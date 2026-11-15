"""Fixed F3 evidence consumers. Importing never boots or opens a device.

Only complete, bounded measured-block encodings can become snapshots. Synthetic
controls exercise these consumers; none of these functions register a provider.
"""
from __future__ import annotations

from dataclasses import dataclass
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import stat
import struct
from types import MappingProxyType
import zlib

import f0
import f0b
import f2

SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6894968776"
MIB = f2.MIB
LIMITS = dict(f0b.LIMITS)
BLOCK_BYTES = 4096
BLOCKS = 16384
DEVICE_BYTES = BLOCK_BYTES * BLOCKS
FRAME_BYTES = 65536
SNAPSHOT_PHASES = ("control-before", "control-after", "read-before", "read-after")
PAYLOAD = b"boardroom F3: one cold ordinary held-FD read; preserved bytes.\n"
ZERO = bytes(BLOCK_BYTES)
ZERO_SHA = hashlib.sha256(ZERO).hexdigest()
FRAME_FIELDS = ("run_id", "origin", "seq", "event", "phase", "rc", "errno", "close_errno", "bytes", "data_hex")
BINDING_FIELDS = ("fd", "device_dev", "device_inode", "rdev", "mode", "uid", "gid", "nlink",
                  "bytes", "block_bytes", "at_ns", "closed")


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def plan(raw):
    result = dict(f2.plan(raw))
    result.update(kind="fixed-private-whole-brd-f3", scope=SCOPE, content_probes=1,
                  max_snapshots=4, decoded_bytes=4 * DEVICE_BYTES, frame_bytes=FRAME_BYTES,
                  snapshot_phases=list(SNAPSHOT_PHASES), payload_bytes=len(PAYLOAD),
                  payload_sha256=hashlib.sha256(PAYLOAD).hexdigest(),
                  production_bound=False, commit_barrier=False)
    return result


def _frame(frame, run_id, phase=None):
    f0._fields(frame, FRAME_FIELDS)
    need(frame["run_id"] == run_id and frame["origin"] == "management", "F3 frame origin/run")
    need(type(frame["seq"]) is int and frame["seq"] > 0, "F3 frame sequence")
    need(type(frame["phase"]) is str and re.fullmatch("[a-z-]{1,32}", frame["phase"]), "F3 phase")
    if phase is not None:
        need(frame["phase"] == phase, "F3 phase mismatch")
    need(type(frame["event"]) is str and re.fullmatch("[a-z-]{1,40}", frame["event"]), "F3 event")
    for name in ("rc", "errno", "close_errno"):
        need(type(frame[name]) is int and -1 <= frame[name] < 4096, "F3 result integer")
    wire = b"BRDF3 " + encoded(frame)
    need(len(wire) <= FRAME_BYTES, "F3 encoded frame budget")
    return f2._raw(frame, (FRAME_BYTES - 512) // 2), len(wire)


def _snapshot_binding(raw, closed):
    value = f0b._json(raw)
    f0._fields(value, BINDING_FIELDS)
    for name in ("fd", "device_dev", "device_inode", "rdev", "mode", "uid", "gid", "nlink", "bytes", "block_bytes"):
        need(type(value[name]) is int and 0 <= value[name] < 1 << 63, "snapshot binding integer")
    need(value["fd"] >= 3 and value["device_inode"] > 0 and value["rdev"] == 256
         and value["mode"] == stat.S_IFBLK | 0o600 and value["uid"] == value["gid"] == 0
         and value["nlink"] == 1 and value["bytes"] == DEVICE_BYTES and value["block_bytes"] == BLOCK_BYTES,
         "owned whole-brd snapshot binding")
    need(type(value["at_ns"]) is str and re.fullmatch("[1-9][0-9]{0,18}", value["at_ns"])
         and int(value["at_ns"]) < 1 << 63, "snapshot monotonic time")
    need(value["closed"] is closed, "snapshot source close receipt")
    return value


@dataclass(frozen=True)
class Snapshot:
    phase: str
    hashes: tuple
    nonzero: object
    before: object
    after: object
    encoded_bytes: int
    total_bytes: int = DEVICE_BYTES
    atomic_live_snapshot: bool = False

    def block(self, index):
        need(type(index) is int and 0 <= index < BLOCKS, "device block index")
        # Completeness was checked before constructing this object. Every absent
        # literal has an explicit measured all-zero run, never an omitted input.
        return self.nonzero.get(index, ZERO)

    def range(self, offset, length):
        need(type(offset) is int and type(length) is int and 0 <= offset <= DEVICE_BYTES
             and 0 <= length <= DEVICE_BYTES-offset, "device byte range")
        if not length:
            return b""
        first, last = offset // BLOCK_BYTES, (offset + length - 1) // BLOCK_BYTES
        raw = b"".join(self.block(i) for i in range(first, last+1))
        return raw[offset % BLOCK_BYTES:offset % BLOCK_BYTES+length]

    def record(self):
        return {"phase": self.phase, "bytes": self.total_bytes, "block_bytes": BLOCK_BYTES,
                "block_sha256": list(self.hashes), "binding_before": dict(self.before),
                "binding_after": dict(self.after), "encoded_bytes": self.encoded_bytes,
                "hash_observation_is_atomic_live_snapshot": False}


def decode_snapshot(frames, run_id, phase):
    need(phase in SNAPSHOT_PHASES and type(frames) is list and 3 <= len(frames) <= 8192,
         "one bounded fixed snapshot")
    need(frames[0].get("event") == "snapshot-begin" and frames[-1].get("event") == "snapshot-end",
         "snapshot begin/end order")
    hashes, nonzero = [], {}
    total_wire = 0
    previous_seq = None
    previous_zero = False
    before = after = None
    for pos, frame in enumerate(frames):
        raw, wire_size = _frame(frame, run_id, phase)
        total_wire += wire_size
        need(total_wire <= LIMITS["serial_bytes"], "snapshot encoded budget")
        if previous_seq is not None:
            need(frame["seq"] == previous_seq + 1, "snapshot frame sequence gap")
        previous_seq = frame["seq"]
        need(frame["rc"] == frame["errno"] == frame["close_errno"] == 0, "snapshot read/close failure")
        event = frame["event"]
        if pos == 0:
            before = _snapshot_binding(raw, False)
        elif pos == len(frames)-1:
            after = _snapshot_binding(raw, True)
        elif event == "snapshot-zero":
            need(len(raw) == 8 and not previous_zero, "canonical zero run")
            start, count = struct.unpack("<II", raw)
            need(start == len(hashes) and 0 < count <= BLOCKS-start, "zero run coverage/bound")
            hashes.extend([ZERO_SHA] * count)
            previous_zero = True
        elif event == "snapshot-data":
            need(len(raw) == BLOCK_BYTES+4, "one complete nonzero block")
            index = struct.unpack_from("<I", raw)[0]
            need(index == len(hashes) and index < BLOCKS and raw[4:] != ZERO,
                 "nonzero literal coverage/canonical encoding")
            nonzero[index] = raw[4:]
            hashes.append(hashlib.sha256(raw[4:]).hexdigest())
            previous_zero = False
        else:
            raise ValueError("unknown/interleaved snapshot event")
    need(len(hashes) == BLOCKS, "incomplete actual device observation")
    need({k: before[k] for k in BINDING_FIELDS if k not in ("at_ns", "closed")}
         == {k: after[k] for k in BINDING_FIELDS if k not in ("at_ns", "closed")},
         "snapshot source identity changed")
    need(int(before["at_ns"]) < int(after["at_ns"]), "snapshot observation order")
    return Snapshot(phase, tuple(hashes), MappingProxyType(nonzero),
                    MappingProxyType(before), MappingProxyType(after), total_wire)


def decode_snapshots(frames, run_id):
    need(type(frames) is list and len(frames) <= 4 * 8192, "bounded snapshot record count")
    result = {}
    offset = 0
    total_wire = 0
    for phase in SNAPSHOT_PHASES:
        selected = []
        while offset < len(frames) and frames[offset].get("phase") == phase:
            selected.append(frames[offset])
            offset += 1
        image = decode_snapshot(selected, run_id, phase)
        result[phase] = image
        total_wire += image.encoded_bytes
        need(total_wire <= LIMITS["serial_bytes"], "all snapshots encoded budget")
    need(offset == len(frames), "extra or reordered snapshot")
    return result


def _entries(run_id, busybox, helper, notes, brd, config, files):
    # The F2 allowlist stays unchanged. F3 adds one explicit preparation mountpoint.
    return f2._entries(run_id, busybox, helper, notes, brd, config, files) + [
        f0b._entry("mnt/f3-prepare", stat.S_IFDIR | 0o700)]


def payload(run_id, busybox, helper, notes, brd, config, files):
    entries = _entries(run_id, busybox, helper, notes, brd, config, files)
    raw = b"".join(f0b._newc_record(entry, i + 1) for i, entry in enumerate(entries))
    raw += f0b._newc_record(f0b._entry("TRAILER!!!", 0), 0)
    need(len(raw) <= LIMITS["expanded_bytes"], "expanded F3 payload budget")
    result = gzip.compress(raw, compresslevel=9, mtime=0)
    inspect_payload(result, run_id)
    return result


def inspect_payload(data, run_id):
    need(type(data) is bytes and len(data) <= LIMITS["compressed_bytes"], "compressed F3 payload budget")
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data, LIMITS["expanded_bytes"] + 1)
    except zlib.error as error:
        raise ValueError("invalid F3 gzip") from error
    need(len(raw) <= LIMITS["expanded_bytes"] and decoder.eof and not decoder.unused_data
         and not decoder.unconsumed_tail, "incomplete/trailing/oversized F3 archive")
    entries = f2.decode_newc(raw)
    by_name = {entry["name"]: entry for entry in entries}
    need(len(by_name) == len(entries), "duplicate F3 member")
    try:
        expected = _entries(run_id, by_name["bin/busybox"]["data"], by_name["bin/brd-f2"]["data"],
            by_name["run/notes"]["data"], by_name["usr/lib/modules/brd.ko"]["data"],
            by_name["etc/mke2fs-f2.conf"]["data"], {name: by_name[name]["data"] for name in f2.PAYLOAD_FILES})
    except KeyError as error:
        raise ValueError("missing F3 fixed member") from error
    need(entries == expected and len(entries) == 43, "F3 exact member/content mismatch")
    return {"state": "OFFLINE_F3_PAYLOAD_ONLY", "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED",
            "compressed_bytes": len(data), "expanded_bytes": len(raw), "sha256": hashlib.sha256(data).hexdigest(),
            "members": [{k: v for k, v in entry.items() if k != "data"} |
                {"bytes": len(entry["data"]), "sha256": hashlib.sha256(entry["data"]).hexdigest()} for entry in entries]}


def inode(snapshot, number):
    """Resolve a real inode from the complete measured single-group device."""
    sb = snapshot.range(1024, 1024)
    d = f2._module("diagnostics")
    d.ext4_superblock(sb, unmounted=struct.unpack_from("<I", sb, 96)[0] == 706)
    total, per_group, inodes, inode_size = (struct.unpack_from("<I", sb, at)[0] for at in (4, 32, 40, 88))
    # s_inode_size is u16, with s_block_group_nr immediately after it.
    need(total == BLOCKS and per_group >= BLOCKS and inodes > 12 and inode_size == 256
         and struct.unpack_from("<I", sb, 0x150)[0] == 0, "fixed single-group inode geometry")
    need(type(number) is int and 1 <= number <= inodes, "inode number outside measured group")
    descriptor = snapshot.range(BLOCK_BYTES, 64)
    table = struct.unpack_from("<I", descriptor, 8)[0] | struct.unpack_from("<I", descriptor, 40)[0] << 32
    offset = table * BLOCK_BYTES + (number - 1) * 256
    need(1 < table < BLOCKS and offset + 256 <= DEVICE_BYTES, "inode table outside measured device")
    return snapshot.range(offset, 256)


def extent_blocks(raw, count):
    need(type(raw) is bytes and len(raw) == 256 and type(count) is int and 1 <= count <= 1024, "bounded inode/extent request")
    need(struct.unpack_from("<I", raw, 32)[0] & 0x80000, "extent inode required")
    magic, entries, maximum, depth, _ = struct.unpack_from("<HHHHI", raw, 40)
    need(magic == 0xf30a and 1 <= entries <= 4 and maximum == 4 and depth == 0, "unsupported extent tree")
    blocks = []
    for index in range(entries):
        logical, length, high, low = struct.unpack_from("<IHHI", raw, 52 + index * 12)
        need(logical == len(blocks) and 0 < length < 32768 and len(blocks) + length <= count, "hole/unwritten/overlapping extent")
        physical = low | high << 32
        need(1 <= physical < BLOCKS and physical + length <= BLOCKS, "extent beyond owned whole device")
        blocks.extend(range(physical, physical + length))
    need(len(blocks) == count and len(set(blocks)) == count, "incomplete/repeated extent mapping")
    return tuple(blocks)


def journal(snapshot):
    raw_inode = inode(snapshot, 8)
    size = struct.unpack_from("<I", raw_inode, 4)[0] | struct.unpack_from("<I", raw_inode, 108)[0] << 32
    need(stat.S_IFMT(struct.unpack_from("<H", raw_inode)[0]) == stat.S_IFREG and size == 4 * MIB, "fixed actual journal inode8")
    blocks = extent_blocks(raw_inode, 1024)
    raw = b"".join(snapshot.block(index) for index in blocks)
    sb = snapshot.range(1024, 1024)
    f2._module("diagnostics")._journal(raw, sb[104:120].hex())
    return blocks, raw


VIEW_NAMES = (".", "payload", "directory", "ancestor", "lost+found")
VIEW_FIELDS = ("name", "fd", "dev", "ino", "mode", "uid", "gid", "nlink", "size", "atime", "mtime", "ctime")
FIXED_ATTR = {b"user.boardroom-source-preservation": b"owned-fixture"}


def source_view(rows, run_id, phase):
    need(type(rows) is list and 19 <= len(rows) <= 400, "bounded complete source view")
    frames = []
    for row in rows:
        raw, _ = _frame(row, run_id, phase)
        need(row["rc"] == row["errno"] == row["close_errno"] == 0, "source view call/close failed")
        frames.append((row["event"], raw))
    cursor = 0

    def take(name):
        nonlocal cursor
        need(cursor < len(frames) and frames[cursor][0] == name, "missing/reordered source view " + name)
        value = frames[cursor][1]
        cursor += 1
        return value

    head = f0b._json(take("view-begin"))
    f0._fields(head, ("root_fd", "dev", "ino", "object_count", "ordinary_source_open_count"))
    need(type(head["root_fd"]) is int and head["root_fd"] >= 3
         and head | {"root_fd": 0} == {"root_fd": 0, "dev": 256, "ino": 2, "object_count": 5, "ordinary_source_open_count": 0},
         "held view root binding")
    members = take("view-members").split(b"\0")
    need(members[-1:] == [b""] and len(members) == 5 and set(members[:-1]) ==
         {b"payload", b"directory", b"ancestor", b"lost+found"}, "complete root membership")
    objects = {}
    for name in VIEW_NAMES:
        value = f0b._json(take("view-object"))
        f0._fields(value, VIEW_FIELDS)
        need(value["name"] == name, "source object order")
        for field in ("fd", "dev", "ino", "mode", "uid", "gid", "nlink", "size"):
            need(type(value[field]) is int and 0 <= value[field] < 1 << 63, "source metadata integer")
        need(value["fd"] >= 3 and value["fd"] != head["root_fd"] and value["dev"] == 256 and value["ino"] > 0
             and value["nlink"] >= 1, "held source object")
        file = name == "payload"
        need(value["mode"] == (stat.S_IFREG | 0o600 if file else stat.S_IFDIR | 0o700)
             and value["uid"] == value["gid"] == (0 if name == "lost+found" else 1000), "source owner/type/mode")
        need(value["ino"] == 2 if name == "." else value["ino"] != 2, "root inode guard")
        need(not file or value["nlink"] == 1 and value["size"] == len(PAYLOAD), "fixed nonempty payload")
        for field in ("atime", "mtime", "ctime"):
            times = value[field]
            need(type(times) is list and len(times) == 2 and all(type(v) is int for v in times)
                 and 0 <= times[0] < 1 << 63 and 0 <= times[1] < 1000000000, "source timestamp")
        attrs = {}
        while cursor < len(frames) and frames[cursor][0] == "view-attr":
            raw = take("view-attr")
            need(len(raw) >= 6, "attribute header")
            n, size = struct.unpack_from("<HI", raw)
            key, val = raw[6:6+n], raw[6+n:]
            need(0 < n <= 255 and size <= 16384 and len(raw) == 6+n+size and b"\0" not in key
                 and key not in attrs and len(attrs) < 64, "duplicate/truncated/oversized source attribute")
            attrs[key] = val
        need(attrs == ({} if name == "lost+found" else FIXED_ATTR), "complete fixed source attributes")
        if not file and name != ".":
            need(take("view-members") == b"", "unexpected child in fixed empty directory")
        if name == "ancestor":
            absence = f0b._json(take("view-absence"))
            need(absence == {"path": "ancestor/missing", "ancestor_fd": value["fd"],
                            "dev": value["dev"], "ino": value["ino"], "errno": 2}, "exact absent leaf/ancestor")
        need(f0b._json(take("view-close")) == {"name": name, "fd": value["fd"]}, "source object close binding")
        objects[name] = {k: v for k, v in value.items() if k != "fd"} | {
            "attributes": {k.hex(): v.hex() for k, v in attrs.items()}}
    need(f0b._json(take("view-close")) == {"name": "root", "fd": head["root_fd"]}, "held view root close")
    need(f0b._json(take("view-end")) == head and cursor == len(frames), "incomplete/extra source view")
    need(len({row["ino"] for row in objects.values()}) == 5, "aliased fixture source inode")
    return {"objects": objects, "members": sorted(part.decode("ascii") for part in members[:-1]),
            "absence": "ancestor/missing", "content_opens": 0,
            "method": "held-O_PATH-metadata-xattr-and-NOATIME-directory-membership"}


def source_payload(snapshot, view):
    number = view["objects"]["payload"]["ino"]
    raw = inode(snapshot, number)
    need(struct.unpack_from("<H", raw)[0] == stat.S_IFREG | 0o600
         and struct.unpack_from("<I", raw, 4)[0] == len(PAYLOAD)
         and struct.unpack_from("<I", raw, 108)[0] == 0, "actual payload inode type/size")
    blocks = extent_blocks(raw, 1)
    content = snapshot.block(blocks[0])[:len(PAYLOAD)]
    need(content == PAYLOAD, "measured baseline payload differs")
    return {"inode": number, "blocks": list(blocks), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}

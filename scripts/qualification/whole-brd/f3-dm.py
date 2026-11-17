"""固定 DM-linear profile；导入及纯消费者不打开设备或启动子进程。

此文件拥有新 profile 的 ABI、身份和阶段合同，不改变旧 whole-ram0 fence。
合成回归只能证明这些消费者的行为，不能产生原生观察或 provider 资格。
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
import struct

import f0
import f0b
import f2
import f3

PROFILE = "whole-brd-f3-dm-linear-v1"
SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6899760900"
SP_SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6881600918"
LIMITS = dict(f3.LIMITS)
BUFFER_BYTES = 16384
MANAGEMENT_BYTES = 7 * 1024 * 1024
HEADER_BYTES = 312
HEADER_WIRE_BYTES = 305
VERSION = (4, 50, 0)
COMMANDS = {"version": 0, "list": 2, "create": 3, "remove": 4, "resume": 6,
            "status": 7, "load": 9, "deps": 11, "table": 12}
need = f3.need


def plan(raw):
    result = f3.plan(raw)
    run_id = f0b._json(raw)["run_id"]
    result.update(kind="fixed-private-whole-brd-f3-dm-linear", profile=PROFILE, scope=SCOPE,
                  sp_scope=SP_SCOPE, dm_version=list(VERSION), dm_buffer_bytes=BUFFER_BYTES,
                  dm_name="br-f3-" + run_id.replace("-", ""), dm_uuid="boardroom-f3-dm:" + run_id,
                  target_type="linear", target_start=0, target_sectors=131072,
                  target_parameters="1:0 0", calibration_before_mkfs=True,
                  production_supported=False)
    return result


@dataclass(frozen=True)
class Device:
    name: str
    uuid: str
    encoded: int
    major: int
    minor: int


def device_number(value):
    # 固定 Linux huge_encode_dev 使用 new_encode_dev：12-bit major + 20-bit minor。
    need(type(value) is int and 0 < value < 1 << 32, "DM encoded device bounds")
    major, minor = (value >> 8) & 0xfff, (value & 0xff) | ((value >> 12) & 0xfff00)
    need(major != 0, "DM zero major")
    return major, minor


def ioctl_request(command, run_id):
    proposal = plan(f3.encoded({"run_id": run_id}))
    need(command in COMMANDS, "DM command not in fixed profile")
    raw = bytearray(BUFFER_BYTES)
    flags, count = (16 if command == "table" else 0), (1 if command == "load" else 0)
    struct.pack_into("<6Ii3IQ", raw, 0, *VERSION, BUFFER_BYTES, HEADER_BYTES, count, 0, flags, 0, 0, 0)
    if command == "create":
        name = proposal["dm_name"].encode(); raw[48:48 + len(name)] = name
    if command not in ("version", "list"):
        uuid = proposal["dm_uuid"].encode(); raw[176:176 + len(uuid)] = uuid
    if command == "load":
        # 请求 next 相对当前 target；只有一个 target，不接受任意表或 backing 参数。
        struct.pack_into("<QQiI16s", raw, HEADER_BYTES, 0, 131072, 0, 48, b"linear")
        raw[HEADER_BYTES + 40:HEADER_BYTES + 46] = b"1:0 0\0"
    return bytes(raw)


def _cstring(raw, label):
    end = raw.find(b"\0")
    need(end >= 0 and not any(raw[end:]), "DM unterminated/nonzero trailing " + label)
    try:
        return raw[:end].decode("ascii", "strict")
    except UnicodeDecodeError as error:
        raise ValueError("DM non-ASCII " + label) from error


def decode_ioctl(raw, command, run_id, identity=None):
    """读取实际返回字节。调用链必须从 create 的 kernel dev 建立 identity。"""
    proposal = plan(f3.encoded({"run_id": run_id}))
    need(command in COMMANDS and type(raw) is bytes
         and HEADER_WIRE_BYTES <= len(raw) <= BUFFER_BYTES, "DM response bounds/command")
    version = struct.unpack_from("<3I", raw)
    size, start, count, opened, flags, event, padding, encoded = struct.unpack_from("<IIIiIIIQ", raw, 12)
    need(version == VERSION and size == len(raw) and start == HEADER_BYTES and padding == 0
         and opened >= 0, "DM response ABI/size/offset")
    name, uuid = _cstring(raw[48:176], "name"), _cstring(raw[176:305], "uuid")
    if command == "version":
        # VERSION 只回写 version；其余字段及零 buffer 应与固定请求完全相同。
        need(raw == ioctl_request("version", run_id), "DM VERSION response/request drift")
        return None
    if command == "list":
        need(size == HEADER_BYTES and count == opened == flags == event == encoded == 0
             and not name and not uuid and not any(raw[305:]), "DM unfiltered list is not empty")
        return None
    need(name == proposal["dm_name"] and uuid == proposal["dm_uuid"], "DM current run name/UUID")
    if command == "create":
        need(identity is None and size == HEADER_WIRE_BYTES and count == flags == 0, "DM fresh create status")
        major, minor = device_number(encoded)
        need((major, minor) != (1, 0), "DM cannot be backing ram0")
        return Device(name, uuid, encoded, major, minor)
    need(type(identity) is Device and identity.name == name and identity.uuid == uuid, "DM missing create identity")
    if command == "remove":
        # remove 不调用 __dev_status；请求 dev=0 会保留，不能伪称它返回目标 dev。
        need(size == HEADER_WIRE_BYTES and encoded == 0 and count == 0
             and flags in (0, 1 << 13), "DM remove flags/response")
        return identity
    need(encoded == identity.encoded, "DM actual device changed")
    if command == "load":
        need(size == HEADER_WIRE_BYTES and flags == 64 and count == 0, "DM single initial inactive table")
        return identity
    expected_flags = 32 | (16 if command == "table" else 0)
    allowed_flags = (expected_flags, expected_flags | (1 << 13)) if command == "resume" else (expected_flags,)
    need(flags in allowed_flags and count == 1, "DM not one active writable unsuspended table")
    if command in ("resume", "status"):
        need(size == HEADER_WIRE_BYTES, "DM unexpected status bytes")
    elif command == "table":
        need(size == HEADER_BYTES + 46 and not any(raw[305:HEADER_BYTES]), "DM exact table response size")
        sector, length, status, next_offset, target = struct.unpack_from("<QQiI16s", raw, HEADER_BYTES)
        # 响应 next 相对首 target，包含对齐位置，但最后 data_size 不含对齐 padding。
        need((sector, length, status, next_offset) == (0, 131072, 0, 48)
             and _cstring(target, "target") == "linear" and raw[HEADER_BYTES + 40:] == b"1:0 0\0",
             "DM exact whole ram0 linear target")
    elif command == "deps":
        need(size == HEADER_BYTES + 16 and not any(raw[305:HEADER_BYTES])
             and struct.unpack_from("<IIQ", raw, HEADER_BYTES) == (1, 0, 256), "DM unique ram0 dependency")
    return identity


def _hex(value, limit):
    need(type(value) is str and len(value) <= 2 * limit and len(value) % 2 == 0
         and re.fullmatch("[0-9a-f]*", value) is not None, "DM raw hex shape")
    return bytes.fromhex(value)


def _statistics(raw):
    need(type(raw) is bytes and re.fullmatch(rb"[ \t]*[0-9]+(?:[ \t]+[0-9]+){16}[ \t]*\n", raw)
         is not None and len(raw) <= 4096, "DM exact 17-field stat")
    values = tuple(map(int, raw.split()))
    need(all(value < 1 << 64 for value in values) and values[8] == 0, "DM stat overflow/inflight")
    return values


def decode_calibration(value, device):
    f0._fields(value, ("device", "fd", "flags", "close_errno", "iostats_hex", "steps"))
    need(type(value["device"]) is int and value["device"] == device and type(value["fd"]) is int
         and value["fd"] >= 3 and type(value["close_errno"]) is int and value["close_errno"] == 0,
         "DM calibration identity/close")
    flags = value["flags"]
    need(type(flags) is int and flags & (3 | 0x4000) == 2 | 0x4000
         and flags & ~(3 | 0x4000 | 0x8000 | 0x20000) == 0, "DM calibration requires actual O_DIRECT/RDWR")
    need(_hex(value["iostats_hex"], 32) == b"1\n", "DM iostats is not enabled")
    steps = value["steps"]
    need(type(steps) is list and len(steps) == 5, "DM exactly five calibration operations")
    previous = original = first = None
    operations = ("read-original", "write-pattern", "read-pattern", "restore-original", "read-restored")
    for row, operation in zip(steps, operations):
        f0._fields(row, ("operation", "rc", "errno", "data_hex", "before_hex", "after_hex"))
        need(row["operation"] == operation and type(row["rc"]) is int and row["rc"] == 4096
             and type(row["errno"]) is int and row["errno"] == 0, "DM calibration operation/errno/short I/O")
        data = _hex(row["data_hex"], 4096)
        need(len(data) == 4096, "DM calibration exact block bytes")
        if original is None:
            original = data
        need(data == (bytes([0xa5]) * 4096 if operation in ("write-pattern", "read-pattern") else original),
             "DM calibration data/restore mismatch")
        before, after = (_statistics(_hex(row[name], 4096)) for name in ("before_hex", "after_hex"))
        need(previous is None or before == previous, "DM calibration unobserved operation")
        if first is None:
            first = before
        delta = tuple(b - a for a, b in zip(before, after))
        write = operation in ("write-pattern", "restore-original")
        expected = {0: 0 if write else 1, 1: 0, 2: 0 if write else 8, 4: 1 if write else 0,
                    5: 0, 6: 8 if write else 0, 8: 0, 11: 0, 12: 0, 13: 0, 15: 0}
        need(all(n >= 0 for n in delta) and all(delta[index] == n for index, n in expected.items()),
             "DM calibration counter mismatch/rollback/extra operation")
        previous = after
    return {"reads": previous[0] - first[0], "read_sectors": previous[2] - first[2],
            "writes": previous[4] - first[4], "write_sectors": previous[6] - first[6]}


# 复用仅与完整块/文件系统字节有关的既有分类器，不改其接受条件。
import json
import stat
import uuid
from types import MappingProxyType
BLOCK_BYTES, BLOCKS, DEVICE_BYTES = f3.BLOCK_BYTES, f3.BLOCKS, f3.DEVICE_BYTES
FRAME_BYTES, FRAME_FIELDS = f3.FRAME_BYTES, f3.FRAME_FIELDS
SNAPSHOT_PHASES, BINDING_FIELDS = f3.SNAPSHOT_PHASES, f3.BINDING_FIELDS
ZERO, ZERO_SHA, PAYLOAD = f3.ZERO, f3.ZERO_SHA, f3.PAYLOAD
VIEW_NAMES, VIEW_FIELDS, FIXED_ATTR = f3.VIEW_NAMES, f3.VIEW_FIELDS, f3.FIXED_ATTR
HEALTH, BRD_SRCVERSION, BRD_BUILD_ID = f2.HEALTH, f2.BRD_SRCVERSION, f2.BRD_BUILD_ID
Snapshot, encoded, _frame, _sp = f3.Snapshot, f3.encoded, f3._frame, f3._sp
inode, journal, source_payload, device_effects = f3.inode, f3.journal, f3.source_payload, f3.device_effects
payload, inspect_payload = f3.payload, f3.inspect_payload

def _snapshot_binding(raw, closed, device):
    value = f0b._json(raw)
    f0._fields(value, BINDING_FIELDS)
    for name in ("fd", "device_dev", "device_inode", "rdev", "mode", "uid", "gid", "nlink", "bytes", "block_bytes"):
        need(type(value[name]) is int and 0 <= value[name] < 1 << 63, "snapshot binding integer")
    need(value["fd"] >= 3 and value["device_inode"] > 0 and value["rdev"] == device.encoded
         and value["mode"] == stat.S_IFBLK | 0o600 and value["uid"] == value["gid"] == 0
         and value["nlink"] == 1 and value["bytes"] == DEVICE_BYTES and value["block_bytes"] == BLOCK_BYTES,
         "owned DM-linear snapshot binding")
    need(type(value["at_ns"]) is str and re.fullmatch("[1-9][0-9]{0,18}", value["at_ns"])
         and int(value["at_ns"]) < 1 << 63, "snapshot monotonic time")
    need(value["closed"] is closed, "snapshot source close receipt")
    return value

def decode_snapshot(frames, run_id, phase, device):
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
            before = _snapshot_binding(raw, False, device)
        elif pos == len(frames)-1:
            after = _snapshot_binding(raw, True, device)
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

def source_view(rows, run_id, phase, device):
    need(type(rows) is list and 19 <= len(rows) <= 400, "bounded complete source view")
    frames = []
    for index, row in enumerate(rows):
        raw, _ = _frame(row, run_id, phase)
        need(row["seq"] == rows[0]["seq"] + index, "source view sequence")
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
         and head | {"root_fd": 0} == {"root_fd": 0, "dev": device.encoded, "ino": 2, "object_count": 5, "ordinary_source_open_count": 0},
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
        need(value["fd"] >= 3 and value["fd"] != head["root_fd"] and value["dev"] == device.encoded and value["ino"] > 0
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

def decode_metadata(rows, p1, run_id, device, sysname):
    METADATA = tuple((item, path.replace("/sys/block/ram0/", f"/sys/devices/virtual/block/{sysname}/")
                     .replace("ram0", sysname), limit) for item, path, limit in f2.METADATA)
    need(len(rows) == len(METADATA), "complete one-pass ordinary metadata required")
    observations = {}
    for seq, (frame, (item, path, limit)) in enumerate(zip(rows, METADATA), 1):
        f0._fields(frame, ("run_id", "origin", "phase", "seq", "item", "path", "status", "errno", "close_errno", "eof", "bytes", "data_hex"))
        need(frame["run_id"] == run_id and frame["origin"] == "ordinary" and frame["phase"] == "metadata"
                 and type(frame["seq"]) is int and frame["seq"] == seq and frame["item"] == item and frame["path"] == path,
                 "ordinary metadata origin/source/order")
        absent = item == "device_partition"
        need(frame["status"] == ("ABSENT" if absent else "OK") and type(frame["errno"]) is int
                 and frame["errno"] == (2 if absent else 0) and type(frame["close_errno"]) is int
                 and frame["close_errno"] == 0 and frame["eof"] is True, "ordinary read/close failed: " + item)
        raw = f2._raw(frame, limit); observations[item] = {"raw": raw, "frame": frame, "sha256": hashlib.sha256(raw).hexdigest()}
    data = {name: value["raw"] for name, value in observations.items()}
    before = f0b._ordinary_status(data["status_before"]); after = f0b._ordinary_status(data["status_after"])
    need(before == after and data["boot_id"] == p1["observations"]["boot_id"]["raw"], "current ordinary identity/boot changed")
    for name, expected in (("module_rd_nr", b"1\n"), ("module_rd_size", b"65536\n"), ("module_max_part", b"1\n"),
                           ("module_srcversion", BRD_SRCVERSION), ("device_dev", f"{device.major}:{device.minor}\n".encode()), ("device_size", b"131072\n"),
                           ("device_ro", b"0\n"), ("device_partition", b"absent\n"), ("device_holders", b""), ("device_slaves", b"ram0\0")):
        need(data[name] == expected, "actual module/whole device mismatch: " + name)
    need(data["module_notes"] == struct.pack("<III", 4, 20, 3) + b"GNU\0" + bytes.fromhex(BRD_BUILD_ID), "loaded module build-id mismatch")
    module_lines = data["modules"].splitlines()
    need(len(module_lines) == 1 and module_lines[0].split()[:1] == [b"brd"], "unexpected loaded module family")
    def names(raw):
        parts = raw.split(b"\0")
        need(parts[-1] == b"" and len(parts) <= 257 and len(set(parts)) == len(parts)
                 and all(re.fullmatch(rb"[A-Za-z0-9_.-]+", n) for n in parts[:-1]), "block inventory format")
        return set(parts[:-1])
    need(names(data["sys_block"]) == names(p1["observations"]["sys_block"]["raw"]) | {b"ram0", sysname.encode()}, "actual extra/missing block object")
    need(re.fullmatch(rb"[1-9][0-9]*\n", data["device_logical"]) is not None, "logical block format")
    logical = int(data["device_logical"])
    need(0 < logical <= 1024 and logical & (logical - 1) == 0, "actual logical block limit")
    opened = f0b._json(data["source_open"]); f0._fields(opened, ("fd",))
    need(type(opened["fd"]) is int and opened["fd"] >= 3, "source FD acquisition")
    st = f0b._json(data["source_stat_before"]); end = f0b._json(data["source_stat_after"])
    f0._fields(st, ("fd", "dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime", "ctime"))
    need(st == end and st["fd"] == opened["fd"] and st["dev"] == device.encoded and st["ino"] == 2
             and st["mode"] == stat.S_IFDIR | 0o700 and st["uid"] == st["gid"] == 1000, "same source root metadata/owner changed")
    fs = f0b._json(data["source_statfs"])
    need(fs == {"magic": 0xef53, "block_size": 4096}, "actual native 4KiB filesystem")
    native = f2._module("native")
    sx = native.decode_statx(data["source_statx_unique"]); legacy = native.decode_statx(data["source_statx_legacy"])
    mount = native.decode_statmount(data["source_mount"]); tune = native.decode_tune(data["source_tune"])
    for value, mask in ((sx, 0x4fff), (legacy, 0x17ff)):
        need(value["mask"] & mask == mask and all(value[k] == st[k] for k in ("ino", "mode", "uid", "gid", "size"))
                 and (value["dev_major"], value["dev_minor"]) == (device.major, device.minor), "statx same-FD identity/mask mismatch")
    need(len(data["source_flags"]) == 8 and native.inode_guard(struct.unpack("<Q", data["source_flags"])[0],
             sx["attributes"], sx["attributes_mask"], directory=True), "source inode flags/DAX")
    proposal = plan(json.dumps({"run_id": run_id}).encode())
    need(data["source_uuid"] == b"\x10" + uuid.UUID(proposal["filesystem_uuid"]).bytes, "actual source UUID mismatch")
    need(len(data["source_fid"]) == 144, "FID frame size")
    mount_id, handle_bytes, handle_type = struct.unpack_from("<QIi", data["source_fid"])
    need(handle_bytes == 8 and handle_type == 1 and mount_id == sx["unique_id"] == mount["unique_id"], "opaque FID/current mount mismatch")
    need(mount["legacy_id"] == legacy["unique_id"] and (mount["dev_major"], mount["dev_minor"]) == (device.major, device.minor)
             and mount["root"] == "/" and mount["point"] == "/mnt/brd" and mount["type"] == "ext4" and mount["magic"] == 0xef53,
             "actual whole-root mount identity")
    # MOUNT_ATTR_NOSUID/NODEV/NOEXEC are the accepted private fixture flags;
    # absence of IDMAP/RDONLY/unknown flags is checked explicitly.
    need(mount["attr"] == 0x0e and mount["propagation"] == 1 << 18 and not mount["sb_flags"] & 1, "mount attributes/private/rw mismatch")
    need(tune["feature_masks"] == [60, 710, 1131], "actual mounted feature vector")
    opts = native.options(data["effective_options"])
    need(opts.get("rw") is True and opts.get("data") == "ordered" and opts.get("dax") == "never"
             and opts.get("errors") == "remount-ro" and opts.get("acl") is True and opts.get("user_xattr") is True,
             "effective source options mismatch")
    for name in HEALTH:
        value = data["health_" + name]
        need(value in (b"", b"\n") if name.endswith("_func") else re.fullmatch(rb"0\n?", value) is not None,
                 "visible error snapshot is nonzero/unknown: " + name)
    mounts = native.mountinfo(data["mountinfo"])
    matching = [m for m in mounts if m["id"] == mount["legacy_id"]]
    need(len(matching) == 1 and matching[0]["device"] == f"{device.major}:{device.minor}" and matching[0]["root"] == "/"
             and matching[0]["point"] == "/mnt/brd" and matching[0]["type"] == "ext4", "mountinfo/current source mismatch")
    return {"observations": observations, "identity": before, "logical_block_size": logical, "source_fd": st["fd"],
            "uuid": proposal["filesystem_uuid"], "fid_hex": data["source_fid"][16:24].hex(), "mount": mount,
            "features": tune["feature_masks"], "effective_options": opts, "healthy_visible_snapshot": True,
            "commit_barrier": False, "production_bound": False}

def native_window(raw, phase, end_frame, metadata, before, after, view, device):
    native, _, window = _sp()
    value = f0b._json(end_frame["raw"])
    f0._fields(value, ("pid","exit","signal","timeout","reaped","pidfd_before_ack","joined_ns"))
    joined = value.pop("joined_ns")
    wait = f2._wait({"raw":encoded(value)})
    need(type(joined) is str and re.fullmatch("[1-9][0-9]{0,18}",joined)
         and int(before.after["at_ns"]) < int(joined) < int(after.before["at_ns"]), "actual native join/window bound")
    mode = "context" if phase == "control" else "ordinary"
    receipt = {"pid":wait["pid"],"returncode":wait["exit"],"reaped":True,"timed_out":False,
               "call_error":None,"cleanup_errors":[],"output_complete":True}
    data = native.parse_stream(raw,mode)
    result = window.capture(raw,mode,receipt,int(joined))
    need(data["uid"] == data["gid"] == 1000, "ordinary process identity")
    need(int(before.after["at_ns"]) < int(result["native_window_closed_ns"]), "native completion before baseline")
    root = data["parsed"]["root-before"]
    need(root["uuid"] == metadata["uuid"].replace("-","") and root["fid"] == metadata["fid_hex"],
         "native root differs from this boot's F2 metadata")
    if phase=="control":
        need(root["mount"]==metadata["mount"], "control native uses another mount than its F2 admission")
    for label, item in data["parsed"].items():
        name="." if label.startswith("root-") else "payload" if label.startswith("payload-") else "directory"
        need(all(item["statx"][key]==view["objects"][name][key] for key in ("ino","mode","size","uid","gid","nlink")),
             "native object differs from the measured application closure")
        need(item["mount"]["root"] == "/" and item["mount"]["point"] == "/mnt/brd"
             and item["mount"]["attr"] == 0xe and item["mount"]["propagation"] == 1 << 18
             and (item["statx"]["dev_major"],item["statx"]["dev_minor"]) == (device.major, device.minor)
             and item["tune"]["feature_masks"] == [60,710,1131], "whole DM-linear native configuration")
    need(data["context"]["before"]["options"] == metadata["effective_options"], "effective options drift")
    notes = [row for row in data["rows"] if row.get("kind")=="pseudo" and row.get("name")=="kernel-notes"]
    need(len(notes)==1 and hashlib.sha256(native.rawhex(notes[0]["hex"])).hexdigest()==f2.NOTES_SHA, "native kernel build notes")
    content = [row for row in data["rows"] if row.get("kind")=="content"]
    need(len(content)==(1 if phase=="read" else 0), "control/prewarm/ordinary content count")
    if content:
        need(native.rawhex(content[0]["hex"])==PAYLOAD, "ordinary held-FD payload differs from measured baseline")
    return result

def decode_serial(raw, run_id, expected_notes):
    plan(encoded({"run_id":run_id}))
    need(type(raw) is bytes and len(raw)<=LIMITS["serial_bytes"], "F3 serial byte budget")
    legacy, ordinary, frames, positions, native_raw = [], [], [], {}, {}
    active = None
    management_bytes = 0
    dm_ordinary = []
    p1_positions = []
    for pos, line in enumerate(raw.splitlines(keepends=True)):
        protocol = line.startswith((b"BRDF1 ",b"BRDF2 ",b"BRDF3 ",b"BRDDM "))
        if protocol or active is not None:
            need(line.endswith(b"\n") and len(line)<=FRAME_BYTES, "incomplete/oversized serial frame")
        if line.startswith(b"BRDDM "):
            dm_ordinary.append((pos, f0b._json(line[6:].rstrip(b"\r\n"))))
            continue
        if line.startswith(b"BRDF1 "): p1_positions.append(pos)
        if b"BRDF3 " in line:
            need(line.startswith(b"BRDF3 "), "interleaved F3 frame")
            management_bytes += len(line)
            need(management_bytes <= MANAGEMENT_BYTES, "F3 management aggregate byte budget")
            row = f0b._json(line[6:].rstrip(b"\r\n"))
            data, _ = _frame(row,run_id)
            need(row["seq"]==len(frames)+1 and len(frames)<34816, "F3 sequence/replay/count")
            need(row["rc"]==row["errno"]==row["close_errno"]==0, "F3 native/cleanup failure")
            if row["event"]=="native-begin":
                need(active is None and row["phase"] in ("control","read") and row["phase"] not in native_raw, "native phase replay")
                need(data== (b"context" if row["phase"]=="control" else b"ordinary"),"native mode binding")
                active=row["phase"];native_raw[active]=bytearray()
            elif row["event"]=="native-end":
                need(active==row["phase"],"native end without owner");active=None
            frames.append(row | {"raw":data,"position":pos})
            positions.setdefault((row["phase"],row["event"]),[]).append(pos)
            continue
        if b"BRDF2 " in line:
            need(line.startswith(b"BRDF2 ") and len(line)<=FRAME_BYTES and line.endswith(b"\n"),"F2 frame integrity")
            row=f0b._json(line[6:].rstrip(b"\r\n"))
            need(row.get("run_id")==run_id,"current boot F2 origin")
            if row.get("origin")=="ordinary": ordinary.append((pos,row));continue
            f0._fields(row,("run_id","origin","seq","event","rc","errno","close_errno","bytes","data_hex"))
            need(row["origin"]=="management" and type(row["seq"]) is int and row["seq"]==len(legacy)+1,
                 "F2 management sequence")
            need(all(type(row[key]) is int and row[key]==0 for key in ("rc","errno","close_errno")),"F2 management failure")
            legacy.append(row|{"raw":f2._raw(row,(FRAME_BYTES-512)//2),"position":pos})
            continue
        if active is not None:
            need(line.startswith(b"{"),"interleaved native output")
            native_raw[active].extend(line)
        elif line.startswith(b"{"):
            need(False,"native output outside its owned window")
    need(active is None,"native output not ended")
    p1 = f0b.decode_serial(raw, run_id, expected_notes)
    dm_frames = [row for row in frames if row["event"].startswith("dm-")]
    frames, dm_proof, device = decode_dm_frames(frames, run_id, p1)
    expected_legacy = f2.EVENTS[:8]+("device-remove",)+f2.EVENTS[8:17]+("metadata-start","metadata-exit")*3+("cleanup-fd","module-unload")
    need(tuple(row["event"] for row in legacy)==expected_legacy,"incomplete/unknown F2 owned lifecycle")
    by_name={row["event"]:row for row in legacy[:18]}
    policy=f2.policy(p1)
    need(p1_positions and p1_positions[0]<by_name["p1-start"]["position"]<p1_positions[1]
         and p1_positions[-1]<by_name["p1-exit"]["position"],"same-boot P1 before preparation")
    need(by_name["policy-gate"]["raw"]==policy.encode(),"same-boot policy gate")
    f2.config_bytes(by_name["config-check"]["raw"])
    p1_wait=f2._wait(by_name["p1-exit"]);format_wait=f2._wait(by_name["format-exit"],format_child=True)
    dm_proof["format_entry"] = validate_format_fds(by_name["format-stdout"]["raw"], format_wait, run_id)
    need(p1_wait["pid"]==p1["ordinary_identity"]["pid"],"P1 owner PID")
    child_starts=[row for row in legacy if row["event"]=="metadata-start"]
    child_ends=[row for row in legacy if row["event"]=="metadata-exit"]
    need(all(child_starts[0]["position"]<pos<child_ends[0]["position"] for pos,_ in ordinary),"metadata outside actual owned child")
    metadata=decode_metadata([row for _,row in ordinary],p1,run_id,device,dm_proof["sysname"])
    waits=[f2._wait(row) for row in child_ends]
    need(waits[0]["pid"]==metadata["identity"]["pid"] and len({p1_wait["pid"],format_wait["pid"],*(wait["pid"] for wait in waits)})==5,
         "distinct actual P1/format/metadata/control/read owners")
    need(by_name["module-load"]["raw"]==b"rd_nr=1 rd_size=65536 max_part=1"
         and by_name["device-create"]["raw"]==b"1:0","fixed single target creation")
    need(set(by_name["brd-family"]["raw"].split(b"\0")) == set(metadata["observations"]["sys_block"]["raw"].split(b"\0")) - {dm_proof["sysname"].encode()},
         "actual target inventory")
    need(f0b._json(by_name["device-geometry"]["raw"])=={"bytes":DEVICE_BYTES,"logical_block_size":metadata["logical_block_size"]},
         "geometry vs native metadata")

    cursor=0
    def take(event,phase):
        nonlocal cursor
        need(cursor<len(frames) and (frames[cursor]["event"],frames[cursor]["phase"])==(event,phase),
             "missing/reordered F3 lifecycle "+phase+":"+event)
        row=frames[cursor];cursor+=1;return row
    need(frames and by_name["mount-private"]["position"] < frames[0]["position"],
         "F3 preparation precedes this boot's P1/F2 policy and target setup")
    prepare_begin = take("mount","prepare")
    need(prepare_begin["raw"]==b"/mnt/f3-prepare","fixed preparation mount")
    need(take("prepare-objects","prepare")["raw"]==PAYLOAD,"fixed prepared source content")
    prepare_end = take("unmount","prepare")
    need(prepare_end["raw"]==b"/mnt/f3-prepare","preparation writers/handles ended")
    phase_positions = {"geometry": by_name["device-geometry"]["position"], "device-remove": by_name["device-remove"]["position"],
        "format-start": by_name["format-start"]["position"], "mount-private": by_name["mount-private"]["position"],
        "prepare-begin": prepare_begin["position"], "prepare-end": prepare_end["position"],
        "cleanup-fd": legacy[-2]["position"], "module-unload": legacy[-1]["position"]}
    snapshots,views,mount_records,windows={}, {}, {}, {}
    for index,phase in enumerate(("control","read")):
        phase_positions[phase+"-begin"] = take("round-begin",phase)["position"]
        start=take("block-stat-before",phase);base=take("mount-base",phase)
        mounted=take("mount",phase)
        need(mounted["raw"]==b"/mnt/brd","whole-source mountpoint")
        mounted_stats=take("block-stat-mounted",phase)
        if phase=="control":
            need(cursor<len(frames) and mounted_stats["position"]<child_starts[0]["position"]<child_ends[0]["position"]<frames[cursor]["position"],
                 "same-boot metadata outside the control mount/baseline interval")
        for suffix in ("before","after"):
            key=phase+"-"+suffix
            if suffix=="after":
                native_begin=take("native-begin",phase);native_end=take("native-end",phase)
                need(native_begin["position"]<child_starts[index+1]["position"]<child_ends[index+1]["position"]<native_end["position"],
                     "native owner lifecycle envelope")
                need(f0b._json(native_end["raw"])["pid"]==waits[index+1]["pid"],"native receipt PID")
                selected=[]
                while cursor<len(frames) and frames[cursor]["event"].startswith("view-"):
                    row=frames[cursor];selected.append({k:row[k] for k in FRAME_FIELDS});cursor+=1
                views[key]=source_view(selected,run_id,key,device)
                need(take("unmount",phase)["raw"]==b"/mnt/brd","explicit post-Tcut harness unmount")
                end=take("block-stat-after",phase)
                mount_records[phase]={"before":start["raw"],"mounted":mounted_stats["raw"],"after":end["raw"],"base":base["raw"]}
            selected=[]
            while cursor<len(frames) and frames[cursor]["event"].startswith("snapshot-"):
                row=frames[cursor];selected.append({k:row[k] for k in FRAME_FIELDS});cursor+=1
            snapshots[key]=decode_snapshot(selected,run_id,key,device)
            if suffix == "after": phase_positions[phase+"-after-snapshot"] = frames[cursor-1]["position"]
            if suffix=="before":
                selected=[]
                while cursor<len(frames) and frames[cursor]["event"].startswith("view-"):
                    row=frames[cursor];selected.append({k:row[k] for k in FRAME_FIELDS});cursor+=1
                views[key]=source_view(selected,run_id,key,device)
        round_end=take("round-end",phase)
        phase_positions[phase+"-end"] = round_end["position"]
        windows[phase]=native_window(bytes(native_raw[phase]),phase,native_end,metadata,snapshots[phase+"-before"],snapshots[phase+"-after"],views[phase+"-before"],device)
    need(round_end["position"] < legacy[-2]["position"],"target cleanup before source windows ended")
    final=take("guest-complete","cleanup")
    need(cursor==len(frames) and final["position"]>legacy[-1]["position"],"extra/incomplete cleanup")
    phase_positions["guest-complete"] = final["position"]
    validate_phase_positions(dm_proof, phase_positions)
    cleanup=f0b._json(final["raw"]);closes=cleanup.pop("parent_closes",None)
    need(type(closes) is list and 1<=len(closes)<=128,"missing parent FD cleanup")
    for row in closes:
        f0._fields(row,("fd","errno"));need(type(row["fd"]) is int and row["fd"]>=3 and type(row["errno"]) is int and row["errno"]==0,"unconfirmed parent close")
    need(cleanup=={"original_errno":0,"cleanup_errno":0,"source_observations_complete":True,
        "module_loaded":False,"mounted":False,"node_exists":False,"children_reaped":True,
        "dm_created":False,"dm_node_exists":False,"dm_control_exists":False,"dm_close_unknown":False},"owned resources remain")
    after=snapshots["read-after"];_,journal_after=journal(after)
    filesystem=f2._raw_filesystem(by_name | {
        "unmounted-superblock":{"raw":after.range(1024,1024)},
        "unmounted-group-descriptor":{"raw":after.range(BLOCK_BYTES,64)},
        "unmounted-journal-inode":{"raw":inode(after,8)},
        "unmounted-journal-header":{"raw":journal_after[:BLOCK_BYTES]}},run_id)
    effects=device_effects(snapshots,views,mount_records,run_id)
    artifacts=effects.pop("artifacts")
    for phase,output in native_raw.items():artifacts[phase+"-native.jsonl"]=bytes(output)
    for phase,data in (("p1",p1),("metadata",metadata)):
        for name,observation in data["observations"].items():
            artifacts[phase+"-"+name+".raw"]=observation.pop("raw")
    for row in legacy:
        artifacts["management-"+str(row["seq"])+"-"+row["event"]+".raw"]=row["raw"]
    for row in dm_frames:
        artifacts["dm-"+str(row["seq"])+"-"+row["phase"]+"-"+row["event"]+".raw"] = row["raw"]
    for _, row in dm_ordinary:
        artifacts["dm-child-"+str(row["pid"])+"-fds.json"] = encoded(row)
    need(sum(map(len,artifacts.values()))<=LIMITS["evidence_bytes"],"complete evidence output budget")
    validate_ordinary_fds(dm_ordinary, child_starts, child_ends, waits, run_id)
    return {"state":"F3_DM_SOURCE_PRESERVATION_OBSERVED","profile":PROFILE,"dm":dm_proof,"qualification":"UNSUPPORTED","content_probes":1,
        "production_bound":False,"commit_barrier":False,"accepted_provider_profiles":[],"qualified_kernel_builds":[],
        "policy":policy,"p1":p1,"metadata":metadata,"filesystem":filesystem,"windows":windows,**effects,
        "guest_cleanup":cleanup|{"parent_closes":closes},"raw_artifacts":artifacts,
        "unresolved":["production_source_db_plan_binding","complete_M04_writer_special_path_coverage",
                      "full_native_ext4_SP_qualification","R05_and_durable_restore","native_ext4_B1"]}


# 以下只解析固定来源的原始观察；不存在 caller 的 ready/verified 入口。
def _uint(value, *, positive=False, maximum=(1 << 64) - 1):
    need(type(value) is int and (1 if positive else 0) <= value <= maximum, "DM unsigned integer")
    return value


def _name_set(raw):
    need(type(raw) is bytes and len(raw) <= 65536, "DM inventory bytes")
    if not raw:
        return set()
    parts = raw.split(b"\0")
    need(parts[-1] == b"" and len(parts) <= 257 and len(set(parts)) == len(parts)
         and all(re.fullmatch(rb"[A-Za-z0-9_.-]+", name) for name in parts[:-1]), "DM complete inventory names")
    return set(parts[:-1])


def _node(value, mode=None, rdev=None):
    f0._fields(value, ("dev", "ino", "rdev", "mode", "uid", "gid", "nlink"))
    for key in value:
        _uint(value[key], positive=key in ("ino", "nlink"))
    if mode is not None:
        need(value["mode"] == mode and value["rdev"] == rdev and value["uid"] == value["gid"] == 0
             and value["nlink"] == 1, "DM owned node identity")
    return value


def _reads(rows, names, absent=()):
    need(type(rows) is list and len(rows) == len(names), "DM complete observation set")
    result = {}
    for row, name in zip(rows, names):
        f0._fields(row, ("name", "errno", "close_errno", "hex"))
        need(row["name"] == name and type(row["errno"]) is int and type(row["close_errno"]) is int
             and row["errno"] == (2 if name in absent else 0) and row["close_errno"] == 0,
             "DM native observation errno/close/order")
        result[name] = _hex(row["hex"], 65536)
        if name in absent:
            need(result[name] == b"", "DM absent path has bytes")
    return result


def decode_topology(value, device, baseline):
    f0._fields(value, ("sysname", "resolved", "sys_dev", "sys_ino", "node", "size", "control", "reads"))
    name = value["sysname"]
    need(type(name) is str and re.fullmatch(r"dm-[0-9]{1,10}", name) is not None
         and value["resolved"] == "/sys/devices/virtual/block/" + name, "DM actual sysfs object")
    _uint(value["sys_dev"]); _uint(value["sys_ino"], positive=True)
    _node(value["node"], stat.S_IFBLK | 0o600, device.encoded)
    _node(value["control"], stat.S_IFCHR | 0o600, (10 << 8) | 236)
    need(type(value["size"]) is int and value["size"] == DEVICE_BYTES, "DM actual whole-device bytes")
    keys = ("dev", "size", "ro", "iostats", "name", "uuid", "holders", "slaves", "partition", "ram-holders",
            "ram-slaves", "ram-partition", "sys-block", "ram-node")
    reads = _reads(value["reads"], keys, ("partition", "ram-partition", "ram-node"))
    expected = {"dev": f"{device.major}:{device.minor}\n".encode(), "size": b"131072\n", "ro": b"0\n",
                "iostats": b"1\n", "name": (device.name + "\n").encode(), "uuid": (device.uuid + "\n").encode(),
                "holders": b"", "slaves": b"ram0\0", "ram-holders": name.encode() + b"\0", "ram-slaves": b""}
    need(all(reads[key] == raw for key, raw in expected.items()), "DM forward/reverse graph or fixed kernel fact")
    need(_name_set(reads["sys-block"]) == baseline | {b"ram0", name.encode()}, "DM extra/missing block object")
    return {key: value[key] for key in ("sysname", "resolved", "sys_dev", "sys_ino", "node", "control", "size")}


def _proc_stat(raw, pid):
    need(type(raw) is bytes and 0 < len(raw) <= 8192 and raw.endswith(b"\n"), "DM process stat bytes")
    end = raw.rfind(b")")
    need(raw.startswith(str(pid).encode() + b" (") and end > 0 and raw[end + 1:end + 2] == b" ", "DM pinned process PID")
    parts = raw[end + 2:].split()
    need(len(parts) >= 20 and re.fullmatch(rb"[A-Za-z]", parts[0]) is not None
         and re.fullmatch(rb"[0-9]+", parts[6]) is not None and re.fullmatch(rb"[1-9][0-9]*", parts[19]) is not None,
         "DM process flags/start identity")
    return int(parts[6]), int(parts[19])


def _fds(rows, enumerators):
    need(type(rows) is list and len(rows) == 3 + len(enumerators), "DM descriptor inventory completeness")
    found = set()
    for row in rows:
        f0._fields(row, ("fd", "flags", "stat"))
        fd = _uint(row["fd"], maximum=(1 << 31) - 1); _uint(row["flags"], maximum=(1 << 31) - 1)
        need(fd not in found, "DM duplicated FD")
        found.add(fd); observed = _node(row["stat"])
        if fd in enumerators:
            need(stat.S_ISDIR(observed["mode"]), "DM enumerator object is not a directory")
        else:
            need(fd in (0, 1, 2) and stat.S_ISCHR(observed["mode"])
                 and observed["rdev"] in ((5 << 8) | 1, (1 << 8) | 3), "DM inherited/unowned descriptor")
    need(found == {0, 1, 2} | enumerators, "DM missing/extra descriptor")


def decode_census(processes, end, topology, device, baseline_mounts):
    need(type(processes) is list and 1 <= len(processes) <= 256, "DM process inventory bound")
    pids = set(); own = None
    for row in processes:
        f0._fields(row, ("pid", "pin", "proc_enumerator", "before_hex", "fds", "enumerator", "after_hex"))
        pid = _uint(row["pid"], positive=True, maximum=(1 << 31) - 1)
        need(pid not in pids, "DM process inventory duplicate")
        pids.add(pid)
        for name in ("pin", "proc_enumerator", "enumerator"):
            need(_uint(row[name], maximum=(1 << 31) - 1) >= 3, "DM actual process enumeration FD")
        need(len({row["pin"], row["proc_enumerator"], row["enumerator"]}) == 3, "DM aliased enumeration FD")
        flags, start = _proc_stat(_hex(row["before_hex"], 8192), pid)
        after_flags, after_start = _proc_stat(_hex(row["after_hex"], 8192), pid)
        need(start == after_start, "DM reused process identity")
        if pid == 1:
            _fds(row["fds"], {row["pin"], row["proc_enumerator"], row["enumerator"]}); own = row
        else:
            need(flags & 0x200000 and after_flags & 0x200000 and row["fds"] == [], "DM unowned userspace actor/FD")
    need(own is not None and all(row["proc_enumerator"] == own["proc_enumerator"] for row in processes), "DM same owned process scan")
    f0._fields(end, ("process_count", "nodes", "mountinfo_hex"))
    need(type(end["process_count"]) is int and end["process_count"] == len(processes)
         and type(end["nodes"]) is list and len(end["nodes"]) == 4, "DM complete process/device-node census")
    nodes = {}
    for row in end["nodes"]:
        f0._fields(row, ("path", "stat")); need(type(row["path"]) is str and row["path"] not in nodes, "DM device-node alias")
        nodes[row["path"]] = _node(row["stat"])
    need(set(nodes) == {"/dev/console", "/dev/null", "/dev/boardroom-f3-dm", "/dev/boardroom-f3-dm-control"}, "DM extra device node/bypass alias")
    need(nodes["/dev/boardroom-f3-dm"] == topology["node"] and nodes["/dev/boardroom-f3-dm-control"] == topology["control"], "DM node replaced during census")
    _node(nodes["/dev/console"], stat.S_IFCHR | 0o600, (5 << 8) | 1)
    _node(nodes["/dev/null"], stat.S_IFCHR | 0o666, (1 << 8) | 3)
    native = f2._module("native"); mounts = native.mountinfo(_hex(end["mountinfo_hex"], 65536))
    root_points = {"/", "/proc", "/sys"}; points = {row["point"] for row in mounts}
    # 全部七个 census 均在未挂载源的阶段，不能把额外挂载留给后续判别。
    need(len(points) == len(mounts) and points == root_points, "DM unexpected mount")
    for row in mounts:
        if row["point"] in root_points:
            prior = [entry for entry in baseline_mounts if entry["point"] == row["point"]]
            need(len(prior) == 1 and all(row[k] == prior[0][k] for k in ("id", "device", "root", "type", "options", "super")), "DM baseline mount identity changed")
    return {"processes": len(processes), "root_start_ticks": _proc_stat(_hex(own["before_hex"], 8192), 1)[1],
            "nodes": nodes, "mounts": mounts}


def validate_ordinary_fds(records, starts, ends, waits, run_id):
    need(type(records) is list and len(records) == 3, "DM ordinary owner census count")
    for (position, row), start, end, wait in zip(records, starts, ends, waits):
        f0._fields(row, ("run_id", "origin", "pid", "uid", "gid", "enumerator", "fds", "errno", "close_errno"))
        need(row["run_id"] == run_id and row["origin"] == "ordinary" and type(row["pid"]) is int
             and row["pid"] == wait["pid"] and row["uid"] == row["gid"] == 1000
             and type(row["errno"]) is int and row["errno"] == 0
             and type(row["close_errno"]) is int and row["close_errno"] == 0
             and start["position"] < position < end["position"], "DM ordinary live owner boundary/close")
        need(_uint(row["enumerator"], maximum=(1 << 31) - 1) >= 3, "DM ordinary FD enumerator")
        _fds(row["fds"], {row["enumerator"]})


def validate_format_fds(raw, wait, run_id):
    prefix = b"BRDDM-MKFS "
    need(type(raw) is bytes and raw.startswith(prefix) and raw.count(prefix) == 1 and b"\n" in raw,
         "DM format entry FD receipt is absent/replayed")
    first = raw.split(b"\n", 1)[0]
    need(len(first) <= FRAME_BYTES, "DM format entry frame budget")
    value = f0b._json(first[len(prefix):])
    f0._fields(value, ("run_id", "origin", "pid", "uid", "gid", "executable_fd", "executable_size", "enumerator", "fds", "errno", "close_errno"))
    need(value["run_id"] == run_id and value["origin"] == "format" and _uint(value["pid"], positive=True) == wait["pid"]
         and type(value["uid"]) is int and value["uid"] == 0 and type(value["gid"]) is int and value["gid"] == 0
         and type(value["executable_size"]) is int and value["executable_size"] == f2.PAYLOAD_FILES["usr/sbin/mke2fs"][0]
         and type(value["errno"]) is int and value["errno"] == 0 and type(value["close_errno"]) is int and value["close_errno"] == 0,
         "DM format entry owner/close")
    executable, enumerator = value["executable_fd"], value["enumerator"]
    need(_uint(executable, maximum=(1 << 31) - 1) >= 3 and _uint(enumerator, maximum=(1 << 31) - 1) >= 3
         and executable != enumerator and type(value["fds"]) is list and len(value["fds"]) == 5, "DM format descriptor set")
    found = set()
    for row in value["fds"]:
        f0._fields(row, ("fd", "flags", "fd_flags", "stat"))
        fd = _uint(row["fd"], maximum=(1 << 31) - 1); flags = _uint(row["flags"], maximum=(1 << 31) - 1)
        descriptor_flags = _uint(row["fd_flags"], maximum=1); observed = _node(row["stat"])
        need(fd not in found, "DM repeated format FD")
        found.add(fd)
        if fd == executable:
            _node(observed, stat.S_IFREG | 0o555, 0)
            need(flags & 3 == 0 and flags & ~(0x8000 | 0x20000) == 0 and descriptor_flags == 1, "DM format executable must close on exec")
        elif fd == enumerator:
            need(stat.S_ISDIR(observed["mode"]) and descriptor_flags == 1, "DM format enumerator")
        elif fd == 0:
            _node(observed, stat.S_IFCHR | 0o666, 259)
            need(flags & 3 == 0 and descriptor_flags == 0, "DM format null input")
        else:
            need(fd in (1, 2) and stat.S_ISFIFO(observed["mode"]) and observed["rdev"] == 0
                 and flags & 3 == 1 and descriptor_flags == 0, "DM format stdout/stderr ownership")
    need(found == {0, 1, 2, executable, enumerator}, "DM inherited format FD")
    return {"pid": value["pid"], "stage": "after-fork-before-fixed-exec", "closed_enumerator": enumerator,
            "cloexec_executable": executable}


def decode_dm_frames(frames, run_id, p1):
    selected = [row for row in frames if row["event"].startswith("dm-")]
    other = [row for row in frames if not row["event"].startswith("dm-")]
    need(selected, "DM evidence is absent")
    previous_position = previous_sequence = -1
    for row in selected:
        f0._fields(row, (*FRAME_FIELDS, "raw", "position"))
        payload, _ = _frame({name: row[name] for name in FRAME_FIELDS}, run_id)
        need(payload == row["raw"] and row["rc"] == row["errno"] == row["close_errno"] == 0,
             "DM raw/operation/close evidence mismatch")
        need(type(row["position"]) is int and row["position"] > previous_position
             and row["seq"] > previous_sequence, "DM reused/reordered frame position")
        previous_position, previous_sequence = row["position"], row["seq"]
    cursor = 0
    def take(event, phase):
        nonlocal cursor
        need(cursor < len(selected) and selected[cursor]["event"] == event and selected[cursor]["phase"] == phase,
             "DM missing/reordered lifecycle " + phase + ":" + event)
        row = selected[cursor]; cursor += 1
        return row
    backing = take("dm-backing", "setup")
    raw = f0b._json(backing["raw"]); f0._fields(raw, ("reads",))
    actual = _reads(raw["reads"], ("dev", "size", "ro", "holders", "slaves", "partition"), ("partition",))
    need(actual == {"dev": b"1:0\n", "size": b"131072\n", "ro": b"0\n", "holders": b"", "slaves": b"", "partition": b""}, "DM backing pregraph")
    control = f0b._json(take("dm-control", "setup")["raw"])
    f0._fields(control, ("sysfs_hex", "resolved", "node"))
    need(_hex(control["sysfs_hex"], 32) == b"10:236\n" and control["resolved"] == "/sys/devices/virtual/misc/device-mapper", "DM actual control misc identity")
    _node(control["node"], stat.S_IFCHR | 0o600, 2796)
    for command in ("version", "list"):
        decode_ioctl(take("dm-" + command, "setup")["raw"], command, run_id)
    device = decode_ioctl(take("dm-create", "setup")["raw"], "create", run_id)
    for command in ("load", "resume"):
        decode_ioctl(take("dm-" + command, "setup")["raw"], command, run_id, device)
    retired = take("dm-backing-retired", "setup"); value = f0b._json(retired["raw"])
    f0._fields(value, ("node", "after_errno")); _node(value["node"], stat.S_IFBLK | 0o600, 256)
    need(type(value["after_errno"]) is int and value["after_errno"] == 2, "DM backing node not retired")
    baseline = _name_set(p1["observations"]["sys_block"]["raw"])
    native = f2._module("native"); baseline_mounts = native.mountinfo(p1["observations"]["mountinfo"]["raw"])
    need({row["point"] for row in baseline_mounts} == {"/", "/proc", "/sys"} and len(baseline_mounts) == 3, "DM fixed initial mount set")
    phases = {}; stable = None; root_start = None
    def observe(phase):
        nonlocal stable, root_start
        first = take("dm-status", phase); decode_ioctl(first["raw"], "status", run_id, device)
        for command in ("table", "deps"):
            decode_ioctl(take("dm-" + command, phase)["raw"], command, run_id, device)
        topology = decode_topology(f0b._json(take("dm-topology", phase)["raw"]), device, baseline)
        if stable is None:
            stable = topology
        need(topology == stable and topology["control"] == control["node"], "DM topology/node identity changed")
        need(take("dm-census-start", phase)["raw"] == b"", "DM census start payload")
        rows = []
        while cursor < len(selected) and selected[cursor]["event"] == "dm-census-process":
            rows.append(f0b._json(take("dm-census-process", phase)["raw"]))
        end = take("dm-census-end", phase)
        census = decode_census(rows, f0b._json(end["raw"]), topology, device, baseline_mounts)
        if root_start is None:
            root_start = census["root_start_ticks"]
        need(census["root_start_ticks"] == root_start, "DM management process changed")
        phases[phase] = {"start": first["position"], "end": end["position"], "process_count": census["processes"]}
    observe("created")
    steps = [f0b._json(take("dm-calibration-step", "calibration")["raw"]) for _ in range(5)]
    calibration = f0b._json(take("dm-calibration-end", "calibration")["raw"])
    need(type(calibration) is dict and "steps" not in calibration, "DM calibration duplicate steps")
    calibrated = decode_calibration(calibration | {"steps": steps}, device.encoded)
    for phase in ("calibrated", "control-before", "control-after", "read-before", "read-after", "before-remove"):
        observe(phase)
    removed = take("dm-remove", "cleanup"); decode_ioctl(removed["raw"], "remove", run_id, device)
    decode_ioctl(take("dm-list", "cleanup")["raw"], "list", run_id)
    cleanup = take("dm-removed", "cleanup"); actual = f0b._json(cleanup["raw"])
    need(actual == {"sysfs_errno": 2, "dev_link_errno": 2, "ram_holders_hex": "", "node_unlink_errno": 0,
                    "control_unlink_errno": 0, "node_exists": False, "control_exists": False}, "DM removal/owned node cleanup not proven")
    need(cursor == len(selected), "DM extra/replayed lifecycle")
    return other, {"profile": PROFILE, "device": {"name": device.name, "uuid": device.uuid,
        "encoded": device.encoded, "major": device.major, "minor": device.minor}, "sysname": stable["sysname"],
        "topology": stable, "calibration": calibrated, "phases": phases, "setup_start": backing["position"],
        "backing_retired": retired["position"], "remove_start": removed["position"], "cleanup_end": cleanup["position"],
        "qualification": "UNSUPPORTED", "production_supported": False}, device


def validate_phase_positions(proof, anchors):
    """DM 生命周期必须夹住同次串行流中的真实 F2/F3 操作，不能只验证一条独立旁路。"""
    f0._fields(anchors, ("geometry", "device-remove", "format-start", "mount-private", "prepare-begin", "prepare-end",
                        "control-begin", "control-after-snapshot", "control-end", "read-begin", "read-after-snapshot",
                        "read-end", "cleanup-fd", "module-unload", "guest-complete"))
    p, a = proof["phases"], anchors
    positions = [a["geometry"], proof["setup_start"], a["device-remove"], proof["backing_retired"],
                 p["created"]["start"], p["created"]["end"], p["calibrated"]["start"], p["calibrated"]["end"],
                 a["format-start"], a["mount-private"], a["prepare-begin"], a["prepare-end"],
                 p["control-before"]["start"], p["control-before"]["end"], a["control-begin"], a["control-after-snapshot"],
                 p["control-after"]["start"], p["control-after"]["end"], a["control-end"],
                 p["read-before"]["start"], p["read-before"]["end"], a["read-begin"], a["read-after-snapshot"],
                 p["read-after"]["start"], p["read-after"]["end"], a["read-end"], a["cleanup-fd"],
                 p["before-remove"]["start"], p["before-remove"]["end"], proof["remove_start"], proof["cleanup_end"],
                 a["module-unload"], a["guest-complete"]]
    need(all(type(value) is int and value >= 0 for value in positions)
         and all(left < right for left, right in zip(positions, positions[1:])), "DM lifecycle is detached from format/source/cleanup")


def mkfs_argv(run_id):
    args = f2.mkfs_argv(run_id)
    need(args[-2:] == ["/dev/ram0", "16384"], "DM inherited mkfs contract drift")
    return args[:-2] + ["/dev/boardroom-f3-dm", "16384"]

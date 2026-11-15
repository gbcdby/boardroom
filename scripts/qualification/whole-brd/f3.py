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

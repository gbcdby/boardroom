#!/usr/bin/env python3
"""Private F0B/F1 raw-input preparation; no qualification authority."""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import stat
import zlib

import f0

MIB = 1024 * 1024
SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6890398295"
CMDLINE = "console=ttyS0,115200n8 rdinit=/init loglevel=4 panic=0 bdev_allow_write_mounted=0"
LIMITS = {
    "guest_memory_bytes": 512 * MIB, "vcpus": 1,
    "child_as_bytes": 2048 * MIB, "child_cpu_seconds": 300,
    "compile_seconds": 10, "stage_seconds": 60, "probe_seconds": 3,
    "boot_seconds": 60, "ordinary_seconds": 3, "fixture_seconds": 300,
    "job_seconds": 600, "qmp_wait_seconds": 5, "term_wait_seconds": 2,
    "kill_reap_seconds": 3, "serial_bytes": 8 * MIB, "evidence_bytes": 64 * MIB,
    "compressed_bytes": 16 * MIB, "expanded_bytes": 32 * MIB,
}
INIT = b'''#!/bin/sh
if ! /bin/busybox mount -t proc -o ro,nosuid,nodev,noexec proc /proc; then
  echo BRDF1-MANAGEMENT-FAIL-proc >&2; exit 1
fi
if ! /bin/busybox mount -t sysfs -o ro,nosuid,nodev,noexec sysfs /sys; then
  echo BRDF1-MANAGEMENT-FAIL-sysfs >&2; exit 1
fi
exec /bin/brd-helper bootstrap
'''


def _json(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=f0._object,
                          parse_constant=f0._invalid_constant)
    except (UnicodeError, RecursionError) as error:
        raise ValueError("invalid bounded JSON") from error


def plan(raw: bytes) -> dict:
    if type(raw) is not bytes or len(raw) > 16 * 1024:
        raise ValueError("bounded request required")
    value = _json(raw)
    f0._fields(value, ("run_id",))
    run_id = str(f0._uuid(value["run_id"]))
    return {"kind": "whole-brd-f0bf1-inputs", "scope": SCOPE, "run_id": run_id,
            "fixture_targets": 0, "ambient_block_objects": "MUST_OBSERVE_NOT_ASSUME_EMPTY",
            "qualification": "UNSUPPORTED", "guest_execution": "NOT_RUN",
            "policy": "UNKNOWN", "limits": dict(LIMITS), "cmdline": CMDLINE}


def _entry(name, mode, data=b"", major=0, minor=0):
    return {"name": name, "mode": mode, "data": data, "rdevmajor": major, "rdevminor": minor}


def _entries(run_id, busybox, helper):
    plan(json.dumps({"run_id": run_id}).encode())
    if type(busybox) is not bytes or not 0 < len(busybox) <= 4 * MIB:
        raise ValueError("bounded BusyBox bytes required")
    if type(helper) is not bytes or not 0 < len(helper) <= 4 * MIB:
        raise ValueError("bounded helper bytes required")
    expected = {"kind": "expected-inputs-only", "run_id": run_id,
                "busybox_sha256": hashlib.sha256(busybox).hexdigest(),
                "helper_sha256": hashlib.sha256(helper).hexdigest(),
                "fixture_targets": 0, "qualification": "UNSUPPORTED"}
    return ([_entry(n, stat.S_IFDIR | 0o555) for n in ("bin", "dev", "proc", "sys", "run")]
            + [_entry("bin/busybox", stat.S_IFREG | 0o755, busybox),
               _entry("bin/sh", stat.S_IFLNK | 0o777, b"busybox"),
               _entry("bin/brd-helper", stat.S_IFREG | 0o755, helper),
               _entry("init", stat.S_IFREG | 0o755, INIT),
               _entry("dev/console", stat.S_IFCHR | 0o600, major=5, minor=1),
               _entry("dev/null", stat.S_IFCHR | 0o666, major=1, minor=3),
               _entry("run/run-id", stat.S_IFREG | 0o444, (run_id + "\n").encode()),
               _entry("run/expected.json", stat.S_IFREG | 0o444,
                      (json.dumps(expected, sort_keys=True) + "\n").encode())])


def _newc_record(entry, ino):
    name = entry["name"].encode("ascii") + b"\0"
    fields = (ino, entry["mode"], 0, 0, 1, 0, len(entry["data"]), 0, 0,
              entry["rdevmajor"], entry["rdevminor"], len(name), 0)
    raw = b"070701" + b"".join(f"{v:08x}".encode() for v in fields) + name
    raw += b"\0" * (-len(raw) % 4)
    raw += entry["data"]
    return raw + b"\0" * (-len(entry["data"]) % 4)


def payload(run_id: str, busybox: bytes, helper: bytes) -> bytes:
    entries = _entries(run_id, busybox, helper)
    raw = b"".join(_newc_record(e, i + 1) for i, e in enumerate(entries))
    raw += _newc_record(_entry("TRAILER!!!", 0), 0)
    if len(raw) > LIMITS["expanded_bytes"]:
        raise ValueError("expanded payload budget exceeded")
    result = gzip.compress(raw, compresslevel=9, mtime=0)
    if len(result) > LIMITS["compressed_bytes"]:
        raise ValueError("compressed payload budget exceeded")
    inspect_payload(result, run_id)
    return result


def _decode_newc(raw):
    entries = []; offset = 0
    while True:
        if len(entries) > 13 or offset + 110 > len(raw) or raw[offset:offset + 6] != b"070701":
            raise ValueError("invalid bounded newc header")
        try:
            fields = [int(raw[i:i + 8], 16) for i in range(offset + 6, offset + 110, 8)]
        except ValueError as error:
            raise ValueError("invalid newc numbers") from error
        ino, mode, uid, gid, nlink, mtime, size, devmaj, devmin, maj, minor, namesize, check = fields
        if (uid, gid, nlink, mtime, devmaj, devmin, check) != (0, 0, 1, 0, 0, 0, 0) or not 1 <= namesize <= 128:
            raise ValueError("noncanonical archive metadata")
        start = offset + 110; end = start + namesize
        if end > len(raw) or raw[end - 1] != 0 or b"\0" in raw[start:end - 1]:
            raise ValueError("invalid member name")
        try:
            name = raw[start:end - 1].decode("ascii")
        except UnicodeError as error:
            raise ValueError("non-ASCII member name") from error
        padded = end + (-end % 4)
        data_end = padded + size; next_offset = data_end + (-size % 4)
        if next_offset > len(raw) or any(raw[end:padded]) or any(raw[data_end:next_offset]):
            raise ValueError("truncated or noncanonical member")
        entry = _entry(name, mode, raw[padded:data_end], maj, minor)
        if name == "TRAILER!!!":
            if (ino, mode, size, maj, minor) != (0, 0, 0, 0, 0) or next_offset != len(raw):
                raise ValueError("invalid archive trailer")
            return entries
        if ino != len(entries) + 1:
            raise ValueError("noncanonical member inode")
        entries.append(entry); offset = next_offset


def inspect_payload(data: bytes, run_id: str) -> dict:
    if type(data) is not bytes or len(data) > LIMITS["compressed_bytes"]:
        raise ValueError("compressed payload budget exceeded")
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data, LIMITS["expanded_bytes"] + 1)
    except zlib.error as error:
        raise ValueError("invalid gzip payload") from error
    if len(raw) > LIMITS["expanded_bytes"] or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("incomplete, trailing or oversized gzip payload")
    entries = _decode_newc(raw)
    by_name = {e["name"]: e for e in entries}
    if len(by_name) != len(entries) or "bin/busybox" not in by_name or "bin/brd-helper" not in by_name:
        raise ValueError("missing or repeated fixed member")
    expected = _entries(run_id, by_name["bin/busybox"]["data"], by_name["bin/brd-helper"]["data"])
    if entries != expected:
        raise ValueError("payload differs from fixed members/types/content")
    return {"state": "OFFLINE_PAYLOAD_ONLY", "guest_execution": "NOT_RUN",
            "compressed_bytes": len(data), "expanded_bytes": len(raw),
            "sha256": hashlib.sha256(data).hexdigest(),
            "members": [{k: v for k, v in e.items() if k != "data"} |
                        {"bytes": len(e["data"]), "sha256": hashlib.sha256(e["data"]).hexdigest()}
                        for e in entries]}


def decode_serial(raw: bytes, run_id: str, expected_notes: bytes) -> dict:
    plan(json.dumps({"run_id": run_id}).encode())
    if type(raw) is not bytes or len(raw) > LIMITS["serial_bytes"]:
        raise ValueError("serial budget exceeded")
    frames = []
    for line in raw.splitlines(keepends=True):
        if b"BRDF1 " not in line:
            continue
        if not line.startswith(b"BRDF1 ") or not line.endswith(b"\n"):
            raise ValueError("interleaved or incomplete frame")
        frame = _json(line[6:].rstrip(b"\r\n"))
        if type(frame) is not dict or frame.get("run_id") != run_id:
            raise ValueError("wrong frame identity")
        frames.append(frame)
    start = {"run_id": run_id, "origin": "management", "event": "ordinary-start"}
    if len(frames) != len(OBSERVATIONS) + 2 or frames[0] != start:
        raise ValueError("incomplete or repeated ordinary pass")
    exit_frame = frames[-1]
    f0._fields(exit_frame, ("run_id", "origin", "event", "exit", "signal", "timeout", "pidfd_close_errno"))
    if exit_frame["origin"] != "management" or exit_frame["event"] != "ordinary-exit":
        raise ValueError("missing actual management wait result")
    if type(exit_frame["exit"]) is not int or not -1 <= exit_frame["exit"] <= 255 or type(exit_frame["signal"]) is not int or not 0 <= exit_frame["signal"] <= 64 or type(exit_frame["timeout"]) is not bool:
        raise ValueError("invalid child wait result")
    if type(exit_frame["pidfd_close_errno"]) is not int or not 0 <= exit_frame["pidfd_close_errno"] <= 4095:
        raise ValueError("invalid original pidfd close errno")
    complete = exit_frame["exit"] == 0 and exit_frame["signal"] == 0 and not exit_frame["timeout"] and exit_frame["pidfd_close_errno"] == 0
    results = {}
    for seq, (frame, (item, source, limit)) in enumerate(zip(frames[1:-1], OBSERVATIONS), 1):
        f0._fields(frame, ("run_id", "origin", "seq", "item", "path", "status", "errno", "eof", "close_errno", "bytes", "data_hex"))
        if frame["origin"] != "ordinary" or type(frame["seq"]) is not int or frame["seq"] != seq or frame["item"] != item or frame["path"] != source:
            raise ValueError("ordinary phase/source/order mismatch")
        if type(frame["bytes"]) is not int or not 0 <= frame["bytes"] <= limit + 1 or type(frame["data_hex"]) is not str or not re.fullmatch(r"[0-9a-f]*", frame["data_hex"]) or len(frame["data_hex"]) != 2 * frame["bytes"]:
            raise ValueError("invalid raw byte framing")
        for key in ("errno", "close_errno"):
            if type(frame[key]) is not int or not 0 <= frame[key] <= 4095:
                raise ValueError("invalid original errno")
        if type(frame["eof"]) is not bool or frame["status"] not in ("OK", "ABSENT", "ERROR"):
            raise ValueError("invalid observation status")
        ok = frame["status"] == "OK" and frame["errno"] == 0
        if item == "brd_presence":
            ok = frame["status"] == "ABSENT" and frame["errno"] == 2
        complete &= ok and frame["eof"] and frame["close_errno"] == 0 and frame["bytes"] <= limit
        data = bytes.fromhex(frame["data_hex"])
        results[item] = {"path": source, "raw": data, "frame": frame, "sha256": hashlib.sha256(data).hexdigest()}
    if not complete:
        return {"state": "ORDINARY_FAILED", "policy": "UNKNOWN", "qualification": "UNSUPPORTED", "observations": results, "wait": exit_frame}
    before = _ordinary_status(results["status_before"]["raw"])
    after = _ordinary_status(results["status_after"]["raw"])
    if before != after:
        raise ValueError("ordinary identity changed")
    for name, prefix in (("ns_pid", b"pid"), ("ns_user", b"user"), ("ns_mnt", b"mnt")):
        if not re.fullmatch(prefix + rb":\[[1-9][0-9]*\]", results[name]["raw"]):
            raise ValueError("invalid namespace identity")
    try:
        f0._uuid(results["boot_id"]["raw"].decode("ascii").rstrip("\n"))
    except (UnicodeError, ValueError) as error:
        raise ValueError("invalid actual boot identity") from error
    names = results["sys_block"]["raw"].split(b"\0")
    if names[-1] != b"" or len(names) - 1 > 256 or any(not n or b"/" in n or n in (b".", b"..") for n in names[:-1]):
        raise ValueError("invalid bounded block-name enumeration")
    uname = results["uname"]["raw"]
    bound = (results["notes"]["raw"] == expected_notes and
             results["osrelease"]["raw"] == b"7.0.0-1017-azure\n" and
             len(uname) == 390 and uname[130:195].split(b"\0", 1)[0] == b"7.0.0-1017-azure" and
             results["cmdline"]["raw"] == CMDLINE.encode() + b"\n")
    return {"state": "CAPTURE_COMPLETE" if bound else "INPUT_MISMATCH", "fixture_targets": 0,
            "policy": "POLICY_INPUTS_CAPTURED" if bound else "UNKNOWN", "qualification": "UNSUPPORTED",
            "observations": results, "wait": exit_frame, "ordinary_identity": before}


OBSERVATIONS = (
    ("status_before", "/proc/self/status", 64 * 1024), ("self_stat", "/proc/self/stat", 8 * 1024),
    ("uid_map", "/proc/self/uid_map", 4096), ("gid_map", "/proc/self/gid_map", 4096),
    ("ns_pid", "/proc/self/ns/pid", 1024), ("ns_user", "/proc/self/ns/user", 1024),
    ("ns_mnt", "/proc/self/ns/mnt", 1024), ("uname", "syscall:uname", 4096),
    ("version", "/proc/version", 16 * 1024), ("osrelease", "/proc/sys/kernel/osrelease", 16 * 1024),
    ("boot_id", "/proc/sys/kernel/random/boot_id", 4096), ("notes", "/sys/kernel/notes", MIB),
    ("cmdline", "/proc/cmdline", 16 * 1024), ("mountinfo", "/proc/self/mountinfo", 64 * 1024),
    ("modules", "/proc/modules", 64 * 1024), ("brd_presence", "/sys/module/brd", 256),
    ("sys_block", "/sys/block", 64 * 1024), ("status_after", "/proc/self/status", 64 * 1024),
    ("end", "collector:end", 0),
)


def _ordinary_status(raw):
    fields = {}
    for line in raw.splitlines():
        if b":" in line:
            key, value = line.split(b":", 1)
            if key in fields:
                raise ValueError("duplicate actual status field")
            fields[key] = value.strip()
    for key in (b"Uid", b"Gid"):
        if fields.get(key, b"").split() != [b"1000"] * 4:
            raise ValueError("ordinary UID/GID not established")
    if fields.get(b"Groups") != b"" or fields.get(b"NoNewPrivs") != b"1":
        raise ValueError("ordinary groups/NNP not established")
    for key in (b"CapInh", b"CapPrm", b"CapEff", b"CapBnd", b"CapAmb"):
        if not re.fullmatch(rb"0{16}", fields.get(key, b"")):
            raise ValueError("ordinary capability set not empty")
    if not re.fullmatch(rb"[1-9][0-9]*", fields.get(b"Pid", b"")) or fields.get(b"PPid") != b"1":
        raise ValueError("ordinary process relationship not established")
    return {"pid": int(fields[b"Pid"]), "parent_pid": 1, "uid": 1000, "gid": 1000,
            "groups": [], "five_caps": "ZERO", "no_new_privs": 1}

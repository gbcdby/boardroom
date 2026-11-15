"""Fixed private F2 input and evidence contract. Importing never runs payloads."""
from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import uuid
import zlib

import f0
import f0b

SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6892780062"
POLICY_SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6892768329"
MIB = f0b.MIB
LIMITS = dict(f0b.LIMITS)
VERSION = "#17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026"
CONFIG_SHA = "29ff35ee2a05a0c672271c378be8626e71f2ab71c3e553af8dd91196a40d7e23"
NOTES_SHA = "d0dbc2744ebce79f09543c87f4659b3ca605c626d4295531212207a5ad5f5960"
BRD_SHA = "5ded0a1b28527421746455918b392eb5afe5f4952bc660f4058a4496c290cb81"
BRD_BUILD_ID = "2d563efa476345d36d936eba2fddc8c4750f6bfb"
BRD_SRCVERSION = b"EDA2F83585B24D6AFCDBC66\n"
FEATURES = (60, 706, 1131)
FEATURE_NAMES = ("has_journal", "ext_attr", "resize_inode", "dir_index", "filetype", "extent", "64bit", "flex_bg",
                 "sparse_super", "large_file", "huge_file", "dir_nlink", "extra_isize", "metadata_csum")
MKFS_ENV = {"PATH": "/usr/sbin:/bin", "LANG": "C", "LC_ALL": "C", "MKE2FS_CONFIG": "/etc/mke2fs-f2.conf"}
PAYLOAD_FILES = {
    "usr/sbin/mke2fs": (146000, "14d64b707e37214aff4568470bb4d908232370684c7eff05465d78116c2c9c67", 0o555),
    "usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2": (225672, "c8438e4fde1934e61c88311633f00949ff645d5c04cdb8671fa3d78164d2f307", 0o555),
    "usr/lib/x86_64-linux-gnu/libc.so.6": (1995216, "9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92", 0o555),
    "usr/lib/x86_64-linux-gnu/libblkid.so.1.1.0": (396256, "116b712c143ac68bb59f6d8e32ed8e05e0772c730a9ba55ec544dd28916af58c", 0o444),
    "usr/lib/x86_64-linux-gnu/libcom_err.so.2.1": (18344, "dc4828400674492839b630c001db424cd38e5cecfcf46dbf705a637647e04bea", 0o444),
    "usr/lib/x86_64-linux-gnu/libe2p.so.2.3": (45016, "e436d442d0453c844163c2a5e62b67891d1ceacf19560d4d38bb3444d8099c90", 0o444),
    "usr/lib/x86_64-linux-gnu/libext2fs.so.2.4": (446800, "fa8293e8dfd3a3a5f699e769c60d39a723c5e9ed192e91bd3840765efd162c95", 0o444),
    "usr/lib/x86_64-linux-gnu/libuuid.so.1.3.0": (39048, "632fd43a9d8d6f3496833b7e62e7840f397163373dddf8b8eb0b2b7f36593117", 0o444),
}
PAYLOAD_LINKS = {
    "lib": "usr/lib", "lib64": "usr/lib64",
    "usr/lib64/ld-linux-x86-64.so.2": "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    "usr/lib/x86_64-linux-gnu/libblkid.so.1": "libblkid.so.1.1.0",
    "usr/lib/x86_64-linux-gnu/libcom_err.so.2": "libcom_err.so.2.1",
    "usr/lib/x86_64-linux-gnu/libe2p.so.2": "libe2p.so.2.3",
    "usr/lib/x86_64-linux-gnu/libext2fs.so.2": "libext2fs.so.2.4",
    "usr/lib/x86_64-linux-gnu/libuuid.so.1": "libuuid.so.1.3.0",
}
INIT = b'''#!/bin/sh
if ! /bin/busybox mount -t proc -o ro,nosuid,nodev,noexec proc /proc; then
  echo BRDF2-MANAGEMENT-FAIL-proc >&2; exit 1
fi
if ! /bin/busybox mount -t sysfs -o ro,nosuid,nodev,noexec sysfs /sys; then
  echo BRDF2-MANAGEMENT-FAIL-sysfs >&2; exit 1
fi
exec /bin/brd-f2 bootstrap
'''


def plan(raw):
    if type(raw) is not bytes or len(raw) > 16384:
        raise ValueError("bounded F2 request required")
    value = f0b._json(raw)
    f0._fields(value, ("run_id",))
    run_id = str(f0._uuid(value["run_id"]))
    def derive(purpose):
        return str(uuid.UUID(bytes=hashlib.sha256((run_id + purpose).encode()).digest()[:16], version=4))
    return {"kind": "whole-brd-f2-metadata", "scope": SCOPE, "policy_scope": POLICY_SCOPE, "run_id": run_id,
            "fixture_targets": 1, "target_bytes": 64 * MIB, "content_probes": 0,
            "qualification": "UNSUPPORTED", "guest_execution": "NOT_RUN", "limits": dict(LIMITS),
            "cmdline": f0b.CMDLINE, "filesystem_uuid": derive(":filesystem"), "hash_seed_uuid": derive(":hash-seed"),
            "features": list(FEATURES), "journal_bytes": 4 * MIB,
            "ambient_block_objects": "MUST_OBSERVE_NOT_ASSUME_EMPTY"}


def mkfs_argv(run_id):
    p = plan(json.dumps({"run_id": run_id}).encode())
    return ["/usr/sbin/mke2fs", "-t", "ext4", "-T", "brd64", "-b", "4096", "-I", "256", "-i", "16384", "-m", "0",
            "-U", p["filesystem_uuid"], "-J", "size=4", "-O", "none," + ",".join(FEATURE_NAMES),
            "-E", "lazy_itable_init=0,lazy_journal_init=0,nodiscard,assume_storage_prezeroed=0,hash_seed=" + p["hash_seed_uuid"],
            "/dev/ram0", "16384"]


def config_bytes(raw):
    if type(raw) is not bytes or hashlib.sha256(raw).hexdigest() != CONFIG_SHA:
        raise ValueError("exact accepted F2 config required; no fallback")
    return raw


def policy(capture):
    if capture["state"] != "CAPTURE_COMPLETE" or capture["policy"] != "POLICY_INPUTS_CAPTURED":
        raise ValueError("current complete ordinary capture required")
    obs = capture["observations"]
    uname = obs["uname"]["raw"]
    expected = ((0, b"Linux"), (130, b"7.0.0-1017-azure"), (195, VERSION.encode()), (260, b"x86_64"))
    if len(uname) != 390 or any(uname[off:off + 65].split(b"\0", 1)[0] != val for off, val in expected):
        raise ValueError("actual exact vendor uname mismatch")
    if obs["cmdline"]["raw"] != f0b.CMDLINE.encode() + b"\n" or obs["modules"]["raw"] != b"":
        raise ValueError("exact complete policy inputs and pre-module state required")
    if obs["brd_presence"]["raw"] != b"absent\n":
        raise ValueError("existing brd must not be taken over")
    if any(name.startswith(b"ram") for name in obs["sys_block"]["raw"].split(b"\0")):
        raise ValueError("unexpected prior RAM block object")
    return "SOURCE_INFERRED_FALSE_FOR_CURRENT_BOOT"


def _entries(run_id, busybox, helper, notes, brd, config, files):
    p = plan(json.dumps({"run_id": run_id}).encode())
    if any(type(b) is not bytes or not 0 < len(b) <= 4 * MIB for b in (busybox, helper)):
        raise ValueError("bounded fixed executable bytes required")
    if hashlib.sha256(notes).hexdigest() != NOTES_SHA or len(brd) != 30017 or hashlib.sha256(brd).hexdigest() != BRD_SHA:
        raise ValueError("exact notes/module required")
    config_bytes(config)
    if set(files) != set(PAYLOAD_FILES):
        raise ValueError("exact eight ELF members required")
    for name, (size, digest, _) in PAYLOAD_FILES.items():
        if type(files[name]) is not bytes or len(files[name]) != size or hashlib.sha256(files[name]).hexdigest() != digest:
            raise ValueError("fixed e2fs input mismatch: " + name)
    entry = f0b._entry
    directories = ("bin", "dev", "etc", "mnt", "mnt/brd", "proc", "sys", "run", "usr", "usr/sbin", "usr/lib",
                   "usr/lib/modules", "usr/lib/x86_64-linux-gnu", "usr/lib64")
    entries = [entry(n, stat.S_IFDIR | (0o700 if n == "mnt/brd" else 0o555)) for n in directories]
    entries += [entry("bin/busybox", stat.S_IFREG | 0o555, busybox),
                entry("bin/sh", stat.S_IFLNK | 0o777, b"busybox"),
                entry("bin/brd-f2", stat.S_IFREG | 0o555, helper),
                entry("init", stat.S_IFREG | 0o555, INIT),
                entry("dev/console", stat.S_IFCHR | 0o600, major=5, minor=1),
                entry("dev/null", stat.S_IFCHR | 0o666, major=1, minor=3),
                entry("etc/mke2fs-f2.conf", stat.S_IFREG | 0o444, config),
                entry("usr/lib/modules/brd.ko", stat.S_IFREG | 0o444, brd),
                entry("run/run-id", stat.S_IFREG | 0o444, (run_id + "\n").encode()),
                entry("run/fs-uuid", stat.S_IFREG | 0o444, (p["filesystem_uuid"] + "\n").encode()),
                entry("run/hash-seed", stat.S_IFREG | 0o444, (p["hash_seed_uuid"] + "\n").encode()),
                entry("run/notes", stat.S_IFREG | 0o444, notes)]
    entries += [entry(name, stat.S_IFREG | mode, files[name]) for name, (_, _, mode) in PAYLOAD_FILES.items()]
    entries += [entry(name, stat.S_IFLNK | 0o777, target.encode()) for name, target in PAYLOAD_LINKS.items()]
    return entries


def decode_newc(raw):
    if type(raw) is not bytes or len(raw) > LIMITS["expanded_bytes"]:
        raise ValueError("bounded archive required")
    entries = []; offset = 0
    while True:
        if len(entries) > 64 or offset + 110 > len(raw) or raw[offset:offset + 6] != b"070701":
            raise ValueError("invalid newc header or member count")
        try: fields = [int(raw[i:i + 8], 16) for i in range(offset + 6, offset + 110, 8)]
        except ValueError as error: raise ValueError("invalid newc numbers") from error
        ino, mode, uid, gid, nlink, mtime, size, devmaj, devmin, maj, minor, namesize, check = fields
        if (uid, gid, nlink, mtime, devmaj, devmin, check) != (0, 0, 1, 0, 0, 0, 0) or not 1 <= namesize <= 128:
            raise ValueError("noncanonical metadata")
        start = offset + 110; end = start + namesize
        if end > len(raw) or raw[end - 1] != 0 or b"\0" in raw[start:end - 1]:
            raise ValueError("invalid name encoding")
        try: name = raw[start:end - 1].decode("ascii")
        except UnicodeError as error: raise ValueError("invalid name") from error
        padded = (end + 3) & ~3; data_end = padded + size; next_offset = (data_end + 3) & ~3
        if next_offset > len(raw) or any(raw[end:padded]) or any(raw[data_end:next_offset]):
            raise ValueError("truncated or noncanonical member")
        if name == "TRAILER!!!":
            if (ino, mode, size, maj, minor) != (0, 0, 0, 0, 0) or next_offset != len(raw):
                raise ValueError("invalid final trailer")
            return entries
        path = PurePosixPath(name)
        if str(path) != name or path.is_absolute() or any(p in ("", ".", "..") for p in path.parts):
            raise ValueError("archive path escape/noncanonical path")
        if ino != len(entries) + 1 or stat.S_IFMT(mode) not in (stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK, stat.S_IFCHR):
            raise ValueError("unknown member type or sequence; no pre-created block node")
        entries.append(f0b._entry(name, mode, raw[padded:data_end], maj, minor)); offset = next_offset


def payload(run_id, busybox, helper, notes, brd, config, files):
    entries = _entries(run_id, busybox, helper, notes, brd, config, files)
    raw = b"".join(f0b._newc_record(e, i + 1) for i, e in enumerate(entries))
    raw += f0b._newc_record(f0b._entry("TRAILER!!!", 0), 0)
    if len(raw) > LIMITS["expanded_bytes"]: raise ValueError("expanded payload budget exceeded")
    result = gzip.compress(raw, compresslevel=9, mtime=0)
    inspect_payload(result, run_id)
    return result


def inspect_payload(data, run_id):
    if type(data) is not bytes or len(data) > LIMITS["compressed_bytes"]:
        raise ValueError("compressed payload budget exceeded")
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data, LIMITS["expanded_bytes"] + 1)
    except zlib.error as error: raise ValueError("invalid gzip payload") from error
    if len(raw) > LIMITS["expanded_bytes"] or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError("incomplete, trailing or oversized payload")
    entries = decode_newc(raw); by_name = {e["name"]: e for e in entries}
    if len(by_name) != len(entries): raise ValueError("duplicate member")
    try:
        expected = _entries(run_id, by_name["bin/busybox"]["data"], by_name["bin/brd-f2"]["data"],
                            by_name["run/notes"]["data"], by_name["usr/lib/modules/brd.ko"]["data"],
                            by_name["etc/mke2fs-f2.conf"]["data"], {n: by_name[n]["data"] for n in PAYLOAD_FILES})
    except KeyError as error: raise ValueError("missing fixed member") from error
    if entries != expected: raise ValueError("payload differs from exact F2 members/content")
    return {"state": "OFFLINE_F2_PAYLOAD_ONLY", "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED",
            "compressed_bytes": len(data), "expanded_bytes": len(raw), "sha256": hashlib.sha256(data).hexdigest(),
            "members": [{k: v for k, v in e.items() if k != "data"} |
                        {"bytes": len(e["data"]), "sha256": hashlib.sha256(e["data"]).hexdigest()} for e in entries]}


HEALTH = ("errors_count", "first_error_errcode", "last_error_errcode", "first_error_ino", "last_error_ino",
          "first_error_block", "last_error_block", "first_error_line", "last_error_line", "first_error_time",
          "last_error_time", "first_error_func", "last_error_func")
METADATA = (
    ("status_before", "/proc/self/status", 65536), ("self_stat", "/proc/self/stat", 8192),
    ("boot_id", "/proc/sys/kernel/random/boot_id", 4096),
    ("module_notes", "/sys/module/brd/notes/.note.gnu.build-id", 4096),
    ("module_srcversion", "/sys/module/brd/srcversion", 4096),
    ("module_rd_nr", "/sys/module/brd/parameters/rd_nr", 4096),
    ("module_rd_size", "/sys/module/brd/parameters/rd_size", 4096),
    ("module_max_part", "/sys/module/brd/parameters/max_part", 4096),
    ("modules", "/proc/modules", 65536), ("sys_block", "/sys/block", 65536),
    ("device_dev", "/sys/block/ram0/dev", 4096), ("device_size", "/sys/block/ram0/size", 4096),
    ("device_logical", "/sys/block/ram0/queue/logical_block_size", 4096),
    ("device_physical", "/sys/block/ram0/queue/physical_block_size", 4096), ("device_ro", "/sys/block/ram0/ro", 4096),
    ("device_partition", "/sys/block/ram0/partition", 256), ("device_holders", "/sys/block/ram0/holders", 65536),
    ("device_slaves", "/sys/block/ram0/slaves", 65536), ("source_open", "source:/mnt/brd", 4096),
    ("source_stat_before", "source:/mnt/brd", 4096), ("source_statfs", "source:/mnt/brd", 4096),
    ("source_statx_legacy", "syscall:statx-legacy", 256), ("source_statx_unique", "syscall:statx-unique", 256),
    ("source_uuid", "ioctl:GETFSUUID", 17), ("source_fid", "syscall:name_to_handle_at", 144),
    ("source_tune", "ioctl:GET_TUNE", 232), ("source_flags", "ioctl:GETFLAGS", 8),
    ("source_mount", "syscall:statmount", 16384), ("effective_options", "/proc/fs/ext4/ram0/options", 16384),
) + tuple(("health_" + name, "/sys/fs/ext4/ram0/" + name, 4096) for name in HEALTH) + (
    ("mountinfo", "/proc/self/mountinfo", 65536), ("source_stat_after", "source:/mnt/brd", 4096),
    ("source_close", "source:/mnt/brd", 0), ("status_after", "/proc/self/status", 65536), ("end", "collector:end", 0),
)
EVENTS = (
    "p1-start", "p1-exit", "policy-gate", "config-check", "module-load", "brd-family", "device-create", "device-geometry",
    "format-start", "format-stdout", "format-stderr", "format-exit", "prepared-superblock", "prepared-group-descriptor",
    "prepared-journal-inode", "prepared-journal-header", "mount-private", "mount-fresh", "ordinary-root",
    "metadata-start", "metadata-exit", "cleanup-fd", "unmount", "unmounted-superblock", "unmounted-group-descriptor",
    "unmounted-journal-inode", "unmounted-journal-header", "device-remove", "module-unload", "guest-complete", "poweroff-failed",
)


def _require(ok, reason):
    if not ok: raise ValueError(reason)


def _raw(frame, limit):
    _require(type(frame["bytes"]) is int and 0 <= frame["bytes"] <= limit, "raw byte bound")
    _require(type(frame["data_hex"]) is str and re.fullmatch("[0-9a-f]*", frame["data_hex"]) is not None
             and len(frame["data_hex"]) == 2 * frame["bytes"], "raw hex encoding")
    return bytes.fromhex(frame["data_hex"])


def _module(name):
    # Existing pure consumers only. These files are separately bound in SOURCE.
    path = Path(__file__).resolve().parent.parent / "fs-source-preservation" / (name + ".py")
    spec = importlib.util.spec_from_file_location("whole_brd_f2_" + name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def _wait(frame, *, format_child=False):
    value = f0b._json(frame["raw"])
    keys = ("pid", "exit", "signal", "timeout", "reaped", "pidfd_before_ack")
    if format_child: keys += ("stdout_eof", "stderr_eof")
    f0._fields(value, keys)
    _require(type(value["pid"]) is int and value["pid"] > 1 and type(value["exit"]) is int and value["exit"] == 0
             and type(value["signal"]) is int and value["signal"] == 0 and value["timeout"] is False
             and value["reaped"] is True and value["pidfd_before_ack"] is True, "owned child normal completion")
    if format_child: _require(value["stdout_eof"] is value["stderr_eof"] is True, "format output EOF")
    return value


def _metadata(rows, p1, run_id):
    _require(len(rows) == len(METADATA), "complete one-pass ordinary metadata required")
    observations = {}
    for seq, (frame, (item, path, limit)) in enumerate(zip(rows, METADATA), 1):
        f0._fields(frame, ("run_id", "origin", "phase", "seq", "item", "path", "status", "errno", "close_errno", "eof", "bytes", "data_hex"))
        _require(frame["run_id"] == run_id and frame["origin"] == "ordinary" and frame["phase"] == "metadata"
                 and type(frame["seq"]) is int and frame["seq"] == seq and frame["item"] == item and frame["path"] == path,
                 "ordinary metadata origin/source/order")
        absent = item == "device_partition"
        _require(frame["status"] == ("ABSENT" if absent else "OK") and type(frame["errno"]) is int
                 and frame["errno"] == (2 if absent else 0) and type(frame["close_errno"]) is int
                 and frame["close_errno"] == 0 and frame["eof"] is True, "ordinary read/close failed: " + item)
        raw = _raw(frame, limit); observations[item] = {"raw": raw, "frame": frame, "sha256": hashlib.sha256(raw).hexdigest()}
    data = {name: value["raw"] for name, value in observations.items()}
    before = f0b._ordinary_status(data["status_before"]); after = f0b._ordinary_status(data["status_after"])
    _require(before == after and data["boot_id"] == p1["observations"]["boot_id"]["raw"], "current ordinary identity/boot changed")
    for name, expected in (("module_rd_nr", b"1\n"), ("module_rd_size", b"65536\n"), ("module_max_part", b"1\n"),
                           ("module_srcversion", BRD_SRCVERSION), ("device_dev", b"1:0\n"), ("device_size", b"131072\n"),
                           ("device_ro", b"0\n"), ("device_partition", b"absent\n"), ("device_holders", b""), ("device_slaves", b"")):
        _require(data[name] == expected, "actual module/whole device mismatch: " + name)
    _require(data["module_notes"] == struct.pack("<III", 4, 20, 3) + b"GNU\0" + bytes.fromhex(BRD_BUILD_ID), "loaded module build-id mismatch")
    module_lines = data["modules"].splitlines()
    _require(len(module_lines) == 1 and module_lines[0].split()[:1] == [b"brd"], "unexpected loaded module family")
    def names(raw):
        parts = raw.split(b"\0")
        _require(parts[-1] == b"" and len(parts) <= 257 and len(set(parts)) == len(parts)
                 and all(re.fullmatch(rb"[A-Za-z0-9_.-]+", n) for n in parts[:-1]), "block inventory format")
        return set(parts[:-1])
    _require(names(data["sys_block"]) == names(p1["observations"]["sys_block"]["raw"]) | {b"ram0"}, "actual extra/missing block object")
    _require(re.fullmatch(rb"[1-9][0-9]*\n", data["device_logical"]) is not None, "logical block format")
    logical = int(data["device_logical"])
    _require(0 < logical <= 1024 and logical & (logical - 1) == 0, "actual logical block limit")
    opened = f0b._json(data["source_open"]); f0._fields(opened, ("fd",))
    _require(type(opened["fd"]) is int and opened["fd"] >= 3, "source FD acquisition")
    st = f0b._json(data["source_stat_before"]); end = f0b._json(data["source_stat_after"])
    f0._fields(st, ("fd", "dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtime", "ctime"))
    _require(st == end and st["fd"] == opened["fd"] and st["dev"] == 256 and st["ino"] == 2
             and st["mode"] == stat.S_IFDIR | 0o700 and st["uid"] == st["gid"] == 1000, "same source root metadata/owner changed")
    fs = f0b._json(data["source_statfs"])
    _require(fs == {"magic": 0xef53, "block_size": 4096}, "actual native 4KiB filesystem")
    native = _module("native")
    sx = native.decode_statx(data["source_statx_unique"]); legacy = native.decode_statx(data["source_statx_legacy"])
    mount = native.decode_statmount(data["source_mount"]); tune = native.decode_tune(data["source_tune"])
    for value, mask in ((sx, 0x4fff), (legacy, 0x17ff)):
        _require(value["mask"] & mask == mask and all(value[k] == st[k] for k in ("ino", "mode", "uid", "gid", "size"))
                 and (value["dev_major"], value["dev_minor"]) == (1, 0), "statx same-FD identity/mask mismatch")
    _require(len(data["source_flags"]) == 8 and native.inode_guard(struct.unpack("<Q", data["source_flags"])[0],
             sx["attributes"], sx["attributes_mask"], directory=True), "source inode flags/DAX")
    proposal = plan(json.dumps({"run_id": run_id}).encode())
    _require(data["source_uuid"] == b"\x10" + uuid.UUID(proposal["filesystem_uuid"]).bytes, "actual source UUID mismatch")
    _require(len(data["source_fid"]) == 144, "FID frame size")
    mount_id, handle_bytes, handle_type = struct.unpack_from("<QIi", data["source_fid"])
    _require(handle_bytes == 8 and handle_type == 1 and mount_id == sx["unique_id"] == mount["unique_id"], "opaque FID/current mount mismatch")
    _require(mount["legacy_id"] == legacy["unique_id"] and (mount["dev_major"], mount["dev_minor"]) == (1, 0)
             and mount["root"] == "/" and mount["point"] == "/mnt/brd" and mount["type"] == "ext4" and mount["magic"] == 0xef53,
             "actual whole-root mount identity")
    # MOUNT_ATTR_NOSUID/NODEV/NOEXEC are the accepted private fixture flags;
    # absence of IDMAP/RDONLY/unknown flags is checked explicitly.
    _require(mount["attr"] == 0x0e and mount["propagation"] == 1 << 18 and not mount["sb_flags"] & 1, "mount attributes/private/rw mismatch")
    _require(tune["feature_masks"] == [60, 710, 1131], "actual mounted feature vector")
    opts = native.options(data["effective_options"])
    _require(opts.get("rw") is True and opts.get("data") == "ordered" and opts.get("dax") == "never"
             and opts.get("errors") == "remount-ro" and opts.get("acl") is True and opts.get("user_xattr") is True,
             "effective source options mismatch")
    for name in HEALTH:
        value = data["health_" + name]
        _require(value in (b"", b"\n") if name.endswith("_func") else re.fullmatch(rb"0\n?", value) is not None,
                 "visible error snapshot is nonzero/unknown: " + name)
    mounts = native.mountinfo(data["mountinfo"])
    matching = [m for m in mounts if m["id"] == mount["legacy_id"]]
    _require(len(matching) == 1 and matching[0]["device"] == "1:0" and matching[0]["root"] == "/"
             and matching[0]["point"] == "/mnt/brd" and matching[0]["type"] == "ext4", "mountinfo/current source mismatch")
    return {"observations": observations, "identity": before, "logical_block_size": logical, "source_fd": st["fd"],
            "uuid": proposal["filesystem_uuid"], "fid_hex": data["source_fid"][16:24].hex(), "mount": mount,
            "features": tune["feature_masks"], "effective_options": opts, "healthy_visible_snapshot": True,
            "commit_barrier": False, "production_bound": False}


def _raw_filesystem(events, run_id):
    d = _module("diagnostics"); outputs = {}
    expected_uuid = uuid.UUID(plan(json.dumps({"run_id": run_id}).encode())["filesystem_uuid"]).bytes
    for phase in ("prepared", "unmounted"):
        sb = events[phase + "-superblock"]["raw"]
        d.ext4_superblock(sb, unmounted=True)
        _require(sb[104:120] == expected_uuid and struct.unpack_from("<I", sb, 4)[0] == 16384, "actual filesystem UUID/size")
        gd = events[phase + "-group-descriptor"]["raw"]; inode = events[phase + "-journal-inode"]["raw"]
        header = events[phase + "-journal-header"]["raw"]
        _require(len(gd) == 64 and len(inode) == 256 and len(header) == 4096, "bounded actual journal metadata")
        _require(struct.unpack_from("<I", inode, 4)[0] == 4 * MIB and struct.unpack_from("<I", inode, 108)[0] == 0
                 and stat.S_IFMT(struct.unpack_from("<H", inode)[0]) == stat.S_IFREG, "actual internal journal size/type")
        _require(struct.unpack_from(">III", header, 12) == (4096, 1024, 1) and header[48:64] == expected_uuid
                 and struct.unpack_from(">II", header) == (0xc03b3998, 4), "actual JBD2 header geometry/UUID")
        features = struct.unpack_from(">III", header, 36)
        _require(features == ((0, 0, 0) if phase == "prepared" else (0, 0x12, 0)), "unexpected journal features")
        if phase == "unmounted": d._checksum(header[:1024], 0xfc, 0xffffffff)
        outputs[phase] = {"journal_bytes": 4 * MIB, "journal_features": list(features), "superblock_sha256": hashlib.sha256(sb).hexdigest()}
    return outputs


def decode_serial(raw, run_id, expected_notes):
    plan(json.dumps({"run_id": run_id}).encode())
    _require(type(raw) is bytes and len(raw) <= LIMITS["serial_bytes"], "serial byte bound")
    frames = []; p1_positions = []
    for line_number, line in enumerate(raw.splitlines(keepends=True)):
        if line.startswith(b"BRDF1 "): p1_positions.append(line_number)
        if b"BRDF2 " not in line: continue
        _require(line.startswith(b"BRDF2 ") and line.endswith(b"\n"), "interleaved/incomplete F2 frame")
        frame = f0b._json(line[6:].rstrip(b"\r\n"))
        _require(type(frame) is dict and frame.get("run_id") == run_id, "F2 frame identity")
        frames.append((line_number, frame))
    _require(0 < len(frames) <= 256, "bounded F2 frame count")
    management = {}; rows = []; positions = {}; last_event = -1; in_metadata = False
    for pos, frame in frames:
        if frame.get("origin") == "ordinary":
            _require(in_metadata, "ordinary metadata outside owned phase")
            rows.append(frame); continue
        f0._fields(frame, ("run_id", "origin", "seq", "event", "rc", "errno", "close_errno", "bytes", "data_hex"))
        event = frame["event"]
        _require(frame["origin"] == "management" and event in EVENTS and type(frame["seq"]) is int
                 and frame["seq"] == len(management) + 1 and EVENTS.index(event) > last_event, "management sequence/replay")
        for key in ("errno", "close_errno"):
            _require(type(frame[key]) is int and 0 <= frame[key] <= 4095, "original management errno")
        _require(type(frame["rc"]) is int and frame["rc"] in (-1, 0), "management result")
        last_event = EVENTS.index(event); positions[event] = pos
        management[event] = frame | {"raw": _raw(frame, 65536)}
        if event == "metadata-start": in_metadata = True
        elif event == "metadata-exit": in_metadata = False
    errors = []
    for name, frame in management.items():
        if frame["rc"] or frame["errno"] or frame["close_errno"]:
            errors.append({"phase": name, "rc": frame["rc"], "errno": frame["errno"], "close_errno": frame["close_errno"]})
    result = {"state": "F2_FAILED", "qualification": "UNSUPPORTED", "content_probes": 0,
              "management": management, "errors": errors, "unresolved": ["production_source_db_plan_binding", "complete_M04_writer_special_path_coverage",
              "source_preservation_content_and_diagnostic_closure", "R05_and_durable_restore"], "policy": "UNKNOWN"}
    try:
        p1 = f0b.decode_serial(raw, run_id, expected_notes); result["p1"] = p1
        result["policy"] = policy(p1)
        _require(tuple(management) == EVENTS[:-1], "incomplete F2 lifecycle")
        _require(p1_positions[0] < positions["p1-start"] < p1_positions[1]
                 and p1_positions[-1] < positions["p1-exit"], "ordinary P1 must precede target preparation in this stream")
        _require(not errors, "management stage failed")
        _require(management["policy-gate"]["raw"] == result["policy"].encode(), "policy gate interpretation mismatch")
        config_bytes(management["config-check"]["raw"])
        p1_wait = _wait(management["p1-exit"]); format_wait = _wait(management["format-exit"], format_child=True)
        meta_wait = _wait(management["metadata-exit"])
        _require(p1_wait["pid"] == p1["ordinary_identity"]["pid"], "P1 child origin/wait mismatch")
        metadata = _metadata(rows, p1, run_id); result["metadata"] = metadata
        _require(management["module-load"]["raw"] == b"rd_nr=1 rd_size=65536 max_part=1"
                 and management["device-create"]["raw"] == b"1:0", "target preparation arguments changed")
        _require(set(management["brd-family"]["raw"].split(b"\0")) == set(metadata["observations"]["sys_block"]["raw"].split(b"\0")),
                 "management and ordinary target inventory differ")
        _require(meta_wait["pid"] == metadata["identity"]["pid"] and len({p1_wait["pid"], format_wait["pid"], meta_wait["pid"]}) == 3,
                 "distinct owned child phases")
        geometry = f0b._json(management["device-geometry"]["raw"])
        _require(geometry == {"bytes": 64 * MIB, "logical_block_size": metadata["logical_block_size"]}, "management/ordinary geometry mismatch")
        result["filesystem"] = _raw_filesystem(management, run_id)
        final = f0b._json(management["guest-complete"]["raw"])
        closes = final.pop("parent_closes", None)
        _require(type(closes) is list and 1 <= len(closes) <= 128, "parent close receipts missing")
        for close in closes:
            f0._fields(close, ("fd", "errno"))
            _require(type(close["fd"]) is int and close["fd"] >= 3 and type(close["errno"]) is int and close["errno"] == 0,
                     "parent owned FD close failed")
        _require(final == {"original_errno": 0, "cleanup_errno": 0, "metadata_complete": True,
                 "module_loaded": False, "mounted": False, "node_exists": False, "children_reaped": True}, "incomplete guest cleanup")
        result["state"] = "F2_METADATA_CAPTURED"; result["guest_cleanup"] = final | {"parent_closes": closes}
    except (ValueError, KeyError, TypeError, struct.error) as error:
        errors.append({"phase": "evidence-interpretation", "type": type(error).__name__, "message": str(error)})
    return result

#!/usr/bin/env python3
"""whole-brd F0: untrusted preparation only; no guest execution entry point."""
from __future__ import annotations

import json
import argparse
import errno
import hashlib
import os
import posixpath
import re
import shutil
import stat
import sys
import uuid


MIB = 1024 * 1024
SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6889709365"


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("non-JSON number: " + value)


def _fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise ValueError("missing or unexpected fields")


def _uuid(value):
    if type(value) is not str:
        raise ValueError("UUID required")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise ValueError("invalid UUID") from error
    if str(parsed) != value or parsed.version != 4:
        raise ValueError("canonical UUIDv4 required")
    return parsed


def prepare(raw: bytes) -> dict:
    """Strictly form an untrusted proposal; never assert an instance exists."""
    if type(raw) is not bytes or len(raw) > 16 * 1024:
        raise ValueError("request must be bounded UTF-8 JSON bytes")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                           parse_constant=_invalid_constant)
    except (UnicodeError, RecursionError) as error:
        raise ValueError("invalid bounded UTF-8 JSON") from error
    _fields(value, ("run_id", "target_count"))
    run_id = _uuid(value["run_id"])
    count = value["target_count"]
    if type(count) is not int or count not in (1, 2):
        raise ValueError("target_count must be 1 or 2")
    return {
        "kind": "whole-brd-f0-proposal",
        "scope": SCOPE,
        "run_id": str(run_id),
        "state": "PREPARED_UNTRUSTED",
        "launch": "REQUIRES_SEPARATE_F0B_F1_ACCEPTANCE",
        "actual_instance": None,
        "qualification": "UNSUPPORTED",
        "ordinary": {"status": "NOT_RUN", "facts": None},
        "target": {
            "count": count, "bytes_each": 64 * MIB,
            "total_bytes": count * 64 * MIB,
            "created": False, "rd_nr_is_global_limit": False,
        },
        "provider": {
            "name": "qemu-tcg-linux-amd64",
            "expected_qemu_version": "10.0.13",
            "expected_machine": "pc-q35-10.0",
            "accelerator": "tcg",
            "host_runtime_binding": "NOT_OBSERVED",
            "guest_kernel_binding": "NOT_OBSERVED",
        },
        "bootstrap": {
            "guest_memory_bytes": 512 * MIB, "vcpus": 1,
            "host_address_space_bytes": 2 * 1024 * MIB,
            "boot_disk_bytes": 0,
            "initramfs_compressed_max_bytes": 16 * MIB,
            "initramfs_expanded_max_bytes": 32 * MIB,
            "host_block_attachments": [], "network": "none",
            "host_filesystem_shares": [], "autoload_modules": [],
            "boot_seconds": 60, "ordinary_probe_seconds": 3,
            "fixture_seconds": 300, "job_seconds": 600,
            "serial_max_bytes": 8 * MIB, "evidence_max_bytes": 64 * MIB,
        },
        "ownership": {
            "boundary": "dedicated-whole-guest",
            "status": "PROPOSED_NOT_ACQUIRED",
            "parent_owned_child_handle": None,
            "exclusive_directory": "/tmp/boardroom-brd-" + run_id.hex,
            "scope_of_module_cleanup": "whole-owned-guest-only",
        },
        "required_before_boot": [
            "accepted concrete F0B/F1 input and cleanup scope",
            "fixed runtime/library/firmware/kernel/initramfs bytes",
            "exclusive directory and parent-owned child supervision",
            "bounded initramfs with no brd module or autoload action",
        ],
        "required_after_boot": [
            "ordinary actual kernel/notes/policy provenance",
            "ordinary identity and permission report independent of bootstrap",
        ],
    }


def _asset_path(value):
    if type(value) is not str or len(value) > 4096:
        raise ValueError("bounded absolute asset path required")
    # POSIX normpath preserves exactly two leading slashes; those are not a
    # canonical single root and must not bypass the protected-prefix checks.
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("exactly one leading slash is required")
    if not re.fullmatch(r"/[A-Za-z0-9_.+/-]+", value):
        raise ValueError("ambiguous asset path")
    if posixpath.normpath(value) != value or any(p in (".", "..") for p in value.split("/")):
        raise ValueError("noncanonical asset path")
    if any(value == p or value.startswith(p + "/") for p in ("/dev", "/proc", "/sys")):
        raise ValueError("kernel/device path is not a preparation asset")
    return value


def command_preview(raw: bytes, assets: dict) -> dict:
    """Render a fixed argv, not a launch API or proof that the inputs exist."""
    proposal = prepare(raw)
    _fields(assets, ("qemu", "kernel", "initramfs", "bios", "qemu_data"))
    paths = {key: _asset_path(value) for key, value in assets.items()}
    socket = proposal["ownership"]["exclusive_directory"] + "/qmp.sock"
    return {
        "status": "PREVIEW_NOT_EXECUTED",
        "asset_bytes_verified": False,
        "guest_policy_effective": "NOT_OBSERVED",
        "runtime_environment": "requires separately fixed library/module manifest",
        "argv": [
            paths["qemu"], "-no-user-config", "-nodefaults",
            "-machine", "pc-q35-10.0,mem-merge=off,dump-guest-core=off",
            "-accel", "tcg,thread=single", "-cpu", "max", "-smp", "1", "-m", "512M",
            "-display", "none", "-monitor", "none", "-serial", "stdio", "-nic", "none",
            "-qmp", "unix:" + socket + ",server=on,wait=off", "-no-reboot",
            "-L", paths["qemu_data"], "-bios", paths["bios"],
            "-kernel", paths["kernel"], "-initrd", paths["initramfs"],
            "-append", "console=ttyS0,115200n8 rdinit=/init loglevel=4 panic=0 "
                       "bdev_allow_write_mounted=0",
        ],
    }


def _child_binding(value, run_id):
    _fields(value, ("run_id", "boot_id", "parent_pid", "pid", "start_ticks", "uid",
                    "executable_sha256"))
    if str(_uuid(value["run_id"])) != run_id:
        raise ValueError("wrong proposed instance")
    _uuid(value["boot_id"])
    for key in ("parent_pid", "pid", "start_ticks", "uid"):
        if type(value[key]) is not int or not 0 < value[key] < 2 ** 63:
            raise ValueError("invalid process binding")
    if value["parent_pid"] == value["pid"]:
        raise ValueError("child cannot be its parent")
    if type(value["executable_sha256"]) is not str or not re.fullmatch(
            r"[0-9a-f]{64}", value["executable_sha256"]):
        raise ValueError("exact executable digest required")


def cleanup_contract(raw: bytes, expected: dict, observed: dict) -> dict:
    """Check receipt consistency only. JSON cannot reconstruct ownership/pidfd."""
    proposal = prepare(raw)
    for value in (expected, observed):
        _child_binding(value, proposal["run_id"])
    if expected != observed:
        raise ValueError("child identity changed; no cleanup proposal")
    return {
        "status": "BINDING_CONSISTENT_NOT_AUTHORIZATION",
        "required_handle": "retained-parent-child-pidfd",
        "signal_numeric_pid": False,
        "waitpid_required": True,
        "preserve_original_failure": True,
        "executed": False,
        "steps": [
            {"action": "request-owned-qmp-quit", "max_seconds": 2},
            {"action": "wait-owned-child", "max_seconds": 5},
            {"action": "if-live-parent-handle-signal-TERM-and-wait", "max_seconds": 2},
            {"action": "if-live-parent-handle-signal-KILL-and-reap", "max_seconds": 5},
        ],
        "result_requires": [
            "original parent retained the actual child handle/pidfd",
            "actual wait status, EOF and owned resources accounted separately",
            "failure/timeout remains failure even if the guest was reclaimed",
        ],
    }


def _regular_bytes(path, limit):
    """Pin an offline regular object before opening it for byte reads (Linux)."""
    if not hasattr(os, "O_PATH"):
        raise OSError(errno.ENOTSUP, "Linux O_PATH is required for this preparation")
    path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        initial = os.fstat(path_fd)
        if not stat.S_ISREG(initial.st_mode) or initial.st_size > limit:
            raise ValueError("not a bounded regular preparation input")
        # This descriptor belongs exclusively to this call. Reopen its pinned
        # regular object, not a second resolution of the caller's pathname.
        fd = os.open("/proc/self/fd/" + str(path_fd), os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if (before.st_dev, before.st_ino) != (initial.st_dev, initial.st_ino):
                raise ValueError("offline input identity changed")
            chunks = []; size = 0
            while True:
                chunk = os.read(fd, min(MIB, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk); size += len(chunk)
                if size > limit:
                    raise ValueError("offline input exceeds budget")
            after = os.fstat(fd)
            fields = lambda value: (value.st_dev, value.st_ino, value.st_size,
                                    value.st_mtime_ns, value.st_ctime_ns)
            if fields(initial) != fields(before) or fields(before) != fields(after) or size != after.st_size:
                raise ValueError("offline input changed during read")
            return b"".join(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(path_fd)


def bind_inputs(specs: dict) -> dict:
    """Observe provided offline bytes. Expected hashes are not approval tokens."""
    limits = {"qemu": 64 * MIB, "kernel": 32 * MIB, "bios": MIB,
              "busybox": 4 * MIB, "initramfs": 16 * MIB}
    if type(specs) is not dict or not specs or not set(specs) <= set(limits):
        raise ValueError("only named offline inputs are supported")
    # Validate the whole input before any read, avoiding partial action on an
    # ambiguous request. This API does not fill guest or ordinary observations.
    for name, spec in specs.items():
        _fields(spec, ("path", "sha256", "max_bytes"))
        _asset_path(spec["path"])
        if type(spec["max_bytes"]) is not int or not 0 < spec["max_bytes"] <= limits[name]:
            raise ValueError("invalid input budget")
        if type(spec["sha256"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", spec["sha256"]):
            raise ValueError("exact input digest required")
    results = {}
    for name, spec in specs.items():
        try:
            data = _regular_bytes(spec["path"], spec["max_bytes"])
            actual = hashlib.sha256(data).hexdigest()
            results[name] = {"status": "MATCHED_OFFLINE_BYTES" if actual == spec["sha256"] else "REJECTED",
                             "bytes": len(data), "sha256": actual}
        except (OSError, ValueError) as error:
            number = error.errno if isinstance(error, OSError) else None
            results[name] = {"status": "MISSING" if number == errno.ENOENT else "REJECTED",
                             "errno": number, "reason": str(error)}
    return {"status": "OFFLINE_BINDING_ONLY", "inputs": results,
            "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED"}


def inspect_host() -> dict:
    """Read fixed host metadata; do not execute a VM or infer guest capability."""
    files = {}
    for path, limit in (("/etc/os-release", 16 * 1024), ("/proc/self/status", 64 * 1024),
                        ("/proc/self/limits", 64 * 1024)):
        try:
            with open(path, "rb") as source:
                raw = source.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("host metadata budget exceeded")
            if path.endswith("/status"):
                raw = b"\n".join(line for line in raw.splitlines() if line.startswith(
                    (b"Uid:", b"Gid:", b"Groups:", b"Cap", b"NoNewPrivs:", b"Seccomp:")))
            files[path] = {"status": "OBSERVED", "raw": raw.decode("utf-8", "strict")}
        except (OSError, ValueError) as error:
            files[path] = {"status": "UNAVAILABLE", "errno": getattr(error, "errno", None),
                           "reason": str(error)}
    return {"status": "HOST_METADATA_ONLY", "uname": list(os.uname()),
            "uid": os.getuid(), "gid": os.getgid(), "files": files,
            "qemu_in_path": shutil.which("qemu-system-x86_64"),
            "path_lookup_is_not_runtime_binding": True,
            "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED"}


def _json_file(path):
    return json.loads(_regular_bytes(_asset_path(path), 16 * 1024).decode("utf-8"),
                      object_pairs_hook=_object, parse_constant=_invalid_constant)


def main(argv=None):
    parser = argparse.ArgumentParser(description="M04 F0 preparation only; no launch/run subcommand")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan"); plan.add_argument("--request", required=True)
    preview = sub.add_parser("preview"); preview.add_argument("--request", required=True)
    preview.add_argument("--assets", required=True)
    binding = sub.add_parser("bind-inputs"); binding.add_argument("--manifest", required=True)
    sub.add_parser("inspect-host")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect-host":
            result = inspect_host()
        elif args.command == "bind-inputs":
            result = bind_inputs(_json_file(args.manifest))
        else:
            raw = _regular_bytes(_asset_path(args.request), 16 * 1024)
            result = prepare(raw) if args.command == "plan" else command_preview(raw, _json_file(args.assets))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
        if args.command == "bind-inputs" and any(
                value["status"] != "MATCHED_OFFLINE_BYTES" for value in result["inputs"].values()):
            return 2
        return 0
    except (OSError, ValueError, RecursionError) as error:
        print(json.dumps({"status": "REJECTED", "reason": str(error),
                          "errno": getattr(error, "errno", None)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

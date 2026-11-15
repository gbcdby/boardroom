#!/usr/bin/env python3
"""Build one fixed offline F2 bundle; never executes the generated payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import build
import f0
import f0b
import f2

HERE = Path(__file__).resolve().parent
SOURCE_NAMES = ("f0.py", "f0b.py", "build.py", "guest.c", "host-gate.c", "supervise.py", "transport.py", "inputs.json",
                "f2.py", "f2-build.py", "f2-run.py", "f2-guest.c", "mke2fs-f2.conf",
                "../fs-source-preservation/uapi.h", "../fs-source-preservation/native.py", "../fs-source-preservation/diagnostics.py")


def source_bindings():
    return {name: build.file_binding((HERE / name).resolve(), f2.MIB)[0] for name in SOURCE_NAMES}


def fixed_header(notes, config):
    if hashlib.sha256(notes).hexdigest() != f2.NOTES_SHA: raise ValueError("exact notes required")
    f2.config_bytes(config)
    return ("#define F2_FIXED_INPUTS 1\n" + "\n".join(
        "static const unsigned char " + name + "[] = {" + ",".join(str(x) for x in raw) + "};"
        for name, raw in (("F2_EXPECTED_NOTES", notes), ("F2_EXPECTED_CONFIG", config))) + "\n").encode()


def verify_base(path, digest):
    binding, raw = build.file_binding(path, f2.MIB, digest); base = f0b._json(raw)
    if base.get("state") != "FIXED_OFFLINE_BUNDLE_NOT_BOOTED": raise ValueError("fixed F0B base bundle required")
    if base["proposal"] != f0b.plan(json.dumps({"run_id": base["request"]["run_id"]}).encode()):
        raise ValueError("base proposal changed")
    catalog = json.loads((HERE / "inputs.json").read_text())["selectedOfflineFiles"]
    for key, original in (("qemu", "qemu-system-x86_64"), ("kernel", "vmlinuz-7.0.0-1017-azure"),
                          ("bios", "bios-256k.bin"), ("busybox", "busybox")):
        if base["inputs"][key]["sha256"] != catalog[original]["sha256"]: raise ValueError("base provider input changed")
    if base["inputs"]["notes"]["sha256"] != f2.NOTES_SHA: raise ValueError("base notes changed")
    return binding, base


def prepare(request, output):
    f0._fields(request, ("run_id", "base_bundle", "base_bundle_sha256", "brd", "payload_root"))
    proposal = f2.plan(json.dumps({"run_id": request["run_id"]}).encode())
    if not isinstance(request["base_bundle_sha256"], str) or len(request["base_bundle_sha256"]) != 64:
        raise ValueError("exact base digest required")
    for name in ("base_bundle", "brd", "payload_root"): f0._asset_path(request[name])
    out = Path(f0._asset_path(str(Path(output).absolute())))
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    record = {"kind": "fixed-whole-brd-f2-bundle", "state": "BUILDING_OFFLINE", "qualification": "UNSUPPORTED",
              "guest_execution": "NOT_RUN", "request": request, "proposal": proposal, "source": source_bindings(),
              "inputs": {}, "e2fs": {}, "commands": []}
    started = time.monotonic(); original_error = None
    try:
        record["base_bundle"], base = verify_base(request["base_bundle"], request["base_bundle_sha256"])
        data = {}
        for name in ("qemu", "kernel", "bios", "busybox", "notes", "gate"):
            old = base["inputs"][name]
            record["inputs"][name], data[name] = build.file_binding(old["path"], 64 * f2.MIB, old["sha256"])
        build.static_elf(data["gate"])
        record["inputs"]["brd"], data["brd"] = build.file_binding(request["brd"], f2.MIB, f2.BRD_SHA)
        record["inputs"]["config"], data["config"] = build.file_binding(HERE / "mke2fs-f2.conf", 65536, f2.CONFIG_SHA)
        payload_root = Path(request["payload_root"])
        files = {}
        for name, (size, digest, _) in f2.PAYLOAD_FILES.items():
            record["e2fs"][name], files[name] = build.file_binding(payload_root / name, 4 * f2.MIB, digest)
            if len(files[name]) != size: raise ValueError("ELF size changed")
        for name, target in f2.PAYLOAD_LINKS.items():
            if not (payload_root / name).is_symlink() or os.readlink(payload_root / name) != target:
                raise ValueError("fixed ELF alias changed: " + name)
        record["libraries"] = base["libraries"]
        record["qemu_data"] = base["qemu_data"]
        record["runtime_environment"] = base["runtime_environment"]
        root = Path(record["inputs"]["qemu"]["path"]).parent.parent
        expected = {"PATH": "/usr/bin:/bin", "LANG": "C", "LD_LIBRARY_PATH": str(root / "lib/x86_64-linux-gnu"),
                    "QEMU_MODULE_DIR": str(root / "lib/x86_64-linux-gnu/qemu")}
        if record["runtime_environment"] != expected: raise ValueError("fixed QEMU environment changed")
        compiler = str(Path("/usr/bin/cc").resolve(strict=True))
        record["compiler"], _ = build.file_binding(compiler, 16 * f2.MIB)
        header = out / "fixed-inputs.h"; header.write_bytes(fixed_header(data["notes"], data["config"]))
        argv = [compiler, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-static", "-fno-ident", "-Wl,--build-id=sha1",
                "-include", str(header), "-o", str(out / "brd-f2"), str(HERE / "f2-guest.c")]
        begin = time.monotonic()
        compiled = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=10,
                                  env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        record["commands"].append({"argv": argv, "exit": compiled.returncode, "stdout": compiled.stdout.decode(errors="replace"),
                                   "stderr": compiled.stderr.decode(errors="replace"), "elapsed_seconds": time.monotonic() - begin})
        if compiled.returncode: raise ValueError("fixed F2 helper compilation failed")
        record["inputs"]["helper"], data["helper"] = build.file_binding(out / "brd-f2", 4 * f2.MIB)
        record["inputs"]["helper"]["elf"] = build.static_elf(data["helper"])
        archive = f2.payload(request["run_id"], data["busybox"], data["helper"], data["notes"], data["brd"], data["config"], files)
        (out / "initramfs.cpio.gz").write_bytes(archive)
        record["inputs"]["initramfs"], _ = build.file_binding(out / "initramfs.cpio.gz", 16 * f2.MIB)
        record["archive"] = f2.inspect_payload(archive, request["run_id"])
        record["mkfs_argv"] = f2.mkfs_argv(request["run_id"]); record["mkfs_environment"] = dict(f2.MKFS_ENV)
        if source_bindings() != record["source"]: raise ValueError("source changed during offline build")
        if time.monotonic() - started > 60: raise TimeoutError("offline preparation stage deadline")
        record["state"] = "FIXED_F2_BUNDLE_NOT_BOOTED"
    except BaseException as error:
        original_error = error
        record["state"] = "OFFLINE_BUILD_FAILED"
        record["original_error"] = {"type": type(error).__name__, "message": str(error), "errno": getattr(error, "errno", None)}
        raise
    finally:
        record["elapsed_seconds"] = time.monotonic() - started
        try: (out / "BUNDLE.json").write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
        except BaseException as error:
            if original_error is None: raise
            original_error.bundle_record_error = {"type": type(error).__name__, "errno": getattr(error, "errno", None), "message": str(error)}
            original_error.add_note("BUNDLE record also failed: " + str(error))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True); parser.add_argument("--output", required=True)
    args = parser.parse_args()
    _, raw = build.file_binding(args.request, 16384)
    result = prepare(f0b._json(raw), args.output)
    print(json.dumps({"state": result["state"], "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED"}))

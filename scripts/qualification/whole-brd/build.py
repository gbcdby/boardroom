#!/usr/bin/env python3
"""Offline static build and fixed newc/gzip payload; never launches a guest."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import time

import f0
import f0b

HERE = Path(__file__).resolve().parent
LIBRARY_MANIFEST_SHA = "8f2e02b5eb1d86b38e8f4ef9b570d605feae486551b7eb9e6ec0a005764ba69f"
NOTES_SHA = "d0dbc2744ebce79f09543c87f4659b3ca605c626d4295531212207a5ad5f5960"


def static_elf(data):
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        raise ValueError("ELF64 little-endian input required")
    kind, machine = struct.unpack_from("<HH", data, 16)
    offset = struct.unpack_from("<Q", data, 32)[0]
    stride, count = struct.unpack_from("<HH", data, 54)
    if kind != 2 or machine != 62 or stride != 56 or not 1 <= count <= 32 or offset + stride * count > len(data):
        raise ValueError("fixed x86_64 executable headers required")
    types = [struct.unpack_from("<I", data, offset + i * stride)[0] for i in range(count)]
    if 2 in types or 3 in types:
        raise ValueError("dynamic/interpreter segment is outside static helper scope")
    return {"class": "ELF64", "machine": "x86_64", "type": "EXEC", "interpreter": None, "dynamic_segment": False}


def file_binding(path, limit, expected=None):
    raw = f0._regular_bytes(f0._asset_path(str(path)), limit)
    digest = hashlib.sha256(raw).hexdigest()
    if expected is not None and digest != expected:
        raise ValueError("fixed input digest mismatch: " + str(path))
    return {"path": str(path), "bytes": len(raw), "sha256": digest}, raw


def data_inventory(root):
    root = Path(f0._asset_path(root))
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("QEMU data must be the fixed ordinary directory")
    result = []; total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in sorted(dirs + files):
            path = Path(base) / name; st = path.lstat()
            item = {"name": str(path.relative_to(root)), "mode": stat.S_IFMT(st.st_mode)}
            if stat.S_ISLNK(st.st_mode):
                item["link"] = os.readlink(path)
            elif stat.S_ISREG(st.st_mode):
                # These names came from a bounded walk of the fixed data
                # directory, not from an argv field. Official firmware names
                # such as QEMU,VGA.bin contain commas. Keep F0 argv rejection
                # unchanged and still pin/check the ordinary file before read.
                raw = f0._regular_bytes(str(path), 32 * f0b.MIB)
                item.update({"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}); total += len(raw)
            elif not stat.S_ISDIR(st.st_mode):
                raise ValueError("special object in fixed QEMU data input")
            result.append(item)
            if len(result) > 512 or total > 64 * f0b.MIB:
                raise ValueError("QEMU data inventory exceeds preparation budget")
    return result


def prepare(request, output):
    started = time.monotonic()
    f0._fields(request, ("run_id", "qemu", "kernel", "bios", "busybox", "qemu_data", "library_manifest", "notes"))
    proposal = f0b.plan(json.dumps({"run_id": request["run_id"]}).encode())
    for key, path in request.items():
        if key != "run_id": f0._asset_path(path)
    output = Path(f0._asset_path(str(Path(output).absolute())))
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    records = {"state": "BUILDING_OFFLINE", "guest_execution": "NOT_RUN", "qualification": "UNSUPPORTED",
               "request": request, "commands": [], "inputs": {}, "source": {}, "proposal": proposal}
    try:
        catalog = json.loads((HERE / "inputs.json").read_text())["selectedOfflineFiles"]
        expected = {"qemu": "qemu-system-x86_64", "kernel": "vmlinuz-7.0.0-1017-azure", "bios": "bios-256k.bin", "busybox": "busybox"}
        input_bytes = {}
        for key, catalog_name in expected.items():
            records["inputs"][key], input_bytes[key] = file_binding(request[key], 64 * f0b.MIB, catalog[catalog_name]["sha256"])
        records["inputs"]["notes"], _ = file_binding(request["notes"], f0b.MIB, NOTES_SHA)
        records["library_manifest"], raw = file_binding(request["library_manifest"], 65536, LIBRARY_MANIFEST_SHA)
        libraries = json.loads(raw)
        if libraries["missing"]:
            raise ValueError("fixed library input has missing dependencies")
        # Paths may be package soname links. Bind both the provided link route
        # and its exact ordinary resolved object; no device input is read.
        records["libraries"] = []
        for lib in libraries["libraries"]:
            f0._asset_path(lib["path"])
        for lib in libraries["libraries"]:
            resolved = str(Path(lib["path"]).resolve(strict=True))
            binding, _ = file_binding(resolved, 64 * f0b.MIB, lib["sha256"])
            records["libraries"].append(binding | {"requested_path": lib["path"]})
        records["qemu_data"] = {"path": request["qemu_data"], "entries": data_inventory(request["qemu_data"]),
                                "meaning": "fixed directory/link bytes; not actual runtime use or loaded-module closure"}
        compiler = str(Path("/usr/bin/cc").resolve(strict=True))
        records["compiler"], _ = file_binding(compiler, 16 * f0b.MIB)
        for source, name in (("guest.c", "brd-helper"), ("host-gate.c", "host-gate")):
            source_path = HERE / source
            records["source"][source], _ = file_binding(source_path, f0b.MIB)
            argv = [compiler, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-static", "-fno-ident",
                    "-Wl,--build-id=sha1", "-o", str(output / name), str(source_path)]
            begin = time.monotonic()
            run = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=10,
                                 env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            record = {"argv": argv, "exit": run.returncode, "stdout": run.stdout.decode(errors="replace"),
                      "stderr": run.stderr.decode(errors="replace"), "elapsed_seconds": time.monotonic() - begin}
            records["commands"].append(record)
            if run.returncode:
                raise ValueError("static compilation failed")
            key = "helper" if source == "guest.c" else "gate"
            records["inputs"][key], data = file_binding(output / name, 4 * f0b.MIB)
            records["inputs"][key]["elf"] = static_elf(data)
            input_bytes[key] = data
        archive = f0b.payload(request["run_id"], input_bytes["busybox"], input_bytes["helper"])
        (output / "initramfs.cpio.gz").write_bytes(archive)
        records["inputs"]["initramfs"], _ = file_binding(output / "initramfs.cpio.gz", 16 * f0b.MIB)
        records["archive"] = f0b.inspect_payload(archive, request["run_id"])
        records["runtime_environment"] = {"PATH": "/usr/bin:/bin", "LANG": "C",
            "LD_LIBRARY_PATH": str(Path(request["qemu"]).parent.parent / "lib/x86_64-linux-gnu"),
            "QEMU_MODULE_DIR": str(Path(request["qemu"]).parent.parent / "lib/x86_64-linux-gnu/qemu")}
        records["state"] = "FIXED_OFFLINE_BUNDLE_NOT_BOOTED"
        if time.monotonic() - started > 60:
            raise TimeoutError("offline preparation stage deadline")
    except BaseException as error:
        records["state"] = "PREPARATION_FAILED"
        records["original_error"] = {"type": type(error).__name__, "message": str(error), "errno": getattr(error, "errno", None)}
        raise
    finally:
        records["elapsed_seconds"] = time.monotonic() - started
        (output / "BUNDLE.json").write_text(json.dumps(records, indent=2, sort_keys=True) + "\n")
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True); parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = f0b._json(f0._regular_bytes(f0._asset_path(args.request), 16 * 1024))
    result = prepare(request, args.output)
    print(json.dumps({"state": result["state"], "run_id": result["request"]["run_id"], "elapsed_seconds": result["elapsed_seconds"]}))

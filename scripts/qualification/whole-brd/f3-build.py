#!/usr/bin/env python3
"""Build one fixed offline F3 bundle; never executes the generated payload."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
from pathlib import Path
import stat
import subprocess
import time

import build
import f0
import f0b
import f2
import f3

HERE = Path(__file__).resolve().parent
NEW_INPUT_KIND = "FIXED_F3_INPUT_CLOSURE_NOT_BOOTED"
PRIVATE_CATALOG_SHA256 = None
SOURCE_NAMES = ('f0.py', 'f0b.py', 'build.py', 'guest.c', 'host-gate.c', 'supervise.py', 'transport.py', 'inputs.json', 'f2.py', 'f2-build.py', 'f2-run.py', 'f2-guest.c', 'mke2fs-f2.conf', 'f3.py', 'f3-build.py', 'f3-run.py', 'f3-inputs.json', 'f3-guest.c', 'F3.md', '../../../tests/whole-brd-f3.test.py', '../fs-source-preservation/uapi.h', '../fs-source-preservation/native.py', '../fs-source-preservation/diagnostics.py', '../fs-source-preservation/window.py', '../fs-source-preservation/probe.c')


def source_bindings():
    return {name: build.file_binding((HERE / name).resolve(), f2.MIB)[0] for name in SOURCE_NAMES}


def require_private_source():
    # This literal is part of a separately reviewed complete source identity. It is
    # deliberately unavailable to argv, the environment, requests and catalog data.
    if PRIVATE_CATALOG_SHA256 is None: raise ValueError("private_source_not_pinned")
    if type(PRIVATE_CATALOG_SHA256) is not str or re.fullmatch(r"[a-f0-9]{64}", PRIVATE_CATALOG_SHA256) is None:
        raise ValueError("invalid private source literal")
    return PRIVATE_CATALOG_SHA256


def read_input_schema():
    binding, raw = build.file_binding(HERE / "f3-inputs.json", 16384)
    schema = f0b._json(raw)
    f0._fields(schema, ("format_version", "kind", "input_kind", "catalog_filename", "catalog_limit", "counts", "shapes"))
    if schema["format_version"] != 1 or schema["kind"] != "private-f3-input-contract-v1" or schema["input_kind"] != NEW_INPUT_KIND:
        raise ValueError("unknown input schema")
    if schema["catalog_filename"] != "F3-INPUTS.private.json" or schema["catalog_limit"] != 65536:
        raise ValueError("private input contract changed")
    if schema["counts"] != {"core": 7, "payload": 8, "libraries": 50, "modules": 12}:
        raise ValueError("fixed input role counts changed")
    return binding, schema


def _digest(value):
    if type(value) is not str or re.fullmatch(r"[a-f0-9]{64}", value) is None:
        raise ValueError("invalid input digest")


def official_core_pins():
    selected = f0b._json(build.file_binding(HERE / "inputs.json", f2.MIB)[1])["selectedOfflineFiles"]
    pins = {key: selected[name]["sha256"] for key, name in (("qemu", "qemu-system-x86_64"),
        ("kernel", "vmlinuz-7.0.0-1017-azure"), ("bios", "bios-256k.bin"), ("busybox", "busybox"))}
    return pins | {"notes": f2.NOTES_SHA, "brd": f2.BRD_SHA, "config": f2.CONFIG_SHA}


def read_input_catalog(input_root):
    digest = require_private_source()
    schema_binding, schema = read_input_schema()
    binding, raw = build.file_binding(Path(input_root) / schema["catalog_filename"], schema["catalog_limit"], digest)
    catalog = f0b._json(raw); shape = schema["shapes"]
    f0._fields(catalog, shape["catalog"])
    if type(catalog["format_version"]) is not int or catalog["format_version"] != 1 or catalog["kind"] != NEW_INPUT_KIND:
        raise ValueError("unknown fixed private F3 input catalog")
    if catalog["runtime_use"] != "NOT_OBSERVED": raise ValueError("inventory cannot assert actual runtime use")
    f0._fields(catalog["provenance"], ("description", "old_manifest_equivalence"))
    if type(catalog["provenance"]["description"]) is not str or len(catalog["provenance"]["description"]) > 1024 or catalog["provenance"]["old_manifest_equivalence"] != "NOT_ESTABLISHED":
        raise ValueError("private input provenance cannot claim the old manifest")
    pins = official_core_pins()
    f0._fields(catalog["core"], tuple(pins))
    if set(catalog["payload"]) != set(f2.PAYLOAD_FILES) or catalog["payload_aliases"] != f2.PAYLOAD_LINKS:
        raise ValueError("fixed guest payload input roles changed")
    for items in (catalog["core"], catalog["payload"]):
        for item in items.values():
            f0._fields(item, shape["file"]); _digest(item["sha256"])
            if type(item["bytes"]) is not int or not 0 < item["bytes"] <= 64 * f2.MIB: raise ValueError("input size")
    if any(catalog["core"][key]["sha256"] != digest for key, digest in pins.items()):
        raise ValueError("private catalog cannot replace an official core input")
    for name, (size, digest, _) in f2.PAYLOAD_FILES.items():
        if (catalog["payload"][name]["bytes"], catalog["payload"][name]["sha256"]) != (size, digest):
            raise ValueError("private catalog cannot replace a fixed guest input")
    if type(catalog["libraries"]) is not list or len(catalog["libraries"]) != schema["counts"]["libraries"]:
        raise ValueError("fixed library role set changed")
    requested = set()
    for library in catalog["libraries"]:
        f0._fields(library, shape["library"]); _digest(library["sha256"])
        for route in (library["requested"], library["resolved"]): f0._fields(route, ("root", "path"))
        role = json.dumps(library["requested"], sort_keys=True)
        if role in requested: raise ValueError("duplicate library route")
        requested.add(role)
        if type(library["bytes"]) is not int or not 0 < library["bytes"] <= 64 * f2.MIB or type(library["links"]) is not list:
            raise ValueError("invalid fixed library")
        if library["origin"] not in ("fixed_package", "current_host") or library["old_comparison"] not in ("same", "unknown"):
            raise ValueError("unknown library provenance")
        for link in library["links"]:
            f0._fields(link, ("at", "target")); f0._fields(link["at"], ("root", "path"))
            if type(link["target"]) is not str: raise ValueError("input link text")
    for key in ("provider_libraries", "provider_executables", "firmware", "modules"):
        f0._fields(catalog[key], shape["modules" if key == "modules" else "firmware" if key == "firmware" else "directory"])
    if catalog["modules"]["role"] != "inventory_only_not_observed_runtime_load" or len(catalog["modules"]["entries"]) != schema["counts"]["modules"]:
        raise ValueError("fixed optional module inventory changed")
    for entry in catalog["modules"]["entries"]:
        f0._fields(entry, ("name", "bytes", "sha256", "needed")); _digest(entry["sha256"])
        if type(entry["needed"]) is not list or any(type(name) is not str for name in entry["needed"]): raise ValueError("module dependency metadata")
    f0._fields(catalog["runtime"], shape["runtime"])
    return binding, schema_binding, catalog


def _input_path(location, roots):
    f0._fields(location, ("root", "path"))
    name = location["path"]
    if location["root"] not in roots or type(name) is not str or not name or name.startswith("/"):
        raise ValueError("unknown input route")
    if any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("noncanonical input route")
    return Path(f0._asset_path(str(roots[location["root"]] / name)))


def _input_address(path, roots):
    for root in ("input", "source"):
        if path.is_relative_to(roots[root]):
            return {"root": root, "path": str(path.relative_to(roots[root]))}
    return {"root": "host", "path": str(path.relative_to("/"))}


def _input_route(path, roots):
    """Observe every symlink spelling as well as the final ordinary route."""
    remaining = list(path.parts[1:]); current = Path("/"); links = []
    while remaining:
        part = remaining.pop(0)
        if part in ("", "."): continue
        if part == "..": current = current.parent; continue
        candidate = Path(f0._asset_path(str(current / part)))
        mode = candidate.lstat().st_mode
        if stat.S_ISLNK(mode):
            target = os.readlink(candidate)
            links.append({"at": _input_address(candidate, roots), "target": target})
            if len(links) > 40: raise ValueError("input symlink budget")
            destination = Path(target)
            if destination.is_absolute():
                current = Path("/"); remaining = list(destination.parts[1:]) + remaining
            else:
                remaining = list(destination.parts) + remaining
        else:
            if remaining and not stat.S_ISDIR(mode): raise ValueError("non-directory input ancestor")
            current = candidate
    return {"resolved": _input_address(current, roots), "links": links}


def _input_directory(path, roots):
    route = _input_route(path, roots); observed = path.lstat()
    if route["links"] or not stat.S_ISDIR(observed.st_mode):
        raise ValueError("input inventory needs an ordinary canonical directory")
    return {"path": str(path), "device": observed.st_dev, "inode": observed.st_ino,
            "mode": stat.S_IMODE(observed.st_mode), "uid": observed.st_uid, "gid": observed.st_gid}


def host_runtime_paths():
    """Search rules of the already-public fixed Debian QEMU/glibc family, not a host inventory."""
    return {"cache": "/etc/ld.so.cache", "preload": "/etc/ld.so.preload",
            "module_roots": ["/usr/lib/x86_64-linux-gnu/qemu", "/var/run/qemu"],
            "firmware_roots": ["/usr/share/qemu", "/usr/share/seabios", "/usr/lib/ipxe/qemu"]}


def _absent_input(path, roots):
    path = Path(f0._asset_path(str(path)))
    try: path.lstat()
    except FileNotFoundError: pass
    else: raise ValueError("runtime search path must be absent")
    ancestor = path.parent
    while True:
        try: ancestor.lstat(); break
        except FileNotFoundError: ancestor = ancestor.parent
    route = _input_route(ancestor, roots)
    identity = _input_directory(_input_path(route["resolved"], roots), roots)
    return {"path": str(path), "existing_ancestor": str(ancestor), "route": route, "identity": identity}


def _elf_interpreter(raw):
    if len(raw) < 64 or raw[:7] != b"\x7fELF\x02\x01\x01" or struct.unpack_from("<H", raw, 18)[0] != 62:
        raise ValueError("fixed x86-64 ELF interpreter required")
    offset = struct.unpack_from("<Q", raw, 32)[0]
    width, count = struct.unpack_from("<HH", raw, 54)
    if width != 56 or not 0 < count <= 256 or offset + width * count > len(raw):
        raise ValueError("ELF program header bounds")
    interpreters = []
    for index in range(count):
        at = offset + width * index
        if struct.unpack_from("<I", raw, at)[0] != 3: continue
        start = struct.unpack_from("<Q", raw, at + 8)[0]; length = struct.unpack_from("<Q", raw, at + 32)[0]
        if not 2 <= length <= 4096 or start + length > len(raw): raise ValueError("ELF interpreter bounds")
        value = raw[start:start + length]
        if not value.endswith(b"\0") or b"\0" in value[:-1]: raise ValueError("ELF interpreter encoding")
        interpreters.append(value[:-1].decode("ascii"))
    if len(interpreters) != 1 or not interpreters[0].startswith("/"):
        raise ValueError("one absolute ELF interpreter required")
    return interpreters[0]


def runtime_input_bindings(closure, catalog, data, roots, bind_file):
    """Recheck exact search inputs. This does not assert an actual module/firmware load."""
    runtime = catalog["runtime"]; paths = host_runtime_paths()
    if runtime["search_profile"] != "fixed-q35-direct-kernel-v1" or runtime["kernel_protocol"] != 0x20f or runtime["boot_rom"] != "linuxboot_dma.bin":
        raise ValueError("runtime_use_NOT_ESTABLISHED")
    kernel = data["kernel"]
    if len(kernel) < 0x208 or kernel[0x202:0x206] != b"HdrS" or struct.unpack_from("<H", kernel, 0x206)[0] != 0x20f:
        raise ValueError("fixed direct-kernel boot protocol changed")
    interpreter = _elf_interpreter(data["qemu"])
    if str(_input_path(runtime["loader"], roots)) != interpreter:
        raise ValueError("actual ELF interpreter route differs from fixed loader")
    loaded = [entry for entry in closure["libraries"] if entry["requested_path"] == interpreter]
    if len(loaded) != 1: raise ValueError("loader missing from fixed library closure")
    cache = runtime["cache"]
    f0._fields(cache, ("requested", "resolved", "links", "bytes", "sha256"))
    _digest(cache["sha256"])
    if type(cache["bytes"]) is not int or not 0 < cache["bytes"] <= f2.MIB:
        raise ValueError("loader cache bound")
    if str(_input_path(cache["requested"], roots)) != paths["cache"]:
        raise ValueError("actual loader cache route changed")
    cache_binding, _ = bind_file(cache["requested"] | {key: cache[key] for key in ("bytes", "sha256")}, f2.MIB,
                                {key: cache[key] for key in ("resolved", "links")})
    qemu = Path(closure["core"]["qemu"]["path"]); provider = qemu.parent.parent
    expected = {"provider_executables": qemu.parent, "provider_libraries": provider / "lib/x86_64-linux-gnu",
                "modules": provider / "lib/x86_64-linux-gnu/qemu", "firmware": provider / "share/qemu"}
    if any(closure[name]["path"] != str(path) for name, path in expected.items()):
        raise ValueError("actual execution route is not covered by the fixed inventories")
    # The fixed binary uses these compiled search roots when qemu-bundle is absent.
    # Neither -L nor QEMU_MODULE_DIR is treated as an exclusive search flag.
    absence_paths = [qemu.parent / "qemu-bundle", Path(paths["preload"]), expected["provider_libraries"] / "glibc-hwcaps"]
    absence_paths += [Path(path) for path in paths["module_roots"] + paths["firmware_roots"]]
    absent = [_absent_input(path, roots) for path in absence_paths]
    rom = expected["firmware"] / runtime["boot_rom"]
    rows = [entry for entry in closure["firmware"]["entries"] if entry["name"] == runtime["boot_rom"]]
    if len(rows) != 1 or rows[0]["mode"] != stat.S_IFREG:
        raise ValueError("unique fixed linuxboot_dma firmware required")
    rom_binding, _ = bind_file(_input_address(rom, roots) | {key: rows[0][key] for key in ("bytes", "sha256")}, 4 * f2.MIB)
    return {"status": "FIXED_PRECONDITIONS_NOT_RUNTIME_EVIDENCE", "profile": runtime["search_profile"],
            "loader": loaded[0], "cache": cache_binding, "cache_route": {key: cache[key] for key in ("requested", "resolved", "links")},
            "absent_search_inputs": absent, "absolute_bios": closure["core"]["bios"], "boot_rom": rom_binding,
            "kernel_protocol": runtime["kernel_protocol"], "optional_module_use": "NOT_OBSERVED",
            "firmware_read_trace": "NOT_OBSERVED"}


def runtime_cwd(path):
    path = Path(f0._asset_path(str(path)))
    identity = _input_directory(path, {"input": path, "source": HERE, "host": Path("/")})
    if identity["uid"] != os.getuid() or identity["mode"] != 0o700 or list(path.iterdir()):
        raise ValueError("runtime cwd must be an owned empty private directory")
    return identity | {"entries": []}


def verify_input_closure(request):
    """Read the new fixed family; this is not the old F0B manifest or runtime evidence."""
    require_private_source()
    f0._fields(request, ("run_id", "input_kind", "input_root"))
    f3.plan(json.dumps({"run_id": request["run_id"]}).encode())
    if request["input_kind"] != NEW_INPUT_KIND: raise ValueError("unknown F3 input kind")
    root = Path(f0._asset_path(request["input_root"]))
    roots = {"input": root, "source": HERE, "host": Path("/")}
    root_identity = _input_directory(root, roots)
    catalog_binding, schema_binding, catalog = read_input_catalog(root)
    closure = {"kind": NEW_INPUT_KIND, "catalog": catalog_binding, "schema": schema_binding, "root": root_identity,
               "core": {}, "payload": {}, "payload_aliases": {}, "libraries": [],
               "runtime_use": "NOT_OBSERVED"}
    core_bytes = {}; payload_bytes = {}; routes = []

    def bind_file(item, limit, expected_route=None):
        location = {key: item[key] for key in ("root", "path")}
        path = _input_path(location, roots)
        route = _input_route(path, roots)
        if expected_route is None: expected_route = {"resolved": location, "links": []}
        if route != expected_route: raise ValueError("fixed input route changed")
        resolved = _input_path(route["resolved"], roots)
        binding, raw = build.file_binding(resolved, limit, item["sha256"])
        if binding["bytes"] != item["bytes"]: raise ValueError("fixed input size changed")
        if _input_route(path, roots) != route: raise ValueError("input route changed during read")
        routes.append((path, route))
        return binding, raw

    for name, item in catalog["core"].items():
        closure["core"][name], core_bytes[name] = bind_file(item, 64 * f2.MIB)
    for name, item in catalog["payload"].items():
        closure["payload"][name], payload_bytes[name] = bind_file(item, 4 * f2.MIB)
    payload_root = root / "payload-root"
    for name, target in catalog["payload_aliases"].items():
        path = payload_root / name
        if not stat.S_ISLNK(path.lstat().st_mode) or os.readlink(path) != target:
            raise ValueError("fixed guest ELF alias changed")
        route = _input_route(path, roots)
        if not _input_path(route["resolved"], roots).is_relative_to(payload_root):
            raise ValueError("guest ELF alias escaped the fixed payload")
        closure["payload_aliases"][name] = {"target": target, "route": route}
        routes.append((path, route))
    for item in catalog["libraries"]:
        requested = item["requested"]
        route = {"resolved": item["resolved"], "links": item["links"]}
        binding, _ = bind_file(requested | {key: item[key] for key in ("bytes", "sha256")}, 64 * f2.MIB, route)
        closure["libraries"].append(binding | {"requested_path": str(_input_path(requested, roots)), "route": route})

    inventories = []
    payload_identity = _input_directory(payload_root, roots)
    payload_entries = build.data_inventory(str(payload_root)); expected_payload = {}
    for name, item in catalog["payload"].items():
        if item["root"] != "input" or item["path"] != "payload-root/" + name:
            raise ValueError("fixed guest payload route changed")
        expected_payload[name] = {"name": name, "mode": stat.S_IFREG, "bytes": item["bytes"], "sha256": item["sha256"]}
    for name, target in catalog["payload_aliases"].items():
        expected_payload[name] = {"name": name, "mode": stat.S_IFLNK, "link": target}
    for name in list(expected_payload):
        for parent in Path(name).parents:
            if str(parent) != ".": expected_payload[str(parent)] = {"name": str(parent), "mode": stat.S_IFDIR}
    if {entry["name"]: entry for entry in payload_entries} != expected_payload:
        raise ValueError("fixed guest payload inventory changed")
    closure["payload_tree"] = payload_identity | {"entries": payload_entries}
    inventories.append((payload_root, payload_identity, payload_entries))
    for name in ("provider_libraries", "provider_executables", "firmware"):
        item = catalog[name]; path = _input_path({"root": "input", "path": item["path"]}, roots)
        identity = _input_directory(path, roots)
        entries = build.data_inventory(str(path))
        if entries != item["entries"]: raise ValueError("fixed " + name + " inventory changed")
        closure[name] = identity | {"entries": entries}
        inventories.append((path, identity, entries))
    # Optional module bytes are inventoried, not added to the 50 loaded startup libraries.
    item = catalog["modules"]; path = _input_path({"root": "input", "path": item["path"]}, roots)
    identity = _input_directory(path, roots)
    expected = [{key: entry[key] for key in ("name", "bytes", "sha256")} | {"mode": stat.S_IFREG}
                for entry in item["entries"]]
    entries = build.data_inventory(str(path))
    if entries != expected: raise ValueError("fixed optional module inventory changed")
    closure["modules"] = identity | {"entries": entries, "role": item["role"]}
    inventories.append((path, identity, entries))
    if catalog["firmware"]["targets"]: raise ValueError("this fixed input family has no external firmware targets")
    provider = Path(closure["core"]["qemu"]["path"]).parent.parent
    closure["runtime_environment"] = {"PATH": "/usr/bin:/bin", "LANG": "C",
        "LD_LIBRARY_PATH": str(provider / "lib/x86_64-linux-gnu"),
        "QEMU_MODULE_DIR": str(provider / "lib/x86_64-linux-gnu/qemu")}
    closure["qemu_data"] = {"path": closure["firmware"]["path"], "entries": closure["firmware"]["entries"],
        "meaning": "fixed directory/link bytes; not actual runtime use or loaded-module closure"}
    closure["runtime_inputs"] = runtime_input_bindings(closure, catalog, core_bytes, roots, bind_file)
    for path, route in routes:
        if _input_route(path, roots) != route: raise ValueError("input route drift")
    for path, identity, entries in inventories:
        if _input_directory(path, roots) != identity or build.data_inventory(str(path)) != entries:
            raise ValueError("input inventory drift")
    if _input_directory(root, roots) != root_identity or read_input_catalog(root)[0] != catalog_binding:
        raise ValueError("input root/catalog drift")
    if runtime_input_bindings(closure, catalog, core_bytes, roots, bind_file) != closure["runtime_inputs"]:
        raise ValueError("runtime search input drift")
    return closure, core_bytes, payload_bytes


def fixed_header(notes, config):
    if hashlib.sha256(notes).hexdigest() != f2.NOTES_SHA: raise ValueError("exact notes required")
    f2.config_bytes(config)
    return ("#define F2_FIXED_INPUTS 1\n#define F3_FIXED_INPUTS 1\n" + "\n".join(
        "static const unsigned char " + name + "[] = {" + ",".join(str(x) for x in raw) + "};"
        for name, raw in (("F2_EXPECTED_NOTES", notes), ("F2_EXPECTED_CONFIG", config),
                          ("F3_EXPECTED_PAYLOAD", f3.PAYLOAD))) + "\n").encode()


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


def prepare_input_closure(request, output):
    """Build the new family without accepting or fabricating an old F0B bundle."""
    started = time.monotonic()
    require_private_source()
    f0._fields(request, ("run_id", "input_kind", "input_root"))
    proposal = f3.plan(json.dumps({"run_id": request["run_id"]}).encode())
    if request["input_kind"] != NEW_INPUT_KIND: raise ValueError("unknown F3 input kind")
    f0._asset_path(request["input_root"])
    out = Path(f0._asset_path(str(Path(output).absolute())))
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    record = {"kind": NEW_INPUT_KIND, "state": "BUILDING_OFFLINE", "qualification": "UNSUPPORTED",
              "guest_execution": "NOT_RUN", "request": request, "proposal": proposal, "source": {},
              "inputs": {}, "e2fs": {}, "commands": []}
    original_error = None
    try:
        record["source"] = source_bindings()
        closure, data, files = verify_input_closure(request)
        record["input_closure"] = closure; record["inputs"] = dict(closure["core"])
        record["e2fs"] = closure["payload"]
        for name in ("libraries", "qemu_data", "runtime_environment"): record[name] = closure[name]
        cwd = out / "runtime-cwd"; cwd.mkdir(mode=0o700, exist_ok=False)
        record["runtime_cwd"] = runtime_cwd(cwd)
        compiler = str(Path("/usr/bin/cc").resolve(strict=True))
        record["compiler"], _ = build.file_binding(compiler, 16 * f2.MIB)
        header = out / "fixed-inputs.h"; header.write_bytes(fixed_header(data["notes"], data["config"]))
        commands = [
            [compiler, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-static", "-fno-ident", "-Wl,--build-id=sha1",
             "-o", str(out / "host-gate"), str(HERE / "host-gate.c")],
            [compiler, "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
             "-Dmain=brdf3_sp_main", "-c", str(HERE / "../fs-source-preservation/probe.c"), "-o", str(out / "sp-probe.o")],
            [compiler, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-static", "-fno-ident", "-Wl,--build-id=sha1",
             "-include", str(header), "-o", str(out / "brd-f2"), str(HERE / "f3-guest.c"), str(out / "sp-probe.o")],
        ]
        compile_started = time.monotonic()
        for argv in commands:
            begin = time.monotonic()
            remaining = min(f3.LIMITS["compile_seconds"] - (begin - compile_started), 60 - (begin - started))
            if remaining <= 0: raise TimeoutError("complete compile/link budget")
            compiled = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=remaining,
                                      env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            record["commands"].append({"argv": argv, "exit": compiled.returncode, "stdout": compiled.stdout.decode(errors="replace"),
                                       "stderr": compiled.stderr.decode(errors="replace"), "elapsed_seconds": time.monotonic() - begin})
            if compiled.returncode: raise ValueError("fixed F3 helper compilation failed")
        if time.monotonic() - compile_started > f3.LIMITS["compile_seconds"]:
            raise TimeoutError("complete compile/link budget")
        for key, name in (("gate", "host-gate"), ("helper", "brd-f2")):
            record["inputs"][key], data[key] = build.file_binding(out / name, 4 * f2.MIB)
            record["inputs"][key]["elf"] = build.static_elf(data[key])
        archive = f3.payload(request["run_id"], data["busybox"], data["helper"], data["notes"], data["brd"], data["config"], files)
        (out / "initramfs.cpio.gz").write_bytes(archive)
        record["inputs"]["initramfs"], _ = build.file_binding(out / "initramfs.cpio.gz", 16 * f2.MIB)
        record["archive"] = f3.inspect_payload(archive, request["run_id"])
        record["mkfs_argv"] = f2.mkfs_argv(request["run_id"]); record["mkfs_environment"] = dict(f2.MKFS_ENV)
        if verify_input_closure(request)[0] != closure: raise ValueError("inputs changed during offline build")
        if runtime_cwd(cwd) != record["runtime_cwd"]: raise ValueError("runtime cwd changed during offline build")
        if source_bindings() != record["source"]: raise ValueError("source changed during offline build")
        if time.monotonic() - started > 60: raise TimeoutError("offline preparation stage deadline")
        record["state"] = "FIXED_F3_BUNDLE_NOT_BOOTED"
    except BaseException as error:
        original_error = error; record["state"] = "OFFLINE_BUILD_FAILED"
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


def prepare(request, output):
    if type(request) is dict and "input_kind" in request: return prepare_input_closure(request, output)
    f0._fields(request, ("run_id", "base_bundle", "base_bundle_sha256", "brd", "payload_root"))
    proposal = f3.plan(json.dumps({"run_id": request["run_id"]}).encode())
    if not isinstance(request["base_bundle_sha256"], str) or len(request["base_bundle_sha256"]) != 64:
        raise ValueError("exact base digest required")
    for name in ("base_bundle", "brd", "payload_root"): f0._asset_path(request[name])
    out = Path(f0._asset_path(str(Path(output).absolute())))
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    record = {"kind": "fixed-whole-brd-f3-bundle", "state": "BUILDING_OFFLINE", "qualification": "UNSUPPORTED",
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
        commands = [
            [compiler, "-std=gnu11", "-O2", "-Wall", "-Wextra", "-Werror", "-fno-ident",
             "-Dmain=brdf3_sp_main", "-c", str(HERE / "../fs-source-preservation/probe.c"), "-o", str(out / "sp-probe.o")],
            [compiler, "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-static", "-fno-ident", "-Wl,--build-id=sha1",
             "-include", str(header), "-o", str(out / "brd-f2"), str(HERE / "f3-guest.c"), str(out / "sp-probe.o")],
        ]
        compile_started = time.monotonic()
        for argv in commands:
            remaining = f3.LIMITS["compile_seconds"] - (time.monotonic() - compile_started)
            if remaining <= 0: raise TimeoutError("complete compile/link budget")
            begin = time.monotonic()
            compiled = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=remaining,
                                      env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            record["commands"].append({"argv": argv, "exit": compiled.returncode, "stdout": compiled.stdout.decode(errors="replace"),
                                       "stderr": compiled.stderr.decode(errors="replace"), "elapsed_seconds": time.monotonic() - begin})
            if compiled.returncode: raise ValueError("fixed F3 helper compilation failed")
        record["inputs"]["helper"], data["helper"] = build.file_binding(out / "brd-f2", 4 * f2.MIB)
        record["inputs"]["helper"]["elf"] = build.static_elf(data["helper"])
        archive = f3.payload(request["run_id"], data["busybox"], data["helper"], data["notes"], data["brd"], data["config"], files)
        (out / "initramfs.cpio.gz").write_bytes(archive)
        record["inputs"]["initramfs"], _ = build.file_binding(out / "initramfs.cpio.gz", 16 * f2.MIB)
        record["archive"] = f3.inspect_payload(archive, request["run_id"])
        record["mkfs_argv"] = f2.mkfs_argv(request["run_id"]); record["mkfs_environment"] = dict(f2.MKFS_ENV)
        if source_bindings() != record["source"]: raise ValueError("source changed during offline build")
        if time.monotonic() - started > 60: raise TimeoutError("offline preparation stage deadline")
        record["state"] = "FIXED_F3_BUNDLE_NOT_BOOTED"
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

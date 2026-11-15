#!/usr/bin/env python3
"""One separately released private F3 run. Never called by standard CI."""
from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import time

import build
import f0
import f0b
import f2
import f3
from supervise import OwnedChild, bounded_read, result_state
from transport import Artifacts, OutputLimit, Pump, QMP, stdio_argv

_spec = importlib.util.spec_from_file_location("f3_builder", Path(__file__).with_name("f3-build.py"))
builder = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(builder)


def validate(bundle_path, digest):
    binding, raw = build.file_binding(bundle_path, f2.MIB, digest); bundle = f0b._json(raw)
    if bundle.get("kind") == builder.NEW_INPUT_KIND: builder.require_private_source()
    if bundle.get("state") != "FIXED_F3_BUNDLE_NOT_BOOTED": raise ValueError("fixed offline F3 bundle required")
    run_id = bundle["request"]["run_id"]
    if bundle["proposal"] != f3.plan(json.dumps({"run_id": run_id}).encode()): raise ValueError("F3 proposal changed")
    if bundle["source"] != builder.source_bindings(): raise ValueError("execution sources differ from frozen bundle")
    if bundle["mkfs_argv"] != f2.mkfs_argv(run_id) or bundle["mkfs_environment"] != f2.MKFS_ENV:
        raise ValueError("fixed mkfs contract changed")
    keys = {"qemu", "kernel", "bios", "busybox", "notes", "gate", "helper", "brd", "config", "initramfs"}
    if set(bundle["inputs"]) != keys or set(bundle["e2fs"]) != set(f2.PAYLOAD_FILES): raise ValueError("fixed input set changed")
    if bundle.get("kind") == builder.NEW_INPUT_KIND:
        f0._fields(bundle, ("kind", "state", "qualification", "guest_execution", "request", "proposal", "source", "inputs",
                           "e2fs", "commands", "input_closure", "libraries", "qemu_data", "runtime_environment", "compiler",
                           "archive", "mkfs_argv", "mkfs_environment", "elapsed_seconds", "runtime_cwd"))
        if bundle["qualification"] != "UNSUPPORTED" or bundle["guest_execution"] != "NOT_RUN":
            raise ValueError("offline input cannot assert a runtime qualification")
        closure, _, _ = builder.verify_input_closure(bundle["request"])
        if closure != bundle["input_closure"]: raise ValueError("fixed F3 input closure changed")
        if any(bundle["inputs"][key] != value for key, value in closure["core"].items()):
            raise ValueError("actual provider input route/bytes changed")
        if bundle["e2fs"] != closure["payload"] or any(bundle[name] != closure[name] for name in ("libraries", "qemu_data", "runtime_environment")):
            raise ValueError("new input family was mixed with another runtime closure")
        if builder.runtime_cwd(Path(bundle_path).parent / "runtime-cwd") != bundle["runtime_cwd"]:
            raise ValueError("fixed runtime cwd changed")
    else:
        if "input_kind" in bundle["request"]: raise ValueError("new input family cannot be relabelled as a legacy bundle")
        _, base = builder.verify_base(bundle["base_bundle"]["path"], bundle["base_bundle"]["sha256"])
        for key in ("qemu", "kernel", "bios", "busybox", "notes", "gate"):
            if bundle["inputs"][key]["sha256"] != base["inputs"][key]["sha256"]: raise ValueError("provider/gate input changed")
        if any(bundle[name] != base[name] for name in ("libraries", "qemu_data", "runtime_environment")):
            raise ValueError("provider runtime closure changed")
    inputs = {name: build.file_binding(item["path"], 64 * f2.MIB, item["sha256"])[1] for name, item in bundle["inputs"].items()}
    if hashlib.sha256(inputs["brd"]).hexdigest() != f2.BRD_SHA: raise ValueError("module changed")
    f2.config_bytes(inputs["config"])
    build.static_elf(inputs["gate"]); build.static_elf(inputs["helper"])
    archive = f3.inspect_payload(inputs["initramfs"], run_id)
    if archive != bundle["archive"]: raise ValueError("fixed F3 archive changed")
    member_hashes = {row["name"]: row["sha256"] for row in archive["members"]}
    for name, member in (("busybox", "bin/busybox"), ("helper", "bin/brd-f2"), ("notes", "run/notes"),
                         ("brd", "usr/lib/modules/brd.ko"), ("config", "etc/mke2fs-f2.conf")):
        if hashlib.sha256(inputs[name]).hexdigest() != member_hashes[member]: raise ValueError("archive input mismatch")
    for library in bundle["libraries"]:
        if str(Path(library["requested_path"]).resolve(strict=True)) != library["path"]: raise ValueError("library route changed")
        build.file_binding(library["path"], 64 * f2.MIB, library["sha256"])
    if build.data_inventory(bundle["qemu_data"]["path"]) != bundle["qemu_data"]["entries"]: raise ValueError("firmware changed")
    return binding, bundle, inputs


_old_spec = importlib.util.spec_from_file_location("fixed_f2_run_helpers", Path(__file__).with_name("f2-run.py"))
_old = importlib.util.module_from_spec(_old_spec); _old_spec.loader.exec_module(_old)
finish_artifacts = _old.finish_artifacts
create_claim = _old.create_claim


def runtime_preflight(bundle_path, bundle, output, argv=None, owned=None):
    """A source-pinned input contract, never a caller approval or actual loading receipt."""
    builder.require_private_source()
    if bundle.get("kind") != builder.NEW_INPUT_KIND: raise ValueError("unknown runtime input family")
    if bundle["source"] != builder.source_bindings(): raise ValueError("private source identity changed")
    closure, _, _ = builder.verify_input_closure(bundle["request"])
    if closure != bundle["input_closure"] or closure["runtime_inputs"]["status"] != "FIXED_PRECONDITIONS_NOT_RUNTIME_EVIDENCE":
        raise ValueError("runtime_use_NOT_ESTABLISHED")
    cwd_path = Path(bundle_path).parent / "runtime-cwd"
    cwd = builder.runtime_cwd(cwd_path)
    if cwd != bundle["runtime_cwd"] or str(Path.cwd()) != cwd["path"]:
        raise ValueError("runner must use the exact fixed empty cwd")
    actual = os.stat(".")
    if (actual.st_dev, actual.st_ino) != (cwd["device"], cwd["inode"]):
        raise ValueError("actual runtime cwd identity changed")
    claim = Path(bundle_path).parent / "EXECUTION-ATTEMPT.json"
    if any(path.resolve().is_relative_to(cwd_path) for path in (Path(output), claim)):
        raise ValueError("output and claim must remain outside the empty runtime cwd")
    assets = {name: bundle["inputs"][name]["path"] for name in ("qemu", "kernel", "bios", "initramfs")}
    assets["qemu_data"] = bundle["qemu_data"]["path"]
    expected = f0.command_preview(json.dumps({"run_id": bundle["request"]["run_id"], "target_count": 1}).encode(), assets)["argv"]
    if expected[-1] != f0b.CMDLINE or argv is not None and argv != expected:
        raise ValueError("fixed runtime argv changed")
    if bundle["runtime_environment"] != closure["runtime_environment"]:
        raise ValueError("fixed four-key runtime environment changed")
    if owned is not None and owned.argv != stdio_argv(expected, owned.serial_identity["inherited_write_fd"]):
        raise ValueError("actual owned stdio argv changed")
    return {"cwd": cwd, "catalog": closure["catalog"], "schema": closure["schema"],
            "status": "FIXED_PRECONDITIONS_NOT_RUNTIME_EVIDENCE"}


def execute(bundle_path, digest, output):
    started = time.monotonic()
    binding, bundle, inputs = validate(bundle_path, digest)
    run_id = bundle["request"]["run_id"]; out = Path(f0._asset_path(str(Path(output).absolute())))
    new_inputs = bundle.get("kind") == builder.NEW_INPUT_KIND
    runtime = runtime_preflight(bundle_path, bundle, out) if new_inputs else None
    if new_inputs and time.monotonic() - started > 60: raise TimeoutError("preflight deadline")
    artifacts = Artifacts(out)
    result = {"kind": "private-f3-source-preservation-run", "bundle": binding, "proposal": bundle["proposal"], "state": "NOT_STARTED",
              "qualification": "UNSUPPORTED", "production_bound": False, "commit_barrier": False, "content_probes": 1, "attempts": 1, "guest_attempts": 0, "guest_starts": 0,
              "original_error": None, "secondary_errors": [], "cleanup": {"verified": False}, "normal_poweroff_observed": False,
              "host": {"uname": list(os.uname()), "uid": os.getuid(), "gid": os.getgid()}}
    if new_inputs: result.update(runtime_preflight=runtime, runtime_checks=["before-claim"])
    owned = None; pump = None; qmp = None; capture = None; tail = b""; finished = False
    stage_started = None; stage = "boot"; boot_started = None; complete_seen_at = None

    def record_error(error, phase, primary=True):
        row = {"phase": phase, "type": type(error).__name__, "errno": getattr(error, "errno", None), "message": str(error)}
        if primary and result["original_error"] is None: result["original_error"] = row
        else: result["secondary_errors"].append(row)

    def observe_serial(chunk):
        nonlocal tail, finished, stage_started, stage, complete_seen_at
        tail += chunk
        while b"\n" in tail:
            line, tail = tail.split(b"\n", 1)
            if len(line) > f3.FRAME_BYTES: raise OutputLimit("encoded serial frame budget")
            if not line.startswith((b"BRDF2 ", b"BRDF3 ")): continue
            try: row = f0b._json(line[6:].rstrip(b"\r"))
            except (ValueError, TypeError): continue  # Final strict consumer rejects it.
            if row.get("run_id") != run_id or row.get("origin") != "management": continue
            event = row.get("event")
            if event in ("p1-start", "metadata-start", "format-start", "mount-private"):
                stage = event; stage_started = time.monotonic()
            elif event in ("p1-exit", "metadata-exit", "format-exit"):
                stage = "management"; stage_started = time.monotonic()
            elif event == "guest-complete" and line.startswith(b"BRDF3 "):
                finished = True
                if complete_seen_at is None: complete_seen_at = time.monotonic()
        if len(tail) > f3.FRAME_BYTES: raise OutputLimit("unbounded serial line")

    try:
        claim = Path(bundle_path).parent / "EXECUTION-ATTEMPT.json"
        raw = (json.dumps({"run_id": run_id, "bundle_sha256": digest, "output": str(out), "attempts": 1}) + "\n").encode()
        create_claim(claim, raw)
        result["host"]["limits"] = {str(which): resource.getrlimit(which) for which in (resource.RLIMIT_AS, resource.RLIMIT_CPU, resource.RLIMIT_CORE)}
        for which, limit in ((resource.RLIMIT_AS, 2048 * f2.MIB), (resource.RLIMIT_CPU, 300)):
            if any(n != resource.RLIM_INFINITY and n < limit for n in resource.getrlimit(which)): raise ValueError("existing limit below child budget")
        for path, name, limit in (("/proc/self/cgroup", "host.cgroup", 65536), ("/proc/self/mountinfo", "host.mountinfo", f2.MIB),
                                  ("/proc/meminfo", "host.meminfo", 65536), ("/proc/self/limits", "host.limits", 65536)):
            artifacts.put(name, bounded_read(path, limit), limit)
        result["host"]["cgroup_effective_limits"] = "NOT_ESTABLISHED_BY_METADATA"
        if time.monotonic() - started > 60: raise TimeoutError("preflight deadline")
        assets = {name: bundle["inputs"][name]["path"] for name in ("qemu", "kernel", "bios", "initramfs")}
        assets["qemu_data"] = bundle["qemu_data"]["path"]
        argv = f0.command_preview(json.dumps({"run_id": run_id, "target_count": 1}).encode(), assets)["argv"]
        if argv[-1] != f0b.CMDLINE: raise ValueError("fixed boot inputs changed")
        if new_inputs:
            runtime_preflight(bundle_path, bundle, out, argv); result["runtime_checks"].append("before-gate")
            if time.monotonic() - started > 60: raise TimeoutError("preflight deadline")
        result["guest_attempts"] = 1; boot_started = time.monotonic()
        owned = OwnedChild(bundle["inputs"]["gate"]["path"], bundle["inputs"]["gate"]["sha256"], assets["qemu"],
                           bundle["inputs"]["qemu"]["sha256"], argv, bundle["runtime_environment"])
        result.update(argv=owned.argv, gate_argv=owned.gate_argv, serial_pipe=owned.serial_identity)
        if new_inputs:
            runtime_preflight(bundle_path, bundle, out, argv, owned); result["runtime_checks"].append("before-ack")
            if time.monotonic() - started > 60: raise TimeoutError("preflight deadline")
        pump = Pump(owned, artifacts, observe_serial); owned.release(bundle["inputs"]["qemu"]["sha256"])
        result["guest_starts"] = 1; qmp = QMP(pump)
        while True:
            pump.poll(0.005); now = time.monotonic()
            returncode = owned.proc.poll()
            if returncode is not None:
                pump.finish(True)
                if not finished: raise ChildProcessError("guest exited before complete lifecycle receipt")
                result["normal_poweroff_observed"] = type(returncode) is int and returncode == 0
                result["exit_before_host_cleanup"] = {"returncode": returncode, "host_requested_quit": False}
                break
            if "serial" in pump.eof and not finished: raise EOFError("serial EOF before completion")
            if complete_seen_at is not None and now - complete_seen_at >= 5:
                raise TimeoutError("guest completion was not followed by normal poweroff")
            if stage_started is None and now - boot_started >= 60: raise TimeoutError("boot deadline")
            limit = 3 if stage in ("p1-start", "metadata-start") else 60
            if stage_started is not None and now - stage_started >= limit: raise TimeoutError("F3 phase deadline: " + stage)
            if now - started >= 290: raise TimeoutError("fixture reserves final ten seconds for cleanup")
    except BaseException as error:
        record_error(error, "execution")
        if hasattr(error, "claim_close_error"): result["secondary_errors"].append(error.claim_close_error)
        if hasattr(error, "owned_cleanup"): result["constructor_cleanup"] = error.owned_cleanup
    finally:
        try:
            if owned is not None:
                result["cleanup"] = owned.cleanup(qmp, pump)
                result["actual_child"] = {"before": owned.before, "after": owned.after, "events": owned.events}
            if qmp is not None: result["qmp_receipts"] = qmp.receipts
            if pump is not None:
                result.update(pipe_errors=pump.errors, pipe_eof=sorted(pump.eof), pipe_read_bytes=dict(pump.read_counts))
                capture = f3.decode_serial(bytes(pump.serial), run_id, inputs["notes"])
                for name, raw in capture.pop("raw_artifacts").items():
                    artifacts.put(name, raw, 4 * f2.MIB)
                result["capture"] = capture
        except BaseException as error: record_error(error, "cleanup-or-capture")
        if new_inputs:
            try:
                runtime_preflight(bundle_path, bundle, out); result["runtime_checks"].append("after-cleanup")
            except BaseException as error: record_error(error, "runtime-input-final-check")
        result["elapsed_seconds"] = time.monotonic() - started
        result["lifecycle_state"] = result_state(capture, None, result["cleanup"])
        result["state"] = "F3_SOURCE_PRESERVATION_OBSERVED" if (result["original_error"] is None and capture is not None
            and result["lifecycle_state"] == "F3_SOURCE_PRESERVATION_OBSERVED" and result["normal_poweroff_observed"] is True
            and result["elapsed_seconds"] <= 300) else "FAILED_NO_RETRY"
        finish_artifacts(artifacts, result, record_error)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="One separately reviewed/released F3 guest; standard CI must never invoke execute.")
    parser.add_argument("--bundle", required=True); parser.add_argument("--bundle-sha256", required=True); parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = execute(args.bundle, args.bundle_sha256, args.output)
    print(json.dumps({key: result[key] for key in ("state", "qualification", "original_error", "secondary_errors", "final_artifact_errors")}))
    raise SystemExit(0 if result["state"] == "F3_SOURCE_PRESERVATION_OBSERVED" else 1)

#!/usr/bin/env python3
"""One explicitly accepted raw-input guest pass. Never run by normal CI.

The bundle digest binds bytes; it is not an authorization token. Root must
first accept independent implementation reviews and actual prerequisites.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import time

import build
import f0
import f0b
from supervise import OwnedChild, bounded_read, result_state
from transport import Artifacts, OutputLimit, Pump, QMP


def _execution_error_state(error, ordinary_started):
    return "OUTPUT_LIMIT" if isinstance(error, OutputLimit) else "TIMEOUT" if isinstance(error, TimeoutError) else "BOOT_FAILED" if ordinary_started is None else "ORDINARY_FAILED"


def execute(bundle_path, digest, output):
    started = time.monotonic()
    bundle_binding, raw = build.file_binding(bundle_path, f0b.MIB, digest)
    bundle = f0b._json(raw)
    if bundle.get("state") != "FIXED_OFFLINE_BUNDLE_NOT_BOOTED":
        raise ValueError("fixed offline bundle required")
    run_id = bundle["request"]["run_id"]
    proposal = f0b.plan(json.dumps({"run_id": run_id}).encode())
    if bundle["proposal"] != proposal:
        raise ValueError("bundle differs from fixed scope/budgets")
    if set(bundle["inputs"]) != {"qemu", "kernel", "bios", "busybox", "notes", "helper", "gate", "initramfs"}:
        raise ValueError("unexpected execution input set")
    catalog = json.loads((build.HERE / "inputs.json").read_text())["selectedOfflineFiles"]
    for name, original in (("qemu", "qemu-system-x86_64"), ("kernel", "vmlinuz-7.0.0-1017-azure"),
                           ("bios", "bios-256k.bin"), ("busybox", "busybox")):
        if bundle["inputs"][name]["sha256"] != catalog[original]["sha256"]:
            raise ValueError("bundle changes a fixed provider input")
    if bundle["inputs"]["notes"]["sha256"] != build.NOTES_SHA:
        raise ValueError("bundle changes fixed vendor notes")
    runtime_root = Path(bundle["inputs"]["qemu"]["path"]).parent.parent
    expected_environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LD_LIBRARY_PATH": str(runtime_root / "lib/x86_64-linux-gnu"),
                            "QEMU_MODULE_DIR": str(runtime_root / "lib/x86_64-linux-gnu/qemu")}
    if bundle["runtime_environment"] != expected_environment:
        raise ValueError("runtime environment must be the fixed provider environment")
    out = Path(f0._asset_path(str(Path(output).absolute())))
    artifacts = Artifacts(out)
    result = {"kind": "private-f0bf1-raw-input-run", "bundle": bundle_binding, "proposal": proposal,
              "host": {"uname": list(os.uname()), "uid": os.getuid(), "gid": os.getgid()},
              "qualification": "UNSUPPORTED", "fixture_targets": 0, "attempts": 1,
              "guest_attempts": 0, "guest_starts": 0, "ordinary": "NOT_RUN", "original_error": None,
              "cleanup": {"verified": False}, "policy": "UNKNOWN"}
    owned = None; qmp = None; pump = None
    scan_tail = b""; ordinary_started = None; ordinary_ended = False
    capture = None; input_bytes = {}

    def fail(state, error, phase):
        if result["original_error"] is None:
            result["original_error"] = {"state": state, "phase": phase, "type": type(error).__name__,
                                        "message": str(error), "errno": getattr(error, "errno", None)}

    def observe_serial(chunk):
        nonlocal scan_tail, ordinary_started, ordinary_ended
        scan_tail += chunk
        while b"\n" in scan_tail:
            line, scan_tail = scan_tail.split(b"\n", 1)
            if not line.startswith(b"BRDF1 "): continue
            try: frame = f0b._json(line[6:].rstrip(b"\r"))
            except (ValueError, TypeError): continue  # Final strict decode still fails.
            if type(frame) is dict and frame.get("run_id") == run_id and frame.get("origin") == "management":
                if frame.get("event") == "ordinary-start" and ordinary_started is None:
                    ordinary_started = time.monotonic()
                if frame.get("event") == "ordinary-exit": ordinary_ended = True
        if len(scan_tail) > 2 * f0b.MIB + 4096:
            raise OutputLimit("unbounded incomplete serial line")

    try:
        # One persistent claim for this frozen bundle. Failure consumes the
        # attempt; no code path retries with another guest/configuration.
        claim = Path(bundle_path).parent / "EXECUTION-ATTEMPT.json"
        fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try: os.write(fd, (json.dumps({"run_id": run_id, "bundle_sha256": digest, "output": str(out), "attempts": 1}) + "\n").encode())
        finally: os.close(fd)
        for name, item in bundle["inputs"].items():
            _, input_bytes[name] = build.file_binding(item["path"], 64 * f0b.MIB, item["sha256"])
        for name in ("helper", "gate"): build.static_elf(input_bytes[name])
        f0b.inspect_payload(input_bytes["initramfs"], run_id)
        for library in bundle["libraries"]:
            if str(Path(library["requested_path"]).resolve(strict=True)) != library["path"]:
                raise ValueError("library resolution changed")
            build.file_binding(library["path"], 64 * f0b.MIB, library["sha256"])
        if build.data_inventory(bundle["qemu_data"]["path"]) != bundle["qemu_data"]["entries"]:
            raise ValueError("QEMU data changed")
        result["host"]["limits"] = {str(which): resource.getrlimit(which) for which in (resource.RLIMIT_AS, resource.RLIMIT_CPU, resource.RLIMIT_CORE)}
        for which, limit in ((resource.RLIMIT_AS, 2048 * f0b.MIB), (resource.RLIMIT_CPU, 300)):
            if any(x != resource.RLIM_INFINITY and x < limit for x in resource.getrlimit(which)):
                raise ValueError("existing process limit is below fixed child budget")
        for path, name, limit in (("/proc/self/cgroup", "host.cgroup", 65536), ("/proc/self/mountinfo", "host.mountinfo", f0b.MIB),
                                  ("/proc/meminfo", "host.meminfo", 65536), ("/proc/self/limits", "host.limits", 65536)):
            artifacts.put(name, bounded_read(path, limit), limit)
        result["host"]["cgroup_effective_limits"] = "NOT_ESTABLISHED_BY_METADATA"
        result["host"]["resources_reserved"] = False
        if time.monotonic() - started > 60: raise TimeoutError("preflight stage deadline")
        assets = {key: bundle["inputs"][key]["path"] for key in ("qemu", "kernel", "bios", "initramfs")}
        assets["qemu_data"] = bundle["qemu_data"]["path"]
        # Reuse only the unchanged F0 argv renderer; its preparation target
        # proposal is not allocated. This new slice's fixture count is zero.
        argv = f0.command_preview(json.dumps({"run_id": run_id, "target_count": 1}).encode(), assets)["argv"]
        if argv[-1] != f0b.CMDLINE: raise ValueError("fixed cmdline changed")
        boot_started = time.monotonic()
        result["guest_attempts"] = 1
        owned = OwnedChild(bundle["inputs"]["gate"]["path"], bundle["inputs"]["gate"]["sha256"],
                           assets["qemu"], bundle["inputs"]["qemu"]["sha256"], argv, bundle["runtime_environment"])
        result["argv"] = owned.argv
        result["gate_argv"] = owned.gate_argv
        result["serial_pipe"] = owned.serial_identity
        pump = Pump(owned, artifacts, observe_serial)
        owned.release(bundle["inputs"]["qemu"]["sha256"])
        result["guest_starts"] = 1
        result["actual_child"] = {"before": owned.before, "after": owned.after, "events": owned.events}
        qmp = QMP(pump)
        boot_deadline = boot_started + 60
        while not ordinary_ended and result["original_error"] is None:
            pump.poll(0.005); now = time.monotonic()
            code = owned.proc.poll()
            if code is not None and not ordinary_ended:
                pump.finish(True)
                if not ordinary_ended:
                    raise ChildProcessError(f"owned child exited before ordinary completion: returncode={code}")
            if "serial" in pump.eof and not ordinary_ended:
                raise EOFError("serial EOF before ordinary completion")
            if ordinary_started is None and now >= boot_deadline:
                fail("TIMEOUT", TimeoutError("boot deadline"), "boot")
            if ordinary_started is not None and now - ordinary_started >= 3 and not ordinary_ended:
                fail("TIMEOUT", TimeoutError("ordinary collection deadline"), "ordinary")
            if now - started >= 290:
                fail("TIMEOUT", TimeoutError("fixture reserves final 10s cleanup"), "fixture")

    except BaseException as error:
        fail(_execution_error_state(error, ordinary_started), error, "execution")
        if hasattr(error, "owned_cleanup"): result["constructor_cleanup"] = error.owned_cleanup
    finally:
        if owned is not None:
            result["cleanup"] = owned.cleanup(qmp, pump)
            result["actual_child"] = {"before": owned.before, "after": owned.after, "events": owned.events}
        if qmp is not None: result["qmp_receipts"] = qmp.receipts
        if pump is not None:
            result["pipe_errors"] = pump.errors
            result["pipe_eof"] = sorted(pump.eof)
            result["pipe_read_bytes"] = dict(pump.read_counts)
            if result["original_error"] is None:
                try:
                    capture = f0b.decode_serial(bytes(pump.serial), run_id, input_bytes["notes"])
                    result["ordinary"] = capture["state"]; result["policy"] = capture["policy"]
                except (OSError, ValueError) as error:
                    fail(_execution_error_state(error, ordinary_started), error, "final-serial")
        if capture is not None:
            try:
                for name, observation in capture["observations"].items():
                    artifacts.put("ordinary-" + name + ".raw", observation.pop("raw"), 4 * f0b.MIB)
                result["capture"] = capture
            except (OSError, ValueError) as error:
                fail("EVIDENCE_UNPROVEN", error, "ordinary-artifact")
        result["artifact_errors"] = artifacts.seal()
        if result["artifact_errors"]: result["cleanup"]["verified"] = False
        result["elapsed_seconds"] = time.monotonic() - started
        result["state"] = result_state(capture, result["original_error"], result["cleanup"])
        if result["elapsed_seconds"] > 300 and result["original_error"] is None:
            result["state"] = "TIMEOUT"
        result["artifact_records"] = [stream.record() for stream in artifacts.entries.values()]
        # The caller also retains this function's final return / stdout: a
        # failing final metadata close cannot be encoded into its own bytes.
        result["final_seal_requires_caller_observation"] = True
        try:
            artifacts.put("RESULT.json", (json.dumps(result, indent=2, sort_keys=True) + "\n").encode(), f0b.MIB)
            members = [stream.record() for stream in artifacts.entries.values()]
            artifacts.put("MANIFEST.json", (json.dumps(members, indent=2, sort_keys=True) + "\n").encode(), f0b.MIB)
        except (OSError, ValueError) as error:
            fail("EVIDENCE_UNPROVEN", error, "metadata-artifact")
            result["state"] = result["original_error"]["state"]
        result["final_artifact_errors"] = artifacts.close()
        if result["final_artifact_errors"] and result["original_error"] is None:
            result["state"] = "EVIDENCE_UNPROVEN"

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True); parser.add_argument("--bundle-sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    outcome = execute(args.bundle, args.bundle_sha256, args.output)
    print(json.dumps({"state": outcome["state"], "qualification": outcome["qualification"],
                      "original_error": outcome["original_error"], "final_artifact_errors": outcome["final_artifact_errors"]}))
    raise SystemExit(0 if outcome["state"] == "CAPTURE_COMPLETE" else 1)

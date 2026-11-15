#!/usr/bin/env python3
"""One separately accepted <=3s owned-pipe witness, no VM or socket.

This runs only the fixed host-gate's built-in pipe-witness-target. Its two
control replies test pipe transport, not real QEMU, fdset use or guest policy.
Normal CI only runs pure controls and never invokes this entry point.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import f0b
from supervise import OwnedChild
from transport import Artifacts, Pump, QMP


def witness(gate, digest, output):
    artifacts = Artifacts(output)  # Existing output consumes this entry; no retry.
    started = time.monotonic(); deadline = started + 3
    result = {"kind": "one-owned-stdio-pipe-witness", "attempts": 1,
              "child_starts": 0, "guest_starts": 0, "socket_operations": 0,
              "qemu_runtime": "NOT_RUN", "qualification": "UNSUPPORTED",
              "host": list(os.uname()), "uid": os.getuid(), "python": sys.version,
              "original_error": None, "cleanup": {"verified": False}, "metadata_errors": []}
    owned = None; pump = None; qmp = None
    try:
        artifacts.put("CLAIM.json", (json.dumps({"gate": gate, "gate_sha256": digest, "attempts": 1}) + "\n").encode(), 4096)
        owned = OwnedChild(gate, digest, gate, digest, [gate], {"PATH": "/usr/bin:/bin", "LANG": "C"},
                           mode="pipe-witness", deadline=deadline)
        result["child_starts"] = 1
        result["gate_argv"] = owned.gate_argv
        result["serial_pipe"] = owned.serial_identity
        pump = Pump(owned, artifacts)
        owned.release(digest)
        qmp = QMP(pump, deadline=deadline - 1)
        pump.poll(0)
        if bytes(pump.serial) != b"PIPE_WITNESS_SERIAL\n":
            raise ValueError("actual inherited serial pipe bytes differ")
        if (pump.read_counts["stderr"] != len(b"PIPE_WITNESS_STDERR\n") or
                artifacts.entries["stderr.raw"].digest.hexdigest() != hashlib.sha256(b"PIPE_WITNESS_STDERR\n").hexdigest()):
            raise ValueError("actual independent stderr bytes differ")
        if "serial" in pump.eof:
            raise ValueError("serial writer did not survive until quit/reap")
        result["serial_eof_before_quit"] = False
        result["state"] = "PIPE_BYTES_OBSERVED_PENDING_REAP"
    except BaseException as error:
        result["original_error"] = {"type": type(error).__name__, "errno": getattr(error, "errno", None), "message": str(error)}
        if hasattr(error, "owned_cleanup"): result["constructor_cleanup"] = error.owned_cleanup
        result["state"] = "FAILED_NO_RETRY"
    finally:
        if owned is not None:
            result["cleanup"] = owned.cleanup(qmp, pump, deadline=deadline)
            result["actual_child"] = {"before": owned.before, "after": owned.after, "events": owned.events}
        if pump is not None:
            result["pipe_eof"] = sorted(pump.eof)
            result["pipe_read_bytes"] = dict(pump.read_counts)
            result["pipe_errors"] = pump.errors
        if qmp is not None: result["control_receipts"] = qmp.receipts
        result["raw_artifact_errors"] = artifacts.seal()
        result["elapsed_seconds"] = time.monotonic() - started
        clean = result["cleanup"]
        if (result["original_error"] is None and clean.get("verified") is True
                and clean.get("wait") == {"reaped": True, "returncode": 0}
                and not clean.get("forced") and not clean.get("wait_timeout")
                and result.get("pipe_eof") == ["qmp", "serial", "stderr"]
                and not result["raw_artifact_errors"] and result["elapsed_seconds"] <= 3):
            result["state"] = "PASS_LOCAL_OWNED_PIPE_ONLY"
        elif result["original_error"] is None:
            result["state"] = "CLEANUP_OR_DEADLINE_UNPROVEN"
        metadata_phase = "source-digests"
        try:
            result["source"] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                for name in ("pipe-witness.py", "supervise.py", "transport.py", "host-gate.c")}
            result["gate_sha256"] = digest
            metadata_phase = "artifact-records"
            result["artifacts"] = [stream.record() for stream in artifacts.entries.values()]
            metadata_phase = "result-write"
            artifacts.put("RESULT.json", (json.dumps(result, indent=2, sort_keys=True) + "\n").encode(), f0b.MIB)
        except BaseException as error:
            result["metadata_errors"].append({"phase": metadata_phase, "type": type(error).__name__,
                                               "errno": getattr(error, "errno", None), "error": str(error)})
        finally:
            # RESULT cannot contain its own final close outcome; preserve it
            # in the returned result/stdout without overwriting the first error.
            try:
                result["final_artifact_errors"] = artifacts.close()
            except BaseException as error:
                result["final_artifact_errors"] = [{"phase": "artifact-store-close", "type": type(error).__name__,
                                                     "errno": getattr(error, "errno", None), "error": str(error)}]
            if (result["metadata_errors"] or result["final_artifact_errors"]) and result["original_error"] is None:
                result["state"] = "EVIDENCE_UNPROVEN"
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gate", required=True); parser.add_argument("--gate-sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    outcome = witness(args.gate, args.gate_sha256, args.output)
    print(json.dumps({"state": outcome["state"], "elapsed_seconds": outcome["elapsed_seconds"],
                      "original_error": outcome["original_error"], "metadata_errors": outcome["metadata_errors"],
                      "final_artifact_errors": outcome["final_artifact_errors"]}))
    raise SystemExit(0 if outcome["state"] == "PASS_LOCAL_OWNED_PIPE_ONLY" else 1)

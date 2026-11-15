#!/usr/bin/env python3
"""One explicitly requested non-VM ownership witness; never imported by CI."""
from __future__ import annotations

import array
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

from supervise import OwnedChild, bounded_read


def send(sock, value, fd=None):
    raw = json.dumps(value, sort_keys=True).encode()
    if len(raw) > 128 * 1024: raise ValueError("witness message bound")
    rights = [] if fd is None else [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))]
    if sock.sendmsg([raw], rights) != len(raw): raise OSError("short witness message")


def receive(sock, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0: raise TimeoutError("one witness deadline")
    sock.settimeout(remaining)
    raw, ancillary, flags, _ = sock.recvmsg(128 * 1024 + 1, socket.CMSG_SPACE(4))
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or not raw or len(raw) > 128 * 1024:
        raise ValueError("incomplete witness message")
    fds = []
    for level, kind, data in ancillary:
        if level != socket.SOL_SOCKET or kind != socket.SCM_RIGHTS:
            raise ValueError("unexpected witness control data")
        received = array.array("i"); received.frombytes(data[:len(data) - len(data) % received.itemsize]); fds.extend(received)
    if len(fds) > 1:
        for fd in fds: os.close(fd)
        raise ValueError("unexpected extra pidfd")
    return json.loads(raw), fds[0] if fds else None


def parent_mode(fd, gate, digest):
    sock = socket.socket(fileno=fd); sock.settimeout(3)
    child = None
    try:
        child = OwnedChild(gate, digest, gate, digest, [gate], {"PATH": "/usr/bin:/bin", "LANG": "C"}, mode="witness")
        send(sock, {"phase": "retained", "parent_pid": os.getpid(), "child": child.before,
                    "events": child.events}, child.pidfd)
        if sock.recv(1) != b"R": raise ValueError("observer did not retain transferred pidfd")
        child.release(digest, witness=True)
        send(sock, {"phase": "normal-startup", "child": child.after, "events": child.events})
        if sock.recv(1) != b"X": raise ValueError("missing bounded parent-failure trigger")
        # Intentional controlled parent failure. No finally/cleanup runs;
        # the kernel PDEATHSIG must terminate the already exec'ed target.
        os._exit(23)
    except BaseException as error:
        cleanup = child.cleanup(None) if child is not None else getattr(error, "owned_cleanup", None)
        try: send(sock, {"phase": "parent-error", "error": repr(error), "cleanup": cleanup})
        except OSError: pass
        return 1


def witness(gate, digest, output):
    out = Path(output)
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    result = {"kind": "one-local-ownership-witness", "attempts": 1, "guest_starts": 0,
              "ordinary_guest_observed": False, "qualification": "UNSUPPORTED",
              "pidfd_signals_sent": [], "phases": [], "original_error": None,
              "cleanup_errors": [], "parent_reaped": False, "gate_reaped": False,
              "host": list(os.uname()), "uid": os.getuid(), "python": sys.version}
    parent = None; parent_fd = None; gate_fd = None; left = None; right = None
    started = time.monotonic(); deadline = started + 3
    try:
        if hashlib.sha256(Path(gate).read_bytes()).hexdigest() != digest: raise ValueError("fixed gate digest mismatch")
        libc = ctypes.CDLL(None, use_errno=True)
        # Affects this observer process only. Adopt this one known grandchild
        # so real wait/reap can be recorded after its controlled parent exits.
        if libc.prctl(36, 1, 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
        result["observer_subreaper"] = True
        left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        command = [sys.executable, "-B", str(Path(__file__).resolve()), "parent", str(right.fileno()), gate, digest]
        parent = subprocess.Popen(command, pass_fds=(right.fileno(),), stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        parent_fd = os.pidfd_open(parent.pid, 0)
        right.close(); right = None
        first, gate_fd = receive(left, deadline)
        result["phases"].append(first)
        if first.get("phase") != "retained" or gate_fd is None or first["parent_pid"] != parent.pid:
            raise ValueError("no actual retained creation chain")
        info = bounded_read("/proc/self/fdinfo/" + str(gate_fd), 4096).decode()
        result["received_pidfd_info"] = info
        fields = dict(line.split(":", 1) for line in info.splitlines() if ":" in line)
        if int(fields.get("Pid", "-1")) != first["child"]["pid"]:
            raise ValueError("transferred fd does not bind the created child")
        left.sendall(b"R")
        second, unexpected_fd = receive(left, deadline)
        if unexpected_fd is not None:
            os.close(unexpected_fd); raise ValueError("duplicate ownership transfer")
        result["phases"].append(second)
        if second.get("phase") != "normal-startup" or second["child"]["pid"] != first["child"]["pid"] or second["child"]["start_ticks"] != first["child"]["start_ticks"]:
            raise ValueError("normal exec incarnation not demonstrated")
        left.sendall(b"X")
        parent.wait(timeout=max(0.001, deadline - time.monotonic()))
        result["parent_reaped"] = True; result["parent_exit"] = parent.returncode
        while time.monotonic() < deadline:
            waited = os.waitid(os.P_PIDFD, gate_fd, os.WEXITED | os.WNOHANG)
            if waited is not None:
                result["gate_reaped"] = True
                result["gate_wait"] = {"pid": waited.si_pid, "code": waited.si_code, "status": waited.si_status}
                break
            time.sleep(0.001)
        if parent.returncode != 23 or not result["gate_reaped"] or result["gate_wait"]["code"] != os.CLD_KILLED or result["gate_wait"]["status"] != signal.SIGKILL:
            raise ValueError("controlled parent failure/PDEATHSIG/wait result did not match")
        result["state"] = "PASS_LOCAL_OWNERSHIP_ONLY"
    except BaseException as error:
        result["original_error"] = {"type": type(error).__name__, "message": str(error), "errno": getattr(error, "errno", None)}
        result["state"] = "FAILED_NO_RETRY"
    finally:
        for name, fd in (("parent", parent_fd), ("gate", gate_fd)):
            reaped = result["parent_reaped"] if name == "parent" else result["gate_reaped"]
            if fd is not None and not reaped:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                    result["pidfd_signals_sent"].append(name + "-SIGKILL")
                except ProcessLookupError: pass
                except OSError as error: result["cleanup_errors"].append({"phase": name + "-signal", "errno": error.errno})
        if parent is not None and not result["parent_reaped"]:
            try:
                parent.wait(timeout=3); result["parent_reaped"] = True; result["parent_exit"] = parent.returncode
            except subprocess.TimeoutExpired: result["cleanup_errors"].append({"phase": "parent-wait", "error": "timeout"})
        if gate_fd is not None and not result["gate_reaped"] and result["parent_reaped"]:
            end = time.monotonic() + 3
            try:
                while time.monotonic() < end:
                    waited = os.waitid(os.P_PIDFD, gate_fd, os.WEXITED | os.WNOHANG)
                    if waited:
                        result["gate_reaped"] = True
                        result["gate_wait"] = {"pid": waited.si_pid, "code": waited.si_code, "status": waited.si_status}; break
                    time.sleep(0.001)
            except OSError as error: result["cleanup_errors"].append({"phase": "gate-wait", "errno": error.errno})
        if parent is not None and result["parent_reaped"]:
            stdout, stderr = parent.communicate(timeout=1)
            (out / "parent.stdout").write_bytes(stdout); (out / "parent.stderr").write_bytes(stderr)
        for name, handle in (("observer-channel", left), ("parent-channel", right)):
            if handle is not None:
                try: handle.close()
                except OSError as error: result["cleanup_errors"].append({"phase": name + "-close", "errno": error.errno})
        for name, fd in (("parent-pidfd", parent_fd), ("gate-pidfd", gate_fd)):
            if fd is not None:
                try: os.close(fd)
                except OSError as error: result["cleanup_errors"].append({"phase": name + "-close", "errno": error.errno})
        result["elapsed_seconds"] = time.monotonic() - started
        if result["cleanup_errors"] or not result["parent_reaped"] or not result["gate_reaped"]:
            result["state"] = "FAILED_NO_RETRY" if result["original_error"] else "CLEANUP_UNPROVEN"
        result["script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        result["supervise_sha256"] = hashlib.sha256(Path(__file__).with_name("supervise.py").read_bytes()).hexdigest()
        result["gate_sha256"] = digest
        (out / "RESULT.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"state": result["state"], "output": str(out), "elapsed_seconds": result["elapsed_seconds"]}))
    return 0 if result["state"] == "PASS_LOCAL_OWNERSHIP_ONLY" else 1


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "witness":
        raise SystemExit(witness(sys.argv[2], sys.argv[3], sys.argv[4]))
    if len(sys.argv) == 5 and sys.argv[1] == "parent":
        raise SystemExit(parent_mode(int(sys.argv[2]), sys.argv[3], sys.argv[4]))
    raise SystemExit("explicit witness GATE SHA OUTPUT required; no automatic run")

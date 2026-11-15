"""Retained-parent supervision for the private accepted F0B/F1 slice.

Importing this module never creates a child. Actual guest execution requires
separate acceptance of the exact implementation and bundle.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import resource
import select
import signal
import socket
import stat
import subprocess
import time

import f0
import f0b


def bounded_read(path, limit):
    with open(path, "rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("bounded input exceeded: " + str(path))
    return data


def pinned_executable(path, digest):
    f0._asset_path(path)
    anchor = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        initial = os.fstat(anchor)
        if not stat.S_ISREG(initial.st_mode) or initial.st_mode & 0o6000 or not 0 < initial.st_size <= 64 * f0b.MIB:
            raise ValueError("bounded non-set-id regular executable required")
        fd = os.open("/proc/self/fd/" + str(anchor), os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
        before = os.fstat(fd)
        if (initial.st_dev, initial.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError("pinned executable identity changed")
        if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o6000 or not 0 < before.st_size <= 64 * f0b.MIB:
            raise ValueError("bounded non-set-id regular executable required")
        h = hashlib.sha256(); total = 0
        while True:
            chunk = os.read(fd, min(f0b.MIB, 64 * f0b.MIB + 1 - total))
            if not chunk:
                break
            total += len(chunk); h.update(chunk)
            if total > 64 * f0b.MIB:
                raise ValueError("executable budget exceeded")
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if identity(before) != identity(after) or total != before.st_size or h.hexdigest() != digest:
            raise ValueError("executable bytes changed or mismatched")
        return fd
    except BaseException:
        if fd is not None: os.close(fd)
        raise
    finally:
        os.close(anchor)


def child_identity(child):
    """Only a live Popen created/retained by this supervisor reaches here."""
    root = Path("/proc") / str(child.pid)
    raw_stat = bounded_read(root / "stat", 8192)
    tail = raw_stat[raw_stat.rfind(b")") + 2:].split()
    if len(tail) < 20 or int(tail[1]) != os.getpid():
        raise ValueError("child parent changed")
    status = bounded_read(root / "status", 64 * 1024)
    fields = dict(line.split(b":", 1) for line in status.splitlines() if b":" in line)
    if fields.get(b"Uid", b"").split() != [str(os.getuid()).encode()] * 4:
        raise ValueError("child UID changed")
    fd = os.open(root / "exe", os.O_RDONLY | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 64 * f0b.MIB:
            raise ValueError("unexpected child executable")
        h = hashlib.sha256(); size = 0
        while True:
            chunk = os.read(fd, min(f0b.MIB, 64 * f0b.MIB + 1 - size))
            if not chunk:
                break
            size += len(chunk); h.update(chunk)
            if size > 64 * f0b.MIB:
                raise ValueError("child executable exceeds bound")
    finally:
        os.close(fd)
    return {"pid": child.pid, "parent_pid": os.getpid(), "start_ticks": int(tail[19]),
            "uid": os.getuid(), "executable_sha256": h.hexdigest(),
            "executable_link": os.readlink(root / "exe"), "stat_raw": raw_stat.decode(),
            "status_raw": status.decode(), "limits_raw": bounded_read(root / "limits", 65536).decode(),
            "boot_id": bounded_read("/proc/sys/kernel/random/boot_id", 4096).decode().strip()}


class OwnedChild:
    """No receipt/PID constructor; always owns the Popen it just created."""
    def __init__(self, gate, gate_sha, executable, executable_sha, argv, env, mode="qemu"):
        if mode not in ("qemu", "witness") or not argv or argv[0] != executable:
            raise ValueError("fixed gate invocation required")
        self.proc = None; self.pidfd = None; self.ack = None; self.status = None
        self.events = []; self.before = None; self.after = None; self._status_buffer = b""
        self._released = False; self._finished = False
        # Validate all path shapes before any input read or child creation.
        f0._asset_path(gate); f0._asset_path(executable)
        gate_fd = pinned_executable(gate, gate_sha)
        executable_fd = None; ack_read = None; status_write = None
        try:
            executable_fd = pinned_executable(executable, executable_sha)
            ack_read, self.ack = os.pipe2(os.O_CLOEXEC)
            self.status, status_write = os.pipe2(os.O_CLOEXEC)
            command = [gate, mode, str(os.getpid()), str(ack_read), str(status_write), str(executable_fd), str(gate_fd), *argv]
            # Gate is already exec'ed when Popen returns. No blocking preexec_fn.
            self.proc = subprocess.Popen(command, executable="/proc/self/fd/" + str(gate_fd),
                                         pass_fds=(ack_read, status_write, executable_fd, gate_fd),
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, env=env, close_fds=True)
            self.pidfd = os.pidfd_open(self.proc.pid, 0)
            self.events.append({"event": "retained-popen-pidfd", "pid": self.proc.pid})
            ready = self.message(3)
            if ready != f"GATE_READY {self.proc.pid} {os.getpid()}\n".encode():
                raise ValueError("gate did not establish parent/limits: " + repr(ready))
            self.before = child_identity(self.proc)
            if self.before["executable_sha256"] != gate_sha:
                raise ValueError("actual gate executable mismatch")
        except BaseException as error:
            if self.ack is not None:
                os.close(self.ack); self.ack = None
            error.owned_cleanup = self.cleanup(None)
            error.owned_events = self.events
            raise
        finally:
            for fd in (gate_fd, executable_fd, ack_read, status_write):
                if fd is not None:
                    os.close(fd)

    def message(self, seconds):
        deadline = time.monotonic() + seconds
        while b"\n" not in self._status_buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.status], [], [], remaining)[0]:
                raise TimeoutError("gate status deadline")
            chunk = os.read(self.status, 4096 - len(self._status_buffer))
            if not chunk:
                if self._status_buffer:
                    raise ValueError("truncated gate status")
                return b""
            self._status_buffer += chunk
            if len(self._status_buffer) >= 4096:
                raise ValueError("gate status limit")
        line, self._status_buffer = self._status_buffer.split(b"\n", 1)
        return line + b"\n"

    def release(self, executable_sha, witness=False):
        if self._released or self.ack is None or self.pidfd is None:
            raise ValueError("startup gate requires a retained fresh parent handle")
        self._released = True
        if os.write(self.ack, b"G") != 1:
            raise OSError("short gate acknowledgement")
        os.close(self.ack); self.ack = None
        self.events.append({"event": "ack-after-retained-pidfd"})
        actual = self.message(3)
        expected = f"WITNESS_EXEC {self.proc.pid} {os.getpid()} 9\n".encode() if witness else b""
        if actual != expected:
            raise ValueError("gate exec failed: " + repr(actual))
        self.after = child_identity(self.proc)
        if self.after["executable_sha256"] != executable_sha or self.after["start_ticks"] != self.before["start_ticks"]:
            raise ValueError("actual executable/incarnation mismatch after gate")
        self.events.append({"event": "actual-exec-bound", "sha256": executable_sha})

    def cleanup(self, qmp, drain=None):
        if self._finished:
            return self.cleanup_result
        result = {"actions": [], "errors": [], "wait": None, "handles_closed": []}
        if self.ack is not None:
            try: os.close(self.ack); self.ack = None; result["handles_closed"].append("ack")
            except OSError as error: result["errors"].append({"phase": "ack-close", "errno": error.errno})
        if self.proc is not None:
            if qmp is not None and self.proc.poll() is None:
                try: qmp.quit(); result["actions"].append("owned-qmp-quit")
                except (OSError, ValueError, TimeoutError) as error: result["errors"].append({"phase": "qmp-quit", "error": str(error)})
            for sig, seconds in ((None, 5), (signal.SIGTERM, 2), (signal.SIGKILL, 3)):
                if self.proc.returncode is not None:
                    break
                if sig is not None:
                    if self.pidfd is None:
                        result["errors"].append({"phase": "signal", "error": "no retained pidfd; no numeric-PID fallback"})
                        break
                    try:
                        signal.pidfd_send_signal(self.pidfd, sig)
                        result["actions"].append("pidfd-" + signal.Signals(sig).name)
                    except ProcessLookupError:
                        result["actions"].append("pidfd-already-exited")
                    except OSError as error:
                        result["errors"].append({"phase": "pidfd-signal", "errno": error.errno})
                deadline = time.monotonic() + seconds
                while self.proc.poll() is None and time.monotonic() < deadline:
                    if drain is not None:
                        try: drain()
                        except OSError as error: result["errors"].append({"phase": "serial-drain", "errno": error.errno}); drain = None
                    select.select([self.pidfd] if self.pidfd is not None else [], [], [], min(0.01, max(0, deadline-time.monotonic())))
                if self.proc.returncode is None:
                    result["actions"].append("wait-timeout-" + str(seconds))
                elif drain is not None:
                    try: drain()
                    except OSError as error: result["errors"].append({"phase": "final-serial-drain", "errno": error.errno})
            result["wait"] = {"reaped": self.proc.returncode is not None, "returncode": self.proc.returncode}
            if self.proc.stdout is not None:
                try:
                    self.proc.stdout.close()
                    result["handles_closed"].append("serial")
                except OSError as error:
                    result["errors"].append({"phase": "serial-close", "errno": error.errno, "error": str(error)})
        for name in ("pidfd", "status"):
            fd = getattr(self, name)
            if fd is not None:
                try: os.close(fd); setattr(self, name, None); result["handles_closed"].append(name)
                except OSError as error: result["errors"].append({"phase": name + "-close", "errno": error.errno})
        if qmp is not None:
            try: qmp.close(); result["handles_closed"].append("qmp")
            except OSError as error: result["errors"].append({"phase": "qmp-close", "errno": error.errno})
        result["verified"] = (self.proc is None or result["wait"]["reaped"]) and not result["errors"]
        result["forced"] = any(a in ("pidfd-SIGTERM", "pidfd-SIGKILL") for a in result["actions"])
        result["wait_timeout"] = any(a.startswith("wait-timeout-") for a in result["actions"])
        self.cleanup_result = result; self._finished = True
        return result


class QMP:
    """Only one socket retained from this owned instance; fixed commands."""
    def __init__(self, path):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(3); self.buffer = b""; self.receipts = []
        try:
            self.socket.connect(path)
            greeting = self._reply(None)
            if "QMP" not in greeting:
                raise ValueError("missing actual QMP greeting")
            self._command("qmp_capabilities", "capabilities")
        except BaseException:
            self.socket.close(); raise

    def _reply(self, wanted):
        deadline = time.monotonic() + 3
        for _ in range(16):
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("QMP response deadline")
                self.socket.settimeout(remaining)
                chunk = self.socket.recv(65536 - len(self.buffer))
                if not chunk: raise ValueError("QMP EOF before response")
                self.buffer += chunk
                if len(self.buffer) >= 65536: raise ValueError("QMP byte limit")
            line, self.buffer = self.buffer.split(b"\n", 1)
            response = f0b._json(line)
            if type(response) is not dict:
                raise ValueError("QMP object required")
            self.receipts.append(response)
            if wanted is None or response.get("id") == wanted:
                return response
        raise ValueError("QMP event limit")

    def _command(self, name, ident):
        self.socket.sendall((json.dumps({"execute": name, "id": ident}) + "\n").encode())
        response = self._reply(ident)
        if "error" in response or "return" not in response:
            raise ValueError("QMP command failed")

    def quit(self): self._command("quit", "quit")
    def close(self): self.socket.close()


def result_state(capture, original_error, cleanup):
    if original_error:
        return original_error["state"]
    if not cleanup.get("verified"):
        return "CLEANUP_UNPROVEN"
    if cleanup.get("forced") or cleanup.get("wait_timeout"):
        return "TIMEOUT"
    # A verified reap/handle cleanup is separate from a normal child exit.
    wait = cleanup.get("wait")
    if type(wait) is not dict or wait.get("reaped") is not True or type(wait.get("returncode")) is not int:
        return "EXIT_UNPROVEN"
    if wait["returncode"] != 0:
        return "GUEST_FAILED"
    return capture["state"] if capture is not None else "BOOT_FAILED"

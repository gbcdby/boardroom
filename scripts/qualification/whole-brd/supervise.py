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
import fcntl
import stat
import subprocess
import time

import f0
import f0b
from transport import QMP, stdio_argv


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


def validate_serial_pipe(fd, device, inode, other_fds):
    if type(fd) is not int or fd < 3 or fd in other_fds:
        raise ValueError("distinct owned serial writer required")
    actual = os.fstat(fd)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    if (not stat.S_ISFIFO(actual.st_mode) or flags & os.O_ACCMODE != os.O_WRONLY
            or (actual.st_dev, actual.st_ino) != (device, inode)):
        raise ValueError("serial writer type/access/identity mismatch")


class OwnedChild:
    """No receipt/PID constructor; always owns the Popen it just created."""
    def __init__(self, gate, gate_sha, executable, executable_sha, argv, env, mode="qemu", deadline=None):
        if mode not in ("qemu", "witness", "pipe-witness") or not argv or argv[0] != executable:
            raise ValueError("fixed gate invocation required")
        self.mode = mode
        self.deadline = deadline
        self.proc = None; self.pidfd = None; self.ack = None; self.status = None; self.serial = None
        self.events = []; self.before = None; self.after = None; self._status_buffer = b""
        self.handle_errors = []
        self._released = False; self._finished = False
        f0._asset_path(gate); f0._asset_path(executable)
        gate_fd = pinned_executable(gate, gate_sha)
        executable_fd = None; ack_read = None; status_write = None; serial_write = None
        primary = None
        try:
            executable_fd = pinned_executable(executable, executable_sha)
            ack_read, self.ack = os.pipe2(os.O_CLOEXEC)
            self.status, status_write = os.pipe2(os.O_CLOEXEC)
            self.serial, serial_write = os.pipe2(os.O_CLOEXEC)
            info = os.fstat(serial_write)
            self.serial_identity = {"device": info.st_dev, "inode": info.st_ino,
                                    "parent_read_fd": self.serial, "inherited_write_fd": serial_write}
            validate_serial_pipe(serial_write, info.st_dev, info.st_ino,
                                 (ack_read, self.ack, self.status, status_write, executable_fd, gate_fd, self.serial))
            self.argv = stdio_argv(argv, serial_write) if mode == "qemu" else list(argv)
            command = [gate, mode, str(os.getpid()), str(ack_read), str(status_write), str(executable_fd), str(gate_fd),
                       str(serial_write), str(info.st_dev), str(info.st_ino), *self.argv]
            self.gate_argv = command
            # Exec gate first; parent obtains Popen/pidfd before ACK. No preexec.
            self.proc = subprocess.Popen(command, executable="/proc/self/fd/" + str(gate_fd),
                                         pass_fds=(ack_read, status_write, executable_fd, gate_fd, serial_write),
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         bufsize=0, env=env, close_fds=True)
            closing = serial_write; serial_write = None
            try: os.close(closing)
            except OSError as error:
                self.handle_errors.append({"phase": "parent-serial-writer-close", "errno": error.errno, "error": str(error)})
                raise
            self.events.append({"event": "parent-serial-writer-closed", "fd": closing})
            self.pidfd = os.pidfd_open(self.proc.pid, 0)
            self.events.append({"event": "retained-popen-pidfd", "pid": self.proc.pid})
            ready = self.message(self.remaining(3))
            expected = f"GATE_READY {self.proc.pid} {os.getpid()} SERIAL {closing} {info.st_dev} {info.st_ino}\n".encode()
            if ready != expected:
                raise ValueError("gate did not establish parent/limits/serial object: " + repr(ready))
            self.before = child_identity(self.proc)
            if self.before["executable_sha256"] != gate_sha:
                raise ValueError("actual gate executable mismatch")
        except BaseException as error:
            primary = error
            error.owned_cleanup = self.cleanup(None, deadline=self.deadline)
            error.owned_events = self.events
            raise
        finally:
            failures = []
            for name, fd in (("gate-anchor", gate_fd), ("executable-anchor", executable_fd),
                             ("child-ack", ack_read), ("child-status", status_write), ("serial-writer", serial_write)):
                if fd is not None:
                    try: os.close(fd)
                    except OSError as error:
                        item = {"phase": name + "-close", "errno": error.errno, "error": str(error)}
                        self.handle_errors.append(item); failures.append(error)
                        if self._finished:
                            self.cleanup_result["errors"].append(item); self.cleanup_result["verified"] = False
            if failures and primary is None:
                error = failures[0]
                error.owned_cleanup = self.cleanup(None, deadline=self.deadline)
                error.owned_events = self.events
                raise error

    def remaining(self, seconds):
        return min(seconds, max(0, self.deadline - time.monotonic())) if self.deadline is not None else seconds

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
        actual = self.message(self.remaining(3))
        expected = f"WITNESS_EXEC {self.proc.pid} {os.getpid()} 9\n".encode() if witness else b""
        if self.mode == "pipe-witness":
            item = self.serial_identity
            expected = (f"PIPE_WITNESS_EXEC {self.proc.pid} {os.getpid()} 9 "
                        f"{item['inherited_write_fd']} {item['device']} {item['inode']}\n").encode()
        if actual != expected:
            raise ValueError("gate exec failed: " + repr(actual))
        self.after = child_identity(self.proc)
        if self.after["executable_sha256"] != executable_sha or self.after["start_ticks"] != self.before["start_ticks"]:
            raise ValueError("actual executable/incarnation mismatch after gate")
        self.events.append({"event": "actual-exec-bound", "sha256": executable_sha})

    def cleanup(self, qmp, pump=None, deadline=None):
        if self._finished:
            return self.cleanup_result
        result = {"actions": [], "errors": list(getattr(self, "handle_errors", ())), "wait": None, "handles_closed": []}
        def error_at(phase, error):
            result["errors"].append({"phase": phase, "error": str(error), "errno": getattr(error, "errno", None)})
        if self.ack is not None:
            try: os.close(self.ack); result["handles_closed"].append("ack")
            except OSError as error: error_at("ack-close", error)
            self.ack = None
        if self.proc is not None:
            if qmp is not None and self.proc.poll() is None:
                try: qmp.quit(); result["actions"].append("owned-qmp-quit")
                except (OSError, ValueError, EOFError) as error: error_at("qmp-quit", error)
            for sig, seconds in ((None, 5), (signal.SIGTERM, 2), (signal.SIGKILL, 3)):
                if self.proc.returncode is not None: break
                if sig is not None:
                    if self.pidfd is None:
                        error_at("signal", ValueError("no retained pidfd; no numeric-PID fallback")); break
                    try:
                        signal.pidfd_send_signal(self.pidfd, sig)
                        result["actions"].append("pidfd-" + signal.Signals(sig).name)
                    except ProcessLookupError: result["actions"].append("pidfd-already-exited")
                    except OSError as error: error_at("pidfd-signal", error)
                end = time.monotonic() + seconds
                if deadline is not None:
                    # The one lightweight witness reserves part of its same
                    # total deadline for TERM/KILL/reap, without adding time.
                    remaining = max(0, deadline - time.monotonic())
                    allowance = remaining if sig == signal.SIGKILL else remaining / 2
                    end = min(end, time.monotonic() + allowance)
                while self.proc.poll() is None and time.monotonic() < end:
                    if pump is not None:
                        try: pump.poll(0)
                        except (OSError, ValueError, EOFError) as error: error_at("pipe-drain", error)
                    select.select([self.pidfd] if self.pidfd is not None else [], [], [], min(0.01, max(0, end-time.monotonic())))
                if self.proc.returncode is None: result["actions"].append("wait-timeout-" + str(seconds))
            result["wait"] = {"reaped": self.proc.returncode is not None, "returncode": self.proc.returncode}
            if pump is not None:
                try: pump.finish(result["wait"]["reaped"])
                except (OSError, ValueError, EOFError) as error: error_at("final-pipe-drain", error)
                result["pipe_eof"] = sorted(pump.eof)
                result["pipe_read_bytes"] = dict(pump.read_counts)
            # Every stream belongs to this Popen; QMP merely borrows it.
            for attribute, name in (("stdin", "qmp-stdin"), ("stdout", "qmp-stdout"), ("stderr", "stderr")):
                stream = getattr(self.proc, attribute, None)
                if stream is not None:
                    try: stream.close(); result["handles_closed"].append(name)
                    except OSError as error: error_at(name + "-close", error)
        for name in ("serial", "pidfd", "status"):
            fd = getattr(self, name, None)
            if fd is not None:
                try: os.close(fd); result["handles_closed"].append(name)
                except OSError as error: error_at(name + "-close", error)
                setattr(self, name, None)
        if qmp is not None:
            try: qmp.close(); result["handles_closed"].append("qmp-borrower")
            except OSError as error: error_at("qmp-close", error)
        result["verified"] = (self.proc is None or result["wait"]["reaped"]) and not result["errors"]
        result["forced"] = any(a in ("pidfd-SIGTERM", "pidfd-SIGKILL") for a in result["actions"])
        result["wait_timeout"] = any(a.startswith("wait-timeout-") for a in result["actions"])
        self.cleanup_result = result; self._finished = True
        return result


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

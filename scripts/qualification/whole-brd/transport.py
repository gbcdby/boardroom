"""Private owned-pipe transport. Importing this module never starts a child.

The literal fdset name is interpreted inside QEMU; it is never a host input
path, and does not change F0's ordinary asset-path rejection rules.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import time

import f0
import f0b


class OutputLimit(ValueError):
    pass


def stdio_argv(original, serial_fd):
    """Private renderer, called with the pipe created by OwnedChild itself."""
    if type(serial_fd) is not int or not 3 <= serial_fd < 2 ** 31:
        raise ValueError("owned non-standard pipe descriptor required")
    if type(original) is not list or not original or any(type(x) is not str for x in original):
        raise ValueError("fixed original argv required")
    if any(x in original for x in ("-add-fd", "-chardev", "-mon")):
        raise ValueError("unexpected existing transport option")
    if original.count("-serial") != 1 or original.count("-qmp") != 1:
        raise ValueError("fixed original transport required")
    serial = original.index("-serial"); qmp = original.index("-qmp")
    if serial + 1 >= len(original) or original[serial + 1] != "stdio" or qmp + 1 >= len(original):
        raise ValueError("fixed original serial transport required")
    if not re.fullmatch(r"unix:/tmp/boardroom-brd-[0-9a-f]{32}/qmp.sock,server=on,wait=off", original[qmp + 1]):
        raise ValueError("fixed original QMP preview required")
    extra = ["-chardev", "stdio,id=control,mux=off,signal=off",
             "-mon", "chardev=control,mode=control", "-add-fd", f"fd={serial_fd},set=1",
             "-chardev", "file,id=serial,path=/dev/fdset/1,append=on", "-serial", "chardev:serial"]
    result = []
    for index, value in enumerate(original):
        if index == serial: result.extend(extra)
        if index not in (serial, serial + 1, qmp, qmp + 1): result.append(value)
    return result


def _identity(value):
    return value.st_dev, value.st_ino


def _close_failed_acquisition(fd, phase, primary):
    """Attempt an acquired FD once, keeping cleanup separate from its cause."""
    errors = []
    try:
        os.close(fd)
    except BaseException as error:
        errors.append({"phase": phase, "type": type(error).__name__,
                       "errno": getattr(error, "errno", None), "error": str(error)})
    primary.artifact_cleanup = {"verified": not errors, "close_attempted": True, "errors": errors}
    return errors


class Artifact:
    def __init__(self, store, name, fd, limit, group):
        self.store = store; self.name = name; self.fd = fd; self.limit = limit; self.group = group
        self.identity = _identity(os.fstat(fd)); self.written = 0; self.observed = 0
        self.digest = hashlib.sha256(); self.closed = False; self.errors = []

    def check(self):
        self.store.check()
        held = os.fstat(self.fd)
        current = os.stat(self.name, dir_fd=self.store.fd, follow_symlinks=False)
        if (_identity(held) != self.identity or _identity(current) != self.identity
                or not stat.S_ISREG(held.st_mode) or held.st_uid != os.getuid()
                or held.st_nlink != 1 or held.st_mode & 0o777 != 0o600
                or held.st_size != self.written):
            raise ValueError("owned artifact identity or size changed: " + self.name)

    def write(self, data):
        if type(data) is not bytes or self.closed:
            raise ValueError("live owned artifact and bytes required")
        self.observed += len(data)
        self.check()
        capacity = min(self.limit - self.written, self.store.limit - self.store.written)
        if self.group:
            budget = self.store.groups[self.group]
            capacity = min(capacity, budget[0] - budget[1])
        prefix = data[:max(0, capacity)]
        offset = 0
        while offset < len(prefix):
            self.check()
            count = os.write(self.fd, prefix[offset:])
            if count <= 0 or count > len(prefix) - offset:
                raise OSError(errno.EIO, "invalid artifact write progress")
            self.digest.update(prefix[offset:offset + count]); offset += count
            self.written += count; self.store.written += count
            if self.group: self.store.groups[self.group][1] += count
        if len(data) > len(prefix):
            raise OutputLimit("owned output hard limit: " + self.name)

    def close(self):
        if self.closed: return self.errors
        try: self.check()
        except (OSError, ValueError) as error:
            self.errors.append({"phase": self.name + "-identity", "error": str(error), "errno": getattr(error, "errno", None)})
        try: os.close(self.fd)
        except OSError as error:
            self.errors.append({"phase": self.name + "-close", "error": str(error), "errno": error.errno})
        self.closed = True  # Never retry an uncertain close / reused FD number.
        return self.errors

    def record(self):
        return {"name": self.name, "bytes": self.written, "observed_bytes": self.observed,
                "sha256": self.digest.hexdigest(), "device": self.identity[0], "inode": self.identity[1],
                "closed": self.closed, "errors": self.errors}


class Artifacts:
    """Only newly created files under this retained exclusive directory FD."""
    def __init__(self, path):
        self.path = Path(f0._asset_path(str(Path(path).absolute())))
        self.path.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.entries = {}; self.closed = False; self.acquisition_errors = []
        self.limit = f0b.LIMITS["evidence_bytes"]; self.written = 0
        self.groups = {"qmp": [f0b.MIB, 0]}; self.close_errors = []
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            self.identity = _identity(os.fstat(self.fd))
            self.check()
        except BaseException as error:
            self.close_errors = _close_failed_acquisition(self.fd, "artifact-directory-initialize-close", error)
            self.closed = True
            raise

    def check(self):
        if self.closed: raise ValueError("artifact directory already closed")
        held = os.fstat(self.fd); current = self.path.lstat()
        if (_identity(held) != self.identity or _identity(current) != self.identity
                or not stat.S_ISDIR(held.st_mode) or held.st_uid != os.getuid()
                or held.st_mode & 0o777 != 0o700):
            raise ValueError("owned artifact directory changed")

    def create(self, name, limit, group=None):
        if (type(name) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", name)
                or type(limit) is not int or not 0 < limit <= self.limit
                or group is not None and group not in self.groups):
            raise ValueError("fixed artifact basename and bound required")
        if name in self.entries:
            raise FileExistsError(errno.EEXIST, "artifact name already claimed", name)
        self.check()
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.fd)
        stream = None
        try:
            stream = Artifact(self, name, fd, limit, group)
            self.entries[name] = stream
            stream.check()
        except BaseException as error:
            errors = _close_failed_acquisition(fd, name + "-initialize-close", error)
            if stream is not None:
                stream.errors.extend(errors)
                stream.closed = True  # An uncertain close must never be retried.
            elif errors:
                self.acquisition_errors.extend(errors)
            raise
        return stream

    def put(self, name, data, limit):
        stream = self.create(name, limit)
        try: stream.write(data)
        finally: stream.close()
        if stream.errors: raise OSError(errno.EIO, "artifact close/identity unproven: " + name)

    def seal(self):
        errors = list(self.acquisition_errors)
        for stream in self.entries.values(): errors.extend(stream.close())
        return errors

    def close(self):
        if self.closed: return self.close_errors
        self.close_errors = self.seal()
        try: self.check()
        except (OSError, ValueError) as error:
            self.close_errors.append({"phase": "artifact-directory-identity", "error": str(error), "errno": getattr(error, "errno", None)})
        try: os.close(self.fd)
        except OSError as error:
            self.close_errors.append({"phase": "artifact-directory-close", "error": str(error), "errno": error.errno})
        self.closed = True
        return self.close_errors


class Pump:
    """Fair bounded reads of three borrowed pipes, and nonblocking QMP writes.

    OwnedChild alone closes these FDs. A failed sink is drained/discarded during
    cleanup so a bounded prefix or protocol failure cannot deadlock the child.
    """
    def __init__(self, owned, artifacts, on_serial=None):
        self.owned = owned; self.on_serial = on_serial
        self.reads = {"qmp": owned.proc.stdout.fileno(), "stderr": owned.proc.stderr.fileno(),
                      "serial": owned.serial}
        self.stdin = owned.proc.stdin.fileno(); self.eof = set(); self.broken = set()
        self.discard = set(); self.errors = []; self.qmp = bytearray(); self.serial = bytearray()
        self.pending = b""; self.read_counts = {k: 0 for k in self.reads}
        self.sinks = {"qmp": artifacts.create("qmp-in.raw", f0b.MIB, "qmp"),
                      "stderr": artifacts.create("stderr.raw", f0b.MIB),
                      "serial": artifacts.create("serial.raw", f0b.LIMITS["serial_bytes"]),
                      "sent": artifacts.create("qmp-out.raw", f0b.MIB, "qmp")}
        for fd in (*self.reads.values(), self.stdin): os.set_blocking(fd, False)

    def _error(self, phase, error):
        self.errors.append({"phase": phase, "type": type(error).__name__,
                            "errno": getattr(error, "errno", None), "error": str(error)})

    def poll(self, seconds=0):
        active = {fd: name for name, fd in self.reads.items() if name not in self.eof | self.broken}
        ready, writable, _ = select.select(list(active), [self.stdin] if self.pending else [], [], max(0, seconds))
        first = None; progress = False
        for fd in ready:
            name = active[fd]
            try: raw = os.read(fd, 65536)
            except BlockingIOError: continue
            except OSError as error:
                self.broken.add(name); self._error(name + "-read", error)
                if first is None: first = error
                continue
            progress = True
            if not raw:
                self.eof.add(name); continue
            self.read_counts[name] += len(raw)
            if name in self.discard: continue
            before = self.sinks[name].written
            try:
                self.sinks[name].write(raw)
                if name == "qmp":
                    self.qmp.extend(raw)
                    # Enforce each frame's bound even when multiple arrive together.
                    if any(len(line) >= 65536 for line in self.qmp.split(b"\n")):
                        raise OutputLimit("QMP frame byte limit")
                elif name == "serial":
                    self.serial.extend(raw)
                    if self.on_serial is not None: self.on_serial(raw)
            except (OSError, ValueError) as error:
                # Retain only the exact prefix actually saved to the owned file.
                if name == "serial" and len(self.serial) == before:
                    self.serial.extend(raw[:self.sinks[name].written - before])
                self.discard.add(name); self._error(name + "-capture", error)
                if first is None: first = error
        if writable and self.pending:
            try:
                # QMP only sends the two tiny fixed commands, never arbitrary bytes.
                count = os.write(self.stdin, self.pending)
                if not 0 < count <= len(self.pending): raise OSError(errno.EIO, "invalid QMP write progress")
                sent, self.pending = self.pending[:count], self.pending[count:]
                self.sinks["sent"].write(sent); progress = True
            except BlockingIOError: pass
            except (OSError, ValueError) as error:
                self.pending = b""; self._error("qmp-write", error)
                if first is None: first = error
        if first is not None: raise first
        return progress

    def finish(self, reaped):
        if not reaped: raise ValueError("final EOF needs an actual reap")
        first = None
        # Readiness after wait is immediate. Never wait for a live fdset writer's
        # EOF before requesting quit, and never add a second cleanup timeout.
        for _ in range(512):
            if self.eof == set(self.reads):
                if first is not None: raise first
                return
            try: progress = self.poll(0)
            except (OSError, ValueError) as error:
                if first is None: first = error
                progress = True
            if not progress or self.broken: break
        if first is not None: raise first
        raise OSError(errno.ENODATA, "final pipe EOF unproven after reap")


class QMP:
    """Borrowed stdio pipes; fixed capabilities/quit only, no socket/getfd."""
    def __init__(self, pump, deadline=None):
        self.pump = pump; self.receipts = []; self.closed = False; self.deadline = deadline
        greeting = self._reply(None, self._deadline())
        if "QMP" not in greeting or "id" in greeting:
            raise ValueError("missing actual QMP greeting")
        self._command("qmp_capabilities", "capabilities")

    def _deadline(self):
        value = time.monotonic() + 3
        return min(value, self.deadline) if self.deadline is not None else value

    def _wait(self, deadline, sending=False):
        # Always drain available original stderr/serial before classifying exit.
        self.pump.poll(0)
        if (not self.pump.pending) if sending else (b"\n" in self.pump.qmp): return
        code = self.pump.owned.proc.poll()
        if code is not None:
            # Exit may race the first readiness observation. Consume bytes
            # already committed before exit, without waiting or another command.
            self.pump.poll(0)
            if (not self.pump.pending) if sending else (b"\n" in self.pump.qmp): return
            raise ChildProcessError(f"owned child exited before QMP response: returncode={code}")
        if "qmp" in self.pump.eof: raise EOFError("QMP EOF before response")
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError("QMP response deadline")
        self.pump.poll(min(0.05, remaining))

    def _reply(self, wanted, deadline):
        for _ in range(16):
            while b"\n" not in self.pump.qmp:
                self._wait(deadline)
            line, remainder = self.pump.qmp.split(b"\n", 1)
            self.pump.qmp[:] = remainder
            if len(line) >= 65536: raise OutputLimit("QMP frame byte limit")
            response = f0b._json(bytes(line))
            if type(response) is not dict: raise ValueError("QMP object required")
            self.receipts.append(response)
            if "event" in response and "id" not in response and wanted is not None:
                continue
            if wanted is None: return response
            if response.get("id") != wanted: raise ValueError("unexpected QMP response id")
            return response
        raise ValueError("QMP event limit")

    def _command(self, name, ident):
        if self.closed or (name, ident) not in (("qmp_capabilities", "capabilities"), ("quit", "quit")):
            raise ValueError("only fixed live QMP commands are supported")
        if self.pump.pending: raise ValueError("overlapping QMP commands")
        deadline = self._deadline()
        self.pump.pending = (json.dumps({"execute": name, "id": ident}) + "\n").encode()
        while self.pump.pending: self._wait(deadline, sending=True)
        response = self._reply(ident, deadline)
        if "error" in response or "return" not in response:
            raise ValueError("QMP command failed")

    def quit(self): self._command("quit", "quit")
    def close(self): self.closed = True  # Borrower: never close OwnedChild's FDs.

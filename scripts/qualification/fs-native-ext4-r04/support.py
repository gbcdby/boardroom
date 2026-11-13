"""#152 资格 harness 公共边界；R04 fix1 对已审复用件的有界修正。
修复 spawn 后异常收束和 owned tree 交接；不继承其它 profile、实验或 verdict。
"""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time
MAX_EVIDENCE = 16 * 1024 * 1024
BUDGETS = {"fixture_seconds": 300, "stage_seconds": 60}
CAPS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
class Stop(Exception):
    def __init__(self, reason: str, status: str = "BLOCKED"):
        super().__init__(reason)
        self.status = status


@contextlib.contextmanager
def deferred_raising_signals():
    """只暂缓会抛异常的 Python handler，不让 child 继承 blocked signal mask。

    Popen 返回/登记和 stop/reap 的短临界区结束后，由调用者交还原 handler。
    默认和 ignore 行为不改；实际 harness 已安装 Stop 型取消/期限 handler。
    """
    handlers = {}; pending = []
    def record(signum, frame):
        pending.append((handlers[signum], signum, frame))
    try:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM):
            handler = signal.getsignal(sig)
            if callable(handler):
                handlers[sig] = handler
                signal.signal(sig, record)
        yield pending
    finally:
        for sig, handler in handlers.items(): signal.signal(sig, handler)


@contextlib.contextmanager
def alarm(seconds: float, reason: str):
    """阶段上限也覆盖 root 自己的目录读取/fsync，不仅覆盖 subprocess。"""
    def expired(_signum, _frame):
        raise Stop(reason, "INCONCLUSIVE")
    previous = signal.signal(signal.SIGALRM, expired)
    old_timer = signal.setitimer(signal.ITIMER_REAL, max(0.001, seconds))
    started = time.monotonic()
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        if old_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.001, old_timer[0] - (time.monotonic() - started)), old_timer[1])


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def read_small(path: Path, limit: int = MAX_EVIDENCE) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise Stop(f"不是有界单链接普通文件: {path}")
        data = bytearray()
        while True:
            part = os.read(fd, min(65536, limit + 1 - len(data)))
            if not part:
                break
            data.extend(part)
            if len(data) > limit:
                raise Stop(f"读取超出预算: {path}")
        return bytes(data)
    finally:
        os.close(fd)


def canonical(path: Path, absent_leaf: bool = False) -> Path:
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise Stop("路径必须是规范绝对路径")
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if absent_leaf and index == len(path.parts) - 2:
                return path
            raise Stop(f"路径父目录不存在: {current}") from None
        if stat.S_ISLNK(info.st_mode):
            raise Stop(f"拒绝 symlink 路径: {current}")
    return path


def write_file(path: Path, data: bytes, mode: int = 0o644) -> None:
    if len(data) > MAX_EVIDENCE:
        raise Stop("单个证据文件超出预算", "INCONCLUSIVE")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, mode)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
            raise Stop("证据目标不是单链接普通文件")
        os.ftruncate(fd, 0)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


class Evidence:
    def __init__(self, path: Path):
        self.path = path
        path.mkdir(mode=0o755, exist_ok=False)
        self.children: dict[int, subprocess.Popen] = {}
        self.pending_receipts: list[dict] = []
        self.deadline = time.monotonic() + BUDGETS["fixture_seconds"]
        self.action_deadline = self.deadline - 30  # 300 秒总预算内留 30 秒普通清理。
        self.stage_deadline = self.action_deadline
        self.cancelled = False
        self.event("start", pid=os.getpid())

    def file(self, name: str, value, raw: bool = False) -> Path:
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise Stop("无效证据相对路径")
        destination = self.path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        canonical(destination.parent)
        write_file(destination, value if raw else encoded(value))
        return destination

    def event(self, kind: str, **fields) -> None:
        data = encoded({"event": kind, "monotonic": time.monotonic(), **fields})
        # JSONL 为单行，避免把漂亮打印的 JSON 当作多个事件。
        data = (json.dumps(json.loads(data), ensure_ascii=False, sort_keys=True) + "\n").encode()
        fd = os.open(self.path / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND |
                     os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o644)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size + len(data) > MAX_EVIDENCE:
                raise Stop("事件日志目标或大小不符合范围", "INCONCLUSIVE")
            os.write(fd, data)
        finally:
            os.close(fd)

    def remaining(self, maximum: float) -> float:
        available = min(self.action_deadline, self.stage_deadline) - time.monotonic()
        if self.cancelled or available <= 0:
            raise Stop("取消或阶段/fixture 期限已到", "INCONCLUSIVE")
        return min(maximum, available)

    @contextlib.contextmanager
    def phase(self, name: str, seconds: float | None = None):
        old = self.stage_deadline
        limit = BUDGETS["stage_seconds"] if seconds is None else min(seconds, BUDGETS["stage_seconds"])
        self.stage_deadline = min(old, self.action_deadline, time.monotonic() + limit)
        try:
            with alarm(self.stage_deadline - time.monotonic(), f"阶段期限已到: {name}"):
                self.event("phase-start", phase=name, deadline=self.stage_deadline)
                self.remaining(1)
                yield
                self.remaining(1)
        finally:
            ended_deadline = self.stage_deadline
            self.stage_deadline = old
            self.event("phase-end", phase=name, active_deadline=ended_deadline)

    def flush_pending_receipts(self):
        """保存实际终止或未决状态及原始字节；迟到回执绝不重新送入采样。"""
        while self.pending_receipts:
            receipt = self.pending_receipts[0]
            label = receipt["label"]
            self.file(f"commands/{label}.stdout", receipt["stdout"], raw=True)
            self.file(f"commands/{label}.stderr", receipt["stderr"], raw=True)
            self.file(f"commands/{label}.receipt.json", {k:v for k,v in receipt.items() if k not in ("stdout","stderr")})
            self.event("deferred-command-receipt", label=label, pid=receipt["pid"],
                       returncode=receipt["returncode"], rejected_for_sampling=True,
                       reaped=receipt["reaped"], output_complete=receipt["output_complete"],
                       call_error=receipt["call_error"])
            self.pending_receipts.pop(0)

    def call(self, label: str, argv: list[str], seconds: float = 3, cleanup: bool = False):
        timeout = max(0.01, min(seconds, self.deadline - time.monotonic())) if cleanup else self.remaining(seconds)
        if cleanup and time.monotonic() >= self.deadline:
            raise Stop("清理期限已到；保留未知资源", "INCONCLUSIVE")
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
        proc = None; stdout = stderr = b""; output_complete = False
        primary = None; primary_tb = None; phase = "spawn"; secondary = []
        try:
            with deferred_raising_signals() as pending:
                proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=True, env=env)
                self.children[proc.pid] = proc
            for handler, sig, frame in pending: handler(sig, frame)
            phase = "child-start-receipt"
            self.event("child-start", label=label, pid=proc.pid, argv=argv, timeout_seconds=timeout)
            phase = "communicate"
            stdout, stderr = proc.communicate(timeout=timeout)
            output_complete = True
        except BaseException as error:
            primary, primary_tb = error, error.__traceback__
            if isinstance(error, subprocess.TimeoutExpired):
                stdout, stderr = error.output or b"", error.stderr or b""
        finally:
            if proc is not None:
                try:
                    with deferred_raising_signals() as pending:
                        if proc.poll() is None:
                            grace = min(30, max(0, self.deadline-time.monotonic())) if label == "namespace" else 0.5
                            stop_child(proc, grace=0 if isinstance(primary, subprocess.TimeoutExpired) else grace)
                        if proc.poll() is None:
                            raise Stop("自有 child 尚未证实终止；保留 registry", "INCONCLUSIVE")
                        if not output_complete:
                            stdout, stderr = proc.communicate(timeout=0.5)
                            output_complete = True
                        # wait/poll/communicate has actually reaped the child; no registry-only cleanup.
                        self.children.pop(proc.pid, None)
                    for handler, sig, frame in pending: handler(sig, frame)
                except BaseException as error:
                    secondary.append({"phase":"stop-reap", "type":type(error).__name__, "reason":str(error)})
                    if primary is None: primary, primary_tb = error, error.__traceback__
        if proc is None:
            if primary is not None: raise primary.with_traceback(primary_tb)
            raise Stop("Popen 未产生可归属对象", "INCONCLUSIVE")
        reaped = proc.poll() is not None
        receipt = {"label":label, "argv":argv, "stdout":stdout, "stderr":stderr,
                   "pid":proc.pid, "returncode":proc.returncode, "reaped":reaped,
                   "output_complete":output_complete, "timed_out":isinstance(primary, subprocess.TimeoutExpired),
                   "call_error":None if primary is None else {"phase":phase,"type":type(primary).__name__,"reason":str(primary)},
                   "cleanup_errors":secondary}
        self.pending_receipts.append(receipt)
        try:
            self.file(f"commands/{label}.stdout", stdout, raw=True)
            self.file(f"commands/{label}.stderr", stderr, raw=True)
            self.file(f"commands/{label}.receipt.json", {k:v for k,v in receipt.items() if k not in ("stdout","stderr")})
            self.event("child-exited" if reaped else "child-unresolved", label=label, pid=proc.pid,
                       returncode=proc.returncode, timed_out=receipt["timed_out"], reaped=reaped,
                       output_complete=output_complete, call_error=receipt["call_error"])
            if primary is None:
                if cleanup:
                    if time.monotonic() >= self.deadline: raise Stop("清理回执逾期", "INCONCLUSIVE")
                else: self.remaining(1)
            self.pending_receipts.remove(receipt)
        except BaseException as error:
            receipt["receipt_error"] = {"type":type(error).__name__,"reason":str(error)}
            if primary is None:
                primary, primary_tb = error, error.__traceback__
                receipt["call_error"]={"phase":"final-receipt", "type":type(error).__name__, "reason":str(error)}
            else: primary.add_note("另有回执错误："+repr(error))
        if primary is not None:
            for error in secondary: primary.add_note("真实收束记录："+str(error))
            if isinstance(primary, subprocess.TimeoutExpired):
                raise Stop(f"进程超时: {label}", "INCONCLUSIVE") from primary
            raise primary.with_traceback(primary_tb)
        return proc.returncode, stdout, stderr


def stop_child(proc: subprocess.Popen, grace=0.5) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(timeout=0.5)
    except ProcessLookupError:
        proc.wait(timeout=0.5)


def identity() -> dict:
    values = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in (*CAPS, "Uid", "Gid", "NoNewPrivs", "Groups"):
            values[key] = value.strip()
    return values


def unprivileged(uid: int, gid: int) -> dict:
    result = identity()
    good = uid > 0 and gid > 0 and all(int(x) == uid for x in result["Uid"].split())
    good = good and all(int(x) == gid for x in result["Gid"].split())
    good = good and not result["Groups"] and result["NoNewPrivs"] == "1"
    good = good and all(int(result[key], 16) == 0 for key in CAPS)
    if not good:
        raise Stop("实际 child UID/GID/capabilities/groups/NNP 不符合合同")
    return result


def drop(uid: int, gid: int, argv: list[str]) -> list[str]:
    return ["setpriv", "--reuid", str(uid), "--regid", str(gid), "--clear-groups",
            "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", *argv]


def mountinfo() -> list[dict]:
    def unescape(value):
        return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)
    result = []
    for raw in Path("/proc/self/mountinfo").read_text().splitlines():
        left, right = raw.split(" - ", 1)
        fields, tail = left.split(), right.split()
        result.append({"id": fields[0], "parent": fields[1], "device": fields[2],
                       "root": unescape(fields[3]), "point": unescape(fields[4]),
                       "mount_options": fields[5].split(","), "optional": fields[6:],
                       "type": tail[0], "source": unescape(tail[1]),
                       "super_options": unescape(tail[2]).split(","), "raw": raw})
    return result


def containing(path: Path) -> dict:
    entries = [entry for entry in mountinfo()
               if path == Path(entry["point"]) or Path(entry["point"]) in path.parents]
    if not entries:
        raise Stop("无法确定实际 backing mount")
    return max(entries, key=lambda entry: len(entry["point"]))


def stat_fields(value: os.stat_result) -> dict:
    return {"dev": value.st_dev, "ino": value.st_ino, "mode": value.st_mode,
            "uid": value.st_uid, "gid": value.st_gid, "nlink": value.st_nlink,
            "size": value.st_size, "rdev": value.st_rdev, "blocks": value.st_blocks,
            "atime_ns": value.st_atime_ns, "mtime_ns": value.st_mtime_ns, "ctime_ns": value.st_ctime_ns}


def diff_entries(before: dict, after: dict) -> dict:
    changes, atime = [], []
    for path in sorted(before.keys() | after.keys()):
        a, b = before.get(path), after.get(path)
        if a is None or b is None:
            changes.append({"path": path, "before": a, "after": b})
            continue
        for key in sorted(a.keys() | b.keys()):
            if a.get(key) != b.get(key):
                item = {"path": path, "field": key, "before": a.get(key), "after": b.get(key)}
                (atime if key == "atime_ns" else changes).append(item)
    return {"non_atime": changes, "atime_only": atime}


def remove_owned_tree(path: Path, expected_dev: int, maximum=512) -> None:
    """FD 相对、NOFOLLOW、同 device；未知 symlink/mount 保留，不跨它们递归。"""
    if any(Path(entry["point"]) == path or path in Path(entry["point"]).parents for entry in mountinfo()):
        raise Stop("删除范围仍包含 mount；保留", "INCONCLUSIVE")
    count = 0

    def walk(parent_fd: int, name: str, depth: int):
        nonlocal count
        count += 1
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if count > maximum or depth > 8 or info.st_dev != expected_dev or stat.S_ISLNK(info.st_mode):
            raise Stop("清理遇到超预算/未知边界，保留", "INCONCLUSIVE")
        if stat.S_ISDIR(info.st_mode):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            try:
                with os.scandir(fd) as iterator:
                    names = sorted(entry.name for entry in iterator)
                for child_name in names:
                    walk(fd, child_name, depth + 1)
            finally:
                os.close(fd)
            os.rmdir(name, dir_fd=parent_fd)
        else:
            os.unlink(name, dir_fd=parent_fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        walk(parent, path.name, 0)
    finally:
        os.close(parent)


def verify_marker(root: Path, token: str) -> dict:
    marker = json.loads(read_small(root / ".fsqual-marker.json", 8192))
    info = root.stat(follow_symlinks=False)
    if marker["token"] != token or marker["root"] != str(root) or [info.st_dev, info.st_ino] != marker["root_identity"]:
        raise Stop("marker/root 身份变化；拒绝操作")
    return marker


def handoff_owned_tree(root: Path, token: str, uid: int, gid: int, resources: dict) -> dict:
    """Only release this marker-bound tree after every owned external resource is gone.

    Validate the whole bounded tree before changing any mode or owner. Keep NOFOLLOW
    FDs for the validated objects; never traverse a symlink, mount, or hardlink alias.
    Unknown resources and failed/partial handoffs remain retained, not cleanup PASS.
    """
    if (resources.get("status") != "PASS" or resources.get("children_reaped") is not True or
        any(resources.get(k) != [] for k in ("owned_mounts_remaining", "owned_loops_remaining",
                                              "unknown_attach_images", "errors"))):
        raise Stop("owned 资源尚未全部证实释放；禁止交接", "INCONCLUSIVE")
    canonical(root); marker = verify_marker(root, token)
    if uid <= 0 or gid <= 0 or (uid, gid) != (marker["uid"], marker["gid"]) or os.geteuid() not in (0, uid):
        raise Stop("交接 UID/GID 与实际 marker 不符", "INCONCLUSIVE")
    expected_dev, expected_ino = marker["root_identity"]
    nodes = []; fds = []

    def no_mounts():
        if any(Path(r["point"]) == root or root in Path(r["point"]).parents for r in mountinfo()):
            raise Stop("owned tree 仍包含 mount；禁止交接", "INCONCLUSIVE")

    def inspect(parent_fd, name, relative, depth):
        if len(nodes) >= 512 or depth > 8:
            raise Stop("交接超出 owned tree 预算", "INCONCLUSIVE")
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        directory = stat.S_ISDIR(info.st_mode)
        if (info.st_dev != expected_dev or info.st_uid not in (os.geteuid(), uid) or
            not (directory or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1))):
            raise Stop("交接遇到未知 owner/device/type/link 边界", "INCONCLUSIVE")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
        fd = os.open(name, flags | (os.O_DIRECTORY if directory else 0), dir_fd=parent_fd); fds.append(fd)
        actual = os.fstat(fd)
        if (actual.st_dev, actual.st_ino, actual.st_mode, actual.st_nlink, actual.st_uid, actual.st_gid) != (
            info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid, info.st_gid):
            raise Stop("交接打开期间对象变化", "INCONCLUSIVE")
        row = {"path": relative, "parent_fd": parent_fd, "name": name, "fd": fd,
               "dev": info.st_dev, "ino": info.st_ino, "kind": "directory" if directory else "file",
               "original_mode": stat.S_IMODE(info.st_mode), "original_uid": info.st_uid, "original_gid": info.st_gid}
        nodes.append(row)
        if directory:
            row["names"] = sorted(os.listdir(fd))
            for child in row["names"]:
                inspect(fd, child, child if relative == "." else relative + "/" + child, depth + 1)

    try:
        no_mounts()
        parent = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC); fds.append(parent)
        inspect(parent, root.name, ".", 0)
        if (nodes[0]["dev"], nodes[0]["ino"]) != (expected_dev, expected_ino):
            raise Stop("交接 root FD 与 marker 不符", "INCONCLUSIVE")
        no_mounts(); verify_marker(root, token)
        # All validation precedes any modification, including a later symlink failure.
        for row in nodes:
            current = os.stat(row["name"], dir_fd=row["parent_fd"], follow_symlinks=False)
            if (current.st_dev, current.st_ino, current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) != (
                row["dev"], row["ino"], row["original_uid"], row["original_gid"], row["original_mode"]):
                raise Stop("交接前对象/权限变化", "INCONCLUSIVE")
            if row["kind"] == "directory" and sorted(os.listdir(row["fd"])) != row["names"]:
                raise Stop("交接前目录内容变化", "INCONCLUSIVE")
        entries = []
        for row in reversed(nodes):
            fd = row["fd"]
            current = os.stat(row["name"], dir_fd=row["parent_fd"], follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (row["dev"], row["ino"]):
                raise Stop("交接中对象路径变化", "INCONCLUSIVE")
            os.fchown(fd, uid, gid)
            os.fchmod(fd, 0o700 if row["kind"] == "directory" else (row["original_mode"] & 0o777) | 0o400)
            actual = os.fstat(fd)
            if (actual.st_dev, actual.st_ino, actual.st_uid, actual.st_gid) != (row["dev"], row["ino"], uid, gid):
                raise Stop("交接后实际所有权未成立", "INCONCLUSIVE")
            entries.append({k: row[k] for k in ("path", "dev", "ino", "kind")} |
                           {"uid": actual.st_uid, "gid": actual.st_gid, "mode": stat.S_IMODE(actual.st_mode)})
        no_mounts(); verify_marker(root, token)
        return {"status": "PASS", "root_identity": [expected_dev, expected_ino],
                "uid": uid, "gid": gid, "entries": sorted(entries, key=lambda r: r["path"])}
    finally:
        for fd in reversed(fds): os.close(fd)

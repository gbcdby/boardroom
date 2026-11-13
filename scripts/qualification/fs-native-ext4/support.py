"""#152 资格 harness 公共边界；只读派生自 overlay 固定 4f451623 的 run.py。
复用 Evidence/超时/reap/身份/路径/同设备清理，不继承其 profile、实验或 verdict。
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
        """独立收尾只保存已结束进程的原始字节，绝不把迟到结果重新送入采样。"""
        while self.pending_receipts:
            receipt = self.pending_receipts[0]
            label = receipt["label"]
            self.file(f"commands/{label}.stdout", receipt["stdout"], raw=True)
            self.file(f"commands/{label}.stderr", receipt["stderr"], raw=True)
            self.event("deferred-command-receipt", label=label, pid=receipt["pid"],
                       returncode=receipt["returncode"], rejected_for_sampling=True, reaped=True)
            self.pending_receipts.pop(0)

    def call(self, label: str, argv: list[str], seconds: float = 3, cleanup: bool = False):
        timeout = max(0.01, min(seconds, self.deadline - time.monotonic())) if cleanup else self.remaining(seconds)
        if cleanup and time.monotonic() >= self.deadline:
            raise Stop("清理期限已到；保留未知资源", "INCONCLUSIVE")
        env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "PYTHONDONTWRITEBYTECODE": "1"}
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True, env=env)
        self.children[proc.pid] = proc
        self.event("child-start", label=label, pid=proc.pid, argv=argv, timeout_seconds=timeout)
        timed_out = False
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except (subprocess.TimeoutExpired, Stop, KeyboardInterrupt) as error:
            timed_out = True
            grace = min(30, max(0, self.deadline - time.monotonic())) if label == "namespace" else 0
            stop_child(proc, grace=0 if isinstance(error, subprocess.TimeoutExpired) else grace)
            stdout, stderr = proc.communicate()
        finally:
            if proc.poll() is None:
                stop_child(proc)
            self.children.pop(proc.pid, None)
        receipt = {"label": label, "stdout": stdout, "stderr": stderr,
                   "pid": proc.pid, "returncode": proc.returncode}
        self.pending_receipts.append(receipt)
        self.file(f"commands/{label}.stdout", stdout, raw=True)
        self.file(f"commands/{label}.stderr", stderr, raw=True)
        self.event("child-exited", label=label, pid=proc.pid, returncode=proc.returncode,
                   timed_out=timed_out, reaped=proc.poll() is not None)
        if timed_out:
            raise Stop(f"进程超时/取消: {label}", "INCONCLUSIVE")
        if cleanup:
            if time.monotonic() >= self.deadline:
                raise Stop("清理命令回执在 fixture 期限后完成", "INCONCLUSIVE")
        else:
            # 子进程成功退出也不能豁免 stdout/stderr/fsync/处理的活动期限。
            self.remaining(1)
        self.pending_receipts.remove(receipt)
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

#!/usr/bin/env python3
"""#152 有限资格实验。仅 hosted-linux 入口可启动独立 private mount namespace。

源码不修改生产 provider；绿色 CI 只表示实验完成，资格状态以 summary.json 为准。
所有 root 写入限制在带本次 marker 的新目录；provider 和真实重建均以原非零 UID 运行。
"""
from __future__ import annotations

import argparse
import contextlib
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
FILES = (".github/workflows/fs-identity-qualification.yml",) + tuple(
    "scripts/qualification/fs-identity/" + name for name in ("probe.c", "run.py", "profile.json")
)
OPTIONS = ("rw", "index=off", "metacopy=off", "nfs_export=off", "uuid=on",
           "redirect_dir=nofollow", "xino=off")
BUDGETS = {"fixture_bytes": 1048576, "objects_per_group": 16, "simultaneous_overlays": 2,
           "inode_attempts": 32, "inode_seconds": 2, "compile_seconds": 10,
           "process_seconds": 3, "stage_seconds": 60, "fixture_seconds": 300,
           "job_minutes": 10, "remounts": 1}
# lower-dir 同时是 absent root 的最近 existingAncestor；不预建 missing/deeper。
CASES = (("lower-file", "lower-file", "file"), ("lower-dir", "lower-dir", "directory"),
         ("upper-file", "upper-file", "file"), ("upper-dir", "upper-dir", "directory"),
         ("merged-dir", "merged-dir", "directory"), ("mount-root", ".", "directory"))
CHECKS = ("profile_confirmation", "privilege_separation", "same_fd_codec", "object_matrix", "observer_purity",
          "cold_backing_nonmutation", "unchanged_reopen", "same_object_mutations",
          "real_recreation", "inode_reuse", "persisted_new_process", "same_source_remount")
CAPS = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")
CANARY = "trusted.boardroom.fsqual"
PAYLOAD = b"boardroom #152 finite fixture\n"
MAX_EVIDENCE = 16 * 1024 * 1024
NOT_RUN = ("OS reboot", "backing device remount", "production Node-API", "capture/canonical Fs/parser/service",
           "old receipts rejection", "restore content closure", "original product failure retest", "PostgreSQL",
           "full product CI", "Darwin/APFS")


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


def backing_snapshot(group: Path, ev: Evidence) -> dict:
    entries, errors, self_changes = {}, [], []
    total_bytes = 0
    expected_dev = group.stat().st_dev

    def visit(path: Path, key: str, recurse: bool):
        nonlocal total_bytes
        ev.remaining(1)
        # merged 的底层空 mountpoint 不打开，仍占用一个 fixture 对象名额。
        if len(entries) + 1 >= BUDGETS["objects_per_group"]:
            raise Stop("backing 对象超过每组 16 上限", "INCONCLUSIVE")
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME | os.O_CLOEXEC)
        except OSError as error:
            raise Stop(f"backing 完整观察受阻: {key}, errno={error.errno}", "INCONCLUSIVE") from None
        try:
            first = os.fstat(fd)
            if first.st_dev != expected_dev or not (stat.S_ISREG(first.st_mode) or stat.S_ISDIR(first.st_mode)):
                raise Stop("backing 观察遇到跨 mount 或未知对象", "INCONCLUSIVE")
            record = stat_fields(first)
            attrs = {}
            try:
                for name in sorted(os.listxattr(fd)):
                    value = os.getxattr(fd, name)
                    total_bytes += len(value)
                    if len(value) > 65536:
                        raise Stop("xattr 超过有限观察预算", "INCONCLUSIVE")
                    attrs[name] = value.hex()
            except OSError as error:
                errors.append({"path": key, "operation": "xattr", "errno": error.errno})
            record["xattrs"] = attrs
            if stat.S_ISREG(first.st_mode):
                if first.st_nlink != 1 or first.st_size > BUDGETS["fixture_bytes"]:
                    raise Stop("backing 文件越过有限预算/单链接边界", "INCONCLUSIVE")
                digest = hashlib.sha256()
                while True:
                    data = os.read(fd, 65536)
                    if not data:
                        break
                    total_bytes += len(data)
                    if total_bytes > BUDGETS["fixture_bytes"]:
                        raise Stop("backing 字节超过 1 MiB", "INCONCLUSIVE")
                    digest.update(data)
                record["sha256"] = digest.hexdigest()
            entries[key] = record
            if recurse and stat.S_ISDIR(first.st_mode):
                with os.scandir(fd) as iterator:
                    names = sorted(entry.name for entry in iterator)
                for name in names:
                    visit(path / name, key + "/" + name, True)
            last = stat_fields(os.fstat(fd))
            changes = diff_entries({key: stat_fields(first)}, {key: last})
            if changes["non_atime"] or changes["atime_only"]:
                self_changes.append(changes)
        finally:
            os.close(fd)

    # 不 enumerate/打开 merged；只取 backing 的共同父目录元数据。
    visit(group, ".", False)
    for name in ("lower", "upper", "work"):
        visit(group / name, name, True)
    observable = all(entries[name]["xattrs"].get(CANARY) == b"observer-visible".hex()
                     for name in ("lower", "upper", "work"))
    return {"entries": entries, "bytes_observed": total_bytes, "objects_observed": len(entries),
            "fixture_objects_including_unopened_mountpoint": len(entries) + 1,
            "trusted_xattrs_observable": observable, "errors": errors, "observer_self_changes": self_changes,
            "merged_not_opened": True, "atime_policy": "O_NOATIME; atime 差异独立保存"}


def snapshots(root: Path, stage: str, ev: Evidence) -> dict:
    result = {}
    for group in ("control", "provider"):
        first = backing_snapshot(root / group, ev)
        second = backing_snapshot(root / group, ev)
        delta = diff_entries(first["entries"], second["entries"])
        result[group] = second
        ev.file(f"snapshots/{stage}-{group}-first.json", first)
        ev.file(f"snapshots/{stage}-{group}-observer-repeat.json", second)
        ev.file(f"diffs/{stage}-{group}-observer-only.json", delta)
        result[group]["observer_repeat_diff"] = delta
    if sum(item["bytes_observed"] for item in result.values()) > BUDGETS["fixture_bytes"]:
        raise Stop("两组累计 fixture 字节超过 1 MiB", "INCONCLUSIVE")
    return result


def validate_native(record: dict) -> tuple[str, str]:
    """只接受整个 opaque handle；绝不按内部位、stat 或请求数据补身份。"""
    try:
        if any(type(record[key]) is not int for key in ("before_rc", "after_rc", "fs_rc")):
            return "INCONCLUSIVE", "syscall rc 必须是整数"
        if record["before_rc"] != 0 or record["after_rc"] != 0:
            return "BLOCKED", "same-FD fstat 不可用"
        before, after = record["before"], record["after"]
        if {k: v for k, v in before.items() if k != "atime"} != {k: v for k, v in after.items() if k != "atime"}:
            return "FAIL", "native 同 FD 读取期间 metadata 改变"
        fsuuid, fid, mount = record["fsuuid"], record["fid_unique"], record["statx_unique"]
        if any(type(item["rc"]) is not int for item in (fsuuid, fid, mount)):
            return "INCONCLUSIVE", "原生身份 syscall rc 必须是整数"
        if record["fs_rc"] != 0 or record["fs_magic"] != "794c7630":
            return "BLOCKED", "不是可确认的 overlay FD"
        if fsuuid["rc"] != 0 or type(fsuuid["length"]) is not int or fsuuid["length"] != 16:
            return "BLOCKED", "GETFSUUID 不可用或 UUID 长度不符"
        if not re.fullmatch(r"[0-9a-f]{32}", fsuuid["hex"]) or fsuuid["hex"] == "0" * 32:
            return "BLOCKED", "UUID 不符合非零严格 codec"
        if fid["rc"] != 0 or type(fid["handle_type"]) is not int or fid["handle_type"] != 248:
            return "BLOCKED", "FID type 不受该 profile 支持"
        if type(fid["handle_bytes"]) is not int or fid["handle_bytes"] != 32 or not re.fullmatch(r"[0-9a-f]{64}", fid["hex"]):
            return "BLOCKED", "FID length/hex 不受该 profile 支持"
        if mount["rc"] != 0 or type(mount["mask"]) is not int or not mount["mask"] & 0x4000:
            return "BLOCKED", "unique mount mask 不可用"
        if not re.fullmatch(r"[1-9][0-9]*", mount["mount_id"]) or int(mount["mount_id"]) >= 2**64:
            return "BLOCKED", "unique mount ID 不是有效 64-bit 槽"
        if mount["mount_id"] != fid["mount_id"]:
            return "FAIL", "同 FD 的 unique mount ID 不一致"
        return "PASS", "实际同 FD UUID/FID 与 unique mount 一致"
    except (KeyError, TypeError, ValueError):
        return "INCONCLUSIVE", "原生输出不符合实验协议"


def aggregate(statuses) -> str:
    values = list(statuses)
    for status in ("FAIL", "BLOCKED", "INCONCLUSIVE"):
        if status in values:
            return status
    return "PASS" if values and all(x == "PASS" for x in values) else "NOT_RUN"


def witness(record: dict) -> tuple:
    return (record["fsuuid"]["hex"], record["fid_unique"]["handle_type"],
            record["fid_unique"]["handle_bytes"], record["fid_unique"]["hex"])


def selected_cases(case=None) -> tuple:
    result = tuple(item for item in CASES if case is None or item[0] == case)
    if not result:
        raise Stop("未知实验对象", "INCONCLUSIVE")
    return result


def validate_read(record: dict, kind: str) -> tuple[str, str]:
    """lookup 只核实际 open 后的完整 fstat；不要求或调用 provider 接口。"""
    try:
        required = {"dev", "ino", "mode", "nlink", "size", "uid", "gid", "atime", "mtime", "ctime"}
        if any(type(record[key]) is not int for key in ("before_rc", "after_rc")):
            return "INCONCLUSIVE", "fstat 返回值不是整数"
        if record["before_rc"] != 0 or record["after_rc"] != 0:
            return "BLOCKED", "open 后未完成两次成功 fstat"
        before, after = record["before"], record["after"]
        if not isinstance(before, dict) or not isinstance(after, dict) or \
           set(before) != required or set(after) != required:
            return "INCONCLUSIVE", "fstat metadata 不完整"
        for value in (before, after):
            if any(not isinstance(value[key], str) or not re.fullmatch(r"0|[1-9][0-9]*", value[key])
                   for key in ("dev", "ino", "mode", "nlink", "size")):
                return "INCONCLUSIVE", "fstat 整数字段无效"
            if any(type(value[key]) is not int or value[key] <= 0 for key in ("uid", "gid")):
                return "INCONCLUSIVE", "fstat owner/group 无效"
            for key in ("atime", "mtime", "ctime"):
                timestamp = value[key]
                if not isinstance(timestamp, list) or len(timestamp) != 2 or \
                   not all(isinstance(part, str) for part in timestamp) or \
                   not re.fullmatch(r"0|-?[1-9][0-9]*", timestamp[0]) or \
                   not re.fullmatch(r"0|[1-9][0-9]*", timestamp[1]) or int(timestamp[1]) >= 1000000000:
                    return "INCONCLUSIVE", "fstat 时间字段无效"
            file_mode = int(value["mode"])
            if (kind == "file" and (not stat.S_ISREG(file_mode) or int(value["nlink"]) != 1)) or \
               (kind == "directory" and not stat.S_ISDIR(file_mode)):
                return "FAIL", "实际对象类型/单链接边界不符"
        if {key: value for key, value in before.items() if key != "atime"} != \
           {key: value for key, value in after.items() if key != "atime"}:
            return "FAIL", "同 FD 读取期间 metadata 改变"
        return "PASS", "实际对象类型与同 FD fstat 完整稳定"
    except (KeyError, TypeError, ValueError):
        return "INCONCLUSIVE", "读取记录不符合实验协议"


def validate_batch(batch: dict, mode="provider", cases=CASES) -> dict:
    """命令回执与每个预期对象一起验；iteration0 不能代表一个完整 provider 批次。"""
    expected = {name: kind for name, _, kind in cases}
    result = {"status": "INCONCLUSIVE", "identity_status": "INCONCLUSIVE", "objects": {}, "reasons": []}
    records = batch.get("records") if isinstance(batch, dict) else None
    if not expected or mode not in ("lookup", "provider") or not isinstance(batch, dict) or \
       batch.get("mode") != mode or type(batch.get("returncode")) is not int or not isinstance(records, list):
        result["reasons"].append("批次 mode/returncode/records 协议不完整")
        return result
    rc = batch["returncode"]
    command_status = "PASS" if rc == 0 else "BLOCKED" if rc in (69, 77) else "FAIL" if rc == 70 else "INCONCLUSIVE"
    statuses = [command_status]
    if rc:
        result["reasons"].append(f"实际命令退出 rc={rc}")
    if any(not isinstance(record, dict) for record in records):
        result["reasons"].append("批次包含非对象记录")
        return result
    identities = [record for record in records if record.get("kind") == "process-identity"]
    identity_ok = len(identities) == 1 and identities[0].get("verified") is True and \
        type(identities[0].get("pid")) is int and identities[0]["pid"] > 0
    result["identity_status"] = "PASS" if identity_ok else "BLOCKED"
    if not identity_ok:
        statuses.append("BLOCKED")
        result["reasons"].append("实际进程身份未核验")
    errors = [record for record in records if record.get("kind") in ("open-root-error", "open-error", "object-guard-error")]
    for record in records:
        if record.get("kind") not in ("process-identity", "native-observation", "open-root-error", "open-error", "object-guard-error"):
            statuses.append("INCONCLUSIVE")
            result["reasons"].append("未知原生输出记录")
        if record.get("kind") in ("native-observation", "open-error", "object-guard-error") and record.get("object") not in expected:
            statuses.append("INCONCLUSIVE")
            result["reasons"].append("出现非预期对象")
    for name, kind in expected.items():
        selected = [(index, record) for index, record in enumerate(records)
                    if record.get("kind") == "native-observation" and record.get("object") == name]
        row_statuses, reasons = [], []
        relevant_errors = [record for record in errors if record.get("kind") == "open-root-error" or record.get("object") == name]
        if relevant_errors:
            row_statuses.append("FAIL" if any(record["kind"] == "object-guard-error" for record in relevant_errors) else "BLOCKED")
            reasons.append("实际打开/对象守卫失败")
        expected_iterations = [0] if mode == "lookup" else [0, 1]
        iterations = [record.get("iteration") for _, record in selected]
        complete = all(type(value) is int for value in iterations) and sorted(iterations) == expected_iterations
        if not complete:
            row_statuses.append("BLOCKED" if relevant_errors else "INCONCLUSIVE")
            reasons.append("预期对象的读取次数/iteration 缺失或重复")
        if not identity_ok:
            row_statuses.append("BLOCKED")
        for _, record in selected:
            if record.get("mode") != mode or type(record.get("pid")) is not int or \
               type(record.get("fd")) is not int or record["fd"] < 0:
                row_statuses.append("INCONCLUSIVE")
                reasons.append("对象 mode/PID/FD 协议不符")
            elif identity_ok and record["pid"] != identities[0]["pid"]:
                row_statuses.append("FAIL")
                reasons.append("对象读取不是已核验进程")
            status, reason = validate_read(record, kind)
            row_statuses.append(status)
            if status != "PASS":
                reasons.append(reason)
            if mode == "provider" and status == "PASS":
                status, reason = validate_native(record)
                row_statuses.append(status)
                if status != "PASS":
                    reasons.append(reason)
        if complete and mode == "provider":
            selected.sort(key=lambda item: item[1]["iteration"])
            first, second = (item[1] for item in selected)
            if (first.get("pid"), first.get("fd")) != (second.get("pid"), second.get("fd")):
                row_statuses.append("FAIL")
                reasons.append("两次 provider 读取不在同一 PID/FD")
            if aggregate(row_statuses) == "PASS":
                between = ({key: value for key, value in first["after"].items() if key != "atime"},
                           {key: value for key, value in second["before"].items() if key != "atime"})
                if between[0] != between[1] or witness(first) != witness(second) or \
                   first["statx_unique"]["mount_id"] != second["statx_unique"]["mount_id"]:
                    row_statuses.append("FAIL")
                    reasons.append("两次同 FD 读取之间 metadata/完整身份/当前 mount 关系改变")
        status = aggregate(row_statuses)
        result["objects"][name] = {"status": status, "kind": kind, "record_indices": [index for index, _ in selected], "reasons": reasons}
        statuses.append(status)
    if mode == "provider":
        valid = [record for record in records if record.get("kind") == "native-observation" and validate_native(record)[0] == "PASS"]
        if len({record["fsuuid"]["hex"] for record in valid}) > 1 or len({record["statx_unique"]["mount_id"] for record in valid}) > 1:
            statuses.append("FAIL")
            result["reasons"].append("同一批次对象不属于同一实际 UUID/mount")
    result["status"] = aggregate(statuses)
    return result


def observations(batch: dict, cases=CASES) -> dict:
    validated = validate_batch(batch, cases=cases)
    if validated["status"] != "PASS":
        return {}  # 不从失败/不完整批次挑选 iteration0 放行后续修改。
    return {name: batch["records"][item["record_indices"][0]] for name, item in validated["objects"].items()
            if item["status"] == "PASS"}


def compare_native(before: dict, after: dict, changed: bool = False, cases=CASES) -> dict:
    old_valid, new_valid = validate_batch(before, cases=cases), validate_batch(after, cases=cases)
    rows = []
    for name, _, _ in cases:
        old_result, new_result = old_valid["objects"].get(name), new_valid["objects"].get(name)
        if old_result is None or new_result is None:
            rows.append({"object": name, "status": "INCONCLUSIVE", "native_status": "INCONCLUSIVE", "reason": "缺少完整批次协议"})
            continue
        valid = aggregate([old_result["status"], new_result["status"]])
        if valid != "PASS":
            rows.append({"object": name, "status": valid, "native_status": valid,
                         "before_validation": old_result, "after_validation": new_result})
            continue
        # 比较原批次的最后一次成功观测与新批次第一次；两侧每次观测已全部核验。
        a = before["records"][old_result["record_indices"][-1]]
        b = after["records"][new_result["record_indices"][0]]
        same = witness(a) == witness(b)
        # dev/ino 等原路径守卫单列；mount ID 不参与持久 witness 相等。
        fields = ("dev", "ino", "mode", "nlink", "uid", "gid")
        guards = {key: [a["after"][key], b["before"][key]] for key in fields
                  if a["after"][key] != b["before"][key]}
        native_status = "PASS" if same != changed else "FAIL"
        status = aggregate([native_status, "FAIL"]) if not changed and guards else native_status
        rows.append({"object": name, "status": status, "native_status": native_status, "native_identity_equal": same,
                     "expected_identity_change": changed, "path_guard_differences": guards,
                     "old_pid": a["pid"], "new_pid": b["pid"],
                     "mount_ids": [a["statx_unique"]["mount_id"], b["statx_unique"]["mount_id"]]})
    return {"status": aggregate([old_valid["status"], new_valid["status"], *(row["status"] for row in rows)]),
            "objects": rows, "before_batch": old_valid, "after_batch": new_valid}


def probe_argv(root: Path, mode: str, uid: int, gid: int, group="provider", case=None) -> list[str]:
    selected = selected_cases(case)
    return [str(root / "native-probe"), mode, str(uid), str(gid), str(root / group / "merged"),
            *(part for item in selected for part in item)]


def run_probe(ev: Evidence, root: Path, label: str, uid: int, gid: int, mode="provider", group="provider", case=None):
    rc, stdout, _ = ev.call(label, drop(uid, gid, probe_argv(root, mode, uid, gid, group, case)))
    ev.file(f"native/{label}.jsonl", stdout, raw=True)
    try:
        records = [json.loads(line) for line in stdout.splitlines() if line]
    except (ValueError, UnicodeDecodeError):
        raise Stop("原生输出不是 JSONL", "INCONCLUSIVE") from None
    batch = {"mode": mode, "returncode": rc, "records": records}
    ev.event("probe-batch-validated", label=label, validation=validate_batch(batch, mode, selected_cases(case)))
    return batch


def host_binding(root: Path) -> dict:
    paths = {}
    for name in ("provider", "provider/lower", "provider/upper", "provider/work"):
        path = root / name
        info = path.stat(follow_symlinks=False)
        paths[name] = {"path": str(path), "dev": info.st_dev, "ino": info.st_ino,
                       "uid": info.st_uid, "gid": info.st_gid, "mode": info.st_mode}
    machine = read_small(Path("/etc/machine-id"), 4096).strip()
    if not machine:
        raise Stop("无法确认 fixture host machine-id")
    return {"machine_id_sha256": sha(machine), "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "root_path": str(root), "mount_root_path": str(root / "provider/merged"), "backing_paths": paths}


def persist(ev: Evidence, root: Path, batch: dict, prefix="persisted-observations") -> None:
    content = encoded({"binding": host_binding(root), "batch": batch,
                       "all_producer_children_exited": not ev.children})
    ev.file(prefix + ".json", content, raw=True)
    ev.file(prefix + ".sha256", (sha(content) + "\n").encode(), raw=True)


def child_context(args) -> tuple[Path, Path, dict]:
    root = canonical(Path(args.root))
    if root.stat().st_uid != 0 or root.stat().st_mode & 0o022:
        raise Stop("child 仅接受 root 持有的自有 fixture 根")
    public = root / ".fixture-public.json"
    if public.stat().st_uid != 0 or public.stat().st_mode & 0o022:
        raise Stop("fixture 公共身份记录可被修改")
    binding = json.loads(read_small(public, 8192))
    if (binding["token"], binding["root"], binding["uid"], binding["gid"]) != (args.token, str(root), args.uid, args.gid):
        raise Stop("child fixture 身份不符")
    actual = unprivileged(args.uid, args.gid)
    merged = root / "provider/merged"
    if containing(merged)["point"] != str(merged) or containing(merged)["type"] != "overlay":
        raise Stop("child 只允许自有 overlay merged 视图")
    return root, merged, actual


def missing_suffix(merged: Path) -> dict:
    ancestor = merged / "lower-dir"
    checked = []
    for path in (ancestor / "missing", ancestor / "missing/deeper"):
        try:
            os.lstat(path)
        except FileNotFoundError as error:
            checked.append({"path": str(path), "errno": error.errno})
        else:
            raise Stop("absent suffix 意外存在", "FAIL")
    return {"existing_ancestor": str(ancestor), "ancestor": stat_fields(ancestor.stat()), "missing": checked}


def write_payload(fd: int, data: bytes) -> None:
    """完成有界 payload；短写只推进已写字节，零进展/错误明确失败。"""
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if type(written) is not int or written <= 0 or written > len(data) - offset:
            raise Stop("重建 payload 写入未取得合法进展", "FAIL")
        offset += written


def validate_recreation_receipt(action: dict, kind: str) -> dict:
    statuses, reasons = [], []
    if not isinstance(action, dict):
        return {"status": "INCONCLUSIVE", "reasons": ["缺少重建行动收据"]}
    required = ["same_mode", "all_old_object_fds_closed_before_delete"]
    if kind == "file":
        required.append("same_content")
    for key in required:
        value = action.get(key)
        if value is not True:
            statuses.append("FAIL" if value is False else "INCONCLUSIVE")
            reasons.append(f"必要重建前提未成立: {key}")
    if type(action.get("absence_errno")) is not int or action["absence_errno"] != errno.ENOENT:
        statuses.append("INCONCLUSIVE")
        reasons.append("没有真实删除后 ENOENT 收据")
    try:
        before, after = action["before"], action["after"]
        for value in (before, after):
            if any(type(value[key]) is not int or value[key] < 0 for key in ("dev", "ino", "mode", "size")):
                raise ValueError("stat fields")
            if (kind == "file" and not stat.S_ISREG(value["mode"])) or \
               (kind == "directory" and not stat.S_ISDIR(value["mode"])):
                statuses.append("FAIL")
                reasons.append("重建对象实际类型不符")
        if stat.S_IMODE(before["mode"]) != stat.S_IMODE(after["mode"]) or \
           (kind == "file" and before["size"] != after["size"]):
            statuses.append("FAIL")
            reasons.append("重建实际 mode/size 不符")
    except (KeyError, TypeError, ValueError):
        statuses.append("INCONCLUSIVE")
        reasons.append("重建前后实际 stat 收据不完整")
    return {"status": aggregate(statuses) if statuses else "PASS", "reasons": reasons}


def compare_recreation(before: dict, after: dict, action: dict, case: str) -> dict:
    cases = selected_cases(case)
    receipt = validate_recreation_receipt(action, cases[0][2])
    comparison = compare_native(before, after, changed=True, cases=cases)
    inode_reused = None
    if receipt["status"] == "PASS":
        inode_reused = all(action["before"][key] == action["after"][key] for key in ("dev", "ino"))
    return {**comparison, "status": aggregate([comparison["status"], receipt["status"]]),
            "recreation_receipt": receipt, "inode_reused": inode_reused}


def child(args) -> int:
    root, merged, actual = child_context(args)
    result = {"identity": actual, "pid": os.getpid(), "operation": args.operation}
    if args.operation == "consume":
        if args.persisted not in ("persisted-observations", "remount-observations"):
            raise Stop("无效持久观察名称")
        path = root / "evidence" / (args.persisted + ".json")
        data = read_small(path, 1024 * 1024)
        expected = read_small(path.with_suffix(".sha256"), 128).decode().strip()
        if sha(data) != expected:
            raise Stop("持久原始观察 hash 不符", "FAIL")
        previous = json.loads(data)
        binding = host_binding(root)
        if previous["binding"] != binding or previous["all_producer_children_exited"] is not True:
            raise Stop("持久重开 source/root/host 前提不符", "FAIL")
        completed = subprocess.run(probe_argv(root, "provider", args.uid, args.gid),
                                   capture_output=True, timeout=2, check=False)
        records = [json.loads(line) for line in completed.stdout.splitlines() if line]
        batch = {"mode": "provider", "returncode": completed.returncode, "records": records}
        result.update({"persisted_sha256": expected, "binding": binding, "raw_native_stdout": completed.stdout.decode(),
                       "raw_native_stderr": completed.stderr.decode(), "native_returncode": completed.returncode,
                       "comparison": compare_native(previous["batch"], batch),
                       "batch": batch, "absent": missing_suffix(merged)})
    elif args.operation == "absent":
        result["absent"] = missing_suffix(merged)
    elif args.operation in ("same-object", "replace"):
        choices = {item[0]: item for item in CASES}
        if args.case not in choices or (args.operation == "replace" and args.case == "mount-root"):
            raise Stop("无效对象操作")
        _, relative, kind = choices[args.case]
        target = merged / relative
        before = target.stat(follow_symlinks=False)
        if before.st_uid != args.uid or before.st_gid != args.gid:
            raise Stop("对象 owner/group 漂移", "FAIL")
        result["before"] = stat_fields(before)
        if args.operation == "same-object":
            if relative != ".":
                temporary = merged / ("moved-" + relative)
                if temporary.exists():
                    raise Stop("临时名称已占用", "FAIL")
                os.rename(target, temporary)
                os.rename(temporary, target)
                result["rename_out_and_back"] = True
            if kind == "directory":
                temp = target / "temporary-member"
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(fd)
                temp.unlink()
                result["temporary_member_removed"] = True
        else:
            data = read_small(target, 4096) if kind == "file" else None
            os.unlink(target) if kind == "file" else os.rmdir(target)
            try:
                os.lstat(target)
            except FileNotFoundError as error:
                result["absence_errno"] = error.errno
            else:
                raise Stop("删除后未观察到真实 ENOENT", "FAIL")
            if kind == "file":
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(before.st_mode))
                try:
                    write_payload(fd, data)
                    os.fchmod(fd, stat.S_IMODE(before.st_mode))
                    os.fsync(fd)
                finally:
                    os.close(fd)
                result["same_content"] = read_small(target, 4096) == data
            else:
                target.mkdir(mode=stat.S_IMODE(before.st_mode))
                os.chmod(target, stat.S_IMODE(before.st_mode))
            result["same_mode"] = stat.S_IMODE(target.stat().st_mode) == stat.S_IMODE(before.st_mode)
        directory = os.open(target if kind == "directory" else merged, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        result["after"] = stat_fields(target.stat())
        result["all_old_object_fds_closed_before_delete"] = True
        if args.operation == "replace":
            result["recreation_validation"] = validate_recreation_receipt(result, kind)
    else:
        raise Stop("未知 child 操作")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if args.operation == "replace" and result["recreation_validation"]["status"] != "PASS":
        print(json.dumps(result["recreation_validation"], ensure_ascii=False), file=sys.stderr)
        return 70 if result["recreation_validation"]["status"] == "FAIL" else 65
    return 0


def child_call(ev: Evidence, args, label: str, operation: str, case=None, persisted=None, seconds=3) -> dict:
    argv = [sys.executable, "-I", str(HERE / "run.py"), "--mode", "child", "--root", args.root,
            "--uid", str(args.uid), "--gid", str(args.gid), "--token", args.token, "--operation", operation]
    if case is not None:
        argv += ["--case", case]
    if persisted is not None:
        argv += ["--persisted", persisted]
    rc, stdout, stderr = ev.call(label, drop(args.uid, args.gid, argv), seconds)
    if rc != 0:
        # EXDEV/权限/能力不足是明确能力结果，不能称为对象稳定。
        status = "BLOCKED"
        try:
            reported = json.loads(stderr.splitlines()[-1])
            if reported.get("status") in ("FAIL", "INCONCLUSIVE"):
                status = reported["status"]
        except (ValueError, IndexError):
            status = "INCONCLUSIVE"
        raise Stop(f"{label}: child rc={rc}; 详见原始 stderr {stderr[:160]!r}", status)
    try:
        result = json.loads(stdout)
    except (ValueError, UnicodeDecodeError):
        raise Stop("child 协议输出无效", "INCONCLUSIVE") from None
    ev.file(f"native/{label}.json", result)
    if operation == "replace":
        receipt = validate_recreation_receipt(result, selected_cases(case)[0][2])
        if receipt["status"] != "PASS":
            raise Stop(f"重建必要收据失败: {receipt['reasons']}", receipt["status"])
    ev.remaining(1)
    return result


def prepare(root: Path, uid: int, gid: int, ev: Evidence) -> None:
    for group_name in ("control", "provider"):
        group = root / group_name
        group.mkdir(mode=0o755)
        for name in ("lower", "upper", "work", "merged"):
            path = group / name
            path.mkdir(mode=0o700)
            os.chown(path, uid, gid)
        for layer in ("lower", "upper"):
            file = group / layer / (layer + "-file")
            write_file(file, PAYLOAD, 0o600)
            os.chown(file, uid, gid)
            for name in (layer + "-dir", "merged-dir"):
                path = group / layer / name
                path.mkdir(mode=0o700)
                os.chown(path, uid, gid)
        for name in ("lower", "upper", "work"):
            path = group / name
            try:
                os.setxattr(path, CANARY, b"observer-visible", os.XATTR_CREATE)
            except OSError as error:
                ev.event("trusted-observer-canary-unavailable", path=str(path), errno=error.errno)
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        backing = {name: {"dev": (group / name).stat().st_dev, "mount": containing(group / name)}
                   for name in ("lower", "upper", "work")}
        if any(item["dev"] != root.stat().st_dev or item["mount"]["type"] != "ext4"
               for item in backing.values()):
            raise Stop("lower/upper/work 不是同一实际 ext4 backing")
        ev.event("fixture-prepared", group=group_name, uid=uid, gid=gid,
                 absent_suffix_created=False, fixture_payload_bytes=2 * len(PAYLOAD), backing=backing)


def mount_group(root: Path, group_name: str, ev: Evidence, label: str) -> dict:
    group = root / group_name
    options = [f"lowerdir={group / 'lower'}", f"upperdir={group / 'upper'}", f"workdir={group / 'work'}", *OPTIONS]
    rc, _, _ = ev.call(label, ["mount", "-t", "overlay", "overlay", "-o", ",".join(options), str(group / "merged")], 10)
    if rc != 0:
        raise Stop(f"mount 不能接受固定参数: {group_name}")
    entry = containing(group / "merged")
    if entry["point"] != str(group / "merged") or entry["type"] != "overlay":
        raise Stop("实际 overlay mount 身份不符")
    requested = dict(option.split("=", 1) if "=" in option else (option, None) for option in options)
    actual = dict(option.split("=", 1) if "=" in option else (option, None) for option in entry["super_options"])
    if any(actual.get(key) != requested[key] for key in ("lowerdir", "upperdir", "workdir")):
        raise Stop("mountinfo 未确认同一 lower/upper/work")
    # Linux 可省略默认的 off 项；仅以本次内核已成功接受的显式请求补充，保存原始文本。
    for key, value in requested.items():
        if key in actual and actual[key] != value:
            raise Stop(f"实际挂载选项冲突: {key}")
    allowed = set(requested) | {"rw", "relatime", "noatime", "nodiratime", "nosuid", "nodev", "noexec", "seclabel"}
    if set(actual) - allowed or "ro" in entry["mount_options"] or "volatile" in actual or "userxattr" in actual:
        raise Stop("出现未核对/冲突的实际 overlay 选项")
    ev.file(f"mounts/{label}.json", {"requested_options": options, "actual_mountinfo": entry,
                                   "omitted_defaults_basis": "本次 mount 成功接受的显式固定请求；不按 runner 标签推断"})
    return entry


def unmount_group(root: Path, group_name: str, ev: Evidence, label: str, cleanup=False) -> None:
    point = root / group_name / "merged"
    matches = [entry for entry in mountinfo() if entry["point"] == str(point)]
    if len(matches) != 1 or matches[0]["type"] != "overlay":
        raise Stop("无法确认本次自有 overlay，拒绝卸载", "INCONCLUSIVE")
    if ev.children:
        raise Stop("child 尚未退出，拒绝卸载", "INCONCLUSIVE")
    rc, _, _ = ev.call(label, ["umount", "--", str(point)], 10, cleanup=cleanup)
    if rc != 0 or any(entry["point"] == str(point) for entry in mountinfo()):
        raise Stop("普通 umount 未确认释放；不 force/lazy", "INCONCLUSIVE")


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


def base_summary(profile: dict) -> dict:
    return {"schema_version": "fs-identity-qualification-result/v1", "execution_status": "NOT_RUN",
            "limited_native_status": "NOT_RUN", "provider_qualification": "BLOCKED", "B1": "OPEN",
            "accepted_provider_profiles": [], "historical_product_delete_recreate": "FAIL_UNRESOLVED",
            "checks": {name: {"status": "NOT_RUN"} for name in CHECKS},
            "not_run": {name: {"status": "BLOCKED" if name == "OS reboot" else "NOT_RUN"}
                        for name in profile["not_run"]},
            "limitations": ["仅自有 fixture 原生证据；不是生产 provider 合同激活或产品修复",
                            "真实 OS reboot 目标未分配；进程/namespace/overlay remount 均不替代 reboot",
                            "完整生产 source/host/root/写者守卫仍须生产链验收，不由本实验豁免"]}


def fixture(args, profile: dict) -> int:
    if os.getuid() != 0 or os.geteuid() != 0 or args.uid <= 0 or args.gid <= 0:
        raise Stop("fixture 模式只允许受控 root 准备器及非零原 runner 身份")
    root = canonical(Path(args.root))
    marker = verify_marker(root, args.token)
    namespace = os.readlink("/proc/self/ns/mnt")
    if namespace == args.outer_namespace or marker["outer_namespace"] != args.outer_namespace:
        raise Stop("fixture 必须进入与外部不同的独立 mount namespace")
    entries = mountinfo()
    if any(any(option.startswith("shared:") for option in entry["optional"]) for entry in entries):
        raise Stop("fixture mount namespace 尚有 shared propagation")
    if marker["uid"] != args.uid or marker["gid"] != args.gid or Path(args.out) != root / "evidence":
        raise Stop("fixture 内部参数与原 marker 不符")
    os.chown(root, 0, 0)
    os.chmod(root, 0o755)
    for name in (".fsqual-marker.json", "native-probe"):
        os.chown(root / name, 0, 0)
    os.chmod(root / "native-probe", 0o555)
    write_file(root / ".fixture-public.json", encoded({"root": str(root), "token": args.token,
                                                      "uid": args.uid, "gid": args.gid}))
    ev = Evidence(root / "evidence")
    summary = base_summary(profile)
    mounted: set[str] = set()
    cleanup = {"status": "NOT_RUN", "namespace": namespace, "children_reaped": False,
               "mounts_released": False, "groups_removed": False, "root_removed": False}

    def cancelled(signum, _frame):
        if ev.cancelled:
            return
        ev.cancelled = True
        ev.event("cancellation", signal=signum)
        raise Stop(f"fixture 收到取消 signal={signum}", "INCONCLUSIVE")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, cancelled)

    try:
        ev.file("namespace.json", {"outer": args.outer_namespace, "inner": namespace,
                                   "root_observer_identity": identity(), "initial_mountinfo": entries,
                                   "propagation": "private", "root_preparation_only": True})
        if containing(root)["type"] != "ext4":
            raise Stop("RUNNER_TEMP 实际 backing 不是所选 ext4；不 mkfs/loop/切换 FS")
        with ev.phase("prepare-and-pre-mount"):
            prepare(root, args.uid, args.gid, ev)
            stages = {"pre-mount": snapshots(root, "pre-mount", ev)}
        with ev.phase("mount-and-pre-lookup"):
            for group in ("control", "provider"):
                mount_group(root, group, ev, "initial-" + group)
                mounted.add(group)
            defaults, defaults_errors = {}, []
            try:
                parameters = sorted(Path("/sys/module/overlay/parameters").iterdir())
                if len(parameters) > 32:
                    raise Stop("overlay defaults 超出有限观察范围", "INCONCLUSIVE")
                for path in parameters:
                    try:
                        defaults[path.name] = read_small(path, 4096).decode().strip()
                    except (OSError, Stop) as error:
                        defaults_errors.append({"name": path.name, "error": str(error)})
            except OSError as error:
                defaults_errors.append({"error": str(error)})
            ev.file("overlay-defaults.json", {"values": defaults, "errors": defaults_errors})
            summary["checks"]["profile_confirmation"] = {
                "status": "PASS" if defaults and not defaults_errors else "INCONCLUSIVE",
                "backing": containing(root), "evidence": ["mounts/initial-control.json", "mounts/initial-provider.json", "overlay-defaults.json"],
                "accepted_explicit_options": list(OPTIONS)}
            stages["post-mount-pre-lookup"] = snapshots(root, "post-mount-pre-lookup", ev)
        with ev.phase("lookup-only-control-provider-stays-cold"):
            control_first = run_probe(ev, root, "control-first-lookup", args.uid, args.gid, "lookup", "control")
            stages["lookup-only"] = snapshots(root, "lookup-only", ev)
        with ev.phase("first-provider-open"):
            initial = run_probe(ev, root, "provider-first-open", args.uid, args.gid)
            control_second = run_probe(ev, root, "control-second-lookup", args.uid, args.gid, "lookup", "control")
            stages["provider"] = snapshots(root, "provider", ev)
            initial_validation = validate_batch(initial)
            control_validations = [validate_batch(control_first, mode="lookup"), validate_batch(control_second, mode="lookup")]
            summary["checks"]["privilege_separation"] = {
                "status": aggregate(item["identity_status"] for item in [initial_validation, *control_validations]),
                "evidence": "native/* process-identity"}
            matrix = [{"object": name, "kind": kind,
                       "source_root_path": str(root / "provider/merged" / relative),
                       "anchor_path": str(root / "provider/merged" / relative), "relative": relative,
                       "root_role": "mount-root" if relative == "." else ("file-root" if kind == "file" else "dir-root"),
                       "status": initial_validation["objects"].get(name, {"status": "INCONCLUSIVE"})["status"]}
                      for name, relative, kind in CASES]
            summary["checks"]["same_fd_codec"] = {"status": initial_validation["status"],
                "evidence": "native/provider-first-open.jsonl", "full_batch_validation": initial_validation}
            summary["checks"]["object_matrix"] = {"status": initial_validation["status"], "objects": matrix,
                "absent_root_path": str(root / "provider/merged/lower-dir/missing/deeper"),
                "absent_anchor_path": str(root / "provider/merged/lower-dir"),
                "absent_anchor_observation": "lower-dir", "absent_suffix": ["missing", "deeper"]}
            observer_ok = all(item["trusted_xattrs_observable"] and not item["errors"] and
                              not item["observer_repeat_diff"]["non_atime"] and
                              not any(change["non_atime"] for change in item["observer_self_changes"])
                              for values in stages.values() for item in values.values())
            summary["checks"]["observer_purity"] = {"status": "PASS" if observer_ok else "INCONCLUSIVE", "evidence": "snapshots/ and diffs/*-observer-only.json"}
            transitions = {}
            names = list(stages)
            for before, after in zip(names, names[1:]):
                for group in ("control", "provider"):
                    key = before + "-to-" + after + "-" + group
                    transitions[key] = diff_entries(stages[before][group]["entries"], stages[after][group]["entries"])
                    ev.file("diffs/" + key + ".json", transitions[key])
            a = transitions["post-mount-pre-lookup-to-lookup-only-control"]
            a_repeat = transitions["lookup-only-to-provider-control"]
            untouched = transitions["post-mount-pre-lookup-to-lookup-only-provider"]
            b = transitions["lookup-only-to-provider-provider"]
            status = "INCONCLUSIVE" if not observer_ok or untouched["non_atime"] else (
                "FAIL" if a["non_atime"] or a_repeat["non_atime"] or b["non_atime"] else "PASS")
            status = aggregate([status, initial_validation["status"], *(item["status"] for item in control_validations)])
            summary["checks"]["cold_backing_nonmutation"] = {"status": status,
                "lookup_batch_validations": control_validations, "provider_batch_validation": initial_validation,
                "control_first_lookup": a, "control_repeat_lookup": a_repeat,
                "provider_first_open": b, "untouched_provider_control": untouched,
                "control_mutation_never_cancels_provider_mutation": True,
                "provider_first_open_was_cold": True, "atime_excluded_only_from_nonmutation_verdict": True}
            ev.file("cold-comparison.json", summary["checks"]["cold_backing_nonmutation"])
        with ev.phase("persisted-new-process"):
            persist(ev, root, initial)
            consumer = child_call(ev, args, "new-process-consumer", "consume", persisted="persisted-observations")
            summary["checks"]["persisted_new_process"] = {"status": consumer["comparison"]["status"], "evidence": "native/new-process-consumer.json"}
            summary["checks"]["unchanged_reopen"] = consumer["comparison"]
            current = consumer["batch"]
        positive_rows = []
        eligible = {name for name, record in observations(initial).items() if validate_native(record)[0] == "PASS"}
        with ev.phase("same-object-positive-controls"):
            for name, _, _ in CASES:
                if name not in eligible:
                    positive_rows.append({"object": name, "status": "BLOCKED", "reason": "初始 cold 对象不支持严格 profile；不通过 copy-up 后再试来制造支持"})
                    continue
                before = run_probe(ev, root, "same-before-" + name, args.uid, args.gid, case=name)
                try:
                    child_call(ev, args, "same-mutation-" + name, "same-object", case=name)
                except Stop as error:
                    positive_rows.append({"object": name, "status": error.status, "reason": str(error)})
                    continue
                after = run_probe(ev, root, "same-after-" + name, args.uid, args.gid, case=name)
                positive_rows.append({"object": name, **compare_native(before, after, cases=selected_cases(name))})
            summary["checks"]["same_object_mutations"] = {"status": aggregate(row["status"] for row in positive_rows), "objects": positive_rows}
        replacement_rows, reused = [], set()
        with ev.phase("real-delete-recreate"):
            for name, _, kind in CASES:
                if name == "mount-root":
                    continue  # 自有 mount 根不能在已挂载时 rmdir；不把 remount 当根重建。
                if name not in eligible:
                    replacement_rows.append({"object": name, "status": "BLOCKED", "reason": "初始 cold 对象严格 profile 不可用"})
                    continue
                before = run_probe(ev, root, "replace-before-" + name, args.uid, args.gid, case=name)
                action = child_call(ev, args, "replace-action-" + name, "replace", case=name)
                after = run_probe(ev, root, "replace-after-" + name, args.uid, args.gid, case=name)
                comparison = compare_recreation(before, after, action, name)
                inode_reused = comparison["inode_reused"]
                if inode_reused and comparison["status"] == "PASS":
                    reused.add(kind)
                replacement_rows.append({"object": name, "inode_reused": inode_reused,
                    "class_label_is_original_fixture_layout": True,
                    "preceding_rename_or_membership_may_have_copied_up": True, **comparison})
            absent = child_call(ev, args, "absent-after-ancestor-recreation", "absent")
            summary["checks"]["real_recreation"] = {"status": aggregate(row["status"] for row in replacement_rows),
                "objects": replacement_rows, "absent_anchor_recreated": "lower-dir" if "lower-dir" in eligible else "BLOCKED",
                "absence_evidence": absent,
                "mount_root_recreation": "NOT_RUN: mounted root itself is not deleted",
                "all_times_equal_native_recreation": "NOT_RUN; no synthetic stat equality claimed"}
        start, attempts, rows = time.monotonic(), 0, []
        budget_stop, active_completed_at = None, None
        reuse_status = "INCONCLUSIVE"
        try:
            with ev.phase("bounded-inode-reuse", seconds=BUDGETS["inode_seconds"]):
                while attempts < BUDGETS["inode_attempts"] and reused != {"file", "directory"}:
                    if ev.stage_deadline - time.monotonic() < 0.15:
                        break
                    kind = "file" if "file" not in reused else "directory"
                    name = "upper-file" if kind == "file" else "upper-dir"
                    if name not in eligible:
                        raise Stop("inode 对照所需的初始 upper 对象不支持严格 profile；不重试能力失败")
                    before = run_probe(ev, root, f"inode-before-{attempts + 1}", args.uid, args.gid, case=name)
                    if validate_batch(before, cases=selected_cases(name))["status"] != "PASS":
                        raise Stop("inode 对照前原生能力不可用；不继续重试")
                    if ev.stage_deadline - time.monotonic() < 0.1:
                        break
                    attempts += 1
                    action = child_call(ev, args, f"inode-action-{attempts}", "replace", case=name)
                    after = run_probe(ev, root, f"inode-after-{attempts}", args.uid, args.gid, case=name)
                    comparison = compare_recreation(before, after, action, name)
                    reused_now = comparison["inode_reused"]
                    ev.remaining(1)  # 处理及必要证据都在有效期限内，才允许计入样本。
                    if reused_now and comparison["status"] == "PASS":
                        reused.add(kind)
                    rows.append({"attempt": attempts, "kind": kind, "inode_reused": reused_now, **comparison})
                reuse_status = "PASS" if reused == {"file", "directory"} else "INCONCLUSIVE"
                if rows:
                    reuse_status = aggregate([reuse_status, *(row["status"] for row in rows)])
                ev.remaining(1)  # 活动阶段结论前再核期限；phase 退出还会复核一次。
                active_completed_at = time.monotonic()
        except Stop as error:
            budget_stop = {"status": error.status, "reason": str(error)}
            reuse_status = aggregate([reuse_status, error.status])
        summary["checks"]["inode_reuse"] = {"status": reuse_status,
            "attempts": attempts, "elapsed_including_receipt_seconds": time.monotonic() - start,
            "active_elapsed_seconds": active_completed_at - start if active_completed_at is not None else None,
            "observed_kinds": sorted(reused), "observations": rows, "stop": budget_stop,
            "late_receipts_never_count_as_samples": True, "not_observed_is_not_pass": True}
        with ev.phase("one-same-source-overlay-remount"):
            current = run_probe(ev, root, "before-remount", args.uid, args.gid)
            persist(ev, root, current, "remount-observations")
            prior_binding = host_binding(root)
            before_mount = containing(root / "provider/merged")
            unmount_group(root, "provider", ev, "single-remount-unmount")
            mounted.remove("provider")
            after_mount = mount_group(root, "provider", ev, "single-remount-mount")
            mounted.add("provider")
            if host_binding(root) != prior_binding:
                raise Stop("remount 的同源/host/root 绑定不符", "FAIL")
            consumer = child_call(ev, args, "after-remount-consumer", "consume", persisted="remount-observations")
            guards = [row for row in consumer["comparison"]["objects"] if row.get("path_guard_differences")]
            comparison = consumer["comparison"]
            native_status = aggregate([comparison["before_batch"]["status"], comparison["after_batch"]["status"],
                                       *(row.get("native_status", row["status"]) for row in comparison["objects"])])
            remount_status = aggregate([native_status, "BLOCKED"]) if guards else native_status
            summary["checks"]["same_source_remount"] = {"status": remount_status,
                "native_stability": consumer["comparison"], "path_guard_differences_not_waived": guards,
                "before_mount": before_mount, "after_mount": after_mount,
                "overlay_remount_count": 1, "backing_device_remount": "NOT_RUN", "OS_reboot": "NOT_RUN"}
            snapshots(root, "after-remount", ev)
        summary["execution_status"] = "COMPLETE"
    except Stop as error:
        summary["execution_status"] = error.status
        summary["stop_reason"] = str(error)
        ev.event("stopped", status=error.status, reason=str(error))
    except OSError as error:
        summary["execution_status"] = "BLOCKED" if error.errno in (
            errno.EACCES, errno.EPERM, errno.EOPNOTSUPP, errno.ENOTTY, errno.ENOSYS, errno.ENODEV) else "INCONCLUSIVE"
        summary["environment_io_error"] = {"errno": error.errno, "message": str(error)}
        ev.event("environment-io-error", error=summary["environment_io_error"])
    except Exception as error:
        summary["execution_status"] = "FAIL"
        summary["harness_error"] = {"type": type(error).__name__, "message": str(error)}
        ev.event("harness-error", error=summary["harness_error"])
    finally:
        try:
            with alarm(min(30, ev.deadline - time.monotonic()), "普通清理达到期限；保留未知资源"):
                for proc in list(ev.children.values()):
                    stop_child(proc, grace=0)
                ev.children.clear()
                cleanup["children_reaped"] = True
                verify_marker(root, args.token)
                # 即使 mount 命令超时/选项回读失败，也以本 namespace 实际 mountinfo 收尾。
                for group in ("provider", "control"):
                    point = root / group / "merged"
                    if any(entry["point"] == str(point) for entry in mountinfo()):
                        unmount_group(root, group, ev, "cleanup-" + group, cleanup=True)
                if any(root == Path(entry["point"]) or root in Path(entry["point"]).parents for entry in mountinfo()):
                    raise Stop("仍有未知自有范围 mount；保留", "INCONCLUSIVE")
                cleanup["mounts_released"] = True
                for group in ("provider", "control"):
                    if (root / group).exists():
                        remove_owned_tree(root / group, root.stat().st_dev, 64)
                cleanup["groups_removed"] = True
                ev.flush_pending_receipts()
                cleanup["status"] = "PASS"
        except Exception as error:
            cleanup["status"] = "INCONCLUSIVE"
            cleanup["reason"] = str(error)
        summary["limited_native_status"] = aggregate(item["status"] for item in summary["checks"].values())
        if summary["execution_status"] != "COMPLETE":
            summary["limited_native_status"] = aggregate([summary["limited_native_status"], summary["execution_status"]])
        if cleanup["status"] != "PASS":
            summary["limited_native_status"] = aggregate([summary["limited_native_status"], "INCONCLUSIVE"])
        ev.file("cleanup.json", cleanup)
        ev.file("summary.json", summary)
        ev.event("fixture-finished", status=summary["execution_status"], cleanup=cleanup["status"])
        # 数据组已经普通卸载并删除后，仅交还自有证据/marker/二进制给原 runner。
        if cleanup["status"] == "PASS":
            for directory, directories, files in os.walk(root, followlinks=False):
                for name in [*directories, *files]:
                    path = Path(directory) / name
                    if path.is_symlink():
                        raise Stop("收尾遇到未知 symlink，保留", "INCONCLUSIVE")
                    os.chown(path, args.uid, args.gid, follow_symlinks=False)
            os.chown(root, args.uid, args.gid)
            os.chmod(root, 0o700)
    return 1 if summary["limited_native_status"] == "FAIL" else 0


def validate_profile(path: Path) -> dict:
    profile = json.loads(read_small(canonical(path), 65536))
    if profile["schema_version"] != "fs-identity-qualification/v1" or profile["budgets"] != BUDGETS or \
       any(type(value) is not int for value in profile["budgets"].values()):
        raise Stop("profile schema/预算不是已审查固定合同")
    if tuple(profile["target"]["mount_options"]) != OPTIONS or profile["target"]["backing_filesystem"] != "ext4":
        raise Stop("profile 挂载目标不符；不自动放宽")
    if profile["target"]["profile"] != "linux-overlay-fid-fsuuid-v1" or profile["target"]["runner"] != "ubuntu-24.04":
        raise Stop("未知 provider/runner profile 不自动接受")
    if profile["status"] != {"qualification": "NOT_RUN", "B1": "OPEN", "accepted_provider_profiles": [],
                             "historical_product_delete_recreate": "FAIL_UNRESOLVED"}:
        raise Stop("profile 不得更改产品/资格状态")
    if tuple(profile["source_files"]) != FILES:
        raise Stop("profile 四文件范围不符")
    if tuple(profile["not_run"]) != NOT_RUN:
        raise Stop("profile 不得删除未执行的产品/reboot 范围")
    return profile


def copy_evidence(source: Path, destination: Path) -> None:
    count, size = 0, 0
    for directory, directories, files in os.walk(source, followlinks=False):
        relative = Path(directory).relative_to(source)
        for name in directories:
            if (Path(directory) / name).is_symlink():
                raise Stop("证据目录含未知 symlink", "INCONCLUSIVE")
        (destination / relative).mkdir(mode=0o755, exist_ok=True)
        for name in files:
            count += 1
            data = read_small(Path(directory) / name, 2 * 1024 * 1024)
            size += len(data)
            if count > 512 or size > MAX_EVIDENCE:
                raise Stop("证据导出超过有限预算", "INCONCLUSIVE")
            write_file(destination / relative / name, data)


def hosted(args, profile: dict) -> int:
    uid, gid = os.getuid(), os.getgid()
    if uid == 0 or gid == 0 or platform.system() != "Linux":
        raise Stop("hosted-linux 入口必须由原非零 Linux runner 身份启动")
    env = os.environ
    if env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REPOSITORY") != "gbcdby/boardroom" or \
       env.get("GITHUB_REF") != "refs/heads/qualification/152-fs-identity-r2" or env.get("GITHUB_EVENT_NAME") != "push":
        raise Stop("只有固定 topic 分支的已授权 hosted push 可进入 fixture；本地不可借此提权 mount")
    run_id, attempt, commit = env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", ""), env.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", attempt) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise Stop("缺真实 run/attempt/commit 身份")
    temp = canonical(Path(env["RUNNER_TEMP"]))
    workspace = canonical(Path(env["GITHUB_WORKSPACE"]))
    root = canonical(Path(args.root), absent_leaf=True)
    if root != temp / f"boardroom-fsqual-{run_id}-{attempt}" or root.exists() or re.search(r"[\s,:\\]", str(root)):
        raise Stop("root 必须是 RUNNER_TEMP 下本 run 的全新安全目录")
    if workspace != REPO or Path(args.out) != workspace / ".agent-output/fs-qualification":
        raise Stop("输出与固定候选工作区不符")
    output_parent = workspace / ".agent-output"
    output_parent.mkdir(mode=0o700, exist_ok=True)
    canonical(output_parent)
    out = canonical(Path(args.out), absent_leaf=True)
    ev = Evidence(out)
    summary = base_summary(profile)
    cleanup = {"status": "PASS", "fixture_created": False, "root_removed": False, "mount_experiment_started": False}
    created = False
    token = uuid.uuid4().hex
    def cancel_hosted(signum, _frame):
        # 进入 finally 导出已有回执；namespace child 获得 30s 普通收尾机会。
        for watched in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(watched, signal.SIG_IGN)
        ev.cancelled = True
        raise Stop(f"hosted 收到取消 signal={signum}", "INCONCLUSIVE")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, cancel_hosted)
    environment = {"uname": list(platform.uname()), "uid": uid, "gid": gid, "runner_identity": identity(),
                   "recorded_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "run_id": run_id, "run_attempt": attempt, "commit": commit,
                   "image": {key: env.get(key) for key in ("ImageOS", "ImageVersion", "ImageRelease", "RUNNER_OS", "RUNNER_ARCH")},
                   "os_release": read_small(Path("/etc/os-release").resolve(), 65536).decode(),
                   "tools": {name: shutil.which(name) for name in ("cc", "python3", "sudo", "unshare", "setpriv", "mount", "umount", "git")},
                   "runner_temp_mount": containing(temp), "requested_options": list(OPTIONS)}
    ev.file("environment.json", environment)
    try:
        if any(value is None for value in environment["tools"].values()):
            raise Stop("所需工具缺失；不安装工具或修改系统头")
        ev.call("compiler-version", [environment["tools"]["cc"], "--version"])
        ev.call("python-version", [environment["tools"]["python3"], "--version"])
        rc, stdout, _ = ev.call("git-identity", ["git", "-C", str(workspace), "rev-parse", "HEAD", "HEAD^{tree}"])
        values = stdout.decode().splitlines()
        if rc != 0 or len(values) != 2 or values[0] != commit:
            raise Stop("checkout 与实际 GITHUB_SHA 不符", "FAIL")
        rc, dirty, _ = ev.call("git-status", ["git", "-C", str(workspace), "status", "--porcelain=v1", "--untracked-files=normal"])
        if rc != 0 or dirty.strip():
            raise Stop("候选工作树不是干净固定版本", "FAIL")
        candidate = {"commit": commit, "tree": values[1], "files": {name: sha(read_small(workspace / name, 1024 * 1024)) for name in FILES}}
        ev.file("candidate.json", candidate)
        root.mkdir(mode=0o700)
        created = True
        info = root.stat()
        namespace = os.readlink("/proc/self/ns/mnt")
        marker = {"schema": "fsqual-own-fixture/v1", "root": str(root), "root_identity": [info.st_dev, info.st_ino],
                  "token": token, "uid": uid, "gid": gid, "outer_namespace": namespace,
                  "candidate": candidate, "run_id": run_id, "attempt": attempt}
        write_file(root / ".fsqual-marker.json", encoded(marker), 0o600)
        cleanup["fixture_created"] = True
        rc, _, _ = ev.call("compile", [environment["tools"]["cc"], "-std=gnu11", "-Wall", "-Wextra", "-Werror", "-O2",
                                       str(HERE / "probe.c"), "-o", str(root / "native-probe")], BUDGETS["compile_seconds"])
        if rc != 0:
            raise Stop("固定 probe/旧 UAPI 编译阻塞；不改头、不安装工具")
        ev.file("binary.json", {"sha256": sha(read_small(root / "native-probe", 1024 * 1024)), "compile_seconds_limit": 10})
        cleanup["mount_experiment_started"] = True
        argv = ["sudo", "-n", "unshare", "--mount", "--propagation", "private", "--fork", "--kill-child=TERM",
                "--", environment["tools"]["python3"], "-I", str(HERE / "run.py"), "--mode", "fixture",
                "--root", str(root), "--out", str(root / "evidence"), "--profile", str(HERE / "profile.json"),
                "--uid", str(uid), "--gid", str(gid), "--token", token, "--outer-namespace", namespace]
        # fixture 有独立 300s 时钟；外围另保留导出回执时间，job 上限仍为 10min。
        ev.action_deadline = time.monotonic() + 330
        ev.stage_deadline = ev.action_deadline
        rc, _, _ = ev.call("namespace", argv, BUDGETS["fixture_seconds"])
        if not (root / "evidence/summary.json").is_file():
            raise Stop(f"sudo/unshare/fixture 不能建立可回读实验，rc={rc}")
        copy_evidence(root / "evidence", out / "fixture")
        summary = json.loads(read_small(root / "evidence/summary.json", 2 * 1024 * 1024))
        summary["evidence_base"] = "fixture/"
        cleanup["namespace_cleanup"] = json.loads(read_small(root / "evidence/cleanup.json", 65536))
        # 提升原始证据的固定顶层入口；其余保留 fixture/ 下完整命令和阶段证据。
        for name in ("persisted-observations.json", "persisted-observations.sha256"):
            if (root / "evidence" / name).is_file():
                ev.file(name, read_small(root / "evidence" / name), raw=True)
        if rc != 0 and summary["limited_native_status"] != "FAIL":
            raise Stop(f"fixture 非预期退出 rc={rc}", "INCONCLUSIVE")
    except Stop as error:
        summary["execution_status"] = error.status
        summary["stop_reason"] = str(error)
        summary["limited_native_status"] = aggregate([summary["limited_native_status"], error.status])
    except Exception as error:
        summary["execution_status"] = "FAIL"
        summary["limited_native_status"] = "FAIL"
        summary["harness_error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        try:
            with alarm(30, "外层原始回执导出达到保留期限"):
                ev.flush_pending_receipts()
        except Exception as error:
            cleanup["status"] = "INCONCLUSIVE"
            cleanup["pending_receipt_error"] = str(error)
        if created:
            # 失败/取消路径也导出已完成的原始证据；没有回执就明确未知。
            evidence = root / "evidence"
            if evidence.is_dir() and not (out / "fixture").exists():
                try:
                    copy_evidence(evidence, out / "fixture")
                    if (evidence / "cleanup.json").is_file():
                        cleanup["namespace_cleanup"] = json.loads(read_small(evidence / "cleanup.json", 65536))
                    if (evidence / "summary.json").is_file():
                        summary["partial_fixture_result"] = json.loads(read_small(evidence / "summary.json", 2 * 1024 * 1024))
                except Exception as error:
                    cleanup["partial_evidence_error"] = str(error)
            try:
                verify_marker(root, token)
                # 只有已确认 namespace 清理成功，或根本未进入 namespace，才删除 root。
                safe = not cleanup["mount_experiment_started"] or cleanup.get("namespace_cleanup", {}).get("status") == "PASS"
                if not safe or ev.children or root.stat().st_uid != uid:
                    raise Stop("资源释放/所有权不明；保留本 run marker 根", "INCONCLUSIVE")
                allowed = {".fsqual-marker.json", ".fixture-public.json", "native-probe", "evidence"}
                if {entry.name for entry in root.iterdir()} - allowed:
                    raise Stop("root 含未知对象；保留", "INCONCLUSIVE")
                remove_owned_tree(root, root.stat().st_dev)
                cleanup["root_removed"] = True
            except Exception as error:
                cleanup["status"] = "INCONCLUSIVE"
                cleanup["reason"] = str(error)
                cleanup["retained_root"] = str(root)
        if cleanup["status"] != "PASS":
            summary["limited_native_status"] = aggregate([summary["limited_native_status"], "INCONCLUSIVE"])
        summary["run"] = {"id": run_id, "attempt": attempt, "commit": commit}
        ev.file("cleanup.json", cleanup)
        ev.file("summary.json", summary)
        sums = []
        for file in sorted(out.rglob("*")):
            if file.is_file() and file.name != "SHA256SUMS":
                sums.append(sha(read_small(file)) + "  " + file.relative_to(out).as_posix())
        ev.file("SHA256SUMS", ("\n".join(sums) + "\n").encode(), raw=True)
    print(json.dumps({"execution_status": summary["execution_status"], "limited_native_status": summary["limited_native_status"],
                      "provider_qualification": "BLOCKED", "B1": "OPEN", "accepted_provider_profiles": [], "summary": str(out / "summary.json")}, ensure_ascii=False))
    return 1 if summary["limited_native_status"] == "FAIL" else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("hosted-linux", "fixture", "child"))
    parser.add_argument("--profile", default=str(HERE / "profile.json"))
    parser.add_argument("--root")
    parser.add_argument("--out")
    parser.add_argument("--uid", type=int, default=-1)
    parser.add_argument("--gid", type=int, default=-1)
    parser.add_argument("--token", default="")
    parser.add_argument("--outer-namespace", default="")
    parser.add_argument("--operation", default="")
    parser.add_argument("--case")
    parser.add_argument("--persisted")
    args = parser.parse_args()
    try:
        if args.mode == "fixture" and os.geteuid() != 0:
            raise Stop("禁止普通用户直接进入 fixture 内部准备模式")
        if not args.root or (args.mode != "child" and not args.out):
            raise Stop("缺少明确 root/out 范围")
        if args.mode == "child":
            return child(args)
        profile = validate_profile(Path(args.profile).absolute())
        return hosted(args, profile) if args.mode == "hosted-linux" else fixture(args, profile)
    except Stop as error:
        print(json.dumps({"status": error.status, "reason": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 64
    except OSError as error:
        print(json.dumps({"status": "BLOCKED", "operation": args.operation,
                          "errno": error.errno, "reason": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 69
    except (KeyError, TypeError, ValueError) as error:
        print(json.dumps({"status": "INCONCLUSIVE", "reason": "输入/内部证据不符合固定协议",
                          "error_type": type(error).__name__}, ensure_ascii=False), file=sys.stderr)
        return 65


if __name__ == "__main__":
    sys.exit(main())

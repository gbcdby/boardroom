"""资格控制专用 Chromium 所有权；不连接既有浏览器，不修改第三方 driver。"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import tempfile
from time import monotonic, sleep

from resource_browser_binding import validate_binding

BACKGROUND = ("--disable-background-timer-throttling",
              "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding")
RUNTIME_PREFIXES = ("--user-data-dir=", "--remote-debugging-port=", "--remote-debugging-address=")
MARKERS = ("--flag-switches-begin", "--flag-switches-end")


def functional_arguments(argv):
    return sorted(set(arg for arg in argv[1:] if arg not in MARKERS
                      and arg != "--remote-debugging-pipe"
                      and not arg.startswith(RUNTIME_PREFIXES)))


def native_arguments(reference, profile):
    assert reference and Path(reference[0]).is_absolute(), "argv 缺固定 executable"
    arguments = list(dict.fromkeys(arg for arg in reference[1:] if arg not in MARKERS
                                  and arg != "--remote-debugging-pipe"
                                  and not arg.startswith(RUNTIME_PREFIXES)))
    return [reference[0], *arguments, f"--user-data-dir={profile}",
            "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"]


def compare_arguments(reference, actual):
    required = ("--enable-automation", "--ozone-platform=x11", *BACKGROUND)
    assert all(arg in actual for arg in required), "实际 argv 缺必要 automation/X11/background 开关"
    assert not any(arg.startswith("--headless") for arg in actual), "实际 argv 不得 headless"
    assert "--remote-debugging-pipe" not in actual, "实际 argv 必须为本次 loopback CDP"
    assert [a for a in actual if a.startswith("--remote-debugging-address=")] == ["--remote-debugging-address=127.0.0.1"], "实际 argv 未唯一绑定 loopback"
    assert [a for a in actual if a.startswith("--remote-debugging-port=")] == ["--remote-debugging-port=0"], "实际 argv 必须由本次 Chrome 唯一分配端口"
    difference = sorted(set(functional_arguments(reference)) ^ set(functional_arguments(actual)))
    assert not difference, "实际 argv 功能差异: " + repr(difference)
    return {"reference": reference, "actual": actual, "functionalDifference": difference,
            "normalization": "仅 profile/调试 transport 与 Chrome 标记；重复的完全相同开关去重",
            "backgroundFlags": list(BACKGROUND)}


def process_identity(pid):
    directory = Path("/proc") / str(pid)
    text = (directory / "stat").read_text()
    fields = text[text.rfind(")") + 2:].split()
    return {"pid": pid, "state": fields[0], "ppid": int(fields[1]),
            "pgrp": int(fields[2]), "session": int(fields[3]),
            "start": int(fields[19]), "uid": directory.stat().st_uid}


def identity_key(item):
    return (item["pid"], item["start"], item["uid"])


def _all_processes():
    result = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            result.append(process_identity(int(entry.name)))
        except (FileNotFoundError, ProcessLookupError):
            pass  # /proc 枚举与读取间的真实退出。
    return result


class OwnedChromium:
    """单个串行 case；其余 fixture/driver 必须先启动，期间不启动无关子进程。"""
    def __init__(self, output: Path):
        if os.name != "posix" or not hasattr(os, "pidfd_open") or not hasattr(os, "P_PIDFD"):
            raise RuntimeError("资格 owner 要求 Linux pidfd/waitid")
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER；仅本 Python 进程。
            raise OSError(ctypes.get_errno(), "无法为本次自有后代建立 reap 归属")
        self.output = output
        output.mkdir(parents=True, exist_ok=True)
        self.profile = Path(tempfile.mkdtemp(prefix="boardroom-native-chrome-"))
        self.profile.chmod(0o700)
        info = self.profile.stat()
        self.profile_identity = (info.st_dev, info.st_ino, info.st_uid)
        self.process = None
        self.main_identity = None
        self.uid = os.getuid()
        self.log = None
        self.closed = False
        self.bound = False
        self.seen = {}
        self.reap_observations = {}
        # 只有已完成或不可重试的失败进入此集合；WNOHANG None 仍为 pending。
        self.attempted = set()
        self.existing_children = {identity_key(p) for p in _all_processes() if p["ppid"] == os.getpid()}
        self.receipt = {"status": "NOT_STARTED", "profile": str(self.profile), "profileMode": "0o700",
                        "processes": [], "signals": [], "orphanWaits": [], "errors": [],
                        "orphanReapObservations": [], "unresolvedOrphanWaits": [],
                        "kernelRelease": os.uname().release,
                        "forced": False, "remaining": [], "browserBound": False}
        self.save()

    def save(self):
        (self.output / "chrome-owner.json").write_text(json.dumps(self.receipt, indent=2) + "\n")

    def error(self, value):
        value = str(value)[:512]
        if value not in self.receipt["errors"] and len(self.receipt["errors"]) < 32:
            self.receipt["errors"].append(value)

    def spawn(self, argv, env):
        assert self.process is None and not self.closed
        self.log = (self.output / "chrome-stderr.log").open("wb")
        self.process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=self.log,
                                        stderr=self.log, env=env, start_new_session=True)
        self.receipt.update({"pid": self.process.pid, "argv": argv, "status": "STARTED"})
        try:
            self.main_identity = process_identity(self.process.pid)
            assert self.main_identity["pgrp"] == self.process.pid
            assert self.main_identity["session"] == self.process.pid
            self.seen[identity_key(self.main_identity)] = self.main_identity
            self.receipt["mainIdentity"] = self.main_identity
        except Exception as error:
            self.error(error)
            self.save()
            raise
        self.save()

    def members(self):
        if self.process is None:
            return []
        all_processes = _all_processes()
        selected = {p["pid"]: p for p in all_processes
                    if identity_key(p) in self.seen
                    or (p["pgrp"] == self.process.pid and p["session"] == self.process.pid)}
        # 同时捕获仍有父链的脱离原进程组后代；身份一经见到即固定 start/uid。
        while True:
            extra = {p["pid"]: p for p in all_processes if p["ppid"] in selected}
            size = len(selected); selected.update(extra)
            if len(selected) == size:
                break
        # subreaper 的新直接子代仍属于本次独占控制进程；不扫/终止共享 UID。
        # fixture 与 Playwright driver 在 owner 前已启动，其已有直接子代全部排除。
        for p in all_processes:
            if (p["ppid"] == os.getpid() and identity_key(p) not in self.existing_children
                    and (self.main_identity is None or p["start"] >= self.main_identity["start"])):
                selected[p["pid"]] = p
        if len(selected) > 128:
            self.error("owned process inventory 超过 128，资格不可完成")
        for p in selected.values():
            if p["uid"] != self.uid:
                self.error("owned process UID changed; 禁止信号")
            self.seen[identity_key(p)] = p
        self.receipt["processes"] = list(self.seen.values())
        return list(selected.values())

    def _pin(self, item):
        fd = os.pidfd_open(item["pid"])
        try:
            actual = process_identity(item["pid"])
            assert identity_key(actual) == identity_key(item), "owned PID identity changed"
            assert actual["uid"] == self.uid, "owned PID UID changed"
            return fd
        except BaseException:
            os.close(fd)
            raise

    def bind_browser(self, info):
        browsers = [p for p in info if p.get("type") == "browser"]
        assert len(browsers) == 1 and browsers[0]["id"] == self.process.pid, "CDP browser PID 不是本次 Popen PID"
        actual = process_identity(self.process.pid)
        assert self.main_identity is not None, "本次 browser PID 初始化身份缺失"
        assert identity_key(actual) == identity_key(self.main_identity), "本次 browser PID 身份发生变化"
        self.bound = True
        self.receipt["browserBound"] = True
        self.receipt["cdpBrowserProcess"] = browsers[0]
        self.members()
        self.save()

    def endpoint(self, timeout=5):
        deadline = monotonic() + timeout
        path = self.profile / "DevToolsActivePort"
        while monotonic() < deadline:
            assert self.process.poll() is None, "Chrome 在 endpoint 就绪前退出"
            self.members()
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
            except FileNotFoundError:
                sleep(min(.025, max(0, deadline - monotonic())))
                continue
            try:
                info = os.fstat(fd)
                assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "endpoint 文件类型错误"
                assert info.st_uid == self.uid and not info.st_mode & 0o022, "endpoint 文件归属错误"
                raw = os.read(fd, 1025)
            finally:
                os.close(fd)
            if not raw:  # 尚未写完第一个字节；不连接任何占位端口。
                sleep(min(.025, max(0, deadline - monotonic())))
                continue
            assert len(raw) <= 1024, "endpoint 文件过长"
            lines = raw.decode("ascii").splitlines()
            assert len(lines) == 2 and re.fullmatch(r"[0-9]{1,5}", lines[0]), "endpoint 格式错误"
            assert 1 <= int(lines[0]) <= 65535, "endpoint port 错误"
            assert re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]{1,128}", lines[1]), "endpoint 非 browser 路径"
            endpoint = "ws://127.0.0.1:" + lines[0] + lines[1]
            self.receipt["endpoint"] = endpoint
            self.save()
            return endpoint
        raise TimeoutError("本次 Chrome endpoint 未在 5 秒内就绪")

    def _reap_record(self, item, phase):
        key = identity_key(item)
        now = round(monotonic() * 1000)
        if key not in self.reap_observations:
            if len(self.reap_observations) >= 128:
                self.error("orphan wait identity 超过 128，资格不可完成")
                return None, None
            record = {"identity": dict(item), "state": "PENDING", "attempts": 0,
                      "firstObservedMonotonicMs": now, "phases": []}
            self.reap_observations[key] = record
            self.receipt["orphanReapObservations"].append(record)
        record = self.reap_observations[key]
        record.update(lastObservedMonotonicMs=now, lastIdentity=dict(item))
        record["attempts"] += 1
        entry = next((p for p in record["phases"] if p["phase"] == phase), None)
        if entry is None:
            entry = {"phase": phase, "firstAttemptMonotonicMs": now,
                     "attempts": 0, "notReadyCount": 0}
            record["phases"].append(entry)
        entry.update(lastAttemptMonotonicMs=now, attempts=entry["attempts"] + 1)
        return record, entry

    def _reap_failure(self, record, entry, step, error):
        item = record["identity"]
        record["state"] = "FAILED"
        self.attempted.add(identity_key(item))
        entry["error"] = {"step": step, "monotonicMs": round(monotonic() * 1000),
                          "name": type(error).__name__, "errno": getattr(error, "errno", None),
                          "message": str(error)[:512]}
        self.error(f"{entry['phase']}/{step} owned PID {item['pid']} start {item['start']} "
                   f"UID {item['uid']}: {type(error).__name__}: {error}")

    def _reap(self, phase="unspecified"):
        assert phase in ("unspecified", "natural", "term", "kill", "final")
        self.process.poll()  # Popen 只 wait 本次直接子代。
        members = self.members()
        current = {identity_key(item): item for item in members}
        for key, record in list(self.reap_observations.items()):
            if record["state"] == "PENDING" and key not in current:
                record, entry = self._reap_record(record["identity"], phase)
                self._reap_failure(record, entry, "inventory",
                                   RuntimeError("pending identity 消失，但没有 matching terminal consume"))
        for item in members:
            key = identity_key(item)
            if item["pid"] == self.process.pid or key in self.attempted:
                continue
            if item["state"] != "Z" or item["ppid"] != os.getpid():
                if key in self.reap_observations:
                    record, entry = self._reap_record(item, phase)
                    self._reap_failure(record, entry, "inventory",
                                       RuntimeError("pending identity 不再是本 owner 的直接 Z 子代"))
                continue
            record, entry = self._reap_record(item, phase)
            if record is None:
                continue
            fd = None
            step = "pin"
            try:
                fd = self._pin(item)
                flags = os.WEXITED | os.WNOHANG
                fields = ("si_pid", "si_uid", "si_signo", "si_code", "si_status")
                step = "peek"
                entry["lastWaitRequest"] = {"step": step, "monotonicMs": round(monotonic() * 1000),
                                            "idtype": int(os.P_PIDFD), "options": flags | os.WNOWAIT}
                peek = os.waitid(os.P_PIDFD, fd, flags | os.WNOWAIT)
                before = {k: getattr(peek, k) for k in fields} if peek is not None else None
                observed = {"monotonicMs": round(monotonic() * 1000), "idtype": int(os.P_PIDFD),
                            "idtypeName": "P_PIDFD", "options": flags | os.WNOWAIT, "raw": before}
                entry.setdefault("firstPeek", observed)
                entry["lastPeek"] = observed
                if peek is None:
                    entry["notReadyCount"] += 1
                    continue  # 合法 WNOHANG pending；不丢身份，也不越过原等待期限。
                assert peek.si_pid == item["pid"] and peek.si_uid == item["uid"], "没有真实 matching terminal wait"
                assert peek.si_signo == signal.SIGCHLD and peek.si_code in (
                    os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED), "wait 不是合法 terminal 事件"
                step = "consume"
                entry["lastWaitRequest"] = {"step": step, "monotonicMs": round(monotonic() * 1000),
                                            "idtype": int(os.P_PIDFD), "options": flags}
                consumed = os.waitid(os.P_PIDFD, fd, flags)
                after = {k: getattr(consumed, k) for k in fields} if consumed is not None else None
                entry["consume"] = {"monotonicMs": round(monotonic() * 1000), "idtype": int(os.P_PIDFD),
                                    "idtypeName": "P_PIDFD", "options": flags, "raw": after}
                assert before == after, "terminal peek/consume mismatch"
                self.receipt["orphanWaits"].append({"identity": item, "peek": before, "consumed": after})
                record["state"] = "COMPLETED"
                self.attempted.add(key)
            except Exception as error:
                self._reap_failure(record, entry, step, error)
            finally:
                if fd is not None:
                    os.close(fd)
        self.receipt["unresolvedOrphanWaits"] = [
            {"identity": r["identity"], "state": r["state"]}
            for r in self.reap_observations.values() if r["state"] != "COMPLETED"]

    def _wait_empty(self, seconds, phase="unspecified"):
        started = monotonic()
        deadline = started + seconds
        observation = {"phase": phase, "limitSeconds": seconds,
                       "startedMonotonicMs": round(started * 1000)}
        self.receipt.setdefault("waitPhases", []).append(observation)
        while True:
            self._reap(phase)
            remaining = self.members()
            if not remaining and self.process.poll() is not None:
                break
            if monotonic() >= deadline:
                observation["deadlineReached"] = True
                break
            sleep(min(.025, max(0, deadline - monotonic())))
        observation.update(elapsedMs=round((monotonic() - started) * 1000), remaining=remaining,
                           unresolvedOrphanWaits=self.receipt["unresolvedOrphanWaits"])
        return remaining

    def _signal(self, number):
        for item in self.members():
            if item["state"] == "Z":
                continue
            fd = None
            try:
                fd = self._pin(item)
                signal.pidfd_send_signal(fd, number)
                self.receipt["signals"].append({"pid": item["pid"], "start": item["start"],
                                                "uid": item["uid"], "signal": number})
            except (FileNotFoundError, ProcessLookupError):
                pass
            except Exception as error:
                self.error(error)
            finally:
                if fd is not None:
                    os.close(fd)

    def close(self, api_close):
        if self.closed:
            return self.receipt
        self.closed = True
        remaining = []
        try:
            if self.process is not None:
                before = self.process.poll()
                self.receipt["beforeCloseExit"] = before
                if before is not None:
                    self.error("Chrome 在 API close 前已退出")
                if api_close is not None and self.bound and before is None:
                    try:
                        self.receipt["apiCloseStartedMonotonicMs"] = round(monotonic() * 1000)
                        self.receipt["apiClose"] = api_close()
                        self.receipt["apiCloseReturnedMonotonicMs"] = round(monotonic() * 1000)
                        if self.receipt["apiClose"].get("status") == "FAIL":
                            self.error("Browser.close helper/transport 未合格；原始事实见 apiClose")
                        assert self.receipt["apiClose"].get("requestSent"), "Browser.close 未发送"
                    except Exception as error:
                        self.error(error)
                else:
                    self.error("没有经 PID 绑定的 Browser.close")
                if self.receipt.get("apiClose", {}).get("requestSent"):
                    # 传输异常不抹掉已经验证的发送事实，也不把它当作进程退出。
                    started = monotonic()
                    observation = {"limitSeconds": 3, "startedMonotonicMs": round(started * 1000)}
                    self.receipt["naturalExitObservation"] = observation
                    remaining = self._wait_empty(3, "natural")
                    observation.update(elapsedMs=round((monotonic() - started) * 1000),
                                       remaining=remaining, rootExit=self.process.poll(),
                                       unresolvedOrphanWaits=self.receipt["unresolvedOrphanWaits"])
                else:
                    remaining = self.members()
                for number in (signal.SIGTERM, signal.SIGKILL):
                    if not remaining:
                        break
                    self.receipt["forced"] = True
                    self._signal(number)
                    remaining = self._wait_empty(3, "term" if number == signal.SIGTERM else "kill")
                self._reap("final")
                remaining = self.members()
                self.receipt["exitCode"] = self.process.poll()
                self.receipt["reaped"] = self.process.returncode is not None
                self.receipt["remaining"] = remaining
            if not remaining and (self.process is None or self.process.poll() is not None):
                info = self.profile.lstat()
                assert (info.st_dev, info.st_ino, info.st_uid) == self.profile_identity and stat.S_ISDIR(info.st_mode), "owned profile 身份变化"
                shutil.rmtree(self.profile)
                self.receipt["profileRemoved"] = not self.profile.exists()
            self.receipt["status"] = "PASS" if (
                self.receipt.get("exitCode") == 0 and self.receipt.get("reaped")
                and not remaining and not self.receipt["forced"] and not self.receipt["errors"]
                and not self.receipt["unresolvedOrphanWaits"]
                and self.receipt.get("profileRemoved")) else "FAIL"
        except Exception as error:
            self.error(error)
            self.receipt["status"] = "FAIL"
        finally:
            if self.log:
                self.log.close()
            self.save()
        return self.receipt



FRAME_AUDIT_JS = r"""
// 只读有界帧尾审计；握手、UTF-8 和完整协议校验仍由公开 ws 执行。
function createFrameAudit() {
  const limitBytes = 65536, limitFrames = 32;
  let bytes = 0, frames = 0, pending = Buffer.alloc(0), fragment = 0;
  let closeFrameSeen = false, closeCode = null, error = null, errorOffset = null;
  const fail = reason => {
    if (!error) { error = reason; errorOffset = bytes - pending.length; }
  };
  return {
    append(chunk) {
      bytes += chunk.length;
      if (bytes > limitBytes) { fail('wire byte limit'); return; }
      if (error) return;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (closeFrameSeen) { fail('bytes after Close frame'); break; }
        if (frames >= limitFrames) { fail('wire frame limit'); break; }
        if (pending.length < 2) break;
        const first = pending[0], second = pending[1], fin = !!(first & 128);
        const opcode = first & 15, marker = second & 127;
        if (first & 112) { fail('unexpected RSV bits'); break; }
        if (second & 128) { fail('masked server frame'); break; }
        if (![0, 1, 2, 8, 9, 10].includes(opcode)) { fail('invalid opcode'); break; }
        if (opcode >= 8 && (!fin || marker > 125)) { fail('invalid control frame'); break; }
        let length = marker, header = 2;
        if (marker === 126) {
          if (pending.length < 4) break;
          length = pending.readUInt16BE(2); header = 4;
          if (length < 126) { fail('non-minimal frame length'); break; }
        } else if (marker === 127) {
          if (pending.length < 10) break;
          const wide = pending.readBigUInt64BE(2); header = 10;
          if (wide < 65536n || wide > BigInt(limitBytes)) { fail('invalid or excessive frame length'); break; }
          length = Number(wide);
        }
        if (header + length > limitBytes) { fail('wire frame length limit'); break; }
        if (pending.length < header + length) break;
        if (opcode === 0) {
          if (!fragment) { fail('continuation without fragmented message'); break; }
          if (fin) fragment = 0;
        } else if (opcode === 1 || opcode === 2) {
          if (fragment) { fail('new message before final continuation'); break; }
          if (!fin) fragment = opcode;
        } else if (opcode === 8) {
          if (length === 1) { fail('incomplete Close code'); break; }
          closeFrameSeen = true;
          closeCode = length >= 2 ? pending.readUInt16BE(header) : null;
        }
        frames++;
        pending = pending.subarray(header + length);
      }
    },
    snapshot() {
      return {bytes, frames, pendingBytes:pending.length, fragmentOpen:!!fragment,
        closeFrameSeen, closeCode, error, errorOffset, limitBytes, limitFrames,
        complete:!error && pending.length === 0 && !fragment};
    }
  };
}
"""


def parse_close_helper_receipt(stdout, stderr, returncode, binding, timed_out=False):
    """先保全发送/ACK，再独立核 wire 和模块事实；进程 wait 仍由 owner 完成。"""
    text = lambda value: value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
    stdout, stderr = text(stdout), text(stderr)
    receipt = {"helperExit": returncode, "helperTimedOut": timed_out, "status": "FAIL",
               "receiptValid": False, "requestSent": False, "reply": False,
               "helperStdout": stdout[:8192], "helperStderr": stderr[:1024]}
    stage = "receipt-structure"
    try:
        assert len(stdout) <= 8192, "helper stdout 超过观察上限"
        value = json.loads(stdout)
        assert type(value) is dict and value.get("schema") == 1, "helper receipt schema 缺失"
        assert type(value.get("helperPid")) is int and value["helperPid"] > 0, "helper PID 缺失"
        assert value.get("request") == {"id": 1, "method": "Browser.close"}, "helper request 身份不符"
        assert all(type(value.get(key)) is bool for key in ("requestSent", "reply", "socketClosed")), "helper 状态不是布尔值"
        assert isinstance(value.get("events"), list) and len(value["events"]) <= 16, "helper 时序缺失/超限"
        for key in ("schema", "helperPid", "request", "requestSent", "socketClosed", "response", "events",
                    "clock", "error", "transportError", "closeCode", "closeReason", "droppedEvents", "deadlineReached",
                    "wire", "moduleBinding"):
            if key in value:
                receipt[key] = value[key]
        if "response" in value:
            response = value["response"]
            assert isinstance(response, dict) and response.get("id") == 1, "CDP reply id 不匹配"
            assert "error" not in response and type(response.get("result")) is dict, "CDP 拒绝/无有效 result"
        if value["reply"]:
            assert value["requestSent"] and "response" in value, "没有匹配请求/回复，不能 ACK"
            receipt["reply"] = True

        root = Path(__file__).resolve().parents[1]
        stage = "binding-validation"
        binding = validate_binding(binding)
        stage = "module-binding"
        expected = binding["closeTransport"]
        module = value["moduleBinding"]
        assert module["package"] == expected["package"] and module["version"] == expected["version"], "ws 包身份不符"
        assert module["realpath"] == str(root / expected["root"]), "ws 不是本 checkout 的直接依赖"
        assert module["entryRealpath"] == str(root / expected["root"] / expected["entry"]), "ws 公开入口不符"
        assert module["sha256"] == expected["sha256"] and module["producer"] == expected["producer"], "ws 字节/producer 绑定不符"
        binding_sha = hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        assert module["bindingSha256"] == binding_sha and module["source"] == binding["source"], "helper 使用的 caller binding 不符"
        environment = binding["dependencies"]["environment"]
        assert module["runtime"] == {key: environment[key] for key in ("node", "abi", "platform", "arch", "libc")}, "helper runtime 与本轮 producer 不符"
        assert module.get("verified") is True, "ws 模块未完成读回"
        stage = "wire-validation"
        wire, raw, audit = value["wire"], value["wire"]["raw"], value["wire"]["audit"]
        assert type(wire) is dict and type(raw) is dict and type(audit) is dict, "wire 观察对象缺失"
        assert "wsError" in wire and "error" in raw and "error" in audit, "wire 错误观察字段缺失"
        assert wire.get("schema") == 1, "wire schema 缺失"
        assert all(type(raw.get(k)) is bool for k in ("endSeen", "closeSeen", "hadError")), "raw Socket 终态不完整"
        assert all(type(audit.get(k)) is bool for k in ("complete", "fragmentOpen", "closeFrameSeen")), "帧尾状态不完整"
        assert all(type(audit.get(k)) is int and audit[k] >= 0 for k in ("bytes", "frames", "pendingBytes")), "帧计数不完整"
        assert type(wire.get("localAbort")) is bool, "本地中止状态缺失"
        assert type(value.get("droppedEvents")) is int and value["droppedEvents"] >= 0, "观察截断状态缺失"
        receipt["receiptValid"] = True
        kind = ("PEER_CLOSE" if audit["closeFrameSeen"] and audit["closeCode"] == 1000 and value.get("closeCode") == 1000
                else "EOF_AFTER_ACK" if not audit["closeFrameSeen"] and value.get("closeCode") == 1006
                else "INVALID_OR_UNKNOWN")
        counts = (type(wire.get("bytesReadStart")) is int and type(wire.get("bytesReadEnd")) is int
                  and wire["bytesReadEnd"] - wire["bytesReadStart"] == audit["bytes"])
        complete = (wire.get("observationReady") is True and wire.get("sameSocket") is True
                    and type(wire.get("upgradeHeadBytes")) is int and wire["upgradeHeadBytes"] == 0
                    and counts and raw["endSeen"] and raw["closeSeen"] and not raw["hadError"]
                    and raw.get("error") is None and wire.get("wsError") is None and not wire["localAbort"]
                    and audit["complete"] and audit.get("error") is None
                    and audit["pendingBytes"] == 0 and not audit["fragmentOpen"]
                    and 0 < audit["bytes"] <= 65536 and 0 < audit["frames"] <= 32
                    and isinstance(wire.get("sha256"), str) and re.fullmatch(r"[0-9a-f]{64}", wire["sha256"]) is not None)
        if (returncode == 0 and not timed_out and value["requestSent"] and receipt["reply"] and value["socketClosed"]
                and complete and kind != "INVALID_OR_UNKNOWN" and wire.get("transportClass") == kind
                and value.get("error") is None and value.get("transportError") is None
                and not value.get("deadlineReached") and value["droppedEvents"] == 0):
            receipt["status"] = "PASS"
    except (AssertionError, ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError) as error:
        receipt["receiptError"] = str(error)[:512]
        receipt["receiptErrorStage"] = stage
        receipt["receiptErrorType"] = type(error).__name__
    return receipt


def close_browser_endpoint(endpoint, binding):
    """只发本次 endpoint 的 Browser.close；协议/wire/进程三种完成证据分开。"""
    code = FRAME_AUDIT_JS + r"""
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
const started = performance.now();
const audit = createFrameAudit(), digest = createHash('sha256');
const wire = {schema:1, transportClass:'INVALID_OR_UNKNOWN', observationReady:false, sameSocket:false,
  upgradeHeadBytes:null, bytesReadStart:null, bytesReadEnd:null, localAbort:false, wsError:null,
  raw:{endSeen:false, closeSeen:false, hadError:null, error:null}};
const receipt = {schema:1, helperPid:process.pid, request:{id:1, method:'Browser.close'},
  requestSent:false, reply:false, socketClosed:false, events:[], droppedEvents:0, wire,
  clock:{startedWallTime:new Date().toISOString(), unit:'milliseconds since helper start'}};
const record = (kind, detail={}) => {
  if (receipt.events.length < 16) receipt.events.push({kind, elapsedMs:performance.now()-started, ...detail});
  else receipt.droppedEvents++;
};
const describeError = error => {
  const result = {};
  for (const key of ['name','message','code','errno','syscall'])
    if (['string','number'].includes(typeof error?.[key])) result[key] = String(error[key]).slice(0,512);
  if (typeof error?.stack === 'string') result.stack = error.stack.slice(0,1536);
  return result;
};
let done = false, rawSocket = null, socket = null, scheduled = false;
const fail = reason => { if (!receipt.error) receipt.error = String(reason).slice(0,512); };
const finish = () => {
  if (done) return; done = true; clearTimeout(timer);
  wire.audit = audit.snapshot(); wire.sha256 = digest.copy().digest('hex');
  if (rawSocket) wire.bytesReadEnd = rawSocket.bytesRead;
  const okay = !receipt.error && !receipt.transportError && !receipt.droppedEvents &&
    wire.transportClass !== 'INVALID_OR_UNKNOWN';
  record('finish', {exitCode:okay ? 0 : 1});
  process.stdout.write(JSON.stringify(receipt) + '\n', () => process.exit(okay && !receipt.droppedEvents ? 0 : 1));
};
const abort = reason => {
  fail(reason); wire.localAbort = true;
  // 仅中止此 helper 自建的连接；从不借此宣称 Chrome 已退出。
  if (socket) socket.terminate();
  else if (rawSocket) rawSocket.destroy();
};
const timer = setTimeout(() => {
  receipt.deadlineReached = true; record('deadline');
  abort(receipt.error || 'Browser.close deadline'); finish();
}, 3000);
const settle = () => {
  if (done || scheduled || !wire.raw.closeSeen || !receipt.socketClosed) return;
  scheduled = true;
  setImmediate(() => {
    if (done) return;
    scheduled = false;
    // ws 的 raw-close handler 可能还会读取残余并结束 receiver；两终态后才封账。
    const tail = audit.snapshot();
    wire.bytesReadEnd = rawSocket.bytesRead;
    const complete = wire.observationReady && wire.sameSocket && wire.upgradeHeadBytes === 0 &&
      wire.bytesReadEnd - wire.bytesReadStart === tail.bytes && tail.bytes > 0 && tail.frames > 0 &&
      tail.complete && wire.raw.endSeen && !wire.raw.hadError && !wire.raw.error && !wire.wsError && !wire.localAbort;
    if (!complete) fail(tail.error || 'wire EOF/error/byte completeness not verified');
    if (!receipt.requestSent || !receipt.reply) fail('CDP close without matching successful reply');
    if (complete && receipt.requestSent && receipt.reply && !receipt.error && !receipt.transportError) {
      if (tail.closeFrameSeen && tail.closeCode === 1000 && receipt.closeCode === 1000)
        wire.transportClass = 'PEER_CLOSE';
      else if (!tail.closeFrameSeen && receipt.closeCode === 1006)
        wire.transportClass = 'EOF_AFTER_ACK';
      else fail('unverified peer Close code');
    }
    finish();
  });
};
try {
  const endpoint = new URL(process.argv[1]);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname)) throw Error('unowned endpoint');
  const root = realpathSync(process.argv[2]), contract = JSON.parse(process.argv[3]);
  const expected = contract.closeTransport, producer = contract.dependencies;
  if (expected.package !== 'ws' || expected.version !== '8.22.0' || expected.root !== 'node_modules/ws' ||
      expected.entry !== 'index.js' || expected.producer.artifactId !== producer.artifactId ||
      expected.producer.tarSha256 !== producer.tarSha256 ||
      expected.producer.environmentSha256 !== producer.environmentSha256 ||
      expected.producer.lockSha256 !== producer.environment.lockSha256) throw Error('ws producer contract mismatch');
  const runtime = {node:process.version, abi:process.versions.modules, platform:process.platform,
    arch:process.arch, libc:process.report.getReport().header.glibcVersionRuntime};
  if (Object.keys(runtime).some(key => runtime[key] !== producer.environment[key])) throw Error('caller producer runtime mismatch');
  const require = createRequire(join(root, 'package.json'));
  const entry = require.resolve('ws'), packageFile = require.resolve('ws/package.json');
  const packageRoot = realpathSync(join(root, expected.root));
  if (packageRoot !== join(root, expected.root) || realpathSync(entry) !== join(packageRoot, expected.entry) ||
      realpathSync(packageFile) !== join(packageRoot, 'package.json')) throw Error('ws resolved outside direct dependency');
  const expectedFiles = ['index.js','lib/receiver.js','lib/websocket.js','package.json'];
  if (JSON.stringify(Object.keys(expected.sha256).sort()) !== JSON.stringify(expectedFiles)) throw Error('ws hash set mismatch');
  const hashes = {};
  for (const name of expectedFiles) {
    const path = join(packageRoot, name);
    if (!lstatSync(path).isFile() || realpathSync(path) !== path) throw Error('ws source path changed');
    hashes[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hashes[name] !== expected.sha256[name]) throw Error('ws source digest mismatch: ' + name);
  }
  if (createHash('sha256').update(readFileSync(join(root,'package-lock.json'))).digest('hex') !== expected.producer.lockSha256)
    throw Error('ws product lock mismatch');
  const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (metadata.name !== expected.package || metadata.version !== expected.version) throw Error('ws package version mismatch');
  receipt.moduleBinding = {verified:true, package:metadata.name, version:metadata.version, realpath:packageRoot,
    entryRealpath:realpathSync(entry), sha256:hashes, producer:expected.producer,
    bindingSha256:createHash('sha256').update(process.argv[3]).digest('hex'), source:contract.source, runtime,
    scope:'explicit caller source/producer runtime and public ws package bytes'};
  const WebSocket = require('ws'); // 公开根导出；不 deep-import SDK 或 ws 的私有字段。
  socket = new WebSocket(endpoint, {
    followRedirects:false, perMessageDeflate:false, skipUTF8Validation:false, maxPayload:16384,
    allowSynchronousEvents:true,
    createConnection() {
      if (rawSocket) throw Error('unexpected second connection');
      rawSocket = createConnection({host:'127.0.0.1', port:Number(endpoint.port)});
      rawSocket.on('end', () => { wire.raw.endSeen = true; record('raw-end'); });
      rawSocket.on('error', error => {
        wire.raw.error ||= describeError(error); fail('raw Socket error');
        receipt.transportError ||= {eventType:'raw-error', error:wire.raw.error};
        record('raw-error', {error:wire.raw.error});
      });
      rawSocket.on('close', hadError => {
        wire.raw.closeSeen = true; wire.raw.hadError = hadError;
        if (hadError) fail('raw Socket close with transmission error');
        record('raw-close', {hadError}); settle();
      });
      return rawSocket;
    },
    finishRequest(request) {
      request.prependOnceListener('upgrade', (response, upgraded, head) => {
        wire.sameSocket = upgraded === rawSocket; wire.upgradeHeadBytes = head.length;
        record('upgrade', {sameSocket:wire.sameSocket, headBytes:head.length});
        if (!wire.sameSocket || head.length !== 0) fail('unobserved data at upgrade boundary');
      });
      request.end();
    }
  });
  socket.on('open', () => {
    if (done) return;
    if (receipt.error || !wire.sameSocket || wire.upgradeHeadBytes !== 0) return abort(receipt.error || 'upgrade observation missing');
    wire.bytesReadStart = rawSocket.bytesRead;
    rawSocket.on('data', chunk => {
      if (done) return;
      try {
        digest.update(chunk); audit.append(chunk);
        const state = audit.snapshot();
        if (state.error) {
          receipt.transportError ||= {eventType:'wire-audit', error:{name:'WireIntegrityError', message:state.error}};
          abort(state.error);
        }
      } catch (error) { abort('wire observation error: ' + String(error)); }
    });
    wire.observationReady = true; record('open');
    try {
      socket.send(JSON.stringify(receipt.request), error => {
        if (error) { receipt.transportError ||= {eventType:'send-error', error:describeError(error)}; abort('Browser.close send error'); }
      });
      receipt.requestSent = true; record('request-sent', {id:1, method:'Browser.close'});
    } catch (error) { abort('Browser.close send: ' + String(error)); }
  });
  socket.on('message', (data, isBinary) => {
    if (done || receipt.error) return;
    try {
      if (isBinary) throw Error('binary CDP reply');
      const text = data.toString('utf8'); record('message', {bytes:data.length});
      if (text.length > 4096) throw Error('CDP reply observation limit');
      const message = JSON.parse(text);
      if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) {
        receipt.response = message;
        if (message.id !== 1) throw Error('CDP reply id mismatch');
        if ('error' in message) throw Error(JSON.stringify(message.error));
        if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) throw Error('CDP reply missing result');
        receipt.reply = true; record('matching-reply', {id:1});
      }
    } catch (error) { abort(error); }
  });
  socket.on('error', error => {
    if (done) return;
    wire.wsError ||= describeError(error);
    receipt.transportError ||= {eventType:'ws-error', error:wire.wsError};
    fail('WebSocket protocol/transport error'); record('ws-error', {error:wire.wsError});
  });
  socket.on('close', (code, reason) => {
    if (done) return;
    receipt.socketClosed = true; receipt.closeCode = code; receipt.closeReason = String(reason).slice(0,256);
    record('ws-close', {code, reason:receipt.closeReason}); settle();
  });
} catch (error) {
  fail(error); record('setup-error', {error:describeError(error)});
  if (rawSocket) abort(error);
  else finish();
}
"""
    try:
        root = Path(__file__).resolve().parents[1]
        binding = validate_binding(binding)
        settings = json.dumps(binding, sort_keys=True, separators=(",", ":"))
    except (AssertionError, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        return {"status": "FAIL", "requestSent": False, "reply": False, "receiptValid": False,
                "helperExit": None, "helperTimedOut": False, "helperErrorStage": "binding-validation",
                "helperError": f"{type(error).__name__}: {error}"}
    try:
        result = subprocess.run(["node", "--input-type=module", "-e", code, endpoint, str(root), settings],
                                cwd=root, capture_output=True, text=True, timeout=4)
    except subprocess.TimeoutExpired as error:
        # subprocess.run 已 kill/wait 本次 helper；只保全实际 bytes，不补造发送或 EOF。
        return parse_close_helper_receipt(error.stdout, error.stderr, None, binding, timed_out=True)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        return {"status": "FAIL", "requestSent": False, "reply": False, "receiptValid": False,
                "helperExit": None, "helperTimedOut": False, "helperErrorStage": "node-helper",
                "helperError": f"{type(error).__name__}: {error}"}
    return parse_close_helper_receipt(result.stdout, result.stderr, result.returncode, binding)

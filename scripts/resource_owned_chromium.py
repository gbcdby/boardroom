"""资格控制专用 Chromium 所有权；不连接既有浏览器，不修改第三方 driver。"""
from __future__ import annotations

import ctypes
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
        self.attempted = set()
        self.existing_children = {identity_key(p) for p in _all_processes() if p["ppid"] == os.getpid()}
        self.receipt = {"status": "NOT_STARTED", "profile": str(self.profile), "profileMode": "0o700",
                        "processes": [], "signals": [], "orphanWaits": [], "errors": [],
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

    def _reap(self):
        self.process.poll()  # Popen 只 wait 本次直接子代。
        for item in self.members():
            key = identity_key(item)
            if item["pid"] == self.process.pid or item["state"] != "Z" or item["ppid"] != os.getpid() or key in self.attempted:
                continue
            self.attempted.add(key)
            fd = None
            try:
                fd = self._pin(item)
                flags = os.WEXITED | os.WNOHANG
                peek = os.waitid(os.P_PIDFD, fd, flags | os.WNOWAIT)
                assert peek and peek.si_pid == item["pid"] and peek.si_uid == item["uid"], "没有真实 matching terminal wait"
                consumed = os.waitid(os.P_PIDFD, fd, flags)
                fields = ("si_pid", "si_uid", "si_code", "si_status")
                before = {k: getattr(peek, k) for k in fields}
                after = {k: getattr(consumed, k) for k in fields} if consumed else None
                assert before == after, "terminal peek/consume mismatch"
                self.receipt["orphanWaits"].append({"identity": item, "peek": before, "consumed": after})
            except (FileNotFoundError, ProcessLookupError):
                pass
            except Exception as error:
                self.error(error)
            finally:
                if fd is not None:
                    os.close(fd)

    def _wait_empty(self, seconds):
        deadline = monotonic() + seconds
        while True:
            self._reap()
            remaining = self.members()
            if not remaining and self.process.poll() is not None:
                return []
            if monotonic() >= deadline:
                return remaining
            sleep(min(.025, max(0, deadline - monotonic())))

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
                    remaining = self._wait_empty(3)
                    observation.update(elapsedMs=round((monotonic() - started) * 1000),
                                       remaining=remaining, rootExit=self.process.poll())
                else:
                    remaining = self.members()
                for number in (signal.SIGTERM, signal.SIGKILL):
                    if not remaining:
                        break
                    self.receipt["forced"] = True
                    self._signal(number)
                    remaining = self._wait_empty(3)
                self._reap()
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
                and self.receipt.get("profileRemoved")) else "FAIL"
        except Exception as error:
            self.error(error)
            self.receipt["status"] = "FAIL"
        finally:
            if self.log:
                self.log.close()
            self.save()
        return self.receipt


def parse_close_helper_receipt(stdout, stderr, returncode, timed_out=False):
    """先保全/核对事实，再分类 helper 结果；非零退出不能丢失已发送收据。"""
    text = lambda value: value.decode("utf-8", errors="replace") if isinstance(value, bytes) else (value or "")
    stdout, stderr = text(stdout), text(stderr)
    receipt = {"helperExit": returncode, "helperTimedOut": timed_out, "status": "FAIL",
               "receiptValid": False, "requestSent": False, "reply": False,
               "helperStdout": stdout[:8192], "helperStderr": stderr[:1024]}
    try:
        assert len(stdout) <= 8192, "helper stdout 超过观察上限"
        value = json.loads(stdout)
        assert type(value) is dict and value.get("schema") == 1, "helper receipt schema 缺失"
        assert type(value.get("helperPid")) is int and value["helperPid"] > 0, "helper PID 缺失"
        assert value.get("request") == {"id": 1, "method": "Browser.close"}, "helper request 身份不符"
        assert all(type(value.get(key)) is bool for key in ("requestSent", "reply", "socketClosed")), "helper 状态不是布尔值"
        assert isinstance(value.get("events"), list) and len(value["events"]) <= 16, "helper 时序缺失/超限"
        for key in ("schema", "helperPid", "request", "requestSent", "socketClosed", "response", "events",
                    "clock", "error", "transportError", "closeCode", "closeReason", "wasClean", "droppedEvents", "deadlineReached"):
            if key in value:
                receipt[key] = value[key]
        # 从这里开始，requestSent 与 response/transport 的有效性分别记账。
        if "response" in value:
            response = value["response"]
            assert isinstance(response, dict) and response.get("id") == 1, "CDP reply id 不匹配"
            assert "error" not in response and type(response.get("result")) is dict, "CDP 拒绝/无有效 result"
        if value["reply"]:
            assert value["requestSent"] and "response" in value, "没有匹配请求/回复，不能 ACK"
            receipt["reply"] = True
        receipt["receiptValid"] = True
        if (returncode == 0 and not timed_out and value["requestSent"] and receipt["reply"] and value["socketClosed"]
                and value.get("closeCode") == 1000 and value.get("wasClean") is True
                and not value.get("error") and not value.get("transportError") and not value.get("droppedEvents")):
            receipt["status"] = "PASS"
    except (AssertionError, ValueError, TypeError) as error:
        receipt["receiptError"] = str(error)[:512]
    return receipt


def close_browser_endpoint(endpoint):
    """使用本次已绑定 endpoint 的标准 CDP Browser.close；4 秒内实际 wait helper。"""
    code = r"""
const endpoint = new URL(process.argv[1]);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
    endpoint.username || endpoint.password || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname))
  throw Error('unowned endpoint');
const started = performance.now();
const receipt = {schema:1, helperPid:process.pid, request:{id:1, method:'Browser.close'},
  requestSent:false, reply:false, socketClosed:false, events:[], droppedEvents:0,
  clock:{startedWallTime:new Date().toISOString(), unit:'milliseconds since helper start'}};
const record = (kind, detail={}) => {
  if (receipt.events.length < 16) receipt.events.push({kind, elapsedMs:performance.now()-started, ...detail});
  else receipt.droppedEvents++;
};
const describeError = (error, depth=0) => {
  if (error == null) return null;
  const result = {};
  for (const key of ['name','message','code','errno','syscall'])
    if (['string','number'].includes(typeof error[key])) result[key] = String(error[key]).slice(0,512);
  if (depth === 0 && typeof error.stack === 'string') result.stack = error.stack.slice(0,1536);
  if (error.cause && depth < 2) result.cause = describeError(error.cause, depth+1);
  return result;
};
let done = false;
const finish = (error) => {
  if (done) return; done = true; clearTimeout(timer);
  if (error) receipt.error = String(error).slice(0,512);
  record('finish', {exitCode:error ? 1 : 0});
  process.stdout.write(JSON.stringify(receipt) + '\n', () => process.exit(error ? 1 : 0));
};
const timer = setTimeout(() => {
  receipt.deadlineReached = true; record('deadline');
  finish(receipt.error || 'Browser.close deadline');
}, 3000);
const socket = new WebSocket(endpoint);
socket.addEventListener('open', () => {
  if (done) return;
  record('open');
  socket.send(JSON.stringify(receipt.request));
  receipt.requestSent = true;
  record('request-sent', {id:1, method:'Browser.close'});
});
socket.addEventListener('message', ({data}) => {
  if (done) return;
  try {
    const text = String(data);
    record('message', {bytes:Buffer.byteLength(text)});
    if (text.length > 4096) throw Error('CDP reply observation limit');
    const message = JSON.parse(text);
    if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) {
      receipt.response = message;
      if (message.id !== 1) return finish('CDP reply id mismatch');
      if ('error' in message) return finish(JSON.stringify(message.error));
      if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result))
        return finish('CDP reply missing result');
      receipt.reply = true;
      record('matching-reply', {id:1});
    }
  } catch(error) { finish(error); }
});
socket.addEventListener('close', ({code, reason, wasClean}) => {
  if (done) return;
  receipt.socketClosed = true; receipt.closeCode = code;
  receipt.closeReason = String(reason).slice(0,256); receipt.wasClean = wasClean;
  record('close', {code, wasClean, reason:receipt.closeReason});
  finish(receipt.error || (!receipt.requestSent ? 'closed before Browser.close' :
    !receipt.reply ? 'CDP close without matching successful reply' :
    (!wasClean || code !== 1000) ? 'CDP close not verified normal' : null));
});
socket.addEventListener('error', event => {
  if (done) return;
  receipt.error = 'CDP socket error';
  receipt.transportError = {eventType:event.type, eventClass:event.constructor?.name,
    message:String(event.message || '').slice(0,512), error:describeError(event.error)};
  record('error', receipt.transportError);
  // 在原3秒期限内旁录随后可能发生的 close；保留 error，绝不改判为成功。
});
"""
    try:
        result = subprocess.run(["node", "--input-type=module", "-e", code, endpoint],
                                capture_output=True, text=True, timeout=4)
        return parse_close_helper_receipt(result.stdout, result.stderr, result.returncode)
    except subprocess.TimeoutExpired as error:
        # subprocess.run 已 kill/wait 本次 helper；只保全实际捕获的 bytes，不补造发送。
        return parse_close_helper_receipt(error.stdout, error.stderr, None, timed_out=True)
    except OSError as error:
        return {"status": "FAIL", "requestSent": False, "reply": False, "receiptValid": False,
                "helperExit": None, "helperError": f"{type(error).__name__}: {error}"}

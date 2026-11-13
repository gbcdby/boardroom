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
                        self.receipt["apiClose"] = api_close()
                        assert self.receipt["apiClose"].get("requestSent"), "Browser.close 未发送"
                    except Exception as error:
                        self.error(error)
                else:
                    self.error("没有经 PID 绑定的 Browser.close")
                remaining = self._wait_empty(3) if self.receipt.get("apiClose", {}).get("requestSent") else self.members()
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


def close_browser_endpoint(endpoint):
    """使用本次已绑定 endpoint 的标准 CDP Browser.close；4 秒内实际 wait helper。"""
    code = r"""
const endpoint = new URL(process.argv[1]);
if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
    endpoint.username || endpoint.password || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname))
  throw Error('unowned endpoint');
const receipt = {helperPid:process.pid, requestSent:false, reply:false, socketClosed:false};
let done = false;
const finish = (error) => {
  if (done) return; done = true; clearTimeout(timer);
  if (error) receipt.error = String(error).slice(0,512);
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exit(error ? 1 : 0);
};
const timer = setTimeout(() => finish('Browser.close deadline'), 3000);
const socket = new WebSocket(endpoint);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({id:1, method:'Browser.close'}));
  receipt.requestSent = true;
});
socket.addEventListener('message', ({data}) => {
  try {
    const message = JSON.parse(String(data));
    if (message.id === 1) {
      if (message.error) return finish(JSON.stringify(message.error));
      receipt.reply = true;
    }
  } catch(error) { finish(error); }
});
socket.addEventListener('close', ({code}) => {
  receipt.socketClosed = true; receipt.closeCode = code;
  finish(receipt.requestSent ? null : 'closed before Browser.close');
});
socket.addEventListener('error', () => finish('CDP socket error'));
"""
    result = subprocess.run(["node", "--input-type=module", "-e", code, endpoint],
                            capture_output=True, text=True, timeout=4)
    assert result.returncode == 0, "Browser.close helper: " + result.stderr[:512] + result.stdout[:1024]
    receipt = json.loads(result.stdout)
    assert receipt["requestSent"], "Browser.close 没有实际发送收据"
    return {**receipt, "helperExit": result.returncode}

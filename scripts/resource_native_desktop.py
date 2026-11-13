"""为资源浏览器验收创建并回收专属 Xvfb/Openbox；不接入已有 DISPLAY。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import subprocess
import tempfile
from time import monotonic, sleep


class NativeDesktop:
    def __init__(self, output: Path):
        self.output = output
        output.mkdir(parents=True, exist_ok=True)
        self.receipt = {"status": "NOT_READY", "processes": [], "cleanup": [], "errors": []}
        self.processes: list[tuple[str, subprocess.Popen]] = []
        self.logs = []
        self.temporary = None
        self.closed = False
        self.env = dict(os.environ)

    def _save(self):
        (self.output / "desktop.json").write_text(json.dumps(self.receipt, ensure_ascii=False, indent=2))

    def _spawn(self, name, argv, **kwargs):
        log = (self.output / f"{name}.log").open("wb")
        self.logs.append(log)
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   env=self.env, **kwargs)
        self.processes.append((name, process))
        self.receipt["processes"].append({"name": name, "pid": process.pid, "argv": argv})
        self._save()
        return process

    def _auth(self, executable, authority, display, cookie):
        # Cookie 只通过 stdin 写入本次 0700 临时目录，不进入 argv、日志或产物。
        result = subprocess.run([executable, "-f", str(authority), "source", "-"],
                                input=f"add {display} MIT-MAGIC-COOKIE-1 {cookie}\n", text=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
        if result.returncode != 0:
            raise RuntimeError(f"专属 Xauthority 初始化失败（exit {result.returncode}）")

    @staticmethod
    def _display_number(fd):
        deadline, data = monotonic() + 5, b""
        while monotonic() < deadline and len(data) < 32:
            ready, _, _ = select.select([fd], [], [], max(0, deadline - monotonic()))
            if not ready:
                break
            chunk = os.read(fd, 32 - len(data))
            if not chunk:
                break
            data += chunk
            if b"\n" in data:
                if not re.fullmatch(rb"[0-9]{1,5}\n", data):
                    break
                return ":" + data.decode().strip()
        raise RuntimeError("Xvfb 未在 5 秒准备期限内返回合法的专属 display")

    def _property(self, executable, target, deadline, *names):
        remaining = deadline - monotonic()
        if remaining <= 0:
            return ""
        result = subprocess.run([executable, *target, *names], env=self.env,
                                capture_output=True, text=True, timeout=min(1, remaining))
        return result.stdout[:4096] if result.returncode == 0 else ""

    def start(self):
        try:
            programs = {name: shutil.which(name) for name in ("Xvfb", "openbox", "xprop", "xauth")}
            self.receipt["executables"] = programs
            missing = [name for name, path in programs.items() if not path]
            if missing:
                raise RuntimeError("原生桌面依赖缺失：" + ", ".join(missing))
            self.temporary = tempfile.TemporaryDirectory(prefix="boardroom-resource-desktop-")
            root = Path(self.temporary.name)
            self.receipt["temporaryRoot"] = str(root)
            authority = root / "Xauthority"
            authority.touch(mode=0o600)
            cookie = secrets.token_hex(16)
            # X server 使用记录的协议与 cookie；在它启动前已有非空授权文件。
            # 得到 -displayfd 分配的号码后，为客户端添加对应 display 的同一 cookie。
            self._auth(programs["xauth"], authority, ":0", cookie)
            self.env["XAUTHORITY"] = str(authority)
            self.env.pop("DISPLAY", None)
            self.env.pop("WAYLAND_DISPLAY", None)
            read_fd, write_fd = os.pipe()
            try:
                try:
                    self._spawn("xvfb", [programs["Xvfb"], "-displayfd", str(write_fd),
                                "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-noreset",
                                "-auth", str(authority)], pass_fds=(write_fd,))
                finally:
                    os.close(write_fd)
                self.env["DISPLAY"] = self._display_number(read_fd)
            finally:
                os.close(read_fd)
            self._auth(programs["xauth"], authority, self.env["DISPLAY"], cookie)
            self.receipt["display"] = self.env["DISPLAY"]
            self.receipt["authorityMode"] = oct(authority.stat().st_mode & 0o777)
            config = root / "openbox.xml"
            config.write_text('<openbox_config xmlns="http://openbox.org/3.4/rc">'
                              '<focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>'
                              '</openbox_config>')
            self._spawn("openbox", [programs["openbox"], "--sm-disable", "--config-file", str(config)])
            deadline = monotonic() + 5
            while monotonic() < deadline:
                self.check_alive()
                root_property = self._property(programs["xprop"], ["-root"], deadline, "_NET_SUPPORTING_WM_CHECK")
                match = re.search(r"window id # (0x[0-9a-fA-F]+)", root_property)
                if match and int(match[1], 16) != 0:
                    child = self._property(programs["xprop"], ["-id", match[1]], deadline,
                                           "_NET_SUPPORTING_WM_CHECK", "_NET_WM_NAME")
                    child_match = re.search(r"window id # (0x[0-9a-fA-F]+)", child)
                    if child_match and int(child_match[1], 16) == int(match[1], 16) and '"Openbox"' in child:
                        self.receipt["wmCheck"] = {"root": root_property, "child": child}
                        self.receipt["status"] = "READY"
                        self._save()
                        return self.env
                sleep(min(0.05, max(0, deadline - monotonic())))  # 仅环境准备，不推进页面时钟或重试产品。
            raise RuntimeError("Openbox 未在 5 秒准备期限内发布一致的 EWMH 身份")
        except Exception as error:
            self.receipt["status"] = "FAIL"
            self.receipt["errors"].append(str(error))
            self._save()
            raise

    def check_alive(self):
        for name, process in self.processes:
            if process.poll() is not None:
                raise RuntimeError(f"本次 {name} 提前退出：{process.returncode}")

    def close(self):
        if self.closed:
            return self.receipt
        self.closed = True
        failed = False
        for name, process in reversed(self.processes):
            item = {"name": name, "pid": process.pid, "before": process.poll(), "forced": False}
            try:
                if item["before"] is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        item["forced"] = True
                        process.kill()
                        process.wait(timeout=3)
                elif self.receipt["status"] == "READY":
                    raise RuntimeError(f"本次 {name} 在清理前已退出：{process.returncode}")
            except Exception as error:
                failed = True
                self.receipt["errors"].append(str(error))
            item["exitCode"] = process.poll()
            item["reaped"] = process.returncode is not None
            failed = failed or item["forced"] or not item["reaped"]
            self.receipt["cleanup"].append(item)
        for log in self.logs:
            log.close()
        if self.temporary and all(process.returncode is not None for _, process in self.processes):
            self.temporary.cleanup()
            self.receipt["temporaryRootRemoved"] = not Path(self.temporary.name).exists()
        if failed:
            self.receipt["status"] = "FAIL"
        self.receipt["closed"] = True
        self._save()
        if failed:
            raise RuntimeError("专属原生桌面清理失败；见 native-desktop/desktop.json")
        return self.receipt

"""完整资源浏览器入口的共用原生会话；来自已实际资格化的 P4 路径。"""
from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
from time import monotonic, sleep

from resource_browser_binding import load_profile, validate_binding
from resource_owned_chromium import (OwnedChromium, close_browser_endpoint, compare_arguments,
                                    native_arguments, process_identity, identity_key)

ROOT = Path(__file__).resolve().parents[1]

class SDKCleanupDeadline(BaseException):
    """不能被 SDK 的普通 Exception 处理吞掉；不是 SDK 取消/退出证明。"""

def sdk_cleanup(report, stage, callback, seconds=3):
    """Linux 主线程的独立期限；失败后不再继续该 SDK 的产品场景。"""
    started = monotonic()
    item = {"stage": stage, "limitSeconds": seconds, "status": "FAIL"}
    previous = signal.getsignal(signal.SIGALRM)
    def expired(number, frame):
        raise SDKCleanupDeadline(stage + " cleanup deadline")
    signal.setitimer(signal.ITIMER_REAL, 0)
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        callback()
        item["status"] = "PASS"
    except BaseException as error:
        item["error"] = f"{type(error).__name__}: {error}"
        report["cleanupErrors"].append(stage + ": " + item["error"])
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
        item["elapsedMs"] = round((monotonic() - started) * 1000)
        report.setdefault("sdkCleanup", []).append(item)
    return item["status"] == "PASS"

class DriverProcess:
    """在首个 case 前固定本次 SDK 子进程；不以 SDK stop future 冒充 wait。"""
    def __init__(self, playwright):
        # 固定 1.62 的 PipeTransport 持有本次 create_subprocess_exec 的 Process。
        # 仅用于所有权/退出核对；不改 SDK 或 no_defaults 的公开行为。
        self.process = playwright._impl_obj._connection._transport._proc
        self.identity = process_identity(self.process.pid)
        assert self.identity["ppid"] == os.getpid() and self.identity["uid"] == os.getuid(), "driver 非本次子进程"
        self.fd = os.pidfd_open(self.process.pid)
        try:
            assert identity_key(process_identity(self.process.pid)) == identity_key(self.identity)
            self.receipt = {"identity": self.identity,
                            "executable": os.readlink(f"/proc/{self.process.pid}/exe"),
                            "argv": Path(f"/proc/{self.process.pid}/cmdline").read_bytes().decode().rstrip("\0").split("\0"),
                            "signals": [], "errors": [], "reaped": False, "status": "FAIL"}
            assert self.receipt["argv"][-1] == "run-driver", "driver argv 不符合固定 SDK"
        except BaseException:
            os.close(self.fd)
            raise

    def wait(self, seconds):
        deadline = monotonic() + seconds
        while True:
            # asyncio 的真实 child watcher 已 wait 时，其 returncode 是退出证据。
            if self.process.returncode is not None:
                self.receipt.update(reaped=True, exitCode=self.process.returncode, waitSource="asyncio-child-watcher")
                return True
            try:
                peek = os.waitid(os.P_PIDFD, self.fd, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if peek is not None:
                    assert peek.si_pid == self.identity["pid"] and peek.si_uid == self.identity["uid"]
                    assert peek.si_code in (os.CLD_EXITED, os.CLD_KILLED, os.CLD_DUMPED)
                    consumed = os.waitid(os.P_PIDFD, self.fd, os.WEXITED | os.WNOHANG)
                    assert consumed == peek, "driver terminal peek/consume mismatch"
                    values = {name: getattr(peek, name) for name in ("si_pid", "si_uid", "si_code", "si_status")}
                    code = peek.si_status if peek.si_code == os.CLD_EXITED else -peek.si_status
                    self.receipt.update(reaped=True, exitCode=code, waitSource="pidfd", peek=values, consumed=values.copy())
                    return True
            except ChildProcessError:
                if self.process.returncode is not None:
                    continue
                self.receipt["errors"].append("driver ECHILD without observed child-watcher exit status")
                return False
            if monotonic() >= deadline:
                return False
            sleep(min(.025, max(0, deadline - monotonic())))

    def close(self):
        try:
            done = self.wait(3)
            for number in (signal.SIGTERM, signal.SIGKILL):
                if done:
                    break
                try:
                    current = process_identity(self.identity["pid"])
                    assert identity_key(current) == identity_key(self.identity) and current["ppid"] == os.getpid(), "driver identity changed"
                    signal.pidfd_send_signal(self.fd, number)
                    self.receipt["signals"].append(number)
                except (FileNotFoundError, ProcessLookupError):
                    pass
                done = self.wait(3)
            self.receipt["status"] = "PASS" if (done and self.receipt["exitCode"] == 0
                and not self.receipt["signals"] and not self.receipt["errors"]) else "FAIL"
        except BaseException as error:
            self.receipt["errors"].append(f"{type(error).__name__}: {error}")
        finally:
            os.close(self.fd)
            self.receipt["pidfdClosed"] = True
        return self.receipt

@contextmanager
def bounded_playwright(report):
    from playwright.sync_api import sync_playwright
    manager, driver = sync_playwright(), None
    try:
        playwright = manager.start()
        driver = DriverProcess(playwright)
        report["driverIdentity"] = driver.receipt
        yield playwright
    finally:
        # __exit__ 中断后再次 stop 会短路，不做第二次调用，也不把其返回当退出。
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            sdk_cleanup(report, "driver-stop", manager.__exit__)
        finally:
            if driver:
                report["driverCleanup"] = driver.close()
                if report["driverCleanup"]["status"] != "PASS":
                    report["cleanupErrors"].append("owned SDK driver 未正常退出/回收")
            else:
                report["cleanupErrors"].append("SDK driver 初始化未完成身份绑定，不能声明未启动或已回收")

def configure_page(page, config_cdp, user_agent, width, height):
    assert page.url in ("about:blank", ""), "必须在应用导航前配置"
    page.set_viewport_size({"width": width, "height": height})
    page.emulate_media(color_scheme="light", reduced_motion="reduce", forced_colors="none", contrast="no-preference")
    config_cdp.send("Emulation.setUserAgentOverride", {"userAgent": user_agent, "acceptLanguage": "zh-CN"})
    config_cdp.send("Emulation.setLocaleOverride", {"locale": "zh-CN"})
    config_cdp.send("Emulation.setTimezoneOverride", {"timezoneId": "Asia/Shanghai"})
    actual = page.evaluate("""() => ({
      url:location.href,width:innerWidth,height:innerHeight,language:navigator.language,
      languages:[...navigator.languages],locale:Intl.DateTimeFormat().resolvedOptions().locale,
      timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,userAgent:navigator.userAgent,
      media:{light:matchMedia('(prefers-color-scheme: light)').matches,
        reduce:matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedNone:matchMedia('(forced-colors: none)').matches,
        contrastNone:matchMedia('(prefers-contrast: no-preference)').matches}
    })""")
    assert actual["width"] == width and actual["height"] == height, actual
    assert actual["language"] == "zh-CN" and actual["languages"][0] == "zh-CN", actual
    assert actual["locale"].lower() == "zh-cn" and actual["timezone"] == "Asia/Shanghai", actual
    assert actual["userAgent"] == user_agent and all(actual["media"].values()), actual
    return actual

def _native_case_status(report):
    """原功能断言之外，资格收据的完整性也必须成立；不修改原旁录 helper。"""
    assert not report["pageErrors"], report["pageErrors"]
    inconclusive = bool(report["unverified"])
    phases = ["before-minimize", "hidden-wait-failed" if inconclusive else "hidden-confirmed"]
    if not inconclusive:
        phases.append("visible-confirmed")
    phases += ["before-restore-cleanup", "after-restore-cleanup"]
    observations = report.get("nativeWindowEvidence", [])
    assert [item.get("phase") for item in observations] == phases, "native observation phases incomplete"
    window = observations[0].get("windowId")
    assert type(window) is int, "native window identity missing"
    for item in observations:
        assert "observationError" not in item, "native observation error: " + str(item.get("observationError"))
        assert item.get("width") == report["width"] and item.get("windowId") == window, "native observation identity mismatch"
        assert isinstance(item.get("at"), str) and datetime.fromisoformat(item["at"]).tzinfo, "native observation time missing"
        bounds = item.get("bounds", {}).get("bounds", {})
        assert all(type(bounds.get(key)) is int for key in ("left", "top", "width", "height")), "native bounds incomplete"
        assert bounds["width"] > 0 and bounds["height"] > 0 and bounds.get("windowState") in ("normal", "minimized", "maximized", "fullscreen"), "native bounds invalid"
        page = item.get("page", {})
        assert page.get("visibility") in ("visible", "hidden") and type(page.get("focus")) is bool, "native page observation incomplete"
        if item["phase"] in ("hidden-confirmed", "visible-confirmed", "after-restore-cleanup"):
            hidden = item["phase"] == "hidden-confirmed"
            assert bounds["windowState"] == ("minimized" if hidden else "normal"), "native window state inconsistent"
            assert page["visibility"] == ("hidden" if hidden else "visible"), "native visibility observation inconsistent"
        for key, kind, choices in (("visibilityEvents", "state", ("visible", "hidden")),
                                   ("windowEvents", "type", ("focus", "blur"))):
            assert isinstance(page.get(key), list), "native event observation missing: " + key
            for event in page[key]:
                assert event.get(kind) in choices and type(event.get("trusted")) is bool and type(event.get("at")) in (int, float), "native event fields incomplete"
                if key == "windowEvents":
                    assert event.get("visibility") in ("visible", "hidden"), "window event visibility missing"
    for key in ("S5-AC07-stdio",) if inconclusive else ("S5-AC07-stdio", "S5-AC07-native-hidden"):
        assert any(check.get("id") == key and check.get("status") == "PASS" for check in report["checks"]), "original functional check missing: " + key
    if inconclusive:
        assert all(item.get("id") == "S5-AC07-native-hidden" and item.get("status") == "INCONCLUSIVE"
                   and item.get("width") == report["width"] for item in report["unverified"]), "unexpected incomplete check"
    report["nativeObservationValidation"] = {"status": "PASS", "phases": phases, "windowId": window}
    return "INCONCLUSIVE" if inconclusive else "PASS"

def validate_native_observations(report, width):
    """只投影当前宽的原检查/旁录；完整 exercise 仍由调用方执行和断言。"""
    observations = report.get("nativeWindowEvidence", [])
    assert all(item.get("width") in (1440, 390) for item in observations), "native observation width unknown"
    scope = {"width": width, "pageErrors": report["pageErrors"],
             "checks": [item for item in report["checks"] if item.get("width") == width],
             "unverified": [item for item in report["unverified"] if item.get("width") == width],
             "nativeWindowEvidence": [item for item in observations if item.get("width") == width]}
    result = _native_case_status(scope)
    report.setdefault("nativeObservationValidation", []).append(
        {"width": width, **scope["nativeObservationValidation"]})
    return result


def runtime_identity(binding):
    """固定浏览器能力与本轮 producer runtime 分开核，不继承旧 run 身份。"""
    import playwright
    from playwright.sync_api import BrowserType
    binding = validate_binding(binding)
    expected = load_profile()["browser"]
    installed = {key: importlib.metadata.version(key) for key in expected["packages"]}
    assert installed == expected["packages"], "Python 包版本不匹配"
    assert "no_defaults" in inspect.signature(BrowserType.connect_over_cdp).parameters, "固定公开 API 缺 no_defaults"
    package = Path(playwright.__file__).parent / "driver/package"
    from hashlib import sha256
    digest = lambda path: sha256(Path(path).read_bytes()).hexdigest()
    assert digest(package / "lib/coreBundle.js") == expected["coreBundleSha256"], "Playwright driver bytes 与受审源码不同"
    executable = Path(expected["executable"])
    assert executable.is_file() and os.access(executable, os.X_OK), "固定 Chromium executable 不存在"
    node = json.loads(subprocess.check_output(["node", "-p",
        "JSON.stringify({node:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch,libc:process.report.getReport().header.glibcVersionRuntime})"],
        text=True, timeout=5))
    environment = binding["dependencies"]["environment"]
    assert node == {key: environment[key] for key in ("node", "abi", "platform", "arch", "libc")}, "Node runtime 与本轮 producer 不匹配"
    packages = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}\t${Version}\n",
                                       *expected["desktopPackages"]], text=True, timeout=5)
    actual_packages = dict(line.split("\t") for line in packages.splitlines())
    assert actual_packages == expected["desktopPackages"], "原生桌面包版本不匹配"
    return {"python": platform.python_version(), "packages": installed, "node": node,
            "playwrightPath": str(Path(playwright.__file__).resolve()),
            "coreBundleSha256": digest(package / "lib/coreBundle.js"),
            "chromiumExecutable": str(executable), "chromiumSha256": digest(executable),
            "desktopPackages": actual_packages}


def cleanup_case(owner, browser, context, config_cdp, tracing, trace_path, report, binding):
    # Case 总期限已到也不得跳过独立收尾。SDK 的失败不会驱动或替代 OS owner。
    signal.setitimer(signal.ITIMER_REAL, 0)
    try:
        if tracing:
            sdk_cleanup(report, "trace", lambda: context.tracing.stop(path=str(trace_path)))
        if config_cdp:
            sdk_cleanup(report, "config CDP", config_cdp.detach)
    finally:
        try:
            report["chromeCleanup"] = owner.close(
                (lambda: close_browser_endpoint(owner.receipt["endpoint"], binding)) if owner.bound else None)
        finally:
            if browser:
                # CDP disconnect 本身仍可能等待 SDK；独立 Chrome close 已执行。
                sdk_cleanup(report, "disconnect", browser.close)
    if report["chromeCleanup"]["status"] != "PASS" or report["cleanupErrors"]:
        report["status"] = "FAIL"

@contextmanager
def native_page(playwright, env, width, height, output, trace_path, report, binding):
    """每宽一个全新默认 context；调用方在 yield 内运行完整原 exercise。"""
    binding = validate_binding(binding)
    profile = load_profile()["browser"]
    output.mkdir(parents=True, exist_ok=True)
    report.setdefault("cleanupErrors", [])
    report.update(width=width, height=height, noDefaults=True, status="NOT_RUN")
    owner = OwnedChromium(output / "chrome")
    browser = context = config_cdp = None
    tracing = False
    try:
        owner.spawn(native_arguments(profile["referenceArguments"], owner.profile), env)
        endpoint = owner.endpoint()
        browser = playwright.chromium.connect_over_cdp(endpoint, no_defaults=True, timeout=10000)
        assert len(browser.contexts) == 1, "fresh Chrome 必须只有默认 context"
        context = browser.contexts[0]
        report["defaultContext"] = True
        assert not context.pages, "fresh --no-startup-window 不应存在既有页面"
        browser_cdp = browser.new_browser_cdp_session()
        try:
            version = browser_cdp.send("Browser.getVersion")
            report["browserVersion"] = version
            assert version["product"].split("/", 1)[1] == profile["version"], version
            process_info = browser_cdp.send("SystemInfo.getProcessInfo")["processInfo"]
            owner.bind_browser(process_info)
            actual_argv = browser_cdp.send("Browser.getBrowserCommandLine")["arguments"]
            assert Path(actual_argv[0]).resolve() == Path(profile["executable"]).resolve()
            assert [a for a in actual_argv if a.startswith("--user-data-dir=")] == [f"--user-data-dir={owner.profile}"], "实际 profile 不是本次唯一所有物"
            report["argumentComparison"] = compare_arguments(profile["referenceArguments"], actual_argv)
            report["browserProcesses"] = [p for p in process_info if p["type"] == "browser"]
        finally:
            browser_cdp.detach()
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        tracing = True
        page = context.new_page()
        page.set_default_timeout(10000)
        config_cdp = context.new_cdp_session(page)
        report["configuration"] = configure_page(page, config_cdp, version["userAgent"], width, height)
        yield page, context
    except BaseException as error:
        report["status"] = "FAIL"
        report.setdefault("error", f"{type(error).__name__}: {error}")
        raise
    finally:
        cleanup_case(owner, browser, context, config_cdp, tracing, trace_path, report, binding)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

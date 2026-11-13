#!/usr/bin/env python3
"""#173 一次公开 no_defaults 对照；不代替产品三 job 验收。"""
from __future__ import annotations

import argparse
import ast
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
from time import monotonic, sleep
import traceback

sys.dont_write_bytecode = True
from resource_native_desktop import NativeDesktop
from resource_owned_chromium import (OwnedChromium, close_browser_endpoint, compare_arguments,
                                    native_arguments, process_identity, identity_key)

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "scripts/resource_native_qualification.json").read_text())
CASE_MATRIX = [(arm, no_defaults, width, height)
               for arm, no_defaults in (("baseline", False), ("candidate", True))
               for width, height in ((1440, 1000), (390, 844))]


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


def case_status(report):
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


def cleanup_case(owner, browser, context, config_cdp, tracing, output, report):
    # Case 总期限已到也不得跳过独立收尾。SDK 的失败不会驱动或替代 OS owner。
    signal.setitimer(signal.ITIMER_REAL, 0)
    try:
        if tracing:
            sdk_cleanup(report, "trace", lambda: context.tracing.stop(path=str(output / "trace.zip")))
        if config_cdp:
            sdk_cleanup(report, "config CDP", config_cdp.detach)
    finally:
        try:
            report["chromeCleanup"] = owner.close(
                (lambda: close_browser_endpoint(owner.receipt["endpoint"])) if owner.bound else None)
        finally:
            if browser:
                # CDP disconnect 本身仍可能等待 SDK；独立 Chrome close 已执行。
                sdk_cleanup(report, "disconnect", browser.close)
    if report["chromeCleanup"]["status"] != "PASS" or report["cleanupErrors"]:
        report["status"] = "FAIL"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def source_identity():
    assert not git("status", "--porcelain"), "资格 checkout 必须 clean"
    difference = git("diff", "--name-status", CONTRACT["product"]["tree"], "HEAD").splitlines()
    actual = sorted(line.split("\t", 1)[1] for line in difference if line.startswith("A\t"))
    assert actual == sorted(CONTRACT["newPaths"]) and len(difference) == len(actual), "只能增加五个资格文件"
    entry = ROOT / "scripts/e2e-resource-web.py"
    assert digest(entry) == CONTRACT["preservedEntrySha256"], "原 resource 入口 bytes 改变"
    return {"qualificationCommit": git("rev-parse", "HEAD"), "qualificationTree": git("rev-parse", "HEAD^{tree}"),
            "product": CONTRACT["product"], "addedPaths": actual, "allOriginalEntriesUnchanged": True,
            "resourceEntrySha256": digest(entry), "purpose": "QUALIFICATION_ONLY"}


def load_original():
    path = ROOT / "scripts/e2e-resource-web.py"
    assert digest(path) == CONTRACT["preservedEntrySha256"], "原场景身份错误"
    spec = importlib.util.spec_from_file_location("resource_original", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def visible_control_ast():
    """编译原 exercise 的完整 stdio 正控块；来源 hash 固定，断言不复制/重写。"""
    tree = ast.parse((ROOT / "scripts/e2e-resource-web.py").read_text())
    exercise = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "exercise")
    starts = [i for i, node in enumerate(exercise.body)
              if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call)
              and isinstance(node.value.func, ast.Name) and node.value.func.id == "create"
              and any(isinstance(value, ast.Constant) and value.value == "stdio 原稿 "
                      for value in ast.walk(node.value))]
    assert len(starts) == 1, "原 stdio 控制起点不唯一"
    start = starts[0]
    ends = [i for i, node in enumerate(exercise.body) if i > start
            and isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "command"
            and node.value.args and isinstance(node.value.args[0], ast.Constant)
            and node.value.args[0].value == "network"
            and any(k.arg == "dropResources" and isinstance(k.value, ast.Constant) and k.value.value is True
                    for k in node.value.keywords)]
    assert ends, "原 stdio 控制终点缺失"
    selected = ast.Module(body=exercise.body[start:min(ends)], type_ignores=[])
    return selected


def run_visible_control(original, page, fixture, data, width, report):
    first = data["records"][0]
    pid = first["project"]["id"]
    collection = f"/api/projects/{pid}/tasks"
    writer = data["writeUrl"]
    create = lambda target, title, member=None: original.api(page, writer, "POST", target, {
        "title": title, "body": "原始目标", "assigneeMemberId": member, "reviewerMemberId": None}, 201)["task"]
    values = {"first": first, "pid": pid, "collection": collection, "create": create,
              "page": page, "fixture": fixture, "data": data, "width": width,
              "report": report, "origin": data["url"]}
    selected = visible_control_ast()
    source_hash = hashlib.sha256(ast.dump(selected, include_attributes=False).encode()).hexdigest()
    assert source_hash == CONTRACT["visibleControlAstSha256"], "原可见轮询控制 AST 改变"
    exec(compile(selected, str(ROOT / "scripts/e2e-resource-web.py"), "exec"), original.__dict__, values)
    report["visibleControlAstSha256"] = source_hash
    return values["task"], values["path"]


def runtime_identity():
    import playwright
    from playwright.sync_api import BrowserType
    expected = CONTRACT["browser"]
    installed = {key: importlib.metadata.version(key) for key in expected["packages"]}
    assert installed == expected["packages"], "Python 包版本不匹配"
    assert "no_defaults" in inspect.signature(BrowserType.connect_over_cdp).parameters, "固定公开 API 缺 no_defaults"
    package = Path(playwright.__file__).parent / "driver/package"
    assert digest(package / "lib/coreBundle.js") == expected["coreBundleSha256"], "Playwright driver bytes 与受审源码不同"
    executable = Path(expected["executable"])
    assert executable.is_file() and os.access(executable, os.X_OK), "固定 Chromium executable 不存在"
    node = subprocess.check_output(["node", "-p", "JSON.stringify({version:process.version,abi:process.versions.modules,webSocket:typeof WebSocket})"], text=True, timeout=5)
    node = json.loads(node)
    assert node == {"version": "v24.22.2", "abi": "137", "webSocket": "function"}, "Node/CDP close runtime 不匹配"
    packages = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}\t${Version}\n",
                                       *expected["desktopPackages"]], text=True, timeout=5)
    actual_packages = dict(line.split("\t") for line in packages.splitlines())
    assert actual_packages == expected["desktopPackages"], "原生桌面包版本不匹配"
    return {"python": platform.python_version(), "packages": installed, "node": node,
            "playwrightPath": str(Path(playwright.__file__).resolve()),
            "coreBundleSha256": digest(package / "lib/coreBundle.js"),
            "chromiumExecutable": str(executable), "chromiumSha256": digest(executable),
            "desktopPackages": actual_packages}


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


def run_case(playwright, original, fixture, data, env, arm, no_defaults, width, height, output):
    output.mkdir(parents=True, exist_ok=True)
    report = {"arm": arm, "width": width, "height": height, "noDefaults": no_defaults,
              "status": "NOT_RUN", "checks": [], "screenshots": [], "unverified": [],
              "pageErrors": [], "requests": [], "cleanupErrors": []}
    owner = OwnedChromium(output / "chrome")
    browser = context = config_cdp = None
    tracing = False
    try:
        owner.spawn(native_arguments(CONTRACT["browser"]["referenceArguments"], owner.profile), env)
        endpoint = owner.endpoint()
        browser = playwright.chromium.connect_over_cdp(endpoint, no_defaults=no_defaults, timeout=10000)
        assert len(browser.contexts) == 1, "fresh Chrome 必须只有默认 context"
        context = browser.contexts[0]
        report["defaultContext"] = True
        # 两臂都只在默认 context 新建 page，不新建 incognito context。
        assert not context.pages, "fresh --no-startup-window 不应存在既有页面"
        browser_cdp = browser.new_browser_cdp_session()
        try:
            version = browser_cdp.send("Browser.getVersion")
            report["browserVersion"] = version
            assert version["product"].split("/", 1)[1] == CONTRACT["browser"]["version"], version
            process_info = browser_cdp.send("SystemInfo.getProcessInfo")["processInfo"]
            owner.bind_browser(process_info)
            actual_argv = browser_cdp.send("Browser.getBrowserCommandLine")["arguments"]
            assert Path(actual_argv[0]).resolve() == Path(CONTRACT["browser"]["executable"]).resolve()
            assert [a for a in actual_argv if a.startswith("--user-data-dir=")] == [f"--user-data-dir={owner.profile}"], "实际 profile 不是本次唯一所有物"
            report["argumentComparison"] = compare_arguments(CONTRACT["browser"]["referenceArguments"], actual_argv)
            report["browserProcesses"] = [p for p in process_info if p["type"] == "browser"]
        finally:
            browser_cdp.detach()
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        tracing = True
        page = context.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: report["pageErrors"].append(str(error)[:2048]))
        page.on("request", lambda request: report["requests"].append({
            "at": datetime.now(timezone.utc).isoformat(), "method": request.method, "url": request.url}))
        config_cdp = context.new_cdp_session(page)
        report["configuration"] = configure_page(page, config_cdp, version["userAgent"], width, height)
        task, path = run_visible_control(original, page, fixture, data, width, report)
        original.native_hidden_recovery(page, context, fixture, data, task, path, width, report)
        report["status"] = case_status(report)
    except BaseException as error:
        report["status"] = "FAIL"
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
        if not isinstance(error, Exception):
            raise
    finally:
        cleanup_case(owner, browser, context, config_cdp, tracing, output, report)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report


def baseline_reproduced(case):
    if case["status"] != "INCONCLUSIVE":
        return False
    failed = [p for p in case.get("nativeWindowEvidence", []) if p["phase"] == "hidden-wait-failed"]
    return bool(failed and failed[-1].get("bounds", {}).get("bounds", {}).get("windowState") == "minimized"
                and failed[-1].get("page", {}).get("visibility") == "visible"
                and not failed[-1].get("page", {}).get("visibilityEvents")
                and any(e["type"] == "blur" and e["trusted"] for e in failed[-1]["page"]["windowEvents"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-source", action="store_true")
    parser.add_argument("--artifacts", type=Path, default=ROOT / ".agent-output/resource-native-qualification")
    args = parser.parse_args()
    identity = source_identity()
    if args.check_source:
        print(json.dumps(identity, indent=2))
        return 0
    output = args.artifacts.resolve(); output.mkdir(parents=True, exist_ok=True)
    report = {"status": "NOT_RUN", "purpose": "QUALIFICATION_ONLY", "source": identity,
              "matrix": [{"arm": a, "width": w, "height": h, "noDefaults": n, "status": "NOT_RUN"}
                         for a, n, w, h in CASE_MATRIX],
              "cases": [], "fixtureCleanup": [], "cleanupErrors": [],
              "interpretation": "no_defaults 同时改变 focus/media/download 默认值；不签 focus 唯一因果"}
    desktop = NativeDesktop(output / "native-desktop")
    old_handlers = {}
    def interrupted(number, frame):
        signal.setitimer(signal.ITIMER_REAL, 0)
        raise KeyboardInterrupt(f"qualification signal {number}")
    try:
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            old_handlers[number] = signal.signal(number, interrupted)
        report["runtime"] = runtime_identity()
        original = load_original()
        env = desktop.start()
        deadline = monotonic() + 300
        with bounded_playwright(report) as playwright:
            for arm, no_defaults in (("baseline", False), ("candidate", True)):
                fixture = None
                arm_output = output / arm; arm_output.mkdir(exist_ok=True)
                try:
                    fixture = original.Fixture(arm_output)
                    data = fixture.start()
                    for width, height in ((1440, 1000), (390, 844)):
                        desktop.check_alive()
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise TimeoutError("四 case 资格总执行期限已到；不重试")
                        signal.setitimer(signal.ITIMER_REAL, remaining)
                        row = next(row for row in report["matrix"] if row["arm"] == arm and row["width"] == width)
                        row["status"] = "RUNNING"
                        case_output = arm_output / str(width)
                        try:
                            case = run_case(playwright, original, fixture, data, env, arm, no_defaults, width, height,
                                            case_output)
                        except BaseException:
                            row["status"] = "FAIL"
                            if (case_output / "report.json").exists():
                                report["cases"].append(json.loads((case_output / "report.json").read_text()))
                            raise
                        report["cases"].append(case)
                        row["status"] = case["status"]
                        # 已知对象清理未完不能继续复用桌面或开始新的 case。
                        if case["chromeCleanup"]["status"] != "PASS" or case["cleanupErrors"]:
                            raise RuntimeError("Chrome/SDK 清理未合格，剩余 case 保持 NOT_RUN；不复用可能已中断的 dispatcher")
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    active_exception = sys.exc_info()[0] is not None
                    if fixture:
                        try:
                            report["fixtureCleanup"].append({"arm": arm, "result": fixture.close()})
                        except Exception as error:
                            report["cleanupErrors"].append("fixture: " + str(error))
                            if not active_exception:
                                raise
        candidates = [case for case in report["cases"] if case["arm"] == "candidate"]
        baselines = [case for case in report["cases"] if case["arm"] == "baseline"]
        report["candidateQualified"] = len(candidates) == 2 and all(c["status"] == "PASS" for c in candidates)
        report["baselineReproducedBoth"] = len(baselines) == 2 and all(baseline_reproduced(c) for c in baselines)
        baseline_valid = len(baselines) == 2 and all(
            c["status"] in ("PASS", "INCONCLUSIVE") and
            any(check["id"] == "S5-AC07-stdio" and check["status"] == "PASS" for check in c["checks"])
            for c in baselines)
        report["status"] = ("FAIL" if any(c["status"] == "FAIL" for c in report["cases"]) else
                            "PASS" if report["candidateQualified"] and baseline_valid else "INCONCLUSIVE")
    except BaseException as error:
        report["status"] = "FAIL"
        report["error"] = f"{type(error).__name__}: {error}"
        report["traceback"] = traceback.format_exc()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            report["desktopCleanup"] = desktop.close()
        except Exception as error:
            report["cleanupErrors"].append("desktop: " + str(error))
        try:
            report["sourceAfter"] = source_identity()
            assert report["sourceAfter"] == identity, "资格源在运行中改变"
        except Exception as error:
            report["cleanupErrors"].append("source: " + str(error))
        for number, handler in old_handlers.items():
            signal.signal(number, handler)
        if report["cleanupErrors"]:
            report["status"] = "FAIL"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "matrix": report["matrix"], "purpose": report["purpose"]}))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())

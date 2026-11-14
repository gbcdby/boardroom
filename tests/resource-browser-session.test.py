#!/usr/bin/env python3
"""产品接缝控制：公开 API 形状用替身；真实 Node/TCP/自有进程不启动 Chromium。"""
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import resource_browser_binding as identity
import resource_browser_session as session
import resource_owned_chromium as ownership


def product_module():
    spec = importlib.util.spec_from_file_location("product_resource_e2e", ROOT / "scripts/e2e-resource-web.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def synthetic_binding():
    """只给接口控制生成形状；真实 Git/Node/lock，CI IDs 和 tar 证明明确合成。"""
    source = identity._git_identity(ROOT)
    environment = {"candidate": source["commit"], **identity._runtime(),
                   "lockSha256": identity._lock_sha(ROOT)}
    producer = {"schema": 1, "runId": 700001, "attempt": 1,
                "candidate": source["commit"], "tree": source["tree"]}
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    dependencies = {"artifactId": 800001, "producer": producer, "producerSha256": digest(producer),
                    "environment": environment, "environmentSha256": digest(environment),
                    "tarSha256": hashlib.sha256(b"synthetic CI archive proof").hexdigest()}
    transport = copy.deepcopy(identity.load_profile()["closeTransport"])
    transport["producer"] = {key: dependencies[key] for key in
                             ("artifactId", "tarSha256", "environmentSha256")}
    transport["producer"]["lockSha256"] = environment["lockSha256"]
    return identity.validate_binding({
        "schema": 1, "purpose": "RESOURCE_BROWSER_PRODUCT", "source": source,
        "consumer": {"runId": 700001, "attempt": 2}, "dependencies": dependencies,
        "closeTransport": transport,
    })


def native_evidence(width):
    phases = ["before-minimize", "hidden-confirmed", "visible-confirmed",
              "before-restore-cleanup", "after-restore-cleanup"]
    observations = []
    for phase in phases:
        hidden = phase == "hidden-confirmed"
        observations.append({
            "phase": phase, "width": width, "windowId": width + 20,
            "at": datetime.now(timezone.utc).isoformat(),
            "bounds": {"bounds": {"left": 0, "top": 0, "width": width, "height": 1000,
                                   "windowState": "minimized" if hidden else "normal"}},
            "page": {"visibility": "hidden" if hidden else "visible", "focus": not hidden,
                     "visibilityEvents": [{"state": "hidden", "trusted": True, "at": 10},
                                          *([] if hidden else [{"state": "visible", "trusted": True, "at": 11}])],
                     "windowEvents": []},
        })
    return observations


class ProductSessionControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="boardroom-product-native-control-")
        self.output = Path(self.temp.name)
        self.binding = synthetic_binding()
        self.owners = []
        self.evidence = {"scope": "author seam controls, synthetic CI identity; zero Chromium"}

    def tearDown(self):
        for owner in self.owners:
            if not owner.closed:
                owner.close(None)
            self.assertIsNotNone(owner.process.poll() if owner.process else 0)
            self.assertFalse(owner.members())
            self.assertFalse(owner.profile.exists())
        self.evidence["owned"] = [owner.receipt for owner in self.owners]
        self.evidence["temporaryDirectoryRemoved"] = False
        destination = os.environ.get("RESOURCE_BROWSER_SESSION_CONTROL_OUTPUT")
        self.temp.cleanup()
        self.evidence["temporaryDirectoryRemoved"] = not self.output.exists()
        if destination:
            path = Path(destination); path.mkdir(parents=True, exist_ok=True)
            (path / (self._testMethodName + ".json")).write_text(
                json.dumps(self.evidence, ensure_ascii=False, indent=2) + "\n")

    def api_fixture(self, bad_config=False):
        """Public API test doubles; never a claim that a real DOM/window was observed."""
        events, owners = [], []
        profile = identity.load_profile()["browser"]
        test = self

        class Owner:
            def __init__(self, output):
                self.profile = Path(str(output) + "-private-profile")
                self.bound = False
                self.receipt = {}
                owners.append(self)
                events.append("owner-create")
            def spawn(self, argv, env):
                self.argv = argv
                test.assertEqual(env, {"DISPLAY": "test-owned-display"})
                events.append("owner-spawn")
            def endpoint(self):
                self.receipt["endpoint"] = "ws://127.0.0.1:12345/devtools/browser/fake-api-shape"
                return self.receipt["endpoint"]
            def bind_browser(self, info):
                test.assertEqual(info, [{"id": 123, "type": "browser"}])
                self.bound = True
                events.append("owner-bind")
            def close(self, api):
                events.append("owner-close")
                test.assertIsNotNone(api)
                api()
                return {"status": "PASS", "synthetic": True}

        class Page:
            url = "about:blank"
            def set_default_timeout(self, value):
                test.assertEqual(value, 10000)
            def set_viewport_size(self, value):
                self.viewport = value
                events.append("viewport")
            def emulate_media(self, **kwargs):
                self.media = kwargs
                events.append("media")
            def evaluate(self, script):
                test.assertEqual(self.url, "about:blank")
                events.append("configuration-readback")
                return {"url": self.url, **self.viewport,
                        "language": "wrong" if bad_config else "zh-CN", "languages": ["zh-CN"],
                        "locale": "zh-CN", "timezone": "Asia/Shanghai", "userAgent": "qualified-test-UA",
                        "media": {key: True for key in ("light", "reduce", "forcedNone", "contrastNone")}}
        page = Page()

        class ConfigCDP:
            def send(self, method, params):
                events.append([method, params])
            def detach(self):
                events.append("config-detach")

        class BrowserCDP:
            def send(self, method):
                if method == "Browser.getVersion":
                    return {"product": "Chrome/" + profile["version"], "userAgent": "qualified-test-UA"}
                if method == "SystemInfo.getProcessInfo":
                    return {"processInfo": [{"id": 123, "type": "browser"}]}
                if method == "Browser.getBrowserCommandLine":
                    return {"arguments": owners[-1].argv}
                raise AssertionError(method)
            def detach(self):
                events.append("browser-cdp-detach")

        class Trace:
            def start(self, **kwargs):
                test.assertEqual(kwargs, {"screenshots": True, "snapshots": True, "sources": True})
                events.append("trace-start")
            def stop(self, **kwargs):
                events.append("trace-stop")

        class Context:
            pages = []
            tracing = Trace()
            def new_page(self):
                events.append("default-context-new-page")
                return page
            def new_cdp_session(self, target):
                test.assertIs(target, page)
                return ConfigCDP()

        context = Context()
        class Browser:
            contexts = [context]
            def new_browser_cdp_session(self):
                return BrowserCDP()
            def close(self):
                events.append("sdk-disconnect")
        browser = Browser()
        def connect(endpoint, **kwargs):
            test.assertEqual(kwargs, {"no_defaults": True, "timeout": 10000})
            test.assertEqual(endpoint, owners[-1].receipt["endpoint"])
            events.append("public-no-defaults")
            return browser
        playwright = SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect))
        def close_endpoint(endpoint, binding):
            test.assertEqual(binding, self.binding)
            events.append("close-explicit-binding")
            return {"status": "PASS"}
        return playwright, Owner, close_endpoint, events

    def test_default_context_configuration_precedes_each_full_exercise(self):
        receipts = []
        for width, height in ((1440, 1000), (390, 844)):
            p, owner, close, events = self.api_fixture()
            report = {"cleanupErrors": []}
            with patch.object(session, "OwnedChromium", owner), patch.object(session, "close_browser_endpoint", close):
                with session.native_page(p, {"DISPLAY": "test-owned-display"}, width, height,
                                         self.output / str(width), self.output / f"trace-{width}.zip",
                                         report, self.binding) as (page, _):
                    self.assertEqual(page.url, "about:blank")
                    self.assertEqual(page.viewport, {"width": width, "height": height})
                    self.assertEqual(events[-1], "configuration-readback")
                    page.url = "http://product.example.invalid/only-after-yield"
                    events.append("full-exercise-boundary")
                    report["status"] = "PASS"
            self.assertEqual(report["status"], "PASS")
            self.assertEqual(events[-5:], ["trace-stop", "config-detach", "owner-close",
                                          "close-explicit-binding", "sdk-disconnect"])
            receipts.append({"width": width, "events": events, "report": report})
        self.evidence["publicApiShape"] = receipts

    def test_configuration_failure_reaches_independent_owner_before_disconnect(self):
        p, owner, close, events = self.api_fixture(bad_config=True)
        report = {"cleanupErrors": []}
        with patch.object(session, "OwnedChromium", owner), patch.object(session, "close_browser_endpoint", close):
            with self.assertRaises(AssertionError):
                with session.native_page(p, {"DISPLAY": "test-owned-display"}, 1440, 1000,
                                         self.output / "bad", self.output / "bad.zip", report, self.binding):
                    self.fail("invalid readback reached application")
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["chromeCleanup"]["status"], "PASS")
        self.assertLess(events.index("trace-stop"), events.index("owner-close"))
        self.assertLess(events.index("owner-close"), events.index("sdk-disconnect"))
        self.evidence.update(events=events, report=report)

    def test_native_observation_validation_only_uses_current_width(self):
        report = {"pageErrors": [], "unverified": [], "checks": [
            {"id": key, "width": width, "status": "PASS"} for width in (1440, 390)
            for key in ("S5-AC07-stdio", "S5-AC07-native-hidden")],
            "nativeWindowEvidence": native_evidence(1440) + native_evidence(390)}
        report["nativeWindowEvidence"][-1]["observationError"] = "controlled second-width read failure"
        self.assertEqual(session.validate_native_observations(report, 1440), "PASS")
        with self.assertRaisesRegex(AssertionError, "native observation error"):
            session.validate_native_observations(report, 390)
        missing = copy.deepcopy(report)
        missing["nativeWindowEvidence"] = native_evidence(1440)
        with self.assertRaisesRegex(AssertionError, "phases incomplete"):
            session.validate_native_observations(missing, 390)
        missing["pageErrors"].append("earlier product error remains sticky")
        with self.assertRaises(AssertionError):
            session.validate_native_observations(missing, 1440)
        self.evidence["observations"] = report
        self.evidence["rejected"] = ["current-width observationError", "current-width absent", "prior page error"]

    def test_product_entry_keeps_one_fixture_order_body_observer_and_sticky_cleanup_failure(self):
        original = product_module()
        runs = []
        for fail_first in (False, True):
            events, pages = [], []
            destination = self.output / ("negative" if fail_first else "positive")
            class Desktop:
                def __init__(self, output): pass
                def start(self): events.append("desktop-start"); return {"DISPLAY": "synthetic"}
                def check_alive(self): events.append("desktop-check")
                def close(self): events.append("desktop-close"); return {"synthetic": True}
            class Fixture:
                def __init__(self, output):
                    events.append("fixture-create")
                    self.ready = True
                    self.process = SimpleNamespace(poll=lambda: None)
                def start(self): events.append("fixture-start"); return {"synthetic": True}
                def snapshot(self): events.append("fixture-snapshot"); return {}
                def close(self): events.append("fixture-close"); return {"synthetic": True}
            @contextmanager
            def driver(report):
                events.append("driver-start")
                try: yield SimpleNamespace()
                finally: events.append("driver-close")
            @contextmanager
            def native(p, env, width, height, output, trace_path, report, binding):
                self.assertEqual(binding, self.binding)
                handlers = {}
                page = SimpleNamespace(on=lambda event, fn: handlers.update({event: fn}))
                pages.append(page)
                report.update(browserVersion={"product": "Chrome/151.0.7922.34"},
                              argumentComparison={"actual": ["synthetic"]}, browserProcesses=[])
                events.append(["native-start", width, height])
                try: yield page, SimpleNamespace()
                finally:
                    events.append(["native-close", width])
                    report["chromeCleanup"] = {"status": "PASS"}
                    if fail_first:
                        report["cleanupErrors"].append("controlled trace failure")
                        report["status"] = "FAIL"
                self.assertIn("request", handlers)
            def exercise(page, context, fixture, data, width, output, report):
                events.append(["exercise-boundary", width])
                report["checks"].append({"id": "full-exercise-sentinel", "width": width, "status": "PASS"})
            # The request callback itself is checked using an on() method that invokes it.
            saved_native = native
            @contextmanager
            def native_with_request(*args):
                with saved_native(*args) as (page, context):
                    original_on = page.on
                    def on(event, callback):
                        original_on(event, callback)
                        if event == "request":
                            callback(SimpleNamespace(method="PATCH", url="http://fixture/same", post_data='{"body":"kept"}'))
                    page.on = on
                    yield page, context
            with patch.object(original, "NativeDesktop", Desktop), patch.object(original, "Fixture", Fixture), \
                 patch.object(original, "bounded_playwright", driver), patch.object(original, "native_page", native_with_request), \
                 patch.object(original, "exercise", exercise), patch.object(original, "runtime_identity", return_value={}), \
                 patch.object(original, "load_runtime_binding", return_value=self.binding), \
                 patch.object(original, "validate_native_observations", return_value="PASS"), \
                 patch.object(original, "candidate", side_effect=[{"id": 1}, {"id": 2 if fail_first else 1}]), \
                 patch.object(sys, "argv", ["e2e-resource-web.py", "--native-desktop", "--artifacts", str(destination)]), \
                 patch("builtins.print"):
                code = original.main()
            report = json.loads((destination / "report.json").read_text())
            self.assertEqual(code, 1 if fail_first else 0)
            self.assertEqual(report["status"], "FAIL" if fail_first else "PASS")
            self.assertEqual(events.count("fixture-create"), 1)
            self.assertEqual([item[1] for item in events if isinstance(item, list) and item[0] == "exercise-boundary"],
                             [1440] if fail_first else [1440, 390])
            self.assertEqual(events[-4:], ["driver-close", "fixture-snapshot", "fixture-close", "desktop-close"])
            self.assertTrue(all(item["body"] == '{"body":"kept"}' for item in report["requests"]))
            self.assertEqual(len(report["requests"]), 1 if fail_first else 2)
            if fail_first: self.assertTrue(report["candidateChanged"])
            runs.append({"controlledCleanupFailure": fail_first, "events": events, "report": report})
        self.evidence["orchestrationOnly"] = runs

    def wire_peer(self, invalid=False):
        """真实 loopback peer；与 P3 判别对同类，不扩展已审帧矩阵。"""
        owner = ownership.OwnedChromium(self.output / ("invalid" if invalid else "valid"))
        self.owners.append(owner)
        script = owner.output / "peer.py"
        script.write_text(r'''import base64,hashlib,json,os,socket
from pathlib import Path
root=Path(__file__).parent
server=socket.socket();server.settimeout(5);server.bind(("127.0.0.1",0));server.listen(1)
(root/"ready").write_text("ws://127.0.0.1:"+str(server.getsockname()[1])+"/devtools/browser/product-binding-control")
record={"pid":os.getpid(),"events":[]}
conn=None
try:
    conn,_=server.accept();conn.settimeout(5);header=b""
    while b"\r\n\r\n" not in header:
        data=conn.recv(1024);assert data;header+=data;assert len(header)<8192
    assert header.endswith(b"\r\n\r\n")
    key=next(line.split(b":",1)[1].strip() for line in header.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
    accept=base64.b64encode(hashlib.sha1(key+b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+accept+b"\r\n\r\n")
    def receive(n):
        data=b""
        while len(data)<n:
            part=conn.recv(n-len(data));assert part;data+=part
        return data
    head=receive(2);assert head[0]==0x81 and head[1]&128 and head[1]&127<126
    mask=receive(4);raw=receive(head[1]&127)
    request=json.loads(bytes(v^mask[i%4] for i,v in enumerate(raw)))
    assert request=={"id":1,"method":"Browser.close"}
    record["request"]=request
    payload=b'{"id":1,"result":{}}'
    wire=b"\x81"+bytes([len(payload)])+payload+INVALID
    conn.sendall(wire);record["wireHex"]=wire.hex()
    try: conn.shutdown(socket.SHUT_WR)
    except ConnectionError as error: record["shutdownError"]=str(error)
    try:
        while conn.recv(4096): pass
        record["events"].append("client-eof")
    except ConnectionError as error: record["readError"]=str(error)
finally:
    if conn is not None: conn.close()
    server.close()
    (root/"peer.json").write_text(json.dumps(record,indent=2))
'''.replace("INVALID", repr(b"\x83\x00" if invalid else b"")))
        owner.spawn([sys.executable, str(script)], dict(os.environ))
        until = time.monotonic() + 3
        while not (owner.output / "ready").exists() and time.monotonic() < until: time.sleep(.01)
        endpoint = (owner.output / "ready").read_text()
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        owner.receipt["endpoint"] = endpoint
        return owner, endpoint

    def test_actual_close_helper_normal_nonzero_and_timeout_receive_same_explicit_binding(self):
        receipts = []
        valid_stdout = None
        expected_sha = hashlib.sha256(json.dumps(self.binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        for invalid in (False, True):
            owner, endpoint = self.wire_peer(invalid)
            receipt = owner.close(lambda: ownership.close_browser_endpoint(endpoint, self.binding))
            helper = receipt["apiClose"]
            self.assertEqual(helper["moduleBinding"]["bindingSha256"], expected_sha)
            self.assertEqual(helper["moduleBinding"]["source"], self.binding["source"])
            self.assertEqual(helper["moduleBinding"]["runtime"],
                             {key: self.binding["dependencies"]["environment"][key]
                              for key in ("node", "abi", "platform", "arch", "libc")})
            self.assertEqual(helper["helperExit"], 1 if invalid else 0)
            self.assertEqual(receipt["status"], "FAIL" if invalid else "PASS")
            self.assertTrue(helper["requestSent"] and helper["reply"])
            self.assertFalse(receipt["forced"])
            self.assertEqual(receipt["signals"], [])
            self.assertEqual(receipt["exitCode"], 0)
            self.assertTrue(receipt["reaped"] and receipt["profileRemoved"])
            if not invalid: valid_stdout = helper["helperStdout"]
            receipts.append({"invalidOpcode": invalid, "owner": receipt,
                             "peer": json.loads((owner.output / "peer.json").read_text())})
        actual_run = subprocess.run
        binding_faults = []
        self.evidence.update(actualNodeAndTCP=receipts, binding=self.binding,
                             bindingFaults=binding_faults)
        for fault in ("CalledProcessError", "TimeoutExpired"):
            git_calls = 0
            def replay_with_git_failure(argv, **kwargs):
                nonlocal git_calls
                if argv and argv[0] == "git":
                    git_calls += 1
                    if git_calls == 2:
                        if fault == "CalledProcessError":
                            raise subprocess.CalledProcessError(128, argv, output="", stderr="controlled post-helper Git failure")
                        raise subprocess.TimeoutExpired(argv, 5, output=b"", stderr=b"controlled post-helper Git deadline")
                    return actual_run(argv, **kwargs)
                if argv[:3] == ["node", "--input-type=module", "-e"]:
                    return subprocess.CompletedProcess(argv, 0, valid_stdout, "")
                raise AssertionError("unexpected subprocess in receipt replay")
            with patch.object(ownership.subprocess, "run", side_effect=replay_with_git_failure):
                failed = ownership.close_browser_endpoint("ws://127.0.0.1:1/devtools/browser/replayed", self.binding)
            binding_faults.append({"fault": fault, "receipt": failed,
                                   "kind": "prior actual helper stdout + explicit post-helper Git fault; no new Node"})
            self.assertEqual(failed["status"], "FAIL")
            self.assertTrue(failed["requestSent"] and failed["reply"])
            self.assertEqual(failed["helperStdout"], valid_stdout)
            self.assertEqual(failed["helperExit"], 0)
            self.assertFalse(failed["helperTimedOut"])
            self.assertEqual(failed["receiptErrorStage"], "binding-validation")
            self.assertEqual(failed["receiptErrorType"], fault)
        calls = []
        def timeout_boundary(argv, **kwargs):
            if argv[:3] == ["node", "--input-type=module", "-e"]:
                calls.append(argv)
                raise subprocess.TimeoutExpired(argv, 4, output=valid_stdout, stderr="controlled Python timeout boundary")
            return actual_run(argv, **kwargs)
        with patch.object(ownership.subprocess, "run", side_effect=timeout_boundary):
            timed = ownership.close_browser_endpoint("ws://127.0.0.1:1/devtools/browser/not-connected", self.binding)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(calls[0][-1]), self.binding)
        self.assertTrue(timed["helperTimedOut"] and timed["reply"])
        self.assertEqual(timed["moduleBinding"]["bindingSha256"], expected_sha)
        self.assertEqual(timed["status"], "FAIL")
        mismatch = copy.deepcopy(self.binding); mismatch["consumer"]["attempt"] += 1
        changed = ownership.parse_close_helper_receipt(valid_stdout, "", 0, mismatch)
        self.assertEqual(changed["status"], "FAIL")
        self.assertIn("caller binding", changed["receiptError"])
        self.evidence.update(actualNodeAndTCP=receipts,
                             timeoutBoundary={"kind": "explicit TimeoutExpired fault using prior actual stdout; no extra helper", "receipt": timed},
                             wrongCallerBinding=changed, binding=self.binding)

    def test_missing_binding_is_rejected_before_node_helper(self):
        actual_run = subprocess.run
        node_calls = []
        def record(argv, **kwargs):
            if argv and argv[0] == "node": node_calls.append(argv)
            return actual_run(argv, **kwargs)
        with patch.object(ownership.subprocess, "run", side_effect=record):
            receipt = ownership.close_browser_endpoint("ws://127.0.0.1:1/devtools/browser/unused", None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertFalse(receipt["requestSent"])
        self.assertEqual(node_calls, [])
        self.evidence["rejectedBeforeHelper"] = receipt

    def test_trace_failure_preserves_error_and_reaches_real_owned_close_before_disconnect(self):
        owner, endpoint = self.wire_peer()
        events = []
        def trace(**kwargs):
            events.append("trace")
            raise RuntimeError("controlled trace failure")
        def detach():
            events.append("config-detach")
            raise RuntimeError("controlled config failure")
        def disconnect():
            events.append("sdk-disconnect")
            raise RuntimeError("controlled disconnect failure")
        original_close = session.close_browser_endpoint
        def close(actual_endpoint, binding):
            events.append("owned-close")
            self.assertEqual(actual_endpoint, endpoint)
            self.assertEqual(binding, self.binding)
            return original_close(actual_endpoint, binding)
        report = {"status": "PASS", "cleanupErrors": [], "error": "original-product-error"}
        with patch.object(session, "close_browser_endpoint", close):
            session.cleanup_case(owner, SimpleNamespace(close=disconnect),
                                 SimpleNamespace(tracing=SimpleNamespace(stop=trace)),
                                 SimpleNamespace(detach=detach), True, self.output / "trace.zip", report, self.binding)
        self.assertEqual(events, ["trace", "config-detach", "owned-close", "sdk-disconnect"])
        self.assertEqual(report["error"], "original-product-error")
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["chromeCleanup"]["status"], "PASS")
        self.assertEqual(len(report["cleanupErrors"]), 3)
        self.evidence.update(events=events, report=report,
                             scope="controlled SDK callbacks + actual Node/TCP/owned process; no Chromium")

    def test_shared_sdk_real_driver_exit_and_deadline_boundary(self):
        report = {"cleanupErrors": [], "error": "original-error"}
        with session.bounded_playwright(report):
            pass  # Real installed SDK driver only; never launch a browser.
        self.assertEqual(report["driverCleanup"]["status"], "PASS")
        self.assertEqual(report["driverCleanup"]["exitCode"], 0)
        self.assertTrue(report["driverCleanup"]["reaped"])
        previous = signal.getsignal(signal.SIGALRM)
        self.assertFalse(session.sdk_cleanup(report, "controlled-block", lambda: time.sleep(60), seconds=.05))
        self.assertIs(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(report["error"], "original-error")
        self.evidence["actualSdkAndSignal"] = report


if __name__ == "__main__":
    unittest.main()

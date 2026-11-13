"""限定本次资格 harness；所有原生进程均由本测试 fork/exec，不启动 Chromium。"""
import importlib.util
import ast
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from resource_owned_chromium import OwnedChromium, native_arguments, compare_arguments, close_browser_endpoint
import qualify_resource_native as qualification

REFERENCE = ["/owned/chrome", "--enable-automation", "--ozone-platform=x11",
             "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
             "--disable-renderer-backgrounding", "--user-data-dir=/old", "--remote-debugging-pipe",
             "--no-startup-window", "--flag-switches-begin", "--flag-switches-end"]


class QualificationControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="boardroom-native-control-")
        self.output = Path(self.temp.name)
        self.owners = []
        self.receipts = []
        self.evidence = {}

    def tearDown(self):
        for owner in self.owners:
            if not owner.closed:
                owner.close(None)
        for owner in self.owners:
            self.assertIsNotNone(owner.process.poll() if owner.process else 0)
            self.assertFalse(owner.members(), "本测试自有进程组仍有残留")
            self.assertFalse(Path(owner.profile).exists())
        directory = os.environ.get("RESOURCE_NATIVE_CONTROL_OUTPUT")
        if directory:
            destination = Path(directory); destination.mkdir(parents=True, exist_ok=True)
            (destination / (self._testMethodName + ".json")).write_text(
                json.dumps([o.receipt for o in self.owners], indent=2) + "\n")
            if self.evidence:
                (destination / (self._testMethodName + "-control.json")).write_text(json.dumps(self.evidence, indent=2) + "\n")
        self.temp.cleanup()

    def owner(self, code):
        owner = OwnedChromium(self.output / str(len(self.owners)))
        self.owners.append(owner)
        script = owner.output / "child.py"; script.write_text(code)
        owner.spawn([sys.executable, str(script)], dict(os.environ))
        return owner

    def wait_file(self, path, content=False):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if path.exists():
                value = path.read_text()
                if value or not content:
                    return value
            time.sleep(0.01)
        self.fail("自有控制进程未就绪")

    def test_reference_functional_flags_and_transport_are_bound(self):
        argv = native_arguments(REFERENCE, Path("/owned/profile"))
        self.assertEqual(argv[0], REFERENCE[0])
        self.assertIn("--disable-background-timer-throttling", argv)
        self.assertIn("--remote-debugging-port=0", argv)
        self.assertNotIn("--remote-debugging-pipe", argv)
        self.assertEqual(compare_arguments(REFERENCE, argv)["functionalDifference"], [])
        broken = [a for a in argv if a != "--disable-background-timer-throttling"]
        with self.assertRaisesRegex(AssertionError, "argv"):
            compare_arguments(REFERENCE, broken)
        with self.assertRaisesRegex(AssertionError, "argv"):
            compare_arguments(REFERENCE, argv + ["--headless=new"])

    def test_graceful_owned_process_and_child_are_reaped(self):
        owner = self.owner("""import os,time
from pathlib import Path
root=Path(__file__).parent
pid=os.fork()
if pid==0:
    while not (root/'finish').exists(): time.sleep(.01)
    os._exit(0)
(root/'ready').write_text(str(pid))
while not (root/'finish').exists(): time.sleep(.01)
os.waitpid(pid,0)
""")
        child = int(self.wait_file(owner.output / "ready", content=True))
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        self.assertIn(child, [i["pid"] for i in owner.members()])
        def close():
            (owner.output / "finish").touch()
            return {"requestSent": True, "reply": True, "source": "test-owned-file-control"}
        receipt = owner.close(close)
        self.assertEqual(receipt["status"], "PASS")
        self.assertEqual(receipt["exitCode"], 0)
        self.assertTrue(receipt["reaped"])
        self.assertEqual(receipt["signals"], [])
        self.assertEqual(receipt["remaining"], [])
        self.assertTrue(receipt["profileRemoved"])

    def test_api_failure_requires_term_and_never_becomes_pass(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        def failure():
            raise RuntimeError("original-api-failure")
        receipt = owner.close(failure)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertIn("original-api-failure", json.dumps(receipt))
        self.assertTrue(receipt["forced"])
        self.assertTrue(any(i["signal"] == signal.SIGTERM for i in receipt["signals"]))
        self.assertEqual(receipt["remaining"], [])

    def test_term_ignoring_owned_process_requires_kill_and_fails(self):
        owner = self.owner("import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(any(i["signal"] == signal.SIGKILL for i in receipt["signals"]))
        self.assertEqual(receipt["exitCode"], -signal.SIGKILL)
        self.assertEqual(receipt["remaining"], [])

    def test_foreign_browser_pid_is_rejected_without_signalling_it(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        with self.assertRaisesRegex(AssertionError, "PID"):
            owner.bind_browser([{"type": "browser", "id": os.getpid()}])
        self.assertEqual(owner.receipt["signals"], [])
        self.assertEqual(os.kill(os.getpid(), 0), None)
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertNotIn(os.getpid(), [i["pid"] for i in receipt["signals"]])

    def test_invalid_endpoint_fails_without_connecting_and_cleans(self):
        owner = self.owner("import time\nfrom pathlib import Path\nPath(__file__).with_name('ready').touch()\ntime.sleep(60)\n")
        self.wait_file(owner.output / "ready")
        endpoint = Path(owner.profile) / "DevToolsActivePort"
        endpoint.write_text("9222\n/devtools/page/not-a-browser")
        with self.assertRaisesRegex(AssertionError, "endpoint"):
            owner.endpoint()
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["profileRemoved"])

    def test_actual_cdp_close_frame_and_owned_endpoint_exit(self):
        owner = self.owner(r'''import base64,hashlib,json,socket
from pathlib import Path
root=Path(__file__).parent
server=socket.socket();server.settimeout(5);server.bind(('127.0.0.1',0));server.listen(1)
(root/'ready').write_text('ws://127.0.0.1:'+str(server.getsockname()[1])+'/devtools/browser/owned-control')
conn,_=server.accept();conn.settimeout(5)
header=b''
while b'\r\n\r\n' not in header and len(header)<8192: header+=conn.recv(1024)
key=next(line.split(b':',1)[1].strip() for line in header.split(b'\r\n') if line.lower().startswith(b'sec-websocket-key:'))
accept=base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
def receive(n):
    data=b''
    while len(data)<n:
        more=conn.recv(n-len(data));assert more;data+=more
    return data
head=receive(2);assert head[0]==0x81 and head[1]&0x80 and head[1]&127<126
mask=receive(4);raw=receive(head[1]&127)
request=json.loads(bytes(v^mask[i%4] for i,v in enumerate(raw)))
assert request=={'id':1,'method':'Browser.close'}
(root/'request.json').write_text(json.dumps(request))
body=b'{"id":1,"result":{}}'
conn.sendall(b'\x81'+bytes([len(body)])+body+b'\x88\x02\x03\xe8')
conn.close();server.close()
''')
        endpoint = self.wait_file(owner.output / "ready", content=True)
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        receipt = owner.close(lambda: close_browser_endpoint(endpoint))
        self.assertEqual(receipt["status"], "PASS", receipt)
        self.assertEqual(json.loads((owner.output / "request.json").read_text()), {"id": 1, "method": "Browser.close"})
        self.assertTrue(receipt["apiClose"]["requestSent"])
        self.assertEqual(receipt["apiClose"]["helperExit"], 0)
        self.assertEqual(receipt["signals"], [])

    def test_new_orphan_terminal_is_reaped_with_real_status(self):
        owner = self.owner("""import os,time
from pathlib import Path
root=Path(__file__).parent
pid=os.fork()
if pid==0:
    while not (root/'finish').exists(): time.sleep(.01)
    time.sleep(.05)
    os._exit(27)
(root/'ready').write_text(str(pid))
while not (root/'finish').exists(): time.sleep(.01)
os._exit(0)
""")
        child = int(self.wait_file(owner.output / "ready", content=True))
        owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
        def close():
            (owner.output / "finish").touch()
            return {"requestSent": True, "source": "test-owned-file-control"}
        receipt = owner.close(close)
        self.assertEqual(receipt["status"], "PASS", receipt)
        waits = [w for w in receipt["orphanWaits"] if w["consumed"]["si_pid"] == child]
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0]["consumed"]["si_status"], 27)
        self.assertEqual(waits[0]["peek"], waits[0]["consumed"])
        self.assertEqual(receipt["remaining"], [])

    def test_early_exit_is_not_a_successful_api_close(self):
        owner = self.owner("pass\n")
        owner.process.wait(timeout=3)
        receipt = owner.close(None)
        self.assertEqual(receipt["status"], "FAIL")
        self.assertTrue(receipt["reaped"])
        self.assertTrue(receipt["profileRemoved"])

    def test_missing_native_observations_cannot_qualify(self):
        original = qualification.load_original()
        class ObservationFault:
            def send(self, method, params):
                raise RuntimeError("controlled bounds observation failure")
        phases = ["before-minimize", "hidden-confirmed", "visible-confirmed",
                  "before-restore-cleanup", "after-restore-cleanup"]
        cases = []
        for arm, _, width, _ in qualification.CASE_MATRIX:
            case = {"arm": arm, "width": width, "pageErrors": [], "unverified": [],
                    "checks": [{"id": key, "status": "PASS"} for key in ("S5-AC07-stdio", "S5-AC07-native-hidden")]}
            for phase in phases:
                original.native_snapshot(None, ObservationFault(), 123, width, phase, case)
            with self.assertRaisesRegex(AssertionError, "native observation error"):
                qualification.case_status(case)
            case["status"] = "FAIL"
            cases.append(case)
        tree = ast.parse((ROOT / "scripts/qualify_resource_native.py").read_text())
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        body = next(n for n in main.body if isinstance(n, ast.Try)).body
        start = next(i for i, n in enumerate(body) if isinstance(n, ast.Assign)
                     and isinstance(n.targets[0], ast.Name) and n.targets[0].id == "candidates")
        aggregate = {"cases": cases}
        namespace = {"report": aggregate, "baseline_reproduced": qualification.baseline_reproduced}
        exec(compile(ast.Module(body=body[start:start+6], type_ignores=[]), "actual-aggregate-gate", "exec"), namespace)
        self.assertFalse(aggregate["candidateQualified"])
        self.assertEqual(aggregate["status"], "FAIL")
        self.evidence = {"kind": "synthetic functional premises; real frozen native_snapshot/gates, no browser",
                         "originalCounterexample": aggregate}

        valid = copy.deepcopy(cases[0]); valid.pop("status")
        for item in valid["nativeWindowEvidence"]:
            item.pop("observationError")
            hidden = item["phase"] == "hidden-confirmed"
            item["bounds"] = {"bounds": {"left": 0, "top": 0, "width": 1448, "height": 1085,
                                           "windowState": "minimized" if hidden else "normal"}}
            item["page"] = {"visibility": "hidden" if hidden else "visible", "focus": not hidden,
                            "visibilityEvents": [], "windowEvents": []}
        self.assertEqual(qualification.case_status(valid), "PASS")
        faults = [lambda c: c["nativeWindowEvidence"].pop(),
                  lambda c: c["nativeWindowEvidence"][1].pop("page"),
                  lambda c: c["nativeWindowEvidence"][1]["bounds"]["bounds"].pop("windowState"),
                  lambda c: c["nativeWindowEvidence"][1].update(windowId=124),
                  lambda c: c["nativeWindowEvidence"][1]["page"].pop("visibilityEvents"),
                  lambda c: c["nativeWindowEvidence"][1].update(observationError="late read failure")]
        for index, fault in enumerate(faults):
            broken = copy.deepcopy(valid); fault(broken)
            with self.subTest(missingObservation=index), self.assertRaises(AssertionError):
                qualification.case_status(broken)
        incomplete = copy.deepcopy(valid)
        incomplete["nativeWindowEvidence"].pop(2)
        failed = incomplete["nativeWindowEvidence"][1]
        failed["phase"] = "hidden-wait-failed"; failed["page"]["visibility"] = "visible"
        incomplete["unverified"] = [{"id": "S5-AC07-native-hidden", "width": 1440, "status": "INCONCLUSIVE"}]
        incomplete["checks"] = incomplete["checks"][:1]
        self.assertEqual(qualification.case_status(incomplete), "INCONCLUSIVE")
        self.evidence["nearby"] = {"completeSyntheticGate": "PASS", "missingFieldsRejected": len(faults),
                                   "completeNativeTimeoutGate": "INCONCLUSIVE"}

    def test_sdk_cleanup_deadlines_restore_handler_and_preserve_original_error(self):
        report = {"cleanupErrors": [], "error": "original-product-error"}
        previous = signal.getsignal(signal.SIGALRM)
        for stage in ("trace", "config CDP", "disconnect", "driver-stop"):
            self.assertFalse(qualification.sdk_cleanup(report, stage, lambda: time.sleep(60), seconds=.05))
            self.assertIs(signal.getsignal(signal.SIGALRM), previous)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(report["error"], "original-product-error")
        self.assertEqual(len(report["cleanupErrors"]), 4)
        self.assertTrue(all(item["elapsedMs"] < 1000 for item in report["sdkCleanup"]))
        self.evidence = {"kind": "real SIGALRM with controlled blocking callbacks; no SDK/browser", "report": report}

    def test_actual_sdk_normal_stop_has_real_driver_exit(self):
        report = {"cleanupErrors": []}
        with qualification.bounded_playwright(report):
            pass  # 只启动真实 SDK driver，绝不 launch Chromium。
        self.assertEqual(report["cleanupErrors"], [], report)
        self.assertEqual(report["driverCleanup"]["status"], "PASS")
        self.assertTrue(report["driverCleanup"]["reaped"])
        self.assertEqual(report["driverCleanup"]["exitCode"], 0)
        self.assertEqual(report["driverCleanup"]["signals"], [])
        self.evidence = report

    def test_actual_stalled_sdk_reaches_owned_cleanup_and_remains_failure(self):
        report = {"status": "PASS", "cleanupErrors": [], "error": "original-product-error"}
        reached = []
        started = time.monotonic()
        try:
            with qualification.bounded_playwright(report) as playwright:
                owner = self.owner("""import time
from pathlib import Path
root=Path(__file__).parent
(root/'ready').touch()
while not (root/'finish').exists(): time.sleep(.01)
""")
                self.wait_file(owner.output / "ready")
                owner.bind_browser([{"type": "browser", "id": owner.process.pid}])
                owner.receipt["endpoint"] = "test-owned-file-control"
                driver = report["driverIdentity"]["identity"]
                fd = os.pidfd_open(driver["pid"])
                try:
                    self.assertEqual(qualification.identity_key(qualification.process_identity(driver["pid"])), qualification.identity_key(driver))
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                finally:
                    os.close(fd)
                def close_owned(_):
                    reached.append("owned close reached")
                    (owner.output / "finish").touch()
                    return {"requestSent": True, "source": "test-owned-file-control"}
                # 真正挂起本次 Node driver 后，让实际 SDK _sync/channel 等待真实响应。
                # 注入点是 trace 回调，不伪称实际 tracing.stop 或浏览器已运行。
                context = SimpleNamespace(tracing=SimpleNamespace(stop=lambda **_: playwright.request.new_context()))
                with patch.object(qualification, "close_browser_endpoint", close_owned):
                    qualification.cleanup_case(owner, None, context, None, True, self.output, report)
                reached.append("case cleanup returned")
                self.assertEqual(report["chromeCleanup"]["status"], "PASS", report)
                self.assertEqual(report["status"], "FAIL")
        finally:
            reached += ["fixture cleanup boundary reached", "desktop cleanup boundary reached"]
            self.evidence = {"kind": "actual SDK driver stop + real owned process; no Chromium/native/desktop run",
                             "elapsedMs": round((time.monotonic()-started)*1000), "reached": reached, "report": report}
        self.assertEqual(report["error"], "original-product-error")
        self.assertEqual(report["driverCleanup"]["status"], "FAIL")
        self.assertTrue(report["driverCleanup"]["reaped"])
        self.assertEqual(report["driverCleanup"]["exitCode"], -signal.SIGKILL)
        self.assertTrue(report["driverCleanup"]["pidfdClosed"])
        self.assertLess(time.monotonic()-started, 25)
        self.assertEqual(reached, ["owned close reached", "case cleanup returned",
                                  "fixture cleanup boundary reached", "desktop cleanup boundary reached"])


if __name__ == "__main__":
    unittest.main()

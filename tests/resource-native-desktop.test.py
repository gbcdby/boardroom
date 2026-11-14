"""桌面进程监管控制：真实自有子进程替身，不代表 X11/Chromium visibility 验收。"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("resource_native_desktop", ROOT / "scripts/resource_native_desktop.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

STANDIN = r'''
import os, signal, sys, time
from pathlib import Path
root = Path(os.environ["RESOURCE_DESKTOP_CONTROL_ROOT"])
mode = (root / "mode").read_text()
role = Path(sys.argv[0]).name
if role == "xprop":
    if not (root / "wm.ready").exists() or mode == "wm-identity-missing":
        raise SystemExit(1)
    print("_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x100001")
    if "-id" in sys.argv: print('_NET_WM_NAME(UTF8_STRING) = "Openbox"')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN if mode == "ignore-term" and role == "openbox" else lambda *_: sys.exit(0))
if role == "Xvfb":
    if mode == "xvfb-error": raise SystemExit(17)
    auth = Path(sys.argv[sys.argv.index("-auth") + 1])
    assert auth.stat().st_mode & 0o777 == 0o600 and auth.stat().st_size > 0
    fd = int(sys.argv[sys.argv.index("-displayfd") + 1])
    os.write(fd, b"72\n"); os.close(fd)
else:
    (root / "wm.ready").write_text(str(os.getpid()))
while True: signal.pause()
'''


class DesktopControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="resource-desktop-control-")
        self.root = Path(self.temporary.name)
        self.real_xauth = shutil.which("xauth")
        self.assertIsNotNone(self.real_xauth, "监管控制需要实际 xauth；不能静默跳过")
        for name in ("Xvfb", "openbox", "xprop"):
            executable = self.root / name
            executable.write_text(f"#!{sys.executable}\n" + STANDIN)
            executable.chmod(0o755)
        self.desktop = module.NativeDesktop(self.root / "evidence")
        self.desktop.env["RESOURCE_DESKTOP_CONTROL_ROOT"] = str(self.root)
        self.programs = {name: str(self.root / name) for name in ("Xvfb", "openbox", "xprop")}
        self.programs["xauth"] = self.real_xauth
        self.locator = patch.object(module.shutil, "which", side_effect=lambda name: self.programs.get(name))
        self.locator.start()

    def tearDown(self):
        try:
            try: self.desktop.close()
            except RuntimeError: pass
            for _, process in self.desktop.processes:
                self.assertIsNotNone(process.poll(), "控制自有子进程必须已回收")
                with self.assertRaises(ProcessLookupError): os.kill(process.pid, 0)
            saved = os.environ.get("RESOURCE_DESKTOP_TEST_ARTIFACTS")
            if saved:
                target = Path(saved) / self._testMethodName
                target.mkdir(parents=True, exist_ok=False)
                for item in (self.root / "evidence").iterdir():
                    shutil.copyfile(item, target / item.name)
        finally:
            self.locator.stop()
            self.temporary.cleanup()

    def start(self, mode="normal"):
        (self.root / "mode").write_text(mode)
        return self.desktop.start()

    def test_owned_display_auth_and_processes_are_closed(self):
        env = self.start()
        self.assertEqual(env["DISPLAY"], ":72")
        self.assertNotIn("WAYLAND_DISPLAY", env)
        authority = Path(env["XAUTHORITY"])
        self.assertEqual(authority.stat().st_mode & 0o777, 0o600)
        result = self.desktop.close()
        self.assertEqual(result["status"], "READY")
        self.assertEqual(len(result["cleanup"]), 2)
        self.assertTrue(all(item["reaped"] and not item["forced"] for item in result["cleanup"]))
        self.assertTrue(result["temporaryRootRemoved"])
        self.assertFalse(authority.exists())

    def test_missing_dependency_never_launches_or_uses_existing_display(self):
        self.programs["Xvfb"] = None
        with self.assertRaisesRegex(RuntimeError, "依赖缺失"):
            self.start()
        self.assertEqual(self.desktop.processes, [])
        self.assertEqual(self.desktop.receipt["status"], "FAIL")

    def test_xserver_start_failure_is_not_ready_and_is_reaped(self):
        with self.assertRaisesRegex(RuntimeError, "合法的专属 display"):
            self.start("xvfb-error")
        result = self.desktop.close()
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["cleanup"][0]["exitCode"], 17)
        self.assertTrue(result["temporaryRootRemoved"])

    def test_missing_wm_identity_fails_and_reaps_both_children(self):
        with self.assertRaisesRegex(RuntimeError, "EWMH 身份"):
            self.start("wm-identity-missing")
        result = self.desktop.close()
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(all(item["reaped"] for item in result["cleanup"]))
        self.assertTrue(result["temporaryRootRemoved"])

    def test_unexpected_wm_exit_remains_failure_after_cleanup(self):
        self.start()
        wm = self.desktop.processes[-1][1]
        wm.terminate(); wm.wait(timeout=2)
        with self.assertRaisesRegex(RuntimeError, "提前退出"):
            self.desktop.check_alive()
        with self.assertRaisesRegex(RuntimeError, "清理失败"):
            self.desktop.close()
        self.assertTrue(self.desktop.receipt["temporaryRootRemoved"])

    def test_forced_cleanup_reaps_but_cannot_turn_into_success(self):
        self.start("ignore-term")
        with self.assertRaisesRegex(RuntimeError, "清理失败"):
            self.desktop.close()
        result = self.desktop.receipt
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(result["cleanup"][0]["forced"])
        self.assertEqual(result["cleanup"][0]["exitCode"], -signal.SIGKILL)
        self.assertTrue(all(item["reaped"] for item in result["cleanup"]))
        self.assertTrue(result["temporaryRootRemoved"])


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Regression tests for the evidence runner; optionally exercise a real TLC jar.

python test_runner.py --jar /absolute/path/to/tla2tools.jar
Without --jar, only input/protocol tests run and integration tests are skipped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
import run_tlc

JAR: Path | None = None


def profile() -> dict:
    return {
        "config": "Main.cfg", "timeout_seconds": 15, "workers": 1,
        "heap_mb": 256, "expected_invariants": ["TypeOK", "Safety"],
        "expected_properties": [], "checks_deadlock": True,
        "scope": {"counter_values": [0, 1, 2]}, "assumptions": [],
    }


class InputTests(unittest.TestCase):
    def test_bad_cli_is_tool_error_not_counterexample(self):
        process = subprocess.run([sys.executable, str(Path(run_tlc.__file__).resolve()), "--unknown"],
                                 shell=False, capture_output=True, text=True, timeout=10)
        self.assertEqual(process.returncode, 4)
        self.assertEqual(json.loads(process.stdout)["status"], "TOOL_ERROR")

    def test_commented_property_is_not_enabled(self):
        with self.assertRaises(run_tlc.RunnerError):
            run_tlc.inspect_config("SPECIFICATION Spec\nINVARIANT TypeOK\n\\* INVARIANT Safety", profile())

    def test_nested_comments_and_strings_do_not_introduce_directives(self):
        config = ('(* INVARIANT Missing (* PROPERTY Other *) *)\n'
                  'SPECIFICATION Spec\nCONSTANT Label = "INVARIANT Safety"\n'
                  'INVARIANTS TypeOK Safety\n')
        result = run_tlc.inspect_config(config, profile())
        self.assertEqual(result["configured_invariants"], ["TypeOK", "Safety"])

    def test_config_reduction_is_rejected(self):
        for directive in ("CONSTRAINT Bound", "ACTION_CONSTRAINT Bound", "VIEW Hidden", "SYMMETRY Sym"):
            with self.subTest(directive=directive), self.assertRaises(run_tlc.RunnerError):
                run_tlc.inspect_config("SPECIFICATION Spec\nINVARIANTS TypeOK Safety\n" + directive, profile())

    def test_deadlock_disagreement_is_rejected(self):
        with self.assertRaises(run_tlc.RunnerError):
            run_tlc.inspect_config("SPECIFICATION Spec\nINVARIANTS TypeOK Safety\nCHECK_DEADLOCK FALSE", profile())

    def test_success_word_without_protocol_cannot_pass(self):
        status, _, _ = run_tlc.classify([], 0, raw_text="Model checking completed. No error has been found.")
        self.assertNotEqual(status, "PASS_WITHIN_SCOPE")

    def test_incomplete_or_empty_state_space_cannot_pass(self):
        # Synthetic message objects specifically test defensive classification;
        # these are not presented as evidence of real TLC execution.
        for distinct, queued in ((0, 0), (2, 1)):
            messages = [{"code": code, "severity": 0, "text": ""} for code in (2187, 2193, 2186)]
            messages.append({"code": 2199, "severity": 0,
                             "text": f"2 states generated, {distinct} distinct states found, {queued} states left on queue."})
            self.assertNotEqual(run_tlc.classify(messages, 0)[0], "PASS_WITHIN_SCOPE")

    def test_violation_takes_precedence_over_success_message(self):
        messages = [{"code": 2193, "severity": 0, "text": "success"},
                    {"code": 2110, "severity": 1, "text": "invariant violation"}]
        self.assertEqual(run_tlc.classify(messages, 0)[0], "COUNTEREXAMPLE")


class RealTLCTests(unittest.TestCase):
    def setUp(self):
        if JAR is None:
            self.skipTest("Pass --jar to run actual TLC integration tests")
        self.temporary = tempfile.TemporaryDirectory(prefix="tla-runner-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.model = self.base / "model"
        self.model.mkdir()
        self.manifest = {
            "schema_version": 1, "model": {"root": "model", "entry": "Main.tla"},
            "tool": {"version": "test-supplied official jar", "sha256": hashlib.sha256(JAR.read_bytes()).hexdigest()},
            "profiles": {"small": profile()},
        }
        self.spec = """---- MODULE Main ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == IF x < 2 THEN x' = x + 1 ELSE x' = x
Spec == Init /\\ [][Next]_x
TypeOK == x \\in 0..2
Safety == x <= 2
====
"""
        self.config = "SPECIFICATION Spec\nINVARIANTS TypeOK Safety\n"

    def run_case(self, name="run"):
        (self.model / "Main.tla").write_text(self.spec, encoding="utf-8")
        (self.model / "Main.cfg").write_text(self.config, encoding="utf-8")
        (self.base / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        command = [sys.executable, str(Path(run_tlc.__file__).resolve()),
                   "--manifest", str(self.base / "manifest.json"), "--profile", "small",
                   "--jar", str(JAR), "--out", str(self.base / name)]
        process = subprocess.run(command, shell=False, capture_output=True, text=True, timeout=25)
        output = json.loads(process.stdout)
        result = json.loads((self.base / name / "result.json").read_text()) if output["result"] else output
        return process, result

    def test_complete_real_model_check(self):
        process, result = self.run_case()
        self.assertEqual(process.returncode, 0, result)
        self.assertEqual(result["status"], "PASS_WITHIN_SCOPE")
        self.assertEqual(result["statistics"]["distinct_states"], 3)
        self.assertEqual(result["implementation_status"], "NOT_ASSESSED")
        self.assertTrue((self.base / "run/input/Main.tla").is_file())

    def test_real_counterexample(self):
        self.spec = self.spec.replace("Safety == x <= 2", "Safety == x <= 1")
        process, result = self.run_case()
        self.assertEqual(process.returncode, 2, result)
        self.assertEqual(result["status"], "COUNTEREXAMPLE")
        self.assertEqual(result["process"]["exit_code"], 12)

    def test_real_syntax_error(self):
        self.spec = self.spec.replace("Init == x = 0", "Init == x =")
        process, result = self.run_case()
        self.assertEqual(process.returncode, 4, result)
        self.assertEqual(result["status"], "TOOL_ERROR")
        self.assertNotEqual(result["process"]["exit_code"], 0)

    def test_real_deadlock(self):
        self.spec = self.spec.replace("IF x < 2 THEN x' = x + 1 ELSE x' = x", "x < 2 /\\ x' = x + 1")
        process, result = self.run_case()
        self.assertEqual(process.returncode, 2, result)
        self.assertEqual(result["status"], "COUNTEREXAMPLE")
        self.assertIn(2114, result["message_codes"])
        self.assertEqual(result["process"]["exit_code"], 11)

    def test_real_liveness_violation(self):
        self.spec = self.spec.replace("====", "EventuallyTwo == <> (x = 2)\n====")
        self.config += "PROPERTY EventuallyTwo\n"
        self.manifest["profiles"]["small"]["expected_properties"] = ["EventuallyTwo"]
        process, result = self.run_case()
        self.assertEqual(process.returncode, 2, result)
        self.assertEqual(result["status"], "COUNTEREXAMPLE")
        self.assertIn(2116, result["message_codes"])
        self.assertEqual(result["process"]["exit_code"], 13)

    def test_empty_initial_states_do_not_pass(self):
        self.spec = self.spec.replace("Init == x = 0", "Init == x \\in {}")
        process, result = self.run_case()
        self.assertNotEqual(process.returncode, 0)
        self.assertEqual(result["status"], "TOOL_ERROR")

    def test_missing_expected_property_prevents_execution(self):
        self.config = "SPECIFICATION Spec\nINVARIANT TypeOK\n\\* INVARIANT Safety\n"
        process, result = self.run_case()
        self.assertEqual(process.returncode, 4)
        self.assertEqual(result["status"], "TOOL_ERROR")
        self.assertEqual(result["command"], [])

    def test_wrong_tool_digest_prevents_execution(self):
        self.manifest["tool"]["sha256"] = "0" * 64
        process, result = self.run_case()
        self.assertEqual(process.returncode, 4)
        self.assertIn("SHA256 mismatch", result["reason"])

    def test_timeout_is_not_pass(self):
        self.manifest["profiles"]["small"]["timeout_seconds"] = 0.001
        process, result = self.run_case()
        self.assertEqual(process.returncode, 3, result)
        self.assertEqual(result["status"], "INCONCLUSIVE")

    def test_actual_tlc_timeout_is_not_pass(self):
        self.spec = self.spec.replace("IF x < 2 THEN x' = x + 1 ELSE x' = x", "x' = x + 1")
        self.spec = self.spec.replace("x \\in 0..2", "x \\in Nat").replace("x <= 2", "x >= 0")
        self.manifest["profiles"]["small"]["timeout_seconds"] = 0.7
        process, result = self.run_case()
        self.assertEqual(process.returncode, 3, result)
        self.assertEqual(result["reason"], "TIMEOUT")
        self.assertTrue(result["command"])

    @unittest.skipUnless(sys.platform != "win32", "POSIX SIGTERM integration test")
    def test_interrupt_preserves_nonpass_evidence(self):
        self.spec = self.spec.replace("IF x < 2 THEN x' = x + 1 ELSE x' = x", "x' = x + 1")
        self.spec = self.spec.replace("x \\in 0..2", "x \\in Nat").replace("x <= 2", "x >= 0")
        (self.model / "Main.tla").write_text(self.spec, encoding="utf-8")
        (self.model / "Main.cfg").write_text(self.config, encoding="utf-8")
        (self.base / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        command = [sys.executable, str(Path(run_tlc.__file__).resolve()),
                   "--manifest", str(self.base / "manifest.json"), "--profile", "small",
                   "--jar", str(JAR), "--out", str(self.base / "interrupted")]
        process = subprocess.Popen(command, shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            log = self.base / "interrupted/tlc.log"
            deadline = time.monotonic() + 10
            while not log.exists() and time.monotonic() < deadline and process.poll() is None:
                time.sleep(0.02)
            self.assertTrue(log.exists(), "Runner never launched TLC")
            process.terminate()
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 3, (stdout, stderr))
            result = json.loads((self.base / "interrupted/result.json").read_text())
            self.assertEqual(result["reason"], "INTERRUPTED")
            self.assertEqual(result["status"], "INCONCLUSIVE")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_existing_output_is_not_overwritten(self):
        process, _ = self.run_case()
        self.assertEqual(process.returncode, 0)
        original = (self.base / "run/result.json").read_bytes()
        process, result = self.run_case()
        self.assertEqual(process.returncode, 4)
        self.assertIsNone(result["result"])
        self.assertEqual((self.base / "run/result.json").read_bytes(), original)

    def test_stateful_helper_is_rejected_but_comment_is_allowed(self):
        self.spec += "\\* Never call TLCSet here.\n"
        process, result = self.run_case("comment")
        self.assertEqual(process.returncode, 0, result)
        self.spec = self.spec.replace("Next == IF", "Next == TLCSet(\"exit\", TRUE) /\\ IF")
        process, result = self.run_case("helper")
        self.assertEqual(process.returncode, 4)
        self.assertIn("Unsupported stateful", result["reason"])

    def test_wall_clock_cannot_drive_model_transitions(self):
        self.spec = self.spec.replace("EXTENDS Naturals", "EXTENDS Naturals, TLC")
        self.spec = self.spec.replace("Init == x = 0", "Init == x = IF JavaTime >= 0 THEN 0 ELSE 1")
        process, result = self.run_case()
        self.assertEqual(process.returncode, 4, result)
        self.assertIn("JavaTime", result["reason"])
        self.assertEqual(result["command"], [])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--jar")
    args, rest = parser.parse_known_args()
    if args.jar:
        JAR = Path(args.jar).expanduser().resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *rest], verbosity=2)

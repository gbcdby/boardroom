#!/usr/bin/env python3
"""F0 纯控制：不下载、启动 VM、操作 block device 或执行 native target。"""
from __future__ import annotations

import json
import copy
import hashlib
import tempfile
from pathlib import Path
import unittest
import sys
from contextlib import redirect_stderr
from io import StringIO
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/qualification/whole-brd"))
import f0


RUN_ID = "412e9c36-df93-4cbb-b77a-4047c52a343a"


def request(count=1):
    return json.dumps({"run_id": RUN_ID, "target_count": count}).encode()


class PreparationTests(unittest.TestCase):
    def test_default_plan_preserves_non_execution_and_separate_budgets(self):
        plan = f0.prepare(request())
        self.assertEqual(plan["target"], {
            "count": 1, "bytes_each": 67108864, "total_bytes": 67108864,
            "created": False, "rd_nr_is_global_limit": False,
        })
        self.assertEqual(plan["bootstrap"]["guest_memory_bytes"], 512 * 1024 * 1024)
        self.assertEqual(plan["bootstrap"]["vcpus"], 1)
        self.assertEqual(plan["bootstrap"]["host_block_attachments"], [])
        self.assertEqual(plan["ordinary"], {"status": "NOT_RUN", "facts": None})
        self.assertEqual(plan["actual_instance"], None)
        self.assertEqual(plan["qualification"], "UNSUPPORTED")
        self.assertEqual(plan["launch"], "REQUIRES_SEPARATE_F0B_F1_ACCEPTANCE")

    def test_two_targets_are_explicit_but_three_or_non_integer_are_rejected(self):
        self.assertEqual(f0.prepare(request(2))["target"]["total_bytes"], 134217728)
        for count in (0, 3, -1, True, 1.0, "1"):
            with self.subTest(count=count), self.assertRaises(ValueError):
                f0.prepare(request(count))

    def test_duplicate_or_unexpected_inputs_cannot_claim_runtime_or_privileges(self):
        payloads = [
            b'{"run_id":"' + RUN_ID.encode() + b'","target_count":1,"target_count":2}',
            json.dumps({"run_id": RUN_ID, "target_count": 1, "ordinary": {"status": "PASS"}}).encode(),
            json.dumps({"run_id": RUN_ID, "target_count": 1, "accelerator": "kvm"}).encode(),
            json.dumps({"run_id": RUN_ID, "target_count": 1, "target_bytes": 67108865}).encode(),
        ]
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                f0.prepare(payload)

    def test_command_preview_has_one_fixed_tcg_guest_without_host_devices(self):
        assets = {key: "/tmp/f0-assets/" + key for key in
                  ("qemu", "kernel", "initramfs", "bios", "qemu_data")}
        result = f0.command_preview(request(), assets)
        argv = result["argv"]
        self.assertEqual(argv[0], assets["qemu"])
        self.assertEqual(argv[argv.index("-accel") + 1], "tcg,thread=single")
        self.assertEqual(argv[argv.index("-machine") + 1],
                         "pc-q35-10.0,mem-merge=off,dump-guest-core=off")
        self.assertEqual(argv[argv.index("-m") + 1], "512M")
        self.assertEqual(argv[argv.index("-smp") + 1], "1")
        self.assertEqual(argv[argv.index("-nic") + 1], "none")
        self.assertIn("bdev_allow_write_mounted=0", argv[argv.index("-append") + 1])
        for flag in ("-drive", "-blockdev", "-fsdev", "-virtfs", "-enable-kvm", "-daemonize"):
            self.assertNotIn(flag, argv)
        self.assertEqual(result["status"], "PREVIEW_NOT_EXECUTED")
        self.assertEqual(result["guest_policy_effective"], "NOT_OBSERVED")

    def test_command_path_injection_or_extra_asset_cannot_extend_scope(self):
        assets = {key: "/tmp/f0-assets/" + key for key in
                  ("qemu", "kernel", "initramfs", "bios", "qemu_data")}
        for value in ("/tmp/foo,server=on", "/dev/sda", "/tmp/x/../kernel", "relative", "/tmp/a\nb"):
            bad = dict(assets, kernel=value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                f0.command_preview(request(), bad)
        with self.assertRaises(ValueError):
            f0.command_preview(request(), dict(assets, extra_args="-enable-kvm"))

    def test_directory_is_unique_proposal_and_not_a_namespace_ownership_claim(self):
        plan = f0.prepare(request())
        self.assertEqual(plan["ownership"]["status"], "PROPOSED_NOT_ACQUIRED")
        self.assertIsNone(plan["ownership"]["parent_owned_child_handle"])
        self.assertEqual(plan["ownership"]["exclusive_directory"],
                         "/tmp/boardroom-brd-412e9c36df934cbbb77a4047c52a343a")
        self.assertLess(len(plan["ownership"]["exclusive_directory"] + "/qmp.sock"), 100)

    def test_bad_identity_or_oversize_request_is_rejected(self):
        for raw in (b"[]", b"null", b" " * 16385,
                    b'{"run_id":"not-a-uuid","target_count":1}',
                    b'{"run_id":"' + RUN_ID.upper().encode() + b'","target_count":1}'):
            with self.subTest(raw=raw[:80]), self.assertRaises(ValueError):
                f0.prepare(raw)


def child():
    return {"run_id": RUN_ID, "boot_id": "f116395b-9bd2-4411-8be4-a7d434839f4f",
            "parent_pid": 111, "pid": 222, "start_ticks": 123456789,
            "uid": 1000, "executable_sha256": "a" * 64}


class CleanupTests(unittest.TestCase):
    def test_consistent_receipts_still_require_live_parent_handle_and_reap(self):
        result = f0.cleanup_contract(request(), child(), child())
        self.assertEqual(result["status"], "BINDING_CONSISTENT_NOT_AUTHORIZATION")
        self.assertEqual(result["required_handle"], "retained-parent-child-pidfd")
        self.assertEqual(result["signal_numeric_pid"], False)
        self.assertTrue(result["waitpid_required"])
        self.assertTrue(result["preserve_original_failure"])
        self.assertEqual(result["executed"], False)

    def test_pid_reuse_wrong_boot_owner_executable_or_instance_is_rejected(self):
        changes = {"run_id": "c34fe5de-a9ac-452e-b99d-cdd7b2bf6566", "pid": 333,
                   "parent_pid": 112, "start_ticks": 123456790, "uid": 1001,
                   "boot_id": "a574dd5d-3ccd-46f8-ad2b-58ab00cf5a6f", "executable_sha256": "b" * 64}
        for key, value in changes.items():
            observed = dict(child(), **{key: value})
            with self.subTest(key=key), self.assertRaises(ValueError):
                f0.cleanup_contract(request(), child(), observed)

    def test_invented_or_missing_binding_cannot_be_used_for_cleanup(self):
        bad_rows = [dict(child(), uid=0), dict(child(), pid=True), dict(child(), pid=111),
                    dict(child(), start_ticks=0), dict(child(), namespace_owned=True)]
        missing = copy.deepcopy(child()); del missing["executable_sha256"]
        bad_rows.append(missing)
        for bad in bad_rows:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                f0.cleanup_contract(request(), bad, bad)


class InputBindingTests(unittest.TestCase):
    def test_matching_offline_bytes_are_not_loaded_runtime_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "kernel"
            path.write_bytes(b"controlled-offline-input")
            specs = {"kernel": {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                "max_bytes": 1024}}
            result = f0.bind_inputs(specs)
            self.assertEqual(result["inputs"]["kernel"]["status"], "MATCHED_OFFLINE_BYTES")
            self.assertEqual(result["status"], "OFFLINE_BINDING_ONLY")
            self.assertEqual(result["guest_execution"], "NOT_RUN")
            self.assertEqual(result["qualification"], "UNSUPPORTED")

    def test_missing_changed_linked_or_oversize_input_never_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); original = root / "kernel"
            original.write_bytes(b"controlled-offline-input")
            original_hash = hashlib.sha256(original.read_bytes()).hexdigest()
            linked = root / "link"; linked.symlink_to(original)
            cases = [(root / "missing", original_hash, 1024, "MISSING"),
                     (original, "0" * 64, 1024, "REJECTED"),
                     (linked, original_hash, 1024, "REJECTED"),
                     (root, original_hash, 1024, "REJECTED"),
                     (original, original_hash, 4, "REJECTED")]
            for path, expected, limit, status in cases:
                with self.subTest(path=path, limit=limit):
                    result = f0.bind_inputs({"kernel": {"path": str(path), "sha256": expected,
                                                        "max_bytes": limit}})
                    self.assertEqual(result["inputs"]["kernel"]["status"], status)
                    self.assertEqual(result["guest_execution"], "NOT_RUN")

    def test_unbounded_or_management_claimed_input_is_not_accepted(self):
        cases = [{"ordinary": {"status": "PASS"}},
                 {"kernel": {"path": "/tmp/kernel", "sha256": "a" * 64, "max_bytes": True}},
                 {"kernel": {"path": "/tmp/kernel", "sha256": "a" * 64, "max_bytes": 67108865}},
                 {"kernel": {"path": "/dev/sda", "sha256": "a" * 64, "max_bytes": 1024}},
                 {"kernel": {"path": "/tmp/kernel", "sha256": "a" * 64, "max_bytes": 1024,
                              "loaded": True}}]
        for specs in cases:
            with self.subTest(specs=specs), self.assertRaises(ValueError):
                f0.bind_inputs(specs)


class SingleRootPathTests(unittest.TestCase):
    aliases = ("//dev/sda", "//proc/version", "//sys/kernel/notes", "//tmp/ordinary")

    def test_preview_rejects_all_non_single_root_paths_without_reads(self):
        assets = {key: "/tmp/f0-assets/" + key for key in
                  ("qemu", "kernel", "initramfs", "bios", "qemu_data")}
        for alias in self.aliases:
            with self.subTest(path=alias), patch.object(f0, "_regular_bytes") as read:
                with self.assertRaises(ValueError):
                    f0.command_preview(request(), dict(assets, kernel=alias))
                read.assert_not_called()

    def test_bad_later_input_rejects_the_whole_request_before_any_read(self):
        for alias in self.aliases:
            specs = {"qemu": {"path": "/tmp/f0-assets/qemu", "sha256": "a" * 64,
                              "max_bytes": 1024},
                     "kernel": {"path": alias, "sha256": "b" * 64, "max_bytes": 1024}}
            with self.subTest(path=alias), patch.object(f0, "_regular_bytes", return_value=b"pure") as read:
                with self.assertRaises(ValueError):
                    f0.bind_inputs(specs)
                read.assert_not_called()

    def test_cli_request_and_manifest_paths_reject_aliases_before_io(self):
        cases = [("plan", "--request", "//proc/version"),
                 ("bind-inputs", "--manifest", "//sys/kernel/notes"),
                 ("preview", "--request", "//dev/sda", "--assets", "/tmp/f0-assets/paths.json")]
        for argv in cases:
            with self.subTest(argv=argv), patch.object(f0, "_regular_bytes", return_value=request()) as read:
                with redirect_stderr(StringIO()):
                    self.assertEqual(f0.main(list(argv)), 2)
                read.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)

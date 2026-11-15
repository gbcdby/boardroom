from __future__ import annotations

import gzip
import errno
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/qualification/whole-brd"))
import f0b

RUN = "412e9c36-df93-4cbb-b77a-4047c52a343a"


class FixedPayloadTests(unittest.TestCase):
    def test_new_stage_has_zero_fixture_targets_and_preserves_f0_boundary(self):
        p = f0b.plan(json.dumps({"run_id": RUN}).encode())
        self.assertEqual(p["fixture_targets"], 0)
        self.assertEqual(p["qualification"], "UNSUPPORTED")
        self.assertEqual(p["guest_execution"], "NOT_RUN")
        self.assertEqual(p["limits"]["guest_memory_bytes"], 512 * 1024 * 1024)
        self.assertEqual(p["limits"]["child_cpu_seconds"], 300)
        self.assertEqual(p["limits"]["kill_reap_seconds"], 3)
        self.assertNotIn("max_loop", p["cmdline"])
        import f0
        self.assertEqual(f0.prepare(json.dumps({"run_id": RUN, "target_count": 1}).encode())["target"]["count"], 1)

    def test_request_cannot_smuggle_targets_ordinary_claim_or_boot_options(self):
        for raw in (b'{}', b'{"run_id":"bad"}',
                    json.dumps({"run_id": RUN, "target_count": 0}).encode(),
                    json.dumps({"run_id": RUN, "ordinary": "PASS"}).encode(),
                    ('{"run_id":"'+RUN+'","run_id":"'+RUN+'"}').encode()):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                f0b.plan(raw)

    def test_payload_is_deterministic_fixed_content_without_block_or_module(self):
        a = f0b.payload(RUN, b"fixed-busybox", b"fixed-helper")
        self.assertEqual(a, f0b.payload(RUN, b"fixed-busybox", b"fixed-helper"))
        p = f0b.inspect_payload(a, RUN)
        members = {x["name"]: x for x in p["members"]}
        self.assertEqual(set(members), {"bin", "dev", "proc", "sys", "run", "bin/busybox", "bin/sh", "bin/brd-helper", "init", "dev/console", "dev/null", "run/run-id", "run/expected.json"})
        self.assertFalse(any(stat.S_ISBLK(m["mode"]) for m in members.values()))
        self.assertEqual((members["dev/console"]["rdevmajor"], members["dev/console"]["rdevminor"]), (5, 1))
        self.assertEqual((members["dev/null"]["rdevmajor"], members["dev/null"]["rdevminor"]), (1, 3))
        self.assertEqual(p["state"], "OFFLINE_PAYLOAD_ONLY")
        self.assertEqual(p["guest_execution"], "NOT_RUN")

    def test_truncation_extra_member_run_mismatch_or_archive_escape_is_rejected(self):
        a = f0b.payload(RUN, b"fixed-busybox", b"fixed-helper")
        cases = (a[:-3], a + b"trailer", gzip.compress(gzip.decompress(a).replace(b"bin/sh\0", b"../shx\0"), mtime=0))
        for raw in cases:
            with self.subTest(length=len(raw)), self.assertRaises(ValueError):
                f0b.inspect_payload(raw, RUN)
        with self.assertRaises(ValueError):
            f0b.inspect_payload(a, "512e9c36-df93-4cbb-b77a-4047c52a343a")

    def test_decompression_and_component_budgets_are_enforced(self):
        with self.assertRaises(ValueError):
            f0b.payload(RUN, b"x" * (4 * 1024 * 1024 + 1), b"helper")
        with self.assertRaises(ValueError):
            f0b.inspect_payload(gzip.compress(b"x" * (32 * 1024 * 1024 + 1), mtime=0), RUN)

    def test_character_node_cannot_be_changed_to_block_node(self):
        raw=bytearray(gzip.decompress(f0b.payload(RUN,b"busybox",b"helper")))
        header=raw.index(b"dev/console\0")-110
        raw[header+14:header+22]=f"{stat.S_IFBLK|0o600:08x}".encode()
        with self.assertRaises(ValueError): f0b.inspect_payload(gzip.compress(bytes(raw),mtime=0),RUN)


class FrameTests(unittest.TestCase):
    def frames(self):
        status = b"Pid:\t2\nPPid:\t1\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nGroups:\t\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n"
        items = [("status_before", status), ("self_stat", b"2 (brd-helper) R 1\n"),
                 ("uid_map", b"0 0 4294967295\n"), ("gid_map", b"0 0 4294967295\n"),
                 ("ns_pid", b"pid:[123]"), ("ns_user", b"user:[456]"), ("ns_mnt", b"mnt:[789]"),
                 ("uname", b"Linux\0".ljust(65,b"\0")+b"guest\0".ljust(65,b"\0")+b"7.0.0-1017-azure\0".ljust(65,b"\0")+b"v\0".ljust(65,b"\0")+b"x86_64\0".ljust(65,b"\0")+b"\0"*65),
                 ("version", b"Linux version test\n"), ("osrelease", b"7.0.0-1017-azure\n"),
                 ("boot_id", b"512e9c36-df93-4cbb-b77a-4047c52a343a\n"),
                 ("notes", b"exact-notes"), ("cmdline", f0b.CMDLINE.encode()+b"\n"),
                 ("mountinfo", b"1 0 0:1 / / ro - rootfs rootfs rw\n"),
                 ("modules", b""), ("brd_presence", b"absent\n"),
                 ("sys_block", b"loop0\0loop1\0"), ("status_after", status), ("end", b"")]
        result=[{"run_id":RUN,"origin":"management","event":"ordinary-start"}]
        paths=["/proc/self/status","/proc/self/stat","/proc/self/uid_map","/proc/self/gid_map",
               "/proc/self/ns/pid","/proc/self/ns/user","/proc/self/ns/mnt","syscall:uname",
               "/proc/version","/proc/sys/kernel/osrelease","/proc/sys/kernel/random/boot_id",
               "/sys/kernel/notes","/proc/cmdline","/proc/self/mountinfo","/proc/modules",
               "/sys/module/brd","/sys/block","/proc/self/status","collector:end"]
        for seq,(item,data) in enumerate(items,1):
            result.append({"run_id":RUN,"origin":"ordinary","seq":seq,"item":item,
                           "path":paths[seq-1],
                           "status":"ABSENT" if item=="brd_presence" else "OK",
                           "errno":2 if item=="brd_presence" else 0,"eof":True,"close_errno":0,
                           "bytes":len(data),"data_hex":data.hex()})
        result.append({"run_id":RUN,"origin":"management","event":"ordinary-exit","exit":0,"signal":0,"timeout":False,"pidfd_close_errno":0})
        return result

    def serial(self, frames):
        return b"kernel boot text\n" + b"".join(b"BRDF1 "+json.dumps(f).encode()+b"\n" for f in frames)

    def test_complete_ordinary_frames_capture_inputs_without_qualifying_policy(self):
        result=f0b.decode_serial(self.serial(self.frames()), RUN, b"exact-notes")
        self.assertEqual(result["state"],"CAPTURE_COMPLETE")
        self.assertEqual(result["policy"],"POLICY_INPUTS_CAPTURED")
        self.assertEqual(result["qualification"],"UNSUPPORTED")
        self.assertEqual(result["fixture_targets"],0)

    def test_management_exit_cannot_replace_ordinary_or_its_identity(self):
        frames=self.frames()
        with self.assertRaises(ValueError): f0b.decode_serial(self.serial([frames[0],frames[-1]]),RUN,b"exact-notes")
        frames[1]["data_hex"]=bytes.fromhex(frames[1]["data_hex"]).replace(b"1000",b"0000").hex()
        with self.assertRaises(ValueError): f0b.decode_serial(self.serial(frames),RUN,b"exact-notes")

    def test_missing_truncated_reordered_or_wrong_sized_frame_is_rejected(self):
        raw=self.serial(self.frames())
        with self.assertRaises(ValueError): f0b.decode_serial(raw[:-1],RUN,b"exact-notes")
        frames=self.frames();frames[2]["bytes"]+=1
        with self.assertRaises(ValueError): f0b.decode_serial(self.serial(frames),RUN,b"exact-notes")
        frames=self.frames();frames[2],frames[3]=frames[3],frames[2]
        with self.assertRaises(ValueError): f0b.decode_serial(self.serial(frames),RUN,b"exact-notes")

    def test_actual_error_or_mismatched_notes_stays_failed(self):
        frames=self.frames();frames[12]["close_errno"]=5
        self.assertEqual(f0b.decode_serial(self.serial(frames),RUN,b"exact-notes")["state"],"ORDINARY_FAILED")
        self.assertEqual(f0b.decode_serial(self.serial(self.frames()),RUN,b"other-notes")["state"],"INPUT_MISMATCH")


class ResultBoundaries(unittest.TestCase):
    def test_enumerated_firmware_name_is_not_reinterpreted_as_an_argv_path(self):
        import build, f0, tempfile
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"QEMU,VGA.bin";p.write_bytes(b"fixed ordinary firmware")
            with self.assertRaises(ValueError): f0._asset_path(str(p))
            self.assertEqual(build.data_inventory(d)[0]["name"],"QEMU,VGA.bin")

    def test_original_failure_survives_successful_cleanup(self):
        import supervise
        original = {"state":"OUTPUT_LIMIT", "phase":"serial", "errno":errno.EIO}
        for cleanup in ({"verified":True},
                        {"verified":True,"wait":{"reaped":True,"returncode":23}},
                        {"verified":False,"forced":True}):
            with self.subTest(cleanup=cleanup):
                self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, original, cleanup), "OUTPUT_LIMIT")
        self.assertEqual(original, {"state":"OUTPUT_LIMIT", "phase":"serial", "errno":errno.EIO})

    def test_ordinary_capture_does_not_replace_unproven_cleanup(self):
        import supervise
        self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None, {"verified":False}), "CLEANUP_UNPROVEN")

    def test_forced_reap_keeps_timeout_even_after_resources_were_reclaimed(self):
        import supervise
        for flags in ({"forced":True}, {"wait_timeout":True}):
            with self.subTest(flags=flags):
                self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None,
                                 {"verified":True,"wait":{"reaped":True,"returncode":-9},**flags}), "TIMEOUT")

    def test_reaped_exit_and_resource_cleanup_remain_separate_outcomes(self):
        import supervise
        for code, expected in ((0, "CAPTURE_COMPLETE"), (23, "GUEST_FAILED"), (-9, "GUEST_FAILED")):
            with self.subTest(code=code):
                owned = object.__new__(supervise.OwnedChild)
                owned._finished = False
                owned.ack = owned.pidfd = owned.status = None
                owned.proc = SimpleNamespace(returncode=code, stdout=None)
                cleanup = owned.cleanup(None)
                self.assertTrue(cleanup["verified"], "an abnormal exit does not undo an established reap")
                self.assertEqual(cleanup["wait"], {"reaped":True,"returncode":code})
                self.assertFalse(cleanup["forced"])
                self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None, cleanup), expected)

    def test_complete_frames_cannot_fill_missing_or_unestablished_exit(self):
        import supervise
        for wait in (None, {}, {"reaped":True,"returncode":None},
                     {"reaped":False,"returncode":0}, {"reaped":True,"returncode":False},
                     {"reaped":True,"returncode":"0"}):
            with self.subTest(wait=wait):
                self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None,
                                 {"verified":True,"wait":wait}), "EXIT_UNPROVEN")

    def test_serial_close_error_preserves_errno_and_finishes_remaining_handles_once(self):
        import supervise
        original_close = OSError(errno.EIO, "controlled serial close failure")
        serial = SimpleNamespace(close=unittest.mock.Mock(side_effect=original_close))
        qmp = SimpleNamespace(close=unittest.mock.Mock(), quit=unittest.mock.Mock())
        owned = object.__new__(supervise.OwnedChild)
        owned._finished = False; owned.ack = None
        owned.pidfd = 701; owned.status = 702  # virtual values, os.close is a pure spy below
        owned.proc = SimpleNamespace(returncode=0, stdout=serial, poll=lambda: 0)
        with patch.object(supervise.os, "close") as close, \
             patch.object(supervise.signal, "pidfd_send_signal", side_effect=AssertionError("no signal permitted")):
            cleanup = owned.cleanup(qmp)
            self.assertIs(owned.cleanup(qmp), cleanup, "a failed close must not be retried implicitly")
            self.assertEqual(close.call_args_list, [unittest.mock.call(701), unittest.mock.call(702)])
        serial.close.assert_called_once_with(); qmp.close.assert_called_once_with(); qmp.quit.assert_not_called()
        self.assertEqual(cleanup["wait"], {"reaped":True,"returncode":0})
        self.assertFalse(cleanup["verified"])
        self.assertNotIn("serial", cleanup["handles_closed"])
        self.assertEqual(cleanup["handles_closed"], ["pidfd", "status", "qmp"])
        self.assertEqual(len(cleanup["errors"]), 1)
        self.assertEqual(cleanup["errors"][0]["phase"], "serial-close")
        self.assertEqual(cleanup["errors"][0]["errno"], errno.EIO)
        original = {"state":"ORDINARY_FAILED","phase":"execution","errno":errno.EPERM}
        self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, original, cleanup), "ORDINARY_FAILED")
        self.assertEqual(original["errno"], errno.EPERM)
        self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None, cleanup), "CLEANUP_UNPROVEN")

    def test_normal_serial_close_keeps_complete_result_and_is_not_repeated(self):
        import supervise
        serial = SimpleNamespace(close=unittest.mock.Mock())
        owned = object.__new__(supervise.OwnedChild)
        owned._finished = False; owned.ack = owned.pidfd = owned.status = None
        owned.proc = SimpleNamespace(returncode=0, stdout=serial)
        cleanup = owned.cleanup(None)
        self.assertIs(owned.cleanup(None), cleanup)
        serial.close.assert_called_once_with()
        self.assertTrue(cleanup["verified"])
        self.assertEqual(cleanup["handles_closed"], ["serial"])
        self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"}, None, cleanup), "CAPTURE_COMPLETE")

    def test_pinned_input_rejects_directory_or_link_before_byte_io(self):
        import supervise, tempfile, hashlib
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"helper"; path.write_bytes(b"known regular input")
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            fd=supervise.pinned_executable(str(path),digest)
            import os
            os.close(fd)
            link=Path(d)/"link"; link.symlink_to(path)
            for candidate in (str(link), d, "//proc/version"):
                with self.subTest(candidate=candidate), self.assertRaises(ValueError): supervise.pinned_executable(candidate,digest)


if __name__ == "__main__":
    unittest.main()

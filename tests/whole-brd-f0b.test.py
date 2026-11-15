from __future__ import annotations

import contextlib
import gzip
import hashlib
import importlib.util
import io
import runpy
import errno
import json
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

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
        self.assertNotIn("qmp-stdout", cleanup["handles_closed"])
        self.assertEqual(cleanup["handles_closed"], ["pidfd", "status", "qmp-borrower"])
        self.assertEqual(len(cleanup["errors"]), 1)
        self.assertEqual(cleanup["errors"][0]["phase"], "qmp-stdout-close")
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
        self.assertEqual(cleanup["handles_closed"], ["qmp-stdout"])
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


class StdioTransportTests(unittest.TestCase):
    def test_private_stdio_argv_preserves_all_other_fixed_provider_options(self):
        import f0, transport
        assets = {k: "/owned/" + k for k in ("qemu", "kernel", "bios", "initramfs", "qemu_data")}
        original = f0.command_preview(json.dumps({"run_id": RUN, "target_count": 1}).encode(), assets)["argv"]
        argv = transport.stdio_argv(original, 37)
        self.assertNotIn("-qmp", argv); self.assertNotIn("stdio", argv)
        self.assertIn("stdio,id=control,mux=off,signal=off", argv)
        self.assertIn("fd=37,set=1", argv)
        self.assertIn("file,id=serial,path=/dev/fdset/1,append=on", argv)
        self.assertIn("chardev=control,mode=control", argv)
        self.assertEqual(argv[-1], f0b.CMDLINE)
        for key in ("-machine", "-accel", "-cpu", "-m", "-smp", "-kernel", "-initrd", "-bios", "-nic"):
            if key in original: self.assertEqual(argv[argv.index(key)+1], original[original.index(key)+1])
        for fd in (0, 2, -1, True, "37"):
            with self.subTest(fd=fd), self.assertRaises(ValueError): transport.stdio_argv(original, fd)
        with self.assertRaises(ValueError): transport.stdio_argv(original + ["-chardev", "socket,id=evil"], 37)

    def test_exclusive_artifacts_hard_limit_before_write_and_keep_prefix(self):
        import transport, tempfile
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "new"
            store = transport.Artifacts(out)
            stream = store.create("serial.raw", 5)
            stream.write(b"abc")
            with self.assertRaises(transport.OutputLimit): stream.write(b"defgh")
            self.assertEqual((out / "serial.raw").read_bytes(), b"abcde")
            self.assertEqual(stream.observed, 8); self.assertEqual(stream.written, 5)
            with self.assertRaises(FileExistsError): store.create("serial.raw", 5)
            self.assertEqual((out / "serial.raw").stat().st_mode & 0o777, 0o600)
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertEqual(store.close(), [])
            with self.assertRaises(FileExistsError): transport.Artifacts(out)

    def test_link_or_object_replacement_is_not_overwritten(self):
        import transport, tempfile
        with tempfile.TemporaryDirectory() as root:
            out = Path(root) / "new"; store = transport.Artifacts(out)
            outside = Path(root) / "outside"; outside.write_bytes(b"preserve")
            (out / "stderr.raw").symlink_to(outside)
            with self.assertRaises(FileExistsError): store.create("stderr.raw", 9)
            stream = store.create("serial.raw", 9); stream.write(b"old")
            (out / "serial.raw").rename(out / "moved")
            (out / "serial.raw").write_bytes(b"replacement")
            with self.assertRaises(ValueError): stream.write(b"bad")
            self.assertEqual(outside.read_bytes(), b"preserve")
            self.assertEqual((out / "serial.raw").read_bytes(), b"replacement")
            self.assertEqual((out / "moved").read_bytes(), b"old")
            self.assertTrue(store.close())


class StdioProtocolTests(unittest.TestCase):
    def harness(self, stdout, code=None, respond=True):
        import transport
        data = {21: list(stdout), 22: [b"startup-stderr\n"], 23: [b"serial-only\n"]}
        sent = bytearray(); ticks = [0.0]; writes = [0]
        class Sink:
            def __init__(self): self.data = bytearray(); self.written = 0
            def write(self, raw): self.data.extend(raw); self.written += len(raw)
        sinks = {}
        store = SimpleNamespace(create=lambda name, limit, group=None: sinks.setdefault(name, Sink()))
        child = SimpleNamespace(proc=SimpleNamespace(stdin=SimpleNamespace(fileno=lambda:20),
                         stdout=SimpleNamespace(fileno=lambda:21), stderr=SimpleNamespace(fileno=lambda:22),
                         poll=lambda:code, returncode=code), serial=23)
        def ready(reads, output, unused, timeout):
            ticks[0] += min(timeout, .1)
            return [fd for fd in reads if data[fd]], output, []
        def read(fd, amount):
            if not data[fd]: raise BlockingIOError()
            return data[fd].pop(0)
        def write(fd, raw):
            self.assertEqual(fd,20); writes[0]+=1
            if writes[0]==1: raise BlockingIOError()
            n=min(7,len(raw)); sent.extend(raw[:n])
            if respond and sent.endswith(b"\n"):
                command=json.loads(bytes(sent).splitlines()[-1])
                data[21].append(json.dumps({"return":{},"id":command["id"]}).encode()+b"\n")
            return n
        return transport, child, store, sinks, data, sent, ticks, ready, read, write

    def test_borrowed_stdio_handles_short_io_backpressure_and_independent_streams(self):
        h=self.harness([b'{"QM',b'P":{}}\r\n'])
        transport,child,store,sinks,data,sent,ticks,ready,read,write=h
        with patch.object(transport.os,"set_blocking"), patch.object(transport.os,"read",side_effect=read), \
             patch.object(transport.os,"write",side_effect=write), patch.object(transport.select,"select",side_effect=ready), \
             patch.object(transport.time,"monotonic",side_effect=lambda:ticks[0]):
            pump=transport.Pump(child,store); qmp=transport.QMP(pump)
            self.assertEqual(sinks["serial.raw"].data,b"serial-only\n")
            self.assertEqual(sinks["stderr.raw"].data,b"startup-stderr\n")
            self.assertNotIn("serial",pump.eof)
            qmp.quit(); qmp.close()
            self.assertEqual([json.loads(x)["execute"] for x in bytes(sent).splitlines()], ["qmp_capabilities","quit"])
            self.assertEqual(sinks["qmp-out.raw"].data, sent)
            data[21].append(b""); data[22].append(b""); data[23].append(b"")
            pump.finish(True)
            self.assertEqual(pump.eof,{"qmp","stderr","serial"})

    def test_wrong_response_id_is_not_an_event_or_a_success(self):
        h=self.harness([b'{"QMP":{}}\n',b'{"event":"STOP"}\n',b'{"return":{},"id":"other"}\n'], respond=False)
        transport,child,store,sinks,data,sent,ticks,ready,read,write=h
        with patch.object(transport.os,"set_blocking"), patch.object(transport.os,"read",side_effect=read), \
             patch.object(transport.os,"write",side_effect=write), patch.object(transport.select,"select",side_effect=ready), \
             patch.object(transport.time,"monotonic",side_effect=lambda:ticks[0]):
            pump=transport.Pump(child,store)
            with self.assertRaisesRegex(ValueError,"id"): transport.QMP(pump)

    def test_early_exit_is_distinct_from_live_response_deadline(self):
        for code,expected in ((1,ChildProcessError),(-9,ChildProcessError),(None,TimeoutError)):
            h=self.harness([],code=code,respond=False)
            transport,child,store,sinks,data,sent,ticks,ready,read,write=h
            with self.subTest(code=code), patch.object(transport.os,"set_blocking"), \
                 patch.object(transport.os,"read",side_effect=read), patch.object(transport.os,"write",side_effect=write), \
                 patch.object(transport.select,"select",side_effect=ready), patch.object(transport.time,"monotonic",side_effect=lambda:ticks[0]):
                pump=transport.Pump(child,store)
                with self.assertRaises(expected): transport.QMP(pump)
                self.assertEqual(sinks["stderr.raw"].data,b"startup-stderr\n")

    def test_eof_without_reap_or_with_retained_writer_is_not_complete(self):
        h=self.harness([])
        transport,child,store,sinks,data,sent,ticks,ready,read,write=h
        with patch.object(transport.os,"set_blocking"), patch.object(transport.os,"read",side_effect=read), \
             patch.object(transport.select,"select",side_effect=ready):
            pump=transport.Pump(child,store)
            with self.assertRaisesRegex(ValueError,"reap"): pump.finish(False)
            with self.assertRaisesRegex(OSError,"EOF"): pump.finish(True)


class StdioLifetimeTests(unittest.TestCase):
    def test_serial_pipe_cannot_be_regular_read_only_alias_or_other_object(self):
        import supervise, os
        good=SimpleNamespace(st_mode=stat.S_IFIFO|0o600,st_dev=8,st_ino=90)
        for mode,flags,dev,ino,others in ((stat.S_IFREG,os.O_WRONLY,8,90,()),
                (stat.S_IFIFO,os.O_RDONLY,8,90,()),(stat.S_IFIFO,os.O_RDWR,8,90,()),
                (stat.S_IFIFO,os.O_WRONLY,9,90,()),(stat.S_IFIFO,os.O_WRONLY,8,91,()),
                (stat.S_IFIFO,os.O_WRONLY,8,90,(37,))):
            actual=SimpleNamespace(st_mode=mode,st_dev=dev,st_ino=ino)
            with self.subTest(mode=mode,flags=flags,dev=dev,ino=ino,others=others), \
                 patch.object(supervise.os,"fstat",return_value=actual), \
                 patch.object(supervise.fcntl,"fcntl",return_value=flags), self.assertRaises(ValueError):
                supervise.validate_serial_pipe(37,8,90,others)
        with patch.object(supervise.os,"fstat",return_value=good), patch.object(supervise.fcntl,"fcntl",return_value=os.O_WRONLY):
            supervise.validate_serial_pipe(37,8,90,(38,39))

    def test_extra_serial_fd_close_failure_keeps_original_and_other_cleanup(self):
        import supervise
        owned=object.__new__(supervise.OwnedChild); owned._finished=False; owned.ack=None
        owned.serial=701; owned.pidfd=702; owned.status=703
        streams=[SimpleNamespace(close=unittest.mock.Mock()) for _ in range(3)]
        owned.proc=SimpleNamespace(returncode=23,stdin=streams[0],stdout=streams[1],stderr=streams[2])
        with patch.object(supervise.os,"close",side_effect=[OSError(errno.EIO,"controlled"),None,None]) as close:
            result=owned.cleanup(None)
            self.assertIs(owned.cleanup(None),result)
            self.assertEqual(close.call_args_list,[unittest.mock.call(701),unittest.mock.call(702),unittest.mock.call(703)])
        self.assertEqual(result["errors"][0]["phase"],"serial-close")
        self.assertEqual(result["errors"][0]["errno"],errno.EIO)
        self.assertEqual(result["wait"],{"reaped":True,"returncode":23});self.assertFalse(result["verified"])
        for stream in streams: stream.close.assert_called_once_with()
        original={"state":"BOOT_FAILED","errno":errno.EPERM}
        self.assertEqual(supervise.result_state({"state":"CAPTURE_COMPLETE"},original,result),"BOOT_FAILED")

    def test_short_artifact_write_and_actual_write_error_preserve_prefix(self):
        import transport,tempfile,os
        with tempfile.TemporaryDirectory() as root:
            store=transport.Artifacts(Path(root)/"new"); stream=store.create("serial.raw",20)
            real=os.write; calls=[0]
            def write(fd,data):
                calls[0]+=1
                if calls[0]==2: raise OSError(errno.EIO,"controlled disk write")
                return real(fd,data[:2])
            with patch.object(transport.os,"write",side_effect=write),self.assertRaises(OSError) as caught:
                stream.write(b"abcdefgh")
            self.assertEqual(caught.exception.errno,errno.EIO)
            self.assertEqual(stream.written,2);self.assertEqual(stream.observed,8)
            self.assertEqual((store.path/"serial.raw").read_bytes(),b"ab")
            self.assertEqual(store.close(),[])

    def test_shared_qmp_budget_is_hard_for_both_original_directions(self):
        import transport,tempfile
        with tempfile.TemporaryDirectory() as root:
            store=transport.Artifacts(Path(root)/"new"); store.groups["qmp"][0]=5
            rx=store.create("qmp-in.raw",20,"qmp");tx=store.create("qmp-out.raw",20,"qmp")
            rx.write(b"123")
            with self.assertRaises(transport.OutputLimit):tx.write(b"4567")
            self.assertEqual((store.path/"qmp-out.raw").read_bytes(),b"45")
            self.assertEqual(store.groups["qmp"][1],5); self.assertEqual(store.close(),[])

    def test_constructor_close_failure_preserves_first_errno_and_all_remaining_handles(self):
        import supervise
        streams=[SimpleNamespace(close=unittest.mock.Mock()) for _ in range(3)]
        proc=SimpleNamespace(pid=999,returncode=0,stdin=streams[0],stdout=streams[1],stderr=streams[2])
        def closing(fd):
            if fd==206: raise OSError(errno.EIO,"original serial writer close")
            if fd==101: raise OSError(errno.EBADF,"later prepared anchor close")
        with patch.object(supervise,"pinned_executable",side_effect=[101,102]), \
             patch.object(supervise.os,"pipe2",side_effect=[(201,202),(203,204),(205,206)]), \
             patch.object(supervise.os,"fstat",return_value=SimpleNamespace(st_dev=8,st_ino=90)), \
             patch.object(supervise,"validate_serial_pipe"), patch.object(supervise.subprocess,"Popen",return_value=proc), \
             patch.object(supervise.os,"close",side_effect=closing) as close, \
             patch.object(supervise.os,"pidfd_open") as pidfd, \
             patch.object(supervise.signal,"pidfd_send_signal",side_effect=AssertionError("no signal")), \
             self.assertRaises(OSError) as caught:
            supervise.OwnedChild("/owned/gate","a"*64,"/owned/gate","a"*64,["/owned/gate"],{},mode="pipe-witness")
        self.assertEqual(caught.exception.errno,errno.EIO)
        pidfd.assert_not_called()
        result=caught.exception.owned_cleanup
        self.assertFalse(result["verified"]);self.assertTrue(result["wait"]["reaped"])
        self.assertIn(errno.EIO,[e["errno"] for e in result["errors"]])
        self.assertIn(errno.EBADF,[e["errno"] for e in result["errors"]])
        self.assertEqual(sorted(c.args[0] for c in close.call_args_list),[101,102,201,202,203,204,205,206])

    def test_quit_reply_already_read_is_not_lost_when_child_exits(self):
        helper=StdioProtocolTests();h=helper.harness([b'{"QMP":{}}\n'])
        transport,child,store,sinks,data,sent,ticks,ready,read,write=h
        def writing(fd,raw):
            count=write(fd,raw)
            if sent.endswith(b'"quit"}\n'): child.proc.poll=lambda:0
            return count
        with patch.object(transport.os,"set_blocking"),patch.object(transport.os,"read",side_effect=read), \
             patch.object(transport.os,"write",side_effect=writing),patch.object(transport.select,"select",side_effect=ready), \
             patch.object(transport.time,"monotonic",side_effect=lambda:ticks[0]):
            pump=transport.Pump(child,store);qmp=transport.QMP(pump)
            qmp.quit()
            self.assertEqual(qmp.receipts[-1]["id"],"quit")


class WitnessFinalMetadataTests(unittest.TestCase):
    # All witness resources and children are replaced before invocation.
    def setUp(self):
        self.source = Path(__file__).resolve().parents[1] / "scripts/qualification/whole-brd"
        spec = importlib.util.spec_from_file_location("pipe_witness_under_test", self.source / "pipe-witness.py")
        self.witness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.witness)

    def fixtures(self, *, original=None, metadata=None, close=None, record=None, source=None):
        stream = SimpleNamespace(
            digest=hashlib.sha256(b"PIPE_WITNESS_STDERR\n"),
            record=Mock(side_effect=record, return_value={"name": "stderr.raw", "closed": True}),
        )
        artifacts = SimpleNamespace(
            entries={"stderr.raw": stream},
            put=Mock(side_effect=lambda name, *args: self.raise_error(metadata) if name == "RESULT.json" and metadata else None),
            seal=Mock(return_value=[]),
            close=Mock(side_effect=close if isinstance(close, BaseException) else None, return_value=close if isinstance(close, list) else []),
        )
        pump = SimpleNamespace(
            serial=bytearray(b"PIPE_WITNESS_SERIAL\n"), eof=set(),
            read_counts={"qmp": 0, "serial": len(b"PIPE_WITNESS_SERIAL\n"), "stderr": len(b"PIPE_WITNESS_STDERR\n")},
            errors=[], poll=Mock(),
        )
        cleanup_result = {"verified": True, "wait": {"reaped": True, "returncode": 0}, "forced": False, "wait_timeout": False}
        def cleanup(*args, **kwargs):
            pump.eof.update(("qmp", "serial", "stderr"))
            return cleanup_result
        owned = SimpleNamespace(
            gate_argv=["/owned/gate"], serial_identity={"device": 1, "inode": 2},
            release=Mock(), cleanup=Mock(side_effect=cleanup), before={}, after={}, events=[],
        )
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(self.witness, "Artifacts", return_value=artifacts))
        stack.enter_context(patch.object(self.witness, "OwnedChild", side_effect=original, return_value=owned))
        stack.enter_context(patch.object(self.witness, "Pump", return_value=pump))
        stack.enter_context(patch.object(self.witness, "QMP", return_value=SimpleNamespace(receipts=[])))
        stack.enter_context(patch.object(self.witness.time, "monotonic", side_effect=[0, 0.01]))
        stack.enter_context(patch.object(self.witness.Path, "read_bytes", side_effect=source, return_value=b"controlled source bytes"))
        self.addCleanup(stack.close)
        return artifacts

    @staticmethod
    def raise_error(error):
        raise error

    def outcome(self):
        return self.witness.witness("/owned/gate", "a" * 64, "/owned/never-created")

    def test_result_write_failure_preserves_original_and_closes(self):
        artifacts = self.fixtures(original=OSError(errno.EIO, "original"), metadata=OSError(errno.ENOSPC, "result"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["original_error"]["errno"], errno.EIO)
        self.assertEqual(result["metadata_errors"][0]["errno"], errno.ENOSPC)
        self.assertEqual(result["state"], "FAILED_NO_RETRY")

    def test_result_failure_without_original_cannot_pass(self):
        artifacts = self.fixtures(metadata=OSError(errno.ENOSPC, "result"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertIsNone(result["original_error"])
        self.assertEqual(result["state"], "EVIDENCE_UNPROVEN")
        self.assertEqual(result["metadata_errors"][0]["phase"], "result-write")

    def test_source_digest_failure_always_closes_and_preserves_original(self):
        artifacts = self.fixtures(original=OSError(errno.EIO, "original"), source=OSError(errno.EACCES, "source"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["original_error"]["errno"], errno.EIO)
        self.assertEqual(result["metadata_errors"][0]["errno"], errno.EACCES)
        self.assertEqual(result["metadata_errors"][0]["phase"], "source-digests")
        self.assertEqual(result["state"], "FAILED_NO_RETRY")

    def test_artifact_summary_failure_always_closes(self):
        artifacts = self.fixtures(record=ValueError("summary unavailable"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["metadata_errors"][0]["phase"], "artifact-records")
        self.assertEqual(result["state"], "EVIDENCE_UNPROVEN")

    def test_metadata_serialization_failure_always_closes(self):
        artifacts = self.fixtures()
        artifacts.entries["stderr.raw"].record.return_value = {"not_json": {1, 2}}
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["metadata_errors"][0]["type"], "TypeError")
        self.assertEqual(result["state"], "EVIDENCE_UNPROVEN")

    def test_metadata_and_close_failures_are_independent_of_original(self):
        artifacts = self.fixtures(original=OSError(errno.EIO, "original"), metadata=OSError(errno.ENOSPC, "result"), close=OSError(errno.EBADF, "close"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["original_error"]["errno"], errno.EIO)
        self.assertEqual(result["metadata_errors"][0]["errno"], errno.ENOSPC)
        self.assertEqual(result["final_artifact_errors"][0]["errno"], errno.EBADF)
        self.assertEqual(result["state"], "FAILED_NO_RETRY")

    def test_returned_close_errors_do_not_replace_original(self):
        errors = [{"phase": "artifact-directory-close", "errno": errno.EBADF, "error": "close"}]
        artifacts = self.fixtures(original=OSError(errno.EIO, "original"), close=errors)
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["original_error"]["errno"], errno.EIO)
        self.assertEqual(result["final_artifact_errors"], errors)
        self.assertEqual(result["state"], "FAILED_NO_RETRY")

    def test_close_failure_without_original_cannot_pass(self):
        artifacts = self.fixtures(close=OSError(errno.EBADF, "close"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertIsNone(result["original_error"])
        self.assertEqual(result["state"], "EVIDENCE_UNPROVEN")
        self.assertEqual(result["final_artifact_errors"][0]["errno"], errno.EBADF)

    def test_normal_result_is_still_a_local_pipe_pass(self):
        artifacts = self.fixtures()
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["state"], "PASS_LOCAL_OWNED_PIPE_ONLY")
        self.assertIsNone(result["original_error"])
        self.assertEqual(result.get("metadata_errors", []), [])
        self.assertEqual(result["final_artifact_errors"], [])
        self.assertEqual(result["child_starts"], 1)
        self.assertEqual(result["guest_starts"], 0)
        self.assertEqual(result["socket_operations"], 0)

    def test_plain_execution_failure_remains_primary(self):
        artifacts = self.fixtures(original=OSError(errno.EIO, "original"))
        result = self.outcome()
        artifacts.close.assert_called_once_with()
        self.assertEqual(result["state"], "FAILED_NO_RETRY")
        self.assertEqual(result["original_error"]["errno"], errno.EIO)
        self.assertEqual(result.get("metadata_errors", []), [])

    def test_cli_reports_original_metadata_and_close_errors_with_failure_exit(self):
        artifacts = SimpleNamespace(entries={}, put=Mock(side_effect=[None, OSError(errno.ENOSPC, "result")]), seal=Mock(return_value=[]), close=Mock(side_effect=OSError(errno.EBADF, "close")))
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["pipe-witness.py", "--gate", "/owned/gate", "--gate-sha256", "a" * 64, "--output", "/owned/never-created"]), \
                patch("transport.Artifacts", return_value=artifacts), \
                patch("supervise.OwnedChild", side_effect=OSError(errno.EIO, "original")), \
                patch.object(Path, "read_bytes", return_value=b"controlled source bytes"), \
                contextlib.redirect_stdout(stdout), self.assertRaises(SystemExit) as stopped:
            runpy.run_path(str(self.source / "pipe-witness.py"), run_name="__main__")
        self.assertEqual(stopped.exception.code, 1)
        data = json.loads(stdout.getvalue())
        self.assertEqual(data["original_error"]["errno"], errno.EIO)
        self.assertEqual(data["metadata_errors"][0]["errno"], errno.ENOSPC)
        self.assertEqual(data["final_artifact_errors"][0]["errno"], errno.EBADF)
        artifacts.close.assert_called_once_with()


class ArtifactAcquisitionFailureTests(unittest.TestCase):
    @staticmethod
    def store():
        import transport
        store = object.__new__(transport.Artifacts)
        store.fd = 700; store.entries = {}; store.limit = 4096; store.groups = {}
        store.acquisition_errors = []; store.check = Mock()
        return store

    def test_directory_initial_fstat_failure_closes_once_and_retains_primary(self):
        import transport
        for close_error in (None, OSError(errno.EBADF, "close")):
            with self.subTest(close_error=close_error):
                primary = OSError(errno.EIO, "initial directory fstat")
                with patch.object(transport.Path, "mkdir"), patch.object(transport.os, "open", return_value=701), \
                     patch.object(transport.os, "fstat", side_effect=primary), \
                     patch.object(transport.os, "close", side_effect=close_error) as close:
                    with self.assertRaises(OSError) as caught:
                        transport.Artifacts("/owned/uncreated")
                    self.assertIs(caught.exception, primary)
                    close.assert_called_once_with(701)
                    cleanup = caught.exception.artifact_cleanup
                    self.assertEqual(cleanup["verified"], close_error is None)
                    self.assertEqual([e["errno"] for e in cleanup["errors"]], [errno.EBADF] if close_error else [])

    def test_directory_check_failure_keeps_first_errno_when_close_also_fails(self):
        import transport
        primary = OSError(errno.EIO, "directory check")
        with patch.object(transport.Path, "mkdir"), patch.object(transport.os, "open", return_value=701), \
             patch.object(transport.os, "fstat", side_effect=[SimpleNamespace(st_dev=9, st_ino=71), primary]), \
             patch.object(transport.os, "close", side_effect=OSError(errno.EBADF, "close")) as close:
            with self.assertRaises(OSError) as caught:
                transport.Artifacts("/owned/uncreated")
            self.assertIs(caught.exception, primary)
            close.assert_called_once_with(701)
            self.assertFalse(primary.artifact_cleanup["verified"])
            self.assertEqual(primary.artifact_cleanup["errors"][0]["errno"], errno.EBADF)

    def test_file_initial_fstat_failure_closes_once_and_keeps_cleanup_visible(self):
        import transport
        for close_error in (None, OSError(errno.EBADF, "close")):
            with self.subTest(close_error=close_error):
                store = self.store(); primary = OSError(errno.EIO, "initial file fstat")
                with patch.object(transport.os, "open", return_value=702), \
                     patch.object(transport.os, "fstat", side_effect=primary), \
                     patch.object(transport.os, "close", side_effect=close_error) as close:
                    with self.assertRaises(OSError) as caught:
                        store.create("serial.raw", 64)
                    self.assertIs(caught.exception, primary)
                    close.assert_called_once_with(702)
                    self.assertEqual(store.entries, {})
                    self.assertEqual(store.seal(), primary.artifact_cleanup["errors"])
                    self.assertEqual(store.seal(), primary.artifact_cleanup["errors"])
                    close.assert_called_once_with(702)

    def test_file_check_failure_does_not_retry_uncertain_close(self):
        import transport
        primary = OSError(errno.EIO, "file identity")
        store = self.store()
        with patch.object(transport.os, "open", return_value=702), \
             patch.object(transport.os, "fstat", return_value=SimpleNamespace(st_dev=9, st_ino=72)), \
             patch.object(transport.Artifact, "check", side_effect=primary), \
             patch.object(transport.os, "close", side_effect=OSError(errno.EBADF, "close")) as close:
            with self.assertRaises(OSError) as caught:
                store.create("serial.raw", 64)
            self.assertIs(caught.exception, primary)
            close.assert_called_once_with(702)
            self.assertTrue(store.entries["serial.raw"].closed)
            self.assertEqual(store.seal(), primary.artifact_cleanup["errors"])
            self.assertEqual(store.seal(), primary.artifact_cleanup["errors"])
            close.assert_called_once_with(702)

    def test_failed_directory_open_does_not_close_an_unacquired_descriptor(self):
        import transport
        primary = OSError(errno.EACCES, "open")
        with patch.object(transport.Path, "mkdir"), patch.object(transport.os, "open", side_effect=primary), \
             patch.object(transport.os, "close") as close:
            with self.assertRaises(OSError) as caught:
                transport.Artifacts("/owned/uncreated")
            self.assertIs(caught.exception, primary)
            close.assert_not_called()

    def test_failed_file_open_does_not_close_an_unacquired_descriptor(self):
        import transport
        primary = OSError(errno.EACCES, "open"); store = self.store()
        with patch.object(transport.os, "open", side_effect=primary), patch.object(transport.os, "close") as close:
            with self.assertRaises(OSError) as caught:
                store.create("serial.raw", 64)
            self.assertIs(caught.exception, primary)
            close.assert_not_called()


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import copy
import errno
import gzip
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/qualification/whole-brd"))
import f0b
import f2

RUN = "9ac818aa-3fe1-4f28-8b5e-119430876bdd"


def runner_module():
    spec = importlib.util.spec_from_file_location("f2_run_tests", ROOT / "scripts/qualification/whole-brd/f2-run.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class ContractTests(unittest.TestCase):
    def test_only_new_run_identity_is_an_input(self):
        p = f2.plan(json.dumps({"run_id": RUN}).encode())
        self.assertEqual(p["fixture_targets"], 1)
        self.assertEqual(p["target_bytes"], 64 * 1024 * 1024)
        self.assertEqual(p["content_probes"], 0)
        self.assertEqual(p["qualification"], "UNSUPPORTED")
        self.assertEqual(p["limits"], f0b.LIMITS)
        for extra in ({"target_count": 2}, {"policy": "PASS"}, {"cmdline": "override"}, {"argv": []}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                f2.plan(json.dumps({"run_id": RUN, **extra}).encode())
        with self.assertRaises(ValueError):
            f2.plan(('{"run_id":"'+RUN+'","run_id":"'+RUN+'"}').encode())

    def test_explicit_format_vector_and_eager_initialization(self):
        argv = f2.mkfs_argv(RUN)
        self.assertEqual(argv[0], "/usr/sbin/mke2fs")
        self.assertEqual(argv[-2:], ["/dev/ram0", "16384"])
        for key, value in (("-t", "ext4"), ("-T", "brd64"), ("-b", "4096"),
                           ("-I", "256"), ("-i", "16384"), ("-m", "0"), ("-J", "size=4")):
            self.assertEqual(argv[argv.index(key) + 1], value)
        self.assertEqual(argv.count("-E"), 1)
        self.assertEqual(argv.count("-O"), 1)
        self.assertEqual(argv[argv.index("-O") + 1].split(",")[0], "none")
        self.assertEqual(set(argv[argv.index("-O") + 1].split(",")[1:]), {
            "has_journal", "ext_attr", "resize_inode", "dir_index", "filetype", "extent", "64bit", "flex_bg",
            "sparse_super", "large_file", "huge_file", "dir_nlink", "extra_isize", "metadata_csum"})
        self.assertEqual(argv[argv.index("-E") + 1].split(",")[:4],
                         ["lazy_itable_init=0", "lazy_journal_init=0", "nodiscard", "assume_storage_prezeroed=0"])
        self.assertNotIn("-F", argv)
        self.assertEqual(f2.FEATURES, (60, 706, 1131))

    def test_configuration_is_exact_not_an_equivalent_or_fallback_profile(self):
        raw = (ROOT / "scripts/qualification/whole-brd/mke2fs-f2.conf").read_bytes()
        self.assertEqual(f2.config_bytes(raw), raw)
        for altered in (b"", raw + b"\n", raw.replace(b"lazy_journal_init = false", b"lazy_journal_init = true"),
                        raw + b"[devices]\n/dev/ram0 = {}\n"):
            with self.assertRaises(ValueError): f2.config_bytes(altered)
        self.assertEqual(set(f2.MKFS_ENV), {"PATH", "LANG", "LC_ALL", "MKE2FS_CONFIG"})

    def test_original_f0b_payload_remains_zero_target_and_exactly_thirteen_members(self):
        p = f0b.inspect_payload(f0b.payload(RUN, b"busybox", b"helper"), RUN)
        self.assertEqual(len(p["members"]), 13)
        self.assertFalse(any(stat.S_ISBLK(x["mode"]) for x in p["members"]))
        self.assertEqual(f0b.plan(json.dumps({"run_id": RUN}).encode())["fixture_targets"], 0)

    def test_bounded_newc_parser_rejects_special_unknown_and_trailing_members(self):
        entry = f0b._entry("run/data", stat.S_IFREG | 0o444, b"data")
        raw = f0b._newc_record(entry, 1) + f0b._newc_record(f0b._entry("TRAILER!!!", 0), 0)
        self.assertEqual(f2.decode_newc(raw), [entry])
        for altered in (raw[:-1], raw + b"x", raw.replace(b"run/data\0", b"../datax\0")):
            with self.assertRaises(ValueError): f2.decode_newc(altered)
        block = f0b._entry("dev/ram0", stat.S_IFBLK | 0o600, major=1, minor=0)
        bad = f0b._newc_record(block, 1) + f0b._newc_record(f0b._entry("TRAILER!!!", 0), 0)
        with self.assertRaises(ValueError): f2.decode_newc(bad)


class PolicyTests(unittest.TestCase):
    def fixture(self):
        spec = importlib.util.spec_from_file_location("f0b_test_fixture", ROOT / "tests/whole-brd-f0b.test.py")
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        old = mod.FrameTests().frames()
        for frame in old: frame["run_id"] = RUN
        for frame in old:
            if frame.get("item") == "uname":
                value = bytes.fromhex(frame["data_hex"])
                value = value[:195] + f2.VERSION.encode().ljust(65, b"\0") + value[260:]
                frame.update(bytes=len(value), data_hex=value.hex())
        raw = b"".join(b"BRDF1 " + json.dumps(x).encode() + b"\n" for x in old)
        return f0b.decode_serial(raw, RUN, b"exact-notes")

    def test_policy_requires_current_exact_complete_inputs_and_preserves_ambient_loops(self):
        p = self.fixture()
        self.assertEqual(f2.policy(p), "SOURCE_INFERRED_FALSE_FOR_CURRENT_BOOT")
        self.assertEqual(p["observations"]["sys_block"]["raw"], b"loop0\0loop1\0")
        for bad in (b"", f0b.CMDLINE.encode(), f0b.CMDLINE.encode()+b" bdev_allow_write_mounted=1\n",
                    b"-- " + f0b.CMDLINE.encode()+b"\n", f0b.CMDLINE.encode()+b" bootconfig\n"):
            changed = copy.deepcopy(p); changed["observations"]["cmdline"]["raw"] = bad
            with self.assertRaises(ValueError): f2.policy(changed)

    def test_prior_loaded_module_or_nonmatching_uname_stops_before_any_target(self):
        p = self.fixture()
        p["observations"]["modules"]["raw"] = b"brd 1234 0 - Live 0\n"
        with self.assertRaises(ValueError): f2.policy(p)
        p = self.fixture(); p["observations"]["uname"]["raw"] = bytes(390)
        with self.assertRaises(ValueError): f2.policy(p)
        p = self.fixture(); p["state"] = "ORDINARY_FAILED"
        with self.assertRaises(ValueError): f2.policy(p)


class ResultAndClaimTests(unittest.TestCase):
    def test_claim_write_error_keeps_first_exception_and_closes_once(self):
        run = runner_module(); first = OSError(errno.ENOSPC, "claim write"); last = OSError(errno.EBADF, "claim close")
        with patch.object(run.os, "open", return_value=701), patch.object(run.os, "write", side_effect=first), \
             patch.object(run.os, "close", side_effect=last) as close:
            with self.assertRaises(OSError) as observed: run.create_claim(Path("/never-used"), b"claim")
        self.assertIs(observed.exception, first)
        self.assertEqual(first.claim_close_error["errno"], errno.EBADF)
        close.assert_called_once_with(701)

    def test_claim_partial_write_and_close_failure_cannot_start_guest(self):
        run = runner_module()
        for written, closing in ((0, None), (5, OSError(errno.EBADF, "close"))):
            with self.subTest(written=written), patch.object(run.os, "open", return_value=702), \
                 patch.object(run.os, "write", return_value=written), patch.object(run.os, "close", side_effect=closing) as close:
                with self.assertRaises(OSError): run.create_claim(Path("/never-used"), b"claim")
                close.assert_called_once_with(702)

    def test_claim_collision_does_not_close_or_retry(self):
        run = runner_module(); first = FileExistsError(errno.EEXIST, "claimed")
        with patch.object(run.os, "open", side_effect=first) as opened, patch.object(run.os, "write") as write, patch.object(run.os, "close") as close:
            with self.assertRaises(FileExistsError) as observed: run.create_claim(Path("/never-used"), b"claim")
        self.assertIs(observed.exception, first); opened.assert_called_once(); write.assert_not_called(); close.assert_not_called()

    def test_final_metadata_failure_always_closes_and_preserves_original_error(self):
        run = runner_module()
        class FakeArtifacts:
            entries = {}
            closed = 0
            def seal(self): return []
            def put(self, *_): raise OSError(errno.ENOSPC, "result")
            def close(self): self.closed += 1; return [{"errno": errno.EBADF}]
        for first in (None, {"errno": errno.EIO, "phase": "execution"}):
            artifacts = FakeArtifacts(); result = {"state": "F2_METADATA_CAPTURED", "original_error": first, "secondary_errors": []}
            def record(error, phase, primary=True):
                result["secondary_errors"].append({"phase": phase, "errno": error.errno})
            run.finish_artifacts(artifacts, result, record)
            self.assertEqual(artifacts.closed, 1); self.assertIs(result["original_error"], first)
            self.assertEqual(result["secondary_errors"], [{"phase": "metadata", "errno": errno.ENOSPC}])
            self.assertEqual(result["final_artifact_errors"], [{"errno": errno.EBADF}])
            self.assertEqual(result["state"], "FAILED_NO_RETRY" if first else "EVIDENCE_UNPROVEN")

    def test_seal_or_serialization_error_always_reaches_final_close(self):
        run = runner_module()
        class FakeArtifacts:
            closed = 0
            entries = {}
            def seal(self): raise OSError(errno.EIO, "seal")
            def close(self): self.closed += 1; raise OSError(errno.EBADF, "close")
        artifacts = FakeArtifacts(); result = {"state": "F2_METADATA_CAPTURED", "original_error": None}
        errors = []
        run.finish_artifacts(artifacts, result, lambda error, phase, **_: errors.append((phase, error.errno)))
        self.assertEqual(artifacts.closed, 1)
        self.assertEqual(errors, [("metadata", errno.EIO), ("artifact-close", errno.EBADF)])
        self.assertEqual(result["state"], "EVIDENCE_UNPROVEN")

    def test_offline_record_failure_cannot_replace_original_preparation_error(self):
        builder = runner_module().builder
        first = ValueError("fixed input mismatch"); last = OSError(errno.ENOSPC, "BUNDLE record")
        request = {"run_id": RUN, "base_bundle": "/never-used/base", "base_bundle_sha256": "0" * 64,
                   "brd": "/never-used/brd", "payload_root": "/never-used/payload"}
        with tempfile.TemporaryDirectory(prefix="whole-brd-f2-offline-") as directory, \
             patch.object(builder, "source_bindings", return_value={}), patch.object(builder, "verify_base", side_effect=first), \
             patch.object(Path, "write_text", side_effect=last):
            with self.assertRaises(ValueError) as observed: builder.prepare(request, Path(directory) / "bundle")
        self.assertIs(observed.exception, first)
        self.assertEqual(first.bundle_record_error["errno"], errno.ENOSPC)

    def test_execute_claim_failure_never_constructs_child_and_finishes_artifacts(self):
        run = runner_module()
        class FakeArtifacts:
            closed = 0
            entries = {}
            def seal(self): return []
            def put(self, *_): pass
            def close(self): self.closed += 1; return []
        artifacts = FakeArtifacts()
        proposal = f2.plan(json.dumps({"run_id": RUN}).encode())
        bundle = {"request": {"run_id": RUN}, "proposal": proposal}
        with patch.object(run, "validate", return_value=({}, bundle, {})), patch.object(run, "Artifacts", return_value=artifacts), \
             patch.object(run, "create_claim", side_effect=FileExistsError(errno.EEXIST, "one attempt")), \
             patch.object(run, "OwnedChild", side_effect=AssertionError("no actual child")) as child:
            result = run.execute("/never-used/BUNDLE.json", "0" * 64, "/never-used/output")
        child.assert_not_called(); self.assertEqual(artifacts.closed, 1)
        self.assertEqual(result["original_error"]["errno"], errno.EEXIST)
        self.assertEqual(result["state"], "FAILED_NO_RETRY"); self.assertEqual(result["guest_attempts"], 0)


class DecoderTests(unittest.TestCase):
    """Synthetic ABI bytes exercise the consumer, never count as qualification."""
    def frames(self):
        p1 = PolicyTests().fixture(); p = f2.plan(json.dumps({"run_id": RUN}).encode())
        j = lambda value: json.dumps(value).encode()
        source_stat = {"fd": 3, "dev": 256, "ino": 2, "mode": stat.S_IFDIR | 0o700,
                       "uid": 1000, "gid": 1000, "nlink": 3, "size": 4096, "mtime": [1, 0], "ctime": [1, 0]}
        status = p1["observations"]["status_before"]["raw"].replace(b"Pid:\t2\n", b"Pid:\t4\n")
        data = {name: b"" for name, _, _ in f2.METADATA}
        data.update(status_before=status, status_after=status, self_stat=b"4 (brd-f2) R 1\n",
            boot_id=p1["observations"]["boot_id"]["raw"],
            module_notes=struct.pack("<III", 4, 20, 3) + b"GNU\0" + bytes.fromhex(f2.BRD_BUILD_ID),
            module_srcversion=f2.BRD_SRCVERSION, module_rd_nr=b"1\n", module_rd_size=b"65536\n", module_max_part=b"1\n",
            modules=b"brd 12345 0 - Live 0x0\n", sys_block=b"loop0\0loop1\0ram0\0", device_dev=b"1:0\n",
            device_size=b"131072\n", device_logical=b"512\n", device_physical=b"4096\n", device_ro=b"0\n",
            device_partition=b"absent\n", source_open=j({"fd": 3}), source_stat_before=j(source_stat), source_stat_after=j(source_stat),
            source_statfs=j({"magic": 0xef53, "block_size": 4096}), source_flags=struct.pack("<Q", 0x80000),
            source_uuid=b"\x10" + uuid.UUID(p["filesystem_uuid"]).bytes,
            source_fid=struct.pack("<QIiII", 101, 8, 1, 2, 99) + bytes(120),
            effective_options=b"rw,data=ordered,dax=never,errors=remount-ro,acl,user_xattr\n",
            mountinfo=b"51 1 1:0 / /mnt/brd rw,nosuid,nodev,noexec,relatime - ext4 /dev/ram0 rw,data=ordered\n")
        for name, mask, mount_id in (("source_statx_unique", 0x4fff, 101), ("source_statx_legacy", 0x17ff, 51)):
            raw = bytearray(256); struct.pack_into("<I", raw, 0, mask)
            struct.pack_into("<IIIH", raw, 16, 3, 1000, 1000, stat.S_IFDIR | 0o700)
            struct.pack_into("<QQ", raw, 32, 2, 4096); struct.pack_into("<Q", raw, 56, 0x200000)
            struct.pack_into("<IIQ", raw, 136, 1, 0, mount_id); data[name] = bytes(raw)
        tune = bytearray(232); struct.pack_into("<III", tune, 64, 60, 710, 1131); data["source_tune"] = bytes(tune)
        strings = b"ext4\0/\0/mnt/brd\0"; mount = bytearray(512 + len(strings)); mount[512:] = strings
        struct.pack_into("<IIQIIQIIQQI", mount, 0, len(mount), 0, 59, 1, 0, 0xef53, 0, 0, 101, 1, 51)
        struct.pack_into("<QQ", mount, 64, 0x0e, 1 << 18); struct.pack_into("<II", mount, 104, 5, 7)
        data["source_mount"] = bytes(mount)
        for name in f2.HEALTH: data["health_" + name] = b"\n" if name.endswith("_func") else b"0\n"
        ordinary = [{"run_id": RUN, "origin": "ordinary", "phase": "metadata", "seq": seq, "item": name, "path": path,
                     "status": "ABSENT" if name == "device_partition" else "OK", "errno": 2 if name == "device_partition" else 0,
                     "close_errno": 0, "eof": True, "bytes": len(data[name]), "data_hex": data[name].hex()}
                    for seq, (name, path, _) in enumerate(f2.METADATA, 1)]
        raw_data = {name: b"" for name in f2.EVENTS[:-1]}
        wait = lambda pid: {"pid": pid, "exit": 0, "signal": 0, "timeout": False, "reaped": True, "pidfd_before_ack": True}
        raw_data.update({"p1-exit": j(wait(2)), "metadata-exit": j(wait(4)),
            "format-exit": j(wait(3) | {"stdout_eof": True, "stderr_eof": True}),
            "policy-gate": b"SOURCE_INFERRED_FALSE_FOR_CURRENT_BOOT",
            "config-check": (ROOT / "scripts/qualification/whole-brd/mke2fs-f2.conf").read_bytes(),
            "module-load": b"rd_nr=1 rd_size=65536 max_part=1", "brd-family": b"loop0\0loop1\0ram0\0",
            "device-create": b"1:0", "device-geometry": j({"bytes": 64 * f2.MIB, "logical_block_size": 512}),
            "guest-complete": j({"original_errno": 0, "cleanup_errno": 0, "metadata_complete": True,
                "module_loaded": False, "mounted": False, "node_exists": False, "children_reaped": True,
                "parent_closes": [{"fd": 3, "errno": 0}, {"fd": 4, "errno": 0}]})})
        d = f2._module("diagnostics")
        for phase in ("prepared", "unmounted"):
            sb = bytearray(1024); struct.pack_into("<I", sb, 4, 16384); struct.pack_into("<I", sb, 24, 2)
            struct.pack_into("<HH", sb, 56, 0xef53, 1); struct.pack_into("<H", sb, 88, 256)
            struct.pack_into("<III", sb, 92, 60, 706, 1131); sb[104:120] = uuid.UUID(p["filesystem_uuid"]).bytes
            struct.pack_into("<I", sb, 224, 8); struct.pack_into("<H", sb, 254, 64); sb[0x175] = 1
            struct.pack_into("<I", sb, 1020, d.crc32c(sb[:1020]))
            gd = bytearray(64); struct.pack_into("<I", gd, 8, 5)
            inode = bytearray(256); struct.pack_into("<H", inode, 0, stat.S_IFREG | 0o600)
            struct.pack_into("<I", inode, 4, 4 * f2.MIB); struct.pack_into("<I", inode, 32, 0x80000)
            struct.pack_into("<HHHHI", inode, 40, 0xf30a, 1, 4, 0, 0); struct.pack_into("<IHHI", inode, 52, 0, 1024, 0, 6)
            header = bytearray(4096); struct.pack_into(">6I", header, 0, 0xc03b3998, 4, 0, 4096, 1024, 1)
            header[48:64] = uuid.UUID(p["filesystem_uuid"]).bytes; struct.pack_into(">I", header, 64, 1)
            if phase == "unmounted":
                struct.pack_into(">III", header, 36, 0, 0x12, 0); header[80] = 4
                struct.pack_into(">I", header, 0xfc, d.crc32c(header[:1024]))
            for name, raw in (("superblock", sb), ("group-descriptor", gd), ("journal-inode", inode), ("journal-header", header)):
                raw_data[phase + "-" + name] = bytes(raw)
        frames = [("BRDF1", {"run_id": RUN, "origin": "management", "event": "ordinary-start"})]
        for seq, name in enumerate(f2.EVENTS[:-1], 1):
            raw = raw_data[name]
            frames.append(("BRDF2", {"run_id": RUN, "origin": "management", "seq": seq, "event": name,
                "rc": 0, "errno": 0, "close_errno": 0, "bytes": len(raw), "data_hex": raw.hex()}))
            if name == "p1-start":
                frames += [("BRDF1", copy.deepcopy(row["frame"])) for row in p1["observations"].values()]
                frames.append(("BRDF1", copy.deepcopy(p1["wait"])))
            if name == "metadata-start": frames += [("BRDF2", row) for row in ordinary]
        return frames

    def consume(self, frames):
        raw = b"".join(tag.encode() + b" " + json.dumps(frame).encode() + b"\n" for tag, frame in frames)
        return f2.decode_serial(raw, RUN, b"exact-notes")

    def rejected(self, frames):
        try: result = self.consume(frames)
        except ValueError: return
        self.assertEqual(result["state"], "F2_FAILED", result.get("errors"))
        self.assertEqual(result["qualification"], "UNSUPPORTED")

    def test_complete_synthetic_capture_is_only_metadata_not_full_qualification(self):
        result = self.consume(self.frames())
        self.assertEqual(result["state"], "F2_METADATA_CAPTURED", result["errors"])
        self.assertEqual(result["qualification"], "UNSUPPORTED"); self.assertEqual(result["content_probes"], 0)
        self.assertFalse(result["metadata"]["commit_barrier"]); self.assertFalse(result["metadata"]["production_bound"])

    def test_p1_frames_cannot_be_moved_after_target_creation(self):
        frames = self.frames()
        self.rejected([row for row in frames if row[0] == "BRDF2"] + [row for row in frames if row[0] == "BRDF1"])

    def test_missing_replayed_or_out_of_phase_ordinary_frames_are_rejected(self):
        frames = self.frames(); index = next(i for i, (_, r) in enumerate(frames) if r.get("item") == "source_uuid")
        self.rejected(frames[:index] + frames[index+1:])
        self.rejected(frames[:index] + [frames[index]] + frames[index:])
        self.rejected([frames[index]] + frames[:index] + frames[index+1:])

    def test_wrong_identity_features_health_or_fid_are_rejected(self):
        for item, value in (("source_uuid", bytes(17)), ("source_tune", bytes(232)), ("source_fid", bytes(144)),
                            ("boot_id", b"512e9c36-df93-4cbb-b77a-4047c52a343b\n"), ("health_errors_count", b"1\n"),
                            ("sys_block", b"loop0\0loop1\0ram0\0ram1\0")):
            with self.subTest(item=item):
                frames = self.frames(); row = next(r for _, r in frames if r.get("item") == item and r.get("phase") == "metadata")
                row.update(bytes=len(value), data_hex=value.hex()); self.rejected(frames)

    def test_bad_checksum_child_wait_or_cleanup_never_becomes_capture_success(self):
        for event in ("unmounted-journal-header", "metadata-exit", "guest-complete"):
            with self.subTest(event=event):
                frames = self.frames(); row = next(r for _, r in frames if r.get("event") == event)
                raw = bytes.fromhex(row["data_hex"])
                if event == "unmounted-journal-header": raw = raw[:100] + bytes([raw[100] ^ 1]) + raw[101:]
                else:
                    value = json.loads(raw)
                    if event == "metadata-exit": value["reaped"] = False
                    else: value["parent_closes"][0]["errno"] = errno.EBADF
                    raw = json.dumps(value).encode()
                row.update(bytes=len(raw), data_hex=raw.hex()); self.rejected(frames)

    def test_host_success_requires_real_normal_exit_beyond_verified_resource_cleanup(self):
        run = runner_module()
        raw = b"".join(tag.encode() + b" " + json.dumps(frame).encode() + b"\n" for tag, frame in self.frames())
        proposal = f2.plan(json.dumps({"run_id": RUN}).encode())
        bundle = {"request": {"run_id": RUN}, "proposal": proposal, "runtime_environment": {},
            "qemu_data": {"path": "/unused/firmware"}, "inputs": {name: {"path": "/unused/" + name, "sha256": "0" * 64}
            for name in ("qemu", "kernel", "bios", "initramfs", "gate")}}
        class FakeArtifacts:
            entries = {}
            def seal(self): return []
            def put(self, *_): pass
            def close(self): return []
        class FakeProcess:
            def poll(self): return 0
        class FakeOwned:
            proc = FakeProcess(); argv = []; gate_argv = []; serial_identity = {}; before = {}; after = {}; events = []
            def release(self, *_): pass
            def cleanup(self, *_): return cleanup
        class FakePump:
            serial = raw; errors = []; eof = {"serial", "qmp", "stderr"}; read_counts = {}
            def __init__(self, _, artifacts, callback): callback(raw)
            def poll(self, *_): pass
            def finish(self, *_): pass
        class FakeQMP:
            receipts = []
            def __init__(self, *_): pass
        normal = {"verified": True, "forced": False, "wait_timeout": False, "wait": {"reaped": True, "returncode": 0}}
        cases = [normal, normal | {"forced": True}, normal | {"wait_timeout": True},
                 normal | {"wait": {"reaped": True, "returncode": -9}}, normal | {"wait": {"reaped": True, "returncode": 1}},
                 normal | {"wait": {"reaped": False, "returncode": None}}, normal | {"wait": {"reaped": True, "returncode": False}}]
        for index, cleanup in enumerate(cases):
            with self.subTest(cleanup=cleanup), patch.object(run, "validate", return_value=({}, bundle, {"notes": b"exact-notes"})), \
                 patch.object(run, "Artifacts", return_value=FakeArtifacts()), patch.object(run, "create_claim"), \
                 patch.object(run, "bounded_read", return_value=b""), patch.object(run, "OwnedChild", return_value=FakeOwned()), \
                 patch.object(run, "Pump", FakePump), patch.object(run, "QMP", FakeQMP):
                result = run.execute("/unused/BUNDLE.json", "0" * 64, "/unused/output")
            self.assertEqual(result["state"], "F2_METADATA_CAPTURED" if index == 0 else "FAILED_NO_RETRY")


class GuestFailureControls(unittest.TestCase):
    """A compiled mock translation only; every target syscall is replaced.

    No payload, guest, target child, pipe, socket, block device or module is run.
    The one small test executable only emits virtual lifecycle receipts.
    """
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="whole-brd-f2-pure-")
        directory = Path(cls.temp.name); cls.binary = directory / "control"
        source = r'''
#define F2_PURE_TEST 1
#define F2_FIXED_INPUTS 1
static const unsigned char F2_EXPECTED_NOTES[] = {1};
static const unsigned char F2_EXPECTED_CONFIG[] = {1};
#define pipe2 test_pipe2
#define fork test_fork
#define close test_close
#define open test_open
#define fstat test_fstat
#define syscall test_syscall
#define read test_read
#define write test_write
#define waitpid test_waitpid
#define getpid test_getpid
#define getuid test_getuid
#define geteuid test_geteuid
#define reboot test_reboot
#define kill test_kill
#define mount test_mount
#define umount2 test_umount2
#define mknod test_mknod
#define unlink test_unlink
#define execve test_execve
#define fcntl test_fcntl
#define ioctl test_ioctl
#define clock_gettime test_clock_gettime
#define nanosleep test_nanosleep
#include "f2-guest.c"
#include <stdarg.h>
static int mode, next_fd=700, closed[1024], ack_count, root_operations, fork_count, pipe_count, reboot_count, read_count, wait_count, signal_count, held_pidfd=-1;
static unsigned clock_ticks;
int test_pipe2(int fds[2], int flags) { (void)flags; ++pipe_count; if(mode==4){errno=EMFILE;return -1;} fds[0]=next_fd++;fds[1]=next_fd++;return 0; }
pid_t test_fork(void) { ++fork_count; if(mode==3||mode==5){errno=EAGAIN;return -1;}return 1234; }
int test_close(int fd) { if(fd<700||fd>=1024)abort();++closed[fd];if(fd==700&&mode==1){errno=EBADF;return -1;}return 0; }
int test_open(const char *path, int flags, ...) { (void)flags; ++root_operations;if(mode<5)abort();if(strcmp(path,"/usr/sbin/mke2fs")&&strcmp(path,"/dev/null"))abort();return next_fd++; }
int test_fstat(int fd, struct stat *s) { if(fd!=700)abort();memset(s,0,sizeof(*s));s->st_mode=S_IFREG|0555;s->st_size=146000;s->st_nlink=1;return 0; }
long test_syscall(long number, ...) {
    if(number==SYS_pidfd_send_signal){
        va_list args;va_start(args,number);int fd=va_arg(args,int),sig=va_arg(args,int);va_end(args);
        if(fd!=held_pidfd||fd<700||closed[fd]||sig!=SIGKILL)abort();
        ++signal_count;return 0;
    }
    if(number!=SYS_pidfd_open)abort();
    if(mode==2){errno=EIO;return -1;}
    if(mode==16||mode==17){errno=EMFILE;return -1;}
    held_pidfd=next_fd++;return held_pidfd;
}
ssize_t test_read(int fd, void *data, size_t size) {
    (void)fd;if(mode<5)abort();
    if(read_count<0){errno=EIO;return -1;}
    if((size_t)read_count>size)abort();
    if(read_count>0)memset(data,'D',(size_t)read_count);
    return read_count;
}
ssize_t test_write(int fd, const void *data, size_t size) { (void)fd;if(size!=1||*(const char*)data!='G')abort();++ack_count;return 1; }
pid_t test_waitpid(pid_t pid, int *status, int flags) {
    if(pid!=1234||flags!=WNOHANG)abort();
    ++wait_count;
    if(mode==16||mode==17){errno=ECHILD;return -1;}
    if(mode>=8&&mode<=15&&(wait_count==1||mode>=12)){errno=(mode==8||mode==9||mode==12||mode==13)?EINTR:EIO;return -1;}
    *status=signal_count?SIGKILL:mode>=5?0:256;return pid;
}
int test_clock_gettime(clockid_t clock, struct timespec *value) {
    if(clock!=CLOCK_MONOTONIC)abort();
    unsigned ticks=mode>=8?clock_ticks++:0;value->tv_sec=ticks/4;value->tv_nsec=(ticks%4)*250000000L;return 0;
}
int test_nanosleep(const struct timespec *request, struct timespec *remaining) { (void)request;(void)remaining;return 0; }
pid_t test_getpid(void) { return 1; }
uid_t test_getuid(void) { return 0; }
uid_t test_geteuid(void) { return 0; }
int test_reboot(int command) { if(command!=RB_POWER_OFF)abort();++reboot_count;return 0; }
int test_kill(pid_t pid,int signal) { (void)pid;(void)signal;abort(); }
int test_mount(const char*a,const char*b,const char*c,unsigned long d,const void*e){(void)a;(void)b;(void)c;(void)d;(void)e;abort();}
int test_umount2(const char*a,int b){(void)a;(void)b;abort();}
int test_mknod(const char*a,mode_t b,dev_t c){(void)a;(void)b;(void)c;abort();}
int test_unlink(const char*a){(void)a;abort();}
int test_execve(const char*a,char*const b[],char*const c[]){(void)a;(void)b;(void)c;abort();}
int test_fcntl(int fd,int command,...){(void)fd;if(mode<5||command!=F_SETFL)abort();return 0;}
int test_ioctl(int fd,unsigned long command,...){(void)fd;(void)command;abort();}
int main(int argc,char**argv){
    if(argc!=2)return 64;
    mode=atoi(argv[1]);strcpy(run_id,"9ac818aa-3fe1-4f28-8b5e-119430876bdd");
    (void)collect_p1;(void)metadata;(void)load_uuid;
    if(mode==7){
        char buffer[4]={'X','X','X','X'};
        read_count=2;if(test_read(700,buffer,sizeof(buffer))!=2||memcmp(buffer,"DDXX",4))return 84;
        read_count=0;if(test_read(700,buffer,sizeof(buffer))!=0||memcmp(buffer,"DDXX",4))return 85;
        read_count=-1;if(test_read(700,buffer,sizeof(buffer))!=-1||errno!=EIO||memcmp(buffer,"DDXX",4))return 86;
        puts("READ_CONTRACT positive_range_only eof_unchanged error_unchanged");return 0;
    }
    if(mode>=8&&mode<=17){
        struct child_result child=mode%2?format_child():ordinary_child("p1");
        for(int fd=700;fd<next_fd;++fd)if(closed[fd]!=1)return 87;
        if(wait_count<2)return 88;
        if(mode<10){if(!child_ok(child)||signal_count)return 89;}
        else if(mode<12){if(!child.reaped||child.error!=EIO||signal_count!=1||child_ok(child))return 90;}
        else if(mode<16){if(child.reaped||signal_count!=1||child_ok(child)||child.error!=(mode<14?ETIMEDOUT:EIO))return 91;}
        else {if(child.reaped||child.error!=EMFILE||signal_count||child_ok(child))return 92;}
        printf("WAIT_CONTROL {\"mode\":%d,\"wait_calls\":%d,\"signals\":%d,\"reaped\":%s,\"error\":%d,\"timed_out\":%s,\"clock_ticks\":%u}\n",
            mode,wait_count,signal_count,child.reaped?"true":"false",child.error,child.timed_out?"true":"false",clock_ticks);
        return 0;
    }
    int rc;
    if(mode<5){rc=bootstrap_f2();if(rc!=1||root_operations||reboot_count!=1)return 80;}
    else {struct child_result child=format_child();rc=child_ok(child)?0:1;if(mode==5?(rc!=1):(rc!=0))return 81;}
    for(int fd=700;fd<next_fd;++fd)if(closed[fd]!=1)return 82;
    if((mode==1||mode==2||mode==3||mode==4||mode==5)&&ack_count)return 83;
    printf("CONTROL {\"mode\":%d,\"closed\":%d,\"root_operations\":%d,\"ack\":%d,\"pipes_virtual\":%d,\"forks_virtual\":%d}\n",mode,next_fd-700,root_operations,ack_count,pipe_count,fork_count);
    return 0;
}
'''
        path = directory / "control.c"; path.write_text(source)
        compile_result = subprocess.run(["/usr/bin/cc", "-std=c11", "-Os", "-Wall", "-Wextra", "-Werror",
            "-I", str(ROOT / "scripts/qualification/whole-brd"), str(path), "-o", str(cls.binary)],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=10, env={"PATH": "/usr/bin:/bin", "LANG": "C"})
        if compile_result.returncode: raise AssertionError(compile_result.stderr.decode())

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def test_failed_p1_and_each_ownership_failure_prevent_all_target_operations(self):
        for mode in range(5):
            with self.subTest(mode=mode):
                result = subprocess.run([str(self.binary), str(mode)], stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stdout.decode()+result.stderr.decode())
                self.assertLess(len(result.stdout), 16384)
                rows = [json.loads(line[8:]) for line in result.stdout.splitlines() if line.startswith(b"CONTROL ")]
                self.assertEqual(len(rows), 1); self.assertEqual(rows[0]["root_operations"], 0)
                receipts = [json.loads(line[6:]) for line in result.stdout.splitlines() if line.startswith(b"BRDF2 ")]
                final = json.loads(bytes.fromhex(next(r for r in receipts if r.get("event") == "guest-complete")["data_hex"]))
                self.assertEqual(final["original_errno"], (errno.EPROTO, errno.EBADF, errno.EIO, errno.EAGAIN, errno.EMFILE)[mode])

    def test_formatter_virtual_fork_failure_and_success_reclaim_all_acquired_handles(self):
        for mode in (5, 6):
            with self.subTest(mode=mode):
                result = subprocess.run([str(self.binary), str(mode)], stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stdout.decode()+result.stderr.decode())
                self.assertLess(len(result.stdout), 16384)

    def test_virtual_read_writes_only_successful_range_and_preserves_eof_error_buffers(self):
        result = subprocess.run([str(self.binary), "7"], stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stdout.decode()+result.stderr.decode())
        self.assertEqual(result.stdout, b"READ_CONTRACT positive_range_only eof_unchanged error_unchanged\n")

    def test_wait_interruption_and_errors_retain_ownership_until_reap_or_original_deadline(self):
        for mode in range(8, 18):
            with self.subTest(mode=mode):
                result = subprocess.run([str(self.binary), str(mode)], stdin=subprocess.DEVNULL, capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stdout.decode()+result.stderr.decode())
                rows = [json.loads(line[13:]) for line in result.stdout.splitlines() if line.startswith(b"WAIT_CONTROL ")]
                self.assertEqual(len(rows), 1)
                self.assertLess(rows[0]["clock_ticks"], 160)
                self.assertEqual(rows[0]["timed_out"], mode in (12, 13))


if __name__ == "__main__": unittest.main()

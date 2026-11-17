"""DM-linear 纯控制。合成字节只检验消费者，不代表任何原生设备资格。"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "scripts/qualification/whole-brd"))
import f3

SPEC = importlib.util.spec_from_file_location("f3_dm", ROOT / "scripts/qualification/whole-brd/f3-dm.py")
dm = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dm
SPEC.loader.exec_module(dm)
RUN = "358af363-b224-4d47-a5b6-5a4573192db3"
NAME = "br-f3-" + RUN.replace("-", "")
UUID = "boardroom-f3-dm:" + RUN
DEV = (253 << 8) | 7


def response(*, command="status", flags=32, targets=1, device=DEV, body=b"", name=NAME, uuid=UUID):
    # 独立列出固定 UAPI 布局；无参数响应 data_size 是 data 的 offset 305，不是 sizeof 312。
    size = 312 + len(body) if body or command == "list" else 305
    raw = bytearray(max(312, size))
    struct.pack_into("<6Ii3IQ", raw, 0, 4, 50, 0, size, 312, targets, 0, flags, 0, 0, device)
    raw[48:48 + len(name)] = name.encode()
    raw[176:176 + len(uuid)] = uuid.encode()
    raw[312:] = body
    return bytes(raw[:size])


def table_bytes():
    # 响应 next=48 是从首 target 算起的对齐位置；data_size 只含实际字符串到 NUL 的 46 字节。
    return struct.pack("<QQiI16s", 0, 131072, 0, 48, b"linear") + b"1:0 0\0"


def statistics(values):
    return (" ".join(map(str, values)) + "\n").encode()


def calibration():
    a, b = bytes(range(256)) * 16, bytes([0xa5]) * 4096
    state = [0] * 17
    rows = []
    for operation, actual in (("read-original", a), ("write-pattern", b), ("read-pattern", b),
                              ("restore-original", a), ("read-restored", a)):
        before = statistics(state)
        offset = 4 if operation in ("write-pattern", "restore-original") else 0
        state[offset] += 1
        state[offset + 2] += 8
        state[9] += 1
        rows.append({"operation": operation, "rc": 4096, "errno": 0,
                     "data_hex": actual.hex(), "before_hex": before.hex(), "after_hex": statistics(state).hex()})
    return {"device": DEV, "fd": 8, "flags": 0x8002 | 0x4000, "close_errno": 0,
            "iostats_hex": b"1\n".hex(), "steps": rows}


class AbiControls(unittest.TestCase):
    def setUp(self):
        self.identity = dm.decode_ioctl(response(command="create", flags=0, targets=0), "create", RUN)

    def test_profile_is_explicit_and_preserves_old_limits(self):
        proposal = dm.plan(f3.encoded({"run_id": RUN}))
        self.assertEqual(proposal["profile"], dm.PROFILE)
        self.assertEqual(proposal["limits"], f3.LIMITS)
        self.assertEqual(proposal["max_snapshots"], 4)
        self.assertFalse(proposal["production_bound"])
        for extra in ({"device": "1:0"}, {"verified": True}, {"profile": "other"}, {"buffer_bytes": 32768}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                dm.plan(f3.encoded({"run_id": RUN, **extra}))

    def test_create_binds_actual_dynamic_device_not_assumed_minor(self):
        self.assertEqual((self.identity.major, self.identity.minor), (253, 7))
        other = dm.decode_ioctl(response(command="create", flags=0, targets=0, device=(254 << 8) | 19), "create", RUN)
        self.assertEqual((other.major, other.minor), (254, 19))
        self.assertEqual(self.identity.name, NAME)
        self.assertEqual(self.identity.uuid, UUID)

    def test_only_uuid_selects_post_create_requests(self):
        for command in ("load", "resume", "status", "table", "deps", "remove"):
            with self.subTest(command=command):
                request = dm.ioctl_request(command, RUN)
                self.assertEqual(len(request), 16384)
                self.assertEqual(request[48:176], bytes(128))
                self.assertEqual(struct.unpack_from("<Q", request, 40)[0], 0)
                self.assertEqual(request[176:176 + len(UUID)], UUID.encode())
        for command in ("rename", "clear", "suspend", "remove-all", "target-msg"):
            with self.subTest(command=command), self.assertRaises(ValueError):
                dm.ioctl_request(command, RUN)

    def test_exact_table_response_and_dependency(self):
        self.assertEqual(dm.decode_ioctl(response(command="table", flags=48, body=table_bytes()), "table", RUN, self.identity), self.identity)
        self.assertEqual(dm.decode_ioctl(response(command="deps", body=struct.pack("<IIQ", 1, 0, 256)), "deps", RUN, self.identity), self.identity)

    def test_header_flags_versions_sizes_and_identity_are_strict(self):
        valid = response()
        variants = [valid[:-1], valid + b"\0", response(flags=32 | 64), response(flags=32 | 2),
                    response(flags=32 | 256), response(flags=32 | (1 << 17)), response(flags=32 | (1 << 30)),
                    response(device=DEV + 1), response(name=NAME + "x"), response(uuid=UUID[:-1] + "4"),
                    response(targets=2)]
        for offset, value in ((4, 49), (12, 304), (16, 304), (36, 1)):
            changed = bytearray(valid); struct.pack_into("<I", changed, offset, value); variants.append(bytes(changed))
        changed = bytearray(valid); changed[48:176] = b"x" * 128; variants.append(bytes(changed))
        for raw in variants:
            with self.subTest(raw=raw[:48].hex()), self.assertRaises(ValueError):
                dm.decode_ioctl(raw, "status", RUN, self.identity)

    def test_wrong_table_or_extra_bytes_are_not_accepted(self):
        body = table_bytes()
        variants = [body[:-1], body + b"\0", body.replace(b"1:0 0", b"1:1 0"),
                    body.replace(b"linear", b"error\0"), body[:24] + b"x" * 16 + body[40:]]
        for offset, fmt, value in ((0, "Q", 1), (8, "Q", 131071), (16, "i", -1), (20, "I", 0), (20, "I", 4096)):
            changed = bytearray(body); struct.pack_into("<" + fmt, changed, offset, value); variants.append(bytes(changed))
        for value in variants:
            with self.subTest(body=value.hex()), self.assertRaises(ValueError):
                dm.decode_ioctl(response(command="table", flags=48, body=value), "table", RUN, self.identity)
        for body in (struct.pack("<IIQ", 2, 0, 256), struct.pack("<IIQ", 1, 0, 257), struct.pack("<IIQ", 1, 1, 256)):
            with self.assertRaises(ValueError):
                dm.decode_ioctl(response(command="deps", body=body), "deps", RUN, self.identity)

    def test_empty_unfiltered_list_requires_no_device_records(self):
        dm.decode_ioctl(response(command="list", flags=0, targets=0, device=0, name="", uuid=""), "list", RUN)
        with self.assertRaises(ValueError):
            dm.decode_ioctl(response(command="list", flags=0, targets=0, device=0, name="", uuid="", body=bytes(16)), "list", RUN)


class CalibrationControls(unittest.TestCase):
    def test_five_exact_operations_account_reads_and_writes(self):
        result = dm.decode_calibration(calibration(), DEV)
        self.assertEqual(result, {"reads": 3, "read_sectors": 24, "writes": 2, "write_sectors": 16})

    def test_unknown_short_error_inflight_no_accounting_and_close_refuse(self):
        variants = []
        for key, value in (("close_errno", 5), ("device", 256), ("iostats_hex", b"0\n".hex()), ("flags", 0)):
            changed = calibration(); changed[key] = value; variants.append(changed)
        for key, value in (("rc", 4095), ("rc", True), ("errno", 5), ("operation", "discard"), ("data_hex", bytes(4096).hex())):
            changed = calibration(); changed["steps"][2][key] = value; variants.append(changed)
        changed = calibration(); changed["steps"][0]["after_hex"] = changed["steps"][0]["before_hex"]; variants.append(changed)
        for index in (1, 5, 8, 11, 12, 13, 15):
            changed = calibration(); values = list(map(int, bytes.fromhex(changed["steps"][2]["after_hex"]).split())); values[index] += 1
            changed["steps"][2]["after_hex"] = statistics(values).hex(); variants.append(changed)
        changed = calibration(); changed["steps"].pop(); variants.append(changed)
        changed = calibration(); changed["verified"] = True; variants.append(changed)
        for value in variants:
            with self.subTest(value=list(value)), self.assertRaises(ValueError):
                dm.decode_calibration(value, DEV)



def node(rdev, mode, inode):
    return {"dev": 1, "ino": inode, "rdev": rdev, "mode": mode, "uid": 0, "gid": 0, "nlink": 1}


def topology():
    values = {"dev": b"253:7\n", "size": b"131072\n", "ro": b"0\n", "iostats": b"1\n",
              "name": (NAME + "\n").encode(), "uuid": (UUID + "\n").encode(), "holders": b"", "slaves": b"ram0\0",
              "partition": b"", "ram-holders": b"dm-7\0", "ram-slaves": b"", "ram-partition": b"",
              "sys-block": b"ram0\0dm-7\0", "ram-node": b""}
    return {"sysname": "dm-7", "resolved": "/sys/devices/virtual/block/dm-7", "sys_dev": 4, "sys_ino": 99,
            "node": node(DEV, 0o60600, 101), "size": 67108864, "control": node(2796, 0o20600, 102),
            "reads": [{"name": k, "errno": 2 if k in ("partition", "ram-partition", "ram-node") else 0,
                       "close_errno": 0, "hex": v.hex()} for k, v in values.items()]}


class TopologyControls(unittest.TestCase):
    def setUp(self):
        self.device = dm.decode_ioctl(response(command="create", flags=0, targets=0), "create", RUN)

    def test_bidirectional_graph_and_actual_node_identity(self):
        self.assertEqual(dm.decode_topology(topology(), self.device, set())["sysname"], "dm-7")

    def test_extra_backing_alias_missing_reverse_holder_and_unknown_fields_refuse(self):
        variants = []
        for name, value in (("holders", b"dm-8\0"), ("slaves", b"ram0\0ram1\0"), ("ram-holders", b""),
                            ("ram-slaves", b"dm-7\0"), ("sys-block", b"ram0\0dm-7\0loop0\0"),
                            ("iostats", b"0\n"), ("name", b"foreign\n")):
            value0 = topology(); next(r for r in value0["reads"] if r["name"] == name)["hex"] = value.hex(); variants.append(value0)
        for key, value in (("rdev", 256), ("nlink", 2), ("mode", 0o60666), ("ino", 0)):
            value0 = topology(); value0["node"][key] = value; variants.append(value0)
        value0 = topology(); value0["reads"][0]["close_errno"] = 5; variants.append(value0)
        value0 = topology(); value0["reads"].pop(); variants.append(value0)
        value0 = topology(); value0["verified"] = True; variants.append(value0)
        for value in variants:
            with self.subTest(value=value["reads"][0]), self.assertRaises(ValueError):
                dm.decode_topology(value, self.device, set())

    def test_snapshot_bound_to_dynamic_dm_is_not_accepted_by_old_ram0_consumer(self):
        binding = {"fd": 5, "device_dev": 1, "device_inode": 101, "rdev": DEV, "mode": 0o60600,
                   "uid": 0, "gid": 0, "nlink": 1, "bytes": 67108864, "block_bytes": 4096, "at_ns": "10", "closed": False}
        def frame(event, value, seq):
            raw = value if isinstance(value, bytes) else f3.encoded(value)
            return {"run_id": RUN, "origin": "management", "seq": seq, "event": event, "phase": "control-before",
                    "rc": 0, "errno": 0, "close_errno": 0, "bytes": len(raw), "data_hex": raw.hex()}
        frames = [frame("snapshot-begin", binding, 1), frame("snapshot-zero", struct.pack("<II", 0, 16384), 2),
                  frame("snapshot-end", binding | {"at_ns": "20", "closed": True}, 3)]
        actual = dm.decode_snapshot(frames, RUN, "control-before", self.device)
        self.assertEqual(actual.before["rdev"], DEV)
        with self.assertRaises(ValueError): f3.decode_snapshot(frames, RUN, "control-before")
        frames[-1] = frame("snapshot-end", binding | {"at_ns": "20", "closed": False}, 3)
        with self.assertRaises(ValueError): dm.decode_snapshot(frames, RUN, "control-before", self.device)


MOUNTS = (b"1 0 0:1 / / rw - rootfs rootfs rw\n"
          b"2 1 0:2 / /proc ro,nosuid,nodev,noexec - proc proc ro\n"
          b"3 1 0:3 / /sys ro,nosuid,nodev,noexec - sysfs sysfs ro\n")


def process_stat(pid, flags, start):
    fields = ["S"] + ["0"] * 19
    fields[6] = str(flags); fields[19] = str(start)
    return (str(pid) + " (fixture) " + " ".join(fields) + "\n").encode()


def fd_rows(enumerators):
    return [{"fd": fd, "flags": 0, "stat": node(1281, 0o20600, 5)} for fd in (0, 1, 2)] + [
        {"fd": fd, "flags": 0, "stat": node(0, 0o40555, fd + 50)} for fd in sorted(enumerators)]


def format_fds():
    return {"run_id": RUN, "origin": "format", "pid": 3, "uid": 0, "gid": 0,
            "executable_fd": 3, "executable_size": 146000, "enumerator": 4, "errno": 0, "close_errno": 0,
            "fds": [{"fd": fd, "flags": flags, "fd_flags": fdflags, "stat": info} for fd, flags, fdflags, info in (
                (0, 0, 0, node(259, 0o20666, 6)), (1, 1, 0, node(0, 0o10600, 81)), (2, 1, 0, node(0, 0o10600, 82)),
                (3, 0, 1, node(0, 0o100555, 83)), (4, 0, 1, node(0, 0o40555, 84)))]}


def census():
    rows = []
    for pid, flags in ((1, 0), (2, 0x200000)):
        raw = process_stat(pid, flags, 100 + pid).hex()
        rows.append({"pid": pid, "pin": 4, "proc_enumerator": 3, "before_hex": raw,
                     "fds": fd_rows({3, 4, 5}) if pid == 1 else [], "enumerator": 5, "after_hex": raw})
    observed = topology()
    end = {"process_count": 2, "nodes": [
        {"path": "/dev/console", "stat": node(1281, 0o20600, 5)}, {"path": "/dev/null", "stat": node(259, 0o20666, 6)},
        {"path": "/dev/boardroom-f3-dm", "stat": observed["node"]},
        {"path": "/dev/boardroom-f3-dm-control", "stat": observed["control"]}], "mountinfo_hex": MOUNTS.hex()}
    return rows, end


def dm_lifecycle():
    frames = []
    def add(event, phase, value):
        raw = value if isinstance(value, bytes) else f3.encoded(value)
        frames.append({"run_id": RUN, "origin": "management", "seq": len(frames) + 1, "event": event,
                       "phase": phase, "rc": 0, "errno": 0, "close_errno": 0,
                       "bytes": len(raw), "data_hex": raw.hex(), "raw": raw, "position": len(frames) + 1})
    add("dm-backing", "setup", {"reads": [{"name": k, "errno": 2 if k == "partition" else 0, "close_errno": 0, "hex": v.hex()}
        for k, v in {"dev": b"1:0\n", "size": b"131072\n", "ro": b"0\n", "holders": b"", "slaves": b"", "partition": b""}.items()]})
    add("dm-control", "setup", {"sysfs_hex": b"10:236\n".hex(), "resolved": "/sys/devices/virtual/misc/device-mapper", "node": topology()["control"]})
    add("dm-version", "setup", dm.ioctl_request("version", RUN))
    add("dm-list", "setup", response(command="list", flags=0, targets=0, device=0, name="", uuid=""))
    add("dm-create", "setup", response(command="create", flags=0, targets=0))
    add("dm-load", "setup", response(command="load", flags=64, targets=0))
    add("dm-resume", "setup", response(command="resume", flags=32 | 8192))
    add("dm-backing-retired", "setup", {"node": node(256, 0o60600, 100), "after_errno": 2})
    def observe(phase):
        add("dm-status", phase, response())
        add("dm-table", phase, response(command="table", flags=48, body=table_bytes()))
        add("dm-deps", phase, response(command="deps", body=struct.pack("<IIQ", 1, 0, 256)))
        add("dm-topology", phase, topology())
        add("dm-census-start", phase, b"")
        rows, end = census()
        for row in rows: add("dm-census-process", phase, row)
        add("dm-census-end", phase, end)
    observe("created")
    value = calibration()
    for row in value.pop("steps"): add("dm-calibration-step", "calibration", row)
    add("dm-calibration-end", "calibration", value)
    for phase in ("calibrated", "control-before", "control-after", "read-before", "read-after", "before-remove"): observe(phase)
    add("dm-remove", "cleanup", response(command="remove", flags=8192, targets=0, device=0))
    add("dm-list", "cleanup", response(command="list", flags=0, targets=0, device=0, name="", uuid=""))
    add("dm-removed", "cleanup", {"sysfs_errno": 2, "dev_link_errno": 2, "ram_holders_hex": "", "node_unlink_errno": 0,
                                   "control_unlink_errno": 0, "node_exists": False, "control_exists": False})
    return frames


class LifecycleControls(unittest.TestCase):
    def setUp(self):
        self.p1 = {"observations": {"sys_block": {"raw": b""}, "mountinfo": {"raw": MOUNTS}}}
        self.device = dm.decode_ioctl(response(command="create", flags=0, targets=0), "create", RUN)
        self.topology = dm.decode_topology(topology(), self.device, set())
        self.mounts = dm.f2._module("native").mountinfo(MOUNTS)

    def test_complete_synthetic_dm_lifecycle_is_only_unsupported_observation(self):
        remaining, value, device = dm.decode_dm_frames(dm_lifecycle(), RUN, self.p1)
        self.assertEqual(remaining, [])
        self.assertEqual(device, self.device)
        self.assertEqual(value["qualification"], "UNSUPPORTED")
        self.assertFalse(value["production_supported"])
        self.assertEqual(len(value["phases"]), 7)
        self.assertEqual(value["calibration"]["write_sectors"], 16)

    def test_omitted_reordered_replayed_or_unknown_lifecycle_refuses(self):
        original = dm_lifecycle()
        for i in range(len(original)):
            with self.subTest(omitted=original[i]["event"]), self.assertRaises(ValueError):
                dm.decode_dm_frames(original[:i] + original[i + 1:], RUN, self.p1)
        changed = copy.deepcopy(original); changed[4], changed[5] = changed[5], changed[4]
        with self.assertRaises(ValueError): dm.decode_dm_frames(changed, RUN, self.p1)
        with self.assertRaises(ValueError): dm.decode_dm_frames(original + [original[-1]], RUN, self.p1)
        changed = copy.deepcopy(original); changed[0]["event"] = "dm-verified"
        with self.assertRaises(ValueError): dm.decode_dm_frames(changed, RUN, self.p1)

    def test_unowned_process_reused_pid_bypass_fd_node_and_mount_refuse(self):
        variants = []
        rows, end = census(); rows[1]["before_hex"] = process_stat(2, 0, 102).hex(); variants.append((rows, end))
        rows, end = census(); rows[0]["after_hex"] = process_stat(1, 0, 999).hex(); variants.append((rows, end))
        rows, end = census(); rows[0]["fds"].append({"fd": 12, "flags": 2, "stat": node(256, 0o60600, 100)}); variants.append((rows, end))
        rows, end = census(); end["nodes"].append({"path": "/tmp/alias", "stat": topology()["node"]}); variants.append((rows, end))
        rows, end = census(); end["mountinfo_hex"] = (MOUNTS + b"4 1 1:0 / /foreign rw - ext4 /dev/ram0 rw\n").hex(); variants.append((rows, end))
        rows, end = census(); rows.pop(0); end["process_count"] = 1; variants.append((rows, end))
        for rows, end in variants:
            with self.subTest(rows=len(rows)), self.assertRaises(ValueError):
                dm.decode_census(rows, end, self.topology, self.device, self.mounts)

    def test_ordinary_inherited_fd_and_owner_close_are_not_boolean_evidence(self):
        def records():
            return [(i * 10 + 5, {"run_id": RUN, "origin": "ordinary", "pid": 10 + i, "uid": 1000, "gid": 1000,
                    "enumerator": 3, "fds": fd_rows({3}), "errno": 0, "close_errno": 0}) for i in range(3)]
        starts = [{"position": i * 10} for i in range(3)]; ends = [{"position": i * 10 + 9} for i in range(3)]
        waits = [{"pid": i + 10} for i in range(3)]
        dm.validate_ordinary_fds(records(), starts, ends, waits, RUN)
        for key, value in (("close_errno", 5), ("pid", 9), ("uid", 0)):
            changed = records(); changed[1][1][key] = value
            with self.assertRaises(ValueError): dm.validate_ordinary_fds(changed, starts, ends, waits, RUN)
        changed = records(); changed[0][1]["fds"].append({"fd": 4, "flags": 0, "stat": topology()["node"]})
        with self.assertRaises(ValueError): dm.validate_ordinary_fds(changed, starts, ends, waits, RUN)

    def test_format_entry_must_close_enumerator_and_keep_only_owned_exec_and_stdio(self):
        def wire(value): return b"BRDDM-MKFS " + f3.encoded(value) + b"fixed mke2fs stdout\n"
        dm.validate_format_fds(wire(format_fds()), {"pid": 3}, RUN)
        variants = []
        for key, value in (("close_errno", 5), ("pid", 8), ("uid", 1000), ("executable_size", 1)):
            altered = format_fds(); altered[key] = value; variants.append(altered)
        altered = format_fds(); altered["fds"][3]["fd_flags"] = 0; variants.append(altered)
        altered = format_fds(); altered["fds"].append({"fd": 8, "flags": 2, "fd_flags": 1, "stat": topology()["control"]}); variants.append(altered)
        for value in variants:
            with self.subTest(value=value.keys()), self.assertRaises(ValueError): dm.validate_format_fds(wire(value), {"pid": 3}, RUN)
        with self.assertRaises(ValueError): dm.validate_format_fds(wire(format_fds()) + wire(format_fds()), {"pid": 3}, RUN)

    def test_failed_close_raw_mismatch_and_position_reuse_are_rejected(self):
        for change in ("close_errno", "raw", "position"):
            frames = dm_lifecycle()
            frames[10][change] = {"close_errno": 5, "raw": b"changed", "position": frames[9]["position"]}[change]
            with self.subTest(change=change), self.assertRaises(ValueError):
                dm.decode_dm_frames(frames, RUN, self.p1)

    def test_dm_observations_surround_the_actual_format_rounds_and_cleanup(self):
        frames = dm_lifecycle()
        for i, row in enumerate(frames): row["position"] = (i + 1) * 100
        _, proof, _ = dm.decode_dm_frames(frames, RUN, self.p1)
        p = proof["phases"]
        anchors = {"geometry": 0, "device-remove": proof["backing_retired"] - 10,
                   "format-start": p["calibrated"]["end"] + 10, "mount-private": p["calibrated"]["end"] + 20,
                   "prepare-begin": p["calibrated"]["end"] + 30, "prepare-end": p["calibrated"]["end"] + 40,
                   "control-begin": p["control-before"]["end"] + 10,
                   "control-after-snapshot": p["control-after"]["start"] - 10,
                   "control-end": p["control-after"]["end"] + 10,
                   "read-begin": p["read-before"]["end"] + 10,
                   "read-after-snapshot": p["read-after"]["start"] - 10,
                   "read-end": p["read-after"]["end"] + 10, "cleanup-fd": p["read-after"]["end"] + 20,
                   "module-unload": proof["cleanup_end"] + 10, "guest-complete": proof["cleanup_end"] + 20}
        dm.validate_phase_positions(proof, anchors)
        for name in anchors:
            changed = dict(anchors); changed[name] = proof["cleanup_end"] + 30 if name == "geometry" else 0
            with self.subTest(name=name), self.assertRaises(ValueError): dm.validate_phase_positions(proof, changed)
        changed = copy.deepcopy(proof); changed["phases"]["control-before"]["end"] = anchors["control-begin"]
        with self.assertRaises(ValueError): dm.validate_phase_positions(changed, anchors)


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/qualification/whole-brd" / filename)
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module; spec.loader.exec_module(module)
    return module


class ProfileDispatchControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load_script("dm_builder_controls", "f3-build.py")
        cls.runner = load_script("dm_runner_controls", "f3-run.py")

    def request(self):
        return {"run_id": RUN, "input_kind": self.builder.NEW_INPUT_KIND,
                "input_root": "/fixed-test-input", "profile": dm.PROFILE}

    def test_only_explicit_new_input_profile_selects_dm(self):
        self.assertIs(self.builder.profile_module({"run_id": RUN}), f3)
        self.assertEqual(self.builder.profile_module(self.request()).PROFILE, dm.PROFILE)
        self.assertEqual(self.builder.observed_state(self.request()), "F3_DM_SOURCE_PRESERVATION_OBSERVED")
        self.assertEqual(self.builder.observed_state({"run_id": RUN}), "F3_SOURCE_PRESERVATION_OBSERVED")
        for request in ({"run_id": RUN, "profile": dm.PROFILE}, self.request() | {"profile": None},
                        self.request() | {"profile": "other"}, self.request() | {"input_kind": "legacy"}):
            with self.subTest(request=request), self.assertRaises(ValueError): self.builder.profile_module(request)

    def test_frozen_source_and_compile_contract_bind_only_the_selected_helper(self):
        old, new = self.builder.source_bindings(), self.builder.source_bindings(dm.PROFILE)
        additions = {"f3-dm.py", "f3-dm-guest.c", "f3-dm-uapi.h", "F3-DM.md", "../../../tests/whole-brd-f3-dm.test.py"}
        self.assertEqual(set(new) - set(old), additions)
        self.assertEqual({name: new[name] for name in old}, old)
        legacy = self.builder.compile_commands("/usr/bin/cc", Path("/fixed/header.h"), Path("/fixed/out"), {"run_id": RUN})
        selected = self.builder.compile_commands("/usr/bin/cc", Path("/fixed/header.h"), Path("/fixed/out"), self.request())
        self.assertEqual(len(selected), 3)
        self.assertEqual(legacy[:2], selected[:2])
        expected = [str(ROOT / "scripts/qualification/whole-brd/f3-dm-guest.c") if value.endswith("/f3-guest.c") else value
                    for value in legacy[2]]
        self.assertEqual(selected[2], expected)
        self.assertEqual(dm.mkfs_argv(RUN), dm.f2.mkfs_argv(RUN)[:-2] + ["/dev/boardroom-f3-dm", "16384"])
        with self.assertRaises(ValueError): self.builder.source_bindings("unrecognised")

    def test_unpinned_private_profile_refuses_before_output_or_native_work(self):
        self.assertIsNone(self.builder.PRIVATE_CATALOG_SHA256)
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(self.builder.subprocess, "run", side_effect=AssertionError("no compile/spawn")):
            output = Path(folder) / "not-created"
            with self.assertRaisesRegex(ValueError, "private_source_not_pinned"):
                self.builder.prepare(self.request(), output)
            self.assertFalse(output.exists())
            with self.assertRaisesRegex(ValueError, "private_source_not_pinned"):
                self.runner.runtime_preflight(Path(folder) / "BUNDLE.json", {"kind": self.builder.NEW_INPUT_KIND,
                                               "request": self.request()}, output)
            self.assertFalse(output.exists())


def synthetic_complete_serial():
    """明确合成的整体顺序，沿用旧检查过的 ext4/JBD2 字节；不是 guest 原件。"""
    prior = load_script("dm_whole_f3_synthetic", "../../../tests/whole-brd-f3.test.py")
    original = prior.synthetic_serial()
    dm_rows = dm_lifecycle()
    groups = {}
    for item in dm_rows:
        row = {key: item[key] for key in dm.FRAME_FIELDS}
        if row["event"] == "dm-topology":
            value = json.loads(bytes.fromhex(row["data_hex"]))
            next(read for read in value["reads"] if read["name"] == "sys-block")["hex"] = b"loop0\0loop1\0ram0\0dm-7\0".hex()
            raw = f3.encoded(value); row.update(bytes=len(raw), data_hex=raw.hex())
        groups.setdefault(row["phase"], []).append(("BRDF3", row))
    output = []
    child_index = 0
    for tag, row in original:
        row = copy.deepcopy(row)
        event = row.get("event")
        raw = bytes.fromhex(row["data_hex"]) if "data_hex" in row else b""
        if tag == "BRDF1" and row.get("item") == "mountinfo": raw = MOUNTS
        if tag == "BRDF2" and event == "format-stdout": raw = b"BRDDM-MKFS " + f3.encoded(format_fds()) + raw
        if tag == "BRDF2" and row.get("origin") == "ordinary":
            row["path"] = row["path"].replace("/sys/block/ram0/", "/sys/devices/virtual/block/dm-7/").replace("ram0", "dm-7")
            item = row["item"]
            if item == "device_dev": raw = b"253:7\n"
            elif item == "device_slaves": raw = b"ram0\0"
            elif item == "sys_block": raw = b"loop0\0loop1\0ram0\0dm-7\0"
            elif item in ("source_stat_before", "source_stat_after"):
                raw = f3.encoded(json.loads(raw) | {"dev": DEV})
            elif item in ("source_statx_unique", "source_statx_legacy"):
                value = bytearray(raw); struct.pack_into("<II", value, 136, 253, 7); raw = bytes(value)
            elif item == "source_mount":
                value = bytearray(raw); struct.pack_into("<II", value, 16, 253, 7); raw = bytes(value)
            elif item == "mountinfo": raw = raw.replace(b"1:0", b"253:7").replace(b"/dev/ram0", b"/dev/boardroom-f3-dm")
        if tag == "BRDF3":
            if event in ("snapshot-begin", "snapshot-end"):
                raw = f3.encoded(json.loads(raw) | {"rdev": DEV, "device_inode": 101})
            elif event in ("view-begin", "view-end", "view-object", "view-absence"):
                raw = f3.encoded(json.loads(raw) | {"dev": DEV})
            elif event == "guest-complete":
                raw = f3.encoded(json.loads(raw) | {"dm_created": False, "dm_node_exists": False,
                                                   "dm_control_exists": False, "dm_close_unknown": False})
            if event == "round-begin": output += groups[row["phase"] + "-before"]
            if event == "round-end": output += groups[row["phase"] + "-after"]
        if "data_hex" in row: row.update(bytes=len(raw), data_hex=raw.hex())
        if tag == "BRDF2" and event == "device-remove": continue
        output.append((tag, row))
        if event == "device-geometry":
            output += groups["setup"][:-1]
            output.append(("BRDF2", {"run_id": RUN, "origin": "management", "seq": 0, "event": "device-remove",
                                     "rc": 0, "errno": 0, "close_errno": 0, "bytes": 0, "data_hex": ""}))
            output += groups["setup"][-1:] + groups["created"] + groups["calibration"] + groups["calibrated"]
        elif event == "cleanup-fd": output += groups["before-remove"] + groups["cleanup"]
        elif tag == "BRDF2" and event == "metadata-start":
            output.append(("BRDDM", {"run_id": RUN, "origin": "ordinary", "pid": 4 + child_index, "uid": 1000, "gid": 1000,
                                     "enumerator": 3, "fds": fd_rows({3}), "errno": 0, "close_errno": 0}))
            child_index += 1
    sequences = {"BRDF2": 0, "BRDF3": 0}
    for tag, row in output:
        if tag in sequences and row.get("origin") == "management":
            sequences[tag] += 1; row["seq"] = sequences[tag]
    return output, prior


class CompleteConsumerControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.rows, cls.prior = synthetic_complete_serial()

    def consume(self, rows):
        # 只隔离未在本纯控制执行的 SP native 数据收集；元数据、全块、校准、DM
        # 拓扑/census、阶段顺序和 cleanup 均交给真实消费者，不替换其判据。
        with mock.patch.object(dm, "native_window", return_value={"status": "SYNTHETIC_NATIVE_SEAM_ONLY"}) as native:
            result = dm.decode_serial(self.prior.serial_bytes(rows), RUN, b"exact-notes")
        self.assertEqual(native.call_count, 2)
        return result

    def test_complete_synthetic_flow_keeps_four_images_and_dynamic_metadata(self):
        result = self.consume(copy.deepcopy(self.rows))
        self.assertEqual(result["state"], "F3_DM_SOURCE_PRESERVATION_OBSERVED")
        self.assertEqual(result["qualification"], "UNSUPPORTED")
        self.assertEqual(result["accepted_provider_profiles"], [])
        self.assertEqual(result["dm"]["device"]["encoded"], DEV)
        self.assertEqual(result["metadata"]["mount"]["dev_major"], 253)
        self.assertEqual(len([name for name in result["raw_artifacts"] if name in {phase+"-blocks.json" for phase in dm.SNAPSHOT_PHASES}]), 4)
        self.assertEqual(len([name for name in result["raw_artifacts"] if name.startswith("dm-child-")]), 3)
        self.assertTrue(any(name.endswith("dm-remove.raw") for name in result["raw_artifacts"]))

    def test_cross_stage_movement_and_unknown_cleanup_cannot_complete(self):
        for case in ("calibration-after-format", "raw-device-metadata", "cleanup-unknown", "child-close"):
            rows = copy.deepcopy(self.rows)
            if case == "calibration-after-format":
                calibration_rows = [pair for pair in rows if pair[0] == "BRDF3" and pair[1].get("phase") == "calibration"]
                rows = [pair for pair in rows if pair not in calibration_rows]
                index = next(i for i, (_, row) in enumerate(rows) if row.get("event") == "format-exit")
                rows[index + 1:index + 1] = calibration_rows
                n = 0
                for tag, row in rows:
                    if tag == "BRDF3": n += 1; row["seq"] = n
            elif case == "raw-device-metadata":
                row = next(row for tag, row in rows if tag == "BRDF2" and row.get("item") == "device_dev")
                row.update(bytes=4, data_hex=b"1:0\n".hex())
            elif case == "cleanup-unknown":
                row = next(row for _, row in rows if row.get("event") == "guest-complete")
                raw = f3.encoded(json.loads(bytes.fromhex(row["data_hex"])) | {"dm_close_unknown": True})
                row.update(bytes=len(raw), data_hex=raw.hex())
            else: next(row for tag, row in rows if tag == "BRDDM")["close_errno"] = 5
            with self.subTest(case=case), self.assertRaises(ValueError): self.consume(rows)

    def test_aggregate_management_budget_cannot_use_the_serial_reserve(self):
        raw = bytes(24000)
        rows = [("BRDF3", {"run_id": RUN, "origin": "management", "seq": i + 1, "phase": "setup", "event": "dm-observation",
                           "rc": 0, "errno": 0, "close_errno": 0, "bytes": len(raw), "data_hex": raw.hex()}) for i in range(160)]
        serial = self.prior.serial_bytes(rows)
        self.assertLess(len(serial), dm.LIMITS["serial_bytes"])
        with self.assertRaisesRegex(ValueError, "management aggregate byte budget"): dm.decode_serial(serial, RUN, b"exact-notes")

    def test_c_source_and_fixed_uapi_are_checked_without_building_a_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            header = Path(folder) / "syntax-only.h"
            header.write_text("#define F2_FIXED_INPUTS 1\n#define F3_FIXED_INPUTS 1\n"
                              "static const unsigned char F2_EXPECTED_NOTES[]={0};\n"
                              "static const unsigned char F2_EXPECTED_CONFIG[]={0};\n"
                              "static const unsigned char F3_EXPECTED_PAYLOAD[]={0};\n")
            result = subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-include", str(header),
                                     str(ROOT / "scripts/qualification/whole-brd/f3-dm-guest.c")], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self.assertEqual({path.name for path in Path(folder).iterdir()}, {"syntax-only.h"})

if __name__ == "__main__":
    unittest.main()

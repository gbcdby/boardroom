"""Bounded F3-only DM-linear evidence. Importing performs no device operations.

This profile consumes actual dynamic identities. It does not normalize them to
ram0, modify the legacy consumers, or establish a production provider profile.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
import struct
from types import MappingProxyType

import f0
import f0b
import f2
import f3

SCOPE = "https://github.com/gbcdby/boardroom/issues/152#issuecomment-6899760900"
PROFILE = "whole-dm-linear-brd-f3-v1"
NODE = "/dev/boardroom-f3-dm"
CONTROL = "/dev/boardroom-f3-control"
ABI = (4, 50, 0)
IOCTL_BYTES = 16384
HEADER_BYTES = 312
HEADER_COPY = 305
COMMANDS = {"version":0, "list":2, "create":3, "remove":4, "resume":6,
            "status":7, "load":9, "deps":11, "table":12}
need = f3.need
encoded = f3.encoded


def identity(run_id):
    f0._uuid(run_id)
    return {"name":"br-f3-"+run_id.replace("-", ""), "uuid":"boardroom-f3-dm:"+run_id}


def plan(raw):
    result = f3.plan(raw)
    result.update(kind="fixed-private-dm-linear-f3", profile=PROFILE, scope=SCOPE,
                  logical_source="one-full-dm-linear-over-ram0", raw_source_access="closed-before-formal-windows",
                  source_device_path=NODE, dm=identity(result["run_id"]), calibration="direct-4k-r-w-r-w-r-before-mkfs")
    return result


def mkfs_argv(run_id):
    result = f2.mkfs_argv(run_id)
    need(result[-2] == "/dev/ram0", "legacy mkfs seam changed")
    return result[:-2] + [NODE, result[-1]]


def device(value):
    # huge_encode_dev in the fixed kernel is new_encode_dev, not old 8:8 dev_t.
    need(type(value) is int and 0 <= value < 1 << 32, "DM encoded dev range")
    major, minor = (value >> 8) & 0xfff, (value & 0xff) | ((value >> 12) & 0xfff00)
    need(value == (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12), "DM noncanonical dev")
    return [major, minor]


def ioctl_number(command):
    need(command in COMMANDS, "unsupported DM command")
    return 0xc138fd00 | COMMANDS[command]


def ioctl_request(command, run_id):
    ioctl_number(command)
    ids = identity(run_id)
    raw = bytearray(IOCTL_BYTES)
    struct.pack_into("<6Ii3IQ", raw, 0, *ABI, IOCTL_BYTES, HEADER_BYTES,
                     1 if command == "load" else 0, 0, 16 if command == "table" else 0, 0, 0, 0)
    if command not in ("version", "list"):
        uuid = ids["uuid"].encode("ascii"); raw[176:176+len(uuid)] = uuid
    if command == "create":
        name = ids["name"].encode("ascii"); raw[48:48+len(name)] = name
    if command == "load":
        struct.pack_into("<QQiI16s", raw, HEADER_BYTES, 0, 131072, 0, 48, b"linear")
        raw[352:358] = b"1:0 0\0"
    return bytes(raw)


def _string(raw, length):
    need(len(raw) == length and b"\0" in raw, "unterminated DM name")
    text, tail = raw.split(b"\0", 1)
    need(not any(tail), "noncanonical DM name padding")
    try: return text.decode("ascii")
    except UnicodeError as error: raise ValueError("non-ASCII DM identity") from error


def ioctl_reply(command, raw, run_id, expected=None):
    ioctl_number(command)
    need(type(raw) is bytes and len(raw) <= IOCTL_BYTES, "bounded original DM response")
    if command == "version":
        need(raw == struct.pack("<3I", *ABI), "fixed actual DM ABI")
        return {"version":list(ABI)}
    need(len(raw) >= HEADER_COPY, "truncated DM header")
    version = struct.unpack_from("<3I", raw)
    size, start, targets, opened, flags, event, padding, dev = struct.unpack_from("<3Ii3IQ", raw, 12)
    need(version == ABI and size == len(raw) and start == HEADER_BYTES and padding == 0,
         "DM header size/offset/version/padding")
    name, uuid = _string(raw[48:176], 128), _string(raw[176:305], 129)
    need(opened >= 0, "unknown DM open-count observation")
    result = {"version":list(version),"name":name,"uuid":uuid,"rdev":dev,"device":device(dev),
              "target_count":targets,"open_count":opened,"flags":flags,"event_nr":event,
              "sha256":hashlib.sha256(raw).hexdigest()}
    if command == "list":
        # Empty-list kernel output has data_size == data_start; its sentinel is
        # outside the copied range. Do not manufacture an observed sentinel.
        need(size == HEADER_BYTES and raw[HEADER_COPY:] == bytes(7) and not name and not uuid
             and not dev and not flags and not targets and not opened, "initial DM list is not empty")
        return result
    need({"name":name,"uuid":uuid} == identity(run_id), "DM name/UUID differs from fresh run")
    if command == "remove":
        # dev_remove resolves UUID but does not call __dev_status; dev remains the
        # zero request selector. Actual absence and topology are separate receipts.
        need(dev == 0 and targets == 0 and size == HEADER_COPY and flags in (0,8192), "DM remove result")
        return result
    need(result["device"][0] > 0 and result["device"] != [1,0], "DM is not a distinct actual device")
    if expected is not None:
        need(type(expected) is dict and all(result[key] == expected[key] for key in ("name","uuid","rdev","device")),
             "DM response changed identity")
    if command == "create":
        need(flags in (0,2) and targets == 0 and size == HEADER_COPY, "unexpected created DM state")
    elif command == "load":
        need(flags in (64,66) and targets == 0 and size == HEADER_COPY, "unexpected inactive table state")
    else:
        wanted = 48 if command == "table" else 32
        need(flags in ((wanted,wanted|8192) if command == "resume" else (wanted,)) and targets == 1,
             "unknown/extra/inactive/read-only DM state")
        if command in ("resume","status"):
            need(size == HEADER_COPY, "extra DM status payload")
        elif command == "deps":
            need(size == HEADER_BYTES+16 and raw[HEADER_COPY:HEADER_BYTES] == bytes(7), "DM dependency length")
            count, reserved, dependency = struct.unpack_from("<IIQ", raw, HEADER_BYTES)
            need((count,reserved,dependency) == (1,0,256), "DM dependency is not only ram0")
            result["dependencies"] = [[1,0]]
        elif command == "table":
            need(size == HEADER_BYTES+46 and raw[HEADER_COPY:HEADER_BYTES] == bytes(7), "DM table exact payload")
            sector, length, status, next_offset, kind = struct.unpack_from("<QQiI16s", raw, HEADER_BYTES)
            need((sector,length,status,next_offset,kind) == (0,131072,0,48,b"linear"+bytes(10))
                 and raw[HEADER_BYTES+40:] == b"1:0 0\0", "unexpected linear table/next/params")
            result["linear"] = {"start":0,"sectors":131072,"device":[1,0],"offset":0}
    return result


STAT_FIELDS = ("dev","ino","rdev","mode","uid","gid","nlink")


def _stat(value, *, block=False):
    f0._fields(value, STAT_FIELDS)
    need(all(type(value[key]) is int and 0 <= value[key] < 1 << 63 for key in STAT_FIELDS), "actual stat integers")
    need(value["ino"] > 0 and value["uid"] == value["gid"] == 0 and value["nlink"] >= 1,
         "owned device/sysfs identity")
    need(value["mode"] == (stat.S_IFBLK|0o600 if block else stat.S_IFDIR|0o755), "actual device/sysfs type/mode")
    if block: need(value["nlink"] == 1, "device node alias")
    return dict(value)


def anchor(run_id, status, raw):
    f0._fields(raw,("sys_name","sysfs_path","sysfs_stat","node_stat","node_path","bytes","logical","physical"))
    need(type(raw["sys_name"]) is str and re.fullmatch(r"dm-(0|[1-9][0-9]{0,5})",raw["sys_name"]), "actual dm sysfs name")
    need(raw["sysfs_path"] == "/sys/devices/virtual/block/"+raw["sys_name"] and raw["node_path"] == NODE,
         "actual device route")
    need(all(type(raw[key]) is int for key in ("bytes","logical","physical")) and raw["bytes"] == f3.DEVICE_BYTES
         and raw["logical"] in (512,1024) and raw["physical"] in (512,1024,2048,4096), "actual DM geometry")
    node = _stat(raw["node_stat"],block=True); sysfs = _stat(raw["sysfs_stat"])
    need(node["rdev"] == status["rdev"] and sysfs["rdev"] == 0
         and {key:status[key] for key in ("name","uuid")} == identity(run_id), "ioctl/node/sysfs origin")
    return dict(raw) | {"name":status["name"],"uuid":status["uuid"],"rdev":status["rdev"],
                       "device":status["device"],"node_stat":node,"sysfs_stat":sysfs}


def names(raw):
    need(type(raw) is bytes and len(raw) <= 16384, "bounded complete directory bytes")
    if not raw: return set()
    items = raw.split(b"\0")
    need(items[-1] == b"" and 1 < len(items) <= 257 and len(set(items)) == len(items)
         and all(re.fullmatch(rb"[A-Za-z0-9_.-]{1,128}",name) for name in items[:-1]), "directory membership")
    return set(items[:-1])


def topology(held, observed, p1_names):
    expected = {"dm_dev":("%d:%d\n"%tuple(held["device"])).encode(),"dm_size":b"131072\n","dm_ro":b"0\n",
                "dm_iostats":b"1\n","dm_logical":str(held["logical"]).encode()+b"\n",
                "dm_physical":str(held["physical"]).encode()+b"\n","dm_partition":b"absent\n",
                "dm_name":held["name"].encode()+b"\n","dm_uuid":held["uuid"].encode()+b"\n",
                "ram_dev":b"1:0\n","ram_size":b"131072\n","ram_ro":b"0\n","ram_partition":b"absent\n"}
    f0._fields(observed,tuple(expected)+("sys_block","dm_holders","dm_slaves","ram_holders","ram_slaves","dev_nodes"))
    need(all(observed[key] == value for key,value in expected.items()), "DM/ram0 same-device attributes")
    need(names(observed["sys_block"]) == names(p1_names)|{b"ram0",held["sys_name"].encode()}, "additional/missing block object")
    need(names(observed["dm_slaves"]) == {b"ram0"} and names(observed["dm_holders"]) == set()
         and names(observed["ram_holders"]) == {held["sys_name"].encode()} and names(observed["ram_slaves"]) == set(),
         "two-way DM/ram0 topology")
    need(names(observed["dev_nodes"]) == {b"console",b"null",b"boardroom-f3-control",b"boardroom-f3-dm"},
         "raw block alias/unknown node")
    return {"device":held["device"],"uuid":held["uuid"],"iostats":1,"raw_ram0_node":"ABSENT",
            "raw_observation_sha256":{key:hashlib.sha256(value).hexdigest() for key,value in observed.items()}}


def _hex(value, maximum):
    need(type(value) is str and len(value) <= maximum*2 and len(value)%2 == 0
         and re.fullmatch("[0-9a-f]*",value), "bounded original bytes")
    return bytes.fromhex(value)


def counters(raw):
    need(type(raw) is bytes and len(raw) <= 4096
         and re.fullmatch(rb"[ \t]*[0-9]+(?:[ \t]+[0-9]+){16}[ \t]*\n",raw), "fixed 17 actual block counters")
    result = [int(value) for value in raw.split()]
    need(all(value < 1 << 63 for value in result) and result[8] == 0, "counter range/in-flight I/O")
    return result


CALIBRATION_PATTERN = bytes((index*73+19)%256 for index in range(4096))


def calibration(held, value):
    f0._fields(value,("fd","rdev","flags","node_stat","rows","close_errno","closed"))
    need(type(value["fd"]) is int and value["fd"] >= 3 and value["rdev"] == held["rdev"]
         and value["node_stat"] == held["node_stat"] and value["flags"] == 0x84002,
         "same owned O_RDWR/O_DIRECT calibration FD")
    need(value["closed"] is True and type(value["close_errno"]) is int and value["close_errno"] == 0,
         "calibration FD close not confirmed")
    rows = value["rows"]
    need(type(rows) is list and len(rows) == 5, "exact five calibration operations")
    a = None; previous = None; last_time = 0; originals=[]
    for index,(row,operation) in enumerate(zip(rows,("read","write","read","write","read"))):
        f0._fields(row,("index","operation","rc","errno","data_hex","before_hex","after_hex","start_ns","end_ns"))
        need(type(row["index"]) is int and row["index"] == index and row["operation"] == operation
             and type(row["rc"]) is int and row["rc"] == 4096 and type(row["errno"]) is int and row["errno"] == 0,
             "calibration error/short result/order")
        data = _hex(row["data_hex"],4096); need(len(data) == 4096, "calibration complete actual block")
        if index == 0: a = data
        need(data == (CALIBRATION_PATTERN if index in (1,2) else a), "calibration write/readback/restore bytes")
        before_raw,after_raw = (_hex(row[key],4096) for key in ("before_hex","after_hex"))
        before,after = counters(before_raw),counters(after_raw)
        need(previous is None or before == previous, "unobserved I/O between calibration operations")
        expected = [0]*17; expected[0 if operation == "read" else 4] = 1; expected[2 if operation == "read" else 6] = 8
        for field in range(17):
            need(after[field] >= before[field] if field in (3,7,9,10,14,16) else after[field]-before[field] == expected[field],
                 "calibration accounting is unavailable/extra/reset")
        times=[]
        for key in ("start_ns","end_ns"):
            need(type(row[key]) is str and re.fullmatch(r"[1-9][0-9]{0,18}",row[key]) and int(row[key]) < 1 << 63,
                 "calibration actual clock")
            times.append(int(row[key]))
        need(last_time < times[0] < times[1], "calibration clock order")
        last_time=times[1];previous=after
        originals.append({"before":hashlib.sha256(before_raw).hexdigest(),"after":hashlib.sha256(after_raw).hexdigest()})
    return {"status":"CALIBRATED_LOGICAL_DEVICE","device":held["device"],"raw_counter_sha256":originals,
            "completed":{"reads":3,"read_sectors":24,"writes":2,"write_sectors":16},
            "original_block_sha256":hashlib.sha256(a).hexdigest(),"production_supported":False}

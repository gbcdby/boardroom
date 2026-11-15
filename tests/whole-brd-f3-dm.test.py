"""DM profile controls. Never compile, boot, create a device, or issue an ioctl."""
from pathlib import Path
import importlib.util
import copy
import json
import stat
import struct
import sys
import unittest

HERE = Path(__file__).resolve().parents[1] / "scripts/qualification/whole-brd"
sys.path.insert(0, str(HERE))
SPEC = importlib.util.spec_from_file_location("f3_dm", HERE / "f3-dm.py")
dm = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dm
SPEC.loader.exec_module(dm)
RUN = "12345678-1234-4234-9234-123456789abc"


def reply(command, *, dev=0xfd07, flags=32, targets=1, payload=b"", size=None):
    # Fixed Linux UAPI offsets, independent of the production decoder.
    raw = bytearray(312 + len(payload))
    struct.pack_into("<6Ii3IQ", raw, 0, 4, 50, 0, size or len(raw), 312,
                     targets, 0, flags, 1, 0, dev)
    name = ("br-f3-" + RUN.replace("-", "")).encode()
    uuid = ("boardroom-f3-dm:" + RUN).encode()
    raw[48:48+len(name)] = name
    raw[176:176+len(uuid)] = uuid
    raw[312:] = payload
    if not payload:
        struct.pack_into("<I", raw, 12, 305)
        del raw[305:]
    return bytes(raw)


class UapiControls(unittest.TestCase):
    def test_uuid_only_requests_and_fixed_linear_table(self):
        create = dm.ioctl_request("create", RUN)
        self.assertEqual(len(create), 16384)
        self.assertEqual(struct.unpack_from("<3I", create), (4, 50, 0))
        self.assertEqual(struct.unpack_from("<Q", create, 40), (0,))
        self.assertEqual(create[48:86], ("br-f3-"+RUN.replace("-", "")).encode())
        load = dm.ioctl_request("load", RUN)
        self.assertEqual(load[48:176], bytes(128))
        self.assertEqual(struct.unpack_from("<QQiI", load, 312), (0, 131072, 0, 48))
        self.assertEqual(load[336:352], b"linear"+bytes(10))
        self.assertEqual(load[352:358], b"1:0 0\0")
        for command in ("remove-all", "rename", "clear", "suspend", "reload"):
            with self.subTest(command=command), self.assertRaises(ValueError):
                dm.ioctl_request(command, RUN)

    def test_response_uses_actual_dynamic_device_not_ram0(self):
        result = dm.ioctl_reply("status", reply("status"), RUN)
        self.assertEqual(result["device"], [253, 7])
        self.assertEqual(result["rdev"], 0xfd07)
        for field, value in ((28, 32|64), (28, 32|256), (20, 2), (40, 256)):
            raw = bytearray(reply("status")); struct.pack_into("<Q" if field==40 else "<I", raw, field, value)
            with self.subTest(field=field,value=value), self.assertRaises(ValueError):
                dm.ioctl_reply("status", bytes(raw), RUN)

    def test_table_and_dependencies_are_complete_bounded_raw_replies(self):
        target = struct.pack("<QQiI16s", 0, 131072, 0, 48, b"linear") + b"1:0 0\0"
        parsed = dm.ioctl_reply("table", reply("table", flags=48, payload=target), RUN)
        self.assertEqual(parsed["linear"], {"start":0,"sectors":131072,"device":[1,0],"offset":0})
        deps = struct.pack("<IIQ", 1, 0, 256)
        self.assertEqual(dm.ioctl_reply("deps", reply("deps",payload=deps), RUN)["dependencies"], [[1,0]])
        for payload in (target[:-1], target+b"x", target.replace(b"1:0 0",b"1:0 1"),
                        target[:20]+struct.pack("<I",0)+target[24:]):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                dm.ioctl_reply("table",reply("table",flags=48,payload=payload),RUN)
        for payload in (struct.pack("<IIQ",2,0,256), deps+b"\0"*8):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                dm.ioctl_reply("deps",reply("deps",payload=payload),RUN)


def anchor_sample():
    return {"sys_name":"dm-7","sysfs_path":"/sys/devices/virtual/block/dm-7",
            "sysfs_stat":{"dev":20,"ino":90,"rdev":0,"mode":stat.S_IFDIR|0o755,"uid":0,"gid":0,"nlink":2},
            "node_stat":{"dev":21,"ino":91,"rdev":0xfd07,"mode":stat.S_IFBLK|0o600,"uid":0,"gid":0,"nlink":1},
            "node_path":"/dev/boardroom-f3-dm","bytes":67108864,"logical":512,"physical":512}


def topology_sample():
    return {"sys_block":b"loop0\0ram0\0dm-7\0", "dm_dev":b"253:7\n", "dm_size":b"131072\n",
            "dm_ro":b"0\n", "dm_iostats":b"1\n", "dm_logical":b"512\n", "dm_physical":b"512\n",
            "dm_holders":b"", "dm_slaves":b"ram0\0", "dm_partition":b"absent\n",
            "dm_name":("br-f3-"+RUN.replace("-","")+"\n").encode(),
            "dm_uuid":("boardroom-f3-dm:"+RUN+"\n").encode(),
            "ram_dev":b"1:0\n", "ram_size":b"131072\n", "ram_ro":b"0\n",
            "ram_holders":b"dm-7\0", "ram_slaves":b"", "ram_partition":b"absent\n",
            "dev_nodes":b"console\0null\0boardroom-f3-control\0boardroom-f3-dm\0"}


def calibration_sample():
    a = bytes([0x37])*4096; b = bytes((i*73+19)%256 for i in range(4096))
    counters = [0]*17; rows=[]
    for i,(op,data) in enumerate(zip(('read','write','read','write','read'),(a,b,b,a,a))):
        before = (' '.join(map(str,counters))+'\n').encode().hex()
        counters[0 if op=='read' else 4] += 1
        counters[2 if op=='read' else 6] += 8
        after = (' '.join(map(str,counters))+'\n').encode().hex()
        rows.append({"index":i,"operation":op,"rc":4096,"errno":0,"data_hex":data.hex(),
                     "before_hex":before,"after_hex":after,"start_ns":str(100+i*10),"end_ns":str(105+i*10)})
    return {"fd":6,"rdev":0xfd07,"flags":0x84002,"node_stat":anchor_sample()['node_stat'],
            "rows":rows,"close_errno":0,"closed":True}


class TopologyAndAccountingControls(unittest.TestCase):
    def setUp(self):
        self.status=dm.ioctl_reply('status',reply('status'),RUN)
        self.anchor=dm.anchor(RUN,self.status,anchor_sample())

    def test_two_way_topology_and_nodes_exclude_raw_aliases(self):
        result=dm.topology(self.anchor,topology_sample(),b'loop0\0')
        self.assertEqual(result['device'],[253,7])
        for key,value in (("ram_holders",b'dm-7\0dm-8\0'),('dm_slaves',b'ram0\0loop0\0'),
                          ('dm_iostats',b'0\n'),('dm_uuid',b'other\n'),
                          ('dev_nodes',topology_sample()['dev_nodes']+b'ram0\0')):
            bad=topology_sample();bad[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError): dm.topology(self.anchor,bad,b'loop0\0')

    def test_real_returns_and_same_counter_source_for_all_five_steps(self):
        result=dm.calibration(self.anchor,calibration_sample())
        self.assertEqual(result['completed'],{'reads':3,'read_sectors':24,'writes':2,'write_sectors':16})
        self.assertFalse(result['production_supported'])
        cases=[]
        bad=calibration_sample();bad['rows'][1]['after_hex']=bad['rows'][1]['before_hex'];cases.append(bad)
        bad=calibration_sample();bad['rows'][2]['rc']=4095;cases.append(bad)
        bad=calibration_sample();bad['rows'][4]['data_hex']='00'*4096;cases.append(bad)
        bad=calibration_sample();bad['rdev']=256;cases.append(bad)
        bad=calibration_sample();bad['close_errno']=5;cases.append(bad)
        bad=calibration_sample();bad['closed']=False;cases.append(bad)
        for bad in cases:
            with self.subTest(bad=cases.index(bad)),self.assertRaises(ValueError):dm.calibration(self.anchor,bad)


if __name__ == "__main__":
    unittest.main()

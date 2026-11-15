"""F3 offline controls. Synthetic envelopes are never native qualification evidence."""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "scripts/qualification/whole-brd"))
import f0b
import f2
import f3

RUN = "358af363-b224-4d47-a5b6-5a4573192db3"
BLOCK = 4096
BLOCKS = 16384
ZERO = bytes(BLOCK)


def frame(event, phase, raw, seq):
    return {"run_id": RUN, "origin": "management", "seq": seq, "event": event,
            "phase": phase, "rc": 0, "errno": 0, "close_errno": 0,
            "bytes": len(raw), "data_hex": raw.hex()}


def raw_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def binding(at, closed):
    return {"fd": 5, "device_dev": 1, "device_inode": 100, "rdev": 256,
            "mode": 0o60600, "uid": 0, "gid": 0, "nlink": 1,
            "bytes": 67108864, "block_bytes": BLOCK, "at_ns": str(at), "closed": closed}


def synthetic_snapshot(nonzero=None, phase="control-before", first_seq=1):
    """Explicit measured-block records for consumer controls, never a real FD receipt."""
    nonzero = {} if nonzero is None else nonzero
    output = [frame("snapshot-begin", phase, raw_json(binding(10, False)), first_seq)]
    next_block = 0
    for index, raw in sorted(nonzero.items()):
        if index > next_block:
            output.append(frame("snapshot-zero", phase, struct.pack("<II", next_block, index-next_block), first_seq+len(output)))
        output.append(frame("snapshot-data", phase, struct.pack("<I", index)+raw, first_seq+len(output)))
        next_block = index+1
    if next_block < BLOCKS:
        output.append(frame("snapshot-zero", phase, struct.pack("<II", next_block, BLOCKS-next_block), first_seq+len(output)))
    output.append(frame("snapshot-end", phase, raw_json(binding(20, True)), first_seq+len(output)))
    return output


class ContractTests(unittest.TestCase):
    def test_fixed_scope_and_budgets_cannot_be_overridden(self):
        value = f3.plan(raw_json({"run_id": RUN}))
        self.assertEqual(value["qualification"], "UNSUPPORTED")
        self.assertEqual(value["content_probes"], 1)
        self.assertEqual(value["fixture_targets"], 1)
        self.assertEqual(value["target_bytes"], 67108864)
        self.assertEqual(value["max_snapshots"], 4)
        self.assertEqual(value["decoded_bytes"], 268435456)
        self.assertEqual(value["limits"], f0b.LIMITS)
        self.assertEqual(value["frame_bytes"], 65536)
        self.assertFalse(value["production_bound"])
        self.assertFalse(value["commit_barrier"])
        self.assertEqual(value["filesystem_uuid"], f2.plan(raw_json({"run_id": RUN}))["filesystem_uuid"])
        self.assertTrue(0 < len(f3.PAYLOAD) <= 4096)
        for extra in ({"target_count": 2}, {"serial_bytes": 16777216}, {"payload": "foreign"}, {"profile": "accepted"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                f3.plan(raw_json({"run_id": RUN, **extra}))

    def test_read_snapshot_preserves_nonzero_bytes_at_both_ends(self):
        originals = {0: b"first"+bytes(BLOCK-5), 3: bytes(range(256))*16,
                     BLOCKS-1: bytes(BLOCK-4)+b"last"}
        image = f3.decode_snapshot(synthetic_snapshot(originals), RUN, "control-before")
        self.assertEqual(len(image.hashes), BLOCKS)
        for index, raw in originals.items():
            self.assertEqual(image.block(index), raw)
            self.assertEqual(image.hashes[index], hashlib.sha256(raw).hexdigest())
        self.assertEqual(image.block(2), ZERO)
        self.assertEqual(image.block(BLOCKS-2), ZERO)
        self.assertEqual(image.total_bytes, 67108864)
        self.assertFalse(image.atomic_live_snapshot)
        with self.assertRaises(ValueError): image.block(BLOCKS)

    def test_missing_gap_overlap_duplicate_or_extra_blocks_never_become_zeros(self):
        base = synthetic_snapshot({5: b"x"*BLOCK})
        variants = []
        for start, count in ((1, 5), (0, 4), (0, 6), (0, BLOCKS+1), (0, 0), (0xffffffff, 2)):
            altered = copy.deepcopy(base)
            altered[1]["data_hex"] = struct.pack("<II", start, count).hex()
            variants.append(altered)
        variants += [base[:1]+base[2:], base[:2]+[base[1]]+base[2:], base[:-1]]
        for rows in variants:
            with self.subTest(rows=len(rows)), self.assertRaises(ValueError):
                f3.decode_snapshot(rows, RUN, "control-before")

    def test_zero_literals_and_adjacent_zero_runs_are_noncanonical(self):
        with self.assertRaises(ValueError):
            f3.decode_snapshot(synthetic_snapshot({1: ZERO}), RUN, "control-before")
        rows = synthetic_snapshot()
        rows[1:2] = [frame("snapshot-zero", "control-before", struct.pack("<II", 0, 2), 2),
                     frame("snapshot-zero", "control-before", struct.pack("<II", 2, BLOCKS-2), 3)]
        rows[-1]["seq"] = 4
        with self.assertRaises(ValueError): f3.decode_snapshot(rows, RUN, "control-before")

    def test_failed_or_unclosed_source_and_changed_identity_reject(self):
        for change in ("close-errno", "read-error", "open-end", "inode", "fd", "time", "bool-sequence"):
            rows = synthetic_snapshot()
            if change == "close-errno": rows[-1]["close_errno"] = 5
            elif change == "read-error": rows[1]["rc"] = -1; rows[1]["errno"] = 5
            elif change == "bool-sequence": rows[0]["seq"] = True
            else:
                info = binding(20, True)
                if change == "open-end": info["closed"] = False
                elif change == "inode": info["device_inode"] += 1
                elif change == "fd": info["fd"] += 1
                elif change == "time": info["at_ns"] = "9"
                raw = raw_json(info); rows[-1]["data_hex"] = raw.hex(); rows[-1]["bytes"] = len(raw)
            with self.subTest(change=change), self.assertRaises(ValueError):
                f3.decode_snapshot(rows, RUN, "control-before")

    def test_frame_fields_and_actual_encoded_budget_are_closed(self):
        base = synthetic_snapshot()
        for change in ("unknown", "run-id", "phase", "odd-hex", "raw-length", "nonfinite", "oversize"):
            rows = copy.deepcopy(base)
            if change == "unknown": rows[1]["qualification"] = "PASS"
            elif change == "run-id": rows[1]["run_id"] = "old-boot"
            elif change == "phase": rows[1]["phase"] = "read-before"
            elif change == "odd-hex": rows[1]["data_hex"] += "a"
            elif change == "raw-length": rows[1]["bytes"] += 1
            elif change == "nonfinite": rows[1]["seq"] = float("inf")
            else: rows[1]["data_hex"] = "ff"*65536; rows[1]["bytes"] = 65536
            with self.subTest(change=change), self.assertRaises(ValueError):
                f3.decode_snapshot(rows, RUN, "control-before")

    def test_four_snapshots_have_a_fixed_phase_order_and_total_budget(self):
        records = []
        for phase in f3.SNAPSHOT_PHASES:
            records += synthetic_snapshot(phase=phase, first_seq=len(records)+1)
        result = f3.decode_snapshots(records, RUN)
        self.assertEqual(tuple(result), f3.SNAPSHOT_PHASES)
        for altered in (records+synthetic_snapshot(phase="read-after", first_seq=len(records)+1),
                        records[3:]+records[:3], records[:-3]):
            with self.assertRaises(ValueError): f3.decode_snapshots(altered, RUN)


class NativeBlockControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="brdf3-codec-")
        cls.root = Path(cls.temporary.name)
        header = cls.root/"fixed.h"
        header.write_text("#define F2_FIXED_INPUTS 1\nstatic const unsigned char F2_EXPECTED_NOTES[]={0};\nstatic const unsigned char F2_EXPECTED_CONFIG[]={0};\n#define F3_FIXED_INPUTS 1\n" + "static const unsigned char F3_EXPECTED_PAYLOAD[]={" + ",".join(str(n) for n in f3.PAYLOAD) + "};\n")
        wrapper = cls.root/"block-control.c"
        wrapper.write_text('#define F3_PURE_TEST 1\n#include "'+str(ROOT/"scripts/qualification/whole-brd/f3-guest.c")+'"\n'
            'int main(int argc,char **argv){if(argc!=2)return 64;strcpy(run_id,"'+RUN+'");'
            'int fd=open(argv[1],O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return 66;'
            'int rc=f3_stream_blocks("control-before",fd);int ce=close(fd);return rc?rc:ce?74:0;}\n')
        cls.binary = cls.root/"block-control"
        result = subprocess.run(["cc","-std=c11","-Os","-Wall","-Wextra","-Werror","-Wno-unused-function",
            "-include",str(header),str(wrapper),"-o",str(cls.binary)],capture_output=True,timeout=10)
        if result.returncode:
            raise AssertionError(result.stderr.decode(errors="replace"))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_blocks(self, changes, length=67108864):
        with tempfile.TemporaryDirectory(dir=self.root) as name:
            path = Path(name)/"owned.bin"
            with path.open("wb") as handle:
                handle.truncate(length)
                for index, raw in changes.items():
                    handle.seek(index*BLOCK); handle.write(raw)
            return subprocess.run([str(self.binary),str(path)],capture_output=True,timeout=3)

    def test_actual_c_reads_nonzero_blocks_and_entire_tail(self):
        originals = {0:b"start"+bytes(BLOCK-5), 7:bytes(range(256))*16,
                     4097:b"middle"+bytes(BLOCK-6),BLOCKS-1:bytes(BLOCK-4)+b"last"}
        result = self.run_blocks(originals)
        self.assertEqual(result.returncode,0,result.stderr)
        measured = []
        for line in result.stdout.splitlines():
            self.assertTrue(line.startswith(b"BRDF3 "))
            row = json.loads(line[6:]); row["seq"] += 1; measured.append(row)
        # Only the block stream is a real C file read. The binding envelope below
        # is explicitly synthetic, not a block device / native F3 witness.
        rows = [frame("snapshot-begin","control-before",raw_json(binding(10,False)),1)] + measured
        rows.append(frame("snapshot-end","control-before",raw_json(binding(20,True)),len(rows)+1))
        snapshot = f3.decode_snapshot(rows,RUN,"control-before")
        for index in range(BLOCKS):
            expected = originals.get(index,ZERO)
            self.assertEqual(snapshot.hashes[index],hashlib.sha256(expected).hexdigest())
        self.assertLess(len(result.stdout),65536)

    def test_short_actual_file_cannot_supply_unread_zeros(self):
        result = self.run_blocks({},length=67108863)
        self.assertNotEqual(result.returncode,0)

    def test_nonzero_wire_overflow_is_bounded_and_fails(self):
        result = self.run_blocks({i:b"n"*BLOCK for i in range(1024)})
        self.assertNotEqual(result.returncode,0)
        self.assertLessEqual(len(result.stdout),7*1024*1024)



def synthetic_view(phase="control-before"):
    rows = []
    def add(event, value):
        raw = value if type(value) is bytes else raw_json(value)
        rows.append(frame(event,phase,raw,len(rows)+1))
    head={"root_fd":3,"dev":256,"ino":2,"object_count":5,"ordinary_source_open_count":0}
    add("view-begin",head);add("view-members",b"payload\0directory\0ancestor\0lost+found\0")
    for name,number in zip(f3.VIEW_NAMES,(2,12,13,14,11)):
        value={"name":name,"fd":4,"dev":256,"ino":number,"mode":0o100600 if name=="payload" else 0o40700,
          "uid":0 if name=="lost+found" else 1000,"gid":0 if name=="lost+found" else 1000,
          "nlink":1 if name=="payload" else 2,"size":len(f3.PAYLOAD) if name=="payload" else BLOCK,
          "atime":[100,1],"mtime":[100,2],"ctime":[100,3]}
        add("view-object",value)
        if name!="lost+found":
            for key,val in f3.FIXED_ATTR.items():add("view-attr",struct.pack("<HI",len(key),len(val))+key+val)
        if name not in (".","payload"):add("view-members",b"")
        if name=="ancestor":add("view-absence",{"path":"ancestor/missing","ancestor_fd":4,"dev":256,"ino":number,"errno":2})
        add("view-close",{"name":name,"fd":4})
    add("view-close",{"name":"root","fd":3});add("view-end",head)
    return rows


def synthetic_inode_image():
    d=f2._module("diagnostics")
    sb=bytearray(1024)
    struct.pack_into("<I",sb,4,BLOCKS);struct.pack_into("<I",sb,24,2)
    struct.pack_into("<I",sb,32,32768);struct.pack_into("<I",sb,40,2048)
    struct.pack_into("<HH",sb,56,0xef53,1);struct.pack_into("<H",sb,88,256)
    struct.pack_into("<III",sb,92,60,710,1131);sb[104:120]=bytes(range(16))
    struct.pack_into("<I",sb,0xe0,8);sb[0x175]=1
    struct.pack_into("<I",sb,1020,d.crc32c(sb[:1020]))
    block0=bytearray(BLOCK);block0[1024:2048]=sb
    group=bytearray(BLOCK);struct.pack_into("<I",group,8,4)
    table=bytearray(BLOCK)
    def item(size,physical,count):
        value=bytearray(256);struct.pack_into("<H",value,0,0o100600)
        struct.pack_into("<I",value,4,size);struct.pack_into("<I",value,32,0x80000)
        struct.pack_into("<HHHHI",value,40,0xf30a,1,4,0,0)
        struct.pack_into("<IHHI",value,52,0,count,0,physical)
        return value
    table[7*256:8*256]=item(4*1024*1024,2048,1024)
    table[11*256:12*256]=item(len(f3.PAYLOAD),4096,1)
    data={0:bytes(block0),1:bytes(group),4:bytes(table),4096:f3.PAYLOAD+bytes(BLOCK-len(f3.PAYLOAD))}
    return f3.decode_snapshot(synthetic_snapshot(data),RUN,"control-before")


class ClosureControls(unittest.TestCase):
    def test_actual_raw_inode_offsets_determine_the_complete_extent_map(self):
        image=synthetic_inode_image()
        mapped=f3.extent_blocks(f3.inode(image,8),1024)
        self.assertEqual(mapped,tuple(range(2048,3072)))
        view=f3.source_view(synthetic_view(),RUN,"control-before")
        self.assertEqual(f3.source_payload(image,view)["sha256"],hashlib.sha256(f3.PAYLOAD).hexdigest())
        for field,value in ((40,0),(46,1),(52,1),(56,0),(56,32768),(60,BLOCKS)):
            changed=bytearray(f3.inode(image,8))
            struct.pack_into("<H" if field in (40,46,56) else "<I",changed,field,value)
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                f3.extent_blocks(bytes(changed),1024)

    def test_complete_views_require_membership_attributes_absence_and_real_close_receipts(self):
        original=synthetic_view()
        actual=f3.source_view(original,RUN,"control-before")
        self.assertEqual(actual["content_opens"],0)
        self.assertEqual(actual["members"],["ancestor","directory","lost+found","payload"])
        for kind in ("missing-attr","extra-member","nonempty-directory","absence","wrong-close","close-failed","missing-end","duplicate-attr"):
            rows=copy.deepcopy(original)
            if kind=="missing-attr":del rows[3]
            elif kind=="duplicate-attr":rows.insert(4,copy.deepcopy(rows[3]))
            elif kind=="extra-member":
                rows[1].update(bytes=rows[1]["bytes"]+6,data_hex=rows[1]["data_hex"]+b"extra\0".hex())
            elif kind=="nonempty-directory":
                row=next(r for r in rows[2:] if r["event"]=="view-members");row.update(bytes=5,data_hex=b"file\0".hex())
            elif kind=="absence":
                row=next(r for r in rows if r["event"]=="view-absence")
                value=json.loads(bytes.fromhex(row["data_hex"]));value["ino"]+=1
                raw=raw_json(value);row.update(bytes=len(raw),data_hex=raw.hex())
            elif kind=="wrong-close":
                row=next(r for r in rows if r["event"]=="view-close");raw=raw_json({"name":".","fd":99});row.update(bytes=len(raw),data_hex=raw.hex())
            elif kind=="close-failed":next(r for r in rows if r["event"]=="view-close")["close_errno"]=5
            elif kind=="missing-end":rows.pop()
            with self.subTest(kind=kind),self.assertRaises(ValueError):f3.source_view(rows,RUN,"control-before")

    def test_native_positive_entry_links_to_unchanged_real_probe_but_cannot_boot_here(self):
        with tempfile.TemporaryDirectory(prefix="brdf3-link-") as directory:
            out=Path(directory);header=out/"fixed.h"
            header.write_text("#define F2_FIXED_INPUTS 1\n#define F3_FIXED_INPUTS 1\n"+
              "static const unsigned char F2_EXPECTED_NOTES[]={0};\nstatic const unsigned char F2_EXPECTED_CONFIG[]={0};\n"+
              "static const unsigned char F3_EXPECTED_PAYLOAD[]={"+",".join(str(n) for n in f3.PAYLOAD)+"};\n")
            common=["cc","-std=c11","-Os","-Wall","-Wextra","-Werror"]
            result=subprocess.run(["cc","-std=gnu11","-O2","-Wall","-Wextra","-Werror","-Dmain=brdf3_sp_main","-c",str(ROOT/"scripts/qualification/fs-source-preservation/probe.c"),"-o",str(out/"probe.o")],capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr.decode(errors="replace"))
            result=subprocess.run(common+["-static","-include",str(header),str(ROOT/"scripts/qualification/whole-brd/f3-guest.c"),
              str(out/"probe.o"),"-o",str(out/"guest")],capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr.decode(errors="replace"))
            for mode,expected in (("bootstrap",77),("ordinary",77),("unknown",64)):
                result=subprocess.run([str(out/"guest"),mode],capture_output=True,timeout=3)
                self.assertEqual(result.returncode,expected);self.assertEqual(result.stdout,b"")



def synthetic_effects():
    """Four measured-encoding controls plus constructed checksummed ext4/JBD2.
    These bytes were not produced by a guest and never enter qualification artifacts.
    """
    _,d,_=f3._sp()
    source=synthetic_inode_image()
    uuid=bytes.fromhex(f3.plan(raw_json({"run_id":RUN}))["filesystem_uuid"].replace("-",""))
    template=bytearray(source.range(1024,1024));template[104:120]=uuid
    struct.pack_into("<H",template,54,0xffff)
    def sb(mounted,path,kbytes,wtime,mount_count,mtime):
        raw=bytearray(template);struct.pack_into("<I",raw,96,710 if mounted else 706)
        raw[136:200]=path.encode().ljust(64,b"\0");struct.pack_into("<Q",raw,0x178,kbytes)
        struct.pack_into("<H",raw,52,mount_count);struct.pack_into("<I",raw,44,mtime)
        struct.pack_into("<I",raw,48,wtime);struct.pack_into("<I",raw,1020,d.crc32c(raw[:1020]));return bytes(raw)
    def checksum(raw,offset,seed):
        struct.pack_into(">I",raw,offset,0);struct.pack_into(">I",raw,offset,d.crc32c(raw,seed));return bytes(raw)
    head=bytearray(1024);struct.pack_into(">6I",head,0,0xc03b3998,4,0,4096,1024,1)
    struct.pack_into(">I",head,0x18,5);struct.pack_into(">3I",head,0x24,0,0x12,0)
    head[0x30:0x40]=uuid;struct.pack_into(">I",head,0x40,1);head[0x50]=4;struct.pack_into(">I",head,0x58,14)
    original=checksum(head,0xfc,0xffffffff)+bytes(4*1024*1024-1024)
    altered=bytearray(original);head=bytearray(original[:1024]);struct.pack_into(">I",head,0x18,8);struct.pack_into(">I",head,0x58,17)
    altered[:1024]=checksum(head,0xfc,0xffffffff)
    sample=sb(True,"/mnt/brd",4,101,3,101);payload=bytes(1024)+sample+bytes(2048)
    seed=d.crc32c(uuid);tx=6
    descriptor=bytearray(BLOCK);struct.pack_into(">3I",descriptor,0,0xc03b3998,1,tx)
    struct.pack_into(">4I",descriptor,12,0,8,0,d.crc32c(payload,d.crc32c(struct.pack(">I",tx),seed)))
    commit=bytearray(BLOCK);struct.pack_into(">3I",commit,0,0xc03b3998,2,tx);struct.pack_into(">QI",commit,48,102,1)
    for index,block in ((14,checksum(descriptor,4092,seed)),(15,payload),(16,checksum(commit,16,seed))):
        altered[index*BLOCK:(index+1)*BLOCK]=block
    snapshots,views={},{}
    specifications=(("control-before",True,"/mnt/f3-prepare",0,90,2,90,10,20,original),
                    ("control-after",False,"/mnt/f3-prepare",4,100,2,90,40,50,original),
                    ("read-before",True,"/mnt/f3-prepare",4,101,3,101,70,80,original),
                    ("read-after",False,"/mnt/brd",20,102,3,101,100,110,bytes(altered)))
    for phase,mounted,point,kbytes,wtime,count,mtime,begin,end,raw_journal in specifications:
        blocks={index:source.block(index) for index in (1,4,4096)}
        blocks[0]=bytes(1024)+sb(mounted,point,kbytes,wtime,count,mtime)+bytes(2048)
        for index in range(1024):
            raw=raw_journal[index*BLOCK:(index+1)*BLOCK]
            if raw!=ZERO:blocks[2048+index]=raw
        rows=synthetic_snapshot(blocks,phase)
        for row,at,closed in ((rows[0],begin,False),(rows[-1],end,True)):
            data=raw_json(binding(at,closed));row.update(bytes=len(data),data_hex=data.hex())
        snapshots[phase]=f3.decode_snapshot(rows,RUN,phase)
        views[phase]=f3.source_view(synthetic_view(phase),RUN,phase)
    def stats(mono,real,sectors):
        values=[0]*17;values[6]=sectors
        raw=(" ".join(str(n) for n in values)+"\n").encode()
        return raw_json({"monotonic_ns":str(mono),"realtime_ns":str(real*1000000000),"raw_hex":raw.hex()})
    records={"control":{"before":stats(1,90,0),"mounted":stats(5,90,8),"after":stats(30,101,16),
                        "base":sb(False,"/mnt/f3-prepare",0,89,1,80)},
             "read":{"before":stats(60,101,16),"mounted":stats(65,101,24),"after":stats(90,103,56),
                     "base":sb(False,"/mnt/f3-prepare",4,100,2,90)}}
    return snapshots,views,records


class FullEffectsControls(unittest.TestCase):
    def test_cross_round_block_zero_cannot_cancel_unknown_bytes(self):
        _,d,_=f3._sp()
        for offset in (2500,1024+120):
            snapshots,views,records=synthetic_effects()
            for key in ("control-before","control-after"):
                image=snapshots[key];blocks=dict(image.nonzero);raw=bytearray(image.block(0));raw[offset]^=1
                if offset<2048:struct.pack_into("<I",raw,1024+1020,d.crc32c(raw[1024:1024+1020]))
                blocks[0]=bytes(raw);rows=synthetic_snapshot(blocks,key)
                for row,info in ((rows[0],image.before),(rows[-1],image.after)):
                    data=raw_json(dict(info));row.update(bytes=len(data),data_hex=data.hex())
                snapshots[key]=f3.decode_snapshot(rows,RUN,key)
            with self.subTest(offset=offset),self.assertRaises(ValueError):
                f3.device_effects(snapshots,views,records,RUN)

    def test_each_mount_base_and_real_mount_accounting_are_required(self):
        _,d,_=f3._sp()
        for phase,case in ((p,c) for p in ("control","read") for c in
                           ("volume-name","mount-count","mount-time","mount-sectors","mount-kbytes")):
            snapshots,views,records=synthetic_effects()
            if case in ("volume-name","mount-count","mount-kbytes"):
                raw=bytearray(records[phase]["base"])
                offset={"volume-name":120,"mount-count":52,"mount-kbytes":0x178}[case]
                raw[offset]^=1;struct.pack_into("<I",raw,1020,d.crc32c(raw[:1020]));records[phase]["base"]=bytes(raw)
            else:
                value=json.loads(records[phase]["mounted"])
                if case=="mount-time":value["realtime_ns"]="89000000000"
                else:
                    fields=bytes.fromhex(value["raw_hex"]).decode().split();fields[6]=str(int(fields[6])+8)
                    value["raw_hex"]=(" ".join(fields)+"\n").encode().hex()
                records[phase]["mounted"]=raw_json(value)
            with self.subTest(phase=phase,case=case),self.assertRaises(ValueError):
                f3.device_effects(snapshots,views,records,RUN)

    def test_checksums_exact_diagnostic_unmount_and_complete_four_device_observations(self):
        snapshots,views,records=synthetic_effects()
        result=f3.device_effects(snapshots,views,records,RUN)
        self.assertEqual(result["effects"]["control"]["changed_device_blocks"],[0])
        self.assertEqual(result["effects"]["read"]["changed_device_blocks"],[0,2048,2062,2063,2064])
        self.assertEqual(result["effects"]["read"]["diagnostic"]["transaction_id"],6)
        self.assertEqual(result["effects"]["read"]["harness_unmount"]["observed_kbytes"],20)
        for phase,count in (("control",2),("read",3)):
            mount=result["effects"][phase]["harness_mount"]
            self.assertEqual(mount["mount_count_after"],count)
            self.assertEqual(mount["write_sectors"],8);self.assertFalse(mount["provider_action"])
            self.assertEqual(mount["inputs_sha256"]["base"],hashlib.sha256(records[phase]["base"]).hexdigest())
        self.assertEqual(records["read"]["base"],snapshots["control-after"].range(1024,1024))
        self.assertFalse(result["effects"]["read"]["diagnostic"]["production_supported"])
        self.assertEqual(len([name for name in result["artifacts"] if name.endswith("-journal.bin")]),4)
        self.assertLess(sum(map(len,result["artifacts"].values())),64*1024*1024)

    def test_unknown_application_bytes_extra_transaction_and_block_zero_tail_are_rejected(self):
        for index,offset in ((10,0),(2048+100,0),(0,2500)):
            snapshots,views,records=synthetic_effects()
            image=snapshots["read-after"];blocks=dict(image.nonzero)
            raw=bytearray(image.block(index));raw[offset]^=1;blocks[index]=bytes(raw)
            rows=synthetic_snapshot(blocks,"read-after")
            for row,at,closed in ((rows[0],100,False),(rows[-1],110,True)):
                data=raw_json(binding(at,closed));row.update(bytes=len(data),data_hex=data.hex())
            snapshots["read-after"]=f3.decode_snapshot(rows,RUN,"read-after")
            with self.subTest(index=index),self.assertRaises(ValueError):f3.device_effects(snapshots,views,records,RUN)

    def test_accounting_time_uuid_or_application_view_uncertainty_is_not_success(self):
        for case in ("sectors","time","uuid","view"):
            snapshots,views,records=synthetic_effects()
            if case=="view":views["read-after"]=copy.deepcopy(views["read-after"]);views["read-after"]["objects"]["payload"]["mode"]=0o100640
            elif case=="uuid":pass
            else:
                value=json.loads(records["read"]["after"])
                if case=="time":value["realtime_ns"]="99000000000"
                else:
                    fields=bytes.fromhex(value["raw_hex"]).decode().split();fields[6]="58";value["raw_hex"]=(" ".join(fields)+"\n").encode().hex()
                records["read"]["after"]=raw_json(value)
            with self.subTest(case=case),self.assertRaises(ValueError):
                f3.device_effects(snapshots,views,records,"831af363-b224-4d47-a5b6-5a4573192db3" if case=="uuid" else RUN)



def load_module(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def synthetic_serial():
    """Whole protocol ordering with constructed metadata/images, not boot evidence.
    Native parsing is a separately frozen consumer and is stubbed only by these
    ordering tests; no old live FD/boot identity enters a runtime bundle.
    """
    prior=load_module("f3_f2_synthetic_controls",ROOT/"tests/whole-brd-f2.test.py")
    prior.RUN=RUN
    old=prior.DecoderTests().frames()
    prefix=[];ordinary=[]
    for tag,row in old:
        if tag=="BRDF1" or row.get("event") in f2.EVENTS[:17]:prefix.append((tag,copy.deepcopy(row)))
        if row.get("origin")=="ordinary" and tag=="BRDF2":ordinary.append(copy.deepcopy(row))
    snapshots,_,records=synthetic_effects()
    output=prefix;next_legacy=18;next_f3=1
    def add(event,phase,raw=b""):
        nonlocal next_f3
        output.append(("BRDF3",frame(event,phase,raw,next_f3)));next_f3+=1
    def legacy(event,raw=b""):
        nonlocal next_legacy
        output.append(("BRDF2",{"run_id":RUN,"origin":"management","seq":next_legacy,"event":event,
          "rc":0,"errno":0,"close_errno":0,"bytes":len(raw),"data_hex":raw.hex()}));next_legacy+=1
    def wait(pid):
        return {"pid":pid,"exit":0,"signal":0,"timeout":False,"reaped":True,"pidfd_before_ack":True}
    def image(key):
        value=snapshots[key];rows=synthetic_snapshot(value.nonzero,key)
        for row,info in ((rows[0],value.before),(rows[-1],value.after)):
            raw=raw_json(dict(info));row.update(bytes=len(raw),data_hex=raw.hex())
        for row in rows:add(row["event"],key,bytes.fromhex(row["data_hex"]))
    def view(key):
        for row in synthetic_view():
            add(row["event"],key,bytes.fromhex(row["data_hex"]))
    add("mount","prepare",b"/mnt/f3-prepare");add("prepare-objects","prepare",f3.PAYLOAD)
    add("unmount","prepare",b"/mnt/f3-prepare")
    for phase,pid,joined in (("control",5,25),("read",6,85)):
        add("round-begin",phase);add("block-stat-before",phase,records[phase]["before"])
        add("mount-base",phase,records[phase]["base"]);add("mount",phase,b"/mnt/brd")
        add("block-stat-mounted",phase,records[phase]["mounted"])
        if phase=="control":
            legacy("metadata-start")
            output.extend(("BRDF2",row) for row in ordinary)
            legacy("metadata-exit",raw_json(wait(4)))
        image(phase+"-before");view(phase+"-before")
        add("native-begin",phase,b"context" if phase=="control" else b"ordinary")
        legacy("metadata-start")
        output.append(("NATIVE",{"synthetic-only":True}))
        legacy("metadata-exit",raw_json(wait(pid)))
        add("native-end",phase,raw_json(wait(pid)|{"joined_ns":str(joined)}))
        view(phase+"-after");add("unmount",phase,b"/mnt/brd")
        add("block-stat-after",phase,records[phase]["after"]);image(phase+"-after");add("round-end",phase)
    for name in ("cleanup-fd","device-remove","module-unload"):legacy(name)
    add("guest-complete","cleanup",raw_json({"original_errno":0,"cleanup_errno":0,"source_observations_complete":True,
      "module_loaded":False,"mounted":False,"node_exists":False,"children_reaped":True,
      "parent_closes":[{"fd":5,"errno":0}]}))
    return output


def serial_bytes(rows):
    return b"".join((b"" if tag=="NATIVE" else tag.encode()+b" ")+raw_json(row)+b"\n" for tag,row in rows)


class SequenceControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original=synthetic_serial()

    def consume(self,rows):
        with patch.object(f3,"native_window",return_value={"status":"SYNTHETIC_NATIVE_SEAM_ONLY"}) as native:
            result=f3.decode_serial(serial_bytes(rows),RUN,b"exact-notes")
        self.assertEqual(native.call_count,2)
        self.assertEqual([call.args[1] for call in native.call_args_list],["control","read"])
        self.assertTrue(all(call.args[0]==b'{"synthetic-only":true}\n' for call in native.call_args_list))
        return result

    def test_complete_control_and_read_sequence_consumes_all_four_images(self):
        result=self.consume(copy.deepcopy(self.original))
        self.assertEqual(result["state"],"F3_SOURCE_PRESERVATION_OBSERVED")
        self.assertEqual(result["qualification"],"UNSUPPORTED")
        self.assertEqual(result["accepted_provider_profiles"],[])
        self.assertFalse(result["commit_barrier"]);self.assertEqual(result["content_probes"],1)
        self.assertEqual(len([name for name in result["raw_artifacts"] if name in [phase+"-blocks.json" for phase in f3.SNAPSHOT_PHASES]]),4)

    def test_missing_replayed_failed_close_or_early_cleanup_is_rejected(self):
        for case in ("missing","replay","close","end","cleanup","before-p1","extra-native","prepared-sb"):
            rows=copy.deepcopy(self.original)
            i=next(i for i,(_,row) in enumerate(rows) if row.get("event")=="view-absence")
            if case=="missing":rows.pop(i)
            elif case=="replay":rows.insert(i,copy.deepcopy(rows[i]))
            elif case=="close":next(row for _,row in rows if row.get("event")=="view-close")["close_errno"]=5
            elif case=="end":rows.pop()
            elif case=="cleanup":
                i=next(i for i,(_,row) in enumerate(rows) if row.get("event")=="cleanup-fd")
                rows.insert(1,rows.pop(i))
            elif case=="extra-native":rows.append(("NATIVE",{"kind":"content","hex":"ff"}))
            elif case=="prepared-sb":
                row=next(row for _,row in rows if row.get("event")=="prepared-superblock")
                raw=bytearray.fromhex(row["data_hex"]);raw[120]^=1;row["data_hex"]=raw.hex()
            else:
                # Preserve every per-protocol sequence while moving all preparation
                # before the current-boot policy; this must not become a valid run.
                prepare=[pair for pair in rows if pair[0]=="BRDF3" and pair[1]["phase"]=="prepare"]
                rows=prepare+[pair for pair in rows if pair not in prepare]
            with self.subTest(case=case),self.assertRaises(ValueError):self.consume(rows)


class BundleAndRunnerControls(unittest.TestCase):
    def test_offline_archive_is_exactly_new_scope_and_old_allowlist_stays_unchanged(self):
        import gzip,stat
        # Synthetic fixed-byte contract for archive parsing only, never a build.
        notes=b"synthetic-notes";brd=b"B"*30017
        files={name:("synthetic:"+name).encode() for name in f2.PAYLOAD_FILES}
        catalog={name:(len(raw),hashlib.sha256(raw).hexdigest(),f2.PAYLOAD_FILES[name][2]) for name,raw in files.items()}
        config=(ROOT/"scripts/qualification/whole-brd/mke2fs-f2.conf").read_bytes()
        with patch.object(f2,"NOTES_SHA",hashlib.sha256(notes).hexdigest()),patch.object(f2,"BRD_SHA",hashlib.sha256(brd).hexdigest()),patch.object(f2,"PAYLOAD_FILES",catalog):
            args=(RUN,b"synthetic-busybox",b"synthetic-helper",notes,brd,config,files)
            old=f2.payload(*args);new=f3.payload(*args)
            self.assertEqual(len(f2.inspect_payload(old,RUN)["members"]),42)
            members=f3.inspect_payload(new,RUN)["members"]
            self.assertEqual(len(members),43)
            self.assertEqual(members[-1]["name"],"mnt/f3-prepare")
            self.assertEqual(members[-1]["mode"],stat.S_IFDIR|0o700)
            with self.assertRaises(ValueError):f2.inspect_payload(new,RUN)
            with self.assertRaises(ValueError):f3.inspect_payload(old,RUN)
            with self.assertRaises(ValueError):f3.inspect_payload(new+b"trailing",RUN)
            raw=gzip.decompress(new)
            with self.assertRaises(ValueError):f3.inspect_payload(gzip.compress(raw.replace(b"mnt/f3-prepare",b"mnt/foreignxx"),mtime=0),RUN)

    def test_bundle_binds_all_six_files_and_rejects_old_or_changed_sources_before_spawn(self):
        runner=load_module("f3_runner_controls",ROOT/"scripts/qualification/whole-brd/f3-run.py")
        bound=runner.builder.source_bindings()
        for name in ("f3.py","f3-build.py","f3-run.py","f3-guest.c","F3.md","../../../tests/whole-brd-f3.test.py"):
            self.assertEqual(bound[name]["sha256"],hashlib.sha256((runner.builder.HERE/name).read_bytes()).hexdigest())
        self.assertIs(runner.finish_artifacts,runner._old.finish_artifacts)
        self.assertIs(runner.create_claim,runner._old.create_claim)
        wrong={"state":"FIXED_F2_BUNDLE_NOT_BOOTED"}
        changed={"state":"FIXED_F3_BUNDLE_NOT_BOOTED","request":{"run_id":RUN},
                 "proposal":f3.plan(raw_json({"run_id":RUN})),"source":{}}
        for value in (wrong,changed):
            with self.subTest(value=value["state"]),tempfile.TemporaryDirectory(prefix="brdf3-validation-") as directory:
                path=Path(directory)/"BUNDLE.json";raw=raw_json(value);path.write_bytes(raw)
                with patch.object(runner,"OwnedChild",side_effect=AssertionError("no guest")) as child,self.assertRaises(ValueError):
                    runner.execute(str(path),hashlib.sha256(raw).hexdigest(),str(Path(directory)/"out"))
                child.assert_not_called()
                self.assertFalse((Path(directory)/"EXECUTION-ATTEMPT.json").exists())
                self.assertFalse((Path(directory)/"out").exists())

    def test_host_claim_and_final_close_failures_never_succeed_or_retry(self):
        runner=load_module("f3_runner_cleanup_controls",ROOT/"scripts/qualification/whole-brd/f3-run.py")
        class FakeArtifacts:
            entries={}
            closed=0
            def seal(self):return []
            def put(self,*_):pass
            def close(self):self.closed+=1;return [{"errno":5}]
        artifacts=FakeArtifacts()
        bundle={"request":{"run_id":RUN},"proposal":f3.plan(raw_json({"run_id":RUN}))}
        first=FileExistsError(17,"exclusive synthetic claim")
        with patch.object(runner,"validate",return_value=({},bundle,{})),patch.object(runner,"Artifacts",return_value=artifacts), \
             patch.object(runner,"create_claim",side_effect=first),patch.object(runner,"OwnedChild",side_effect=AssertionError("no guest")) as child:
            result=runner.execute("/unused/BUNDLE.json","0"*64,"/unused/output")
        child.assert_not_called();self.assertEqual(artifacts.closed,1)
        self.assertEqual(result["guest_attempts"],0);self.assertEqual(result["state"],"FAILED_NO_RETRY")
        self.assertEqual(result["original_error"]["errno"],17);self.assertEqual(result["final_artifact_errors"],[{"errno":5}])


    def test_normal_exit_owned_cleanup_and_last_artifact_close_all_gate_success(self):
        runner=load_module("f3_host_completion_controls",ROOT/"scripts/qualification/whole-brd/f3-run.py")
        raw=serial_bytes(synthetic_serial())
        bundle={"request":{"run_id":RUN},"proposal":f3.plan(raw_json({"run_id":RUN})),"runtime_environment":{},
          "qemu_data":{"path":"/unused/firmware"},"inputs":{name:{"path":"/unused/"+name,"sha256":"0"*64}
          for name in ("qemu","kernel","bios","initramfs","gate")}}
        normal={"verified":True,"forced":False,"wait_timeout":False,"wait":{"reaped":True,"returncode":0}}
        class FakeArtifacts:
            entries={}
            closed=0
            def seal(self):return []
            def put(self,*_):pass
            def close(self):self.closed+=1;return close_errors
        class FakeProcess:
            def poll(self):return exit_code
        class FakeOwned:
            proc=FakeProcess();argv=[];gate_argv=[];serial_identity={};before={};after={};events=[]
            def release(self,*_):pass
            def cleanup(self,*_):return cleanup
        class FakePump:
            errors=[];eof={"serial","qmp","stderr"};read_counts={}
            def __init__(self,_,artifacts,callback):self.serial=raw;callback(raw)
            def poll(self,*_):pass
            def finish(self,*_):pass
        class FakeQMP:
            receipts=[]
            def __init__(self,*_):pass
        cases=((normal,0,[],"F3_SOURCE_PRESERVATION_OBSERVED"),
               (normal|{"forced":True},0,[],"FAILED_NO_RETRY"),
               (normal,1,[],"FAILED_NO_RETRY"),
               (normal,0,[{"errno":5}],"EVIDENCE_UNPROVEN"))
        for cleanup,exit_code,close_errors,state in cases:
            artifacts=FakeArtifacts()
            with self.subTest(state=state),patch.object(runner,"validate",return_value=({},bundle,{"notes":b"exact-notes"})), \
                 patch.object(runner,"Artifacts",return_value=artifacts),patch.object(runner,"create_claim"), \
                 patch.object(runner,"bounded_read",return_value=b""),patch.object(runner,"OwnedChild",return_value=FakeOwned()), \
                 patch.object(runner,"Pump",FakePump),patch.object(runner,"QMP",FakeQMP), \
                 patch.object(f3,"native_window",return_value={"status":"SYNTHETIC_NATIVE_SEAM_ONLY"}):
                result=runner.execute("/unused/BUNDLE.json","0"*64,"/unused/output")
            self.assertEqual(result["state"],state);self.assertEqual(artifacts.closed,1)
            self.assertEqual(result["attempts"],1);self.assertEqual(result["guest_attempts"],1)

if __name__ == "__main__":
    unittest.main(verbosity=2)

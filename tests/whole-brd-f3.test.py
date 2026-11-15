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

if __name__ == "__main__":
    unittest.main(verbosity=2)

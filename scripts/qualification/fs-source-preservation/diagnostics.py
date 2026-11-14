"""#152 r2 的窄 ext4/JBD2 离线分类；不注册 provider，不证明运行时零写。

这里只支持已固定的 4 KiB、internal-journal/csum-v3/64bit 单 SB 事务。
未知格式、额外事务、payload、revoke 或差异均拒绝；没有 journal 字节通配。
机制固定于 Linux 028ef9c96e96197026887c0f092424679298aae8：
fs/jbd2/{journal,recovery,commit}.c、include/linux/jbd2.h、fs/ext4/{file,super}.c。
实际 vendor build 对应和完整源保全仍由资格链另外核对。
"""
from __future__ import annotations
import hashlib
import re
import struct


class Invalid(ValueError):
    pass


def need(condition, reason):
    if not condition:
        raise Invalid(reason)


def crc32c(raw: bytes, seed: int = 0xffffffff) -> int:
    """Linux crc32c 的原始累积值；不执行用户协议常见的最终 xor。"""
    value = seed
    for byte in raw:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value


def be32(raw, offset):
    return struct.unpack_from('>I', raw, offset)[0]


def le32(raw, offset):
    return struct.unpack_from('<I', raw, offset)[0]


def _checksum(raw, offset, seed, *, endian='>'):
    altered = bytearray(raw)
    actual = struct.unpack_from(endian + 'I', altered, offset)[0]
    altered[offset:offset + 4] = bytes(4)
    need(crc32c(altered, seed) == actual, 'checksum mismatch at ' + str(offset))


def _changes(before, after):
    need(len(before) == len(after), 'raw size changed')
    return [i for i, (a, b) in enumerate(zip(before, after)) if a != b]


def ext4_superblock(raw, *, unmounted=False):
    need(type(raw) is bytes and len(raw) == 1024, 'ext4 SB size')
    need(raw[56:58] == b'\x53\xef' and le32(raw, 24) == 2, '4KiB native ext4 required')
    need(struct.unpack_from('<III', raw, 92) == (60, 706 if unmounted else 710, 1131), 'unqualified ext4 feature vector')
    need(raw[0x175] == 1 and crc32c(raw[:1020]) == le32(raw, 1020), 'ext4 checksum')
    need(struct.unpack_from('<H', raw, 58)[0] == 1, 'ext4 state error/unknown')
    need(raw[0x194:0x200] == bytes(0x6c) and raw[0x278:0x27c] == bytes(4), 'ext4 error fields')
    need(le32(raw, 0xe0) == 8 and raw[0xd0:0xe0] == bytes(16), 'internal journal inode8 only')
    need(raw[104:120] != bytes(16), 'zero filesystem UUID')
    return {'uuid': raw[104:120].hex(), 'last_mounted': raw[136:200].hex()}


def classify_sample(before, after, mount_path):
    """只分类 sample 自身；flush/unmount 的统计不能混入这里。"""
    first, last = ext4_superblock(before), ext4_superblock(after)
    need(isinstance(mount_path, str) and re.fullmatch(r'/[A-Za-z0-9/_.-]{1,62}', mount_path),
         'bounded qualification mount path')
    need(all(part not in ('', '.', '..') for part in mount_path.split('/')[1:]), 'canonical mount path')
    expected = mount_path.encode('ascii').ljust(64, b'\0')
    need(before[136:200] != expected and after[136:200] == expected, 'actual new mount diagnostic sample required')
    changed = _changes(before, after)
    allowed = set(range(136, 200)) | set(range(1020, 1024))
    need(set(changed) <= allowed and first['uuid'] == last['uuid'], 'unapproved ext4 SB mutation')
    return {'changed_offsets': changed, 'filesystem_uuid': first['uuid'], 'mount_path': mount_path}


def _journal(raw, filesystem_uuid):
    need(type(raw) is bytes and len(raw) == 4 * 1024 * 1024, 'bounded complete 4MiB journal required')
    need(struct.unpack_from('>6I', raw) == (0xc03b3998, 4, 0, 4096, 1024, 1), 'unknown JBD2 geometry/header')
    need(struct.unpack_from('>3I', raw, 0x24) == (0, 0x12, 0), 'only 64bit/csum-v3 journal supported')
    need(be32(raw, 0x20) == 0, 'journal errno')
    need(raw[0x50] == 4 and be32(raw, 0x54) == 0, 'journal checksum type/fast-commit')
    need(raw[0x30:0x40].hex() == filesystem_uuid and be32(raw, 0x40) == 1, 'journal UUID/users')
    _checksum(raw[:1024], 0xfc, 0xffffffff)
    need(raw[1024:4096] == bytes(3072), 'unknown journal SB block tail')
    return {'sequence': be32(raw, 0x18), 'start': be32(raw, 0x1c), 'head': be32(raw, 0x58),
            'seed': crc32c(raw[0x30:0x40])}


def classify_diagnostic_transaction(before, after, sb_before, sb_after, mount_path):
    """完整 clean-mount → one sample → clean-unmount 的窄原件分类。

    该阶段的 after 是 root harness 卸载后的观察，绝不是 provider 的 Tcut。
    recover 对 clean log 取 sequence+1；一次事务随后 destroy 再加一，故
    after.s_sequence == tx+2。起始 head 必须正好容纳唯一 D/P/C 三块。
    wrap、空的其它事务或不同生命周期均不在本次已实现分支内。
    """
    sample = classify_sample(sb_before, sb_after, mount_path)
    first = _journal(before, sample['filesystem_uuid'])
    last = _journal(after, sample['filesystem_uuid'])
    need(first['start'] == last['start'] == 0, 'journal lifecycle not clean-to-clean')
    start = first['head']
    need(1 <= start <= 1020, 'journal ring wrap not qualified')
    tx = first['sequence'] + 1
    need(tx < 0xfffffffe and last['sequence'] == tx + 2 and last['head'] == start + 3,
         'journal lifecycle is not the single observed transaction')
    permitted_sb = set(range(0x18, 0x20)) | set(range(0x58, 0x5c)) | set(range(0xfc, 0x100))
    need(set(_changes(before[:4096], after[:4096])) <= permitted_sb, 'unapproved JBD2 SB field')
    changed = [i for i in range(1024) if before[i * 4096:(i + 1) * 4096] != after[i * 4096:(i + 1) * 4096]]
    need(changed == [0, start, start + 1, start + 2], 'extra/missing journal block or transaction')
    descriptor, payload, commit = [after[i * 4096:(i + 1) * 4096] for i in range(start, start + 3)]
    need(struct.unpack_from('>3I', descriptor) == (0xc03b3998, 1, tx), 'descriptor sequence/header')
    block, flags, high, tag_sum = struct.unpack_from('>4I', descriptor, 12)
    need(block == high == 0 and flags == 8, 'only one unescaped LAST_TAG targeting primary SB block0')
    # Internal-journal j_uuid remains zero in this fixed target; it is not a wildcard UUID.
    need(descriptor[28:44] == bytes(16) and descriptor[44:-4] == bytes(4096 - 48),
         'unknown tag UUID/extra tag/descriptor payload')
    _checksum(descriptor, 4092, first['seed'])
    need(payload[:1024] == bytes(1024) and payload[2048:] == bytes(2048), 'extra data outside SB in payload')
    need(payload[1024:2048] == sb_after, 'journal payload differs from approved sample SB')
    seed = crc32c(struct.pack('>I', tx), first['seed'])
    need(crc32c(payload, seed) == tag_sum, 'tag payload checksum')
    need(struct.unpack_from('>3I', commit) == (0xc03b3998, 2, tx), 'commit sequence/header')
    need(commit[12:16] == bytes(4) and commit[20:48] == bytes(28) and commit[60:] == bytes(4036),
         'unknown commit fields')
    seconds, nanos = struct.unpack_from('>QI', commit, 48)
    need(0 < seconds < (1 << 63) and nanos < 1_000_000_000, 'invalid commit time')
    _checksum(commit, 16, first['seed'])
    return {'status': 'CLASSIFIED', 'scope': 'single-diagnostic-transaction-structure',
            'transaction_id': tx, 'target_block': 0, 'changed_journal_blocks': changed,
            'commit_realtime_ns': str(seconds * 1_000_000_000 + nanos), 'sample': sample,
            'inputs_sha256': {name: hashlib.sha256(raw).hexdigest() for name, raw in (
                ('journal_before', before), ('journal_after', after), ('sb_before', sb_before), ('sb_after', sb_after))},
            'physical_device_zero_write': False, 'production_supported': False,
            'accepted_provider_profiles': [], 'qualified_kernel_builds': []}


def classify_unmount(before, after, mount_base, mount_start_sectors, final_sectors, time_begin_ns, time_end_ns, mount_path=None):
    """只核本 fixture 的明确卸载记账，不把卸载写入归给 ordinary provider。

    ext4_update_super 在最后一个 4KiB SB buffer 提交之前计算 kbytes；
    所以已卸载且无其它 loop writer 时，最终设备计数须扣除该最后8 sectors。
    这条精确公式不匹配就拒绝，不用范围/“背景写”弥补未知。
    """
    ext4_superblock(before); ext4_superblock(after, unmounted=True)
    ext4_superblock(mount_base, unmounted=True)
    need(before[104:120] == after[104:120] == mount_base[104:120], 'lifecycle UUID changed')
    allowed = set(range(136, 200)) | set(range(48, 52)) | {0x275} | set(range(0x178, 0x180))
    allowed |= set(range(96, 100)) | set(range(1020, 1024))
    need(set(_changes(before, after)) <= allowed, 'unapproved lifecycle SB mutation')
    need(le32(after, 96) == le32(before, 96) & ~4, 'unmount may clear only needs_recovery')
    expected_path = before[136:200] if mount_path is None else mount_path.encode('ascii').ljust(64, b'\0')
    need(after[136:200] == expected_path, 'unmount diagnostic mount path')
    need(all(type(v) is int and 0 <= v < (1 << 63) for v in (mount_start_sectors, final_sectors, time_begin_ns, time_end_ns)),
         'lifecycle counter/time domain')
    need(final_sectors >= mount_start_sectors + 8 and time_begin_ns <= time_end_ns, 'lifecycle counter/time order')
    initial_kbytes = struct.unpack_from('<Q', mount_base, 0x178)[0]
    observed_kbytes = struct.unpack_from('<Q', after, 0x178)[0]
    need(observed_kbytes == initial_kbytes + ((final_sectors - mount_start_sectors - 8) >> 1), 'persistent write accounting is not exactly explained')
    seconds = le32(after, 48) | (after[0x275] << 32)
    need(time_begin_ns // 1_000_000_000 <= seconds <= time_end_ns // 1_000_000_000, 'persistent write time outside harness lifecycle')
    return {'status': 'CLASSIFIED', 'scope': 'explicit-harness-unmount-accounting', 'initial_kbytes': initial_kbytes,
            'observed_kbytes': observed_kbytes, 'mount_start_sectors': str(mount_start_sectors),
            'final_sectors': str(final_sectors), 'final_sb_write_sectors': 8,
            'changed_offsets': _changes(before, after), 'provider_action': False}

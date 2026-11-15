#!/usr/bin/env python3
"""Synthetic parser controls only; no new ordinary getter or qualification run."""
from dataclasses import replace
from pathlib import Path
import sys
import struct
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] /
                       'scripts/qualification/fs-source-preservation'))
import effective_options as E


def context():
    # Synthetic source/namespace labels; they do not establish a live FD binding.
    return E.Context(observation_id='a' * 64, phase='before', pid=101,
                     pid_namespace=4026531836, mount_namespace=4026531841,
                     source_fd=9, dev_major=7, dev_minor=0, mount_id=31,
                     sb_id='loop0', block_size=4096)


def complete_read(raw, ctx=None):
    return E.Read(context=ctx or context(), raw=raw, bytes_read=len(raw),
                  read_rc=0, errno=0, eof=True, close_rc=0, close_errno=0,
                  native_finished=True)


# The old run's 27-option shape, copied as a synthetic parser vector. It is not
# a fresh kernel observation or an accepted effective-options provider profile.
OPTIONS = (b'rw,bsddf,nogrpid,resuid=0,resgid=0,errors=remount-ro,user_xattr,acl,'
           b'noquota,barrier,commit=5,data=ordered,inode_readahead_blks=32,'
           b'init_itable=10,min_batch_time=0,max_batch_time=15000,stripe=0,'
           b'delalloc,block_validity,auto_da_alloc,dioread_nolock,nodiscard,'
           b'max_dir_size_kb=0,journal_checksum,nowarn_on_error,'
           b'prefetch_block_bitmaps,i_version\n')


# Exact text shape from ext4_mb_seq_structs_summary_show, with synthetic counts.
# 4 KiB => blocksize_bits 12 => MB_NUM_ORDERS 14, independently enumerated here.
SUMMARY = b'''optimize_scan: 1
max_free_order_lists:
\tlist_order_0_groups: 0
\tlist_order_1_groups: 2
\tlist_order_2_groups: 0
\tlist_order_3_groups: 0
\tlist_order_4_groups: 0
\tlist_order_5_groups: 0
\tlist_order_6_groups: 0
\tlist_order_7_groups: 0
\tlist_order_8_groups: 0
\tlist_order_9_groups: 0
\tlist_order_10_groups: 0
\tlist_order_11_groups: 0
\tlist_order_12_groups: 0
\tlist_order_13_groups: 1
avg_fragment_size_lists:
\tlist_order_0_groups: 0
\tlist_order_1_groups: 0
\tlist_order_2_groups: 3
\tlist_order_3_groups: 0
\tlist_order_4_groups: 0
\tlist_order_5_groups: 0
\tlist_order_6_groups: 0
\tlist_order_7_groups: 0
\tlist_order_8_groups: 0
\tlist_order_9_groups: 0
\tlist_order_10_groups: 0
\tlist_order_11_groups: 0
\tlist_order_12_groups: 0
\tlist_order_13_groups: 0
'''


class MbSummaryControls(unittest.TestCase):
    def test_direct_bit_and_complete_counts_are_only_diagnostics(self):
        observed = E.mb_summary(complete_read(SUMMARY), context(), complete_read(OPTIONS))
        self.assertEqual(observed.value.optimize_scan, 1)
        self.assertEqual(observed.value.max_free_groups, (0, 2) + (0,) * 11 + (1,))
        self.assertEqual(observed.value.avg_fragment_groups, (0, 0, 3) + (0,) * 11)
        self.assertEqual(observed.status, 'OBSERVED')
        self.assertEqual(observed.qualification, 'UNSUPPORTED')
        self.assertFalse(observed.production_supported)
        disabled = E.mb_summary(complete_read(SUMMARY.replace(b'optimize_scan: 1',
                                                            b'optimize_scan: 0')), context(),
                                complete_read(OPTIONS))
        self.assertEqual(disabled.value.optimize_scan, 0)

    def test_header_alone_is_not_a_complete_getter(self):
        with self.assertRaises(E.Rejected):
            E.mb_summary(complete_read(b'optimize_scan: 1\n'), context(), complete_read(OPTIONS))

    def test_other_source_context_is_rejected(self):
        other = replace(context(), observation_id='b' * 64, dev_minor=1, sb_id='loop1')
        with self.assertRaises(E.Rejected):
            E.mb_summary(complete_read(SUMMARY, other), context(), complete_read(OPTIONS))

    def test_explicit_options_must_match_the_direct_bit(self):
        matching = OPTIONS[:-1] + b',mb_optimize_scan=1\n'
        self.assertEqual(E.mb_summary(complete_read(SUMMARY), context(),
                                     complete_read(matching)).value.optimize_scan, 1)
        for value in (b'0', b'2', b'01', b'', b'-1'):
            with self.subTest(value=value), self.assertRaises(E.Rejected):
                E.mb_summary(complete_read(SUMMARY), context(),
                             complete_read(OPTIONS[:-1] + b',mb_optimize_scan=' + value + b'\n'))

    def test_full_grammar_rejects_unknown_duplicate_truncated_and_overflow(self):
        rows = SUMMARY.splitlines(keepends=True)
        vectors = {
            'bit': SUMMARY.replace(b'optimize_scan: 1', b'optimize_scan: 2'),
            'missing-last-lf': SUMMARY[:-1], 'missing-row': b''.join(rows[:-1]),
            'duplicate-row': b''.join(rows[:3] + rows[2:]),
            'reordered': b''.join(rows[:2] + rows[3:4] + rows[2:3] + rows[4:]),
            'unknown-line': SUMMARY + b'future: 0\n',
            'duplicate-header': SUMMARY + rows[0], 'nul': SUMMARY + b'\0',
            'non-ascii': SUMMARY.replace(b'groups: 2', b'groups: \xff'),
            'leading-zero': SUMMARY.replace(b'groups: 2', b'groups: 02'),
            'negative': SUMMARY.replace(b'groups: 2', b'groups: -1'),
            'overflow': SUMMARY.replace(b'groups: 2', b'groups: 4294967296'),
            'wrong-indent': SUMMARY.replace(b'\tlist_order_1_', b' list_order_1_'),
            'crlf': SUMMARY.replace(b'\n', b'\r\n'),
            'bytes-budget': b'x' * 16385, 'line-budget': b'x' * 1025 + b'\n',
            'lines-budget': b'\n' * 257,
        }
        for name, raw in vectors.items():
            with self.subTest(name=name), self.assertRaises(E.Rejected):
                E.mb_summary(complete_read(raw), context(), complete_read(OPTIONS))
        max_count = SUMMARY.replace(b'groups: 2', b'groups: 4294967295')
        self.assertEqual(E.mb_summary(complete_read(max_count), context(),
                                     complete_read(OPTIONS)).value.max_free_groups[1], 4294967295)

    def test_completion_data_must_be_consistent_and_not_truthy_substitutes(self):
        record = complete_read(SUMMARY)
        vectors = ({'bytes_read': len(SUMMARY) - 1}, {'bytes_read': True},
                   {'read_rc': -1, 'errno': 5}, {'read_rc': 1}, {'read_rc': False},
                   {'errno': True}, {'eof': False}, {'eof': 1},
                   {'close_rc': -1, 'close_errno': 5}, {'close_rc': False},
                   {'close_errno': 5}, {'native_finished': False}, {'native_finished': 1})
        for change in vectors:
            with self.subTest(change=change), self.assertRaises(E.Rejected):
                E.mb_summary(replace(record, **change), context(), complete_read(OPTIONS))

    def test_every_context_component_is_bound_without_claiming_a_live_fd(self):
        changes = {'observation_id': 'b' * 64, 'phase': 'after', 'pid': 102,
                   'pid_namespace': 42, 'mount_namespace': 43, 'source_fd': 10,
                   'dev_major': 8, 'dev_minor': 1, 'mount_id': 32, 'sb_id': 'loop1',
                   'block_size': 1024}
        for field, value in changes.items():
            with self.subTest(field=field), self.assertRaises(E.Rejected):
                E.mb_summary(complete_read(SUMMARY, replace(context(), **{field: value})),
                             context(), complete_read(OPTIONS))
        for ctx in (replace(context(), pid=True), replace(context(), sb_id='..'),
                    replace(context(), observation_id='short'), replace(context(), mount_id=0),
                    replace(context(), block_size=4096.0)):
            with self.subTest(context=ctx), self.assertRaises(E.Rejected):
                E.mb_summary(complete_read(SUMMARY, ctx), ctx, complete_read(OPTIONS, ctx))
        with self.assertRaises(E.Rejected):
            E.mb_summary(complete_read(SUMMARY), context(),
                         complete_read(OPTIONS, replace(context(), dev_minor=1)))

    def test_missing_or_unknown_options_are_not_normalized(self):
        for raw in (OPTIONS.replace(b'acl,', b''), OPTIONS[:-1] + b',future=1\n',
                    OPTIONS[:-1] + b',acl\n', OPTIONS.replace(b'commit=5', b'commit=6'),
                    OPTIONS[:-1], OPTIONS + b'\n', OPTIONS.replace(b',', b'\n', 1)):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected):
                E.mb_summary(complete_read(SUMMARY), context(), complete_read(raw))


def priority_call(raw=0x403b, **changes):
    values = dict(context=context(), which=1, who=341, raw_value=raw,
                  errno=0, native_finished=True)
    values.update(changes)
    return E.IoprioCall(**values)


class JournalPriorityControls(unittest.TestCase):
    def test_full_raw_class_hint_level_is_preserved_but_task_identity_is_unproven(self):
        before = after = complete_read(b'341\n')
        result = E.journal_priority(before, priority_call(), after, context())
        self.assertEqual((result.value.pid, result.value.raw, result.value.priority_class,
                          result.value.hint, result.value.level), (341, 0x403b, 2, 7, 3))
        self.assertEqual(result.status, 'UNSUPPORTED')
        self.assertEqual(result.reason, 'JOURNAL_TASK_IDENTITY_UNPROVEN')
        self.assertEqual(result.qualification, 'UNSUPPORTED')
        self.assertFalse(result.production_supported)
        same_level = E.journal_priority(before, priority_call(0x4003), after, context())
        self.assertEqual(same_level.value.level, result.value.level)
        self.assertNotEqual(same_level.value.raw, result.value.raw)
        self.assertEqual(same_level.value.hint, 0)
        for raw, fields in ((0x200f, (1, 1, 7)), (0x6000, (3, 0, 0))):
            result = E.journal_priority(before, priority_call(raw), after, context())
            self.assertEqual((result.value.priority_class, result.value.hint, result.value.level), fields)
            self.assertFalse(result.production_supported)

    def test_invisible_or_invalid_task_never_falls_back_to_self(self):
        for raw in (b'0\n', b'<none>\n', b'-1\n', b'01\n', b'', b'341',
                    b'341\n342\n', b'2147483648\n', b'9' * 200 + b'\n'):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(complete_read(raw), priority_call(who=0),
                                   complete_read(raw), context())
            self.assertEqual(caught.exception.code, 'JOURNAL_TASK_NOT_VISIBLE')

    def test_none_unknown_class_hint_overflow_and_truthy_values_are_not_defaults(self):
        before = after = complete_read(b'341\n')
        for raw in (0, 3, 0x8000, 0xa000, 0xc000, 0xe000, 0x4043,
                    0xffff, 65536, -1, True, '16387', 16387.0):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(before, priority_call(raw), after, context())
            self.assertEqual(caught.exception.code, 'IOPRIO_VALUE_UNSUPPORTED')

    def test_errno_is_kept_and_no_fallback_is_possible(self):
        for errno in (1, 3, 5, 38):
            with self.subTest(errno=errno), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(complete_read(b'341\n'), priority_call(-1, errno=errno),
                                   complete_read(b'341\n'), context())
            self.assertEqual((caught.exception.code, caught.exception.status, caught.exception.errno),
                             ('GETTER_UNAVAILABLE', 'FAILED', errno))

    def test_syscall_target_and_readback_context_must_match(self):
        before = after = complete_read(b'341\n')
        changes = ({'which': 0}, {'which': 2}, {'which': True}, {'who': 0},
                   {'who': 342}, {'who': True}, {'errno': False},
                   {'native_finished': False}, {'native_finished': 1},
                   {'context': replace(context(), pid=102)},
                   {'context': replace(context(), pid_namespace=43)},
                   {'context': replace(context(), mount_namespace=44)},
                   {'context': replace(context(), phase='after')})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(E.Rejected):
                E.journal_priority(before, priority_call(**change), after, context())
        for after in (complete_read(b'342\n'), complete_read(b'0\n'),
                      complete_read(b'341\n', replace(context(), source_fd=10)),
                      replace(complete_read(b'341\n'), close_rc=-1, close_errno=5)):
            with self.subTest(after=after), self.assertRaises(E.Rejected):
                E.journal_priority(before, priority_call(), after, context())


def tune_call(features=(60, 710, 1131), **changes):
    # Synthetic ABI bytes for a field parser, never a GET_TUNE receipt.
    raw = bytearray(232)
    struct.pack_into('<III', raw, 64, *features)
    values = dict(context=context(), raw=bytes(raw), rc=0, errno=0, native_finished=True)
    values.update(changes)
    return E.TuneCall(**values)


def mapping_claim():
    # Declared exact provenance for parser tests, not a trusted build attestation.
    return E.MappingClaim(
        context=context(), sysname='Linux', machine='x86_64', release='7.0.0-1017-azure',
        version='#17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026',
        package='7.0.0-1017.17~24.04.1', fs_encryption='y',
        config_sha256='59b49d17af9e7049b5d1c0de5451d8afbeac39420b5086bfaa39f16cd1dec10b',
        kernel_notes_sha256='d0dbc2744ebce79f09543c87f4659b3ca605c626d4295531212207a5ad5f5960',
        source_hashes=(
            ('fs/ext4/super.c', '4916dc9690597e0de3e41f0dc957569848135185495302decf77abcfd0b5bdb5'),
            ('fs/ext4/sysfs.c', 'de6e820d406ed3e4efee70d65fd7e92dcf99533ecf872ced8279ccd362a18fd3'),
            ('fs/ext4/crypto.c', '469f0be09a47a8397ebdca1d5e994fe9c915c1120fd99d7bfbe171b4bc5bf34b'),
            ('fs/crypto/policy.c', 'f899b08d7084fd53ff110bef7434cca0d1b288aef71d2b9f57c0a82de4cd1931'),
            ('fs/crypto/hooks.c', '021fd5d0907d57027e5aef8d4489594810a1bb47c33f3020c9137ff884f4124e'),
            ('fs/ext4/ext4.h', 'aab5665c718bcc34ebca96edd64646d9a006817faddf007c9813bd012c90068b'),
        ))


class DummyPolicyControls(unittest.TestCase):
    def test_omission_only_matches_the_narrow_declared_source_conditions(self):
        result = E.dummy_omission(complete_read(OPTIONS), tune_call(), mapping_claim(), context())
        self.assertEqual(result.value.feature_masks, (60, 710, 1131))
        self.assertEqual(result.value.interpretation, 'ABSENCE_CONDITION_MATCHED')
        self.assertEqual(result.reason, 'CONDITIONAL_SOURCE_MAPPING_ONLY')
        self.assertEqual(result.qualification, 'UNSUPPORTED')
        self.assertFalse(result.production_supported)

    def test_encrypt_unknown_or_changed_features_are_rejected(self):
        for features in ((60, 710 | 0x10000, 1131), (60 | 0x80000000, 710, 1131),
                         (60, 710 | 0x80000000, 1131), (60, 710, 1131 | 0x80000000),
                         (60, 710, 0), (0, 0, 0)):
            with self.subTest(features=features), self.assertRaises(E.Rejected):
                E.dummy_omission(complete_read(OPTIONS), tune_call(features), mapping_claim(), context())

    def test_token_and_unknown_options_cannot_be_omission(self):
        for raw in (OPTIONS[:-1] + b',test_dummy_encryption=v2\n',
                    OPTIONS[:-1] + b',test_dummy_encryption\n',
                    OPTIONS[:-1] + b',future=1\n', OPTIONS.replace(b'journal_checksum,', b'')):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected):
                E.dummy_omission(complete_read(raw), tune_call(), mapping_claim(), context())

    def test_provenance_must_be_exact_and_complete_without_unknown_helpers(self):
        claim = mapping_claim()
        for field in ('sysname', 'machine', 'release', 'version', 'package', 'fs_encryption',
                      'config_sha256', 'kernel_notes_sha256'):
            with self.subTest(field=field), self.assertRaises(E.Rejected):
                E.dummy_omission(complete_read(OPTIONS), tune_call(),
                                 replace(claim, **{field: 'unknown'}), context())
        sources = claim.source_hashes
        vectors = (sources[:-1], sources + (('unknown.c', 'a' * 64),), sources + sources[:1],
                   (('fs/ext4/super.c', 'a' * 64),) + sources[1:],
                   list(sources), (('malformed',),) + sources[1:])
        for sources in vectors:
            with self.subTest(sources=sources), self.assertRaises(E.Rejected):
                E.dummy_omission(complete_read(OPTIONS), tune_call(),
                                 replace(claim, source_hashes=sources), context())

    def test_live_features_mapping_and_options_must_use_this_source_phase(self):
        other = replace(context(), observation_id='b' * 64, phase='after', source_fd=10)
        trials = (
            (complete_read(OPTIONS, other), tune_call(), mapping_claim()),
            (complete_read(OPTIONS), tune_call(context=other), mapping_claim()),
            (complete_read(OPTIONS), tune_call(), replace(mapping_claim(), context=other)),
        )
        for options, tune, mapping in trials:
            with self.subTest(tune=tune), self.assertRaises(E.Rejected):
                E.dummy_omission(options, tune, mapping, context())
        for change in ({'rc': -1, 'errno': 5}, {'rc': False}, {'errno': True},
                       {'raw': bytes(231)}, {'raw': bytes(233)},
                       {'native_finished': False}, {'native_finished': 1}):
            with self.subTest(change=change), self.assertRaises(E.Rejected):
                E.dummy_omission(complete_read(OPTIONS), tune_call(**change), mapping_claim(), context())


if __name__ == '__main__':
    unittest.main()

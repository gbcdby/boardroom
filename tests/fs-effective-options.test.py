#!/usr/bin/env python3
"""Synthetic parser controls only; no new ordinary getter or qualification run."""
from dataclasses import FrozenInstanceError, astuple, replace
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


def complete_read(raw, ctx=None, *, source, slot):
    return E.Read(context=ctx or context(), raw=raw, bytes_read=len(raw),
                  read_rc=0, errno=0, eof=True, close_rc=0, close_errno=0,
                  native_finished=True, source=source, slot=slot)


def summary_read(raw, ctx=None):
    return complete_read(raw, ctx, source='ext4_mb_structs_summary', slot='single')


def options_read(raw, ctx=None):
    return complete_read(raw, ctx, source='ext4_proc_options', slot='single')


def journal_before_read(raw, ctx=None):
    return complete_read(raw, ctx, source='ext4_journal_task', slot='journal-before')


def journal_after_read(raw, ctx=None):
    return complete_read(raw, ctx, source='ext4_journal_task', slot='journal-after')


# The old run's 27-option shape, copied as a synthetic parser vector. It is not
# a fresh kernel observation or an accepted effective-options provider profile.
LEGACY_COMMA_OPTIONS = (b'rw,bsddf,nogrpid,resuid=0,resgid=0,errors=remount-ro,user_xattr,acl,'
           b'noquota,barrier,commit=5,data=ordered,inode_readahead_blks=32,'
           b'init_itable=10,min_batch_time=0,max_batch_time=15000,stripe=0,'
           b'delalloc,block_validity,auto_da_alloc,dioread_nolock,nodiscard,'
           b'max_dir_size_kb=0,journal_checksum,nowarn_on_error,'
           b'prefetch_block_bitmaps,i_version\n')

# Literal proc/options shape from the pinned vendor show routine, with supplied
# research values. This is not a live kernel observation.
OPTIONS_LF = b'''rw
bsddf
nogrpid
resuid=0
resgid=0
errors=remount-ro
user_xattr
acl
noquota
barrier
commit=5
data=ordered
inode_readahead_blks=32
init_itable=10
min_batch_time=0
max_batch_time=15000
stripe=0
delalloc
block_validity
auto_da_alloc
dioread_nolock
nodiscard
max_dir_size_kb=0
journal_checksum
nowarn_on_error
prefetch_block_bitmaps
i_version
'''


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
        observed = E.mb_summary(summary_read(SUMMARY), context(), options_read(OPTIONS_LF))
        self.assertEqual(observed.value.optimize_scan, 1)
        self.assertEqual(observed.value.max_free_groups, (0, 2) + (0,) * 11 + (1,))
        self.assertEqual(observed.value.avg_fragment_groups, (0, 0, 3) + (0,) * 11)
        self.assertEqual(observed.status, 'PARSED_SUPPLIED')
        self.assertEqual(observed.qualification, 'UNSUPPORTED')
        self.assertFalse(observed.production_supported)
        disabled = E.mb_summary(summary_read(SUMMARY.replace(b'optimize_scan: 1',
                                                            b'optimize_scan: 0')), context(),
                                options_read(OPTIONS_LF))
        self.assertEqual(disabled.value.optimize_scan, 0)

    def test_header_alone_is_not_a_complete_getter(self):
        with self.assertRaises(E.Rejected):
            E.mb_summary(summary_read(b'optimize_scan: 1\n'), context(), options_read(OPTIONS_LF))

    def test_other_source_context_is_rejected(self):
        other = replace(context(), observation_id='b' * 64, dev_minor=1, sb_id='loop1')
        with self.assertRaises(E.Rejected):
            E.mb_summary(summary_read(SUMMARY, other), context(), options_read(OPTIONS_LF))

    def test_explicit_options_must_match_the_direct_bit(self):
        matching = OPTIONS_LF + b'mb_optimize_scan=1\n'
        self.assertEqual(E.mb_summary(summary_read(SUMMARY), context(),
                                     options_read(matching)).value.optimize_scan, 1)
        for value in (b'0', b'2', b'01', b'', b'-1'):
            with self.subTest(value=value), self.assertRaises(E.Rejected):
                E.mb_summary(summary_read(SUMMARY), context(),
                             options_read(OPTIONS_LF + b'mb_optimize_scan=' + value + b'\n'))

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
                E.mb_summary(summary_read(raw), context(), options_read(OPTIONS_LF))
        max_count = SUMMARY.replace(b'groups: 2', b'groups: 4294967295')
        self.assertEqual(E.mb_summary(summary_read(max_count), context(),
                                     options_read(OPTIONS_LF)).value.max_free_groups[1], 4294967295)

    def test_completion_data_must_be_consistent_and_not_truthy_substitutes(self):
        record = summary_read(SUMMARY)
        vectors = ({'bytes_read': len(SUMMARY) - 1}, {'bytes_read': True},
                   {'read_rc': -1, 'errno': 5}, {'read_rc': 1}, {'read_rc': False},
                   {'errno': True}, {'eof': False}, {'eof': 1},
                   {'close_rc': -1, 'close_errno': 5}, {'close_rc': False},
                   {'close_errno': 5}, {'native_finished': False}, {'native_finished': 1})
        for change in vectors:
            with self.subTest(change=change), self.assertRaises(E.Rejected):
                E.mb_summary(replace(record, **change), context(), options_read(OPTIONS_LF))

    def test_every_context_component_is_bound_without_claiming_a_live_fd(self):
        changes = {'observation_id': 'b' * 64, 'phase': 'after', 'pid': 102,
                   'pid_namespace': 42, 'mount_namespace': 43, 'source_fd': 10,
                   'dev_major': 8, 'dev_minor': 1, 'mount_id': 32, 'sb_id': 'loop1',
                   'block_size': 1024}
        for field, value in changes.items():
            with self.subTest(field=field), self.assertRaises(E.Rejected):
                E.mb_summary(summary_read(SUMMARY, replace(context(), **{field: value})),
                             context(), options_read(OPTIONS_LF))
        for ctx in (replace(context(), pid=True), replace(context(), sb_id='..'),
                    replace(context(), observation_id='short'), replace(context(), mount_id=0),
                    replace(context(), block_size=4096.0)):
            with self.subTest(context=ctx), self.assertRaises(E.Rejected):
                E.mb_summary(summary_read(SUMMARY, ctx), ctx, options_read(OPTIONS_LF, ctx))
        with self.assertRaises(E.Rejected):
            E.mb_summary(summary_read(SUMMARY), context(),
                         options_read(OPTIONS_LF, replace(context(), dev_minor=1)))

    def test_proc_options_requires_complete_lf_source_grammar(self):
        vectors = (
            LEGACY_COMMA_OPTIONS,
            OPTIONS_LF.replace(b'\n', b',', 1),
            OPTIONS_LF.replace(b'\n', b'\r\n'),
            OPTIONS_LF + b'\n', OPTIONS_LF[:-1],
            OPTIONS_LF.replace(b'acl\n', b'\n'),
            OPTIONS_LF.replace(b'acl\n', b'acl\0\n'),
            OPTIONS_LF.replace(b'acl\n', b'\xff\n'),
            OPTIONS_LF.replace(b'acl\n', b' acl\n'),
            OPTIONS_LF.replace(b'rw\nbsddf\n', b'bsddf\nrw\n'),
            b'rw\n' + b'x' * 1025 + b'\n',
            b'rw\n' + b'acl\n' * 256,
        )
        for raw in vectors:
            with self.subTest(raw=raw), self.assertRaises(E.Rejected) as caught:
                E.mb_summary(summary_read(SUMMARY), context(), options_read(raw))
            self.assertEqual((caught.exception.code, caught.exception.status),
                             ('OPTION_SHAPE_UNSUPPORTED', 'UNSUPPORTED'))

    def test_missing_or_unknown_options_are_not_normalized(self):
        for raw in (OPTIONS_LF.replace(b'acl\n', b''), OPTIONS_LF + b'future=1\n',
                    OPTIONS_LF + b'acl\n', OPTIONS_LF.replace(b'commit=5', b'commit=6'),
                    OPTIONS_LF[:-1], OPTIONS_LF + b'\n', OPTIONS_LF.replace(b'\n', b',', 1)):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected):
                E.mb_summary(summary_read(SUMMARY), context(), options_read(raw))


def priority_call(raw=0x403b, **changes):
    values = dict(context=context(), which=1, who=341, raw_value=raw,
                  errno=0, native_finished=True)
    values.update(changes)
    return E.IoprioCall(**values)


class JournalPriorityControls(unittest.TestCase):
    def test_full_raw_class_hint_level_is_preserved_but_task_identity_is_unproven(self):
        before = journal_before_read(b'341\n')
        after = journal_after_read(b'341\n')
        result = E.journal_priority(before, priority_call(), after, context())
        self.assertEqual((result.value.pid, result.value.raw, result.value.priority_class,
                          result.value.hint, result.value.level), (341, 0x403b, 2, 7, 3))
        self.assertEqual(result.status, 'PARSED_SUPPLIED')
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
                E.journal_priority(journal_before_read(raw), priority_call(who=0),
                                   journal_after_read(raw), context())
            self.assertEqual(caught.exception.code, 'JOURNAL_TASK_NOT_VISIBLE')

    def test_complete_raw_bits_use_fixed_independent_value_domain_oracles(self):
        # Literal UAPI bit-layout oracles, not values generated by the parser.
        vectors = (
            (0x0000, 0, 0, 0, 'NONE_ZERO', None),
            (0x0003, 0, 0, 3, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0x0008, 0, 1, 0, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0x4003, 2, 0, 3, 'RT_BE_IDLE_HINT_0_7', None),
            (0x403b, 2, 7, 3, 'RT_BE_IDLE_HINT_0_7', None),
            (0x200f, 1, 1, 7, 'RT_BE_IDLE_HINT_0_7', None),
            (0x6000, 3, 0, 0, 'RT_BE_IDLE_HINT_0_7', None),
            (0x4043, 2, 8, 3, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0x8000, 4, 0, 0, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0xffff, 7, 1023, 7, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0xa000, 5, 0, 0, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0xc000, 6, 0, 0, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
            (0xe000, 7, 0, 0, 'UNSUPPORTED_BITS', 'IOPRIO_VALUE_UNSUPPORTED'),
        )
        before, after = journal_before_read(b'341\n'), journal_after_read(b'341\n')
        for raw, priority_class, hint, level, domain, reason in vectors:
            with self.subTest(raw=raw):
                result = E.journal_priority(before, priority_call(raw), after, context())
                value = result.value
                self.assertEqual((value.pid, value.raw, value.priority_class, value.hint,
                                  value.level, value.value_domain, value.value_reason),
                                 (341, raw, priority_class, hint, level, domain, reason))
                self.assertEqual(result.reason, 'JOURNAL_TASK_IDENTITY_UNPROVEN')
                self.assertEqual(result.qualification, 'UNSUPPORTED')
                self.assertFalse(result.production_supported)

    def test_out_of_range_and_truthy_values_are_not_priority_bits(self):
        before = journal_before_read(b'341\n')
        after = journal_after_read(b'341\n')
        for raw in (65536, -1, True, '16387', 16387.0):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(before, priority_call(raw), after, context())
            self.assertEqual(caught.exception.code, 'IOPRIO_VALUE_UNSUPPORTED')

    def test_errno_is_kept_and_no_fallback_is_possible(self):
        for errno in (1, 3, 5, 38):
            with self.subTest(errno=errno), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(journal_before_read(b'341\n'), priority_call(-1, errno=errno),
                                   journal_after_read(b'341\n'), context())
            self.assertEqual((caught.exception.code, caught.exception.status, caught.exception.errno),
                             ('GETTER_UNAVAILABLE', 'FAILED', errno))

    def test_syscall_target_and_readback_context_must_match(self):
        before = journal_before_read(b'341\n')
        after = journal_after_read(b'341\n')
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
        for after in (journal_after_read(b'342\n'), journal_after_read(b'0\n'),
                      journal_after_read(b'341\n', replace(context(), source_fd=10)),
                      replace(journal_after_read(b'341\n'), close_rc=-1, close_errno=5)):
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


def read_positions():
    ctx = context()
    summary, opts = summary_read(SUMMARY), options_read(OPTIONS_LF)
    before, after = journal_before_read(b'341\n'), journal_after_read(b'341\n')
    return (
        ('summary', summary, lambda r: E.mb_summary(r, ctx, opts)),
        ('summary-options', opts, lambda r: E.mb_summary(summary, ctx, r)),
        ('journal-before', before, lambda r: E.journal_priority(r, priority_call(), after, ctx)),
        ('journal-after', after, lambda r: E.journal_priority(before, priority_call(), r, ctx)),
        ('dummy-options', opts, lambda r: E.dummy_omission(r, tune_call(), mapping_claim(), ctx)),
    )


class ReadSourceControls(unittest.TestCase):
    def test_every_read_position_checks_supplied_source_before_parsing(self):
        for name, record, invoke in read_positions():
            for source in ('future', None, True, [], 1):
                with self.subTest(name=name, source=source), self.assertRaises(E.Rejected) as caught:
                    invoke(replace(record, source=source))
                self.assertEqual((caught.exception.code, caught.exception.status),
                                 ('READ_SOURCE_UNSUPPORTED', 'UNSUPPORTED'))
            with self.subTest(name=name), self.assertRaises(E.Rejected) as caught:
                invoke(replace(record, source='ext4_mb_groups'))
            self.assertEqual((caught.exception.code, caught.exception.status),
                             ('READ_SOURCE_MISMATCH', 'FAILED'))

    def test_every_read_position_checks_its_exact_slot(self):
        for name, record, invoke in read_positions():
            other = 'journal-after' if record.slot == 'journal-before' else 'journal-before'
            for slot in (other, 'future', None, True, [], 1):
                with self.subTest(name=name, slot=slot), self.assertRaises(E.Rejected) as caught:
                    invoke(replace(record, slot=slot))
                self.assertEqual((caught.exception.code, caught.exception.status),
                                 ('READ_SLOT_MISMATCH', 'FAILED'))

    def test_journal_before_after_cannot_reuse_or_exchange_slots(self):
        before, after = journal_before_read(b'341\n'), journal_after_read(b'341\n')
        for left, right in ((before, before), (after, after), (after, before)):
            with self.subTest(left=left.slot, right=right.slot), self.assertRaises(E.Rejected) as caught:
                E.journal_priority(left, priority_call(), right, context())
            self.assertEqual(caught.exception.code, 'READ_SLOT_MISMATCH')

    def test_outer_after_phase_keeps_both_internal_journal_slots(self):
        ctx = replace(context(), phase='after')
        before = journal_before_read(b'341\n', ctx)
        after = journal_after_read(b'341\n', ctx)
        result = E.journal_priority(before, priority_call(context=ctx), after, ctx)
        self.assertEqual(result.value.raw, 0x403b)

    def test_context_precedes_tags_and_tags_precede_bytes(self):
        record = summary_read(SUMMARY)
        other = replace(context(), observation_id='b' * 64)
        vectors = (
            (replace(record, context=other, source='future'), 'SOURCE_BINDING_MISMATCH', 'FAILED'),
            (replace(record, source='future', raw=None), 'READ_SOURCE_UNSUPPORTED', 'UNSUPPORTED'),
            (replace(record, slot='future', raw=None), 'READ_SLOT_MISMATCH', 'FAILED'),
        )
        for supplied, code, status in vectors:
            with self.subTest(code=code), self.assertRaises(E.Rejected) as caught:
                E.mb_summary(supplied, context(), options_read(OPTIONS_LF))
            self.assertEqual((caught.exception.code, caught.exception.status), (code, status))


class DummyPolicyControls(unittest.TestCase):
    def test_omission_only_matches_the_narrow_declared_source_conditions(self):
        result = E.dummy_omission(options_read(OPTIONS_LF), tune_call(), mapping_claim(), context())
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
                E.dummy_omission(options_read(OPTIONS_LF), tune_call(features), mapping_claim(), context())

    def test_token_and_unknown_options_cannot_be_omission(self):
        for raw in (OPTIONS_LF + b'test_dummy_encryption=v1\n',
                    OPTIONS_LF + b'test_dummy_encryption=v2\n',
                    OPTIONS_LF + b'test_dummy_encryption=v3\n',
                    OPTIONS_LF + b'test_dummy_encryption\n',
                    OPTIONS_LF + b'future=1\n', OPTIONS_LF.replace(b'journal_checksum\n', b'')):
            with self.subTest(raw=raw), self.assertRaises(E.Rejected):
                E.dummy_omission(options_read(raw), tune_call(), mapping_claim(), context())

    def test_provenance_must_be_exact_and_complete_without_unknown_helpers(self):
        claim = mapping_claim()
        for field in ('sysname', 'machine', 'release', 'version', 'package', 'fs_encryption',
                      'config_sha256', 'kernel_notes_sha256'):
            with self.subTest(field=field), self.assertRaises(E.Rejected):
                E.dummy_omission(options_read(OPTIONS_LF), tune_call(),
                                 replace(claim, **{field: 'unknown'}), context())
        sources = claim.source_hashes
        vectors = (sources[:-1], sources + (('unknown.c', 'a' * 64),), sources + sources[:1],
                   (('fs/ext4/super.c', 'a' * 64),) + sources[1:],
                   list(sources), (('malformed',),) + sources[1:])
        for sources in vectors:
            with self.subTest(sources=sources), self.assertRaises(E.Rejected):
                E.dummy_omission(options_read(OPTIONS_LF), tune_call(),
                                 replace(claim, source_hashes=sources), context())

    def test_live_features_mapping_and_options_must_use_this_source_phase(self):
        other = replace(context(), observation_id='b' * 64, phase='after', source_fd=10)
        trials = (
            (options_read(OPTIONS_LF, other), tune_call(), mapping_claim()),
            (options_read(OPTIONS_LF), tune_call(context=other), mapping_claim()),
            (options_read(OPTIONS_LF), tune_call(), replace(mapping_claim(), context=other)),
        )
        for options, tune, mapping in trials:
            with self.subTest(tune=tune), self.assertRaises(E.Rejected):
                E.dummy_omission(options, tune, mapping, context())
        for change in ({'rc': -1, 'errno': 5}, {'rc': False}, {'errno': True},
                       {'raw': bytes(231)}, {'raw': bytes(233)},
                       {'native_finished': False}, {'native_finished': 1}):
            with self.subTest(change=change), self.assertRaises(E.Rejected):
                E.dummy_omission(options_read(OPTIONS_LF), tune_call(**change), mapping_claim(), context())


class ReadCompletionControls(unittest.TestCase):
    def test_each_read_position_preserves_all_common_failure_checks(self):
        # One changed fact per vector; these are failures of supplied records,
        # not evidence that an actual kernel read/close was performed.
        for name, record, invoke in read_positions():
            format_error = ('FORMAT_OR_BUDGET_EXCEEDED', 'UNSUPPORTED', None)
            vectors = (
                ({'raw': None}, format_error),
                ({'raw': bytearray(record.raw)}, format_error),
                ({'raw': b'x' * 16385, 'bytes_read': 16385}, format_error),
                ({'bytes_read': len(record.raw) - 1}, format_error),
                ({'bytes_read': True}, format_error),
                ({'bytes_read': -1}, format_error),
                ({'read_rc': False}, format_error),
                ({'read_rc': 1}, ('GETTER_UNAVAILABLE', 'FAILED', 0)),
                ({'read_rc': -1, 'errno': 5}, ('GETTER_UNAVAILABLE', 'FAILED', 5)),
                ({'errno': True}, format_error),
                ({'errno': 4096}, format_error),
                ({'eof': False}, ('INCOMPLETE_READ', 'FAILED', None)),
                ({'eof': 1}, ('INCOMPLETE_READ', 'FAILED', None)),
                ({'close_rc': False}, format_error),
                ({'close_rc': -1, 'close_errno': 5}, ('CLOSE_FAILED', 'FAILED', 5)),
                ({'close_errno': 5}, ('CLOSE_FAILED', 'FAILED', 5)),
                ({'close_errno': True}, format_error),
                ({'native_finished': False}, ('NATIVE_NOT_FINISHED', 'FAILED', None)),
                ({'native_finished': 1}, ('NATIVE_NOT_FINISHED', 'FAILED', None)),
                ({'context': replace(context(), pid=True)},
                 ('SOURCE_BINDING_MISMATCH', 'UNSUPPORTED', None)),
                ({'context': replace(context(), phase='after')},
                 ('SOURCE_BINDING_MISMATCH', 'FAILED', None)),
                ({'context': replace(context(), block_size=1024)},
                 ('BLOCK_LAYOUT_UNSUPPORTED', 'UNSUPPORTED', None)),
            )
            for change, expected in vectors:
                damaged = replace(record, **change)
                original = astuple(damaged)
                with self.subTest(name=name, change=change), self.assertRaises(E.Rejected) as caught:
                    invoke(damaged)
                self.assertEqual((caught.exception.code, caught.exception.status,
                                  caught.exception.errno), expected)
                self.assertEqual(astuple(damaged), original)

    def test_each_position_rejects_non_records_and_record_subclasses(self):
        class OtherRead(E.Read):
            pass
        for name, record, invoke in read_positions():
            for supplied in (None, object(), OtherRead(**vars(record))):
                with self.subTest(name=name, supplied=type(supplied)), self.assertRaises(E.Rejected) as caught:
                    invoke(supplied)
                self.assertEqual((caught.exception.code, caught.exception.status),
                                 ('FORMAT_OR_BUDGET_EXCEEDED', 'UNSUPPORTED'))


def supplied_observation_cases():
    ctx = context()
    summary, opts = summary_read(SUMMARY), options_read(OPTIONS_LF)
    before, call, after = journal_before_read(b'341\n'), priority_call(0xffff), journal_after_read(b'341\n')
    tune, mapping = tune_call(), mapping_claim()
    calls = (
        ('summary', (summary, opts), lambda: E.mb_summary(summary, ctx, opts),
         'RUNTIME_QUALIFICATION_NOT_RUN'),
        ('journal', (before, call, after), lambda: E.journal_priority(before, call, after, ctx),
         'JOURNAL_TASK_IDENTITY_UNPROVEN'),
        ('dummy', (opts, tune, mapping), lambda: E.dummy_omission(opts, tune, mapping, ctx),
         'CONDITIONAL_SOURCE_MAPPING_ONLY'),
    )
    result = []
    for name, supplied, invoke, reason in calls:
        original_values = tuple(astuple(record) for record in supplied)
        result.append((name, invoke(), supplied, original_values, reason))
    return result


class SuppliedObservationControls(unittest.TestCase):
    def test_every_success_is_only_supplied_parsing_with_its_original_reason(self):
        for name, result, supplied, original_values, reason in supplied_observation_cases():
            with self.subTest(name=name):
                self.assertEqual(result.status, 'PARSED_SUPPLIED')
                self.assertEqual(result.reason, reason)
                self.assertEqual(result.qualification, 'UNSUPPORTED')
                self.assertIs(result.production_supported, False)
                self.assertEqual(tuple(astuple(record) for record in supplied), original_values)

    def test_supplied_inputs_keep_original_records_bytes_and_order(self):
        for name, result, supplied, original_values, reason in supplied_observation_cases():
            with self.subTest(name=name):
                self.assertIs(type(result.supplied_inputs), tuple)
                self.assertEqual(len(result.supplied_inputs), len(supplied))
                for actual, original in zip(result.supplied_inputs, supplied):
                    self.assertIs(actual, original)
                    if type(original) in (E.Read, E.TuneCall):
                        self.assertIs(actual.raw, original.raw)
                self.assertEqual(tuple(astuple(record) for record in supplied), original_values)
                if name == 'journal':
                    self.assertEqual(result.supplied_inputs[1].raw_value, 0xffff)
                    self.assertEqual(result.value.value_domain, 'UNSUPPORTED_BITS')

    def test_fixed_status_and_qualification_cannot_be_constructor_overrides(self):
        result = supplied_observation_cases()[0][1]
        for field, forged in (('status', 'OBSERVED'), ('qualification', 'QUALIFIED'),
                              ('production_supported', True)):
            with self.subTest(field=field):
                with self.assertRaises(TypeError):
                    E.Observation(result.value, result.supplied_inputs, **{field: forged})
                with self.assertRaises(ValueError):
                    replace(result, **{field: forged})
                with self.assertRaises(FrozenInstanceError):
                    setattr(result, field, forged)


if __name__ == '__main__':
    unittest.main()

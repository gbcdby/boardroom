"""Private, pure parsers for the exact-vendor M02 D1 investigation.

Inputs are supplied data, including completion and source-context claims. Checking
their consistency does not attest a live read, held FD, kernel build, task lease,
or bounded native execution. This module has no reader, bridge, matcher, registry,
CLI, or production caller. Every result keeps qualification UNSUPPORTED.

Grammar: Linux Azure 7.0.0-1017.17~24.04.1, fs/ext4/mballoc.c
ff5c47fbbbe353356752b7f0628abe06ebdacadfbdb803fd90d853447b53892f;
MB_NUM_ORDERS: mballoc.h 86d89a6d13d038a9c2e1429d59bc23b64317771f3166c2eb70e237d3f0b1b588.
IOPRIO UAPI: b9fbd261e2893ae568f08414300cfd8f9b1cfcd7fd83c706c81b2b0eaeda61c6;
block/ioprio.c: f33e815ba09ca96e05dcf565fb244ed97bfb27a767adb41c30ef4ecec20366e5.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import re
from typing import Generic, TypeVar
from native import Invalid, TARGET, decode_tune, options


# The old 27-option observation is a narrow diagnostic shape, not an exhaustive
# or accepted profile. No defaults, provider selection, or runtime matching.
_OPTION_SHAPE = (
    ('rw', True), ('bsddf', True), ('nogrpid', True), ('resuid', '0'), ('resgid', '0'),
    ('errors', 'remount-ro'), ('user_xattr', True), ('acl', True), ('noquota', True),
    ('barrier', True), ('commit', '5'), ('data', 'ordered'),
    ('inode_readahead_blks', '32'), ('init_itable', '10'), ('min_batch_time', '0'),
    ('max_batch_time', '15000'), ('stripe', '0'), ('delalloc', True),
    ('block_validity', True), ('auto_da_alloc', True), ('dioread_nolock', True),
    ('nodiscard', True), ('max_dir_size_kb', '0'), ('journal_checksum', True),
    ('nowarn_on_error', True), ('prefetch_block_bitmaps', True), ('i_version', True),
)

# Static source-mapping basis only. These hashes are not qualified build entries;
# comparing supplied claims does not verify the artifacts or trust their origin.
_DUMMY_SOURCE_HASHES = (
    ('fs/ext4/super.c', '4916dc9690597e0de3e41f0dc957569848135185495302decf77abcfd0b5bdb5'),
    ('fs/ext4/sysfs.c', 'de6e820d406ed3e4efee70d65fd7e92dcf99533ecf872ced8279ccd362a18fd3'),
    ('fs/ext4/crypto.c', '469f0be09a47a8397ebdca1d5e994fe9c915c1120fd99d7bfbe171b4bc5bf34b'),
    ('fs/crypto/policy.c', 'f899b08d7084fd53ff110bef7434cca0d1b288aef71d2b9f57c0a82de4cd1931'),
    ('fs/crypto/hooks.c', '021fd5d0907d57027e5aef8d4489594810a1bb47c33f3020c9137ff884f4124e'),
    ('fs/ext4/ext4.h', 'aab5665c718bcc34ebca96edd64646d9a006817faddf007c9813bd012c90068b'),
)


class Rejected(ValueError):
    def __init__(self, code, *, status='UNSUPPORTED', errno=None):
        super().__init__(code)
        self.code, self.status, self.errno = code, status, errno


def require(ok, code='FORMAT_OR_BUDGET_EXCEEDED', *, status='UNSUPPORTED', errno=None):
    if not ok:
        raise Rejected(code, status=status, errno=errno)


@dataclass(frozen=True)
class Context:
    # The original observation digest is an association label, not a new identity.
    observation_id: str
    phase: str
    pid: int
    pid_namespace: int
    mount_namespace: int
    source_fd: int
    dev_major: int
    dev_minor: int
    mount_id: int
    sb_id: str
    block_size: int


@dataclass(frozen=True)
class Read:
    context: Context
    raw: bytes
    bytes_read: int
    read_rc: int  # Final read: zero only when EOF was actually reported.
    errno: int
    eof: bool
    close_rc: int
    close_errno: int
    native_finished: bool


@dataclass(frozen=True)
class IoprioCall:
    context: Context
    which: int
    who: int
    raw_value: int
    errno: int
    native_finished: bool


@dataclass(frozen=True)
class TuneCall:
    context: Context
    raw: bytes
    rc: int
    errno: int
    native_finished: bool


@dataclass(frozen=True)
class MappingClaim:
    context: Context
    sysname: str
    machine: str
    release: str
    version: str
    package: str
    fs_encryption: str
    config_sha256: str
    kernel_notes_sha256: str
    source_hashes: tuple[tuple[str, str], ...]


T = TypeVar('T')


@dataclass(frozen=True)
class Observation(Generic[T]):
    value: T
    status: str = 'OBSERVED'
    reason: str = 'RUNTIME_QUALIFICATION_NOT_RUN'
    qualification: str = field(default='UNSUPPORTED', init=False)
    production_supported: bool = field(default=False, init=False)


@dataclass(frozen=True)
class MbSummary:
    optimize_scan: int
    # Counts are diagnostic only; never persistent identity or a group total.
    max_free_groups: tuple[int, ...]
    avg_fragment_groups: tuple[int, ...]


@dataclass(frozen=True)
class JournalPriority:
    pid: int  # This observation only; never a lease or persistent identity.
    raw: int
    priority_class: int
    hint: int
    level: int


@dataclass(frozen=True)
class DummyOmission:
    feature_masks: tuple[int, int, int]
    interpretation: str = field(default='ABSENCE_CONDITION_MATCHED', init=False)


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _context(actual, expected):
    for context in (actual, expected):
        require(type(context) is Context, 'SOURCE_BINDING_MISMATCH')
        require(type(context.observation_id) is str and
                re.fullmatch('[a-f0-9]{64}', context.observation_id) is not None and
                context.phase in ('before', 'after') and
                type(context.sb_id) is str and context.sb_id not in ('.', '..') and
                re.fullmatch('[A-Za-z0-9_.-]{1,31}', context.sb_id) is not None,
                'SOURCE_BINDING_MISMATCH')
        for value, low, high in ((context.pid, 1, 2**31 - 1),
                                 (context.pid_namespace, 1, 2**64 - 1),
                                 (context.mount_namespace, 1, 2**64 - 1),
                                 (context.source_fd, 0, 2**31 - 1),
                                 (context.dev_major, 0, 2**32 - 1),
                                 (context.dev_minor, 0, 2**32 - 1),
                                 (context.mount_id, 1, 2**64 - 1)):
            require(_integer(value, low, high), 'SOURCE_BINDING_MISMATCH')
        # Only the prior investigation's 4 KiB layout is parsed in this slice.
        # This is a syntax restriction, not an admitted kernel/profile list.
        require(type(context.block_size) is int and context.block_size == 4096,
                'BLOCK_LAYOUT_UNSUPPORTED')
    require(actual == expected, 'SOURCE_BINDING_MISMATCH', status='FAILED')


def _read(record, expected):
    require(type(record) is Read)
    _context(record.context, expected)
    require(type(record.raw) is bytes and len(record.raw) <= 16384 and
            _integer(record.bytes_read, 0, 16384) and record.bytes_read == len(record.raw))
    require(type(record.read_rc) is int and _integer(record.errno, 0, 4095))
    require(record.errno == 0 and record.read_rc == 0, 'GETTER_UNAVAILABLE',
            status='FAILED', errno=record.errno)
    require(record.eof is True, 'INCOMPLETE_READ', status='FAILED')
    require(type(record.close_rc) is int and _integer(record.close_errno, 0, 4095))
    require(record.close_rc == 0 and record.close_errno == 0,
            'CLOSE_FAILED', status='FAILED', errno=record.close_errno)
    require(record.native_finished is True, 'NATIVE_NOT_FINISHED', status='FAILED')
    return record.raw


def _options(record, expected):
    raw = _read(record, expected)
    require(raw.endswith(b'\n') and raw.count(b'\n') == 1 and b'\r' not in raw)
    try:
        parsed = options(raw)
    except Invalid:
        raise Rejected('OPTION_SHAPE_UNSUPPORTED') from None
    require({key: value for key, value in parsed.items() if key != 'mb_optimize_scan'} ==
            dict(_OPTION_SHAPE), 'OPTION_SHAPE_UNSUPPORTED')
    if 'mb_optimize_scan' in parsed:
        require(parsed['mb_optimize_scan'] in ('0', '1'), 'OPTION_SHAPE_UNSUPPORTED')
    return parsed


def mb_summary(record: Read, expected: Context,
               options_record: Read) -> Observation[MbSummary]:
    raw = _read(record, expected)
    current_options = _options(options_record, expected)
    require(raw.endswith(b'\n') and b'\0' not in raw)
    lines = raw[:-1].split(b'\n')
    require(len(lines) <= 256 and all(len(line) <= 1024 for line in lines))
    orders = expected.block_size.bit_length() - 1 + 2
    require(len(lines) == 3 + orders * 2 and lines[0] in
            (b'optimize_scan: 0', b'optimize_scan: 1'))
    counts = []
    for start, header in ((1, b'max_free_order_lists:'),
                          (orders + 2, b'avg_fragment_size_lists:')):
        require(lines[start] == header)
        values = []
        for index, line in enumerate(lines[start + 1:start + 1 + orders]):
            match = re.fullmatch(rb'\tlist_order_' + str(index).encode('ascii') +
                                 rb'_groups: (0|[1-9][0-9]{0,9})', line)
            require(match is not None)
            value = int(match[1])
            require(value <= 2**32 - 1)
            values.append(value)
        counts.append(tuple(values))
    bit = int(lines[0][-1:])
    if 'mb_optimize_scan' in current_options:
        require(current_options['mb_optimize_scan'] == str(bit),
                'EFFECTIVE_OPTION_MISMATCH', status='FAILED')
    return Observation(MbSummary(bit, counts[0], counts[1]))


def _journal_task(record, expected):
    raw = _read(record, expected)
    require(re.fullmatch(rb'[1-9][0-9]{0,9}\n', raw) is not None,
            'JOURNAL_TASK_NOT_VISIBLE')
    pid = int(raw[:-1])
    require(pid <= 2**31 - 1, 'JOURNAL_TASK_NOT_VISIBLE')
    return pid


def journal_priority(before: Read, call: IoprioCall, after: Read,
                     expected: Context) -> Observation[JournalPriority]:
    pid = _journal_task(before, expected)  # Never accept who=0 as a fallback.
    require(type(call) is IoprioCall)
    _context(call.context, expected)
    require(type(call.which) is int and call.which == 1 and
            type(call.who) is int and call.who == pid,
            'JOURNAL_TASK_NOT_VISIBLE')
    require(_integer(call.errno, 0, 4095))
    require(call.errno == 0, 'GETTER_UNAVAILABLE', status='FAILED', errno=call.errno)
    require(call.native_finished is True, 'NATIVE_NOT_FINISHED', status='FAILED')
    require(_journal_task(after, expected) == pid, 'CONTEXT_CHANGED', status='FAILED')
    require(_integer(call.raw_value, 0, 65535), 'IOPRIO_VALUE_UNSUPPORTED')
    # Exact UAPI: class bits 15..13, hint bits 12..3, level bits 2..0.
    # NONE/0 (also the missing-io_context result) is not mount default BE/3.
    # Unknown classes/hints stay unsupported instead of being masked away.
    priority_class = call.raw_value >> 13
    hint = (call.raw_value >> 3) & 1023
    level = call.raw_value & 7
    require(priority_class in (1, 2, 3) and hint <= 7, 'IOPRIO_VALUE_UNSUPPORTED')
    value = JournalPriority(pid, call.raw_value, priority_class, hint, level)
    # Equal PIDs and contexts are necessary consistency checks, never a task
    # lease. D0 has not closed the held-source -> journal task lifetime proof.
    return Observation(value, status='UNSUPPORTED', reason='JOURNAL_TASK_IDENTITY_UNPROVEN')


def _mapping_claim(claim, expected):
    require(type(claim) is MappingClaim, 'SOURCE_MAPPING_UNSUPPORTED')
    _context(claim.context, expected)
    required = dict(TARGET, package='7.0.0-1017.17~24.04.1', fs_encryption='y',
                    config_sha256='59b49d17af9e7049b5d1c0de5451d8afbeac39420b5086bfaa39f16cd1dec10b',
                    kernel_notes_sha256='d0dbc2744ebce79f09543c87f4659b3ca605c626d4295531212207a5ad5f5960')
    require(all(type(getattr(claim, key)) is str and getattr(claim, key) == value
                for key, value in required.items()), 'SOURCE_MAPPING_UNSUPPORTED')
    pairs = claim.source_hashes
    require(type(pairs) is tuple and len(pairs) == len(_DUMMY_SOURCE_HASHES) and
            all(type(pair) is tuple and len(pair) == 2 and
            all(type(item) is str for item in pair) for pair in pairs),
            'SOURCE_MAPPING_UNSUPPORTED')
    require(dict(pairs) == dict(_DUMMY_SOURCE_HASHES), 'SOURCE_MAPPING_UNSUPPORTED')


def dummy_omission(options_record: Read, tune: TuneCall, mapping: MappingClaim,
                   expected: Context) -> Observation[DummyOmission]:
    _options(options_record, expected)  # Unknown or present dummy token refuses.
    _mapping_claim(mapping, expected)
    require(type(tune) is TuneCall)
    _context(tune.context, expected)
    require(type(tune.rc) is int and _integer(tune.errno, 0, 4095))
    require(tune.rc == 0 and tune.errno == 0, 'GETTER_UNAVAILABLE',
            status='FAILED', errno=tune.errno)
    require(tune.native_finished is True, 'NATIVE_NOT_FINISHED', status='FAILED')
    require(type(tune.raw) is bytes and len(tune.raw) == 232)
    masks = tuple(decode_tune(tune.raw)['feature_masks'])
    # Only the old live-feature shape is mapped. No policy from persistent
    # defaults, missing data, an encrypt bit, or a different/unknown feature set.
    require(masks == (60, 710, 1131), 'FEATURE_MAPPING_UNSUPPORTED')
    return Observation(DummyOmission(masks), reason='CONDITIONAL_SOURCE_MAPPING_ONLY')

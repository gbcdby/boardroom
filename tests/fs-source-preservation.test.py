#!/usr/bin/env python3
"""新政策的离线控制；历史 FAIL 原件不充当新 profile 资格通过。"""
import gzip
import hashlib
import json
import copy
import os
from pathlib import Path
import struct
import sys
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPO / 'scripts/qualification/fs-source-preservation'))
import diagnostics as D
import window as W
import checks as C

FIXTURE = REPO / 'tests/fixtures/fs-source-preservation'


def originals():
    manifest = json.loads((FIXTURE / 'provenance.json').read_text())
    result = {}
    for name, record in manifest['files'].items():
        stored = (FIXTURE / name).read_bytes()
        assert hashlib.sha256(stored).hexdigest() == record['stored_sha256']
        raw = gzip.decompress(stored) if name.endswith('.gz') else stored
        assert len(raw) == record['raw_bytes']
        assert hashlib.sha256(raw).hexdigest() == record['raw_sha256']
        result[record['raw_file']] = raw
    return result


class DiagnosticControls(unittest.TestCase):
    def test_crc32c_known_vector(self):
        self.assertEqual(D.crc32c(b'123456789'), 0x1cf96d7c)

    def test_historical_single_sb_transaction(self):
        raw = originals()
        result = D.classify_diagnostic_transaction(
            raw['regular-journal-before.bin'], raw['regular-journal-after.bin'],
            raw['regular-pre.sb'], raw['regular-post.sb'], '/tmp/br4-_h18m1wv/r')
        self.assertEqual(result['status'], 'CLASSIFIED')
        self.assertEqual(result['transaction_id'], 6)
        self.assertEqual(result['changed_journal_blocks'], [0, 14, 15, 16])
        self.assertEqual(result['target_block'], 0)
        self.assertEqual(result['physical_device_zero_write'], False)
        self.assertEqual(result['production_supported'], False)
        self.assertEqual(result['qualified_kernel_builds'], [])

    def test_unknown_application_or_journal_changes_are_rejected(self):
        original = originals()
        cases = ('application', 'allocation', 'health', 'extra-journal', 'payload', 'descriptor', 'commit', 'wrong-mount')
        for case in cases:
            with self.subTest(case=case):
                raw = dict(original); mount = '/tmp/br4-_h18m1wv/r'
                if case in ('application', 'allocation', 'health'):
                    sb = bytearray(raw['regular-post.sb'])
                    sb[{'application': 104, 'allocation': 12, 'health': 0x194}[case]] ^= 1
                    struct.pack_into('<I', sb, 1020, D.crc32c(sb[:1020]))
                    raw['regular-post.sb'] = bytes(sb)
                elif case == 'wrong-mount':
                    mount = '/tmp/br4-_h18m1wv/other'
                else:
                    journal = bytearray(raw['regular-journal-after.bin'])
                    at = {'extra-journal': 30 * 4096, 'payload': 15 * 4096 + 2200,
                          'descriptor': 14 * 4096 + 16, 'commit': 16 * 4096 + 8}[case]
                    journal[at] ^= 1
                    raw['regular-journal-after.bin'] = bytes(journal)
                with self.assertRaises(D.Invalid):
                    D.classify_diagnostic_transaction(raw['regular-journal-before.bin'], raw['regular-journal-after.bin'],
                        raw['regular-pre.sb'], raw['regular-post.sb'], mount)


def synthetic_device_block_control(changed_offset=None):
    """Self-consistent synthetic image envelope around the real historical journal.
    Only tests the offline block classifier; it is never a qualification artifact.
    """
    raw = originals()
    before, after = raw['regular-journal-before.bin'], raw['regular-journal-after.bin']
    first = bytearray(4096); first[1024:2048] = raw['regular-pre.sb']
    last = bytearray(4096); last[1024:2048] = raw['regular-post.sb']
    if changed_offset is not None: last[changed_offset] ^= 1
    blocks = list(range(2048, 3072)); binding = {'synthetic': True}
    views = []
    for index, (block0, journal) in enumerate(((first, before), (last, after))):
        hashes = [hashlib.sha256(bytes(4096)).hexdigest()] * 16384
        hashes[0] = hashlib.sha256(block0).hexdigest()
        for logical, physical in enumerate(blocks):
            hashes[physical] = hashlib.sha256(journal[logical*4096:(logical+1)*4096]).hexdigest()
        views.append({'bytes': 67108864, 'block_bytes': 4096, 'block_sha256': hashes,
                      'loop_binding': binding, 'begin_monotonic_ns': index*2+1, 'end_monotonic_ns': index*2+2})
    delta = [{'block': 0, 'before_hex': first.hex(), 'after_hex': last.hex()}]
    for logical, physical in enumerate(blocks):
        a, b = before[logical*4096:(logical+1)*4096], after[logical*4096:(logical+1)*4096]
        if a != b: delta.append({'block': physical, 'before_hex': a.hex(), 'after_hex': b.hex()})
    values = {'raw/regular-image-before.json': views[0], 'raw/regular-image-after.json': views[1],
              'raw/regular-journal-map.json': {'blocks': blocks, 'loop_binding': binding},
              'raw/regular-block-deltas.json': {'complete': True, 'changed_blocks': [d['block'] for d in delta], 'raw_blocks': delta}}
    files = {name: json.dumps(value).encode() for name, value in values.items()}
    files.update({'raw/regular-image-before.sb': raw['regular-pre.sb'], 'raw/regular-image-after.sb': raw['regular-post.sb']})
    return files, before, after


class DeviceControls(unittest.TestCase):
    def test_device_block_zero_does_not_allow_bytes_outside_superblock(self):
        files, before, after = synthetic_device_block_control()
        self.assertEqual(C._device_effects(files, 'regular', before, after)['status'], 'CLASSIFIED')
        for offset in (0, 1023, 2048, 4095):
            with self.subTest(offset=offset):
                files, before, after = synthetic_device_block_control(offset)
                with self.assertRaises(C.Invalid):
                    C._device_effects(files, 'regular', before, after)


def synthetic_window():
    """只用于窗口消费者单元测试：历史 native 原件 + 明示合成 health 记录。
    不输出 hosted 原件，不用于资格通过；真实 health 留专用 job 实测。
    """
    rows = [json.loads(line) for line in originals()['provider-regular.jsonl'].splitlines()]
    pid = rows[0]['pid']
    last_ns = max(int(r['monotonic_ns']) for r in rows if 'monotonic_ns' in r)
    for phase in ('before', 'after'):
        b = next(r for r in rows if r.get('kind') == 'sysfs-binding' and r['phase'] == phase)
        binding = {'kind': 'health-binding', 'pid': pid, 'phase': phase, 'source_fd': b['source_fd'],
            'dev_major': b['dev_major'], 'dev_minor': b['dev_minor'], 'device_dev': b['sysfs_dev'],
            'device_inode': b['sysfs_inode'], 'health_dev': b['sysfs_dev'], 'health_inode': '777',
            'resolved': b['resolved'], 'sb_id': b['sb_id']}
        inserted = [binding]
        for index, field in enumerate(W.HEALTH_FIELDS):
            inserted += [{'kind': 'health-field', 'pid': pid, 'phase': phase, 'source_fd': b['source_fd'],
                'sb_id': b['sb_id'], 'name': field, 'actual_name': field, 'fd': 98, 'rc': 0, 'errno': 0,
                'fs_magic': '62656572', 'dev': b['sysfs_dev'], 'ino': str(10000 + index),
                'hex': (b'\n' if field.endswith('_func') else b'0\n').hex(), 'zero_error_snapshot': True,
                'fault_injection': False},
                {'kind': 'step', 'pid': pid, 'action': 'close', 'role': 'health-field',
                 'fd': 98, 'rc': 0, 'errno': 0, 'monotonic_ns': str(last_ns + index + 1)}]
        inserted += [{'kind': 'health-result', 'pid': pid, 'phase': phase, 'source_fd': b['source_fd'],
                      'healthy': True, 'commit_barrier': False}]
        if phase == 'before':
            at = next(i for i, r in enumerate(rows) if r.get('action') == 'ordinary-open-attempt')
        else:
            at = next(i for i, r in enumerate(rows) if r.get('kind') == 'r04-extra' and r.get('label') == 'root-after') + 1
        rows[at:at] = inserted
    rows.insert(-1, {'kind': 'step', 'pid': pid, 'action': 'native-window-closed', 'role': 'capture',
                    'fd': -1, 'rc': 0, 'errno': 0, 'monotonic_ns': str(last_ns + 100)})
    receipt = {'pid': pid, 'returncode': 0, 'reaped': True, 'output_complete': True,
               'timed_out': False, 'call_error': None, 'cleanup_errors': []}
    return rows, receipt, last_ns + 200


def stream(rows):
    return b''.join((json.dumps(row, sort_keys=True) + '\n').encode() for row in rows)


class WindowControls(unittest.TestCase):
    def test_persisted_summary_preserves_complete_json_values(self):
        rows, receipt, joined = synthetic_window()
        computed = W.capture(stream(rows), 'ordinary', receipt, joined)
        stored = json.loads(json.dumps(computed))
        C._verify_summary(stored, computed)
        for change in ('member', 'array-order', 'bool-to-number', 'int-to-float', 'int-to-string', 'missing', 'extra'):
            with self.subTest(change=change):
                trial = copy.deepcopy(stored)
                item = trial['native']['context']['before']['pseudo_identity']['device-dev']
                if change == 'member': item[0] += '-different'
                if change == 'array-order': item.reverse()
                if change == 'bool-to-number': trial['production_supported'] = 0
                if change == 'int-to-float': trial['native']['parsed']['root-before']['statx']['ino'] = 2.0
                if change == 'int-to-string': trial['native']['parsed']['root-before']['statx']['ino'] = '2'
                if change == 'missing': del trial['native']['context']['before']['pseudo_identity']['device-dev']
                if change == 'extra': trial['unexpected'] = False
                with self.assertRaises(C.Invalid): C._verify_summary(trial, computed)

    def test_visible_kernel_error_control_cannot_use_missing_or_other_source_getters(self):
        rows, receipt, joined = synthetic_window()
        healthy = W.capture(stream(rows), 'ordinary', receipt, joined)
        refused = [copy.deepcopy(r) for r in rows if not (r.get('kind') == 'content'
                   or r.get('object') == 'payload' or r.get('label', '').startswith('payload-')
                   or r.get('kind') == 'payload-path-guard'
                   or r.get('kind') == 'step' and (r.get('action', '').startswith('ordinary-open') or r.get('role', '').startswith('payload')))]
        for row in refused:
            if row.get('kind') == 'health-field':
                if row['name'] == 'errors_count': row['hex'] = b'1\n'.hex()
                if row['name'].endswith('_func'): row['hex'] = b'trigger_test_error\n'.hex()
            if row.get('kind') == 'health-result': row['healthy'] = False
            if row.get('action') == 'native-window-closed': row['rc'] = 69
            if row.get('kind') == 'complete': row['status'] = 69
        receipt['returncode'] = 69
        self.assertEqual(W.visible_error_refusal(stream(refused), receipt, healthy)['kernel_error_count'], 1)
        for change in ('missing-getter', 'wrong-device', 'other-error', 'ordinary-content'):
            with self.subTest(change=change):
                trial = copy.deepcopy(refused)
                if change == 'missing-getter': next(r for r in trial if r.get('kind') == 'health-field')['rc'] = -1
                if change == 'wrong-device': next(r for r in trial if r.get('kind') == 'health-binding')['dev_minor'] += 1
                if change == 'other-error': next(r for r in trial if r.get('kind') == 'health-field' and r['name'] == 'errors_count')['hex'] = b'2\n'.hex()
                if change == 'ordinary-content': trial.insert(-1, {'kind': 'content', 'hex': '61'})
                with self.assertRaises(W.Invalid): W.visible_error_refusal(stream(trial), receipt, healthy)

    def test_root_fault_admission_rejects_other_source_or_error_policy(self):
        rows, receipt, joined = synthetic_window()
        window = W.capture(stream(rows), 'ordinary', receipt, joined)
        root = window['native']['parsed']['root-before']; health = window['health']['binding']
        source = root['statx']; device = os.makedev(source['dev_major'], source['dev_minor'])
        binding = {'loop_rdev': device}
        current = {'source_dev': device, 'source_inode': source['ino'], 'source_uid': source['uid'], 'source_gid': source['gid'],
                   'health_dev': int(health['health_dev']), 'health_inode': int(health['health_inode']), 'health_magic': 0x62656572,
                   'trigger_dev': int(health['health_dev']), 'trigger_uid': 0, 'trigger_mode': 0o100200, 'trigger_magic': 0x62656572,
                   'options_magic': 0x9fa0}
        options = window['native']['context']['after']['options']
        C.visible_error_admission(window, binding, current, options, root['uuid'], root['mount']['point'])
        for change in ('other-device', 'other-inode', 'other-health', 'non-sysfs', 'other-policy', 'other-source', 'other-point', 'warn-on-error'):
            with self.subTest(change=change):
                actual, opts = dict(current), dict(options); expected_uuid, point = root['uuid'], root['mount']['point']
                basis = copy.deepcopy(window)
                if change == 'other-device': actual['source_dev'] += 1
                if change == 'other-inode': actual['source_inode'] += 1
                if change == 'other-health': actual['health_inode'] += 1
                if change == 'non-sysfs': actual['trigger_magic'] = 0xef53
                if change == 'other-policy':
                    opts['errors'] = 'panic'; basis['native']['context']['after']['options'] = dict(opts)
                if change == 'other-source': expected_uuid = '00' * 16
                if change == 'other-point': point += '-other'
                if change == 'warn-on-error':
                    del opts['nowarn_on_error']; opts['warn_on_error'] = True
                    basis['native']['context']['after']['options'] = dict(opts)
                with self.assertRaises(C.Invalid):
                    C.visible_error_admission(basis, binding, actual, opts, expected_uuid, point)

    def test_refusal_cannot_contain_an_untagged_content_record(self):
        rows, receipt, _ = synthetic_window()
        failed = copy.deepcopy(next(r for r in rows if r.get('kind') == 'health-field'))
        failed.update(rc=-1, errno=2, hex='', actual_name='errors_count_qualification_missing', fault_injection=True)
        refused = [rows[0], failed, {'kind': 'health-result', 'phase': 'before', 'healthy': False},
                   {'kind': 'complete', 'status': 69}]
        receipt['returncode'] = 69
        self.assertEqual(W.refused_before_content(stream(refused), receipt)['status'], 'OBSERVED_REFUSAL')
        for content in ({'kind': 'content', 'hex': '61'},
                        {'kind': 'native-observation', 'object': 'payload'},
                        {'kind': 'step', 'action': 'ordinary-open-attempt'}):
            with self.subTest(content=content):
                with self.assertRaises(W.Invalid):
                    W.refused_before_content(stream(refused[:-1] + [content, refused[-1]]), receipt)

    def test_synthetic_window_requires_join_and_preserves_non_barrier_semantics(self):
        rows, receipt, joined = synthetic_window()
        result = W.capture(stream(rows), 'ordinary', receipt, joined)
        self.assertEqual(result['status'], 'OBSERVED_SUCCESS')
        self.assertEqual(result['tcut_monotonic_ns'], str(joined))
        self.assertFalse(result['diagnostic_commit_waited'])
        self.assertFalse(result['future_errors_guaranteed_absent'])
        self.assertFalse(result['production_supported'])

    def test_visible_error_unknown_or_missing_health_refuses_success(self):
        rows, receipt, joined = synthetic_window()
        for change in ('visible-error', 'unknown', 'errno', 'wrong-source', 'missing', 'close-failed', 'late-admission'):
            with self.subTest(change=change):
                trial = copy.deepcopy(rows)
                field = next(r for r in trial if r.get('kind') == 'health-field')
                if change == 'visible-error': field['hex'] = b'1\n'.hex()
                if change == 'unknown': field['hex'] = b'unknown\n'.hex()
                if change == 'errno': field['rc'], field['errno'] = -1, 13
                if change == 'wrong-source': field['source_fd'] += 1
                if change == 'missing': trial.remove(field)
                if change == 'close-failed': trial[trial.index(field) + 1]['rc'] = -1
                if change == 'late-admission':
                    result = next(r for r in trial if r.get('kind') == 'health-result' and r['phase'] == 'before')
                    trial.remove(result); trial.insert(-2, result)
                with self.assertRaises(W.Invalid): W.capture(stream(trial), 'ordinary', receipt, joined)

    def test_incomplete_native_or_earlier_join_is_not_tcut(self):
        rows, receipt, joined = synthetic_window()
        for change in ('unreaped', 'incomplete', 'timeout', 'failed', 'earlier-time', 'missing-close'):
            with self.subTest(change=change):
                trial, result, moment = copy.deepcopy(rows), dict(receipt), joined
                if change == 'unreaped': result['reaped'] = False
                if change == 'incomplete': result['output_complete'] = False
                if change == 'timeout': result['timed_out'] = True
                if change == 'failed': result['returncode'] = 70
                if change == 'earlier-time': moment = 1
                if change == 'missing-close': trial.pop(-2)
                with self.assertRaises(W.Invalid): W.capture(stream(trial), 'ordinary', result, moment)


if __name__ == '__main__':
    unittest.main(verbosity=2)

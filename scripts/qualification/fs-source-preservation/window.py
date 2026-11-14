"""单次 native 只读观察窗口的离线核对；Tcut 取 child 真正 reap 后。

此模块不等待或声称 JBD2 最终提交，也不对未来健康作保证。
它没有 production registry、Fs/Jq 写入或 live 消费授权能力。
"""
from __future__ import annotations
import hashlib
import json
import re
import native as N

Invalid = N.Invalid
HEALTH_FIELDS = ('errors_count', 'first_error_errcode', 'last_error_errcode',
    'first_error_ino', 'last_error_ino', 'first_error_block', 'last_error_block',
    'first_error_line', 'last_error_line', 'first_error_time', 'last_error_time',
    'first_error_func', 'last_error_func')


def health_value(name, raw):
    N.need(name in HEALTH_FIELDS, 'unknown health field')
    N.need(type(raw) is bytes and len(raw) <= 4096, 'health value bytes/budget')
    # 固定新 fixture 健康前提；非零既有错误不能作为新的健康基线。
    N.need(raw == (b'\n' if name.endswith('_func') else b'0\n'), 'visible health error/unknown value')
    return 'empty' if name.endswith('_func') else 0


def _receipt(receipt):
    N.need(isinstance(receipt, dict) and receipt.get('reaped') is True and receipt.get('output_complete') is True,
           'native child not fully joined')
    N.need(type(receipt.get('pid')) is int and receipt['pid'] > 0
           and type(receipt.get('returncode')) is int, 'native process/result identity')
    N.need(receipt.get('timed_out') is False and receipt.get('call_error') is None
           and receipt.get('cleanup_errors') == [], 'native timeout/cleanup/result uncertainty')


def capture(raw, mode, receipt, joined_monotonic_ns):
    _receipt(receipt)
    N.need(receipt['returncode'] == 0, 'native read did not succeed')
    N.need(type(joined_monotonic_ns) is int and joined_monotonic_ns > 0, 'missing actual join time')
    data = N.parse_stream(raw, mode)
    N.need(data['exit'] == 0 and not data['problems'] and data['pid'] == receipt['pid'], 'native capability/input not established')
    rows = data['rows']
    closed = [r for r in rows if r.get('kind') == 'step' and r.get('action') == 'native-window-closed']
    N.need(len(closed) == 1 and rows[-2] is closed[0] and closed[0]['rc'] == 0,
           'missing ordered native window close')
    closed_ns = int(closed[0]['monotonic_ns'])
    N.need(0 < closed_ns <= joined_monotonic_ns, 'Tcut must follow native completion/join')
    root_closes = [r for r in rows if r.get('kind') == 'step' and r.get('action') == 'close' and r.get('role') == 'root']
    N.need(len(root_closes) == 1 and root_closes[0]['fd'] == data['parsed']['root-before']['fd']
           and root_closes[0]['rc'] == 0 and rows.index(root_closes[0]) < rows.index(closed[0]), 'held source root not closed')
    phases = {}
    for phase in ('before', 'after'):
        bindings = [r for r in rows if r.get('kind') == 'health-binding' and r.get('phase') == phase]
        N.need(len(bindings) == 1, 'missing/duplicate source-health binding')
        bound = bindings[0]
        current = data['context'][phase]['binding']
        root = data['parsed']['root-' + phase]
        N.need(bound['source_fd'] == root['fd'] and
               (bound['dev_major'], bound['dev_minor']) == (root['statx']['dev_major'], root['statx']['dev_minor'])
               and bound['resolved'] == current['resolved'] and bound['sb_id'] == current['sb_id']
               and (bound['device_dev'], bound['device_inode']) == (current['sysfs_dev'], current['sysfs_inode']),
               'health observations bound to another source/device')
        N.need(str(int(bound['health_inode'])) == bound['health_inode'] and int(bound['health_inode']) > 0,
               'health directory identity')
        fields = [r for r in rows if r.get('kind') == 'health-field' and r.get('phase') == phase]
        N.need(len(fields) == len(HEALTH_FIELDS) and {r['name'] for r in fields} == set(HEALTH_FIELDS),
               'incomplete/duplicate health fields')
        values = {}
        last_position = rows.index(bound)
        for row in fields:
            N.need(row['source_fd'] == root['fd'] and row['sb_id'] == bound['sb_id'] and row['actual_name'] == row['name'],
                   'health getter path/source mismatch')
            N.need(row['rc'] == row['errno'] == 0 and row['fs_magic'] == '62656572'
                   and row['dev'] == bound['health_dev'] and int(row['ino']) > 0
                   and row['fault_injection'] is False, 'health getter failed or injected')
            value = health_value(row['name'], N.rawhex(row['hex']))
            at = rows.index(row)
            N.need(at > last_position and at + 1 < len(rows), 'health getter order')
            close = rows[at + 1]
            N.need(close.get('kind') == 'step' and close.get('action') == 'close'
                   and close.get('role') == 'health-field' and close['fd'] == row['fd']
                   and close['rc'] == 0 and int(close['monotonic_ns']) <= closed_ns, 'health FD not closed')
            last_position = at + 1
            values[row['name']] = {'value': value, 'dev': row['dev'], 'ino': row['ino']}
        result = [r for r in rows if r.get('kind') == 'health-result' and r.get('phase') == phase]
        N.need(len(result) == 1 and result[0]['healthy'] is True and result[0]['commit_barrier'] is False
               and result[0]['source_fd'] == root['fd'] and rows.index(result[0]) > last_position,
               'health window has no successful bounded result')
        phases[phase] = {'binding': {k: v for k, v in bound.items() if k != 'phase'}, 'fields': values}
        if phase == 'before' and mode == 'ordinary':
            attempt = next(r for r in rows if r.get('kind') == 'step' and r.get('action') == 'ordinary-open-attempt')
            N.need(rows.index(result[0]) < rows.index(attempt), 'health admission is after content open')
        if phase == 'after':
            if mode == 'ordinary':
                payload_close = next(r for r in rows if r.get('kind') == 'step' and r.get('action') == 'close' and r.get('role') == 'payload')
                N.need(rows.index(bound) > rows.index(payload_close), 'health recheck precedes content completion')
            N.need(rows.index(result[0]) < rows.index(root_closes[0]), 'health queried after losing source FD')
    N.need(phases['before'] == phases['after'], 'same-source health binding/state changed')
    return {'status': 'OBSERVED_SUCCESS', 'scope': 'bounded-native-read-window', 'pid': data['pid'],
            'tcut_monotonic_ns': str(joined_monotonic_ns), 'native_window_closed_ns': str(closed_ns),
            'raw_sha256': hashlib.sha256(raw).hexdigest(), 'native': {k: data[k] for k in ('parsed', 'context', 'anchor')},
            'health': phases['after'], 'blockEffectsObservation': 'not-observed-at-runtime',
            'diagnostic_commit_waited': False, 'future_errors_guaranteed_absent': False,
            'production_supported': False, 'accepted_provider_profiles': [], 'qualified_kernel_builds': []}


def refused_before_content(raw, receipt):
    """真实 getter 拒绝回执；只证明该负例没有进入普通内容读取。"""
    _receipt(receipt)
    N.need(receipt['returncode'] != 0, 'negative probe returned success')
    N.need(len(raw) <= 12 * 1024 * 1024, 'failed probe stream bound')
    rows = [N.strict_json(line) for line in raw.splitlines()]
    N.need(rows and isinstance(rows[0], dict), 'failed probe originals absent')
    pid, _, _ = N._identity(rows[0])
    N.need(pid == receipt['pid'], 'failed probe PID mismatch')
    N.need(not any(r.get('kind') == 'content'
                   or r.get('kind') == 'native-observation' and r.get('object') == 'payload'
                   or r.get('kind') == 'step' and r.get('action') in ('ordinary-open-attempt', 'ordinary-open')
                   for r in rows), 'failed health admission reached content open')
    bad = [r for r in rows if r.get('kind') == 'health-field' and r.get('phase') == 'before'
           and (r['rc'] != 0 or r['hex'] != (b'\n' if r['name'].endswith('_func') else b'0\n').hex())]
    N.need(bad and any(r.get('kind') == 'health-result' and r.get('phase') == 'before'
                      and r.get('healthy') is False for r in rows), 'no actual health rejection')
    N.need(rows[-1].get('kind') == 'complete' and rows[-1].get('status') == receipt['returncode'], 'failed probe incomplete')
    return {'status': 'OBSERVED_REFUSAL', 'ordinary_content_open_count': 0, 'pid': pid,
            'failed_fields': bad, 'raw_sha256': hashlib.sha256(raw).hexdigest(), 'production_supported': False}


def visible_error_refusal(raw, receipt, healthy):
    """Separate deliberate kernel-error control, never an allowed read effect."""
    result = refused_before_content(raw, receipt)
    rows = [N.strict_json(line) for line in raw.splitlines()]
    N.need(all(isinstance(r, dict) and r.get('pid', receipt['pid']) == receipt['pid'] for r in rows), 'fault stream process identity')
    N.need(receipt['returncode'] == 69 and rows[-2].get('action') == 'native-window-closed'
           and rows[-2]['rc'] == 69, 'visible error probe did not close with capability refusal')
    N.need(all(r['rc'] == 0 for r in rows if r.get('kind') == 'step' and r.get('action') == 'close'), 'fault probe close failure')
    expected = healthy['native']['parsed']['root-before']; binding = healthy['health']['binding']
    _, uid, gid = N._identity(rows[0])
    N.need((uid, gid) == (expected['statx']['uid'], expected['statx']['gid']), 'fault ordinary identity changed')
    held_roots = []
    for phase, iteration in (('before', 0), ('after', 1)):
        roots = [r for r in rows if r.get('kind') == 'native-observation' and r.get('object') == 'root' and r['iteration'] == iteration]
        N.need(len(roots) == 1, 'fault source native evidence absent')
        root = roots[0]
        held_roots.append(root)
        N.need(root['before_rc'] == root['after_rc'] == root['fsuuid']['rc'] == root['fid_unique']['rc'] == 0
               and root['before'] == root['after'] and root['fsuuid']['hex'] == expected['uuid']
               and root['fid_unique']['hex'] == expected['fid'], 'fault affected another source identity')
        bindings = [r for r in rows if r.get('kind') == 'health-binding' and r.get('phase') == phase]
        N.need(len(bindings) == 1 and bindings[0]['source_fd'] == root['fd'], 'fault health source FD')
        N.need(all(bindings[0][k] == binding[k] for k in ('dev_major', 'dev_minor', 'device_dev', 'device_inode',
                   'health_dev', 'health_inode', 'resolved', 'sb_id')), 'fault health kernel object changed')
        fields = [r for r in rows if r.get('kind') == 'health-field' and r.get('phase') == phase]
        N.need(len(fields) == len(HEALTH_FIELDS) and {r['name'] for r in fields} == set(HEALTH_FIELDS), 'fault health field completeness')
        values = {}
        for row in fields:
            N.need(row['rc'] == row['errno'] == 0 and row['fault_injection'] is False and row['actual_name'] == row['name']
                   and row['source_fd'] == root['fd'] and row['sb_id'] == binding['sb_id'] and row['fs_magic'] == '62656572'
                   and (row['dev'], row['ino']) == (healthy['health']['fields'][row['name']]['dev'], healthy['health']['fields'][row['name']]['ino']),
                   'fault observation used failed/injected/other-source getter')
            value = N.rawhex(row['hex']);values[row['name']] = value
            if not row['name'].endswith('_func'): N.need(re.fullmatch(rb'[0-9]{1,20}\n', value), 'unknown fault numeric value')
            at = rows.index(row);close = rows[at+1]
            N.need(close.get('action') == 'close' and close.get('role') == 'health-field'
                   and close['fd'] == row['fd'] and close['rc'] == 0, 'fault health FD not closed')
        N.need(values['errors_count'] == b'1\n' and values['first_error_func'] == values['last_error_func'] == b'trigger_test_error\n',
               'visible fault is not exactly the deliberate test error')
        status = [r for r in rows if r.get('kind') == 'health-result' and r.get('phase') == phase]
        N.need(len(status) == 1 and status[0]['healthy'] is False, 'visible error not refused')
    root_closes = [r for r in rows if r.get('action') == 'close' and r.get('role') == 'root']
    N.need(len(root_closes) == 1 and root_closes[0]['fd'] == held_roots[0]['fd'] == held_roots[1]['fd']
           and rows.index(root_closes[0]) > rows.index(held_roots[1]) and rows.index(root_closes[0]) < len(rows)-2,
           'fault source FD lifetime not completed')
    result['scope'] = 'deliberate-root-owned-B-kernel-error-control'
    result['kernel_error_count'] = 1
    result['provider_diagnostic_allowance'] = False
    return result

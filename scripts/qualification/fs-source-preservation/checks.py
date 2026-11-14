"""新 profile 资格原件消费者。成功收集不等于接受 profile/产品通过。"""
from __future__ import annotations
import hashlib
import json
import os
import re
import struct
import diagnostics as D
import native as N
import window as W

Invalid = N.Invalid
need = N.need
strict_json = N.strict_json
sha = N.sha
TARGET = N.TARGET
REVISION = 'S4-T2-Fs-source-preservation-qualification-r1-20261114'
M_IDS = ('M01', 'M02', 'M03', 'M04', 'M05')
RELEASE = {'accepted_provider_profiles': [], 'qualified_kernel_builds': [], 'B1': 'OPEN',
           'R05': 'NOT_IMPLEMENTED_NOT_RUN', 'S4_outputs_released': [], 'ticket153': 'BLOCKED'}
FAULT_MESSAGE = b'boardroom owned B source preservation fault control\n'
PREFIX = 'scripts/qualification/fs-source-preservation/'
FILES = ('.github/workflows/fs-source-preservation-evidence.yml', 'tests/fs-source-preservation.test.py') + tuple(
    PREFIX + name for name in ('README.md', 'checks.py', 'diagnostics.py', 'native.py', 'observer.py',
    'probe.c', 'profile.json', 'reuse.json', 'run.py', 'support.py', 'uapi.h', 'window.py')) + tuple(
    'tests/fixtures/fs-source-preservation/' + name for name in ('provenance.json', 'provider-regular.jsonl.gz',
    'regular-journal-before.bin.gz', 'regular-journal-after.bin.gz', 'regular-pre.sb', 'regular-post.sb'))


def base_summary():
    return {'revision': REVISION, 'integrity': 'NOT_RUN', 'qualification': 'INCONCLUSIVE',
            'M': {key: {'status': 'NOT_RUN'} for key in M_IDS}, 'production_runtime': 'UNSUPPORTED', **RELEASE}


def _value(files, name):
    need(name in files, 'missing original: ' + name)
    return strict_json(files[name])


def _verify_summary(stored, computed):
    # JSON arrays represent the native parser's tuples. Compare complete JSON
    # values, preserving array order and distinct bool/int/float/string types.
    def encode(value):
        return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)
    need(encode(stored) == encode(computed), 'stored interpretation not independently reproducible')


def _receipt(files, label):
    r = _value(files, 'commands/' + label + '.receipt.json')
    W._receipt(r)
    need(r['label'] == label and type(r['pid']) is int and r['pid'] > 0, 'command receipt identity')
    need('commands/' + label + '.stdout' in files and 'commands/' + label + '.stderr' in files, 'missing command raw output')
    return r


def _device_effects(files, label, journal_before, journal_after):
    first = _value(files, 'raw/' + label + '-image-before.json')
    last = _value(files, 'raw/' + label + '-image-after.json')
    mapping = _value(files, 'raw/' + label + '-journal-map.json')
    for view in (first, last):
        need(view['bytes'] == 67108864 and view['block_bytes'] == 4096 and len(view['block_sha256']) == 16384,
             'whole owned-device hash coverage')
        need(all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in view['block_sha256']), 'device block digest')
        need(view['loop_binding'] == mapping['loop_binding'], 'device/journal map backing mismatch')
        need(view['begin_monotonic_ns'] <= view['end_monotonic_ns'], 'image observation interval')
    need(first['end_monotonic_ns'] < last['begin_monotonic_ns'], 'device observation order')
    blocks = mapping['blocks']
    need(len(blocks) == len(set(blocks)) == 1024 and all(type(v) is int and 0 < v < 16384 for v in blocks), 'journal physical map')
    for view, raw in ((first, journal_before), (last, journal_after)):
        need(len(raw) == 4194304 and all(view['block_sha256'][block] == sha(raw[i*4096:(i+1)*4096]) for i, block in enumerate(blocks)),
             'journal dump not the complete mapped device bytes')
    changed = [i for i, (a, b) in enumerate(zip(first['block_sha256'], last['block_sha256'])) if a != b]
    journal_changed = [i for i in range(1024) if journal_before[i*4096:(i+1)*4096] != journal_after[i*4096:(i+1)*4096]]
    need(changed == sorted([0] + [blocks[i] for i in journal_changed]), 'unknown changed device block outside SB/exact journal transaction')
    delta = _value(files, 'raw/' + label + '-block-deltas.json')
    need(delta['complete'] is True and delta['changed_blocks'] == changed and len(delta['raw_blocks']) == len(changed), 'changed raw block originals incomplete')
    for expected, row in zip(changed, delta['raw_blocks']):
        need(row['block'] == expected, 'changed block order')
        originals = {}
        for phase, view in (('before', first), ('after', last)):
            raw = N.rawhex(row[phase + '_hex'], 4096)
            need(sha(raw) == view['block_sha256'][expected], 'changed block bytes/digest mismatch')
            if expected == 0: need(raw[1024:2048] == files[f'raw/{label}-image-{phase}.sb'], 'SB not from device block0')
            originals[phase] = raw
        if expected == 0:
            need(originals['before'][:1024] == originals['after'][:1024]
                 and originals['before'][2048:] == originals['after'][2048:],
                 'unapproved device block0 bytes outside ext4 superblock')
    return {'status': 'CLASSIFIED', 'changed_device_blocks': changed, 'journal_changed_logical_blocks': journal_changed,
            'full_device_block_hashes': 16384, 'hash_observation_is_atomic_live_snapshot': False}


def visible_error_admission(window, binding, current, options, expected_uuid, expected_point):
    """Qualification root may fault only its still-bound image after ordinary admission.
    This is not a production permission or a side-effect whitelist.
    """
    root = window['native']['parsed']['root-before']; sx, mount = root['statx'], root['mount']
    health = window['health']['binding']
    need(window['status'] == 'OBSERVED_SUCCESS' and root['uuid'] == expected_uuid
         and mount['point'] == expected_point and mount['root'] == '/' and sx['ino'] == 2,
         'fault target is not the verified whole owned image')
    need(mount['attr'] == mount['sb_flags'] == 0 and mount['propagation'] == 262144, 'fault requires private native rw mount')
    need(current['source_dev'] == binding['loop_rdev']
         and (os.major(current['source_dev']), os.minor(current['source_dev'])) == (sx['dev_major'], sx['dev_minor'])
         and (current['source_inode'], current['source_uid'], current['source_gid']) == (sx['ino'], sx['uid'], sx['gid']),
         'fault source FD differs from owned loop/native identity')
    need((current['health_dev'], current['health_inode']) == (int(health['health_dev']), int(health['health_inode']))
         and current['trigger_dev'] == current['health_dev'] and current['trigger_uid'] == 0
         and current['trigger_mode'] == 0o100200
         and current['health_magic'] == current['trigger_magic'] == 0x62656572
         and current['options_magic'] == 0x9fa0, 'fault getter/trigger is not the verified kernel object')
    need(options == window['native']['context']['after']['options'] and options.get('errors') == 'remount-ro'
         and options.get('rw') is True, 'fault policy changed or may panic')
    need(options.get('nowarn_on_error') is True and 'warn_on_error' not in options,
         'fault policy may issue a global kernel warning')


def positive_rounds(files, fixture):
    windows, effects = {}, {}
    for label, key, mode in (('control', 'A', 'context'), ('regular', 'A', 'ordinary'), ('variant', 'B', 'context')):
        point = fixture['points'][label]
        need(re.fullmatch('/tmp/brsp-[A-Za-z0-9_-]+/[crv]', point), 'fixed short namespace mount point')
        command = 'provider-' + label
        receipt = _receipt(files, command)
        joined = _value(files, 'windows/' + command + '-reap.json')
        need(joined['label'] == command and joined['mode'] == mode and not files['commands/' + command + '.stderr'], 'probe result association')
        window = W.capture(files['commands/' + command + '.stdout'], mode, receipt, joined['joined_monotonic_ns'])
        root = window['native']['parsed']['root-before']
        need(window['pid'] == receipt['pid'] and root['uuid'] == fixture['images'][key]['uuid']
             and root['mount']['point'] == point, 'native source/fixture association')
        views = [_value(files, f'views/{label}-{phase}.json') for phase in ('before', 'after')]
        need(views[0] == views[1] and views[0]['ordinary_source_open_count'] == 0, 'observed application state changed/observer preheated')
        need(set(views[0]['objects']) == {'.', 'payload', 'directory', 'ancestor'}, 'complete fixed fixture observation domain')
        if mode == 'ordinary':
            data = N.parse_stream(files['commands/' + command + '.stdout'], mode)
            payload = [r for r in data['rows'] if r.get('kind') == 'content']
            need(len(payload) == 1 and N.rawhex(payload[0]['hex']) == files['expected-payload.bin'], 'actual held-FD content')
        _receipt(files, label + '-offline-content')
        need(files['commands/' + label + '-offline-content.stdout'] == files['expected-payload.bin'], 'offline source payload baseline')
        before, after = files['raw/' + label + '-journal-before.bin'], files['raw/' + label + '-journal-after.bin']
        effects[label] = _device_effects(files, label, before, after)
        sb_before, sb_after = files['raw/' + label + '-pre.sb'], files['raw/' + label + '-unmount.sb']
        need(sb_before == files['raw/' + label + '-image-before.sb'] and sb_after == files['raw/' + label + '-image-after.sb'], 'SB/device observation consistency')
        if label == 'regular':
            head = D.be32(before, 0x58)
            sample = after[(head + 1)*4096+1024:(head + 1)*4096+2048]
            effects[label]['diagnostic'] = D.classify_diagnostic_transaction(before, after, sb_before, sample, point)
        else:
            need(before == after, 'non-content control wrote journal')
        before_mount = _value(files, 'mounts/mount-' + label + '-before-stat.json')
        unmount = _value(files, 'mounts/' + label + '-unmount-statistics.json')
        effects[label]['lifecycle'] = D.classify_unmount(sb_before, sb_after, files['mounts/mount-' + label + '-before.sb'],
            int(before_mount['write_sectors']), int(unmount['after']['write_sectors']),
            before_mount['realtime_ns'], unmount['after']['realtime_ns'], point if label == 'regular' else None)
        if label == 'regular':
            timestamp = int(effects[label]['diagnostic']['commit_realtime_ns'])
            need(before_mount['realtime_ns'] <= timestamp <= unmount['after']['realtime_ns'], 'commit time outside actual lifecycle')
        windows[label] = window
    return windows, effects


def visible_error_control(files, fixture, positive):
    closed = _value(files, 'fault/positive-closure.json')
    need(closed['sha256'] == sha(N.encoded(positive)), 'fault preceded or replaced positive closure')
    before_label, after_label = 'provider-visible-error-before', 'provider-visible-error-after'
    before_join = _value(files, 'windows/' + before_label + '-reap.json')
    after_join = _value(files, 'windows/' + after_label + '-reap.json')
    need(before_join['label'] == before_label and before_join['mode'] == 'context'
         and after_join['label'] == after_label and after_join['mode'] == 'ordinary', 'fault probe association')
    need(not files['commands/' + before_label + '.stderr'] and not files['commands/' + after_label + '.stderr'], 'fault probe stderr')
    before = W.capture(files['commands/' + before_label + '.stdout'], 'context', _receipt(files, before_label), before_join['joined_monotonic_ns'])
    admission = _value(files, 'fault/admission.json'); point = fixture['points']['variant']
    need(admission['loop_binding']['image_identity'] == fixture['images']['B']['identity'], 'fault backing is not owned B')
    visible_error_admission(before, admission['loop_binding'], admission['current'], N.options(files['fault/current-options.bin']),
                            fixture['images']['B']['uuid'], point)
    trigger = _value(files, 'fault/trigger.json')
    need(trigger['actor'] == 'root-owned-B-fault-control' and trigger['image'] == 'B' and trigger['point'] == point
         and trigger['sb_id'] == before['health']['binding']['sb_id'] and trigger['message_hex'] == FAULT_MESSAGE.hex()
         and trigger['write_attempted'] is True and trigger['written'] == len(FAULT_MESSAGE)
         and trigger['error'] is None and trigger['close_errors'] == [], 'fault root write result unknown/wrong target')
    times = [max(_value(files, 'mounts/' + k + '-unmount-statistics.json')['after']['monotonic_ns'] for k in ('control', 'regular', 'variant')),
             closed['monotonic_ns'], before_join['joined_monotonic_ns'], admission['monotonic_ns'],
             trigger['begin_monotonic_ns'], trigger['end_monotonic_ns'], after_join['joined_monotonic_ns']]
    need(all(type(v) is int and v > 0 for v in times) and times == sorted(times), 'fault control window order')
    refused = W.visible_error_refusal(files['commands/' + after_label + '.stdout'], _receipt(files, after_label), before)
    need(_value(files, 'fault/ordinary-refusal.json') == refused, 'fault refusal not independently reproducible')
    sb_before = files['raw/visible-error-pre.sb']; D.ext4_superblock(sb_before)
    sb_after = files['raw/visible-error-unmount.sb']; sb_post = files['raw/visible-error-post.sb']
    for value in (sb_post, sb_after):
        need(len(value) == 1024 and value[56:58] == b'\x53\xef' and value[104:120].hex() == fixture['images']['B']['uuid']
             and struct.unpack_from('<I', value, 0x194)[0] == 1 and struct.unpack_from('<H', value, 58)[0] & 2,
             'actual owned B superblock did not retain the deliberate error')
    journals = [files['raw/visible-error-journal-' + phase + '.bin'] for phase in ('before', 'after')]
    need(all(len(v) == 4194304 for v in journals), 'fault journal originals incomplete')
    unmount = _value(files, 'mounts/visible-error-unmount-statistics.json')
    need(unmount['before']['loop_binding'] == unmount['after']['loop_binding'] == admission['loop_binding']
         and unmount['before']['monotonic_ns'] >= after_join['joined_monotonic_ns'], 'fault unmount association')
    refused['root_fault_effects'] = {'scope': 'separate-deliberate-error-and-harness-unmount',
        'provider_diagnostic_allowance': False, 'sb_changed_offsets': D._changes(sb_before, sb_after),
        'journal_before_sha256': sha(journals[0]), 'journal_after_sha256': sha(journals[1]),
        'positive_device_closure_sha256': closed['sha256']}
    return refused


def consume(files, expected_source, profile_raw, *, allow_synthetic=False, sealed=True):
    need(not allow_synthetic, 'synthetic bundle never qualifies')
    need(len(files) <= 512 and sum(map(len, files.values())) <= 67108864, 'artifact budget')
    manifest = _value(files, 'manifest.json')
    need(manifest.get('schema') == 'fs-source-preservation-manifest/v1' and
         manifest.get('files') == {k: sha(v) for k, v in files.items() if k != 'manifest.json'}, 'artifact exact manifest')
    need(_value(files, 'source.json') == expected_source and files.get('profile.json') == profile_raw, 'source/profile binding')
    profile = strict_json(profile_raw)
    need(profile['revision'] == REVISION and profile['target'] == TARGET and profile['source_files'] == list(FILES), 'fixed profile')
    need(all(profile[k] == v for k, v in RELEASE.items()) and profile['production_enable'] is False, 'release claim forbidden')
    need(set(expected_source['files']) == set(FILES), 'complete source input set')
    need(_value(files, 'binary.json')['sha256'] == sha(files['native-probe']), 'binary binding')
    execution = _value(files, 'execution.json')
    need(execution == {'mode': 'hosted-fixture', 'platform_run': True, 'synthetic': False, 'completed': True}, 'no complete actual target execution')
    need(_value(files, 'environment.json')['target'] == TARGET, 'actual target environment')
    cleanup = _value(files, 'cleanup.json')
    need(cleanup['status'] == 'PASS' and cleanup['children_reaped'] is True and all(cleanup[k] == [] for k in
        ('owned_mounts_remaining', 'owned_loops_remaining', 'unknown_attach_images', 'errors')), 'fixture resources not released')
    fixture = _value(files, 'fixture.json')
    need(set(fixture['images']) == {'A', 'B'} and fixture['uid'] > 0 and fixture['gid'] > 0, 'fixed owned fixtures')
    for key in ('A', 'B'):
        need(fixture['images'][key]['bytes'] == 67108864, 'owned image size')
        detached = _value(files, 'cleanup/detached-' + key + '.json')
        need(detached['unconfigured'] is True and detached['errno'] == 6, 'loop detach not actually observed')
    windows, effects = positive_rounds(files, fixture)
    visible_error = visible_error_control(files, fixture, (windows, effects))
    negative_label = 'provider-control-missing-getter'
    negative = W.refused_before_content(files['commands/' + negative_label + '.stdout'], _receipt(files, negative_label))
    need(any(row['errno'] == 2 and row['actual_name'] == 'errors_count_qualification_missing' for row in negative['failed_fields']),
         'real unavailable-getter ENOENT control absent')
    left, right = (windows[k]['native']['parsed']['root-before'] for k in ('control', 'regular'))
    need(left['uuid'] == right['uuid'] and left['fid'] == right['fid'], 'new process/remount native identity did not reopen')
    a, b = windows['control']['native'], windows['variant']['native']
    need(a['parsed']['root-before']['tune']['default_mnt_opts'] != b['parsed']['root-before']['tune']['default_mnt_opts'], 'actual A/B persistent defaults did not differ')
    need(a['context']['before']['options'] == b['context']['before']['options'] and a['context']['before']['options'].get('acl') is True,
         'explicit ACL override not observed effectively')
    result = base_summary(); result['integrity'] = 'PASS'
    result['M'] = {
        'M01': {'status': 'INCONCLUSIVE', 'observed': 'exact kernel/notes/native ABI', 'remaining': 'vendor build-to-source qualification not accepted'},
        'M02': {'status': 'INCONCLUSIVE', 'observed': 'real A/B defaults and same effective override', 'remaining': 'complete effective feature/options entry not accepted'},
        'M03': {'status': 'INCONCLUSIVE', 'observed': 'same-FD native and 13 health getters; true missing-getter and visible-kernel-error refusal; Tcut after reap',
                'remaining': 'full production provider lifecycle qualification'},
        'M04': {'status': 'INCONCLUSIVE', 'observed': 'same-FD/mount/dev/sysfs and harness-only loop ownership',
                'remaining': 'ordinary backing object/writer coverage; root loop receipt is not runtime authorization'},
        'M05': {'status': 'PASS', 'scope': 'fixed fixture application state and exact diagnostic/harness device-block effects', 'effects': effects}}
    result['windows'] = windows; result['missing_getter_control'] = negative
    result['visible_kernel_error_control'] = visible_error
    result['late_error_live_recovery'] = 'NOT_IMPLEMENTED_NOT_RUN'
    if sealed: _verify_summary(_value(files, 'summary.json'), result)
    return result

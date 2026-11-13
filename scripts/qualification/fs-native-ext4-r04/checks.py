"""R04 d1 原件消费者。只产生诊断事实；没有生产准入正向分支。"""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import struct

REVISION = 'S4-T2-Fs-native-ext4-r3-R04-d1-20261113'
TARGET = {'sysname': 'Linux', 'machine': 'x86_64', 'release': '7.0.0-1017-azure',
          'version': '#17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026'}
M_IDS = ('M01', 'M02', 'M03', 'M04', 'M05')
RELEASE = {'accepted_provider_profiles': [], 'qualified_kernel_builds': [], 'B1': 'OPEN',
           'R05': 'NOT_IMPLEMENTED_NOT_RUN', 'S4_outputs_released': [], 'ticket153': 'BLOCKED'}
PREFIX = 'scripts/qualification/fs-native-ext4-r04/'
FILES = ('.github/workflows/fs-native-ext4-r04-evidence.yml',
         'tests/fs-native-ext4-r04-evidence.test.py') + tuple(PREFIX + n for n in
         ('README.md', 'checks.py', 'profile.json', 'probe.c', 'run.py', 'observer.py', 'support.py', 'uapi.h'))
CAPS = ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb')


class Invalid(ValueError): pass


def need(ok, why):
    if not ok: raise Invalid(why)


def encoded(value): return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
def sha(value): return hashlib.sha256(value).hexdigest()


def strict_json(raw):
    def pairs(values):
        result = {}
        for k, v in values:
            need(k not in result, 'duplicate JSON key: ' + k); result[k] = v
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs,
                          parse_constant=lambda v: (_ for _ in ()).throw(Invalid('non-finite JSON: ' + v)))
    except (UnicodeError, json.JSONDecodeError) as error: raise Invalid(str(error)) from None


def rawhex(value, size=None):
    need(isinstance(value, str) and len(value) % 2 == 0 and re.fullmatch('[a-f0-9]*', value) is not None, 'raw hex')
    result = bytes.fromhex(value); need(size is None or len(result) == size, 'raw ABI size'); return result


def decode_statx(raw):
    need(len(raw) == 256, 'statx size')
    return {'mask': struct.unpack_from('<I', raw, 0)[0], 'attributes': struct.unpack_from('<Q', raw, 8)[0],
            'nlink': struct.unpack_from('<I', raw, 16)[0], 'uid': struct.unpack_from('<I', raw, 20)[0],
            'gid': struct.unpack_from('<I', raw, 24)[0], 'mode': struct.unpack_from('<H', raw, 28)[0],
            'ino': struct.unpack_from('<Q', raw, 32)[0], 'size': struct.unpack_from('<Q', raw, 40)[0],
            'attributes_mask': struct.unpack_from('<Q', raw, 56)[0],
            'dev_major': struct.unpack_from('<I', raw, 136)[0], 'dev_minor': struct.unpack_from('<I', raw, 140)[0],
            'unique_id': struct.unpack_from('<Q', raw, 144)[0]}


def decode_tune(raw):
    need(len(raw) == 232, 'GET_TUNE size')
    # set_flags and set/clear masks remain raw SET capability information; not GET valid masks.
    return {'default_mnt_opts': struct.unpack_from('<I', raw, 40)[0],
            'feature_masks': list(struct.unpack_from('<III', raw, 64)), 'mount_opts_hex': raw[100:164].hex(),
            'encoding': struct.unpack_from('<H', raw, 56)[0], 'encoding_flags': struct.unpack_from('<H', raw, 58)[0],
            'def_hash_alg': raw[60], 'reserved_uid': struct.unpack_from('<I', raw, 44)[0],
            'reserved_gid': struct.unpack_from('<I', raw, 48)[0]}


def decode_statmount(raw):
    need(512 <= len(raw) <= 16384, 'statmount bounds')
    size, _, mask = struct.unpack_from('<IIQ', raw)
    need(size == len(raw) and mask & 59 == 59, 'statmount size/required mask')
    def string(offset):
        need(0 <= offset < len(raw)-512, 'statmount string offset')
        data = raw[512+offset:]; end = data.find(b'\0'); need(end >= 0, 'statmount NUL')
        try: return data[:end].decode('utf-8', 'strict')
        except UnicodeError: raise Invalid('statmount string encoding') from None
    row = {'mask': mask, 'dev_major': struct.unpack_from('<I', raw, 16)[0],
           'dev_minor': struct.unpack_from('<I', raw, 20)[0], 'magic': struct.unpack_from('<Q', raw, 24)[0],
           'sb_flags': struct.unpack_from('<I', raw, 32)[0], 'type': string(struct.unpack_from('<I', raw, 36)[0]),
           'unique_id': struct.unpack_from('<Q', raw, 40)[0], 'legacy_id': struct.unpack_from('<I', raw, 56)[0],
           'attr': struct.unpack_from('<Q', raw, 64)[0], 'propagation': struct.unpack_from('<Q', raw, 72)[0],
           'root': string(struct.unpack_from('<I', raw, 104)[0]),
           'point': string(struct.unpack_from('<I', raw, 108)[0])}
    need(row['unique_id'] > 0 and row['legacy_id'] > 0, 'statmount IDs')
    return row


def options(raw):
    need(len(raw) <= 16384 and b'\0' not in raw, 'proc options bound/NUL')
    try: text = raw.decode('ascii')
    except UnicodeError: raise Invalid('non-ASCII options') from None
    lines = text.splitlines(); need(len(lines) <= 256 and all(len(v) <= 1024 for v in lines), 'options lines')
    result = {}
    for token in re.split('[,\n]', text.rstrip('\n')):
        need(re.fullmatch('[A-Za-z0-9_.-]+(?:=[A-Za-z0-9_.:-]+)?', token) is not None, 'invalid option spelling')
        key, sep, value = token.partition('='); need(key not in result, 'duplicate option')
        result[key] = value if sep else True
    return result


def inode_guard(flags, attrs, mask, *, directory):
    allowed = (0x80000,0x81000) if directory else (0x80000,)
    return bool(mask & 0x200000) and not attrs & 0x200000 and flags in allowed


def topology(mount, anchor, *, writer_covered):
    reasons = []
    if mount['root'] != '/' or anchor['ino'] != 2: reasons.append('NOT_FULL_ROOT')
    if mount['type'] != 'ext4' or mount['magic'] != 0xef53: reasons.append('NOT_NATIVE_EXT4')
    if mount['attr'] & 0x100000: reasons.append('IDMAPPED')
    if mount['attr'] != 0 or mount['sb_flags'] & 1: reasons.append('UNKNOWN_OR_NON_RW_ATTR')
    if mount['propagation'] != 1 << 18: reasons.append('NOT_PRIVATE_VIEW')
    if any(mount[k] != anchor[k] for k in ('unique_id', 'dev_major', 'dev_minor')): reasons.append('ANCHOR_MOUNT_MISMATCH')
    if not writer_covered: reasons.append('ORIGINAL_WRITER_GUARD_UNPROVEN')
    return {'status': 'UNSUPPORTED' if reasons else 'CANDIDATE_ONLY',
            'mechanical_view': None if reasons else 'WHOLE_ROOT_CANDIDATE', 'reasons': reasons,
            'backing_object_bound': False, 'production_supported': False}


def match_runtime(entry, facts):
    # Compiled registry is deliberately empty. Null, JSON, caller booleans or evidence cannot register it.
    return {'status': 'UNSUPPORTED', 'reason': 'NO_REGISTERED_ENTRY' if entry is None else 'UNREGISTERED_ENTRY',
            'external': 'backup_capability_unavailable', 'before_regular_open': True,
            'cold_open_rule': 'UNRESOLVED', **RELEASE}


def _identity(row):
    need(row['kind'] == 'process-identity' and isinstance(row['pid'], int) and row['pid'] > 0, 'provider PID')
    uid, gid = row['uid'][0], row['gid'][0]
    need(uid > 0 and gid > 0 and row['uid'] == [uid]*4 and row['gid'] == [gid]*4, 'ordinary UID/GID')
    need(row['supplementary_group_count'] == 0 and row['no_new_privs'] == 1, 'groups/NNP')
    need(set(row['capabilities']) == set(CAPS) and all(int(row['capabilities'][k], 16) == 0 for k in CAPS), 'all five caps')
    return row['pid'], uid, gid


def mountinfo(raw):
    need(len(raw) <= 1048576, 'mountinfo bytes')
    lines = raw.decode('utf-8', 'strict').splitlines()
    need(len(lines) <= 4096 and all(len(l.encode()) <= 16384 for l in lines), 'mountinfo lines')
    rows = []
    def unescape(s):
        need(re.search(r'\\(?!040|011|012|134)', s) is None, 'mountinfo escape')
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)
    for line in lines:
        parts = line.split(' - '); need(len(parts) == 2, 'mountinfo delimiter')
        a, b = parts[0].split(), parts[1].split(); need(len(a) >= 6 and len(b) == 3, 'mountinfo row')
        rows.append({'id': int(a[0]), 'device': a[2], 'root': unescape(a[3]), 'point': unescape(a[4]),
                     'options': a[5].split(','), 'optional': a[6:], 'type': b[0], 'super': b[2].split(',')})
    need(len({r['id'] for r in rows}) == len(rows), 'duplicate mount IDs'); return rows


def parse_stream(raw, mode):
    need(len(raw) <= 12*1024*1024, 'provider stream bound')
    rows = [strict_json(line) for line in raw.splitlines()]
    need(rows and all(isinstance(r, dict) for r in rows), 'empty provider stream')
    pid, uid, gid = _identity(rows[0])
    need(rows[-1] == {'kind': 'complete', 'pid': pid, 'mode': mode, 'status': rows[-1].get('status')}, 'complete record')
    need(rows[-1]['status'] in (0, 69, 70), 'provider exit classification')
    for r in rows:
        if 'pid' in r: need(r['pid'] == pid, 'mixed provider PID')
        if r.get('kind') == 'step' and r.get('action') == 'close': need(r['rc'] == 0, 'native FD close failed')
    natives = {(r['object'], r['iteration']): r for r in rows if r.get('kind') == 'native-observation'}
    extra = {r['label']: r for r in rows if r.get('kind') == 'r04-extra'}
    opaths = {r['label']: r for r in rows if r.get('kind') == 'opath'}
    need(len(natives)==len([r for r in rows if r.get('kind')=='native-observation']) and len(opaths)==len([r for r in rows if r.get('kind')=='opath']), 'duplicate object/phase original')
    mandatory = {'root-before', 'root-after', 'directory'}
    if mode == 'ordinary': mandatory |= {'payload-before', 'payload-after'}
    need(mandatory <= extra.keys() and ('root',0) in natives and ('root',1) in natives, 'missing actual native originals')
    need(len(extra) == len([r for r in rows if r.get('kind') == 'r04-extra']), 'duplicate native label')
    problems, parsed = [], {}
    for label, r in extra.items():
        object_name = 'root' if label.startswith('root-') else 'payload' if label.startswith('payload-') else 'directory'
        iteration = 1 if label.endswith('-after') else 0
        need((object_name, iteration) in natives, 'extra without same-FD native observation')
        n = natives[object_name, iteration]
        need(n['fd'] == r['fd'] and r['fd'] >= 0, 'same-FD observation binding')
        for field, size in (('statx',256),('tune',232),('flags',8)): rawhex(r[field]['hex'], size)
        mr = r['statmount']; req = rawhex(mr['request_hex'], 32)
        need(struct.unpack('<IIQQQ', req)[:2] == (32,0) and struct.unpack('<IIQQQ', req)[3:] == (59,0) and mr['flags'] == 0, 'statmount current namespace request')
        sx = decode_statx(rawhex(r['statx']['hex']))
        need(struct.unpack_from('<Q', req, 8)[0] == sx['unique_id'], 'statmount request not from this FD')
        if any(r[k]['rc'] != 0 for k in ('statx','tune','flags','statmount')):
            problems.append(label+':GET_UNAVAILABLE'); continue
        sm = decode_statmount(rawhex(mr['hex'])); tune = decode_tune(rawhex(r['tune']['hex']))
        flags = struct.unpack('<Q', rawhex(r['flags']['hex']))[0]
        before, after = n['before'], n['after']
        need(before == after and n['before_rc'] == n['after_rc'] == 0, 'source metadata changed within native read')
        need(before['uid'] == uid and before['gid'] == gid, 'source owner')
        need(sx['ino'] == int(before['ino']) and sx['mode'] == int(before['mode']) and sx['size'] == int(before['size']) and sx['uid'] == uid and sx['gid'] == gid, 'raw statx vs fstat')
        need(sx['mask'] & 0x4fff == 0x4fff, 'statx required mask')
        need(inode_guard(flags, sx['attributes'], sx['attributes_mask'], directory=object_name!='payload'), 'unknown/unsafe inode flags or DAX')
        uuid = n['fsuuid']; fid = n['fid_unique']; legacy = n['statx_legacy']
        need(uuid['rc'] == 0 and uuid['length'] == 16 and rawhex(uuid['hex'],16) != bytes(16), 'same-FD UUID')
        need(fid['rc'] == 0 and fid['handle_type'] == 1 and fid['handle_bytes'] == 8, 'same-FD opaque FID')
        rawhex(fid['hex'],8)
        need(n['fs_rc'] == 0 and n['fs_magic'] == 'ef53' and sm['magic'] == 0xef53 and sm['type'] == 'ext4', 'native ext4')
        need(sm['unique_id'] == sx['unique_id'] == int(fid['mount_id']) == int(n['statx_unique']['mount_id']), 'unique mount triangulation')
        need(legacy['rc'] == 0 and legacy['mask'] & 0x17ff == 0x17ff and sm['legacy_id'] == int(legacy['mount_id']), 'legacy mount binding')
        need((sm['dev_major'],sm['dev_minor']) == (sx['dev_major'],sx['dev_minor']) == (legacy['dev_major'],legacy['dev_minor']), 'current device binding')
        parsed[label] = {'statx':sx, 'mount':sm, 'tune':tune, 'flags':flags, 'uuid':uuid['hex'], 'fid':fid['hex'], 'fd':r['fd']}
    if 'root-before' in parsed and 'root-after' in parsed:
        need(parsed['root-before'] == parsed['root-after'], 'root config/FD changed between observations')
    context = {}
    for phase in ('before','after'):
        pp = [r for r in rows if r.get('kind') == 'pseudo' and r.get('phase') == phase]
        need(len({r['name'] for r in pp}) == len(pp), 'duplicate pseudo source')
        p = {r['name']:r for r in pp}
        for key in ('mountinfo','device-dev','device-uevent','proc-options'):
            if key not in p or p[key]['rc'] != 0: problems.append(phase+':'+key+':UNAVAILABLE')
        if problems or 'root-before' not in parsed: continue
        binding = [r for r in rows if r.get('kind') == 'sysfs-binding' and r.get('phase') == phase]
        need(len(binding) == 1 and binding[0]['valid_name'], 'sysfs FD name binding'); b = binding[0]
        n = parsed['root-'+phase]; sx, sm = n['statx'], n['mount']
        need(b['source_fd'] == n['fd'] and (b['dev_major'],b['dev_minor']) == (sx['dev_major'],sx['dev_minor']), 'sysfs bound to different source FD')
        need(re.fullmatch('[A-Za-z0-9_.-]{1,31}', b['sb_id']) and b['resolved'].startswith('/sys/devices/') and b['resolved'].split('/')[-1] == b['sb_id'], 'sysfs name family')
        need(rawhex(p['device-dev']['hex']).decode().strip() == f"{sx['dev_major']}:{sx['dev_minor']}", 'sysfs device value')
        ue = rawhex(p['device-uevent']['hex']).decode().splitlines()
        need(ue.count('DEVNAME='+b['sb_id']) == 1, 'DEVNAME relation')
        need(p['proc-options']['relative'] == 'fs/ext4/'+b['sb_id']+'/options', 'wrong A/B proc association')
        for name, q in p.items():
            if q['rc'] == 0: need(q['fs_magic'] == ('9fa0' if name in ('mountinfo','proc-options') else '62656572'), 'pseudo FS type')
        mounts = mountinfo(rawhex(p['mountinfo']['hex'])); selected = [v for v in mounts if v['id'] == sm['legacy_id']]
        need(len(selected) == 1, 'one current mountinfo row'); mi = selected[0]
        need(mi['root'] == sm['root'] and mi['point'] == sm['point'] and mi['device'] == f"{sx['dev_major']}:{sx['dev_minor']}" and mi['type'] == 'ext4', 'mountinfo/statmount/FD mismatch')
        context[phase] = {'binding':{k:v for k,v in b.items() if k!='phase'}, 'options':options(rawhex(p['proc-options']['hex'])), 'mountinfo':mi,
                          'pseudo_identity':{k:(p[k]['dev'],p[k]['ino'],p[k]['hex']) for k in ('device-dev','device-uevent','proc-options')}}
    if len(context) == 2: need(context['before'] == context['after'], 'effective/sysfs/mount mapping changed')
    for key in ('mount-root','file-before','file-after','absent-leaf'): need(key in opaths, 'missing O_PATH source record')
    anchor = decode_statx(rawhex(opaths['mount-root']['statx_hex'],256))
    need(opaths['mount-root']['rc'] == 0, 'O_PATH root evidence')
    if 'root-before' in parsed: need(anchor['unique_id'] == parsed['root-before']['statx']['unique_id'], 'O_PATH mount mismatch')
    need(opaths['absent-leaf']['rc'] == -1 and opaths['absent-leaf']['errno'] == 2, 'absent-ancestor guard')
    need(rawhex(opaths['file-before']['statx_hex'],256) == rawhex(opaths['file-after']['statx_hex'],256), 'file O_PATH metadata changed')
    guards = [r for r in rows if r.get('kind') == 'root-path-guard']; need(len(guards) == 1 and guards[0]['same'], 'held root/path guard')
    ordinary = [r for r in rows if r.get('kind') == 'step' and r.get('action') == 'ordinary-open']
    need(len(ordinary) == (1 if mode == 'ordinary' else 0), 'first ordinary-open count')
    if mode == 'ordinary':
        need(ordinary[0]['rc'] == 0, 'ordinary content open did not complete')
        attempts=[r for r in rows if r.get('kind')=='step' and r.get('action')=='ordinary-open-attempt']
        closes=[r for r in rows if r.get('kind')=='step' and r.get('action')=='close' and r.get('role')=='payload']
        need(len(attempts)==1 and len(closes)==1 and closes[0]['fd']==ordinary[0]['fd'], 'actual ordinary open/close lifetime')
        need(int(attempts[0]['monotonic_ns'])<=int(ordinary[0]['monotonic_ns'])<=int(closes[0]['monotonic_ns']), 'native ordinary event time order')
        content = [r for r in rows if r.get('kind') == 'content']; need(len(content) == 1 and content[0]['errno'] == 0 and content[0]['fd'] == ordinary[0]['fd'], 'content same-FD')
        need(len(rawhex(content[0]['hex'])) <= 1048576, 'content bound')
        guard = [r for r in rows if r.get('kind') == 'payload-path-guard']; need(len(guard) == 1 and guard[0]['same'] and guard[0]['fd'] == ordinary[0]['fd'], 'content path revalidation')
        # One held content FD owns the entire read interval; pairwise getter matches are insufficient.
        need({'payload-before','payload-after','root-before','root-after'}<=parsed.keys(), 'payload lifecycle requires complete current getters')
        before,after=parsed['payload-before'],parsed['payload-after']
        first,last=natives['payload',0],natives['payload',1]
        fd=ordinary[0]['fd'];need(type(fd) is int and fd>0, 'positive ordinary content FD')
        chain=[ordinary[0],first,extra['payload-before'],content[0],last,extra['payload-after'],guard[0],closes[0]]
        need(all(r.get('pid')==pid and r.get('fd')==fd for r in chain), 'payload getter/content/open/guard/close FD lifecycle mismatch')
        need(attempts[0].get('pid')==pid, 'ordinary attempt PID')
        stable_fields=('dev','ino','mode','nlink','size','uid','gid','mtime','ctime')
        need(before==after and all(first['before'][k]==last['after'][k] for k in stable_fields), 'payload identity/metadata/config changed across content read')
        root=parsed['root-before']
        need(before['uuid']==root['uuid'] and before['mount']==root['mount'] and before['tune']==root['tune'], 'payload not in current root filesystem/config')
        need(decode_statx(rawhex(opaths['file-before']['statx_hex'],256))==before['statx'], 'payload getter not the current source path object')
        need(opaths['file-before']['rc']==opaths['file-after']['rc']==0, 'current payload O_PATH guard failed')
        need(len(rawhex(content[0]['hex']))==before['statx']['size'], 'content bytes do not match held file size')
        positions={id(r):i for i,r in enumerate(rows)}
        ordered=[extra['root-before'],attempts[0],*chain,extra['root-after']]
        need(all(positions[id(a)]<positions[id(b)] for a,b in zip(ordered,ordered[1:])), 'payload read lifecycle record order')
        start,end=positions[id(ordinary[0])],positions[id(closes[0])]
        need(not any(r.get('kind')=='step' and r.get('fd')==fd for r in rows[start+1:end]), 'content FD closed/reused during held read')
    kernel = [r for r in rows if r.get('kind') == 'uname']; need(len(kernel) == 1 and {k:kernel[0][k] for k in TARGET} == TARGET, 'actual target kernel')
    notes = [r for r in rows if r.get('kind') == 'pseudo' and r.get('name') == 'kernel-notes']
    if len(notes) != 1 or notes[0]['rc'] != 0 or not rawhex(notes[0]['hex']): problems.append('BUILD_NOTES_UNAVAILABLE')
    return {'pid':pid, 'uid':uid, 'gid':gid, 'parsed':parsed, 'context':context, 'anchor':anchor,
            'problems':problems, 'rows':rows, 'exit':rows[-1]['status']}


def sb(raw):
    if isinstance(raw,str): raw = rawhex(raw,1024)
    need(len(raw) == 1024 and raw[56:58] == b'\x53\xef', 'raw ext4 superblock')
    return {'uuid':raw[104:120].hex(), 'last_mounted':raw[136:200].split(b'\0',1)[0], 'checksum':raw[1020:1024].hex()}


def cold_result(data):
    """只允许完整配对正向写证据为 FAIL；未见变化永远不是 cold PASS。"""
    try:
        control, regular = data['control'], data['regular']
        for row, ordinary in ((control,False),(regular,True)):
            need(0 < len(row['point'].encode()) < 64 and row['point'].startswith('/') and row['point'] != data['prepare_point'], 'cold mount point')
            need(row['image_identity'] == data['image_identity'] and row['observer_domain_valid'], 'same owned image/source observer')
            expected = ['cold-mounted','path-observer-before','provider-start'] + (['ordinary-open'] if ordinary else []) + ['provider-end','path-observer-after','raw-post','flush','raw-flush','unmount','raw-unmount']
            need([v['kind'] for v in row['events']] == expected, 'cold first-open/flush order')
            if ordinary: need(row['events'][3]['actor'] == 'provider', 'observer preopened regular source')
            states = [sb(row[k]) for k in ('pre','post','flush','unmount')]
            need(all(s['uuid'] == data['uuid'] for s in states), 'SB actual object UUID')
        need(control['point'] != regular['point'], 'distinct cold rounds')
        c = [sb(control[k]) for k in ('pre','post','flush','unmount')]
        r = [sb(regular[k]) for k in ('pre','post','flush','unmount')]
        need(all(v['last_mounted'] == c[0]['last_mounted'] for v in c), 'directory/control itself changed sampled field')
        need(r[0]['last_mounted'] == c[-1]['last_mounted'], 'control/ordinary lifecycle chain')
        if r[2]['last_mounted'] == r[3]['last_mounted'] == regular['point'].encode() and r[0]['last_mounted'] != r[2]['last_mounted'] and r[0]['checksum'] != r[2]['checksum']:
            return {'status':'FAIL','reason':'PROVIDER_PERSISTENT_SB_SAMPLE', 'scope':'paired owned fixture first ordinary open'}
        return {'status':'INCONCLUSIVE','reason':'NO_CHANGE_IS_NOT_A_PREOPEN_COLD_RULE'}
    except (Invalid,KeyError,TypeError,ValueError) as error:
        return {'status':'INCONCLUSIVE','reason':'INSUFFICIENT_COLD_ATTRIBUTION: '+str(error)}


def base_summary():
    return {'schema':'fs-ext4-r04-evidence/v1','revision':REVISION,'integrity':'UNVERIFIED',
            'M':{k:{'status':'NOT_RUN'} for k in M_IDS}, 'production_runtime':'UNSUPPORTED',
            'cold_open_rule':'UNRESOLVED', **RELEASE}


def _consume(files, expected_source, profile_raw, allow_synthetic, sealed):
    need(isinstance(files,dict) and 8 <= len(files) <= 512 and sum(len(v) for v in files.values()) <= 64*1024*1024, 'bundle count/size')
    need(all(re.fullmatch('[A-Za-z0-9_./-]+',k) and not k.startswith('/') and '..' not in k.split('/') for k in files), 'bundle paths')
    required = {'manifest.json','profile.json','source.json','execution.json','cleanup.json','summary.json','events.jsonl','binary.json','native-probe'}
    need(required <= files.keys(), 'missing required original')
    manifest = strict_json(files['manifest.json']); actual = {k:sha(v) for k,v in files.items() if k!='manifest.json'}
    need(manifest == {'schema':'fs-ext4-r04-manifest/v1','files':actual}, 'complete original manifest mismatch')
    need(files['profile.json'] == profile_raw, 'profile raw bytes changed')
    profile = strict_json(profile_raw); need(profile['revision'] == REVISION and profile['target'] == TARGET, 'profile identity')
    need(profile['source_files'] == list(FILES) and all(profile[k] == RELEASE[k] for k in RELEASE), 'profile scope/release')
    source = strict_json(files['source.json']); need(source == expected_source, 'actual source identity mismatch')
    need(re.fullmatch('[a-f0-9]{40}',source['commit']) and re.fullmatch('[a-f0-9]{40}',source['tree']) and set(source['files']) == set(FILES), 'source commit/tree/scope')
    for name, entry in source['files'].items():
        need(entry['mode'] == '100644' and re.fullmatch('[a-f0-9]{40}',entry['blob']) and re.fullmatch('[a-f0-9]{64}',entry['sha256']), 'source mode/blob/hash')
    need(source['files'][PREFIX+'profile.json']['sha256'] == sha(profile_raw), 'profile not exact source blob')
    binary = strict_json(files['binary.json']); need(binary['sha256'] == sha(files['native-probe']), 'binary original mismatch')
    cleanup = strict_json(files['cleanup.json'])
    need(cleanup['status'] == 'PASS' and cleanup['children_reaped'] is True and cleanup['owned_mounts_remaining'] == [] and cleanup['owned_loops_remaining'] == [], 'cleanup incomplete')
    need(not cleanup.get('unknown_attach_images',[]) and not cleanup.get('errors',[]), 'unknown resource side effect')
    execution = strict_json(files['execution.json']); summary = strict_json(files['summary.json'])
    need(execution['completed'] is True, 'incomplete execution')
    result = base_summary(); result['integrity'] = 'PASS'
    if execution['mode'] == 'synthetic-control':
        need(allow_synthetic and execution['platform_run'] is False, 'synthetic bundle is not hosted evidence')
        need(files.get('raw/local-control.bin') == b'R04-local-control\x00\xff\n', 'complete control original')
        need(execution['control_original_sha256'] == sha(files['raw/local-control.bin']), 'control original binding')
        need(strict_json(files['events.jsonl']) == {'event':'synthetic-generator','platform_run':False}, 'synthetic provenance')
    else:
        need(execution['mode'] == 'hosted-fixture' and execution['platform_run'] is True, 'unknown execution mode')
        need(execution.get('synthetic') is False or (execution.get('synthetic') is True and allow_synthetic), 'synthetic host-shape controls are not platform evidence')
        need(strict_json(files['environment.json'])['target'] == TARGET, 'target runtime snapshot')
        fixture = strict_json(files['fixture.json']); events = [strict_json(x) for x in files['events.jsonl'].splitlines()]
        completed = {e['label']:e for e in events if e.get('event') == 'child-exited'}
        starts = {e['label']:e for e in events if e.get('event') == 'child-start'}
        for key in ('A','B'):
            receipt=strict_json(files['cleanup/detached-'+key+'.json'])
            need(receipt['unconfigured'] is True and receipt['errno']==6,'actual loop unconfigured receipt')
            command=completed.get('detach-'+key,{});need(command.get('returncode')==0 and command.get('reaped') and not command.get('timed_out'),'detach command receipt')
        parsed = {}
        for label, mode in (('control','context'),('regular','ordinary'),('variant','context')):
            key='provider-'+label; need(key in completed and key in starts and completed[key]['reaped'] and not completed[key]['timed_out'], 'provider child receipt')
            raw = files['commands/'+key+'.stdout']; row = parse_stream(raw,mode); parsed[label]=row
            need(row['pid'] == completed[key]['pid'] == starts[key]['pid'] and row['exit'] == completed[key]['returncode'], 'actual provider process/exit binding')
            need(starts[key]['argv'][-5:] == [fixture['binary_path'],mode,str(fixture['uid']),str(fixture['gid']),fixture['points'][label]], 'provider argv/source/identity binding')
            need(files['commands/'+key+'.stderr'] == b'', 'provider stderr not silently ignored')
            need(row['uid'] == fixture['uid'] and row['gid'] == fixture['gid'], 'fixture ordinary owner')
        need(parsed['control']['pid'] != parsed['regular']['pid'], 'new provider process')
        handoff=strict_json(files['handoff.json'])
        need(handoff['status']=='PASS' and handoff['uid']==fixture['uid'] and handoff['gid']==fixture['gid'] and
             handoff['root_identity']==fixture['root_identity'], 'complete owned-tree handoff identity')
        entries=handoff['entries'];need(isinstance(entries,list) and 1<=len(entries)<=512, 'bounded owned-tree handoff')
        by_path={row['path']:row for row in entries};need(len(by_path)==len(entries), 'duplicate handoff entry')
        need({'.','.fsqual-marker.json','native-probe','A.ext4','B.ext4','evidence'} |
             {'evidence/'+name for name in files} <= by_path.keys(), 'handoff does not cover actual originals')
        for path,row in by_path.items():
            need(path=='.' or (re.fullmatch('[A-Za-z0-9_./-]+',path) and not path.startswith('/') and
                               all(p not in ('','..','.') for p in path.split('/'))), 'handoff relative path')
            need(row['dev']==fixture['root_identity'][0] and type(row['ino']) is int and row['ino']>0 and
                 row['uid']==fixture['uid'] and row['gid']==fixture['gid'], 'handoff actual recipient/device')
            need(row['kind'] in ('file','directory') and type(row['mode']) is int and
                 (row['mode']==0o700 if row['kind']=='directory' else (row['mode']&0o400)!=0), 'handoff readable/deletable mode')
            if path!='.':need(by_path.get(path.rpartition('/')[0] or '.',{}).get('kind')=='directory', 'handoff missing parent')
        need([by_path['.']['dev'],by_path['.']['ino']]==fixture['root_identity'] and by_path['.']['kind']=='directory', 'handoff root object')
        for row in parsed.values():
            if 'root-before' in row['parsed']: need(row['parsed']['root-before']['mount']['point'] in fixture['points'].values(), 'provider source outside owned mountpoints')
        cold = {'prepare_point':fixture['prepare_point'], 'image_identity':fixture['images']['A']['identity'], 'uuid':fixture['images']['A']['uuid']}
        for label in ('control','regular'):
            row = strict_json(files['rounds/'+label+'.json'])
            need(row['point'] == fixture['points'][label] and row['image_identity'] == fixture['images']['A']['identity'], 'cold round source identity')
            record = dict(row)
            actual_root=parsed[label]['parsed'].get('root-before')
            need(actual_root is not None and actual_root['uuid']==fixture['images']['A']['uuid'], 'native source UUID vs raw image')
            for phase in ('pre','post','flush','unmount'):
                record[phase] = files[f'raw/{label}-{phase}.sb']
                need(struct.unpack_from('<I',record[phase],224)[0]==8, 'actual internal journal inode8')
                receipt=strict_json(files[f'raw/{label}-{phase}-receipt.json'])
                validate_loop_receipt(receipt,fixture['images']['A']['identity'],actual_root['statx'])
            before = strict_json(files['views/'+label+'-before.json']); after = strict_json(files['views/'+label+'-after.json'])
            validate_source_view(before,parsed[label],files['expected-payload.bin'])
            validate_source_view(after,parsed[label],files['expected-payload.bin'])
            record['observer_domain_valid'] = before == after and before['ordinary_source_open_count'] == 0
            need(files['commands/'+label+'-offline-content.stdout'] == files['expected-payload.bin'], 'offline source content baseline')
            if label=='regular':
                contents = [r for r in parsed[label]['rows'] if r.get('kind')=='content']
                need(len(contents)==1 and rawhex(contents[0]['hex']) == files['expected-payload.bin'], 'actual content bytes')
            actual_events = [e for e in events if e.get('round')==label and e.get('event')=='cold-step']
            need(row['events'] == [e['value'] for e in actual_events], 'round/event original cross-binding')
            ordinary = [r for r in parsed[label]['rows'] if r.get('kind')=='step' and r.get('action')=='ordinary-open']
            need(sum(e['kind']=='ordinary-open' for e in row['events'])==len(ordinary), 'native/harness ordinary-open count')
            for suffix in ('flush','unmount','offline-content','journal-before','journal-after'):
                key=label+'-'+suffix
                need(key in completed and completed[key]['returncode']==0 and completed[key]['reaped'] and not completed[key]['timed_out'], 'raw observer/flush/cleanup receipt: '+key)
                need('commands/'+key+'.stdout' in files and 'commands/'+key+'.stderr' in files, 'missing journal/command originals')
            for phase in ('before','after'):
                raw=files[f'raw/{label}-journal-{phase}.bin']; receipt=strict_json(files[f'raw/{label}-journal-{phase}-receipt.json'])
                need(1024<=len(raw)<=8*1024*1024 and receipt['bytes']==len(raw) and receipt['sha256']==sha(raw), 'journal original size/hash')
                magic,kind,_sequence,block_size,blocks=struct.unpack_from('>IIIII',raw)
                need(magic==0xc03b3998 and kind in (3,4) and block_size in (1024,2048,4096) and block_size*blocks==len(raw),'complete internal JBD2 journal geometry')
                validate_loop_receipt(receipt['loop_binding'],fixture['images']['A']['identity'],actual_root['statx'])
            if label=='regular':
                opened=ordinary[0]
                need(starts['provider-regular']['monotonic']<=int(opened['monotonic_ns'])/1e9<=completed['provider-regular']['monotonic'], 'native open outside actual child lifetime')
            cold[label] = record
        problems = sorted({p for row in parsed.values() for p in row['problems']})
        result['M'] = {
            'M01':{'status':'BLOCKED' if problems else 'INCONCLUSIVE','reason':'GET/BUILD evidence unavailable' if problems else 'vendor source/built-in/module association requires independent interpretation','problems':problems},
            'M02':{'status':'INCONCLUSIVE','reason':'actual defaults/effective originals collected; no automatic reference table or dynamic feature-bit rule'},
            'M03':{'status':'INCONCLUSIVE','reason':'actual ordinary flags/DAX originals; exact reference not registered'},
            'M04':{'status':'INCONCLUSIVE','reason':'backing object and original production writer/source guards unresolved'},
            'M05':cold_result(cold)}
        a,b = parsed['control'],parsed['variant']
        if 'root-before' in a['parsed'] and 'root-before' in b['parsed']:
            aa,bb = a['parsed']['root-before'],b['parsed']['root-before']
            need(aa['uuid'] != bb['uuid'] and aa['statx']['unique_id'] != bb['statx']['unique_id'], 'two actual different filesystems')
            need(bb['uuid']==fixture['images']['B']['uuid'], 'variant native UUID vs own image')
            need(aa['tune']['default_mnt_opts'] != bb['tune']['default_mnt_opts'], 'controlled defaults did not differ')
        controls = strict_json(files['topology-controls.json'])
        need(controls['idmap']['status']=='NOT_RUN' and controls['production_writer_coverage']=='UNPROVEN', 'topology open gates')
        for label in ('whole-alias','subdir-alias'):
            need('commands/provider-'+label+'.stdout' in files and controls[label]['status'] in ('OBSERVED','BLOCKED'), 'alias raw control missing')
            rows=[strict_json(line) for line in files['commands/provider-'+label+'.stdout'].splitlines()]
            pid,uid,gid=_identity(rows[0]);need(uid==fixture['uid'] and gid==fixture['gid'],'alias ordinary identity')
            key='provider-'+label;need(key in completed and key in starts and completed[key]['pid']==starts[key]['pid']==pid and completed[key]['reaped'] and not completed[key]['timed_out'],'alias process original')
            extras=[r for r in rows if r.get('kind')=='r04-extra' and r.get('label')=='root-before']
            anchors=[r for r in rows if r.get('kind')=='opath' and r.get('label')=='mount-root']
            need(len(extras)==len(anchors)==1,'alias root originals')
            need(extras[0]['statmount']['rc']==0 and anchors[0]['rc']==0,'alias mount/anchor observation')
            view=decode_statmount(rawhex(extras[0]['statmount']['hex']));anchor=decode_statx(rawhex(anchors[0]['statx_hex'],256))
            need(view['point']==fixture['points'][label],'alias actual point')
            mechanical=topology(view,anchor,writer_covered=True)
            need(mechanical['mechanical_view']=='WHOLE_ROOT_CANDIDATE' if label=='whole-alias' else mechanical['status']=='UNSUPPORTED','alias actual geometry control')
        if execution['synthetic']:
            result['M']={k:{'status':'NOT_RUN'} for k in M_IDS}
    if sealed: need(summary == result, 'summary not derived from complete consumed originals')
    return result


def validate_loop_receipt(receipt, identity, sx):
    raw=rawhex(receipt['raw_loop_info64_hex'],232)
    dev,ino,_rdev,offset,limit=struct.unpack_from('<QQQQQ',raw)
    need([dev,ino]==identity==receipt['image_identity'] and offset==limit==0, 'raw observer backing object binding')
    # Linux gnu_dev encoding, not a loopN name allowlist.
    number=receipt['loop_rdev'];major=(number>>8)&0xfff | (number>>32)&0xfffff000
    minor=number&0xff | (number>>12)&0xffffff00
    need((major,minor)==(sx['dev_major'],sx['dev_minor']), 'raw loop vs same-FD ext4 device')


def validate_source_view(view, native, payload):
    need(view['ordinary_source_open_count']==0 and view['method']=='O_PATH+lstat+listxattr/getxattr; no regular read','non-prewarming observer method')
    objects=view['objects'];need(set(objects)=={'.','payload','directory','ancestor'},'complete path observer domain')
    root=native['parsed']['root-before']['statx'];dev=os.makedev(root['dev_major'],root['dev_minor'])
    fields={'dev','ino','mode','uid','gid','nlink','size','rdev','blocks','atime_ns','mtime_ns','ctime_ns'}
    for name,row in objects.items():
        s=row['stat'];need(set(s)==fields and all(type(v) is int and v>=0 for v in s.values()),'complete path stat fields')
        need(s['dev']==dev and s['uid']==native['uid'] and s['gid']==native['gid'],'observer source owner/device')
        need(stat.S_ISREG(s['mode']) if name=='payload' else stat.S_ISDIR(s['mode']),'observer type')
        need(isinstance(row['xattrs'],dict) and row['xattrs'].get('user.boardroom-r04')==b'owned-fixture'.hex(),'full fixture xattr canary')
        for value in row['xattrs'].values():rawhex(value)
        if name=='payload':need(s['nlink']==1 and s['size']==len(payload),'regular content baseline shape')
    need(objects['.']['stat']['ino']==root['ino'],'observer root current object')


def consume(files, expected_source, profile_raw, *, allow_synthetic=False, sealed=True):
    try: return _consume(files,expected_source,profile_raw,allow_synthetic,sealed)
    except (KeyError,TypeError,ValueError,UnicodeError,struct.error,OverflowError) as error:
        if isinstance(error,Invalid): raise
        raise Invalid('invalid complete evidence bundle: '+str(error)) from None

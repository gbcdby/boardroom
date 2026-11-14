"""固定 R04 消费者的未修改只读 ABI/身份检查函数；不带旧 COLD 结论或 matcher。
原件 SHA256 e084cc6ad09221b28900db373e4bcbe3c7dad2aee9fc0b0261ba1dda3d946fb2。
复用仅表示同 FD/原始字段语义，不授予新 profile 支持。
"""
from __future__ import annotations
import hashlib
import json
import re
import struct

TARGET = {'sysname': 'Linux', 'machine': 'x86_64', 'release': '7.0.0-1017-azure',
          'version': '#17~24.04.1-Ubuntu SMP PREEMPT Thu Sep 24 18:46:57 UTC 2026'}
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

#!/usr/bin/env python3
"""R04 的离线消费者控制；不 mount、不切 UID、不调用实际 provider。"""
from __future__ import annotations
import copy
import errno
import json
import os
import signal
import subprocess
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / 'scripts/qualification/fs-native-ext4-r04'
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import checks as C


def statmount(root='/', point='/tmp/r04/a', *, mask=59, attr=0, ino_id=9001, minor=0):
    strings = b'ext4\0' + root.encode() + b'\0' + point.encode() + b'\0'
    raw = bytearray(512 + len(strings))
    struct.pack_into('<IIQIIQIIQQIIQQQQQII', raw, 0, len(raw), 0, mask,
                     7, minor, 0xef53, 0, 0, ino_id, 9000, 42+minor, 41,
                     attr, 1 << 18, 0, 0, 0, 5, 6 + len(root))
    raw[512:] = strings
    return bytes(raw)


def wire_stream(point,mode='context',*,minor=0,pid=2001,mount_root='/',root_ino=2):
    """手工 ABI/协议夹具；标 synthetic，不执行 C 的 runtime probe。"""
    import run as R
    unique=9001+minor;fsuuid=('a1' if minor==0 else 'b2')*16
    def sx(ino,regular=False):
        data=bytearray(256)
        struct.pack_into('<I',data,0,0x4fff);struct.pack_into('<Q',data,56,0x200000)
        struct.pack_into('<IIIH',data,16,1 if regular else 2,1001,1001,0o100600 if regular else 0o40700)
        struct.pack_into('<QQ',data,32,ino,len(R.PAYLOAD) if regular else 1024)
        struct.pack_into('<IIQ',data,136,7,minor,unique);return bytes(data)
    def meta(ino,regular=False):
        return {'dev':str(os.makedev(7,minor)),'ino':str(ino),'mode':str(0o100600 if regular else 0o40700),
                'nlink':'1' if regular else '2','size':str(len(R.PAYLOAD) if regular else 1024),'uid':1001,'gid':1001,
                'atime':['0','0'],'mtime':['0','0'],'ctime':['0','0']}
    def native(obj,iteration,fd,ino,regular=False):
        m=meta(ino,regular)
        return {'kind':'native-observation','object':obj,'iteration':iteration,'pid':pid,'fd':fd,
                'before_rc':0,'after_rc':0,'before':m,'after':dict(m),'fs_rc':0,'fs_magic':'ef53',
                'fsuuid':{'rc':0,'length':16,'hex':fsuuid},
                'fid_unique':{'rc':0,'handle_type':1,'handle_bytes':8,'hex':struct.pack('<II',ino,4).hex(),'mount_id':str(unique)},
                'statx_legacy':{'rc':0,'mask':0x17ff,'mount_id':str(42+minor),'dev_major':7,'dev_minor':minor},
                'statx_unique':{'mount_id':str(unique)}}
    def extra(label,fd,ino,regular=False):
        tune=bytearray(232);struct.pack_into('<I',tune,40,8 if minor==0 else 0)
        struct.pack_into('<III',tune,64,0x3c,0x2c2,0x46b)
        return {'kind':'r04-extra','label':label,'pid':pid,'fd':fd,
          'statx':{'rc':0,'errno':0,'hex':sx(ino,regular).hex()},
          'tune':{'rc':0,'errno':0,'ioctl':'80e8662d','hex':tune.hex()},
          'flags':{'rc':0,'errno':0,'hex':struct.pack('<Q',0x80000).hex()},
          'statmount':{'rc':0,'errno':0,'flags':0,'request_hex':struct.pack('<IIQQQ',32,0,unique,59,0).hex(),
                       'hex':statmount(mount_root,point,ino_id=unique,minor=minor).hex()}}
    rows=[{'kind':'process-identity','pid':pid,'uid':[1001]*4,'gid':[1001]*4,
           'supplementary_group_count':0,'no_new_privs':1,'capabilities':{k:'0000000000000000' for k in C.CAPS}},
          {'kind':'uname',**C.TARGET},
          {'kind':'pseudo','name':'kernel-notes','phase':'build','rc':0,'hex':'01020304'},
          native('root',0,3,root_ino),extra('root-before',3,root_ino),
          native('directory',0,4,12),extra('directory',4,12)]
    for phase in ('before','after'):
        rows.append({'kind':'sysfs-binding','phase':phase,'source_fd':3,'dev_major':7,'dev_minor':minor,
                     'sysfs_inode':'500','sysfs_dev':'24','resolved':f'/sys/devices/virtual/block/loop{minor}',
                     'sb_id':f'loop{minor}','valid_name':True})
        raw={'device-dev':f'7:{minor}\n'.encode(),'device-uevent':f'MAJOR=7\nMINOR={minor}\nDEVNAME=loop{minor}\n'.encode(),
             'proc-options':b'rw,data=ordered,errors=remount-ro,acl,user_xattr\n',
             'mountinfo':f'{42+minor} 41 7:{minor} {mount_root} {point} rw,relatime - ext4 /dev/loop{minor} rw,errors=remount-ro,data=ordered\n'.encode()}
        for name,data in raw.items():
            rows.append({'kind':'pseudo','phase':phase,'name':name,'rc':0,'errno':0,'hex':data.hex(),
                         'relative':f'fs/ext4/loop{minor}/options' if name=='proc-options' else name,
                         'fs_magic':'9fa0' if name in ('mountinfo','proc-options') else '62656572','dev':'24','ino':'900'})
    for label,ino,regular in (('mount-root',root_ino,False),('file-before',13,True),('file-after',13,True)):
        rows.append({'kind':'opath','pid':pid,'label':label,'fd':7,'rc':0,'errno':0,'statx_hex':sx(ino,regular).hex()})
    rows.append({'kind':'opath','pid':pid,'label':'absent-leaf','fd':-1,'rc':-1,'errno':2,'statx_hex':bytes(256).hex()})
    if mode=='ordinary':
        rows += [{'kind':'step','pid':pid,'action':'ordinary-open-attempt','role':'payload','fd':-1,'rc':0,'monotonic_ns':'1400000000'},
                 {'kind':'step','pid':pid,'action':'ordinary-open','role':'payload','fd':5,'rc':0,'monotonic_ns':'1500000000'},
                 native('payload',0,5,13,True),extra('payload-before',5,13,True),
                 {'kind':'content','pid':pid,'fd':5,'errno':0,'hex':R.PAYLOAD.hex()},
                 native('payload',1,5,13,True),extra('payload-after',5,13,True),
                 {'kind':'payload-path-guard','pid':pid,'fd':5,'same':True},
                 {'kind':'step','pid':pid,'action':'close','role':'payload','fd':5,'rc':0,'monotonic_ns':'2000000000'}]
    rows += [extra('root-after',3,root_ino),native('root',1,3,root_ino),{'kind':'root-path-guard','same':True},
             {'kind':'complete','pid':pid,'mode':mode,'status':0}]
    return rows


def hosted_shape_files(path):
    """完整原件图由真实 writer/manifest/seal 消费；全部内容明确 synthetic。"""
    import run as R
    source,profile=R.local_fixture(path);files=R.originals(path);files.pop('raw/local-control.bin')
    def put(name,value,raw=False):files[name]=value if raw else C.encoded(value)
    points={k:'/tmp/r04/'+v for k,v in {'control':'c','regular':'r','variant':'v','whole-alias':'w','subdir-alias':'s'}.items()}
    fixture={'uid':1001,'gid':1001,'root_identity':[123,999],'binary_path':'/tmp/r04/native-probe','prepare_point':'/tmp/r04/p','points':points,
             'images':{'A':{'identity':[123,456],'uuid':'a1'*16,'bytes':67108864},'B':{'identity':[123,457],'uuid':'b2'*16,'bytes':67108864}}}
    put('fixture.json',fixture);put('environment.json',{'target':C.TARGET})
    put('execution.json',{'mode':'hosted-fixture','platform_run':True,'synthetic':True,'completed':True})
    put('expected-payload.bin',R.PAYLOAD,True);events=[]
    def child(label,argv,out=b'',pid=3000):
        put('commands/'+label+'.stdout',out,True);put('commands/'+label+'.stderr',b'',True)
        events.extend([{'event':'child-start','label':label,'argv':argv,'pid':pid,'monotonic':1},
                       {'event':'child-exited','label':label,'returncode':0,'pid':pid,'reaped':True,'timed_out':False,'monotonic':3}])
    for i,label in enumerate(points):
        mode='ordinary' if label=='regular' else 'context';minor=1 if label=='variant' else 0
        rows=wire_stream(points[label],mode,minor=minor,pid=2001+i,
                         mount_root='/directory' if label=='subdir-alias' else '/',root_ino=12 if label=='subdir-alias' else 2)
        child('provider-'+label,[fixture['binary_path'],mode,'1001','1001',points[label]],
              b''.join(json.dumps(r).encode()+b'\n' for r in rows),2001+i)
    cold=R.cold_control_fixture()
    loop_raw=bytearray(232);struct.pack_into('<QQ',loop_raw,0,123,456)
    binding={'image_identity':[123,456],'loop_rdev':os.makedev(7,0),'loop_inode':99,'raw_loop_info64_hex':loop_raw.hex()}
    for label in ('control','regular'):
        row=copy.deepcopy(cold[label]);row['point']=points[label];row['observer_domain_valid']=False
        for phase in ('pre','post','flush','unmount'):
            raw=bytearray(row.pop(phase));struct.pack_into('<I',raw,224,8)
            put(f'raw/{label}-{phase}.sb',bytes(raw),True);put(f'raw/{label}-{phase}-receipt.json',binding)
        put('rounds/'+label+'.json',row)
        for value in row['events']:events.append({'event':'cold-step','round':label,'value':value,'monotonic':4})
        objects={}
        for name,ino in (('.',2),('payload',13),('directory',12),('ancestor',14)):
            s={'dev':os.makedev(7,0),'ino':ino,'mode':0o100600 if name=='payload' else 0o40700,'uid':1001,'gid':1001,
               'nlink':1 if name=='payload' else 2,'size':len(R.PAYLOAD) if name=='payload' else 1024,'rdev':0,'blocks':8,'atime_ns':0,'mtime_ns':0,'ctime_ns':0}
            objects[name]={'stat':s,'xattrs':{'user.boardroom-r04':b'owned-fixture'.hex()}}
        view={'ordinary_source_open_count':0,'method':'O_PATH+lstat+listxattr/getxattr; no regular read','objects':objects}
        put('views/'+label+'-before.json',view);put('views/'+label+'-after.json',view)
        for suffix in ('flush','unmount','offline-content','journal-before','journal-after'):
            child(label+'-'+suffix,['synthetic',suffix],R.PAYLOAD if suffix=='offline-content' else b'')
        for phase in ('before','after'):
            journal=bytearray(4096);struct.pack_into('>IIIII',journal,0,0xc03b3998,4,1,1024,4);journal=bytes(journal)
            put(f'raw/{label}-journal-{phase}.bin',journal,True)
            put(f'raw/{label}-journal-{phase}-receipt.json',{'loop_binding':binding,'bytes':len(journal),'sha256':C.sha(journal)})
    put('topology-controls.json',{'idmap':{'status':'NOT_RUN'},'production_writer_coverage':'UNPROVEN',
       'whole-alias':{'status':'OBSERVED'},'subdir-alias':{'status':'OBSERVED'}})
    for key,minor in (('A',0),('B',1)):
        child('detach-'+key,['losetup','-d','/dev/loop'+str(minor)])
        put('cleanup/detached-'+key+'.json',{'unconfigured':True,'errno':6,'loop_rdev':os.makedev(7,minor)})
    put('events.jsonl',b''.join(json.dumps(e).encode()+b'\n' for e in events),True)
    paths={'.':'directory','.fsqual-marker.json':'file','native-probe':'file','A.ext4':'file','B.ext4':'file','evidence':'directory'}
    for name in set(files)|{'handoff.json'}:
        path=Path('evidence')/name;paths[path.as_posix()]='file'
        for parent in path.parents:
            if str(parent)!='.':paths[parent.as_posix()]='directory'
    put('handoff.json',{'status':'PASS','uid':1001,'gid':1001,'root_identity':[123,999],
        'entries':[{'path':p,'dev':123,'ino':999 if p=='.' else 2000+i,'kind':kind,'uid':1001,'gid':1001,'mode':0o700 if kind=='directory' else 0o600}
                   for i,(p,kind) in enumerate(sorted(paths.items()))]})
    files=R.reseal_memory(files)
    result=C.consume(files,source,profile,allow_synthetic=True,sealed=False)
    put('summary.json',result);files=R.reseal_memory(files)
    return files,source,profile


class NativeAndMatcherContract(unittest.TestCase):
    def test_statmount_full_root_uses_real_mask_ids_and_strings(self):
        row = C.decode_statmount(statmount())
        self.assertEqual((row['root'], row['point'], row['unique_id'], row['legacy_id']),
                         ('/', '/tmp/r04/a', 9001, 42))

    def test_statmount_absent_mask_and_bad_offset_are_not_defaults(self):
        for data in (statmount(mask=27), statmount()[:511]):
            with self.assertRaises(C.Invalid): C.decode_statmount(data)
        data = bytearray(statmount()); struct.pack_into('<I', data, 108, 999999)
        with self.assertRaises(C.Invalid): C.decode_statmount(bytes(data))

    def test_options_no_duplicates_unknown_or_omitted_defaults(self):
        self.assertEqual(C.options(b'rw\ndata=ordered\nerrors=remount-ro\n'),
                         {'rw': True, 'data': 'ordered', 'errors': 'remount-ro'})
        for raw in (b'acl\nacl\n', b'data=ordered,data=journal\n', b'data=\n', b'bad\\040value\n'):
            with self.assertRaises(C.Invalid): C.options(raw)
        self.assertEqual(C.match_runtime(None, {})['reason'], 'NO_REGISTERED_ENTRY')
        for entry in ({}, {'production_enable': True}, {'cold_open_rule': None},
                      {'effective_options_reference': {'unknown': None}}):
            self.assertEqual(C.match_runtime(entry, {})['status'], 'UNSUPPORTED')

    def test_topology_does_not_invent_no_bind_history_or_writer_guard(self):
        row = C.decode_statmount(statmount())
        anchor = {'ino': 2, 'unique_id': 9001, 'dev_major': 7, 'dev_minor': 0}
        self.assertEqual(C.topology(row, anchor, writer_covered=True)['mechanical_view'], 'WHOLE_ROOT_CANDIDATE')
        self.assertEqual(C.topology(row, anchor, writer_covered=False)['status'], 'UNSUPPORTED')
        for changed in (C.decode_statmount(statmount(root='/child')),
                        C.decode_statmount(statmount(attr=0x100000))):
            self.assertEqual(C.topology(changed, anchor, writer_covered=True)['status'], 'UNSUPPORTED')
        wrong = dict(anchor, unique_id=9002)
        self.assertEqual(C.topology(row, wrong, writer_covered=True)['status'], 'UNSUPPORTED')

    def test_visible_inode_and_dax_require_positive_valid_mask(self):
        self.assertTrue(C.inode_guard(0x80000, 0, 0x200000, directory=False))
        self.assertTrue(C.inode_guard(0x81000, 0, 0x200000, directory=True))
        for flags, attrs, mask in ((0x80000, 0, 0), (0x80000, 0x200000, 0x200000),
                                  (0x80000 | 0x40000000, 0, 0x200000), (0x81000, 0, 0x200000)):
            self.assertFalse(C.inode_guard(flags, attrs, mask, directory=False))


class BundleContract(unittest.TestCase):
    def test_unknown_detach_error_is_not_success(self):
        import observer as O
        for error in (errno.EPERM,errno.EIO,errno.EINVAL):
            with mock.patch.object(O.os,'open',return_value=41),mock.patch.object(O.os,'fstat',return_value=SimpleNamespace(st_mode=0o60600,st_rdev=1792)),mock.patch.object(O.os,'close'),mock.patch.object(O.fcntl,'ioctl',side_effect=OSError(error,'synthetic')):
                with self.assertRaises(O.Stop):O.loop_detached('/dev/loop0',1792)
        with mock.patch.object(O.os,'open',return_value=41),mock.patch.object(O.os,'fstat',return_value=SimpleNamespace(st_mode=0o60600,st_rdev=1792)),mock.patch.object(O.os,'close'),mock.patch.object(O.fcntl,'ioctl',side_effect=OSError(errno.ENXIO,'synthetic')):
            self.assertTrue(O.loop_detached('/dev/loop0',1792)['unconfigured'])

    def test_full_hosted_original_graph_is_consumed_not_status_labels(self):
        import run as R
        with tempfile.TemporaryDirectory(prefix='r04-wire-') as tmp:
            files,source,profile=hosted_shape_files(Path(tmp)/'seed')
            result=C.consume(files,source,profile,allow_synthetic=True)
            self.assertEqual(result['integrity'],'PASS')
            self.assertTrue(all(v['status']=='NOT_RUN' for v in result['M'].values()))
            with self.assertRaises(C.Invalid):C.consume(files,source,profile)
            for kind in ('missing-journal','wrong-image','wrong-proc','wrong-getter-FD','empty-view','alias-tag-only','bad-cap','raw-statx-device'):
                bad=dict(files)
                if kind=='missing-journal':del bad['raw/regular-journal-before.bin']
                elif kind=='wrong-image':
                    r=C.strict_json(bad['raw/regular-pre-receipt.json']);r['image_identity']=[123,999]
                    bad['raw/regular-pre-receipt.json']=C.encoded(r)
                elif kind=='empty-view':bad['views/regular-before.json']=C.encoded({'ordinary_source_open_count':0,'objects':{}})
                elif kind=='alias-tag-only':bad['commands/provider-whole-alias.stdout']=b'{"status":"PASS"}\n'
                else:
                    rows=[C.strict_json(l) for l in bad['commands/provider-control.stdout'].splitlines()]
                    if kind=='wrong-proc':
                        for r in rows:
                            if r.get('name')=='proc-options':r['relative']='fs/ext4/loop1/options'
                    elif kind=='wrong-getter-FD':
                        next(r for r in rows if r.get('label')=='root-before')['fd']=99
                    elif kind=='bad-cap':rows[0]['capabilities']['CapBnd']='0000000000000001'
                    else:
                        r=next(r for r in rows if r.get('label')=='root-before');raw=bytearray.fromhex(r['statx']['hex'])
                        struct.pack_into('<I',raw,140,9);r['statx']['hex']=raw.hex()
                    bad['commands/provider-control.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in rows)
                bad=R.reseal_memory(bad)
                with self.subTest(kind=kind):
                    with self.assertRaises(C.Invalid):C.consume(bad,source,profile,allow_synthetic=True)

    def test_empty_and_handwritten_pass_are_rejected(self):
        for files in ({}, {'summary.json': b'{"status":"PASS"}\n'},
                      {'manifest.json': b'{"files":{}}\n'}):
            with self.assertRaises(C.Invalid): C.consume(files, {}, b'{}\n')

    def test_full_generation_and_consumption_then_independent_damage(self):
        import run as R
        with tempfile.TemporaryDirectory(prefix='r04-offline-') as tmp:
            root = Path(tmp) / 'bundle'
            source, profile = R.local_fixture(root)
            files = R.originals(root)
            result = C.consume(files, source, profile, allow_synthetic=True)
            self.assertEqual(result['integrity'], 'PASS')
            self.assertTrue(all(v['status'] == 'NOT_RUN' for v in result['M'].values()))
            self.assertEqual(result['accepted_provider_profiles'], [])
            with self.assertRaises(C.Invalid): C.consume(files, source, profile)
            for mutation in ('missing', 'profile', 'source', 'pretend-pass', 'unlisted', 'raw-binding', 'cleanup', 'unknown-attach'):
                bad = dict(files)
                if mutation == 'missing': del bad['raw/local-control.bin']
                elif mutation == 'profile': bad['profile.json'] += b' '
                elif mutation == 'source':
                    row = json.loads(bad['source.json']); row['commit'] = 'f' * 40
                    bad['source.json'] = C.encoded(row)
                elif mutation == 'pretend-pass':
                    row = json.loads(bad['summary.json']); row['M']['M05']['status'] = 'PASS'
                    bad['summary.json'] = C.encoded(row)
                elif mutation == 'unlisted': bad['unlisted'] = b'no'
                elif mutation == 'raw-binding': bad['raw/local-control.bin'] = b'changed'
                elif mutation=='cleanup':
                    row = json.loads(bad['cleanup.json']); row['children_reaped'] = False
                    bad['cleanup.json'] = C.encoded(row)
                else:
                    row=json.loads(bad['cleanup.json']);row['unknown_attach_images']=['A']
                    bad['cleanup.json']=C.encoded(row)
                # 即使攻击者重新计算清单，消费者仍须核原件语义/准确来源。
                if mutation != 'unlisted': bad = R.reseal_memory(bad)
                with self.subTest(mutation=mutation):
                    with self.assertRaises(C.Invalid): C.consume(bad, source, profile, allow_synthetic=True)

    def test_cold_order_and_sb_attribution(self):
        import run as R
        fixture = R.cold_control_fixture()
        result = C.cold_result(fixture)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['reason'], 'PROVIDER_PERSISTENT_SB_SAMPLE')
        nochange = copy.deepcopy(fixture)
        nochange['regular']['flush'] = nochange['regular']['pre']
        nochange['regular']['unmount'] = nochange['regular']['pre']
        self.assertEqual(C.cold_result(nochange)['status'], 'INCONCLUSIVE')
        for mutate in ('preopen', 'longpath', 'samepath', 'no-flush', 'different-image', 'control-wrote'):
            bad = copy.deepcopy(fixture)
            if mutate == 'preopen': bad['regular']['events'].insert(1, {'kind':'ordinary-open', 'actor':'observer'})
            elif mutate == 'longpath': bad['regular']['point'] = '/' + 'x' * 64
            elif mutate == 'samepath': bad['regular']['point'] = bad['prepare_point']
            elif mutate == 'no-flush': del bad['regular']['flush']
            elif mutate == 'different-image': bad['regular']['image_identity'][1] += 1
            else: bad['control']['flush'] = bad['regular']['flush']
            with self.subTest(mutate=mutate):
                self.assertNotEqual(C.cold_result(bad)['status'], 'FAIL')


class ReviewFix1Contract(unittest.TestCase):
    def test_payload_lifecycle_through_actual_seal_and_import(self):
        import run as R
        with tempfile.TemporaryDirectory(prefix='r04-fix1-payload-') as tmp:
            files,source,profile=hosted_shape_files(Path(tmp)/'seed')
            self.assertEqual(C.consume(files,source,profile,allow_synthetic=True)['integrity'],'PASS')
            for case in ('split-fd','post-fid','post-uuid','post-tune','foreign-fs','wrong-path-object','post-metadata','reordered-getter','early-close'):
                bad=dict(files);rows=[C.strict_json(l) for l in files['commands/provider-regular.stdout'].splitlines()]
                ns=[r for r in rows if r.get('kind')=='native-observation' and r.get('object')=='payload']
                es=[r for r in rows if r.get('kind')=='r04-extra' and r.get('label','').startswith('payload-')]
                if case=='split-fd':
                    for r in ns+es:r['fd']=99
                elif case=='post-fid':ns[1]['fid_unique']['hex']='deadc0debaadf00d'
                elif case=='post-uuid':ns[1]['fsuuid']['hex']='dd'*16
                elif case=='post-tune':
                    raw=bytearray.fromhex(es[1]['tune']['hex']);struct.pack_into('<I',raw,40,9);es[1]['tune']['hex']=raw.hex()
                elif case=='foreign-fs':
                    for r in ns:r['fsuuid']['hex']='dd'*16
                elif case=='wrong-path-object':
                    for r in ns:
                        r['before']['ino']=r['after']['ino']='99';r['fid_unique']['hex']='9988776655443322'
                    for r in es:
                        raw=bytearray.fromhex(r['statx']['hex']);struct.pack_into('<Q',raw,32,99);r['statx']['hex']=raw.hex()
                elif case=='post-metadata':
                    ns[1]['before']['ctime']=ns[1]['after']['ctime']=['9','0']
                elif case=='reordered-getter':
                    rows.remove(es[0]);index=next(i for i,r in enumerate(rows) if r.get('kind')=='content');rows.insert(index+1,es[0])
                else:
                    index=next(i for i,r in enumerate(rows) if r.get('kind')=='content')
                    rows.insert(index,{'kind':'step','pid':2002,'action':'close','role':'unexpected','fd':5,'rc':0,'monotonic_ns':'1600000000'})
                bad['commands/provider-regular.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in rows)
                bad=R.reseal_memory(bad);path=Path(tmp)/case;path.mkdir()
                for name,raw in bad.items():(path/name).parent.mkdir(parents=True,exist_ok=True);(path/name).write_bytes(raw)
                results={}
                for operation in ('import','seal'):
                    try:
                        result=C.consume(R.originals(path),source,profile,allow_synthetic=True) if operation=='import' else R.seal(path,source,profile,synthetic=True)
                        results[operation]='ACCEPTED:'+result['integrity']
                    except C.Invalid as error:results[operation]='REJECTED:'+str(error)
                print(json.dumps({'fix1':'REQ-001','case':case,'results':results},sort_keys=True))
                with self.subTest(case=case):self.assertTrue(all(v.startswith('REJECTED:') for v in results.values()),results)

    def test_owned_handoff_closes_real_directory_delete_permission(self):
        import support as S
        self.assertNotEqual(os.geteuid(),0)
        self.assertEqual(int(S.identity()['CapEff'],16),0)
        with tempfile.TemporaryDirectory(prefix='r04-fix1-dac-') as tmp:
            root=Path(tmp)/'owned';root.mkdir();st=root.stat();token='handoff-control'
            S.write_file(root/'.fsqual-marker.json',S.encoded({'root':str(root),'root_identity':[st.st_dev,st.st_ino],'token':token,'uid':os.getuid(),'gid':os.getgid()}))
            ev=S.Evidence(root/'evidence');ev.file('commands/sample.stdout',b'owned\n',raw=True);ev.file('raw/sample.bin',b'raw',raw=True)
            denied=ev.path/'commands';denied.chmod(0o555)
            try:
                with self.assertRaises(PermissionError):S.remove_owned_tree(denied,st.st_dev)
                resources={'status':'PASS','children_reaped':True,'owned_mounts_remaining':[],'owned_loops_remaining':[],'unknown_attach_images':[],'errors':[]}
                receipt=S.handoff_owned_tree(root,token,os.getuid(),os.getgid(),resources)
                self.assertEqual(receipt['status'],'PASS')
                self.assertTrue(all(r['uid']==os.getuid() and r['gid']==os.getgid() for r in receipt['entries']))
                S.remove_owned_tree(root,st.st_dev);self.assertFalse(root.exists())
                print(json.dumps({'fix1':'STD-001','ordinary_uid':os.getuid(),'effective_caps':S.identity()['CapEff'],'initial_delete':'EACCES','handoff_entries':len(receipt['entries']),'actual_delete':'PASS','cross_uid_hosted':'NOT_RUN'},sort_keys=True))
            finally:
                if denied.exists():denied.chmod(0o700)

    def test_handoff_preserves_unknown_resource_and_symlink_target(self):
        import support as S
        with tempfile.TemporaryDirectory(prefix='r04-fix1-handoff-') as tmp:
            root=Path(tmp)/'owned';root.mkdir();st=root.stat();token='guard-control'
            S.write_file(root/'.fsqual-marker.json',S.encoded({'root':str(root),'root_identity':[st.st_dev,st.st_ino],'token':token,'uid':os.getuid(),'gid':os.getgid()}))
            directory=root/'readonly';directory.mkdir(mode=0o500);before=directory.stat().st_mode
            good={'status':'PASS','children_reaped':True,'owned_mounts_remaining':[],'owned_loops_remaining':[],'unknown_attach_images':[],'errors':[]}
            with self.assertRaises(S.Stop):S.handoff_owned_tree(root,token,os.getuid(),os.getgid(),dict(good,unknown_attach_images=['A']))
            self.assertEqual(directory.stat().st_mode,before)
            outside=Path(tmp)/'outside';outside.write_bytes(b'untouched');outside.chmod(0o400);saved=outside.stat()
            (root/'unknown-link').symlink_to(outside)
            with self.assertRaises(S.Stop):S.handoff_owned_tree(root,token,os.getuid(),os.getgid(),good)
            self.assertEqual(directory.stat().st_mode,before)
            self.assertEqual((outside.stat().st_mode,outside.stat().st_uid,outside.read_bytes()),(saved.st_mode,saved.st_uid,b'untouched'))
            directory.chmod(0o700)

    def test_spawn_receipt_errors_reap_real_owned_child_and_preserve_cause(self):
        import support as S
        for case in ('normal','start-stop','start-io','spawn-signal'):
            with self.subTest(case=case),tempfile.TemporaryDirectory(prefix='r04-fix1-child-') as tmp:
                ev=S.Evidence(Path(tmp)/'evidence');original_event=ev.event;created=[];popen=subprocess.Popen
                failure=OSError(errno.EIO,'owned child-start write failure') if case=='start-io' else S.Stop('owned cancellation '+case,'INCONCLUSIVE')
                previous=signal.getsignal(signal.SIGALRM)
                def cancelled(_sig,_frame):raise failure
                if case=='spawn-signal':signal.signal(signal.SIGALRM,cancelled)
                def track(*args,**kwargs):
                    p=popen(*args,**kwargs);created.append(p)
                    if case=='spawn-signal':os.kill(os.getpid(),signal.SIGALRM)
                    return p
                def event(kind,**fields):
                    if kind=='child-start' and case in ('start-stop','start-io'):raise failure
                    return original_event(kind,**fields)
                ev.event=event;observed=None;before_cleanup=[]
                try:
                    with mock.patch.object(S.subprocess,'Popen',side_effect=track):
                        try:
                            ev.call('owned-control',[sys.executable,'-c','print("owned-normal")' if case=='normal' else 'import time;time.sleep(20)'],2)
                        except BaseException as error:observed=error
                    for p in created:
                        rc=p.poll();reaped=False
                        if rc is not None:
                            try:os.waitpid(p.pid,os.WNOHANG)
                            except ChildProcessError:reaped=True
                        before_cleanup.append({'pid':p.pid,'returncode':rc,'reaped':reaped})
                    print(json.dumps({'fix1':'STD-002','case':case,'before_test_cleanup':before_cleanup,'registry_remaining':len(ev.children),'original_exception_preserved':observed is failure if case!='normal' else observed is None},sort_keys=True))
                    self.assertTrue(created and all(r['reaped'] for r in before_cleanup),before_cleanup)
                    self.assertEqual(ev.children,{})
                    if case=='normal':self.assertIsNone(observed)
                    else:self.assertIs(observed,failure)
                finally:
                    signal.signal(signal.SIGALRM,previous)
                    # Only test-owned children; old RED is cleaned without hiding pre-cleanup facts.
                    for p in created:
                        if p.poll() is None:S.stop_child(p)
                        p.communicate(timeout=1)
                        ev.children.pop(p.pid,None)


if __name__ == '__main__': unittest.main(verbosity=2)

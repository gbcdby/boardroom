"""有限资格消费者控制；synthetic 输入不代表任何目标环境已资格。"""
import copy
import errno
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.dont_write_bytecode=True
HERE = Path(__file__).resolve().parents[1] / 'scripts/qualification/fs-native-ext4'
spec = importlib.util.spec_from_file_location('ext4_checks', HERE / 'checks.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)

def native():
    meta = {'dev':'2049','ino':'123','mode':'33152','nlink':'1','size':'4','uid':1000,'gid':1000,
            'atime':['1','0'],'mtime':['2','123'],'ctime':['2','456']}
    return {'kind':'native-observation','object':'file-root','mode':'provider','pid':10,'fd':5,'iteration':0,
            'before_rc':0,'before_errno':0,'before':meta,'after_rc':0,'after_errno':0,'after':copy.deepcopy(meta),
            'fs_rc':0,'fs_errno':0,'fs_magic':'ef53',
            'statx_legacy':{'rc':0,'errno':0,'requested_mask':0x17ff,'mask':0x17ff,'mount_id':'77','dev_major':8,'dev_minor':1},
            'statx_unique':{'rc':0,'errno':0,'requested_mask':0x4fff,'mask':0x4fff,'mount_id':'4294967377',
                            'btime':['1','42'],'attributes':'0','attributes_mask':'2097152'},
            'fsuuid':{'rc':0,'errno':0,'length':16,'hex':'1234567890abcdef1234567890abcdef'},
            'fid_unique':{'rc':0,'errno':0,'mount_id':'4294967377','handle_type':1,'handle_bytes':8,'hex':'0100000002000000'},
            'same_fd_metadata_stable':True,'statx_metadata_matches':True,'strict_shape':True}

class CodecContract(unittest.TestCase):
    def test_exact_ext4_same_fd_and_uint64_unique_id(self):
        self.assertEqual(checks.validate_native(native())[0], 'PASS')

    def test_other_filesystem_uuid_fid_shapes_and_errno_reject(self):
        changes=[('fs_magic',None,'794c7630'),('fsuuid','hex','0'*32),('fsuuid','length',15),
                 ('fsuuid','hex','A'*32),('fid_unique','handle_type',2),('fid_unique','handle_type',248),
                 ('fid_unique','handle_bytes',32),('fid_unique','hex','01'*9)]
        for field,key,value in changes:
            with self.subTest(field=field,key=key,value=value):
                r=native()
                if key is None:r[field]=value
                else:r[field][key]=value
                self.assertNotEqual(checks.validate_native(r)[0],'PASS')
        for code in (errno.EOPNOTSUPP,errno.ENOTTY,errno.EPERM,errno.ENOSYS,errno.EOVERFLOW):
            r=native();r['fid_unique'].update(rc=-1,errno=code)
            self.assertNotEqual(checks.validate_native(r)[0],'PASS')

    def test_separate_effective_mount_masks_device_and_dax_required(self):
        for field,key,value in [('statx_unique','requested_mask',0x5fff),('statx_legacy','requested_mask',0x4fff),
          ('statx_unique','mask',0x17ff),('statx_legacy','mask',0x7ff),('statx_unique','mount_id','81'),
          ('fid_unique','mount_id','81'),('statx_unique','mount_id',str(2**64)),
          ('statx_legacy','dev_major',9),('statx_unique','attributes_mask','0'),('statx_unique','attributes','2097152')]:
            with self.subTest(field=field,key=key,value=value):
                r=native();r[field][key]=value;self.assertNotEqual(checks.validate_native(r)[0],'PASS')

    def test_metadata_change_owner_links_and_missing_fields_reject(self):
        for change in ('ctime','owner','links','missing','statx'):
            r=native()
            if change=='ctime':r['after']['ctime']=['2','457']
            elif change=='owner':r['before']['uid']=r['after']['uid']=0
            elif change=='links':r['before']['nlink']=r['after']['nlink']='2'
            elif change=='missing':del r['before']['ctime']
            else:r['statx_metadata_matches']=False
            self.assertNotEqual(checks.validate_native(r)[0],'PASS')

def view(record=None,kind='file'):
    r=copy.deepcopy(record or native())
    if kind=='directory':r['before']['mode']=r['after']['mode']='16832';r['before']['nlink']=r['after']['nlink']='2'
    return {'file-root':{'native':r,'witness':checks.witness(r),'metadata':r['before'],'btime':r['statx_unique']['btime'],'content_sha256':'a'*64,'kind':kind}}

def batch():
    entry,proof=MountAndLifecycleContract().fixture()
    first=native();last=copy.deepcopy(first);last['iteration']=1
    ident={'kind':'process-identity','pid':10,'uid':[1000]*4,'gid':[1000]*4,'verified':True,
           'supplementary_group_count':0,'no_new_privs':1,'capabilities':dict.fromkeys(('CapInh','CapPrm','CapEff','CapBnd','CapAmb'),'0000000000000000')}
    records=[ident,first,{'kind':'content-read','object':'file-root','pid':10,'fd':5,'rc':0,'errno':0,'bytes':4,'hex':b'data'.hex()},last,
             {'kind':'path-guard','object':'file-root','same_object':True,'root_stable':True},
             {'kind':'fd-closed','object':'file-root','fd':5,'rc':0},{'kind':'root-closed','fd':4,'rc':0}]
    return {'returncode':0,'reaped':True,'records':records,'mountinfo_before':[entry],'mountinfo_after':[entry],'mode':'provider'},proof

ONE_CASE=(('file-root','file-root','file'),)

class ReviewCorrections(unittest.TestCase):
    def status(self,expected,fn):
        with self.assertRaises(checks.CheckError) as caught:fn()
        self.assertEqual(caught.exception.status,expected)

    def test_q10_requires_one_applied_same_number_fd_reuse_and_actual_rejection(self):
        value,_=batch();value['returncode']=70
        self.status('BLOCKED',lambda:checks.validate_fd_reuse(value,'file-root'))
        injection={'kind':'fd-reuse-injection','object':'file-root','pid':10,'old_fd':5,'new_fd':5,
                   'close_rc':0,'open_rc':5,'dup_attempted':False,'dup_rc':-2,'close_errno':0,'open_errno':0,'dup_errno':0,'applied':True,'test_only':True}
        value['records'].insert(2,injection)
        self.status('FAIL',lambda:checks.validate_fd_reuse(value,'file-root'))
        changed=value['records'][4]
        for m in ('before','after'):changed[m].update(dev='5',ino='6',mode='8630')
        value['records'][5]['same_object']=False
        self.assertTrue(checks.validate_fd_reuse(value,'file-root')['actual_object_changed'])
        dup=copy.deepcopy(value);dup['records'][2].update(open_rc=6,dup_attempted=True,dup_rc=5)
        self.assertTrue(checks.validate_fd_reuse(dup,'file-root')['actual_object_changed'])
        for key,v in [('new_fd',-1),('new_fd',6),('applied',False),('close_rc',-1),('open_rc',-1)]:
            broken=copy.deepcopy(value);broken['records'][2][key]=v
            self.status('BLOCKED',lambda:checks.validate_fd_reuse(broken,'file-root'))
        duplicate=copy.deepcopy(value);duplicate['records'].insert(2,copy.deepcopy(injection))
        self.status('INCONCLUSIVE',lambda:checks.validate_fd_reuse(duplicate,'file-root'))
        no_rejection=copy.deepcopy(value);no_rejection['records'][5]['same_object']=True
        self.status('FAIL',lambda:checks.validate_fd_reuse(no_rejection,'file-root'))

    def test_q03_actual_fs_root_is_required_and_has_no_non_atime_waiver(self):
        entry={**native()['before'],'xattrs':{'trusted.control':'aa'},'inode_flags':0}
        before={name:{'entries':{'.':copy.deepcopy(entry)}} for name in ('fs-root','control','provider')}
        self.assertEqual(set(checks.cold_compare(before,copy.deepcopy(before),copy.deepcopy(before))),set(before))
        for field,value in [('ctime',['9','1']),('xattrs',{}),('inode_flags',1)]:
            after=copy.deepcopy(before);after['fs-root']['entries']['.'][field]=value
            self.status('FAIL',lambda:checks.cold_compare(before,copy.deepcopy(before),after))
        missing=copy.deepcopy(before);del missing['fs-root']
        self.status('INCONCLUSIVE',lambda:checks.cold_compare(missing,before,before))

    def test_q11_mount_injection_is_guaranteed_different_including_old_constant(self):
        sys.path.insert(0,str(HERE));spec=importlib.util.spec_from_file_location('ext4_fault_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        for actual in ('4294967378',str(2**64-1),'1'):
            r=native();r['statx_unique']['mount_id']=r['fid_unique']['mount_id']=actual
            results=runner.fault_controls(r)
            row=next(v for v in results if v.get('field')=='statx_unique.mount_id')
            self.assertEqual(row['original_value'],actual);self.assertNotEqual(row['injected_value'],actual)
            self.assertTrue(0<int(row['injected_value'])<2**64);self.assertEqual(row['observed_rejection'],'FAIL')

    def test_q01_environment_status_comes_from_raw_identity_or_syscalls(self):
        value,proof=batch();value['returncode']=77;value['records']=value['records'][:1];value['records'][0]['verified']=False;value['records'][0]['uid']=[0]*4
        self.status('BLOCKED',lambda:checks.validate_batch(value,ONE_CASE,1000,1000,proof))
        value,proof=batch();value['returncode']=69
        for r in value['records']:
            if r['kind']=='native-observation':r['fsuuid'].update(rc=-1,errno=errno.ENOTTY)
        self.status('BLOCKED',lambda:checks.validate_batch(value,ONE_CASE,1000,1000,proof))
        value,proof=batch();value['returncode']=69;value['records']=[]
        self.status('INCONCLUSIVE',lambda:checks.validate_batch(value,ONE_CASE,1000,1000,proof))
        for fault in ('metadata','mount'):
            value,proof=batch();value['returncode']=70
            if fault=='metadata':value['records'][1]['after']['ctime']=['9','2']
            else:value['records'][1]['fid_unique']['mount_id']='9'
            self.status('FAIL',lambda:checks.validate_batch(value,ONE_CASE,1000,1000,proof))

    def test_std002_disk_frozen_records_are_consumed_inside_an_actual_new_process(self):
        value,proof=batch()
        # 仅synthetic旧native PID；1不会与仍有父进程的实际child PID或其+1相撞。
        for record in value['records']:
            if 'pid' in record:record['pid']=1
        observations=checks.validate_batch(value,ONE_CASE,1000,1000,proof)
        frozen={'schema_version':checks.FROZEN_SCHEMA,'root':'/owned/mount/provider','uid':1000,'gid':1000,
                'cases':[list(v) for v in ONE_CASE],'all_native_children_reaped':True,
                'mount_proof':proof,'observations':observations,'batch':value}
        parent_memory=copy.deepcopy(observations)
        script="""import sys,json,os
sys.path.insert(0,sys.argv[1]);import checks
from pathlib import Path
try:
    current=json.loads(Path(sys.argv[4]).read_bytes());current['records'][0]['pid']=os.getpid()+1
    for r in current['records']:
        if 'pid' in r:r['pid']=os.getpid()+1
    receipt=checks.consume_frozen(Path(sys.argv[2]).read_bytes(),Path(sys.argv[3]).read_bytes(),current,
        json.loads(sys.argv[5]),'/owned/mount/provider',(('file-root','file-root','file'),),1000,1000,os.getpid())
    print(json.dumps(receipt))
except checks.CheckError as error:
    print(json.dumps({'status':error.status,'reason':str(error)}));sys.exit(2)
"""
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)
            for fault in ('valid','new_mount','deleted','raw_deleted','empty','extra_object','changed','coherent_changed','duplicate'):
                document=copy.deepcopy(frozen)
                current=copy.deepcopy(value)
                if fault=='new_mount':
                    for r in current['records']:
                        if r['kind']=='native-observation':r['statx_legacy']['mount_id']='78';r['statx_unique']['mount_id']=r['fid_unique']['mount_id']='4294967378'
                    for e in current['mountinfo_before']+current['mountinfo_after']:e['id']='78'
                if fault=='deleted':del document['observations']
                elif fault=='raw_deleted':del document['batch']
                elif fault=='empty':document['observations']={}
                elif fault=='extra_object':document['observations']['unexpected']=copy.deepcopy(observations['file-root'])
                elif fault=='changed':document['observations']['file-root']['metadata']['ctime']=['99','7']
                elif fault=='coherent_changed':
                    for row in document['batch']['records']:
                        if row['kind']=='native-observation':
                            for field in ('before','after'):row[field]['ctime']=['99','7']
                    document['observations']=checks.validate_batch(document['batch'],ONE_CASE,1000,1000,proof)
                data=json.dumps(document).encode()
                if fault=='duplicate':data=data[:-1]+b',"observations":{}}'
                (p/'current.json').write_text(json.dumps(current));(p/'frozen.json').write_bytes(data);(p/'sidecar').write_text(hashlib.sha256(data).hexdigest()+'\n')
                result=subprocess.run([sys.executable,'-I','-B','-c',script,str(HERE),str(p/'frozen.json'),str(p/'sidecar'),str(p/'current.json'),json.dumps(proof)],capture_output=True,text=True,timeout=2)
                with self.subTest(fault=fault):
                    receipt=json.loads(result.stdout)
                    self.assertEqual(result.returncode,0 if fault in ('valid','new_mount') else 2,result.stderr)
                    if fault in ('valid','new_mount'):self.assertNotEqual(receipt['consumer_pid'],os.getpid());self.assertEqual(receipt['comparison'],'equal')
                    if fault=='coherent_changed':self.assertEqual(receipt['status'],'FAIL');self.assertIn('source_changed',receipt['reason'])
                    self.assertEqual(observations,parent_memory)

class ResultBundleContract(unittest.TestCase):
    """构造完整synthetic原件封包，仅验证消费者，不表示真实Q运行。"""
    def labels_only_bundle(self):
        import hashlib
        def encode(value):return (json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
        profile=(HERE/'profile.json').read_bytes();source=json.loads(profile)
        candidate={'commit':'1'*40,'tree':'2'*40,'files':dict.fromkeys(source['source_files'],'a'*64)}
        candidate['files']['scripts/qualification/fs-native-ext4/profile.json']=hashlib.sha256(profile).hexdigest()
        cleanup={'status':'PASS','children':[],'mounts_released':True,'loop_detached':True,'children_reaped':True}
        summary=checks.base_summary();summary.update(candidate=candidate,execution_status='COMPLETE')
        files={p:encode({'synthetic_control':True}) for paths in checks.Q_REQUIRED.values() for p in paths}
        files.update({'profile.json':profile,'candidate.json':encode(candidate),'binary.json':encode({'sha256':'b'*64}),
                      'environment.json':encode({'uname':['Linux','control','synthetic','synthetic','x86_64',''],'process':{'Uid':'1000'},'os_release':'synthetic only'}),
                      'cleanup.json':encode(cleanup)})
        events=[{'event':'start','pid':1}]
        for key in checks.CHECKS:
            summary['checks'][key]={'status':'PASS','detail':cleanup if key=='EX4-Q12' else {'synthetic_control':True},'evidence':sorted(checks.Q_REQUIRED[key])}
            if key!='EX4-Q12':events.extend([{'event':'phase-start','phase':key},{'event':'phase-end','phase':key}])
        for path in list(files):
            if path.startswith('native/'):
                value,_=batch();files[path]=encode(value);label=Path(path).stem
                files['commands/'+label+'.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in value['records']);files['commands/'+label+'.stderr']=b''
                events.extend([{'event':'child-start','label':label,'pid':10},{'event':'child-exited','label':label,'pid':10,'returncode':0,'reaped':True}])
            elif path.startswith('actions/'):
                value={'synthetic_control':True,'all_old_native_children_reaped':True};files[path]=encode(value);label=Path(path).stem
                files['commands/'+label+'.stdout']=encode({'synthetic_control':True});files['commands/'+label+'.stderr']=b''
                events.extend([{'event':'child-start','label':label,'pid':11},{'event':'child-exited','label':label,'pid':11,'returncode':0,'reaped':True}])
        for name in files:
            if name.startswith('commands/') and name.endswith('.stdout'):
                label=Path(name).stem
                if not any(e.get('event')=='child-start' and e.get('label')==label for e in events):
                    events.extend([{'event':'child-start','label':label,'pid':12},{'event':'child-exited','label':label,'pid':12,'returncode':0,'reaped':True}])
        files['events.jsonl']=b''.join(json.dumps(v).encode()+b'\n' for v in events);files['summary.json']=encode(summary)
        return files,candidate,summary


    def bundle(self):
        """实际writer/normalizer生成结构完整的synthetic封包，绝不作为native资格。"""
        sys.path.insert(0,str(HERE));spec=importlib.util.spec_from_file_location('ext4_producer',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        import support,hashlib
        files,candidate,summary=self.labels_only_bundle()
        with tempfile.TemporaryDirectory() as tmp:
            ev=support.Evidence(Path(tmp)/'evidence');runner.profile(ev)
            profile=(ev.path/'profile.json').read_bytes();self.assertEqual(profile,(HERE/'profile.json').read_bytes())
            candidate=runner.candidate(ev)
        def put(name,value):files[name]=support.encoded(value)
        put('candidate.json',candidate);files['profile.json']=profile;summary['candidate']=candidate
        entry,initial=MountAndLifecycleContract().fixture();initial['entry']=entry
        latest=copy.deepcopy(initial);latest['entry']['id']='78'
        put('mount/mount-native.json',initial);put('mount/lifecycle-mount.json',latest)
        def make(cases,proof=initial,pid=10,lookup=False,changes=None):
            changes=changes or {};base,_=batch();records=[copy.deepcopy(base['records'][0])];records[0]['pid']=pid
            for index,(label,relative,kind) in enumerate(cases):
                r=native();r.update(object=label,pid=pid,fd=index+5,mode='lookup' if lookup else 'provider')
                number=2 if label=='fs-root' else 100+next(i for i,row in enumerate(checks.CASES) if row[0]==label)
                meta={**r['before'],'ino':str(number),'mode':'16832' if kind=='directory' else '33152','nlink':'2' if kind=='directory' else '1','size':'4096' if kind=='directory' else '4'}
                meta.update(changes.get(label,{}).get('metadata',{}));r['before']=meta;r['after']=copy.deepcopy(meta)
                r['fid_unique']['hex']=changes.get(label,{}).get('fid',f'{number:016x}')
                r['statx_legacy']['mount_id']=proof['entry']['id'];r['statx_unique']['mount_id']=r['fid_unique']['mount_id']='4294967377' if proof is initial else '4294967378'
                records.append(r)
                if not lookup:
                    data=b'' if kind=='directory' else b'data'
                    records.append({'kind':'content-read','object':label,'pid':pid,'fd':index+5,'rc':0,'errno':0,'bytes':len(data),'hex':data.hex()})
                    after=copy.deepcopy(r);after['iteration']=1;records.append(after)
                records.extend([{'kind':'path-guard','object':label,'same_object':True,'root_stable':True},{'kind':'fd-closed','object':label,'fd':index+5,'rc':0}])
            records.append({'kind':'root-closed','fd':4,'rc':0})
            return {'returncode':0,'reaped':True,'records':records,'mountinfo_before':[proof['entry']],'mountinfo_after':[proof['entry']],'mode':'lookup' if lookup else 'provider'}
        def native_put(name,cases,proof=initial,**kwargs):
            value=make(cases,proof,**kwargs);put('native/'+name+'.json',value)
            return checks.validate_batch(value,cases,1000,1000,proof,kwargs.get('lookup',False)),value
        def case(label):return tuple(v for v in checks.CASES if v[0]==label)
        ident={**dict.fromkeys(checks.CAPS,'0000000000000000'),'Uid':'1000 1000 1000 1000','Gid':'1000 1000 1000 1000','Groups':'','NoNewPrivs':'1'}
        def action_put(label,operation,extra):
            value={'operation':operation,'pid':20,'identity':ident,'all_old_native_children_reaped':True,**extra};put('actions/'+label+'.json',value);return value
        def observed_stat(view):
            m=view['metadata'];return {**{k:int(m[k]) for k in ('dev','ino','mode','nlink','size','uid','gid')},'rdev':0,'blocks':8,**{k+'_ns':int(m[k][0])*10**9+int(m[k][1]) for k in ('atime','mtime','ctime')}}
        root_view,_=native_put('identity-native',(('fs-root','.','directory'),))
        cold,cold_batch=native_put('cold-provider',checks.CASES);native_put('cold-control',checks.CASES,lookup=True)
        image_stat=observed_stat(cold['file-root']);image_stat['size']=67108864
        put('fixture-image.json',{'uuid_requested':'12345678-90ab-cdef-1234-567890abcdef','bytes':67108864,'identity':image_stat,'scope':'new private fixture, no source clone'})
        put('features.json',{'raw':'Filesystem features: synthetic control only','requested_mkfs':['-F','-U','12345678-90ab-cdef-1234-567890abcdef','-E','lazy_itable_init=0,lazy_journal_init=0'],'production_inference':False})
        def absent(label,view):return action_put(label,'absent',{'ancestor':observed_stat(view),'missing':[{'suffix':'missing','errno':2},{'suffix':'missing/deeper','errno':2}],'absent_incarnation':None})
        a=absent('initial-absent',cold['ancestor']);summary['checks']['EX4-Q02']['detail']={'case_count':10,'same_fd_bytes':True,'absent':a}
        def snapshot(values,cases):
            entries={}
            for label,relative,kind in cases:
                entries['.' if relative=='.' else './'+relative]={**observed_stat(values[label]),'xattrs':{'trusted.boardroom.ext4qual':b'observer-visible'.hex()} if relative=='.' else {},'inode_flags':0,**({'sha256':hashlib.sha256(b'data').hexdigest()} if kind=='file' else {})}
            payload=sum((v['size'] if 'sha256' in v else 0)+sum(len(bytes.fromhex(x)) for x in v['xattrs'].values()) for v in entries.values())
            return {'entries':entries,'payload_bytes_observed':payload,'objects':len(entries)}
        cold_groups={group:snapshot(root_view,(('fs-root','.','directory'),)) if group=='fs-root' else snapshot(cold,checks.CASES) for group in ('fs-root','control','provider')}
        for stage in ('cold-before','cold-control-after','cold-provider-after'):
            for group,value in cold_groups.items():put(f'snapshots/{stage}-{group}.json',{'first':value,'repeat':value,'observer_only':{'atime_only':[],'non_atime':[]}})
        put('cold-comparison.json',checks.cold_compare(cold_groups,cold_groups,cold_groups));summary['checks']['EX4-Q03']['detail']={'comparison':'cold-comparison.json','provider_primed':False}
        mutations={}
        for label in ('file-root','directory-root','empty-dir'):
            before,_=native_put('mutation-before-'+label,case(label));after,_=native_put('mutation-after-'+label,case(label),changes={label:{'metadata':{'ctime':['8','0']}}})
            a=action_put('mutation-'+label,'mutate',{'before':observed_stat(before[label]),'after':observed_stat(after[label]),'chmod_restore':True,'rename_out_back':True,('write_truncate_restore' if label=='file-root' else 'temporary_member_removed'):True})
            mutations[label]={'action':a,'comparison':checks.compare(before,after)}
        summary['checks']['EX4-Q04']['detail']=mutations;reuse={}
        def replacement(label,suffix):
            before,_=native_put('replace-before-'+suffix,case(label));after,_=native_put('replace-after-'+suffix,case(label),changes={label:{'fid':'ef'*8,'metadata':{'ctime':['9','0']}}})
            a=action_put('replace-'+suffix,'replace',{'before':observed_stat(before[label]),'after':observed_stat(after[label]),'before_delete_source_fds':[],'old_object_fds_open':0,'absence_errno':2,'same_mode':True,'same_final_members':True,'same_content':True})
            value={'before':before,'after':after,'receipt':a,'inode_reused':checks.replacement(before,after,a,label),'native_before_ref':'native/replace-before-'+suffix+'.json','native_after_ref':'native/replace-after-'+suffix+'.json'}
            put('recreation/'+suffix+'.json',value);return value
        for label in ('file-root','empty-dir'):reuse[label]=replacement(label,label)
        summary['checks']['EX4-Q05']['detail']={'receipts':['recreation/file-root.json','recreation/empty-dir.json'],'no_old_native_processes':True}
        put('inode-reuse.json',reuse);put('inode-reuse-budget.json',{'additional_attempts':0,'elapsed_seconds':.1,'reused':list(reuse),'limits':{'attempts':32,'seconds':2}})
        summary['checks']['EX4-Q06']['detail']={'additional_attempts':0,'receipt':'inode-reuse.json'}
        put('synthetic-equal-stat-time.json',{'native_sources':'inode-reuse.json','cases':{label:checks.equal_stat_control(v['before'],v['after'],v['receipt'],label) for label,v in reuse.items()}})
        summary['checks']['EX4-Q07']['detail']={'origin':'synthetic from actual native receipts','production_Fs_service':'NOT_RUN','evidence':'synthetic-equal-stat-time.json'}
        persisted,persist_batch=native_put('persist-source',checks.CASES)
        put('persisted-observations.json',{'schema_version':checks.FROZEN_SCHEMA,'root':initial['mountpoint']+'/provider','uid':1000,'gid':1000,'cases':[list(v) for v in checks.CASES],'all_native_children_reaped':True,'mount_proof':initial,'observations':persisted,'batch':persist_batch})
        files['persisted-observations.sha256']=(hashlib.sha256(files['persisted-observations.json']).hexdigest()+'\n').encode()
        def consumed(label,proof):
            current=make(checks.CASES,proof,pid=21)
            receipt=checks.consume_frozen(files['persisted-observations.json'],files['persisted-observations.sha256'],current,proof,initial['mountpoint']+'/provider',checks.CASES,1000,1000,20)
            action_put(label,'consume',{'batch':current,'native_reaped':True,'raw_stderr':'','receipt':receipt});return receipt
        summary['checks']['EX4-Q08']['detail']=consumed('new-process-consume',initial)
        lifecycle={'all_native_children_reaped':True,'open_fixture_fds':0,'source_fds_before_unmount':[],'unmount_rc':0,'detached_rc':0,'reattach_rc':0,'mount_rc':0,'image_sha256_after_detach':'a'*64,'image_sha256_before_reattach':'a'*64,'mountpoint_before':initial['mountpoint'],'mountpoint_after':initial['mountpoint'],'image_inode_before':[1,2],'image_inode_after':[1,2],'cycles':1,'os_reboot':'NOT_RUN','fresh_consume':consumed('post-lifecycle-consume',latest)}
        put('fs-lifecycle.json',lifecycle);summary['checks']['EX4-Q09']['detail']=lifecycle
        negatives={}
        for label in ('symlink','hardlink','fifo','foreign-owner','cross-mount'):
            value=make(case('file-root'),latest);object_label='cross' if label=='cross-mount' else label;opened=label not in ('symlink','cross-mount')
            records=[value['records'][0],{'kind':'object-guard-error' if opened else 'open-error','object':object_label}]
            if opened:records.append({'kind':'fd-closed','object':object_label,'fd':5,'rc':0})
            else:records[-1]['errno']=errno.EXDEV if label=='cross-mount' else errno.ELOOP
            records.append(value['records'][-1]);value.update(records=records,returncode=70 if opened else 69);put('native/reject-'+label+'.json',value)
            if label!='cross-mount':negatives[label]={'returncode':value['returncode'],'native':'native/reject-'+label+'.json'}
        fd=make(case('file-root'),latest);fd['mode']='fd-reuse';fd['returncode']=70
        fd['records'].insert(2,{'kind':'fd-reuse-injection','object':'file-root','pid':10,'old_fd':5,'new_fd':5,'close_rc':0,'close_errno':0,'open_rc':5,'open_errno':0,'dup_attempted':False,'dup_rc':-2,'dup_errno':0,'applied':True,'test_only':True})
        for key in ('before','after'):fd['records'][4][key].update(dev='5',ino='6',mode='8630')
        fd['records'][5]['same_object']=False;put('native/reject-fd-reuse.json',fd);negatives['fd_reuse']=checks.validate_fd_reuse(fd,'file-root')
        race=make(case('file-root'),latest,pid=21)['records'];race.insert(2,{'kind':'race-window','test_only':True});race[5]['same_object']=False
        action_put('path-race','path-race',{'native_returncode':70,'native_reaped':True,'records':race,'raw_stderr':'','real_barrier_observed':True,'real_path_replacement':True});negatives.update(path_race='actions/path-race.json',cross_mount='real bind/EXDEV')
        before,_=native_put('ancestor-before',case('ancestor'),latest);after,_=native_put('ancestor-after',case('ancestor'),latest,changes={'ancestor':{'fid':'aa'*8}})
        action_put('ancestor-replace','replace',{'before':observed_stat(before['ancestor']),'after':observed_stat(after['ancestor']),'before_delete_source_fds':[],'old_object_fds_open':0,'absence_errno':2,'same_mode':True,'same_final_members':True,'same_content':True})
        negatives['absent']=absent('ancestor-absent',after['ancestor']);summary['checks']['EX4-Q10']['detail']=negatives
        current,_=native_put('fault-control-source',case('file-root'),latest);injected=runner.fault_controls(current['file-root']['native']);put('fault-injections.json',injected)
        cancel=make(case('file-root'),latest,pid=21)['records'][:2]+[{'kind':'race-window','test_only':True}]
        action_put('cancel-native','cancel-native',{'native_returncode':-15,'native_reaped':True,'records':cancel,'raw_stderr':'','real_barrier_observed':True,'real_path_replacement':False})
        summary['checks']['EX4-Q11']['detail']={'synthetic_errno_field_cases':len(injected),'native_resize_retries':0,'actual_cancel':'actions/cancel-native.json','timeout':'synthetic-timeout-child, reaped; no source access','successful_Fs':False}
        files['commands/loop-attach.stdout']=(initial['loop']+'\n').encode();files['commands/lifecycle-reattach.stdout']=(latest['loop']+'\n').encode();files['commands/lifecycle-detach-proof.stdout']=b''
        events=[{'event':'start','pid':1}]
        for key in checks.CHECKS:
            if key!='EX4-Q12':events.extend([{'event':'phase-start','phase':key},{'event':'phase-end','phase':key}])
        for name,data in list(files.items()):
            if name.startswith('native/'):
                value=json.loads(data);label=Path(name).stem;pid=value['records'][0]['pid']
                files['commands/'+label+'.stdout']=b''.join(json.dumps(v).encode()+b'\n' for v in value['records']);files['commands/'+label+'.stderr']=b''
                events.extend([{'event':'child-start','label':label,'pid':pid},{'event':'child-exited','label':label,'pid':pid,'returncode':value['returncode'],'reaped':True}])
            elif name.startswith('actions/'):
                value=json.loads(data);label=Path(name).stem;files['commands/'+label+'.stdout']=support.encoded({k:v for k,v in value.items() if k!='all_old_native_children_reaped'});files['commands/'+label+'.stderr']=b''
                events.extend([{'event':'child-start','label':label,'pid':value['pid']},{'event':'child-exited','label':label,'pid':value['pid'],'returncode':0,'reaped':True}])
        for name in files:
            if name.startswith('commands/') and name.endswith('.stdout'):
                label=Path(name).stem
                if not any(e.get('event')=='child-start' and e.get('label')==label for e in events):
                    events.extend([{'event':'child-start','label':label,'pid':12,'timeout_seconds':.02},{'event':'child-exited','label':label,'pid':12,'returncode':-15 if label=='synthetic-timeout-child' else 0,'reaped':True,'timed_out':label=='synthetic-timeout-child'}])
        files['events.jsonl']=b''.join(json.dumps(v).encode()+b'\n' for v in events);put('summary.json',summary)
        return files,candidate,summary

    def seal(self,files):
        import hashlib
        files['SHA256SUMS']=''.join(hashlib.sha256(data).hexdigest()+'  '+name+'\n' for name,data in sorted(files.items()) if name!='SHA256SUMS').encode()

    def test_std001_exact_q_set_and_payload_are_required_by_real_finalizer(self):
        files,candidate,summary=self.bundle();self.seal(files)
        self.assertEqual(checks.validate_result_bundle(files,candidate,'b'*64)[1],'PASS')
        for broken in ({}, {'EX4-Q01':summary['checks']['EX4-Q01']}, {k:v for k,v in summary['checks'].items() if k!='EX4-Q12'}, {**summary['checks'],'UNRELATED':{'status':'PASS'}}, {k:{'status':'PASS'} for k in checks.CHECKS}):
            altered=dict(files);altered['summary.json']=json.dumps({**summary,'checks':broken}).encode();self.seal(altered)
            with self.assertRaises(checks.CheckError):checks.validate_result_bundle(altered,candidate,'b'*64)

    def test_std001_missing_wrong_hash_and_unlinked_originals_reject(self):
        files,candidate,summary=self.bundle();self.seal(files)
        for fault in ('missing','rehash_missing','wrong_hash','wrong_candidate','bad_status','raw_unlinked','missing_reference','duplicate'):
            altered=dict(files);document=copy.deepcopy(summary)
            if fault in ('missing','rehash_missing'):del altered['native/identity-native.json']
            elif fault=='wrong_hash':altered['features.json']+=b' '
            elif fault=='wrong_candidate':document['candidate']['commit']='3'*40;altered['summary.json']=json.dumps(document).encode()
            elif fault=='bad_status':document['checks']['EX4-Q01']['status']='SKIP';altered['summary.json']=json.dumps(document).encode()
            elif fault=='raw_unlinked':altered['commands/identity-native.stdout']=b'{}\n'
            elif fault=='missing_reference':altered['inode-reuse.json']=json.dumps({'native_before_ref':'native/absent-source.json'}).encode()
            else:altered['summary.json']=json.dumps(summary)[:-1].encode()+b',"checks":{}}'
            if fault not in ('missing','wrong_hash'):self.seal(altered)
            with self.subTest(fault=fault),self.assertRaises(checks.CheckError):checks.validate_result_bundle(altered,candidate,'b'*64)

    def test_std001_fixture_seal_and_import_share_the_disk_gate(self):
        sys.path.insert(0,str(HERE));spec=importlib.util.spec_from_file_location('ext4_bundle_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        from types import SimpleNamespace
        files,candidate,summary=self.bundle()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name,data in files.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            evidence=SimpleNamespace(path=root,file=lambda name,value:(root/name).write_text(json.dumps(value)))
            runner.seal_fixture(evidence,summary,candidate,'b'*64)
            self.assertEqual(runner.read_result_bundle(root,candidate,'b'*64)[1],'PASS')
            summary['checks']={};runner.seal_fixture(evidence,summary,candidate,'b'*64)
            self.assertEqual(summary['limited_native_status'],'BLOCKED')
            with self.assertRaises(runner.C.CheckError):runner.read_result_bundle(root,candidate,'b'*64)

    def test_req005_actual_profile_writer_preserves_validated_source_bytes(self):
        sys.path.insert(0,str(HERE));spec=importlib.util.spec_from_file_location('ext4_profile_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        import support
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);ev=support.Evidence(root/'valid');runner.profile(ev)
            self.assertEqual((ev.path/'profile.json').read_bytes(),(HERE/'profile.json').read_bytes())
            invalid=json.loads((HERE/'profile.json').read_bytes());invalid['profile']='unknown';(root/'profile.json').write_text(json.dumps(invalid))
            denied=support.Evidence(root/'invalid')
            with patch.object(runner,'HERE',root),self.assertRaises(support.Stop):runner.profile(denied)
            self.assertFalse((denied.path/'profile.json').exists())

    def test_std001_rehashed_empty_or_placeholder_pass_payloads_reject(self):
        import hashlib
        files,candidate,summary=self.bundle()
        for fault in ('native_empty','native_observations_missing','lookup_empty','persisted_empty','persisted_object_missing','mutation_placeholder','recreation_placeholder','lifecycle_placeholder','fault_placeholder','snapshot_placeholder'):
            altered=dict(files)
            if fault in ('native_empty','native_observations_missing','lookup_empty'):
                path='native/cold-control.json' if fault=='lookup_empty' else 'native/cold-provider.json';native=json.loads(altered[path])
                native['records']=[] if fault!='native_observations_missing' else [r for r in native['records'] if r['kind']!='native-observation'];altered[path]=json.dumps(native).encode()
                altered['commands/'+Path(path).stem+'.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in native['records'])
            elif fault.startswith('persisted_'):
                value=json.loads(altered['persisted-observations.json'])
                if fault=='persisted_empty':value={'observations':{}}
                else:del value['observations']['child-file']
                data=json.dumps(value).encode();altered['persisted-observations.json']=data;altered['persisted-observations.sha256']=(hashlib.sha256(data).hexdigest()+'\n').encode()
            else:
                path={'mutation_placeholder':'actions/mutation-file-root.json','recreation_placeholder':'recreation/file-root.json','lifecycle_placeholder':'fs-lifecycle.json','fault_placeholder':'fault-injections.json','snapshot_placeholder':'snapshots/cold-before-fs-root.json'}[fault]
                altered[path]=b'{"synthetic_control":true}'
                if path.startswith('actions/'):altered['commands/'+Path(path).stem+'.stdout']=altered[path]
            self.seal(altered)
            with self.subTest(fault=fault),self.assertRaises(checks.CheckError):checks.validate_result_bundle(altered,candidate,'b'*64)
        placeholders,expected,_=self.labels_only_bundle();self.seal(placeholders)
        with self.assertRaises(checks.CheckError):checks.validate_result_bundle(placeholders,expected,'b'*64)
        # 原STD反例的完整实际封存→导入路径，同步stdout/manifest也不能恢复PASS。
        sys.path.insert(0,str(HERE));spec=importlib.util.spec_from_file_location('ext4_empty_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        from types import SimpleNamespace
        value=json.loads(files['native/cold-provider.json']);value['records']=[];files['native/cold-provider.json']=json.dumps(value).encode();files['commands/cold-provider.stdout']=b''
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name,data in files.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            evidence=SimpleNamespace(path=root,file=lambda name,value:(root/name).write_text(json.dumps(value)))
            runner.seal_fixture(evidence,summary,candidate,'b'*64)
            self.assertNotEqual(summary['limited_native_status'],'PASS')
            with self.assertRaises(runner.C.CheckError):runner.read_result_bundle(root,candidate,'b'*64)

    def test_std001_typed_environment_rows_remain_nonpass_without_fabricated_payloads(self):
        files,candidate,summary=self.bundle()
        for status in ('BLOCKED','INCONCLUSIVE'):
            partial={k:v for k,v in files.items() if k in checks.BASE_ORIGINALS};document=copy.deepcopy(summary)
            document['execution_status']=status;document['checks']={key:{'status':'NOT_RUN_ENVIRONMENT'} for key in checks.CHECKS};document['checks']['EX4-Q01']={'status':status,'reason':'synthetic raw identity/capability environment control'};document['checks']['EX4-Q12']=summary['checks']['EX4-Q12']
            native=json.loads(files['native/identity-native.json']);native.update(records=native['records'][:1] if status=='BLOCKED' else [],returncode=77 if status=='BLOCKED' else 69)
            if native['records']:native['records'][0].update(uid=[0]*4,verified=False)
            partial['native/identity-native.json']=json.dumps(native).encode();partial['commands/identity-native.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in native['records']);partial['commands/identity-native.stderr']=b''
            partial['events.jsonl']=b''.join(json.dumps(v).encode()+b'\n' for v in [{'event':'start','pid':1},{'event':'child-start','label':'identity-native','pid':10},{'event':'child-exited','label':'identity-native','pid':10,'returncode':native['returncode'],'reaped':True}]);partial['summary.json']=json.dumps(document).encode();self.seal(partial)
            returned,result=checks.validate_result_bundle(partial,candidate,'b'*64);self.assertEqual(result,'BLOCKED');self.assertEqual(returned['checks']['EX4-Q01']['status'],status)

    def test_std003_foreign_owner_keeps_both_bound_producer_rejections(self):
        files,candidate,summary=self.bundle()
        for case in ('guard_70','open_eacces','open_eperm','wrong_errno','enoent','errno_type','wrong_object','wrong_rc','missing_root_close','not_reaped','wrong_identity','guard_missing_entry_close'):
            altered=dict(files);document=copy.deepcopy(summary);native=json.loads(altered['native/reject-foreign-owner.json']);events=[json.loads(line) for line in altered['events.jsonl'].splitlines()]
            if case=='guard_missing_entry_close':native['records']=[r for r in native['records'] if r['kind']!='fd-closed']
            elif case!='guard_70':
                native['records']=[native['records'][0],{'kind':'open-error','object':'foreign-owner','errno':errno.EPERM if case=='open_eperm' else errno.EACCES},native['records'][-1]];native['returncode']=69
                if case=='wrong_errno':native['records'][1]['errno']=errno.ENOSYS
                elif case=='enoent':native['records'][1]['errno']=errno.ENOENT
                elif case=='errno_type':native['records'][1]['errno']=True
                elif case=='wrong_object':native['records'][1]['object']='file-root'
                elif case=='wrong_rc':native['returncode']=70
                elif case=='missing_root_close':native['records'].pop()
                elif case=='not_reaped':native['reaped']=False
                elif case=='wrong_identity':native['records'][0]['uid']=[0]*4;native['records'][0]['verified']=False
                document['checks']['EX4-Q10']['detail']['foreign-owner']['returncode']=native['returncode']
                for event in events:
                    if event.get('event')=='child-exited' and event.get('label')=='reject-foreign-owner':event['returncode']=native['returncode'];event['reaped']=native['reaped']
            altered['native/reject-foreign-owner.json']=json.dumps(native).encode();altered['commands/reject-foreign-owner.stdout']=b''.join(json.dumps(r).encode()+b'\n' for r in native['records']);altered['events.jsonl']=b''.join(json.dumps(e).encode()+b'\n' for e in events);altered['summary.json']=json.dumps(document).encode();self.seal(altered)
            with self.subTest(case=case):
                if case in ('guard_70','open_eacces','open_eperm'):
                    self.assertEqual(checks.validate_result_bundle(altered,candidate,'b'*64)[1],'PASS')
                    if case!='guard_70':
                        spec=importlib.util.spec_from_file_location('ext4_owner_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
                        from types import SimpleNamespace
                        with tempfile.TemporaryDirectory() as tmp:
                            root=Path(tmp)
                            for name,data in altered.items():
                                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
                            evidence=SimpleNamespace(path=root,file=lambda name,value:(root/name).write_text(json.dumps(value)))
                            runner.seal_fixture(evidence,document,candidate,'b'*64)
                            self.assertEqual(runner.read_result_bundle(root,candidate,'b'*64)[1],'PASS')
                else:
                    with self.assertRaises(checks.CheckError):checks.validate_result_bundle(altered,candidate,'b'*64)

class ConsumerContract(unittest.TestCase):
    def test_same_file_native_identity_stays_but_changed_frozen_time_rejects(self):
        a=view();b=copy.deepcopy(a);b['file-root']['metadata']['ctime']=['8','1']
        self.assertEqual(a['file-root']['witness'],b['file-root']['witness'])
        self.assertEqual(checks.compare(a,b),'source_changed')

    def test_directory_member_add_remove_does_not_gain_persistent_ctime_guard(self):
        a=view(kind='directory');b=copy.deepcopy(a);b['file-root']['metadata']['ctime']=['8','1'];b['file-root']['metadata']['mtime']=['8','2']
        self.assertEqual(checks.compare(a,b),'equal')

    def test_equal_stat_time_still_rejects_actual_receipt_different_fid_branch(self):
        a=view();r=native();r['fid_unique']['hex']='0100000003000000';b=view(r)
        receipt={'absence_errno':errno.ENOENT,'all_old_native_children_reaped':True,'old_object_fds_open':0,'same_mode':True,'same_final_members':True,'same_content':True}
        result=checks.equal_stat_control(a,b,receipt,'file-root')
        self.assertEqual(result['result'],'source_changed');self.assertFalse(result['real_all_times_equal']);self.assertEqual(result['production_Fs_service'],'NOT_RUN')
        for key,value in [('absence_errno',0),('old_object_fds_open',1),('all_old_native_children_reaped',False),('same_content',False)]:
            broken={**receipt,key:value}
            with self.assertRaises(ValueError):checks.equal_stat_control(a,b,broken,'file-root')

    def test_q07_cannot_substitute_no_reuse_or_arbitrary_missing_native_receipt(self):
        a=view();r=native();r['fid_unique']['hex']='0100000003000000';r['before']['ino']=r['after']['ino']='124';b=view(r)
        receipt={'absence_errno':2,'all_old_native_children_reaped':True,'old_object_fds_open':0,'same_mode':True,'same_final_members':True,'same_content':True}
        with self.assertRaises(ValueError):checks.equal_stat_control(a,b,receipt,'file-root')
        with self.assertRaises((ValueError,KeyError)):checks.equal_stat_control(a,b,{},'file-root')

class MountAndLifecycleContract(unittest.TestCase):
    def fixture(self):
        entry={'id':'77','parent':'1','device':'8:1','root':'/','point':'/owned/mount','mount_options':['rw','relatime'],
               'optional':[],'type':'ext4','source':'/dev/loop8','super_options':['rw','errors=remount-ro'],'raw':'synthetic control'}
        proof={'mountpoint':'/owned/mount','loop':'/dev/loop8','requested_options':list(checks.OPTIONS),'mount_returncode':0,
               'scope':'owned_qualification_fixture','production_runtime_match':'NOT_IMPLEMENTED_UNSUPPORTED'}
        return entry,proof

    def test_full_current_mount_binding_and_no_production_defaults_inference(self):
        entry,proof=self.fixture();self.assertEqual(checks.validate_mount(native(),[entry],proof),entry)
        for key,value in [('type','ext3'),('root','/subtree'),('device','9:1'),('id','4294967377'),('super_options',['rw','nodelalloc']),('source','/dev/loop9')]:
            with self.assertRaises(ValueError):checks.validate_mount(native(),[{**entry,key:value}],proof)
        with self.assertRaises(ValueError):checks.validate_mount(native(),[entry],{**proof,'scope':'production'})
        with self.assertRaises(ValueError):checks.validate_mount(native(),[entry],{**proof,'production_runtime_match':'fixture_features_match'})

    def test_full_fs_lifecycle_requires_unmount_detach_same_image_and_new_mount(self):
        receipt={'all_native_children_reaped':True,'open_fixture_fds':0,'unmount_rc':0,'detached_rc':0,'reattach_rc':0,'mount_rc':0,
                 'image_sha256_after_detach':'a'*64,'image_sha256_before_reattach':'a'*64,'mountpoint_before':'/owned/mount','mountpoint_after':'/owned/mount',
                 'image_inode_before':[1,2],'image_inode_after':[1,2],'cycles':1,'os_reboot':'NOT_RUN'}
        self.assertTrue(checks.lifecycle(receipt))
        for key,value in [('detached_rc',1),('image_sha256_before_reattach','b'*64),('open_fixture_fds',1),('image_inode_after',[1,3]),('cycles',0),('os_reboot','PASS')]:
            with self.assertRaises(ValueError):checks.lifecycle({**receipt,key:value})

    def test_missing_evidence_and_cleanup_never_qualify(self):
        self.assertEqual(checks.aggregate([]),'BLOCKED')
        self.assertEqual(checks.aggregate(['PASS','NOT_RUN_ENVIRONMENT']),'BLOCKED')
        self.assertEqual(checks.aggregate(['PASS','INCONCLUSIVE']),'BLOCKED')
        self.assertEqual(checks.aggregate(['PASS','FAIL']),'FAIL')
        s=checks.base_summary();self.assertEqual(set(s['checks']),{f'EX4-Q{i:02}' for i in range(1,13)})
        self.assertEqual(s['accepted_provider_profiles'],[]);self.assertEqual(s['qualified_kernel_builds'],[]);self.assertEqual(s['B1'],'OPEN');self.assertEqual(s['R05'],'NOT_RUN')

class ProcessContract(unittest.TestCase):
    def test_timeout_reaps_actual_child_and_preserves_nonzero_receipt(self):
        sys.path.insert(0,str(HERE))
        import support
        with tempfile.TemporaryDirectory() as tmp:
            ev=support.Evidence(Path(tmp)/'evidence')
            with self.assertRaises(support.Stop):ev.call('controlled-timeout',[sys.executable,'-I','-c','import time; time.sleep(1)'],.02)
            self.assertEqual(ev.children,{})
            ev.flush_pending_receipts()
            events=[json.loads(l) for l in (ev.path/'events.jsonl').read_text().splitlines()]
            exits=[e for e in events if e['event']=='child-exited'];self.assertEqual(len(exits),1)
            self.assertTrue(exits[0]['reaped']);self.assertTrue(exits[0]['timed_out']);self.assertNotEqual(exits[0]['returncode'],0)

    def test_hosted_entry_rejects_local_before_sudo_or_fixture(self):
        sys.path.insert(0,str(HERE));spec2=importlib.util.spec_from_file_location('ext4_run',HERE/'run.py');runner=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(runner)
        from types import SimpleNamespace
        from unittest.mock import patch
        import support
        with patch.dict(os.environ,{},clear=True),patch.object(runner.subprocess,'Popen',side_effect=AssertionError('must not spawn')):
            with self.assertRaises(support.Stop):runner.hosted(SimpleNamespace(root='/not-created',out='/not-created-evidence'))

if __name__ == '__main__':
    unittest.main()

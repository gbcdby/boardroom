"""CFP2 新 profile 纯控制；只编译与自有普通文件，不启动 guest/设备。"""
from __future__ import annotations
import importlib.util
import copy
import json
import os
import hashlib
import struct
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
HERE = ROOT / 'scripts/qualification/whole-brd'
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
RUN = '358af363-b224-4d47-a5b6-5a4573192db3'
PAYLOAD = b'boardroom F3: one cold ordinary held-FD read; preserved bytes.\n'

def consumer():
    spec = importlib.util.spec_from_file_location('f4_cfp2_controls', HERE / 'f4-cfp2.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def trace(rows):
    return b''.join(b'BRDCF4 ' + json.dumps(row | {'seq': i + 1}, separators=(',', ':')).encode() + b'\n'
                    for i, row in enumerate(rows))


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class SyntheticTrace:
    """独立构造固定 Linux ABI 字节和事件；明确不是 native/guest 运行证据。"""
    def __init__(self):
        self.old = module_at('f4_dm_fixture', ROOT / 'tests/whole-brd-f3-dm.test.py')
        self.outer, self.prior = self.old.synthetic_complete_serial()
        dm = self.old.dm
        self.p1 = dm.f0b.decode_serial(self.prior.serial_bytes(self.outer), RUN, b'exact-notes')
        self.device = dm.decode_ioctl(self.old.response(command='create', flags=0, targets=0), 'create', RUN)
        self.metadata = dm.decode_metadata([r for t,r in self.outer if t=='BRDF2' and r.get('origin')=='ordinary'],
                                          self.p1, RUN, self.device, 'dm-7')
        self.view = dm.source_view([r for t,r in self.outer if t=='BRDF3' and r['phase']=='read-before' and r['event'].startswith('view-')],
                                  RUN, 'read-before', self.device)
        self.binding = dict(metadata=self.metadata, view=self.view, device=self.device,
                            p1=self.p1, dm={'sysname':'dm-7'})
        self.rows=[]; self.fds={'Dp':3,'M':4,'R':5,'V':6,'F':7,'A':3}; self.aux_count=0
        self.identities={}; self.counts=dict(opens=5,syncs=3,closes=5,transfers=1,reads=2,
                                          payload_bytes=len(PAYLOAD),eofs=1,aux_opens=0,aux_closes=0)

    def add(self, event, role='aux', fd=-1, data=None, rc=0, error=0):
        row=dict(v=1,run_id=RUN,pid=6,seq=len(self.rows)+1,ns='82',event=event,role=role,fd=fd,
                 rc=rc,errno=error,data={} if data is None else data)
        self.rows.append(row); return row

    def raw(self, stage, phase, name, fd, value):
        for at in range(0, max(1,len(value)),8192):
            chunk=value[at:at+8192]
            self.add('raw',fd=fd,data=dict(stage=stage,**{'pass':phase},name=name,offset=at,total=len(value),
                                         hex=chunk.hex(),last=at+len(chunk)==len(value)))

    def meta(self, role, stage):
        source=self.view['objects']['.' if role in ('Dp','A') else 'payload']
        data={key:source[key] for key in ('dev','ino','mode','uid','gid','nlink','size')}
        data.update(stage=stage,mount_id=51,mount_unique=101,fs_type=0xef53)
        for key in ('atime','mtime','ctime'):data[key+'_ns']=str(source[key][0]*1000000000+source[key][1])
        self.add('metadata',role,self.fds[role],data)

    def open(self,role):
        self.add('open',role,self.fds[role],dict(parent_fd=-100 if role=='Dp' else 3,
                 metadata_only=role=='M',directory=role=='Dp',flags=0x220000 if role=='M' else 0x68800|(0x10000 if role=='Dp' else 0),fd_flags=1))
        self.meta(role,'opened')

    def aux_open(self,name,path,magic,directory=False,namespace=None):
        self.counts['aux_opens']+=1
        ino=self.identities.setdefault(name,1000+len(self.identities)) if namespace is None else namespace
        flags=0 if namespace else (0x30800 if directory else 0x20800)
        self.add('aux-open',fd=8,data=dict(name=name,path_hex=path.encode().hex(),flags=flags|0x80000))
        self.add('aux-stat',fd=8,data=dict(name=name,dev=4,ino=ino,mode=0o40555 if directory else 0o100444,fs_type=magic))

    def aux_close(self,name):
        self.add('aux-close',fd=8,data=dict(name=name,ran=True,unknown=False));self.counts['aux_closes']+=1

    def file(self,stage,phase,name,path,magic,value):
        self.aux_open(name,path,magic)
        if value:self.add('aux-read',fd=8,rc=len(value),data=dict(name=name,offset=0))
        self.add('aux-read',fd=8,data=dict(name=name,offset=len(value)))
        self.raw(stage,phase,name,8,value);self.aux_close(name)

    def names(self,stage,phase,name,path,names):
        self.aux_open(name,path,0x62656572,directory=True)
        self.add('enumeration',fd=8,data=dict(name=name,entries=len(names),eof=True))
        self.raw(stage,phase,name,8,b''.join(n+b'\0' for n in sorted(names)));self.aux_close(name)

    def configuration(self,stage,phase):
        role='V' if stage=='after-v' else 'M';carrier='A' if stage=='tail' else 'Dp';fd=self.fds[role]
        self.meta(carrier,'configuration-before')
        self.add('source-path',role,fd,dict(stage=stage,**{'pass':phase},carrier_fd=3,
                    source_ino=12,parent_ino=2,dev=self.device.encoded,mount_id=51,mount_unique=101))
        for kind,mask,mount in (('legacy',0x17ff,51),('unique',0x4fff,101)):
            raw=bytearray(256);struct.pack_into('<I',raw,0,mask);struct.pack_into('<IIIH',raw,16,1,1000,1000,0o100600)
            struct.pack_into('<QQ',raw,32,12,len(PAYLOAD));struct.pack_into('<Q',raw,56,0x200000)
            for offset,key in ((64,'atime'),(96,'ctime'),(112,'mtime')):struct.pack_into('<qI',raw,offset,*self.view['objects']['payload'][key])
            struct.pack_into('<qI',raw,80,99,0);struct.pack_into('<IIQ',raw,136,253,7,mount)
            self.add('configuration',role,fd,dict(stage=stage,**{'pass':phase},name='statx-'+kind))
            self.raw(stage,phase,'source.statx-'+kind,fd,bytes(raw))
        self.add('configuration',carrier,3,dict(stage=stage,**{'pass':phase},name='get-tune'))
        self.raw(stage,phase,'filesystem.tune',3,self.metadata['observations']['source_tune']['raw'])
        self.add('configuration',role,fd,dict(stage=stage,**{'pass':phase},name='statmount'))
        self.raw(stage,phase,'source.statmount-request',fd,struct.pack('<IIQQQ',32,0,101,59,0))
        self.raw(stage,phase,'source.statmount',fd,self.metadata['observations']['source_mount']['raw'])
        self.meta(carrier,'configuration-after')

    def environment(self,stage):
        role='V' if stage=='after-v' else 'M';fd=self.fds[role]
        self.add('environment-begin',role,fd,dict(stage=stage,carrier_fd=3))
        p1=self.p1['observations']
        for phase in ('before','after'):
            self.add('credentials',data=dict(stage=stage,**{'pass':phase},uid=1000,gid=1000,groups=0,no_new_privs=1,ppid=1,tid=6))
            self.configuration(stage,phase)
            for leaf,ino in (('pid',123),('mnt',789),('user',456)):
                name='namespace.'+leaf;value=p1['ns_'+leaf]['raw']
                self.aux_open(name,'/proc/6/task/6/ns/'+leaf,0x6e736673,namespace=ino)
                self.add('namespace-link',fd=8,rc=len(value),data=dict(stage=stage,**{'pass':phase},name=name))
                self.raw(stage,phase,name,8,value);self.aux_close(name)
            self.raw(stage,phase,'uname',-1,p1['uname']['raw'])
            status=p1['status_before']['raw'].replace(b'Pid:\t2\n',b'Pid:\t6\n')+b'Tgid:\t6\nThreads:\t1\n'
            self.file(stage,phase,'thread-status','/proc/6/task/6/status',0x9fa0,status)
            fields=['S','1']+['0']*17+['106']+['0','0'];fields[6]='0'
            self.file(stage,phase,'process-stat','/proc/6/stat',0x9fa0,b'6 (fixture) '+ ' '.join(fields).encode()+b'\n')
            for name,path,magic,value in (
                ('mountinfo','/proc/6/task/6/mountinfo',0x9fa0,p1['mountinfo']['raw']+self.metadata['observations']['mountinfo']['raw']),
                ('boot-id','/proc/sys/kernel/random/boot_id',0x9fa0,p1['boot_id']['raw']),
                ('cmdline','/proc/cmdline',0x9fa0,p1['cmdline']['raw']),
                ('kernel-notes','/sys/kernel/notes',0x62656572,b'exact-notes')):
                self.file(stage,phase,name,path,magic,value)
            self.add('unsupported',data=dict(stage=stage,**{'pass':phase},name='kernel-config',reason='unsupported'))
            self.raw(stage,phase,'device.path',-1,b'/sys/devices/virtual/block/dm-7')
            for leaf,value in (('name','br-f3-'+RUN.replace('-','')),('uuid','boardroom-f3-dm:'+RUN)):
                self.file(stage,phase,'device.dm-'+leaf,'/sys/devices/virtual/block/dm-7/dm/'+leaf,0x62656572,(value+'\n').encode())
            for kind,node,dev in (('source','dm-7','253:7'),('backing','ram0','1:0')):
                base='/sys/devices/virtual/block/'+node
                major,minor=dev.split(':');uevent=f'MAJOR={major}\nMINOR={minor}\nDEVNAME={node}\nDEVTYPE=disk\nDISKSEQ=1\n'.encode()
                for leaf,value in (('dev',(dev+'\n').encode()),('uevent',uevent),('size',b'131072\n'),('ro',b'0\n'),('diskseq',b'1\n')):
                    self.file(stage,phase,'graph.'+kind+'.'+leaf,base+'/'+leaf,0x62656572,value)
                for leaf,names in (('slaves',[b'ram0'] if kind=='source' else []),('holders',[] if kind=='source' else [b'dm-7']),
                                   ('',[b'dev',b'uevent',b'size',b'ro',b'diskseq',b'slaves',b'holders'])):
                    self.names(stage,phase,'graph.'+kind+'.'+(leaf or 'entries'),base+'/'+leaf,names)
                self.add('absence',data=dict(stage=stage,**{'pass':phase},name='graph.'+kind+'.partition'),rc=-1,error=2)
            for leaf,value in (('options',self.metadata['observations']['effective_options']['raw']),('mb_groups',b'#group: free\n')):
                self.file(stage,phase,leaf,'/proc/fs/ext4/dm-7/'+leaf,0x9fa0,value)
            self.file(stage,phase,'journal-task','/sys/fs/ext4/dm-7/journal_task',0x62656572,b'2\n')
            self.add('ioprio',rc=16387,data=dict(stage=stage,**{'pass':phase},which=1,who=2))
            for name in consumer().HEALTH:
                self.file(stage,phase,name,'/sys/fs/ext4/dm-7/'+name,0x62656572,b'\n' if name.endswith('_func') else b'0\n')
        self.configuration(stage,'final');self.meta('M','environment-after')
        self.add('environment-end',role,fd,dict(stage=stage,carrier_fd=3,aux_live=0))

    def extended(self,role,stage):
        self.meta(role,'extended-before');fd=self.fds[role];kind='parent' if role=='Dp' else 'payload';inode=2 if role=='Dp' else 12
        values=(('uuid',b'\x10'+bytes.fromhex(self.metadata['uuid'].replace('-','')),0),
                ('fid',struct.pack('<IIII',8,1,inode,99),0),('flags',struct.pack('<Q',0x80000),0),
                ('xattr-names',b'user.boardroom-source-preservation\0',35),('xattr-value',b'owned-fixture',13),
                ('xattr-names-after',b'user.boardroom-source-preservation\0',35))
        for name,value,rc in values:
            data=dict(stage=stage,name=name)
            if name=='fid':data['mount_unique']=101
            self.add('getter',role,fd,data,rc=rc);self.raw(stage,role,kind+'.'+name,fd,value)
        self.meta(role,'extended-after')

    def directory(self,stage):
        self.meta('Dp','before-members');self.add('aux-open',fd=8,data=dict(name='source-members',dup_from=3));self.counts['aux_opens']+=1
        self.add('enumeration',fd=8,data=dict(name='source-members',entries=4,eof=True))
        self.raw(stage,'members','source-members',8,b'ancestor\0directory\0lost+found\0payload\0')
        self.aux_close('source-members');self.meta('Dp','after-members')

    def sync(self,role):self.add('sync',role,self.fds[role],dict(ran=True));self.meta(role,'after-sync')
    def close(self,role):self.add('close',role,self.fds[role],dict(ran=True))
    def build(self):
        self.add('begin','-',-1,dict(profile='whole-brd-f4-cfp2-clean-regular-v1',scope='clean-regular-native',D0_ns='81',
                    product_budget_ns='120000000000',child_budget_ns='3000000000',uuid=self.metadata['uuid']))
        self.open('Dp');self.open('M');self.environment('before');self.extended('Dp','before');self.directory('before')
        self.open('R');self.open('V');self.extended('R','before');self.extended('V','before');self.sync('R')
        self.meta('R','before-read');self.add('payload','R',5,dict(offset=0,hex=PAYLOAD.hex()),rc=len(PAYLOAD));self.meta('R','after-read')
        self.meta('R','before-read');self.add('payload-eof','R',5,dict(offset=len(PAYLOAD)));self.meta('R','after-eof')
        self.add('offsets','R',5,dict(R=len(PAYLOAD),V=0));self.open('F');self.extended('F','reopen');self.close('F')
        self.extended('R','after');self.meta('R','before-close');self.close('R');self.sync('V');self.extended('V','after')
        self.environment('after-v');self.close('V');self.meta('Dp','before-sync');self.directory('after');self.sync('Dp')
        self.add('transfer','A',3,{'from':'Dp','old_owner_live':False,'dup':False});self.meta('M','tail');self.environment('tail')
        self.close('A');self.close('M')
        self.add('complete','-',-1,dict(scope='clean-regular-native',first_errno=0,cleanup_errno=0,unknown_closes=0,live_owners=0,**self.counts))['ns']='84'
        return self


class FullTraceControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.fixture=SyntheticTrace().build()

    def consume(self,rows):
        parser=consumer()
        # 只替换合成 fixture 的 notes digest；生产常量/校验仍固定原内核。
        with mock.patch.object(parser.f2,'NOTES_SHA',hashlib.sha256(b'exact-notes').hexdigest()):
            return parser.parse_native_trace(trace(rows),RUN,self.fixture.binding)

    def test_complete_three_stage_raw_environment_closes_before_tcut(self):
        result=self.consume(self.fixture.rows)
        self.assertEqual(result['state'],'NATIVE_TRACE_CLOSED')
        self.assertEqual(result['syncs'],3);self.assertEqual(result['closes'],5)
        self.assertGreater(result['aux_closes'],100)
        self.assertFalse(result['production_bound']);self.assertEqual(result['qualification'],'UNSUPPORTED')

    def test_ext4_root_fid_generation_zero_remains_a_valid_exact_identity(self):
        rows=copy.deepcopy(self.fixture.rows);binding=copy.deepcopy(self.fixture.binding)
        fid=struct.pack('<IIII',8,1,2,0)
        binding['metadata']['fid_hex']=fid[8:].hex()
        for row in rows:
            if row['event']=='raw' and row['data']['name']=='parent.fid':row['data']['hex']=fid.hex()
        parser=consumer()
        with mock.patch.object(parser.f2,'NOTES_SHA',hashlib.sha256(b'exact-notes').hexdigest()):
            self.assertEqual(parser.parse_native_trace(trace(rows),RUN,binding)['state'],'NATIVE_TRACE_CLOSED')

    def test_tail_requires_full_raw_metadata_of_the_live_a_carrier(self):
        rows=[r for r in copy.deepcopy(self.fixture.rows) if not (r['event']=='metadata' and r['role']=='A')]
        with self.assertRaises(ValueError):self.consume(rows)

    def test_json_boolean_cannot_impersonate_actual_counter_or_completion_flag(self):
        for case in ('counter','ran','unknown','aux-live'):
            rows=copy.deepcopy(self.fixture.rows)
            if case=='counter':rows[-1]['data']['eofs']=True
            elif case=='ran':next(r for r in rows if r['event']=='sync')['data']['ran']=1
            elif case=='unknown':next(r for r in rows if r['event']=='aux-close')['data']['unknown']=0
            else:next(r for r in rows if r['event']=='environment-end')['data']['aux_live']=False
            with self.subTest(case=case),self.assertRaises(ValueError):self.consume(rows)

    def test_environment_rejects_each_stage_identity_health_aux_and_freshness_gaps(self):
        for stage in ('before','after-v','tail'):
            for case in ('boot','health','namespace','pid','source','mount','tune','aux-close','aux-kind','missing-after','missing-final'):
                rows=copy.deepcopy(self.fixture.rows)
                selected=[r for r in rows if r['data'].get('stage')==stage]
                def raw(name):return next(r for r in selected if r['event']=='raw' and r['data']['name']==name)
                if case in ('boot','health','namespace'):
                    row=raw({'boot':'boot-id','health':'errors_count','namespace':'namespace.mnt'}[case])
                    value=bytearray.fromhex(row['data']['hex']);value[0]^=1;row['data']['hex']=value.hex()
                elif case=='pid':next(r for r in selected if r['event']=='credentials')['data']['tid']=7
                elif case=='source':next(r for r in selected if r['event']=='source-path')['data']['source_ino']=13
                elif case=='mount':
                    row=raw('source.statx-unique');value=bytearray.fromhex(row['data']['hex']);struct.pack_into('<Q',value,144,999);row['data']['hex']=value.hex()
                elif case=='tune':
                    row=raw('filesystem.tune');value=bytearray.fromhex(row['data']['hex']);value[64]^=1;row['data']['hex']=value.hex()
                elif case in ('aux-close','aux-kind'):
                    start=rows.index(next(r for r in selected if r['event']=='environment-begin'))
                    row=next(r for r in rows[start:] if r['event']==('aux-close' if case=='aux-close' else 'aux-stat'))
                    if case=='aux-close':row['data']['unknown']=True
                    else:row['data']['mode']=0o20600
                else:
                    row=next(r for r in selected if r['event']=='source-path' and r['data']['pass']==('final' if case=='missing-final' else 'after'))
                    rows.remove(row)
                with self.subTest(stage=stage,case=case),self.assertRaises(ValueError):self.consume(rows)


class FullSerialControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=SyntheticTrace().build();cls.rows=[];phase=None
        for tag,row in cls.fixture.outer:
            if row.get('event')=='native-begin':phase=row['phase']
            if tag=='NATIVE' and phase=='read':
                cls.rows.extend(('BRDCF4',r) for r in cls.fixture.rows)
            else:cls.rows.append((tag,copy.deepcopy(row)))

    def consume(self,rows):
        parser=consumer()
        with mock.patch.object(parser.f2,'NOTES_SHA',hashlib.sha256(b'exact-notes').hexdigest()), \
             mock.patch.object(parser.dm,'native_window',return_value={'status':'SYNTHETIC_CONTROL_ONLY'}) as control:
            result=parser.decode_serial(self.fixture.prior.serial_bytes(rows),RUN,b'exact-notes')
        self.assertEqual(control.call_count,1)
        return result

    def test_new_profile_consumes_real_parser_and_original_four_block_classifier(self):
        result=self.consume(copy.deepcopy(self.rows))
        self.assertEqual(result['state'],'CFP2_CLEAN_REGULAR_NATIVE_MECHANISM_OBSERVED')
        self.assertEqual(result['profile'],'whole-brd-f4-cfp2-clean-regular-v1')
        self.assertEqual(result['qualification'],'UNSUPPORTED');self.assertFalse(result['production_bound'])
        self.assertEqual(result['accepted_provider_profiles'],[])
        self.assertEqual(result['windows']['read']['Tcut_ns'],85)
        self.assertEqual(result['effects']['read']['changed_device_blocks'],[0,2048,2062,2063,2064])
        self.assertEqual(len([n for n in result['raw_artifacts'] if n in {phase+'-blocks.json' for phase in self.fixture.old.dm.SNAPSHOT_PHASES}]),4)

    def test_incomplete_child_source_boot_counter_and_unknown_blocks_cannot_complete(self):
        for case in ('reap','timeout','join','counter','close','native-origin','source-device','unknown-block'):
            rows=copy.deepcopy(self.rows)
            if case in ('reap','timeout','join'):
                row=next(r for _,r in rows if r.get('event')=='native-end' and r['phase']=='read')
                value=json.loads(bytes.fromhex(row['data_hex']));value[{'reap':'reaped','timeout':'timeout','join':'joined_ns'}[case]]={'reap':False,'timeout':True,'join':'81'}[case]
                raw=self.fixture.old.f3.encoded(value);row.update(bytes=len(raw),data_hex=raw.hex())
            elif case=='counter':next(r for tag,r in rows if tag=='BRDCF4' and r['event']=='complete')['data']['syncs']=2
            elif case=='close':
                rows=[(tag,r) for tag,r in rows if not(tag=='BRDCF4' and r['event']=='close' and r['role']=='M')]
            elif case=='native-origin':next(r for tag,r in rows if tag=='BRDCF4')['run_id']='ffffffff-ffff-4fff-afff-ffffffffffff'
            elif case=='source-device':
                row=next(r for tag,r in rows if tag=='BRDF2' and r.get('item')=='device_dev');row.update(bytes=4,data_hex=b'1:0\n'.hex())
            else:
                row=next(r for tag,r in rows if tag=='BRDF3' and r['phase']=='read-after' and r['event']=='snapshot-data')
                raw=bytearray.fromhex(row['data_hex']);raw[8+2500]^=1;row.update(data_hex=raw.hex())
            with self.subTest(case=case),self.assertRaises(ValueError):self.consume(rows)

    def test_old_dm_consumer_does_not_whitewash_the_new_read_trace(self):
        with self.assertRaises(ValueError):
            self.fixture.old.dm.decode_serial(self.fixture.prior.serial_bytes(self.rows),RUN,b'exact-notes')


class ProfileControls(unittest.TestCase):
    def test_three_profiles_keep_distinct_sources_states_and_cli_results(self):
        builder=module_at('f4_dispatch_builder',HERE/'f3-build.py')
        runner=module_at('f4_dispatch_runner',HERE/'f3-run.py')
        selections=({},None,'F3_SOURCE_PRESERVATION_OBSERVED'), \
            ({'profile':'whole-brd-f3-dm-linear-v1','input_kind':builder.NEW_INPUT_KIND},'whole-brd-f3-dm-linear-v1','F3_DM_SOURCE_PRESERVATION_OBSERVED'), \
            ({'profile':'whole-brd-f4-cfp2-clean-regular-v1','input_kind':builder.NEW_INPUT_KIND},'whole-brd-f4-cfp2-clean-regular-v1','CFP2_CLEAN_REGULAR_NATIVE_MECHANISM_OBSERVED')
        for request,profile,state in selections:
            with self.subTest(profile=profile):
                self.assertEqual(builder.observed_state(request),state)
                module=builder.profile_module(request)
                if profile is not None:self.assertEqual(module.PROFILE,profile)
                result={'state':state}
                if profile is not None:result['profile']=profile
                self.assertEqual(runner.expected_result_state(result),state)
                self.assertNotEqual(runner.expected_result_state(result), 'FAILED_NO_RETRY')
                for other in (s[2] for s in selections if s[2]!=state):
                    self.assertNotEqual(runner.expected_result_state(result|{'state':other}),other)
        original=set(builder.source_bindings())
        dm=set(builder.source_bindings('whole-brd-f3-dm-linear-v1'))
        f4=set(builder.source_bindings('whole-brd-f4-cfp2-clean-regular-v1'))
        self.assertEqual(dm-original,set(builder.DM_SOURCE_NAMES))
        self.assertLess(dm,f4)
        required={'f4-cfp2-guest.c','f4-cfp2-target.c','f4-cfp2-worker.c','f4-cfp2-worker.h','f4-cfp2-observe.h',
                  '../../../native/maintenance-source-files.c'}
        self.assertLessEqual(required,f4)
        self.assertEqual({p.name for p in (ROOT/'native/node-api/v24.22.1').iterdir()},
                         {Path(n).name for n in f4 if n.startswith('../../../native/node-api/v24.22.1/')})
        self.assertIsNone(builder.PRIVATE_CATALOG_SHA256)
        for profile in ('unknown','whole-brd-f4-cfp2-clean-regular-v0',None):
            with self.subTest(profile=profile),self.assertRaises(ValueError):
                builder.profile_module({'profile':profile,'input_kind':builder.NEW_INPUT_KIND})
        with self.assertRaises(ValueError):builder.profile_module({'profile':selections[-1][1]})
        with self.assertRaises(ValueError):runner.expected_result_state({'profile':'other','state':selections[-1][2]})

    def test_selected_f4_result_keeps_exit_reap_eof_and_final_seal_gates(self):
        runner=module_at('f4_host_state_control',HERE/'f3-run.py')
        request={'run_id':RUN,'profile':runner.builder.F4_PROFILE,'input_kind':runner.builder.NEW_INPUT_KIND,'input_root':'/unused/inputs'}
        module=runner.builder.profile_module(request);state=module.STATE
        bundle={'kind':runner.builder.NEW_INPUT_KIND,'request':request,'proposal':module.plan(json.dumps({'run_id':RUN}).encode()),
                'runtime_environment':{},'qemu_data':{'path':'/unused/firmware'},
                'inputs':{name:{'path':'/unused/'+name,'sha256':'0'*64} for name in ('qemu','kernel','bios','initramfs','gate')}}
        normal={'verified':True,'forced':False,'wait_timeout':False,'wait':{'reaped':True,'returncode':0}}
        raw=b'BRDF3 '+json.dumps({'run_id':RUN,'origin':'management','event':'guest-complete'}).encode()+b'\n'
        # 显式纯 host 状态控制：不创建 claim/child，不伪装成 guest 验收。
        for case in ('normal','nonzero','forced','unreaped','missing-eof','seal-error','close-error'):
            cleanup=copy.deepcopy(normal)
            if case=='forced':cleanup['forced']=True
            if case=='unreaped':cleanup['wait']['reaped']=False
            class Artifacts:
                entries={};closed=0
                def seal(self):
                    if case=='seal-error':raise OSError(5,'synthetic seal failure')
                    return []
                def put(self,*_):pass
                def close(self):self.closed+=1;return [{'errno':5}] if case=='close-error' else []
            class Process:
                def poll(self):return 1 if case=='nonzero' else 0
            class Owned:
                proc=Process();argv=[];gate_argv=[];serial_identity={};before={};after={};events=[]
                def release(self,*_):pass
                def cleanup(self,*_):return cleanup
            class Pump:
                errors=[];eof={'serial','qmp','stderr'};read_counts={};serial=b''
                def __init__(self,_,artifacts,callback):callback(raw)
                def poll(self,*_):pass
                def finish(self,*_):
                    if case=='missing-eof':raise EOFError('synthetic missing three-pipe EOF')
            class QMP:
                receipts=[]
                def __init__(self,*_):pass
            artifacts=Artifacts()
            with self.subTest(case=case),mock.patch.object(runner,'validate',return_value=({},bundle,{'notes':b'none-used'})), \
                 mock.patch.object(runner,'runtime_preflight',return_value={}),mock.patch.object(runner,'Artifacts',return_value=artifacts), \
                 mock.patch.object(runner,'create_claim') as claim,mock.patch.object(runner,'OwnedChild',return_value=Owned()), \
                 mock.patch.object(runner,'Pump',Pump),mock.patch.object(runner,'QMP',QMP),mock.patch.object(runner,'bounded_read',return_value=b''), \
                 mock.patch.object(module,'decode_serial',return_value={'state':state,'raw_artifacts':{}}):
                result=runner.execute('/unused/BUNDLE.json','0'*64,'/unused/output')
            self.assertEqual(result['kind'],'private-f4-cfp2-clean-regular-run')
            self.assertEqual(result['profile'],runner.builder.F4_PROFILE);self.assertEqual(artifacts.closed,1);self.assertEqual(claim.call_count,1)
            expected=state if case=='normal' else 'EVIDENCE_UNPROVEN' if case in ('seal-error','close-error') else 'FAILED_NO_RETRY'
            self.assertEqual(result['state'],expected)

    def test_exact_three_compiler_invocations_share_the_original_ten_seconds(self):
        builder=module_at('f4_compile_builder',HERE/'f3-build.py')
        request={'profile':'whole-brd-f4-cfp2-clean-regular-v1','input_kind':builder.NEW_INPUT_KIND}
        with tempfile.TemporaryDirectory(prefix='br-f4-compile-') as directory:
            out=Path(directory);header=out/'control-fixed-inputs.h'
            # 仅编译 TU/ELF，不准备 initramfs/BUNDLE，不运行 guest。非真实 notes 输入不释放执行。
            header.write_text('#define F2_FIXED_INPUTS 1\n#define F3_FIXED_INPUTS 1\n'
                'static const unsigned char F2_EXPECTED_NOTES[]={0};\n'
                'static const unsigned char F2_EXPECTED_CONFIG[]={0};\n'
                'static const unsigned char F3_EXPECTED_PAYLOAD[]={'+','.join(map(str,PAYLOAD))+'};\n')
            commands=builder.compile_commands('/usr/bin/cc',header,out,request)
            original=builder.compile_commands('/usr/bin/cc',header,out,{})
            old_dm=builder.compile_commands('/usr/bin/cc',header,out,{'profile':builder.DM_PROFILE,'input_kind':builder.NEW_INPUT_KIND})
            self.assertEqual(len(commands),3);self.assertEqual(commands[:2],original[:2]);self.assertEqual(commands[:2],old_dm[:2])
            self.assertEqual({Path(x).name for x in commands[2] if x.endswith('.c')},
                             {'f4-cfp2-guest.c','f4-cfp2-target.c','f4-cfp2-worker.c'})
            self.assertIn('-Wl,--gc-sections',commands[2]);self.assertIn('-DNAPI_VERSION=8',commands[2])
            start=time.monotonic();durations=[]
            for command in commands:
                before=time.monotonic();remaining=10-(before-start);self.assertGreater(remaining,0)
                result=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,timeout=remaining,
                                      env={'PATH':'/usr/bin:/bin','LANG':'C'})
                durations.append(time.monotonic()-before)
                self.assertEqual(result.returncode,0,result.stderr.decode())
            elapsed=time.monotonic()-start;self.assertLess(elapsed,10)
            raw=(out/'brd-f2').read_bytes();builder.build.static_elf(raw);self.assertLess(len(raw),4*1024*1024)
            symbols=subprocess.run(['/usr/bin/nm','-u',str(out/'brd-f2')],capture_output=True,check=True)
            self.assertNotIn(b'napi_',symbols.stdout)
            print(json.dumps({'pure_compile_seconds':elapsed,'three_invocation_seconds':durations,'helper_bytes':len(raw),
                              'helper_sha256':hashlib.sha256(raw).hexdigest(),'guest_starts':0,'claims':0},sort_keys=True))

class OwnerControls(unittest.TestCase):
    def test_full_target_links_original_native_without_napi_runtime(self):
        with tempfile.TemporaryDirectory(prefix='br-f4-link-') as directory:
            owned = Path(directory)
            main = owned / 'target.c'
            main.write_text('#include "f4-cfp2-worker.h"\nint main(void) { return f4_cfp2_run("invalid", "invalid"); }\n')
            program = owned / 'target'
            built = subprocess.run(['/usr/bin/cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror',
                '-ffunction-sections', '-fdata-sections', '-DNAPI_VERSION=8', '-static', '-Wl,--gc-sections',
                '-I', str(HERE), '-I', str(ROOT / 'native/node-api/v24.22.1'),
                str(main), str(HERE / 'f4-cfp2-worker.c'), '-o', str(program)], capture_output=True, timeout=10)
            self.assertEqual(built.returncode, 0, built.stderr.decode())
            symbols = subprocess.run(['/usr/bin/nm', '-u', str(program)], capture_output=True, check=True)
            self.assertNotIn(b'napi_', symbols.stdout)
            bad = subprocess.run([str(program)], capture_output=True, timeout=3)
            self.assertEqual(bad.returncode, 64)
            self.assertEqual(bad.stdout, b'')

    def test_real_closed_regular_owners_use_two_opens_and_unique_tail_transfer(self):
        with tempfile.TemporaryDirectory(prefix='br-f4-owner-') as directory:
            owned = Path(directory); source = owned / 'source'; source.mkdir(mode=0o700)
            (source / 'payload').write_bytes(PAYLOAD); (source / 'payload').chmod(0o600)
            os.utime(source,ns=(946684800000000000,946684800000000000))
            os.utime(source/'payload',ns=(946684800000000000,946684800000000000))
            initial={path:os.stat(path) for path in (source,source/'payload')}
            main = owned / 'control.c'; main.write_text('#include "f4-cfp2-worker.h"\nint main(void) { return f4_cfp2_owner_control(); }\n')
            program = owned / 'control'
            command = ['/usr/bin/cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror',
                '-ffunction-sections', '-fdata-sections', '-DNAPI_VERSION=8', '-DF4_CFP2_OWNER_CONTROL=1',
                '-DF4_CFP2_TEST_ROOT=' + json.dumps(str(source)), '-static', '-Wl,--gc-sections',
                '-I', str(HERE), '-I', str(ROOT / 'native/node-api/v24.22.1'),
                str(main), str(HERE / 'f4-cfp2-worker.c'), '-o', str(program)]
            built = subprocess.run(command, capture_output=True, timeout=10)
            self.assertEqual(built.returncode, 0, built.stderr.decode())
            result = subprocess.run([str(program)], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
            for path,before in initial.items():
                after=os.stat(path)
                self.assertEqual((after.st_ino,after.st_size,after.st_atime_ns,after.st_mtime_ns,after.st_ctime_ns),
                                 (before.st_ino,before.st_size,before.st_atime_ns,before.st_mtime_ns,before.st_ctime_ns))
            rows = [json.loads(line.removeprefix(b'BRDCF4 ')) for line in result.stdout.splitlines()]
            self.assertTrue(rows)
            self.assertEqual(rows[-1]['event'], 'complete')
            self.assertEqual(rows[-1]['data']['scope'], 'owned-file-control')
            self.assertEqual(rows[-1]['data']['first_errno'], 0)
            self.assertEqual(rows[-1]['data']['unknown_closes'], 0)
            self.assertEqual(rows[-1]['data']['live_owners'], 0)
            opened = {row['role']: row['fd'] for row in rows if row['event'] == 'open'}
            self.assertNotEqual(opened['R'], opened['V'])
            self.assertEqual([(r['event'], r['role']) for r in rows if r['event'] in ('sync', 'close', 'transfer')],
                [('sync', 'R'), ('close', 'F'), ('close', 'R'), ('sync', 'V'), ('close', 'V'),
                 ('sync', 'Dp'), ('transfer', 'A'), ('close', 'A'), ('close', 'M')])
            transfer = next(r for r in rows if r['event'] == 'transfer')
            self.assertEqual(transfer['fd'], opened['Dp'])
            self.assertEqual(transfer['data']['old_owner_live'], False)
            offsets = next(r for r in rows if r['event'] == 'offsets')
            self.assertEqual(offsets['data'], {'R': len(PAYLOAD), 'V': 0})
            self.assertEqual(b''.join(bytes.fromhex(r['data']['hex']) for r in rows if r['event'] == 'payload'), PAYLOAD)
            self.assertEqual(sum(r['event'] == 'payload-eof' for r in rows), 1)
            parser = consumer()
            report = parser.parse_owner_control(result.stdout, RUN)
            self.assertEqual(report['state'], 'OWNED_FILE_CONTROL_OBSERVED')
            self.assertEqual(report['syncs'], 3)
            self.assertFalse(report['production_bound'])
            variants = []
            changed = copy.deepcopy(rows); changed.pop(next(i for i,r in enumerate(changed) if r['event']=='open' and r['role']=='V')); variants.append(changed)
            changed = copy.deepcopy(rows); sync = next(i for i,r in enumerate(changed) if r['event']=='sync'); changed.insert(sync, copy.deepcopy(changed[sync])); variants.append(changed)
            for key, value in [('dup', True), ('old_owner_live', True), ('from', 'R')]:
                changed = copy.deepcopy(rows); next(r for r in changed if r['event']=='transfer')['data'][key]=value; variants.append(changed)
            changed = copy.deepcopy(rows); changed[-1]['data']['closes'] += 1; variants.append(changed)
            changed = copy.deepcopy(rows); changed[-1]['data']['unknown_closes'] = 1; variants.append(changed)
            changed = copy.deepcopy(rows); changed[-1]['ns'] = str(int(changed[0]['data']['D0_ns'])+3_000_000_000); variants.append(changed)
            changed = copy.deepcopy(rows); next(r for r in changed if r['event']=='metadata' and r['role']=='M')['data']['ino']+=1; variants.append(changed)
            changed = copy.deepcopy(rows); next(r for r in changed if r['event']=='payload')['data']['hex']=b'wrong'.hex(); variants.append(changed)
            changed = copy.deepcopy(rows); changed.pop(next(i for i,r in enumerate(changed) if r['event']=='close' and r['role']=='F')); variants.append(changed)
            changed = copy.deepcopy(rows); changed.pop(-2); variants.append(changed)
            changed = copy.deepcopy(rows); index=next(i for i,r in enumerate(changed) if r['event']=='payload');changed.insert(index+1,copy.deepcopy(changed[index]));variants.append(changed)
            changed = copy.deepcopy(rows); index=next(i for i,r in enumerate(changed) if r['event']=='open' and r['role']=='V');value=changed.pop(index);changed.insert(next(i for i,r in enumerate(changed) if r['event']=='close' and r['role']=='R')+1,value);variants.append(changed)
            changed = copy.deepcopy(rows); value=copy.deepcopy(next(r for r in changed if r['event']=='open' and r['role']=='F'));changed.insert(next(i for i,r in enumerate(changed) if r['event']=='close' and r['role']=='V')+1,value);variants.append(changed)
            for changed in variants:
                with self.subTest(events=[r['event'] for r in changed]), self.assertRaises(ValueError):
                    parser.parse_owner_control(trace(changed), RUN)
            # 真实源负例复用同一个固定普通文件控制 executable，不注入 syscall 结果。
            payload=source/'payload'
            for case in ('payload-bytes','symlink','hardlink','absent'):
                payload.unlink()
                if case=='payload-bytes':payload.write_bytes(b'X'+PAYLOAD[1:]);payload.chmod(0o600)
                elif case=='symlink':payload.symlink_to('missing')
                elif case=='hardlink':
                    (owned/'linked-payload').write_bytes(PAYLOAD);(owned/'linked-payload').chmod(0o600);os.link(owned/'linked-payload',payload)
                bad=subprocess.run([str(program)],capture_output=True,timeout=3)
                actual=[json.loads(line.removeprefix(b'BRDCF4 ')) for line in bad.stdout.splitlines()]
                self.assertEqual(bad.returncode,1)
                self.assertEqual(actual[-1]['event'],'complete');self.assertNotEqual(actual[-1]['data']['first_errno'],0)
                self.assertEqual(actual[-1]['data']['unknown_closes'],0);self.assertEqual(actual[-1]['data']['live_owners'],0)
                if case!='payload-bytes':self.assertFalse(any(r['event']=='sync' for r in actual))
                with self.assertRaises(ValueError):parser.parse_owner_control(bad.stdout,RUN)
                print(json.dumps({'actual_owned_file_negative':case,'completion':actual[-1]['data']},sort_keys=True))
                if case=='absent':continue
                # 下一轮固定先 unlink；最后 absent 分支不再创建源。
                if case=='symlink':self.assertTrue(payload.is_symlink())

    def test_actual_cancel_and_tail_ebadf_preserve_first_error_and_close_m_once(self):
        for mode in ('CANCEL','TAIL_A_EBADF'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(prefix='br-f4-error-') as directory:
                owned=Path(directory);source=owned/'source';source.mkdir(mode=0o700)
                (source/'payload').write_bytes(PAYLOAD);(source/'payload').chmod(0o600)
                main=owned/'control.c';main.write_text('#include "f4-cfp2-worker.h"\nint main(void) { return f4_cfp2_owner_control(); }\n')
                program=owned/'control'
                command=['/usr/bin/cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-ffunction-sections','-fdata-sections',
                    '-DNAPI_VERSION=8','-DF4_CFP2_OWNER_CONTROL=1','-DF4_CFP2_TEST_'+mode+'=1',
                    '-DF4_CFP2_TEST_ROOT='+json.dumps(str(source)),'-static','-Wl,--gc-sections','-I',str(HERE),
                    '-I',str(ROOT/'native/node-api/v24.22.1'),str(main),str(HERE/'f4-cfp2-worker.c'),'-o',str(program)]
                built=subprocess.run(command,capture_output=True,timeout=10);self.assertEqual(built.returncode,0,built.stderr.decode())
                actual=subprocess.run([str(program)],capture_output=True,timeout=3)
                self.assertEqual(actual.returncode,1);rows=[json.loads(line.removeprefix(b'BRDCF4 ')) for line in actual.stdout.splitlines()]
                final=rows[-1]['data'];self.assertEqual(rows[-1]['event'],'complete')
                # 原 worker 对 unknown 保留数值 slot，禁止把未知清理写成已关闭。
                self.assertEqual(final['live_owners'],1 if mode=='TAIL_A_EBADF' else 0)
                closes=[r for r in rows if r['event']=='close'];self.assertEqual(sum(r['role']=='M' for r in closes),1)
                if mode=='CANCEL':
                    self.assertEqual(final['first_errno'],125);self.assertEqual(final['unknown_closes'],0)
                    self.assertFalse(any(r['event']=='sync' for r in rows))
                else:
                    self.assertEqual(final['first_errno'],9);self.assertEqual(final['cleanup_errno'],9)
                    self.assertEqual(final['unknown_closes'],1)
                    self.assertEqual([(r['role'],r['rc'],r['errno']) for r in closes[-2:]],[('A',-1,9),('M',0,0)])
                    self.assertEqual(sum(r['role']=='A' for r in closes),1)
                with self.assertRaises(ValueError):consumer().parse_owner_control(actual.stdout,RUN)
                print(json.dumps({'actual_owned_error':mode,'completion':final,'tail_closes':[(r['role'],r['rc'],r['errno']) for r in closes]},sort_keys=True))

if __name__ == '__main__': unittest.main()

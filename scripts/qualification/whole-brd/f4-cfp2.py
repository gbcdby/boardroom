"""CFP2 clean-regular 的独立严格消费者；导入不打开设备或启动 guest。

普通文件控制不能进入 guest 成功路径。原 DM/SP 完整块消费者复用原函数，
本模块不修改其白名单，也不把新 R/V/F trace 转换为旧 ordinary trace。
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import re
import stat
import struct
import sys

import f0
import f0b
import f2
import f3

_spec = importlib.util.spec_from_file_location('fixed_f4_cfp2_dm_helpers', Path(__file__).with_name('f3-dm.py'))
dm = sys.modules.get(_spec.name)
if dm is None:
    dm = importlib.util.module_from_spec(_spec)
    sys.modules[_spec.name] = dm
    _spec.loader.exec_module(dm)

PROFILE = 'whole-brd-f4-cfp2-clean-regular-v1'
SCOPE = 'https://github.com/gbcdby/boardroom/issues/152#issuecomment-7030904017'
STATE = 'CFP2_CLEAN_REGULAR_NATIVE_MECHANISM_OBSERVED'
LIMITS = dict(f3.LIMITS)
MANAGEMENT_BYTES = dm.MANAGEMENT_BYTES
FRAME_BYTES = f3.FRAME_BYTES
PAYLOAD = f3.PAYLOAD
need, encoded = f3.need, f3.encoded
payload, inspect_payload, mkfs_argv = dm.payload, dm.inspect_payload, dm.mkfs_argv
FIELDS = ('v','run_id','pid','seq','ns','event','role','fd','rc','errno','data')
META_FIELDS = ('stage','dev','ino','mode','uid','gid','nlink','size','fs_type','atime_ns','mtime_ns','ctime_ns','mount_id','mount_unique')
HEALTH = ('errors_count','first_error_errcode','last_error_errcode','first_error_ino','last_error_ino',
          'first_error_block','last_error_block','first_error_line','last_error_line','first_error_time',
          'last_error_time','first_error_func','last_error_func')


def plan(raw):
    result = dm.plan(raw)
    result.update(kind='fixed-private-whole-brd-f4-cfp2-clean-regular', profile=PROFILE, scope=SCOPE,
                  native_target='fixed-original-C-worker-without-NAPI-runtime',
                  source_roles=['R','V','F','Dp','M','A'], source_fsyncs=3,
                  production_bound=False, commit_barrier=False, qualification='UNSUPPORTED')
    return result


def _integer(value, minimum=0, maximum=(1 << 63)-1):
    need(type(value) is int and minimum <= value <= maximum, 'F4 exact integer bound')
    return value


def _ns(value):
    need(type(value) is str and re.fullmatch(r'[0-9]{1,19}',value) is not None and
         (value == '0' or value[0] != '0'), 'F4 nanosecond spelling')
    return _integer(int(value))


def _hex(value, maximum):
    return dm._hex(value, maximum)


def _rows(raw, run_id):
    f0._uuid(run_id)
    need(type(raw) is bytes and 0 < len(raw) <= MANAGEMENT_BYTES, 'F4 trace aggregate budget')
    rows=[]
    for line in raw.splitlines(keepends=True):
        need(line.startswith(b'BRDCF4 ') and line.endswith(b'\n') and len(line)<=FRAME_BYTES,
             'F4 complete bounded trace frame')
        row=f0b._json(line[7:-1]);f0._fields(row,FIELDS)
        need(type(row['v']) is int and row['v']==1 and row['run_id']==run_id, 'F4 source/run/version')
        _integer(row['pid'],1,0x7fffffff);_integer(row['fd'],-1,0x7fffffff);_integer(row['rc'],-1,1048577);_integer(row['errno'],0,4095)
        need(type(row['seq']) is int and row['seq']==len(rows)+1 and len(rows)<32768,
             'F4 replay/sequence/operation count')
        need(type(row['event']) is str and type(row['role']) is str and type(row['data']) is dict,
             'F4 event/role/payload type')
        # C trace 只有平坦标量；Python 的 True==1 不得把未执行标记变成真实计数。
        boolean_fields={'ran','unknown','last','directory','metadata_only','dup','old_owner_live','eof'}
        need(all(type(value) is bool if key in boolean_fields else type(value) in (str,int)
                 for key,value in row['data'].items()),'F4 exact scalar/boolean counter types')
        stamp=_ns(row['ns']);need(stamp>0 and (not rows or stamp>=_ns(rows[-1]['ns'])), 'F4 monotonic trace')
        need(not rows or row['pid']==rows[0]['pid'], 'F4 mixed child PID')
        rows.append(row)
    return rows


class _Trace:
    def __init__(self, raw, run_id, *, scope, binding=None):
        self.rows=_rows(raw,run_id);self.cursor=0;self.scope=scope;self.binding=binding
        self.pid=self.rows[0]['pid'];self.roles={};self.metadata={};self.aux={};self.aux_identity={}
        self.run_id=run_id
        self.counts=dict(opens=0,syncs=0,closes=0,transfers=0,reads=0,payload_bytes=0,eofs=0,aux_opens=0,aux_closes=0)
        self.stable={};self.context_bytes=0;self.process_start=None
        self.journal_priority=None

    def take(self,event,role=None,fd=None,*,rc=0,error=0):
        need(self.cursor<len(self.rows),'F4 missing '+event)
        row=self.rows[self.cursor];self.cursor+=1
        need(row['event']==event and (role is None or row['role']==role) and (fd is None or row['fd']==fd),
             'F4 missing/reordered/wrong-owner '+event)
        need(row['rc']==rc and row['errno']==error,'F4 native error/unknown completion at '+event)
        return row

    def meta(self,role,stage):
        row=self.take('metadata',role,self.roles[role]);data=row['data'];f0._fields(data,META_FIELDS)
        need(data['stage']==stage,'F4 metadata phase')
        for key in ('dev','ino','mode','uid','gid','nlink','size','fs_type','mount_id','mount_unique'):_integer(data[key])
        need(all(data[key]>0 for key in ('dev','ino','nlink','mount_id','mount_unique')),'F4 metadata positive identity')
        for key in ('atime_ns','mtime_ns','ctime_ns'):_ns(data[key])
        directory=role in ('Dp','A');need(stat.S_ISDIR(data['mode']) if directory else stat.S_ISREG(data['mode']), 'F4 exact object kind')
        need(not data['mode']&0o22 and (directory or data['nlink']==1 and data['size']==len(PAYLOAD)), 'F4 writable/link/content metadata')
        stable={k:v for k,v in data.items() if k!='stage'};key='parent' if directory else 'payload'
        if key in self.metadata:need(self.metadata[key]==stable,'F4 source metadata changed')
        else:self.metadata[key]=stable
        if not directory:
            need(all(data[k]==self.metadata['parent'][k] for k in ('dev','uid','gid','fs_type','mount_id','mount_unique')),
                 'F4 cross-source/cross-mount parent')
        if self.binding is not None:
            need(data['fs_type']==0xef53,'F4 actual source filesystem type')
            source=self.binding['view']['objects']['.' if directory else 'payload']
            need(all(data[k]==source[k] for k in ('dev','ino','mode','uid','gid','nlink','size')), 'F4 raw source view metadata binding')
            need(all(int(data[k+'_ns'])==source[k][0]*1000000000+source[k][1] for k in ('atime','mtime','ctime')),
                 'F4 full source times binding')
        return stable

    def open(self,role):
        row=self.take('open',role);data=row['data'];f0._fields(data,('parent_fd','metadata_only','directory','flags','fd_flags'))
        fd=_integer(row['fd'],3);need(role not in self.roles and fd not in self.roles.values() and fd not in self.aux,'F4 duplicate/reused live FD')
        need(data['parent_fd']==(-100 if role=='Dp' else self.roles['Dp']) and data['metadata_only'] is (role=='M')
             and data['directory'] is (role=='Dp'),'F4 independent open/source carrier')
        flags=0x220000 if role=='M' else 0x40000|0x20000|0x800|0x8000|(0x10000 if role=='Dp' else 0)
        need(type(data['flags']) is int and data['flags']==flags and type(data['fd_flags']) is int and data['fd_flags']==1,
             'F4 actual readonly NOFOLLOW/NOATIME/O_PATH/CLOEXEC flags')
        self.roles[role]=fd;self.counts['opens']+=1;self.meta(role,'opened')

    def sync(self,role):
        row=self.take('sync',role,self.roles[role]);need(row['data']=={'ran':True},'F4 sync actual completion')
        self.counts['syncs']+=1;self.meta(role,'after-sync')

    def close(self,role):
        row=self.take('close',role,self.roles[role]);need(row['data']=={'ran':True},'F4 close actual completion')
        self.counts['closes']+=1;del self.roles[role]

    def content(self):
        self.meta('R','before-read')
        row=self.take('payload','R',self.roles['R'],rc=len(PAYLOAD));need(row['data']=={'offset':0,'hex':PAYLOAD.hex()},'F4 one complete original payload read')
        self.counts['reads']+=1;self.counts['payload_bytes']+=len(PAYLOAD)
        self.meta('R','after-read');self.meta('R','before-read')
        row=self.take('payload-eof','R',self.roles['R']);need(row['data']=={'offset':len(PAYLOAD)},'F4 original R EOF')
        self.counts['reads']+=1;self.counts['eofs']+=1;self.meta('R','after-eof')
        row=self.take('offsets','R',self.roles['R']);need(row['data']=={'R':len(PAYLOAD),'V':0},'F4 independent R/V open descriptions')

    def raw(self,stage,phase,name,fd,maximum,*,stable=True):
        output=bytearray();total=None
        while True:
            row=self.take('raw','aux',fd);data=row['data'];f0._fields(data,('stage','pass','name','offset','total','hex','last'))
            need((data['stage'],data['pass'],data['name'])==(stage,phase,name),'F4 raw source/phase/name')
            _integer(data['total'],0,maximum);_integer(data['offset'],0,maximum)
            if total is None:total=data['total']
            need(total==data['total'] and data['offset']==len(output),'F4 missing/overlap raw bytes')
            chunk=_hex(data['hex'],8192);output.extend(chunk)
            need(len(output)<=total and type(data['last']) is bool and data['last'] is (len(output)==total), 'F4 raw framing/EOF')
            if data['last']:break
            need(len(chunk)==8192,'F4 short nonterminal raw frame')
        result=bytes(output);self.context_bytes+=len(result)
        need(self.context_bytes<=2*1024*1024,'F4 original context byte budget')
        if stable:
            if name in self.stable:need(result==self.stable[name],'F4 raw before/after changed '+name)
            else:self.stable[name]=result
        return result

    def aux_open(self,name,path,magic,flags=0x20800):
        row=self.take('aux-open','aux');fd=_integer(row['fd'],3)
        need(fd not in self.roles.values() and fd not in self.aux,'F4 auxiliary/source alias')
        need(row['data']=={'name':name,'path_hex':path.encode().hex(),'flags':flags|0x80000}, 'F4 fixed auxiliary pathname/flags')
        self.aux[fd]=name;self.counts['aux_opens']+=1
        row=self.take('aux-stat','aux',fd);data=row['data'];f0._fields(data,('name','dev','ino','mode','fs_type'))
        need(data['name']==name and data['fs_type']==magic,'F4 auxiliary filesystem identity')
        for key in ('dev','ino','mode'):_integer(data[key],1)
        need(stat.S_ISDIR(data['mode']) if flags & 0x10000 else stat.S_ISREG(data['mode']),
             'F4 auxiliary object kind')
        if name in self.aux_identity:need(data==self.aux_identity[name],'F4 auxiliary object identity changed')
        else:self.aux_identity[name]=data
        return fd

    def aux_close(self,name,fd):
        row=self.take('aux-close','aux',fd)
        need(self.aux.pop(fd,None)==name and row['data']=={'name':name,'ran':True,'unknown':False},'F4 unknown/missing auxiliary close')
        self.counts['aux_closes']+=1

    def file(self,stage,phase,name,path,magic,maximum,*,stable=True):
        fd=self.aux_open(name,path,magic);length=0
        for _ in range(256):
            need(self.cursor<len(self.rows),'F4 auxiliary read/EOF missing')
            count=self.rows[self.cursor]['rc'];_integer(count,0,maximum+1)
            row=self.take('aux-read','aux',fd,rc=count);need(row['data']=={'name':name,'offset':length},'F4 auxiliary actual read ordering')
            length+=count;need(length<=maximum,'F4 auxiliary read budget')
            if count==0:break
        else:raise ValueError('F4 original per-fact read count budget')
        raw=self.raw(stage,phase,name,fd,maximum,stable=stable);need(len(raw)==length,'F4 actual reads/raw mismatch')
        self.aux_close(name,fd);return raw

    def enumeration(self,stage,phase,name,path,magic):
        fd=self.aux_open(name,path,magic,0x30800)
        row=self.take('enumeration','aux',fd);data=row['data'];f0._fields(data,('name','entries','eof'))
        count=_integer(data['entries'],0,128);need(data['name']==name and data['eof'] is True,'F4 bounded actual enumeration EOF')
        raw=self.raw(stage,phase,name,fd,32768)
        names=[] if not raw else raw.split(b'\0')[:-1]
        need((not raw or raw.endswith(b'\0')) and len(names)==count and names==sorted(set(names))
             and all(0<len(name)<=255 and b'/' not in name and name not in (b'.',b'..') for name in names),'F4 enumeration exact names')
        self.aux_close(name,fd);return names

    def directory(self,stage):
        self.meta('Dp','before-members');row=self.take('aux-open','aux');fd=_integer(row['fd'],3)
        need(fd not in self.roles.values() and fd not in self.aux and
             row['data']=={'name':'source-members','dup_from':self.roles['Dp']}, 'F4 original NOATIME directory dup')
        self.aux[fd]='source-members';self.counts['aux_opens']+=1
        row=self.take('enumeration','aux',fd);need(row['data']=={'name':'source-members','entries':4,'eof':True},'F4 complete parent members')
        raw=self.raw(stage,'members','source-members',fd,1024)
        need(raw==b'ancestor\0directory\0lost+found\0payload\0','F4 current parent name closure')
        self.aux_close('source-members',fd);self.meta('Dp','after-members')

    def extended(self,role,stage):
        self.meta(role,'extended-before');fd=self.roles[role];kind='parent' if role=='Dp' else 'payload'
        values={}
        for name,length in (('uuid',17),('fid',136),('flags',8),('xattr-names',65536),('xattr-value',16384),('xattr-names-after',65536)):
            rc=35 if name.startswith('xattr-names') else 13 if name=='xattr-value' else 0
            row=self.take('getter',role,fd,rc=rc);expected={'stage':stage,'name':name}
            if name=='fid':expected['mount_unique']=self.metadata['payload']['mount_unique'] if kind=='payload' else self.metadata['parent']['mount_unique']
            need(row['data']==expected,'F4 full getter exact binding')
            values[name]=self.raw(stage,role,kind+'.'+name,fd,length)
        need(values['uuid']==b'\x10'+bytes.fromhex(self.binding['metadata']['uuid'].replace('-','')),'F4 current filesystem UUID')
        fid=values['fid'];need(len(fid)==16 and struct.unpack_from('<II',fid)==(8,1),'F4 exact ext4 FID ABI')
        inode=struct.unpack_from('<I',fid,8)[0]
        # generation 是不透明完整 FID 的一部分；真实固定 ext4 root 可以为 0。
        need(inode==self.metadata[kind]['ino'],'F4 FID/inode binding')
        if kind=='parent':need(fid[8:].hex()==self.binding['metadata']['fid_hex'],'F4 same boot root FID')
        flags=struct.unpack('<Q',values['flags'])[0]
        need(flags in ((0x80000,0x81000) if kind=='parent' else (0x80000,)),'F4 ext4 inode flags')
        need(values['xattr-names']==values['xattr-names-after']==b'user.boardroom-source-preservation\0'
             and values['xattr-value']==b'owned-fixture','F4 complete fixed xattrs')
        self.meta(role,'extended-after')

    def configuration(self,stage,phase):
        native=f2._module('native');device=self.binding['device']
        role='V' if stage=='after-v' else 'M';carrier='A' if stage=='tail' else 'Dp'
        fd=self.roles[role];parent=self.metadata['parent'];source=self.metadata['payload']
        self.meta(carrier,'configuration-before')
        row=self.take('source-path',role,fd)
        need(row['data']==dict(stage=stage,**{'pass':phase},carrier_fd=self.roles[carrier],
             source_ino=source['ino'],parent_ino=parent['ino'],dev=source['dev'],
             mount_id=source['mount_id'],mount_unique=source['mount_unique']), 'F4 current path/source/carrier binding')
        values=[]
        for kind,mask,mount in (('legacy',0x17ff,source['mount_id']),('unique',0x4fff,source['mount_unique'])):
            row=self.take('configuration',role,fd)
            need(row['data']==dict(stage=stage,**{'pass':phase},name='statx-'+kind),'F4 current statx call')
            raw=self.raw(stage,phase,'source.statx-'+kind,fd,256);value=native.decode_statx(raw);values.append(value)
            need(value['mask']&mask==mask and value['unique_id']==mount and
                 (value['dev_major'],value['dev_minor'])==(device.major,device.minor) and
                 all(value[key]==source[key] for key in ('ino','mode','nlink','size','uid','gid')), 'F4 same live source statx')
            for offset,key in ((64,'atime'),(96,'ctime'),(112,'mtime')):
                sec,nsec=struct.unpack_from('<qI',raw,offset)
                need(0<=nsec<1000000000 and sec*1000000000+nsec==int(source[key+'_ns']),'F4 statx full source times')
            birth=struct.unpack_from('<qI',raw,80)
            need(birth[0]>=0 and birth[1]<1000000000 and native.inode_guard(0x80000,value['attributes'],value['attributes_mask'],directory=False),
                 'F4 source birthtime/non-DAX attributes')
        need({k:v for k,v in values[0].items() if k not in ('mask','unique_id')}==
             {k:v for k,v in values[1].items() if k not in ('mask','unique_id')},'F4 legacy/unique selected object agreement')
        row=self.take('configuration',carrier,self.roles[carrier])
        need(row['data']==dict(stage=stage,**{'pass':phase},name='get-tune'),'F4 actual live readable carrier GET_TUNE')
        tune=native.decode_tune(self.raw(stage,phase,'filesystem.tune',self.roles[carrier],232))
        need(tune['feature_masks']==self.binding['metadata']['features']==[60,710,1131],'F4 source feature vector')
        row=self.take('configuration',role,fd)
        need(row['data']==dict(stage=stage,**{'pass':phase},name='statmount'),'F4 current mount query')
        request=self.raw(stage,phase,'source.statmount-request',fd,32)
        need(request==struct.pack('<IIQQQ',32,0,source['mount_unique'],59,0),'F4 exact current mount request')
        mount=native.decode_statmount(self.raw(stage,phase,'source.statmount',fd,16384))
        need(mount['unique_id']==source['mount_unique'] and mount['legacy_id']==source['mount_id']
             and (mount['dev_major'],mount['dev_minor'])==(device.major,device.minor) and mount['type']=='ext4'
             and mount['magic']==0xef53 and mount['root']=='/' and mount['point']=='/mnt/brd'
             and mount['attr']==0xe and mount['propagation']==1<<18 and not mount['sb_flags']&1,
             'F4 fixed full-root current mount binding')
        self.meta(carrier,'configuration-after')
        return mount

    def environment(self,stage):
        native=f2._module('native');p1=self.binding['p1']['observations'];device=self.binding['device']
        role='V' if stage=='after-v' else 'M';carrier='A' if stage=='tail' else 'Dp';fd=self.roles[role]
        row=self.take('environment-begin',role,fd)
        need(row['data']==dict(stage=stage,carrier_fd=self.roles[carrier]) and not self.aux,'F4 fresh environment owner')
        sysname=self.binding['dm']['sysname']
        need(re.fullmatch(r'dm-[0-9]+',sysname) is not None,'F4 actual DM sysname')
        for phase in ('before','after'):
            row=self.take('credentials','aux',-1)
            need(row['data']==dict(stage=stage,**{'pass':phase},uid=1000,gid=1000,groups=0,no_new_privs=1,ppid=1,tid=self.pid),
                 'F4 current ordinary thread identity')
            mount=self.configuration(stage,phase)
            for leaf in ('pid','mnt','user'):
                name='namespace.'+leaf;path=f'/proc/{self.pid}/task/{self.pid}/ns/'+leaf
                nsfd=self.aux_open(name,path,0x6e736673,0)
                link=p1['ns_'+leaf]['raw'];row=self.take('namespace-link','aux',nsfd,rc=len(link))
                need(row['data']==dict(stage=stage,**{'pass':phase},name=name),'F4 current namespace link call')
                raw=self.raw(stage,phase,name,nsfd,128)
                match=re.fullmatch(leaf.encode()+rb':\[([1-9][0-9]*)\]',raw)
                need(raw==link and match is not None and int(match[1])==self.aux_identity[name]['ino'],
                     'F4 same boot namespace FD/link identity')
                self.aux_close(name,nsfd)
            uname=self.raw(stage,phase,'uname',-1,390)
            need(len(uname)==390 and uname==p1['uname']['raw'],'F4 actual fixed kernel uname')
            status=self.file(stage,phase,'thread-status',f'/proc/{self.pid}/task/{self.pid}/status',0x9fa0,65536,stable=False)
            identity=f0b._ordinary_status(status)
            need(identity['pid']==self.pid,'F4 actual ordinary owner PID')
            fields={}
            for line in status.splitlines():
                key,sep,value=line.partition(b':')
                need(sep and key not in fields,'F4 unambiguous current status fields');fields[key]=value.strip()
            need(fields.get(b'Tgid')==str(self.pid).encode() and fields.get(b'Threads')==b'1','F4 fixed single-thread owner')
            proc=self.file(stage,phase,'process-stat',f'/proc/{self.pid}/stat',0x9fa0,8192,stable=False)
            begin=proc.find(b' (');end=proc.rfind(b') ')
            need(begin>0 and end>begin and proc[:begin]==str(self.pid).encode(),'F4 current process stat PID')
            parts=proc[end+2:].split();need(len(parts)>=22 and parts[1]==b'1' and all(re.fullmatch(rb'[0-9]+',parts[i]) for i in (6,19)),
                                          'F4 current process stat fields')
            start=int(parts[19]);need(start>0 and not int(parts[6])&0x200000,'F4 ordinary process/start identity')
            if self.process_start is None:self.process_start=start
            else:need(self.process_start==start,'F4 process generation changed')
            mounts=native.mountinfo(self.file(stage,phase,'mountinfo',f'/proc/{self.pid}/task/{self.pid}/mountinfo',0x9fa0,1048576))
            selected=[m for m in mounts if m['id']==mount['legacy_id']]
            need(len(selected)==1 and selected[0]['device']==f'{device.major}:{device.minor}' and selected[0]['root']=='/'
                 and selected[0]['point']=='/mnt/brd' and selected[0]['type']=='ext4','F4 current mountinfo source')
            baseline=native.mountinfo(p1['mountinfo']['raw'])
            need([m for m in mounts if m['id']!=mount['legacy_id']]==baseline,'F4 current namespace mount closure')
            boot=self.file(stage,phase,'boot-id','/proc/sys/kernel/random/boot_id',0x9fa0,4096)
            cmdline=self.file(stage,phase,'cmdline','/proc/cmdline',0x9fa0,16384)
            notes=self.file(stage,phase,'kernel-notes','/sys/kernel/notes',0x62656572,1048576)
            need(boot==p1['boot_id']['raw'] and cmdline==p1['cmdline']['raw']==(f0b.CMDLINE+'\n').encode()
                 and notes==p1['notes']['raw'] and hashlib.sha256(notes).hexdigest()==f2.NOTES_SHA,'F4 same boot/kernel inputs')
            row=self.take('unsupported','aux',-1)
            need(row['data']==dict(stage=stage,**{'pass':phase},name='kernel-config',reason='unsupported'),'F4 unavailable kernel config remains explicit')
            resolved=self.raw(stage,phase,'device.path',-1,4096)
            need(resolved==('/sys/devices/virtual/block/'+sysname).encode(),'F4 source actual sysfs route')
            for leaf,value in (('name','br-f3-'+self.run_id.replace('-','')),('uuid','boardroom-f3-dm:'+self.run_id)):
                actual=self.file(stage,phase,'device.dm-'+leaf,f'/sys/devices/virtual/block/{sysname}/dm/{leaf}',0x62656572,256)
                need(actual==(value+'\n').encode(),'F4 same run DM named identity')
            for kind,node,dev in (('source',sysname,f'{device.major}:{device.minor}'),('backing','ram0','1:0')):
                base='/sys/devices/virtual/block/'+node;facts={}
                for leaf in ('dev','uevent','size','ro','diskseq'):
                    facts[leaf]=self.file(stage,phase,'graph.'+kind+'.'+leaf,base+'/'+leaf,0x62656572,4096)
                need(facts['dev']==(dev+'\n').encode() and facts['size']==b'131072\n' and facts['ro']==b'0\n'
                     and re.fullmatch(rb'[1-9][0-9]*\n',facts['diskseq']) is not None,'F4 fixed source/backing block geometry')
                uevent={}
                for line in facts['uevent'].splitlines():
                    key,sep,value=line.partition(b'=')
                    need(sep and key not in uevent and re.fullmatch(rb'[A-Z0-9_]+',key),'F4 actual device uevent fields');uevent[key]=value
                major,minor=dev.split(':')
                need(all(uevent.get(k)==v for k,v in ((b'MAJOR',major.encode()),(b'MINOR',minor.encode()),(b'DEVNAME',node.encode()),(b'DEVTYPE',b'disk')))
                     and (b'DISKSEQ' not in uevent or uevent[b'DISKSEQ']==facts['diskseq'].rstrip(b'\n')),'F4 uevent device/disk generation binding')
                sets={}
                for leaf in ('slaves','holders',''):
                    sets[leaf]=self.enumeration(stage,phase,'graph.'+kind+'.'+(leaf or 'entries'),base+'/'+leaf,0x62656572)
                need(sets['slaves']==([b'ram0'] if kind=='source' else []) and sets['holders']==([] if kind=='source' else [sysname.encode()])
                     and set(sets['']) >= {b'dev',b'uevent',b'size',b'ro',b'diskseq',b'slaves',b'holders'} and b'partition' not in sets[''],
                     'F4 closed bidirectional actual device topology')
                row=self.take('absence','aux',-1,rc=-1,error=2)
                need(row['data']==dict(stage=stage,**{'pass':phase},name='graph.'+kind+'.partition'),'F4 real partition absence')
            options=native.options(self.file(stage,phase,'options',f'/proc/fs/ext4/{sysname}/options',0x9fa0,16384))
            mb=self.file(stage,phase,'mb_groups',f'/proc/fs/ext4/{sysname}/mb_groups',0x9fa0,16384)
            need(options==self.binding['metadata']['effective_options'] and b'\0' not in mb,'F4 current complete effective configuration')
            task=self.file(stage,phase,'journal-task',f'/sys/fs/ext4/{sysname}/journal_task',0x62656572,4096)
            need(re.fullmatch(rb'[1-9][0-9]*\n',task) is not None,'F4 live journal task')
            need(self.cursor<len(self.rows),'F4 missing actual journal priority query')
            who=_integer(int(task),1,0x7fffffff);priority=_integer(self.rows[self.cursor]['rc'],0,0x7fffffff)
            row=self.take('ioprio','aux',-1,rc=priority)
            need(row['data']==dict(stage=stage,**{'pass':phase},which=1,who=who),'F4 actual journal priority query')
            if self.journal_priority is None:self.journal_priority=priority
            else:need(priority==self.journal_priority,'F4 journal priority changed')
            for name in HEALTH:
                value=self.file(stage,phase,name,f'/sys/fs/ext4/{sysname}/{name}',0x62656572,4096)
                need(value==(b'\n' if name.endswith('_func') else b'0\n'),'F4 fresh health nonzero/unknown '+name)
        self.configuration(stage,'final');self.meta('M','environment-after')
        row=self.take('environment-end',role,fd)
        need(row['data']==dict(stage=stage,carrier_fd=self.roles[carrier],aux_live=0) and not self.aux
             and self.counts['aux_opens']==self.counts['aux_closes'],'F4 all current auxiliary resources settled')

    def execute(self):
        row=self.take('begin','-',-1);data=row['data']
        f0._fields(data,('profile','scope','D0_ns','product_budget_ns','child_budget_ns','uuid'))
        need(data['profile']==PROFILE and data['scope']==self.scope and data['product_budget_ns']=='120000000000'
             and data['child_budget_ns']=='3000000000','F4 exact profile/scope/original budgets')
        start=_ns(data['D0_ns']);need(0<start<=_ns(row['ns']),'F4 D0 before first lookup')
        full=self.scope=='clean-regular-native'
        need(data['uuid']==(self.binding['metadata']['uuid'] if full else 'control-only'),'F4 input filesystem identity')
        self.open('Dp');self.open('M')
        if full:self.environment('before');self.extended('Dp','before');self.directory('before')
        self.open('R');self.open('V')
        if full:self.extended('R','before');self.extended('V','before')
        self.sync('R');self.content();self.open('F')
        if full:self.extended('F','reopen')
        self.close('F')
        if full:self.extended('R','after')
        self.meta('R','before-close');self.close('R');self.sync('V')
        if full:self.extended('V','after');self.environment('after-v')
        self.close('V');self.meta('Dp','before-sync')
        if full:self.directory('after')
        self.sync('Dp')
        row=self.take('transfer','A',self.roles['Dp'])
        need(row['data']=={'from':'Dp','old_owner_live':False,'dup':False} and not self.aux,'F4 unique carrier transfer after auxiliary settlement')
        self.roles['A']=self.roles.pop('Dp');self.counts['transfers']+=1;self.meta('M','tail')
        if full:self.environment('tail')
        self.close('A');self.close('M')
        row=self.take('complete','-',-1)
        need(row['data']==dict(scope=self.scope,first_errno=0,cleanup_errno=0,unknown_closes=0,live_owners=0,**self.counts),
             'F4 independent syscall counters/first error/cleanup mismatch')
        need(not self.roles and not self.aux and self.counts['aux_opens']==self.counts['aux_closes'] and self.cursor==len(self.rows),
             'F4 missing close/extra call after completion')
        need(start<_ns(row['ns'])<start+3_000_000_000,'F4 original child/D0 budget exceeded')
        return {'state':'NATIVE_TRACE_CLOSED' if full else 'OWNED_FILE_CONTROL_OBSERVED','pid':self.pid,
                'D0_ns':start,'native_window_closed_ns':_ns(row['ns']),**self.counts,
                'qualification':'UNSUPPORTED','production_bound':False,'commit_barrier':False}


def parse_owner_control(raw,run_id):
    """仅测试普通自有文件。该状态无法被 decode_serial 当成 guest 结果。"""
    return _Trace(raw,run_id,scope='owned-file-control').execute()


def parse_native_trace(raw,run_id,binding):
    """必须由同次外层消费者交付原始来源；本函数自身不输出 guest 成功。"""
    return _Trace(raw,run_id,scope='clean-regular-native',binding=binding).execute()


def native_window(raw,end_frame,metadata,before,after,view,device,p1,dm_proof,run_id):
    value=f0b._json(end_frame['raw'])
    f0._fields(value,('pid','exit','signal','timeout','reaped','pidfd_before_ack','joined_ns'))
    joined=_ns(value.pop('joined_ns'));wait=f2._wait({'raw':encoded(value)})
    result=parse_native_trace(raw,run_id,dict(metadata=metadata,view=view,device=device,p1=p1,dm=dm_proof))
    need(result['pid']==wait['pid'],'F4 actual owned child receipt/source PID')
    need(int(before.after['at_ns'])<result['D0_ns']<=result['native_window_closed_ns']<joined<int(after.before['at_ns']),
         'F4 source baseline/actual native close/actual join/window bound')
    need(joined<result['D0_ns']+3_000_000_000,'F4 actual child join charged to original D0/budget')
    return result|{'Tcut_ns':joined,'actual_reaped':True,'pidfd_before_ack':True}


# 保留原 DM 生命周期与最窄完整块分类；新 read trace 由独立消费者逐项消费。
def decode_serial(raw, run_id, expected_notes):
    plan(encoded({"run_id":run_id}))
    need(type(raw) is bytes and len(raw)<=LIMITS["serial_bytes"], "F3 serial byte budget")
    legacy, ordinary, frames, positions, native_raw = [], [], [], {}, {}
    active = None
    management_bytes = 0
    dm_ordinary = []
    p1_positions = []
    for pos, line in enumerate(raw.splitlines(keepends=True)):
        protocol = line.startswith((b"BRDF1 ",b"BRDF2 ",b"BRDF3 ",b"BRDDM ",b"BRDCF4 "))
        if protocol or active is not None:
            need(line.endswith(b"\n") and len(line)<=FRAME_BYTES, "incomplete/oversized serial frame")
        if b"BRDCF4 " in line:
            need(active=="read" and line.startswith(b"BRDCF4 "),"F4 trace outside its owned read window")
            management_bytes += len(line)
            need(management_bytes<=MANAGEMENT_BYTES,"F4 management/native aggregate byte budget")
            native_raw[active].extend(line)
            continue
        if line.startswith(b"BRDDM "):
            dm_ordinary.append((pos, f0b._json(line[6:].rstrip(b"\r\n"))))
            continue
        if line.startswith(b"BRDF1 "): p1_positions.append(pos)
        if b"BRDF3 " in line:
            need(line.startswith(b"BRDF3 "), "interleaved F3 frame")
            management_bytes += len(line)
            need(management_bytes <= MANAGEMENT_BYTES, "F3 management aggregate byte budget")
            row = f0b._json(line[6:].rstrip(b"\r\n"))
            data, _ = dm._frame(row,run_id)
            need(row["seq"]==len(frames)+1 and len(frames)<34816, "F3 sequence/replay/count")
            need(row["rc"]==row["errno"]==row["close_errno"]==0, "F3 native/cleanup failure")
            if row["event"]=="native-begin":
                need(active is None and row["phase"] in ("control","read") and row["phase"] not in native_raw, "native phase replay")
                need(data== (b"context" if row["phase"]=="control" else b"ordinary"),"native mode binding")
                active=row["phase"];native_raw[active]=bytearray()
            elif row["event"]=="native-end":
                need(active==row["phase"],"native end without owner");active=None
            frames.append(row | {"raw":data,"position":pos})
            positions.setdefault((row["phase"],row["event"]),[]).append(pos)
            continue
        if b"BRDF2 " in line:
            need(line.startswith(b"BRDF2 ") and len(line)<=FRAME_BYTES and line.endswith(b"\n"),"F2 frame integrity")
            row=f0b._json(line[6:].rstrip(b"\r\n"))
            need(row.get("run_id")==run_id,"current boot F2 origin")
            if row.get("origin")=="ordinary": ordinary.append((pos,row));continue
            f0._fields(row,("run_id","origin","seq","event","rc","errno","close_errno","bytes","data_hex"))
            need(row["origin"]=="management" and type(row["seq"]) is int and row["seq"]==len(legacy)+1,
                 "F2 management sequence")
            need(all(type(row[key]) is int and row[key]==0 for key in ("rc","errno","close_errno")),"F2 management failure")
            legacy.append(row|{"raw":f2._raw(row,(FRAME_BYTES-512)//2),"position":pos})
            continue
        if active is not None:
            need(active=="control" and line.startswith(b"{"),"wrong native protocol or interleaved F4 output")
            management_bytes += len(line)
            need(management_bytes<=MANAGEMENT_BYTES,"F4 management/native aggregate byte budget")
            native_raw[active].extend(line)
        elif line.startswith(b"{"):
            need(False,"native output outside its owned window")
    need(active is None,"native output not ended")
    p1 = f0b.decode_serial(raw, run_id, expected_notes)
    dm_frames = [row for row in frames if row["event"].startswith("dm-")]
    frames, dm_proof, device = dm.decode_dm_frames(frames, run_id, p1)
    expected_legacy = f2.EVENTS[:8]+("device-remove",)+f2.EVENTS[8:17]+("metadata-start","metadata-exit")*3+("cleanup-fd","module-unload")
    need(tuple(row["event"] for row in legacy)==expected_legacy,"incomplete/unknown F2 owned lifecycle")
    by_name={row["event"]:row for row in legacy[:18]}
    policy=f2.policy(p1)
    need(p1_positions and p1_positions[0]<by_name["p1-start"]["position"]<p1_positions[1]
         and p1_positions[-1]<by_name["p1-exit"]["position"],"same-boot P1 before preparation")
    need(by_name["policy-gate"]["raw"]==policy.encode(),"same-boot policy gate")
    f2.config_bytes(by_name["config-check"]["raw"])
    p1_wait=f2._wait(by_name["p1-exit"]);format_wait=f2._wait(by_name["format-exit"],format_child=True)
    dm_proof["format_entry"] = dm.validate_format_fds(by_name["format-stdout"]["raw"], format_wait, run_id)
    need(p1_wait["pid"]==p1["ordinary_identity"]["pid"],"P1 owner PID")
    child_starts=[row for row in legacy if row["event"]=="metadata-start"]
    child_ends=[row for row in legacy if row["event"]=="metadata-exit"]
    need(all(child_starts[0]["position"]<pos<child_ends[0]["position"] for pos,_ in ordinary),"metadata outside actual owned child")
    metadata=dm.decode_metadata([row for _,row in ordinary],p1,run_id,device,dm_proof["sysname"])
    waits=[f2._wait(row) for row in child_ends]
    need(waits[0]["pid"]==metadata["identity"]["pid"] and len({p1_wait["pid"],format_wait["pid"],*(wait["pid"] for wait in waits)})==5,
         "distinct actual P1/format/metadata/control/read owners")
    need(by_name["module-load"]["raw"]==b"rd_nr=1 rd_size=65536 max_part=1"
         and by_name["device-create"]["raw"]==b"1:0","fixed single target creation")
    need(set(by_name["brd-family"]["raw"].split(b"\0")) == set(metadata["observations"]["sys_block"]["raw"].split(b"\0")) - {dm_proof["sysname"].encode()},
         "actual target inventory")
    need(f0b._json(by_name["device-geometry"]["raw"])=={"bytes":dm.DEVICE_BYTES,"logical_block_size":metadata["logical_block_size"]},
         "geometry vs native metadata")

    cursor=0
    def take(event,phase):
        nonlocal cursor
        need(cursor<len(frames) and (frames[cursor]["event"],frames[cursor]["phase"])==(event,phase),
             "missing/reordered F3 lifecycle "+phase+":"+event)
        row=frames[cursor];cursor+=1;return row
    need(frames and by_name["mount-private"]["position"] < frames[0]["position"],
         "F3 preparation precedes this boot's P1/F2 policy and target setup")
    prepare_begin = take("mount","prepare")
    need(prepare_begin["raw"]==b"/mnt/f3-prepare","fixed preparation mount")
    need(take("prepare-objects","prepare")["raw"]==PAYLOAD,"fixed prepared source content")
    prepare_end = take("unmount","prepare")
    need(prepare_end["raw"]==b"/mnt/f3-prepare","preparation writers/handles ended")
    phase_positions = {"geometry": by_name["device-geometry"]["position"], "device-remove": by_name["device-remove"]["position"],
        "format-start": by_name["format-start"]["position"], "mount-private": by_name["mount-private"]["position"],
        "prepare-begin": prepare_begin["position"], "prepare-end": prepare_end["position"],
        "cleanup-fd": legacy[-2]["position"], "module-unload": legacy[-1]["position"]}
    snapshots,views,mount_records,windows={}, {}, {}, {}
    for index,phase in enumerate(("control","read")):
        phase_positions[phase+"-begin"] = take("round-begin",phase)["position"]
        start=take("block-stat-before",phase);base=take("mount-base",phase)
        mounted=take("mount",phase)
        need(mounted["raw"]==b"/mnt/brd","whole-source mountpoint")
        mounted_stats=take("block-stat-mounted",phase)
        if phase=="control":
            need(cursor<len(frames) and mounted_stats["position"]<child_starts[0]["position"]<child_ends[0]["position"]<frames[cursor]["position"],
                 "same-boot metadata outside the control mount/baseline interval")
        for suffix in ("before","after"):
            key=phase+"-"+suffix
            if suffix=="after":
                native_begin=take("native-begin",phase);native_end=take("native-end",phase)
                need(native_begin["position"]<child_starts[index+1]["position"]<child_ends[index+1]["position"]<native_end["position"],
                     "native owner lifecycle envelope")
                need(f0b._json(native_end["raw"])["pid"]==waits[index+1]["pid"],"native receipt PID")
                selected=[]
                while cursor<len(frames) and frames[cursor]["event"].startswith("view-"):
                    row=frames[cursor];selected.append({k:row[k] for k in dm.FRAME_FIELDS});cursor+=1
                views[key]=dm.source_view(selected,run_id,key,device)
                need(take("unmount",phase)["raw"]==b"/mnt/brd","explicit post-Tcut harness unmount")
                end=take("block-stat-after",phase)
                mount_records[phase]={"before":start["raw"],"mounted":mounted_stats["raw"],"after":end["raw"],"base":base["raw"]}
            selected=[]
            while cursor<len(frames) and frames[cursor]["event"].startswith("snapshot-"):
                row=frames[cursor];selected.append({k:row[k] for k in dm.FRAME_FIELDS});cursor+=1
            snapshots[key]=dm.decode_snapshot(selected,run_id,key,device)
            if suffix == "after": phase_positions[phase+"-after-snapshot"] = frames[cursor-1]["position"]
            if suffix=="before":
                selected=[]
                while cursor<len(frames) and frames[cursor]["event"].startswith("view-"):
                    row=frames[cursor];selected.append({k:row[k] for k in dm.FRAME_FIELDS});cursor+=1
                views[key]=dm.source_view(selected,run_id,key,device)
        round_end=take("round-end",phase)
        phase_positions[phase+"-end"] = round_end["position"]
        if phase=="control":
            windows[phase]=dm.native_window(bytes(native_raw[phase]),phase,native_end,metadata,
                snapshots[phase+"-before"],snapshots[phase+"-after"],views[phase+"-before"],device)
        else:
            windows[phase]=native_window(bytes(native_raw[phase]),native_end,metadata,
                snapshots[phase+"-before"],snapshots[phase+"-after"],views[phase+"-before"],device,p1,dm_proof,run_id)
    need(round_end["position"] < legacy[-2]["position"],"target cleanup before source windows ended")
    final=take("guest-complete","cleanup")
    need(cursor==len(frames) and final["position"]>legacy[-1]["position"],"extra/incomplete cleanup")
    phase_positions["guest-complete"] = final["position"]
    dm.validate_phase_positions(dm_proof, phase_positions)
    cleanup=f0b._json(final["raw"]);closes=cleanup.pop("parent_closes",None)
    need(type(closes) is list and 1<=len(closes)<=128,"missing parent FD cleanup")
    for row in closes:
        f0._fields(row,("fd","errno"));need(type(row["fd"]) is int and row["fd"]>=3 and type(row["errno"]) is int and row["errno"]==0,"unconfirmed parent close")
    need(cleanup=={"original_errno":0,"cleanup_errno":0,"source_observations_complete":True,
        "module_loaded":False,"mounted":False,"node_exists":False,"children_reaped":True,
        "dm_created":False,"dm_node_exists":False,"dm_control_exists":False,"dm_close_unknown":False},"owned resources remain")
    after=snapshots["read-after"];_,journal_after=dm.journal(after)
    filesystem=f2._raw_filesystem(by_name | {
        "unmounted-superblock":{"raw":after.range(1024,1024)},
        "unmounted-group-descriptor":{"raw":after.range(dm.BLOCK_BYTES,64)},
        "unmounted-journal-inode":{"raw":dm.inode(after,8)},
        "unmounted-journal-header":{"raw":journal_after[:dm.BLOCK_BYTES]}},run_id)
    effects=dm.device_effects(snapshots,views,mount_records,run_id)
    artifacts=effects.pop("artifacts")
    for phase,output in native_raw.items():artifacts[phase+"-native.jsonl"]=bytes(output)
    for phase,data in (("p1",p1),("metadata",metadata)):
        for name,observation in data["observations"].items():
            artifacts[phase+"-"+name+".raw"]=observation.pop("raw")
    for row in legacy:
        artifacts["management-"+str(row["seq"])+"-"+row["event"]+".raw"]=row["raw"]
    for row in dm_frames:
        artifacts["dm-"+str(row["seq"])+"-"+row["phase"]+"-"+row["event"]+".raw"] = row["raw"]
    for _, row in dm_ordinary:
        artifacts["dm-child-"+str(row["pid"])+"-fds.json"] = encoded(row)
    need(sum(map(len,artifacts.values()))<=LIMITS["evidence_bytes"],"complete evidence output budget")
    dm.validate_ordinary_fds(dm_ordinary, child_starts, child_ends, waits, run_id)
    return {"state":STATE,"profile":PROFILE,"dm":dm_proof,"qualification":"UNSUPPORTED","content_probes":1,
        "production_bound":False,"commit_barrier":False,"accepted_provider_profiles":[],"qualified_kernel_builds":[],
        "policy":policy,"p1":p1,"metadata":metadata,"filesystem":filesystem,"windows":windows,**effects,
        "guest_cleanup":cleanup|{"parent_closes":closes},"raw_artifacts":artifacts,
        "unresolved":["production_source_db_plan_binding","complete_M04_writer_special_path_coverage",
                      "full_native_ext4_SP_qualification","R05_and_durable_restore","native_ext4_B1","production_Node_CFP2_invocation_binding",
                      "dirty_cancel_crash_directory_absent_profiles"]}

#!/usr/bin/env python3
"""#152 native-ext4一次有限资格；local-check不提权，hosted只接受专属分支。"""
from __future__ import annotations
import argparse
import array
import copy
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
sys.dont_write_bytecode=True
sys.path.insert(0,str(HERE))
import checks as C
from support import Evidence, Stop, alarm, canonical, containing, diff_entries, drop, encoded, identity, mountinfo, read_small, remove_owned_tree, sha, stat_fields, unprivileged, verify_marker, write_file
FILES=('.github/workflows/fs-native-ext4-qualification.yml', 'tests/fs-native-ext4-qualification.test.py')+tuple('scripts/qualification/fs-native-ext4/'+n for n in ('probe.c','run.py','checks.py','support.py','profile.json','README.md'))
CASES=C.CASES
PAYLOAD=b'boardroom #152 native-ext4 finite qualification\n'
CANARY='trusted.boardroom.ext4qual'
BRANCH='refs/heads/qualification/152-native-ext4-r3'
BUDGETS={'image_bytes':67108864,'payload_bytes':1048576,'objects_per_group':16,'compile_seconds':10,'native_child_seconds':3,'stage_seconds':60,'fixture_seconds':300,'job_minutes':10,'inode_attempts':32,'inode_seconds':2,'fs_cycles':1}

def need(ok,reason,status='BLOCKED'):
    if not ok:raise Stop(reason,status)

def selected(label=None):
    rows=tuple(r for r in CASES if label is None or r[0]==label)
    need(bool(rows),'未知case')
    return rows

def candidate(ev):
    p=subprocess.run(['git','-C',str(REPO),'rev-parse','HEAD','HEAD^{tree}'],capture_output=True,check=True,text=True)
    head,tree=p.stdout.splitlines()
    return {'commit':head,'tree':tree,'files':{n:sha(read_small(REPO/n)) for n in FILES}}

def environment():
    return {'uname':list(platform.uname()),'os_release':read_small(Path('/etc/os-release').resolve()).decode(),'process':identity(),
            'image':{k:os.environ.get(k) for k in ('ImageOS','ImageVersion','ImageRelease','RUNNER_OS','RUNNER_ARCH')},
            'recorded_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'requested_mount_options':list(C.OPTIONS),
            'tools':{n:shutil.which(n) for n in ('cc','python3','setpriv','sudo','unshare','mount','umount','mkfs.ext4','dumpe2fs','losetup')}}

def sumfiles(out):
    data=[]
    for p in sorted(out.rglob('*')):
        if p.is_file() and p!=out/'SHA256SUMS':data.append(sha(read_small(p))+'  '+p.relative_to(out).as_posix())
    write_file(out/'SHA256SUMS',('\n'.join(data)+'\n').encode())

def originals(path):
    files={};size=0
    for p in sorted(path.rglob('*')):
        need(not p.is_symlink(),'原件不得含symlink','INCONCLUSIVE')
        if p.is_file():
            data=read_small(p);size+=len(data);files[p.relative_to(path).as_posix()]=data
            need(len(files)<=512 and size<=16*1024*1024,'原件集合预算','INCONCLUSIVE')
    return files

def read_result_bundle(path,expected_candidate,binary_sha256,sealed=True):
    summary,status=C.validate_result_bundle(originals(path),expected_candidate,binary_sha256)
    C.require(not sealed or summary['limited_native_status']==status,'封存summary与严格计算不符','INCONCLUSIVE')
    return summary,status

def seal_fixture(ev,summary,expected_candidate,binary_sha256):
    ev.file('summary.json',summary);sumfiles(ev.path)
    try:
        _,status=read_result_bundle(ev.path,expected_candidate,binary_sha256,sealed=False)
    except (Stop,C.CheckError) as error:
        summary['bundle_error']={'status':error.status,'reason':str(error)}
        status='FAIL' if error.status=='FAIL' or summary['execution_status']=='FAIL' or any(v.get('status')=='FAIL' for v in summary['checks'].values()) else 'BLOCKED'
    summary['limited_native_status']=status;ev.file('summary.json',summary);sumfiles(ev.path)
    if 'bundle_error' not in summary:read_result_bundle(ev.path,expected_candidate,binary_sha256)

def profile(ev=None):
    raw=read_small(HERE/'profile.json');p=C.strict_json(raw)
    need(p['profile']==C.PROFILE and p['budgets']==BUDGETS and p['accepted_provider_profiles']==[] and p['qualified_kernel_builds']==[],'profile合同不符')
    need(tuple(p['source_files'])==FILES and tuple(p['mount_options'])==C.OPTIONS,'固定源码/挂载范围不符')
    if ev is not None:ev.file('profile.json',raw,raw=True)
    return p

def observer(point,ev,recursive=True):
    result={};total=0
    def scan(path,key):
        nonlocal total
        ev.remaining(1);need(len(result)<16,'每组对象预算','INCONCLUSIVE')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC|os.O_NOATIME)
        try:
            a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) or stat.S_ISDIR(a.st_mode),'observer对象类型','INCONCLUSIVE')
            need(a.st_dev==point.stat().st_dev,'observer同device','INCONCLUSIVE')
            v=stat_fields(a);attrs={}
            for name in sorted(os.listxattr(fd)):
                value=os.getxattr(fd,name);total+=len(value);need(len(value)<=65536,'xattr预算');attrs[name]=value.hex()
            v['xattrs']=attrs;flags=array.array('l',[0]);fcntl.ioctl(fd,0x80086601,flags,True);v['inode_flags']=flags[0]
            if stat.S_ISREG(a.st_mode):
                need(a.st_nlink==1,'observer单链接');h=hashlib.sha256()
                while True:
                    data=os.read(fd,65536)
                    if not data:break
                    total+=len(data);need(total<=1048576,'payload预算');h.update(data)
                v['sha256']=h.hexdigest()
            result[key]=v
            if recursive and stat.S_ISDIR(a.st_mode):
                for name in sorted(os.listdir(fd)):scan(path/name,key+'/'+name)
            need(not any(diff_entries({'x':stat_fields(a)},{'x':stat_fields(os.fstat(fd))}).values()),'observer自身改变source','FAIL')
        finally:os.close(fd)
    scan(point,'.')
    need(result['.']['xattrs'].get(CANARY)==b'observer-visible'.hex(),'完整trusted-xattr观察标记')
    return {'entries':result,'payload_bytes_observed':total,'objects':len(result)}

def snapshots(root,stage,ev):
    values={}
    for group in ('fs-root','control','provider'):
        point=root/'mount' if group=='fs-root' else root/'mount'/group
        a=observer(point,ev,recursive=group!='fs-root');b=observer(point,ev,recursive=group!='fs-root')
        delta=diff_entries(a['entries'],b['entries'])
        ev.file(f'snapshots/{stage}-{group}.json',{'first':a,'repeat':b,'observer_only':delta})
        need(not any(delta.values()),'observer-only读取有副作用','FAIL');values[group]=b
    need(sum(v['payload_bytes_observed'] for v in values.values())<=1048576,'两组累计payload预算')
    return values

def probe_argv(root,uid,gid,cases=CASES,mode='provider',group='provider'):
    point=root/'mount'/group if group else root/'mount'
    return [str(root/'native-probe'),mode,str(uid),str(gid),str(point),*[v for row in cases for v in row]]

def probe(ev,args,label,proof,cases=CASES,mode='provider',group='provider',valid=True):
    before=mountinfo();rc,out,err=ev.call(label,drop(args.uid,args.gid,probe_argv(Path(args.root),args.uid,args.gid,cases,mode,group)),3)
    batch={'returncode':rc,'reaped':True,'records':[json.loads(l) for l in out.splitlines() if l],'mountinfo_before':before,'mountinfo_after':mountinfo(),'mode':mode}
    ev.file(f'native/{label}.json',batch)
    if valid:return C.validate_batch(batch,cases,args.uid,args.gid,proof,lookup=mode=='lookup'),batch
    return {},batch

def child_binding(args):
    root=canonical(Path(args.root));m=json.loads(read_small(root/'.fixture-public.json'))
    need(root.stat().st_uid==0 and root.stat().st_mode&0o022==0,'fixture enclosure owner')
    need((m['root'],m['token'],m['uid'],m['gid'])==(str(root),args.token,args.uid,args.gid),'fixture marker binding')
    need((root/'.fixture-public.json').stat().st_uid==0,'root-owned marker')
    ident=unprivileged(args.uid,args.gid)
    need(containing(root/'mount')['point']==str(root/'mount') and containing(root/'mount')['type']=='ext4','child native ext4 mount')
    return root,ident

def fixture_fds(point):
    result=[]
    for p in Path('/proc/self/fd').iterdir():
        try:target=os.readlink(p)
        except FileNotFoundError:continue
        if target==str(point) or target.startswith(str(point)+'/'):result.append({'fd':int(p.name),'target':target})
    return result

def source_bytes(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NOATIME)
    try:
        data=os.read(fd,1048577);need(len(data)<=1048576,'source payload预算');return data
    finally:os.close(fd)

def child(args):
    root,ident=child_binding(args);point=root/'mount/provider';result={'operation':args.operation,'pid':os.getpid(),'identity':ident}
    if args.operation in ('replace','mutate'):
        row=selected(args.case)[0];target=point/row[1];directory=row[2]=='directory';a=target.stat(follow_symlinks=False)
        need(a.st_uid==args.uid and a.st_gid==args.gid,'mutator owner')
        data=None if directory else source_bytes(target);members=sorted(os.listdir(target)) if directory else []
        result['before']=stat_fields(a)
        if args.operation=='replace':
            need(not members,'有界重建只对既有empty-dir/ancestor执行')
            # 此进程没有打开旧对象FD；先前native进程已由parent wait/reap，回执由parent绑定。
            result['before_delete_source_fds']=fixture_fds(point);need(not result['before_delete_source_fds'],'重建前仍持source FD','FAIL')
            os.rmdir(target) if directory else os.unlink(target)
            try:os.lstat(target)
            except FileNotFoundError as e:result['absence_errno']=e.errno
            else:raise Stop('删除后没有ENOENT','FAIL')
            if directory:target.mkdir(mode=stat.S_IMODE(a.st_mode))
            else:
                fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,stat.S_IMODE(a.st_mode))
                try:
                    with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush();os.fsync(fd)
                finally:os.close(fd)
            os.chmod(target,stat.S_IMODE(a.st_mode));result.update(same_mode=stat.S_IMODE(target.stat().st_mode)==stat.S_IMODE(a.st_mode),same_final_members=(sorted(os.listdir(target))==members if directory else True),same_content=True if directory else source_bytes(target)==data,old_object_fds_open=len(result['before_delete_source_fds']))
        else:
            if not directory:
                fd=os.open(target,os.O_WRONLY|os.O_NOFOLLOW)
                try:
                    os.ftruncate(fd,0);os.write(fd,data+b'mutated');os.ftruncate(fd,len(data));os.fsync(fd)
                finally:os.close(fd)
                result['write_truncate_restore']=source_bytes(target)==data
            os.chmod(target,0o500 if directory else 0o400);os.chmod(target,stat.S_IMODE(a.st_mode));result['chmod_restore']=True
            moved=target.with_name('moved-'+target.name);need(not moved.exists(),'rename临时名冲突');os.rename(target,moved);os.rename(moved,target);result['rename_out_back']=True
            if directory:
                p=target/'temporary-member';fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd);p.unlink();result['temporary_member_removed']=True
        fd=os.open(point,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NOATIME)
        try:os.fsync(fd)
        finally:os.close(fd)
        result['after']=stat_fields(target.stat())
    elif args.operation=='absent':
        ancestor=point/'ancestor';missing=[]
        for p in (ancestor/'missing',ancestor/'missing/deeper'):
            try:os.lstat(p)
            except FileNotFoundError as e:missing.append({'suffix':str(p.relative_to(ancestor)),'errno':e.errno})
            else:raise Stop('absent suffix存在','FAIL')
        result.update(ancestor=stat_fields(ancestor.stat()),missing=missing,absent_incarnation=None)
    elif args.operation=='consume':
        data=read_small(root/'evidence/persisted-observations.json');sidecar=read_small(root/'evidence/persisted-observations.sha256')
        # 在新进程中先完整消费磁盘冻结记录；父进程不提供内存expected对象。
        C.decode_frozen(data,sidecar,str(point),CASES,args.uid,args.gid)
        current_proof=C.strict_json(read_small(root/'evidence/current-mount-proof.json'))
        before=mountinfo();p=subprocess.Popen(probe_argv(root,args.uid,args.gid),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:out,err=p.communicate(timeout=2)
        finally:
            if p.poll() is None:p.kill();p.communicate()
        batch={'returncode':p.returncode,'reaped':p.poll() is not None,'records':[C.strict_json(l) for l in out.splitlines() if l],'mountinfo_before':before,'mountinfo_after':mountinfo(),'mode':'provider'}
        receipt=C.consume_frozen(data,sidecar,batch,current_proof,str(point),CASES,args.uid,args.gid,os.getpid())
        result.update(receipt=receipt,batch=batch,native_reaped=p.poll() is not None,raw_stderr=err.decode())
    elif args.operation in ('path-race','cancel-native'):
        cases=selected('file-root');p=subprocess.Popen(probe_argv(root,args.uid,args.gid,cases,'path-race'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
        raw=bytearray();deadline=time.monotonic()+1.5;replaced=False;target=point/'file-root';moved=point/'race-old-file';returncode=None
        try:
            while b'"race-window"' not in raw:
                need(time.monotonic()<deadline,'race barrier未观察','INCONCLUSIVE')
                readable,_,_=select.select([p.stdout],[],[],max(0,deadline-time.monotonic()))
                need(bool(readable),'race barrier超时','INCONCLUSIVE');part=os.read(p.stdout.fileno(),4096);need(bool(part),'native在barrier前退出');raw.extend(part)
            if args.operation=='path-race':
                data=source_bytes(target);os.rename(target,moved);replaced=True
                fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                try:os.write(fd,data);os.fsync(fd)
                finally:os.close(fd)
            else:p.terminate()
            p.send_signal(signal.SIGCONT);out,err=p.communicate(timeout=max(.01,deadline-time.monotonic()));raw.extend(out);returncode=p.returncode
            result.update(native_returncode=returncode,native_reaped=p.poll() is not None,records=[json.loads(l) for l in raw.splitlines()],raw_stderr=err.decode(),real_barrier_observed=True,real_path_replacement=replaced)
        finally:
            if p.poll() is None:p.kill();p.communicate()
            if replaced:
                target.unlink();os.rename(moved,target)
    else:raise Stop('未知child动作')
    print(json.dumps(result,ensure_ascii=False));return 0

def action(ev,args,label,operation,case=None,seconds=3):
    argv=[sys.executable,'-I',str(HERE/'run.py'),'--mode','child','--root',args.root,'--uid',str(args.uid),'--gid',str(args.gid),'--token',args.token,'--operation',operation]
    if case:argv+=['--case',case]
    rc,out,err=ev.call(label,drop(args.uid,args.gid,argv),seconds)
    if rc!=0:
        try:failure=C.strict_json(err)
        except C.CheckError:failure={}
        status=failure.get('status','INCONCLUSIVE') if isinstance(failure,dict) else 'INCONCLUSIVE'
        need(False,'child动作未完成:'+label+':'+str(failure),status if status in ('FAIL','BLOCKED','INCONCLUSIVE') else 'INCONCLUSIVE')
    value=json.loads(out);value['all_old_native_children_reaped']=not ev.children
    ev.file('actions/'+label+'.json',value);return value

def command(ev,label,argv,seconds=3,cleanup=False):
    rc,out,err=ev.call(label,argv,seconds,cleanup=cleanup);need(rc==0,'命令未完成:'+label,'NOT_RUN_ENVIRONMENT' if label in ('loop-attach','mount-native') else 'BLOCKED');return out.decode().strip()

def loop_owned(ev,root,loop,cleanup=False):
    text=command(ev,'loop-binding-'+uuid.uuid4().hex[:6],['losetup','--json','--list',loop],cleanup=cleanup)
    rows=json.loads(text)['loopdevices'];need(len(rows)==1 and Path(rows[0]['back-file'])==root/'image.ext4','loop当前backing归属不符','INCONCLUSIVE')

def attach(ev,root,label='loop-attach'):
    out=command(ev,label,['losetup','--find','--show',str(root/'image.ext4')]);need(re.fullmatch('/dev/loop[0-9]+',out) is not None,'loop返回值无效');loop_owned(ev,root,out);return out

def mount_native(ev,root,loop,label='mount-native'):
    command(ev,label,['mount','-t','ext4','-o',','.join(C.OPTIONS),loop,str(root/'mount')])
    entries=[e for e in mountinfo() if e['point']==str(root/'mount')];need(len(entries)==1 and entries[0]['type']=='ext4' and entries[0]['root']=='/','实际mount未确认为native ext4')
    proof={'mountpoint':str(root/'mount'),'loop':loop,'requested_options':list(C.OPTIONS),'mount_returncode':0,'entry':entries[0],'scope':'owned_qualification_fixture','production_runtime_match':'NOT_IMPLEMENTED_UNSUPPORTED'}
    ev.file('mount/'+label+'.json',proof);ev.file('current-mount-proof.json',proof);return proof

def prepare_objects(root,uid,gid):
    point=root/'mount';os.chown(point,uid,gid);os.chmod(point,0o700)
    os.setxattr(point,CANARY,b'observer-visible')
    for group in ('control','provider'):
        g=point/group;g.mkdir(mode=0o700);os.chown(g,uid,gid)
        for name in ('directory-root','directory-root/child-dir','nonempty','empty-dir','ancestor'):
            p=g/name;p.mkdir(mode=0o700);os.chown(p,uid,gid)
        for name in ('file-root','directory-root/child-file','nonempty/item'):
            p=g/name;write_file(p,PAYLOAD,0o600);os.chown(p,uid,gid)
        os.setxattr(g,CANARY,b'observer-visible')
    fd=os.open(point,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME)
    try:os.fsync(fd)
    finally:os.close(fd)

def fault_controls(native):
    return C.fault_controls(native)

def fixture(args):
    root=canonical(Path(args.root));marker=verify_marker(root,args.token)
    need(os.getuid()==0 and os.readlink('/proc/self/ns/mnt')!=args.outer_namespace,'仅已授权独立mount namespace fixture')
    need(marker['uid']==args.uid and marker['gid']==args.gid and args.uid>0 and args.gid>0,'原runner身份')
    os.chown(root,0,0);os.chmod(root,0o711)
    public={'root':str(root),'token':args.token,'uid':args.uid,'gid':args.gid};write_file(root/'.fixture-public.json',encoded(public));os.chown(root/'.fixture-public.json',0,0)
    ev=Evidence(root/'evidence');summary=C.base_summary();summary['candidate']=marker['candidate'];loop=None;mounted=False;cross=False;cleanup={'status':'NOT_RUN','children':[]};proof=None
    binary_sha256=sha(read_small(root/'native-probe'))
    def q(number,fn):
        key=f'EX4-Q{number:02}'
        old_paths={p.relative_to(ev.path).as_posix() for p in ev.path.rglob('*') if p.is_file()}
        try:
            with ev.phase(key):detail=fn()
            added={p.relative_to(ev.path).as_posix() for p in ev.path.rglob('*') if p.is_file()}-old_paths
            summary['checks'][key]={'status':'PASS','detail':detail,'evidence':sorted(added|C.Q_REQUIRED[key])}
        except (Stop,ValueError,OSError) as e:
            status=e.status if isinstance(e,(Stop,C.CheckError)) else 'FAIL' if isinstance(e,ValueError) else 'BLOCKED'
            summary['checks'][key]={'status':status,'reason':str(e)}
            if number<=3 or status=='FAIL':raise Stop(str(e),status)
    def cancel(signum,_frame):
        for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,signal.SIG_IGN)
        ev.cancelled=True;raise Stop('fixture取消:'+str(signum),'INCONCLUSIVE')
    for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,cancel)
    try:
        ev.file('candidate.json',marker['candidate']);profile(ev);ev.file('environment.json',environment());ev.file('binary.json',{'sha256':binary_sha256})
        with ev.phase('prepare'):
            image=root/'image.ext4';fd=os.open(image,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            try:os.ftruncate(fd,67108864);os.fsync(fd)
            finally:os.close(fd)
            uuid_text=str(uuid.uuid4());ev.file('fixture-image.json',{'uuid_requested':uuid_text,'bytes':67108864,'identity':stat_fields(image.stat()),'scope':'new private fixture, no source clone'})
            command(ev,'mkfs-version',['mkfs.ext4','-V']);command(ev,'mount-version',['mount','--version']);command(ev,'loop-version',['losetup','--version'])
            command(ev,'mkfs',['mkfs.ext4','-F','-U',uuid_text,'-E','lazy_itable_init=0,lazy_journal_init=0',str(image)],30)
            loop=attach(ev,root);features=command(ev,'ext4-superblock',['dumpe2fs','-h',loop]);ev.file('features.json',{'raw':features,'requested_mkfs':['-F','-U',uuid_text,'-E','lazy_itable_init=0,lazy_journal_init=0'],'production_inference':False})
            (root/'mount').mkdir();proof=mount_native(ev,root,loop);mounted=True;prepare_objects(root,args.uid,args.gid)
        state={}
        def q01():
            # 实际FS root和所有组在Q01首次provider open之前取得冷基线及observer-only复读。
            state['cold_before']=snapshots(root,'cold-before',ev)
            current,batch=probe(ev,args,'identity-native',proof,cases=(('fs-root','.','directory'),),group='')
            state['fs-root']=current;return {'native_identity':batch['records'][0],'environment_ref':'environment.json','features_ref':'features.json','mount_ref':'mount/mount-native.json','qualified_kernel_builds':[]}
        q(1,q01)
        def q03():
            probe(ev,args,'cold-control',proof,mode='lookup',group='control')
            middle=snapshots(root,'cold-control-after',ev)
            current,batch=probe(ev,args,'cold-provider',proof);state['current']=current;state['batch']=batch
            after=snapshots(root,'cold-provider-after',ev);results=C.cold_compare(state['cold_before'],middle,after)
            ev.file('cold-comparison.json',results);return {'comparison':'cold-comparison.json','provider_primed':False}
        q(3,q03)
        def q02():
            anchor=state['fs-root']['fs-root']['native'];entry=state['current']['group-anchor']['native'];need(anchor['fsuuid']['hex']==entry['fsuuid']['hex'] and anchor['statx_unique']['mount_id']==entry['statx_unique']['mount_id'],'实际FS root与entries绑定不符','FAIL')
            absent=action(ev,args,'initial-absent','absent');return {'case_count':len(CASES)+1,'same_fd_bytes':True,'native':'native/cold-provider.json','fs_root':'native/identity-native.json','absent':absent}
        q(2,q02)
        def q04():
            result={}
            for label in ('file-root','directory-root','empty-dir'):
                before,_=probe(ev,args,'mutation-before-'+label,proof,cases=selected(label));act=action(ev,args,'mutation-'+label,'mutate',label);after,_=probe(ev,args,'mutation-after-'+label,proof,cases=selected(label))
                need(before[label]['witness']==after[label]['witness'],'普通修改改变FID','FAIL');observed=C.compare(before,after)
                need(observed==('source_changed' if before[label]['kind']=='file' else 'equal'),'file冻结/目录正例不符','FAIL');result[label]={'action':act,'comparison':observed}
            return result
        q(4,q04);recreations={};reused={}
        def recreate(label,suffix):
            before,_=probe(ev,args,'replace-before-'+suffix,proof,cases=selected(label));need(not ev.children,'旧native进程仍活')
            receipt=action(ev,args,'replace-'+suffix,'replace',label);after,_=probe(ev,args,'replace-after-'+suffix,proof,cases=selected(label))
            used=C.replacement(before,after,receipt,label);data={'before':before,'after':after,'receipt':receipt,'inode_reused':used,'native_before_ref':'native/replace-before-'+suffix+'.json','native_after_ref':'native/replace-after-'+suffix+'.json'}
            ev.file('recreation/'+suffix+'.json',data);return data
        def q05():
            for label in ('file-root','empty-dir'):
                recreations[label]=recreate(label,label)
                if recreations[label]['inode_reused']:reused[label]=recreations[label]
            return {'receipts':['recreation/file-root.json','recreation/empty-dir.json'],'no_old_native_processes':not ev.children}
        q(5,q05)
        def q06():
            start=time.monotonic();attempts=0;old=ev.stage_deadline;ev.stage_deadline=min(old,start+2)
            try:
                for label in ('file-root','empty-dir'):
                    while label not in reused and attempts<32:
                        ev.remaining(1);attempts+=1;value=recreate(label,'reuse-'+str(attempts))
                        if value['inode_reused']:reused[label]=value
                need(set(reused)=={'file-root','empty-dir'} and time.monotonic()-start<=2,'32次/2秒内未观察到file+dir复用')
            except Stop as error:
                if not ev.cancelled and time.monotonic()-start>=2:raise Stop('2秒复用预算结束；未观察到的类别保持BLOCKED') from error
                raise
            finally:
                ev.stage_deadline=old;ev.file('inode-reuse-budget.json',{'additional_attempts':attempts,'elapsed_seconds':time.monotonic()-start,'reused':list(reused),'limits':{'attempts':32,'seconds':2}})
            ev.file('inode-reuse.json',reused);return {'additional_attempts':attempts,'receipt':'inode-reuse.json'}
        q(6,q06)
        def q07():
            need(set(reused)=={'file-root','empty-dir'},'Q06实际file/dir复用收据缺失')
            values={label:C.equal_stat_control(v['before'],v['after'],v['receipt'],label) for label,v in reused.items()}
            ev.file('synthetic-equal-stat-time.json',{'native_sources':'inode-reuse.json','cases':values});return {'origin':'synthetic from actual native receipts','production_Fs_service':'NOT_RUN','evidence':'synthetic-equal-stat-time.json'}
        q(7,q07)
        def persist():
            current,batch=probe(ev,args,'persist-source',proof)
            value={'schema_version':C.FROZEN_SCHEMA,'root':str(root/'mount/provider'),'uid':args.uid,'gid':args.gid,'cases':[list(v) for v in CASES],
                   'all_native_children_reaped':not ev.children,'mount_proof':proof,'observations':current,'batch':batch}
            data=encoded(value);ev.file('persisted-observations.json',data,raw=True);ev.file('persisted-observations.sha256',(sha(data)+'\n').encode(),raw=True);return sha(data)
        persisted_sha256=persist()
        def consume(label):
            result=action(ev,args,label,'consume');C.validate_batch(result['batch'],CASES,args.uid,args.gid,proof);receipt=result['receipt']
            need(receipt['schema_version']=='fs-native-ext4-consume-receipt/v1' and receipt['persisted_sha256']==persisted_sha256 and receipt['consumer_pid']==result['pid'] and receipt['consumer_pid']!=os.getpid() and receipt['current_native_pid']==result['batch']['records'][0]['pid'] and receipt['current_batch_sha256']==C.encoded_hash(result['batch']) and receipt['decoded_objects']==sorted(r[0] for r in CASES) and receipt['expected_source']=='strict_disk_observations' and receipt['comparison']=='equal','新进程磁盘消费回执绑定不符','FAIL')
            need(result['native_reaped'] is True,'consumer native未reap');return receipt
        q(8,lambda:consume('new-process-consume'))
        def q09():
            nonlocal loop,mounted,proof
            need(not ev.children,'生命周期前仍有child');image=root/'image.ext4';info=image.stat();receipt={'all_native_children_reaped':True,'open_fixture_fds':0,'mountpoint_before':str(root/'mount'),'mountpoint_after':str(root/'mount'),'image_inode_before':[info.st_dev,info.st_ino],'cycles':1,'os_reboot':'NOT_RUN'}
            receipt['source_fds_before_unmount']=fixture_fds(root/'mount');receipt['open_fixture_fds']=len(receipt['source_fds_before_unmount']);need(receipt['open_fixture_fds']==0,'FS生命周期前仍有source FD')
            loop_owned(ev,root,loop);command(ev,'lifecycle-unmount',['umount',str(root/'mount')]);mounted=False;receipt['unmount_rc']=0
            need(not any(e['point']==str(root/'mount') for e in mountinfo()),'umount后仍有mount')
            command(ev,'lifecycle-loop-detach',['losetup','-d',loop]);loop=None;receipt['detached_rc']=0
            need(not command(ev,'lifecycle-detach-proof',['losetup','-j',str(image)]),'image仍关联loop')
            def image_hash():
                h=hashlib.sha256();fd=os.open(image,os.O_RDONLY|os.O_NOFOLLOW|os.O_NOATIME)
                try:
                    while True:
                        b=os.read(fd,65536)
                        if not b:break
                        h.update(b)
                finally:os.close(fd)
                return h.hexdigest()
            receipt['image_sha256_after_detach']=image_hash();receipt['image_sha256_before_reattach']=image_hash();info=image.stat();receipt['image_inode_after']=[info.st_dev,info.st_ino]
            loop=attach(ev,root,'lifecycle-reattach');receipt['reattach_rc']=0;proof=mount_native(ev,root,loop,'lifecycle-mount');mounted=True;receipt['mount_rc']=0
            C.lifecycle(receipt);receipt['fresh_consume']=consume('post-lifecycle-consume');ev.file('fs-lifecycle.json',receipt);return receipt
        q(9,q09)
        def q10():
            nonlocal cross
            point=root/'mount/provider';results={}
            targets=[('symlink','file-root','symlink'),('hardlink','file-root','hardlink'),('fifo',None,'fifo'),('foreign-owner',None,'foreign')]
            for label,source,kind in targets:
                p=point/label
                if kind=='symlink':os.symlink(source,p)
                elif kind=='hardlink':os.link(point/source,p)
                elif kind=='fifo':os.mkfifo(p,0o600);os.chown(p,args.uid,args.gid)
                else:write_file(p,PAYLOAD,0o600)
                try:
                    _,batch=probe(ev,args,'reject-'+label,proof,cases=((label,label,'file'),),valid=False)
                    need(batch['returncode'] in (69,70) and any(r['kind'] in ('open-error','object-guard-error') for r in batch['records']),'负例未明确拒绝:'+label,'FAIL');results[label]={'returncode':batch['returncode'],'native':'native/reject-'+label+'.json'}
                finally:p.unlink()
            # 同FS bind mount也必须因挂载边界拒绝，不能只比较dev。
            for n in ('cross-source','cross-target'):(point/n).mkdir(mode=0o700);os.chown(point/n,args.uid,args.gid)
            command(ev,'cross-bind',['mount','--bind',str(point/'cross-source'),str(point/'cross-target')]);cross=True
            try:
                _,batch=probe(ev,args,'reject-cross-mount',proof,cases=(('cross','cross-target','directory'),),valid=False)
                need(batch['returncode']==69 and any(r.get('errno')==errno.EXDEV for r in batch['records']),'跨mount未以EXDEV拒绝','FAIL');results['cross_mount']='real bind/EXDEV'
            finally:command(ev,'cross-unmount',['umount',str(point/'cross-target')]);cross=False;(point/'cross-target').rmdir();(point/'cross-source').rmdir()
            race=action(ev,args,'path-race','path-race');need(race['real_path_replacement'] is True and race['native_returncode']==70 and any(r['kind']=='path-guard' and not r['same_object'] for r in race['records']),'真实held-FD路径替换未拒绝','FAIL');results['path_race']='actions/path-race.json'
            _,batch=probe(ev,args,'reject-fd-reuse',proof,cases=selected('file-root'),mode='fd-reuse',valid=False);results['fd_reuse']=C.validate_fd_reuse(batch,'file-root')
            before,_=probe(ev,args,'ancestor-before',proof,cases=selected('ancestor'));action(ev,args,'ancestor-replace','replace','ancestor');after,_=probe(ev,args,'ancestor-after',proof,cases=selected('ancestor'));need(C.compare(before,after)=='source_changed','ancestor替换未拒绝','FAIL');results['absent']=action(ev,args,'ancestor-absent','absent')
            return results
        q(10,q10)
        def q11():
            current,_=probe(ev,args,'fault-control-source',proof,cases=selected('file-root'));injected=fault_controls(current['file-root']['native']);ev.file('fault-injections.json',injected)
            cancel_result=action(ev,args,'cancel-native','cancel-native');need(cancel_result['native_reaped'] is True and cancel_result['native_returncode']==-signal.SIGTERM,'实际native取消/reap未成立','FAIL')
            try:ev.call('synthetic-timeout-child',drop(args.uid,args.gid,[sys.executable,'-I','-c','import time; time.sleep(1)']),.02)
            except Stop:need(not ev.children,'超时child未回收','FAIL')
            else:raise Stop('timeout控制意外成功','FAIL')
            ev.flush_pending_receipts();return {'synthetic_errno_field_cases':len(injected),'native_resize_retries':0,'actual_cancel':'actions/cancel-native.json','timeout':'synthetic-timeout-child, reaped; no source access','successful_Fs':False}
        q(11,q11);summary['execution_status']='COMPLETE'
    except (Stop,C.CheckError) as e:summary['execution_status']=e.status;summary['stop_reason']=str(e)
    except OSError as e:summary['execution_status']='BLOCKED';summary['stop_reason']='实际fixture环境错误:'+str(e)
    except Exception as e:summary['execution_status']='FAIL';summary['harness_error']={'type':type(e).__name__,'message':str(e)}
    finally:
        try:
            # 只清理本次身份已确认的资源；没有lazy/force umount或强删未知root。
            with alarm(max(.01,ev.deadline-time.monotonic()),'fixture清理预算耗尽'):
                verify_marker(root,args.token);need(not ev.children,'仍有child，保留','INCONCLUSIVE')
                if cross:command(ev,'cleanup-cross',['umount',str(root/'mount/provider/cross-target')],cleanup=True)
                if any(e['point']==str(root/'mount') for e in mountinfo()):command(ev,'cleanup-unmount',['umount',str(root/'mount')],cleanup=True)
                need(not any(root==Path(e['point']) or root in Path(e['point']).parents for e in mountinfo()),'仍有未知mount，保留','INCONCLUSIVE')
                if loop:
                    loop_owned(ev,root,loop,cleanup=True);command(ev,'cleanup-loop-detach',['losetup','-d',loop],cleanup=True);loop=None
                if (root/'image.ext4').exists():need(not command(ev,'cleanup-loop-proof',['losetup','-j',str(root/'image.ext4')],cleanup=True),'image仍有loop，保留','INCONCLUSIVE');(root/'image.ext4').unlink()
                if (root/'mount').exists():(root/'mount').rmdir()
                ev.flush_pending_receipts();cleanup.update(status='PASS',mounts_released=True,loop_detached=True,children_reaped=True)
        except Exception as e:cleanup.update(status='INCONCLUSIVE',reason=str(e),retained_root=str(root))
        summary['checks']['EX4-Q12']={'status':cleanup['status'],'detail':cleanup,'evidence':['cleanup.json']}
        ev.file('cleanup.json',cleanup);seal_fixture(ev,summary,marker['candidate'],binary_sha256)
        # 只有已正常释放时交回原UID；root marker及其inode仍可复核。
        if cleanup['status']=='PASS':
            for directory,dirs,files in os.walk(root,followlinks=False):
                for name in dirs+files:
                    p=Path(directory)/name;need(not p.is_symlink(),'收尾未知symlink','INCONCLUSIVE');os.chown(p,args.uid,args.gid,follow_symlinks=False)
            os.chown(root,args.uid,args.gid);os.chmod(root,0o700)
    return 1 if summary['limited_native_status']=='FAIL' else 0

def local(args):
    out=canonical(Path(args.out),absent_leaf=True);ev=Evidence(out);summary=C.base_summary();env=environment();ev.file('environment.json',env);ev.file('candidate.json',candidate(ev));profile(ev)
    cleanup={'status':'PASS','mount_attempted':False,'privilege_escalation_attempted':False,'retained_evidence_binary':True,'children_reaped':True}
    try:
        command(ev,'compiler-version',[env['tools']['cc'],'--version'])
        command(ev,'compile',[env['tools']['cc'],'-std=gnu11','-Wall','-Wextra','-Werror','-O2',str(HERE/'probe.c'),'-o',str(out/'native-probe')],10)
        ev.file('binary.json',{'sha256':sha(read_small(out/'native-probe')),'architecture':platform.machine(),'runtime_qualification':False})
        command(ev,'local-controls',[sys.executable,str(REPO/'tests/fs-native-ext4-qualification.test.py')],3)
        summary['execution_status']='NOT_RUN_ENVIRONMENT';summary['stop_reason']='本地只执行无提权编译/控制；真实loop/mount及五cap清空的provider须已授权专属hosted入口'
        summary['checks']={k:{'status':'NOT_RUN_ENVIRONMENT'} for k in C.CHECKS};summary['local_controls']='PASS'
    except Exception as e:summary.update(execution_status='FAIL',local_controls='FAIL',harness_error=str(e))
    finally:
        ev.flush_pending_receipts();ev.file('cleanup.json',cleanup);ev.file('summary.json',summary);sumfiles(out)
    print(json.dumps({'execution_status':summary['execution_status'],'limited_native_status':'BLOCKED','profile_accepted':False},ensure_ascii=False));return 1 if summary['execution_status']=='FAIL' else 0

def hosted(args):
    uid,gid=os.getuid(),os.getgid();env=os.environ
    need(uid>0 and gid>0 and platform.system()=='Linux' and platform.machine()=='x86_64','原非零x86_64 Linux runner')
    need(env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_REPOSITORY')=='gbcdby/boardroom' and env.get('GITHUB_REF')==BRANCH and env.get('GITHUB_EVENT_NAME')=='push','仅新专属分支已授权hosted push；不提供本地提权入口')
    run,attempt,commit=(env.get(k,'') for k in ('GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA'))
    need(re.fullmatch('[0-9]+',run) and re.fullmatch('[0-9]+',attempt) and re.fullmatch('[a-f0-9]{40}',commit),'真实run身份')
    temp=canonical(Path(env['RUNNER_TEMP']));workspace=canonical(Path(env['GITHUB_WORKSPACE']));root=canonical(Path(args.root),absent_leaf=True)
    need(workspace==REPO and root==temp/f'boardroom-ext4qual-{run}-{attempt}' and not root.exists(),'私有新root范围')
    need(not re.search(r'[\s,:\\]',str(root)),'root字符串不安全')
    need(Path(args.out)==workspace/'.agent-output/fs-native-ext4-qualification','固定artifact路径')
    Path(args.out).parent.mkdir(mode=0o700,exist_ok=True);out=canonical(Path(args.out),absent_leaf=True);ev=Evidence(out);ev.deadline=time.monotonic()+360;ev.action_deadline=ev.stage_deadline=time.monotonic()+330
    summary=C.base_summary();cleanup={'status':'PASS','root_created':False,'root_removed':False,'namespace_started':False};token=uuid.uuid4().hex;created=False;validated_fixture_status='BLOCKED';cand=None;binary_sha256=None
    def cancelled(sig,_frame):
        for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,signal.SIG_IGN)
        ev.cancelled=True;raise Stop('hosted取消:'+str(sig),'INCONCLUSIVE')
    for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,cancelled)
    try:
        profile(ev);envdata=environment();ev.file('environment.json',envdata);cand=candidate(ev);ev.file('candidate.json',cand);need(cand['commit']==commit,'实际checkout与GITHUB_SHA不符','FAIL')
        p=subprocess.run(['git','-C',str(REPO),'status','--porcelain=v1'],capture_output=True,check=True);need(not p.stdout.strip(),'固定候选dirty','FAIL')
        need(all(envdata['tools'].values()),'工具缺失，不安装/改系统头')
        root.mkdir(mode=0o700);created=True;cleanup['root_created']=True;st=root.stat();namespace=os.readlink('/proc/self/ns/mnt')
        write_file(root/'.fsqual-marker.json',encoded({'root':str(root),'root_identity':[st.st_dev,st.st_ino],'token':token,'uid':uid,'gid':gid,'candidate':cand,'outer_namespace':namespace}))
        command(ev,'compiler-version',[envdata['tools']['cc'],'--version']);command(ev,'compile',[envdata['tools']['cc'],'-std=gnu11','-Wall','-Wextra','-Werror','-O2',str(HERE/'probe.c'),'-o',str(root/'native-probe')],10)
        binary_sha256=sha(read_small(root/'native-probe'));ev.file('binary.json',{'sha256':binary_sha256});cleanup['namespace_started']=True
        argv=['sudo','-n','unshare','--mount','--propagation','private','--fork','--kill-child=TERM','--',sys.executable,'-I',str(HERE/'run.py'),'--mode','fixture','--root',str(root),'--uid',str(uid),'--gid',str(gid),'--token',token,'--outer-namespace',namespace]
        rc,_,_=ev.call('namespace',argv,300)
        need((root/'evidence/summary.json').is_file(),'namespace未生成资格回执','NOT_RUN_ENVIRONMENT')
        summary,validated_fixture_status=read_result_bundle(root/'evidence',cand,binary_sha256);cleanup['fixture']=C.strict_json(read_small(root/'evidence/cleanup.json'))
        need(rc==0 or summary['limited_native_status']=='FAIL','非预期fixture退出','INCONCLUSIVE')
    except (Stop,C.CheckError) as e:summary.update(execution_status=e.status,stop_reason=str(e))
    except Exception as e:summary.update(execution_status='FAIL',harness_error=str(e))
    finally:
        try:
            ev.flush_pending_receipts()
            if created:
                verify_marker(root,token)
                if (root/'evidence').is_dir():
                    count=0;size=0
                    for p in sorted((root/'evidence').rglob('*')):
                        need(not p.is_symlink(),'未知证据symlink','INCONCLUSIVE')
                        if p.is_file():
                            data=read_small(p);size+=len(data);count+=1;need(count<=512 and size<=16*1024*1024,'证据预算','INCONCLUSIVE');ev.file('fixture/'+p.relative_to(root/'evidence').as_posix(),data,raw=True)
                    if (root/'evidence/cleanup.json').is_file():cleanup['fixture']=C.strict_json(read_small(root/'evidence/cleanup.json'))
                    # 再消费实际复制到artifact的完整封包，避免导入与交付对象脱节。
                    _,validated_fixture_status=read_result_bundle(ev.path/'fixture',cand,binary_sha256)
                need(not ev.children and (not cleanup['namespace_started'] or cleanup.get('fixture',{}).get('status')=='PASS'),'资源归属/释放不明，保留','INCONCLUSIVE')
                need(root.stat().st_uid==uid,'fixture未正常交还owner','INCONCLUSIVE');remove_owned_tree(root,root.stat().st_dev);cleanup['root_removed']=True
        except Exception as e:cleanup.update(status='INCONCLUSIVE',reason=str(e),retained_root=str(root))
        summary['run']={'id':run,'attempt':attempt,'commit':commit};summary['limited_native_status']=C.aggregate([validated_fixture_status,cleanup['status'],'PASS' if summary['execution_status']=='COMPLETE' else summary['execution_status']]);ev.file('cleanup.json',cleanup);ev.file('summary.json',summary);sumfiles(out)
    print(json.dumps({'execution_status':summary['execution_status'],'limited_native_status':summary['limited_native_status'],'provider_qualification':'BLOCKED_PENDING_INDEPENDENT_R04','accepted_provider_profiles':[]},ensure_ascii=False));return 1 if summary['limited_native_status']=='FAIL' else 0

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--mode',required=True,choices=('local-check','hosted-linux','fixture','child'));p.add_argument('--root');p.add_argument('--out');p.add_argument('--uid',type=int,default=-1);p.add_argument('--gid',type=int,default=-1);p.add_argument('--token',default='');p.add_argument('--outer-namespace',default='');p.add_argument('--operation');p.add_argument('--case');args=p.parse_args()
    try:
        if args.mode=='local-check':return local(args)
        if args.mode=='hosted-linux':return hosted(args)
        if args.mode=='fixture':return fixture(args)
        return child(args)
    except (Stop,OSError,ValueError,KeyError,TypeError) as e:
        status=e.status if isinstance(e,(Stop,C.CheckError)) else 'FAIL' if isinstance(e,ValueError) else 'INCONCLUSIVE'
        print(json.dumps({'status':status,'error_type':type(e).__name__,'reason':str(e)},ensure_ascii=False),file=sys.stderr);return 69
if __name__=='__main__':raise SystemExit(main())

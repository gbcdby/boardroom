#!/usr/bin/env python3
"""#152 R04 d1：离线控制或独立专用 hosted 取证；没有本地提权入口。"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
sys.dont_write_bytecode=True
sys.path.insert(0,str(HERE))
import checks as C
import observer as O
from support import Evidence, Stop, canonical, drop, encoded, handoff_owned_tree, mountinfo, read_small, remove_owned_tree, sha, stat_fields, verify_marker, write_file

BRANCH='refs/heads/qualification/152-native-ext4-r04-d1'
OPTIONS=('rw','relatime','errors=remount-ro','data=ordered','acl')
PAYLOAD=b'boardroom #152 R04 first ordinary content open\n'
BUDGETS={'images':2,'image_bytes':67108864,'payload_bytes':1048576,'objects_per_class':8,
         'cold_rounds':3,'default_variants':1,'compile_seconds':10,'probe_seconds':3,
         'stage_seconds':60,'fixture_seconds':300,'job_minutes':10,'bundle_bytes':67108864}


def need(ok,reason,status='INCONCLUSIVE'):
    if not ok: raise Stop(reason,status)


def original_profile():
    raw=read_small(HERE/'profile.json'); p=C.strict_json(raw)
    need(p['revision']==C.REVISION and p['target']==C.TARGET and p['budgets']==BUDGETS,'固定 profile 不符')
    need(p['source_files']==list(C.FILES) and all(p[k]==C.RELEASE[k] for k in C.RELEASE),'scope/release 不符')
    return raw


def source_identity(*,dirty=False):
    def git(*args): return subprocess.check_output(['git','-C',str(REPO),*args],text=True).strip()
    if not dirty: need(not git('status','--porcelain=v1','--untracked-files=no'),'候选 tracked dirty','FAIL')
    rows={}
    for name in C.FILES:
        raw=read_small(REPO/name)
        blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        if not dirty:
            actual=git('ls-tree','HEAD','--',name).split();need(actual[:3]==['100644','blob',blob],'源码未绑定 HEAD blob','FAIL')
        rows[name]={'mode':'100644','blob':blob,'sha256':sha(raw)}
    return {'commit':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'files':rows}


def originals(path):
    files={}; total=0
    for p in sorted(path.rglob('*')):
        need(not p.is_symlink(),'原件 symlink')
        if p.is_file():
            raw=read_small(p);total+=len(raw);files[p.relative_to(path).as_posix()]=raw
            need(len(files)<=512 and total<=BUDGETS['bundle_bytes'],'原件总预算')
    return files


def reseal_memory(files):
    files=dict(files);files['manifest.json']=encoded({'schema':'fs-ext4-r04-manifest/v1',
      'files':{k:sha(v) for k,v in files.items() if k!='manifest.json'}});return files


def manifest(path):
    files=reseal_memory(originals(path));write_file(path/'manifest.json',files['manifest.json'])


def seal(path,source,profile,*,synthetic=False):
    write_file(path/'summary.json',encoded(C.base_summary()));manifest(path)
    result=C.consume(originals(path),source,profile,allow_synthetic=synthetic,sealed=False)
    write_file(path/'summary.json',encoded(result));manifest(path)
    return C.consume(originals(path),source,profile,allow_synthetic=synthetic)


def local_fixture(path):
    """真实文件生成→manifest→同一消费者接线；明确 synthetic，不能交平台 PASS。"""
    path.mkdir();profile=original_profile();source=source_identity(dirty=True)
    binary=b'synthetic local consumer fixture; not executable\n'; raw=b'R04-local-control\x00\xff\n'
    files={'source.json':encoded(source),'profile.json':profile,'native-probe':binary,
      'binary.json':encoded({'sha256':sha(binary),'synthetic':True}),
      'cleanup.json':encoded({'status':'PASS','children_reaped':True,'owned_mounts_remaining':[], 'owned_loops_remaining':[]}),
      'execution.json':encoded({'mode':'synthetic-control','platform_run':False,'completed':True,'control_original_sha256':sha(raw)}),
      'events.jsonl':encoded({'event':'synthetic-generator','platform_run':False}),
      'raw/local-control.bin':raw}
    for name,data in files.items():
        (path/name).parent.mkdir(parents=True,exist_ok=True);write_file(path/name,data)
    seal(path,source,profile,synthetic=True);return source,profile


def cold_control_fixture():
    """仅离线归因控制，绝不作为任何 M 的 host 原件。"""
    identity=[123,456];uid='a1'*16
    def sb(point,checksum):
        raw=bytearray(1024);raw[56:58]=b'\x53\xef';raw[104:120]=bytes.fromhex(uid)
        raw[136:136+len(point)]=point.encode();struct.pack_into('<I',raw,1020,checksum);return bytes(raw)
    before=sb('/tmp/r04/p',1);changed=sb('/tmp/r04/r',2)
    def row(point,ordinary):
        kinds=['cold-mounted','path-observer-before','provider-start']+(['ordinary-open'] if ordinary else [])+['provider-end','path-observer-after','raw-post','flush','raw-flush','unmount','raw-unmount']
        return {'point':point,'image_identity':identity.copy(),'observer_domain_valid':True,
          'events':[{'kind':k,**({'actor':'provider'} if k=='ordinary-open' else {})} for k in kinds],
          'pre':before,'post':changed if ordinary else before,'flush':changed if ordinary else before,'unmount':changed if ordinary else before}
    return {'prepare_point':'/tmp/r04/p','image_identity':identity,'uuid':uid,
            'control':row('/tmp/r04/c',False),'regular':row('/tmp/r04/r',True)}


def command(ev,label,argv,seconds=3,cleanup=False):
    rc,out,err=ev.call(label,argv,seconds,cleanup=cleanup)
    need(rc==0,'命令未完成 '+label+': '+str(rc),'BLOCKED')
    return out


def environment():
    u=platform.uname()
    return {'target':{'sysname':u.system,'machine':u.machine,'release':u.release,'version':u.version},
      'image_provenance':{k:os.environ.get(k) for k in ('ImageOS','ImageVersion','ImageRelease')},
      'vendor_source_binding':'UNPROVEN','ext4_build_or_module_binding':'UNPROVEN',
      'tools':{k:shutil.which(k) for k in ('cc','python3','setpriv','sudo','unshare','mount','umount','mkfs.ext4','tune2fs','debugfs','losetup','sync')}}


def prepare_objects(point,uid,gid):
    os.chown(point,uid,gid);os.chmod(point,0o700)
    for name in ('directory','ancestor'):
        p=point/name;p.mkdir(mode=0o700);os.chown(p,uid,gid)
    write_file(point/'payload',PAYLOAD,0o600);os.chown(point/'payload',uid,gid)
    for name in ('.','payload','directory','ancestor'): os.setxattr(point/name,'user.boardroom-r04',b'owned-fixture')
    fd=os.open(point,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME)
    try: os.fsync(fd)
    finally: os.close(fd)


def fixture(args):
    root=canonical(Path(args.root));marker=verify_marker(root,args.token)
    need(os.getuid()==0 and os.readlink('/proc/self/ns/mnt')!=args.outer_namespace,'仅专用 hosted 私有 mount namespace')
    need(marker['entrypoint']==BRANCH and marker['uid']==args.uid and marker['gid']==args.gid and args.uid>0 and args.gid>0,'固定执行归属')
    need(root.parent==Path('/tmp') and re.fullmatch('br4-[A-Za-z0-9_-]+',root.name),'短且自有 root')
    os.chown(root,0,0);os.chmod(root,0o711);os.chown(root/'native-probe',0,0)
    ev=Evidence(root/'evidence');profile=original_profile();source=marker['source'];binary=read_small(root/'native-probe')
    need(sha(binary)==marker['binary_sha256'],'native binary changed','FAIL')
    active_mounts=[];loops={};attach_unknown=set();images={};points={k:str(root/v) for k,v in {'control':'c','regular':'r','variant':'v','whole-alias':'w','subdir-alias':'s'}.items()}
    fixture_info={'uid':args.uid,'gid':args.gid,'root_identity':marker['root_identity'],'binary_path':str(root/'native-probe'),'prepare_point':str(root/'p'),'points':points,'images':images}
    cleanup={'status':'INCONCLUSIVE','children_reaped':False,'owned_mounts_remaining':[],'owned_loops_remaining':[]}
    execution={'mode':'hosted-fixture','platform_run':True,'synthetic':False,'completed':False};error=None;result=C.base_summary()
    def cancel(sig,_):
        for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,signal.SIG_IGN)
        ev.cancelled=True;raise Stop('fixture cancelled '+str(sig),'INCONCLUSIVE')
    for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,cancel)
    def guard(key):
        verify_marker(root,args.token)
        return O.loop_binding(loops[key],root/(key+'.ext4'),images[key]['identity'])
    def mount(key,point,label):
        guard(key);point.mkdir(exist_ok=True)
        need(not any(r['point']==str(point) for r in mountinfo()),'mount target already occupied')
        active_mounts.append((str(point),key))
        try:command(ev,label,['mount','-t','ext4','-o',','.join(OPTIONS),loops[key],str(point)])
        finally:
            entries=[r for r in mountinfo() if r['point']==str(point)]
            ev.file('mounts/'+label+'-attempt.json',{'observed_after_attempt':entries,'target':str(point),'key':key})
            if not entries:active_mounts.remove((str(point),key))
        need(len(entries)==1 and entries[0]['type']=='ext4' and entries[0]['root']=='/','实际 native mount 原件')
        ev.file('mounts/'+label+'.json',{'entry':entries[0],'loop_binding':guard(key),'requested':list(OPTIONS)})
    def unmount(point,key,label,cleanup_mode=False):
        guard(key);entries=[r for r in mountinfo() if r['point']==str(point)]
        need(len(entries)==1 and entries[0]['type']=='ext4' and entries[0]['device']==f"{os.major(guard(key)['loop_rdev'])}:{os.minor(guard(key)['loop_rdev'])}",'cleanup mount identity')
        command(ev,label,['umount',str(point)],3,cleanup=cleanup_mode)
        need(not any(r['point']==str(point) for r in mountinfo()),'mount remains after umount')
        active_mounts.remove((str(point),key))
    def raw_sb(key,label,phase):
        raw,binding=O.superblock(loops[key],root/(key+'.ext4'),images[key]['identity'])
        ev.file(f'raw/{label}-{phase}.sb',raw,raw=True);ev.file(f'raw/{label}-{phase}-receipt.json',binding)
        ev.event('raw-sb',round=label,phase=phase,sha256=sha(raw));return raw
    def journal(key,label,phase):
        binding=guard(key);dest=root/f'journal-{label}-{phase}.bin';need(not dest.exists(),'journal export must be new')
        command(ev,label+'-journal-'+phase,['debugfs','-R','dump <8> '+str(dest),loops[key]],3)
        raw=read_small(dest,8*1024*1024);need(len(raw)>=1024,'journal original empty')
        ev.file(f'raw/{label}-journal-{phase}.bin',raw,raw=True)
        ev.file(f'raw/{label}-journal-{phase}-receipt.json',{'loop_binding':binding,'bytes':len(raw),'sha256':sha(raw),'method':'debugfs read-only raw device, dump internal journal inode8'})
        need(guard(key)==binding,'journal device changed')
    def provider(label,mode):
        need(sha(read_small(root/'native-probe'))==marker['binary_sha256'],'provider binary identity','FAIL')
        rc,out,err=ev.call('provider-'+label,drop(args.uid,args.gid,[str(root/'native-probe'),mode,str(args.uid),str(args.gid),points[label]]),3)
        return rc,out,err
    def round_(key,label,mode):
        point=Path(points[label]);events=[]
        def e(kind,**fields):
            value={'kind':kind,**fields};events.append(value);ev.event('cold-step',round=label,value=value)
        guard(key)
        # 离线 raw 工具读取 backing image，不经过 source ext4 file_open。
        command(ev,label+'-offline-content',['debugfs','-R','cat /payload',str(root/(key+'.ext4'))],3)
        mount(key,point,'mount-'+label);e('cold-mounted')
        raw_sb(key,label,'pre');journal(key,label,'before')
        ev.file('views/'+label+'-before.json',O.source_view(point));e('path-observer-before')
        e('provider-start');rc,out,err=provider(label,mode)
        try:
            native=[C.strict_json(l) for l in out.splitlines()]
            for entry in native:
                if entry.get('kind')=='step' and entry.get('action')=='ordinary-open':
                    e('ordinary-open',actor='provider')
        except C.Invalid: pass
        e('provider-end')
        ev.file('views/'+label+'-after.json',O.source_view(point));e('path-observer-after')
        raw_sb(key,label,'post');e('raw-post')
        # sync -f opens the DIRECTORY only; its writes are harness flush, separately receipted.
        command(ev,label+'-flush',['sync','-f',str(point)],3);e('flush')
        raw_sb(key,label,'flush');e('raw-flush')
        if label=='regular': alias_controls(key,point)
        unmount(point,key,label+'-unmount');e('unmount')
        raw_sb(key,label,'unmount');e('raw-unmount');journal(key,label,'after')
        ev.file('rounds/'+label+'.json',{'point':str(point),'image_identity':images[key]['identity'],'events':events,
                 'observer_domain_valid':False,'provider_returncode':rc,'provider_stderr_bytes':len(err)})
    def alias_controls(key,point):
        data={'production_writer_coverage':'UNPROVEN','idmap':{'status':'NOT_RUN','reason':'not induced; no user namespace or extra provider privilege'},
              'namespace':{'outer':args.outer_namespace,'fixture':os.readlink('/proc/self/ns/mnt'),'scope':'harness-private only'}}
        for label,source_path in (('whole-alias',point),('subdir-alias',point/'directory')):
            alias=Path(points[label]);alias.mkdir();guard(key)
            active_mounts.append((str(alias),key))
            try:command(ev,'bind-'+label,['mount','--bind',str(source_path),str(alias)])
            finally:
                if not any(r['point']==str(alias) for r in mountinfo()):active_mounts.remove((str(alias),key))
            rc,out,err=provider(label,'context')
            data[label]={'status':'OBSERVED' if out else 'BLOCKED','returncode':rc,'root':str(source_path),
                         'mechanical_only':True,'writer_coverage':'UNPROVEN','backing_object_binding':'UNPROVEN'}
            ev.file('mounts/'+label+'.json',{'rows':[r for r in mountinfo() if r['point']==str(alias)],'loop_binding':guard(key)})
            unmount(alias,key,'unbind-'+label)
        ev.file('topology-controls.json',data)
    try:
        for name,value in (('source.json',source),('environment.json',marker['environment']),('binary.json',{'sha256':sha(binary)})):
            ev.file(name,value)
        ev.file('profile.json',profile,raw=True);ev.file('native-probe',binary,raw=True);ev.file('expected-payload.bin',PAYLOAD,raw=True)
        need(marker['environment']['target']==C.TARGET,'target build changed','BLOCKED')
        for key,prep,default in (('A','p','acl,user_xattr'),('B','q','^acl,user_xattr')):
            with ev.phase('prepare-'+key):
                image=root/(key+'.ext4');fd=os.open(image,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
                try: os.ftruncate(fd,BUDGETS['image_bytes']);os.fsync(fd)
                finally: os.close(fd)
                st=image.lstat();uid=str(uuid.uuid4());images[key]={'identity':[st.st_dev,st.st_ino],'uuid':uuid.UUID(uid).hex,'bytes':st.st_size}
                command(ev,'mkfs-'+key,['mkfs.ext4','-F','-U',uid,'-E','lazy_itable_init=0,lazy_journal_init=0',str(image)],30)
                command(ev,'defaults-'+key,['tune2fs','-o',default,str(image)],3)
                attach_unknown.add(key)
                text=command(ev,'attach-'+key,['losetup','--find','--show',str(image)]).decode().strip()
                need(re.fullmatch('/dev/loop[0-9]+',text) is not None,'loop name');loops[key]=text;guard(key);attach_unknown.remove(key)
                point=root/prep;mount(key,point,'prepare-mount-'+key);prepare_objects(point,args.uid,args.gid)
                ev.file('preparation/'+key+'-view.json',O.source_view(point));ev.file('preparation/'+key+'-writes.json',{'scope':'owned fixture only','source_open_phase':'preparation','payload_sha256':sha(PAYLOAD)})
                command(ev,'prepare-flush-'+key,['sync','-f',str(point)]);unmount(point,key,'prepare-unmount-'+key)
                raw_sb(key,'prepare-'+key,'unmount')
        ev.file('fixture.json',fixture_info)
        for key,label,mode in (('A','control','context'),('A','regular','ordinary'),('B','variant','context')):
            with ev.phase('cold-'+label):round_(key,label,mode)
        execution['completed']=True
    except (Exception,KeyboardInterrupt) as exc:
        error={'type':type(exc).__name__,'reason':str(exc),'status':getattr(exc,'status','INCONCLUSIVE')}
        ev.file('execution-error.json',error)
    finally:
        ev.flush_pending_receipts();errors=[]
        for point,key in list(reversed(active_mounts)):
            try:unmount(Path(point),key,'cleanup-unmount-'+Path(point).name,True)
            except Exception as exc:errors.append(str(exc))
        for key,loop in list(loops.items()):
            if any(k==key for _,k in active_mounts):continue
            try:
                binding=guard(key);command(ev,'detach-'+key,['losetup','-d',loop],3,cleanup=True)
                ev.file('cleanup/detached-'+key+'.json',O.loop_detached(loop,binding['loop_rdev']))
                loops.pop(key)
            except Exception as exc:errors.append(str(exc))
        cleanup={'status':'PASS' if not errors and not active_mounts and not loops and not attach_unknown and not ev.children else 'INCONCLUSIVE',
                 'children_reaped':not ev.children,'owned_mounts_remaining':active_mounts,'owned_loops_remaining':list(loops.values()),
                 'unknown_attach_images':sorted(attach_unknown),'errors':errors}
        ev.file('cleanup.json',cleanup);ev.file('execution.json',execution)
        # Every final artifact exists before ownership handoff. Later writes only
        # truncate these same files, retaining the verified recipient ownership.
        ev.file('handoff.json',{'status':'NOT_RUN'});ev.file('summary.json',C.base_summary());manifest(ev.path)
        if cleanup['status']=='PASS':
            try:ev.file('handoff.json',handoff_owned_tree(root,args.token,args.uid,args.gid,cleanup))
            except Exception as exc:
                cleanup['status']='INCONCLUSIVE';cleanup['errors'].append('owned tree handoff: '+str(exc))
                ev.file('handoff.json',{'status':'INCONCLUSIVE','reason':str(exc)})
                ev.file('cleanup.json',cleanup)
        try:result=seal(ev.path,source,profile)
        except Exception as exc:
            result=C.base_summary();result['integrity']='REJECTED';result['bundle_error']=str(exc)
            observed=list((ev.path/'commands').glob('provider-*.stdout')) if (ev.path/'commands').exists() else []
            if observed:
                result['M']={k:{'status':'INCONCLUSIVE','reason':'attempted originals retained; complete consumer rejected'} for k in C.M_IDS}
                if not (ev.path/'commands/provider-regular.stdout').exists():result['M']['M05']={'status':'NOT_RUN'}
            if error:result['execution_error']=error
            ev.file('summary.json',result);manifest(ev.path)
    print(json.dumps({'integrity':result['integrity'],'M':result['M'],'production_runtime':'UNSUPPORTED'},ensure_ascii=False))
    return 1 if result['integrity']!='PASS' or any(r['status']=='FAIL' for r in result['M'].values()) else 0


def local(args):
    out=canonical(Path(args.out),absent_leaf=True);ev=Evidence(out);summary=C.base_summary()
    try:
        ev.file('profile.json',original_profile(),raw=True);ev.file('source.json',source_identity(dirty=True))
        command(ev,'compile',['cc','-std=gnu11','-Wall','-Wextra','-Werror','-O2',str(HERE/'probe.c'),'-o',str(out/'native-probe')],10)
        command(ev,'abi',[str(out/'native-probe'),'--abi'],3)
        command(ev,'local-controls',[sys.executable,str(REPO/'tests/fs-native-ext4-r04-evidence.test.py')],3)
        summary['local_controls']='PASS';summary['target_execution']='NOT_RUN'
    except Exception as exc:summary['local_controls']='FAIL';summary['error']=str(exc)
    finally:
        ev.flush_pending_receipts();ev.file('cleanup.json',{'status':'PASS','children_reaped':not ev.children,'mount_attempted':False,'privilege_attempted':False})
        ev.file('summary.json',summary);manifest(out)
    print(json.dumps(summary,ensure_ascii=False));return 0 if summary.get('local_controls')=='PASS' else 1


def hosted(args):
    env=os.environ;uid,gid=os.getuid(),os.getgid()
    need(uid>0 and gid>0 and env.get('GITHUB_ACTIONS')=='true' and env.get('GITHUB_REPOSITORY')=='gbcdby/boardroom' and env.get('GITHUB_REF')==BRANCH and env.get('GITHUB_EVENT_NAME')=='push','只允许专用 push hosted 入口；拒绝本地提权')
    need(canonical(Path(env['GITHUB_WORKSPACE']))==REPO,'checkout root')
    runid,attempt,commit=(env.get(k,'') for k in ('GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA'))
    need(re.fullmatch('[0-9]+',runid) and re.fullmatch('[0-9]+',attempt) and re.fullmatch('[a-f0-9]{40}',commit),'run identity')
    need(Path(args.out)==REPO/'.agent-output/fs-native-ext4-r04-evidence','fixed output root')
    Path(args.out).parent.mkdir(exist_ok=True);ev=Evidence(canonical(Path(args.out),absent_leaf=True))
    ev.deadline=time.monotonic()+360;ev.action_deadline=ev.stage_deadline=ev.deadline-30
    def cancel(sig,_):
        for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,signal.SIG_IGN)
        ev.cancelled=True;raise Stop('hosted cancelled '+str(sig),'INCONCLUSIVE')
    for s in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(s,cancel)
    root=None;token=uuid.uuid4().hex;source=None;profile=None;cleanup={'status':'PASS','root_removed':False};summary=C.base_summary()
    try:
        profile=original_profile();source=source_identity();need(source['commit']==commit,'GITHUB_SHA vs checkout','FAIL')
        e=environment();ev.file('environment.json',e);ev.file('source.json',source);ev.file('profile.json',profile,raw=True)
        ev.file('run.json',{'run':runid,'attempt':attempt,'commit':commit,'branch':BRANCH})
        need(e['target']==C.TARGET,'actual runner no longer target; no auto retry','BLOCKED')
        need(all(e['tools'].values()),'required tool unavailable; no install fallback','BLOCKED')
        root=Path(tempfile.mkdtemp(prefix='br4-',dir='/tmp'));canonical(root)
        need(len(str(root/'r').encode())<64,'short mountpoint bound')
        command(ev,'compiler-version',['cc','--version'])
        command(ev,'compile',['cc','-std=gnu11','-Wall','-Wextra','-Werror','-O2',str(HERE/'probe.c'),'-o',str(root/'native-probe')],10)
        binary=read_small(root/'native-probe');st=root.stat();ns=os.readlink('/proc/self/ns/mnt')
        marker={'root':str(root),'root_identity':[st.st_dev,st.st_ino],'token':token,'uid':uid,'gid':gid,
                'entrypoint':BRANCH,'source':source,'binary_sha256':sha(binary),'environment':e,'outer_namespace':ns}
        write_file(root/'.fsqual-marker.json',encoded(marker))
        rc,out,err=ev.call('namespace',['sudo','-n','unshare','--mount','--propagation','private','--fork','--kill-child=TERM','--',
             sys.executable,'-I',str(HERE/'run.py'),'--mode','fixture','--root',str(root),'--uid',str(uid),'--gid',str(gid),'--token',token,'--outer-namespace',ns],300)
        need((root/'evidence/summary.json').is_file(),'fixture failed before producing evidence')
        for name,data in originals(root/'evidence').items():ev.file('fixture/'+name,data,raw=True)
        # Consume the actual copied artifact subtree, not an in-memory summary.
        summary=C.consume(originals(ev.path/'fixture'),source,profile)
        need(rc in (0,1),'unexpected namespace exit')
        need(rc==0 or any(v['status']=='FAIL' for v in summary['M'].values()),'exit failed without qualified diagnostic failure')
    except Exception as exc:
        summary['integrity']='REJECTED';summary['error']={'status':getattr(exc,'status','INCONCLUSIVE'),'reason':str(exc)}
    finally:
        ev.flush_pending_receipts()
        if root is not None:
            try:
                verify_marker(root,token)
                if (root/'evidence').is_dir() and not (ev.path/'fixture').exists():
                    for name,data in originals(root/'evidence').items():ev.file('fixture/'+name,data,raw=True)
                raw=read_small(root/'evidence/cleanup.json');fixture_cleanup=C.strict_json(raw)
                handoff=C.strict_json(read_small(root/'evidence/handoff.json'))
                need(fixture_cleanup['status']=='PASS' and handoff['status']=='PASS' and
                     handoff['root_identity']==[root.lstat().st_dev,root.lstat().st_ino] and
                     handoff['uid']==uid and handoff['gid']==gid and root.lstat().st_uid==uid and
                     root.lstat().st_gid==gid and not ev.children,'unknown fixture resource or ownership retained')
                remove_owned_tree(root,root.stat().st_dev);cleanup['root_removed']=True
            except Exception as exc:cleanup={'status':'INCONCLUSIVE','root_removed':False,'reason':str(exc),'retained_root':str(root)}
        ev.file('cleanup.json',cleanup);ev.file('summary.json',summary);manifest(ev.path)
    print(json.dumps({'integrity':summary['integrity'],'M':summary['M'],'production_runtime':'UNSUPPORTED','cleanup':cleanup['status']},ensure_ascii=False))
    return 1 if summary['integrity']!='PASS' or cleanup['status']!='PASS' or any(r['status']=='FAIL' for r in summary['M'].values()) else 0


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--mode',choices=('local-check','hosted-linux','fixture'),required=True)
    p.add_argument('--out');p.add_argument('--root');p.add_argument('--uid',type=int,default=-1);p.add_argument('--gid',type=int,default=-1)
    p.add_argument('--token',default='');p.add_argument('--outer-namespace',default='');args=p.parse_args()
    try:return local(args) if args.mode=='local-check' else hosted(args) if args.mode=='hosted-linux' else fixture(args)
    except (Stop,C.Invalid,OSError,ValueError) as exc:
        print(json.dumps({'status':getattr(exc,'status','INCONCLUSIVE'),'reason':str(exc)},ensure_ascii=False),file=sys.stderr);return 69


if __name__=='__main__':raise SystemExit(main())

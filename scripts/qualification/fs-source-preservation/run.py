#!/usr/bin/env python3
"""#152 source-preservation r2：离线控制或独立专用 hosted 取证；没有本地提权入口。"""
from __future__ import annotations
import argparse
import copy
import ctypes
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
import window as W
from support import Evidence, Stop, canonical, drop, encoded, handoff_owned_tree, mountinfo, read_small, remove_owned_tree, sha, stat_fields, verify_marker, write_file

BRANCH='refs/heads/qualification/152-fs-source-preservation-r1'
OPTIONS=('rw','relatime','errors=remount-ro','data=ordered','acl')
PAYLOAD=b'boardroom #152 source preservation ordinary content open\n'
BUDGETS={'images':2,'image_bytes':67108864,'payload_bytes':1048576,'objects_per_class':8,
         'cold_rounds':3,'visible_error_rounds':1,'default_variants':1,'compile_seconds':10,'probe_seconds':3,
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
    if not dirty: need(not git('status','--porcelain=v1'),'候选 tracked dirty','FAIL')
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
    files=dict(files);files['manifest.json']=encoded({'schema':'fs-source-preservation-manifest/v1',
      'files':{k:sha(v) for k,v in files.items() if k!='manifest.json'}});return files


def manifest(path):
    files=reseal_memory(originals(path));write_file(path/'manifest.json',files['manifest.json'])


def seal(path,source,profile,*,synthetic=False):
    write_file(path/'summary.json',encoded(C.base_summary()));manifest(path)
    result=C.consume(originals(path),source,profile,allow_synthetic=synthetic,sealed=False)
    write_file(path/'summary.json',encoded(result));manifest(path)
    return C.consume(originals(path),source,profile,allow_synthetic=synthetic)






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
    for name in ('.','payload','directory','ancestor'): os.setxattr(point/name,'user.boardroom-source-preservation',b'owned-fixture')
    fd=os.open(point,os.O_RDONLY|os.O_DIRECTORY|os.O_NOATIME)
    try: os.fsync(fd)
    finally: os.close(fd)


def fixture(args):
    root=canonical(Path(args.root));marker=verify_marker(root,args.token)
    need(os.getuid()==0 and os.readlink('/proc/self/ns/mnt')!=args.outer_namespace,'仅专用 hosted 私有 mount namespace')
    need(marker['entrypoint']==BRANCH and marker['uid']==args.uid and marker['gid']==args.gid and args.uid>0 and args.gid>0,'固定执行归属')
    need(root.parent==Path('/tmp') and re.fullmatch('brsp-[A-Za-z0-9_-]+',root.name),'短且自有 root')
    os.chown(root,0,0);os.chmod(root,0o711);os.chown(root/'native-probe',0,0)
    ev=Evidence(root/'evidence');profile=original_profile();source=C.strict_json(read_small(root/'source.json'));binary=read_small(root/'native-probe')
    need(sha(encoded(source))==marker['source_sha256'],'source manifest changed','FAIL')
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
    def statistics(key):
        binding=guard(key);device=f"{os.major(binding['loop_rdev'])}:{os.minor(binding['loop_rdev'])}"
        raw=read_small(Path('/sys/dev/block')/device/'stat',4096)
        fields=raw.decode('ascii').split();need(11<=len(fields)<=32 and all(re.fullmatch('[0-9]+',v) for v in fields),'block stat original')
        need(guard(key)==binding,'statistics device changed')
        return {'loop_binding':binding,'device':device,'raw_hex':raw.hex(),'write_sectors':fields[6],
                'realtime_ns':time.time_ns(),'monotonic_ns':time.monotonic_ns()}
    def device_view(key,label,phase):
        binding=guard(key);started=time.monotonic_ns()
        fd=os.open(loops[key],os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
        try:
            actual=os.fstat(fd);need(stat.S_ISBLK(actual.st_mode) and actual.st_rdev==binding['loop_rdev'],'image observer binding')
            chunks=[]
            for offset in range(0,BUDGETS['image_bytes'],1048576):
                ev.remaining(3);chunk=os.pread(fd,1048576,offset);need(len(chunk)==1048576,'complete owned image observation')
                chunks.append(chunk)
            raw=b''.join(chunks)
        finally:os.close(fd)
        need(guard(key)==binding,'image observer device changed')
        hashes=[sha(raw[i:i+4096]) for i in range(0,len(raw),4096)]
        ev.file(f'raw/{label}-image-{phase}.json',{'bytes':len(raw),'block_bytes':4096,'block_sha256':hashes,
            'loop_binding':binding,'begin_monotonic_ns':started,'end_monotonic_ns':time.monotonic_ns(),
            'scope':'all owned-device blocks observed; hashes are not an atomic live device snapshot'})
        ev.file(f'raw/{label}-image-{phase}.sb',raw[1024:2048],raw=True)
        return raw
    def mount(key,point,label):
        guard(key);point.mkdir(exist_ok=True)
        need(not any(r['point']==str(point) for r in mountinfo()),'mount target already occupied')
        before,binding=O.superblock(loops[key],root/(key+'.ext4'),images[key]['identity'])
        ev.file('mounts/'+label+'-before.sb',before,raw=True);ev.file('mounts/'+label+'-before-stat.json',statistics(key))
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
        before=statistics(key)
        command(ev,label,['umount',str(point)],3,cleanup=cleanup_mode)
        ev.file('mounts/'+label+'-statistics.json',{'before':before,'after':statistics(key)})
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
    def provider(label,mode,fault=False,command_label=None):
        need(sha(read_small(root/'native-probe'))==marker['binary_sha256'],'provider binary identity','FAIL')
        command_label=command_label or 'provider-'+label+('-missing-getter' if fault else '')
        argv=[str(root/'native-probe'),mode,str(args.uid),str(args.gid),points[label]]+(['--fault-health-unavailable'] if fault else [])
        rc,out,err=ev.call(command_label,drop(args.uid,args.gid,argv),3)
        ev.file('windows/'+command_label+'-reap.json',{'joined_monotonic_ns':time.monotonic_ns(),'label':command_label,'mode':mode})
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
        mapping=command(ev,label+'-journal-blocks',['debugfs','-R','blocks <8>',loops[key]],3).decode('ascii').split()
        need(len(mapping)==1024 and all(re.fullmatch('[0-9]+',v) for v in mapping),'complete 4MiB journal mapping')
        mapping=[int(v) for v in mapping];need(len(set(mapping))==1024 and all(0<v<16384 for v in mapping),'unique owned journal blocks')
        ev.file('raw/'+label+'-journal-map.json',{'blocks':mapping,'loop_binding':guard(key)})
        before_image=device_view(key,label,'before')
        ev.file('views/'+label+'-before.json',O.source_view(point));e('path-observer-before')
        e('provider-start');rc,out,err=provider(label,mode)
        try:
            native=[C.strict_json(l) for l in out.splitlines()]
            for entry in native:
                if entry.get('kind')=='step' and entry.get('action')=='ordinary-open':
                    e('ordinary-open',actor='provider')
        except C.Invalid: pass
        e('provider-end')
        if label=='control':provider(label,'ordinary',True)
        ev.file('views/'+label+'-after.json',O.source_view(point));e('path-observer-after')
        raw_sb(key,label,'post');e('raw-post')
        ev.file('raw/'+label+'-provider-stat.json',statistics(key))
        # sync -f opens the DIRECTORY only; its writes are harness flush, separately receipted.
        command(ev,label+'-flush',['sync','-f',str(point)],3);e('flush')
        raw_sb(key,label,'flush');e('raw-flush')
        if label=='regular': alias_controls(key,point)
        unmount(point,key,label+'-unmount');e('unmount')
        raw_sb(key,label,'unmount');e('raw-unmount');journal(key,label,'after')
        after_image=device_view(key,label,'after')
        differences=[i for i in range(16384) if before_image[i*4096:(i+1)*4096]!=after_image[i*4096:(i+1)*4096]]
        ev.file('raw/'+label+'-block-deltas.json',{'complete':len(differences)<=128,'changed_blocks':differences,
            'raw_blocks':[{'block':i,'before_hex':before_image[i*4096:(i+1)*4096].hex(),
                          'after_hex':after_image[i*4096:(i+1)*4096].hex()} for i in differences[:128]]})
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
    def visible_error_control():
        # All positive windows and complete device/journal closures must classify
        # before a separate deliberate root error can affect the owned B image.
        positive=C.positive_rounds(originals(ev.path),fixture_info)
        ev.file('fault/positive-closure.json',{'sha256':sha(encoded(positive)),'monotonic_ns':time.monotonic_ns()})
        point=Path(points['variant']);mount('B',point,'visible-error-mount')
        before_label='provider-visible-error-before'
        _,raw,_=provider('variant','context',command_label=before_label)
        baseline=W.capture(raw,'context',C.strict_json(read_small(ev.path/'commands'/f'{before_label}.receipt.json')),
            C.strict_json(read_small(ev.path/'windows'/f'{before_label}-reap.json'))['joined_monotonic_ns'])
        raw_sb('B','visible-error','pre');journal('B','visible-error','before')
        binding=guard('B');sbid=baseline['health']['binding']['sb_id']
        need(sbid==Path(loops['B']).name and re.fullmatch('loop[0-9]+',sbid),'fault owned loop name')
        def magic(fd):
            buf=ctypes.create_string_buffer(256);call=ctypes.CDLL(None,use_errno=True).fstatfs
            call.argtypes=[ctypes.c_int,ctypes.c_void_p];call.restype=ctypes.c_int
            need(call(fd,buf)==0,'fault pseudo-FS type unavailable')
            return struct.unpack_from('=q',buf.raw)[0]
        fds=[];record={'actor':'root-owned-B-fault-control','image':'B','point':str(point),'sb_id':sbid,
            'message_hex':C.FAULT_MESSAGE.hex(),'write_attempted':False,'written':None,'error':None,'close_errors':[]}
        try:
            source_fd=os.open(point,os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);fds.append(source_fd)
            health_fd=os.open(canonical(Path('/sys/fs/ext4')/sbid),os.O_PATH|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC);fds.append(health_fd)
            options_fd=os.open(canonical(Path('/proc/fs/ext4')/sbid/'options'),os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC);fds.append(options_fd)
            options_raw=os.read(options_fd,16385);need(len(options_raw)<=16384 and not os.read(options_fd,1),'fault options full bounded read')
            trigger_fd=os.open('trigger_fs_error',os.O_WRONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=health_fd);fds.append(trigger_fd)
            ss,hs,ts=os.fstat(source_fd),os.fstat(health_fd),os.fstat(trigger_fd)
            current={'source_dev':ss.st_dev,'source_inode':ss.st_ino,'source_uid':ss.st_uid,'source_gid':ss.st_gid,
                'health_dev':hs.st_dev,'health_inode':hs.st_ino,'health_magic':magic(health_fd),
                'trigger_dev':ts.st_dev,'trigger_uid':ts.st_uid,'trigger_mode':ts.st_mode,'trigger_magic':magic(trigger_fd),
                'options_magic':magic(options_fd)}
            C.visible_error_admission(baseline,binding,current,C.N.options(options_raw),images['B']['uuid'],str(point))
            need(guard('B')==binding,'fault loop backing changed before write')
            ev.file('fault/current-options.bin',options_raw,raw=True)
            ev.file('fault/admission.json',{'current':current,'loop_binding':binding,'monotonic_ns':time.monotonic_ns()})
            record['write_attempted']=True;record['begin_monotonic_ns']=time.monotonic_ns();ev.file('fault/trigger.json',record)
            record['written']=os.write(trigger_fd,C.FAULT_MESSAGE);record['end_monotonic_ns']=time.monotonic_ns()
            need(record['written']==len(C.FAULT_MESSAGE),'fault control short/unknown write')
        except Exception as exc:
            record['error']={'type':type(exc).__name__,'reason':str(exc)};raise
        finally:
            for fd in reversed(fds):
                try:os.close(fd)
                except OSError as exc:record['close_errors'].append({'fd':fd,'errno':exc.errno})
            ev.file('fault/trigger.json',record)
        need(not record['close_errors'] and guard('B')==binding,'fault control close/binding failure')
        after_label='provider-visible-error-after'
        _,raw,_=provider('variant','ordinary',command_label=after_label)
        rejected=W.visible_error_refusal(raw,C.strict_json(read_small(ev.path/'commands'/f'{after_label}.receipt.json')),baseline)
        ev.file('fault/ordinary-refusal.json',rejected)
        raw_sb('B','visible-error','post');unmount(point,'B','visible-error-unmount')
        raw_sb('B','visible-error','unmount');journal('B','visible-error','after')
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
                command(ev,'mkfs-'+key,['mkfs.ext4','-F','-b','4096','-U',uid,'-E','lazy_itable_init=0,lazy_journal_init=0',str(image)],30)
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
        with ev.phase('visible-error-control'):visible_error_control()
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
        command(ev,'local-controls',[sys.executable,str(REPO/'tests/fs-source-preservation.test.py')],3)
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
    need(Path(args.out)==REPO/'.agent-output/fs-source-preservation-evidence','fixed output root')
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
        # 普通 runner 只读取实际 package/module 元数据；不是仅凭 uname 推定 vendor 源码。
        for label,argv in (
            ('kernel-package',['dpkg-query','-W','-f=${Package}\n${Version}\n${source:Package}\n${source:Version}\n${Architecture}\n','linux-image-'+C.TARGET['release']]),
            ('ext4-module-file',['modinfo','-n','ext4']),
            ('ext4-module-vermagic',['modinfo','-F','vermagic','ext4']),
            ('ext4-module-srcversion',['modinfo','-F','srcversion','ext4'])):
            try:
                rc,out,err=ev.call(label,argv,3)
                ev.file('vendor/'+label+'.json',{'status':'OBSERVED' if rc==0 else 'UNAVAILABLE','returncode':rc,
                    'meaning':'raw build provenance only; no accepted build/source qualification'})
            except Exception as exc:
                ev.file('vendor/'+label+'.json',{'status':'UNAVAILABLE','reason':str(exc)})
        root=Path(tempfile.mkdtemp(prefix='brsp-',dir='/tmp'));canonical(root)
        need(len(str(root/'r').encode())<64,'short mountpoint bound')
        command(ev,'compiler-version',['cc','--version'])
        command(ev,'compile',['cc','-std=gnu11','-Wall','-Wextra','-Werror','-O2',str(HERE/'probe.c'),'-o',str(root/'native-probe')],10)
        binary=read_small(root/'native-probe');st=root.stat();ns=os.readlink('/proc/self/ns/mnt')
        marker={'root':str(root),'root_identity':[st.st_dev,st.st_ino],'token':token,'uid':uid,'gid':gid,
                'entrypoint':BRANCH,'source_sha256':sha(encoded(source)),'binary_sha256':sha(binary),'environment':e,'outer_namespace':ns}
        write_file(root/'source.json',encoded(source))
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

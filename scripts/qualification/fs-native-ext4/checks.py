"""有限资格消费者；不是生产 Fs parser/provider。"""
import re, os, stat, copy, errno, hashlib, json
PROFILE='linux-native-ext4-fid-fsuuid-v1'
CHECKS=tuple(f'EX4-Q{i:02}' for i in range(1,13))
OPTIONS=('rw','data=ordered','relatime','errors=remount-ro')
META_KEYS={'dev','ino','mode','nlink','size','uid','gid','atime','mtime','ctime'}
FROZEN_SCHEMA='fs-native-ext4-frozen-observations/v1'
CAPS={'CapInh','CapPrm','CapEff','CapBnd','CapAmb'}
CASES=(('file-root','file-root','file'),('directory-root','directory-root','directory'),('child-file','directory-root/child-file','file'),('child-dir','directory-root/child-dir','directory'),('nonempty','nonempty','directory'),('nonempty-child','nonempty/item','file'),('empty-dir','empty-dir','directory'),('ancestor','ancestor','directory'),('group-anchor','.','directory'))
STAT_FIELDS={'dev','ino','mode','uid','gid','nlink','size','rdev','blocks','atime_ns','mtime_ns','ctime_ns'}
# 每一PASS行的最小原件闭包。其余实际原件同样必须进入完整manifest。
Q_REQUIRED={
    'EX4-Q01':{'native/identity-native.json','fixture-image.json','features.json','mount/mount-native.json'},
    'EX4-Q02':{'native/cold-provider.json','native/identity-native.json','actions/initial-absent.json'},
    'EX4-Q03':{'cold-comparison.json','native/cold-control.json','native/cold-provider.json'}|{f'snapshots/{stage}-{group}.json' for stage in ('cold-before','cold-control-after','cold-provider-after') for group in ('fs-root','control','provider')},
    'EX4-Q04':{f'{prefix}/{stem}-{label}.json' for label in ('file-root','directory-root','empty-dir') for prefix,stem in (('native','mutation-before'),('native','mutation-after'),('actions','mutation'))},
    'EX4-Q05':{'recreation/file-root.json','recreation/empty-dir.json'}|{f'{prefix}/{stem}-{label}.json' for label in ('file-root','empty-dir') for prefix,stem in (('native','replace-before'),('native','replace-after'),('actions','replace'))},
    'EX4-Q06':{'inode-reuse.json','inode-reuse-budget.json'},
    'EX4-Q07':{'synthetic-equal-stat-time.json','inode-reuse.json'},
    'EX4-Q08':{'persisted-observations.json','persisted-observations.sha256','native/persist-source.json','actions/new-process-consume.json'},
    'EX4-Q09':{'fs-lifecycle.json','mount/lifecycle-mount.json','actions/post-lifecycle-consume.json','persisted-observations.json','persisted-observations.sha256'},
    'EX4-Q10':{'native/reject-'+label+'.json' for label in ('symlink','hardlink','fifo','foreign-owner','cross-mount','fd-reuse')}|{'actions/path-race.json','native/ancestor-before.json','native/ancestor-after.json','actions/ancestor-replace.json','actions/ancestor-absent.json'},
    'EX4-Q11':{'fault-injections.json','native/fault-control-source.json','actions/cancel-native.json','commands/synthetic-timeout-child.stdout','commands/synthetic-timeout-child.stderr'},
    'EX4-Q12':{'cleanup.json'},
}
for _key,_labels in {
    'EX4-Q01':('mkfs-version','mount-version','loop-version','mkfs','loop-attach','ext4-superblock','mount-native'),
    'EX4-Q09':('lifecycle-unmount','lifecycle-loop-detach','lifecycle-detach-proof','lifecycle-reattach','lifecycle-mount'),
}.items():Q_REQUIRED[_key]|={f'commands/{label}.{stream}' for label in _labels for stream in ('stdout','stderr')}
BASE_ORIGINALS={'summary.json','cleanup.json','candidate.json','environment.json','binary.json','profile.json','events.jsonl'}

class CheckError(ValueError):
    def __init__(self,message,status='FAIL'):
        super().__init__(message);self.status=status

def require(condition, message, status='FAIL'):
    if not condition: raise CheckError(message,status)

def strict_json(data):
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result,'重复JSON字段:'+key,'INCONCLUSIVE');result[key]=value
        return result
    def constant(value):raise CheckError('非有限JSON值:'+value,'INCONCLUSIVE')
    try:return json.loads(data,object_pairs_hook=pairs,parse_constant=constant)
    except (ValueError,UnicodeError) as error:
        if isinstance(error,CheckError):raise
        raise CheckError('不完整JSON原件','INCONCLUSIVE') from error

def encoded_hash(value):
    return hashlib.sha256((json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()).hexdigest()

def validate_identity(i,uid,gid):
    require(type(i['pid']) is int and i['pid']>0 and type(i['verified']) is bool,'完整原生identity','INCONCLUSIVE')
    require(all(isinstance(i[k],list) and len(i[k])==4 and all(type(v) is int for v in i[k]) for k in ('uid','gid')),'UID/GID原件结构','INCONCLUSIVE')
    require(set(i['capabilities'])==CAPS and all(isinstance(v,str) and re.fullmatch('[0-9a-f]{16}',v) for v in i['capabilities'].values()),'五cap原件结构','INCONCLUSIVE')
    eligible=uid>0 and gid>0 and i['uid']==[uid]*4 and i['gid']==[gid]*4 and i['supplementary_group_count']==0 and i['no_new_privs']==1 and all(v=='0000000000000000' for v in i['capabilities'].values())
    require(eligible,'原件证明当前进程不满足UID/GID/caps/groups/NNP资格','BLOCKED')
    require(i['verified'] is True,'identity verified与原始字段不一致','INCONCLUSIVE')

def validate_metadata(m):
    require(set(m)==META_KEYS,'完整metadata')
    for k in ('dev','ino','mode','nlink','size'):
        require(isinstance(m[k],str) and re.fullmatch(r'0|[1-9][0-9]*',m[k]) is not None,'整数codec')
    require(all(type(m[k]) is int and m[k]>0 for k in ('uid','gid')),'非零owner')
    require(stat.S_ISDIR(int(m['mode'])) or (stat.S_ISREG(int(m['mode'])) and m['nlink']=='1'),'类型/单链接')
    for k in ('atime','mtime','ctime'):
        t=m[k]; require(isinstance(t,list) and len(t)==2 and all(isinstance(v,str) for v in t),'精确时间结构')
        require(re.fullmatch(r'0|-?[1-9][0-9]*',t[0]) is not None and re.fullmatch(r'0|[1-9][0-9]*',t[1]) is not None and int(t[1])<10**9,'精确时间值')

def validate_mount(record, entries, proof):
    status,reason=validate_native(record);require(status=='PASS',reason,status)
    rows=[e for e in entries if e['id']==record['statx_legacy']['mount_id']]
    require(len(rows)==1,'legacy映射唯一')
    e=rows[0];legacy=record['statx_legacy']
    require(e['type']=='ext4' and e['root']=='/' and e['point']==proof['mountpoint'] and e['source']==proof['loop'],'native ext4完整mount根')
    require(e['device']==f"{legacy['dev_major']}:{legacy['dev_minor']}",'device绑定')
    require({'rw','relatime'}<=set(e['mount_options']),'rw relatime')
    require(set(e['mount_options'])<={'rw','relatime','nosuid','nodev','noexec','seclabel'},'未知mount选项')
    require(set(e['super_options'])<={'rw','data=ordered','errors=remount-ro','seclabel'},'未知super选项')
    require(not e['optional'] or all(re.fullmatch(r'(shared|master|propagate_from):[1-9][0-9]*|unbindable',x) for x in e['optional']),'未知拓扑')
    require(tuple(proof['requested_options'])==OPTIONS and proof['mount_returncode']==0,'固定fixture请求回执')
    require(proof['scope']=='owned_qualification_fixture' and proof['production_runtime_match']=='NOT_IMPLEMENTED_UNSUPPORTED','不以fixture推断生产匹配')
    return e

def witness(r):
    require(validate_native(r)[0]=='PASS','非法native witness')
    return {'profile':PROFILE,'uuid':r['fsuuid']['hex'],'type':r['fid_unique']['handle_type'],'byte_count':r['fid_unique']['handle_bytes'],'hex':r['fid_unique']['hex']}

def validate_batch(batch,cases,uid,gid,proof,lookup=False):
    try:return _validate_batch(batch,cases,uid,gid,proof,lookup)
    except CheckError:raise
    except (KeyError,TypeError,ValueError) as error:raise CheckError('native batch原件不完整或codec非法','INCONCLUSIVE') from error

def _validate_batch(batch,cases,uid,gid,proof,lookup):
    require(type(batch['returncode']) is int and batch['reaped'] is True,'native退出/reap原件','INCONCLUSIVE')
    records=batch['records'];ids=[r for r in records if r['kind']=='process-identity']
    require(len(ids)==1,'唯一进程原件','INCONCLUSIVE');i=ids[0];validate_identity(i,uid,gid)
    if not lookup:
        outcomes=[validate_native(r) for r in records if r['kind']=='native-observation']
        for wanted in ('FAIL','BLOCKED','INCONCLUSIVE'):
            for status,reason in outcomes:
                if status==wanted:raise CheckError(reason,status)
    if batch['returncode']!=0:
        errors=[r for r in records if r['kind'].endswith('-error')]
        unavailable={errno.EOPNOTSUPP,errno.ENOTTY,errno.EPERM,errno.EACCES,errno.ENOSYS,errno.EOVERFLOW}
        if any(type(r.get('errno')) is int and r['errno'] in unavailable for r in errors):raise CheckError('实际open/原生API不可用:'+str(errors),'BLOCKED')
        if any(r['kind']=='object-guard-error' for r in errors) or any(r['kind']=='path-guard' and (r['same_object'] is False or r['root_stable'] is False) for r in records):raise CheckError('原始对象/path守卫确认拒绝','FAIL')
        raise CheckError('非零native退出但缺少可归因原件:'+str(batch['returncode']),'INCONCLUSIVE')
    require(batch['mountinfo_before']==batch['mountinfo_after'],'当次mount绑定不变')
    require(not any(r['kind'].endswith('-error') for r in records),'native guard拒绝')
    roots=[r for r in records if r['kind']=='root-closed'];require(len(roots)==1 and roots[0]['rc']==0,'root关闭','INCONCLUSIVE')
    require({r['object'] for r in records if r['kind']=='native-observation'}=={r[0] for r in cases},'精确native对象集合','INCONCLUSIVE')
    result={};mounts=set();uuids=set()
    for label,relative,kind in cases:
        rows=[r for r in records if r['kind']=='native-observation' and r['object']==label]
        require([r['iteration'] for r in rows]==([0] if lookup else [0,1]),'完整前后观测','INCONCLUSIVE')
        for row in rows:
            validate_metadata(row['before']);validate_metadata(row['after'])
            require(row['pid']==i['pid'] and row['fd']==rows[0]['fd'],'同PID/FD')
            require(row['before']['uid']==uid and row['before']['gid']==gid and stat.S_ISDIR(int(row['before']['mode']))==(kind=='directory'),'对象owner/kind')
            if not lookup:
                validate_mount(row,batch['mountinfo_before'],proof);mounts.add(row['statx_unique']['mount_id']);uuids.add(row['fsuuid']['hex'])
        guard=[r for r in records if r['kind']=='path-guard' and r['object']==label]
        require(len(guard)==1 and guard[0]['same_object'] is True and guard[0]['root_stable'] is True,'当前path/root不变')
        closed=[r for r in records if r['kind']=='fd-closed' and r['object']==label]
        require(len(closed)==1 and closed[0]['rc']==0,'entry已关闭')
        if not lookup:
            require(witness(rows[0])==witness(rows[1]) and rows[0]['after']==rows[1]['before'] and rows[0]['statx_unique']['mount_id']==rows[1]['statx_unique']['mount_id'],'同FD跨读取身份不变')
            reads=[r for r in records if r['kind']=='content-read' and r['object']==label];require(len(reads)==1,'同FD内容读取')
            read=reads[0];require(read['pid']==i['pid'] and read['fd']==rows[0]['fd'] and read['rc']==0 and read['bytes']<=1048576 and len(read['hex'])==2*read['bytes'],'内容来源与预算')
            data=bytes.fromhex(read['hex']);require(kind=='directory' or len(data)==int(rows[0]['before']['size']),'完整file bytes')
            result[label]={'native':rows[0],'witness':witness(rows[0]),'metadata':rows[0]['before'],'btime':rows[0]['statx_unique']['btime'],'content_sha256':hashlib.sha256(data).hexdigest(),'kind':kind}
    if not lookup:require(len(mounts)==1 and len(uuids)==1,'anchor/entry同mount/UUID')
    return result

def validate_fd_reuse(batch,label):
    """负例只接受已实际施加且在同数字FD观察到换对象的明确拒绝。"""
    rows=batch.get('records',[]);events=[r for r in rows if r.get('kind')=='fd-reuse-injection']
    require(bool(events),'FD复用注入未发生','BLOCKED');require(len(events)==1,'FD复用必须唯一','INCONCLUSIVE');event=events[0]
    require(event.get('test_only') is True and event.get('applied') is True and event.get('object')==label,'FD复用施加未成功/对象不符','BLOCKED')
    old,new=event.get('old_fd'),event.get('new_fd')
    dup_ok=(event.get('dup_attempted') is False and event.get('open_rc')==old and event.get('dup_rc')==-2) or (event.get('dup_attempted') is True and event.get('open_rc')!=old and event.get('dup_rc')==old)
    require(type(old) is int and type(new) is int and old>=0 and new==old and event.get('close_rc')==0 and type(event.get('open_rc')) is int and event['open_rc']>=0 and dup_ok and all(event.get(k)==0 for k in ('close_errno','open_errno','dup_errno')),'FD复用close/open/dup回执不足','BLOCKED')
    identities=[r for r in rows if r.get('kind')=='process-identity']
    require(len(identities)==1 and identities[0].get('pid')==event.get('pid') and identities[0].get('verified') is True,'注入实际进程绑定不足','INCONCLUSIVE')
    require(not any(r.get('kind','').endswith('-error') for r in rows),'注入链存在操作失败','BLOCKED')
    observations=[r for r in rows if r.get('kind')=='native-observation' and r.get('object')==label]
    require([r['iteration'] for r in observations]==[0,1],'注入前后观测缺失','INCONCLUSIVE');before,after=observations
    require(all(r['pid']==event.get('pid') and r['fd']==old and r['before_rc']==0 and r['after_rc']==0 for r in observations),'注入PID/FD或fstat原件不符','INCONCLUSIVE')
    require(rows.index(before)<rows.index(event)<rows.index(after),'注入不在两次实际观测之间','INCONCLUSIVE')
    require(validate_native(before)[0]=='PASS','注入前不是有效provider对象','BLOCKED')
    require(any(before['before'][k]!=after['before'][k] for k in ('dev','ino','mode')),'注入未证明换对象','FAIL')
    guards=[r for r in rows if r.get('kind')=='path-guard' and r.get('object')==label]
    require(len(guards)==1 and guards[0].get('same_object') is False and guards[0].get('root_stable') is True and batch.get('returncode')==70,'实际换对象未由预期path/identity守卫拒绝','FAIL')
    require(batch.get('reaped') is True and any(r.get('kind')=='fd-closed' and r.get('fd')==old and r.get('rc')==0 for r in rows) and any(r.get('kind')=='root-closed' and r.get('rc')==0 for r in rows),'注入后未自然关闭/reap','INCONCLUSIVE')
    return {'injection':event,'actual_object_changed':True,'guard':guards[0],'returncode':70}

def cold_compare(before,middle,after):
    from support import diff_entries
    expected={'fs-root','control','provider'}
    for snapshot in (before,middle,after):
        require(set(snapshot)==expected,'冷读缺少实际FS root或测试组','INCONCLUSIVE')
        root=snapshot['fs-root']['entries'];require(set(root)=={'.'} and {'xattrs','inode_flags'}<=set(root['.']),'FS root完整观察缺失','INCONCLUSIVE')
    result={group:diff_entries(before[group]['entries'],after[group]['entries']) for group in expected}
    for group,delta in result.items():require(not delta['non_atime'],'冷读发生非atime源修改:'+group)
    require(not any(diff_entries(before['provider']['entries'],middle['provider']['entries']).values()),'control阶段provider已变')
    return result

def decode_frozen(data,sidecar,root,cases,uid,gid):
    digest=hashlib.sha256(data).hexdigest()
    require(sidecar==bytes(digest+'\n','ascii'),'persisted sidecar不匹配','INCONCLUSIVE')
    value=strict_json(data)
    require(isinstance(value,dict) and set(value)=={'schema_version','root','uid','gid','cases','all_native_children_reaped','mount_proof','observations','batch'},'完整冻结文档字段','INCONCLUSIVE')
    require(value['schema_version']==FROZEN_SCHEMA and value['root']==root and value['uid']==uid and value['gid']==gid and value['cases']==[list(v) for v in cases] and value['all_native_children_reaped'] is True,'冻结source/身份/进程绑定','INCONCLUSIVE')
    require(isinstance(value['mount_proof'],dict) and value['mount_proof'].get('mountpoint')==os.path.dirname(root),'冻结root/mount关系不符','INCONCLUSIVE')
    observations=value['observations'];require(isinstance(observations,dict) and bool(observations) and set(observations)=={r[0] for r in cases},'精确非空冻结对象集合','INCONCLUSIVE')
    decoded=validate_batch(value['batch'],cases,uid,gid,value['mount_proof'])
    require(observations==decoded,'磁盘冻结metadata/witness/native与原批次不一致','INCONCLUSIVE')
    return value,digest

def consume_frozen(data,sidecar,current_batch,current_proof,root,cases,uid,gid,consumer_pid):
    previous,digest=decode_frozen(data,sidecar,root,cases,uid,gid)
    require(isinstance(current_proof,dict) and current_proof.get('mountpoint')==os.path.dirname(root),'当前root/mount关系不符','INCONCLUSIVE')
    current=validate_batch(current_batch,cases,uid,gid,current_proof)
    old_pid=previous['batch']['records'][0]['pid'];new_pid=current_batch['records'][0]['pid']
    require(type(consumer_pid) is int and consumer_pid>0 and len({old_pid,new_pid,consumer_pid})==3,'实际新consumer/native进程边界','INCONCLUSIVE')
    comparison=compare(previous['observations'],current);require(comparison=='equal','新进程从磁盘消费后发现source_changed')
    return {'schema_version':'fs-native-ext4-consume-receipt/v1','persisted_sha256':digest,'consumer_pid':consumer_pid,
            'previous_native_pid':old_pid,'current_native_pid':new_pid,'decoded_objects':sorted(previous['observations']),
            'current_batch_sha256':encoded_hash(current_batch),'comparison':comparison,'expected_source':'strict_disk_observations'}

def compare(before,after):
    """资格消费者模型；不冒称生产Fs/service闭包。"""
    require(set(before)==set(after),'entry集合')
    for key,a in before.items():
        b=after[key]
        if a['witness']!=b['witness'] or a['kind']!=b['kind']:return 'source_changed'
        keys=('dev','ino','mode','nlink','uid','gid') if a['kind']=='directory' else tuple(k for k in META_KEYS if k!='atime')
        if any(a['metadata'][k]!=b['metadata'][k] for k in keys):return 'source_changed'
        if a['kind']=='file' and (a['btime']!=b['btime'] or a['content_sha256']!=b['content_sha256']):return 'source_changed'
    return 'equal'

def replacement(before,after,receipt,label):
    a,b=before[label],after[label]
    require(receipt['absence_errno']==errno.ENOENT and receipt['all_old_native_children_reaped'] is True and receipt['old_object_fds_open']==0,'旧FD/进程已关且真实ENOENT')
    require(receipt['same_mode'] is True and receipt['same_final_members'] is True,'真实同mode/member集合')
    require(a['witness']['uuid']==b['witness']['uuid'] and a['witness']['hex']!=b['witness']['hex'],'真实同UUID不同FID')
    if a['kind']=='file':require(receipt['same_content'] is True and a['content_sha256']==b['content_sha256'],'同内容重建')
    return all(a['metadata'][k]==b['metadata'][k] for k in ('dev','ino'))

def equal_stat_control(before,after,receipt,label):
    require(replacement(before,after,receipt,label),'Q07必须有实际same-inode receipt')
    a=copy.deepcopy(before[label]);b=copy.deepcopy(a);b['witness']=copy.deepcopy(after[label]['witness'])
    require(compare({label:a},{label:b})=='source_changed','FID独立拒绝')
    return {'origin':'synthetic_equal_stat_time_from_actual_Q06_native','before':a,'after':b,'result':'source_changed','production_Fs_service':'NOT_RUN','real_all_times_equal':False}

def lifecycle(receipt):
    require(receipt['all_native_children_reaped'] is True and receipt['open_fixture_fds']==0,'生命周期开始前已关闭')
    require(all(receipt[k]==0 for k in ('unmount_rc','detached_rc','reattach_rc','mount_rc')),'完整卸载/分离/重新挂载')
    require(receipt['image_sha256_after_detach']==receipt['image_sha256_before_reattach'],'分离期image字节不变')
    require(receipt['mountpoint_before']==receipt['mountpoint_after'] and receipt['image_inode_before']==receipt['image_inode_after'],'同image/绝对根')
    require(receipt['cycles']==1 and receipt['os_reboot']=='NOT_RUN','一次FS生命周期不称reboot')
    return True

def fault_controls(native):
    cases=[]
    for field in ('fsuuid','fid_unique','statx_unique','statx_legacy'):
        for code in (errno.EOPNOTSUPP,errno.ENOTTY,errno.EPERM,errno.ENOSYS,errno.EOVERFLOW):
            v=copy.deepcopy(native);v[field]['rc']=-1;v[field]['errno']=code;cases.append((f'{field}-errno-{code}',v))
    real_mount=native['statx_unique']['mount_id'];wrong_mount=str(int(real_mount)%(2**64-1)+1)
    require(wrong_mount!=real_mount and 0<int(wrong_mount)<2**64,'mount ID注入必须实际不同','FAIL')
    for field,key,value in [('fsuuid','hex','0'*32),('fsuuid','length',15),('fsuuid','hex','A'*32),('fid_unique','handle_type',2),('fid_unique','handle_type',248),('fid_unique','handle_bytes',7),('fid_unique','hex','ff'*9),('statx_unique','mask',0x17ff),('statx_legacy','mask',0x7ff),('statx_unique','mount_id',wrong_mount),('statx_unique','requested_mask',0x5fff),('statx_unique','attributes_mask','0'),('statx_unique','attributes','2097152')]:
        v=copy.deepcopy(native);v[field][key]=value;cases.append((field+'-'+key+'-'+str(value),v))
    results=[]
    for name,v in cases:
        status,reason=validate_native(v);require(status!='PASS','synthetic错误被接受:'+name,'FAIL');results.append({'name':name,'origin':'synthetic_errno_or_field_injection','status':'PASS','observed_rejection':status,'reason':reason,'native_attempts_added':0})
        if v['statx_unique']['mount_id']!=real_mount:results[-1].update(field='statx_unique.mount_id',original_value=real_mount,injected_value=v['statx_unique']['mount_id'])
    return results

def aggregate(statuses):
    values=list(statuses)
    return 'FAIL' if 'FAIL' in values else 'PASS' if values and all(v=='PASS' for v in values) else 'BLOCKED'


def validate_pass_payloads(rows,docs,files,events):
    """只对宣称PASS的场景重新消费现有资格producer原件，不补造未运行观测。"""
    from support import diff_entries
    passed={key for key,row in rows.items() if row['status']=='PASS'}
    if not passed-{'EX4-Q12'}:return
    require('EX4-Q01' in passed,'后续PASS缺有效Q01上下文','INCONCLUSIVE')
    initial=docs['mount/mount-native.json'];latest=docs.get('mount/lifecycle-mount.json',initial)
    root=initial['mountpoint'];anchor_batch=docs['native/identity-native.json']
    ident=anchor_batch['records'][0];uid,gid=ident['uid'][0],ident['gid'][0]
    validate_identity(ident,uid,gid)
    def one(label):
        values=tuple(r for r in CASES if r[0]==label);require(len(values)==1,'未知单项case','INCONCLUSIVE');return values
    def positive(name,cases,proof=initial,lookup=False):
        b=docs[name];mode='lookup' if lookup else 'provider'
        require(b.get('mode')==mode and b['records'][0]['kind']=='process-identity' and b['records'][-1]['kind']=='root-closed','native mode/边界不完整','INCONCLUSIVE')
        allowed={'process-identity','native-observation','path-guard','fd-closed','root-closed'}|({'content-read'} if not lookup else set())
        require(len(b['records'])==2+len(cases)*(3 if lookup else 5) and all(r['kind'] in allowed for r in b['records']),'native记录集合不完整','INCONCLUSIVE')
        require(all(r['mode']==mode for r in b['records'] if r['kind']=='native-observation'),'native观察mode不符','INCONCLUSIVE')
        return validate_batch(b,cases,uid,gid,proof,lookup)
    def action(name,operation):
        a=docs[name];i=a['identity']
        require(a['operation']==operation and type(a['pid']) is int and a['pid']>0 and a['all_old_native_children_reaped'] is True,'action身份/operation/reap缺失','INCONCLUSIVE')
        require(i['Uid'].split()==[str(uid)]*4 and i['Gid'].split()==[str(gid)]*4 and i['Groups']=='' and i['NoNewPrivs']=='1' and all(i[k]=='0000000000000000' for k in CAPS),'action实际身份不合格','BLOCKED')
        return a
    def stat_record(v):
        require(isinstance(v,dict) and set(v)==STAT_FIELDS and all(type(x) is int for x in v.values()),'完整observer/mutator stat原件','INCONCLUSIVE')
    def stat_matches(v,observation):
        stat_record(v);m=observation['metadata']
        require(all(v[k]==int(m[k]) for k in ('dev','ino','mode','uid','gid','nlink','size')) and all(v[k+'_ns']==int(m[k][0])*10**9+int(m[k][1]) for k in ('mtime','ctime')),'mutator与native前后stat断开','INCONCLUSIVE')
    def absent(name,expected):
        a=action(name,'absent');stat_matches(a['ancestor'],expected)
        require(a['missing']==[{'suffix':'missing','errno':errno.ENOENT},{'suffix':'missing/deeper','errno':errno.ENOENT}] and a['absent_incarnation'] is None,'absent suffix完整拒绝原件','INCONCLUSIVE')
        return a
    def command_ok(label,code=0):
        values=[e for e in events if e.get('event')=='child-exited' and e.get('label')==label]
        require(len(values)==1 and values[0]['returncode']==code and values[0]['reaped'] is True,'命令原始结果不符:'+label,'INCONCLUSIVE')
        return values[0]
    fsroot=positive('native/identity-native.json',(('fs-root','.','directory'),))['fs-root']
    image=docs['fixture-image.json'];features=docs['features.json'];stat_record(image['identity'])
    require(image['bytes']==67108864 and image['identity']['size']==67108864 and re.fullmatch('[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}',image['uuid_requested']) and image['uuid_requested'].replace('-','')==fsroot['witness']['uuid'],'实际fixture image/UUID原件不完整','INCONCLUSIVE')
    require(isinstance(features['raw'],str) and 'Filesystem features:' in features['raw'] and features['requested_mkfs']==['-F','-U',image['uuid_requested'],'-E','lazy_itable_init=0,lazy_journal_init=0'] and features['production_inference'] is False,'实际mkfs/features原件不完整','INCONCLUSIVE')
    for label in ('mkfs-version','mount-version','loop-version','mkfs','loop-attach','ext4-superblock','mount-native'):command_ok(label)
    require(files['commands/loop-attach.stdout'].decode().strip()==initial['loop'],'loop attach与mount proof断开','INCONCLUSIVE')
    require(initial.get('entry')==validate_mount(fsroot['native'],anchor_batch['mountinfo_before'],initial),'mount原件与实际FD断开','INCONCLUSIVE')
    if 'EX4-Q02' in passed or 'EX4-Q03' in passed:
        cold=positive('native/cold-provider.json',CASES)
        require(cold['group-anchor']['witness']['uuid']==fsroot['witness']['uuid'] and cold['group-anchor']['native']['statx_unique']['mount_id']==fsroot['native']['statx_unique']['mount_id'],'FS root/组绑定不符')
    if 'EX4-Q02' in passed:
        a=absent('actions/initial-absent.json',cold['ancestor']);detail=rows['EX4-Q02']['detail']
        require(detail['case_count']==len(CASES)+1 and detail['same_fd_bytes'] is True and detail['absent']==a,'Q02 payload断开','INCONCLUSIVE')
    if 'EX4-Q03' in passed:
        positive('native/cold-control.json',CASES,lookup=True);snapshots={}
        for stage in ('cold-before','cold-control-after','cold-provider-after'):
            snapshots[stage]={}
            for group in ('fs-root','control','provider'):
                v=docs[f'snapshots/{stage}-{group}.json'];expected={'.'} if group=='fs-root' else {'.' if relative=='.' else './'+relative for _,relative,_ in CASES}
                for sample in (v['first'],v['repeat']):
                    require(set(sample)=={'entries','payload_bytes_observed','objects'} and set(sample['entries'])==expected and sample['objects']==len(expected) and type(sample['payload_bytes_observed']) is int and 0<=sample['payload_bytes_observed']<=1048576,'完整cold observer对象/预算','INCONCLUSIVE')
                    for entry in sample['entries'].values():
                        stat_record({k:v for k,v in entry.items() if k in STAT_FIELDS})
                        require(set(entry)==STAT_FIELDS|{'xattrs','inode_flags'}|({'sha256'} if stat.S_ISREG(entry['mode']) else set()) and entry['uid']==uid and entry['gid']==gid and type(entry['inode_flags']) is int and isinstance(entry['xattrs'],dict),'observer完整字段','INCONCLUSIVE')
                        require(stat.S_ISDIR(entry['mode']) or (stat.S_ISREG(entry['mode']) and entry['nlink']==1),'observer类型/单链接原件','INCONCLUSIVE')
                        require(all(isinstance(k,str) and isinstance(v,str) and re.fullmatch('([0-9a-f]{2})*',v) is not None for k,v in entry['xattrs'].items()),'observer xattr codec','INCONCLUSIVE')
                        if stat.S_ISREG(entry['mode']):require(re.fullmatch('[0-9a-f]{64}',entry['sha256']) is not None,'observer内容hash','INCONCLUSIVE')
                    require(sample['entries']['.']['xattrs'].get('trusted.boardroom.ext4qual')==b'observer-visible'.hex(),'observer可读xattr标记','INCONCLUSIVE')
                    require(sample['payload_bytes_observed']==sum((v['size'] if stat.S_ISREG(v['mode']) else 0)+sum(len(bytes.fromhex(x)) for x in v['xattrs'].values()) for v in sample['entries'].values()),'observer累计payload与原件断开','INCONCLUSIVE')
                delta=diff_entries(v['first']['entries'],v['repeat']['entries']);require(v['observer_only']==delta and not any(delta.values()),'observer-only原件不成立')
                snapshots[stage][group]=v['repeat']
            require(sum(v['payload_bytes_observed'] for v in snapshots[stage].values())<=1048576,'cold累计payload预算','INCONCLUSIVE')
        expected=cold_compare(*(snapshots[k] for k in ('cold-before','cold-control-after','cold-provider-after')))
        require(docs['cold-comparison.json']==expected and rows['EX4-Q03']['detail']['provider_primed'] is False,'cold结果与原件断开','INCONCLUSIVE')
    if 'EX4-Q04' in passed:
        detail=rows['EX4-Q04']['detail'];require(set(detail)=={'file-root','directory-root','empty-dir'},'mutation完整对象集合','INCONCLUSIVE')
        for label in detail:
            before=positive('native/mutation-before-'+label+'.json',one(label));after=positive('native/mutation-after-'+label+'.json',one(label));a=action('actions/mutation-'+label+'.json','mutate')
            stat_matches(a['before'],before[label]);stat_matches(a['after'],after[label])
            require(a['chmod_restore'] is True and a['rename_out_back'] is True and a['write_truncate_restore' if label=='file-root' else 'temporary_member_removed'] is True,'mutation实际操作原件不完整','INCONCLUSIVE')
            expected='source_changed' if label=='file-root' else 'equal'
            require(before[label]['witness']==after[label]['witness'] and compare(before,after)==expected and detail[label]=={'action':a,'comparison':expected},'mutation PASS判据不成立')
    def recreation(v):
        require(set(v)=={'before','after','receipt','inode_reused','native_before_ref','native_after_ref'} and len(v['before'])==1 and set(v['before'])==set(v['after']),'recreation完整原件','INCONCLUSIVE')
        label=next(iter(v['before']));require(label in ('file-root','empty-dir'),'recreation对象范围','INCONCLUSIVE')
        before=positive(v['native_before_ref'],one(label));after=positive(v['native_after_ref'],one(label))
        suffix=v['native_before_ref'].removeprefix('native/replace-before-').removesuffix('.json');a=action('actions/replace-'+suffix+'.json','replace')
        require(v['before']==before and v['after']==after and v['receipt']==a,'recreation与native/action原件断开','INCONCLUSIVE')
        stat_matches(a['before'],before[label]);stat_matches(a['after'],after[label])
        require(a['before_delete_source_fds']==[],'真实删除前source FD未空')
        reused=replacement(before,after,a,label);require(v['inode_reused'] is reused,'recreation复用结果断开','INCONCLUSIVE');return label,reused
    if 'EX4-Q05' in passed:
        for label in ('file-root','empty-dir'):require(recreation(docs['recreation/'+label+'.json'])[0]==label,'Q05对象不符','INCONCLUSIVE')
        require(rows['EX4-Q05']['detail']['receipts']==['recreation/file-root.json','recreation/empty-dir.json'] and rows['EX4-Q05']['detail']['no_old_native_processes'] is True,'Q05 payload不完整','INCONCLUSIVE')
    if 'EX4-Q06' in passed or 'EX4-Q07' in passed:
        reuse=docs['inode-reuse.json'];require(set(reuse)=={'file-root','empty-dir'},'完整file/dir复用原件','INCONCLUSIVE')
        for label,v in reuse.items():require(recreation(v)==(label,True),'Q06实际same-inode原件不成立')
    if 'EX4-Q06' in passed:
        budget=docs['inode-reuse-budget.json'];detail=rows['EX4-Q06']['detail']
        require(type(budget['additional_attempts']) is int and 0<=budget['additional_attempts']<=32 and type(budget['elapsed_seconds']) in (int,float) and 0<=budget['elapsed_seconds']<=2 and set(budget['reused'])=={'file-root','empty-dir'} and budget['limits']=={'attempts':32,'seconds':2} and detail['additional_attempts']==budget['additional_attempts'],'实际复用预算原件不完整','INCONCLUSIVE')
    if 'EX4-Q07' in passed:
        expected={'native_sources':'inode-reuse.json','cases':{label:equal_stat_control(v['before'],v['after'],v['receipt'],label) for label,v in reuse.items()}}
        require(docs['synthetic-equal-stat-time.json']==expected and rows['EX4-Q07']['detail']['production_Fs_service']=='NOT_RUN','Q07来源/完整payload断开','INCONCLUSIVE')
    def consume(name,proof):
        a=action(name,'consume');require(a['native_reaped'] is True,'consumer native未reap','INCONCLUSIVE')
        receipt=consume_frozen(files['persisted-observations.json'],files['persisted-observations.sha256'],a['batch'],proof,root+'/provider',CASES,uid,gid,a['pid'])
        require(a['receipt']==receipt,'consumer完整回执与磁盘/current batch断开','INCONCLUSIVE');return receipt
    if 'EX4-Q08' in passed or 'EX4-Q09' in passed:
        frozen,_=decode_frozen(files['persisted-observations.json'],files['persisted-observations.sha256'],root+'/provider',CASES,uid,gid)
        require(frozen['batch']==docs['native/persist-source.json'] and frozen['mount_proof']==initial,'persisted与实际保存前batch断开','INCONCLUSIVE');positive('native/persist-source.json',CASES)
    if 'EX4-Q08' in passed:require(rows['EX4-Q08']['detail']==consume('actions/new-process-consume.json',initial),'Q08 payload断开','INCONCLUSIVE')
    if 'EX4-Q09' in passed:
        v=docs['fs-lifecycle.json'];lifecycle(v)
        require(v['source_fds_before_unmount']==[] and v['mountpoint_before']==v['mountpoint_after']==root and all(isinstance(v[k],list) and len(v[k])==2 and all(type(n) is int and n>0 for n in v[k]) for k in ('image_inode_before','image_inode_after')) and re.fullmatch('[0-9a-f]{64}',v['image_sha256_after_detach']),'FS生命周期完整原件','INCONCLUSIVE')
        for label in ('lifecycle-unmount','lifecycle-loop-detach','lifecycle-detach-proof','lifecycle-reattach','lifecycle-mount'):command_ok(label)
        require(not files['commands/lifecycle-detach-proof.stdout'].strip() and files['commands/lifecycle-reattach.stdout'].decode().strip()==latest['loop'],'loop分离/重挂原件不符','INCONCLUSIVE')
        require(v['fresh_consume']==consume('actions/post-lifecycle-consume.json',latest) and rows['EX4-Q09']['detail']==v,'Q09消费/summary断开','INCONCLUSIVE')
    def negative(name,label,kinds,code):
        b=docs[name];records=b['records'];ids=[r for r in records if r.get('kind')=='process-identity']
        require(len(ids)==1 and records[0]==ids[0] and b['returncode']==code and b['reaped'] is True,'负例process/退出原件不完整','INCONCLUSIVE');validate_identity(ids[0],uid,gid)
        errors=[r for r in records if r.get('kind') in kinds and r.get('object')==label]
        require(len(errors)==1 and records[-1].get('kind')=='root-closed' and records[-1].get('rc')==0,'负例预期拒绝/关闭原件不完整','INCONCLUSIVE')
        require(len(records)==(3 if errors[0]['kind']=='open-error' else 4),'负例记录集合不完整','INCONCLUSIVE')
        if errors[0]['kind']=='object-guard-error':require(records[-2].get('kind')=='fd-closed' and records[-2].get('object')==label and records[-2].get('rc')==0,'负例entry未关闭','INCONCLUSIVE')
        return errors[0]
    def barrier(name,operation):
        a=action(name,operation);r=a['records'];require(a['native_reaped'] is True and a['real_barrier_observed'] is True and r[0]['kind']=='process-identity','实际barrier/process原件','INCONCLUSIVE');validate_identity(r[0],uid,gid)
        windows=[v for v in r if v.get('kind')=='race-window'];observations=[v for v in r if v.get('kind')=='native-observation']
        require(len(windows)==1 and windows[0].get('test_only') is True and observations and observations[0]['iteration']==0 and observations[0]['object']=='file-root' and observations[0]['pid']==r[0]['pid'] and r.index(observations[0])<r.index(windows[0]),'barrier与实际native观测断开','INCONCLUSIVE')
        status,reason=validate_native(observations[0]);require(status=='PASS',reason,status)
        return a,r,observations
    if 'EX4-Q10' in passed:
        detail=rows['EX4-Q10']['detail']
        for label in ('symlink','hardlink','fifo','foreign-owner'):
            name='native/reject-'+label+'.json';code=69 if label=='symlink' else 70
            if label=='foreign-owner' and type(docs[name]['returncode']) is int and docs[name]['returncode']==69:
                code=69;error=negative(name,label,{'open-error'},code)
                require(type(error.get('errno')) is int and error['errno'] in (errno.EACCES,errno.EPERM),'foreign-owner open未证明权限拒绝','INCONCLUSIVE')
            else:error=negative(name,label,{'open-error'} if label=='symlink' else {'object-guard-error'},code)
            if label=='symlink':require(error['errno']==errno.ELOOP,'symlink未明确拒绝','INCONCLUSIVE')
            require(detail[label]=={'returncode':code,'native':name},'Q10拒绝summary断开','INCONCLUSIVE')
        require(negative('native/reject-cross-mount.json','cross',{'open-error'},69)['errno']==errno.EXDEV,'cross mount未明确EXDEV','INCONCLUSIVE')
        require(detail['fd_reuse']==validate_fd_reuse(docs['native/reject-fd-reuse.json'],'file-root'),'FD复用summary断开','INCONCLUSIVE')
        a,r,observations=barrier('actions/path-race.json','path-race')
        require(a['real_path_replacement'] is True and a['native_returncode']==70 and len(r)==8 and [v['iteration'] for v in observations]==[0,1] and all(v['pid']==r[0]['pid'] and v['fd']==observations[0]['fd'] for v in observations) and any(v.get('kind')=='path-guard' and v.get('object')=='file-root' and v.get('same_object') is False for v in r) and r[-1].get('kind')=='root-closed' and r[-1].get('rc')==0,'真实path race拒绝/关闭原件不完整','INCONCLUSIVE')
        before=positive('native/ancestor-before.json',one('ancestor'),latest);after=positive('native/ancestor-after.json',one('ancestor'),latest);a=action('actions/ancestor-replace.json','replace')
        stat_matches(a['before'],before['ancestor']);stat_matches(a['after'],after['ancestor']);require(a['absence_errno']==errno.ENOENT and a['old_object_fds_open']==0 and a['before_delete_source_fds']==[] and compare(before,after)=='source_changed','ancestor真实重建/拒绝原件不完整','INCONCLUSIVE')
        require(detail['absent']==absent('actions/ancestor-absent.json',after['ancestor']),'ancestor absent summary断开','INCONCLUSIVE')
    if 'EX4-Q11' in passed:
        native=positive('native/fault-control-source.json',one('file-root'),latest)['file-root']['native'];injected=fault_controls(native)
        require(docs['fault-injections.json']==injected,'完整故障控制与实际源断开','INCONCLUSIVE')
        a,r,_=barrier('actions/cancel-native.json','cancel-native');require(a['native_returncode']==-15 and a['real_path_replacement'] is False and len(r)==3,'实际native取消/reap原件不完整','INCONCLUSIVE')
        timeout=[e for e in events if e.get('event')=='child-exited' and e.get('label')=='synthetic-timeout-child'];starts=[e for e in events if e.get('event')=='child-start' and e.get('label')=='synthetic-timeout-child']
        require(len(timeout)==len(starts)==1 and timeout[0]['timed_out'] is True and timeout[0]['reaped'] is True and timeout[0]['returncode'] in (-15,-9) and 0<starts[0]['timeout_seconds']<=.02,'实际timeout/reap原件不完整','INCONCLUSIVE')
        detail=rows['EX4-Q11']['detail'];require(detail['synthetic_errno_field_cases']==len(injected) and detail['native_resize_retries']==0 and detail['successful_Fs'] is False,'Q11 payload不完整','INCONCLUSIVE')

def validate_result_bundle(files,expected_candidate,expected_binary_sha256):
    """fixture封存和hosted导入共用的严格原件消费者；exit0不是输入门槛。"""
    try:return _validate_result_bundle(files,expected_candidate,expected_binary_sha256)
    except CheckError:raise
    except (KeyError,TypeError,ValueError,UnicodeError,IndexError,AttributeError) as error:raise CheckError('资格回执结构/原件不完整','INCONCLUSIVE') from error

def _validate_result_bundle(files,expected_candidate,expected_binary_sha256):
    require(BASE_ORIGINALS|{'SHA256SUMS'}<=set(files),'缺少资格基本原件','INCONCLUSIVE')
    manifest={}
    for line in files['SHA256SUMS'].decode('ascii').splitlines():
        match=re.fullmatch(r'([0-9a-f]{64})  ([^\r\n]+)',line);require(match is not None,'manifest行非法','INCONCLUSIVE')
        digest,name=match.groups()
        require(name not in manifest and not name.startswith('/') and all(p not in ('','..','.') for p in name.split('/')),'manifest重复/非法路径','INCONCLUSIVE');manifest[name]=digest
    require(set(manifest)==set(files)-{'SHA256SUMS'},'manifest必须覆盖精确完整原件集合','INCONCLUSIVE')
    for name,digest in manifest.items():require(hashlib.sha256(files[name]).hexdigest()==digest,'原件摘要不符:'+name,'INCONCLUSIVE')
    docs={name:strict_json(data) for name,data in files.items() if name.endswith('.json')}
    summary=docs['summary.json'];base=base_summary()
    require(isinstance(summary,dict) and set(base)|{'candidate'}<=set(summary),'summary完整字段','INCONCLUSIVE')
    for key,value in base.items():
        if key not in ('execution_status','checks','limited_native_status'):require(summary[key]==value,'资格边界/版本不符:'+key,'INCONCLUSIVE')
    require(summary['candidate']==expected_candidate==docs['candidate.json'],'固定candidate绑定不符','INCONCLUSIVE')
    require(set(expected_candidate)=={'commit','tree','files'} and all(isinstance(expected_candidate[k],str) and re.fullmatch('[0-9a-f]{40}',expected_candidate[k]) for k in ('commit','tree')),'candidate身份结构','INCONCLUSIVE')
    profile=docs['profile.json'];require(profile['profile']==PROFILE and profile['accepted_provider_profiles']==[] and profile['qualified_kernel_builds']==[],'profile边界','INCONCLUSIVE')
    require(set(expected_candidate['files'])==set(profile['source_files']) and len(profile['source_files'])==len(expected_candidate['files'])==8 and all(re.fullmatch('[0-9a-f]{64}',v) for v in expected_candidate['files'].values()),'精确八路径候选','INCONCLUSIVE')
    require(hashlib.sha256(files['profile.json']).hexdigest()==expected_candidate['files']['scripts/qualification/fs-native-ext4/profile.json'],'profile原件与候选blob不符','INCONCLUSIVE')
    require(docs['binary.json']['sha256']==expected_binary_sha256 and re.fullmatch('[0-9a-f]{64}',expected_binary_sha256),'实际binary绑定不符','INCONCLUSIVE')
    env=docs['environment.json'];require(isinstance(env['uname'],list) and len(env['uname'])==6 and bool(env['process']) and bool(env['os_release']),'实际environment原件缺失','INCONCLUSIVE')
    rows=summary['checks'];require(isinstance(rows,dict) and set(rows)==set(CHECKS),'必须精确包含EX4-Q01–Q12','INCONCLUSIVE')
    statuses={'PASS','FAIL','BLOCKED','INCONCLUSIVE','NOT_RUN','NOT_RUN_ENVIRONMENT'}
    events=[strict_json(line) for line in files['events.jsonl'].splitlines() if line]
    require(events and events[0]['event']=='start','完整进程事件原件','INCONCLUSIVE')
    for key in CHECKS:
        row=rows[key];require(isinstance(row,dict) and set(row)<={'status','detail','reason','evidence'} and row.get('status') in statuses,'合法Q行:'+key,'INCONCLUSIVE')
        if row['status']=='PASS':
            require(isinstance(row.get('detail'),(dict,list)) and bool(row['detail']),'PASS缺payload:'+key,'INCONCLUSIVE')
            refs=row.get('evidence');require(isinstance(refs,list) and all(isinstance(v,str) for v in refs) and len(refs)==len(set(refs)) and Q_REQUIRED[key]<=set(refs)<=set(manifest),'PASS缺必需原件:'+key,'INCONCLUSIVE')
            require(all(bool(docs[p]) for p in Q_REQUIRED[key] if p.endswith('.json')),'空原件:'+key,'INCONCLUSIVE')
            if key!='EX4-Q12':
                require(all(sum(e.get('event')==phase and e.get('phase')==key for e in events)==1 for phase in ('phase-start','phase-end')),'缺唯一场景执行边界:'+key,'INCONCLUSIVE')
        elif row['status'] not in ('NOT_RUN','NOT_RUN_ENVIRONMENT'):require(bool(row.get('reason')) or bool(row.get('detail')),'非PASS缺结果依据:'+key,'INCONCLUSIVE')
    starts=[e for e in events if e['event']=='child-start'];exits=[e for e in events if e['event']=='child-exited']
    require(len(starts)==len(exits),'子进程退出原件不完整','INCONCLUSIVE')
    for start in starts:
        matching=[e for e in exits if (e['label'],e['pid'])==(start['label'],start['pid'])]
        require(len(matching)==1 and matching[0]['reaped'] is True and type(matching[0]['returncode']) is int,'子进程未证明reap','INCONCLUSIVE')
        require({'commands/'+start['label']+ext for ext in ('.stdout','.stderr')}<=set(manifest),'缺命令原字节','INCONCLUSIVE')
    for name in files:
        if name.startswith('commands/'):
            label=name[len('commands/'):].rsplit('.',1)[0]
            require(sum(e['label']==label for e in starts)==1,'命令原字节缺唯一进程回执:'+name,'INCONCLUSIVE')
    def references(value):
        if isinstance(value,dict):
            for item in value.values():references(item)
        elif isinstance(value,list):
            for item in value:references(item)
        elif isinstance(value,str) and value.endswith('.json'):
            require(value in manifest,'记录引用的原件缺失:'+value,'INCONCLUSIVE')
    for row in rows.values():references(row.get('detail'))
    for name,value in docs.items():
        if name.startswith('recreation/') or name in ('inode-reuse.json','synthetic-equal-stat-time.json','fs-lifecycle.json'):references(value)
    for name,value in docs.items():
        if name.startswith('native/'):
            label=name[len('native/'):-len('.json')];stdout='commands/'+label+'.stdout'
            require(stdout in files and value['records']==[strict_json(line) for line in files[stdout].splitlines() if line],'native记录与原stdout断开:'+name,'INCONCLUSIVE')
            require(any(e['label']==label and e['returncode']==value['returncode'] and e['reaped']==value['reaped'] for e in exits),'native退出与事件断开:'+name,'INCONCLUSIVE')
        elif name.startswith('actions/'):
            stdout='commands/'+name[len('actions/'):-len('.json')]+'.stdout'
            require(stdout in files and {k:v for k,v in value.items() if k!='all_old_native_children_reaped'}==strict_json(files[stdout]),'action与原stdout断开:'+name,'INCONCLUSIVE')
    cleanup=docs['cleanup.json'];require(rows['EX4-Q12'].get('detail')==cleanup and rows['EX4-Q12']['status']==cleanup['status'],'Q12与cleanup断开','INCONCLUSIVE')
    if cleanup['status']=='PASS':require(all(cleanup.get(k) is True for k in ('mounts_released','loop_detached','children_reaped')),'cleanup缺实际释放证明','INCONCLUSIVE')
    execution=summary['execution_status'];require(execution in statuses|{'COMPLETE'},'非法execution状态','INCONCLUSIVE')
    validate_pass_payloads(rows,docs,files,events)
    return summary,aggregate([rows[k]['status'] for k in CHECKS]+[cleanup['status'],'PASS' if execution=='COMPLETE' else execution])

def base_summary():
    return {'schema_version':'fs-native-ext4-qualification-result/v1','profile':PROFILE,'execution_status':'NOT_RUN','checks':{k:{'status':'NOT_RUN'} for k in CHECKS},'limited_native_status':'BLOCKED','provider_qualification':'BLOCKED_PENDING_INDEPENDENT_R04','accepted_provider_profiles':[],'qualified_kernel_builds':[],'B1':'OPEN','historical_product_delete_recreate':'FAIL_UNRESOLVED','overlay':'historical FAIL/BLOCKED unchanged','S4_outputs_released':[],'ticket153':'BLOCKED','production_runtime_matching':'NOT_IMPLEMENTED_UNSUPPORTED','R05':'NOT_RUN','OS_reboot':'NOT_RUN'}
def validate_native(record: dict) -> tuple[str, str]:
    """只接受整个 opaque handle；绝不按内部位、stat 或请求数据补身份。"""
    try:
        if any(type(record[key]) is not int for key in ("before_rc", "after_rc", "fs_rc")):
            return "INCONCLUSIVE", "syscall rc 必须是整数"
        if record["before_rc"] != 0 or record["after_rc"] != 0:
            errors=[record[name+'_errno'] for name in ('before','after') if record[name+'_rc']!=0]
            return ("BLOCKED" if all(type(e) is int and e>0 for e in errors) else "INCONCLUSIVE"), "same-FD fstat 不可用；原始errno="+str(errors)
        before, after = record["before"], record["after"]
        if {k: v for k, v in before.items() if k != "atime"} != {k: v for k, v in after.items() if k != "atime"}:
            return "FAIL", "native 同 FD 读取期间 metadata 改变"
        fsuuid, fid, mount = record["fsuuid"], record["fid_unique"], record["statx_unique"]
        if any(type(item["rc"]) is not int for item in (fsuuid, fid, mount)):
            return "INCONCLUSIVE", "原生身份 syscall rc 必须是整数"
        for item in (fsuuid,fid,mount,record['statx_legacy']):
            if item['rc']!=0 and (type(item['errno']) is not int or item['errno']<=0):return "INCONCLUSIVE","失败syscall缺少实际errno"
        if record["fs_rc"] != 0 or record["fs_magic"] != "ef53":
            if record['fs_rc']!=0 and (type(record['fs_errno']) is not int or record['fs_errno']<=0):return 'INCONCLUSIVE','fstatfs失败缺少实际errno'
            return "BLOCKED", "不是可确认的 native ext4 FD"
        if fsuuid["rc"] != 0 or type(fsuuid["length"]) is not int or fsuuid["length"] != 16:
            return "BLOCKED", "GETFSUUID 不可用或 UUID 长度不符"
        if not re.fullmatch(r"[0-9a-f]{32}", fsuuid["hex"]) or fsuuid["hex"] == "0" * 32:
            return "BLOCKED", "UUID 不符合非零严格 codec"
        if fid["rc"] != 0 or type(fid["handle_type"]) is not int or fid["handle_type"] != 1:
            return "BLOCKED", "FID type 不受该 profile 支持"
        if type(fid["handle_bytes"]) is not int or fid["handle_bytes"] != 8 or not re.fullmatch(r"[0-9a-f]{16}", fid["hex"]):
            return "BLOCKED", "FID length/hex 不受该 profile 支持"
        if mount["rc"] != 0 or type(mount["mask"]) is not int or not mount["mask"] & 0x4000:
            return "BLOCKED", "unique mount mask 不可用"
        if not re.fullmatch(r"[1-9][0-9]*", mount["mount_id"]) or int(mount["mount_id"]) >= 2**64:
            return "BLOCKED", "unique mount ID 不是有效 64-bit 槽"
        if mount["mount_id"] != fid["mount_id"]:
            return "FAIL", "同 FD 的 unique mount ID 不一致"
        legacy=record["statx_legacy"]
        if any(type(legacy[k]) is not int for k in ("rc","errno","mask","requested_mask","dev_major","dev_minor")) or type(mount["requested_mask"]) is not int or legacy["rc"]!=0 or legacy["errno"]!=0 or legacy["requested_mask"]!=0x17ff or mount["requested_mask"]!=0x4fff:
            return "BLOCKED", "必须分开请求legacy/unique masks"
        if legacy["mask"] & 0x17ff != 0x17ff or mount["mask"] & 0x4fff != 0x4fff:
            return "BLOCKED", "缺有效basic/btime/mount mask"
        if not re.fullmatch(r"[1-9][0-9]*",legacy["mount_id"]) or int(legacy["mount_id"])>=2**64:
            return "BLOCKED", "legacy mount ID非法"
        if os.makedev(legacy["dev_major"],legacy["dev_minor"])!=int(before["dev"]):
            return "FAIL", "实际statx/fstat device不符"
        if not int(mount["attributes_mask"]) & 0x200000 or int(mount["attributes"]) & 0x200000:
            return "BLOCKED", "non-DAX必须有当前FD可观察证据"
        if record["statx_metadata_matches"] is not True or record["same_fd_metadata_stable"] is not True:
            return "FAIL", "实际statx/fstat或same FD不符"
        for m in (before,after):
            validate_metadata(m)
        for row in (fsuuid,fid,mount,legacy):
            if type(row["errno"]) is not int or row["errno"]!=0:return "BLOCKED","原生错误"
        t=mount["btime"]
        if len(t)!=2 or not re.fullmatch(r"0|-?[1-9][0-9]*",t[0]) or not re.fullmatch(r"0|[1-9][0-9]*",t[1]) or int(t[1])>=10**9:
            return "BLOCKED","birthtime非法"
        return "PASS", "实际同 FD ext4 UUID/FID 与64-bit unique mount一致"
    except (KeyError, TypeError, ValueError):
        return "INCONCLUSIVE", "原生输出不符合实验协议"

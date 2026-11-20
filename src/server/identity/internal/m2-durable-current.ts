import type { BindingVersion, ConfigSnapshot, CurrentAdvancedSelection, WorkspaceRef, SelectedConfigSource, SourcePair } from '../m2-value-contracts.ts';
import type { RawRow } from '../m2-history-contracts.ts';
import type { ReadonlyDeep } from '../m2-value-contracts.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import type { M2OriginClosure } from './m2-durable-origin.ts';
import { M2Business, checkM2Capture, checkM2CapturedLegacySnapshot } from './m2-durable-business.ts';
import type { M2Graph, M2HistoryData } from './m2-durable-graph.ts';
import { M2_PROFILE_WRITER_CONTRACT } from './m2-profile-writer-contract.ts';

type Row=ReadonlyDeep<RawRow>;
function role(b:M2Business,ref:{roleTemplateId:string;revision:number}|null):void {
  if(ref)b.one('role_template_versions',['role_template_id','revision'],[ref.roleTemplateId,ref.revision]);
}
function workspace(b:M2Business,ref:WorkspaceRef,root?:{canonicalRoot:string;physicalResourceKey:string;rootIdentity:unknown}):void {
  const row=b.one('project_workspace_versions',['project_id','workspace_revision'],[ref.projectId,ref.workspaceRevision]),f:FState=b.g.f;
  if(root){f.require(b.text('project_workspace_versions',row,'canonical_root')===root.canonicalRoot
      &&b.text('project_workspace_versions',row,'physical_resource_key')===root.physicalResourceKey);
    b.g.same(b.json('project_workspace_versions',row,'root_identity_json'),root.rootIdentity);}
}
function scope(b:M2Business,value:{agentId:string;memberId:string;projectId:string;groupId:string}):void {
  const f:FState=b.g.f,member=b.one('members',['id'],[value.memberId]),group=b.one('groups',['id'],[value.groupId]);
  b.one('agents',['id'],[value.agentId]);b.one('projects',['id'],[value.projectId]);
  f.require(b.text('members',member,'kind')==='agent'&&b.scalar('members',member,'agent_id')===value.agentId
    &&b.text('members',member,'project_id')===value.projectId&&b.text('groups',group,'project_id')===value.projectId);
}
function executionScope(b:M2Business,execution:Row,value:{agentId:string;memberId:string;projectId:string;groupId:string;groupBindingId?:string}):void {
  const f:FState=b.g.f,runtime=b.one('agent_runtimes',['id'],[b.text('agent_runtime_bindings',execution,'runtime_id')]);
  f.require(b.text('agent_runtimes',runtime,'agent_id')===value.agentId);
  for(const [column,key] of [['member_id','memberId'],['project_id','projectId'],['group_id','groupId'],['group_binding_id','groupBindingId']] as const)
    if(value[key]!==undefined)f.require(b.text('agent_runtime_bindings',execution,column)===value[key]);
}
function capture(b:M2Business,origin:M2OriginClosure,reference:{captureId:string;sourceDigest:string;artifactDigest:string}):void {
  const saved=b.value('legacy_config_captures',b.one('legacy_config_captures',['id'],[reference.captureId]));b.g.same(saved.ref,reference);
  b.g.same(saved.capture,b.g.capture(reference));checkM2Capture(b.g,reference,origin.before);
}
function advanced(b:M2Business,origin:M2OriginClosure,value:CurrentAdvancedSelection,binding:BindingVersion):void {
  const f:FState=b.g.f;if(value.state==='none')return;
  if(value.state==='retained_inactive'){
    capture(b,origin,value.captureRef);const old=new M2Business(b.g,origin.before),execution=old.one('agent_runtime_bindings',['id'],[binding.ref.groupBindingId]);
    b.g.same(old.json('agent_runtime_bindings',execution,'advanced_json'),value.original);
    const runtime=old.one('agent_runtimes',['id'],[old.text('agent_runtime_bindings',execution,'runtime_id')]);
    const valid=value.original.runtimeRevision===old.number('agent_runtimes',runtime,'revision')&&value.original.bindingRevision===old.number('agent_runtime_bindings',execution,'revision');
    f.require(value.reason===(valid?'migration_reconfirmation_required':'invalidated_by_revision'));return;
  }
  const basis=value.basis,profile=b.profile(basis.profileRef),member=b.one('members',['id'],[binding.memberId]);
  f.require(basis.profileRef.agentId===binding.agentId&&basis.bindingConfigRevision===binding.ref.bindingConfigRevision
    &&basis.existingScope.sourceIdentityDigest===b.history.observation.source.identityDigest
    &&basis.existingScope.agentId===binding.agentId&&basis.existingScope.memberId===binding.memberId
    &&basis.existingScope.groupId===binding.groupId&&basis.existingScope.projectId===binding.projectId
    &&basis.existingScope.membershipRevision<=b.number('members',member,'membership_revision'));
  workspace(b,basis.root.workspaceRef,basis.root);const execution=b.one('agent_runtime_bindings',['id'],[basis.existingScope.executionBindingId]);
  executionScope(b,execution,{...binding,groupBindingId:binding.ref.groupBindingId});
  if(basis.compatibilityBasis){
    const saved=b.value('agent_profile_versions',b.one('agent_profile_versions',['agent_id','revision'],[profile.ref.agentId,profile.ref.profileRevision]));
    const version=b.value('group_binding_config_versions',b.one('group_binding_config_versions',['binding_id','revision'],[binding.ref.groupBindingId,binding.ref.bindingConfigRevision]));
    f.require(saved.compatRuntimeRevision===basis.compatibilityBasis.runtimeRevision&&version.compatibility!==null
      &&version.compatibility.executionBindingId===basis.existingScope.executionBindingId&&version.compatibility.bindingRevision===basis.compatibilityBasis.bindingRevision);
  }
  if(value.origin.kind==='legacy_equivalence'){
    capture(b,origin,value.origin.captureRef);const initial=new M2Business(b.g,origin.preB);
    const saved=initial.value('group_binding_config_versions',initial.one('group_binding_config_versions',['binding_id','revision'],[binding.ref.groupBindingId,1]));
    b.g.same(saved.content.currentAdvanced,value);
  }
}
function monotone(b:M2Business,rows:readonly {revision:number;compat:number|null}[]):void {
  const f:FState=b.g.f,ordered=b.g.sort(rows,(a,c)=>a.revision-c.revision);let prior=0;
  for(const item of ordered){f.charge(1);if(item.compat!==null){f.require(item.compat>prior);prior=item.compat;}}
}
function profiles(b:M2Business):void {
  const f:FState=b.g.f,versions=b.values('agent_profile_versions');
  for(const head of b.values('agent_profiles')){
    const row=b.value('agent_profile_versions',b.one('agent_profile_versions',['agent_id','revision'],[head.agentId,head.currentRevision]));
    f.require(row.compatRuntimeRevision===head.compatRuntimeRevision);
    if(head.legacyRuntimeId!==null){const runtime=b.one('agent_runtimes',['id'],[head.legacyRuntimeId]);f.require(b.text('agent_runtimes',runtime,'agent_id')===head.agentId);}
    const history=versions.filter(v=>v.version.ref.agentId===head.agentId);f.charge(versions.length,0,history.length+1);
    monotone(b,history.map(v=>({revision:v.version.ref.profileRevision,compat:v.compatRuntimeRevision})));
  }
  for(const row of versions)role(b,row.version.content.defaultRoleRef);
}
function bindings(b:M2Business,origin:M2OriginClosure):void {
  const f:FState=b.g.f,versions=b.values('group_binding_config_versions');
  for(const head of b.values('group_bindings')){
    scope(b,head);const version=b.value('group_binding_config_versions',b.one('group_binding_config_versions',['binding_id','revision'],[head.id,head.currentRevision]));
    if(head.originalLegacyBindingId!==null){const shell=b.one('agent_runtime_bindings',['id'],[head.originalLegacyBindingId]);executionScope(b,shell,{...head,groupBindingId:head.id});}
    if(head.currentAttachmentId!==null){
      f.require(head.retiredAt===null&&version.compatibility!==null&&version.compatibility.executionBindingId===head.currentAttachmentId
        &&version.compatibility.bindingRevision===head.currentCompatBindingRevision);
      const shell=b.one('agent_runtime_bindings',['id'],[head.currentAttachmentId]);executionScope(b,shell,{...head,groupBindingId:head.id});
      f.require(b.text('agent_runtime_bindings',shell,'attachment_state')==='attached');
    }else f.require(head.currentCompatBindingRevision===null);
  }
  const compat=new Map<string,{revision:number;compat:number|null}[]>();f.charge(1,0,1);
  for(const version of versions){const binding=b.binding(version.ref);role(b,binding.content.roleRef);advanced(b,origin,binding.content.currentAdvanced,binding);
    if(version.compatibility){const shell=b.one('agent_runtime_bindings',['id'],[version.compatibility.executionBindingId]);executionScope(b,shell,{...binding,groupBindingId:binding.ref.groupBindingId});
      const history=compat.get(version.compatibility.executionBindingId)??[];f.charge(1,0,2);history.push({revision:version.ref.bindingConfigRevision,compat:version.compatibility.bindingRevision});compat.set(version.compatibility.executionBindingId,history);}}
  for(const history of compat.values())monotone(b,history);
}
function snapshotScope(b:M2Business,snapshot:ConfigSnapshot):void {
  scope(b,snapshot);const head=b.value('group_bindings',b.one('group_bindings',['id'],[snapshot.groupBindingId]));
  for(const field of ['agentId','memberId','projectId','groupId'] as const)b.g.same(snapshot[field],head[field]);
  if(snapshot.executionBindingId!==null)executionScope(b,b.one('agent_runtime_bindings',['id'],[snapshot.executionBindingId]),snapshot);
}
function snapshots(b:M2Business,origin:M2OriginClosure):void {
  const f:FState=b.g.f;
  for(const saved of b.values('legacy_config_captures'))capture(b,origin,saved.ref);
  for(const snapshot of b.values('config_snapshots')){
    snapshotScope(b,snapshot);
    if(snapshot.origin.kind==='legacy'){
      capture(b,origin,snapshot.origin.raw.captureRef);checkM2CapturedLegacySnapshot(b.g,snapshot,origin.before);
      if(snapshot.advancedBasis.kind==='legacy'&&snapshot.advancedBasis.legacy.mappedValidity==='equivalent'){
        const initial=new M2Business(b.g,origin.preB);let found=false;
        for(const old of initial.values('config_snapshots'))if(old.origin.kind==='legacy'&&b.g.f.equal(old.origin.legacyRef,snapshot.origin.legacyRef)){
          b.g.same(old.advancedBasis,snapshot.advancedBasis);found=true;break;}
        f.require(found);
      }
    }else{
      const profile=b.profile(snapshot.origin.profileRef),binding=b.binding(snapshot.origin.bindingRef);f.require(profile.ref.agentId===snapshot.agentId);
      for(const key of ['agentId','memberId','projectId','groupId'] as const)f.require(binding[key]===snapshot[key]);
      f.require(snapshot.advancedBasis.kind==='profile');b.g.same(snapshot.advancedBasis.currentSelection,binding.content.currentAdvanced);
    }
  }
  for(const mapping of b.values('config_workspace_mappings')){
    const snapshot=b.snapshot(mapping.configSnapshotRef);workspace(b,mapping.workspaceRef,mapping);b.g.join('mapping',{snapshot,mapping});
  }
}
function selected(b:M2Business,value:SelectedConfigSource|null):SourcePair|null {
  if(value===null)return null;b.g.f.charge(1,0,1,3);return {snapshot:b.snapshot(value.snapshotRef),mapping:value.state==='mapped'?b.mapping(value.mappingRef):null};
}
function detaches(b:M2Business,origin:M2OriginClosure):void {
  const f:FState=b.g.f;
  for(const detach of b.values('config_detach_snapshots')){
    const profile=b.profile(detach.profileRef),binding=b.binding(detach.bindingRef),shell=b.one('agent_runtime_bindings',['id'],[detach.attachment.executionBindingId]);
    executionScope(b,shell,{...binding,groupBindingId:binding.ref.groupBindingId});f.require(b.text('agent_runtime_bindings',shell,'runtime_id')===detach.attachment.runtimeId);
    if(detach.root.workspaceRef)workspace(b,detach.root.workspaceRef,detach.root.state==='fixed_reference'?detach.root:undefined);
    const rootSelected=detach.root.state==='fixed_reference'&&detach.root.mappingRef!==null?b.mapping(detach.root.mappingRef):null;
    advanced(b,origin,detach.currentAdvanced.stored,binding);
    b.g.join('detach',{detach,profile,binding,requested:selected(b,detach.requested),applied:selected(b,detach.applied),
      rootSelected:rootSelected===null?null:{mapping:rootSelected,snapshot:b.snapshot(rootSelected.configSnapshotRef)}});
  }
}
function pair(b:M2Business,snapshotId:string|null,mappingId:string|null,shell:Row):void {
  const f:FState=b.g.f;if(snapshotId===null){f.require(mappingId===null);return;}
  const snapshot=b.value('config_snapshots',b.one('config_snapshots',['id'],[snapshotId]));f.require(snapshot.executionBindingId===b.text('agent_runtime_bindings',shell,'id'));
  snapshotScope(b,snapshot);if(mappingId!==null){const mapping=b.value('config_workspace_mappings',b.one('config_workspace_mappings',['id'],[mappingId]));b.g.join('mapping',{snapshot,mapping});}
}
function attachments(b:M2Business):void {
  const f:FState=b.g.f;
  for(const shell of b.rows('agent_runtime_bindings')){
    const refs=b.value('execution-binding-references',shell),head=b.value('group_bindings',b.one('group_bindings',['id'],[refs.groupBindingId]));
    executionScope(b,shell,{...head,groupBindingId:head.id});
    if(refs.attachmentState==='attached')f.require(head.currentAttachmentId===refs.executionBindingId&&head.retiredAt===null);
    else{
      f.require(head.currentAttachmentId!==refs.executionBindingId&&refs.detachSnapshotId!==null&&refs.detachedAt!==null);
      const detach=b.value('config_detach_snapshots',b.one('config_detach_snapshots',['id'],[refs.detachSnapshotId]));
      f.require(detach.attachment.executionBindingId===refs.executionBindingId&&detach.attachment.groupBindingId===refs.groupBindingId);
    }
    pair(b,refs.requestedSnapshotId,refs.requestedMappingId,shell);
  }
  for(const row of b.rows('agent_runner_states')){const refs=b.value('runner-applied-references',row),shell=b.one('agent_runtime_bindings',['id'],[refs.bindingId]);pair(b,refs.appliedSnapshotId,refs.appliedMappingId,shell);}
}
/** All current persistent P-A relations. The origin target is never compared to
 * these later mutable heads, aliases, requests, runs or audit descriptions. */
export function checkM2CurrentValues(g:M2Graph,history:M2HistoryData,origin:M2OriginClosure):void {
  const f:FState=g.f,b=new M2Business(g,history);b.keys();profiles(b);bindings(b,origin);snapshots(b,origin);detaches(b,origin);attachments(b);
  const receipts=b.values('config_activation_receipts');f.require(receipts.length===1);g.same(receipts[0],origin.activation);
  const authorities=b.values('config_authority');f.require(authorities.length===1);const authority=authorities[0]!;
  f.require(authority.owner==='profile'&&authority.sourceBinding.kind==='local','semantic_unsupported');
  g.join('authority',{authority,receipt:origin.activation,receiptArtifact:null,sourceHistory:null,importSelection:null});
  for(const receipt of b.values('config_mutation_receipts')){
    if(receipt.result.kind==='profile')b.profile(receipt.result.saved.ref);else b.binding(receipt.result.saved.ref);
    b.one('audit_log',['id'],[receipt.auditId]);
  }
  for(const row of b.rows('storage_source_clients')){
    const protocol=g.integer(row.cells[4]!),format=g.text(row.cells[16]!);
    f.require(protocol===1n?format===null:protocol===2n&&format===M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest);
  }
}

import type { ActivationReceipt } from '../m2-value-contracts.ts';
import type { P0Request } from './m2-p0-types.ts';
import type { FState } from './m2-p0-artifacts-common.ts';
import { beginP0FArtifactPass, endP0FArtifactPass } from './m2-p0-artifacts-frame.ts';
import { runP0M2Predecessor } from './m2-p0-closure.ts';
import { runP0ReadyJournal } from './m2-p0-artifacts-math.ts';
import { M2Graph } from './m2-durable-graph.ts';
import type { M2HistoryData } from './m2-durable-graph.ts';
import { m2Definition } from './m2-durable-schema.ts';
import type { ArtifactRef, EvidenceRef, SourceRef, ProfileCommitRecord, ProfileCompletionRecord, ProfileOwnerAcquired,
  ProfileCompletionBinding, M2ControlValue, CompleteHistorySelection } from './m2-durable-types.ts';
import { checkM2OldControlTail, selectedM2Control, readM2Control, checkM2ActivationControls, deriveM2OldRegistrations } from './m2-durable-controls.ts';
import { checkM2Capture, checkM2InitialBusiness, M2Business } from './m2-durable-business.ts';
import { checkM2AllowedDelta, checkM2TargetRows, checkM2AuditAdditions, checkM2Upgrade } from './m2-durable-delta.ts';
import { checkM2OwnerClients } from './m2-durable-clients.ts';
import type { M2ClientRegistration } from './m2-durable-clients.ts';
import { M2_PROFILE_WRITER_CONTRACT } from './m2-profile-writer-contract.ts';

type Body=ProfileCommitRecord|ProfileOwnerAcquired|ProfileCompletionRecord;
interface RecordV4 {
  readonly formatVersion:4; readonly kind:'journal'; readonly migrationId:string; readonly sequence:number;
  readonly previous:ArtifactRef; readonly source:SourceRef; readonly plan:ArtifactRef; readonly requestId:string;
  readonly requestDigest:string; readonly fenceEpoch:number; readonly ownerGeneration:number;
  readonly event:'s2_profile_committed'|'s2_profile_owner_acquired'|'s2_profile_completed';
  readonly phase:'s2_profile_committed'|'s2_profile_completed'; readonly body:Body;
  readonly bindings:{readonly activationReceipt:ArtifactRef;readonly takeoverPlan:ArtifactRef};
}
interface Node {readonly reference:ArtifactRef;readonly record:RecordV4;}
export interface M2OriginClosure {
  readonly graph:M2Graph; readonly completion:ProfileCompletionBinding; readonly activation:ActivationReceipt;
  readonly activationArtifact:ArtifactRef; readonly before:M2HistoryData; readonly preB:M2HistoryData;
  readonly terminal:ArtifactRef; readonly controlBeforeB:M2ControlValue; readonly ownerGeneration:number;
}
function v4(g:M2Graph,reference:ArtifactRef):RecordV4 {
  const f:FState=g.f,v=f.object(f.json(g.selected(reference,'journal')),
    ['formatVersion','kind','migrationId','sequence','previous','source','plan','requestId','requestDigest','fenceEpoch','ownerGeneration','event','phase','body','bindings']);
  f.require(v.formatVersion===4&&v.kind==='journal');m2Definition(f,'MigrationId',v.migrationId);
  for(const name of ['sequence','fenceEpoch','ownerGeneration'])m2Definition(f,'PositiveCounter',v[name]);
  m2Definition(f,'Id',v.requestId);m2Definition(f,'Digest',v.requestDigest);m2Definition(f,'SourceRef',v.source);
  g.ref(v.previous);g.ref(v.plan);const bindings=f.object(v.bindings,['activationReceipt','takeoverPlan']);g.ref(bindings.activationReceipt);g.ref(bindings.takeoverPlan);
  f.require(reference.ref===`journals/${v.migrationId}/${v.sequence}-${reference.sha256}.json`);
  if(v.event==='s2_profile_committed'){f.require(v.phase==='s2_profile_committed');m2Definition(f,'ProfileCommitRecord',v.body);}
  else if(v.event==='s2_profile_owner_acquired'){f.require(v.phase==='s2_profile_committed');m2Definition(f,'ProfileOwnerAcquired',v.body);}
  else {f.require(v.event==='s2_profile_completed'&&v.phase==='s2_profile_completed');m2Definition(f,'ProfileCompletionRecord',v.body);}
  return v as unknown as RecordV4;
}
function anchor(g:M2Graph,reference:ArtifactRef,sequence:number){g.f.charge(1,0,2,5);return {record:{artifactId:reference.ref,digest:reference.sha256},sequence};}
function domain(g:M2Graph,reference:EvidenceRef,kind:'full-data'|'frozen-business'|'pre-anchor-controls'|'source-clients',selection:CompleteHistorySelection):void {
  const f:FState=g.f,value=g.evidence(reference,'m2-observation-domain');f.require(value.domain===kind);g.same(value.source,selection.source);g.same(value.history,selection);
  f.charge(selection.tables.length,0,selection.tables.length+1);
  const tables=selection.tables.filter(t=>kind==='full-data'?true:kind==='frozen-business'?!['storage_maintenance','storage_source_clients','schema_migrations'].includes(t.table)
    :kind==='pre-anchor-controls'?t.table==='storage_maintenance'||t.table==='storage_source_clients':t.table==='storage_source_clients');
  g.same(value.tables,tables);
  f.require(value.domainDigest===f.digestCr3(['m2-observation-domain/r1',value.source,kind,value.tables]));
}
function common(g:M2Graph,node:Node,activation:ActivationReceipt,planRef:{planId:string;digest:string},source:SourceRef,plan:ArtifactRef,migration:string):void {
  const f:FState=g.f,r=node.record,b=r.body;g.same(r.source,source);g.same(r.plan,plan);f.require(r.migrationId===migration);
  g.same(b.activation,activation.ref);g.same(b.takeoverPlan,planRef);g.same(b.physicalSource,activation.physicalSourceRef);
  if(r.event!=='s2_profile_owner_acquired'){
    const body=b as ProfileCommitRecord|ProfileCompletionRecord;f.require(body.migrationId===migration&&body.s4PlanDigest===plan.sha256&&body.ownerGeneration===r.ownerGeneration&&body.requestDigest===r.requestDigest);
    g.same(body.predecessor,anchor(g,r.previous,r.sequence-1));
  }
}

/** One complete original captured-history pass followed by exact ready/A/owners/B.
 * This internal result is data for the two fixed consumers, never a writer permit. */
export function checkM2Origin(request:P0Request,closureReference:ArtifactRef):M2OriginClosure {
  const g=new M2Graph(request),f:FState=g.f,old=runP0M2Predecessor(request);f.require(old.ok,old.ok?'invalid_value':old.error.code);
  beginP0FArtifactPass(f,request.original);
  try {
    const closure=g.payload(closureReference,'profile-journal-closure');
    f.require(closure.purpose==='m2-origin'&&closure.originHistory===null&&closure.nodes.length>=5&&closure.nodes.length<=4096);
    g.same(closure.genesis,closure.nodes[0]);g.same(closure.terminal,closure.nodes.at(-1));
    const seen=new Set<string>(),requests=new Map<string,string>(),nodes:Node[]=[];let firstNew=-1;
    f.charge(closure.nodes.length,0,closure.nodes.length*2+2);
    for(let at=0;at<closure.nodes.length;at++){
      const reference=closure.nodes[at]!;f.require(!seen.has(reference.ref));seen.add(reference.ref);
      const raw=f.object(f.json(g.selected(reference,'journal')));f.require(raw.sequence===at+1&&raw.migrationId===closure.migrationId);
      g.same(raw.source,closure.originSource);g.same(raw.plan,closure.plan);g.same(raw.previous,at===0?null:closure.nodes[at-1]);
      if(raw.formatVersion===4){if(firstNew===-1)firstNew=at;const record=v4(g,reference),previousDigest=requests.get(record.requestId);
        f.require(previousDigest===undefined||previousDigest===record.requestDigest);f.charge(1,record.requestId.length*2,1);requests.set(record.requestId,record.requestDigest);nodes.push({reference,record});}
      else f.require(firstNew===-1&&(raw.formatVersion===1||raw.formatVersion===2||raw.formatVersion===3));
    }
    f.require(firstNew>=3&&nodes.length>=2&&nodes[0]!.record.event==='s2_profile_committed'&&nodes.at(-1)!.record.event==='s2_profile_completed');
    for(let i=1;i<nodes.length-1;i++)f.require(nodes[i]!.record.event==='s2_profile_owner_acquired');
    const a=nodes[0]!,b=nodes.at(-1)!,aBody=a.record.body as ProfileCommitRecord,bBody=b.record.body as ProfileCompletionRecord;
    const plan=g.payload(a.record.bindings.takeoverPlan,'m2-takeover-plan'),seed=g.payload(plan.seed,'m2-takeover-seed');
    const receipt=g.value('activation-receipt',g.payload(a.record.bindings.activationReceipt,'m2-activation-receipt'));
    const planRef={planId:plan.planId,digest:f.digestCr3(plan)};g.same(receipt.planRef,planRef);
    f.require(plan.expectedAuthority==='legacy'&&plan.planId===seed.planId&&plan.requestId===seed.requestId&&plan.activationId===seed.activationId
      &&receipt.ref.activationId===seed.activationId&&plan.migrationId===seed.migrationId&&plan.migrationId===closure.migrationId);
    g.same(plan.source,closure.originSource);g.same(seed.source,plan.source);g.same(seed.s4Plan,plan.s4Plan);g.same(plan.s4Plan,closure.plan);
    const before=g.history(seed.before);g.same(before.observation,request.input.graph.observation);f.require(before.completeHistoryDigest===old.value.completeHistoryDigest);
    g.same(plan.physicalSourceRef,before.observation.physicalSourceRef);g.same(plan.snapshotReceiptRef,before.observation.snapshotReceiptRef);
    const physical=g.evidence(plan.physicalSourceRef,'m2-physical-source');g.same(physical.sourcePlan,closure.plan);
    const originalPlan=f.decode(closure.plan,'plan'),ready=runP0ReadyJournal(f,originalPlan,physical.controlRoot,a.record.previous);
    g.same(ready.receiptRef,g.evidenceArtifact(plan.snapshotReceiptRef,'receipt'));f.require(ready.chain.nodes.length===firstNew);
    for(let i=0;i<firstNew;i++)g.same(ready.chain.nodes[i]!.reference,closure.nodes[i]);
    f.require(ready.chain.nodes[0]!.record.event==='enter'&&ready.chain.nodes[0]!.record.previous===null);
    const previous=ready.chain.nodes.at(-1)!;f.require(previous.record.phase==='snapshot_ready'&&a.record.sequence===previous.record.sequence+1
      &&a.record.ownerGeneration===previous.record.ownerGeneration&&a.record.fenceEpoch===previous.record.fenceEpoch&&aBody.fenceEpoch===a.record.fenceEpoch);
    const expectedReceipt={requestId:seed.requestId,planRef,physicalSourceRef:plan.physicalSourceRef,snapshotReceiptRef:plan.snapshotReceiptRef,
      captureRef:plan.captureRef,schemaBeforeDigest:plan.guardTransition.schemaBeforeDigest,schemaAfterDigest:plan.guardTransition.schemaAfterDigest,
      guardTransition:plan.guardTransition,allowedDeltaManifest:plan.allowedDeltaManifest,targetRowsDigest:plan.targetRowsDigest,
      sourceToTargetManifest:plan.sourceToTargetManifest,committedAuthority:'profile'};
    g.same(receipt,{ref:receipt.ref,...expectedReceipt});
    const upgrade=checkM2Upgrade(g,plan,receipt,ready),delta=g.evidence(plan.allowedDeltaManifest,'m2-allowed-delta'),map=g.evidence(plan.sourceToTargetManifest,'m2-source-to-target');
    g.same(map.seed,plan.seed);g.same(map.targetRows,delta.targetRows);
    const target=g.evidence(aBody.plannedTargetManifest,'m2-target-rows');g.same(delta.targetRows,g.evidenceArtifact(aBody.plannedTargetManifest,'m2-target-rows'));
    g.same(target.capture,plan.captureRef);g.same(aBody.exactAllowedDelta,plan.allowedDeltaManifest);g.same(aBody.guardTransition,plan.guardTransition);
    f.require(target.targetRowsDigest===plan.targetRowsDigest&&a.record.requestId===seed.requestId
      &&a.record.requestDigest===f.digest({operation:'commit-profile-takeover',source:plan.source,takeoverPlan:planRef,requestId:seed.requestId}));
    const proof=g.evidence(bBody.sealedProof,'m2-post-a-proof'),exact=g.evidence(proof.exactAllowedDeltaCheck,'m2-exact-delta-check');
    g.same(exact.source,plan.source);g.same(exact.before,seed.before);g.same(exact.allowedDelta,plan.allowedDeltaManifest);g.same(exact.receipt,a.record.bindings.activationReceipt);
    f.require(exact.targetRowsDigest===target.targetRowsDigest);const preB=g.history(exact.after);
    checkM2Capture(g,plan.captureRef,before);new M2Business(g,preB).keys();
    checkM2TargetRows(g,target,seed,plan.seed,preB);checkM2InitialBusiness(g,seed,map,plan.captureRef,before,preB);
    checkM2AuditAdditions(g,seed,before,target.rows.auditAdditions);checkM2AllowedDelta(g,delta,plan,seed,target,before,preB,receipt);
    const preA=selectedM2Control(g,delta.controlRule.before,plan.source,'p0');checkM2OldControlTail(g,ready,before,preA);
    const lastProof=previous.record.formatVersion===3?previous.record.controlProof:null;
    f.require(lastProof&&(lastProof.kind==='control-successor'||lastProof.kind==='legacy-first-capture-bridge'));
    let coordinator=lastProof.facts.actor.clientId;
    if(coordinator===null){const registered=lastProof.changes.filter(change=>change.kind==='maintenance-registration'&&change.actorId===lastProof.facts.actor.actorId);
      f.charge(lastProof.changes.length,0,registered.length+1);f.require(registered.length===1);coordinator=registered[0]!.after.client_id;}
    f.require(g.text(coordinator)===delta.controlRule.coordinatorClientId);
    const finalControl=readM2Control(g,g.tableOf(preB,'storage_maintenance'),'p1');
    const firstOwner=nodes.length>2?nodes[1]!.record.body as ProfileOwnerAcquired:null;
    const cutA=firstOwner?selectedM2Control(g,firstOwner.controlBefore,plan.source,'p1'):
      {maintenance:g.tableOf(preB,'storage_maintenance'),clients:g.tableOf(preB,'storage_source_clients'),control:finalControl};
    checkM2ActivationControls(g,preA,cutA,a.reference,a.record.sequence,upgrade.guardAfterDigest,delta.controlRule.coordinatorClientId);
    let control=cutA.control,clients=cutA.clients,cursor=a.reference,sequence=a.record.sequence;
    let registrations:ReadonlyMap<string,M2ClientRegistration>=deriveM2OldRegistrations(g,ready);
    for(const node of nodes){common(g,node,receipt,planRef,plan.source,plan.s4Plan,plan.migrationId);g.same(node.record.bindings,a.record.bindings);}
    for(let i=1;i<nodes.length-1;i++){
      const node=nodes[i]!,r=node.record,body=r.body as ProfileOwnerAcquired,beforeCut=selectedM2Control(g,body.controlBefore,plan.source,'p1');
      g.same(beforeCut.control,control);g.same(beforeCut.clients,clients);g.same(r.previous,cursor);
      f.require(sequence<Number.MAX_SAFE_INTEGER&&r.sequence===sequence+1&&control.ownerGeneration<Number.MAX_SAFE_INTEGER
        &&body.fromGeneration===control.ownerGeneration&&body.toGeneration===body.fromGeneration+1&&r.ownerGeneration===body.toGeneration&&r.fenceEpoch===control.fenceEpoch);
      const changed=checkM2OwnerClients(g,{delta:body.clientDelta,source:plan.source,plan:plan.s4Plan,actualPlan:originalPlan,migrationId:plan.migrationId,
        previous:cursor,targetSequence:r.sequence,fromGeneration:body.fromGeneration,toGeneration:body.toGeneration,fenceEpoch:control.fenceEpoch,
        originCapture:ready.receipt.capture.journal,receiptGeneration:ready.receipt.capture.ownerGeneration,
        currentFormat:{kind:'m2-profile',activationReceipt:a.record.bindings.activationReceipt,protocolVersion:2,writerFormatDigest:M2_PROFILE_WRITER_CONTRACT.profileFormatPair.writerFormatDigest},
        before:clients,beforeControl:control,knownRegistrations:registrations,frozenHistory:preB});
      clients=changed.after;registrations=changed.registrations;cursor=node.reference;sequence=r.sequence;
      f.charge(1,0,3,17);control={...control,ownerGeneration:r.ownerGeneration,journal:anchor(g,cursor,sequence)};
    }
    g.same(control,finalControl);g.same(clients,g.tableOf(preB,'storage_source_clients'));
    for(const [ref,kind] of [[proof.fullDataBeforeB,'full-data'],[proof.frozenBusinessManifest,'frozen-business'],[proof.preAnchorControlManifest,'pre-anchor-controls'],[proof.sourceClientsManifest,'source-clients']] as const)domain(g,ref,kind,exact.after);
    g.same(proof.activation,receipt.ref);g.same(proof.takeoverPlan,planRef);g.same(proof.physicalSource,plan.physicalSourceRef);g.same(proof.predecessor,anchor(g,cursor,sequence));
    f.require(proof.migrationId===plan.migrationId&&proof.s4PlanDigest===plan.s4Plan.sha256&&proof.ownerGeneration===control.ownerGeneration
      &&proof.fenceEpoch===control.fenceEpoch&&proof.guardDigest===upgrade.guardAfterDigest&&proof.schemaDigest===upgrade.schemaAfterDigest
      &&control.protocolVersion===2&&control.guardManifestDigest===proof.guardDigest&&control.admission==='sealed'&&control.profileTakeoverTerminal===null);
    const files=g.evidenceArtifact(proof.sourceFilesManifest,'source-files');g.same(files,ready.receipt.sourceFilesManifest);
    g.same(f.decode(files,'source-files'),ready.files);f.require(proof.sourceFilesManifest.digest===f.digest(ready.files));
    g.same(b.record.previous,cursor);f.require(b.record.sequence===sequence+1&&b.record.ownerGeneration===control.ownerGeneration
      &&b.record.fenceEpoch===control.fenceEpoch&&bBody.fenceEpochBefore===control.fenceEpoch&&control.fenceEpoch<Number.MAX_SAFE_INTEGER
      &&bBody.after.fenceEpoch===control.fenceEpoch+1&&bBody.after.ownerGeneration===control.ownerGeneration&&bBody.after.guardDigest===upgrade.guardAfterDigest
      &&b.record.requestId===seed.requestId+':finish'&&b.record.requestDigest===f.digest({operation:'finish-profile-takeover',source:plan.source,activation:receipt.ref,
        takeoverPlan:planRef,migrationId:plan.migrationId,s4PlanDigest:plan.s4Plan.sha256}));
    const completion:ProfileCompletionBinding={activation:receipt.ref,takeoverPlan:planRef,migrationId:plan.migrationId,s4PlanDigest:plan.s4Plan.sha256,
      sourceIdentityDigest:plan.source.identityDigest,epochBefore:control.fenceEpoch,epochAfter:bBody.after.fenceEpoch,terminal:anchor(g,b.reference,b.record.sequence)};
    f.freeze(completion);return {graph:g,completion,activation:receipt,activationArtifact:a.record.bindings.activationReceipt,before,preB,terminal:b.reference,controlBeforeB:control,ownerGeneration:control.ownerGeneration};
  } finally {endP0FArtifactPass(f);}
}

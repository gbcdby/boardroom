import { createHash } from 'node:crypto';
import type { DbReadSnapshot } from '../db/driver.ts';
import type { RepositorySet } from '../db/repositories.ts';
import type { Actor } from '../authz/authorize.ts';
import { authorize } from '../authz/authorize.ts';
import { PolicyConfigurationError } from '../policy/configuration-errors.ts';
import { canonicalJson } from '../policy/canonical.ts';
import type { DecisionStorageGraph, StorageRow } from './storage-validation.ts';
import { decode } from './text-codec.ts';
import { readCurrentReview, assertReviewPath, reviewOwnerAvailable } from './review-state.ts';
import type { DecisionRef, ReviewHeadRef, ReviewActionRequest, PolicyRef, PolicyObservation, LiveDecisionView,
  DecisionResolution, DbReviewExecution, LegacyReviewDecisionView, DecisionStoredResponseV1 } from './types.ts';

export const recordRef=(row:StorageRow):DecisionRef=>({decisionId:String(row.id),projectId:String(row.project_id),
  revision:Number(row.revision),actionDigest:String(row.action_digest)});
export const headRef=(row:StorageRow):ReviewHeadRef=>({projectId:String(row.project_id),taskId:String(row.task_id),
  roundId:String(row.round_id),headRevision:Number(row.head_revision),currentDecisionId:String(row.current_decision_id)});
export const observationOf=(row:StorageRow):PolicyObservation=>decode('decision_records.policy_evaluation_json',String(row.policy_evaluation_json)) as PolicyObservation;
export function actionOf(row:StorageRow):ReviewActionRequest {
  return {id:String(row.id),projectId:String(row.project_id),taskId:String(row.task_id),roundId:String(row.round_id),
    action:decode('decision_action_requests.action_json',String(row.action_json)) as ReviewActionRequest['action'],
    actionDigest:String(row.action_digest),candidateEnvelope:decode('decision_action_requests.candidate_envelope_json',String(row.candidate_envelope_json)) as ReviewActionRequest['candidateEnvelope'],
    origin:row.origin as ReviewActionRequest['origin'],createdBy:{kind:row.created_by_kind,id:row.created_by_id} as ReviewActionRequest['createdBy'],
    proposalReason:decode('decision_action_requests.proposal_reason_json',String(row.proposal_reason_json)) as string,
    requestedPath:row.requested_path as ReviewActionRequest['requestedPath'],createdAt:String(row.created_at)};
}
export function executionOf(row:StorageRow):DbReviewExecution {
  const base={kind:'db-review-execution/v1' as const,id:String(row.id),decisionId:String(row.decision_id),effectKey:String(row.effect_key)};
  if(row.status==='not_required')return {...base,status:'not_required',verdict:null};
  return {...base,status:'succeeded',verdict:row.verdict as 'pass'|'changes_requested',
    before:{taskRevision:Number(row.before_task_revision),roundRevision:Number(row.before_round_revision)},
    after:{taskRevision:Number(row.after_task_revision),roundRevision:Number(row.after_round_revision)},
    taskHistoryId:String(row.task_history_id),workEventIds:decode('decision_executions.work_event_ids_json',String(row.work_event_ids_json)) as string[]};
}
export function responseOf(row:StorageRow):DecisionStoredResponseV1 {
  return decode('decision_command_receipts.response_json',String(row.response_json)) as DecisionStoredResponseV1;
}
export async function currentPolicyRef(snapshot:DbReadSnapshot,projectId:string):Promise<PolicyRef> {
  const rows=await snapshot.query(`SELECT d.scope,v.revision,v.content_digest,v.default_revision FROM policy_documents d
    JOIN policy_document_versions v ON v.document_id=d.scope_key AND v.revision=d.revision WHERE d.scope_key IN ('user',?)`,[`project:${projectId}`]);
  const global=rows.find(r=>r.scope==='user'),project=rows.find(r=>r.scope==='project');
  if(!global)throw new PolicyConfigurationError('policy_not_initialized',409);
  return {policyRevision:createHash('sha256').update(JSON.stringify([global.content_digest,project?.content_digest??null,Number(global.default_revision)])).digest('hex'),
    global:{revision:Number(global.revision),contentDigest:String(global.content_digest)},
    project:project?{revision:Number(project.revision),contentDigest:String(project.content_digest)}:null,defaultRevision:Number(global.default_revision)};
}
export async function presentDecision(repos:RepositorySet,graph:DecisionStorageGraph,actor:Actor,policy:PolicyRef,row:StorageRow):Promise<LiveDecisionView> {
  const rows=(table:string)=>graph[table]??[];
  const action=actionOf(rows('decision_action_requests').find(a=>a.id===row.action_request_id)!);
  const savedEvaluation=observationOf(row),head=headRef(rows('decision_review_heads').find(h=>h.task_id===row.task_id&&h.round_id===row.round_id)!);
  const resolutionRow=rows('decision_resolutions').find(r=>r.decision_id===row.id),executionRow=rows('decision_executions').find(e=>e.decision_id===row.id);
  let resolution:DecisionResolution|null=null;
  if(resolutionRow) {
    const r=resolutionRow,init=rows('decision_local_initiations').find(i=>i.id===r.initiation_id);
    resolution={id:String(r.id),inputDecisionRef:{...recordRef(row),revision:Number(r.input_decision_revision)},
      choiceId:r.choice_id as DecisionResolution['choiceId'],authority:r.authority as DecisionResolution['authority'],
      actor:{kind:r.actor_kind,id:r.actor_id} as DecisionResolution['actor'],reason:decode('decision_resolutions.reason_json',String(r.reason_json)) as string,
      actualExecutionPath:r.actual_execution_path as DecisionResolution['actualExecutionPath'],
      provenance:init?{sourceContract:'s1.local-db-decision-choice/v1',transferMode:'same-transaction-only',authorityBasis:'same-transaction-current-permissions',
        initiationId:String(init.id),userEventId:String(init.user_event_id),actor:{kind:'human',id:'human:local'},receiptId:String(init.consumed_receipt_id),
        issuedAt:String(init.issued_at),consumedAt:String(init.consumed_at)}:
        {kind:'current-actor-command',actor:{kind:r.actor_kind,id:r.actor_id} as DecisionResolution['actor'],commandReceiptId:String(r.command_receipt_id)},
      policy:(decode('decision_resolutions.policy_evaluation_json',String(r.policy_evaluation_json)) as PolicyObservation).policy,
      permissionSnapshotDigest:String(r.permission_snapshot_digest),resolvedAt:String(r.resolved_at)};
  }
  let freshness:LiveDecisionView['freshness']=canonicalJson(savedEvaluation.policy)===canonicalJson(policy)?'current':'policy_changed';
  let blockedReason=row.blocked_reason_code as string|null;
  const allowed:LiveDecisionView['allowedOperations'][number][]=[];
  const active=graph.projects?.find(p=>p.id===row.project_id)?.archived_at===null;
  try {
    const subject=await readCurrentReview(repos,action),path=actor.kind==='human'||authorize(actor,'task:override',
      {projectId:action.projectId,nodeId:subject.assignee?.nodeId??null}).allowed?'management':'reviewer';
    const expectedTask=action.action.expectedSubjectRevisions.find(s=>s.subjectRef.kind==='task'&&s.subjectRef.id===subject.task.id);
    const expectedRound=action.action.expectedSubjectRevisions.find(s=>s.subjectRef.kind==='review-round'&&s.subjectRef.id===subject.round.id);
    if(row.status==='pending'&&row.required_authority==='owner'&&
      !await reviewOwnerAvailable(repos,subject,row.assignee_member_id as string|null))blockedReason='assignee_unavailable';
    if(!active)freshness='lifecycle_changed';
    else if(subject.candidateDigest!==action.action.candidateDigest||row.status==='pending'&&
      (subject.task.revision!==expectedTask?.revision||subject.round.revision!==expectedRound?.revision))freshness='candidate_changed';
    if(active&&head.currentDecisionId===row.id) {
      let permitted=true;try{assertReviewPath(actor,subject,path,action.action.payload.choice);}catch{permitted=false;}
      if(permitted&&row.status==='pending') {
        allowed.push('refresh');
        if(freshness==='current'&&row.required_authority!==null&&(!blockedReason||blockedReason==='assignee_unavailable'&&path==='management')&&
          (actor.kind==='human'||row.required_authority==='auto'||row.required_authority==='owner'&&path==='management'))allowed.push('approve','reject','request_changes');
      }
      if(permitted)allowed.push('propose-successor');
    }
  } catch {freshness='lifecycle_changed';}
  const successor=rows('decision_records').find(r=>r.predecessor_decision_id===row.id);
  return {recordKind:'live-review-decision',ref:recordRef(row),head,isCurrent:head.currentDecisionId===row.id,actionRequest:action,
    status:row.status as LiveDecisionView['status'],requiredAuthority:row.required_authority as LiveDecisionView['requiredAuthority'],
    savedEvaluation,currentPolicy:policy,freshness,assigneeMemberId:row.assignee_member_id as string|null,blockedReason,
    predecessor:row.predecessor_decision_id!==null?{kind:'live',decisionId:String(row.predecessor_decision_id)}:
      row.predecessor_legacy_id!==null?{kind:'legacy',legacyId:String(row.predecessor_legacy_id)}:null,
    supersededBy:successor?recordRef(successor):null,resolution,execution:executionRow?executionOf(executionRow):null,
    allowedOperations:allowed,createdAt:String(row.created_at),updatedAt:String(row.updated_at)};
}
export function legacyView(row:StorageRow):LegacyReviewDecisionView {
  const raw=JSON.parse(String(row.raw_text));let detail:Record<string,unknown>|null=null;
  try{const value=row.source_table==='task_history'?JSON.parse(raw.detail):null;if(value&&typeof value==='object'&&!Array.isArray(value))detail=value;}catch{/* 不为坏历史补造结构 */}
  let decision:unknown=row.source_table==='task_history'&&!detail?raw.detail:raw.decision??null;
  try{decision=detail?.decision??(typeof raw.decision==='string'?JSON.parse(raw.decision):decision);}catch{/* 保留原文本诊断 */}
  let actor:unknown=raw.actor??null;try{actor=typeof raw.actor==='string'?JSON.parse(raw.actor):actor;}catch{/* 保留原文本诊断 */}
  return {recordKind:'legacy-review-fact',legacyId:String(row.id),projectId:String(row.project_id),taskId:String(row.task_id),roundId:row.round_id as string|null,
    source:{table:row.source_table as LegacyReviewDecisionView['source']['table'],id:String(row.source_id),rawDigest:String(row.raw_digest)},
    chainStatus:row.chain_status as LegacyReviewDecisionView['chainStatus'],originalActor:actor,originalDecision:decision,
    originalPreviousDecision:detail?.previousDecision??null,originalTaskRevision:typeof raw.task_revision==='number'?raw.task_revision:null,
    canResolve:false,newApprovalProvenance:null,diagnosticCodes:JSON.parse(String(row.diagnostics_json))};
}

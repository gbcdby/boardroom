import { randomUUID } from 'node:crypto';
import type { Actor } from '../authz/authorize.ts';
import { appendAuditEntry, auditActorFrom } from '../audit.ts';
import { notifyWorkEventCommit } from '../tasks/events.ts';
import { notifyResourceChange } from '../resource-changes.ts';
import type { DbReviewHandlerDescriptorV1 } from '../policy/db-review.ts';
import type { ReviewRound } from '../../shared/tasks.ts';
import type { ReviewLockedTransaction, CurrentDbReviewEffectGuard, DecisionRef, ReviewPolicyActionV1, PolicyObservation, DbReviewExecution } from './types.ts';
import { assertReviewTransaction } from './locked-transaction.ts';
import { assertReviewPath, readCurrentReview, reviewAction } from './review-state.ts';
import { DecisionCommandError } from './errors.ts';
import { canonicalJson } from '../policy/canonical.ts';
import { readLockedReviewPolicy } from '../policy/configuration.ts';

/** 本切片唯一已注册效果，所有资源和效果都在同一物理 DB 事务。 */
export const DB_REVIEW_HANDLER:DbReviewHandlerDescriptorV1=Object.freeze({handlerId:'s1.review-decide.db/v1',revision:1,
  kind:'review.decide',available:true,effects:'single-database-transaction',resources:'database-only',
  delegation:'none',deferredEffects:'none',grantUse:'none'});

interface EffectInput {actor:Actor;path:'reviewer'|'management';action:ReviewPolicyActionV1;observation:PolicyObservation;
  resultRef:DecisionRef;reason:string;executionId:string;resolutionId:string;at:string}
const permits=new WeakMap<object,{guard:ReviewLockedTransaction;input:EffectInput;token:object}>(),permitKey=Symbol('decision.current.effect');
/** 只由唯一 resolver 在当前完整 resolution 写入后调用；不从 DTO、历史回执或 policy outcome 构造。 */
export async function currentReviewEffect(guard:ReviewLockedTransaction,input:EffectInput):Promise<CurrentDbReviewEffectGuard> {
  const {db,repos,slot}=assertReviewTransaction(guard),subject=await readCurrentReview(repos,slot);
  assertReviewPath(input.actor,subject,input.path,input.action.payload.choice);
  if(reviewAction(subject,input.action.payload.choice).actionDigest!==input.resultRef.actionDigest
    ||input.observation.purpose!=='resolver-check'||input.observation.status!=='evaluated'||input.observation.outcome==='deny'
    ||input.observation.fullEvaluation.actionDigest!==input.resultRef.actionDigest
    ||input.observation.evaluationPrincipal?.id!==input.actor.actorId||input.observation.evaluationPrincipal.kind!==input.actor.kind) {
    throw new DecisionCommandError('candidate_changed','实际 Task 效果与当前受锁裁决不一致。');
  }
  const resolution=(await db.query('SELECT * FROM decision_resolutions WHERE project_id=? AND id=?',[slot.projectId,input.resolutionId]))[0];
  const policy=await readLockedReviewPolicy(guard);
  if(!resolution||resolution.decision_id!==input.resultRef.decisionId||resolution.choice_id!=='approve'
    ||resolution.actor_id!==input.actor.actorId||resolution.actor_kind!==input.actor.kind||resolution.actual_execution_path!==input.path
    ||Number(resolution.input_decision_revision)+1!==input.resultRef.revision||resolution.action_digest!==input.resultRef.actionDigest
    ||policy.policyRevision!==input.observation.policy.policyRevision
    ||canonicalJson(JSON.parse(String(resolution.policy_evaluation_json)))!==canonicalJson(input.observation)) {
    throw new DecisionCommandError('source_binding_mismatch','实际效果缺少本事务的完整当前裁决。');
  }
  if(input.actor.kind==='human') {
    const source=(await db.query('SELECT * FROM decision_local_initiations WHERE project_id=? AND id=?',[slot.projectId,resolution.initiation_id]))[0];
    if(!source||source.consumed_receipt_id!==resolution.command_receipt_id||source.request_digest!==resolution.request_digest
      ||source.decision_id!==resolution.decision_id||source.input_decision_revision!==resolution.input_decision_revision)
      throw new DecisionCommandError('source_binding_mismatch','本地来源不是当前裁决的同事务消费。');
  }
  const state=assertReviewTransaction(guard),token=Object.freeze({}),old=state.context.values.get(permitKey);
  state.context.values.set(permitKey,Object.freeze([...(Array.isArray(old)?old:[]),token]));
  const result=Object.freeze({transaction:guard,inputRef:{...input.resultRef,revision:input.resultRef.revision-1},actualActor:{kind:input.actor.kind,id:input.actor.actorId},
    actualPath:input.path,policy:input.observation.policy,permittedAction:input.action}) as CurrentDbReviewEffectGuard;
  permits.set(result,{guard,input,token});return result;
}
/** 真实 Task/Round mutation 仅接受本 resolver 刚签出的 opaque 当前 guard；保存点回滚使其失效。 */
export async function applyReviewEffect(permit:CurrentDbReviewEffectGuard):Promise<DbReviewExecution> {
  const issued=permits.get(permit);if(!issued)throw new DecisionCommandError('source_binding_mismatch','缺少当前效果 guard。');
  const {guard,input,token}=issued,{db,repos,slot,context}=assertReviewTransaction(guard),tokens=context.values.get(permitKey);
  if(!Array.isArray(tokens)||!tokens.includes(token))throw new DecisionCommandError('source_binding_mismatch','效果 guard 已失效或已消费。');
  context.values.set(permitKey,Object.freeze(tokens.filter(t=>t!==token)));
  const subject=await readCurrentReview(repos,slot);assertReviewPath(input.actor,subject,input.path,input.action.payload.choice);
  if(reviewAction(subject,input.action.payload.choice).actionDigest!==input.resultRef.actionDigest)throw new DecisionCommandError('candidate_changed','效果候选已变化。');
  const {task,round}=subject;
  const updated=await repos.tasks.updateCas(slot.projectId,task.id,task.revision,
    {state:input.action.payload.choice==='pass'?'done':'in-progress',blockedReason:null},input.at);
  const actor={kind:input.actor.kind,actorId:input.actor.actorId,
    displayName:input.actor.kind==='human'?'人（owner）':(await repos.members.get(input.actor.actorId))?.displayName??input.actor.actorId};
  const decision:NonNullable<ReviewRound['decision']>={verdict:input.action.payload.choice,actor,reason:input.reason,
    override:input.path==='management',taskRevision:updated.revision,decisionRef:input.resultRef};
  const historyId=randomUUID();
  const detail={roundId:round.id,previousDecision:round.decision,decision,decisionRef:input.resultRef};
  await repos.tasks.appendHistory({id:historyId,projectId:slot.projectId,taskId:task.id,action:'task.review_decided',
    actor,taskRevision:updated.revision,detail,createdAt:input.at});
  await appendAuditEntry(repos.audit,{projectId:slot.projectId,actor:auditActorFrom(input.actor),action:'task.review_decided',
    targetKind:'task',targetId:task.id,targetName:task.title,detail});
  const nextRound=await repos.tasks.updateRoundCas(slot.projectId,round.id,round.revision,{state:'decided',decision},input.at);
  const workEventIds:string[]=[];
  if(updated.assigneeMemberId) {
    const event=await repos.tasks.enqueueWorkEvent({id:randomUUID(),projectId:slot.projectId,taskId:task.id,
      recipientMemberId:updated.assigneeMemberId,kind:'task.review_decided',eventKey:`decision:${input.resultRef.decisionId}:effect`,
      payload:{taskId:task.id,revision:updated.revision,roundId:round.id,decision,decisionRef:input.resultRef,
        enteredDone:task.state!=='done'&&updated.state==='done',completionRevision:updated.revision,
        assigneeAgentId:subject.assignee?.kind==='agent'?subject.assignee.agentId:null},deliveryState:'pending',attempts:0,
      createdAt:input.at,firstDeliveredAt:null,lastDeliveredAt:null,ackedAt:null});
    workEventIds.push(event.id);await notifyWorkEventCommit(db,[event]);
  }
  await notifyResourceChange(db,{projectId:slot.projectId,entity:'task',id:task.id,revision:updated.revision});
  assertReviewTransaction(guard);
  return {kind:'db-review-execution/v1',id:input.executionId,decisionId:input.resultRef.decisionId,
    effectKey:`decision:${input.resultRef.decisionId}`,status:'succeeded',verdict:input.action.payload.choice,
    before:{taskRevision:task.revision,roundRevision:round.revision},after:{taskRevision:updated.revision,roundRevision:nextRound.revision},
    taskHistoryId:historyId,workEventIds};
}

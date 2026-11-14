/** 私有严格TEXT codec；B3 schema与摘要合同，不签发执行资格。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, normalizePolicyAction } from '../policy/canonical.ts';
import { policyActionSchema } from '../policy/schemas.ts';
import type { DecisionTextColumn } from './types.ts';

const s = z.string();
const id = z.string().min(1).max(200);
const n = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const time = z.string().datetime({ offset: true });
const reason = z.string().min(1).max(2000).refine(x => x === x.trim(), 'already normalized reason required');
const authority = z.enum(['auto','owner','human']);
const verdict = z.enum(['pass','changes_requested']);
const choice = z.enum(['approve','reject','request_changes']);
const actor = z.object({kind:z.enum(['human','agent']),id}).strict();
const slot = {projectId:id,taskId:id,roundId:id};
const decisionRef = z.object({decisionId:id,revision:n,actionDigest:digest,projectId:id}).strict();
const head = z.object({...slot,headRevision:n,currentDecisionId:id}).strict();
const policyRef = z.object({policyRevision:s,global:z.object({revision:n,contentDigest:hash}).strict(),
  project:z.object({revision:n,contentDigest:hash}).strict().nullable(),defaultRevision:n}).strict();
const kind = z.enum(['code','artifact','finding']);
const acceptanceSource = z.enum(['explicit','legacy_task_body']);
const report = z.object({axis:z.enum(['spec','standards']),id,contentSha256:hash,verdict}).strict();
const candidateEnvelope = z.object({...slot,task:z.object({title:s,body:s,labels:z.array(s),deliveryKind:kind.nullable(),
  acceptanceText:s,acceptanceSource,assigneeMemberId:id.nullable(),reviewerMemberId:id.nullable(),repoPath:s.nullable(),fixedPoint:s.nullable()}).strict(),
  roundSpecSnapshot:z.object({title:s,body:s,labels:z.array(s),deliveryKind:kind.nullable().optional(),acceptanceText:s.optional(),acceptanceSource:acceptanceSource.optional()}).strict(),
  candidate:z.object({repositoryRoot:s,fixedPointInput:s,baseCommit:s,candidateCommit:s,policy:z.literal('committed-clean'),
    diffSha256:hash,commits:z.array(z.object({sha:s,subject:s}).strict())}).strict(),
  reports:z.tuple([report.extend({axis:z.literal('spec')}),report.extend({axis:z.literal('standards')})])
}).strict().refine(x => canonicalJson(x.task.labels) === canonicalJson([...new Set(x.task.labels)].sort()), 'canonical task labels required');
const reviewAction = policyActionSchema.refine(x => x.kind === 'review.decide' && x.projectId !== null && x.candidateDigest !== null &&
  x.expectedSubjectRevisions.length === 2 && x.expectedSubjectRevisions[0]?.subjectRef.kind === 'review-round' &&
  x.expectedSubjectRevisions[1]?.subjectRef.kind === 'task', 'normalized review action required');
const policySource = z.object({scope:z.enum(['global','project','project-override','default','guard']),ruleId:s,
  revision:n.nullable(),projectId:id.nullable(),replacedGlobalRevision:n.optional()}).strict();
const policyReason = z.object({code:s,message:s,ruleId:s}).strict();
const outcome = z.enum(['auto','owner','human','deny']);
const evaluation = z.object({schemaVersion:z.literal(1),action:reviewAction,actionDigest:digest,mode:z.literal('observation'),
  executionAdmission:z.literal('not-issued'),stage:z.enum(['proposal','execution']),status:z.enum(['evaluated','evaluation_incomplete']),
  policyRevision:s,globalRevision:n,projectRevision:n.nullable(),defaultRevision:n,registryRevision:n,evaluatedAt:time,outcome,
  matchedRuleIds:z.array(s),matchedRules:z.array(z.object({ruleId:s,outcome,requiresFreshHuman:z.boolean(),source:policySource}).strict()),
  effectiveSource:z.array(policySource),grantRefs:z.array(z.object({grantId:id,revision:n,provenanceRef:id}).strict()).max(0),
  grantChecks:z.array(z.object({grantId:id,revision:n,matched:z.boolean(),reasons:z.array(s)}).strict()).max(0),
  requiresFreshHuman:z.boolean(),reasons:z.array(policyReason),missingFacts:z.array(s),
  executionPrerequisites:z.array(z.object({code:z.enum(['authorization_required','budget_increase_required','retry_increase_required',
    'candidate_refresh_required','delivery_checks_required','fresh_human_required']),message:s}).strict())
}).strict();
export const observationSchema = z.object({factsContract:z.literal('s1.db-review-locked/v1'),
  purpose:z.enum(['eligibility-observation','resolver-check']),evaluationPrincipal:actor.nullable(),mode:z.literal('observation'),
  executionAdmission:z.literal('not-issued'),status:z.enum(['evaluated','evaluation_incomplete']),outcome,requiresFreshHuman:z.boolean(),
  policy:policyRef,matchedRuleIds:z.array(s),reasons:z.array(policyReason),missingFacts:z.array(s),grantRefs:z.array(z.never()),
  evaluatedAt:time,fullEvaluation:evaluation}).strict().superRefine((x,ctx) => {
    for (const key of ['mode','executionAdmission','status','outcome','requiresFreshHuman','matchedRuleIds','reasons','missingFacts','grantRefs','evaluatedAt'] as const)
      if (canonicalJson(x[key]) !== canonicalJson(x.fullEvaluation[key])) ctx.addIssue({code:'custom',path:[key],message:'display/full evaluation mismatch'});
    if (x.policy.policyRevision !== x.fullEvaluation.policyRevision || x.policy.global.revision !== x.fullEvaluation.globalRevision ||
      (x.policy.project?.revision ?? null) !== x.fullEvaluation.projectRevision || x.policy.defaultRevision !== x.fullEvaluation.defaultRevision)
      ctx.addIssue({code:'custom',path:['policy'],message:'policy identity mismatch'});
  });
const requestInput = z.object({expectedTaskRevision:n,expectedRoundRevision:n,proposedVerdict:verdict,reason,
  requestedPath:z.enum(['reviewer','management']),expectedHead:head.optional()}).strict();
const resolveInput = z.object({decisionRef,choiceId:choice,reason}).strict();
const refreshInput = z.object({decisionRef}).strict();
const legacyInput = z.object({expectedTaskRevision:n,expectedRoundRevision:n,verdict,reason,override:z.boolean()}).strict();
export const commandSchema = z.discriminatedUnion('operation',[
  z.object({...slot,actor,operation:z.literal('request-review'),input:requestInput}).strict(),
  z.object({...slot,actor,operation:z.literal('resolve'),input:resolveInput}).strict(),
  z.object({...slot,actor,operation:z.literal('refresh'),input:refreshInput}).strict(),
  z.object({...slot,actor,operation:z.literal('legacy-decide'),input:legacyInput}).strict(),
]);
const uiCommand = z.object({kind:z.enum(['ui-decision-choice','legacy-decide']),command:commandSchema,clientMutationId:id}).strict()
  .refine(x => x.command.actor.kind === 'human' && x.command.actor.id === 'human:local' &&
    (x.kind === 'legacy-decide' ? x.command.operation === 'legacy-decide' : x.command.operation === 'resolve'), 'trusted UI shape required');
const permission = z.object({...slot,schemaVersion:z.literal('db-review-permissions/v1'),actor,active:z.boolean(),
  membershipRevision:n.nullable(),currentMembershipRevision:n.nullable(),projectActive:z.boolean(),readAllowed:z.boolean(),
  capability:z.enum(['task:review','task:override']).nullable(),capabilityAllowed:z.boolean(),inScope:z.boolean(),
  actualPath:z.enum(['reviewer','management','no-effect']),checkedAt:time}).strict();
const execution = z.discriminatedUnion('status',[
  z.object({kind:z.literal('db-review-execution/v1'),id,decisionId:id,effectKey:s,status:z.literal('succeeded'),verdict,
    before:z.object({taskRevision:n,roundRevision:n}).strict(),after:z.object({taskRevision:n,roundRevision:n}).strict(),
    taskHistoryId:id,workEventIds:z.array(id)}).strict(),
  z.object({kind:z.literal('db-review-execution/v1'),id,decisionId:id,effectKey:s,status:z.literal('not_required'),verdict:z.null()}).strict()
]);
const receipt = z.object({receiptId:id,operation:z.enum(['request-review','resolve','refresh','legacy-decide']),actor,requestDigest:digest,
  inputDecisionRef:decisionRef.nullable(),resultDecisionRef:decisionRef,head,result:z.enum(['pending','applied','not_required','refreshed']),
  httpStatus:z.union([z.literal(200),z.literal(202),z.literal(409)]),command:commandSchema,resolutionId:id.nullable(),
  execution:execution.nullable(),committedAt:time}).strict();
const taskAuthor = z.object({kind:z.enum(['human','agent']),actorId:id,displayName:s}).strict();
const materialPhase = z.object({reasonCodes:z.array(s),issues:z.array(z.object({code:s,field:s,message:s}).strict())}).strict();
const taskView = z.object({id,projectId:id,title:s,body:s,labels:z.array(s),state:z.enum(['todo','in-progress','review','blocked','done']),
  assigneeMemberId:id.nullable(),reviewerMemberId:id.nullable(),deliveryKind:kind.nullable(),acceptanceText:s,acceptanceSource,
  repoPath:s.nullable(),fixedPoint:s.nullable(),revision:n,currentReviewRoundId:id.nullable(),blockedReason:s.nullable(),
  author:taskAuthor,createdAt:time,updatedAt:time,materialStatus:z.object({scope:z.literal('task-materials'),executionAdmission:z.literal('not-issued'),
    startExecution:materialPhase,submitReview:materialPhase,complete:materialPhase}).strict()}).strict();
const response = z.object({schemaVersion:z.literal('decision-response/v1'),state:z.enum(['applied','pending','not_required','refreshed']),
  reason:z.literal('policy_changed').nullable(),receipt,task:taskView,decisionRef,head,requiredAuthority:authority.nullable(),blockedReason:s.nullable()}).strict()
  .superRefine((x,ctx) => {
    const expected = x.state === 'pending' ? 202 : x.state === 'refreshed' ? 409 : 200;
    const command=x.receipt.command;
    if (x.receipt.httpStatus !== expected || x.receipt.result !== x.state || (x.state === 'refreshed') !== (x.reason === 'policy_changed') ||
      canonicalJson(x.decisionRef) !== canonicalJson(x.receipt.resultDecisionRef) || canonicalJson(x.head) !== canonicalJson(x.receipt.head) ||
      x.receipt.operation !== command.operation || canonicalJson(x.receipt.actor) !== canonicalJson(command.actor) ||
      x.receipt.requestDigest !== commandDigest(command) || x.task.projectId !== command.projectId || x.task.id !== command.taskId)
      ctx.addIssue({code:'custom',message:'receipt response binding mismatch'});
    if (['pending','refreshed'].includes(x.state) && (x.receipt.resolutionId !== null || x.receipt.execution !== null))
      ctx.addIssue({code:'custom',message:'nonterminal receipt has execution'});
    if ((command.operation==='resolve'||command.operation==='refresh') &&
      (canonicalJson(x.receipt.inputDecisionRef)!==canonicalJson(command.input.decisionRef)||command.input.decisionRef.projectId!==command.projectId))
      ctx.addIssue({code:'custom',message:'receipt input does not match original command'});
    // This is the immutable committed Task snapshot, not a later current Task.
    if (x.state==='applied' && (x.receipt.execution?.status!=='succeeded'||x.task.revision!==x.receipt.execution.after.taskRevision))
      ctx.addIssue({code:'custom',message:'committed Task snapshot differs from execution after'});
  });

/** Registry keys are compile-time constants, never selected by HTTP/MCP input. */
const schemas: Record<DecisionTextColumn,z.ZodTypeAny> = {
  'decision_action_requests.action_json':reviewAction,
  'decision_action_requests.candidate_envelope_json':candidateEnvelope,
  'decision_action_requests.proposal_reason_json':reason,
  'decision_records.policy_evaluation_json':observationSchema,
  'decision_user_events.command_json':uiCommand,
  'decision_resolutions.reason_json':reason,
  'decision_resolutions.policy_evaluation_json':observationSchema,
  'decision_resolutions.permission_snapshot_json':permission,
  'decision_command_receipts.response_json':response,
  'decision_executions.work_event_ids_json':z.array(id).refine(x => new Set(x).size === x.length,'duplicate event id'),
};
export const TEXT_COLUMNS = Object.freeze(Object.keys(schemas) as DecisionTextColumn[]);
export { StorageInvalid } from './storage-error.ts';
import { StorageInvalid } from './storage-error.ts';
import { validateRawDecisionRow } from './row-validation.ts';
const fail = (column:string,stage:string):never => { throw new StorageInvalid(column,stage); };
export function encode(column:DecisionTextColumn,value:unknown):string {
  const parsed=schemas[column].safeParse(value);
  if (!parsed.success) return fail(column,'strict_schema');
  if (canonicalJson(parsed.data) !== canonicalJson(value)) return fail(column,'normalization_forbidden');
  if (column === 'decision_action_requests.action_json' && canonicalJson(normalizePolicyAction(value).action) !== canonicalJson(value))
    return fail(column,'action_not_normalized');
  return column.endsWith('.proposal_reason_json') || column.endsWith('.reason_json') ? JSON.stringify(value) : canonicalJson(value);
}
export function decode(column:DecisionTextColumn,raw:string):unknown {
  if (typeof raw !== 'string') return fail(column,'raw_not_text');
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return fail(column,'invalid_json'); }
  if (encode(column,value) !== raw) return fail(column,'noncanonical_text');
  return value;
}
export function hashDomain(domain:string,value:unknown):string {
  return createHash('sha256').update(`${domain}\n${canonicalJson(value)}`,'utf8').digest('hex');
}
export function commandDigest(command:unknown):string { return `sha256:${hashDomain('boardroom.decision-command.v1',command)}`; }
export function candidateDigest(candidate:unknown):string { return hashDomain('boardroom.review-candidate.v1',candidate); }
export function permissionDigest(snapshot:unknown):string { return hashDomain('boardroom.decision-permissions.v1',snapshot); }

/** Row validation is pure and never changes the original source row or its TEXT. */
export function validateCopyRow(table:string,row:Readonly<Record<string,unknown>>):void {
  validateRawDecisionRow(table,row);
  const decoded:Record<string,unknown>={};
  for (const key of TEXT_COLUMNS.filter(x => x.startsWith(`${table}.`))) {
    const col=key.slice(table.length+1);
    decoded[col]=decode(key,row[col] as string);
  }
  const check=(condition:boolean,field:string) => { if(!condition)fail(`${table}.${field}`,'binding_or_digest'); };
  if (table === 'decision_action_requests') {
    const action=reviewAction.parse(decoded.action_json), envelope=candidateEnvelope.parse(decoded.candidate_envelope_json);
    check(normalizePolicyAction(action).actionDigest === row.action_digest,'action_digest');
    check(candidateDigest(envelope) === row.candidate_digest && action.candidateDigest === row.candidate_digest,'candidate_digest');
    check(action.projectId === row.project_id && action.subjectRef.id === row.round_id &&
      action.expectedSubjectRevisions[0]?.subjectRef.id === row.round_id &&
      action.expectedSubjectRevisions[1]?.subjectRef.id === row.task_id &&
      action.expectedSubjectRevisions[0]?.revision === Number(row.expected_round_revision) &&
      action.expectedSubjectRevisions[1]?.revision === Number(row.expected_task_revision),'action_json');
    check(action.kind === 'review.decide' && action.payload.choice === row.proposed_verdict,'proposed_verdict');
    check(envelope.projectId === row.project_id && envelope.taskId === row.task_id && envelope.roundId === row.round_id,'candidate_envelope_json');
  }
  if (table === 'decision_records' || table === 'decision_resolutions') {
    const obs=observationSchema.parse(decoded.policy_evaluation_json);
    check(obs.fullEvaluation.actionDigest === row.action_digest && normalizePolicyAction(obs.fullEvaluation.action).actionDigest === row.action_digest,'policy_evaluation_json');
    check(obs.fullEvaluation.action.projectId === row.project_id && obs.fullEvaluation.action.subjectRef.id === row.round_id,'policy_evaluation_json');
  }
  if (table === 'decision_resolutions') {
    const p=permission.parse(decoded.permission_snapshot_json);
    check(permissionDigest(p) === row.permission_snapshot_digest,'permission_snapshot_digest');
    check(p.projectId === row.project_id && p.taskId === row.task_id && p.roundId === row.round_id &&
      p.actor.kind === row.actor_kind && p.actor.id === row.actor_id && p.actualPath === row.actual_execution_path,'permission_snapshot_json');
  }
  if (table === 'decision_user_events') {
    const c=uiCommand.parse(decoded.command_json);
    check(commandDigest(c.command) === row.request_digest && c.clientMutationId === row.client_mutation_id &&
      c.kind === row.command_kind && c.command.actor.kind === row.actor_kind && c.command.actor.id === row.actor_id &&
      c.command.projectId === row.project_id && c.command.taskId === row.task_id && c.command.roundId === row.round_id,'command_json');
    if(c.command.operation === 'resolve') check(c.command.input.decisionRef.decisionId === row.decision_id &&
      c.command.input.decisionRef.revision === Number(row.input_decision_revision) && c.command.input.decisionRef.actionDigest === row.action_digest &&
      c.command.input.choiceId === row.choice_id,'command_json');
    else check(row.choice_id === 'approve','choice_id');
  }
  if (table === 'decision_command_receipts') {
    const r=response.parse(decoded.response_json), c=r.receipt;
    check(c.receiptId === row.id && c.requestDigest === row.request_digest && c.operation === row.operation &&
      c.actor.kind === row.actor_kind && c.actor.id === row.actor_id && c.result === row.result_state &&
      c.httpStatus === Number(row.http_status) && c.resultDecisionRef.decisionId === row.result_decision_id &&
      c.resultDecisionRef.revision === Number(row.result_decision_revision) && c.resultDecisionRef.actionDigest === row.result_action_digest &&
      c.head.headRevision === Number(row.head_revision) && c.resolutionId === row.resolution_id &&
      c.command.projectId === row.project_id && c.command.taskId === row.task_id && c.command.roundId === row.round_id,'response_json');
  }
}
/** 不可变 execution 的逻辑快照；完整原行由上游 raw validator 校验。 */
function executionValueFromRow(row:Readonly<Record<string,unknown>>):z.infer<typeof execution> {
  const revision=(field:string):number => {
    const raw=row[field];
    if(typeof raw!=='number' && !(typeof raw==='string' && /^[1-9][0-9]*$/.test(raw)))
      return fail(`decision_executions.${field}`,'execution_revision');
    const value=Number(raw);
    if(!Number.isSafeInteger(value)||value<1)return fail(`decision_executions.${field}`,'execution_revision');
    return value;
  };
  const base={kind:'db-review-execution/v1',id:row.id,decisionId:row.decision_id,effectKey:row.effect_key,status:row.status,verdict:row.verdict};
  let value:unknown=base;
  if(row.status==='succeeded') {
    value={...base,before:{taskRevision:revision('before_task_revision'),roundRevision:revision('before_round_revision')},
      after:{taskRevision:revision('after_task_revision'),roundRevision:revision('after_round_revision')},
      taskHistoryId:row.task_history_id,workEventIds:decode('decision_executions.work_event_ids_json',row.work_event_ids_json as string)};
  } else if(row.status==='not_required') {
    if(['before_task_revision','before_round_revision','after_task_revision','after_round_revision','task_history_id'].some(k=>row[k]!==null)||
      canonicalJson(decode('decision_executions.work_event_ids_json',row.work_event_ids_json as string))!=='[]')
      return fail('decision_executions.status','no_effect_row_has_effect');
  }
  const parsed=execution.safeParse(value);
  if(!parsed.success)return fail('decision_executions','execution_shape');
  return parsed.data;
}
/** Extra cross-row rules supplement SQL FK checks; history is never reauthorized.
 * B3 binds execution values to action/receipt; it does not load actual Task,
 * history or WorkEvent source rows, or claim complete production M1 validation. */
export function validateDecisionBindings(rows:Readonly<Record<string,readonly Readonly<Record<string,unknown>>[]>>):void {
  for (const [table,entries] of Object.entries(rows)) for(const row of entries)validateCopyRow(table,row);
  const receipts=new Map((rows.decision_command_receipts ?? []).map(x=>[x.id,x]));
  const records=new Map((rows.decision_records ?? []).map(x=>[x.id,x]));
  const actions=new Map((rows.decision_action_requests ?? []).map(x=>[x.id,x]));
  const resolutions=new Map((rows.decision_resolutions ?? []).map(x=>[x.decision_id,x]));
  const executions=new Map((rows.decision_executions ?? []).map(x=>[x.decision_id,x]));
  const executionIds=new Map((rows.decision_executions ?? []).map(x=>[x.id,x]));
  const initiations=new Map((rows.decision_local_initiations ?? []).map(x=>[x.id,x]));
  const events=new Map((rows.decision_user_events ?? []).map(x=>[x.id,x]));
  for(const r of rows.decision_records ?? []) {
    const a=actions.get(r.action_request_id);
    if(!a || a.action_digest !== r.action_digest)fail('decision_records.action_request_id','missing_or_changed_action');
    const complete=resolutions.has(r.id)&&executions.has(r.id);
    if((r.status === 'resolved') !== complete || (r.status !== 'resolved' && (resolutions.has(r.id)||executions.has(r.id))))
      fail('decision_records.status','terminal_graph_incomplete');
  }
  for(const h of rows.decision_review_heads ?? []) {
    const r=records.get(h.current_decision_id);
    if(!r || Number(r.generation)!==Number(h.head_revision) || ['project_id','task_id','round_id'].some(k=>r[k]!==h[k]))
      fail('decision_review_heads.current_decision_id','head_slot_or_generation');
  }
  for(const r of rows.decision_resolutions ?? []) {
    const c=receipts.get(r.command_receipt_id);
    if(!c)fail('decision_resolutions.command_receipt_id','missing_receipt');
    const snapshot=response.parse(decode('decision_command_receipts.response_json',c!.response_json as string));
    const command=snapshot.receipt.command;
    const inputRef=snapshot.receipt.inputDecisionRef;
    const resolvedInput={decisionId:r.decision_id,revision:Number(r.input_decision_revision),actionDigest:r.action_digest,projectId:r.project_id};
    // Legacy commands may have no client DecisionRef; a saved derived ref still
    // denotes this resolution's original input. Native resolve always has one.
    if((command.operation==='resolve'||inputRef!==null) && canonicalJson(inputRef)!==canonicalJson(resolvedInput))
      fail('decision_command_receipts.inputDecisionRef','resolution_input_binding');
    if(!('reason' in command.input) || command.input.reason !== decode('decision_resolutions.reason_json',r.reason_json as string) ||
      snapshot.receipt.requestDigest !== r.request_digest || snapshot.receipt.resolutionId !== r.id)
      fail('decision_resolutions.reason_json','receipt_reason_or_fingerprint');
    const e=executions.get(r.decision_id);
    if(!e || e.resolution_id!==r.id || e.choice_id!==r.choice_id || (r.choice_id==='approve')!==(e.status==='succeeded') ||
      snapshot.receipt.execution?.id!==e.id)fail('decision_executions.resolution_id','execution_binding');
    const record=records.get(r.decision_id),actionRow=record&&actions.get(record.action_request_id);
    if(!record || !actionRow || ['project_id','task_id','round_id'].some(k=>e![k]!==r[k]||record[k]!==r[k]||actionRow[k]!==r[k]))
      fail('decision_executions.decision_id','execution_slot_binding');
    const logicalExecution=executionValueFromRow(e!);
    if(canonicalJson(logicalExecution)!==canonicalJson(snapshot.receipt.execution))
      fail('decision_executions','receipt_execution_values');
    const action=reviewAction.parse(decode('decision_action_requests.action_json',actionRow!.action_json as string));
    if(command.operation==='legacy-decide' && (command.input.expectedTaskRevision!==Number(actionRow!.expected_task_revision)||command.input.expectedRoundRevision!==Number(actionRow!.expected_round_revision)))
      fail('decision_command_receipts.command','legacy_input_revisions');
    if(logicalExecution.status==='succeeded') {
      if(action.kind!=='review.decide' || logicalExecution.verdict!==action.payload.choice || logicalExecution.verdict!==actionRow!.proposed_verdict ||
        logicalExecution.before.taskRevision!==action.expectedSubjectRevisions[1]?.revision ||
        logicalExecution.before.roundRevision!==action.expectedSubjectRevisions[0]?.revision ||
        logicalExecution.after.taskRevision!==logicalExecution.before.taskRevision+1 ||
        logicalExecution.after.roundRevision!==logicalExecution.before.roundRevision+1)
        fail('decision_executions','action_execution_values');
    }
    if(command.operation==='resolve' ? command.input.choiceId!==r.choice_id : command.operation!=='legacy-decide'||r.choice_id!=='approve'||
      action.kind!=='review.decide'||command.input.verdict!==action.payload.choice)
      fail('decision_resolutions.choice_id','command_choice_binding');
    if(r.actor_kind==='human') {
      if(r.authority!=='human')fail('decision_resolutions.authority','human_authority_required');
      const i=initiations.get(r.initiation_id),event=i&&events.get(i.user_event_id);
      if(!i || !event || i.consumed_receipt_id!==c!.id || c!.initiation_id!==i.id)
        fail('decision_resolutions.initiation_id','source_receipt_cycle');
      for(const key of ['project_id','task_id','round_id','decision_id','input_decision_revision','action_digest','choice_id','actor_kind','actor_id','request_digest']) {
        const equal=(a:unknown,b:unknown)=>key==='input_decision_revision'?Number(a)===Number(b):a===b;
        if(!equal(i![key],r[key])||!equal(event![key],r[key]))fail('decision_resolutions.initiation_id','source_binding');
      }
    } else if(r.initiation_id!==null || r.authority==='human')fail('decision_resolutions.authority','false_human_source');
  }
  for(const p of rows.decision_review_projections ?? [])if(p.source_kind==='live') {
    const e=executionIds.get(p.execution_id);
    if(!e || e.status!=='succeeded' || e.choice_id!=='approve')fail('decision_review_projections.execution_id','not_applied');
  }
}

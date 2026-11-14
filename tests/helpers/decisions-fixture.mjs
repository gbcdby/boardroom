import { createHash } from 'node:crypto';
import { decideTaskReviewSchema, parseTaskInput } from '../../src/server/tasks/schemas.ts';
import { policyDocumentsSchema } from '../../src/server/policy/schemas.ts';
import { normalizePolicyAction, canonicalJson } from '../../src/server/policy/canonical.ts';
import { evaluateAction } from '../../src/server/policy/evaluator.ts';
import { encode, commandDigest, candidateDigest, permissionDigest } from '../../src/server/decisions/text-codec.ts';

export const at='2026-11-12T00:00:00.000Z';
export const logicalReason=input => parseTaskInput(decideTaskReviewSchema,{expectedTaskRevision:3,expectedRoundRevision:5,verdict:'pass',reason:input,override:false}).reason;
export function fixture(input='理由',suffix='one') {
  const reason=logicalReason(input), projectId=`project-${suffix}`,taskId=`task-${suffix}`,roundId=`round-${suffix}`;
  const slot={projectId,taskId,roundId},actor={kind:'human',id:'human:local'};
  const ids=Object.fromEntries(['request','decision','event','initiation','resolution','execution','receipt','history','legacy'].map(x=>[x,`${x}-${suffix}`]));
  const envelope={...slot,task:{title:'测试任务',body:reason,labels:['a','b'],deliveryKind:'code',acceptanceText:reason,acceptanceSource:'explicit',assigneeMemberId:null,reviewerMemberId:null,repoPath:'/synthetic/repo',fixedPoint:'base'},
    roundSpecSnapshot:{title:'测试任务',body:reason,labels:['b','a'],deliveryKind:'code',acceptanceText:reason,acceptanceSource:'explicit'},
    candidate:{repositoryRoot:'/synthetic/repo',fixedPointInput:'base',baseCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40),policy:'committed-clean',diffSha256:'c'.repeat(64),commits:[{sha:'b'.repeat(40),subject:reason}]},
    reports:[{axis:'spec',id:`spec-${suffix}`,contentSha256:'d'.repeat(64),verdict:'pass'},{axis:'standards',id:`standards-${suffix}`,contentSha256:'e'.repeat(64),verdict:'pass'}]};
  const candidateHash=candidateDigest(envelope);
  const normalized=normalizePolicyAction({schemaVersion:1,kind:'review.decide',projectId,subjectRef:{kind:'review-round',id:roundId},
    expectedSubjectRevisions:[{subjectRef:{kind:'task',id:taskId},revision:3},{subjectRef:{kind:'review-round',id:roundId},revision:5}],candidateDigest:candidateHash,payload:{choice:'pass'}});
  const action=normalized.action,actionDigest=normalized.actionDigest;
  const policies=policyDocumentsSchema.parse({global:{schemaVersion:1,scope:'user',revision:1,rules:[{ruleId:'review-text',when:{actionKinds:['review.decide']},outcome:'owner',reason,requiresFreshHuman:false,locked:false,overridable:false}]}});
  const request={action,stage:'execution',policies,context:{evaluatedAt:at,policyRevision:'f'.repeat(64),registry:{revision:1,handlers:[{kind:'review.decide',handlerId:'isolated-old-kernel-fixture',revision:1,available:true}]},facts:{
    principal:{actorId:'human:local',active:true,membershipRevision:null,currentMembershipRevision:null},project:{projectId,active:true},
    subjects:action.expectedSubjectRevisions.map(x=>({...x,active:true,candidateDigest:candidateHash})),
    proposal:{readAllowed:true,createAllowed:true,inScope:true,kindAllowed:true,delegable:false,prohibited:false},
    execution:{resourceAccess:true,capabilityAllowed:true,inScope:true,authorizationCurrent:true,hostSupported:true,prohibited:false},
    authorization:{authorizationEpoch:7,existingAuthorization:true,grants:[]},budget:{requiredUnits:0,availableUnits:0,mayRequestIncrease:false},
    retries:{requested:0,available:0,mayRequestIncrease:false},userReserved:false}}};
  // Real released v1 evaluation with its required epoch. This is an old-output
  // text-domain fixture, NOT an implementation of the proposed no-epoch branch.
  const fullEvaluation=evaluateAction(request);
  const policy={policyRevision:fullEvaluation.policyRevision,global:{revision:1,contentDigest:'a'.repeat(64)},project:null,defaultRevision:fullEvaluation.defaultRevision};
  const obs={factsContract:'s1.db-review-locked/v1',purpose:'resolver-check',evaluationPrincipal:actor,mode:fullEvaluation.mode,
    executionAdmission:fullEvaluation.executionAdmission,status:fullEvaluation.status,outcome:fullEvaluation.outcome,
    requiresFreshHuman:fullEvaluation.requiresFreshHuman,policy,matchedRuleIds:fullEvaluation.matchedRuleIds,reasons:fullEvaluation.reasons,
    missingFacts:fullEvaluation.missingFacts,grantRefs:[],evaluatedAt:at,fullEvaluation};
  const inputRef={decisionId:ids.decision,revision:1,actionDigest,projectId}, resultRef={...inputRef,revision:2};
  const command={...slot,actor,operation:'resolve',input:{decisionRef:inputRef,choiceId:'approve',reason}};
  const fingerprint=commandDigest(command),head={...slot,headRevision:1,currentDecisionId:ids.decision};
  const permission={...slot,schemaVersion:'db-review-permissions/v1',actor,active:true,membershipRevision:null,currentMembershipRevision:null,
    projectActive:true,readAllowed:true,capability:'task:override',capabilityAllowed:true,inScope:true,actualPath:'management',checkedAt:at};
  const execution={kind:'db-review-execution/v1',id:ids.execution,decisionId:ids.decision,effectKey:`effect-${suffix}`,status:'succeeded',verdict:'pass',before:{taskRevision:3,roundRevision:5},after:{taskRevision:4,roundRevision:6},taskHistoryId:ids.history,workEventIds:[]};
  const receipt={receiptId:ids.receipt,operation:'resolve',actor,requestDigest:fingerprint,inputDecisionRef:inputRef,resultDecisionRef:resultRef,head,
    result:'applied',httpStatus:200,command,resolutionId:ids.resolution,execution,committedAt:at};
  const emptyPhase={reasonCodes:[],issues:[]};
  const task={id:taskId,projectId,...envelope.task,state:'done',revision:4,currentReviewRoundId:roundId,blockedReason:null,
    author:{kind:'human',actorId:'human:local',displayName:'本地用户'},createdAt:at,updatedAt:at,
    materialStatus:{scope:'task-materials',executionAdmission:'not-issued',startExecution:emptyPhase,submitReview:emptyPhase,complete:emptyPhase}};
  const response={schemaVersion:'decision-response/v1',state:'applied',reason:null,receipt,task,decisionRef:resultRef,head,requiredAuthority:'owner',blockedReason:null};
  const ui={kind:'ui-decision-choice',command,clientMutationId:`click-${suffix}`};
  const values={
    'decision_action_requests.action_json':action,
    'decision_action_requests.candidate_envelope_json':envelope,
    'decision_action_requests.proposal_reason_json':reason,
    'decision_records.policy_evaluation_json':obs,
    'decision_user_events.command_json':ui,
    'decision_resolutions.reason_json':reason,
    'decision_resolutions.policy_evaluation_json':obs,
    'decision_resolutions.permission_snapshot_json':permission,
    'decision_command_receipts.response_json':response,
    'decision_executions.work_event_ids_json':[],
  };
  const raw=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,encode(k,v)]));
  const dbslot={project_id:projectId,task_id:taskId,round_id:roundId};
  const bind={...dbslot,decision_id:ids.decision,input_decision_revision:1,action_digest:actionDigest,choice_id:'approve',actor_kind:'human',actor_id:'human:local',request_digest:fingerprint};
  const rows={
    decision_legacy_records:[{id:ids.legacy,...dbslot,source_table:'task_history',source_id:`old-history-${suffix}`,raw_text:canonicalJson({reason}),raw_digest:createHash('sha256').update(canonicalJson({reason})).digest('hex'),chain_status:'verified',diagnostics_json:'[]',imported_at:at}],
    decision_action_requests:[{id:ids.request,...dbslot,action_json:raw['decision_action_requests.action_json'],candidate_envelope_json:raw['decision_action_requests.candidate_envelope_json'],
      action_digest:actionDigest,candidate_digest:candidateHash,expected_task_revision:3,expected_round_revision:5,proposed_verdict:'pass',proposal_reason_json:raw['decision_action_requests.proposal_reason_json'],requested_path:'management',origin:'user-request',created_by_kind:'human',created_by_id:'human:local',created_at:at}],
    decision_records:[{id:ids.decision,...dbslot,action_request_id:ids.request,action_digest:actionDigest,generation:1,revision:2,status:'resolved',required_authority:'owner',assignee_member_id:null,blocked_reason_code:null,policy_evaluation_json:raw['decision_records.policy_evaluation_json'],predecessor_decision_id:null,predecessor_legacy_id:ids.legacy,created_at:at,updated_at:at}],
    decision_review_heads:[{...dbslot,head_revision:1,current_decision_id:ids.decision}],
    decision_user_events:[{id:ids.event,...bind,command_kind:ui.kind,client_mutation_id:ui.clientMutationId,command_json:raw['decision_user_events.command_json'],issued_at:at}],
    decision_local_initiations:[{id:ids.initiation,...bind,user_event_id:ids.event,nonce_hash:'1'.repeat(64),source_contract:'s1.local-db-decision-choice/v1',authority_basis:'same-transaction-current-permissions',transfer_mode:'same-transaction-only',consumed_receipt_id:ids.receipt,issued_at:at,consumed_at:at}],
    decision_resolutions:[{id:ids.resolution,...bind,authority:'human',reason_json:raw['decision_resolutions.reason_json'],actual_execution_path:'management',initiation_id:ids.initiation,command_receipt_id:ids.receipt,
      policy_evaluation_json:raw['decision_resolutions.policy_evaluation_json'],permission_snapshot_json:raw['decision_resolutions.permission_snapshot_json'],permission_snapshot_digest:permissionDigest(permission),resolved_at:at}],
    decision_executions:[{id:ids.execution,...dbslot,decision_id:ids.decision,resolution_id:ids.resolution,choice_id:'approve',effect_key:execution.effectKey,status:'succeeded',verdict:'pass',before_task_revision:3,before_round_revision:5,after_task_revision:4,after_round_revision:6,task_history_id:ids.history,work_event_ids_json:'[]',committed_at:at}],
    decision_command_receipts:[{id:ids.receipt,...dbslot,actor_kind:'human',actor_id:'human:local',operation:'resolve',idempotency_key:`key-${suffix}`,request_digest:fingerprint,input_decision_id:ids.decision,input_decision_revision:1,result_decision_id:ids.decision,result_decision_revision:2,result_action_digest:actionDigest,head_revision:1,result_state:'applied',http_status:200,resolution_id:ids.resolution,initiation_id:ids.initiation,response_json:raw['decision_command_receipts.response_json'],committed_at:at}],
    decision_review_projections:[{...dbslot,source_kind:'live',execution_id:ids.execution,legacy_id:null,applied_at:at}],
    decision_change_heads:[{project_id:projectId,revision:1}],
    decision_changes:[{project_id:projectId,revision:1,task_id:taskId,decision_id:ids.decision,decision_revision:2,kind:'resolved',created_at:at}],
  };
  rows.decision_local_initiations[0].nonce_hash=createHash('sha256').update(`fixture-nonce-${suffix}`).digest('hex');
  return {reason,slot,ids,values,raw,command,request,rows,task};
}

export function parentRows(f) {
  const {projectId,taskId,roundId}=f.slot;
  return {
    projects:[{id:projectId,name:'合成项目',created_at:at,updated_at:at}],
    tasks:[{id:taskId,project_id:projectId,title:'测试任务',body:'合成已完成任务',labels:'[]',state:'done',revision:4,current_review_round_id:roundId,author:JSON.stringify(f.task.author),created_at:at,updated_at:at,delivery_kind:'code',acceptance_text:'合成验收',acceptance_source:'explicit'}],
    task_review_rounds:[{id:roundId,task_id:taskId,project_id:projectId,revision:6,task_revision:3,state:'decided',reviewer_member_id:'historical-reviewer',spec_snapshot:JSON.stringify({title:'测试',body:'合成',labels:[]}),candidate:'{}',decision:JSON.stringify({reason:f.reason,verdict:'pass'}),created_at:at,updated_at:at}],
    task_history:[{id:f.ids.history,project_id:projectId,task_id:taskId,action:'task.review_decided',actor:JSON.stringify(f.task.author),task_revision:4,detail:JSON.stringify({reason:f.reason}),created_at:at}],
  };
}

/** 完整关系控制：是显式合成历史，不签发任何实际执行来源。 */
export function storageFixture(reason='历史\0\ud800',suffix='storage') {
  const f=fixture(reason,suffix), parents=parentRows(f), {projectId,taskId,roundId}=f.slot;
  const envelope=structuredClone(f.values['decision_action_requests.candidate_envelope_json']);
  envelope.task.assigneeMemberId=`recipient-${suffix}`;
  const reports=envelope.reports.map(report=>{
    const value={axis:report.axis,verdict:report.verdict,body:'历史报告',sources:[],evidence:[]};
    report.contentSha256=createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return {id:report.id,project_id:projectId,task_id:taskId,round_id:roundId,axis:report.axis,verdict:report.verdict,body:value.body,sources:'[]',evidence:'[]',content_sha256:report.contentSha256,created_at:at,author:JSON.stringify(f.task.author),author_actor_id:'human:local'};
  });
  const candidateHash=candidateDigest(envelope), action=normalizePolicyAction({...f.values['decision_action_requests.action_json'],candidateDigest:candidateHash});
  // 将全部历史快照中的原 action/candidate digest 一致换为本完整报告的 digest。
  const oldAction=f.rows.decision_action_requests[0].action_digest, oldCandidate=f.rows.decision_action_requests[0].candidate_digest;
  let rows=JSON.parse(JSON.stringify(f.rows).replaceAll(oldAction,action.actionDigest).replaceAll(oldCandidate,candidateHash));
  rows.decision_action_requests[0].candidate_envelope_json=encode('decision_action_requests.candidate_envelope_json',envelope);
  const response=JSON.parse(rows.decision_command_receipts[0].response_json);const fp=commandDigest(response.receipt.command);
  const oldFp=rows.decision_command_receipts[0].request_digest;rows=JSON.parse(JSON.stringify(rows).replaceAll(oldFp,fp));
  const ref={decisionId:f.ids.decision,revision:2,projectId,actionDigest:action.actionDigest};
  const decision={verdict:'pass',reason:f.reason,override:true,actor:f.task.author,decidedAt:at,decisionRef:ref};
  parents.task_review_rounds[0].spec_snapshot=JSON.stringify(envelope.roundSpecSnapshot);
  parents.task_review_rounds[0].candidate=JSON.stringify(envelope.candidate);
  parents.task_review_rounds[0].decision=JSON.stringify(decision);
  parents.task_history[0].detail=JSON.stringify({roundId,previousDecision:null,decision,decisionRef:ref});
  const oldHistory={...parents.task_history[0],id:rows.decision_legacy_records[0].source_id,task_revision:2,detail:'{"legacy":true}'};
  parents.task_history.push(oldHistory);
  rows.decision_legacy_records[0].raw_text=canonicalJson(oldHistory);
  rows.decision_legacy_records[0].raw_digest=createHash('sha256').update(rows.decision_legacy_records[0].raw_text).digest('hex');
  const eventId=`work-${suffix}`, memberId=`recipient-${suffix}`;
  const member={id:memberId,project_id:projectId,agent_id:null,kind:'human',display_name:'历史接收者',role:'normal',node_id:null,status:'active',created_at:at,updated_at:at,removed_at:null,membership_revision:1};
  const work={id:eventId,project_id:projectId,recipient_member_id:memberId,task_id:taskId,kind:'task.review_decided',event_key:`decision:${f.ids.decision}:effect`,payload:JSON.stringify({taskId,revision:4,roundId,decision,decisionRef:ref,enteredDone:true,completionRevision:4,assigneeAgentId:null}),delivery_state:'pending',attempts:0,created_at:at,first_delivered_at:null,last_delivered_at:null,acked_at:null};
  rows.decision_executions[0].work_event_ids_json=encode('decision_executions.work_event_ids_json',[eventId]);
  const resp=JSON.parse(rows.decision_command_receipts[0].response_json);resp.task.assigneeMemberId=memberId;resp.receipt.execution.workEventIds=[eventId];rows.decision_command_receipts[0].response_json=encode('decision_command_receipts.response_json',resp);
  return {...f,rows,graph:{...parents,members:[member],task_review_reports:reports,work_events:[work],...rows}};
}

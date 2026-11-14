import { createHash } from 'node:crypto';
import { canonicalJson } from '../policy/canonical.ts';
import { DECISION_TABLES, DECISION_TABLE_BY_NAME } from './tables.ts';
import { validateCopyRow, validateDecisionBindings, decode } from './text-codec.ts';
import { StorageInvalid } from './storage-error.ts';
import type { RepoCtx } from '../db/repositories.ts';

export type StorageRow = Readonly<Record<string,unknown>>;
export type DecisionStorageGraph = Readonly<Record<string,readonly StorageRow[]>>;
function fail(field:string,stage:string):never {throw new StorageInvalid(field,stage);}
function object(value:unknown,field:string):Record<string,unknown> {
  if(value===null||typeof value!=='object'||Array.isArray(value))return fail(field,'object');
  return value as Record<string,unknown>;
}
function json(raw:unknown,field:string):Record<string,unknown> {
  if(typeof raw!=='string')return fail(field,'raw_text');
  try{return object(JSON.parse(raw),field);}catch(error){if(error instanceof StorageInvalid)throw error;return fail(field,'json');}
}
function array(value:unknown,field:string):readonly unknown[] {if(!Array.isArray(value))return fail(field,'array');return value;}
const eq=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const slotKeys=['project_id','task_id','round_id'] as const;
const sameSlot=(a:StorageRow,b:StorageRow)=>slotKeys.every(k=>a[k]===b[k]);

/** Bind completion to its immutable candidate/history, never current Task state. */
function validateCompletionEvent(event:StorageRow, execution:StorageRow, record:StorageRow, action:StorageRow,
  history:StorageRow, member:StorageRow|undefined, previousHistory:StorageRow|undefined):void {
  const envelope=object(decode('decision_action_requests.candidate_envelope_json',action.candidate_envelope_json as string),'candidate');
  const candidateTask=object(envelope.task,'candidate.task'), detail=json(history.detail,'history.detail');
  const decision=object(detail.decision,'history.decision'), previous=detail.previousDecision===null?null:object(detail.previousDecision,'history.previousDecision');
  const ref={decisionId:record.id,projectId:record.project_id,revision:Number(record.revision),actionDigest:record.action_digest};
  const ids=array(decode('decision_executions.work_event_ids_json',execution.work_event_ids_json as string),'event_ids');
  if(execution.status!=='succeeded'||execution.decision_id!==record.id||record.action_request_id!==action.id||!sameSlot(execution,record)||!sameSlot(action,record)
    ||history.id!==execution.task_history_id||history.project_id!==execution.project_id||history.task_id!==execution.task_id
    ||history.action!=='task.review_decided'||Number(history.task_revision)!==Number(execution.after_task_revision)
    ||ids.length!==1||ids[0]!==event.id||!member||member.id!==candidateTask.assigneeMemberId||member.project_id!==execution.project_id
    ||event.project_id!==execution.project_id||event.task_id!==execution.task_id||event.recipient_member_id!==member.id
    ||event.kind!=='task.review_decided'||event.event_key!==`decision:${record.id}:effect`)fail('decision_executions','completion_binding');
  if(previous&&(!['pass','changes_requested'].includes(String(previous.verdict))||Number(previous.taskRevision)!==Number(execution.before_task_revision)
    ||!previousHistory||previousHistory.project_id!==execution.project_id||previousHistory.task_id!==execution.task_id
    ||previousHistory.action!=='task.review_decided'||Number(previousHistory.task_revision)!==Number(execution.before_task_revision)
    ||json(previousHistory.detail,'previous_history.detail').roundId!==execution.round_id
    ||!eq(json(previousHistory.detail,'previous_history.detail').decision,previous)))fail('decision_executions','previous_effect_binding');
  const payload=json(event.payload,'work_event.payload');
  if(detail.roundId!==execution.round_id||!eq(detail.decisionRef??decision.decisionRef,ref)||decision.verdict!==execution.verdict
    ||payload.taskId!==execution.task_id||Number(payload.revision)!==Number(execution.after_task_revision)||payload.roundId!==execution.round_id
    ||!eq(payload.decisionRef??object(payload.decision,'event.decision').decisionRef,ref)||!eq(payload.decision,decision)
    ||Number(payload.completionRevision)!==Number(execution.after_task_revision)
    ||payload.assigneeAgentId!==(member.kind==='agent'?member.agent_id:null)
    ||payload.enteredDone!==(execution.verdict==='pass'&&previous?.verdict!=='pass'))fail('decision_executions','completion_values');
}

/** Memory checks the exact immutable execution membership of each bounded raw
 * source row. Pre-Decision events retain their existing interpretation. */
export async function validateLiveCompletionSource(ctx:Pick<RepoCtx,'one'|'query'>, event:StorageRow):Promise<void> {
  if(!await ctx.one('SELECT version FROM schema_migrations WHERE version=20'))return;
  const pattern='%'+JSON.stringify(event.id).replace(/[\^%_]/g,'^$&')+'%';
  const executions=await ctx.query("SELECT * FROM decision_executions WHERE project_id=? AND task_id=? AND work_event_ids_json LIKE ? ESCAPE '^' LIMIT 2",
    [event.project_id,event.task_id,pattern]);
  if(!executions.length) {
    let payload:unknown;
    try{payload=JSON.parse(String(event.payload));}catch{payload=null;}
    if(payload&&typeof payload==='object'&&Object.hasOwn(payload,'decisionRef')||String(event.event_key).startsWith('decision:'))fail('decision_executions','missing_completion_source');
    return;
  }
  if(executions.length!==1)fail('decision_executions','duplicate_completion_source');
  const execution=executions[0]!,record=await ctx.one('SELECT * FROM decision_records WHERE project_id=? AND id=?',[event.project_id,execution.decision_id]);
  const history=await ctx.one('SELECT * FROM task_history WHERE project_id=? AND id=?',[event.project_id,execution.task_history_id]);
  const action=record&&await ctx.one('SELECT * FROM decision_action_requests WHERE project_id=? AND id=?',[event.project_id,record.action_request_id]);
  if(!record||!history||!action)fail('decision_executions','missing_completion_source');
  const candidate=object(object(decode('decision_action_requests.candidate_envelope_json',action.candidate_envelope_json as string),'candidate').task,'candidate.task');
  const member=await ctx.one('SELECT id,project_id,kind,agent_id FROM members WHERE project_id=? AND id=?',[event.project_id,candidate.assigneeMemberId]);
  const previous=await ctx.one("SELECT * FROM task_history WHERE project_id=? AND task_id=? AND task_revision=? AND action='task.review_decided'",
    [event.project_id,event.task_id,execution.before_task_revision]);
  validateCompletionEvent(event,execution,record,action,history,member,previous);
}

/** 同一批原源行的完整结构/实体绑定；不重读源、不重新判断历史权限。M1协调另行接入。 */
export function validateDecisionStorageGraph(graph:DecisionStorageGraph):void {
  const rows=(table:string):readonly StorageRow[]=>graph[table]??[];
  const rowKey=(table:string,row:StorageRow,columns:readonly string[])=>canonicalJson(columns.map(k=>{
    const value=row[k];return DECISION_TABLE_BY_NAME.get(table)?.columns.find(c=>c.name===k)?.integer&&value!==null?Number(value):value;
  }));
  const indexes=new Map<string,Set<string>>();
  for(const spec of DECISION_TABLES) {
    if(!Object.hasOwn(graph,spec.name)||!Array.isArray(graph[spec.name]))fail(spec.name,'table_missing');
    for(const row of rows(spec.name))validateCopyRow(spec.name,row);
    for(const keys of spec.uniqueKeys) {
      const seen=new Set<string>();
      for(const row of rows(spec.name)) {if(keys.some(k=>row[k]===null))continue;const k=rowKey(spec.name,row,keys);if(seen.has(k))fail(spec.name,'unique');seen.add(k);}
    }
    for(const fk of spec.foreignKeys) {
      const cacheKey=`${fk.table}:${fk.targetColumns.join(',')}`;
      let keys=indexes.get(cacheKey);if(!keys){keys=new Set(rows(fk.table).map(r=>rowKey(fk.table,r,fk.targetColumns)));indexes.set(cacheKey,keys);}
      for(const row of rows(spec.name)) {
        if(fk.columns.some(k=>row[k]===null))continue;
        const comparable=Object.fromEntries(fk.targetColumns.map((k,i)=>[k,row[fk.columns[i]!] ]));
        if(!keys.has(rowKey(fk.table,comparable,fk.targetColumns)))fail(`${spec.name}.${fk.columns.join(',')}`,'foreign_key');
      }
    }
  }
  validateDecisionBindings(Object.fromEntries(DECISION_TABLES.map(t=>[t.name,rows(t.name)])));
  const byId=(table:string)=>new Map(rows(table).map(r=>[r.id,r]));
  const tasks=byId('tasks'),rounds=byId('task_review_rounds'),reports=byId('task_review_reports');
  const actions=byId('decision_action_requests'),records=byId('decision_records'),histories=byId('task_history'),events=byId('work_events');
  const resolutions=byId('decision_resolutions'),receipts=byId('decision_command_receipts');
  for(const action of rows('decision_action_requests')) {
    if(rows('decision_records').filter(r=>r.action_request_id===action.id).length!==1)fail('decision_action_requests','record_binding');
    const task=tasks.get(action.task_id),round=rounds.get(action.round_id);
    if(!task||!round||task.project_id!==action.project_id||!sameSlot({...round,round_id:round.id},action)||Number(task.revision)<Number(action.expected_task_revision)||Number(round.revision)<Number(action.expected_round_revision))fail('decision_action_requests','subject_binding');
    const envelope=object(decode('decision_action_requests.candidate_envelope_json',action.candidate_envelope_json as string),'candidate');
    if(!eq(envelope.roundSpecSnapshot,json(round.spec_snapshot,'round.spec_snapshot')))fail('decision_action_requests','round_spec');
    const candidate=object(envelope.candidate,'candidate'),actualCandidate=json(round.candidate,'round.candidate');
    if(!eq(candidate,Object.fromEntries(Object.keys(candidate).map(k=>[k,actualCandidate[k]]))))fail('decision_action_requests','candidate_identity');
    for(const value of array(envelope.reports,'reports')) {
      const ref=object(value,'report'),report=reports.get(ref.id);
      if(!report||!sameSlot(report,action)||report.axis!==ref.axis||report.verdict!==ref.verdict||report.content_sha256!==ref.contentSha256)fail('decision_action_requests','report_binding');
      let sources:unknown,evidence:unknown;try{sources=JSON.parse(report.sources as string);evidence=JSON.parse(report.evidence as string);}catch{return fail('task_review_reports','json');}
      const digest=createHash('sha256').update(JSON.stringify({axis:report.axis,verdict:report.verdict,body:report.body,sources,evidence})).digest('hex');
      if(digest!==report.content_sha256)fail('task_review_reports','content_digest');
    }
  }
  for(const record of rows('decision_records')) {
    const head=rows('decision_review_heads').find(r=>sameSlot(record,r));
    if(!head||Number(head.head_revision)<Number(record.generation))fail('decision_records','missing_head');
    if(record.predecessor_decision_id!==null) {
      const predecessor=records.get(record.predecessor_decision_id);
      if(!predecessor||predecessor.status==='pending'||Number(predecessor.generation)+1!==Number(record.generation))fail('decision_records','predecessor');
    } else if(Number(record.generation)!==1)fail('decision_records','initial_generation');
  }
  for(const receipt of rows('decision_command_receipts')) {
    const snapshot=object(decode('decision_command_receipts.response_json',receipt.response_json as string),'receipt'),saved=object(snapshot.receipt,'receipt');
    const input=saved.inputDecisionRef===null?null:object(saved.inputDecisionRef,'inputRef');
    if((input===null)!==(receipt.input_decision_id===null)||input&&(input.decisionId!==receipt.input_decision_id||Number(input.revision)!==Number(receipt.input_decision_revision)))fail('decision_command_receipts','input_ref');
    if(input!==null){
      const original=records.get(input.decisionId);
      if(!original||!sameSlot(original,receipt)||input.projectId!==original.project_id||input.actionDigest!==original.action_digest||Number(input.revision)>Number(original.revision))fail('decision_command_receipts','input_record');
    }
    const current=records.get(receipt.result_decision_id),ref=object(saved.resultDecisionRef,'resultRef'),head=object(saved.head,'head');
    if(!current||!sameSlot(current,receipt)||Number(receipt.result_decision_revision)>Number(current.revision)||ref.projectId!==receipt.project_id||ref.actionDigest!==current.action_digest||head.projectId!==receipt.project_id||head.taskId!==receipt.task_id||head.roundId!==receipt.round_id||head.currentDecisionId!==current.id||Number(head.headRevision)!==Number(current.generation))fail('decision_command_receipts','result_ref');
  }
  for(const resolution of rows('decision_resolutions')) {
    const record=records.get(resolution.decision_id),receipt=receipts.get(resolution.command_receipt_id);
    if(!record||Number(resolution.input_decision_revision)+1!==Number(record.revision)||!receipt||receipt.actor_id!==resolution.actor_id||receipt.actor_kind!==resolution.actor_kind||receipt.request_digest!==resolution.request_digest||receipt.committed_at!==resolution.resolved_at)fail('decision_resolutions','receipt_binding');
  }
  for(const initiation of rows('decision_local_initiations')) {
    const receipt=receipts.get(initiation.consumed_receipt_id);
    if(!receipt||receipt.committed_at!==initiation.consumed_at||rows('decision_resolutions').filter(r=>r.initiation_id===initiation.id).length!==1)fail('decision_local_initiations','consumption');
  }
  for(const event of rows('decision_user_events'))if(rows('decision_local_initiations').filter(r=>r.user_event_id===event.id).length!==1)fail('decision_user_events','consumption');
  const usedEvents=new Set<unknown>();
  for(const execution of rows('decision_executions')) {
    if(execution.status!=='succeeded')continue;
    const task=tasks.get(execution.task_id),round=rounds.get(execution.round_id),history=histories.get(execution.task_history_id),resolution=resolutions.get(execution.resolution_id),record=records.get(execution.decision_id);
    if(!task||!round||!history||!resolution||!record||Number(task.revision)<Number(execution.after_task_revision)||Number(round.revision)<Number(execution.after_round_revision)||history.task_id!==execution.task_id||history.project_id!==execution.project_id||history.action!=='task.review_decided'||Number(history.task_revision)!==Number(execution.after_task_revision))fail('decision_executions','actual_history');
    const detail=json(history.detail,'history.detail'),decision=object(detail.decision,'history.decision'),actor=json(history.actor,'history.actor');
    const ref={decisionId:record.id,projectId:record.project_id,revision:Number(record.revision),actionDigest:record.action_digest};
    if(detail.roundId!==execution.round_id||!eq(detail.decisionRef??decision.decisionRef,ref)||decision.verdict!==execution.verdict||decision.reason!==decode('decision_resolutions.reason_json',resolution.reason_json as string)||decision.override!==(resolution.actual_execution_path==='management')||actor.kind!==resolution.actor_kind||actor.actorId!==resolution.actor_id||!eq(decision.actor,actor))fail('decision_executions','history_values');
    const action=actions.get(record.action_request_id)!;
    const candidateTask=object(object(decode('decision_action_requests.candidate_envelope_json',action.candidate_envelope_json as string),'candidate').task,'candidate.task');
    const ids=array(decode('decision_executions.work_event_ids_json',execution.work_event_ids_json as string),'event_ids');
    if(ids.length!==(candidateTask.assigneeMemberId===null?0:1))fail('decision_executions','completion_event_set');
    for(const id of ids) {
      const event=events.get(id);if(!event||usedEvents.has(id)||event.project_id!==execution.project_id||event.task_id!==execution.task_id||event.kind!=='task.review_decided')fail('decision_executions','actual_event');usedEvents.add(id);
      validateCompletionEvent(event,execution,record,action,history,rows('members').find(m=>m.id===candidateTask.assigneeMemberId),
        rows('task_history').find(h=>h.project_id===execution.project_id&&h.task_id===execution.task_id&&Number(h.task_revision)===Number(execution.before_task_revision)&&h.action==='task.review_decided'));
    }
  }
  for(const projection of rows('decision_review_projections')) {
    if(projection.source_kind!=='live')continue;
    const execution=rows('decision_executions').find(r=>r.id===projection.execution_id),round=rounds.get(projection.round_id);
    const history=execution&&histories.get(execution.task_history_id);
    if(!round||!history||!eq(json(round.decision,'round.decision'),json(history.detail,'history.detail').decision))fail('decision_review_projections','actual_projection');
  }
  for(const legacy of rows('decision_legacy_records')) {
    const raw=json(legacy.raw_text,'legacy.raw_text'),source=byId(legacy.source_table as string).get(legacy.source_id);
    if(!source||raw.id!==source.id||raw.project_id!==legacy.project_id||raw.task_id!==legacy.task_id||!eq(Object.keys(raw).sort(),Object.keys(source).sort())||canonicalJson(raw)!==legacy.raw_text)fail('decision_legacy_records','source_row');
    if(legacy.source_table==='task_history'?!eq(raw,source):!Number.isSafeInteger(Number(raw.revision))||Number(raw.revision)>Number(source.revision))fail('decision_legacy_records','source_values');
  }
  for(const head of rows('decision_change_heads')) {
    let max=0;for(const change of rows('decision_changes'))if(change.project_id===head.project_id)max=Math.max(max,Number(change.revision));
    if(max!==Number(head.revision))fail('decision_change_heads','cursor');
  }
  for(const change of rows('decision_changes')) {
    const record=records.get(change.decision_id);
    if(!record||record.task_id!==change.task_id||Number(change.decision_revision)>Number(record.revision)||!rows('decision_change_heads').some(h=>h.project_id===change.project_id))fail('decision_changes','decision_revision');
  }
}

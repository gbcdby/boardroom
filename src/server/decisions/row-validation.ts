import { createHash } from 'node:crypto';
import { DECISION_TABLE_BY_NAME } from './tables.ts';
import { StorageInvalid } from './storage-error.ts';
import { canonicalJson } from '../policy/canonical.ts';

export function storageInteger(value:unknown,field:string):number {
  if(typeof value!=='number' && !(typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value))) throw new StorageInvalid(field,'integer');
  const n=Number(value);
  if(!Number.isSafeInteger(n)) throw new StorageInvalid(field,'integer_range');
  return n;
}
/** 完整 raw Row 边界；不改源值，不修复 TEXT，也不把 SQL CHECK 当授权。 */
export function validateRawDecisionRow(table:string,row:Readonly<Record<string,unknown>>):void {
  const spec=DECISION_TABLE_BY_NAME.get(table);
  const fail=(field:string,stage='row_shape'):never=>{throw new StorageInvalid(`${table}.${field}`,stage);};
  if(!spec || row===null || typeof row!=='object' || Array.isArray(row))return fail('*');
  if(Object.keys(row).length!==spec.columns.length || spec.columns.some(c=>!Object.hasOwn(row,c.name)))return fail('*','columns');
  for(const c of spec.columns) {
    const v=row[c.name];
    if(v===null) {if(c.nullable)continue;return fail(c.name,'null');}
    if(c.integer) {const n=storageInteger(v,`${table}.${c.name}`);if(c.positive&&n<1)return fail(c.name,'positive');}
    else {
      if(typeof v!=='string')return fail(c.name,'text');
      if(c.values&&!c.values.includes(v))return fail(c.name,'enum');
      if((c.name==='id'||c.name.endsWith('_id')||c.name==='effect_key'||c.name==='idempotency_key') && (v.length<1||v.length>200||v!==v.trim()||/[\u0000\r\n]/.test(v)))return fail(c.name,'identifier');
      if(c.name.endsWith('_at') && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v))))return fail(c.name,'timestamp');
      if(/^(?:candidate_digest|raw_digest|nonce_hash|permission_snapshot_digest)$/.test(c.name)&&!/^[0-9a-f]{64}$/.test(v))return fail(c.name,'digest');
      if(/^(?:action_digest|result_action_digest|request_digest)$/.test(c.name)&&!/^sha256:[0-9a-f]{64}$/.test(v))return fail(c.name,'digest');
    }
  }
  if(table==='decision_legacy_records') {
    if(createHash('sha256').update(row.raw_text as string).digest('hex')!==row.raw_digest)return fail('raw_digest','digest');
    let diagnostics:unknown;try{diagnostics=JSON.parse(row.diagnostics_json as string);}catch{return fail('diagnostics_json','json');}
    if(!Array.isArray(diagnostics)||diagnostics.some(x=>typeof x!=='string')||canonicalJson(diagnostics)!==row.diagnostics_json)return fail('diagnostics_json','diagnostics');
  }
  if(table==='decision_action_requests') {
    if(row.created_by_kind==='system') {if(row.created_by_id!=='review-materializer'||row.requested_path!=='materializer')return fail('created_by_kind');}
    else if(row.requested_path==='materializer')return fail('requested_path');
  }
  if(table==='decision_records' && ((row.predecessor_decision_id!==null&&row.predecessor_legacy_id!==null)||row.predecessor_decision_id===row.id))return fail('predecessor_decision_id');
  if(table==='decision_user_events'||table==='decision_local_initiations') {
    if(row.actor_kind!=='human'||row.actor_id!=='human:local')return fail('actor_id');
  }
  if(table==='decision_resolutions') {
    if(row.actor_kind==='human' ? row.actor_id!=='human:local'||row.initiation_id===null||row.authority!=='human' : row.initiation_id!==null||row.authority==='human')return fail('authority');
    if(row.choice_id==='approve' ? row.actual_execution_path==='no-effect' : row.actual_execution_path!=='no-effect')return fail('actual_execution_path');
  }
  if(table==='decision_command_receipts') {
    if((row.input_decision_id===null)!==(row.input_decision_revision===null))return fail('input_decision_revision');
    const status=Number(row.http_status);
    if(![200,202,409].includes(status))return fail('http_status','enum');
    if(row.result_state==='applied'||row.result_state==='not_required') {
      if(status!==200||row.resolution_id===null)return fail('result_state');
    } else if(status!==(row.result_state==='pending'?202:409)||row.resolution_id!==null||row.initiation_id!==null)return fail('result_state');
  }
  if(table==='decision_executions') {
    const fields=['before_task_revision','before_round_revision','after_task_revision','after_round_revision','task_history_id'];
    if(row.status==='not_required' && (row.verdict!==null||fields.some(k=>row[k]!==null)||row.work_event_ids_json!=='[]'||row.choice_id==='approve'))return fail('status');
    if(row.status==='succeeded' && (row.choice_id!=='approve'||row.verdict===null||fields.some(k=>row[k]===null)||Number(row.after_task_revision)!==Number(row.before_task_revision)+1||Number(row.after_round_revision)!==Number(row.before_round_revision)+1))return fail('status');
  }
  if(table==='decision_review_projections' && (row.source_kind==='live' ? row.execution_id===null||row.legacy_id!==null : row.legacy_id===null||row.execution_id!==null))return fail('source_kind');
}

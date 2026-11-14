import { createHash } from 'node:crypto';
import { canonicalJson } from '../policy/canonical.ts';
import { validateCopyRow } from './text-codec.ts';
import type { StorageRow } from './storage-validation.ts';

interface LegacyInput {projectId:string;taskId:string;histories:readonly StorageRow[];rounds:readonly StorageRow[];at:string;liveHistoryIds:ReadonlySet<string>}
type Row=Record<string,unknown>;
function parsed(raw:unknown):Row|null {try{const value=typeof raw==='string'?JSON.parse(raw):raw;return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:null;}catch{return null;}}
function decision(value:unknown):Row|null {
  const d=parsed(value),actor=d&&parsed(d.actor);
  return d&&(d.verdict==='pass'||d.verdict==='changes_requested')&&typeof d.reason==='string'&&d.reason.trim()===d.reason&&d.reason.length>=1&&d.reason.length<=2000&&typeof d.override==='boolean'&&Number.isSafeInteger(d.taskRevision)&&Number(d.taskRevision)>0&&actor&&(actor.kind==='human'||actor.kind==='agent')&&typeof actor.actorId==='string'?d:null;
}
/** 旧 Row 只作历史与诊断；绝不合成 UserInitiation、批准、Task效果或完成事件。 */
export function planLegacyImport(input:LegacyInput):{rows:Row[];projections:Row[]} {
  const rows:Row[]=[],projections:Row[]=[];
  const rounds=new Map(input.rounds.filter(r=>r.project_id===input.projectId&&r.task_id===input.taskId).map(r=>[r.id,r]));
  const histories=new Map<unknown,{row:Row;source:StorageRow;detail:Row;decision:Row}[]>();
  const make=(table:string,source:StorageRow,roundId:unknown,status:string,codes:string[]):Row=>{
    const raw=canonicalJson(source),row={id:`legacy-${createHash('sha256').update(canonicalJson([input.projectId,table,source.id])).digest('hex')}`,project_id:input.projectId,task_id:input.taskId,round_id:roundId??null,source_table:table,source_id:source.id,raw_text:raw,raw_digest:createHash('sha256').update(raw).digest('hex'),chain_status:status,diagnostics_json:canonicalJson([...new Set(codes)].sort()),imported_at:input.at};
    rows.push(row);return row;
  };
  const mark=(row:Row,code:string)=>{row.chain_status='ambiguous';row.diagnostics_json=canonicalJson([...new Set([...(JSON.parse(row.diagnostics_json as string) as string[]),code])].sort());};
  for(const source of input.histories) {
    if(source.action!=='task.review_decided'||input.liveHistoryIds.has(String(source.id)))continue;
    const detail=parsed(source.detail),d=detail&&decision(detail.decision),round=detail&&rounds.get(detail.roundId);const codes:string[]=[];
    if(source.project_id!==input.projectId||source.task_id!==input.taskId)codes.push('source_scope_mismatch');
    if(!detail)codes.push('history_detail_invalid');if(!d)codes.push('decision_invalid');
    if(!Number.isSafeInteger(Number(source.task_revision))||Number(source.task_revision)<1||d&&d.taskRevision!==Number(source.task_revision))codes.push('revision_invalid');
    if(!round)codes.push('round_missing');if(detail&&!Object.hasOwn(detail,'previousDecision'))codes.push('previous_decision_missing');
    if(detail?.decisionRef||d?.decisionRef)codes.push('live_ref_unbound');
    const row=make('task_history',source,round?.id,codes.length?'malformed':'verified',codes);
    if(!codes.length&&detail&&d){const entries=histories.get(round!.id)??[];entries.push({row,source,detail,decision:d});histories.set(round!.id,entries);}
  }
  for(const round of rounds.values()) {
    const entries=(histories.get(round.id)??[]).sort((a,b)=>Number(a.source.task_revision)-Number(b.source.task_revision));
    const rawFinal=round.decision,final=decision(rawFinal);let valid=true,previous:Row|null=null;
    const counts=new Map<number,number>();for(const entry of entries){const rev=Number(entry.source.task_revision);counts.set(rev,(counts.get(rev)??0)+1);}
    for(const entry of entries) {
      if(counts.get(Number(entry.source.task_revision))!==1){mark(entry.row,'duplicate_revision');valid=false;}
      if(!Object.hasOwn(entry.detail,'previousDecision')||canonicalJson(entry.detail.previousDecision)!==canonicalJson(previous)){mark(entry.row,'previous_decision_mismatch');valid=false;}
      if(!valid)mark(entry.row,'chain_ambiguous');previous=entry.decision;
    }
    if(rawFinal===null||rawFinal===undefined) {for(const entry of entries)mark(entry.row,'final_projection_missing');continue;}
    if(final&&valid&&entries.length&&canonicalJson(final)===canonicalJson(entries.at(-1)!.decision)) {
      projections.push({project_id:input.projectId,task_id:input.taskId,round_id:round.id,source_kind:'legacy',execution_id:null,legacy_id:entries.at(-1)!.row.id,applied_at:input.at});continue;
    }
    if(entries.length)for(const entry of entries)mark(entry.row,'final_projection_mismatch');
    const row=make('task_review_rounds',round,round.id,final?(entries.length?'ambiguous':'projection-only'):'malformed',[final?(entries.length?'final_projection_mismatch':'history_missing'):'final_projection_invalid']);
    if(final&&!entries.length)projections.push({project_id:input.projectId,task_id:input.taskId,round_id:round.id,source_kind:'legacy',execution_id:null,legacy_id:row.id,applied_at:input.at});
  }
  for(const row of rows)validateCopyRow('decision_legacy_records',row);
  for(const row of projections)validateCopyRow('decision_review_projections',row);
  return {rows,projections};
}

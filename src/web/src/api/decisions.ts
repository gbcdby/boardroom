import { ApiError } from './client.ts';
import type { DecisionView, LiveDecisionView, DecisionCommandResult } from '../../../shared/decisions.ts';
import type { ResourceReader } from '../composables/useResourceReconciliation.ts';
export type * from '../../../shared/decisions.ts';
export interface DecisionSnapshot {decisions:DecisionView[];cursor:number}
export const decisionsUrl=(projectId:string)=>`/api/projects/${encodeURIComponent(projectId)}/decisions`;
export const decisionUrl=(projectId:string,id:string)=>`${decisionsUrl(projectId)}/${encodeURIComponent(id)}`;
export async function readTaskDecisions(reader:ResourceReader,projectId:string,taskId:string):Promise<DecisionSnapshot> {
  const value=await reader.get<DecisionSnapshot>(`${decisionsUrl(projectId)}?taskId=${encodeURIComponent(taskId)}`);
  if(!value||!Array.isArray(value.decisions)||!Number.isSafeInteger(value.cursor)||value.cursor<0)throw new Error('决定快照不完整，已保留上次数据。');
  return value;
}
export function acceptsDecisions(incoming:DecisionSnapshot,current:DecisionSnapshot|null):boolean {
  if(!current)return true;
  if(incoming.cursor<current.cursor)return false;
  const rows=new Map(incoming.decisions.filter((d):d is LiveDecisionView=>d.recordKind==='live-review-decision').map(d=>[d.ref.decisionId,d]));
  return current.decisions.every(d=>d.recordKind==='legacy-review-fact'?incoming.decisions.some(v=>v.recordKind==='legacy-review-fact'&&v.legacyId===d.legacyId):
    !!rows.get(d.ref.decisionId)&&rows.get(d.ref.decisionId)!.ref.revision>=d.ref.revision&&rows.get(d.ref.decisionId)!.head.headRevision>=d.head.headRevision);
}
/** 明示提交的 409 refresh 是回执；其它失败仍保留 HTTP 原因。 */
export async function postDecision(url:string,input:unknown):Promise<DecisionCommandResult> {
  const response=await fetch(url,{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  let value:unknown;try{value=await response.json();}catch{throw new Error('无法确认本次决策结果。');}
  const result=value as Partial<DecisionCommandResult>;
  if((response.ok||response.status===409)&&result.schemaVersion==='decision-response/v1'&&result.state&&['applied','pending','not_required','refreshed'].includes(result.state)
    &&result.receipt?.result===result.state&&typeof result.receipt.receiptId==='string'&&result.receipt.httpStatus===response.status
    &&result.current?.recordKind==='live-review-decision'&&Number.isSafeInteger(result.decisionRef?.revision)
    &&(result.state!=='applied'||result.receipt.execution?.status==='succeeded')
    &&(result.state!=='not_required'||result.receipt.execution?.status==='not_required'))return result as DecisionCommandResult;
  if(response.ok||result.schemaVersion==='decision-response/v1')throw new Error('回执不完整，无法确认本次决策结果。');
  const error=(value as {error?:{code?:string;message?:string;reason?:string}})?.error;
  throw new ApiError(response.status,error?.code??'decision_response_invalid',error?.message??'决策操作失败。',error?.reason,value);
}
export function decisionResultMessage(result:DecisionCommandResult):string {
  if(result.state==='applied'&&result.receipt.execution?.status==='succeeded')return '裁决已保存并应用；原报告和历史结论保留。';
  if(result.state==='not_required')return '选择已保存；任务和当前已应用结论保持原样。';
  if(result.state==='refreshed')return '策略已变化，本次只更新了评估。理由和原选择已保留，请核对新决定后再明确提交。';
  return result.blockedReason?`提案已保存，当前仍有阻塞：${result.blockedReason}。`:
    result.requiredAuthority==='human'?'提案已保存，等待人的明确选择。':result.requiredAuthority==='owner'?'提案已保存，等待有权负责人处理。':'提案已保存，尚未应用到任务。';
}

import type { DbDriver } from '../db/driver.ts';
import type { DomainAccess } from '../mutation-access.ts';
import { appendAuditEntry,auditActorFrom } from '../audit.ts';
import { notifyResourceChange } from '../resource-changes.ts';
import { withLockedReviewTransaction,withLockedReviewTransactions } from './locked-transaction.ts';
import { createDecisionRepository } from './repository.ts';
import { createRepositories } from '../db/repositories.ts';
import { captureExceeded } from '../org/capture-budget.ts';

/** Member compensation captures only its original task closure; a stale owner
 * route alone does not invent a different candidate or a replacement authority. */
export async function prepareLifecycleDecisionCancellations(db:DbDriver,projectId:string,taskIds:readonly string[]|null,at:string,reason:string) {
  const repos=createRepositories(db);
  if(!(await repos.context.one('SELECT version FROM schema_migrations WHERE version=20'))||taskIds?.length===0)return {count:0,apply:async()=>{}};
  const rows=await repos.context.query<{task_id:string;round_id:string}>(`SELECT task_id,round_id FROM decision_records WHERE project_id=? AND status='pending'${taskIds===null?'':` AND task_id IN (${taskIds.map(()=>'?').join(',')})`} ORDER BY task_id,round_id LIMIT 101`,[projectId,...taskIds??[]]);
  if(rows.length>100)captureExceeded('待决生命周期闭包超过单次有界事务容量');
  if(!rows.length)return {count:0,apply:async()=>{}};
  const store=createDecisionRepository(db);
  const prepared=await withLockedReviewTransactions(db,null,rows.map(row=>({projectId,taskId:row.task_id,roundId:row.round_id})),async guards=>{
    const result=[];for(const guard of guards){const item=await store.prepareCancellation(guard,at);if(item)result.push(item);}return result;
  });
  return {count:prepared.length,async apply(){for(const item of prepared){
    await item.apply();
    await appendAuditEntry(repos.audit,{projectId,actor:{kind:'system',memberId:null,name:'Decision 生命周期'},action:'decision.cancelled',
      targetKind:'decision',targetId:item.id,targetName:item.slot.taskId,detail:{taskId:item.slot.taskId,roundId:item.slot.roundId,reason}},{createdAt:at});
    await notifyResourceChange(db,{projectId,entity:'decision',id:item.id,revision:item.revision});
  }}};
}

/** Task 已持项目域锁；改变候选/取消/重开前终结 pending，旧 resolution/projection 完全不动。 */
export async function invalidateTaskDecisions(db:DbDriver,access:DomainAccess,projectId:string,taskId:string,at:string):Promise<void> {
  if(!(await db.query('SELECT version FROM schema_migrations WHERE version=20')).length)return;
  const rows=await db.query("SELECT * FROM decision_records WHERE project_id=? AND task_id=? AND status='pending' ORDER BY round_id,id",[projectId,taskId]);
  for(const row of rows)await withLockedReviewTransaction(db,access,{projectId,taskId,roundId:String(row.round_id)},guard=>
    createDecisionRepository(db).write(guard,async writer=>{
      await writer.terminate(String(row.id),Number(row.revision),'cancelled',at);
      await writer.appendChange({decisionId:String(row.id),decisionRevision:Number(row.revision)+1,kind:'cancelled',at});
      await appendAuditEntry(createRepositories(db).audit,{projectId,actor:auditActorFrom(access.actor),
        action:'decision.cancelled',targetKind:'decision',targetId:String(row.id),targetName:taskId,detail:{taskId,roundId:row.round_id,reason:'task_candidate_changed'}});
      await notifyResourceChange(db,{projectId,entity:'decision',id:String(row.id),revision:Number(row.revision)+1});
    }));
}

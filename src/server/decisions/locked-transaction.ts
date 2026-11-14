import type { DbDriver, DbTransactionContext } from '../db/driver.ts';
import { createRepositories, type RepositorySet } from '../db/repositories.ts';
import { discoverDomainMutation, type DomainAccess } from '../mutation-access.ts';
import { PolicyConfigurationError } from '../policy/configuration-errors.ts';
import type { ReviewSlot, ReviewLockedTransaction } from './types.ts';

const tokenKey=Symbol('decision.review.locked');
interface State {db:DbDriver;repos:RepositorySet;context:DbTransactionContext;token:object;slot:ReviewSlot}
const guards=new WeakMap<object,State>();
const invalid=():never=>{throw new Error('review_transaction_invalid');};
export function assertReviewTransaction(guard:ReviewLockedTransaction):State {
  const state=guards.get(guard);if(!state)return invalid();
  const current=state.db.currentTransactionContext();
  const tokens=current?.values.get(tokenKey);
  if(current!==state.context||!Array.isArray(tokens)||!tokens.includes(state.token))return invalid();
  const scope=state.repos.mutations.current();if(!scope||!scope.projectIds.includes(state.slot.projectId))return invalid();
  return state;
}
export async function withLockedReviewTransactions<T>(db:DbDriver,access:DomainAccess|null,slots:readonly ReviewSlot[],body:(guards:readonly ReviewLockedTransaction[])=>Promise<T>):Promise<T> {
  if(!Array.isArray(slots)||slots.length<1||slots.length>100)return invalid();
  const projectId=slots[0]!.projectId;
  if(slots.some(s=>s.projectId!==projectId||[s.projectId,s.taskId,s.roundId].some(v=>typeof v!=='string'||v.length<1||v.length>200||v!==v.trim()||/[\0\r\n]/.test(v)))||new Set(slots.map(s=>JSON.stringify([s.taskId,s.roundId]))).size!==slots.length)return invalid();
  const repos=createRepositories(db);
  return repos.mutations.run({projectIds:[projectId],discover:async tx=>{
    const members=new Set<string>(),groups=new Set<string>(),runtimes=new Set<string>();
    for(const slot of slots) {
      if(access!==null) {
        const d=await discoverDomainMutation(access,projectId,{taskId:slot.taskId,roundId:slot.roundId,escalation:true})(tx);
        d.memberIds.forEach(id=>members.add(id));d.groupIds.forEach(id=>groups.add(id));d.runtimeIds.forEach(id=>runtimes.add(id));
      } else {
        // initializer没有伪造人的Actor；只锁实际来源成员和可成为路由目标的当前管理岗位。
        const actual=await tx.query<{id:string}>(`SELECT m.id FROM members m LEFT JOIN org_nodes n ON n.id=m.node_id
          WHERE m.project_id=? AND (m.id IN (SELECT assignee_member_id FROM tasks WHERE project_id=? AND id=?)
          OR m.id IN (SELECT reviewer_member_id FROM tasks WHERE project_id=? AND id=?)
          OR m.id IN (SELECT reviewer_member_id FROM task_review_rounds WHERE project_id=? AND id=?)
          OR m.role='manager' OR n.role IN ('top_manager','sub_manager')) ORDER BY m.id LIMIT 2049`,[projectId,projectId,slot.taskId,projectId,slot.taskId,projectId,slot.roundId]);
        actual.forEach(row=>members.add(row.id));
      }
    }
    return {memberIds:[...members],groupIds:[...groups],runtimeIds:[...runtimes]};
  }},async()=>{
    if(await repos.context.exec("UPDATE policy_documents SET updated_at = updated_at WHERE scope_key='user'")!==1)throw new PolicyConfigurationError('policy_not_initialized',409);
    const context=db.currentTransactionContext();if(!context)return invalid();
    const result:ReviewLockedTransaction[]=[];
    for(const slot of slots) {
      // Guard证明当前锁与实际实体归属；坏JSON由调用方的严格解码给出诊断，
      // 不能在发放guard前用DTO解码吞掉initializer的逐来源错误边界。
      const task=await repos.context.query('SELECT id FROM tasks WHERE project_id=? AND id=?',[slot.projectId,slot.taskId]);
      const round=await repos.context.query('SELECT id FROM task_review_rounds WHERE project_id=? AND task_id=? AND id=?',[slot.projectId,slot.taskId,slot.roundId]);
      if(task.length!==1||round.length!==1)return invalid();
      const token=Object.freeze({});const old=context.values.get(tokenKey);
      // 替换不可变集合，保存点回滚才可恢复先前集合；仅物理context相等不足以证明锁仍持有。
      context.values.set(tokenKey,Object.freeze([...(Array.isArray(old)?old:[]),token]));
      const pinnedSlot=Object.freeze({...slot});
      const guard=Object.freeze({physicalTransactionIdentity:context,slot:pinnedSlot,scopeFullyLocked:true,globalPolicyHeadLocked:true}) as ReviewLockedTransaction;
      guards.set(guard,{db,repos,context,token,slot:pinnedSlot});result.push(guard);
    }
    return body(Object.freeze(result));
  });
}
export function withLockedReviewTransaction<T>(db:DbDriver,access:DomainAccess|null,slot:ReviewSlot,body:(guard:ReviewLockedTransaction)=>Promise<T>):Promise<T> {
  return withLockedReviewTransactions(db,access,[slot],guards=>body(guards[0]!));
}

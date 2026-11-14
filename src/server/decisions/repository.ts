import type { DbDriver, DbReadSnapshot } from '../db/driver.ts';
import { createRepositories } from '../db/repositories.ts';
import { assertPolicyConfigurationInitialized } from '../policy/configuration.ts';
import { DECISION_TABLES, DECISION_TABLE_BY_NAME } from './tables.ts';
import { validateCopyRow } from './text-codec.ts';
import { validateDecisionStorageGraph, type StorageRow, type DecisionStorageGraph } from './storage-validation.ts';
import { assertReviewTransaction } from './locked-transaction.ts';
import type { ReviewLockedTransaction } from './types.ts';
import { StorageInvalid } from './storage-error.ts';

export class DecisionWriteConflict extends Error {readonly code='decision_revision_conflict';constructor(){super('decision_revision_conflict');}}
export interface DecisionWriter {
  insert(table:string,row:StorageRow):Promise<void>;
  terminate(id:string,expectedRevision:number,status:'superseded'|'cancelled'|'expired',at:string):Promise<void>;
  updatePending(id:string,expectedRevision:number,patch:{status:'pending'|'resolved';requiredAuthority:string|null;assigneeMemberId:string|null;blockedReason:string|null;policyEvaluation:string;at:string}):Promise<void>;
  replaceHead(row:StorageRow,expectedRevision:number|null):Promise<void>;
  replaceProjection(row:StorageRow):Promise<void>;
  appendChange(input:{decisionId:string;decisionRevision:number;kind:string;at:string}):Promise<number>;
}
export async function readDecisionProjectGraph(snapshot:DbReadSnapshot,projectId:string):Promise<DecisionStorageGraph> {
  const graph:Record<string,StorageRow[]>={};
  for(const table of DECISION_TABLES)graph[table.name]=await snapshot.query(`SELECT * FROM ${table.name} WHERE project_id=?`,[projectId]);
  graph.projects=await snapshot.query('SELECT * FROM projects WHERE id=?',[projectId]);
  for(const table of ['members','tasks','task_review_rounds','task_review_reports','task_history','work_events'])graph[table]=await snapshot.query(`SELECT * FROM ${table} WHERE project_id=?`,[projectId]);
  validateDecisionStorageGraph(graph);return graph;
}
/** 私有库级仓储，不从HTTP/MCP暴露。write只能消费当前物理事务及保存点仍有效的guard。 */
export function createDecisionRepository(db:DbDriver) {
  const repos=createRepositories(db);
  async function insert(table:string,row:StorageRow):Promise<void> {
    validateCopyRow(table,row);const spec=DECISION_TABLE_BY_NAME.get(table)!;const columns=spec.columns.map(c=>c.name);
    await db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(c=>row[c]));
  }
  return {
    /** Lifecycle only changes the current pending row's status/revision. All
     * immutable source/action/effect text remains untouched. The caller budgets
     * this bounded strict row before its first lifecycle write. */
    async prepareCancellation(guard:ReviewLockedTransaction,at:string) {
      const state=assertReviewTransaction(guard);if(state.db!==db)throw new StorageInvalid('guard','wrong_database');
      const row=await repos.context.one("SELECT * FROM decision_records WHERE project_id=? AND task_id=? AND round_id=? AND status='pending'",[state.slot.projectId,state.slot.taskId,state.slot.roundId]);
      if(!row)return null;validateCopyRow('decision_records',row);
      const next={...row,status:'cancelled',revision:Number(row.revision)+1,updated_at:at};validateCopyRow('decision_records',next);
      return {id:String(row.id),revision:Number(next.revision),slot:state.slot,async apply(){
        assertReviewTransaction(guard);
        if(await repos.context.exec("UPDATE decision_records SET status='cancelled',revision=?,updated_at=? WHERE project_id=? AND id=? AND revision=? AND status='pending'",
          [next.revision,at,state.slot.projectId,row.id,row.revision])!==1)throw new DecisionWriteConflict();
        const head=await repos.context.one('SELECT revision FROM decision_change_heads WHERE project_id=?',[state.slot.projectId]);
        const old=Number(head?.revision??0),revision=old+1;
        const change={project_id:state.slot.projectId,revision,task_id:state.slot.taskId,decision_id:row.id,decision_revision:next.revision,kind:'cancelled',created_at:at};
        validateCopyRow('decision_changes',change);
        if(head){if(await repos.context.exec('UPDATE decision_change_heads SET revision=? WHERE project_id=? AND revision=?',[revision,state.slot.projectId,old])!==1)throw new DecisionWriteConflict();}
        else await repos.context.exec('INSERT INTO decision_change_heads (project_id,revision) VALUES (?,?)',[state.slot.projectId,revision]);
        await repos.context.exec('INSERT INTO decision_changes (project_id,revision,task_id,decision_id,decision_revision,kind,created_at) VALUES (?,?,?,?,?,?,?)',
          [state.slot.projectId,revision,state.slot.taskId,row.id,next.revision,'cancelled',at]);
      }};
    },
    readProject(projectId:string):Promise<DecisionStorageGraph> {return db.currentTransactionContext()?readDecisionProjectGraph(db,projectId):db.readSnapshot(snapshot=>readDecisionProjectGraph(snapshot,projectId));},
    async write<T>(guard:ReviewLockedTransaction,body:(writer:DecisionWriter)=>Promise<T>):Promise<T> {
      const state=assertReviewTransaction(guard);if(state.db!==db)throw new StorageInvalid('guard','wrong_database');
      let open=false;
      const assertWriter=()=>{if(!open)throw new StorageInvalid('writer','writer_closed');assertReviewTransaction(guard);};
      const inSlot=(row:StorageRow)=>{assertWriter();if(row.project_id!==state.slot.projectId||Object.hasOwn(row,'task_id')&&row.task_id!==state.slot.taskId||Object.hasOwn(row,'round_id')&&row.round_id!==state.slot.roundId)throw new StorageInvalid('writer','scope');};
      return db.transaction(async()=>{
        await readDecisionProjectGraph(db,state.slot.projectId);
        const writer:DecisionWriter={
          async insert(table,row){inSlot(row);await insert(table,row);},
          async updatePending(id,expectedRevision,patch){
            assertWriter();const current=(await db.query('SELECT * FROM decision_records WHERE project_id=? AND id=?',[state.slot.projectId,id]))[0];
            if(!current||current.status!=='pending'||Number(current.revision)!==expectedRevision)throw new DecisionWriteConflict();
            inSlot(current);
            const next={...current,status:patch.status,revision:expectedRevision+1,required_authority:patch.requiredAuthority,
              assignee_member_id:patch.assigneeMemberId,blocked_reason_code:patch.blockedReason,policy_evaluation_json:patch.policyEvaluation,updated_at:patch.at};
            validateCopyRow('decision_records',next);
            if(await db.exec("UPDATE decision_records SET status=?,revision=?,required_authority=?,assignee_member_id=?,blocked_reason_code=?,policy_evaluation_json=?,updated_at=? WHERE project_id=? AND id=? AND revision=? AND status='pending'",
              [next.status,next.revision,next.required_authority,next.assignee_member_id,next.blocked_reason_code,next.policy_evaluation_json,next.updated_at,state.slot.projectId,id,expectedRevision])!==1)throw new DecisionWriteConflict();
          },
          async terminate(id,expectedRevision,status,at){
            assertWriter();if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!['superseded','cancelled','expired'].includes(status))throw new DecisionWriteConflict();
            const current=(await db.query('SELECT * FROM decision_records WHERE project_id=? AND id=?',[state.slot.projectId,id]))[0];
            if(!current)throw new DecisionWriteConflict();inSlot(current);validateCopyRow('decision_records',current);
            if(current.status!=='pending'||Number(current.revision)!==expectedRevision)throw new DecisionWriteConflict();
            const next={...current,status,revision:expectedRevision+1,updated_at:at};validateCopyRow('decision_records',next);
            if(await db.exec("UPDATE decision_records SET status=?,revision=?,updated_at=? WHERE project_id=? AND id=? AND revision=? AND status='pending'",[status,expectedRevision+1,at,state.slot.projectId,id,expectedRevision])!==1)throw new DecisionWriteConflict();
          },
          async replaceHead(row,expectedRevision){
            inSlot(row);validateCopyRow('decision_review_heads',row);
            if(expectedRevision===null)await insert('decision_review_heads',row);
            else {
              if(!Number.isSafeInteger(expectedRevision)||Number(row.head_revision)!==expectedRevision+1)throw new DecisionWriteConflict();
              if(await db.exec('UPDATE decision_review_heads SET head_revision=?,current_decision_id=? WHERE project_id=? AND task_id=? AND round_id=? AND head_revision=?',[row.head_revision,row.current_decision_id,row.project_id,row.task_id,row.round_id,expectedRevision])!==1)throw new DecisionWriteConflict();
            }
          },
          async replaceProjection(row){inSlot(row);validateCopyRow('decision_review_projections',row);await db.exec('DELETE FROM decision_review_projections WHERE project_id=? AND task_id=? AND round_id=?',[row.project_id,row.task_id,row.round_id]);await insert('decision_review_projections',row);},
          async appendChange(input){
            assertWriter();const head=(await db.query('SELECT * FROM decision_change_heads WHERE project_id=?',[state.slot.projectId]))[0];
            const old=head?Number(head.revision):0,revision=old+1;
            const row={project_id:state.slot.projectId,revision,task_id:state.slot.taskId,decision_id:input.decisionId,decision_revision:input.decisionRevision,kind:input.kind,created_at:input.at};validateCopyRow('decision_changes',row);
            if(head){if(await db.exec('UPDATE decision_change_heads SET revision=? WHERE project_id=? AND revision=?',[revision,state.slot.projectId,old])!==1)throw new DecisionWriteConflict();}
            else await insert('decision_change_heads',{project_id:state.slot.projectId,revision});
            await insert('decision_changes',row);return revision;
          },
        };
        open=true;let result:T;try{result=await body(writer);}finally{open=false;}
        assertReviewTransaction(guard);await readDecisionProjectGraph(db,state.slot.projectId);return result;
      });
    },
    async importLegacy(projectId:string,rows:readonly StorageRow[],projections:readonly StorageRow[]):Promise<number> {
      if(rows.length>100||projections.length>100)throw new StorageInvalid('legacy','batch_limit');
      return repos.mutations.run({projectIds:[projectId],discover:async()=>({memberIds:[],groupIds:[],runtimeIds:[]})},async()=>{
        await db.exec("UPDATE policy_documents SET updated_at=updated_at WHERE scope_key='user'");await assertPolicyConfigurationInitialized(repos);let imported=0;
        for(const row of rows) {
          validateCopyRow('decision_legacy_records',row);if(row.project_id!==projectId)throw new StorageInvalid('legacy','scope');
          const old=(await db.query('SELECT * FROM decision_legacy_records WHERE project_id=? AND source_table=? AND source_id=?',[projectId,row.source_table,row.source_id]))[0];
          if(old){validateCopyRow('decision_legacy_records',old);continue;}
          await insert('decision_legacy_records',row);imported++;
        }
        for(const row of projections) {
          validateCopyRow('decision_review_projections',row);if(row.project_id!==projectId||row.source_kind!=='legacy')throw new StorageInvalid('legacy','scope');
          const old=await db.query('SELECT * FROM decision_review_projections WHERE project_id=? AND task_id=? AND round_id=?',[projectId,row.task_id,row.round_id]);
          if(!old.length)await insert('decision_review_projections',row);
        }
        await readDecisionProjectGraph(db,projectId);return imported;
      });
    },
  };
}

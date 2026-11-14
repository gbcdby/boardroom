import { createHash } from 'node:crypto';
import type { DbDriver } from '../../src/server/db/driver.ts';
import { storageFixture } from './decisions-fixture.mjs';
import { DECISION_TABLE_NAMES } from '../../src/server/decisions/tables.ts';
import { canonicalJson } from '../../src/server/policy/canonical.ts';
import { encode } from '../../src/server/decisions/text-codec.ts';
import { readDecisionProjectGraph } from '../../src/server/decisions/repository.ts';
export async function seedDecisionDatabase(db:DbDriver,reason='历史\0\ud800',suffix='database') {
  const f=storageFixture(reason,suffix);
  // 顺序特意先successor后predecessor，依靠实际双方言deferred FK，不逐行假装已完整。
  const record=f.rows['decision_records']![0]!,request=f.rows['decision_action_requests']![0]!;
  const parent={...record,id:`predecessor-${suffix}`,action_request_id:`predecessor-request-${suffix}`,status:'cancelled',revision:1,generation:1};
  f.rows['decision_action_requests']!.push({...request,id:parent.action_request_id});f.rows['decision_records']!.push(parent);
  record['generation']=2;record['predecessor_decision_id']=parent.id;record['predecessor_legacy_id']=null;
  f.rows['decision_review_heads']![0]!['head_revision']=2;
  const receipt=f.rows['decision_command_receipts']![0]!;receipt['head_revision']=2;const response=JSON.parse(receipt['response_json']);response.head.headRevision=2;response.receipt.head.headRevision=2;receipt['response_json']=encode('decision_command_receipts.response_json',response);
  const insert=async(table:string,row:Record<string,unknown>)=>{const columns=Object.keys(row);await db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(c=>row[c]));};
  await db.transaction(async()=>{
    for(const table of ['projects','members','tasks','task_review_rounds','task_review_reports','task_history','work_events'])for(const original of f.graph[table]??[]) {
      const row={...original};if(table==='task_review_reports')delete row['author_actor_id'];await insert(table,row);
    }
    const legacy=f.rows['decision_legacy_records']![0]!;
    const source=(await db.query('SELECT * FROM task_history WHERE id=?',[legacy['source_id']]))[0]!;
    legacy['raw_text']=canonicalJson(source);legacy['raw_digest']=createHash('sha256').update(legacy['raw_text']).digest('hex');
    for(const table of DECISION_TABLE_NAMES)for(const row of f.rows[table]!)await insert(table,row);
  });
  await db.readSnapshot(snapshot=>readDecisionProjectGraph(snapshot,f.slot.projectId));return f;
}

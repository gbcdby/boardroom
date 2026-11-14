import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture,identityEngines,identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { initializeDecisionStorage } from '../src/server/decisions/initializer.ts';
import { createDecisionRepository,type DecisionWriter } from '../src/server/decisions/repository.ts';
import { withLockedReviewTransaction } from '../src/server/decisions/locked-transaction.ts';
import { StorageInvalid } from '../src/server/decisions/storage-error.ts';
for(const engine of identityEngines)test(`${engine}: private writer rolls back malformed/orphan/error, expires callbacks and CASes one successor`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine);try {
    await initializePolicyConfiguration(f.repos);const d=await decisionDomainFixture(f.repos);await initializeDecisionStorage(f.db);const repo=createDecisionRepository(f.db),before=await repo.readProject(d.project.id);
    await withLockedReviewTransaction(f.db,d.owner,d.slot,async guard=>{
      const action=before['decision_action_requests']![0]!,record=before['decision_records']![0]!;
      await assert.rejects(repo.write(guard,w=>w.insert('decision_action_requests',{...action,id:'bad',extra:true})),StorageInvalid);
      await assert.rejects(repo.write(guard,w=>w.insert('decision_action_requests',{...action,id:'orphan'})),StorageInvalid);
      const original=new Error('caller failure');await assert.rejects(repo.write(guard,async()=>{throw original;}),error=>error===original);
      assert.deepEqual(await repo.readProject(d.project.id),before);
      let escaped:DecisionWriter|undefined;await repo.write(guard,async writer=>{escaped=writer;});
      await assert.rejects(escaped!.insert('decision_action_requests',{...action,id:'escaped'}),/writer_closed/);
      const at='2026-11-13T04:00:00.000Z';
      await repo.write(guard,async writer=>{
        await writer.terminate(String(record.id),1,'cancelled',at);
        await writer.insert('decision_action_requests',{...action,id:'successor-action'});
        await writer.insert('decision_records',{...record,id:'successor',action_request_id:'successor-action',generation:2,predecessor_decision_id:record.id,created_at:at,updated_at:at});
        await writer.replaceHead({project_id:d.project.id,task_id:d.task.id,round_id:d.round.id,head_revision:2,current_decision_id:'successor'},1);
        await writer.appendChange({decisionId:'successor',decisionRevision:1,kind:'created',at});
      });
      await assert.rejects(repo.write(guard,w=>w.terminate('successor',99,'cancelled',at)),{code:'decision_revision_conflict'});
    });
    const after=await repo.readProject(d.project.id);assert.equal(after['decision_records']!.length,2);assert.equal(after['decision_review_heads']![0]!.current_decision_id,'successor');
    for(const table of ['decision_executions','decision_user_events','decision_resolutions'])assert.equal(after[table]!.length,0);
  }finally{await f.close();}
});

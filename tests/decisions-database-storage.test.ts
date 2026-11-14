import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture,identityEngines,identitySkip } from './helpers/identity-fixture.ts';
import { seedDecisionDatabase } from './helpers/decisions-database-fixture.ts';
import { createDecisionRepository } from '../src/server/decisions/repository.ts';
import { decode } from '../src/server/decisions/text-codec.ts';
for(const engine of identityEngines)test(`${engine}: all twelve Decision tables preserve original encoded TEXT/deferred predecessor and immutable graph`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine);try {
    const source=await seedDecisionDatabase(f.db),repo=createDecisionRepository(f.db);const before=await repo.readProject(source.slot.projectId);
    for(const [name,rows] of Object.entries(before))if(name.startsWith('decision_'))assert.ok(rows.length>0,name);
    assert.equal(decode('decision_resolutions.reason_json',before['decision_resolutions']![0]!.reason_json as string),source.reason);
    for(const table of ['decision_legacy_records','decision_action_requests','decision_user_events','decision_local_initiations','decision_resolutions','decision_executions','decision_command_receipts'])await assert.rejects(f.db.exec(`UPDATE ${table} SET id=id WHERE project_id=?`,[source.slot.projectId]));
    await assert.rejects(f.db.exec('UPDATE decision_records SET revision=revision+1 WHERE project_id=?',[source.slot.projectId]));
    await assert.rejects(f.db.exec('INSERT INTO decision_change_heads (project_id,revision) VALUES (?,?)',['missing-project',1]));
    await assert.rejects(f.db.exec('INSERT INTO decision_change_heads (project_id,revision) VALUES (?,?)',[source.slot.projectId,0]));
    assert.deepEqual(await repo.readProject(source.slot.projectId),before);
  }finally{await f.close();}
});

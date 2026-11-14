import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFixture,identityEngines,identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { initializeDecisionStorage } from '../src/server/decisions/initializer.ts';
import { DECISION_TABLE_NAMES } from '../src/server/decisions/tables.ts';
import { migrations } from '../src/server/db/migrations/index.ts';
for(const engine of identityEngines)test(`${engine}: project purge counts/digest cover all Decision values, group and other project remain unchanged`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine,19);try {
    await initializePolicyConfiguration(f.repos);const a=await decisionDomainFixture(f.repos),b=await decisionDomainFixture(f.repos);
    const group=await f.repos.groups.create({projectId:a.project.id,name:'保留成员语义',participantMemberIds:[a.worker.id]});
    await f.db.migrate(migrations);
    const old=await f.repos.projects.capturePurge(a.project.id),groupBefore=await f.repos.groups.capturePurge(group.id);
    await initializeDecisionStorage(f.db);
    assert.deepEqual(await f.repos.groups.capturePurge(group.id),groupBefore);
    await assert.rejects(f.repos.projects.purge(a.project.id,old.digest),{code:'confirmation_changed'});
    const current=await f.repos.projects.capturePurge(a.project.id);assert.equal((current.cascade as unknown as Record<string,number>)['decisionRecords'],1);
    const global=await f.db.query("SELECT * FROM policy_documents WHERE scope='user'");
    const removed=await f.repos.projects.purge(a.project.id,current.digest);assert.deepEqual(removed,current.cascade);
    for(const table of DECISION_TABLE_NAMES)assert.deepEqual(await f.db.query(`SELECT * FROM ${table} WHERE project_id=?`,[a.project.id]),[]);
    assert.equal((await f.db.query('SELECT * FROM decision_records WHERE project_id=?',[b.project.id])).length,1);
    assert.deepEqual(await f.db.query("SELECT * FROM policy_documents WHERE scope='user'"),global);
  }finally{await f.close();}
});

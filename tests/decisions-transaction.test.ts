import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { identityFixture, identityEngines, identitySkip, identityPgUrl } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { withLockedReviewTransaction, assertReviewTransaction } from '../src/server/decisions/locked-transaction.ts';
import type { ReviewLockedTransaction } from '../src/server/decisions/types.ts';
import { initializePolicyConfiguration, readLockedReviewPolicy, createPolicyConfiguration } from '../src/server/policy/configuration.ts';
for(const engine of identityEngines) {
  test(`${engine}: T05 guard dies after SAVEPOINT rollback/physical exit, even while outer transaction stays`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine);try{
      const d=await decisionDomainFixture(f.repos,'ready');await initializePolicyConfiguration(f.repos);let saved:ReviewLockedTransaction|undefined;
      await f.db.transaction(async()=>{
        const original=new Error('savepoint rollback');
        await assert.rejects(f.db.transaction(async()=>{
          await withLockedReviewTransaction(f.db,d.owner,d.slot,async guard=>{saved=guard;assertReviewTransaction(guard);assert.equal((await readLockedReviewPolicy(guard)).executionAdmission,'not-issued');});
          assertReviewTransaction(saved!);throw original;
        }),error=>error===original);
        assert.throws(()=>assertReviewTransaction(saved!),/review_transaction_invalid/);
        await withLockedReviewTransaction(f.db,d.owner,d.slot,async guard=>{assertReviewTransaction(guard);assert.throws(()=>assertReviewTransaction({...guard}),/review_transaction_invalid/);saved=guard;});
      });
      assert.throws(()=>assertReviewTransaction(saved!),/review_transaction_invalid/);
    }finally{await f.close();}
  });
  test(`${engine}: private locked policy reader accepts actual reviewer; public user guard is unchanged; missing head never seeds`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine);try{
      const d=await decisionDomainFixture(f.repos,'ready');
      await assert.rejects(withLockedReviewTransaction(f.db,d.reviewerAccess,d.slot,async()=>{}),{code:'conflict',reason:'policy_not_initialized'});
      assert.deepEqual(await f.db.query('SELECT * FROM policy_documents'),[]);await initializePolicyConfiguration(f.repos);
      const before=await f.db.query('SELECT * FROM policy_documents');
      await withLockedReviewTransaction(f.db,d.reviewerAccess,d.slot,async guard=>{assert.equal((await readLockedReviewPolicy(guard)).mode,'observation');});
      await assert.rejects(createPolicyConfiguration({repos:f.repos}).getEffective(d.reviewerAccess,d.project.id),{name:'ForbiddenError'});
      assert.deepEqual(await f.db.query('SELECT * FROM policy_documents'),before);
    }finally{await f.close();}
  });
}
test('postgres: T05 real contender sees project/global locks released by savepoint rollback while stale guard stays invalid',{skip:identitySkip('postgres'),timeout:10_000},async t=>{
  const f=await identityFixture('postgres'),other=new Client({connectionString:identityPgUrl});
  try {
    const d=await decisionDomainFixture(f.repos,'ready');await initializePolicyConfiguration(f.repos);await other.connect();
    const schema=(await f.db.query<{schema:string}>('SELECT current_schema() AS schema'))[0]!.schema;assert.match(schema,/^identity_[a-f0-9]{32}$/);
    const observations:Record<string,unknown>[]=[];
    const attempt=async(phase:string,subject:'project'|'global',expected:string|null)=>{
      await other.query('BEGIN');let code:string|null=null;
      try {await other.query(subject==='project'?`SELECT id FROM "${schema}".projects WHERE id=$1 FOR UPDATE NOWAIT`:`SELECT scope_key FROM "${schema}".policy_documents WHERE scope_key='user' FOR UPDATE NOWAIT`,subject==='project'?[d.project.id]:[]);}
      catch(error){code=(error as {code?:string}).code??'unknown';}
      finally{await other.query('ROLLBACK');}
      observations.push({phase,subject,code,acquired:code===null});assert.equal(code,expected);
    };
    let stale:ReviewLockedTransaction|undefined;
    await f.db.transaction(async()=>{
      const rollback=new Error('T05 real savepoint rollback');
      await assert.rejects(f.db.transaction(async()=>{
        await withLockedReviewTransaction(f.db,d.owner,d.slot,async guard=>{stale=guard;assertReviewTransaction(guard);await attempt('held','project','55P03');await attempt('held','global','55P03');});
        throw rollback;
      }),error=>error===rollback);
      assert.ok(f.db.currentTransactionContext());assert.throws(()=>assertReviewTransaction(stale!),/review_transaction_invalid/);
      await attempt('rolled-back','project',null);await attempt('rolled-back','global',null);
    });
    t.diagnostic(JSON.stringify({control:'T05',observations,outerStayedActive:true,staleGuardRejected:true}));
  }finally{await other.end();await f.close();}
});

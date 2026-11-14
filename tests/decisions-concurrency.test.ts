import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration, createPolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createDecisionService } from '../src/server/decisions/service.ts';
import { actorForMember } from '../src/server/authz/actors.ts';

function signal() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }
async function boundary(promise:Promise<void>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('required concurrency boundary not observed')),1000);})]); }
  finally {if(timer)clearTimeout(timer);}
}

for(const engine of identityEngines)test(`${engine}: actual opposite Decision choices serialize to one terminal resolution and one receipt`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine);try{
    await initializePolicyConfiguration(f.repos);const p=await decisionDomainFixture(f.repos),service=createDecisionService(f.db),access={actor:actorForMember(p.manager)};
    const view=(await service.list(access,p.project.id)).decisions[0]!;if(view.recordKind!=='live-review-decision')throw new Error('missing');
    const results=await Promise.allSettled((['approve','reject'] as const).map(choiceId=>service.resolve(access,p.project.id,view.ref.decisionId,
      {decisionRef:view.ref,choiceId,reason:'相反的实际并发选择',idempotencyKey:`race-${choiceId}`})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const loser=results.find(r=>r.status==='rejected')!;assert.equal(loser.status,'rejected');if(loser.status==='rejected')assert.equal(loser.reason.reason,'decision_terminal');
    assert.equal((await f.db.query('SELECT * FROM decision_resolutions')).length,1);
    assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,1);
    assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length,1);
    assert.deepEqual(await f.db.query('SELECT * FROM decision_local_initiations'),[]);
  }finally{await f.close();}
});

// These controls deliberately remain NOT_RUN locally without the real PG URL.
// Each observes distinct backend PIDs and the actual production global lock;
// no sleep, synthetic lock, timeout expansion or alternative DB is substituted.
for(const first of ['policy','resolve'] as const)test(`postgres: T01/T02 ${first} wins the actual global lock before its contender`,{skip:identitySkip('postgres'),timeout:10_000},async t=>{
  const f=await identityFixture('postgres'),release=signal(),acquired=signal(),attempted=signal();
  const exec=f.db.exec.bind(f.db),transaction=f.db.transaction.bind(f.db),trace=new AsyncLocalStorage<'policy'|'resolve'>();
  const pids=new Map<string,number>(),seen=new Set<string>(),pending:Promise<unknown>[]=[];
  try{
    await initializePolicyConfiguration(f.repos);const p=await decisionDomainFixture(f.repos),service=createDecisionService(f.db),access={actor:actorForMember(p.manager)};
    const view=(await service.list(access,p.project.id)).decisions[0]!;if(view.recordKind!=='live-review-decision')throw new Error('missing');
    const policy=createPolicyConfiguration({repos:f.repos}),old=await policy.getGlobal(p.owner);
    const wrap=(execute:typeof exec):typeof exec=>async(sql,params)=>{
      const label=trace.getStore(),lock=/^UPDATE policy_documents SET updated_at\s*=\s*updated_at WHERE scope_key\s*=\s*'user'/.test(sql.trim());
      if(!label||!lock||seen.has(label))return execute(sql,params);
      seen.add(label);pids.set(label,Number((await f.db.query('SELECT pg_backend_pid() AS pid'))[0]!.pid));
      if(label!==first)attempted.resolve();
      const value=await execute(sql,params);
      if(label===first){acquired.resolve();await release.promise;}
      return value;
    };
    f.db.exec=wrap(exec);f.db.transaction=body=>transaction(tx=>body({query:tx.query.bind(tx),exec:wrap(tx.exec.bind(tx))}));
    const resolve=()=>trace.run('resolve',()=>service.resolve(access,p.project.id,view.ref.decisionId,
      {decisionRef:view.ref,choiceId:'approve',reason:'按真实锁先后处理',idempotencyKey:'ordered-resolve'}));
    const update=()=>trace.run('policy',()=>policy.updateGlobal(p.owner,{expectedRevision:old.ref.revision,
      rules:old.document.rules.map(r=>r.ruleId==='default.review.decide'?{...r,outcome:'human',requiresFreshHuman:true}:r)}));
    let result:ReturnType<typeof resolve>;
    if(first==='resolve'){result=resolve();pending.push(result);await boundary(acquired.promise);pending.push(update());}
    else{pending.push(update());await boundary(acquired.promise);result=resolve();pending.push(result);}
    await boundary(attempted.promise);assert.equal(pids.size,2);assert.notEqual(pids.get('policy'),pids.get('resolve'));release.resolve();
    await Promise.all(pending);const response=await result;
    assert.equal(response.state,first==='policy'?'refreshed':'applied');
    assert.equal(response.receipt.httpStatus,first==='policy'?409:200);
    assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,first==='policy'?0:1);
    if(first==='resolve')assert.equal(response.current.resolution!.policy.global.revision,old.ref.revision);
    assert.equal((await policy.getGlobal(p.owner)).ref.revision,old.ref.revision+1);
    t.diagnostic(JSON.stringify({first,backendPids:Object.fromEntries(pids),result:response.state,sourceRows:(await f.db.query('SELECT * FROM decision_local_initiations')).length}));
  }finally{release.resolve();await Promise.allSettled(pending);f.db.exec=exec;f.db.transaction=transaction;await f.close();}
});

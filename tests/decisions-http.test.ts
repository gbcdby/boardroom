import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { identityEngines,identityFixture,identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createTaskApi } from '../src/server/tasks/api.ts';
import { createLogger } from '../src/server/logger.ts';
import { onWorkEventCommit } from '../src/server/tasks/events.ts';
import { onResourceChange } from '../src/server/resource-changes.ts';
import type { DecisionCommandResult,LiveDecisionView } from '../src/shared/decisions.ts';
import { DECISION_TABLE_NAMES } from '../src/server/decisions/tables.ts';

for(const engine of identityEngines)test(`${engine}: Decision real local HTTP source, rollback, current GET and same-key durable receipt`,{skip:identitySkip(engine)},async()=>{
  const f=await identityFixture(engine);let closeHttp:(()=>Promise<void>)|undefined;
  try{
    await initializePolicyConfiguration(f.repos);const p=await decisionDomainFixture(f.repos),api=createTaskApi({db:f.db,logger:createLogger({write:()=>{}})});
    const server=createServer((req,res)=>{void api.handle(req,res,new URL(req.url??'/','http://127.0.0.1').pathname).then(handled=>{if(!handled){res.statusCode=404;res.end();}});});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    closeHttp=()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
    const listUrl=`${base}/api/projects/${p.project.id}/decisions?taskId=${p.task.id}`;
    const first=await fetch(listUrl),list=await first.json() as {decisions:LiveDecisionView[]};assert.equal(first.status,200);
    const current=list.decisions[0]!,url=`${base}/api/projects/${p.project.id}/decisions/${current.ref.decisionId}/choices`;
    const post=(input:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(input)});
    const before=await f.db.query('SELECT * FROM decision_records'),input={decisionRef:current.ref,choiceId:'approve',reason:'人明确选择\0\ud800',clientMutationId:'actual-http-choice'};
    assert.equal((await post({...input,actor:{kind:'human',id:'human:local'}})).status,400);
    assert.equal((await post({...input,userInitiationRef:'guessed'})).status,400);
    assert.equal((await post(input,'https://foreign.example')).status,403);
    const missing=await fetch(`${base}/api/projects/${p.project.id}/tasks/missing/reviews/missing/decision-requests`,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({expectedTaskRevision:1,expectedRoundRevision:1,proposedVerdict:'pass',requestedPath:'management',reason:'不存在的对象',idempotencyKey:'not-found'})});
    assert.equal(missing.status,404);
    const etag=first.headers.get('etag');assert.ok(etag);
    const unchanged=await fetch(listUrl,{headers:{'if-none-match':etag}});assert.equal(unchanged.status,304);
    assert.deepEqual(await f.db.query('SELECT * FROM decision_records'),before);
    const notified:unknown[]=[];const stopWork=onWorkEventCommit(f.db,events=>{notified.push(...events);}),stopResource=onResourceChange(f.db,event=>{notified.push(event);});
    const exec=f.db.exec.bind(f.db),transaction=f.db.transaction.bind(f.db);
    const capture=async()=>Object.fromEntries(await Promise.all([...DECISION_TABLE_NAMES,'tasks','task_review_rounds','task_history','work_events','audit_log','member_fact_revisions'].map(async table=>
      [table,(await f.db.query(`SELECT * FROM ${table}`)).map(r=>JSON.stringify(r)).sort()])));
    const fullBefore=await capture();
    const writePoints=[['user-event',/^INSERT INTO decision_user_events\b/],['initiation',/^INSERT INTO decision_local_initiations\b/],
      ['resolution',/^INSERT INTO decision_resolutions\b/],['task',/^UPDATE tasks SET /],['round',/^UPDATE task_review_rounds SET /],
      ['history',/^INSERT INTO task_history\b/],['audit',/^INSERT INTO audit_log\b/],['work-event',/^INSERT INTO work_events\b/],
      ['execution',/^INSERT INTO decision_executions\b/],['change',/^INSERT INTO decision_changes\b/],['receipt',/^INSERT INTO decision_command_receipts\b/]] as const;
    for(const [point,pattern] of writePoints){
      let injected=false;
      const wrap=(execute:typeof exec):typeof exec=>async(sql,params)=>{const value=await execute(sql,params);if(!injected&&pattern.test(sql.trim())){injected=true;throw new Error(`T10 after ${point}`);}return value;};
      f.db.exec=wrap(exec);
      // Repository mutations use the driver's real transaction facade, while
      // the Decision writer uses the same driver's current physical context.
      // Observe both paths without replacing either DB transaction or effect.
      f.db.transaction=body=>transaction(tx=>body({query:tx.query.bind(tx),exec:wrap(tx.exec.bind(tx))}));
      try{assert.equal((await post(input)).status,500,point);}finally{f.db.exec=exec;f.db.transaction=transaction;}
      assert.equal(injected,true,point);assert.equal(notified.length,0,point);assert.deepEqual(await capture(),fullBefore,point);
    }
    assert.deepEqual(await f.db.query('SELECT * FROM decision_records'),before);
    for(const table of ['decision_resolutions','decision_executions','decision_user_events','decision_local_initiations','decision_command_receipts'])assert.equal((await f.db.query(`SELECT * FROM ${table}`)).length,0);
    assert.equal((await f.repos.tasks.get(p.project.id,p.task.id))!.state,'review');
    const response=await post(input),result=await response.json() as DecisionCommandResult;
    assert.equal(response.status,200);assert.equal(result.state,'applied');assert.equal(result.current.resolution?.authority,'human');
    const provenance=result.current.resolution?.provenance;assert.ok(provenance&&'sourceContract' in provenance);
    assert.equal(provenance.sourceContract,'s1.local-db-decision-choice/v1');
    const sources=await f.db.query('SELECT * FROM decision_local_initiations');assert.equal(sources.length,1);assert.match(String(sources[0]!.nonce_hash),/^[0-9a-f]{64}$/);
    assert.equal(sources[0]!.consumed_receipt_id,result.receipt.receiptId);assert.equal(sources[0]!.issued_at,sources[0]!.consumed_at);
    assert.equal(JSON.stringify(result).includes('nonce'),false);
    assert.ok(notified.length>0);stopWork();stopResource();
    const replayResponse=await post(input),replay=await replayResponse.json() as DecisionCommandResult;
    assert.equal(replayResponse.status,200);assert.equal(replay.replay,'same-key');assert.deepEqual(replay.receipt,result.receipt);
    assert.equal((await f.db.query('SELECT * FROM decision_local_initiations')).length,1);
    assert.equal((await f.db.query('SELECT * FROM decision_executions')).length,1);
    assert.equal((await post({...input,reason:'不同理由'})).status,409);
    const changes=await fetch(`${base}/api/projects/${p.project.id}/decisions/changes?afterRevision=0`);assert.equal(changes.status,200);
    assert.ok((await changes.json() as {cursor:number}).cursor>=2);
    const all=await fetch(`${base}/api/decisions`);assert.equal(all.status,200);
  }finally{await closeHttp?.();await f.close();}
});

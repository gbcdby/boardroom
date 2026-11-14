import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { migrations } from '../src/server/db/migrations/index.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { initializeDecisionStorage } from '../src/server/decisions/initializer.ts';
import { createDecisionRepository } from '../src/server/decisions/repository.ts';
import type { DbDriver } from '../src/server/db/driver.ts';
import type { ReviewEvidence } from '../src/shared/tasks.ts';
async function originalRows(db:DbDriver){const result:Record<string,unknown>={};for(const t of ['tasks','task_review_rounds','task_review_reports','task_history','work_events','audit_log','policy_documents','policy_document_versions'])result[t]=await db.query(`SELECT * FROM ${t} ORDER BY 1`);return result;}
for(const engine of identityEngines) {
  test(`${engine}: R-157-A-003 initializer retains original TaskService command interval semantics`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine,19);try{
      await initializePolicyConfiguration(f.repos);
      const equal=await decisionDomainFixture(f.repos),outer=await decisionDomainFixture(f.repos,'running'),narrow=await decisionDomainFixture(f.repos,'running');
      const evidence=(axis:string,inside=false):ReviewEvidence=>({provenance:'reviewer-declared',host:'fixture',hostVersion:'not-a-model-run',parentRunId:'same-parent',invocationId:`inv-${axis}`,contextId:`ctx-${axis}`,startedAt:'2026-11-13T00:00:00.000Z',completedAt:'2026-11-13T00:01:00.000Z',command:{argv:['declared-fixture'],cwd:'/fixture',startedAt:inside?'2026-11-13T00:00:10.000Z':'2026-11-12T23:59:00.000Z',completedAt:inside?'2026-11-13T00:00:50.000Z':'2026-11-13T00:02:00.000Z',exitCode:0},promptSha256:'d'.repeat(64),transcriptSha256:'e'.repeat(64),evidenceRef:'declared-control',baseCommit:'a'.repeat(40),candidateCommit:'b'.repeat(40),diffSha256:'c'.repeat(64)});
      await assert.rejects(narrow.service.submitReport(narrow.reviewerAccess,narrow.project.id,narrow.task.id,narrow.round.id,{expectedTaskRevision:narrow.task.revision,expectedRoundRevision:narrow.round.revision,axis:'spec',verdict:'pass',body:'不覆盖',sources:['declared'],evidence:evidence('spec',true)}),{reason:'review_evidence_execution_invalid'});
      for(const d of [outer,narrow]){
        let round=d.round;
        for(const axis of ['spec','standards'] as const){await d.service.submitReport(d.reviewerAccess,d.project.id,d.task.id,round.id,{expectedTaskRevision:d.task.revision,expectedRoundRevision:round.revision,axis,verdict:'pass',body:'原服务接受的外层命令',sources:['declared'],evidence:evidence(axis)});round=(await f.repos.tasks.getRound(d.project.id,d.task.id,round.id))!;}
        assert.equal(round.state,'reported');
      }
      // Persisted corruption has a correct content digest, so only interval semantics reject it.
      for(const report of await f.repos.tasks.listReports(narrow.project.id,narrow.task.id,narrow.round.id)){
        const changed=evidence(report.axis,true),digest=createHash('sha256').update(JSON.stringify({axis:report.axis,verdict:report.verdict,body:report.body,sources:report.sources,evidence:changed})).digest('hex');
        await f.db.exec('UPDATE task_review_reports SET evidence=?,content_sha256=? WHERE id=?',[JSON.stringify(changed),digest,report.id]);
      }
      const before=await originalRows(f.db);await f.db.migrate(migrations);const result=await initializeDecisionStorage(f.db);
      for(const d of [equal,outer])assert.equal((await f.db.query('SELECT id FROM decision_records WHERE project_id=?',[d.project.id])).length,1);
      assert.equal((await f.db.query('SELECT id FROM decision_records WHERE project_id=?',[narrow.project.id])).length,0);
      assert.ok(result.diagnostics.some(d=>d.projectId===narrow.project.id&&d.code==='review_reports_invalid'));
      assert.deepEqual(await originalRows(f.db),before);assert.deepEqual(await f.db.query('SELECT * FROM decision_executions'),[]);
    }finally{await f.close();}
  });
  test(`${engine}: nonempty v19 initialization preserves old decisions, imports full legacy and creates only blocked pending`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine,19);try {
      await initializePolicyConfiguration(f.repos);const old=await decisionDomainFixture(f.repos,'decided'),ready=await decisionDomainFixture(f.repos,'ready'),running=await decisionDomainFixture(f.repos,'running'),reported=await decisionDomainFixture(f.repos,'reported');
      const before=await originalRows(f.db);await f.db.migrate(migrations);
      const result=await initializeDecisionStorage(f.db);assert.equal(result.pendingCreated,1);assert.equal(result.legacyImported,2);assert.equal(result.complete,true);
      assert.deepEqual(await originalRows(f.db),before);
      for(const d of [old,ready,running,reported])await createDecisionRepository(f.db).readProject(d.project.id);
      const rows=await f.db.query('SELECT * FROM decision_records');assert.equal(rows.length,1);assert.equal(rows[0]!.status,'pending');assert.equal(rows[0]!.required_authority,null);
      const observation=JSON.parse(rows[0]!.policy_evaluation_json as string);assert.equal(observation.executionAdmission,'not-issued');assert.equal(observation.outcome,'deny');assert.ok(observation.reasons.some((r:{code:string})=>r.code==='handler_unavailable'));
      for(const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_executions','decision_command_receipts'])assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`),[]);
      const replay=await initializeDecisionStorage(f.db);assert.equal(replay.pendingCreated,0);assert.equal(replay.legacyImported,0);assert.deepEqual(await originalRows(f.db),before);
    }finally{await f.close();}
  });
  test(`${engine}: initializer requires global policy, rolls back failed batch and restarts without duplicate effects`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine,19);try {
      await assert.rejects(initializeDecisionStorage(f.db),{reason:'policy_not_initialized'});assert.deepEqual(await f.db.query('SELECT * FROM policy_documents'),[]);
      await initializePolicyConfiguration(f.repos);await decisionDomainFixture(f.repos);await decisionDomainFixture(f.repos);
      await f.db.migrate(migrations);
      const exec=f.db.exec.bind(f.db),failure=new Error('second insert injected');let count=0;
      f.db.exec=(sql,params)=>{if(/^INSERT INTO decision_records /.test(sql)&&++count===2)return Promise.reject(failure);return exec(sql,params);};
      try{await assert.rejects(initializeDecisionStorage(f.db,{batchSize:1}),e=>e===failure);}finally{f.db.exec=exec;}
      assert.equal((await f.db.query('SELECT * FROM decision_records')).length,1);
      assert.equal((await initializeDecisionStorage(f.db,{batchSize:1})).pendingCreated,1);
      assert.equal((await f.db.query('SELECT * FROM decision_records')).length,2);assert.deepEqual(await f.db.query('SELECT * FROM decision_executions'),[]);
    }finally{await f.close();}
  });
  test(`${engine}: R-157-REQ-003 legacy initialization commits at most 100 Round slots per transaction and resumes the failed batch`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine,19);try {
      await initializePolicyConfiguration(f.repos);const d=await decisionDomainFixture(f.repos,'decided');
      const round=(await f.db.query('SELECT * FROM task_review_rounds WHERE id=?',[d.round.id]))[0]!;
      const histories=await f.db.query("SELECT * FROM task_history WHERE task_id=? AND action='task.review_decided' ORDER BY task_revision,id",[d.task.id]);
      assert.equal(histories.length,2);
      const insert=async(table:string,row:Record<string,unknown>)=>{const columns=Object.keys(row);await f.db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,columns.map(key=>row[key]));};
      // Synthetic legacy inputs derived from the production Task fixture; this
      // checks import/rollback boundaries, not 101 actual model review runs.
      for(let n=1;n<=100;n++){
        const roundId=`legacy-batch-round-${String(n).padStart(3,'0')}`;await insert('task_review_rounds',{...round,id:roundId});
        for(const [i,history] of histories.entries())await insert('task_history',{...history,id:`legacy-batch-history-${n}-${i}`,detail:JSON.stringify({...JSON.parse(history.detail as string),roundId})});
      }
      const before=await originalRows(f.db);assert.equal((await f.db.query('SELECT * FROM task_review_rounds')).length,101);await f.db.migrate(migrations);
      const exec=f.db.exec.bind(f.db),failure=new Error('second legacy batch insert injected');let count=0;
      f.db.exec=(sql,params)=>{if(/^INSERT INTO decision_legacy_records\b/.test(sql)&&++count===201)return Promise.reject(failure);return exec(sql,params);};
      try{await assert.rejects(initializeDecisionStorage(f.db),e=>e===failure);}finally{f.db.exec=exec;}
      const committed=await f.db.query('SELECT * FROM decision_legacy_records ORDER BY id');
      assert.equal(count,201);assert.equal(committed.length,200,'a failure in Round 101 cannot roll back the first 100 Round slots');
      assert.equal((await f.db.query('SELECT * FROM decision_review_projections')).length,100);
      assert.equal(new Set(committed.map(row=>row.round_id)).size,100);
      const recovered=await Promise.all([initializeDecisionStorage(f.db),initializeDecisionStorage(f.db)]);
      assert.equal(recovered.reduce((total,result)=>total+result.legacyImported,0),2,'concurrent restart imports each remaining source once');
      assert.equal((await f.db.query('SELECT * FROM decision_legacy_records')).length,202);
      assert.equal((await f.db.query('SELECT * FROM decision_review_projections')).length,101);
      const after=await f.db.query('SELECT * FROM decision_legacy_records ORDER BY id');
      assert.equal((await initializeDecisionStorage(f.db)).legacyImported,0);
      assert.deepEqual(await f.db.query('SELECT * FROM decision_legacy_records ORDER BY id'),after);
      for(const row of committed)assert.deepEqual(after.find(next=>next.id===row.id),row,'completed batch provenance remains byte-for-byte stable');
      assert.deepEqual(await originalRows(f.db),before);
      for(const table of ['decision_records','decision_user_events','decision_local_initiations','decision_resolutions','decision_executions','decision_command_receipts'])assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`),[]);
      await createDecisionRepository(f.db).readProject(d.project.id);
    }finally{await f.close();}
  });
  test(`${engine}: initializer keeps archived/inactive/malformed sources diagnostic with no fabricated actor or effects`,{skip:identitySkip(engine)},async()=>{
    const f=await identityFixture(engine,19);try {
      await initializePolicyConfiguration(f.repos);
      const archived=await decisionDomainFixture(f.repos),inactive=await decisionDomainFixture(f.repos),badHash=await decisionDomainFixture(f.repos),badJson=await decisionDomainFixture(f.repos),badCandidate=await decisionDomainFixture(f.repos);
      await f.db.exec('UPDATE projects SET archived_at=? WHERE id=?',['2026-11-13T00:02:00.000Z',archived.project.id]);
      await f.db.exec("UPDATE members SET status='disabled',membership_revision=membership_revision+1 WHERE id=?",[inactive.reviewer.id]);
      await f.db.exec("UPDATE task_review_reports SET content_sha256=? WHERE round_id=?",['0'.repeat(64),badHash.round.id]);
      await f.db.exec('UPDATE task_review_reports SET evidence=? WHERE round_id=?',['{',badJson.round.id]);
      await f.db.exec('UPDATE task_review_rounds SET candidate=? WHERE id=?',['{',badCandidate.round.id]);
      const before=await originalRows(f.db);
      await f.db.migrate(migrations);
      const result=await initializeDecisionStorage(f.db);assert.equal(result.pendingCreated,0);assert.equal(result.complete,true);
      assert.ok(result.diagnostics.some(d=>d.projectId===inactive.project.id&&d.code==='evaluation_incomplete'));
      assert.ok(result.diagnostics.some(d=>d.projectId===badHash.project.id&&d.code==='review_reports_invalid'));
      for(const d of [badJson,badCandidate])assert.ok(result.diagnostics.some(x=>x.projectId===d.project.id&&x.code==='source_json_invalid'));
      assert.deepEqual(await originalRows(f.db),before);
      for(const table of ['decision_records','decision_resolutions','decision_executions','decision_user_events','decision_local_initiations'])assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`),[]);
    }finally{await f.close();}
  });
}

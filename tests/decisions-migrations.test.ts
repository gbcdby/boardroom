import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { migrations } from '../src/server/db/migrations/index.ts';

const v20Catalog = migrations.filter(m => m.version <= 20);
const names = ['decision_legacy_records','decision_action_requests','decision_records','decision_review_heads','decision_user_events','decision_local_initiations','decision_resolutions','decision_executions','decision_command_receipts','decision_review_projections','decision_change_heads','decision_changes'];
for (const engine of identityEngines) {
  test(`${engine}: Decision v20 preserves v1–19 and nonempty MCP/audit, is idempotent`, {skip:identitySkip(engine)}, async () => {
    const f=await identityFixture(engine,19);
    try {
      const before=await f.db.migrationState();
      const project=await f.repos.projects.create({name:'v19 audit preservation'});
      const auditColumns=['id','scope','project_id','actor_kind','actor_member_id','actor_name','action','target_kind','target_id','target_name','changed','before','after','detail','reversed_at','reversed_by_audit_id','created_at'];
      const at='2026-11-13T00:00:00.000Z';
      for(const [id,scope,pid,reversed,reverseId] of [['audit-old','project',project.id,at,'audit-reverse'],['audit-reverse','project',project.id,null,null],['audit-user','user',null,null,null]]) {
        await f.db.exec(`INSERT INTO audit_log (${auditColumns.join(',')}) VALUES (${auditColumns.map(()=>'?').join(',')})`,[id,scope,pid,'human',null,'原人 🧪','task.review_decided','task','old-task','旧名','{"field":{"from":"旧","to":"新"}}','{"raw":"before"}','{"raw":"after"}','{"text":"保留\\u0000\\ud800"}',reversed,reverseId,at]);
      }
      const audit=await f.db.query('SELECT * FROM audit_log ORDER BY id');assert.equal(Object.keys(audit[0]!).length,17);
      const indexSql=engine==='sqlite'?"SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='audit_log' AND name LIKE 'ix_audit_%' ORDER BY name":"SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND tablename='audit_log' AND indexname LIKE 'ix_audit_%' ORDER BY indexname";
      const indexes=await f.db.query(indexSql);assert.deepEqual(indexes.map(r=>r.name),['ix_audit_project_action','ix_audit_project_created','ix_audit_project_target','ix_audit_user_created']);
      await f.db.exec("INSERT INTO mcp_connections (id,revision,created_at,updated_at) VALUES (?,?,?,?)",['old-mcp',1,'2026-11-13T00:00:00.000Z','2026-11-13T00:00:00.000Z']);
      const mcp=await f.db.query('SELECT * FROM mcp_connections');
      assert.equal(v20Catalog.at(-1)?.version,20);
      assert.equal((await f.db.migrate(v20Catalog)).version,20);
      assert.deepEqual((await f.db.migrationState()).applied.slice(0,19),before.applied);
      assert.deepEqual(await f.db.query('SELECT * FROM mcp_connections'),mcp);
      assert.deepEqual(await f.db.query('SELECT * FROM audit_log ORDER BY id'),audit);
      assert.deepEqual(await f.db.query(indexSql),indexes);
      for (const name of names) assert.deepEqual(await f.db.query(`SELECT * FROM ${name}`),[]);
      assert.equal((await f.db.migrate(v20Catalog)).applied.length,0);
    } finally { await f.close(); }
  });
  test(`${engine}: a failed v20 rolls back DDL and does not advance migration state`, {skip:identitySkip(engine)}, async () => {
    const f=await identityFixture(engine,19);
    try {
      const before=await f.db.migrationState(); const v20=migrations.find(m=>m.version===20); assert.ok(v20);
      const bad={...v20,up:v20.up+'\nSELECT boardroom_missing_migration_function();',upPostgres:v20.upPostgres+'\nSELECT boardroom_missing_migration_function();'};
      await assert.rejects(f.db.migrate([...migrations.slice(0,19),bad]));
      assert.deepEqual(await f.db.migrationState(),before);
      await assert.rejects(f.db.query('SELECT * FROM decision_records'));
    } finally { await f.close(); }
  });
}

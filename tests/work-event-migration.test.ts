import type { DbRow } from '../src/server/db/driver.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { migrations } from '../src/server/db/migrations/index.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { seedDecisionMigrationSource } from './helpers/decisions-migration-fixture.ts';
import { validateWorkEventInvalidations } from '../src/server/tasks/work-event-storage.ts';
import { m1Capture, m1Sqlite } from './helpers/m1-fixture.ts';
import { copyAllTables, clearTargetTables, BUSINESS_TABLES } from '../src/server/db/migrate-data.ts';
import { withM1Cleanup } from '../src/server/db/m1-resources.ts';
import { SqliteDriver } from '../src/server/db/drivers/sqlite.ts';
import { assertSqliteGuardCoverage } from '../src/server/storage/schema-guards.ts';

for (const engine of identityEngines) test(`${engine}: WL09 v19→v20→v21 preserves checksums/nonempty rows and old v2 compensation`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine, 19);
  try {
    const project = await f.repos.projects.create({ name: '旧库实际审计' }), org = createOrgMutationService({ repos: f.repos });
    const access = { actor: ownerActor() };
    const added = await org.addMember(access, { projectId: project.id, kind: 'human', displayName: '旧版本人' });
    const removed = await org.removeMember(access, project.id, added.member.id);
    const before = await f.db.query('SELECT * FROM audit_log ORDER BY id');
    await f.db.migrate(migrations.filter(m => m.version <= 20));
    const versions = await f.db.migrationState(), members = await f.db.query('SELECT * FROM members');
    assert.equal(versions.version, 20);
    assert.equal((await f.db.migrate(migrations)).version, 21);
    assert.deepEqual((await f.db.migrationState()).applied.slice(0,20), versions.applied);
    assert.deepEqual(await f.db.query('SELECT * FROM audit_log ORDER BY id'), before);
    assert.deepEqual(await f.db.query('SELECT * FROM members'), members);
    assert.deepEqual(await f.db.query('SELECT * FROM work_event_delivery_invalidations'), []);
    assert.equal((await f.db.migrate(migrations)).applied.length, 0);
    const compensation = createAuditCompensationService({ repos: f.repos });
    const undo = await compensation.revoke(access, project.id, removed.auditId);
    assert.equal((await f.repos.members.get(added.member.id))!.membershipRevision, 3);
    await compensation.revoke(access, project.id, undo.id);
    assert.equal((await f.repos.members.getIncludingRemoved(added.member.id))!.membershipRevision, 4);
  } finally { await f.close(); }
});

for (const engine of identityEngines) test(`${engine}: WL09 failed v21 remains at exact v20 and leaves no sidecar`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine, 20);
  try {
    const before = await f.db.migrationState(), v21 = migrations.find(m => m.version === 21)!;
    const bad = { ...v21, up: v21.up + '\nSELECT missing_v21_function();', upPostgres: v21.upPostgres + '\nSELECT missing_v21_function();' };
    await assert.rejects(f.db.migrate([...migrations.filter(m => m.version < 21), bad]));
    assert.deepEqual(await f.db.migrationState(), before);
    await assert.rejects(f.db.query('SELECT * FROM work_event_delivery_invalidations'));
  } finally { await f.close(); }
});

test('WL10/11 SQLite 58-table source validates exact audit closure; sidecar tampering rejects copy; purge and clear preserve other graphs', async () => {
  const source = await m1Sqlite(), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    await seedDecisionMigrationSource(source.db);
    const before = await m1Capture(source.db); validateWorkEventInvalidations(before);
    assert.equal(BUSINESS_TABLES.length, 58);
    const rows = before.work_event_delivery_invalidations!; assert.equal(rows.length, 3);
    assert.ok(source.db instanceof SqliteDriver);
    const raw=source.db.handle;assertSqliteGuardCoverage(raw);
    const initialControl=raw.prepare('SELECT * FROM storage_maintenance WHERE singleton=1').get() as Record<string,unknown>;
    raw.prepare(`UPDATE storage_maintenance SET admission='sealed',active_migration_id='wl-guard-control',plan_digest=?,
      control_root_json='{}',mutex_identity_json='{}',journal_record_ref='wl-guard-control',journal_digest=?,journal_sequence=1 WHERE singleton=1`).run('1'.repeat(64),'2'.repeat(64));
    try{
      for(const statement of [
        'INSERT INTO work_event_delivery_invalidations SELECT * FROM work_event_delivery_invalidations LIMIT 1',
        "UPDATE work_event_delivery_invalidations SET cause_action='restored'",
        'DELETE FROM work_event_delivery_invalidations',
      ])assert.throws(()=>raw.exec(statement),/BOARDROOM_STORAGE_MAINTENANCE/);
    }finally{raw.prepare(`UPDATE storage_maintenance SET ${Object.keys(initialControl).map(k=>k+'=?').join(',')} WHERE singleton=1`).run(...Object.values(initialControl));}
    assert.deepEqual(await source.db.query('SELECT * FROM work_event_delivery_invalidations'),rows);
    for (const variant of ['project','revision','unrelated-audit','missing-marker','all-markers-omitted','orphan'] as const) {
      const broken: Record<string, DbRow[]> = structuredClone(Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, [...rows]])));
      const marker = broken.work_event_delivery_invalidations![0]!;
      if (variant === 'project') marker.project_id = 'pr1';
      if (variant === 'revision') { marker.cause_from_revision = 8; marker.cause_to_revision = 9; }
      if (variant === 'unrelated-audit') marker.cause_audit_id = broken.audit_log!.find(r => r.action === 'task.review_decided')!.id;
      if (variant === 'missing-marker') broken.work_event_delivery_invalidations!.pop();
      if (variant === 'all-markers-omitted') {
        broken.work_event_delivery_invalidations = [];
        // Model the later same-ID restore: current presence alone cannot prove
        // the old event is eligible or replace the immutable audit closure.
        broken.members!.find(m => m.id === marker.cause_member_id)!.removed_at = null;
      }
      if (variant === 'orphan') marker.work_event_id = 'missing';
      assert.throws(() => validateWorkEventInvalidations(broken), /work_event_storage_invalid/, variant);
    }
    const originalMarker = { ...rows[0]! };
    const writeMarker = async (row: DbRow) => source.db.exec(`INSERT INTO work_event_delivery_invalidations (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row));
    await source.db.transaction(async () => {
      await source.db.exec('DELETE FROM work_event_delivery_invalidations WHERE work_event_id=?', [originalMarker.work_event_id]);
      await writeMarker({ ...originalMarker, cause_audit_id: before.audit_log!.find(r => r.action === 'task.review_decided')!.id });
    });
    await assert.rejects(copyAllTables(source.db, target.db), /work_event_storage_invalid/);
    for (const table of BUSINESS_TABLES) assert.deepEqual(await target.db.query(`SELECT * FROM ${table.name}`), []);
    await source.db.transaction(async () => {
      await source.db.exec('DELETE FROM work_event_delivery_invalidations WHERE work_event_id=?', [originalMarker.work_event_id]);
      await writeMarker(originalMarker);
    });
    await copyAllTables(source.db, target.db);
    const values=(rows:readonly DbRow[])=>rows.map(r=>JSON.stringify(r)).sort();
    assert.deepEqual(values((await m1Capture(target.db)).work_event_delivery_invalidations!),values(before.work_event_delivery_invalidations!));
    await assert.rejects(target.db.exec("UPDATE work_event_delivery_invalidations SET cause_action='removed'"), /immutable/);
    const { createRepositories } = await import('../src/server/db/repositories.ts');
    const repos = createRepositories(target.db), projectId = String(rows[0]!.project_id);
    const preview = await repos.projects.capturePurge(projectId);
    assert.equal(preview.cascade.workEventInvalidations, 3);
    const removed = await repos.projects.purge(projectId, preview.digest);
    assert.equal(removed.workEventInvalidations, 3);
    assert.deepEqual(await target.db.query('SELECT * FROM work_event_delivery_invalidations'), []);
    assert.ok((await target.db.query('SELECT * FROM decision_records')).length > 0);
    await clearTargetTables(target.db);
    for (const table of BUSINESS_TABLES) assert.deepEqual(await target.db.query(`SELECT * FROM ${table.name}`), []);
    const normalize=(graph:Readonly<Record<string,readonly DbRow[]>>)=>Object.fromEntries(Object.entries(graph).map(([table,rows])=>[table,values(rows)]));
    assert.deepEqual(normalize(await m1Capture(source.db)),normalize(before));
  }, [source.close, target.close]);
});

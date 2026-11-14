import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUSINESS_TABLES, clearTargetTables, copyAllTables, migrateData, validateData } from "../src/server/db/migrate-data.ts";
import { createDbDriver } from "../src/server/db/driver.ts";
import { DECISION_TABLES } from "../src/server/decisions/tables.ts";
import { withM1Cleanup } from "../src/server/db/m1-resources.ts";
import { m1Capture, m1DropSchema, m1PgUrl, m1Postgres, m1Schema, m1Sqlite, m1ValueOracle } from "./helpers/m1-fixture.ts";
import { DECISION_MIGRATION_TABLES } from "./helpers/decisions-migration-fixture.ts";
import { seedDecisionDatabase } from "./helpers/decisions-database-fixture.ts";
import { canonicalJson } from "../src/server/policy/canonical.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { validateDecisionStorageGraph } from "../src/server/decisions/storage-validation.ts";

for(const engine of ['sqlite','postgres'] as const)for(const corruption of ['R-157-A-001','R-157-A-002'] as const){
  test(`M1 ${engine} ${corruption}: bad committed receipt rejects before target connect/creation and keeps source bytes`,{skip:engine==='postgres'&&!m1PgUrl?'真实 PostgreSQL 未配置':false},async t=>{
    const source=engine==='postgres'?await m1Postgres():await m1Sqlite();
    let directory=source.directory;
    try{
      // PG sources need only an owned empty parent, never a pre-opened destination DB.
      directory??=await mkdtemp(path.join(tmpdir(),'boardroom-m1-receipt-'));
      await seedDecisionDatabase(source.db);
      const captured=await m1Capture(source.db);validateDecisionStorageGraph(captured);
      await source.db.transaction(async tx=>{
        for(const spec of [...DECISION_TABLES].reverse())await tx.exec(`DELETE FROM ${spec.name}`);
        for(const spec of DECISION_TABLES)for(const original of captured[spec.name]!){
          const row={...original};
          if(spec.name==='decision_command_receipts'){
            const response=JSON.parse(row.response_json as string);
            if(corruption==='R-157-A-001'){row.input_decision_revision=99;response.receipt.inputDecisionRef.revision=99;}
            else response.task.revision=999;
            row.response_json=canonicalJson(response);
          }
          await tx.exec(`INSERT INTO ${spec.name} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row));
        }
      });
      const broken=await m1Capture(source.db),target={dataDir:path.join(directory,'receipt-target','nested')};
      const connect=SqliteDriver.prototype.connect,calls:{file:string|null;failed:boolean}[]=[];
      SqliteDriver.prototype.connect=function(){const call={file:null as string|null,failed:false};calls.push(call);const result=connect.call(this);void result.then(()=>{call.file=this.file;},()=>{call.failed=true;});return result;};
      try{await assert.rejects(migrateData(source.options,target),/decision_storage_invalid/);}
      finally{SqliteDriver.prototype.connect=connect;}
      assert.equal(calls.length,engine==='sqlite'?1:0,'only existing source may connect; target connect never starts');
      assert.ok(calls.every(call=>call.file!==null&&!call.failed&&!call.file.startsWith(target.dataDir)));
      assert.equal(existsSync(path.join(directory,'receipt-target')),false);
      assert.deepEqual(await m1Capture(source.db),broken);
      t.diagnostic(JSON.stringify({corruption,engine,targetConnectionAttempts:0,targetDirectoryCreated:false,sourceOriginalRowsPreserved:true}));
    }finally{await withM1Cleanup(async()=>{},[source.close,async()=>{if(engine==='postgres'&&directory)await rm(directory,{recursive:true,force:true});}]);}
  });
}

test("M1 SQLite 58 表每表非空，所有真实列原值保持、源与1–19记录不变、目标有独立维护身份", async () => {
  const source = await m1Sqlite(true), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    const before = await m1Capture(source.db), oracle = await m1ValueOracle(source.db);
    assert.deepEqual(BUSINESS_TABLES.map(t => t.name), [...DECISION_MIGRATION_TABLES]);
    for (const table of DECISION_MIGRATION_TABLES) assert.ok(before[table]!.length > 0, table);
    const versions = await source.db.query("SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version");
    const sourceIdentity = (await source.db.query("SELECT database_instance_id FROM storage_maintenance"))[0]!.database_instance_id;
    const targetIdentity = (await target.db.query("SELECT database_instance_id FROM storage_maintenance"))[0]!.database_instance_id;
    assert.notEqual(targetIdentity, sourceIdentity);
    const report = await migrateData(source.options, target.options);
    assert.equal(report.validation.ok, true);
    assert.equal(Object.keys(report.perTableCounts).length, 58);
    assert.ok(Object.values(report.perTableCounts).every(count => count > 0));
    assert.deepEqual(oracle(await m1Capture(target.db)), oracle(before));
    assert.deepEqual(await m1Capture(source.db), before);
    assert.deepEqual(await source.db.query("SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version"), versions);
    assert.equal((await target.db.query("SELECT database_instance_id FROM storage_maintenance"))[0]!.database_instance_id, targetIdentity);
    for (const spec of DECISION_TABLES) {
      const copied = BUSINESS_TABLES.find(table => table.name === spec.name)!;
      assert.deepEqual([...copied.keyColumns, ...copied.valueColumns!].sort(), Object.keys(before[spec.name]![0]!).sort());
    }
  }, [source.close, target.close]);
});

test("M1 SQLite↔真实PG 58 表全列原值；完整生产catalog、原M1镜像catalog与省略pgSchema均支持", {
  skip: !m1PgUrl ? "真实 PostgreSQL 未配置" : false,
}, async () => {
  const source = await m1Sqlite(true), production = await m1Postgres(), back = await m1Sqlite();
  const schema = m1Schema();
  const mirror = { dbDriver: "postgres" as const, pgConnectionString: m1PgUrl!, pgSchema: schema };
  const mirrorDriver = createDbDriver({ ...mirror, initializationOnConnect: "none" });
  await withM1Cleanup(async () => {
    const before = await m1Capture(source.db), oracle = await m1ValueOracle(source.db);
    const baseline = oracle(before);
    const forward = await migrateData(source.options, mirror);
    assert.ok(Object.values(forward.perTableCounts).every(count => count > 0));
    await mirrorDriver.connect();
    assert.deepEqual(oracle(await m1Capture(mirrorDriver)), baseline);
    assert.equal((await migrateData(mirror, back.options)).validation.ok, true);
    assert.deepEqual(oracle(await m1Capture(back.db)), baseline);
    // Existing production checksum catalog is retained as a whole on the target and as a source.
    const productionVersions = await production.db.query("SELECT version,checksum FROM schema_migrations ORDER BY version");
    assert.equal((await migrateData(source.options, production.options)).validation.ok, true);
    assert.deepEqual(await production.db.query("SELECT version,checksum FROM schema_migrations ORDER BY version"), productionVersions);
    const url = new URL(m1PgUrl!);
    url.searchParams.set("options", `-c search_path=${production.options.pgSchema}`);
    assert.equal((await migrateData({ dbDriver: "postgres", pgConnectionString: url.toString() }, back.options)).validation.ok, true);
    assert.deepEqual(oracle(await m1Capture(back.db)), baseline);
    assert.deepEqual(await m1Capture(source.db), before);
  }, [source.close, production.close, back.close, () => mirrorDriver.close(), () => m1DropSchema(schema)]);
});

test("M1 borrowed helper 保留外层SAVEPOINT回滚；target compare失败回滚全部copy且独立clear不恢复", async () => {
  const source = await m1Sqlite(true), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    await assert.rejects(target.db.transaction(async () => {
      await copyAllTables(source.db, target.db);
      throw new Error("caller_outer_rollback");
    }), /caller_outer_rollback/);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0);
    await copyAllTables(source.db, target.db);
    await target.db.exec(`CREATE TRIGGER m1_copy_compare_failure AFTER INSERT ON decision_change_heads
      BEGIN UPDATE decision_change_heads SET revision=revision+1 WHERE project_id=NEW.project_id; END`);
    await assert.rejects(migrateData(source.options, target.options), /m1_copy_validation_failed/);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0, "committed clear remains; failed copy rolled back");
    assert.ok(Object.values(await m1Capture(source.db)).every(rows => rows.length > 0));
    await target.db.exec("DROP TRIGGER m1_copy_compare_failure");
    assert.equal((await migrateData(source.options, target.options)).validation.ok, true);
    await clearTargetTables(target.db);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0);
  }, [source.close, target.close]);
});

for (const corruption of ["typed", "graph"] as const) {
  test(`M1 ${corruption} 坏行从同批Task/history/Decision图拒绝，目标未初始化且源原行不修复`, async () => {
    const source = await m1Sqlite(true);
    await withM1Cleanup(async () => {
      const captured = await m1Capture(source.db);
      // Controlled fixture construction uses admitted DELETE/INSERT, never disables guards or constraints.
      await source.db.transaction(async tx => {
        for (const spec of [...DECISION_TABLES].reverse()) await tx.exec(`DELETE FROM ${spec.name}`);
        for (const spec of DECISION_TABLES) for (const original of captured[spec.name]!) {
          const row = { ...original };
          if (corruption === "typed" && spec.name === "decision_action_requests") row.proposal_reason_json = '"  unnormalized  "';
          if (corruption === "graph" && spec.name === "decision_executions" && row.status === "succeeded") {
            row.before_task_revision = Number(row.before_task_revision) + 1;
            row.after_task_revision = Number(row.after_task_revision) + 1;
          }
          await tx.exec(`INSERT INTO ${spec.name} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, Object.values(row));
        }
      });
      const broken = await m1Capture(source.db);
      const target = { dataDir: path.join(source.directory!, "new-target", "nested") };
      await assert.rejects(migrateData(source.options, target), /decision_storage_invalid/);
      assert.equal(existsSync(path.join(source.directory!, "new-target")), false);
      assert.deepEqual(await m1Capture(source.db), broken);
    }, [source.close]);
  });
}

test("M1 source v19须先显式正常追加v20；M1拒绝期间不改源/建目标，升级后原1–19保持", async () => {
  const source = await m1Sqlite(false, 19), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    const before = await source.db.query("SELECT * FROM schema_migrations ORDER BY version");
    await assert.rejects(migrateData(source.options, target.options), /m1_source_relation_missing|m1_source_version/);
    assert.deepEqual(await source.db.query("SELECT * FROM schema_migrations ORDER BY version"), before);
    const { migrations } = await import("../src/server/db/migrations/index.ts");
    await source.db.migrate(migrations);
    assert.deepEqual(await source.db.query("SELECT * FROM schema_migrations WHERE version<=19 ORDER BY version"), before);
    assert.equal((await migrateData(source.options, target.options)).validation.ok, true);
    assert.equal((await validateData(source.options, target.options)).ok, true);
  }, [source.close, target.close]);
});

test("M1 保留递归readSql但不能静默漏掉孤立环，完整性失败必须在target初始化前拒绝", async () => {
  const source = await m1Sqlite();
  await withM1Cleanup(async () => {
    await source.db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('cycle-project','cycle','t','t')");
    await source.db.exec("INSERT INTO org_nodes(id,project_id,parent_id,name,role,created_at,updated_at) VALUES('cycle-a','cycle-project',NULL,'a','member','t','t')");
    await source.db.exec("INSERT INTO org_nodes(id,project_id,parent_id,name,role,created_at,updated_at) VALUES('cycle-b','cycle-project','cycle-a','b','member','t','t')");
    await source.db.exec("UPDATE org_nodes SET parent_id='cycle-b' WHERE id='cycle-a'");
    const before = await m1Capture(source.db), target = { dataDir: path.join(source.directory!, "cycle-target") };
    assert.equal(before.org_nodes!.length, 2);
    await assert.rejects(migrateData(source.options, target), /m1_source_ordered_read_incomplete:org_nodes/);
    assert.equal(existsSync(target.dataDir), false);
    assert.deepEqual(await m1Capture(source.db), before);
  }, [source.close]);
});

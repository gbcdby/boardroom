import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrations } from "../src/server/db/migrations/index.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { assertSqliteGuardCoverage } from "../src/server/storage/schema-guards.ts";
import { readSqliteMaintenanceState } from "../src/server/storage/admission.ts";
import { bindStorageDrainBoundary } from "../src/server/storage/drain-boundary.ts";
import { copyAllTables, clearTargetTables } from "../src/server/db/migrate-data.ts";

// 真实控制行的测试装配；本测试不把手填阶段当成 MaintenanceService 产物。
function setAdmission(db: Database.Database, admission: "draining" | "sealed") {
  db.prepare(`UPDATE storage_maintenance SET admission=?, fence_epoch=1,
    active_migration_id='fixture', plan_digest=?, control_root_json='{}', mutex_identity_json='{}',
    journal_record_ref='fixture', journal_digest=?, journal_sequence=1 WHERE singleton=1`)
    .run(admission, "a".repeat(64), "b".repeat(64));
}

test("#152 v18 只追加控制元数据；所有现有领域表和 schema_migrations 受持久 guard 保护", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations.filter(m => m.version < 18));
    const historical = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    runMigrations(db, migrations.filter(m => m.version <= 18));
    assert.equal((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {v:number}).v, 18);
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version<18 ORDER BY version").all(), historical);
    const state = db.prepare("SELECT * FROM storage_maintenance").get() as Record<string, unknown>;
    assert.equal(state.admission, "open");
    assert.equal(state.fence_epoch, 0);
    assert.equal("phase" in state, false);
    assert.match(String(state.database_instance_id), /^[a-f0-9]{32}$/);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
    setAdmission(db, "sealed");
    for (const {name} of tables.filter(t => !["storage_maintenance", "storage_source_clients"].includes(t.name))) {
      // SQLite 的 row trigger 在空表没有待写行时不触发；检查每表真实编译的 DELETE 程序。
      const program = db.prepare(`EXPLAIN DELETE FROM "${name}"`).all() as {p4:unknown}[];
      assert.ok(program.some(op=>op.p4==="BOARDROOM_STORAGE_MAINTENANCE"), name);
    }
    assert.equal((db.prepare("SELECT count(*) AS n FROM storage_source_clients").get() as {n:number}).n, 0);
  } finally { db.close(); }
});

test("#152 appended migrations extend actual catalog guards atomically; replay never repairs tampering", () => {
  const db=new Database(":memory:");
  try {
    runMigrations(db,migrations);
    const before=assertSqliteGuardCoverage(db);
    const next=[...migrations,{version:migrations.at(-1)!.version+1,name:"fixture_future_table",up:"CREATE TABLE future_domain(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO future_domain VALUES(1,'v');"}];
    runMigrations(db,next);
    assert.notEqual(assertSqliteGuardCoverage(db),before);
    setAdmission(db,"sealed");
    assert.throws(()=>db.prepare("UPDATE future_domain SET value='lost'").run(),/BOARDROOM_STORAGE_MAINTENANCE/);
    assert.throws(()=>runMigrations(db,next),/storage_maintenance/);
    db.exec("UPDATE storage_maintenance SET admission='open',active_migration_id=NULL,plan_digest=NULL,fence_epoch=2");
    const trigger=db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='future_domain' LIMIT 1").get() as {name:string};
    db.exec(`DROP TRIGGER "${trigger.name}"`);
    assert.throws(()=>runMigrations(db,next),/guard_incomplete/);
    assert.throws(()=>assertSqliteGuardCoverage(db),/guard_incomplete/);
  } finally {db.close();}
});

test("#152 missing control row fails closed in old DML and metadata diagnostics", () => {
  const db=new Database(":memory:");
  try {
    runMigrations(db,migrations);
    db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','n','t','t'); DELETE FROM storage_maintenance");
    assert.throws(()=>db.exec("DELETE FROM projects"),/BOARDROOM_STORAGE_MAINTENANCE/);
    assert.throws(()=>readSqliteMaintenanceState(db),/metadata_invalid/);
  } finally {db.close();}
});

test("#152 accepted SQLite transaction holds the real writer lock; reopening an epoch requires a new client", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"br-maintenance-inflight-"));
  const driver=new SqliteDriver({dataDir:dir});
  let controller: Database.Database | undefined;
  try {
    await driver.connect();await driver.migrate(migrations);
    controller=new Database(driver.file);controller.pragma("busy_timeout=1");
    await driver.transaction(async tx=>{
      assert.throws(()=>setAdmission(controller!,"draining"),/database is locked/);
      await tx.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','committed','t','t')");
    });
    setAdmission(controller,"draining");
    controller.exec("UPDATE storage_maintenance SET admission='open',active_migration_id=NULL,plan_digest=NULL,fence_epoch=2");
    await assert.rejects(driver.exec("UPDATE projects SET name='late'"),/epoch_changed/);
    assert.equal((controller.prepare("SELECT name FROM projects").get() as {name:string}).name,"committed");
    const fresh=new SqliteDriver({dataDir:dir});
    try {await fresh.connect();await fresh.exec("UPDATE projects SET name='new-client'");} finally {await fresh.close();}
  } finally {controller?.close();await driver.close();await rm(dir,{recursive:true,force:true});}
});

test("#152 logical business copy/clear preserves destination identity and refuses active source or target", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"br-maintenance-copy-"));
  const source=new SqliteDriver({dataDir:path.join(dir,"a")}),target=new SqliteDriver({dataDir:path.join(dir,"b")});
  try {
    await source.connect();await source.migrate(migrations);await target.connect();await target.migrate(migrations);
    await source.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','n','t','t')");
    const sourceId=readSqliteMaintenanceState(source.handle)!.databaseInstanceId;
    const targetId=readSqliteMaintenanceState(target.handle)!.databaseInstanceId;
    await copyAllTables(source,target);await clearTargetTables(target);
    assert.notEqual(sourceId,targetId);assert.equal(readSqliteMaintenanceState(target.handle)!.databaseInstanceId,targetId);
    setAdmission(source.handle,"draining");
    await assert.rejects(copyAllTables(source,target),/storage_maintenance/);
    assert.equal((target.handle.prepare("SELECT count(*) AS n FROM projects").get() as {n:number}).n,0);
    setAdmission(target.handle,"sealed");
    await assert.rejects(clearTargetTables(target),/storage_maintenance/);
    assert.equal(readSqliteMaintenanceState(target.handle)!.admission,"sealed");
  } finally {await source.close();await target.close();await rm(dir,{recursive:true,force:true});}
});

test("#152 bound lifecycle cleanup is epoch/client scoped, cannot admit a concurrent normal request or run after seal", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"br-maintenance-drain-"));
  const driver=new SqliteDriver({dataDir:dir});
  try {
    await driver.connect();await driver.migrate(migrations);
    const state=readSqliteMaintenanceState(driver.handle)!;
    driver.handle.prepare(`INSERT INTO storage_source_clients(client_id,database_instance_id,entrypoint,build_id,protocol_version,
      host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch,registered_at,last_observed_at)
      VALUES('c',?,'http','test',1,'{}','{}','[]',0,0,'t','t')`).run(state.databaseInstanceId);
    let invoked=0;
    const boundary=await bindStorageDrainBoundary(driver,{clientId:"c",identity:state,callbacks:{
      disconnect_sessions:async()=>{await driver.exec("UPDATE storage_source_clients SET last_observed_at='receipt' WHERE client_id='c'");invoked++;},
    }});
    setAdmission(driver.handle,"draining");
    driver.handle.exec("UPDATE storage_source_clients SET drain_epoch=1,drain_state='draining' WHERE client_id='c'");
    await boundary.invoke("disconnect_sessions",1);
    assert.equal(invoked,1);
    await assert.rejects(driver.exec("UPDATE projects SET name='ordinary'"),/storage_maintenance/);
    await assert.rejects(boundary.invoke("disconnect_sessions",0),/storage_maintenance/);
    setAdmission(driver.handle,"sealed");
    await assert.rejects(boundary.invoke("disconnect_sessions",1),/storage_maintenance/);
    boundary.revoke();
    assert.equal(invoked,1);
  } finally {await driver.close();await rm(dir,{recursive:true,force:true});}
});

test("#152 sealed survives controller connection close and blocks old prepared DML", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-maintenance-admission-"));
  const file = path.join(dir, "agent-studio.db");
  const controller = new Database(file);
  const old = new Database(file);
  try {
    runMigrations(controller, migrations);
    old.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','before','t','t')").run();
    const prepared = old.prepare("UPDATE projects SET name='after' WHERE id='p'");
    setAdmission(controller, "sealed");
    controller.close();
    assert.throws(() => prepared.run(), /BOARDROOM_STORAGE_MAINTENANCE/);
    assert.equal((old.prepare("SELECT name FROM projects WHERE id='p'").get() as {name:string}).name, "before");
  } finally { if (controller.open) controller.close(); old.close(); await rm(dir, {recursive:true,force:true}); }
});

test("#152 draining rejects new driver transactions, standalone exec and query-returning; a different source stays open", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-maintenance-driver-"));
  const driver = new SqliteDriver({dataDir:dir});
  try {
    await driver.connect(); await driver.migrate(migrations);
    setAdmission(driver.handle, "draining");
    await assert.rejects(driver.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','n','t','t')"), /storage_maintenance/);
    await assert.rejects(driver.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES('q','n','t','t') RETURNING id"), /storage_maintenance/);
    let entered = false;
    await assert.rejects(driver.transaction(async () => { entered=true; }), /storage_maintenance/);
    assert.equal(entered,false);
    const diagnostic = new Database(path.join(dir,"agent-studio.db"),{readonly:true,fileMustExist:true});
    assert.equal((diagnostic.prepare("SELECT count(*) AS n FROM projects").get() as {n:number}).n,0); diagnostic.close();
    const second = new SqliteDriver({dataDir:path.join(dir,"other")});
    try {await second.connect(); await second.migrate(migrations); await second.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','n','t','t')");}
    finally {await second.close();}
    const restarted = new SqliteDriver({dataDir:dir});
    await assert.rejects(restarted.connect(), /storage_maintenance/);
    await restarted.close();
  } finally {await driver.close(); await rm(dir,{recursive:true,force:true});}
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import path from "node:path";
import { buildM2ControlSchemaSql, M2ControlSchemaSqlError } from "../src/server/identity/m2-control-schema-sql.ts";
import type { M2ControlSchemaSqlPlan } from "../src/server/identity/m2-control-schema-sql.ts";
import { readM2RewriteFootprint } from "../src/server/identity/m2-rewrite-footprint.ts";
import type { M2RewriteFootprint } from "../src/server/identity/m2-rewrite-footprint.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { identityFixture, identityEngines, identitySkip, identityPgUrl } from "./helpers/identity-fixture.ts";
import { DATABASE_FILE_NAME } from "../src/server/db/database.ts";
import { renderPlaceholders } from "../src/server/db/dialect.ts";
import type { DbRow, DbTransaction } from "../src/server/db/driver.ts";

type Engine = typeof identityEngines[number];
type Fixture = Awaited<ReturnType<typeof identityFixture>>;
const tables = ["agent_runner_states", "agent_runtime_bindings", "agent_runtime_members", "storage_maintenance", "storage_source_clients"] as const;
const read = (f: Fixture, engine: Engine) => f.db.readSnapshot(s => readM2RewriteFootprint(s, engine));
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Mutable<T> = T extends ReadonlyArray<infer V> ? Mutable<V>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const clone = (value: M2RewriteFootprint): Mutable<M2RewriteFootprint> => JSON.parse(JSON.stringify(value));
function rehash(value: Mutable<M2RewriteFootprint>): M2RewriteFootprint {
  const { digest: _digest, ...data } = value;
  value.digest = createHash("sha256").update("boardroom:m2-rewrite-footprint:internal").update(Buffer.from([0])).update(canonicalJson(data)).digest("hex");
  return value as unknown as M2RewriteFootprint;
}
interface Session extends DbTransaction { close(): Promise<void> }
/** 仅测试文件使用：真实隔离机械连接，没有生产 source/window 或 A 许可。 */
async function session(f: Fixture, engine: Engine, namespace?: string): Promise<Session> {
  if (engine === "sqlite") {
    const db = new Database(path.join(f.dir, DATABASE_FILE_NAME), { fileMustExist: true, timeout: 150 });
    db.pragma("foreign_keys=ON");
    return {
      async query<T extends DbRow>(sql: string, params: readonly unknown[] = []) { return db.prepare(sql).all(...params) as T[]; },
      async exec(sql: string, params: readonly unknown[] = []) { if (params.length) return db.prepare(sql).run(...params).changes; db.exec(sql); return 0; },
      async close() { db.close(); },
    };
  }
  const client = new Client({ connectionString: identityPgUrl });
  await client.connect();
  try {
    const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    assert(version >= 160000 && version < 170000, "机械验收需要 PostgreSQL 16");
    const name = namespace ?? (await read(f, "postgres")).namespace.name;
    await client.query(`SET search_path TO ${quote(name)}`);
    return {
      async query<T extends DbRow>(sql: string, params: readonly unknown[] = []) { return (await client.query(renderPlaceholders(sql), [...params])).rows as T[]; },
      async exec(sql: string, params: readonly unknown[] = []) { return (await client.query(renderPlaceholders(sql), [...params])).rowCount ?? 0; },
      async close() { await client.end(); },
    };
  } catch (error) { await client.end(); throw error; }
}
async function seed(f: Fixture, engine: Engine) {
  const long = `{\r\n  "原文": "${"旧快照\\n".repeat(16000)}", "space": [ 1, 2 ]\r\n}`;
  await f.db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','历史项目','t','t')");
  for (let i = 0; i < 3; i++) {
    await f.db.exec("INSERT INTO groups(id,project_id,name,created_at,updated_at) VALUES(?,'p',?,'t','t')", [`g${i}`, `群${i}`]);
    await f.db.exec("INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES(?,?,'claude-code','t','t')", [`a${i}`, `Agent ${i}`]);
    await f.db.exec("INSERT INTO members(id,project_id,kind,agent_id,display_name,created_at,updated_at) VALUES(?,'p','agent',?,?,'t','t')", [`m${i}`, `a${i}`, `成员${i}`]);
    await f.db.exec("INSERT INTO agent_runtimes(id,agent_id,defaults_json,created_at,updated_at) VALUES(?,?,?,'t','t')", [`r${i}`, `a${i}`, long]);
    await f.db.exec("INSERT INTO agent_runtime_bindings(id,runtime_id,project_id,group_id,member_id,revision,overrides_json,advanced_json,desired_state,intent_revision,requested_snapshot_json,reset_session_requested,created_at,updated_at) VALUES(?,?,'p',?,?,?, ?,?,'stopped',?,?,?,'old-created','old-updated')",
      [`b${i}`, `r${i}`, `g${i}`, `m${i}`, i + 2, long, i ? long : null, i + 5, i === 1 ? null : long, i % 2]);
    await f.db.exec("INSERT INTO agent_runner_states(binding_id,state,phase,generation,lease_owner,lease_expires_at,applied_json,harness_session_id,session_key,session_state,pid,exit_confirmed,observed_at,started_at,attempt_count,next_retry_at,last_error_code,last_exit_code,last_exit_signal,permission_observed,updated_at,process_identity_json) VALUES(?,'stopped','unknown',?,?,?,?,?,?,'resumable',?,1,'observed','started',2,'next','old_error',-1,'SIGTERM','unknown','updated',?)",
      [`b${i}`, i + 7, i ? `owner${i}` : null, i ? `expiry${i}` : null, long, `SID${i}`, `session${i}`, i ? 47 + i : null, long]);
    await f.db.exec("INSERT INTO agent_runtime_members(member_id,runtime_id,project_id,binding_id,generation,lease_owner,lease_expires_at,updated_at) VALUES(?,?,'p',?,?,?,?,'t')", [`m${i}`, `r${i}`, `b${i}`, 9 + i, `member-owner${i}`, `member-expiry${i}`]);
    await f.db.exec("INSERT INTO storage_source_clients(client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch,drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) SELECT ?,database_instance_id,'http',?,1,?,?,?,4,5,?,?,?,'registered','observed',? FROM storage_maintenance",
      [`c${i}`, `build${i}`, long, long, '[ { "backend": "old" } ]', i === 1 ? 7 : null, i === 1 ? "drained" : "none", i === 1 ? "a".repeat(64) : null, i === 2 ? "ended-history" : null]);
  }
  await f.db.exec("CREATE TABLE unrelated_domain(id INTEGER PRIMARY KEY, original TEXT)");
  await f.db.exec("INSERT INTO unrelated_domain VALUES(1,?)", [long]);
  if (engine === "sqlite") {
    await f.db.exec("UPDATE storage_source_clients SET rowid=-rowid");
    await f.db.exec("UPDATE storage_source_clients SET rowid=CASE client_id WHEN 'c0' THEN 2 WHEN 'c1' THEN 9 ELSE 21 END");
    await f.db.exec("UPDATE storage_source_clients SET build_id=?,host_identity_json=? WHERE client_id='c0'", ["before\0after", Buffer.from([0, 1, 0, 255, 127])]);
  }
  await f.db.exec("UPDATE storage_maintenance SET fence_epoch=7,owner_generation=5,journal_record_ref='old-journal',journal_digest=?,journal_sequence=3,control_root_json=?,mutex_identity_json=? WHERE singleton=1", ["b".repeat(64), long, long]);
  // 夹具完成后重新取得真实连接，旧 epoch 的连接不参与后续机械验收。
  await f.db.close(); await f.db.connect();
}
async function projection(db: DbTransaction, engine: Engine, footprint: M2RewriteFootprint) {
  const values: Record<string, unknown> = {};
  for (const relation of footprint.relations) {
    const fields = relation.columns.flatMap((c, i) => engine === "sqlite"
      ? [`typeof(${quote(String(c.name))}) AS t${i}`, `CASE WHEN typeof(${quote(String(c.name))}) IN ('text','blob') THEN hex(${quote(String(c.name))}) ELSE ${quote(String(c.name))} END AS v${i}`]
      : [`pg_catalog.pg_typeof(${quote(String(c.name))})::pg_catalog.text AS t${i}`, `${quote(String(c.name))} AS v${i}`]);
    // reader 已核实五表首列分别为真实主键；PG 必须按主键值而非恒定的类型投影排序。
    const orderBy = engine === "sqlite" ? "original_rowid" : quote(String(relation.columns[0]!.name));
    values[relation.name] = await db.query(`SELECT ${engine === "sqlite" ? "rowid AS original_rowid," : ""}${fields.join(",")} FROM ${quote(footprint.namespace.name)}.${quote(relation.name)} ORDER BY ${orderBy}`);
  }
  for (const table of ["schema_migrations", "agent_runtimes", "projects", "groups", "agents", "members", "unrelated_domain"])
    values[table] = await db.query(`SELECT * FROM ${quote(footprint.namespace.name)}.${quote(table)} ORDER BY 1`);
  return values;
}

test("sqlite CS-06 real unsupported control catalogs and temporary dependencies are rejected intact", async t => {
  const f = await identityFixture("sqlite", 21); let s: Session | undefined;
  try {
    await seed(f, "sqlite"); const footprint = await read(f, "sqlite"), plan = buildM2ControlSchemaSql(footprint); s = await session(f, "sqlite");
    const before = await projection(s, "sqlite", footprint), catalog = await sqliteCatalog(s);
    const cases: [string, string, "reader" | "precheck"][] = [
      ["extra index", "CREATE INDEX unknown_control_index ON storage_maintenance(admission)", "reader"],
      ["control trigger", "CREATE TRIGGER unknown_control_trigger AFTER UPDATE ON storage_maintenance BEGIN SELECT 1; END", "reader"],
      ["extra incoming FK", "CREATE TABLE unknown_inbound(id TEXT REFERENCES storage_source_clients(client_id))", "reader"],
      ["main view", "CREATE VIEW unknown_main_view AS SELECT singleton FROM storage_maintenance", "reader"],
      ...["main", "temp"].flatMap(scope => ["__br_m2_control_saved_maintenance", "__br_m2_control_saved_clients"].flatMap(name => [name, name.toUpperCase()].map(n => [`${scope}/${n}`, `CREATE TABLE ${scope}.${quote(n)}(value TEXT)`, "precheck"] as [string, string, "precheck"]))),
      ...["storage_maintenance", "storage_source_clients"].map(name => [`temp shadow ${name}`, `CREATE TEMP TABLE ${quote(name.toUpperCase())}(value TEXT)`, "precheck"] as [string, string, "precheck"]),
      ["unrelated TEMP view", "CREATE TEMP VIEW unknown_temp_view AS SELECT 1 AS n", "precheck"],
      ["TEMP trigger on main", "CREATE TEMP TRIGGER unknown_temp_trigger AFTER UPDATE ON main.storage_maintenance BEGIN SELECT 1; END", "precheck"],
    ];
    for (const [label, sql, stage] of cases) await t.test(label, async () => {
      await s!.exec("BEGIN IMMEDIATE");
      try {
        await s!.exec(sql);
        const mutatedCatalog = await sqliteCatalog(s!);
        if (stage === "reader") await assert.rejects(async () => buildM2ControlSchemaSql(await readM2RewriteFootprint(s!, "sqlite")));
        else await assert.rejects(checkAll(s!, plan.prechecks));
        assert.deepEqual(await sqliteCatalog(s!), mutatedCatalog);
        assert.deepEqual(await projection(s!, "sqlite", footprint), before);
      } finally { await s!.exec("ROLLBACK"); }
      assert.deepEqual(await sqliteCatalog(s!), catalog);
    });
    const maintenanceDDL = footprint.relations.find(r => r.name === "storage_maintenance")!.createSql!;
    const clientsDDL = footprint.relations.find(r => r.name === "storage_source_clients")!.createSql!;
    for (const [label, transform] of [
      ["different CHECK", (sql: string) => sql.replace("fence_epoch >= 0", "fence_epoch >= -1")],
      ["different DEFAULT", (sql: string) => sql.replace("DEFAULT 'open'", "DEFAULT 'draining'")],
      ["different COLLATION", (sql: string) => sql.replace("database_instance_id TEXT NOT NULL UNIQUE", "database_instance_id TEXT COLLATE NOCASE NOT NULL UNIQUE")],
    ] as const) await t.test(label, async () => {
      await s!.exec("BEGIN IMMEDIATE");
      try {
        await s!.exec("CREATE TEMP TABLE raw_control AS SELECT * FROM storage_maintenance");
        await s!.exec("CREATE TEMP TABLE raw_clients AS SELECT rowid AS original_rowid,* FROM storage_source_clients");
        await s!.exec("DROP TABLE storage_source_clients"); await s!.exec("DROP TABLE storage_maintenance");
        await s!.exec(transform(maintenanceDDL)); await s!.exec(clientsDDL);
        await s!.exec("INSERT INTO storage_maintenance SELECT * FROM raw_control");
        await s!.exec("INSERT INTO storage_source_clients(rowid,client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,process_identity_json,db_sessions_json,registered_epoch,observed_epoch,drain_epoch,drain_state,drain_receipt_digest,registered_at,last_observed_at,ended_at) SELECT * FROM raw_clients");
        await s!.exec("CREATE INDEX storage_source_clients_epoch ON storage_source_clients(registered_epoch,ended_at)");
        await assert.rejects(async () => buildM2ControlSchemaSql(await readM2RewriteFootprint(s!, "sqlite")));
      } finally { await s!.exec("ROLLBACK"); }
      assert.deepEqual(await projection(s!, "sqlite", footprint), before); assert.deepEqual(await sqliteCatalog(s!), catalog);
    });
  } finally { await s?.close(); await f.close(); }
});

test("sqlite CS-06 fixed main PRAGMAs resist ordinary/virtual name shadows in main, TEMP and ATTACH", async t => {
  const f = await identityFixture("sqlite", 21);
  let plan: M2ControlSchemaSqlPlan;
  try { plan = buildM2ControlSchemaSql(await read(f, "sqlite")); } finally { await f.close(); }
  const checks = [plan.prechecks.find(c => c.id === "sqlite-fk-on-and-valid")!, plan.finalChecks.find(c => c.id === "sqlite-final-fk")!];
  for (const scope of ["main", "temp", "aux"]) for (const kind of ["ordinary", "virtual"]) for (const target of ["pragma_foreign_keys", "pragma_foreign_key_check", "both"]) for (const upper of [false, true]) for (const state of ["healthy", "off", "orphan"]) {
    await t.test(`${scope}/${kind}/${target}/${upper ? "upper" : "lower"}/${state}`, () => {
      const db = new Database(":memory:");
      try {
        db.pragma("foreign_keys=ON"); db.exec("CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(parent_id TEXT REFERENCES parent(id));");
        if (state !== "healthy") db.pragma("foreign_keys=OFF");
        if (state === "orphan") { db.exec("INSERT INTO child VALUES('absent')"); db.pragma("foreign_keys=ON"); }
        if (scope === "aux") db.exec("ATTACH ':memory:' AS aux");
        const names = target === "both" ? ["pragma_foreign_keys", "pragma_foreign_key_check"] : [target];
        for (const original of names) {
          const name = upper ? original.toUpperCase() : original;
          const column = original === "pragma_foreign_keys" ? "foreign_keys" : "value";
          db.exec(kind === "ordinary" ? `CREATE TABLE ${scope}.${quote(name)}(${column} INTEGER)` : `CREATE VIRTUAL TABLE ${scope}.${quote(name)} USING fts5(${column})`);
          if (original === "pragma_foreign_keys") db.prepare(`INSERT INTO ${scope}.${quote(name)}(${column}) VALUES(?)`).run(1);
        }
        for (const check of checks) {
          if (scope === "aux") assert.deepEqual(db.prepare(check.sql).all(), state === "healthy" ? [] : [{ violation: state === "off" ? "foreign_keys_off" : "foreign_key_violation" }]);
          else {
            try { assert.deepEqual(db.prepare(check.sql).all(), [{ violation: "pragma_name_shadow" }]); }
            catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_ERROR") throw error; }
          }
        }
      } finally { db.close(); }
    });
  }
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=OFF"); db.exec("ATTACH ':memory:' AS aux; CREATE VIRTUAL TABLE aux.pragma_foreign_keys USING fts5(foreign_keys); INSERT INTO aux.pragma_foreign_keys VALUES(1)");
    const fixed = checks[0]!.sql;
    assert.deepEqual(db.prepare(fixed.replaceAll("main.pragma_foreign_keys()", "pragma_foreign_keys()" )).all(), []);
    assert.deepEqual(db.prepare(fixed).all(), [{ violation: "foreign_keys_off" }]);
  } finally { db.close(); }
});

test("sqlite CS-10 real CHECK/FK copy errors roll back and copy checks detect changed typed bytes", async t => {
  const f = await identityFixture("sqlite", 21); let s: Session | undefined;
  try {
    await seed(f, "sqlite"); const footprint = await read(f, "sqlite"), plan = buildM2ControlSchemaSql(footprint); s = await session(f, "sqlite");
    const before = await projection(s, "sqlite", footprint), catalog = await sqliteCatalog(s);
    for (const kind of ["CHECK", "FK", "NUL bytes", "BLOB type"] as const) await t.test(kind, async () => {
      await s!.exec("BEGIN IMMEDIATE");
      try {
        await checkAll(s!, plan.prechecks);
        for (const step of plan.writesBeforeCopyCheck.slice(0, 6)) await s!.exec(step.sql);
        if (kind === "CHECK") {
          await s!.exec("UPDATE temp.__br_m2_control_saved_maintenance SET protocol_version=3");
          await assert.rejects(s!.exec(plan.writesBeforeCopyCheck[6]!.sql), /CHECK constraint failed/);
        } else if (kind === "FK") {
          await s!.exec("UPDATE temp.__br_m2_control_saved_clients SET database_instance_id='missing'");
          await s!.exec(plan.writesBeforeCopyCheck[6]!.sql);
          await assert.rejects(s!.exec(plan.writesBeforeCopyCheck[7]!.sql), /FOREIGN KEY constraint failed/);
        } else {
          for (const step of plan.writesBeforeCopyCheck.slice(6)) await s!.exec(step.sql);
          await s!.exec("UPDATE temp.__br_m2_control_saved_clients SET build_id=? WHERE client_id='c0'", [kind === "NUL bytes" ? "before\0changed" : Buffer.from("before\0after")]);
          assert.deepEqual(await s!.query(plan.copyChecks[1]!.sql), [{ violation: "old_typed_cell_or_rowid_mismatch" }]);
        }
      } finally { await s!.exec("ROLLBACK"); }
      assert.deepEqual(await projection(s!, "sqlite", footprint), before); assert.deepEqual(await sqliteCatalog(s!), catalog);
    });
  } finally { await s?.close(); await f.close(); }
});

for (const engine of identityEngines) test(`${engine} CS-14 separate connections never observe half a plan; fresh readback is physical only`, { skip: identitySkip(engine) }, async t => {
  for (const terminal of ["COMMIT", "ROLLBACK"]) await t.test(`discard ${terminal} acknowledgement`, async () => {
    const f = await identityFixture(engine, 21); let writer: Session | undefined, observer: Session | undefined;
    try {
      await seed(f, engine); const footprint = await read(f, engine), plan = buildM2ControlSchemaSql(footprint);
      writer = await session(f, engine); observer = await session(f, engine);
      const before = await projection(observer, engine, footprint), catalog = engine === "sqlite" ? await sqliteCatalog(observer) : null;
      if (engine === "postgres") await observer.exec("SET lock_timeout='50ms'");
      await writer.exec(engine === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        await applyPlan(writer, plan, async () => {
          if (engine === "sqlite") { assert.deepEqual(await projection(observer!, engine, footprint), before); assert.deepEqual(await sqliteCatalog(observer!), catalog); }
          else await assert.rejects(observer!.query(`SELECT * FROM ${quote(footprint.namespace.name)}.storage_maintenance`), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "55P03");
        });
        await writer.exec(terminal); // 人为丢弃确认；没有声称真实网络断连或断电。
      } catch (error) { await writer.exec("ROLLBACK"); throw error; }
      await writer.close(); writer = undefined; await observer.close(); observer = undefined;
      observer = await session(f, engine, footprint.namespace.name);
      assert.deepEqual(await projection(observer, engine, footprint), before);
      if (terminal === "COMMIT") {
        await checkAll(observer, plan.finalChecks);
        const columns = engine === "sqlite" ? await observer.query("SELECT name FROM main.pragma_table_info('storage_maintenance')")
          : await observer.query("SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid=?::pg_catalog.oid AND attnum>0 ORDER BY attnum", [footprint.relations.find(r => r.name === "storage_maintenance")!.oid]);
        assert(columns.some(c => c.name === "profile_takeover_terminal_json"));
        assert.equal(Object.hasOwn(plan, "authority"), false); assert.equal(Object.hasOwn(plan, "resumeAllowed"), false);
      } else assert.deepEqual(await read(f, engine), footprint);
    } finally { await writer?.close(); await observer?.close(); await f.close(); }
  });
});
async function sqliteCatalog(db: DbTransaction) {
  return { main: await db.query("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name"), temp: await db.query("SELECT type,name,tbl_name,sql FROM temp.sqlite_schema ORDER BY type,name") };
}
async function pgCatalog(db: DbTransaction, footprint: M2RewriteFootprint) {
  const ids = footprint.relations.map(r => r.oid), params = ids.map(() => "?::pg_catalog.oid").join(",");
  return {
    relations: await db.query(`SELECT oid::text AS oid,relname,relkind,relpersistence,relispartition,relrowsecurity,relforcerowsecurity,relam::text AS relam FROM pg_catalog.pg_class WHERE oid IN (${params}) ORDER BY oid`, ids),
    columns: await db.query(`SELECT a.attrelid::text AS table_oid,a.attnum,a.attname,a.atttypid::text AS type_oid,a.atttypmod,a.attnotnull,a.attisdropped,a.attidentity,a.attgenerated,a.attcollation::text AS collation_oid,d.oid::text AS default_oid,pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_expression FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid IN (${params}) AND a.attnum>0 ORDER BY a.attrelid,a.attnum`, ids),
    constraints: await db.query(`SELECT c.oid::text AS oid,c.conrelid::text AS table_oid,c.conname,c.contype,c.conindid::text AS index_oid,c.conkey,c.confkey,c.condeferrable,c.condeferred,c.convalidated,c.conislocal,c.conparentid::text AS parent,c.coninhcount,c.connoinherit,pg_catalog.pg_get_constraintdef(c.oid,false) AS definition FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (${params}) ORDER BY c.oid`, ids),
    indexes: await db.query(`SELECT i.*,pg_catalog.pg_get_indexdef(i.indexrelid,0,false) AS definition FROM pg_catalog.pg_index i WHERE i.indrelid IN (${params}) ORDER BY i.indexrelid`, ids),
    triggers: await db.query(`SELECT t.oid::text AS oid,t.tgrelid::text AS table_oid,t.tgname,t.tgenabled,t.tgtype,t.tgconstraint::text AS constraint_oid,t.tgisinternal,t.tgfoid::text AS function_oid,pg_catalog.pg_get_triggerdef(t.oid,false) AS definition FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN (${params}) ORDER BY t.oid`, ids),
  };
}
async function checkAll(db: DbTransaction, checks: M2ControlSchemaSqlPlan["prechecks"]) {
  for (const check of checks) assert.deepEqual(await db.query(check.sql, check.params), [], check.id);
}
async function applyPlan(db: DbTransaction, plan: M2ControlSchemaSqlPlan, afterWrite?: (index: number, id: string) => Promise<void>) {
  for (const lock of plan.locks) await db.exec(lock.sql);
  await checkAll(db, plan.prechecks);
  let count = 0;
  for (const step of plan.writesBeforeCopyCheck) { await db.exec(step.sql); await afterWrite?.(++count, step.id); }
  await checkAll(db, plan.copyChecks);
  for (const step of plan.cleanupWrites) { await db.exec(step.sql); await afterWrite?.(++count, step.id); }
  await checkAll(db, plan.finalChecks);
}
function assertFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    assert(Object.isFrozen(value)); for (const child of Object.values(value)) assertFrozen(child);
  }
}

test("CS-03 strict external data is copied from one descriptor snapshot without callbacks", async t => {
  const f = await identityFixture("sqlite", 21);
  try {
    const original = await read(f, "sqlite");
    const cases: [string, (value: Mutable<M2RewriteFootprint>) => unknown][] = [
      ["extra root", v => Object.assign(v, { extra: 1 })], ["symbol", v => Object.assign(v, { [Symbol("secret")]: 1 })],
      ["hidden", v => Object.defineProperty(v, "hidden", { value: 1 })], ["function", v => Object.assign(v, { fn() {} })],
      ["sparse", v => { delete (v.migrations as unknown[])[0]; return v; }],
      ["array extra", v => { Object.assign(v.migrations, { extra: 1 }); return v; }],
      ["cycle", v => Object.assign(v, { loop: v })], ["undefined", v => Object.assign(v, { x: undefined })],
      ...[NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, 1.5].map(n => [`number ${String(n)}`, (v: Mutable<M2RewriteFootprint>) => { v.migrations[0]!.version = n; return v; }] as [string, (v: Mutable<M2RewriteFootprint>) => unknown]),
    ];
    for (const [label, change] of cases) await t.test(label, () => assert.throws(() => buildM2ControlSchemaSql(change(clone(original)) as M2RewriteFootprint), errorCode("invalid_footprint")));
    let getters = 0;
    const getter = clone(original); Object.defineProperty(getter, "digest", { enumerable: true, get() { getters++; return original.digest; } });
    assert.throws(() => buildM2ControlSchemaSql(getter as unknown as M2RewriteFootprint), errorCode("invalid_footprint")); assert.equal(getters, 0);
    let keys = 0, prototypes = 0;
    const drift = new Proxy(clone(original), { ownKeys(target) { assert.equal(++keys, 1); return Reflect.ownKeys(target); }, getPrototypeOf() { prototypes++; throw new Error("do not inspect prototype"); } });
    assert.deepEqual(buildM2ControlSchemaSql(drift as unknown as M2RewriteFootprint), buildM2ControlSchemaSql(original));
    assert.equal(keys, 1); assert.equal(prototypes, 0);
    const missing = new Proxy(clone(original), { getOwnPropertyDescriptor(target, key) { return key === "digest" ? undefined : Object.getOwnPropertyDescriptor(target, key); } });
    assert.throws(() => buildM2ControlSchemaSql(missing as unknown as M2RewriteFootprint), errorCode("invalid_footprint"));
    const genuine = new M2ControlSchemaSqlError("catalog_budget");
    Object.assign(genuine, { code: "SECRET", message: "secret input" });
    assert.throws(() => buildM2ControlSchemaSql(new Proxy({}, { ownKeys() { throw genuine; } }) as M2RewriteFootprint), errorCode("catalog_budget"));
    const forged = Object.create(M2ControlSchemaSqlError.prototype); Object.assign(forged, { code: "catalog_budget", message: "secret" });
    assert.throws(() => buildM2ControlSchemaSql(new Proxy({}, { ownKeys() { throw forged; } }) as M2RewriteFootprint), errorCode("invalid_footprint"));
    assert.equal(new M2ControlSchemaSqlError("secret" as "invalid_footprint").message, "M2_CONTROL_SCHEMA_SQL: invalid_footprint");
  } finally { await f.close(); }
});

test("CS-04 fixed expanded JSON budgets reject before retaining an unbounded DAG", async t => {
  const f = await identityFixture("sqlite", 21);
  try {
    const base = await read(f, "sqlite");
    const near = clone(base); near.relations[0]!.createSql = "x".repeat(65536);
    assert(buildM2ControlSchemaSql(rehash(near)));
    for (const [label, value] of [
      ["raw string", "x".repeat(65537)], ["escaped bytes", Array.from({ length: 12 }, () => "\u0000".repeat(65536))],
      ["array", Array(4097).fill(null)], ["key", { ["x".repeat(65537)]: null }],
    ]) await t.test(String(label), () => assert.throws(() => buildM2ControlSchemaSql(Object.assign(clone(base), { excessive: value }) as unknown as M2RewriteFootprint), errorCode("catalog_budget")));
    let deep: unknown = null; for (let i = 0; i < 65; i++) deep = [deep];
    assert.throws(() => buildM2ControlSchemaSql(Object.assign(clone(base), { deep }) as unknown as M2RewriteFootprint), errorCode("catalog_budget"));
    let dag: unknown = null; for (let i = 0; i < 18; i++) dag = [dag, dag];
    assert.throws(() => buildM2ControlSchemaSql(Object.assign(clone(base), { dag }) as unknown as M2RewriteFootprint), errorCode("catalog_budget"));
    const shared = { chunk: "x".repeat(65536) };
    assert.throws(() => buildM2ControlSchemaSql(Object.assign(clone(base), { dag: Array(40).fill(shared) }) as unknown as M2RewriteFootprint), errorCode("catalog_budget"));
    const exact = clone(base);
    exact.relations[0]!.triggers = Array.from({ length: 32 }, (_, i) => ({ type: "trigger", name: `budget_${String(i).padStart(2, "0")}`, table_name: "agent_runner_states", definition: i < 31 ? "x".repeat(65536) : "" }));
    const remaining = 2 * 1024 * 1024 - Buffer.byteLength(canonicalJson(exact));
    assert(remaining > 0 && remaining <= 65536);
    exact.relations[0]!.triggers[31]!.definition = "x".repeat(remaining);
    assert.equal(Buffer.byteLength(canonicalJson(rehash(exact))), 2 * 1024 * 1024);
    const plan = buildM2ControlSchemaSql(exact as unknown as M2RewriteFootprint);
    const allSql = [plan.locks, plan.prechecks, plan.writesBeforeCopyCheck, plan.copyChecks, plan.cleanupWrites, plan.finalChecks].flat();
    assert(allSql.reduce((size, step) => size + Buffer.byteLength(step.sql), 0) <= 65536);
    exact.relations[0]!.triggers[31]!.definition += "x";
    assert.throws(() => buildM2ControlSchemaSql(rehash(exact)), errorCode("catalog_budget"));
  } finally { await f.close(); }
});

test("CS-05 redigested inconsistent identities and metadata cannot be promoted to a plan", async t => {
  const f = await identityFixture("sqlite", 21);
  try {
    const base = await read(f, "sqlite");
    const cases: [string, (v: Mutable<M2RewriteFootprint>) => void][] = [
      ["namespace", v => { v.namespace.name = "temp"; }], ["migration", v => { v.migrations[4]!.checksum = "0".repeat(16); }],
      ["table order", v => { v.relations.reverse(); }], ["column name", v => { v.relations[0]!.columns[0]!.name = "other"; }],
      ["column type", v => { v.relations[0]!.columns[0]!.type = "BLOB"; }], ["column ordinal", v => { v.relations[0]!.columns[0]!.ordinal = 1; }],
      ["column extra", v => { Object.assign(v.relations[0]!.columns[0]!, { extra: 1 }); }],
      ["relation extra", v => { Object.assign(v.relations[0]!, { permission: true }); }],
      ["index association", v => { v.relations[0]!.indexes[0]!.items[0]!.index_name = "other"; }],
      ["index column", v => { v.relations[0]!.indexes[0]!.items[0]!.cid = 73; }],
      ["incoming association", v => { v.incomingForeignKeys[0]!.id = "999"; }],
      ["foreign column", v => { v.relations[0]!.foreignKeys[0]!.pairs[0]!.from_column = "other"; }],
      ["legacy flags", v => { v.legacyBindingUniques[0]!.flags.partial = 1; }],
      ["legacy target", v => { v.legacyBindingUniques[0]!.keys.reverse(); }],
      ["legacy index", v => { v.legacyBindingUniques[0]!.indexName = "other"; }],
    ];
    for (const [label, mutate] of cases) await t.test(label, () => {
      const value = clone(base); mutate(value); assert.throws(() => buildM2ControlSchemaSql(rehash(value)), errorCode("invalid_footprint"));
    });
    const badHash = clone(base); badHash.digest = "f".repeat(64); assert.throws(() => buildM2ControlSchemaSql(badHash as unknown as M2RewriteFootprint), errorCode("invalid_footprint"));
  } finally { await f.close(); }
});

for (const engine of identityEngines) {
  test(`${engine} CS-07/08 exact mechanical plan preserves all 74 old columns and complete history`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 21); let s: Session | undefined;
    try {
      await seed(f, engine); const footprint = await read(f, engine), plan = buildM2ControlSchemaSql(footprint);
      s = await session(f, engine); const before = await projection(s, engine, footprint);
      const originalPgCatalog = engine === "postgres" ? await pgCatalog(s, footprint) : null;
      await s.exec(engine === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
      try { await applyPlan(s, plan); assert.deepEqual(await projection(s, engine, footprint), before); await s.exec("COMMIT"); }
      catch (error) { await s.exec("ROLLBACK"); throw error; }
      assert.deepEqual(await projection(s, engine, footprint), before);
      if (originalPgCatalog) {
        const after = await pgCatalog(s, footprint);
        assert.deepEqual(after.relations, originalPgCatalog.relations);
        assert.deepEqual(after.indexes, originalPgCatalog.indexes);
        assert.deepEqual(after.triggers, originalPgCatalog.triggers);
        assert.deepEqual(after.columns.filter(c => !["profile_takeover_terminal_json", "writer_format_digest"].includes(String(c.attname))), originalPgCatalog.columns);
        const protocol = footprint.relations.filter(r => r.name.startsWith("storage_")).flatMap(r => r.constraints!.filter(c => c.type === "c" && c.definition === "CHECK ((protocol_version = 1))"));
        const omitted = new Set([...protocol.map(c => c.name), "br_m2_storage_client_format_pair"]);
        assert.deepEqual(after.constraints.filter(c => !omitted.has(String(c.conname))), originalPgCatalog.constraints.filter(c => !omitted.has(String(c.conname))));
        for (const old of protocol) {
          const replacement = after.constraints.find(c => c.table_oid === old.table_oid && c.conname === old.name)!;
          assert(replacement); assert.notEqual(replacement.oid, old.oid);
          assert.equal(replacement.convalidated, true); assert.equal(replacement.condeferrable, false);
        }
        assert.equal(after.constraints.length, originalPgCatalog.constraints.length + 1);
      }
      await checkAll(s, plan.finalChecks);
      await assert.rejects(read(f, engine)); // P0 reader 不能冒充新布局 verifier。
      for (const table of tables) assert.equal((before[table] as unknown[]).length, table === "storage_maintenance" ? 1 : 3);
      assert.equal((before.schema_migrations as unknown[]).length, 21);
    } finally { await s?.close(); await f.close(); }
  });

  test(`${engine} CS-09 physical protocol domains do not imply writer permission`, { skip: identitySkip(engine) }, async t => {
    const f = await identityFixture(engine, 21); let s: Session | undefined;
    try {
      await seed(f, engine); const plan = buildM2ControlSchemaSql(await read(f, engine)); s = await session(f, engine);
      await s.exec(engine === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        await applyPlan(s, plan);
        for (const table of ["storage_maintenance", "storage_source_clients"]) for (const protocol of [0, 3]) await t.test(`${table}/${protocol}`, async () => {
          await s!.exec("SAVEPOINT domain_case");
          await assert.rejects(s!.exec(`UPDATE ${table} SET protocol_version=?`, [protocol]));
          await s!.exec("ROLLBACK TO SAVEPOINT domain_case"); await s!.exec("RELEASE SAVEPOINT domain_case");
        });
        for (const [protocol, writer, valid] of [[1, null, true], [1, "a".repeat(64), false], [2, null, false], [2, "a".repeat(63), false], [2, "a".repeat(64), true]] as const) await t.test(`client/${protocol}/${writer?.length ?? "null"}`, async () => {
          await s!.exec("SAVEPOINT domain_case");
          const action = () => s!.exec("UPDATE storage_source_clients SET protocol_version=?,writer_format_digest=?", [protocol, writer]);
          if (valid) await action(); else await assert.rejects(action());
          await s!.exec("ROLLBACK TO SAVEPOINT domain_case"); await s!.exec("RELEASE SAVEPOINT domain_case");
        });
        await s.exec("UPDATE storage_maintenance SET protocol_version=2,profile_takeover_terminal_json='physical-text-only'");
      } finally { await s.exec("ROLLBACK"); }
    } finally { await s?.close(); await f.close(); }
  });

  test(`${engine} CS-10 every completed write rolls back original catalog and full history`, { skip: identitySkip(engine) }, async t => {
    const f = await identityFixture(engine, 21); let s: Session | undefined;
    try {
      await seed(f, engine); const footprint = await read(f, engine), plan = buildM2ControlSchemaSql(footprint); s = await session(f, engine);
      const before = await projection(s, engine, footprint), catalog = engine === "sqlite" ? await sqliteCatalog(s) : await pgCatalog(s, footprint);
      for (let point = 1; point <= plan.writesBeforeCopyCheck.length + plan.cleanupWrites.length; point++) await t.test(`FAULT_INJECTED after write ${point}`, async () => {
        await s!.exec(engine === "sqlite" ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
          await assert.rejects(applyPlan(s!, plan, async index => { if (index === point) throw new Error(`FAULT_INJECTED_${point}`); }), new RegExp(`FAULT_INJECTED_${point}`));
        } finally { await s!.exec("ROLLBACK"); }
        assert.deepEqual(await projection(s!, engine, footprint), before);
        assert.deepEqual(engine === "sqlite" ? await sqliteCatalog(s!) : await pgCatalog(s!, footprint), catalog);
      });
    } finally { await s?.close(); await f.close(); }
  });
}
function errorCode(expected: string) {
  return (error: unknown) => {
    assert(error instanceof M2ControlSchemaSqlError);
    assert.equal(error.code, expected); assert.equal(error.message, `M2_CONTROL_SCHEMA_SQL: ${expected}`);
    assert.equal(Object.hasOwn(error, "cause"), false); return true;
  };
}

test("postgres CS-05/11 rejects redigested OID, FK, constraints and unsupported catalog changes", { skip: identitySkip("postgres") }, async t => {
  const f = await identityFixture("postgres", 21);
  try {
    const base = await read(f, "postgres");
    const cases: [string, (v: Mutable<M2RewriteFootprint>) => void, string][] = [
      ["invalid namespace oid", v => { v.namespace.oid = "0"; }, "invalid_footprint"],
      ["invalid namespace identifier", v => { v.namespace.name = "bad\0namespace"; }, "invalid_footprint"],
      ["invalid UTF16 identifier", v => { v.namespace.name = "\ud800"; }, "invalid_footprint"],
      ["too long identifier", v => { v.namespace.name = "界".repeat(22); }, "invalid_footprint"],
      ["column table oid", v => { v.relations[0]!.columns[0]!.table_oid = "1"; }, "invalid_footprint"],
      ["index table oid", v => { v.relations[0]!.indexes[0]!.metadata.table_oid = "1"; }, "invalid_footprint"],
      ["constraint table oid", v => { v.relations[0]!.constraints![0]!.table_oid = "1"; }, "invalid_footprint"],
      ["FK target oid", v => { v.relations[0]!.foreignKeys[0]!.targetOid = "1"; }, "invalid_footprint"],
      ["second protocol check", v => {
        const r = v.relations.find(r => r.name === "storage_maintenance")!;
        const c = r.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!;
        r.constraints!.push({ ...c, oid: "999999999", name: "extra_protocol" });
        r.constraints!.sort((a, b) => String(a.oid).localeCompare(String(b.oid)));
      }, "unsupported_control_catalog"],
      ["protocol NOT VALID", v => { v.relations.find(r => r.name === "storage_maintenance")!.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!.validated = false; }, "unsupported_control_catalog"],
      ["protocol alternate definition", v => { v.relations.find(r => r.name === "storage_maintenance")!.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!.definition = "CHECK ((protocol_version > 0))"; }, "unsupported_control_catalog"],
      ["protocol unsafe check identifier", v => { v.relations.find(r => r.name === "storage_maintenance")!.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!.name = "bad\0name"; }, "invalid_footprint"],
    ];
    for (const [label, mutate, expected] of cases) await t.test(label, () => {
      const value = clone(base); mutate(value); assert.throws(() => buildM2ControlSchemaSql(rehash(value)), errorCode(expected));
    });
  } finally { await f.close(); }
});

test("postgres CS-12 quoted real identifiers and extra source prechecks remain exact", { skip: identitySkip("postgres") }, async t => {
  const f = await identityFixture("postgres", 21); let s: Session | undefined;
  try {
    await seed(f, "postgres"); const footprint = await read(f, "postgres"), plan = buildM2ControlSchemaSql(footprint);
    const namespace = footprint.namespace.name; s = await session(f, "postgres");
    const before = await projection(s, "postgres", footprint), catalog = await pgCatalog(s, footprint);
    await t.test("actual quote and Unicode schema/CHECK names", async () => {
      await s!.exec("BEGIN");
      try {
        const renamed = `m2_引号"_${namespace.slice(-12)}`;
        for (const [i, r] of footprint.relations.filter(r => r.name.startsWith("storage_")).entries()) {
          const protocol = r.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!;
          await s!.exec(`ALTER TABLE ${quote(namespace)}.${quote(r.name)} RENAME CONSTRAINT ${quote(String(protocol.name))} TO ${quote(`协议"${i}`)}`);
        }
        await s!.exec(`ALTER SCHEMA ${quote(namespace)} RENAME TO ${quote(renamed)}`);
        await s!.exec(`SET LOCAL search_path TO ${quote(renamed)}`);
        const actual = await readM2RewriteFootprint(s!, "postgres"), quoted = buildM2ControlSchemaSql(actual);
        assert.equal(actual.namespace.name, renamed);
        assert(quoted.locks[0]!.sql.includes(quote(renamed)));
        await applyPlan(s!, quoted);
        assert.deepEqual(await projection(s!, "postgres", actual), before);
      } finally { await s!.exec("ROLLBACK"); }
    });
    const other = `${namespace}_other`, event = `m2_ev_${namespace.slice(-16)}`;
    const cases: [string, string[], string][] = [
      ["wrong current namespace", [`CREATE SCHEMA ${quote(other)}`, `SET LOCAL search_path TO ${quote(other)}`], "pg-source-identities"],
      ["cross namespace view", [`CREATE SCHEMA ${quote(other)}`, `CREATE VIEW ${quote(other)}.dependency AS SELECT singleton FROM ${quote(namespace)}.storage_maintenance`], "pg-no-rewrite-dependencies"],
      ["cross namespace materialized view", [`CREATE SCHEMA ${quote(other)}`, `CREATE MATERIALIZED VIEW ${quote(other)}.dependency AS SELECT singleton FROM ${quote(namespace)}.storage_maintenance`], "pg-no-rewrite-dependencies"],
      ["target rule", ["CREATE RULE ignored_control_update AS ON UPDATE TO storage_maintenance DO ALSO NOTHING"], "pg-no-rewrite-dependencies"],
      ["enabled event trigger", [`CREATE FUNCTION ${quote(namespace)}.event_probe() RETURNS event_trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN; END; $body$`, `CREATE EVENT TRIGGER ${quote(event)} ON ddl_command_start EXECUTE FUNCTION ${quote(namespace)}.event_probe()`], "pg-no-enabled-event-trigger"],
      ["occupied new CHECK name", ["ALTER TABLE storage_source_clients ADD CONSTRAINT br_m2_storage_client_format_pair CHECK (true)"], "pg-format-constraint-name-free"],
    ];
    for (const [label, setup, checkId] of cases) await t.test(label, async () => {
      await s!.exec("BEGIN");
      try {
        for (const sql of setup) await s!.exec(sql);
        const check = plan.prechecks.find(c => c.id === checkId)!;
        assert((await s!.query(check.sql, check.params)).length > 0, checkId);
        assert.deepEqual(await projection(s!, "postgres", footprint), before);
      } finally { await s!.exec("ROLLBACK"); }
      assert.deepEqual(await pgCatalog(s!, footprint), catalog);
    });
    const identityCheck = plan.prechecks.find(c => c.id === "pg-source-identities")!;
    for (const index of [0, 2, 3]) {
      const params = [...identityCheck.params]; params[index] = "4294967295";
      assert.deepEqual(await s.query(identityCheck.sql, params), [{ violation: "source_identity_mismatch" }]);
    }
    await s.exec("BEGIN");
    try {
      await s.exec(`CREATE SCHEMA ${quote(other)}`);
      await s.exec(`CREATE TABLE ${quote(other)}.storage_maintenance(original pg_catalog.text); INSERT INTO ${quote(other)}.storage_maintenance VALUES('other source')`);
      await s.exec(`CREATE TABLE ${quote(other)}.storage_source_clients(original pg_catalog.text); INSERT INTO ${quote(other)}.storage_source_clients VALUES('other clients')`);
      await applyPlan(s, plan);
      assert.deepEqual(await s.query(`SELECT * FROM ${quote(other)}.storage_maintenance`), [{ original: "other source" }]);
      assert.deepEqual(await s.query(`SELECT * FROM ${quote(other)}.storage_source_clients`), [{ original: "other clients" }]);
    } finally { await s.exec("ROLLBACK"); }
  } finally { await s?.close(); await f.close(); }
});

test("postgres CS-13 NOWAIT is enforced by two real connections before any write", { skip: identitySkip("postgres") }, async () => {
  const f = await identityFixture("postgres", 21); let owner: Session | undefined, contender: Session | undefined;
  try {
    await seed(f, "postgres"); const footprint = await read(f, "postgres"), plan = buildM2ControlSchemaSql(footprint);
    owner = await session(f, "postgres"); contender = await session(f, "postgres");
    const before = await projection(owner, "postgres", footprint), catalog = await pgCatalog(owner, footprint);
    await owner.exec("BEGIN"); await owner.exec("LOCK TABLE storage_maintenance IN ACCESS SHARE MODE"); await contender.exec("BEGIN");
    try { await assert.rejects(contender.exec(plan.locks[0]!.sql), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "55P03"); }
    finally { await contender.exec("ROLLBACK"); await owner.exec("ROLLBACK"); }
    assert.deepEqual(await projection(contender, "postgres", footprint), before); assert.deepEqual(await pgCatalog(contender, footprint), catalog);
    await contender.exec("BEGIN");
    try { await applyPlan(contender, plan); assert.deepEqual(await projection(contender, "postgres", footprint), before); }
    finally { await contender.exec("ROLLBACK"); }
  } finally { await contender?.close(); await owner?.close(); await f.close(); }
});

test("postgres CS-12 fixed builtins ignore actual search_path operator/function/aggregate shadows", { skip: identitySkip("postgres") }, async () => {
  const f = await identityFixture("postgres", 21); let s: Session | undefined;
  try {
    await seed(f, "postgres"); const footprint = await read(f, "postgres"), plan = buildM2ControlSchemaSql(footprint);
    const schema = quote(footprint.namespace.name); s = await session(f, "postgres");
    await s.exec("BEGIN");
    try {
      const operatorCases: [string, string, string, string][] = [
        ["eq_text", "=", "pg_catalog.text", "SELECT 'x'::pg_catalog.text = 'x'::pg_catalog.text"],
        ["ne_text", "<>", "pg_catalog.text", "SELECT 'x'::pg_catalog.text <> 'y'::pg_catalog.text"],
        ["eq_oid", "=", "pg_catalog.oid", "SELECT 1::pg_catalog.oid = 1::pg_catalog.oid"],
        ["eq_int4", "=", "pg_catalog.int4", "SELECT 1::pg_catalog.int4 = 1::pg_catalog.int4"],
        ["ne_int8", "<>", "pg_catalog.int8", "SELECT 1::pg_catalog.int8 <> 2::pg_catalog.int8"],
        ["lt_int2", "<", "pg_catalog.int2", "SELECT 1::pg_catalog.int2 < 2::pg_catalog.int2"],
        ["eq_array", "=", "pg_catalog.int2[]", "SELECT ARRAY[1,2]::pg_catalog.int2[] = ARRAY[1,2]::pg_catalog.int2[]"],
      ];
      for (const [name, operator, type] of operatorCases) {
        await s.exec(`CREATE FUNCTION ${schema}.${name}(${type},${type}) RETURNS pg_catalog.bool LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_${name}'; END; $body$`);
        await s.exec(`CREATE OPERATOR ${schema}.${operator} (LEFTARG=${type},RIGHTARG=${type},FUNCTION=${schema}.${name})`);
      }
      await s.exec(`CREATE FUNCTION ${schema}.length(pg_catalog.text) RETURNS pg_catalog.int4 LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_length'; END; $body$`);
      await s.exec(`CREATE FUNCTION ${schema}.unnest(pg_catalog.int2[]) RETURNS SETOF pg_catalog.int2 LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_unnest'; END; $body$`);
      await s.exec(`CREATE FUNCTION ${schema}.count_state(pg_catalog.int8) RETURNS pg_catalog.int8 LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_count'; END; $body$`);
      await s.exec(`CREATE AGGREGATE ${schema}.count(*) (SFUNC=${schema}.count_state,STYPE=pg_catalog.int8,INITCOND='0')`);
      await s.exec(`CREATE FUNCTION ${schema}.array_state(pg_catalog.int2[],pg_catalog.int2) RETURNS pg_catalog.int2[] LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'SHADOW_array_agg'; END; $body$`);
      await s.exec(`CREATE AGGREGATE ${schema}.array_agg(pg_catalog.int2) (SFUNC=${schema}.array_state,STYPE=pg_catalog.int2[],INITCOND='{}')`);
      await s.exec(`SET LOCAL search_path TO ${schema},pg_catalog`);
      for (const sql of [...operatorCases.map(c => c[3]), "SELECT length('x'::pg_catalog.text)", "SELECT unnest(ARRAY[1]::pg_catalog.int2[])", "SELECT count(*) FROM (VALUES(1)) AS n(x)", "SELECT array_agg(x::pg_catalog.int2) FROM (VALUES(1)) AS n(x)"]) {
        await s.exec("SAVEPOINT shadow_control");
        await assert.rejects(s.query(sql), /SHADOW_/);
        await s.exec("ROLLBACK TO SAVEPOINT shadow_control"); await s.exec("RELEASE SAVEPOINT shadow_control");
      }
      const identityCheck = plan.prechecks.find(c => c.id === "pg-source-identities")!;
      const wrong = [...identityCheck.params]; wrong[2] = "4294967295";
      assert.deepEqual(await s.query(identityCheck.sql, wrong), [{ violation: "source_identity_mismatch" }]);
      await applyPlan(s, plan); // 所有固定 SELECT/ALTER 均不能触发上面的真实哨兵。
      await checkAll(s, plan.finalChecks);
      const pair = plan.prechecks.find(c => c.id === "pg-format-constraint-name-free")!;
      assert.deepEqual(await s.query(pair.sql, pair.params), [{ violation: "format_constraint_name_taken" }]);
    } finally { await s.exec("ROLLBACK"); }
  } finally { await s?.close(); await f.close(); }
});

for (const engine of identityEngines) {
  test(`${engine} CS-01/02/05 pure plan accepts the real P0 footprint and detached JSON`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 21);
    try {
      const footprint = await read(f, engine);
      assert(footprint.legacyBindingUniques.some(u => footprint.relations.some(r => r.indexes.some(i => i.metadata === u.flags))));
      const plan: M2ControlSchemaSqlPlan = buildM2ControlSchemaSql(footprint);
      assert.equal(plan.kind, "m2-control-schema-sql"); assert.equal(plan.dialect, engine);
      assert.equal(plan.footprintDigest, footprint.digest); assertFrozen(plan);
      const independent = JSON.parse(JSON.stringify(footprint)) as M2RewriteFootprint;
      assert.deepEqual(buildM2ControlSchemaSql(independent), plan);
      const detached = clone(footprint); const detachedPlan = buildM2ControlSchemaSql(detached as unknown as M2RewriteFootprint);
      detached.namespace.name = "later change"; detached.relations[0]!.columns[0]!.name = "later change";
      assert.deepEqual(detachedPlan, plan);
      const { digest, ...value } = plan;
      const expected = createHash("sha256").update("boardroom:m2-control-schema-sql:internal").update(Buffer.from([0])).update(canonicalJson(value)).digest("hex");
      assert.equal(digest, expected);
      assert.deepEqual(plan.preserve.map(p => [p.table, p.columns.length]), tables.map((table, i) => [table, [22, 14, 8, 14, 16][i]]));
      assert.deepEqual([plan.locks.length, plan.prechecks.length, plan.writesBeforeCopyCheck.length, plan.copyChecks.length, plan.cleanupWrites.length, plan.finalChecks.length], engine === "sqlite" ? [0, 3, 9, 2, 2, 4] : [1, 4, 2, 0, 0, 3]);
      // 摘要来自共享 r3 的独立 SQL/JSON 原文，不由产品返回值生成期望。
      if (engine === "sqlite") {
        const snapshot = { locks: plan.locks, prechecks: plan.prechecks, writesBeforeCopyCheck: plan.writesBeforeCopyCheck, copyChecks: plan.copyChecks, cleanupWrites: plan.cleanupWrites, finalChecks: plan.finalChecks };
        assert.equal(createHash("sha256").update(canonicalJson(snapshot)).digest("hex"), "f50357b56e84f1f6baefb9073bf9226d44a1535a5597a61291bec5cff9d77824");
      } else {
        const protocolNames = footprint.relations.filter(r => r.name.startsWith("storage_")).map(r => r.constraints!.find(c => c.definition === "CHECK ((protocol_version = 1))")!.name as string);
        const sql = [plan.locks, plan.prechecks, plan.writesBeforeCopyCheck, plan.copyChecks, plan.cleanupWrites, plan.finalChecks].flat().map(step => step.sql
          .replaceAll(quote(footprint.namespace.name), "{{schema}}")
          .replaceAll(quote(protocolNames[0]!), "{{maintenance_protocol_check}}")
          .replaceAll(quote(protocolNames[1]!), "{{clients_protocol_check}}"));
        assert.equal(createHash("sha256").update(canonicalJson(sql)).digest("hex"), "a7f8ccc27d2875902abed29b518f3708c2fee04fb101e5d61bee829ac070bd3d");
      }
      assert.deepEqual(await read(f, engine), footprint);
    } finally { await f.close(); }
  });
}

test("CS-01 runtime exports contain only the pure builder and fixed error class", async () => {
  assert.deepEqual(Object.keys(await import("../src/server/identity/m2-control-schema-sql.ts")).sort(), ["M2ControlSchemaSqlError", "buildM2ControlSchemaSql"]);
});

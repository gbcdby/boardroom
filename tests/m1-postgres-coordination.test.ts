import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client, type QueryResult } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { createDbDriver, type DbReadSnapshot, type DbRow, type DbTransaction } from "../src/server/db/driver.ts";
import { BUSINESS_TABLES, M1_READ_PLAN, PG_BUSINESS_SCHEMA_MIGRATIONS, copyAllTables, migrateData, validateData } from "../src/server/db/migrate-data.ts";
import { checksumOf, migrationSql } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { withM1Cleanup } from "../src/server/db/m1-resources.ts";
import { m1Capture, m1DropSchema, m1PgControl, m1PgUrl, m1Postgres, m1Schema, m1Sqlite } from "./helpers/m1-fixture.ts";

const pg = { skip: !m1PgUrl ? "真实 PostgreSQL 未配置" : false };
type Reader<T> = (read: DbReadSnapshot) => Promise<T>;
type Transaction<T> = (tx: DbTransaction) => Promise<T>;

async function seededPg() {
  const source = await m1Sqlite(true), target = await m1Postgres();
  try { await copyAllTables(source.db, target.db); return target; }
  catch (error) { return withM1Cleanup(async () => { throw error; }, [target.close]); }
  finally { await source.close(); }
}

async function ownerFor(schema: string) {
  return m1PgControl(async client => {
    const rows = (await client.query(`SELECT DISTINCT a.pid, a.application_name,
      a.backend_start::text AS backend_start, a.xact_start::text AS xact_start
      FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
      WHERE l.relation=to_regclass($1) AND l.mode='RowShareLock'
        AND a.usename=current_user AND a.application_name LIKE 'boardroom-m1:%'`, [`"${schema}".storage_maintenance`])).rows;
    assert.equal(rows.length, 1, "exact live owner for the source maintenance relation");
    return rows[0]!;
  });
}

async function assertNamespaceMissing(schema: string): Promise<void> {
  await m1PgControl(async client => {
    assert.equal((await client.query("SELECT to_regnamespace($1)::text AS name", [schema])).rows[0]!.name, null);
  });
}

test("M1 PG none不存在source schema不创建，默认normal仍可创建；source拒绝前target不连接", pg, async () => {
  const sourceSchema = m1Schema(), targetSchema = m1Schema();
  const none = createDbDriver({ dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: sourceSchema, initializationOnConnect: "none" });
  const original = PostgresDriver.prototype.connect;
  let targetConnections = 0;
  const hook = mock.method(PostgresDriver.prototype, "connect", async function (this: PostgresDriver) {
    if (this.m1ExistingSourceOptions().pgSchema === targetSchema) targetConnections++;
    return original.call(this);
  });
  try {
    await none.connect();
    await assertNamespaceMissing(sourceSchema);
    await none.close();
    await none.connect();
    await assertNamespaceMissing(sourceSchema);
    await assert.rejects(migrateData({ dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: sourceSchema },
      { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: targetSchema }), /m1_source_namespace_missing/);
    assert.equal(targetConnections, 0);
    await assertNamespaceMissing(sourceSchema); await assertNamespaceMissing(targetSchema);
    const normal = createDbDriver({ dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: sourceSchema });
    await normal.connect(); await normal.close();
    await m1PgControl(async client => assert.equal((await client.query("SELECT to_regnamespace($1)::text AS name", [sourceSchema])).rows[0]!.name, sourceSchema));
  } finally { hook.mock.restore(); await none.close(); await m1DropSchema(sourceSchema); await m1DropSchema(targetSchema); }
});

test("M1 PG reader namespace/前后nonce/重复nonce/断连均在target初始化前拒绝；own连接全部关闭", pg, async () => {
  const source = await seededPg();
  await withM1Cleanup(async () => {
    const before = await m1Capture(source.db);
    for (const fault of ["namespace", "nonce", "post_nonce", "duplicate_nonce", "connection"] as const) {
      const missing = m1Schema(), target = m1Schema();
      const originalSnapshot = PostgresDriver.prototype.readSnapshot, originalConnect = PostgresDriver.prototype.connect,
        originalClose = PostgresDriver.prototype.close;
      const connected = new Set<PostgresDriver>(), closed = new Set<PostgresDriver>();
      const calls = new WeakMap<PostgresDriver, number>();
      let injected = false, witnesses = 0, businessReads = 0;
      let duplicate: Client | undefined;
      const businessSql = new Set(BUSINESS_TABLES.map(table => table.readSql ?? `SELECT * FROM ${table.name}`));
      const connectHook = mock.method(PostgresDriver.prototype, "connect", async function (this: PostgresDriver) {
        if (this.initializationOnConnect === "none") connected.add(this);
        assert.notEqual(this.m1ExistingSourceOptions().pgSchema, target, "target must not even connect");
        return originalConnect.call(this);
      });
      const closeHook = mock.method(PostgresDriver.prototype, "close", async function (this: PostgresDriver) {
        await originalClose.call(this); closed.add(this);
      });
      const snapshotHook = mock.method(PostgresDriver.prototype, "readSnapshot", function <T>(this: PostgresDriver, use: Reader<T>): Promise<T> {
        const n = (calls.get(this) ?? 0) + 1; calls.set(this, n);
        return originalSnapshot.call(this, async read => {
          if (n === 2 && fault === "namespace") {
            injected = true;
            await read.query("SELECT set_config('search_path', ?, true)", [missing]);
          }
          if (n === 2 && fault === "connection") {
            const [own] = await read.query("SELECT pg_backend_pid() AS pid");
            await m1PgControl(async client => assert.equal((await client.query("SELECT pg_terminate_backend($1) AS terminated", [own!.pid])).rows[0]!.terminated, true));
            injected = true;
          }
          if (n === 2 && fault === "duplicate_nonce") {
            const owner = await ownerFor(source.options.pgSchema!);
            duplicate = new Client({ connectionString: m1PgUrl! });
            await duplicate.connect();
            await duplicate.query("SELECT set_config('application_name',$1,false)", [owner.application_name]);
            injected = true;
          }
          const wrapped: DbReadSnapshot = { query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) => {
            if (n === 2 && businessSql.has(sql)) businessReads++;
            if (n === 2 && sql.includes("FROM pg_stat_activity a")) witnesses++;
            if (n === 2 && (fault === "nonce" || fault === "post_nonce" && witnesses === 2) && sql.includes("FROM pg_stat_activity a")) {
              injected = true;
              const altered = [...params]; altered[5] = "boardroom-m1:wrong-nonce";
              const rows = await read.query<R>(sql, altered);
              assert.deepEqual(rows, [], "real PG witness query must reject the wrong nonce");
              return rows;
            }
            return read.query<R>(sql, params);
          } };
          return use(wrapped);
        }) as Promise<T>;
      });
      try {
        await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: target }),
          fault === "namespace" ? /m1_postgres_namespace_mismatch/ : fault === "connection" ? /terminat|closed|Connection|Client|connection/i : /m1_owner_witness_mismatch/);
        assert.equal(injected, true);
        if (fault === "post_nonce") {
          assert.ok(BUSINESS_TABLES.some(table => table.name === "work_event_delivery_invalidations"));
          assert.equal(businessReads, BUSINESS_TABLES.length);
        }
        assert.ok(connected.size >= 2);
        assert.ok([...connected].every(driver => closed.has(driver)));
        await assertNamespaceMissing(missing); await assertNamespaceMissing(target);
        assert.deepEqual(await m1Capture(source.db), before);
      } finally {
        snapshotHook.mock.restore(); connectHook.mock.restore(); closeHook.mock.restore();
        await duplicate?.end();
        await m1DropSchema(missing); await m1DropSchema(target);
      }
    }
  }, [source.close]);
});

test("M1 PG独立RR只读reader、128位nonce/完整时间活owner、准入锁及原批次不重读", pg, async () => {
  const source = await seededPg(), target = await m1Sqlite();
  const original = PostgresDriver.prototype.readSnapshot;
  const readCounts = new Map<string, number>();
  const tableBySql = new Map(BUSINESS_TABLES.map(table => [table.readSql ?? `SELECT * FROM ${table.name}`, table.name]));
  let changed = false;
  const hook = mock.method(PostgresDriver.prototype, "readSnapshot", function <T>(this: PostgresDriver, use: Reader<T>): Promise<T> {
    return original.call(this, read => use({ query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) => {
      const rows = await read.query<R>(sql, params), table = tableBySql.get(sql);
      if (table) {
        readCounts.set(table, (readCounts.get(table) ?? 0) + 1);
        if (!changed) {
          changed = true;
          const [state] = await read.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, pg_backend_pid() AS pid");
          assert.equal(state!.isolation, "repeatable read"); assert.equal(state!.read_only, "on");
          const owner = await ownerFor(source.options.pgSchema!);
          assert.notEqual(owner.pid, state!.pid);
          assert.match(owner.application_name, /^boardroom-m1:[0-9a-f]{32}$/);
          assert.ok(Buffer.byteLength(owner.application_name) <= 63);
          assert.equal(typeof owner.backend_start, "string"); assert.equal(typeof owner.xact_start, "string");
          await m1PgControl(async control => {
            await control.query("BEGIN"); await control.query("SET LOCAL lock_timeout='100ms'");
            await assert.rejects(control.query(`SELECT * FROM "${source.options.pgSchema}".storage_maintenance FOR UPDATE`), { code: "55P03" });
            await control.query("ROLLBACK");
          });
          // An ordinary writer shares the admission lock. RR still fixes the captured batch;
          // this is a fault control, not an online-migration guarantee.
          await source.db.exec("UPDATE tasks SET acceptance_text='concurrent-after-snapshot' WHERE id='task-copy'");
          console.log(JSON.stringify({ m1OwnerWitness: owner, reader: state, lockConflict: "55P03" }));
        }
      }
      return rows;
    } })) as Promise<T>;
  });
  try {
    const old = (await source.db.query("SELECT acceptance_text FROM tasks WHERE id='task-copy'"))[0]!.acceptance_text;
    assert.equal((await migrateData(source.options, target.options)).validation.ok, true);
    assert.equal(changed, true);
    assert.deepEqual([...readCounts.entries()].sort(), BUSINESS_TABLES.map(t => [t.name, 1]).sort());
    assert.equal((await target.db.query("SELECT acceptance_text FROM tasks WHERE id='task-copy'"))[0]!.acceptance_text, old);
    assert.equal((await source.db.query("SELECT acceptance_text FROM tasks WHERE id='task-copy'"))[0]!.acceptance_text, "concurrent-after-snapshot");
  } finally { hook.mock.restore(); }
  await withM1Cleanup(async () => {
    assert.equal((await validateData(source.options, target.options)).ok, false, "independent live validate is not the migration batch proof");
  }, [source.close, target.close]);
});

test("M1 PG owner与reader时区文本不同仍按PG时间值见证，不丢微秒或裸文本比较", pg, async () => {
  const source = await m1Postgres(), target = await m1Sqlite();
  const original = PostgresDriver.prototype.readSnapshot, calls = new WeakMap<PostgresDriver, number>();
  let changed = false;
  const hook = mock.method(PostgresDriver.prototype, "readSnapshot", function <T>(this: PostgresDriver, use: Reader<T>): Promise<T> {
    const n = (calls.get(this) ?? 0) + 1; calls.set(this, n);
    return original.call(this, async read => {
      if (n === 2) { await read.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'"); changed = true; }
      return use(read);
    }) as Promise<T>;
  });
  try { assert.equal((await migrateData(source.options, target.options)).validation.ok, true); assert.equal(changed, true); }
  finally { hook.mock.restore(); await source.close(); await target.close(); }
});

test("M1 PG target inspect→CREATE→21迁移→clear→copy→真实COMMIT均固定同一physical client", pg, async () => {
  const source = await m1Sqlite(true), schema = m1Schema();
  const original = Client.prototype.query as (...args: unknown[]) => unknown;
  const ids = new Set<number>(), committed: string[] = [], applied: number[] = [];
  let inspections = 0;
  const hook = mock.method(Client.prototype, "query", function (this: Client, ...args: unknown[]): unknown {
    const result = original.apply(this, args);
    if (!result || typeof (result as { then?: unknown }).then !== "function") return result;
    return (result as Promise<unknown>).then(async value => {
      const observed = await original.call(this, "SELECT pg_backend_pid() AS pid, current_schema() AS schema") as QueryResult;
      const state = observed.rows[0]!;
      const sql = typeof args[0] === "string" ? args[0] : "";
      const inspecting = sql.includes("AS database_name") && (args[1] as unknown[] | undefined)?.[0] === schema;
      if (state.schema === schema || inspecting) {
        ids.add(state.pid);
        if (inspecting) inspections++;
        if (sql === "COMMIT") committed.push((value as QueryResult).command);
        if (sql.startsWith("INSERT INTO schema_migrations")) applied.push(Number((args[1] as unknown[])[0]));
      }
      return value;
    });
  } as typeof Client.prototype.query);
  try {
    assert.equal((await migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: schema })).validation.ok, true);
    assert.equal(ids.size, 1);
    assert.ok(inspections > 20);
    assert.deepEqual(applied, migrations.map(m => m.version));
    assert.ok(committed.length >= 23); assert.ok(committed.every(command => command === "COMMIT"));
    console.log(JSON.stringify({ m1PinnedTarget: { pids: [...ids], inspections, migrationVersions: applied, commitCommands: committed } }));
  } finally { hook.mock.restore(); await source.close(); await m1DropSchema(schema); }
});

test("M1 PG target inspect后别人创建schema：精确CREATE冲突，保留竞争者对象不接管", pg, async () => {
  const source = await m1Sqlite(), schema = m1Schema();
  const original = PostgresDriver.prototype.transaction;
  let reads = 0, competed = false;
  const hook = mock.method(PostgresDriver.prototype, "transaction", function <T>(this: PostgresDriver, use: Transaction<T>): Promise<T> {
    if (this.m1ExistingSourceOptions().pgSchema !== schema) return original.call(this, use) as Promise<T>;
    return original.call(this, tx => use({ exec: tx.exec, query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) => {
      const rows = await tx.query<R>(sql, params);
      if (sql.includes("AS database_name") && ++reads === 2) {
        await m1PgControl(async client => { await client.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".competitor(value TEXT); INSERT INTO "${schema}".competitor VALUES('owned')`); });
        competed = true;
      }
      return rows;
    } })) as Promise<T>;
  });
  try {
    await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: schema }), { code: "42P06" });
    assert.equal(competed, true);
    await m1PgControl(async client => {
      assert.deepEqual((await client.query(`SELECT * FROM "${schema}".competitor`)).rows, [{ value: "owned" }]);
      assert.equal((await client.query("SELECT to_regclass($1)::text AS table_name", [`${schema}.schema_migrations`])).rows[0]!.table_name, null);
    });
  } finally { hook.mock.restore(); await source.close(); await m1DropSchema(schema); }
});

test("M1 PG外部已有source事务不能转独立不可见快照；target外层保存点仍可回滚", pg, async () => {
  const source = await seededPg(), target = await m1Postgres(), sqlite = await m1Sqlite(true);
  await withM1Cleanup(async () => {
    await assert.rejects(source.db.transaction(() => copyAllTables(source.db, target.db)), /m1_postgres_source_requires_own_transaction/);
    await assert.rejects(target.db.transaction(async () => { await copyAllTables(sqlite.db, target.db); throw new Error("outer-target-rollback"); }), /outer-target-rollback/);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0);
    await assert.rejects(target.db.transaction(async tx => { try { await tx.query("SELECT 1/0"); } catch { /* intentional aborted COMMIT control */ } }), /COMMIT 返回 ROLLBACK/);
  }, [source.close, target.close, sqlite.close]);
});

test("M1 PG生产/mirror逐版本混拼checksum拒绝；缺版本表读取不会DDL补表", pg, async () => {
  const source = await m1Postgres(), target = await m1Sqlite();
  await withM1Cleanup(async () => {
    const different = migrations.filter((migration, i) => checksumOf(migrationSql(migration, "postgres"))
      !== checksumOf(migrationSql(PG_BUSINESS_SCHEMA_MIGRATIONS[i]!, "postgres")));
    assert.ok(different.length > 1);
    const first = different[0]!;
    await source.db.exec("UPDATE schema_migrations SET checksum=? WHERE version=?", [
      checksumOf(migrationSql(PG_BUSINESS_SCHEMA_MIGRATIONS.find(m => m.version === first.version)!, "postgres")), first.version]);
    const before = await source.db.query("SELECT * FROM schema_migrations ORDER BY version");
    await assert.rejects(migrateData(source.options, target.options), /m1_source_version_or_checksum_mismatch/);
    assert.deepEqual(await source.db.query("SELECT * FROM schema_migrations ORDER BY version"), before);
    await source.db.exec("DROP TABLE schema_migrations");
    await assert.rejects(migrateData(source.options, target.options), /m1_source_relation_mismatch:schema_migrations/);
    await m1PgControl(async client => {
      assert.equal((await client.query("SELECT to_regclass($1)::text AS name", [`${source.options.pgSchema}.schema_migrations`])).rows[0]!.name, null);
    });
  }, [source.close, target.close]);
});

test("M1 PG真实deferred COMMIT失败回滚全部复制，独立clear仍已提交且source不变", pg, async () => {
  const source = await m1Sqlite(true), target = await m1Postgres();
  await withM1Cleanup(async () => {
    await target.db.exec(`CREATE FUNCTION m1_deferred_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'm1-deferred-commit-failure'; END $$`);
    await target.db.exec(`CREATE CONSTRAINT TRIGGER m1_deferred_failure AFTER INSERT ON decision_changes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION m1_deferred_failure()`);
    const before = await m1Capture(source.db);
    await assert.rejects(migrateData(source.options, target.options), /m1-deferred-commit-failure/);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0);
    assert.deepEqual(await m1Capture(source.db), before);
  }, [source.close, target.close]);
});

test("M1 PG target既有namespace被替换或pinned连接丢失，写前拒绝且不换client重连", pg, async () => {
  const source = await m1Sqlite();
  await withM1Cleanup(async () => {
    for (const fault of ["namespace", "connection"] as const) {
      const existing = fault === "namespace" ? await m1Postgres() : undefined;
      const schema = existing?.options.pgSchema ?? m1Schema(), renamed = m1Schema();
      const original = PostgresDriver.prototype.transaction, originalConnect = PostgresDriver.prototype.connect;
      let injected = false, connections = 0;
      const connectHook = mock.method(PostgresDriver.prototype, "connect", async function (this: PostgresDriver) {
        if (this.m1ExistingSourceOptions().pgSchema === schema) connections++;
        return originalConnect.call(this);
      });
      const transactionHook = mock.method(PostgresDriver.prototype, "transaction", function <T>(this: PostgresDriver, use: Transaction<T>): Promise<T> {
        if (this.m1ExistingSourceOptions().pgSchema !== schema) return original.call(this, use) as Promise<T>;
        return original.call(this, tx => use({ exec: tx.exec, query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) => {
          const rows = await tx.query<R>(sql, params);
          if (!injected && sql.includes("AS database_name")) {
            injected = true;
            if (fault === "namespace") {
              await m1PgControl(async client => { await client.query(`ALTER SCHEMA "${schema}" RENAME TO "${renamed}"; CREATE SCHEMA "${schema}"`); });
            } else {
              const [own] = await tx.query("SELECT pg_backend_pid() AS pid");
              await m1PgControl(async client => assert.equal((await client.query("SELECT pg_terminate_backend($1) AS terminated", [own!.pid])).rows[0]!.terminated, true));
            }
          }
          return rows;
        } })) as Promise<T>;
      });
      try {
        await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: schema }),
          fault === "namespace" ? /m1_target_namespace_changed/ : /terminat|closed|Connection|Client|connection/i);
        assert.equal(injected, true); assert.equal(connections, 1);
        if (fault === "connection") await assertNamespaceMissing(schema);
        else await m1PgControl(async client => {
          assert.equal((await client.query("SELECT to_regclass($1)::text AS name", [`${schema}.schema_migrations`])).rows[0]!.name, null);
          assert.deepEqual((await client.query(`SELECT version FROM "${renamed}".schema_migrations ORDER BY version`)).rows.map(row => row.version), migrations.map(migration => migration.version));
        });
      } finally {
        transactionHook.mock.restore(); connectHook.mock.restore();
        await existing?.close(); await m1DropSchema(schema); await m1DropSchema(renamed);
      }
    }
  }, [source.close]);
});

test("M1 PG显式初始化v20故障保留已提交1–19，当前迁移回滚且不虚称目标无痕", pg, async () => {
  const source = await m1Sqlite(true), schema = m1Schema();
  const original = PostgresDriver.prototype.migrate;
  const hook = mock.method(PostgresDriver.prototype, "migrate", function (this: PostgresDriver, catalog: Parameters<PostgresDriver["migrate"]>[0]) {
    return original.call(this, this.m1ExistingSourceOptions().pgSchema === schema
      ? catalog.map(migration => migration.version === 20 ? { ...migration, upPostgres: "SELECT 1/0" } : migration) : catalog);
  });
  try {
    const before = await m1Capture(source.db);
    await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: schema }), /迁移 20.*division by zero/);
    assert.deepEqual(await m1Capture(source.db), before);
    await m1PgControl(async client => {
      const rows = (await client.query(`SELECT version,checksum FROM "${schema}".schema_migrations ORDER BY version`)).rows;
      assert.deepEqual(rows, PG_BUSINESS_SCHEMA_MIGRATIONS.filter(m => m.version <= 19).map(m => ({ version: m.version, checksum: checksumOf(migrationSql(m, "postgres")) })));
      assert.equal((await client.query("SELECT to_regclass($1)::text AS name", [`${schema}.decision_records`])).rows[0]!.name, null);
      assert.equal(Number((await client.query(`SELECT COUNT(*) AS n FROM "${schema}".agents`)).rows[0]!.n), 0);
    });
  } finally { hook.mock.restore(); await source.close(); await m1DropSchema(schema); }
});

test("M1 PG owner在target copy中真实断开：copy回滚，source不变，target不被报告成功", pg, async () => {
  const source = await seededPg(), target = await m1Sqlite();
  const original = SqliteDriver.prototype.transaction;
  let terminated = false;
  const hook = mock.method(SqliteDriver.prototype, "transaction", function <T>(this: SqliteDriver, use: Transaction<T>): Promise<T> {
    return original.call(this, tx => use({ query: tx.query, exec: async (sql, params) => {
      const count = await tx.exec(sql, params);
      if (!terminated && this.initializationOnConnect === "none" && sql.startsWith("INSERT INTO mcp_connections")) {
        const owner = await ownerFor(source.options.pgSchema!);
        await m1PgControl(async client => assert.equal((await client.query("SELECT pg_terminate_backend($1) AS terminated", [owner.pid])).rows[0]!.terminated, true));
        terminated = true;
      }
      return count;
    } })) as Promise<T>;
  });
  try {
    const before = await m1Capture(source.db);
    await assert.rejects(migrateData(source.options, target.options), /terminat|closed|Connection|Client|connection/i);
    assert.equal(terminated, true);
    for (const rows of Object.values(await m1Capture(target.db))) assert.equal(rows.length, 0);
    assert.deepEqual(await m1Capture(source.db), before);
  } finally { hook.mock.restore(); await source.close(); await target.close(); }
});

test("M1 PG source预检后epoch变化在owner准入拒绝，目标namespace仍不存在", pg, async () => {
  const source = await m1Postgres(), targetSchema = m1Schema();
  const original = PostgresDriver.prototype.readSnapshot;
  let changed = false;
  const hook = mock.method(PostgresDriver.prototype, "readSnapshot", async function <T>(this: PostgresDriver, use: Reader<T>): Promise<T> {
    const result = await original.call(this, use) as T;
    if (!changed && this.m1ExistingSourceOptions().pgSchema === source.options.pgSchema) {
      await m1PgControl(async client => { await client.query(`UPDATE "${source.options.pgSchema}".storage_maintenance SET fence_epoch=fence_epoch+1`); });
      changed = true;
    }
    return result;
  });
  try {
    await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: targetSchema }), /epoch_changed/);
    assert.equal(changed, true); await assertNamespaceMissing(targetSchema);
    await m1PgControl(async client => assert.equal(Number((await client.query(`SELECT fence_epoch FROM "${source.options.pgSchema}".storage_maintenance`)).rows[0]!.fence_epoch), 1));
  } finally { hook.mock.restore(); await source.close(); await m1DropSchema(targetSchema); }
});

test("M1 PG实际同源别名配置不同仍拒绝，不清空自己的源", pg, async () => {
  const source = await seededPg();
  await withM1Cleanup(async () => {
    const before = await m1Capture(source.db), alias = new URL(m1PgUrl!);
    alias.searchParams.set("application_name", "m1-target-alias");
    await assert.rejects(migrateData(source.options, { ...source.options, pgConnectionString: alias.toString() }), /m1_source_target_same_database/);
    assert.deepEqual(await m1Capture(source.db), before);
  }, [source.close]);
});

test("M1 PG reader完成后close失败不形成permit，owner仍清理且target未连接", pg, async () => {
  const source = await m1Postgres(), targetSchema = m1Schema();
  const originalSnapshot = PostgresDriver.prototype.readSnapshot, originalClose = PostgresDriver.prototype.close,
    originalConnect = PostgresDriver.prototype.connect;
  const reads = new WeakMap<PostgresDriver, number>(), connected = new Set<PostgresDriver>(), closed = new Set<PostgresDriver>();
  const cleanupFailure = new Error("reader-close-failure");
  const snapshotHook = mock.method(PostgresDriver.prototype, "readSnapshot", function <T>(this: PostgresDriver, use: Reader<T>): Promise<T> {
    reads.set(this, (reads.get(this) ?? 0) + 1);
    return originalSnapshot.call(this, use) as Promise<T>;
  });
  const connectHook = mock.method(PostgresDriver.prototype, "connect", async function (this: PostgresDriver) {
    assert.notEqual(this.m1ExistingSourceOptions().pgSchema, targetSchema);
    connected.add(this); return originalConnect.call(this);
  });
  const closeHook = mock.method(PostgresDriver.prototype, "close", async function (this: PostgresDriver) {
    await originalClose.call(this); closed.add(this);
    if ((reads.get(this) ?? 0) >= 2) throw cleanupFailure;
  });
  try {
    await assert.rejects(migrateData(source.options, { dbDriver: "postgres", pgConnectionString: m1PgUrl!, pgSchema: targetSchema }), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [cleanupFailure]); return true;
    });
    assert.ok(connected.size >= 2); assert.ok([...connected].every(driver => closed.has(driver)));
    await assertNamespaceMissing(targetSchema);
  } finally { snapshotHook.mock.restore(); connectHook.mock.restore(); closeHook.mock.restore(); await source.close(); await m1DropSchema(targetSchema); }
});

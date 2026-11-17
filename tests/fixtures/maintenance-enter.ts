import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { PostgresDriver } from "../../src/server/db/drivers/postgres.ts";
import { SqliteDriver } from "../../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../../src/server/environment.ts";
import { createSqliteMaintenanceAdapter } from "../../src/server/storage/maintenance/sqlite.ts";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { planMigration, persistMigrationPlan } from "../../src/server/storage/maintenance/plan.ts";
import { registerStorageSourceClient } from "../../src/server/storage/source-client.ts";
import type { ContinueRequest, MaintenanceServiceOptions } from "../../src/server/storage/maintenance/types.ts";

/** Only bootstraps a private source and persists P; never seeds a journal, phase, or DB anchor. */
export async function enterFixture(kind: "sqlite" | "postgres" = "sqlite",
  fixtureOptions: { sqliteEncoding?: "UTF-8" | "UTF-16le" | "UTF-16be" } = {}) {
  // Use the checkout filesystem for durable positive fixtures. Some Linux runners mount /tmp
  // as tmpfs, which is intentionally outside the production filesystem support policy.
  const directory = await realpath(await mkdtemp(path.join(path.dirname(process.cwd()), "br-enter-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(directory, "config.json");
  let admin: Client | undefined, database: string | undefined, sourceUrl: string | undefined;
  const clients = new Set<Client>();
  const connect = async () => {
    assert(sourceUrl); const client = new Client({ connectionString: sourceUrl });
    client.on("error", () => {}); clients.add(client); await client.connect(); return client;
  };
  const closeClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (kind === "sqlite") {
      const db = new Database(file, { fileMustExist: true });
      try { return db.prepare(sql).all() as Record<string, unknown>[]; } finally { db.close(); }
    }
    const client = await connect(); try { return (await client.query(sql)).rows; } finally { await closeClient(client); }
  };
  const exec = async (sql: string): Promise<void> => {
    if (kind === "sqlite") {
      const db = new Database(file, { fileMustExist: true }); try { db.exec(sql); } finally { db.close(); } return;
    }
    const client = await connect(); try { await client.query(sql); } finally { await closeClient(client); }
  };
  const close = async () => {
    try {
      for (const client of clients) await client.end(); clients.clear();
      if (admin && database) {
        assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [database])).rows[0].count, "0");
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally { await admin?.end(); await rm(directory, { recursive: true, force: true }); }
  };
  try {
    if (kind === "sqlite") {
      const db = new Database(file);
      try {
        // SQLite fixes its database encoding at the first table. A fixed test
        // profile exercises real raw bytes without changing existing fixtures.
        const encoding = fixtureOptions.sqliteEncoding ?? "UTF-8";
        assert(["UTF-8", "UTF-16le", "UTF-16be"].includes(encoding));
        db.pragma(`encoding='${encoding}'`);
        db.exec("CREATE TABLE enter_observation(value TEXT); INSERT INTO enter_observation VALUES('original business bytes')");
        runMigrations(db, migrations); db.pragma("journal_mode=WAL");
      }
      finally { db.close(); }
    } else {
      assert(process.env.AGENT_STUDIO_PG_TEST_URL, "explicit private PostgreSQL test URL required");
      admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
      const name = `br_enter_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`); database = name;
      const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = `/${database}`; sourceUrl = url.toString();
      const driver = new PostgresDriver({ connectionString: sourceUrl });
      try { await driver.connect(); await driver.exec("CREATE TABLE enter_observation(value TEXT)"); await driver.exec("INSERT INTO enter_observation VALUES('original business bytes')"); await driver.migrate(migrations); }
      finally { await driver.close(); }
    }
    await writeFile(configFile, JSON.stringify({ dataDir, ...(kind === "postgres" ? { dbDriver: "postgres", pgConnectionString: sourceUrl } : {}) }), { mode: 0o600 });
    const environment = await resolveBoardroomEnvironment({ cwd: directory, homeDir: directory,
      env: { AGENT_STUDIO_CONFIG: configFile, BOARDROOM_HOME: path.join(directory, "home") } });
    const descriptor = environment.databaseDescriptor;
    // Real persisted user intent, without starting any runner. Enter may gate work but cannot
    // rewrite desired state, reset requests, or interpret this row as an owned-exit fact.
    await exec(`INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES('enter-agent','Agent','codex','2026-11-15','2026-11-15');
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('enter-project','Project','2026-11-15','2026-11-15');
      INSERT INTO members(id,project_id,agent_id,kind,display_name,created_at,updated_at) VALUES('enter-member','enter-project','enter-agent','agent','Member','2026-11-15','2026-11-15');
      INSERT INTO groups(id,project_id,name,created_at,updated_at) VALUES('enter-group','enter-project','Group','2026-11-15','2026-11-15');
      INSERT INTO agent_runtimes(id,agent_id,defaults_json,created_at,updated_at) VALUES('enter-runtime','enter-agent','{}','2026-11-15','2026-11-15');
      INSERT INTO agent_runtime_bindings(id,runtime_id,project_id,group_id,member_id,desired_state,intent_revision,reset_session_requested,created_at,updated_at)
        VALUES('enter-binding','enter-runtime','enter-project','enter-group','enter-member','running',7,1,'2026-11-15','2026-11-15');`);
    const clientId = randomUUID();
    const driver = descriptor.kind === "sqlite" ? new SqliteDriver({ dataDir, sqlitePath: file, sqliteSource: descriptor })
      : new PostgresDriver({ connectionString: (() => { const url = new URL(descriptor.connectionString); url.searchParams.set("application_name", `boardroom-source:${clientId}`); return url.toString(); })() });
    try {
      await driver.connect();
      const registered = await registerStorageSourceClient({ db: driver, database: descriptor, entrypoint: "owned-background", clientId });
      await registered.close(); // A real historical registration; never a claim of source quiescence.
    } finally { await driver.close(); }
    const createAdapter = () => descriptor.kind === "sqlite" ? createSqliteMaintenanceAdapter(descriptor) : createPostgresMaintenanceAdapter(descriptor, undefined);
    const options: MaintenanceServiceOptions = { environment, originalCwd: directory, expectedSourceId: environment.inventory.selectedSourceId!,
      controlRoot: path.join(dataDir, "control"), targetRoot: path.join(directory, "target") };
    const adapter = await createAdapter();
    try {
      const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
      const initial = await adapter.observe();
      assert.equal(initial.state.admission, "open"); assert.equal(initial.state.journalRecordRef, null);
      const request: ContinueRequest = { plan: reference, expectedSource: plan.source, expectedPhase: null, expectedJournalDigest: null, requestId: "first-enter" };
      const observe = async () => { const a = await createAdapter(); try { return await a.observe(); } finally { await a.close(); } };
      return { kind, directory, dataDir, file, configFile, database, descriptor, options, plan, reference, request, initial,
        createAdapter, observe, query, exec, connect, closeClient, close };
    } finally { await adapter.close(); }
  } catch (error) { await close(); throw error; }
}

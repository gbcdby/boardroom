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
import { createPreviewGraph, planMigration, persistMigrationPlan } from "./maintenance-preview-graph.ts";
import { registerStorageSourceClient } from "../../src/server/storage/source-client.ts";
import type { ContinueRequest, MaintenanceServiceOptions } from "../../src/server/storage/maintenance/types.ts";

/** Only bootstraps a private source and persists P; never seeds a journal, phase, or DB anchor. */
export async function enterFixture(kind: "sqlite" | "postgres" = "sqlite",
  fixtureOptions: { sqliteEncoding?: "UTF-8" | "UTF-16le" | "UTF-16be"; directory?: string; sessions?: boolean; drainClient?: boolean;
    configSource?: "file" | "none" } = {}) {
  // Use the checkout filesystem for durable positive fixtures. Some Linux runners mount /tmp
  // as tmpfs, which is intentionally outside the production filesystem support policy.
  const directory = await realpath(fixtureOptions.directory ?? await mkdtemp(path.join(path.dirname(process.cwd()), "br-enter-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const file = path.join(dataDir, "agent-studio.db"), configFile = path.join(directory, "config.json");
  let admin: Client | undefined, database: string | undefined, sourceUrl: string | undefined;
  const clients = new Set<Client>();
  let sourceClient: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  let sourceDriver: SqliteDriver | PostgresDriver | undefined;
  let preview: Awaited<ReturnType<typeof createPreviewGraph>> | undefined;
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
      await sourceClient?.close(); await sourceDriver?.close();
      for (const client of clients) await client.end(); clients.clear();
      if (admin && database) {
        // pg-pool removes an idle client before its real end callback completes;
        // pool.end() alone is not proof that the server backend has exited.
        // Observe this private database becoming empty; never force a DROP or
        // interpret expiry as closure. This also lets the original end fire.
        let remaining: string | undefined;
        for (let attempt = 0; attempt < 200; attempt++) {
          remaining = (await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [database])).rows[0].count;
          if (remaining === "0") break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(remaining, "0", "every owned backend must actually exit before DROP");
        await admin.query(`DROP DATABASE "${database}"`);
      }
    } finally { await admin?.end(); await preview?.close(); await rm(directory, { recursive: true, force: true }); }
  };
  try {
    preview = await createPreviewGraph(directory, fixtureOptions.configSource === "none" ? "production" : "qualified-linux");
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
    if (fixtureOptions.configSource !== "none")
      await writeFile(configFile, JSON.stringify({ dataDir, ...(kind === "postgres" ? { dbDriver: "postgres", pgConnectionString: sourceUrl } : {}) }), { mode: 0o600 });
    const environment = await resolveBoardroomEnvironment({ cwd: directory, homeDir: directory,
      env: { ...(fixtureOptions.configSource === "none"
        ? { AGENT_STUDIO_DATA_DIR: dataDir, ...(kind === "postgres" ? { AGENT_STUDIO_DB_DRIVER: "postgres", AGENT_STUDIO_PG_CONNECTION_STRING: sourceUrl } : {}) }
        : { AGENT_STUDIO_CONFIG: configFile }), BOARDROOM_HOME: path.join(directory, "home") } });
    const descriptor = environment.databaseDescriptor;
    if (fixtureOptions.sessions) {
      const sessions = path.join(environment.runtimeRoot, "sessions");
      await mkdir(path.join(sessions, "nested"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(sessions, "nested", "capture-binary"), Buffer.from([0, 0xff, 0x80, 1, 10]), { mode: 0o600 });
    }
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
    if (fixtureOptions.drainClient) {
      // The production binding creator inserts these default generation-zero
      // rows together. No process has ever been launched or owned by this fixture.
      await exec("INSERT INTO agent_runner_states(binding_id,updated_at) VALUES('enter-binding','2026-11-15'); "
        + "INSERT INTO agent_runtime_members(member_id,runtime_id,project_id,updated_at) VALUES('enter-member','enter-runtime','enter-project','2026-11-15')");
    }
    const driver = descriptor.kind === "sqlite" ? new SqliteDriver({ dataDir, sqlitePath: file, sqliteSource: descriptor })
      : new PostgresDriver({ connectionString: (() => { const url = new URL(descriptor.connectionString); url.searchParams.set("application_name", `boardroom-source:${clientId}`); return url.toString(); })() });
    try {
      await driver.connect();
      const registered = await registerStorageSourceClient({ db: driver, database: descriptor, entrypoint: "owned-background", clientId });
      if (fixtureOptions.drainClient) {
        sourceClient = registered; sourceDriver = driver;
        await registered.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
          async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; },
          async observeOwnedExit() { throw new Error("fixture owns no child"); } });
      } else await registered.close(); // A real historical registration; never a claim of source quiescence.
    } finally { if (!sourceDriver) await driver.close(); }
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
      return { kind, directory, dataDir, file, configFile, database, descriptor, options, plan, reference, request, initial, preview,
        createAdapter, observe, query, exec, connect, closeClient, sourceClient, close };
    } finally { await adapter.close(); }
  } catch (error) { await close(); throw error; }
}

/** Generic entry/phase tests explicitly retain null-config protocol coverage on
 * Darwin. Non-null Linux preview and production capability refusals are separate
 * exercised branches; this does not give Darwin the Linux CFP2 qualification. */
export function protocolEnterFixture(kind: Parameters<typeof enterFixture>[0] = "sqlite",
  options: Parameters<typeof enterFixture>[1] = {}) {
  return enterFixture(kind, { configSource: process.platform === "darwin" ? "none" : "file", ...options });
}

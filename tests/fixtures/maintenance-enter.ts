import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { PostgresDriver } from "../../src/server/db/drivers/postgres.ts";
import { runMigrations } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../../src/server/environment.ts";
import { createSqliteMaintenanceAdapter } from "../../src/server/storage/maintenance/sqlite.ts";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { planMigration, persistMigrationPlan } from "../../src/server/storage/maintenance/plan.ts";
import type { ContinueRequest, MaintenanceServiceOptions } from "../../src/server/storage/maintenance/types.ts";

/** Only bootstraps a private source and persists P; never seeds a journal, phase, or DB anchor. */
export async function enterFixture(kind: "sqlite" | "postgres" = "sqlite") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-enter-")));
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
      try { db.exec("CREATE TABLE enter_observation(value TEXT); INSERT INTO enter_observation VALUES('original business bytes')"); runMigrations(db, migrations); db.pragma("journal_mode=WAL"); }
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

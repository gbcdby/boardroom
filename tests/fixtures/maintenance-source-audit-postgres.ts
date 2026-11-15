import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { PostgresDriver } from "../../src/server/db/drivers/postgres.ts";
import { checksumOf, migrationSql } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../../src/server/environment.ts";
import { createPostgresMaintenanceAdapter } from "../../src/server/storage/maintenance/postgres.ts";
import { readPostgresCatalog } from "../../src/server/storage/maintenance/postgres-manifests.ts";
import { planMigration, persistMigrationPlan } from "../../src/server/storage/maintenance/plan.ts";
import { ArtifactStore } from "../../src/server/storage/maintenance/objects.ts";
import { registerStorageSourceClient } from "../../src/server/storage/source-client.ts";
import type { OperationMutex } from "../../src/server/storage/maintenance/types.ts";
const testUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Real private database and ordinary registration. The fixture alone creates its v2 enter anchor. */
export async function postgresAuditFixture(encoding: "UTF8" | "LATIN1" | "SQL_ASCII" = "UTF8",
  options?: { clientCount?: number; beforeRegister?: (descriptor: { kind: "postgres"; connectionString: string }) => Promise<void> }) {
  if (!testUrl) throw new Error("explicit private PostgreSQL URL required");
  const database = `br_a12b_${randomUUID().replaceAll("-", "")}`;
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-source-audit-pg-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const sourceUrl = new URL(testUrl); sourceUrl.pathname = `/${database}`;
  const descriptor = { kind: "postgres" as const, connectionString: sourceUrl.toString() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const clients = new Set<Client>(); let created = false;
  let adapter: Awaited<ReturnType<typeof createPostgresMaintenanceAdapter>> | undefined;
  let sourceClient: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  const ordinaryClients: Awaited<ReturnType<typeof registerStorageSourceClient>>[] = [];
  let mutex: OperationMutex | undefined;
  const connect = async (applicationName?: string) => {
    const url = new URL(sourceUrl); if (applicationName) url.searchParams.set("application_name", applicationName);
    const client = new Client({ connectionString: url.toString() }); client.on("error", () => {});
    clients.add(client); await client.connect(); return client;
  };
  const closeClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const close = async () => {
    try {
      for (const registered of ordinaryClients) await registered.close();
      await mutex?.release(); await adapter?.close();
      for (const client of clients) await client.end(); clients.clear();
      if (created) {
        const sessions = await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [database]);
        assert.equal(sessions.rows[0].count, "0", "all owned source sessions close before DROP");
        await admin.query(`DROP DATABASE ${quote(database)}`); created = false;
      }
    } finally { await admin.end(); await rm(directory, { recursive: true }); }
  };
  try {
    await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0 ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C'`); created = true;
    const bootstrap = new PostgresDriver({ connectionString: descriptor.connectionString });
    try {
      await bootstrap.connect();
      // Only fixture initialization uses SQL_ASCII to transmit the original UTF8 SQL comments unchanged.
      // Source/client/maintenance sessions below use their normal production UTF8 setting.
      if (encoding === "LATIN1") await bootstrap.query("SET client_encoding='SQL_ASCII'");
      await bootstrap.migrate(migrations);
      const ledger = await bootstrap.query("SELECT version::text AS version,name,checksum FROM schema_migrations ORDER BY schema_migrations.version");
      assert.deepEqual(ledger, migrations.map(m => ({ version: String(m.version), name: m.name, checksum: checksumOf(migrationSql(m, "postgres")) })));
    } finally { await bootstrap.close(); }
    const proof = await connect();
    try {
      assert.equal((await proof.query("SHOW client_encoding")).rows[0].client_encoding, "UTF8");
      assert.equal((await proof.query("SHOW server_encoding")).rows[0].server_encoding, encoding);
      await readPostgresCatalog(proof, "public");
    } finally { await closeClient(proof); }
    const configFile = path.join(directory, "config.json");
    await writeFile(configFile, JSON.stringify({ dataDir, dbDriver: "postgres", pgConnectionString: descriptor.connectionString }), { mode: 0o600 });
    const environment = await resolveBoardroomEnvironment({ cwd: directory, homeDir: directory,
      env: { AGENT_STUDIO_CONFIG: configFile, BOARDROOM_HOME: path.join(directory, "home") } });
    await options?.beforeRegister?.(descriptor);
    let clientId = "";
    for (let index = 0; index < (options?.clientCount ?? 1); index++) {
    clientId = randomUUID(); const businessUrl = new URL(sourceUrl);
    businessUrl.searchParams.set("application_name", `boardroom-source:${clientId}`);
    const driver = new PostgresDriver({ connectionString: businessUrl.toString() }); await driver.connect();
    sourceClient = await registerStorageSourceClient({ db: driver, database: descriptor, entrypoint: "owned-background", clientId });
    ordinaryClients.push(sourceClient);
    await sourceClient.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() { throw new Error("no owned child"); } });
    }
    adapter = await createPostgresMaintenanceAdapter(descriptor, undefined);
    const planOptions = { environment, originalCwd: directory, expectedSourceId: environment.inventory.selectedSourceId!,
      controlRoot: path.join(dataDir, "control"), targetRoot: path.join(directory, "target") };
    const plan = await planMigration(planOptions, adapter), reference = await persistMigrationPlan(plan, planOptions, adapter);
    const store = await ArtifactStore.open(reference.controlRoot, plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const head = await adapter.withSourceLock("control", async lock => {
      const raw = await lock.observeSourceClients();
      const journal = await store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId, sequence: 1,
        previous: null, phase: "planned", event: "enter", requestId: "pg-fixture-enter", requestDigest: "a".repeat(64), source: plan.source,
        plan: reference.immutablePlan, fenceEpoch: raw.state.fenceEpoch + 1, ownerGeneration: 1, evidence: [], snapshot: null, sourceClients: null, frozen: null });
      await lock.anchor({ expected: raw.state, admission: "draining", fenceEpoch: raw.state.fenceEpoch + 1, ownerGeneration: 1,
        activeMigrationId: plan.migrationId, planDigest: reference.planDigest, controlRootIdentity: store.identity as never,
        mutexIdentity: mutex!.identity, journal, journalSequence: 1 });
      return journal;
    });
    for (const registered of ordinaryClients) { await registered.refresh(); await registered.waitForDrain(); }
    const receipt = await sourceClient!.waitForDrain();
    return { directory, dataDir, database, descriptor, admin, adapter, sourceClient, clientId, receipt,
      mutex, store, plan, reference, head, connect, closeClient, close };
  } catch (error) { await close(); throw error; }
}

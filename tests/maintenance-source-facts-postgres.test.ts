import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { checksumOf, migrationSql } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { readPostgresCatalog } from "../src/server/storage/maintenance/postgres-manifests.ts";
import { planMigration, persistMigrationPlan } from "../src/server/storage/maintenance/plan.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { registerStorageSourceClient, storageReceiptDigest } from "../src/server/storage/source-client.ts";
import type { JournalRecordV2, OperationMutex, SourceClientFactsWindow } from "../src/server/storage/maintenance/types.ts";

const testUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
const pgTest = testUrl ? test : test.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function fixture(encoding: "UTF8" | "LATIN1" | "SQL_ASCII" = "UTF8") {
  if (!testUrl) throw new Error("explicit private PostgreSQL URL required");
  const database = `br_sca11_${randomUUID().replaceAll("-", "")}`;
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "br-source-facts-pg-")));
  const dataDir = path.join(directory, "data"); await mkdir(dataDir);
  const sourceUrl = new URL(testUrl); sourceUrl.pathname = `/${database}`;
  const descriptor = { kind: "postgres" as const, connectionString: sourceUrl.toString() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const clients = new Set<Client>(); let created = false;
  let adapter: Awaited<ReturnType<typeof createPostgresMaintenanceAdapter>> | undefined;
  let sourceClient: Awaited<ReturnType<typeof registerStorageSourceClient>> | undefined;
  let mutex: OperationMutex | undefined;
  const connect = async (applicationName?: string) => {
    const url = new URL(sourceUrl); if (applicationName) url.searchParams.set("application_name", applicationName);
    const client = new Client({ connectionString: url.toString() }); client.on("error", () => {});
    clients.add(client); await client.connect(); return client;
  };
  const closeClient = async (client: Client) => { await client.end(); clients.delete(client); };
  const close = async () => {
    try {
      await sourceClient?.close(); await mutex?.release(); await adapter?.close();
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
    const clientId = randomUUID(), businessUrl = new URL(sourceUrl);
    businessUrl.searchParams.set("application_name", `boardroom-source:${clientId}`);
    const driver = new PostgresDriver({ connectionString: businessUrl.toString() }); await driver.connect();
    sourceClient = await registerStorageSourceClient({ db: driver, database: descriptor, entrypoint: "owned-background", clientId });
    await sourceClient.bind({ stopNewWork() {}, async disconnectSessions() {}, async closeMemory() {},
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() { throw new Error("no owned child"); } });
    adapter = await createPostgresMaintenanceAdapter(descriptor, undefined);
    const options = { environment, originalCwd: directory, expectedSourceId: environment.inventory.selectedSourceId!,
      controlRoot: path.join(dataDir, "control"), targetRoot: path.join(directory, "target") };
    const plan = await planMigration(options, adapter), reference = await persistMigrationPlan(plan, options, adapter);
    const store = await ArtifactStore.open(reference.controlRoot, plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const head = await adapter.withSourceLock("control", async lock => {
      const raw = await lock.observeSourceClients();
      const journal = await store.putJson("journal", { formatVersion: 2, kind: "journal", migrationId: plan.migrationId, sequence: 1,
        previous: null, phase: "planned", event: "enter", requestId: "pg-fixture-enter", requestDigest: "a".repeat(64), source: plan.source,
        plan: reference.immutablePlan, fenceEpoch: 1, ownerGeneration: 1, evidence: [], snapshot: null, sourceClients: null, frozen: null });
      await lock.anchor({ expected: raw.state, admission: "draining", fenceEpoch: 1, ownerGeneration: 1,
        activeMigrationId: plan.migrationId, planDigest: reference.planDigest, controlRootIdentity: store.identity as never,
        mutexIdentity: mutex!.identity, journal, journalSequence: 1 });
      return journal;
    });
    await sourceClient.refresh(); const receipt = await sourceClient.waitForDrain();
    return { directory, dataDir, database, descriptor, admin, adapter, sourceClient, clientId, receipt,
      mutex, store, plan, reference, head, connect, closeClient, close };
  } catch (error) { await close(); throw error; }
}

pgTest("A11A PostgreSQL facts verify real closed registration sessions in each actual encoding", { timeout: 60_000 }, async t => {
  for (const encoding of ["UTF8", "LATIN1", "SQL_ASCII"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding); let escaped: SourceClientFactsWindow | undefined;
    try {
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        escaped = window;
        assert.equal(window.observation.textEncoding.name, encoding);
        assert.equal(window.origin.receiptGeneration, 1);
        assert.deepEqual(window.clients[0]!.receipt, f.receipt);
        assert.equal(window.clients[0]!.process.status, "present");
        assert.equal(window.clients[0]!.classification, "current-client");
        await window.assertCurrent();
      }));
      await assert.rejects(escaped!.assertCurrent(), { code: "maintenance_lost" });
      const writer = await f.connect();
      try {
        // Latin1 has a lossless Unicode meaning; SQL_ASCII deliberately does not promise one.
        await writer.query("UPDATE storage_source_clients SET last_observed_at=convert_from(decode($1,'hex'),current_setting('server_encoding'))", [encoding === "UTF8" ? "c3a9" : "e9"]);
      } finally { await f.closeClient(writer); }
      await f.adapter.withSourceLock("control", async lock => {
        const raw = await lock.observeSourceClients();
        assert.deepEqual(raw.rows[0]!.last_observed_at, ["text", encoding === "UTF8" ? "c3a9" : "e9"]);
        const read = () => lock.withSourceClientFacts(f.reference, async window => assert.deepEqual(window.observation.rows, raw.rows));
        if (encoding === "SQL_ASCII") await assert.rejects(read(), { code: "source_writer_unknown" });
        else await read();
        assert.deepEqual((await lock.observeSourceClients()).rows, raw.rows);
      });
    } finally { await f.close(); }
  });
});

pgTest("A11A REQ-002 PostgreSQL rejects foreign session kinds and SQLite native-management provenance", { timeout: 60_000 }, async t => {
  for (const variant of ["local-driver", "client-control", "both", "native-management"]) await t.test(variant, async () => {
    const f = await fixture(); let consumed = false;
    try {
      const writer = await f.connect();
      try {
        const row = (await writer.query("SELECT db_sessions_json,build_id,entrypoint FROM storage_source_clients WHERE client_id=$1", [f.clientId])).rows[0];
        const envelope = JSON.parse(row.db_sessions_json);
        if (variant === "native-management") {
          // Controlled source corruption: this version has no PostgreSQL native-management registration protocol.
          row.build_id = envelope.drainReceipt.buildId = "boardroom-native-management-v1";
          row.entrypoint = envelope.drainReceipt.entrypoint = "local-management";
          const nativeTransactions = { committed: 0, rolledBack: 0, notAdmitted: 0 };
          envelope.drainReceipt.nativeTransactions = nativeTransactions;
          envelope.sessions = [{ kind: "sqlite", owner: "native-management", connectionId: "controlled-foreign-session", state: "closed", nativeTransactions }];
        } else {
          envelope.sessions = envelope.sessions.map((session: { owner: string }) => variant === "both" || session.owner === variant
            ? { kind: "sqlite", owner: session.owner } : session);
        }
        await writer.query("UPDATE storage_source_clients SET db_sessions_json=$1,drain_receipt_digest=$2,build_id=$3,entrypoint=$4 WHERE client_id=$5",
          [JSON.stringify(envelope), storageReceiptDigest(envelope.drainReceipt), row.build_id, row.entrypoint, f.clientId]);
      } finally { await f.closeClient(writer); }
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => {
        consumed = true;
      })), { code: "source_writer_unknown" });
      assert.equal(consumed, false);
    } finally { await f.close(); }
  });
});

pgTest("A11A PostgreSQL observes real second backends, tags, prepared transactions and an empty roster", { timeout: 60_000 }, async t => {
  const f = await fixture();
  const read = () => f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => {}));
  try {
    for (const tag of [`boardroom-source:${f.clientId}`, "boardroom-maintenance:copied-tag"]) await t.test(tag.split(":")[0]!, async () => {
      const writer = await f.connect(tag);
      try {
        assert.equal((await writer.query("SELECT state FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0].state, "active");
        await assert.rejects(read(), { code: "source_writer_unknown" });
      } finally { await f.closeClient(writer); }
      await read();
    });
    await t.test("actual registered backend identity is still active despite a receipt", async () => {
      const writer = await f.connect(`boardroom-source:${f.clientId}`);
      const before = (await writer.query("SELECT db_sessions_json FROM storage_source_clients WHERE client_id=$1", [f.clientId])).rows[0].db_sessions_json;
      const inspections: Record<string, unknown>[] = [], diagnostic = channel("boardroom.maintenance.postgres.writer-observation");
      const listener = (event: unknown) => { if ((event as { kind: string }).kind === "inspection") inspections.push(event as Record<string, unknown>); };
      diagnostic.subscribe(listener);
      try {
        const backend = (await writer.query("SELECT pid,backend_start::text,application_name FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
        const envelope = JSON.parse(before); envelope.sessions.find((s: { owner: string }) => s.owner === "local-driver").observedBackends.push(backend);
        // Controlled lying session envelope, backed by an actual live backend, not a fabricated pid.
        await writer.query("UPDATE storage_source_clients SET db_sessions_json=$1 WHERE client_id=$2", [JSON.stringify(envelope), f.clientId]);
        await assert.rejects(read(), error => {
          assert.equal((error as { code: string }).code, "source_writer_active", JSON.stringify({ actualBackend: backend, inspections })); return true;
        });
      } finally {
        diagnostic.unsubscribe(listener);
        await writer.query("UPDATE storage_source_clients SET db_sessions_json=$1 WHERE client_id=$2", [before, f.clientId]);
        await f.closeClient(writer);
      }
    });
    await t.test("prepared transaction survives its real backend", async () => {
      const gid = `sca11_${randomUUID().replaceAll("-", "")}`;
      const writer = await f.connect(); let prepared = false;
      try {
        assert(Number((await writer.query("SHOW max_prepared_transactions")).rows[0].max_prepared_transactions) > 0,
          "the private PostgreSQL fixture must enable real prepared transactions");
        await writer.query("BEGIN"); await writer.query("SELECT 1");
        await writer.query(`PREPARE TRANSACTION '${gid}'`); prepared = true;
      } finally { await f.closeClient(writer); }
      try { await assert.rejects(read(), { code: "source_writer_unknown" }); }
      finally {
        if (prepared) { const cleanup = await f.connect(); try { await cleanup.query(`ROLLBACK PREPARED '${gid}'`); } finally { await f.closeClient(cleanup); } }
      }
      await read();
    });
    await t.test("empty roster does not suppress actual backend inventory", async () => {
      const writer = await f.connect("boardroom-maintenance:empty-roster");
      try {
        await writer.query("DELETE FROM storage_source_clients");
        assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
        await assert.rejects(read(), { code: "source_writer_unknown" });
      } finally { await f.closeClient(writer); }
      await read();
    });
  } finally { await f.close(); }
});

pgTest("A11A PostgreSQL rechecks fresh sessions inside a window and consumes real lock loss", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    let writer: Client | undefined;
    try {
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
        writer = await f.connect("boardroom-maintenance:late-arrival");
        await assert.rejects(window.assertCurrent(), { code: "source_writer_unknown" });
      })), { code: "source_writer_unknown" });
    } finally { if (writer) await f.closeClient(writer); }
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => {
      const holders = await f.admin.query(`SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
        WHERE a.datname=$1 AND l.granted AND l.locktype='relation' AND l.mode='ShareRowExclusiveLock'`, [f.database]);
      assert.equal(holders.rows.length, 1);
      assert.equal((await f.admin.query("SELECT pg_terminate_backend($1,1000) AS stopped", [holders.rows[0].pid])).rows[0].stopped, true);
      await assert.rejects(window.assertCurrent(), { code: "maintenance_lost" });
    })), { code: "maintenance_lost" });
  } finally { await f.close(); }
});

pgTest("A11A PostgreSQL never reports facts success after a native owned close failure", { timeout: 30_000 }, async t => {
  for (const [target, mode] of [["inventory", "rejected-promise"], ["inventory", "synchronous-throw"],
    ["catalog-pin", "rejected-promise"], ["source-lock", "rejected-promise"]] as const) await t.test(`${target}: ${mode}`, async t => {
    const f = await fixture(); const original = Client.prototype.end, query = Client.prototype.query;
    let attempted = false, consumed = false, selected: Client | undefined;
    try {
      t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        if (target === "source-lock" && sql.startsWith("LOCK TABLE ")
          || target === "catalog-pin" && sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") selected = this;
        return Reflect.apply(query, this, args);
      });
      t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
        if (database !== f.database || attempted || target !== "inventory" && this !== selected) return result;
        attempted = true;
        // Actual close is performed; only its completion boundary is a controlled driver fault.
        if (mode === "synchronous-throw") throw new Error("private-facts-close-canary");
        return Promise.resolve(result).then(() => { throw new Error("private-facts-close-canary"); });
      });
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
        async () => { consumed = true; })), error => /maintenance_lost/.test(String(error)) && !String(error).includes("canary"));
      assert.equal(attempted, true); assert.equal(consumed, target !== "inventory");
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

pgTest("A11A PostgreSQL does not replace a real inventory permission denial with empty facts", async t => {
  const f = await fixture(), role = `sca11_denied_${randomUUID().replaceAll("-", "")}`;
  const original = Client.prototype.query; let created = false, denied = false;
  try {
    await f.admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`); created = true;
    const setup = await f.connect();
    try { await setup.query("REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC"); } finally { await f.closeClient(setup); }
    t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (!sql.startsWith("SELECT pid,backend_start::text,backend_type,state,")) return Reflect.apply(original, this, args);
      // Controlled role change at the actual query boundary; PostgreSQL itself returns 42501.
      return Reflect.apply(original, this, [`SET ROLE ${quote(role)}`]).then(() => Reflect.apply(original, this, args)).catch((error: { code?: string }) => {
        denied = error.code === "42501"; throw error;
      });
    });
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
      async () => assert.fail("unreadable inventory is not empty"))), error =>
      (error as { code?: string }).code === "source_writer_unknown" && !String(error).includes(role));
    assert.equal(denied, true);
  } finally {
    t.mock.restoreAll();
    const cleanup = await f.connect(); try { await cleanup.query("GRANT SELECT ON pg_catalog.pg_stat_activity TO PUBLIC"); } finally { await f.closeClient(cleanup); }
    if (created) await f.admin.query(`DROP ROLE ${quote(role)}`); await f.close();
  }
});

pgTest("A11A PostgreSQL facts borrow both physical lock modes and do not publish source changes", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const mode of ["control", "snapshot"] as const) {
      const before = await f.adapter.observe(), config = await readFile(path.join(f.directory, "config.json"));
      await f.adapter.withSourceLock(mode, lock => lock.withSourceClientFacts(f.reference, async window => {
        const competitor = await f.connect();
        try {
          await competitor.query("SET lock_timeout='25ms'");
          await assert.rejects(competitor.query("UPDATE projects SET name=name WHERE false"), { code: "55P03" });
        } finally { await f.closeClient(competitor); }
        await window.assertCurrent();
      }));
      const after = await f.adapter.observe();
      assert.deepEqual(after.manifests, before.manifests); assert.deepEqual(after.state, before.state); assert.deepEqual(after.clients, before.clients);
      assert.deepEqual(await readFile(path.join(f.directory, "config.json")), config);
    }
    const original = await f.store.readJson(f.head, "journal") as JournalRecordV2;
    const head = await f.store.putJson("journal", { ...original, sequence: 2, previous: f.head, event: "observation", requestId: "actual-control-boundary" });
    await f.adapter.withSourceLock("control", async lock => {
      await lock.withSourceClientFacts(f.reference, async () => {});
      const { state } = await lock.observeSourceClients();
      await lock.anchor({ expected: state, admission: "draining", fenceEpoch: 1, ownerGeneration: 1, activeMigrationId: f.plan.migrationId,
        planDigest: f.reference.planDigest, controlRootIdentity: f.store.identity as never, mutexIdentity: f.mutex.identity, journal: head, journalSequence: 2 });
      await assert.rejects(lock.withSourceClientFacts(f.reference, async () => assert.fail("control write requires a new lock")), { code: "maintenance_lost" });
    });
    await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async window => assert.deepEqual(window.origin.head, head)));
  } finally { await f.close(); }
});

pgTest("A11A PostgreSQL refuses unreadable runtime ownership as unknown facts", async t => {
  const f = await fixture(), role = `sca11_runtime_denied_${randomUUID().replaceAll("-", "")}`;
  const original = Client.prototype.query; let denied = false, consumed = false;
  try {
    await f.admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
    t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (sql !== "SELECT member_id,binding_id,generation,lease_owner,lease_expires_at FROM agent_runtime_members")
        return Reflect.apply(original, this, args);
      // Change only the real query session's role; PostgreSQL supplies the permission failure.
      return Reflect.apply(original, this, [`SET LOCAL ROLE ${quote(role)}`]).then(() => Reflect.apply(original, this, args)).catch((error: { code?: string }) => {
        denied = error.code === "42501"; throw error;
      });
    });
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference,
      async () => { consumed = true; })), error => {
      assert.equal((error as { code?: string }).code, "source_writer_unknown");
      assert(!String(error).includes(role)); return true;
    });
    assert.equal(denied, true); assert.equal(consumed, false);
  } finally { t.mock.restoreAll(); await f.admin.query(`DROP ROLE ${quote(role)}`); await f.close(); }
});

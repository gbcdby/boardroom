import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { inspect } from "node:util";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { checksumOf, migrationSql } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { maintenanceHostIdentityDigest } from "../src/server/storage/maintenance/host.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readPostgresCatalog, readPostgresManifests } from "../src/server/storage/maintenance/postgres-manifests.ts";
import { parsePostgresConnection } from "../src/server/storage/maintenance/postgres-tools.ts";
import { buildSourceClientsRoster, parseSourceClientsRoster, sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";
import { assertCapturedSourceClientBinding } from "../src/server/storage/maintenance/source-client-binding.ts";
import { buildDatabaseManifests } from "../src/server/storage/maintenance/manifests.ts";

const testUrl = process.env.AGENT_STUDIO_PG_TEST_URL;
const pgTest = testUrl ? test : test.skip;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const marker = "2".repeat(32);
const columns = ["client_id", "database_instance_id", "entrypoint", "build_id", "protocol_version", "host_identity_json",
  "process_identity_json", "db_sessions_json", "registered_epoch", "observed_epoch", "drain_epoch", "drain_state",
  "drain_receipt_digest", "registered_at", "last_observed_at", "ended_at"] as const;
async function fixture(encoding: "UTF8" | "LATIN1" | "SQL_ASCII") {
  if (!testUrl) throw new Error("Explicit private PG test URL is required");
  const database = `br_sca10_${randomUUID().replaceAll("-", "")}`;
  const directory = await realpath(await mkdtemp(join(tmpdir(), "br-sca10-pg-"))); await chmod(directory, 0o700);
  const info = await lstat(directory, { bigint: true });
  const root = { path: directory, device: info.dev.toString(), inode: info.ino.toString(), hostIdentityDigest: await maintenanceHostIdentityDigest() };
  const admin = new Client({ connectionString: testUrl }); admin.on("error", () => {}); await admin.connect();
  const url = new URL(testUrl); url.pathname = `/${database}`;
  const descriptor = { kind: "postgres" as const, connectionString: url.toString(), schema: "app" };
  let created = false, adapter: Awaited<ReturnType<typeof createPostgresMaintenanceAdapter>> | undefined;
  const clients = new Set<Client>();
  const connect = async () => {
    const client = new Client(parsePostgresConnection(descriptor).clientConfig); client.on("error", () => {});
    clients.add(client); await client.connect(); await client.query('SET search_path TO "app",pg_catalog'); return client;
  };
  const close = async () => {
    try {
      await adapter?.close();
      for (const client of clients) await client.end(); clients.clear();
      if (created) {
        const remaining = await admin.query("SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1", [database]);
        assert.equal(remaining.rows[0].count, "0", "all owned source sessions must close before DROP");
        await admin.query(`DROP DATABASE ${quote(database)}`); created = false;
      }
    } finally { await admin.end(); await rm(directory, { recursive: true }); }
  };
  try {
    await admin.query(`CREATE DATABASE ${quote(database)} TEMPLATE template0 ENCODING '${encoding}' LC_COLLATE 'C' LC_CTYPE 'C'`); created = true;
    // Fixture bootstrap only: the unchanged migration SQL contains UTF8 comments,
    // while every persisted token/function body is ASCII. SQL_ASCII transmits those
    // original bytes without conversion; LATIN1 still validates them. The original
    // driver executes the complete SQL and records its original checksums. All
    // subsequent source/adapter connections retain the production UTF8 setting.
    const driver = new PostgresDriver({ connectionString: descriptor.connectionString, schema: descriptor.schema });
    const migrationQueries = new Map(migrations.map(m => [migrationSql(m, "postgres"), m.version]));
    const migrationWitness: { version: number; pid: number; client_encoding: string; server_encoding: string }[] = [];
    const originalQuery = Client.prototype.query;
    try {
      await driver.connect();
      if (encoding === "LATIN1") {
        // The fixture is sequential: the driver's only pooled connection retains
        // this session setting across the original per-migration transactions.
        await driver.query("SET client_encoding='SQL_ASCII'");
        assert.equal((await driver.query("SHOW client_encoding"))[0]!.client_encoding, "SQL_ASCII");
        // Private setup witness only. The intercepted SQL is forwarded byte-for-byte.
        Client.prototype.query = function(this: Client, ...args: unknown[]) {
          const version = typeof args[0] === "string" ? migrationQueries.get(args[0]) : undefined;
          if (version === undefined) return Reflect.apply(originalQuery, this, args);
          return Promise.resolve(Reflect.apply(originalQuery, this, ["SELECT pg_backend_pid() AS pid,current_setting('client_encoding') AS client_encoding,current_setting('server_encoding') AS server_encoding"]))
            .then(result => {
              const row = result.rows[0]; assert.equal(row.client_encoding, "SQL_ASCII"); assert.equal(row.server_encoding, "LATIN1");
              migrationWitness.push({ version, ...row });
              return Reflect.apply(originalQuery, this, args);
            });
        } as Client["query"];
      }
      await driver.migrate(migrations);
      if (encoding === "LATIN1") assert.equal((await driver.query("SHOW client_encoding"))[0]!.client_encoding, "SQL_ASCII");
    } finally { Client.prototype.query = originalQuery; await driver.close(); }
    const writer = await connect(); await writer.query("UPDATE storage_maintenance SET database_instance_id=$1", [marker]);
    assert.equal((await writer.query("SHOW server_encoding")).rows[0].server_encoding, encoding);
    assert.equal((await writer.query("SHOW client_encoding")).rows[0].client_encoding, "UTF8");
    if (encoding === "LATIN1") {
      assert.deepEqual(migrationWitness.map(row => row.version), migrations.map(m => m.version));
      assert.equal(new Set(migrationWitness.map(row => row.pid)).size, 1);
      assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND pid=$2", [database, migrationWitness[0]!.pid])).rows[0].count, "0");
      const ledger = (await writer.query("SELECT version::text AS version,name,checksum FROM schema_migrations ORDER BY schema_migrations.version")).rows;
      assert.deepEqual(ledger, migrations.map(m => ({ version: String(m.version), name: m.name, checksum: checksumOf(migrationSql(m, "postgres")) })));
      const catalog = await readPostgresCatalog(writer, "app"); // Original strict guard/function/profile validation.
      console.log("LATIN1 fixture initialization witness", JSON.stringify({ migrationWitness, ledger, schemaManifestDigest: digestJson(catalog.schema), initializationSessionClosed: true, sourceClientEncoding: "UTF8" }));
    }
    adapter = await createPostgresMaintenanceAdapter(descriptor, undefined);
    return { database, directory, root, admin, descriptor, adapter, writer, connect, close };
  } catch (error) { await close(); throw error; }
}
function cells(encoding: "UTF8" | "LATIN1" | "SQL_ASCII") {
  const text = (value: string) => ["text", Buffer.from(value, "utf8").toString("hex")];
  return {
    client_id: ["text", encoding === "UTF8" ? "e5ad97" : "80"], database_instance_id: text(marker),
    entrypoint: text("maintenance-controller"), build_id: ["text", encoding === "UTF8" ? "65cc81" : "e9"],
    protocol_version: ["integer", "1"], host_identity_json: ["text", encoding === "UTF8" ? "7b202268223a20225c753030363122207d" : "ff"],
    process_identity_json: text('{ "process" : 1 }'), db_sessions_json: text('{"sessions": []}'),
    registered_epoch: ["integer", "9007199254740993"], observed_epoch: ["integer", "9223372036854775807"],
    drain_epoch: ["null"], drain_state: text("none"), drain_receipt_digest: ["null"], registered_at: text("t\n1"),
    last_observed_at: ["text", ""], ended_at: ["null"],
  };
}
async function seed(client: Client, raw: ReturnType<typeof cells>) {
  const parameters: (string | null)[] = [];
  const expressions = columns.map(name => {
    const value = raw[name]; parameters.push(value[1] ?? null);
    return value[0] === "text" ? `pg_catalog.convert_from(pg_catalog.decode($${parameters.length},'hex'),current_setting('server_encoding'))`
      : `$${parameters.length}::${name === "protocol_version" ? "integer" : ["drain_epoch", "registered_epoch", "observed_epoch"].includes(name) ? "bigint" : "text"}`;
  });
  await client.query(`INSERT INTO storage_source_clients(${columns.join(",")}) VALUES(${expressions.join(",")})`, parameters);
}

pgTest("#152 C3 PG source rows have identical raw order for opposite physical insertion orders", async t => {
  for (const encoding of ["UTF8", "LATIN1", "SQL_ASCII"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      const higher = cells(encoding);
      const lower = { ...cells(encoding), client_id: ["text", "41"], observed_epoch: ["integer", "0"],
        ended_at: ["text", "656e646564"], entrypoint: ["text", "68747470"] };
      await seed(f.writer, higher); await seed(f.writer, lower);
      const descending = await f.adapter.observeSourceClients();
      assert.deepEqual(descending.rows, [lower, higher]);
      await f.writer.query("DELETE FROM storage_source_clients");
      await seed(f.writer, lower); await seed(f.writer, higher);
      const ascending = await f.adapter.observeSourceClients();
      assert.deepEqual(ascending, descending, "complete native cells and source/schema/encoding bindings must be insertion-order independent");
    } finally { await f.close(); }
  });
});

pgTest("#228 PG UTF8/LATIN1/SQL_ASCII: capture/archive binding uses the actual native encoding in one lock", async t => {
  for (const encoding of ["UTF8", "LATIN1", "SQL_ASCII"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding); let mutex;
    try {
      // SQL_ASCII high bytes remain unreadable by the existing Md reader; retain
      // that separate rejection test. Its supported ASCII rows still bind here.
      const row = encoding === "SQL_ASCII" ? { ...cells(encoding), client_id: ["text", "636c69656e74"],
        build_id: ["text", "6275696c64"], host_identity_json: ["text", "7b7d"] } : cells(encoding);
      await seed(f.writer, row);
      mutex = await f.adapter.acquireMutex(f.root, (await f.adapter.observe()).state);
      const planHash = "a".repeat(64), journalHash = "b".repeat(64);
      // Private data fixture metadata only: no journal artifact, capture permit,
      // B/U or V is constructed. The test exercises the native data join alone.
      await f.writer.query(`UPDATE storage_maintenance SET admission='sealed',fence_epoch=1,owner_generation=1,
        active_migration_id='native-binding-fixture',plan_digest=$1,journal_record_ref=$2,journal_digest=$3,journal_sequence=2`,
      [planHash, `journals/native-binding-fixture/2-${journalHash}.json`, journalHash]);
      await f.adapter.withSourceLock("snapshot", async lock => {
        const observed = await lock.observe(), raw = await lock.observeSourceClients();
        assert.deepEqual(raw.textEncoding, { backend: "postgres", name: encoding });
        const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
          migrationId: "native-binding-fixture", plan: { ref: `plans/${planHash}.json`, sha256: planHash, bytes: "1" },
          fenceEpoch: "1", receiptGeneration: "1", textEncoding: raw.textEncoding, rows: raw.rows });
        await assertCapturedSourceClientBinding(lock, observed, roster, observed.manifests);
        assert.equal(raw.rows[0]!.registered_epoch[1], "9007199254740993");
        assert.equal(raw.rows[0]!.observed_epoch[1], "9223372036854775807");
        const archived = buildDatabaseManifests("postgres", observed.manifests.schema, observed.manifests.tables,
          { ...observed.manifests.controlRows, storage_source_clients: observed.manifests.controlRows.storage_source_clients
            .map(value => ({ ...value, build_id: "different-archive-value" })) });
        await assert.rejects(assertCapturedSourceClientBinding(lock, observed, roster, archived),
          error => error instanceof MaintenanceFailure && error.code === "source_changed");
        assert.deepEqual(await lock.observe(), observed);
      });
    } finally { await mutex?.release(); await f.close(); }
  });
});

pgTest("#152 A10-R04/R08 PG SQL_ASCII non-UTF8 bytes succeed through the actual standalone and SourceLock APIs", async () => {
  const f = await fixture("SQL_ASCII"); let mutex;
  try {
    const expected = cells("SQL_ASCII"); await seed(f.writer, expected);
    const encoding = (await f.writer.query("SHOW server_encoding")).rows[0].server_encoding;
    assert.equal(encoding, "SQL_ASCII"); assert.equal((await f.writer.query("SHOW client_encoding")).rows[0].client_encoding, "UTF8");
    await assert.rejects(readPostgresManifests(f.writer, "app"), { code: "22021" });
    await assert.rejects(f.adapter.observe(), /schema_guard_incomplete/);
    const raw = await f.adapter.observeSourceClients();
    assert.deepEqual(raw.rows, [expected]); assert.deepEqual(raw.textEncoding, { backend: "postgres", name: "SQL_ASCII" });
    assert.equal(raw.source.identityDigest, digestJson(raw.sourceIdentity));
    assert.equal(raw.source.databaseInstanceId, raw.state.databaseInstanceId);
    assert.equal(raw.source.databaseInstanceId, marker);
    mutex = await f.adapter.acquireMutex(f.root, raw.state);
    const bound = await f.adapter.observeSourceClients();
    await f.adapter.withSourceLock("control", async lock => {
      assert.deepEqual(await lock.observeSourceClients(), bound);
      await lock.assertHeld();
    });
  } finally { await mutex?.release(); await f.close(); }
});

pgTest("#152 A10-R07 PG owned close rejection and synchronous failure never return a successful raw observation", async t => {
  for (const mode of ["rejected-promise", "synchronous-throw"]) await t.test(mode, async t => {
    const f = await fixture("UTF8"); const original = Client.prototype.end;
    try {
      t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
        if (database !== f.database || this === f.writer) return result;
        if (mode === "synchronous-throw") throw new Error("private-close-canary");
        return Promise.resolve(result).then(() => { throw new Error("private-close-canary"); });
      });
      await assert.rejects(f.adapter.observeSourceClients(), error =>
        /maintenance_lost/.test(String(error)) && !String(error).includes("canary"));
      t.mock.restoreAll();
      await assert.rejects(f.adapter.observe(), /maintenance_lost/, "unconfirmed facts close still retires this adapter");
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

pgTest("#152 A10-R04/R06/R08/R09/R10 PG actual UTF8/LATIN1/SQL_ASCII rosters survive both real lock modes without new writes", async t => {
  for (const encoding of ["UTF8", "LATIN1", "SQL_ASCII"] as const) await t.test(encoding, async t => {
    const f = await fixture(encoding); let mutex;
    const originalQuery = Client.prototype.query;
    let mode = "standalone";
    const encodingWitness: { mode: string; pid: number; client_encoding: string; server_encoding: string; database_encoding: string }[] = [];
    try {
      t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(originalQuery, this, args);
        const sql = (args[0] as { text?: string })?.text ?? "";
        if (!sql.startsWith("SELECT pg_catalog.encode(pg_catalog.convert_to(")) return result;
        return Promise.resolve(result).then(async value => {
          const witness = (await Reflect.apply(originalQuery, this, ["SELECT pg_backend_pid() AS pid,current_setting('client_encoding') AS client_encoding,current_setting('server_encoding') AS server_encoding,(SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname=current_database()) AS database_encoding"])).rows[0];
          assert.equal(witness.client_encoding, "UTF8"); assert.equal(witness.server_encoding, encoding); assert.equal(witness.database_encoding, encoding);
          encodingWitness.push({ mode, ...witness }); return value;
        });
      });
      assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
      const first = cells(encoding);
      const second = { ...cells(encoding), client_id: ["text", "41"], registered_epoch: ["integer", "0"],
        observed_epoch: ["integer", "9007199254740992"], drain_epoch: ["integer", "9223372036854775807"],
        ended_at: ["text", "656e646564"], entrypoint: ["text", "68747470"] };
      await seed(f.writer, first); await seed(f.writer, second);
      const independent = async () => (await f.writer.query(`SELECT
        (SELECT md5(string_agg(t::text,',' ORDER BY client_id)) FROM storage_source_clients t) AS clients,
        (SELECT md5(t::text) FROM storage_maintenance t) AS state,
        (SELECT md5(string_agg(t::text,',' ORDER BY version)) FROM schema_migrations t) AS migrations`)).rows;
      const before = await independent(), raw = await f.adapter.observeSourceClients();
      assert.deepEqual(await independent(), before);
      const sort = (rows: readonly { client_id: readonly string[] }[]) => [...rows].sort((a, b) => a.client_id[1]! < b.client_id[1]! ? -1 : 1);
      assert.deepEqual(sort(raw.rows), sort([first, second]));
      assert.deepEqual(raw.textEncoding, { backend: "postgres", name: encoding });
      if (encoding !== "SQL_ASCII") {
        const old = await f.adapter.observe();
        assert.deepEqual(raw.source, old.source); assert.deepEqual(raw.state, old.state);
        assert.equal(raw.schemaManifestDigest, old.manifests.schemaManifestDigest);
      }
      const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
        migrationId: "private-fixture", plan: { ref: `plans/${"a".repeat(64)}.json`, sha256: "a".repeat(64), bytes: "1" },
        fenceEpoch: "1", receiptGeneration: "1", textEncoding: raw.textEncoding, rows: raw.rows });
      assert.deepEqual(parseSourceClientsRoster(roster), roster); assert.deepEqual(roster.rows, sort([first, second]));
      const changedBytes = { ...roster.rows[0]!, process_identity_json: ["text", "7b2270726f63657373223a317d"] };
      assert.notEqual(sourceClientsDigest(buildSourceClientsRoster({ ...roster, rows: [changedBytes, ...roster.rows.slice(1)] })), sourceClientsDigest(roster));
      mutex = await f.adapter.acquireMutex(f.root, raw.state); // Existing root CAS is setup, outside the readonly raw interval.
      const bound = await f.adapter.observeSourceClients(), boundBefore = await independent();
      await f.writer.query("SET lock_timeout='50ms'");
      for (const kind of ["control", "snapshot"] as const) await f.adapter.withSourceLock(kind, async lock => {
        mode = kind;
        assert.deepEqual(await lock.observeSourceClients(), bound);
        await assert.rejects(f.writer.query("UPDATE storage_source_clients SET build_id='contender'"), { code: "55P03" });
        await assert.rejects(f.writer.query("ALTER TABLE storage_source_clients ADD COLUMN unwanted TEXT"), { code: "55P03" });
        assert.deepEqual(await lock.observeSourceClients(), bound); await lock.assertHeld();
      });
      assert.deepEqual(await independent(), boundBefore); assert.deepEqual(await readdir(f.directory), []);
      await assert.rejects(f.writer.query("SELECT pg_catalog.convert_from(pg_catalog.decode('00','hex'),current_setting('server_encoding'))"), { code: "22021" });
      // Real post-release success is the counterfactual for the competing writer above.
      mode = "standalone";
      await f.writer.query("UPDATE storage_source_clients SET build_id='after-lock'");
      assert.notDeepEqual((await f.adapter.observeSourceClients()).rows, bound.rows);
      assert.deepEqual([...new Set(encodingWitness.map(row => row.mode))].sort(), ["control", "snapshot", "standalone"]);
      console.log("PG raw actual encoding witness", JSON.stringify(encodingWitness));
    } finally { t.mock.restoreAll(); await mutex?.release(); await f.close(); }
  });
});

pgTest("#152 A10-R08 PG standalone repeatable read keeps state/count/rows from one actual view during a committed writer", async t => {
  const f = await fixture("UTF8"); const original = Client.prototype.query;
  try {
    const expected = cells("UTF8"); await seed(f.writer, expected);
    let interleaved = false;
    t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
      if (this === f.writer || !sql.startsWith('SELECT count(*)::pg_catalog.text AS count FROM "app"."storage_source_clients"')) return result;
      return Promise.resolve(result).then(async value => {
        if (!interleaved) {
          interleaved = true;
          await f.writer.query("UPDATE storage_source_clients SET build_id='later-view'");
          await seed(f.writer, { ...cells("UTF8"), client_id: ["text", "6e6577"] });
        }
        return value;
      });
    });
    const raw = await f.adapter.observeSourceClients();
    assert.equal(interleaved, true); assert.deepEqual(raw.rows, [expected]);
    t.mock.restoreAll();
    const later = await f.adapter.observeSourceClients(); assert.equal(later.rows.length, 2); assert.notDeepEqual(later.rows, raw.rows);
  } finally { t.mock.restoreAll(); await f.close(); }
});

pgTest("#152 A10-R05 PG native column layouts reject extras, drops, aliases, domains and generated values before casting", async t => {
  for (const sql of [
    "ALTER TABLE storage_source_clients ADD COLUMN extra TEXT",
    "ALTER TABLE storage_source_clients DROP COLUMN build_id",
    "ALTER TABLE storage_source_clients ALTER COLUMN build_id TYPE VARCHAR",
    "CREATE DOMAIN raw_text AS TEXT; ALTER TABLE storage_source_clients ALTER COLUMN build_id TYPE raw_text",
    "ALTER TABLE storage_source_clients ADD COLUMN extra TEXT GENERATED ALWAYS AS (client_id) STORED",
    "ALTER TABLE storage_source_clients DROP CONSTRAINT storage_source_clients_pkey",
  ]) await t.test(sql, async () => {
    const f = await fixture("UTF8");
    try { await f.writer.query(sql); await assert.rejects(f.adapter.observeSourceClients(), /schema_guard_incomplete/); }
    finally { await f.close(); }
  });
});

pgTest("#152 A10-R05 PG existing source identity pin is shared by the new and old observations", async () => {
  const f = await fixture("UTF8");
  try {
    const first = await f.adapter.observe(); const raw = await f.adapter.observeSourceClients(); assert.deepEqual(raw.source, first.source);
    await f.writer.query("UPDATE storage_maintenance SET database_instance_id=$1", ["3".repeat(32)]);
    await assert.rejects(f.adapter.observeSourceClients(), /source_changed/);
    await assert.rejects(f.adapter.observe(), /source_changed/);
  } finally { await f.close(); }
});

pgTest("#152 A10-R08 PG raw-only locked reads activate the original fresh catalog pin at wrapper completion", async () => {
  const f = await fixture("UTF8"); let mutex;
  try {
    const raw = await f.adapter.observeSourceClients(); mutex = await f.adapter.acquireMutex(f.root, raw.state);
    await assert.rejects(f.adapter.withSourceLock("snapshot", async lock => {
      await lock.observeSourceClients();
      // This schema-wide catalog fact is not protected by the table SHARE locks.
      await f.writer.query("COMMENT ON SCHEMA app IS 'concurrent-private-fixture'");
      await lock.assertHeld();
    }), /source_changed/);
  } finally { await mutex?.release(); await f.close(); }
});

pgTest("#152 A10-R08 PG real critical backend loss invalidates a borrowed raw read without reconnecting", async () => {
  const f = await fixture("UTF8"); let mutex;
  try {
    const raw = await f.adapter.observeSourceClients(); mutex = await f.adapter.acquireMutex(f.root, raw.state);
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      await lock.observeSourceClients();
      const holders = await f.admin.query(`SELECT DISTINCT a.pid FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_locks l ON l.pid=a.pid
        WHERE a.datname=$1 AND a.application_name LIKE 'boardroom-maintenance:%' AND l.mode='ShareRowExclusiveLock' AND l.granted`, [f.database]);
      assert.equal(holders.rows.length, 1);
      await f.admin.query("SELECT pg_catalog.pg_terminate_backend($1,1000)", [holders.rows[0].pid]);
      await assert.rejects(lock.observeSourceClients(), /maintenance_lost/);
    }), /maintenance_lost/);
    await assert.rejects(f.adapter.observeSourceClients(), /maintenance_lost/);
  } finally { await mutex?.release(); await f.close(); }
});

pgTest("#152 A10-R11 ordinary PG observe propagates an unconfirmed close and remains usable after cleanup", async t => {
  const f = await fixture("UTF8"); const original = Client.prototype.end;
  let endedPid: number | undefined, completedEnds = 0;
  try {
    t.mock.method(Client.prototype, "end", function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
      if (database === f.database && this !== f.writer) return Promise.resolve(result).then(() => {
        endedPid = (this as unknown as { processID: number }).processID; completedEnds++;
        throw new Error("private-old-close-canary");
      });
      return result;
    });
    await assert.rejects(f.adapter.observe(), error => {
      assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost");
      assert.equal(error.message, "storage_maintenance: maintenance_lost (observation-close)");
      assert.doesNotMatch(inspect(error, { depth: 10 }), /private-old-close-canary/); return true;
    });
    assert.equal(completedEnds, 1); assert.equal(typeof endedPid, "number");
    assert.equal((await f.admin.query("SELECT count(*)::text AS n FROM pg_catalog.pg_stat_activity WHERE datname=$1 AND pid=$2", [f.database, endedPid])).rows[0].n, "0");
    t.mock.restoreAll();
    const old = await f.adapter.observe(); assert.equal(old.source.databaseInstanceId, marker);
  } finally { t.mock.restoreAll(); await f.close(); }
});

pgTest("#152 A10-R05/R07 private PG transport faults never become empty or partial successful rosters", async t => {
  const f = await fixture("UTF8"); const original = Client.prototype.query;
  try {
    await seed(f.writer, cells("UTF8"));
    for (const [mode, code] of [
      ["short-row", "snapshot_invalid"], ["bad-hex", "snapshot_invalid"], ["byte-length", "snapshot_invalid"],
      ["number-integer", "snapshot_invalid"], ["null-protocol", "snapshot_invalid"], ["negative-integer", "snapshot_invalid"],
      ["overflow-integer", "snapshot_invalid"], ["count", "source_changed"], ["duplicate-id", "snapshot_invalid"],
      ["unknown-encoding", "schema_guard_incomplete"], ["wrong-valid-encoding", "source_changed"],
      ["query-error", "snapshot_invalid"], ["serialization", "source_changed"], ["busy", "maintenance_busy"],
    ]) await t.test(mode!, async t => {
      let injected = false;
      t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(original, this, args);
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        if (this === f.writer || this === f.admin) return result;
        return Promise.resolve(result).then(value => {
          if (sql.startsWith("SELECT pg_catalog.pg_encoding_to_char(d.encoding) AS encoding") && ["unknown-encoding", "wrong-valid-encoding"].includes(mode!)) {
            injected = true; value.rows[0].encoding = mode === "unknown-encoding" ? "UNKNOWN" : "LATIN1";
          } else if (sql.startsWith('SELECT count(*)::pg_catalog.text AS count FROM "app"."storage_source_clients"') && ["count", "duplicate-id"].includes(mode!)) {
            injected = true; value.rows[0].count = "2";
          } else if (sql.startsWith("SELECT pg_catalog.encode(pg_catalog.convert_to(")) {
            if (["short-row", "bad-hex", "byte-length", "number-integer", "null-protocol", "negative-integer", "overflow-integer", "duplicate-id", "query-error", "serialization", "busy"].includes(mode!)) injected = true;
            if (mode === "short-row") value.rows[0].pop();
            if (mode === "bad-hex") value.rows[0][0] = "private-invalid-raw-canary";
            if (mode === "byte-length") value.rows[0][1] = "1";
            if (mode === "number-integer") value.rows[0][16] = 9007199254740992;
            if (mode === "null-protocol") value.rows[0][8] = null;
            if (mode === "negative-integer") value.rows[0][16] = "-1";
            if (mode === "overflow-integer") value.rows[0][16] = "9223372036854775808";
            if (mode === "duplicate-id") value.rows.push([...value.rows[0]]);
            if (["query-error", "serialization", "busy"].includes(mode!)) throw Object.assign(new Error("private-sql-data-canary"),
              { code: mode === "serialization" ? "40001" : mode === "busy" ? "55P03" : "XX000" });
          }
          return value;
        });
      });
      try { await assert.rejects(f.adapter.observeSourceClients(), error => String(error).includes(code!) && !String(error).includes("canary")); assert.equal(injected, true); }
      finally { t.mock.restoreAll(); }
      if (mode === "bad-hex") {
        assert.equal((await f.admin.query("SELECT count(*)::text AS n FROM pg_catalog.pg_stat_activity WHERE datname=$1 AND application_name LIKE 'boardroom-maintenance:%'", [f.database])).rows[0].n, "0");
        assert.equal((await f.adapter.observe()).source.databaseInstanceId, marker, "a decoded-row rejection with confirmed close does not retire ordinary observation");
      }
    });
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, [cells("UTF8")]);
  } finally { t.mock.restoreAll(); await f.close(); }
});

pgTest("#152 A10-R07 real PG SELECT denial fails safely instead of returning an empty roster", async () => {
  const f = await fixture("UTF8"); const role = `br_sca10_role_${randomUUID().replaceAll("-", "")}`, password = randomUUID();
  let created = false, reader: Client | undefined, adapter: Awaited<ReturnType<typeof createPostgresMaintenanceAdapter>> | undefined;
  try {
    await seed(f.writer, cells("UTF8"));
    await f.admin.query(`CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`); created = true;
    await f.admin.query(`GRANT pg_monitor TO ${quote(role)}`);
    await f.writer.query(`GRANT USAGE ON SCHEMA app TO ${quote(role)}; GRANT SELECT ON ALL TABLES IN SCHEMA app TO ${quote(role)}; REVOKE SELECT ON storage_source_clients FROM ${quote(role)}`);
    const url = new URL(f.descriptor.connectionString); url.username = role; url.password = password;
    const descriptor = { ...f.descriptor, connectionString: url.toString() };
    reader = new Client(parsePostgresConnection(descriptor).clientConfig); reader.on("error", () => {}); await reader.connect();
    await reader.query('SET search_path TO "app",pg_catalog');
    await readPostgresCatalog(reader, "app"); // The original closed profile is readable; row permission alone is denied.
    await assert.rejects(reader.query("SELECT count(*) FROM storage_source_clients"), { code: "42501" });
    adapter = await createPostgresMaintenanceAdapter(descriptor, undefined);
    await assert.rejects(adapter.observeSourceClients(), error => /snapshot_invalid/.test(String(error)) && !String(error).includes(role) && !String(error).includes(password));
  } finally {
    try { await adapter?.close(); await reader?.end(); if (created) { await f.writer.query(`DROP OWNED BY ${quote(role)}`); await f.admin.query(`DROP ROLE ${quote(role)}`); } }
    finally { await f.close(); }
  }
});

pgTest("#152 A10-R07 real PG missing-database connection failure does not produce a raw observation", async () => {
  const f = await fixture("UTF8"); let adapter;
  try {
    const url = new URL(f.descriptor.connectionString); url.pathname += "_missing";
    adapter = await createPostgresMaintenanceAdapter({ ...f.descriptor, connectionString: url.toString() }, undefined);
    await assert.rejects(adapter.observeSourceClients(), error => /source_missing/.test(String(error)) && !String(error).includes(f.database));
  } finally { await adapter?.close(); await f.close(); }
});

pgTest("#152 A10-R07 cancellation after actual PG row completion prevents a cached success", async t => {
  const f = await fixture("UTF8"); const original = Client.prototype.query; let cancelled = false;
  try {
    await seed(f.writer, cells("UTF8"));
    t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      const sql = (args[0] as { text?: string })?.text ?? "";
      if (!sql.startsWith("SELECT pg_catalog.encode(pg_catalog.convert_to(")) return result;
      return Promise.resolve(result).then(async value => { cancelled = true; await f.adapter.close(); return value; });
    });
    await assert.rejects(f.adapter.observeSourceClients(), /maintenance_lost/); assert.equal(cancelled, true);
  } finally { t.mock.restoreAll(); await f.close(); }
});

pgTest("#152 A10-R04/R07 PG raw transport preserves a full 70KiB original JSON text", async () => {
  const f = await fixture("UTF8");
  try {
    const original = '{ "value" : "' + "字".repeat(24_000) + '" }';
    const expected = { ...cells("UTF8"), process_identity_json: ["text", Buffer.from(original).toString("hex")] };
    await seed(f.writer, expected);
    const raw = await f.adapter.observeSourceClients(); assert.deepEqual(raw.rows, [expected]);
    assert.ok(Buffer.from(raw.rows[0]!.process_identity_json[1]!, "hex").length > 70 * 1024);
  } finally { await f.close(); }
});

pgTest("#152 A10-R08 real PG lock loss between completed rows and borrowed return is checked", async t => {
  for (const target of ["mutex", "source-lock"] as const) await t.test(target, async t => {
    const f = await fixture("UTF8"); const original = Client.prototype.query; let mutex, lost = false;
    try {
      const raw = await f.adapter.observeSourceClients(); mutex = await f.adapter.acquireMutex(f.root, raw.state);
      await assert.rejects(f.adapter.withSourceLock("control", async lock => {
        t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args);
          const sql = (args[0] as { text?: string })?.text ?? "";
          if (!sql.startsWith("SELECT pg_catalog.encode(pg_catalog.convert_to(")) return result;
          return Promise.resolve(result).then(async value => {
            const holders = await f.admin.query(`SELECT DISTINCT a.pid FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_locks l ON l.pid=a.pid
              WHERE a.datname=$1 AND l.granted AND ${target === "mutex" ? "l.locktype='advisory'" : "l.locktype='relation' AND l.mode='ShareRowExclusiveLock'"}`, [f.database]);
            assert.equal(holders.rows.length, 1);
            await f.admin.query("SELECT pg_catalog.pg_terminate_backend($1,1000)", [holders.rows[0].pid]);
            lost = true; return value;
          });
        });
        await assert.rejects(lock.observeSourceClients(), /maintenance_lost/);
      }), /maintenance_lost/);
      assert.equal(lost, true);
    } finally { t.mock.restoreAll(); await mutex?.release(); await f.close(); }
  });
});

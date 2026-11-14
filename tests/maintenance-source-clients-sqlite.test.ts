import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmod, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { buildSourceClientsRoster, parseSourceClientsRoster, sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";

type Encoding = "UTF-8" | "UTF-16le" | "UTF-16be";
const columns = ["client_id", "database_instance_id", "entrypoint", "build_id", "protocol_version", "host_identity_json",
  "process_identity_json", "db_sessions_json", "registered_epoch", "observed_epoch", "drain_epoch", "drain_state",
  "drain_receipt_digest", "registered_at", "last_observed_at", "ended_at"] as const;
const marker = "1".repeat(32);
async function fixture(encoding: Encoding = "UTF-8") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "br-sca10-sqlite-")));
  const file = join(directory, "source.db"), db = new Database(file);
  let adapter: Awaited<ReturnType<typeof createSqliteMaintenanceAdapter>> | undefined;
  try {
    db.pragma(`encoding='${encoding}'`); runMigrations(db, migrations); db.pragma("journal_mode=WAL");
    db.pragma("busy_timeout=0"); // The competing fixture writes explicitly test NOWAIT lock refusal.
    db.prepare("UPDATE storage_maintenance SET database_instance_id=?").run(marker);
    const info = await stat(file, { bigint: true });
    const descriptor = { kind: "sqlite" as const, dataDir: directory, sourcePath: file, sqlitePath: file,
      identity: { device: info.dev.toString(), inode: info.ino.toString() } };
    adapter = await createSqliteMaintenanceAdapter(descriptor);
    return { directory, file, db, descriptor, adapter,
      async close() { try { await adapter!.close(); } finally { db.close(); await rm(directory, { recursive: true }); } } };
  } catch (error) { await adapter?.close(); db.close(); await rm(directory, { recursive: true }); throw error; }
}
function bytes(value: string, encoding: Encoding): string {
  if (encoding === "UTF-8") return Buffer.from(value, "utf8").toString("hex");
  const result = Buffer.from(value, "utf16le");
  return (encoding === "UTF-16be" ? result.swap16() : result).toString("hex");
}
function seed(db: Database.Database, overrides: Record<string, string | bigint | null> = {}) {
  const values: Record<typeof columns[number], string | bigint | null> = {
    client_id: "client-字-e\u0301", database_instance_id: marker, entrypoint: "maintenance-controller", build_id: "build\0字",
    protocol_version: 1n, host_identity_json: '{ "h" : "\\u0061" }', process_identity_json: '{"process":1}',
    db_sessions_json: '{ "sessions" : [] }', registered_epoch: 9007199254740993n,
    observed_epoch: 9223372036854775807n, drain_epoch: null, drain_state: "none", drain_receipt_digest: null,
    registered_at: "t\n1", last_observed_at: "", ended_at: null, ...overrides,
  };
  db.prepare(`INSERT INTO storage_source_clients(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .run(...columns.map(column => values[column]));
  return values;
}
function expected(values: ReturnType<typeof seed>, encoding: Encoding) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name,
    value === null ? ["null"] : typeof value === "bigint" ? ["integer", value.toString()] : ["text", bytes(value, encoding)]]));
}

test("#152 A10-R01/R02/R09 SQLite raw observation preserves all 16 original cells and source/schema binding", async () => {
  const f = await fixture();
  try {
    const values = seed(f.db), before = await f.adapter.observe();
    const raw = await f.adapter.observeSourceClients();
    assert.deepEqual(raw.rows, [expected(values, "UTF-8")]);
    assert.deepEqual(raw.textEncoding, { backend: "sqlite", name: "UTF-8" });
    assert.deepEqual(raw.source, before.source); assert.deepEqual(raw.sourceIdentity, before.sourceIdentity);
    assert.equal(raw.source.identityDigest, digestJson(raw.sourceIdentity));
    assert.equal(raw.source.databaseInstanceId, raw.state.databaseInstanceId);
    assert.deepEqual(raw.state, before.state); assert.equal(raw.schemaManifestDigest, before.manifests.schemaManifestDigest);
    assert.deepEqual(Object.keys(raw).sort(), ["rows", "schemaManifestDigest", "source", "sourceIdentity", "state", "textEncoding"]);
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

test("#152 A10-R01/R03/R06/R08 SQLite three actual encodings preserve bytes through the unchanged real mutex and lock", async t => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    let mutex;
    try {
      assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
      const values = seed(f.db);
      const standalone = await f.adapter.observeSourceClients();
      assert.deepEqual(standalone.rows, [expected(values, encoding)]);
      assert.deepEqual(standalone.textEncoding, { backend: "sqlite", name: encoding });
      const store = await ArtifactStore.create(join(f.directory, "control"), standalone.source);
      mutex = await f.adapter.acquireMutex(store.identity, standalone.state);
      const bound = await f.adapter.observeSourceClients();
      const before = await f.adapter.observe();
      await f.adapter.withSourceLock("control", async lock => {
        const held = await lock.observeSourceClients();
        assert.deepEqual(held, bound);
        assert.throws(() => f.db.exec("UPDATE storage_source_clients SET build_id='competing'"), { code: "SQLITE_BUSY" });
        assert.throws(() => f.db.exec("ALTER TABLE storage_source_clients ADD COLUMN extra TEXT"), { code: "SQLITE_BUSY" });
        assert.deepEqual(await lock.observeSourceClients(), held);
        assert.deepEqual(await lock.observe(), before);
      });
      assert.deepEqual(await f.adapter.observe(), before);
      await mutex.release(); mutex = undefined;
      // These bytes are inserted as native TEXT, without a JS-string decoding round trip.
      const anomalous = encoding === "UTF-8" ? "80ff00" : encoding === "UTF-16le" ? "00d8" : "d800";
      f.db.exec(`UPDATE storage_source_clients SET build_id=CAST(x'${anomalous}' AS TEXT)`);
      const raw = await f.adapter.observeSourceClients();
      assert.deepEqual(raw.rows[0]!.build_id, ["text", anomalous]);
      // The original SQLite mutex's full observe prerequisite must still be genuinely reachable.
      mutex = await f.adapter.acquireMutex(store.identity, raw.state);
      await f.adapter.withSourceLock("control", async lock => {
        assert.deepEqual((await lock.observeSourceClients()).rows[0]!.build_id, ["text", anomalous]);
      });
    } finally { await mutex?.release(); await f.close(); }
  });
});

test("#152 A10-R02/R06/R09 SQLite all history and int64 boundaries reach the existing byte-sorted codec", async () => {
  const f = await fixture();
  try {
    const boundaries = [0n, 9007199254740991n, 9007199254740992n, 9007199254740993n, 9223372036854775807n];
    const values = boundaries.map((value, index) => seed(f.db, { client_id: ["é", "z", "prefix-long", "prefix", "A"][index]!,
      registered_epoch: value, observed_epoch: value, drain_epoch: index === 0 ? null : value,
      entrypoint: index === 0 ? "maintenance-controller" : "http", ended_at: index % 2 ? "ended" : null }));
    const raw = await f.adapter.observeSourceClients();
    assert.equal(raw.rows.length, boundaries.length);
    const byId = (rows: readonly unknown[]) => [...rows].sort((a, b) =>
      JSON.stringify((a as { client_id: unknown }).client_id).localeCompare(JSON.stringify((b as { client_id: unknown }).client_id)));
    assert.deepEqual(byId(raw.rows), byId(values.map(value => expected(value, "UTF-8"))));
    const roster = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source: raw.source,
      migrationId: "private-fixture", plan: { ref: `plans/${"a".repeat(64)}.json`, sha256: "a".repeat(64), bytes: "1" },
      fenceEpoch: "1", receiptGeneration: "1", textEncoding: raw.textEncoding, rows: raw.rows });
    assert.deepEqual(roster.rows.map(row => row.client_id[1]), values.map(value => bytes(value.client_id as string, "UTF-8")).sort());
    assert.deepEqual(parseSourceClientsRoster(roster), roster);
    const before = sourceClientsDigest(roster);
    f.db.prepare("UPDATE storage_source_clients SET host_identity_json=?").run('{"h":"a"}');
    const changed = await f.adapter.observeSourceClients();
    assert.notEqual(sourceClientsDigest(buildSourceClientsRoster({ ...roster, rows: changed.rows })), before);
  } finally { await f.close(); }
});

test("#152 A10-R03 SQLite long original JSON bytes are complete in every actual encoding", async t => {
  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      const original = '{ "padding" : "' + "a".repeat(70 * 1024) + '", "escaped" : "\\u0061" }';
      seed(f.db, { host_identity_json: original });
      assert.deepEqual((await f.adapter.observeSourceClients()).rows[0]!.host_identity_json, ["text", bytes(original, encoding)]);
    } finally { await f.close(); }
  });
});

test("#152 A10-R02 SQLite rejects actual invalid native values without leaking source content", async t => {
  for (const [name, update] of [
    ["integer as text", "registered_epoch='secret-invalid-integer'"], ["integer as real", "registered_epoch=1.5"],
    ["text as blob", "build_id=x'736563726574'"], ["NULL primary ID", "client_id=NULL"],
    ["negative integer", "registered_epoch=-1"], ["overflow becomes REAL", "registered_epoch=9223372036854775808"],
    ["wrong protocol", "protocol_version=2"],
  ]) await t.test(name!, async () => {
    const f = await fixture();
    try {
      seed(f.db); f.db.pragma("ignore_check_constraints=ON"); f.db.exec(`UPDATE storage_source_clients SET ${update}`);
      await assert.rejects(f.adapter.observeSourceClients(), error => String(error) === "MaintenanceFailure: storage_maintenance: snapshot_invalid (source-clients)");
    } finally { await f.close(); }
  });
});

test("#152 A10-R05 SQLite rejects catalog changes before projecting rows", async t => {
  for (const sql of ["ALTER TABLE storage_source_clients ADD COLUMN extra TEXT",
    "ALTER TABLE storage_source_clients DROP COLUMN build_id",
    "ALTER TABLE storage_source_clients ADD COLUMN extra TEXT GENERATED ALWAYS AS (client_id) VIRTUAL"]) await t.test(sql, async () => {
    const f = await fixture();
    try { f.db.exec(sql); await assert.rejects(f.adapter.observeSourceClients(), /schema_guard_incomplete/); }
    finally { await f.close(); }
  });
});

test("#152 A10-R07 SQLite actual unreadable source fails at its platform preflight before raw state/rows", async t => {
  const f = await fixture(), prepare = Database.prototype.prepare;
  const mode = (await stat(f.file)).mode & 0o777;
  let stateReads = 0, rawReads = 0, darwinChecks = 0;
  try {
    t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
      if (this.name === f.file && this !== f.db) {
        if (sql === "SELECT * FROM storage_maintenance") stateReads++;
        if (sql.endsWith("FROM main.storage_source_clients")) rawReads++;
        if (sql === "SELECT boardroom_maintenance_source_unchanged() AS unchanged") darwinChecks++;
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    await chmod(f.file, 0);
    // Darwin's fixed native handle inventory cannot observe the unreadable source;
    // Linux reaches the failed readonly database open. Neither entered the raw read.
    await assert.rejects(f.adapter.observeSourceClients(), { code: process.platform === "darwin" ? "source_writer_unknown" : "snapshot_invalid" });
    assert.equal(stateReads, 0); assert.equal(rawReads, 0); assert.equal(darwinChecks, 0);
  } finally { t.mock.restoreAll(); await chmod(f.file, mode); await f.close(); }
});

test("#152 A10-R07 SQLite owned close rejection blocks success after the real handle is closed", async t => {
  const f = await fixture(); const original = Database.prototype.close;
  try {
    const close = t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      const result = Reflect.apply(original, this, []);
      if (this.name === f.file && this !== f.db) throw new Error("private-close-canary");
      return result;
    });
    await assert.rejects(f.adapter.observeSourceClients(), error => /snapshot_invalid/.test(String(error)) && !String(error).includes("canary"));
    close.mock.restore();
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("#152 A10-R08 SQLite lost real mutex rejects a retained SourceLock method", async () => {
  const f = await fixture(); let mutex;
  try {
    const raw = await f.adapter.observeSourceClients(); const store = await ArtifactStore.create(join(f.directory, "control"), raw.source);
    mutex = await f.adapter.acquireMutex(store.identity, raw.state);
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      assert.deepEqual((await lock.observeSourceClients()).rows, []);
      await mutex!.release();
      await assert.rejects(lock.observeSourceClients(), /maintenance_lost/);
    }), /maintenance_lost/);
  } finally { await mutex?.release(); await f.close(); }
});

test("#152 A10-R07 SQLite an existing exclusive lock preserves platform preflight refusal before raw state", async t => {
  const f = await fixture(), prepare = Database.prototype.prepare, pragma = Database.prototype.pragma, loadExtension = Database.prototype.loadExtension;
  let stateReads = 0, schemaReads = 0, bindLoads = 0;
  try {
    t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
      if (this.name === f.file && this !== f.db) {
        if (sql === "SELECT * FROM storage_maintenance") stateReads++;
      }
      return Reflect.apply(prepare, this, [sql]);
    });
    t.mock.method(Database.prototype, "pragma", function(this: Database.Database, ...args: unknown[]) {
      if (this.name === f.file && this !== f.db && args[0] === "schema_version") schemaReads++;
      return Reflect.apply(pragma, this, args);
    });
    t.mock.method(Database.prototype, "loadExtension", function(this: Database.Database, ...args: unknown[]) {
      if (this.name === f.file && this !== f.db) bindLoads++;
      return Reflect.apply(loadExtension, this, args);
    });
    f.db.pragma("journal_mode=DELETE"); f.db.exec("BEGIN EXCLUSIVE");
    try {
      // Darwin's unchanged bind/loadExtension source guard refuses this locked source
      // before schema_version; Linux reports BUSY while opening the schema view.
      await assert.rejects(f.adapter.observeSourceClients(), { code: process.platform === "darwin" ? "source_changed" : "maintenance_busy" });
      assert.equal(stateReads, 0); assert.equal(bindLoads, process.platform === "darwin" ? 1 : 0);
      assert.equal(schemaReads, process.platform === "darwin" ? 0 : 1);
    }
    finally { f.db.exec("ROLLBACK"); }
    t.mock.restoreAll();
    await rename(f.file, f.file + ".moved");
    try { await assert.rejects(f.adapter.observeSourceClients(), /source_changed/); }
    finally { await rename(f.file + ".moved", f.file); }
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("#152 R-152-SCA10-REQ-001 real lock acquired after open still reports busy at the first state read", async t => {
  const f = await fixture(), prepare = Database.prototype.prepare;
  try {
    f.db.pragma("journal_mode=DELETE");
    for (const entry of ["raw", "legacy"] as const) {
      let acquired = false;
      const hook = t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
        if (this.name === f.file && this !== f.db && sql === "SELECT * FROM storage_maintenance" && !acquired) {
          f.db.exec("BEGIN EXCLUSIVE"); acquired = f.db.inTransaction;
        }
        return Reflect.apply(prepare, this, [sql]);
      });
      try {
        await assert.rejects(entry === "raw" ? f.adapter.observeSourceClients() : f.adapter.observe(), error => entry === "raw"
          ? (error as { code?: string }).code === "maintenance_busy"
          : (error as { reason?: string }).reason === "metadata_invalid");
        assert.equal(acquired, true, "第二个真实 handle 在 adapter 打开/schema_version 后成功持有 EXCLUSIVE");
      } finally { hook.mock.restore(); if (f.db.inTransaction) f.db.exec("ROLLBACK"); }
    }
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, []);
  } finally { t.mock.restoreAll(); if (f.db.inTransaction) f.db.exec("ROLLBACK"); await f.close(); }
});

test("#152 A10-R07 raw state validation separates malformed schema from native read errors", async t => {
  for (const sql of ["DELETE FROM storage_maintenance", "DROP TABLE storage_maintenance"]) await t.test(sql, async () => {
    const f = await fixture();
    try { f.db.exec(sql); await assert.rejects(f.adapter.observeSourceClients(), /schema_guard_incomplete/); }
    finally { await f.close(); }
  });
  for (const code of ["SQLITE_LOCKED", "SQLITE_IOERR_READ"]) await t.test(`synthetic ${code}`, async child => {
    const f = await fixture(), prepare = Database.prototype.prepare;
    try {
      child.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
        if (this.name === f.file && this !== f.db && sql === "SELECT * FROM storage_maintenance")
          throw Object.assign(new Error("private-state-read-canary"), { code });
        return Reflect.apply(prepare, this, [sql]);
      });
      await assert.rejects(f.adapter.observeSourceClients(), error =>
        (error as { code?: string }).code === (code === "SQLITE_LOCKED" ? "maintenance_busy" : "snapshot_invalid")
        && !String(error).includes("canary"));
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

test("#152 A10-R08 SQLite read view preserves count and raw cells across an actual second-handle commit", async t => {
  const f = await fixture(); const original = Database.prototype.prepare;
  try {
    const first = seed(f.db); let interleaved = false;
    t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
      const statement = Reflect.apply(original, this, [sql]);
      if (this.name === f.file && this !== f.db && sql === "SELECT count(*) FROM main.storage_source_clients") {
        const get = statement.get;
        t.mock.method(statement, "get", function(this: Database.Statement, ...args: unknown[]) {
          const count = Reflect.apply(get, this, args);
          if (!interleaved) {
            interleaved = true; f.db.exec("UPDATE storage_source_clients SET build_id='later-view'");
            seed(f.db, { client_id: "later-row" });
          }
          return count;
        });
      }
      return statement;
    });
    const raw = await f.adapter.observeSourceClients(); assert.equal(interleaved, true);
    assert.deepEqual(raw.rows, [expected(first, "UTF-8")]);
    t.mock.restoreAll(); assert.equal((await f.adapter.observeSourceClients()).rows.length, 2);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test("#152 A10-R08 SQLite sealed snapshot uses the original lock lifetime and rejects a retained capability", async () => {
  const f = await fixture(); let mutex;
  try {
    seed(f.db); const first = await f.adapter.observeSourceClients();
    const store = await ArtifactStore.create(join(f.directory, "control"), first.source);
    mutex = await f.adapter.acquireMutex(store.identity, first.state);
    // Native CAS fixture setup only; these references are not a journal/capture proof.
    for (const admission of ["draining", "sealed"] as const) await f.adapter.withSourceLock("control", async lock => {
      const raw = await lock.observeSourceClients();
      await lock.anchor({ expected: raw.state, admission, fenceEpoch: 1, ownerGeneration: 1,
        activeMigrationId: "raw-lock-fixture", planDigest: "a".repeat(64), controlRootIdentity: { ...store.identity },
        mutexIdentity: mutex!.identity, journal: { ref: `fixture-${admission}`, sha256: "b".repeat(64), bytes: "1" },
        journalSequence: admission === "draining" ? 1 : 2 });
    });
    const before = await f.adapter.observe(); let retained: (() => ReturnType<typeof f.adapter.observeSourceClients>) | undefined;
    await f.adapter.withSourceLock("snapshot", async lock => {
      retained = () => lock.observeSourceClients();
      assert.equal((await lock.observeSourceClients()).state.admission, "sealed");
      assert.throws(() => f.db.exec("UPDATE storage_source_clients SET build_id='blocked'"), { code: "SQLITE_BUSY" });
      await lock.assertHeld(); assert.deepEqual(await lock.observe(), before);
    });
    await assert.rejects(retained!(), /maintenance_lost/);
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await mutex?.release(); await f.close(); }
});

test("#152 A10-R05/R06/R07 SQLite private transport faults never turn into partial or empty success", async t => {
  for (const mode of ["short-row", "bad-hex", "wrong-length", "wrong-count", "duplicate-id", "read-error", "wrong-encoding", "unknown-encoding"]) await t.test(mode, async t => {
    const f = await fixture(); const prepare = Database.prototype.prepare, pragma = Database.prototype.pragma;
    try {
      seed(f.db); seed(f.db, { client_id: "other-id" });
      let encodingReads = 0;
      t.mock.method(Database.prototype, "pragma", function(this: Database.Database, ...args: unknown[]) {
        const result = Reflect.apply(pragma, this, args);
        if (this.name === f.file && this !== f.db && args[0] === "main.encoding" && encodingReads++ === 0) {
          if (mode === "wrong-encoding") return "UTF-16le";
          if (mode === "unknown-encoding") return "unknown-native-encoding";
        }
        return result;
      });
      t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
        const statement = Reflect.apply(prepare, this, [sql]);
        if (this.name !== f.file || this === f.db) return statement;
        if (sql === "SELECT count(*) FROM main.storage_source_clients" && mode === "wrong-count") t.mock.method(statement, "get", () => 3n);
        if (sql.includes("hex(CAST(") && sql.endsWith("FROM main.storage_source_clients")) {
          const all = statement.all;
          t.mock.method(statement, "all", function(this: Database.Statement, ...args: unknown[]) {
            const rows = Reflect.apply(all, this, args) as unknown[][];
            if (mode === "read-error") throw new Error("private-row-secret-canary");
            if (mode === "short-row") rows[0]!.pop();
            if (mode === "bad-hex") rows[0]![1] = "0";
            if (mode === "wrong-length") rows[0]![2] = 0n;
            if (mode === "duplicate-id") { rows[1]![1] = rows[0]![1]; rows[1]![2] = rows[0]![2]; }
            return rows;
          });
        }
        return statement;
      });
      const code = mode === "wrong-count" || mode === "wrong-encoding" ? "source_changed"
        : mode === "unknown-encoding" ? "schema_guard_incomplete" : "snapshot_invalid";
      await assert.rejects(f.adapter.observeSourceClients(), error => String(error).includes(code) && !String(error).includes("canary"));
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

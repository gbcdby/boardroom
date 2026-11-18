import test, { before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import type { QueryResult } from "pg";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { checksumOf, migrationSql, MigrationError } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { recoveryFixture } from "./fixtures/maintenance-capture-recovery.ts";
import { errorLeaves, rejected } from "./fixtures/maintenance-backup-lifecycle.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { captureSnapshotMaintenance } from "../src/server/storage/maintenance/capture.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

const supported = process.platform === "linux" && !!process.env.AGENT_STUDIO_PG_TEST_URL;
const nativeTest = supported ? test : test.skip;
before(() => {
  if (!supported) return;
  const build = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);
});

nativeTest("#152 C2 postgres: real commits are externally visible before the next source lock and dump", async () => {
  const f = await recoveryFixture("postgres", { sessions: true, initialGeneration: 3 });
  try {
    const committed: Record<string, unknown>[] = [], beforeCommit: Record<string, unknown>[] = [];
    let backups = 0, backupCompleted = false;
    f.recovery.onLock = (lock, _stage, kind) => {
      if (kind === "control") {
        const anchor = lock.anchor;
        lock.anchor = async change => {
          const before = await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance");
          await anchor(change);
          const independent = await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance");
          assert.deepEqual(independent, before, "an independent session cannot see uncommitted CAS state");
          beforeCommit.push(independent[0]!);
        };
      } else {
        const backup = lock.backup;
        lock.backup = async destination => {
          await lock.assertHeld(); backups++;
          const actual = await backup(destination);
          assert.equal((await readFile(destination)).subarray(0, 5).toString(), "PGDMP");
          await lock.assertHeld(); backupCompleted = true; return actual;
        };
      }
    };
    f.recovery.afterSourceClose = async () => {
      committed.push((await f.query("SELECT admission,owner_generation,journal_sequence,journal_digest FROM storage_maintenance"))[0]!);
    };
    const result = await f.captureSnapshot(f.options, f.request);
    assert.equal("kind" in result && result.kind, "unverified-bundle");
    if (!("kind" in result) || result.kind !== "unverified-bundle") throw new Error("unverified bundle required");
    assert.deepEqual(committed.map(row => [row.admission, String(row.owner_generation), String(row.journal_sequence)]),
      [["sealed", "4", "2"], ["sealed", "5", "3"], ["sealed", "5", "4"], ["sealed", "5", "4"]]);
    assert.deepEqual(beforeCommit.map(row => [row.admission, String(row.owner_generation), String(row.journal_sequence)]),
      [["draining", "4", "1"], ["sealed", "4", "2"], ["sealed", "5", "3"]]);
    assert.equal(backups, 1); assert.equal(backupCompleted, true);
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const closure = await verifyRestoreBundleClosure(store, result.bundle, result.publication);
    assert.deepEqual(closure.chain.nodes.map(n => n.record.event), ["enter", "capture", "takeover", "capture"]);
    assert.deepEqual(closure.bundle.capture, result.ref);
    assert.equal(closure.manifests.controlRows.storage_maintenance[0]!.journal_digest, result.ref.journal.sha256);
    assert.equal(f.events.filter(e => e.event === "owner").length, 1);
    assert.equal(f.events.at(-1)!.event, "adapter-close-end");
    assert.deepEqual(Object.keys(result).sort(), ["kind", "ref", "bundle", "publication"].sort());
    delete f.recovery.onLock; delete f.recovery.afterSourceClose;
    assert.deepEqual(await f.captureSnapshot(f.options, f.request), { kind: "anchored-progress", reached: "recapture", ref: result.ref });
  } finally { await f.close(); }
});

nativeTest("#152 C2 postgres: interrupted first T and Q prefixes are fresh read-only progress", async t => {
  for (const stopped of [1, 2, 3] as const) await t.test("after commit " + stopped, async child => {
    const f = await recoveryFixture("postgres"), failure = new MaintenanceFailure("maintenance_lost", "C2 response loss");
    try {
      f.recovery.afterSourceClose = stage => { if (stage === stopped) throw failure; };
      await assert.rejects(f.captureSnapshot(f.options, f.request), error => error === failure);
      delete f.recovery.afterSourceClose;
      const current = await f.observe(), names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      child.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("replay cannot publish"); });
      f.state.events.length = 0;
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.reached, stopped === 1 ? "first-capture" : stopped === 2 ? "takeover" : "recapture");
      assert.equal(replay.ref.ownerGeneration, current.state.ownerGeneration);
      assert.equal(replay.ref.journal.sha256, current.state.journalDigest);
      assert.deepEqual(await f.observe(), current); assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), names);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 postgres: real dump read failure keeps literal undefined before safeError and its independent undefined close", async t => {
  const f = await recoveryFixture("postgres"), open = fs.promises.open;
  let reads = 0, closes = 0, oldOwner: ControllerOwner | undefined;
  try {
    f.recovery.onOwner = owner => { oldOwner = owner; };
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      const handle = await Reflect.apply(open, fs.promises, args);
      if (typeof args[0] === "string" && args[0].startsWith(f.reference.controlRoot + path.sep)
        && args[0].endsWith(path.sep + "database.dump")) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: unknown[]) => { await Reflect.apply(read, handle, values); reads++; throw undefined; }) as typeof handle.read;
        handle.close = async () => { closes++; await close(); throw undefined; };
      }
      return handle;
    }); syncBuiltinESMExports();
    const outcome = await rejected(f.captureSnapshot(f.options, f.request));
    assert.equal(outcome.failed, true); assert(reads > 0); assert.equal(closes, 1);
    const errors = errorLeaves(outcome.error); assert.strictEqual(errors[0], undefined);
    assert.equal(errors.filter(value => value === undefined).length, 2, "body and physical close are distinct failed events");
    assert(oldOwner); assert.equal(oldOwner.adapterClosed, false);
    const current = await f.observe(); assert.equal(current.state.journalSequence, 4); assert.equal(current.state.admission, "sealed");
    t.mock.restoreAll(); syncBuiltinESMExports(); delete f.recovery.onOwner;
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress");
    assert.equal(oldOwner.adapterClosed, true, "new entry first retires the same original D owner");
    assert.equal(f.events.filter(event => event.owner === oldOwner && event.event === "adapter-close-begin").length, 2);
    assert.deepEqual((await f.observe()).state, current.state);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

nativeTest("#152 C2 postgres: lost actual advisory mutex never grants overlap with the active T source transaction", async t => {
  const f = await recoveryFixture("postgres"), query = Client.prototype.query;
  let reached!: () => void, resume!: () => void;
  const reachedT = new Promise<void>(resolve => { reached = resolve; }), continueT = new Promise<void>(resolve => { resume = resolve; });
  let mutexClient: Client | undefined, held: OperationMutex | undefined;
  let running: ReturnType<typeof f.captureSnapshot> | undefined, other: Awaited<ReturnType<typeof f.createAdapter>> | undefined;
  let otherMutex: OperationMutex | undefined;
  try {
    t.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
      const result = await Reflect.apply(query, this, args) as QueryResult;
      const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
      if (!mutexClient && database === f.database && typeof args[0] === "string"
        && args[0].startsWith("SELECT pg_catalog.pg_try_advisory_lock") && result.rows[0]?.acquired === true) mutexClient = this;
      return result;
    } as typeof query);
    f.recovery.onOwner = owner => {
      const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
      owner.adapter.acquireMutex = async (...args) => held = await acquire(...args);
    };
    f.recovery.onLock = async (_lock, stage) => { if (stage === 2) { reached(); await continueT; } };
    running = f.captureSnapshot(f.options, f.request); void running.catch(() => {});
    await Promise.race([reachedT, running.then(() => { throw new Error("T transaction boundary missing"); })]);
    assert(held && mutexClient); await assert.rejects(held.release(), { code: "maintenance_busy" });
    await mutexClient.query("SELECT pg_catalog.pg_advisory_unlock_all()");
    const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    other = await f.createAdapter(); otherMutex = await other.acquireMutex(store.identity, (await other.observe()).state);
    let entered = false;
    await assert.rejects(other.withSourceLock("control", async () => { entered = true; }), { code: "maintenance_busy" });
    assert.equal(entered, false); await otherMutex.release(); otherMutex = undefined; await other.close(); other = undefined;
    resume(); await assert.rejects(running); running = undefined;
    assert.deepEqual((await f.observe()).state, before.state); assert.equal(before.state.journalSequence, 2);
    delete f.recovery.onLock; delete f.recovery.onOwner; t.mock.restoreAll();
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress" && replay.reached === "first-capture");
  } finally {
    resume(); await running?.catch(() => {}); t.mock.restoreAll();
    try { await otherMutex?.release(); } finally { await other?.close(); await f.close(); }
  }
});

for (const encoding of ["LATIN1", "SQL_ASCII"] as const) nativeTest(
  "#152 C2 postgres: actual " + encoding + " raw roster and native typed archive remain bound through all stages", async () => {
    const f = await recoveryFixture("postgres", { postgresEncoding: encoding });
    try {
      assert.equal((await f.query("SHOW server_encoding"))[0]!.server_encoding, encoding);
      assert.equal((await f.query("SHOW client_encoding"))[0]!.client_encoding, "UTF8", "fixture bootstrap encoding does not escape into a later source session");
      assert.deepEqual(await f.query("SELECT version::text AS version,name,checksum FROM schema_migrations ORDER BY schema_migrations.version"),
        migrations.map(migration => ({ version: String(migration.version), name: migration.name,
          checksum: checksumOf(migrationSql(migration, "postgres")) })), "the source retains every original migration and checksum");
      const before = await f.observe(), result = await f.captureSnapshot(f.options, f.request);
      assert("kind" in result && result.kind === "unverified-bundle");
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const closure = await verifyRestoreBundleClosure(store, result.bundle, result.publication);
      const captures = closure.chain.nodes.filter(node => node.record.event === "capture");
      assert.equal(captures.length, 2);
      for (const node of captures) {
        assert(node.record.formatVersion === 2 && node.record.sourceClients);
        assert.deepEqual(node.record.sourceClients.textEncoding, { backend: "postgres", name: encoding });
      }
      assert.deepEqual(captures[1]!.record.frozen, captures[0]!.record.frozen);
      assert.deepEqual(closure.manifests.controlRows.storage_source_clients, before.manifests.controlRows.storage_source_clients);
      assert.deepEqual((await f.observe()).clients, before.clients);
    } finally { await f.close(); }
  });

nativeTest("#152 C2 postgres: failed bootstrap preserves its first value and closes every owned session before rejecting", async t => {
  for (const mode of ["native-encoding-error", "error", "undefined"] as const) await t.test(mode, async t => {
    const migrate = PostgresDriver.prototype.migrate, connect = Client.prototype.connect;
    const owned = new Set<Client>(), ended = new Set<Client>();
    const original = mode === "error" ? new Error("controlled C2 bootstrap failure") : undefined;
    let observedFirst: unknown, firstOccurred = false, database: string | undefined;
    const ownedDirectories: string[] = [];
    try {
      t.mock.method(Client.prototype, "connect", function(this: Client, ...args: unknown[]) {
        owned.add(this); this.once("end", () => { ended.add(this); });
        return Reflect.apply(connect, this, args);
      } as typeof connect);
      t.mock.method(PostgresDriver.prototype, "migrate", async function(this: PostgresDriver, ...args: Parameters<typeof migrate>) {
        database = String((await this.query("SELECT current_database() AS database"))[0]!.database);
        assert.match(database, /^br_enter_[a-f0-9]{32}$/);
        try {
          // Real PostgreSQL repeats the original CI failure, without editing any
          // migration SQL. The other two branches distinguish Error/undefined.
          if (mode === "native-encoding-error") {
            await this.query("SET client_encoding='UTF8'");
            return await Reflect.apply(migrate, this, args);
          }
          throw original;
        } catch (error) { firstOccurred = true; observedFirst = error; throw error; }
      });
      const result = await rejected(recoveryFixture("postgres", { postgresEncoding: "LATIN1",
        onTemporaryDirectory: directory => { ownedDirectories.push(directory); } }));
      assert(firstOccurred && result.failed, "the intended real bootstrap boundary was reached");
      assert.equal(result.error, observedFirst, "cleanup must preserve the exact first thrown value");
      if (mode === "native-encoding-error") {
        assert(observedFirst instanceof MigrationError);
        assert.match(observedFirst.message, /LATIN1/);
      } else assert.equal(observedFirst, original);
      assert(owned.size >= 2, "actual administrator and bootstrap pool connections were opened");
      assert.deepEqual(ended, owned, "every original pg Client emitted end before the fixture rejected");
    } finally { t.mock.restoreAll(); }
    assert(database);
    const verifier = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL });
    verifier.on("error", () => {});
    try {
      await verifier.connect();
      assert.equal((await verifier.query("SELECT count(*)::text AS count FROM pg_database WHERE datname=$1", [database])).rows[0].count, "0");
      assert.equal((await verifier.query("SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1", [database])).rows[0].count, "0");
    } finally { await verifier.end(); }
    assert(ownedDirectories.length > 0, "this fixture must have acquired real temporary inputs");
    assert.equal(new Set(ownedDirectories).size, ownedDirectories.length);
    for (const directory of ownedDirectories) await assert.rejects(lstat(directory), { code: "ENOENT" },
      "each directory acquired by this invocation is removed on initialization failure");
  });
});

nativeTest("#152 C2 postgres: production empty registry rejects planned and sealed starts without D or successor Jq", async () => {
  const f = await recoveryFixture("postgres");
  try {
    const planned = await f.observe();
    await assert.rejects(captureSnapshotMaintenance(f.options, f.request), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), planned);
    const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
    if (first.status !== "paused") throw new Error("actual first capture required");
    const sealed = await f.observe();
    const request: ContinueRequest = { ...f.request, requestId: "production-successor", expectedPhase: "quiesced", expectedJournalDigest: first.ref.journal.sha256 };
    await assert.rejects(captureSnapshotMaintenance(f.options, request), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), sealed);
    assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 2);
    assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).filter(name =>
      /(^|\/)(database-snapshot\.bin|database\.sqlite|database\.dump|restore-bundle\.json|publication\.json|verification\.json|receipt\.json)$/.test(name)), []);
  } finally { await f.close(); }
});

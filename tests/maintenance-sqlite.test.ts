import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import filesystem from "node:fs/promises";
import { mkdtemp, rm, stat, copyFile, rename } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import type { SourceLock, AnchorChange, ArtifactRef } from "../src/server/storage/maintenance/types.ts";
import { recordDarwinInventoryFailure } from "./fixtures/maintenance-darwin-inventory-diagnostic.ts";
import { inspectWithLinuxInventoryDiagnostics } from "./fixtures/maintenance-linux-inventory-diagnostic.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
async function fixture() {
  const dir = await mkdtemp(path.join(process.cwd(), "br-native-maintenance-"));
  const file = path.join(dir, "agent-studio.db");
  const db = new Database(file);
  db.exec("CREATE TABLE extra_values(v)"); runMigrations(db, migrations); db.pragma("journal_mode=WAL"); db.close();
  const info = await stat(file, { bigint: true });
  const descriptor = { kind: "sqlite" as const, dataDir: dir, sourcePath: file, sqlitePath: file,
    identity: { device: String(info.dev), inode: String(info.ino) } };
  const adapter = await createSqliteMaintenanceAdapter(descriptor);
  const initial = await adapter.observe();
  const store = await ArtifactStore.create(path.join(dir, "control"), initial.source);
  return { dir, file, descriptor, adapter, store, initial, async close() { await adapter.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function enter(lock: SourceLock, store: ArtifactStore, mutexIdentity: AnchorChange["mutexIdentity"], sequence: number, previous: ArtifactRef | null) {
  const observed = await lock.observe();
  const phase = sequence === 1 ? "planned" : "quiesced";
  // Deliberately incomplete legacy-shaped bytes exercise only native anchor CAS, not the journal
  // reader or a source proof. Valid current v2 capture/closure fixtures live in maintenance-journal.
  const journal = await store.putJson("journal", { formatVersion: 1, kind: "journal", migrationId: "fixture", sequence, previous,
    phase, event: sequence === 1 ? "enter" : "capture", requestId: `request-${sequence}`, requestDigest: "d".repeat(64),
    source: observed.source, plan: { ref: `plans/${"a".repeat(64)}.json`, sha256: "a".repeat(64), bytes: "1" },
    fenceEpoch: 1, ownerGeneration: 1, evidence: [] });
  await lock.anchor({ expected: observed.state, admission: sequence === 1 ? "draining" : "sealed", fenceEpoch: 1,
    ownerGeneration: 1, activeMigrationId: "fixture", planDigest: "a".repeat(64),
    controlRootIdentity: store.identity as unknown as AnchorChange["controlRootIdentity"], mutexIdentity,
    journal, journalSequence: sequence });
  return journal;
}

platformTest("#152 source-bound SQLite operation mutex survives observer close and rejects a missing bound lock file", async () => {
  const f = await fixture(); const other = await createSqliteMaintenanceAdapter(f.descriptor);
  try {
    const mutex = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
    await assert.rejects(other.acquireMutex(f.store.identity, (await other.observe()).state), /maintenance_busy/);
    const second = await fixture();
    try { const lease = await second.adapter.acquireMutex(second.store.identity, second.initial.state); await lease.release(); }
    finally { await second.close(); }
    await mutex.release();
    const acquired = await other.acquireMutex(f.store.identity, (await other.observe()).state); await acquired.release();
    await rm(path.join(f.store.root, "mutex.sqlite"));
    await assert.rejects(f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state), /control_root_mismatch/);
    assert.equal((await f.adapter.observe()).state.admission, "open");
  } finally { await other.close(); await f.close(); }
});

platformTest("#152 native lock serializes all control CAS and backup captures committed WAL with exact restored typed values", async () => {
  const f = await fixture(); const writer = new Database(f.file); writer.pragma("busy_timeout=1");
  let mutex;
  try {
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.exec("INSERT INTO extra_values VALUES(9223372036854775807),(x'00ff'),(CAST(x'80' AS TEXT)),('same'),('same')");
    const bare = path.join(f.dir, "bare.db"); await copyFile(f.file, bare);
    const bareDb = new Database(bare, { readonly: true, fileMustExist: true });
    try { assert.equal((bareDb.prepare("SELECT count(*) AS n FROM extra_values").get() as { n: number }).n, 0); }
    finally { bareDb.close(); }
    mutex = await f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state);
    const planned = await f.adapter.withSourceLock("control", async lock => {
      assert.throws(() => writer.exec("UPDATE storage_maintenance SET owner_generation=99"), /locked/);
      return enter(lock, f.store, mutex!.identity, 1, null);
    });
    const capture = await f.adapter.withSourceLock("control", lock => enter(lock, f.store, mutex!.identity, 2, planned));
    assert.throws(() => writer.exec("INSERT INTO extra_values VALUES('late')"), /BOARDROOM_STORAGE_MAINTENANCE/);
    const attempt = await f.store.createAttempt(1);
    await f.adapter.withSourceLock("snapshot", async lock => {
      const result = await lock.backup(path.join(attempt, "backup.sqlite"));
      assert.equal(result.manifests.controlRows.storage_maintenance[0]!.journal_digest, capture.sha256);
      assert.equal(result.manifests.tables.find(t => t.name === "extra_values")!.count, "5");
      const artifact = await f.store.importDatabase(path.join(attempt, "backup.sqlite"));
      const verification = await f.adapter.verifyDatabase(f.store.pathFor(artifact), result.manifests, path.join(attempt, "restore"));
      assert.equal((verification as { kind: string }).kind, "sqlite-restore-verification");
      await assert.rejects(f.adapter.verifyDatabase(f.store.pathFor(artifact), { ...result.manifests, fullDataManifestDigest: "0".repeat(64) }, path.join(attempt, "bad-restore")), /snapshot_invalid/);
      await lock.assertHeld();
    });
    assert.equal((await f.adapter.observe()).state.admission, "sealed");
  } finally { await mutex?.release(); writer.close(); await f.close(); }
});

platformTest("#152 SQLite verification keeps its original pending source owner and refuses late admission", async t => {
  for (const ending of ["return", "throw-primary"] as const) await t.test(ending, async child => {
    const f = await fixture(), originalCopy = filesystem.copyFile, primary = new Error("original source callback");
    let mutex, release!: () => void, reached!: () => void, operation: Promise<unknown> | undefined, outer: Promise<void> | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let pendingFile = "", finished = false;
    try {
      mutex = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
      const planned = await f.adapter.withSourceLock("control", lock => enter(lock, f.store, mutex!.identity, 1, null));
      await f.adapter.withSourceLock("control", lock => enter(lock, f.store, mutex!.identity, 2, planned));
      const before = await f.adapter.observe(), attempt = await f.store.createAttempt(1), restore = path.join(attempt, "pending-restore");
      pendingFile = path.join(restore, "restored.sqlite");
      child.mock.method(filesystem, "copyFile", async (...args: Parameters<typeof originalCopy>) => {
        const result = await originalCopy(...args);
        if (args[1] === pendingFile) { reached(); await gate; throw undefined; }
        return result;
      });
      syncBuiltinESMExports();
      outer = f.adapter.withSourceLock("snapshot", async lock => {
        const archive = path.join(attempt, "backup.sqlite"), backup = await lock.backup(archive);
        operation = f.adapter.verifyDatabase(archive, backup.manifests, restore);
        void operation.catch(() => undefined);
        await entered;
        if (ending === "throw-primary") throw primary;
      });
      void outer.then(() => { finished = true; }, () => { finished = true; });
      await entered; await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(finished, false, "callback exit cannot retire its original in-flight verification");
      const external = new Database(f.file); external.pragma("busy_timeout=1");
      try { assert.throws(() => external.exec("BEGIN IMMEDIATE"), /locked/, "the original source transaction is still held"); }
      finally { external.close(); }
      await assert.rejects(f.adapter.verifyDatabase("late", before.manifests, path.join(attempt, "late")), { code: "maintenance_lost" });
      release();
      await assert.rejects(operation!, error => { assert.equal(error, undefined); return true; });
      await assert.rejects(outer, error => { assert.equal(error, ending === "return" ? undefined : primary); return true; });
      assert.deepEqual(await f.adapter.observe(), before);
    } finally {
      release(); if (outer) await Promise.allSettled([outer]);
      child.mock.restoreAll(); syncBuiltinESMExports(); await mutex?.release(); await f.close();
    }
  });
});

platformTest("#152 SQLite handled verification cleanup failure stays sticky after the actual target close", async t => {
  const f = await fixture(), close = Database.prototype.close;
  let mutex, restored = "", closed = 0;
  try {
    mutex = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
    const planned = await f.adapter.withSourceLock("control", lock => enter(lock, f.store, mutex!.identity, 1, null));
    await f.adapter.withSourceLock("control", lock => enter(lock, f.store, mutex!.identity, 2, planned));
    const before = await f.adapter.observe(), attempt = await f.store.createAttempt(1), restore = path.join(attempt, "restore");
    restored = path.join(restore, "restored.sqlite");
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      const owned = this.name === restored, result = close.call(this);
      if (owned) { assert.equal(this.open, false); closed++; throw undefined; }
      return result;
    });
    await assert.rejects(f.adapter.withSourceLock("snapshot", async lock => {
      const archive = path.join(attempt, "backup.sqlite"), backup = await lock.backup(archive);
      await assert.rejects(f.adapter.verifyDatabase(archive, backup.manifests, restore), error => {
        assert.equal(error, undefined); return true;
      });
      assert.equal(closed, 1, "the original native close really completed before its response failed");
    }), error => { assert.equal(error, undefined); return true; });
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { t.mock.restoreAll(); await mutex?.release(); await f.close(); }
});

platformTest("#152 unknown source file users stay blockers; renamed source never opens a replacement empty DB", async () => {
  const f = await fixture();
  const external = new Database(f.file);
  try {
    const blockers = await f.adapter.inspectWriters(await f.adapter.observe());
    assert.ok(blockers.some(b => b.code === "source_writer_unknown"));
    external.close();
    const afterCloseObservation = await f.adapter.observe();
    const afterClose = await inspectWithLinuxInventoryDiagnostics("after-external-close", f.descriptor,
      () => f.adapter.inspectWriters(afterCloseObservation));
    await recordDarwinInventoryFailure("after-external-close", f.descriptor, afterClose);
    assert.deepEqual(afterClose, []);
    await rename(f.file, `${f.file}.moved`);
    await assert.rejects(f.adapter.observe(), /source_changed/);
    await assert.rejects(stat(f.file), { code: "ENOENT" });
  } finally { if (external.open) external.close(); await f.close(); }
});

platformTest("#152 repeated native readers under a held source lock preserve exact ownership when SQLite reuses FDs", async () => {
  const f = await fixture();
  try {
    const mutex = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
    await f.adapter.withSourceLock("control", async lock => {
      for (let i = 0; i < 4; i++) {
        assert.deepEqual((await f.adapter.observe()).source, f.initial.source);
        const observed = await lock.observe();
        const blockers = await inspectWithLinuxInventoryDiagnostics("held-source-lock", f.descriptor,
          () => f.adapter.inspectWriters(observed));
        await recordDarwinInventoryFailure("held-source-lock", f.descriptor, blockers);
        assert.deepEqual(blockers, []);
        await lock.assertHeld();
      }
    });
    await mutex.release();
  } finally { await f.close(); }
});

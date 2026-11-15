import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, stat, access } from "node:fs/promises";
import path from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { AnchorChange, ArtifactRef, SourceLock } from "../src/server/storage/maintenance/types.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;

async function fixture() {
  const directory = await mkdtemp(path.join(process.cwd(), "br-verification-lifecycle-"));
  const file = path.join(directory, "agent-studio.db");
  const database = new Database(file);
  database.exec("CREATE TABLE verification_values(value)"); runMigrations(database, migrations);
  database.exec("INSERT INTO verification_values VALUES (NULL), (42), (X'00FF'), ('restored')");
  database.pragma("journal_mode=WAL"); database.close();
  const info = await stat(file, { bigint: true });
  const adapter = await createSqliteMaintenanceAdapter({ kind: "sqlite", dataDir: directory, sourcePath: file,
    sqlitePath: file, identity: { device: String(info.dev), inode: String(info.ino) } });
  const initial = await adapter.observe();
  const store = await ArtifactStore.create(path.join(directory, "control"), initial.source);
  const mutex = await adapter.acquireMutex(store.identity, initial.state);
  async function anchor(lock: SourceLock, sequence: number, previous: ArtifactRef | null) {
    const observed = await lock.observe();
    // Only a native anchor/backup fixture. These records are not claimed to be a valid
    // capture proof; complete B/U/V closure is covered by maintenance-verify-bundle.
    const journal = await store.putJson("journal", { formatVersion: 1, kind: "journal", migrationId: "verification-lifecycle", sequence, previous });
    await lock.anchor({ expected: observed.state, admission: sequence === 1 ? "draining" : "sealed", fenceEpoch: 1,
      ownerGeneration: 1, activeMigrationId: "verification-lifecycle", planDigest: "a".repeat(64),
      controlRootIdentity: store.identity as unknown as AnchorChange["controlRootIdentity"], mutexIdentity: mutex.identity,
      journal, journalSequence: sequence });
    return journal;
  }
  const planned = await adapter.withSourceLock("control", lock => anchor(lock, 1, null));
  await adapter.withSourceLock("control", lock => anchor(lock, 2, planned));
  const attempt = await store.createAttempt(1);
  return { directory, adapter, mutex, attempt, async close() {
    await mutex.release(); await adapter.close(); await rm(directory, { recursive: true, force: true });
  } };
}

function first(error: unknown): unknown { return error instanceof AggregateError ? error.errors[0] : error; }
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  let failed = false, error: unknown;
  try { await operation; } catch (caught) { failed = true; error = caught; }
  assert.equal(failed, true); return error;
}

platformTest("SQLite verification: real restored bytes succeed only after target close", async t => {
  const f = await fixture(); const close = Database.prototype.close;
  let restored: Database.Database | undefined, closes = 0;
  try {
    await f.adapter.withSourceLock("snapshot", async lock => {
      const file = path.join(f.attempt, "backup.sqlite"), backup = await lock.backup(file);
      t.mock.method(Database.prototype, "close", function(this: Database.Database) {
        if (this.name.endsWith("/restored.sqlite")) { restored = this; closes++; }
        return close.call(this);
      });
      const result = await f.adapter.verifyDatabase(file, backup.manifests, path.join(f.attempt, "restore"));
      assert.equal((result as { kind: string }).kind, "sqlite-restore-verification");
      assert.equal(closes, 1); assert.equal(restored?.open, false);
      const reader = new Database(path.join(f.attempt, "restore", "restored.sqlite"), { readonly: true });
      try { assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM verification_values").get() as { n: number }).n, 4); }
      finally { reader.close(); }
    });
  } finally { t.mock.restoreAll(); await f.close(); }
});

platformTest("SQLite verification: rollback failure preserves primary and still closes the real target", async t => {
  const f = await fixture(); const exec = Database.prototype.exec, close = Database.prototype.close;
  const rollback = Object.freeze(new Error("verification-rollback"));
  let restored: Database.Database | undefined, closes = 0;
  try {
    await f.adapter.withSourceLock("snapshot", async lock => {
      const file = path.join(f.attempt, "backup.sqlite"), backup = await lock.backup(file);
      t.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
        if (this.name.endsWith("/restored.sqlite") && sql === "ROLLBACK") { restored = this; throw rollback; }
        return exec.call(this, sql);
      });
      t.mock.method(Database.prototype, "close", function(this: Database.Database) {
        if (this.name.endsWith("/restored.sqlite")) { restored = this; closes++; }
        return close.call(this);
      });
      const error = await rejection(f.adapter.verifyDatabase(file, { ...backup.manifests, fullDataManifestDigest: "0".repeat(64) }, path.join(f.attempt, "restore")));
      assert(error instanceof AggregateError); assert.equal(error.errors.length, 2);
      assert(first(error) instanceof MaintenanceFailure); assert.equal((first(error) as MaintenanceFailure).code, "snapshot_invalid");
      assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], rollback);
      assert.equal(closes, 1); assert.equal(restored?.open, false);
    });
  } finally {
    t.mock.restoreAll(); if (restored?.open) close.call(restored); await f.close();
  }
});

for (const timing of ["before", "after"] as const) for (const undefinedError of [false, true]) {
  platformTest(`SQLite verification: close-${timing} ${undefinedError ? "undefined" : "frozen error"} retains exact failure and owner`, async t => {
    const f = await fixture(); const close = Database.prototype.close;
    const injected = undefinedError ? undefined : Object.freeze(new Error(`verification-close-${timing}`));
    let restored: Database.Database | undefined, calls = 0;
    try {
      await f.adapter.withSourceLock("snapshot", async lock => {
        const file = path.join(f.attempt, "backup.sqlite"), backup = await lock.backup(file);
        t.mock.method(Database.prototype, "close", function(this: Database.Database) {
          if (this.name.endsWith("/restored.sqlite")) {
            restored = this; calls++; if (timing === "after") close.call(this); throw injected;
          }
          return close.call(this);
        });
        assert.equal(await rejection(f.adapter.verifyDatabase(file, backup.manifests, path.join(f.attempt, "restore"))), injected);
        assert.equal(calls, 1); assert.equal(restored?.open, timing === "before");
        if (timing === "before") {
          const next = path.join(f.attempt, "must-not-create");
          const blocked = await rejection(f.adapter.verifyDatabase(file, backup.manifests, next));
          assert(blocked instanceof MaintenanceFailure); assert.equal(blocked.code, "maintenance_lost");
          await assert.rejects(access(next), { code: "ENOENT" }); assert.equal(calls, 1);
        }
        t.mock.restoreAll();
      });
      await f.mutex.release(); await f.adapter.close();
      assert.equal(restored?.open, false); assert.equal(calls, 1);
    } finally { t.mock.restoreAll(); if (restored?.open) close.call(restored); await f.close(); }
  });
}

platformTest("SQLite verification: three failures keep ordering and explicit cleanup retains the owned DB", async t => {
  const f = await fixture(); const exec = Database.prototype.exec, close = Database.prototype.close;
  const closeError = Object.freeze(new Error("verification-close"));
  let restored: Database.Database | undefined;
  try {
    await f.adapter.withSourceLock("snapshot", async lock => {
      const file = path.join(f.attempt, "backup.sqlite"), backup = await lock.backup(file);
      t.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
        if (this.name.endsWith("/restored.sqlite") && sql === "ROLLBACK") { restored = this; throw undefined; }
        return exec.call(this, sql);
      });
      t.mock.method(Database.prototype, "close", function(this: Database.Database) {
        if (this.name.endsWith("/restored.sqlite")) { restored = this; throw closeError; }
        return close.call(this);
      });
      const error = await rejection(f.adapter.verifyDatabase(file, { ...backup.manifests, fullDataManifestDigest: "0".repeat(64) }, path.join(f.attempt, "restore")));
      assert(error instanceof AggregateError); assert.equal(error.errors.length, 3);
      assert.equal((error.errors[0] as MaintenanceFailure).code, "snapshot_invalid");
      assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], undefined); assert.equal(error.errors[2], closeError);
      assert.equal(restored?.open, true);
    });
    await f.mutex.release();
    const retry = await rejection(f.adapter.close());
    assert(retry instanceof AggregateError); assert.deepEqual(retry.errors, [undefined, closeError]); assert.equal(restored?.open, true);
    t.mock.restoreAll(); await f.adapter.close(); assert.equal(restored?.open, false);
    const check = new Database(path.join(f.attempt, "restore", "restored.sqlite"), { readonly: true });
    try { assert.equal((check.prepare("SELECT COUNT(*) AS n FROM verification_values").get() as { n: number }).n, 4); }
    finally { check.close(); }
  } finally { t.mock.restoreAll(); if (restored?.open) close.call(restored); await f.close(); }
});

for (const timing of ["before", "after"] as const) {
  platformTest(`SQLite backup: rollback and close-${timing} preserve primary and the actual reader owner`, async t => {
    const f = await fixture(), exec = Database.prototype.exec, close = Database.prototype.close;
    const primary = new MaintenanceFailure("snapshot_invalid", "backup-primary");
    const secondary = Object.freeze(new Error("backup-close"));
    let reader: Database.Database | undefined, closes = 0;
    try {
      await f.adapter.withSourceLock("snapshot", async lock => {
        t.mock.method(Database.prototype, "backup", function(this: Database.Database) { reader = this; throw primary; });
        t.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
          if (this === reader && sql === "ROLLBACK") throw undefined;
          return exec.call(this, sql);
        });
        t.mock.method(Database.prototype, "close", function(this: Database.Database) {
          if (this === reader) { closes++; if (timing === "after") close.call(this); throw secondary; }
          return close.call(this);
        });
        const error = await rejection(lock.backup(path.join(f.attempt, "failed-backup.sqlite")));
        assert(error instanceof AggregateError); assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, undefined, secondary]);
        assert.equal(closes, 1); assert.equal(reader?.open, timing === "before");
      });
      await f.mutex.release();
      if (timing === "before") {
        const error = await rejection(f.adapter.close());
        assert(error instanceof AggregateError); assert.deepEqual(error.errors, [undefined, secondary]);
        assert.equal(closes, 2); assert.equal(reader?.open, true);
      }
      t.mock.restoreAll(); await f.adapter.close(); assert.equal(reader?.open, false);
    } finally { t.mock.restoreAll(); if (reader?.open) close.call(reader); await f.close(); }
  });
}

platformTest("SQLite backup: throw undefined keeps the original safe failure and still closes once", async t => {
  const f = await fixture(), close = Database.prototype.close;
  let reader: Database.Database | undefined, closes = 0;
  try {
    await f.adapter.withSourceLock("snapshot", async lock => {
      t.mock.method(Database.prototype, "backup", function(this: Database.Database) { reader = this; throw undefined; });
      t.mock.method(Database.prototype, "close", function(this: Database.Database) { if (this === reader) closes++; return close.call(this); });
      const error = await rejection(lock.backup(path.join(f.attempt, "failed-backup.sqlite")));
      assert(error instanceof MaintenanceFailure); assert.equal(error.code, "snapshot_invalid");
      assert.equal(closes, 1); assert.equal(reader?.open, false);
    });
  } finally { t.mock.restoreAll(); await f.close(); }
});

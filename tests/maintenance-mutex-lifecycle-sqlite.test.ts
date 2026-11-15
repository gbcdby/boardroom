import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import fsPromises, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { createSqliteMaintenanceAdapter } from "../src/server/storage/maintenance/sqlite.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(process.cwd(), "br-mutex-lifecycle-")));
  const file = path.join(directory, "agent-studio.db"), db = new Database(file);
  try {
    db.exec("CREATE TABLE lifecycle_values(value TEXT NOT NULL); INSERT INTO lifecycle_values VALUES('original')");
    runMigrations(db, migrations); db.pragma("journal_mode=WAL");
  } finally { db.close(); }
  const info = await stat(file, { bigint: true });
  const descriptor = { kind: "sqlite" as const, dataDir: directory, sourcePath: file, sqlitePath: file,
    identity: { device: String(info.dev), inode: String(info.ino) } };
  const adapter = await createSqliteMaintenanceAdapter(descriptor), initial = await adapter.observe();
  const store = await ArtifactStore.create(path.join(directory, "control"), initial.source);
  return { directory, file, descriptor, adapter, store, initial,
    async close() { await adapter.close(); await rm(directory, { recursive: true }); } };
}

function businessValues(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare("SELECT value FROM lifecycle_values").all(); } finally { db.close(); }
}

test("#152 SQLite mutex release closes the real lock even when ROLLBACK dispatch fails", async t => {
  const f = await fixture(), lease = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
  const mutexPath = path.join(f.store.root, "mutex.sqlite"), exec = Database.prototype.exec;
  const primary = new MaintenanceFailure("maintenance_lost", "mutex-rollback");
  let owned: Database.Database | undefined, injected = false;
  try {
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (this.name === mutexPath && sql === "ROLLBACK") { owned = this; injected = true; throw primary; }
      return exec.call(this, sql);
    });
    await assert.rejects(lease.release(), error => error === primary);
    assert.equal(injected, true); assert.ok(owned);
    assert.equal(owned.open, false, "a rollback dispatch error cannot skip the real connection close");
    t.mock.restoreAll();
    const other = await createSqliteMaintenanceAdapter(f.descriptor);
    try {
      const next = await other.acquireMutex(f.store.identity, (await other.observe()).state);
      await next.assertHeld(); await next.release();
    } finally { await other.close(); }
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally {
    t.mock.restoreAll(); if (owned?.open) owned.close(); await f.close();
  }
});

test("#152 SQLite adapter closes its source descriptor despite a mutex cleanup failure", async t => {
  const f = await fixture(), lease = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
  const mutexPath = path.join(f.store.root, "mutex.sqlite"), exec = Database.prototype.exec, closeFd = fs.closeSync;
  const primary = new MaintenanceFailure("maintenance_lost", "mutex-rollback");
  let sourceFd: number | undefined;
  try {
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (this.name === mutexPath && sql === "ROLLBACK") throw primary;
      return exec.call(this, sql);
    });
    t.mock.method(fs, "closeSync", (fd: number) => {
      const info = fs.fstatSync(fd, { bigint: true });
      if (String(info.dev) === f.descriptor.identity.device && String(info.ino) === f.descriptor.identity.inode) sourceFd = fd;
      closeFd(fd);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.adapter.close(), error => error === primary);
    assert.notEqual(sourceFd, undefined, "failure in the first cleanup cannot skip the remaining owned descriptor");
    assert.throws(() => fs.fstatSync(sourceFd!), { code: "EBADF" });
    await assert.rejects(f.adapter.observe(), /maintenance_lost/);
    t.mock.restoreAll(); syncBuiltinESMExports(); await lease.release();
    const other = await createSqliteMaintenanceAdapter(f.descriptor);
    try { const next = await other.acquireMutex(f.store.identity, (await other.observe()).state); await next.release(); }
    finally { await other.close(); }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test("#152 SQLite reader keeps its first failure, cleanup facts and the unclosed connection owner", async t => {
  for (const first of ["error", "undefined"] as const) await t.test(first, async child => {
  const f = await fixture(), exec = Database.prototype.exec, close = Database.prototype.close;
  const primary = first === "undefined" ? undefined : new MaintenanceFailure("source_changed", "reader-first"), cleanup = new Error("reader-close");
  let owned: Database.Database | undefined, rejected = false, rejection: unknown;
  try {
    child.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (this.name === f.file && this.readonly && sql === "COMMIT") { owned = this; throw primary; }
      if (this === owned && sql === "ROLLBACK") throw undefined;
      return exec.call(this, sql);
    });
    child.mock.method(Database.prototype, "close", function (this: Database.Database) {
      if (this === owned) throw cleanup;
      return close.call(this);
    });
    try { await f.adapter.observe(); } catch (error) { rejected = true; rejection = error; }
    assert.equal(rejected, true); assert.ok(rejection instanceof AggregateError);
    assert.deepEqual(rejection.errors, [primary, undefined, cleanup]); assert.equal(rejection.cause, primary);
    assert.ok(owned); assert.equal(owned.open, true, "the injected close did not close the actual reader");
    child.mock.restoreAll(); await f.adapter.close();
    assert.equal(owned.open, false, "adapter teardown retains and closes a reader with uncertain completion");
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally { child.mock.restoreAll(); if (owned?.open) owned.close(); await f.close(); }
  });
});

test("#152 SQLite bind preserves its first COMMIT failure while rollback and close still run", async t => {
  const f = await fixture(), exec = Database.prototype.exec, close = Database.prototype.close;
  const primary = new MaintenanceFailure("source_changed", "bind-first"), cleanup = new Error("bind-close");
  let owned: Database.Database | undefined, rejected = false, rejection: unknown, rolledBack = false;
  try {
    t.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
      if (this.name === f.file && !this.readonly && sql === "COMMIT") { owned = this; throw primary; }
      if (this === owned && sql === "ROLLBACK") { rolledBack = true; throw undefined; }
      return exec.call(this, sql);
    });
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      const result = close.call(this); if (this === owned) throw cleanup; return result;
    });
    try { await f.adapter.acquireMutex(f.store.identity, f.initial.state); } catch (error) { rejected = true; rejection = error; }
    assert.equal(rejected, true); assert.ok(rejection instanceof AggregateError);
    assert.deepEqual(rejection.errors, [primary, undefined, cleanup]); assert.equal(rejection.cause, primary);
    assert.equal(rolledBack, true); assert.ok(owned); assert.equal(owned.open, false);
    t.mock.restoreAll();
    assert.deepEqual((await f.adapter.observe()).state, f.initial.state, "an independent connection sees no committed bind");
    const next = await f.adapter.acquireMutex(f.store.identity, f.initial.state); await next.release();
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally { t.mock.restoreAll(); if (owned?.open) owned.close(); await f.close(); }
});

test("#152 SQLite uncertain mutex close is rejected and can be cleaned by the same owner", async t => {
  for (const phase of ["before", "after"] as const) await t.test(phase, async child => {
    const f = await fixture(), lease = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
    const close = Database.prototype.close, mutexPath = path.join(f.store.root, "mutex.sqlite");
    const other = await createSqliteMaintenanceAdapter(f.descriptor);
    let owned: Database.Database | undefined, failed = false;
    try {
      child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        if (this.name === mutexPath) {
          owned = this; if (phase === "after") close.call(this); throw undefined;
        }
        return close.call(this);
      });
      try { await lease.release(); } catch (error) { failed = true; assert.equal(error, undefined); }
      assert.equal(failed, true); assert.ok(owned); assert.equal(owned.open, phase === "before");
      await assert.rejects(lease.assertHeld(), /maintenance_lost/);
      child.mock.restoreAll();
      if (phase === "before") await assert.rejects(f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state), /maintenance_busy/);
      await lease.release(); assert.equal(owned.open, false);
      const next = await other.acquireMutex(f.store.identity, (await other.observe()).state); await next.release();
    } finally { child.mock.restoreAll(); if (owned?.open) owned.close(); await other.close(); await f.close(); }
  });
});

test("#152 SQLite failed mutex initialization keeps both errors and owns the unclosed handle", async t => {
  for (const phase of ["schema", "lease"] as const) await t.test(phase, async child => {
    const f = await fixture(), exec = Database.prototype.exec, close = Database.prototype.close;
    const mutexPath = path.join(f.store.root, "mutex.sqlite"), primary = new MaintenanceFailure("source_changed", "mutex-initialization");
    const cleanup = new Error("initialization-close");
    let owned: Database.Database | undefined, failed = false, rejection: unknown;
    try {
      child.mock.method(Database.prototype, "exec", function (this: Database.Database, sql: string) {
        if (this.name === mutexPath && (phase === "schema" ? sql.startsWith("BEGIN IMMEDIATE; CREATE TABLE") : sql === "BEGIN IMMEDIATE")) {
          owned = this; throw primary;
        }
        return exec.call(this, sql);
      });
      child.mock.method(Database.prototype, "close", function (this: Database.Database) {
        if (this === owned) throw cleanup; return close.call(this);
      });
      try { await f.adapter.acquireMutex(f.store.identity, f.initial.state); } catch (error) { failed = true; rejection = error; }
      assert.equal(failed, true); assert.ok(rejection instanceof AggregateError);
      assert.deepEqual(rejection.errors, [primary, cleanup]); assert.equal(rejection.cause, primary);
      assert.ok(owned); assert.equal(owned.open, true);
      child.mock.restoreAll(); await f.adapter.close(); assert.equal(owned.open, false);
      assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
    } finally { child.mock.restoreAll(); if (owned?.open) owned.close(); await f.close(); }
  });
});

test("#152 SQLite bind retains an unconfirmed native file close for adapter teardown", async t => {
  const f = await fixture(), open = fsPromises.open, mutexPath = path.join(f.store.root, "mutex.sqlite");
  let owned: FileHandle | undefined, injected = false;
  try {
    t.mock.method(fsPromises, "open", async function (...args: Parameters<typeof open>) {
      const handle = await open(...args);
      if (args[0] === mutexPath && !injected) {
        owned = handle; injected = true;
        t.mock.method(handle, "close", async function () { throw undefined; });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.adapter.acquireMutex(f.store.identity, f.initial.state), error => {
      assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "snapshot_invalid"); return true;
    });
    assert.ok(owned); assert.notEqual(owned.fd, -1); fs.fstatSync(owned.fd);
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.adapter.close();
    assert.equal(owned.fd, -1, "the failed bind cannot orphan its native file handle");
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await owned?.close(); await f.close(); }
});

test("#152 SQLite adapter standalone descriptor failure never masquerades as successful close", async t => {
  for (const phase of ["before", "after"] as const) await t.test(phase, async child => {
    const f = await fixture(), close = fs.closeSync;
    let sourceFd: number | undefined, failed = false;
    try {
      child.mock.method(fs, "closeSync", (fd: number) => {
        const info = fs.fstatSync(fd, { bigint: true });
        if (String(info.dev) === f.descriptor.identity.device && String(info.ino) === f.descriptor.identity.inode) {
          sourceFd = fd; if (phase === "after") close(fd); throw undefined;
        }
        close(fd);
      });
      syncBuiltinESMExports();
      try { await f.adapter.close(); } catch (error) { failed = true; assert.equal(error, undefined); }
      assert.equal(failed, true); assert.notEqual(sourceFd, undefined);
      if (phase === "before") fs.fstatSync(sourceFd!); else assert.throws(() => fs.fstatSync(sourceFd!), { code: "EBADF" });
      await assert.rejects(f.adapter.observe(), /maintenance_lost/);
      child.mock.restoreAll(); syncBuiltinESMExports(); await f.adapter.close();
      assert.throws(() => fs.fstatSync(sourceFd!), { code: "EBADF" });
    } finally { child.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
});

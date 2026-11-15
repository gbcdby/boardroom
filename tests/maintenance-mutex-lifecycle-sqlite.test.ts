import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import fsPromises, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
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

test("#152 SQLite rejected constructor closes its just-opened source descriptor", async t => {
  const f = await fixture(), open = fs.openSync, fstat = fs.fstatSync, close = fs.closeSync;
  await f.adapter.close();
  let owned: number | undefined, injected = false, closeCalls = 0;
  try {
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args); if (args[0] === f.file) owned = fd; return fd;
    });
    t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
      if (args[0] === owned && !injected) { injected = true; throw Object.assign(new Error("private identity-read canary"), { code: "EIO" }); }
      return fstat(...args);
    });
    t.mock.method(fs, "closeSync", (fd: number) => { if (fd === owned) closeCalls++; close(fd); });
    syncBuiltinESMExports();
    await assert.rejects(createSqliteMaintenanceAdapter(f.descriptor), { code: "source_changed" });
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(injected, true); assert.notEqual(owned, undefined); assert.equal(closeCalls, 1);
    assert.throws(() => fstat(owned!), { code: "EBADF" });
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (owned !== undefined) { try { fstat(owned); close(owned); } catch {} }
    await f.close();
  }
});

test("#152 SQLite constructor cleanup preserves classification and never retries an unknown close", async t => {
  for (const phase of ["before", "after", "reused", "unknown-reused"] as const) await t.test(phase, async child => {
    const f = await fixture(), open = fs.openSync, fstat = fs.fstatSync, close = fs.closeSync;
    await f.adapter.close();
    const unrelated = path.join(f.directory, "other-fd-owner"); fs.writeFileSync(unrelated, "independent owner");
    const cleanup = phase === "before" ? undefined : new Error("controlled constructor close response");
    let owned: number | undefined, replacement: number | undefined, injected = false, closeCalls = 0;
    try {
      child.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args); if (args[0] === f.file) owned = fd; return fd;
      });
      child.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
        if (args[0] === owned && !injected) {
          injected = true;
          if (phase === "reused") return Object.assign(fstat(...args), { nlink: 2n });
          throw new Error("private constructor identity-read canary");
        }
        return fstat(...args);
      });
      child.mock.method(fs, "closeSync", (fd: number) => {
        if (fd !== owned) { close(fd); return; }
        closeCalls++;
        if (phase !== "before") close(fd);
        if (phase === "reused" || phase === "unknown-reused") {
          replacement = open(phase === "reused" ? f.file : unrelated, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          assert.equal(replacement, fd, "the native fd number now belongs to a different open description");
        }
        throw cleanup;
      });
      syncBuiltinESMExports();
      await assert.rejects(createSqliteMaintenanceAdapter(f.descriptor), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
        assert.ok(error.errors[0] instanceof MaintenanceFailure); assert.equal(error.errors[0].code, "source_changed");
        assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], cleanup);
        assert.equal(error.errors[0].message.includes("canary"), false); return true;
      });
      child.mock.restoreAll(); syncBuiltinESMExports();
      assert.equal(injected, true); assert.notEqual(owned, undefined); assert.equal(closeCalls, 1);
      if (phase === "after") {
        assert.throws(() => fstat(owned!), { code: "EBADF" });
        const recovered = await createSqliteMaintenanceAdapter(f.descriptor); await recovered.close();
      }
      else {
        await assert.rejects(createSqliteMaintenanceAdapter(f.descriptor), { code: "maintenance_lost" });
        const info = fstat(owned!, { bigint: true });
        assert.equal(String(info.dev), f.descriptor.identity.device);
        if (phase === "unknown-reused") assert.notEqual(String(info.ino), f.descriptor.identity.inode);
        else assert.equal(String(info.ino), f.descriptor.identity.inode);
      }
      assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
    } finally {
      child.mock.restoreAll(); syncBuiltinESMExports();
      // Only this fixture knows whether its injection preceded close or created a new owner.
      const remaining = phase === "before" ? owned : replacement;
      if (remaining !== undefined) { try { close(remaining); } catch {} }
      await f.close();
    }
  });
});

test("#152 SQLite failed initialization retains an unreachable caller handle's private owner", async t => {
  for (const phase of ["identity", "observation"] as const) await t.test(phase, async child => {
    const f = await fixture(), independent = await fixture(), open = fs.openSync, fstat = fs.fstatSync, close = fs.closeSync;
    const prepare = Database.prototype.prepare; await f.adapter.close();
    let owned: number | undefined, opened = 0, closeCalls = 0, injected = false, moved = false;
    const unexpected: Awaited<ReturnType<typeof createSqliteMaintenanceAdapter>>[] = [];
    const alias = path.join(f.directory, "renamed-source.db");
    try {
      child.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args); if (args[0] === f.file || args[0] === alias) { opened++; owned ??= fd; } return fd;
      });
      child.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
        if (phase === "identity" && args[0] === owned && !injected) { injected = true; throw new Error("private first identity read"); }
        return fstat(...args);
      });
      child.mock.method(Database.prototype, "prepare", function (this: Database.Database, sql: string) {
        if (phase === "observation" && this.name === f.file && this.readonly && sql === "SELECT * FROM storage_maintenance" && !injected) {
          injected = true; throw new MaintenanceFailure("source_changed", "initial-observation");
        }
        return prepare.call(this, sql);
      });
      child.mock.method(fs, "closeSync", (fd: number) => {
        if (fd === owned) { closeCalls++; throw undefined; } close(fd);
      });
      syncBuiltinESMExports();
      await assert.rejects(createSqliteMaintenanceAdapter(f.descriptor), error => {
        assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].code, phase === "identity" ? "source_changed" : "migration_incomplete");
        assert.equal(error.errors[1], undefined); return true;
      });
      assert.equal(injected, true); assert(opened >= 1); assert.equal(closeCalls, 1); fstat(owned!);
      const originalOpens = opened;
      const rejectedCreate = async (descriptor: typeof f.descriptor) => {
        let failed = false;
        try { unexpected.push(await createSqliteMaintenanceAdapter(descriptor)); } catch (error) {
          failed = true; assert.ok(error instanceof MaintenanceFailure); assert.equal(error.code, "maintenance_lost");
        }
        assert.equal(failed, true, "the prior private owner must remain reachable after factory rejection");
      };
      await rejectedCreate(f.descriptor);
      await rename(f.file, alias); moved = true;
      await rejectedCreate({ ...f.descriptor, sourcePath: alias, sqlitePath: alias });
      assert.equal(opened, originalOpens, "a renamed source with the same bound inode cannot bypass the pending owner");
      assert.equal(closeCalls, 1, "an unconfirmed close is never retried by numeric descriptor");
      const other = await createSqliteMaintenanceAdapter(independent.descriptor); await other.close();
      await rename(alias, f.file); moved = false;
      child.mock.restoreAll(); syncBuiltinESMExports();
      close(owned!); // This test alone knows its injection preceded the native close.
      assert.throws(() => fstat(owned!), { code: "EBADF" }); owned = undefined;
      const recovered = await createSqliteMaintenanceAdapter(f.descriptor); await recovered.close();
      assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
    } finally {
      child.mock.restoreAll(); syncBuiltinESMExports();
      if (moved) await rename(alias, f.file);
      for (const adapter of unexpected) await adapter.close();
      if (owned !== undefined) { try { close(owned); } catch {} }
      await independent.close(); await f.close();
    }
  });
});

test("#152 SQLite actually closed source owners retire before the Darwin identity assertion", async t => {
  const f = await fixture(), lease = await f.adapter.acquireMutex(f.store.identity, f.initial.state);
  const close = Database.prototype.close, failure = new Error("controlled source close-before");
  let held: Database.Database | undefined;
  try {
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      if (this.name === f.file && !this.readonly) { held = this; throw failure; }
      return close.call(this);
    });
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.observeSourceClients()), error => error === failure);
    assert.ok(held); assert.equal(held.open, true);
    t.mock.restoreAll(); close.call(held); assert.equal(held.open, false);
    // On Linux this is an explicit private branch control using the real closed Database,
    // not a claim that Darwin native inventory or durability ran on this host.
    if (process.platform === "linux") {
      const internal = f.adapter as unknown as { darwinConnections: Set<Database.Database>; assertSource(): void };
      internal.darwinConnections.add(held);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try { Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); internal.assertSource(); }
      finally { Object.defineProperty(process, "platform", platform); }
      assert.equal(internal.darwinConnections.has(held), false);
    }
    await lease.release();
    const observed = await f.adapter.observe();
    const next = await f.adapter.acquireMutex(f.store.identity, observed.state); await next.release();
    assert.deepEqual(businessValues(f.file), [{ value: "original" }]);
  } finally { t.mock.restoreAll(); if (held?.open) close.call(held); await f.close(); }
});

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
      child.mock.restoreAll(); syncBuiltinESMExports();
      if (phase === "before") {
        await assert.rejects(f.adapter.close(), /source-close-unknown/);
        fs.fstatSync(sourceFd!);
        // Only this test knows that its injection preceded the real close. Production cannot prove that.
        close(sourceFd!);
      }
      await f.adapter.close();
      assert.throws(() => fs.fstatSync(sourceFd!), { code: "EBADF" });
    } finally {
      child.mock.restoreAll(); syncBuiltinESMExports();
      if (phase === "before" && sourceFd !== undefined) { try { close(sourceFd); } catch {} }
      await f.close();
    }
  });
});

test("#152 SQLite unknown source close never closes a reopened same-inode descriptor", async t => {
  const f = await fixture(), close = fs.closeSync, open = fs.openSync;
  const primary = new Error("controlled response failure after native close");
  let replacement: number | undefined, injected = false;
  try {
    t.mock.method(fs, "closeSync", (fd: number) => {
      const info = fs.fstatSync(fd, { bigint: true });
      if (!injected && String(info.dev) === f.descriptor.identity.device && String(info.ino) === f.descriptor.identity.inode) {
        injected = true; close(fd);
        replacement = open(f.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        assert.equal(replacement, fd, "the real kernel reused the numeric fd for a new owner");
        throw primary;
      }
      close(fd);
    });
    syncBuiltinESMExports();
    await assert.rejects(f.adapter.close(), error => error === primary);
    assert.equal(injected, true); assert.notEqual(replacement, undefined);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await assert.rejects(f.adapter.close(), /source-close-unknown/);
    const info = fs.fstatSync(replacement!, { bigint: true });
    assert.equal(String(info.dev), f.descriptor.identity.device); assert.equal(String(info.ino), f.descriptor.identity.inode);
    close(replacement!); replacement = undefined;
    await f.adapter.close();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (replacement !== undefined) { try { close(replacement); } catch {} }
    await f.close();
  }
});

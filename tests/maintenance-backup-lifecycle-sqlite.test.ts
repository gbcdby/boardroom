import test from "node:test";
import assert from "node:assert/strict";
import fs, { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import promises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as tick } from "node:timers/promises";
import Database from "better-sqlite3";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { errorLeaves, rejected, sqliteBackupFixture, waitForOwnedStage } from "./fixtures/maintenance-backup-lifecycle.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;

nativeTest("D-AC01 SQLite D still captures actual WAL, complete control rows and typed business values", async () => {
  const f = await sqliteBackupFixture();
  try {
    const backup = await f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination));
    assert.equal(backup.manifests.tables.find(row => row.name === "extra_values")?.count, "4");
    assert.equal(backup.manifests.controlRows.storage_maintenance[0]!.admission, "sealed");
    const restored = new Database(f.destination, { readonly: true, fileMustExist: true });
    try {
      restored.defaultSafeIntegers(true);
      assert.deepEqual(restored.prepare("SELECT value FROM extra_values ORDER BY rowid").pluck().all(), [9223372036854775807n, Buffer.from([0, 255]), "same", "same"]);
      assert.equal(restored.prepare("PRAGMA integrity_check").pluck().get(), "ok");
    } finally { restored.close(); }
    await f.adapter.close();
  } finally { assert.equal((await f.dispose()).failed, false); }
});

nativeTest("D-AC03/05 SQLite real backup preserves the read first error and independently reports close-after failure", async t => {
  const f = await sqliteBackupFixture(), open = promises.open;
  const first = new MaintenanceFailure("snapshot_invalid", "D-read-first"), closeFailure = new MaintenanceFailure("maintenance_lost", "D-close-after");
  let reads = 0, closes = 0, captured = false;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination && args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW)) {
        captured = true;
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: unknown[]) => { await Reflect.apply(read, handle, values); reads++; throw first; }) as typeof handle.read;
        handle.close = async () => { closes++; await close(); throw closeFailure; };
      }
      return handle;
    }); syncBuiltinESMExports();
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    const outer = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination));
      if (inner.failed) throw inner.error;
    }));
    assert.equal(captured, true); assert.equal(reads, 1); assert.equal(closes, 1);
    assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, first, "D close must not replace the original read failure");
    assert.equal(outer.failed, true); assert.strictEqual(outer.error, first);
    const cleanup = await rejected(f.adapter.close());
    assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(closeFailure), "the independently failed close remains observable after the FD is actually closed");
    assert.equal((await rejected(f.adapter.close())).failed, false, "a later explicit cleanup can confirm the now-complete owner");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.dispose(); }
});

for (const primary of [undefined, new Error("ordinary D read first")]) nativeTest(`D-AC03 SQLite retains the exact body first value, undefined=${primary === undefined}`, async t => {
  const f = await sqliteBackupFixture(), open = promises.open;
  const secondary = new Error("independent close after");
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination && args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW)) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: unknown[]) => { await Reflect.apply(read, handle, values); throw primary; }) as typeof handle.read;
        handle.close = async () => { await close(); throw secondary; };
      }
      return handle;
    }); syncBuiltinESMExports();
    let observed: Awaited<ReturnType<typeof rejected>> | undefined;
    const outcome = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      observed = await rejected(lock.backup(f.destination));
      if (observed.failed) throw observed.error;
    }));
    assert.equal(observed?.failed, true); assert.strictEqual(observed?.error, primary);
    assert.equal(outcome.failed, true); assert.strictEqual(outcome.error, primary);
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true);
    assert.ok(errorLeaves(cleanup.error).includes(secondary));
    await f.adapter.close();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal((await f.dispose()).failed, false); }
});

for (const role of ["precreate", "readback"] as const) for (const after of [false, true])
  nativeTest(`D-AC02/05/13 SQLite ${role} close-only ${after ? "after" : "before"} keeps its original owner and error`, async t => {
    const f = await sqliteBackupFixture(), open = promises.open;
    let owned: FileHandle | undefined, originalClose: (() => Promise<void>) | undefined, closes = 0;
    const failure = after ? new Error("close completed then failed") : undefined;
    try {
      t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await Reflect.apply(open, promises, args);
        const readback = args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW);
        if (args[0] === f.destination && readback === (role === "readback")) {
          owned = handle; originalClose = handle.close.bind(handle);
          handle.close = async () => { closes++; if (after) await originalClose!(); throw failure; };
        }
        return handle;
      }); syncBuiltinESMExports();
      let inner: Awaited<ReturnType<typeof rejected>> | undefined;
      assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
        inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
      }))).failed, true);
      assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, failure); assert.equal(closes, 1);
      assert.ok(owned && originalClose);
      const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true);
      assert.ok(errorLeaves(cleanup.error).some(value => value === failure));
      if (!after) {
        const repeat = await rejected(f.adapter.close()); assert.equal(repeat.failed, true);
        assert.equal(closes, 1, "unknown original close is never retried through a replacement/no-op call");
        assert.notEqual(owned.fd, -1, "the original FileHandle remains physically open");
        await originalClose();
      }
      await f.adapter.close(); assert.equal(owned.fd, -1); assert.equal(closes, 1);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (owned && originalClose && owned.fd !== -1) await originalClose();
      assert.equal((await f.dispose()).failed, false);
    }
  });

nativeTest("D-AC02/07 SQLite failed initial identity sampling still owns and closes the actual acquired FileHandle", async t => {
  const f = await sqliteBackupFixture(), open = promises.open, fstat = fs.fstatSync;
  const primary = new Error("first owner identity observation failed"), secondary = new Error("first close failed");
  let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined, fd = -1, sampled = false, closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) {
        owned = handle; fd = handle.fd; close = handle.close.bind(handle);
        handle.close = async () => { closes++; throw secondary; };
      }
      return handle;
    });
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      if (args[0] === fd && !sampled) { sampled = true; throw primary; }
      return Reflect.apply(fstat, fs, args);
    }) as typeof fs.fstatSync); syncBuiltinESMExports();
    const result = await rejected(f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination)));
    assert.equal(sampled, true); assert.equal(result.failed, true); assert.strictEqual(result.error, primary);
    assert.equal(closes, 1); assert.ok(owned && close);
    assert.equal((await rejected(f.adapter.close())).failed, true);
    assert.equal(closes, 1); await close();
    await f.adapter.close();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && close && owned.fd !== -1) await close();
    assert.equal((await f.dispose()).failed, false);
  }
});

for (const sameInode of [false, true]) nativeTest(`D-AC07 SQLite never closes the reused numeric FD, same inode=${sameInode}`, async t => {
  const f = await sqliteBackupFixture(), open = promises.open;
  const otherFile = f.destination + ".replacement"; await promises.writeFile(otherFile, "replacement", { mode: 0o600 });
  const failure = new Error("actual close failed after FD reuse"); let replacement = -1, closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination && args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW)) {
        const close = handle.close.bind(handle), fd = handle.fd;
        handle.close = async () => {
          closes++; await close(); replacement = openSync(sameInode ? f.destination : otherFile, constants.O_RDONLY | constants.O_NOFOLLOW);
          assert.equal(replacement, fd, "this controlled fixture actually reuses the original fd"); throw failure;
        };
      }
      return handle;
    }); syncBuiltinESMExports();
    const failed = await rejected(f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination)));
    assert.equal(failed.failed, true); assert.strictEqual(failed.error, failure); assert.equal(closes, 1);
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(failure));
    assert.doesNotThrow(() => fstatSync(replacement));
    const bytes = Buffer.alloc(sameInode ? 16 : 11); readSync(replacement, bytes, 0, bytes.length, 0);
    assert.equal(bytes.toString(), sameInode ? "SQLite format 3\0" : "replacement");
    assert.equal((await rejected(f.adapter.close())).failed, sameInode, "same inode does not prove ownership of the old open description");
    assert.equal(closes, 1); closeSync(replacement); replacement = -1;
    await f.adapter.close();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); if (replacement >= 0) closeSync(replacement);
    assert.equal((await f.dispose()).failed, false);
  }
});

for (const [after, undefinedCleanup] of [[false, false], [true, false], [true, true]] as const) nativeTest(`D-AC04/08/14 SQLite target and reader cleanup failures stay independent, target close-after=${after}, undefined=${undefinedCleanup}`, async t => {
  const f = await sqliteBackupFixture(), pragma = Database.prototype.pragma, close = Database.prototype.close;
  const targetFailure = undefinedCleanup ? undefined : new Error("target close failure"), readerFailure = undefinedCleanup ? undefined : new Error("reader close failure");
  const primary = undefinedCleanup ? new Error("body remains first before two undefined closes") : undefined;
  let target: Database.Database | undefined, armed = false, readerCloses = 0, targetCloses = 0;
  try {
    t.mock.method(Database.prototype, "pragma", function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      if (this.name === f.destination) { target = this; armed = true; throw primary; }
      return Reflect.apply(pragma, this, args);
    });
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      if (this.name === f.destination) { targetCloses++; if (after) close.call(this); throw targetFailure; }
      if (armed && this.name === f.file && this.readonly) { readerCloses++; close.call(this); throw readerFailure; }
      return close.call(this);
    });
    const first = await rejected(f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination)));
    assert.equal(first.failed, true); assert.strictEqual(first.error, primary); assert.ok(target);
    assert.equal(targetCloses, 1); assert.equal(readerCloses, 1, "the remaining original reader is really closed after target failure");
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true);
    const errors = errorLeaves(cleanup.error);
    assert.strictEqual(errors[0], targetFailure); assert.strictEqual(errors[1], readerFailure);
    if (undefinedCleanup) assert.equal(errors.filter(error => error === undefined).length, 2, "two distinct cleanup events survive even when both values are undefined");
    assert.equal(target.open, !after);
    t.mock.restoreAll();
    if (!after) { await f.adapter.close(); assert.equal(target.open, false); }
    else {
      assert.equal((await rejected(f.adapter.close())).failed, true, "open=false after a failed original close remains unknown");
      assert.equal(targetCloses, 1, "a no-op second close cannot certify the failed first close");
    }
  } finally {
    t.mock.restoreAll(); if (target?.open) close.call(target);
    const cleanup = await f.dispose(); assert.equal(cleanup.failed, after);
  }
});

const readerSharedFailure = new Error("same value from independent reader initialization and close stages");
for (const [label, primary, secondary] of [
  ["distinct errors", new Error("reader initialization first"), new Error("reader close after initialization failure")],
  ["two undefined values", undefined, undefined],
  ["same error object", readerSharedFailure, readerSharedFailure],
] as const) nativeTest(`D-AC03/04 SQLite reader acquisition separates its original first and independent cleanup: ${label}`, async t => {
  const f = await sqliteBackupFixture(), pragma = Database.prototype.pragma, close = Database.prototype.close;
  let initializationFailures = 0, readerCloses = 0;
  try {
    t.mock.method(Database.prototype, "pragma", function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      if (this.name === f.file && this.readonly && args[0] === "query_only=ON") { initializationFailures++; throw primary; }
      return Reflect.apply(pragma, this, args);
    });
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      const result = close.call(this);
      if (this.name === f.file && this.readonly) { readerCloses++; throw secondary; }
      return result;
    });
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    const outer = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
    }));
    const cleanup = await rejected(f.adapter.close());
    assert.equal(initializationFailures, 1); assert.equal(readerCloses, 1);
    assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, primary, "the acquired reader's exact initialization failure remains D's first error");
    assert.equal(outer.failed, true); assert.equal(cleanup.failed, true);
    const errors = errorLeaves(cleanup.error); assert.equal(errors.length, 1); assert.strictEqual(errors[0], secondary);
    await f.adapter.close(); assert.equal(readerCloses, 1);
  } finally { t.mock.restoreAll(); assert.equal((await f.dispose()).failed, false); }
});

nativeTest("D-AC12 SQLite registers the whole D call before its first original held check can await", async t => {
  const f = await sqliteBackupFixture(), held = f.mutex.assertHeld.bind(f.mutex);
  let release!: () => void, enter!: () => void, blocked = false, windowComplete = false;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { enter = resolve; });
  let backup: Promise<Awaited<ReturnType<typeof rejected>>> | undefined, operation: Promise<Awaited<ReturnType<typeof rejected>>> | undefined;
  try {
    operation = rejected(f.adapter.withSourceLock("snapshot", async lock => {
      t.mock.method(f.mutex, "assertHeld", async () => {
        await held();
        if (!blocked) { blocked = true; enter(); await barrier; }
      });
      backup = rejected(lock.backup(f.destination));
    })).then(result => { windowComplete = true; return result; });
    await waitForOwnedStage(started); await tick();
    assert.equal(windowComplete, false, "the original source transaction cannot finish ahead of its registered D call");
    release(); assert.equal((await operation).failed, false);
    assert.equal((await backup)?.failed, false, "the original D must complete before its source window is released");
    assert.equal(windowComplete, true); assert.equal(blocked, true); await f.adapter.close();
  } finally {
    release(); await operation; await backup; t.mock.restoreAll(); assert.equal((await f.dispose()).failed, false);
  }
});

nativeTest("D-AC06/12 SQLite waits for the original close promise even after the fd has retired", async t => {
  const f = await sqliteBackupFixture(), open = promises.open;
  let release!: () => void, entered!: () => void, owned: FileHandle | undefined, closes = 0, completed = false;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let operation: Promise<unknown> | undefined;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination && args[1] !== (constants.O_RDONLY | constants.O_NOFOLLOW)) {
        owned = handle; const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); entered(); await barrier; };
      }
      return handle;
    }); syncBuiltinESMExports();
    operation = f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination)).then(result => { completed = true; return result; });
    await started; assert.equal(owned?.fd, -1); assert.equal(completed, false);
    const closeWhileActive = await rejected(f.adapter.close()); assert.equal(closeWhileActive.failed, true);
    assert.equal((closeWhileActive.error as MaintenanceFailure).code, "maintenance_busy");
    assert.equal(completed, false); assert.equal(closes, 1);
    release(); await operation; assert.equal(completed, true); assert.equal(closes, 1);
    await f.adapter.close();
  } finally { release(); await operation?.catch(() => {}); t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal((await f.dispose()).failed, false); }
});

nativeTest("D-AC09/13 SQLite caught D failure cannot continue the same owner; concurrent cleanup shares its failure", async t => {
  const f = await sqliteBackupFixture(), open = promises.open;
  const failure = new Error("original close before failure"); let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined, closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) {
        owned = handle; close = handle.close.bind(handle);
        handle.close = async () => { closes++; throw failure; };
      }
      return handle;
    }); syncBuiltinESMExports();
    const outer = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      const failed = await rejected(lock.backup(f.destination)); assert.equal(failed.failed, true); assert.strictEqual(failed.error, failure);
      await assert.rejects(lock.assertHeld(), { code: "maintenance_lost" });
      await assert.rejects(lock.observe(), { code: "maintenance_lost" });
      await assert.rejects(lock.backup(f.destination + ".retry"), { code: "maintenance_lost" });
    }));
    assert.equal(outer.failed, true); assert.ok(owned && close);
    await assert.rejects(f.adapter.observe(), { code: "maintenance_lost" });
    const [one, two] = await Promise.all([rejected(f.adapter.close()), rejected(f.adapter.close())]);
    assert.equal(one.failed, true); assert.equal(two.failed, true); assert.strictEqual(one.error, two.error);
    assert.ok(errorLeaves(one.error).includes(failure)); assert.equal(closes, 1);
    await assert.rejects(promises.stat(f.destination + ".retry"), { code: "ENOENT" });
    await close(); await f.adapter.close(); assert.equal(closes, 1);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && close && owned.fd !== -1) await close();
    assert.equal((await f.dispose()).failed, false);
  }
});

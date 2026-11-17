import test from "node:test";
import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, openSync } from "node:fs";
import fs from "node:fs";
import promises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Client } from "pg";
import { setImmediate as tick } from "node:timers/promises";
import { errorLeaves, postgresBackupFixture, rejected, waitForOwnedMarker, waitForOwnedStage } from "./fixtures/maintenance-backup-lifecycle.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

pgTest("D-AC01 PG uses a real exported snapshot and pg_dump before its owners complete", async () => {
  const f = await postgresBackupFixture();
  try {
    const backup = await f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination));
    assert.equal(backup.manifests.tables.find(table => table.name === "projects")?.count, "1");
    assert.equal(backup.manifests.controlRows.storage_maintenance[0]!.admission, "sealed");
    assert.equal((await promises.readFile(f.destination)).subarray(0, 5).toString(), "PGDMP");
    assert.deepEqual((await promises.readdir(dirname(f.destination))).filter(name => name.startsWith(".pgpass-")), []);
    await f.adapter.close();
  } finally { assert.deepEqual(await f.dispose(), []); }
});

for (const role of ["output", "passfile"] as const) pgTest(`D-AC02/03/10 PG ${role} is owned before its first identity observation fails`, async t => {
  const f = await postgresBackupFixture(), open = promises.open, fstat = fs.fstatSync;
  const primary = role === "output" ? undefined : new Error("passfile first identity failure"), secondary = new Error("acquired owner close failure");
  let owned: FileHandle | undefined, originalClose: (() => Promise<void>) | undefined, sampled = false, closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (role === "output" ? args[0] === f.destination : typeof args[0] === "string" && args[0].startsWith(dirname(f.destination) + "/.pgpass-")) {
        owned = handle; originalClose = handle.close.bind(handle);
        handle.close = async () => { closes++; await originalClose!(); throw secondary; };
      }
      return handle;
    });
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fstat>) => {
      const value = Reflect.apply(fstat, fs, args);
      if (!sampled && owned && args[0] === owned.fd) { sampled = true; throw primary; }
      return value;
    }) as typeof fstat); syncBuiltinESMExports();
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
    }))).failed, true);
    assert.equal(sampled, true); assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, primary);
    assert.equal(closes, 1); assert.equal(owned?.fd, -1);
    assert.equal((await promises.stat(f.destination)).size, 0, "the early failure did not dispatch pg_dump");
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(secondary));
    await f.adapter.close();
    assert.deepEqual((await promises.readdir(dirname(f.destination))).filter(name => name.startsWith(".pgpass-")), []);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && originalClose && owned.fd !== -1) await originalClose();
    assert.deepEqual(await f.dispose(), []);
  }
});

pgTest("D-AC02/10 PG an actual passfile open collision creates no owner for the unacquired name", async t => {
  const f = await postgresBackupFixture(), open = promises.open;
  let collision = "", openFailed = false, first: unknown;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      if (typeof args[0] === "string" && args[0].startsWith(dirname(f.destination) + "/.pgpass-")) {
        collision = args[0]; await promises.mkdir(collision, { mode: 0o700 });
        try { return await Reflect.apply(open, promises, args); }
        catch (error) { openFailed = true; first = error; throw error; }
      }
      return Reflect.apply(open, promises, args);
    }); syncBuiltinESMExports();
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
    }))).failed, true);
    assert.equal(openFailed, true); assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, first);
    assert.equal((first as NodeJS.ErrnoException).code, "EEXIST"); assert.equal((await promises.stat(f.destination)).size, 0);
    await f.adapter.close(); assert.equal((await promises.stat(collision)).isDirectory(), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.deepEqual(await f.dispose(), []); }
});

for (const sameInode of [false, true]) pgTest(`D-AC07 PG original output owner never closes a reused fd, same inode=${sameInode}`, async t => {
  const f = await postgresBackupFixture(), open = promises.open, other = f.destination + ".other";
  await promises.writeFile(other, "replacement", { mode: 0o600 });
  const failure = new Error("output closed then fd reused"); let replacement = -1, closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) {
        const close = handle.close.bind(handle), fd = handle.fd;
        handle.close = async () => {
          closes++; await close(); replacement = openSync(sameInode ? f.destination : other, constants.O_RDONLY | constants.O_NOFOLLOW);
          assert.equal(replacement, fd, "actual numeric reuse was exercised"); throw failure;
        };
      }
      return handle;
    }); syncBuiltinESMExports();
    let first: unknown, failed = false;
    assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      try { await lock.backup(f.destination); } catch (error) { failed = true; first = error; throw error; }
    }))).failed, true);
    assert.equal(failed, true); assert.strictEqual(first, failure);
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(failure));
    assert.doesNotThrow(() => fstatSync(replacement)); assert.equal(closes, 1);
    assert.equal((await rejected(f.adapter.close())).failed, sameInode);
    assert.doesNotThrow(() => fstatSync(replacement)); closeSync(replacement); replacement = -1;
    await f.adapter.close();
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); if (replacement >= 0) closeSync(replacement);
    assert.deepEqual(await f.dispose(), []);
  }
});

pgTest("D-AC10 PG passfile name replacement remains separate from the closed FileHandle owner", async t => {
  const f = await postgresBackupFixture(), open = promises.open;
  let name = "", retained = "", closes = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].startsWith(dirname(f.destination) + "/.pgpass-")) {
        name = args[0]; retained = name + ".owned"; const close = handle.close.bind(handle);
        handle.close = async () => {
          closes++; await close(); await promises.rename(name, retained);
          await promises.writeFile(name, "replacement owned by test", { mode: 0o600 }); throw undefined;
        };
      }
      return handle;
    }); syncBuiltinESMExports();
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
    }))).failed, true);
    assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, undefined); assert.equal(closes, 1);
    assert.equal((await promises.stat(f.destination)).size, 0, "no dump used the unconfirmed passfile close");
    assert.equal((await rejected(f.adapter.close())).failed, true);
    assert.equal(await promises.readFile(name, "utf8"), "replacement owned by test", "cleanup never deletes the replacement");
    await promises.unlink(name); await promises.rename(retained, name); retained = "";
    await f.adapter.close(); await assert.rejects(promises.stat(name), { code: "ENOENT" }); assert.equal(closes, 1);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (retained) { await promises.unlink(name).catch(() => {}); await promises.rename(retained, name); }
    assert.deepEqual(await f.dispose(), []);
  }
});

pgTest("D-AC06/11 PG joins the original in-flight monitor before closing the real output", async t => {
  const f = await postgresBackupFixture({ holdDump: true }), held = f.held!;
  const open = promises.open, query = Client.prototype.query;
  let releaseMonitor!: () => void, monitorEntered!: () => void, finalStat!: () => void;
  const barrier = new Promise<void>(resolve => { releaseMonitor = resolve; });
  const entered = new Promise<void>(resolve => { monitorEntered = resolve; }), lastStat = new Promise<void>(resolve => { finalStat = resolve; });
  let armed = false, blocked = false, closes = 0, completed = false, bigStats = 0;
  let operation: Promise<Awaited<ReturnType<typeof rejected>>> | undefined;
  try {
    t.mock.method(Client.prototype, "query", (async function(this: Client, ...args: unknown[]) {
      const result = await Reflect.apply(query, this, args);
      const sql = typeof args[0] === "string" ? args[0] : "";
      if (armed && !blocked && sql.startsWith("SELECT pg_catalog.pg_current_xact_id_if_assigned()")) {
        blocked = true; monitorEntered(); await barrier;
      }
      return result;
    }) as typeof query);
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) {
        const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
        handle.stat = (async (...values: Parameters<typeof stat>) => {
          const info = await Reflect.apply(stat, handle, values);
          if (values[0]?.bigint === true && ++bigStats === 2) finalStat();
          return info;
        }) as typeof handle.stat;
        handle.close = async () => { closes++; await close(); };
      }
      return handle;
    }); syncBuiltinESMExports();
    operation = rejected(f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination))).then(value => { completed = true; return value; });
    await waitForOwnedMarker(held.ready); armed = true; await waitForOwnedStage(entered);
    await promises.writeFile(held.release, "release owned wrapper"); await waitForOwnedStage(lastStat); await tick();
    assert.equal(closes, 0, "output close cannot overtake the original monitor completion"); assert.equal(completed, false);
    releaseMonitor(); const result = await operation; assert.equal(result.failed, false); assert.equal(closes, 1); assert.equal(blocked, true);
    await f.adapter.close();
  } finally {
    releaseMonitor(); await promises.writeFile(held.release, "cleanup release"); await operation;
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.deepEqual(await f.dispose(), []);
  }
});

pgTest("D-AC11/14 PG abort waits for the actual tool close before parent output close and shares concurrent cleanup", async t => {
  const f = await postgresBackupFixture({ holdDump: true }), held = f.held!;
  const open = promises.open, spawn = childProcess.spawn, closeFailure = new Error("parent output close after tool reap");
  let child: ChildProcess | undefined, reaped = false, outputCloses = 0;
  let operation: Promise<Awaited<ReturnType<typeof rejected>>> | undefined;
  try {
    t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof spawn>) => {
      const result = Reflect.apply(spawn, childProcess, args);
      if (args[0] === "pg_dump" && Array.isArray(args[1]) && !args[1].includes("--version")) {
        child = result; result.once("close", () => { reaped = true; });
      }
      return result;
    }) as typeof spawn);
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) {
        const close = handle.close.bind(handle);
        handle.close = async () => { outputCloses++; assert.equal(reaped, true); await close(); throw closeFailure; };
      }
      return handle;
    }); syncBuiltinESMExports();
    operation = rejected(f.adapter.withSourceLock("snapshot", lock => lock.backup(f.destination)));
    await waitForOwnedMarker(held.ready); assert.ok(child?.pid); assert.equal(reaped, false); assert.equal(outputCloses, 0);
    const [one, two] = await Promise.all([rejected(f.adapter.close()), rejected(f.adapter.close())]);
    assert.equal(one.failed, true); assert.equal(two.failed, true); assert.strictEqual(one.error, two.error);
    assert.ok(errorLeaves(one.error).includes(closeFailure));
    assert.equal((await operation).failed, true); assert.equal(reaped, true); assert.equal(outputCloses, 1);
    await f.adapter.close();
  } finally {
    if (child && !reaped) child.kill("SIGTERM"); await operation;
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.deepEqual(await f.dispose(), []);
  }
});

for (const primary of [undefined, new Error("PG output sync first")])
  pgTest(`D-AC03/05/15 PG preserves callback first across safeError and reports close-after, undefined=${primary === undefined}`, async t => {
    const f = await postgresBackupFixture(), open = promises.open, secondary = new Error("output close after failure");
    let syncs = 0, closes = 0;
    try {
      t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await Reflect.apply(open, promises, args);
        if (args[0] === f.destination) {
          const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
          handle.sync = async () => { await sync(); syncs++; throw primary; };
          handle.close = async () => { closes++; await close(); throw secondary; };
        }
        return handle;
      }); syncBuiltinESMExports();
      let inner: Awaited<ReturnType<typeof rejected>> | undefined;
      const outer = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
        inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
      }));
      assert.equal(syncs, 1, "the real dump completed before the actual output sync failed"); assert.equal(closes, 1);
      assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, primary);
      assert.equal(outer.failed, true); assert.notStrictEqual(outer.error, primary, "the existing PG wrapper remains a distinct safe error boundary");
      const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(secondary));
      await f.adapter.close();
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.deepEqual(await f.dispose(), []); }
  });

for (const role of ["output", "passfile"] as const) for (const after of [false, true])
  pgTest(`D-AC02/05/10 PG ${role} close-${after ? "after" : "before"} failure retains its real owner`, async t => {
    const f = await postgresBackupFixture(), open = promises.open;
    let owned: FileHandle | undefined, originalClose: (() => Promise<void>) | undefined, closes = 0;
    const failure = undefined;
    try {
      t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await Reflect.apply(open, promises, args);
        if (role === "output" ? args[0] === f.destination : typeof args[0] === "string" && args[0].startsWith(f.destination.slice(0, f.destination.lastIndexOf("/")) + "/.pgpass-")) {
          owned = handle; originalClose = handle.close.bind(handle);
          handle.close = async () => { closes++; if (after) await originalClose!(); throw failure; };
        }
        return handle;
      }); syncBuiltinESMExports();
      let inner: Awaited<ReturnType<typeof rejected>> | undefined;
      const outer = await rejected(f.adapter.withSourceLock("snapshot", async lock => {
        inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
      }));
      assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, failure); assert.equal(outer.failed, true);
      assert.ok(owned && originalClose); assert.equal(closes, 1);
      if (role === "passfile") assert.equal((await promises.stat(f.destination)).size, 0, "pg_dump never starts before the original passfile close completes");
      const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true); assert.ok(errorLeaves(cleanup.error).includes(failure));
      if (!after) {
        assert.equal((await rejected(f.adapter.close())).failed, true); assert.equal(closes, 1);
        await originalClose();
      }
      await f.adapter.close(); assert.equal(owned.fd, -1); assert.equal(closes, 1);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && originalClose && owned.fd !== -1) await originalClose();
      assert.deepEqual(await f.dispose(), []);
    }
  });

pgTest("D-AC04/10/14 PG retains multiple independent passfile and output cleanup errors", async t => {
  const f = await postgresBackupFixture(), open = promises.open, unlink = promises.unlink;
  const closeFailure = new Error("output close failure"), unlinkFailure = new Error("passfile unlink failure");
  let unlinks = 0, outputCloses = 0;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (args[0] === f.destination) { const close = handle.close.bind(handle); handle.close = async () => { outputCloses++; await close(); throw closeFailure; }; }
      return handle;
    });
    t.mock.method(promises, "unlink", async (...args: Parameters<typeof promises.unlink>) => {
      if (typeof args[0] === "string" && args[0].includes("/.pgpass-")) { unlinks++; throw unlinkFailure; }
      return Reflect.apply(unlink, promises, args);
    }); syncBuiltinESMExports();
    let inner: Awaited<ReturnType<typeof rejected>> | undefined;
    assert.equal((await rejected(f.adapter.withSourceLock("snapshot", async lock => {
      inner = await rejected(lock.backup(f.destination)); if (inner.failed) throw inner.error;
    }))).failed, true);
    assert.equal(inner?.failed, true); assert.strictEqual(inner?.error, unlinkFailure);
    assert.equal(outputCloses, 1); assert.equal(unlinks, 1);
    const cleanup = await rejected(f.adapter.close()); assert.equal(cleanup.failed, true);
    const errors = errorLeaves(cleanup.error); assert.strictEqual(errors[0], unlinkFailure); assert.strictEqual(errors[1], closeFailure);
    assert.ok(unlinks >= 2); assert.equal(outputCloses, 1);
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.adapter.close();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); assert.deepEqual(await f.dispose(), []); }
});

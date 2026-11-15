import test from "node:test";
import assert from "node:assert/strict";
import fs, { constants, closeSync, fstatSync, openSync } from "node:fs";
import promises, { mkdtemp, rm, lstat, readFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { canonicalJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: "2".repeat(64) };
async function fixture() {
  const dir = await mkdtemp(path.join(process.cwd(), "maintenance-publication-test-"));
  const store = await ArtifactStore.create(path.join(dir, "control"), source);
  const readable = await store.putJson("plan", { purpose: "existing immutable object" });
  return { dir, store, readable, close: () => rm(dir, { recursive: true, force: true }) };
}
async function rejected(operation: Promise<unknown>) {
  try { await operation; } catch (error) { return { failed: true, error }; }
  return { failed: false, error: undefined };
}

for (const phase of ["write", "sync"] as const) for (const point of ["before", "after"] as const)
  for (const undefinedFirst of [false, true]) nativeTest(`#152 publication ${phase} first failure survives close-${point}, undefined=${undefinedFirst}`, async t => {
    const f = await fixture(), open = promises.open;
    const first = undefinedFirst ? undefined : Object.freeze(new MaintenanceFailure("snapshot_invalid", "publication-first"));
    const second = Object.freeze(new MaintenanceFailure("maintenance_lost", "publication-close"));
    let owned: FileHandle | undefined, originalClose: (() => Promise<void>) | undefined;
    let writes = 0, closes = 0, armed = false, temporary = "";
    const body = { kind: "receipt-test", phase, point, undefinedFirst };
    const ref = { ref: `snapshots/${sha256(canonicalJson(body))}/receipt.json`, sha256: sha256(canonicalJson(body)), bytes: String(Buffer.byteLength(canonicalJson(body))) };
    try {
      const guarded = await ArtifactStore.open(f.store.root, source, { after(value) {
        if (armed && phase === "sync" && value === "file_synced") throw first;
      } });
      t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await Reflect.apply(open, promises, args);
        if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
          owned = handle; temporary = args[0]; originalClose = handle.close.bind(handle);
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async (...values: Parameters<typeof write>) => { await write(...values); writes++; if (phase === "write") throw first; };
          handle.close = async () => { closes++; if (point === "before") throw second; await originalClose!(); throw second; };
        }
        return handle;
      });
      syncBuiltinESMExports(); armed = true;
      const result = await rejected(guarded.putJson("receipt", body));
      assert.equal(result.failed, true); assert.strictEqual(result.error, first, "close must not replace the original failure");
      assert.equal(writes, 1); assert.equal(closes, 1); assert.ok(owned && originalClose);
      assert.deepEqual(await readFile(temporary), Buffer.from(canonicalJson(body)));
      await assert.rejects(lstat(f.store.pathFor(ref)), { code: "ENOENT" });
      const record = f.store.publicationOutcomes().records.at(-1)!;
      assert.deepEqual(record.artifact, ref); assert.equal(record.failureObserved, true); assert.equal(record.closeFailureObserved, true);
      assert.equal(record.handleOpened, true); assert.equal(record.handleClosed, point === "after");
      assert.equal(record.pendingCleanup, point === "before");
      assert.ok(!JSON.stringify(record).includes("publication-first")); assert.ok(!JSON.stringify(record).includes("publication-close"));
      await f.store.readJson(f.readable, "plan"); assert.equal(closes, 1, "reads never perform cleanup");
      if (point === "before") {
        await assert.rejects(f.store.putJson("plan", { new: true }), { code: "snapshot_invalid" });
        assert.equal(closes, 1, "a blocked new publication does not retry cleanup");
        const cleanup = await rejected(f.store.cleanupPublications()); assert.equal(cleanup.failed, true); assert.equal(cleanup.error, second);
        assert.equal(closes, 2); assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, true);
      }
      owned.close = async () => { closes++; await originalClose!(); };
      await f.store.cleanupPublications();
      assert.equal(owned.fd, -1); assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, false);
      assert.equal(f.store.publicationOutcomes().records.at(-1)!.handleClosed, true);
      assert.equal(writes, 1, "cleanup never replays write or rename");
      await assert.rejects(lstat(f.store.pathFor(ref)), { code: "ENOENT" });
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (owned && originalClose) { owned.close = originalClose; await originalClose().catch(() => {}); }
      await f.close();
    }
  });

for (const point of ["before", "after"] as const) for (const undefinedClose of [false, true])
  nativeTest(`#152 publication single close-${point} failure, undefined=${undefinedClose}`, async t => {
    const f = await fixture(), open = promises.open;
    const failure = undefinedClose ? undefined : new MaintenanceFailure("snapshot_invalid", "close-only");
    let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined;
    try {
      t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
        const handle = await Reflect.apply(open, promises, args);
        if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
          owned = handle; close = handle.close.bind(handle);
          handle.close = async () => { if (point === "after") await close!(); throw failure; };
        }
        return handle;
      }); syncBuiltinESMExports();
      const result = await rejected(f.store.putJson("receipt", { point, undefinedClose }));
      assert.equal(result.failed, true); assert.strictEqual(result.error, failure);
      const record = f.store.publicationOutcomes().records.at(-1)!;
      assert.equal(record.failureObserved, false); assert.equal(record.closeFailureObserved, true);
      assert.equal(record.handleClosed, point === "after"); assert.equal(record.pendingCleanup, point === "before");
      assert.ok(owned && close); owned.close = close;
      await f.store.cleanupPublications(); assert.equal(owned.fd, -1);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && close) { owned.close = close; await close().catch(() => {}); }
      await f.store.cleanupPublications(); await f.close(); }
  });

nativeTest("#152 publication pending owner is shared across guarded stores and gates every publishing entry", async t => {
  const f = await fixture(), open = promises.open, failure = new MaintenanceFailure("snapshot_invalid", "close-before");
  let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined, closes = 0;
  const attempt = await f.store.createAttempt(1), database = path.join(attempt, "database.bin");
  await writeFile(database, "real closed imported bytes");
  try {
    const guarded = await ArtifactStore.open(f.store.root, source);
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
        owned = handle; close = handle.close.bind(handle); handle.close = async () => { closes++; throw failure; };
      }
      return handle;
    }); syncBuiltinESMExports();
    await assert.rejects(guarded.putJson("receipt", { isolated: true }), error => error === failure);
    const fresh = await ArtifactStore.open(f.store.root, source), before = f.store.publicationOutcomes();
    assert.deepEqual(fresh.publicationOutcomes(), before);
    await fresh.assertRoot(); await fresh.readJson(f.readable, "plan");
    await assert.rejects(fresh.putBytes("source-file-payload", Buffer.from("blocked")), { code: "snapshot_invalid" });
    await assert.rejects(fresh.importDatabase(database), { code: "snapshot_invalid" });
    await assert.rejects(fresh.confirmDurable(f.readable), { code: "snapshot_invalid" });
    assert.equal(closes, 1); assert.deepEqual(await readFile(database), Buffer.from("real closed imported bytes"));
    assert.ok(owned && close); owned.close = async () => { closes++; await close!(); };
    await fresh.cleanupPublications(); assert.equal(closes, 2); assert.equal(owned.fd, -1);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, false);
    const imported = await fresh.importDatabase(database); assert.deepEqual(await fresh.readBytes(imported), Buffer.from("real closed imported bytes"));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && close) { owned.close = close; await close().catch(() => {}); }
    await f.store.cleanupPublications(); await f.close(); }
});

for (const unknownIdentity of [false, true]) nativeTest(`#152 publication never closes a retired reused descriptor, unknown identity=${unknownIdentity}`, async t => {
  const f = await fixture(), open = promises.open, originalStat = fs.fstatSync;
  const primary = undefined, secondary = new MaintenanceFailure("snapshot_invalid", "close-after");
  let owned: FileHandle | undefined, originalFd = -1, replacement = -1, close: (() => Promise<void>) | undefined, closes = 0, firstStat = true;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
        owned = handle; originalFd = handle.fd; close = handle.close.bind(handle);
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...data: Parameters<typeof write>) => { await write(...data); throw primary; };
        const file = args[0];
        handle.close = async () => { closes++; await close!(); replacement = openSync(file, constants.O_RDONLY);
          assert.equal(replacement, originalFd, "the real OS must actually reuse this descriptor for the counterexample"); throw secondary; };
      }
      return handle;
    });
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      if (unknownIdentity && args[0] === originalFd && firstStat) { firstStat = false; throw primary; }
      return Reflect.apply(originalStat, fs, args);
    }) as typeof fs.fstatSync); syncBuiltinESMExports();
    const result = await rejected(f.store.putJson("receipt", { unknownIdentity }));
    assert.equal(result.failed, true); assert.strictEqual(result.error, primary); assert.equal(closes, 1); assert.ok(owned && close);
    assert.equal(owned.fd, -1); assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, true);
    await assert.rejects(f.store.cleanupPublications(), { code: "snapshot_invalid" });
    assert.equal(closes, 1); assert.equal(fstatSync(replacement).isFile(), true, "replacement owner remains open");
    closeSync(replacement); replacement = -1;
    await f.store.cleanupPublications(); assert.equal(closes, 1);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.pendingCleanup, false);
    assert.equal(f.store.publicationOutcomes().records.at(-1)!.handleClosed, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); if (replacement >= 0) closeSync(replacement);
    if (owned && close) { owned.close = close; await close().catch(() => {}); } await f.store.cleanupPublications(); await f.close(); }
});

nativeTest("#152 publication cleanup shares one original handle attempt and preserves undefined without replay", async t => {
  const f = await fixture(), open = promises.open;
  let owned: FileHandle | undefined, close: (() => Promise<void>) | undefined, writes = 0, closes = 0;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
        owned = handle; close = handle.close.bind(handle); const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...data: Parameters<typeof write>) => { writes++; await write(...data); };
        handle.close = async () => { closes++; throw undefined; };
      }
      return handle;
    }); syncBuiltinESMExports();
    const failed = await rejected(f.store.putJson("receipt", { concurrent: true })); assert.equal(failed.failed, true); assert.equal(failed.error, undefined);
    assert.ok(owned && close); owned.close = async () => { closes++; await barrier; await close!(); throw undefined; };
    const calls = [rejected(f.store.cleanupPublications()), rejected(f.store.cleanupPublications()), rejected(f.store.cleanupPublications())];
    await Promise.resolve(); assert.equal(closes, 2); release();
    for (const result of await Promise.all(calls)) { assert.equal(result.failed, true); assert.equal(result.error, undefined); }
    assert.equal(closes, 2); assert.equal(writes, 1); assert.equal(owned.fd, -1);
    const record = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(record.cleanupFailureObserved, true); assert.equal(record.pendingCleanup, false); assert.equal(record.handleClosed, true);
  } finally { release(); t.mock.restoreAll(); syncBuiltinESMExports(); if (owned && close) { owned.close = close; await close().catch(() => {}); }
    await f.store.cleanupPublications(); await f.close(); }
});

nativeTest("#152 publication history is bounded and readonly without inventing full historical success", async () => {
  const f = await fixture();
  try {
    const initial = f.store.publicationOutcomes();
    for (let i = 0; i < 36; i++) await f.store.putJson("receipt", { i });
    const result = f.store.publicationOutcomes();
    assert.equal(result.epoch, initial.epoch); assert.equal(result.records.length, 32); assert.equal(result.discarded, 5);
    assert.deepEqual(result.records.map(item => item.invocation), Array.from({ length: 32 }, (_, i) => i + 6));
    assert.throws(() => { (result.records[0]!.artifact as { ref: string }).ref = "altered"; }, TypeError);
    assert.throws(() => { (result.limits as { roots: number }).roots = 1; }, TypeError);
    assert.equal(f.store.publicationOutcomes().limits.roots, 64);
    assert.equal(result.records.every(record => record.handleClosed && !record.failureObserved && !record.closeFailureObserved), true);
  } finally { await f.close(); }
});

nativeTest("#152 publication cleanup cannot close an active writer and never replays its operation", async t => {
  const f = await fixture(), open = promises.open;
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let closes = 0, writes = 0, owned: FileHandle | undefined;
  let operation: Promise<unknown> | undefined;
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
        owned = handle; const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        handle.writeFile = async (...data: Parameters<typeof write>) => { start(); await gate; writes++; await write(...data); };
        handle.close = async () => { closes++; await close(); };
      }
      return handle;
    }); syncBuiltinESMExports();
    operation = f.store.putJson("receipt", { active: true }); await started;
    await assert.rejects(f.store.cleanupPublications(), { code: "snapshot_invalid" });
    assert.equal(closes, 0); assert.equal(writes, 0); assert.ok(owned && owned.fd >= 0);
    const active = f.store.publicationOutcomes().records.at(-1)!;
    assert.equal(active.operationFinished, false); assert.equal(active.pendingCleanup, false);
    release(); await operation;
    assert.equal(closes, 1); assert.equal(writes, 1); assert.equal(owned.fd, -1);
    await f.store.cleanupPublications(); assert.equal(closes, 1);
  } finally { release(); await operation?.catch(() => {}); t.mock.restoreAll(); syncBuiltinESMExports(); await f.store.cleanupPublications(); await f.close(); }
});

nativeTest("#152 publication cleanup uses the verified root binding rather than mutable caller fields", async t => {
  const one = await fixture(), two = await fixture(), open = promises.open;
  const owners: { handle: FileHandle; close: () => Promise<void>; count: number }[] = [];
  const identity = { ...one.store.identity };
  try {
    t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
      const handle = await Reflect.apply(open, promises, args);
      if (typeof args[0] === "string" && args[0].includes("/receipt.json.") && args[0].endsWith(".tmp")) {
        const owner = { handle, close: handle.close.bind(handle), count: 0 }; owners.push(owner);
        handle.close = async () => { owner.count++; throw undefined; };
      }
      return handle;
    }); syncBuiltinESMExports();
    assert.equal((await rejected(one.store.putJson("receipt", { root: 1 }))).failed, true);
    assert.equal((await rejected(two.store.putJson("receipt", { root: 2 }))).failed, true);
    assert.equal(owners.length, 2);
    for (const owner of owners) owner.handle.close = async () => { owner.count++; await owner.close(); };
    Object.assign(one.store.identity, two.store.identity);
    await one.store.cleanupPublications();
    assert.equal(owners[0]!.handle.fd, -1); assert.equal(owners[0]!.count, 2);
    assert.ok(owners[1]!.handle.fd >= 0); assert.equal(owners[1]!.count, 1);
    assert.equal(two.store.publicationOutcomes().records.at(-1)!.pendingCleanup, true);
    Object.assign(one.store.identity, identity);
    await two.store.cleanupPublications(); assert.equal(owners[1]!.handle.fd, -1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); Object.assign(one.store.identity, identity);
    for (const owner of owners) { owner.handle.close = owner.close; await owner.close().catch(() => {}); }
    await one.store.cleanupPublications(); await two.store.cleanupPublications(); await one.close(); await two.close(); }
});

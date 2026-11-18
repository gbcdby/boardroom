import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { parseReceipt, parseVerification } from "../src/server/storage/maintenance/parse.ts";
import { verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";
import { readyRevalidationFixture } from "./fixtures/maintenance-ready-revalidation.ts";

// This fixture actually uses the Linux source-FD bridge with an explicitly
// synthetic Fs profile; it is neither a Darwin nor a qualification positive.
const nativeTest = process.platform === "linux" ? test : test.skip;
const files = async (root: string) => (await readdir(root, { recursive: true })).sort();
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

nativeTest("C3 restore close-entry drains the original pending snapshot operation before source close", async t => {
  const f = await readyRevalidationFixture();
  let original: SourceLock | undefined;
  try {
    const scope = await f.select(), before = await files(f.store.root), state = await f.adapter.observe();
    await assert.rejects(f.snapshot(async lock => {
      original = lock;
      const entered = gate(), release = gate(), read = lock.observeSourceClients.bind(lock);
      let abortProbe = false, childStarted = false;
      t.mock.method(lock, "observeSourceClients", async () => {
        if (!childStarted) return read();
        entered.resolve(); await release.promise;
        if (abortProbe) throw new Error("owned probe cleanup");
        return read();
      });
      const operation = f.consumers.withControllerRestoreCallback(scope, lock, () => {
        childStarted = true;
        return f.consumers.prepareControllerSnapshot(scope, lock);
      });
      const observed = operation.then(() => ({ failed: false, error: undefined as unknown }), error => ({ failed: true, error }));
      await entered.promise;
      let barrier: Promise<void> | undefined;
      try {
        barrier = f.consumers.finishControllerRestoreCallback(lock);
        assert(barrier); assert.strictEqual(f.consumers.finishControllerRestoreCallback(lock), barrier);
        void barrier.catch(() => undefined);
        assert.notEqual(f.sql.controlSqlOutcome(lock).commitReturned, true);
        await lock.assertHeld();
        assert.deepEqual(await files(f.store.root), before, "a blocked original read has not published D/V/R");
      } catch (error) { abortProbe = true; throw error; }
      finally { release.resolve(); await observed; }
      const result = await observed;
      assert.equal(result.failed, true); assert.equal((result.error as { code?: string }).code, "maintenance_lost");
      await barrier;
    }), { code: "maintenance_lost" });
    assert(original); await assert.rejects(original.assertHeld(), { code: "maintenance_lost" });
    assert.deepEqual(await files(f.store.root), before); assert.deepEqual(await f.adapter.observe(), state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("C3 actual restore authority crosses only the completed original snapshot and a fresh exact control lock", async () => {
  const f = await readyRevalidationFixture();
  let original: SourceLock | undefined;
  try {
    const scope = await f.select(), before = await f.adapter.observe();
    await f.snapshot(async lock => {
      original = lock;
      const returned = await f.consumers.withControllerRestoreCallback(scope, lock, async () => {
        const result = await f.consumers.prepareControllerSnapshot(scope, lock);
        assert.equal(result, undefined, "no returned refs or reusable authority");
        return "actual callback result";
      });
      assert.equal(returned, "actual callback result", "parent lifetime permits its original nested restore operation");
      assert.notEqual(f.sql.controlSqlOutcome(lock).commitReturned, true);
      assert.throws(() => f.writer.assertControllerLockCompleted(scope, lock), { code: "maintenance_lost" });
    });
    assert(original); f.writer.assertControllerLockCompleted(scope, original);
    await assert.rejects(original.assertHeld(), { code: "maintenance_lost" });
    const authorization = await f.adapter.withSourceLock("control", async lock => {
      assert.notStrictEqual(lock, original);
      return f.consumers.consumeControllerRestoreAuthorization(scope, lock, "ready");
    });
    assert.equal(authorization.kind, "ready");
    const receipt = parseReceipt(await f.store.readJson(authorization.receipt, "receipt"));
    const closure = await verifyRestoreBundleClosure(f.store, receipt.bundle, receipt.publication);
    const verification = parseVerification(await f.store.readJson(receipt.verification, "verification"));
    assert.deepEqual(verification.bundle, receipt.bundle);
    assert.deepEqual(closure.manifests, before.manifests);
    assert.equal(closure.manifests.controlRows.storage_source_clients.length, 2);
    assert.equal(receipt.capture.journal.sha256, before.state.journalDigest);
    assert.deepEqual(await f.adapter.observe(), before, "receipt publication has not written or committed a ready source anchor");
    const names = await files(f.store.root);
    await assert.rejects(f.adapter.withSourceLock("control", lock =>
      f.consumers.consumeControllerRestoreAuthorization(scope, lock, "ready")), { code: "maintenance_lost" });
    assert.deepEqual(await files(f.store.root), names, "a consumed association cannot publish a second receipt");
  } finally { await f.close(); }
});

nativeTest("C3 original consumer callback remains owned between checks and preserves a raw undefined rejection", async () => {
  const f = await readyRevalidationFixture();
  try {
    const scope = await f.select(), before = await files(f.store.root), state = await f.adapter.observe();
    let caught = false;
    try {
      await f.snapshot(async lock => {
        const entered = gate(), release = gate();
        const operation = f.consumers.withControllerRestoreCallback(scope, lock, async () => {
          entered.resolve(); await release.promise; throw undefined;
        });
        const observed = operation.then(() => ({ failed: false, error: undefined as unknown }), error => ({ failed: true, error }));
        await entered.promise;
        const barrier = f.consumers.finishControllerRestoreCallback(lock);
        assert(barrier); assert.strictEqual(f.consumers.finishControllerRestoreCallback(lock), barrier);
        const closed = barrier.then(() => ({ failed: false, error: undefined as unknown }), error => ({ failed: true, error }));
        try {
          await lock.assertHeld(); assert.notEqual(f.sql.controlSqlOutcome(lock).commitReturned, true);
        } finally { release.resolve(); }
        const result = await observed, close = await closed;
        assert.equal(result.failed, true); assert.equal(result.error, undefined);
        assert.equal(close.failed, true); assert.equal(close.error, undefined, "source-close observes the original raw callback rejection");
        let late = false;
        await assert.rejects(f.consumers.withControllerRestoreCallback(scope, lock, async () => { late = true; }), { code: "maintenance_lost" });
        assert.equal(late, false, "closing admission forbids a late callback before its first action");
        throw result.error;
      });
    } catch (error) { caught = true; assert.equal(error, undefined); }
    assert.equal(caught, true); assert.deepEqual(await files(f.store.root), before); assert.deepEqual(await f.adapter.observe(), state);
  } finally { await f.close(); }
});

nativeTest("C3 copied scope and source lock cannot start database publication or create restore authority", async () => {
  const f = await readyRevalidationFixture();
  try {
    const scope = await f.select(), before = await files(f.store.root), state = await f.adapter.observe();
    await f.snapshot(async lock => {
      await assert.rejects(f.consumers.prepareControllerSnapshot({ ...scope }, lock), { code: "maintenance_lost" });
      await assert.rejects(f.consumers.prepareControllerSnapshot(scope, { ...lock }), { code: "maintenance_lost" });
    });
    assert.deepEqual(await files(f.store.root), before); assert.deepEqual(await f.adapter.observe(), state);
    await assert.rejects(f.adapter.withSourceLock("control", lock =>
      f.consumers.consumeControllerRestoreAuthorization(scope, lock, "ready")), { code: "maintenance_lost" });
    assert.deepEqual(await files(f.store.root), before);
  } finally { await f.close(); }
});

nativeTest("C3 actual ready readonly view checks current source bytes without attempts, publications or target restoration", async t => {
  const f = await readyRevalidationFixture();
  const artifacts = async () => {
    const values: [string, string][] = [];
    for (const name of await files(f.store.root)) {
      const file = path.join(f.store.root, name);
      if ((await stat(file)).isFile()) values.push([name, createHash("sha256").update(await readFile(file)).digest("hex")]);
    }
    return values;
  };
  try {
    const scope = await f.select();
    await f.snapshot(lock => f.consumers.prepareControllerSnapshot(scope, lock));
    await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope, lock, { kind: "ready" }));
    const before = await f.adapter.observe(), bytes = await artifacts();
    let checked = false;
    for (const method of ["createAttempt", "putJson", "putBytes", "putSourceFilePayload", "confirmDurable"] as const)
      t.mock.method(ArtifactStore.prototype, method, () => { assert.fail("readonly ready must not publish or create attempts"); });
    t.mock.method(f.adapter, "verifyDatabase", () => { assert.fail("readonly ready must not restore a target"); });
    await assert.rejects(f.snapshot(async lock => {
      t.mock.method(lock, "backup", () => { assert.fail("readonly ready must not create a database archive"); });
      const view = await f.consumers.assertControllerReadyCurrent(scope, lock);
      assert.equal(view.ref.journal.sha256, before.state.journalDigest);
      await view.assertCurrent(); checked = true;
      assert.deepEqual(await artifacts(), bytes, "successful readonly view preserves every existing artifact byte");
      await writeFile(f.profile.config, "changed owned source bytes", { mode: 0o600 });
      f.resetReadTimes();
      await view.assertCurrent();
    }), { code: "plan_stale" }); // The existing P contract pins config bytes before the Fs comparison.
    assert.equal(checked, true, "the actual current ready positive branch ran before source mutation");
    assert.deepEqual(await artifacts(), bytes, "the failed readonly check also leaves all artifact bytes unchanged");
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("C3 actual restoration failure including undefined never publishes V/R or grants the next lock authority", async t => {
  const f = await readyRevalidationFixture();
  let attempted = false;
  try {
    const scope = await f.select(), before = await f.adapter.observe();
    t.mock.method(f.adapter, "verifyDatabase", async () => { attempted = true; throw undefined; });
    let occurred = false, first: unknown;
    try { await f.snapshot(lock => f.consumers.prepareControllerSnapshot(scope, lock)); }
    catch (error) { occurred = true; first = error; }
    assert.equal(attempted, true); assert.equal(occurred, true); assert.equal(first, undefined);
    assert(!(await files(f.store.root)).some(name => name.endsWith("/verification.json") || name.endsWith("/receipt.json")));
    assert.deepEqual(await f.adapter.observe(), before);
    let repeated = false;
    try { await f.adapter.withSourceLock("control", lock => f.consumers.consumeControllerRestoreAuthorization(scope, lock, "ready")); }
    catch (error) { repeated = true; assert.equal(error, undefined, "failure occurrence is sticky even for undefined"); }
    assert.equal(repeated, true);
  } finally { t.mock.restoreAll(); await f.close(); }
});

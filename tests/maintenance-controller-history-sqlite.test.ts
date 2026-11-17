import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import Database from "better-sqlite3";
import { sqliteAuditFixture } from "./fixtures/maintenance-source-audit.ts";
import { assertControllerPendingFailures, assertVerifiedConsumerFailure, controllerWriterFixture, historicalControllerProcess, historicalControllerRow } from "./fixtures/maintenance-controller-history.ts";
import { readyRevalidationFixture } from "./fixtures/maintenance-ready-revalidation.ts";
import { canonicalJson } from "../src/server/storage/maintenance/canonical.ts";
import { verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import { planMigration, persistMigrationPlan } from "../src/server/storage/maintenance/plan.ts";
import { inspectRegisteredSourceProcess } from "../src/server/storage/maintenance/source-facts.ts";
import type { ControllerCommandScope } from "../src/server/storage/maintenance/controller-write.ts";
import { beginControllerCommand, commitControllerStep } from "../src/server/storage/maintenance/controller-write.ts";
import type { SourceLock } from "../src/server/storage/maintenance/types.ts";

// Only these new capture/restore engineering fixtures use the Linux source-FD bridge.
// The existing native audit cases keep their original cross-platform gate.
const captureTest = process.platform === "linux" ? test : test.skip;

captureTest("C3 sqlite fixed verified consumer preserves original failure forwarding and independent occurrences", async t => {
  for (const variant of ["revalidate", "check-early", "check-child", "join", "last-check", "independent-same", "independent-undefined", "independent-after"] as const)
    await t.test(variant, () => assertVerifiedConsumerFailure("sqlite", variant));
});

captureTest("C3 SQLite keeps each independent pending callback failure after the original source callback failure", async t => {
  for (const variant of ["distinct", "same", "undefined", "parent-and-child", "control-writer"] as const)
    await t.test(variant, () => assertControllerPendingFailures("sqlite", variant));
});

captureTest("C3 SQLite original factory registers only through three real commits and a fresh exact readback", async () => {
  const f = await controllerWriterFixture(), exec = Database.prototype.exec, close = Database.prototype.close;
  const events: string[] = [], locks: SourceLock[] = [];
  let scope: ControllerCommandScope | undefined;
  try {
    Database.prototype.exec = function(sql) { const result = exec.call(this, sql);
      if (this.name === f.file && !this.readonly && sql === "COMMIT") events.push("commit-returned"); return result; };
    Database.prototype.close = function() { const source = this.name === f.file && !this.readonly;
      const result = close.call(this); if (source) events.push("source-closed"); return result; };
    const first = await f.adapter.withSourceLock("control", async lock => {
      locks.push(lock);
      const begun = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request });
      scope = begun.scope; assert.equal(begun.prefix.status, "new");
      await assert.rejects(f.writer.commitControllerStep({ ...scope }, lock, { kind: "first-capture" }), { code: "maintenance_lost" });
      return f.writer.commitControllerStep(scope, lock, { kind: "first-capture" });
    });
    assert.equal((await f.adapter.observeSourceClients()).rows.length, 1, "first seal does not register the controller");
    const takeover = await f.adapter.withSourceLock("control", async lock => {
      locks.push(lock); return f.writer.commitControllerStep(scope!, lock, { kind: "takeover" });
    });
    const recapture = await f.adapter.withSourceLock("control", async lock => {
      locks.push(lock);
      const audit = await lock.readSourceClientAudit(f.reference);
      assert(audit.facts.actor.clientId, "only the different actual lock promotes the committed controller");
      assert.deepEqual(audit.facts.actor.process, first.node.record.formatVersion === 3 ? first.node.record.controlProof?.facts.actor.process : undefined);
      return f.writer.commitControllerStep(scope!, lock, { kind: "recapture" });
    });
    assert.equal(new Set(locks).size, 3); assert.deepEqual(events, ["commit-returned", "source-closed", "commit-returned", "source-closed", "commit-returned", "source-closed"]);
    assert.equal(takeover.node.record.ownerGeneration, first.node.record.ownerGeneration + 1);
    assert.equal(recapture.node.record.ownerGeneration, takeover.node.record.ownerGeneration);
    assert.deepEqual(recapture.node.record.frozen, first.node.record.frozen);
    assert.deepEqual(recapture.node.record.formatVersion === 3 ? recapture.node.record.sourceClients : undefined,
      first.node.record.formatVersion === 3 ? first.node.record.sourceClients : undefined);
    assert.equal((await f.adapter.observeSourceClients()).rows.length, 2);
    for (const lock of locks) assert.equal(f.sql.controlSqlOutcome(lock).status, "source-transaction-completed");
  } finally { Database.prototype.exec = exec; Database.prototype.close = close; await f.close(); }
});

test("C3 SQLite production writer rejects copied native owners and the actual empty qualification registry", async () => {
  const f = await sqliteAuditFixture(false), before = await f.adapter.observeSourceClients();
  const command = { operation: "resume-migration" as const, request: { plan: f.reference, expectedSource: f.plan.source,
    expectedPhase: "planned" as const, expectedJournalDigest: f.head.sha256, requestId: "c3-unqualified" } };
  try {
    await assert.rejects(f.adapter.withSourceLock("control", async lock => {
      await assert.rejects(beginControllerCommand({ ...f.adapter }, f.mutex, lock, command), { code: "maintenance_lost" });
      await assert.rejects(beginControllerCommand(f.adapter, { ...f.mutex }, lock, command), { code: "maintenance_lost" });
      await assert.rejects(beginControllerCommand(f.adapter, f.mutex, { ...lock }, command), { code: "maintenance_lost" });
      const { scope } = await beginControllerCommand(f.adapter, f.mutex, lock, command);
      await commitControllerStep(scope, lock, { kind: "first-capture" });
    }), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.adapter.observeSourceClients(), before, "no first seal, registration or head change without actual P/S qualification");
  } finally { await f.close(); }
});

captureTest("C3 SQLite a forgotten controller Promise keeps its original source transaction owned until retirement", async () => {
  const f = await controllerWriterFixture();
  const before = await f.adapter.observeSourceClients();
  let release!: () => void, entered!: () => void, operation: Promise<unknown> | undefined, sourceLock: SourceLock | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  f.state.hook = async stage => { if (stage === "capture-begin") { entered(); await gate; } };
  try {
    const outer = f.adapter.withSourceLock("control", async lock => {
      sourceLock = lock;
      const { scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request });
      operation = f.writer.commitControllerStep(scope, lock, { kind: "first-capture" });
      void operation.catch(() => {}); await reached;
    });
    void outer.catch(() => {}); await reached; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sql.controlSqlOutcome(sourceLock!).failureObserved, true, "callback exit records the forgotten original operation");
    assert.equal(f.sql.controlSqlOutcome(sourceLock!).localSourceHandleClosed, false, "original source handle remains until its pending work retires");
    release(); await assert.rejects(outer, { code: "maintenance_lost" }); await assert.rejects(operation!, { code: "maintenance_lost" });
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
    assert.equal(f.sql.controlSqlOutcome(sourceLock!).localSourceHandleClosed, true);
  } finally { release(); await operation?.catch(() => {}); await f.close(); }
});

captureTest("C3 SQLite actual writer distinguishes lost COMMIT response from source-close failure without losing undefined", async t => {
  for (const stage of ["commit-before", "commit-after", "close-after"] as const) await t.test(stage, async () => {
    const f = await controllerWriterFixture(), exec = Database.prototype.exec, close = Database.prototype.close;
    const primary = stage === "close-after" ? undefined : new Error(stage);
    const before = await f.adapter.observeSourceClients();
    let scope: ControllerCommandScope | undefined, original: SourceLock | undefined, invoked = false, rejected = false;
    try { try {
      Database.prototype.exec = function(sql) {
        if (this.name === f.file && !this.readonly && sql === "COMMIT" && stage.startsWith("commit")) {
          invoked = true; if (stage === "commit-after") exec.call(this, sql); throw primary;
        }
        return exec.call(this, sql);
      };
      Database.prototype.close = function() {
        const source = this.name === f.file && !this.readonly, result = close.call(this);
        if (source && stage === "close-after") { invoked = true; throw primary; } return result;
      };
      try {
        await f.adapter.withSourceLock("control", async lock => {
          original = lock;
          ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
          return f.writer.commitControllerStep(scope, lock, { kind: "first-capture" });
        });
      } catch (error) { rejected = true; assert.equal(error, primary); }
      assert(invoked && rejected);
      const outcome = f.sql.controlSqlOutcome(original!);
      assert.equal(outcome.status, "unknown"); assert.equal(outcome.localSourceHandleClosed, true);
      assert.equal(outcome.commitReturned, stage === "close-after");
      assert.equal(stage === "close-after" ? outcome.closeError : outcome.originalError, primary);
      assert.equal(stage === "close-after" ? outcome.closeFailureObserved : outcome.failureObserved, true);
      assert.throws(() => f.writer.assertControllerLockCompleted(scope!, original!), { code: "maintenance_lost" });
    } finally { Database.prototype.exec = exec; Database.prototype.close = close; }
      const after = await f.adapter.observeSourceClients();
      assert.deepEqual(after.rows, before.rows);
      assert.equal(after.state.admission, stage === "commit-before" ? "draining" : "sealed");
      assert.equal((await f.sql.resolveUntrustedControlSql(f.adapter, original!)).classification, "unknown",
        "the original mutex still owns the unresolved outcome");
      await f.mutex.release();
      assert.equal((await f.sql.resolveUntrustedControlSql(f.adapter, original!)).classification,
        stage === "commit-before" ? "observed-uncommitted" : "observed-committed");
    } finally { await f.close(); }
  });
});

captureTest("C3 SQLite legacy capture keeps v2 bytes and rows through public-scope cancellation", async () => {
  const f = await controllerWriterFixture("sqlite", { legacyCapture: true });
  const before = await f.adapter.observeSourceClients(); let scope: ControllerCommandScope | undefined;
  try {
    const takeover = await f.adapter.withSourceLock("control", async lock => {
      const begun = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "cancel-migration", request: f.request });
      scope = begun.scope; return f.writer.commitControllerStep(scope, lock, { kind: "takeover" });
    });
    const intent = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "cancel-intent" }));
    const terminal = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "cancelled" }));
    for (const result of [takeover, intent, terminal]) {
      assert.equal(result.node.record.formatVersion, 2); assert.equal(Object.hasOwn(result.node.record, "controlProof"), false);
      assert.equal(result.node.record.requestId, f.request.requestId);
    }
    const after = await f.adapter.observeSourceClients();
    assert.deepEqual(after.rows, before.rows); assert.equal(after.state.admission, "open");
    assert.equal(after.state.fenceEpoch, before.state.fenceEpoch + 1);
    assert.equal(after.state.ownerGeneration, before.state.ownerGeneration + 1);
    assert.equal(after.state.activeMigrationId, null); assert.equal(after.state.planDigest, null);
  } finally { await f.close(); }
});

captureTest("C3 SQLite ready writer consumes actual D/V only after snapshot COMMIT and source close", async () => {
  const f = await readyRevalidationFixture(); let snapshot: SourceLock | undefined, readyLock: SourceLock | undefined;
  try {
    const scope = await f.select(), selected = await f.adapter.observeSourceClients();
    await f.snapshot(async lock => { snapshot = lock; await f.consumers.prepareControllerSnapshot(scope, lock); });
    f.writer.assertControllerLockCompleted(scope, snapshot!);
    const ready = await f.adapter.withSourceLock("control", async lock => {
      readyLock = lock; assert.notStrictEqual(lock, snapshot);
      const result = await f.writer.commitControllerStep(scope, lock, { kind: "ready" });
      assert.notEqual(f.sql.controlSqlOutcome(lock).commitReturned, true); return result;
    });
    assert.equal(f.sql.controlSqlOutcome(readyLock!).status, "source-transaction-completed");
    const closure = await verifySnapshotClosure(f.store, ready.node.reference);
    assert.equal(ready.node.record.event, "ready"); assert.equal(ready.node.record.formatVersion, 3);
    assert.equal(ready.node.record.requestId, f.request.requestId);
    assert.equal(closure.receipt.capture.journal.sha256, selected.state.journalDigest);
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, selected.rows);
    assert.equal((await f.adapter.observe()).state.journalDigest, ready.node.reference.sha256);
  } finally { await f.close(); }
});

captureTest("C3 SQLite a handled verification refusal remains sticky in the original private controller window", async () => {
  const f = await readyRevalidationFixture();
  try {
    const scope = await f.select(), before = await f.adapter.observe();
    const attempt = await f.store.createAttempt(before.state.ownerGeneration);
    await assert.rejects(f.snapshot(async lock => {
      await f.writer.assertControllerCommandWindow(scope, lock);
      const archive = path.join(attempt, "backup.sqlite"), backup = await lock.backup(archive);
      await assert.rejects(f.adapter.verifyDatabase(archive, { ...backup.manifests, fullDataManifestDigest: "0".repeat(64) },
        path.join(attempt, "restore")), { code: "snapshot_invalid" });
    }), { code: "snapshot_invalid" });
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { await f.close(); }
});

captureTest("C3 SQLite adapter automatically retires forgotten parent and child restore Promises on return and throw", async t => {
  for (const ending of ["return", "throw-undefined"] as const) await t.test(ending, async () => {
    const f = await readyRevalidationFixture();
    let release!: () => void, reached!: () => void, original: SourceLock | undefined, operation: Promise<void> | undefined, outer: Promise<void> | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
    try {
      const scope = await f.select(), before = await f.adapter.observeSourceClients();
      const files = (await filesystem.readdir(f.store.root, { recursive: true })).sort();
      let completed = false;
      outer = f.adapter.withSourceLock("snapshot", async lock => {
        original = lock;
        const read = lock.observeSourceClients.bind(lock); let child = false;
        lock.observeSourceClients = async () => {
          if (child) { reached(); await gate; }
          return read();
        };
        operation = f.consumers.withControllerRestoreCallback(scope, lock, () => {
          child = true; return f.consumers.prepareControllerSnapshot(scope, lock);
        });
        void operation.catch(() => undefined);
        await entered;
        if (ending === "throw-undefined") throw undefined;
      });
      void outer.then(() => { completed = true; }, () => { completed = true; });
      await entered; await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(completed, false, "outer source ownership cannot finish around an original pending child");
      assert.notEqual(f.sql.controlSqlOutcome(original!).commitReturned, true);
      assert.notEqual(f.sql.controlSqlOutcome(original!).localSourceHandleClosed, true);
      await original!.assertHeld(); release();
      if (ending === "return") await assert.rejects(outer, { code: "maintenance_lost" });
      else {
        let rejected = false;
        try { await outer; } catch (error) { rejected = true; assert.equal(error, undefined); }
        assert(rejected); assert.equal(f.sql.controlSqlOutcome(original!).originalError, undefined);
      }
      await assert.rejects(operation!, { code: "maintenance_lost" });
      assert.equal(f.sql.controlSqlOutcome(original!).localSourceHandleClosed, true);
      assert.deepEqual(f.sql.controlSqlOutcome(original!).cleanupEvents, [], "the single private close marker is not a second cleanup failure");
      assert.deepEqual(await f.adapter.observeSourceClients(), before);
      assert.deepEqual((await filesystem.readdir(f.store.root, { recursive: true })).sort(), files);
    } finally { release(); await Promise.allSettled([...(outer ? [outer] : []), ...(operation ? [operation] : [])]); await f.close(); }
  });
});

captureTest("C3 SQLite new private archive owner really restores anchored legacy ready before a separate bridge and takeover", async () => {
  const f = await controllerWriterFixture("sqlite", { legacyReady: true }), pragma = Database.prototype.pragma;
  const targets: string[] = []; let scope: ControllerCommandScope | undefined, snapshot: SourceLock | undefined;
  try {
    const before = await f.adapter.observeSourceClients();
    const oldHead = await f.store.readAnchoredJournal({ ref: before.state.journalRecordRef!, sha256: before.state.journalDigest! });
    const old = await verifySnapshotClosure(f.store, oldHead);
    const receipt = await f.store.readJson(old.receiptRef, "receipt"), verification = await f.store.readJson(old.receipt.verification, "verification");
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
    });
    Database.prototype.pragma = function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      const value = Reflect.apply(pragma, this, args);
      if (args[0] === "integrity_check" && this.name.startsWith(f.store.root + "/attempts/") && this.name.endsWith("restored.sqlite")) targets.push(this.name);
      return value;
    } as typeof pragma;
    const restored = await f.adapter.withSourceLock("snapshot", async lock => {
      snapshot = lock; return f.consumers.revalidateControllerReady(scope!, lock);
    });
    assert.equal(targets.length, 1, "the new owner executed the real isolated SQLite integrity and full-manifest restoration");
    f.writer.assertControllerLockCompleted(scope!, snapshot!);
    assert.deepEqual(restored.receiptRef, old.receiptRef);
    assert.deepEqual(await f.adapter.observeSourceClients(), before, "actual restoration has not written any source control");
    const bridged = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "legacy-ready-bridge" }));
    assert.equal(bridged.node.record.formatVersion, 3);
    if (bridged.node.record.formatVersion !== 3) assert.fail("actual v3 bridge required");
    assert.equal(bridged.node.record.event, "observation");
    assert.equal(bridged.node.record.ownerGeneration, before.state.ownerGeneration);
    assert.equal(bridged.node.record.fenceEpoch, before.state.fenceEpoch);
    assert.equal(bridged.node.record.controlProof?.kind, "legacy-first-capture-bridge");
    assert.deepEqual(bridged.node.record.controlProof?.kind === "legacy-first-capture-bridge" ? bridged.node.record.controlProof.legacy : null,
      { ready: oldHead, receipt: old.receiptRef, manifests: old.receipt.manifests });
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, before.rows);
    const takeover = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "takeover" }));
    assert.equal(takeover.node.record.ownerGeneration, before.state.ownerGeneration + 1);
    await f.adapter.withSourceLock("control", async lock => {
      const audit = await lock.readSourceClientAudit(f.reference); assert(audit.facts.actor.clientId);
      assert.equal(audit.observation.rows.length, before.rows.length + 1);
    });
    assert.deepEqual(await f.store.readJson(old.receiptRef, "receipt"), receipt);
    assert.deepEqual(await f.store.readJson(old.receipt.verification, "verification"), verification);
  } finally { Database.prototype.pragma = pragma; await f.close(); }
});

captureTest("C3 SQLite anchored archive selection refuses caller paths before any restore target is opened", async () => {
  const f = await controllerWriterFixture("sqlite", { legacyReady: true }), pragma = Database.prototype.pragma;
  let scope: ControllerCommandScope | undefined, restored = 0;
  try {
    const before = await f.adapter.observe();
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
    });
    Database.prototype.pragma = function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      if (args[0] === "integrity_check") restored++;
      return Reflect.apply(pragma, this, args);
    } as typeof pragma;
    await assert.rejects(f.adapter.withSourceLock("snapshot", async lock => {
      const context = await f.writer.assertControllerCommandWindow(scope!, lock);
      const closure = await verifySnapshotClosure(f.store, context.head!);
      return f.adapter.verifyDatabase(f.file, closure.manifests, path.join(f.store.root, "attempts", "wrong-caller-archive"));
    }), { code: "snapshot_invalid" });
    assert.equal(restored, 0);
    await assert.rejects(filesystem.stat(path.join(f.store.root, "attempts", "wrong-caller-archive")), { code: "ENOENT" });
    assert.deepEqual(await f.adapter.observe(), before);
  } finally { Database.prototype.pragma = pragma; await f.close(); }
});

captureTest("C3 SQLite a real archive input close failure preserves undefined and invalidates the bridge association", async () => {
  const f = await controllerWriterFixture("sqlite", { legacyReady: true }), pragma = Database.prototype.pragma, open = filesystem.open;
  let scope: ControllerCommandScope | undefined, restored = false, closeFailures = 0, rejected = false;
  try {
    const before = await f.adapter.observeSourceClients();
    const head = await f.store.readAnchoredJournal({ ref: before.state.journalRecordRef!, sha256: before.state.journalDigest! });
    const closure = await verifySnapshotClosure(f.store, head), archive = f.store.pathFor(closure.receipt.database);
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
    });
    Database.prototype.pragma = function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      const result = Reflect.apply(pragma, this, args);
      if (args[0] === "integrity_check" && this.name.endsWith("restored.sqlite")) restored = true;
      return result;
    } as typeof pragma;
    filesystem.open = async function(...args: Parameters<typeof open>) {
      const handle = await open(...args);
      if (args[0] === archive && !restored) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          // Earlier closure readers really closed before the restore. Only the
          // retained N07 input spans the actual target integrity/manifest run.
          if (restored) { closeFailures++; throw undefined; }
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try { await f.adapter.withSourceLock("snapshot", lock => f.consumers.revalidateControllerReady(scope!, lock)); }
    catch (error) { rejected = true; assert.equal(error, undefined); }
    assert(restored && rejected); assert.equal(closeFailures, 1, "one original input close occurrence, after its actual native close");
    assert.deepEqual(await f.adapter.observeSourceClients(), before);
    let replayRejected = false;
    try { await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "legacy-ready-bridge" })); }
    catch (error) { replayRejected = true; assert.equal(error, undefined); }
    assert(replayRejected); assert.equal((await f.adapter.observe()).state.journalDigest, head.sha256);
  } finally {
    filesystem.open = open; syncBuiltinESMExports(); Database.prototype.pragma = pragma;
    await f.close();
  }
});

captureTest("C3 SQLite a new execute scope binds the exact cancelled terminal before the next migration enter", async () => {
  const f = await controllerWriterFixture("sqlite", { legacyCapture: true });
  let held = f.mutex, scope: ControllerCommandScope | undefined;
  try {
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, held, lock, { operation: "cancel-migration", request: f.request }));
      return f.writer.commitControllerStep(scope, lock, { kind: "takeover" });
    });
    await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "cancel-intent" }));
    const terminal = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "cancelled" }));
    await held.release();
    const plan = await planMigration(f.options, f.adapter), reference = await persistMigrationPlan(plan, f.options, f.adapter);
    assert.notEqual(plan.migrationId, f.plan.migrationId);
    held = await f.adapter.acquireMutex(f.store.identity, (await f.adapter.observe()).state);
    await f.adapter.withSourceLock("control", async lock => {
      const command = { operation: "execute-migration" as const, request: { plan: reference, expectedSource: plan.source,
        expectedPhase: null, expectedJournalDigest: null, requestId: "next-epoch-enter" } };
      const next = await f.writer.beginControllerCommand(f.adapter, held, lock, command);
      assert.equal(next.prefix.status, "new");
      const context = await f.writer.assertControllerEnterWindow(next.scope, lock);
      assert.deepEqual(context.head, terminal.node.reference);
      assert.equal(context.chain!.nodes.at(-1)!.record.event, "cancelled", "the old terminal remains the real observed chain");
      assert.equal(context.observation.state.admission, "open"); assert.equal(context.plan.migrationId, plan.migrationId);
    });
    assert.equal((await f.adapter.observe()).state.journalDigest, terminal.node.reference.sha256,
      "scope creation/enter authorization alone did not mutate or replace the old terminal");
  } finally { await held.release(); await f.close(); }
});

async function fixture(encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8") {
  const actor = await historicalControllerProcess();
  let source: Awaited<ReturnType<typeof sqliteAuditFixture>> | undefined;
  try {
    source = await sqliteAuditFixture(true, encoding, async ({ dataDir }) => {
      const db = new Database(path.join(dataDir, "agent-studio.db"));
      // Carried open state for a later maintenance, not evidence of a previous controller registration.
      try { db.prepare("UPDATE storage_maintenance SET fence_epoch=2").run(); }
      finally { db.close(); }
    });
    const row = historicalControllerRow(source.plan.source, actor);
    const db = new Database(source.file);
    try {
      const names = Object.keys(row);
      db.prepare(`INSERT INTO storage_source_clients (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(row));
    } finally { db.close(); }
    const ready = source;
    return { ...ready, actor, row, async close() { await actor.close(); await ready.close(); } };
  } catch (error) { await actor.close(); await source?.close(); throw error; }
}

function replaceRow(f: Awaited<ReturnType<typeof fixture>>, row: Record<string, unknown>) {
  const db = new Database(f.file);
  try {
    const names = Object.keys(row).filter(key => key !== "client_id");
    db.prepare(`UPDATE storage_source_clients SET ${names.map(key => `${key}=?`).join(",")} WHERE client_id=?`)
      .run(...names.map(key => row[key]), f.row.client_id);
  } finally { db.close(); }
}

test("A12-B historical SQLite controller uses actual child exit and preserves every raw row without writes", async () => {
  const f = await fixture();
  try {
    await f.actor.exit();
    await f.adapter.withSourceLock("control", async lock => {
      const before = await lock.observeSourceClients();
      assert.equal(before.state.fenceEpoch, 3);
      const packet = await lock.readSourceClientAudit(f.reference);
      assert.equal(packet.kind, "untrusted-source-client-audit");
      assert.deepEqual(packet.observation, before);
      assert.equal(packet.origin.capture, null);
      assert.equal(packet.facts.actor.clientId, null);
      assert.equal(packet.facts.clients.length, 2);
      const old = packet.facts.clients.find(value => Buffer.from(value.subject[1], "hex").toString("utf8") === f.row.client_id)!;
      assert.equal(old.kind, "maintenance-controller");
      if (old.kind !== "maintenance-controller") assert.fail("historical controller fact required");
      assert.equal(old.classification, "exited-actor");
      assert.equal(old.registration, "R0-historical");
      assert.deepEqual(old.process, f.actor.identity);
      assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
      assert(packet.facts.clients.some(value => value.kind === "ordinary-client" && value.classification === "current-client"));
      assert.deepEqual(await lock.observeSourceClients(), before, "no control row or anchor mutation");
    });
  } finally { await f.close(); }
});

test("C3 default SQLite consumer binds both UTF16 histories to actual exited controllers", async t => {
  for (const encoding of ["UTF-16le", "UTF-16be"] as const) await t.test(encoding, async () => {
    const f = await fixture(encoding);
    try {
      await assert.rejects(f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async () => assert.fail("a live old controller must still block"))),
        { code: "source_writer_unknown" });
      await f.actor.exit();
      await f.adapter.withSourceLock("control", lock => lock.withSourceClientFacts(f.reference, async facts => {
        assert.equal(facts.observation.textEncoding.name, encoding);
        assert.equal(facts.clients.find(client => client.clientId === f.row.client_id)?.classification, "historical-controller");
        assert.equal(facts.clients.find(client => client.clientId === f.row.client_id)?.process.status, "exited");
        await facts.assertCurrent();
      }));
      await f.adapter.withSourceLock("control", async lock => {
        const before = await lock.observeSourceClients(), packet = await lock.readSourceClientAudit(f.reference);
        assert.equal(packet.observation.textEncoding.name, encoding);
        assert.deepEqual(packet.observation, before);
        assert.equal(packet.facts.clients.filter(value => value.kind === "maintenance-controller").length, 1);
        assert.equal(packet.facts.clients.filter(value => value.kind === "ordinary-client").length, 1);
        assert.deepEqual(await lock.observeSourceClients(), before);
      });
    } finally { await f.close(); }
  });
});

test("A12-B historical SQLite controller never substitutes ended time or empty owned resources for actual exit", async () => {
  const f = await fixture();
  try {
    replaceRow(f, { ...f.row, ended_at: "2026-11-02T00:00:00.000Z" });
    const read = () => f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    await assert.rejects(read(), { code: "source_writer_unknown" });
    await f.actor.exit();
    const packet = await read();
    assert.equal(packet.facts.clients.find(value => value.kind === "maintenance-controller")!.classification, "exited-actor");
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller keeps same-value native decimals live and preserves their raw text", async () => {
  const f = await fixture();
  try {
    const identity = f.actor.identity;
    const alias = identity.platform === "linux" ? { ...identity, startTicks: `0${identity.startTicks}` }
      : { ...identity, startSeconds: `0${identity.startSeconds}` };
    replaceRow(f, { ...f.row, process_identity_json: canonicalJson(alias) });
    const before = await f.adapter.withSourceLock("control", lock => lock.observeSourceClients());
    assert.equal((await inspectRegisteredSourceProcess(f.actor.host, alias)).fact.status, "present");
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" });
    assert.deepEqual(await f.adapter.withSourceLock("control", lock => lock.observeSourceClients()), before);
    assert.equal((await inspectRegisteredSourceProcess(f.actor.host, identity)).fact.status, "present");
    await f.actor.exit();
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    const old = packet.facts.clients.find(value => value.kind === "maintenance-controller")!;
    assert.equal(old.classification, "exited-actor");
    assert.equal(old.processCheck.kind, process.platform === "linux" ? "linux-absent" : "darwin-absent");
    assert.deepEqual(old.process, alias, "the observed input text is retained rather than normalized");
    assert.deepEqual(packet.observation, before, "the full raw roster is unchanged after actual exit");
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller refuses unknown profile, creation and native provenance", async t => {
  const f = await fixture();
  try {
    await f.actor.exit();
    const cases: [string, (row: Record<string, unknown>, registration: Record<string, unknown>) => void][] = [
      ["unknown build", row => { row.build_id = "unknown-controller"; }],
      ["extra registration field", (_row, registration) => { registration.owned = true; }],
      ["source identity mismatch", (_row, registration) => { registration.sourceIdentityDigest = "0".repeat(64); }],
      ["same epoch", (row, registration) => {
        row.registered_epoch = row.observed_epoch = 3;
        (registration.creation as Record<string, unknown>).fenceEpoch = "3";
      }],
      ["creation epoch mismatch", (_row, registration) => { (registration.creation as Record<string, unknown>).fenceEpoch = "2"; }],
      ["creation previous mismatch", (_row, registration) => {
        ((registration.creation as Record<string, unknown>).previousAnchor as Record<string, unknown>).ref = `journals/wrong/1-${"8".repeat(64)}.json`;
      }],
      ["foreign boot", row => {
        const identity = JSON.parse(String(row.process_identity_json));
        identity[process.platform === "linux" ? "kernelBootId" : "bootSessionUuid"] = "00000000-0000-4000-8000-000000000000";
        row.process_identity_json = canonicalJson(identity);
      }],
      ["foreign native boundary", row => {
        const identity = JSON.parse(String(row.process_identity_json));
        if (process.platform === "linux") identity.pidNamespace = "pid:[0]";
        else identity.uid = Number(identity.uid) + 1;
        row.process_identity_json = canonicalJson(identity);
      }],
    ];
    for (const [name, edit] of cases) await t.test(name, async () => {
      const row: Record<string, unknown> = { ...f.row }, registration = JSON.parse(f.row.db_sessions_json) as Record<string, unknown>;
      edit(row, registration); row.db_sessions_json = canonicalJson(registration); replaceRow(f, row);
      try { await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" }); }
      finally { replaceRow(f, f.row); }
    });
    const packet = await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference));
    assert.equal(packet.facts.clients.filter(value => value.kind === "maintenance-controller").length, 1);
  } finally { await f.close(); }
});

test("A12-B historical SQLite controller does not exempt a different process holding the source", async () => {
  const f = await fixture(); let reader: Awaited<ReturnType<typeof historicalControllerProcess>> | undefined;
  try {
    await f.actor.exit(); reader = await historicalControllerProcess(f.file);
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)), { code: "source_writer_unknown" });
    await reader.exit();
    assert.equal((await f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference))).facts.clients.length, 2);
  } finally { await reader?.close(); await f.close(); }
});

test("A12-B historical SQLite controller cannot return through a failed final source close", async () => {
  const f = await fixture(), original = Database.prototype.close;
  let closes = 0, injected = false, fulfilled = false;
  try {
    await f.actor.exit();
    Database.prototype.close = function () {
      const target = this.name === f.file && this.readonly;
      const result = original.call(this);
      if (target && ++closes === 2) { injected = true; throw Object.assign(new Error("controlled final native close"), { code: "EIO" }); }
      return result;
    };
    await assert.rejects(f.adapter.withSourceLock("control", lock => lock.readSourceClientAudit(f.reference)).then(value => { fulfilled = true; return value; }),
      { code: "maintenance_lost" });
    assert(injected, "the actual final inspection close was reached"); assert.equal(fulfilled, false);
  } finally { Database.prototype.close = original; await f.close(); }
});

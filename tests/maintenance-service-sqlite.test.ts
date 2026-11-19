import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import { sha256, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { inspectMaintenance } from "../src/server/storage/maintenance/inspect.ts";
import { runMaintenanceServiceCommand } from "../src/server/storage/maintenance/service.ts";
import { enterMaintenance, stageControllerEnter } from "../src/server/storage/maintenance/enter.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { maintenanceRequestDigest, parseJournal, parseReceipt } from "../src/server/storage/maintenance/parse.ts";
import { assertControllerLockCompleted, beginControllerCommand } from "../src/server/storage/maintenance/controller-write.ts";
import { captureReference, verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { enterFixture } from "./fixtures/maintenance-enter.ts";
import { runActualMaintenanceCli, serviceFixture, startServiceChild } from "./fixtures/maintenance-service.ts";
import type { InspectMaintenanceCommand } from "../src/server/storage/maintenance/controller-command.ts";
import type { ControllerCommandScope } from "../src/server/storage/maintenance/controller-write.ts";
import type { OperationMutex, SourceLock } from "../src/server/storage/maintenance/types.ts";
import type { VerifiedMaintenanceGuard } from "../src/server/storage/maintenance/verified-maintenance.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const sourceFileTest = process.platform === "linux" ? test : test.skip;
const inspectCommand = (f: Awaited<ReturnType<typeof enterFixture>>): InspectMaintenanceCommand =>
  ({ operation: "inspect-migration", request: { plan: f.reference, expectedSource: f.plan.source } });
async function inventory(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const rows = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(entry.parentPath, entry.name);
    return { path: path.relative(root, file), digest: sha256(await readFile(file)) };
  }));
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

nativeTest("#152 C3 inspect SQLite: open saved plan remains read-only, with no mutex or journal creation", async () => {
  const f = await enterFixture();
  try {
    const before = await f.observe(), files = await inventory(f.reference.controlRoot);
    const result = await inspectMaintenance(f.options, inspectCommand(f));
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") throw new Error("open source is an observation without a maintenance prefix");
    assert.equal(result.lastVerifiedPhase, null);
    assert.deepEqual(result.blockers.map(blocker => blocker.code), ["phase_conflict"]);
    assert.equal(result.observedAnchor, undefined);
    assert.deepEqual(await f.observe(), before);
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 inspect SQLite: exact planned prefix returns only a diagnostic anchor without writes", async () => {
  const f = await enterFixture();
  try {
    const entered = await enterMaintenance(f.options, f.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("planned required");
    const before = await f.observe(), files = await inventory(f.reference.controlRoot);
    const result = await inspectMaintenance(f.options, inspectCommand(f));
    assert.equal(result.status, "paused"); if (result.status !== "paused") throw new Error("planned observation required");
    assert.equal(result.phase, "planned"); assert.deepEqual(result.ref, entered.ref);
    assert.deepEqual(result.observedAnchor, { ...entered.ref, phase: "planned", admission: "draining", authority: "observation-only" });
    assert.deepEqual(await f.observe(), before);
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 inspect SQLite: broken anchored bytes are recovery_required and never repaired", async () => {
  const f = await enterFixture();
  try {
    const entered = await enterMaintenance(f.options, f.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("planned required");
    const journal = path.join(f.reference.controlRoot, entered.ref.journal.ref);
    await writeFile(journal, Buffer.concat([await readFile(journal), Buffer.from(" ")]));
    const before = await f.observe(), files = await inventory(f.reference.controlRoot);
    const result = await inspectMaintenance(f.options, inspectCommand(f));
    assert.equal(result.status, "recovery_required"); assert.equal(result.observedAnchor, undefined);
    assert.deepEqual(await f.observe(), before);
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 inspect SQLite: a later durable orphan cannot replace the exact database head", async () => {
  const f = await enterFixture();
  try {
    const entered = await enterMaintenance(f.options, f.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("planned required");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const original = parseJournal(await store.readJson(entered.ref.journal, "journal"));
    await store.putJson("journal", parseJournal({ ...original, sequence: 2, previous: entered.ref.journal,
      event: "observation", requestId: "unselected-orphan", requestDigest: digestJson({ orphan: true }) }));
    const before = await f.observe(), files = await inventory(f.reference.controlRoot);
    const result = await inspectMaintenance(f.options, inspectCommand(f));
    assert.equal(result.status, "paused"); if (result.status !== "paused") throw new Error("exact planned required");
    assert.deepEqual(result.ref, entered.ref);
    assert.deepEqual(await f.observe(), before);
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 inspect SQLite: unknown request keys are rejected before source or artifact changes", async () => {
  const f = await enterFixture();
  try {
    const before = await f.observe(), files = await inventory(f.reference.controlRoot), command = inspectCommand(f);
    await assert.rejects(inspectMaintenance(f.options, { ...command,
      request: { ...command.request, requestId: "not-an-inspect-key" } } as InspectMaintenanceCommand), { code: "request_conflict" });
    assert.deepEqual(await f.observe(), before);
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 inspect SQLite: a missing selected source is recovery_required and is never seeded", async () => {
  const f = await enterFixture();
  const saved = f.file + ".saved";
  let moved = false;
  try {
    const entered = await enterMaintenance(f.options, f.request); assert.equal(entered.status, "paused");
    const before = await f.observe(), files = await inventory(f.reference.controlRoot);
    await rename(f.file, saved); moved = true;
    const result = await inspectMaintenance(f.options, inspectCommand(f));
    assert.equal(result.status, "recovery_required"); assert.equal(result.observedAnchor, undefined);
    await assert.rejects(stat(f.file), { code: "ENOENT" });
    assert.deepEqual(await inventory(f.reference.controlRoot), files);
    await rename(saved, f.file); moved = false;
    assert.deepEqual(await f.observe(), before);
  } finally { if (moved) await rename(saved, f.file); await f.close(); }
});

nativeTest("#152 C3 public enter SQLite: actual original command scope commits one canonical planned record", async () => {
  const f = await enterFixture(), adapter = await f.createAdapter();
  let mutex: OperationMutex | undefined;
  try {
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const held = mutex, before = await adapter.observe();
    const command = { operation: "execute-migration" as const, request: { ...f.request, requestId: "public-enter-original-key" } };
    let scope: ControllerCommandScope | undefined, firstLock: SourceLock | undefined;
    const transactionView = await adapter.withSourceLock("control", async lock => {
      firstLock = lock;
      const begun = await beginControllerCommand(adapter, held, lock, command); scope = begun.scope;
      assert.equal(begun.prefix.status, "new");
      return stageControllerEnter(begun.scope, lock, f.options);
    });
    assert(scope && firstLock); assertControllerLockCompleted(scope, firstLock);
    const current = await f.observe(), chain = await verifyJournalChain(store, transactionView.node.reference);
    assert.equal(chain.nodes.length, 1); const record = chain.nodes[0]!.record;
    assert.equal(record.event, "enter"); assert.equal(record.formatVersion, 2);
    assert.equal(record.requestId, command.request.requestId);
    assert.equal(record.requestDigest, maintenanceRequestDigest(command));
    assert.notEqual(record.requestDigest, digestJson({ operation: "internal-enter", request: command.request }));
    assert.equal(current.state.admission, "draining"); assert.equal(current.state.journalDigest, transactionView.node.reference.sha256);
    assert.equal(current.state.fenceEpoch, before.state.fenceEpoch + 1);
    assert.equal(current.state.ownerGeneration, before.state.ownerGeneration + 1);
    assert.equal(current.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
    assert.deepEqual(current.clients, before.clients);
    await held.release(); mutex = undefined;
    await assert.rejects(enterMaintenance(f.options, command.request), { code: "request_conflict" });
  } finally { try { await mutex?.release(); } finally { await adapter.close(); await f.close(); } }
});

nativeTest("#152 C3 public enter SQLite: copied command scope cannot publish or anchor", async () => {
  const f = await enterFixture(), adapter = await f.createAdapter();
  let mutex: OperationMutex | undefined;
  try {
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
    const held = mutex, before = await adapter.observe(), files = await inventory(store.root);
    await adapter.withSourceLock("control", async lock => {
      const { scope } = await beginControllerCommand(adapter, held, lock, { operation: "execute-migration", request: f.request });
      await assert.rejects(stageControllerEnter({ ...scope }, lock, f.options), { code: "maintenance_lost" });
    });
    assert.deepEqual(await adapter.observe(), before); assert.deepEqual(await inventory(store.root), files);
  } finally { try { await mutex?.release(); } finally { await adapter.close(); await f.close(); } }
});

nativeTest("#152 C3 service SQLite: new execute reaches a concrete gate, and same-key planned replay writes nothing", async () => {
  const f = await enterFixture("sqlite", { drainClient: true });
  try {
    const command = { operation: "execute-migration" as const, request: { ...f.request, requestId: "complete-public-execute" } };
    const result = await runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "blocked"); if (result.status !== "blocked") throw new Error("unqualified source cannot issue ready");
    assert.equal(result.lastVerifiedPhase, "planned"); assert.equal(result.observedAnchor?.phase, "planned");
    assert(result.blockers.some(item => ["source_writer_active", "source_writer_unknown", "drain_incomplete", "unsupported_durability"].includes(item.code)));
    const observed = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    assert(observed.state.journalRecordRef && observed.state.journalDigest);
    const anchored = await store.readAnchoredJournal({ ref: observed.state.journalRecordRef, sha256: observed.state.journalDigest });
    const chain = await verifyJournalChain(store, anchored);
    assert.equal(chain.nodes.length, 1); assert.equal(chain.nodes[0]!.record.requestDigest, maintenanceRequestDigest(command));
    await f.sourceClient!.refresh(); await f.sourceClient!.waitForDrain();
    const stable = await f.observe(), files = await inventory(store.root);
    const replay = await runMaintenanceServiceCommand(f.options, command);
    assert.equal(replay.status, "paused"); if (replay.status !== "paused") throw new Error("read-only exact planned prefix required");
    assert.deepEqual(replay.ref.journal, anchored);
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(store.root), files);
    const wrongDomain = await runMaintenanceServiceCommand(f.options, { operation: "resume-migration", request: command.request });
    assert.equal(wrongDomain.status, "blocked");
    if (wrongDomain.status !== "blocked") throw new Error("same key cannot change public operation");
    assert(wrongDomain.blockers.some(item => item.code === "request_conflict"));
    assert.deepEqual(await f.observe(), stable);
  } finally { await f.close(); }
});

sourceFileTest("#152 C3 service SQLite: one original owner completes the full public resume and every actual source close", async () => {
  const f = await serviceFixture("sqlite", { sessions: true });
  try {
    const command = { operation: "resume-migration" as const, request: { ...f.request, requestId: "public-complete-resume" } };
    const result = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "snapshot_ready"); if (result.status !== "snapshot_ready") throw new Error("actual ready required");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const chain = await verifyJournalChain(store, result.ref.journal);
    assert.deepEqual(chain.nodes.map(node => node.record.event), ["enter", "capture", "takeover", "capture", "ready"]);
    for (const node of chain.nodes.slice(1)) {
      assert.equal(node.record.requestId, command.request.requestId);
      assert.equal(node.record.requestDigest, maintenanceRequestDigest(command));
      assert.equal(node.record.formatVersion, 3);
    }
    const first = chain.nodes[1]!.record, selected = chain.nodes[3]!.record;
    assert.deepEqual(selected.frozen, first.frozen);
    const receipt = await store.readJson(result.snapshot, "receipt") as { capture: { journal: unknown } };
    assert.deepEqual(receipt.capture.journal, chain.nodes[3]!.reference);
    const events = f.state.events;
    assert.equal(events.filter(event => event.event === "owner").length, 1);
    assert.equal(new Set(events.map(event => event.owner)).size, 1);
    assert.equal(events.filter(event => event.event === "mutex-acquired").length, 1);
    const ended = events.filter(event => event.event === "source-end");
    assert.deepEqual(ended.map(event => event.kind), ["control", "control", "control", "snapshot", "control"]);
    assert.equal(new Set(ended.map(event => event.lock)).size, 5);
    for (const event of ended) {
      assert(event.lock); const outcome = f.sql.controlSqlOutcome(event.lock);
      assert.equal(outcome.commitReturned, true); assert.equal(outcome.localSourceHandleClosed, true);
      assert.equal(outcome.failureObserved, false);
      await assert.rejects(event.lock.assertHeld(), { code: "maintenance_lost" });
    }
    const lastSource = events.findLastIndex(event => event.event === "source-end");
    assert(events.findIndex(event => event.event === "mutex-release-begin") > lastSource);
    assert(events.findIndex(event => event.event === "adapter-close-end") > lastSource);
    // This test process is still alive. A second factory cannot classify the
    // first real controller as exited merely because its adapter has closed.
    const stable = await f.observe(), files = await inventory(store.root);
    const replay = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(replay.status, "blocked"); if (replay.status !== "blocked") throw new Error("old live controller is not a fresh ready permit");
    assert.equal(replay.observedAnchor?.journal.sha256, result.ref.journal.sha256);
    assert(replay.blockers.some(blocker => ["source_writer_active", "source_writer_unknown"].includes(blocker.code)));
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(store.root), files);
    const next = await f.service.runMaintenanceServiceCommand(f.options, { operation: "resume-migration",
      request: { ...f.request, requestId: "same-process-new-owner-must-not-end-old-owner", expectedPhase: "snapshot_ready",
        expectedJournalDigest: result.ref.journal.sha256 } });
    assert.equal(next.status, "blocked");
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(store.root), files);
  } finally { await f.close(); }
});

nativeTest("#152 C3 service SQLite: undefined primary and two actual cleanup occurrences retain their exact values", async t => {
  const f = await enterFixture("sqlite", { drainClient: true }), cleanup = new Error("same actual rollback and close failure");
  let primary = false, rollback = 0, closed = 0;
  const execute = Database.prototype.exec, close = Database.prototype.close, prepare = Database.prototype.prepare;
  try {
    t.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
      if (this.name === f.file && sql.startsWith("UPDATE storage_maintenance SET admission=")) { primary = true; throw undefined; }
      return Reflect.apply(prepare, this, [sql]);
    });
    t.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
      const result = Reflect.apply(execute, this, [sql]);
      if (primary && this.name === f.file && sql === "ROLLBACK") { rollback++; throw cleanup; }
      return result;
    });
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      const result = Reflect.apply(close, this, []);
      if (primary && rollback > 0 && closed === 0 && this.name === f.file) { closed++; throw cleanup; }
      return result;
    });
    let failed = false, first: unknown;
    try { await runMaintenanceServiceCommand(f.options, { operation: "execute-migration", request: f.request }); }
    catch (error) { failed = true; first = error; }
    assert.equal(primary, true); assert.equal(rollback, 1); assert.equal(closed, 1); assert.equal(failed, true);
    assert(first instanceof AggregateError); assert.equal(first.cause, undefined); assert.equal(first.errors[0], undefined);
    assert.equal(first.errors.filter(error => error === cleanup).length, 2,
      "independent real rollback and close events cannot be replaced by generic errors or deduplicated by value");
    const current = await f.observe();
    assert.equal(current.state.journalSequence, 0); assert.equal(current.state.admission, "open");
  } finally { t.mock.restoreAll(); await f.close(); }
});

sourceFileTest("#152 C3 guard SQLite: actual original ready window grants only scoped immutable guards and keeps undefined failure sticky", async t => {
  const f = await serviceFixture(), retained: VerifiedMaintenanceGuard[] = [];
  let consumed = 0, observedFailure = false, failedNativeRead = 0;
  try {
    f.state.afterSourceClose = async (_completed, stage) => {
      if (stage !== 5) return;
      const scope = f.state.scopes[0], owner = f.state.events[0]?.owner;
      assert(scope && owner);
      await owner.adapter.withSourceLock("snapshot", async lock => {
        const current = await f.writer.assertControllerCommandWindow(scope, lock), head = current.chain?.nodes.at(-1);
        assert(head?.record.snapshot); const ref = captureReference(head), receipt = parseReceipt(await current.store.readJson(head.record.snapshot, "receipt"));
        const consumer = await f.guard.createVerifiedMaintenanceConsumer(scope, lock);
        const value = await consumer.withVerifiedMaintenance(ref, receipt, async guard => {
          retained.push(guard); consumed++;
          assert(Object.isFrozen(guard)); assert(Object.isFrozen(guard.maintenance.journal)); assert(Object.isFrozen(guard.snapshot.capture.source));
          const first = guard.assertCurrent(), concurrent = guard.assertCurrent();
          assert.strictEqual(concurrent, first, "parallel assertions retain the original Promise"); await first;
          await assert.rejects(f.guard.assertVerifiedMaintenanceGuard({ ...guard }), { code: "maintenance_lost" });
          await assert.rejects(f.guard.assertVerifiedMaintenanceGuard({ ...guard, assertCurrent: guard.assertCurrent.bind(guard) }), { code: "maintenance_lost" });
          return "trusted actual callback value";
        });
        assert.equal(value, "trusted actual callback value");
        await assert.rejects(retained[0]!.assertCurrent(), { code: "maintenance_lost" });
        // A later actual read failure cannot be forgotten merely because the
        // trusted callback catches it and returns an otherwise normal value.
        await consumer.withVerifiedMaintenance(ref, receipt, async guard => {
          retained.push(guard); const observe = lock.observeSourceClients.bind(lock);
          let armed = true;
          t.mock.method(lock, "observeSourceClients", async () => {
            const raw = await observe();
            if (armed) { armed = false; failedNativeRead++; throw undefined; }
            return raw;
          });
          try { await guard.assertCurrent(); }
          catch (error) { observedFailure = true; assert.equal(error, undefined); }
          let repeated = false;
          try { await guard.assertCurrent(); }
          catch (error) { repeated = true; assert.equal(error, undefined); }
          assert.equal(repeated, true);
          return "caught failures are not success";
        });
      });
    };
    let rejected = false, failure: unknown;
    try { await f.service.runMaintenanceServiceCommand(f.options,
      { operation: "resume-migration", request: { ...f.request, requestId: "actual-trusted-guard" } }); }
    catch (error) { rejected = true; failure = error; }
    assert.equal(rejected, true); assert.equal(failure, undefined);
    assert.equal(consumed, 1); assert.equal(observedFailure, true); assert.equal(failedNativeRead, 1);
    for (const guard of retained) await assert.rejects(guard.assertCurrent(), { code: "maintenance_lost" });
    const observed = await f.observe();
    assert.equal(observed.state.admission, "sealed"); assert.equal(observed.state.journalSequence, 5);
  } finally { t.mock.restoreAll(); await f.close(); }
});

sourceFileTest("#152 C3 guard SQLite: a forgotten whole consumer retains its original callback through real source close", async () => {
  const f = await serviceFixture();
  let retained: VerifiedMaintenanceGuard | undefined, source: SourceLock | undefined;
  let entered!: () => void, release!: () => void, closing!: () => void;
  const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const callbackClosing = new Promise<void>(resolve => { closing = resolve; });
  try {
    f.state.afterSourceClose = async (_completed, stage) => {
      if (stage !== 5) return;
      const scope = f.state.scopes[0], owner = f.state.events[0]?.owner;
      assert(scope && owner);
      const outer = owner.adapter.withSourceLock("snapshot", async lock => {
        source = lock;
        const current = await f.writer.assertControllerCommandWindow(scope, lock), head = current.chain?.nodes.at(-1);
        assert(head?.record.snapshot);
        const consumer = await f.guard.createVerifiedMaintenanceConsumer(scope, lock);
        const original = consumer.withVerifiedMaintenance(captureReference(head),
          parseReceipt(await current.store.readJson(head.record.snapshot, "receipt")), async guard => {
            retained = guard; entered(); await gate; throw undefined;
          });
        void original.catch(() => undefined); // Deliberately forget the whole consumer in this source callback.
        await Promise.race([callbackEntered, original.then(() => { throw new Error("consumer completed before callback entry"); })]);
        const barrier = f.consumers.finishControllerRestoreCallback(lock);
        assert(barrier, "the complete callback between assertions must already be registered");
        assert.strictEqual(f.consumers.finishControllerRestoreCallback(lock), barrier);
        assert.notEqual(f.sql.controlSqlOutcome(lock).commitStarted, true);
        assert.notEqual(f.sql.controlSqlOutcome(lock).localSourceHandleClosed, true);
        closing(); return "a source callback return is not completion";
      });
      void outer.catch(() => undefined);
      try {
        await Promise.race([callbackClosing, outer.then(() => { throw new Error("source completed before its callback close entry"); })]);
        assert(source); assert.notEqual(f.sql.controlSqlOutcome(source).localSourceHandleClosed, true);
      } finally { release(); }
      // The real adapter must wait for the same callback barrier and preserve
      // its undefined failure; a returned callback value must never COMMIT.
      await outer;
    };
    let rejected = false, failure: unknown;
    let returned: Awaited<ReturnType<typeof f.service.runMaintenanceServiceCommand>> | undefined;
    try { returned = await f.service.runMaintenanceServiceCommand(f.options,
      { operation: "resume-migration", request: { ...f.request, requestId: "forgotten-whole-guard-consumer" } }); }
    catch (error) { rejected = true; failure = error; }
    // A domain blocker can return before the late consumer callback is entered.
    // Preserve that boundary without emitting source values or changing the failure.
    assert.equal(rejected, true, "the original consumer must reject; observed service boundary: " + JSON.stringify({
      status: returned?.status ?? null,
      phase: returned && "lastVerifiedPhase" in returned ? returned.lastVerifiedPhase
        : returned && "phase" in returned ? returned.phase : returned && "lastPhase" in returned ? returned.lastPhase : null,
      blockers: returned && "blockers" in returned ? [...new Set(returned.blockers.map(item => item.code))].slice(0, 16) : [],
      sourceEntered: source !== undefined, consumerEntered: retained !== undefined,
      stages: f.state.events.filter(event => event.event === "source-begin" || event.event === "source-end")
        .slice(-16).map(({ event, stage, kind }) => ({ event, stage, kind })),
    }));
    assert.equal(failure, undefined);
    assert(source && retained);
    const outcome = f.sql.controlSqlOutcome(source);
    assert.equal(outcome.commitStarted, false); assert.equal(outcome.commitReturned, false);
    assert.equal(outcome.localSourceHandleClosed, true); assert.equal(outcome.failureObserved, true);
    await assert.rejects(retained.assertCurrent(), { code: "maintenance_lost" });
    const observed = await f.observe();
    assert.equal(observed.state.admission, "sealed"); assert.equal(observed.state.journalSequence, 5);
  } finally { release(); await f.close(); }
});

nativeTest("#152 C3 actual CLI SQLite: production execute, read-only replay/inspect, and planned cancel retain exact public values", async () => {
  const f = await enterFixture("sqlite", { drainClient: true });
  try {
    const request = { ...f.request, requestId: "actual-cli-public-execute" };
    const executed = runActualMaintenanceCli(f, "execute", request);
    assert.equal(executed.status, 1);
    const outcome = JSON.parse(executed.stdout);
    assert.equal(outcome.failure, null); assert.equal(outcome.result.status, "blocked");
    assert.equal(outcome.result.observedAnchor?.phase, "planned");
    assert(outcome.result.blockers.some((blocker: { code: string }) =>
      ["source_writer_active", "source_writer_unknown", "drain_incomplete", "unsupported_durability"].includes(blocker.code)));
    const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    assert(before.state.journalRecordRef && before.state.journalDigest);
    const journal = await store.readAnchoredJournal({ ref: before.state.journalRecordRef, sha256: before.state.journalDigest });
    const chain = await verifyJournalChain(store, journal);
    assert.equal(chain.nodes.length, 1);
    assert.equal(chain.nodes[0]!.record.requestDigest, maintenanceRequestDigest({ operation: "execute-migration", request }));
    await f.sourceClient!.refresh(); await f.sourceClient!.waitForDrain();
    const stable = await f.observe(), files = await inventory(store.root);
    const replay = runActualMaintenanceCli(f, "execute", request), replayed = JSON.parse(replay.stdout);
    assert.equal(replay.status, 0); assert.equal(replayed.failure, null); assert.equal(replayed.result.status, "paused");
    assert.deepEqual(replayed.result.ref.journal, journal);
    const inspected = runActualMaintenanceCli(f, "inspect", request), inspection = JSON.parse(inspected.stdout);
    assert.equal(inspected.status, 0); assert.equal(inspection.failure, null); assert.equal(inspection.result.status, "paused");
    assert.deepEqual(inspection.result.observedAnchor, replayed.result.observedAnchor);
    const cancellation = runActualMaintenanceCli(f, "cancel", { ...request, requestId: "actual-cli-planned-cancel",
      expectedPhase: "planned", expectedJournalDigest: journal.sha256 });
    const cancelled = JSON.parse(cancellation.stdout);
    assert.equal(cancellation.status, 1); assert.equal(cancelled.failure, null); assert.equal(cancelled.result.status, "blocked");
    assert.deepEqual(cancelled.result.blockers.map((item: { code: string }) => item.code), ["request_conflict"]);
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(store.root), files);
    for (const value of [executed, replay, inspected, cancellation]) {
      assert.equal(value.signal, null);
      assert(!value.stdout.includes(f.directory)); assert(!value.stderr.includes(f.directory));
    }
  } finally { await f.close(); }
});

sourceFileTest("#152 C3 inspect SQLite: actual ready child is present, unreadable, then exited before a new owner ends and revalidates it", async t => {
  const f = await serviceFixture();
  let worker: Awaited<ReturnType<typeof startServiceChild>> | undefined;
  const nativeOpen = fs.promises.open;
  try {
    const command = { operation: "resume-migration" as const, request: { ...f.request, requestId: "actual-ready-child" } };
    worker = await startServiceChild(f, command);
    const ready = worker.result;
    assert.equal(ready.status, "snapshot_ready"); if (ready.status !== "snapshot_ready") throw new Error("actual child ready required");
    const stable = await f.observe(), files = await inventory(f.reference.controlRoot);
    const controller = stable.clients.find(row => row.entrypoint === "maintenance-controller");
    assert(controller && typeof controller.process_identity_json === "string");
    assert.equal(JSON.parse(controller.process_identity_json).pid, worker.pid);
    assert.equal(controller.ended_at, null);
    const inspect = () => inspectMaintenance(f.options, inspectCommand(f));
    const present = await inspect();
    assert.equal(present.status, "blocked"); if (present.status !== "blocked") throw new Error("present controller must block");
    assert(present.blockers.some(item => item.code === "source_writer_active" && item.subjectRef.startsWith("controller-process-present:")));
    assert.equal(present.observedAnchor?.journal.sha256, ready.ref.journal.sha256);
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(f.reference.controlRoot), files);

    const proc = `/proc/${worker.pid}`; let denied = 0;
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof nativeOpen>) => {
      if (args[0] === proc) { denied++; throw Object.assign(new Error("owned native-read fault"), { code: "EACCES" }); }
      return Reflect.apply(nativeOpen, fs.promises, args);
    });
    syncBuiltinESMExports();
    const unreadable = await inspect();
    assert(denied > 0); assert.equal(unreadable.status, "blocked");
    if (unreadable.status !== "blocked") throw new Error("unreadable native identity must block");
    assert(unreadable.blockers.some(item => item.code === "source_writer_unknown" && item.subjectRef.startsWith("controller-native-unreadable:")));
    assert.deepEqual(unreadable.observedAnchor, present.observedAnchor);
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(f.reference.controlRoot), files);

    const completion = await worker.stop();
    assert.deepEqual(completion.exit, { code: 0, signal: null }); assert.deepEqual(completion.close, completion.exit);
    const exited = await inspect();
    assert.equal(exited.status, "blocked"); if (exited.status !== "blocked") throw new Error("unended exited controller needs a successor");
    assert(exited.blockers.some(item => item.code === "source_writer_unknown" && item.subjectRef.startsWith("controller-ended-observation-required:")));
    assert.deepEqual(exited.observedAnchor, present.observedAnchor);
    const replay = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(replay.status, "blocked"); assert.equal(replay.observedAnchor?.journal.sha256, ready.ref.journal.sha256);
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(f.reference.controlRoot), files);

    // The native reader is actually called each time. Fault only its second
    // returned observation, never SQL or a successful native fact/permit. A
    // changed anchor or raw row must discard the first diagnostic completely.
    for (const changed of ["anchor", "raw"] as const) {
      let reads = 0;
      f.state.onOwner = owner => {
        const observe = owner.adapter.observeSourceClients.bind(owner.adapter);
        owner.adapter.observeSourceClients = async () => {
          const value = await observe(); if (++reads !== 2) return value;
          return changed === "anchor" ? { ...value, state: { ...value.state, journalDigest: "0".repeat(64) } }
            : { ...value, rows: value.rows.map((row, index) => index === 0 ? { ...row,
              last_observed_at: ["text", Buffer.from("2099-01-01T00:00:00.000Z").toString("hex")] as const } : row) };
        };
      };
      await assert.rejects(f.service.runMaintenanceServiceCommand(f.options, inspectCommand(f)), { code: "maintenance_lost" });
      assert.equal(reads, 2); delete f.state.onOwner;
      assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(f.reference.controlRoot), files);
    }
    const next = { operation: "resume-migration" as const, request: { ...f.request, requestId: "actual-new-owner-after-child-exit",
      expectedPhase: "snapshot_ready" as const, expectedJournalDigest: ready.ref.journal.sha256 } };
    const resumed = await f.service.runMaintenanceServiceCommand(f.options, next);
    assert.equal(resumed.status, "snapshot_ready", JSON.stringify(resumed));
    if (resumed.status !== "snapshot_ready") throw new Error("new owner must actually revalidate ready");
    const after = await f.observe();
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const chain = await verifyJournalChain(store, resumed.ref.journal), takeover = chain.nodes.at(-1)!;
    assert.equal(takeover.record.event, "takeover"); assert.equal(takeover.record.sequence, 6);
    assert.equal(takeover.record.requestId, next.request.requestId); assert.equal(takeover.record.requestDigest, maintenanceRequestDigest(next));
    assert(takeover.record.formatVersion === 3 && takeover.record.controlProof?.kind === "control-successor");
    assert(takeover.record.controlProof.changes.some(change => change.kind === "client-observation" && change.effect === "ended-observed"));
    assert.equal(after.clients.filter(row => row.entrypoint === "maintenance-controller").length, 2);
    assert(after.clients.find(row => row.client_id === controller.client_id)?.ended_at);
    assert.deepEqual(resumed.snapshot, ready.snapshot, "the new owner reuses the original closed receipt and capture");
    for (const entry of files.filter(entry => /^(journals|receipts|verifications)\//.test(entry.path)))
      assert.equal(sha256(await readFile(path.join(store.root, entry.path))), entry.digest);
  } finally {
    delete f.state.onOwner; t.mock.restoreAll(); syncBuiltinESMExports();
    try { await worker?.stop(); } finally { await f.close(); }
  }
});

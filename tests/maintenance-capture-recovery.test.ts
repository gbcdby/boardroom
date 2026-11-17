import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Database from "better-sqlite3";
import { recoveryFixture } from "./fixtures/maintenance-capture-recovery.ts";
import { errorLeaves, rejected } from "./fixtures/maintenance-backup-lifecycle.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { captureSnapshotMaintenance } from "../src/server/storage/maintenance/capture.ts";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { finishControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

const supported = process.platform === "linux";
const nativeTest = supported ? test : test.skip;
const uncertainFixtureCleanup: (() => Promise<void>)[] = [];
after(async () => {
  const failures: unknown[] = [];
  for (const close of uncertainFixtureCleanup) try { await close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "C2 private fixture cleanup failed");
});
before(() => {
  if (!supported) return;
  const build = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);
});

nativeTest("#152 C2 sqlite: one real owner commits first Jq, takeover, recapture before D/Md/B/U", async t => {
  const f = await recoveryFixture("sqlite", { sessions: true, initialGeneration: 6 });
  try {
    const before = await f.observe();
    const result = await f.captureSnapshot(f.options, f.request);
    assert.equal("kind" in result && result.kind, "unverified-bundle");
    if (!("kind" in result) || result.kind !== "unverified-bundle") throw new Error("unverified bundle required");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const closure = await verifyRestoreBundleClosure(store, result.bundle, result.publication);
    assert.deepEqual(closure.chain.nodes.map(node => node.record.event), ["enter", "capture", "takeover", "capture"]);
    assert.deepEqual(closure.chain.nodes.map(node => node.record.ownerGeneration), [7, 7, 8, 8]);
    const first = closure.chain.nodes[1]!.record, last = closure.chain.nodes[3]!.record;
    assert(first.formatVersion === 2 && first.frozen && first.sourceClients);
    assert(last.formatVersion === 2 && last.frozen && last.sourceClients);
    assert.deepEqual(last.frozen, first.frozen); assert.deepEqual(last.sourceClients, first.sourceClients);
    assert.equal(last.sourceClients.receiptGeneration, "7");
    assert.deepEqual(closure.bundle.capture, result.ref);
    assert.equal(closure.manifests.controlRows.storage_maintenance[0]!.owner_generation, "8");
    assert.deepEqual(closure.manifests.controlRows.storage_source_clients, before.manifests.controlRows.storage_source_clients);
    const after = await f.observe();
    assert.equal(after.state.admission, "sealed"); assert.equal(after.state.ownerGeneration, 8);
    assert.equal(after.state.journalSequence, 4); assert.equal(after.state.journalDigest, result.ref.journal.sha256);
    assert.equal(after.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
    assert.equal(f.events.filter(e => e.event === "owner").length, 1);
    assert.equal(f.events.filter(e => e.event === "mutex-acquired").length, 1);
    assert.deepEqual(f.events.filter(e => e.event.startsWith("source-")).map(e => [e.event, e.kind, e.stage]),
      [1, 2, 3, 4].flatMap(stage => [["source-begin", stage === 4 ? "snapshot" : "control", stage],
        ["source-end", stage === 4 ? "snapshot" : "control", stage]]));
    assert.deepEqual(f.events.slice(-4).map(e => e.event),
      ["mutex-release-begin", "mutex-release-end", "adapter-close-begin", "adapter-close-end"]);
    assert.equal(f.profile.state.handles.size, 0);
    assert.deepEqual(Object.keys(result).sort(), ["kind", "ref", "bundle", "publication"].sort());
    assert.deepEqual(Object.keys(result.ref).sort(),
      ["migrationId", "source", "planDigest", "fenceEpoch", "journal", "journalSequence", "ownerGeneration"].sort());
    const nodes = closure.chain.nodes.slice(1);
    assert(nodes.every(node => node.record.requestId === f.request.requestId
      && node.record.requestDigest === digestJson({ operation: "internal-capture-snapshot", request: f.request })));
    assert.equal(closure.chain.nodes[2]!.record.frozen, null);
    assert.equal(closure.chain.nodes[2]!.record.formatVersion === 2 && closure.chain.nodes[2]!.record.sourceClients, null);
    assert(nodes.every(node => node.record.snapshot === null));
    assert.equal(closure.files.entries.filter(entry => entry.sourceRoot === "managed-sessions" && entry.kind === "file").length, 1);
    // Existing B/U bytes confer no retry authority. Replaying the key reads the
    // exact anchored Q and fresh source state without even touching those refs.
    const originalBundle = await readFile(store.pathFor(result.bundle));
    await writeFile(store.pathFor(result.bundle), "not a selectable bundle");
    t.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("same-key progress cannot publish"); });
    t.mock.method(ArtifactStore.prototype, "putSourceFilePayload", async () => { throw new Error("same-key progress cannot capture"); });
    f.state.events.length = 0;
    const replay = await f.captureSnapshot(f.options, f.request);
    assert.deepEqual(replay, { kind: "anchored-progress", reached: "recapture", ref: result.ref });
    assert.deepEqual(await f.observe(), after); assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
    t.mock.restoreAll(); await writeFile(store.pathFor(result.bundle), originalBundle);
    await assert.rejects(f.capture(f.options, f.request), { code: "request_conflict" }, "C1 cannot inherit the C2 request domain");
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 C2 sqlite: each committed prefix replays fresh without writes and a new key always takes over again", async t => {
  for (const stopped of [1, 2, 3] as const) await t.test("after independent commit " + stopped, async child => {
    const f = await recoveryFixture("sqlite"), failure = new Error("response after actual source completion");
    try {
      f.recovery.afterSourceClose = stage => { if (stage === stopped) throw failure; };
      await assert.rejects(f.captureSnapshot(f.options, f.request), error => error === failure);
      assert.equal(f.events.filter(e => e.event === "source-end").length, stopped);
      delete f.recovery.afterSourceClose;
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const names = await readdir(path.join(store.root, "journals", f.plan.migrationId));
      assert.equal(before.state.journalSequence, stopped + 1); assert.equal(before.state.admission, "sealed");
      assert.equal(before.state.ownerGeneration, stopped === 1 ? 1 : 2);
      child.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("no publication during replay"); });
      child.mock.method(ArtifactStore.prototype, "putBytes", async () => { throw new Error("no bytes during replay"); });
      child.mock.method(ArtifactStore.prototype, "putSourceFilePayload", async () => { throw new Error("no new source payload"); });
      f.state.events.length = 0;
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.reached, stopped === 1 ? "first-capture" : stopped === 2 ? "takeover" : "recapture");
      assert.equal(replay.ref.ownerGeneration, before.state.ownerGeneration);
      assert.equal(replay.ref.journalSequence, before.state.journalSequence);
      assert.equal(replay.ref.journal.sha256, before.state.journalDigest);
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
      assert.deepEqual(await readdir(path.join(store.root, "journals", f.plan.migrationId)), names);
      child.mock.restoreAll();
      // Cover actual capture, takeover and observation starting heads. The
      // observation is a private ordinary control fixture, never a new capture.
      const head = stopped === 3 ? await f.advance("observation") : replay.ref.journal;
      const request: ContinueRequest = { ...f.request, requestId: "explicit-next", expectedPhase: "quiesced", expectedJournalDigest: head.sha256 };
      f.state.events.length = 0; f.events.length = 0;
      const next = await f.captureSnapshot(f.options, request);
      assert("kind" in next && next.kind === "unverified-bundle");
      assert.equal(next.ref.ownerGeneration, before.state.ownerGeneration + 1);
      assert.deepEqual(f.events.filter(e => e.event === "source-end").map(e => e.kind), ["control", "control", "snapshot"]);
      assert(!f.state.events.includes("capture-begin"), "all successor paths retain the original exact Fs");
      const chain = await verifyJournalChain(store, next.ref.journal);
      assert.deepEqual(chain.nodes.slice(-2).map(n => n.record.event), ["takeover", "capture"]);
      const first = chain.nodes.find(n => n.record.event === "capture")!.record, last = chain.nodes.at(-1)!.record;
      assert.equal(first.formatVersion, 2); assert.equal(last.formatVersion, 2);
      assert.deepEqual(last.frozen, first.frozen);
      assert.deepEqual(last.formatVersion === 2 && last.sourceClients, first.formatVersion === 2 && first.sourceClients);
      await assert.rejects(f.captureSnapshot(f.options, f.request), { code: "phase_conflict" }, "a later key prevents stale progress return");
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: strict input, request domains, stale expectations and original planned provenance fail before publication", async t => {
  const f = await recoveryFixture("sqlite");
  try {
    const before = await f.observe();
    for (const value of [{ ...f.request, adapter: {} }, { ...f.request, stage: "takeover" }, { ...f.request, proof: {} },
      { ...f.request, success: true }, { ...f.request, plan: { ...f.request.plan, verified: true } }])
      await assert.rejects(f.captureSnapshot(f.options, value as ContinueRequest), { code: "request_conflict" });
    for (const value of [{ ...f.request, expectedPhase: null }, { ...f.request, expectedJournalDigest: "a".repeat(64) }])
      await assert.rejects(f.captureSnapshot(f.options, value), { code: "phase_conflict" });
    assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
    assert.equal((await f.capture(f.options, f.request)).status, "paused");
    await assert.rejects(f.captureSnapshot(f.options, f.request), { code: "request_conflict" });
    const current = await f.observe();
    await assert.rejects(f.captureSnapshot(f.options, { ...f.request, requestId: "other", expectedPhase: "quiesced" }), { code: "phase_conflict" });
    assert.deepEqual(await f.observe(), current);
  } finally { await f.close(); }
  await t.test("planned takeover is not an original-generation receipt origin", async () => {
    const f = await recoveryFixture("sqlite");
    try {
      const head = await f.advance("takeover"), before = await f.observe();
      await assert.rejects(f.captureSnapshot(f.options, { ...f.request, expectedJournalDigest: head.sha256 }), { code: "phase_conflict" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
    } finally { await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: a legal v1 planned prefix gets one v2 first capture and retains its original bytes", async () => {
  const f = await recoveryFixture("sqlite", { legacyPlanned: true, initialGeneration: 4, changeBusinessBeforeEnter: true });
  try {
    const head = await f.advance("observation"), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    const original = await readFile(store.pathFor(head)), before = await f.observe();
    const result = await f.captureSnapshot(f.options, { ...f.request, expectedJournalDigest: head.sha256 });
    assert("kind" in result && result.kind === "unverified-bundle");
    const chain = await verifyJournalChain(store, result.ref.journal);
    assert.deepEqual(chain.nodes.map(n => n.record.formatVersion), [1, 1, 2, 2, 2]);
    assert.deepEqual(chain.nodes.map(n => n.record.ownerGeneration), [5, 5, 5, 6, 6]);
    assert.deepEqual(await readFile(store.pathFor(head)), original);
    assert.equal((await f.observe()).manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
  } finally { await f.close(); }
});

nativeTest("#152 C2 sqlite: successor facts bind original receipt, exact current head and complete chain", async t => {
  const f = await recoveryFixture("sqlite");
  try {
    const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
    if (first.status !== "paused") throw new Error("first capture required");
    const request: ContinueRequest = { ...f.request, requestId: "takeover-proof", expectedPhase: "quiesced", expectedJournalDigest: first.ref.journal.sha256 };
    const before = await f.observe();
    for (const point of ["kind", "capture", "head", "generation", "chain"] as const) await t.test(point, async () => {
      f.recovery.onLock = lock => {
        const real = lock.withSourceClientFacts;
        lock.withSourceClientFacts = (plan, consume) => real(plan, facts => consume({ ...facts, origin: { ...facts.origin,
          ...(point === "kind" ? { kind: "current-generation" as const } : {}),
          ...(point === "capture" ? { capture: null } : {}),
          ...(point === "head" ? { head: f.entered.ref.journal } : {}),
          ...(point === "generation" ? { receiptGeneration: facts.origin.receiptGeneration + 1 } : {}),
          ...(point === "chain" ? { chain: { ...facts.origin.chain, nodes: facts.origin.chain.nodes.slice(1) } } : {}),
        } }));
      };
      await assert.rejects(f.captureSnapshot(f.options, request));
      assert.deepEqual(await f.observe(), before);
    });
  } finally { delete f.recovery.onLock; await f.close(); }
});

nativeTest("#152 C2 sqlite: automatic final failure at T Q or snapshot never advances the next stage", async t => {
  for (const failedStage of [2, 3, 4]) await t.test("stage " + failedStage, async () => {
    const f = await recoveryFixture("sqlite"), failure = new MaintenanceFailure("source_changed", "C2 automatic final");
    let returned = false, finalReads = 0, anchors = 0;
    try {
      f.recovery.onLock = (lock, stage) => {
        if (stage !== failedStage) return;
        const facts = lock.withSourceClientFacts, raw = lock.observeSourceClients, anchor = lock.anchor;
        lock.observeSourceClients = async () => { if (returned) { finalReads++; throw failure; } return raw(); };
        lock.withSourceClientFacts = (plan, consume) => facts(plan, async actual => { const value = await consume(actual); returned = true; return value; });
        lock.anchor = async change => { anchors++; return anchor(change); };
      };
      await assert.rejects(f.captureSnapshot(f.options, f.request), error => error === failure);
      assert(returned && finalReads > 0); assert.equal(anchors, 0);
      assert.equal(f.events.filter(e => e.event === "source-begin").length, failedStage);
      const actual = await f.observe();
      assert.equal(actual.state.journalSequence, failedStage === 4 ? 4 : failedStage);
      assert.equal(actual.state.admission, "sealed"); assert.equal(f.profile.state.handles.size, 0);
      const names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      assert.equal(names.length, failedStage === 4 ? 4 : failedStage + 1, "durable Jq may exist only as an unselected orphan");
      delete f.recovery.onLock;
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.deepEqual((await f.observe()).state, actual.state);
    } finally { await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: actual T COMMIT before/after and Q close failures never start the following stage", async t => {
  for (const point of ["commit-before", "commit-after", "source-close"] as const) await t.test(point, async child => {
    const f = await recoveryFixture("sqlite"), prepare = Database.prototype.prepare, exec = Database.prototype.exec, close = Database.prototype.close;
    const targetStage = point === "source-close" ? 3 : 2, failure = new MaintenanceFailure("maintenance_lost", "C2 " + point);
    let currentStage = 0, target: Database.Database | undefined, injected = 0, automaticFinal = false;
    try {
      f.recovery.onLock = (lock, stage) => {
        currentStage = stage; automaticFinal = false; const facts = lock.withSourceClientFacts;
        lock.withSourceClientFacts = async (plan, consume) => { const value = await facts(plan, consume); automaticFinal = true; return value; };
      };
      child.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
        if (this.name === f.file && currentStage === targetStage && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
          assert(automaticFinal); target = this;
        }
        return prepare.call(this, sql);
      });
      child.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
        if (this === target && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
        const value = exec.call(this, sql);
        if (this === target && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
        return value;
      });
      child.mock.method(Database.prototype, "close", function(this: Database.Database) {
        const value = close.call(this);
        if (this === target && point === "source-close") { injected++; throw failure; }
        return value;
      });
      const outcome = await rejected(f.captureSnapshot(f.options, f.request));
      assert.equal(outcome.failed, true); assert(injected >= 1);
      // The existing facts-source close boundary deliberately exposes this
      // safe error instead of the native close value. C2 must preserve that
      // failure and the actual committed anchor, not fabricate rollback.
      if (point === "source-close") assert(errorLeaves(outcome.error).some(error => error instanceof MaintenanceFailure
        && error.code === "maintenance_lost" && error.message === "storage_maintenance: maintenance_lost (source-client-facts)"));
      else assert(errorLeaves(outcome.error).includes(failure));
      child.mock.restoreAll(); delete f.recovery.onLock;
      const actual = await f.observe(), expectedSequence = point === "commit-before" ? 2 : point === "commit-after" ? 3 : 4;
      assert.equal(actual.state.journalSequence, expectedSequence); assert.equal(actual.state.admission, "sealed");
      assert.equal(actual.state.ownerGeneration, point === "commit-before" ? 1 : 2);
      assert.equal(f.events.filter(e => e.event === "source-begin").length, targetStage);
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress");
      assert.equal(replay.ref.journal.sha256, actual.state.journalDigest);
      assert.deepEqual(await f.observe(), actual);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: T Q and U durability failures retain the prior exact authority", async t => {
  for (const point of ["T-durable", "Q-durable", "U-durable"] as const) await t.test(point, async child => {
    const f = await recoveryFixture("sqlite"), confirm = ArtifactStore.prototype.confirmDurable, put = ArtifactStore.prototype.putJson;
    const failure = new MaintenanceFailure("snapshot_invalid", "C2 " + point);
    let injected = 0;
    try {
      child.mock.method(ArtifactStore.prototype, "confirmDurable", async function(this: ArtifactStore, reference: Parameters<typeof confirm>[0]) {
        const value = await confirm.call(this, reference);
        if (this.root === f.reference.controlRoot && this.kindFor(reference) === "journal") {
          const record = await this.readJson(reference, "journal") as { sequence: number };
          if (point === "T-durable" && record.sequence === 3 || point === "Q-durable" && record.sequence === 4) {
            injected++; throw failure;
          }
        }
        return value;
      });
      child.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, kind: Parameters<typeof put>[0], value: Parameters<typeof put>[1]) {
        const reference = await put.call(this, kind, value);
        if (this.root === f.reference.controlRoot && kind === "publication" && point === "U-durable") { injected++; throw failure; }
        return reference;
      });
      await assert.rejects(f.captureSnapshot(f.options, f.request), error => error === failure);
      assert.equal(injected, 1);
      const actual = await f.observe(); assert.equal(actual.state.journalSequence, point === "T-durable" ? 2 : point === "Q-durable" ? 3 : 4);
      assert.equal(actual.state.admission, "sealed"); assert.equal(f.profile.state.handles.size, 0);
      child.mock.restoreAll();
      const replay = await f.captureSnapshot(f.options, f.request);
      assert("kind" in replay && replay.kind === "anchored-progress"); assert.deepEqual((await f.observe()).state, actual.state);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: actual D read and close throwing undefined remain separate and the original pending owner is settled", async t => {
  const f = await recoveryFixture("sqlite"), open = fs.promises.open;
  let reads = 0, closes = 0, oldOwner: ControllerOwner | undefined;
  try {
    f.recovery.onOwner = owner => { oldOwner = owner; };
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      const handle = await Reflect.apply(open, fs.promises, args);
      if (typeof args[0] === "string" && args[0].startsWith(f.reference.controlRoot + path.sep)
        && args[0].endsWith(path.sep + "database.sqlite") && args[1] === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) {
        const read = handle.read.bind(handle), close = handle.close.bind(handle);
        handle.read = (async (...values: unknown[]) => { await Reflect.apply(read, handle, values); reads++; throw undefined; }) as typeof handle.read;
        handle.close = async () => { closes++; await close(); throw undefined; };
      }
      return handle;
    }); syncBuiltinESMExports();
    const outcome = await rejected(f.captureSnapshot(f.options, f.request));
    assert.equal(outcome.failed, true); assert.equal(reads, 1); assert.equal(closes, 1);
    const errors = errorLeaves(outcome.error); assert.strictEqual(errors[0], undefined);
    assert.equal(errors.filter(value => value === undefined).length, 2);
    assert(oldOwner); assert.equal(oldOwner.adapterClosed, false);
    const actual = await f.observe(); assert.equal(actual.state.journalSequence, 4); assert.equal(actual.state.admission, "sealed");
    t.mock.restoreAll(); syncBuiltinESMExports(); delete f.recovery.onOwner;
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress");
    assert.equal(oldOwner.adapterClosed, true);
    assert.equal(f.events.filter(event => event.owner === oldOwner && event.event === "adapter-close-begin").length, 2);
    assert.deepEqual((await f.observe()).state, actual.state);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

nativeTest("#152 C2 sqlite: actual D body error precedes both independent target and reader cleanup failures", async t => {
  const f = await recoveryFixture("sqlite"), pragma = Database.prototype.pragma, close = Database.prototype.close;
  const first = new Error("C2 D body"), sameCleanup = new Error("same value from two physical closes");
  let armed = false, targetCloses = 0, readerCloses = 0, newOwners = 0;
  try {
    t.mock.method(Database.prototype, "pragma", function(this: Database.Database, ...args: Parameters<typeof pragma>) {
      if (this.name.startsWith(f.reference.controlRoot + path.sep) && this.name.endsWith(path.sep + "database.sqlite")) {
        armed = true; throw first;
      }
      return Reflect.apply(pragma, this, args);
    });
    t.mock.method(Database.prototype, "close", function(this: Database.Database) {
      if (this.name.startsWith(f.reference.controlRoot + path.sep) && this.name.endsWith(path.sep + "database.sqlite")) {
        targetCloses++; close.call(this); throw sameCleanup;
      }
      if (armed && this.name === f.file && this.readonly) { readerCloses++; close.call(this); throw sameCleanup; }
      return close.call(this);
    });
    const outcome = await rejected(f.captureSnapshot(f.options, f.request));
    assert.equal(outcome.failed, true); const errors = errorLeaves(outcome.error);
    assert.strictEqual(errors[0], first); assert.equal(errors.filter(value => value === sameCleanup).length, 2);
    assert.equal(targetCloses, 1); assert.equal(readerCloses, 1);
    t.mock.restoreAll(); f.recovery.onOwner = () => { newOwners++; };
    await assert.rejects(f.captureSnapshot(f.options, f.request));
    await assert.rejects(f.capture(f.options, f.request));
    assert.equal(newOwners, 0, "physically closed fields cannot replace the failed original close proof");
    assert.equal(targetCloses, 1); assert.equal(readerCloses, 1);
    assert.equal((await f.observe()).state.journalSequence, 4);
  } finally {
    t.mock.restoreAll(); uncertainFixtureCleanup.push(() => f.close()); await f.sourceClient?.close();
  }
});

nativeTest("#152 C2 sqlite: a previously created C2 entrant settles the later failed C1 close before advancing", async () => {
  const f = await recoveryFixture("sqlite"), failure = new MaintenanceFailure("maintenance_lost", "C1 close response");
  let committed!: () => void, releaseFirst!: () => void, created!: () => void, releaseSecond!: () => void;
  const firstCommitted = new Promise<void>(resolve => { committed = resolve; }), firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondCreated = new Promise<void>(resolve => { created = resolve; }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  let ordinal = 0, closes = 0, firstOwner: ControllerOwner | undefined;
  let first: ReturnType<typeof f.capture> | undefined, second: ReturnType<typeof f.captureSnapshot> | undefined;
  try {
    f.recovery.onOwner = owner => {
      if (++ordinal === 1) {
        firstOwner = owner;
        const withLock = owner.adapter.withSourceLock.bind(owner.adapter), close = owner.adapter.close.bind(owner.adapter);
        owner.adapter.withSourceLock = async (kind, consume) => { const value = await withLock(kind, consume); committed(); await firstGate; return value; };
        owner.adapter.close = async () => { await close(); closes++; if (closes === 1) throw failure; };
      } else if (ordinal === 2) {
        const observe = owner.adapter.observe.bind(owner.adapter);
        owner.adapter.observe = async () => { created(); await secondGate; return observe(); };
      }
    };
    first = f.capture(f.options, f.request); void first.catch(() => {});
    await Promise.race([firstCommitted, first.then(() => { throw new Error("C1 real COMMIT boundary missing"); })]);
    const before = await f.observe();
    second = f.captureSnapshot(f.options, { ...f.request, requestId: "C2-after-C1", expectedPhase: "quiesced", expectedJournalDigest: before.state.journalDigest });
    void second.catch(() => {});
    await Promise.race([secondCreated, second.then(() => { throw new Error("created entrant boundary missing"); })]);
    releaseFirst(); await assert.rejects(first, error => error === failure); first = undefined;
    assert.equal(closes, 1); releaseSecond();
    const result = await second; second = undefined;
    assert("kind" in result && result.kind === "unverified-bundle");
    assert.equal(closes, 2); assert(firstOwner?.adapterClosed);
    assert.equal(result.ref.ownerGeneration, before.state.ownerGeneration + 1);
    const originalCloseEnd = f.events.findLastIndex(event => event.owner === firstOwner && event.event === "adapter-close-end");
    const secondSource = f.events.findIndex(event => event.owner !== firstOwner && event.event === "source-begin");
    assert(originalCloseEnd < secondSource, "same original cleanup precedes the already-created entrant's source scope");
  } finally {
    releaseFirst(); releaseSecond(); await first?.catch(() => {}); await second?.catch(() => {});
    if (firstOwner) await finishControllerOwner(firstOwner, undefined, undefined, [], "C2 original fixture cleanup");
    await f.close();
  }
});

nativeTest("#152 C2 sqlite: lost mutex at T keeps the actual source reservation until the original operation exits", async () => {
  const f = await recoveryFixture("sqlite");
  let reached!: () => void, resume!: () => void;
  const atT = new Promise<void>(resolve => { reached = resolve; }), continueT = new Promise<void>(resolve => { resume = resolve; });
  let held: OperationMutex | undefined, running: ReturnType<typeof f.captureSnapshot> | undefined;
  let other: Awaited<ReturnType<typeof f.createAdapter>> | undefined;
  try {
    f.recovery.onOwner = owner => {
      const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
      owner.adapter.acquireMutex = async (...args) => held = await acquire(...args);
    };
    f.recovery.onLock = async (_lock, stage) => { if (stage === 2) { reached(); await continueT; } };
    running = f.captureSnapshot(f.options, f.request); void running.catch(() => {});
    await Promise.race([atT, running.then(() => { throw new Error("T source boundary missing"); })]);
    assert(held); await held.release();
    const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    other = await f.createAdapter();
    await assert.rejects(other.acquireMutex(store.identity, (await other.observe()).state), { code: "maintenance_busy" });
    await other.close(); other = undefined;
    resume(); await assert.rejects(running); running = undefined;
    assert.deepEqual((await f.observe()).state, before.state); assert.equal(before.state.journalSequence, 2);
    delete f.recovery.onLock; delete f.recovery.onOwner;
    const replay = await f.captureSnapshot(f.options, f.request);
    assert("kind" in replay && replay.kind === "anchored-progress" && replay.reached === "first-capture");
  } finally { resume(); await running?.catch(() => {}); await other?.close(); await f.close(); }
});

nativeTest("#152 C2 sqlite: production empty registry rejects both planned and sealed starts without Fs Jq or D success", async () => {
  const f = await recoveryFixture("sqlite");
  try {
    const before = await f.observe();
    await assert.rejects(captureSnapshotMaintenance(f.options, f.request), { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
    const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
    if (first.status !== "paused") throw new Error("first capture required");
    const sealed = await f.observe();
    await assert.rejects(captureSnapshotMaintenance(f.options,
      { ...f.request, requestId: "production-sealed", expectedPhase: "quiesced", expectedJournalDigest: first.ref.journal.sha256 }),
    { code: "backup_capability_unavailable" });
    assert.deepEqual(await f.observe(), sealed);
    assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 2);
    // The earlier real C1 capture legitimately stores Fs/payloads under
    // snapshots/. No database attempt, bundle or verification was produced.
    assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).filter(name =>
      /(^|\/)(database-snapshot\.bin|database\.sqlite|database\.dump|restore-bundle\.json|publication\.json|verification\.json|receipt\.json)$/.test(name)), []);
  } finally { await f.close(); }
});

nativeTest("#152 C2 sqlite: committed T and completed D do not cache prior raw file or health proof", async t => {
  for (const point of ["raw-after-T", "config-after-T", "health-after-D"] as const) await t.test(point, async () => {
    const f = await recoveryFixture("sqlite");
    let changed = false, backups = 0;
    try {
      const before = await f.observe();
      f.recovery.afterSourceClose = async stage => {
        if (stage !== 2 || point === "health-after-D") return;
        if (point === "raw-after-T") await f.exec("UPDATE storage_source_clients SET db_sessions_json=db_sessions_json || ' '");
        else await writeFile(f.configFile, Buffer.concat([await readFile(f.configFile), Buffer.from(" ")]));
        changed = true;
      };
      f.recovery.onLock = (lock, _stage, kind) => {
        if (kind !== "snapshot") return;
        const backup = lock.backup;
        lock.backup = async destination => {
          const result = await backup(destination); backups++;
          if (point === "health-after-D") { f.profile.state.health = "2\n"; changed = true; }
          return result;
        };
      };
      await assert.rejects(f.captureSnapshot(f.options, f.request));
      assert.equal(changed, true);
      assert.equal(backups, point === "health-after-D" ? 1 : 0);
      const actual = await f.observe();
      assert.equal(actual.state.admission, "sealed");
      assert.equal(actual.state.journalSequence, point === "health-after-D" ? 4 : 3);
      assert.equal(actual.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      assert.equal(f.events.filter(event => event.event === "source-begin").length, point === "health-after-D" ? 4 : 3);
      assert.equal(f.profile.state.handles.size, 0);
      const journals = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      delete f.recovery.afterSourceClose; delete f.recovery.onLock;
      await assert.rejects(f.captureSnapshot(f.options, f.request), "same-key progress must also reject the changed current source");
      assert.deepEqual((await f.observe()).state, actual.state);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), journals);
    } finally { await f.close(); }
  });
});

nativeTest("#152 C2 sqlite: generation budget is checked before first publication but not required for read-only replay", async t => {
  await t.test("planned generation has no room for the required takeover", async () => {
    const f = await recoveryFixture("sqlite", { initialGeneration: Number.MAX_SAFE_INTEGER - 1 });
    try {
      const before = await f.observe(); assert.equal(before.state.ownerGeneration, Number.MAX_SAFE_INTEGER);
      await assert.rejects(f.captureSnapshot(f.options, f.request), { code: "phase_conflict" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 1);
    } finally { await f.close(); }
  });
  await t.test("complete prefix at the last safe generation remains replayable", async child => {
    const f = await recoveryFixture("sqlite", { initialGeneration: Number.MAX_SAFE_INTEGER - 2 });
    try {
      const result = await f.captureSnapshot(f.options, f.request);
      assert("kind" in result && result.kind === "unverified-bundle");
      assert.equal(result.ref.ownerGeneration, Number.MAX_SAFE_INTEGER);
      const before = await f.observe();
      child.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("read-only prefix cannot publish"); });
      assert.deepEqual(await f.captureSnapshot(f.options, f.request), { kind: "anchored-progress", reached: "recapture", ref: result.ref });
      f.state.events.length = 0;
      await assert.rejects(f.captureSnapshot(f.options, { ...f.request, requestId: "no-next-generation",
        expectedPhase: "quiesced", expectedJournalDigest: result.ref.journal.sha256 }), { code: "phase_conflict" });
      assert.deepEqual(f.state.events, []); assert.deepEqual(await f.observe(), before);
    } finally { child.mock.restoreAll(); await f.close(); }
  });
});

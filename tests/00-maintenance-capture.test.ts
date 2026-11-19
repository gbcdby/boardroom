import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Client } from "pg";
import type { QueryResult } from "pg";
import { captureFixture } from "./fixtures/maintenance-capture.ts";
import { withSqliteSourceInventoryDiagnostics } from "./fixtures/maintenance-source-inventory-diagnostic.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { enterMaintenance } from "./fixtures/maintenance-preview-graph.ts";
import { captureMaintenance } from "../src/server/storage/maintenance/capture.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { publishSnapshotBundle } from "../src/server/storage/maintenance/snapshot-bundle.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { stageSnapshotReady } from "../src/server/storage/maintenance/snapshot-ready.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";
import { finishControllerOwner } from "./fixtures/maintenance-capture.ts";
import type { ControllerOwner } from "../src/server/storage/maintenance/controller-owner.ts";

// The positive S fixture uses the actual Linux ordinary source-FD bridge. It is
// explicit engineering evidence, not a Darwin or qualified-profile positive.
const supported = process.platform === "linux";
const uncertainFixtureCleanup: (() => Promise<void>)[] = [];
after(async () => {
  const errors: unknown[] = [];
  for (const close of uncertainFixtureCleanup) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "private unknown-close fixture cleanup failed");
});
before(() => {
  if (!supported) return;
  const built = spawnSync(process.execPath,
    [fileURLToPath(new URL("../scripts/build-maintenance-platform.mjs", import.meta.url)), "--source-files"],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(built.status, 0, built.stderr);
});
for (const kind of ["sqlite", "postgres"] as const) {
  const nativeTest = supported && (kind === "sqlite" || process.env.AGENT_STUDIO_PG_TEST_URL) ? test : test.skip;
  nativeTest("#152 C1 " + kind + ": actual original-generation capture commits exactly one sealed v2 Jq", async () => {
    const f = await captureFixture(kind, { sessions: true });
    try {
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const predecessor = await readFile(store.pathFor(f.entered.ref.journal));
      const result = await f.capture(f.options, f.request);
      assert.equal(result.status, "paused"); if (result.status !== "paused") throw new Error("paused required");
      assert.equal(result.phase, "quiesced");
      assert.deepEqual(Object.keys(result.ref).sort(),
        ["migrationId", "source", "planDigest", "fenceEpoch", "journal", "journalSequence", "ownerGeneration"].sort());
      const after = await f.observe(), chain = await verifyJournalChain(store, result.ref.journal);
      assert.equal(chain.nodes.length, 2); const record = chain.nodes[1]!.record;
      assert.equal(record.formatVersion, 2); assert.equal(record.event, "capture"); assert.equal(record.phase, "quiesced");
      assert.deepEqual(record.previous, f.entered.ref.journal); assert.equal(record.snapshot, null);
      assert.deepEqual(await readFile(store.pathFor(f.entered.ref.journal)), predecessor);
      assert.equal(after.state.admission, "sealed"); assert.equal(after.state.ownerGeneration, before.state.ownerGeneration);
      assert.equal(after.state.fenceEpoch, before.state.fenceEpoch); assert.equal(after.state.journalSequence, 2);
      assert.equal(after.state.journalRecordRef, result.ref.journal.ref); assert.equal(after.state.journalDigest, result.ref.journal.sha256);
      assert.equal(after.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      assert.deepEqual(after.clients, before.clients);
      assert(record.formatVersion === 2 && record.frozen && record.sourceClients);
      assert.equal(record.frozen.sourceClientsDigest, digestJson(record.sourceClients));
      assert.equal(record.frozen.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      assert.equal(record.sourceClients.receiptGeneration, String(before.state.ownerGeneration));
      assert.deepEqual(f.state.events, ["capture-begin", "capture-end", "live-begin", "live-end"]);
      assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 2);
      assert.equal(f.profile.state.handles.size, 0);
    } finally { await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": exact-first replay revalidates old Fs and fresh live without publication", async t => {
    const f = await captureFixture(kind, { sessions: true });
    try {
      const first = await f.capture(f.options, f.request);
      assert.equal(first.status, "paused"); if (first.status !== "paused") throw new Error("paused required");
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const chain = await verifyJournalChain(store, first.ref.journal), record = chain.nodes.at(-1)!.record;
      assert(record.frozen);
      const journal = await readFile(store.pathFor(first.ref.journal)), files = await readFile(store.pathFor(record.frozen.sourceFilesManifest));
      const names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      const priorWindows = f.profile.state.windows; f.state.events.length = 0;
      t.mock.method(ArtifactStore.prototype, "putJson", async () => { throw new Error("replay must not publish JSON"); });
      t.mock.method(ArtifactStore.prototype, "putBytes", async () => { throw new Error("replay must not publish bytes"); });
      t.mock.method(ArtifactStore.prototype, "putSourceFilePayload", async () => { throw new Error("replay must not stream payloads"); });
      assert.deepEqual(await f.capture(f.options, f.request), first);
      assert.deepEqual(await f.observe(), before);
      assert.deepEqual(await readFile(store.pathFor(first.ref.journal)), journal);
      assert.deepEqual(await readFile(store.pathFor(record.frozen.sourceFilesManifest)), files);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), names);
      assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
      assert(f.profile.state.windows > priorWindows); assert.equal(f.profile.state.handles.size, 0);
    } finally { t.mock.restoreAll(); await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": literal undefined primary and independent cleanup rejection both survive", async t => {
    const f = await captureFixture(kind);
    try {
      const before = await f.observe(), cleanup = ArtifactStore.prototype.cleanupPublications;
      f.state.hook = stage => { if (stage === "capture-begin") throw undefined; };
      t.mock.method(ArtifactStore.prototype, "cleanupPublications", async function(this: ArtifactStore) {
        await cleanup.call(this); if (this.root === f.reference.controlRoot) throw undefined;
      });
      let rejected = false, reason: unknown;
      try { await f.capture(f.options, f.request); } catch (error) { rejected = true; reason = error; }
      assert(rejected); assert(reason instanceof AggregateError);
      assert.equal(reason.errors[0], undefined);
      assert.equal(reason.errors.filter(error => error === undefined).length, 2,
        "two actual failing stages must not be merged because their thrown values match");
      assert.deepEqual(await f.observe(), before); assert.equal(f.profile.state.handles.size, 0);
      t.mock.restoreAll();
      // A different trusted entry must first retire the same original pending
      // publication/adapter owner. No source SQL/publication retry occurs here.
      assert.equal((await enterMaintenance(f.options, { ...f.request, requestId: "first-enter",
        expectedPhase: null, expectedJournalDigest: null })).status, "paused");
    } finally { t.mock.restoreAll(); await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": strict inputs and durable request conflicts never manufacture another capture", async () => {
    const f = await captureFixture(kind);
    try {
      const before = await f.observe();
      for (const request of [
        { ...f.request, success: true }, { ...f.request, adapter: {} }, { ...f.request, facts: {} },
        { ...f.request, plan: { ...f.reference, verified: true } }, { ...f.request, requestId: "../invalid" },
      ]) await assert.rejects(f.capture(f.options, request as ContinueRequest), { code: "request_conflict" });
      for (const request of [{ ...f.request, expectedPhase: null }, { ...f.request, expectedJournalDigest: "a".repeat(64) }])
        await assert.rejects(f.capture(f.options, request), { code: "phase_conflict" });
      await assert.rejects(f.capture(f.options, { ...f.request, requestId: "first-enter" }), { code: "request_conflict" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      const first = await f.capture(f.options, f.request), sealed = await f.observe();
      assert.equal(first.status, "paused"); if (first.status !== "paused") throw new Error("paused required");
      for (const change of [{ expectedPhase: "quiesced" as const }, { expectedJournalDigest: first.ref.journal.sha256 }])
        await assert.rejects(f.capture(f.options, { ...f.request, ...change }), { code: "request_conflict" });
      await assert.rejects(f.capture(f.options, { ...f.request, requestId: "new-capture" }), { code: "phase_conflict" });
      assert.deepEqual(await f.observe(), sealed);
    } finally { await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": missing or noncanonical exact authority requires recovery without selecting an orphan", async () => {
    const f = await captureFixture(kind);
    try {
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), before = await f.observe();
      const exact = store.pathFor(f.entered.ref.journal), bytes = await readFile(exact);
      const old = await store.readJson(f.entered.ref.journal, "journal") as Record<string, unknown>;
      await store.putJson("journal", { ...old, requestId: "unselected-orphan", requestDigest: "f".repeat(64) });
      await rename(exact, exact + ".saved");
      assert.equal((await f.capture(f.options, f.request)).status, "recovery_required");
      await rename(exact + ".saved", exact); await writeFile(exact, Buffer.concat([bytes, Buffer.from(" ")]));
      assert.equal((await f.capture(f.options, f.request)).status, "recovery_required");
      await writeFile(exact, bytes);
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
    } finally { await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": capture and replay read config only through actual S/P", async t => {
    const f = await captureFixture(kind);
    try {
      const open = fs.promises.open; let ordinaryConfigOpens = 0;
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
        if (String(args[0]) === f.configFile) { ordinaryConfigOpens++; throw new Error("ordinary source config open"); }
        return Reflect.apply(open, fs.promises, args);
      });
      syncBuiltinESMExports();
      const first = await f.capture(f.options, f.request);
      assert.equal(first.status, "paused"); assert.deepEqual(await f.capture(f.options, f.request), first);
      assert.equal(ordinaryConfigOpens, 0);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": real config drift and current health failure cannot produce Jq", async t => {
    for (const point of ["config", "health"] as const) await t.test(point, async () => {
      const f = await captureFixture(kind);
      try {
        const before = await f.observe();
        if (point === "config") await writeFile(f.configFile, Buffer.concat([await readFile(f.configFile), Buffer.from(" ")]));
        else f.profile.state.health = "1\n";
        await assert.rejects(f.capture(f.options, f.request));
        assert.deepEqual(await f.observe(), before);
        assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 1);
        assert.equal(f.profile.state.handles.size, 0);
      } finally { await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": captured roster bytes and current file identity remain frozen on replay", async t => {
    for (const point of ["raw-row", "fid", "health", "config"] as const) await t.test(point, async () => {
      const f = await captureFixture(kind);
      try {
        const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
        const before = (await f.observe()).state;
        if (point === "raw-row") await f.exec("UPDATE storage_source_clients SET db_sessions_json=db_sessions_json || ' '");
        if (point === "fid") f.profile.state.identities.set(f.configFile, "ff".repeat(8));
        if (point === "health") f.profile.state.health = "2\n";
        if (point === "config") await writeFile(f.configFile, Buffer.concat([await readFile(f.configFile), Buffer.from(" ")]));
        f.state.events.length = 0;
        await assert.rejects(f.capture(f.options, f.request));
        assert(!f.state.events.includes("capture-begin")); assert.equal(f.profile.state.handles.size, 0);
        assert.deepEqual((await f.observe()).state, before);
        assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 2);
      } finally { await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": production empty registry refuses without Fs, Jq or seal", async () => {
    const f = await captureFixture(kind);
    try {
      const before = await f.observe();
      await assert.rejects(captureMaintenance(f.options, f.request), { code: "backup_capability_unavailable" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 1);
      await assert.rejects(readdir(path.join(f.reference.controlRoot, "snapshots")), { code: "ENOENT" });
    } finally { await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": both branches reject origin, head, capture, generation and chain mismatches", async t => {
    for (const replay of [false, true]) await t.test(replay ? "captured-generation replay" : "current-generation publication", async () => {
      const f = await captureFixture(kind);
      try {
        if (replay) assert.equal((await f.capture(f.options, f.request)).status, "paused");
        const before = await f.observe(); f.state.events.length = 0;
        for (const mismatch of ["kind", "head", "capture", "generation", "chain"] as const) {
          f.state.onLock = lock => {
            const actual = lock.withSourceClientFacts;
            lock.withSourceClientFacts = (plan, consume) => actual(plan, facts => consume({
              ...facts, origin: { ...facts.origin,
                ...(mismatch === "kind" ? { kind: replay ? "current-generation" as const : "captured-generation" as const } : {}),
                ...(mismatch === "head" ? { head: { ...facts.origin.head, sha256: "a".repeat(64) } } : {}),
                ...(mismatch === "capture" ? { capture: replay ? null : facts.origin.head } : {}),
                ...(mismatch === "generation" ? { receiptGeneration: facts.origin.receiptGeneration + 1 } : {}),
                ...(mismatch === "chain" ? { chain: { ...facts.origin.chain, nodes: [] } } : {}) },
            }));
          };
          await assert.rejects(f.capture(f.options, f.request));
          assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
        }
      } finally { await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": automatic final failure leaves first Jq orphan and never caches replay success", async t => {
    for (const replay of [false, true]) await t.test(replay ? "replay" : "new publication", async () => {
      const f = await captureFixture(kind);
      try {
        if (replay) assert.equal((await f.capture(f.options, f.request)).status, "paused");
        const before = await f.observe(); let callbackReturned = false, finalReads = 0, anchors = 0;
        const failure = new MaintenanceFailure("source_changed", "fixture-automatic-final");
        f.state.onLock = lock => {
          const actualFacts = lock.withSourceClientFacts, actualRaw = lock.observeSourceClients, actualAnchor = lock.anchor;
          lock.observeSourceClients = async () => {
            if (callbackReturned) { finalReads++; throw failure; }
            return actualRaw();
          };
          lock.withSourceClientFacts = (plan, consume) => actualFacts(plan, async facts => {
            const value = await consume(facts); callbackReturned = true; return value;
          });
          lock.anchor = async change => { anchors++; return actualAnchor(change); };
        };
        await assert.rejects(f.capture(f.options, f.request), error => error === failure);
        assert(callbackReturned && finalReads > 0); assert.equal(anchors, 0);
        assert.deepEqual(await f.observe(), before); assert.equal(f.profile.state.handles.size, 0);
        const names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
        assert.equal(names.length, 2, replay ? "only original enter/Jq" : "durable orphan is not an anchor");
        if (!replay) {
          delete f.state.onLock;
          const result = await f.capture(f.options, f.request); assert.equal(result.status, "paused");
          assert.equal((await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId))).length, 3,
            "explicit retry must perform a new S window; it cannot select the old orphan");
        }
      } finally { await f.close(); }
    });
  });


}

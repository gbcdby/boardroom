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
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { enterMaintenance } from "../src/server/storage/maintenance/enter.ts";
import { captureMaintenance } from "../src/server/storage/maintenance/capture.ts";
import type { ContinueRequest, OperationMutex } from "../src/server/storage/maintenance/types.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { publishSnapshotBundle } from "../src/server/storage/maintenance/snapshot-bundle.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { stageSnapshotReady } from "../src/server/storage/maintenance/snapshot-ready.ts";
import { createPostgresMaintenanceAdapter } from "../src/server/storage/maintenance/postgres.ts";

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

  nativeTest("#152 C1 " + kind + ": real COMMIT and close failures reject, then a fresh owner reads actual authority", async t => {
    for (const point of ["anchor-before", "commit-before", "commit-after", "source-close"] as const) await t.test(point, async child => {
      const f = await captureFixture(kind), exec = Database.prototype.exec, prepare = Database.prototype.prepare;
      const close = Database.prototype.close, query = Client.prototype.query, end = Client.prototype.end;
      const failure = new MaintenanceFailure("maintenance_lost", "c1-" + point);
      let sqliteWriter: Database.Database | undefined, pgWriter: Client | undefined, anchors = 0, injected = 0;
      let finalCompleted = false, laterAnchors = 0;
      try {
        const before = await f.observe();
        f.state.onLock = lock => {
          const facts = lock.withSourceClientFacts;
          lock.withSourceClientFacts = async (plan, consume) => {
            const result = await facts(plan, consume); finalCompleted = true; return result;
          };
        };
        if (kind === "sqlite") {
          child.mock.method(Database.prototype, "prepare", function(this: Database.Database, sql: string) {
            if (this.name === f.file && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
              assert(finalCompleted, "automatic facts final must complete before exact CAS"); sqliteWriter = this; anchors++;
              if (point === "anchor-before") { injected++; throw failure; }
            }
            return prepare.call(this, sql);
          });
          child.mock.method(Database.prototype, "exec", function(this: Database.Database, sql: string) {
            if (this === sqliteWriter && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
            const result = exec.call(this, sql);
            if (this === sqliteWriter && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
            return result;
          });
          child.mock.method(Database.prototype, "close", function(this: Database.Database) {
            const result = close.call(this);
            if (this === sqliteWriter && point === "source-close") { injected++; throw failure; }
            return result;
          });
        } else {
          child.mock.method(Client.prototype, "query", async function(this: Client, ...args: unknown[]) {
            const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | null)?.text ?? "";
            const database = (this as unknown as { connectionParameters: { database: string } }).connectionParameters.database;
            if (database === f.database && sql.startsWith("UPDATE storage_maintenance SET admission=")) {
              assert(finalCompleted); pgWriter = this; anchors++;
              if (point === "anchor-before") { injected++; throw failure; }
            }
            if (this === pgWriter && sql === "COMMIT" && point === "commit-before") { injected++; throw failure; }
            const result = await Reflect.apply(query, this, args) as QueryResult;
            if (this === pgWriter && sql === "COMMIT" && point === "commit-after") { injected++; throw failure; }
            return result;
          } as typeof query);
          child.mock.method(Client.prototype, "end", async function(this: Client) {
            await Reflect.apply(end, this, []);
            if (this === pgWriter && point === "source-close") { injected++; throw failure; }
          } as typeof end);
        }
        await assert.rejects(f.capture(f.options, f.request));
        assert(finalCompleted); assert.equal(anchors, 1); assert(injected >= 1);
        child.mock.restoreAll(); delete f.state.onLock;
        const committed = ["commit-after", "source-close"].includes(point), actual = await f.observe();
        assert.equal(actual.state.admission, committed ? "sealed" : "draining");
        assert.equal(actual.state.journalSequence, committed ? 2 : 1);
        assert.equal(actual.state.ownerGeneration, before.state.ownerGeneration);
        assert.equal(actual.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
        assert.deepEqual(actual.clients, before.clients); f.state.events.length = 0;
        f.state.onLock = lock => {
          const anchor = lock.anchor; lock.anchor = async change => { laterAnchors++; return anchor(change); };
        };
        const next = await f.capture(f.options, f.request); assert.equal(next.status, "paused");
        assert.equal(laterAnchors, committed ? 0 : 1);
        if (committed) {
          assert.deepEqual((await f.observe()).state, actual.state);
          assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
        } else assert.deepEqual(f.state.events, ["capture-begin", "capture-end", "live-begin", "live-end"]);
        assert.equal(f.profile.state.handles.size, 0);
      } finally { child.mock.restoreAll(); await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": successful callback cannot hide mutex or adapter close failure", async t => {
    for (const replay of [false, true]) for (const point of ["mutex-release", "adapter-close"] as const)
      await t.test((replay ? "replay " : "first ") + point, async () => {
        const f = await captureFixture(kind);
        const failure = new MaintenanceFailure("maintenance_lost", "c1-" + point); let failed = false, actualOwnerCloses = 0;
        try {
          if (replay) assert.equal((await f.capture(f.options, f.request)).status, "paused");
          const before = await f.observe();
          f.state.onOwner = owner => {
            if (point === "mutex-release") {
              const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
              owner.adapter.acquireMutex = async (...args) => {
                const mutex = await acquire(...args), release = mutex.release.bind(mutex);
                mutex.release = async () => { await release(); if (!failed) { failed = true; throw failure; } };
                return mutex;
              };
            } else {
              const close = owner.adapter.close.bind(owner.adapter);
              owner.adapter.close = async () => {
                await close(); actualOwnerCloses++;
                if (!failed) { failed = true; throw failure; }
              };
            }
          };
          await assert.rejects(f.capture(f.options, f.request), error => error === failure);
          assert(failed); delete f.state.onOwner;
          const actual = await f.observe(); assert.equal(actual.state.admission, "sealed");
          if (replay) assert.deepEqual(actual.state, before.state);
          f.state.events.length = 0;
          const next = await f.capture(f.options, f.request); assert.equal(next.status, "paused");
          assert.deepEqual((await f.observe()).state, actual.state);
          assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
          if (point === "adapter-close") assert.equal(actualOwnerCloses, 2, "the same actual owner is retried only for cleanup");
        } finally { await f.close(); }
      });
  });
  nativeTest("#152 C1 " + kind + ": unknown S close retains original owner across capture and enter", async () => {
    const f = await captureFixture(kind); let closes = 0, newOwners = 0;
    const failure = new Error("synthetic response loss after actual owned native close");
    try {
      const before = await f.observe();
      f.profile.state.hook = (stage, file) => {
        if (stage === "closed" && file === f.configFile) { closes++; if (closes === 1) throw failure; }
      };
      await assert.rejects(f.capture(f.options, f.request));
      assert(closes >= 1); const completedCloses = closes; assert.equal(f.profile.state.handles.size, 0);
      f.profile.state.hook = () => {}; f.state.events.length = 0;
      f.state.onOwner = () => { newOwners++; };
      await assert.rejects(f.capture(f.options, f.request));
      await assert.rejects(enterMaintenance(f.options, { ...f.request, requestId: "first-enter",
        expectedPhase: null, expectedJournalDigest: null }));
      assert.equal(newOwners, 0); assert.equal(closes, completedCloses); assert.deepEqual(f.state.events, []);
      assert.deepEqual(await f.observe(), before);
    } finally {
      // Its unknown owner deliberately remains registered. Keep the source inode
      // allocated until the file ends, so later unrelated fixtures cannot recycle
      // that cleanup alias. Retire known client resources now; never reset the
      // production pending registry to make a subsequent test pass.
      uncertainFixtureCleanup.push(() => f.close()); await f.sourceClient?.close();
    }
  });


  nativeTest("#152 C1 " + kind + ": original planned prefixes preserve arbitrary original generation and frozen preview semantics", async t => {
    for (const legacy of [false, true]) await t.test(legacy ? "v1 planned observation" : "v2 planned observation", async () => {
      const f = await captureFixture(kind, { legacyPlanned: legacy, initialGeneration: 7, changeBusinessBeforeEnter: true });
      try {
        const old = await f.advance("observation"), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
        const bytes = await readFile(store.pathFor(old));
        // Real business bytes changed after preview while admission was still open.
        const before = await f.observe();
        assert.notEqual(before.manifests.frozenBusinessManifestDigest, f.initial.manifests.frozenBusinessManifestDigest);
        const request = { ...f.request, expectedJournalDigest: old.sha256 };
        const result = await f.capture(f.options, request); assert.equal(result.status, "paused");
        if (result.status !== "paused") throw new Error("paused required");
        const chain = await verifyJournalChain(store, result.ref.journal), captured = chain.nodes.at(-1)!.record;
        assert.equal(chain.nodes.length, 3); assert.equal(chain.nodes[0]!.record.formatVersion, legacy ? 1 : 2);
        assert.equal(captured.formatVersion, 2); assert.equal(result.ref.ownerGeneration, 8);
        assert(captured.formatVersion === 2 && captured.frozen && captured.sourceClients);
        assert.equal(captured.sourceClients.receiptGeneration, "8");
        assert.equal(captured.frozen.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
        assert.deepEqual(await readFile(store.pathFor(old)), bytes);
        assert.deepEqual(await f.capture(f.options, request), result);
      } finally { await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": planned takeover and every successor after first Jq stay outside C1", async t => {
    for (const point of ["planned-takeover", "observation", "takeover", "cancel_intent"] as const) await t.test(point, async () => {
      const f = await captureFixture(kind);
      try {
        if (point !== "planned-takeover") assert.equal((await f.capture(f.options, f.request)).status, "paused");
        const head = await f.advance(point === "planned-takeover" ? "takeover" : point), before = await f.observe();
        f.state.events.length = 0;
        const request = point === "planned-takeover" ? { ...f.request, expectedJournalDigest: head.sha256 } : f.request;
        await assert.rejects(f.capture(f.options, request), { code: "phase_conflict" });
        assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      } finally { await f.close(); }
    });
  });
  nativeTest("#152 C1 " + kind + ": real raw roster and five frozen domain changes reject without publication", async t => {
    for (const point of ["row-delete", "same-count-replacement", "bad-receipt-generation", "r0", "business", "schema"] as const)
      await t.test(point, async () => {
        const f = await captureFixture(kind);
        try {
          if (["row-delete", "same-count-replacement", "business"].includes(point))
            assert.equal((await f.capture(f.options, f.request)).status, "paused");
          if (point === "row-delete") await f.exec("DELETE FROM storage_source_clients");
          if (point === "same-count-replacement") await f.exec("UPDATE storage_source_clients SET client_id='different-client'");
          if (point === "bad-receipt-generation") {
            const row = (await f.query("SELECT db_sessions_json FROM storage_source_clients"))[0]!;
            const envelope = JSON.parse(String(row.db_sessions_json)); envelope.drainReceipt.ownerGeneration++;
            await f.exec("UPDATE storage_source_clients SET db_sessions_json='" + JSON.stringify(envelope).replaceAll("'", "''") + "'");
          }
          if (point === "r0") await f.exec("UPDATE storage_source_clients SET entrypoint='maintenance-controller'");
          if (point === "business") {
            // Explicit private corruption input. Restore every control field in
            // the same real transaction before C observes the changed business row.
            const state = (await f.observe()).state;
            await f.exec("BEGIN; UPDATE storage_maintenance SET admission='open',active_migration_id=NULL,plan_digest=NULL; "
              + "UPDATE enter_observation SET value='changed after capture'; UPDATE storage_maintenance SET admission='sealed',"
              + "active_migration_id='" + state.activeMigrationId + "',plan_digest='" + state.planDigest + "'; COMMIT;");
          }
          if (point === "schema") await f.exec("CREATE TABLE unexpected_c1_table(value TEXT)");
          const before = await f.query("SELECT * FROM storage_maintenance"); f.state.events.length = 0;
          await assert.rejects(f.capture(f.options, f.request));
          assert.deepEqual(await f.query("SELECT * FROM storage_maintenance"), before); assert.deepEqual(f.state.events, []);
        } finally { await f.close(); }
      });
  });
  nativeTest("#152 C1 " + kind + ": replay requires every old Fs and payload byte", async t => {
    for (const point of ["missing-Fs", "missing-payload", "changed-payload"] as const) await t.test(point, async () => {
      const f = await captureFixture(kind);
      try {
        const first = await f.capture(f.options, f.request); assert.equal(first.status, "paused");
        if (first.status !== "paused") throw new Error("paused required");
        const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
        const chain = await verifyJournalChain(store, first.ref.journal), record = chain.nodes.at(-1)!.record; assert(record.frozen);
        const files = await readSourceFiles(store, record.frozen.sourceFilesManifest);
        const payload = files.entries.find(entry => entry.payload)!.payload!;
        const file = store.pathFor(point === "missing-Fs" ? record.frozen.sourceFilesManifest : payload);
        const bytes = await readFile(file), before = await f.observe(); f.state.events.length = 0;
        if (point === "changed-payload") await writeFile(file, Buffer.concat([bytes, Buffer.from("corruption")]));
        else await rename(file, file + ".held");
        assert.equal((await f.capture(f.options, f.request)).status, "recovery_required");
        assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
        if (point !== "changed-payload") await rename(file + ".held", file);
      } finally { await f.close(); }
    });
  });


  nativeTest("#152 C1 " + kind + ": lost mutex never releases the still-active source transaction", async () => {
    const f = await captureFixture(kind);
    let other: Awaited<ReturnType<typeof f.createAdapter>> | undefined;
    let held!: OperationMutex, release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { reached = resolve; });
    let running: ReturnType<typeof f.capture> | undefined;
    try {
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      f.state.onOwner = owner => {
        const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
        owner.adapter.acquireMutex = async (...args) => held = await acquire(...args);
      };
      f.state.hook = async stage => { if (stage === "capture-begin") { reached(); await gate; } };
      running = f.capture(f.options, f.request);
      await Promise.race([started, running.then(() => { throw new Error("C did not retain its source transaction"); })]);
      await held.release();
      other = await f.createAdapter();
      // These actual adapters first bind/check their mutex under source control.
      // The retained original transaction blocks that earlier boundary too.
      await assert.rejects(other.acquireMutex(store.identity, (await other.observe()).state), { code: "maintenance_busy" });
      await other.close(); other = undefined;
      release(); await assert.rejects(running, { code: "maintenance_lost" }); running = undefined;
      assert.deepEqual(await f.observe(), before);
      delete f.state.onOwner; f.state.hook = () => {};
      assert.equal((await f.capture(f.options, f.request)).status, "paused");
    } finally { release(); await running?.catch(() => {}); await other?.close(); await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": actual v2 C artifacts feed existing D B V R Jr without widening default readers", async () => {
    const f = await captureFixture(kind, { sessions: true });
    let admin: Client | undefined, targetName: string | undefined, targetUrl: string | undefined;
    let adapter: Awaited<ReturnType<typeof f.createAdapter>> | undefined, mutex: OperationMutex | undefined;
    try {
      const captured = await f.capture(f.options, f.request); assert.equal(captured.status, "paused");
      if (captured.status !== "paused") throw new Error("paused required");
      const before = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      if (kind === "postgres") {
        assert(process.env.AGENT_STUDIO_PG_TEST_URL);
        admin = new Client({ connectionString: process.env.AGENT_STUDIO_PG_TEST_URL }); admin.on("error", () => {}); await admin.connect();
        targetName = "br_c1_verify_" + randomUUID().replaceAll("-", "");
        await admin.query('CREATE DATABASE "' + targetName + '" TEMPLATE template0 ENCODING \'UTF8\' LC_COLLATE \'C\' LC_CTYPE \'C\'');
        const url = new URL(process.env.AGENT_STUDIO_PG_TEST_URL); url.pathname = "/" + targetName; targetUrl = url.toString();
        assert(f.descriptor.kind === "postgres");
        adapter = await createPostgresMaintenanceAdapter(f.descriptor, { kind: "postgres", connectionString: targetUrl });
      } else adapter = await f.createAdapter();
      mutex = await adapter.acquireMutex(store.identity, (await adapter.observe()).state);
      const actual = adapter;
      const input = await adapter.withSourceLock("snapshot", async lock => {
        const refs = await publishSnapshotBundle(store, lock);
        const verification = await verifyRestoreBundle(store, actual, lock, refs.bundle, refs.publication);
        return { ...refs, verification };
      });
      const held = mutex;
      const ready = await adapter.withSourceLock("control", lock => stageSnapshotReady(store, lock, held, input,
        { ...f.request, expectedPhase: "quiesced", expectedJournalDigest: captured.ref.journal.sha256, requestId: "c1-ready" }));
      const closure = await verifySnapshotClosure(store, ready.journal);
      assert.deepEqual(closure.receipt.capture, captured.ref);
      assert.equal(closure.chain.nodes.at(-1)!.record.formatVersion, 2);
      const after = await adapter.observe();
      assert.equal(after.state.ownerGeneration, before.state.ownerGeneration);
      assert.equal(after.state.journalSequence, 3);
      assert.equal(after.manifests.frozenBusinessManifestDigest, before.manifests.frozenBusinessManifestDigest);
      await mutex.release(); mutex = undefined; await adapter.close(); adapter = undefined;
      await assert.rejects(f.capture(f.options, f.request), { code: "phase_conflict" });
    } finally {
      try { await mutex?.release(); await adapter?.close(); }
      finally {
        try { if (admin && targetName) await admin.query('DROP DATABASE "' + targetName + '"'); }
        finally { await admin?.end(); await f.close(); }
      }
    }
  });


  nativeTest("#152 C1 " + kind + ": next entry awaits the same actual owner while post-release cleanup is in flight", async t => {
    for (const fail of [false, true]) await t.test(fail ? "same close rejection" : "successful completion", async () => {
    const f = await captureFixture(kind);
    const failure = new MaintenanceFailure("maintenance_lost", "c1-concurrent-close"); let closeCalls = 0;
    let released!: () => void, resume!: () => void, newOwner!: () => void;
    const atRelease = new Promise<void>(resolve => { released = resolve; });
    const finishRelease = new Promise<void>(resolve => { resume = resolve; });
    const secondOwner = new Promise<void>(resolve => { newOwner = resolve; });
    let first: ReturnType<typeof f.capture> | undefined, second: ReturnType<typeof f.capture> | undefined;
    try {
      f.state.onOwner = owner => {
        const close = owner.adapter.close.bind(owner.adapter);
        owner.adapter.close = async () => { await close(); closeCalls++; if (fail && closeCalls === 1) throw failure; };
        const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
        owner.adapter.acquireMutex = async (...args) => {
          const mutex = await acquire(...args), release = mutex.release.bind(mutex);
          mutex.release = async () => { await release(); released(); await finishRelease; };
          return mutex;
        };
      };
      first = f.capture(f.options, f.request); void first.catch(() => {});
      await Promise.race([atRelease, first.then(() => { throw new Error("missing actual release boundary"); })]);
      f.state.onOwner = () => { newOwner(); };
      second = f.capture(f.options, f.request); void second.catch(() => {});
      const overlapped = await Promise.race([secondOwner.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 500))]);
      assert.equal(overlapped, false, "creating a fresh owner before prior cleanup ends bypasses its unknown-close barrier");
      resume();
      if (fail) {
        await assert.rejects(second, error => error === failure);
        await assert.rejects(first, error => error === failure);
        assert.equal(closeCalls, 1, "waiting callers cannot replace the shared failed close with another cleanup");
        delete f.state.onOwner;
        assert.equal((await f.capture(f.options, f.request)).status, "paused");
        assert.equal(closeCalls, 2, "a later explicit call may finish the retained original cleanup");
      } else assert.deepEqual(await second, await first);
    } finally { resume(); await first?.catch(() => {}); await second?.catch(() => {}); await f.close(); }
    });
  });


  nativeTest("#152 C1 " + kind + ": a real extra source owner cannot be mistaken for a drained diagnostic parent", async () => {
    const f = await captureFixture(kind), other = kind === "sqlite" ? await f.createAdapter() : undefined;
    const backend = kind === "postgres" ? await f.connect() : undefined;
    try {
      const before = await f.observe();
      await assert.rejects(f.capture(f.options, f.request), { code: "source_writer_unknown" });
      assert.deepEqual(await f.observe(), before); assert.deepEqual(f.state.events, []);
      await other?.close(); if (backend) await f.closeClient(backend);
      assert.equal((await f.capture(f.options, f.request)).status, "paused");
    } finally { await other?.close(); await f.close(); }
  });
  nativeTest("#152 C1 " + kind + ": durable publication failures leave only unselected objects", async t => {
    for (const point of ["source-file-payload", "source-files", "journal", "journal-confirm"] as const) await t.test(point, async child => {
      const f = await captureFixture(kind), putPayload = ArtifactStore.prototype.putSourceFilePayload;
      const putJson = ArtifactStore.prototype.putJson, confirm = ArtifactStore.prototype.confirmDurable;
      const failure = new MaintenanceFailure("snapshot_invalid", "c1-" + point); let injected = 0, anchors = 0;
      try {
        const before = await f.observe();
        f.state.onLock = lock => { const anchor = lock.anchor; lock.anchor = async change => { anchors++; return anchor(change); }; };
        child.mock.method(ArtifactStore.prototype, "putSourceFilePayload", async function(this: ArtifactStore, ...args: Parameters<typeof putPayload>) {
          const result = await putPayload.apply(this, args);
          if (this.root === f.reference.controlRoot && point === "source-file-payload") { injected++; throw failure; }
          return result;
        });
        child.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, ...args: Parameters<typeof putJson>) {
          const result = await putJson.apply(this, args);
          if (this.root === f.reference.controlRoot && args[0] === point) { injected++; throw failure; }
          return result;
        });
        child.mock.method(ArtifactStore.prototype, "confirmDurable", async function(this: ArtifactStore, ...args: Parameters<typeof confirm>) {
          const result = await confirm.apply(this, args);
          if (this.root === f.reference.controlRoot && point === "journal-confirm" && args[0].ref.startsWith("journals/")) { injected++; throw failure; }
          return result;
        });
        await assert.rejects(f.capture(f.options, f.request));
        assert.equal(injected, 1); assert.equal(anchors, 0);
        assert.deepEqual(await f.observe(), before); assert.equal(f.profile.state.handles.size, 0);
        const journals = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
        assert.equal(journals.length, point.startsWith("journal") ? 2 : 1);
      } finally { child.mock.restoreAll(); await f.close(); }
    });
  });

}

for (const encoding of ["UTF-16le", "UTF-16be"] as const) (supported ? test : test.skip)(
  "#152 C1 sqlite: actual " + encoding + " first capture and replay retain exact roster encoding", async () => {
    const f = await captureFixture("sqlite", { sqliteEncoding: encoding });
    try {
      const captured = await f.capture(f.options, f.request); assert.equal(captured.status, "paused");
      if (captured.status !== "paused") throw new Error("paused required");
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const chain = await verifyJournalChain(store, captured.ref.journal), head = chain.nodes.at(-1)!.record;
      assert(head.formatVersion === 2 && head.sourceClients);
      assert.equal(head.sourceClients.textEncoding.backend, "sqlite");
      assert.equal(head.sourceClients.textEncoding.name, encoding);
      assert.deepEqual(await f.capture(f.options, f.request), captured);
    } finally { await f.close(); }
  });

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
        if (kind === "sqlite" && point === "commit-before") f.state.onOwner = owner => {
          const withSourceLock = owner.adapter.withSourceLock.bind(owner.adapter);
          owner.adapter.withSourceLock = (purpose, consume) => withSqliteSourceInventoryDiagnostics(owner.adapter, phase => {
            phase("c1-commit-before-fresh-source-window");
            return withSourceLock(purpose, consume);
          });
        };
        const next = await f.capture(f.options, f.request); assert.equal(next.status, "paused");
        assert.equal(laterAnchors, committed ? 0 : 1);
        if (committed) {
          assert.deepEqual((await f.observe()).state, actual.state);
          assert.deepEqual(f.state.events, ["live-begin", "live-end"]);
        } else assert.deepEqual(f.state.events, ["capture-begin", "capture-end", "live-begin", "live-end"]);
        assert.equal(f.profile.state.handles.size, 0);
      } finally { delete f.state.onOwner; child.mock.restoreAll(); await f.close(); }
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

}

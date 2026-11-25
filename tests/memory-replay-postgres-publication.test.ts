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

// Coverage: postgres publication (durable publication and four already-created cases).
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
for (const kind of ["postgres"] as ("sqlite" | "postgres")[]) {
  const nativeTest = supported && (kind === "sqlite" || process.env.AGENT_STUDIO_PG_TEST_URL) ? test : test.skip;
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


  for (const entry of ["capture", "enter"] as const) for (const point of ["observe", "mutex"] as const)
    nativeTest("#152 C1 " + kind + ": already-created " + entry + " " + point + " entrant honors later pending resources", async () => {
      const f = await captureFixture(kind);
      let committed!: () => void, finishFirst!: () => void, created!: () => void, resumeSecond!: () => void;
      const atCommit = new Promise<void>(resolve => { committed = resolve; });
      const firstGate = new Promise<void>(resolve => { finishFirst = resolve; });
      const atSecond = new Promise<void>(resolve => { created = resolve; });
      const secondGate = new Promise<void>(resolve => { resumeSecond = resolve; });
      const failure = new MaintenanceFailure("maintenance_lost", "c1-prior-close-response");
      let ordinal = 0, firstOwner: ControllerOwner | undefined, closes = 0, anchors = 0;
      let first: ReturnType<typeof f.capture> | undefined, second: ReturnType<typeof f.capture> | undefined;
      try {
        f.state.onLock = lock => { const anchor = lock.anchor; lock.anchor = async change => { anchors++; return anchor(change); }; };
        f.state.onOwner = owner => {
          ordinal++;
          if (ordinal === 1) {
            firstOwner = owner;
            const withSourceLock = owner.adapter.withSourceLock.bind(owner.adapter);
            owner.adapter.withSourceLock = async (kind, consume) => {
              const result = await withSourceLock(kind, consume); committed(); await firstGate; return result;
            };
            const close = owner.adapter.close.bind(owner.adapter);
            owner.adapter.close = async () => { await close(); closes++; if (closes === 1) throw failure; };
          } else if (ordinal === 2) {
            if (point === "observe") {
              const observe = owner.adapter.observe.bind(owner.adapter);
              owner.adapter.observe = async () => { created(); await secondGate; return observe(); };
            } else {
              const acquire = owner.adapter.acquireMutex.bind(owner.adapter);
              owner.adapter.acquireMutex = async (...args) => { created(); await secondGate; return acquire(...args); };
            }
          }
        };
        first = f.capture(f.options, f.request); void first.catch(() => {});
        await Promise.race([atCommit, first.then(() => { throw new Error("first actual COMMIT boundary missing"); })]);
        second = entry === "capture" ? f.capture(f.options, f.request) : f.enter(f.options,
          { ...f.request, expectedPhase: null, expectedJournalDigest: null, requestId: "first-enter" });
        void second.catch(() => {});
        await Promise.race([atSecond, second.then(() => { throw new Error("second pre-existing owner boundary missing"); })]);
        finishFirst(); await assert.rejects(first, error => error === failure); first = undefined;
        assert.equal(closes, 1);
        const before = await f.observe(); resumeSecond();
        const outcome = await second.then(result => ({ result }), error => ({ error })); second = undefined;
        assert("error" in outcome || closes > 1,
          "a pre-existing entrant cannot succeed without waiting for or cleaning the original later-pending owner");
        if ("error" in outcome) throw outcome.error;
        assert.equal(outcome.result.status, entry === "capture" ? "paused" : "blocked");
        assert.equal(closes, 2, "the original concrete adapter, not a new empty owner, completes cleanup");
        assert.deepEqual((await f.observe()).state, before.state); assert.equal(anchors, 1);
        assert.equal(f.profile.state.handles.size, 0);
      } finally {
        finishFirst(); resumeSecond(); await first?.catch(() => {}); await second?.catch(() => {});
        delete f.state.onOwner;
        if (firstOwner) await finishControllerOwner(firstOwner, undefined, undefined, [], "c1-test-original-cleanup");
        await f.close();
      }
    });

}

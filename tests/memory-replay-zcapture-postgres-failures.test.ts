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

// Coverage: postgres C1 negative publication/replay branches — origin/head/capture/generation/chain
// mismatches and automatic final failure with explicit retry.

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

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

// Coverage: postgres C1 frozen identity and negative gates — config/health drift, captured roster bytes and
// current file identity, and production empty registry.

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


}

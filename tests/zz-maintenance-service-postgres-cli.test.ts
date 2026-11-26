import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectMaintenance } from "./fixtures/maintenance-preview-graph.ts";
import { enterMaintenance } from "./fixtures/maintenance-preview-graph.ts";
import { protocolEnterFixture as enterFixture } from "./fixtures/maintenance-enter.ts";
import { runActualMaintenanceCli, serviceFixture, startServiceChild } from "./fixtures/maintenance-service.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { maintenanceRequestDigest } from "../src/server/storage/maintenance/parse.ts";
import { sha256 } from "../src/server/storage/maintenance/canonical.ts";

const postgresTest = ["linux", "darwin"].includes(process.platform) && process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const sourceFilePostgresTest = process.platform === "linux" && process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

// Coverage: service PostgreSQL C3 legacy capture and actual CLI — LATIN1/SQL_ASCII byte preservation
// through public ready/cancel, plus fixed production worker enter-once and exact planned command replay.

sourceFilePostgresTest("#152 C3 service PostgreSQL: native LATIN1 and SQL_ASCII legacy capture retains bytes through public ready and cancel", async t => {
  for (const postgresEncoding of ["LATIN1", "SQL_ASCII"] as const) await t.test(postgresEncoding, async () => {
    const f = await serviceFixture("postgres", { postgresEncoding });
    try {
      const captured = await f.capture(f.options, f.request);
      assert.equal(captured.status, "paused"); if (captured.status !== "paused") throw new Error("actual legacy capture required");
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
      const original = await store.readBytes(captured.ref.journal), before = await f.observe();
      const command = { operation: "resume-migration" as const, request: { ...f.request, requestId: "pg-legacy-public-ready",
        expectedPhase: "quiesced" as const, expectedJournalDigest: captured.ref.journal.sha256 } };
      const ready = await f.service.runMaintenanceServiceCommand(f.options, command);
      assert.equal(ready.status, "snapshot_ready"); if (ready.status !== "snapshot_ready") throw new Error("actual legacy PG ready required");
      const readyChain = await verifyJournalChain(store, ready.ref.journal);
      assert(readyChain.nodes.every(node => node.record.formatVersion === 2));
      assert.deepEqual(await store.readBytes(captured.ref.journal), original);
      assert.deepEqual((await f.observe()).manifests.controlRows.storage_source_clients, before.manifests.controlRows.storage_source_clients);
      const cancelled = await f.service.runMaintenanceServiceCommand(f.options, { operation: "cancel-migration",
        request: { ...f.request, requestId: "pg-legacy-public-cancel", expectedPhase: "snapshot_ready", expectedJournalDigest: ready.ref.journal.sha256 } });
      assert.equal(cancelled.status, "cancelled"); if (cancelled.status !== "cancelled") throw new Error("actual legacy PG terminal required");
      const terminal = await verifyJournalChain(store, cancelled.terminalJournal);
      assert(terminal.nodes.every(node => node.record.formatVersion === 2));
      assert.deepEqual(await store.readBytes(captured.ref.journal), original);
      assert.deepEqual((await f.observe()).manifests.controlRows.storage_source_clients, before.manifests.controlRows.storage_source_clients);
      assert.equal((await f.observe()).state.fenceEpoch, before.state.fenceEpoch + 1);
    } finally { await f.close(); }
  });
});

postgresTest("#152 C3 actual CLI PostgreSQL: fixed production worker enters once and replays the exact planned command", async () => {
  const f = await enterFixture("postgres", { drainClient: true, configSource: "none" });
  try {
    const request = { ...f.request, requestId: "actual-pg-cli-public-execute" };
    const executed = runActualMaintenanceCli(f, "execute", request), result = JSON.parse(executed.stdout);
    assert.equal(executed.status, 1); assert.equal(result.failure, null);
    assert.equal(result.result.status, "blocked"); assert.equal(result.result.observedAnchor?.phase, "planned");
    const observed = await f.observe(); assert.equal(observed.state.admission, "draining");
    assert.equal(observed.state.journalSequence, 1); assert(observed.state.journalDigest);
    await f.sourceClient!.refresh(); await f.sourceClient!.waitForDrain();
    const stable = await f.observe(), files = (await readdir(f.reference.controlRoot, { recursive: true })).sort();
    const replay = runActualMaintenanceCli(f, "execute", request), replayed = JSON.parse(replay.stdout);
    assert.equal(replay.status, 0); assert.equal(replayed.failure, null); assert.equal(replayed.result.status, "paused");
    assert.equal(replayed.result.ref.journal.sha256, observed.state.journalDigest);
    const inspect = runActualMaintenanceCli(f, "inspect", request), inspected = JSON.parse(inspect.stdout);
    assert.equal(inspect.status, 0); assert.equal(inspected.failure, null); assert.equal(inspected.result.status, "paused");
    assert.deepEqual(await f.observe(), stable);
    assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).sort(), files);
    for (const output of [executed, replay, inspect]) for (const raw of [output.stdout, output.stderr]) {
      assert(!raw.includes(f.directory)); assert(!raw.includes("postgres://")); assert(!raw.includes("postgresql://"));
    }
  } finally { await f.close(); }
});

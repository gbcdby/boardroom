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
postgresTest("#152 C3 inspect PostgreSQL: actual read transactions preserve open/planned controls and never repair bad journals", async () => {
  const f = await enterFixture("postgres");
  try {
    const command = { operation: "inspect-migration" as const, request: { plan: f.reference, expectedSource: f.plan.source } };
    const open = await f.observe(), names = await readdir(f.reference.controlRoot, { recursive: true });
    assert.equal((await inspectMaintenance(f.options, command)).status, "blocked");
    assert.deepEqual(await f.observe(), open);
    assert.deepEqual(await readdir(f.reference.controlRoot, { recursive: true }), names);
    const entered = await enterMaintenance(f.options, f.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("actual planned required");
    const planned = await f.observe(), selectedNames = await readdir(f.reference.controlRoot, { recursive: true });
    const inspected = await inspectMaintenance(f.options, command);
    assert.equal(inspected.status, "paused"); if (inspected.status !== "paused") throw new Error("planned diagnostic required");
    assert.deepEqual(inspected.ref, entered.ref); assert.equal(inspected.observedAnchor?.authority, "observation-only");
    assert.deepEqual(await f.observe(), planned);
    assert.deepEqual(await readdir(f.reference.controlRoot, { recursive: true }), selectedNames);
    const journal = path.join(f.reference.controlRoot, entered.ref.journal.ref);
    const bad = Buffer.concat([await readFile(journal), Buffer.from(" ")]); await writeFile(journal, bad);
    assert.equal((await inspectMaintenance(f.options, command)).status, "recovery_required");
    assert.deepEqual(await f.observe(), planned); assert.deepEqual(await readFile(journal), bad);
    assert.deepEqual(await readdir(f.reference.controlRoot, { recursive: true }), selectedNames);
  } finally { await f.close(); }
});

sourceFilePostgresTest("#152 C3 service PostgreSQL: complete public resume owns every original transaction and ready record", async () => {
  const f = await serviceFixture("postgres", { sessions: true });
  try {
    const command = { operation: "resume-migration" as const, request: { ...f.request, requestId: "pg-complete-public-resume" } };
    const result = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "snapshot_ready"); if (result.status !== "snapshot_ready") throw new Error("real PG ready required");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), chain = await verifyJournalChain(store, result.ref.journal);
    assert.deepEqual(chain.nodes.map(node => node.record.event), ["enter", "capture", "takeover", "capture", "ready"]);
    for (const node of chain.nodes.slice(1)) {
      assert.equal(node.record.formatVersion, 3); assert.equal(node.record.requestId, command.request.requestId);
      assert.equal(node.record.requestDigest, maintenanceRequestDigest(command));
    }
    const events = f.state.events, sourceEnds = events.filter(event => event.event === "source-end");
    assert.equal(events.filter(event => event.event === "owner").length, 1);
    assert.equal(events.filter(event => event.event === "mutex-acquired").length, 1);
    assert.equal(new Set(events.map(event => event.owner)).size, 1);
    assert.deepEqual(sourceEnds.map(event => event.kind), ["control", "control", "control", "snapshot", "control"]);
    for (const event of sourceEnds) {
      assert(event.lock); const outcome = f.sql.controlSqlOutcome(event.lock);
      assert.equal(outcome.commitReturned, true); assert.equal(outcome.localSourceHandleClosed, true);
      await assert.rejects(event.lock.assertHeld(), { code: "maintenance_lost" });
    }
    assert.equal((await f.observe()).state.journalDigest, result.ref.journal.sha256);
  } finally { await f.close(); }
});

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

sourceFilePostgresTest("#152 C3 inspect PostgreSQL: actual ready child exit requires a readonly diagnostic before real new-owner restore", async () => {
  const f = await serviceFixture("postgres");
  let worker: Awaited<ReturnType<typeof startServiceChild>> | undefined;
  const inventory = async () => {
    const entries = await readdir(f.reference.controlRoot, { recursive: true, withFileTypes: true });
    return (await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const file = path.join(entry.parentPath, entry.name);
      return { path: path.relative(f.reference.controlRoot, file), digest: sha256(await readFile(file)) };
    }))).sort((left, right) => left.path.localeCompare(right.path));
  };
  try {
    const command = { operation: "resume-migration" as const, request: { ...f.request, requestId: "pg-actual-ready-child" } };
    worker = await startServiceChild(f, command);
    const ready = worker.result;
    assert.equal(ready.status, "snapshot_ready"); if (ready.status !== "snapshot_ready") throw new Error("actual PG child ready required");
    const stable = await f.observe(), files = await inventory();
    const controller = stable.clients.find(row => row.entrypoint === "maintenance-controller");
    assert(controller && typeof controller.process_identity_json === "string");
    assert.equal(JSON.parse(controller.process_identity_json).pid, worker.pid); assert.equal(controller.ended_at, null);
    const inspect = () => inspectMaintenance(f.options, { operation: "inspect-migration", request: { plan: f.reference, expectedSource: f.plan.source } });
    const present = await inspect();
    assert.equal(present.status, "blocked"); if (present.status !== "blocked") throw new Error("present controller must block");
    assert(present.blockers.some(item => item.code === "source_writer_active" && item.subjectRef.startsWith("controller-process-present:")));
    assert.equal(present.observedAnchor?.journal.sha256, ready.ref.journal.sha256);
    const completion = await worker.stop();
    assert.deepEqual(completion.exit, { code: 0, signal: null }); assert.deepEqual(completion.close, completion.exit);
    const exited = await inspect();
    assert.equal(exited.status, "blocked"); if (exited.status !== "blocked") throw new Error("unended native exit must block");
    assert(exited.blockers.some(item => item.code === "source_writer_unknown" && item.subjectRef.startsWith("controller-ended-observation-required:")));
    assert.deepEqual(exited.observedAnchor, present.observedAnchor);
    const replay = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(replay.status, "blocked"); assert.equal(replay.observedAnchor?.journal.sha256, ready.ref.journal.sha256);
    assert.deepEqual(await f.observe(), stable); assert.deepEqual(await inventory(), files);
    await f.freshVerificationTarget(); // A new actual N07 restore needs a new isolated empty target.
    const next = { operation: "resume-migration" as const, request: { ...f.request, requestId: "pg-new-owner-after-child-exit",
      expectedPhase: "snapshot_ready" as const, expectedJournalDigest: ready.ref.journal.sha256 } };
    const resumed = await f.service.runMaintenanceServiceCommand(f.options, next);
    assert.equal(resumed.status, "snapshot_ready"); if (resumed.status !== "snapshot_ready") throw new Error("actual PG N07 restore required");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), chain = await verifyJournalChain(store, resumed.ref.journal);
    const takeover = chain.nodes.at(-1)!;
    assert.equal(takeover.record.event, "takeover"); assert.equal(takeover.record.sequence, 6);
    assert.equal(takeover.record.requestDigest, maintenanceRequestDigest(next));
    assert(takeover.record.formatVersion === 3 && takeover.record.controlProof?.kind === "control-successor");
    assert(takeover.record.controlProof.changes.some(change => change.kind === "client-observation" && change.effect === "ended-observed"));
    assert((await f.observe()).clients.find(row => row.client_id === controller.client_id)?.ended_at);
    assert.deepEqual(resumed.snapshot, ready.snapshot);
    for (const entry of files.filter(entry => /^(journals|receipts|verifications)\//.test(entry.path)))
      assert.equal(sha256(await readFile(path.join(store.root, entry.path))), entry.digest);
  } finally { try { await worker?.stop(); } finally { await f.close(); } }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { serviceFixture } from "./fixtures/maintenance-service.ts";
import { protocolEnterFixture as enterFixture } from "./fixtures/maintenance-enter.ts";
import { enterMaintenance } from "./fixtures/maintenance-preview-graph.ts";
import { runMaintenanceServiceCommand } from "./fixtures/maintenance-preview-graph.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { maintenanceRequestDigest } from "../src/server/storage/maintenance/parse.ts";
import { captureReference, verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { planMigration, persistMigrationPlan } from "./fixtures/maintenance-preview-graph.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const sourceFileTest = process.platform === "linux" ? test : test.skip;
async function files(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return (await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(entry.parentPath, entry.name);
    return { path: path.relative(root, file), hash: sha256(await readFile(file)) };
  }))).sort((a, b) => a.path.localeCompare(b.path));
}
async function firstCapture() {
  const f = await serviceFixture(), cut = new Error("after original first capture COMMIT/close, before takeover");
  try {
    f.state.beforeSource = (_lock, stage) => { if (stage === 2) throw cut; };
    await assert.rejects(f.service.runMaintenanceServiceCommand(f.options,
      { operation: "resume-migration", request: { ...f.request, requestId: "quiesced-before-cancel" } }), error => error === cut);
    delete f.state.beforeSource;
    const observed = await f.observe(), store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source);
    assert.equal(observed.state.admission, "sealed"); assert.equal(observed.state.journalSequence, 2);
    assert(observed.state.journalRecordRef && observed.state.journalDigest);
    const journal = await store.readAnchoredJournal({ ref: observed.state.journalRecordRef, sha256: observed.state.journalDigest });
    const chain = await verifyJournalChain(store, journal), head = chain.nodes.at(-1)!;
    assert.equal(head.record.formatVersion, 3); assert.equal(head.record.event, "capture");
    f.state.events.length = 0; f.state.scopes.length = 0;
    return { f, observed, store, ref: captureReference(head) };
  } catch (error) { await f.close(); throw error; }
}

nativeTest("#152 C3 cancel SQLite: planned without first Jq cannot publish cancellation or open the source", async () => {
  const f = await enterFixture("sqlite", { drainClient: true });
  try {
    const entered = await enterMaintenance(f.options, f.request);
    assert.equal(entered.status, "paused"); if (entered.status !== "paused") throw new Error("actual planned required");
    await f.sourceClient!.refresh(); await f.sourceClient!.waitForDrain();
    const before = await f.observe(), names = await files(f.reference.controlRoot);
    const result = await runMaintenanceServiceCommand(f.options,
      { operation: "cancel-migration", request: { ...f.request, requestId: "invalid-planned-cancel",
        expectedPhase: "planned", expectedJournalDigest: entered.ref.journal.sha256 } });
    assert.equal(result.status, "blocked"); if (result.status !== "blocked") throw new Error("planned cancellation must be blocked");
    assert.deepEqual(result.blockers.map(blocker => blocker.code), ["request_conflict"]);
    assert.deepEqual(await f.observe(), before); assert.deepEqual(await files(f.reference.controlRoot), names);
  } finally { await f.close(); }
});

sourceFileTest("#152 C3 cancel SQLite: actual independent takeover/intent/terminal commits open E+1, preserve intent, and replay history", async () => {
  const { f, observed, store, ref } = await firstCapture();
  try {
    const command = { operation: "cancel-migration" as const, request: { ...f.request, requestId: "cancel-original-public-key",
      expectedPhase: "quiesced" as const, expectedJournalDigest: ref.journal.sha256 } };
    const result = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "cancelled"); if (result.status !== "cancelled") throw new Error("real terminal required");
    const current = await f.observe(), chain = await verifyJournalChain(store, result.terminalJournal);
    assert.deepEqual(chain.nodes.slice(-3).map(node => node.record.event), ["takeover", "cancel_intent", "cancelled"]);
    for (const node of chain.nodes.slice(-3)) {
      assert.equal(node.record.requestId, command.request.requestId);
      assert.equal(node.record.requestDigest, maintenanceRequestDigest(command));
      assert.equal(node.record.formatVersion, 3);
    }
    assert.equal(current.state.admission, "open"); assert.equal(current.state.fenceEpoch, observed.state.fenceEpoch + 1);
    assert.equal(result.openedFenceEpoch, current.state.fenceEpoch); assert.equal(current.state.ownerGeneration, observed.state.ownerGeneration + 1);
    assert.equal(current.state.activeMigrationId, null); assert.equal(current.state.planDigest, null);
    assert.equal(current.state.journalDigest, result.terminalJournal.sha256); assert.equal(current.state.journalSequence, 5);
    assert.equal(current.manifests.frozenBusinessManifestDigest, observed.manifests.frozenBusinessManifestDigest);
    const intent = (await f.query("SELECT desired_state,intent_revision,reset_session_requested FROM agent_runtime_bindings WHERE id='enter-binding'"))[0]!;
    assert.deepEqual(intent, { desired_state: "running", intent_revision: 7, reset_session_requested: 1 });
    const endings = f.state.events.filter(event => event.event === "source-end");
    assert.equal(endings.length, 3); assert.equal(new Set(endings.map(event => event.lock)).size, 3);
    for (const event of endings) {
      assert(event.lock); const outcome = f.sql.controlSqlOutcome(event.lock);
      assert.equal(outcome.commitReturned, true); assert.equal(outcome.localSourceHandleClosed, true);
    }
    await f.exec("UPDATE enter_observation SET value='ordinary business after terminal'");
    const changed = await f.observe(), names = await files(store.root);
    assert.deepEqual(await f.service.runMaintenanceServiceCommand(f.options, command), result);
    const inspected = await f.service.runMaintenanceServiceCommand(f.options, { operation: "inspect-migration",
      request: { plan: f.reference, expectedSource: f.plan.source } });
    assert.equal(inspected.status, "cancelled");
    assert.deepEqual(await f.observe(), changed); assert.deepEqual(await files(store.root), names);

    const adapter = await f.createAdapter();
    let nextPlan, nextReference;
    try {
      nextPlan = await planMigration(f.options, adapter);
      nextReference = await persistMigrationPlan(nextPlan, f.options, adapter);
    } finally { await adapter.close(); }
    assert.notEqual(nextPlan.migrationId, f.plan.migrationId);
    // Stop after the next original enter COMMIT. No pretend quiescence of the
    // still-live former controller is needed to test the new epoch boundary.
    const nextCut = new Error("next epoch entered");
    f.state.afterSourceClose = (_lock, stage) => { if (stage === 1) throw nextCut; };
    await assert.rejects(f.service.runMaintenanceServiceCommand(f.options, { operation: "execute-migration",
      request: { plan: nextReference, expectedSource: nextPlan.source, expectedPhase: null, expectedJournalDigest: null,
        requestId: "fresh-execute-after-terminal" } }), error => error === nextCut);
    delete f.state.afterSourceClose;
    const next = await f.observe();
    assert.equal(next.state.admission, "draining"); assert.equal(next.state.fenceEpoch, current.state.fenceEpoch + 1);
    assert.equal(next.state.ownerGeneration, current.state.ownerGeneration + 1);
    assert.equal(next.state.activeMigrationId, nextPlan.migrationId); assert.equal(next.state.journalSequence, 1);
    const stale = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.notEqual(stale.status, "cancelled"); assert.deepEqual(await f.observe(), next);
  } finally { await f.close(); }
});

sourceFileTest("#152 C3 cancel SQLite: unknown terminal response keeps the exact undefined failure, then same key reads the actual terminal", async () => {
  const { f, observed, ref } = await firstCapture();
  try {
    const command = { operation: "cancel-migration" as const, request: { ...f.request, requestId: "terminal-response-unknown",
      expectedPhase: "quiesced" as const, expectedJournalDigest: ref.journal.sha256 } };
    f.state.afterSourceClose = (_lock, stage) => { if (stage === 3) throw undefined; };
    let failed = false, failure: unknown;
    try { await f.service.runMaintenanceServiceCommand(f.options, command); }
    catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.equal(failure, undefined); delete f.state.afterSourceClose;
    const terminal = await f.observe(), names = await files(f.reference.controlRoot);
    assert.equal(terminal.state.admission, "open"); assert.equal(terminal.state.fenceEpoch, observed.state.fenceEpoch + 1);
    const result = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "cancelled"); if (result.status !== "cancelled") throw new Error("actual terminal replay required");
    assert.equal(result.terminalJournal.sha256, terminal.state.journalDigest);
    assert.deepEqual(await f.observe(), terminal); assert.deepEqual(await files(f.reference.controlRoot), names);
  } finally { await f.close(); }
});

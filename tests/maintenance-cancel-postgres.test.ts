import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { serviceFixture } from "./fixtures/maintenance-service.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { maintenanceRequestDigest } from "../src/server/storage/maintenance/parse.ts";

// This complete cancellation fixture uses the actual Linux source-FD bridge.
const postgresTest = process.platform === "linux" && process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
postgresTest("#152 C3 cancel PostgreSQL: planned rejection and an actual terminal survive unknown response and later ordinary writes", async () => {
  const f = await serviceFixture("postgres");
  try {
    const before = await f.observe(), names = (await readdir(f.reference.controlRoot, { recursive: true })).sort();
    const invalid = await f.service.runMaintenanceServiceCommand(f.options, { operation: "cancel-migration",
      request: { ...f.request, requestId: "pg-planned-cancel" } });
    assert.equal(invalid.status, "blocked"); if (invalid.status !== "blocked") throw new Error("planned PG cancel must fail closed");
    assert.deepEqual(invalid.blockers.map(blocker => blocker.code), ["request_conflict"]);
    assert.deepEqual(await f.observe(), before); assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).sort(), names);
    const cut = new Error("actual PG first capture completed");
    f.state.beforeSource = (_lock, stage) => { if (stage === 2) throw cut; };
    await assert.rejects(f.service.runMaintenanceServiceCommand(f.options, { operation: "resume-migration",
      request: { ...f.request, requestId: "pg-first-capture-before-cancel" } }), error => error === cut);
    delete f.state.beforeSource;
    const quiesced = await f.observe();
    assert.equal(quiesced.state.admission, "sealed"); assert.equal(quiesced.state.journalSequence, 2);
    assert(quiesced.state.journalDigest);
    const command = { operation: "cancel-migration" as const, request: { ...f.request, requestId: "pg-terminal-response-unknown",
      expectedPhase: "quiesced" as const, expectedJournalDigest: quiesced.state.journalDigest } };
    f.state.events.length = 0;
    f.state.afterSourceClose = (_lock, stage) => { if (stage === 3) throw undefined; };
    let failed = false, failure: unknown;
    try { await f.service.runMaintenanceServiceCommand(f.options, command); }
    catch (error) { failed = true; failure = error; }
    assert.equal(failed, true); assert.equal(failure, undefined); delete f.state.afterSourceClose;
    const terminal = await f.observe();
    assert.equal(terminal.state.admission, "open"); assert.equal(terminal.state.fenceEpoch, quiesced.state.fenceEpoch + 1);
    assert.equal(terminal.state.activeMigrationId, null); assert.equal(terminal.state.planDigest, null);
    assert.equal(terminal.manifests.frozenBusinessManifestDigest, quiesced.manifests.frozenBusinessManifestDigest);
    const endings = f.state.events.filter(event => event.event === "source-end");
    assert.equal(endings.length, 3); assert.equal(new Set(endings.map(event => event.lock)).size, 3);
    for (const event of endings) {
      assert(event.lock); const outcome = f.sql.controlSqlOutcome(event.lock);
      assert.equal(outcome.commitReturned, true); assert.equal(outcome.localSourceHandleClosed, true);
    }
    await f.exec("UPDATE enter_observation SET value='ordinary PG business after terminal'");
    const changed = await f.observe(), files = (await readdir(f.reference.controlRoot, { recursive: true })).sort();
    const result = await f.service.runMaintenanceServiceCommand(f.options, command);
    assert.equal(result.status, "cancelled"); if (result.status !== "cancelled") throw new Error("actual PG terminal must replay");
    const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), chain = await verifyJournalChain(store, result.terminalJournal);
    assert.deepEqual(chain.nodes.slice(-3).map(node => node.record.event), ["takeover", "cancel_intent", "cancelled"]);
    for (const node of chain.nodes.slice(-3)) assert.equal(node.record.requestDigest, maintenanceRequestDigest(command));
    assert.equal((await f.service.runMaintenanceServiceCommand(f.options, { operation: "inspect-migration",
      request: { plan: f.reference, expectedSource: f.plan.source } })).status, "cancelled");
    assert.deepEqual(await f.observe(), changed);
    assert.deepEqual((await readdir(f.reference.controlRoot, { recursive: true })).sort(), files);
  } finally { await f.close(); }
});

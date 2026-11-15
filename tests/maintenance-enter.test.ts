import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { enterFixture } from "./fixtures/maintenance-enter.ts";
import { enterMaintenance } from "../src/server/storage/maintenance/enter.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyJournalChain } from "../src/server/storage/maintenance/journal.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { openNativeManagementSource } from "../src/server/storage/native-management-admission.ts";

const supported = ["linux", "darwin"].includes(process.platform);
for (const kind of ["sqlite", "postgres"] as const) {
  const nativeTest = supported && (kind === "sqlite" || process.env.AGENT_STUDIO_PG_TEST_URL) ? test : test.skip;
  nativeTest(`#152 internal enter ${kind}: real saved P becomes exactly one planned/draining anchor and gates new work`, async () => {
    const f = await enterFixture(kind);
    try {
      const result = await enterMaintenance(f.options, f.request);
      assert.equal(result.status, "paused"); if (result.status !== "paused") throw new Error("paused required");
      assert.equal(result.phase, "planned");
      const current = await f.observe();
      assert.equal(current.state.admission, "draining"); assert.equal(current.state.fenceEpoch, f.initial.state.fenceEpoch + 1);
      assert.equal(current.state.ownerGeneration, f.initial.state.ownerGeneration + 1);
      assert.equal(current.state.journalRecordRef, result.ref.journal.ref); assert.equal(current.state.journalSequence, 1);
      assert.equal(current.state.journalDigest, result.ref.journal.sha256); assert.equal(current.state.planDigest, f.reference.planDigest);
      assert.equal(current.manifests.frozenBusinessManifestDigest, f.initial.manifests.frozenBusinessManifestDigest);
      assert.deepEqual(current.clients, f.initial.clients);
      const store = await ArtifactStore.open(f.reference.controlRoot, f.plan.source), chain = await verifyJournalChain(store, result.ref.journal);
      assert.equal(chain.nodes.length, 1); const record = chain.nodes[0]!.record;
      assert.equal(record.formatVersion, 2); assert.equal(record.event, "enter"); assert.equal(record.previous, null);
      assert.equal(record.snapshot, null); assert.equal(record.frozen, null);
      if (record.formatVersion === 2) assert.equal(record.sourceClients, null);
      assert.deepEqual(record.plan, f.reference.immutablePlan);
      const driver = f.descriptor.kind === "sqlite" ? new SqliteDriver({ dataDir: f.dataDir, sqlitePath: f.file, sqliteSource: f.descriptor })
        : new PostgresDriver({ connectionString: f.descriptor.connectionString });
      try { await assert.rejects(driver.connect(), /storage_maintenance/); } finally { await driver.close(); }
      if (f.descriptor.kind === "sqlite") await assert.rejects(openNativeManagementSource({ source: f.descriptor, mode: "write" }), /storage_maintenance/);
    } finally { await f.close(); }
  });
  nativeTest(`#152 internal enter ${kind}: same request replay selects the exact head without another journal or generation`, async () => {
    const f = await enterFixture(kind);
    try {
      const first = await enterMaintenance(f.options, f.request), before = await f.observe();
      const names = await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId));
      assert.deepEqual(await enterMaintenance(f.options, f.request), first);
      assert.deepEqual((await f.observe()).state, before.state);
      assert.deepEqual(await readdir(path.join(f.reference.controlRoot, "journals", f.plan.migrationId)), names);
    } finally { await f.close(); }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { controllerWriterFixture } from "../fixtures/maintenance-controller-history.ts";
import type { ControllerCommandScope } from "../../src/server/storage/maintenance/controller-write.ts";
import { verifySnapshotClosure } from "../../src/server/storage/maintenance/journal.ts";

const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;

// This capture/restore fixture uses the Linux source-FD bridge.
const pgCaptureTest = process.platform === "linux" ? pgTest : test.skip;

pgCaptureTest("C3 PostgreSQL new archive owner restores exact legacy ready into a fresh target before bridge and registration", async () => {
  const f = await controllerWriterFixture("postgres", { legacyReady: true });
  let scope: ControllerCommandScope | undefined;
  try {
    assert(f.verificationTarget);
    const before = await f.adapter.observeSourceClients();
    const head = await f.store.readAnchoredJournal({ ref: before.state.journalRecordRef!, sha256: before.state.journalDigest! });
    const closure = await verifySnapshotClosure(f.store, head);
    const oldReceipt = await f.store.readJson(closure.receiptRef, "receipt"), oldVerification = await f.store.readJson(closure.receipt.verification, "verification");
    await f.adapter.withSourceLock("control", async lock => {
      ({ scope } = await f.writer.beginControllerCommand(f.adapter, f.mutex, lock, { operation: "resume-migration", request: f.request }));
    });
    const view = await f.adapter.withSourceLock("snapshot", async lock => {
      const result = await f.consumers.revalidateControllerReady(scope!, lock);
      assert.notEqual(f.sql.controlSqlOutcome(lock).commitReturned, true); return result;
    });
    assert.deepEqual(view.receiptRef, closure.receiptRef); assert.deepEqual(await f.adapter.observeSourceClients(), before);
    const target = new Client({ connectionString: f.verificationTarget.connectionString }); await target.connect();
    try {
      assert.equal((await target.query("SELECT count(*)::text AS count FROM storage_source_clients")).rows[0].count,
        String(closure.manifests.controlRows.storage_source_clients.length), "the real isolated PostgreSQL target contains the fully restored archive");
    } finally { await target.end(); }
    const bridge = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "legacy-ready-bridge" }));
    assert.equal(bridge.node.record.ownerGeneration, before.state.ownerGeneration);
    assert.equal(bridge.node.record.fenceEpoch, before.state.fenceEpoch);
    assert.equal(bridge.node.record.formatVersion === 3 ? bridge.node.record.controlProof?.kind : null, "legacy-first-capture-bridge");
    assert.deepEqual((await f.adapter.observeSourceClients()).rows, before.rows);
    const takeover = await f.adapter.withSourceLock("control", lock => f.writer.commitControllerStep(scope!, lock, { kind: "takeover" }));
    assert.equal(takeover.node.record.ownerGeneration, before.state.ownerGeneration + 1);
    await f.adapter.withSourceLock("control", async lock => { assert((await lock.readSourceClientAudit(f.reference)).facts.actor.clientId); });
    assert.deepEqual(await f.store.readJson(closure.receiptRef, "receipt"), oldReceipt);
    assert.deepEqual(await f.store.readJson(closure.receipt.verification, "verification"), oldVerification);

    const connect = Client.prototype.connect, targetDatabase = new URL(f.verificationTarget.connectionString).pathname.slice(1);
    let targetConnections = 0;
    const stable = await f.adapter.observeSourceClients();
    try {
      Client.prototype.connect = function(this: Client, ...args: unknown[]) {
        if ((this as unknown as { connectionParameters: { database: string } }).connectionParameters.database === targetDatabase) targetConnections++;
        return Reflect.apply(connect, this, args);
      } as typeof connect;
      await assert.rejects(f.adapter.withSourceLock("snapshot", async lock => {
        await f.writer.assertControllerCommandWindow(scope!, lock);
        return f.adapter.verifyDatabase(f.store.pathFor(closure.receipt.database) + ".caller-copy", closure.manifests,
          f.store.root + "/attempts/wrong-caller-archive");
      }), { code: "snapshot_invalid" });
      assert.equal(targetConnections, 0, "caller path mismatch is rejected before opening a target or launching pg_restore");
    } finally { Client.prototype.connect = connect; }
    assert.deepEqual(await f.adapter.observeSourceClients(), stable);
  } finally { await f.close(); }
});

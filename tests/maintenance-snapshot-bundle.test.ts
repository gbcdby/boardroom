import test from "node:test";
import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { snapshotBundleFixture } from "./fixtures/maintenance-snapshot-bundle.ts";
import { verificationV3Fixture } from "./fixtures/maintenance-verification-v3.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";
import { readSqliteMaintenanceState } from "../src/server/storage/admission.ts";
import type { ArtifactRef, SourceLock } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const publish = async (store: ArtifactStore, lock: SourceLock) => {
  const snapshot = await import("../src/server/storage/maintenance/snapshot-bundle.ts");
  return snapshot.publishSnapshotBundle(store, lock);
};
const names = async (store: ArtifactStore) => (await readdir(store.root, { recursive: true })).sort();

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `C3 snapshot B/U ${kind}: actual D uses selected v3 replay rows while preserving the original roster`, async () => {
    const f = await verificationV3Fixture(kind);
    try {
      await f.advance("register"); await f.advance("recapture");
      const selected = await f.adapter.observe();
      const refs = await f.run(lock => publish(f.store, lock));
      const closure = await verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication);
      const origin = closure.chain.nodes.find(node => node.record.event === "capture")!;
      const capture = closure.chain.nodes.at(-1)!;
      assert.equal(capture.record.formatVersion, 3);
      assert.equal(closure.bundle.capture.journal.sha256, selected.state.journalDigest);
      assert.deepEqual(closure.manifests, selected.manifests);
      assert.equal(closure.manifests.controlRows.storage_source_clients.length, 1);
      assert(origin.record.formatVersion !== 1);
      assert.equal(origin.record.sourceClients!.rows.length, 0);
      assert.deepEqual(capture.record.sourceClients, origin.record.sourceClients);
      assert.deepEqual(capture.record.frozen, origin.record.frozen);
      assert.deepEqual(await f.adapter.observe(), selected);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 snapshot B/U ${kind}: real native backup binds exact Jq, typed DB controls and complete durable closure`, async () => {
    const f = await snapshotBundleFixture(kind);
    try {
      if (kind === "sqlite") assert.ok((await stat(f.file + "-wal")).size > 0, "committed WAL is present in the real source");
      const refs = await f.run(lock => publish(f.store, lock));
      assert.deepEqual(Object.keys(refs).sort(), ["bundle", "publication"]);
      const closed = await verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication);
      assert.deepEqual(closed.chain.nodes.at(-1)!.reference, f.capture.reference);
      assert.deepEqual(closed.manifests, f.sealed.manifests); assert.deepEqual(closed.files, f.files);
      assert.equal(closed.manifests.controlRows.storage_maintenance[0]!.journal_digest, f.capture.reference.sha256);
      assert.equal(closed.manifests.controlRows.storage_source_clients.length, f.sealed.manifests.controlRows.storage_source_clients.length);
      const bytes = await f.store.readBytes(closed.databaseRef);
      assert.equal(bytes.subarray(0, kind === "sqlite" ? 16 : 5).toString("binary"), kind === "sqlite" ? "SQLite format 3\0" : "PGDMP");
      if (kind === "sqlite") {
        const db = new Database(f.store.pathFor(closed.databaseRef), { readonly: true, fileMustExist: true });
        try {
          const cells = db.prepare("SELECT typeof(value) AS type,hex(value) AS bytes FROM enter_observation").all() as { type: string; bytes: string }[];
          assert.ok(cells.some(cell => cell.type === "blob" && cell.bytes === "00FF"));
          assert.ok(cells.some(cell => cell.type === "text" && cell.bytes === "80"));
          assert.equal(cells.filter(cell => cell.bytes === "6475706C6963617465").length, 2);
        } finally { db.close(); }
      }
      assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
      assert.ok(!(await names(f.store)).some(name => /\/(verification|receipt)\.json$/.test(name)));
    } finally { await f.close(); }
  });

nativeTest("#152 snapshot B/U: real head, business and complete raw roster mismatches reject before creating an attempt", async t => {
  for (const change of ["generation", "business", "roster"] as const) await t.test(change, async () => {
    const f = await snapshotBundleFixture("sqlite", { changeCapture(record) {
      if (change === "generation") return { ...record, ownerGeneration: record.ownerGeneration + 1 };
      if (change === "business") return { ...record, frozen: { ...record.frozen!, frozenBusinessManifestDigest: "f".repeat(64) } };
      const sourceClients = { ...record.sourceClients!, rows: record.sourceClients!.rows.map(row => ({ ...row,
        last_observed_at: ["text", Buffer.from("other immutable original").toString("hex")] as const })) };
      return { ...record, sourceClients, frozen: { ...record.frozen!, sourceClientsDigest: sourceClientsDigest(sourceClients) } };
    } });
    try {
      const before = await names(f.store);
      await assert.rejects(f.run(lock => publish(f.store, lock)), error => error instanceof MaintenanceFailure
        && error.code === (change === "generation" ? "journal_invalid" : "source_changed"));
      assert.deepEqual(await names(f.store), before); assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
    } finally { await f.close(); }
  });
});

nativeTest("#152 snapshot B/U: corrupted original Fs payload rejects before native backup or target writes", async t => {
  const f = await snapshotBundleFixture();
  try {
    const payload = f.files.entries.find(entry => entry.kind === "file")!.payload!;
    await writeFile(f.store.pathFor(payload), Buffer.alloc(Number(payload.bytes), 0));
    const before = await names(f.store); let backups = 0;
    await assert.rejects(f.run(async lock => {
      const backup = lock.backup.bind(lock); t.mock.method(lock, "backup", async (file: string) => { backups++; return backup(file); });
      return publish(f.store, lock);
    }), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    assert.equal(backups, 0); assert.deepEqual(await names(f.store), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 snapshot B/U: actual source marker, schema and guard drift remain rejected without artifact writes", async t => {
  for (const drift of ["source", "schema", "guard"] as const) await t.test(drift, async () => {
    const f = await snapshotBundleFixture();
    try {
      if (drift === "source") await f.exec(`BEGIN; PRAGMA defer_foreign_keys=ON;
        UPDATE storage_maintenance SET database_instance_id='${"2".repeat(32)}';
        UPDATE storage_source_clients SET database_instance_id='${"2".repeat(32)}'; COMMIT`);
      else if (drift === "schema") await f.exec("CREATE INDEX snapshot_schema_drift ON enter_observation(value)");
      else await f.exec(`UPDATE storage_maintenance SET guard_manifest_digest='${"f".repeat(64)}'`);
      const before = await names(f.store), controlSql = "SELECT database_instance_id,guard_manifest_digest,journal_digest,journal_sequence,admission FROM storage_maintenance";
      const control = await f.query(controlSql);
      await assert.rejects(f.run(lock => publish(f.store, lock)), error => error instanceof MaintenanceFailure
        && error.code === (drift === "source" ? "maintenance_lost" : drift === "schema" ? "source_changed" : "schema_guard_incomplete"));
      assert.deepEqual(await names(f.store), before); assert.deepEqual(await f.query(controlSql), control);
    } finally { await f.close(); }
  });
});

nativeTest("#152 snapshot B/U: a later exact observation anchor never selects an older capture as the current point", async () => {
  const f = await snapshotBundleFixture();
  try {
    await f.adapter.withSourceLock("control", async lock => {
      const current = await lock.observe();
      const reference = await f.store.putJson("journal", { ...f.capture.record, sequence: current.state.journalSequence + 1,
        previous: f.capture.reference, event: "observation", requestId: "later-observation", frozen: null, sourceClients: null });
      await lock.anchor({ expected: current.state, admission: "sealed", fenceEpoch: current.state.fenceEpoch,
        ownerGeneration: current.state.ownerGeneration, activeMigrationId: f.plan.migrationId, planDigest: f.reference.planDigest,
        controlRootIdentity: f.store.identity as never, mutexIdentity: f.mutex.identity, journal: reference,
        journalSequence: current.state.journalSequence + 1 });
    });
    const before = await names(f.store), current = await f.adapter.observe();
    await assert.rejects(f.run(lock => publish(f.store, lock)), error => error instanceof MaintenanceFailure && error.code === "phase_conflict");
    assert.deepEqual(await names(f.store), before); assert.deepEqual((await f.adapter.observe()).state, current.state);
  } finally { await f.close(); }
});

nativeTest("#152 snapshot B/U: a real backup with mismatched returned Md cannot publish a bundle", async t => {
  const f = await snapshotBundleFixture();
  try {
    let backups = 0;
    await assert.rejects(f.run(async lock => {
      const backup = lock.backup.bind(lock);
      t.mock.method(lock, "backup", async (file: string) => {
        const result = await backup(file); backups++;
        return { ...result, manifests: { ...result.manifests, capturedControlManifestDigest: "f".repeat(64) } };
      });
      return publish(f.store, lock);
    }), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    assert.equal(backups, 1); assert.ok(!(await names(f.store)).some(name => /\/(restore-bundle|publication)\.json$/.test(name)));
    assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 snapshot B/U: losing the real mutex after backup prevents publication and never advances Jq", async t => {
  const f = await snapshotBundleFixture();
  try {
    let backups = 0;
    await assert.rejects(f.run(async lock => {
      const backup = lock.backup.bind(lock);
      t.mock.method(lock, "backup", async (file: string) => { const result = await backup(file); backups++; await f.mutex.release(); return result; });
      return publish(f.store, lock);
    }), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    assert.equal(backups, 1); assert.ok(!(await names(f.store)).some(name => /\/(restore-bundle|publication)\.json$/.test(name)));
    assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 snapshot B/U: actual native reader close failure preserves the first error and cannot publish B/U", async t => {
  const f = await snapshotBundleFixture(), close = Database.prototype.close;
  const failure = new MaintenanceFailure("snapshot_invalid", "backup-reader-close"); let closes = 0, rejected = false;
  try {
    t.mock.method(Database.prototype, "close", function (this: Database.Database) {
      const result = close.call(this);
      if (this.name === f.file && this.readonly) { closes++; throw failure; }
      return result;
    });
    await assert.rejects(f.run(async lock => {
      try { await publish(f.store, lock); } catch (error) { rejected = true; assert.equal(error, failure); }
    }), error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
    assert.equal(rejected, true); assert.equal(closes, 1);
    assert.ok(!(await names(f.store)).some(name => /\/(restore-bundle|publication)\.json$/.test(name)));
    t.mock.restoreAll(); await f.mutex.release(); await f.adapter.close();
    const fresh = new Database(f.file, { readonly: true, fileMustExist: true });
    try { assert.deepEqual(readSqliteMaintenanceState(fresh, true), f.sealed.state); }
    finally { fresh.close(); }
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 snapshot B/U: failed durable confirmation retains throw undefined and cannot mint U", async t => {
  const f = await snapshotBundleFixture(), confirm = ArtifactStore.prototype.confirmDurable;
  let confirmations = 0, rejected = false;
  try {
    t.mock.method(ArtifactStore.prototype, "confirmDurable", async function (this: ArtifactStore, reference: ArtifactRef) {
      const result = await confirm.call(this, reference);
      if (this.kindFor(reference) === "restore-bundle") { confirmations++; throw undefined; }
      return result;
    });
    await f.run(async lock => {
      try { await publish(f.store, lock); } catch (error) { rejected = true; assert.equal(error, undefined); }
    });
    assert.equal(rejected, true); assert.equal(confirmations, 1);
    const artifacts = await names(f.store); assert.ok(artifacts.some(name => name.endsWith("/restore-bundle.json")));
    assert.ok(!artifacts.some(name => /\/(publication|verification|receipt)\.json$/.test(name)));
    assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 snapshot B/U ${kind}: publication response failure keeps the original error and leaves only unselected artifacts`, async t => {
    const f = await snapshotBundleFixture(kind), put = ArtifactStore.prototype.putJson;
    const failure = new MaintenanceFailure("snapshot_invalid", "publication-response"); let publications = 0, rejected = false;
    try {
      t.mock.method(ArtifactStore.prototype, "putJson", async function (this: ArtifactStore, ...args: Parameters<typeof put>) {
        const result = await Reflect.apply(put, this, args);
        if (args[0] === "publication") { publications++; throw failure; }
        return result;
      });
      await f.run(async lock => {
        try { await publish(f.store, lock); } catch (error) { rejected = true; assert.equal(error, failure); }
      });
      assert.equal(rejected, true); assert.equal(publications, 1);
      assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
      const originalNames = await names(f.store); assert.ok(originalNames.some(name => name.endsWith("/publication.json")));
      assert.ok(!originalNames.some(name => /\/(verification|receipt)\.json$/.test(name)));
    } finally { t.mock.restoreAll(); await f.close(); }
  });

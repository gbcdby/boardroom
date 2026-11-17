import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { verificationBundleFixture } from "./fixtures/maintenance-verify-bundle.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { restorePointDigest, verifyRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { parsePublication, parseVerification } from "../src/server/storage/maintenance/parse.ts";
import { readSqliteManifests } from "../src/server/storage/maintenance/sqlite-manifests.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ArtifactRef, PublicationEvidence } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
const artifacts = async (store: ArtifactStore) => (await readdir(store.root, { recursive: true })).sort();
const noVerification = async (store: ArtifactStore) => assert.ok(!(await artifacts(store)).some(name => name.endsWith("/verification.json")));
type Target = { kind: string; database: { kind?: string; path?: string; device?: string; inode?: string;
  formatVersion?: number; engine?: string; verificationTargetIdentity?: { databaseName: string; databaseOid: string; systemIdentifier: string };
  schemaManifestDigest?: string; fullDataManifestDigest?: string; frozenBusinessManifestDigest?: string;
  capturedControlManifestDigest?: string; exactFullDataAndControlMatched?: boolean };
  sourceFiles: { kind: string; target: { path: string }; entries: { sourceRoot: string; relativePath: string; kind: string; mode: string | null }[] } };

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 V ${kind}: same native snapshot restores real typed DB and files before publishing exact verification`, async () => {
    const f = await verificationBundleFixture(kind);
    try {
      await f.run(async lock => {
        const refs = await f.publish(lock), closed = await verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication);
        const reference = await verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication);
        const value = parseVerification(await f.store.readJson(reference, "verification"));
        assert.equal(f.store.kindFor(reference), "verification");
        assert.deepEqual(value.bundle, refs.bundle); assert.deepEqual(value.publication, refs.publication);
        assert.equal(value.exactFullDataAndControlMatched, true); assert.equal(value.sourceFilePayloadsMatched, true); assert.equal(value.schemaAndScopeMatched, true);
        const target = value.verificationTargetIdentity as unknown as Target;
        assert.equal(target.kind, "isolated-restore-targets"); assert.equal(target.sourceFiles.kind, "isolated-source-files-restore");
        if (kind === "sqlite") {
          assert(target.database.path); assert.notEqual(target.database.path, f.file);
          const db = new Database(target.database.path, { readonly: true, fileMustExist: true });
          try {
            assert.deepEqual(readSqliteManifests(db), closed.manifests);
            const cells = db.prepare("SELECT typeof(value) AS type,hex(value) AS bytes FROM enter_observation").all() as {type: string; bytes: string}[];
            assert.ok(cells.some(cell => cell.type === "blob" && cell.bytes === "00FF"));
            assert.ok(cells.some(cell => cell.type === "text" && cell.bytes === "80"));
            assert.equal(cells.filter(cell => cell.bytes === "6475706C6963617465").length, 2);
          } finally { db.close(); }
        } else {
          assert.equal(target.database.formatVersion, 1); assert.equal(target.database.engine, "postgres");
          assert.equal(target.database.verificationTargetIdentity?.databaseName, f.targetName);
          assert.notEqual(target.database.verificationTargetIdentity?.databaseName, f.database);
          assert.match(target.database.verificationTargetIdentity!.databaseOid, /^[0-9]+$/);
          assert.match(target.database.verificationTargetIdentity!.systemIdentifier, /^[0-9]+$/);
          assert.equal(target.database.exactFullDataAndControlMatched, true);
          assert.equal(target.database.schemaManifestDigest, closed.manifests.schemaManifestDigest);
          assert.equal(target.database.fullDataManifestDigest, closed.manifests.fullDataManifestDigest);
          assert.equal(target.database.frozenBusinessManifestDigest, closed.manifests.frozenBusinessManifestDigest);
          assert.equal(target.database.capturedControlManifestDigest, closed.manifests.capturedControlManifestDigest);
          assert.equal((await f.readTarget("SELECT COUNT(*)::int AS n FROM enter_observation WHERE value='duplicate'"))[0].n, 2);
          const control = (await f.readTarget("SELECT admission,journal_digest,journal_sequence FROM storage_maintenance"))[0];
          assert.equal(control.admission, "sealed"); assert.equal(control.journal_digest, f.capture.reference.sha256);
          assert.equal(Number(control.journal_sequence), f.sealed.state.journalSequence);
        }
        assert.equal(target.sourceFiles.entries.length, closed.files.entries.length);
        for (const entry of closed.files.entries) {
          const file = path.join(target.sourceFiles.target.path, entry.sourceRoot, entry.sourceRelativePath);
          if (entry.kind === "absent") await assert.rejects(lstat(file), { code: "ENOENT" });
          else {
            const info = await lstat(file); assert.equal(info.isDirectory(), entry.kind === "directory");
            assert.equal(info.mode & 0o7777, Number.parseInt(entry.mode!, 8));
            if (entry.kind === "file") assert.deepEqual(await readFile(file), await f.store.readBytes(entry.payload!));
          }
        }
        assert.deepEqual((await lock.observe()).state, f.sealed.state);
        assert.deepEqual((await lock.observe()).manifests, f.sealed.manifests);
        assert.equal((await artifacts(f.store)).filter(name => name.endsWith("/verification.json")).length, 1);
      });
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 V ${kind}: current native anchor accepts exact capture plus legal observation/takeover successors`, async () => {
    const f = await verificationBundleFixture(kind);
    try {
      const refs = await f.run(lock => f.publish(lock));
      const original = (await f.adapter.observe()).state;
      await f.advance("observation");
      await f.advance("takeover");
      await f.advance("observation");
      const current = (await f.adapter.observe()).state;
      assert.equal(current.fenceEpoch, original.fenceEpoch);
      assert.equal(current.ownerGeneration, original.ownerGeneration + 1);
      assert.equal(current.journalSequence, original.journalSequence + 3);
      const verification = await f.run(lock => verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication));
      const value = parseVerification(await f.store.readJson(verification, "verification"));
      assert.equal(value.exactFullDataAndControlMatched, true);
      assert.equal(value.sourceFilePayloadsMatched, true);
      assert.equal(value.schemaAndScopeMatched, true);
      assert.notEqual(current.journalRecordRef, f.capture.reference.ref);
      assert.equal((await f.adapter.observe()).state.journalDigest, current.journalDigest);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#228 V ${kind}: the native roster read must agree before database verification starts`, async () => {
    const f = await verificationBundleFixture(kind);
    try {
      await f.run(async lock => {
        const refs = await f.publish(lock);
        let restoreStarted = false;
        const adapter = { ...f.adapter, verifyDatabase: async () => {
          restoreStarted = true; throw new Error("database verification reached before source-client binding");
        } };
        // Only the returned observation is inconsistent. No source row, archive or process is changed.
        const inconsistent = { ...lock, observeSourceClients: async () => ({ ...await lock.observeSourceClients(), schemaManifestDigest: "f".repeat(64) }) };
        await assert.rejects(verifyRestoreBundle(f.store, adapter, inconsistent, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "source_changed");
        assert.equal(restoreStarted, false);
      });
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 V ${kind}: original B/U cannot authorize a new sealed migration on the same physical source`, async t => {
    const f = await verificationBundleFixture(kind);
    let restored = 0;
    try {
      const refs = await f.run(lock => f.publish(lock));
      const original = await f.adapter.observe();
      const replacement = await f.newSealedEpoch();
      const now = await f.adapter.observe();
      assert.deepEqual(now.source, original.source);
      assert.deepEqual(now.sourceIdentity, original.sourceIdentity);
      assert.equal(now.state.admission, "sealed");
      assert.ok(now.state.fenceEpoch > original.state.fenceEpoch);
      assert.notEqual(now.state.activeMigrationId, original.state.activeMigrationId);
      assert.equal(now.state.journalRecordRef, replacement.ref);
      const verify = f.adapter.verifyDatabase.bind(f.adapter);
      t.mock.method(f.adapter, "verifyDatabase", async (...args: Parameters<typeof verify>) => {
        restored++; return verify(...args);
      });
      const before = await artifacts(f.store);
      await f.run(async lock => {
        await assert.rejects(verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "maintenance_lost");
      });
      assert.equal(restored, 0);
      assert.deepEqual(await artifacts(f.store), before);
      await noVerification(f.store);
    } finally { t.mock.restoreAll(); await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 V ${kind}: illegal same-migration successor is not a capture continuation`, async t => {
    const f = await verificationBundleFixture(kind);
    let restores = 0;
    try {
      const refs = await f.run(lock => f.publish(lock));
      await f.adapter.withSourceLock("control", async lock => {
        const current = await lock.observe(), state = current.state;
        assert(state.journalRecordRef && state.journalDigest);
        // The native CAS admits a +1 generation, but the journal protocol requires
        // that this increment be caused by 'takeover', never 'observation'.
        const invalid = { ...f.capture.record, previous: f.capture.reference,
          sequence: state.journalSequence + 1, event: "observation" as const, phase: "quiesced" as const,
          ownerGeneration: state.ownerGeneration + 1, sourceClients: null, frozen: null,
          requestId: "v-illegal-successor", snapshot: null };
        const journal = await f.store.putJson("journal", invalid);
        await lock.anchor({ expected: state, admission: "sealed", fenceEpoch: state.fenceEpoch,
          ownerGeneration: invalid.ownerGeneration, activeMigrationId: state.activeMigrationId,
          planDigest: state.planDigest, controlRootIdentity: { ...f.store.identity }, mutexIdentity: f.mutex.identity,
          journal, journalSequence: invalid.sequence });
      });
      const verify = f.adapter.verifyDatabase.bind(f.adapter);
      t.mock.method(f.adapter, "verifyDatabase", async (...args: Parameters<typeof verify>) => {
        restores++; return verify(...args);
      });
      const before = await artifacts(f.store);
      await f.run(async lock => {
        await assert.rejects(verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication),
          error => error instanceof MaintenanceFailure && error.code === "journal_invalid");
      });
      assert.equal(restores, 0); assert.deepEqual(await artifacts(f.store), before); await noVerification(f.store);
    } finally { t.mock.restoreAll(); await f.close(); }
  });

nativeTest("#152 V: wrong role, hash and U binding reject before actual restore or new attempts", async t => {
  for (const fault of ["role", "hash", "publication"] as const) await t.test(fault, async () => {
    const f = await verificationBundleFixture(); let calls = 0;
    try {
      await f.run(async lock => {
        const refs = await f.publish(lock); let bundle = refs.bundle, publication = refs.publication;
        if (fault === "role") bundle = publication;
        else if (fault === "hash") bundle = { ...bundle, sha256: "f".repeat(64) };
        else {
          const body = parsePublication(await f.store.readJson(publication, "publication"));
          publication = await f.store.putJson("publication", { ...body, bundle: f.filesRef });
        }
        const before = await artifacts(f.store), verify = f.adapter.verifyDatabase.bind(f.adapter);
        t.mock.method(f.adapter, "verifyDatabase", async (...args: Parameters<typeof verify>) => { calls++; return verify(...args); });
        await assert.rejects(verifyRestoreBundle(f.store, f.adapter, lock, bundle, publication), error => error instanceof MaintenanceFailure
          && error.code === (fault === "publication" ? "journal_invalid" : "snapshot_invalid"));
        assert.equal(calls, 0); assert.deepEqual(await artifacts(f.store), before); await noVerification(f.store);
      });
    } finally { t.mock.restoreAll(); await f.close(); }
  });
});

nativeTest("#152 V: a byte-valid B/U with altered real database control rows fails the actual restore", async () => {
  const f = await verificationBundleFixture();
  try {
    await f.run(async lock => {
      const original = await f.publish(lock), closed = await verifyRestoreBundleClosure(f.store, original.bundle, original.publication);
      const attempt = await f.store.createAttempt(1), file = path.join(attempt, "changed.sqlite");
      await copyFile(f.store.pathFor(closed.databaseRef), file);
      const db = new Database(file, { fileMustExist: true });
      try { db.exec("UPDATE storage_maintenance SET owner_generation=owner_generation+1"); } finally { db.close(); }
      const database = await f.store.importDatabase(file);
      const body = { ...closed.bundle, entries: closed.bundle.entries.map(entry => entry.role === "database-snapshot" ? { ...entry, object: database } : entry),
        restorePointDigest: restorePointDigest({ capture: closed.bundle.capture, sourceFilesManifest: closed.bundle.sourceFilesManifest,
          database, manifests: closed.manifestsRef, schemaManifestDigest: closed.manifests.schemaManifestDigest,
          frozenBusinessManifestDigest: closed.manifests.frozenBusinessManifestDigest }) };
      const bundle = await f.store.putJson("restore-bundle", body), observedOperations: PublicationEvidence["observedOperations"][number][] = [];
      for (const reference of [...body.entries.map(entry => entry.object), bundle]) observedOperations.push(await f.store.confirmDurable(reference));
      const publication = await f.store.putJson("publication", { ...closed.publication, bundle, observedOperations });
      await verifyRestoreBundleClosure(f.store, bundle, publication);
      await assert.rejects(verifyRestoreBundle(f.store, f.adapter, lock, bundle, publication), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
      await noVerification(f.store); assert.deepEqual((await lock.observe()).state, f.sealed.state);
    });
  } finally { await f.close(); }
});

for (const fault of ["payload", "mutex"] as const) nativeTest(`#152 V: ${fault} loss after actual DB restoration cannot publish verification`, async t => {
  const f = await verificationBundleFixture(), verify = f.adapter.verifyDatabase.bind(f.adapter); let restores = 0;
  try {
    await assert.rejects(f.run(async lock => {
      const refs = await f.publish(lock);
      t.mock.method(f.adapter, "verifyDatabase", async (...args: Parameters<typeof verify>) => {
        const result = await verify(...args); restores++;
        if (fault === "payload") {
          const payload = f.files.entries.find(entry => entry.kind === "file")!.payload!;
          await writeFile(f.store.pathFor(payload), Buffer.alloc(Number(payload.bytes), 0));
        } else await f.mutex.release();
        return result;
      });
      return verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication);
    }), error => error instanceof MaintenanceFailure && error.code === (fault === "payload" ? "snapshot_invalid" : "maintenance_lost"));
    assert.equal(restores, 1); await noVerification(f.store);
    t.mock.restoreAll(); assert.deepEqual((await f.adapter.observe()).state, f.sealed.state);
  } finally { t.mock.restoreAll(); await f.close(); }
});

nativeTest("#152 V: an actual restored DB close failure retains its owner and forbids V", async t => {
  const f = await verificationBundleFixture(), close = Database.prototype.close;
  const failure = Object.freeze(new Error("verification-target-close")); let target: Database.Database | undefined;
  try {
    await f.run(async lock => {
      const refs = await f.publish(lock); let failed = false;
      t.mock.method(Database.prototype, "close", function(this: Database.Database) {
        if (this.name.endsWith("/database/restored.sqlite")) { target = this; throw failure; }
        return close.call(this);
      });
      try { await verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication); }
      catch (error) { failed = true; assert.equal(error, failure); }
      assert.equal(failed, true); assert.equal(target?.open, true); await noVerification(f.store);
      assert.deepEqual((await lock.observe()).state, f.sealed.state);
      t.mock.restoreAll();
    });
    await f.mutex.release(); await f.adapter.close(); assert.equal(target?.open, false);
  } finally { t.mock.restoreAll(); if (target?.open) close.call(target); await f.close(); }
});

for (const afterWrite of [false, true]) nativeTest(`#152 V: publication ${afterWrite ? "response" : "dispatch"} failure never returns success or writes readiness`, async t => {
  const f = await verificationBundleFixture(), put = ArtifactStore.prototype.putJson;
  let failed = false, writes = 0;
  try {
    await f.run(async lock => {
      const refs = await f.publish(lock);
      t.mock.method(ArtifactStore.prototype, "putJson", async function(this: ArtifactStore, ...args: Parameters<typeof put>): Promise<ArtifactRef> {
        if (args[0] !== "verification") return Reflect.apply(put, this, args);
        writes++; if (afterWrite) await Reflect.apply(put, this, args); throw undefined;
      });
      try { await verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication); }
      catch (error) { failed = true; assert.equal(error, undefined); }
      assert.equal(failed, true); assert.equal(writes, 1);
      const names = await artifacts(f.store);
      assert.equal(names.filter(name => name.endsWith("/verification.json")).length, afterWrite ? 1 : 0);
      assert.ok(!names.some(name => /\/(receipt|ready)\.json$/.test(name)));
      assert.deepEqual((await lock.observe()).state, f.sealed.state);
    });
  } finally { t.mock.restoreAll(); await f.close(); }
});

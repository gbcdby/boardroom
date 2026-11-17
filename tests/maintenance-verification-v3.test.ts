import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { verificationV3Fixture } from "./fixtures/maintenance-verification-v3.ts";
import { verifyRestoreBundle } from "../src/server/storage/maintenance/verify-bundle.ts";
import { verifyRestoreBundleClosure, verifyVerificationRestoreBundleClosure } from "../src/server/storage/maintenance/journal.ts";
import { parseJournal, parseVerification } from "../src/server/storage/maintenance/parse.ts";
import { publishSnapshotBundle } from "../src/server/storage/maintenance/snapshot-bundle.ts";
import { readSqliteManifests } from "../src/server/storage/maintenance/sqlite-manifests.ts";
import { inspectRegisteredSourceProcess } from "../src/server/storage/maintenance/source-facts.ts";
import type { ProcessCheck } from "../src/server/storage/maintenance/control-candidate/schema.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ArtifactRef, Json } from "../src/server/storage/maintenance/types.ts";

const nativeTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const pgTest = process.env.AGENT_STUDIO_PG_TEST_URL ? test : test.skip;
type Fixture = Awaited<ReturnType<typeof verificationV3Fixture>>;
function jsonObject(value: Json | undefined): asserts value is Readonly<Record<string, Json>> {
  assert(value && typeof value === "object" && !Array.isArray(value));
}
async function verifyActual(f: Fixture, refs: { bundle: ArtifactRef; publication: ArtifactRef }, capturedRows: number) {
  const closed = await verifyVerificationRestoreBundleClosure(f.store, refs.bundle, refs.publication);
  const live = await f.adapter.observe();
  const reference = await f.run(lock => verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication));
  const value = parseVerification(await f.store.readJson(reference, "verification"));
  assert.deepEqual(value.bundle, refs.bundle); assert.deepEqual(value.publication, refs.publication);
  assert.equal(value.exactFullDataAndControlMatched, true); assert.equal(value.sourceFilePayloadsMatched, true); assert.equal(value.schemaAndScopeMatched, true);
  const target = value.verificationTargetIdentity;
  jsonObject(target);
  const database = target.database;
  jsonObject(database);
  if (f.kind === "sqlite") {
    assert.equal(typeof database.path, "string"); assert.notEqual(database.path, f.file);
    const db = new Database(String(database.path), { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(readSqliteManifests(db), closed.manifests);
      assert.equal(db.prepare("SELECT count(*) FROM storage_source_clients").pluck().get(), capturedRows);
    } finally { db.close(); }
  } else {
    assert.equal(database.engine, "postgres"); assert.equal(database.exactFullDataAndControlMatched, true);
    assert.equal(database.fullDataManifestDigest, closed.manifests.fullDataManifestDigest);
    assert.equal(database.capturedControlManifestDigest, closed.manifests.capturedControlManifestDigest);
    assert.equal((await f.readTarget("SELECT count(*)::int AS n FROM storage_source_clients"))[0].n, capturedRows);
    assert.equal((await f.readTarget("SELECT journal_digest FROM storage_maintenance"))[0].journal_digest, closed.bundle.capture.journal.sha256);
  }
  assert.deepEqual(await f.adapter.observe(), live);
}

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#152 C3 AC16 / #248 V ${kind}: production D and V verify an unchanged v3 root and D rejects a non-capture head`, async () => {
    const f = await verificationV3Fixture(kind);
    try {
      const original = await f.store.readBytes(f.root.reference);
      for (const invalid of [{ ...f.root.record, formatVersion: 4 }, { ...f.root.record, controlProof: null },
        { ...f.root.record, controlProof: { ...f.root.record.controlProof, unknown: true } }])
        assert.throws(() => parseJournal(invalid), error => error instanceof MaintenanceFailure && error.code === "journal_invalid");
      const refs = await f.run(lock => publishSnapshotBundle(f.store, lock));
      const closed = await verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication);
      assert.deepEqual(closed.bundle.capture.journal, f.root.reference);
      assert.deepEqual(closed.chain.nodes.at(-1)?.record, f.root.record);
      assert.deepEqual(await verifyVerificationRestoreBundleClosure(f.store, refs.bundle, refs.publication), closed);
      await verifyActual(f, refs, 0);
      await f.advance("takeover");
      const before = await f.adapter.observe(), artifacts = (await readdir(f.store.root, { recursive: true })).sort();
      await assert.rejects(f.run(lock => publishSnapshotBundle(f.store, lock)),
        error => error instanceof MaintenanceFailure && error.code === "phase_conflict");
      assert.deepEqual(await f.adapter.observe(), before);
      assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), artifacts);
      assert.deepEqual(await f.store.readBytes(f.root.reference), original);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) for (const ending of [false, true]) (kind === "sqlite" ? nativeTest : pgTest)(
  `#248 V ${kind}: real registration and consecutive observations ${ending ? "then native exit" : "with a live controller"} restore the original capture`, async t => {
    const f = await verificationV3Fixture(kind);
    try {
      const refs = await f.run(lock => f.publish(lock)), registered = await f.advance("register");
      assert(registered.witness);
      await f.advance("observe"); await f.advance("observe");
      let inspected = await inspectRegisteredSourceProcess(registered.witness.host, registered.witness.process);
      assert.deepEqual(inspected.fact, { status: "present", reason: "identity_matches" });
      if (ending) {
        await registered.witness.close();
        inspected = await inspectRegisteredSourceProcess(registered.witness.host, registered.witness.process);
        assert.deepEqual(inspected.fact, { status: "exited", reason: "process_absent" });
        await f.advance("ended");
      }
      await verifyActual(f, refs, 0);
      t.diagnostic(`actual ${process.platform} ${inspected.fact.status}/${inspected.fact.reason}; native ${kind} backup and restore; no observe or verifyDatabase substitution`);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#248 V ${kind}: selected recapture binds its replay rows and still checks an earlier registration`, async () => {
    const f = await verificationV3Fixture(kind);
    try {
      await f.advance("register"); await f.advance("observe");
      const selected = await f.advance("recapture"), refs = await f.run(lock => f.publish(lock));
      const closed = await verifyVerificationRestoreBundleClosure(f.store, refs.bundle, refs.publication);
      assert.deepEqual(closed.bundle.capture.journal, selected.reference); assert.equal(f.root.roster.rows.length, 0);
      assert.equal(closed.manifests.controlRows.storage_source_clients.length, 1);
      await verifyActual(f, refs, 1);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#248 V ${kind}: a historical ended claim never replaces inspection of the still-live owned child`, async () => {
    const f = await verificationV3Fixture(kind);
    try {
      const refs = await f.run(lock => f.publish(lock)), registered = await f.advance("register");
      assert(registered.witness); await f.advance("observe");
      // Deliberately inconsistent historical data in this private fixture. The
      // isolated SQL mechanism accepts self-consistent data, never a process permit;
      // V must inspect the actual child and reject before any restore begins.
      await f.advance("ended", { change(record) {
        const proof = record.controlProof; assert(proof?.kind === "control-successor");
        return { ...record, controlProof: { ...proof, facts: { ...proof.facts, clients: proof.facts.clients.map(client => {
          let claimed: ProcessCheck;
          if (client.process.platform === "linux") {
            assert("observerUid" in client.processCheck);
            claimed = { kind: "linux-absent", observerUid: client.processCheck.observerUid, kernelBootId: client.process.kernelBootId,
              pidNamespace: client.process.pidNamespace, pid: client.process.pid, stage: "proc-open", errno: "ENOENT" };
          } else claimed = { kind: "darwin-absent", result: { version: 1, pid: client.process.pid,
            bootSessionUuid: client.process.bootSessionUuid, status: "absent" } };
          return { ...client, processCheck: claimed };
        }) } } };
      } });
      assert.deepEqual((await inspectRegisteredSourceProcess(registered.witness.host, registered.witness.process)).fact,
        { status: "present", reason: "identity_matches" });
      const artifacts = (await readdir(f.store.root, { recursive: true })).sort();
      await assert.rejects(f.run(lock => verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication)),
        error => error instanceof MaintenanceFailure && error.code === "source_changed");
      assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), artifacts);
    } finally { await f.close(); }
  });

for (const encoding of ["UTF-16le", "UTF-16be"] as const) nativeTest(
  `#248 V SQLite ${encoding}: real typed archive and head bytes round-trip through recapture and native exit`, async () => {
    const f = await verificationV3Fixture("sqlite", { sqliteEncoding: encoding });
    try {
      assert.equal(f.root.roster.textEncoding.name, encoding);
      const registered = await f.advance("register"); assert(registered.witness);
      await f.advance("observe"); await f.advance("recapture");
      const refs = await f.run(lock => f.publish(lock));
      await registered.witness.close(); await f.advance("ended");
      await verifyActual(f, refs, 1);
    } finally { await f.close(); }
  });

for (const kind of ["sqlite", "postgres"] as const) (kind === "sqlite" ? nativeTest : pgTest)(
  `#248 V ${kind}: an unchanged selected recapture cannot exempt an earlier controller from native inspection`, async () => {
    const f = await verificationV3Fixture(kind);
    try {
      const registered = await f.advance("register"); assert(registered.witness);
      await f.advance("observe"); await f.advance("recapture");
      const refs = await f.run(lock => f.publish(lock));
      const before = await f.adapter.observe(), artifacts = (await readdir(f.store.root, { recursive: true })).sort();
      await registered.witness.close(); // Deliberately no ended-observed journal change.
      assert.deepEqual((await inspectRegisteredSourceProcess(registered.witness.host, registered.witness.process)).fact,
        { status: "exited", reason: "process_absent" });
      await assert.rejects(f.run(lock => verifyRestoreBundle(f.store, f.adapter, lock, refs.bundle, refs.publication)),
        error => error instanceof MaintenanceFailure && error.code === "source_changed");
      assert.deepEqual(await f.adapter.observe(), before);
      assert.deepEqual((await readdir(f.store.root, { recursive: true })).sort(), artifacts, "no restore attempt or V may be created");
    } finally { await f.close(); }
  });

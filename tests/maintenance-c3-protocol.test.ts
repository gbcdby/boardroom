import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import type { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import type { ArtifactRef, DatabaseManifests, JournalRecord, Json, SourceClientRawRow } from "../src/server/storage/maintenance/types.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { encodePostgresCell } from "../src/server/storage/maintenance/postgres-manifests.ts";
import { sourceClientColumns } from "../src/server/storage/maintenance/source-clients-read.ts";
import * as parse from "../src/server/storage/maintenance/parse.ts";
import * as journal from "../src/server/storage/maintenance/journal.ts";
import { parseControlJournalCandidate } from "../src/server/storage/maintenance/control-candidate/codec.ts";
import { reconstructControlCandidates } from "../src/server/storage/maintenance/control-candidate/replay.ts";
import { CandidateContents } from "../src/server/storage/maintenance/control-candidate/content.ts";
import { bindSourceClientManifestRows, decodeRow, encodeText, supportedEncoding } from "../src/server/storage/maintenance/control-candidate/rows.ts";
import { controlVector, currentClient, historicalClient, successorVector } from "./fixtures/maintenance-control-candidate.ts";

// Entirely supplied data. None of these vectors is a source lock, process audit or executed restore.
const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "journal_invalid";
type Vector = ReturnType<typeof controlVector>;
function suppliedStore(f: Vector): ArtifactStore {
  const contents = new CandidateContents({ objects: f.objects.map(item => ({ reference: item.reference, bytes: Uint8Array.from(item.bytes) })),
    head: f.enterRef, controlRoot: f.root, mutexIdentity: f.mutex });
  // Only the readonly content methods are exercised. This fake never enters an adapter or service.
  return { root: f.root.path, identity: f.root, kindFor: reference => contents.kind(reference),
    readBytes: async reference => contents.bytes(reference, contents.kind(reference)),
    readJson: async (reference, kind) => contents.json(reference, kind ?? contents.kind(reference)),
    verifyFile: async reference => { contents.bytes(reference, contents.kind(reference)); } } as ArtifactStore;
}
function sourceTable(f: Vector, rows: readonly SourceClientRawRow[]) {
  const decoded = rows.map(row => decodeRow(row, f.encoding)!);
  const typed: Json[] = rows.map((row, index) => sourceClientColumns.map(column => f.source.kind === "sqlite"
    ? [...row[column.name]] : encodePostgresCell(column.postgres, decoded[index]![column.name])));
  const columns = sourceClientColumns.map((column, index) => f.source.kind === "sqlite"
    ? { cid: String(index), name: column.name, type: column.sqlite, notnull: column.nullable || index === 0 ? "0" : "1" }
    : { position: String(index + 1), name: column.name, type_oid: column.postgres, not_null: !column.nullable });
  return { table: { name: "storage_source_clients", columns, ...digestRowMultiset(typed) }, decoded };
}
function manifestVector(f: Vector, rows: readonly SourceClientRawRow[]) {
  const { table, decoded } = sourceTable(f, rows);
  return buildDatabaseManifests(f.source.kind, { fixture: "schema" }, [table], { storage_maintenance: [], storage_source_clients: decoded });
}
function baseCapture(f: Vector, version: 2 | 3 = 3) {
  f.captured.frozen.frozenBusinessManifestDigest = digestJson({ dialect: f.source.kind, schemaManifestDigest: f.plan.schemaManifestDigest, tables: [] });
  const { controlProof, ...body } = f.captured;
  const record = parse.parseJournal(version === 3 ? { ...body, controlProof } : { ...body, formatVersion: 2 });
  return { record, reference: f.pack("journal", record) };
}
function readyVector(f: Vector, prefix: readonly journal.JournalNode[], rows: readonly SourceClientRawRow[] = [],
  facts: unknown = f.facts, omitRole?: string) {
  const selected = prefix.at(-1)!, origin = prefix.find(node => node.record.event === "capture")!;
  assert.ok(selected.record.frozen);
  const capture = journal.captureReference(selected), source = sourceTable(f, rows);
  const control = { singleton: 1, database_instance_id: f.source.databaseInstanceId, control_root_json: canonicalJson(f.root), mutex_identity_json: canonicalJson(f.mutex),
    fence_epoch: selected.record.fenceEpoch, admission: "sealed", active_migration_id: "a12", plan_digest: f.planRef.sha256, protocol_version: 1,
    guard_manifest_digest: f.plan.guardManifestDigest, owner_generation: capture.ownerGeneration, journal_record_ref: selected.reference.ref,
    journal_digest: selected.reference.sha256, journal_sequence: selected.record.sequence };
  const manifests = buildDatabaseManifests(f.source.kind, { fixture: "schema" }, [source.table,
    { name: "storage_maintenance", columns: ["pure-maintenance-projection"], ...digestRowMultiset([control]) }],
    { storage_maintenance: [control], storage_source_clients: source.decoded });
  const manifestsRef = f.pack("database-manifests", manifests), database = f.pack("database-snapshot", Buffer.from("PURE content; never restored"));
  const capability = f.pack("capability", { formatVersion: 1, kind: "capability", node: "pure-fixture", rootIdentity: f.root, powerLossTested: false,
    probeDigest: "1".repeat(64), platform: "linux", filesystemType: "61267", guarantee: "observed-file-fsync-rename-directory-fsync" });
  const partial = { capture, sourceFilesManifest: f.filesRef, database, manifests: manifestsRef,
    schemaManifestDigest: f.plan.schemaManifestDigest, frozenBusinessManifestDigest: selected.record.frozen.frozenBusinessManifestDigest };
  const point = journal.restorePointDigest(partial), entries = [{ role: "plan", object: f.planRef },
    ...prefix.map(node => ({ role: node === selected ? "capture-journal" : "journal-prefix", object: node.reference })),
    { role: "source-files-manifest", object: f.filesRef }, { role: "database-snapshot", object: database },
    { role: "database-expected-manifests", object: manifestsRef }, { role: "capability-evidence", object: capability }].filter(entry => entry.role !== omitRole);
  const bundle = f.pack("restore-bundle", { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: f.filesRef, restorePointDigest: point, entries });
  const publication = f.pack("publication", { formatVersion: 1, kind: "publication", bundle, capability,
    observedOperations: [...entries.map(entry => entry.object), bundle].map(artifact => ({ artifact, completed: ["file_sync", "rename", "directory_sync"] })) });
  const verification = f.pack("verification", { formatVersion: 1, kind: "verification", bundle, publication, verificationTargetIdentity: { fixture: "untrusted-only" },
    exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
  const receiptRef = f.pack("receipt", { formatVersion: 1, kind: "receipt", snapshotId: "pure-ready", ...partial, restorePointDigest: point,
    bundle, publication, verification, capability, fullDataManifestDigest: manifests.fullDataManifestDigest, capturedControlManifestDigest: manifests.capturedControlManifestDigest });
  const successor = successorVector(f, { origin: origin.reference, previous: selected.reference, sequence: selected.record.sequence + 1,
    before: rows, after: rows, clients: [], changes: [], fromGeneration: selected.record.ownerGeneration, toGeneration: selected.record.ownerGeneration });
  const { controlProof: _proof, ...body } = successor;
  const record = parse.parseJournal({ ...body, formatVersion: selected.record.formatVersion, event: "ready", phase: "snapshot_ready", snapshot: receiptRef,
    ...(selected.record.formatVersion === 3 ? { controlProof: { ...successor.controlProof, facts } } : {}) });
  return { record, reference: f.pack("journal", record), manifests, manifestsRef, receiptRef, database, bundle, publication, verification };
}
function cancellation() {
  const f = controlVector(), origin = f.pack("journal", f.captured);
  const successor = successorVector(f, { origin, previous: origin, sequence: 3, before: [], after: [], clients: [], changes: [] });
  const intent = { ...successor, event: "cancel_intent", requestId: "cancel" };
  const intentRef = f.pack("journal", intent);
  const terminal = { ...intent, sequence: 4, event: "cancelled", previous: intentRef, fenceEpoch: 3,
    controlProof: { formatVersion: 1, kind: "cancel-terminal-controls", originCapture: origin,
      originSourceClientsDigest: f.captured.frozen.sourceClientsDigest, source: f.source, plan: f.planRef, migrationId: "a12",
      epochBefore: "2", epochAfter: "3", receiptGeneration: "7", textEncoding: f.encoding, previousAnchor: intentRef,
      ownerGeneration: "7", targetSequence: "4", beforeRowsDigest: f.rowsDigest([]), afterRowsDigest: f.rowsDigest([]),
      changes: [], facts: f.facts, successorRule: "open-next-epoch-clear-active-v1" } };
  return { f, origin, intent, intentRef, terminal };
}

test("C3 PURE AC16/36: default strict v3 codec accepts independent intent and terminal shapes", () => {
  const f = cancellation();
  for (const record of [f.f.enter, f.f.captured, f.intent, f.terminal]) {
    assert.deepEqual(parse.parseJournal(record), record);
    assert.deepEqual(parseControlJournalCandidate(record), record);
  }
  for (const event of ["cancel_intent", "cancelled"]) {
    assert.throws(() => parseControlJournalCandidate({ ...f.intent, event, controlProof: null }), invalid);
  }
});

test("C3 PURE AC35/36: terminal replay preserves sealed origin and all rows, with an exact open E+1 projection", () => {
  const f = cancellation(), head = f.f.pack("journal", f.terminal);
  const result = reconstructControlCandidates({ head, objects: f.f.objects, controlRoot: f.f.root, mutexIdentity: f.f.mutex });
  assert.equal(result.kind, "untrusted-control-reconstruction");
  if (result.kind !== "untrusted-control-reconstruction") assert.fail("terminal needs the original capture");
  assert.equal(result.cancellation, "terminal");
  assert.deepEqual(result.sealedInvariant, f.f.invariant);
  assert.deepEqual(result.expectedRows, []);
  assert.deepEqual(result.expectedMaintenance, { ...f.f.invariant, admission: "open", fenceEpoch: "3", activeMigrationId: null,
    planDigest: null, ownerGeneration: "7", journalRecordRef: head.ref, journalDigest: head.sha256, journalSequence: "4" });
  assert.ok(result.runtimeObligations.includes("actual-db-exact-anchor-and-source-lock"));
  assert.equal(Object.hasOwn(result, "permit"), false);
});

test("C3 PURE AC36: wrong terminal epoch, generation, origin, self hash or nonempty changes rejects", () => {
  for (const mutate of [
    (record: any) => { record.controlProof.epochBefore = "1"; },
    (record: any) => { record.controlProof.epochAfter = "4"; },
    (record: any) => { record.controlProof.ownerGeneration = "8"; },
    (record: any) => { record.controlProof.previousAnchor = record.controlProof.originCapture; },
    (record: any) => { record.controlProof.beforeRowsDigest = "0".repeat(64); },
    (record: any) => { record.controlProof.afterRowsDigest = "0".repeat(64); },
    (record: any) => { record.controlProof.afterJournal = { sha256: "1".repeat(64) }; },
    (record: any) => { record.controlProof.changes = [{}]; },
    (record: any) => { record.controlProof.successorRule = "open"; },
  ]) {
    const f = cancellation(); mutate(f.terminal);
    const head = f.f.pack("journal", f.terminal);
    assert.throws(() => reconstructControlCandidates({ head, objects: f.f.objects, controlRoot: f.f.root, mutexIdentity: f.f.mutex }), invalid);
  }
});

test("C3 PURE AC33/36: pending cannot advance, terminal cannot have a successor", () => {
  const f = cancellation(), terminalRef = f.f.pack("journal", f.terminal);
  for (const record of [
    { ...f.f.captured, previous: f.intentRef, sequence: 4 },
    { ...f.intent, event: "observation", previous: terminalRef, sequence: 5, fenceEpoch: 3 },
  ]) {
    const head = f.f.pack("journal", record);
    assert.throws(() => reconstructControlCandidates({ head, objects: f.f.objects, controlRoot: f.f.root, mutexIdentity: f.f.mutex }), invalid);
  }
});

test("C3 PURE AC19/20: encoding does not silently replace invalid text or erase empty non-UTF8 obligations", () => {
  for (const name of ["UTF-8", "UTF-16le", "UTF-16be"]) {
    assert.throws(() => encodeText("\ud800", { backend: "sqlite", name }), invalid);
  }
  assert.equal(supportedEncoding({ backend: "sqlite", name: "unrecognized" }), false);
  const f = controlVector({ backend: "postgres", encoding: "LATIN1" }), head = f.pack("journal", f.captured);
  const result = reconstructControlCandidates({ head, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.equal(result.kind, "untrusted-control-reconstruction");
  assert.ok(result.kind === "untrusted-control-reconstruction" && result.runtimeObligations.includes("raw-identity-profile-encoding"));
});

test("C3 PURE AC25/27: public canonical request domains stay distinct from every stage wrapper", () => {
  const f = controlVector(), request = { plan: { migrationId: "a12", planDigest: f.planRef.sha256, immutablePlan: f.planRef, controlRoot: f.root.path },
    expectedSource: f.source, expectedPhase: null, expectedJournalDigest: null, requestId: "one-command" };
  const digests = ["execute-migration", "resume-migration", "cancel-migration"].map(operation => {
    const command = parse.parseMaintenanceCommand({ operation, request });
    return parse.maintenanceRequestDigest(command);
  });
  assert.equal(new Set(digests).size, 3);
  for (const operation of ["internal-enter", "internal-capture", "internal-capture-snapshot", "stage-snapshot-ready"])
    assert.ok(!digests.includes(digestJson({ operation, request })));
  assert.throws(() => parse.parseMaintenanceCommand({ operation: "execute-migration", request: { ...request, proof: true } }),
    error => error instanceof MaintenanceFailure && error.code === "request_conflict");
  assert.equal(canonicalJson(request), canonicalJson(structuredClone(request)));
});

test("C3 PURE AC25/26: request replay classifies only its exact continuous anchored suffix", () => {
  const f = controlVector(), request = { plan: { migrationId: "a12", planDigest: f.planRef.sha256, immutablePlan: f.planRef, controlRoot: f.root.path },
    expectedSource: f.source, expectedPhase: null, expectedJournalDigest: null, requestId: "one-command" };
  const command = parse.parseMaintenanceCommand({ operation: "execute-migration", request }), requestDigest = parse.maintenanceRequestDigest(command);
  const enter = { ...f.enter, requestId: request.requestId, requestDigest }, enterRef = f.pack("journal", enter);
  const captured = { ...f.captured, previous: enterRef, requestId: request.requestId, requestDigest }, captureRef = f.pack("journal", captured);
  const nodes = [{ reference: enterRef, record: parse.parseJournal(enter) }, { reference: captureRef, record: parse.parseJournal(captured) }];
  const result = journal.classifyMaintenanceRequest(nodes, command);
  assert.equal(result.kind, "untrusted-request-prefix");
  assert.equal(result.status, "paused");
  const conflict = (error: unknown) => error instanceof MaintenanceFailure && error.code === "request_conflict";
  assert.throws(() => journal.classifyMaintenanceRequest(nodes, { ...command, operation: "resume-migration" }), conflict);
  const later = { ...captured, event: "observation", frozen: null, sourceClients: null, sequence: 3, previous: captureRef,
    requestId: "later", requestDigest: "8".repeat(64), controlProof: successorVector(f,
      { origin: captureRef, previous: captureRef, sequence: 3, before: [], after: [], clients: [], changes: [] }).controlProof };
  const laterRef = f.pack("journal", later);
  assert.throws(() => journal.classifyMaintenanceRequest([...nodes, { reference: laterRef, record: parse.parseJournal(later) }], command), conflict);
});

test("C3 PURE AC16: default version matrix keeps original v1/v2 bytes and V quiesced purpose", async t => {
  for (const initialVersion of [1, 2, 3] as const) await t.test(`planned v${initialVersion} to first v3 and ready`, async () => {
    const f = controlVector({ initialVersion }), old = Buffer.from(f.objects[0]!.bytes), capture = baseCapture(f);
    const prefix = [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, capture];
    const ready = readyVector(f, prefix), store = suppliedStore(f);
    assert.deepEqual((await journal.verifyJournalChain(store, capture.reference)).nodes.map(node => node.record.formatVersion), [initialVersion, 3]);
    assert.equal((await journal.verifyJournalChain(store, ready.reference)).nodes.at(-1)!.record.event, "ready");
    assert.equal((await journal.verifySnapshotClosure(store, ready.reference)).receipt.capture.journal.sha256, capture.reference.sha256);
    assert.equal((await journal.verifyVerificationJournalChain(store, capture.reference)).nodes.length, 2);
    await assert.rejects(journal.verifyVerificationJournalChain(store, ready.reference), invalid);
    assert.deepEqual(f.objects[0]!.bytes, old);
  });
  await t.test("v2 capture never turns into a v3 successor; v3 never downgrades", async () => {
    const f = controlVector({ initialVersion: 2 }), oldCapture = baseCapture(f, 2);
    const next = successorVector(f, { origin: oldCapture.reference, previous: oldCapture.reference, sequence: 3, before: [], after: [], clients: [], changes: [] });
    const mixed = f.pack("journal", next);
    await assert.rejects(journal.verifyJournalChain(suppliedStore(f), mixed), invalid);
    const v3 = baseCapture(f), { controlProof: _proof, ...body } = next;
    const downgrade = f.pack("journal", { ...body, formatVersion: 2, previous: v3.reference });
    await assert.rejects(journal.verifyJournalChain(suppliedStore(f), downgrade), invalid);
    assert.throws(() => parse.parseJournal({ ...next, formatVersion: 4 }), invalid);
  });
});

test("C3 PURE AC16/31: only a complete first-capture legacy ready can bridge, then remains v3", async () => {
  const f = controlVector({ initialVersion: 2 }), capture = baseCapture(f, 2);
  const prefix = [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, capture], ready = readyVector(f, prefix);
  const normal = successorVector(f, { origin: capture.reference, previous: ready.reference, sequence: 4, before: [], after: [], clients: [], changes: [] });
  const bridge = { ...normal, phase: "snapshot_ready", controlProof: { ...normal.controlProof, kind: "legacy-first-capture-bridge",
    legacy: { ready: ready.reference, receipt: ready.receiptRef, manifests: ready.manifestsRef } } };
  const bridgeRef = f.pack("journal", bridge), store = suppliedStore(f);
  assert.equal((await journal.verifyJournalChain(store, ready.reference)).nodes.at(-1)!.record.formatVersion, 2);
  assert.equal((await journal.verifyJournalChain(store, bridgeRef)).nodes.at(-1)!.record.formatVersion, 3);
  await assert.rejects(journal.verifyVerificationJournalChain(store, bridgeRef), invalid);
  const reconstruction = reconstructControlCandidates({ head: bridgeRef, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.ok(reconstruction.kind === "untrusted-control-reconstruction" && reconstruction.runtimeObligations.includes("actual-first-capture-restore-and-raw-rows"));
  for (const record of [
    { ...bridge, controlProof: { ...bridge.controlProof, legacy: { ...bridge.controlProof.legacy, ready: capture.reference } } },
    { ...bridge, event: "takeover", ownerGeneration: 8 },
    { ...bridge, phase: "quiesced", previous: capture.reference, sequence: 3 },
  ]) {
    const head = f.pack("journal", record);
    await assert.rejects(journal.verifyJournalChain(suppliedStore(f), head), invalid);
  }
});

test("C3 PURE AC21: every default ready read verifies the complete DAG before returning", async t => {
  for (const missing of ["plan", "journal-prefix", "capture-journal", "source-files-manifest", "database-snapshot", "database-expected-manifests", "capability-evidence"])
    await t.test(`bundle missing ${missing}`, async () => {
      const f = controlVector(), capture = baseCapture(f), ready = readyVector(f,
        [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, capture], [], f.facts, missing);
      await assert.rejects(journal.verifyJournalChain(suppliedStore(f), ready.reference), invalid);
    });
  for (const missing of ["database", "manifestsRef", "bundle", "publication", "verification", "receiptRef"] as const)
    await t.test(`missing ${missing} bytes`, async () => {
      const f = controlVector(), capture = baseCapture(f), ready = readyVector(f, [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, capture]);
      const index = f.objects.findIndex(item => item.reference.ref === ready[missing].ref);
      assert.ok(index >= 0); f.objects.splice(index, 1);
      await assert.rejects(journal.verifyJournalChain(suppliedStore(f), ready.reference), invalid);
    });
});

test("C3 PURE AC35/36: default reader consumes terminal proof, V-only reader refuses cancellation", async () => {
  const f = cancellation(), terminal = f.f.pack("journal", f.terminal), store = suppliedStore(f.f);
  assert.equal((await journal.verifyJournalChain(store, f.intentRef)).nodes.at(-1)!.record.event, "cancel_intent");
  assert.equal((await journal.verifyJournalChain(store, terminal)).nodes.at(-1)!.record.fenceEpoch, 3);
  for (const reference of [f.intentRef, terminal]) await assert.rejects(journal.verifyVerificationJournalChain(store, reference), invalid);
});

test("C3 PURE AC18/19: all supported encodings bind original text and exact native typed cells", t => {
  for (const [backend, name] of [["sqlite", "UTF-8"], ["sqlite", "UTF-16le"], ["sqlite", "UTF-16be"], ["postgres", "UTF8"]] as const) {
    const f = controlVector({ backend, encoding: name }), { row } = historicalClient(f, "原始 client 🧪");
    const wide: SourceClientRawRow = { ...row, observed_epoch: ["integer", "9223372036854775807"] };
    const manifests = manifestVector(f, [wide]), original = canonicalJson(wide);
    const result = bindSourceClientManifestRows(manifests, [wide], f.encoding);
    assert.equal(result.kind, "untrusted-source-client-manifest-binding");
    assert.equal(result.rows[0]!.observed_epoch, "9223372036854775807");
    assert.equal(result.rows[0]!.client_id, "原始 client 🧪");
    assert.equal(canonicalJson(wide), original);
    const empty = manifestVector(f, []);
    assert.equal(bindSourceClientManifestRows(empty, [], f.encoding).rows.length, 0);
    t.diagnostic(`${backend}/${name}: nonempty and empty typed/raw projection, not a native DB check`);
  }
});

test("C3 PURE AC18: count, column/OID, digest, null, raw text and 64-bit projection mismatches reject", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const f = controlVector({ backend }), { row } = historicalClient(f), manifests = manifestVector(f, [row]);
    for (const mutate of [
      (md: any) => { md.tables[0].count = "0"; },
      (md: any) => { md.tables[0].digest = "0".repeat(64); },
      (md: any) => { md.tables[0].columns.pop(); },
      (md: any) => { md.tables[0].columns[0].name = "unknown"; },
      (md: any) => { md.tables[0].columns[0][backend === "sqlite" ? "type" : "type_oid"] = backend === "sqlite" ? "INTEGER" : "20"; },
      (md: any) => { md.controlRows.storage_source_clients[0].host_identity_json = md.controlRows.storage_source_clients[0].host_identity_json.trim(); },
      (md: any) => { md.controlRows.storage_source_clients[0].drain_receipt_digest = ""; },
      (md: any) => { md.controlRows.storage_source_clients[0].observed_epoch = Number.MAX_SAFE_INTEGER + 1; },
      (md: any) => { md.controlRows.storage_source_clients[0].extra = null; },
    ]) {
      const bad = structuredClone(manifests); mutate(bad);
      assert.throws(() => bindSourceClientManifestRows(bad, [row], f.encoding), invalid);
    }
    const empty = manifestVector(f, []), malformed = structuredClone(empty) as any;
    malformed.tables[0].columns[0][backend === "sqlite" ? "type" : "type_oid"] = "unverified";
    assert.throws(() => bindSourceClientManifestRows(malformed, [], f.encoding), invalid);
    const columns = manifests.tables[0]!.columns;
    assert.throws(() => bindSourceClientManifestRows(manifests, [row], f.encoding, [...(columns as Json[]), "extra"]), invalid);
  }
});

test("C3 PURE AC19/20: illegal byte sequences and unknown PG encodings never pass empty/equal bindings", () => {
  for (const [backend, name, bytes] of [["sqlite", "UTF-8", "c080"], ["sqlite", "UTF-16le", "00d8"], ["sqlite", "UTF-16be", "d800"],
    ["postgres", "UTF8", "eda080"]] as const) {
    const f = controlVector({ backend, encoding: name }), { row } = historicalClient(f);
    assert.throws(() => decodeRow({ ...row, client_id: ["text", bytes] }, f.encoding), invalid);
  }
  const f = controlVector({ backend: "postgres" }), { row } = historicalClient(f);
  for (const rows of [[], [row]]) for (const name of ["LATIN1", "SQL_ASCII", "EUC_JP"]) {
    assert.throws(() => bindSourceClientManifestRows(manifestVector(f, rows), rows, { backend: "postgres", name }),
      error => error instanceof MaintenanceFailure && error.code === "source_changed"
        && error.message === "storage_maintenance: source_changed (v3-source-clients-encoding-unverified)");
  }
});

test("C3 PURE AC17: O→S registration stays in every subsequent ready proof and selected Md", async () => {
  const f = controlVector(), origin = baseCapture(f), observedAt = "2026-11-15T00:01:00.000Z";
  const creation = { migrationId: "a12", plan: f.planRef, fenceEpoch: "2", ownerGeneration: "8", previousAnchor: origin.reference, targetSequence: "3" };
  const envelope = { formatVersion: 1, kind: "maintenance-controller-registration", source: f.source, sourceIdentityDigest: f.source.identityDigest,
    creation, sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
  const row: SourceClientRawRow = { client_id: f.text("controller-before-selected"), database_instance_id: f.text(f.source.databaseInstanceId),
    entrypoint: f.text("maintenance-controller"), build_id: f.text("boardroom-maintenance-control-v1"), host_identity_json: f.text(canonicalJson(f.facts.actor.host)),
    process_identity_json: f.text(canonicalJson(f.facts.actor.process)), db_sessions_json: f.text(canonicalJson(envelope)), registered_at: f.text(observedAt),
    last_observed_at: f.text(observedAt), drain_state: f.text("none"), drain_receipt_digest: ["null"], ended_at: ["null"], protocol_version: ["integer", "1"],
    registered_epoch: ["integer", "2"], observed_epoch: ["integer", "2"], drain_epoch: ["null"] };
  const takeover = parse.parseJournal(successorVector(f, { origin: origin.reference, previous: origin.reference, sequence: 3,
    before: [], after: [row], clients: [], changes: [{ kind: "maintenance-registration", before: null, after: row, actorId: f.facts.actor.actorId }],
    event: "takeover", fromGeneration: 7, toGeneration: 8 }));
  const takeoverRef = f.pack("journal", takeover), actor = { ...f.facts.actor, clientId: row.client_id };
  const client = { kind: "maintenance-controller", subject: row.client_id, rowDigest: f.rowDigest(row), host: actor.host, process: actor.process,
    processCheck: actor.processCheck, classification: "active-actor", registration: "current-chain" };
  const facts = { ...f.facts, actor, beforeCount: "1", beforeRowsDigest: f.rowsDigest([row]), clients: [client] };
  const next = successorVector(f, { origin: origin.reference, previous: takeoverRef, sequence: 4, before: [row], after: [row],
    clients: [client], changes: [], actor, fromGeneration: 8, toGeneration: 8 });
  const selected = { ...next, event: "capture", sourceClients: f.roster, frozen: f.captured.frozen }, selectedRef = f.pack("journal", selected);
  const prefix = [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, origin,
    { record: takeover, reference: takeoverRef }, { record: parse.parseJournal(selected), reference: selectedRef }];
  const ready = readyVector(f, prefix, [row], facts);
  assert.equal((await journal.verifySnapshotClosure(suppliedStore(f), ready.reference)).receipt.capture.journal.sha256, selectedRef.sha256);
  const replay = reconstructControlCandidates({ head: ready.reference, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.ok(replay.kind === "untrusted-control-reconstruction");
  assert.deepEqual(replay.originalRoster.rows, []);
  assert.deepEqual(replay.expectedRows, [row]);
  assert.equal(replay.events.length, 4);
  // Build a separate ordinary bad input from the start; no live/archive rewrite or rehash probe.
  const missing = readyVector(f, prefix, [], { ...f.facts });
  await assert.rejects(journal.verifyJournalChain(suppliedStore(f), missing.reference), invalid);
});

test("C3 PURE AC31: later v2 recapture and non-UTF8 keep legacy reads but cannot bridge", async () => {
  for (const nonUtf of [false, true]) {
    const f = controlVector(nonUtf ? { backend: "postgres", encoding: "LATIN1", initialVersion: 2 } : { initialVersion: 2 });
    const origin = baseCapture(f, 2), prefix = [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, origin];
    if (!nonUtf) {
      const record = parse.parseJournal({ ...origin.record, sequence: 3, previous: origin.reference, requestId: "later-capture" });
      prefix.push({ record, reference: f.pack("journal", record) });
    }
    const ready = readyVector(f, prefix), next = successorVector(f, { origin: origin.reference, previous: ready.reference,
      sequence: ready.record.sequence + 1, before: [], after: [], clients: [], changes: [] });
    const bridge = { ...next, phase: "snapshot_ready", controlProof: { ...next.controlProof, kind: "legacy-first-capture-bridge",
      legacy: { ready: ready.reference, receipt: ready.receiptRef, manifests: ready.manifestsRef } } };
    const head = f.pack("journal", bridge);
    assert.equal((await journal.verifyJournalChain(suppliedStore(f), ready.reference)).nodes.at(-1)!.record.formatVersion, 2);
    await assert.rejects(journal.verifyJournalChain(suppliedStore(f), head), invalid);
    assert.throws(() => reconstructControlCandidates({ head, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex }), invalid);
  }
});

test("C3 PURE AC10/36: terminal facts use the original receipt epoch/g, not E+1 or a re-signed receipt", () => {
  const f = controlVector(), current = currentClient(f), roster = { ...f.roster, rows: [current.row] };
  const facts = { ...f.facts, beforeCount: "1", beforeRowsDigest: f.rowsDigest([current.row]), clients: [current.fact], runtime: current.runtime };
  f.captured.frozen.sourceClientsDigest = digestJson(roster);
  const captured = { ...f.captured, sourceClients: roster, controlProof: { ...f.captured.controlProof, facts } }, origin = f.pack("journal", captured);
  const next = successorVector(f, { origin, previous: origin, sequence: 3, before: [current.row], after: [current.row], clients: [current.fact], changes: [] });
  const intent = { ...next, event: "cancel_intent", requestId: "cancel", controlProof: { ...next.controlProof, facts } }, intentRef = f.pack("journal", intent);
  const terminal = { ...intent, sequence: 4, event: "cancelled", previous: intentRef, fenceEpoch: 3,
    controlProof: { ...cancellation().terminal.controlProof, originCapture: origin, originSourceClientsDigest: digestJson(roster), previousAnchor: intentRef,
      beforeRowsDigest: f.rowsDigest([current.row]), afterRowsDigest: f.rowsDigest([current.row]), facts } };
  const head = f.pack("journal", terminal), result = reconstructControlCandidates({ head, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.ok(result.kind === "untrusted-control-reconstruction");
  assert.equal(result.cancellation, "terminal");
  assert.deepEqual(result.expectedRows, [current.row]);
  assert.equal(result.receiptGeneration, "7");
  const bad = { ...terminal, controlProof: { ...terminal.controlProof, receiptGeneration: "8" } }, badHead = f.pack("journal", bad);
  assert.throws(() => reconstructControlCandidates({ head: badHead, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex }), invalid);
});

test("C3 PURE AC25/26: every same-command prefix stays read only; a fresh exact resume is new", () => {
  const f = controlVector(), request = { plan: { migrationId: "a12", planDigest: f.planRef.sha256, immutablePlan: f.planRef, controlRoot: f.root.path },
    expectedSource: f.source, expectedPhase: null, expectedJournalDigest: null, requestId: "public-command" };
  const command = parse.parseMaintenanceCommand({ operation: "execute-migration", request }), requestDigest = parse.maintenanceRequestDigest(command);
  const enter = parse.parseJournal({ ...f.enter, requestId: request.requestId, requestDigest }), enterRef = f.pack("journal", enter);
  const capture = baseCapture(f), captured = parse.parseJournal({ ...capture.record, previous: enterRef, requestId: request.requestId, requestDigest });
  const captureRef = f.pack("journal", captured), prefix: journal.JournalNode[] = [{ record: enter, reference: enterRef }, { record: captured, reference: captureRef }];
  const takeover = parse.parseJournal({ ...successorVector(f, { origin: captureRef, previous: captureRef, sequence: 3,
    before: [], after: [], clients: [], changes: [], event: "takeover", fromGeneration: 7, toGeneration: 8 }), requestId: request.requestId, requestDigest });
  const takeoverRef = f.pack("journal", takeover); prefix.push({ record: takeover, reference: takeoverRef });
  const recapture = parse.parseJournal({ ...successorVector(f, { origin: captureRef, previous: takeoverRef, sequence: 4,
    before: [], after: [], clients: [], changes: [], fromGeneration: 8, toGeneration: 8 }), event: "capture", sourceClients: f.roster,
    frozen: f.captured.frozen, requestId: request.requestId, requestDigest });
  prefix.push({ record: recapture, reference: f.pack("journal", recapture) });
  for (let count = 1; count <= prefix.length; count++) {
    const nodes = prefix.slice(0, count), old = journal.classifyMaintenanceRequest(nodes, command);
    assert.equal(old.status, "paused");
    const head = nodes.at(-1)!;
    assert.equal(journal.classifyMaintenanceRequest(nodes, { operation: "resume-migration", request: { ...request,
      requestId: `new-${count}`, expectedPhase: head.record.phase, expectedJournalDigest: head.reference.sha256 } }).status, "new");
  }
  const ready = readyVector(f, prefix), record = parse.parseJournal({ ...ready.record, requestId: request.requestId, requestDigest });
  const reference = f.pack("journal", record);
  // Available but unanchored B/U/V/R/ready bytes do not affect the prefix selected by the caller's exact DB anchor.
  assert.equal(journal.classifyMaintenanceRequest(prefix, command).status, "paused");
  assert.equal(journal.classifyMaintenanceRequest([...prefix, { record, reference }], command).status, "ready");
  const conflict = (error: unknown) => error instanceof MaintenanceFailure && error.code === "request_conflict";
  assert.throws(() => journal.classifyMaintenanceRequest(prefix, { ...command, request: { ...request, expectedJournalDigest: captureRef.sha256, expectedPhase: "quiesced" } }), conflict);
});

test("C3 PURE AC25/33/37: pending permits cancel/resume only, exact terminal repeats are read only", () => {
  const c = cancellation(), f = c.f, request = { plan: { migrationId: "a12", planDigest: f.planRef.sha256, immutablePlan: f.planRef, controlRoot: f.root.path },
    expectedSource: f.source, expectedPhase: "quiesced", expectedJournalDigest: c.origin.sha256, requestId: "cancel" };
  const command = parse.parseMaintenanceCommand({ operation: "cancel-migration", request }), requestDigest = parse.maintenanceRequestDigest(command);
  const intent = parse.parseJournal({ ...c.intent, requestDigest }), intentRef = f.pack("journal", intent);
  const terminal = parse.parseJournal({ ...c.terminal, requestDigest, previous: intentRef,
    controlProof: { ...c.terminal.controlProof, previousAnchor: intentRef } }), terminalRef = f.pack("journal", terminal);
  const prefix = [{ record: parse.parseJournal(f.enter), reference: f.enterRef }, { record: parse.parseJournal(f.captured), reference: c.origin },
    { record: intent, reference: intentRef }];
  assert.equal(journal.classifyMaintenanceRequest(prefix, command).status, "cancel_pending");
  assert.equal(journal.classifyMaintenanceRequest([...prefix, { record: terminal, reference: terminalRef }], command).status, "cancelled");
  const fresh = { ...command.request, requestId: "fresh", expectedJournalDigest: intentRef.sha256 };
  assert.equal(journal.classifyMaintenanceRequest(prefix, { operation: "resume-migration", request: fresh }).status, "new");
  assert.equal(journal.classifyMaintenanceRequest(prefix, { operation: "cancel-migration", request: fresh }).status, "new");
  const conflict = (error: unknown) => error instanceof MaintenanceFailure && error.code === "request_conflict";
  assert.throws(() => journal.classifyMaintenanceRequest(prefix, { operation: "execute-migration", request: fresh }), conflict);
  for (const operation of ["execute-migration", "resume-migration", "cancel-migration"] as const)
    assert.throws(() => journal.classifyMaintenanceRequest([...prefix, { record: terminal, reference: terminalRef }], {
      operation, request: { ...fresh, expectedJournalDigest: terminalRef.sha256 } }), conflict);
  assert.throws(() => journal.classifyMaintenanceRequest(prefix.slice(0, 1), { operation: "cancel-migration",
    request: { ...fresh, expectedPhase: "planned", expectedJournalDigest: f.enterRef.sha256 } }), conflict);
});

test("C3 PURE AC36: cancellation-only takeover preserves rows then terminal closes the new generation", () => {
  const c = cancellation(), f = c.f;
  const takeover = successorVector(f, { origin: c.origin, previous: c.intentRef, sequence: 4, before: [], after: [], clients: [], changes: [],
    event: "takeover", fromGeneration: 7, toGeneration: 8 });
  const takeoverRef = f.pack("journal", takeover);
  const terminal = { ...c.terminal, sequence: 5, previous: takeoverRef, requestId: takeover.requestId, ownerGeneration: 8,
    controlProof: { ...c.terminal.controlProof, previousAnchor: takeoverRef, ownerGeneration: "8", targetSequence: "5" } };
  const head = f.pack("journal", terminal), result = reconstructControlCandidates({ head, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  assert.ok(result.kind === "untrusted-control-reconstruction");
  assert.equal(result.cancellation, "terminal");
  assert.equal(result.expectedMaintenance.ownerGeneration, "8");
  assert.equal(result.expectedMaintenance.fenceEpoch, "3");
  assert.equal(result.receiptGeneration, "7");
  assert.deepEqual(result.expectedRows, []);
});

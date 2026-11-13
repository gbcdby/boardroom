import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { assertFrozenSourceUnchanged, captureReference, restorePointDigest, verifyJournalChain, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import type { ArtifactRef, DatabaseManifests, JournalRecord, MigrationPlan, SourceFilesManifest, SourceObservation } from "../src/server/storage/maintenance/types.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const hash = (letter: string) => letter.repeat(64);
// These are deliberately structural fixtures. They do not assert that a synthetic V is a real restore.
// The independent native-adapter tests exercise actual backup output and restoration.
async function fixture() {
  // /tmp can be tmpfs: use the current worktree filesystem for the actual durability probe.
  const dir = await mkdtemp(path.join(process.cwd(), "maintenance-journal-test-"));
  const sourceIdentity = { kind: "sqlite", fixture: "structure-only" };
  const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: digestJson(sourceIdentity) };
  const store = await ArtifactStore.create(path.join(dir, "control"), source);
  const info = await stat(dir, { bigint: true });
  const planned = (file: string) => ({ path: file, existingAncestor: { path: dir, device: String(info.dev), inode: String(info.ino) }, absentSegments: [path.basename(file)] });
  const config = path.join(dir, "config.json"), schema = { format: "structural-test-catalog" };
  const roots = [{ label: "config" as const, path: config, expected: planned(config) }];
  const plan: MigrationPlan = { formatVersion: 1, kind: "plan", migrationId: "graph-test", source, sourceIdentity,
    originalCwd: dir, originalConfigPath: config, configDigest: hash("a"), effectiveConfigDigest: hash("b"),
    schemaManifestDigest: digestJson(schema), guardManifestDigest: hash("c"), controlRoot: planned(store.root), targetRoot: planned(path.join(dir, "target")),
    fileRoots: roots, preview: { observedAt: "2026-11-12T00:00:00.000Z", dataDigest: hash("d"), tableCounts: {}, clientInventory: [] }, requiredCapabilities: [], blockers: [] };
  const planRef = await store.putJson("plan", plan);
  const capability = await store.putJson("capability", await store.capability());
  const body: JournalRecord = { formatVersion: 1, kind: "journal", migrationId: plan.migrationId, sequence: 1, previous: null,
    phase: "planned", event: "enter", requestId: "enter", requestDigest: hash("e"), source, plan: planRef,
    fenceEpoch: 1, ownerGeneration: 1, evidence: [capability], frozen: null, snapshot: null };
  const enter = await store.putJson("journal", body);
  const payload = await store.putBytes("source-file-payload", Buffer.from("private config bytes"));
  const files: SourceFilesManifest = { formatVersion: 1, kind: "source-files", source, roots,
    entries: [{ sourceRoot: "config", sourceRelativePath: "", kind: "file", identity: { path: config, device: "1", inode: "7" }, mode: "600", size: payload.bytes, payload }],
    sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
  const filesRef = await store.putJson("source-files", files);
  const table = (name: string, rows: readonly unknown[]) => ({ name, columns: ["fixture"], ...digestRowMultiset(rows as never) });
  const domainTable = table("ordinary", [["text", "same"], ["text", "same"]]);
  const frozen = buildDatabaseManifests("sqlite", schema, [domainTable], { storage_maintenance: [], storage_source_clients: [] });
  const captured: JournalRecord = { ...body, sequence: 2, previous: enter, phase: "quiesced", event: "capture", requestId: "capture",
    frozen: { sourceFilesManifest: filesRef, schemaManifestDigest: frozen.schemaManifestDigest,
      frozenBusinessManifestDigest: frozen.frozenBusinessManifestDigest, guardManifestDigest: plan.guardManifestDigest } };
  const captureRef = await store.putJson("journal", captured);
  const capture = captureReference({ record: captured, reference: captureRef });
  const control = { database_instance_id: source.databaseInstanceId, admission: "sealed", fence_epoch: "1", owner_generation: "1",
    active_migration_id: plan.migrationId, plan_digest: planRef.sha256, journal_record_ref: captureRef.ref, journal_digest: captureRef.sha256,
    journal_sequence: "2", guard_manifest_digest: plan.guardManifestDigest, protocol_version: "1" };
  const manifests = buildDatabaseManifests("sqlite", schema, [domainTable, table("storage_maintenance", [control]), table("storage_source_clients", [])],
    { storage_maintenance: [control], storage_source_clients: [] });
  const manifestsRef = await store.putJson("database-manifests", manifests);
  const database = await store.putBytes("database-snapshot", Buffer.from("structure-only DB fixture; not a real backup"));
  const partial = { capture, sourceFilesManifest: filesRef, database, manifests: manifestsRef,
    schemaManifestDigest: manifests.schemaManifestDigest, frozenBusinessManifestDigest: manifests.frozenBusinessManifestDigest };
  const bundleBody = { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: filesRef, restorePointDigest: restorePointDigest(partial), entries: [
    { role: "plan", object: planRef }, { role: "journal-prefix", object: enter }, { role: "capture-journal", object: captureRef },
    { role: "source-files-manifest", object: filesRef }, { role: "source-file-payload", object: payload },
    { role: "database-snapshot", object: database }, { role: "database-expected-manifests", object: manifestsRef }, { role: "capability-evidence", object: capability },
  ] };
  async function finish(options: { omitPayload?: boolean; wrongVerificationBundle?: boolean; capability?: ArtifactRef } = {}) {
    const bundle = await store.putJson("restore-bundle", { ...bundleBody, entries: options.omitPayload ? bundleBody.entries.filter(item => item.role !== "source-file-payload") : bundleBody.entries });
    const publication = await store.putJson("publication", { formatVersion: 1, kind: "publication", bundle, capability: options.capability ?? capability,
      observedOperations: await Promise.all([...bundleBody.entries.map(item => item.object), bundle].map(ref => store.confirmDurable(ref))) });
    const verification = await store.putJson("verification", { formatVersion: 1, kind: "verification", bundle: options.wrongVerificationBundle ? planRef : bundle, publication,
      verificationTargetIdentity: { kind: "fixture-only" }, exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
    const receipt = await store.putJson("receipt", { formatVersion: 1, kind: "receipt", snapshotId: "fixture-snapshot", ...partial,
      restorePointDigest: bundleBody.restorePointDigest, bundle, publication, verification, capability: options.capability ?? capability,
      fullDataManifestDigest: manifests.fullDataManifestDigest, capturedControlManifestDigest: manifests.capturedControlManifestDigest });
    const ready: JournalRecord = { ...body, sequence: 3, previous: captureRef, phase: "snapshot_ready", event: "ready", requestId: "ready", snapshot: receipt };
    return { reference: await store.putJson("journal", ready), record: ready };
  }
  return { dir, store, source, plan, planRef, body, enter, captured, captureRef, capability, payload, manifests, control, finish,
    close: () => rm(dir, { recursive: true, force: true }) };
}

platformTest("#152 journal starts at the exact anchor and preserves the capture generation across legal takeover", async () => {
  const f = await fixture();
  try {
    const ready = await f.finish();
    const takeover: JournalRecord = { ...ready.record, sequence: 4, previous: ready.reference, event: "takeover", requestId: "takeover", ownerGeneration: 2, snapshot: null };
    const head = await f.store.putJson("journal", takeover);
    const verified = await verifySnapshotClosure(f.store, head);
    assert.equal(verified.receipt.capture.ownerGeneration, 1);
    assert.equal(verified.chain.nodes.at(-1)!.record.ownerGeneration, 2);
    assert.equal(verified.chain.nodes.length, 4);
    const bad = await f.store.putJson("journal", { ...takeover, ownerGeneration: 4 });
    await assert.rejects(verifyJournalChain(f.store, bad), /journal_invalid/);
    // A later-looking orphan does not alter which anchor is consumed.
    assert.equal((await verifyJournalChain(f.store, ready.reference)).nodes.length, 3);
    await assert.rejects(verifyJournalChain(f.store, { ...head, sha256: hash("f") }), /snapshot_invalid/);
  } finally { await f.close(); }
});

platformTest("#152 journal rejects skipped phases, request reuse with different input, unknown fields and broken predecessors", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { sequence: 3 }, { phase: "snapshot_ready", event: "ready", snapshot: f.planRef },
      { requestId: "enter", requestDigest: hash("f") }, { ownerGeneration: 2 }, { futureReceipt: f.planRef },
    ]) {
      const ref = await f.store.putJson("journal", { ...f.captured, ...change });
      await assert.rejects(verifyJournalChain(f.store, ref), /journal_invalid/);
    }
    await rm(f.store.pathFor(f.enter));
    await assert.rejects(verifyJournalChain(f.store, f.captureRef), /ENOENT/);
  } finally { await f.close(); }
});

platformTest("#152 finite recovery closure rejects missing roles, wrong verifier bundle and changed payload bytes", async () => {
  const f = await fixture();
  try {
    const valid = await f.finish();
    await verifySnapshotClosure(f.store, valid.reference);
    for (const options of [{ omitPayload: true }, { wrongVerificationBundle: true }])
      await assert.rejects(verifySnapshotClosure(f.store, (await f.finish(options)).reference), /journal_invalid/);
    await writeFile(f.store.pathFor(f.payload), "private config bytex");
    await assert.rejects(verifySnapshotClosure(f.store, valid.reference), /snapshot_invalid/);
  } finally { await f.close(); }
});

platformTest("#152 arbitrary capability bodies cannot introduce hidden recovery references", async () => {
  const f = await fixture();
  try {
    const capability = await f.store.putJson("capability", { ...await f.store.capability() as object, future: f.planRef });
    const head = await f.store.putJson("journal", { ...f.body, evidence: [capability] });
    await assert.rejects(verifyJournalChain(f.store, head), /journal_invalid/);
  } finally { await f.close(); }
});

platformTest("#152 journal rejects planned/no-Jq cancellation even when an unlinked capture exists", async () => {
  const f = await fixture();
  try {
    assert.equal((await verifyJournalChain(f.store, f.enter)).nodes.length, 1);
    const intent = { ...f.body, sequence: 2, previous: f.enter, event: "cancel_intent" as const, requestId: "cancel" };
    const intentRef = await f.store.putJson("journal", intent);
    const cancelled = { ...intent, sequence: 3, previous: intentRef, event: "cancelled" as const, fenceEpoch: 2 };
    const head = await f.store.putJson("journal", cancelled);
    // fixture() has persisted a capture, but this exact predecessor chain never includes it.
    await assert.rejects(verifyJournalChain(f.store, intentRef), /journal_invalid/);
    await assert.rejects(verifyJournalChain(f.store, head), /journal_invalid/);
  } finally { await f.close(); }
});

platformTest("#152 captured cancellation blocks capture/ready and is terminal with exactly one new epoch", async () => {
  const f = await fixture();
  try {
    const ready = await f.finish();
    for (const anchor of [{ reference: f.captureRef, record: f.captured }, ready]) {
      const intent: JournalRecord = { ...anchor.record, sequence: anchor.record.sequence + 1, previous: anchor.reference,
        event: "cancel_intent", requestId: "cancel", frozen: null, snapshot: null };
      const intentRef = await f.store.putJson("journal", intent);
      assert.equal((await verifyJournalChain(f.store, intentRef)).nodes.at(-1)!.record.phase, anchor.record.phase);
      const cancelled: JournalRecord = { ...intent, sequence: intent.sequence + 1, previous: intentRef,
        event: "cancelled", fenceEpoch: intent.fenceEpoch + 1 };
      const head = await f.store.putJson("journal", cancelled);
      const terminal = (await verifyJournalChain(f.store, head)).nodes.at(-1)!.record;
      assert.equal(terminal.phase, anchor.record.phase);
      assert.equal(terminal.fenceEpoch, anchor.record.fenceEpoch + 1);
      for (const record of [
        { ...intent, fenceEpoch: intent.fenceEpoch + 1 },
        { ...f.captured, sequence: intent.sequence + 1, previous: intentRef },
        { ...ready.record, sequence: intent.sequence + 1, previous: intentRef },
        { ...cancelled, sequence: intent.sequence, previous: anchor.reference },
        { ...cancelled, fenceEpoch: intent.fenceEpoch },
        { ...cancelled, fenceEpoch: intent.fenceEpoch + 2 },
        { ...cancelled, sequence: cancelled.sequence + 1, previous: head, event: "observation" },
      ]) await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", record)), /journal_invalid/);
    }
  } finally { await f.close(); }
});

platformTest("#152 ready reuse allows only journal-proven controller fields, never ignores the control tables", async () => {
  const f = await fixture();
  try {
    const ready = await f.finish(), checked = await verifySnapshotClosure(f.store, ready.reference);
    const liveRow = { ...f.control, journal_record_ref: ready.reference.ref, journal_digest: ready.reference.sha256, journal_sequence: "3" };
    const live = (control: Record<string, string>, clients: DatabaseManifests["controlRows"]["storage_source_clients"] = []) => ({ source: f.source,
      manifests: { ...f.manifests, controlRows: { storage_maintenance: [control], storage_source_clients: clients } } } satisfies Pick<SourceObservation, "source" | "manifests">);
    assertFrozenSourceUnchanged(live(liveRow), f.manifests, checked.chain);
    assert.throws(() => assertFrozenSourceUnchanged(live({ ...liveRow, guard_manifest_digest: hash("f") }), f.manifests, checked.chain), /journal_invalid/);
    assert.throws(() => assertFrozenSourceUnchanged(live({ ...liveRow, fence_epoch: "2" }), f.manifests, checked.chain), /journal_invalid/);
    assert.throws(() => assertFrozenSourceUnchanged(live(liveRow, [{ client_id: "unproved" }]), f.manifests, checked.chain), /journal_invalid/);
  } finally { await f.close(); }
});

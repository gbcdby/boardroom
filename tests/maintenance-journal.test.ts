import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../src/server/storage/maintenance/objects.ts";
import { canonicalJson, digestJson, sha256 } from "../src/server/storage/maintenance/canonical.ts";
import { MaintenanceFailure } from "../src/server/storage/maintenance/error.ts";
import { readSourceFiles } from "../src/server/storage/maintenance/parse.ts";
import { buildSourceClientsRoster, sourceClientsDigest } from "../src/server/storage/maintenance/source-clients.ts";
import { buildDatabaseManifests, digestRowMultiset } from "../src/server/storage/maintenance/manifests.ts";
import { assertFrozenSourceUnchanged, captureReference, restorePointDigest, verifyJournalChain, verifySnapshotClosure } from "../src/server/storage/maintenance/journal.ts";
import * as journal from "../src/server/storage/maintenance/journal.ts";
import type { ArtifactRef, DatabaseManifests, JournalRecordV2 as JournalRecord, MigrationPlan, RestoreBundleManifest, SourceFilesManifest, SourceObservation, SourceClientsRosterV1 } from "../src/server/storage/maintenance/types.ts";

const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const hash = (letter: string) => letter.repeat(64);
// These are deliberately structural fixtures. They do not assert that a synthetic V is a real restore.
// The independent native-adapter tests exercise actual backup output and restoration.
async function fixture(options: { sourceFiles?: (value: SourceFilesManifest) => unknown } = {}) {
  // /tmp can be tmpfs: use the current worktree filesystem for the actual durability probe.
  const dir = await mkdtemp(path.join(process.cwd(), "maintenance-journal-test-"));
  const sourceIdentity = { kind: "sqlite", fixture: "structure-only" };
  const source = { kind: "sqlite" as const, databaseInstanceId: "1".repeat(32), identityDigest: digestJson(sourceIdentity) };
  const store = await ArtifactStore.create(path.join(dir, "control"), source);
  const info = await stat(dir, { bigint: true });
  const planned = (file: string) => ({ path: file, existingAncestor: { path: dir, device: String(info.dev), inode: String(info.ino) }, absentSegments: [path.basename(file)] });
  const config = path.join(dir, "config.json"), schema = { format: "structural-test-catalog" };
  const configIdentity = { path: config, device: "1", inode: "7" };
  const roots = [{ label: "config" as const, path: config, expected: { path: config, existingAncestor: configIdentity, absentSegments: [] } }];
  const plan: MigrationPlan = { formatVersion: 1, kind: "plan", migrationId: "graph-test", source, sourceIdentity,
    originalCwd: dir, originalConfigPath: config, configDigest: hash("a"), effectiveConfigDigest: hash("b"),
    schemaManifestDigest: digestJson(schema), guardManifestDigest: hash("c"), controlRoot: planned(store.root), targetRoot: planned(path.join(dir, "target")),
    fileRoots: roots, preview: { observedAt: "2026-11-12T00:00:00.000Z", dataDigest: hash("d"), tableCounts: {}, clientInventory: [] }, requiredCapabilities: [], blockers: [] };
  const planRef = await store.putJson("plan", plan);
  const capability = await store.putJson("capability", await store.capability());
  const body: JournalRecord = { formatVersion: 2, kind: "journal", migrationId: plan.migrationId, sequence: 1, previous: null,
    phase: "planned", event: "enter", requestId: "enter", requestDigest: hash("e"), source, plan: planRef,
    fenceEpoch: 1, ownerGeneration: 1, evidence: [capability], frozen: null, snapshot: null, sourceClients: null };
  const enter = await store.putJson("journal", body);
  const payload = await store.putBytes("source-file-payload", Buffer.from("private config bytes"));
  // Fixed synthetic ext4-shaped bytes; no source is opened and no native/provider claim is made.
  const handle = { type: 1 as const, byteCount: 8 as const, hex: "0123456789abcdef" };
  const files: SourceFilesManifest = { formatVersion: 2, kind: "source-files", source, roots,
    rootBindings: [{ sourceRoot: "config", profile: "linux-native-ext4-fid-fsuuid-v1", filesystemType: "ext4",
      filesystemUuidHex: "4".repeat(32), hostIdentityDigest: store.identity.hostIdentityDigest,
      anchorPath: config, anchorKind: "file", anchorHandle: handle }],
    entries: [{ sourceRoot: "config", sourceRelativePath: "", kind: "file", identity: configIdentity, mode: "600", size: payload.bytes, payload,
      sourceWitness: { kind: "file", incarnation: handle, change: { mtimeNs: "1", ctimeNs: "2", observedBirthtimeNs: null } } }],
    sourceMembershipExclusions: ["database-files", "entire-maintenance-control-root", "all-maintenance-artifacts"] };
  const filesRef = await store.putJson("source-files", options.sourceFiles ? options.sourceFiles(files) : files);
  const table = (name: string, rows: readonly unknown[]) => ({ name, columns: ["fixture"], ...digestRowMultiset(rows as never) });
  const domainTable = table("ordinary", [["text", "same"], ["text", "same"]]);
  const frozen = buildDatabaseManifests("sqlite", schema, [domainTable], { storage_maintenance: [], storage_source_clients: [] });
  const sourceClients = buildSourceClientsRoster({ formatVersion: 1, kind: "source-clients-roster", source, migrationId: plan.migrationId,
    plan: planRef, fenceEpoch: "1", receiptGeneration: "1", textEncoding: { backend: "sqlite", name: "UTF-8" }, rows: [] });
  const captured: JournalRecord = { ...body, sequence: 2, previous: enter, phase: "quiesced", event: "capture", requestId: "capture",
    sourceClients,
    frozen: { sourceFilesManifest: filesRef, schemaManifestDigest: frozen.schemaManifestDigest,
      frozenBusinessManifestDigest: frozen.frozenBusinessManifestDigest, guardManifestDigest: plan.guardManifestDigest,
      sourceClientsDigest: sourceClientsDigest(sourceClients) } };
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
  const bundleBody: RestoreBundleManifest = { formatVersion: 1, kind: "restore-bundle", capture, sourceFilesManifest: filesRef, restorePointDigest: restorePointDigest(partial), entries: [
    { role: "plan", object: planRef }, { role: "journal-prefix", object: enter }, { role: "capture-journal", object: captureRef },
    { role: "source-files-manifest", object: filesRef }, { role: "source-file-payload", object: payload },
    { role: "database-snapshot", object: database }, { role: "database-expected-manifests", object: manifestsRef }, { role: "capability-evidence", object: capability },
  ] };
  async function publishBundle(options: { omitPayload?: boolean; capability?: ArtifactRef; body?: RestoreBundleManifest } = {}) {
    const bundle = await store.putJson("restore-bundle", options.body ?? { ...bundleBody,
      entries: options.omitPayload ? bundleBody.entries.filter(item => item.role !== "source-file-payload") : bundleBody.entries });
    const publication = await store.putJson("publication", { formatVersion: 1, kind: "publication", bundle, capability: options.capability ?? capability,
      observedOperations: await Promise.all([...(options.body ?? bundleBody).entries.map(item => item.object), bundle].map(ref => store.confirmDurable(ref))) });
    return { bundle, publication };
  }
  async function finish(options: { omitPayload?: boolean; wrongVerificationBundle?: boolean; capability?: ArtifactRef } = {}) {
    const { bundle, publication } = await publishBundle(options);
    const verification = await store.putJson("verification", { formatVersion: 1, kind: "verification", bundle: options.wrongVerificationBundle ? planRef : bundle, publication,
      verificationTargetIdentity: { kind: "fixture-only" }, exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
    const receipt = await store.putJson("receipt", { formatVersion: 1, kind: "receipt", snapshotId: "fixture-snapshot", ...partial,
      restorePointDigest: bundleBody.restorePointDigest, bundle, publication, verification, capability: options.capability ?? capability,
      fullDataManifestDigest: manifests.fullDataManifestDigest, capturedControlManifestDigest: manifests.capturedControlManifestDigest });
    const ready: JournalRecord = { ...body, sequence: 3, previous: captureRef, phase: "snapshot_ready", event: "ready", requestId: "ready", snapshot: receipt };
    return { reference: await store.putJson("journal", ready), record: ready };
  }
  return { dir, store, source, plan, planRef, body, enter, captured, captureRef, capability, files, filesRef, payload, manifests, control,
    database, manifestsRef, partial, bundleBody, publishBundle, finish,
    close: () => rm(dir, { recursive: true, force: true }) };
}

platformTest("#152 B/U closure: exact captured prefix is readable before V, R or ready exists", async () => {
  const f = await fixture();
  try {
    const refs = await f.publishBundle();
    const verified = await journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication);
    assert.deepEqual(Object.keys(verified).sort(), ["bundle", "capabilityRef", "chain", "databaseRef", "files", "manifests", "manifestsRef", "publication"]);
    assert.deepEqual(verified.bundle, f.bundleBody); assert.deepEqual(verified.publication.bundle, refs.bundle);
    assert.deepEqual(verified.chain.nodes.map(node => node.reference), [f.enter, f.captureRef]);
    assert.deepEqual(verified.files, f.files); assert.deepEqual(verified.manifests, f.manifests);
    assert.deepEqual(verified.databaseRef, f.database); assert.deepEqual(verified.manifestsRef, f.manifestsRef);
    assert.deepEqual(verified.capabilityRef, f.capability);
    const orphan = await f.store.putJson("journal", { ...f.body, sequence: 3, previous: f.captureRef,
      phase: "quiesced", event: "observation", requestId: "orphan" });
    assert.notDeepEqual(orphan, f.captureRef);
    assert.deepEqual((await journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication)).chain.nodes.at(-1)!.reference, f.captureRef);
  } finally { await f.close(); }
});

platformTest("#152 B/U closure: omitted, duplicate and role-confused members never form a finite bundle", async t => {
  const f = await fixture();
  try {
    for (const role of ["plan", "journal-prefix", "capture-journal", "source-files-manifest", "source-file-payload", "database-snapshot", "database-expected-manifests", "capability-evidence"]) {
      await t.test(`missing ${role}`, async () => {
        const refs = await f.publishBundle({ body: { ...f.bundleBody, entries: f.bundleBody.entries.filter(entry => entry.role !== role) } });
        await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /journal_invalid/);
      });
    }
    for (const entry of [f.bundleBody.entries.find(entry => entry.role === "database-snapshot")!,
      { role: "database-snapshot" as const, object: f.payload }, { role: "database-expected-manifests" as const, object: f.planRef }]) {
      const refs = await f.publishBundle({ body: { ...f.bundleBody, entries: [...f.bundleBody.entries, entry] } });
      await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /journal_invalid/);
    }
  } finally { await f.close(); }
});

platformTest("#152 B/U closure: capture point, captured controls and completed publication must agree", async () => {
  const f = await fixture();
  try {
    for (const body of [{ ...f.bundleBody, restorePointDigest: hash("f") },
      { ...f.bundleBody, capture: captureReference({ record: f.body, reference: f.enter }) }]) {
      const refs = await f.publishBundle({ body });
      await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /journal_invalid/);
    }
    const changed = buildDatabaseManifests("sqlite", f.manifests.schema, f.manifests.tables,
      { ...f.manifests.controlRows, storage_maintenance: [{ ...f.control, admission: "draining" }] });
    const changedRef = await f.store.putJson("database-manifests", changed);
    const refs = await f.publishBundle({ body: { ...f.bundleBody,
      restorePointDigest: restorePointDigest({ ...f.partial, manifests: changedRef }),
      entries: f.bundleBody.entries.map(entry => entry.role === "database-expected-manifests" ? { ...entry, object: changedRef } : entry) } });
    await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /journal_invalid/);
    const valid = await f.publishBundle(), publication = await f.store.readJson(valid.publication, "publication") as Record<string, unknown>;
    const operations = publication.observedOperations as { artifact: ArtifactRef; completed: string[] }[];
    for (const altered of [{ ...publication, bundle: f.planRef }, { ...publication, observedOperations: operations.slice(1) },
      { ...publication, observedOperations: [...operations, operations[0]!] },
      { ...publication, observedOperations: operations.map((entry, index) => index ? entry : { ...entry, completed: ["file_sync"] }) }]) {
      await assert.rejects(journal.verifyRestoreBundleClosure(f.store, valid.bundle, await f.store.putJson("publication", altered)), /journal_invalid/);
    }
  } finally { await f.close(); }
});

platformTest("#152 B/U closure: original payload bytes and the entire exact journal prefix remain required", async () => {
  const f = await fixture();
  try {
    const refs = await f.publishBundle(), original = await f.store.readBytes(f.database);
    await writeFile(f.store.pathFor(f.database), Buffer.alloc(original.length, 0x20));
    await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /snapshot_invalid/);
    await writeFile(f.store.pathFor(f.database), original); await rm(f.store.pathFor(f.enter));
    await assert.rejects(journal.verifyRestoreBundleClosure(f.store, refs.bundle, refs.publication), /ENOENT/);
  } finally { await f.close(); }
});

platformTest("#152 FSI-08: exact anchored Fs v1 is rejected by v2 capture and ready without rewriting bytes", async () => {
  const f = await fixture({ sourceFiles: value => {
    const { rootBindings: _bindings, ...legacy } = value;
    return { ...legacy, formatVersion: 1, entries: value.entries.map(({ sourceWitness: _witness, ...entry }) => entry) };
  } });
  try {
    const ready = await f.finish(), original = await f.store.readBytes(f.filesRef);
    const invalid = (error: unknown) => error instanceof MaintenanceFailure && error.code === "snapshot_invalid";
    await assert.rejects(verifyJournalChain(f.store, f.captureRef), invalid);
    await assert.rejects(verifySnapshotClosure(f.store, ready.reference), invalid);
    assert.deepEqual(await f.store.readBytes(f.filesRef), original);
  } finally { await f.close(); }
});

platformTest("#152 FSI-08: Fs-specific noncanonical and invalid bytes are snapshot_invalid in the existing closure reader", async () => {
  const f = await fixture();
  try {
    const canonical = Buffer.from(canonicalJson(f.files));
    for (const bytes of [Buffer.concat([canonical, Buffer.from("\n")]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
      Buffer.from(JSON.stringify(f.files)), Buffer.from("{"), Buffer.from([0xff])]) {
      // Deliberately corrupt fixtures with a correct content address; never rewrite an immutable artifact.
      const hash = sha256(bytes), ref = { ref: `snapshots/${hash}/source-files.json`, sha256: hash, bytes: String(bytes.length) };
      await mkdir(path.dirname(f.store.pathFor(ref)), { mode: 0o700 });
      await writeFile(f.store.pathFor(ref), bytes, { mode: 0o600, flag: "wx" });
      const anchor = await f.store.putJson("journal", { ...f.captured, frozen: { ...f.captured.frozen!, sourceFilesManifest: ref } });
      await assert.rejects(verifyJournalChain(f.store, anchor), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    }
  } finally { await f.close(); }
});

platformTest("#152 Fs reader retains actual control-root and missing-file errors while checking artifact kind/hash", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readSourceFiles(f.store, f.filesRef), f.files);
    await assert.rejects(readSourceFiles(f.store, f.planRef), error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    await assert.rejects(readSourceFiles(f.store, { ...f.filesRef, sha256: hash("f") }),
      error => error instanceof MaintenanceFailure && error.code === "snapshot_invalid");
    await chmod(f.store.root, 0o750);
    try {
      await assert.rejects(readSourceFiles(f.store, f.filesRef), error => error instanceof MaintenanceFailure && error.code === "control_root_mismatch");
    } finally { await chmod(f.store.root, 0o700); }
    await rm(f.store.pathFor(f.filesRef));
    await assert.rejects(readSourceFiles(f.store, f.filesRef), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally { await f.close(); }
});

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

platformTest("#152 SC-A07: v2 recapture preserves all five frozen fields and original roster across takeover", async (t) => {
  const f = await fixture();
  try {
    const takeover: JournalRecord = { ...f.captured, sequence: 3, previous: f.captureRef, event: "takeover",
      requestId: "takeover", ownerGeneration: 2, frozen: null, sourceClients: null };
    const takeoverRef = await f.store.putJson("journal", takeover);
    const recaptured: JournalRecord = { ...f.captured, sequence: 4, previous: takeoverRef,
      requestId: "recapture", ownerGeneration: 2 };
    await t.test("unchanged frozen values remain valid in the new generation", async () => {
      const chain = await verifyJournalChain(f.store, await f.store.putJson("journal", recaptured));
      const captures = chain.nodes.filter(node => node.record.event === "capture");
      assert.equal(chain.nodes.length, 4);
      assert.deepEqual(captures.map(node => node.record.ownerGeneration), [1, 2]);
      assert.deepEqual(captures.map(node => node.record.frozen), [f.captured.frozen, f.captured.frozen]);
      assert.ok(captures.every(node => node.record.formatVersion === 2));
      assert.deepEqual(captures.map(node => node.record.formatVersion === 2 ? node.record.sourceClients?.receiptGeneration : null), ["1", "1"]);
    });
    // A distinct, fully readable synthetic closure must not become a new frozen baseline.
    const payload = await f.store.putBytes("source-file-payload", Buffer.from("changed private config bytes"));
    const files: SourceFilesManifest = { ...f.files, entries: f.files.entries.map(entry => entry.kind === "file"
      ? { ...entry, size: payload.bytes, payload } : entry) };
    const filesRef = await f.store.putJson("source-files", files);
    const frozen = f.captured.frozen!;
    for (const change of [
      { field: "sourceFilesManifest", frozen: { ...frozen, sourceFilesManifest: filesRef }, validFirstCapture: true },
      { field: "schemaManifestDigest", frozen: { ...frozen, schemaManifestDigest: hash("f") }, validFirstCapture: false },
      { field: "frozenBusinessManifestDigest", frozen: { ...frozen, frozenBusinessManifestDigest: hash("f") }, validFirstCapture: true },
      { field: "guardManifestDigest", frozen: { ...frozen, guardManifestDigest: hash("f") }, validFirstCapture: false },
    ]) await t.test(`${change.field} drift is rejected`, async () => {
      if (change.validFirstCapture) {
        // These values are valid on their own; rejection must come from the earlier capture.
        const standalone = await f.store.putJson("journal", { ...f.captured, frozen: change.frozen });
        assert.equal((await verifyJournalChain(f.store, standalone)).nodes.length, 2);
      } else {
        // These two values are bound to the same plan before the frozen equality guard.
        await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...f.captured, frozen: change.frozen })), /journal_invalid/);
      }
      const head = await f.store.putJson("journal", { ...recaptured, frozen: change.frozen });
      await assert.rejects(verifyJournalChain(f.store, head),
        error => error instanceof MaintenanceFailure && error.code === "journal_invalid");
    });
    await t.test("complete roster and self-consistent fifth digest cannot replace the first capture", async () => {
      const vectors = JSON.parse(readFileSync(new URL("./fixtures/maintenance-source-clients-v1.json", import.meta.url), "utf8"));
      const sample = JSON.parse(vectors.rawByteVectors[0].canonicalEnvelope) as SourceClientsRosterV1;
      const sourceClients = buildSourceClientsRoster({ ...f.captured.sourceClients!, rows: sample.rows });
      const frozen = { ...f.captured.frozen!, sourceClientsDigest: sourceClientsDigest(sourceClients) };
      const firstRef = await f.store.putJson("journal", { ...f.captured, sourceClients, frozen });
      assert.equal((await verifyJournalChain(f.store, firstRef)).nodes.length, 2);
      await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...recaptured, sourceClients, frozen })), /journal_invalid/);
      const takeoverRef = await f.store.putJson("journal", { ...takeover, previous: firstRef });
      for (const changed of [
        { ...sourceClients, rows: sourceClients.rows.map(row => ({ ...row, host_identity_json: ["text", row.host_identity_json[1] + "0a"] as const })) },
        { ...sourceClients, textEncoding: { backend: "sqlite", name: "UTF-16le" } },
      ]) {
        const frozen = { ...f.captured.frozen!, sourceClientsDigest: digestJson(changed) };
        // Each self-consistent raw-byte/encoding variant is a valid standalone first capture.
        assert.equal((await verifyJournalChain(f.store, await f.store.putJson("journal", { ...f.captured, sourceClients: changed, frozen }))).nodes.length, 2);
        await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", {
          ...recaptured, previous: takeoverRef, sourceClients: changed, frozen,
        })), /journal_invalid/);
      }
    });
  } finally { await f.close(); }
});

platformTest("#152 SC-A06: self-consistent roster digests cannot cross source, plan, epoch or first generation", async t => {
  const f = await fixture();
  try {
    assert.equal((await verifyJournalChain(f.store, f.captureRef)).nodes.length, 2);
    const roster = f.captured.sourceClients!;
    const variants = [
      { name: "source backend", roster: { ...roster, source: { ...roster.source, kind: "postgres" }, textEncoding: { backend: "postgres", name: "UTF8" } } },
      { name: "database instance", roster: { ...roster, source: { ...roster.source, databaseInstanceId: "9".repeat(32) } } },
      { name: "source identity", roster: { ...roster, source: { ...roster.source, identityDigest: hash("f") } } },
      { name: "plan path", roster: { ...roster, plan: { ...roster.plan, ref: `plans/${hash("f")}.json` } } },
      { name: "plan digest", roster: { ...roster, plan: { ...roster.plan, sha256: hash("f") } } },
      { name: "plan byte count", roster: { ...roster, plan: { ...roster.plan, bytes: "1" } } },
      { name: "migration", roster: { ...roster, migrationId: "another-plan" } },
      { name: "fence epoch", roster: { ...roster, fenceEpoch: "2" } },
      { name: "first receipt generation", roster: { ...roster, receiptGeneration: "2" } },
      { name: "cross-backend encoding", roster: { ...roster, textEncoding: { backend: "postgres", name: "UTF8" } } },
      { name: "wrong encoding name", roster: { ...roster, textEncoding: { backend: "sqlite", name: "UTF8" } } },
    ];
    for (const variant of variants) await t.test(variant.name, async () => {
      const frozen = { ...f.captured.frozen!, sourceClientsDigest: digestJson(variant.roster) };
      const reference = await f.store.putJson("journal", { ...f.captured, sourceClients: variant.roster, frozen });
      await assert.rejects(verifyJournalChain(f.store, reference), error => error instanceof MaintenanceFailure && error.code === "journal_invalid");
    });
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", {
      ...f.captured, frozen: { ...f.captured.frozen!, sourceClientsDigest: hash("f") },
    })), /journal_invalid/);
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...f.body, sourceClients: roster })), /journal_invalid/);
    const takeover = { ...f.captured, sequence: 3, previous: f.captureRef, event: "takeover", ownerGeneration: 2, frozen: null, sourceClients: null };
    const previous = await f.store.putJson("journal", takeover);
    const changedGeneration = { ...roster, receiptGeneration: "2" };
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...f.captured, sequence: 4, previous,
      ownerGeneration: 2, sourceClients: changedGeneration, frozen: { ...f.captured.frozen!, sourceClientsDigest: digestJson(changedGeneration) } })), /journal_invalid/);
  } finally { await f.close(); }
});

platformTest("#152 SC-A08: only a valid v1 planned prefix can transition directly to the first v2 capture", async () => {
  const f = await fixture();
  try {
    const { sourceClients: _roster, ...body } = f.body;
    const legacyEnter = { ...body, formatVersion: 1 };
    const enter = await f.store.putJson("journal", legacyEnter);
    const takeover = { ...legacyEnter, sequence: 2, previous: enter, event: "takeover", ownerGeneration: 2, requestId: "legacy-takeover" };
    const takeoverRef = await f.store.putJson("journal", takeover);
    const observation = { ...takeover, sequence: 3, previous: takeoverRef, event: "observation", requestId: "legacy-observation" };
    const planned = await f.store.putJson("journal", observation);
    const oldBytes = await f.store.readBytes(planned);
    const prefix = await verifyJournalChain(f.store, planned);
    assert.equal(prefix.nodes.length, 3);
    assert.ok(prefix.nodes.every(node => node.record.formatVersion === 1 && node.record.phase === "planned" && node.record.frozen === null));
    const sourceClients = { ...f.captured.sourceClients!, receiptGeneration: "2" };
    const captured = { ...f.captured, sequence: 4, previous: planned, ownerGeneration: 2, sourceClients,
      frozen: { ...f.captured.frozen!, sourceClientsDigest: digestJson(sourceClients) } };
    const captureRef = await f.store.putJson("journal", captured);
    assert.deepEqual((await verifyJournalChain(f.store, captureRef)).nodes.map(node => node.record.formatVersion), [1, 1, 1, 2]);
    const v2Takeover = { ...captured, sequence: 5, previous: captureRef, event: "takeover", ownerGeneration: 3, frozen: null, sourceClients: null };
    const v2TakeoverRef = await f.store.putJson("journal", v2Takeover);
    assert.equal((await verifyJournalChain(f.store, await f.store.putJson("journal", {
      ...captured, sequence: 6, previous: v2TakeoverRef, ownerGeneration: 3,
    }))).nodes.length, 6);
    for (const event of ["takeover", "observation"]) {
      const bad = { ...f.body, sequence: 4, previous: planned, event, ownerGeneration: event === "takeover" ? 3 : 2 };
      await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", bad)), /journal_invalid/);
    }
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...captured, ownerGeneration: 3 })), /journal_invalid/);
    const backwards = { ...observation, sequence: 2, previous: f.enter, ownerGeneration: 1 };
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", backwards)), /journal_invalid/);
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", {
      ...observation, sequence: 5, previous: captureRef, phase: "quiesced",
    })), /journal_invalid/);
    for (const event of ["cancel_intent", "cancelled"]) await assert.rejects(verifyJournalChain(f.store,
      await f.store.putJson("journal", { ...observation, sequence: 4, previous: planned, event })), /journal_invalid/);
    assert.deepEqual(await f.store.readBytes(planned), oldBytes);
  } finally { await f.close(); }
});

platformTest("#152 SC-A08: legacy capture/ready cannot be accepted or laundered by a v2 recapture", async () => {
  const f = await fixture();
  try {
    const { sourceClients: _empty, ...body } = f.body;
    const enter = await f.store.putJson("journal", { ...body, formatVersion: 1 });
    const { sourceClients: _roster, ...captured } = f.captured;
    const { sourceClientsDigest: _digest, ...frozen } = f.captured.frozen!;
    const legacyCapture = { ...captured, formatVersion: 1, previous: enter, frozen };
    const reference = await f.store.putJson("journal", legacyCapture), original = await f.store.readBytes(reference);
    await assert.rejects(verifyJournalChain(f.store, reference), /journal_invalid/);
    const ready = await f.finish();
    const { sourceClients: _readyRoster, ...readyRecord } = ready.record;
    const legacyReady = await f.store.putJson("journal", { ...readyRecord, formatVersion: 1, previous: reference });
    await assert.rejects(verifyJournalChain(f.store, legacyReady), /journal_invalid/);
    await assert.rejects(verifySnapshotClosure(f.store, legacyReady), /journal_invalid/);
    const takeover = await f.store.putJson("journal", { ...legacyCapture, sequence: 3, previous: reference,
      event: "takeover", ownerGeneration: 2, frozen: null });
    await assert.rejects(verifyJournalChain(f.store, await f.store.putJson("journal", { ...f.captured,
      sequence: 4, previous: takeover, ownerGeneration: 2 })), /journal_invalid/);
    assert.deepEqual(await f.store.readBytes(reference), original);
  } finally { await f.close(); }
});

platformTest("#152 SC-A14: private v2 originals survive readback and failed publication without selecting an orphan", async () => {
  const f = await fixture();
  try {
    const reopened = await ArtifactStore.open(f.store.root, f.source);
    const original = await reopened.readBytes(f.captureRef), identity = await stat(reopened.pathFor(f.captureRef), { bigint: true });
    assert.equal(original.toString("utf8"), canonicalJson(f.captured));
    assert.deepEqual(await reopened.putJson("journal", f.captured), f.captureRef);
    assert.equal((await stat(reopened.pathFor(f.captureRef), { bigint: true })).ino, identity.ino);
    assert.equal(identity.mode & 0o777n, 0o600n);
    const orphan = { ...f.body, sequence: 3, previous: f.captureRef, phase: "quiesced", event: "observation", requestId: "orphan" };
    let faultReached = false;
    const failedStore = await ArtifactStore.open(f.store.root, f.source, { after(point) {
      if (point === "directory_synced") { faultReached = true; throw new MaintenanceFailure("journal_invalid"); }
    } });
    await assert.rejects(failedStore.putJson("journal", orphan), /journal_invalid/);
    assert.equal(faultReached, true);
    const bytes = Buffer.from(canonicalJson(orphan)), hash = sha256(bytes);
    const orphanRef = { ref: `journals/${f.body.migrationId}/3-${hash}.json`, sha256: hash, bytes: String(bytes.length) };
    assert.deepEqual(await reopened.readBytes(orphanRef), bytes);
    const checked = await verifyJournalChain(reopened, f.captureRef);
    assert.deepEqual(Object.keys(checked).sort(), ["nodes", "plan"]);
    assert.equal(checked.nodes.length, 2);
    assert.deepEqual(checked.nodes.at(-1)!.reference, f.captureRef);
    assert.deepEqual(await reopened.readBytes(f.captureRef), original);
  } finally { await f.close(); }
});

platformTest("#152 SC-A14: corrupt or noncanonical v2 bytes fail safely and preserve root/I/O errors", async () => {
  const f = await fixture();
  try {
    const original = await f.store.readBytes(f.captureRef);
    for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]), Buffer.concat([original, Buffer.from("\n")]),
      Buffer.from(JSON.stringify(f.captured)), Buffer.from("{"), Buffer.from([0xff])]) {
      const hash = sha256(bytes), reference = { ref: `journals/${f.body.migrationId}/2-${hash}.json`, sha256: hash, bytes: String(bytes.length) };
      await writeFile(f.store.pathFor(reference), bytes, { mode: 0o600, flag: "wx" });
      await assert.rejects(verifyJournalChain(f.store, reference), error => error instanceof MaintenanceFailure && error.code === "journal_invalid"
        && error.message === "storage_maintenance: journal_invalid (source)");
    }
    await chmod(f.store.root, 0o750);
    try { await assert.rejects(verifyJournalChain(f.store, f.captureRef), /control_root_mismatch/); }
    finally { await chmod(f.store.root, 0o700); }
    await writeFile(f.store.pathFor(f.captureRef), Buffer.alloc(original.length, 0x20));
    await assert.rejects(verifyJournalChain(f.store, f.captureRef), /snapshot_invalid/);
    await rm(f.store.pathFor(f.captureRef));
    await assert.rejects(verifyJournalChain(f.store, f.captureRef), /ENOENT/);
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
        event: "cancel_intent", requestId: "cancel", frozen: null, snapshot: null, sourceClients: null };
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

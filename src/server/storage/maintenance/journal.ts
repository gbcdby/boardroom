import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { buildDatabaseManifests } from "./manifests.ts";
import { ArtifactStore } from "./objects.ts";
import { parseBundle, parseCapability, parseJournal, parseManifests, parsePlan, parsePublication, parseReceipt, parseVerification, readSourceFiles } from "./parse.ts";
import type { ArtifactRef, DatabaseManifests, JournalRecord, MaintenanceCaptureRef, MigrationPlan, SnapshotReceipt, SourceFilesManifest, SourceObservation } from "./types.ts";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new MaintenanceFailure("journal_invalid"); }
export interface JournalNode { readonly reference: ArtifactRef; readonly record: JournalRecord }
export interface VerifiedJournalChain { readonly plan: MigrationPlan; readonly nodes: readonly JournalNode[] }
async function verifyCapability(store: ArtifactStore, reference: ArtifactRef): Promise<void> {
  const capability = parseCapability(await store.readJson(reference, "capability"));
  requireValue(equal(capability.rootIdentity, store.identity));
}

/** Starts at an exact DB-anchored ref supplied by the controller; never chooses a file by mtime. */
export async function verifyJournalChain(store: ArtifactStore, current: ArtifactRef): Promise<VerifiedJournalChain> {
  const reversed: JournalNode[] = [], seen = new Set<string>(); let reference: ArtifactRef | null = current;
  while (reference) {
    requireValue(!seen.has(reference.ref) && reversed.length < 4096); seen.add(reference.ref);
    const record = parseJournal(await store.readJson(reference, "journal"));
    requireValue(reference.ref === `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`);
    reversed.push({ reference, record }); reference = record.previous;
  }
  const nodes = reversed.reverse(); const first = nodes[0]!.record;
  const plan = parsePlan(await store.readJson(first.plan, "plan"));
  requireValue(first.event === "enter" && first.phase === "planned" && first.sequence === 1
    && first.migrationId === plan.migrationId && equal(first.source, plan.source)
    && digestJson(plan.sourceIdentity) === plan.source.identityDigest && plan.controlRoot.path === store.root);
  let cancelPending = false;
  let firstFrozen: JournalRecord["frozen"] = null;
  const requests = new Map<string, string>();
  for (let index = 0; index < nodes.length; index++) {
    const record = nodes[index]!.record, previous = nodes[index - 1]?.record;
    requireValue(record.sequence === index + 1 && record.migrationId === first.migrationId
      && equal(record.source, first.source) && equal(record.plan, first.plan));
    const digest = requests.get(record.requestId);
    requireValue(digest === undefined || digest === record.requestDigest); requests.set(record.requestId, record.requestDigest);
    if (previous) {
      requireValue(previous.event !== "cancelled" && record.event !== "enter"
        && record.ownerGeneration === previous.ownerGeneration + (record.event === "takeover" ? 1 : 0)
        && record.fenceEpoch === previous.fenceEpoch + (record.event === "cancelled" ? 1 : 0));
      if (["takeover", "observation", "cancel_intent", "cancelled"].includes(record.event)) requireValue(record.phase === previous.phase);
      if (record.event === "capture") requireValue(!cancelPending && ["planned", "quiesced"].includes(previous.phase) && record.phase === "quiesced");
      if (record.event === "ready") requireValue(!cancelPending && previous.phase === "quiesced" && record.phase === "snapshot_ready");
    }
    requireValue((record.event === "capture") === (record.frozen !== null));
    requireValue((record.event === "ready") === (record.snapshot !== null));
    if (record.event === "cancel_intent") {
      // The verified prefix must already contain capture/Jq; planned/no-Jq cancellation is forbidden.
      requireValue(record.phase !== "planned");
      cancelPending = true;
    }
    if (record.event === "cancelled") requireValue(cancelPending);
    const evidence = new Set(record.evidence.map(item => item.ref)); requireValue(evidence.size === record.evidence.length);
    for (const artifact of record.evidence) await verifyCapability(store, artifact);
    if (record.frozen) {
      const files = await readSourceFiles(store, record.frozen.sourceFilesManifest);
      requireValue(equal(files.source, record.source) && equal(files.roots, plan.fileRoots)
        && record.frozen.schemaManifestDigest === plan.schemaManifestDigest && record.frozen.guardManifestDigest === plan.guardManifestDigest);
      await verifySourceFilesClosure(store, files);
      // Takeover may advance the owner, but cannot replace the first capture's frozen facts.
      requireValue(firstFrozen === null || equal(firstFrozen, record.frozen));
      firstFrozen ??= record.frozen;
    }
  }
  return { plan, nodes };
}

export async function verifySourceFilesClosure(store: ArtifactStore, manifest: SourceFilesManifest): Promise<void> {
  const roots = new Map(manifest.roots.map(root => [root.label, root])); const seen = new Set<string>();
  requireValue(roots.size === manifest.roots.length);
  for (const root of roots.values()) requireValue(path.isAbsolute(root.path) && root.expected.path === root.path
    && root.path !== store.root && !root.path.startsWith(`${store.root}/`) && !store.root.startsWith(`${root.path}/`));
  for (const entry of manifest.entries) {
    const root = roots.get(entry.sourceRoot as "config" | "managed-sessions");
    requireValue(root && !path.isAbsolute(entry.sourceRelativePath) && (entry.sourceRelativePath === ""
      || entry.sourceRelativePath.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")));
    const key = `${entry.sourceRoot}/${entry.sourceRelativePath}`; requireValue(!seen.has(key)); seen.add(key);
    if (entry.kind === "absent") requireValue(entry.identity === null && entry.mode === null && entry.size === null && entry.payload === null && entry.sourceRelativePath === "");
    else requireValue(entry.identity !== null && entry.identity.path === path.join(root.path, entry.sourceRelativePath) && entry.mode !== null);
    if (entry.kind === "file") {
      requireValue(entry.payload !== null && entry.size === entry.payload.bytes && store.kindFor(entry.payload) === "source-file-payload"); await store.verifyFile(entry.payload);
    } else requireValue(entry.payload === null);
  }
  for (const root of roots.keys()) requireValue(seen.has(`${root}/`));
}

export function restorePointDigest(input: Pick<SnapshotReceipt, "capture" | "sourceFilesManifest" | "database" | "manifests" | "schemaManifestDigest" | "frozenBusinessManifestDigest">): string {
  return digestJson({ capture: input.capture, sourceFilesManifest: input.sourceFilesManifest, database: input.database,
    manifests: input.manifests, schemaManifestDigest: input.schemaManifestDigest, frozenBusinessManifestDigest: input.frozenBusinessManifestDigest });
}
export function captureReference(node: JournalNode): MaintenanceCaptureRef {
  return { migrationId: node.record.migrationId, source: node.record.source, planDigest: node.record.plan.sha256,
    fenceEpoch: node.record.fenceEpoch, journal: node.reference, journalSequence: node.record.sequence, ownerGeneration: node.record.ownerGeneration };
}

/** Verifies the finite byte/reference closure, not runtime qualification, source provenance or actual restore execution. */
export async function verifySnapshotClosure(store: ArtifactStore, current: ArtifactRef): Promise<{
  chain: VerifiedJournalChain; receipt: SnapshotReceipt; receiptRef: ArtifactRef; files: SourceFilesManifest; manifests: DatabaseManifests;
}> {
  const chain = await verifyJournalChain(store, current), last = chain.nodes.at(-1)!.record;
  requireValue(last.phase === "snapshot_ready" && !chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)));
  const ready = [...chain.nodes].reverse().find(node => node.record.event === "ready")!;
  requireValue(ready?.record.snapshot); const receiptRef = ready.record.snapshot;
  const receipt = parseReceipt(await store.readJson(receiptRef, "receipt"));
  const captureIndex = chain.nodes.findIndex(node => equal(node.reference, receipt.capture.journal));
  requireValue(captureIndex >= 0 && captureIndex < chain.nodes.indexOf(ready));
  const captured = chain.nodes[captureIndex]!;
  requireValue(captured.record.event === "capture" && captured.record.frozen && equal(captureReference(captured), receipt.capture));
  requireValue(chain.nodes.slice(captureIndex + 1).every(node => ["ready", "takeover", "observation"].includes(node.record.event)));
  const frozen = captured.record.frozen;
  requireValue(equal(frozen.sourceFilesManifest, receipt.sourceFilesManifest) && frozen.schemaManifestDigest === receipt.schemaManifestDigest
    && frozen.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest);
  const bundle = parseBundle(await store.readJson(receipt.bundle, "restore-bundle"));
  const publication = parsePublication(await store.readJson(receipt.publication, "publication"));
  const verification = parseVerification(await store.readJson(receipt.verification, "verification"));
  requireValue(equal(bundle.capture, receipt.capture) && equal(bundle.sourceFilesManifest, receipt.sourceFilesManifest)
    && equal(publication.bundle, receipt.bundle) && equal(publication.capability, receipt.capability)
    && equal(verification.bundle, receipt.bundle) && equal(verification.publication, receipt.publication)
    && bundle.restorePointDigest === receipt.restorePointDigest && receipt.restorePointDigest === restorePointDigest(receipt));
  const files = await readSourceFiles(store, receipt.sourceFilesManifest); await verifySourceFilesClosure(store, files);
  requireValue(equal(files.source, receipt.capture.source));
  await verifyCapability(store, receipt.capability);
  const manifests = parseManifests(await store.readJson(receipt.manifests, "database-manifests"));
  requireValue(equal(buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows), manifests)
    && manifests.schemaManifestDigest === receipt.schemaManifestDigest && manifests.fullDataManifestDigest === receipt.fullDataManifestDigest
    && manifests.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest && manifests.capturedControlManifestDigest === receipt.capturedControlManifestDigest);
  requireValue(manifests.dialect === receipt.capture.source.kind && manifests.controlRows.storage_maintenance.length === 1
    && new Set(manifests.tables.map(table => table.name)).size === manifests.tables.length
    && ["storage_maintenance", "storage_source_clients"].every(name => manifests.tables.some(table => table.name === name)));
  const control = manifests.controlRows.storage_maintenance[0]!;
  requireValue(control.database_instance_id === receipt.capture.source.databaseInstanceId && control.admission === "sealed"
    && String(control.fence_epoch) === String(receipt.capture.fenceEpoch) && String(control.owner_generation) === String(receipt.capture.ownerGeneration)
    && control.active_migration_id === receipt.capture.migrationId && control.plan_digest === receipt.capture.planDigest
    && control.guard_manifest_digest === frozen.guardManifestDigest && String(control.protocol_version) === "1"
    && control.journal_record_ref === receipt.capture.journal.ref && control.journal_digest === receipt.capture.journal.sha256
    && String(control.journal_sequence) === String(receipt.capture.journalSequence));
  const expected = new Map<string, { role: string; object: ArtifactRef }>();
  const add = (role: string, object: ArtifactRef) => {
    const prior = expected.get(object.ref); requireValue(!prior || prior.role === role && equal(prior.object, object)); expected.set(object.ref, { role, object });
  };
  add("plan", captured.record.plan);
  for (const node of chain.nodes.slice(0, captureIndex + 1)) { add(node === captured ? "capture-journal" : "journal-prefix", node.reference); for (const evidence of node.record.evidence) add("capability-evidence", evidence); }
  add("source-files-manifest", receipt.sourceFilesManifest);
  for (const entry of files.entries) if (entry.payload) add("source-file-payload", entry.payload);
  add("database-snapshot", receipt.database); add("database-expected-manifests", receipt.manifests); add("capability-evidence", receipt.capability);
  requireValue(bundle.entries.length === expected.size && new Set(bundle.entries.map(entry => entry.object.ref)).size === expected.size);
  const roleKinds: Record<string, string> = { plan: "plan", "journal-prefix": "journal", "capture-journal": "journal", "source-files-manifest": "source-files",
    "source-file-payload": "source-file-payload", "database-snapshot": "database-snapshot", "database-expected-manifests": "database-manifests", "capability-evidence": "capability" };
  for (const entry of bundle.entries) {
    requireValue(equal(expected.get(entry.object.ref), entry) && store.kindFor(entry.object) === roleKinds[entry.role]); await store.verifyFile(entry.object);
  }
  const published = new Map(publication.observedOperations.map(item => [item.artifact.ref, item.artifact]));
  requireValue(published.size === publication.observedOperations.length && published.size === expected.size + 1 && equal(published.get(receipt.bundle.ref), receipt.bundle));
  for (const entry of expected.values()) requireValue(equal(published.get(entry.object.ref), entry.object));
  return { chain, receipt, receiptRef, files, manifests };
}

/** A ready pointer/takeover changes controls, not frozen domain values. Never omit all controls. */
export function assertFrozenSourceUnchanged(current: Pick<SourceObservation, "source" | "manifests">, captured: DatabaseManifests, chain: VerifiedJournalChain): void {
  const head = chain.nodes.at(-1)!;
  const prior = captured.controlRows.storage_maintenance[0], live = current.manifests.controlRows.storage_maintenance[0];
  requireValue(head.record.phase === "snapshot_ready" && !chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event))
    && equal(current.source, head.record.source) && current.manifests.schemaManifestDigest === captured.schemaManifestDigest
    && current.manifests.frozenBusinessManifestDigest === captured.frozenBusinessManifestDigest && prior && live
    && current.manifests.controlRows.storage_maintenance.length === 1);
  const mutable = new Set(["owner_generation", "journal_record_ref", "journal_digest", "journal_sequence"]);
  requireValue(equal(Object.keys(prior).sort(), Object.keys(live).sort()));
  for (const key of Object.keys(prior)) if (!mutable.has(key)) requireValue(equal(prior[key], live[key]));
  requireValue(live.admission === "sealed" && String(live.owner_generation) === String(head.record.ownerGeneration)
    && live.journal_record_ref === head.reference.ref && live.journal_digest === head.reference.sha256
    && String(live.journal_sequence) === String(head.record.sequence));
  // This prefix's controllers have no source_clients registration. Thus no post-seal client edits
  // are legitimate here; later adapters must add a journal-proven field whitelist, never ignore rows.
  requireValue(equal(current.manifests.controlRows.storage_source_clients, captured.controlRows.storage_source_clients));
}

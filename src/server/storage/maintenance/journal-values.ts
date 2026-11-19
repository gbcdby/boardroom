import path from "node:path";
import { canonicalJson, digestJson, parseCanonical } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { applyControlNode, replayVerificationControls, validateJournalSequence, type ControlReplayState } from "./control-candidate/replay-core.ts";
import { bindSourceClientManifestRows, supportedEncoding } from "./control-candidate/rows.ts";
import { invariantFromManifests } from "./control-candidate/closure.ts";
import { buildDatabaseManifests } from "./manifests.ts";
import { parseSourceFilesBytes } from "./parse.ts";
import type { ActualRestoreVerification, ArtifactRef, ControlRootIdentity, DatabaseManifests, DurabilityCapability, JournalRecord, MaintenanceCaptureRef, MigrationPlan, ObjectKind, PublicationEvidence, RestoreBundleManifest, SnapshotReceipt, SourceFilesManifest, VerificationJournalRecord } from "./types.ts";
import { decodeJournalParsed } from './journal-codecs.ts';
import type { DecodedValues, JournalDecodedKind } from './journal-codecs.ts';
export { decodeJournalParsed } from './journal-codecs.ts';
export type { JournalDecodedKind } from './journal-codecs.ts';

export interface JournalNode<T extends VerificationJournalRecord = JournalRecord> { readonly reference: ArtifactRef; readonly record: T }
export interface VerifiedJournalChain<T extends VerificationJournalRecord = JournalRecord> { readonly plan: MigrationPlan; readonly nodes: readonly JournalNode<T>[] }
export type JournalValueOperation = { readonly operation: "decode"; readonly reference: ArtifactRef; readonly as: JournalDecodedKind }
  | { readonly operation: "kind"; readonly reference: ArtifactRef }
  | { readonly operation: "verify"; readonly reference: ArtifactRef };
export type JournalValueProgram<T> = Generator<JournalValueOperation, T, unknown>;
export interface RestoreBundleValueClosure { bundle: RestoreBundleManifest; publication: PublicationEvidence; chain: VerifiedJournalChain; files: SourceFilesManifest;
  manifests: DatabaseManifests; databaseRef: ArtifactRef; manifestsRef: ArtifactRef; capabilityRef: ArtifactRef }
export interface SnapshotValueClosure { chain: VerifiedJournalChain; receipt: SnapshotReceipt; receiptRef: ArtifactRef; files: SourceFilesManifest; manifests: DatabaseManifests }
/** Internal value computations only. The P0 caller supplies its own authenticated request meter;
 * these methods are never accepted from the wire and have no IO authority. */
export const JOURNAL_VALUE_MATH = Object.freeze({ equal: (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
  digestJson, buildDatabaseManifests, validateJournalSequence, applyControlNode, replayVerificationControls, bindSourceClientManifestRows,
  invariantFromManifests, restorePointDigest, json: (text: string): unknown => JSON.parse(text),
  canonicalText: (text: string): unknown => parseCanonical(Buffer.from(text, "utf8")),
  visit: (_value: unknown): void => {},
});
export interface JournalValueContext { readonly root: string; readonly identity: ControlRootIdentity; readonly math: typeof JOURNAL_VALUE_MATH }
function requireValue(condition: unknown): asserts condition { if (!condition) throw new MaintenanceFailure("journal_invalid"); }
function* decode<K extends JournalDecodedKind>(context: JournalValueContext, reference: ArtifactRef, as: K): JournalValueProgram<DecodedValues[K]> {
  const value = (yield { operation: "decode", reference, as }) as DecodedValues[K]; context.math.visit(value); return value;
}
function* kind(reference: ArtifactRef): JournalValueProgram<ObjectKind> { return (yield { operation: "kind", reference }) as ObjectKind; }
function* verify(reference: ArtifactRef): JournalValueProgram<void> { yield { operation: "verify", reference }; }
/** Same exact decoder and original-byte check as the old async reader. Inputs are supplied bytes. */
export function decodeJournalValue<K extends JournalDecodedKind>(kind: K, bytes: Uint8Array): DecodedValues[K] {
  if (kind === "source-files") return parseSourceFilesBytes(bytes) as DecodedValues[K];
  const value = parseCanonical(bytes);
  requireValue(Buffer.from(canonicalJson(value), "utf8").equals(bytes));
  return decodeJournalParsed(kind, value);
}

export function restorePointDigest(input: Pick<SnapshotReceipt, "capture" | "sourceFilesManifest" | "database" | "manifests" | "schemaManifestDigest" | "frozenBusinessManifestDigest">): string {
  return digestJson({ capture: input.capture, sourceFilesManifest: input.sourceFilesManifest, database: input.database,
    manifests: input.manifests, schemaManifestDigest: input.schemaManifestDigest, frozenBusinessManifestDigest: input.frozenBusinessManifestDigest });
}
export function captureReference(node: JournalNode<VerificationJournalRecord>): MaintenanceCaptureRef {
  return { migrationId: node.record.migrationId, source: node.record.source, planDigest: node.record.plan.sha256,
    fenceEpoch: node.record.fenceEpoch, journal: node.reference, journalSequence: node.record.sequence, ownerGeneration: node.record.ownerGeneration };
}

function* verifyCapability(context: JournalValueContext, reference: ArtifactRef): JournalValueProgram<void> {
  const capability = (yield* decode(context, reference, "capability"));
  requireValue(context.math.equal(capability.rootIdentity, context.identity));
}

export function* readJournalValues(context: JournalValueContext, current: ArtifactRef, verificationOnly = false): JournalValueProgram<VerifiedJournalChain> {
  const reversed: JournalNode[] = [], seen = new Set<string>(); let reference: ArtifactRef | null = current;
  while (reference) {
    requireValue(!seen.has(reference.ref) && reversed.length < 4096); seen.add(reference.ref);
    requireValue((yield* kind(reference)) === "journal");
    const record: JournalRecord = yield* decode(context, reference, "journal");
    requireValue(reference.ref === `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`);
    reversed.push({ reference, record }); reference = record.previous;
  }
  const nodes = reversed.reverse(); context.math.validateJournalSequence(nodes); const first = nodes[0]!.record;
  if (verificationOnly) requireValue(nodes.every(node => node.record.phase !== "snapshot_ready"
    && !["ready", "cancel_intent", "cancelled"].includes(node.record.event)
    && (node.record.formatVersion !== 3 || node.record.controlProof?.kind !== "legacy-first-capture-bridge")));
  const plan = (yield* decode(context, first.plan, "plan"));
  requireValue(first.event === "enter" && first.phase === "planned" && first.sequence === 1
    && first.migrationId === plan.migrationId && context.math.equal(first.source, plan.source)
    && context.math.digestJson(plan.sourceIdentity) === plan.source.identityDigest && plan.controlRoot.path === context.root);
  for (const { record } of nodes) {
    for (const artifact of record.evidence) yield* verifyCapability(context, artifact);
    if (record.frozen) {
      requireValue(record.formatVersion !== 1 && record.sourceClients !== null);
      const files = yield* decode(context, record.frozen.sourceFilesManifest, "source-files");
      requireValue(context.math.equal(files.source, record.source) && context.math.equal(files.roots, plan.fileRoots)
        && record.frozen.schemaManifestDigest === plan.schemaManifestDigest && record.frozen.guardManifestDigest === plan.guardManifestDigest);
      yield* verifySourceFilesValues(context, files);
    }
  }
  const chain = { plan, nodes };
  yield* verifyDefaultControlProofs(context, chain);
  return chain;
}

/** Full pure O→S→H proof replay. Mutex bytes here are historical data; actual consumers
 * must independently bind them, current raw rows and the runtime obligations to a real lock. */
function* verifyDefaultControlProofs(context: JournalValueContext, chain: VerifiedJournalChain): JournalValueProgram<void> {
  const { nodes, plan } = chain, origin = nodes.find(node => node.record.event === "capture");
  if (!origin || origin.record.formatVersion === 1 || origin.record.sourceClients === null) return;
  const roster = origin.record.sourceClients;
  const state: ControlReplayState = { rows: roster.rows, invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
  let lastReady: SnapshotValueClosure | undefined;
  let mutexIdentity: unknown;
  for (const [index, node] of nodes.entries()) {
    const record = node.record;
    if (record.formatVersion === 3 && record.controlProof !== null) {
      const proof = record.controlProof;
      if (proof.kind === "capture-controls") mutexIdentity = context.math.json(proof.maintenanceInvariant.mutexIdentityJson);
      if (proof.kind === "legacy-first-capture-bridge") {
        requireValue(origin.record.formatVersion === 2 && state.invariant === null && lastReady
          && context.math.equal(lastReady.receipt.capture.journal, origin.reference)
          && context.math.equal(proof.legacy.ready, nodes.slice(0, index).find(item => item.record.event === "ready")?.reference)
          && context.math.equal(proof.legacy.receipt, lastReady.receiptRef) && context.math.equal(proof.legacy.manifests, lastReady.receipt.manifests)
          && supportedEncoding(roster.textEncoding));
        const row = lastReady.manifests.controlRows.storage_maintenance[0];
        requireValue(row && typeof row.mutex_identity_json === "string");
        mutexIdentity = context.math.canonicalText(row.mutex_identity_json);
        state.invariant = context.math.invariantFromManifests(lastReady.manifests, origin, context.identity, mutexIdentity);
        context.math.bindSourceClientManifestRows(lastReady.manifests, roster.rows, roster.textEncoding);
      }
      context.math.applyControlNode(plan, node, nodes[index - 1], origin, roster, { controlRoot: context.identity, mutexIdentity }, state);
    }
    if (record.event === "ready") lastReady = yield* readSnapshotValues(context, { plan, nodes: nodes.slice(0, index + 1) });
  }
}

export function* verifySourceFilesValues(context: JournalValueContext, manifest: SourceFilesManifest): JournalValueProgram<void> {
  const roots = new Map(manifest.roots.map(root => [root.label, root])); const seen = new Set<string>();
  requireValue(roots.size === manifest.roots.length);
  for (const root of roots.values()) requireValue(path.isAbsolute(root.path) && root.expected.path === root.path
    && root.path !== context.root && !root.path.startsWith(`${context.root}/`) && !context.root.startsWith(`${root.path}/`));
  for (const entry of manifest.entries) {
    const root = roots.get(entry.sourceRoot as "config" | "managed-sessions");
    requireValue(root && !path.isAbsolute(entry.sourceRelativePath) && (entry.sourceRelativePath === ""
      || entry.sourceRelativePath.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")));
    const key = `${entry.sourceRoot}/${entry.sourceRelativePath}`; requireValue(!seen.has(key)); seen.add(key);
    if (entry.kind === "absent") requireValue(entry.identity === null && entry.mode === null && entry.size === null && entry.payload === null && entry.sourceRelativePath === "");
    else requireValue(entry.identity !== null && entry.identity.path === path.join(root.path, entry.sourceRelativePath) && entry.mode !== null);
    if (entry.kind === "file") {
      requireValue(entry.payload !== null && entry.size === entry.payload.bytes && (yield* kind(entry.payload)) === "source-file-payload"); yield* verify(entry.payload);
    } else requireValue(entry.payload === null);
  }
  for (const root of roots.keys()) requireValue(seen.has(`${root}/`));
}

export function* readRestoreBundleValues(context: JournalValueContext, bundleRef: ArtifactRef, publicationRef: ArtifactRef, verificationOnly = false): JournalValueProgram<RestoreBundleValueClosure> {
  const bundle = (yield* decode(context, bundleRef, "restore-bundle"));
  const publication = (yield* decode(context, publicationRef, "publication"));
  requireValue(context.math.equal(publication.bundle, bundleRef));
  const chain = yield* readJournalValues(context, bundle.capture.journal, verificationOnly), captured = chain.nodes.at(-1)!;
  requireValue(captured.record.event === "capture" && captured.record.frozen && context.math.equal(captureReference(captured), bundle.capture));
  const frozen = captured.record.frozen;
  requireValue(context.math.equal(frozen.sourceFilesManifest, bundle.sourceFilesManifest));
  const files = yield* decode(context, bundle.sourceFilesManifest, "source-files"); yield* verifySourceFilesValues(context, files);
  requireValue(context.math.equal(files.source, bundle.capture.source));
  const capabilityRef = publication.capability; yield* verifyCapability(context, capabilityRef);
  const databases = bundle.entries.filter(entry => entry.role === "database-snapshot");
  const expectedManifests = bundle.entries.filter(entry => entry.role === "database-expected-manifests");
  requireValue(databases.length === 1 && expectedManifests.length === 1);
  const databaseRef = databases[0]!.object, manifestsRef = expectedManifests[0]!.object;
  const manifests = (yield* decode(context, manifestsRef, "database-manifests"));
  requireValue(context.math.equal(context.math.buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows), manifests)
    && manifests.schemaManifestDigest === frozen.schemaManifestDigest && manifests.frozenBusinessManifestDigest === frozen.frozenBusinessManifestDigest);
  requireValue(bundle.restorePointDigest === context.math.restorePointDigest({ capture: bundle.capture, sourceFilesManifest: bundle.sourceFilesManifest,
    database: databaseRef, manifests: manifestsRef, schemaManifestDigest: manifests.schemaManifestDigest,
    frozenBusinessManifestDigest: manifests.frozenBusinessManifestDigest }));
  requireValue(manifests.dialect === bundle.capture.source.kind && manifests.controlRows.storage_maintenance.length === 1
    && new Set(manifests.tables.map(table => table.name)).size === manifests.tables.length
    && ["storage_maintenance", "storage_source_clients"].every(name => manifests.tables.some(table => table.name === name)));
  const control = manifests.controlRows.storage_maintenance[0]!;
  requireValue(control.database_instance_id === bundle.capture.source.databaseInstanceId && control.admission === "sealed"
    && String(control.fence_epoch) === String(bundle.capture.fenceEpoch) && String(control.owner_generation) === String(bundle.capture.ownerGeneration)
    && control.active_migration_id === bundle.capture.migrationId && control.plan_digest === bundle.capture.planDigest
    && control.guard_manifest_digest === frozen.guardManifestDigest && String(control.protocol_version) === "1"
    && control.journal_record_ref === bundle.capture.journal.ref && control.journal_digest === bundle.capture.journal.sha256
    && String(control.journal_sequence) === String(bundle.capture.journalSequence));
  if (captured.record.formatVersion === 3) {
    const origin = chain.nodes.find(node => node.record.event === "capture");
    requireValue(origin?.record.formatVersion === 3 && origin.record.controlProof?.kind === "capture-controls");
    const mutexIdentity = context.math.json(origin.record.controlProof.maintenanceInvariant.mutexIdentityJson);
    const replay = context.math.replayVerificationControls(chain.plan, chain.nodes, { controlRoot: context.identity, mutexIdentity });
    const selected = replay.captures.get(captured.reference.ref); requireValue(selected);
    context.math.bindSourceClientManifestRows(manifests, selected.rows, replay.originalRoster.textEncoding);
    requireValue(context.math.equal(context.math.invariantFromManifests(manifests, captured, context.identity, mutexIdentity), selected.invariant));
  }
  const expected = new Map<string, { role: string; object: ArtifactRef }>();
  const add = (role: string, object: ArtifactRef) => {
    const prior = expected.get(object.ref); requireValue(!prior || prior.role === role && context.math.equal(prior.object, object)); expected.set(object.ref, { role, object });
  };
  add("plan", captured.record.plan);
  for (const node of chain.nodes) { add(node === captured ? "capture-journal" : "journal-prefix", node.reference); for (const evidence of node.record.evidence) add("capability-evidence", evidence); }
  add("source-files-manifest", bundle.sourceFilesManifest);
  for (const entry of files.entries) if (entry.payload) add("source-file-payload", entry.payload);
  add("database-snapshot", databaseRef); add("database-expected-manifests", manifestsRef); add("capability-evidence", capabilityRef);
  requireValue(bundle.entries.length === expected.size && new Set(bundle.entries.map(entry => entry.object.ref)).size === expected.size);
  const roleKinds: Record<string, string> = { plan: "plan", "journal-prefix": "journal", "capture-journal": "journal", "source-files-manifest": "source-files",
    "source-file-payload": "source-file-payload", "database-snapshot": "database-snapshot", "database-expected-manifests": "database-manifests", "capability-evidence": "capability" };
  for (const entry of bundle.entries) {
    requireValue(context.math.equal(expected.get(entry.object.ref), entry) && (yield* kind(entry.object)) === roleKinds[entry.role]); yield* verify(entry.object);
  }
  const published = new Map(publication.observedOperations.map(item => [item.artifact.ref, item.artifact]));
  requireValue(published.size === publication.observedOperations.length && published.size === expected.size + 1 && context.math.equal(published.get(bundleRef.ref), bundleRef));
  for (const entry of expected.values()) requireValue(context.math.equal(published.get(entry.object.ref), entry.object));
  return { bundle, publication, chain, files, manifests, databaseRef, manifestsRef, capabilityRef };
}

export function* readSnapshotValues(context: JournalValueContext, chain: VerifiedJournalChain): JournalValueProgram<SnapshotValueClosure> {
  const last = chain.nodes.at(-1)!.record;
  requireValue(last.phase === "snapshot_ready" && !chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)));
  const ready = [...chain.nodes].reverse().find(node => node.record.event === "ready")!;
  requireValue(ready?.record.snapshot); const receiptRef = ready.record.snapshot;
  const receipt = (yield* decode(context, receiptRef, "receipt"));
  const captureIndex = chain.nodes.findIndex(node => context.math.equal(node.reference, receipt.capture.journal));
  requireValue(captureIndex >= 0 && captureIndex < chain.nodes.indexOf(ready));
  const captured = chain.nodes[captureIndex]!;
  requireValue(captured.record.event === "capture" && captured.record.frozen && context.math.equal(captureReference(captured), receipt.capture));
  requireValue(chain.nodes.slice(captureIndex + 1).every(node => ["ready", "takeover", "observation"].includes(node.record.event)));
  return yield* receiptClosure(context, receiptRef, receipt, chain);
}

/** P0 capture-root closure. It does not assert a later DB-ready anchor. */
export function* readReceiptValues(context: JournalValueContext, receiptRef: ArtifactRef): JournalValueProgram<SnapshotValueClosure> {
  const receipt = yield* decode(context, receiptRef, "receipt");
  return yield* receiptClosure(context, receiptRef, receipt);
}
function* receiptClosure(context: JournalValueContext, receiptRef: ArtifactRef, receipt: SnapshotReceipt, anchoredChain?: VerifiedJournalChain): JournalValueProgram<SnapshotValueClosure> {
  const { bundle, publication, files, manifests, databaseRef, manifestsRef, capabilityRef, chain } =
    yield* readRestoreBundleValues(context, receipt.bundle, receipt.publication);
  const verification = (yield* decode(context, receipt.verification, "verification"));
  requireValue(context.math.equal(bundle.capture, receipt.capture) && context.math.equal(bundle.sourceFilesManifest, receipt.sourceFilesManifest)
    && context.math.equal(publication.capability, receipt.capability) && context.math.equal(capabilityRef, receipt.capability)
    && context.math.equal(databaseRef, receipt.database) && context.math.equal(manifestsRef, receipt.manifests)
    && context.math.equal(verification.bundle, receipt.bundle) && context.math.equal(verification.publication, receipt.publication)
    && bundle.restorePointDigest === receipt.restorePointDigest && receipt.restorePointDigest === context.math.restorePointDigest(receipt)
    && manifests.schemaManifestDigest === receipt.schemaManifestDigest && manifests.fullDataManifestDigest === receipt.fullDataManifestDigest
    && manifests.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest && manifests.capturedControlManifestDigest === receipt.capturedControlManifestDigest);
  return { chain: anchoredChain ?? chain, receipt, receiptRef, files, manifests };
}

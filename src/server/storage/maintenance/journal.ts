import path from "node:path";
import { canonicalJson, digestJson, parseCanonical } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { applyControlNode, replayVerificationControls, validateJournalSequence, type ControlReplayState } from "./control-candidate/replay-core.ts";
import { bindSourceClientManifestRows, supportedEncoding } from "./control-candidate/rows.ts";
import { invariantFromManifests } from "./control-candidate/closure.ts";
import { buildDatabaseManifests } from "./manifests.ts";
import { ArtifactStore } from "./objects.ts";
import { maintenanceRequestDigest, parseBundle, parseCapability, parseJournal, parseMaintenanceCommand, parseManifests, parsePlan, parsePublication, parseReceipt, parseVerification, parseVerificationJournal, readSourceFiles } from "./parse.ts";
import type { ArtifactRef, DatabaseManifests, JournalRecord, MaintenanceCaptureRef, MaintenanceCommand, MigrationPlan, PublicationEvidence, RestoreBundleManifest, SnapshotReceipt, SourceFilesManifest, SourceObservation, VerificationJournalRecord } from "./types.ts";

const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new MaintenanceFailure("journal_invalid"); }
export interface JournalNode<T extends VerificationJournalRecord = JournalRecord> { readonly reference: ArtifactRef; readonly record: T }
export interface VerifiedJournalChain<T extends VerificationJournalRecord = JournalRecord> { readonly plan: MigrationPlan; readonly nodes: readonly JournalNode<T>[] }
async function verifyCapability(store: ArtifactStore, reference: ArtifactRef): Promise<void> {
  const capability = parseCapability(await store.readJson(reference, "capability"));
  requireValue(equal(capability.rootIdentity, store.identity));
}

/** Starts at an exact DB-anchored ref supplied by the controller; never chooses a file by mtime. */
export async function verifyJournalChain(store: ArtifactStore, current: ArtifactRef): Promise<VerifiedJournalChain> {
  return readJournalChain(store, current, parseJournal);
}
/** Explicit V-only envelope/closure read; control replay and native binding remain mandatory. */
export async function verifyVerificationJournalChain(store: ArtifactStore, current: ArtifactRef): Promise<VerifiedJournalChain<VerificationJournalRecord>> {
  return readJournalChain(store, current, parseVerificationJournal, true);
}
async function readJournalChain<T extends VerificationJournalRecord>(store: ArtifactStore, current: ArtifactRef,
  parseRecord: (value: unknown) => T, verificationOnly = false): Promise<VerifiedJournalChain<T>> {
  const reversed: JournalNode<T>[] = [], seen = new Set<string>(); let reference: ArtifactRef | null = current;
  while (reference) {
    requireValue(!seen.has(reference.ref) && reversed.length < 4096); seen.add(reference.ref);
    requireValue(store.kindFor(reference) === "journal");
    const bytes = await store.readBytes(reference), value = parseCanonical(bytes);
    // Check original bytes too: TextDecoder may otherwise discard a UTF-8 BOM.
    requireValue(Buffer.from(canonicalJson(value), "utf8").equals(bytes));
    const record = parseRecord(value);
    requireValue(reference.ref === `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`);
    reversed.push({ reference, record }); reference = record.previous;
  }
  const nodes = reversed.reverse(); validateJournalSequence(nodes); const first = nodes[0]!.record;
  if (verificationOnly) requireValue(nodes.every(node => node.record.phase !== "snapshot_ready"
    && !["ready", "cancel_intent", "cancelled"].includes(node.record.event)
    && (node.record.formatVersion !== 3 || node.record.controlProof?.kind !== "legacy-first-capture-bridge")));
  const plan = parsePlan(await store.readJson(first.plan, "plan"));
  requireValue(first.event === "enter" && first.phase === "planned" && first.sequence === 1
    && first.migrationId === plan.migrationId && equal(first.source, plan.source)
    && digestJson(plan.sourceIdentity) === plan.source.identityDigest && plan.controlRoot.path === store.root);
  for (const { record } of nodes) {
    for (const artifact of record.evidence) await verifyCapability(store, artifact);
    if (record.frozen) {
      requireValue(record.formatVersion !== 1 && record.sourceClients !== null);
      const files = await readSourceFiles(store, record.frozen.sourceFilesManifest);
      requireValue(equal(files.source, record.source) && equal(files.roots, plan.fileRoots)
        && record.frozen.schemaManifestDigest === plan.schemaManifestDigest && record.frozen.guardManifestDigest === plan.guardManifestDigest);
      await verifySourceFilesClosure(store, files);
    }
  }
  const chain = { plan, nodes };
  await verifyDefaultControlProofs(store, chain);
  return chain;
}

/** Full pure O→S→H proof replay. Mutex bytes here are historical data; actual consumers
 * must independently bind them, current raw rows and the runtime obligations to a real lock. */
async function verifyDefaultControlProofs(store: ArtifactStore, chain: VerifiedJournalChain): Promise<void> {
  const { nodes, plan } = chain, origin = nodes.find(node => node.record.event === "capture");
  if (!origin || origin.record.formatVersion === 1 || origin.record.sourceClients === null) return;
  const roster = origin.record.sourceClients;
  const state: ControlReplayState = { rows: roster.rows, invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
  let lastReady: Awaited<ReturnType<typeof readSnapshotClosure>> | undefined;
  let mutexIdentity: unknown;
  for (const [index, node] of nodes.entries()) {
    const record = node.record;
    if (record.formatVersion === 3 && record.controlProof !== null) {
      const proof = record.controlProof;
      if (proof.kind === "capture-controls") mutexIdentity = JSON.parse(proof.maintenanceInvariant.mutexIdentityJson);
      if (proof.kind === "legacy-first-capture-bridge") {
        requireValue(origin.record.formatVersion === 2 && state.invariant === null && lastReady
          && equal(lastReady.receipt.capture.journal, origin.reference)
          && equal(proof.legacy.ready, nodes.slice(0, index).find(item => item.record.event === "ready")?.reference)
          && equal(proof.legacy.receipt, lastReady.receiptRef) && equal(proof.legacy.manifests, lastReady.receipt.manifests)
          && supportedEncoding(roster.textEncoding));
        const row = lastReady.manifests.controlRows.storage_maintenance[0];
        requireValue(row && typeof row.mutex_identity_json === "string");
        mutexIdentity = parseCanonical(Buffer.from(row.mutex_identity_json, "utf8"));
        state.invariant = invariantFromManifests(lastReady.manifests, origin, store.identity, mutexIdentity);
        bindSourceClientManifestRows(lastReady.manifests, roster.rows, roster.textEncoding);
      }
      applyControlNode(plan, node, nodes[index - 1], origin, roster, { controlRoot: store.identity, mutexIdentity }, state);
    }
    if (record.event === "ready") lastReady = await readSnapshotClosure(store, { plan, nodes: nodes.slice(0, index + 1) });
  }
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
export function captureReference(node: JournalNode<VerificationJournalRecord>): MaintenanceCaptureRef {
  return { migrationId: node.record.migrationId, source: node.record.source, planDigest: node.record.plan.sha256,
    fenceEpoch: node.record.fenceEpoch, journal: node.reference, journalSequence: node.record.sequence, ownerGeneration: node.record.ownerGeneration };
}

/** Finite B/U byte/reference proof. No V, receipt, ready anchor or source qualification is implied. */
export async function verifyRestoreBundleClosure(store: ArtifactStore, bundleRef: ArtifactRef, publicationRef: ArtifactRef): Promise<{
  bundle: RestoreBundleManifest; publication: PublicationEvidence; chain: VerifiedJournalChain; files: SourceFilesManifest;
  manifests: DatabaseManifests; databaseRef: ArtifactRef; manifestsRef: ArtifactRef; capabilityRef: ArtifactRef;
}> {
  return readRestoreBundleClosure(store, bundleRef, publicationRef, verifyJournalChain);
}
export async function verifyVerificationRestoreBundleClosure(store: ArtifactStore, bundleRef: ArtifactRef, publicationRef: ArtifactRef) {
  return readRestoreBundleClosure(store, bundleRef, publicationRef, verifyVerificationJournalChain);
}
async function readRestoreBundleClosure<T extends VerificationJournalRecord>(store: ArtifactStore, bundleRef: ArtifactRef, publicationRef: ArtifactRef,
  readChain: (store: ArtifactStore, current: ArtifactRef) => Promise<VerifiedJournalChain<T>>) {
  const bundle = parseBundle(await store.readJson(bundleRef, "restore-bundle"));
  const publication = parsePublication(await store.readJson(publicationRef, "publication"));
  requireValue(equal(publication.bundle, bundleRef));
  const chain = await readChain(store, bundle.capture.journal), captured = chain.nodes.at(-1)!;
  requireValue(captured.record.event === "capture" && captured.record.frozen && equal(captureReference(captured), bundle.capture));
  const frozen = captured.record.frozen;
  requireValue(equal(frozen.sourceFilesManifest, bundle.sourceFilesManifest));
  const files = await readSourceFiles(store, bundle.sourceFilesManifest); await verifySourceFilesClosure(store, files);
  requireValue(equal(files.source, bundle.capture.source));
  const capabilityRef = publication.capability; await verifyCapability(store, capabilityRef);
  const databases = bundle.entries.filter(entry => entry.role === "database-snapshot");
  const expectedManifests = bundle.entries.filter(entry => entry.role === "database-expected-manifests");
  requireValue(databases.length === 1 && expectedManifests.length === 1);
  const databaseRef = databases[0]!.object, manifestsRef = expectedManifests[0]!.object;
  const manifests = parseManifests(await store.readJson(manifestsRef, "database-manifests"));
  requireValue(equal(buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows), manifests)
    && manifests.schemaManifestDigest === frozen.schemaManifestDigest && manifests.frozenBusinessManifestDigest === frozen.frozenBusinessManifestDigest);
  requireValue(bundle.restorePointDigest === restorePointDigest({ capture: bundle.capture, sourceFilesManifest: bundle.sourceFilesManifest,
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
    const mutexIdentity = JSON.parse(origin.record.controlProof.maintenanceInvariant.mutexIdentityJson);
    const replay = replayVerificationControls(chain.plan, chain.nodes, { controlRoot: store.identity, mutexIdentity });
    const selected = replay.captures.get(captured.reference.ref); requireValue(selected);
    bindSourceClientManifestRows(manifests, selected.rows, replay.originalRoster.textEncoding);
    requireValue(equal(invariantFromManifests(manifests, captured, store.identity, mutexIdentity), selected.invariant));
  }
  const expected = new Map<string, { role: string; object: ArtifactRef }>();
  const add = (role: string, object: ArtifactRef) => {
    const prior = expected.get(object.ref); requireValue(!prior || prior.role === role && equal(prior.object, object)); expected.set(object.ref, { role, object });
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
    requireValue(equal(expected.get(entry.object.ref), entry) && store.kindFor(entry.object) === roleKinds[entry.role]); await store.verifyFile(entry.object);
  }
  const published = new Map(publication.observedOperations.map(item => [item.artifact.ref, item.artifact]));
  requireValue(published.size === publication.observedOperations.length && published.size === expected.size + 1 && equal(published.get(bundleRef.ref), bundleRef));
  for (const entry of expected.values()) requireValue(equal(published.get(entry.object.ref), entry.object));
  return { bundle, publication, chain, files, manifests, databaseRef, manifestsRef, capabilityRef };
}

/** Verifies the finite byte/reference closure, not runtime qualification, source provenance or actual restore execution. */
export async function verifySnapshotClosure(store: ArtifactStore, current: ArtifactRef): Promise<{
  chain: VerifiedJournalChain; receipt: SnapshotReceipt; receiptRef: ArtifactRef; files: SourceFilesManifest; manifests: DatabaseManifests;
}> {
  return readSnapshotClosure(store, await verifyJournalChain(store, current));
}
async function readSnapshotClosure(store: ArtifactStore, chain: VerifiedJournalChain) {
  const last = chain.nodes.at(-1)!.record;
  requireValue(last.phase === "snapshot_ready" && !chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)));
  const ready = [...chain.nodes].reverse().find(node => node.record.event === "ready")!;
  requireValue(ready?.record.snapshot); const receiptRef = ready.record.snapshot;
  const receipt = parseReceipt(await store.readJson(receiptRef, "receipt"));
  const captureIndex = chain.nodes.findIndex(node => equal(node.reference, receipt.capture.journal));
  requireValue(captureIndex >= 0 && captureIndex < chain.nodes.indexOf(ready));
  const captured = chain.nodes[captureIndex]!;
  requireValue(captured.record.event === "capture" && captured.record.frozen && equal(captureReference(captured), receipt.capture));
  requireValue(chain.nodes.slice(captureIndex + 1).every(node => ["ready", "takeover", "observation"].includes(node.record.event)));
  const { bundle, publication, files, manifests, databaseRef, manifestsRef, capabilityRef } =
    await verifyRestoreBundleClosure(store, receipt.bundle, receipt.publication);
  const verification = parseVerification(await store.readJson(receipt.verification, "verification"));
  requireValue(equal(bundle.capture, receipt.capture) && equal(bundle.sourceFilesManifest, receipt.sourceFilesManifest)
    && equal(publication.capability, receipt.capability) && equal(capabilityRef, receipt.capability)
    && equal(databaseRef, receipt.database) && equal(manifestsRef, receipt.manifests)
    && equal(verification.bundle, receipt.bundle) && equal(verification.publication, receipt.publication)
    && bundle.restorePointDigest === receipt.restorePointDigest && receipt.restorePointDigest === restorePointDigest(receipt)
    && manifests.schemaManifestDigest === receipt.schemaManifestDigest && manifests.fullDataManifestDigest === receipt.fullDataManifestDigest
    && manifests.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest && manifests.capturedControlManifestDigest === receipt.capturedControlManifestDigest);
  return { chain, receipt, receiptRef, files, manifests };
}

export interface UntrustedRequestPrefix {
  readonly kind: "untrusted-request-prefix";
  readonly status: "new" | "paused" | "ready" | "cancel_pending" | "cancelled";
  readonly head: ArtifactRef | null;
  readonly firstSequence: number | null;
}
/** Exact anchored request classification only. The caller still owns actual DB head,
 * source, current native window and all cleanup checks; "ready" here is a historical prefix. */
export function classifyMaintenanceRequest(nodes: readonly JournalNode[], value: MaintenanceCommand): UntrustedRequestPrefix {
  const command = parseMaintenanceCommand(value), { request, operation } = command, digest = maintenanceRequestDigest(command);
  const conflict = (condition: unknown): void => { if (!condition) throw new MaintenanceFailure("request_conflict", "maintenance-command"); };
  if (nodes.length) validateJournalSequence(nodes);
  // Legacy bytes can still be inspected, but no new public command repairs a wrong pre-Jq generation.
  conflict(!nodes.some(node => node.record.phase === "planned" && node.record.event === "takeover"));
  const head = nodes.at(-1), matches = nodes.map((node, index) => ({ node, index })).filter(item => item.node.record.requestId === request.requestId);
  if (head) conflict(equal(head.record.source, request.expectedSource) && head.record.migrationId === request.plan.migrationId
    && equal(head.record.plan, request.plan.immutablePlan));
  const before = matches.length ? nodes[matches[0]!.index - 1] : head;
  conflict(request.expectedPhase === (before?.record.phase ?? null) && request.expectedJournalDigest === (before?.reference.sha256 ?? null));
  if (!matches.length) {
    conflict(head?.record.event !== "cancelled");
    if (operation === "execute-migration") conflict(!nodes.some(node => node.record.event === "cancel_intent"));
    if (operation === "cancel-migration") conflict(head && head.record.phase !== "planned");
    if (operation === "resume-migration") conflict(head !== undefined);
    return { kind: "untrusted-request-prefix", status: "new", head: head?.reference ?? null, firstSequence: null };
  }
  conflict(matches.every(item => item.node.record.requestDigest === digest)
    && matches[0]!.index + matches.length === nodes.length
    && matches.every((item, index) => item.index === matches[0]!.index + index));
  const cancellation = operation === "cancel-migration" || operation === "resume-migration"
    && nodes.slice(0, matches[0]!.index).some(item => item.record.event === "cancel_intent");
  const allowed = cancellation ? ["takeover", "observation", "cancel_intent", "cancelled"] : ["enter", "capture", "takeover", "observation", "ready"];
  conflict(matches.every(item => allowed.includes(item.node.record.event)));
  if (operation !== "execute-migration") conflict(matches.every(item => item.node.record.event !== "enter"));
  if (cancellation) conflict(before && before.record.phase !== "planned");
  const pending = nodes.some(node => node.record.event === "cancel_intent");
  const status = head!.record.event === "cancelled" ? "cancelled" : pending ? "cancel_pending"
    : head!.record.phase === "snapshot_ready" ? "ready" : "paused";
  return { kind: "untrusted-request-prefix", status, head: head!.reference, firstSequence: matches[0]!.node.record.sequence };
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

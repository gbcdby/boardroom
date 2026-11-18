import { canonicalJson, digestJson } from "../canonical.ts";
import { buildDatabaseManifests } from "../manifests.ts";
import { parseBundle, parseManifests, parsePublication, parseReceipt, parseVerification } from "../parse.ts";
import type { ArtifactRef, DatabaseManifests, MaintenanceCaptureRef, SnapshotReceipt, SourceClientRawRow, SourceClientsRosterV1 } from "../types.ts";
import { equal, requireCandidate } from "./common.ts";
import type { CandidateContents } from "./content.ts";
import type { CandidateNode } from "./replay.ts";
import { decodeRow, supportedEncoding } from "./rows.ts";
import { invariantSchema, type MaintenanceInvariant } from "./schema.ts";

export interface CaptureExpectation { readonly rows: readonly SourceClientRawRow[]; readonly encoding: SourceClientsRosterV1["textEncoding"]; readonly invariant: MaintenanceInvariant | null }
export interface SnapshotClosure {
  readonly ready: ArtifactRef;
  readonly capture: ArtifactRef;
  readonly receiptRef: ArtifactRef;
  readonly receipt: SnapshotReceipt;
  readonly manifestsRef: ArtifactRef;
  readonly invariant: MaintenanceInvariant;
  readonly rawEncodingUnverified: boolean;
}
function captureReference(node: CandidateNode): MaintenanceCaptureRef {
  return { migrationId: node.record.migrationId, source: node.record.source, planDigest: node.record.plan.sha256,
    fenceEpoch: node.record.fenceEpoch, journal: node.reference, journalSequence: node.record.sequence, ownerGeneration: node.record.ownerGeneration };
}
function numberCell(value: unknown): string {
  requireCandidate(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    || typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return String(value);
}
const columns = ["singleton", "database_instance_id", "control_root_json", "mutex_identity_json", "fence_epoch", "owner_generation", "admission",
  "active_migration_id", "plan_digest", "journal_record_ref", "journal_digest", "journal_sequence", "protocol_version", "guard_manifest_digest"].sort();
export function invariantFromManifests(manifests: DatabaseManifests, captured: CandidateNode, controlRoot: unknown, mutexIdentity: unknown): MaintenanceInvariant {
  requireCandidate(manifests.controlRows.storage_maintenance.length === 1 && captured.record.frozen !== null);
  const row = manifests.controlRows.storage_maintenance[0]!;
  requireCandidate(equal(Object.keys(row).sort(), columns) && row.database_instance_id === captured.record.source.databaseInstanceId
    && row.admission === "sealed" && numberCell(row.fence_epoch) === String(captured.record.fenceEpoch)
    && numberCell(row.owner_generation) === String(captured.record.ownerGeneration) && row.active_migration_id === captured.record.migrationId
    && row.plan_digest === captured.record.plan.sha256 && row.guard_manifest_digest === captured.record.frozen.guardManifestDigest
    && row.journal_record_ref === captured.reference.ref && row.journal_digest === captured.reference.sha256
    && numberCell(row.journal_sequence) === String(captured.record.sequence) && row.control_root_json === canonicalJson(controlRoot)
    && row.mutex_identity_json === canonicalJson(mutexIdentity));
  const parsed = invariantSchema.safeParse({ singleton: numberCell(row.singleton), databaseInstanceId: row.database_instance_id,
    controlRootJson: row.control_root_json, mutexIdentityJson: row.mutex_identity_json, fenceEpoch: numberCell(row.fence_epoch), admission: row.admission,
    activeMigrationId: row.active_migration_id, planDigest: row.plan_digest, protocolVersion: numberCell(row.protocol_version), guardManifestDigest: row.guard_manifest_digest });
  requireCandidate(parsed.success); return parsed.data;
}
/** A projection screen only; actual consumers also require the full typed/native binding. */
export function sourceRowsMatch(manifests: DatabaseManifests, expected: CaptureExpectation): boolean {
  const actual = manifests.controlRows.storage_source_clients;
  requireCandidate(actual.length === expected.rows.length);
  const keys = ["client_id", "database_instance_id", "entrypoint", "build_id", "host_identity_json", "process_identity_json", "db_sessions_json",
    "registered_at", "last_observed_at", "drain_state", "drain_receipt_digest", "ended_at", "protocol_version", "registered_epoch", "observed_epoch", "drain_epoch"].sort();
  requireCandidate(actual.every(row => equal(Object.keys(row).sort(), keys) && typeof row.client_id === "string")
    && new Set(actual.map(row => row.client_id)).size === actual.length);
  let decodedAll = supportedEncoding(expected.encoding);
  for (const raw of expected.rows) {
    const decoded = decodeRow(raw, expected.encoding);
    if (decoded === null) { decodedAll = false; continue; }
    const row = actual.find(item => item.client_id === decoded.client_id); requireCandidate(row);
    for (const key of keys as (keyof SourceClientRawRow)[]) {
      const cell = raw[key];
      requireCandidate(cell[0] === "integer" ? numberCell(row[key]) === cell[1] : row[key] === decoded[key]);
    }
  }
  return decodedAll;
}

/** Complete finite typed graph from supplied bytes. The V payload is never treated as an executed restore. */
export function snapshotClosure(contents: CandidateContents, nodes: readonly CandidateNode[], ready: CandidateNode,
  captures: ReadonlyMap<string, CaptureExpectation>, mutexIdentity: unknown): SnapshotClosure {
  requireCandidate(ready.record.event === "ready" && ready.record.snapshot !== null);
  const receiptRef = ready.record.snapshot, receipt = parseReceipt(contents.json(receiptRef, "receipt"));
  const capturedIndex = nodes.findIndex(node => equal(node.reference, receipt.capture.journal)), readyIndex = nodes.indexOf(ready);
  requireCandidate(capturedIndex >= 0 && capturedIndex < readyIndex);
  const captured = nodes[capturedIndex]!, frozen = captured.record.frozen, expected = captures.get(captured.reference.ref);
  requireCandidate(captured.record.event === "capture" && frozen !== null && expected && equal(captureReference(captured), receipt.capture)
    && nodes.slice(capturedIndex + 1, readyIndex + 1).every(node => ["observation", "takeover", "ready"].includes(node.record.event))
    && equal(frozen.sourceFilesManifest, receipt.sourceFilesManifest) && frozen.schemaManifestDigest === receipt.schemaManifestDigest
    && frozen.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest);
  const bundle = parseBundle(contents.json(receipt.bundle, "restore-bundle")), publication = parsePublication(contents.json(receipt.publication, "publication")),
    verification = parseVerification(contents.json(receipt.verification, "verification"));
  const pointDigest = digestJson({ capture: receipt.capture, sourceFilesManifest: receipt.sourceFilesManifest, database: receipt.database,
    manifests: receipt.manifests, schemaManifestDigest: receipt.schemaManifestDigest, frozenBusinessManifestDigest: receipt.frozenBusinessManifestDigest });
  requireCandidate(equal(bundle.capture, receipt.capture) && equal(bundle.sourceFilesManifest, receipt.sourceFilesManifest)
    && equal(publication.bundle, receipt.bundle) && equal(publication.capability, receipt.capability)
    && equal(verification.bundle, receipt.bundle) && equal(verification.publication, receipt.publication)
    && bundle.restorePointDigest === receipt.restorePointDigest && receipt.restorePointDigest === pointDigest);
  const files = contents.sourceFiles(receipt.sourceFilesManifest); requireCandidate(equal(files.source, receipt.capture.source));
  contents.capability(receipt.capability);
  const manifests = parseManifests(contents.json(receipt.manifests, "database-manifests"));
  requireCandidate(equal(buildDatabaseManifests(manifests.dialect, manifests.schema, manifests.tables, manifests.controlRows), manifests)
    && manifests.schemaManifestDigest === receipt.schemaManifestDigest && manifests.fullDataManifestDigest === receipt.fullDataManifestDigest
    && manifests.frozenBusinessManifestDigest === receipt.frozenBusinessManifestDigest && manifests.capturedControlManifestDigest === receipt.capturedControlManifestDigest
    && manifests.dialect === receipt.capture.source.kind && new Set(manifests.tables.map(table => table.name)).size === manifests.tables.length);
  for (const name of ["storage_maintenance", "storage_source_clients"] as const) requireCandidate(manifests.tables.find(table => table.name === name)?.count === String(manifests.controlRows[name].length));
  const invariant = invariantFromManifests(manifests, captured, contents.root, mutexIdentity);
  if (expected.invariant !== null) requireCandidate(equal(expected.invariant, invariant));
  const rawEncodingUnverified = !sourceRowsMatch(manifests, expected);
  const members = new Map<string, { role: string; object: ArtifactRef }>();
  const add = (role: string, object: ArtifactRef) => {
    const prior = members.get(object.ref); requireCandidate(!prior || prior.role === role && equal(prior.object, object)); members.set(object.ref, { role, object });
  };
  add("plan", captured.record.plan);
  for (const node of nodes.slice(0, capturedIndex + 1)) {
    add(node === captured ? "capture-journal" : "journal-prefix", node.reference);
    for (const evidence of node.record.evidence) add("capability-evidence", evidence);
  }
  add("source-files-manifest", receipt.sourceFilesManifest);
  for (const file of files.entries) if (file.payload !== null) add("source-file-payload", file.payload);
  add("database-snapshot", receipt.database); add("database-expected-manifests", receipt.manifests); add("capability-evidence", receipt.capability);
  requireCandidate(bundle.entries.length === members.size && new Set(bundle.entries.map(entry => entry.object.ref)).size === members.size);
  const roleKinds = { plan: "plan", "journal-prefix": "journal", "capture-journal": "journal", "source-files-manifest": "source-files", "source-file-payload": "source-file-payload",
    "database-snapshot": "database-snapshot", "database-expected-manifests": "database-manifests", "capability-evidence": "capability" } as const;
  for (const entry of bundle.entries) { requireCandidate(equal(members.get(entry.object.ref), entry)); contents.bytes(entry.object, roleKinds[entry.role]); }
  const published = new Map(publication.observedOperations.map(item => [item.artifact.ref, item.artifact]));
  requireCandidate(published.size === publication.observedOperations.length && published.size === members.size + 1 && equal(published.get(receipt.bundle.ref), receipt.bundle));
  for (const entry of members.values()) requireCandidate(equal(published.get(entry.object.ref), entry.object));
  return { ready: ready.reference, capture: captured.reference, receiptRef, receipt, manifestsRef: receipt.manifests, invariant, rawEncodingUnverified };
}

import { canonicalJson, parseCanonical } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { validateJournalSequence } from "./control-candidate/replay-core.ts";
import { ArtifactStore } from "./objects.ts";
import { maintenanceRequestDigest, parseBundle, parseCapability, parseJournal, parseMaintenanceCommand, parseManifests, parsePlan, parsePublication, parseReceipt, parseVerification, readSourceFiles } from "./parse.ts";
import type { ArtifactRef, DatabaseManifests, MaintenanceCommand, SourceFilesManifest, SourceObservation, VerificationJournalRecord } from "./types.ts";
import { JOURNAL_VALUE_MATH, readJournalValues, readRestoreBundleValues, readSnapshotValues, verifySourceFilesValues } from "./journal-values.ts";
import type { JournalValueProgram } from "./journal-values.ts";
import type { JournalNode, VerifiedJournalChain } from "./journal-values.ts";
export type { JournalNode, VerifiedJournalChain } from "./journal-values.ts";
export { captureReference, restorePointDigest } from "./journal-values.ts";
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new MaintenanceFailure("journal_invalid"); }
const context = (store: ArtifactStore) => ({ root: store.root, identity: store.identity, math: JOURNAL_VALUE_MATH });
async function runJournalValues<T>(store: ArtifactStore, program: JournalValueProgram<T>): Promise<T> {
  let step = program.next();
  while (!step.done) {
    const op = step.value;
    let result: unknown;
    if (op.operation === "kind") result = store.kindFor(op.reference);
    else if (op.operation === "verify") result = await store.verifyFile(op.reference);
    else if (op.as === "source-files") result = await readSourceFiles(store, op.reference);
    else if (op.as === "journal") {
      const bytes = await store.readBytes(op.reference), value = parseCanonical(bytes);
      requireValue(Buffer.from(canonicalJson(value), "utf8").equals(bytes));
      result = parseJournal(value);
    } else {
      const parsers = { plan: parsePlan, capability: parseCapability, "restore-bundle": parseBundle, publication: parsePublication,
        verification: parseVerification, receipt: parseReceipt, "database-manifests": parseManifests };
      result = parsers[op.as](await store.readJson(op.reference, op.as));
    }
    step = program.next(result);
  }
  return step.value;
}
/** Exact DB-anchored prefix; preserves default control replay and all native-store checks. */
export async function verifyJournalChain(store: ArtifactStore, current: ArtifactRef): Promise<VerifiedJournalChain> {
  return runJournalValues(store, readJournalValues(context(store), current));
}
export async function verifyVerificationJournalChain(store: ArtifactStore, current: ArtifactRef): Promise<VerifiedJournalChain<VerificationJournalRecord>> {
  return runJournalValues(store, readJournalValues(context(store), current, true));
}
export async function verifySourceFilesClosure(store: ArtifactStore, manifest: SourceFilesManifest): Promise<void> {
  return runJournalValues(store, verifySourceFilesValues(context(store), manifest));
}
export async function verifyRestoreBundleClosure(store: ArtifactStore, bundleRef: ArtifactRef, publicationRef: ArtifactRef) {
  return runJournalValues(store, readRestoreBundleValues(context(store), bundleRef, publicationRef));
}
export async function verifyVerificationRestoreBundleClosure(store: ArtifactStore, bundleRef: ArtifactRef, publicationRef: ArtifactRef) {
  return runJournalValues(store, readRestoreBundleValues(context(store), bundleRef, publicationRef, true));
}
/** Ready-anchor, cancellation and intervening-event checks remain in the shared ready branch. */
export async function verifySnapshotClosure(store: ArtifactStore, current: ArtifactRef) {
  return runJournalValues(store, readSnapshotValues(context(store), await verifyJournalChain(store, current)));
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

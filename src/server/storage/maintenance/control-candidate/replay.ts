import { digestJson } from "../canonical.ts";
import { parseJournal, parsePlan } from "../parse.ts";
import type { ArtifactRef, JournalFrozenV2, MigrationPlan, SourceClientRawRow, SourceClientsRosterV1 } from "../types.ts";
import { parseControlJournalCandidate } from "./codec.ts";
import { equal, requireCandidate } from "./common.ts";
import { CandidateContents, parseReconstructionInput } from "./content.ts";
import type { ControlProof, MaintenanceInvariant } from "./schema.ts";
import { applyControlNode, validateJournalSequence, type CancellationState, type ControlReplayNode, type ControlReplayState } from "./replay-core.ts";
import { supportedEncoding } from "./rows.ts";
import { snapshotClosure, type CaptureExpectation, type SnapshotClosure } from "./closure.ts";

export type CandidateNode = ControlReplayNode;
export { rowsDigest } from "./replay-core.ts";
interface ExpectedAnchor {
  readonly ownerGeneration: string;
  readonly journalRecordRef: string;
  readonly journalDigest: string;
  readonly journalSequence: string;
}
export type ExpectedMaintenance = ExpectedAnchor & (MaintenanceInvariant | (
  Omit<MaintenanceInvariant, "admission" | "activeMigrationId" | "planDigest"> & {
    readonly admission: "open"; readonly activeMigrationId: null; readonly planDigest: null;
  }
));
const obligations = ["actual-db-exact-anchor-and-source-lock", "actual-source-root-mutex-and-descriptor-bindings", "full-current-source-and-control-rows", "current-native-process-session-runtime-audit",
  "private-controller-factory", "fresh-window-and-all-resource-close", "source-files-and-frozen-domain"] as const;
export type RuntimeObligation = typeof obligations[number] | "actual-first-capture-restore-and-raw-rows" | "actual-capture-restore-and-raw-rows" | "raw-identity-profile-encoding";
export interface ReconstructedControls {
  readonly kind: "untrusted-control-reconstruction";
  readonly originCapture: ArtifactRef;
  readonly receiptGeneration: string;
  readonly originalRoster: SourceClientsRosterV1;
  readonly expectedRows: readonly SourceClientRawRow[];
  readonly expectedMaintenance: ExpectedMaintenance;
  readonly sealedInvariant: MaintenanceInvariant;
  readonly cancellation: CancellationState;
  readonly events: readonly { readonly journal: ArtifactRef; readonly proof: ControlProof }[];
  readonly runtimeObligations: readonly RuntimeObligation[];
}
export interface UnavailableControls {
  readonly kind: "baseline-unavailable";
  readonly reason: "first-capture-unavailable" | "legacy-baseline-unavailable";
  readonly originCapture: ArtifactRef | null;
  readonly runtimeObligations: readonly RuntimeObligation[];
  readonly cancellation: CancellationState;
}
function maintenance(invariant: MaintenanceInvariant, node: CandidateNode): ExpectedMaintenance {
  const anchor = { ownerGeneration: String(node.record.ownerGeneration), journalRecordRef: node.reference.ref,
    journalDigest: node.reference.sha256, journalSequence: String(node.record.sequence) };
  return node.record.event === "cancelled"
    ? { ...invariant, ...anchor, admission: "open", fenceEpoch: String(node.record.fenceEpoch), activeMigrationId: null, planDigest: null }
    : { ...invariant, ...anchor };
}
function readNodes(contents: CandidateContents, head: ArtifactRef): CandidateNode[] {
  const reversed: CandidateNode[] = [], seen = new Set<string>(); let reference: ArtifactRef | null = head;
  while (reference !== null) {
    requireCandidate(!seen.has(reference.ref) && reversed.length < 4096); seen.add(reference.ref);
    const value = contents.json(reference, "journal");
    requireCandidate(value !== null && typeof value === "object" && !Array.isArray(value));
    const record = (value as { formatVersion?: unknown }).formatVersion === 3 ? parseControlJournalCandidate(value) : parseJournal(value);
    requireCandidate(reference.ref === `journals/${record.migrationId}/${record.sequence}-${reference.sha256}.json`);
    reversed.push({ reference, record }); reference = record.previous;
  }
  return reversed.reverse();
}

/** Pure finite-content replay. A supplied head and historical facts remain untrusted at every return. */
export function reconstructControlCandidates(value: unknown): ReconstructedControls | UnavailableControls {
  const input = parseReconstructionInput(value), contents = new CandidateContents(input), nodes = readNodes(contents, input.head);
  const cancellation = validateJournalSequence(nodes);
  const first = nodes[0]!.record, plan: MigrationPlan = parsePlan(contents.json(first.plan, "plan"));
  requireCandidate(first.event === "enter" && first.phase === "planned" && first.sequence === 1
    && first.migrationId === plan.migrationId && equal(first.source, plan.source) && digestJson(plan.sourceIdentity) === plan.source.identityDigest
    && plan.controlRoot.path === input.controlRoot.path);
  let origin: CandidateNode | null = null, frozen: JournalFrozenV2 | null = null, roster: SourceClientsRosterV1 | null = null;
  const state: ControlReplayState = { rows: [], invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
  const events: { journal: ArtifactRef; proof: ControlProof }[] = [];
  const captures = new Map<string, CaptureExpectation>();
  let lastReady: SnapshotClosure | null = null, legacyBridge = false;
  for (const [index, node] of nodes.entries()) {
    const record = node.record, previous = nodes[index - 1];
    for (const evidence of record.evidence) contents.capability(evidence);
    const firstCapture = record.event === "capture" && origin === null;
    if (record.event === "capture") {
      requireCandidate(record.formatVersion !== 1 && record.sourceClients !== null && record.frozen !== null);
      const original = record.sourceClients;
      requireCandidate(equal(original.source, record.source) && equal(original.plan, record.plan) && original.migrationId === record.migrationId
        && original.fenceEpoch === String(record.fenceEpoch) && digestJson(original) === record.frozen.sourceClientsDigest);
      requireCandidate(roster === null ? original.receiptGeneration === String(record.ownerGeneration) : equal(roster, original));
      requireCandidate(frozen === null || equal(frozen, record.frozen));
      const files = contents.sourceFiles(record.frozen.sourceFilesManifest);
      requireCandidate(equal(files.source, record.source) && equal(files.roots, plan.fileRoots)
        && record.frozen.schemaManifestDigest === plan.schemaManifestDigest && record.frozen.guardManifestDigest === plan.guardManifestDigest);
      if (firstCapture) { origin = node; roster = original; frozen = record.frozen; state.rows = original.rows; }
    }
    if (record.formatVersion === 3 && origin !== null) {
      requireCandidate(record.controlProof !== null && roster !== null);
      const proof = record.controlProof;
      if (proof.kind === "legacy-first-capture-bridge") {
        requireCandidate(previous && previous.record.formatVersion === 2 && state.invariant === null && origin.record.formatVersion === 2 && lastReady !== null
          && equal(lastReady.capture, origin.reference) && equal(proof.legacy.ready, lastReady.ready)
          && equal(proof.legacy.receipt, lastReady.receiptRef) && equal(proof.legacy.manifests, lastReady.manifestsRef)
          && supportedEncoding(roster.textEncoding));
        state.invariant = lastReady.invariant; legacyBridge = true;
      }
      applyControlNode(plan, node, previous, origin, roster, { controlRoot: input.controlRoot, mutexIdentity: input.mutexIdentity }, state);
      events.push({ journal: node.reference, proof });
    }
    if (record.event === "capture") {
      requireCandidate(roster !== null);
      captures.set(node.reference.ref, { rows: state.rows, encoding: roster.textEncoding, invariant: state.invariant });
    }
    if (record.event === "ready") {
      lastReady = snapshotClosure(contents, nodes, node, captures, input.mutexIdentity);
      if (lastReady.rawEncodingUnverified) state.unresolvedEncoding.add("legacy-raw");
    }
  }
  if (origin === null || roster === null) return { kind: "baseline-unavailable", reason: "first-capture-unavailable", originCapture: null, cancellation, runtimeObligations: obligations };
  if (state.invariant === null) return { kind: "baseline-unavailable", reason: "legacy-baseline-unavailable", originCapture: origin.reference, cancellation, runtimeObligations: obligations };
  return { kind: "untrusted-control-reconstruction", originCapture: origin.reference, receiptGeneration: roster.receiptGeneration, originalRoster: roster,
    expectedRows: state.rows, expectedMaintenance: maintenance(state.invariant, nodes.at(-1)!), sealedInvariant: state.invariant, cancellation, events,
    runtimeObligations: [...obligations, ...(lastReady ? [legacyBridge ? "actual-first-capture-restore-and-raw-rows" as const : "actual-capture-restore-and-raw-rows" as const] : []),
      ...(state.unresolvedEncoding.size > 0 ? ["raw-identity-profile-encoding" as const] : [])] };
}

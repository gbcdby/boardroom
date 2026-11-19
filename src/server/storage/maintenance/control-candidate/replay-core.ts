import { canonicalJson, digestJson } from "../canonical.ts";
import type { ArtifactRef, JournalFrozenV2, MigrationPlan, SourceClientRawRow, SourceClientsRosterV1, SourceRef, VerificationJournalRecord } from "../types.ts";
import { equal, requireCandidate, sameJoinedText } from "./common.ts";
import { applyChanges, validateRowsFacts, type RowContext } from "./rows.ts";
import type { CancelTerminalProof, ControlProof, MaintenanceInvariant, SuccessorProof } from "./schema.ts";
import { assertP0FSyntaxScope, reserveP0FNativeNodes,reserveP0FNativeMetadata,encodeP0FNativeShell,reserveP0FNativeComparisons,reserveP0FNativeText, type P0FArtifactSyntaxFrame } from '../../../identity/internal/m2-p0-artifacts-frame.ts';

const legacyEnterEvents=Object.freeze(["enter", "takeover", "observation"]);
const samePhaseEvents=Object.freeze(["takeover", "observation", "cancel_intent", "cancelled"]);
const capturePreviousPhases=Object.freeze(["planned", "quiesced"]);
const pendingEvents=Object.freeze(["takeover", "observation", "cancelled"]);
const capturePrefixEvents=Object.freeze(["enter", "observation"]);
const verificationEvents=Object.freeze(["capture", "observation", "takeover"]);

export interface ControlReplayNode { readonly reference: ArtifactRef; readonly record: VerificationJournalRecord }
export interface ControlReplayState {
  rows: readonly SourceClientRawRow[];
  invariant: MaintenanceInvariant | null;
  readonly registrations: RowContext["registrations"];
  readonly unresolvedEncoding: Set<string>;
}
export interface ControlReplayBindings { readonly controlRoot: unknown; readonly mutexIdentity: unknown }
export type CancellationState = "active" | "pending" | "terminal";

/** One finite version/event/frozen protocol shared by default and untrusted readers.
 * Records must have passed the shared strict codec. No native authority is established. */
export function validateJournalSequence(nodes: readonly ControlReplayNode[]): CancellationState {
  requireCandidate(nodes.length > 0 && nodes.length <= 4096);
  const first = nodes[0]!.record;
  requireCandidate(first.event === "enter" && first.phase === "planned" && first.previous === null && first.sequence === 1);
  let origin: ControlReplayNode | null = null, frozen: JournalFrozenV2 | null = null, roster: SourceClientsRosterV1 | null = null;
  let cancellation: CancellationState = "active";
  const requests = new Map<string, string>(), completedRequests = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const record = node.record, previous = nodes[index - 1];
    requireCandidate(record.sequence === index + 1 && sameJoinedText(record.migrationId,first.migrationId)
      && equal(record.source, first.source) && equal(record.plan, first.plan));
    reserveP0FNativeText(record.requestId);const oldDigest = requests.get(record.requestId);
    requireCandidate(oldDigest === undefined || sameJoinedText(oldDigest,record.requestDigest));
    reserveP0FNativeText(record.requestId);requests.set(record.requestId, record.requestDigest);
    if (previous && !sameJoinedText(previous.record.requestId,record.requestId)) {reserveP0FNativeText(previous.record.requestId);completedRequests.add(previous.record.requestId);}
    // Legacy bytes retain their old structural read rules. New v3 commands never reopen a prior request.
    if (record.formatVersion === 3) {reserveP0FNativeText(record.requestId);requireCandidate(!completedRequests.has(record.requestId));}
    if (record.formatVersion === 1) requireCandidate((!previous || previous.record.formatVersion === 1)
      && record.phase === "planned" && legacyEnterEvents.includes(record.event)
      && record.frozen === null && record.snapshot === null);
    if (previous) {
      requireCandidate(cancellation !== "terminal" && equal(record.previous, previous.reference) && record.event !== "enter"
        && record.ownerGeneration === previous.record.ownerGeneration + (record.event === "takeover" ? 1 : 0)
        && record.fenceEpoch === previous.record.fenceEpoch + (record.event === "cancelled" ? 1 : 0));
      if (previous.record.formatVersion === 3) requireCandidate(record.formatVersion === 3);
      if (previous.record.formatVersion === 1 && record.formatVersion !== 1) requireCandidate(record.event === "capture" && origin === null);
      if (previous.record.formatVersion === 2 && record.formatVersion === 3) requireCandidate(origin === null
        ? record.event === "capture" : record.controlProof?.kind === "legacy-first-capture-bridge");
      if (samePhaseEvents.includes(record.event)) requireCandidate(record.phase === previous.record.phase);
      if (record.event === "capture") requireCandidate(cancellation === "active" && record.phase === "quiesced"
        && capturePreviousPhases.includes(previous.record.phase));
      if (record.event === "ready") requireCandidate(cancellation === "active" && previous.record.phase === "quiesced" && record.phase === "snapshot_ready");
    }
    if (cancellation === "pending") requireCandidate(pendingEvents.includes(record.event));
    if (record.event === "cancel_intent") {
      requireCandidate(origin !== null && record.phase !== "planned" && cancellation === "active"); cancellation = "pending";
    }
    if (record.event === "cancelled") { requireCandidate(cancellation === "pending"); cancellation = "terminal"; }
    requireCandidate((record.event === "capture") === (record.frozen !== null) && (record.event === "ready") === (record.snapshot !== null));
    reserveP0FNativeNodes(1 + record.evidence.length, record.evidence.length);
    reserveP0FNativeMetadata(2); // label list + uniqueness Set shells; 2E slots/bindings prepaid by sequenceCost and the preceding fee
    requireCandidate(new Set(record.evidence.map(item => {reserveP0FNativeText(item.ref);return item.ref;})).size === record.evidence.length);
    if (record.formatVersion === 3) {
      if (record.event === "capture") requireCandidate(record.controlProof?.kind === (origin === null ? "capture-controls" : "control-successor"));
      if (record.controlProof?.kind === "capture-controls") {
        reserveP0FNativeNodes(1, index);reserveP0FNativeMetadata(1);
        requireCandidate(record.event === "capture" && origin === null
          && nodes.slice(0, index).every(item => capturePrefixEvents.includes(item.record.event)));
      }
      if (record.controlProof?.kind === "legacy-first-capture-bridge") requireCandidate(previous?.record.formatVersion === 2
        && previous.record.phase === "snapshot_ready" && origin?.record.formatVersion === 2 && cancellation === "active");
    }
    if (record.event === "capture") {
      requireCandidate(record.formatVersion !== 1 && record.sourceClients !== null && record.frozen !== null);
      const original = record.sourceClients;
      requireCandidate(equal(original.source, record.source) && equal(original.plan, record.plan)
        && original.migrationId === record.migrationId && original.fenceEpoch === String(record.fenceEpoch)
        && original.textEncoding.backend === record.source.kind && sameJoinedText(digestJson(original),record.frozen.sourceClientsDigest));
      requireCandidate(roster === null ? original.receiptGeneration === String(record.ownerGeneration) : equal(roster, original));
      requireCandidate(frozen === null || equal(frozen, record.frozen));
      if (origin === null) { origin = node; frozen = record.frozen; roster = original; }
    }
  }
  return cancellation;
}
export function rowsDigest(source: SourceRef, textEncoding: SourceClientsRosterV1["textEncoding"], rows: readonly SourceClientRawRow[]): string {
  reserveP0FNativeNodes(9, rows.length);
  reserveP0FNativeMetadata(1); // sorted reference-list shell
  const sorted = [...rows].sort((a, b) => {reserveP0FNativeComparisons(a.client_id[1],b.client_id[1],2);return a.client_id[1] < b.client_id[1] ? -1 : a.client_id[1] > b.client_id[1] ? 1 : 0;});
  requireCandidate(sorted.every((row, index) => {if(index===0)return true;reserveP0FNativeComparisons(sorted[index-1]!.client_id[1],row.client_id[1]);return sorted[index-1]!.client_id[1]!==row.client_id[1];}));
  encodeP0FNativeShell(sorted);
  return digestJson(encodeP0FNativeShell({ formatVersion: 1, kind: "source-clients-live-rows", source, textEncoding, rows: sorted }));
}
function successorBinding(proof: SuccessorProof, node: ControlReplayNode, previous: ControlReplayNode,
  origin: ControlReplayNode, roster: SourceClientsRosterV1): void {
  requireCandidate(equal(proof.originCapture, origin.reference) && proof.originSourceClientsDigest === digestJson(roster)
    && equal(proof.source, node.record.source) && equal(proof.plan, node.record.plan) && proof.migrationId === node.record.migrationId
    && proof.fenceEpoch === String(node.record.fenceEpoch) && proof.receiptGeneration === roster.receiptGeneration && equal(proof.textEncoding, roster.textEncoding)
    && equal(proof.previousAnchor, previous.reference) && proof.fromGeneration === String(previous.record.ownerGeneration)
    && proof.toGeneration === String(node.record.ownerGeneration) && proof.targetSequence === String(node.record.sequence));
}
function terminalBinding(proof: CancelTerminalProof, node: ControlReplayNode, previous: ControlReplayNode,
  origin: ControlReplayNode, roster: SourceClientsRosterV1): void {
  requireCandidate(node.record.event === "cancelled" && equal(proof.originCapture, origin.reference)
    && proof.originSourceClientsDigest === digestJson(roster) && equal(proof.source, node.record.source)
    && equal(proof.plan, node.record.plan) && proof.migrationId === node.record.migrationId
    && proof.epochBefore === roster.fenceEpoch && proof.epochBefore === String(previous.record.fenceEpoch)
    && proof.epochAfter === String(node.record.fenceEpoch) && BigInt(proof.epochAfter) === BigInt(proof.epochBefore) + 1n
    && proof.receiptGeneration === roster.receiptGeneration && equal(proof.textEncoding, roster.textEncoding)
    && equal(proof.previousAnchor, previous.reference) && proof.ownerGeneration === String(previous.record.ownerGeneration)
    && proof.ownerGeneration === String(node.record.ownerGeneration) && proof.targetSequence === String(node.record.sequence)
    && proof.changes.length === 0 && proof.beforeRowsDigest === proof.afterRowsDigest);
}

/** Shared pure data rules. The caller must validate its finite chain and any legacy bridge.
 * Neither the state nor successful replay grants a native lock, registration or V permit. */
export function applyControlNode(plan: MigrationPlan, node: ControlReplayNode, previous: ControlReplayNode | undefined,
  origin: ControlReplayNode, roster: SourceClientsRosterV1, bindings: ControlReplayBindings, state: ControlReplayState, syntaxFrame?: P0FArtifactSyntaxFrame): ControlProof {
  if (syntaxFrame !== undefined) assertP0FSyntaxScope(syntaxFrame, 'rows', plan);
  const record = node.record;
  requireCandidate(record.formatVersion === 3 && record.controlProof !== null);
  const proof = record.controlProof;
  if (equal(node.reference, origin.reference)) {
    requireCandidate(proof.kind === "capture-controls");
    state.invariant = proof.maintenanceInvariant;
    requireCandidate(state.invariant.databaseInstanceId === record.source.databaseInstanceId && state.invariant.fenceEpoch === String(record.fenceEpoch)
      && state.invariant.activeMigrationId === record.migrationId && state.invariant.planDigest === record.plan.sha256
      && state.invariant.guardManifestDigest === plan.guardManifestDigest && state.invariant.controlRootJson === canonicalJson(bindings.controlRoot)
      && state.invariant.mutexIdentityJson === canonicalJson(bindings.mutexIdentity));
  } else {
    requireCandidate(proof.kind !== "capture-controls" && previous && state.invariant !== null);
    if (proof.kind === "cancel-terminal-controls") terminalBinding(proof, node, previous, origin, roster);
    else successorBinding(proof, node, previous, origin, roster);
    requireCandidate(proof.beforeRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  }
  requireCandidate(proof.facts.beforeCount === String(state.rows.length)
    && proof.facts.beforeRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  reserveP0FNativeNodes(syntaxFrame === undefined ? 10 : 13);
  reserveP0FNativeMetadata(2); // RowContext and its explicit spread source record
  const context: RowContext = { plan, record, fenceEpoch: Number(roster.fenceEpoch), encoding: roster.textEncoding, receiptGeneration: roster.receiptGeneration,
    registrations: state.registrations, unresolvedEncoding: state.unresolvedEncoding, ...(syntaxFrame === undefined ? {} : { syntaxFrame }) };
  validateRowsFacts(state.rows, proof.facts, context);
  if (proof.kind === "control-successor" || proof.kind === "legacy-first-capture-bridge") {
    state.rows = applyChanges(state.rows, proof, context);
    requireCandidate(proof.afterRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  }
  return proof;
}

/** A V-only root is the first capture-controls. Legacy ready bridges remain elsewhere. */
export function replayVerificationControls(plan: MigrationPlan, nodes: readonly ControlReplayNode[], bindings: ControlReplayBindings, syntaxFrame?: P0FArtifactSyntaxFrame) {
  if (syntaxFrame !== undefined) assertP0FSyntaxScope(syntaxFrame, 'rows', plan);
  requireCandidate(validateJournalSequence(nodes) === "active");
  const firstCapture = nodes.findIndex(node => node.record.event === "capture"), origin = nodes[firstCapture];
  reserveP0FNativeNodes(1, Math.max(0, firstCapture));
  reserveP0FNativeMetadata(1);
  requireCandidate(origin && origin.record.formatVersion === 3 && origin.record.sourceClients !== null
    && nodes.slice(0, firstCapture).every(node => node.record.phase === "planned" && capturePrefixEvents.includes(node.record.event)));
  const roster = origin.record.sourceClients;
  reserveP0FNativeNodes(7);
  reserveP0FNativeMetadata(5); // state, registrations Map, unresolved Set, captures Map, events list
  const state: ControlReplayState = { rows: roster.rows, invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
  const captures = new Map<string, { readonly rows: readonly SourceClientRawRow[]; readonly invariant: MaintenanceInvariant }>();
  const events: { readonly journal: ArtifactRef; readonly proof: ControlProof }[] = [];
  for (let index = firstCapture; index < nodes.length; index++) {
    const node = nodes[index]!, record = node.record;
    requireCandidate(record.formatVersion === 3 && record.phase === "quiesced" && verificationEvents.includes(record.event)
      && record.controlProof !== null && record.controlProof.kind !== "legacy-first-capture-bridge");
    const proof = applyControlNode(plan, node, nodes[index - 1], origin, roster, bindings, state, syntaxFrame);
    reserveP0FNativeNodes(3, 1);reserveP0FNativeMetadata(1); // event record; slot already prepaid
    events.push({ journal: node.reference, proof });
    requireCandidate(state.invariant !== null);
    if (record.event === "capture") { reserveP0FNativeNodes(3, 1);reserveP0FNativeMetadata(1); captures.set(node.reference.ref, { rows: state.rows, invariant: state.invariant }); }
  }
  requireCandidate(state.invariant !== null);
  reserveP0FNativeNodes(11 + state.unresolvedEncoding.size);
  reserveP0FNativeMetadata(2+state.unresolvedEncoding.size); // return protocol + unresolved reference list
  return { kind: "untrusted-verification-controls" as const, originCapture: origin.reference, originalRoster: roster,
    expectedRows: state.rows, invariant: state.invariant, captures, events, unresolvedEncoding: [...state.unresolvedEncoding] };
}

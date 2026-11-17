import { canonicalJson, digestJson } from "../canonical.ts";
import type { ArtifactRef, MigrationPlan, SourceClientRawRow, SourceClientsRosterV1, SourceRef, VerificationJournalRecord } from "../types.ts";
import { equal, requireCandidate } from "./common.ts";
import { applyChanges, validateRowsFacts, type RowContext } from "./rows.ts";
import type { ControlProof, MaintenanceInvariant, SuccessorProof } from "./schema.ts";

export interface ControlReplayNode { readonly reference: ArtifactRef; readonly record: VerificationJournalRecord }
export interface ControlReplayState {
  rows: readonly SourceClientRawRow[];
  invariant: MaintenanceInvariant | null;
  readonly registrations: RowContext["registrations"];
  readonly unresolvedEncoding: Set<string>;
}
export interface ControlReplayBindings { readonly controlRoot: unknown; readonly mutexIdentity: unknown }
export function rowsDigest(source: SourceRef, textEncoding: SourceClientsRosterV1["textEncoding"], rows: readonly SourceClientRawRow[]): string {
  const sorted = [...rows].sort((a, b) => a.client_id[1] < b.client_id[1] ? -1 : a.client_id[1] > b.client_id[1] ? 1 : 0);
  requireCandidate(sorted.every((row, index) => index === 0 || sorted[index - 1]!.client_id[1] !== row.client_id[1]));
  return digestJson({ formatVersion: 1, kind: "source-clients-live-rows", source, textEncoding, rows: sorted });
}
function successorBinding(proof: SuccessorProof, node: ControlReplayNode, previous: ControlReplayNode,
  origin: ControlReplayNode, roster: SourceClientsRosterV1): void {
  requireCandidate(equal(proof.originCapture, origin.reference) && proof.originSourceClientsDigest === digestJson(roster)
    && equal(proof.source, node.record.source) && equal(proof.plan, node.record.plan) && proof.migrationId === node.record.migrationId
    && proof.fenceEpoch === String(node.record.fenceEpoch) && proof.receiptGeneration === roster.receiptGeneration && equal(proof.textEncoding, roster.textEncoding)
    && equal(proof.previousAnchor, previous.reference) && proof.fromGeneration === String(previous.record.ownerGeneration)
    && proof.toGeneration === String(node.record.ownerGeneration) && proof.targetSequence === String(node.record.sequence));
}

/** Shared pure data rules. The caller must validate its finite chain and any legacy bridge.
 * Neither the state nor successful replay grants a native lock, registration or V permit. */
export function applyControlNode(plan: MigrationPlan, node: ControlReplayNode, previous: ControlReplayNode | undefined,
  origin: ControlReplayNode, roster: SourceClientsRosterV1, bindings: ControlReplayBindings, state: ControlReplayState): ControlProof {
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
    successorBinding(proof, node, previous, origin, roster);
    requireCandidate(proof.beforeRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  }
  requireCandidate(proof.facts.beforeCount === String(state.rows.length)
    && proof.facts.beforeRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  const context: RowContext = { plan, record, encoding: roster.textEncoding, receiptGeneration: roster.receiptGeneration,
    registrations: state.registrations, unresolvedEncoding: state.unresolvedEncoding };
  validateRowsFacts(state.rows, proof.facts, context);
  if (proof.kind !== "capture-controls") {
    state.rows = applyChanges(state.rows, proof, context);
    requireCandidate(proof.afterRowsDigest === rowsDigest(record.source, roster.textEncoding, state.rows));
  }
  return proof;
}

/** A V-only root is the first capture-controls. Legacy ready bridges remain elsewhere. */
export function replayVerificationControls(plan: MigrationPlan, nodes: readonly ControlReplayNode[], bindings: ControlReplayBindings) {
  const firstCapture = nodes.findIndex(node => node.record.event === "capture"), origin = nodes[firstCapture];
  requireCandidate(origin && origin.record.formatVersion === 3 && origin.record.sourceClients !== null
    && nodes.slice(0, firstCapture).every(node => node.record.phase === "planned" && ["enter", "observation"].includes(node.record.event)));
  const roster = origin.record.sourceClients;
  const state: ControlReplayState = { rows: roster.rows, invariant: null, registrations: new Map(), unresolvedEncoding: new Set() };
  const captures = new Map<string, { readonly rows: readonly SourceClientRawRow[]; readonly invariant: MaintenanceInvariant }>();
  const events: { readonly journal: ArtifactRef; readonly proof: ControlProof }[] = [];
  for (let index = firstCapture; index < nodes.length; index++) {
    const node = nodes[index]!, record = node.record;
    requireCandidate(record.formatVersion === 3 && record.phase === "quiesced" && ["capture", "observation", "takeover"].includes(record.event)
      && record.controlProof !== null && record.controlProof.kind !== "legacy-first-capture-bridge");
    const proof = applyControlNode(plan, node, nodes[index - 1], origin, roster, bindings, state);
    events.push({ journal: node.reference, proof });
    requireCandidate(state.invariant !== null);
    if (record.event === "capture") captures.set(node.reference.ref, { rows: state.rows, invariant: state.invariant });
  }
  requireCandidate(state.invariant !== null);
  return { kind: "untrusted-verification-controls" as const, originCapture: origin.reference, originalRoster: roster,
    expectedRows: state.rows, invariant: state.invariant, captures, events, unresolvedEncoding: [...state.unresolvedEncoding] };
}

import assert from "node:assert/strict";
import { controlVector, successorVector } from "./maintenance-control-candidate.ts";
import { canonicalJson } from "../../src/server/storage/maintenance/canonical.ts";
import { reconstructControlCandidates } from "../../src/server/storage/maintenance/control-candidate/replay.ts";
import type { ArtifactRef, ControlRootIdentity, Json, SourceClientRawRow, SourceClientsObservation } from "../../src/server/storage/maintenance/types.ts";

/** Mechanism seeds only. Source/root identify the owned test DB; events are synthetic and prove no registration/native/Fs history. */
export function controlSqlVector(observed: SourceClientsObservation, root: ControlRootIdentity, mutex: Json) {
  const f = controlVector({ backend: observed.source.kind, encoding: observed.textEncoding.name,
    mechanism: { sourceIdentity: observed.sourceIdentity, databaseInstanceId: observed.source.databaseInstanceId, root, mutex,
      schemaManifestDigest: observed.schemaManifestDigest, guardManifestDigest: observed.state.guardManifestDigest } });
  const capture = f.pack("journal", f.captured), at = "2026-11-15T00:01:00.000Z";
  const registration = { formatVersion: 1, kind: "maintenance-controller-registration", source: f.source, sourceIdentityDigest: f.source.identityDigest,
    creation: { migrationId: "a12", plan: f.planRef, fenceEpoch: "2", ownerGeneration: "7", previousAnchor: capture, targetSequence: "3" },
    sessionBinding: "per-source-lock-native-inventory-v1", drainReceipt: null };
  const row: SourceClientRawRow = { client_id: f.text("controller-sql-only"), database_instance_id: f.text(f.source.databaseInstanceId),
    entrypoint: f.text("maintenance-controller"), build_id: f.text("boardroom-maintenance-control-v1"), host_identity_json: f.text(canonicalJson(f.facts.actor.host)),
    process_identity_json: f.text(canonicalJson(f.facts.actor.process)), db_sessions_json: f.text(canonicalJson(registration)), registered_at: f.text(at),
    last_observed_at: f.text(at), ended_at: ["null"], drain_state: f.text("none"), drain_receipt_digest: ["null"], protocol_version: ["integer", "1"],
    registered_epoch: ["integer", "2"], observed_epoch: ["integer", "2"], drain_epoch: ["null"] };
  const inserted = successorVector(f, { origin: capture, previous: capture, sequence: 3, before: [], after: [row], clients: [],
    changes: [{ kind: "maintenance-registration", before: null, after: row, actorId: f.facts.actor.actorId }] });
  const insertedRef = f.pack("journal", inserted);
  const actor = { ...f.facts.actor, clientId: row.client_id };
  const fact = { kind: "maintenance-controller", subject: row.client_id, rowDigest: f.rowDigest(row), host: actor.host, process: actor.process,
    processCheck: actor.processCheck, classification: "active-actor", registration: "current-chain" };
  const nextTime = "2026-11-15T00:02:00.000Z", updatedRow = { ...row, last_observed_at: f.text(nextTime) };
  const updated = successorVector(f, { origin: capture, previous: insertedRef, sequence: 4, before: [row], after: [updatedRow], clients: [fact],
    actor, observedAt: nextTime, changes: [{ kind: "client-observation", subject: row.client_id, before: row, after: updatedRow, effect: "observed" }] });
  const updatedRef = f.pack("journal", updated);
  const endedTime = "2026-11-15T00:03:00.000Z", endedRow = { ...updatedRow, last_observed_at: f.text(endedTime), ended_at: f.text(endedTime) };
  // Supplied consistency facts only; these vectors do not claim this actor was ever native-observed.
  const nextId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const originalProcess = f.facts.actor.process;
  assert(originalProcess.platform === "linux", "this mechanism seed deliberately uses pure Linux facts, not native platform evidence");
  const nextActor = { ...f.facts.actor, actorId: nextId, clientId: null,
    process: { ...originalProcess, pid: 124, instanceId: nextId, startTicks: "200" },
    processCheck: { kind: "linux-matched", observerUid: 1000, kernelBootId: originalProcess.kernelBootId, pidNamespace: originalProcess.pidNamespace,
      uidBefore: 1000, uidAfter: 1000, pid: 124, startTicksBefore: "200", startTicksAfter: "200" } };
  const exitedFact = { ...fact, rowDigest: f.rowDigest(updatedRow), classification: "exited-actor", processCheck: {
    kind: "linux-absent", observerUid: 1000, kernelBootId: f.facts.actor.process.kernelBootId,
    pidNamespace: f.facts.actor.process.pidNamespace, pid: 123, stage: "proc-open", errno: "ENOENT" } };
  const ended = successorVector(f, { origin: capture, previous: updatedRef, sequence: 5, before: [updatedRow], after: [endedRow], clients: [exitedFact],
    actor: nextActor, observedAt: endedTime, changes: [{ kind: "client-observation", subject: row.client_id, before: updatedRow, after: endedRow, effect: "ended-observed" }] });
  if ("observer" in ended.controlProof.facts.sessions) ended.controlProof.facts.sessions = { ...ended.controlProof.facts.sessions,
    observer: { host: nextActor.host, process: nextActor.process } };
  const endedRef = f.pack("journal", ended);
  const zero = successorVector(f, { origin: capture, previous: capture, sequence: 3, before: [], after: [], clients: [], changes: [],
    event: "takeover", fromGeneration: 7, toGeneration: 8 });
  const zeroRef = f.pack("journal", zero);
  const cancellation = successorVector(f, { origin: capture, previous: zeroRef, sequence: 4,
    before: [], after: [], clients: [], changes: [], fromGeneration: 8, toGeneration: 8 });
  const intent = { ...cancellation, event: "cancel_intent" }, intentRef = f.pack("journal", intent);
  const terminal = { ...intent, event: "cancelled", sequence: 5, previous: intentRef, fenceEpoch: 3,
    controlProof: { formatVersion: 1, kind: "cancel-terminal-controls", originCapture: capture,
      originSourceClientsDigest: f.captured.frozen.sourceClientsDigest, source: f.source, plan: f.planRef, migrationId: "a12",
      epochBefore: "2", epochAfter: "3", receiptGeneration: "7", textEncoding: f.encoding, previousAnchor: intentRef,
      ownerGeneration: "8", targetSequence: "5", beforeRowsDigest: f.rowsDigest([]), afterRowsDigest: f.rowsDigest([]),
      changes: [], facts: cancellation.controlProof.facts, successorRule: "open-next-epoch-clear-active-v1" } };
  const terminalRef = f.pack("journal", terminal);
  const input = (head: ArtifactRef) => ({ head, objects: f.objects, controlRoot: f.root, mutexIdentity: f.mutex });
  const reconstruct = (head: ArtifactRef) => {
    const value = reconstructControlCandidates(input(head));
    assert.equal(value.kind, "untrusted-control-reconstruction");
    if (value.kind !== "untrusted-control-reconstruction") throw new Error("complete mechanism seed required");
    return value;
  };
  for (const head of [capture, insertedRef, updatedRef, endedRef, zeroRef]) reconstruct(head);
  return { f, capture, row, inserted, insertedRef, updated, updatedRow, updatedRef, endedRow, endedRef, zeroRef,
    intentRef, terminalRef, input, reconstruct };
}

export const controlSeedColumns = {
  singleton: "singleton", databaseInstanceId: "database_instance_id", admission: "admission", fenceEpoch: "fence_epoch", ownerGeneration: "owner_generation",
  activeMigrationId: "active_migration_id", planDigest: "plan_digest", controlRootJson: "control_root_json", mutexIdentityJson: "mutex_identity_json",
  journalRecordRef: "journal_record_ref", journalDigest: "journal_digest", journalSequence: "journal_sequence", protocolVersion: "protocol_version", guardManifestDigest: "guard_manifest_digest",
} as const;

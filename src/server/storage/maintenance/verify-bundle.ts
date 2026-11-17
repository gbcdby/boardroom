import path from "node:path";
import { canonicalJson } from "./canonical.ts";
import { decodeRow } from "./control-candidate/rows.ts";
import { replayVerificationControls } from "./control-candidate/replay-core.ts";
import { MaintenanceFailure } from "./error.ts";
import { assertCapturedSourceClientBinding } from "./source-client-binding.ts";
import { assertVerificationSourceClientBinding } from "./verification-source-client-binding.ts";
import { compatibleSourceClientWindow, type SourceClientJournalProof, type SourceClientObservationProof, type SourceClientRegistrationProof } from "./source-client-window.ts";
import { captureReference, verifyVerificationJournalChain, verifyVerificationRestoreBundleClosure, type JournalNode } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { parseVerification } from "./parse.ts";
import { restoreSourceFiles } from "./restore-files.ts";
import type { ActualRestoreVerification, ArtifactRef, Json, MaintenanceAdapter, SourceLock, SourceObservation, VerificationJournalRecord } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: "snapshot_invalid" | "source_changed" | "maintenance_lost" | "control_root_mismatch"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "verify-bundle");
}

/** Extract row-level authority from control-successor journal nodes. A v2
 * observation/takeover node carries no changes, so a new client row cannot be
 * authorized merely by its own envelope or by an unrelated anchor advance. */
function liveControlProof(nodes: readonly JournalNode<VerificationJournalRecord>[], captureIndex: number): SourceClientJournalProof {
  const registrations: SourceClientRegistrationProof[] = [];
  const observations: SourceClientObservationProof[] = [];
  for (const node of nodes.slice(captureIndex + 1)) {
    if (node.record.formatVersion !== 3 || node.record.controlProof === null) continue;
    const proof = node.record.controlProof;
    if (proof.kind === "capture-controls") continue;
    for (const change of proof.changes) {
      if (change.kind === "maintenance-registration") {
        const after = decodeRow(change.after, proof.textEncoding);
        if (!after || typeof after.client_id !== "string" || after.client_id === "") requireValue(false, "source_changed");
        requireValue(proof.facts.actor.clientId === null && change.actorId === proof.facts.actor.actorId
          && proof.facts.actor.process.instanceId === change.actorId, "source_changed");
        registrations.push({ journal: node.reference, sequence: node.record.sequence,
          clientId: after.client_id, after, actorId: change.actorId });
      } else {
        const before = decodeRow(change.before, proof.textEncoding), after = decodeRow(change.after, proof.textEncoding);
        if (!before || !after || typeof after.client_id !== "string" || after.client_id === ""
          || before.client_id !== after.client_id) requireValue(false, "source_changed");
        observations.push({ journal: node.reference, sequence: node.record.sequence,
          clientId: after.client_id, before, after, effect: change.effect });
      }
    }
  }
  return { registrations, observations };
}

/** A byte-valid B/U is not authority to restore for a later sealed migration.
 * The native lock's *current* DB anchor must extend B's exact capture through only
 * the quiesced observation/takeover transitions permitted by the journal protocol.
 * Immutable artifacts are never selected by the filesystem's latest-looking name. */
async function assertLiveCapture(store: ArtifactStore, lock: SourceLock, observed: SourceObservation,
  closed: Awaited<ReturnType<typeof verifyVerificationRestoreBundleClosure>>): Promise<void> {
  const capture = closed.bundle.capture, state = observed.state;
  requireValue(state.admission === "sealed" && state.journalRecordRef !== null && state.journalDigest !== null
    && state.activeMigrationId === capture.migrationId && state.planDigest === capture.planDigest
    && state.fenceEpoch === capture.fenceEpoch && state.databaseInstanceId === capture.source.databaseInstanceId,
    "maintenance_lost");
  requireValue(same(observed.source, capture.source) && same(observed.sourceIdentity, closed.chain.plan.sourceIdentity),
    "source_changed");
  const anchored = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
  const liveChain = await verifyVerificationJournalChain(store, anchored), head = liveChain.nodes.at(-1)!;
  const captureIndex = liveChain.nodes.findIndex(node => same(node.reference, capture.journal));
  requireValue(captureIndex === closed.chain.nodes.length - 1
    && same(liveChain.nodes.slice(0, captureIndex + 1).map(node => node.reference),
      closed.chain.nodes.map(node => node.reference))
    && same(liveChain.plan, closed.chain.plan)
    && same(captureReference(liveChain.nodes[captureIndex]!), capture)
    && liveChain.nodes.slice(captureIndex + 1).every(node =>
      node.record.phase === "quiesced" && ["observation", "takeover"].includes(node.record.event))
    && head.record.phase === "quiesced" && ["capture", "observation", "takeover"].includes(head.record.event)
    && head.record.migrationId === capture.migrationId && head.record.plan.sha256 === capture.planDigest
    && head.record.fenceEpoch === capture.fenceEpoch && head.record.ownerGeneration === state.ownerGeneration
    && head.record.sequence === state.journalSequence
    && head.reference.ref === state.journalRecordRef && head.reference.sha256 === state.journalDigest,
    "maintenance_lost");

  const captured = closed.chain.nodes.at(-1)!.record, frozen = captured.frozen;
  requireValue(captured.formatVersion !== 1 && captured.sourceClients !== null, "source_changed");
  let windowBefore = closed.manifests.controlRows.storage_source_clients, windowOrigin = captureIndex;
  // Validate every v3 proof and bind both capture/head row states before any
  // same-row fast path. Legacy v2 keeps its existing all-encoding native join.
  if (captured.formatVersion === 3) {
    let mutexIdentity: unknown;
    try { mutexIdentity = JSON.parse(state.mutexIdentityJson!); }
    catch { requireValue(false, "control_root_mismatch"); }
    const replay = replayVerificationControls(liveChain.plan, liveChain.nodes, { controlRoot: store.identity, mutexIdentity });
    windowBefore = await assertVerificationSourceClientBinding(lock, observed, closed.chain.nodes.at(-1)!, closed.manifests, replay);
    windowOrigin = liveChain.nodes.findIndex(node => same(node.reference, replay.originCapture));
    requireValue(windowOrigin >= 0 && windowOrigin <= captureIndex, "source_changed");
  } else await assertCapturedSourceClientBinding(lock, observed, captured.sourceClients, closed.manifests);
  requireValue(frozen !== null && state.guardManifestDigest === frozen.guardManifestDigest
    && observed.manifests.schemaManifestDigest === frozen.schemaManifestDigest
    && observed.manifests.frozenBusinessManifestDigest === frozen.frozenBusinessManifestDigest
    && await compatibleSourceClientWindow(windowBefore,
      observed.manifests.controlRows.storage_source_clients, {
        journalAdvanced: liveChain.nodes.length > windowOrigin + 1,
        mode: "strict", proof: liveControlProof(liveChain.nodes, windowOrigin),
        fenceEpoch: capture.fenceEpoch, databaseInstanceId: capture.source.databaseInstanceId,
        source: capture.source, migrationId: capture.migrationId, planDigest: capture.planDigest,
        currentSequence: head.record.sequence,
        anchors: liveChain.nodes.slice(windowOrigin + 1).map(node => ({
          reference: node.reference, previous: node.record.previous, migrationId: node.record.migrationId,
          planDigest: node.record.plan.sha256, fenceEpoch: node.record.fenceEpoch,
          ownerGeneration: node.record.ownerGeneration, sequence: node.record.sequence,
        })),
      }),
    "source_changed");
  const prior = closed.manifests.controlRows.storage_maintenance[0];
  const live = observed.manifests.controlRows.storage_maintenance[0];
  requireValue(prior !== undefined && live !== undefined
    && observed.manifests.controlRows.storage_maintenance.length === 1
    && same(Object.keys(prior).sort(), Object.keys(live).sort()), "source_changed");
  // A valid takeover can advance the generation/journal pointer, but must not
  // silently mutate the mutex owner, schema guard, migration/plan or other controls.
  const mutable = new Set(["owner_generation", "journal_record_ref", "journal_digest", "journal_sequence"]);
  for (const key of Object.keys(prior)) if (!mutable.has(key)) requireValue(same(prior[key], live[key]), "source_changed");
  requireValue(live.admission === "sealed" && String(live.fence_epoch) === String(capture.fenceEpoch)
    && live.active_migration_id === capture.migrationId && live.plan_digest === capture.planDigest
    && String(live.owner_generation) === String(head.record.ownerGeneration)
    && live.journal_record_ref === head.reference.ref && live.journal_digest === head.reference.sha256
    && String(live.journal_sequence) === String(head.record.sequence), "maintenance_lost");
}

/**
 * Internal B/U -> V under the caller's actual native adapter and snapshot lock.
 * The caller retains both and owns their eventual cleanup. In particular, public
 * PostgreSQL verification consumes the same adapter/window's native backup authority;
 * a persisted bundle is not a replacement for that authority or an offline permit.
 * This restores artifacts, not the live source; it never writes a source anchor,
 * receipt, ready record, or source-files qualification. Failed private attempts remain
 * unselected, and a publication failure can leave an unreturned immutable V orphan.
 */
export async function verifyRestoreBundle(store: ArtifactStore, adapter: MaintenanceAdapter, lock: SourceLock,
  bundleRef: ArtifactRef, publicationRef: ArtifactRef): Promise<ArtifactRef> {
  requireValue(store.kindFor(bundleRef) === "restore-bundle" && store.kindFor(publicationRef) === "publication", "snapshot_invalid");
  const fixedBundle = Object.freeze({ ...bundleRef }), fixedPublication = Object.freeze({ ...publicationRef });
  await lock.assertHeld(); await store.assertRoot();
  const closure = await verifyVerificationRestoreBundleClosure(store, fixedBundle, fixedPublication);
  const initial = await lock.observe();
  requireValue(initial.state.admission === "sealed", "maintenance_lost");
  requireValue(same(initial.source, closure.bundle.capture.source) && same(initial.sourceIdentity, closure.chain.plan.sourceIdentity)
    && adapter.dialect === initial.source.kind, "source_changed");
  requireValue(initial.state.controlRootJson === canonicalJson(store.identity) && initial.state.mutexIdentityJson !== null, "control_root_mismatch");
  await assertLiveCapture(store, lock, initial, closure);
  const assertCurrent = async () => {
    await lock.assertHeld();
    const current = await lock.observe();
    requireValue(same(current.source, initial.source) && same(current.sourceIdentity, initial.sourceIdentity)
      && same(current.state, initial.state) && same(current.manifests, initial.manifests), "source_changed");
    await assertLiveCapture(store, lock, current, closure);
    await lock.assertHeld();
  };
  const guarded = await ArtifactStore.open(store.root, initial.source, { assertCurrent: () => lock.assertHeld() });
  requireValue(same(guarded.identity, store.identity), "control_root_mismatch");
  await assertCurrent();
  const databaseAttempt = await guarded.createAttempt(initial.state.ownerGeneration);
  // SQLite creates its restore leaf exclusively; PostgreSQL requires an existing
  // private directory for its native tool files. Neither is a future active target.
  const databaseDirectory = adapter.dialect === "sqlite" ? path.join(databaseAttempt, "database") : databaseAttempt;
  const database = await adapter.verifyDatabase(guarded.pathFor(closure.databaseRef), closure.manifests, databaseDirectory);
  await assertCurrent();
  const fileAttempt = await guarded.createAttempt(initial.state.ownerGeneration);
  const files = await restoreSourceFiles(guarded, closure.bundle.sourceFilesManifest, path.join(fileAttempt, "files"));
  requireValue(same(files.sourceFilesManifest, closure.bundle.sourceFilesManifest), "snapshot_invalid");
  // Recheck the exact closed byte/reference graph after the two real restorations.
  // These immutable references must not silently select another bundle or payload.
  await verifyVerificationRestoreBundleClosure(guarded, fixedBundle, fixedPublication);
  await assertCurrent();
  const target: Json = { kind: "isolated-restore-targets", database,
    sourceFiles: { kind: files.kind, sourceFilesManifest: { ...files.sourceFilesManifest }, target: { ...files.target },
      entries: files.entries.map(entry => ({ ...entry, identity: entry.identity ? { ...entry.identity } : null })) } };
  const verification: ActualRestoreVerification = parseVerification({ formatVersion: 1, kind: "verification",
    bundle: fixedBundle, publication: fixedPublication, verificationTargetIdentity: target,
    exactFullDataAndControlMatched: true, sourceFilePayloadsMatched: true, schemaAndScopeMatched: true });
  const reference = await guarded.putJson("verification", verification);
  await assertCurrent();
  return reference;
}

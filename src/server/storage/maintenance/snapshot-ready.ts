import { z } from "zod";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { assertFrozenSourceUnchanged, captureReference, verifyJournalChain, verifyRestoreBundleClosure, verifySnapshotClosure } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { parseJournal, parseReceipt, parseVerification } from "./parse.ts";
import { buildSourceClientsRoster } from "./source-clients.ts";
import type { ArtifactRef, BlockerCode, ContinueRequest, MaintenanceRef, OperationMutex, SourceClientsRosterV1, SourceLock, SourceObservation } from "./types.ts";

const requestSchema = z.object({
  plan: z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict(),
  expectedSource: source, expectedPhase: z.enum(["planned", "quiesced", "snapshot_ready"]).nullable(),
  expectedJournalDigest: hash.nullable(), requestId: id,
}).strict();
const inputSchema = z.object({ bundle: ref, publication: ref, verification: ref }).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: BlockerCode): asserts value {
  if (!value) throw new MaintenanceFailure(code, "snapshot-ready-stage");
}

/**
 * Internal R/Jr staging only, borrowing the caller's actual native source lock and mutex.
 * The return value remains inside that transaction: it is neither COMMIT/cleanup evidence
 * nor public snapshot_ready. No public entry point calls this component. The caller keeps
 * ownership of both resources and must interpret the outer operation's actual outcome.
 *
 * Fixed B/U/V and codec-valid Fs cannot establish live source-files qualification. Before
 * future production integration, a real qualified Fs producer and its window revalidation
 * must exist. Protocol fixtures exercise this finite composition without granting them.
 * Failure may leave unselected immutable R/Jr; this function never recovers from orphans,
 * changes support policy, captures a new Jq, takes over, cancels, or replays source SQL.
 */
export async function stageSnapshotReady(store: ArtifactStore, lock: SourceLock, mutex: OperationMutex,
  input: { bundle: ArtifactRef; publication: ArtifactRef; verification: ArtifactRef }, value: ContinueRequest,
): Promise<{ receipt: ArtifactRef; journal: ArtifactRef; ref: MaintenanceRef }> {
  const parsedRequest = requestSchema.safeParse(value), parsedInput = inputSchema.safeParse(input);
  requireValue(parsedRequest.success && parsedInput.success, "request_conflict");
  const request = parsedRequest.data, fixed = parsedInput.data;
  const requestDigest = digestJson({ operation: "stage-snapshot-ready", request, input: fixed });
  await mutex.assertHeld(); await lock.assertHeld(); await store.assertRoot();
  const initial = await lock.observe(), state = initial.state;
  requireValue(state.admission === "sealed" && state.journalRecordRef !== null && state.journalDigest !== null, "phase_conflict");
  requireValue(state.controlRootJson === canonicalJson(store.identity) && state.mutexIdentityJson === canonicalJson(mutex.identity), "control_root_mismatch");
  const anchored = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
  const chain = await verifyJournalChain(store, anchored), head = chain.nodes.at(-1)!;
  requireValue(head.record.sequence === state.journalSequence && head.record.migrationId === state.activeMigrationId
    && head.record.plan.sha256 === state.planDigest && head.record.source.databaseInstanceId === state.databaseInstanceId
    && head.record.fenceEpoch === state.fenceEpoch && head.record.ownerGeneration === state.ownerGeneration, "maintenance_lost");
  // A caller's original quiesced expectations remain unchanged on a valid explicit retry.
  // Check the durable request digest before comparing those expectations to a ready head.
  const previous = chain.nodes.find(node => node.record.requestId === request.requestId);
  if (previous) requireValue(previous.record.requestDigest === requestDigest, "request_conflict");
  requireValue(request.plan.controlRoot === store.root && request.plan.planDigest === request.plan.immutablePlan.sha256
    && request.plan.migrationId === chain.plan.migrationId && same(request.plan.immutablePlan, head.record.plan), "plan_stale");
  requireValue(same(initial.source, request.expectedSource) && same(initial.source, chain.plan.source)
    && same(initial.sourceIdentity, chain.plan.sourceIdentity), "source_changed");
  requireValue(!chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)), "phase_conflict");
  const assertRoster = async (observed: SourceObservation, captured: SourceClientsRosterV1) => {
    const live = await lock.observeSourceClients();
    requireValue(same(live.source, observed.source) && same(live.sourceIdentity, observed.sourceIdentity)
      && same(live.state, observed.state) && live.schemaManifestDigest === observed.manifests.schemaManifestDigest, "source_changed");
    requireValue(same(buildSourceClientsRoster({ ...captured, source: live.source, textEncoding: live.textEncoding, rows: live.rows }), captured), "source_changed");
  };
  const assertCurrent = async (captured: SourceClientsRosterV1) => {
    await mutex.assertHeld(); await lock.assertHeld();
    const current = await lock.observe();
    requireValue(same(current.source, initial.source) && same(current.sourceIdentity, initial.sourceIdentity)
      && same(current.state, state) && same(current.manifests, initial.manifests), "source_changed");
    await assertRoster(current, captured); await mutex.assertHeld(); await lock.assertHeld();
  };
  if (head.record.phase === "snapshot_ready") {
    requireValue(previous?.record.event === "ready", "request_conflict");
    const closure = await verifySnapshotClosure(store, anchored);
    requireValue(same(closure.receiptRef, previous.record.snapshot) && same(closure.receipt.bundle, fixed.bundle)
      && same(closure.receipt.publication, fixed.publication) && same(closure.receipt.verification, fixed.verification), "snapshot_invalid");
    const captured = closure.chain.nodes.find(node => same(node.reference, closure.receipt.capture.journal))!;
    requireValue(captured.record.formatVersion === 2 && captured.record.sourceClients !== null, "journal_invalid");
    requireValue(closure.files.rootBindings.every(binding => binding.hostIdentityDigest === store.identity.hostIdentityDigest), "source_changed");
    assertFrozenSourceUnchanged(initial, closure.manifests, closure.chain);
    await assertCurrent(captured.record.sourceClients);
    return { receipt: closure.receiptRef, journal: previous.reference, ref: captureReference(head) };
  }
  requireValue(previous === undefined, "request_conflict");
  requireValue(head.record.formatVersion === 2 && head.record.event === "capture" && head.record.phase === "quiesced"
    && head.record.frozen !== null && head.record.sourceClients !== null, "phase_conflict");
  requireValue(request.expectedPhase === "quiesced" && request.expectedJournalDigest === anchored.sha256, "phase_conflict");
  requireValue(store.kindFor(fixed.bundle) === "restore-bundle" && store.kindFor(fixed.publication) === "publication"
    && store.kindFor(fixed.verification) === "verification", "snapshot_invalid");
  const closure = await verifyRestoreBundleClosure(store, fixed.bundle, fixed.publication);
  requireValue(same(closure.bundle.capture, captureReference(head)) && same(closure.manifests, initial.manifests), "source_changed");
  requireValue(closure.files.rootBindings.every(binding => binding.hostIdentityDigest === store.identity.hostIdentityDigest), "source_changed");
  const verification = parseVerification(await store.readJson(fixed.verification, "verification"));
  requireValue(same(verification.bundle, fixed.bundle) && same(verification.publication, fixed.publication), "snapshot_invalid");
  await assertCurrent(head.record.sourceClients);
  const guarded = await ArtifactStore.open(store.root, initial.source, { assertCurrent: async () => {
    await mutex.assertHeld(); await lock.assertHeld();
  } });
  requireValue(same(guarded.identity, store.identity), "control_root_mismatch");
  const receiptBody = parseReceipt({ formatVersion: 1, kind: "receipt", snapshotId: digestJson({ requestDigest, capture: closure.bundle.capture, input: fixed }),
    capture: closure.bundle.capture, restorePointDigest: closure.bundle.restorePointDigest, sourceFilesManifest: closure.bundle.sourceFilesManifest,
    bundle: fixed.bundle, publication: fixed.publication, verification: fixed.verification, database: closure.databaseRef,
    manifests: closure.manifestsRef, capability: closure.capabilityRef, schemaManifestDigest: closure.manifests.schemaManifestDigest,
    fullDataManifestDigest: closure.manifests.fullDataManifestDigest, frozenBusinessManifestDigest: closure.manifests.frozenBusinessManifestDigest,
    capturedControlManifestDigest: closure.manifests.capturedControlManifestDigest });
  const receipt = await guarded.putJson("receipt", receiptBody);
  await assertCurrent(head.record.sourceClients);
  const record = parseJournal({ formatVersion: 2, kind: "journal", migrationId: head.record.migrationId,
    sequence: head.record.sequence + 1, previous: anchored, phase: "snapshot_ready", event: "ready",
    requestId: request.requestId, requestDigest, source: initial.source, plan: head.record.plan,
    fenceEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration, evidence: [], snapshot: receipt, sourceClients: null, frozen: null });
  const journal = await guarded.putJson("journal", record), ready = await verifySnapshotClosure(guarded, journal);
  requireValue(same(ready.receiptRef, receipt) && same(ready.receipt, receiptBody), "snapshot_invalid");
  await assertCurrent(head.record.sourceClients);
  await lock.anchor({ expected: state, admission: "sealed", fenceEpoch: state.fenceEpoch, ownerGeneration: state.ownerGeneration,
    activeMigrationId: state.activeMigrationId, planDigest: state.planDigest, controlRootIdentity: { ...store.identity },
    mutexIdentity: mutex.identity, journal, journalSequence: record.sequence });
  await mutex.assertHeld(); await lock.assertHeld();
  const after = await lock.observe();
  requireValue(same(after.sourceIdentity, initial.sourceIdentity) && same(after.state, { ...state,
    journalRecordRef: journal.ref, journalDigest: journal.sha256, journalSequence: record.sequence }), "maintenance_lost");
  assertFrozenSourceUnchanged(after, closure.manifests, ready.chain);
  await assertRoster(after, head.record.sourceClients); await mutex.assertHeld(); await lock.assertHeld();
  return { receipt, journal, ref: captureReference(ready.chain.nodes.at(-1)!) };
}

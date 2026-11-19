import { z } from "zod";
import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifyJournalChain } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { loadPersistedPlan, observeCapturePlanSelection, revalidatePlan } from "./plan.ts";
import type { ContinueRequest, MaintenanceAdapter, MaintenanceResult, MaintenanceServiceOptions, OperationMutex,
  SourceLock } from "./types.ts";

const requestSchema = z.object({
  plan: z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict(),
  expectedSource: source, expectedPhase: z.enum(["planned", "quiesced", "snapshot_ready"]).nullable(),
  expectedJournalDigest: hash.nullable(), requestId: id,
}).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: ConstructorParameters<typeof MaintenanceFailure>[0]): asserts value {
  if (!value) throw new MaintenanceFailure(code, "pre-jq-inspection");
}
const recovery = (): MaintenanceResult => ({ status: "recovery_required", lastVerifiedPhase: null,
  blockers: [{ code: "journal_invalid", subjectRef: "db-exact-journal" }] });

/**
 * Internal, read-only pre-Jq classification. Trusted assembly lends the same native adapter,
 * operation mutex and current control lock; no public request accepts these capabilities.
 * Nothing is published or anchored, and no returned value authorizes capture or takeover.
 * The caller retains all resources and must still complete its outer transaction/close checks.
 */
export async function inspectPreJq(options: MaintenanceServiceOptions, adapter: MaintenanceAdapter,
  mutex: OperationMutex, lock: SourceLock, value: ContinueRequest): Promise<MaintenanceResult> {
  try {
    const parsed = requestSchema.safeParse(value);
    requireValue(parsed.success, "request_conflict");
    const request = parsed.data;
    const plan = await loadPersistedPlan(request.plan, request.expectedSource);
    await mutex.assertHeld(); await lock.assertHeld();
    await observeCapturePlanSelection(plan, options, adapter);
    const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    const initial = await lock.observeSourceClients(), state = initial.state;
    requireValue(same(initial.source, plan.source) && same(initial.sourceIdentity, plan.sourceIdentity), "source_changed");
    requireValue(initial.schemaManifestDigest === plan.schemaManifestDigest
      && state.guardManifestDigest === plan.guardManifestDigest, "plan_stale");
    requireValue(state.controlRootJson === canonicalJson(store.identity)
      && state.mutexIdentityJson === canonicalJson(mutex.identity), "control_root_mismatch");
    requireValue(state.admission === "draining", "phase_conflict");
    if (!state.journalRecordRef || !state.journalDigest || state.journalSequence < 1) return recovery();

    let chain;
    try {
      const head = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      chain = await verifyJournalChain(store, head);
    } catch (error) {
      if (error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid"].includes(error.code)
        || (error as NodeJS.ErrnoException | null)?.code === "ENOENT") return recovery();
      throw error;
    }
    const first = chain.nodes[0]!, head = chain.nodes.at(-1)!;
    if (head.reference.ref !== state.journalRecordRef || head.reference.sha256 !== state.journalDigest
      || head.record.sequence !== state.journalSequence || head.record.fenceEpoch !== state.fenceEpoch
      || head.record.ownerGeneration !== state.ownerGeneration || head.record.migrationId !== state.activeMigrationId
      || head.record.plan.sha256 !== state.planDigest || head.record.source.databaseInstanceId !== state.databaseInstanceId)
      return recovery();
    requireValue(same(chain.plan, plan) && same(head.record.plan, request.plan.immutablePlan), "plan_stale");
    // A legacy or current planned chain can be inspected only at its original generation.
    // In particular, even a seemingly harmless planned takeover cannot legalize old receipts.
    requireValue(chain.nodes.every(node => node.record.phase === "planned"
      && ["enter", "observation"].includes(node.record.event)
      && node.record.ownerGeneration === first.record.ownerGeneration
      && node.record.fenceEpoch === first.record.fenceEpoch), "phase_conflict");
    const previous = chain.nodes.find(node => node.record.requestId === request.requestId);
    if (previous) {
      // Only enter has an established production request-digest domain in this prefix.
      // Unknown recorded operations cannot be accepted by guessing a canonical input.
      requireValue(previous.record.event === "enter" && previous.record.requestDigest
        === digestJson({ operation: "internal-enter", request }), "request_conflict");
    } else {
      requireValue(request.expectedPhase === "planned" && request.expectedJournalDigest === head.reference.sha256, "phase_conflict");
    }
    const assertCurrent = async () => {
      await mutex.assertHeld(); await lock.assertHeld(); await store.assertRoot();
      requireValue(same(await lock.observeSourceClients(), initial), "source_changed");
      await mutex.assertHeld(); await lock.assertHeld();
    };
    await lock.withSourceClientFacts(request.plan, async window => {
      requireValue(same(window.observation, initial) && window.origin.kind === "current-generation"
        && window.origin.capture === null && same(window.origin.head, head.reference)
        && window.origin.receiptGeneration === first.record.ownerGeneration
        && same(window.origin.chain, chain), "source_changed");
      await window.assertCurrent();
      await revalidatePlan(plan, options, adapter); await assertCurrent();
    });
    // This diagnostic preview has no frozen-source or writer authority. Complete its
    // own readonly configuration observation after the facts callback's real close.
    await revalidatePlan(plan, options, adapter);
    try {
      const finalHead = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
      requireValue(same(await verifyJournalChain(store, finalHead), chain), "journal_invalid");
    } catch (error) {
      if (error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid"].includes(error.code)
        || (error as NodeJS.ErrnoException | null)?.code === "ENOENT") return recovery();
      throw error;
    }
    await assertCurrent();
    return { status: "paused", phase: "planned", ref: captureReference(head) };
  } catch (error) {
    if (!(error instanceof MaintenanceFailure)) throw error;
    return { status: "blocked", lastVerifiedPhase: null,
      blockers: [{ code: error.code, subjectRef: "pre-jq-inspection" }] };
  }
}

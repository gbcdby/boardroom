import { z } from "zod";
import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { createControllerOwner, finishControllerOwner, recordControllerFailure, rememberControllerStore } from "./controller-owner.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { parseJournal } from "./parse.ts";
import { loadPersistedPlan, revalidatePlan } from "./plan.ts";
import { captureReference, verifyJournalChain } from "./journal.ts";
import { maintenanceFilesystem } from "./platform.ts";
import type { StorageMaintenanceState } from "../admission.ts";
import type { ContinueRequest, MaintenanceResult, MaintenanceServiceOptions, MigrationPlan, OperationMutex, SourceLock } from "./types.ts";

const requestSchema = z.object({
  plan: z.object({ migrationId: id, planDigest: hash, immutablePlan: ref, controlRoot: text }).strict(),
  expectedSource: source, expectedPhase: z.enum(["planned", "quiesced", "snapshot_ready"]).nullable(),
  expectedJournalDigest: hash.nullable(), requestId: id,
}).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: ConstructorParameters<typeof MaintenanceFailure>[0]): asserts value {
  if (!value) throw new MaintenanceFailure(code, "internal-enter");
}
const recovery = (): MaintenanceResult => ({ status: "recovery_required", lastVerifiedPhase: null,
  blockers: [{ code: "journal_invalid", subjectRef: "db-exact-journal" }] });

async function classifyExisting(store: ArtifactStore, state: StorageMaintenanceState, plan: MigrationPlan,
  request: ContinueRequest, requestDigest: string): Promise<MaintenanceResult> {
  if (!state.journalRecordRef || !state.journalDigest) return recovery();
  let chain;
  try {
    const anchored = await store.readAnchoredJournal({ ref: state.journalRecordRef, sha256: state.journalDigest });
    chain = await verifyJournalChain(store, anchored);
  } catch (error) {
    if (error instanceof MaintenanceFailure && ["journal_invalid", "snapshot_invalid", "control_root_mismatch"].includes(error.code)
      || (error as NodeJS.ErrnoException | null)?.code === "ENOENT") return recovery();
    throw error;
  }
  const head = chain.nodes.at(-1)!;
  if (head.reference.ref !== state.journalRecordRef || head.reference.sha256 !== state.journalDigest
    || head.record.sequence !== state.journalSequence || head.record.fenceEpoch !== state.fenceEpoch
    || head.record.ownerGeneration !== state.ownerGeneration || head.record.migrationId !== state.activeMigrationId
    || head.record.plan.sha256 !== state.planDigest || head.record.source.databaseInstanceId !== state.databaseInstanceId) return recovery();
  // Match the durable idempotency key before comparing the caller's original null expectations
  // with the now-planned head. Replays never rewrite a record or advance the generation.
  const previous = chain.nodes.find(node => node.record.requestId === request.requestId);
  if (previous) requireValue(previous.record.requestDigest === requestDigest, "request_conflict");
  requireValue(same(chain.plan, plan) && same(head.record.plan, request.plan.immutablePlan), "plan_stale");
  if (state.admission !== "draining" || chain.nodes.some(node => node.record.phase !== "planned"
    || !["enter", "takeover", "observation"].includes(node.record.event))) {
    return { status: "blocked", lastVerifiedPhase: null, blockers: [{ code: "phase_conflict", subjectRef: "internal-enter-prefix" }] };
  }
  requireValue(previous, "request_conflict");
  return { status: "paused", phase: "planned", ref: captureReference(head) };
}

/**
 * Trusted internal assembly only: resolver data + a saved-P request, never an adapter, SQL,
 * store, callback or caller-supplied proof. This enters draining or reads the same request's
 * exact planned prefix. It does not drain writers, capture, take over, cancel, or expose a service.
 * A rejected COMMIT/close is not retried here; a later explicit invocation reads the actual anchor.
 */
export async function enterMaintenance(options: MaintenanceServiceOptions, value: ContinueRequest): Promise<MaintenanceResult> {
  const parsed = requestSchema.safeParse(value);
  requireValue(parsed.success, "request_conflict");
  const request = parsed.data, requestDigest = digestJson({ operation: "internal-enter", request });
  const plan = await loadPersistedPlan(request.plan, request.expectedSource);
  const owner = await createControllerOwner(options, plan), { adapter, descriptor } = owner;
  let mutex: OperationMutex | undefined, sourceLock: SourceLock | undefined, result: MaintenanceResult | undefined;
  const failures: unknown[] = [];
  try {
    const observed = await revalidatePlan(plan, options, adapter);
    const initialStore = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
    rememberControllerStore(owner, initialStore);
    // Durable entry consumes the existing platform/FS support policy. A successful fsync on
    // an unsupported filesystem is not qualification; preview/persist alone does not grant it.
    await maintenanceFilesystem(initialStore.root);
    if (descriptor.kind === "sqlite") await maintenanceFilesystem(path.dirname(descriptor.sqlitePath));
    mutex = await adapter.acquireMutex(initialStore.identity, observed.state);
    const heldMutex = mutex;
    result = await adapter.withSourceLock("control", async (lock: SourceLock) => {
      sourceLock = lock;
      // acquireMutex may have committed the first physical root/mutex binding. Read again under
      // the actual source lock; the earlier observation cannot be used as anchor.expected.
      await revalidatePlan(plan, options, adapter);
      const current = await lock.observeSourceClients(), expected = current.state;
      requireValue(same(current.source, plan.source) && same(current.sourceIdentity, plan.sourceIdentity), "source_changed");
      requireValue(current.schemaManifestDigest === plan.schemaManifestDigest && expected.guardManifestDigest === plan.guardManifestDigest, "plan_stale");
      requireValue(expected.controlRootJson === canonicalJson(initialStore.identity)
        && expected.mutexIdentityJson === canonicalJson(heldMutex.identity), "control_root_mismatch");
      const assertCurrent = async () => {
        await heldMutex.assertHeld(); await lock.assertHeld();
        const live = await lock.observeSourceClients();
        requireValue(same(live.state, expected) && same(live.source, plan.source)
          && same(live.sourceIdentity, plan.sourceIdentity) && live.schemaManifestDigest === plan.schemaManifestDigest, "maintenance_lost");
      };
      const store = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource, { assertCurrent });
      rememberControllerStore(owner, store);
      await assertCurrent();
      if (expected.admission !== "open" || expected.journalSequence !== 0) {
        const existing = await classifyExisting(store, expected, plan, request, requestDigest);
        await revalidatePlan(plan, options, adapter); await assertCurrent(); return existing;
      }
      requireValue(request.expectedPhase === null && request.expectedJournalDigest === null, "phase_conflict");
      const fenceEpoch = expected.fenceEpoch + 1, ownerGeneration = expected.ownerGeneration + 1;
      requireValue(Number.isSafeInteger(fenceEpoch) && Number.isSafeInteger(ownerGeneration), "phase_conflict");
      const record = parseJournal({ formatVersion: 2, kind: "journal", migrationId: plan.migrationId, sequence: 1,
        previous: null, phase: "planned", event: "enter", requestId: request.requestId, requestDigest,
        source: plan.source, plan: request.plan.immutablePlan, fenceEpoch, ownerGeneration,
        evidence: [], snapshot: null, sourceClients: null, frozen: null });
      const journal = await store.putJson("journal", record);
      const chain = await verifyJournalChain(store, journal);
      requireValue(chain.nodes.length === 1 && same(chain.nodes[0]!.record, record) && same(chain.plan, plan), "journal_invalid");
      await revalidatePlan(plan, options, adapter); await assertCurrent();
      await lock.anchor({ expected, admission: "draining", fenceEpoch, ownerGeneration,
        activeMigrationId: plan.migrationId, planDigest: request.plan.planDigest, controlRootIdentity: { ...store.identity },
        mutexIdentity: heldMutex.identity, journal, journalSequence: 1 });
      return { status: "paused", phase: "planned", ref: captureReference(chain.nodes[0]!) };
    });
  } catch (error) { recordControllerFailure(owner, failures, error); }
  await finishControllerOwner(owner, mutex, sourceLock, failures, "internal-enter");
  return result!;
}

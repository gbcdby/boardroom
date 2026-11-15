import { z } from "zod";
import path from "node:path";
import { canonicalJson, digestJson } from "./canonical.ts";
import { controlSqlOutcome } from "./control-sql.ts";
import { MaintenanceFailure } from "./error.ts";
import { ArtifactStore } from "./objects.ts";
import { hash, id, ref, source, text } from "./parse-primitives.ts";
import { parseJournal } from "./parse.ts";
import { loadPersistedPlan, revalidatePlan } from "./plan.ts";
import { captureReference, verifyJournalChain } from "./journal.ts";
import { createSqliteMaintenanceAdapter } from "./sqlite.ts";
import { createPostgresMaintenanceAdapter } from "./postgres.ts";
import { postgresDescriptorDigest } from "./postgres-tools.ts";
import { maintenanceFilesystem } from "./platform.ts";
import type { StorageMaintenanceState } from "../admission.ts";
import type { DatabaseDescriptor } from "../../environment.ts";
import type { ContinueRequest, Json, MaintenanceAdapter, MaintenanceResult, MaintenanceServiceOptions, MigrationPlan, OperationMutex, SourceLock } from "./types.ts";

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

interface PendingCleanup { readonly adapter: MaintenanceAdapter; readonly keys: readonly string[]; closing?: Promise<void> }
const pendingCleanups = new Set<PendingCleanup>();
function cleanupKeys(descriptor: DatabaseDescriptor, plan: MigrationPlan): readonly string[] {
  // These copied keys only select a prior owner for cleanup. They never authorize a new
  // source operation; the new adapter must still establish all actual native bindings.
  const keys = [`source:${digestJson(plan.source)}`];
  if (descriptor.kind === "sqlite") {
    keys.push(`sqlite-path:${path.resolve(descriptor.sqlitePath)}`);
    if (descriptor.identity) keys.push(`sqlite-inode:${digestJson(descriptor.identity)}`);
  } else {
    keys.push(`postgres-descriptor:${postgresDescriptorDigest(descriptor)}`);
    const identity = plan.sourceIdentity;
    if (identity && typeof identity === "object" && !Array.isArray(identity)) {
      const values = identity as Readonly<Record<string, Json>>;
      const fields = ["systemIdentifier", "databaseOid", "schemaOid", "serverAddress", "serverPort", "databaseInstanceId"];
      if (values.kind === "postgres" && fields.every(field => Object.hasOwn(values, field))) {
        const physical = Object.fromEntries(fields.map(field => [field, values[field]!]));
        keys.push(`postgres-native:${digestJson(physical)}`);
      }
    }
  }
  return Object.freeze(keys);
}
async function finishPending(owner: PendingCleanup): Promise<void> {
  const attempt = owner.closing ??= Promise.resolve().then(() => owner.adapter.close()).then(() => { pendingCleanups.delete(owner); });
  try { await attempt; } finally { if (owner.closing === attempt) delete owner.closing; }
}

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
  const selected = options.environment.databaseDescriptor;
  const descriptor: DatabaseDescriptor = selected.kind === "sqlite"
    ? { ...selected, identity: selected.identity && { ...selected.identity } } : { ...selected };
  const keys = cleanupKeys(descriptor, plan);
  for (const pending of pendingCleanups) if (keys.some(key => pending.keys.includes(key))) await finishPending(pending);
  const adapter = descriptor.kind === "sqlite" ? await createSqliteMaintenanceAdapter(descriptor)
    : await createPostgresMaintenanceAdapter(descriptor, options.postgresVerification);
  const owner: PendingCleanup = { adapter, keys };
  let mutex: OperationMutex | undefined, sourceLock: SourceLock | undefined, result: MaintenanceResult | undefined;
  const failures: unknown[] = [];
  try {
    const observed = await revalidatePlan(plan, options, adapter);
    const initialStore = await ArtifactStore.open(request.plan.controlRoot, request.expectedSource);
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
  } catch (error) { failures.push(error); }
  // Ordinary anchors expose only bounded lifecycle facts. The outer rejection remains the
  // primary error; record suppressed cleanup stages without reading raw auxiliary errors.
  // A standalone close rejection is already that primary, so do not report it twice.
  try {
    const outcome = sourceLock && controlSqlOutcome(sourceLock);
    if (outcome?.rollbackFailureObserved) failures.push(new MaintenanceFailure("maintenance_lost", "source-rollback-failure"));
    if (outcome?.failureObserved && outcome.closeFailureObserved)
      failures.push(new MaintenanceFailure("maintenance_lost", "source-close-failure"));
  } catch (error) { failures.push(error); }
  // Even when release fails, whole-adapter close is necessary. Never treat a callback value as
  // commit/closure confirmation, or replace an earlier error with a cleanup exception.
  try { await mutex?.release(); } catch (error) { failures.push(error); }
  try { await adapter.close(); } catch (error) { pendingCleanups.add(owner); failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "storage_maintenance: internal-enter cleanup failed", { cause: failures[0] });
  return result!;
}

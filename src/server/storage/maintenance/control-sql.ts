import { canonicalJson, digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { CandidateContents, parseReconstructionInput, type ReconstructionInput } from "./control-candidate/content.ts";
import { readControlJournalCandidate } from "./control-candidate/codec.ts";
import { reconstructControlCandidates, type ExpectedMaintenance, type ReconstructedControls } from "./control-candidate/replay.ts";
import type { SuccessorProof } from "./control-candidate/schema.ts";
import type { ArtifactRef, ControlRootIdentity, MaintenanceAdapter, MigrationPlan, SourceClientRawRow, SourceClientsObservation, SourceLock, SourceObservation } from "./types.ts";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function requireData(condition: unknown): asserts condition { if (!condition) throw new MaintenanceFailure("journal_invalid"); }
const rows = (value: readonly SourceClientRawRow[]) => [...value].sort((a, b) => a.client_id[1] < b.client_id[1] ? -1 : a.client_id[1] > b.client_id[1] ? 1 : 0);

/** Pure fixed SQL intent. Full candidate replay is still supplied data, never a runtime permit. */
export interface ControlSqlPlan {
  readonly source: SourceClientsObservation["source"];
  readonly textEncoding: SourceClientsObservation["textEncoding"];
  readonly schemaManifestDigest: string;
  readonly before: ReconstructedControls;
  readonly after: ReconstructedControls;
  readonly changes: SuccessorProof["changes"];
  readonly previous: ArtifactRef;
  readonly head: ArtifactRef;
  readonly input: ReconstructionInput;
}
function compile(value: unknown): ControlSqlPlan {
  const parsed = parseReconstructionInput(value);
  const input = { ...parsed, mutexIdentity: JSON.parse(canonicalJson(parsed.mutexIdentity)),
    objects: parsed.objects.map(item => ({ reference: { ...item.reference }, bytes: Buffer.from(item.bytes) })) };
  const contents = new CandidateContents(input);
  const node = readControlJournalCandidate(input.head, contents.bytes(input.head, "journal"));
  requireData(node.previous && node.controlProof?.kind === "control-successor");
  const before = reconstructControlCandidates({ ...input, head: node.previous }), after = reconstructControlCandidates(input);
  requireData(before.kind === "untrusted-control-reconstruction" && after.kind === "untrusted-control-reconstruction");
  requireData(node.sequence === Number(before.expectedMaintenance.journalSequence) + 1
    && node.controlProof.beforeRowsDigest === digestJson({ formatVersion: 1, kind: "source-clients-live-rows", source: node.source,
      textEncoding: before.originalRoster.textEncoding, rows: before.expectedRows }));
  return { source: node.source, textEncoding: before.originalRoster.textEncoding, before, after,
    schemaManifestDigest: (contents.json(node.plan, "plan") as unknown as MigrationPlan).schemaManifestDigest,
    changes: node.controlProof.changes, previous: node.previous, head: input.head, input };
}
export function observedControlState(value: SourceClientsObservation): ExpectedMaintenance {
  const state = value.state;
  if (state.admission !== "sealed" || !state.controlRootJson || !state.mutexIdentityJson || !state.activeMigrationId
    || !state.planDigest || !state.journalRecordRef || !state.journalDigest) throw new MaintenanceFailure("source_changed");
  return { singleton: "1", databaseInstanceId: state.databaseInstanceId, admission: "sealed", fenceEpoch: String(state.fenceEpoch),
    ownerGeneration: String(state.ownerGeneration), activeMigrationId: state.activeMigrationId, planDigest: state.planDigest,
    controlRootJson: state.controlRootJson, mutexIdentityJson: state.mutexIdentityJson, protocolVersion: "1", guardManifestDigest: state.guardManifestDigest,
    journalRecordRef: state.journalRecordRef, journalDigest: state.journalDigest, journalSequence: String(state.journalSequence) };
}
function matches(observed: SourceClientsObservation, expected: ReconstructedControls, source: ControlSqlPlan["source"]): boolean {
  return same(observed.source, source) && same(observed.textEncoding, expected.originalRoster.textEncoding)
    && same(observedControlState(observed), expected.expectedMaintenance) && same(rows(observed.rows), expected.expectedRows);
}

/** Adapter-only binding to an existing actual lock. No mechanism caller supplies SQL, handles or callbacks. */
export interface ControlSqlAccess {
  readonly adapter: MaintenanceAdapter;
  readonly root: ControlRootIdentity;
  readonly control: boolean;
  assertHeld(): Promise<void>;
  invalidateFacts(): void;
  observe(): Promise<SourceClientsObservation>;
  manifests(): Promise<SourceObservation>;
  write(plan: ControlSqlPlan): Promise<void>;
  sourceHandleClosed(): boolean;
  mutexHandleClosed(): boolean;
}
interface Attempt {
  plan?: ControlSqlPlan;
  afterValidated: boolean;
  finalValidated: boolean;
  running: boolean;
  settled: Promise<void>;
  committing: boolean;
  committed: boolean;
  failed: boolean;
  rollbackFailed: boolean;
  closeFailed: boolean;
  failure?: unknown;
  rollbackFailure?: unknown;
  closeFailure?: unknown;
  businessDigest?: string;
  schemaDigest?: string;
}
const bindings = new WeakMap<object, ControlSqlAccess>();
const attempts = new WeakMap<object, Attempt>();
// Ordinary locks have no control-SQL Attempt. Retain only bounded phase facts,
// never raw errors or an authorization/validation claim for those locks.
type OrdinaryLifecycle = Pick<Attempt, "committing" | "committed" | "failed" | "rollbackFailed" | "closeFailed">;
const ordinaryLifecycles = new WeakMap<object, OrdinaryLifecycle>();
const callbackClosed = new WeakSet<object>();
export function bindControlSql(lock: SourceLock, access: ControlSqlAccess): void { bindings.set(lock, Object.freeze(access)); }
export function noteControlSql(lock: SourceLock | undefined, stage: "committing" | "committed" | "failure" | "rollback-failure" | "close-failure", error?: unknown): void {
  const attempt = lock && attempts.get(lock);
  if (!attempt) {
    if (!lock || !bindings.has(lock)) return;
    const lifecycle = ordinaryLifecycles.get(lock) ?? {
      committing: false, committed: false, failed: false, rollbackFailed: false, closeFailed: false };
    if (stage === "committing") lifecycle.committing = true;
    else if (stage === "committed") lifecycle.committed = true;
    else if (stage === "failure") lifecycle.failed = true;
    else if (stage === "rollback-failure") lifecycle.rollbackFailed = true;
    else lifecycle.closeFailed = true;
    ordinaryLifecycles.set(lock, lifecycle);
    return;
  }
  if (stage === "committing") attempt.committing = true;
  else if (stage === "committed") attempt.committed = true;
  else if (stage === "failure") { if (!attempt.failed) attempt.failure = error; attempt.failed = true; }
  else if (stage === "rollback-failure") { attempt.rollbackFailure = error; attempt.rollbackFailed = true; }
  else { attempt.closeFailure = error; attempt.closeFailed = true; }
}
export function assertControlSqlCommit(lock: SourceLock): void {
  const attempt = attempts.get(lock);
  if (attempt?.failed) throw attempt.failure;
  if (attempt && (!attempt.afterValidated || !attempt.finalValidated || attempt.running)) throw new MaintenanceFailure("maintenance_lost");
}
/** Close new mechanism entry, and retire an unawaited invocation inside its original transaction before rollback. */
export function finishControlSqlCallback(lock: SourceLock | undefined): Promise<void> | undefined {
  if (!lock) return;
  callbackClosed.add(lock);
  const attempt = attempts.get(lock);
  if (attempt?.running) {
    noteControlSql(lock, "failure", new MaintenanceFailure("maintenance_lost", "unfinished-control-sql"));
    return attempt.settled;
  }
}
/** Existing anchor semantics are unchanged without a mechanism attempt; mixing writes poisons only this attempt. */
export function assertControlSqlAnchorAllowed(lock: SourceLock): void {
  if (!attempts.has(lock)) return;
  const error = new MaintenanceFailure("maintenance_lost", "mixed-control-write");
  noteControlSql(lock, "failure", error);
  throw error;
}
/** Last full observation under the actual lock, after callback entry is closed and before COMMIT is issued. */
export async function validateControlSqlCommit(lock: SourceLock): Promise<void> {
  const attempt = attempts.get(lock), access = bindings.get(lock);
  if (!attempt) return;
  try {
    if (attempt.failed) throw attempt.failure;
    if (!access || !callbackClosed.has(lock) || attempt.running || !attempt.afterValidated || !attempt.plan)
      throw new MaintenanceFailure("maintenance_lost");
    await access.assertHeld();
    const actual = await access.observe(), manifest = await access.manifests();
    if (!matches(actual, attempt.plan.after, attempt.plan.source) || actual.schemaManifestDigest !== attempt.plan.schemaManifestDigest
      || manifest.manifests.schemaManifestDigest !== attempt.schemaDigest
      || manifest.manifests.frozenBusinessManifestDigest !== attempt.businessDigest) throw new MaintenanceFailure("source_changed");
    await access.assertHeld();
    if (attempt.failed) throw attempt.failure;
    attempt.finalValidated = true;
  } catch (error) { noteControlSql(lock, "failure", error); throw error; }
}

/** Isolated mechanism only: no production caller, publication, registration or authority transition. */
export async function applyUntrustedControlSql(lock: SourceLock, input: unknown): Promise<Readonly<{ kind: "untrusted-control-transaction-view"; observation: SourceClientsObservation }>> {
  const access = bindings.get(lock);
  if (!access?.control || callbackClosed.has(lock) || attempts.has(lock)) {
    const error = new MaintenanceFailure("maintenance_lost"), prior = attempts.get(lock);
    if (prior && !prior.failed) { prior.failure = error; prior.failed = true; }
    throw error;
  }
  let settle!: () => void;
  const attempt: Attempt = { afterValidated: false, finalValidated: false, running: true, settled: new Promise<void>(resolve => { settle = resolve; }),
    committing: false, committed: false, failed: false, rollbackFailed: false, closeFailed: false }; attempts.set(lock, attempt);
  try {
    await access.assertHeld();
    if (attempt.failed) throw attempt.failure;
    const plan = compile(input); attempt.plan = plan;
    const before = await access.observe(), manifest = await access.manifests();
    attempt.businessDigest = manifest.manifests.frozenBusinessManifestDigest;
    attempt.schemaDigest = manifest.manifests.schemaManifestDigest;
    if (!same(access.root, plan.input.controlRoot) || before.schemaManifestDigest !== plan.schemaManifestDigest
      || !matches(before, plan.before, plan.source)) throw new MaintenanceFailure("source_changed");
    await access.assertHeld();
    if (attempt.failed) throw attempt.failure;
    access.invalidateFacts();
    await access.write(plan);
    await access.assertHeld();
    const after = await access.observe(), final = await access.manifests();
    if (!matches(after, plan.after, plan.source) || before.schemaManifestDigest !== after.schemaManifestDigest
      || manifest.manifests.schemaManifestDigest !== final.manifests.schemaManifestDigest
      || manifest.manifests.frozenBusinessManifestDigest !== final.manifests.frozenBusinessManifestDigest) throw new MaintenanceFailure("source_changed");
    attempt.afterValidated = true;
    return Object.freeze({ kind: "untrusted-control-transaction-view", observation: after });
  } catch (error) { noteControlSql(lock, "failure", error); throw error; }
  finally { attempt.running = false; settle(); }
}

export interface ControlSqlOutcome {
  readonly kind: "untrusted-control-outcome";
  readonly status: "unknown" | "source-transaction-completed";
  readonly localSourceHandleClosed?: boolean;
  readonly localMutexHandleClosed?: boolean;
  readonly afterValidated?: boolean;
  readonly finalValidated?: boolean;
  readonly commitStarted?: boolean;
  readonly commitReturned?: boolean;
  readonly failureObserved?: boolean;
  readonly rollbackFailureObserved?: boolean;
  readonly closeFailureObserved?: boolean;
  readonly originalError?: unknown;
  readonly rollbackError?: unknown;
  readonly closeError?: unknown;
}
/** This reports the actual outer lifecycle. A transaction-local view alone is never committed. */
export function controlSqlOutcome(lock: SourceLock): Readonly<ControlSqlOutcome> {
  const access = bindings.get(lock), attempt = attempts.get(lock);
  if (!access) return Object.freeze({ kind: "untrusted-control-outcome" as const, status: "unknown" as const });
  if (!attempt) {
    const lifecycle = ordinaryLifecycles.get(lock);
    if (!lifecycle) return Object.freeze({ kind: "untrusted-control-outcome" as const, status: "unknown" as const });
    return Object.freeze({ kind: "untrusted-control-outcome" as const, status: "unknown" as const,
      localSourceHandleClosed: access.sourceHandleClosed(), localMutexHandleClosed: access.mutexHandleClosed(),
      commitStarted: lifecycle.committing, commitReturned: lifecycle.committed, failureObserved: lifecycle.failed,
      rollbackFailureObserved: lifecycle.rollbackFailed, closeFailureObserved: lifecycle.closeFailed });
  }
  const sourceClosed = access.sourceHandleClosed(), mutexClosed = access.mutexHandleClosed();
  return Object.freeze({ kind: "untrusted-control-outcome" as const,
    status: attempt.finalValidated && attempt.committed && sourceClosed && !attempt.failed && !attempt.rollbackFailed && !attempt.closeFailed
      ? "source-transaction-completed" as const : "unknown" as const,
    localSourceHandleClosed: sourceClosed, localMutexHandleClosed: mutexClosed, afterValidated: attempt.afterValidated, finalValidated: attempt.finalValidated, commitStarted: attempt.committing,
    commitReturned: attempt.committed, failureObserved: attempt.failed, rollbackFailureObserved: attempt.rollbackFailed, closeFailureObserved: attempt.closeFailed,
    originalError: attempt.failure, rollbackError: attempt.rollbackFailure, closeError: attempt.closeFailure });
}

/** Re-observation only, no retry/write. Retired actual local handles precede a NEW real mutex and source-lock acquisition.
 * For PG, socket close alone is not a server transaction/lock release claim: both new server lock grants are required. */
export async function resolveUntrustedControlSql(adapter: MaintenanceAdapter, oldLock: SourceLock, currentInput?: unknown) {
  const access = bindings.get(oldLock), attempt = attempts.get(oldLock), plan = attempt?.plan;
  const unknown = (reason: string, error?: unknown) => Object.freeze({ kind: "untrusted-control-resolution" as const, classification: "unknown" as const, reason, error });
  if (!access || !plan || !access.sourceHandleClosed() || !access.mutexHandleClosed())
    return unknown("old-local-handle-exit-unproven");
  let mutex: Awaited<ReturnType<MaintenanceAdapter["acquireMutex"]>> | undefined, fresh: SourceLock | undefined;
  let result: Readonly<{ kind: "untrusted-control-resolution"; classification: "observed-committed" | "observed-uncommitted" | "observed-legal-successor" }> | undefined;
  let error: unknown, failed = false;
  try {
    const observed = await adapter.observe();
    if (!same(observed.source, plan.source)) throw new MaintenanceFailure("source_changed");
    mutex = await adapter.acquireMutex(access.root, observed.state);
    result = await adapter.withSourceLock("control", async lock => {
      fresh = lock;
      const actual = await lock.observeSourceClients();
      if (actual.schemaManifestDigest !== plan.schemaManifestDigest || (await lock.observe()).manifests.frozenBusinessManifestDigest !== attempt.businessDigest)
        throw new MaintenanceFailure("source_changed");
      if (matches(actual, plan.after, plan.source)) return Object.freeze({ kind: "untrusted-control-resolution", classification: "observed-committed" });
      if (matches(actual, plan.before, plan.source)) return Object.freeze({ kind: "untrusted-control-resolution", classification: "observed-uncommitted" });
      const proof = parseReconstructionInput(currentInput), contents = new CandidateContents(proof);
      const expected = reconstructControlCandidates(proof);
      requireData(expected.kind === "untrusted-control-reconstruction" && same(proof.controlRoot, plan.input.controlRoot)
        && same(proof.mutexIdentity, plan.input.mutexIdentity) && Number(expected.expectedMaintenance.journalSequence) > Number(plan.before.expectedMaintenance.journalSequence));
      // The observed head must contain the exact prior anchor, not merely a greater sequence or an available file.
      let reference: ArtifactRef | null = proof.head; let found = false;
      while (reference) {
        if (same(reference, plan.previous)) { found = true; break; }
        const value = contents.json(reference, "journal") as { previous: ArtifactRef | null };
        reference = value.previous;
      }
      requireData(found && matches(actual, expected, plan.source));
      return Object.freeze({ kind: "untrusted-control-resolution", classification: "observed-legal-successor" });
    });
  } catch (failure) { error = failure; failed = true; }
  finally { try { await mutex?.release(); } catch (failure) { if (!failed) error = failure; failed = true; } }
  const current = fresh && bindings.get(fresh);
  if (failed || !result || !current?.sourceHandleClosed() || !current.mutexHandleClosed()) return unknown("fresh-observation-or-close-unproven", error);
  return result;
}

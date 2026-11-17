import { canonicalJson, digestJson } from "./canonical.ts";
import { notePendingControllerOperationFailure } from "./control-sql.ts";
import { assertControllerCommandWindow, assertControllerLockCompleted, type ControllerCommandScope } from "./controller-write.ts";
import { supportedEncoding } from "./control-candidate/rows.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifyRestoreBundleClosure } from "./journal.ts";
import { ArtifactStore } from "./objects.ts";
import { parseReceipt, parseVerification } from "./parse.ts";
import { publishSnapshotBundle } from "./snapshot-bundle.ts";
import { assertCapturedSourceClientBinding } from "./source-client-binding.ts";
import { verifyLiveSourceFiles, verifyLiveSourceFilesReadOnly } from "./source-files.ts";
import { assertReadySnapshotBinding, restoreAnchoredSnapshot, verifyRestoreBundle } from "./verify-bundle.ts";
import { assertVerificationSourceClientBinding, replayConsumerSourceControls } from "./verification-source-client-binding.ts";
import type { ArtifactRef, BlockerCode, MaintenanceRef, SnapshotReceipt, SourceLock } from "./types.ts";

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: BlockerCode = "maintenance_lost"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "controller-restore");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
type Window = Awaited<ReturnType<typeof assertControllerCommandWindow>>;
interface BaseRestore { readonly lock: SourceLock; readonly head: ArtifactRef }
type OwnedRestore = BaseRestore & (
  | { readonly kind: "ready"; readonly bundle: ArtifactRef; readonly publication: ArtifactRef; readonly verification: ArtifactRef }
  | { readonly kind: "legacy-ready-bridge"; readonly ready: ArtifactRef; readonly receipt: ArtifactRef; readonly manifests: ArtifactRef }
);
const restores = new WeakMap<ControllerCommandScope, OwnedRestore>();
const failures = new WeakMap<ControllerCommandScope, unknown>();
interface RestoreOperation {
  readonly scope: ControllerCommandScope;
  readonly lock: SourceLock;
  readonly promise: Promise<unknown>;
  failed: boolean;
  failure?: unknown;
  failureOrder: number;
  retainFailure?: boolean;
  callbackFailed?: boolean;
  callbackFailureRetained?: boolean;
  returnedChild?: RestoreOperation;
  joinedChild?: RestoreOperation;
}
interface RestoreLockLifetime {
  closed: boolean;
  readonly pending: Set<RestoreOperation>;
  failureOrder: number;
  closeFailure?: MaintenanceFailure;
  barrier?: Promise<void>;
}
const operations = new WeakMap<ControllerCommandScope, RestoreOperation>();
const callbacks = new WeakMap<ControllerCommandScope, RestoreOperation>();
const lockLifetimes = new WeakMap<SourceLock, RestoreLockLifetime>();

function assertValid(scope: ControllerCommandScope): void {
  if (failures.has(scope)) throw failures.get(scope);
}
function fail(scope: ControllerCommandScope, error: unknown): void {
  restores.delete(scope);
  if (!failures.has(scope)) failures.set(scope, error);
}
function lockLifetime(lock: SourceLock): RestoreLockLifetime {
  let state = lockLifetimes.get(lock);
  if (!state) { state = { closed: false, pending: new Set(), failureOrder: 0 }; lockLifetimes.set(lock, state); }
  return state;
}
function assertOpen(scope: ControllerCommandScope, lock: SourceLock): void {
  assertValid(scope);
  const state = lockLifetime(lock);
  if (state.closed) {
    state.closeFailure ??= new MaintenanceFailure("maintenance_lost", "controller-restore");
    fail(scope, state.closeFailure); throw state.closeFailure;
  }
}
/** Register before work can yield. Failure occurrence is separate from its value,
 * so throw undefined and an already observed failure remain sticky. */
function track<T>(scope: ControllerCommandScope, lock: SourceLock,
  owner: WeakMap<ControllerCommandScope, RestoreOperation>, work: () => Promise<T>): Promise<T> {
  try {
    assertOpen(scope, lock); requireValue(!owner.has(scope) && !operations.has(scope));
    const parent = callbacks.get(scope); requireValue(!parent || parent.lock === lock);
  } catch (error) { fail(scope, error); return Promise.reject(error); }
  const state = lockLifetime(lock);
  let tracked!: RestoreOperation;
  const operation = Promise.resolve().then(() => { assertOpen(scope, lock); return work(); }).then(value => {
    assertOpen(scope, lock); return value;
  }).catch(error => {
    tracked.failed = true; tracked.failure = error; tracked.failureOrder = ++state.failureOrder;
    const childPropagation = tracked.returnedChild?.failed && tracked.returnedChild.retainFailure
      || !tracked.callbackFailed && tracked.joinedChild?.failed && tracked.joinedChild.retainFailure;
    if (tracked.retainFailure && !tracked.callbackFailureRetained && !childPropagation && error !== state.closeFailure)
      notePendingControllerOperationFailure(lock, operation, error);
    fail(scope, error);
    throw error;
  }).finally(() => {
    if (owner.get(scope) === tracked) owner.delete(scope);
    state.pending.delete(tracked);
  });
  tracked = { scope, lock, promise: operation, failed: false, failureOrder: 0 };
  owner.set(scope, tracked); state.pending.add(tracked);
  // Observe a forgotten rejection without replacing the original returned
  // Promise or the rejection retained by the source-close barrier.
  void operation.catch(() => undefined);
  return operation;
}
function exclusive<T>(scope: ControllerCommandScope, lock: SourceLock, work: () => Promise<T>): Promise<T> {
  return track(scope, lock, operations, work);
}

/** Mark only operations still owned at the adapter's failed callback exit.
 * Their actual catch records the occurrence before the original Promise retires.
 * A settled barrier that supplied the outer first error is not added again. */
export function retainPendingControllerRestoreFailures(lock: SourceLock | undefined): void {
  if (!lock) return;
  for (const operation of lockLifetime(lock).pending) operation.retainFailure = true;
}

/** Fixed adapter close-entry. Closing admission is synchronous, before awaiting
 * every original parent/child operation. Repeated cleanup gets the same barrier.
 * A pending operation that later resolves still cannot authorize COMMIT. */
export function finishControllerRestoreCallback(lock: SourceLock | undefined): Promise<void> | undefined {
  if (!lock) return undefined;
  const state = lockLifetime(lock); state.closed = true;
  if (state.barrier) return state.barrier;
  if (!state.pending.size) return undefined;
  state.closeFailure ??= new MaintenanceFailure("maintenance_lost", "controller-restore");
  const pending = [...state.pending];
  for (const operation of pending) fail(operation.scope, state.closeFailure);
  state.barrier = Promise.allSettled(pending.map(operation => operation.promise)).then(() => {
    const rejected = pending.filter(operation => operation.failed).sort((left, right) => left.failureOrder - right.failureOrder);
    // This private marker is one synchronous close event. Its known propagation
    // through child and awaiting parent is not a second cleanup occurrence.
    // Do not apply value-based deduplication to any raw callback/native errors.
    if (rejected.length && rejected.every(operation => operation.failure === state.closeFailure)) throw state.closeFailure;
    const first = rejected[0];
    if (first && rejected.length === 1) throw first.failure;
    if (first) throw new AggregateError(rejected.map(operation => operation.failure),
      "storage_maintenance: controller restore callback failed", { cause: first.failure });
    throw state.closeFailure;
  });
  void state.barrier.catch(() => undefined);
  return state.barrier;
}

/** Trusted fixed guard assembly only. This owns the complete callback lifetime,
 * including gaps between assertions; it issues no restore permit or references.
 * Child restore/check entries use the same original lock and remain individually
 * exclusive. Nothing supplied by a caller is installed as an owned Promise. */
export function withControllerRestoreCallback<T>(scope: ControllerCommandScope, lock: SourceLock,
  callback: () => Promise<T>): Promise<T> {
  return track(scope, lock, callbacks, async () => {
    const context = await currentWindow(scope, lock);
    requireValue(context.kind === "snapshot");
    const parent = callbacks.get(scope)!;
    const errors: unknown[] = [];
    let result: { value: T } | undefined;
    try {
      const returned = callback(), child = operations.get(scope);
      if (child?.promise === returned) parent.returnedChild = child;
      result = { value: await returned };
    } catch (error) {
      parent.callbackFailed = true; errors.push(error);
      // The original returned child Promise is a known propagation edge. A
      // separately thrown equal value, including undefined, is a new event.
      if (parent.retainFailure && !(parent.returnedChild?.failed && parent.returnedChild.retainFailure)
        && error !== lockLifetime(lock).closeFailure) {
        notePendingControllerOperationFailure(lock, parent.promise, error); parent.callbackFailureRetained = true;
      }
    }
    const child = operations.get(scope);
    if (child) {
      parent.joinedChild = child;
      try { await child.promise; } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "storage_maintenance: controller restore consumer failed", { cause: errors[0] });
    await currentWindow(scope, lock, context);
    requireValue(result); return result.value;
  });
}
async function currentWindow(scope: ControllerCommandScope, lock: SourceLock, initial?: Window): Promise<Window> {
  assertOpen(scope, lock);
  const window = await assertControllerCommandWindow(scope, lock);
  assertOpen(scope, lock);
  requireValue(window.head && window.chain && window.observation.state.admission === "sealed", "phase_conflict");
  requireValue(window.command.operation !== "cancel-migration"
    && !window.chain.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)), "phase_conflict");
  if (initial) requireValue(same(window.head, initial.head) && same(window.observation, initial.observation), "source_changed");
  return window;
}

/** New selected capture: the original snapshot lock actually produces D/B/U and
 * restores database/files before V. No references or reusable permit cross this
 * entry; only its private original-scope/original-lock association is retained. */
export function prepareControllerSnapshot(scope: ControllerCommandScope, lock: SourceLock): Promise<void> {
  return exclusive(scope, lock, async () => {
    requireValue(!restores.has(scope));
    const context = await currentWindow(scope, lock), head = context.chain!.nodes.at(-1)!;
    requireValue(context.prefix.status === "new", "request_conflict");
    requireValue(context.kind === "snapshot" && head.record.formatVersion !== 1
      && head.record.event === "capture" && head.record.phase === "quiesced" && head.record.frozen, "phase_conflict");
    const frozen = head.record.frozen;
    const completed = await lock.withSourceClientFacts(context.command.request.plan, async facts => {
      assertOpen(scope, lock);
      requireValue(same(facts.observation, context.observation) && same(facts.origin.head, context.head), "source_changed");
      await verifyLiveSourceFiles(context.store, lock, context.mutex, context.command.request.plan, frozen.sourceFilesManifest);
      await facts.assertCurrent();
      const bundle = await publishSnapshotBundle(context.store, lock);
      const verification = await verifyRestoreBundle(context.store, context.adapter, lock, bundle.bundle, bundle.publication);
      await verifyLiveSourceFiles(context.store, lock, context.mutex, context.command.request.plan, frozen.sourceFilesManifest);
      await currentWindow(scope, lock, context); await facts.assertCurrent();
      return freeze({ ...bundle, verification });
    });
    await currentWindow(scope, lock, context);
    restores.set(scope, { kind: "ready", lock, head: context.head!, ...completed });
  });
}

export interface ControllerReadyView {
  readonly receipt: SnapshotReceipt;
  readonly receiptRef: ArtifactRef;
  readonly ref: MaintenanceRef;
  /** Original command and lock only. A failed check remains failed, even after
   * callback code catches the error or the source appears unchanged again. */
  assertCurrent(): Promise<void>;
}

async function readyWindow(scope: ControllerCommandScope, lock: SourceLock, mode: "read-only" | "restore"): Promise<ControllerReadyView> {
  const context = await currentWindow(scope, lock);
  requireValue(mode === "read-only" || context.prefix.status === "new", "request_conflict");
  requireValue(mode === "read-only" || context.kind === "snapshot", "phase_conflict");
  const initial = await assertReadySnapshotBinding(context.store, lock);
  const check = async () => {
    await currentWindow(scope, lock, context);
    await initial.assertCurrent();
  };
  const inspectFiles = mode === "read-only" ? verifyLiveSourceFilesReadOnly : verifyLiveSourceFiles;
  const checkRuntime = async () => {
    await lock.withSourceClientFacts(context.command.request.plan, async facts => {
      requireValue(same(facts.observation, context.observation) && same(facts.origin.head, context.head), "source_changed");
      await check();
      await inspectFiles(context.store, lock, context.mutex, context.command.request.plan, initial.snapshot.receipt.sourceFilesManifest);
      await facts.assertCurrent(); await check();
    });
  };
  await checkRuntime();
  if (mode === "restore") {
    // The snapshot lock and command remain original and held. N07 opens its own
    // actual native facts lease; it cannot be nested inside a consumer lease.
    const restored = await restoreAnchoredSnapshot(context.store, context.adapter, lock);
    requireValue(same(restored.snapshot, initial.snapshot), "snapshot_invalid");
    await checkRuntime();
  }
  await check();
  const snapshot = initial.snapshot, first = snapshot.chain.nodes.find(node => node.record.event === "capture")!;
  const head = snapshot.chain.nodes.at(-1)!, ready = snapshot.chain.nodes.find(node => node.record.event === "ready")!;
  // A later v2 recapture or legacy PG encoding remains a valid legacy consume
  // result, but it never silently acquires the optional bridge authority.
  if (mode === "restore" && head.record.formatVersion === 2 && first.record.formatVersion === 2
    && first.record.sourceClients && supportedEncoding(first.record.sourceClients.textEncoding)
    && same(snapshot.receipt.capture.journal, first.reference)) {
    requireValue(same(context.observation.rows, first.record.sourceClients.rows), "source_changed");
    restores.set(scope, { kind: "legacy-ready-bridge", lock, head: context.head!,
      ready: freeze({ ...ready.reference }), receipt: freeze({ ...snapshot.receiptRef }), manifests: freeze({ ...snapshot.receipt.manifests }) });
  }
  return freeze({ receipt: snapshot.receipt, receiptRef: snapshot.receiptRef, ref: captureReference(head),
    assertCurrent() { return exclusive(scope, lock, checkRuntime); } });
}

/** New-owner actual restore. Historical V is read as evidence, never as an
 * executed restore. Any legacy bridge association is issued only after this
 * operation and its original snapshot transaction have really completed. */
export function revalidateControllerReady(scope: ControllerCommandScope, lock: SourceLock): Promise<ControllerReadyView> {
  return exclusive(scope, lock, () => readyWindow(scope, lock, "restore"));
}

/** Same-key diagnostics: full bytes/native/current Fs, zero target or attempt
 * creation. This path never installs restore authorization in the private table. */
export function assertControllerReadyCurrent(scope: ControllerCommandScope, lock: SourceLock): Promise<ControllerReadyView> {
  return exclusive(scope, lock, () => readyWindow(scope, lock, "read-only"));
}

export type ControllerRestoreAuthorization =
  | Readonly<{ kind: "ready"; receipt: ArtifactRef }>
  | Readonly<{ kind: "legacy-ready-bridge"; ready: ArtifactRef; receipt: ArtifactRef; manifests: ArtifactRef }>;

/** Fixed writer-only consumption. The caller supplies no bundle, verification,
 * receipt, callback or success flag. Original snapshot COMMIT/close and a fresh
 * exact control window are mandatory before any R or bridge output is returned. */
export function consumeControllerRestoreAuthorization(scope: ControllerCommandScope, lock: SourceLock,
  kind: "ready" | "legacy-ready-bridge"): Promise<ControllerRestoreAuthorization> {
  return exclusive(scope, lock, async () => {
    const owned = restores.get(scope); restores.delete(scope);
    requireValue(owned && owned.kind === kind && owned.lock !== lock);
    assertControllerLockCompleted(scope, owned.lock);
    const context = await currentWindow(scope, lock);
    requireValue(context.prefix.status === "new", "request_conflict");
    requireValue(context.kind === "control" && same(context.head, owned.head));
    if (owned.kind === "legacy-ready-bridge") {
      const binding = await assertReadySnapshotBinding(context.store, lock);
      requireValue(same(binding.snapshot.receiptRef, owned.receipt)
        && same(binding.snapshot.receipt.manifests, owned.manifests)
        && same(binding.snapshot.chain.nodes.find(node => node.record.event === "ready")?.reference, owned.ready), "snapshot_invalid");
      await lock.withSourceClientFacts(context.command.request.plan, async facts => {
        requireValue(same(facts.observation, context.observation), "source_changed");
        await verifyLiveSourceFiles(context.store, lock, context.mutex, context.command.request.plan, binding.snapshot.receipt.sourceFilesManifest);
        await binding.assertCurrent(); await facts.assertCurrent(); await currentWindow(scope, lock, context);
      });
      return freeze({ kind: "legacy-ready-bridge", ready: owned.ready, receipt: owned.receipt, manifests: owned.manifests });
    }
    const fixed = { bundle: owned.bundle, publication: owned.publication, verification: owned.verification };
    const closure = await verifyRestoreBundleClosure(context.store, fixed.bundle, fixed.publication);
    const selected = context.chain!.nodes.at(-1)!;
    requireValue(selected.record.formatVersion !== 1 && selected.record.sourceClients && selected.record.event === "capture"
      && selected.record.phase === "quiesced" && same(closure.bundle.capture.journal, context.head), "phase_conflict");
    const captured = selected.record.sourceClients;
    const verification = parseVerification(await context.store.readJson(fixed.verification, "verification"));
    requireValue(same(verification.bundle, fixed.bundle) && same(verification.publication, fixed.publication), "snapshot_invalid");
    const initial = await lock.observe();
    requireValue(same(initial.manifests, closure.manifests), "source_changed");
    const replay = selected.record.formatVersion === 3
      ? await replayConsumerSourceControls(context.store, context.chain!, context.mutex.identity) : null;
    const assertCurrent = async () => {
      await currentWindow(scope, lock, context);
      requireValue(same(await lock.observe(), initial), "source_changed");
      if (replay) await assertVerificationSourceClientBinding(lock, initial, selected, closure.manifests, replay);
      else await assertCapturedSourceClientBinding(lock, initial, captured, closure.manifests);
      await verifyRestoreBundleClosure(context.store, fixed.bundle, fixed.publication);
      requireValue(same(parseVerification(await context.store.readJson(fixed.verification, "verification")), verification), "snapshot_invalid");
    };
    const receipt = await lock.withSourceClientFacts(context.command.request.plan, async facts => {
      requireValue(same(facts.observation, context.observation), "source_changed");
      await assertCurrent();
      await verifyLiveSourceFiles(context.store, lock, context.mutex, context.command.request.plan, closure.bundle.sourceFilesManifest);
      const guarded = await ArtifactStore.open(context.store.root, initial.source, { assertCurrent: async () => {
        await context.mutex.assertHeld(); await lock.assertHeld(); assertValid(scope);
      } });
      requireValue(same(guarded.identity, context.store.identity), "control_root_mismatch");
      const body = parseReceipt({ formatVersion: 1, kind: "receipt",
        snapshotId: digestJson({ requestDigest: context.requestDigest, capture: closure.bundle.capture, input: fixed }),
        capture: closure.bundle.capture, restorePointDigest: closure.bundle.restorePointDigest,
        sourceFilesManifest: closure.bundle.sourceFilesManifest, ...fixed,
        database: closure.databaseRef, manifests: closure.manifestsRef, capability: closure.capabilityRef,
        schemaManifestDigest: closure.manifests.schemaManifestDigest, fullDataManifestDigest: closure.manifests.fullDataManifestDigest,
        frozenBusinessManifestDigest: closure.manifests.frozenBusinessManifestDigest,
        capturedControlManifestDigest: closure.manifests.capturedControlManifestDigest });
      const reference = await guarded.putJson("receipt", body); await guarded.confirmDurable(reference);
      requireValue(same(parseReceipt(await guarded.readJson(reference, "receipt")), body), "snapshot_invalid");
      await verifyLiveSourceFiles(context.store, lock, context.mutex, context.command.request.plan, closure.bundle.sourceFilesManifest);
      await assertCurrent(); await facts.assertCurrent();
      return reference;
    });
    await assertCurrent();
    return freeze({ kind: "ready", receipt });
  });
}

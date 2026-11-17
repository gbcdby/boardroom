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
const failures = new WeakMap<ControllerCommandScope, { readonly error: unknown; readonly operation: RestoreOperation | undefined }>();
type RestoreRole = "restore" | "callback" | "checking" | "consumer";
interface RestoreFailureOccurrence {
  readonly error: unknown;
  readonly order: number;
  readonly closeInduced: boolean;
}
interface RestoreOperation {
  readonly scope: ControllerCommandScope;
  readonly lock: SourceLock;
  readonly promise: Promise<unknown>;
  readonly role: RestoreRole;
  readonly parent: RestoreOperation | undefined;
  readonly children: Set<RestoreOperation>;
  failed: boolean;
  failure?: unknown;
  failures?: readonly RestoreFailureOccurrence[];
  retainFailure?: boolean;
  callbackClosed?: boolean;
  forwarded?: RestoreOperation;
  consumer?: RestoreOperation;
  checking?: RestoreOperation;
}
interface RestoreLockLifetime {
  closed: boolean;
  readonly pending: Set<RestoreOperation>;
  failureOrder: number;
  closeFailure?: MaintenanceFailure;
  closeOccurrence?: RestoreFailureOccurrence;
  barrier?: Promise<void>;
}
const operations = new WeakMap<ControllerCommandScope, RestoreOperation>();
const callbacks = new WeakMap<ControllerCommandScope, RestoreOperation>();
const originalOperations = new WeakMap<Promise<unknown>, RestoreOperation>();
const lockLifetimes = new WeakMap<SourceLock, RestoreLockLifetime>();

function assertValid(scope: ControllerCommandScope): void {
  const failure = failures.get(scope);
  if (failure) throw failure.error;
}
function fail(scope: ControllerCommandScope, error: unknown, operation?: RestoreOperation): void {
  restores.delete(scope);
  if (!failures.has(scope)) failures.set(scope, { error, operation });
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
function orderedFailures(values: readonly RestoreFailureOccurrence[]): readonly RestoreFailureOccurrence[] {
  // These are private occurrence objects. Equal raw errors are never keys.
  const actual = [...new Set(values)].sort((left, right) => left.order - right.order);
  return actual.some(value => !value.closeInduced) ? actual.filter(value => !value.closeInduced) : actual;
}
function ownFailure(operation: RestoreOperation, error: unknown): RestoreFailureOccurrence {
  const state = lockLifetime(operation.lock);
  if (state.closeFailure && error === state.closeFailure)
    return state.closeOccurrence ??= { error, order: ++state.failureOrder, closeInduced: true };
  return { error, order: ++state.failureOrder, closeInduced: false };
}
function retainFailures(operation: RestoreOperation, observed: readonly RestoreFailureOccurrence[]): void {
  operation.failures = orderedFailures(observed);
  if (operation.retainFailure) for (const occurrence of operation.failures)
    if (!occurrence.closeInduced) notePendingControllerOperationFailure(operation.lock, occurrence, occurrence.error);
}
function throwFailures(observed: readonly RestoreFailureOccurrence[]): never {
  const failures = orderedFailures(observed), first = failures[0];
  requireValue(first);
  if (failures.length === 1) throw first.error;
  throw new AggregateError(failures.map(value => value.error),
    "storage_maintenance: controller restore callback failed", { cause: first.error });
}
function parentFor(scope: ControllerCommandScope, role: RestoreRole): RestoreOperation | undefined {
  const root = callbacks.get(scope);
  if (role === "callback") { requireValue(!root); return undefined; }
  if (role === "consumer") { requireValue(root && !root.consumer && !root.checking); return root; }
  const parent = root?.consumer ?? root;
  if (role === "checking") { requireValue(parent && !parent.checking); return parent; }
  return parent?.checking ?? parent;
}
/** Every fixed boundary creates and registers its original Promise before its
 * first action. There is no API for registering a supplied Promise or owner. */
function track<T>(scope: ControllerCommandScope, lock: SourceLock, role: RestoreRole,
  work: (operation: RestoreOperation) => Promise<T>): Promise<T> {
  let parent: RestoreOperation | undefined;
  try {
    assertOpen(scope, lock); requireValue(!operations.has(scope)); parent = parentFor(scope, role);
    requireValue(!parent || parent.lock === lock && !parent.callbackClosed);
  } catch (error) {
    const state = lockLifetime(lock);
    // A fixed child factory can reject admission after its original parent has
    // yielded. Preserve that original rejection for forwarding, without running
    // work, joining pending operations or reopening a closed entry.
    if (!parent) { try { parent = parentFor(scope, role); } catch { /* No original parent relationship. */ } }
    if (parent && parent.lock === lock && !parent.callbackClosed && state.pending.has(parent)) {
      const rejected = Promise.reject<T>(error);
      const tracked: RestoreOperation = { scope, lock, promise: rejected, role, parent,
        children: new Set(), failed: true, failure: error, retainFailure: parent.retainFailure === true };
      retainFailures(tracked, failures.get(scope)?.operation?.failures ?? [ownFailure(tracked, error)]);
      originalOperations.set(rejected, tracked); parent.children.add(tracked);
      fail(scope, error, tracked); void rejected.catch(() => undefined); return rejected;
    }
    fail(scope, error); return Promise.reject(error);
  }
  const state = lockLifetime(lock);
  let tracked!: RestoreOperation;
  const operation: Promise<T> = Promise.resolve().then(() => { assertOpen(scope, lock); return work(tracked); }).then(value => {
    assertOpen(scope, lock); return value;
  }).catch(error => {
    tracked.failed = true; tracked.failure = error;
    if (!tracked.failures) retainFailures(tracked, tracked.forwarded?.failures ?? [ownFailure(tracked, error)]);
    fail(scope, error, tracked); throw error;
  }).finally(() => {
    if (operations.get(scope) === tracked) operations.delete(scope);
    if (callbacks.get(scope) === tracked) callbacks.delete(scope);
    if (parent?.consumer === tracked) delete parent.consumer;
    if (parent?.checking === tracked) delete parent.checking;
    state.pending.delete(tracked);
  });
  tracked = { scope, lock, promise: operation, role, parent, children: new Set(), failed: false };
  originalOperations.set(operation, tracked); state.pending.add(tracked); parent?.children.add(tracked);
  if (role === "restore") operations.set(scope, tracked);
  else if (role === "callback") callbacks.set(scope, tracked);
  else if (role === "consumer") parent!.consumer = tracked;
  else parent!.checking = tracked;
  void operation.catch(() => undefined);
  return operation;
}
function exclusive<T>(scope: ControllerCommandScope, lock: SourceLock, work: () => Promise<T>): Promise<T> {
  return track(scope, lock, "restore", work);
}

/** Terminal forwarding in fixed trusted code. A supplied error, id, success
 * flag or foreign Promise cannot declare provenance. Closing admission does not
 * rewrite an already owned rejection; retired parents cannot forward again. */
export function forwardControllerRestoreFailure(scope: ControllerCommandScope, lock: SourceLock,
  original: Promise<unknown>): never {
  const child = originalOperations.get(original), parent = child?.parent, state = lockLifetime(lock);
  requireValue(child && child.scope === scope && child.lock === lock && child.failed && child.failures
    && parent && parent.scope === scope && parent.lock === lock && state.pending.has(parent));
  parent.forwarded = child;
  if (parent.retainFailure) for (const occurrence of child.failures)
    if (!occurrence.closeInduced) notePendingControllerOperationFailure(lock, occurrence, occurrence.error);
  throw child.failure;
}

/** Mark only original operations pending at the failed source callback exit. */
export function retainPendingControllerRestoreFailures(lock: SourceLock | undefined): void {
  if (!lock) return;
  for (const operation of lockLifetime(lock).pending) {
    operation.retainFailure = true;
    if (operation.failures) retainFailures(operation, operation.failures);
  }
}

/** Callback invocation and its actual children share the existing lock barrier.
 * Independent callback errors are recorded where caught, before joining children.
 * Explicit forwarding preserves the child's occurrence through async adoption. */
async function invokeCallback<T>(operation: RestoreOperation, callback: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined, returnedChild: RestoreOperation | undefined;
  const observed: RestoreFailureOccurrence[] = [];
  try {
    const returned = callback(), child = originalOperations.get(returned);
    if (child?.parent === operation) returnedChild = child;
    result = { value: await returned };
  } catch (error) {
    const forwarded = operation.forwarded ?? (returnedChild?.failed ? returnedChild : undefined);
    observed.push(...forwarded?.failures ?? [ownFailure(operation, error)]);
    retainFailures(operation, observed);
  }
  operation.callbackClosed = true;
  const children = [...operation.children];
  await Promise.allSettled(children.map(child => child.promise));
  for (const child of children) if (child.failed) observed.push(...child.failures!);
  if (observed.length) { retainFailures(operation, observed); throwFailures(observed); }
  requireValue(result); return result.value;
}

/** Fixed adapter close-entry: preserve original operations and the same barrier. */
export function finishControllerRestoreCallback(lock: SourceLock | undefined): Promise<void> | undefined {
  if (!lock) return undefined;
  const state = lockLifetime(lock); state.closed = true;
  if (state.barrier) return state.barrier;
  if (!state.pending.size) return undefined;
  state.closeFailure ??= new MaintenanceFailure("maintenance_lost", "controller-restore");
  const pending = [...state.pending];
  for (const operation of pending) fail(operation.scope, state.closeFailure);
  state.barrier = Promise.allSettled(pending.map(operation => operation.promise)).then(() => {
    const observed = pending.flatMap(operation => operation.failures ?? []);
    if (observed.length) throwFailures(observed);
    throw state.closeFailure;
  });
  void state.barrier.catch(() => undefined); return state.barrier;
}

/** These two boundaries are used only by the fixed guard assembly. They create
 * the actual checking/consumer Promise, not a caller-registered alias or permit. */
export function runControllerRestoreCheck<T>(scope: ControllerCommandScope, lock: SourceLock, check: () => Promise<T>): Promise<T> {
  return track(scope, lock, "checking", operation => invokeCallback(operation, check));
}
export function runControllerRestoreConsumer<T>(scope: ControllerCommandScope, lock: SourceLock, consume: () => Promise<T>): Promise<T> {
  return track(scope, lock, "consumer", operation => invokeCallback(operation, consume));
}
/** Trusted fixed assembly only. The entire parent remains owned between checks. */
export function withControllerRestoreCallback<T>(scope: ControllerCommandScope, lock: SourceLock,
  callback: () => Promise<T>): Promise<T> {
  return track(scope, lock, "callback", async operation => {
    const context = await currentWindow(scope, lock); requireValue(context.kind === "snapshot");
    const result = await invokeCallback(operation, callback);
    await currentWindow(scope, lock, context); return result;
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

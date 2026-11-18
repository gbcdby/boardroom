import { canonicalJson } from "./canonical.ts";
import { assertControllerCommandWindow } from "./controller-write.ts";
import type { ControllerCommandScope } from "./controller-write.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifySnapshotClosure } from "./journal.ts";
import { parseReceipt } from "./parse.ts";
import { forwardControllerRestoreFailure, runControllerRestoreCheck, runControllerRestoreConsumer, withControllerRestoreCallback } from "./restore-authorization.ts";
import type { MaintenanceRef, SnapshotReceipt, SourceLock } from "./types.ts";

const verifiedGuard: unique symbol = Symbol("verified-maintenance-guard");
export interface VerifiedMaintenanceGuard {
  readonly [verifiedGuard]: true;
  readonly maintenance: MaintenanceRef;
  readonly snapshot: SnapshotReceipt;
  assertCurrent(): Promise<void>;
}
export interface VerifiedMaintenanceConsumer {
  withVerifiedMaintenance<T>(ref: MaintenanceRef, snapshot: SnapshotReceipt,
    consume: (guard: VerifiedMaintenanceGuard) => Promise<T>): Promise<T>;
}
interface ConsumerState {
  readonly scope: ControllerCommandScope;
  readonly lock: SourceLock;
  running: boolean;
}
interface GuardState {
  readonly scope: ControllerCommandScope;
  readonly lock: SourceLock;
  readonly current: () => Promise<void>;
  readonly maintenance: MaintenanceRef;
  active: boolean;
  failed: boolean;
  firstFailure: unknown;
  checking?: Promise<void>;
  failedChecking?: Promise<void>;
  readonly checks: WeakSet<Promise<void>>;
}
const consumers = new WeakMap<VerifiedMaintenanceConsumer, ConsumerState>();
const guards = new WeakMap<VerifiedMaintenanceGuard, GuardState>();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function requireValue(value: unknown, code: ConstructorParameters<typeof MaintenanceFailure>[0] = "maintenance_lost"): asserts value {
  if (!value) throw new MaintenanceFailure(code, "verified-maintenance");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertGuardCurrent(this: VerifiedMaintenanceGuard): Promise<void> {
  const state = guards.get(this);
  if (!state || !state.active) return Promise.reject(new MaintenanceFailure("maintenance_lost", "verified-maintenance"));
  if (state.checking) return state.checking;
  if (state.failed) return state.failedChecking!;
  // The fixed wrapper owns this exact checking Promise, including early native
  // checks before any restore child. Public callers still observe its raw error.
  const checking = runControllerRestoreCheck(state.scope, state.lock, async () => {
    const actual = await assertControllerCommandWindow(state.scope, state.lock), head = actual.chain?.nodes.at(-1);
    requireValue(state.active && head && same(captureReference(head), state.maintenance)
      && head.record.phase === "snapshot_ready" && !actual.chain!.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)));
    const current = state.current();
    try { await current; }
    catch { forwardControllerRestoreFailure(state.scope, state.lock, current); }
  });
  state.checks.add(checking); state.checking = checking;
  void checking.then(() => { if (state.checking === checking) delete state.checking; }, error => {
    if (!state.failed) { state.firstFailure = error; state.failedChecking = checking; }
    state.failed = true;
    if (state.checking === checking) delete state.checking;
  });
  return checking;
}

/** Fixed trusted consumer forwarding only. No error value, id or propagation
 * flag is accepted. The original guard and its actual checking Promise select
 * the already observed failure; an independent throw does not call this entry. */
export function forwardVerifiedMaintenanceFailure(guard: VerifiedMaintenanceGuard, checking: Promise<void>): never {
  const state = guards.get(guard);
  requireValue(state && state.active && state.checks.has(checking));
  forwardControllerRestoreFailure(state.scope, state.lock, checking);
}

/** Actual consumers validate the original object in this private table, so a
 * copied object with a rebound method or a foreign source field is no permit. */
export function assertVerifiedMaintenanceGuard(guard: VerifiedMaintenanceGuard): Promise<void> {
  if (!guards.has(guard)) return Promise.reject(new MaintenanceFailure("maintenance_lost", "verified-maintenance"));
  return assertGuardCurrent.call(guard);
}

function consumeVerified<T>(this: VerifiedMaintenanceConsumer, ref: MaintenanceRef, snapshot: SnapshotReceipt,
  consume: (guard: VerifiedMaintenanceGuard) => Promise<T>): Promise<T> {
  const state = consumers.get(this);
  try {
    requireValue(state && !state.running);
    requireValue(typeof consume === "function", "request_conflict");
  } catch (error) { return Promise.reject(error); }
  state.running = true;
  // The whole original operation, including the user's pending callback
  // between assertions, enters the source-close barrier before any work yields.
  // This wrapper grants no additional authority; real restore remains below.
  const operation = withControllerRestoreCallback(state.scope, state.lock, async () => {
    let guard: VerifiedMaintenanceGuard | undefined, lifetime: GuardState | undefined;
    try {
      const actual = await assertControllerCommandWindow(state.scope, state.lock), head = actual.chain?.nodes.at(-1);
      requireValue(head && head.record.phase === "snapshot_ready" && same(ref, captureReference(head)), "phase_conflict");
      const supplied = parseReceipt(snapshot), closure = await verifySnapshotClosure(actual.store, head.reference);
      requireValue(same(supplied, closure.receipt), "snapshot_invalid");
      // A readonly current-ready check cannot issue this guard. This entry always
      // obtains a fresh actual restore in the original snapshot lock/owner.
      const { revalidateControllerReady } = await import("./restore-authorization.ts");
      const revalidation = revalidateControllerReady(state.scope, state.lock);
      let verified: Awaited<typeof revalidation>;
      try { verified = await revalidation; }
      catch { forwardControllerRestoreFailure(state.scope, state.lock, revalidation); }
      requireValue(same(verified.ref, ref) && same(verified.receipt, supplied), "snapshot_invalid");
      const maintenance = freeze(structuredClone(verified.ref)), receipt = freeze(structuredClone(verified.receipt));
      guard = Object.freeze({ [verifiedGuard]: true as const, maintenance, snapshot: receipt, assertCurrent: assertGuardCurrent });
      lifetime = { scope: state.scope, lock: state.lock, current: verified.assertCurrent, maintenance,
        active: true, failed: false, firstFailure: undefined, checks: new WeakSet() };
      guards.set(guard, lifetime);
      const check = async () => {
        const checking = assertVerifiedMaintenanceGuard(guard!);
        try { await checking; }
        catch { forwardVerifiedMaintenanceFailure(guard!, checking); }
      };
      await check();
      // Own the actual consumer invocation separately from its checking children.
      // Its independent throw remains an occurrence even for an equal raw value.
      const consumption = runControllerRestoreConsumer(state.scope, state.lock, () => consume(guard!));
      let result: T;
      try { result = await consumption; }
      catch { forwardControllerRestoreFailure(state.scope, state.lock, consumption); }
      if (lifetime.checking) {
        const checking = lifetime.checking;
        try { await checking; }
        catch { forwardVerifiedMaintenanceFailure(guard, checking); }
      }
      await check();
      // The original failed checking remains available after its current slot is
      // cleared. A sticky rejection never creates a new Promise or occurrence.
      if (lifetime.failed) forwardVerifiedMaintenanceFailure(guard, lifetime.failedChecking!);
      return result;
    } finally {
      if (lifetime) lifetime.active = false;
    }
  });
  void operation.then(() => { state.running = false; }, () => { state.running = false; });
  return operation;
}

/** Trusted executor assembly only. A real original scope and currently-held
 * snapshot lock are required before creating the binding and at every use.
 * The fixed worker never sends this object or a callback over IPC. The returned
 * value is still inside the caller's actual source transaction: the enclosing
 * service must finish its original COMMIT/close and owner cleanup before
 * returning any consumer result. Future S2 supplies its reviewed fixed command
 * at that assembly point; this is not an arbitrary consumer registry. */
export async function createVerifiedMaintenanceConsumer(scope: ControllerCommandScope, lock: SourceLock): Promise<VerifiedMaintenanceConsumer> {
  const actual = await assertControllerCommandWindow(scope, lock), head = actual.chain?.nodes.at(-1);
  requireValue(actual.kind === "snapshot" && head?.record.phase === "snapshot_ready"
    && !actual.chain!.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)), "phase_conflict");
  const consumer: VerifiedMaintenanceConsumer = Object.freeze({ withVerifiedMaintenance: consumeVerified });
  consumers.set(consumer, { scope, lock, running: false });
  return consumer;
}

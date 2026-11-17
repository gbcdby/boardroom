import { canonicalJson } from "./canonical.ts";
import { assertControllerCommandWindow } from "./controller-write.ts";
import type { ControllerCommandScope } from "./controller-write.ts";
import { MaintenanceFailure } from "./error.ts";
import { captureReference, verifySnapshotClosure } from "./journal.ts";
import { parseReceipt } from "./parse.ts";
import { withControllerRestoreCallback } from "./restore-authorization.ts";
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
  if (state.failed) return Promise.reject(state.firstFailure);
  // Register the original check before any native/read await. Concurrent
  // assertions observe that same Promise; scope closure must await it too.
  let start!: () => void;
  const gate = new Promise<void>(resolve => { start = resolve; });
  const checking = gate.then(async () => {
    const actual = await assertControllerCommandWindow(state.scope, state.lock), head = actual.chain?.nodes.at(-1);
    requireValue(state.active && head && same(captureReference(head), state.maintenance)
      && head.record.phase === "snapshot_ready" && !actual.chain!.nodes.some(node => ["cancel_intent", "cancelled"].includes(node.record.event)));
    await state.current();
  }).catch(error => {
    if (!state.failed) state.firstFailure = error;
    state.failed = true; throw error;
  }).finally(() => { if (state.checking === checking) delete state.checking; });
  state.checking = checking; start(); return checking;
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
      const verified = await revalidateControllerReady(state.scope, state.lock);
      requireValue(same(verified.ref, ref) && same(verified.receipt, supplied), "snapshot_invalid");
      const maintenance = freeze(structuredClone(verified.ref)), receipt = freeze(structuredClone(verified.receipt));
      guard = Object.freeze({ [verifiedGuard]: true as const, maintenance, snapshot: receipt, assertCurrent: assertGuardCurrent });
      lifetime = { scope: state.scope, lock: state.lock, current: verified.assertCurrent, maintenance,
        active: true, failed: false, firstFailure: undefined };
      guards.set(guard, lifetime);
      const failures: unknown[] = [];
      let result: { value: T } | undefined;
      try {
        await assertVerifiedMaintenanceGuard(guard);
        result = { value: await consume(guard) };
        // A consumer may start a real guard assertion without awaiting it. Keep
        // that exact operation alive, finish it, then make the final fresh check.
        if (lifetime.checking) await lifetime.checking;
        await assertVerifiedMaintenanceGuard(guard);
      } catch (error) { failures.push(error); }
      if (lifetime.checking) {
        try { await lifetime.checking; }
        catch (error) { failures.push(error); }
      }
      // Sticky validation failure remains failure even if a trusted consumer
      // catches it and returns normally. Literal undefined is an observed failure.
      if (!failures.length && lifetime.failed) failures.push(lifetime.firstFailure);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "storage_maintenance: verified consumer failed", { cause: failures[0] });
      requireValue(result); return result.value;
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

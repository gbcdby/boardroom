import path from "node:path";
import { digestJson } from "./canonical.ts";
import { controlSqlOutcome } from "./control-sql.ts";
import { MaintenanceFailure } from "./error.ts";
import { createSqliteMaintenanceAdapter } from "./sqlite.ts";
import { createPostgresMaintenanceAdapter } from "./postgres.ts";
import { postgresDescriptorDigest } from "./postgres-tools.ts";
import type { DatabaseDescriptor } from "../../environment.ts";
import type { ArtifactStore } from "./objects.ts";
import type { Json, MaintenanceAdapter, MaintenanceServiceOptions, MigrationPlan, OperationMutex, SourceLock } from "./types.ts";

/** Concrete trusted-assembly resources only. Keys select old owners for cleanup;
 * neither a copied key nor this process-local registry grants source authority. */
export interface ControllerOwner {
  readonly descriptor: DatabaseDescriptor;
  readonly adapter: MaintenanceAdapter;
  readonly keys: readonly string[];
  readonly stores: Map<string, ArtifactStore>;
  readonly unresolvedSourceErrors: Set<object>;
  adapterClosed: boolean;
  closing?: Promise<void>;
}
const pending = new Set<ControllerOwner>();
function cleanupKeys(descriptor: DatabaseDescriptor, plan: MigrationPlan): readonly string[] {
  const keys = ["source:" + digestJson(plan.source)];
  if (descriptor.kind === "sqlite") {
    keys.push("sqlite-path:" + path.resolve(descriptor.sqlitePath));
    if (descriptor.identity) keys.push("sqlite-inode:" + digestJson(descriptor.identity));
  } else {
    keys.push("postgres-descriptor:" + postgresDescriptorDigest(descriptor));
    const identity = plan.sourceIdentity;
    if (identity && typeof identity === "object" && !Array.isArray(identity)) {
      const values = identity as Readonly<Record<string, Json>>;
      const fields = ["systemIdentifier", "databaseOid", "schemaOid", "serverAddress", "serverPort", "databaseInstanceId"];
      if (values.kind === "postgres" && fields.every(field => Object.hasOwn(values, field)))
        keys.push("postgres-native:" + digestJson(Object.fromEntries(fields.map(field => [field, values[field]!]))));
    }
  }
  return Object.freeze(keys);
}
function throwFailures(errors: readonly unknown[], subject: string): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "storage_maintenance: " + subject, { cause: errors[0] });
}
/** These are caught real errors, not caller proof. Keep the original S/native
 * error graph (and its real nativeCleanupOwner) alive. No numeric FD is retried. */
function retainSourceErrors(owner: ControllerOwner, error: unknown, seen = new Set<object>()): void {
  if (error === null || typeof error !== "object" || seen.has(error)) return;
  seen.add(error);
  if (Object.hasOwn(error, "nativeCleanupOwner")
    || "closeErrors" in error && Array.isArray(error.closeErrors) && error.closeErrors.length > 0)
    owner.unresolvedSourceErrors.add(error);
  if (error instanceof AggregateError) for (const item of error.errors) retainSourceErrors(owner, item, seen);
  if ("cause" in error) retainSourceErrors(owner, error.cause, seen);
}
export function rememberControllerStore(owner: ControllerOwner, store: ArtifactStore): void {
  const key = digestJson(store.identity);
  if (!owner.stores.has(key)) owner.stores.set(key, store);
}
export function recordControllerFailure(owner: ControllerOwner, failures: unknown[], error: unknown): void {
  // Object.is preserves a literal undefined primary and prevents adding the
  // identical exception again as it crosses nested native callback boundaries.
  if (!failures.some(value => Object.is(value, error))) failures.push(error);
  retainSourceErrors(owner, error);
}
async function cleanup(owner: ControllerOwner): Promise<void> {
  const errors: unknown[] = [];
  for (const store of owner.stores.values()) {
    try { await store.cleanupPublications(); }
    catch (error) { errors.push(error); }
  }
  if (!owner.adapterClosed) {
    try { await owner.adapter.close(); owner.adapterClosed = true; }
    catch (error) { errors.push(error); }
  }
  // Adapter success cannot retire an uncertain S auxiliary/native owner. S/P
  // retain their concrete owners too; recovery is separate from a fresh entry.
  if (owner.unresolvedSourceErrors.size)
    errors.push(new AggregateError([...owner.unresolvedSourceErrors],
      "storage_maintenance: source cleanup remains unknown"));
  if (errors.length) { pending.add(owner); throwFailures(errors, "controller resource cleanup failed"); }
  pending.delete(owner);
}
async function finishPending(owner: ControllerOwner): Promise<void> {
  const attempt = owner.closing ??= Promise.resolve().then(() => cleanup(owner));
  try { await attempt; } finally { if (owner.closing === attempt) delete owner.closing; }
}
/** Creates only from trusted resolver selection. There is no adapter override. */
export async function createControllerOwner(options: MaintenanceServiceOptions, plan: MigrationPlan): Promise<ControllerOwner> {
  const selected = options.environment.databaseDescriptor;
  const descriptor: DatabaseDescriptor = selected.kind === "sqlite"
    ? { ...selected, identity: selected.identity && { ...selected.identity } } : { ...selected };
  const keys = cleanupKeys(descriptor, plan);
  for (const owner of pending) if (keys.some(key => owner.keys.includes(key))) await finishPending(owner);
  const adapter = descriptor.kind === "sqlite" ? await createSqliteMaintenanceAdapter(descriptor)
    : await createPostgresMaintenanceAdapter(descriptor, options.postgresVerification);
  return { descriptor, adapter, keys, stores: new Map(), unresolvedSourceErrors: new Set(), adapterClosed: false };
}
/** Real outer completion precedes this call; it never treats callback return as
 * COMMIT evidence. Even a failed release must not prevent other owned cleanup. */
export async function finishControllerOwner(owner: ControllerOwner, mutex: OperationMutex | undefined,
  lock: SourceLock | undefined, failures: unknown[], subject: string): Promise<void> {
  // Separate cleanup stages remain separate even if each throws undefined or
  // the same Error object. Only propagation through nested callbacks is deduped.
  const cleanupFailure = (error: unknown) => { failures.push(error); retainSourceErrors(owner, error); };
  try {
    const outcome = lock && controlSqlOutcome(lock);
    if (outcome?.rollbackFailureObserved)
      failures.push(new MaintenanceFailure("maintenance_lost", "source-rollback-failure"));
    if (outcome?.failureObserved && outcome.closeFailureObserved)
      failures.push(new MaintenanceFailure("maintenance_lost", "source-close-failure"));
  } catch (error) { cleanupFailure(error); }
  // Publish the concrete in-flight close before the first await. Mutex release
  // alone must not let another entry bypass this owner's store/source cleanup.
  // Concurrent entrants await this same promise, including its rejection; they
  // cannot start a second empty cleanup while the real one is still in flight.
  const closingFailures: unknown[] = [];
  pending.add(owner);
  const attempt = Promise.resolve().then(async () => {
    try { await mutex?.release(); } catch (error) { closingFailures.push(error); retainSourceErrors(owner, error); }
    try { await cleanup(owner); } catch (error) { closingFailures.push(error); retainSourceErrors(owner, error); }
    if (closingFailures.length) throwFailures(closingFailures, subject + " resource cleanup failed");
  });
  owner.closing = attempt;
  try { await attempt; }
  catch (error) { if (closingFailures.length) failures.push(...closingFailures); else cleanupFailure(error); }
  finally { if (owner.closing === attempt) delete owner.closing; }
  if (failures.length) throwFailures(failures, subject + " cleanup failed");
}

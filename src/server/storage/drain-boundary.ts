import { AsyncLocalStorage } from "node:async_hooks";
import type { DbDriver } from "../db/driver.ts";
import { StorageMaintenanceError, type StorageAdmissionIdentity, type StorageMaintenanceState } from "./admission.ts";

/** Internal application assembly only. These are fixed lifecycle operations, never caller SQL. */
export type StorageDrainOperation = "disconnect_sessions" | "stop_owned_runtime" | "observe_owned_exit" | "close_memory";
type Callback = (input: unknown) => Promise<unknown>;
interface Registration {
  readonly driver: DbDriver;
  readonly clientId: string;
  readonly identity: StorageAdmissionIdentity;
  readonly callbacks: Readonly<Partial<Record<StorageDrainOperation, Callback>>>;
  active: boolean;
}
interface Invocation { readonly registration: Registration; readonly epoch: number; active: boolean }
const registered = new WeakMap<DbDriver, Registration>();
const scope = new AsyncLocalStorage<Invocation>();
export interface StorageDrainBoundary {
  invoke(operation: StorageDrainOperation, epoch: number, input?: unknown): Promise<unknown>;
  revoke(): void;
}

/** Bind exact app-owned callbacks once, under ordinary admission and a real registered client.
 * An invocation cannot supply a callback/SQL; no serializable bypass token is returned.
 * Callback implementations still own existing session/fence/process-proof validation.
 */
export async function bindStorageDrainBoundary(driver: DbDriver, input: {
  readonly clientId: string;
  readonly identity: StorageAdmissionIdentity;
  readonly callbacks: Readonly<Partial<Record<StorageDrainOperation, Callback>>>;
}): Promise<StorageDrainBoundary> {
  if (registered.has(driver) || Object.keys(input.callbacks).some(k => !["disconnect_sessions","stop_owned_runtime","observe_owned_exit","close_memory"].includes(k)))
    throw new StorageMaintenanceError("metadata_invalid");
  await driver.transaction(async tx => {
    const rows=await tx.query("SELECT * FROM storage_source_clients WHERE client_id=?",[input.clientId]);
    const client=rows[0];
    if (rows.length!==1 || client?.database_instance_id!==input.identity.databaseInstanceId
      || Number(client.registered_epoch)!==input.identity.fenceEpoch || client.ended_at!==null || client.drain_state!=="none")
      throw new StorageMaintenanceError("metadata_invalid");
  });
  const registration: Registration={driver,clientId:input.clientId,identity:{...input.identity},callbacks:Object.freeze({...input.callbacks}),active:true};
  registered.set(driver,registration);
  return Object.freeze({
    async invoke(operation: StorageDrainOperation, epoch: number, data?: unknown) {
      const callback=registration.callbacks[operation];
      if (!registration.active || !callback || !Number.isSafeInteger(epoch) || epoch<0 || scope.getStore()) throw new StorageMaintenanceError("active");
      const invocation: Invocation={registration,epoch,active:true};
      try {
        return await scope.run(invocation,async()=>{
          // Validate before even an OS/file callback. Each later top-level DB transaction rechecks.
          await driver.transaction(async()=>{});
          return callback(data);
        });
      } finally {invocation.active=false;}
    },
    revoke() {registration.active=false;registered.delete(driver);},
  });
}

/** Driver-private query descriptor. No permit is usable by another driver or async request. */
export function storageDrainClientToCheck(driver: DbDriver, state: StorageMaintenanceState | null,
  expected: StorageAdmissionIdentity | undefined): string | null {
  const invocation=scope.getStore(), registration=invocation?.registration;
  if (!invocation?.active || !registration?.active || registered.get(driver)!==registration || registration.driver!==driver) return null;
  if (!state || state.admission!=="draining" || state.fenceEpoch!==invocation.epoch || !expected
    || expected.databaseInstanceId!==registration.identity.databaseInstanceId || expected.fenceEpoch!==registration.identity.fenceEpoch
    || state.databaseInstanceId!==expected.databaseInstanceId || state.fenceEpoch!==expected.fenceEpoch+1)
    throw new StorageMaintenanceError("active");
  return registration.clientId;
}
export function assertStorageDrainClient(row: Record<string,unknown> | undefined, state: StorageMaintenanceState,
  expected: StorageAdmissionIdentity): void {
  if (!row || row.database_instance_id!==expected.databaseInstanceId || Number(row.registered_epoch)!==expected.fenceEpoch
    || Number(row.drain_epoch)!==state.fenceEpoch || row.drain_state!=="draining" || row.ended_at!==null)
    throw new StorageMaintenanceError("active");
}

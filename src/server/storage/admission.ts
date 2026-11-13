import type Database from "better-sqlite3";
import type { PoolClient } from "pg";
import { ConfigError } from "../config-error.ts";

export const STORAGE_MAINTENANCE_VERSION = 18;
export const STORAGE_PROTOCOL_VERSION = 1;
export type StorageAdmission = "open" | "draining" | "sealed";
/** Source gate facts only. No migration phase or execution authorization. */
export interface StorageMaintenanceState {
  readonly databaseInstanceId: string;
  readonly admission: StorageAdmission;
  readonly fenceEpoch: number;
  readonly ownerGeneration: number;
  readonly activeMigrationId: string | null;
  readonly planDigest: string | null;
  readonly controlRootJson: string | null;
  readonly mutexIdentityJson: string | null;
  readonly journalRecordRef: string | null;
  readonly journalDigest: string | null;
  readonly journalSequence: number;
  readonly protocolVersion: 1;
  readonly guardManifestDigest: string;
}
export interface StorageAdmissionIdentity { readonly databaseInstanceId: string; readonly fenceEpoch: number }

export class StorageMaintenanceError extends ConfigError {
  readonly reason: "active" | "epoch_changed" | "metadata_invalid" | "guard_incomplete";
  constructor(reason: StorageMaintenanceError["reason"] = "active") {
    super(`storage_maintenance: ${reason}。普通工作未获准入。`,
      reason === "metadata_invalid" || reason === "guard_incomplete" ? "migration_incomplete" : "storage_maintenance",
      "使用可信本地维护入口检查原数据源与 journal；不要删除门禁或切换空库。");
    this.reason = reason;
  }
}

function counter(value: unknown): number {
  if (!(typeof value === "number" || typeof value === "bigint" || typeof value === "string") || !/^\d+$/.test(String(value)))
    throw new StorageMaintenanceError("metadata_invalid");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new StorageMaintenanceError("metadata_invalid");
  return n;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw new StorageMaintenanceError("metadata_invalid");
  return value;
}
function digest(value: unknown, optional = false): string | null {
  if (optional && value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new StorageMaintenanceError("metadata_invalid");
  return value;
}
export function parseStorageMaintenanceState(rows: readonly Record<string, unknown>[]): StorageMaintenanceState {
  const row = rows[0];
  if (rows.length !== 1 || !row || Number(row.singleton) !== 1 || Number(row.protocol_version) !== 1
    || typeof row.database_instance_id !== "string" || !/^[a-f0-9]{32}$/.test(row.database_instance_id)
    || !["open","draining","sealed"].includes(String(row.admission))) throw new StorageMaintenanceError("metadata_invalid");
  const state: StorageMaintenanceState = {
    databaseInstanceId: row.database_instance_id,
    admission: row.admission as StorageAdmission,
    fenceEpoch: counter(row.fence_epoch), ownerGeneration: counter(row.owner_generation),
    activeMigrationId: nullableText(row.active_migration_id), planDigest: digest(row.plan_digest,true),
    controlRootJson: nullableText(row.control_root_json), mutexIdentityJson: nullableText(row.mutex_identity_json),
    journalRecordRef: nullableText(row.journal_record_ref), journalDigest: digest(row.journal_digest,true),
    journalSequence: counter(row.journal_sequence), protocolVersion: 1,
    guardManifestDigest: digest(row.guard_manifest_digest)!,
  };
  for (const encoded of [state.controlRootJson,state.mutexIdentityJson]) if (encoded !== null) {
    try { const value: unknown = JSON.parse(encoded); if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error(); }
    catch { throw new StorageMaintenanceError("metadata_invalid"); }
  }
  if ((state.admission === "open" && (state.activeMigrationId !== null || state.planDigest !== null))
    || (state.admission !== "open" && (!state.activeMigrationId || !state.planDigest || !state.controlRootJson || !state.mutexIdentityJson || !state.journalRecordRef))
    || (state.journalSequence === 0 ? state.journalDigest !== null || state.journalRecordRef !== null : !state.journalDigest || !state.journalRecordRef))
    throw new StorageMaintenanceError("metadata_invalid");
  return Object.freeze(state);
}

/** Null only means an actual pre-v18/fresh schema; a missing v18 table never means open. */
export function readSqliteMaintenanceState(db: Database.Database, required = false): StorageMaintenanceState | null {
  if (required) {
    try {return parseStorageMaintenanceState(db.prepare("SELECT * FROM storage_maintenance").all() as Record<string,unknown>[]);}
    catch {throw new StorageMaintenanceError("metadata_invalid");}
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('storage_maintenance','schema_migrations')").all() as {name:string}[];
  if (!tables.some(t => t.name === "storage_maintenance")) {
    if (required || (tables.some(t => t.name === "schema_migrations") && Number((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {v:number}).v) >= 18))
      throw new StorageMaintenanceError("metadata_invalid");
    return null;
  }
  return parseStorageMaintenanceState(db.prepare("SELECT * FROM storage_maintenance").all() as Record<string, unknown>[]);
}

export async function readPostgresMaintenanceState(client: Pick<PoolClient,"query">, options: {required?:boolean; lock?:boolean} = {}): Promise<StorageMaintenanceState | null> {
  if (options.required) {
    try {return parseStorageMaintenanceState((await client.query(`SELECT * FROM storage_maintenance${options.lock ? " FOR SHARE" : ""}`)).rows);}
    catch (error) {
      // A serialization/deadlock error still owns transaction rollback semantics.
      if (["40001","40P01","55P03"].includes(String((error as {code?:string}).code))) throw error;
      throw new StorageMaintenanceError("metadata_invalid");
    }
  }
  const table = await client.query("SELECT to_regclass('storage_maintenance')::text AS maintenance, to_regclass('schema_migrations')::text AS migrations");
  if (!table.rows[0]?.maintenance) {
    if (options.required || (table.rows[0]?.migrations && Number((await client.query("SELECT MAX(version) AS v FROM schema_migrations")).rows[0]?.v) >= 18))
      throw new StorageMaintenanceError("metadata_invalid");
    return null;
  }
  return parseStorageMaintenanceState((await client.query(`SELECT * FROM storage_maintenance${options.lock ? " FOR SHARE" : ""}`)).rows);
}

/** Caller must hold its write transaction (SQLite IMMEDIATE / PG row FOR SHARE) until commit. */
export function assertStorageAdmission(state: StorageMaintenanceState | null, expected?: StorageAdmissionIdentity): void {
  if (!state) { if (expected) throw new StorageMaintenanceError("metadata_invalid"); return; }
  if (state.admission !== "open") throw new StorageMaintenanceError("active");
  if (expected && (state.databaseInstanceId !== expected.databaseInstanceId || state.fenceEpoch !== expected.fenceEpoch))
    throw new StorageMaintenanceError("epoch_changed");
}

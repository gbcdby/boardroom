import type Database from "better-sqlite3";
import type { Client } from "pg";
import { MaintenanceFailure } from "./error.ts";
import { sourceClientColumns } from "./source-clients-read.ts";
import type { SourceClientRawRow } from "./types.ts";
import type { ControlSqlMaintenance, ControlSqlPlan } from "./control-sql.ts";

const maintenanceColumns: Readonly<Record<keyof ControlSqlMaintenance, string>> = {
  singleton: "singleton", databaseInstanceId: "database_instance_id", admission: "admission", fenceEpoch: "fence_epoch",
  ownerGeneration: "owner_generation", activeMigrationId: "active_migration_id", planDigest: "plan_digest",
  controlRootJson: "control_root_json", mutexIdentityJson: "mutex_identity_json", journalRecordRef: "journal_record_ref",
  journalDigest: "journal_digest", journalSequence: "journal_sequence", protocolVersion: "protocol_version", guardManifestDigest: "guard_manifest_digest",
};
const keys = Object.keys(maintenanceColumns) as (keyof ControlSqlMaintenance)[];
const successorColumns = ["ownerGeneration", "journalRecordRef", "journalDigest", "journalSequence"] as const;
function changedColumns(plan: ControlSqlPlan): readonly (keyof ControlSqlMaintenance)[] {
  if (plan.transition === "sealed-successor") return successorColumns;
  if (plan.transition === "first-seal") return ["admission", ...successorColumns];
  if (plan.transition === "cancel-terminal") return ["admission", "fenceEpoch", "activeMigrationId", "planDigest", ...successorColumns];
  throw new MaintenanceFailure("journal_invalid");
}
function one(count: number | bigint | null): void { if (count !== 1 && count !== 1n) throw new MaintenanceFailure("source_changed"); }
function completeMaintenance(value: Record<string, unknown>[]): void {
  if (value.length !== 1 || Object.keys(value[0]!).length !== keys.length || keys.some(key => !Object.hasOwn(value[0]!, maintenanceColumns[key])))
    throw new MaintenanceFailure("schema_guard_incomplete");
}

/** Only the adapter's already-held transaction passes its handle here. No input chooses SQL or columns. */
export function writeSqliteControlSql(db: Database.Database, plan: ControlSqlPlan): void {
  const changed = changedColumns(plan);
  completeMaintenance(db.prepare("SELECT * FROM storage_maintenance").all() as Record<string, unknown>[]);
  const cell = (value: SourceClientRawRow[keyof SourceClientRawRow]) => value[0] === "null" ? null
    : value[0] === "text" ? Buffer.from(value[1], "hex") : BigInt(value[1]);
  const marker = (value: SourceClientRawRow[keyof SourceClientRawRow]) => value[0] === "text" ? "CAST(? AS TEXT)" : "?";
  const compare = (row: SourceClientRawRow) => sourceClientColumns.map(({ name }) => row[name][0] === "text"
    ? `CAST(${name} AS BLOB) IS ?` : `${name} IS ?`).join(" AND ");
  for (const change of plan.changes) {
    if (change.kind === "maintenance-registration") {
      const after = change.after;
      one(db.prepare(`INSERT INTO storage_source_clients (${sourceClientColumns.map(column => column.name).join(",")}) VALUES (${sourceClientColumns.map(column => marker(after[column.name])).join(",")})`)
        .run(...sourceClientColumns.map(column => cell(after[column.name]))).changes);
    } else {
      one(db.prepare(`UPDATE storage_source_clients SET last_observed_at=${marker(change.after.last_observed_at)},ended_at=${marker(change.after.ended_at)} WHERE ${compare(change.before)}`)
        .run(cell(change.after.last_observed_at), cell(change.after.ended_at), ...sourceClientColumns.map(column => cell(change.before[column.name]))).changes);
    }
  }
  one(db.prepare(`UPDATE storage_maintenance SET ${changed.map(key => `${maintenanceColumns[key]}=?`).join(",")} WHERE ${keys.map(key => `${maintenanceColumns[key]} IS ?`).join(" AND ")}`)
    .run(...changed.map(key => plan.after.expectedMaintenance[key]), ...keys.map(key => plan.before.expectedMaintenance[key])).changes);
}

/** The PG client and schema are fixed by the actual adapter, never by a mechanism input. */
export async function writePostgresControlSql(client: Client, plan: ControlSqlPlan): Promise<void> {
  const changed = changedColumns(plan);
  completeMaintenance((await client.query("SELECT * FROM storage_maintenance")).rows);
  const expression = (value: SourceClientRawRow[keyof SourceClientRawRow], index: number) => value[0] === "text"
    ? `convert_from(decode($${index},'hex'),current_setting('server_encoding'))` : `$${index}`;
  const value = (cell: SourceClientRawRow[keyof SourceClientRawRow]) => cell[0] === "null" ? null : cell[1];
  for (const change of plan.changes) {
    if (change.kind === "maintenance-registration") {
      const after = change.after;
      one((await client.query(`INSERT INTO storage_source_clients (${sourceClientColumns.map(column => column.name).join(",")}) VALUES (${sourceClientColumns.map((column, index) => expression(after[column.name], index + 1)).join(",")})`,
        sourceClientColumns.map(column => value(after[column.name])))).rowCount);
    } else {
      const where = sourceClientColumns.map((column, index) => change.before[column.name][0] === "text"
        ? `convert_to(${column.name},current_setting('server_encoding')) IS NOT DISTINCT FROM decode($${index + 3},'hex')`
        : `${column.name} IS NOT DISTINCT FROM $${index + 3}`).join(" AND ");
      one((await client.query(`UPDATE storage_source_clients SET last_observed_at=${expression(change.after.last_observed_at, 1)},ended_at=${expression(change.after.ended_at, 2)} WHERE ${where}`,
        [value(change.after.last_observed_at), value(change.after.ended_at), ...sourceClientColumns.map(column => value(change.before[column.name]))])).rowCount);
    }
  }
  one((await client.query(`UPDATE storage_maintenance SET ${changed.map((key, index) => `${maintenanceColumns[key]}=$${index + 1}`).join(",")} WHERE ${keys.map((key, index) => `${maintenanceColumns[key]} IS NOT DISTINCT FROM $${index + changed.length + 1}`).join(" AND ")}`,
    [...changed.map(key => plan.after.expectedMaintenance[key]), ...keys.map(key => plan.before.expectedMaintenance[key])])).rowCount);
}

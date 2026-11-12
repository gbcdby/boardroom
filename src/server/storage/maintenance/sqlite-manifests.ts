import type Database from "better-sqlite3";
import { checksumOf } from "../../db/migrate.ts";
import { migrations } from "../../db/migrations/index.ts";
import { assertSqliteGuardCoverage } from "../schema-guards.ts";
import { MaintenanceFailure } from "./error.ts";
import { buildDatabaseManifests, digestRowMultiset } from "./manifests.ts";
import type { DatabaseManifests, Json } from "./types.ts";

export function quoteSqliteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function jsonCell(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Buffer.isBuffer(value)) return { type: "blob", hex: value.toString("hex") };
  throw new MaintenanceFailure("snapshot_invalid");
}
function objectRows(db: Database.Database, sql: string): Readonly<Record<string, Json>>[] {
  return (db.prepare(sql).safeIntegers(true).all() as Record<string, unknown>[]).map(row =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonCell(value)])));
}

/** Call inside one real source read view; no SQL writes, migration or guard repair occur. */
export function readSqliteManifests(db: Database.Database): DatabaseManifests {
  try { assertSqliteGuardCoverage(db); }
  catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
  const applied = objectRows(db, "SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version");
  if (applied.length !== migrations.length || applied.some((row, i) => String(row.version) !== String(migrations[i]!.version)
    || row.name !== migrations[i]!.name || row.checksum !== checksumOf(migrations[i]!.up)))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const catalog = objectRows(db, "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name");
  const names = catalog.filter(row => row.type === "table").map(row => String(row.name)).sort();
  const tables: DatabaseManifests["tables"][number][] = [];
  for (const name of names) {
    const columns = objectRows(db, `PRAGMA main.table_xinfo(${quoteSqliteIdentifier(name)})`);
    if (!columns.length) throw new MaintenanceFailure("schema_guard_incomplete");
    const expressions = columns.flatMap(column => {
      const quoted = quoteSqliteIdentifier(String(column.name));
      // Text bytes are read as hex too, preserving even a SQLite TEXT value containing invalid UTF-8.
      return [`typeof(${quoted})`, `CASE WHEN typeof(${quoted}) IN ('text','blob') THEN hex(${quoted}) ELSE ${quoted} END`];
    });
    const rows = db.prepare(`SELECT ${expressions.join(",")} FROM main.${quoteSqliteIdentifier(name)}`).raw(true).safeIntegers(true).all() as unknown[][];
    const encoded: Json[] = rows.map(row => columns.map((_, index): Json => {
      const type = row[index * 2], value = row[index * 2 + 1];
      if (type === "null" && value === null) return ["null"];
      if (type === "integer" && typeof value === "bigint") return ["integer", value.toString()];
      if (type === "real" && typeof value === "number" && Number.isFinite(value)) {
        const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return ["real-ieee754", bytes.toString("hex")];
      }
      if ((type === "text" || type === "blob") && typeof value === "string") return [type, value.toLowerCase()];
      throw new MaintenanceFailure("snapshot_invalid");
    }));
    tables.push({ name, columns, ...digestRowMultiset(encoded) });
  }
  return buildDatabaseManifests("sqlite", { catalog, migrations: applied }, tables, {
    storage_maintenance: objectRows(db, "SELECT * FROM storage_maintenance ORDER BY singleton"),
    storage_source_clients: objectRows(db, "SELECT * FROM storage_source_clients ORDER BY client_id"),
  });
}

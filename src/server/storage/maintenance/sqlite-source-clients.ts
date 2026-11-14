import type Database from "better-sqlite3";
import { digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { invalidSourceClients, sourceClientColumns, sourceClientsEncoding, sourceClientsHex, sourceClientsRows } from "./source-clients-read.ts";
import { quoteSqliteIdentifier as quote, readSqliteCatalog } from "./sqlite-manifests.ts";

/** Receives only the adapter's current main handle, inside its existing read/lock transaction. */
export function readSqliteSourceClients(db: Database.Database) {
  const catalog = readSqliteCatalog(db);
  const columns = catalog.tables.find(table => table.name === "storage_source_clients")?.columns;
  if (columns?.length !== sourceClientColumns.length || columns.some((column, index) => {
    const expected = sourceClientColumns[index]!;
    return column.cid !== String(index) || column.name !== expected.name || column.type !== expected.sqlite
      || column.notnull !== (expected.nullable || index === 0 ? "0" : "1") || column.pk !== (index === 0 ? "1" : "0")
      || column.hidden !== "0" || column.dflt_value !== (expected.name === "drain_state" ? "'none'" : null);
  })) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  const textEncoding = sourceClientsEncoding("sqlite", db.pragma("main.encoding", { simple: true }));
  const count = db.prepare("SELECT count(*) FROM main.storage_source_clients").pluck(true).safeIntegers(true).get();
  if (typeof count !== "bigint") invalidSourceClients();
  const projection = sourceClientColumns.flatMap(({ name }) => {
    const column = quote(name);
    return [`typeof(${column})`, `CASE WHEN typeof(${column})='text' THEN hex(CAST(${column} AS BLOB)) WHEN typeof(${column})='integer' THEN ${column} ELSE NULL END`,
      `CASE WHEN typeof(${column})='text' THEN length(CAST(${column} AS BLOB)) ELSE NULL END`];
  });
  const records = db.prepare(`SELECT ${projection.join(",")} FROM main.storage_source_clients`).raw(true).safeIntegers(true).all() as unknown[][];
  const rows = records.map(record => {
    if (record.length !== sourceClientColumns.length * 3) invalidSourceClients();
    return Object.fromEntries(sourceClientColumns.map(({ name }, index) => {
      const [type, value, size] = record.slice(index * 3, index * 3 + 3);
      if (type === "text") return [name, ["text", sourceClientsHex(value, size)]];
      if (type === "integer" && typeof value === "bigint" && size === null) return [name, ["integer", value.toString()]];
      if (type === "null" && value === null && size === null) return [name, ["null"]];
      return invalidSourceClients();
    }));
  });
  if (db.pragma("main.encoding", { simple: true }) !== textEncoding.name) throw new MaintenanceFailure("source_changed", "source-clients");
  return { schemaManifestDigest: digestJson(catalog.schema), textEncoding, rows: sourceClientsRows(rows, count) };
}

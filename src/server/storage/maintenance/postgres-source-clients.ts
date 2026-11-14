import { digestJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { quotePostgresIdentifier as quote, readPostgresCatalog, type PostgresReader } from "./postgres-manifests.ts";
import { invalidSourceClients, sourceClientColumns, sourceClientsEncoding, sourceClientsHex, sourceClientsRows } from "./source-clients-read.ts";
import { decodedSourceRows, sourceTextHexes, unknownWriter } from "./source-facts.ts";
import type { Json, SourceClientsObservation } from "./types.ts";

/** Native codec conversion, followed by a byte-exact inverse, on the original lock session. */
export async function decodePostgresSourceRows(client: PostgresReader, observation: SourceClientsObservation): Promise<Record<string, unknown>[]> {
  const hexes = sourceTextHexes(observation), text = new Map<string, string>();
  if (observation.textEncoding.backend !== "postgres") return unknownWriter();
  if (hexes.length === 0) return decodedSourceRows(observation, text);
  // SQL_ASCII does not assign a character meaning to high bytes. Refuse them
  // before asking the server to convert, which would abort the held transaction.
  // A10 retains every raw byte; ASCII identities still use the native round trip.
  if (observation.textEncoding.name === "SQL_ASCII" && hexes.some(hex => Buffer.from(hex, "hex").some(byte => byte > 0x7f)))
    return unknownWriter();
  try {
    const converted = (await client.query(`SELECT position::text AS position,
      encode(convert_to(convert_from(decode(value,'hex'),$2),'UTF8'),'hex') AS value
      FROM unnest($1::text[]) WITH ORDINALITY AS cells(value,position) ORDER BY cells.position`, [hexes, observation.textEncoding.name])).rows;
    if (converted.length !== hexes.length) return unknownWriter();
    const utf8 = converted.map((row, i) => {
      if (row.position !== String(i + 1) || typeof row.value !== "string" || !/^(?:[a-f0-9]{2})*$/.test(row.value)) return unknownWriter();
      const bytes = Buffer.from(row.value, "hex");
      const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!Buffer.from(value, "utf8").equals(bytes)) return unknownWriter();
      text.set(hexes[i]!, value); return row.value as string;
    });
    const inverse = (await client.query(`SELECT position::text AS position,
      encode(convert_to(convert_from(decode(value,'hex'),'UTF8'),$2),'hex') AS value
      FROM unnest($1::text[]) WITH ORDINALITY AS cells(value,position) ORDER BY cells.position`, [utf8, observation.textEncoding.name])).rows;
    if (inverse.length !== hexes.length || inverse.some((row, i) => row.position !== String(i + 1) || row.value !== hexes[i])) return unknownWriter();
  } catch (error) {
    if (["55P03", "40001", "40P01"].includes(String((error as { code?: string })?.code))) throw error;
    return unknownWriter();
  }
  return decodedSourceRows(observation, text);
}

function object(value: Json | undefined): Readonly<Record<string, Json>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  return value as Readonly<Record<string, Json>>;
}
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalidSourceClients();
  return BigInt(value);
}

/** No connection/transaction is created here. Catalog and rows share the adapter's real view. */
export async function readPostgresSourceClients(client: PostgresReader, schema: string) {
  const catalog = await readPostgresCatalog(client, schema);
  const table = catalog.tables.find(item => item.name === "storage_source_clients");
  if (!table) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  // Unlike the restore catalog's semantic column positions, these physical attnums include drops.
  const native = (await client.query(`SELECT a.attnum::text AS position,a.attname AS name,a.atttypid::text AS type_oid,
    a.atttypmod AS modifier,a.attnotnull AS not_null,a.attgenerated AS generated,a.attidentity AS identity,a.attisdropped AS dropped,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_expression,
    EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='p'
      AND c.conkey=ARRAY[1]::smallint[] AND c.convalidated) AS primary_id
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=$1::oid AND a.attnum>0 ORDER BY a.attnum`, [table.oid])).rows;
  if (native.length !== sourceClientColumns.length || native.some((column, index) => {
    const expected = sourceClientColumns[index]!;
    return column.position !== String(index + 1) || column.name !== expected.name || column.type_oid !== expected.postgres
      || column.modifier !== -1 || column.not_null !== !expected.nullable || column.generated !== "" || column.identity !== ""
      || column.dropped !== false || column.primary_id !== true
      || column.default_expression !== (expected.name === "drain_state" ? "'none'::text" : null);
  })) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  const databases = object(object(catalog.schema).environment).database;
  if (!Array.isArray(databases) || databases.length !== 1) throw new MaintenanceFailure("schema_guard_incomplete", "source-clients");
  const textEncoding = sourceClientsEncoding("postgres", object(databases[0]).encoding);
  const actual = (await client.query("SELECT current_setting('server_encoding') AS encoding")).rows;
  if (actual.length !== 1 || actual[0].encoding !== textEncoding.name) throw new MaintenanceFailure("source_changed", "source-clients");
  const qualified = `${quote(schema)}.${quote(table.name)}`;
  const counts = (await client.query(`SELECT count(*)::pg_catalog.text AS count FROM ${qualified}`)).rows;
  if (counts.length !== 1) invalidSourceClients();
  const count = decimal(counts[0].count);
  const projection = sourceClientColumns.flatMap(column => column.postgres === "25"
    ? [`pg_catalog.encode(pg_catalog.convert_to(${quote(column.name)},$1),'hex')`, `pg_catalog.octet_length(${quote(column.name)})::pg_catalog.text`]
    : [`${quote(column.name)}::pg_catalog.text`, "NULL::pg_catalog.text"]);
  const records = (await client.query({ text: `SELECT ${projection.join(",")} FROM ${qualified}`,
    values: [textEncoding.name], rowMode: "array" })).rows as unknown[][];
  const rows = records.map(record => {
    if (!Array.isArray(record) || record.length !== sourceClientColumns.length * 2) invalidSourceClients();
    return Object.fromEntries(sourceClientColumns.map((column, index) => {
      const value = record[index * 2], size = record[index * 2 + 1];
      if (value === null && size === null) return [column.name, ["null"]];
      if (column.postgres === "25") return [column.name, ["text", sourceClientsHex(value, decimal(size))]];
      if (typeof value !== "string" || size !== null) invalidSourceClients();
      return [column.name, ["integer", value]];
    }));
  });
  return { schemaManifestDigest: digestJson(catalog.schema), textEncoding, rows: sourceClientsRows(rows, count) };
}

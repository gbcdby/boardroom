import type { DbReadSnapshot } from "../../db/driver.ts";
import { canonicalJson, sha256 } from "./canonical.ts";
import { buildDatabaseManifests, digestRowMultiset } from "./manifests.ts";
import { parseManifests } from "./parse.ts";
import { buildLayoutMemoryInventory } from "./layout-memory-inventory.ts";
import type { EncodedCell, FrozenMemoryInputValue, LayoutMemoryInventoryValue } from "./layout-memory-inventory.ts";
import type { ReadonlyDeep } from "./layout-values.ts";
import type { SourceRef, ArtifactRef, DatabaseManifests, Json } from "./types.ts";

/** Observation input only; none of these values authenticate the source owner. */
export interface MemoryCollectionRequestValue {
  readonly contract: "layout-memory-collection-request/r1";
  readonly source: SourceRef;
  readonly frozenManifest: ArtifactRef;
  readonly storageId: string;
  readonly invocationStartedAtNs: string;
}
export interface MemoryCollectionObservation {
  readonly contract: "layout-memory-collection-observation/r1";
  readonly authority: "observation-only";
  readonly input: ReadonlyDeep<FrozenMemoryInputValue>;
  readonly inventory: ReadonlyDeep<LayoutMemoryInventoryValue>;
}
export type MemoryCollectionErrorCode = "invalid_input" | "manifest_invalid" | "source_mismatch"
  | "unsupported_catalog" | "read_unavailable" | "inventory_invalid" | "budget_exceeded";
const failures = new WeakMap<object, MemoryCollectionErrorCode>();
const invoke = Reflect.apply;
const errorCodes: readonly MemoryCollectionErrorCode[] = ["invalid_input", "manifest_invalid", "source_mismatch",
  "unsupported_catalog", "read_unavailable", "inventory_invalid", "budget_exceeded"];
export class MemoryCollectionError extends Error {
  declare readonly code: MemoryCollectionErrorCode;
  constructor(code: MemoryCollectionErrorCode) {
    const safe = errorCodes.includes(code) ? code : "invalid_input";
    super(`layout_memory_collection:${safe}`);
    Object.defineProperty(this, "name", { __proto__: null, value: "MemoryCollectionError" } as PropertyDescriptor);
    Object.defineProperty(this, "code", { __proto__: null, value: safe, enumerable: true } as PropertyDescriptor);
    failures.set(this, safe);
  }
}
function requireValue(value: unknown, code: MemoryCollectionErrorCode): asserts value { if (!value) throw new MemoryCollectionError(code); }
function sanitized(error: unknown, fallback: MemoryCollectionErrorCode) {
  const known = error !== null && (typeof error === "object" || typeof error === "function") ? failures.get(error) : undefined;
  return new MemoryCollectionError(known ?? fallback);
}
type RecordValue = Record<string, unknown>;
const MiB = 1_048_576;
const unsigned = /^(0|[1-9][0-9]*)$/;
const signed = /^(0|-?[1-9][0-9]*)$/;
const tableNames = ["memory_documents", "memory_versions", "memory_summary_requests"] as const;
const targetNames = [...tableNames, "storage_maintenance"];
const tableColumns = [
  ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
  ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
  ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
] as const;
const integerColumns: readonly (readonly number[])[] = [[4, 6], [2, 3, 5], [6, 7, 12, 18]];
const nullableColumns: readonly (readonly number[])[] = [[2, 3], [11], [4, 5, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24]];
const rowLimits = [4096, 16384, 16384];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function put(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { __proto__: null, value, enumerable: true } as PropertyDescriptor);
}
function ownData(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") && Object.hasOwn(descriptor, "writable")
    && !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set");
}
function append<T>(array: T[], value: T) { put(array, String(array.length), value); }
function record(values: RecordValue): RecordValue {
  const result = Object.create(null) as RecordValue;
  for (const key of Object.keys(values)) put(result, key, values[key]);
  return result;
}
function ownRecord(value: unknown, fields: readonly string[], code: MemoryCollectionErrorCode): RecordValue {
  requireValue(value !== null && typeof value === "object", code);
  const proto: unknown = Object.getPrototypeOf(value);
  requireValue(proto === Object.prototype || proto === null, code);
  const keys = Reflect.ownKeys(value); requireValue(keys.length === fields.length, code);
  const result = Object.create(null) as RecordValue;
  for (const key of keys) {
    requireValue(typeof key === "string" && fields.includes(key), code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(ownData(descriptor) && descriptor.enumerable, code);
    put(result, key, descriptor.value);
  }
  return result;
}
function ownArray(value: unknown, maximum: number, code: MemoryCollectionErrorCode): unknown[] {
  requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
  const keys = Reflect.ownKeys(value); requireValue(keys.length <= maximum + 1, code);
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    requireValue(typeof key === "string" && (key === "length" || unsigned.test(key)), code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(ownData(descriptor), code); descriptors.set(key, descriptor);
  }
  const length: unknown = descriptors.get("length")?.value;
  requireValue(typeof length === "number" && Number.isSafeInteger(length) && length >= 0 && length <= maximum && keys.length === length + 1, code);
  const result: unknown[] = [];
  for (let n = 0; n < length; n++) {
    const descriptor = descriptors.get(String(n));
    requireValue(descriptor && descriptor.enumerable, code); append(result, descriptor.value);
  }
  return result;
}
/** Keys consume canonical bytes but are not separate JSON value nodes. */
class Budget {
  bytes = 0;
  nodes = 0;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  charge(size: number) { this.bytes += size; requireValue(this.bytes <= this.limit, "budget_exceeded"); }
  string(value: string, code: MemoryCollectionErrorCode) {
    requireValue(value.length <= this.limit, "budget_exceeded");
    requireValue(!/[\uD800-\uDFFF]/u.test(value), code);
    this.charge(Buffer.byteLength(value) + 2);
    for (let n = 0; n < value.length; n++) {
      const c = value.charCodeAt(n);
      if (c === 34 || c === 92) this.charge(1);
      else if (c < 32) this.charge(c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 1 : 5);
    }
  }
  copy(value: unknown, code: MemoryCollectionErrorCode, depth = 0, ancestors = new Set<object>()): unknown {
    requireValue(++this.nodes <= 250_000 && depth <= 64, "budget_exceeded");
    if (value === null) { this.charge(4); return null; }
    if (typeof value === "string") { this.string(value, code); return value; }
    if (typeof value === "boolean") { this.charge(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      requireValue(Number.isSafeInteger(value) && !Object.is(value, -0), code); this.charge(String(value).length); return value;
    }
    requireValue(typeof value === "object" && !ancestors.has(value), code); ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const entries = ownArray(value, 250_000, code); this.charge(2 + Math.max(0, entries.length - 1));
        const result: unknown[] = [];
        for (const entry of entries) append(result, this.copy(entry, code, depth + 1, ancestors));
        return Object.freeze(result);
      }
      const proto: unknown = Object.getPrototypeOf(value); requireValue(proto === Object.prototype || proto === null, code);
      const keys = Reflect.ownKeys(value); requireValue(keys.length <= 250_000, "budget_exceeded");
      this.charge(2 + Math.max(0, keys.length - 1)); const result = Object.create(null) as RecordValue;
      for (const key of keys) {
        requireValue(typeof key === "string", code); const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(ownData(descriptor) && descriptor.enumerable, code);
        this.string(key, code); this.charge(1); put(result, key, this.copy(descriptor.value, code, depth + 1, ancestors));
      }
      return Object.freeze(result);
    } finally { ancestors.delete(value); }
  }
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const brandGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")!.get!;
const byteSet = Uint8Array.prototype.set;
function copyBytes(value: unknown): Uint8Array {
  requireValue(invoke(brandGetter, value, []) === "Uint8Array", "invalid_input");
  const length: unknown = invoke(byteLengthGetter, value, []);
  requireValue(typeof length === "number" && length <= 16 * MiB, "budget_exceeded");
  const buffer: unknown = invoke(bufferGetter, value, []);
  invoke(arrayBufferLength, buffer, []); // Reject SharedArrayBuffer with the intrinsic brand check.
  requireValue(invoke(resizableGetter, buffer, []) === false, "invalid_input");
  const result = new Uint8Array(length); invoke(byteSet, result, [value]); return result;
}
function decimal(value: unknown, code: MemoryCollectionErrorCode, max = 24): bigint {
  requireValue(typeof value === "string" && value.length <= max && unsigned.test(value), code); return BigInt(value);
}
function fixedRequest(value: unknown): MemoryCollectionRequestValue {
  const r = ownRecord(value, ["contract", "source", "frozenManifest", "storageId", "invocationStartedAtNs"], "invalid_input");
  const s = ownRecord(r.source, ["kind", "databaseInstanceId", "identityDigest"], "invalid_input");
  const a = ownRecord(r.frozenManifest, ["ref", "sha256", "bytes"], "invalid_input");
  requireValue(r.contract === "layout-memory-collection-request/r1" && (s.kind === "sqlite" || s.kind === "postgres")
    && typeof s.databaseInstanceId === "string" && /^[a-f0-9]{32}$/.test(s.databaseInstanceId)
    && typeof s.identityDigest === "string" && /^[a-f0-9]{64}$/.test(s.identityDigest)
    && typeof a.sha256 === "string" && /^[a-f0-9]{64}$/.test(a.sha256)
    && a.ref === `snapshots/${a.sha256}/database-manifests.json`
    && typeof r.storageId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.storageId), "invalid_input");
  decimal(a.bytes, "invalid_input"); decimal(r.invocationStartedAtNs, "invalid_input");
  return Object.freeze(record({ ...r, source: Object.freeze(s), frozenManifest: Object.freeze(a) })) as unknown as MemoryCollectionRequestValue;
}
function manifestGuard(value: unknown) {
  const stack: [unknown, number][] = [[value, 0]]; let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!; requireValue(++nodes <= 250_000 && depth <= 128, "budget_exceeded");
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "string") { requireValue(!/[\uD800-\uDFFF]/u.test(item), "manifest_invalid"); continue; }
    if (typeof item === "number") { requireValue(Number.isFinite(item) && !Object.is(item, -0) && (!Number.isInteger(item) || Number.isSafeInteger(item)), "manifest_invalid"); continue; }
    requireValue(typeof item === "object", "manifest_invalid"); const keys = Object.keys(item);
    requireValue(nodes + stack.length + keys.length <= 250_000, "budget_exceeded");
    for (const key of keys) stack.push([(item as RecordValue)[key], depth + 1]);
  }
}
function sqliteColumns(index: number): RecordValue[] {
  return tableColumns[index]!.map((name, n) => record({ cid: String(n), name, type: integerColumns[index]!.includes(n) ? "INTEGER" : "TEXT",
    notnull: nullableColumns[index]!.includes(n) ? "0" : "1", dflt_value: null, pk: n === 0 ? "1" : "0", hidden: "0" }));
}
function originalColumns(value: unknown, index: number, dialect: "sqlite" | "postgres") {
  requireValue(Array.isArray(value) && value.length === tableColumns[index]!.length, "unsupported_catalog");
  if (dialect === "sqlite") { requireValue(canonicalJson(value) === canonicalJson(sqliteColumns(index)), "unsupported_catalog"); return; }
  for (const [n, column] of value.entries()) {
    const c = ownRecord(column, ["acl", "collation", "collation_schema", "comment", "compression", "default_expression", "generated", "identity", "name", "not_null", "position", "statistics", "storage", "table_name", "type", "type_modifier", "type_oid"], "unsupported_catalog");
    const integer = integerColumns[index]!.includes(n);
    requireValue(c.name === tableColumns[index]![n] && c.position === String(n + 1) && c.table_name === tableNames[index]
      && c.type === (integer ? "integer" : "text") && c.type_oid === (integer ? "23" : "25") && c.type_modifier === -1
      && c.collation === (integer ? null : "default") && c.collation_schema === (integer ? null : "pg_catalog")
      && c.not_null === !nullableColumns[index]!.includes(n) && c.default_expression === null && c.generated === "" && c.identity === "", "unsupported_catalog");
  }
}
function fixedManifest(bytes: Uint8Array, request: MemoryCollectionRequestValue): DatabaseManifests {
  requireValue(String(bytes.length) === request.frozenManifest.bytes && sha256(bytes) === request.frozenManifest.sha256, "manifest_invalid");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const decoded: unknown = JSON.parse(text); manifestGuard(decoded); requireValue(canonicalJson(decoded) === text, "manifest_invalid");
  const m = parseManifests(decoded);
  requireValue(canonicalJson(m) === canonicalJson(buildDatabaseManifests(m.dialect, m.schema, m.tables, m.controlRows)), "manifest_invalid");
  const seen = new Set<string>();
  for (const t of m.tables) { requireValue(!seen.has(t.name) && unsigned.test(t.count), "manifest_invalid"); seen.add(t.name); }
  requireValue(m.dialect === request.source.kind, "source_mismatch");
  const markers = m.controlRows.storage_maintenance;
  requireValue(markers.length === 1 && markers[0]!.singleton === (m.dialect === "sqlite" ? "1" : 1), "manifest_invalid");
  requireValue(markers[0]!.database_instance_id === request.source.databaseInstanceId, "source_mismatch");
  for (const [n, name] of tableNames.entries()) {
    const t = m.tables.find(t => t.name === name); requireValue(t, "manifest_invalid");
    requireValue(t.count.length <= String(rowLimits[n]!).length && BigInt(t.count) <= BigInt(rowLimits[n]!), "budget_exceeded");
    originalColumns(t.columns, n, m.dialect);
  }
  return m;
}
/** Capture scalar rows before yielding. This necessary payload bound does not
 * replace or reset the single exact whole-input Budget in collectRows. */
function fixedDataRows(rows: unknown[]): readonly RecordValue[] {
  const result: RecordValue[] = []; let payload = 0;
  for (const value of rows) {
    requireValue(value !== null && typeof value === "object", "inventory_invalid");
    const proto: unknown = Object.getPrototypeOf(value); requireValue(proto === Object.prototype || proto === null, "inventory_invalid");
    const keys = Reflect.ownKeys(value); requireValue(keys.length <= 128, "inventory_invalid"); const row = Object.create(null) as RecordValue;
    for (const key of keys) {
      requireValue(typeof key === "string" && key.length <= 32, "inventory_invalid"); const d = Object.getOwnPropertyDescriptor(value, key);
      requireValue(ownData(d) && d.enumerable, "inventory_invalid"); const cell: unknown = d.value;
      requireValue(cell === null || typeof cell === "string" || typeof cell === "boolean" || typeof cell === "number" && Number.isSafeInteger(cell) && !Object.is(cell, -0), "inventory_invalid");
      if (typeof cell === "string") { requireValue(cell.length <= 32 * MiB, "budget_exceeded"); payload += Buffer.byteLength(cell); requireValue(payload <= 32 * MiB, "budget_exceeded"); }
      put(row, key, cell);
    }
    append(result, Object.freeze(row));
  }
  return Object.freeze(result);
}
function fixedQuery(snapshot: DbReadSnapshot): DbReadSnapshot["query"] {
  const descriptor = Object.getOwnPropertyDescriptor(snapshot, "query");
  requireValue(ownData(descriptor) && typeof descriptor.value === "function", "invalid_input");
  return descriptor.value as DbReadSnapshot["query"];
}
class Reader {
  readonly receiver: DbReadSnapshot;
  readonly query: DbReadSnapshot["query"];
  readonly deadline: bigint;
  readonly catalog = new Budget(MiB);
  calls = 0;
  nonPageCalls = 0;
  constructor(snapshot: DbReadSnapshot, query: DbReadSnapshot["query"], start: string) {
    this.receiver = snapshot; this.query = query;
    const time = BigInt(start); requireValue(time <= process.hrtime.bigint(), "invalid_input"); this.deadline = time + 120_000_000_000n; this.check();
  }
  check() { requireValue(process.hrtime.bigint() <= this.deadline, "budget_exceeded"); }
  async run(sql: string, params: readonly unknown[] = [], metadata = false, page = false): Promise<{ rows: unknown[] }> {
    this.check(); requireValue(++this.calls <= 512, "budget_exceeded"); if (!page) requireValue(++this.nonPageCalls <= 96, "budget_exceeded");
    const argumentsCopy = Object.freeze(params.map(v => Array.isArray(v) ? Object.freeze([...v]) : v)); let value: unknown;
    try { value = await invoke(this.query, this.receiver, [sql, argumentsCopy]); } catch { throw new MemoryCollectionError("read_unavailable"); }
    this.check(); const rows = ownArray(value, page ? 128 : 250_000, "read_unavailable");
    const fixed = metadata ? this.catalog.copy(rows, "unsupported_catalog") : fixedDataRows(rows);
    return Object.freeze(record({ rows: fixed })) as { rows: unknown[] };
  }
}
function onlyRow(rows: unknown[], fields: readonly string[], code: MemoryCollectionErrorCode) { requireValue(rows.length === 1, code); return ownRecord(rows[0], fields, code); }
function sqliteInt(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 || typeof value === "bigint" && value >= 0n) return String(value);
  throw new MemoryCollectionError("unsupported_catalog");
}
async function sqliteCatalog(reader: Reader, request: MemoryCollectionRequestValue, m: DatabaseManifests) {
  requireValue(onlyRow((await reader.run("PRAGMA query_only", [], true)).rows, ["query_only"], "unsupported_catalog").query_only === 1, "unsupported_catalog");
  requireValue(onlyRow((await reader.run("PRAGMA main.encoding", [], true)).rows, ["encoding"], "unsupported_catalog").encoding === "UTF-8", "unsupported_catalog");
  const where = "name IN ('memory_documents','memory_versions','memory_summary_requests','storage_maintenance')";
  const rows = (await reader.run(`SELECT name,type,CAST(rootpage AS TEXT) AS rootpage,CAST(length(CAST(sql AS BLOB)) AS TEXT) AS sql_bytes FROM main.sqlite_schema WHERE ${where} LIMIT 5`, [], true)).rows;
  requireValue(rows.length === 4, "unsupported_catalog"); const seen = new Set<string>();
  for (const raw of rows) {
    const r = ownRecord(raw, ["name", "type", "rootpage", "sql_bytes"], "unsupported_catalog");
    requireValue(typeof r.name === "string" && targetNames.includes(r.name) && !seen.has(r.name) && r.type === "table", "unsupported_catalog"); seen.add(r.name);
    requireValue(decimal(r.rootpage, "unsupported_catalog") > 0n && decimal(r.sql_bytes, "unsupported_catalog") <= 65536n, "unsupported_catalog");
  }
  const definitions = (await reader.run(`SELECT name,sql FROM main.sqlite_schema WHERE ${where} LIMIT 5`, [], true)).rows;
  requireValue(definitions.length === 4, "unsupported_catalog");
  for (const raw of definitions) {
    const r = ownRecord(raw, ["name", "sql"], "unsupported_catalog");
    requireValue(typeof r.name === "string" && seen.delete(r.name) && typeof r.sql === "string" && r.sql.length > 0 && Buffer.byteLength(r.sql) <= 65536 && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(r.sql), "unsupported_catalog");
  }
  for (const [n, name] of tableNames.entries()) {
    const columns = (await reader.run(`PRAGMA main.table_xinfo(${quote(name)})`, [], true)).rows;
    requireValue(columns.length === tableColumns[n]!.length && columns.length <= 64, "unsupported_catalog");
    const normal = columns.map(raw => {
      const c = ownRecord(raw, ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], "unsupported_catalog");
      return record({ cid: sqliteInt(c.cid), name: c.name, type: c.type, notnull: sqliteInt(c.notnull), dflt_value: c.dflt_value, pk: sqliteInt(c.pk), hidden: sqliteInt(c.hidden) });
    });
    requireValue(canonicalJson(normal) === canonicalJson(m.tables.find(t => t.name === name)!.columns), "unsupported_catalog");
  }
  const marker = onlyRow((await reader.run('SELECT typeof(singleton) AS singleton_type,CAST(singleton AS TEXT) AS singleton,typeof(database_instance_id) AS id_type,database_instance_id FROM main."storage_maintenance" LIMIT 2')).rows,
    ["singleton_type", "singleton", "id_type", "database_instance_id"], "source_mismatch");
  requireValue(marker.singleton_type === "integer" && marker.singleton === "1" && marker.id_type === "text" && marker.database_instance_id === request.source.databaseInstanceId, "source_mismatch");
}
function sqliteCapacity(index: number) {
  const fields = ['CAST(COUNT(*) AS TEXT) AS row_count'];
  for (const [n, name] of tableColumns[index]!.entries()) {
    const c = quote(name), kind = integerColumns[index]!.includes(n) ? "integer" : "text";
    const length = `CASE WHEN typeof(${c}) = 'text' THEN length(CAST(${c} AS BLOB)) WHEN typeof(${c}) = 'integer' THEN length(CAST(${c} AS TEXT)) ELSE 0 END`;
    const payload = `CASE WHEN typeof(${c}) = 'text' THEN 2 * length(CAST(${c} AS BLOB)) WHEN typeof(${c}) = 'integer' THEN length(CAST(${c} AS TEXT)) ELSE 0 END`;
    fields.push(`CAST(SUM(${payload}) AS TEXT) AS s${n}`, `CAST(MAX(${length}) AS TEXT) AS m${n}`, `CAST(SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) AS TEXT) AS z${n}`, `CAST(SUM(CASE WHEN typeof(${c}) = '${kind}' OR ${c} IS NULL THEN 0 ELSE 1 END) AS TEXT) AS b${n}`);
  }
  return `SELECT ${fields.join(",")} FROM main.${quote(tableNames[index]!)}`;
}
function sqlitePage(index: number) {
  const fields = tableColumns[index]!.flatMap((name, n) => { const c = quote(name); return [`typeof(${c}) AS t${n}`, `CASE WHEN typeof(${c}) = 'text' THEN hex(CAST(${c} AS BLOB)) WHEN typeof(${c}) = 'integer' THEN CAST(${c} AS TEXT) ELSE NULL END AS v${n}`]; });
  return `SELECT ${fields.join(",")} FROM main.${quote(tableNames[index]!)} ORDER BY CAST("id" AS BLOB) LIMIT ? OFFSET ?`;
}
function capacity(rows: unknown[], index: number, count: bigint, sqlite: boolean) {
  const prefixes = sqlite ? ["s", "m", "z", "b"] : ["s", "m", "z"];
  const row = onlyRow(rows, ["row_count", ...tableColumns[index]!.flatMap((_, n) => prefixes.map(p => `${p}${n}`))], "inventory_invalid");
  requireValue(decimal(row.row_count, "inventory_invalid") === count, "inventory_invalid"); let total = 0n;
  for (const [n, column] of tableColumns[index]!.entries()) {
    const values = prefixes.map(p => { const v = row[`${p}${n}`]; if (count === 0n) { requireValue(v === null, "inventory_invalid"); return 0n; } return decimal(v, "inventory_invalid"); });
    const [sum, max, nulls, bad] = values;
    requireValue(nulls! <= count && (nullableColumns[index]!.includes(n) || nulls === 0n) && (!sqlite || bad === 0n), "inventory_invalid");
    if (column === "markdown") requireValue(max! <= BigInt(MiB), "budget_exceeded"); total += sum!;
  }
  return total;
}
function encodeRow(value: unknown, index: number, sqlite: boolean): EncodedCell[] {
  const r = ownRecord(value, tableColumns[index]!.flatMap((_, n) => sqlite ? [`t${n}`, `v${n}`] : [`v${n}`]), "inventory_invalid");
  const cells: EncodedCell[] = [];
  for (let n = 0; n < tableColumns[index]!.length; n++) {
    const v = r[`v${n}`], integer = integerColumns[index]!.includes(n), nullable = nullableColumns[index]!.includes(n);
    if (sqlite && r[`t${n}`] === "null") { requireValue(nullable && v === null, "inventory_invalid"); append(cells, ["null"]); continue; }
    if (!sqlite && v === null) { requireValue(nullable, "inventory_invalid"); append(cells, [integer ? "pg:23" : "pg:25", null]); continue; }
    requireValue(typeof v === "string" && (!integer || signed.test(v)), "inventory_invalid");
    if (sqlite) { requireValue(r[`t${n}`] === (integer ? "integer" : "text") && (integer || /^(?:[0-9a-fA-F]{2})*$/.test(v)), "inventory_invalid"); append(cells, [integer ? "integer" : "text", integer ? v : v.toLowerCase()]); }
    else append(cells, [integer ? "pg:23" : "pg:25", v]);
  }
  return cells;
}
async function collectRows(reader: Reader, request: MemoryCollectionRequestValue, m: DatabaseManifests,
  countSql: (index: number) => string, capacitySql: (index: number) => string, pageSql: (index: number) => string): Promise<ReadonlyDeep<FrozenMemoryInputValue>> {
  const counts: bigint[] = [];
  for (const [n, name] of tableNames.entries()) {
    const row = onlyRow((await reader.run(countSql(n))).rows, ["row_count"], "inventory_invalid"), count = decimal(row.row_count, "inventory_invalid");
    requireValue(count <= BigInt(rowLimits[n]!), "budget_exceeded"); requireValue(String(count) === m.tables.find(t => t.name === name)!.count, "inventory_invalid"); append(counts, count);
  }
  let payload = 0n;
  for (let n = 0; n < 3; n++) { payload += capacity((await reader.run(capacitySql(n))).rows, n, counts[n]!, request.source.kind === "sqlite"); requireValue(payload <= 32n * BigInt(MiB), "budget_exceeded"); }
  const tables = tableNames.map((name, n) => { const t = m.tables.find(t => t.name === name)!; return record({ name, columns: [...tableColumns[n]!], expectedCount: t.count, expectedDigest: t.digest, rows: [] }); });
  const input = record({ contract: "layout-memory-input/r1", source: request.source, frozenManifest: request.frozenManifest, storageId: request.storageId, dialect: request.source.kind, tables });
  const budget = new Budget(32 * MiB); budget.copy(input, "inventory_invalid");
  for (let n = 0; n < 3; n++) {
    const rows = tables[n]!.rows as EncodedCell[][], count = Number(counts[n]); let previous: Buffer | undefined;
    for (let offset = 0; ; offset += 128) {
      const terminal = offset >= count;
      const page = (await reader.run(pageSql(n), [128, terminal ? count : offset], false, true)).rows;
      requireValue(page.length === (terminal ? 0 : Math.min(128, count - offset)), "inventory_invalid"); if (terminal) break;
      for (const raw of page) {
        const cells = budget.copy(encodeRow(raw, n, request.source.kind === "sqlite"), "inventory_invalid", 4) as EncodedCell[];
        if (rows.length) budget.charge(1); const id = cells[0]![1]; requireValue(typeof id === "string", "inventory_invalid");
        const key = Buffer.from(id, request.source.kind === "sqlite" ? "hex" : "utf8");
        requireValue(!previous || Buffer.compare(previous, key) < 0, "inventory_invalid"); previous = key; append(rows, cells);
      }
    }
    const digest = digestRowMultiset(rows as unknown as Json[]);
    requireValue(digest.count === tables[n]!.expectedCount && digest.digest === tables[n]!.expectedDigest, "inventory_invalid");
    Object.freeze(rows); Object.freeze(tables[n]!.columns); Object.freeze(tables[n]);
  }
  Object.freeze(tables); return Object.freeze(input) as unknown as ReadonlyDeep<FrozenMemoryInputValue>;
}

// Accepted BR-S4-MEMORY-COLLECTOR-20261118-r4, FREEZE SHA256
// 175284124e6fbf543743450e3c28bfc56df05246034cc2b32ad9d9643057c64f.
// Fixed fingerprints cover every ordered builtin field; nothing is learned
// from the caller's database. Only declared node-location holes may vary.
interface PgSection { readonly query: string; readonly fields: readonly string[]; readonly maximumRows: number;
  readonly bounds: readonly (readonly [number, number])[]; readonly sha256?: string }
const pgFixed = {"entry":"WITH s AS MATERIALIZED (\nSELECT pg_catalog.pg_current_snapshot() AS snapshot,\npg_catalog.pg_current_xact_id_if_assigned() AS prior\n)\nSELECT pg_catalog.current_setting('server_version_num') AS server_version_num,\npg_catalog.current_setting('server_encoding') AS server_encoding,\npg_catalog.current_setting('client_encoding') AS client_encoding,\npg_catalog.current_setting('transaction_read_only') AS readonly,\npg_catalog.current_setting('transaction_isolation') AS isolation,\npg_catalog.current_schema()::pg_catalog.text AS schema,\npg_catalog.current_database()::pg_catalog.text AS database_name,\npg_catalog.pg_backend_pid()::pg_catalog.text AS pid,\npg_catalog.pg_is_in_recovery() AS recovery,\nprior::pg_catalog.text AS prior,\nCASE WHEN pg_catalog.pg_snapshot_xmin(snapshot) OPERATOR(pg_catalog.=) pg_catalog.pg_snapshot_xmax(snapshot)\nTHEN snapshot::pg_catalog.text ELSE NULL END AS snapshot,\npg_catalog.pg_snapshot_xmin(snapshot)::pg_catalog.text AS xmin,\npg_catalog.pg_snapshot_xmax(snapshot)::pg_catalog.text AS xmax\nFROM s","gate":"WITH before_assignment AS MATERIALIZED (\nSELECT pg_catalog.pg_current_xact_id_if_assigned() AS prior,pg_catalog.pg_current_snapshot() AS snapshot\n)\nSELECT prior::pg_catalog.text AS prior,\nCASE WHEN pg_catalog.pg_snapshot_xmin(snapshot) OPERATOR(pg_catalog.=) pg_catalog.pg_snapshot_xmax(snapshot)\nTHEN snapshot::pg_catalog.text ELSE NULL END AS snapshot,\npg_catalog.pg_snapshot_xmin(snapshot)::pg_catalog.text AS xmin,\npg_catalog.pg_snapshot_xmax(snapshot)::pg_catalog.text AS xmax,\npg_catalog.pg_current_xact_id()::pg_catalog.text AS assigned\nFROM before_assignment","postSettings":"SELECT pg_catalog.current_setting('server_version_num') AS server_version_num,\npg_catalog.current_setting('server_encoding') AS server_encoding,\npg_catalog.current_setting('client_encoding') AS client_encoding,\npg_catalog.current_setting('transaction_read_only') AS readonly,\npg_catalog.current_setting('transaction_isolation') AS isolation,\npg_catalog.current_schema()::pg_catalog.text AS schema,\npg_catalog.current_database()::pg_catalog.text AS database_name,\npg_catalog.pg_backend_pid()::pg_catalog.text AS pid,pg_catalog.pg_is_in_recovery() AS recovery","catalogLocks":["LOCK TABLE ONLY pg_catalog.\"pg_namespace\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_class\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_attribute\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_type\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_attrdef\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_index\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_inherits\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_am\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_constraint\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_opclass\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_opfamily\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_amop\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_amproc\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_operator\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_proc\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_collation\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_cast\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_aggregate\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_rewrite\" IN SHARE MODE NOWAIT","LOCK TABLE ONLY pg_catalog.\"pg_statistic_ext\" IN SHARE MODE NOWAIT"],"targetLocks":["LOCK TABLE ONLY {{schema}}.\"memory_documents\" IN ACCESS SHARE MODE NOWAIT","LOCK TABLE ONLY {{schema}}.\"memory_versions\" IN ACCESS SHARE MODE NOWAIT","LOCK TABLE ONLY {{schema}}.\"memory_summary_requests\" IN ACCESS SHARE MODE NOWAIT","LOCK TABLE ONLY {{schema}}.\"storage_maintenance\" IN ACCESS SHARE MODE NOWAIT"],"databaseIdentity":"SELECT d.oid::pg_catalog.text AS oid FROM pg_catalog.pg_database d\nWHERE d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database() LIMIT 2","blockedObjects":"SELECT\nEXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])) AS rules,\nEXISTS(SELECT 1 FROM pg_catalog.pg_statistic_ext WHERE stxrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])) AS statistics,\nEXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) OR inhparent OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])) AS inheritance,\nEXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_index i ON a.attrelid OPERATOR(pg_catalog.=) i.indexrelid\nWHERE i.indrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) AND a.attoptions IS NOT NULL) AS index_attribute_options","lockState":"SELECT l.relation::pg_catalog.text AS oid,l.mode::pg_catalog.text AS mode,\nl.database::pg_catalog.text AS database,l.pid::pg_catalog.text AS pid,l.granted\nFROM pg_catalog.pg_locks l\nWHERE l.pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()\nAND l.database OPERATOR(pg_catalog.=) ?::pg_catalog.oid\nAND l.granted\nAND ((l.relation OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])\nAND l.mode OPERATOR(pg_catalog.=) 'ShareLock'::pg_catalog.text)\nOR (l.relation OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])\nAND l.mode OPERATOR(pg_catalog.=) 'AccessShareLock'::pg_catalog.text))\nLIMIT 25","marker":"SELECT singleton::pg_catalog.text AS singleton,database_instance_id::pg_catalog.text AS database_instance_id FROM ONLY {{schema}}.\"storage_maintenance\" LIMIT 2"} as const;
const pgSections: Readonly<Record<string, PgSection>> = {
  "relations": {"query":"SELECT c.oid::pg_catalog.text AS oid,c.relname,c.relnamespace::pg_catalog.text AS namespace,c.relispartition,c.relkind,c.relpersistence,c.relam::pg_catalog.text AS am,c.relrowsecurity,c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE n.nspname OPERATOR(pg_catalog.=) ? AND c.relname OPERATOR(pg_catalog.=) ANY(?::pg_catalog.text[]) ORDER BY c.relname USING OPERATOR(pg_catalog.<)","fields":["oid","relname","namespace","relispartition","relkind","relpersistence","am","relrowsecurity","relforcerowsecurity"],"maximumRows":4,"bounds":[[10,0],[63,0],[10,0],[5,0],[1,0],[1,0],[10,0],[5,0],[5,0]]},
  "columns": {"query":"SELECT c.relname AS table_name,a.attnum,a.attname,a.atttypid::pg_catalog.text AS type,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation::pg_catalog.text AS collation,d.adbin::pg_catalog.text AS default_node FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) a.attrelid LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid OPERATOR(pg_catalog.=) a.attrelid AND d.adnum OPERATOR(pg_catalog.=) a.attnum WHERE a.attrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) AND a.attnum OPERATOR(pg_catalog.>) 0 ORDER BY c.relname USING OPERATOR(pg_catalog.<),a.attnum USING OPERATOR(pg_catalog.<)","fields":["table_name","attnum","attname","type","atttypmod","attnotnull","attidentity","attgenerated","attisdropped","collation","default_node"],"maximumRows":62,"bounds":[[23,0],[2,0],[23,0],[2,0],[2,0],[5,0],[0,0],[0,0],[5,0],[3,0],[2048,58]]},
  "indexes": {"query":"SELECT t.relname AS table_name,c.relname AS name,c.relkind,c.relpersistence,c.relam::pg_catalog.text AS am,c.reltablespace::pg_catalog.text AS tablespace,c.reloptions,i.indnatts,i.indnkeyatts,i.indisunique,i.indnullsnotdistinct,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisclustered,i.indisvalid,i.indcheckxmin,i.indisready,i.indislive,i.indisreplident,i.indkey::pg_catalog.text AS keys,i.indcollation::pg_catalog.text AS collations,i.indclass::pg_catalog.text AS opclasses,i.indoption::pg_catalog.text AS options,i.indexprs::pg_catalog.text AS expressions,i.indpred::pg_catalog.text AS predicate FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) i.indexrelid JOIN pg_catalog.pg_class t ON t.oid OPERATOR(pg_catalog.=) i.indrelid WHERE i.indrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY t.relname USING OPERATOR(pg_catalog.<),c.relname USING OPERATOR(pg_catalog.<)","fields":["table_name","name","relkind","relpersistence","am","tablespace","reloptions","indnatts","indnkeyatts","indisunique","indnullsnotdistinct","indisprimary","indisexclusion","indimmediate","indisclustered","indisvalid","indcheckxmin","indisready","indislive","indisreplident","keys","collations","opclasses","options","expressions","predicate"],"maximumRows":17,"bounds":[[23,0],[59,0],[1,0],[1,0],[3,0],[1,0],[0,17],[1,0],[1,0],[5,0],[5,0],[5,0],[5,0],[4,0],[5,0],[4,0],[5,0],[4,0],[4,0],[5,0],[10,0],[19,0],[24,0],[9,0],[0,17],[2048,14]]},
  "opclasses": {"query":"SELECT oid::pg_catalog.text AS oid,opcmethod::pg_catalog.text AS method,opcname,opcnamespace::pg_catalog.text AS namespace,opcfamily::pg_catalog.text AS family,opcintype::pg_catalog.text AS input,opcdefault,opckeytype::pg_catalog.text AS key_type FROM pg_catalog.pg_opclass WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","method","opcname","namespace","family","input","opcdefault","key_type"],"maximumRows":2,"bounds":[[4,0],[3,0],[8,0],[2,0],[4,0],[2,0],[4,0],[1,0]],"sha256":"a19681e7652a5c48c283acde5967ebedb65a388f2343236f38a46536cd150b07"},
  "opfamilies": {"query":"SELECT oid::pg_catalog.text AS oid,opfmethod::pg_catalog.text AS method,opfname,opfnamespace::pg_catalog.text AS namespace FROM pg_catalog.pg_opfamily WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","method","opfname","namespace"],"maximumRows":3,"bounds":[[4,0],[3,0],[16,0],[2,0]],"sha256":"e33fb6688ce4398a48d437789805e032d5d41830e21b3c7341a521e5c03b096f"},
  "amop": {"query":"SELECT oid::pg_catalog.text AS oid,amopfamily::pg_catalog.text AS family,amoplefttype::pg_catalog.text AS left_type,amoprighttype::pg_catalog.text AS right_type,amopstrategy,amoppurpose,amopopr::pg_catalog.text AS operator,amopmethod::pg_catalog.text AS method,amopsortfamily::pg_catalog.text AS sort_family FROM pg_catalog.pg_amop WHERE amopfamily OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) OR (amopmethod OPERATOR(pg_catalog.=) 403 AND amopopr OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","family","left_type","right_type","amopstrategy","amoppurpose","operator","method","sort_family"],"maximumRows":70,"bounds":[[5,0],[4,0],[2,0],[2,0],[1,0],[1,0],[4,0],[3,0],[1,0]],"sha256":"7010c239a860d598d547b9b04871e05f25055364e42d9c291048c762dc476708"},
  "amproc": {"query":"SELECT oid::pg_catalog.text AS oid,amprocfamily::pg_catalog.text AS family,amproclefttype::pg_catalog.text AS left_type,amprocrighttype::pg_catalog.text AS right_type,amprocnum,amproc::pg_catalog.oid::pg_catalog.text AS function FROM pg_catalog.pg_amproc WHERE amprocfamily OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","family","left_type","right_type","amprocnum","function"],"maximumRows":33,"bounds":[[5,0],[4,0],[2,0],[2,0],[1,0],[4,0]],"sha256":"e27468246523a5da50d1d32a048d3cae5e70a33c92178879a5ab357069b01383"},
  "am": {"query":"SELECT oid::pg_catalog.text AS oid,amname,amhandler::pg_catalog.oid::pg_catalog.text AS handler,amtype FROM pg_catalog.pg_am WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","amname","handler","amtype"],"maximumRows":2,"bounds":[[3,0],[5,0],[3,0],[1,0]],"sha256":"b5aea9e498b1e01b34ba13254aa923aee37e999eee748f1730d18d6836ba39e5"},
  "operators": {"query":"SELECT oid::pg_catalog.text AS oid,oprname,oprnamespace::pg_catalog.text AS namespace,oprkind,oprcanmerge,oprcanhash,oprleft::pg_catalog.text AS left_type,oprright::pg_catalog.text AS right_type,oprresult::pg_catalog.text AS result_type,oprcom::pg_catalog.text AS commutator,oprnegate::pg_catalog.text AS negator,oprcode::pg_catalog.oid::pg_catalog.text AS function,oprrest::pg_catalog.oid::pg_catalog.text AS restrict_function,oprjoin::pg_catalog.oid::pg_catalog.text AS join_function FROM pg_catalog.pg_operator WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","oprname","namespace","oprkind","oprcanmerge","oprcanhash","left_type","right_type","result_type","commutator","negator","function","restrict_function","join_function"],"maximumRows":82,"bounds":[[4,0],[4,0],[2,0],[1,0],[5,0],[5,0],[2,0],[2,0],[2,0],[4,0],[4,0],[4,0],[3,0],[3,0]],"sha256":"e8e46e254362a6c602b8081ab2984ed2740dc727d7a5e404b707d3991597489d"},
  "procedures": {"query":"SELECT oid::pg_catalog.text AS oid,proname,pronamespace::pg_catalog.text AS namespace,prolang::pg_catalog.text AS language,procost::pg_catalog.text AS cost,prorows::pg_catalog.text AS rows,provariadic::pg_catalog.text AS variadic,prosupport::pg_catalog.oid::pg_catalog.text AS support,prokind,prosecdef,proleakproof,proisstrict,proretset,provolatile,proparallel,pronargs,pronargdefaults,prorettype::pg_catalog.text AS result_type,proargtypes::pg_catalog.text AS argument_types,proallargtypes::pg_catalog.text AS all_argument_types,proargmodes::pg_catalog.text AS argument_modes,proargnames::pg_catalog.text AS argument_names,proargdefaults::pg_catalog.text AS defaults,protrftypes::pg_catalog.text AS transform_types,prosrc,probin,prosqlbody::pg_catalog.text AS sql_body,proconfig::pg_catalog.text AS config FROM pg_catalog.pg_proc WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","proname","namespace","language","cost","rows","variadic","support","prokind","prosecdef","proleakproof","proisstrict","proretset","provolatile","proparallel","pronargs","pronargdefaults","result_type","argument_types","all_argument_types","argument_modes","argument_names","defaults","transform_types","prosrc","probin","sql_body","config"],"maximumRows":166,"bounds":[[4,0],[27,0],[2,0],[2,0],[1,0],[1,0],[1,0],[4,0],[1,0],[5,0],[5,0],[5,0],[5,0],[1,0],[1,0],[1,0],[1,0],[4,0],[20,0],[0,166],[0,166],[0,166],[0,166],[0,166],[27,0],[0,166],[0,166],[0,166]],"sha256":"96a957a5bc37cd7d052e3799db6a907b49f2457e9b61bd56102ff9d46c9f1c4c"},
  "types": {"query":"SELECT oid::pg_catalog.text AS oid,typname,typnamespace::pg_catalog.text AS namespace,typlen,typbyval,typtype,typcategory,typispreferred,typisdefined,typdelim,typrelid::pg_catalog.text AS relation,typsubscript::pg_catalog.oid::pg_catalog.text AS subscript,typelem::pg_catalog.text AS element,typinput::pg_catalog.oid::pg_catalog.text AS input,typoutput::pg_catalog.oid::pg_catalog.text AS output,typreceive::pg_catalog.oid::pg_catalog.text AS receive,typsend::pg_catalog.oid::pg_catalog.text AS send,typmodin::pg_catalog.oid::pg_catalog.text AS mod_in,typmodout::pg_catalog.oid::pg_catalog.text AS mod_out,typanalyze::pg_catalog.oid::pg_catalog.text AS analyze,typalign,typstorage,typnotnull,typbasetype::pg_catalog.text AS base_type,typtypmod,typndims,typcollation::pg_catalog.text AS collation FROM pg_catalog.pg_type WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","typname","namespace","typlen","typbyval","typtype","typcategory","typispreferred","typisdefined","typdelim","relation","subscript","element","input","output","receive","send","mod_in","mod_out","analyze","typalign","typstorage","typnotnull","base_type","typtypmod","typndims","collation"],"maximumRows":6,"bounds":[[2,0],[4,0],[2,0],[2,0],[5,0],[1,0],[1,0],[5,0],[4,0],[1,0],[1,0],[4,0],[2,0],[4,0],[4,0],[4,0],[4,0],[1,0],[1,0],[1,0],[1,0],[1,0],[5,0],[1,0],[2,0],[1,0],[3,0]],"sha256":"d212d1c0eb167a15364375254ee96291c3f3512c09075f0bf07c0f92877805cb"},
  "collations": {"query":"SELECT oid::pg_catalog.text AS oid,collname,collnamespace::pg_catalog.text AS namespace,collprovider,collisdeterministic,collencoding,collcollate,collctype,colliculocale,collicurules,collversion FROM pg_catalog.pg_collation WHERE oid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","collname","namespace","collprovider","collisdeterministic","collencoding","collcollate","collctype","colliculocale","collicurules","collversion"],"maximumRows":2,"bounds":[[3,0],[7,0],[2,0],[1,0],[4,0],[2,0],[1,1],[1,1],[0,2],[0,2],[0,2]],"sha256":"6a4019fb2f42abeff560e851b1c35a095559cbf7dc865f2849924333ef68e26f"},
  "casts": {"query":"SELECT oid::pg_catalog.text AS oid,castsource::pg_catalog.text AS source,casttarget::pg_catalog.text AS target,castfunc::pg_catalog.oid::pg_catalog.text AS function,castcontext,castmethod FROM pg_catalog.pg_cast WHERE castsource OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[]) AND casttarget OPERATOR(pg_catalog.=) 25 ORDER BY oid USING OPERATOR(pg_catalog.<)","fields":["oid","source","target","function","castcontext","castmethod"],"maximumRows":0,"bounds":[[0,0],[0,0],[0,0],[0,0],[0,0],[0,0]],"sha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},
  "aggregates": {"query":"SELECT a.aggfnoid::pg_catalog.oid::pg_catalog.text AS function,a.aggkind,a.aggnumdirectargs,a.aggtransfn::pg_catalog.oid::pg_catalog.text AS trans,a.aggfinalfn::pg_catalog.oid::pg_catalog.text AS final,a.aggcombinefn::pg_catalog.oid::pg_catalog.text AS combine,a.aggserialfn::pg_catalog.oid::pg_catalog.text AS serial,a.aggdeserialfn::pg_catalog.oid::pg_catalog.text AS deserial,a.aggmtransfn::pg_catalog.oid::pg_catalog.text AS moving_trans,a.aggminvtransfn::pg_catalog.oid::pg_catalog.text AS moving_inverse,a.aggmfinalfn::pg_catalog.oid::pg_catalog.text AS moving_final,a.aggfinalextra,a.aggmfinalextra,a.aggfinalmodify,a.aggmfinalmodify,a.aggsortop::pg_catalog.text AS sort_operator,a.aggtranstype::pg_catalog.text AS trans_type,a.aggtransspace,a.aggmtranstype::pg_catalog.text AS moving_trans_type,a.aggmtransspace,a.agginitval,a.aggminitval FROM pg_catalog.pg_aggregate a JOIN pg_catalog.pg_proc p ON p.oid OPERATOR(pg_catalog.=) a.aggfnoid WHERE p.pronamespace OPERATOR(pg_catalog.=) 11 AND ((p.proname OPERATOR(pg_catalog.=) 'count' AND p.pronargs OPERATOR(pg_catalog.=) 0) OR (p.proname OPERATOR(pg_catalog.=) ANY(ARRAY['sum'::pg_catalog.name,'max'::pg_catalog.name]) AND p.proargtypes::pg_catalog.text OPERATOR(pg_catalog.=) '23')) ORDER BY a.aggfnoid USING OPERATOR(pg_catalog.<)","fields":["function","aggkind","aggnumdirectargs","trans","final","combine","serial","deserial","moving_trans","moving_inverse","moving_final","aggfinalextra","aggmfinalextra","aggfinalmodify","aggmfinalmodify","sort_operator","trans_type","aggtransspace","moving_trans_type","aggmtransspace","agginitval","aggminitval"],"maximumRows":3,"bounds":[[4,0],[1,0],[1,0],[4,0],[1,0],[3,0],[1,0],[1,0],[4,0],[4,0],[4,0],[5,0],[5,0],[1,0],[1,0],[3,0],[2,0],[1,0],[4,0],[1,0],[1,2],[5,1]],"sha256":"11f84fdfefdda80968eae9dc9db93ec7c7405b85f68b56ba1c15bc2ac967e7d1"}
};
const pgSupplements: Readonly<Record<string, PgSection>> = {"catalogIdentities":{"query":"SELECT c.oid::pg_catalog.text AS oid,c.relname::pg_catalog.text AS name\nFROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n\nON n.oid OPERATOR(pg_catalog.=) c.relnamespace\nWHERE n.nspname OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.name\nAND c.relname OPERATOR(pg_catalog.=) ANY(?::pg_catalog.text[])","fields":["oid","name"],"maximumRows":20,"bounds":[[10,0],[63,0]]},"keyLinks":{"query":"SELECT c.conrelid::pg_catalog.text AS relation,c.conindid::pg_catalog.text AS index,\nc.contype::pg_catalog.text AS kind,c.conkey::pg_catalog.text AS keys\nFROM pg_catalog.pg_constraint c\nWHERE c.conrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])\nAND c.contype::pg_catalog.text OPERATOR(pg_catalog.=) ANY(ARRAY['p'::pg_catalog.text,'u'::pg_catalog.text])","fields":["relation","index","kind","keys"],"maximumRows":8,"bounds":[[10,0],[10,0],[1,0],[32,0]]},"indexIdentities":{"query":"SELECT i.indexrelid::pg_catalog.text AS oid,c.relname::pg_catalog.text AS name,\ni.indrelid::pg_catalog.text AS relation\nFROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) i.indexrelid\nWHERE i.indrelid OPERATOR(pg_catalog.=) ANY(?::pg_catalog.oid[])","fields":["oid","name","relation"],"maximumRows":17,"bounds":[[10,0],[63,0],[10,0]]}};
const pgExpectedColumns: readonly RecordValue[] = [
  {"table_name":"memory_documents","attnum":1,"attname":"id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":2,"attname":"scope","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":3,"attname":"project_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":4,"attname":"agent_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":5,"attname":"version","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_documents","attnum":6,"attname":"markdown","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":7,"attname":"byte_length","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_documents","attnum":8,"attname":"updated_at","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":9,"attname":"updated_by","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_documents","attnum":10,"attname":"source","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":1,"attname":"id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":2,"attname":"project_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":3,"attname":"agent_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":4,"attname":"recipient_member_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":5,"attname":"context_group_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":6,"attname":"document_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":7,"attname":"base_version","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_summary_requests","attnum":8,"attname":"revision","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_summary_requests","attnum":9,"attname":"state","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":10,"attname":"trigger","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":11,"attname":"trigger_key","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":12,"attname":"task_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":13,"attname":"completed_task_revision","type":"23","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_summary_requests","attnum":14,"attname":"message_ids","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":15,"attname":"source_work_event_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":16,"attname":"retry_of_request_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":17,"attname":"attempt_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":18,"attname":"begin_mutation_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":19,"attname":"result_version","type":"23","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_summary_requests","attnum":20,"attname":"result_sha256","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":21,"attname":"error","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":22,"attname":"evidence","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":23,"attname":"created_at","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":24,"attname":"started_at","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_summary_requests","attnum":25,"attname":"finished_at","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":1,"attname":"id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":2,"attname":"document_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":3,"attname":"version","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_versions","attnum":4,"attname":"parent_version","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_versions","attnum":5,"attname":"markdown","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":6,"attname":"byte_length","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"memory_versions","attnum":7,"attname":"content_sha256","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":8,"attname":"author","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":9,"attname":"actor_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":10,"attname":"source","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":11,"attname":"client_mutation_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":12,"attname":"summary_request_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"memory_versions","attnum":13,"attname":"created_at","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":1,"attname":"singleton","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"storage_maintenance","attnum":2,"attname":"database_instance_id","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":3,"attname":"control_root_json","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":4,"attname":"mutex_identity_json","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":5,"attname":"fence_epoch","type":"20","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":"{FUNCEXPR :funcid 481 :funcresulttype 20 :funcretset false :funcvariadic false :funcformat 2 :funccollid 0 :inputcollid 0 :args ({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location 228 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]}) :location -1}"},
  {"table_name":"storage_maintenance","attnum":6,"attname":"admission","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":"{CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location 290 :constvalue 8 [ 32 0 0 0 111 112 101 110 ]}"},
  {"table_name":"storage_maintenance","attnum":7,"attname":"active_migration_id","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":8,"attname":"plan_digest","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":9,"attname":"owner_generation","type":"20","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":"{FUNCEXPR :funcid 481 :funcresulttype 20 :funcretset false :funcvariadic false :funcformat 2 :funccollid 0 :inputcollid 0 :args ({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location 439 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]}) :location -1}"},
  {"table_name":"storage_maintenance","attnum":10,"attname":"journal_record_ref","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":11,"attname":"journal_digest","type":"25","atttypmod":-1,"attnotnull":false,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null},
  {"table_name":"storage_maintenance","attnum":12,"attname":"journal_sequence","type":"20","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":"{FUNCEXPR :funcid 481 :funcresulttype 20 :funcretset false :funcvariadic false :funcformat 2 :funccollid 0 :inputcollid 0 :args ({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location 565 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]}) :location -1}"},
  {"table_name":"storage_maintenance","attnum":13,"attname":"protocol_version","type":"23","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"0","default_node":null},
  {"table_name":"storage_maintenance","attnum":14,"attname":"guard_manifest_digest","type":"25","atttypmod":-1,"attnotnull":true,"attidentity":"","attgenerated":"","attisdropped":false,"collation":"100","default_node":null}
];
const pgExpectedIndexes: readonly RecordValue[] = [
  {"table_name":"memory_documents","name":"ix_memory_documents_project","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":3,"indnkeyatts":3,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"3 8 1","collations":"100 100 100","opclasses":"3126 3126 3126","options":"0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_documents","name":"memory_documents_pkey","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":true,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"1","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"memory_documents","name":"ux_memory_global","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"4","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":"{OPEXPR :opno 98 :opfuncid 67 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 2 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 2 :location 917} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location 925 :constvalue 10 [ 40 0 0 0 103 108 111 98 97 108 ]}) :location 923}"},
  {"table_name":"memory_documents","name":"ux_memory_project","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"3","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":"{OPEXPR :opno 98 :opfuncid 67 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 2 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 2 :location 1016} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location 1024 :constvalue 11 [ 44 0 0 0 112 114 111 106 101 99 116 ]}) :location 1022}"},
  {"table_name":"memory_documents","name":"ux_memory_project_agent","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":2,"indnkeyatts":2,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"3 4","collations":"100 100","opclasses":"3126 3126","options":"0 0","expressions":null,"predicate":"{OPEXPR :opno 98 :opfuncid 67 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 2 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 2 :location 1132} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location 1140 :constvalue 17 [ 68 0 0 0 112 114 111 106 101 99 116 45 97 103 101 110 116 ]}) :location 1138}"},
  {"table_name":"memory_summary_requests","name":"ix_memory_requests_agent","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":5,"indnkeyatts":5,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2 3 9 23 1","collations":"100 100 100 100 100","opclasses":"3126 3126 3126 3126 3126","options":"0 0 0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"ix_memory_requests_expiry","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":5,"indnkeyatts":5,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2 3 9 24 1","collations":"100 100 100 100 100","opclasses":"3126 3126 3126 3126 3126","options":"0 0 0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"ix_memory_requests_group","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"5","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"ix_memory_requests_recipient_seek","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":3,"indnkeyatts":3,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"4 9 1","collations":"100 100 100","opclasses":"3126 3126 3126","options":"0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"ix_memory_requests_source","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":false,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"15","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"memory_summary_requests_pkey","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":true,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"1","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"memory_summary_requests","name":"memory_summary_requests_project_id_agent_id_trigger_key_key","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":3,"indnkeyatts":3,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2 3 11","collations":"100 100 100","opclasses":"3126 3126 3126","options":"0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_versions","name":"memory_versions_document_id_actor_id_client_mutation_id_key","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":3,"indnkeyatts":3,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2 9 11","collations":"100 100 100","opclasses":"3126 3126 3126","options":"0 0 0","expressions":null,"predicate":null},
  {"table_name":"memory_versions","name":"memory_versions_document_id_version_key","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":2,"indnkeyatts":2,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2 3","collations":"100 0","opclasses":"3126 1978","options":"0 0","expressions":null,"predicate":null},
  {"table_name":"memory_versions","name":"memory_versions_pkey","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":true,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"1","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"storage_maintenance","name":"storage_maintenance_database_instance_id_key","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":false,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"2","collations":"100","opclasses":"3126","options":"0","expressions":null,"predicate":null},
  {"table_name":"storage_maintenance","name":"storage_maintenance_pkey","relkind":"i","relpersistence":"p","am":"403","tablespace":"0","reloptions":null,"indnatts":1,"indnkeyatts":1,"indisunique":true,"indnullsnotdistinct":false,"indisprimary":true,"indisexclusion":false,"indimmediate":true,"indisclustered":false,"indisvalid":true,"indcheckxmin":false,"indisready":true,"indislive":true,"indisreplident":false,"keys":"1","collations":"0","opclasses":"1978","options":"0","expressions":null,"predicate":null}
];
const pgBuiltinIds = {"opclasses":["1978","3126"],"opfamilies":["1976","1994","2095"],"am":["2","403"],"operators":["15","1862","1863","1864","1865","1866","1867","1868","1869","1870","1871","1872","1873","2314","2315","2317","2318","254","255","256","257","258","259","260","261","262","263","264","265","36","37","410","411","412","413","414","415","416","417","418","419","420","430","518","519","520","521","522","523","524","525","531","532","533","534","535","536","537","538","539","540","541","542","543","643","660","661","662","663","664","665","666","667","76","80","82","93","94","95","96","97","98"],"procedures":["101","102","103","104","105","106","107","108","1219","1242","1243","1374","1375","144","145","146","147","148","149","150","151","157","158","159","160","161","162","163","164","165","166","167","168","1682","169","1841","1850","1851","1852","1853","1854","1855","1856","1857","1858","1859","1860","1861","1963","2108","2116","2160","2161","2163","2164","2166","2188","2189","2190","2191","2192","2193","240","2404","2405","2406","2407","2408","2409","241","2414","2415","242","2422","2423","243","2436","2437","244","245","246","247","248","249","250","251","252","253","2803","3","3129","3130","3131","3135","3255","330","3332","336","337","34","35","350","351","3546","3571","3572","359","360","38","386","39","398","4126","4127","4128","4129","4130","4131","4132","42","43","46","460","461","463","467","468","469","47","470","471","472","474","475","476","477","478","479","5050","5051","6180","62","6236","63","64","65","655","656","657","658","659","66","67","720","740","741","742","743","768","842","852","853","854","855","856","857"],"types":["16","19","20","21","23","25"],"collations":["100","950"]} as const;
const pgCatalogNames = ["pg_namespace","pg_class","pg_attribute","pg_type","pg_attrdef","pg_index","pg_inherits","pg_am","pg_constraint","pg_opclass","pg_opfamily","pg_amop","pg_amproc","pg_operator","pg_proc","pg_collation","pg_cast","pg_aggregate","pg_rewrite","pg_statistic_ext"] as const;


function pgAggregates(fields: readonly string[], prefix = ""): string {
  const parts = ["pg_catalog.count(*)::pg_catalog.text AS row_count"];
  for (const [n, name] of fields.entries()) {
    const c = prefix + quote(name);
    const payload = `CASE WHEN ${c} IS NULL THEN 0::pg_catalog.int4 ELSE pg_catalog.octet_length(${c}::pg_catalog.text) END`;
    const nulls = `CASE WHEN ${c} IS NULL THEN 1::pg_catalog.int4 ELSE 0::pg_catalog.int4 END`;
    parts.push(`pg_catalog.sum(${payload})::pg_catalog.text AS ${quote(`s${n}`)}`, `pg_catalog.max(${payload})::pg_catalog.text AS ${quote(`m${n}`)}`, `pg_catalog.sum(${nulls})::pg_catalog.text AS ${quote(`z${n}`)}`);
  }
  return parts.join(",");
}
function pgPreflight(section: PgSection) {
  const order = section.query.lastIndexOf(" ORDER BY "), base = order < 0 ? section.query : section.query.slice(0, order);
  return `WITH bounded AS MATERIALIZED (${base} LIMIT ${section.maximumRows + 1}) SELECT ${pgAggregates(section.fields, "b.")} FROM bounded b`;
}
function pgNode(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null;
  if (typeof actual !== "string" || typeof expected !== "string" || Buffer.byteLength(actual) > 2048) return false;
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); let start = 0, pattern = "^", holes = 0;
  for (const match of expected.matchAll(/:location (-?\d+)/g)) {
    const end = match.index + ":location ".length;
    pattern += escape(expected.slice(start, end)) + "(-1|0|[1-9][0-9]{0,9})"; start = match.index + match[0].length; holes++;
  }
  const found = new RegExp(pattern + escape(expected.slice(start)) + "$").exec(actual);
  return !!found && found.length === holes + 1 && found.slice(1).every(v => BigInt(v) <= 2147483647n);
}
function pgProfile(actual: RecordValue[], expected: readonly RecordValue[], nodeField: string) {
  requireValue(actual.length === expected.length, "unsupported_catalog");
  for (const [n, row] of actual.entries()) {
    const desired = expected[n]!; requireValue(Object.keys(row).length === Object.keys(desired).length, "unsupported_catalog");
    for (const key of Object.keys(desired)) requireValue(key === nodeField ? pgNode(row[key], desired[key]) : canonicalJson(row[key]) === canonicalJson(desired[key]), "unsupported_catalog");
  }
}
async function pgCatalogSection(reader: Reader, section: PgSection, params: readonly unknown[]): Promise<{ rows: RecordValue[] }> {
  const p = onlyRow((await reader.run(pgPreflight(section), params, true)).rows, ["row_count", ...section.fields.flatMap((_, n) => [`s${n}`, `m${n}`, `z${n}`])], "unsupported_catalog");
  const count = decimal(p.row_count, "unsupported_catalog"); requireValue(count === BigInt(section.maximumRows), "unsupported_catalog"); let payload = 0n;
  for (let n = 0; n < section.fields.length; n++) {
    if (count === 0n) { requireValue(p[`s${n}`] === null && p[`m${n}`] === null && p[`z${n}`] === null, "unsupported_catalog"); continue; }
    const sum = decimal(p[`s${n}`], "unsupported_catalog"), max = decimal(p[`m${n}`], "unsupported_catalog"), nulls = decimal(p[`z${n}`], "unsupported_catalog"), bounds = section.bounds[n]!;
    requireValue(nulls === BigInt(bounds[1]) && max <= BigInt(bounds[0]) && sum <= count * BigInt(bounds[0]), "unsupported_catalog");
    payload += sum; requireValue(payload <= BigInt(MiB), "budget_exceeded");
  }
  const raw = (await reader.run(`${section.query} LIMIT ${section.maximumRows + 1}`, params, true)).rows;
  requireValue(raw.length === section.maximumRows, "unsupported_catalog"); const rows = raw.map(row => ownRecord(row, section.fields, "unsupported_catalog"));
  if (section.sha256) requireValue(sha256(canonicalJson(rows)) === section.sha256, "unsupported_catalog");
  return Object.freeze(record({ rows })) as { rows: RecordValue[] };
}
function pgOid(value: unknown): string { const n = decimal(value, "unsupported_catalog", 10); requireValue(n > 0n && n <= 4294967295n, "unsupported_catalog"); return String(n); }
function pgXid(value: unknown): bigint { const n = decimal(value, "read_unavailable", 20); requireValue(n <= 18446744073709551615n, "read_unavailable"); return n; }
const pgSettingFields = ["server_version_num", "server_encoding", "client_encoding", "readonly", "isolation", "schema", "database_name", "pid", "recovery"];
function pgSettings(value: RecordValue, schema: string) {
  requireValue(typeof value.server_version_num === "string" && /^16[0-9]{4}$/.test(value.server_version_num) && value.server_encoding === "UTF8"
    && value.client_encoding === "UTF8" && value.readonly === "on" && value.isolation === "repeatable read" && value.recovery === false, "unsupported_catalog");
  requireValue(value.schema === schema, "source_mismatch");
  requireValue(typeof value.database_name === "string" && value.database_name.length > 0 && Buffer.byteLength(value.database_name) <= 63
    && typeof value.pid === "string" && /^[1-9][0-9]{0,9}$/.test(value.pid), "read_unavailable");
}
async function postgresCatalog(reader: Reader, request: MemoryCollectionRequestValue, m: DatabaseManifests): Promise<{ schema: string; recheck: () => Promise<void> }> {
  const original = m.schema as RecordValue, scope = original.scope as RecordValue, schema = scope?.name;
  requireValue(typeof schema === "string" && schema.length > 0 && Buffer.byteLength(schema) <= 63 && !schema.includes("\0") && schema !== "information_schema" && !schema.startsWith("pg_"), "unsupported_catalog");
  const entry = onlyRow((await reader.run(pgFixed.entry, [], true)).rows, [...pgSettingFields, "prior", "snapshot", "xmin", "xmax"], "read_unavailable");
  pgSettings(entry, schema); const xmin = pgXid(entry.xmin), xmax = pgXid(entry.xmax);
  requireValue(entry.prior === null && xmin === xmax && entry.snapshot === `${xmin}:${xmax}:`, "read_unavailable");
  for (const lock of pgFixed.catalogLocks) await reader.run(lock, [], true);
  const gate = onlyRow((await reader.run(pgFixed.gate, [], true)).rows, ["prior", "snapshot", "xmin", "xmax", "assigned"], "read_unavailable");
  requireValue(gate.prior === null && gate.snapshot === entry.snapshot && pgXid(gate.xmin) === xmin && pgXid(gate.xmax) === xmax && pgXid(gate.assigned) === xmax, "read_unavailable");
  const relations = (await pgCatalogSection(reader, pgSections.relations!, [schema, targetNames])).rows;
  const relationIds: string[] = [], relationByName = new Map<string, string>(); let namespace: string | undefined;
  for (const row of relations) {
    const oid = pgOid(row.oid), ns = pgOid(row.namespace);
    requireValue(typeof row.relname === "string" && targetNames.includes(row.relname) && !relationByName.has(row.relname) && !relationIds.includes(oid)
      && (!namespace || namespace === ns) && row.relkind === "r" && row.relpersistence === "p" && row.am === "2" && row.relispartition === false
      && row.relrowsecurity === false && row.relforcerowsecurity === false, "unsupported_catalog");
    namespace = ns; relationByName.set(row.relname, oid); relationIds.push(oid);
  }
  const blocked = onlyRow((await reader.run(pgFixed.blockedObjects, [relationIds, relationIds, relationIds, relationIds, relationIds], true)).rows,
    ["rules", "statistics", "inheritance", "index_attribute_options"], "unsupported_catalog");
  requireValue(Object.values(blocked).every(v => v === false), "unsupported_catalog");
  const params: Record<string, readonly unknown[]> = { columns: [relationIds], indexes: [relationIds], opclasses: [pgBuiltinIds.opclasses], opfamilies: [pgBuiltinIds.opfamilies],
    amop: [pgBuiltinIds.opfamilies, pgBuiltinIds.operators], amproc: [pgBuiltinIds.opfamilies], am: [pgBuiltinIds.am], operators: [pgBuiltinIds.operators],
    procedures: [pgBuiltinIds.procedures], types: [pgBuiltinIds.types], collations: [pgBuiltinIds.collations], casts: [["20", "23", "25"]], aggregates: [] };
  for (const name of Object.keys(pgSections).filter(n => n !== "relations")) {
    const rows = (await pgCatalogSection(reader, pgSections[name]!, params[name]!)).rows;
    if (name === "columns") pgProfile(rows, pgExpectedColumns, "default_node"); if (name === "indexes") pgProfile(rows, pgExpectedIndexes, "predicate");
  }
  const catalogs = (await pgCatalogSection(reader, pgSupplements.catalogIdentities!, [pgCatalogNames])).rows;
  const catalogOids: string[] = [], remainingCatalogs = new Set<string>(pgCatalogNames);
  for (const row of catalogs) { const oid = pgOid(row.oid); requireValue(typeof row.name === "string" && remainingCatalogs.delete(row.name) && !catalogOids.includes(oid), "unsupported_catalog"); catalogOids.push(oid); }
  const indexes = (await pgCatalogSection(reader, pgSupplements.indexIdentities!, [relationIds])).rows;
  const indexByOid = new Map<string, RecordValue>(), remainingIndexes = new Set(pgExpectedIndexes.map(r => r.name));
  for (const row of indexes) {
    const oid = pgOid(row.oid), relation = pgOid(row.relation), expected = pgExpectedIndexes.find(i => i.name === row.name);
    requireValue(expected && remainingIndexes.delete(row.name) && !indexByOid.has(oid) && relationByName.get(expected.table_name as string) === relation, "unsupported_catalog"); indexByOid.set(oid, expected);
  }
  const keys = (await pgCatalogSection(reader, pgSupplements.keyLinks!, [relationIds])).rows;
  const expectedKeys = new Set(pgExpectedIndexes.filter(r => r.indisprimary || r.indisunique && r.predicate === null).map(r => r.name));
  for (const row of keys) {
    const expected = indexByOid.get(pgOid(row.index));
    requireValue(expected && expectedKeys.delete(expected.name) && row.relation === relationByName.get(expected.table_name as string)
      && row.kind === (expected.indisprimary ? "p" : "u") && row.keys === `{${(expected.keys as string).replaceAll(" ", ",")}}`, "unsupported_catalog");
  }
  requireValue(expectedKeys.size === 0, "unsupported_catalog");
  const databaseId = pgOid(onlyRow((await reader.run(pgFixed.databaseIdentity, [], true)).rows, ["oid"], "unsupported_catalog").oid);
  for (const lock of pgFixed.targetLocks) await reader.run(lock.replaceAll("{{schema}}", quote(schema)), [], true);
  const recheck = async (final = true) => {
    const locks = (await reader.run(pgFixed.lockState, [databaseId, catalogOids, relationIds], true)).rows; requireValue(locks.length === 24, "read_unavailable");
    const wanted = new Map([...catalogOids.map(oid => [oid, "ShareLock"] as const), ...relationIds.map(oid => [oid, "AccessShareLock"] as const)]);
    for (const value of locks) { const row = ownRecord(value, ["oid", "mode", "database", "pid", "granted"], "read_unavailable");
      requireValue(typeof row.oid === "string" && wanted.has(row.oid) && wanted.get(row.oid) === row.mode && row.database === databaseId && row.pid === entry.pid && row.granted === true, "read_unavailable"); wanted.delete(row.oid); }
    requireValue(wanted.size === 0, "read_unavailable");
    if (final) { const settings = onlyRow((await reader.run(pgFixed.postSettings, [], true)).rows, pgSettingFields, "read_unavailable"); requireValue(pgSettingFields.every(k => settings[k] === entry[k]), "read_unavailable"); }
  };
  // R06/P06: entry fixes settings, locks are checked twice, postSettings once.
  await recheck(false);
  const marker = onlyRow((await reader.run(pgFixed.marker.replaceAll("{{schema}}", quote(schema)))).rows, ["singleton", "database_instance_id"], "source_mismatch");
  requireValue(marker.singleton === "1" && marker.database_instance_id === request.source.databaseInstanceId, "source_mismatch");
  return Object.freeze(record({ schema, recheck })) as { schema: string; recheck: () => Promise<void> };
}
function pgData(index: number, schema: string, kind: "count" | "capacity" | "page") {
  const relation = `FROM ONLY ${quote(schema)}.${quote(tableNames[index]!)}`;
  if (kind === "count") return `SELECT pg_catalog.count(*)::pg_catalog.text AS row_count ${relation}`;
  if (kind === "capacity") return `SELECT ${pgAggregates(tableColumns[index]!)} ${relation}`;
  return `SELECT ${tableColumns[index]!.map((name, n) => `${quote(name)}::pg_catalog.text AS ${quote(`v${n}`)}`).join(",")} ${relation} ORDER BY "id" COLLATE pg_catalog."C" USING OPERATOR(pg_catalog.<) LIMIT ?::pg_catalog.int8 OFFSET ?::pg_catalog.int8`;
}
/** Only the caller owns transaction end and source authorization. */
export async function collectLayoutMemoryInventory(snapshot: DbReadSnapshot, request: unknown, frozenManifestBytes: Uint8Array): Promise<ReadonlyDeep<MemoryCollectionObservation>> {
  let phase: MemoryCollectionErrorCode = "invalid_input";
  try {
    const query = fixedQuery(snapshot), fixed = fixedRequest(request), bytes = copyBytes(frozenManifestBytes);
    const reader = new Reader(snapshot, query, fixed.invocationStartedAtNs);
    phase = "manifest_invalid"; const manifest = fixedManifest(bytes, fixed); phase = "read_unavailable";
    let input: ReadonlyDeep<FrozenMemoryInputValue>, recheck: (() => Promise<void>) | undefined;
    if (fixed.source.kind === "sqlite") {
      await sqliteCatalog(reader, fixed, manifest);
      input = await collectRows(reader, fixed, manifest, n => `SELECT CAST(COUNT(*) AS TEXT) AS row_count FROM main.${quote(tableNames[n]!)}`, sqliteCapacity, sqlitePage);
    } else {
      const pg = await postgresCatalog(reader, fixed, manifest); recheck = pg.recheck;
      input = await collectRows(reader, fixed, manifest, n => pgData(n, pg.schema, "count"), n => pgData(n, pg.schema, "capacity"), n => pgData(n, pg.schema, "page"));
    }
    reader.check(); phase = "inventory_invalid"; const inventory = buildLayoutMemoryInventory(input); reader.check(); phase = "read_unavailable";
    if (recheck) await recheck();
    const result = record({ contract: "layout-memory-collection-observation/r1", authority: "observation-only", input, inventory });
    reader.check(); return Object.freeze(result) as unknown as ReadonlyDeep<MemoryCollectionObservation>;
  } catch (error) { throw sanitized(error, phase); }
}

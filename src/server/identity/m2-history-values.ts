import { createHash } from "node:crypto";
import { M2_FORMAT_REGISTRATION } from "./m2-value-contracts.ts";
import { M2_HISTORY_LIMITS, M2_HISTORY_REMAINING, M2_HISTORY_TABLES } from "./m2-history-contracts.ts";
import { markUnknownHistoryFailure } from "./internal/m2-history-failure-identity.ts";
import { sortHistoryFrames } from "./internal/m2-history-sort.ts";
import type { ComparisonObservation, HistoryColumn, HistoryErrorCode, HistoryObservation, HistoryObservationInput,
  HistoryRemaining, HistoryResult, RawCell, RawRow, RawTable } from "./m2-history-contracts.ts";

// Stage1a is a total, primitive-string-only value boundary. No native/semantic closure is issued.
const knownFailures = new WeakMap<object, { code: HistoryErrorCode; path: string[] }>();
function fail(code: HistoryErrorCode, path: string[] = []): never {
  const token = {};
  knownFailures.set(token, { code, path });
  throw token;
}
function requireValue(ok: unknown, path: string[] = [], code: HistoryErrorCode = "invalid_value"): asserts ok {
  if (!ok) fail(code, path);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function total<T>(input: unknown, work: (value: unknown) => T): HistoryResult<T> {
  try {
    const value = read(input);
    return freeze({ ok: true, value: work(value) }) as HistoryResult<T>;
  } catch (error) {
    // Identity lookup never invokes an unknown Proxy's prototype or property traps.
    const known = typeof error === "object" && error !== null ? knownFailures.get(error) : undefined;
    const result = freeze({ ok: false, error: { code: known?.code ?? "invalid_value", path: known?.path ?? [] } }) as HistoryResult<T>;
    return known ? result : markUnknownHistoryFailure(result);
  }
}
function codepointOrder(a: string, b: string): number {
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}
function canonical(value: unknown): string {
  // Keep the same scalar spelling and codepoint key order, but copy nested raw cells only
  // once at the final join instead of rebuilding their full text at every ancestor.
  const pieces: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      pieces.push("[");
      node.forEach((child, index) => { if (index) pieces.push(","); visit(child); });
      pieces.push("]");
    } else if (node !== null && typeof node === "object") {
      pieces.push("{");
      Object.keys(node).sort(codepointOrder).forEach((key, index) => {
        if (index) pieces.push(",");
        pieces.push(JSON.stringify(key), ":"); visit((node as Record<string, unknown>)[key]);
      });
      pieces.push("}");
    } else pieces.push(JSON.stringify(node));
  };
  visit(value);
  return pieces.join("");
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function read(input: unknown): unknown {
  // Do not inspect an object, Proxy, getter or Symbol, including when reporting errors.
  if (typeof input !== "string") fail("invalid_value");
  if (input.length > M2_HISTORY_LIMITS.bytes || Buffer.byteLength(input, "utf8") > M2_HISTORY_LIMITS.bytes) fail("budget_exceeded");
  // Preflight valid JSON's value nodes/depth before JSON.parse allocates its tree.
  // The one envelope includes both sides; neither side gets a fresh budget.
  const stack: string[] = []; let wantValue = true, nodes = 0;
  const node = () => { if (++nodes > M2_HISTORY_LIMITS.nodes || stack.length > M2_HISTORY_LIMITS.depth) fail("budget_exceeded"); };
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if (c === "{" || c === "[") { node(); stack.push(c); wantValue = c === "["; }
    else if (c === "}" || c === "]") { stack.pop(); wantValue = false; }
    else if (c === ":") wantValue = true;
    else if (c === ",") wantValue = stack.at(-1) === "[";
    else if (c === '"') {
      if (wantValue) node();
      for (i++; i < input.length; i++) { if (input[i] === "\\") i++; else if (input[i] === '"') break; }
      wantValue = false;
    } else {
      if (wantValue) node();
      while (i + 1 < input.length && !/[\s,}:\]]/.test(input[i + 1]!)) i++;
      wantValue = false;
    }
  }
  const parsed: unknown = JSON.parse(input);
  const scalar = (v: unknown): void => {
    if (typeof v === "string") requireValue(wellFormed(v));
    else if (typeof v === "number") requireValue(Number.isSafeInteger(v) && !Object.is(v, -0));
    else if (Array.isArray(v)) v.forEach(scalar);
    else if (v !== null && typeof v === "object") for (const [key, child] of Object.entries(v)) { requireValue(wellFormed(key)); scalar(child); }
  };
  scalar(parsed);
  // Equality also rejects duplicate keys, escapes/whitespace and noncanonical numeric spellings.
  requireValue(canonical(parsed) === input);
  return parsed;
}
function object(value: unknown, keys: readonly string[], path: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), path);
  const result = value as Record<string, unknown>, own = Object.keys(result);
  requireValue(own.length === keys.length && keys.every(k => Object.hasOwn(result, k)), path);
  return result;
}
function string(value: unknown, path: string[], expression?: RegExp): asserts value is string {
  requireValue(typeof value === "string" && (expression ? expression.test(value) : value.length > 0), path);
}
const HASH = /^[0-9a-f]{64}$/, DECIMAL = /^(?:0|[1-9][0-9]*)$/, HEX = /^(?:[0-9a-f]{2})*$/;
function int64(value: unknown, path: string[]): asserts value is string {
  string(value, path, /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/);
  requireValue(value.length <= 20, path);
  const n = BigInt(value); requireValue(n >= -9223372036854775808n && n <= 9223372036854775807n, path);
}
function artifact(value: unknown, path: string[]): void {
  const v = object(value, ["ref", "sha256", "bytes"], path);
  string(v.ref, path); string(v.sha256, path, HASH); string(v.bytes, path, DECIMAL);
}
function evidence(value: unknown, path: string[]): void {
  const v = object(value, ["artifactId", "digest"], path); string(v.artifactId, path); string(v.digest, path, HASH);
}
function cell(value: unknown, backend: string, column: HistoryColumn, path: string[]): asserts value is RawCell {
  requireValue(Array.isArray(value), path);
  const tag: unknown = value[0];
  if (tag === "null") { requireValue(value.length === 1, path); return; }
  if (backend === "postgres") {
    requireValue(tag === "pg-binary", path); requireValue(value.length === 3, path);
    requireValue(value[1] === column.postgresTypeOid, path, "column_contract_mismatch");
    string(value[2], path, HEX);
    if (value[1] !== "25") requireValue(value[2].length === (value[1] === "23" ? 8 : 16), path);
    return;
  }
  requireValue(value.length === 2, path);
  if (tag === "integer") int64(value[1], path);
  else if (tag === "text" || tag === "blob") string(value[1], path, HEX);
  else if (tag === "real64be") string(value[1], path, /^[0-9a-f]{16}$/);
  else fail("unsupported_shape", path);
}
function observation(input: unknown): HistoryObservationInput {
  const v = object(input, ["contract", "backend", "phase", "configFormat", "source", "physicalSourceRef", "snapshotReceiptRef", "catalog", "textEncoding", "tables", "sequences"], []);
  requireValue(v.contract === "m2-history-observation/r1", ["contract"], "unsupported_shape");
  requireValue(v.backend === "sqlite" || v.backend === "postgres", ["backend"], "unsupported_shape");
  requireValue(v.phase === "p0" || v.phase === "p1" || v.phase === "p1-bootstrap", ["phase"], "unsupported_shape");
  requireValue(typeof v.configFormat === "number" && Number.isSafeInteger(v.configFormat), ["configFormat"]);
  requireValue(M2_FORMAT_REGISTRATION.state === "registered-stage1" && M2_FORMAT_REGISTRATION.schemaMigration === 22
    && v.configFormat === M2_FORMAT_REGISTRATION.configFormat, ["configFormat"], "format_unregistered");
  const source = object(v.source, ["kind", "databaseInstanceId", "identityDigest"], ["source"]);
  requireValue(source.kind === v.backend, ["source", "kind"]); string(source.databaseInstanceId, ["source"], /^[0-9a-f]{32}$/); string(source.identityDigest, ["source"], HASH);
  evidence(v.physicalSourceRef, ["physicalSourceRef"]); evidence(v.snapshotReceiptRef, ["snapshotReceiptRef"]); artifact(v.catalog, ["catalog"]);
  const encoding = object(v.textEncoding, ["backend", "name"], ["textEncoding"]);
  requireValue(encoding.backend === v.backend, ["textEncoding"]); string(encoding.name, ["textEncoding"]);
  const contracts = M2_HISTORY_TABLES.filter(t => v.phase !== "p0" || t.columnsP0.length > 0);
  requireValue(Array.isArray(v.tables) && v.tables.length === contracts.length, ["tables"], "incomplete_universe");
  for (let t = 0; t < contracts.length; t++) {
    const contract = contracts[t]!, path = ["tables", contract.name];
    const table = object(v.tables[t], ["name", "columnContract", "columnContractValueDigest", "columns", "count", "rows"], path);
    requireValue(table.name === contract.name, path, "incomplete_universe");
    artifact(table.columnContract, [...path, "columnContract"]); string(table.columnContractValueDigest, path, HASH);
    const columns = v.phase === "p0" ? contract.columnsP0 : contract.columnsP1;
    requireValue(Array.isArray(table.columns) && table.columns.length === columns.length
      && columns.every((c, i) => (table.columns as unknown[])[i] === c.name), path, "column_contract_mismatch");
    requireValue(Array.isArray(table.rows), [...path, "rows"]);
    requireValue(table.count === String(table.rows.length), [...path, "count"]);
    if (contract.name === "config_authority") requireValue(table.rows.length === (v.phase === "p1" ? 1 : 0), path);
    for (let r = 0; r < table.rows.length; r++) {
      const rowPath = [...path, "rows", String(r)], row = object(table.rows[r], ["rowid", "cells"], rowPath);
      if (v.backend === "sqlite") int64(row.rowid, [...rowPath, "rowid"]); else requireValue(row.rowid === null, [...rowPath, "rowid"]);
      requireValue(Array.isArray(row.cells) && row.cells.length === columns.length, rowPath, "column_contract_mismatch");
      for (let c = 0; c < columns.length; c++) cell(row.cells[c], v.backend, columns[c]!, [...rowPath, "cells", String(c)]);
      if (v.backend === "sqlite" && contract.sqliteRowidAlias !== null) {
        const alias = row.cells[columns.findIndex(c => c.name === contract.sqliteRowidAlias)] as RawCell;
        requireValue(alias[0] === "integer" && alias[1] === row.rowid, [...rowPath, "rowid"]);
      }
    }
  }
  requireValue(Array.isArray(v.sequences) && v.sequences.length === (v.backend === "sqlite" ? 0 : 1), ["sequences"], "incomplete_universe");
  if (v.backend === "postgres") {
    const s = object(v.sequences[0], ["contract", "name", "relationIdentity", "lastValue", "isCalled"], ["sequences"]);
    requireValue(s.contract === "m2-pc-pg-sequence-observation/r1" && s.name === "schema_migrations_version_seq", ["sequences"], "unsupported_shape");
    artifact(s.relationIdentity, ["sequences", "relationIdentity"]); int64(s.lastValue, ["sequences", "lastValue"]);
    requireValue(typeof s.isCalled === "boolean", ["sequences", "isCalled"]);
  }
  return v as unknown as HistoryObservationInput;
}
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const frame = (row: RawRow) => canonical([row.rowid, row.cells]);
function frames(rows: RawRow[]): string[] {
  // The closed cell/rowid grammar is entirely ASCII: lexical string order is byte order.
  return sortHistoryFrames(rows.map(frame));
}
function remaining(backend: string): HistoryRemaining {
  return M2_HISTORY_REMAINING.map(check => ({ check, status: check === "sequence_exclusion" && backend === "sqlite" ? "not-applicable" : "unproven" }));
}
export function parseM2HistoryObservation(input: unknown): HistoryResult<HistoryObservation> {
  return total(input, value => {
    const result = observation(value);
    const tableDigests = result.tables.map(t => ({ name: t.name, count: t.count,
      rowMultisetDigest: hash(canonical(["m2-pc-table-rows/r1", result.backend, t.name, t.columnContractValueDigest, t.count, frames(t.rows)])) }));
    return { classification: "observation", coverage: "complete-typed-rows", observation: result, tableDigests, remaining: remaining(result.backend) };
  });
}

function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function equalRows(before: RawRow[], after: RawRow[], table: string): void {
  requireValue(before.length === after.length, ["tables", table], "row_mismatch");
  const left = frames(before), right = frames(after);
  requireValue(left.every((v, i) => v === right[i]), ["tables", table], "row_mismatch");
}
function auditPreserved(before: RawTable, after: RawTable): void {
  const index = before.columns.indexOf("id");
  const group = (rows: RawRow[]) => {
    const result = new Map<string, RawRow[]>();
    for (const row of rows) { const key = canonical(row.cells[index]); const group = result.get(key) ?? []; group.push(row); result.set(key, group); }
    return result;
  };
  const old = group(before.rows), target = group(after.rows);
  for (const [key, rows] of old) equalRows(rows, target.get(key) ?? [], "audit_log");
  // New keys are explicitly unverified additions, never permission to append or purge.
}
function migrationVersion(row: RawRow, column: number): bigint {
  const value = row.cells[column]!;
  if (value[0] === "integer") return BigInt(value[1]);
  if (value[0] === "pg-binary" && (value[1] === "20" || value[1] === "23")) {
    const bytes = Buffer.from(value[2], "hex"); return value[1] === "20" ? bytes.readBigInt64BE() : BigInt(bytes.readInt32BE());
  }
  fail("row_mismatch", ["tables", "schema_migrations"]);
}
function oldMigrations(table: RawTable, before: boolean): RawRow[] {
  const index = table.columns.indexOf("version"), result: RawRow[] = [];
  const versions = new Set<bigint>();
  for (const row of table.rows) {
    const version = migrationVersion(row, index);
    if (version >= 1n && version <= 21n) {
      requireValue(!versions.has(version), ["tables", "schema_migrations"], "row_mismatch");
      versions.add(version); result.push(row);
    } else requireValue(!before && version === 22n, ["tables", "schema_migrations"], "row_mismatch");
  }
  requireValue(versions.size === 21, ["tables", "schema_migrations"], "row_mismatch");
  return result;
}
export function compareM2HistoryPreservation(input: unknown): HistoryResult<ComparisonObservation> {
  return total(input, value => {
    const v = object(value, ["contract", "mode", "before", "after", "delta"], []);
    requireValue(v.contract === "m2-history-comparison-input/r1", ["contract"], "unsupported_shape");
    requireValue(v.mode === "exact-p1" || v.mode === "legacy-a-preservation", ["mode"], "unsupported_shape");
    const delta = object(v.delta, ["kind"], ["delta"]);
    requireValue(delta.kind === (v.mode === "exact-p1" ? "none" : "legacy-domain-only"), ["delta"], "unsupported_shape");
    const before = observation(v.before), after = observation(v.after);
    requireValue(before.backend === after.backend && same(before.source, after.source) && same(before.textEncoding, after.textEncoding), ["source"], "row_mismatch");
    const tables: ComparisonObservation["tables"] = [];
    if (v.mode === "exact-p1") {
      requireValue(before.phase !== "p0" && before.phase === after.phase, ["phase"], "unsupported_shape");
      requireValue(same(before.catalog, after.catalog), ["catalog"], "column_contract_mismatch");
      requireValue(same(before.sequences, after.sequences), ["sequences"], "row_mismatch");
      for (let i = 0; i < before.tables.length; i++) {
        const left = before.tables[i]!, right = after.tables[i]!;
        requireValue(same(left.columnContract, right.columnContract) && left.columnContractValueDigest === right.columnContractValueDigest,
          ["tables", left.name, "columnContract"], "column_contract_mismatch");
        equalRows(left.rows, right.rows, left.name);
        tables.push({ name: left.name, beforeCount: left.count, afterCount: right.count, comparedCount: left.count });
      }
    } else {
      requireValue(before.phase === "p0" && after.phase === "p1", ["phase"], "unsupported_shape");
      const target = new Map(after.tables.map(t => [t.name, t]));
      for (const contract of M2_HISTORY_TABLES) {
        if (contract.category !== "business" && contract.category !== "migration") continue;
        const left = before.tables.find(t => t.name === contract.name)!, right = target.get(contract.name)!;
        const projected = right.rows.map(row => ({ rowid: row.rowid, cells: row.cells.slice(0, contract.columnsP0.length) }));
        let comparedCount = left.count;
        if (contract.name === "audit_log") auditPreserved(left, { ...right, columns: left.columns, rows: projected });
        else if (contract.name === "schema_migrations") {
          const old = oldMigrations(left, true), next = oldMigrations({ ...right, rows: projected }, false);
          equalRows(old, next, contract.name); comparedCount = String(old.length);
        } else equalRows(left.rows, projected, contract.name);
        tables.push({ name: contract.name, beforeCount: left.count, afterCount: right.count, comparedCount });
      }
    }
    return { classification: "observation", mode: v.mode, coverage: v.mode === "exact-p1" ? "complete-typed-rows" : "legacy-domain-only",
      beforeValueDigest: hash(canonical(before)), afterValueDigest: hash(canonical(after)), tables,
      unverifiedTargetDomains: v.mode === "exact-p1" ? [] : ["new-m2-rows", "control-transition", "migration22", "audit-additions", "native-target-schema"],
      remaining: remaining(before.backend) };
  });
}

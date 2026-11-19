import { M2_FORMAT_REGISTRATION } from "../m2-value-contracts.ts";
import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { HistoryColumn, HistoryErrorCode, HistoryObservationInput, RawCell } from "../m2-history-contracts.ts";

// One typed-row grammar shared by the original primitive carrier and the P0 owned tree.
// This private core does not parse, canonicalize, hash, clone or issue semantic closure.
const knownFailures = new WeakMap<object, { code: HistoryErrorCode; path: string[] }>();
export function failHistoryValue(code: HistoryErrorCode, path: string[] = []): never {
  const token = {};
  knownFailures.set(token, { code, path });
  throw token;
}
export function requireHistoryValue(ok: unknown, path: string[] = [], code: HistoryErrorCode = "invalid_value"): asserts ok {
  if (!ok) failHistoryValue(code, path);
}

export function historyValueFailure(error: unknown): { code: HistoryErrorCode; path: string[] } | undefined {
  return typeof error === "object" && error !== null ? knownFailures.get(error) : undefined;
}
export function historyObject(value: unknown, keys: readonly string[], path: string[]): Record<string, unknown> {
  requireHistoryValue(value !== null && typeof value === "object" && !Array.isArray(value), path);
  const result = value as Record<string, unknown>, own = Object.keys(result);
  requireHistoryValue(own.length === keys.length && keys.every(k => Object.hasOwn(result, k)), path);
  return result;
}
function string(value: unknown, path: string[], expression?: RegExp): asserts value is string {
  requireHistoryValue(typeof value === "string" && (expression ? expression.test(value) : value.length > 0), path);
}
const HASH = /^[0-9a-f]{64}$/, DECIMAL = /^(?:0|[1-9][0-9]*)$/, HEX = /^(?:[0-9a-f]{2})*$/;
function int64(value: unknown, path: string[]): asserts value is string {
  string(value, path, /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/);
  requireHistoryValue(value.length <= 20, path);
  const n = BigInt(value); requireHistoryValue(n >= -9223372036854775808n && n <= 9223372036854775807n, path);
}
function artifact(value: unknown, path: string[]): void {
  const v = historyObject(value, ["ref", "sha256", "bytes"], path);
  string(v.ref, path); string(v.sha256, path, HASH); string(v.bytes, path, DECIMAL);
}
function evidence(value: unknown, path: string[]): void {
  const v = historyObject(value, ["artifactId", "digest"], path); string(v.artifactId, path); string(v.digest, path, HASH);
}
function cell(value: unknown, backend: string, column: HistoryColumn, path: string[]): asserts value is RawCell {
  requireHistoryValue(Array.isArray(value), path);
  const tag: unknown = value[0];
  if (tag === "null") { requireHistoryValue(value.length === 1, path); return; }
  if (backend === "postgres") {
    requireHistoryValue(tag === "pg-binary", path); requireHistoryValue(value.length === 3, path);
    requireHistoryValue(value[1] === column.postgresTypeOid, path, "column_contract_mismatch");
    string(value[2], path, HEX);
    if (value[1] !== "25") requireHistoryValue(value[2].length === (value[1] === "23" ? 8 : 16), path);
    return;
  }
  requireHistoryValue(value.length === 2, path);
  if (tag === "integer") int64(value[1], path);
  else if (tag === "text" || tag === "blob") string(value[1], path, HEX);
  else if (tag === "real64be") string(value[1], path, /^[0-9a-f]{16}$/);
  else failHistoryValue("unsupported_shape", path);
}
export function validateHistoryObservationValue(input: unknown): HistoryObservationInput {
  const v = historyObject(input, ["contract", "backend", "phase", "configFormat", "source", "physicalSourceRef", "snapshotReceiptRef", "catalog", "textEncoding", "tables", "sequences"], []);
  requireHistoryValue(v.contract === "m2-history-observation/r1", ["contract"], "unsupported_shape");
  requireHistoryValue(v.backend === "sqlite" || v.backend === "postgres", ["backend"], "unsupported_shape");
  requireHistoryValue(v.phase === "p0" || v.phase === "p1" || v.phase === "p1-bootstrap", ["phase"], "unsupported_shape");
  requireHistoryValue(typeof v.configFormat === "number" && Number.isSafeInteger(v.configFormat), ["configFormat"]);
  requireHistoryValue(M2_FORMAT_REGISTRATION.state === "registered-stage1" && M2_FORMAT_REGISTRATION.schemaMigration === 22
    && v.configFormat === M2_FORMAT_REGISTRATION.configFormat, ["configFormat"], "format_unregistered");
  const source = historyObject(v.source, ["kind", "databaseInstanceId", "identityDigest"], ["source"]);
  requireHistoryValue(source.kind === v.backend, ["source", "kind"]); string(source.databaseInstanceId, ["source"], /^[0-9a-f]{32}$/); string(source.identityDigest, ["source"], HASH);
  evidence(v.physicalSourceRef, ["physicalSourceRef"]); evidence(v.snapshotReceiptRef, ["snapshotReceiptRef"]); artifact(v.catalog, ["catalog"]);
  const encoding = historyObject(v.textEncoding, ["backend", "name"], ["textEncoding"]);
  requireHistoryValue(encoding.backend === v.backend, ["textEncoding"]); string(encoding.name, ["textEncoding"]);
  const contracts = M2_HISTORY_TABLES.filter(t => v.phase !== "p0" || t.columnsP0.length > 0);
  requireHistoryValue(Array.isArray(v.tables) && v.tables.length === contracts.length, ["tables"], "incomplete_universe");
  for (let t = 0; t < contracts.length; t++) {
    const contract = contracts[t]!, path = ["tables", contract.name];
    const table = historyObject(v.tables[t], ["name", "columnContract", "columnContractValueDigest", "columns", "count", "rows"], path);
    requireHistoryValue(table.name === contract.name, path, "incomplete_universe");
    artifact(table.columnContract, [...path, "columnContract"]); string(table.columnContractValueDigest, path, HASH);
    const columns = v.phase === "p0" ? contract.columnsP0 : contract.columnsP1;
    requireHistoryValue(Array.isArray(table.columns) && table.columns.length === columns.length
      && columns.every((c, i) => (table.columns as unknown[])[i] === c.name), path, "column_contract_mismatch");
    requireHistoryValue(Array.isArray(table.rows), [...path, "rows"]);
    requireHistoryValue(table.count === String(table.rows.length), [...path, "count"]);
    if (contract.name === "config_authority") requireHistoryValue(table.rows.length === (v.phase === "p1" ? 1 : 0), path);
    for (let r = 0; r < table.rows.length; r++) {
      const rowPath = [...path, "rows", String(r)], row = historyObject(table.rows[r], ["rowid", "cells"], rowPath);
      if (v.backend === "sqlite") int64(row.rowid, [...rowPath, "rowid"]); else requireHistoryValue(row.rowid === null, [...rowPath, "rowid"]);
      requireHistoryValue(Array.isArray(row.cells) && row.cells.length === columns.length, rowPath, "column_contract_mismatch");
      for (let c = 0; c < columns.length; c++) cell(row.cells[c], v.backend, columns[c]!, [...rowPath, "cells", String(c)]);
      if (v.backend === "sqlite" && contract.sqliteRowidAlias !== null) {
        const alias = row.cells[columns.findIndex(c => c.name === contract.sqliteRowidAlias)] as RawCell;
        requireHistoryValue(alias[0] === "integer" && alias[1] === row.rowid, [...rowPath, "rowid"]);
      }
    }
  }
  requireHistoryValue(Array.isArray(v.sequences) && v.sequences.length === (v.backend === "sqlite" ? 0 : 1), ["sequences"], "incomplete_universe");
  if (v.backend === "postgres") {
    const s = historyObject(v.sequences[0], ["contract", "name", "relationIdentity", "lastValue", "isCalled"], ["sequences"]);
    requireHistoryValue(s.contract === "m2-pc-pg-sequence-observation/r1" && s.name === "schema_migrations_version_seq", ["sequences"], "unsupported_shape");
    artifact(s.relationIdentity, ["sequences", "relationIdentity"]); int64(s.lastValue, ["sequences", "lastValue"]);
    requireHistoryValue(typeof s.isCalled === "boolean", ["sequences", "isCalled"]);
  }
  return v as unknown as HistoryObservationInput;
}

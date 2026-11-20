import { M2_FORMAT_REGISTRATION } from "../m2-value-contracts.ts";
import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import { assertP0State, chargeState, siteData, throwP0 } from "./m2-p0-budget.ts";
import type { P0State } from "./m2-p0-budget.ts";
import type { P0Site } from "./m2-p0-types.ts";
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
// Only the fixed private owned entry supplies a ledger. Both entries execute this
// same grammar. Owned success positions are scalars, so a path array is built
// only for a bounded failure, instead of once for every visited cell.
type Place = "root" | "contract" | "backend" | "phase" | "configFormat" | "source" | "sourceKind"
  | "physicalSourceRef" | "snapshotReceiptRef" | "catalog" | "textEncoding" | "tables" | "table"
  | "columnContract" | "rows" | "count" | "row" | "rowid" | "cell" | "sequences"
  | "relationIdentity" | "lastValue" | "isCalled";
const HASH = /^[0-9a-f]{64}$/, DECIMAL = /^(?:0|[1-9][0-9]*)$/, HEX = /^(?:[0-9a-f]{2})*$/;
class Grammar {
  table = "";
  row = 0;
  column = 0;
  readonly state: P0State | undefined;
  readonly site: P0Site | undefined;
  constructor(state?: P0State, site?: P0Site) { this.state = state; this.site = site; }
  reserve(work: number, bytes = 0): void {
    if (this.state) chargeState(this.state, { work, bytes }, this.site);
  }
  path(place: Place): string[] {
    switch (place) {
      case "root": return [];
      case "sourceKind": return ["source", "kind"];
      case "table": return ["tables", this.table];
      case "columnContract": return ["tables", this.table, "columnContract"];
      case "rows": return ["tables", this.table, "rows"];
      case "count": return ["tables", this.table, "count"];
      case "row": return ["tables", this.table, "rows", String(this.row)];
      case "rowid": return ["tables", this.table, "rows", String(this.row), "rowid"];
      case "cell": return ["tables", this.table, "rows", String(this.row), "cells", String(this.column)];
      case "relationIdentity": case "lastValue": case "isCalled": return ["sequences", place];
      default: return [place];
    }
  }
  need(ok: unknown, place: Place, code: HistoryErrorCode = "invalid_value"): asserts ok {
    if (!ok) failHistoryValue(code, this.path(place));
  }
  object(value: unknown, keys: readonly string[], place: Place): Record<string, unknown> {
    if (!this.state) return historyObject(value, keys, this.path(place));
    this.reserve(3 + keys.length * 2);
    this.need(value !== null && typeof value === "object" && !Array.isArray(value), place);
    const result = value as Record<string, unknown>;
    // The authenticated scanner tree has only own enumerable data properties.
    // Bounded enumeration removes the old Object.keys allocation on this path;
    // extra keys fail as soon as they cannot belong to the exact fixed shape.
    let count = 0;
    for (const key in result) {
      this.reserve(2);
      if (Object.hasOwn(result, key)) this.need(++count <= keys.length, place);
    }
    this.need(count === keys.length && keys.every(key => Object.hasOwn(result, key)), place);
    return result;
  }
  string(value: unknown, place: Place, expression?: RegExp): asserts value is string {
    this.reserve(1, expression && typeof value === "string" ? value.length * 2 : 0);
    this.need(typeof value === "string" && (expression ? expression.test(value) : value.length > 0), place);
  }
  int64(value: unknown, place: Place): asserts value is string {
    this.string(value, place, /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/);
    this.need(value.length <= 20, place);
    this.reserve(2, value.length * 2);
    const n = BigInt(value); this.need(n >= -9223372036854775808n && n <= 9223372036854775807n, place);
  }
  artifact(value: unknown, place: Place): void {
    const v = this.object(value, ["ref", "sha256", "bytes"], place);
    this.string(v.ref, place); this.string(v.sha256, place, HASH); this.string(v.bytes, place, DECIMAL);
  }
  evidence(value: unknown, place: Place): void {
    const v = this.object(value, ["artifactId", "digest"], place);
    this.string(v.artifactId, place); this.string(v.digest, place, HASH);
  }
  cell(value: unknown, backend: string, column: HistoryColumn): asserts value is RawCell {
    this.reserve(12, 32); // fixed short tag/OID comparisons, array and branch work
    this.need(Array.isArray(value), "cell");
    const tag: unknown = value[0];
    if (tag === "null") { this.need(value.length === 1, "cell"); return; }
    if (backend === "postgres") {
      this.need(tag === "pg-binary", "cell"); this.need(value.length === 3, "cell");
      this.need(value[1] === column.postgresTypeOid, "cell", "column_contract_mismatch");
      this.string(value[2], "cell", HEX);
      if (value[1] !== "25") this.need(value[2].length === (value[1] === "23" ? 8 : 16), "cell");
      return;
    }
    this.need(value.length === 2, "cell");
    if (tag === "integer") this.int64(value[1], "cell");
    else if (tag === "text" || tag === "blob") this.string(value[1], "cell", HEX);
    else if (tag === "real64be") this.string(value[1], "cell", /^[0-9a-f]{16}$/);
    else failHistoryValue("unsupported_shape", this.path("cell"));
  }
}
function observation(input: unknown, g: Grammar): HistoryObservationInput {
  g.reserve(36, 128);
  const v = g.object(input, ["contract", "backend", "phase", "configFormat", "source", "physicalSourceRef", "snapshotReceiptRef", "catalog", "textEncoding", "tables", "sequences"], "root");
  g.need(v.contract === "m2-history-observation/r1", "contract", "unsupported_shape");
  g.need(v.backend === "sqlite" || v.backend === "postgres", "backend", "unsupported_shape");
  g.need(v.phase === "p0" || v.phase === "p1" || v.phase === "p1-bootstrap", "phase", "unsupported_shape");
  g.need(typeof v.configFormat === "number" && Number.isSafeInteger(v.configFormat), "configFormat");
  g.need(M2_FORMAT_REGISTRATION.state === "registered-stage1" && M2_FORMAT_REGISTRATION.schemaMigration === 22
    && v.configFormat === M2_FORMAT_REGISTRATION.configFormat, "configFormat", "format_unregistered");
  const source = g.object(v.source, ["kind", "databaseInstanceId", "identityDigest"], "source");
  g.need(source.kind === v.backend, "sourceKind"); g.string(source.databaseInstanceId, "source", /^[0-9a-f]{32}$/); g.string(source.identityDigest, "source", HASH);
  g.evidence(v.physicalSourceRef, "physicalSourceRef"); g.evidence(v.snapshotReceiptRef, "snapshotReceiptRef"); g.artifact(v.catalog, "catalog");
  const encoding = g.object(v.textEncoding, ["backend", "name"], "textEncoding");
  g.need(encoding.backend === v.backend, "textEncoding"); g.string(encoding.name, "textEncoding");
  g.reserve(M2_HISTORY_TABLES.length);
  const contracts = M2_HISTORY_TABLES.filter(t => v.phase !== "p0" || t.columnsP0.length > 0);
  g.need(Array.isArray(v.tables) && v.tables.length === contracts.length, "tables", "incomplete_universe");
  for (let t = 0; t < contracts.length; t++) {
    const contract = contracts[t]!; g.table = contract.name;
    g.reserve(16, contract.name.length * 2 + 32);
    const table = g.object(v.tables[t], ["name", "columnContract", "columnContractValueDigest", "columns", "count", "rows"], "table");
    g.need(table.name === contract.name, "table", "incomplete_universe");
    g.artifact(table.columnContract, "columnContract"); g.string(table.columnContractValueDigest, "table", HASH);
    const columns = v.phase === "p0" ? contract.columnsP0 : contract.columnsP1;
    g.need(Array.isArray(table.columns) && table.columns.length === columns.length, "table", "column_contract_mismatch");
    for (let c = 0; c < columns.length; c++) {
      g.reserve(2, columns[c]!.name.length * 2);
      g.need(table.columns[c] === columns[c]!.name, "table", "column_contract_mismatch");
    }
    g.need(Array.isArray(table.rows), "rows");
    g.need(table.count === String(table.rows.length), "count");
    if (contract.name === "config_authority") g.need(table.rows.length === (v.phase === "p1" ? 1 : 0), "table");
    for (let r = 0; r < table.rows.length; r++) {
      g.row = r; g.reserve(10);
      const row = g.object(table.rows[r], ["rowid", "cells"], "row");
      if (v.backend === "sqlite") g.int64(row.rowid, "rowid"); else g.need(row.rowid === null, "rowid");
      g.need(Array.isArray(row.cells) && row.cells.length === columns.length, "row", "column_contract_mismatch");
      for (let c = 0; c < columns.length; c++) { g.column = c; g.cell(row.cells[c], v.backend, columns[c]!); }
      if (v.backend === "sqlite" && contract.sqliteRowidAlias !== null) {
        g.reserve(columns.length * 2, columns.length * 32 + 40);
        const alias = row.cells[columns.findIndex(c => c.name === contract.sqliteRowidAlias)] as RawCell;
        g.need(alias[0] === "integer" && alias[1] === row.rowid, "rowid");
      }
    }
  }
  g.reserve(8);
  g.need(Array.isArray(v.sequences) && v.sequences.length === (v.backend === "sqlite" ? 0 : 1), "sequences", "incomplete_universe");
  if (v.backend === "postgres") {
    const s = g.object(v.sequences[0], ["contract", "name", "relationIdentity", "lastValue", "isCalled"], "sequences");
    g.reserve(2, 160);
    g.need(s.contract === "m2-pc-pg-sequence-observation/r1" && s.name === "schema_migrations_version_seq", "sequences", "unsupported_shape");
    g.artifact(s.relationIdentity, "relationIdentity"); g.int64(s.lastValue, "lastValue");
    g.need(typeof s.isCalled === "boolean", "isCalled");
  }
  return v as unknown as HistoryObservationInput;
}
export function validateHistoryObservationValue(input: unknown): HistoryObservationInput {
  return observation(input, new Grammar());
}
/** The private owned branch has no caller-selected limits, schema or callback.
 * Identity checks precede all tree/state inspection. Its input must be a frozen
 * tree already scanned into this exact authentic request's ownership maps. */
export function validateM2OwnedHistoryObservation(state: P0State, input: unknown, site: P0Site): HistoryObservationInput {
  assertP0State(state); siteData(state, site);
  if (input === null || typeof input !== "object" || !state.depths.has(input) || !Object.isFrozen(input)) {
    throwP0(state, { code: "unsupported_shape", rule: "PC1B-RAW01", site });
  }
  chargeState(state, { work: 1, tuples: 1 }, site);
  return observation(input, new Grammar(state, site));
}

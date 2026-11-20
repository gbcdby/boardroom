import { M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import { assertRow, assertView, chargeState, makeP0Site, p0State, P0_LIMITS, siteData, throwP0 } from "./m2-p0-budget.ts";
import type { P0State } from "./m2-p0-budget.ts";
import { parseP0Json } from "./m2-p0-lexical.ts";
import { M2_ALL_TABLE_NAMES } from "./m2-p0-types.ts";
import type { P0JsonPolicy, P0Path, P0Request, P0Row, P0Site, P0Table, P0View } from "./m2-p0-types.ts";

const contracts = new Map(M2_HISTORY_TABLES.map(t => [t.name, t]));
const columns = new Map([...contracts].map(([name, table]) => [name, new Map(table.columnsP0.map((c, i) => [c.name, i]))]));
const p1Columns = new Map([...contracts].map(([name, table]) => [name, new Map(table.columnsP1.map((c, i) => [c.name, i]))]));
export function columnP0(state: P0State, row: P0Row, column: string): number {
  assertRow(state, row); chargeState(state, { work: 1, bytes: column.length * 2 });
  const index = (row.stage === "p1" ? p1Columns : columns).get(row.table)?.get(column);
  if (index === undefined) throwP0(state, { code: "unsupported_shape", rule: "PC1B-RAW01" });
  return index;
}
export function buildP0View(state: P0State, rows: readonly P0Row[], phase: P0View["phase"]): P0View {
  chargeState(state, { work: rows.length + M2_ALL_TABLE_NAMES.length, tuples: rows.length + M2_ALL_TABLE_NAMES.length });
  const byTable = new Map<P0Table, P0Row[]>(M2_ALL_TABLE_NAMES.map(table => [table, []]));
  const membership = new Set<P0Row>();
  for (const row of rows) {
    assertRow(state, row);
    if (membership.has(row)) throwP0(state, { code: "semantic_invariant_failed", rule: "PC1B-KEY01", condition: "duplicate-key" });
    membership.add(row); byTable.get(row.table)!.push(row);
  }
  for (const tableRows of byTable.values()) Object.freeze(tableRows);
  const view = Object.freeze({ phase, rowCount: rows.length, rows(table: P0Table): readonly P0Row[] {
    chargeState(state, { work: 1 });
    const result = byTable.get(table);
    if (!result) throwP0(state, { code: "unsupported_shape", rule: "PC1B-RAW01" });
    return result;
  } }) as P0View;
  state.views.set(view, membership); return view;
}
export function retainP0Rows(request: P0Request, rows: readonly P0Row[]): P0View {
  const state = p0State(request), original = assertView(state, request.original);
  chargeState(state, { work: rows.length * 2 + original.size, tuples: rows.length });
  for (const row of rows) if (!original.has(row)) throwP0(state, { code: "invalid_value", rule: "PC1B-RAW01" });
  // Original order is retained regardless of a private caller's requested presentation order.
  const kept = new Set(rows);
  if (kept.size !== rows.length) throwP0(state, { code: "semantic_invariant_failed", rule: "PC1B-KEY01", condition: "duplicate-key" });
  const ordered = [...original].filter(row => kept.has(row));
  return buildP0View(state, ordered, "retained-graph");
}
export function p0RowSite(request: P0Request, view: P0View, row: P0Row, column?: string, pathId: P0Path = "row.cell"): P0Site {
  const state = p0State(request); assertRow(state, row);
  if (!assertView(state, view).has(row)) throwP0(state, { code: "invalid_value", rule: "PC1B-RAW01" });
  const ordinal = column === undefined ? null : columnP0(state, row, column) + 1;
  return makeP0Site(state, { depth: state.rowDepths.get(row)!, phase: view.phase,
    location: { inputPart: "observation", artifactOrdinal: null, table: row.table, rowOrdinal: row.rowOrdinal,
      columnOrdinal: ordinal, pathId } });
}
export function p0ArtifactSite(request: P0Request, artifactOrdinal: number): P0Site {
  const state = p0State(request);
  if (!Number.isSafeInteger(artifactOrdinal) || artifactOrdinal < 0 || artifactOrdinal >= request.input.artifacts.length) {
    throwP0(state, { code: "invalid_value", rule: "PC1B-RAW01" });
  }
  const artifact = request.input.artifacts[artifactOrdinal]!;
  return makeP0Site(state, { depth: (state.depths.get(artifact) ?? 2) + 2, phase: "artifact",
    location: { inputPart: "artifact", artifactOrdinal, table: null, rowOrdinal: null, columnOrdinal: null, pathId: "artifact.root" } });
}
export function p0NestedSite(request: P0Request, parent: P0Site, depthDelta: number): P0Site {
  const state = p0State(request), data = siteData(state, parent);
  if (!Number.isSafeInteger(depthDelta) || depthDelta < 1 || data.depth + depthDelta > P0_LIMITS.depth) {
    throwP0(state, { code: "resource_limit", rule: "PC1B-RAW01", site: parent });
  }
  return makeP0Site(state, { ...data, depth: data.depth + depthDelta });
}
function cellAndSite(request: P0Request, row: P0Row, column: string, inputSite?: P0Site) {
  const state = p0State(request), index = columnP0(state, row, column);
  const site = inputSite ?? p0RowSite(request, request.original, row, column);
  siteData(state, site);
  return { state, site, cell: row.raw.cells[index]! };
}
function validUtf8(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index++]!;
    if (lead <= 0x7f) continue;
    const size = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
    if (!size || index + size > bytes.length) return false;
    const second = bytes[index]!;
    if (lead === 0xe0 && second < 0xa0 || lead === 0xed && second > 0x9f
      || lead === 0xf0 && second < 0x90 || lead === 0xf4 && second > 0x8f) return false;
    for (let offset = 0; offset < size; offset++) { const byte = bytes[index++]!; if (byte < 0x80 || byte > 0xbf) return false; }
  }
  return true;
}
export function readP0Text(request: P0Request, row: P0Row, column: string, inputSite?: P0Site): string | null {
  const { state, site, cell } = cellAndSite(request, row, column, inputSite);
  let cached = state.textCells.get(row);
  if (cached?.has(column)) {
    const cachedText = cached.get(column)!;
    chargeState(state, { work: 1, bytes: cachedText.bytes }, site);
    return cachedText.value;
  }
  if (cell[0] === "null") return null;
  const backend = request.input.graph.observation.backend;
  if (backend === "sqlite" ? cell[0] !== "text" : cell[0] !== "pg-binary" || cell[1] !== "25") {
    throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
  }
  const hex = cell[cell[0] === "pg-binary" ? 2 : 1] as string;
  // All hex/type/OID grammar was proved before this allocation by the real Stage1a consumer.
  chargeState(state, { bytes: hex.length * 4, work: 1, tuples: 1 }, site);
  const bytes = Buffer.from(hex, "hex");
  // Recognize malformed UTF8 from owned bytes. An arbitrary thrown decoder value is
  // never classified by instanceof, prototype, fields, or a blanket catch.
  if (!validUtf8(bytes)) throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, "utf8").equals(bytes) || backend === "postgres" && text.includes("\u0000")) {
    throwP0(state, { code: "source_contract_mismatch", rule: "PC1B-RAW01", site });
  }
  if (!cached) { cached = new Map(); state.textCells.set(row, cached); }
  cached.set(column, { value: text, bytes: bytes.length }); return text;
}
export function readP0Int64(request: P0Request, row: P0Row, column: string, inputSite?: P0Site): bigint | null {
  const { state, site, cell } = cellAndSite(request, row, column, inputSite);
  if (cell[0] === "null") return null;
  chargeState(state, { bytes: 40, work: 1 }, site);
  if (cell[0] === "integer") return BigInt(cell[1]!);
  if (cell[0] === "pg-binary" && (cell[1] === "20" || cell[1] === "23")) {
    const bytes = Buffer.from(cell[2]!, "hex"); return cell[1] === "20" ? bytes.readBigInt64BE() : BigInt(bytes.readInt32BE());
  }
  throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
}
export function readP0SafeInteger(request: P0Request, row: P0Row, column: string, inputSite?: P0Site): number | null {
  const value = readP0Int64(request, row, column, inputSite);
  if (value === null) return null;
  const state = p0State(request), site = inputSite ?? p0RowSite(request, request.original, row, column);
  chargeState(state, { work: 1 }, site);
  if (value < -9007199254740991n || value > 9007199254740991n) {
    throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
  }
  return Number(value);
}
export function readP0Real(request: P0Request, row: P0Row, column: string, inputSite?: P0Site): number | null {
  const { state, site, cell } = cellAndSite(request, row, column, inputSite);
  if (cell[0] === "null") return null;
  if (cell[0] === "integer" || cell[0] === "pg-binary" && (cell[1] === "20" || cell[1] === "23")) return readP0SafeInteger(request, row, column, site);
  if (cell[0] !== "real64be") throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
  chargeState(state, { bytes: 32, work: 1 }, site);
  const value = Buffer.from(cell[1]!, "hex").readDoubleBE();
  if (!Number.isFinite(value)) throwP0(state, { code: "semantic_unsupported", rule: "PC1B-RAW01", site });
  return value;
}
export function readP0Json(request: P0Request, row: P0Row, column: string, policy: P0JsonPolicy = "reference", inputSite?: P0Site): unknown {
  const state = p0State(request), ordinal = columnP0(state, row, column);
  const site = inputSite ?? p0RowSite(request, request.original, row, column);
  siteData(state, site);
  if (!["reference", "finite", "legacy-display"].includes(policy)) throwP0(state, { code: "unsupported_shape", rule: "PC1B-RAW01", site });
  const key = `${ordinal}:${policy}`; // Only fixed column ordinal and closed parser policy, never user keys.
  let cached = state.parsedCells.get(row);
  if (cached?.has(key)) {
    chargeState(state, { work: 1 }, site);
    const value = cached.get(key), height = value !== null && typeof value === "object" ? state.jsonHeights.get(value) ?? 0 : 0;
    if (siteData(state, site).depth + height > P0_LIMITS.depth) throwP0(state, { code: "resource_limit", rule: "PC1B-RAW01", site });
    return value;
  }
  const text = readP0Text(request, row, column, site);
  const value = text === null ? null : parseP0Json(request, text, site, policy);
  // An unavailable legacy display has no parsed tree carrying its scanned height.
  // Scan it again at each consumption site so a shallower read cannot mask a
  // later inherited-depth failure; the actual scan continues to use this meter.
  if (value === undefined) return undefined;
  chargeState(state, { work: 1, tuples: 1 }, site);
  if (!cached) { cached = new Map(); state.parsedCells.set(row, cached); }
  cached.set(key, value); return value;
}
export function equalP0Text(request: P0Request, left: string, right: string, site?: P0Site): boolean {
  chargeState(p0State(request), { bytes: (left.length + right.length) * 3, work: 1 }, site);
  return left === right;
}

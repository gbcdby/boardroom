import { parseM2HistoryObservation, compareM2HistoryPreservation } from "../m2-history-values.ts";
import { M2_HISTORY_LIMITS, M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { ComparisonObservation, HistoryErrorCode, HistoryObservation, HistoryResult } from "../m2-history-contracts.ts";
import type { ReadonlyDeep } from "../m2-value-contracts.ts";

// Internal Stage1a seam only. It does not validate a semantic closure or authorize a writer.
type CarrierCode = "unsupported_shape" | "invalid_value" | "source_contract_mismatch"
  | "semantic_invariant_failed" | "format_unregistered" | "resource_limit";
type Location = { inputPart: "input" | "observation"; artifactOrdinal: null; table: string | null;
  rowOrdinal: number | null; columnOrdinal: number | null; pathId: "input.root" | "observation.root" | "row.cell" };
type CarrierError = { code: CarrierCode; phase: "input" | "original-graph"; rule: "PC1B-RAW01" | null;
  location: Location | null; conflicts: { rule: "PC1B-RAW01"; source: Location; target: null;
    condition: "unsupported-value" | "source-mismatch" | "immutable-history-mismatch" | "format-mismatch" | "budget-exceeded" }[];
  moreConflicts: false };
type CarrierResult<T> = ReadonlyDeep<{ ok: true; value: T } | { ok: false; error: CarrierError }>;
const inputLocation: Readonly<Location> = Object.freeze({ inputPart: "input", artifactOrdinal: null, table: null,
  rowOrdinal: null, columnOrdinal: null, pathId: "input.root" });
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function rejected(code: CarrierCode, location: Location | null = inputLocation): CarrierResult<never> {
  return freeze({ ok: false, error: { code, phase: location?.inputPart === "observation" ? "original-graph" : "input",
    rule: location ? "PC1B-RAW01" : null, location, conflicts: location ? [{ rule: "PC1B-RAW01", source: location, target: null,
      condition: code === "resource_limit" ? "budget-exceeded" : code === "source_contract_mismatch" ? "source-mismatch"
        : code === "semantic_invariant_failed" ? "immutable-history-mismatch" : code === "format_unregistered" ? "format-mismatch" : "unsupported-value" }] : [],
    moreConflicts: false } });
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
const LIMITS = Object.freeze({ characters: 64 * 1024 * 1024, work: 4_000_000, rows: 100_000, output: 1024 * 1024 });
class Request {
  readonly failures = new WeakMap<object, CarrierResult<never>>();
  readonly sizes = new WeakMap<object, number>();
  nodes = 0;
  characters = 2048; // Reserve the finite failure shape even when the work budget is exhausted.
  work = 128;
  rows = 0;
  fail(code: CarrierCode = "invalid_value"): never {
    const token = {};
    this.failures.set(token, rejected(code));
    throw token;
  }
  node(depth: number): void {
    if (++this.nodes > M2_HISTORY_LIMITS.nodes || depth > M2_HISTORY_LIMITS.depth) this.fail("resource_limit");
    this.units(1);
  }
  units(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || (this.work += count) > LIMITS.work) this.fail("resource_limit");
  }
  text(bytes: number, passes = 1): void {
    const cost = bytes * passes;
    if (!Number.isSafeInteger(cost) || cost < 0 || (this.characters += cost) > LIMITS.characters) this.fail("resource_limit");
    this.units(passes * Math.ceil(bytes / 64));
  }
}
function quotedBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
function canonical(value: unknown, request: Request): string {
  const pieces: string[] = [];
  let bytes = 0;
  const append = (piece: string, size = piece.length) => {
    if ((bytes += size) > M2_HISTORY_LIMITS.bytes) request.fail("resource_limit");
    request.text(size); pieces.push(piece);
  };
  const visit = (node: unknown): void => {
    request.units(1);
    const start = bytes;
    if (typeof node === "string") {
      const size = quotedBytes(node);
      // Check the allocation's exact byte length before stringifying a value from the private tree.
      if (bytes + size > M2_HISTORY_LIMITS.bytes || request.characters + size > LIMITS.characters) request.fail("resource_limit");
      append(JSON.stringify(node), size);
    } else if (Array.isArray(node)) {
      append("["); node.forEach((child, index) => { if (index) append(","); visit(child); }); append("]");
    } else if (node !== null && typeof node === "object") {
      const keys = Object.keys(node).sort((a, b) => {
        request.units(1); request.text(Buffer.byteLength(a) + Buffer.byteLength(b)); return codepointOrder(a, b);
      });
      append("{"); keys.forEach((key, index) => {
        if (index) append(","); visit(key); append(":"); visit((node as Record<string, unknown>)[key]);
      }); append("}");
    } else append(JSON.stringify(node));
    if (node !== null && typeof node === "object") request.sizes.set(node, bytes - start);
  };
  visit(value);
  // Joining and passing the new carrier are additional character work, not a fresh allowance.
  request.text(bytes);
  return pieces.join("");
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function exactInteger(token: string, request: Request): void {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!match) request.fail();
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) { if (match[1]) request.fail(); return; }
  const exponentSign = match[4]?.startsWith("-") ? -1 : 1;
  const exponentToken = (match[4] ?? "0").replace(/^[+-]/, "").replace(/^0+/, "");
  // A longer nonzero exponent cannot be cancelled by any mantissa within the outer byte limit.
  if (exponentToken.length > 8) request.fail();
  const exponent = exponentSign * Number(exponentToken || "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > M2_HISTORY_LIMITS.bytes + 32) request.fail();
  const significant = digits.replace(/0+$/, "");
  const shift = exponent - (match[3]?.length ?? 0) + digits.length - significant.length;
  if (shift < 0 || significant.length + shift > 16) request.fail();
  const integer = significant + "0".repeat(shift);
  if (integer.length === 16 && integer > "9007199254740991") request.fail();
}
function readOuter(input: string, request: Request): unknown {
  if (input.length > M2_HISTORY_LIMITS.bytes) request.fail("resource_limit");
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes > M2_HISTORY_LIMITS.bytes) request.fail("resource_limit");
  // Scanner, token-string decoding/validation, key checks and final JSON.parse are bounded together.
  request.text(bytes, 4);
  let at = 0;
  const whitespace = () => { while (at < input.length && /[ \t\r\n]/.test(input[at]!)) at++; };
  const text = (): string => {
    if (input[at] !== '"') request.fail();
    const start = at++;
    let complete = false;
    while (at < input.length) {
      const c = input[at++]!;
      if (c === '"') { complete = true; break; }
      if (c.charCodeAt(0) < 0x20) request.fail();
      if (c === "\\") {
        const escaped = input[at++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(at, at + 4))) request.fail();
          at += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) request.fail();
      }
    }
    if (!complete) request.fail();
    request.units(1 + Math.ceil((at - start) / 64));
    const value: string = JSON.parse(input.slice(start, at));
    if (!wellFormed(value)) request.fail();
    return value;
  };
  const value = (depth: number): void => {
    whitespace(); request.node(depth);
    const c = input[at];
    if (c === '"') { text(); return; }
    if (c === "{") {
      at++; whitespace();
      const keys = new Set<string>();
      if (input[at] === "}") { at++; return; }
      for (;;) {
        const key = text();
        if (keys.has(key)) request.fail();
        keys.add(key); whitespace();
        if (input[at++] !== ":") request.fail();
        value(depth + 1); whitespace();
        const separator = input[at++];
        if (separator === "}") return;
        if (separator !== ",") request.fail();
        whitespace();
      }
    }
    if (c === "[") {
      at++; whitespace();
      if (input[at] === "]") { at++; return; }
      for (;;) {
        value(depth + 1); whitespace();
        const separator = input[at++];
        if (separator === "]") return;
        if (separator !== ",") request.fail();
      }
    }
    const start = at;
    while (at < input.length && !/[ \t\r\n,}\]]/.test(input[at]!)) at++;
    const token = input.slice(start, at);
    if (token !== "true" && token !== "false" && token !== "null") { request.text(token.length, 4); exactInteger(token, request); }
  };
  value(0); whitespace();
  if (at !== input.length) request.fail();
  return JSON.parse(input);
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function reserveConsumer(parsed: unknown, carrierBytes: number, comparison: boolean, request: Request): void {
  // The old API reparses the private carrier. Charge that allocation, its validation/canonical/hash
  // passes and result metadata before invoking it; its own fixed limits still run independently.
  const nodes = request.nodes;
  if (nodes * 2 + 2048 > M2_HISTORY_LIMITS.nodes) request.fail("resource_limit");
  request.nodes += nodes + 2048;
  request.units(nodes * 12 + 72 * 72);
  request.text(carrierBytes, 8);
  const envelope = record(parsed);
  const observations = comparison ? [envelope?.before, envelope?.after] : [parsed];
  for (const observation of observations) {
    const tables = record(observation)?.tables;
    if (!Array.isArray(tables)) continue;
    for (const table of tables) {
      const rows = record(table)?.rows;
      if (!Array.isArray(rows)) continue;
      if ((request.rows += rows.length) > LIMITS.rows) request.fail("resource_limit");
      let maxFrameBytes = 1;
      for (const row of rows) {
        request.units(1);
        // A complete raw-row object is larger than its [rowid,cells] frame. Invalid row shapes
        // are rejected by the real consumer before sorting, never coerced into a frame here.
        if (row !== null && typeof row === "object") maxFrameBytes = Math.max(maxFrameBytes, request.sizes.get(row) ?? 1);
      }
      // Conservative quadratic bound for the uninstrumented legacy string sort. All table/group
      // sorts of a side fit this bound; two comparison sides debit the same request.
      const comparisons = rows.length * rows.length;
      request.units(comparisons);
      request.text(2 * maxFrameBytes, comparisons);
    }
  }
}
function checkOutput(value: unknown, request: Request): void {
  let bytes = 0;
  const add = (amount: number) => { if ((bytes += amount) > LIMITS.output) request.fail("resource_limit"); };
  const visit = (node: unknown): void => {
    request.units(1);
    if (typeof node === "string") add(quotedBytes(node));
    else if (Array.isArray(node)) { add(2 + Math.max(0, node.length - 1)); node.forEach(visit); }
    else if (node !== null && typeof node === "object") {
      const keys = Object.keys(node); add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) { add(quotedBytes(key) + 1); visit((node as Record<string, unknown>)[key]); }
    } else add(JSON.stringify(node).length);
  };
  visit(value); request.text(bytes);
}
function ownerCode(code: HistoryErrorCode): CarrierCode {
  switch (code) {
    case "budget_exceeded": return "resource_limit";
    case "incomplete_universe": case "column_contract_mismatch": return "source_contract_mismatch";
    case "row_mismatch": return "semantic_invariant_failed";
    case "invalid_value": case "unsupported_shape": case "format_unregistered": return code;
    default: return "invalid_value";
  }
}
function ownerLocation(path: readonly string[], parsed: unknown, comparison: boolean): Location {
  if (path.length === 0) return inputLocation;
  const location: Location = { inputPart: "observation", artifactOrdinal: null, table: null,
    rowOrdinal: null, columnOrdinal: null, pathId: "observation.root" };
  if (path[0] !== "tables") return location;
  const contract = M2_HISTORY_TABLES.find(t => t.name === path[1]);
  if (!contract) return location;
  location.table = contract.name; // Always read back from the fixed catalog, never the caller's table/name.
  // The old comparison error does not identify which side failed. Do not invent side/row identity.
  if (comparison) return location;
  const observation = record(parsed), contracts = M2_HISTORY_TABLES.filter(t => observation?.phase !== "p0" || t.columnsP0.length > 0);
  const tables = observation?.tables, index = contracts.findIndex(t => t === contract);
  if (!Array.isArray(tables) || index < 0) return location;
  const rows = record(tables[index])?.rows;
  if (path[2] !== "rows" || !/^(0|[1-9][0-9]*)$/.test(path[3] ?? "")) return location;
  const row = Number(path[3]);
  if (!Number.isSafeInteger(row) || !Array.isArray(rows) || row >= rows.length) return location;
  location.rowOrdinal = row;
  const columns = observation?.phase === "p0" ? contract.columnsP0 : contract.columnsP1;
  if (path[4] === "cells" && /^(0|[1-9][0-9]*)$/.test(path[5] ?? "")) {
    const column = Number(path[5]);
    if (Number.isSafeInteger(column) && column < columns.length) { location.columnOrdinal = column + 1; location.pathId = "row.cell"; }
  }
  return location;
}
function consume<T>(input: unknown, comparison: boolean, consumer: (value: unknown) => HistoryResult<T>): CarrierResult<T> {
  if (typeof input !== "string") return rejected("unsupported_shape");
  const request = new Request();
  try {
    const parsed = readOuter(input, request);
    const carrier = canonical(parsed, request);
    reserveConsumer(parsed, Buffer.byteLength(carrier), comparison, request);
    const result = consumer(carrier);
    const mapped = result.ok ? result : rejected(ownerCode(result.error.code), ownerLocation(result.error.path, parsed, comparison));
    checkOutput(mapped, request);
    return mapped;
  } catch (error) {
    // Never inspect an unknown thrown value, even if it is a Proxy, Symbol or Error with accessors.
    return request.failures.get(error as object) ?? rejected("invalid_value", null);
  }
}
export function parseM2HistoryCarrier(input: unknown): CarrierResult<HistoryObservation> {
  return consume(input, false, parseM2HistoryObservation);
}
export function compareM2HistoryCarrier(input: unknown): CarrierResult<ComparisonObservation> {
  return consume(input, true, compareM2HistoryPreservation);
}

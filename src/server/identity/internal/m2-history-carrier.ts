import { parseM2HistoryObservation, compareM2HistoryPreservation } from "../m2-history-values.ts";
import { M2_HISTORY_LIMITS, M2_HISTORY_TABLES } from "../m2-history-contracts.ts";
import type { ComparisonObservation, HistoryErrorCode, HistoryObservation, HistoryResult } from "../m2-history-contracts.ts";
import type { ReadonlyDeep } from "../m2-value-contracts.ts";
import { isUnknownHistoryFailure } from "./m2-history-failure-identity.ts";

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
// characters counts scalar stringify and key sorting. A complete canonical call adds one
// read/write of its final flat join; ancestor arrays/objects do not recopy their children.
type EncodingCost = { bytes: number; characters: number; work: number };
const scalarEncoding = (bytes: number): EncodingCost => ({ bytes, characters: bytes * 2, work: 1 });
function arrayEncoding(children: readonly EncodingCost[]): EncodingCost {
  const bytes = 2 + Math.max(0, children.length - 1) + children.reduce((sum, child) => sum + child.bytes, 0);
  return { bytes, characters: children.reduce((sum, child) => sum + child.characters, 0),
    work: 1 + children.length + children.reduce((sum, child) => sum + child.work, 0) };
}
class Request {
  readonly failures = new WeakMap<object, CarrierResult<never>>();
  readonly encodings = new WeakMap<object, EncodingCost>();
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
function quotedBytes(text: string, request: Request): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    // Bound the estimator's own scan before reading each chunk. One UTF-16 unit needs at
    // most three UTF-8 bytes (a surrogate pair needs four for two units).
    if (i % 64 === 0) request.text(3 * Math.min(64, text.length - i));
    const c = text.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; }
    else if (c >= 0xdc00 && c <= 0xdfff) { /* Already counted with the preceding high surrogate. */ }
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
  const emitString = (text: string, size: number): EncodingCost => {
    // Reserve both the read and encoded output before JSON.stringify can allocate it.
    if (bytes + size > M2_HISTORY_LIMITS.bytes) request.fail("resource_limit");
    request.text(size, 2);
    bytes += size; pieces.push(JSON.stringify(text));
    return scalarEncoding(size);
  };
  const visit = (node: unknown): EncodingCost => {
    request.units(1);
    const start = bytes;
    let encoding: EncodingCost;
    if (typeof node === "string") {
      const size = quotedBytes(node, request);
      encoding = emitString(node, size);
    } else if (Array.isArray(node)) {
      const children: EncodingCost[] = [];
      append("["); node.forEach((child, index) => { if (index) append(","); children.push(visit(child)); }); append("]");
      request.units(children.length * 3);
      encoding = arrayEncoding(children);
    } else if (node !== null && typeof node === "object") {
      const keys = Object.keys(node).map(key => { request.units(1); return { key, bytes: quotedBytes(key, request) }; }).sort((a, b) => {
        request.units(1); request.text(a.bytes + b.bytes); return codepointOrder(a.key, b.key);
      });
      let childCharacters = 0, childWork = 0, maxKeyBytes = 0;
      append("{"); keys.forEach(({ key, bytes: keyBytes }, index) => {
        request.units(1);
        if (index) append(",");
        const keyEncoding = emitString(key, keyBytes);
        append(":");
        const child = visit((node as Record<string, unknown>)[key]);
        childCharacters += keyEncoding.characters + child.characters;
        childWork += keyEncoding.work + child.work;
        maxKeyBytes = Math.max(maxKeyBytes, keyBytes);
      }); append("}");
      const size = bytes - start, comparisons = keys.length * keys.length;
      // The original consumer's flat encoder sorts keys but never joins a child separately.
      // n² comparisons is a conservative bound for its consistent key sort.
      encoding = { bytes: size, characters: childCharacters + 2 * maxKeyBytes * comparisons,
        work: 1 + childWork + keys.length * 2 + comparisons };
    } else {
      request.text(24); // A safe integer, boolean or null primitive requires at most 17 encoded bytes.
      const text = JSON.stringify(node); append(text); encoding = scalarEncoding(text.length);
    }
    if (node !== null && typeof node === "object") {
      request.encodings.set(node, encoding);
    }
    return encoding;
  };
  visit(value);
  // Read + write the flat join, then measure the completed carrier at the caller's boundary.
  request.text(bytes, 3);
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
  // Reserve the real old consumer's work before calling it. These are encoding costs, not
  // validation results: the original parser/comparator remains the sole typed-row authority.
  const nodes = request.nodes;
  if (nodes * 2 + 2048 > M2_HISTORY_LIMITS.nodes) request.fail("resource_limit");
  request.nodes += nodes + 2048;
  request.units(nodes * 12 + 72 * 72);
  // read(): byteLength, token scan, JSON.parse, then scalar well-formedness. Typed validation
  // adds at most four reads per string: regex matching/backtracking, bounded int64 conversion,
  // and fixed-value/rowid-alias comparison. No recursive encoding is hidden in these passes.
  request.text(carrierBytes); // Buffer.byteLength.
  request.text(carrierBytes); // Token scanner.
  request.text(carrierBytes); // JSON.parse.
  request.text(carrierBytes); // scalar() string/key well-formedness.
  request.text(carrierBytes, 4);
  const encoding = (value: unknown): EncodingCost => {
    request.units(1);
    if (value !== null && typeof value === "object") return request.encodings.get(value) ?? scalarEncoding(0);
    if (typeof value === "string") return scalarEncoding(quotedBytes(value, request));
    // Missing/malformed children stop the actual consumer before its later encodings.
    if (value === undefined) return scalarEncoding(0);
    request.text(24);
    return scalarEncoding(JSON.stringify(value).length);
  };
  const arrayCost = (children: readonly EncodingCost[]): EncodingCost => {
    request.units(children.length * 3);
    return arrayEncoding(children);
  };
  const encode = (cost: EncodingCost): void => {
    request.text(cost.characters); request.text(cost.bytes, 2); request.units(cost.work);
  };
  const same = (left: unknown, right: unknown): void => {
    const a = encoding(left), b = encoding(right);
    encode(a); encode(b); request.text(a.bytes + b.bytes);
  };
  encode(encoding(parsed)); // read() reconstructs canonical(parsed).
  request.text(carrierBytes, 2); // canonical(parsed) === input.
  const envelope = record(parsed);
  const observations = comparison ? [envelope?.before, envelope?.after] : [parsed];
  if (comparison) {
    const before = record(observations[0]), after = record(observations[1]);
    same(before?.source, after?.source); same(before?.textEncoding, after?.textEncoding);
    if (envelope?.mode === "exact-p1") {
      same(before?.catalog, after?.catalog); same(before?.sequences, after?.sequences);
    }
  }
  for (const input of observations) {
    request.units(1);
    const observation = record(input), tables = observation?.tables;
    if (!Array.isArray(tables)) continue;
    for (const rawTable of tables) {
      request.units(1);
      const table = record(rawTable), rows = table?.rows;
      if (!Array.isArray(rows)) continue;
      if ((request.rows += rows.length) > LIMITS.rows) request.fail("resource_limit");
      let maxFrameBytes = 1, allFrameBytes = 0;
      const frameStrings: EncodingCost[] = [];
      if (comparison && envelope?.mode === "exact-p1") {
        // same(columnContract) performs one encoding per side and compares the two strings.
        const cost = encoding(table?.columnContract); encode(cost); request.text(cost.bytes);
        request.text(64); // The validated column-contract digest comparison, one side.
      }
      const audit = comparison && envelope?.mode === "legacy-a-preservation" && table?.name === "audit_log";
      // The fixed typed schema bounds the id search; charge the estimator before traversing it.
      const columns = table?.columns;
      let id = -1;
      if (audit && Array.isArray(columns)) {
        request.units(columns.length); request.text(columns.length * 64);
        id = columns.indexOf("id");
      }
      for (const row of rows) {
        request.units(1);
        // A complete raw-row object is larger than its [rowid,cells] frame. Invalid row shapes
        // are rejected before frames. The raw object's encoding cost also bounds a legacy
        // projection, which only drops cells; each original row reaches at most one frame.
        const cost = encoding(row); encode(cost);
        maxFrameBytes = Math.max(maxFrameBytes, cost.bytes); allFrameBytes += cost.bytes;
        if (!comparison) frameStrings.push(scalarEncoding(2 * cost.bytes + 2)); // Quoting an ASCII frame at most doubles it.
        if (audit) {
          const cells = record(row)?.cells, key = encoding(Array.isArray(cells) ? cells[id] : undefined);
          encode(key);
          // group(): get/set and the later target.get; one scan for each operation.
          request.text(key.bytes, 3);
        }
      }
      // Conservative quadratic bound for the uninstrumented legacy string sort. All table/group
      // sorts of a side fit this bound; two comparison sides debit the same request.
      const comparisons = rows.length * rows.length;
      request.units(comparisons);
      request.text(2 * maxFrameBytes, comparisons);
      if (comparison) request.text(allFrameBytes); // equalRows string equality, this side.
      else {
        const digest = arrayCost([encoding("m2-pc-table-rows/r1"), encoding(observation?.backend), encoding(table?.name),
          encoding(table?.columnContractValueDigest), encoding(table?.count), arrayCost(frameStrings)]);
        encode(digest); request.text(digest.bytes); // hash.update of the table frame array.
      }
    }
    if (comparison) {
      const cost = encoding(input); encode(cost); request.text(cost.bytes); // Final per-side canonical + hash.update.
    }
  }
}
function checkOutput(value: unknown, request: Request): void {
  let bytes = 0;
  const add = (amount: number) => { if ((bytes += amount) > LIMITS.output) request.fail("resource_limit"); };
  const visit = (node: unknown): void => {
    request.units(1);
    if (typeof node === "string") add(quotedBytes(node, request));
    else if (Array.isArray(node)) { add(2 + Math.max(0, node.length - 1)); node.forEach(visit); }
    else if (node !== null && typeof node === "object") {
      const keys = Object.keys(node); add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) { add(quotedBytes(key, request) + 1); visit((node as Record<string, unknown>)[key]); }
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
    const mapped = isUnknownHistoryFailure(result) ? rejected("invalid_value", null)
      : result.ok ? result : rejected(ownerCode(result.error.code), ownerLocation(result.error.path, parsed, comparison));
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

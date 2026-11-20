import { isUtf8 } from "node:buffer";
import type { ReadonlyDeep } from "../m2-value-contracts.ts";

// Private C2 boundary. No caller-selected grammar, budget or error location.
export type AuditCode = "unsupported_shape" | "invalid_value" | "source_contract_mismatch"
  | "semantic_invariant_failed" | "resource_limit";
export type AuditRule = "PC1B-RAW01" | "PC1B-KEY01" | "PC1B-AUD01";
type Condition = "unsupported-value" | "source-mismatch" | "count-mismatch" | "identity-mismatch" | "budget-exceeded" | "duplicate-key";
type Location = { inputPart: "input" | "observation"; artifactOrdinal: null; table: "agents" | "audit_log" | null;
  rowOrdinal: number | null; columnOrdinal: number | null; pathId: "input.root" | "observation.root" | "row.cell" };
type AuditError = { code: AuditCode; phase: "input" | "original-graph"; rule: AuditRule | null; location: Location | null;
  conflicts: { rule: AuditRule; source: Location; target: null; condition: Condition }[]; moreConflicts: false };
export type AuditResult<T> = ReadonlyDeep<{ ok: true; value: T } | { ok: false; error: AuditError }>;
export type JsonKind = "null" | "boolean" | "number" | "string" | "array" | "object";
export const AUDIT_LIMITS = Object.freeze({ input: 16 * 1024 * 1024, capture: 1024 * 1024, raw: 4 * 1024 * 1024,
  rawTotal: 8 * 1024 * 1024, nodes: 250_000, depth: 64, rows: 100_000, characters: 64 * 1024 * 1024,
  work: 4_000_000, output: 1024 * 1024, field: 32 * 1024 });
const inputLocation: Location = { inputPart: "input", artifactOrdinal: null, table: null, rowOrdinal: null,
  columnOrdinal: null, pathId: "input.root" };
function freeze<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as ReadonlyDeep<T>;
}
function rejected(code: AuditCode, location: Location | null, rule: AuditRule = "PC1B-RAW01", condition?: Condition): AuditResult<never> {
  return freeze({ ok: false, error: { code, phase: location?.inputPart === "observation" ? "original-graph" : "input",
    rule: location ? rule : null, location, conflicts: location ? [{ rule, source: location, target: null,
      condition: condition ?? (code === "resource_limit" ? "budget-exceeded" : code === "source_contract_mismatch"
        ? "source-mismatch" : code === "semantic_invariant_failed" ? "identity-mismatch" : "unsupported-value") }] : [], moreConflicts: false } });
}
export class AuditRequest {
  readonly failures = new WeakMap<object, AuditResult<never>>();
  private location: Location = inputLocation;
  private rule: AuditRule = "PC1B-RAW01";
  private nodes = 0;
  private characters = 2048; // Reserve finite failure output even after the main budget is exhausted.
  private work = 128;
  private rows = 0;
  private rawBytes = 0;
  private outputBytes = 0;
  at(table: "agents" | "audit_log" | null = null, rowOrdinal: number | null = null,
    columnIndex: number | null = null, rule: AuditRule = "PC1B-RAW01"): void {
    this.location = table === null ? inputLocation : { inputPart: "observation", artifactOrdinal: null, table,
      rowOrdinal, columnOrdinal: columnIndex === null ? null : columnIndex + 1, pathId: columnIndex === null ? "observation.root" : "row.cell" };
    this.rule = rule;
  }
  fail(code: AuditCode = "invalid_value", condition?: Condition): never {
    const token = {};
    this.failures.set(token, rejected(code, this.location, code === "resource_limit" ? "PC1B-RAW01" : this.rule, condition));
    throw token;
  }
  unlocatedInvalid(): never {
    const token = {};
    this.failures.set(token, rejected("invalid_value", null));
    throw token;
  }
  require(ok: unknown, code: AuditCode = "invalid_value", condition?: Condition): asserts ok {
    if (!ok) this.fail(code, condition);
  }
  units(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || (this.work += n) > AUDIT_LIMITS.work) this.fail("resource_limit");
  }
  text(bytes: number, passes = 1): void {
    const cost = bytes * passes;
    if (!Number.isSafeInteger(cost) || cost < 0 || (this.characters += cost) > AUDIT_LIMITS.characters) this.fail("resource_limit");
    this.units(passes * Math.ceil(bytes / 64));
  }
  allocateNodes(n: number, depth = 0): void {
    if (!Number.isSafeInteger(n) || n < 0 || (this.nodes += n) > AUDIT_LIMITS.nodes || depth > AUDIT_LIMITS.depth) this.fail("resource_limit");
    this.units(n);
  }
  rowCount(n: number): void {
    if ((this.rows += n) > AUDIT_LIMITS.rows) this.fail("resource_limit");
    this.units(n);
  }
  reserveOutput(n: number): void {
    if ((this.outputBytes += n) > AUDIT_LIMITS.output) this.fail("resource_limit");
  }
  utf8Bytes(text: string): number {
    this.text(text.length * 3); // Bound the byteLength scan before executing it.
    return Buffer.byteLength(text, "utf8");
  }
  quotedBytes(text: string): number {
    this.text(text.length * 3);
    let bytes = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
      else if (c < 32) bytes += 6;
      else if (c < 128) bytes++;
      else if (c < 2048) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; } // Outer strings are already well formed.
      else bytes += 3;
    }
    return bytes;
  }
  protected numberBytes(value: number): number { return String(value).length; }
  measure(value: unknown, maximum: number): { bytes: number; nodes: number } {
    let bytes = 0, nodes = 0;
    const add = (n: number) => { if ((bytes += n) > maximum) this.fail("resource_limit"); };
    const visit = (v: unknown): void => {
      this.units(1); nodes++;
      if (typeof v === "string") { add(this.quotedBytes(v)); return; }
      if (v === null || typeof v === "boolean" || typeof v === "number") { add(v === null ? 4 : typeof v === "boolean" ? v ? 4 : 5 : this.numberBytes(v)); return; }
      if (Array.isArray(v)) { add(2 + Math.max(0, v.length - 1)); for (const child of v) visit(child); return; }
      const obj = v as Record<string, unknown>, keys = Object.keys(obj);
      this.units(keys.length); add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) { add(this.quotedBytes(key) + 1); visit(obj[key]); }
    };
    visit(value); return { bytes, nodes };
  }
  stringify(value: unknown, maximum: number): string {
    const cost = this.measure(value, maximum);
    this.text(cost.bytes, 2); // Read and allocated output, reserved before stringify.
    return JSON.stringify(value);
  }
  hex(value: unknown, bytes?: number): string {
    this.require(typeof value === "string");
    if (value.length > AUDIT_LIMITS.raw * 2 || (this.rawBytes += value.length / 2) > AUDIT_LIMITS.rawTotal) this.fail("resource_limit");
    this.text(value.length);
    this.require(value.length % 2 === 0 && /^[0-9a-f]*$/.test(value) && (bytes === undefined || value.length === bytes * 2));
    return value;
  }
  decodeText(hex: string): string {
    const bytes = hex.length / 2;
    this.text(bytes, 6); // hex decode, UTF-8 validation/decode and exact round-trip comparison.
    const raw = Buffer.from(hex, "hex");
    this.require(isUtf8(raw), "source_contract_mismatch");
    // UTF-8 was validated without exceptions; any unexpected throw remains unknown, never inspected.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    this.require(Buffer.from(text, "utf8").equals(raw), "source_contract_mismatch");
    return text;
  }
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const low = text.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) return false; }
    else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
// Same exact mathematical integer domain as C1; never round a numeric token before admission.
function exactInteger(token: string, r: AuditRequest): void {
  r.text(token.length, 6);
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!m) r.fail();
  const digits = `${m[2]}${m[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) { if (m[1]) r.fail(); return; }
  const exponentText = (m[4] ?? "0").replace(/^[+-]/, "").replace(/^0+/, "");
  if (exponentText.length > 8) r.fail();
  const exponent = (m[4]?.startsWith("-") ? -1 : 1) * Number(exponentText || "0");
  if (Math.abs(exponent) > AUDIT_LIMITS.input + 32) r.fail();
  const significant = digits.replace(/0+$/, ""), shift = exponent - (m[3]?.length ?? 0) + digits.length - significant.length;
  if (shift < 0 || significant.length + shift > 16) r.fail();
  const integer = significant + "0".repeat(shift);
  if (integer.length === 16 && integer > "9007199254740991") r.fail();
}
// Only internal code chooses strict outer grammar or historical display syntax.
function scan(text: string, strict: boolean, rootDepth: number, r: AuditRequest): JsonKind | null {
  const malformed = Symbol();
  const bad = (): never => { throw malformed; };
  let at = 0;
  const ws = () => { while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at++; };
  const string = (): string | null => {
    if (text[at++] !== '"') bad();
    const start = at - 1;
    let closed = false;
    while (at < text.length) {
      const c = text[at++]!;
      if (c === '"') { closed = true; break; }
      if (c.charCodeAt(0) < 32) bad();
      if (c === "\\") {
        const escape = text[at++];
        if (escape === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) bad(); at += 4; }
        else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) bad();
      }
    }
    if (!closed) bad();
    r.units(1);
    if (!strict) return null; // No numeric conversion, key collapse, or escaped-surrogate rejection in old display.
    const decoded: string = JSON.parse(text.slice(start, at));
    if (!wellFormed(decoded)) r.fail();
    return decoded;
  };
  const value = (depth: number): JsonKind => {
    ws(); r.allocateNodes(1, depth);
    if (text[at] === '"') { string(); return "string"; }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", end = object ? "}" : "]", keys = strict && object ? new Set<string>() : null;
      ws(); if (text[at] === end) { at++; return object ? "object" : "array"; }
      for (;;) {
        if (object) {
          // A key is a JSON string token at the same child depth as its value.
          // Charge before scanning it, including duplicate keys in historical display JSON.
          r.allocateNodes(1, depth + 1);
          const key = string();
          if (keys) {
            r.units(1); r.text(key!.length * 3);
            if (keys.has(key!)) r.fail("invalid_value", "duplicate-key");
            keys.add(key!);
          }
          ws(); if (text[at++] !== ":") bad();
        }
        value(depth + 1); ws(); const separator = text[at++];
        if (separator === end) return object ? "object" : "array";
        if (separator !== ",") bad(); ws();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (token === "null") return "null";
    if (token === "true" || token === "false") return "boolean";
    if (!/^-?(0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token)) bad();
    if (strict) exactInteger(token, r);
    return "number";
  };
  try { const kind = value(rootDepth); ws(); if (at !== text.length) bad(); return kind; }
  catch (error) { if (error === malformed) return null; throw error; }
}
export function observeDisplaySyntax(text: string, r: AuditRequest): JsonKind | null {
  r.text(r.utf8Bytes(text));
  // root object -> raw-cell array -> hex TEXT -> expanded JSON root.
  return scan(text, false, 3, r);
}
export function record(value: unknown, keys: readonly string[], r: AuditRequest): Record<string, unknown> {
  r.units(1);
  r.require(value !== null && typeof value === "object" && !Array.isArray(value), "unsupported_shape");
  const actual = Object.keys(value);
  r.units(actual.length + keys.length);
  r.require(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)), "unsupported_shape");
  return value as Record<string, unknown>;
}
export function encoding(value: unknown, backend: "sqlite" | "postgres", r: AuditRequest): void {
  const v = record(value, ["backend", "name"], r);
  r.require(v.backend === backend && v.name === (backend === "sqlite" ? "UTF-8" : "UTF8"), "source_contract_mismatch");
}
// SRC has an additional, smaller cumulative byte contract. Keep its fixed policy
// private: ordinary C2/P0 callers retain the original limits and cannot select a
// budget, supply a request, or turn this policy off. Inherited decoding, measuring
// and serialization all dispatch through this same request's text method.
class SourceTransferRequest extends AuditRequest {
  private transferBytes = 2048; // The same finite failure-output reservation as C2.
  override text(bytes: number, passes = 1): void {
    const cost = bytes * passes;
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > 16 * 1024 * 1024 - this.transferBytes) this.fail("resource_limit");
    this.transferBytes += cost;
    super.text(bytes, passes);
  }
  override decodeText(hex: string): string {
    // Together with C2's six passes: hex read/copy (3), UTF-8 validation (1),
    // decode read/copy (2), re-encode read/copy (2), comparison of both buffers (2).
    this.text(hex.length / 2, 4);
    return super.decodeText(hex);
  }
  protected override numberBytes(value: number): number {
    this.text(32, 2); // Decimal/exponent rendering and its result, before String.
    return super.numberBytes(value);
  }
}
function runBoundary<T>(input: unknown, body: (value: unknown, r: AuditRequest) => T,
  r: AuditRequest, sourceTransfer: boolean): AuditResult<T> {
  try {
    r.require(typeof input === "string", "unsupported_shape");
    if (input.length > AUDIT_LIMITS.input) r.fail("resource_limit");
    const bytes = r.utf8Bytes(input);
    if (bytes > AUDIT_LIMITS.input) r.fail("resource_limit");
    // SRC prepays lexical scan, token slices, token parse/read/copy, decoded
    // well-formedness, and the final parse/read/copy (seven complete upper-bound
    // passes). UTF-8 measurement and key/number checks have their own charges.
    // Preserve the original four-pass C2 policy for every existing caller.
    r.text(bytes, sourceTransfer ? 7 : 4);
    if (scan(input, true, 0, r) === null) r.fail();
    const value = body(JSON.parse(input), r), result = { ok: true as const, value };
    const cost = r.measure(result, AUDIT_LIMITS.output);
    r.text(cost.bytes, 2); r.units(cost.nodes); // Later result serialization and deep freeze.
    return freeze(result);
  } catch (error) {
    const known = error !== null && (typeof error === "object" || typeof error === "function") ? r.failures.get(error) : undefined;
    return known ?? rejected("invalid_value", null); // Never read an unknown throw's properties/prototype.
  }
}
export function boundary<T>(input: unknown, body: (value: unknown, r: AuditRequest) => T): AuditResult<T> {
  return runBoundary(input, body, new AuditRequest(), false);
}
export function sourceTransferBoundary<T>(input: unknown, body: (value: unknown, r: AuditRequest) => T): AuditResult<T> {
  return runBoundary(input, body, new SourceTransferRequest(), true);
}

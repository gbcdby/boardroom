import { isNativeError, isProxy } from "node:util/types";
import { ProfileAuthorityValueError } from "../../../identity/profile-authority-values.ts";
import { canonicalJson, sha256 } from "../canonical.ts";
import { LayoutValueError } from "../layout-values.ts";
import type { E1FailureCode, E1RuleId, E1SchemaPath, SelectedBytes } from "../layout-publication-file-values.ts";

type Failure = { code: E1FailureCode; ruleId: E1RuleId; schemaPath: E1SchemaPath };
const failures = new WeakMap<object, Failure>();
const paths = { E1_INPUT: "/input", E1_BYTES: "/selected", E1_CONFIG: "/privateConfig", E1_NUMBER: "/original",
  E1_SEED: "/seed", E1_BINDING: "/links", E1_RENDER: "/files", E1_BUDGET: "/budget" } as const;
export function fail(code: E1FailureCode, ruleId: E1RuleId): never {
  const token = Object.freeze({});
  failures.set(token, { code, ruleId, schemaPath: paths[ruleId] });
  throw token;
}
export function failure(value: unknown, stage: E1RuleId): Failure {
  // WeakMap lookup does not inspect even a revoked Proxy or accessor-bearing thrown value.
  const known = value !== null && (typeof value === "object" || typeof value === "function") ? failures.get(value) : undefined;
  return known ?? { code: "invalid_value", ruleId: stage, schemaPath: paths[stage] };
}
export function consume<T>(operation: () => T, stage: E1RuleId): T {
  try { return operation(); }
  catch (error) {
    // Only native Error instances from these two consumers have a transferable code.
    // The brand check is trap-free. Never inspect a Proxy, message, cause or stack.
    if (isNativeError(error) && !isProxy(error)) {
      const prototype: unknown = Object.getPrototypeOf(error);
      if (prototype === LayoutValueError.prototype || prototype === ProfileAuthorityValueError.prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        if (descriptor && "value" in descriptor) {
          if (descriptor.value === "budget_exceeded") fail("resource_limit", "E1_BUDGET");
          if (descriptor.value === "value_conflict" && (stage === "E1_RENDER" || stage === "E1_SEED")) fail("value_conflict", stage);
        }
      }
    }
    fail("invalid_value", stage);
  }
}

export const SINGLE_BYTES = 1_048_576;
/** One meter spans the captured outer tree, all decoded JSON and every new output tree. */
export class Budget {
  private nodes = 0;
  private bytes = 0;
  node(depth: number): void {
    if (++this.nodes > 250_000 || depth > 64) fail("resource_limit", "E1_BUDGET");
  }
  decodedBytes(length: number): void {
    if (length > SINGLE_BYTES || (this.bytes += length) > 8 * SINGLE_BYTES) fail("resource_limit", "E1_BUDGET");
  }
  tree(value: unknown, depth = 0): void {
    this.node(depth);
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) this.tree(child, depth + 1);
    }
  }
}

/** Bounds every JSON value before JSON.parse allocates its object graph. */
function scanJson(text: string, budget: Budget, stage: E1RuleId): void {
  let offset = 0;
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function bad(): never { return fail("invalid_value", stage); }
  function whitespace() { while (offset < text.length && /[\t\n\r ]/.test(text[offset]!)) offset++; }
  function string() {
    if (text[offset++] !== '"') bad();
    while (offset < text.length) {
      const character = text[offset++]!;
      if (character === '"') return;
      if (character.charCodeAt(0) < 32) bad();
      if (character === "\\") {
        const escape = text[offset++];
        if (escape === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset, offset + 4))) bad();
          offset += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) bad();
      }
    }
    bad();
  }
  function value(depth: number) {
    budget.node(depth);
    whitespace();
    const character = text[offset];
    if (character === '"') { string(); return; }
    if (character === "{" || character === "[") {
      offset++;
      const object = character === "{", end = object ? "}" : "]";
      whitespace();
      if (text[offset] === end) { offset++; return; }
      for (;;) {
        if (object) { whitespace(); string(); whitespace(); if (text[offset++] !== ":") bad(); }
        value(depth + 1);
        whitespace();
        if (text[offset] === end) { offset++; return; }
        if (text[offset++] !== ",") bad();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return; }
    }
    number.lastIndex = offset;
    const match = number.exec(text);
    if (!match) bad();
    offset = number.lastIndex;
  }
  value(0);
  whitespace();
  if (offset !== text.length) bad();
}

export type NumberSources = WeakMap<object, Map<string, string>>;
export function decodeJson(text: string, budget: Budget, stage: E1RuleId, numbers?: NumberSources): unknown {
  scanJson(text, budget, stage);
  try {
    // Node 24 supplies the original primitive token even when Number rounded it.
    // A duplicate property is visited only for its last JSON.parse value/token.
    const parse = JSON.parse as (text: string, reviver: (this: object, key: string, value: unknown,
      context: { source?: string }) => unknown) => unknown;
    return parse(text, function(key, value, context) {
      if (numbers && typeof value === "number" && context.source !== undefined) {
        let sources = numbers.get(this);
        if (!sources) { sources = new Map(); numbers.set(this, sources); }
        sources.set(key, context.source);
      }
      return value;
    });
  } catch { fail("invalid_value", stage); }
}
function canonicalValues(value: unknown): void {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) fail("invalid_value", "E1_BYTES");
  if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)) fail("invalid_value", "E1_BYTES");
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/[\uD800-\uDFFF]/u.test(key)) fail("invalid_value", "E1_BYTES");
      canonicalValues(child);
    }
  }
}
export function selectedSize(selected: SelectedBytes, budget: Budget): void {
  const hex = selected.bytesHex;
  // Bound before scanning or allocating a Buffer. Charge actual hex length, never a declared byte count.
  if (hex.length > 2 * SINGLE_BYTES) fail("resource_limit", "E1_BUDGET");
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) fail("invalid_value", "E1_BYTES");
  budget.decodedBytes(hex.length / 2);
}
export function selectedBytes(selected: SelectedBytes): Buffer {
  const bytes = Buffer.from(selected.bytesHex, "hex");
  if (selected.artifact.bytes !== String(bytes.length) || sha256(bytes) !== selected.artifact.sha256)
    fail("artifact_integrity", "E1_BYTES");
  return bytes;
}
export function strictUtf8(bytes: Uint8Array, stage: E1RuleId): string {
  // ignoreBOM=true preserves U+FEFF so JSON grammar/canonical comparison cannot hide it.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("invalid_value", stage); }
}
export function selectedJson(bytes: Uint8Array, budget: Budget): unknown {
  const text = strictUtf8(bytes, "E1_BYTES");
  const value = decodeJson(text, budget, "E1_BYTES");
  canonicalValues(value);
  if (canonicalJson(value) !== text) fail("artifact_integrity", "E1_BYTES");
  return value;
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

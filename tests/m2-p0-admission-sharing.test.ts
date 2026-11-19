import test from "node:test";
import assert from "node:assert/strict";
import { createP0Request, parseP0Json, p0RowSite, p0Usage, withP0Guard } from "../src/server/identity/internal/m2-p0.ts";
import { p0Fixture, addP0Row, p0Text } from "./helpers/m2-p0-a-fixture.ts";
import { parseM2HistoryObservation } from "../src/server/identity/m2-history-values.ts";
import type { HistoryObservationInput } from "../src/server/identity/m2-history-contracts.ts";

test("Unicode escape scanning consumes four hex digits without copied or rescanned substrings", () => {
  const repeats = 32768, wire = '"' + '\\u0078'.repeat(repeats) + '"';
  const nativeSlice = String.prototype.slice, nativeTest = RegExp.prototype.test,
    nativeParseInt = Number.parseInt, nativeCharCode = String.prototype.charCodeAt;
  const calls = { slice: 0, regex: 0, parseInt: 0, digits: 0 };
  let result: ReturnType<typeof createP0Request>;
  try {
    String.prototype.slice = function(start: number, end?: number) {
      if (this === wire && end !== undefined && end - start === 4) calls.slice++;
      return Reflect.apply(nativeSlice, this, [start, end]);
    };
    RegExp.prototype.test = function(value: string) {
      if (this.source === "^[0-9a-fA-F]{4}$" && value === "0078") calls.regex++;
      return Reflect.apply(nativeTest, this, [value]);
    };
    Number.parseInt = function(value: string, radix?: number) {
      if (value === "0078") calls.parseInt++;
      return Reflect.apply(nativeParseInt, this, [value, radix]);
    };
    String.prototype.charCodeAt = function(index: number) {
      if (this === wire) calls.digits++;
      return Reflect.apply(nativeCharCode, this, [index]);
    };
    result = createP0Request(wire);
  } finally {
    String.prototype.slice = nativeSlice; RegExp.prototype.test = nativeTest;
    Number.parseInt = nativeParseInt; String.prototype.charCodeAt = nativeCharCode;
  }
  assert.deepEqual(calls, { slice: 0, regex: 0, parseInt: 0, digits: repeats * 4 });
  assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.code, "unsupported_shape");
});

test("inline hex decoding preserves valid digits and rejects every malformed digit position", () => {
  for (const digits of ["0000", "0078", "00aF", "00Af", "D7FF", "e000", "FFFF"]) {
    const result = createP0Request('"\\u' + digits + '"');
    assert.equal(result.ok, false); if (result.ok) assert.fail();
    assert.equal(result.error.code, "unsupported_shape", digits);
  }
  for (const digits of ["", "0", "000", "G000", "0g00", "00g0", "000g", "-001", " 001"]) {
    const result = createP0Request('"\\u' + digits + '"');
    assert.equal(result.ok, false); if (result.ok) assert.fail();
    assert.equal(result.error.code, "invalid_value", digits);
  }
});

test("admission parses one owned tree and only decodes keys separately", () => {
  const input = p0Fixture();
  addP0Row(input, "agents", { id: p0Text("sqlite", "native-owned-tree") });
  const text = JSON.stringify(input), native = JSON.parse;
  const calls: string[] = [];
  let result: ReturnType<typeof createP0Request>;
  try {
    JSON.parse = ((source: string, ...args: unknown[]) => {
      calls.push(source); return Reflect.apply(native, JSON, [source, ...args]);
    }) as typeof JSON.parse;
    result = createP0Request(text);
  } finally { JSON.parse = native; }
  assert.equal(result.ok, true);
  assert.equal(calls.filter(source => source[0] !== '"').length, 1);
  assert.equal(calls.filter(source => source === text).length, 1);
  assert.equal(calls.includes('"native-owned-tree"'), false);
  assert.equal(calls.includes('"text"'), false);
  if (!result.ok) assert.fail();
  const count = (value: unknown): number => Array.isArray(value) ? 1 + value.reduce((n: number, child) => n + count(child), 0)
    : value !== null && typeof value === "object" ? 1 + Object.entries(value).reduce((n, [, child]) => n + 1 + count(child), 0) : 1;
  assert.equal(p0Usage(result.value).nodes, count(input));
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("owned admission and the real carrier keep the same complete typed-row grammar", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const changes: ((value: HistoryObservationInput) => void)[] = [
      () => {},
      value => { Object.assign(value, { configFormat: 2 }); },
      value => { value.tables.pop(); },
      value => { value.tables[0]!.count = "1"; },
      value => { value.tables[0]!.columns.reverse(); },
      value => { value.tables[0]!.columnContractValueDigest = "f"; },
      value => { value.source = { ...value.source, identityDigest: "bad" }; },
      value => { value.tables.find(table => table.name === "agents")!.rows[0]!.cells[0] = ["text", "z0"]; },
      value => { value.tables.find(table => table.name === "agents")!.rows[0]!.cells.pop(); },
      value => { value.tables.find(table => table.name === "agents")!.rows[0]!.rowid = backend === "sqlite" ? "9223372036854775808" : "1"; },
    ];
    for (const change of changes) {
      const input = p0Fixture(backend);
      addP0Row(input, "agents", { id: p0Text(backend, "grammar-row") });
      change(input.graph.observation);
      const native = parseM2HistoryObservation(canonical(input.graph.observation));
      const owned = createP0Request(JSON.stringify(input));
      assert.equal(owned.ok, native.ok);
      if (!native.ok && !owned.ok) {
        const code = ["incomplete_universe", "column_contract_mismatch"].includes(native.error.code)
          ? "source_contract_mismatch" : native.error.code;
        assert.equal(owned.error.code, code);
        assert.equal(owned.error.rule, "PC1B-RAW01");
      }
    }
  }
});

test("unknown throw in the shared raw grammar remains an unlocated finite failure", () => {
  const input = p0Fixture();
  addP0Row(input, "agents", { id: p0Text("sqlite", "raw-grammar-unknown") });
  const source = JSON.stringify(input), target = Buffer.from("raw-grammar-unknown").toString("hex");
  const native = RegExp.prototype.test;
  let hits = 0, traps = 0;
  const unknown = new Proxy({}, { get() { traps++; throw new Error("private"); }, getPrototypeOf() { traps++; throw new Error("private"); } });
  let result: ReturnType<typeof createP0Request>;
  try {
    RegExp.prototype.test = function (text: string) {
      if (text === target && this.source === "^(?:[0-9a-f]{2})*$") { hits++; throw unknown; }
      return Reflect.apply(native, this, [text]);
    };
    result = createP0Request(source);
  } finally { RegExp.prototype.test = native; }
  assert.equal(hits, 1); assert.equal(traps, 0); assert.equal(result.ok, false);
  if (result.ok) assert.fail();
  assert.equal(result.error.code, "invalid_value"); assert.equal(result.error.rule, null); assert.equal(result.error.location, null);
});

test("merged string scanning preserves raw and escaped Unicode and legacy lone surrogates", () => {
  const fixture = p0Fixture();
  const marker = "unicode-slot";
  fixture.graph.observation.catalog = { ...fixture.graph.observation.catalog, ref: marker };
  const text = JSON.stringify(fixture);
  for (const literal of ['"汉字"', '"😀"', '"\\ud83d\\ude00"', '"\\ud83d\ude00"', '"\ud83d\\ude00"', '"a\\nb\\t\\u0000"']) {
    const result = createP0Request(text.replace(JSON.stringify(marker), literal));
    assert.equal(result.ok, true, JSON.stringify(literal));
  }
  for (const literal of ['"\\ud800"', '"\\udc00"', '"\ud800"', '"\udc00"', '"\\ud800x"', '"\\ud800\\ud800"', '"\\u12xz"']) {
    const result = createP0Request(text.replace(JSON.stringify(marker), literal));
    assert.equal(result.ok, false, JSON.stringify(literal));
    if (result.ok) assert.fail(); assert.equal(result.error.code, "invalid_value");
  }
  addP0Row(fixture, "audit_log", { detail: p0Text("sqlite", "null") });
  const request = createP0Request(JSON.stringify(fixture)); if (!request.ok) assert.fail();
  const site = p0RowSite(request.value, request.value.original, request.value.original.rows("audit_log")[0]!, "detail");
  const legacy = withP0Guard(request.value, () => parseP0Json(request.value, '"\\ud800"', site, "legacy-display"));
  assert.deepEqual(legacy, { ok: true, value: "\ud800" });
});

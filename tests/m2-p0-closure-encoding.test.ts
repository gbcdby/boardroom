import assert from "node:assert/strict";
import test from "node:test";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { ClosureEncoder, freezeClosureOutput, sortedClosureFrames } from "../src/server/identity/internal/m2-p0-closure-output.ts";
import { canonicalP0, chargeP0, createP0Request, p0Usage, withP0Guard } from "../src/server/identity/internal/m2-p0.ts";
import { P0_LIMITS } from "../src/server/identity/internal/m2-p0-budget.ts";
import { p0Fixture, addP0Row, p0Text } from "./helpers/m2-p0-a-fixture.ts";

function request(input = p0Fixture()) {
  const result = createP0Request(JSON.stringify(input)); assert(result.ok); return result.value;
}
function checked<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert(result.ok, JSON.stringify(result)); return result.value;
}
test("streamed C-R3 exactly matches the accepted encoder for nested Unicode and integer boundaries", () => {
  const cases: unknown[] = [null, true, false, 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
    "", "\0\b\t\n\f\r\"\\", "\ufeff汉字\u{10000}\ue000😀", Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join(""),
    { "\u{10000}": { "é": ["中", 9007199254740991, null] }, "\ue000": [false, { "a\0\"\\": "🙂" }] },
    { z: [], a: {}, b: [{ c: { d: [-5, "raw \\u0041 remains text"] } }] },
  ];
  for (const value of cases) {
    const req = request(), expected = checked(withP0Guard(req, () => canonicalP0(req, value)));
    const encoded = new ClosureEncoder(req);
    assert.equal(encoded.text(value), expected);
    assert.equal(encoded.bytes(value), Buffer.byteLength(expected, "utf8"));
    assert.equal(encoded.digest(value), createHash("sha256").update(expected).digest("hex"));
  }
});

test("unpaired surrogates and unsupported scalars retain the original rejection", () => {
  for (const value of [-0, 1.5, Infinity, NaN, undefined, "\ud800", "\udc00", "x\ud800z"]) {
    const left = request(), right = request();
    const original = withP0Guard(left, () => canonicalP0(left, value));
    const streamed = withP0Guard(right, () => new ClosureEncoder(right).digest(value));
    assert.equal(original.ok, false); assert.equal(streamed.ok, false);
    if (!original.ok && !streamed.ok) assert.equal(streamed.error.code, original.error.code);
  }
});

test("raw-cell and selected-hex fast paths require this request's exact immutable identity", () => {
  const input = p0Fixture(); addP0Row(input, "agents", { id: p0Text("sqlite", "raw\0unicode😀") });
  input.artifacts.push({ kind: "syntax-only-selected", artifact: { ref: "syntax", sha256: "a".repeat(64), bytes: "2" }, bytesHex: "00ff" });
  const req = request(input), encoder = new ClosureEncoder(req), cell = req.original.rows("agents")[0]!.raw.cells[0]!;
  const values = [cell, req.input.artifacts[0], ["text", "\"\0\u{10000}"], { bytesHex: "\"\0\u{10000}" }];
  for (const value of values) {
    const expected = checked(withP0Guard(req, () => canonicalP0(req, value)));
    assert.equal(encoder.text(value), expected); assert.equal(encoder.bytes(value), Buffer.byteLength(expected));
  }
});

test("large admitted hex is streamed without quoted-string allocation and reduces actual encoding work", () => {
  const input = p0Fixture(), hex = "ab".repeat(32_768);
  input.artifacts.push({ kind: "syntax-only-selected", artifact: { ref: "syntax", sha256: "a".repeat(64), bytes: "32768" }, bytesHex: hex });
  const oldRequest = request(input), newRequest = request(input), beforeOld = p0Usage(oldRequest), beforeNew = p0Usage(newRequest);
  const original = checked(withP0Guard(oldRequest, () => canonicalP0(oldRequest, oldRequest.input)));
  const expected = createHash("sha256").update(original).digest("hex");
  const stringify = JSON.stringify, nativeHash = crypto.createHash;
  let largeQuotes = 0, hashBytes = 0, updates = 0;
  let digest: string, usage: ReturnType<typeof p0Usage>;
  try {
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value === hex) largeQuotes++; return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify;
    crypto.createHash = ((...args: Parameters<typeof crypto.createHash>) => {
      const hash = Reflect.apply(nativeHash, crypto, args), update = hash.update;
      hash.update = ((value: string | Uint8Array, encoding?: BufferEncoding) => {
        updates++; hashBytes += typeof value === "string" ? Buffer.byteLength(value, encoding) : value.byteLength;
        return Reflect.apply(update, hash, encoding === undefined ? [value] : [value, encoding]);
      }) as typeof hash.update;
      return hash;
    }) as typeof crypto.createHash;
    syncBuiltinESMExports();
    const encoder = new ClosureEncoder(newRequest);
    digest = encoder.digest(newRequest.input);
    const firstUpdates = updates;
    assert.equal(encoder.digest(newRequest.input), digest); assert.equal(updates, firstUpdates);
    usage = p0Usage(newRequest);
  } finally { JSON.stringify = stringify; crypto.createHash = nativeHash; syncBuiltinESMExports(); }
  assert.equal(digest!, expected); assert.equal(largeQuotes, 0);
  assert.equal(hashBytes, Buffer.byteLength(original)); assert(updates > 1);
  assert(usage!.bytes - beforeNew.bytes < p0Usage(oldRequest).bytes - beforeOld.bytes);
});

test("streamed output size remains exact and rejects over-limit output instead of truncation", () => {
  const req = request(), result = withP0Guard(req, () => {
    const encoder = new ClosureEncoder(req);
    return freezeClosureOutput(req, { whole: "x".repeat(1_048_576) }, encoder);
  });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "resource_limit");
});

test("the exact output ceiling includes the fixed complete public success envelope", () => {
  for (const extra of [0, 1]) {
    const value = { whole: "x".repeat(P0_LIMITS.output - 32 + extra) };
    assert.equal(Buffer.byteLength(JSON.stringify({ ok: true, value })), P0_LIMITS.output + extra);
    const req = request(), result = withP0Guard(req, () => freezeClosureOutput(req, value, new ClosureEncoder(req)));
    assert.equal(result.ok, extra === 0);
    if (!result.ok) assert.equal(result.error.code, "resource_limit");
  }
});

test("authenticated table frames keep exact C-R3 string preimages without second stringify", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = p0Fixture(backend), longText = "\0\"\\中😀".repeat(128);
    addP0Row(input, "agents", { id: p0Text(backend, longText) }, "9223372036854775807");
    addP0Row(input, "agents", { id: p0Text(backend, longText + "z") }, "-9223372036854775808");
    const raw = input.graph.observation.tables.find(table => table.name === "agents")!;
    if (backend === "sqlite") raw.rows[0]!.cells.splice(1, 4,
      ["integer", "-9223372036854775808"], ["blob", "00ff"], ["real64be", "3ff0000000000000"], ["text", ""]);
    raw.rows.push(structuredClone(raw.rows[0]!)); raw.count = String(raw.rows.length);
    const req = request(input), encoder = new ClosureEncoder(req), observation = req.input.graph.observation;
    const ordinal = observation.tables.findIndex(table => table.name === "agents"), table = observation.tables[ordinal]!;
    const frames = table.rows.map(row => checked(withP0Guard(req, () => canonicalP0(req, [row.rowid, row.cells])))).sort();
    const preimage = checked(withP0Guard(req, () => canonicalP0(req,
      ["m2-pc-table-rows/r1", backend, table.name, table.columnContractValueDigest, table.count, frames])));
    const nativeStringify = JSON.stringify; let repeatedFrameQuotes = 0;
    try {
      JSON.stringify = ((value: unknown, ...args: unknown[]) => {
        if (typeof value === "string" && frames.includes(value)) repeatedFrameQuotes++;
        return Reflect.apply(nativeStringify, JSON, [value, ...args]);
      }) as typeof JSON.stringify;
      assert.equal(encoder.tableRowsDigest(ordinal), createHash("sha256").update(preimage).digest("hex"));
    } finally { JSON.stringify = nativeStringify; }
    assert.equal(repeatedFrameQuotes, 0);
    const other = request(input);
    const foreign = withP0Guard(req, () => encoder.tableRowsDigest(other.input.graph.observation.tables[ordinal] as unknown as number));
    assert.equal(foreign.ok, false, "the frame fast path selects rows from its own request, not a supplied raw object");
  }
});

test("block comparison keeps full prefix, length, boundary and duplicate ordering", () => {
  const frames = ["", "a", "a", "a".repeat(63), "a".repeat(64), "a".repeat(65),
    "a".repeat(63) + "b", "a".repeat(64) + "b", "a".repeat(128) + "c", "a".repeat(128) + "b",
    "[\"10\",[]]", "[\"2\",[]]", "[null,[]]", "[\"2\",[]]", "\\", "\""].reverse();
  assert.deepEqual(sortedClosureFrames(request(), frames), [...frames].sort());
  const left = "a" + "x".repeat(4096), right = "b" + "x".repeat(4096), req = request();
  const before = p0Usage(req), original = String.prototype.charCodeAt; let reads = 0;
  try {
    String.prototype.charCodeAt = function (this: string, index: number) {
      if (String(this) === left || String(this) === right) reads++;
      return Reflect.apply(original, this, [index]);
    };
    assert.deepEqual(sortedClosureFrames(req, [right, left]), [left, right]);
  } finally { String.prototype.charCodeAt = original; }
  assert.equal(reads, 2, "a first-character difference must never read the long suffix");
  assert.equal(p0Usage(req).bytes - before.bytes, 256, "both 64-unit UTF-16 blocks are prepaid at 2 B per unit");
});

test("exhausted block budget fails before the first character read", () => {
  const req = request(), left = "budget-left", right = "budget-right";
  chargeP0(req, { bytes: P0_LIMITS.bytes - p0Usage(req).bytes - 1 });
  const original = String.prototype.charCodeAt; let reads = 0;
  let result: ReturnType<typeof withP0Guard>;
  try {
    String.prototype.charCodeAt = function (this: string, index: number) {
      if (String(this) === left || String(this) === right) reads++;
      return Reflect.apply(original, this, [index]);
    };
    result = withP0Guard(req, () => sortedClosureFrames(req, [right, left]));
  } finally { String.prototype.charCodeAt = original; }
  assert.equal(result!.ok, false); if (!result!.ok) assert.equal(result!.error.code, "resource_limit");
  assert.equal(reads, 0);
});

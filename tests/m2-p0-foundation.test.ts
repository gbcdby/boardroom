import test from "node:test";
import assert from "node:assert/strict";
import { createP0Request, withP0Guard, readP0Text, readP0Int64, readP0SafeInteger, readP0Json, p0RowSite,
  p0NestedSite, parseP0Json, chargeP0, p0Usage, createP0TupleIndex, retainP0Rows, failP0, assertP0View, checkP0Keys }
  from "../src/server/identity/internal/m2-p0.ts";
import type { P0Result, P0View, P0Request } from "../src/server/identity/internal/m2-p0.ts";
import { p0Fixture, addP0Row, p0Text, p0Integer } from "./helpers/m2-p0-a-fixture.ts";

function value<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function rejected<T>(result: P0Result<T>, code: string): void {
  assert.equal(result.ok, false); if (result.ok) assert.fail(); assert.equal(result.error.code, code);
}

for (const backend of ["sqlite", "postgres"] as const) for (const retained of [false, true]) {
  test(`invalid legacy JSON is depth checked at every site (${backend}, retained=${retained})`, () => {
    const input = p0Fixture(backend), text = "[".repeat(50) + "?";
    addP0Row(input, "audit_log", { changed: p0Text(backend, text) });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("audit_log")[0]!;
    const originalSite = p0RowSite(request, request.original, row, "changed");
    assert.equal(value(withP0Guard(request, () => readP0Json(request, row, "changed", "legacy-display", originalSite))), undefined);
    const view = retained ? retainP0Rows(request, [row]) : request.original;
    const site = p0RowSite(request, view, row, "changed");
    const boundary = p0NestedSite(request, site, 4), deeper = p0NestedSite(request, site, 5);
    assert.equal(value(withP0Guard(request, () => readP0Json(request, row, "changed", "legacy-display", boundary))), undefined);
    const result = withP0Guard(request, () => readP0Json(request, row, "changed", "legacy-display", deeper));
    rejected(result, "resource_limit");
    if (result.ok) assert.fail();
    assert.equal(result.error.phase, retained ? "retained-graph" : "original-graph");
    assert.equal(result.error.location?.rowOrdinal, 0);
    assert.equal(JSON.stringify(result).includes(text), false);
  });
}

test("P0-A admits the original primitive r2 envelope and retains all raw rows and original ordinals", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = p0Fixture(backend);
    addP0Row(input, "agents", { id: p0Text(backend, "same"), display_name: p0Text(backend, " \ufeff原值\u0000 ") }, "5");
    addP0Row(input, "agents", { id: p0Text(backend, "second") }, "8");
    const result = createP0Request(JSON.stringify(input, null, 2));
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    assert.equal(result.value.input.graph.observation.tables.length, 61);
    assert.equal(result.value.original.rowCount, 2);
    const rows = result.value.original.rows("agents");
    assert.deepEqual(rows.map(r => r.rowOrdinal), [0, 1]);
    assert.deepEqual(rows.map(r => r.raw), input.graph.observation.tables.find(t => t.name === "agents")!.rows);
    assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0]!.raw.cells));
    assert.equal(Object.hasOwn(result.value, "coverage"), false);
    assert.equal(Object.hasOwn(result.value, "checks"), false);
  }
});

test("P0-A rejects hostile unknown inputs without reading any property or prototype", () => {
  let touched = 0;
  const proxy = new Proxy({}, { get() { touched++; throw new Error("private"); }, ownKeys() { touched++; return []; },
    getPrototypeOf() { touched++; throw new Error("private"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [proxy, revoked.proxy, new String("{}"), Symbol("private"), () => null, null, 1]) {
    const result = createP0Request(value);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.error.code, "unsupported_shape");
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  assert.equal(touched, 0);
});

test("outer lexical checks reject decoded duplicate keys and rounding-based integer impostors", () => {
  const input = JSON.stringify(p0Fixture());
  for (const replacement of ['1.00000000000000001', '9007199254740993', '9.007199254740993e15', '-0']) {
    rejected(createP0Request(input.replace('"configFormat":1', `"configFormat":${replacement}`)), "invalid_value");
  }
  rejected(createP0Request(input.replace('"configFormat":1', '"configFormat":1,"config\\u0046ormat":1')), "invalid_value");
  assert.equal(createP0Request(input.replace('"configFormat":1', '"configFormat":1e0')).ok, true);
});

test("exact JSON integers retain long zero runs, exponent cancellation and safe boundaries", () => {
  const input = JSON.stringify(p0Fixture());
  const accepts = ["1" + "0".repeat(131072) + "e-131072", "1." + "0".repeat(4096), "1e+" + "0".repeat(4096)];
  for (const token of accepts) assert.equal(createP0Request(input.replace('"configFormat":1', `"configFormat":${token}`)).ok, true);
  for (const token of ["1" + "0".repeat(131072) + "1", "1" + "0".repeat(4096) + "1e-4097", "-0e999999999999999999", "9007199254740992"]) {
    rejected(createP0Request(input.replace('"configFormat":1', `"configFormat":${token}`)), "invalid_value");
  }
  for (const [token, expected] of [["900719925474099100e-2", 9007199254740991], ["-90071992547409910e-1", -9007199254740991], ["0e-999999999999999999", 0]] as const) {
    const source = p0Fixture(); addP0Row(source, "audit_log", { detail: p0Text("sqlite", token) });
    const semantic = value(createP0Request(JSON.stringify(source))), row = semantic.original.rows("audit_log")[0]!;
    assert.equal(value(withP0Guard(semantic, () => readP0Json(semantic, row, "detail", "reference"))), expected);
  }
});

test("raw int64 is exact; JS integer narrowing and TEXT/UTF8/OID adaptation are explicit", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = p0Fixture(backend);
    addP0Row(input, "mcp_connection_versions", { revision: p0Integer(backend, "mcp_connection_versions", "revision", 9223372036854775807n),
      configuration_json: p0Text(backend, '\ufeff { "n":1e0 }') });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("mcp_connection_versions")[0]!;
    assert.equal(value(withP0Guard(request, () => readP0Int64(request, row, "revision"))), 9223372036854775807n);
    rejected(withP0Guard(request, () => readP0SafeInteger(request, row, "revision")), "semantic_unsupported");
    assert.equal(value(withP0Guard(request, () => readP0Text(request, row, "configuration_json"))), '\ufeff { "n":1e0 }');
  }
  for (const cell of [["blob", "61"], ["text", "c080"]] as const) {
    const input = p0Fixture(); addP0Row(input, "agents", { id: [...cell] });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("agents")[0]!;
    rejected(withP0Guard(request, () => readP0Text(request, row, "id")), "semantic_unsupported");
  }
});

test("registered semantic JSON keeps raw bytes and exact integer math; old display syntax is separate", () => {
  for (const [text, expected, policy] of [
    [' { "n":1e0 } ', { n: 1 }, "reference"],
    ['{"x":1,"x":2,"n":1e400}', { x: 2, n: Infinity }, "legacy-display"],
    ['{broken', undefined, "legacy-display"],
    ['null', null, "legacy-display"],
  ] as const) {
    const input = p0Fixture(); addP0Row(input, "audit_log", { detail: p0Text("sqlite", text) });
    const original = JSON.stringify(input), request = value(createP0Request(original)), row = request.original.rows("audit_log")[0]!;
    assert.deepEqual(value(withP0Guard(request, () => readP0Json(request, row, "detail", policy))), expected);
    assert.equal(JSON.stringify(request.input), original);
  }
  for (const text of ['{"n":1.00000000000000001}', '{"n":9007199254740993}', '{"x":1,"\\u0078":2}']) {
    const input = p0Fixture(); addP0Row(input, "audit_log", { detail: p0Text("sqlite", text) });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("audit_log")[0]!;
    rejected(withP0Guard(request, () => readP0Json(request, row, "detail")), "semantic_unsupported");
  }
});

test("JSON keys and values are counted; semantic depth and resource usage continue in one request", () => {
  const input = p0Fixture(); addP0Row(input, "audit_log", { detail: p0Text("sqlite", '{"a":1}') });
  const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("audit_log")[0]!;
  const site = p0RowSite(request, request.original, row, "detail");
  const before = p0Usage(request).nodes;
  value(withP0Guard(request, () => readP0Json(request, row, "detail")));
  assert.equal(p0Usage(request).nodes - before, 3); // object + key + value
  value(withP0Guard(request, () => readP0Json(request, row, "detail")));
  assert.equal(p0Usage(request).nodes - before, 3); // immutable parsed cache
  rejected(withP0Guard(request, () => parseP0Json(request, "[[0]]", p0NestedSite(request, site, 53))), "resource_limit");
  rejected(withP0Guard(request, () => chargeP0(request, { work: 0 })), "resource_limit");
  const second = value(createP0Request(JSON.stringify(p0Fixture())));
  const remaining = 4_000_000 - p0Usage(second).work;
  value(withP0Guard(second, () => chargeP0(second, { work: remaining })));
  rejected(withP0Guard(second, () => chargeP0(second, { work: 1 })), "resource_limit");
});

test("typed tuple equality cannot confuse text, composite boundaries, large int64 or blob", () => {
  const request = value(createP0Request(JSON.stringify(p0Fixture()))), index = createP0TupleIndex<string>(request);
  for (const [key, item] of [
    [["a", "b:c"], "one"], [["a:b", "c"], "two"], [[1n], "integer"], [["1"], "text"],
    [[9223372036854775806n], "near"], [[9223372036854775807n], "max"], [[["blob", "31"]], "blob"],
  ] as const) assert.equal(index.insert(key, item), undefined);
  assert.equal(index.size, 7); assert.equal(index.get([1]), "integer");
  assert.equal(index.get(["1"]), "text"); assert.equal(index.get([9223372036854775807n]), "max");
  assert.equal(index.insert(["1"], "replacement"), "text"); assert.equal(index.get(["1"]), "text");
});

test("retained sites preserve original ordinals and redact unknown exceptions without reflection", () => {
  const input = p0Fixture(); addP0Row(input, "agents", { id: p0Text("sqlite", "private-first") });
  addP0Row(input, "agents", { id: p0Text("sqlite", "private-second") });
  const request = value(createP0Request(JSON.stringify(input))), second = request.original.rows("agents")[1]!;
  const view = retainP0Rows(request, [second]), site = p0RowSite(request, view, second, "id", "PC1B-ID01.P01");
  const failure = withP0Guard(request, () => failP0(request, { code: "semantic_invariant_failed", rule: "PC1B-ID01", site }));
  rejected(failure, "retained_reference_conflict"); if (failure.ok) assert.fail();
  assert.equal(failure.error.location!.rowOrdinal, 1); assert.equal(JSON.stringify(failure).includes("private-"), false);
  let touched = 0;
  const proxy = new Proxy({}, { get() { touched++; throw Error(); }, getPrototypeOf() { touched++; throw Error(); }, ownKeys() { touched++; throw Error(); } });
  const unknown = withP0Guard(request, () => { throw proxy; }); rejected(unknown, "invalid_value");
  if (unknown.ok) assert.fail(); assert.equal(unknown.error.location, null); assert.equal(unknown.error.rule, null); assert.equal(touched, 0);
});

test("a swallowed private budget failure cannot turn the request back into success", () => {
  const request = value(createP0Request(JSON.stringify(p0Fixture())));
  const result = withP0Guard(request, () => {
    try { chargeP0(request, { work: 4_000_000 }); } catch { /* simulate a caller bug */ }
    return "must not escape";
  });
  rejected(result, "resource_limit");
});

test("a cached semantic tree still pays inherited depth at a deeper consumption site", () => {
  const input = p0Fixture(); addP0Row(input, "audit_log", { detail: p0Text("sqlite", '{"a":[1]}') });
  const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("audit_log")[0]!;
  const site = p0RowSite(request, request.original, row, "detail");
  value(withP0Guard(request, () => readP0Json(request, row, "detail")));
  const deeper = p0NestedSite(request, site, 54);
  rejected(withP0Guard(request, () => readP0Json(request, row, "detail", "reference", deeper)), "resource_limit");
});

test("UTF8 syntax rejection is recognized from bytes; unknown decoder exceptions remain redacted", () => {
  const input = p0Fixture(); addP0Row(input, "agents", { id: p0Text("sqlite", "valid UTF8") });
  const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("agents")[0]!;
  let traps = 0;
  const thrown = new Proxy({}, { get() { traps++; throw Error(); }, getPrototypeOf() { traps++; throw Error(); } });
  const decode = TextDecoder.prototype.decode;
  try {
    TextDecoder.prototype.decode = function () { throw thrown; };
    const result = withP0Guard(request, () => readP0Text(request, row, "id"));
    rejected(result, "invalid_value"); if (result.ok) assert.fail();
    assert.equal(result.error.rule, null); assert.equal(result.error.location, null); assert.equal(traps, 0);
  } finally { TextDecoder.prototype.decode = decode; }
});

test("registered empty views are accepted while forged, cross-request and hostile views have no authority", () => {
  const request = value(createP0Request(JSON.stringify(p0Fixture()))), other = value(createP0Request(JSON.stringify(p0Fixture())));
  value(withP0Guard(request, () => assertP0View(request, retainP0Rows(request, []))));
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw Error(); }, getPrototypeOf() { traps++; throw Error(); }, ownKeys() { traps++; throw Error(); } });
  for (const view of [{ phase: "retained-graph", rowCount: 0, rows: () => [] }, other.original, hostile]) {
    const result = withP0Guard(request, () => assertP0View(request, view as P0View));
    rejected(result, "invalid_value"); if (result.ok) assert.fail(); assert.equal(result.error.location, null);
  }
  rejected(checkP0Keys(hostile as P0Request), "invalid_value"); assert.equal(traps, 0);
});

test("strict UTF8 recognizes scalar boundaries before decoding and preserves original bytes", () => {
  for (const hex of ["c280", "e0a080", "ed9fbf", "ee8080", "f0908080", "f48fbfbf"]) {
    const input = p0Fixture(); addP0Row(input, "agents", { id: ["text", hex] });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("agents")[0]!;
    assert.equal(Buffer.from(value(withP0Guard(request, () => readP0Text(request, row, "id")))!).toString("hex"), hex);
    assert.deepEqual(row.raw.cells[0], ["text", hex]);
  }
  for (const hex of ["c080", "eda080", "f4908080", "e180", "80", "e09f80", "ffff"]) {
    const input = p0Fixture(); addP0Row(input, "agents", { id: ["text", hex] });
    const request = value(createP0Request(JSON.stringify(input))), row = request.original.rows("agents")[0]!;
    rejected(withP0Guard(request, () => readP0Text(request, row, "id")), "semantic_unsupported");
  }
});

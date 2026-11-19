import test from "node:test";
import assert from "node:assert/strict";
import { parseM2HistoryCarrier, compareM2HistoryCarrier } from "../src/server/identity/internal/m2-history-carrier.ts";
import { parseM2HistoryObservation, compareM2HistoryPreservation } from "../src/server/identity/m2-history-values.ts";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import type { HistoryObservationInput, RawCell } from "../src/server/identity/m2-history-contracts.ts";

const HASH = "a".repeat(64);
const artifact = (ref: string) => ({ ref, sha256: HASH, bytes: "1" });
const evidence = (artifactId: string) => ({ artifactId, digest: HASH });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
// Complete typed carriers, deliberately without any claim of business-graph closure.
function fixture(backend: "sqlite" | "postgres" = "sqlite", phase: "p0" | "p1" = "p0"): HistoryObservationInput {
  return {
    contract: "m2-history-observation/r1", backend, phase, configFormat: 1,
    source: { kind: backend, databaseInstanceId: "1".repeat(32), identityDigest: HASH },
    physicalSourceRef: evidence("physical"), snapshotReceiptRef: evidence("snapshot"), catalog: artifact("catalog"),
    textEncoding: { backend, name: "UTF-8" },
    tables: M2_HISTORY_TABLES.filter(t => phase !== "p0" || t.columnsP0.length > 0).map(t => {
      const columns = phase === "p0" ? t.columnsP0 : t.columnsP1;
      const cells: RawCell[] = columns.map(c => c.name === t.sqliteRowidAlias
        ? backend === "sqlite" ? ["integer", "1"] : ["pg-binary", c.postgresTypeOid, "00000001"] : ["null"]);
      return { name: t.name, columnContract: artifact(`column:${t.name}`), columnContractValueDigest: HASH,
        columns: columns.map(c => c.name), count: "1", rows: [{ rowid: backend === "sqlite" ? "1" : null, cells }] };
    }),
    sequences: backend === "sqlite" ? [] : [{ contract: "m2-pc-pg-sequence-observation/r1", name: "schema_migrations_version_seq",
      relationIdentity: artifact("sequence"), lastValue: "22", isCalled: true }]
  };
}
function comparison(before: HistoryObservationInput, after: HistoryObservationInput, mode = "exact-p1") {
  return { contract: "m2-history-comparison-input/r1", mode, before, after,
    delta: { kind: mode === "exact-p1" ? "none" : "legacy-domain-only" } };
}
test("private carrier preserves complete 61/72 typed inputs and original TEXT bytes through the real parser", () => {
  for (const backend of ["sqlite", "postgres"] as const) for (const phase of ["p0", "p1"] as const) {
    const input = fixture(backend, phase), row = input.tables.find(t => t.name === "agents")!.rows[0]!;
    const text = Buffer.from('\ufeff { "id" : "  原值\r\n😀  ", "n":1e0 }', "utf8").toString("hex");
    row.cells[1] = backend === "sqlite" ? ["text", text] : ["pg-binary", "25", text];
    const expected = parseM2HistoryObservation(canonical(input));
    assert.equal(expected.ok, true);
    const actual = parseM2HistoryCarrier(JSON.stringify(input, null, 2));
    assert.deepEqual(actual, expected);
    if (!actual.ok) throw new Error("expected typed observation");
    assert.equal(actual.value.coverage, "complete-typed-rows");
    assert.equal(actual.value.remaining.find(x => x.check === "artifact_semantics")!.status, "unproven");
    assert.equal(actual.value.observation.tables.length, phase === "p0" ? 61 : 72);
    assert.ok(Object.isFrozen(actual.value.observation.tables[0]!.rows[0]!.cells));
    assert.equal(parseM2HistoryObservation(JSON.stringify(input, null, 2)).ok, false);
  }
});

test("outer preflight rejects duplicate decoded keys and inexact numbers before canonical encoding", () => {
  const input = JSON.stringify(fixture());
  const bad = [
    input.replace('"configFormat":1', '"configFormat":1,"configFormat":1'),
    input.replace('"configFormat":1', '"configFormat":1,"config\\u0046ormat":1'),
    input.replace('"configFormat":1', '"configFormat":1.00000000000000001'),
    input.replace('"configFormat":1', '"configFormat":9007199254740993'),
    input.replace('"configFormat":1', '"configFormat":9.007199254740993e15'),
    input.replace('"configFormat":1', '"configFormat":-0'),
    input.replace('"configFormat":1', '"configFormat":1e-100000000'),
    input.replace('"artifactId":"physical"', '"artifactId":"\\ud800"'),
    input.replace('"artifactId":"physical"', '"artifactId":"\ud800"'),
    input.slice(0, -1) + ",}", "{", "[] true", "{\"a\":1e}", "[01]"
  ];
  for (const text of bad) {
    const result = parseM2HistoryCarrier(text);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected invalid outer value");
    assert.equal(result.error.code, "invalid_value");
  }
  for (const literal of ["1.0", "1e0", "1e+0", "1e-000", "1e+0000000000000000000000", "1000000000000000000000000e-24"]) {
    assert.deepEqual(parseM2HistoryCarrier(input.replace('"configFormat":1', `"configFormat":${literal}`)),
      parseM2HistoryObservation(canonical(fixture())));
  }
});

test("comparison retains exact-p1 and legacy-a coverage while calling the real old comparison", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const before = fixture(backend, "p1"), after = structuredClone(before);
    assert.deepEqual(compareM2HistoryCarrier(JSON.stringify(comparison(before, after), null, 2)),
      compareM2HistoryPreservation(canonical(comparison(before, after))));
    const legacy = fixture(backend, "p0"), target = fixture(backend, "p1");
    for (const [value, count] of [[legacy, 21], [target, 22]] as const) {
      const table = value.tables.find(t => t.name === "schema_migrations")!, version = table.columns.indexOf("version");
      const contract = M2_HISTORY_TABLES.find(t => t.name === "schema_migrations")!.columnsP1[version]!;
      table.rows = Array.from({ length: count }, (_, i) => {
        const cells = table.columns.map(() => ["null"] as RawCell);
        cells[version] = backend === "sqlite" ? ["integer", String(i + 1)]
          : ["pg-binary", contract.postgresTypeOid, (i + 1).toString(16).padStart(contract.postgresTypeOid === "23" ? 8 : 16, "0")];
        return { rowid: backend === "sqlite" ? String(i + 1) : null, cells };
      });
      table.count = String(count);
    }
    const input = comparison(legacy, target, "legacy-a-preservation");
    const actual = compareM2HistoryCarrier(JSON.stringify(input));
    assert.deepEqual(actual, compareM2HistoryPreservation(canonical(input)));
    assert.equal(actual.ok, true);
    if (!actual.ok) throw new Error("expected legacy-only comparison");
    assert.equal(actual.value.coverage, "legacy-domain-only");
    assert.deepEqual(actual.value.unverifiedTargetDomains, ["new-m2-rows", "control-transition", "migration22", "audit-additions", "native-target-schema"]);
  }
});

test("all reachable old rejection codes are mapped without returning the old path", () => {
  const checks: [string, string, (input: HistoryObservationInput) => void][] = [
    ["unsupported_shape", "unsupported_shape", v => { (v as { contract: string }).contract = "private-unsupported-contract"; }],
    ["invalid_value", "invalid_value", v => { v.tables[0]!.rows[0]!.rowid = "not-an-int64"; }],
    ["incomplete_universe", "source_contract_mismatch", v => { v.tables.pop(); }],
    ["column_contract_mismatch", "source_contract_mismatch", v => { v.tables[0]!.columns.pop(); }],
    ["format_unregistered", "format_unregistered", v => { (v as { configFormat: number }).configFormat = 2; }]
  ];
  for (const [oldCode, code, mutate] of checks) {
    const input = fixture(); mutate(input);
    const old = parseM2HistoryObservation(canonical(input)), result = parseM2HistoryCarrier(JSON.stringify(input));
    assert.equal(old.ok, false); assert.equal(result.ok, false);
    if (old.ok || result.ok) throw new Error("expected owner failure");
    assert.equal(old.error.code, oldCode); assert.equal(result.error.code, code);
    assert.equal(Object.hasOwn(result.error, "path"), false);
  }
  const before = fixture("sqlite", "p1"), after = structuredClone(before);
  after.tables.find(t => t.name === "agents")!.rows[0]!.cells[0] = ["text", "534543524554"];
  const input = comparison(before, after);
  const old = compareM2HistoryPreservation(canonical(input)), result = compareM2HistoryCarrier(JSON.stringify(input));
  assert.equal(old.ok, false); assert.equal(result.ok, false);
  if (old.ok || result.ok) throw new Error("expected preservation failure");
  assert.equal(old.error.code, "row_mismatch"); assert.equal(result.error.code, "semantic_invariant_failed");
  assert.equal(result.error.location!.table, "agents");
  assert.equal(result.error.location!.rowOrdinal, null); // The old comparison does not identify a side.
});

test("sensitive D, keys, ref strings and unsupported input names never appear in failures", () => {
  const secret = "SYNTHETIC-secret-复合主键", hex = Buffer.from(secret).toString("hex"), base64 = Buffer.from(secret).toString("base64");
  const input = fixture();
  const variants = [
    { ...input, proposedDeletion: { rows: [{ table: "agents", key: [["text", hex]], rowid: secret }] } },
    { ...input, [secret]: { ref: secret, [base64]: hex } },
    { ...input, tables: [{ ...input.tables[0], name: secret }, ...input.tables.slice(1)] },
    { ...input, physicalSourceRef: { artifactId: secret, digest: secret } }
  ];
  for (const value of variants) {
    const result = parseM2HistoryCarrier(JSON.stringify(value));
    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    for (const forbidden of [secret, hex, base64]) assert.ok(!text.includes(forbidden));
    assert.ok(Buffer.byteLength(text) < 2048);
  }
});

test("non-string inputs and unknown thrown proxies are not inspected", t => {
  let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw new Error("private getter"); }, ownKeys() { traps++; throw new Error("private keys"); },
    getPrototypeOf() { traps++; throw new Error("private prototype"); } });
  for (const call of [parseM2HistoryCarrier, compareM2HistoryCarrier]) {
    for (const input of [proxy, Symbol("private"), () => {}, { toJSON() { traps++; return {}; } }]) {
      const result = call(input);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("expected primitive boundary");
      assert.equal(result.error.code, "unsupported_shape");
    }
  }
  const mock = t.mock.method(Buffer, "byteLength", () => { throw proxy; });
  let result;
  try { result = parseM2HistoryCarrier("{}"); } finally { mock.mock.restore(); }
  assert.equal(traps, 0);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fixed unknown failure");
  assert.equal(result.error.code, "invalid_value"); assert.equal(result.error.rule, null); assert.equal(result.error.location, null);
  assert.equal(Object.hasOwn(result.error, "cause"), false);
});

test("unknown failures inside the real old consumer keep their identity without reflecting the thrown value", t => {
  for (const call of [parseM2HistoryCarrier, compareM2HistoryCarrier]) {
    let prototypeTraps = 0, propertyTraps = 0;
    const proxy = new Proxy({}, {
      getPrototypeOf() { prototypeTraps++; return null; },
      get() { propertyTraps++; throw new Error("private exception property"); },
      ownKeys() { propertyTraps++; throw new Error("private exception keys"); },
    });
    for (const thrown of [proxy, Symbol("private downstream exception")]) {
      const original = Buffer.byteLength;
      let calls = 0;
      const mock = t.mock.method(Buffer, "byteLength", (...args: Parameters<typeof Buffer.byteLength>) => {
        // Outer scan and carrier length are the first two calls; the third is the real consumer's read.
        if (++calls === 3) throw thrown;
        return original(...args);
      });
      let result;
      try { result = call("{}"); } finally { mock.mock.restore(); }
      assert.equal(calls, 3);
      assert.equal(prototypeTraps, 0);
      assert.equal(propertyTraps, 0);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error("expected downstream unknown failure");
      assert.equal(result.error.code, "invalid_value");
      assert.equal(result.error.rule, null);
      assert.equal(result.error.location, null);
      assert.deepEqual(result.error.conflicts, []);
      assert.ok(Object.isFrozen(result.error));
    }
    // An ordinary known root-shape failure still gets its known rule/location on a later request.
    const known = call("{}");
    assert.equal(known.ok, false);
    if (known.ok) throw new Error("expected known root-shape failure");
    assert.equal(known.error.code, "invalid_value");
    assert.equal(known.error.rule, "PC1B-RAW01");
    assert.equal(known.error.location?.pathId, "input.root");
  }
});

test("original public parser and comparison retain their exact unknown-failure DTO", t => {
  for (const call of [parseM2HistoryObservation, compareM2HistoryPreservation]) {
    let prototypeTraps = 0;
    const proxy = new Proxy({}, { getPrototypeOf() { prototypeTraps++; return null; } });
    const mock = t.mock.method(Buffer, "byteLength", () => { throw proxy; });
    let result;
    try { result = call("{}"); } finally { mock.mock.restore(); }
    assert.equal(prototypeTraps, 0);
    assert.deepEqual(result, { ok: false, error: { code: "invalid_value", path: [] } });
    assert.deepEqual(Reflect.ownKeys(result), ["ok", "error"]);
    if (result.ok) throw new Error("expected original total failure");
    assert.deepEqual(Reflect.ownKeys(result.error), ["code", "path"]);
    assert.ok(Object.isFrozen(result.error.path));
  }
});

test("input/depth/node and actual returned-value limits remain explicit resource failures", () => {
  for (const input of [" ".repeat(16 * 1024 * 1024 + 1), "[".repeat(65) + "0" + "]".repeat(65),
    "[" + Array(250_001).fill("null").join(",") + "]"]) {
    const result = parseM2HistoryCarrier(input);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("expected bounded preflight");
    assert.equal(result.error.code, "resource_limit");
  }
  const input = fixture(); input.physicalSourceRef = { ...input.physicalSourceRef, artifactId: "x".repeat(1024 * 1024) };
  assert.equal(parseM2HistoryObservation(canonical(input)).ok, true);
  const result = parseM2HistoryCarrier(JSON.stringify(input));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected private result size limit");
  assert.equal(result.error.code, "resource_limit");
});

test("one request shares both comparison sides and the downstream sorting/encoding budget", () => {
  const input = fixture("sqlite", "p1"), table = input.tables.find(t => t.name === "agents")!;
  table.rows = Array.from({ length: 500 }, (_, i) => ({ rowid: String(i + 1), cells: table.rows[0]!.cells.map(c => [...c] as RawCell) }));
  table.count = String(table.rows.length);
  assert.equal(parseM2HistoryCarrier(JSON.stringify(input)).ok, true);
  assert.equal(parseM2HistoryCarrier(JSON.stringify(input)).ok, true); // No cross-call proof/budget cache.
  const old = compareM2HistoryPreservation(canonical(comparison(input, input)));
  assert.equal(old.ok, true);
  const result = compareM2HistoryCarrier(JSON.stringify(comparison(input, input)));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected cumulative resource limit");
  assert.equal(result.error.code, "resource_limit");
  assert.equal(result.error.conflicts[0]!.condition, "budget-exceeded");
});

test("nested canonical joins, metadata comparisons and final hashes share the same character budget", () => {
  const observation = fixture("sqlite", "p1");
  for (const table of observation.tables) if (table.name !== "config_authority") {
    table.rows = []; table.count = "0";
  }
  observation.catalog = { ...observation.catalog, ref: "x".repeat(2_300_000) };
  const oversized = comparison(observation, observation);
  // This is a valid Stage1a value; its repeated encoding/compare/hash work exceeds C1's one budget.
  assert.equal(compareM2HistoryPreservation(canonical(oversized)).ok, true);
  const result = compareM2HistoryCarrier(JSON.stringify(oversized));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected cumulative downstream character limit");
  assert.equal(result.error.code, "resource_limit");
  observation.catalog = { ...observation.catalog, ref: "x".repeat(50_000) };
  const bounded = comparison(observation, observation);
  const expected = compareM2HistoryPreservation(canonical(bounded));
  assert.equal(expected.ok, true);
  assert.deepEqual(compareM2HistoryCarrier(JSON.stringify(bounded)), expected);
});

test("deep raw TEXT and Unicode references compare without repeatedly copying ancestor encodings", () => {
  const observation = fixture("sqlite", "p1"), table = observation.tables.find(t => t.name === "agents")!;
  table.rows[0]!.cells[1] = ["text", "20".repeat(300_000)];
  observation.catalog = { ...observation.catalog, ref: '目录😀\u0001 \\ " \u2028' };
  observation.physicalSourceRef = { ...observation.physicalSourceRef, artifactId: "源𐀀\ufeff𝄞" };
  const input = comparison(observation, observation);
  const expected = compareM2HistoryPreservation(canonical(input));
  assert.equal(expected.ok, true);
  if (!expected.ok) throw new Error("expected original typed comparison");
  // Frozen before the flat-encoder change, with the original recursive consumer.
  assert.equal(expected.value.beforeValueDigest, "e8af97dd22bb9f3f7e5dae451e3acee82742d9584c7a0c208abdf23e04b075c7");
  assert.deepEqual(compareM2HistoryCarrier(JSON.stringify(input, null, 2)), expected);
});

test("owner errors use fixed catalog locations and original row/one-based column ordinals", () => {
  const input = fixture(), table = input.tables.find(t => t.name === "agents")!;
  table.rows = Array.from({ length: 4 }, (_, i) => ({ rowid: String(i + 1), cells: table.rows[0]!.cells.map(c => [...c] as RawCell) }));
  table.count = "4";
  table.rows[3]!.cells[1] = ["integer", "SECRET-PK-NOT-AN-INTEGER"];
  const old = parseM2HistoryObservation(canonical(input));
  assert.equal(old.ok, false);
  const result = parseM2HistoryCarrier(JSON.stringify(input));
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected raw-cell rejection");
  assert.deepEqual(result.error.location, { inputPart: "observation", artifactOrdinal: null, table: "agents",
    rowOrdinal: 3, columnOrdinal: 2, pathId: "row.cell" });
  assert.equal(result.error.phase, "original-graph");
  assert.equal(result.error.conflicts[0]!.target, null);
  assert.ok(Object.isFrozen(result.error.conflicts[0]!.source));
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

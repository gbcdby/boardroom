import assert from "node:assert/strict";
import test from "node:test";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { validateM2HistoryClosure } from "../src/server/identity/m2-history-closure.ts";
import type { ClosureResult } from "../src/server/identity/m2-history-closure.ts";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import type { HistoryObservationInput } from "../src/server/identity/m2-history-contracts.ts";
import { parseM2HistoryObservation } from "../src/server/identity/m2-history-values.ts";
import { P0_RULES } from "../src/server/identity/internal/m2-p0-types.ts";
import { p0ArtifactFixture } from "./helpers/m2-p0-f-fixture.ts";
import { p0Fixture } from "./helpers/m2-p0-a-fixture.ts";

// Independent oracle for the closed ASCII-key envelope; JSON string values keep
// their original Unicode spelling, and raw TEXT remains its unchanged hex string.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
function success(result: ClosureResult) { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) assert.fail(); return result.value; }
function failure(result: ClosureResult, code: string) { assert.equal(result.ok, false); if (result.ok) assert.fail(); assert.equal(result.error.code, code); return result.error; }
function deeplyFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") { assert(Object.isFrozen(value)); for (const child of Object.values(value)) deeplyFrozen(child); }
}
function selector(input: ReturnType<typeof p0ArtifactFixture>, name: string, ordinal = 0) {
  const table = input.graph.observation.tables.find(table => table.name === name)!;
  const fixed = M2_HISTORY_TABLES.find(table => table.name === name)!;
  const row = table.rows[ordinal]!;
  return { table: name, key: fixed.primaryKey.map(column => row.cells[table.columns.indexOf(column)]!), rowid: row.rowid };
}
function deletionInput(input: ReturnType<typeof p0ArtifactFixture>, rows: ReturnType<typeof selector>[]) {
  return JSON.stringify({ ...input, proposedDeletion: { rows } });
}

test("P0 facade issues complete value closure only after all six real families", () => {
  const input = p0ArtifactFixture(), before = canonical(input), result = validateM2HistoryClosure(JSON.stringify(input));
  const value = success(result), stage1 = parseM2HistoryObservation(canonical(input.graph.observation));
  assert(stage1.ok);
  assert.equal(value.catalog, "legacy-p0"); assert.equal(value.graphKind, "m2-observation");
  assert.equal(value.coverage, "complete-history-value-closure"); assert.equal(value.phase, "p0");
  assert.equal(value.completeHistoryDigest, hash(["m2-pc-complete-history/r1", input.graph.observation]));
  assert.equal(value.inputDigest, hash(["m2-pc-closure-input/r2", input]));
  assert.deepEqual(value.tables, stage1.value.tableDigests.map(table => ({ table: table.name, rows: table.count, rowMultisetDigest: table.rowMultisetDigest })));
  assert.equal(value.tables.length, 61); assert.deepEqual(value.ruleCoverage.map(entry => entry.rule), P0_RULES);
  assert.equal(value.ruleCoverage.filter(entry => entry.status === "verified").length, 43);
  assert.deepEqual(value.ruleCoverage.filter(entry => entry.status === "not-applicable").map(entry => entry.rule),
    ["PC1B-M201", "PC1B-M202", "PC1B-M203", "PC1B-M204", "PC1B-DEL01"]);
  assert.deepEqual(value.selectedArtifacts, input.artifacts.map((entry, artifactOrdinal) => ({ kind: entry.kind,
    artifactOrdinal, byteDigest: entry.artifact.sha256, bytes: entry.artifact.bytes })));
  assert.deepEqual(value.checks, { legacySemanticGraph: "verified", m2SemanticGraph: "not-applicable", layoutSemanticGraph: "not-applicable",
    artifactBytes: "verified", artifactSemantics: "verified", sourceProvenance: "verified-values", retainedReferenceClosure: "not-requested" });
  assert.equal(value.deletion, null); assert.equal(value.remaining.length, 12);
  assert.deepEqual(value.remaining.filter(entry => entry.status === "not-applicable").map(entry => entry.check), ["strict_p1_native_outer_join", "sequence_exclusion"]);
  assert(value.remaining.filter(entry => entry.status !== "not-applicable").every(entry => entry.status === "unproven"));
  assert.equal(canonical(input), before); deeplyFrozen(result);
  const output = JSON.stringify(result);
  for (const forbidden of ["sourcePath", "canCommit", "runReady", "bytesHex", "controlRoot", "snapshotId", "/a12/"])
    assert.equal(output.includes(forbidden), false, forbidden);
});

test("empty D runs the retained pass and uses the r2 virtual history digest", () => {
  const input = p0ArtifactFixture(), wire = deletionInput(input, []), parsed = JSON.parse(wire);
  const value = success(validateM2HistoryClosure(wire));
  assert.equal(value.checks.retainedReferenceClosure, "verified"); assert(value.deletion);
  assert.equal(value.deletion.requestedCount, "0"); assert.equal(value.deletion.valueConsistent, true);
  assert.equal(value.deletion.retainedHistoryDigest, hash(["m2-pc-retained-history/r2", value.completeHistoryDigest, [], input.graph.observation]));
  assert.equal(value.inputDigest, hash(["m2-pc-closure-input/r2", parsed]));
  assert.equal(value.ruleCoverage.filter(entry => entry.status === "verified").length, 44);
  assert.deepEqual(value.deletion.retainedCounts, value.tables.map(({ table, rows }) => ({ table, rows })));
});

test("the complete input digest retains Unicode and escaped evidence aliases", () => {
  const input = p0ArtifactFixture(), alias = "\ufeff证据😀\0\"\\";
  input.graph.observation.physicalSourceRef = { ...input.graph.observation.physicalSourceRef, artifactId: alias };
  input.evidence[0]!.evidence.artifactId = alias;
  const value = success(validateM2HistoryClosure(JSON.stringify(input)));
  assert.equal(value.inputDigest, hash(["m2-pc-closure-input/r2", input]));
  assert.equal(value.completeHistoryDigest, hash(["m2-pc-complete-history/r1", input.graph.observation]));
  assert.equal(JSON.stringify(value).includes("证据"), false);
});

test("precise D rejects duplicate, absent, NULL and wrong-storage selectors without echo", () => {
  const input = p0ArtifactFixture(), row = selector(input, "schema_migrations");
  const cases = [
    { rows: [row, row], condition: "duplicate-key" },
    { rows: [{ ...row, rowid: "9223372036854775807" }], condition: "missing-target" },
    { rows: [{ ...row, key: [["null"]] }], condition: "missing-target" },
    { rows: [{ ...row, key: [["text", Buffer.from("SECRET-SELECTOR").toString("hex")]] }], condition: "missing-target" },
  ];
  for (const item of cases) {
    const error = failure(validateM2HistoryClosure(JSON.stringify({ ...input, proposedDeletion: { rows: item.rows } })), "invalid_value");
    assert.equal(error.rule, "PC1B-DEL01"); assert.equal(error.conflicts[0]!.condition, item.condition);
    assert.equal(error.conflicts[0]!.target, null); assert.equal(error.location!.rowOrdinal, null);
    assert.equal(JSON.stringify(error).includes("SECRET"), false); assert.equal(JSON.stringify(error).includes("rowid"), false);
  }
});

test("DEL01 protects migration rows and maintenance even when its client is also selected", () => {
  const input = p0ArtifactFixture({ sourceClient: true });
  for (const rows of [[selector(input, "schema_migrations")], [selector(input, "storage_maintenance"), selector(input, "storage_source_clients")]]) {
    const error = failure(validateM2HistoryClosure(deletionInput(input, rows)), "retained_reference_conflict");
    assert.equal(error.phase, "retained-graph"); assert.equal(error.rule, "PC1B-DEL01");
    assert.equal(error.location!.table, rows[0]!.table); assert.equal(error.location!.rowOrdinal, 0);
  }
  const first = selector(input, "schema_migrations", 0), last = selector(input, "schema_migrations", 20);
  assert.deepEqual(validateM2HistoryClosure(deletionInput(input, [last, first])), validateM2HistoryClosure(deletionInput(input, [first, last])));
});

test("the original invalid graph cannot be laundered by deleting the invalid row", () => {
  const input = p0ArtifactFixture(), table = input.graph.observation.tables.find(table => table.name === "schema_migrations")!;
  const row = selector(input, table.name);
  table.rows[0]!.cells[table.columns.indexOf("checksum")] = ["text", Buffer.from("not-original-checksum").toString("hex")];
  const original = failure(validateM2HistoryClosure(JSON.stringify(input)), "artifact_semantic_mismatch");
  const deleted = failure(validateM2HistoryClosure(deletionInput(input, [row])), "artifact_semantic_mismatch");
  assert.equal(original.rule, "PC1B-ART01"); assert.deepEqual(deleted, original);
});

test("historical source-client deletion keeps the original artifact context", () => {
  const input = p0ArtifactFixture({ sourceClient: true });
  const value = success(validateM2HistoryClosure(deletionInput(input, [selector(input, "storage_source_clients")])));
  assert(value.deletion); assert.equal(value.deletion.retainedCounts.find(table => table.table === "storage_source_clients")!.rows, "0");
  assert.equal(value.selectedArtifacts.length, input.artifacts.length);
  assert.equal(value.completeHistoryDigest, hash(["m2-pc-complete-history/r1", input.graph.observation]));
});

test("cold, warm and failure-then-success calls do not share semantic success", () => {
  const input = p0ArtifactFixture(), wire = JSON.stringify(input), first = validateM2HistoryClosure(wire);
  success(first);
  const bad = structuredClone(input); bad.artifacts[0]!.bytesHex = "00";
  failure(validateM2HistoryClosure(JSON.stringify(bad)), "artifact_bytes_mismatch");
  assert.deepEqual(validateM2HistoryClosure(wire), first);
  assert.deepEqual(validateM2HistoryClosure(wire), first);
});

test("the public primitive boundary and arbitrary native exceptions have zero reflection", () => {
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw 1; }, getPrototypeOf() { traps++; throw 2; },
    ownKeys() { traps++; throw 3; }, getOwnPropertyDescriptor() { traps++; throw 4; } });
  for (const input of [hostile, Object("{}"), Symbol("SECRET"), () => 1, null, 1, []])
    failure(validateM2HistoryClosure(input), "unsupported_shape");
  assert.equal(traps, 0);
  const wire = JSON.stringify(p0ArtifactFixture()), original = crypto.createHash;
  let result: ClosureResult;
  try {
    crypto.createHash = (() => { throw hostile; }) as typeof crypto.createHash;
    syncBuiltinESMExports(); result = validateM2HistoryClosure(wire);
  } finally { crypto.createHash = original; syncBuiltinESMExports(); }
  const error = failure(result!, "invalid_value");
  assert.equal(traps, 0); assert.equal(error.rule, null); assert.equal(error.location, null); assert.deepEqual(error.conflicts, []);
});

const branchRef = { ref: "known", sha256: "a".repeat(64), bytes: "1" };
const branchOrigin = { sourceHistory: branchRef, importManifest: null };
function p1Observation(): HistoryObservationInput {
  const original = p0Fixture().graph.observation;
  return { ...original, phase: "p1", tables: M2_HISTORY_TABLES.map(table => ({ name: table.name,
    columnContract: branchRef, columnContractValueDigest: branchRef.sha256, columns: table.columnsP1.map(column => column.name),
    count: table.name === "config_authority" ? "1" : "0", rows: table.name === "config_authority"
      ? [{ rowid: "1", cells: table.columnsP1.map(column => column.name === "singleton" ? ["integer", "1"] : ["null"]) }] : [] })) };
}
test("known unimplemented branches use one scanner and the fixed semantic_unsupported result", () => {
  const graphs = [
    { kind: "m2-observation", observation: p1Observation(), origin: branchOrigin },
    { kind: "p1-source-cut", cut: branchRef, origin: branchOrigin },
    { kind: "p1-source-history", observation: p1Observation(), snapshotLink: branchRef, origin: branchOrigin },
    { kind: "layout-history", history: branchRef, origin: branchOrigin },
  ];
  for (const graph of graphs) {
    const wire = JSON.stringify({ ...p0Fixture(), graph }), native = JSON.parse;
    let fullParses = 0, result: ClosureResult;
    try {
      JSON.parse = ((text: string, ...args: unknown[]) => { if (text === wire) fullParses++; return Reflect.apply(native, JSON, [text, ...args]); }) as typeof JSON.parse;
      result = validateM2HistoryClosure(wire);
    } finally { JSON.parse = native; }
    const error = failure(result!, "semantic_unsupported");
    assert.equal(fullParses, 1); assert.equal(error.phase, "input"); assert.equal(error.rule, "PC1B-RAW01");
    assert.equal(error.conflicts[0]!.condition, "undefined-grammar"); assert.equal(error.conflicts[0]!.target, null);
    assert.equal(error.location!.rowOrdinal, null);
    failure(validateM2HistoryClosure(JSON.stringify({ ...p0Fixture(), graph: { ...graph, extra: 1 } })), "unsupported_shape");
    failure(validateM2HistoryClosure(JSON.stringify({ ...p0Fixture(), graph, artifacts: null })), "unsupported_shape");
  }
});

test("unknown, malformed and new-facade bootstrap roots stay unsupported_shape", () => {
  const graphs = [
    { kind: "unknown", observation: p1Observation(), origin: branchOrigin },
    { kind: "p1-source-cut", origin: branchOrigin },
    { kind: "layout-history", history: branchRef, origin: null },
    { kind: "m2-observation", observation: { phase: "p1" }, origin: branchOrigin },
    { kind: "m2-observation", observation: { ...p1Observation(), phase: "unknown" }, origin: branchOrigin },
    { kind: "m2-observation", observation: { ...p1Observation(), phase: "p1-bootstrap" }, origin: branchOrigin },
  ];
  for (const graph of graphs) failure(validateM2HistoryClosure(JSON.stringify({ ...p0Fixture(), graph })), "unsupported_shape");
});

test("the facade preserves duplicate-key, lexical and fixed outer-byte limits", () => {
  failure(validateM2HistoryClosure('{"contract":1,"contract":2}'), "invalid_value");
  failure(validateM2HistoryClosure('{"x":-0}'), "invalid_value");
  failure(validateM2HistoryClosure('"' + "a".repeat(16 * 1024 * 1024) + '"'), "resource_limit");
});

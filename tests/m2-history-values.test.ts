import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { M2_COLUMN_CONTRACT, M2_FORMAT_REGISTRATION } from "../src/server/identity/m2-value-contracts.ts";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import type { HistoryObservationInput, RawCell, RawTable } from "../src/server/identity/m2-history-contracts.ts";
import { parseM2HistoryObservation, compareM2HistoryPreservation } from "../src/server/identity/m2-history-values.ts";
import * as importedValues from "../src/server/identity/m2-history-values.ts";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
// All envelope keys in these fixtures are ASCII; this is the independent test encoder.
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${json((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const ref = (name: string) => ({ ref: `selected/${name}`, bytes: "1", sha256: digest(name) });
function fixture(backend: "sqlite" | "postgres" = "sqlite", phase: "p0" | "p1" | "p1-bootstrap" = "p1"): HistoryObservationInput {
  const tables: RawTable[] = M2_HISTORY_TABLES.filter(t => phase !== "p0" || t.columnsP0.length > 0).map(t => {
    const columns = phase === "p0" ? t.columnsP0 : t.columnsP1;
    return { name: t.name, columnContract: ref(`${t.name}/${phase === "p0" ? "old" : "target"}`),
      columnContractValueDigest: digest(`${t.name}/${columns.length}`), columns: columns.map(c => c.name), count: "0", rows: [] };
  });
  const out: HistoryObservationInput = { contract: "m2-history-observation/r1", backend, phase, configFormat: 1,
    source: { kind: backend, databaseInstanceId: "1".repeat(32), identityDigest: digest("source") },
    physicalSourceRef: { artifactId: "physical", digest: digest("physical") }, snapshotReceiptRef: { artifactId: "snapshot", digest: digest("snapshot") },
    catalog: ref(`catalog/${phase === "p0" ? "old" : "target"}`), textEncoding: { backend, name: "UTF-8" }, tables,
    sequences: backend === "sqlite" ? [] : [{ contract: "m2-pc-pg-sequence-observation/r1", name: "schema_migrations_version_seq",
      relationIdentity: ref("sequence"), lastValue: phase === "p0" ? "21" : "22", isCalled: true }] };
  add(out, "agents", { id: text(backend, "agent-a"), display_name: text(backend, "original") });
  add(out, "audit_log", { id: text(backend, "audit-a"), action: text(backend, "member.add") });
  for (let version = 1; version <= (phase === "p0" ? 21 : 22); version++) add(out, "schema_migrations", { version: integer(backend, "schema_migrations", "version", version) }, String(version));
  if (phase === "p1") add(out, "config_authority", { singleton: integer(backend, "config_authority", "singleton", 1) }, "1");
  return out;
}
function text(backend: string, value: string): RawCell { const hex = Buffer.from(value).toString("hex"); return backend === "sqlite" ? ["text", hex] : ["pg-binary", "25", hex]; }
function integer(backend: string, table: string, column: string, value: number): RawCell {
  if (backend === "sqlite") return ["integer", String(value)];
  const oid = M2_HISTORY_TABLES.find(t => t.name === table)!.columnsP1.find(c => c.name === column)!.postgresTypeOid;
  const bytes = Buffer.alloc(oid === "23" ? 4 : 8); if (oid === "23") bytes.writeInt32BE(value); else bytes.writeBigInt64BE(BigInt(value));
  return ["pg-binary", oid, bytes.toString("hex")];
}
function add(value: HistoryObservationInput, name: string, values: Record<string, RawCell>, rowid?: string): void {
  const table = value.tables.find(t => t.name === name)!;
  table.rows.push({ rowid: value.backend === "sqlite" ? rowid ?? String(table.rows.length + 101) : null,
    cells: table.columns.map(c => values[c] ?? ["null"]) }); table.count = String(table.rows.length);
}
function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T { if (!result.ok) assert.fail(JSON.stringify(result)); return result.value; }

test("PC01/26: actual 22/F1 parses complete nonempty SQLite and PG observations", () => {
  for (const backend of ["sqlite", "postgres"] as const) for (const phase of ["p0", "p1", "p1-bootstrap"] as const) {
    const input = fixture(backend, phase), result = ok(parseM2HistoryObservation(json(input)));
    assert.equal(result.classification, "observation"); assert.equal(result.coverage, "complete-typed-rows");
    assert.deepEqual(result.observation, input); assert.equal(result.tableDigests.length, phase === "p0" ? 61 : 72);
    assert.equal(result.remaining.length, 11);
    assert.equal(result.remaining.find(x => x.check === "sequence_exclusion")!.status, backend === "sqlite" ? "not-applicable" : "unproven");
    for (const item of result.remaining.filter(x => x.check !== "sequence_exclusion")) assert.equal(item.status, "unproven");
    assert.equal(Object.isFrozen(result.observation.tables[0]!.rows), true);
  }
});

const clone = <T>(value: T): T => structuredClone(value);
function comparison(before: HistoryObservationInput, after: HistoryObservationInput, mode = "exact-p1") {
  return { contract: "m2-history-comparison-input/r1", mode, before, after,
    delta: { kind: mode === "exact-p1" ? "none" : "legacy-domain-only" } };
}
function rejected(result: { ok: boolean; error?: { code: string } }, code: string): void {
  assert.equal(result.ok, false); assert.equal(result.error!.code, code);
}
test("PC08/18/26: both complete exact-P1 and old-domain preservation really succeed", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const before = fixture(backend), after = clone(before);
    after.tables.find(t => t.name === "schema_migrations")!.rows.reverse();
    const exact = ok(compareM2HistoryPreservation(json(comparison(before, after))));
    assert.equal(exact.coverage, "complete-typed-rows"); assert.equal(exact.tables.length, 72);
    assert.deepEqual(exact.unverifiedTargetDomains, []); assert.equal(exact.remaining.length, 11);
    const legacy = fixture(backend, "p0"), target = fixture(backend);
    add(target, "audit_log", { id: text(backend, "audit-new"), action: text(backend, "activation") }, "999");
    const partial = ok(compareM2HistoryPreservation(json(comparison(legacy, target, "legacy-a-preservation"))));
    assert.equal(partial.coverage, "legacy-domain-only"); assert.equal(partial.tables.length, 59);
    assert.deepEqual(partial.unverifiedTargetDomains, ["new-m2-rows", "control-transition", "migration22", "audit-additions", "native-target-schema"]);
    assert.equal(partial.tables.find(t => t.name === "audit_log")!.comparedCount, "1");
  }
});
test("PC08/09: non-key, storage type, rowid, raw JSON and multiplicity differences fail", () => {
  const before = fixture();
  const agents = before.tables.find(t => t.name === "agents")!, column = agents.columns.indexOf("display_name");
  assert.ok(column >= 0);
  agents.rows[0]!.cells[column] = ["text", Buffer.from('{ "x":1 }').toString("hex")];
  for (const mutate of [
    (t: RawTable) => { t.rows[0]!.cells[column] = ["text", "31"]; },
    (t: RawTable) => { t.rows[0]!.cells[column] = ["blob", agents.rows[0]!.cells[column]![1]!]; },
    (t: RawTable) => { t.rows[0]!.rowid = "102"; },
    (t: RawTable) => { t.rows[0]!.cells[column] = ["text", Buffer.from('{"x":1}').toString("hex")]; },
  ]) {
    const after = clone(before); mutate(after.tables.find(t => t.name === "agents")!);
    rejected(compareM2HistoryPreservation(json(comparison(before, after))), "row_mismatch");
  }
  const a = clone(agents.rows[0]!), b = clone(a); b.rowid = "202";
  agents.rows = [a, a, b]; agents.count = "3";
  const changed = clone(before), target = changed.tables.find(t => t.name === "agents")!;
  target.rows = [a, b, b];
  rejected(compareM2HistoryPreservation(json(comparison(before, changed))), "row_mismatch");
});

test("PC01/28: catalog matches independently executed schema1–21 and registered P-A target names", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations.filter(m => m.version <= 21));
    const names = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    const old = M2_HISTORY_TABLES.filter(t => t.columnsP0.length > 0);
    assert.deepEqual(old.map(t => t.name), names); assert.equal(names.length, 61);
    assert.equal(old.reduce((n, t) => n + t.columnsP0.length, 0), 615);
    for (const table of old) {
      const actual = db.pragma(`table_xinfo('${table.name}')`) as { name: string; type: string; pk: number }[];
      assert.deepEqual(table.columnsP0.map(c => [c.name, c.sqliteDeclaredType]), actual.map(c => [c.name, c.type]));
      assert.deepEqual(table.primaryKey, actual.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name));
    }
    assert.equal(M2_HISTORY_TABLES.length, 72); assert.equal(M2_HISTORY_TABLES.reduce((n, t) => n + t.columnsP1.length, 0), 763);
    for (const expected of M2_COLUMN_CONTRACT.relations) assert.deepEqual(M2_HISTORY_TABLES.find(t => t.name === expected.table)!.columnsP1.map(c => c.name), expected.columns.map(c => c.name));
    for (const expected of M2_COLUMN_CONTRACT.executionFragments) {
      const table = M2_HISTORY_TABLES.find(t => t.name === expected.table)!;
      assert.deepEqual(table.columnsP1.slice(table.columnsP0.length).map(c => c.name), expected.columns.map(c => c.name));
    }
    assert.ok(M2_FORMAT_REGISTRATION.state === "registered-stage1");
    assert.equal(M2_FORMAT_REGISTRATION.productionTuple.state, "pending");
    assert.equal(Object.isFrozen(M2_HISTORY_TABLES[0]!.columnsP1[0]), true);
    // Real nonempty old rows, not the fixture builder's invented business graph.
    // This test adapter has no REAL input and makes no native-window/identity claim.
    const actual = fixture("sqlite", "p0");
    for (const table of actual.tables) {
      const rows = db.prepare(`SELECT rowid,${table.columns.map(c => `"${c}"`).join(",")} FROM "${table.name}" ORDER BY rowid`).safeIntegers(true).raw(true).all() as unknown[][];
      table.rows = rows.map(row => ({ rowid: String(row[0]), cells: row.slice(1).map((value): RawCell => {
        if (value === null) return ["null"];
        if (typeof value === "bigint") return ["integer", String(value)];
        if (typeof value === "string") return ["text", Buffer.from(value).toString("hex")];
        if (Buffer.isBuffer(value)) return ["blob", value.toString("hex")];
        assert.fail("Unexpected fixture storage class; do not convert REAL through Number");
      }) })); table.count = String(table.rows.length);
    }
    assert.ok(actual.tables.reduce((n, t) => n + t.rows.length, 0) >= 21);
    assert.deepEqual(ok(parseM2HistoryObservation(json(actual))).observation, actual);
  } finally { db.close(); }
});

test("PC01/07/25: strict envelope, full directory and unknown caller objects", () => {
  let reflected = 0;
  const proxy = new Proxy({}, { ownKeys() { reflected++; throw new Error("secret"); }, get() { reflected++; throw new Error("secret"); } });
  for (const call of [parseM2HistoryObservation, compareM2HistoryPreservation]) rejected(call(proxy), "invalid_value");
  assert.equal(reflected, 0);
  for (const mutate of [
    (v: HistoryObservationInput) => { v.tables.pop(); },
    (v: HistoryObservationInput) => { v.tables[1] = v.tables[0]!; },
    (v: HistoryObservationInput) => { v.tables.reverse(); },
  ]) { const v = fixture(); mutate(v); rejected(parseM2HistoryObservation(json(v)), "incomplete_universe"); }
  for (const mutate of [
    (t: RawTable) => { t.columns.pop(); },
    (t: RawTable) => { t.rows[0]!.cells.pop(); },
  ]) { const v = fixture(); mutate(v.tables.find(t => t.name === "agents")!); rejected(parseM2HistoryObservation(json(v)), "column_contract_mismatch"); }
  const v = fixture(), serialized = json(v);
  for (const invalid of [serialized + "\n", serialized.replace('"configFormat":1', '"configFormat":1.0'),
    serialized.replace('"configFormat":1', '"configFormat":1,"configFormat":1'), json({ ...v, proposedDeletion: [] })]) {
    rejected(parseM2HistoryObservation(invalid), "invalid_value");
  }
  rejected(parseM2HistoryObservation(json({ ...v, configFormat: 2 })), "format_unregistered");
  const wrongRowid = fixture("postgres"); wrongRowid.tables.find(t => t.name === "agents")!.rows[0]!.rowid = "101";
  rejected(parseM2HistoryObservation(json(wrongRowid)), "invalid_value");
  const alias = fixture(); alias.tables.find(t => t.name === "config_authority")!.rows[0]!.rowid = "2";
  rejected(parseM2HistoryObservation(json(alias)), "invalid_value");
});

test("PC03/05/06: raw carriers retain int64, invalid text, REAL bits and PG type identity", () => {
  const v = fixture(), table = v.tables.find(t => t.name === "agents")!, index = table.columns.indexOf("display_name");
  for (const value of [["integer", "9223372036854775807"], ["integer", "-9223372036854775808"], ["text", "ff0061"],
    ["text", ""], ["blob", ""], ["null"], ["real64be", "8000000000000000"], ["real64be", "7ff0000000000000"]] as RawCell[]) {
    table.rows[0]!.cells[index] = value;
    assert.deepEqual(ok(parseM2HistoryObservation(json(v))).observation.tables.find(t => t.name === "agents")!.rows[0]!.cells[index], value);
  }
  for (const value of [["integer", "9223372036854775808"], ["integer", "-0"], ["integer", "01"], ["text", "AA"], ["blob", "a"], ["real64be", "1"], ["null", ""]]) {
    table.rows[0]!.cells[index] = value as RawCell; rejected(parseM2HistoryObservation(json(v)), "invalid_value");
  }
  const pg = fixture("postgres"), agent = pg.tables.find(t => t.name === "agents")!;
  agent.rows[0]!.cells[index] = ["pg-binary", "23", "00000001"];
  rejected(parseM2HistoryObservation(json(pg)), "column_contract_mismatch");
  const migration = pg.tables.find(t => t.name === "schema_migrations")!;
  migration.rows[0]!.cells[migration.columns.indexOf("version")] = ["pg-binary", "23", "00"];
  agent.rows[0]!.cells[index] = ["null"];
  rejected(parseM2HistoryObservation(json(pg)), "invalid_value");
});

test("PC18: permitted target additions stay unverified, old fields and same-key audit variants cannot change", () => {
  const before = fixture("sqlite", "p0"), after = fixture();
  for (const name of ["agents", "audit_log", "schema_migrations"]) {
    const mutated = clone(after), table = mutated.tables.find(t => t.name === name)!;
    const at = table.columns.findIndex(c => c !== "id" && c !== "version");
    table.rows[0]!.cells[at] = ["text", "616c7465726564"];
    rejected(compareM2HistoryPreservation(json(comparison(before, mutated, "legacy-a-preservation"))), "row_mismatch");
  }
  const extra = clone(after), audit = extra.tables.find(t => t.name === "audit_log")!;
  audit.rows.push(clone(audit.rows[0]!)); audit.count = "2";
  rejected(compareM2HistoryPreservation(json(comparison(before, extra, "legacy-a-preservation"))), "row_mismatch");
  const target = clone(after);
  add(target, "agent_runtime_bindings", {});
  rejected(compareM2HistoryPreservation(json(comparison(before, target, "legacy-a-preservation"))), "row_mismatch");
  after.tables.find(t => t.name === "config_authority")!.rows[0]!.cells[1] = ["text", "756e7665726966696564"];
  const result = ok(compareM2HistoryPreservation(json(comparison(before, after, "legacy-a-preservation"))));
  assert.ok(result.unverifiedTargetDomains.includes("new-m2-rows")); assert.equal(result.remaining.length, 11);
});

test("PC18: all old execution cells survive while the fixed eight appended cells stay unverified", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const before = fixture(backend, "p0"), after = fixture(backend);
    for (const name of ["agent_runtime_bindings", "agent_runner_states"]) {
      const identity = name === "agent_runtime_bindings" ? "id" : "binding_id";
      add(before, name, { [identity]: text(backend, "execution-a") });
      add(after, name, { [identity]: text(backend, "execution-a"),
        ...(name === "agent_runtime_bindings" ? { group_binding_id: text(backend, "binding-new") } : { applied_config_snapshot_id: text(backend, "snapshot-new") }) });
    }
    ok(compareM2HistoryPreservation(json(comparison(before, after, "legacy-a-preservation"))));
    const rows = after.tables.find(t => t.name === "agent_runtime_bindings")!;
    rows.rows[0]!.cells[0] = text(backend, "changed-old-identity");
    rejected(compareM2HistoryPreservation(json(comparison(before, after, "legacy-a-preservation"))), "row_mismatch");
  }
});

test("PC29/30: no semantic or deletion qualification, fixed failures do not echo secret values", () => {
  const a = fixture(), b = clone(a);
  add(a, "decision_executions", { work_event_ids_json: text("sqlite", '["missing-event"]') });
  add(b, "decision_executions", { work_event_ids_json: text("sqlite", '["missing-event"]') });
  const result = ok(compareM2HistoryPreservation(json(comparison(a, b))));
  assert.deepEqual(result.remaining.slice(0, 5).map(x => x.status), Array(5).fill("unproven"));
  assert.equal(Object.hasOwn(result, "retainedReferenceConflicts"), false);
  rejected(compareM2HistoryPreservation(json({ ...comparison(a, b), proposedDeletion: [{ secret: "DO-NOT-ECHO" }] })), "invalid_value");
  rejected(compareM2HistoryPreservation(json(comparison(a, b, "sqlite-relocation-history"))), "unsupported_shape");
  const error = parseM2HistoryObservation(json({ ...a, secret: "DO-NOT-ECHO" }));
  assert.equal(JSON.stringify(error).includes("DO-NOT-ECHO"), false);
});

test("PC25: shared bytes/nodes/depth budget rejects before allocating parsed trees", () => {
  const original = JSON.parse; let parses = 0;
  JSON.parse = (() => { parses++; throw new Error("must not allocate"); }) as typeof JSON.parse;
  try {
    for (const input of ['"' + "a".repeat(16_777_216) + '"', "[".repeat(66) + "0" + "]".repeat(66),
      "[" + Array(250_001).fill("null").join(",") + "]"]) rejected(parseM2HistoryObservation(input), "budget_exceeded");
    assert.equal(parses, 0);
  } finally { JSON.parse = original; }
  const a = fixture(), b = clone(a), cellIndex = a.tables.find(t => t.name === "agents")!.columns.indexOf("display_name");
  a.tables.find(t => t.name === "agents")!.rows[0]!.cells[cellIndex] = ["text", "61".repeat(4_200_000)];
  b.tables.find(t => t.name === "agents")!.rows[0]!.cells[cellIndex] = ["text", "61".repeat(4_200_000)];
  ok(parseM2HistoryObservation(json(a)));
  rejected(compareM2HistoryPreservation(json(comparison(a, b))), "budget_exceeded");
  const wide = fixture(), rows = wide.tables.find(t => t.name === "agents")!;
  rows.rows = Array.from({ length: 8_000 }, () => clone(rows.rows[0]!)); rows.count = "8000";
  ok(parseM2HistoryObservation(json(wide)));
  rejected(compareM2HistoryPreservation(json(comparison(wide, wide))), "budget_exceeded");
});

test("PC08/24: exact comparison includes source, column identities, controls and sequence observations", () => {
  const before = fixture("postgres");
  for (const [change, code] of [
    [(v: HistoryObservationInput) => { v.source = { ...v.source, identityDigest: digest("other-source") }; }, "row_mismatch"],
    [(v: HistoryObservationInput) => { v.catalog = ref("other-catalog"); }, "column_contract_mismatch"],
    [(v: HistoryObservationInput) => { v.tables[0]!.columnContractValueDigest = digest("other-columns"); }, "column_contract_mismatch"],
    [(v: HistoryObservationInput) => { v.sequences[0]!.lastValue = "23"; }, "row_mismatch"],
    [(v: HistoryObservationInput) => { add(v, "storage_source_clients", {}); }, "row_mismatch"],
  ] as const) {
    const after = clone(before); change(after);
    rejected(compareM2HistoryPreservation(json(comparison(before, after))), code);
  }
});

test("PC05/25: canonical scalar spelling, Unicode and exact row-digest vector", () => {
  const v = fixture();
  for (const value of ["中é🧪", "\ud800", "\udc00"]) {
    v.physicalSourceRef = { ...v.physicalSourceRef, artifactId: value };
    if (value.length === 1) rejected(parseM2HistoryObservation(json(v)), "invalid_value");
    else ok(parseM2HistoryObservation(json(v)));
  }
  const input = fixture(), parsed = ok(parseM2HistoryObservation(json(input)));
  const rawFrame = '["1",[["integer","1"],["null"],["null"],["null"],["null"]]]';
  const expected = digest(JSON.stringify(["m2-pc-table-rows/r1", "sqlite", "config_authority", digest("config_authority/5"), "1", [rawFrame]]));
  assert.equal(parsed.tableDigests.find(t => t.name === "config_authority")!.rowMultisetDigest, expected);
  assert.throws(() => { (parsed.remaining as unknown as { status: string }[])[0]!.status = "proven"; }, TypeError);
  const exports = Object.keys(importedValues).sort();
  assert.deepEqual(exports, ["compareM2HistoryPreservation", "parseM2HistoryObservation"]);
});

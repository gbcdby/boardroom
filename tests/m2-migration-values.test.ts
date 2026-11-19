import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import { buildM2Migration22Values } from "../src/server/identity/m2-migration-values.ts";
import * as publicApi from "../src/server/identity/m2-migration-values.ts";
import { M2_FORMAT_REGISTRATION } from "../src/server/identity/m2-value-contracts.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ref = (name: string) => ({ ref: `fixture/${name}`, sha256: hash(name), bytes: "1" });
// Two complete, nonempty pure-value seeds, built independently for their source dialect.
// These selected references do not claim native captures or a verified artifact closure.
function input(backend: "sqlite" | "postgres" = "sqlite", createdAt = "2026-11-19T12:00:00.000Z") {
  const source = { kind: backend, databaseInstanceId: backend === "sqlite" ? "1".repeat(32) : "2".repeat(32), identityDigest: hash(`${backend}/source`) };
  const counts: Record<string, string> = { schema_migrations: "21", agents: "1", members: "2", groups: "1", projects: "1",
    group_participants: "2", agent_runtimes: "1", agent_runtime_bindings: "1", agent_runner_states: "1",
    agent_runtime_members: "1", agent_legacy_aliases: "1", storage_maintenance: "1" };
  const tables = M2_HISTORY_TABLES.filter(t => t.columnsP0.length).map(t => ({
    table: t.name, columnContract: ref(`${backend}/${t.name}/columns`), columnContractValueDigest: hash(`${backend}/${t.name}/columns`),
    typedRows: ref(`${backend}/${t.name}/rows`), count: counts[t.name] ?? "0",
    rowMultisetDigest: hash(`${backend}/${t.name}/rows`),
  }));
  return { backend, seed: {
    contract: "m2-takeover-seed/r1", source, migrationId: "migration-value-test", s4Plan: ref(`${backend}/plan`),
    requestId: "request-1", planId: "plan-1", activationId: "activation-1", captureId: "capture-1",
    before: { contract: "m2-pc-typed-selection/r1", source: { ...source }, backend, phase: "p0",
      observation: ref(`${backend}/observation`), completeHistoryDigest: hash(`${backend}/history`), tables },
    createdAt, actor: { kind: "human", name: "M22 值测试", memberId: null },
    agents: [{ agentId: "agent-1", profileRevision: 1, auditId: "audit-1" }],
    bindings: [{ memberId: "member-1", groupId: "group-1", groupBindingId: "binding-1", bindingRevision: 1,
      legacyExecutionId: "binding-1", effective: { snapshotId: "snapshot-effective", mappingId: "mapping-effective" as string | null },
      requested: null, applied: null },
    { memberId: "member-2", groupId: "group-1", groupBindingId: "external-1", bindingRevision: 1,
      legacyExecutionId: null, effective: null, requested: null, applied: null }],
  } };
}
function value(raw: unknown) {
  const result = buildM2Migration22Values(raw);
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
const definitionRef = { ref: "m2-contract/sha256/688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220/CONTROLLED-MIGRATION-DEFINITION.json",
  sha256: "688245bdc8dc8cfb32e8c9c2ea9139629f4b5d5844efd44d05a968e49dd6d220", bytes: "152437" };

test("M22-AC03/04/05: exact accepted definition produces both complete source-dialect value entries", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const selected = input(backend), result = value(JSON.stringify(selected));
    assert.deepEqual(result.entry, { contract: "m2-migration22-entry/r1", backend, version: 22,
      name: "profile_configuration_authority", checksum: backend === "sqlite" ? "41d93b6d6ad261c5" : "aece9775f7cdfdda",
      appliedAt: selected.seed.createdAt, rowid: backend === "sqlite" ? "22" : null, registeredMigration: definitionRef });
    assert.equal(result.scope, "fixed-controlled-m22-entry-and-typed-row");
    assert.equal(result.checksumDomain, "m2-fixed-phase-source/v1");
    assert.deepEqual(result.row.columns, ["version", "name", "checksum", "applied_at"]);
    assert.equal(result.row.table, "schema_migrations");
    assert.equal(result.row.rowid, result.entry.rowid);
    assert.deepEqual(result.row.cells[0], backend === "sqlite" ? ["integer", "22"] : ["pg-binary", "23", "00000016"]);
    assert.deepEqual(result.row.cells[3], backend === "sqlite"
      ? ["text", "323032362d31312d31395431323a30303a30302e3030305a"] : ["pg-binary", "1184", "0003039ea2bad000"]);
    assert.deepEqual(result.row.cells[1], backend === "sqlite"
      ? ["text", "70726f66696c655f636f6e66696775726174696f6e5f617574686f72697479"]
      : ["pg-binary", "25", "70726f66696c655f636f6e66696775726174696f6e5f617574686f72697479"]);
    assert.deepEqual(result.row.cells[2], backend === "sqlite"
      ? ["text", "34316439336236643661643236316335"] : ["pg-binary", "25", "61656365393737356637636466646461"]);
    assert.deepEqual(result, value(JSON.stringify(selected)), "same seed has no fresh now, ID or external state");
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.entry) && Object.isFrozen(result.entry.registeredMigration));
  }
});

function rejected(raw: unknown, code: string): void {
  const result = buildM2Migration22Values(raw);
  assert.deepEqual(result, { ok: false, error: { code } });
  assert.ok(Object.isFrozen(result));
}
test("M22-AC04: timestamp spelling, integer microseconds, offsets and pre-epoch values are lossless", () => {
  const vectors = [
    ["2000-01-01T00:00:00Z", "0000000000000000"],
    ["1999-12-31T23:59:59.999999Z", "ffffffffffffffff"],
    ["2000-01-01T00:00:00.000001Z", "0000000000000001"],
    ["2000-01-01T02:30:00.123456+02:30", "000000000001e240"],
    ["1999-12-31T21:30:00.654321-02:30", "000000000009fbf1"],
    ["2000-01-01T00:00:00.123456000Z", "000000000001e240"],
    // Independently calculated integer datetime vectors, including Gregorian centuries.
    ["2000-02-29T00:00:00Z", "000004a2e0a32000"],
    ["2000-03-01T00:00:00Z", "000004b6fe7a8000"],
    ["1900-03-01T00:00:00Z", "fff4ce915caea000"],
    ["2100-03-01T00:00:00Z", "000b3ac8826f0000"],
    ["0001-01-01T00:00:00Z", "ff1fe2ffc59c6000"],
    ["9999-12-31T23:59:59.999999Z", "0380e70b913b7fff"],
  ];
  for (const [timestamp, hex] of vectors) {
    const result = value(JSON.stringify(input("postgres", timestamp)));
    assert.equal(result.entry.appliedAt, timestamp);
    assert.deepEqual(result.row.cells[3], ["pg-binary", "1184", hex]);
  }
  const nanoseconds = "2026-11-19T12:00:00.123456789+01:30";
  const sqlite = value(JSON.stringify(input("sqlite", nanoseconds)));
  assert.equal(sqlite.entry.appliedAt, nanoseconds);
  assert.deepEqual(sqlite.row.cells[3], ["text", Buffer.from(nanoseconds, "utf8").toString("hex")]);
  rejected(JSON.stringify(input("postgres", nanoseconds)), "semantic_unsupported");
  rejected(JSON.stringify(input("postgres", "2000-01-01T00:00:00.0000001Z")), "semantic_unsupported");
  rejected(JSON.stringify(input("postgres", "0000-01-01T00:00:00Z")), "semantic_unsupported");
  for (const timestamp of ["2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2000-01-01T00:00:00",
    "2000-01-01T00:00:00+24:00", "2000-01-01T00:00:00+01:60", "not-a-date"]) {
    rejected(JSON.stringify(input("sqlite", timestamp)), "invalid_value");
  }
});

test("M22-AC05: source/backend contradictions are checked at this entry", () => {
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.backend = "postgres"; },
    (v: ReturnType<typeof input>) => { v.seed.source.kind = "postgres"; },
    (v: ReturnType<typeof input>) => { v.seed.before.backend = "postgres"; },
    (v: ReturnType<typeof input>) => { v.seed.before.source.kind = "postgres"; },
    (v: ReturnType<typeof input>) => { v.seed.before.source.databaseInstanceId = "3".repeat(32); },
    (v: ReturnType<typeof input>) => { v.seed.before.source.identityDigest = "3".repeat(64); },
  ]) {
    const selected = input(); mutate(selected); rejected(JSON.stringify(selected), "source_contract_mismatch");
  }
});

test("M22-AC05: full exact seed shape and selected P0 table directory are required", () => {
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.seed.before.tables.pop(); },
    (v: ReturnType<typeof input>) => { v.seed.before.phase = "p1"; },
    (v: ReturnType<typeof input>) => { Object.assign(v.seed.actor, { permit: true }); },
    (v: ReturnType<typeof input>) => { delete (v.seed as Partial<typeof v.seed>).actor; },
    (v: ReturnType<typeof input>) => { Object.assign(v.seed.bindings[0]!, { future: "unknown" }); },
    (v: ReturnType<typeof input>) => { Object.assign(v.seed.before.tables[0]!, { columns: [] }); },
  ]) {
    const selected = input(); mutate(selected); rejected(JSON.stringify(selected), "unsupported_shape");
  }
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.seed.before.tables.reverse(); },
    (v: ReturnType<typeof input>) => { v.seed.before.tables[1] = structuredClone(v.seed.before.tables[0]!); },
    (v: ReturnType<typeof input>) => { v.seed.before.tables.find(t => t.table === "schema_migrations")!.count = "22"; },
    (v: ReturnType<typeof input>) => { v.seed.before.tables.find(t => t.table === "agents")!.count = "2"; },
  ]) {
    const selected = input(); mutate(selected); rejected(JSON.stringify(selected), "source_contract_mismatch");
  }
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.seed.migrationId = "not/a/migration-id"; },
    (v: ReturnType<typeof input>) => { v.seed.before.tables[0]!.columnContract.bytes = "01"; },
    (v: ReturnType<typeof input>) => { v.seed.s4Plan.ref = "bad\u0000ref"; },
    (v: ReturnType<typeof input>) => { v.seed.source.identityDigest = "A".repeat(64); },
    (v: ReturnType<typeof input>) => { v.seed.agents[0]!.profileRevision = 2; },
  ]) {
    const selected = input(); mutate(selected); rejected(JSON.stringify(selected), "invalid_value");
  }
});

test("M22-AC05: locally decidable seed ordering, uniqueness and slot rules cannot be skipped", () => {
  for (const mutate of [
    (v: ReturnType<typeof input>) => { v.seed.bindings.reverse(); },
    (v: ReturnType<typeof input>) => { v.seed.bindings[1]!.groupBindingId = "binding-1"; },
    (v: ReturnType<typeof input>) => { v.seed.bindings[0]!.legacyExecutionId = "different-binding"; },
    (v: ReturnType<typeof input>) => { v.seed.bindings[0]!.effective = null; },
    (v: ReturnType<typeof input>) => { v.seed.bindings[1]!.effective = { snapshotId: "external-slot", mappingId: null }; },
    (v: ReturnType<typeof input>) => { v.seed.bindings[0]!.effective!.mappingId = "snapshot-effective"; },
    (v: ReturnType<typeof input>) => { v.seed.agents[0]!.auditId = "activation-1"; },
  ]) {
    const selected = input(); mutate(selected); rejected(JSON.stringify(selected), "semantic_invariant_failed");
  }
  const selected = input();
  selected.seed.agents.push({ agentId: "agent-1", profileRevision: 1, auditId: "audit-2" });
  selected.seed.before.tables.find(t => t.table === "agents")!.count = "2";
  rejected(JSON.stringify(selected), "semantic_invariant_failed");
});

test("M22-AC02/05/10: caller cannot replace fixed definition, seed time source or expose execution", () => {
  for (const extra of ["definitionRef", "registeredMigration", "checksum", "checksumDomain", "registry", "driver", "up", "upPostgres", "sql", "permit", "appliedAt", "rowid"]) {
    rejected(JSON.stringify({ ...input(), [extra]: "caller-override" }), "unsupported_shape");
    const selected = input(); Object.assign(selected.seed, { [extra]: "caller-override" });
    rejected(JSON.stringify(selected), "unsupported_shape");
  }
  assert.deepEqual(Object.keys(publicApi), ["buildM2Migration22Values"]);
  assert.deepEqual(migrations.map(m => m.version), Array.from({ length: 21 }, (_, i) => i + 1));
  assert.ok(M2_FORMAT_REGISTRATION.state === "registered-stage1");
  assert.equal(M2_FORMAT_REGISTRATION.productionTuple.state, "pending");
  const result = value(JSON.stringify(input()));
  assert.deepEqual(Object.keys(result.entry).sort(), ["appliedAt", "backend", "checksum", "contract", "name", "registeredMigration", "rowid", "version"]);
  assert.deepEqual(result.unverified, ["seed-artifact-closure-and-old-row-coverage", "source-existence-and-native-window",
    "production-registration", "controlled-a-transaction-and-sequence-preservation", "g1-receipt-authority-and-full-p1"]);
  assert.ok(Object.isFrozen(result.row.cells) && Object.isFrozen(result.row.cells[0]));
  assert.throws(() => { (result.row.cells as unknown[]).push(["null"]); }, TypeError);
});

test("M22-AC05: objects, getters and revoked proxies are refused without reflection", () => {
  let observed = 0;
  const getter = Object.defineProperty({}, "backend", { get() { observed++; return "sqlite"; } });
  const proxy = new Proxy({}, { get() { observed++; throw new Error("get"); }, ownKeys() { observed++; return []; },
    getPrototypeOf() { observed++; return null; }, getOwnPropertyDescriptor() { observed++; return undefined; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const raw of [getter, proxy, revoked.proxy, input(), new String(JSON.stringify(input())), null, undefined, 1, true, Symbol("seed"), () => input()]) {
    rejected(raw, "unsupported_shape");
  }
  assert.equal(observed, 0);
  const parse = JSON.parse;
  try {
    JSON.parse = () => { throw proxy; };
    rejected("{}", "invalid_value");
    assert.equal(observed, 0, "unknown thrown values are not inspected either");
  } finally { JSON.parse = parse; }
});

test("M22-AC05: strict lexical admission and resource limits run before seed allocation", () => {
  const wire = JSON.stringify(input());
  for (const raw of [wire.replace('"backend":"sqlite"', '"backend":"sqlite","\\u0062ackend":"sqlite"'),
    wire.replace('"profileRevision":1', '"profileRevision":1.00000000000000001'),
    wire.replace('"profileRevision":1', '"profileRevision":9007199254740993'),
    wire.replace('"profileRevision":1', '"profileRevision":-0'),
    wire.replace('"name":"M22 值测试"', '"name":"\\ud800"'), wire + " trailing", "{", "null"]) {
    const result = buildM2Migration22Values(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(["invalid_value", "unsupported_shape"].includes(result.error.code));
  }
  rejected(" ".repeat(16 * 1024 * 1024 + 1), "resource_limit");
  rejected("[".repeat(66) + "0" + "]".repeat(66), "resource_limit");
  rejected("[" + "0,".repeat(250001) + "0]", "resource_limit");
  const selected = input(); selected.seed.actor.name = "x".repeat(1048577);
  rejected(JSON.stringify(selected), "invalid_value");
});

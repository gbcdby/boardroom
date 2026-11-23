import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { M2_HISTORY_TABLES } from "../src/server/identity/m2-history-contracts.ts";
import { buildM2Migration22Values, buildM2Migration22ProfileValues } from "../src/server/identity/m2-migration-values.ts";
import * as publicApi from "../src/server/identity/m2-migration-values.ts";
import { M2_FORMAT_REGISTRATION } from "../src/server/identity/m2-value-contracts.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { AuditRequest, AUDIT_LIMITS } from "../src/server/identity/internal/m2-audit-boundary.ts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  assert.deepEqual(Object.keys(publicApi), ["buildM2Migration22ProfileValues", "buildM2Migration22Values"]);
  assert.deepEqual(migrations.filter(m => m.version <= 21).map(m => m.version), Array.from({ length: 21 }, (_, i) => i + 1));
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

const writerDigest = "c94dfbd3199953af3740188aff54566578708e0ee6267440aa27c71db51fac03";
const writerDescriptor = { ref: `m2-contract/sha256/${writerDigest}/WRITER-FORMAT-DESCRIPTOR.json`, sha256: writerDigest, bytes: "2399" };
const clientDigest = "c7ff5f09fe063c4d8124c0d2a37f726c4c7e687ac3a59b25788632d1d8fe1d06";
const clientContract = { ref: `m2-contract/sha256/${clientDigest}/SOURCE-CLIENT-FORMAT-CONTRACT.json`, sha256: clientDigest, bytes: "3909" };
function profileInput(backend: "sqlite" | "postgres" = "sqlite", createdAt?: string) {
  return { ...input(backend, createdAt), profileFormatPair: { protocolVersion: 2, writerFormatDigest: writerDigest } };
}
function profileValue(raw: unknown) {
  const result = buildM2Migration22ProfileValues(raw);
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.value;
}
function deepFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) deepFrozen(child);
  }
}
test("GV-01/02/11/12: both complete source seeds produce the fixed seven-field pair/M22 value", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const selected = profileInput(backend), result = profileValue(JSON.stringify(selected));
    assert.deepEqual(result, { scope: "fixed-m22-entry-and-profile-format-pair",
      migration: value(JSON.stringify({ backend, seed: selected.seed })),
      profileFormatPair: { protocolVersion: 2, writerFormatDigest: writerDigest }, writerFormat: "s2-profile-config/v1",
      writerFormatDescriptor: writerDescriptor, sourceClientFormatContract: clientContract,
      unverified: ["activation-receipt-binding-and-complete-profile-current-format", "cf03-05-and-current-native-writer"] });
    assert.deepEqual(Object.keys(result).sort(), ["migration", "profileFormatPair", "scope", "sourceClientFormatContract", "unverified", "writerFormat", "writerFormatDescriptor"]);
    deepFrozen(result);
    assert.notEqual(result.profileFormatPair, selected.profileFormatPair);
    assert.ok(!Object.hasOwn(result, "kind") && !Object.hasOwn(result, "activationReceipt"));
    assert.deepEqual(result, profileValue(JSON.stringify(selected)));
  }
});

function profileRejected(raw: unknown, code: string): void {
  const result = buildM2Migration22ProfileValues(raw);
  assert.deepEqual(result, { ok: false, error: { code } }); deepFrozen(result);
}
test("GV-03/04/05/06: exact pair, roots, source checks and ordered finite errors", () => {
  for (const [patch, code] of [
    [{ protocolVersion: 3 }, "source_contract_mismatch"],
    [{ protocolVersion: "2" }, "invalid_value"],
    [{ writerFormatDigest: "b".repeat(64) }, "source_contract_mismatch"],
    [{ writerFormatDigest: writerDigest.toUpperCase() }, "invalid_value"],
    [{ writerFormatDigest: writerDigest.slice(0, 16) }, "invalid_value"],
    [{ activationReceipt: definitionRef }, "unsupported_shape"],
  ] as const) {
    const selected = profileInput(); Object.assign(selected.profileFormatPair, patch);
    profileRejected(JSON.stringify(selected), code);
  }
  for (const field of ["registry", "sql", "permit", "verified", "activationReceipt", "writerFormatDescriptor", "sourceClientFormatContract"]) {
    profileRejected(JSON.stringify({ ...profileInput(), [field]: true }), "unsupported_shape");
  }
  for (const pair of [null, [], {}, "s2-profile-config/v1"]) {
    profileRejected(JSON.stringify({ ...input(), profileFormatPair: pair }), "unsupported_shape");
  }
  rejected(JSON.stringify(profileInput()), "unsupported_shape");
  profileRejected(JSON.stringify(input()), "unsupported_shape");
  profileRejected(JSON.stringify({ ...profileInput(), backend: "unsupported" }), "unsupported_shape");
  profileRejected(JSON.stringify({ ...profileInput(), backend: "postgres" }), "source_contract_mismatch");
  const missing = profileInput(); missing.seed.before.tables.pop();
  profileRejected(JSON.stringify(missing), "unsupported_shape");
  const empty = profileInput(); empty.seed.before.tables = [];
  profileRejected(JSON.stringify(empty), "unsupported_shape");
  profileRejected(JSON.stringify(profileInput("postgres", "2026-11-19T12:00:00.123456789Z")), "semantic_unsupported");
  profileRejected(JSON.stringify(profileInput("sqlite", "not-a-time")), "invalid_value");
  const mismatchFirst = { ...profileInput(), seed: {}, profileFormatPair: { protocolVersion: 3, writerFormatDigest: "bad" } };
  profileRejected(JSON.stringify(mismatchFirst), "source_contract_mismatch");
  const sqliteTime = "2026-11-19T13:00:00.123456789+01:00";
  assert.equal(profileValue(JSON.stringify(profileInput("sqlite", sqliteTime))).migration.entry.appliedAt, sqliteTime);
});

test("GV-07: new boundary never observes hostile callers or unknown thrown objects", () => {
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw Error("getter"); }, ownKeys() { traps++; return []; },
    getPrototypeOf() { traps++; return null; }, getOwnPropertyDescriptor() { traps++; return undefined; } });
  const getter = Object.defineProperty({}, "profileFormatPair", { get() { traps++; return {}; } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const raw of [hostile, getter, revoked.proxy, new String("{}"), Buffer.from("{}"), new Uint8Array(1), [], () => ({}), null, undefined]) {
    profileRejected(raw, "unsupported_shape");
  }
  assert.equal(traps, 0);
  const wire = JSON.stringify(profileInput());
  for (const raw of [wire.replace('"protocolVersion":2', '"protocolVersion":2,"\\u0070rotocolVersion":2'),
    wire.replace('"protocolVersion":2', '"protocolVersion":2.00000000000000001'),
    wire.replace('"name":"M22 值测试"', '"name":"\\ud800"')]) profileRejected(raw, "invalid_value");
  const original = JSON.parse;
  try {
    JSON.parse = () => { throw hostile; };
    profileRejected("{}", "invalid_value"); assert.equal(traps, 0);
  } finally { JSON.parse = original; }
});

test("GV-08/10: one request, one whole parse, one seed pass, one complete result measurement", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const wire = JSON.stringify(profileInput(backend));
    const originalText = AuditRequest.prototype.text, originalRows = AuditRequest.prototype.rowCount;
    const originalMeasure = AuditRequest.prototype.measure, originalParse = JSON.parse, originalStringify = JSON.stringify;
    const instances = new Set<AuditRequest>(), rows: number[] = [], fees: number[] = [];
    let wholeParses = 0, stringifyCalls = 0, measurements = 0, measured: unknown, measuredBytes = 0;
    AuditRequest.prototype.text = function(bytes, passes = 1) {
      instances.add(this); if ([128, 380, 2048].includes(bytes) && passes === 1) fees.push(bytes);
      return originalText.call(this, bytes, passes);
    };
    AuditRequest.prototype.rowCount = function(n) { rows.push(n); return originalRows.call(this, n); };
    AuditRequest.prototype.measure = function(value, maximum) {
      measurements++; measured = value; assert.equal(maximum, AUDIT_LIMITS.output);
      const cost = originalMeasure.call(this, value, maximum); measuredBytes = cost.bytes; return cost;
    };
    JSON.parse = function(text, ...args) { if (text === wire) wholeParses++; return Reflect.apply(originalParse, this, [text, ...args]); };
    JSON.stringify = function(this: typeof JSON, ...args: Parameters<typeof JSON.stringify>) { stringifyCalls++; return Reflect.apply(originalStringify, this, args); } as typeof JSON.stringify;
    let result: ReturnType<typeof buildM2Migration22ProfileValues>;
    try { result = buildM2Migration22ProfileValues(wire); }
    finally {
      AuditRequest.prototype.text = originalText; AuditRequest.prototype.rowCount = originalRows;
      AuditRequest.prototype.measure = originalMeasure; JSON.parse = originalParse; JSON.stringify = originalStringify;
    }
    assert.ok(result.ok); assert.equal(instances.size, 1); assert.equal(wholeParses, 1); assert.equal(stringifyCalls, 0);
    assert.deepEqual(rows, [1, 2]); assert.deepEqual(fees, [128, 380, 2048]);
    assert.equal(measurements, 1); assert.equal(measured, result, "return the enclosing boundary's exact success envelope");
    assert.equal(measuredBytes, Buffer.byteLength(JSON.stringify(result)));
    assert.ok(measuredBytes > Buffer.byteLength(JSON.stringify(result.value.migration)));
    deepFrozen(result);
  }
});

// Observe private counters only. Exhaustion uses the original request's actual
// charging methods; no counter assignment, changed limits or production hooks.
type Usage = { readonly characters: number; readonly nodes: number; readonly work: number };
test("GV-09: pair and M22 producer precharges reject 0/short balances without granting a new budget", () => {
  for (const target of [128, 2048]) for (const keep of [0, target - 1, target]) {
    const wire = JSON.stringify(profileInput()), originalText = AuditRequest.prototype.text, originalFrom = Buffer.from;
    let reached = false, paid = false, afterBuffers = 0;
    AuditRequest.prototype.text = function(bytes, passes = 1) {
      const targetCall = !reached && bytes === target && passes === 1;
      if (targetCall) {
        reached = true;
        originalText.call(this, AUDIT_LIMITS.characters - (this as unknown as Usage).characters - keep);
      }
      const result = originalText.call(this, bytes, passes);
      if (targetCall) paid = true;
      return result;
    };
    Buffer.from = function(...args: Parameters<typeof Buffer.from>) {
      if (reached) afterBuffers++;
      return Reflect.apply(originalFrom, Buffer, args);
    } as typeof Buffer.from;
    try { profileRejected(wire, "resource_limit"); }
    finally { AuditRequest.prototype.text = originalText; Buffer.from = originalFrom; }
    assert.ok(reached); assert.equal(paid, keep === target);
    assert.equal(afterBuffers, target === 2048 && keep === 2048 ? 3 : 0);
  }
});

test("GV-10: new record prepays one node and seven work units before whole-result measurement", () => {
  for (const keep of [0, 1]) {
    const wire = JSON.stringify(profileInput());
    const text = AuditRequest.prototype.text, allocate = AuditRequest.prototype.allocateNodes, units = AuditRequest.prototype.units;
    const measure = AuditRequest.prototype.measure;
    let outputPaid = false, reached = false, recordPaid = false, assignmentsPaid = false, measured = false, instance: AuditRequest | undefined;
    AuditRequest.prototype.text = function(bytes, passes = 1) {
      const result = text.call(this, bytes, passes);
      if (bytes === 2048 && passes === 1) outputPaid = true;
      return result;
    };
    AuditRequest.prototype.allocateNodes = function(n, depth = 0) {
      const targetCall = outputPaid && !reached;
      if (targetCall) {
        assert.equal(n, 1); assert.equal(depth, 0); reached = true; instance = this;
        allocate.call(this, AUDIT_LIMITS.nodes - (this as unknown as Usage).nodes - keep);
      }
      const result = allocate.call(this, n, depth); if (targetCall) recordPaid = true; return result;
    };
    AuditRequest.prototype.units = function(n) {
      if (recordPaid && n === 7 && !measured) assignmentsPaid = true;
      return units.call(this, n);
    };
    AuditRequest.prototype.measure = function(value, maximum) {
      assert.ok(recordPaid && assignmentsPaid); measured = true; return measure.call(this, value, maximum);
    };
    let result: ReturnType<typeof buildM2Migration22ProfileValues>;
    try { result = buildM2Migration22ProfileValues(wire); }
    finally {
      AuditRequest.prototype.text = text; AuditRequest.prototype.allocateNodes = allocate;
      AuditRequest.prototype.units = units; AuditRequest.prototype.measure = measure;
    }
    assert.ok(reached); assert.equal(recordPaid, keep === 1); assert.equal(measured, keep === 1);
    if (keep === 0) assert.deepEqual(result, { ok: false, error: { code: "resource_limit" } });
    else { assert.ok(result.ok); assert.equal((instance as unknown as Usage).nodes, AUDIT_LIMITS.nodes); }
  }
});

test("GV-09 legacy: public large input still rejects before any M22 output conversion", () => {
  const selected = input();
  for (const [field, char] of [["requestId", "q"], ["planId", "p"], ["activationId", "a"], ["captureId", "c"]] as const) selected.seed[field] = char.repeat(1048576);
  selected.seed.actor.name = "n".repeat(1048576);
  const originalText = AuditRequest.prototype.text, originalFrom = Buffer.from;
  let before = 0, outputBefore = -1, conversions = 0;
  AuditRequest.prototype.text = function(bytes, passes = 1) {
    if (bytes === 2048 && passes === 1) { before = (this as unknown as Usage).characters; outputBefore = conversions; }
    return originalText.call(this, bytes, passes);
  };
  Buffer.from = function(value: unknown, ...args: unknown[]) {
    if (["profile_configuration_authority", "41d93b6d6ad261c5", selected.seed.createdAt].includes(value as string)) conversions++;
    return Reflect.apply(originalFrom, Buffer, [value, ...args]);
  } as typeof Buffer.from;
  try {
    selected.seed.agents[0]!.auditId = "u";
    assert.ok(buildM2Migration22Values(JSON.stringify(selected)).ok);
    assert.equal(outputBefore, 0); assert.equal(conversions, 3);
    const length = 1 + Math.floor((AUDIT_LIMITS.characters - 1024 - before) / 16);
    assert.ok(length > 1 && length <= 1048576);
    selected.seed.agents[0]!.auditId = "u".repeat(length); conversions = 0;
    rejected(JSON.stringify(selected), "resource_limit");
    assert.ok(AUDIT_LIMITS.characters - before < 2048);
    assert.equal(outputBefore, 0); assert.equal(conversions, 0);
  } finally { AuditRequest.prototype.text = originalText; Buffer.from = originalFrom; }
});

test("GV-03 compiled drift: isolated definition ref/sha/bytes changes reject only the new consumer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-m22-profile-drift-"));
  const productUrl = new URL("../src/server/identity/m2-migration-values.ts", import.meta.url);
  const contractUrl = new URL("../src/server/identity/internal/m2-profile-writer-contract.ts", import.meta.url);
  const product = await readFile(productUrl, "utf8"), contract = await readFile(contractUrl, "utf8");
  const marker = "expectedM22Definition: Object.freeze({";
  const offset = contract.indexOf(marker); assert.ok(offset > 0);
  const prefix = contract.slice(0, offset), selected = contract.slice(offset);
  const oldInput = input(), oldWire = JSON.stringify(oldInput), newWire = JSON.stringify({ ...oldInput, profileFormatPair: { protocolVersion: 2, writerFormatDigest: writerDigest } });
  try {
    for (const [field, before, after] of [
      ["ref", definitionRef.ref, definitionRef.ref + "/different"],
      ["sha", definitionRef.sha256, "b".repeat(64)],
      ["bytes", 'bytes: "152437"', 'bytes: "152438"'],
    ] as const) {
      // For sha only replace the standalone field, not the same text inside the ref.
      const source = field === "sha" ? `sha256: "${before}"` : before;
      const replacement = field === "sha" ? `sha256: "${after}"` : after;
      assert.ok(selected.includes(source));
      const contractPath = path.join(directory, `${field}-contract.ts`), productPath = path.join(directory, `${field}-values.ts`);
      await writeFile(contractPath, prefix + selected.replace(source, replacement));
      const derived = product.replace(/from "([^"]+)"/g, (_match, specifier: string) => {
        const resolved = specifier === "./internal/m2-profile-writer-contract.ts" ? pathToFileURL(contractPath).href
          : specifier.startsWith(".") ? new URL(specifier, productUrl).href : import.meta.resolve(specifier);
        return `from ${JSON.stringify(resolved)}`;
      });
      await writeFile(productPath, derived);
      const control = await import(pathToFileURL(productPath).href) as typeof publicApi;
      assert.deepEqual(control.buildM2Migration22ProfileValues(newWire), { ok: false, error: { code: "source_contract_mismatch" } });
      assert.deepEqual(control.buildM2Migration22Values(oldWire), buildM2Migration22Values(oldWire));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

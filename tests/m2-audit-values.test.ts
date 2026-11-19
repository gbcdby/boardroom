import test from "node:test";
import assert from "node:assert/strict";
import { observeLegacyAuditChangedSyntax, projectM2TakeoverAuditAdditions } from "../src/server/identity/internal/m2-audit-values.ts";
import type { TakeoverAuditProjectionInput } from "../src/server/identity/internal/m2-audit-values.ts";
import type { RawCell, RawRow } from "../src/server/identity/m2-history-contracts.ts";
import { appendAuditEntry, createAuditRepository, auditView, parseJsonColumn, assertCompleteAuditFields } from "../src/server/audit.ts";
import { parseM2Value } from "../src/server/identity/m2-value-codecs.ts";
import { decodeInvalidationClosure } from "../src/server/tasks/work-event-storage.ts";
import { decisionsMigration } from "../src/server/db/migrations/decisions.ts";
import type { RepoCtx } from "../src/server/db/repositories.ts";
import Database from "better-sqlite3";
import projectionInput from "./fixtures/m2-audit-projection-input.json" with { type: "json" };
import expectedProjection from "./fixtures/m2-audit-projection-expected.json" with { type: "json" };

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
type Mutable<T> = T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;
type Input = Mutable<TakeoverAuditProjectionInput>;
// Exact C2 design input/expected (freeze 263e79e8...). These finite values do not prove R4 source/full P1 qualification.
function fixture(backend: "sqlite" | "postgres" = "sqlite"): Input {
  const input = structuredClone(projectionInput) as unknown as Input;
  if (backend === "postgres") {
    input.seed.source.kind = backend; input.capture.source.kind = backend; input.previousAudit.source.kind = backend;
    input.capture.textEncoding = { backend, name: "UTF8" }; input.previousAudit.textEncoding = { backend, name: "UTF8" };
    for (const table of input.capture.tables) for (const row of table.rows) row.rowid = null;
    for (const row of input.previousAudit.table.rows) {
      row.rowid = null;
      row.cells = row.cells.map(cell => { assert.ok(cell[0] === "text" || cell[0] === "null");
        return cell[0] === "null" ? ["null"] : ["pg-binary", "25", cell[1]]; });
    }
    for (const row of input.rowids) row.rowid = null;
  }
  return input;
}
function project(input: Input) { return projectM2TakeoverAuditAdditions(JSON.stringify(input)); }
function success(input: Input) {
  const result = project(input); assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected finite projection"); return result.value;
}
function failed(result: ReturnType<typeof project> | ReturnType<typeof observeLegacyAuditChangedSyntax>, code?: string) {
  assert.equal(result.ok, false); if (result.ok) throw new Error("expected refusal");
  if (code) assert.equal(result.error.code, code);
  assert.equal(result.error.moreConflicts, false); assert.ok(result.error.conflicts.length <= 1);
  assert.ok(Object.isFrozen(result.error)); return result.error;
}
const fromRaw = (cell: readonly unknown[]) => cell[0] === "null" ? null
  : Buffer.from(cell[cell[0] === "pg-binary" ? 2 : 1] as string, "hex").toString("utf8");
const toRaw = (text: string | null): RawCell => text === null ? ["null"] : ["text", hex(text)];
const syntaxInput = (text: string | null, backend: "sqlite" | "postgres" = "sqlite") => JSON.stringify({
  backend, textEncoding: { backend, name: backend === "sqlite" ? "UTF-8" : "UTF8" },
  cell: text === null ? ["null"] : backend === "sqlite" ? ["text", hex(text)] : ["pg-binary", "25", hex(text)],
});

test("old JSON lexemes, duplicate keys and escaped surrogates keep actual legacy display semantics", () => {
  for (const raw of ["1.0", "1e0", "-0", "9007199254740993", "1e400", "1e999999999999999999999",
    '{"x":1,"\\u0078":2}', '"\\ud800"', '{"\\ud800":0}', ' \n [null, true, {"ref":"unregistered"}] \t']) {
    const input = syntaxInput(raw), result = observeLegacyAuditChangedSyntax(input);
    assert.equal(result.ok, true); if (!result.ok) throw new Error("expected syntax");
    assert.equal(result.value.syntax, "json"); assert.equal(result.value.semanticChecks, "not-performed");
    assert.equal(syntaxInput(raw), input);
  }
  assert.equal(parseJsonColumn("9007199254740993"), 9007199254740992);
  assert.equal(parseJsonColumn("1e400"), Infinity);
  assert.deepEqual(parseJsonColumn('{"x":1,"\\u0078":2}'), { x: 2 });
  assert.equal(parseJsonColumn('"\\ud800"'), "\ud800");
  for (const raw of ["", "\ufeffnull", "[1,]", "{\"x\":1,}", "01", "1.", "NaN", '"\\x41"', '"\u0000"', "{} true"]) {
    const result = observeLegacyAuditChangedSyntax(syntaxInput(raw));
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.syntax, "invalid-json");
    assert.equal(parseJsonColumn(raw), null);
  }
});

test("raw decoding rejects encoding/OID/storage-class and invalid UTF8 without invalid-display fallback", () => {
  const input = JSON.parse(syntaxInput("null")) as { backend: string; textEncoding: { backend: string; name: string }; cell: unknown[] };
  const variants = [
    { ...input, cell: ["text", "ff"] }, { ...input, cell: ["text", "eda080"] },
    { ...input, cell: ["text", "c080"] }, { ...input, cell: ["blob", hex("null")] },
    { ...input, textEncoding: { backend: "sqlite", name: "UTF-16le" } },
    { ...input, backend: "postgres", textEncoding: { backend: "postgres", name: "UTF8" }, cell: ["pg-binary", "23", "00000000"] },
  ];
  for (const v of variants) failed(observeLegacyAuditChangedSyntax(JSON.stringify(v)), "source_contract_mismatch");
  for (const cell of [["text", "0"], ["text", "AB"], ["text", "zz"], ["null", "extra"]]) {
    failed(observeLegacyAuditChangedSyntax(JSON.stringify({ ...input, cell })), "invalid_value");
  }
});

test("strict outer JSON and hostile primitive boundary are separate from the historical inner grammar", t => {
  const valid = syntaxInput("1e400");
  for (const raw of [valid.replace('"backend":"sqlite"', '"backend":"sqlite","back\\u0065nd":"sqlite"'),
    '{"value":9007199254740993}', '{"value":1.00000000000000001}', '{"value":-0}', '{"value":1e-1000000}',
    '{"value":"\\ud800"}', '{"\\ud800":0}', "{", "[] true", "[01]"]) {
    failed(observeLegacyAuditChangedSyntax(raw), "invalid_value");
  }
  const request = JSON.stringify(fixture());
  assert.deepEqual(projectM2TakeoverAuditAdditions(request.replaceAll('"profileRevision":1', '"profileRevision":1e0')), project(fixture()));
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw Error("secret"); }, ownKeys() { traps++; throw Error("secret"); },
    getPrototypeOf() { traps++; throw Error("secret"); } });
  for (const call of [observeLegacyAuditChangedSyntax, projectM2TakeoverAuditAdditions]) {
    for (const value of [hostile, Symbol("secret"), () => {}, { toJSON() { traps++; return {}; } }]) failed(call(value), "unsupported_shape");
  }
  assert.equal(traps, 0);
  const mock = t.mock.method(Buffer, "byteLength", () => { throw hostile; });
  try {
    for (const call of [observeLegacyAuditChangedSyntax, projectM2TakeoverAuditAdditions]) {
      const error = failed(call(valid), "invalid_value");
      assert.equal(error.location, null); assert.equal(error.rule, null); assert.deepEqual(error.conflicts, []);
    }
    assert.equal(traps, 0);
  } finally { mock.mock.restore(); }
});

test("P-A capture stays the actual value consumer and PG produces binary25 rows without native registration", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = fixture(backend);
    assert.equal(parseM2Value({ kind: "legacy-capture", value: input.capture }).ok, true);
    const value = success(input);
    assert.equal(value.source.kind, backend); assert.equal(value.additions.count, "6");
    for (const row of value.additions.rows) {
      assert.equal(row.rowid === null, backend === "postgres");
      for (const cell of row.cells) if (cell[0] !== "null") assert.equal(cell[0], backend === "sqlite" ? "text" : "pg-binary");
    }
    assert.deepEqual(value.additions.rows.map(row => row.cells.map(fromRaw)).sort(),
      expectedProjection.rows.map(row => row.cells.map(fromRaw)).sort());
    const bad = fixture(backend); bad.capture.tables[0]!.rows.push(structuredClone(bad.capture.tables[0]!.rows[0]!));
    bad.capture.tables[0]!.count = String(bad.capture.tables[0]!.rows.length);
    assert.equal(parseM2Value({ kind: "legacy-capture", value: bad.capture }).ok, false);
    failed(project(bad), "semantic_invariant_failed");
  }
});

test("real append/repository/SQLite/view consume every new column while preserving all old raw rows", async () => {
  const input = fixture(), projected = success(input), cols = projected.additions.columns;
  const ddl = decisionsMigration.up.match(/CREATE TABLE audit_log_decision_rebuild \([\s\S]*?\n\);/)![0].replace("audit_log_decision_rebuild", "audit_log");
  const db = new Database(":memory:");
  try {
    db.exec(ddl);
    const insert = db.prepare(`INSERT INTO audit_log (rowid,${cols.map(c => '"' + c + '"').join(",")}) VALUES (${Array(cols.length + 1).fill("?").join(",")})`);
    for (const row of input.previousAudit.table.rows) insert.run(BigInt(row.rowid!), ...row.cells.map(fromRaw));
    const ctx: RepoCtx = { query: async <T>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).all(...params) as T[],
      one: async <T>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => db.prepare(sql).run(...params).changes, withTransaction: async fn => fn() };
    const repo = createAuditRepository(ctx);
    // Expected rows come from the frozen design vector, not a recomputation of the implementation.
    for (const expected of expectedProjection.rows) {
      const fields = Object.fromEntries(cols.map((c, i) => [c, fromRaw(expected.cells[i]!)]));
      const returned = await appendAuditEntry(repo, { scope: "user", projectId: null, actor: { kind: "human", name: fields.actor_name!, memberId: null },
        action: fields.action!, targetKind: "agent", targetId: fields.target_id!, targetName: fields.target_name!,
        changed: JSON.parse(fields.changed!), before: JSON.parse(fields.before!), after: JSON.parse(fields.after!), detail: JSON.parse(fields.detail!) },
      { id: fields.id!, createdAt: fields.created_at! });
      assert.deepEqual(auditView(returned).changed, ["configuration_authority"]);
      assert.equal(auditView(returned).targetName, fields.target_name);
      assert.equal(auditView(returned).reversible, false);
      assert.deepEqual(await repo.getUser(returned.id), returned);
    }
    const actual = db.prepare("SELECT rowid AS original_rowid,* FROM audit_log").safeIntegers(true).all() as Record<string, string | bigint | null>[];
    const rows: RawRow[] = actual.map(row => ({ rowid: String(row.original_rowid), cells: cols.map(c => toRaw(row[c] as string | null)) }));
    for (const old of input.previousAudit.table.rows) assert.deepEqual(rows.find(row => row.rowid === old.rowid), old);
    for (const added of projected.additions.rows) assert.deepEqual(rows.find(row => row.rowid === added.rowid), added);
    assert.equal(rows.length, input.previousAudit.table.rows.length + 6);
  } finally { db.close(); }
});

test("seed/source/captured names and fixed catalog shape are enforced without reinterpreting old JSON", () => {
  const mutations: [string, (v: Input) => void][] = [
    ["source_contract_mismatch", v => { v.seed.source.identityDigest = "f".repeat(64); }],
    ["source_contract_mismatch", v => { v.previousAudit.source.databaseInstanceId = "0".repeat(32); }],
    ["source_contract_mismatch", v => { v.seed.captureId += "other"; }],
    ["source_contract_mismatch", v => { v.capture.textEncoding.name = "UTF-16"; }],
    ["source_contract_mismatch", v => { v.capture.tables[0]!.columns.reverse(); }],
    ["source_contract_mismatch", v => { v.previousAudit.table.columns.pop(); }],
    ["semantic_invariant_failed", v => { v.previousAudit.table.count = "0"; }],
    ["invalid_value", v => { v.previousAudit.table.count = "01"; }],
    ["invalid_value", v => { v.seed.createdAt = "2026-02-30T00:00:00Z"; }],
    ["invalid_value", v => { v.seed.createdAt = "2026-11-19T00:00:00"; }],
    ["invalid_value", v => { (v.seed.actor as { kind: string }).kind = "agent"; }],
    ["invalid_value", v => { (v.seed.actor as { memberId: unknown }).memberId = "member"; }],
    ["unsupported_shape", v => { v.capture.tables[0]!.rows[0]!.cells[1] = ["null"]; }],
  ];
  for (const [code, mutate] of mutations) { const input = fixture(); mutate(input); failed(project(input), code); }
  const preserved = fixture();
  for (const raw of ['  {"x":1,"x":2,"n":1e0} ', "{invalid-old", '"\\ud800"']) {
    preserved.previousAudit.table.rows[0]!.cells[10] = ["text", hex(raw)];
    assert.deepEqual(success(preserved).additions, expectedProjection);
    assert.equal(fromRaw(preserved.previousAudit.table.rows[0]!.cells[10]!), raw);
  }
  preserved.previousAudit.table.rows[0]!.cells[10] = ["blob", "00ff"];
  assert.deepEqual(success(preserved).additions, expectedProjection); // Non-read historical storage classes remain raw, not rewritten.
  const renamed = fixture(); renamed.capture.tables[0]!.rows[0]!.cells[1] = ["text", hex("  捕获名称 Ω\n")];
  assert.ok(success(renamed).additions.rows.some(row => fromRaw(row.cells[9]!) === "  捕获名称 Ω\n"));
  const time = fixture(); time.seed.createdAt = "2026-11-19T23:59:59.123456+08:30";
  assert.ok(success(time).additions.rows.every(row => fromRaw(row.cells[16]!) === time.seed.createdAt));
});

test("Agent coverage, all audit IDs and every preselected rowid are checked without auto allocation", () => {
  const mutations: ((v: Input) => void)[] = [
    v => { v.seed.agents.pop(); }, v => { v.seed.agents.push(structuredClone(v.seed.agents[0]!)); },
    v => { v.seed.agents[1]!.agentId = v.seed.agents[0]!.agentId; }, v => { v.seed.agents[0]!.agentId = "unknown"; },
    v => { v.seed.agents[1]!.auditId = v.seed.agents[0]!.auditId; },
    v => { v.seed.agents[0]!.auditId = fromRaw(v.previousAudit.table.rows[0]!.cells[0]!)!; },
    v => { v.rowids.pop(); }, v => { v.rowids[1]!.agentId = v.rowids[0]!.agentId; },
    v => { v.rowids[1]!.rowid = v.rowids[0]!.rowid; }, v => { v.rowids[0]!.rowid = v.previousAudit.table.rows[0]!.rowid; },
    v => { const row = structuredClone(v.previousAudit.table.rows[0]!); row.rowid = "99999";
      v.previousAudit.table.rows.push(row); v.previousAudit.table.count = String(v.previousAudit.table.rows.length); },
    v => { v.previousAudit.table.rows[1]!.rowid = v.previousAudit.table.rows[0]!.rowid; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); failed(project(input), "semantic_invariant_failed"); }
  for (const bad of ["-0", "01", "1.0", "1e0", "9223372036854775808", "-9223372036854775809", "1".repeat(1000)]) {
    const input = fixture(); input.rowids[0]!.rowid = bad; failed(project(input), "invalid_value");
  }
  for (const good of ["-9223372036854775808", "9223372036854775807", "9007199254740993", "0"]) {
    const input = fixture(); input.rowids[0]!.rowid = good;
    assert.ok(success(input).additions.rows.some(row => row.rowid === good));
  }
  const pg = fixture("postgres"); pg.rowids[0]!.rowid = "1"; failed(project(pg), "source_contract_mismatch");
});

test("zero-Agent and reordered finite inputs are deterministic without claiming full source selection", () => {
  const reordered = fixture(); reordered.seed.agents.reverse(); reordered.rowids.reverse(); reordered.capture.tables[0]!.rows.reverse();
  assert.deepEqual(success(reordered), success(fixture()));
  const empty = fixture(); for (const table of empty.capture.tables) { table.rows = []; table.count = "0"; }
  empty.seed.agents = []; empty.rowids = [];
  const result = success(empty); assert.equal(result.additions.count, "0"); assert.deepEqual(result.additions.rows, []);
  assert.ok(result.remaining.includes("capture-and-previous-audit-selection-provenance"));
});

test("new JSON fields honor exact 32KiB UTF8 while large scalar names remain allowed", () => {
  const base = fixture(), overhead = Buffer.byteLength(JSON.stringify({ activationId: "", owner: "profile", profileRevision: 1 }));
  for (const activation of ["x".repeat(32768 - overhead), "名".repeat(Math.floor((32768 - overhead) / 3)) + "x".repeat((32768 - overhead) % 3)]) {
    const input = fixture(); input.seed.activationId = activation;
    const projected = success(input), after = fromRaw(projected.additions.rows[0]!.cells[12]!)!;
    assert.equal(Buffer.byteLength(after), 32768); assertCompleteAuditFields(JSON.parse(after));
    input.seed.activationId += "x"; failed(project(input), "resource_limit");
  }
  const escaped = fixture(); escaped.seed.activationId = '"'.repeat(Math.floor((32768 - overhead) / 2));
  assert.ok(Buffer.byteLength(fromRaw(success(escaped).additions.rows[0]!.cells[12]!)!) <= 32768);
  escaped.seed.activationId += '"'; failed(project(escaped), "resource_limit");
  const detailOverhead = Buffer.byteLength(JSON.stringify({ captureId: base.seed.captureId, contract: "m2-takeover-audit/r1", planId: "", sourceIdentityDigest: base.seed.source.identityDigest }));
  const detail = fixture(); detail.seed.planId = "p".repeat(32768 - detailOverhead);
  assert.equal(Buffer.byteLength(fromRaw(success(detail).additions.rows[0]!.cells[13]!)!), 32768);
  detail.seed.planId += "p"; failed(project(detail), "resource_limit");
  const scalar = fixture(); scalar.seed.actor.name = "名".repeat(11000);
  for (const row of scalar.capture.tables[0]!.rows) row.cells[1] = ["text", hex(scalar.seed.actor.name)];
  const large = success(scalar); assert.ok(large.additions.rows.every(row => fromRaw(row.cells[5]!) === scalar.seed.actor.name && fromRaw(row.cells[9]!) === scalar.seed.actor.name));
  const pg = fixture("postgres"); pg.seed.actor.name = "bad\0name"; failed(project(pg), "source_contract_mismatch");
});

test("semantic consumers stay strict even when old display grammar succeeds", async () => {
  const detail = { workEventInvalidations: { schema: "work-event-invalidation/v1", eventIds: ["e", "e"] } };
  assert.equal(observeLegacyAuditChangedSyntax(syntaxInput(JSON.stringify(detail))).ok, true);
  assert.throws(() => decodeInvalidationClosure(detail.workEventInvalidations), { code: "work_event_storage_invalid" });
  const input = fixture(), value = success(input), projectedAfter = JSON.parse(fromRaw(value.additions.rows[0]!.cells[12]!)!);
  assert.equal(JSON.stringify({ owner: "profile", activationId: input.seed.activationId, profileRevision: 1 }) === JSON.stringify(projectedAfter), false);
  let appends = 0;
  const repo = { appendUser: async () => { appends++; throw Error("unexpected append"); } } as unknown as ReturnType<typeof createAuditRepository>;
  await assert.rejects(appendAuditEntry(repo, { scope: "user", projectId: null, actor: { kind: "human", name: "actor" }, action: "member.revoke",
    targetKind: "member", targetId: "member", targetName: "member", after: "x".repeat(32768), detail: { reversal: { version: 2 } } },
  { id: "fixed", createdAt: "2026-11-19T00:00:00Z" }), { code: "audit_snapshot_too_large" });
  assert.equal(appends, 0);
});

test("inner depth and nodes share the outer budget; byte/raw/row ceilings refuse before large consumers", () => {
  assert.equal(observeLegacyAuditChangedSyntax(syntaxInput("[".repeat(61) + "0" + "]".repeat(61))).ok, true);
  failed(observeLegacyAuditChangedSyntax(syntaxInput("[".repeat(62) + "0" + "]".repeat(62))), "resource_limit");
  assert.equal(observeLegacyAuditChangedSyntax(syntaxInput("[" + Array(249980).fill("0").join(",") + "]")).ok, true);
  failed(observeLegacyAuditChangedSyntax(syntaxInput("[" + Array(250001).fill("0").join(",") + "]")), "resource_limit");
  failed(observeLegacyAuditChangedSyntax(" ".repeat(16 * 1024 * 1024 + 1)), "resource_limit");
  failed(observeLegacyAuditChangedSyntax(syntaxInput(" ".repeat(4 * 1024 * 1024 + 1))), "resource_limit");
  // At the raw maximum, cumulative scans/encoding already exceed the separate 64MiB bound.
  failed(observeLegacyAuditChangedSyntax(syntaxInput(" ".repeat(4 * 1024 * 1024 - 4) + "null")), "resource_limit");
  const capture = fixture(); capture.capture.tables[0]!.rows[0]!.cells[1] = ["text", hex("x".repeat(512 * 1024))];
  failed(project(capture), "resource_limit"); // P-A subvalue exceeds the accepted 1MiB intersection.
  const rows = fixture(); rows.previousAudit.table.rows = Array.from({ length: 100001 }, () => ({ rowid: "1", cells: [] })); rows.previousAudit.table.count = "100001";
  failed(project(rows), "resource_limit"); // Node ceiling may dominate row ceiling; neither is reset.
});

test("real P-A traversal is precharged into the same work budget", () => {
  const input = fixture();
  const largeCapture = (count: number) => {
    const v = structuredClone(input), table = v.capture.tables[1]!;
    table.columns = ["id"]; table.count = String(count);
    table.rows = Array.from({ length: count }, (_, i) => ({ rowid: String(i + 1), cells: [["text", hex(`runtime-${i}`)]] }));
    return v;
  };
  assert.equal(project(largeCapture(4000)).ok, true);
  failed(project(largeCapture(6500)), "resource_limit");
});

test("exact output byte budget includes hex expansion and fixed metadata, with no truncated success", () => {
  const input = fixture(); input.capture.tables[0]!.rows = input.capture.tables[0]!.rows.slice(0, 1); input.capture.tables[0]!.count = "1";
  input.seed.agents = input.seed.agents.slice(0, 1); input.rowids = input.rowids.slice(0, 1); input.seed.actor.name = "";
  let base = Buffer.byteLength(JSON.stringify(project(input)));
  if ((1024 * 1024 - base) % 2 !== 0) { input.seed.captureId += "x"; input.capture.captureId += "x"; base = Buffer.byteLength(JSON.stringify(project(input))); }
  input.seed.actor.name = "x".repeat((1024 * 1024 - base) / 2);
  const exact = project(input); assert.equal(exact.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(exact)), 1024 * 1024);
  // Single row: captureId adds one public scalar byte + two detail-hex bytes; removing one actor byte subtracts two.
  input.seed.captureId += "x"; input.capture.captureId += "x"; input.seed.actor.name = input.seed.actor.name.slice(1);
  failed(project(input), "resource_limit");
});

test("failures use fixed rules/ordinals and never echo sensitive values, keys, rowids or errors", () => {
  const secret = "SYNTHETIC-sensitive-/private/Ω", forbidden = [secret, hex(secret), Buffer.from(secret).toString("base64")];
  const a = fixture(); a.previousAudit.table.columns[0] = secret;
  const b = fixture(); b.rowids[0]!.rowid = secret;
  const c = fixture(); c.previousAudit.table.rows[0]!.cells[0] = ["text", hex(secret)]; c.seed.agents[0]!.auditId = secret;
  for (const input of [a, b, c, { ...fixture(), [secret]: { [forbidden[2]!]: secret } }]) {
    const result = projectM2TakeoverAuditAdditions(JSON.stringify(input)), error = failed(result), text = JSON.stringify(error);
    for (const value of forbidden) assert.ok(!text.includes(value));
    assert.ok(Buffer.byteLength(text) < 2048);
    assert.ok(error.location === null || ["input.root", "observation.root", "row.cell"].includes(error.location.pathId));
    assert.ok(error.location?.table == null || ["agents", "audit_log"].includes(error.location.table));
  }
});

test("opaque P-A invalid failures cannot relabel an unknown downstream throw as a known input location", t => {
  const input = JSON.stringify(fixture()); let traps = 0;
  const thrown = new Proxy({}, { get() { traps++; throw Error("private consumer error"); },
    ownKeys() { traps++; throw Error("private consumer keys"); }, getPrototypeOf() { traps++; throw Error("private consumer prototype"); } });
  const original = Object.getOwnPropertyDescriptor;
  const mock = t.mock.method(Object, "getOwnPropertyDescriptor", (target: object, key: PropertyKey) => {
    if (target === Object.prototype && key === "constructor") throw thrown; // Actual P-A prototype admission.
    return original(target, key);
  });
  let result: ReturnType<typeof projectM2TakeoverAuditAdditions>;
  try { result = projectM2TakeoverAuditAdditions(input); } finally { mock.mock.restore(); }
  const error = failed(result!, "invalid_value");
  assert.equal(error.location, null); assert.equal(error.rule, null); assert.deepEqual(error.conflicts, []);
  assert.equal(traps, 0);
});

test("error ordinals retain the original row index and one-based fixed catalog column", () => {
  const request = JSON.parse(syntaxInput("null")); request.cell = ["text", "ff"];
  const display = failed(observeLegacyAuditChangedSyntax(JSON.stringify(request)), "source_contract_mismatch");
  assert.deepEqual(display.location, { inputPart: "observation", artifactOrdinal: null, table: "audit_log", rowOrdinal: null, columnOrdinal: 11, pathId: "row.cell" });
  const input = fixture(); input.previousAudit.table.rows[3]!.cells[0] = ["text", "ff"];
  const id = failed(project(input), "source_contract_mismatch");
  assert.equal(id.location!.rowOrdinal, 3); assert.equal(id.location!.columnOrdinal, 1);
  assert.equal(id.rule, "PC1B-RAW01");
});

test("C2 R2 preserves empty historical TEXT audit IDs accepted by the original consumers", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(decisionsMigration.up.match(/CREATE TABLE audit_log_decision_rebuild \([\s\S]*?\n\);/)![0].replace("audit_log_decision_rebuild", "audit_log"));
    const ctx: RepoCtx = { query: async <T>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).all(...params) as T[],
      one: async <T>(sql: string, params: readonly unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
      exec: async (sql, params = []) => db.prepare(sql).run(...params).changes, withTransaction: async fn => fn() };
    const repo = createAuditRepository(ctx);
    const returned = await appendAuditEntry(repo, { scope: "user", projectId: null, actor: { kind: "human", name: "historical actor" },
      action: "configuration.takeover", targetKind: "agent", targetId: "historical-agent", targetName: "original name", changed: ["old"] },
    { id: "", createdAt: "2026-11-19T00:00:00Z" });
    const stored = await repo.getUser("");
    assert.equal(returned.id, ""); assert.ok(stored); assert.equal(stored.id, ""); assert.equal(auditView(stored).id, "");
    assert.equal((db.prepare("SELECT typeof(id) AS t FROM audit_log").get() as { t: string }).t, "text");
    const input = fixture(), record = db.prepare("SELECT rowid AS original_rowid,* FROM audit_log").safeIntegers(true).get() as Record<string, string | bigint | null>;
    input.previousAudit.table.rows = [{ rowid: String(record.original_rowid), cells: input.previousAudit.table.columns.map(c => toRaw(record[c] as string | null)) }];
    input.previousAudit.table.count = "1";
    const original = JSON.stringify(input);
    assert.deepEqual(success(input).additions, expectedProjection);
    assert.equal(JSON.stringify(input), original);
  } finally { db.close(); }
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = fixture(backend), empty: RawCell = backend === "sqlite" ? ["text", ""] : ["pg-binary", "25", ""];
    input.previousAudit.table.rows[0]!.cells[0] = empty;
    assert.equal(success(input).additions.count, "6");
    input.previousAudit.table.rows[1]!.cells[0] = empty;
    failed(project(input), "semantic_invariant_failed");
  }
  for (const cell of [["null"], ["blob", ""], ["integer", "0"]] as RawCell[]) {
    const input = fixture(); input.previousAudit.table.rows[0]!.cells[0] = cell;
    failed(project(input), "unsupported_shape");
  }
  const newEmpty = fixture(); newEmpty.seed.agents[0]!.auditId = ""; failed(project(newEmpty), "invalid_value");
  const occupied = fixture(); occupied.seed.agents[0]!.auditId = fromRaw(occupied.previousAudit.table.rows[0]!.cells[0]!)!;
  failed(project(occupied), "semantic_invariant_failed");
});

test("C2 R2 counts every object key token in the shared node budget without rejecting duplicate display keys", () => {
  const object = (pairs: number) => "{" + Array(pairs).fill('"a":0').join(",") + "}";
  for (const backend of ["sqlite", "postgres"] as const) {
    const below = object(124980), result = observeLegacyAuditChangedSyntax(syntaxInput(below, backend));
    assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.syntax, "json");
    assert.deepEqual(parseJsonColumn(below), { a: 0 });
    const over = object(125000); assert.equal(Buffer.byteLength(over), 750001);
    failed(observeLegacyAuditChangedSyntax(syntaxInput(over, backend)), "resource_limit");
    // Outer tokens are 13 (SQLite) / 14 (PG). Each inner pair is two tokens plus its root container.
    const maximumPairs = backend === "sqlite" ? 124993 : 124992;
    assert.equal(observeLegacyAuditChangedSyntax(syntaxInput(object(maximumPairs), backend)).ok, true);
    failed(observeLegacyAuditChangedSyntax(syntaxInput(object(maximumPairs + 1), backend)), "resource_limit");
  }
  const small = '{"a":1,"\\u0061":2}';
  assert.equal(observeLegacyAuditChangedSyntax(syntaxInput(small)).ok, true);
  assert.deepEqual(parseJsonColumn(small), { a: 2 });
  assert.equal(observeLegacyAuditChangedSyntax(syntaxInput("[".repeat(60) + '{"a":0}' + "]".repeat(60))).ok, true);
  failed(observeLegacyAuditChangedSyntax(syntaxInput("[".repeat(61) + '{"a":0}' + "]".repeat(61))), "resource_limit");
});

test("C2 projects the frozen nonempty six-Agent input to all seventeen exact columns", () => {
  const serialized = JSON.stringify(projectionInput), before = JSON.stringify(projectionInput);
  const result = projectM2TakeoverAuditAdditions(serialized);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected finite projection");
  assert.equal(result.value.classification, "projection");
  assert.equal(result.value.coverage, "takeover-audit-seventeen-columns");
  assert.deepEqual(result.value.additions, expectedProjection);
  assert.equal(result.value.additions.rows.length, 6);
  assert.ok(Object.isFrozen(result.value.additions.rows[0]!.cells));
  assert.deepEqual(result.value.remaining, ["capture-and-previous-audit-selection-provenance", "complete-before-audit-population",
    "legacy-audit-we-reversal-and-m2-semantics", "full-takeover-seed-and-a-delta", "physical-source-and-writer-transaction"]);
  assert.equal(JSON.stringify(projectionInput), before);
});
test("C2 distinguishes SQL NULL, JSON values and invalid old display without issuing a semantic verdict", () => {
  const cases = [
    [null, "sql-null", null], ["null", "json", "null"], ["true", "json", "boolean"],
    ["1.25", "json", "number"], ['"old"', "json", "string"], ["[]", "json", "array"],
    ["{}", "json", "object"], ["{old-invalid", "invalid-json", null],
  ] as const;
  for (const backend of ["sqlite", "postgres"] as const) for (const [raw, syntax, jsonType] of cases) {
    const result = observeLegacyAuditChangedSyntax(syntaxInput(raw, backend));
    assert.deepEqual(result, { ok: true, value: { classification: "syntax-observation", field: "audit_log.changed",
      syntax, jsonType, semanticChecks: "not-performed" } });
    assert.ok(Object.isFrozen(result));
    if (result.ok) assert.ok(Object.isFrozen(result.value));
  }
  assert.equal(parseJsonColumn(null), null);
  assert.equal(parseJsonColumn("null"), null);
  assert.equal(parseJsonColumn("{old-invalid"), null);
});

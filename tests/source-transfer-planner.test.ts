import test from "node:test";
import assert from "node:assert/strict";
import { planSourceTransferValues } from "../src/server/storage/internal/source-transfer-planner.ts";
import type { SourceTransferInput, TransferFrame } from "../src/server/storage/internal/source-transfer-planner.ts";
import type { RawCell } from "../src/server/identity/m2-history-contracts.ts";
import { AuditRequest, boundary, AUDIT_LIMITS } from "../src/server/identity/internal/m2-audit-boundary.ts";
import fixture from "./fixtures/source-transfer-structural.json" with { type: "json" };

// Complete raw-width values, using frozen original SQL defaults. The JSON payloads
// and control proofs deliberately remain synthetic and must NEVER qualify native P1.
const input = (): SourceTransferInput => structuredClone(fixture) as SourceTransferInput;
const table = (frame: TransferFrame, name: string) => frame.tables.find(t => t.name === name)!;
const text = (v: string): RawCell => ["text", Buffer.from(v, "utf8").toString("hex")];
const real = (v: number): RawCell => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return ["real64be", b.toString("hex")]; };
function append(frame: TransferFrame, name: string, values: Record<string, RawCell>, rowid: string) {
  const t = table(frame, name);
  // Every fixed column is present; omitted values are SQL NULL, not a dummy cell.
  // Missing required values are rejected by the actual planner.
  t.rows.push({ rowid, cells: t.columns.map(c => values[c] ?? ["null"]) }); t.count = String(t.rows.length);
}
function set(frame: TransferFrame, name: string, field: string, value: RawCell, row = 0) {
  const t = table(frame, name); t.rows[row]!.cells[t.columns.indexOf(field)] = value;
}
function failure(value: unknown, code?: string) {
  const result = planSourceTransferValues(value);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected refusal");
  if (code) assert.equal(result.error.code, code);
  assert.ok(result.error.conflicts.length <= 1); return result.error;
}
const rejected = (value: SourceTransferInput, code?: string) => failure(JSON.stringify(value), code);
function success(value: SourceTransferInput) {
  const result = planSourceTransferValues(JSON.stringify(value));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected pure value plan");
  return result.value;
}

test("full-width nonempty replacement keeps target authority/history and exact source rowid", () => {
  const original = input(), before = structuredClone(original), plan = success(original);
  assert.equal(plan.classification, "pure-value-plan");
  assert.equal(plan.after.tables.length, 72);
  assert.equal(plan.after.tables.reduce((n, t) => n + t.columns.length, 0), 763);
  assert.equal(plan.stableBefore.length, 71);
  assert.equal(plan.stableAfter.length, 71);
  assert.ok(plan.stableAfter.every(t => t.name !== "storage_source_clients"));
  for (const name of ["config_authority", "schema_migrations", "storage_maintenance", "storage_source_clients"]) {
    assert.deepEqual(plan.after.tables.find(t => t.name === name), table(original.target, name));
  }
  assert.deepEqual(plan.after.tables.find(t => t.name === "agents"), table(original.source!, "agents"));
  assert.equal(plan.after.tables.find(t => t.name === "agents")!.rows[0]!.rowid, "9007199254740993");
  for (const name of ["audit_log", "legacy_config_captures", "config_activation_receipts"]) {
    const rows = plan.after.tables.find(t => t.name === name)!.rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find(r => r.rowid === "7"), table(original.target, name).rows[0]);
    assert.ok(rows.some(r => r.rowid === "1"));
  }
  const messageDelete = plan.steps.find(s => s.phase === "delete-replaced" && s.table === "messages")!;
  assert.equal(messageDelete.effects.length, 1);
  assert.deepEqual(messageDelete.effects[0]!.before!.cells[2], ["integer", "9007199254740990"]);
  assert.deepEqual(messageDelete.effects[0]!.after!.cells[2], ["integer", "9007199254740991"]);
  assert.equal(plan.steps.filter(s => s.phase === "delete-provisional-facts").length, 6);
  assert.deepEqual(plan.after.tables.find(t => t.name === "member_fact_revisions"), table(original.source!, "member_fact_revisions"));
  assert.ok(plan.remainingChecks.includes("target-current-runtime-and-CF17"));
  assert.ok(plan.remainingChecks.includes("strict-domain-and-CHECK-semantics"));
  assert.ok(plan.remainingChecks.includes("artifact-bytes-and-retained-reference-closure"));
  assert.ok(Object.isFrozen(plan.after.tables[0]!.rows));
  assert.deepEqual(original, before);
});

test("stable projection is independent of read row order, includes singleton and excludes only clients", () => {
  const a = input(), b = input();
  table(b.target, "member_fact_revisions").rows.reverse();
  table(b.source!, "member_fact_revisions").rows.reverse();
  set(b.target, "storage_source_clients", "ended_at", text("2026-11-21T00:00:00.000Z"));
  const first = success(a), second = success(b);
  assert.deepEqual(first.stableBefore, second.stableBefore);
  assert.deepEqual(first.stableAfter, second.stableAfter);
  set(b.target, "storage_maintenance", "owner_generation", ["integer", "8"]);
  assert.notDeepEqual(success(b).stableBefore, first.stableBefore);
});

test("whole-width, NULL, int64/rowid and source/encoding boundaries reject before planning", () => {
  for (const mutate of [
    (v: SourceTransferInput) => { v.source!.tables.pop(); },
    (v: SourceTransferInput) => { table(v.source!, "agents").columns.pop(); },
    (v: SourceTransferInput) => { table(v.source!, "agents").rows[0]!.cells.pop(); },
    (v: SourceTransferInput) => { table(v.source!, "agents").count = "9"; },
    (v: SourceTransferInput) => { table(v.source!, "agents").rows[0]!.rowid = "9223372036854775808"; },
    (v: SourceTransferInput) => { table(v.source!, "schema_migrations").rows[0]!.rowid = "21"; },
    (v: SourceTransferInput) => { set(v.source!, "agents", "display_name", ["null"]); },
    (v: SourceTransferInput) => { set(v.source!, "agents", "id", ["text", "ff"]); },
    (v: SourceTransferInput) => { v.source!.source = structuredClone(v.target.source); },
  ]) { const v = input(); mutate(v); rejected(v); }
  const obj = { ...input(), limits: { output: 100_000_000 } };
  failure(JSON.stringify(obj), "unsupported_shape");
  const badEncoding = input(); (badEncoding.source!.textEncoding as { name: string }).name = "UTF-16le";
  rejected(badEncoding, "source_contract_mismatch");
});

test("PK/rowid, ordinary UNIQUE and history request UNIQUE collisions are distinct checks", () => {
  for (const kind of ["pk", "rowid", "secondary"]) {
    const v = input(), t = table(v.source!, "agents"), row = structuredClone(t.rows[0]!);
    if (kind !== "pk") row.cells[0] = text("another-agent");
    if (kind !== "rowid") row.rowid = "18";
    t.rows.push(row); t.count = "2"; rejected(v, "semantic_invariant_failed");
  }
  const request = input(); set(request.source!, "config_activation_receipts", "request_id", text("trequest"));
  rejected(request, "semantic_invariant_failed");
  const conflictingHistory = input(); set(conflictingHistory.source!, "audit_log", "id", text("taudit"));
  rejected(conflictingHistory, "semantic_invariant_failed");
  const identical = input();
  for (const name of ["audit_log", "legacy_config_captures", "config_activation_receipts"]) {
    const targetRow = structuredClone(table(identical.target, name).rows[0]!); targetRow.rowid = "99";
    table(identical.source!, name).rows.push(targetRow); table(identical.source!, name).count = "2";
  }
  const plan = success(identical);
  assert.equal(plan.after.tables.find(t => t.name === "audit_log")!.rows.length, 2);
  assert.equal(plan.steps.filter(s => s.phase === "append-history").length, 3);
});

test("immediate and declared deferred FKs both close in final frames; self rows use actual DAG", () => {
  for (const [name, field, cell] of [["groups", "project_id", text("missing")], ["agent_profiles", "current_revision", ["integer", "2"]]] as const) {
    const v = input(); set(v.source!, name, field, cell as RawCell); rejected(v, "semantic_invariant_failed");
  }
  const v = input(), nodes = table(v.source!, "org_nodes"), at = "2026-11-20T00:00:00.000Z";
  const row = (id: string, parent: string | null, rowid: string) => ({ rowid, cells: [text(id), text("sproject"), parent === null ? ["null"] as RawCell : text(parent), text(id), text("member"), ["integer", "0"] as RawCell, text(at), text(at)] });
  nodes.rows = [row("a-child", "z-root", "21"), row("z-root", null, "20")]; nodes.count = "2";
  const plan = success(v), inserted = plan.steps.filter(s => s.phase === "insert-replaced" && s.table === "org_nodes");
  assert.deepEqual(inserted.map(s => s.after!.cells[0]), [text("z-root"), text("a-child")]);
  const fk = plan.constraints.foreignKeys;
  assert.equal(fk.length, 173); assert.equal(fk.filter(f => f.deferred).length, 23);
  assert.equal(plan.constraints.uniques.length, 93); assert.equal(plan.triggers.length, 34);
  nodes.rows[1]!.cells[2] = text("a-child"); rejected(v, "semantic_invariant_failed");
});

test("clear retains H/U and preflights exact old trigger overflow; source is prohibited", () => {
  const v = input(); v.operation = "clear"; v.source = null; const plan = success(v);
  assert.equal(plan.steps.some(s => s.event === "insert"), false);
  assert.equal(plan.after.tables.find(t => t.name === "agents")!.rows.length, 0);
  for (const name of ["audit_log", "legacy_config_captures", "config_activation_receipts", "config_authority", "storage_source_clients"]) {
    assert.deepEqual(plan.after.tables.find(t => t.name === name), table(v.target, name));
  }
  set(v.target, "member_fact_revisions", "revision", ["integer", "9007199254740991"]);
  rejected(v, "semantic_invariant_failed");
  const missing = input(); table(missing.source!, "member_fact_revisions").rows.pop(); table(missing.source!, "member_fact_revisions").count = "5";
  rejected(missing, "semantic_invariant_failed");
  const wrongBranch = input(); wrongBranch.operation = "clear"; rejected(wrongBranch, "unsupported_shape");
});

test("primitive bounded boundary rejects hostile objects, duplicate envelope keys and caller programs", () => {
  let calls = 0; const hostile = new Proxy({}, { get() { calls++; throw new Error("do not inspect"); }, ownKeys() { calls++; throw new Error("do not inspect"); } });
  failure(hostile, "unsupported_shape"); assert.equal(calls, 0);
  failure('{"contract":"m2-src-transfer-values/v1","contract":"x"}', "invalid_value");
  failure(JSON.stringify({ ...input(), steps: [{ sql: "DELETE FROM config_authority" }] }), "unsupported_shape");
  const large = input(); set(large.source!, "messages", "body", ["blob", "00".repeat(600_000)]);
  rejected(large, "resource_limit");
});

test("all six monitored families produce exact deletion/insertion facts, then restore source bytes", () => {
  const v = input(), at = text("2026-11-20T00:00:00.000Z"), one: RawCell = ["integer", "1"];
  for (const [f, p] of [[v.source!, "s"], [v.target, "t"]] as const) {
    const project = text(p + "project"), agent = text(p + "agent"), group = text(p + "group"), member = text(p + "member"), message = text(p + "message");
    append(f, "message_deliveries", { id: text(p + "delivery"), message_id: message, member_id: member, project_id: project,
      status: text("pending"), attempt_count: ["integer", "0"], created_at: at, updated_at: at }, "50");
    append(f, "memory_summary_requests", { id: text(p + "request"), project_id: project, agent_id: agent, recipient_member_id: member,
      base_version: one, revision: one, state: text("pending"), trigger: text("message_threshold"), trigger_key: text("key"), message_ids: text("[]"), created_at: at }, "51");
    append(f, "memory_message_receipts", { project_id: project, agent_id: agent, group_id: group, message_id: message, first_observed_at: at, counter_value: one }, "52");
    append(f, "memory_trigger_counters", { project_id: project, agent_id: agent, group_id: group, lifetime_count: one, next_threshold: one,
      configured_n: one, threshold_sequence: one, revision: one }, "53");
    append(f, "memory_scan_checkpoints", { id: text(p + "checkpoint"), kind: text("message_threshold"), project_id: project, agent_id: agent, group_id: group,
      sweep: one, revision: one, updated_at: at }, "54");
  }
  const plan = success(v);
  const deletes = plan.steps.filter(s => s.phase === "delete-replaced").flatMap(s => s.effects);
  const inserts = plan.steps.filter(s => s.phase === "insert-replaced").flatMap(s => s.effects).filter(e => e.event === "update");
  assert.equal(deletes.length, 6); assert.equal(inserts.length, 6);
  for (const effect of deletes) {
    assert.deepEqual(effect.before!.cells[2], ["integer", "9007199254740990"]);
    assert.deepEqual(effect.after.cells[2], ["integer", "9007199254740991"]);
  }
  for (const effect of inserts) {
    assert.deepEqual(effect.before!.cells[2], ["integer", "1"]);
    assert.deepEqual(effect.after.cells[2], ["integer", "2"]);
    assert.notEqual(typeof effect.after.rowid, "string");
  }
  for (const step of plan.steps.filter(s => s.phase === "delete-provisional-facts")) {
    assert.deepEqual(step.before!.cells[2], ["integer", "2"]);
    assert.notEqual(typeof step.before!.rowid, "string");
  }
  assert.deepEqual(plan.after.tables.find(t => t.name === "member_fact_revisions"), table(v.source!, "member_fact_revisions"));
  assert.equal(plan.triggers.filter(t => t.event === "update").reduce((n, t) => n + t.invocations, 0), 0);
});

test("partial UNIQUE and NULL semantics do not collapse distinct SQL rows", () => {
  const v = input(), first = structuredClone(table(v.source!, "messages").rows[0]!);
  first.rowid = "16"; first.cells[0] = text("second-message"); first.cells[3] = ["integer", "2"];
  table(v.source!, "messages").rows.push(first); table(v.source!, "messages").count = "2";
  success(v); // Both client_message_id values are SQL NULL; the partial index excludes both.
  set(v.source!, "messages", "client_message_id", text("same"), 0);
  set(v.source!, "messages", "client_message_id", text("same"), 1);
  rejected(v, "semantic_invariant_failed");
  const roots = input(), at = text("2026-11-20T00:00:00.000Z");
  for (const id of ["root1", "root2"]) append(roots.source!, "org_nodes", { id: text(id), project_id: text("sproject"), name: text(id),
    role: text("member"), sort_order: ["integer", "0"], created_at: at, updated_at: at }, id === "root1" ? "1" : "2");
  rejected(roots, "semantic_invariant_failed");
});

test("second self DAG and exact mixed numeric equality keep int64 distinctions", () => {
  const v = input(), versions = table(v.source!, "role_template_versions"), original = structuredClone(versions.rows[0]!);
  const second = structuredClone(original); second.rowid = "18"; second.cells[1] = ["integer", "2"];
  second.cells[7] = text("srole"); second.cells[8] = ["integer", "1"];
  versions.rows.unshift(second); versions.count = "2";
  const inserts = success(v).steps.filter(s => s.phase === "insert-replaced" && s.table === "role_template_versions");
  assert.deepEqual(inserts.map(s => s.after!.cells[1]), [["integer", "1"], ["integer", "2"]]);
  set(v.source!, "role_template_versions", "copied_from_role_template_id", text("srole"), 1);
  set(v.source!, "role_template_versions", "copied_from_revision", ["integer", "2"], 1);
  rejected(v, "semantic_invariant_failed");
  const numeric = input(), rows = table(numeric.source!, "role_template_versions");
  const a = structuredClone(original), b = structuredClone(original);
  a.rowid = "19"; a.cells[1] = ["integer", "9007199254740993"];
  b.rowid = "20"; b.cells[1] = real(9007199254740992);
  rows.rows.push(a, b); rows.count = "3";
  success(numeric); // Exact INTEGER 2^53+1 is not REAL 2^53.
  a.cells[1] = ["integer", "9007199254740992"]; rejected(numeric, "semantic_invariant_failed");
  const unsupported = input(); set(unsupported.source!, "agents", "id", ["integer", "1"]);
  rejected(unsupported, "unsupported_shape");
  const raw = input(); set(raw.source!, "audit_log", "changed", ["blob", "00ff"]);
  set(raw.source!, "audit_log", "before", real(-0));
  const carried = success(raw).after.tables.find(t => t.name === "audit_log")!.rows.find(r => r.rowid === "1")!;
  assert.deepEqual(carried.cells[10], ["blob", "00ff"]); assert.deepEqual(carried.cells[11], real(-0));
});

test("fixed aggregate output budget has a real success/refusal edge without caller limits", () => {
  let low = 0, high = 300_000;
  const probe = (bytes: number) => { const v = input(); set(v.source!, "messages", "body", ["blob", "00".repeat(bytes)]); return planSourceTransferValues(JSON.stringify(v)); };
  while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if (probe(mid).ok) low = mid; else high = mid; }
  const last = probe(low), next = probe(high);
  assert.ok(last.ok); assert.equal(next.ok, false);
  if (!last.ok || next.ok) throw new Error("expected fixed budget edge");
  assert.equal(next.error.code, "resource_limit"); assert.ok(low > 0);
  assert.ok(last.value.charges.outputBytesReserved <= 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(last)) <= 1024 * 1024);
  assert.equal(last.value.charges.scope, "planner-additions-on-shared-C2-ledger");
  const a = input(), b = input(), combined = input(), raw: RawCell = ["blob", "00".repeat(60_000)];
  set(a.source!, "messages", "body", raw); set(b.source!, "audit_log", "changed", raw);
  success(a); success(b);
  set(combined.source!, "messages", "body", raw); set(combined.source!, "audit_log", "changed", raw);
  rejected(combined, "resource_limit"); // Different tables still spend one request ledger.
});

test("original member and work-event INSERT guards are modeled, not waived as remaining CHECKs", () => {
  const removed = input(); set(removed.source!, "members", "removed_at", text("2026-11-20T00:00:00.000Z"));
  rejected(removed, "semantic_invariant_failed");
  set(removed.source!, "members", "status", text("disabled")); success(removed);
  const v = input(), at = text("2026-11-20T00:00:00.000Z");
  append(v.source!, "work_events", { id: text("event"), project_id: text("sproject"), recipient_member_id: text("smember"),
    kind: text("fixture"), event_key: text("event-key"), payload: text("{}"), delivery_state: text("pending"), attempts: ["integer", "0"], created_at: at }, "51");
  append(v.source!, "work_event_delivery_invalidations", { work_event_id: text("event"), project_id: text("sproject"), cause_member_id: text("smember"),
    cause_from_revision: ["integer", "1"], cause_to_revision: ["integer", "2"], cause_action: text("removed"), cause_audit_id: text("saudit"), invalidated_at: at }, "52");
  assert.equal(success(v).triggers.find(t => t.name === "work_event_invalidation_integer_guard")!.invocations, 1);
  set(v.source!, "work_event_delivery_invalidations", "cause_from_revision", real(1));
  rejected(v, "unsupported_shape");
});


test("SRC cumulative read/copy budget rejects the reviewed padded input before full parsing", () => {
  const compact = JSON.stringify(input()), padded = " ".repeat(8.25 * 1024 * 1024) + compact;
  assert.equal(Buffer.byteLength(padded), 8_696_083);
  assert.ok(Buffer.byteLength(padded) * 2 > 16 * 1024 * 1024);
  assert.ok(planSourceTransferValues(compact).ok);
  let fullParses = 0;
  const parse = JSON.parse;
  JSON.parse = function(value, reviver) { if (value === padded) fullParses++; return parse(value, reviver); };
  try { failure(padded, "resource_limit"); }
  finally { JSON.parse = parse; }
  assert.equal(fullParses, 0, "reject the accumulated cost before performing the full parse");
  const originalC2 = boundary(padded, () => null);
  assert.ok(originalC2.ok, "the original C2 boundary retains its existing policy");
  assert.equal(AUDIT_LIMITS.characters, 64 * 1024 * 1024);
});

test("outer reads and later raw decoding/output share the SRC budget in replace and clear", () => {
  for (const operation of ["replace", "clear"] as const) {
    const base = input();
    if (operation === "clear") { base.operation = operation; base.source = null; }
    const changed = structuredClone(base);
    set(changed.source ?? changed.target, "messages", "body", text("a".repeat(60_000)));
    const paddedBase = " ".repeat(1.25 * 1024 * 1024) + JSON.stringify(base);
    const compactChanged = JSON.stringify(changed), combined = " ".repeat(1.25 * 1024 * 1024) + compactChanged;
    assert.ok(planSourceTransferValues(paddedBase).ok, operation + " outer-read positive control");
    const rawOnly = planSourceTransferValues(compactChanged);
    assert.ok(rawOnly.ok, operation + " raw/output positive control");
    assert.ok(Buffer.byteLength(JSON.stringify(rawOnly)) < 1024 * 1024);
    assert.ok(Buffer.byteLength(combined) < 16 * 1024 * 1024);
    failure(combined, "resource_limit");
  }
});

test("SRC has a complete-request success/refusal edge after parsing and through final output", (t) => {
  const compact = JSON.stringify(input()), base = planSourceTransferValues(compact);
  assert.ok(base.ok);
  const probe = (padding: number) => planSourceTransferValues(" ".repeat(padding) + compact);
  let low = 0, high = 2 * 1024 * 1024;
  assert.equal(probe(high).ok, false);
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (probe(mid).ok) low = mid; else high = mid;
  }
  const observed = (padding: number) => {
    const wire = " ".repeat(padding) + compact;
    const text = AuditRequest.prototype.text, parse = JSON.parse;
    const paid = new Map<AuditRequest, number>(); let fullParses = 0;
    AuditRequest.prototype.text = function(bytes, passes = 1) {
      const result = text.call(this, bytes, passes);
      paid.set(this, (paid.get(this) ?? 2048) + bytes * passes);
      return result;
    };
    JSON.parse = function(value, reviver) { if (value === wire) fullParses++; return parse(value, reviver); };
    let result;
    try { result = planSourceTransferValues(wire); }
    finally { AuditRequest.prototype.text = text; JSON.parse = parse; }
    assert.equal(paid.size, 1, "parse, decoders, keys, projections, effects and output retain one request");
    assert.equal(fullParses, 1, "both neighbours reach full parsing; refusal is cumulative later work");
    assert.ok([...paid.values()][0]! <= 16 * 1024 * 1024);
    return { result, prepaidBytes: [...paid.values()][0]!, fullParses };
  };
  const accepted = observed(low), refused = observed(high), last = accepted.result, next = refused.result;
  assert.equal(high, low + 1);
  assert.deepEqual(last, base, "whitespace cannot change the accepted plan or mint a second budget");
  assert.equal(next.ok, false);
  if (next.ok) throw new Error("expected cumulative resource refusal");
  assert.equal(next.error.code, "resource_limit");
  t.diagnostic(JSON.stringify({ scope: "SRC same-request cumulative byte boundary", limit: 16 * 1024 * 1024,
    accepted: { padding: low, inputBytes: low + Buffer.byteLength(compact), prepaidBytes: accepted.prepaidBytes, fullParses: accepted.fullParses },
    refused: { padding: high, inputBytes: high + Buffer.byteLength(compact), prepaidBytesBeforeRejection: refused.prepaidBytes,
      fullParses: refused.fullParses, code: next.error.code } }));
});

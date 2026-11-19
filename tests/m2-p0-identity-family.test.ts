import assert from "node:assert/strict";
import { roleTemplateInputSchema } from "../src/server/identity/catalog.ts";
import test from "node:test";
import { chargeP0, createP0Request, p0Usage, retainP0Rows, readP0Json, p0RowSite, withP0Guard } from "../src/server/identity/internal/m2-p0.ts";
import type { P0Request, P0Result, P0View } from "../src/server/identity/internal/m2-p0.ts";
import { checkP0IdentityFamily } from "../src/server/identity/internal/m2-p0-identity-family.ts";
import { addB, addMember, addMessage, addNode, addProject, addRoleVersion, addSession, aliasFixture, chatFixture, orgFixture, removeB, roleFixture, setB } from "./helpers/m2-p0-b-fixture.ts";
import type { BFixture } from "./helpers/m2-p0-b-fixture.ts";
function value<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function request(input: BFixture): P0Request { return value(createP0Request(JSON.stringify(input))); }
function failure(input: BFixture, rule: string) {
  const result = checkP0IdentityFamily(request(input)); assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.rule, rule); return result.error;
}

test("ROLE01 classifies exact unsafe INT64 references before the ordinary minimum constraint", () => {
  for (const backend of ["sqlite", "postgres"] as const) for (const phase of ["original", "retained"] as const) {
    // PostgreSQL's registered revision column is int4; its wire cannot encode
    // unsafe INT64. Exercise that backend's real maximum and ordinary minimum.
    const revisions = backend === "sqlite" ? [9007199254740991n, 9007199254740993n, -9007199254740993n, 0n] : [2147483647n, 0n];
    for (const revision of revisions) {
      const input = roleFixture(backend);
      setB(input, "role_template_versions", 1, "revision", revision);
      setB(input, "role_template_versions", 2, "copied_from_revision", revision);
      const req = request(input), raw = JSON.stringify(req.input);
      const view = phase === "original" ? req.original : retainP0Rows(req,
        req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0])));
      const result = checkP0IdentityFamily(req, view);
      assert.equal(JSON.stringify(req.input), raw, "exact source INT64 cells remain unchanged");
      if (revision > 0n && revision <= 9007199254740991n) { value(result); continue; }
      assert.equal(result.ok, false); if (result.ok) assert.fail();
      const unsafe = revision > 9007199254740991n || revision < -9007199254740991n;
      assert.equal(result.error.code, unsafe ? "semantic_unsupported"
        : phase === "retained" ? "retained_reference_conflict" : "semantic_invariant_failed");
      assert.equal(result.error.rule, "PC1B-ROLE01");
      assert.equal(result.error.location?.table, "role_template_versions");
      assert.equal(result.error.location?.rowOrdinal, 1);
      assert.equal(result.error.location?.columnOrdinal, 2);
      assert.equal(result.error.conflicts[0]?.condition, "unsupported-value");
    }
  }
});

test("ROLE02 reserves actual schema clone nodes before either original or retained allocation", () => {
  const count = (node: unknown): number => {
    if (node === null || typeof node !== "object") return 1;
    if (Array.isArray(node)) return 1 + node.reduce((sum, child) => sum + count(child), 0);
    return 1 + Object.values(node).reduce<number>((sum, child) => sum + 1 + count(child), 0);
  };
  for (const phase of ["original", "retained"] as const) for (const exhausted of [false, true]) {
    const req = request(roleFixture());
    for (const row of req.original.rows("role_template_versions")) value(withP0Guard(req, () =>
      readP0Json(req, row, "recommended_skill_refs_json", "reference", p0RowSite(req, req.original, row, "recommended_skill_refs_json"))));
    let view = req.original;
    if (phase === "retained") {
      value(checkP0IdentityFamily(req));
      view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0])));
    }
    if (exhausted) chargeP0(req, { nodes: 250000 - p0Usage(req).nodes });
    const before = p0Usage(req), native = roleTemplateInputSchema.safeParse;
    let calls = 0, allocatedOutputNodes = 0;
    try {
      roleTemplateInputSchema.safeParse = function(...args: Parameters<typeof native>) {
        calls++; const result = native.apply(this, args);
        if (result.success) allocatedOutputNodes += count(result.data);
        return result;
      };
      const result = checkP0IdentityFamily(req, view);
      if (exhausted) {
        assert.equal(result.ok, false); if (result.ok) assert.fail();
        assert.equal(result.error.code, "resource_limit"); assert.equal(calls, 0);
        assert.deepEqual(checkP0IdentityFamily(req, view), result, "node exhaustion remains sticky");
      } else {
        value(result); assert.equal(calls, 3);
        assert.ok(p0Usage(req).nodes - before.nodes >= allocatedOutputNodes, "the actual new output tree is fully charged");
      }
    } finally { roleTemplateInputSchema.safeParse = native; }
  }
});

test("ID01 preserves renamed aliases and reserved retired identity without a live target", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const req = request(aliasFixture(backend)), before = JSON.stringify(req.input.graph.observation);
    const result = value(checkP0IdentityFamily(req));
    assert.equal(result.fullSemanticClosure, "not-performed");
    assert.deepEqual(result.checkedRules, ["PC1B-ID01", "PC1B-ROLE01", "PC1B-ROLE02", "PC1B-ORG01", "PC1B-CHAT01"]);
    assert.equal(JSON.stringify(req.input.graph.observation), before);
  }
});

test("ID01 checks both directions, retired negative invariants and duplicate history without map overwrite", () => {
  const missing = aliasFixture(); removeB(missing, "agent_legacy_aliases", 0); failure(missing, "PC1B-ID01");
  const target = aliasFixture(); setB(target, "agent_legacy_aliases", 2, "agent_id", "secret-missing");
  const error = failure(target, "PC1B-ID01"); assert.equal(error.conflicts[0]?.condition, "missing-target");
  assert.equal(JSON.stringify(error).includes("secret-missing"), false);
  const retired = aliasFixture(); setB(retired, "agent_legacy_aliases", 2, "retired_at", "t");
  assert.equal(failure(retired, "PC1B-ID01").conflicts[0]?.condition, "negative-invariant");
  const claimed = aliasFixture(); removeB(claimed, "agent_legacy_aliases", 1);
  setB(claimed, "agent_legacy_aliases", 2, "display_name", "two");
  assert.equal(failure(claimed, "PC1B-ID01").conflicts[0]?.condition, "negative-invariant");
  const stolen = aliasFixture(); setB(stolen, "agent_legacy_aliases", 1, "agent_id", "agent-one"); failure(stolen, "PC1B-ID01");
  const duplicate = aliasFixture(); addB(duplicate, "agent_legacy_aliases", { display_name: "old-one", host_type: "h", agent_id: "agent-one", created_at: "t" });
  assert.equal(failure(duplicate, "PC1B-ID01").conflicts[0]?.condition, "duplicate-key");
});

test("B authenticates request/view before properties and retains original alias ordinals", () => {
  const req = request(aliasFixture()); let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; throw Error(); }, getPrototypeOf() { traps++; throw Error(); }, ownKeys() { traps++; throw Error(); } });
  for (const result of [checkP0IdentityFamily(hostile as P0Request), checkP0IdentityFamily(req, hostile as P0View),
    checkP0IdentityFamily(req, { phase: "retained-graph", rowCount: 0, rows: () => [] } as unknown as P0View)]) {
    assert.equal(result.ok, false); if (result.ok) assert.fail(); assert.equal(result.error.rule, null);
  }
  assert.equal(traps, 0);
  const rows = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0]));
  const kept = rows.filter(row => !(row.table === "agents" && row.rowOrdinal === 0));
  const result = checkP0IdentityFamily(req, retainP0Rows(req, kept)); assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.location?.rowOrdinal, 0);
  assert.equal(result.error.location?.table, "agent_legacy_aliases");
});


test("ROLE01 uses the exact head and all copy history; ROLE02 preserves raw external skill descriptions", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const req = request(roleFixture(backend)), before = JSON.stringify(req.input.graph.observation);
    value(checkP0IdentityFamily(req)); assert.equal(JSON.stringify(req.input.graph.observation), before);
  }
});
test("ROLE01 rejects orphan versions, dangling exact heads, half pairs and historical copy cycles", () => {
  const head = roleFixture(); setB(head, "role_templates", 0, "revision", 3n); failure(head, "PC1B-ROLE01");
  const orphan = roleFixture(); setB(orphan, "role_template_versions", 1, "role_template_id", "absent"); failure(orphan, "PC1B-ROLE01");
  const half = roleFixture(); setB(half, "role_template_versions", 2, "copied_from_revision", null); failure(half, "PC1B-ROLE01");
  const target = roleFixture(); setB(target, "role_template_versions", 2, "copied_from_revision", 3n); failure(target, "PC1B-ROLE01");
  const cycle = roleFixture(); setB(cycle, "role_template_versions", 1, "copied_from_role_template_id", "copy");
  setB(cycle, "role_template_versions", 1, "copied_from_revision", 1n); failure(cycle, "PC1B-ROLE01");
  const self = roleFixture(); setB(self, "role_template_versions", 1, "copied_from_role_template_id", "source");
  setB(self, "role_template_versions", 1, "copied_from_revision", 2n); failure(self, "PC1B-ROLE01");
  for (const revision of [0n, 9007199254740992n]) {
    const bad = roleFixture(); setB(bad, "role_template_versions", 1, "revision", revision); failure(bad, "PC1B-ROLE01");
  }
});
test("ROLE02 checks strict schema, 64 refs, full typed tuples and all old revisions", () => {
  const ref = (skillId: string, version = "v") => ({ skillId, version, contentDigest: "a".repeat(64) });
  const good = roleFixture(); setB(good, "role_template_versions", 0, "recommended_skill_refs_json", JSON.stringify(Array.from({ length: 64 }, (_, i) => ref(`s${i}`))));
  value(checkP0IdentityFamily(request(good)));
  const distinct = roleFixture(); setB(distinct, "role_template_versions", 0, "recommended_skill_refs_json", JSON.stringify([ref("a|b", "c"), ref("a", "b|c")]));
  value(checkP0IdentityFamily(request(distinct)));
  for (const refs of [[ref("same"), ref("same")], Array.from({ length: 65 }, (_, i) => ref(`s${i}`)),
    [{ ...ref("s"), extra: true }], [ref(" spaced ")], [ref("x\0")], [{ ...ref("s"), contentDigest: "A".repeat(64) }], [{ ...ref("s"), version: 1 }]]) {
    const bad = roleFixture(); setB(bad, "role_template_versions", 0, "recommended_skill_refs_json", JSON.stringify(refs)); failure(bad, "PC1B-ROLE02");
  }
  const duplicate = roleFixture(); setB(duplicate, "role_template_versions", 0, "recommended_skill_refs_json", '[{"skillId":"x","skillId":"y","version":"v","contentDigest":"' + "a".repeat(64) + '"}]');
  assert.equal(checkP0IdentityFamily(request(duplicate)).ok, false);
});
test("role deletion rechecks exact historical references with original ordinals", () => {
  const req = request(roleFixture()), kept = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0]))
    .filter(row => !(row.table === "role_template_versions" && row.rowOrdinal === 1));
  const result = checkP0IdentityFamily(req, retainP0Rows(req, kept)); assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.rule, "PC1B-ROLE01");
  assert.equal(result.error.location?.rowOrdinal, 2);
});


test("ORG01 accepts complete trees, disabled/removed history, no-org manager and positive safe observations", () => {
  for (const backend of ["sqlite", "postgres"] as const) value(checkP0IdentityFamily(request(orgFixture(backend))));
  const old = orgFixture(); setB(old, "members", 0, "membership_revision", 9007199254740991n);
  setB(old, "members", 1, "status", "disabled"); setB(old, "member_fact_revisions", 0, "revision", 9007199254740991n);
  setB(old, "projects", 0, "archived_at", "old"); value(checkP0IdentityFamily(request(old)));
});
test("ORG01 checks complete graph, root-role equivalence and same-project parent", () => {
  for (const [ordinal, column, change] of [[0, "role", "member"], [1, "role", "owner"], [1, "parent_id", "absent"],
    [1, "parent_id", "leaf"], [1, "project_id", "legacy"]] as const) {
    const bad = orgFixture(); setB(bad, "org_nodes", ordinal, column, change); failure(bad, "PC1B-ORG01");
  }
  const roots = orgFixture(); addNode(roots, "root-two", null, "top_manager"); failure(roots, "PC1B-ORG01");
  const disconnected = orgFixture(); addNode(disconnected, "loop-a", "loop-b", "member"); addNode(disconnected, "loop-b", "loop-a", "sub_manager");
  failure(disconnected, "PC1B-ORG01");
});
test("ORG01 checks occupancy, legacy projection, removed shape and all six unique fact kinds", () => {
  for (const [ordinal, column, change] of [[1, "node_id", "root"], [0, "role", "normal"], [2, "status", "pending"],
    [2, "node_id", "leaf"], [2, "role", "manager"], [1, "project_id", "legacy"], [1, "membership_revision", 0n],
    [1, "kind", "agent"]] as const) {
    const bad = orgFixture(); setB(bad, "members", ordinal, column, change); failure(bad, "PC1B-ORG01");
  }
  const manager = orgFixture(); addMember(manager, "second-manager", "legacy", null, "manager"); failure(manager, "PC1B-ORG01");
  const missing = orgFixture(); removeB(missing, "member_fact_revisions", 0); failure(missing, "PC1B-ORG01");
  const duplicate = orgFixture(); setB(duplicate, "member_fact_revisions", 1, "kind", "authored-messages"); failure(duplicate, "PC1B-ORG01");
  for (const change of [0n, 9007199254740992n]) {
    const bad = orgFixture(); setB(bad, "member_fact_revisions", 0, "revision", change); failure(bad, "PC1B-ORG01");
  }
  const orphan = orgFixture(); setB(orphan, "member_fact_revisions", 0, "member_id", "gone"); failure(orphan, "PC1B-ORG01");
});
test("ORG01 does not apply capture's 512 edge limit to a complete historical graph", () => {
  const input = orgFixture();
  for (let i = 0; i < 513; i++) addNode(input, `extra${i}`, "root", "member");
  value(checkP0IdentityFamily(request(input)));
  const long = orgFixture(), id = "n".repeat(1100); setB(long, "org_nodes", 1, "id", id); setB(long, "members", 1, "node_id", id);
  value(checkP0IdentityFamily(request(long)));
});
test("ORG01 rechecks node references and facts in the retained graph", () => {
  const req = request(orgFixture()); value(checkP0IdentityFamily(req));
  const kept = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0]))
    .filter(row => !(row.table === "org_nodes" && row.rowOrdinal === 1));
  const result = checkP0IdentityFamily(req, retainP0Rows(req, kept)); assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.rule, "PC1B-ORG01");
  assert.equal(result.error.location?.table, "members"); assert.equal(result.error.location?.rowOrdinal, 1);
});


test("CHAT01 accepts historical selectors and disabled/removed/nonparticipant/archived observations", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = chatFixture(backend); addMessage(input, "second", "group", "removed", 10n); addSession(input, "other-old", "disconnected");
    addSession(input, "active", "connected"); const req = request(input), before = JSON.stringify(req.input.graph.observation);
    value(checkP0IdentityFamily(req)); assert.equal(JSON.stringify(req.input.graph.observation), before);
  }
});
test("CHAT01 checks all actual group/member/message/session same-scope relations", () => {
  for (const [table, column, change] of [["groups", "project_id", "gone"], ["group_participants", "member_id", "legacy-manager"],
    ["messages", "sender_member_id", "legacy-manager"], ["messages", "group_id", "missing"],
    ["message_deliveries", "project_id", "legacy"], ["message_deliveries", "member_id", "legacy-manager"],
    ["message_deliveries", "message_id", "gone"], ["member_statuses", "project_id", "legacy"],
    ["mcp_sessions", "member_id", "worker"], ["mcp_sessions", "group_id", "other-group"], ["mcp_sessions", "project_id", "legacy"]] as const) {
    const bad = chatFixture(); setB(bad, table, 0, column, change); failure(bad, "PC1B-CHAT01");
  }
});
test("CHAT01 enforces exact seq/client/session and structural uniqueness predicates", () => {
  const seq = chatFixture(); addMessage(seq, "same-seq", "group", "removed", 7n); failure(seq, "PC1B-CHAT01");
  const client = chatFixture(); setB(client, "messages", 0, "client_message_id", "client"); addMessage(client, "same-client", "group", "removed", 8n, "client");
  failure(client, "PC1B-CHAT01");
  const active = chatFixture(); setB(active, "mcp_sessions", 0, "state", "connected"); addSession(active, "second-active", "connected"); failure(active, "PC1B-CHAT01");
  const participant = chatFixture(); addB(participant, "group_participants", { group_id: "group", member_id: "worker", joined_at: "t" }); failure(participant, "PC1B-CHAT01");
  for (const seqValue of [0n, 9007199254740992n]) { const bad = chatFixture(); setB(bad, "messages", 0, "seq", seqValue); failure(bad, "PC1B-CHAT01"); }
});
test("CHAT01 validates scalar domains and wake enum pairing without inferring timestamp facts", () => {
  for (const [table, column, change] of [["messages", "body", " "], ["messages", "client_message_id", ""],
    ["message_deliveries", "status", "unknown"], ["message_deliveries", "attempt_count", -1n],
    ["message_deliveries", "wake_decision", "suppressed"], ["message_deliveries", "wake_suppressed_reason", "rate_limited"],
    ["member_statuses", "state", "active"], ["mcp_sessions", "state", "active"]] as const) {
    const bad = chatFixture(); setB(bad, table, 0, column, change); failure(bad, "PC1B-CHAT01");
  }
  const old = chatFixture(); setB(old, "message_deliveries", 0, "acked_at", null);
  setB(old, "message_deliveries", 0, "wake_decision", "suppressed"); setB(old, "message_deliveries", 0, "wake_suppressed_reason", "rate_limited");
  value(checkP0IdentityFamily(request(old)));
});
test("CHAT01 mentions are a strict string array, with actual backend selector representability", () => {
  for (const mentions of ['[1]', '[null]', '[["worker"]]', '[{"id":"worker"}]', '{}', 'null', 'invalid', '[]\0tail']) {
    const bad = chatFixture(); setB(bad, "messages", 0, "mentions", mentions); assert.equal(checkP0IdentityFamily(request(bad)).ok, false);
  }
  for (const selector of ["a\0b", "\ud800", "\udc00"]) {
    const raw = JSON.stringify([selector]); const sqlite = chatFixture(); setB(sqlite, "messages", 0, "mentions", raw);
    value(checkP0IdentityFamily(request(sqlite)));
    const pg = chatFixture("postgres"); setB(pg, "messages", 0, "mentions", raw); failure(pg, "PC1B-CHAT01");
  }
  const pgPair = chatFixture("postgres"); setB(pgPair, "messages", 0, "mentions", '["\\ud83d\\ude00"]');
  value(checkP0IdentityFamily(request(pgPair)));
});
test("CHAT01 rechecks retained messages and preserves original source positions", () => {
  const req = request(chatFixture()); value(checkP0IdentityFamily(req));
  const kept = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0]))
    .filter(row => row.table !== "messages");
  const result = checkP0IdentityFamily(req, retainP0Rows(req, kept)); assert.equal(result.ok, false); if (result.ok) assert.fail();
  assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.rule, "PC1B-CHAT01");
  assert.equal(result.error.location?.table, "message_deliveries"); assert.equal(result.error.location?.rowOrdinal, 0);
});


test("B keeps a single exhausting meter across wrappers and both graph passes", () => {
  const req = request(chatFixture()); value(checkP0IdentityFamily(req)); const first = p0Usage(req);
  const kept = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0]));
  const view = retainP0Rows(req, kept); value(checkP0IdentityFamily(req, view)); const second = p0Usage(req);
  assert.ok(second.bytes > first.bytes); assert.ok(second.work > first.work);
  chargeP0(req, { bytes: 64 * 1024 * 1024 - second.bytes - 1 });
  for (const selected of [undefined, view]) {
    const result = checkP0IdentityFamily(req, selected); assert.equal(result.ok, false); if (result.ok) assert.fail();
    assert.equal(result.error.code, "resource_limit"); assert.ok(p0Usage(req).bytes <= 64 * 1024 * 1024);
  }
});
test("B rejects a foreign view and revoked Proxy; arbitrary legacy-consumer throws remain uninspected", () => {
  const req = request(roleFixture()); const foreign = request(roleFixture()).original;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const result of [checkP0IdentityFamily(req, foreign), checkP0IdentityFamily(revoked.proxy as P0Request)]) {
    assert.equal(result.ok, false); if (result.ok) assert.fail(); assert.equal(result.error.rule, null);
  }
  let traps = 0;
  const thrown = new Proxy({}, { get() { traps++; throw 0; }, getPrototypeOf() { traps++; throw 0; }, ownKeys() { traps++; throw 0; } });
  const original = roleTemplateInputSchema.safeParse;
  try {
    roleTemplateInputSchema.safeParse = () => { throw thrown; };
    const result = checkP0IdentityFamily(req); assert.equal(result.ok, false); if (result.ok) assert.fail();
    assert.equal(result.error.code, "invalid_value"); assert.equal(result.error.rule, null); assert.equal(traps, 0);
  } finally { roleTemplateInputSchema.safeParse = original; }
});
test("ORG01 keeps the explicitly finite SQLite REAL sort domain and original IEEE bytes", () => {
  for (const number of [-0, 0.5, -1.5]) {
    const input = orgFixture(), table = input.graph.observation.tables.find(t => t.name === "org_nodes")!;
    const bytes = Buffer.alloc(8); bytes.writeDoubleBE(number);
    table.rows[0]!.cells[table.columns.indexOf("sort_order")] = ["real64be", bytes.toString("hex")];
    const req = request(input), before = JSON.stringify(req.input.graph.observation); value(checkP0IdentityFamily(req));
    assert.equal(JSON.stringify(req.input.graph.observation), before);
  }
  const bad = orgFixture(), table = bad.graph.observation.tables.find(t => t.name === "org_nodes")!;
  table.rows[0]!.cells[table.columns.indexOf("sort_order")] = ["real64be", "7ff0000000000000"];
  const result = checkP0IdentityFamily(request(bad)); assert.equal(result.ok, false);
});

test("B validates every consumed identity/role metadata TEXT cell without rewriting timestamps", () => {
  for (const [input, tableName, column, ordinal] of [
    [aliasFixture(), "agents", "last_seen_at", 0], [aliasFixture(), "agents", "created_at", 0],
    [aliasFixture(), "agent_legacy_aliases", "created_at", 0], [roleFixture(), "role_templates", "updated_at", 0],
    [roleFixture(), "role_template_versions", "archived_at", 1], [roleFixture(), "role_template_versions", "created_at", 1],
  ] as const) {
    const table = input.graph.observation.tables.find(t => t.name === tableName)!;
    table.rows[ordinal]!.cells[table.columns.indexOf(column)] = ["text", "ff"];
    const result = checkP0IdentityFamily(request(input)); assert.equal(result.ok, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import type { RawCell } from "../src/server/identity/m2-history-contracts.ts";
import { checkP0Keys, createP0Request, retainP0Rows, withP0Guard, readP0Json, readP0Text } from "../src/server/identity/internal/m2-p0.ts";
import type { P0Request, P0Result } from "../src/server/identity/internal/m2-p0.ts";
import { addP0Row, p0Fixture, p0Integer, p0Text } from "./helpers/m2-p0-a-fixture.ts";

type Input = ReturnType<typeof p0Fixture>;
function unwrap<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function request(input: Input): P0Request { return unwrap(createP0Request(JSON.stringify(input))); }
function add(input: Input, table: string, values: Record<string, string | bigint | null>, rowid?: string) {
  const backend = input.graph.observation.backend;
  addP0Row(input, table, Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    value === null ? ["null"] : typeof value === "bigint" ? p0Integer(backend, table, key, value) : p0Text(backend, value)])) as Record<string, RawCell>, rowid);
}
function set(input: Input, table: string, ordinal: number, column: string, value: string | bigint | null) {
  const t = input.graph.observation.tables.find(t => t.name === table)!;
  t.rows[ordinal]!.cells[t.columns.indexOf(column)] = value === null ? ["null"] : typeof value === "bigint"
    ? p0Integer(input.graph.observation.backend, table, column, value) : p0Text(input.graph.observation.backend, value);
}
function core(backend: "sqlite" | "postgres" = "sqlite"): Input {
  const input = p0Fixture(backend);
  add(input, "projects", { id: "p", name: "P", created_at: "t", updated_at: "t", project_revision: 1n, workspace_revision: 0n });
  add(input, "agents", { id: "a", display_name: "A", host_type: "h", created_at: "t", updated_at: "t" });
  add(input, "groups", { id: "g", project_id: "p", name: "G", created_at: "t", updated_at: "t" });
  add(input, "members", { id: "m", project_id: "p", kind: "human", display_name: "Human", role: "normal", created_at: "t", updated_at: "t", status: "active", membership_revision: 1n });
  add(input, "messages", { id: "msg", group_id: "g", sender_member_id: "m", seq: 1n, body: "hello", mentions: "[1,{}]", created_at: "t" });
  return input;
}
function keyFailure(input: Input, condition?: string) {
  const result = checkP0Keys(request(input)); assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected KEY failure");
  assert.equal(result.error.rule, "PC1B-KEY01");
  if (condition) assert.equal(result.error.conflicts[0]?.condition, condition);
  return result.error;
}

test("SQLite JSON CHECK keeps native NUL termination separate from full TEXT grammar", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db, migrations); db.pragma("foreign_keys = ON");
    for (const mentions of ["[]", "[]\0", "[]\0trailing", '["x"]\0garbage', '["\\u0000"]\0tail']) {
      const input = core(); set(input, "messages", 0, "mentions", mentions);
      db.exec("BEGIN");
      try {
        for (const name of ["projects", "agents", "groups", "members", "messages"]) {
          const table = input.graph.observation.tables.find(t => t.name === name)!;
          const parameters = table.rows[0]!.cells.map(cell => cell[0] === "null" ? null
            : cell[0] === "integer" ? BigInt(cell[1]) : Buffer.from(cell[1]!, "hex").toString("utf8"));
          db.prepare(`INSERT INTO "${name}" (${table.columns.map(c => `"${c}"`).join(",")}) VALUES (${parameters.map(() => "?").join(",")})`).run(...parameters);
        }
        assert.deepEqual(db.pragma("foreign_key_check"), []);
        assert.deepEqual(db.prepare("SELECT json_valid(mentions) AS valid, json_type(mentions) AS kind, lower(hex(mentions)) AS raw FROM messages").get(),
          { valid: 1, kind: "array", raw: Buffer.from(mentions).toString("hex") });
        const req = request(input); unwrap(checkP0Keys(req));
        const row = req.original.rows("messages")[0]!;
        assert.equal(unwrap(withP0Guard(req, () => readP0Text(req, row, "mentions"))), mentions);
        if (mentions.includes("\0")) {
          const semantic = withP0Guard(req, () => readP0Json(req, row, "mentions", "reference"));
          assert.equal(semantic.ok, false);
          if (semantic.ok) assert.fail();
          assert.equal(semantic.error.code, "semantic_unsupported");
        }
      } finally { db.exec("ROLLBACK"); }
    }
    for (const mentions of ["\0[]", "[\0]", "[\"\0\"]", "[]x\0ignored"]) {
      assert.equal((db.prepare("SELECT json_valid(?) AS valid").get(mentions) as { valid: number }).valid, 0);
      const input = core(); set(input, "messages", 0, "mentions", mentions); keyFailure(input, "state-mismatch");
    }
  } finally { db.close(); }
});

test("KEY checks both complete fixed catalogues without claiming semantic closure", () => {
  for (const backend of ["sqlite", "postgres"] as const) for (const input of [p0Fixture(backend), core(backend)]) {
    const result = unwrap(checkP0Keys(request(input)));
    assert.equal(result.classification, "sql-constraint-observation"); assert.equal(result.tables, 61);
    assert.equal(result.fullSemanticClosure, "not-performed"); assert.equal("ruleCoverage" in result, false);
  }
});

test("PK, independent UNIQUE and SQLite rowid collisions retain original source ordinals", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = core(backend);
    add(input, "agents", { id: "second-secret", display_name: "A", host_type: "h", created_at: "t", updated_at: "t" });
    const error = keyFailure(input, "duplicate-key");
    assert.equal(error.location?.table, "agents"); assert.equal(error.location?.rowOrdinal, 1);
    assert.equal(error.conflicts[0]?.target?.rowOrdinal, 0); assert.ok(!JSON.stringify(error).includes("second-secret"));
    set(input, "agents", 1, "display_name", "B"); set(input, "agents", 1, "id", "a"); keyFailure(input, "duplicate-key");
  }
  const input = core();
  add(input, "agents", { id: "b", display_name: "B", host_type: "h", created_at: "t", updated_at: "t" }, "1");
  keyFailure(input, "duplicate-key");
});

test("partial UNIQUE includes only its exact scope and leaves nullable unique keys distinct", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = core(backend);
    add(input, "members", { id: "m2", project_id: "p", kind: "human", display_name: "Another", role: "normal", created_at: "t", updated_at: "t", status: "active", membership_revision: 1n });
    add(input, "messages", { id: "msg2", group_id: "g", sender_member_id: "m", seq: 2n, body: "hello", mentions: "[]", created_at: "t" });
    const common = { version: 1n, markdown: "x", byte_length: 1n, updated_at: "t", updated_by: "h", source: "human" };
    add(input, "memory_documents", { ...common, id: "global", scope: "global", agent_id: "a" });
    add(input, "memory_documents", { ...common, id: "project", scope: "project", project_id: "p" });
    unwrap(checkP0Keys(request(input)));
    set(input, "memory_documents", 1, "scope", "global"); set(input, "memory_documents", 1, "project_id", null); set(input, "memory_documents", 1, "agent_id", "a");
    keyFailure(input, "duplicate-key");
    const messages = core(backend);
    add(messages, "messages", { id: "msg2", group_id: "g", sender_member_id: "m", seq: 2n, body: "hello", mentions: "[]", created_at: "t", client_message_id: "same" });
    set(messages, "messages", 0, "client_message_id", "same"); keyFailure(messages, "duplicate-key");
  }
});

test("FK checks every original and retained row without applying CASCADE or SET NULL", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = core(backend), req = request(input); unwrap(checkP0Keys(req));
    const kept = input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<typeof req.original.rows>[0])).filter(row => row.table !== "groups");
    const result = checkP0Keys(req, retainP0Rows(req, kept)); assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.location?.table, "messages");
    assert.equal(result.error.location?.rowOrdinal, 0); assert.equal(result.error.conflicts[0]?.target, null);
    set(input, "messages", 0, "group_id", "missing-secret"); keyFailure(input, "missing-target");
  }
});

test("composite FK equality is exact and MATCH SIMPLE keeps nullable components", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = core(backend);
    add(input, "tasks", { id: "task", project_id: "p", title: "T", body: "", labels: "[]", state: "todo", revision: 1n, author: "h", created_at: "t", updated_at: "t", acceptance_text: "", acceptance_source: "explicit" });
    add(input, "task_comments", { id: "comment", task_id: "task", project_id: "p", kind: "comment", author: "h", author_actor_id: "h", body: "x", created_at: "t" });
    unwrap(checkP0Keys(request(input))); // (project, task, SQL NULL report) skips only this FK.
    add(input, "projects", { id: "other", name: "P", created_at: "t", updated_at: "t", project_revision: 1n, workspace_revision: 0n });
    set(input, "task_comments", 0, "project_id", "other"); keyFailure(input, "missing-target");
  }
});

test("CHECK and NOT NULL use SQL truth, ASCII trim, Unicode character length and both backend catalogues", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    const input = core(backend);
    add(input, "message_deliveries", { id: "d", message_id: "msg", member_id: "m", project_id: "p", status: "pending", attempt_count: 0n, created_at: "t", updated_at: "t" });
    unwrap(checkP0Keys(request(input))); // nullable wake_decision IN (...) is SQL UNKNOWN.
    set(input, "message_deliveries", 0, "wake_decision", "suppressed"); keyFailure(input, "state-mismatch");
    set(input, "message_deliveries", 0, "wake_suppressed_reason", "rate_limited"); unwrap(checkP0Keys(request(input)));
    set(input, "agents", 0, "display_name", "\t"); unwrap(checkP0Keys(request(input)));
    set(input, "agents", 0, "display_name", "  "); keyFailure(input, "state-mismatch");
    set(input, "agents", 0, "display_name", null); keyFailure(input, "state-mismatch");
    const title = core(backend);
    add(title, "tasks", { id: "task", project_id: "p", title: "😀".repeat(200), body: "", labels: "[]", state: "todo", revision: 1n, author: "h", created_at: "t", updated_at: "t", acceptance_text: "", acceptance_source: "explicit" });
    unwrap(checkP0Keys(request(title))); set(title, "tasks", 0, "title", "😀".repeat(201)); keyFailure(title, "state-mismatch");
    const enumInput = core(backend); set(enumInput, "members", 0, "status", "unknown"); keyFailure(enumInput, "state-mismatch");
    const json = core(backend); set(json, "messages", 0, "mentions", "not JSON");
    if (backend === "sqlite") keyFailure(json, "state-mismatch"); else unwrap(checkP0Keys(request(json))); // PG has no SQL JSON CHECK; CHAT still owns its grammar.
  }
  const nul = core(); set(nul, "agents", 0, "display_name", "\u0000visible"); keyFailure(nul, "state-mismatch");
});

test("SQL ASCII trim preserves internal runs, non-ASCII whitespace and native NUL behavior", () => {
  const db = new Database(":memory:");
  try {
    for (const text of ["", " ".repeat(32768), "x" + " ".repeat(32768) + "y", " " + "x" + " ".repeat(32768) + "y ", " \t ", " \u00a0 ", " \ufeff ", " \0x ", " x\0 "]) {
      const native = db.prepare("SELECT length(trim(?)) > 0 AS accepted").get(text) as { accepted: number };
      const input = core(); set(input, "agents", 0, "display_name", text);
      const req = request(input), result = checkP0Keys(req);
      assert.equal(result.ok, native.accepted === 1, JSON.stringify({ length: text.length, native }));
      if (result.ok) {
        const row = req.original.rows("agents")[0]!;
        assert.equal(unwrap(withP0Guard(req, () => readP0Text(req, row, "display_name"))), text);
      }
      if (!text.includes("\0")) {
        const pg = core("postgres"); set(pg, "agents", 0, "display_name", text);
        assert.equal(checkP0Keys(request(pg)).ok, native.accepted === 1);
      }
    }
  } finally { db.close(); }
});

test("INTEGER keys keep adjacent int64 values distinct and reject REAL storage impersonation", () => {
  const input = p0Fixture();
  add(input, "role_templates", { id: "role", revision: 1n, created_at: "t", updated_at: "t" });
  const version = { role_template_id: "role", name: "R", purpose: "", instructions: "", recommended_skill_refs_json: "[]", created_at: "t" };
  add(input, "role_template_versions", { ...version, revision: 9007199254740992n });
  add(input, "role_template_versions", { ...version, revision: 9007199254740993n, copied_from_role_template_id: "role", copied_from_revision: 9007199254740992n });
  unwrap(checkP0Keys(request(input)));
  set(input, "role_template_versions", 1, "copied_from_revision", 9007199254740994n); keyFailure(input, "missing-target");
  const table = input.graph.observation.tables.find(t => t.name === "role_template_versions")!;
  table.rows[0]!.cells[table.columns.indexOf("revision")] = ["real64be", "3ff0000000000000"];
  const result = checkP0Keys(request(input)); assert.equal(result.ok, false);
  if (result.ok) assert.fail(); assert.equal(result.error.code, "semantic_unsupported");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  SQLITE_PROFILE_EXISTING_TRIGGERS,
  SQLITE_PROFILE_RULE_SOURCE,
  SQLITE_PROFILE_TABLE_RULES,
} from "../src/server/storage/internal/sqlite-profile-rules.ts";
import {
  SQLITE_PROFILE_GUARD_COMPONENT,
  SQLITE_PROFILE_GUARD_DEFINITIONS,
  SQLITE_PROFILE_UDF_ABI,
} from "../src/server/storage/internal/sqlite-profile-guard-source.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const rows = new Map(SQLITE_PROFILE_TABLE_RULES.map(row => [row.table, row]));
type Cell = string | number | bigint | Buffer | null;
type Image = Readonly<Record<string, Cell>>;
type Event = "insert" | "update" | "delete";
interface Seed { table: string; rowid: bigint; values: Image }
const controlImage: Image = Object.freeze({
  singleton: 1n, database_instance_id: "synthetic-source", control_root_json: "root-fixture",
  mutex_identity_json: "mutex-fixture", fence_epoch: 7n, admission: "open", active_migration_id: null,
  plan_digest: null, owner_generation: 3n, journal_record_ref: null, journal_digest: null,
  journal_sequence: 0n, protocol_version: 2n, guard_manifest_digest: "a".repeat(64),
  profile_takeover_terminal_json: "synthetic-terminal-not-production-evidence",
});

function createCatalog(db: Database.Database): void {
  for (const row of SQLITE_PROFILE_TABLE_RULES) {
    db.exec(`CREATE TABLE ${quote(row.table)} (${row.columns.map(column => `${quote(column.name)} ${column.type}`).join(",")}, PRIMARY KEY (${row.primaryKey.map(quote).join(",")}))`);
  }
}

function valuesFor(table: string, image: Image | null): Cell[] {
  return rows.get(table)!.columns.map(column => image?.[column.name] ?? null);
}

function expectedRow(table: string, event: Event, oldRowid: bigint | null, newRowid: bigint | null, oldImage: Image | null, newImage: Image | null): Cell[] {
  return [table, event, oldRowid, newRowid, ...valuesFor(table, oldImage), ...valuesFor(table, newImage)];
}

function insert(db: Database.Database, seed: Seed): void {
  const names = rows.get(seed.table)!.columns.map(column => column.name);
  db.prepare(`INSERT INTO ${quote(seed.table)} (rowid,${names.map(quote).join(",")}) VALUES (${Array(names.length + 1).fill("?").join(",")})`)
    .run(seed.rowid, ...valuesFor(seed.table, seed.values));
}

/**
 * 仅 SQL 组件机制夹具：测试自己构造 :memory: 连接并注册合成函数。
 * synthetic source/terminal、下面 frame/expected 集合不进入任何产品入口。
 * 它不是另一个 P1 owner，也不能代替并行 private L/T/O 内核的验收。
 */
function mechanism(seeds: readonly Seed[] = [], controlOverrides: Image | null = {}, nonG0 = false) {
  const db = new Database(":memory:");
  db.defaultSafeIntegers(true);
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  createCatalog(db);
  if (controlOverrides !== null) insert(db, { table: "storage_maintenance", rowid: 1n, values: { ...controlImage, ...controlOverrides } });
  for (const seed of seeds) insert(db, seed);
  if (nonG0) for (const source of SQLITE_PROFILE_EXISTING_TRIGGERS) db.exec(source.sql);
  for (const source of SQLITE_PROFILE_GUARD_DEFINITIONS) db.exec(source.sql);

  let current: { role: "business" | "s4-control"; expected: readonly (readonly Cell[])[] } | null = null;
  const observed: unknown[][] = [];
  db.function(SQLITE_PROFILE_UDF_ABI.format.name, SQLITE_PROFILE_UDF_ABI.format.options,
    function (table: unknown, _event: unknown, marker: unknown, epoch: unknown, digest: unknown, writer: unknown) {
      return current !== null && db.inTransaction && typeof table === "string" && current.role === rows.get(table)?.guardOwner
        && marker === controlImage.database_instance_id && epoch === controlImage.fence_epoch
        && digest === controlImage.guard_manifest_digest && writer === SQLITE_PROFILE_RULE_SOURCE.basis.writerDescriptor.sha256 ? 1 : 0;
    });
  db.function(SQLITE_PROFILE_UDF_ABI.row.name, SQLITE_PROFILE_UDF_ABI.row.options, (...args: unknown[]) => {
    observed.push(args); // 只在测试函数采集真实 native 参数，不是生产 UDF 的状态更新。
    return current !== null && db.inTransaction && current.expected.some(expected => isDeepStrictEqual(args, expected)) ? 1 : 0;
  });
  function run(expected: readonly (readonly Cell[])[], action: () => void, role: "business" | "s4-control" = "business") {
    db.exec("BEGIN IMMEDIATE");
    current = { role, expected };
    try {
      action();
      current = null;
      db.exec("COMMIT");
    } catch (error) {
      current = null;
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally { current = null; }
  }
  return { db, run, observed };
}

test("SQ source: complete accepted matrix, column catalog and non-G0 sources retain their independent digests", () => {
  // 期望来自已接受 SQ-D01 + SRC-D01 R2 原件，不由产品实现或 SQL 返回值生成。
  const matrix = SQLITE_PROFILE_TABLE_RULES.map(rule => ({
    table: rule.table, columnCount: rule.columns.length, primaryKey: rule.primaryKey,
    guardOwner: rule.guardOwner, owner: rule.owner, operationEligibility: rule.operationEligibility,
    columns: rule.columns.map(column => ({ column: column.name, rule: column.rule })),
    originalRule: rule.originalRule, qualification: rule.qualification,
  }));
  assert.equal(hash(canonical(matrix)), "b019a09f05a649bf7a38618829160360c1e200b2509d34f5e97b35ac4ebca89f");
  const sourceReplacement = "SRC-01 exact full-source replacement with own target authority";
  assert.deepEqual(matrix.filter(row => row.operationEligibility.insert.includes(sourceReplacement)).map(row => row.table),
    ["agent_profile_versions", "config_detach_snapshots", "config_mutation_receipts", "config_workspace_mappings", "group_binding_config_versions"]);
  // 移除仅这五项增补后，整个旧矩阵（含 UPDATE/DELETE/列策略）仍逐值相等。
  const originalMatrix = matrix.map(row => ({ ...row, operationEligibility: {
    ...row.operationEligibility, insert: row.operationEligibility.insert.filter(item => item !== sourceReplacement),
  } }));
  assert.equal(hash(canonical(originalMatrix)), "97d6b19b6aba0f3813879ee83f0cb1e8ea8816b63a0c41a3f6bcff7eddd55ddc");
  assert.equal(SQLITE_PROFILE_RULE_SOURCE.basis.matrix.bytes, 209374);
  assert.equal(SQLITE_PROFILE_RULE_SOURCE.basis.matrix.sha256, "7485efee85b7c56093f3685c0465e1104a3b972ce8d581774a7a193441b85c38");
  const catalog = SQLITE_PROFILE_TABLE_RULES.map(rule => ({
    name: rule.table,
    columns: rule.columns.map(({ rule: _rule, ...column }) => column),
    foreignKeys: rule.foreignKeys, withoutRowid: rule.withoutRowid, sqlSHA256: rule.sqlSHA256,
  }));
  assert.equal(hash(canonical(catalog)), "91a5e9715857620fe4b2c82d08286225ae5cef36cac556f52811fa6447e0d534");
  assert.equal(hash(canonical(SQLITE_PROFILE_EXISTING_TRIGGERS)), "d96322d82530a9cd1e4b96c898e0c7101be1bca6460488926d70097beaf5d90c");
  assert.equal(SQLITE_PROFILE_TABLE_RULES.length, 72);
  assert.equal(SQLITE_PROFILE_TABLE_RULES.reduce((n, row) => n + row.columns.length, 0), 763);
  assert.equal(SQLITE_PROFILE_TABLE_RULES.filter(row => row.guardOwner === "business").length, 70);
  assert.equal(SQLITE_PROFILE_TABLE_RULES.filter(row => row.guardOwner === "s4-control").length, 2);
  assert.equal(SQLITE_PROFILE_TABLE_RULES.find(row => row.table === "storage_source_clients")?.columns.length, 17);
  assert.equal(SQLITE_PROFILE_EXISTING_TRIGGERS.length, 34);
});

test("SQ source: actual SQLite installs all 216 fixed components and preserves all 34 non-G0 definitions", () => {
  const db = new Database(":memory:");
  try {
    // 仅声明列与 PK 的 72 表隔离夹具；不是完整 P1 schema/准入或领域消费者。
    createCatalog(db);
    for (const source of SQLITE_PROFILE_EXISTING_TRIGGERS) db.exec(source.sql);
    for (const definition of SQLITE_PROFILE_GUARD_DEFINITIONS) db.exec(definition.sql);
    assert.equal(SQLITE_PROFILE_GUARD_DEFINITIONS.length, 216);
    assert.equal((db.prepare("SELECT count(*) count FROM main.sqlite_schema WHERE type='trigger'").get() as { count: number }).count, 250);
    for (const source of [...SQLITE_PROFILE_EXISTING_TRIGGERS, ...SQLITE_PROFILE_GUARD_DEFINITIONS]) {
      const stored = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name=?").get(source.name) as { sql: string };
      assert.equal(stored.sql, source.sql);
      assert.equal(Buffer.byteLength(stored.sql, "utf8"), source.bytes);
      assert.equal(hash(stored.sql), source.sha256);
    }
    // EXPLAIN 只调用真实 SQLite 编译器，不执行领域写入；补 CREATE TRIGGER 延迟列解析。
    db.function(SQLITE_PROFILE_UDF_ABI.format.name, SQLITE_PROFILE_UDF_ABI.format.options,
      function (_t: unknown, _e: unknown, _m: unknown, _epoch: unknown, _g: unknown, _w: unknown) { return 0; });
    db.function(SQLITE_PROFILE_UDF_ABI.row.name, SQLITE_PROFILE_UDF_ABI.row.options, (..._args: unknown[]) => 0);
    let compiled = 0;
    for (const row of SQLITE_PROFILE_TABLE_RULES) {
      for (const sql of [
        `INSERT INTO main.${quote(row.table)} DEFAULT VALUES`,
        `UPDATE main.${quote(row.table)} SET ${quote(row.columns[0]!.name)}=${quote(row.columns[0]!.name)}`,
        `DELETE FROM main.${quote(row.table)}`,
      ]) { assert(db.prepare(`EXPLAIN ${sql}`).all().length > 0); compiled++; }
    }
    assert.equal(compiled, 216);
    assert.deepEqual(SQLITE_PROFILE_UDF_ABI.row.parameters,
      ["table", "event", "oldRowid", "newRowid", "OLD cells in declared column order", "NEW cells in declared column order"]);
    assert.deepEqual(SQLITE_PROFILE_UDF_ABI.format.parameters,
      ["table", "event", "databaseInstanceId", "fenceEpoch", "guardManifestDigest", "writerFormatDigest"]);
    assert.equal(SQLITE_PROFILE_UDF_ABI.row.maximumArguments, 60);
    assert.equal(SQLITE_PROFILE_RULE_SOURCE.qualification, "inert-fixed-source; not-admission");
    assert.equal(SQLITE_PROFILE_GUARD_COMPONENT.qualification, "component-only; not-final-G1");
    assert.equal(SQLITE_PROFILE_GUARD_COMPONENT.guardTransitionRef, null);
    assert.equal(SQLITE_PROFILE_GUARD_COMPONENT.targetSchemaRef, null);
  } finally { db.close(); }
});

test("SQ source: exports are deeply frozen inert values, with no installer or caller-fed builder", async () => {
  function frozen(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    assert(Object.isFrozen(value));
    for (const item of Object.values(value)) frozen(item);
  }
  for (const module of [await import("../src/server/storage/internal/sqlite-profile-rules.ts"),
    await import("../src/server/storage/internal/sqlite-profile-guard-source.ts")]) {
    for (const value of Object.values(module)) { assert.notEqual(typeof value, "function"); frozen(value); }
  }
  assert.throws(() => { (SQLITE_PROFILE_TABLE_RULES[0]!.columns as unknown[]).push("caller-column"); }, TypeError);
  assert.throws(() => { (SQLITE_PROFILE_GUARD_DEFINITIONS[0] as { sql: string }).sql = "SELECT 1"; }, TypeError);
  assert.equal(new Set(SQLITE_PROFILE_GUARD_DEFINITIONS.map(source => source.name)).size, 216);
  assert.deepEqual(SQLITE_PROFILE_UDF_ABI.row.options,
    { safeIntegers: true, varargs: true, deterministic: false, directOnly: false });
  assert.deepEqual(SQLITE_PROFILE_UDF_ABI.format.options,
    { safeIntegers: true, varargs: false, deterministic: false, directOnly: false });
  assert.equal(SQLITE_PROFILE_UDF_ABI.format.requiredDeclaredParameters, 6);
  assert.equal(SQLITE_PROFILE_GUARD_COMPONENT.sqlBytes, SQLITE_PROFILE_GUARD_DEFINITIONS.reduce((sum, definition) => sum + definition.bytes, 0));
  const { bytes, sha256, ...manifest } = SQLITE_PROFILE_GUARD_COMPONENT;
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(manifest), "utf8"));
  assert.equal(sha256, hash(JSON.stringify(manifest)));
  assert.deepEqual(SQLITE_PROFILE_GUARD_COMPONENT.requiredPragmas, { foreign_keys: "ON", recursive_triggers: "ON" });
});

test("SQ mechanism: exact INSERT/UPDATE/DELETE transport preserves int64, BLOB, NUL text and null", () => {
  const f = mechanism();
  const before: Image = { id: "p", name: Buffer.from([0, 255, 17]), created_at: "汉字\0尾", updated_at: "t", archived_at: null,
    project_revision: 9_007_199_254_740_993n, workspace_revision: 9_223_372_036_854_775_807n };
  const after: Image = { ...before, name: "更新🙂", project_revision: 9_007_199_254_740_994n };
  try {
    const insertArgs = expectedRow("projects", "insert", null, -17n, null, before);
    assert.throws(() => insert(f.db, { table: "projects", rowid: -17n, values: before }), /BR_M2_PROFILE_FORMAT_BLOCKED/);
    f.run([insertArgs], () => insert(f.db, { table: "projects", rowid: -17n, values: before }));
    assert.deepEqual(f.observed.at(-1), insertArgs);
    assert.deepEqual(f.db.prepare("SELECT * FROM projects").get(), before);
    const updateArgs = expectedRow("projects", "update", -17n, -17n, before, after);
    f.run([updateArgs], () => f.db.prepare("UPDATE projects SET name=?, project_revision=? WHERE id='p'").run(after.name, after.project_revision));
    assert.deepEqual(f.observed.at(-1), updateArgs);
    const deleteArgs = expectedRow("projects", "delete", -17n, null, after, null);
    f.run([deleteArgs], () => f.db.exec("DELETE FROM projects WHERE id='p'"));
    assert.deepEqual(f.observed.at(-1), deleteArgs);
    assert.equal((f.db.prepare("SELECT count(*) n FROM projects").get() as { n: bigint }).n, 0n);
    assert.throws(() => insert(f.db, { table: "projects", rowid: -17n, values: before }), /BR_M2_PROFILE_FORMAT_BLOCKED/);
  } finally { f.db.close(); }
});

test("SQ mechanism: largest declared row uses exactly 60 arguments and absent side is all NULL", () => {
  const f = mechanism();
  const image: Image = { id: "synthetic-detach" };
  try {
    const expected = expectedRow("config_detach_snapshots", "insert", null, 77n, null, image);
    assert.equal(expected.length, 60);
    f.run([expected], () => insert(f.db, { table: "config_detach_snapshots", rowid: 77n, values: image }));
    assert.deepEqual(f.observed.at(-1), expected);
    assert(f.observed.at(-1)!.slice(4, 32).every(value => value === null));
  } finally { f.db.close(); }
});

test("SQ mechanism: old already-prepared handle without the private functions cannot write after install", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "boardroom-sq-source-"));
  const file = path.join(dir, "mechanism.sqlite");
  const old = new Database(file);
  let installing: Database.Database | undefined;
  try {
    createCatalog(old);
    insert(old, { table: "storage_maintenance", rowid: 1n, values: controlImage });
    const prepared = old.prepare("INSERT INTO projects(id,name) VALUES ('old-writer','old')");
    installing = new Database(file);
    for (const source of SQLITE_PROFILE_GUARD_DEFINITIONS) installing.exec(source.sql);
    assert.throws(() => prepared.run(), /no such function: br_m2_private_(format|row)_v1/);
    assert.equal((old.prepare("SELECT count(*) n FROM projects").get() as { n: number }).n, 0);
  } finally { installing?.close(); old.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const [name, overrides] of [
  ["protocol 1", { protocol_version: 1n }],
  ["sealed", { admission: "sealed" }],
  ["NULL terminal", { profile_takeover_terminal_json: null }],
  ["different source", { database_instance_id: "other" }],
  ["different epoch", { fence_epoch: 8n }],
  ["different guard manifest", { guard_manifest_digest: "b".repeat(64) }],
] as const) {
  test(`SQ mechanism: business rejects ${name} despite an exact row image`, () => {
    const f = mechanism([], overrides);
    const image: Image = { id: "p" };
    try {
      assert.throws(() => f.run([expectedRow("projects", "insert", null, 1n, null, image)],
        () => insert(f.db, { table: "projects", rowid: 1n, values: image })), /BR_M2_PROFILE_FORMAT_BLOCKED/);
      assert.equal(f.observed.length, 0);
    } finally { f.db.close(); }
  });
}

test("SQ mechanism: absent or multiple singleton rows fail closed", () => {
  for (const f of [mechanism([], null), mechanism([
    { table: "storage_maintenance", rowid: 2n, values: { ...controlImage, singleton: 2n } },
  ])]) {
    try {
      const image: Image = { id: "p" };
      assert.throws(() => f.run([expectedRow("projects", "insert", null, 1n, null, image)],
        () => insert(f.db, { table: "projects", rowid: 1n, values: image })), /BR_M2_PROFILE_FORMAT_BLOCKED/);
      assert.equal(f.observed.length, 0);
    } finally { f.db.close(); }
  }
});

test("SQ mechanism: TEMP shadow cannot replace the main singleton read", () => {
  const f = mechanism([], { database_instance_id: "wrong-main-source" });
  try {
    f.db.exec("CREATE TEMP TABLE storage_maintenance AS SELECT * FROM main.storage_maintenance");
    f.db.prepare("UPDATE temp.storage_maintenance SET database_instance_id=?").run(controlImage.database_instance_id);
    const image: Image = { id: "p" };
    assert.throws(() => f.run([expectedRow("projects", "insert", null, 1n, null, image)],
      () => insert(f.db, { table: "projects", rowid: 1n, values: image })), /BR_M2_PROFILE_FORMAT_BLOCKED/);
  } finally { f.db.close(); }
});

test("SQ mechanism: draining still requires the exact private cleanup row, never a broad table grant", () => {
  const before: Image = { id: "own-session", state: "connected" };
  const after: Image = { ...before, state: "disconnected" };
  const f = mechanism([{ table: "mcp_sessions", rowid: 1n, values: before }], { admission: "draining" });
  try {
    const expected = expectedRow("mcp_sessions", "update", 1n, 1n, before, after);
    f.run([expected], () => f.db.exec("UPDATE mcp_sessions SET state='disconnected' WHERE id='own-session'"));
    assert.throws(() => f.run([expected], () => f.db.exec("UPDATE mcp_sessions SET state='other' WHERE id='own-session'")), /BR_M2_PROFILE_ROW_BLOCKED/);
    assert.equal((f.db.prepare("SELECT state FROM mcp_sessions").get() as { state: string }).state, "disconnected");
  } finally { f.db.close(); }
});

test("SQ mechanism: NULL from either private validator rejects and a wrong callback arity fails", () => {
  const f = mechanism();
  const image: Image = { id: "p" };
  const expected = expectedRow("projects", "insert", null, 1n, null, image);
  try {
    f.db.function(SQLITE_PROFILE_UDF_ABI.row.name, SQLITE_PROFILE_UDF_ABI.row.options, (..._args: unknown[]) => null);
    assert.throws(() => f.run([expected], () => insert(f.db, { table: "projects", rowid: 1n, values: image })), /BR_M2_PROFILE_ROW_BLOCKED/);
    f.db.function(SQLITE_PROFILE_UDF_ABI.format.name, SQLITE_PROFILE_UDF_ABI.format.options,
      function (_t: unknown, _e: unknown, _m: unknown, _epoch: unknown, _g: unknown, _w: unknown) { return null; });
    assert.throws(() => f.run([expected], () => insert(f.db, { table: "projects", rowid: 1n, values: image })), /BR_M2_PROFILE_FORMAT_BLOCKED/);
    const wrongArity = new Database(":memory:");
    try {
      wrongArity.function(SQLITE_PROFILE_UDF_ABI.format.name, SQLITE_PROFILE_UDF_ABI.format.options, (..._args: unknown[]) => 1);
      assert.throws(() => wrongArity.prepare("SELECT br_m2_private_format_v1(1,2,3,4,5,6)").get(), /wrong number of arguments/);
    } finally { wrongArity.close(); }
  } finally { f.db.close(); }
});

test("SQ mechanism: every no-UPDATE rule rejects even a no-op before invoking private validators", () => {
  const blocked = SQLITE_PROFILE_TABLE_RULES.filter(row => row.operationEligibility.update.length === 0);
  const seeds = blocked.map(row => ({ table: row.table, rowid: 1n, values: Object.fromEntries(row.primaryKey.map(name =>
    [name, row.columns.find(column => column.name === name)!.type === "TEXT" ? "key" : 1n])) as Image }));
  const f = mechanism(seeds);
  try {
    for (const row of blocked) {
      assert.throws(() => f.run([], () => f.db.exec(`UPDATE ${quote(row.table)} SET ${quote(row.columns[0]!.name)}=${quote(row.columns[0]!.name)}`)),
        /BR_M2_PROFILE_OPERATION_BLOCKED/, row.table);
    }
    assert(blocked.some(row => row.table === "agent_runtimes"));
    assert(blocked.some(row => row.table === "schema_migrations"));
    assert.equal(f.observed.length, 0);
  } finally { f.db.close(); }
});

for (const [table, image, column, next] of [
  ["agent_profiles", { agent_id: "Identity", current_revision: 1n }, "agent_id", "identity"],
  ["agent_runner_states", { binding_id: "b", applied_json: '{"a":1}' }, "applied_json", '{ "a": 1 }'],
  ["agent_runner_states", { binding_id: "b", applied_json: '{"a":1}' }, "applied_json", Buffer.from('{"a":1}')],
  ["agent_runtime_bindings", { id: "b", attachment_state: "attached", overrides_json: "旧\0raw" }, "overrides_json", "旧\0RAW"],
  ["agent_runtime_members", { member_id: "m", runtime_id: "r" }, "runtime_id", "other"],
  ["storage_source_clients", { client_id: "c", build_id: "birth" }, "build_id", "changed"],
] as const) {
  test(`SQ mechanism: ${table}.${column} frozen value retains SQLite type and exact bytes (${typeof next})`, () => {
    const f = mechanism([{ table, rowid: 1n, values: image }]);
    const after: Image = { ...image, [column]: next };
    try {
      assert.throws(() => f.run([expectedRow(table, "update", 1n, 1n, image, after)],
        () => { f.db.prepare(`UPDATE ${quote(table)} SET ${quote(column)}=?`).run(next); },
        table === "storage_source_clients" ? "s4-control" : "business"), /BR_M2_PROFILE_FROZEN_CELL/);
      assert.equal(f.observed.length, 0);
    } finally { f.db.close(); }
  });
}

test("SQ mechanism: intent remains mutable while attachment is one-way and detached history cannot revive", () => {
  const before: Image = { id: "b", attachment_state: "attached", desired_state: "stopped", intent_revision: 2n, overrides_json: "raw" };
  const intent: Image = { ...before, desired_state: "running", intent_revision: 3n };
  const detached: Image = { ...intent, attachment_state: "detached", detach_config_snapshot_id: "d", detached_at: "t" };
  const f = mechanism([{ table: "agent_runtime_bindings", rowid: 1n, values: before }]);
  try {
    f.run([expectedRow("agent_runtime_bindings", "update", 1n, 1n, before, intent)],
      () => f.db.exec("UPDATE agent_runtime_bindings SET desired_state='running',intent_revision=3"));
    f.run([expectedRow("agent_runtime_bindings", "update", 1n, 1n, intent, detached)],
      () => f.db.exec("UPDATE agent_runtime_bindings SET attachment_state='detached',detach_config_snapshot_id='d',detached_at='t'"));
    assert.throws(() => f.run([expectedRow("agent_runtime_bindings", "update", 1n, 1n, detached, intent)],
      () => f.db.exec("UPDATE agent_runtime_bindings SET attachment_state='attached',detach_config_snapshot_id=NULL,detached_at=NULL")), /BR_M2_PROFILE_FROZEN_CELL/);
    assert.throws(() => f.run([], () => f.db.exec("UPDATE agent_runtime_bindings SET intent_revision=intent_revision")), /BR_M2_PROFILE_FROZEN_CELL/);
  } finally { f.db.close(); }
});

test("SQ mechanism: S4 control branch admits one terminal write, retains identity, and excludes business owner", () => {
  const before: Image = { ...controlImage, admission: "sealed", profile_takeover_terminal_json: null };
  const after: Image = { ...before, profile_takeover_terminal_json: "synthetic-terminal" };
  const f = mechanism([], before);
  try {
    const expected = expectedRow("storage_maintenance", "update", 1n, 1n, before, after);
    assert.throws(() => f.run([expected], () => f.db.exec("UPDATE storage_maintenance SET profile_takeover_terminal_json='synthetic-terminal'")), /BR_M2_PROFILE_FORMAT_BLOCKED/);
    f.run([expected], () => f.db.exec("UPDATE storage_maintenance SET profile_takeover_terminal_json='synthetic-terminal'"), "s4-control");
    for (const column of ["database_instance_id", "control_root_json", "mutex_identity_json", "profile_takeover_terminal_json"]) {
      assert.throws(() => f.run([expectedRow("storage_maintenance", "update", 1n, 1n, after, { ...after, [column]: "changed" })],
        () => f.db.exec(`UPDATE storage_maintenance SET ${quote(column)}='changed'`), "s4-control"), /BR_M2_PROFILE_FROZEN_CELL/);
    }
    assert.throws(() => f.run([], () => f.db.exec("DELETE FROM storage_maintenance"), "s4-control"), /BR_M2_PROFILE_OPERATION_BLOCKED/);
    assert.throws(() => f.run([], () => f.db.exec("INSERT INTO storage_maintenance(singleton) VALUES(2)"), "s4-control"), /BR_M2_PROFILE_OPERATION_BLOCKED/);
  } finally { f.db.close(); }
});

test("SQ mechanism: client observation uses the separate control owner; deletion never inherits it", () => {
  const before: Image = { client_id: "c", build_id: "birth", ended_at: null };
  const after: Image = { ...before, ended_at: "fixture-ended" };
  const f = mechanism([{ table: "storage_source_clients", rowid: 1n, values: before }]);
  try {
    const expected = expectedRow("storage_source_clients", "update", 1n, 1n, before, after);
    assert.throws(() => f.run([expected], () => f.db.exec("UPDATE storage_source_clients SET ended_at='fixture-ended'")), /BR_M2_PROFILE_FORMAT_BLOCKED/);
    f.run([expected], () => f.db.exec("UPDATE storage_source_clients SET ended_at='fixture-ended'"), "s4-control");
    assert.throws(() => f.run([], () => f.db.exec("DELETE FROM storage_source_clients"), "s4-control"), /BR_M2_PROFILE_OPERATION_BLOCKED/);
  } finally { f.db.close(); }
});

test("SQ mechanism: REPLACE implicit DELETE is checked and omitted closure rolls back the entire statement", () => {
  const before: Image = { id: "p", name: "old" };
  const after: Image = { id: "p", name: "replacement" };
  const f = mechanism([{ table: "projects", rowid: 9n, values: before }]);
  try {
    assert.equal(f.db.pragma("recursive_triggers", { simple: true }), 1n);
    assert.throws(() => f.run([expectedRow("projects", "insert", null, 10n, null, after)],
      () => f.db.exec("INSERT OR REPLACE INTO projects(rowid,id,name) VALUES(10,'p','replacement')")), /BR_M2_PROFILE_ROW_BLOCKED/);
    assert(f.observed.some(args => args[1] === "delete"));
    assert.deepEqual(f.db.prepare("SELECT rowid,name FROM projects").get(), { rowid: 9n, name: "old" });
  } finally { f.db.close(); }
});

test("SQ mechanism: preserved original message trigger requires the exact member-fact side effect", () => {
  const fact: Image = { member_id: "m", kind: "authored-messages", revision: 1n };
  const factAfter: Image = { ...fact, revision: 2n };
  const message: Image = { id: "msg", sender_member_id: "m", body: "hello" };
  const f = mechanism([
    { table: "members", rowid: 1n, values: { id: "m", removed_at: null, membership_revision: 1n } },
    { table: "member_fact_revisions", rowid: 11n, values: fact },
  ], {}, true);
  try {
    const primary = expectedRow("messages", "insert", null, 41n, null, message);
    const sideEffect = expectedRow("member_fact_revisions", "update", 11n, 11n, fact, factAfter);
    assert.throws(() => f.run([primary], () => insert(f.db, { table: "messages", rowid: 41n, values: message })), /BR_M2_PROFILE_ROW_BLOCKED/);
    assert.equal((f.db.prepare("SELECT count(*) n FROM messages").get() as { n: bigint }).n, 0n);
    assert.equal((f.db.prepare("SELECT revision FROM member_fact_revisions").get() as { revision: bigint }).revision, 1n);
    f.run([primary, sideEffect], () => insert(f.db, { table: "messages", rowid: 41n, values: message }));
    assert.equal((f.db.prepare("SELECT revision FROM member_fact_revisions").get() as { revision: bigint }).revision, 2n);
    assert.equal((f.db.prepare("SELECT count(*) n FROM messages").get() as { n: bigint }).n, 1n);
  } finally { f.db.close(); }
});

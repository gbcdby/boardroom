import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DbReadSnapshot, DbRow } from "../src/server/db/driver.ts";
import { readLegacyConfigCapture, sameLegacyConfigCapture } from "../src/server/identity/legacy-config-capture.ts";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "../src/server/identity/legacy-config-inspection.ts";
import { parseLegacySourceValue } from "../src/server/identity/m2-config-values.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

const queries = [
  "SELECT * FROM agents ORDER BY id", "SELECT * FROM agent_runtimes ORDER BY id",
  "SELECT * FROM agent_runtime_bindings ORDER BY id", "SELECT * FROM agent_runner_states ORDER BY binding_id",
  "SELECT * FROM agent_runtime_members ORDER BY member_id", "SELECT * FROM members ORDER BY id",
  "SELECT * FROM projects ORDER BY id", "SELECT * FROM groups ORDER BY id",
  "SELECT * FROM group_participants ORDER BY group_id, member_id",
  "SELECT version FROM schema_migrations WHERE version = 14",
  "SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type, agent_id, created_at, retired_at",
];

test("E1 capture 固定十组读取与原摘要；alias 未迁移不访问不存在的表，原查询异常不重试", async () => {
  for (const persistedAliases of [true, false]) {
    const calls: string[] = [];
    const reader: DbReadSnapshot = { async query<T extends DbRow>(sql: string): Promise<T[]> {
      calls.push(sql);
      if (sql === queries[9]) return (persistedAliases ? [{ version: 14 }] : []) as unknown as T[];
      assert.ok(queries.includes(sql), "没有可扩展的调用者表名或 SQL");
      return (sql === queries[0] ? [{ id: "a", raw: ' { "b": 2, "a": 1 }\n' }] : []) as unknown as T[];
    } };
    const capture = await readLegacyConfigCapture(reader);
    assert.deepEqual(calls, persistedAliases ? queries : queries.slice(0, 10));
    assert.equal(capture.persistedAliases, persistedAliases);
    assert.equal(Object.keys(capture.rows).length, 10);
    assert.equal(capture.rows.agents[0]!["raw"], ' { "b": 2, "a": 1 }\n');
    // 独立固定字节 oracle：只排序对象键，原 raw JSON 字符串保持字节；不是新持久格式。
    const originalCanonical = '{"agent_legacy_aliases":[],"agent_runner_states":[],"agent_runtime_bindings":[],"agent_runtime_members":[],"agent_runtimes":[],"agents":[{"id":"a","raw":" { \\"b\\": 2, \\"a\\": 1 }\\n"}],"group_participants":[],"groups":[],"members":[],"projects":[]}';
    assert.equal(capture.sourceDigest, createHash("sha256").update(originalCanonical).digest("hex"));
    assert.equal(sameLegacyConfigCapture(capture, structuredClone(capture)), true);
    for (const table of Object.keys(capture.rows) as (keyof typeof capture.rows)[]) {
      const changed = structuredClone(capture);
      changed.rows[table] = [{ extra_imported_column: "changed" }];
      assert.equal(sameLegacyConfigCapture(capture, changed), false, `${table} 的任意原列变化不得靠旧 digest 混过`);
    }
    assert.equal(sameLegacyConfigCapture(capture, { ...capture, persistedAliases: !persistedAliases }), false);
  }
  const failure = new Error("original capture query failed"); let calls = 0;
  await assert.rejects(readLegacyConfigCapture({ async query() { calls++; throw failure; } }), error => error === failure);
  assert.equal(calls, 1);
});

for (const engine of identityEngines) test(`${engine} E1 原 public inspector 复用真实非空捕获，保留只读快照与嵌套拒绝`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine);
  try {
    const project = await f.repos.projects.create({ name: "E1 原项目" });
    const group = await f.repos.groups.create({ projectId: project.id, name: "E1 原群" });
    const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
    const created = await runtimes.create({ name: "E1 原身份", backend: "claude-code", defaults: { workdir: f.dir }, bindings: [{ projectId: project.id, groupId: group.id }] });
    const bindingId = created.bindings[0]!.binding.id;
    await runtimes.intent(bindingId, "start");
    const view = (await runtimes.getBinding(bindingId))!;
    const rawJson = JSON.stringify(view.binding.requestedSnapshot, null, 2) + "\n";
    await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [rawJson, bindingId]);
    const read = () => f.db.readSnapshot(readLegacyConfigCapture);
    const before = await read();
    const migrations = await f.db.migrationState();
    const inspector = createLegacyConfigInspector({ db: f.db, repos: f.repos });
    const report = await inspector.preflight();
    assert.equal(report.sourceDigest, before.sourceDigest);
    assert.equal(report.bindings[0]!.raw.requestedSnapshotJson, rawJson);
    assert.equal(report.readOnly, true); assert.equal(report.migrated, false); assert.equal(report.authority, "legacy");
    const binding = report.bindings[0]!;
    const selected = selectLegacyConfigSnapshot(binding);
    assert.equal(selected.configSnapshotRef?.kind, "requestedSnapshot");
    assert.equal(selected.activationAllowed, false);
    for (const source of Object.values(binding.snapshots)) if (source) {
      const advanced = binding.raw.advancedJson;
      const parsed = parseLegacySourceValue({ ref: source.ref, snapshot: source.snapshot, rawJson: source.rawJson, rawDigest: source.rawDigest,
        rawAdvancedJson: advanced, rawAdvancedDigest: advanced === null ? null : createHash("sha256").update(advanced).digest("hex") });
      assert.deepEqual(parsed.ref, source.ref); assert.deepEqual(parsed.snapshot, source.snapshot);
      assert.equal(parsed.rawJson, source.rawJson);
    }
    await f.db.transaction(async () => {
      await assert.rejects(inspector.preflight(), { message: "legacy_inspection_requires_own_snapshot" });
    });
    assert.equal(sameLegacyConfigCapture(before, await read()), true);
    assert.deepEqual(await f.db.migrationState(), migrations);
    await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [JSON.stringify(view.binding.requestedSnapshot), bindingId]);
    const changed = await read();
    assert.equal(sameLegacyConfigCapture(before, changed), false, "语义等价但原 bytes 不同仍是捕获变化");
    assert.notEqual(before.sourceDigest, changed.sourceDigest);
    assert.deepEqual((await runtimes.getBinding(bindingId))!.binding.requestedSnapshot, view.binding.requestedSnapshot);
  } finally { await f.close(); }
});

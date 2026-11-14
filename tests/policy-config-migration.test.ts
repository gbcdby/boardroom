import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { migrations } from "../src/server/db/migrations/index.ts";
import { policyConfigurationMigration } from "../src/server/db/migrations/policy-configuration.ts";
import { appendAuditEntry } from "../src/server/audit.ts";
import { createIdentityCatalog } from "../src/server/identity/catalog.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { initializePolicyConfiguration } from "../src/server/policy/configuration.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import { policyCompatibilityV16 } from "./fixtures/policy-task-intake-v16.ts";

const at = "2026-11-11T00:00:00.000Z";
function migrationsThrough16() {
  const actual = migrations.find(migration => migration.version === 16);
  if (actual) {
    assert.equal(actual.name, policyCompatibilityV16.name);
    assert.equal(actual.up, policyCompatibilityV16.up, "真实合成后仍核对固定 v16；不重复注册版本");
    assert.equal(actual.upPostgres, policyCompatibilityV16.upPostgres);
  }
  return [...migrations.filter(migration => migration.version <= 15), actual ?? policyCompatibilityV16];
}

for (const engine of identityEngines) {
  for (const inputVersion of [15, 16] as const) {
    test(`${engine} S1 v${inputVersion}非空→v17：旧身份/任务/评审/工作区/审计及checksum不变，迁移不seed`, { skip: identitySkip(engine) }, async () => {
      const f = await identityFixture(engine, 15);
      try {
        const p = await f.repos.projects.create({ name: "历史项目" });
        const a = await f.repos.agents.create({ displayName: "历史身份", hostType: "other" });
        const m = await f.repos.members.create({ projectId: p.id, kind: "agent", agentId: a.id, displayName: a.displayName });
        const g = await f.repos.groups.create({ projectId: p.id, name: "历史群", participantMemberIds: [m.id] });
        await f.repos.messages.create({ groupId: g.id, senderMemberId: m.id, body: "原消息", mentions: [] });
        await createIdentityCatalog({ repos: f.repos }).roles.create({ actor: ownerActor() }, { name: "历史角色", purpose: "原职责", instructions: "原指令", recommendedSkillRefs: [] });
        await f.db.exec(`INSERT INTO project_workspace_versions (project_id, workspace_revision, project_revision, mode, observed_at, mutation_id, input_digest, updated_at)
          VALUES (?, 1, 2, 'isolated', ?, 'old-workspace', ?, ?)`, [p.id, at, "a".repeat(64), at]);
        await f.db.exec("UPDATE projects SET project_revision = 2, workspace_revision = 1 WHERE id = ?", [p.id]);
        await f.db.exec(`INSERT INTO tasks (id, project_id, title, body, labels, state, revision, author, created_at, updated_at)
          VALUES ('old-task', ?, '原任务', '原验收内容', '[]', 'review', 4, '{}', ?, ?)`, [p.id, at, at]);
        await f.db.exec(`INSERT INTO task_review_rounds (id, task_id, project_id, revision, task_revision, state, reviewer_member_id, spec_snapshot, candidate, created_at, updated_at)
          VALUES ('old-round', 'old-task', ?, 2, 4, 'reported', ?, '{"original":true}', '{"tree":"original"}', ?, ?)`, [p.id, m.id, at, at]);
        await f.db.exec(`INSERT INTO task_review_reports (id, round_id, task_id, project_id, axis, verdict, body, sources, evidence, content_sha256, author, created_at)
          VALUES ('old-report', 'old-round', 'old-task', ?, 'spec', 'pass', '原评审', '[]', '[]', ?, '{}', ?)`, [p.id, "b".repeat(64), at]);
        const audit = await appendAuditEntry(f.repos.audit, { projectId: p.id, actor: { kind: "human", memberId: null, name: "历史用户" },
          action: "org.node_update", targetKind: "node", targetId: "old-node", targetName: "原岗位", before: { name: "旧" }, after: { name: "新" }, detail: { original: true } });
        await f.repos.audit.markReversed(p.id, audit.id, "original-reversal", at);
        // 每一路从真实 v15 非空输入出发；16 路实际执行三列新增及 body 回填，绝非只写版本元数据。
        const inputs = inputVersion === 16 ? migrationsThrough16() : migrations.filter(migration => migration.version <= 15);
        if (inputVersion === 16) {
          await f.db.migrate(inputs);
          const task = (await f.db.query("SELECT * FROM tasks WHERE id = 'old-task'"))[0]!;
          assert.equal(task.delivery_kind, "code"); assert.equal(task.acceptance_text, "原验收内容"); assert.equal(task.acceptance_source, "legacy_task_body");
        }
        assert.deepEqual((await f.db.migrationState()).applied.map(row => row.version), inputs.map(row => row.version));
        const tables = ["agents", "agent_legacy_aliases", "role_templates", "role_template_versions", "projects", "project_workspace_versions",
          "groups", "members", "member_fact_revisions", "messages", "tasks", "task_review_rounds", "task_review_reports", "audit_log"];
        const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
        const checksums = (await f.db.migrationState()).applied;
        const upgrade = [...inputs, policyConfigurationMigration];
        assert.equal((await f.db.migrate(upgrade)).version, 17);
        assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`))), before);
        assert.deepEqual((await f.db.migrationState()).applied.slice(0, inputVersion), checksums);
        assert.deepEqual(await f.db.query("SELECT * FROM policy_documents"), []);
        assert.deepEqual(await f.db.query("SELECT * FROM policy_document_versions"), []);
        const indexQuery = engine === "sqlite" ? "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'"
          : "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_log'";
        const indexes = (await f.db.query<{ name: string }>(indexQuery)).map(row => row.name);
        for (const name of ["ix_audit_project_created", "ix_audit_project_target", "ix_audit_project_action", "ix_audit_user_created"]) assert.ok(indexes.includes(name));
        await assert.rejects(f.db.exec(`INSERT INTO audit_log (id, scope, project_id, actor_kind, actor_name, action, target_kind, target_id, target_name, created_at)
          VALUES ('bad-scope', 'user', ?, 'human', '人', 'policy.update', 'policy_document', 'user', '全局', ?)`, [p.id, at]));
        await assert.rejects(f.db.exec(`INSERT INTO policy_documents (scope_key, scope, project_id, revision, created_at, updated_at)
          VALUES ('bad', 'user', NULL, 1, ?, ?)`, [at, at]));
        assert.equal((await f.db.migrate(upgrade)).applied.length, 0);
        const initialized = await initializePolicyConfiguration(f.repos);
        assert.equal(initialized.createdBy.kind, "system");
        assert.equal((await f.db.query("SELECT * FROM audit_log WHERE action = 'policy.initialize'")).length, 1);
        assert.deepEqual(await f.db.query("SELECT * FROM audit_log WHERE action <> 'policy.initialize' ORDER BY 1, 2"), before.at(-1));
      } finally { await f.close(); }
    });
  }
  test(`${engine} S1 v17升级原子失败：新表与审计重建同时回滚，旧版本/数据继续可读`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 15);
    try {
      await appendAuditEntry(f.repos.audit, { scope: "user", projectId: null, actor: { kind: "human", name: "人" },
        action: "agent.rename", targetKind: "agent", targetId: "original", targetName: "原身份", after: { original: true } });
      const before = await f.db.query("SELECT * FROM audit_log"), state = await f.db.migrationState();
      const broken = { ...policyConfigurationMigration, up: `${policyConfigurationMigration.up}\nINSERT INTO policy_documents (scope_key) VALUES ('force_constraint_failure');` };
      await assert.rejects(f.db.migrate([...migrations.filter(migration => migration.version <= 15), broken]));
      assert.deepEqual(await f.db.migrationState(), state); assert.deepEqual(await f.db.query("SELECT * FROM audit_log"), before);
      await assert.rejects(f.db.query("SELECT * FROM policy_documents"));
      await f.db.migrate([...migrations.filter(migration => migration.version <= 15), policyConfigurationMigration]);
      assert.deepEqual(await f.db.query("SELECT * FROM audit_log"), before);
    } finally { await f.close(); }
  });
}

test("S1 v16兼容输入来源校验：固定真实DDL字节，生产有16时不重复添加", () => {
  assert.equal(createHash("sha256").update(policyCompatibilityV16.up).digest("hex"), "be002cb0d7fc02d652f18d6fb81ffc7a5ea86b5f765e7112bc743cf7b7f72e25");
  const selected = migrationsThrough16();
  assert.equal(selected.filter(migration => migration.version === 16).length, 1);
});

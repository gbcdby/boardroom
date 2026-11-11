import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { appendAuditEntry } from "../src/server/audit.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} S2 v13→v14 非空升级保留全部旧身份/引用/快照/审计，并建立不可重分配 alias`, {
    skip: engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；由数据库 CI 门控执行" : false,
  }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "boardroom-identity-migration-"));
    const schema = `identity_migration_${randomUUID().replaceAll("-", "")}`;
    const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir }
      : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
    try {
      await db.connect();
      await db.migrate(migrations.filter(m => m.version <= 13));
      const repos = createRepositories(db), runtimes = createRuntimeRepository(db, { repos });
      const project = await repos.projects.create({ name: "历史项目" });
      const group = await repos.groups.create({ projectId: project.id, name: "历史群" });
      const created = await runtimes.create({ name: "原身份", backend: "claude-code", defaults: { workdir: dir, model: "old" },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      const binding = created.bindings[0]!.binding;
      await runtimes.intent(binding.id, "start");
      const fence = await runtimes.claim(binding.id, "historical-owner");
      await runtimes.setSession(fence, "original-session-id");
      await runtimes.markExit(fence, { exitCode: 0 });
      await runtimes.updateDefaults(created.runtime.id, 1, { workdir: dir, model: "pending" });
      await runtimes.intent(binding.id, "apply");
      const agent = await repos.agents.create({ displayName: "外部身份", hostType: "codex-cli" });
      const member = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "外部身份" });
      await repos.groups.addParticipant(group.id, member.id);
      await repos.messages.create({ groupId: group.id, senderMemberId: member.id, body: "不可丢失的历史", mentions: [] });
      await repos.mcpSessions.connect({ agentId: agent.id, projectId: project.id, groupId: group.id, memberId: member.id,
        displayName: agent.displayName, hostType: agent.hostType });
      const audit = await appendAuditEntry(repos.audit, { projectId: project.id, actor: { kind: "human", name: "人" },
        action: "org.node_update", targetKind: "node", targetId: "historical-node", targetName: "历史岗位",
        before: { name: "前" }, after: { name: "后" }, detail: { evidence: "原审计" } });
      await repos.audit.markReversed(project.id, audit.id, "original-reversal", "2026-11-11T00:00:00.000Z");
      const tables = ["agents", "projects", "groups", "members", "group_participants", "messages", "mcp_sessions",
        "member_fact_revisions", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members"];
      const snapshots = new Map<string, unknown>();
      for (const table of tables) snapshots.set(table, await db.query(`SELECT * FROM ${table} ORDER BY 1, 2`));
      const oldAudit = await db.query("SELECT * FROM audit_log ORDER BY id");
      const oldMigrations = (await db.migrationState()).applied;
      assert.equal((await db.migrate(migrations)).version, 14);
      for (const table of tables) assert.deepEqual(await db.query(`SELECT * FROM ${table} ORDER BY 1, 2`), snapshots.get(table), table);
      const upgradedAudit = await db.query("SELECT * FROM audit_log ORDER BY id");
      assert.deepEqual(upgradedAudit.map(({ scope, ...row }) => { assert.equal(scope, "project"); return row; }), oldAudit);
      assert.deepEqual((await db.migrationState()).applied.slice(0, 13), oldMigrations);
      const aliases = await db.query("SELECT display_name, host_type, agent_id, retired_at FROM agent_legacy_aliases ORDER BY agent_id");
      const agents = await repos.agents.list();
      assert.deepEqual(aliases, [...agents].sort((a, b) => a.id.localeCompare(b.id)).map(a => ({ display_name: a.displayName,
        host_type: a.hostType, agent_id: a.id, retired_at: null })));
      await assert.rejects(db.exec("INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at) VALUES (?, ?, ?, ?)",
        ["原身份", "claude-code", agent.id, new Date().toISOString()]));
      await db.exec(`INSERT INTO audit_log (id, scope, project_id, actor_kind, actor_name, action, target_kind, target_id, target_name, created_at)
        VALUES (?, 'user', NULL, 'human', '本地用户', 'role_template.create', 'role_template', 'role-1', '负责人', ?)`, ["user-audit", new Date().toISOString()]);
      assert.equal((await repos.projects.list()).length, 1, "user scope 不创建伪项目");
      await assert.rejects(db.exec(`INSERT INTO audit_log (id, scope, project_id, actor_kind, actor_name, action, target_kind, target_id, target_name, created_at)
        VALUES ('invalid-scope', 'user', ?, 'human', '人', 'agent.rename', 'agent', ?, '错误范围', ?)`, [project.id, agent.id, new Date().toISOString()]));
      const indexSql = engine === "sqlite" ? "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'"
        : "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_log'";
      const indexes = (await db.query<{ name: string }>(indexSql)).map(row => row.name);
      for (const name of ["ix_audit_project_created", "ix_audit_project_target", "ix_audit_project_action", "ix_audit_user_created"]) assert.ok(indexes.includes(name), name);
      assert.equal((await db.migrate(migrations)).applied.length, 0);
    } finally {
      await db.close();
      if (engine === "postgres") {
        const admin = new Client({ connectionString: pgUrl }); await admin.connect();
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../../src/server/db/driver.ts";
import { checksumOf, migrationSql } from "../../src/server/db/migrate.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { createRepositories } from "../../src/server/db/repositories.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const skip = (engine: "sqlite" | "postgres") => engine === "postgres" && !pgUrl
  ? "未配置真实 PostgreSQL；由数据库 CI 门控执行" : false;

async function tableExists(db: DbDriver, engine: "sqlite" | "postgres", name: string): Promise<boolean> {
  const rows = engine === "sqlite"
    ? await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
    : await db.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?", [name]);
  return rows.length > 0;
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} v22 受控夹具回钉 v21，全量升级到 v23：旧数据/旧 checksum 不变，只新增核心配置表`, { skip: skip(engine) }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "profile-config-v22-"));
    const schema = `pcfg_v22_${randomUUID().replaceAll("-", "")}`;
    const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir }
      : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
    try {
      await db.connect();
      await db.migrate(migrations.filter(m => m.version <= 21));
      const repos = createRepositories(db);
      const agent = await repos.agents.create({ displayName: "旧身份", hostType: "claude-code" });
      const project = await repos.projects.create({ name: "历史项目" });
      const group = await repos.groups.create({ projectId: project.id, name: "历史群" });
      const member = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "旧成员" });
      await repos.groups.addParticipant(group.id, member.id);
      await repos.messages.create({ groupId: group.id, senderMemberId: member.id, body: "不可丢失的历史消息", mentions: [] });
      const before = {
        agents: await db.query("SELECT * FROM agents ORDER BY 1"),
        messages: await db.query("SELECT * FROM messages ORDER BY 1"),
        migrations: (await db.migrationState()).applied,
      };
      assert.equal((await tableExists(db, engine, "config_authority")), false);

      const result = await db.migrate(migrations);
      assert.equal(result.version, 23);
      assert.deepEqual(result.applied.map(m => m.version), [22, 23]);
      assert.deepEqual(await db.query("SELECT * FROM agents ORDER BY 1"), before.agents);
      assert.deepEqual(await db.query("SELECT * FROM messages ORDER BY 1"), before.messages);
      const after = (await db.migrationState()).applied;
      assert.deepEqual(after.filter(row => row.version <= 21), before.migrations);
      for (const migration of migrations.filter(m => m.version <= 21)) {
        const row = after.find(entry => entry.version === migration.version)!;
        assert.equal(row.checksum, checksumOf(migrationSql(migration, engine)), `v${migration.version} checksum 不变`);
      }
      for (const name of ["agent_profiles", "agent_profile_versions", "group_bindings",
        "group_binding_config_versions", "config_compat_revisions", "config_mutation_receipts",
        "config_mutation_audit"]) assert.equal(await tableExists(db, engine, name), true, name);
      assert.equal(await tableExists(db, engine, "config_authority"), false, "未切换配置权威");
      assert.deepEqual((await db.migrate(migrations)).applied, [], "重复迁移幂等");

      const at = new Date().toISOString();
      await db.transaction(async tx => {
        await tx.exec(`INSERT INTO agent_profiles (agent_id, current_revision, created_at, updated_at)
          VALUES (?, 1, ?, ?)`, [agent.id, at, at]);
        await tx.exec(`INSERT INTO agent_profile_versions (agent_id, revision, content_json, content_digest, created_at)
          VALUES (?, 1, '{}', ?, ?)`, [agent.id, "a".repeat(64), at]);
      });
      await assert.rejects(db.exec("UPDATE agent_profile_versions SET content_json = '{}' WHERE agent_id = ?", [agent.id]));
      await assert.rejects(db.exec("DELETE FROM agent_profile_versions WHERE agent_id = ?", [agent.id]));
    } finally {
      await db.close();
      if (engine === "postgres") {
        const admin = new Client({ connectionString: pgUrl });
        await admin.connect();
        try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}

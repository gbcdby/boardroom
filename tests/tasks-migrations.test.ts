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
import { appendAuditEntry } from "../src/server/audit.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
for (const engine of ["sqlite", "postgres"] as const) {
test(`${engine} v10 升级 v11 保留审计快照/撤销字段/索引，并允许 task 目标`, { skip: engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；由既有 CI 门控执行" : false }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-task-migration-"));
  const schema = `tasks_migration_${randomUUID().replaceAll("-", "")}`;
  const driver = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try {
    await driver.connect();
    await driver.migrate(migrations.filter(migration => migration.version <= 10));
    const repos = createRepositories(driver);
    const project = await repos.projects.create({ name: "旧库计数" });
    const group = await repos.groups.create({ projectId: project.id, name: "旧群" });
    assert.equal((await repos.groups.previewPurge(group.id)).taskMessageLinks, 0);
    const oldCounts = await repos.projects.previewPurge(project.id);
    for (const key of ["taskSettings", "tasks", "taskComments", "taskHistory", "taskMessageLinks", "reviewRounds", "reviewReports", "workEvents"] as const) assert.equal(oldCounts[key], 0);
    assert.deepEqual(await repos.projects.purge(project.id), oldCounts);
    const old = await appendAuditEntry(repos.audit, {
      projectId: "deleted-project", actor: { kind: "human", name: "人" }, action: "org.node_update",
      targetKind: "node", targetId: "node", targetName: "旧岗位", before: { name: "旧岗位" }, after: { name: "新岗位" }, detail: { key: "保留" },
    });
    await repos.audit.markReversed("deleted-project", old.id, "compensation", "2026-11-10T00:00:00.000Z");
    const before = await repos.audit.get("deleted-project", old.id);
    const appliedBefore = (await driver.migrationState()).applied;
    const taskMigrations = migrations.filter(migration => migration.version <= 11);
    const result = await driver.migrate(taskMigrations);
    assert.equal(result.version, 11);
    assert.deepEqual(await repos.audit.get("deleted-project", old.id), before);
    assert.deepEqual((await driver.migrationState()).applied.slice(0, 10), appliedBefore);
    const indexQuery = engine === "sqlite" ? "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'" : "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_log'";
    const indexes = (await driver.query<{ name: string }>(indexQuery))
      .map(row => row.name);
    for (const name of ["ix_audit_project_created", "ix_audit_project_target", "ix_audit_project_action"]) assert.ok(indexes.includes(name));
    const row = await appendAuditEntry(repos.audit, {
      projectId: "deleted-project", actor: { kind: "human", name: "人" }, action: "task.created",
      targetKind: "task", targetId: "task", targetName: "任务", after: { title: "任务" },
    });
    assert.equal((await repos.audit.get("deleted-project", row.id))?.targetKind, "task");
    assert.equal((await driver.migrate(taskMigrations)).applied.length, 0);
  } finally {
    await driver.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl });
      await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
}

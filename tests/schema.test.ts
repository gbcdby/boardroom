import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../src/server/db/database.ts";
import { readMigrationState, runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

/** F2 领域表清单（不含迁移版本表）。 */
const DOMAIN_TABLES = [
  "agents",
  "projects",
  "members",
  "groups",
  "group_participants",
  "messages",
  "message_deliveries",
  "member_statuses",
  "mcp_sessions",
] as const;

/** 期望的最高迁移版本（F2 v1 + T2 v2 + T1 #48 v3 归档标记）。 */
const EXPECTED_VERSION = 3;

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-schema-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

test("空库执行生产迁移后建立全部领域表", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      const result = runMigrations(db, migrations);
      assert.equal(result.version, EXPECTED_VERSION);
      assert.equal(result.applied.length, EXPECTED_VERSION);

      const created = tables(db);
      for (const table of DOMAIN_TABLES) {
        assert.ok(created.includes(table), `缺少表 ${table}`);
      }
      assert.ok(created.includes("schema_migrations"));
    } finally {
      db.close();
    }
  });
});

test("重复执行生产迁移是幂等的", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      runMigrations(db, migrations);
      const second = runMigrations(db, migrations);
      assert.deepEqual(second.applied, []);
      assert.equal(second.version, EXPECTED_VERSION);
      assert.equal(readMigrationState(db).applied.length, EXPECTED_VERSION);
    } finally {
      db.close();
    }
  });
});

test("领域表上存在预期的索引与唯一约束", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      runMigrations(db, migrations);

      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((row) => row.name);

      // 每项目最多一个 manager：部分唯一索引。
      assert.ok(indexes.includes("ux_members_project_manager"), "缺少 manager 唯一索引");
      // 消息按群组 + 时间稳定排序。
      assert.ok(indexes.includes("ix_messages_group_seq"), "缺少消息群组序号索引");
      // 投递按 (message, member) 唯一去重。
      assert.ok(indexes.includes("ux_deliveries_message_member"), "缺少投递去重唯一索引");
      // 状态按 (project, member) 唯一。
      assert.ok(indexes.includes("ux_member_statuses_scope"), "缺少状态作用域唯一索引");
      // T2：Agent 全局身份唯一、MCP 活跃会话唯一。
      assert.ok(indexes.includes("ux_agents_identity"), "缺少 Agent 身份唯一索引");
      assert.ok(indexes.includes("ux_mcp_sessions_active"), "缺少 MCP 活跃会话唯一索引");
      // T1 #48：归档标记的列表索引（默认只取未归档行）。
      assert.ok(indexes.includes("ix_projects_archived"), "缺少项目归档列表索引");
      assert.ok(indexes.includes("ix_groups_project_archived"), "缺少群组项目+归档列表索引");
    } finally {
      db.close();
    }
  });
});

test("外键约束开启时拒绝悬空引用", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      runMigrations(db, migrations);
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO members (id, project_id, kind, display_name, role, created_at, updated_at) VALUES (?, ?, 'human', ?, 'normal', ?, ?)")
            .run("m1", "no-such-project", "幽灵成员", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });
});

test("阶段 1 已有库（v2）升级到 v3：补上归档列且旧数据不丢（#48 回滚/升级路径）", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      // 1) 先只跑到 v2，模拟用户手上已有的阶段 1 数据库
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 2),
      );
      assert.equal(readMigrationState(db).version, 2);
      const T = "2026-01-01T00:00:00.000Z";
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "p-old",
        "老项目",
        T,
        T,
      );
      db.prepare("INSERT INTO groups (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "g-old",
        "p-old",
        "老群组",
        T,
        T,
      );

      // 2) 再跑当前迁移列表：只追加 v3，已有行保留、归档列初值为 NULL
      const result = runMigrations(db, migrations);
      assert.deepEqual(
        result.applied.map((m) => m.version),
        [3],
      );
      assert.equal(result.version, EXPECTED_VERSION);
      assert.equal(
        (db.prepare("SELECT archived_at FROM projects WHERE id = ?").get("p-old") as { archived_at: string | null })
          .archived_at,
        null,
        "升级后老项目应为未归档",
      );
      assert.equal(
        (db.prepare("SELECT archived_at FROM groups WHERE id = ?").get("g-old") as { archived_at: string | null })
          .archived_at,
        null,
        "升级后老群组应为未归档",
      );

      // 3) 归档标记在升级后的库上可用（列表默认只取未归档行）
      db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(T, "p-old");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE archived_at IS NULL").get() as { c: number }).c,
        0,
      );

      // 4) 幂等：重复执行不再应用任何迁移
      assert.deepEqual(runMigrations(db, migrations).applied, []);
    } finally {
      db.close();
    }
  });
});

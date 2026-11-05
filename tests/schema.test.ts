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
  // T2 #49：组织树岗位节点（决策票 #24：成员「占据」节点，汇报线 = parent_id）。
  "org_nodes",
] as const;

/** 期望的最高迁移版本（F2 v1 + T2 #15 v2 + T1 #48 v3 归档 + T2 #49 v4 组织树 + T3 #50 v5 成员状态）。 */
const EXPECTED_VERSION = 5;

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

      // T2 #49：阶段 1 的「每项目至多一个 manager」部分唯一索引按决策票 #24 移除，
      // 顶层 manager 唯一性改由组织树根节点唯一（ux_org_nodes_single_root）表达；
      // 阶段 1 兼容语义（legacy members.role='manager' 唯一）下沉到 repository 应用层校验。
      assert.ok(!indexes.includes("ux_members_project_manager"), "旧 manager 唯一索引应已被 v4 移除");
      assert.ok(indexes.includes("ux_org_nodes_single_root"), "缺少组织树根节点唯一索引");
      assert.ok(indexes.includes("ux_members_node"), "缺少成员占岗唯一索引（一人一岗、一岗一实例）");
      assert.ok(indexes.includes("ix_org_nodes_project"), "缺少组织节点项目索引");
      assert.ok(indexes.includes("ix_org_nodes_parent"), "缺少组织节点父指针索引（子树递归查询用）");
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
      // T3 #50：成员生命周期状态的项目内列表索引（默认 active，老库升级后同样生效）。
      assert.ok(indexes.includes("ix_members_project_status"), "缺少成员项目+状态索引");
      // 成员状态列存在，且 CHECK 约束把取值收敛在 active/disabled/pending。
      const memberColumns = (
        db.prepare("PRAGMA table_info(members)").all() as { name: string; dflt_value: string | null }[]
      );
      const statusColumn = memberColumns.find((c) => c.name === "status");
      assert.ok(statusColumn, "v5 应为 members 增加 status 列");
      assert.equal(statusColumn?.dflt_value, "'active'", "老库行与新行的 status 默认应为 active");
      const T = "2026-01-01T00:00:00.000Z";
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "p-chk",
        "校验项目",
        T,
        T,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO members (id, project_id, kind, display_name, role, status, created_at, updated_at) VALUES (?, ?, 'human', ?, 'normal', 'bogus', ?, ?)",
            )
            .run("m-chk", "p-chk", "坏状态", T, T),
        /CHECK/i,
      );
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

test("阶段 1 已有库（v2）升级到当前版本：补上归档列与组织树结构且旧数据不丢（#48/#49 升级路径）", async () => {
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

      // 2) 再跑当前迁移列表：只追加 v3、v4、v5，已有行保留、归档列初值为 NULL
      const result = runMigrations(db, migrations);
      assert.deepEqual(
        result.applied.map((m) => m.version),
        [3, 4, 5],
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

test("v3 库升级到当前版本（v4 组织树 + v5 成员状态）：旧数据不回填、兼容映射与默认 active 继续可用（#49/#50 升级路径）", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      // 1) 跑到 v3（阶段 2 T1 #48 之后的现有库形态），并留下阶段 1 语义的旧数据。
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 3),
      );
      const T = "2026-01-01T00:00:00.000Z";
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("p-old", "老项目", T, T);
      db
        .prepare("INSERT INTO agents (id, display_name, host_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("a-old", "老经理", "claude-code", T, T);
      db
        .prepare("INSERT INTO members (id, project_id, agent_id, kind, display_name, role, created_at, updated_at) VALUES (?, ?, ?, 'agent', ?, 'manager', ?, ?)")
        .run("m-mgr", "p-old", "a-old", "老经理", T, T);
      db
        .prepare("INSERT INTO members (id, project_id, kind, display_name, role, created_at, updated_at) VALUES (?, ?, 'human', ?, 'normal', ?, ?)")
        .run("m-nrm", "p-old", "老成员", T, T);

      // 2) 执行当前迁移：只追加 v4（组织树）与 v5（成员状态）。
      const result = runMigrations(db, migrations);
      assert.deepEqual(
        result.applied.map((m) => m.version),
        [4, 5],
      );
      assert.equal(result.version, EXPECTED_VERSION);

      // 3) v4 **不回填**组织树：升级后的库默认无组织数据（票面硬约束——
      //    resolveActor 的阶段 1 兼容映射在升级路径上继续工作）。
      assert.equal((db.prepare("SELECT COUNT(*) AS c FROM org_nodes").get() as { c: number }).c, 0);
      assert.equal(
        (db.prepare("SELECT node_id FROM members WHERE id = ?").get("m-mgr") as { node_id: string | null }).node_id,
        null,
      );
      assert.equal(
        (db.prepare("SELECT role FROM members WHERE id = ?").get("m-mgr") as { role: string }).role,
        "manager",
        "旧成员的兼容角色字段必须原样保留",
      );
      // T3 #50：v5 只加列、默认 active；老成员未改状态即为 active，阶段 1 行为不变。
      assert.equal(
        (db.prepare("SELECT status FROM members WHERE id = ?").get("m-mgr") as { status: string }).status,
        "active",
      );
      assert.equal(
        (db.prepare("SELECT status FROM members WHERE id = ?").get("m-nrm") as { status: string }).status,
        "active",
      );

      // 4) 旧「每项目至多一个 manager」唯一索引已按 #24 移除（多层树与它冲突）。
      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.ok(!indexes.includes("ux_members_project_manager"), "v4 应移除旧 manager 唯一索引");
      assert.ok(indexes.includes("ux_org_nodes_single_root"), "v4 应建立根节点唯一索引");

      // 5) 组织树在升级后的库上可用：根节点唯一约束实际生效。
      db.prepare(
        "INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, 'top_manager', 0, ?, ?)",
      ).run("n-root", "p-old", "项目统筹", T, T);
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO org_nodes (id, project_id, parent_id, name, role, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, 'top_manager', 0, ?, ?)",
            )
            .run("n-root2", "p-old", "第二个根", T, T),
        /UNIQUE/i,
      );

      // 6) 幂等。
      assert.deepEqual(runMigrations(db, migrations).applied, []);
    } finally {
      db.close();
    }
  });
});

test("v4 库升级到 v5：成员状态列默认 active、旧数据不丢、状态机写入可用（#50 升级路径）", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      // 1) 跑到 v4（T2 #49 之后的现有库形态），留一名阶段 1 语义的旧成员（无 status 列）。
      runMigrations(
        db,
        migrations.filter((m) => m.version <= 4),
      );
      const T = "2026-01-01T00:00:00.000Z";
      db.prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run("p-old", "老项目", T, T);
      db.prepare(
        "INSERT INTO members (id, project_id, kind, display_name, role, created_at, updated_at) VALUES (?, ?, 'human', ?, 'normal', ?, ?)",
      ).run("m-old", "p-old", "老成员", T, T);

      // 2) 追加 v5：只加列，不回填业务数据（默认 active），旧行可恢复读取。
      const result = runMigrations(db, migrations);
      assert.deepEqual(
        result.applied.map((m) => m.version),
        [5],
      );
      assert.equal(result.version, EXPECTED_VERSION);
      assert.equal(
        (db.prepare("SELECT status FROM members WHERE id = ?").get("m-old") as { status: string }).status,
        "active",
        "v4 老成员升级后应为 active（阶段 1 行为不变）",
      );
      assert.equal(
        (db.prepare("SELECT display_name FROM members WHERE id = ?").get("m-old") as { display_name: string })
          .display_name,
        "老成员",
        "升级不丢旧数据",
      );

      // 3) 升级后的库上状态机写入可用：切到 disabled 再恢复 active。
      db.prepare("UPDATE members SET status = 'disabled' WHERE id = ?").run("m-old");
      assert.equal(
        (db.prepare("SELECT status FROM members WHERE id = ?").get("m-old") as { status: string }).status,
        "disabled",
      );
      db.prepare("UPDATE members SET status = 'active' WHERE id = ?").run("m-old");

      // 4) 幂等。
      assert.deepEqual(runMigrations(db, migrations).applied, []);
    } finally {
      db.close();
    }
  });
});

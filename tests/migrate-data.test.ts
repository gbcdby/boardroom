/**
 * M1（#54）数据迁移与回滚测试。
 *
 * - 单元：业务表清单完整性、外键拷贝顺序合法性、PG DDL 镜像与 SQLite DDL 版本对应。
 * - 集成（无需 PG）：SQLite → SQLite 全量拷贝 + 一致性校验 + 幂等重跑 + 回滚。
 * - 端到端（真实 PG，门控于 AGENT_STUDIO_PG_TEST_URL）：SQLite→PG 迁移校验、
 *   PG→SQLite 反向校验（与源库逐键一致）、回滚（DROP schema），并在 finally 清理。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDbDriver } from "../src/server/db/driver.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import type { DbDriverOptions } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import {
  BUSINESS_TABLES,
  PG_BUSINESS_SCHEMA_MIGRATIONS,
  migrateData,
  rollbackTarget,
  validateData,
} from "../src/server/db/migrate-data.ts";
import { seedSampleData } from "../src/server/db/seed-sample-data.ts";

const PG_URL =
  process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-m1-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedSqliteDir(dir: string): Promise<void> {
  const driver = createDbDriver({ dbDriver: "sqlite", dataDir: dir });
  await driver.connect();
  try {
    await driver.migrate(migrations);
    seedSampleData((driver as SqliteDriver).handle);
    // 迁移往返也必须保留 v7 的幂等键和唤醒事实，不能只验证全 NULL 的新列。
    await driver.exec(
      "UPDATE messages SET client_message_id = ? WHERE id = (SELECT id FROM messages ORDER BY id LIMIT 1)",
      ["migration-request"],
    );
    await driver.exec(
      "UPDATE message_deliveries SET wake_decision = 'allowed' WHERE id = (SELECT id FROM message_deliveries ORDER BY id LIMIT 1)",
    );
    await driver.exec(
      "UPDATE message_deliveries SET wake_decision = 'suppressed', wake_suppressed_reason = 'rate_limited' WHERE id = 'md2'",
    );
  } finally {
    await driver.close();
  }
}

async function assertDispatchValues(options: DbDriverOptions): Promise<void> {
  const driver = createDbDriver(options);
  await driver.connect();
  try {
    assert.deepEqual(await driver.query("SELECT id, client_message_id FROM messages ORDER BY id"), [
      { id: "msg1", client_message_id: "migration-request" },
      { id: "msg2", client_message_id: null },
    ]);
    assert.deepEqual(await driver.query(
      "SELECT id, wake_decision, wake_suppressed_reason FROM message_deliveries ORDER BY id",
    ), [
      { id: "md1", wake_decision: "allowed", wake_suppressed_reason: null },
      { id: "md2", wake_decision: "suppressed", wake_suppressed_reason: "rate_limited" },
    ]);
  } finally { await driver.close(); }
}

// 跨表外键依赖（自引用 org_nodes 由递归读取处理，此处不计入顺序约束）。
const FK_DEPS: Record<string, string[]> = {
  org_nodes: ["projects"],
  members: ["projects", "agents", "org_nodes"],
  groups: ["projects"],
  group_participants: ["groups", "members"],
  messages: ["groups", "members"],
  message_deliveries: ["messages", "members", "projects"],
  member_statuses: ["projects", "members"],
  mcp_sessions: ["agents", "projects", "groups", "members"],
  agent_runtimes: ["agents"],
  agent_runtime_bindings: ["agent_runtimes", "projects", "groups", "members"],
  agent_runner_states: ["agent_runtime_bindings"],
  agent_runtime_members: ["agent_runtimes", "projects", "members", "agent_runtime_bindings"],
};

test("业务表清单：18 张表、不含 schema_migrations、外键顺序合法", () => {
  const names = BUSINESS_TABLES.map((t) => t.name);
  assert.equal(names.length, 18);
  assert.ok(!names.includes("schema_migrations"));
  for (const expected of [
    "agents",
    "projects",
    "members",
    "groups",
    "org_nodes",
    "group_participants",
    "messages",
    "message_deliveries",
    "member_statuses",
    "mcp_sessions",
    "audit_log",
    "agent_runtimes",
    "agent_runtime_bindings",
    "agent_runner_states",
    "agent_runtime_members",
    "agent_runtime_events",
    "agent_runtime_observation_meta",
    "agent_runtime_usage_snapshots",
  ]) {
    assert.ok(names.includes(expected), `缺少业务表 ${expected}`);
  }

  const pos = new Map(names.map((n, i) => [n, i]));
  for (const [table, deps] of Object.entries(FK_DEPS)) {
    for (const dep of deps) {
      assert.ok(
        (pos.get(dep) ?? -1) < (pos.get(table) ?? -1),
        `外键顺序错误：${table} 应晚于其依赖 ${dep}`,
      );
    }
  }

  // 复合主键表应有两列键。
  const gp = BUSINESS_TABLES.find((t) => t.name === "group_participants");
  const ms = BUSINESS_TABLES.find((t) => t.name === "member_statuses");
  assert.deepEqual(gp?.keyColumns, ["group_id", "member_id"]);
  assert.deepEqual(ms?.keyColumns, ["project_id", "member_id"]);
  // org_nodes 使用层级读取 SQL。
  const on = BUSINESS_TABLES.find((t) => t.name === "org_nodes");
  assert.ok(on?.readSql?.includes("WITH RECURSIVE"));
});

test("PG DDL 镜像：版本与 SQLite 一致，且不含 json_valid 检查", () => {
  assert.equal(PG_BUSINESS_SCHEMA_MIGRATIONS.length, migrations.length);
  const expectedVersions = migrations.map((m) => m.version).sort((a, b) => a - b);
  const pgVersions = PG_BUSINESS_SCHEMA_MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
  assert.deepEqual(pgVersions, expectedVersions);
  // 生产 SQLite DDL 用 json_valid 校验 mentions；PG 镜像应改用 PG 合法写法（此处省略）。
  const sqliteUp = migrations.map((m) => m.up).join("\n");
  assert.ok(sqliteUp.includes("json_valid"));
  const pgUp = PG_BUSINESS_SCHEMA_MIGRATIONS.map((m) => m.up).join("\n");
  assert.ok(!pgUp.includes("json_valid"));
  assert.ok(!pgUp.includes("json_type"));
});

test("SQLite → SQLite：全量拷贝、一致性校验、源库只读、幂等重跑", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };

    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };

      const first = await migrateData(srcOpts, dstOpts, { snapshotSource: true });
      assert.equal(first.validation.ok, true);
      await assertDispatchValues(srcOpts);
      await assertDispatchValues(dstOpts);

      // 源库未改：全部业务表的行数保持一致。
      const srcCounts: Record<string, number> = {};
      const srcDriver = createDbDriver(srcOpts);
      await srcDriver.connect();
      try {
        for (const t of BUSINESS_TABLES) {
          const rows = await srcDriver.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t.name}`);
          srcCounts[t.name] = rows[0]?.c ?? 0;
        }
      } finally {
        await srcDriver.close();
      }
      assert.equal(srcCounts["agents"], 2);
      assert.equal(srcCounts["members"], 3);
      assert.equal(srcCounts["org_nodes"], 4);
      assert.equal(srcCounts["messages"], 2);
      assert.equal(srcCounts["audit_log"], 1);

      // 幂等重跑：再次迁移仍一致。
      const again = await migrateData(srcOpts, dstOpts);
      assert.equal(again.validation.ok, true);
      assert.deepEqual(again.perTableCounts, first.perTableCounts);
      await assertDispatchValues(dstOpts);
    });
  });
});

test("SQLite → SQLite：目标键集完整（含复合主键表与 id 保留）", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };
    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };
      const report = await migrateData(srcOpts, dstOpts);

      // 抽查具体 id 在目标库存在。
      const dstDriver = createDbDriver(dstOpts);
      await dstDriver.connect();
      try {
        const member = await dstDriver.query<{ id: string }>(
          `SELECT id FROM members WHERE id = 'mb1'`,
        );
        assert.equal(member.length, 1);
        const gp = await dstDriver.query<{ group_id: string; member_id: string }>(
          `SELECT group_id, member_id FROM group_participants WHERE group_id = 'gp1' AND member_id = 'mb2'`,
        );
        assert.equal(gp.length, 1);
      } finally {
        await dstDriver.close();
      }
      assert.equal(report.validation.ok, true);
    });
  });
});

test("回滚：清空目标业务表，源库不受影响；可重新迁移恢复", async () => {
  await withTempDir(async (srcDir) => {
    await seedSqliteDir(srcDir);
    const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };
    await withTempDir(async (dstDir) => {
      const dstOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: dstDir };
      await migrateData(srcOpts, dstOpts);

      const rb = await rollbackTarget(dstOpts);
      assert.equal(rb.clearedTables.length, 18);

      // 目标业务表已清空，校验失败。
      const afterRollback = await validateData(srcOpts, dstOpts);
      assert.equal(afterRollback.ok, false);

      // 源库仍完整。
      const srcStillOk = await validateData(srcOpts, srcOpts);
      assert.equal(srcStillOk.ok, true);

      // 重跑迁移可恢复。
      const recovered = await migrateData(srcOpts, dstOpts);
      assert.equal(recovered.validation.ok, true);
    });
  });
});

if (PG_URL !== undefined) {
  test("PG 端到端：SQLite→PG 迁移校验 → PG→SQLite 反向校验 → 回滚 DROP schema", async () => {
    const schema = `boardroom_m1_${Math.random().toString(16).slice(2, 10)}`;
    const pgOpts: DbDriverOptions = {
      dbDriver: "postgres",
      pgConnectionString: PG_URL,
      pgSchema: schema,
    };
    await withTempDir(async (srcDir) => {
      await seedSqliteDir(srcDir);
      const srcOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: srcDir };

      await withTempDir(async (revDir) => {
        const revOpts: DbDriverOptions = { dbDriver: "sqlite", dataDir: revDir };
        try {
          // 正向：SQLite → PG
          const fwd = await migrateData(srcOpts, pgOpts, { snapshotSource: true });
          assert.equal(fwd.validation.ok, true, "SQLite→PG 一致性校验应通过");
          await assertDispatchValues(pgOpts);

          // 反向：PG → SQLite
          const rev = await migrateData(pgOpts, revOpts);
          assert.equal(rev.validation.ok, true, "PG→SQLite 一致性校验应通过");
          await assertDispatchValues(revOpts);

          // 反向产物与原源库逐键一致（证明 PG 中转未丢失/改写数据）。
          const identity = await validateData(srcOpts, revOpts);
          assert.equal(identity.ok, true, "反向迁移产物应与源库逐键一致");

          // 回滚：DROP 目标 schema。
          const rb = await rollbackTarget(pgOpts, { dropSchema: true });
          assert.equal(rb.droppedSchema, schema);
        } finally {
          // 无论如何清理 PG schema，避免遗留。
          const pg = createDbDriver(pgOpts);
          await pg.connect();
          try {
            await pg.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await pg.close();
          }
        }
      });
    });
  });
}

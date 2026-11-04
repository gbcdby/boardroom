/**
 * F1（#46）：持久化驱动接口 / 连接工厂 的 seam 测试。
 *
 * 观察的公共行为：
 * - 工厂按配置产出对应驱动（默认 SQLite）；
 * - SQLite 驱动 connect/migrate/query/transaction/close 的语义与阶段 1 一致；
 * - 驱动暴露的 SQLite 句柄可直接交给既有 repository 调用点（旧调用点不变）；
 * - 失败路径：PG 配置缺失 / 连接失败给出明确错误与恢复路径（NFR-PROJ-05）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { startServer, ServerStartupError } from "../src/server/server.ts";

const silentLogger = createLogger({ write: () => {} });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-driver-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("连接工厂缺省产出 SQLite 驱动", () => {
  const driver = createDbDriver({ dataDir: "/tmp/unused" });
  assert.equal(driver.kind, "sqlite");
});

test("SQLite 驱动 connect/migrate/query 走通，迁移可幂等重放", async () => {
  await withTempDir(async (dir) => {
    const driver = createDbDriver({ dbDriver: "sqlite", dataDir: dir });
    await driver.connect();
    try {
      const first = await driver.migrate(migrations);
      assert.equal(first.applied.length, migrations.length);

      const replay = await driver.migrate(migrations);
      assert.equal(replay.applied.length, 0);
      assert.equal(replay.version, migrations.length);

      const rows = await driver.query<{ version: number; name: string }>(
        `SELECT version, name FROM schema_migrations ORDER BY version`,
      );
      assert.deepEqual(
        rows.map((row) => row.version),
        migrations.map((migration) => migration.version),
      );
    } finally {
      await driver.close();
    }
  });
});

test("SQLite 驱动句柄可直接交给既有 repository 调用点（旧调用点不变）", async () => {
  await withTempDir(async (dir) => {
    const driver = createDbDriver({ dbDriver: "sqlite", dataDir: dir });
    assert.ok(driver instanceof SqliteDriver, "sqlite 工厂产物应为 SqliteDriver（含 handle）");
    await driver.connect();
    try {
      await driver.migrate(migrations);
      const repos = createRepositories(driver.handle);
      const project = repos.projects.create({ name: "F1 项目" });
      assert.equal(repos.projects.get(project.id)?.name, "F1 项目");
    } finally {
      await driver.close();
    }
  });
});

test("SQLite 驱动事务：提交持久化、异常整体回滚", async () => {
  await withTempDir(async (dir) => {
    const driver = createDbDriver({ dbDriver: "sqlite", dataDir: dir });
    await driver.connect();
    try {
      await driver.exec(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);

      await driver.transaction(async (tx) => {
        await tx.exec(`INSERT INTO widgets (id, name) VALUES (?, ?)`, [1, "committed"]);
      });
      await assert.rejects(
        driver.transaction(async (tx) => {
          await tx.exec(`INSERT INTO widgets (id, name) VALUES (?, ?)`, [2, "rolled-back"]);
          throw new Error("故意失败");
        }),
        /故意失败/,
      );

      const rows = await driver.query<{ id: number; name: string }>(`SELECT id, name FROM widgets ORDER BY id`);
      assert.deepEqual(rows, [{ id: 1, name: "committed" }]);
    } finally {
      await driver.close();
    }
  });
});

test("连接工厂：dbDriver=postgres 但缺连接串时报错并给出配置指引", () => {
  assert.throws(
    () => createDbDriver({ dbDriver: "postgres", dataDir: "/tmp/unused" }),
    { name: "ConfigError", message: /pgConnectionString|PG 连接串/ },
  );
});

test("连接工厂：dbDriver=postgres 且配置连接串时产出 PostgreSQL 驱动（不触发网络连接）", () => {
  const driver = createDbDriver({
    dbDriver: "postgres",
    pgConnectionString: "postgres://user:pass@127.0.0.1:55432/appdb",
  });
  assert.equal(driver.kind, "postgres");
});

test("PostgreSQL 驱动连接失败：明确错误类型、恢复路径，且不外泄密码", async () => {
  // 127.0.0.1:1 无监听 → 快速 ECONNREFUSED，可在无 PG 环境验证失败路径。
  const driver = createDbDriver({
    dbDriver: "postgres",
    pgConnectionString: "postgres://user:secret-pw@127.0.0.1:1/appdb",
  });
  await assert.rejects(driver.connect(), (error: unknown) => {
    const err = error as Error;
    assert.equal(err.name, "DriverConnectionError");
    assert.match(err.message, /无法连接 PostgreSQL/);
    assert.match(err.message, /AGENT_STUDIO_PG_CONNECTION_STRING|连接串/);
    assert.match(err.message, /sqlite/); // 回滚路径：切回 SQLite 配置
    assert.doesNotMatch(err.message, /secret-pw/); // 不把口令带回错误信息
    return true;
  });
  await driver.close();
});

test("服务启动经连接工厂：默认 SQLite 正常，业务仓储未迁移前 postgres 明确拒绝启动", async () => {
  await withTempDir(async (dir) => {
    // 默认（未写 dbDriver）仍走 SQLite，阶段 1 启动路径不回归。
    const server = await startServer({
      config: {
        port: 0,
        dataDir: dir,
        heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
        configFile: null,
      },
      logger: silentLogger,
    });
    try {
      assert.equal(server.migrationState.version, migrations.length);
    } finally {
      await server.close();
    }

    // postgres：业务表尚未迁移（M1 #54），启动应失败并给出切回 sqlite 的回滚指引。
    // 手动承接 Promise：在实现尚未拒绝时也不泄漏已启动的 server。
    let started: import("../src/server/server.ts").RunningServer | null = null;
    let caught: unknown = null;
    try {
      started = await startServer({
        config: {
          port: 0,
          dataDir: dir,
          heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
          dbDriver: "postgres",
          pgConnectionString: "postgres://user:pass@127.0.0.1:1/appdb",
          configFile: null,
        },
        logger: silentLogger,
      });
    } catch (error) {
      caught = error;
    }
    if (started !== null) await started.close();
    assert.ok(caught instanceof ServerStartupError, "postgres 启动应抛 ServerStartupError");
    assert.match(caught.message, /PostgreSQL/);
    assert.match(caught.message, /M1/);
    assert.match(caught.message, /sqlite/);
  });
});

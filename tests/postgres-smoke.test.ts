/**
 * F1（#46）：PostgreSQL 驱动冒烟测试（可选，自动跳过）。
 *
 * 运行前提：需要可达的 PG，显式设置环境变量
 *   AGENT_STUDIO_PG_TEST_URL=postgres://user:password@host:port/database
 * 本地冒烟容器（专用、一次性）：
 *   docker run -d --name boardroom-pg-f1-smoke -e POSTGRES_PASSWORD=smokepw \
 *     -p 15432:5432 postgres:16-alpine
 *   AGENT_STUDIO_PG_TEST_URL=postgres://postgres:smokepw@127.0.0.1:15432/postgres npm test
 * 未设置该变量时本文件整体跳过，`npm test` 在无 PG 环境不因缺 PG 失败。
 *
 * 覆盖：connect、按方言的基线迁移（含幂等重放与 checksum 防篡改）、
 * `?`→`$n` 参数渲染、事务提交/回滚、JSONB/BOOLEAN/TIMESTAMPTZ 往返、
 * schema 隔离（pgSchema）与 close。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createDbDriver } from "../src/server/db/driver.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import { MigrationError, type Migration } from "../src/server/db/migrate.ts";
import { postgresDialect } from "../src/server/db/dialect.ts";

const url = process.env["AGENT_STUDIO_PG_TEST_URL"];
const skip = url === undefined ? "未设置 AGENT_STUDIO_PG_TEST_URL：无 PG 环境自动跳过冒烟" : false;

/** 冒烟专用迁移：DDL 片段来自方言抽象，验证其能在真 PG 上执行。 */
function smokeMigrations(): Migration[] {
  return [
    {
      version: 1,
      name: "smoke_init",
      up:
        `CREATE TABLE f1_smoke_widgets (
           id ${postgresDialect.columnType("integer_pk")},
           name ${postgresDialect.columnType("text")} NOT NULL,
           payload ${postgresDialect.columnType("json")},
           active ${postgresDialect.columnType("boolean")} NOT NULL DEFAULT TRUE,
           created ${postgresDialect.columnType("timestamp")} NOT NULL DEFAULT now()
         );`,
    },
  ];
}

/** 每次运行独立 schema：隔离并允许并行冒烟；结束后删除。 */
async function withSmokeSchema<T>(fn: (schema: string, driver: DbDriver) => Promise<T>): Promise<T> {
  assert.ok(url !== undefined, "withSmokeSchema 仅在冒烟开启时调用");
  const schema = `f1_smoke_${randomBytes(6).toString("hex")}`;
  const driver = createDbDriver({
    dbDriver: "postgres",
    pgConnectionString: url,
    pgSchema: schema,
  });
  try {
    return await fn(schema, driver);
  } finally {
    await driver.close();
    // 清理 schema（用未限定 search_path 的独立连接，避免依赖驱动状态）。
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
}

test(
  "冒烟：connect + 基线迁移 + 幂等重放",
  { skip, timeout: 60_000 },
  async () => {
    await withSmokeSchema(async (schema, driver) => {
      await driver.connect();
      const result = await driver.migrate(smokeMigrations());
      assert.equal(result.applied.length, 1);
      assert.equal(result.version, 1);

      const replay = await driver.migrate(smokeMigrations());
      assert.equal(replay.applied.length, 0);

      const state = await driver.migrationState();
      assert.equal(state.applied[0]?.name, "smoke_init");
      assert.match(String(state.applied[0]?.appliedAt), /^\d{4}-\d{2}-\d{2}T/); // TIMESTAMPTZ → ISO 字符串

      const rows = await driver.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE nspname = ?",
        [schema],
      );
      assert.equal(rows.length, 1);
    });
  },
);

test(
  "冒烟：已应用迁移被改写时 checksum 拒绝执行",
  { skip, timeout: 60_000 },
  async () => {
    await withSmokeSchema(async (_schema, driver) => {
      await driver.connect();
      await driver.migrate(smokeMigrations());
      const tampered: Migration[] = [{ version: 1, name: "smoke_init", up: "CREATE TABLE f1_smoke_other (id INTEGER);" }];
      await assert.rejects(driver.migrate(tampered), (error: unknown) => {
        assert.ok(error instanceof MigrationError);
        assert.match((error as Error).message, /checksum/);
        return true;
      });
    });
  },
);

test(
  "冒烟：?→$n 渲染、JSONB/BOOLEAN/自增往返",
  { skip, timeout: 60_000 },
  async () => {
    await withSmokeSchema(async (_schema, driver) => {
      await driver.connect();
      await driver.migrate(smokeMigrations());

      await driver.exec(
        "INSERT INTO f1_smoke_widgets (name, payload, active) VALUES (?, ?, ?)",
        ["alpha", JSON.stringify({ tags: ["a", "b"], nested: { ok: true } }), true],
      );
      await driver.exec(
        "INSERT INTO f1_smoke_widgets (name, payload) VALUES (?, ?)",
        ["beta", JSON.stringify({ seq: 2 })],
      );

      const rows = await driver.query<{
        id: number;
        name: string;
        payload: { tags?: string[]; nested?: { ok?: boolean }; seq?: number };
        active: boolean;
      }>(
        "SELECT id, name, payload, active FROM f1_smoke_widgets ORDER BY name",
      );

      assert.deepEqual(rows.map((row) => row.name), ["alpha", "beta"]);
      // 自增由 IDENTITY 产生：调用方未提供 id。
      assert.equal(typeof rows[0]?.id, "number");
      assert.ok((rows[0]?.id ?? 0) > 0);
      assert.notEqual(rows[0]?.id, rows[1]?.id);
      // JSONB 以对象返回（方言映射生效）。
      assert.deepEqual(rows[0]?.payload?.tags, ["a", "b"]);
      assert.equal(rows[0]?.payload?.nested?.ok, true);
      // BOOLEAN 以布尔返回。
      assert.equal(rows[0]?.active, true);
    });
  },
);

test(
  "冒烟：事务提交持久化、异常整体回滚",
  { skip, timeout: 60_000 },
  async () => {
    await withSmokeSchema(async (_schema, driver) => {
      await driver.connect();
      await driver.migrate(smokeMigrations());

      await driver.transaction(async (tx) => {
        await tx.exec("INSERT INTO f1_smoke_widgets (name) VALUES (?)", ["kept"]);
      });
      await assert.rejects(
        driver.transaction(async (tx) => {
          await tx.exec("INSERT INTO f1_smoke_widgets (name) VALUES (?)", ["dropped"]);
          throw new Error("故意失败");
        }),
        /故意失败/,
      );

      const rows = await driver.query<{ name: string }>("SELECT name FROM f1_smoke_widgets ORDER BY name");
      assert.deepEqual(rows.map((row) => row.name), ["kept"]);
    });
  },
);

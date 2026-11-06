import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { readMigrationState, runMigrations, type Migration } from "../src/server/db/migrate.ts";
// 注：本文件只验证迁移框架（SAMPLE）的幂等与校验，不混入生产 migrations，
// 否则生产迁移（version 1）会与 SAMPLE（version 1 create_widgets）冲突触发 checksum 错误。

const SAMPLE: readonly Migration[] = [
  { version: 1, name: "create_widgets", up: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);" },
  { version: 2, name: "add_widget_color", up: "ALTER TABLE widgets ADD COLUMN color TEXT;" },
];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-migrate-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("首次运行按顺序执行全部迁移并记录版本", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    const db = driver.handle;
    try {
      const result = runMigrations(db, SAMPLE);

      assert.deepEqual(
        result.applied.map((m) => m.version),
        [1, 2],
      );
      assert.equal(result.version, 2);
      assert.equal(readMigrationState(db).version, 2);

      const columns = db.prepare("PRAGMA table_info(widgets)").all() as { name: string }[];
      assert.deepEqual(
        columns.map((c) => c.name),
        ["id", "label", "color"],
      );
    } finally {
      await driver.close();;
    }
  });
});

test("重复运行迁移是幂等的，不会重复执行", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    const db = driver.handle;
    try {
      runMigrations(db, SAMPLE);
      const second = runMigrations(db, SAMPLE);

      assert.deepEqual(second.applied, []);
      assert.equal(second.version, 2);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      assert.deepEqual(rows, [{ version: 1 }, { version: 2 }]);
    } finally {
      await driver.close();;
    }
  });
});

test("重启后迁移版本保留，不会重跑已应用的迁移", async () => {
  await withTempDir(async (dir) => {
    const firstDriver = new SqliteDriver({ dataDir: dir });
    await firstDriver.connect();
    const first = firstDriver.handle;
    runMigrations(first, SAMPLE);
    first.close();

    const secondDriver = new SqliteDriver({ dataDir: dir });
    await secondDriver.connect();
    const second = secondDriver.handle;
    try {
      assert.equal(readMigrationState(second).version, 2);

      const result = runMigrations(second, SAMPLE);
      assert.deepEqual(result.applied, []);
      assert.equal(result.version, 2);
    } finally {
      second.close();
    }
  });
});

test("已应用的迁移被改写时给出明确错误", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    const db = driver.handle;
    try {
      runMigrations(db, SAMPLE);
      const tampered: readonly Migration[] = [
        { version: 1, name: "create_widgets", up: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);" },
      ];

      assert.throws(() => runMigrations(db, tampered), /create_widgets/);
    } finally {
      await driver.close();;
    }
  });
});

test("迁移执行失败时整条迁移回滚，版本不前进", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    const db = driver.handle;
    try {
      const broken: readonly Migration[] = [
        { version: 1, name: "ok", up: "CREATE TABLE ok (id INTEGER);" },
        { version: 2, name: "broken", up: "CREATE TABLE broken (id INTEGER); INVALID SQL;" },
      ];

      assert.throws(() => runMigrations(db, broken));

      assert.equal(readMigrationState(db).version, 1);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'")
        .all();
      assert.deepEqual(tables, []);
    } finally {
      await driver.close();;
    }
  });
});

test("生产迁移列表当前为空，只建迁移版本表", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    const db = driver.handle;
    try {
      const result = runMigrations(db, []);
      assert.deepEqual(result.applied, []);
      assert.equal(result.version, 0);

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.deepEqual(tables, ["schema_migrations"]);
    } finally {
      await driver.close();;
    }
  });
});

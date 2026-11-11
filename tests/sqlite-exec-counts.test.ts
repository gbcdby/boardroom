import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver, type DbDriver, type DbTransaction } from "../src/server/db/driver.ts";

async function sqlite(body: (db: DbDriver) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-sqlite-counts-"));
  const db = createDbDriver({ dataDir: directory });
  try { await db.connect(); await body(db); }
  finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const mode of ["direct", "transaction"] as const) {
  test(`SQLite ${mode} exec：无参DML返回顶层真实changes，DDL/空匹配不继承旧计数`, async () => sqlite(async db => {
    assert.equal(await db.exec("CREATE TABLE exec_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)"), 0);
    assert.equal(await db.exec("CREATE TABLE exec_effects (row_id INTEGER NOT NULL)"), 0);
    assert.equal(await db.exec(`CREATE TRIGGER exec_side_effect AFTER UPDATE ON exec_rows BEGIN
      INSERT INTO exec_effects VALUES(NEW.id); INSERT INTO exec_effects VALUES(NEW.id); END`), 0);
    const exercise = async (executor: DbTransaction) => {
      assert.equal(await executor.exec("INSERT INTO exec_rows VALUES (1, 'first'), (2, 'second'), (3, 'semi;colon')"), 3);
      assert.equal(await executor.exec("UPDATE exec_rows SET value = 'changed' WHERE id <= 2"), 2);
      assert.equal((await executor.query("SELECT row_id FROM exec_effects")).length, 4, "trigger真实写4行，顶层UPDATE仍只报告2行");
      assert.equal(await executor.exec("/* prefix */ -- actual SQL follows\nWITH target(id) AS (VALUES(3)) UPDATE exec_rows SET value = 'cte' WHERE id IN (SELECT id FROM target)"), 1);
      assert.equal(await executor.exec("CREATE TABLE exec_ddl (id INTEGER)"), 0);
      assert.equal(await executor.exec("DROP TABLE exec_ddl"), 0);
      assert.equal(await executor.exec("SELECT id FROM exec_rows ORDER BY id"), 0);
      assert.equal(await executor.exec("UPDATE exec_rows SET value = 'none' WHERE id = 999"), 0);
      assert.equal(await executor.exec("DELETE FROM exec_rows WHERE id = 2"), 1);
      assert.equal(await executor.exec("INSERT INTO exec_rows VALUES (?, ?)", [4, "parameterized"]), 1);
      assert.deepEqual(await executor.query("SELECT id, value FROM exec_rows ORDER BY id"), [
        { id: 1, value: "changed" }, { id: 3, value: "cte" }, { id: 4, value: "parameterized" },
      ]);
    };
    if (mode === "transaction") await db.transaction(exercise); else await exercise(db);
  }));

  test(`SQLite ${mode} exec：单语句入口拒绝多语句且没有部分执行`, async () => sqlite(async db => {
    await db.exec("CREATE TABLE exec_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await db.exec("INSERT INTO exec_rows VALUES (?, ?)", [1, "untouched"]);
    const exercise = async (executor: DbTransaction) => {
      await assert.rejects(executor.exec("UPDATE exec_rows SET value = 'must-not-run'; DELETE FROM exec_rows;"), /more than one statement/);
      assert.deepEqual(await executor.query("SELECT id, value FROM exec_rows"), [{ id: 1, value: "untouched" }]);
      assert.equal(await executor.exec("UPDATE exec_rows SET value = 'usable' WHERE id = 1"), 1);
    };
    if (mode === "transaction") await db.transaction(exercise); else await exercise(db);
    assert.deepEqual(await db.query("SELECT value FROM exec_rows"), [{ value: "usable" }]);
  }));
}

test("SQLite migrate：多语句DDL/数据及trigger仍在迁移事务内执行，失败无部分DDL", async () => sqlite(async db => {
  const initial = { version: 1, name: "multi_statement", up: `
    CREATE TABLE migrated (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE migrated_effects (row_id INTEGER NOT NULL);
    INSERT INTO migrated VALUES (1, 'seed');
    CREATE TRIGGER migrated_trigger AFTER UPDATE ON migrated BEGIN
      INSERT INTO migrated_effects VALUES(NEW.id); INSERT INTO migrated_effects VALUES(NEW.id); END;
    UPDATE migrated SET value = 'triggered';
  ` };
  assert.equal((await db.migrate([initial])).version, 1);
  assert.deepEqual(await db.query("SELECT id, value FROM migrated"), [{ id: 1, value: "triggered" }]);
  assert.deepEqual(await db.query("SELECT row_id FROM migrated_effects"), [{ row_id: 1 }, { row_id: 1 }]);
  assert.equal((await db.migrate([initial])).applied.length, 0);
  await assert.rejects(db.migrate([initial, { version: 2, name: "failed_multi_statement", up:
    "CREATE TABLE must_not_persist (id INTEGER); INSERT INTO migrated VALUES(1, 'duplicate');" }]), /UNIQUE constraint/);
  assert.deepEqual(await db.query("SELECT name FROM sqlite_master WHERE name = 'must_not_persist'"), []);
  assert.equal((await db.migrationState()).version, 1);
}));

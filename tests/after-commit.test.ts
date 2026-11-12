import test from "node:test";
import assert from "node:assert/strict";
import { afterCommit } from "../src/server/db/after-commit.ts";
import type { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

for (const engine of identityEngines) {
  const skip = identitySkip(engine);
  test(`${engine} 提交回调在物理提交、上下文及连接释放后执行，可重入`, { skip, timeout: 15_000 }, async () => {
    const f = await identityFixture(engine);
    try {
      const seen: string[] = [];
      await f.db.exec("CREATE TABLE callback_probe (id TEXT PRIMARY KEY)");
      await f.db.transaction(async () => {
        await f.db.exec("INSERT INTO callback_probe VALUES ('outer')");
        await afterCommit(f.db, async () => {
          assert.equal(f.db.currentTransactionContext(), undefined);
          assert.equal((await f.db.query("SELECT id FROM callback_probe WHERE id = 'outer'")).length, 1);
          await f.db.transaction(async () => { await f.db.exec("INSERT INTO callback_probe VALUES ('reentered')"); });
          seen.push("outer");
        });
        await f.db.transaction(async () => {
          await afterCommit(f.db, () => { seen.push("nested"); });
        });
        assert.deepEqual(seen, [], "保存点释放不是物理提交");
      });
      assert.deepEqual(seen, ["outer", "nested"]);
      assert.equal((await f.db.query("SELECT id FROM callback_probe")).length, 2);
    } finally { await f.close(); }
  });

  test(`${engine} 提交回调随外层和保存点回滚丢弃，观察者异常不改变提交`, { skip }, async () => {
    const f = await identityFixture(engine);
    try {
      const seen: string[] = [];
      await f.db.exec("CREATE TABLE callback_probe (id TEXT PRIMARY KEY)");
      await assert.rejects(f.db.transaction(async () => {
        await afterCommit(f.db, () => { seen.push("rollback"); });
        throw new Error("outer_rollback");
      }), /outer_rollback/);
      const result = await f.db.transaction(async () => {
        await f.db.exec("INSERT INTO callback_probe VALUES ('persisted')");
        await afterCommit(f.db, () => { seen.push("parent"); });
        await assert.rejects(f.db.transaction(async () => {
          await afterCommit(f.db, () => { seen.push("nested_rollback"); });
          throw new Error("nested_rollback");
        }), /nested_rollback/);
        await afterCommit(f.db, () => { throw new Error("observer_failure"); });
        await afterCommit(f.db, () => { seen.push("after_failure"); });
        return "committed";
      });
      assert.equal(result, "committed");
      assert.deepEqual(seen, ["parent", "after_failure"]);
      assert.equal((await f.db.query("SELECT id FROM callback_probe")).length, 1);
    } finally { await f.close(); }
  });

  test(`${engine} 只读一致快照不发布业务提交回调，读隔离约束保留`, { skip }, async () => {
    const f = await identityFixture(engine);
    try {
      let notified = false;
      await f.db.readSnapshot(async snapshot => {
        await snapshot.query("SELECT id FROM projects");
        await afterCommit(f.db, () => { notified = true; });
        await assert.rejects(snapshot.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('forbidden','x','t','t')"));
      }).catch(error => {
        // PostgreSQL 的只读写入拒绝会中止该只读事务；SQLite 保持只读事务可继续。
        if (engine !== "postgres") throw error;
        assert.match(String(error), /aborted|read.only/i);
      });
      assert.equal(notified, false);
      assert.equal((await f.db.query("SELECT id FROM projects WHERE id = 'forbidden'")).length, 0);
    } finally { await f.close(); }
  });
}

test("sqlite 隐式 exec 和 query RETURNING 提交后释放串行队列，回调重入不死锁", { timeout: 10_000 }, async () => {
  const f = await identityFixture("sqlite");
  try {
    await f.db.exec("CREATE TABLE callback_probe (id TEXT PRIMARY KEY)");
    const seen: string[] = [];
    (f.db as SqliteDriver).handle.function("stage_callback", (value: string) => {
      void afterCommit(f.db, async () => {
        assert.equal(f.db.currentTransactionContext(), undefined);
        assert.equal((await f.db.query("SELECT id FROM callback_probe WHERE id = ?", [value])).length, 1);
        seen.push(value);
      });
      return value;
    });
    assert.equal(await f.db.exec("INSERT INTO callback_probe VALUES (stage_callback('exec'))"), 1);
    const returned = await f.db.query<{ id: string }>("INSERT INTO callback_probe VALUES (stage_callback('returning')) RETURNING id");
    assert.deepEqual(returned, [{ id: "returning" }]);
    assert.deepEqual(seen, ["exec", "returning"]);
  } finally { await f.close(); }
});

test("postgres 五个并发提交回调重新借用连接池，不保留原物理连接", { skip: identitySkip("postgres"), timeout: 15_000 }, async () => {
  const f = await identityFixture("postgres");
  try {
    await f.db.exec("CREATE TABLE callback_probe (id TEXT PRIMARY KEY)");
    let entered = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const seen: number[] = [];
    await Promise.all(Array.from({ length: 5 }, (_, index) => f.db.transaction(async () => {
      await f.db.exec("INSERT INTO callback_probe VALUES (?)", [String(index)]);
      await afterCommit(f.db, async () => {
        assert.equal(f.db.currentTransactionContext(), undefined);
        await f.db.transaction(async () => {
          assert.equal((await f.db.query("SELECT id FROM callback_probe WHERE id = ?", [String(index)])).length, 1);
        });
        seen.push(index);
      });
      if (++entered === 5) release();
      await ready;
    })));
    assert.deepEqual(seen.sort(), [0, 1, 2, 3, 4]);
  } finally { await f.close(); }
});

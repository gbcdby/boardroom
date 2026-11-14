import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { notifyResourceChange, onResourceChange } from "../src/server/resource-changes.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"];
async function withDb(kind: "sqlite" | "postgres", run: (db: DbDriver) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-resource-commit-"));
  const schema = `resource_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(kind === "sqlite" ? { dataDir: directory } : { dbDriver: kind, pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.exec("CREATE TABLE resource_test (id TEXT PRIMARY KEY, value INTEGER NOT NULL)"); await run(db); }
  finally {
    await db.close();
    if (kind === "postgres") {
      const admin = new Client({ connectionString: pgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const kind of ["sqlite", "postgres"] as const) {
  const skip = kind === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；保留 CI 门控" : false;
  test(`${kind} resource.changed：外事务提交和上下文结束后才通知，可重新读取；只读与回滚不通知`, { skip }, async () => {
    await withDb(kind, async db => {
      const received: number[] = [];
      const stop = onResourceChange(db, async change => {
        assert.equal(db.currentTransactionContext(), undefined);
        const [row] = await db.query<{ value: number }>("SELECT value FROM resource_test WHERE id = ?", [change.id]);
        received.push(row!.value);
      });
      await db.transaction(async () => {
        await db.exec("INSERT INTO resource_test VALUES (?, ?)", ["task-a", 1]);
        await db.transaction(async () => notifyResourceChange(db, { projectId: "project-a", entity: "task", id: "task-a", revision: 1 }));
        assert.deepEqual(received, [], "保存点释放不是物理提交");
      });
      assert.deepEqual(received, [1]);
      await db.transaction(async () => { await db.query("SELECT * FROM resource_test"); });
      assert.deepEqual(received, [1], "普通读取不能生成业务成功提示");
      await assert.rejects(db.transaction(async () => {
        await db.exec("UPDATE resource_test SET value = 2");
        await db.transaction(async () => notifyResourceChange(db, { projectId: "project-a", entity: "task", id: "task-a", revision: 2 }));
        throw new Error("外事务回滚");
      }), /外事务回滚/);
      assert.deepEqual(received, [1]);
      assert.equal((await db.query<{ value: number }>("SELECT value FROM resource_test"))[0]!.value, 1);
      stop();
    });
  });

  test(`${kind} resource.changed：保存点回滚丢弃其提示，保留父提示；失败订阅者不改变已提交结果`, { skip }, async () => {
    await withDb(kind, async db => {
      const received: string[] = [];
      onResourceChange(db, change => { received.push(change.id); });
      onResourceChange(db, () => { throw new Error("模拟断线订阅者"); });
      const result = await db.transaction(async () => {
        await db.exec("INSERT INTO resource_test VALUES ('outer', 1)");
        await notifyResourceChange(db, { projectId: "p", entity: "task", id: "outer", revision: 1 });
        await assert.rejects(db.transaction(async () => {
          await db.exec("INSERT INTO resource_test VALUES ('rolled-back', 1)");
          await notifyResourceChange(db, { projectId: "p", entity: "task", id: "rolled-back", revision: 1 });
          throw new Error("保存点回滚");
        }), /保存点回滚/);
        await db.transaction(async () => {
          await db.exec("INSERT INTO resource_test VALUES ('nested', 1)");
          await notifyResourceChange(db, { projectId: "p", entity: "task", id: "nested", revision: 1 });
        });
        return "committed";
      });
      assert.equal(result, "committed");
      assert.deepEqual(received, ["outer", "nested"]);
      assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM resource_test ORDER BY id")).map(row => row.id), ["nested", "outer"]);
    });
  });
}

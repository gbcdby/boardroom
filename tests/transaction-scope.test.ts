import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { Client as PgClient } from "pg";
import type { DbDriver } from "../src/server/db/driver.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function verifyTransactionScope(db: DbDriver): Promise<void> {
  const first = createRepositories(db);
  const second = createRepositories(db);
  let rolledBackId = "";
  await assert.rejects(first.transaction(async () => {
    const project = await first.projects.create({ name: "outer-write" });
    rolledBackId = project.id;
    // 共享 driver 的第二套仓储必须使用相同事务连接，能读到尚未提交的行。
    assert.equal((await second.projects.get(project.id))?.name, "outer-write");
    await second.projects.rename(project.id, "second-repository-write");
    assert.equal((await first.projects.get(project.id))?.name, "second-repository-write");
    throw new Error("outer rollback");
  }), /outer rollback/);
  assert.equal(await second.projects.get(rolledBackId), null);

  await db.exec("CREATE TABLE transaction_probe (id TEXT PRIMARY KEY)");
  await db.transaction(async (outer) => {
    const entered = deferred();
    const release = deferred();
    const rollback = db.transaction(async (inner) => {
      await inner.exec("INSERT INTO transaction_probe(id) VALUES (?)", ["rollback"]);
      entered.resolve();
      await release.promise;
      // 捕获的父句柄在子事务中重入当前作用域，不能排到等待自己的父队列。
      await outer.exec("INSERT INTO transaction_probe(id) VALUES (?)", ["parent-in-child"]);
      await db.exec("INSERT INTO transaction_probe(id) VALUES (?)", ["driver-in-child"]);
      throw new Error("nested rollback");
    });
    await entered.promise;
    const survivor = db.transaction(async (inner) => {
      await inner.exec("INSERT INTO transaction_probe(id) VALUES (?)", ["survivor"]);
      // 仓储上下文捕获的祖先连接在子作用域中也应可重入。
      await first.transaction(async () => {
        const project = await first.projects.create({ name: "nested-survivor" });
        assert.equal((await second.projects.get(project.id))?.name, "nested-survivor");
      });
    });
    const pending = Promise.allSettled([rollback, survivor]);
    await setImmediate();
    release.resolve();
    const results = await pending;
    assert.equal(results[0]?.status, "rejected");
    assert.equal(results[1]?.status, "fulfilled");
    await outer.exec("INSERT INTO transaction_probe(id) VALUES (?)", ["outer-survivor"]);
  });
  assert.deepEqual(await db.query("SELECT id FROM transaction_probe ORDER BY id"), [
    { id: "outer-survivor" }, { id: "survivor" },
  ]);
  assert.ok((await first.projects.list()).some((project) => project.name === "nested-survivor"));
}

test("SQLite：跨仓储共用事务，兄弟保存点回滚隔离，父句柄可重入", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-transaction-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect();
  try {
    await db.migrate(migrations);
    await verifyTransactionScope(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("PostgreSQL：跨仓储共用事务，兄弟保存点回滚隔离，父句柄可重入", {
  skip: !process.env["AGENT_STUDIO_PG_TEST_URL"] && "未配置真实 PostgreSQL",
  timeout: 30_000,
}, async () => {
  const url = process.env["AGENT_STUDIO_PG_TEST_URL"]!;
  const schema = `transaction_${randomBytes(6).toString("hex")}`;
  const db = new PostgresDriver({ connectionString: url, schema });
  await db.connect();
  try {
    await db.migrate(migrations);
    await verifyTransactionScope(db);
  } finally {
    await db.close();
    const admin = new PgClient({ connectionString: url });
    await admin.connect();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

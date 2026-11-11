import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"];
async function withDb(engine: "sqlite" | "postgres", body: (db: DbDriver, schema: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-savepoint-"));
  const schema = `savepoint_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir }
    : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await body(db, schema); }
  finally {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "真实 PostgreSQL 由 CI 执行" : false;
  test(`${engine} 保存点回滚删除其内创建的 scope，下一次写入重新取得项目与成员锁`, { skip }, async () => {
    await withDb(engine, async db => {
      const repos = createRepositories(db), nestedRepos = createRepositories(db);
      const p = await repos.projects.create({ name: "保存点" });
      const member = await repos.members.create({ projectId: p.id, kind: "human", displayName: "成员" });
      const locks = { projects: 0, members: 0 };
      const exec = db.exec.bind(db);
      db.exec = async (sql, params) => {
        if (sql === "UPDATE projects SET updated_at = updated_at WHERE id = ?") locks.projects++;
        if (sql === "UPDATE members SET updated_at = updated_at WHERE id = ? AND project_id = ?") locks.members++;
        return exec(sql, params);
      };
      await repos.transaction(async () => {
        const identity = db.currentTransactionContext();
        await assert.rejects(() => nestedRepos.transaction(async () => {
          await nestedRepos.members.setStatus(member.id, "disabled");
          assert.ok(repos.mutations.current());
          throw new Error("rollback inner");
        }), /rollback inner/);
        assert.equal(db.currentTransactionContext(), identity, "外层物理事务仍有效");
        assert.equal((await repos.members.get(member.id))!.status, "active");
        assert.equal(repos.mutations.current(), null, "已回滚的锁不能留在元数据中");
        await repos.members.setStatus(member.id, "disabled");
      });
      assert.deepEqual(locks, { projects: 2, members: 2 });
      assert.equal((await repos.members.get(member.id))!.status, "disabled");
    });
  });

  test(`${engine} 保存点回滚保留此前已取得的父 scope，不能清空后扩大范围`, { skip }, async () => {
    await withDb(engine, async db => {
      const repos = createRepositories(db);
      const p = await repos.projects.create({ name: "父范围" });
      const member = await repos.members.create({ projectId: p.id, kind: "human", displayName: "成员" });
      const outside = await repos.members.create({ projectId: p.id, kind: "human", displayName: "范围外" });
      const metadata = Symbol("parent metadata");
      await repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [member.id], groupIds: [], runtimeIds: [] }) }, async parent => {
        const identity = db.currentTransactionContext()!;
        identity.values.set(metadata, "before");
        await assert.rejects(() => repos.transaction(async () => {
          identity.values.set(metadata, "during");
          await repos.members.setStatus(member.id, "disabled");
          throw new Error("rollback nested");
        }), /rollback nested/);
        assert.equal(identity.values.get(metadata), "before");
        assert.equal(repos.mutations.current(), parent);
        assert.equal((await repos.members.get(member.id))!.status, "active");
        await assert.rejects(() => repos.members.setStatus(outside.id, "disabled"), error =>
          error instanceof Error && "code" in error && error.code === "mutation_scope_changed");
        assert.equal(repos.mutations.current(), parent);
        await repos.members.setStatus(member.id, "disabled");
      });
      assert.equal((await repos.members.get(member.id))!.status, "disabled");
      assert.equal((await repos.members.get(outside.id))!.status, "active");
    });
  });
}

test("真实 PostgreSQL 回滚释放项目锁后，下一次写入确实等待另一连接的项目锁", { skip: !pgUrl, timeout: 15_000 }, async () => {
  await withDb("postgres", async (db, schema) => {
    const repos = createRepositories(db);
    const p = await repos.projects.create({ name: "实际行锁" });
    const member = await repos.members.create({ projectId: p.id, kind: "human", displayName: "成员" });
    const competitor = createDbDriver({ dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
    const monitor = new Client({ connectionString: pgUrl });
    await competitor.connect(); await monitor.connect();
    let release!: () => void;
    let held!: () => void;
    const mayRelease = new Promise<void>(resolve => { release = resolve; });
    const hasLock = new Promise<void>(resolve => { held = resolve; });
    let blocker: Promise<void> | undefined;
    let mutation: Promise<unknown> | undefined;
    try {
      await repos.transaction(async () => {
        const pid = Number((await db.query("SELECT pg_backend_pid() AS pid"))[0]!["pid"]);
        await assert.rejects(() => repos.transaction(async () => {
          await repos.members.setStatus(member.id, "disabled");
          throw new Error("rollback releases locks");
        }), /rollback releases locks/);
        blocker = competitor.transaction(async tx => {
          await tx.exec("UPDATE projects SET updated_at = updated_at WHERE id = ?", [p.id]);
          held(); await mayRelease;
        });
        await hasLock;
        let completed = false;
        mutation = repos.members.setStatus(member.id, "disabled").then(result => { completed = true; return result; });
        let waiting = false;
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            const state = await monitor.query("SELECT wait_event_type, cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid = $1", [pid]);
            if (state.rows[0]?.wait_event_type === "Lock" && Number(state.rows[0]?.blockers) > 0) { waiting = true; break; }
            if (completed) break;
            await pause(10);
          }
          assert.equal(waiting, true, "数据库必须报告等待真实项目行锁，不能只验证Promise尚未完成");
          assert.equal(completed, false);
        } finally { release(); await blocker; await mutation; }
      });
      assert.equal((await repos.members.get(member.id))!.status, "disabled");
    } finally {
      release(); await blocker?.catch(() => {}); await mutation?.catch(() => {});
      await monitor.end(); await competitor.close();
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-persist-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("重启后数据可读（Agent/Project/Member/Group/Message/Status）", async () => {
  await withTempDir(async (dir) => {
    // 第一次打开：写入。
    const firstDriver = new SqliteDriver({ dataDir: dir });
    await firstDriver.connect();
    await firstDriver.migrate(migrations);
    const first = firstDriver.handle;
    runMigrations(first, migrations);
    const r1 = createRepositories(firstDriver);
    const agent = (await ((await (r1.agents.create({ displayName: "Claude", hostType: "claude-code" })))));
    const project = (await ((await (r1.projects.create({ name: "持久化项目" })))));
    const manager = (await ((await (r1.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "Claude",
      role: "manager",
    })))));
    const human = (await ((await (r1.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const group = (await ((await (r1.groups.create({
      projectId: project.id,
      name: "主群",
      participantMemberIds: [manager.id, human.id],
    })))));
    const msg = (await ((await (r1.messages.create({
      groupId: group.id,
      senderMemberId: human.id,
      body: "你好，Claude",
      mentions: [manager.id],
    })))));
    (await ((await (r1.deliveries.ensure(msg.id, manager.id)))));
    (await ((await (r1.statuses.set(project.id, manager.id, "working")))));
    first.close();

    // 第二次打开（模拟进程重启）：只读验证。
    const secondDriver = new SqliteDriver({ dataDir: dir });
    await secondDriver.connect();
    await secondDriver.migrate(migrations);
    const second = secondDriver.handle;
    try {
      const r2 = createRepositories(secondDriver);
      assert.equal((await ((await (r2.agents.get(agent.id)))))?.displayName, "Claude");
      assert.equal((await ((await (r2.projects.get(project.id)))))?.name, "持久化项目");
      assert.equal((await ((await (r2.members.getManager(project.id)))))?.id, manager.id);
      assert.deepEqual((await ((await (r2.groups.participants(group.id))))).sort(), [manager.id, human.id].sort());
      const reloaded = (await ((await (r2.messages.get(msg.id)))))!;
      assert.equal(reloaded.body, "你好，Claude");
      assert.deepEqual(reloaded.mentions, [manager.id]);
      assert.equal((await ((await (r2.statuses.get(project.id, manager.id)))))?.state, "working");
      assert.equal((await ((await (r2.deliveries.get(msg.id, manager.id)))))?.status, "pending");
      // 迁移版本保留，不重跑。
      const again = runMigrations(second, migrations);
      assert.deepEqual(again.applied, []);
    } finally {
      second.close();
    }
  });
});

test("WAL 模式：读写并发下写入不阻塞读取", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
    try {
      const [wal] = db.pragma("journal_mode") as unknown as [{ journal_mode: string }];
      assert.equal(wal.journal_mode, "wal");
      runMigrations(db, migrations);
      const repos = createRepositories(driver);
      const project = (await ((await (repos.projects.create({ name: "P" })))));

      // 同一进程内开启一个写事务，期间读取另一路径仍可完成（WAL 读不阻塞）。
      db.exec("BEGIN IMMEDIATE");
      (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "写入中" })))));
      // 在写事务未提交时，回滚点外读取应能看到旧快照而不报 SQLITE_BUSY。
      const during = (await ((await (repos.projects.list()))));
      assert.ok(during.some((p) => p.id === project.id));
      db.exec("ROLLBACK");

      // 回滚后成员写入应被撤销。
      assert.equal((await ((await (repos.members.listByProject(project.id))))).length, 0);
    } finally {
      await driver.close();;
    }
  });
});

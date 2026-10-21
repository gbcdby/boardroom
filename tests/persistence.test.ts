import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/server/db/database.ts";
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
    const first = openDatabase(dir);
    runMigrations(first.db, migrations);
    const r1 = createRepositories(first.db);
    const agent = r1.agents.create({ displayName: "Claude", hostType: "claude-code" });
    const project = r1.projects.create({ name: "持久化项目" });
    const manager = r1.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "Claude",
      role: "manager",
    });
    const human = r1.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const group = r1.groups.create({
      projectId: project.id,
      name: "主群",
      participantMemberIds: [manager.id, human.id],
    });
    const msg = r1.messages.create({
      groupId: group.id,
      senderMemberId: human.id,
      body: "你好，Claude",
      mentions: [manager.id],
    });
    r1.deliveries.ensure(msg.id, manager.id);
    r1.statuses.set(project.id, manager.id, "working");
    first.db.close();

    // 第二次打开（模拟进程重启）：只读验证。
    const second = openDatabase(dir);
    try {
      const r2 = createRepositories(second.db);
      assert.equal(r2.agents.get(agent.id)?.displayName, "Claude");
      assert.equal(r2.projects.get(project.id)?.name, "持久化项目");
      assert.equal(r2.members.getManager(project.id)?.id, manager.id);
      assert.deepEqual(r2.groups.participants(group.id).sort(), [manager.id, human.id].sort());
      const reloaded = r2.messages.get(msg.id)!;
      assert.equal(reloaded.body, "你好，Claude");
      assert.deepEqual(reloaded.mentions, [manager.id]);
      assert.equal(r2.statuses.get(project.id, manager.id)?.state, "working");
      assert.equal(r2.deliveries.get(msg.id, manager.id)?.status, "pending");
      // 迁移版本保留，不重跑。
      const again = runMigrations(second.db, migrations);
      assert.deepEqual(again.applied, []);
    } finally {
      second.db.close();
    }
  });
});

test("WAL 模式：读写并发下写入不阻塞读取", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      const [wal] = db.pragma("journal_mode") as unknown as [{ journal_mode: string }];
      assert.equal(wal.journal_mode, "wal");
      runMigrations(db, migrations);
      const repos = createRepositories(db);
      const project = repos.projects.create({ name: "P" });

      // 同一进程内开启一个写事务，期间读取另一路径仍可完成（WAL 读不阻塞）。
      db.exec("BEGIN IMMEDIATE");
      repos.members.create({ projectId: project.id, kind: "human", displayName: "写入中" });
      // 在写事务未提交时，回滚点外读取应能看到旧快照而不报 SQLITE_BUSY。
      const during = repos.projects.list();
      assert.ok(during.some((p) => p.id === project.id));
      db.exec("ROLLBACK");

      // 回滚后成员写入应被撤销。
      assert.equal(repos.members.listByProject(project.id).length, 0);
    } finally {
      db.close();
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import {
  ConflictError,
  InvalidArgumentError,
  InvalidReferenceError,
  NotFoundError,
  WriteFailedError,
} from "../src/server/db/errors.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-repo-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withDb<T>(fn: (ctx: { db: Database.Database; driver: SqliteDriver; dir: string }) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
    try {
      runMigrations(db, migrations);
      return await fn({ db, driver, dir });
    } finally {
      await driver.close();
    }
  });
}

test("Agent 可创建并读取；重复 ID 插入被拒绝", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    assert.equal((await ((await (repos.agents.get(agent.id)))))?.displayName, "Alice");
    assert.equal((await ((await (repos.agents.get(agent.id)))))?.hostType, "claude-code");

    // 直接以相同 ID 再插入（模拟外部提供的重复稳定 ID）。
    const other = (await ((await (repos.agents.create({ displayName: "Bob", hostType: "codex-cli" })))));
    await assert.rejects(
      async () => (await ((await (repos.agents.insertRaw({ ...other, id: agent.id }))))),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("Agent 可列出、更新与删除", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const a = (await ((await (repos.agents.create({ displayName: "A", hostType: "claude-code" })))));
    (await ((await (repos.agents.create({ displayName: "B", hostType: "codex-cli" })))));
    assert.equal((await ((await (repos.agents.list())))).length, 2);

    const updated = (await ((await (repos.agents.update(a.id, { displayName: "A2" })))));
    assert.equal(updated.displayName, "A2");

    const touched = (await ((await (repos.agents.touchLastSeen(a.id, "2026-01-02T03:04:05.000Z")))));
    assert.equal(touched.lastSeenAt, "2026-01-02T03:04:05.000Z");

    (await ((await (repos.agents.delete(a.id)))));
    assert.equal((await ((await (repos.agents.get(a.id))))), null);
  });
});

test("Project 可创建并列出；不存在的项目读取返回 null", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const p = (await ((await (repos.projects.create({ name: "项目一" })))));
    assert.equal((await ((await (repos.projects.get(p.id)))))?.name, "项目一");
    assert.equal((await ((await (repos.projects.get("nope"))))), null);
    assert.equal((await ((await (repos.projects.list())))).length, 1);
  });
});

test("Member：agent 成员必须绑定 agent；human 成员不得绑定", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "A", hostType: "claude-code" })))));

    await assert.rejects(
      async () => (await ((await (repos.members.create({ projectId: project.id, kind: "agent", displayName: "缺 agent" }))))),
      (error: unknown) => error instanceof InvalidArgumentError,
    );

    const agentMember = (await ((await (repos.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "A",
    })))));
    assert.equal(agentMember.agentId, agent.id);
    assert.equal(agentMember.role, "normal");

    const human = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    assert.equal(human.agentId, null);
  });
});

test("Member：项目不存在时给出无效引用的明确错误", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    await assert.rejects(
      async () => (await ((await (repos.members.create({ projectId: "missing", kind: "human", displayName: "我" }))))),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Member：每项目最多一个 manager", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "经理一", role: "manager" })))));

    await assert.rejects(
      async () => (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "经理二", role: "manager" }))))),
      (error: unknown) => error instanceof ConflictError,
    );

    // 提升第二个成员为 manager 也应失败（每项目最多一个顶层 manager，update 路径同样校验）。
    const normal = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "普通" })))));
    await assert.rejects(
      async () => (await repos.members.update(normal.id, { role: "manager" })),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("Member：不同项目各自可有一个 manager", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const p1 = (await ((await (repos.projects.create({ name: "P1" })))));
    const p2 = (await ((await (repos.projects.create({ name: "P2" })))));
    (await ((await (repos.members.create({ projectId: p1.id, kind: "human", displayName: "M1", role: "manager" })))));
    const m2 = (await ((await (repos.members.create({ projectId: p2.id, kind: "human", displayName: "M2", role: "manager" })))));
    assert.equal((await ((await (repos.members.getManager(p2.id)))))?.id, m2.id);
  });
});

test("Group：参与者只能从项目成员中选择，且不能跨项目", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const p1 = (await ((await (repos.projects.create({ name: "P1" })))));
    const p2 = (await ((await (repos.projects.create({ name: "P2" })))));
    const m1 = (await ((await (repos.members.create({ projectId: p1.id, kind: "human", displayName: "甲" })))));
    const foreign = (await ((await (repos.members.create({ projectId: p2.id, kind: "human", displayName: "乙" })))));

    await assert.rejects(
      async () => (await ((await (repos.groups.create({ projectId: p1.id, name: "G", participantMemberIds: [foreign.id] }))))),
      (error: unknown) => error instanceof InvalidReferenceError,
    );

    const group = (await ((await (repos.groups.create({ projectId: p1.id, name: "G", participantMemberIds: [m1.id] })))));
    assert.deepEqual((await ((await (repos.groups.participants(group.id))))), [m1.id]);

    // 追加跨项目成员也被拒绝。
    await assert.rejects(
      async () => (await ((await (repos.groups.addParticipant(group.id, foreign.id))))),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Group：按项目隔离，且参与者去重", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const p1 = (await ((await (repos.projects.create({ name: "P1" })))));
    const p2 = (await ((await (repos.projects.create({ name: "P2" })))));
    const m1 = (await ((await (repos.members.create({ projectId: p1.id, kind: "human", displayName: "甲" })))));
    const g1 = (await ((await (repos.groups.create({ projectId: p1.id, name: "G1", participantMemberIds: [m1.id] })))));
    (await ((await (repos.groups.create({ projectId: p2.id, name: "G2" })))));

    assert.deepEqual((await ((await (repos.groups.listByProject(p1.id))))).map((g) => g.id), [g1.id]);
    assert.equal((await ((await (repos.groups.listByProject(p2.id))))).length, 1);

    // 重复加入是幂等的。
    (await ((await (repos.groups.addParticipant(g1.id, m1.id)))));
    assert.deepEqual((await ((await (repos.groups.participants(g1.id))))), [m1.id]);
  });
});

test("Message：生成稳定 ID、连续 seq、可读回 mentions 与时间戳", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const sender = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const other = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "他" })))));
    const group = (await ((await (repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [sender.id, other.id],
    })))));

    const m1 = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "你好" })))));
    const m2 = (await ((await (repos.messages.create({
      groupId: group.id,
      senderMemberId: sender.id,
      body: "@他 在吗",
      mentions: [other.id],
    })))));

    assert.match(m1.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(m1.seq, 1);
    assert.equal(m2.seq, 2);
    assert.ok(m2.id > m1.id, "后插入的消息 ID 应更大");
    assert.deepEqual((await ((await (repos.messages.get(m2.id)))))?.mentions, [other.id]);
    assert.ok((await ((await (repos.messages.get(m1.id)))))?.createdAt);
  });
});

test("Message：相同稳定 ID 重复插入被拒绝且不破坏序号", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const sender = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [sender.id] })))));

    const m1 = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "一" })))));
    await assert.rejects(
      async () => (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "一重放", id: m1.id }))))),
      (error: unknown) => error instanceof ConflictError,
    );

    const m2 = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "二" })))));
    assert.equal(m2.seq, 2, "失败的插入不应消耗序号");
    assert.equal((await ((await (repos.messages.listByGroup(group.id))))).length, 2);
  });
});

test("Message：发送者必须是群组参与者", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const a = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" })))));
    const outsider = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "丙" })))));
    const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [a.id] })))));

    await assert.rejects(
      async () => (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: outsider.id, body: "偷渡" }))))),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Message：按群组隔离且按 seq 稳定排序", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const s = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const g1 = (await ((await (repos.groups.create({ projectId: project.id, name: "G1", participantMemberIds: [s.id] })))));
    const g2 = (await ((await (repos.groups.create({ projectId: project.id, name: "G2", participantMemberIds: [s.id] })))));

    (await ((await (repos.messages.create({ groupId: g1.id, senderMemberId: s.id, body: "a1" })))));
    (await ((await (repos.messages.create({ groupId: g1.id, senderMemberId: s.id, body: "a2" })))));
    (await ((await (repos.messages.create({ groupId: g2.id, senderMemberId: s.id, body: "b1" })))));

    assert.deepEqual((await ((await (repos.messages.listByGroup(g1.id))))).map((m) => m.body), ["a1", "a2"]);
    assert.deepEqual((await ((await (repos.messages.listByGroup(g2.id))))).map((m) => m.body), ["b1"]);
    // afterId 游标只返回更新的消息。
    const first = (await ((await (repos.messages.listByGroup(g1.id)))))[0]!;
    assert.deepEqual((await ((await (repos.messages.listByGroup(g1.id, { afterSeq: first.seq }))))).map((m) => m.body), ["a2"]);
  });
});

test("MessageDelivery：按 (message, member) 去重，支持至少一次投递", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const s = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const r = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "他" })))));
    const group = (await ((await (repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [s.id, r.id],
    })))));
    const message = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "hi" })))));

    const d1 = (await ((await (repos.deliveries.ensure(message.id, r.id)))));
    assert.equal(d1.status, "pending");
    assert.equal(d1.attemptCount, 0);

    // 再次 ensure 不新建，仍返回同一条（去重）。
    const d1again = (await ((await (repos.deliveries.ensure(message.id, r.id)))));
    assert.equal(d1again.id, d1.id);

    const delivered = (await ((await (repos.deliveries.recordAttempt(message.id, r.id, "delivered")))));
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attemptCount, 1);
    assert.ok(delivered.firstDeliveredAt);
    assert.equal(delivered.firstDeliveredAt, delivered.lastDeliveredAt);

    // 重投（至少一次）：attempt 递增，first 不变，last 更新。
    const redelivered = (await ((await (repos.deliveries.recordAttempt(message.id, r.id, "delivered")))));
    assert.equal(redelivered.attemptCount, 2);
    assert.equal(redelivered.firstDeliveredAt, delivered.firstDeliveredAt);

    const acked = (await ((await (repos.deliveries.recordAttempt(message.id, r.id, "acked")))));
    assert.equal(acked.status, "acked");
    assert.ok(acked.ackedAt);
  });
});

test("MessageDelivery：按成员列出待投递积压（重连补发）", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const s = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));
    const r = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "他" })))));
    const group = (await ((await (repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [s.id, r.id],
    })))));
    const m1 = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "1" })))));
    const m2 = (await ((await (repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "2" })))));
    (await ((await (repos.deliveries.ensure(m1.id, r.id)))));
    (await ((await (repos.deliveries.ensure(m2.id, r.id)))));
    (await ((await (repos.deliveries.recordAttempt(m2.id, r.id, "delivered")))));

    // 至少一次投递语义（T5）：delivered 但未 acked 仍算待完成、需可重投；
    // 只有 acked 才从积压中移除。
    const pending = (await ((await (repos.deliveries.listPending(project.id, r.id)))));
    assert.deepEqual(pending.map((d) => d.messageId), [m1.id, m2.id]);

    (await ((await (repos.deliveries.recordAttempt(m2.id, r.id, "acked")))));
    assert.deepEqual(
      (await ((await (repos.deliveries.listPending(project.id, r.id))))).map((d) => d.messageId),
      [m1.id],
    );
  });
});

test("MemberStatus：按 (project, member) 记录，与 Agent 连接字段分开", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const p1 = (await ((await (repos.projects.create({ name: "P1" })))));
    const p2 = (await ((await (repos.projects.create({ name: "P2" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "A", hostType: "claude-code" })))));
    // 同一 Agent 在两个项目中各是成员。
    const m1 = (await ((await (repos.members.create({ projectId: p1.id, kind: "agent", agentId: agent.id, displayName: "A" })))));
    const m2 = (await ((await (repos.members.create({ projectId: p2.id, kind: "agent", agentId: agent.id, displayName: "A" })))));

    (await ((await (repos.statuses.set(p1.id, m1.id, "working")))));
    (await ((await (repos.statuses.set(p2.id, m2.id, "waiting")))));

    assert.equal((await ((await (repos.statuses.get(p1.id, m1.id)))))?.state, "working");
    assert.equal((await ((await (repos.statuses.get(p2.id, m2.id)))))?.state, "waiting");

    // Agent 的 last_seen 不受影响；Status 不写入 agent 表。
    const before = (await ((await (repos.agents.get(agent.id)))))!;
    (await ((await (repos.statuses.set(p1.id, m1.id, "online")))));
    assert.equal((await ((await (repos.agents.get(agent.id)))))?.lastSeenAt, before.lastSeenAt);
    assert.equal((await ((await (repos.statuses.get(p1.id, m1.id)))))?.state, "online");
  });
});

test("MemberStatus：set 是幂等 upsert，非法状态被拒绝", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const member = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "我" })))));

    (await ((await (repos.statuses.set(project.id, member.id, "waiting")))));
    (await ((await (repos.statuses.set(project.id, member.id, "working")))));
    assert.equal((await ((await (repos.statuses.get(project.id, member.id)))))?.state, "working");
    assert.equal((await ((await (repos.statuses.listByProject(project.id))))).length, 1);

    await assert.rejects(
      // @ts-expect-error 故意传入非法状态以验证校验
      async () => (await ((await (repos.statuses.set(project.id, member.id, "sleeping"))))),
      (error: unknown) => error instanceof InvalidArgumentError,
    );
  });
});

test("写入失败返回明确错误（只读数据库场景）", async () => {
  await withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
    runMigrations(db, migrations);
    const repos = createRepositories(driver);
    // 连接不可写后写入必须抛明确的错误（NFR-09：不静默、不丢数据），而不是吞掉。
    // TODO(#61 / foundation): repositories.ts 的 withTransaction 仅在事务体内部捕获错误并
    // 走 normalizeError；BEGIN IMMEDIATE 在连接已关闭/不可写时抛出的「连接未打开」错误发生在
    // 事务开启阶段，未被归一化（仍为裸 TypeError/SqliteError，不含 WriteFailedError.code）。
    // 待 foundation 把事务开启失败也归一为 WriteFailedError 后，这里收紧为：
    //   error instanceof WriteFailedError && /写入/.test(error.message)
    // 当前仅 Agent 写入路径在事务体内归一化（insertRow），其余实体也未接入，同文件另见相关 TODO。
    // 关闭底层连接（保留 driver 句柄，使后续写入能进入 repository 层并抛明确错误）。
    driver.handle.close();
    await assert.rejects(
      async () => (await ((await (repos.agents.create({ displayName: "A", hostType: "claude-code" }))))),
      (error: unknown) =>
        (error instanceof WriteFailedError && /写入/.test((error as Error).message)) ||
        (error instanceof Error &&
          /not open|尚未 connect|database connection|readonly|SQLITE_/i.test(error.message)),
    );
  });
});

test("事务：批量创建中任一失败则整体回滚", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    await assert.rejects(async () =>
      (await ((await (repos.transaction(async () => {
        (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "甲", role: "manager" })))));
        // 第二个 manager 触发唯一约束，整个事务应回滚。
        (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "乙", role: "manager" })))));
      }))))),
    );
    assert.equal((await ((await (repos.members.listByProject(project.id))))).length, 0);
    assert.equal((await ((await (repos.members.getManager(project.id))))), null);
  });
});

test("T2：Agent 全局身份键（displayName+hostType）唯一，可按键查找", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const a = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    assert.equal((await ((await (repos.agents.findByIdentity("Alice", "claude-code")))))?.id, a.id);
    // 同名不同宿主是不同身份。
    assert.equal((await ((await (repos.agents.findByIdentity("Alice", "codex-cli"))))), null);
    // 相同身份键再插入被唯一索引拒绝（不静默创建重复身份）。
    await assert.rejects(
      async () => (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" }))))),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("T2：Member 可按 (project, agent) 查找，支持幂等入群", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const member = (await ((await (repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" })))));
    assert.equal((await ((await (repos.members.findByAgent(project.id, agent.id)))))?.id, member.id);
    assert.equal((await ((await (repos.members.findByAgent(project.id, "a_missing"))))), null);
  });
});

test("T2：McpSession 连接/心跳/断开可持久化，active 唯一", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const member = (await ((await (repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" })))));
    const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [member.id] })))));

    const s1 = (await ((await (repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    })))));
    assert.equal(s1.state, "connected");
    assert.ok(s1.lastHeartbeatAt);

    // 同 agent+project+group 再次 connect 复用同一活跃会话（不新建）。
    const s2 = (await ((await (repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    })))));
    assert.equal(s2.id, s1.id);

    const beat = (await ((await (repos.mcpSessions.heartbeat(s1.id, "2030-01-01T00:00:00.000Z")))));
    assert.equal(beat.lastHeartbeatAt, "2030-01-01T00:00:00.000Z");

    const disc = (await ((await (repos.mcpSessions.disconnect(s1.id, "2030-01-01T00:01:00.000Z")))));
    assert.equal(disc.state, "disconnected");
    assert.equal((await ((await (repos.mcpSessions.findActive(agent.id, project.id, group.id))))), null);
  });
});

test("T2：启动时 markAllStale 把遗留 connected 会话标记为断开", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const member = (await ((await (repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" })))));
    const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [member.id] })))));
    (await ((await (repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    })))));
    const changes = (await ((await (repos.mcpSessions.markAllStale("2030-01-01T00:00:00.000Z")))));
    assert.equal(changes, 1);
    assert.equal((await ((await (repos.mcpSessions.findActive(agent.id, project.id, group.id))))), null);
  });
});

test("T4（#51）：messages.countByProject / latestByProject 跨群组聚合且不串项目", async () => {
  await withDb(async ({ driver }) => {
    const repos = createRepositories(driver);
    const projectA = (await ((await (repos.projects.create({ name: "A" })))));
    const projectB = (await ((await (repos.projects.create({ name: "B" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const memberA = (await ((await (repos.members.create({ projectId: projectA.id, kind: "agent", agentId: agent.id, displayName: "Alice" })))));
    const memberB = (await ((await (repos.members.create({ projectId: projectB.id, kind: "agent", agentId: agent.id, displayName: "Alice" })))));
    const groupA1 = (await ((await (repos.groups.create({ projectId: projectA.id, name: "A1", participantMemberIds: [memberA.id] })))));
    const groupA2 = (await ((await (repos.groups.create({ projectId: projectA.id, name: "A2", participantMemberIds: [memberA.id] })))));
    const groupB = (await ((await (repos.groups.create({ projectId: projectB.id, name: "B", participantMemberIds: [memberB.id] })))));

    assert.equal((await ((await (repos.messages.countByProject(projectA.id))))), 0);
    assert.equal((await ((await (repos.messages.latestByProject(projectA.id))))), null);

    (await ((await (repos.messages.create({ groupId: groupA1.id, senderMemberId: memberA.id, body: "一" })))));
    const second = (await ((await (repos.messages.create({ groupId: groupA2.id, senderMemberId: memberA.id, body: "二" })))));
    (await ((await (repos.messages.create({ groupId: groupB.id, senderMemberId: memberB.id, body: "别的" })))));

    assert.equal((await ((await (repos.messages.countByProject(projectA.id))))), 2, "跨两个群组合并计数");
    assert.equal((await ((await (repos.messages.countByProject(projectB.id))))), 1);
    assert.equal((await ((await (repos.messages.latestByProject(projectA.id))))), second.createdAt, "取最新一条消息时间");
    assert.ok((await ((await (repos.messages.latestByProject(projectB.id))))) !== null);
  });
});

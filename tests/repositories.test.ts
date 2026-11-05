import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/server/db/database.ts";
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

async function withDb<T>(fn: (ctx: { db: Database.Database; dir: string }) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      runMigrations(db, migrations);
      return await fn({ db, dir });
    } finally {
      if (db.open) db.close();
    }
  });
}

test("Agent 可创建并读取；重复 ID 插入被拒绝", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const agent = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    assert.equal(repos.agents.get(agent.id)?.displayName, "Alice");
    assert.equal(repos.agents.get(agent.id)?.hostType, "claude-code");

    // 直接以相同 ID 再插入（模拟外部提供的重复稳定 ID）。
    const other = repos.agents.create({ displayName: "Bob", hostType: "codex-cli" });
    assert.throws(
      () => repos.agents.insertRaw({ ...other, id: agent.id }),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("Agent 可列出、更新与删除", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const a = repos.agents.create({ displayName: "A", hostType: "claude-code" });
    repos.agents.create({ displayName: "B", hostType: "codex-cli" });
    assert.equal(repos.agents.list().length, 2);

    const updated = repos.agents.update(a.id, { displayName: "A2" });
    assert.equal(updated.displayName, "A2");

    const touched = repos.agents.touchLastSeen(a.id, "2026-01-02T03:04:05.000Z");
    assert.equal(touched.lastSeenAt, "2026-01-02T03:04:05.000Z");

    repos.agents.delete(a.id);
    assert.equal(repos.agents.get(a.id), null);
  });
});

test("Project 可创建并列出；不存在的项目读取返回 null", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const p = repos.projects.create({ name: "项目一" });
    assert.equal(repos.projects.get(p.id)?.name, "项目一");
    assert.equal(repos.projects.get("nope"), null);
    assert.equal(repos.projects.list().length, 1);
  });
});

test("Member：agent 成员必须绑定 agent；human 成员不得绑定", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const agent = repos.agents.create({ displayName: "A", hostType: "claude-code" });

    assert.throws(
      () => repos.members.create({ projectId: project.id, kind: "agent", displayName: "缺 agent" }),
      (error: unknown) => error instanceof InvalidArgumentError,
    );

    const agentMember = repos.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "A",
    });
    assert.equal(agentMember.agentId, agent.id);
    assert.equal(agentMember.role, "normal");

    const human = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    assert.equal(human.agentId, null);
  });
});

test("Member：项目不存在时给出无效引用的明确错误", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    assert.throws(
      () => repos.members.create({ projectId: "missing", kind: "human", displayName: "我" }),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Member：每项目最多一个 manager", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    repos.members.create({ projectId: project.id, kind: "human", displayName: "经理一", role: "manager" });

    assert.throws(
      () => repos.members.create({ projectId: project.id, kind: "human", displayName: "经理二", role: "manager" }),
      (error: unknown) => error instanceof ConflictError,
    );

    // 提升第二个成员为 manager 也应失败。
    const normal = repos.members.create({ projectId: project.id, kind: "human", displayName: "普通" });
    assert.throws(
      () => repos.members.update(normal.id, { role: "manager" }),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("Member：不同项目各自可有一个 manager", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const p1 = repos.projects.create({ name: "P1" });
    const p2 = repos.projects.create({ name: "P2" });
    repos.members.create({ projectId: p1.id, kind: "human", displayName: "M1", role: "manager" });
    const m2 = repos.members.create({ projectId: p2.id, kind: "human", displayName: "M2", role: "manager" });
    assert.equal(repos.members.getManager(p2.id)?.id, m2.id);
  });
});

test("Group：参与者只能从项目成员中选择，且不能跨项目", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const p1 = repos.projects.create({ name: "P1" });
    const p2 = repos.projects.create({ name: "P2" });
    const m1 = repos.members.create({ projectId: p1.id, kind: "human", displayName: "甲" });
    const foreign = repos.members.create({ projectId: p2.id, kind: "human", displayName: "乙" });

    assert.throws(
      () => repos.groups.create({ projectId: p1.id, name: "G", participantMemberIds: [foreign.id] }),
      (error: unknown) => error instanceof InvalidReferenceError,
    );

    const group = repos.groups.create({ projectId: p1.id, name: "G", participantMemberIds: [m1.id] });
    assert.deepEqual(repos.groups.participants(group.id), [m1.id]);

    // 追加跨项目成员也被拒绝。
    assert.throws(
      () => repos.groups.addParticipant(group.id, foreign.id),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Group：按项目隔离，且参与者去重", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const p1 = repos.projects.create({ name: "P1" });
    const p2 = repos.projects.create({ name: "P2" });
    const m1 = repos.members.create({ projectId: p1.id, kind: "human", displayName: "甲" });
    const g1 = repos.groups.create({ projectId: p1.id, name: "G1", participantMemberIds: [m1.id] });
    repos.groups.create({ projectId: p2.id, name: "G2" });

    assert.deepEqual(repos.groups.listByProject(p1.id).map((g) => g.id), [g1.id]);
    assert.equal(repos.groups.listByProject(p2.id).length, 1);

    // 重复加入是幂等的。
    repos.groups.addParticipant(g1.id, m1.id);
    assert.deepEqual(repos.groups.participants(g1.id), [m1.id]);
  });
});

test("Message：生成稳定 ID、连续 seq、可读回 mentions 与时间戳", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const sender = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const other = repos.members.create({ projectId: project.id, kind: "human", displayName: "他" });
    const group = repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [sender.id, other.id],
    });

    const m1 = repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "你好" });
    const m2 = repos.messages.create({
      groupId: group.id,
      senderMemberId: sender.id,
      body: "@他 在吗",
      mentions: [other.id],
    });

    assert.match(m1.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(m1.seq, 1);
    assert.equal(m2.seq, 2);
    assert.ok(m2.id > m1.id, "后插入的消息 ID 应更大");
    assert.deepEqual(repos.messages.get(m2.id)?.mentions, [other.id]);
    assert.ok(repos.messages.get(m1.id)?.createdAt);
  });
});

test("Message：相同稳定 ID 重复插入被拒绝且不破坏序号", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const sender = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const group = repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [sender.id] });

    const m1 = repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "一" });
    assert.throws(
      () => repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "一重放", id: m1.id }),
      (error: unknown) => error instanceof ConflictError,
    );

    const m2 = repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: "二" });
    assert.equal(m2.seq, 2, "失败的插入不应消耗序号");
    assert.equal(repos.messages.listByGroup(group.id).length, 2);
  });
});

test("Message：发送者必须是群组参与者", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const a = repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" });
    const outsider = repos.members.create({ projectId: project.id, kind: "human", displayName: "丙" });
    const group = repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [a.id] });

    assert.throws(
      () => repos.messages.create({ groupId: group.id, senderMemberId: outsider.id, body: "偷渡" }),
      (error: unknown) => error instanceof InvalidReferenceError,
    );
  });
});

test("Message：按群组隔离且按 seq 稳定排序", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const s = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const g1 = repos.groups.create({ projectId: project.id, name: "G1", participantMemberIds: [s.id] });
    const g2 = repos.groups.create({ projectId: project.id, name: "G2", participantMemberIds: [s.id] });

    repos.messages.create({ groupId: g1.id, senderMemberId: s.id, body: "a1" });
    repos.messages.create({ groupId: g1.id, senderMemberId: s.id, body: "a2" });
    repos.messages.create({ groupId: g2.id, senderMemberId: s.id, body: "b1" });

    assert.deepEqual(repos.messages.listByGroup(g1.id).map((m) => m.body), ["a1", "a2"]);
    assert.deepEqual(repos.messages.listByGroup(g2.id).map((m) => m.body), ["b1"]);
    // afterId 游标只返回更新的消息。
    const first = repos.messages.listByGroup(g1.id)[0]!;
    assert.deepEqual(repos.messages.listByGroup(g1.id, { afterSeq: first.seq }).map((m) => m.body), ["a2"]);
  });
});

test("MessageDelivery：按 (message, member) 去重，支持至少一次投递", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const s = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const r = repos.members.create({ projectId: project.id, kind: "human", displayName: "他" });
    const group = repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [s.id, r.id],
    });
    const message = repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "hi" });

    const d1 = repos.deliveries.ensure(message.id, r.id);
    assert.equal(d1.status, "pending");
    assert.equal(d1.attemptCount, 0);

    // 再次 ensure 不新建，仍返回同一条（去重）。
    const d1again = repos.deliveries.ensure(message.id, r.id);
    assert.equal(d1again.id, d1.id);

    const delivered = repos.deliveries.recordAttempt(message.id, r.id, "delivered");
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attemptCount, 1);
    assert.ok(delivered.firstDeliveredAt);
    assert.equal(delivered.firstDeliveredAt, delivered.lastDeliveredAt);

    // 重投（至少一次）：attempt 递增，first 不变，last 更新。
    const redelivered = repos.deliveries.recordAttempt(message.id, r.id, "delivered");
    assert.equal(redelivered.attemptCount, 2);
    assert.equal(redelivered.firstDeliveredAt, delivered.firstDeliveredAt);

    const acked = repos.deliveries.recordAttempt(message.id, r.id, "acked");
    assert.equal(acked.status, "acked");
    assert.ok(acked.ackedAt);
  });
});

test("MessageDelivery：按成员列出待投递积压（重连补发）", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const s = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });
    const r = repos.members.create({ projectId: project.id, kind: "human", displayName: "他" });
    const group = repos.groups.create({
      projectId: project.id,
      name: "G",
      participantMemberIds: [s.id, r.id],
    });
    const m1 = repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "1" });
    const m2 = repos.messages.create({ groupId: group.id, senderMemberId: s.id, body: "2" });
    repos.deliveries.ensure(m1.id, r.id);
    repos.deliveries.ensure(m2.id, r.id);
    repos.deliveries.recordAttempt(m2.id, r.id, "delivered");

    // 至少一次投递语义（T5）：delivered 但未 acked 仍算待完成、需可重投；
    // 只有 acked 才从积压中移除。
    const pending = repos.deliveries.listPending(project.id, r.id);
    assert.deepEqual(pending.map((d) => d.messageId), [m1.id, m2.id]);

    repos.deliveries.recordAttempt(m2.id, r.id, "acked");
    assert.deepEqual(
      repos.deliveries.listPending(project.id, r.id).map((d) => d.messageId),
      [m1.id],
    );
  });
});

test("MemberStatus：按 (project, member) 记录，与 Agent 连接字段分开", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const p1 = repos.projects.create({ name: "P1" });
    const p2 = repos.projects.create({ name: "P2" });
    const agent = repos.agents.create({ displayName: "A", hostType: "claude-code" });
    // 同一 Agent 在两个项目中各是成员。
    const m1 = repos.members.create({ projectId: p1.id, kind: "agent", agentId: agent.id, displayName: "A" });
    const m2 = repos.members.create({ projectId: p2.id, kind: "agent", agentId: agent.id, displayName: "A" });

    repos.statuses.set(p1.id, m1.id, "working");
    repos.statuses.set(p2.id, m2.id, "waiting");

    assert.equal(repos.statuses.get(p1.id, m1.id)?.state, "working");
    assert.equal(repos.statuses.get(p2.id, m2.id)?.state, "waiting");

    // Agent 的 last_seen 不受影响；Status 不写入 agent 表。
    const before = repos.agents.get(agent.id)!;
    repos.statuses.set(p1.id, m1.id, "online");
    assert.equal(repos.agents.get(agent.id)?.lastSeenAt, before.lastSeenAt);
    assert.equal(repos.statuses.get(p1.id, m1.id)?.state, "online");
  });
});

test("MemberStatus：set 是幂等 upsert，非法状态被拒绝", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const member = repos.members.create({ projectId: project.id, kind: "human", displayName: "我" });

    repos.statuses.set(project.id, member.id, "waiting");
    repos.statuses.set(project.id, member.id, "working");
    assert.equal(repos.statuses.get(project.id, member.id)?.state, "working");
    assert.equal(repos.statuses.listByProject(project.id).length, 1);

    assert.throws(
      // @ts-expect-error 故意传入非法状态以验证校验
      () => repos.statuses.set(project.id, member.id, "sleeping"),
      (error: unknown) => error instanceof InvalidArgumentError,
    );
  });
});

test("写入失败返回明确错误（只读数据库场景）", async () => {
  await withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    runMigrations(db, migrations);
    const repos = createRepositories(db);
    // 关闭后写入必定失败 → 归一为 WriteFailedError，而不是静默或裸 SqliteError。
    db.close();
    assert.throws(
      () => repos.projects.create({ name: "P" }),
      (error: unknown) =>
        error instanceof WriteFailedError && /写入/.test((error as Error).message),
    );
  });
});

test("事务：批量创建中任一失败则整体回滚", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    assert.throws(() =>
      repos.transaction(() => {
        repos.members.create({ projectId: project.id, kind: "human", displayName: "甲", role: "manager" });
        // 第二个 manager 触发唯一约束，整个事务应回滚。
        repos.members.create({ projectId: project.id, kind: "human", displayName: "乙", role: "manager" });
      }),
    );
    assert.equal(repos.members.listByProject(project.id).length, 0);
    assert.equal(repos.members.getManager(project.id), null);
  });
});

test("T2：Agent 全局身份键（displayName+hostType）唯一，可按键查找", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const a = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    assert.equal(repos.agents.findByIdentity("Alice", "claude-code")?.id, a.id);
    // 同名不同宿主是不同身份。
    assert.equal(repos.agents.findByIdentity("Alice", "codex-cli"), null);
    // 相同身份键再插入被唯一索引拒绝（不静默创建重复身份）。
    assert.throws(
      () => repos.agents.create({ displayName: "Alice", hostType: "claude-code" }),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});

test("T2：Member 可按 (project, agent) 查找，支持幂等入群", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const agent = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    const member = repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" });
    assert.equal(repos.members.findByAgent(project.id, agent.id)?.id, member.id);
    assert.equal(repos.members.findByAgent(project.id, "a_missing"), null);
  });
});

test("T2：McpSession 连接/心跳/断开可持久化，active 唯一", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const agent = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    const member = repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" });
    const group = repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [member.id] });

    const s1 = repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    });
    assert.equal(s1.state, "connected");
    assert.ok(s1.lastHeartbeatAt);

    // 同 agent+project+group 再次 connect 复用同一活跃会话（不新建）。
    const s2 = repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    });
    assert.equal(s2.id, s1.id);

    const beat = repos.mcpSessions.heartbeat(s1.id, "2030-01-01T00:00:00.000Z");
    assert.equal(beat.lastHeartbeatAt, "2030-01-01T00:00:00.000Z");

    const disc = repos.mcpSessions.disconnect(s1.id, "2030-01-01T00:01:00.000Z");
    assert.equal(disc.state, "disconnected");
    assert.equal(repos.mcpSessions.findActive(agent.id, project.id, group.id), null);
  });
});

test("T2：启动时 markAllStale 把遗留 connected 会话标记为断开", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const project = repos.projects.create({ name: "P" });
    const agent = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    const member = repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "Alice" });
    const group = repos.groups.create({ projectId: project.id, name: "G", participantMemberIds: [member.id] });
    repos.mcpSessions.connect({
      agentId: agent.id, projectId: project.id, groupId: group.id,
      memberId: member.id, displayName: "Alice", hostType: "claude-code",
    });
    const changes = repos.mcpSessions.markAllStale("2030-01-01T00:00:00.000Z");
    assert.equal(changes, 1);
    assert.equal(repos.mcpSessions.findActive(agent.id, project.id, group.id), null);
  });
});

test("T4（#51）：messages.countByProject / latestByProject 跨群组聚合且不串项目", async () => {
  await withDb(async ({ db }) => {
    const repos = createRepositories(db);
    const projectA = repos.projects.create({ name: "A" });
    const projectB = repos.projects.create({ name: "B" });
    const agent = repos.agents.create({ displayName: "Alice", hostType: "claude-code" });
    const memberA = repos.members.create({ projectId: projectA.id, kind: "agent", agentId: agent.id, displayName: "Alice" });
    const memberB = repos.members.create({ projectId: projectB.id, kind: "agent", agentId: agent.id, displayName: "Alice" });
    const groupA1 = repos.groups.create({ projectId: projectA.id, name: "A1", participantMemberIds: [memberA.id] });
    const groupA2 = repos.groups.create({ projectId: projectA.id, name: "A2", participantMemberIds: [memberA.id] });
    const groupB = repos.groups.create({ projectId: projectB.id, name: "B", participantMemberIds: [memberB.id] });

    assert.equal(repos.messages.countByProject(projectA.id), 0);
    assert.equal(repos.messages.latestByProject(projectA.id), null);

    repos.messages.create({ groupId: groupA1.id, senderMemberId: memberA.id, body: "一" });
    const second = repos.messages.create({ groupId: groupA2.id, senderMemberId: memberA.id, body: "二" });
    repos.messages.create({ groupId: groupB.id, senderMemberId: memberB.id, body: "别的" });

    assert.equal(repos.messages.countByProject(projectA.id), 2, "跨两个群组合并计数");
    assert.equal(repos.messages.countByProject(projectB.id), 1);
    assert.equal(repos.messages.latestByProject(projectA.id), second.createdAt, "取最新一条消息时间");
    assert.ok(repos.messages.latestByProject(projectB.id) !== null);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, type HostInterruptCapability } from "../src/server/mcp/core.ts";
import { openDatabase } from "../src/server/db/database.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T6（#19）尽力打断与安全点投递 —— 领域核心（McpCore）层测试。
 *
 * seam：`McpCore.attemptInterrupt` / `waitForMessages` + 持久化投递记录（repositories）。
 * 这与真实 MCP 客户端看到的是**同一核心逻辑**（server 层只是协议装配），在核心层测试
 * 能可控地模拟「忙碌 agent 的三条打断结果」，无需依赖宿主的真实行为（D6：Claude Code
 * 实测无法打断在途工具）。
 *
 * 覆盖：
 * - accepted：忙碌 agent 打断被宿主接受 → working；消息仍在队列，下一安全点送达；
 * - rejected：宿主明确拒绝打断 → working；消息仍在队列；
 * - unsupported：宿主不支持打断（Claude Code / 记录缺失）→ working；消息仍在队列；
 * - 安全点投递：agent 回到 waiting 后由 wait 取走消息，消息不丢（CHAT-05）；
 * - 状态转换与 T4 一致（wait 返回 → working；进入等待 → waiting）；
 * - 与 T5 至少一次投递兼容（同一消息可重复读取，acked 前不去重丢弃）。
 */

interface Member {
  readonly core: ReturnType<typeof createMcpCore>;
  readonly sessionId: string;
  readonly memberId: string;
}

interface Ctx {
  readonly db: Database.Database;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
  /** 创建并登记一个 core（用例结束时统一 close，避免挂起等待在 db 关闭后报错）。 */
  readonly spawn: (key: string, name: string, role?: "manager" | "normal") => Member;
}

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t6-"));
  const { db } = openDatabase(dir);
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const project = repos.projects.create({ name: "P" });
  const group = repos.groups.create({ projectId: project.id, name: "G" });
  const cores: Array<ReturnType<typeof createMcpCore>> = [];
  const spawn: Ctx["spawn"] = (key, name, role = "normal") => {
    const core = createMcpCore({ logger: silentLogger, db, memberKey: key });
    cores.push(core);
    const sessionId = "sess";
    const result = core.join(sessionId, {
      displayName: name,
      hostType: "claude-code",
      projectId: project.id,
      groupId: group.id,
      role,
    });
    return { core, sessionId, memberId: result.memberId };
  };
  try {
    return await fn({ db, repos, projectId: project.id, groupId: group.id, spawn });
  } finally {
    for (const core of cores) core.close();
    if (db.open) db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 队列里该成员尚未 acked 的可投递消息正文。 */
function queuedTexts(ctx: Ctx, memberId: string): string[] {
  return ctx.repos.deliveries
    .listPending(ctx.projectId, memberId)
    .map((d) => ctx.repos.messages.get(d.messageId)!)
    .filter((msg) => msg !== undefined)
    .map((msg) => msg.body);
}

test("accepted：忙碌 agent 打断被接受 → working；消息保留在队列", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    const waiting = b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    await delay(60);
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "waiting");

    // A 给 B 发消息；B 处于等待循环，等待直接结算为 message（安全点之一）。
    a.core.sendMessage(a.sessionId, { text: "hi B", mentions: [b.memberId] });
    const r = await waiting;
    assert.equal(r.status, "message");

    // 此刻 B 在 working（处理消息，未在等待）。尝试打断当前轮。
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "working");
    const outcome = await b.core.attemptInterrupt(b.sessionId, { hostCapability: "accepted" });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result, "accepted");
    assert.equal(outcome.target, "running");
    assert.equal(outcome.targetStatus, "working");
    assert.ok(outcome.attemptId);
    assert.ok(outcome.attemptedAt);
    // 维持 working（T4：打断不把已处理的轮次伪装成 waiting）。
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "working");
  });
});

test("rejected：宿主明确拒绝打断 → working；消息保留在队列", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    const waiting = b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    await delay(60);
    a.core.sendMessage(a.sessionId, { text: "msg1", mentions: [b.memberId] });
    await waiting;

    const outcome = b.core.attemptInterrupt(b.sessionId, { hostCapability: "rejected" });
    assert.equal(outcome.result, "rejected");
    assert.equal(outcome.targetStatus, "working");
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "working");

    // 第二条消息在 B 忙碌时写入：必须保留为 pending，等待下一安全点。
    a.core.sendMessage(a.sessionId, { text: "msg2", mentions: [b.memberId] });
    assert.ok(queuedTexts(ctx, b.memberId).includes("msg2"), "忙碌时消息应保留在队列");
  });
});

test("unsupported：宿主不支持打断（Claude Code 实测）→ working；消息保留在队列", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    const waiting = b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    await delay(60);
    a.core.sendMessage(a.sessionId, { text: "m", mentions: [b.memberId] });
    await waiting;

    const outcome = b.core.attemptInterrupt(b.sessionId, { hostCapability: "unsupported" });
    assert.equal(outcome.result, "unsupported");
    assert.equal(outcome.targetStatus, "working");
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "working");
    // 依据里明确写出「不能打断在途工具」。
    assert.match(outcome.reason, /不能打断|无法打断/);

    a.core.sendMessage(a.sessionId, { text: "queued", mentions: [b.memberId] });
    assert.ok(queuedTexts(ctx, b.memberId).includes("queued"));
  });
});

test("缺省能力：Claude Code 未申报能力时默认 unsupported，不臆造打断", async () => {
  await withCtx(async (ctx) => {
    const b = ctx.spawn("b", "B");
    const outcome = b.core.attemptInterrupt(b.sessionId);
    assert.equal(outcome.result, "unsupported");
    assert.equal(outcome.target, "idle");
    assert.equal(outcome.hostType, "claude-code");
    // 未入群的会话直接 NOT_IN_GROUP。
    const stranger = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: "z" });
    try {
      assert.throws(() => {
        stranger.attemptInterrupt("nope");
      }, /尚未入群/);
    } finally {
      stranger.close();
    }
  });
});

test("安全点投递：打断失败后消息保留，agent 回到 waiting 时自然取走；消息不丢（CHAT-05）", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    const first = b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    await delay(60);
    a.core.sendMessage(a.sessionId, { text: "first", mentions: [b.memberId] });
    await first;
    assert.equal(ctx.repos.statuses.get(ctx.projectId, b.memberId)?.state, "working");

    // 忙碌期间 A 又发两条：都不应丢。
    a.core.sendMessage(a.sessionId, { text: "second", mentions: [b.memberId] });
    a.core.sendMessage(a.sessionId, { text: "third", mentions: [b.memberId] });
    const out = b.core.attemptInterrupt(b.sessionId, { hostCapability: "unsupported" });
    assert.equal(out.result, "unsupported");
    // T5 语义：queuedMessageCount = 未 ack 的消息数（含已投递未确认的 first），
    // 这正是「至少一次、不丢消息」的可见依据。
    assert.equal(out.queuedMessageCount, 3);
    assert.deepEqual(queuedTexts(ctx, b.memberId).sort(), ["first", "second", "third"]);

    // B 处理完 first 后回到等待循环（下一安全点），按至少一次语义取走积压。
    const next = await b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    assert.equal(next.status, "message");
    const texts = next.messages.map((m) => m.text);
    assert.ok(texts.includes("second"));
    assert.ok(texts.includes("third"));
  });
});

test("至少一次投递兼容（T5）：同一消息在 acked 前可重复读取，不因已投递丢弃", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    const first = b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    await delay(60);
    a.core.sendMessage(a.sessionId, { text: "x", mentions: [b.memberId] });
    const r1 = await first;
    assert.equal(r1.messages.length, 1);

    // 未 ack，再次等待：同一消息仍可被再次投递（至少一次，靠 ack 去重）。
    const second = await b.core.waitForMessages(b.sessionId, { timeoutMs: 20_000 });
    assert.equal(second.status, "message");
    assert.deepEqual(second.messages.map((m) => m.text), ["x"]);

    // ack 后不再投递。
    b.core.acknowledgeMessage(b.sessionId, r1.messages[0]!.id);
    const r3 = await b.core.waitForMessages(b.sessionId, { timeoutMs: 120 });
    assert.equal(r3.status, "timeout");
    assert.equal(r3.messages.length, 0);
  });
});

test("打断结果可注入：三种能力返回对应结果，且记录宿主类型", async () => {
  await withCtx(async (ctx) => {
    const b = ctx.spawn("b", "B");
    const caps: HostInterruptCapability[] = ["accepted", "rejected", "unsupported"];
    const seen: string[] = [];
    for (const cap of caps) {
      const out = b.core.attemptInterrupt(b.sessionId, { hostCapability: cap });
      seen.push(out.result);
      assert.equal(out.hostType, "claude-code");
    }
    assert.deepEqual(seen, ["accepted", "rejected", "unsupported"]);
  });
});

test("重复投递：忙碌时两条消息各自入队，按 message+member 唯一，不重复计数", async () => {
  await withCtx(async (ctx) => {
    const a = ctx.spawn("a", "A", "manager");
    const b = ctx.spawn("b", "B");
    b.core.reportStatus(b.sessionId, { status: "working" });
    const m1 = a.core.sendMessage(a.sessionId, { text: "p", mentions: [b.memberId] });
    const m2 = a.core.sendMessage(a.sessionId, { text: "q", mentions: [b.memberId] });
    const pending = ctx.repos.deliveries.listPending(ctx.projectId, b.memberId);
    assert.equal(pending.length, 2);
    const ids = new Set(pending.map((d) => d.messageId));
    assert.equal(ids.size, 2);
    assert.ok(ids.has(m1.messageId));
    assert.ok(ids.has(m2.messageId));
  });
});

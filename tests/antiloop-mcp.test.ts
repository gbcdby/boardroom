import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger, type LogFields } from "../src/server/logger.ts";
import { createMcpCore, resetGroupConsecutiveCount, resetSharedAntiLoopForTests, type AntiLoopRuntimeOptions } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";

/**
 * T7（#20）防环/限流 MCP 集成测试。
 *
 * seam：MCP 工具公开行为（fake client + 真实 server + 真实 SQLite）+ 进程级共享的
 * 防环限流器 + 注入的模拟时钟。覆盖：发送者不被自己唤醒（限流不误伤）、连续 6 次上限、
 * 人类消息重置、每成员 20 次/分钟跨群限流（manager 计入）、超限不丢且窗口重置后补投、
 * 配置覆盖、日志可诊断且不含正文。
 */

const silent = createLogger({ level: "error", write: () => {} });

interface Ctx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
  readonly clock: { now: () => number; advance: (ms: number) => void };
  readonly logs: LogFields[];
  readonly antiLoop: AntiLoopRuntimeOptions;
}

async function withDb<T>(
  fn: (ctx: Ctx) => Promise<T>,
  overrides: { config?: Partial<AntiLoopRuntimeOptions["config"]>; captureLogs?: boolean } = {},
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t7-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const logs: LogFields[] = [];
  const logger = overrides.captureLogs
    ? createLogger({
        level: "debug",
        write: (chunk) => {
          const trimmed = chunk.trim();
          if (trimmed) logs.push(JSON.parse(trimmed) as LogFields);
        },
      })
    : silent;
  const antiLoop: AntiLoopRuntimeOptions = {
    now: clock.now,
    ...(overrides.config ? { config: overrides.config } : {}),
  };
  // 每个用例一套全新的进程级共享限流器（模拟独立进程/重启），避免用例间状态泄漏。
  resetSharedAntiLoopForTests();
  try {
    return await fn({ db: driver, repos, projectId: project.id, groupId: group.id, clock, logs, antiLoop });
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface Payload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

interface Fake {
  call(name: string, args: Record<string, unknown>): Promise<Payload>;
  close(): Promise<void>;
}

async function spawn(ctx: Ctx, key: string, logger: ReturnType<typeof createLogger> = silent): Promise<Fake> {
  const core = createMcpCore({
    logger,
    db: ctx.db,
    memberKey: key,
    now: () => new Date(ctx.clock.now()),
    antiLoop: ctx.antiLoop,
  });
  const server = createMcpServer({ core, logger: silent });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key, version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return {
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.find((p) => p.type === "text")?.text;
      assert.ok(text, `工具 ${name} 应返回 text`);
      return JSON.parse(text) as Payload;
    },
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

async function join(ctx: Ctx, f: Fake, displayName: string, role?: "manager" | "normal"): Promise<string> {
  const r = await f.call("join", {
    displayName,
    hostType: "claude-code",
    projectId: ctx.projectId,
    groupId: ctx.groupId,
    ...(role ? { role } : {}),
  });
  assert.equal(r.ok, true);
  return String(r["memberId"]);
}

/** 造一条人类消息（模拟 WebUI 发送，不经过 MCP core）。返回 memberId。 */
async function sendHumanMessage(ctx: Ctx): Promise<string> {
  const existing = (await ((await (ctx.repos.members.listByProject(ctx.projectId))))).find((m) => m.kind === "human");
  const member =
    existing ??
    (await (async () => {
      const created = (await ((await (ctx.repos.members.create({
        projectId: ctx.projectId,
        kind: "human",
        displayName: "Human",
        role: "normal",
      })))));
      (await ((await (ctx.repos.groups.addParticipant(ctx.groupId, created.id)))));
      return created;
    })());
  (await ((await (ctx.repos.messages.create({ groupId: ctx.groupId, senderMemberId: member.id, body: "人类到场" })))));
  // 与生产一致：人类消息重置该群组的连续自动回复计数（HTTP API 里做同样的事）。
  resetGroupConsecutiveCount(ctx.groupId);
  return member.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 确认一条等待结果里的所有消息（至少一次投递需 ack 才不会在下次 wait 中重复出现）。 */
async function ackAll(f: Fake, result: Payload): Promise<void> {
  for (const m of (result["messages"] as Array<{ id: string }> | undefined) ?? []) {
    await f.call("acknowledge_message", { messageId: m.id });
  }
}

test("发送者不会被自己的消息唤醒（限流不误伤）", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    try {
      await join(ctx, a, "Alice", "manager");
      const bId = await join(ctx, b, "Bob");
      const wait = a.call("wait_for_messages", { timeoutMs: 200 });
      await sleep(30);
      await a.call("send_message", { text: "自言自语" });
      assert.equal((await wait)["status"], "timeout", "发送者不应被自己的消息唤醒");
      const waitB = b.call("wait_for_messages", { timeoutMs: 2000 });
      await sleep(30);
      await a.call("send_message", { text: `hi @${bId}`, mentions: [bId] });
      assert.equal((await waitB)["status"], "message", "限流不误伤正常唤醒");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("每群组连续自动回复达 6 次后停止自动唤醒；人类消息重置后恢复", async () => {
  await withDb(async (ctx) => {
    const mgr = await spawn(ctx, "mgr");
    const b = await spawn(ctx, "b");
    try {
      await join(ctx, mgr, "Mgr", "manager");
      const bId = await join(ctx, b, "Bob");
      for (let i = 1; i <= 6; i += 1) {
        const wait = b.call("wait_for_messages", { timeoutMs: 400 });
        await sleep(25);
        await mgr.call("send_message", { text: `msg ${i} @${bId}`, mentions: [bId] });
        const r = await wait;
        assert.equal(r["status"], "message", `第 ${i} 条应唤醒 b`);
        await ackAll(b, r);
      }
      const wait7 = b.call("wait_for_messages", { timeoutMs: 250 });
      await sleep(25);
      const s7 = await mgr.call("send_message", { text: `msg 7 @${bId}`, mentions: [bId] });
      assert.equal(s7.ok, true);
      assert.equal((await wait7)["status"], "timeout", "达到连续上限后不应自动唤醒");
      const hist = await b.call("read_history", { limit: 50 });
      const texts = (hist["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.ok(texts.includes(`msg 7 @${bId}`), "超限消息仍应持久化在 b 的可见历史中");

      sendHumanMessage(ctx);
      const wait8 = b.call("wait_for_messages", { timeoutMs: 2000 });
      await sleep(25);
      await mgr.call("send_message", { text: `msg 8 @${bId}`, mentions: [bId] });
      const r8 = await wait8;
      assert.equal(r8["status"], "message", "人类消息后应恢复自动唤醒");
      await ackAll(b, r8);
    } finally {
      await mgr.close();
      await b.close();
    }
  });
});

test("每成员 20 次/分钟唤醒限流（跨群 manager 计入同一成员）；超限不丢、窗口重置后补投", async () => {
  await withDb(async (ctx) => {
    const mgr = await spawn(ctx, "mgr");
    const b = await spawn(ctx, "b");
    try {
      await join(ctx, mgr, "Mgr", "manager");
      const bId = await join(ctx, b, "Bob");
      for (let i = 1; i <= 20; i += 1) {
        sendHumanMessage(ctx); // 每条前重置连续计数，隔离出速率限流
        // 先让 b 清掉人类消息（可见积压），再等 manager 的唤醒。
        await ackAll(b, await b.call("wait_for_messages", { timeoutMs: 300 }));
        const wait = b.call("wait_for_messages", { timeoutMs: 400 });
        await sleep(20);
        await mgr.call("send_message", { text: `m${i} @${bId}`, mentions: [bId] });
        const r = await wait;
        assert.equal(r["status"], "message", `第 ${i} 次应唤醒 b`);
        await ackAll(b, r);
      }
      sendHumanMessage(ctx);
      await ackAll(b, await b.call("wait_for_messages", { timeoutMs: 300 }));
      const wait21 = b.call("wait_for_messages", { timeoutMs: 250 });
      await sleep(20);
      await mgr.call("send_message", { text: `m21 @${bId}`, mentions: [bId] });
      assert.equal((await wait21)["status"], "timeout", "第 21 次应被速率限流");
      const hist = await b.call("read_history", { limit: 100 });
      const texts = (hist["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.ok(texts.includes(`m21 @${bId}`), "超限消息持久化未丢");

      ctx.clock.advance(60_001);
      const drain = await b.call("wait_for_messages", { timeoutMs: 2000 });
      assert.equal(drain["status"], "message", "窗口重置后应补投积压消息");
      const drained = (drain["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.ok(drained.includes(`m21 @${bId}`), "窗口重置后应补投之前的超限消息");
    } finally {
      await mgr.close();
      await b.close();
    }
  });
});

test("配置覆盖生效：自定义连续上限", async () => {
  await withDb(
    async (ctx) => {
      const mgr = await spawn(ctx, "mgr");
      const b = await spawn(ctx, "b");
      try {
        await join(ctx, mgr, "Mgr", "manager");
        const bId = await join(ctx, b, "Bob");
        for (let i = 1; i <= 2; i += 1) {
          const wait = b.call("wait_for_messages", { timeoutMs: 300 });
          await sleep(20);
          await mgr.call("send_message", { text: `m${i} @${bId}`, mentions: [bId] });
          const r = await wait;
          assert.equal(r["status"], "message");
          await ackAll(b, r);
        }
        const wait3 = b.call("wait_for_messages", { timeoutMs: 200 });
        await sleep(20);
        await mgr.call("send_message", { text: `m3 @${bId}`, mentions: [bId] });
        assert.equal((await wait3)["status"], "timeout", "自定义上限=2 时第 3 条不唤醒");
      } finally {
        await mgr.close();
        await b.close();
      }
    },
    { config: { maxConsecutiveAutoReplies: 2 } },
  );
});

test("限流日志可诊断且不含消息正文", async () => {
  await withDb(
    async (ctx) => {
      const logger = createLogger({
        level: "debug",
        write: (chunk) => {
          const trimmed = chunk.trim();
          if (trimmed) ctx.logs.push(JSON.parse(trimmed) as LogFields);
        },
      });
      const mgr = await spawn(ctx, "mgr", logger);
      const b = await spawn(ctx, "b", logger);
      try {
        await join(ctx, mgr, "Mgr", "manager");
        const bId = await join(ctx, b, "Bob");
        await mgr.call("send_message", { text: `第一 @${bId}`, mentions: [bId] });
        await mgr.call("send_message", { text: `第二 @${bId}`, mentions: [bId] });
      } finally {
        await mgr.close();
        await b.close();
      }
      const suppressed = ctx.logs.filter((l) => l["msg"] === "wake_suppressed");
      assert.ok(suppressed.length > 0, "应记录 wake_suppressed 日志");
      const serialized = JSON.stringify(ctx.logs);
      assert.ok(!serialized.includes("第一"), "日志不得包含消息正文");
      assert.ok(!serialized.includes("第二"), "日志不得包含消息正文");
    },
    { config: { maxConsecutiveAutoReplies: 1 }, captureLogs: true },
  );
});

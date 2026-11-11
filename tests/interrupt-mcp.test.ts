import test from "node:test";
import { EXPECTED_MCP_TOOL_NAMES } from "./helpers/mcp-contract.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T6（#19）MCP 工具边界的打断契约一致性。
 *
 * 「打断尝试」不新增 MCP 工具名（约束：不改 MCP 工具名/错误码）。因此宿主侧看到的是一个
 * **可选能力**：若服务端暴露 `attempt_interrupt` 工具，其返回必须是
 * `{ ok:true, result: accepted|rejected|unsupported, targetStatus }`；未暴露时，宿主侧可观察的
 * 语义是「消息留在队列、下一安全点由 wait_for_messages 送达」，本测试验证两条路径下消息都不丢。
 */

interface Ctx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
}

async function withDb<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t6mcp-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  try {
    return await fn({ db: driver, repos, projectId: project.id, groupId: group.id });
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
  toolNames(): Promise<string[]>;
  close(): Promise<void>;
}

async function spawn(ctx: Ctx, key: string, hostType: "claude-code" | "codex-cli" = "claude-code"): Promise<Fake> {
  const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: key });
  const server = createMcpServer({ core, logger: silentLogger });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key, version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  const toolNames = async () => {
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  };
  return {
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.find((p) => p.type === "text")?.text;
      assert.ok(text, `工具 ${name} 应返回 text`);
      return JSON.parse(text) as Payload;
    },
    toolNames,
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("打断能力不新增 MCP 工具名：保持聊天、任务与工作事件公开清单", async () => {
  await withDb(async (ctx) => {
    const b = await spawn(ctx, "b");
    try {
      const names = await b.toolNames();
      assert.deepEqual(
        names.sort(),
        EXPECTED_MCP_TOOL_NAMES,
      );
    } finally {
      await b.close();
    }
  });
});

test("忙碌失败路径：无法打断时消息留在队列，下一安全点 wait 送达，不丢消息", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    try {
      const pa = await a.call("join", {
        displayName: "A",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
        role: "manager",
      });
      const pb = await b.call("join", {
        displayName: "B",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      const bId = pb.memberId as string;
      void pa;

      // 第一条消息唤醒等待中的 B。
      const waiting = b.call("wait_for_messages", { timeoutMs: 20_000 });
      await delay(80);
      await a.call("send_message", { text: "first", mentions: [bId] });
      const r = await waiting;
      assert.equal(r.status, "message");

      // B 忙碌（working）期间 A 再发，消息只入队（不丢）。
      // T5 语义：listPending = 未 ack 的消息（含已投递未确认的 first + 新入队的 second）。
      await a.call("send_message", { text: "second", mentions: [bId] });
      const pending = (await ((await (ctx.repos.deliveries.listPending(ctx.projectId, bId)))));
      const pendingTexts = await Promise.all(pending.map(async (d) => (await ((await (ctx.repos.messages.get(d.messageId)))))!.body));
      assert.ok(pendingTexts.includes("second"), "忙碌期间的消息必须保留在队列");

      // B 回到等待循环（下一安全点）→ 取走积压。"first" 未 ack，按 T5 至少一次语义可再次出现；
      // "second" 必须送达，消息不丢。
      const next = await b.call("wait_for_messages", { timeoutMs: 20_000 });
      assert.equal(next.status, "message");
      const texts = (next.messages as Array<{ text: string }>).map((m) => m.text);
      assert.ok(texts.includes("second"), "忙碌期间的消息必须在下一安全点送达");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("If 服务端暴露 attempt_interrupt：忙碌时返回可观察结果且不伪造打断成功", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    try {
      await a.call("join", {
        displayName: "A",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
        role: "manager",
      });
      const pb = await b.call("join", {
        displayName: "B",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      const names = await b.toolNames();
      if (!names.includes("attempt_interrupt")) {
        // 未暴露：契约不新增工具名，跳过断言（已由上一个测试保证工具集固定）。
        return;
      }
      await b.call("report_status", { status: "working" });
      const out = await b.call("attempt_interrupt", {});
      assert.equal(out.ok, true);
      assert.ok(["accepted", "rejected", "unsupported"].includes(out.result as string));
      assert.equal(out.targetStatus, "working");
      void pb;
    } finally {
      await a.close();
      await b.close();
    }
  });
});

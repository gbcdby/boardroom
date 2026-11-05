import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, type SessionBinding } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import type { Actor } from "../src/server/authz/authorize.ts";

/**
 * F2（#47）守卫接入 MCP 工具边界的可观察行为。
 *
 * 测试 seam：MCP 工具边界（fake client + 真实 core + 真实 SQLite），与 `tests/mcp-server.test.ts`
 * 同一 seam——本文件只补「权限守卫之后」的三类路径：正常 / 越权 / 子树与注入主体。
 * 错误码仍是契约里的 `FORBIDDEN`（决策票 #26），新增的 `details.deny` 携带守卫拒绝码。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

interface Ctx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
  readonly otherGroupId: string;
}

interface Member {
  call(name: string, args: Record<string, unknown>): Promise<ToolPayload>;
  close(): Promise<void>;
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

async function withDb<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-f2-mcp-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  const otherGroup = (await ((await (repos.groups.create({ projectId: project.id, name: "G2" })))));
  try {
    return await fn({
      db: driver,
      repos,
      projectId: project.id,
      groupId: group.id,
      otherGroupId: otherGroup.id,
    });
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 一个成员 = 一个 core（可注入 authz.actorFor，模拟 T2 的岗位数据）+ fake client。 */
async function spawn(
  ctx: Ctx,
  name: string,
  actorFor?: (binding: SessionBinding) => Promise<Actor>,
): Promise<Member> {
  const core = createMcpCore({
    logger: silentLogger,
    db: ctx.db,
    memberKey: name,
    ...(actorFor ? { authz: { actorFor } } : {}),
  });
  const server = createMcpServer({ core, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${name}-client`, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(toolName, args) {
      const result = (await client.callTool({ name: toolName, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      return JSON.parse(result.content.find((p) => p.type === "text")?.text ?? "{}") as ToolPayload;
    },
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

async function joined(
  ctx: Ctx,
  name: string,
  role?: "manager" | "normal",
  actorFor?: (binding: SessionBinding) => Promise<Actor>,
): Promise<Member> {
  const member = await spawn(ctx, name, actorFor);
  const join = await member.call("join", {
    displayName: name,
    hostType: "claude-code",
    projectId: ctx.projectId,
    groupId: ctx.groupId,
    ...(role === undefined ? {} : { role }),
  });
  assert.equal(join.ok, true, `join 应成功：${JSON.stringify(join.error)}`);
  return member;
}

test("正常路径：入群成员在绑定群组发言放行", async () => {
  await withDb(async (ctx) => {
    const a = await joined(ctx, "A");
    try {
      const sent = await a.call("send_message", { text: "在允许范围内" });
      assert.equal(sent.ok, true);
    } finally {
      await a.close();
    }
  });
});

test("越权路径：向未加入的群组发消息返回 FORBIDDEN + deny=out_of_connection", async () => {
  await withDb(async (ctx) => {
    const a = await joined(ctx, "A");
    try {
      const sent = await a.call("send_message", { groupId: ctx.otherGroupId, text: "跨群写入" });
      assert.equal(sent.ok, false);
      assert.equal(sent.error?.code, "FORBIDDEN");
      assert.equal(sent.error?.details?.deny, "out_of_connection");
      assert.equal(sent.error?.details?.capability, "group:post");
    } finally {
      await a.close();
    }
  });
});

test("越权路径：manager 也不能借角色越出连接作用域（阶段 1 行为不变）", async () => {
  await withDb(async (ctx) => {
    const m = await joined(ctx, "M", "manager");
    try {
      const sent = await m.call("send_message", { groupId: ctx.otherGroupId, text: "manager 跨群" });
      assert.equal(sent.ok, false);
      assert.equal(sent.error?.code, "FORBIDDEN");
      const read = await m.call("read_history", { groupId: ctx.otherGroupId });
      assert.equal(read.error?.code, "FORBIDDEN");
      assert.equal(read.error?.details?.deny, "out_of_connection");
    } finally {
      await m.close();
    }
  });
});

test("越权路径：上报他人状态是 self 边界（deny=not_self）", async () => {
  await withDb(async (ctx) => {
    const a = await joined(ctx, "A");
    try {
      const res = await a.call("report_status", { status: "waiting", memberId: "m_someoneelse" });
      assert.equal(res.ok, false);
      assert.equal(res.error?.code, "FORBIDDEN");
      assert.equal(res.error?.details?.deny, "not_self");
    } finally {
      await a.close();
    }
  });
});

test("注入主体（T2 接口）：下级 manager 的非参与者身份被参与边界拒绝", async () => {
  await withDb(async (ctx) => {
    // 岗位数据由注入的 Actor 表达：sub_manager，子树 = 两个节点，且不是该群组参与者。
    const outsider: Actor = {
      actorId: "m-not-in-group",
      kind: "agent",
      role: "sub_manager",
      projectId: ctx.projectId,
      nodeId: "n2",
      subtreeNodeIds: ["n2", "n3"],
    };
    const injected = await joined(ctx, "S", undefined, async () => outsider);
    try {
      const sent = await injected.call("send_message", { text: "我不是参与者" });
      assert.equal(sent.ok, false);
      assert.equal(sent.error?.code, "FORBIDDEN");
      assert.equal(sent.error?.details?.deny, "not_a_member");
      // 只读可见性不扩成写权限：同一个 participation 边界挡住写路径。
      const read = await injected.call("read_history", {});
      assert.equal(read.error?.code, "FORBIDDEN");
      assert.equal(read.error?.details?.deny, "not_visible", "非参与者且参与者不属其子树 → 不可见");
    } finally {
      await injected.close();
    }
  });
});

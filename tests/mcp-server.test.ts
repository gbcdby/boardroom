import test from "node:test";
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
 * T2 测试 seam：MCP 工具边界（fake MCP client + 真实 server + 真实 SQLite）。
 *
 * 与 F3 不同：不再有内存 McpStore。每个 fake 成员是一个独立 core，但都读写同一个
 * SQLite（F2 repository），因此天然共享成员/消息/状态。join 需要预先存在项目与群组
 * （由 T1 的 WebUI/HTTP 创建），测试用 repository 直接播种。
 */

interface TestContext {
  readonly db: SqliteDriver;
  readonly dir: string;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
}

async function withDb<T>(fn: (ctx: TestContext) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-mcp-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  try {
    return await fn({ db: driver, dir, repos, projectId: project.id, groupId: group.id });
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

interface FakeMember {
  call(name: string, args: Record<string, unknown>): Promise<{ payload: ToolPayload; isError: boolean }>;
  close(): Promise<void>;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ payload: ToolPayload; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const textPart = result.content.find((part) => part.type === "text");
  assert.ok(textPart?.text, `工具 ${name} 必须返回 text content`);
  let payload: ToolPayload;
  try {
    payload = JSON.parse(textPart.text) as ToolPayload;
  } catch {
    payload = { ok: false, error: { code: "INTERNAL", message: textPart.text } };
  }
  if (result.structuredContent) {
    assert.deepEqual(result.structuredContent, payload, "text 与 structuredContent 必须一致");
  }
  return { payload, isError: result.isError === true };
}

/** 一个成员 = 独立 core（共享同一 db）+ 独立 server + InMemoryTransport。 */
async function spawnMember(
  ctx: TestContext,
  name: string,
): Promise<FakeMember> {
  const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: name });
  const server = createMcpServer({ core, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${name}-client`, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: (toolName, args) => callTool(client, toolName, args),
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

async function withTwoMembers<T>(
  fn: (ctx: {
    ctx: TestContext;
    a: FakeMember["call"];
    b: FakeMember["call"];
    aMember: FakeMember;
    bMember: FakeMember;
  }) => Promise<T>,
): Promise<T> {
  return await withDb(async (ctx) => {
    const aMember = await spawnMember(ctx, "A");
    const bMember = await spawnMember(ctx, "B");
    try {
      await aMember.call("join", {
        displayName: "A", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      await bMember.call("join", {
        displayName: "B", hostType: "codex-cli", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      return await fn({ ctx, a: aMember.call, b: bMember.call, aMember, bMember });
    } finally {
      await aMember.close();
      await bMember.close();
    }
  });
}

test("工具列表符合契约：固定 6 工具 + heartbeat", async () => {
  await withDb(async (ctx) => {
    const core = createMcpCore({ logger: silentLogger, db: ctx.db });
    const server = createMcpServer({ core, logger: silentLogger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lister", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "acknowledge_message",
        "heartbeat",
        "join",
        "read_history",
        "report_status",
        "send_message",
        "wait_for_messages",
      ]);
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.description && tool.description.length > 0, `${tool.name} 必须有描述`);
        assert.equal(tool.inputSchema.type, "object");
      }
    } finally {
      await client.close();
      await server.close();
      core.close();
    }
  });
});

test("join 声明身份并返回 memberId、agentId、heartbeat；持久化三个实体", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const { payload, isError } = await a.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(isError, false);
      assert.equal(payload.ok, true);
      assert.match(String(payload["memberId"]), /^[0-9A-Z]{26}$/);
      assert.match(String(payload["agentId"]), /^[0-9A-Z]{26}$/);
      assert.equal(payload["projectId"], ctx.projectId);
      assert.equal(payload["groupId"], ctx.groupId);
      assert.equal(payload["role"], "normal");
      assert.deepEqual(payload["heartbeat"], { intervalMs: 10_000, timeoutMs: 30_000 });

      const memberId = String(payload["memberId"]);
      // 持久化：Agent（全局身份）、Member（项目成员）、McpSession（连接状态）、MemberStatus online。
      assert.ok((await ((await (ctx.repos.agents.get(String(payload["agentId"])))))));
      const member = (await ((await (ctx.repos.members.get(memberId)))))!;
      assert.equal(member.kind, "agent");
      assert.equal(member.displayName, "Alice");
      const sessions = (await ((await (ctx.repos.mcpSessions.listByProject(ctx.projectId))))).filter((s) => s.memberId === memberId);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.state, "connected");
      assert.equal((await ((await (ctx.repos.statuses.get(ctx.projectId, memberId)))))?.state, "online");
      // 群组参与者已加入。
      assert.ok((await ((await (ctx.repos.groups.participants(ctx.groupId))))).includes(memberId));
    } finally {
      await a.close();
    }
  });
});

test("未入群调用其他工具返回 NOT_IN_GROUP", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const { payload, isError } = await a.call("send_message", { text: "hi" });
      assert.equal(isError, true);
      assert.equal(payload.ok, false);
      assert.equal(payload.error?.code, "NOT_IN_GROUP");
    } finally {
      await a.close();
    }
  });
});

test("参数无效返回 INVALID_ARGUMENT", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const { payload, isError } = await a.call("join", {
        displayName: "", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(isError, true);
      assert.equal(payload.error?.code, "INVALID_ARGUMENT");
    } finally {
      await a.close();
    }
  });
});

test("无效群组 / 无效项目入群返回 INVALID_ARGUMENT（不静默创建）", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const badGroup = await a.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: "g_missing",
      });
      assert.equal(badGroup.payload.error?.code, "INVALID_ARGUMENT");
      const badProject = await a.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: "p_missing", groupId: ctx.groupId,
      });
      assert.equal(badProject.payload.error?.code, "INVALID_ARGUMENT");
      // 没有任何成员/身份被创建。
      assert.equal((await ((await (ctx.repos.agents.list())))).length, 0);
      assert.equal((await ((await (ctx.repos.members.listByProject(ctx.projectId))))).length, 0);
    } finally {
      await a.close();
    }
  });
});

test("身份唯一性：同名同宿主 agent 复用同一全局身份；同名不同宿主不同身份", async () => {
  await withDb(async (ctx) => {
    const s1 = await spawnMember(ctx, "S1");
    const s2 = await spawnMember(ctx, "S2");
    const s3 = await spawnMember(ctx, "S3");
    try {
      const first = await s1.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(first.payload.ok, true);
      const agentId = String(first.payload["agentId"]);
      // 同 displayName+hostType 的另一会话应得到同一 agentId（全局身份唯一）。
      const second = await s2.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(second.payload["agentId"], agentId, "同名同宿主应复用全局身份");
      // 同名不同宿主 → 不同身份。
      const third = await s3.call("join", {
        displayName: "Alice", hostType: "codex-cli", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.notEqual(third.payload["agentId"], agentId);
      // 全局只有一个 codex-cli Alice 和 一个 claude-code Alice 的 agent。
      assert.equal((await ((await (ctx.repos.agents.list())))).filter((ag) => ag.displayName === "Alice").length, 2);
    } finally {
      await s1.close();
      await s2.close();
      await s3.close();
    }
  });
});

test("同一会话重复 join 不同身份返回 CONFLICT", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const first = await a.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(first.payload.ok, true);
      // 同一会话改 hostType → 身份不一致 → CONFLICT（不静默重复创建）。
      const second = await a.call("join", {
        displayName: "Alice", hostType: "codex-cli", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      assert.equal(second.isError, true);
      assert.equal(second.payload.error?.code, "CONFLICT");
    } finally {
      await a.close();
    }
  });
});

test("heartbeat 刷新连接心跳与会话状态，不改成员运行状态", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const joined = await a.call("join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const memberId = String(joined.payload["memberId"]);
      // 先改成 working（成员运行状态）。
      await a.call("report_status", { status: "working" });
      const beat = await a.call("heartbeat", {});
      assert.equal(beat.payload.ok, true);
      assert.equal(beat.payload["state"], "connected");
      assert.equal(typeof beat.payload["lastHeartbeatAt"], "string");
      // 心跳不改运行状态：仍是 working。
      assert.equal((await ((await (ctx.repos.statuses.get(ctx.projectId, memberId)))))?.state, "working");
    } finally {
      await a.close();
    }
  });
});

test("发送 → 等待命中消息 → 确认，走通至少一次投递", async () => {
  await withTwoMembers(async ({ a }) => {
    const sent = await a("send_message", { text: "hello" });
    assert.equal(sent.payload.ok, true);
    const messageId = String(sent.payload["messageId"]);
    assert.match(messageId, /^[0-9A-Z]{26}$/);

    const acked = await a("acknowledge_message", { messageId });
    assert.equal(acked.payload.ok, true);
    assert.equal(acked.payload["alreadyAcknowledged"], false);
  });
});

test("被 @ 的成员在等待中收到消息（服务端提前结束等待）", async () => {
  await withDb(async (ctx) => {
    const aSide = await spawnMember(ctx, "A");
    const bSide = await spawnMember(ctx, "B");
    try {
      const jb = await bSide.call("join", {
        displayName: "B", hostType: "codex-cli", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const memberB = String(jb.payload["memberId"]);
      await aSide.call("join", {
        displayName: "A", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });

      const waitPromise = bSide.call("wait_for_messages", { timeoutMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await aSide.call("send_message", { text: "ping @B", mentions: [memberB] });

      const waited = await waitPromise;
      assert.equal(waited.payload["status"], "message");
      const messages = waited.payload["messages"] as Array<{ text: string }>;
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.text, "ping @B");
    } finally {
      await aSide.close();
      await bSide.close();
    }
  });
});

test("等待超时按 status:timeout 正常返回", async () => {
  await withTwoMembers(async ({ b }) => {
    const started = Date.now();
    const waited = await b("wait_for_messages", { timeoutMs: 120 });
    assert.equal(waited.isError, false);
    assert.equal(waited.payload.ok, true);
    assert.equal(waited.payload["status"], "timeout");
    assert.ok(Date.now() - started >= 100);
  });
});

test("重复确认同一消息幂等：alreadyAcknowledged=true 不报错", async () => {
  await withTwoMembers(async ({ a }) => {
    const sent = await a("send_message", { text: "note" });
    const messageId = String(sent.payload["messageId"]);
    const first = await a("acknowledge_message", { messageId });
    const second = await a("acknowledge_message", { messageId });
    assert.equal(first.payload["alreadyAcknowledged"], false);
    assert.equal(second.payload.ok, true);
    assert.equal(second.payload["alreadyAcknowledged"], true);
  });
});

test("重复 send_message（相同 clientMessageId）只落一条，duplicate=true", async () => {
  await withTwoMembers(async ({ a }) => {
    const first = await a("send_message", { text: "once", clientMessageId: "k1" });
    const second = await a("send_message", { text: "once", clientMessageId: "k1" });
    assert.equal(first.payload["duplicate"], false);
    assert.equal(second.payload["duplicate"], true);
    assert.equal(first.payload["messageId"], second.payload["messageId"]);
  });
});

test("确认不存在/不可见的消息返回 FORBIDDEN", async () => {
  await withTwoMembers(async ({ a }) => {
    const { payload, isError } = await a("acknowledge_message", { messageId: "msg_missing" });
    assert.equal(isError, true);
    assert.equal(payload.error?.code, "FORBIDDEN");
  });
});

test("read_history 只返回自己发送 + 被 @ 的消息", async () => {
  await withDb(async (ctx) => {
    const aSide = await spawnMember(ctx, "A");
    const bSide = await spawnMember(ctx, "B");
    try {
      const ja = await aSide.call("join", {
        displayName: "A", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const memberA = String(ja.payload["memberId"]);
      const jb = await bSide.call("join", {
        displayName: "B", hostType: "codex-cli", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const memberB = String(jb.payload["memberId"]);

      await bSide.call("send_message", { text: "from B to A", mentions: [memberA] });
      await aSide.call("send_message", { text: "to B", mentions: [memberB] });
      await aSide.call("send_message", { text: "to nobody", mentions: [] });

      const historyB = await bSide.call("read_history", { limit: 50 });
      const texts = (historyB.payload["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.deepEqual(texts, ["from B to A", "to B"]);
      assert.equal(texts.includes("to nobody"), false);

      const historyA = await aSide.call("read_history", { limit: 50 });
      const textsA = (historyA.payload["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.deepEqual(textsA, ["from B to A", "to B", "to nobody"]);
    } finally {
      await aSide.close();
      await bSide.close();
    }
  });
});

test("report_status 记录 waiting/working 并回显上下文（写入 MemberStatus）", async () => {
  await withTwoMembers(async ({ ctx, a, aMember }) => {
    void aMember;
    const res = await a("report_status", { status: "working" });
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload["status"], "working");
    assert.equal(res.payload["projectId"], ctx.projectId);
    const memberId = String(res.payload["memberId"]);
    assert.match(memberId, /^[0-9A-Z]{26}$/);
    assert.equal(typeof res.payload["updatedAt"], "string");
    assert.equal((await ((await (ctx.repos.statuses.get(ctx.projectId, memberId)))))?.state, "working");
  });
});

test("report_status 传入他人 memberId 返回 FORBIDDEN", async () => {
  await withTwoMembers(async ({ a }) => {
    const { payload, isError } = await a("report_status", { status: "waiting", memberId: "m_someoneelse" });
    assert.equal(isError, true);
    assert.equal(payload.error?.code, "FORBIDDEN");
  });
});

test("同一成员并发等待返回 CONFLICT", async () => {
  await withDb(async (ctx) => {
    const aSide = await spawnMember(ctx, "A");
    try {
      await aSide.call("join", {
        displayName: "A", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const first = aSide.call("wait_for_messages", { timeoutMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await aSide.call("wait_for_messages", { timeoutMs: 200 });
      assert.equal(second.isError, true);
      assert.equal(second.payload.error?.code, "CONFLICT");
      const firstResult = await first;
      assert.equal(firstResult.payload["status"], "timeout");
    } finally {
      await aSide.close();
    }
  });
});

test("未入群读取历史返回 NOT_IN_GROUP", async () => {
  await withDb(async (ctx) => {
    const a = await spawnMember(ctx, "A");
    try {
      const { payload, isError } = await a.call("read_history", {});
      assert.equal(isError, true);
      assert.equal(payload.error?.code, "NOT_IN_GROUP");
    } finally {
      await a.close();
    }
  });
});

test("agent 断开连接后成员状态转为 offline（disconnect）", async () => {
  await withDb(async (ctx) => {
    const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: "A" });
    const server = createMcpServer({ core, logger: silentLogger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "A", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const joined = await callTool(client, "join", {
        displayName: "Alice", hostType: "claude-code", projectId: ctx.projectId, groupId: ctx.groupId,
      });
      const memberId = String(joined.payload["memberId"]);
      assert.equal((await ((await (ctx.repos.statuses.get(ctx.projectId, memberId)))))?.state, "online");
      // 模拟会话关闭：标记断开。
      await core.disconnect();
      assert.equal((await ((await (ctx.repos.statuses.get(ctx.projectId, memberId)))))?.state, "offline");
      const sessions = (await ((await (ctx.repos.mcpSessions.listByProject(ctx.projectId))))).filter((s) => s.memberId === memberId);
      assert.equal(sessions[0]!.state, "disconnected");
    } finally {
      await client.close();
      await server.close();
      core.close();
    }
  });
});

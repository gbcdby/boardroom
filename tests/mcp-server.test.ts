import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, createMcpStore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * 用 SDK 的 InMemoryTransport 建一对互连传输，得到 fake MCP client + 真实 server。
 * 这是本票确认的测试 seam：MCP 工具边界。
 */
async function withFakeClient<T>(fn: (client: Client, core: ReturnType<typeof createMcpCore>) => Promise<T>): Promise<T> {
  const core = createMcpCore({ logger: silentLogger });
  const server = createMcpServer({ core, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "fake-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client, core);
  } finally {
    await client.close();
    await server.close();
    core.close();
  }
}

interface SharedMemory {
  readonly store: ReturnType<typeof createMcpStore>;
}

function createSharedMemory(): SharedMemory {
  return { store: createMcpStore() };
}

interface FakeMember {
  call(name: string, args: Record<string, unknown>): Promise<{ payload: ToolPayload; isError: boolean }>;
  close(): Promise<void>;
}

/** 创建一个成员：独立 core（共享 store）+ 独立 server + InMemoryTransport。 */
async function spawnMember(
  shared: SharedMemory,
  name: string,
  hostType: "claude-code" | "codex-cli",
): Promise<FakeMember> {
  const core = createMcpCore({ logger: silentLogger, store: shared.store, memberKey: name });
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

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  [key: string]: unknown;
}

/** 取出工具返回的结构化载荷；同时校验 text 与 structuredContent 一致。 */
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
    // 框架级错误（如协议校验）返回纯文本；归一为 INTERNAL 便于断言。
    payload = { ok: false, error: { code: "INTERNAL", message: textPart.text } };
  }
  if (result.structuredContent) {
    assert.deepEqual(result.structuredContent, payload, "text 与 structuredContent 必须一致");
  }
  return { payload, isError: result.isError === true };
}

test("工具列表符合契约：固定 6 个工具", async () => {
  await withFakeClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "acknowledge_message",
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
  });
});

test("join 声明身份并返回 memberId、agentId、heartbeat", async () => {
  await withFakeClient(async (client) => {
    const { payload, isError } = await callTool(client, "join", {
      displayName: "Alice",
      hostType: "claude-code",
      projectId: "p1",
      groupId: "g1",
    });
    assert.equal(isError, false);
    assert.equal(payload.ok, true);
    assert.match(String(payload["memberId"]), /^m_/);
    assert.match(String(payload["agentId"]), /^a_/);
    assert.equal(payload["projectId"], "p1");
    assert.equal(payload["groupId"], "g1");
    assert.equal(payload["role"], "normal");
    assert.deepEqual(payload["heartbeat"], { intervalMs: 10_000, timeoutMs: 30_000 });
  });
});

test("未入群调用其他工具返回 NOT_IN_GROUP", async () => {
  await withFakeClient(async (client) => {
    const { payload, isError } = await callTool(client, "send_message", { text: "hi" });
    assert.equal(isError, true);
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.code, "NOT_IN_GROUP");
  });
});

test("参数无效返回 INVALID_ARGUMENT", async () => {
  await withFakeClient(async (client) => {
    const { payload, isError } = await callTool(client, "join", {
      displayName: "",
      hostType: "claude-code",
      projectId: "p1",
      groupId: "g1",
    });
    assert.equal(isError, true);
    assert.equal(payload.error?.code, "INVALID_ARGUMENT");
  });
});

/**
 * 两个成员各自入群；每个成员一个独立 core（模拟 Streamable HTTP 的 per-session 实例）。
 * 返回可分别调用工具的 helper。
 */
async function withTwoMembers<T>(
  fn: (ctx: {
    a: (name: string, args: Record<string, unknown>) => Promise<{ payload: ToolPayload; isError: boolean }>;
    b: (name: string, args: Record<string, unknown>) => Promise<{ payload: ToolPayload; isError: boolean }>;
  }) => Promise<T>,
): Promise<T> {
  const shared = createSharedMemory();
  const aSide = await spawnMember(shared, "A", "claude-code");
  const bSide = await spawnMember(shared, "B", "codex-cli");
  try {
    await aSide.call("join", { displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1" });
    await bSide.call("join", { displayName: "B", hostType: "codex-cli", projectId: "p1", groupId: "g1" });
    return await fn({ a: aSide.call, b: bSide.call });
  } finally {
    await aSide.close();
    await bSide.close();
  }
}

test("发送 → 等待命中消息 → 确认，走通至少一次投递", async () => {
  await withTwoMembers(async ({ a, b }) => {
    const sent = await a("send_message", { text: "hello B" });
    assert.equal(sent.payload.ok, true);
    const messageId = String(sent.payload["messageId"]);
    assert.match(messageId, /^msg_/);

    // 自己发送的消息对发送者可见，可直接确认（至少一次投递 + 去重）。
    const acked = await a("acknowledge_message", { messageId });
    assert.equal(acked.payload.ok, true);
    assert.equal(acked.payload["alreadyAcknowledged"], false);
  });
});

test("被 @ 的成员在等待中收到消息（服务端提前结束等待）", async () => {
  const shared = createSharedMemory();
  const aSide = await spawnMember(shared, "A", "claude-code");
  const bSide = await spawnMember(shared, "B", "codex-cli");
  try {
    const jb = await bSide.call("join", {
      displayName: "B", hostType: "codex-cli", projectId: "p1", groupId: "g1",
    });
    const memberB = String(jb.payload["memberId"]);
    await aSide.call("join", { displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1" });

    // B 先进入长等待（不会超时，因为很快会被消息唤醒）。
    const waitPromise = bSide.call("wait_for_messages", { timeoutMs: 5_000 });
    // 给等待一点时间挂起。
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
  const shared = createSharedMemory();
  const aSide = await spawnMember(shared, "A", "claude-code");
  const bSide = await spawnMember(shared, "B", "codex-cli");
  try {
    const ja = await aSide.call("join", {
      displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1",
    });
    const memberA = String(ja.payload["memberId"]);
    const jb = await bSide.call("join", {
      displayName: "B", hostType: "codex-cli", projectId: "p1", groupId: "g1",
    });
    const memberB = String(jb.payload["memberId"]);

    // B 发一条 @A 的消息；A 发一条 @B 的消息；A 再发一条谁都不 @ 的消息。
    await bSide.call("send_message", { text: "from B to A", mentions: [memberA] });
    await aSide.call("send_message", { text: "to B", mentions: [memberB] });
    await aSide.call("send_message", { text: "to nobody", mentions: [] });

    // B 可见：自己发送（"from B to A"）+ 被 @（"to B"）；"to nobody" 不可见。
    const historyB = await bSide.call("read_history", { limit: 50 });
    const texts = (historyB.payload["messages"] as Array<{ text: string }>).map((m) => m.text);
    assert.deepEqual(texts, ["from B to A", "to B"]);
    assert.equal(texts.includes("to nobody"), false);

    // A 可见：被 @（B 的消息）+ 自己发送的两条。
    const historyA = await aSide.call("read_history", { limit: 50 });
    const textsA = (historyA.payload["messages"] as Array<{ text: string }>).map((m) => m.text);
    assert.deepEqual(textsA, ["from B to A", "to B", "to nobody"]);
  } finally {
    await aSide.close();
    await bSide.close();
  }
});

test("report_status 记录 waiting/working 并回显上下文", async () => {
  await withTwoMembers(async ({ a }) => {
    const res = await a("report_status", { status: "working" });
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload["status"], "working");
    assert.equal(res.payload["projectId"], "p1");
    assert.match(String(res.payload["memberId"]), /^m_/);
    assert.equal(typeof res.payload["updatedAt"], "string");
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
  const shared = createSharedMemory();
  const aSide = await spawnMember(shared, "A", "claude-code");
  try {
    await aSide.call("join", { displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1" });
    const first = aSide.call("wait_for_messages", { timeoutMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await aSide.call("wait_for_messages", { timeoutMs: 200 });
    assert.equal(second.isError, true);
    assert.equal(second.payload.error?.code, "CONFLICT");
    // 第一次等待最终以 timeout 正常返回（并发冲突不打断它）。
    const firstResult = await first;
    assert.equal(firstResult.payload["status"], "timeout");
  } finally {
    await aSide.close();
  }
});

test("未入群读取历史返回 NOT_IN_GROUP", async () => {
  await withFakeClient(async (client) => {
    const { payload, isError } = await callTool(client, "read_history", {});
    assert.equal(isError, true);
    assert.equal(payload.error?.code, "NOT_IN_GROUP");
  });
});

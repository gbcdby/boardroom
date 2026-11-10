import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T8（#21）集成缺陷回归：人经 HTTP 发送的群组消息必须**实时唤醒**正在 MCP 等待中的 agent。
 *
 * 缺陷背景：MCP `send_message` 在 core 内部会跨 core 唤醒挂起的等待；但人的消息走
 * HTTP API（`POST /api/groups/:id/messages`），不经过任何 core 的 send_message，
 * 因此需要服务端在广播人的消息后显式调用 `mcpHandler.wakeGroup(...)`。修复前，
 * agent 的 `wait_for_messages` 只能等超时或下一次 wait 才拿到积压（定向消息不及时，
 * 不满足 NFR-03）。
 *
 * 本测试用真实 HTTP server + 真实 MCP Streamable HTTP 客户端（与 Claude Code 同 wire 协议）。
 */

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function connectAgent(server: RunningServer, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return { client, transport };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((p) => p.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text) as ToolPayload;
}

async function seedHumanAndGroup(server: RunningServer) {
  const projectRes = await fetch(`${server.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "P" }),
  });
  const projectId = ((await projectRes.json()) as { project: { id: string } }).project.id;
  const hmRes = await fetch(`${server.url}/api/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "human", displayName: "我" }),
  });
  const humanMemberId = ((await hmRes.json()) as { member: { id: string } }).member.id;
  const groupRes = await fetch(`${server.url}/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "G", participantMemberIds: [humanMemberId] }),
  });
  const groupId = ((await groupRes.json()) as { group: { id: string } }).group.id;
  return { projectId, groupId, humanMemberId };
}

test("人的 HTTP 消息实时唤醒正在 MCP 等待中的 agent（T8 #21 修复回归）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t8-human-wake-"));
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: silentLogger,
  });
  try {
    const { projectId, groupId, humanMemberId } = await seedHumanAndGroup(server);
    const { client, transport } = await connectAgent(server, "agent-b");
    try {
      const joined = await callTool(client, "join", {
        displayName: "Bob",
        hostType: "claude-code",
        projectId,
        groupId,
      });
      const memberId = String(joined["memberId"]);

      // agent 进入长等待（挂起）
      const wait = callTool(client, "wait_for_messages", { timeoutMs: 5_000 });
      // 等它确实挂起
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(server.mcpPendingWaitCount, 1);

      // 人经 HTTP 发送一条 @Bob 消息
      const sendRes = await fetch(`${server.url}/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderMemberId: humanMemberId, text: "@Bob 实时消息", mentions: [memberId] }),
      });
      assert.equal(sendRes.status, 201);
      const sent = ((await sendRes.json()) as { message: { id: string } }).message;

      // 通知可丢失；提交时落库的唤醒事实必须足以让未来 dispatcher 恢复。
      const deliveries = await server.database.query<{ member_id: string; wake_decision: string | null }>(
        "SELECT member_id, wake_decision FROM message_deliveries WHERE message_id = ?", [sent.id],
      );
      assert.equal(deliveries.find((d) => d.member_id === memberId)?.wake_decision, "allowed");
      assert.equal(deliveries.find((d) => d.member_id === humanMemberId)?.wake_decision, null);

      // 关键断言：等待应立即返回该消息，而不是等 5s 超时
      const waited = await wait;
      assert.equal(waited["status"], "message", "人的消息应实时唤醒等待中的 agent，而非超时");
      const messages = waited["messages"] as Array<{ id: string; text: string }>;
      assert.equal(messages[0]!.id, sent.id);
    } finally {
      await client.close().catch(() => {});
      await transport.terminateSession().catch(() => {});
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("人的 @all 实时唤醒所有在线等待中的 agent（T8 #21 修复回归）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t8-all-wake-"));
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: silentLogger,
  });
  try {
    const { projectId, groupId, humanMemberId } = await seedHumanAndGroup(server);
    const a = await connectAgent(server, "agent-a");
    const b = await connectAgent(server, "agent-b");
    try {
      await callTool(a.client, "join", { displayName: "Alice", hostType: "claude-code", projectId, groupId });
      await callTool(b.client, "join", { displayName: "Bob", hostType: "codex-cli", projectId, groupId });

      const waitA = callTool(a.client, "wait_for_messages", { timeoutMs: 5_000 });
      const waitB = callTool(b.client, "wait_for_messages", { timeoutMs: 5_000 });
      await new Promise((r) => setTimeout(r, 100));

      const sendRes = await fetch(`${server.url}/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderMemberId: humanMemberId, text: "@all 全员" }),
      });
      assert.equal(sendRes.status, 201);
      const sent = ((await sendRes.json()) as { message: { id: string } }).message;

      const [ra, rb] = await Promise.all([waitA, waitB]);
      assert.equal(ra["status"], "message", "A 应被 @all 实时唤醒");
      assert.equal(rb["status"], "message", "B 应被 @all 实时唤醒");
      assert.equal((ra["messages"] as Array<{ id: string }>)[0]!.id, sent.id);
      assert.equal((rb["messages"] as Array<{ id: string }>)[0]!.id, sent.id);
    } finally {
      await a.client.close().catch(() => {});
      await a.transport.terminateSession().catch(() => {});
      await b.client.close().catch(() => {});
      await b.transport.terminateSession().catch(() => {});
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

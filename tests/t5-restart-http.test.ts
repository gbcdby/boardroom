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
 * T5（#18）重启恢复 + 重连积压 —— 服务端 HTTP/MCP 端到端 seam。
 *
 * 真实启动 `startServer`，在**同一数据目录**上先后启动两个进程（模拟服务端重启），
 * 验证：
 * - 人通过 HTTP 发送的消息在重启后仍可经 `GET /api/groups/:id/messages` 读到（WebUI 历史）；
 * - 断线 agent 用新 MCP 会话重连后，`wait_for_messages` 立即补投允许范围内的积压；
 * - 遗留 connected 会话在重启后被标记断开（不臆造在线）。
 */

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function connectClient(server: RunningServer, name: string) {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
    reconnectionOptions: {
      initialReconnectionDelay: 50,
      maxReconnectionDelay: 200,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 2,
    },
  });
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

interface Seed {
  projectId: string;
  groupId: string;
  managerMemberId: string;
  humanMemberId: string;
}

async function seedWithManager(server: RunningServer): Promise<Seed> {
  const projectRes = await fetch(`${server.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "P" }),
  });
  const projectId = ((await projectRes.json()) as { project: { id: string } }).project.id;

  // 人成员
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

  // manager agent 入群（通过 MCP 简化：这里用 HTTP 建成员并指定 role=manager 不现实，
  // 故走 MCP join，随后关闭连接，模拟离线 manager）。
  const { client, transport } = await connectClient(server, "seed-mgr");
  const j = await callTool(client, "join", {
    displayName: "Manager",
    hostType: "claude-code",
    projectId,
    groupId,
    role: "manager",
  });
  const managerMemberId = String(j["memberId"]);
  await client.close();
  await transport.terminateSession().catch(() => {});
  return { projectId, groupId, managerMemberId, humanMemberId };
}

const baseConfig = (dir: string) => ({
  port: 0,
  dataDir: dir,
  heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
  configFile: null,
});

test("重启后人的历史（WebUI 历史）仍在，且断线 manager 重连可补发积压", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t5-http-"));
  try {
    // ---- 第一次进程：建项目/群组/manager，人发一条 @manager 消息 ----
    const first = await startServer({ config: baseConfig(dir), logger: silentLogger });
    let seed: Seed;
    let firstMsgId: string;
    try {
      seed = await seedWithManager(first);
      const sendRes = await fetch(`${first.url}/api/groups/${seed.groupId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          senderMemberId: seed.humanMemberId,
          text: `@Manager 重连后请查收`,
          mentions: [seed.managerMemberId],
        }),
      });
      assert.equal(sendRes.status, 201);
      firstMsgId = ((await sendRes.json()) as { message: { id: string } }).message.id;
    } finally {
      await first.close();
    }

    // ---- 第二次进程（重启）：历史仍在；manager 重连补发积压 ----
    const second = await startServer({ config: baseConfig(dir), logger: silentLogger });
    try {
      // WebUI 历史：GET 群消息包含重启前的消息，顺序稳定（按 seq）。
      const histRes = await fetch(`${second.url}/api/groups/${seed.groupId}/messages`);
      assert.equal(histRes.status, 200);
      const { messages } = (await histRes.json()) as { messages: Array<{ id: string; seq: number }> };
      assert.ok(messages.some((m) => m.id === firstMsgId), "重启后人的历史应包含重启前消息");
      const seqs = messages.map((m) => m.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "历史按 seq 稳定排序");

      // manager 重连（新 MCP 会话）→ 立即拿到积压。
      const { client, transport } = await connectClient(second, "reconnect-mgr");
      try {
        const j = await callTool(client, "join", {
          displayName: "Manager",
          hostType: "claude-code",
          projectId: seed.projectId,
          groupId: seed.groupId,
        });
        assert.equal(j.ok, true);
        assert.equal(String(j["memberId"]), seed.managerMemberId, "重连应复用同一成员");

        const drained = await callTool(client, "wait_for_messages", { timeoutMs: 2000 });
        assert.equal(drained["status"], "message");
        assert.equal(drained["drainedBacklog"], true);
        const ids = (drained["messages"] as Array<{ id: string }>).map((m) => m.id);
        assert.ok(ids.includes(firstMsgId), "manager 重连应补投重启前积压消息");
      } finally {
        await client.close();
        await transport.terminateSession().catch(() => {});
      }
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重启后遗留会话标记断开、成员状态 offline（不臆造在线）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t5-http2-"));
  try {
    const first = await startServer({ config: baseConfig(dir), logger: silentLogger });
    const seed = await seedWithManager(first);
    // 再开一个 manager 会话并保持连接（模拟非优雅退出前的在线状态）。
    const { client, transport } = await connectClient(first, "live-mgr");
    await callTool(client, "join", {
      displayName: "Manager",
      hostType: "claude-code",
      projectId: seed.projectId,
      groupId: seed.groupId,
    });
    // 非优雅退出：直接关服务（不走 disconnect）。
    await first.close();

    const second = await startServer({ config: baseConfig(dir), logger: silentLogger });
    try {
      const statusRes = await fetch(
        `${second.url}/api/projects/${seed.projectId}/members/${seed.managerMemberId}/status`,
      );
      assert.equal(statusRes.status, 200);
      const view = ((await statusRes.json()) as { memberStatus: { connection: string; state: string | null } })
        .memberStatus;
      assert.equal(view.connection, "disconnected");
      assert.equal(view.state, "offline");
    } finally {
      await second.close();
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

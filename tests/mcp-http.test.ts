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

async function withServer<T>(fn: (server: RunningServer) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-mcp-http-"));
  const server = await startServer({
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
    logger: silentLogger,
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function connectClient(server: RunningServer, name: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
    // 快速重连参数：服务端关闭后，客户端在测试时限内可达「最大重连次数」并让
    // 进行中的 callTool reject（D6：重连靠服务端持久化，宿主不缓存会话）。
    reconnectionOptions: {
      initialReconnectionDelay: 50,
      maxReconnectionDelay: 200,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 2,
    },
  });
  const client = new Client({ name, version: "0.0.0" });
  // exactOptionalPropertyTypes 下 SDK 的 Transport 可选项类型与 Client.connect 不完全一致，
  // 运行时兼容（SDK 自身组合），这里显式收窄。
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return { client, transport };
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ payload: ToolPayload; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const textPart = result.content.find((part) => part.type === "text");
  assert.ok(textPart?.text);
  return { payload: JSON.parse(textPart.text) as ToolPayload, isError: result.isError === true };
}

/** 通过 HTTP REST 创建一个项目与一个群组（T1 契约），返回它们 id。 */
async function seedProjectAndGroup(server: RunningServer): Promise<{ projectId: string; groupId: string }> {
  const projectRes = await fetch(`${server.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "P" }),
  });
  const project = (await projectRes.json()) as { project: { id: string } };
  const groupRes = await fetch(`${server.url}/api/projects/${project.project.id}/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "G" }),
  });
  const group = (await groupRes.json()) as { group: { id: string } };
  return { projectId: project.project.id, groupId: group.group.id };
}

test("Streamable HTTP /mcp 暴露契约工具列表", async () => {
  await withServer(async (server) => {
    const { client, transport } = await connectClient(server, "http-client");
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
      assert.ok(server.mcpSessionCount >= 1);
    } finally {
      await client.close();
      await transport.terminateSession().catch(() => {});
    }
  });
});

test("两个 HTTP 会话入同一群组可互相收发（共享 store）", async () => {
  await withServer(async (server) => {
    const { projectId, groupId } = await seedProjectAndGroup(server);
    const a = await connectClient(server, "A");
    const b = await connectClient(server, "B");
    try {
      const ja = await callTool(a.client, "join", {
        displayName: "A", hostType: "claude-code", projectId, groupId,
      });
      const jb = await callTool(b.client, "join", {
        displayName: "B", hostType: "codex-cli", projectId, groupId,
      });
      assert.equal(ja.payload.ok, true);
      assert.equal(jb.payload.ok, true);
      const memberB = String(jb.payload["memberId"]);

      const waitPromise = callTool(b.client, "wait_for_messages", { timeoutMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await callTool(a.client, "send_message", { text: "hi B", mentions: [memberB] });

      const waited = await waitPromise;
      assert.equal(waited.payload["status"], "message");
      const messages = waited.payload["messages"] as Array<{ text: string }>;
      assert.equal(messages[0]!.text, "hi B");
    } finally {
      await a.client.close();
      await a.transport.terminateSession().catch(() => {});
      await b.client.close();
      await b.transport.terminateSession().catch(() => {});
    }
  });
});

test("优雅关闭后端口可立即被重新监听（不泄漏）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-mcp-restart-"));
  const baseConfig = {
    port: 0,
    dataDir: dir,
    heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
    configFile: null,
  };
  try {
    const first = await startServer({ config: baseConfig, logger: silentLogger });
    const port = first.port;
    const { projectId, groupId } = await seedProjectAndGroup(first);
    const { client, transport } = await connectClient(first, "restart-client");
    await callTool(client, "join", { displayName: "A", hostType: "claude-code", projectId, groupId });
    await client.close();
    await transport.terminateSession().catch(() => {});
    await first.close();

    // 用同一端口重新启动；若端口泄漏（未释放），listen 会 EADDRINUSE。
    const second = await startServer({ config: { ...baseConfig, port }, logger: silentLogger });
    try {
      const res = await fetch(`${second.url}/api/health`);
      assert.equal(res.status, 200);
      const probe = await connectClient(second, "restart-client-2");
      const listed = await probe.client.listTools();
      assert.equal(listed.tools.length, 7);
      await probe.client.close();
      await probe.transport.terminateSession().catch(() => {});
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("优雅关闭会清空挂起的等待并关闭所有 MCP 会话", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-mcp-cancel-"));
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: silentLogger,
  });
  try {
    const { projectId, groupId } = await seedProjectAndGroup(server);
    const { client, transport } = await connectClient(server, "wait-client");
    await callTool(client, "join", { displayName: "A", hostType: "claude-code", projectId, groupId });
    // 起一个长等待但不 await；随后确认它确实挂起。
    const waitPromise = callTool(client, "wait_for_messages", { timeoutMs: 30_000 });
    // 该 promise 在关闭后可能 resolve 也可能 reject；这里只要求不产生未处理拒绝。
    void waitPromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.mcpPendingWaitCount, 1);
    assert.equal(server.mcpSessionCount, 1);

    await server.close();
    // 服务端侧：挂起等待被清空、会话被关闭、端口释放。
    // 注：MCP SDK 的 Streamable HTTP 客户端在其传输断线后不会 reject 进行中的
    // callTool（重连失败也只是 onerror），这是 SDK 行为，不在本票可控范围内；
    // 服务端的关闭保证（等待被 cancelled、会话回收、端口释放）由下列断言覆盖。
    assert.equal(server.mcpPendingWaitCount, 0);
    assert.equal(server.mcpSessionCount, 0);
    // 显式关闭客户端传输，避免 SDK 重连计时器/undici 连接把测试进程拖住。
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重启恢复：成员保留、遗留 MCP 会话标记断开、成员状态 offline（不臆造在线）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-mcp-recover-"));
  const config = {
    port: 0,
    dataDir: dir,
    heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
    configFile: null,
  };
  try {
    const first = await startServer({ config, logger: silentLogger });
    const { projectId, groupId } = await seedProjectAndGroup(first);
    const { client, transport } = await connectClient(first, "recover-client");
    const joined = await callTool(client, "join", {
      displayName: "Alice", hostType: "claude-code", projectId, groupId,
    });
    const memberId = String(joined.payload["memberId"]);
    await callTool(client, "report_status", { status: "working" });
    await client.close();
    await transport.terminateSession().catch(() => {});
    // 模拟非优雅退出：直接关闭 HTTP server（不经过会话 disconnect 清理路径）。
    await first.close();

    // 重启同一数据目录：成员保留；遗留会话被标记断开；成员状态回落 offline。
    const second = await startServer({ config: { ...config, port: 0 }, logger: silentLogger });
    try {
      const membersRes = await fetch(`${second.url}/api/projects/${projectId}/members`);
      assert.equal(membersRes.status, 200);
      const { members } = (await membersRes.json()) as { members: Array<{ id: string; kind: string }> };
      assert.equal(members.length, 1);
      assert.equal(members[0]!.id, memberId);
      assert.equal(members[0]!.kind, "agent");

      const statusRes = await fetch(`${second.url}/api/projects/${projectId}/members/${memberId}/status`);
      assert.equal(statusRes.status, 200);
      const view = ((await statusRes.json()) as { memberStatus: { connection: string; state: string | null } }).memberStatus;
      assert.equal(view.connection, "disconnected", "重启后遗留会话应显示断开");
      assert.equal(view.state, "offline", "重启后成员状态应为 offline，而不是在线");
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

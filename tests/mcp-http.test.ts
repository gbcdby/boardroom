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

test("Streamable HTTP /mcp 暴露契约工具列表", async () => {
  await withServer(async (server) => {
    const { client, transport } = await connectClient(server, "http-client");
    try {
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
      assert.ok(server.mcpSessionCount >= 1);
    } finally {
      await client.close();
      await transport.terminateSession().catch(() => {});
    }
  });
});

test("两个 HTTP 会话入同一群组可互相收发（共享 store）", async () => {
  await withServer(async (server) => {
    const a = await connectClient(server, "A");
    const b = await connectClient(server, "B");
    try {
      const ja = await callTool(a.client, "join", {
        displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1",
      });
      const jb = await callTool(b.client, "join", {
        displayName: "B", hostType: "codex-cli", projectId: "p1", groupId: "g1",
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
    const { client, transport } = await connectClient(first, "restart-client");
    await callTool(client, "join", { displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1" });
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
      assert.equal(listed.tools.length, 6);
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
    const { client, transport } = await connectClient(server, "wait-client");
    await callTool(client, "join", { displayName: "A", hostType: "claude-code", projectId: "p1", groupId: "g1" });
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

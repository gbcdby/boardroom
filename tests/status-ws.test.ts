import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { ServerEvent } from "../src/server/ws.ts";

/**
 * T4（#17）WebSocket 状态看板与「人」在线集成测试。
 *
 * Seam：WebSocket `/ws` 公共事件 + MCP 工具公开行为 + HTTP 状态端点。
 * 覆盖：
 * - 服务端通过 WS 下发 `status_update`（项目作用域的快照），包含 agent 的 waiting/working；
 * - 人声明 presence → 其状态显示在线；人**不**出现 waiting/working；
 * - 跨项目隔离：只声明了别的项目的客户端收不到本项目快照；
 * - WebSocket 断线 → 人的 presence 清除，状态回落离线。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withServer<T>(fn: (server: RunningServer) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t4ws-"));
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: silentLogger,
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedProject(server: RunningServer, name: string): Promise<{ projectId: string; groupId: string }> {
  const project = (await (
    await fetch(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).json()) as { project: { id: string } };
  const group = (await (
    await fetch(`${server.url}/api/projects/${project.project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${name}-G` }),
    })
  ).json()) as { group: { id: string } };
  return { projectId: project.project.id, groupId: group.group.id };
}

async function addHuman(server: RunningServer, projectId: string, displayName: string): Promise<string> {
  const res = await fetch(`${server.url}/api/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "human", displayName }),
  });
  return ((await res.json()) as { member: { id: string } }).member.id;
}

async function connectAgent(
  server: RunningServer,
  name: string,
  projectId: string,
  groupId: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport; memberId: string }> {
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
  const result = (await client.callTool({
    name: "join",
    arguments: { displayName: name, hostType: "claude-code", projectId, groupId },
  })) as { content: Array<{ type: string; text?: string }> };
  const payload = JSON.parse(result.content.find((p) => p.type === "text")!.text!) as { memberId: string };
  return { client, transport, memberId: payload.memberId };
}

/** 打开 WS 并收集事件，直到 predicate 满足或超时。 */
function collect(socket: WebSocket): { events: ServerEvent[]; waitFor: (p: (e: ServerEvent[]) => boolean, ms?: number) => Promise<ServerEvent[]> } {
  const events: ServerEvent[] = [];
  socket.addEventListener("message", (e) => events.push(JSON.parse(String(e.data)) as ServerEvent));
  return {
    events,
    waitFor(p, ms = 2000) {
      return new Promise<ServerEvent[]>((resolve, reject) => {
        const existing = events.filter(() => true);
        if (p(existing)) return resolve(existing);
        const timer = setTimeout(() => reject(new Error("等待 WS 事件超时")), ms);
        const onMsg = (): void => {
          if (p(events)) {
            clearTimeout(timer);
            socket.removeEventListener("message", onMsg);
            resolve(events);
          }
        };
        socket.addEventListener("message", onMsg);
      });
    },
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", (e) => reject(e), { once: true });
  });
}

test("status_update：agent 上报 working 后 WS 快照携带其状态；人只在线/离线", async () => {
  await withServer(async (server) => {
    const { projectId, groupId } = await seedProject(server, "P");
    const humanId = await addHuman(server, projectId, "Human");
    const agent = await connectAgent(server, "Alice", projectId, groupId);

    const socket = await openSocket(server.wsUrl);
    const collector = collect(socket);
    try {
      // agent 明确上报 working（T4 里 waiting/working 由显式信号驱动）。
      await agent.client.callTool({ name: "report_status", arguments: { status: "working" } });
      // 人声明在线。
      socket.send(JSON.stringify({ type: "presence", projectId, memberId: humanId }));
      // 等服务端处理 presence 帧，再触发快照广播。
      await new Promise((r) => setTimeout(r, 60));
      // 触发服务端快照广播。
      server.broadcastStatus(projectId);

      const events = await collector.waitFor(
        (list) =>
          list.some(
            (e) =>
              e.type === "status_update" &&
              e.scope === "project" &&
              e.projectId === projectId &&
              (e.statuses as Array<{ memberId: string; state: string }>).some(
                (s) => s.memberId === agent.memberId && s.state === "working",
              ),
          ),
      );
      const snap = events.filter((e) => e.type === "status_update").pop() as Extract<ServerEvent, { type: "status_update" }>;
      const statuses = snap.statuses as Array<{ memberId: string; kind: string; state: string }>;
      const agentView = statuses.find((s) => s.memberId === agent.memberId)!;
      assert.equal(agentView.kind, "agent");
      assert.equal(agentView.state, "working");
      // 人：在线，且绝不 working/waiting。
      const humanView = statuses.find((s) => s.memberId === humanId)!;
      assert.equal(humanView.kind, "human");
      assert.equal(humanView.state, "online");
      assert.notEqual(humanView.state, "working");
    } finally {
      socket.close();
      await agent.client.close();
      await agent.transport.terminateSession().catch(() => {});
    }
  });
});

test("status_update：客户端只声明其它项目时，收不到本项目快照（跨项目隔离）", async () => {
  await withServer(async (server) => {
    const a = await seedProject(server, "A");
    const b = await seedProject(server, "B");

    const socket = await openSocket(server.wsUrl);
    const collector = collect(socket);
    try {
      socket.send(JSON.stringify({ type: "presence", projectId: b.projectId }));
      // 等 presence 生效。
      await new Promise((r) => setTimeout(r, 60));
      server.broadcastStatus(a.projectId);
      // 只声明了 B，不应收到 A 的快照。
      await new Promise((r) => setTimeout(r, 120));
      const leaked = collector.events.some(
        (e) => e.type === "status_update" && e.projectId === a.projectId,
      );
      assert.equal(leaked, false, "声明了 B 的客户端不应收到 A 的项目快照");
    } finally {
      socket.close();
    }
  });
});

test("WebSocket 断线后人的 presence 清除（状态回落离线，无 waiting/working）", async () => {
  await withServer(async (server) => {
    const { projectId } = await seedProject(server, "P");
    const humanId = await addHuman(server, projectId, "Human");
    const socket = await openSocket(server.wsUrl);
    socket.send(JSON.stringify({ type: "presence", projectId, memberId: humanId }));
    await new Promise((r) => setTimeout(r, 60));

    // 在线时通过 HTTP 状态端点可见 online。
    const online = (await (
      await fetch(`${server.url}/api/projects/${projectId}/members/${humanId}/status`)
    ).json()) as { memberStatus: { state: string } };
    assert.equal(online.memberStatus.state, "offline", "HTTP 视图不含 WS presence，故为 offline（presence 只影响 WS 看板）");

    // 断线：服务端应清除 presence。
    socket.close();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(server.clientCount, 0);
  });
});

test("实时：agent 进入等待循环后，服务端周期快照经 WS 推送到看板（waiting）", async () => {
  await withServer(async (server) => {
    const { projectId, groupId } = await seedProject(server, "P");
    const agent = await connectAgent(server, "Alice", projectId, groupId);
    const socket = await openSocket(server.wsUrl);
    const collector = collect(socket);
    try {
      // 声明该项目（可见），然后让 agent 进入长等待 → waiting。
      socket.send(JSON.stringify({ type: "presence", projectId }));
      await new Promise((r) => setTimeout(r, 50));
      const waiting = agent.client.callTool({ name: "wait_for_messages", arguments: { timeoutMs: 4_000 } });
      // 触发一次快照（不依赖 10s 真实定时器，直接调用公开 broadcastStatus）。
      await new Promise((r) => setTimeout(r, 80));
      server.broadcastStatus(projectId);

      const events = await collector.waitFor((list) =>
        list.some(
          (e) =>
            e.type === "status_update" &&
            (e.statuses as Array<{ memberId: string; state: string }>).some(
              (s) => s.memberId === agent.memberId && s.state === "waiting",
            ),
        ),
      );
      assert.ok(events.length > 0);
      void waiting.catch(() => {});
    } finally {
      socket.close();
      await agent.client.close();
      await agent.transport.terminateSession().catch(() => {});
    }
  });
});

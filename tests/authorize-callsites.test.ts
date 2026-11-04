import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { Actor } from "../src/server/authz/authorize.ts";
import type { ServerEvent } from "../src/server/ws.ts";

/**
 * F2（#47）守卫接入现有调用点。
 *
 * 两类可观察行为：
 * 1. **阶段 1 默认行为不变**：单用户无认证 → 主体是人（owner），既有入口照常放行
 *    （由 `tests/http.test.ts`、`tests/chat-http-ws.test.ts`、`tests/mcp-server.test.ts`
 *    等既有用例整体回归，本文件不重复它们）。
 * 2. **注入主体后按矩阵拒绝**：入口把 `authorize` 的拒绝翻译成 HTTP 403 / WS error 帧，
 *    调用点不再自行判断权限（票面「复用/接入现有调用点」）。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

function memberActor(projectId: string): Actor {
  return { actorId: "m-x", kind: "agent", role: "member", projectId, nodeId: null, subtreeNodeIds: null };
}

async function withServer<T>(
  serverOptions: Omit<Parameters<typeof startServer>[0], "config">,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  // F1（#46）后 startServer 经连接工厂取驱动，sqlite 驱动要求显式 dataDir；
  // 与 tests/http.test.ts 同一惯例：mkdtemp 临时目录注入 config.dataDir，用完即删。
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-f2guard-"));
  const server = await startServer({
    ...serverOptions,
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function post(server: RunningServer, pathname: string, body: unknown) {
  const res = await fetch(`${server.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

test("HTTP 入口：注入的主体缺能力点时返回 403 forbidden", async () => {
  await withServer(
    {
      logger: silentLogger,
      authorization: { resolveHttpActor: ({ projectId }) => memberActor(projectId ?? "p1") },
    },
    async (server) => {
      const created = await post(server, "/api/projects", { name: "P" });
      assert.equal(created.status, 403);
      assert.equal(created.body.error.code, "forbidden");
      assert.match(created.body.error.message, /project:create/);
    },
  );
});

test("HTTP 入口：主体无法解析时按 fail-closed 拒绝", async () => {
  await withServer(
    { logger: silentLogger, authorization: { resolveHttpActor: () => null } },
    async (server) => {
      const created = await post(server, "/api/projects", { name: "P" });
      assert.equal(created.status, 403);
      assert.equal(created.body.error.code, "forbidden");
    },
  );
});

test("WS 入口：presence 声明越出主体范围时拒绝，不记录在线", async () => {
  await withServer(
    {
      logger: silentLogger,
      authorization: { resolveWsActor: () => memberActor("p1") },
    },
    async (server) => {
      const socket = new WebSocket(server.wsUrl);
      const events: ServerEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
      });
      socket.addEventListener("message", (event) => {
        events.push(JSON.parse(String(event.data)) as ServerEvent);
      });
      socket.send(JSON.stringify({ type: "presence", projectId: "p1", memberId: "m-x" }));
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(
        events.some((e) => e.type === "notice"),
        false,
        "被拒绝的 presence 不应回「presence 已更新」（普通成员没有看板读数能力点）",
      );
      const denied = events.find((e) => e.type === "error") as { code: string } | undefined;
      assert.equal(denied?.code, "forbidden");
      assert.equal(server.humanPresenceCount("p1"), 0);
      socket.close();
    },
  );
});

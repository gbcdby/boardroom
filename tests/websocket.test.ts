import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { ServerEvent } from "../src/server/ws.ts";

const silentLogger = createLogger({ write: () => {} });

async function withServer<T>(fn: (server: RunningServer) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-ws-"));
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

/** 打开连接并收集消息，直到 predicate 满足或超时。 */
function collectUntil(
  socket: WebSocket,
  predicate: (events: ServerEvent[]) => boolean,
): { events: ServerEvent[]; done: Promise<ServerEvent[]> } {
  const events: ServerEvent[] = [];
  let resolveDone: (value: ServerEvent[]) => void;
  const done = new Promise<ServerEvent[]>((resolve) => {
    resolveDone = resolve;
  });
  const timer = setTimeout(() => resolveDone(events), 3000);
  socket.addEventListener("message", (event) => {
    events.push(JSON.parse(String(event.data)) as ServerEvent);
    if (predicate(events)) {
      clearTimeout(timer);
      resolveDone(events);
    }
  });
  return { events, done };
}

test("WebSocket 连接后收到 welcome 事件", async () => {
  await withServer(async (server) => {
    const socket = new WebSocket(server.wsUrl);
    const { done } = collectUntil(socket, (events) => events.length >= 1);

    const events = await done;
    socket.close();

    assert.equal(events.length >= 1, true);
    const welcome = events[0]!;
    assert.equal(welcome.type, "welcome");
    assert.equal(typeof welcome.serverTime, "string");
    assert.equal(Number.isNaN(Date.parse(welcome.serverTime)), false);
  });
});

test("心跳配置随 welcome 下发给客户端", async () => {
  await withServer(async (server) => {
    const socket = new WebSocket(server.wsUrl);
    const { done } = collectUntil(socket, (events) => events.length >= 1);
    const events = await done;
    socket.close();

    const welcome = events[0]!;
    assert.equal(welcome.type, "welcome");
    assert.deepEqual(welcome.heartbeat, { intervalMs: 10_000, timeoutMs: 30_000 });
  });
});

test("客户端心跳 ping 收到 pong", async () => {
  await withServer(async (server) => {
    const socket = new WebSocket(server.wsUrl);
    const { done } = collectUntil(socket, (events) => events.some((e) => e.type === "pong"));
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "ping", sentAt: "2026-01-01T00:00:00.000Z" }));
    });

    const events = await done;
    socket.close();

    const pong = events.find((e) => e.type === "pong");
    assert.ok(pong, "应收到 pong");
    assert.equal(pong.sentAt, "2026-01-01T00:00:00.000Z");
  });
});

test("非法 JSON 帧收到 error 事件但连接保持", async () => {
  await withServer(async (server) => {
    const socket = new WebSocket(server.wsUrl);
    const { done } = collectUntil(socket, (events) => events.some((e) => e.type === "error"));
    socket.addEventListener("open", () => {
      socket.send("not json");
    });

    const events = await done;
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.close();

    const error = events.find((e) => e.type === "error");
    assert.ok(error);
    assert.equal(error.code, "invalid_message");
  });
});

test("服务端广播事件可送达所有连接", async () => {
  await withServer(async (server) => {
    const a = new WebSocket(server.wsUrl);
    const b = new WebSocket(server.wsUrl);
    const aEvents = collectUntil(a, (events) => events.some((e) => e.type === "notice"));
    const bEvents = collectUntil(b, (events) => events.some((e) => e.type === "notice"));

    await Promise.all([
      new Promise<void>((resolve) => a.addEventListener("open", () => resolve(), { once: true })),
      new Promise<void>((resolve) => b.addEventListener("open", () => resolve(), { once: true })),
    ]);

    server.broadcast({ type: "notice", level: "info", message: "迁移完成" });

    const [receivedA, receivedB] = await Promise.all([aEvents.done, bEvents.done]);
    a.close();
    b.close();

    assert.equal(receivedA.some((e) => e.type === "notice"), true);
    assert.equal(receivedB.some((e) => e.type === "notice"), true);
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { ServerEvent } from "../src/server/ws.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T3（#16）HTTP 聊天 API + WebSocket 广播 + 顺序测试。
 *
 * seam：HTTP/WebSocket API 边界（真实 server）。模拟「人在 WebUI」：
 * - `POST /api/groups/:id/messages` 发送；`GET` 取历史（人的视角 = 全部）；
 * - WS 收到实时 `message` 事件，顺序与持久化 seq 一致。
 */

async function withServer<T>(fn: (server: RunningServer) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t3http-"));
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

async function post(server: RunningServer, pathname: string, body: unknown) {
  const res = await fetch(`${server.url}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function seed(server: RunningServer) {
  const project = (await post(server, "/api/projects", { name: "P" })).body.project;
  const alice = (await post(server, `/api/projects/${project.id}/members`, { kind: "human", displayName: "Alice" }))
    .body.member;
  const bob = (await post(server, `/api/projects/${project.id}/members`, { kind: "human", displayName: "Bob" }))
    .body.member;
  const group = (
    await post(server, `/api/projects/${project.id}/groups`, {
      name: "G",
      participantMemberIds: [alice.id, bob.id],
    })
  ).body.group;
  return { project, alice, bob, group };
}

test("HTTP 发送消息：稳定 ID、seq 递增、@单人解析进 mentions", async () => {
  await withServer(async (server) => {
    const { alice, bob, group } = await seed(server);
    const r1 = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: alice.id,
      text: `你好 @${bob.displayName}`,
    });
    assert.equal(r1.status, 201);
    const msg = r1.body.message;
    assert.equal(typeof msg.id, "string");
    assert.equal(msg.seq, 1);
    assert.deepEqual(msg.mentions, [bob.id]);
    // 可见性：发送者 Alice + 被 @ 的 Bob（两人都是 human，人可见全部 → 也都在 visible）。
    assert.ok(msg.visibleMemberIds.includes(alice.id));

    const r2 = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: alice.id,
      text: "第二条",
    });
    assert.equal(r2.body.message.seq, 2, "seq 应群组内单调递增");
  });
});

test("HTTP @all 展开为在线参与者快照（写入 mentions，不含发送者）", async () => {
  await withServer(async (server) => {
    const { alice, bob, group } = await seed(server);
    const r = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: alice.id,
      text: "全体注意 @all",
    });
    assert.equal(r.status, 201);
    const msg = r.body.message;
    assert.ok(msg.mentions.includes(bob.id), "@all 快照应包含 Bob");
    assert.ok(!msg.mentions.includes(alice.id), "@all 快照不应包含发送者");
  });
});

test("HTTP 无效 mention 返回 400；空消息返回 400", async () => {
  await withServer(async (server) => {
    const { alice, group } = await seed(server);
    const bad = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: alice.id,
      text: "你好 @ghost",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "invalid_argument");

    const empty = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: alice.id,
      text: "   ",
    });
    assert.equal(empty.status, 400);
  });
});

test("HTTP 非参与者发送消息被拒（invalid_reference）", async () => {
  await withServer(async (server) => {
    const { project, alice, group } = await seed(server);
    const outsider = (
      await post(server, `/api/projects/${project.id}/members`, { kind: "human", displayName: "Outsider" })
    ).body.member;
    const r = await post(server, `/api/groups/${group.id}/messages`, {
      senderMemberId: outsider.id,
      text: "我不在这个群",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_reference");
    void alice;
  });
});

test("HTTP 历史按 seq 顺序返回全部消息", async () => {
  await withServer(async (server) => {
    const { alice, group } = await seed(server);
    for (const text of ["一", "二", "三"]) {
      await post(server, `/api/groups/${group.id}/messages`, { senderMemberId: alice.id, text });
    }
    const res = await fetch(`${server.url}/api/groups/${group.id}/messages`);
    const body = (await res.json()) as { messages: Array<{ seq: number; text: string }> };
    assert.deepEqual(body.messages.map((m) => m.text), ["一", "二", "三"]);
    assert.deepEqual(body.messages.map((m) => m.seq), [1, 2, 3]);
  });
});

test("WebSocket 实时收到 message 事件，顺序与持久化一致", async () => {
  await withServer(async (server) => {
    const { alice, group } = await seed(server);
    const socket = new WebSocket(server.wsUrl);
    const received: Array<{ seq: number; text: string }> = [];
    let resolveReady: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    let resolveAll: () => void;
    const all = new Promise<void>((r) => (resolveAll = r));
    socket.addEventListener("message", (ev) => {
      const event = JSON.parse(String(ev.data)) as ServerEvent;
      if (event.type === "welcome") resolveReady();
      if (event.type === "message") {
        received.push({ seq: event.message.seq, text: event.message.text });
        if (received.length === 3) resolveAll();
      }
    });
    await ready;

    for (const text of ["A", "B", "C"]) {
      await post(server, `/api/groups/${group.id}/messages`, { senderMemberId: alice.id, text });
    }
    await Promise.race([all, new Promise((r) => setTimeout(r, 3000))]);
    socket.close();
    assert.deepEqual(received.map((m) => m.text), ["A", "B", "C"]);
    assert.deepEqual(received.map((m) => m.seq), [1, 2, 3], "WS 顺序应与持久化 seq 一致");
  });
});

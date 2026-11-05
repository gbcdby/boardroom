import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { Actor } from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";

/**
 * T4（#51）状态看板与跨项目概览。
 *
 * seam：公共 HTTP 边界（GET /api/projects 的跨项目概览聚合）+ WebSocket 状态看板快照。
 * 所有断言只经公共边界，不直接查库。
 *
 * 覆盖：
 * - OVERVIEW-01 聚合字段（memberCount / groupCount / messageCount / onlineCount / lastActivityAt / status）；
 * - 跨项目概览的鉴权边界：owner 见全部，顶层 manager 只见自己项目（不泄漏），
 *   普通成员按 OVERVIEW-01 被拒（403）——不回归既有行为；
 * - 归档项目默认不进概览；?includeArchived=true 时出现且 status=archived（T1 unresolved：归档=非活跃）；
 * - 实时：归档项目仅在客户端显式 presence 后才经 WS 推送快照（按需快照，不进默认周期广播）。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withServer<T>(
  serverOptions: Omit<Parameters<typeof startServer>[0], "config">,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t4overview-"));
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

async function call(
  server: RunningServer,
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method, ...(headers ? { headers } : {}) };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json", ...(headers ?? {}) };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${server.url}${pathname}`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

function createProject(server: RunningServer, name: string): Promise<any> {
  return call(server, "POST", "/api/projects", { name }).then((r) => {
    assert.equal(r.status, 201, `创建项目应成功：${JSON.stringify(r.body)}`);
    return r.body.project;
  });
}

function addHuman(server: RunningServer, projectId: string, displayName: string): Promise<any> {
  return call(server, "POST", `/api/projects/${projectId}/members`, { kind: "human", displayName }).then((r) => {
    assert.equal(r.status, 201, `添加成员应成功：${JSON.stringify(r.body)}`);
    return r.body.member;
  });
}

function createGroup(server: RunningServer, projectId: string, name: string, participantMemberIds: string[]): Promise<any> {
  return call(server, "POST", `/api/projects/${projectId}/groups`, { name, participantMemberIds }).then((r) => {
    assert.equal(r.status, 201, `创建群组应成功：${JSON.stringify(r.body)}`);
    return r.body.group;
  });
}

function sendMessage(server: RunningServer, groupId: string, senderMemberId: string, text: string): Promise<any> {
  return call(server, "POST", `/api/groups/${groupId}/messages`, { senderMemberId, text }).then((r) => {
    assert.equal(r.status, 201, `发送消息应成功：${JSON.stringify(r.body)}`);
    return r.body.message;
  });
}

function archiveProject(server: RunningServer, projectId: string): Promise<any> {
  return call(server, "POST", `/api/projects/${projectId}/archive`).then((r) => {
    assert.equal(r.status, 200, `归档应成功：${JSON.stringify(r.body)}`);
    return r.body.project;
  });
}

test("跨项目概览：owner 看到全部项目且聚合字段正确（OVERVIEW-01）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const a = await createProject(server, "甲");
    const b = await createProject(server, "乙");
    const humanA = await addHuman(server, a.id, "Alice");
    const humanB = await addHuman(server, b.id, "Bob");
    const gA1 = await createGroup(server, a.id, "甲-群1", [humanA.id]);
    const gA2 = await createGroup(server, a.id, "甲-群2", [humanA.id]);
    const gB = await createGroup(server, b.id, "乙-群", [humanB.id]);
    await sendMessage(server, gA1.id, humanA.id, "甲第一条");
    await sendMessage(server, gA2.id, humanA.id, "甲第二条");
    await sendMessage(server, gB.id, humanB.id, "乙第一条");

    const res = await call(server, "GET", "/api/projects");
    assert.equal(res.status, 200);
    assert.equal(res.body.projects.length, 2, "owner 应看到全部两个项目");

    const projectA = res.body.projects.find((p: any) => p.id === a.id);
    const projectB = res.body.projects.find((p: any) => p.id === b.id);
    assert.ok(projectA && projectB, "两个项目都应出现");

    // 聚合字段存在且类型正确。
    for (const p of [projectA, projectB]) {
      assert.equal(typeof p.memberCount, "number");
      assert.equal(typeof p.groupCount, "number");
      assert.equal(typeof p.messageCount, "number");
      assert.equal(typeof p.onlineCount, "number");
      assert.ok(["active", "idle", "archived"].includes(p.status), "聚合状态字段合法");
    }

    assert.equal(projectA.memberCount, 1, "甲项目只有 1 名成员");
    assert.equal(projectA.groupCount, 2, "甲项目有 2 个群组");
    assert.equal(projectA.messageCount, 2, "甲项目跨两个群组共 2 条消息");
    assert.ok(projectA.lastActivityAt !== null, "甲项目应有最近活跃时间");
    // 概览的 onlineCount 不依赖 WS presence（人按 offline 计），此处无 agent 在线 → idle。
    assert.equal(projectA.status, "idle", "无成员在线时状态为 idle");

    assert.equal(projectB.messageCount, 1);
  });
});

test("跨项目概览：顶层 manager 仅见自己项目，不泄漏另一项目", async () => {
  // 收窄的项目 id 必须在 resolveHttpActor 闭包可见的作用域里声明（闭包捕获外层变量）。
  const ids: Record<string, string> = {};
  await withServer(
    {
      logger: silentLogger,
      authorization: {
        resolveHttpActor: ({ request, projectId }): Actor | null => {
          if (request.headers["x-actor"] === "manager") {
            return {
              actorId: "member-manager",
              kind: "agent",
              role: "top_manager",
              projectId: ids.a ?? null,
              nodeId: null,
              subtreeNodeIds: null,
            };
          }
          return ownerActor(projectId);
        },
      },
    },
    async (server) => {
      const a = await createProject(server, "收窄甲");
      const b = await createProject(server, "收窄乙");
      ids.a = a.id;
      ids.b = b.id;
      await addHuman(server, a.id, "Alice");

      const res = await call(server, "GET", "/api/projects", undefined, { "x-actor": "manager" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      // 行级收窄：只回他所属的那一个项目，乙项目**不泄漏**。
      assert.deepEqual(
        (res.body.projects as any[]).map((p) => p.id),
        [a.id],
        "顶层 manager 不应看到其它项目",
      );
      // 返回的项目仍带聚合字段。
      const only = res.body.projects[0];
      assert.equal(typeof only.memberCount, "number");
      assert.equal(typeof only.groupCount, "number");
      assert.equal(typeof only.messageCount, "number");
      assert.equal(typeof only.onlineCount, "number");
      assert.ok(only.lastActivityAt === null || typeof only.lastActivityAt === "string");
    },
  );
});

test("跨项目概览：普通成员被拒（OVERVIEW-01 安全边界不回归）", async () => {
  // 收窄的项目 id 必须在 resolveHttpActor 闭包可见的作用域里声明（闭包捕获外层变量）。
  const ids: Record<string, string> = {};
  await withServer(
    {
      logger: silentLogger,
      authorization: {
        resolveHttpActor: ({ request, projectId }): Actor | null => {
          if (request.headers["x-actor"] === "member") {
            return { actorId: "alice", kind: "human", role: "member", projectId: ids.a ?? null, nodeId: null, subtreeNodeIds: null };
          }
          return ownerActor(projectId);
        },
      },
    },
    async (server) => {
      const a = await createProject(server, "甲");
      const b = await createProject(server, "乙");
      ids.a = a.id;
      ids.b = b.id;
      await addHuman(server, a.id, "Alice");

      // 跨项目概览不在普通成员能力集内：连「有哪些项目」都问不到。
      const res = await call(server, "GET", "/api/projects", undefined, { "x-actor": "member" });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "forbidden");
      // 越出项目维度的概览查询不应泄漏任何项目信息。
      assert.equal(res.body.projects, undefined);
    },
  );
});

test("归档项目：默认不进概览；includeArchived 时出现且 status=archived", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const active = await createProject(server, "活跃项目");
    const archived = await createProject(server, "归档项目");
    await addHuman(server, active.id, "A");
    await addHuman(server, archived.id, "B");
    // 真正执行归档动作（T1 #48：写入归档时间；不删数据）。
    await archiveProject(server, archived.id);

    // 默认概览：仅活跃项目。
    const defaultRes = await call(server, "GET", "/api/projects");
    assert.equal(defaultRes.status, 200);
    assert.deepEqual(
      (defaultRes.body.projects as any[]).map((p) => p.id),
      [active.id],
      "默认概览不应包含已归档项目",
    );

    // 显式包含归档：归档项目出现，且聚合状态为 archived。
    const incRes = await call(server, "GET", "/api/projects?includeArchived=true");
    assert.equal(incRes.status, 200);
    const archivedView = (incRes.body.projects as any[]).find((p) => p.id === archived.id);
    assert.ok(archivedView, "includeArchived 时应出现归档项目");
    assert.equal(archivedView.status, "archived", "归档项目的聚合状态应为 archived");
    assert.equal(typeof archivedView.memberCount, "number");
    assert.equal(archivedView.memberCount, 1);
  });
});

test("WebSocket：归档项目仅在客户端声明 presence 后才推送快照（按需快照）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t4ws-arch-"));
  const server = await startServer({
    logger: silentLogger,
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 150, timeoutMs: 60_000 }, configFile: null },
  });
  try {
    const active = await createProject(server, "活跃");
    const archived = await createProject(server, "归档");
    await archiveProject(server, archived.id);

    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(server.wsUrl);
      s.addEventListener("open", () => resolve(s), { once: true });
      s.addEventListener("error", (e) => reject(e), { once: true });
    });
    const events: any[] = [];
    socket.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));

    // 先声明活跃项目 → 能看到活跃项目快照，但不应收到归档项目快照。
    socket.send(JSON.stringify({ type: "presence", projectId: active.id }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(
      events.some((e) => e.type === "status_update" && e.projectId === active.id),
      "应收到活跃项目快照",
    );
    assert.equal(
      events.some((e) => e.type === "status_update" && e.projectId === archived.id),
      false,
      "未声明时不应收到归档项目快照",
    );

    // 再声明归档项目 → 服务端按需将其纳入周期快照。
    events.length = 0;
    socket.send(JSON.stringify({ type: "presence", projectId: archived.id }));
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(
      events.some((e) => e.type === "status_update" && e.projectId === archived.id),
      "声明归档项目后应收其快照",
    );
    socket.close();
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

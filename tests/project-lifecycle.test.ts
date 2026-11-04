import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";

/**
 * T1（#48）项目与群组生命周期 + 跨项目数据隔离。
 *
 * seam（票面确认）：**项目/群组生命周期 HTTP API + 数据隔离边界**。
 * 所有断言只经过公共 HTTP 边界（含 F2 的 `resolveHttpActor` 注入点），不直接查库。
 *
 * 覆盖：PROJECT-01（多项目 + 隔离）、PROJECT-02（顶层 manager 岗位）、
 * PROJECT-03 / GROUP-04 / LIFE-ARC-01 / LIFE-ARC-02（归档、恢复、永久删除二次确认与级联清除）、
 * GROUP-01（一项目多群组、每群组一聊天室）、GROUP-02（参与者仅项目成员、同成员可参与多群组）、
 * AC-PROJ-01..03 与 AC-IDENT-01 中与跨项目身份/隔离相关的部分。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withServer<T>(
  serverOptions: Omit<Parameters<typeof startServer>[0], "config">,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  // F1（#46）后 startServer 经连接工厂取驱动，sqlite 驱动要求显式 dataDir。
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1lifecycle-"));
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
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${server.url}${pathname}`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** 建一个项目，返回项目对象。 */
async function createProject(server: RunningServer, name: string): Promise<any> {
  const created = await call(server, "POST", "/api/projects", { name });
  assert.equal(created.status, 201, `创建项目应成功：${JSON.stringify(created.body)}`);
  return created.body.project;
}

/** 建一个 human 成员，返回成员对象。 */
async function addHuman(server: RunningServer, projectId: string, displayName: string): Promise<any> {
  const added = await call(server, "POST", `/api/projects/${projectId}/members`, {
    kind: "human",
    displayName,
  });
  assert.equal(added.status, 201, `添加成员应成功：${JSON.stringify(added.body)}`);
  return added.body.member;
}

/** 建一个群组，返回群组对象。 */
async function createGroup(
  server: RunningServer,
  projectId: string,
  name: string,
  participantMemberIds: string[],
): Promise<any> {
  const created = await call(server, "POST", `/api/projects/${projectId}/groups`, {
    name,
    participantMemberIds,
  });
  assert.equal(created.status, 201, `创建群组应成功：${JSON.stringify(created.body)}`);
  return created.body.group;
}

// ---------------------------------------------------------------------------
// 循环 A：项目归档 / 恢复（PROJECT-03、LIFE-ARC-01）
// ---------------------------------------------------------------------------

test("项目可归档：归档后从默认列表消失，includeArchived 可见，GET 单项目仍可定位", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "待归档项目");
    const kept = await createProject(server, "在用项目");

    const archived = await call(server, "POST", `/api/projects/${project.id}/archive`);
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(typeof archived.body.project.archivedAt, "string", "归档后应带 archivedAt");

    const active = await call(server, "GET", "/api/projects");
    assert.equal(active.status, 200);
    const activeIds = (active.body.projects as any[]).map((p) => p.id);
    assert.ok(!activeIds.includes(project.id), "默认列表不应包含已归档项目");
    assert.ok(activeIds.includes(kept.id), "未归档项目照常列出");

    const all = await call(server, "GET", "/api/projects?includeArchived=true");
    assert.equal(all.status, 200);
    const listed = (all.body.projects as any[]).find((p) => p.id === project.id);
    assert.ok(listed, "includeArchived=true 应列出已归档项目");
    assert.equal(typeof listed.archivedAt, "string");

    // 归档项目仍可定位（恢复入口需要它）。
    const single = await call(server, "GET", `/api/projects/${project.id}`);
    assert.equal(single.status, 200);
    assert.equal(single.body.project.archivedAt, listed.archivedAt);
  });
});

test("项目可恢复：恢复后回到默认列表且 archivedAt 为空（归档可恢复）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "会回来的项目");
    await call(server, "POST", `/api/projects/${project.id}/archive`);

    const restored = await call(server, "POST", `/api/projects/${project.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.project.archivedAt, null, "恢复后 archivedAt 应为空");

    const active = await call(server, "GET", "/api/projects");
    const activeIds = (active.body.projects as any[]).map((p) => p.id);
    assert.ok(activeIds.includes(project.id), "恢复后应回到默认列表");
  });
});

// ---------------------------------------------------------------------------
// 占位：以下循环按 TDD 逐个补入（B 群组归档、C 归档写路径、D/E 永久删除、
// F 守卫、G 隔离、H 多群组）
// ---------------------------------------------------------------------------

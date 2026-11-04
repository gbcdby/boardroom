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
// 循环 B：群组归档 / 恢复（GROUP-04、LIFE-ARC-01）
// ---------------------------------------------------------------------------

test("群组可归档：默认项目群组列表隐藏它，includeArchived 可见，参与者仍可读", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "多群组项目");
    const alice = await addHuman(server, project.id, "Alice");
    const kept = await createGroup(server, project.id, "在用群组", [alice.id]);
    const retired = await createGroup(server, project.id, "解散中的群组", [alice.id]);

    const archived = await call(server, "POST", `/api/groups/${retired.id}/archive`);
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(typeof archived.body.group.archivedAt, "string", "归档后应带 archivedAt");

    const active = await call(server, "GET", `/api/projects/${project.id}/groups`);
    assert.equal(active.status, 200);
    const ids = (active.body.groups as any[]).map((g) => g.id);
    assert.ok(!ids.includes(retired.id), "默认列表不应包含已归档群组");
    assert.ok(ids.includes(kept.id), "未归档群组照常列出");

    const all = await call(server, "GET", `/api/projects/${project.id}/groups?includeArchived=true`);
    const listed = (all.body.groups as any[]).find((g) => g.id === retired.id);
    assert.ok(listed, "includeArchived=true 应列出已归档群组");
    assert.equal(typeof listed.archivedAt, "string");

    // 归档不删数据：参与者关系仍在（恢复入口与后续审计需要它）。
    const participants = await call(server, "GET", `/api/groups/${retired.id}/participants`);
    assert.equal(participants.status, 200);
    assert.deepEqual((participants.body.participants as any[]).map((m) => m.id), [alice.id]);
  });
});

test("群组可恢复：恢复后回到项目群组列表且 archivedAt 为空", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "会回来的群组项目");
    const alice = await addHuman(server, project.id, "Alice");
    const group = await createGroup(server, project.id, "临时群组", [alice.id]);
    await call(server, "POST", `/api/groups/${group.id}/archive`);

    const restored = await call(server, "POST", `/api/groups/${group.id}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.group.archivedAt, null);

    const active = await call(server, "GET", `/api/projects/${project.id}/groups`);
    const ids = (active.body.groups as any[]).map((g) => g.id);
    assert.ok(ids.includes(group.id), "恢复后应回到默认列表");
  });
});

// ---------------------------------------------------------------------------
// 循环 C：归档 = 非活跃态，写路径被拒（PROJECT-03、GROUP-04 的可观察后果）
// ---------------------------------------------------------------------------

test("已归档项目拒绝新写入：建群组/加成员/指定 manager 返回 409 archived，恢复后放行", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "归档后不再新增");
    const alice = await addHuman(server, project.id, "Alice");
    await call(server, "POST", `/api/projects/${project.id}/archive`);

    const group = await call(server, "POST", `/api/projects/${project.id}/groups`, {
      name: "归档后新建群组",
      participantMemberIds: [alice.id],
    });
    assert.equal(group.status, 409, JSON.stringify(group.body));
    assert.equal(group.body.error.code, "archived");

    const member = await call(server, "POST", `/api/projects/${project.id}/members`, {
      kind: "human",
      displayName: "Bob",
    });
    assert.equal(member.status, 409);
    assert.equal(member.body.error.code, "archived");

    const manager = await call(server, "PUT", `/api/projects/${project.id}/manager`, {
      memberId: alice.id,
    });
    assert.equal(manager.status, 409);
    assert.equal(manager.body.error.code, "archived");

    // 恢复后同样的写入应当放行（归档是可恢复态，不是只读墓碑）。
    await call(server, "POST", `/api/projects/${project.id}/restore`);
    const afterRestore = await call(server, "POST", `/api/projects/${project.id}/groups`, {
      name: "恢复后新建群组",
      participantMemberIds: [alice.id],
    });
    assert.equal(afterRestore.status, 201, JSON.stringify(afterRestore.body));
  });
});

test("已归档群组拒绝新消息：发送返回 409 archived，同项目的其他群组不受影响", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "两群组项目");
    const alice = await addHuman(server, project.id, "Alice");
    const active = await createGroup(server, project.id, "在用群组", [alice.id]);
    const retired = await createGroup(server, project.id, "已归档群组", [alice.id]);
    await call(server, "POST", `/api/groups/${retired.id}/archive`);

    const blocked = await call(server, "POST", `/api/groups/${retired.id}/messages`, {
      senderMemberId: alice.id,
      text: "归档后还想说话",
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error.code, "archived");

    // 隔离在群组级：同项目的未归档群组照常收消息。
    const allowed = await call(server, "POST", `/api/groups/${active.id}/messages`, {
      senderMemberId: alice.id,
      text: "照常发言",
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

    // 已归档群组的既有历史仍可读（归档不删数据）。
    const history = await call(server, "GET", `/api/groups/${retired.id}/messages`);
    assert.equal(history.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 占位：以下循环按 TDD 逐个补入（D/E 永久删除、F 守卫、G 隔离、H 多群组）
// ---------------------------------------------------------------------------

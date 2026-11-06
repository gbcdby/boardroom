import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { Actor } from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";

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
// 循环 D：项目永久删除 = 人二次确认 + 级联清除（PROJECT-03、LIFE-ARC-02）
// ---------------------------------------------------------------------------

/** 同一个数据目录里连续启停（验证删除是持久化的，不是进程内标记）。 */
async function withPersistentServer<T>(
  dir: string,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const server = await startServer({
    config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null },
    logger: silentLogger,
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test("项目永久删除需二次确认：首次只给级联清单与确认凭据，确认后彻底清除且不影响其他项目", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1purge-"));
  let doomedId = "";
  try {
    await withPersistentServer(dir, async (server) => {
      const doomed = await createProject(server, "要删掉的项目");
      doomedId = doomed.id;
      const other = await createProject(server, "别动的项目");
      const dave = await addHuman(server, doomed.id, "Dave");
      const ogave = await addHuman(server, other.id, "Oga");
      const doomedGroup = await createGroup(server, doomed.id, "将被清除的群组", [dave.id]);
      const otherGroup = await createGroup(server, other.id, "另一个项目的群组", [ogave.id]);
      await call(server, "POST", `/api/groups/${doomedGroup.id}/messages`, {
        senderMemberId: dave.id,
        text: "第一条",
      });
      await call(server, "POST", `/api/groups/${otherGroup.id}/messages`, {
        senderMemberId: ogave.id,
        text: "别的项目的消息",
      });

      // 第一刀：没有确认凭据 → 不删，只返回级联清单与一次性凭据。
      const first = await call(server, "DELETE", `/api/projects/${doomed.id}`);
      assert.equal(first.status, 409, JSON.stringify(first.body));
      assert.equal(first.body.error.code, "confirmation_required");
      const confirmation = first.body.confirmation;
      assert.equal(confirmation.projectId, doomed.id);
      assert.equal(confirmation.projectName, "要删掉的项目");
      assert.equal(typeof confirmation.token, "string");
      assert.equal(typeof confirmation.expiresAt, "string");
      assert.ok(confirmation.cascade.groups >= 1, "清单应包含将被清除的群组数");
      assert.ok(confirmation.cascade.members >= 1, "清单应包含将被清除的成员数");
      assert.ok(confirmation.cascade.messages >= 1, "清单应包含将被清除的群聊消息数");

      // 未确认时数据仍在。
      assert.equal((await call(server, "GET", `/api/projects/${doomed.id}`)).status, 200);

      // 凭据不对 → 拒绝执行，不删。
      const bad = await call(server, "DELETE", `/api/projects/${doomed.id}`, { confirm: "not-the-token" });
      assert.equal(bad.status, 400, JSON.stringify(bad.body));
      assert.equal(bad.body.error.code, "invalid_confirmation");
      assert.equal((await call(server, "GET", `/api/projects/${doomed.id}`)).status, 200);

      // 第二刀：带上一轮给出的确认凭据 → 永久删除。
      const purged = await call(server, "DELETE", `/api/projects/${doomed.id}`, {
        confirm: confirmation.token,
      });
      assert.equal(purged.status, 204, JSON.stringify(purged.body));
      assert.equal((await call(server, "GET", `/api/projects/${doomed.id}`)).status, 404);
      assert.equal((await call(server, "GET", `/api/groups/${doomedGroup.id}/messages`)).status, 404);

      // 级联清除只覆盖本项目：其他项目的项目/群组/消息照常可读（PROJECT-01 隔离）。
      const projects = await call(server, "GET", "/api/projects");
      assert.deepEqual((projects.body.projects as any[]).map((p) => p.id), [other.id]);
      assert.equal((await call(server, "GET", `/api/projects/${other.id}/groups`)).body.groups.length, 1);
      const history = await call(server, "GET", `/api/groups/${otherGroup.id}/messages`);
      assert.equal(history.status, 200);
      assert.equal((history.body.messages as any[]).length, 1);
    });

    // 重启后仍然是「已永久删除」：清除落在持久层，不是进程内标记。
    await withPersistentServer(dir, async (server) => {
      assert.equal((await call(server, "GET", `/api/projects/${doomedId}`)).status, 404);
      const projects = await call(server, "GET", "/api/projects");
      assert.equal((projects.body.projects as any[]).length, 1);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 循环 E：群组永久删除 = 只清群聊与参与者关系（GROUP-04、LIFE-ARC-02）
// ---------------------------------------------------------------------------

test("群组永久删除需二次确认，且只清群聊与参与者关系：成员与同项目其他群组不受影响", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t1gpurge-"));
  let doomedGroupId = "";
  try {
    await withPersistentServer(dir, async (server) => {
      const project = await createProject(server, "两群组一个要删");
      const alice = await addHuman(server, project.id, "Alice");
      const bob = await addHuman(server, project.id, "Bob");
      const doomedGroup = await createGroup(server, project.id, "解散的群组", [alice.id, bob.id]);
      doomedGroupId = doomedGroup.id;
      const keptGroup = await createGroup(server, project.id, "留下的群组", [alice.id]);
      await call(server, "POST", `/api/groups/${doomedGroup.id}/messages`, {
        senderMemberId: alice.id,
        text: "要被清掉的一条",
      });
      await call(server, "POST", `/api/groups/${doomedGroup.id}/messages`, {
        senderMemberId: bob.id,
        text: "要被清掉的二条",
      });
      await call(server, "POST", `/api/groups/${keptGroup.id}/messages`, {
        senderMemberId: alice.id,
        text: "留下的一条",
      });

      // 第一刀：只给清单，不删。
      const first = await call(server, "DELETE", `/api/groups/${doomedGroup.id}`);
      assert.equal(first.status, 409, JSON.stringify(first.body));
      assert.equal(first.body.error.code, "confirmation_required");
      assert.equal(first.body.confirmation.kind, "group");
      assert.equal(first.body.confirmation.cascade.messages, 2);
      assert.equal(first.body.confirmation.cascade.participants, 2);
      assert.equal((await call(server, "GET", `/api/groups/${doomedGroup.id}/participants`)).status, 200);

      // 第二刀：带确认凭据后删除。
      const purged = await call(server, "DELETE", `/api/groups/${doomedGroup.id}`, {
        confirm: first.body.confirmation.token,
      });
      assert.equal(purged.status, 204, JSON.stringify(purged.body));
      assert.equal((await call(server, "GET", `/api/groups/${doomedGroup.id}`)).status, 404);
      assert.equal((await call(server, "GET", `/api/groups/${doomedGroup.id}/messages`)).status, 404);

      // 成员本身保留（LIFE-ARC-02：删群组不清项目成员）。
      const members = await call(server, "GET", `/api/projects/${project.id}/members`);
      assert.equal(members.status, 200);
      assert.deepEqual(
        (members.body.members as any[]).map((m) => m.displayName).sort(),
        ["Alice", "Bob"],
      );

      // 同项目另一个群组的群聊与参与者关系完好，成员仍能发言（多群组关系未被牵连）。
      const keptHistory = await call(server, "GET", `/api/groups/${keptGroup.id}/messages`);
      assert.equal((keptHistory.body.messages as any[]).length, 1);
      const keptParticipants = await call(server, "GET", `/api/groups/${keptGroup.id}/participants`);
      assert.deepEqual((keptParticipants.body.participants as any[]).map((m) => m.id), [alice.id]);
      const stillSends = await call(server, "POST", `/api/groups/${keptGroup.id}/messages`, {
        senderMemberId: alice.id,
        text: "删除其他群组后照常发言",
      });
      assert.equal(stillSends.status, 201, JSON.stringify(stillSends.body));

      const groups = await call(server, "GET", `/api/projects/${project.id}/groups?includeArchived=true`);
      assert.deepEqual((groups.body.groups as any[]).map((g) => g.id), [keptGroup.id]);
    });

    // 重启后仍是已删除状态（删除落在持久层）。
    await withPersistentServer(dir, async (server) => {
      assert.equal((await call(server, "GET", `/api/groups/${doomedGroupId}`)).status, 404);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 循环 F：谁能归档 / 谁能永久删除（LIFE-ARC-01、AC-LIFE-01）
// ---------------------------------------------------------------------------

test("顶层 manager 可归档项目与群组，但不能发起永久删除（403），人才能发起（409 待确认）", async () => {
  const managerActor = (projectId: string): Actor => ({
    actorId: "member-manager",
    kind: "agent",
    role: "top_manager",
    projectId,
    nodeId: null,
    subtreeNodeIds: null,
  });

  await withServer(
    {
      logger: silentLogger,
      // F2 注入点：本用例按请求头切换主体，模拟「以顶层 manager 身份调用」与「以人身份调用」。
      authorization: {
        resolveHttpActor: async ({ request, projectId }) =>
          request.headers["x-as"] === "manager" ? managerActor(projectId ?? "") : ownerActor(projectId),
      },
    },
    async (server) => {
      const asManager = { "x-as": "manager" };
      const project = await createProject(server, "谁能删");
      const alice = await addHuman(server, project.id, "Alice");
      const group = await createGroup(server, project.id, "群组", [alice.id]);

      // 顶层 manager：归档可以（project:archive / group:archive 在能力集里）。
      const archiveProject = await call(server, "POST", `/api/projects/${project.id}/archive`, undefined, asManager);
      assert.equal(archiveProject.status, 200, JSON.stringify(archiveProject.body));
      const restoreProject = await call(server, "POST", `/api/projects/${project.id}/restore`, undefined, asManager);
      assert.equal(restoreProject.status, 200);
      const archiveGroup = await call(server, "POST", `/api/groups/${group.id}/archive`, undefined, asManager);
      assert.equal(archiveGroup.status, 200, JSON.stringify(archiveGroup.body));
      await call(server, "POST", `/api/groups/${group.id}/restore`);

      // 顶层 manager：永久删除被守卫拒绝，连确认清单都拿不到（LIFE-ARC-01）。
      const purgeProject = await call(server, "DELETE", `/api/projects/${project.id}`, undefined, asManager);
      assert.equal(purgeProject.status, 403, JSON.stringify(purgeProject.body));
      assert.equal(purgeProject.body.error.code, "forbidden");
      assert.match(purgeProject.body.error.message, /project:purge/);
      const purgeGroup = await call(server, "DELETE", `/api/groups/${group.id}`, undefined, asManager);
      assert.equal(purgeGroup.status, 403, JSON.stringify(purgeGroup.body));
      assert.match(purgeGroup.body.error.message, /group:purge/);

      // 数据仍在：拒绝发生在写入之前。
      assert.equal((await call(server, "GET", `/api/projects/${project.id}`)).status, 200);
      assert.equal((await call(server, "GET", `/api/groups/${group.id}`)).status, 200);

      // 人（owner）：可发起，但要走二次确认（409 待确认，而不是直接删）。
      const humanPurge = await call(server, "DELETE", `/api/projects/${project.id}`);
      assert.equal(humanPurge.status, 409);
      assert.equal(humanPurge.body.error.code, "confirmation_required");
    },
  );
});

// ---------------------------------------------------------------------------
// 循环 G：跨项目数据隔离 + 列表按主体收窄（PROJECT-01、AC-PROJ-01、AC-IDENT-01 部分）
// ---------------------------------------------------------------------------

test("项目间数据隔离：成员/群组/群聊按项目作用域互不可见，跨项目引用被拒", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const a = await createProject(server, "项目甲");
    const b = await createProject(server, "项目乙");
    const alice = await addHuman(server, a.id, "Alice");
    const bob = await addHuman(server, b.id, "Bob");
    const groupA = await createGroup(server, a.id, "甲群组", [alice.id]);
    const groupB = await createGroup(server, b.id, "乙群组", [bob.id]);

    await call(server, "POST", `/api/groups/${groupA.id}/messages`, {
      senderMemberId: alice.id,
      text: "只在甲项目说的一句话",
    });

    // 成员与群组按项目作用域列出，互不串。
    const membersA = await call(server, "GET", `/api/projects/${a.id}/members`);
    assert.deepEqual((membersA.body.members as any[]).map((m) => m.id), [alice.id]);
    const groupsA = await call(server, "GET", `/api/projects/${a.id}/groups`);
    assert.deepEqual((groupsA.body.groups as any[]).map((g) => g.id), [groupA.id]);
    const groupsB = await call(server, "GET", `/api/projects/${b.id}/groups`);
    assert.deepEqual((groupsB.body.groups as any[]).map((g) => g.id), [groupB.id]);

    // 聊天室按群组隔离：乙群组读不到甲群组的群聊。
    const historyB = await call(server, "GET", `/api/groups/${groupB.id}/messages`);
    assert.equal((historyB.body.messages as any[]).length, 0);

    // 跨项目引用被拒：不能把乙项目成员拉进甲项目的群组（GROUP-02）。
    const crossCreate = await call(server, "POST", `/api/projects/${a.id}/groups`, {
      name: "越界群组",
      participantMemberIds: [bob.id],
    });
    assert.equal(crossCreate.status, 400, JSON.stringify(crossCreate.body));
    assert.equal(crossCreate.body.error.code, "invalid_reference");

    // 跨项目发言同样被拒。
    const crossSend = await call(server, "POST", `/api/groups/${groupA.id}/messages`, {
      senderMemberId: bob.id,
      text: "想混进甲群组",
    });
    assert.equal(crossSend.status, 400, JSON.stringify(crossSend.body));
    assert.equal(crossSend.body.error.code, "invalid_reference");
  });
});

test("列表按主体收窄：跨项目概览只有人/顶层 manager 问得到，普通成员只看自己参与的群组", async () => {
  const ids = { a: "", b: "", alice: "", joined: "", notJoined: "" };

  await withServer(
    {
      logger: silentLogger,
      // F2 注入点：同一服务里按请求头切换主体——人（owner）建数据，
      // 之后以「甲项目的普通成员 Alice」为主体读取列表，验证行级收窄。
      authorization: {
        resolveHttpActor: async ({ request, projectId }) => {
          const as = request.headers["x-actor"];
          if (as === "member") {
            return {
              actorId: ids.alice,
              kind: "human",
              role: "member",
              projectId: ids.a,
              nodeId: null,
              subtreeNodeIds: null,
            };
          }
          if (as === "manager") {
            return {
              actorId: "member-manager",
              kind: "agent",
              role: "top_manager",
              projectId: ids.a,
              nodeId: null,
              subtreeNodeIds: null,
            };
          }
          return ownerActor(projectId);
        },
      },
    },
    async (server) => {
      const member = { "x-actor": "member" };
      const manager = { "x-actor": "manager" };
      const a = await createProject(server, "收窄甲");
      const b = await createProject(server, "收窄乙");
      ids.a = a.id;
      ids.b = b.id;
      const alice = await addHuman(server, a.id, "Alice");
      const carol = await addHuman(server, a.id, "Carol");
      ids.alice = alice.id;
      await addHuman(server, b.id, "Bob");
      const joined = await createGroup(server, a.id, "甲-她参与", [alice.id, carol.id]);
      const notJoined = await createGroup(server, a.id, "甲-她未参与", [carol.id]);
      ids.joined = joined.id;
      ids.notJoined = notJoined.id;
      await createGroup(server, b.id, "乙-群组", []);

      // 跨项目概览本身不在普通成员的能力集里：连「有哪些项目」都问不到（OVERVIEW-01）。
      const memberProjects = await call(server, "GET", "/api/projects", undefined, member);
      assert.equal(memberProjects.status, 403, JSON.stringify(memberProjects.body));
      assert.equal(memberProjects.body.error.code, "forbidden");

      // 顶层 manager 有 overview:view，但行级收窄只回他所属的那一个项目。
      const managerProjects = await call(server, "GET", "/api/projects", undefined, manager);
      assert.equal(managerProjects.status, 200, JSON.stringify(managerProjects.body));
      assert.deepEqual((managerProjects.body.projects as any[]).map((p) => p.id), [a.id]);

      // 群组列表收窄到她参与的群组：未参与的群组**不出现**，不泄漏存在。
      const groups = await call(server, "GET", `/api/projects/${a.id}/groups`, undefined, member);
      assert.equal(groups.status, 200, JSON.stringify(groups.body));
      assert.deepEqual((groups.body.groups as any[]).map((g) => g.id), [joined.id]);

      // 越出项目：403 cross_project（不返回别的项目的群组清单）。
      const cross = await call(server, "GET", `/api/projects/${b.id}/groups`, undefined, member);
      assert.equal(cross.status, 403, JSON.stringify(cross.body));
      assert.equal(cross.body.error.code, "cross_project");

      // 未参与的同项目群组：读历史被拒 not_visible（AC-IDENT-01「不能读未参与群组消息」）。
      const history = await call(server, "GET", `/api/groups/${notJoined.id}/messages`, undefined, member);
      assert.equal(history.status, 403, JSON.stringify(history.body));
      assert.equal(history.body.error.code, "not_visible");

      // 归档这类生命周期动作不在她的能力集里。
      const archive = await call(server, "POST", `/api/projects/${a.id}/archive`, undefined, member);
      assert.equal(archive.status, 403, JSON.stringify(archive.body));
      assert.equal(archive.body.error.code, "forbidden");
    },
  );
});

// ---------------------------------------------------------------------------
// 循环 H：一项目多群组 + 每群组一个聊天室（GROUP-01、GROUP-02、AC-PROJ-02）
// ---------------------------------------------------------------------------

test("一项目多群组：每群组一个聊天室，序号与历史各自独立，同一成员可同时参与多个群组", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "多群组聊天室");
    const alice = await addHuman(server, project.id, "Alice");
    const bob = await addHuman(server, project.id, "Bob");
    const design = await createGroup(server, project.id, "设计组", [alice.id, bob.id]);
    const ops = await createGroup(server, project.id, "运维组", [alice.id]);

    // 两个群组都在同一项目下。
    const groups = await call(server, "GET", `/api/projects/${project.id}/groups`);
    assert.deepEqual((groups.body.groups as any[]).map((g) => g.id).sort(), [design.id, ops.id].sort());

    // 同一成员参与多个群组（GROUP-02）。
    const designMembers = await call(server, "GET", `/api/groups/${design.id}/participants`);
    const opsMembers = await call(server, "GET", `/api/groups/${ops.id}/participants`);
    assert.deepEqual((designMembers.body.participants as any[]).map((m) => m.id).sort(), [alice.id, bob.id].sort());
    assert.deepEqual((opsMembers.body.participants as any[]).map((m) => m.id), [alice.id]);

    // 每个聊天室自己的 seq 从 1 起算，历史互不混入。
    const d1 = await call(server, "POST", `/api/groups/${design.id}/messages`, {
      senderMemberId: alice.id,
      text: "设计组第一条",
    });
    const d2 = await call(server, "POST", `/api/groups/${design.id}/messages`, {
      senderMemberId: bob.id,
      text: "设计组第二条",
    });
    const o1 = await call(server, "POST", `/api/groups/${ops.id}/messages`, {
      senderMemberId: alice.id,
      text: "运维组第一条",
    });
    assert.equal(d1.body.message.seq, 1);
    assert.equal(d2.body.message.seq, 2);
    assert.equal(o1.body.message.seq, 1, "另一个聊天室的序号应独立起算");

    const designHistory = await call(server, "GET", `/api/groups/${design.id}/messages`);
    const opsHistory = await call(server, "GET", `/api/groups/${ops.id}/messages`);
    assert.deepEqual((designHistory.body.messages as any[]).map((m) => m.text), ["设计组第一条", "设计组第二条"]);
    assert.deepEqual((opsHistory.body.messages as any[]).map((m) => m.text), ["运维组第一条"]);

    // 不是该群组参与者就不能发言（即便同项目）。
    const notParticipant = await call(server, "POST", `/api/groups/${ops.id}/messages`, {
      senderMemberId: bob.id,
      text: "我不在运维组",
    });
    assert.equal(notParticipant.status, 400, JSON.stringify(notParticipant.body));
    assert.equal(notParticipant.body.error.code, "invalid_reference");
  });
});

// ---------------------------------------------------------------------------
// 循环 I：同一 agent 跨项目的独立身份与群聊隔离（AC-IDENT-01 的跨项目部分）
// seam：MCP 工具边界（真实 Streamable HTTP，与宿主同一 wire 协议）+ 项目/群组 HTTP API。
// ---------------------------------------------------------------------------

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function connectAgent(server: RunningServer, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
    reconnectionOptions: {
      initialReconnectionDelay: 50,
      maxReconnectionDelay: 200,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 0,
    },
  });
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.ok(text, `工具 ${name} 应返回 text`);
  return JSON.parse(text) as ToolPayload;
}

test("同一 agent 参与两个项目：全局身份相同、项目岗位各自独立，群聊不跨项目泄漏", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const a = await createProject(server, "身份甲项目");
    const b = await createProject(server, "身份乙项目");
    const groupA = await createGroup(server, a.id, "甲群组", []);
    const groupB = await createGroup(server, b.id, "乙群组", []);

    // 两个会话、同一个 (displayName, hostType) = 同一个全局 agent 身份。
    const clientA = await connectAgent(server, "agent-in-a");
    const clientB = await connectAgent(server, "agent-in-b");
    try {
      const joinA = await callTool(clientA, "join", {
        displayName: "Kimi",
        hostType: "claude-code",
        projectId: a.id,
        groupId: groupA.id,
      });
      const joinB = await callTool(clientB, "join", {
        displayName: "Kimi",
        hostType: "claude-code",
        projectId: b.id,
        groupId: groupB.id,
      });
      assert.equal(joinA.ok, true, JSON.stringify(joinA));
      assert.equal(joinB.ok, true, JSON.stringify(joinB));

      // 全局身份唯一：同一个 agent；项目内成员关系（岗位）按项目分开。
      assert.equal(String(joinA.agentId), String(joinB.agentId), "同 displayName+hostType 应复用同一全局 agent");
      assert.notEqual(String(joinA.memberId), String(joinB.memberId), "两个项目应有各自独立的成员岗位");

      // 在甲项目发言 → 乙项目的同一 agent 读不到（连接只绑定自己那个群组）。
      const sent = await callTool(clientA, "send_message", { text: "只在甲群组说的话" });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const historyB = await callTool(clientB, "read_history", {});
      assert.equal(historyB.ok, true, JSON.stringify(historyB));
      const textsB = (historyB["messages"] as any[] ?? []).map((m) => m.text);
      assert.ok(!textsB.includes("只在甲群组说的话"), "乙项目会话不应读到甲项目的群聊");

      // 想跨项目发言：被连接的允许范围挡住（#37 conn-scoped 强制点）。
      const cross = await callTool(clientB, "send_message", {
        groupId: groupA.id,
        text: "想跨项目发言",
      });
      assert.equal(cross.ok, false, JSON.stringify(cross));
      assert.equal(cross.error?.code, "FORBIDDEN");
    } finally {
      await clientA.close();
      await clientB.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 循环 J：每项目一个顶层 manager（PROJECT-02）跨项目互不影响
// ---------------------------------------------------------------------------

test("每个项目各有自己的顶层 manager：一个项目指定 manager 不影响另一个项目", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const a = await createProject(server, "经理甲项目");
    const b = await createProject(server, "经理乙项目");
    const alice = await addHuman(server, a.id, "Alice");
    const bob = await addHuman(server, b.id, "Bob");

    // 创建时都留空：manager 为 null，等待后续分配（PROJECT-02）。
    assert.equal(a.manager, null);
    assert.equal(b.manager, null);

    const setA = await call(server, "PUT", `/api/projects/${a.id}/manager`, { memberId: alice.id });
    assert.equal(setA.status, 200, JSON.stringify(setA.body));
    assert.equal(setA.body.project.manager.id, alice.id);

    const projects = await call(server, "GET", "/api/projects");
    const byId = Object.fromEntries(
      (projects.body.projects as any[]).map((p) => [p.id, p.manager?.id ?? null]),
    );
    assert.equal(byId[a.id], alice.id, "甲项目应有自己的 manager");
    assert.equal(byId[b.id], null, "乙项目不受影响，仍是留空待分配");

    const setB = await call(server, "PUT", `/api/projects/${b.id}/manager`, { memberId: bob.id });
    assert.equal(setB.body.project.manager.id, bob.id);
    const after = await call(server, "GET", `/api/projects/${a.id}`);
    assert.equal(after.body.project.manager.id, alice.id, "甲项目的 manager 不被乙项目顶掉");
  });
});

// ---------------------------------------------------------------------------
// 循环 K：PROJECT-02「创建时指定」——同一请求里把已有全局 agent 落为该项目的 manager
// ---------------------------------------------------------------------------

test("创建项目时可同时指定顶层 manager（留空仍可稍后分配）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    // 先让一个 agent 通过 MCP 在别的项目里取得全局身份（真实入群，不造占位数据）。
    const first = await createProject(server, "身份来源项目");
    const firstGroup = await createGroup(server, first.id, "来源群组", []);
    const client = await connectAgent(server, "manager-candidate");
    let agentId = "";
    try {
      const join = await callTool(client, "join", {
        displayName: "PM",
        hostType: "claude-code",
        projectId: first.id,
        groupId: firstGroup.id,
      });
      assert.equal(join.ok, true, JSON.stringify(join));
      agentId = String(join.agentId);
    } finally {
      await client.close();
    }

    // 创建时指定：同一个 agent 在新项目里就是顶层 manager。
    const created = await call(server, "POST", "/api/projects", {
      name: "创建时定经理",
      managerAgentId: agentId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.manager?.displayName, "PM");
    assert.equal(created.body.project.manager?.role, "manager");
    assert.notEqual(created.body.project.manager?.id, undefined);

    // 留空仍然可用（既有流程不变）。
    const blank = await createProject(server, "留空待分配");
    assert.equal(blank.manager, null);

    // 指定不存在的 agent → 明确引用错误，不静默创建项目。
    const bogus = await call(server, "POST", "/api/projects", {
      name: "假经理",
      managerAgentId: "00000000000000000000000000",
    });
    assert.equal(bogus.status, 400, JSON.stringify(bogus.body));
    assert.equal(bogus.body.error.code, "invalid_reference");
    const projects = await call(server, "GET", "/api/projects");
    assert.ok(
      !(projects.body.projects as any[]).some((p) => p.name === "假经理"),
      "引用校验失败时不应留下项目",
    );
  });
});

// ---------------------------------------------------------------------------
// 循环 L：归档群组不再接受新的参与者（MCP 入群也受同一条归档写规则约束）
// ---------------------------------------------------------------------------

test("已归档群组不能被加入：MCP 入群在归档写规则前被拒", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "归档群组项目");
    const group = await createGroup(server, project.id, "只读归档群组", []);
    await call(server, "POST", `/api/groups/${group.id}/archive`);

    const client = await connectAgent(server, "late-joiner");
    try {
      const join = await callTool(client, "join", {
        displayName: "Late",
        hostType: "codex-cli",
        projectId: project.id,
        groupId: group.id,
      });
      assert.equal(join.ok, false, JSON.stringify(join));
      assert.equal(join.error?.code, "CONFLICT");
      assert.match(String(join.error?.message), /归档/);
    } finally {
      await client.close();
    }

    // 恢复后照常可入群（归档是可恢复态）。
    await call(server, "POST", `/api/groups/${group.id}/restore`);
    const reopened = await connectAgent(server, "late-joiner-2");
    try {
      const join = await callTool(reopened, "join", {
        displayName: "Late2",
        hostType: "codex-cli",
        projectId: project.id,
        groupId: group.id,
      });
      assert.equal(join.ok, true, JSON.stringify(join));
    } finally {
      await reopened.close();
    }
  });
});

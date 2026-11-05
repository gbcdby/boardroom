import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDatabase } from "../src/server/db/database.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { Actor } from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import {
  ArchivedError,
  ConflictError,
  InvalidArgumentError,
  NotFoundError,
} from "../src/server/db/errors.ts";
import type { Member } from "../src/server/db/types.ts";

/**
 * T3（#50）成员生命周期。
 *
 * seam（票面确认）：**成员状态机 + 归档/删除守卫**。
 * - 本文件的 repository 段直接走 `createRepositories(db).members` 公共数据访问边界
 *   （与 `tests/repositories.test.ts` 同一 seam），验证状态机本身：枚举、转换、
 *   disable 保留历史/数据/岗位、re-enable 恢复岗位、非法转换拒绝、持久化、升级默认 active。
 * - HTTP 段走 `/api` 公共边界（含 F2 `resolveHttpActor` 注入点），验证守卫限制与
 *   生命周期端点接入：ORG-07（顶层 manager 增删/暂停无需确认）、AC-LIFE-01（manager
 *   不能永久删除）、AC-LIFE-02（级联的成员相关部分）、LIFE-MEM-03（断连不删成员）。
 *
 * 不含：组织树结构（T2 #49）、审计写入（T5 #52，只留钩子）、状态看板（T4）、MCP 上下文（T6）。
 */

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t3-life-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 单一公共 seam：`createRepositories(db)`，与 repositories.test.ts 一致。 */
async function withRepos<T>(fn: (ctx: { repos: RepositorySet; db: Database.Database; dir: string }) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const { db } = openDatabase(dir);
    try {
      runMigrations(db, migrations);
      return await fn({ repos: createRepositories(db), db, dir });
    } finally {
      if (db.open) db.close();
    }
  });
}

/** 造一个带岗位、群组参与、消息与运行状态的成员，用于「disable 保留历史与数据」。 */
function seedMember(repos: RepositorySet): {
  projectId: string;
  member: Member;
  nodeId: string;
  groupId: string;
  messageId: string;
} {
  const project = repos.projects.create({ name: "生命周期项目" });
  const agent = repos.agents.create({ displayName: "张三", hostType: "claude-code" });
  const member = repos.members.create({
    projectId: project.id,
    kind: "agent",
    agentId: agent.id,
    displayName: "张三",
  });
  const root = repos.org.createNode({
    projectId: project.id,
    parentId: null,
    name: "统筹",
    role: "top_manager",
  });
  repos.org.assignNode(member.id, root.id);
  const group = repos.groups.create({ projectId: project.id, name: "协作群", participantMemberIds: [member.id] });
  const message = repos.messages.create({ groupId: group.id, senderMemberId: member.id, body: "历史消息" });
  repos.deliveries.ensure(message.id, member.id);
  repos.statuses.set(project.id, member.id, "working");
  return { projectId: project.id, member: repos.members.get(member.id)!, nodeId: root.id, groupId: group.id, messageId: message.id };
}

// ---------------------------------------------------------------------------
// 状态机（repository seam）
// ---------------------------------------------------------------------------

test("LIFE-MEM-01：新建成员默认 active，可显式登记为 pending（枚举 active/disabled/pending）", async () => {
  await withRepos(async ({ repos }) => {
    const project = repos.projects.create({ name: "P" });
    const active = repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" });
    assert.equal(active.status, "active", "老库/新建成员默认 active（阶段 1 行为不回归）");

    const pending = repos.members.create({
      projectId: project.id,
      kind: "human",
      displayName: "乙",
      status: "pending",
    });
    assert.equal(pending.status, "pending");
    assert.equal(repos.members.get(pending.id)?.status, "pending", "状态必须落库可读");
  });
});

test("LIFE-MEM-01/02：disable 不物理删除、保留历史与数据与岗位；re-enable 恢复岗位", async () => {
  await withRepos(async ({ repos }) => {
    const { projectId, member, nodeId, groupId, messageId } = seedMember(repos);

    const disabled = repos.members.setStatus(member.id, "disabled");
    assert.equal(disabled.status, "disabled");

    // 不物理删除：成员行仍在，身份/展示名/角色/岗位锚点原样保留。
    const stillThere = repos.members.get(member.id);
    assert.ok(stillThere, "disable 不得物理删除成员");
    assert.equal(stillThere.status, "disabled");
    assert.equal(stillThere.agentId, member.agentId);
    assert.equal(stillThere.kind, member.kind);
    assert.equal(stillThere.displayName, member.displayName);
    assert.equal(stillThere.role, member.role);
    assert.equal(stillThere.nodeId, nodeId, "disable 保留岗位锚点（node_id）");
    assert.equal(repos.org.nodeOfMember(member.id)?.id, nodeId, "占岗数据仍在");

    // 保留历史与数据：群组参与关系、消息、投递、运行状态都不动。
    assert.ok(repos.groups.participants(groupId).includes(member.id), "禁用的成员仍是群组参与者");
    assert.equal(repos.messages.get(messageId)?.body, "历史消息");
    assert.equal(repos.deliveries.get(messageId, member.id)?.memberId, member.id);
    assert.equal(repos.statuses.get(projectId, member.id)?.state, "working", "运行状态与生命周期状态分开建模");

    // re-enable 恢复岗位：回到 active，岗位/数据不变。
    const enabled = repos.members.setStatus(member.id, "active");
    assert.equal(enabled.status, "active");
    assert.equal(enabled.nodeId, nodeId, "re-enable 恢复岗位（node_id 不变且重新生效）");
    assert.equal(repos.org.nodeOfMember(member.id)?.id, nodeId);
    assert.ok(repos.groups.participants(groupId).includes(member.id));
    assert.equal(repos.messages.get(messageId)?.body, "历史消息");
  });
});

test("状态机：合法转换表、幂等、非法转换被拒（fail-closed），未知状态 400", async () => {
  await withRepos(async ({ repos }) => {
    const project = repos.projects.create({ name: "P" });
    const active = repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" });

    // active -> disabled -> active（暂停 / 恢复闭环）
    assert.equal(repos.members.setStatus(active.id, "disabled").status, "disabled");
    assert.equal(repos.members.setStatus(active.id, "active").status, "active");
    // 同态幂等（ORG-07 无需逐次确认，重复暂停不报错）
    assert.equal(repos.members.setStatus(active.id, "active").status, "active");
    assert.equal(repos.members.setStatus(active.id, "disabled").status, "disabled");
    assert.equal(repos.members.setStatus(active.id, "disabled").status, "disabled");

    // disabled -> pending 非法：必须先 re-enable 回 active（可恢复、不物理删除的约束）。
    assert.throws(
      () => repos.members.setStatus(active.id, "pending"),
      (error: unknown) => error instanceof ConflictError && error.code === "conflict",
    );
    assert.equal(repos.members.get(active.id)?.status, "disabled", "非法转换不得改动现状");

    // pending -> active（激活）、pending -> disabled（暂停未激活成员）合法；active -> pending 非法。
    const waiting = repos.members.create({
      projectId: project.id,
      kind: "human",
      displayName: "乙",
      status: "pending",
    });
    assert.equal(repos.members.setStatus(waiting.id, "active").status, "active");
    assert.throws(() => repos.members.setStatus(waiting.id, "pending"), (e: unknown) => e instanceof ConflictError);

    const waiting2 = repos.members.create({
      projectId: project.id,
      kind: "human",
      displayName: "丙",
      status: "pending",
    });
    assert.equal(repos.members.setStatus(waiting2.id, "disabled").status, "disabled");

    // 未知状态与不存在的成员：明确错误，不静默。
    assert.throws(
      () => repos.members.setStatus(active.id, "bogus" as never),
      (e: unknown) => e instanceof InvalidArgumentError && e.code === "invalid_argument",
    );
    assert.throws(
      () => repos.members.create({ projectId: project.id, kind: "human", displayName: "丁", status: "bogus" as never }),
      (e: unknown) => e instanceof InvalidArgumentError,
    );
    assert.throws(() => repos.members.setStatus("no-such-member", "active"), (e: unknown) => e instanceof NotFoundError);
  });
});

test("状态机遵守 T1 归档写规则：归档项目内改成员状态被 ArchivedError 拒绝，恢复后放行", async () => {
  await withRepos(async ({ repos }) => {
    const project = repos.projects.create({ name: "P" });
    const member = repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" });
    repos.projects.archive(project.id);
    assert.throws(
      () => repos.members.setStatus(member.id, "disabled"),
      (e: unknown) => e instanceof ArchivedError && e.code === "archived",
    );
    repos.projects.restore(project.id);
    assert.equal(repos.members.setStatus(member.id, "disabled").status, "disabled");
  });
});

test("状态持久化：重启后（重开库）disabled 状态保留，不因进程边界回到 active", async () => {
  await withTempDir(async (dir) => {
    const first = openDatabase(dir);
    let memberId = "";
    try {
      runMigrations(first.db, migrations);
      const repos = createRepositories(first.db);
      const project = repos.projects.create({ name: "P" });
      const member = repos.members.create({ projectId: project.id, kind: "human", displayName: "甲" });
      memberId = member.id;
      repos.members.setStatus(memberId, "disabled");
    } finally {
      first.db.close();
    }

    const second = openDatabase(dir);
    try {
      runMigrations(second.db, migrations);
      const repos = createRepositories(second.db);
      assert.equal(repos.members.get(memberId)?.status, "disabled", "状态是持久化字段，不依赖进程内存");
      assert.equal(repos.members.setStatus(memberId, "active").status, "active", "重启后仍可恢复");
    } finally {
      second.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP seam：`/api` + F2 `resolveHttpActor` 注入点
// ---------------------------------------------------------------------------

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withServer<T>(
  serverOptions: Omit<Parameters<typeof startServer>[0], "config">,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t3-life-http-"));
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

async function createProject(server: RunningServer, name: string): Promise<any> {
  const created = await call(server, "POST", "/api/projects", { name });
  assert.equal(created.status, 201, `创建项目应成功：${JSON.stringify(created.body)}`);
  return created.body.project;
}

async function addHuman(server: RunningServer, projectId: string, displayName: string): Promise<any> {
  const added = await call(server, "POST", `/api/projects/${projectId}/members`, { kind: "human", displayName });
  assert.equal(added.status, 201, `添加成员应成功：${JSON.stringify(added.body)}`);
  return added.body.member;
}

async function createGroup(server: RunningServer, projectId: string, name: string, participants: string[]): Promise<any> {
  const created = await call(server, "POST", `/api/projects/${projectId}/groups`, {
    name,
    participantMemberIds: participants,
  });
  assert.equal(created.status, 201, `创建群组应成功：${JSON.stringify(created.body)}`);
  return created.body.group;
}

/** 守卫主体：按请求头切换，模拟「人 / 顶层 manager / 普通成员」三种调用者。 */
function actorFor(projectId: string, role: "top_manager" | "member", kind: "human" | "agent" = "agent"): Actor {
  return {
    actorId: `actor-${role}`,
    kind,
    role,
    projectId,
    nodeId: null,
    subtreeNodeIds: null,
  };
}

/** 轮询等待异步断开清理完成，避免 DELETE 与 onclose 的时序抖动。 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolPayload> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((part) => part.type === "text")?.text;
  assert.ok(text, `工具 ${name} 应返回 text`);
  return JSON.parse(text) as ToolPayload;
}

// ---------------------------------------------------------------------------

test("生命周期端点：disable/enable/lifecycle 经 /api 暴露状态机、memberView 带 status（幂等与错误码）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "状态机项目");
    const alice = await addHuman(server, project.id, "Alice");
    assert.equal(alice.status, "active", "新建成员默认 active");

    // disable：200 + disabled；成员仍在花名册（不物理删除），岗位保留。
    const disabled = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/disable`);
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.member.status, "disabled");
    assert.equal(disabled.body.member.nodeId, alice.nodeId);

    const listed = await call(server, "GET", `/api/projects/${project.id}/members`);
    const view = (listed.body.members as any[]).find((m) => m.id === alice.id);
    assert.ok(view, "disable 不物理删除成员");
    assert.equal(view.status, "disabled");
    assert.equal(view.nodeId, alice.nodeId, "disable 保留岗位");

    // 幂等：重复暂停不报错（ORG-07 无需逐次确认）。
    const again = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/disable`);
    assert.equal(again.status, 200);
    assert.equal(again.body.member.status, "disabled");

    // enable：恢复岗位（active + nodeId 不变）。
    const enabled = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/enable`);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.member.status, "active");
    assert.equal(enabled.body.member.nodeId, alice.nodeId);

    // 通用 lifecycle PUT：非法转换（disabled -> pending）→ 409 conflict；合法 PUT active = re-enable。
    await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/disable`);
    const illegal = await call(server, "PUT", `/api/projects/${project.id}/members/${alice.id}/lifecycle`, {
      status: "pending",
    });
    assert.equal(illegal.status, 409, JSON.stringify(illegal.body));
    assert.equal(illegal.body.error.code, "conflict");
    const back = await call(server, "PUT", `/api/projects/${project.id}/members/${alice.id}/lifecycle`, {
      status: "active",
    });
    assert.equal(back.status, 200);
    assert.equal(back.body.member.status, "active");

    // 未知状态 → 400 invalid_argument；不存在的成员 → 404。
    const bad = await call(server, "PUT", `/api/projects/${project.id}/members/${alice.id}/lifecycle`, {
      status: "bogus",
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, "invalid_argument");
    const missing = await call(server, "POST", `/api/projects/${project.id}/members/no-such-member/disable`);
    assert.equal(missing.status, 404);
  });
});

test("LIFE-MEM-01：pending 成员可经 HTTP 登记、花名册可见、enable 激活为 active", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "待激活项目");
    const created = await call(server, "POST", `/api/projects/${project.id}/members`, {
      kind: "human",
      displayName: "待激活成员",
      status: "pending",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.member.status, "pending");

    const listed = await call(server, "GET", `/api/projects/${project.id}/members`);
    const view = (listed.body.members as any[]).find((m) => m.id === created.body.member.id);
    assert.equal(view.status, "pending");

    const enabled = await call(server, "POST", `/api/projects/${project.id}/members/${created.body.member.id}/enable`);
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.member.status, "active");
  });
});

test("守卫：顶层 manager 可暂停成员（ORG-07 无需确认）、可归档但不可永久删除（AC-LIFE-01）；普通成员被拒", async () => {
  await withServer(
    {
      logger: silentLogger,
      authorization: {
        resolveHttpActor: ({ request, projectId }) => {
          const as = request.headers["x-as"];
          if (as === "manager") return actorFor(projectId ?? "", "top_manager");
          if (as === "member") return actorFor(projectId ?? "", "member");
          return ownerActor(projectId);
        },
      },
    },
    async (server) => {
      const project = await createProject(server, "守卫项目");
      const alice = await addHuman(server, project.id, "Alice");
      const group = await createGroup(server, project.id, "群", [alice.id]);
      const asManager = { "x-as": "manager" };
      const asMember = { "x-as": "member" };

      // 顶层 manager：暂停/恢复成员无需逐次确认（直接 200，不是永久删除的二次确认流程）。
      const paused = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/disable`, undefined, asManager);
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      assert.equal(paused.body.member.status, "disabled");
      const resumed = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/enable`, undefined, asManager);
      assert.equal(resumed.status, 200);

      // 顶层 manager 可归档（project:archive / group:archive）。
      const archived = await call(server, "POST", `/api/projects/${project.id}/archive`, undefined, asManager);
      assert.equal(archived.status, 200, JSON.stringify(archived.body));
      await call(server, "POST", `/api/projects/${project.id}/restore`);

      // 顶层 manager 不能永久删除项目/群组（project:purge / group:purge 仅人持有）。
      const purgeProject = await call(server, "DELETE", `/api/projects/${project.id}`, undefined, asManager);
      assert.equal(purgeProject.status, 403, JSON.stringify(purgeProject.body));
      assert.equal(purgeProject.body.error.code, "forbidden");
      assert.match(purgeProject.body.error.message, /project:purge/);
      const purgeGroup = await call(server, "DELETE", `/api/groups/${group.id}`, undefined, asManager);
      assert.equal(purgeGroup.status, 403);
      assert.match(purgeGroup.body.error.message, /group:purge/);
      assert.equal((await call(server, "GET", `/api/projects/${project.id}`)).status, 200, "拒绝发生在写入之前");

      // 普通成员不能管理成员（member:manage 不在能力集，守卫 fail-closed）。
      const denied = await call(server, "POST", `/api/projects/${project.id}/members/${alice.id}/disable`, undefined, asMember);
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.error.code, "forbidden");
      assert.match(denied.body.error.message, /member:manage/);

      // 人（owner）：可发起永久删除，但仍要二次确认（409 而非直接删）。
      const ownerPurge = await call(server, "DELETE", `/api/projects/${project.id}`);
      assert.equal(ownerPurge.status, 409);
      assert.equal(ownerPurge.body.error.code, "confirmation_required");
    },
  );
});

test("AC-LIFE-02：删群组只清群聊与参与者、保留成员及其生命周期状态；删项目清除成员（复用 T1 二次确认与级联）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "级联项目");
    const alice = await addHuman(server, project.id, "Alice");
    const bob = await addHuman(server, project.id, "Bob");
    await call(server, "POST", `/api/projects/${project.id}/members/${bob.id}/disable`);
    const groupA = await createGroup(server, project.id, "群A", [alice.id, bob.id]);
    const groupB = await createGroup(server, project.id, "群B", [alice.id]);
    await call(server, "POST", `/api/groups/${groupA.id}/messages`, {
      senderMemberId: alice.id,
      text: "会被清掉的历史",
    });

    // 删群组：二次确认；级联清单只含参与者，不含成员。
    const g1 = await call(server, "DELETE", `/api/groups/${groupA.id}`);
    assert.equal(g1.status, 409);
    assert.equal(g1.body.error.code, "confirmation_required");
    assert.equal(g1.body.confirmation.cascade.participants, 2);
    const g2 = await call(server, "DELETE", `/api/groups/${groupA.id}`, { confirm: g1.body.confirmation.token });
    assert.equal(g2.status, 204, JSON.stringify(g2.body));

    const afterGroup = await call(server, "GET", `/api/projects/${project.id}/members`);
    assert.deepEqual(
      (afterGroup.body.members as any[]).map((m) => m.id).sort(),
      [alice.id, bob.id].sort(),
      "删群组不动项目成员",
    );
    const bobView = (afterGroup.body.members as any[]).find((m) => m.id === bob.id);
    assert.equal(bobView.status, "disabled", "删群组不动成员的生命周期状态");
    assert.equal((await call(server, "GET", `/api/groups/${groupB.id}`)).status, 200, "其它群组保留");

    // 删项目：二次确认；级联清单含成员；执行后项目与成员都清除。
    const p1 = await call(server, "DELETE", `/api/projects/${project.id}`);
    assert.equal(p1.status, 409);
    assert.equal(p1.body.confirmation.cascade.members, 2);
    const p2 = await call(server, "DELETE", `/api/projects/${project.id}`, { confirm: p1.body.confirmation.token });
    assert.equal(p2.status, 204, JSON.stringify(p2.body));
    assert.equal((await call(server, "GET", `/api/projects/${project.id}/members`)).status, 404);
  });
});

test("LIFE-MEM-03：断连不删除成员、在线/离线由连接与心跳表达（真实 MCP 入群→断开）", async () => {
  await withServer({ logger: silentLogger }, async (server) => {
    const project = await createProject(server, "连接项目");
    const group = await createGroup(server, project.id, "群", []);

    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      reconnectionOptions: {
        initialReconnectionDelay: 50,
        maxReconnectionDelay: 200,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 0,
      },
    });
    const client = new Client({ name: "t3-life", version: "0.0.0" });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);

    let memberId = "";
    try {
      const join = await callTool(client, "join", {
        displayName: "AgentX",
        hostType: "claude-code",
        projectId: project.id,
        groupId: group.id,
      });
      assert.equal(join.ok, true, JSON.stringify(join));
      memberId = String(join.memberId);

      // 入群后：成员存在且 active；连接层 connected / 运行状态 online。
      const members0 = await call(server, "GET", `/api/projects/${project.id}/members`);
      assert.equal((members0.body.members as any[]).find((m) => m.id === memberId).status, "active");
      const st0 = await call(server, "GET", `/api/projects/${project.id}/members/${memberId}/status`);
      assert.equal(st0.body.memberStatus.connection, "connected");
    } finally {
      // 顺序要紧：terminateSession() 发 DELETE 触发服务端 onclose→core.disconnect()；
      // client.close() 会 abort controller，必须先发 DELETE 再关客户端。
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }

    // 断开清理（DELETE → onclose → core.disconnect）完成后：连接层 disconnected / 运行状态 offline。
    const offline = await waitFor(async () => {
      const st = await call(server, "GET", `/api/projects/${project.id}/members/${memberId}/status`);
      return st.body?.memberStatus?.connection === "disconnected";
    });
    assert.equal(offline, true, "断开后连接状态应为 disconnected");

    // 断连不删除成员：成员仍在花名册，且生命周期状态不被改写成 disabled/pending。
    const members = await call(server, "GET", `/api/projects/${project.id}/members`);
    const view = (members.body.members as any[]).find((m) => m.id === memberId);
    assert.ok(view, "断连不得删除成员（可恢复、不物理删除）");
    assert.equal(view.status, "active", "在线/离线由连接/心跳表达，不复用成员生命周期状态");
    const st = await call(server, "GET", `/api/projects/${project.id}/members/${memberId}/status`);
    assert.equal(st.body.memberStatus.state, "offline");
  });
});

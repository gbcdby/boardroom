import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type Database from "better-sqlite3";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import {
  authorize,
  visibleGroups,
  type Actor,
  type Capability,
  type GuardScope,
  type GuardedGroup,
} from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createOrgActorResolver, orgActorForMember } from "../src/server/authz/org-actors.ts";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { OrgChangeRecorder } from "../src/server/org-change-hook.ts";

/**
 * T2（#49）票面测试 seam：**org_nodes 递归查询 + 角色/可见性 + 守卫单测**。
 *
 * 覆盖 AC-PERM-01（人/顶层 manager/下级 manager/普通 agent 权限矩阵）、
 * AC-ORG-05（越级被拒、权限随子树边界）、AC-ORG-07 / #32（`group:view_subtree`
 * 子树只读可见性：可看元数据与历史、不唤醒、不能发消息）、ORG-06（_own + 归属校验）、
 * 以及阶段 1 兼容硬约束（升级库默认无组织数据 → resolveActor 兼容映射继续工作）。
 *
 * 期望值来自独立来源：决策票 #24/#25/#26/#32 与 docs/f2-authorize-guard.md §2/§3，
 * 不按被测代码算法重算。
 */

async function withRepos<T>(fn: (repos: RepositorySet) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-orgauthz-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  try {
    runMigrations(db, migrations);
    return await fn(createRepositories(driver));
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function resolution(projectId: string, memberId?: string) {
  return {
    request: {} as IncomingMessage,
    projectId,
    ...(memberId === undefined ? {} : { memberId }),
  };
}

function denyCode(actor: Actor, capability: Capability, scope: GuardScope): string | null {
  const decision = authorize(actor, capability, scope);
  return decision.allowed ? null : decision.code;
}

/** 从真实 DB 组装「某群组」的可见性事实（参与者 + 各自岗位节点）。 */
async function guarded(repos: RepositorySet, groupId: string): Promise<GuardedGroup> {
  const memberIds = (await ((await (repos.groups.participants(groupId)))));
  return {
    id: groupId,
    projectId: (await ((await (repos.groups.get(groupId)))))!.projectId,
    memberIds,
    memberNodeIds: (await Promise.all(memberIds.map(async (id) => (await (repos.members.get(id)))?.nodeId ?? null))),
  };
}

async function groupScope(repos: RepositorySet, groupId: string): Promise<GuardScope> {
  const g = (await ((await (guarded(repos, groupId)))));
  return {
    projectId: g.projectId,
    groupId: g.id,
    groupMemberIds: g.memberIds,
    ...(g.memberNodeIds === undefined ? {} : { groupMemberNodeIds: g.memberNodeIds }),
  };
}

/** 建一棵测试树并占岗，返回节点与成员 id。 */
async function buildTree(repos: RepositorySet) {
  const p = (await ((await (repos.projects.create({ name: "P" })))));
  const root = (await ((await (repos.org.createNode({ projectId: p.id, parentId: null, name: "统筹", role: "top_manager" })))));
  const a = (await ((await (repos.org.createNode({ projectId: p.id, parentId: root.id, name: "A 线", role: "sub_manager" })))));
  const b = (await ((await (repos.org.createNode({ projectId: p.id, parentId: a.id, name: "B 岗", role: "member" })))));
  const c = (await ((await (repos.org.createNode({ projectId: p.id, parentId: a.id, name: "C 岗", role: "member" })))));
  const x = (await ((await (repos.org.createNode({ projectId: p.id, parentId: root.id, name: "X 岗", role: "member" })))));

  const mk = async (name: string): Promise<string> => {
    const agent = (await ((await (repos.agents.create({ displayName: name, hostType: "claude-code" })))));
    return (await ((await (repos.members.create({ projectId: p.id, kind: "agent", agentId: agent.id, displayName: name }))))).id;
  };
  const mTop = (await ((await (mk("顶层")))));
  const mSub = (await ((await (mk("下级")))));
  const mB = (await ((await (mk("B")))));
  const mC = (await ((await (mk("C")))));
  const mX = (await ((await (mk("X")))));
  (await ((await (repos.org.assignNode(mTop, root.id)))));
  (await ((await (repos.org.assignNode(mSub, a.id)))));
  (await ((await (repos.org.assignNode(mB, b.id)))));
  (await ((await (repos.org.assignNode(mC, c.id)))));
  (await ((await (repos.org.assignNode(mX, x.id)))));
  return { p, root, a, b, c, x, mTop, mSub, mB, mC, mX };
}

// ---------------------------------------------------------------------------
// 一、真实 DB → Actor 装配（阶段 1 兼容硬约束）
// ---------------------------------------------------------------------------

test("阶段 1 兼容：升级库无组织数据时 resolveActor 沿用 F2 兼容映射，行为不变", async () => {
  await withRepos(async (repos) => {
    const p = (await ((await (repos.projects.create({ name: "P" })))));
    const mgrAgent = (await ((await (repos.agents.create({ displayName: "经理", hostType: "claude-code" })))));
    const mgr = (await ((await (repos.members.create({
      projectId: p.id,
      kind: "agent",
      agentId: mgrAgent.id,
      displayName: "经理",
      role: "manager",
    })))));
    const plainAgent = (await ((await (repos.agents.create({ displayName: "成员", hostType: "codex-cli" })))));
    const plain = (await ((await (repos.members.create({
      projectId: p.id,
      kind: "agent",
      agentId: plainAgent.id,
      displayName: "成员",
    })))));
    const resolver = createOrgActorResolver(repos);

    // 未认证的人 = owner（全局主体可跨项目）。
    assert.equal((await (resolver.resolveHttpActor(resolution(p.id))))?.role, "owner");
    assert.equal((await (resolver.resolveWsActor({ projectId: p.id, memberId: null })))?.role, "owner");
    // legacy manager → top_manager；normal → member；nodeId/subtreeNodeIds 仍为 null。
    const mgrActor = (await (resolver.resolveHttpActor(resolution(p.id, mgr.id))))!;
    assert.equal(mgrActor.role, "top_manager");
    assert.equal(mgrActor.nodeId, null);
    assert.equal(mgrActor.subtreeNodeIds, null);
    assert.equal((await (resolver.resolveHttpActor(resolution(p.id, plain.id))))?.role, "member");
    // MCP 会话绑定同样回退到阶段 1 兼容映射（manager → top_manager）。
    const binding = {
      sessionId: "s",
      agentId: mgrAgent.id,
      memberId: mgr.id,
      membershipRevision: mgr.membershipRevision,
      projectId: p.id,
      groupId: "g",
      role: "manager" as const,
      displayName: "经理",
      hostType: "claude-code" as const,
      mcpSessionId: "ms",
    };
    assert.equal((await (resolver.actorForMcpBinding(binding))).role, "top_manager");
    assert.equal((await (resolver.actorForMcpBinding({ ...binding, role: "normal" }))).role, "member");
  });
});

test("占岗成员由真实 org_nodes 装配 Actor：role / nodeId / 递归 CTE 子树", async () => {
  await withRepos(async (repos) => {
    const { p, a, b, c, mSub, mTop, mX } = (await ((await (buildTree(repos)))));
    const resolver = createOrgActorResolver(repos);

    const sub = (await (orgActorForMember(repos, mSub)))!;
    assert.equal(sub.role, "sub_manager");
    assert.equal(sub.nodeId, a.id);
    assert.deepEqual([...(sub.subtreeNodeIds ?? [])].sort(), [a.id, b.id, c.id].sort());

    const top = (await (orgActorForMember(repos, mTop)))!;
    assert.equal(top.role, "top_manager");
    assert.equal(top.nodeId, (await ((await (repos.org.getRootNode(p.id)))))!.id);
    // 顶层 manager 的管辖范围是 project（ROLE_REACH），子树数据仍可给出但不改变全项目范围。
    assert.equal(top.subtreeNodeIds?.length, 5);

    // 普通成员占 member 岗 → reach=own。
    assert.equal((await (orgActorForMember(repos, mX)))!.role, "member");
    // HTTP / MCP 两个装配点拿到同一真实主体。
    assert.equal((await (resolver.resolveHttpActor(resolution(p.id, mSub))))?.role, "sub_manager");
    assert.equal((await (resolver.resolveWsActor({ projectId: p.id, memberId: mSub })))?.role, "sub_manager");
    const binding = {
      sessionId: "s",
      agentId: (await ((await (repos.members.get(mSub)))))!.agentId!,
      memberId: mSub,
      membershipRevision: (await repos.members.get(mSub))!.membershipRevision,
      projectId: p.id,
      groupId: "g",
      role: "normal" as const,
      displayName: "下级",
      hostType: "claude-code" as const,
      mcpSessionId: "ms",
    };
    assert.equal((await (resolver.actorForMcpBinding(binding))).role, "sub_manager");
  });
});

test("人（owner）即使占岗也保持内建全局主体，不降级为岗位角色", async () => {
  await withRepos(async (repos) => {
    const p = (await ((await (repos.projects.create({ name: "P" })))));
    const root = (await ((await (repos.org.createNode({ projectId: p.id, parentId: null, name: "统筹", role: "top_manager" })))));
    const human = (await ((await (repos.members.create({ projectId: p.id, kind: "human", displayName: "人" })))));
    (await ((await (repos.org.assignNode(human.id, root.id)))));
    assert.equal((await (orgActorForMember(repos, human.id))), null);
    assert.equal((await (createOrgActorResolver(repos).resolveHttpActor(resolution(p.id, human.id))))?.role, "owner");
  });
});

// ---------------------------------------------------------------------------
// 二、AC-PERM-01 权限矩阵（守卫单测，主体来自真实组织数据）
// ---------------------------------------------------------------------------

test("AC-PERM-01：人 / 顶层 manager / 下级 manager / 普通 agent 的权限矩阵", async () => {
  await withRepos(async (repos) => {
    const { p, root, a, b, x, mTop, mSub, mX } = (await ((await (buildTree(repos)))));
    const owner = ownerActor(p.id);
    const top = (await (orgActorForMember(repos, mTop)))!;
    const sub = (await (orgActorForMember(repos, mSub)))!;
    const member = (await (orgActorForMember(repos, mX)))!;

    // 人（owner）：全量能力点，含永久删除 / 撤销类特权。
    assert.equal(denyCode(owner, "org:manage", { projectId: p.id, nodeId: x.id }), null);
    assert.equal(denyCode(owner, "project:purge", { projectId: p.id }), null);
    assert.equal(denyCode(owner, "group:view", { projectId: p.id, groupId: "any" }), null);

    // 顶层 manager：全项目组织/成员管理，但不能永久删除（LIFE-ARC-01）。
    assert.equal(denyCode(top, "org:manage", { projectId: p.id, nodeId: x.id }), null);
    assert.equal(denyCode(top, "project:purge", { projectId: p.id }), "forbidden");
    assert.equal(denyCode(top, "group:purge", { projectId: p.id, groupId: "any" }), "forbidden");

    // 下级 manager：子树内放行，越级被拒（ORG-05 / 权限随子树边界）。
    assert.equal(denyCode(sub, "org:manage", { projectId: p.id, nodeId: b.id }), null);
    assert.equal(denyCode(sub, "org:manage", { projectId: p.id, nodeId: a.id }), null);
    assert.equal(denyCode(sub, "org:manage", { projectId: p.id, nodeId: x.id }), "out_of_subtree");
    assert.equal(denyCode(sub, "org:manage", { projectId: p.id, nodeId: root.id }), "out_of_subtree");
    assert.equal(denyCode(sub, "member:manage", { projectId: p.id, nodeId: x.id }), "out_of_subtree");
    // 跨项目目标一律拒绝（NFR-PROJ-01）。
    assert.equal(denyCode(sub, "org:manage", { projectId: "other", nodeId: b.id }), "cross_project");

    // 普通 agent：不能管组织；_own 能力点 + 目标归属校验（ORG-06）。
    assert.equal(denyCode(member, "org:manage", { projectId: p.id, nodeId: b.id }), "forbidden");
    assert.equal(denyCode(member, "member:manage", { projectId: p.id }), "forbidden");
    assert.equal(denyCode(member, "task:update_own", { projectId: p.id, memberId: member.actorId }), null);
    assert.equal(denyCode(member, "memory:write_own", { projectId: p.id, memberId: "someone-else" }), "not_self");
    assert.equal(denyCode(member, "task:reassign" as Capability, { projectId: p.id }), "unknown_action");
  });
});

// ---------------------------------------------------------------------------
// 三、group:view_subtree：子树内只读可见性（AC-ORG-07 / #32）
// ---------------------------------------------------------------------------

test("group:view_subtree：下级 manager 对子树内全员属该子树的群组只读可见", async () => {
  await withRepos(async (repos) => {
    const { p, a, b, c, x, mSub, mB, mC, mX, mTop } = (await ((await (buildTree(repos)))));
    // g1：参与者全部在 sub_manager 子树内（b、c）；g2：含一个子树外成员（x）；
    // g3：sub_manager 自己是参与者 → 可写。
    const g1 = (await ((await (repos.groups.create({ projectId: p.id, name: "子树内群", participantMemberIds: [mB, mC] })))));
    const g2 = (await ((await (repos.groups.create({ projectId: p.id, name: "跨子树群", participantMemberIds: [mB, mX] })))));
    const g3 = (await ((await (repos.groups.create({ projectId: p.id, name: "自己参与的群", participantMemberIds: [mSub, mB] })))));

    const sub = (await (orgActorForMember(repos, mSub)))!;
    const visible = visibleGroups(sub, [(await ((await (guarded(repos, g1.id))))), (await ((await (guarded(repos, g2.id))))), (await ((await (guarded(repos, g3.id)))))]);
    const byId = new Map(visible.map((v) => [v.id, v.writable]));
    // 只读可见（看元数据与历史，不唤醒、不能发消息）→ writable=false。
    assert.equal(byId.get(g1.id), false, "子树内未参与群组应只读可见");
    assert.equal(byId.has(g2.id), false, "含子树外参与者的群组不可见，且不泄漏存在");
    assert.equal(byId.get(g3.id), true, "自己参与的群组可写");

    // 能力点判定：group:view / group:view_subtree 放行只读；group:post 仍要求参与资格。
    assert.equal(denyCode(sub, "group:view", (await ((await (groupScope(repos, g1.id)))))), null);
    assert.equal(denyCode(sub, "group:view_subtree", (await ((await (groupScope(repos, g1.id)))))), null);
    assert.equal(denyCode(sub, "group:post", (await ((await (groupScope(repos, g1.id)))))), "not_a_member");
    assert.equal(denyCode(sub, "group:view_subtree", (await ((await (groupScope(repos, g2.id)))))), "not_visible");
    assert.equal(denyCode(sub, "group:view", (await ((await (groupScope(repos, g2.id)))))), "not_visible");

    // 顶层 manager 与人可见全部群组（AC-ORG-07）；不因未参与而消失。
    const top = (await (orgActorForMember(repos, mTop)))!;
    assert.equal(visibleGroups(top, [(await ((await (guarded(repos, g2.id)))))]).length, 1);
    assert.equal(visibleGroups(ownerActor(p.id), [(await ((await (guarded(repos, g1.id))))), (await ((await (guarded(repos, g2.id)))))]).length, 2);
    // 普通成员只看自己参与的群组。
    const plain = (await (orgActorForMember(repos, mX)))!;
    assert.equal(visibleGroups(plain, [(await ((await (guarded(repos, g1.id)))))]).length, 0);

    // 子树边界来自递归 CTE：把 b 移到根节点下后，g1 不再「全员属子树」。
    (await ((await (repos.org.updateNode(b.id, { parentId: (await ((await (repos.org.getRootNode(p.id)))))!.id })))));
    const movedSub = (await (orgActorForMember(repos, mSub)))!;
    assert.equal(denyCode(movedSub, "group:view_subtree", (await ((await (groupScope(repos, g1.id)))))), "not_visible");
    assert.equal(denyCode(movedSub, "group:create", {
      projectId: p.id,
      groupMemberIds: [mB, mC],
      groupMemberNodeIds: [(await ((await (repos.members.get(mB)))))!.nodeId, (await ((await (repos.members.get(mC)))))!.nodeId],
    }), "out_of_subtree");
    // 记录 x/a 仅用于让树形清晰（避免未使用变量告警语义不清）。
    assert.ok(x.id && a.id && c.id);
  });
});

// ---------------------------------------------------------------------------
// 四、HTTP 调用点：越级被拒 + 只读可见性 + T5 审计钩子
// ---------------------------------------------------------------------------

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withServer<T>(
  options: Omit<Parameters<typeof startServer>[0], "config">,
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-org-http-"));
  const server = await startServer({
    ...options,
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.url}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

test("HTTP：组织端点按真实主体执行子树边界（ORG-05 越级 403）、只读可见性与审计钩子", async () => {
  let reposForTest: RepositorySet | null = null;
  const recorded: { action: string; nodeId: string | null }[] = [];
  const recorder: OrgChangeRecorder = {
    record(change) {
      recorded.push({ action: change.action, nodeId: change.nodeId });
    },
  };

  await withServer(
    {
      logger: silentLogger,
      orgChangeRecorder: recorder,
      // 用请求头选择「以某成员为主体」，主体由真实 DB 装配（nodeId/subtreeNodeIds）。
      authorization: {
        resolveHttpActor: async (r) => {
          const as = r.request.headers["x-member"];
          if (typeof as === "string" && reposForTest) {
            const orgActor = (await (orgActorForMember(reposForTest, as)));
            if (orgActor) return orgActor;
          }
          return ownerActor(r.projectId);
        },
      },
    },
    async (server) => {
      reposForTest = createRepositories(server.database);
      const repos = reposForTest;
      const project = (await call(server, "POST", "/api/projects", { name: "组织项目" })).body.project;
      const pid: string = project.id;

      const mkMember = async (name: string): Promise<string> => {
        const agent = (await ((await (repos.agents.create({ displayName: name, hostType: "claude-code" })))));
        const created = await call(server, "POST", `/api/projects/${pid}/members`, {
          kind: "agent",
          agentId: agent.id,
          displayName: name,
        });
        assert.equal(created.status, 201);
        return created.body.member.id as string;
      };
      const subMember = await mkMember("下级经理");
      const bMember = await mkMember("B 成员");
      const xMember = await mkMember("X 成员");

      // 人建组织树：根 → A 线（sub_manager）/ X 岗（member）；A 线 → B 岗（member）。
      const root = (
        await call(server, "POST", `/api/projects/${pid}/org/nodes`, { name: "统筹", role: "top_manager" })
      ).body.node;
      assert.equal(root.role, "top_manager");
      const a = (await call(server, "POST", `/api/projects/${pid}/org/nodes`, {
        parentId: root.id,
        name: "A 线",
        role: "sub_manager",
      })).body.node;
      const b = (await call(server, "POST", `/api/projects/${pid}/org/nodes`, {
        parentId: a.id,
        name: "B 岗",
        role: "member",
      })).body.node;
      const x = (await call(server, "POST", `/api/projects/${pid}/org/nodes`, {
        parentId: root.id,
        name: "X 岗",
        role: "member",
      })).body.node;

      // 占岗（人操作）。
      await call(server, "PUT", `/api/org/nodes/${a.id}/assignee`, { memberId: subMember });
      await call(server, "PUT", `/api/org/nodes/${b.id}/assignee`, { memberId: bMember });
      await call(server, "PUT", `/api/org/nodes/${x.id}/assignee`, { memberId: xMember });

      const asSub = { "x-member": subMember };
      const asMember = { "x-member": xMember };

      // 子树内改名放行；越级改 X 岗 → 403 out_of_subtree（AC-PERM-01 / ORG-05）。
      const ok = await call(server, "PUT", `/api/org/nodes/${b.id}`, { name: "B 岗（改）" }, asSub);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      const over = await call(server, "PUT", `/api/org/nodes/${x.id}`, { name: "越级改名" }, asSub);
      assert.equal(over.status, 403);
      assert.equal(over.body.error.code, "out_of_subtree");
      // 越级在别人的子树下建岗同样被拒。
      const overCreate = await call(
        server,
        "POST",
        `/api/projects/${pid}/org/nodes`,
        { parentId: x.id, name: "越级建岗", role: "member" },
        asSub,
      );
      assert.equal(overCreate.status, 403);
      assert.equal(overCreate.body.error.code, "out_of_subtree");
      // 普通成员没有 org:manage 能力点 → 403 forbidden。
      const asPlain = await call(server, "PUT", `/api/org/nodes/${b.id}`, { name: "普通成员改名" }, asMember);
      assert.equal(asPlain.status, 403);
      assert.equal(asPlain.body.error.code, "forbidden");
      // 人（默认主体）可调整任意岗位：ORG-02/04/08「人可调整」。
      const asOwner = await call(server, "PUT", `/api/org/nodes/${x.id}`, { name: "人调整 X 岗" });
      assert.equal(asOwner.status, 200);

      // 子树只读可见性：g1 参与者全在子树内、g2 含子树外成员。
      const g1 = (await call(server, "POST", `/api/projects/${pid}/groups`, {
        name: "子树内群",
        participantMemberIds: [bMember],
      })).body.group;
      const g2 = (await call(server, "POST", `/api/projects/${pid}/groups`, {
        name: "跨子树群",
        participantMemberIds: [bMember, xMember],
      })).body.group;
      const list = await call(server, "GET", `/api/projects/${pid}/groups`, undefined, asSub);
      const byId = new Map((list.body.groups as any[]).map((g) => [g.id, g.writable]));
      assert.equal(byId.get(g1.id), false, "子树内未参与群组应只读可见（writable=false）");
      assert.equal(byId.has(g2.id), false, "含子树外参与者的群组不出现");
      // 只读可见的群组可读历史（200），但不能发消息（非参与者 → 400 invalid_reference）。
      const history = await call(server, "GET", `/api/groups/${g1.id}/messages`, undefined, asSub);
      assert.equal(history.status, 200);
      const post = await call(
        server,
        "POST",
        `/api/groups/${g1.id}/messages`,
        { senderMemberId: subMember, text: "越权发言" },
        asSub,
      );
      assert.equal(post.status, 400);
      assert.equal(post.body.error.code, "invalid_reference");

      // 人可见全部群组。
      const ownerList = await call(server, "GET", `/api/projects/${pid}/groups`);
      assert.equal((ownerList.body.groups as any[]).length, 2);

      // 自动分配：给未落位成员在根下建 member 岗（ORG-02/08）。
      const idle = await mkMember("新人");
      const placed = await call(server, "POST", `/api/projects/${pid}/org/auto-place`, { memberId: idle });
      assert.equal(placed.status, 200);
      assert.equal(placed.body.node.role, "member");
      assert.equal(placed.body.node.parentId, root.id);

      // T5 审计钩子：本票只记录到注入的 recorder，不写 audit_log。
      assert.ok(recorded.some((c) => c.action === "node.create"));
      assert.ok(recorded.some((c) => c.action === "node.update"));
      assert.ok(recorded.some((c) => c.action === "node.assign"));
      assert.ok(recorded.some((c) => c.action === "member.auto_place"));
      // 组织树响应含角色能力点目录（角色配置入口数据）。
      const snapshot = await call(server, "GET", `/api/projects/${pid}/org`);
      const subRole = (snapshot.body.roles as any[]).find((r) => r.role === "sub_manager");
      assert.ok(subRole.capabilities.includes("group:view_subtree"));
      assert.equal((snapshot.body.roles as any[]).find((r) => r.role === "owner").nodeRole, false);
    },
  );
});

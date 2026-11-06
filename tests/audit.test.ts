import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { Actor } from "../src/server/authz/authorize.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import type Database from "better-sqlite3";
import {
  AUDIT_ACTIONS,
  appendAuditEntry,
  auditView,
  createAuditRecorder,
  createAuditRepository,
  revokeUnavailableReason,
} from "../src/server/audit.ts";
import type { OrgChange } from "../src/server/org-change-hook.ts";

/**
 * T5（#52）最小审计。
 *
 * seam：
 * - 仓储段走 `createRepositories(driver).audit`（与 `audit.ts` 同一边界），验证单表读写、
 *   截断、钩子映射、撤销不可用分类、以及「审计表不在 #28 级联注册表」——项目被 purge 后痕迹仍在。
 * - HTTP 段走 `/api` 公共边界（含 F2 `resolveHttpActor` 注入点），验证：经守卫的写入留痕、
 *   `audit:view` 行级可见（owner / 顶层 manager，普通成员 403）、人的 `org:revoke` 撤销权
 *   （仅人、可逆才可撤销、永久删除与状态可逆被拒）、以及越权写入不落审计。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t5-audit-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withRepos<T>(
  fn: (ctx: { repos: RepositorySet; db: Database.Database; driver: SqliteDriver; dir: string }) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
    try {
      runMigrations(db, migrations);
      return await fn({ repos: createRepositories(driver), db, driver, dir });
    } finally {
      await driver.close();
    }
  });
}

// ---------------------------------------------------------------------------
// 仓储 seam
// ---------------------------------------------------------------------------

test("T5-AUDIT-REPO-01：append / get / list / markReversed 基本读写（append-only）", async () => {
  await withRepos(async ({ repos }) => {
    const projectId = "p1";
    const row = await appendAuditEntry(repos.audit, {
      projectId,
      actor: { kind: "human", name: "人" },
      action: AUDIT_ACTIONS.member_add,
      targetKind: "member",
      targetId: "m1",
      targetName: "甲",
      before: null,
      after: { id: "m1" },
    });
    assert.ok(row.id, "应生成 ulid 主键");
    assert.equal(row.projectId, projectId);
    assert.equal(row.actorKind, "human");

    const got = (await ((await (repos.audit.get(projectId, row.id)))));
    assert.ok(got, "get 应命中");
    assert.equal(got!.id, row.id);

    const listed = (await ((await (repos.audit.list(projectId)))));
    assert.equal(listed.length, 1);

    (await ((await (repos.audit.markReversed(projectId, row.id, "rev1", new Date().toISOString())))));
    const after = (await ((await (repos.audit.get(projectId, row.id)))))!;
    assert.ok(after.reversedAt, "markReversed 应回写 reversed_at");
    assert.equal(after.reversedByAuditId, "rev1");
  });
});

test("T5-AUDIT-REPO-02：list 按 action / targetKind / targetId / limit 过滤", async () => {
  await withRepos(async ({ repos }) => {
    const projectId = "p1";
    for (let i = 0; i < 5; i++) {
      appendAuditEntry(repos.audit, {
        projectId,
        actor: { kind: "human", name: "人" },
        action: i % 2 === 0 ? AUDIT_ACTIONS.member_add : AUDIT_ACTIONS.member_remove,
        targetKind: "member",
        targetId: `m${i}`,
        targetName: `甲${i}`,
        before: null,
        after: { id: `m${i}` },
      });
    }
    assert.equal((await ((await (repos.audit.list(projectId, { action: AUDIT_ACTIONS.member_add }))))).length, 3);
    assert.equal((await ((await (repos.audit.list(projectId, { targetKind: "member" }))))).length, 5);
    assert.equal((await ((await (repos.audit.list(projectId, { targetId: "m2" }))))).length, 1);
    assert.equal((await ((await (repos.audit.list(projectId, { limit: 2 }))))).length, 2);
  });
});

test("T5-AUDIT-REPO-03：revokeUnavailableReason 分类（可逆 / 永久 / 状态可逆 / 未知）", () => {
  // 可逆（含撤销的撤销）。
  for (const a of [
    "member.add",
    "member.remove",
    "member.pause",
    "member.resume",
    "member.status_change",
    "member.revoke",
    "org.node_create",
    "org.node_update",
    "org.node_delete",
    "org.assign",
    "org.auto_place",
    "org.revoke",
  ]) {
    assert.equal(revokeUnavailableReason(a), null, `${a} 应可逆`);
  }
  // 永久删除不可撤销。
  assert.equal(revokeUnavailableReason("project.delete"), "permanent_delete");
  assert.equal(revokeUnavailableReason("group.delete"), "permanent_delete");
  // 归档 / 恢复属状态本身可逆，不提供撤销入口。
  assert.equal(revokeUnavailableReason("project.archive"), "forward_reversible");
  assert.equal(revokeUnavailableReason("project.restore"), "forward_reversible");
  assert.equal(revokeUnavailableReason("group.archive"), "forward_reversible");
  assert.equal(revokeUnavailableReason("group.restore"), "forward_reversible");
  // 未知类型不可撤销。
  assert.equal(revokeUnavailableReason("something.weird"), "action_not_revocable");
});

test("T5-AUDIT-REPO-04：createAuditRecorder 把 OrgChange 映射为审计行（含 before/after 与缺省退化）", async () => {
  await withRepos(async ({ repos }) => {
    const repo = repos.audit;
    const recorder = createAuditRecorder(repo);
    const projectId = "p1";

    recorder.record({
      projectId,
      action: "member.disable",
      nodeId: null,
      memberId: "m1",
      detail: { from: "active" },
      actor: { kind: "human", name: "人", memberId: "m0" },
      targetName: "甲",
      before: { id: "m1", status: "active" },
      after: { id: "m1", status: "disabled" },
    } as OrgChange);
    const paused = await repo.list(projectId, { action: AUDIT_ACTIONS.member_pause });
    assert.equal(paused.length, 1, "member.disable → member_pause");
    assert.equal(paused[0]!.targetId, "m1");
    assert.equal(paused[0]!.actorKind, "human");

    // 未授权主体时退化为 system。
    recorder.record({
      projectId,
      action: "node.create",
      nodeId: "n1",
      memberId: null,
      detail: { name: "统筹" },
      targetName: "统筹",
      before: null,
      after: { id: "n1" },
    } as OrgChange);
    const created = await repo.list(projectId, { action: AUDIT_ACTIONS.org_node_create });
    assert.equal(created.length, 1);
    assert.equal(created[0]!.actorKind, "system");

    // auto_place 落空（无岗位）是 no-op，不写审计。
    recorder.record({
      projectId,
      action: "member.auto_place",
      nodeId: null,
      memberId: "m2",
      detail: { placed: false },
    } as OrgChange);
    assert.equal((await repo.list(projectId, { action: AUDIT_ACTIONS.org_auto_place })).length, 0);
  });
});

test("T5-AUDIT-REPO-05：字段超长截断并标记 truncated（截断事件不可撤销）", async () => {
  await withRepos(async ({ repos }) => {
    const projectId = "p1";
    const big = { data: "x".repeat(40 * 1024) };
    const row = await appendAuditEntry(repos.audit, {
      projectId,
      actor: { kind: "human", name: "人" },
      action: AUDIT_ACTIONS.member_add,
      targetKind: "member",
      targetId: "m1",
      targetName: "甲",
      before: big,
      after: null,
    });
    const got = (await ((await (repos.audit.get(projectId, row.id)))))!;
    assert.ok(got.before && got.before.includes("truncated"), "超长字段应截断");
    const view = auditView(got);
    assert.equal((view.detail as { truncated?: boolean }).truncated, true);
    assert.equal(view.reversible, false, "截断事件不可撤销");
  });
});

test("T5-AUDIT-REPO-06：审计表不在 #28 级联注册表——项目被 purge 后审计痕迹仍在", async () => {
  await withRepos(async ({ repos }) => {
    const project = (await ((await (repos.projects.create({ name: "生命周期项目" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "张三", hostType: "claude-code" })))));
    const member = (await ((await (repos.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "张三",
    })))));
    appendAuditEntry(repos.audit, {
      projectId: project.id,
      actor: { kind: "human", name: "人" },
      action: AUDIT_ACTIONS.member_add,
      targetKind: "member",
      targetId: member.id,
      targetName: member.displayName,
      before: null,
      after: member,
    });
    assert.equal((await ((await (repos.audit.list(project.id))))).length, 1, "写入一条成员添加审计");

    // 永久删除项目（二次确认后的清除：级联删成员/群组/消息，但 audit_log 不在注册表）。
    (await ((await (repos.projects.purge(project.id)))));
    assert.equal((await ((await (repos.audit.list(project.id))))).length, 1, "项目删除后审计行仍存活");
  });
});

// ---------------------------------------------------------------------------
// HTTP seam
// ---------------------------------------------------------------------------

/** 守卫主体：按请求头切换「人 / 顶层 manager / 普通成员 / agent」四种调用者。 */
function actorFor(projectId: string, role: "top_manager" | "member", kind: "human" | "agent" = "agent"): Actor {
  return {
    actorId: `actor-${role}-${kind}`,
    kind,
    role,
    projectId,
    nodeId: null,
    subtreeNodeIds: null,
  };
}

async function withServer<T>(
  fn: (server: RunningServer) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t5-audit-http-"));
  const server = await startServer({
    config: {
      port: 0,
      dataDir: dir,
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      configFile: null,
    },
    logger: silentLogger,
    authorization: {
      resolveHttpActor: async ({ request, projectId }) => {
        const as = request.headers["x-as"];
        if (as === "manager") return actorFor(projectId ?? "", "top_manager", "human");
        if (as === "member") return actorFor(projectId ?? "", "member", "human");
        if (as === "agent") return actorFor(projectId ?? "", "top_manager", "agent");
        return ownerActor(projectId);
      },
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
  const added = await call(server, "POST", `/api/projects/${projectId}/members`, {
    kind: "human",
    displayName,
  });
  assert.equal(added.status, 201, `添加成员应成功：${JSON.stringify(added.body)}`);
  return added.body.member;
}

test("T5-AUDIT-HTTP-01：经守卫的「添加成员」写入审计，audit:view 行级可见（owner / 顶层 manager，普通成员 403）", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "审计项目");
    const alice = await addHuman(server, project.id, "Alice");

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const entries = list.body.entries as any[];
    const added = entries.find((e) => e.action === "member.add");
    assert.ok(added, "成员添加应写入审计");
    assert.equal(added.targetId, alice.id);
    assert.equal(added.actorKind, "human");
    assert.equal(added.targetName, "Alice");

    // 顶层 manager 同样可见（ROLE_CAPABILITIES 给 top_manager audit:view）。
    const asManager = await call(server, "GET", `/api/projects/${project.id}/audit`, undefined, {
      "x-as": "manager",
    });
    assert.equal(asManager.status, 200);

    // 普通成员无 audit:view → 403。
    const asMember = await call(server, "GET", `/api/projects/${project.id}/audit`, undefined, {
      "x-as": "member",
    });
    assert.equal(asMember.status, 403);
    assert.match(asMember.body.error.message, /audit:view/);
  });
});

test("T5-AUDIT-HTTP-02：人撤销可逆事件（member.add）成功——原事件标记 reversedAt，补偿删除成员", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "撤销项目");
    const alice = await addHuman(server, project.id, "Alice");

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const added = (list.body.entries as any[]).find((e) => e.action === "member.add");

    const revoke = await call(
      server,
      "POST",
      `/api/projects/${project.id}/audit/${added.id}/revoke`,
    );
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    assert.equal(revoke.body.entry.action, "member.revoke");
    assert.equal(revoke.body.entry.detail.kind, "undo");
    assert.equal(revoke.body.entry.detail.undoes, added.id);
    assert.equal(revoke.body.entry.targetId, alice.id);

    // 原事件被标记，审计共 2 行。
    const list2 = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const entries2 = list2.body.entries as any[];
    assert.equal(entries2.length, 2);
    const orig = entries2.find((e) => e.id === added.id)!;
    assert.ok(orig.reversedAt, "原事件应标记 reversedAt");

    // 补偿真的执行：撤销「添加成员」＝删除该成员。
    const members = await call(server, "GET", `/api/projects/${project.id}/members`);
    const stillThere = (members.body.members as any[]).find((m) => m.id === alice.id);
    assert.equal(stillThere, undefined, "撤销添加成员后应删除该成员");
  });
});

test("T5-AUDIT-HTTP-03：agent 撤销被拒（org:revoke 仅人）→ 403", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "撤销项目");
    await addHuman(server, project.id, "Alice");

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const added = (list.body.entries as any[]).find((e) => e.action === "member.add");

    const revoke = await call(
      server,
      "POST",
      `/api/projects/${project.id}/audit/${added.id}/revoke`,
      undefined,
      { "x-as": "agent" },
    );
    assert.equal(revoke.status, 403, JSON.stringify(revoke.body));
    assert.match(revoke.body.error.message, /org:revoke/);
  });
});

test("T5-AUDIT-HTTP-04：撤销普通成员被拒（org:revoke 不在成员能力集）→ 403", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "撤销项目");
    await addHuman(server, project.id, "Alice");

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const added = (list.body.entries as any[]).find((e) => e.action === "member.add");

    const revoke = await call(
      server,
      "POST",
      `/api/projects/${project.id}/audit/${added.id}/revoke`,
      undefined,
      { "x-as": "member" },
    );
    assert.equal(revoke.status, 403);
    assert.match(revoke.body.error.message, /org:revoke/);
  });
});

test("T5-AUDIT-HTTP-05：状态可逆事件（project.archive）不可撤销 → 403 forward_reversible", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "归档项目");
    const archived = await call(server, "POST", `/api/projects/${project.id}/archive`);
    assert.equal(archived.status, 200);

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const entry = (list.body.entries as any[]).find((e) => e.action === "project.archive");
    assert.ok(entry, "归档应留痕");

    const revoke = await call(
      server,
      "POST",
      `/api/projects/${project.id}/audit/${entry.id}/revoke`,
    );
    assert.equal(revoke.status, 403, JSON.stringify(revoke.body));
    assert.equal(revoke.body.error.code, "forward_reversible");
    assert.match(revoke.body.error.message, /归档|状态/);
  });
});

test("T5-AUDIT-HTTP-06：越权操作不写审计（F2 守卫在写入之前）——普通成员添加成员被拒且零审计", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "守卫项目");

    const denied = await call(
      server,
      "POST",
      `/api/projects/${project.id}/members`,
      { kind: "human", displayName: "X" },
      { "x-as": "member" },
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const list = await call(server, "GET", `/api/projects/${project.id}/audit`);
    const hasAdd = (list.body.entries as any[]).some((e) => e.action === "member.add");
    assert.equal(hasAdd, false, "越权的成员添加不应产生审计");
  });
});

test("T5-AUDIT-HTTP-07：项目间审计隔离——A 的审计不出现在 B", async () => {
  await withServer(async (server) => {
    const pa = await createProject(server, "项目A");
    const pb = await createProject(server, "项目B");
    await addHuman(server, pa.id, "Alice");

    const listA = await call(server, "GET", `/api/projects/${pa.id}/audit`);
    const listB = await call(server, "GET", `/api/projects/${pb.id}/audit`);
    assert.ok((listA.body.entries as any[]).some((e) => e.action === "member.add"));
    assert.equal((listB.body.entries as any[]).length, 0, "B 不应看到 A 的审计");
  });
});

test("T5-AUDIT-HTTP-08：截断事件（失去完整快照）不可撤销 → 403 truncated", async () => {
  await withServer(async (server) => {
    const project = await createProject(server, "截断项目");
    // 直接注入一条被字段截断的审计行（模拟超大 before 快照被截断）。
    (server.database as SqliteDriver).handle
      .prepare(
        `INSERT INTO audit_log
           (id, project_id, actor_kind, actor_member_id, actor_name, action,
            target_kind, target_id, target_name, changed, before, after, detail,
            reversed_at, reversed_by_audit_id, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?)`,
      )
      .run(
        "trunc1",
        project.id,
        "human",
        "人",
        "member.add",
        "member",
        "m1",
        "甲",
        '{"truncated":true,"bytes":99999}',
        '{"truncated":true}',
        new Date().toISOString(),
      );
    const revoke = await call(
      server,
      "POST",
      `/api/projects/${project.id}/audit/trunc1/revoke`,
    );
    assert.equal(revoke.status, 403, JSON.stringify(revoke.body));
    assert.equal(revoke.body.error.code, "truncated");
    assert.match(revoke.body.error.message, /截断/);
  });
});

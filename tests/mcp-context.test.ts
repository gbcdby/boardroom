import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, type McpSessionContext, type SessionBinding } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import type { Actor } from "../src/server/authz/authorize.ts";

/**
 * T6（#53）MCP 上下文注入的测试 seam：与 `tests/mcp-server.test.ts` / `tests/authorize-mcp.test.ts`
 * 同一 seam——fake MCP client + 真实 server + 真实 SQLite，在「入群（会话建立）」处断言注入的
 * 上下文载荷，并验证跨项目隔离与只读可见性边界（MCPCTX-01/02、AC-IDENT-01、AC-PROJ-GUARD-01）。
 *
 * 这是「上下文注入」而非「新工具」：上下文作为 `join` 出参的 `context` 字段下发，复用阶段 1
 * 已有的入群流程，不新增 MCP 工具。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

interface Ctx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  context?: McpSessionContext;
  memberId?: string;
  [key: string]: unknown;
}

interface Member {
  call(name: string, args: Record<string, unknown>): Promise<ToolPayload>;
  close(): Promise<void>;
}

async function withDb<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t6-ctx-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  try {
    return await fn({ db: driver, repos, projectId: project.id, groupId: group.id });
  } finally {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 一个成员 = 一个 core（可注入 authz.actorFor，模拟 T2 的岗位数据）+ fake client。 */
async function spawn(ctx: Ctx, name: string, actorFor?: (binding: SessionBinding) => Promise<Actor>): Promise<Member> {
  const core = createMcpCore({
    logger: silentLogger,
    db: ctx.db,
    memberKey: name,
    ...(actorFor ? { authz: { actorFor } } : {}),
  });
  const server = createMcpServer({ core, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${name}-client`, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(toolName, args) {
      const result = (await client.callTool({ name: toolName, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      return JSON.parse(result.content.find((p) => p.type === "text")?.text ?? "{}") as ToolPayload;
    },
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

test("正常参与者入群：上下文含项目/群组/身份/可见参与者，且可写（canPost/canWake=true）", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "A");
    try {
      const join = await a.call("join", {
        displayName: "A",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      assert.equal(join.ok, true, `join 应成功：${JSON.stringify(join.error)}`);
      const c = join.context;
      assert.ok(c, "join 出参必须携带 context 字段（T6 注入点）");

      // 项目 / 群组（含名称，便于 agent 自识别所处位置）。
      assert.equal(c!.project.id, ctx.projectId);
      assert.equal(c!.group.id, ctx.groupId);

      // 身份：普通参与者 → 静态角色 member、管辖范围 own。
      assert.equal(c!.identity.memberId, join.memberId);
      assert.equal(c!.identity.role, "member");
      assert.equal(c!.identity.reach, "own");

      // 可见性：参与者默认可写、可唤醒。
      assert.equal(c!.visibility.scope, "write");
      assert.equal(c!.visibility.canPost, true);
      assert.equal(c!.visibility.canWake, true);

      // 可见参与者名单（来自本群组、本项目）。
      assert.ok(c!.participants.length >= 1);
      assert.equal(c!.participants[0]!.kind, "agent");

      // 跨项目隔离边界：本会话唯一可访问项目，绝不开放跨项目。
      assert.equal(c!.isolation.projectId, ctx.projectId);
      assert.equal(c!.isolation.crossProjectAccess, false);
    } finally {
      await a.close();
    }
  });
});

test("跨项目隔离：上下文只含所属项目/群组，绝不出现任何跨项目数据（MCPCTX-02 / AC-PROJ-GUARD-01）", async () => {
  await withDb(async (ctx) => {
    // 制造跨项目数据：另一项目 / 另一群组 / 另一项目的成员。
    const otherProject = (await ((await (ctx.repos.projects.create({ name: "P2" })))));
    const otherGroup = (await ((await (ctx.repos.groups.create({ projectId: otherProject.id, name: "G2" })))));
    const otherAgent = (await ((await (ctx.repos.agents.create({ displayName: "Other", hostType: "other" })))));
    const otherMember = (await ((await (ctx.repos.members.create({
      projectId: otherProject.id,
      kind: "agent",
      agentId: otherAgent.id,
      displayName: "Other",
      role: "normal",
    })))));
    (await ((await (ctx.repos.groups.addParticipant(otherGroup.id, otherMember.id)))));

    const a = await spawn(ctx, "A");
    try {
      const join = await a.call("join", {
        displayName: "A",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      assert.equal(join.ok, true, `join 应成功：${JSON.stringify(join.error)}`);
      const c = join.context!;
      const serialized = JSON.stringify(c);

      // 任何跨项目标识符都不得出现在上下文中。
      assert.ok(!serialized.includes(otherProject.id), "上下文不得含另一项目 ID");
      assert.ok(!serialized.includes(otherGroup.id), "上下文不得含另一群组 ID");
      assert.ok(!serialized.includes(otherMember.id), "上下文不得含另一项目成员 ID");

      // 参与者只来自本群组（同一项目），不含跨项目成员。
      assert.equal(c.project.id, ctx.projectId);
      assert.equal(c.group.id, ctx.groupId);
      for (const p of c.participants) {
        assert.equal(p.memberId, join.memberId, "参与者只来自本群组/本项目");
      }
      assert.equal(c.isolation.projectId, ctx.projectId);
      assert.equal(c.isolation.crossProjectAccess, false);
    } finally {
      await a.close();
    }
  });
});

test("只读可见（group:view_subtree）的群组：上下文 scope=read_only，不暴露发言/唤醒能力", async () => {
  await withDb(async (ctx) => {
    // 组织树：根（顶层 manager，top_manager）→ n1（sub_manager）→ 两个下属岗位（member）。
    // 每个岗位至多一名成员占据（唯一约束），故入群成员与参与者分别占 n1 / n1a / n1b，
    // 全部落在 n1 的子树内。
    const root = (await ((await (ctx.repos.org.createNode({
      projectId: ctx.projectId,
      parentId: null,
      name: "统筹",
      role: "top_manager",
    })))));
    const n1 = (await ((await (ctx.repos.org.createNode({
      projectId: ctx.projectId,
      parentId: root.id,
      name: "A 线",
      role: "sub_manager",
    })))));
    const n1a = (await ((await (ctx.repos.org.createNode({
      projectId: ctx.projectId,
      parentId: n1.id,
      name: "A1 岗",
      role: "member",
    })))));
    const n1b = (await ((await (ctx.repos.org.createNode({
      projectId: ctx.projectId,
      parentId: n1.id,
      name: "A2 岗",
      role: "member",
    })))));
    const subtree = (await ((await (ctx.repos.org.subtreeNodeIds(n1.id)))));

    // 预先建好「入群成员」的 agent/member 并占岗 n1，使 join 复用（nodeId 落在子树内）。
    const viewerAgent = (await ((await (ctx.repos.agents.create({ displayName: "Viewer", hostType: "claude-code" })))));
    const viewerMember = (await ((await (ctx.repos.members.create({
      projectId: ctx.projectId,
      kind: "agent",
      agentId: viewerAgent.id,
      displayName: "Viewer",
      role: "normal",
    })))));
    (await ((await (ctx.repos.org.assignNode(viewerMember.id, n1.id)))));

    // 群内另两名参与者，分别占 n1a / n1b（均在子树内）。
    const seats = [n1a.id, n1b.id];
    let seatIdx = 0;
    for (const name of ["M1", "M2"]) {
      const a = (await ((await (ctx.repos.agents.create({ displayName: name, hostType: "claude-code" })))));
      const m = (await ((await (ctx.repos.members.create({
        projectId: ctx.projectId,
        kind: "agent",
        agentId: a.id,
        displayName: name,
        role: "normal",
      })))));
      (await ((await (ctx.repos.org.assignNode(m.id, seats[seatIdx++]!)))));
      (await ((await (ctx.repos.groups.addParticipant(ctx.groupId, m.id)))));
    }

    // 注入「非参与者但子树覆盖全部参与者」的 sub_manager 主体（T2 接口）。
    const viewerActor: Actor = {
      actorId: "m-viewer-injected",
      kind: "agent",
      role: "sub_manager",
      projectId: ctx.projectId,
      nodeId: n1.id,
      subtreeNodeIds: subtree,
    };
    const member = await spawn(ctx, "Viewer", async () => viewerActor);
    try {
      const join = await member.call("join", {
        displayName: "Viewer",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      assert.equal(join.ok, true, `join 应成功：${JSON.stringify(join.error)}`);
      const c = join.context!;

      // 只读可见：可看元数据与历史，但不开放发言/唤醒（CHAT-05 / ORG-07）。
      assert.equal(c.visibility.scope, "read_only", "非参与者 + 子树只读可见 → read_only");
      assert.equal(c.visibility.canPost, false, "只读可见不开放发言");
      assert.equal(c.visibility.canWake, false, "只读可见不开放唤醒");
      assert.equal(c.identity.role, "sub_manager");

      // 参与者（元数据）仍可见。
      assert.ok(c.participants.length >= 3, "只读可见的元数据/参与者仍可见");

      // 上下文与真实守卫一致：发言被 FORBIDDEN 拒绝（not_a_member）。
      const sent = await member.call("send_message", { text: "只读越权发言" });
      assert.equal(sent.ok, false);
      assert.equal(sent.error?.code, "FORBIDDEN");
      assert.equal(sent.error?.details?.deny, "not_a_member");
    } finally {
      await member.close();
    }
  });
});

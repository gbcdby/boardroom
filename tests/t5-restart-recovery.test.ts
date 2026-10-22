import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { openDatabase } from "../src/server/db/database.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T5（#18）持久化、重启恢复与重连积压 —— 投递 seam。
 *
 * seam：MCP 工具边界（fake client + 真实 server + 真实 SQLite 文件）。
 * 每个用例在**同一数据目录**上打开/关闭数据库，模拟服务端进程重启；验证：
 * - 消息/成员/群组/投递状态在重启后保留；
 * - 重连后 wait_for_messages 按可见范围补发积压（普通 agent / manager 各自正确）；
 * - 重复确认幂等、未确认消息可重投；
 * - @all 快照的离线边界；未参与群组不可见。
 */

interface Env {
  readonly dir: string;
  readonly db: Database.Database;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
}

interface Payload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

interface Fake {
  call(name: string, args: Record<string, unknown>): Promise<Payload>;
  readonly core: ReturnType<typeof createMcpCore>;
  close(): Promise<void>;
}

/** 打开目录并在其中确保有一个项目 + 一个群组；重启后复用已有项目/群组。 */
async function open(dir: string): Promise<Env> {
  const { db } = openDatabase(dir);
  runMigrations(db, migrations);
  const repos = createRepositories(db);
  const project = repos.projects.list()[0] ?? repos.projects.create({ name: "P" });
  const group = repos.groups.listByProject(project.id)[0] ?? repos.groups.create({ projectId: project.id, name: "G" });
  return { dir, db, repos, projectId: project.id, groupId: group.id };
}

async function withDir<T>(fn: (ctx: { dir: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t5-"));
  try {
    return await fn({ dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function spawn(env: Env, key: string): Promise<Fake> {
  const core = createMcpCore({ logger: silentLogger, db: env.db, memberKey: key });
  const server = createMcpServer({ core, logger: silentLogger });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key, version: "0.0.0" });
  await server.connect(st);
  await client.connect(ct);
  return {
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = res.content.find((p) => p.type === "text")?.text;
      assert.ok(text, `工具 ${name} 应返回 text`);
      return JSON.parse(text) as Payload;
    },
    core,
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

async function join(env: Env, f: Fake, displayName: string, kind = "claude-code"): Promise<string> {
  const r = await f.call("join", { displayName, hostType: kind, projectId: env.projectId, groupId: env.groupId });
  assert.equal(r.ok, true);
  return String(r["memberId"]);
}

test("重启后：消息/成员/群组/投递状态保留，重连补发积压（普通 agent 只收到自己发送+被@）", async () => {
  await withDir(async ({ dir }) => {
    // ---- 第一次进程：入群、manager 发消息 @ 普通 agent、人发一条未点名消息 ----
    let env = await open(dir);
    const mgr = await spawn(env, "mgr-1");
    const norm = await spawn(env, "norm-1");
    let normId: string;
    let mgrId: string;
    let humanId: string;
    let mentionedMsgId: string;
    try {
      mgrId = await join(env, mgr, "Manager");
      normId = await join(env, norm, "Worker");
      // 人成员：直接建库记录（WebUI 发送走 HTTP，这里等价于持久化层面的人）。
      const human = env.repos.members.create({ projectId: env.projectId, kind: "human", displayName: "我" });
      humanId = human.id;
      env.repos.groups.addParticipant(env.groupId, humanId);

      // manager @ 普通 agent 的消息（应进入普通 agent 积压）。
      const sent = await mgr.call("send_message", { text: `请处理 @Worker`, mentions: [normId] });
      mentionedMsgId = String(sent["messageId"]);
      // 人发一条未点名普通 agent 的消息（普通 agent 不可见，不进入其积压；manager 可见）。
      const humanMsg = env.repos.messages.create({
        groupId: env.groupId,
        senderMemberId: humanId,
        body: "大家好，今天下班前交",
        mentions: [],
      });
      for (const id of [mgrId, humanId]) env.repos.deliveries.ensure(humanMsg.id, id);
      assert.ok(humanMsg.id.length > 0);
    } finally {
      await mgr.close();
      await norm.close();
      env.db.close();
    }

    // ---- 模拟进程重启：关闭后重开同一目录 ----
    env = await open(dir);
    const norm2 = await spawn(env, "norm-2");
    try {
      // 重连：直接 wait_for_messages 拉积压（D6：重连后首次等待立即补投）。
      const re = await norm2.call("join", {
        displayName: "Worker",
        hostType: "claude-code",
        projectId: env.projectId,
        groupId: env.groupId,
      });
      assert.equal(re.ok, true);
      assert.equal(String(re["memberId"]), normId, "重启后重连应复用同一成员");

      const drained = await norm2.call("wait_for_messages", { timeoutMs: 2000 });
      assert.equal(drained["status"], "message", "重连后应立即拿到积压");
      assert.equal(drained["drainedBacklog"], true);
      const msgs = drained["messages"] as Array<{ id: string; text: string }>;
      assert.deepEqual(msgs.map((m) => m.id), [mentionedMsgId], "普通 agent 只应拿到被@的那条，不含未点名的群消息");

      // 投递状态已从 pending 推进到 delivered。
      const delivery = env.repos.deliveries.get(mentionedMsgId, normId);
      assert.equal(delivery?.status, "delivered");
    } finally {
      await norm2.close();
      env.db.close();
    }
  });
});

test("未确认的消息可重投，确认后不再重投；重复确认幂等", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const mgr = await spawn(env, "m-1");
    const norm = await spawn(env, "n-1");
    try {
      await join(env, mgr, "Manager");
      const normId = await join(env, norm, "Worker");
      const sent = await mgr.call("send_message", { text: `@Worker 看这条`, mentions: [normId] });
      const msgId = String(sent["messageId"]);

      // 第一次拉取：拿到消息（delivered，未 ack）。
      const first = await norm.call("wait_for_messages", { timeoutMs: 1000 });
      assert.equal(first["status"], "message");
      assert.equal((first["messages"] as Array<{ id: string }>)[0]!.id, msgId);
      assert.equal(env.repos.deliveries.get(msgId, normId)?.status, "delivered");

      // 未确认：再次等待应**重投**同一条（至少一次语义）。
      const retry = await norm.call("wait_for_messages", { timeoutMs: 1000 });
      assert.equal(retry["status"], "message", "未确认消息应可重投");
      assert.equal((retry["messages"] as Array<{ id: string }>)[0]!.id, msgId);

      // 确认：首次返回 alreadyAcknowledged=false。
      const ack1 = await norm.call("acknowledge_message", { messageId: msgId });
      assert.equal(ack1["alreadyAcknowledged"], false);
      assert.equal(env.repos.deliveries.get(msgId, normId)?.status, "acked");

      // 重复确认：幂等，alreadyAcknowledged=true。
      const ack2 = await norm.call("acknowledge_message", { messageId: msgId });
      assert.equal(ack2["alreadyAcknowledged"], true);

      // 确认后不再重投。
      const after = await norm.call("wait_for_messages", { timeoutMs: 300 });
      assert.equal(after["status"], "timeout", "已确认消息不应重投");
    } finally {
      await mgr.close();
      await norm.close();
      env.db.close();
    }
  });
});

test("重连补发可见范围：manager 收到项目内未点名消息，未参与群组者无投递", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const mgr = await spawn(env, "mgr");
    const norm = await spawn(env, "norm");
    try {
      await join(env, mgr, "Boss");
      const normId = await join(env, norm, "Worker");
      // 另建一个项目内但**未加入该群组**的成员。
      const outsiderAgent = env.repos.agents.create({ displayName: "Outsider", hostType: "codex-cli" });
      const outsiderMember = env.repos.members.create({
        projectId: env.projectId,
        kind: "agent",
        agentId: outsiderAgent.id,
        displayName: "Outsider",
      });
      // manager 发一条不点名任何人的消息。
      await mgr.call("send_message", { text: "全员周报" });

      // manager 重连等待：应拿到这条（manager 可见项目内全部消息）。
      const mgrDrained = await mgr.call("wait_for_messages", { timeoutMs: 500 });
      assert.equal(mgrDrained["status"], "message", "manager 应收到未点名消息");
      assert.equal((mgrDrained["messages"] as Array<{ text: string }>)[0]!.text, "全员周报");

      // 未参与者没有该群组任何消息的投递记录（隔离）。
      for (const m of env.repos.messages.listByGroup(env.groupId)) {
        assert.equal(env.repos.deliveries.get(m.id, outsiderMember.id), null, "未参与群组者不应有投递记录");
      }
      void normId;
    } finally {
      await mgr.close();
      await norm.close();
      env.db.close();
    }
  });
});

test("@all 离线边界：离线参与者不因 @all 进入积压，除非被单独 @ 或消息由自己发送", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const a = await spawn(env, "a");
    const b = await spawn(env, "b");
    try {
      // 两人都入群并保持连接（都算在线）。随后 b 断开（模拟离线）。
      await join(env, a, "Alice");
      const bId = await join(env, b, "Bob");
      // 让 b 的 MCP 会话标记为断开 → b 离线。
      b.core.disconnect();
      // a 发一条 @all 消息（b 此刻离线，不在发送时在线快照）。
      await a.call("send_message", { text: "大家好 @all" });
      // 另发一条显式 @b 的消息（离线边界：单独 @ 仍应进入 b 的积压）。
      const direct = await a.call("send_message", { text: `单独找 @Bob`, mentions: [bId] });

      // b 重连后拉积压：只应收到被单独 @ 的那条，不含 @all。
      const drained = await b.call("wait_for_messages", { timeoutMs: 1000 });
      assert.equal(drained["status"], "message");
      const ids = (drained["messages"] as Array<{ id: string; text: string }>).map((m) => m.id);
      assert.deepEqual(ids, [String(direct["messageId"])], "@all 不应命中发送时离线的 b；单独 @ 应命中");
    } finally {
      await a.close();
      await b.close();
      env.db.close();
    }
  });
});

test("连接断开时成员状态从 waiting/working 回落 offline（状态机，不臆造在线）", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const a = await spawn(env, "state-a");
    try {
      const aId = await join(env, a, "Alice");
      // 显式上报 working → 状态机进入 working。
      const r = await a.call("report_status", { status: "working" });
      assert.equal(r.ok, true);
      assert.equal(env.repos.statuses.get(env.projectId, aId)?.state, "working");

      // 断线（模拟会话回收/宿主断开）：成员运行状态应回落 offline，而非停留在 working。
      a.core.disconnect();
      assert.equal(env.repos.statuses.get(env.projectId, aId)?.state, "offline");
      // 持久化的 MCP 会话标记断开。
      const active = env.repos.mcpSessions.findActive(
        env.repos.members.get(aId)!.agentId!,
        env.projectId,
        env.groupId,
      );
      assert.equal(active, null, "断线后不应存在 connected 会话");
    } finally {
      await a.close();
      env.db.close();
    }
  });
});

test("NFR-09：数据库不可写/连接断开时写入返回明确错误，不静默丢数据", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    checkRepo(env.repos);
    env.db.close();
    // 关闭连接后再次写入：必须抛明确的持久化错误，而不是静默成功/丢数据。
    assert.throws(
      () => env.repos.messages.create({ groupId: "x", senderMemberId: "y", body: "z" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // repository 层归一化后的错误带 code。
        assert.ok(typeof (err as { code?: unknown }).code === "string" || err.name === "RepositoryError");
        return true;
      },
    );
  });
});

/** 触发一次正常写入，确保关闭前状态健康。 */
function checkRepo(repos: RepositorySet): void {
  assert.ok(repos.projects.list());
}

test("恢复韧性：消息可见但缺投递记录（模拟写入中途崩溃）时，重连仍能补投，不丢消息", async () => {
  await withDir(async ({ dir }) => {
    let env = await open(dir);
    const mgr = await spawn(env, "m-x");
    let normId: string;
    let msgId: string;
    try {
      await join(env, mgr, "Manager");
      // 直接构造「消息已落库、但目标成员的投递记录缺失」的最坏情况：
      const norm = env.repos.members.create({
        projectId: env.projectId,
        kind: "agent",
        agentId: env.repos.agents.create({ displayName: "Worker", hostType: "claude-code" }).id,
        displayName: "Worker",
      });
      normId = norm.id;
      env.repos.groups.addParticipant(env.groupId, normId);
      const m = env.repos.messages.create({
        groupId: env.groupId,
        senderMemberId: normId,
        body: "自救消息（无投递记录）",
        mentions: [],
      });
      msgId = m.id;
      // 注意：故意**不**为 (m, normId) 建投递记录。
      assert.equal(env.repos.deliveries.get(msgId, normId), null);
    } finally {
      await mgr.close();
      env.db.close();
    }

    // 重启后重连：自己发送的消息本就可见 → 即使没有投递记录也应补投出来。
    env = await open(dir);
    const worker = await spawn(env, "w-x");
    try {
      await worker.call("join", {
        displayName: "Worker",
        hostType: "claude-code",
        projectId: env.projectId,
        groupId: env.groupId,
      });
      const drained = await worker.call("wait_for_messages", { timeoutMs: 1000 });
      assert.equal(drained["status"], "message", "缺失投递记录不应导致消息丢失");
      const ids = (drained["messages"] as Array<{ id: string }>).map((m) => m.id);
      assert.ok(ids.includes(msgId), "缺失投递记录的消息应被补投");
      // 补投后投递记录被建立并推进。
      assert.equal(env.repos.deliveries.get(msgId, normId)?.status, "delivered");
    } finally {
      await worker.close();
      env.db.close();
    }
  });
});

test("优雅关闭：正在等待的成员被取消等待后不回写成 working，而是 offline（状态机不臆造 working）", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const a = await spawn(env, "close-a");
    try {
      const aId = await join(env, a, "Alice");
      // 起一个长等待并让它挂起（进入 waiting）。
      const waitPromise = a.call("wait_for_messages", { timeoutMs: 30_000 });
      void waitPromise.catch(() => {});
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(env.repos.statuses.get(env.projectId, aId)?.state, "waiting");

      // 模拟会话回收/优雅关闭：先 disconnect 再 close。
      a.core.disconnect();
      a.core.close();
      // 关闭后状态应是 offline，而不是被取消等待「回写」成 working。
      assert.equal(env.repos.statuses.get(env.projectId, aId)?.state, "offline");
    } finally {
      await a.close();
      env.db.close();
    }
  });
});

test("积压查询（repository seam）：listPending 只返回未完成投递，按群组 seq 稳定排序，acked 后移除", async () => {
  await withDir(async ({ dir }) => {
    const env = await open(dir);
    const human = env.repos.members.create({ projectId: env.projectId, kind: "human", displayName: "我" });
    env.repos.groups.addParticipant(env.groupId, human.id);
    const m1 = env.repos.messages.create({ groupId: env.groupId, senderMemberId: human.id, body: "一" });
    const m2 = env.repos.messages.create({ groupId: env.groupId, senderMemberId: human.id, body: "二" });
    const m3 = env.repos.messages.create({ groupId: env.groupId, senderMemberId: human.id, body: "三" });
    for (const m of [m1, m2, m3]) env.repos.deliveries.ensure(m.id, human.id);

    // 全部 pending 时按 seq 升序返回。
    assert.deepEqual(
      env.repos.deliveries.listPending(env.projectId, human.id).map((d) => d.messageId),
      [m1.id, m2.id, m3.id],
    );

    // 中间一条 acked：不再出现在 pending 积压中。
    env.repos.deliveries.recordAttempt(m2.id, human.id, "acked");
    assert.deepEqual(
      env.repos.deliveries.listPending(env.projectId, human.id).map((d) => d.messageId),
      [m1.id, m3.id],
    );

    // delivered（未 ack）仍算待完成，可重投。
    env.repos.deliveries.recordAttempt(m1.id, human.id, "delivered");
    assert.deepEqual(
      env.repos.deliveries.listPending(env.projectId, human.id).map((d) => d.messageId),
      [m1.id, m3.id],
    );
    env.db.close();
  });
});

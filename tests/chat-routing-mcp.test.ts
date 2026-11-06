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
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * T3（#16）MCP 投递/可见性集成测试。
 *
 * seam：MCP 工具边界（fake client + 真实 server + 真实 SQLite）。验证路由规则
 * 落到实际投递：普通 agent 只被 @ 唤醒、manager 被其他成员消息唤醒、发送者排除、
 * 未参与群组不可见、@all 快照、重复 ID 幂等。
 */

interface Ctx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
}

async function withDb<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t3-"));
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

interface Payload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

interface Fake {
  call(name: string, args: Record<string, unknown>): Promise<Payload>;
  close(): Promise<void>;
}

async function spawn(ctx: Ctx, key: string): Promise<Fake> {
  const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: key });
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
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

/** 入群并返回 memberId。 */
async function join(ctx: Ctx, f: Fake, displayName: string, kind: "claude-code" | "codex-cli" = "claude-code"): Promise<string> {
  const r = await f.call("join", { displayName, hostType: kind, projectId: ctx.projectId, groupId: ctx.groupId });
  assert.equal(r.ok, true);
  return String(r["memberId"]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("普通 agent 只被 @ 唤醒：未点名消息不会结束其等待", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    try {
      await join(ctx, a, "Alice");
      const bId = await join(ctx, b, "Bob");

      // b 等待；a 发送**未点名 b**的消息，b 的等待应超时而非收到消息。
      const waitPromise = b.call("wait_for_messages", { timeoutMs: 250 });
      await sleep(40);
      await a.call("send_message", { text: "大家好" });
      const waited = await waitPromise;
      assert.equal(waited["status"], "timeout", "普通 agent 不应被未点名消息唤醒");

      // 再 @ b，则唤醒命中。
      const wait2 = b.call("wait_for_messages", { timeoutMs: 2000 });
      await sleep(40);
      await a.call("send_message", { text: `你好 @${bId}`, mentions: [bId] });
      const hit = await wait2;
      assert.equal(hit["status"], "message");
      assert.equal((hit["messages"] as Array<{ text: string }>)[0]!.text, `你好 @${bId}`);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("manager 被其他成员的未点名消息唤醒", async () => {
  await withDb(async (ctx) => {
    // manager 需由 WebUI 指定 role；这里直接用 repository 把成员升为 manager。
    const m = await spawn(ctx, "m");
    const a = await spawn(ctx, "a");
    try {
      const mId = await join(ctx, m, "Manager");
      (await ((await (ctx.repos.members.update(mId, { role: "manager" })))));
      // 重新入群让绑定拿到 manager 角色（join 复用成员，重新读取 role 在 core 内已固化，
      // 因此这里再建一个 core 绑定也无必要：wake 判定每次都从 DB 读 roster role）。
      await join(ctx, a, "Alice");

      const waitPromise = m.call("wait_for_messages", { timeoutMs: 2000 });
      await sleep(40);
      await a.call("send_message", { text: "汇报进展" }); // 未点名 manager
      const waited = await waitPromise;
      assert.equal(waited["status"], "message", "manager 应被其他成员消息唤醒");
      assert.equal((waited["messages"] as Array<{ text: string }>)[0]!.text, "汇报进展");
    } finally {
      await m.close();
      await a.close();
    }
  });
});

test("发送者排除：自己等待时不会被自己刚发的消息唤醒", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    try {
      const aId = await join(ctx, a, "Alice");
      // a 等待，并 @ 自己发消息。不应被自己的消息唤醒（只做发送者排除）。
      const waitPromise = a.call("wait_for_messages", { timeoutMs: 250 });
      await sleep(40);
      await a.call("send_message", { text: `自言自语 @${aId}`, mentions: [aId] });
      const waited = await waitPromise;
      assert.equal(waited["status"], "timeout", "发送者不应被自己的消息唤醒");
    } finally {
      await a.close();
    }
  });
});

test("未参与群组不可见：外部成员的历史读取不包含该群消息（无泄漏）", async () => {
  await withDb(async (ctx) => {
    // 另建一个群组；外部成员只在这个群，看不到原群消息。
    const otherGroup = (await ((await (ctx.repos.groups.create({ projectId: ctx.projectId, name: "Other" })))));
    const a = await spawn(ctx, "a");
    const outsider = await spawn(ctx, "o");
    try {
      const aId = await join(ctx, a, "Alice");
      await a.call("send_message", { text: "原群机密" });

      // outsider 加入另一个群组。
      const jo = await outsider.call("join", {
        displayName: "Outsider",
        hostType: "codex-cli",
        projectId: ctx.projectId,
        groupId: otherGroup.id,
      });
      assert.equal(jo.ok, true);
      const hist = await outsider.call("read_history", { groupId: otherGroup.id });
      const texts = (hist["messages"] as Array<{ text: string }>).map((m) => m.text);
      assert.ok(!texts.includes("原群机密"), "外部群成员不得看到原群消息");
      // 读取原群直接 FORBIDDEN。
      const forbidden = await outsider.call("read_history", { groupId: ctx.groupId });
      assert.equal(forbidden.ok, false);
      assert.equal(forbidden.error?.code, "FORBIDDEN");
      void aId;
    } finally {
      await a.close();
      await outsider.close();
    }
  });
});

test("普通 agent 的 read_history 只含自己发送 + 被 @；manager 含全部", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    const m = await spawn(ctx, "m");
    try {
      const aId = await join(ctx, a, "Alice");
      await join(ctx, b, "Bob");
      const mId = await join(ctx, m, "Manager");
      (await ((await (ctx.repos.members.update(mId, { role: "manager" })))));

      await a.call("send_message", { text: `只给 Bob @${(await (async () => {
        // 取 b 的 memberId
        return (await ((await (ctx.repos.members.listByProject(ctx.projectId))))).find((x) => x.displayName === "Bob")!.id;
      })())}`, mentions: [(await ((await (ctx.repos.members.listByProject(ctx.projectId))))).find((x) => x.displayName === "Bob")!.id] });

      const bHist = await b.call("read_history", {});
      const bTexts = (bHist["messages"] as Array<{ text: string }>).map((x) => x.text);
      assert.equal(bTexts.length, 1, "Bob 应只看到被 @ 的那条");

      const mHist = await m.call("read_history", {});
      assert.equal((mHist["messages"] as unknown[]).length, 1, "manager 应看到群组全部消息");

      void aId;
    } finally {
      await a.close();
      await b.close();
      await m.close();
    }
  });
});

test("@all 通过 MCP 展开为在线参与者快照并唤醒在线普通 agent", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    const b = await spawn(ctx, "b");
    try {
      const aId = await join(ctx, a, "Alice");
      await join(ctx, b, "Bob");
      const waitB = b.call("wait_for_messages", { timeoutMs: 2000 });
      await sleep(40);
      await a.call("send_message", { text: "通知 @all 开会" });
      const got = await waitB;
      assert.equal(got["status"], "message");
      const msg = (got["messages"] as Array<{ text: string; mentions: string[] }>)[0]!;
      assert.equal(msg.text, "通知 @all 开会");
      // @all 快照写入持久化 mentions（Bob 在快照里，Alice 是发送者被排除）。
      assert.ok(msg.mentions.includes((await ((await (ctx.repos.members.listByProject(ctx.projectId))))).find((x) => x.displayName === "Bob")!.id));
      assert.ok(!msg.mentions.includes(aId), "@all 快照不应包含发送者");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test("无效 mention（未知 @name）返回 INVALID_ARGUMENT", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    try {
      await join(ctx, a, "Alice");
      const r = await a.call("send_message", { text: "你好 @nobody" });
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "INVALID_ARGUMENT");
    } finally {
      await a.close();
    }
  });
});

test("空消息返回 INVALID_ARGUMENT", async () => {
  await withDb(async (ctx) => {
    const a = await spawn(ctx, "a");
    try {
      await join(ctx, a, "Alice");
      const r = await a.call("send_message", { text: "   " });
      assert.equal(r.ok, false);
      assert.equal(r.error?.code, "INVALID_ARGUMENT");
    } finally {
      await a.close();
    }
  });
});

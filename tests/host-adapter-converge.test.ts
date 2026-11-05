import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, type McpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { getAdapter, isRegistered } from "../src/server/mcp/adapters/index.ts";

/**
 * #58（T2）core 运行期硬编码收敛到宿主适配层注册表 —— 测试 seam。
 *
 * 覆盖四个收敛点（AC-HOST-01 / NFR-HOST-03）：
 * 1. `DEFAULT_HOST_INTERRUPT_CAPABILITY` 硬编码映射被删除，默认打断能力改为从注册表读取
 *    （claude-code / codex-cli / dsh / other → 各自 adapter 的 capabilities.interrupt）。
 * 2. `buildInterruptReason` 的 hostType 分支被 `interruptReasonNote`（注册表字段）取代，
 *    claude-code 的 unsupported 依据仍匹配 `/不能打断|无法打断/` 且保留 D6 实测说明。
 * 3. join 运行期白名单改为注册表驱动（`isRegistered`），拒绝未注册宿主、接受 dsh 与三个已知宿主。
 * 4. server.ts 的 join zod 校验改为注册表驱动（refine isRegistered），拒绝未知、接受已注册。
 *
 * 非目标：不触碰 T1（四宿主模块）/ T3（dsh 身份迁移）/ T4（证据文档），不改 adapter 能力值或
 * interruptReasonNote 文本，不改 MCP 契约/DB 列类型/迁移。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

const KNOWN_HOSTS = ["claude-code", "codex-cli", "dsh", "other"] as const;

interface CoreCtx {
  readonly db: SqliteDriver;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
  /** 以指定 hostType 创建并登记一个 core（用例结束统一 close）。 */
  readonly spawn: (key: string, name: string, hostType: string) => Promise<{
    core: McpCore;
    sessionId: string;
    memberId: string;
  }>;
}

async function withCoreCtx<T>(fn: (ctx: CoreCtx) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t58-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  const cores: Array<McpCore> = [];
  const spawn: CoreCtx["spawn"] = async (key, name, hostType) => {
    const core = createMcpCore({ logger: silentLogger, db: driver, memberKey: key });
    cores.push(core);
    const sessionId = "sess";
    const result = await core.join(sessionId, {
      displayName: name,
      hostType: hostType as never,
      projectId: project.id,
      groupId: group.id,
    });
    return { core, sessionId, memberId: result.memberId };
  };
  try {
    return await fn({ db: driver, repos, projectId: project.id, groupId: group.id, spawn });
  } finally {
    for (const core of cores) core.close();
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

interface ToolPayload {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

/** 一个 fake 成员 = 独立 core + 独立 server + InMemoryTransport。 */
async function spawnServerMember(ctx: CoreCtx, name: string) {
  const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: name });
  const server = createMcpServer({ core, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${name}-client`, version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: toolName, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const textPart = result.content.find((part) => part.type === "text");
    const payload = textPart?.text ? (JSON.parse(textPart.text) as ToolPayload) : { ok: false };
    return { payload, isError: result.isError === true };
  };
  return {
    call,
    async close() {
      await client.close();
      await server.close();
      core.close();
    },
  };
}

test("默认打断能力从注册表派生：四个宿主均取 adapter.capabilities.interrupt（非硬编码映射）", async () => {
  await withCoreCtx(async (ctx) => {
    for (const hostType of KNOWN_HOSTS) {
      const m = await ctx.spawn(hostType, hostType, hostType);
      // 不申报 hostCapability → 取注册表默认；须等于该 adapter 声明的能力值。
      const outcome = (await (m.core.attemptInterrupt(m.sessionId)));
      const expected = getAdapter(hostType as never).capabilities.interrupt;
      assert.equal(
        outcome.result,
        expected,
        `${hostType} 默认打断能力应等于注册表 adapter.capabilities.interrupt（${expected}）`,
      );
      // 注册表对四宿主的 interrupt 均为 unsupported（NFR-HOST-02 保守默认值）。
      assert.equal(expected, "unsupported");
      m.core.close();
    }
  });
});

test("buildInterruptReason（claude-code / unsupported）仍匹配 /不能打断|无法打断/ 且保留 D6 实测说明", async () => {
  await withCoreCtx(async (ctx) => {
    const m = await ctx.spawn("cc", "CC", "claude-code");
    const outcome = (await (m.core.attemptInterrupt(m.sessionId))); // 无申报 → unsupported。
    assert.equal(outcome.result, "unsupported");
    assert.match(outcome.reason, /不能打断|无法打断/);
    // 注册表提供的 D6 实测说明原样出现在依据中。
    const note = getAdapter("claude-code" as never).interruptReasonNote ?? "";
    assert.ok(outcome.reason.includes(note), `依据应含 D6 实测说明：${note}`);
    m.core.close();
  });
});

test("join 运行期白名单改为注册表驱动：拒绝未注册宿主、接受 dsh 与三个已知宿主", async () => {
  await withCoreCtx(async (ctx) => {
    // 已注册宿主：claude-code / codex-cli / dsh / other 都应成功。
    for (const hostType of KNOWN_HOSTS) {
      const core = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: `ok-${hostType}` });
      try {
        const r = await core.join("s", {
          displayName: "X",
          hostType: hostType as never,
          projectId: ctx.projectId,
          groupId: ctx.groupId,
        });
        assert.ok(r.memberId, `${hostType} 应成功入群`);
      } finally {
        core.close();
      }
    }

    // 未注册宿主：应被 isRegistered 拒绝，抛出 INVALID_ARGUMENT（含「未知 hostType」）。
    const stranger = createMcpCore({ logger: silentLogger, db: ctx.db, memberKey: "stranger" });
    try {
      await assert.rejects(
        async () =>
          stranger.join("s", {
            displayName: "X",
            hostType: "totally-unknown-host" as never,
            projectId: ctx.projectId,
            groupId: ctx.groupId,
          }),
        /未知 hostType/,
      );
    } finally {
      stranger.close();
    }

    // 回归确认：isRegistered 对未知宿主为 false，对 four 宿主为 true。
    assert.equal(isRegistered("totally-unknown-host" as never), false);
    for (const hostType of KNOWN_HOSTS) assert.equal(isRegistered(hostType as never), true);
  });
});

test("server.ts join 校验注册表驱动：拒绝未知 hostType、接受已注册（claude-code / dsh）", async () => {
  await withCoreCtx(async (ctx) => {
    // 已知宿主（claude-code）应成功入群 —— 不应被新校验误伤（回归）。
    const a = await spawnServerMember(ctx, "A");
    try {
      const { payload, isError } = await a.call("join", {
        displayName: "Alice",
        hostType: "claude-code",
        projectId: ctx.projectId,
        groupId: ctx.groupId,
      });
      assert.equal(isError, false);
      assert.equal(payload.ok, true);

      // dsh 现在作为一等宿主被接受。
      const d = await spawnServerMember(ctx, "D");
      try {
        const dr = await d.call("join", {
          displayName: "DeepSeek",
          hostType: "dsh",
          projectId: ctx.projectId,
          groupId: ctx.groupId,
        });
        assert.equal(dr.isError, false);
        assert.equal(dr.payload.ok, true);
      } finally {
        await d.close();
      }
    } finally {
      await a.close();
    }

    // 未知宿主：zod refine 校验失败 → 协议层 InvalidParams，client.callTool 拒绝。
    const z = await spawnServerMember(ctx, "Z");
    try {
      await assert.rejects(
        () =>
          z.call("join", {
            displayName: "Ghost",
            hostType: "totally-unknown-host",
            projectId: ctx.projectId,
            groupId: ctx.groupId,
          }),
        "未知 hostType 应被 server 层 zod 校验拒绝",
      );
    } finally {
      await z.close();
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "../src/server/logger.ts";
import { createMcpCore, type McpCore } from "../src/server/mcp/core.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import {
  migrateOtherToDsh,
  HostTypeMigrationCollisionError,
  type MigrationReport,
} from "../src/server/db/migrate-host-type.ts";

/**
 * #59（T3 / HOST-04）历史 other→dsh 数据迁移 + DSH 入群 seam（AC-HOST-05）测试。
 *
 * 复用 interrupt-core 同款 harness：`openDatabase` + `runMigrations` 在 mkdtemp 临时目录下建库，
 * `finally` 清理。通过 `createMcpCore().join(...)` 在库里写入真实 `agents` / `mcp_sessions` 行
 * （join 已接受 `hostType='dsh'` 与 `'other'`，由 #57/#58 保证，本文件仅验证 T3 迁移行为）。
 *
 * 覆盖：
 *  1. 迁移把历史 other→dsh，已 dsh 行不变；
 *  2. 幂等：重跑改变 0 行、报告 0；
 *  3. 迁移后 'other' 仍可作为新未知宿主合法值（D4）；
 *  4. ux_agents_identity 冲突时中止且不改动任何数据；
 *  5. AC-HOST-05：成员以 hostType='dsh' 入群后持久化 host_type='dsh'（锁定 #57/#58 行为）；
 *  6. dry-run 只报告、不执行。
 */

const silentLogger = createLogger({ level: "error", write: () => {} });

interface Ctx {
  readonly db: Database.Database;
  readonly repos: RepositorySet;
  readonly projectId: string;
  readonly groupId: string;
  /** 以指定 hostType 入群，写入真实 agents / members / mcp_sessions 行（用例结束统一 close core）。 */
  readonly join: (key: string, name: string, hostType: string) => Promise<{ core: McpCore; memberId: string }>;
}

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t59-"));
  const driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const db = driver.handle;
  runMigrations(db, migrations);
  const repos = createRepositories(driver);
  const project = (await ((await (repos.projects.create({ name: "P" })))));
  const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
  const cores: McpCore[] = [];
  const join: Ctx["join"] = async (key, name, hostType) => {
    const core = createMcpCore({ logger: silentLogger, db: driver, memberKey: key });
    cores.push(core);
    const result = await core.join("sess", {
      displayName: name,
      hostType,
      projectId: project.id,
      groupId: group.id,
    });
    return { core, memberId: result.memberId };
  };
  try {
    return await fn({ db, repos, projectId: project.id, groupId: group.id, join });
  } finally {
    for (const c of cores) c.close();
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function countAgents(db: Database.Database, hostType: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM agents WHERE host_type = ?").get(hostType) as { c: number }).c;
}
function countSessions(db: Database.Database, hostType: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM mcp_sessions WHERE host_type = ?").get(hostType) as { c: number }).c;
}

test("S2 alias：other→dsh 保留旧 alias 与已改显示名；隐藏的历史别名冲突也整体拒绝", async () => {
  await withCtx(async ctx => {
    const old = await ctx.repos.agents.create({ displayName: "改名前", hostType: "other" });
    await ctx.repos.agents.rename(old.id, "改名前", "改名后");
    const reserved = await ctx.repos.agents.create({ displayName: "改名后", hostType: "dsh" });
    await ctx.repos.agents.rename(reserved.id, "改名后", "另一个稳定身份");
    const beforeAgents = ctx.db.prepare("SELECT * FROM agents ORDER BY id").all();
    const beforeAliases = ctx.db.prepare("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type").all();
    assert.throws(() => migrateOtherToDsh(ctx.db), HostTypeMigrationCollisionError);
    assert.deepEqual(ctx.db.prepare("SELECT * FROM agents ORDER BY id").all(), beforeAgents);
    assert.deepEqual(ctx.db.prepare("SELECT * FROM agent_legacy_aliases ORDER BY display_name, host_type").all(), beforeAliases);
    await ctx.repos.agents.rename(old.id, "改名后", "无冲突的新名字");
    assert.equal(migrateOtherToDsh(ctx.db).changedAgents, 1);
    for (const name of ["改名前", "改名后", "无冲突的新名字"]) {
      const agent = await ctx.repos.agents.findByIdentity(name, "other");
      assert.equal(agent?.id, old.id); assert.equal(agent?.displayName, "无冲突的新名字");
    }
    assert.equal((await ctx.repos.agents.findByIdentity("无冲突的新名字", "dsh"))?.id, old.id);
    assert.equal((await ctx.repos.agents.findByIdentity("改名后", "dsh"))?.id, reserved.id);
  });
});

test("T3-1：迁移把历史 other→dsh，已 dsh 行不变", async () => {
  await withCtx(async (ctx) => {
    await ctx.join("k1", "OldOther", "other");
    await ctx.join("k2", "AnotherOther", "other");
    await ctx.join("k3", "AlreadyDsh", "dsh");

    assert.equal(countAgents(ctx.db, "other"), 2);
    assert.equal(countAgents(ctx.db, "dsh"), 1);

    const report = migrateOtherToDsh(ctx.db);
    assert.equal(report.changedAgents, 2);
    assert.equal(report.changedSessions, 2);
    assert.equal(report.skippedAgents, 1);
    assert.equal(report.skippedSessions, 1);
    assert.deepEqual([...report.collisions], []);
    assert.equal(report.dryRun, false);

    // agents：所有 other 变 dsh，已 dsh 保留。
    assert.equal(countAgents(ctx.db, "other"), 0);
    assert.equal(countAgents(ctx.db, "dsh"), 3);
    assert.ok((await ((await (ctx.repos.agents.findByIdentity("AlreadyDsh", "dsh"))))));

    // mcp_sessions：全部 dsh。
    assert.equal(countSessions(ctx.db, "other"), 0);
    assert.equal(countSessions(ctx.db, "dsh"), 3);
  });
});

test("T3-2：幂等 —— 重跑改变 0 行、报告 0", async () => {
  await withCtx(async (ctx) => {
    await ctx.join("k1", "X", "other");
    await ctx.join("k2", "Y", "dsh");

    const r1 = migrateOtherToDsh(ctx.db);
    assert.equal(r1.changedAgents, 1);
    assert.equal(r1.changedSessions, 1);

    const r2 = migrateOtherToDsh(ctx.db);
    assert.equal(r2.changedAgents, 0, "第二次应改变 0 行");
    assert.equal(r2.changedSessions, 0, "第二次应改变 0 行");
    assert.equal(r2.skippedAgents, 2);
    assert.equal(r2.skippedSessions, 2);
    assert.deepEqual([...r2.collisions], []);

    // 数据确实已全为 dsh。
    assert.equal(countAgents(ctx.db, "dsh"), 2);
    assert.equal(countSessions(ctx.db, "dsh"), 2);
  });
});

test("T3-3：D4 —— 迁移后 'other' 仍可作为新未知宿主合法值", async () => {
  await withCtx(async (ctx) => {
    await ctx.join("k1", "Hist", "other");
    migrateOtherToDsh(ctx.db);

    // 迁移后，新未知宿主仍可用 'other' 入群（不禁止 'other'）。
    const fresh = (await ((await (ctx.repos.agents.create({ displayName: "BrandNewUnknown", hostType: "other" })))));
    assert.equal(fresh.hostType, "other");
    assert.ok((await ((await (ctx.repos.agents.findByIdentity("BrandNewUnknown", "other"))))));

    // 不破坏唯一索引。
    assert.equal(countAgents(ctx.db, "other"), 1);
  });
});

test("T3-4：ux_agents_identity 冲突时中止且不改动任何数据", async () => {
  await withCtx(async (ctx) => {
    // 同一 display_name 同时拥有 other 与 dsh 两行 —— 改写会生成重复唯一键。
    await ctx.join("k1", "Dup", "other");
    await ctx.join("k2", "Dup", "dsh");
    // 另有纯 other 行，用于验证"整体未改动"。
    await ctx.join("k3", "Plain", "other");

    assert.equal(countAgents(ctx.db, "other"), 2);
    assert.equal(countAgents(ctx.db, "dsh"), 1);

    let thrown: unknown;
    try {
      migrateOtherToDsh(ctx.db);
      thrown = null;
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof HostTypeMigrationCollisionError, "冲突时应抛出 HostTypeMigrationCollisionError");
    const report = (thrown as HostTypeMigrationCollisionError).report;
    assert.deepEqual([...report.collisions].sort(), ["Dup"]);
    assert.equal(report.changedAgents, 0);
    assert.equal(report.changedSessions, 0);

    // 数据未改动：仍是 2 个 other、1 个 dsh，且唯一索引仍健全。
    assert.equal(countAgents(ctx.db, "other"), 2);
    assert.equal(countAgents(ctx.db, "dsh"), 1);
    assert.ok((await ((await (ctx.repos.agents.findByIdentity("Dup", "other"))))));
    assert.ok((await ((await (ctx.repos.agents.findByIdentity("Dup", "dsh"))))));
    assert.ok((await ((await (ctx.repos.agents.findByIdentity("Plain", "other"))))));
  });
});

test("T3-5：AC-HOST-05 —— 成员以 hostType='dsh' 入群后持久化 host_type='dsh'", async () => {
  await withCtx(async (ctx) => {
    const { core, memberId } = await ctx.join("k-dsh", "DeepSeek", "dsh");
    core.close();

    const agent = (await ((await (ctx.repos.agents.findByIdentity("DeepSeek", "dsh")))));
    assert.ok(agent, "应存在 (DeepSeek, dsh) 全局身份");
    assert.equal(agent.hostType, "dsh");

    const sess = ctx.db
      .prepare("SELECT host_type FROM mcp_sessions WHERE member_id = ?")
      .get(memberId) as { host_type: string };
    assert.equal(sess.host_type, "dsh");
  });
});

test("T3-6：dry-run 只报告、不执行", async () => {
  await withCtx(async (ctx) => {
    await ctx.join("k1", "X", "other");
    await ctx.join("k2", "Y", "dsh");

    const report: MigrationReport = migrateOtherToDsh(ctx.db, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.changedAgents, 1);
    assert.equal(report.changedSessions, 1);
    assert.deepEqual([...report.collisions], []);

    // 数据未改动。
    assert.equal(countAgents(ctx.db, "other"), 1);
    assert.equal(countSessions(ctx.db, "other"), 1);
    assert.equal(countAgents(ctx.db, "dsh"), 1);
  });
});

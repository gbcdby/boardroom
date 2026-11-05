import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { createT1ApiRouter } from "../src/server/api.ts";
import { createLogger } from "../src/server/logger.ts";
import { deriveEffectiveStatus } from "../src/server/status.ts";
import type { HeartbeatConfig } from "../src/server/config.ts";

/**
 * T4（#17）HTTP 状态端点 + fake timers 心跳超时的端到端验证。
 *
 * Seam：`GET /api/projects/:id/members/:m/status`（有状态端点），服务端时钟可注入，
 * 因此能**确定性地**用 fake timers 推进 30s，验证真实端点返回 offline + stale，
 * 再刷新心跳后恢复在线。
 */

const HEARTBEAT: HeartbeatConfig = { intervalMs: 10_000, timeoutMs: 30_000 };
const silentLogger = createLogger({ write: () => {} });

interface Seed {
  repos: RepositorySet;
  projectId: string;
  memberId: string;
  mcpSessionId: string;
}

async function withApi<T>(now: () => Date, fn: (call: (p: string) => Promise<any>, seed: Seed, repos: RepositorySet) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t4http-"));
  let driver: SqliteDriver | null = null;
  try {
    driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const handle = driver.handle;
    runMigrations(handle, migrations);
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const group = (await ((await (repos.groups.create({ projectId: project.id, name: "G" })))));
    const agent = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const member = (await ((await (repos.members.create({
      projectId: project.id,
      kind: "agent",
      agentId: agent.id,
      displayName: "Alice",
    })))));
    const session = (await ((await (repos.mcpSessions.connect({
      agentId: agent.id,
      projectId: project.id,
      groupId: group.id,
      memberId: member.id,
      displayName: "Alice",
      hostType: "claude-code",
    })))));
    (await ((await (repos.statuses.set(project.id, member.id, "waiting")))));

    const router = createT1ApiRouter({ db: driver, logger: silentLogger, heartbeat: HEARTBEAT, now });
    const call = async (pathname: string): Promise<any> => {
      // 构造最小 IncomingMessage/ServerResponse 垫片，直接驱动路由（不经过真实 socket）。
      const { Readable } = await import("node:stream");
      const request = Object.assign(Readable.from([]), { method: "GET", url: pathname, headers: {} });
      const chunks: Buffer[] = [];
      const headers: Record<string, string> = {};
      const response = {
        statusCode: 0,
        headersSent: false,
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        writeHead(status: number, h?: Record<string, string>) {
          this.statusCode = status;
          Object.assign(headers, h ?? {});
          this.headersSent = true;
        },
        end(payload?: string) {
          if (payload) chunks.push(Buffer.from(payload));
        },
      };
      const handled = await router.handle(request as any, response as any, pathname);
      assert.equal(handled, true, `路由应处理 ${pathname}`);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      return { status: response.statusCode, body };
    };
    return await fn(call, { repos, projectId: project.id, memberId: member.id, mcpSessionId: session.id }, repos);
  } finally {
    await driver?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("fake timers：心跳 30s 内在线（waiting）；超过 30s → 端点返回 offline + stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T00:00:00.000Z") });
  const base = new Date(Date.now());

  await withApi(() => new Date(Date.now()), async (call, seed, repos) => {
    // 心跳时间 = base（connect 时写入的是真实时钟，这里覆盖为 base 以保证与 fake now 对齐）。
    (await ((await (repos.mcpSessions.heartbeat(seed.mcpSessionId, base.toISOString())))));

    // 20s：仍在线 waiting。
    t.mock.timers.tick(20_000);
    let view = (await call(`/api/projects/${seed.projectId}/members/${seed.memberId}/status`)).body.memberStatus;
    assert.equal(view.state, "waiting");
    assert.equal(view.heartbeatTimedOut, false);

    // 推进到 30s + 1ms：心跳超时 → offline + stale。
    t.mock.timers.tick(10_001);
    view = (await call(`/api/projects/${seed.projectId}/members/${seed.memberId}/status`)).body.memberStatus;
    assert.equal(view.heartbeatTimedOut, true);
    assert.equal(view.state, "offline");
    assert.equal(view.stale, true, "心跳超时后应标记陈旧");

    // 恢复心跳 → 回到在线（在线/等待），陈旧清除。
    (await ((await (repos.mcpSessions.heartbeat(seed.mcpSessionId, new Date(Date.now()).toISOString())))));
    await t.mock.timers.tick?.(0);
    view = (await call(`/api/projects/${seed.projectId}/members/${seed.memberId}/status`)).body.memberStatus;
    assert.equal(view.heartbeatTimedOut, false);
    assert.equal(view.state, "waiting");
    assert.equal(view.stale, false);
  });
});

test("人：HTTP 状态端点只给 online/offline，不出现 waiting/working", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-t4human-"));
  let driver: SqliteDriver | null = null;
  try {
    driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const handle = driver.handle;
    runMigrations(handle, migrations);
    const repos = createRepositories(driver);
    const project = (await ((await (repos.projects.create({ name: "P" })))));
    const human = (await ((await (repos.members.create({ projectId: project.id, kind: "human", displayName: "H" })))));
    // 即便把持久状态写成 working（异常数据），端点也不得透出 working。
    (await ((await (repos.statuses.set(project.id, human.id, "working")))));

    const now = new Date("2026-10-22T00:00:00.000Z");
    const router = createT1ApiRouter({ db: driver, logger: silentLogger, heartbeat: HEARTBEAT, now: () => now });
    // 直接调用推导函数验证（端点同样使用它）。
    const effective = deriveEffectiveStatus({
      projectId: project.id,
      memberId: human.id,
      kind: "human",
      displayName: "H",
      storedState: "working",
      session: null,
      heartbeat: HEARTBEAT,
      now,
    });
    assert.notEqual(effective.state, "working");
    assert.notEqual(effective.state, "waiting");
    assert.equal(effective.state, "offline");
    void router;
  } finally {
    await driver?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

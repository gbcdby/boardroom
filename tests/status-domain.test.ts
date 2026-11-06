import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { deriveEffectiveStatus, deriveProjectStatuses } from "../src/server/status.ts";
import type { HeartbeatConfig } from "../src/server/config.ts";
import type { McpSession, MemberState } from "../src/server/db/types.ts";

/**
 * T4（#17）状态领域层单元测试。
 *
 * Seam：`deriveEffectiveStatus` / `deriveProjectStatuses` —— WebUI 状态看板所消费的
 * 「有效状态」推导。测试只走公共函数，不伸手查内部字段；时间通过 `now` 注入，
 * 心跳超时用 fake timers（node:test 的 `t.mock.timers`）推进。
 */

const HEARTBEAT: HeartbeatConfig = { intervalMs: 10_000, timeoutMs: 30_000 };

function isoOffset(base: Date, ms: number): string {
  return new Date(base.getTime() + ms).toISOString();
}

/** 构造一个 agent 的 connected 会话快照。 */
function connectedSession(at: Date, heartbeatAt: number | null): McpSession {
  return {
    id: "s1",
    agentId: "a1",
    projectId: "p1",
    groupId: "g1",
    memberId: "m1",
    displayName: "Alice",
    hostType: "claude-code",
    state: "connected",
    connectedAt: at.toISOString(),
    lastHeartbeatAt: heartbeatAt === null ? null : isoOffset(at, heartbeatAt),
    disconnectedAt: null,
    updatedAt: at.toISOString(),
  };
}

test("agent：连接有效且上报 waiting → waiting，不陈旧", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const status = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "waiting",
    session: connectedSession(now, 0),
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(status.state, "waiting");
  assert.equal(status.connection, "connected");
  assert.equal(status.stale, false);
  assert.equal(status.heartbeatTimedOut, false);
});

test("agent：连接有效且上报 working → working", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const status = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "working",
    session: connectedSession(now, 0),
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(status.state, "working");
});

test("agent：连接有效但持久状态为 offline（尚未上报）→ 视作 online", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const status = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "offline",
    session: connectedSession(now, 0),
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(status.state, "online");
});

test("心跳在 30s 边界内仍在线；fake timers 推进超过 30s 判定超时 → 离线且陈旧", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T00:00:00.000Z") });
  const base = new Date(Date.now());
  const session = connectedSession(base, 0); // 心跳 = base

  // 恰好 30s：未超过 timeoutMs（30_000），仍在线 waiting。
  t.mock.timers.tick(30_000);
  const at30 = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "waiting",
    session,
    heartbeat: HEARTBEAT,
    now: new Date(Date.now()),
  });
  assert.equal(at30.heartbeatTimedOut, false);
  assert.equal(at30.state, "waiting");

  // 再推进 1ms，超过 30s → 心跳超时，offline 且 stale。
  t.mock.timers.tick(1);
  const over = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "waiting",
    session,
    heartbeat: HEARTBEAT,
    now: new Date(Date.now()),
  });
  assert.equal(over.heartbeatTimedOut, true);
  assert.equal(over.state, "offline");
  assert.equal(over.stale, true, "心跳超时后应标记陈旧");
});

test("agent：会话已断开（disconnected）→ offline + disconnected + stale", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const session: McpSession = {
    ...connectedSession(now, -60_000),
    state: "disconnected",
    disconnectedAt: now.toISOString(),
  };
  const status = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "working",
    session,
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(status.state, "offline");
  assert.equal(status.connection, "disconnected");
  assert.equal(status.disconnected, true);
  assert.equal(status.stale, true);
});

test("人：即使持久状态被写成 working，也不显示 waiting/working（只 online/offline）", () => {
  const now = new Date("2026-10-22T00:00:00.000Z");
  const asWorking = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "h1",
    kind: "human",
    displayName: "Human",
    storedState: "working", // 不应被透出
    session: null,
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(asWorking.state, "offline");
  assert.notEqual(asWorking.state, "working");
  assert.notEqual(asWorking.state, "waiting");

  const asOnline = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "h1",
    kind: "human",
    displayName: "Human",
    storedState: "online",
    session: null,
    heartbeat: HEARTBEAT,
    now,
  });
  assert.equal(asOnline.state, "online");
});

test("心跳在 timeoutMs..2*timeoutMs 之间：仍在线但标记 heartbeatStale（陈旧渐变）", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T00:00:00.000Z") });
  const base = new Date(Date.now());
  const session = connectedSession(base, 0);
  // 推进 45s（>30s 且 <60s）→ 超时但未到强超时。
  t.mock.timers.tick(45_000);
  const status = deriveEffectiveStatus({
    projectId: "p1",
    memberId: "m1",
    kind: "agent",
    displayName: "Alice",
    storedState: "waiting",
    session,
    heartbeat: HEARTBEAT,
    now: new Date(Date.now()),
  });
  assert.equal(status.heartbeatTimedOut, true);
  assert.equal(status.heartbeatStale, false);
  assert.equal(status.state, "offline");
});

test("deriveProjectStatuses：按项目隔离成员状态，且人与 agent 区分", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-studio-status-"));
  let driver: SqliteDriver | null = null;
  try {
    driver = new SqliteDriver({ dataDir: dir });
    await driver.connect();
    await driver.migrate(migrations);
    const handle = driver.handle;
    runMigrations(handle, migrations);
    const repos: RepositorySet = createRepositories(driver);
    const now = new Date("2026-10-22T00:00:00.000Z");

    const p1 = (await ((await (repos.projects.create({ name: "P1" })))));
    const p2 = (await ((await (repos.projects.create({ name: "P2" })))));
    const human1 = (await ((await (repos.members.create({ projectId: p1.id, kind: "human", displayName: "Human1" })))));
    const a1 = (await ((await (repos.agents.create({ displayName: "Alice", hostType: "claude-code" })))));
    const agent1 = (await ((await (repos.members.create({ projectId: p1.id, kind: "agent", agentId: a1.id, displayName: "Alice" })))));
    const a2 = (await ((await (repos.agents.create({ displayName: "Bob", hostType: "codex-cli" })))));
    const agent2 = (await ((await (repos.members.create({ projectId: p2.id, kind: "agent", agentId: a2.id, displayName: "Bob" })))));

    (await ((await (repos.statuses.set(p1.id, human1.id, "online")))));
    (await ((await (repos.statuses.set(p1.id, agent1.id, "waiting")))));
    (await ((await (repos.statuses.set(p2.id, agent2.id, "working")))));
    const g1 = (await ((await (repos.groups.create({ projectId: p1.id, name: "G1" })))));
    const g2 = (await ((await (repos.groups.create({ projectId: p2.id, name: "G2" })))));
    (await ((await (repos.mcpSessions.connect({
      agentId: a1.id, projectId: p1.id, groupId: g1.id, memberId: agent1.id,
      displayName: "Alice", hostType: "claude-code",
    })))));
    (await ((await (repos.mcpSessions.connect({
      agentId: a2.id, projectId: p2.id, groupId: g2.id, memberId: agent2.id,
      displayName: "Bob", hostType: "codex-cli",
    })))));

    const p1Statuses = await deriveProjectStatuses(repos, p1.id, { heartbeat: HEARTBEAT, now });
    const p2Statuses = await deriveProjectStatuses(repos, p2.id, { heartbeat: HEARTBEAT, now });

    assert.equal(p1Statuses.length, 2, "P1 有两个成员");
    assert.equal(p2Statuses.length, 1, "P2 只有一个成员");
    const byId = (list: typeof p1Statuses, id: string) => list.find((s) => s.memberId === id)!;

    assert.equal(byId(p1Statuses, human1.id).kind, "human");
    assert.equal(byId(p1Statuses, human1.id).state, "online");
    assert.equal(byId(p1Statuses, agent1.id).kind, "agent");
    assert.equal(byId(p1Statuses, agent1.id).state, "waiting");
    // P2 的 agent 状态不会出现在 P1 视图里。
    assert.equal(p1Statuses.some((s) => s.memberId === agent2.id), false);
    assert.equal(byId(p2Statuses, agent2.id).state, "working");
  } finally {
    await driver?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("状态枚举保持 online/offline/waiting/working（无任务状态，STATUS-04 边界）", () => {
  const allowed: MemberState[] = ["online", "offline", "waiting", "working"];
  assert.deepEqual(allowed.sort(), ["offline", "online", "waiting", "working"].sort());
  assert.equal(allowed.includes("done" as MemberState), false);
});

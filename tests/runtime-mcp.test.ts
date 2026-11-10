import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DbDriver } from "../src/server/db/driver.ts";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createRuntimeGateway } from "../src/server/runtime/gateway.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpServer } from "../src/server/mcp/server.ts";
import { createLogger } from "../src/server/logger.ts";
import type { RuntimeBindingView } from "../src/server/runtime/types.ts";

const logger = createLogger({ level: "error", write: () => {} });
const PG_URL = process.env["AGENT_STUDIO_PG_TEST_URL"];

/** 双方言使用相同真实MCP断言；PG不可用时显式skip，不以SQLite代替PG结论。 */
function databaseTest(name: string, verify: (driver?: DbDriver) => Promise<void>) {
  test(`${name}（SQLite）`, () => verify());
  test(`${name}（PostgreSQL）`, { skip: !PG_URL }, async () => {
    const schema = `runtime_mcp_${randomBytes(8).toString("hex")}`;
    const db = new PostgresDriver({ connectionString: PG_URL!, schema });
    try { await verify(db); }
    finally { await db.connect(); await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await db.close(); }
  });
}
interface Payload { ok: boolean; status?: string; messages?: { id: string }[]; error?: { code: string }; [key: string]: unknown }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Payload> {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as { type: string; text?: string }[]).find((part) => part.type === "text")!.text!) as Payload;
}
async function until(predicate: () => boolean | Promise<boolean>, reason: string) {
  for (let i = 0; i < 200; i += 1) { if (await predicate()) return; await delay(1); }
  assert.fail(reason);
}

async function fixture(driver?: DbDriver) {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-mcp-"));
  const db = driver ?? new SqliteDriver({ dataDir: dir }); await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db); const runtime = createRuntimeRepository(db);
  const project = await repos.projects.create({ name: "MCP边界" });
  const otherProject = await repos.projects.create({ name: "其他项目" });
  const group = await repos.groups.create({ projectId: project.id, name: "当前群" });
  const otherGroup = await repos.groups.create({ projectId: project.id, name: "其他群" });
  const crossGroup = await repos.groups.create({ projectId: otherProject.id, name: "跨项目" });
  const created = await runtime.create({ name: "managed", backend: "claude-code", defaults: { workdir: dir }, bindings: [{ projectId: project.id, groupId: group.id }] });
  const view = created.bindings[0]!;
  const human = await repos.members.create({ projectId: project.id, kind: "human", displayName: "用户" });
  await repos.groups.addParticipant(group.id, human.id); await repos.groups.addParticipant(otherGroup.id, human.id);
  const closers: (() => Promise<void>)[] = [];
  async function external() {
    const core = createMcpCore({ db, logger, memberKey: randomBytes(8).toString("hex") });
    const server = createMcpServer({ core, logger });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "external-sdk", version: "test" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    closers.push(async () => { await core.close(); await core.disconnect(); await client.close(); await server.close(); });
    return { client, core, call: (name: string, args: Record<string, unknown>) => call(client, name, args) };
  }
  async function managed(v: RuntimeBindingView = view) {
    await runtime.intent(v.binding.id, "start");
    const fence = await runtime.claim(v.binding.id, `supervisor-${randomBytes(6).toString("hex")}`);
    const gateway = await createRuntimeGateway({ db, logger, onJoined: async () => {}, authority: {
      identity: { displayName: v.runtime.name, hostType: v.runtime.backend, projectId: v.binding.projectId, groupId: v.binding.groupId, memberId: v.binding.memberId },
      run: (operation, fn) => runtime.withFence(fence, fn, { requireRunningIntent: operation === "consume" }),
      beforeWait: async () => (await runtime.checkFence(fence)).binding.desiredState === "running",
      onDelivery: async () => { await runtime.patchRunner(fence, { phase: "working" }); },
    } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "managed-sdk", version: "test" });
    await gateway.attach(serverTransport); await client.connect(clientTransport);
    closers.push(async () => { await gateway.close(); await client.close(); });
    return { client, gateway, fence, call: (name: string, args: Record<string, unknown>) => call(client, name, args),
      join: () => call(client, "join", { displayName: v.runtime.name, hostType: v.runtime.backend, projectId: v.binding.projectId, groupId: v.binding.groupId }) };
  }
  async function humanMessage(text: string, wake: "allowed" | "suppressed" | null = "allowed") {
    const message = await repos.messages.create({ groupId: group.id, senderMemberId: human.id, body: text, mentions: [view.binding.memberId] });
    await repos.deliveries.ensure(message.id, view.binding.memberId, wake === null ? undefined : wake === "allowed" ? { decision: wake } : { decision: wake, reason: "rate_limited" });
    return message;
  }
  return { db, dir, repos, runtime, project, otherProject, group, otherGroup, crossGroup, created, view, human, external, managed, humanMessage,
    async close() { for (const close of closers.reverse()) await close(); if (!driver) await db.close(); await rm(dir, { recursive: true, force: true }); } };
}

databaseTest("R2 真实MCP保持普通external join，托管预留成员的公共join明确冲突", async (driver) => {
  const f = await fixture(driver);
  try {
    const external = await f.external();
    const denied = await external.call("join", { displayName: "managed", hostType: "claude-code", projectId: f.project.id, groupId: f.group.id });
    assert.equal(denied.error?.code, "CONFLICT");
    assert.equal((await f.repos.mcpSessions.listByProject(f.project.id)).length, 0);
    const ordinary = await external.call("join", { displayName: "external", hostType: "other", projectId: f.project.id, groupId: f.group.id });
    assert.equal(ordinary.ok, true);
    assert.equal((await external.call("send_message", { text: "普通接入仍可发言" })).ok, true);
  } finally { await f.close(); }
});
async function externalBindingRace(driver?: DbDriver) {
  const f = await fixture(driver);
  try {
    const external = await f.external();
    const member = await f.repos.members.create({ projectId: f.otherProject.id, agentId: f.created.runtime.agentId, kind: "agent", displayName: "managed" });
    const outcomes = await Promise.allSettled([
      external.call("join", { displayName: "managed", hostType: "claude-code", projectId: f.otherProject.id, groupId: f.crossGroup.id }),
      f.runtime.addBinding(f.created.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id }),
    ]);
    const joined = outcomes[0].status === "fulfilled" && outcomes[0].value.ok;
    const reserved = outcomes[1].status === "fulfilled";
    assert.notEqual(joined, reserved, "external连接与托管预留只能有一个成功");
    const connected = (await f.repos.mcpSessions.listByProject(f.otherProject.id)).filter((s) => s.memberId === member.id && s.state === "connected");
    assert.equal(connected.length, joined ? 1 : 0);
    if (joined) await assert.rejects(f.runtime.addBinding(f.created.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id }), /external_session_conflict/);
    else assert.equal((await external.call("join", { displayName: "managed", hostType: "claude-code", projectId: f.otherProject.id, groupId: f.crossGroup.id })).error?.code, "CONFLICT");
  } finally { await f.close(); }
}

databaseTest("R2 真实external join与托管预留独立事务并发不会双成功", externalBindingRace);

databaseTest("R2 external断开后新增托管预留，迟到的旧external请求不能穿透成员锁", async (driver) => {
  const f = await fixture(driver);
  try {
    const external = await f.external();
    const joined = await external.call("join", { displayName: "managed", hostType: "claude-code", projectId: f.otherProject.id, groupId: f.crossGroup.id });
    assert.equal(joined.ok, true);
    // 持久连接已被生命周期/超时清理，但旧SDK传输还有迟到请求。
    for (const session of await f.repos.mcpSessions.listByProject(f.otherProject.id)) {
      await f.repos.mcpSessions.disconnect(session.id, new Date().toISOString());
    }
    const reserved = await f.runtime.addBinding(f.created.runtime.id, { projectId: f.otherProject.id, groupId: f.crossGroup.id });
    await f.repos.statuses.set(f.otherProject.id, reserved.binding.memberId, "online");
    assert.equal((await external.call("send_message", { text: "已失去成员所有权的旧请求" })).error?.code, "CONFLICT");
    assert.equal((await external.call("report_status", { status: "working" })).error?.code, "CONFLICT");
    assert.equal((await external.call("heartbeat", {})).error?.code, "CONFLICT");
    assert.equal((await f.repos.messages.listByGroup(f.crossGroup.id)).length, 0);
    assert.equal((await f.repos.statuses.get(f.otherProject.id, reserved.binding.memberId))?.state, "online");
  } finally { await f.close(); }
});

databaseTest("R2 受控MCP不能选择其他身份/角色/群，授权拒绝保持FORBIDDEN", async (driver) => {
  const f = await fixture(driver);
  try {
    const managed = await f.managed();
    const base = { displayName: "managed", hostType: "claude-code", projectId: f.project.id, groupId: f.group.id };
    for (const change of [{ role: "manager" }, { displayName: "impersonation" }, { groupId: f.otherGroup.id }, { projectId: f.otherProject.id }]) {
      assert.equal((await managed.call("join", { ...base, ...change })).error?.code, "FORBIDDEN");
    }
    assert.equal((await managed.join()).ok, true);
    assert.equal((await managed.call("read_history", { groupId: f.otherGroup.id })).error?.code, "FORBIDDEN");
    assert.equal((await managed.call("send_message", { groupId: f.otherGroup.id, text: "越界" })).error?.code, "FORBIDDEN");
    assert.equal((await managed.call("report_status", { status: "working", memberId: f.human.id })).error?.code, "FORBIDDEN");
    const hidden = await f.repos.messages.create({ groupId: f.otherGroup.id, senderMemberId: f.human.id, body: "不能确认其他群消息" });
    assert.equal((await managed.call("acknowledge_message", { messageId: hidden.id })).error?.code, "FORBIDDEN");
    assert.equal((await f.repos.messages.listByGroup(f.otherGroup.id)).length, 1);
  } finally { await f.close(); }
});

databaseTest("R2 旧generation挂起wait不会出队、ACK或覆盖新generation状态", async (driver) => {
  const f = await fixture(driver);
  try {
    const old = await f.managed(); await old.join();
    const wait = old.call("wait_for_messages", { timeoutMs: 5000 });
    await until(() => old.gateway.pendingWaitCount === 1, "旧wait应已挂起");
    // 模拟已确认退出后仍有迟到的旧传输请求；只替换所有权，不伪造新消息处理。
    await f.runtime.markExit(old.fence, { exitCode: 0 });
    for (const session of await f.repos.mcpSessions.listByProject(f.project.id)) await f.repos.mcpSessions.disconnect(session.id, new Date().toISOString());
    const next = await f.runtime.claim(f.view.binding.id, "replacement");
    await f.repos.statuses.set(f.project.id, f.view.binding.memberId, "online");
    const message = await f.humanMessage("只给新代次"); await old.gateway.wake();
    const result = await wait;
    assert.equal(result.status, "cancelled"); assert.deepEqual(result.messages, []);
    assert.equal((await f.repos.deliveries.get(message.id, f.view.binding.memberId))?.status, "pending");
    assert.equal((await f.repos.statuses.get(f.project.id, f.view.binding.memberId))?.state, "online");
    assert.equal((await old.call("acknowledge_message", { messageId: message.id })).error?.code, "CONFLICT");
    assert.equal((await old.call("send_message", { text: "迟到旧回复" })).error?.code, "CONFLICT");
    assert.equal((await f.runtime.checkFence(next)).runner.generation, next.generation);
  } finally { await f.close(); }
});

databaseTest("R2 stop允许已投递轮次回复/ACK，但下一批消息保留pending", async (driver) => {
  const f = await fixture(driver);
  try {
    const managed = await f.managed(); await managed.join();
    const first = await f.humanMessage("当前工作");
    const delivery = await managed.call("wait_for_messages", { timeoutMs: 100 });
    assert.equal(delivery.status, "message"); assert.ok(delivery.messages?.some((m) => m.id === first.id));
    await f.runtime.intent(f.view.binding.id, "stop");
    assert.equal((await managed.call("send_message", { text: "当前轮次完成回复" })).ok, true);
    assert.equal((await managed.call("acknowledge_message", { messageId: first.id })).ok, true);
    const second = await f.humanMessage("下一批不能开始");
    const stopped = await managed.call("wait_for_messages", { timeoutMs: 100 });
    assert.equal(stopped.status, "cancelled");
    assert.equal((await f.repos.deliveries.get(first.id, f.view.binding.memberId))?.status, "acked");
    assert.equal((await f.repos.deliveries.get(second.id, f.view.binding.memberId))?.status, "pending");
  } finally { await f.close(); }
});

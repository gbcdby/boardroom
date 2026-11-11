import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import type { MemoryConfig } from "../src/shared/memory.ts";
import { registerMemoryRuntime, getMemoryRuntime, closeMemoryRuntime, scheduleMemoryReconciliation } from "../src/server/memory/runtime.ts";

async function fixture(config?: MemoryConfig) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-mcp-"));
  const db = createDbDriver({ dataDir: dir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db), logger = createLogger({ write: () => {} });
  const project = await repos.projects.create({ name: "记忆入口" });
  const group = await repos.groups.create({ projectId: project.id, name: "当前群" });
  registerMemoryRuntime(db, { database: { kind: "sqlite", sqlitePath: path.join(dir, "agent-studio.db") }, ...(config ? { config } : {}) });
  const core = createMcpCore({ db, logger });
  return { dir, db, repos, project, group, core, logger,
    async close() { await core.close(); await closeMemoryRuntime(db); await db.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("真实 MCP core 读写三层记忆并在 join/wait 安全点注入，单会话关闭不终止共享 reader", async () => {
  const f = await fixture();
  const other = createMcpCore({ db: f.db, logger: f.logger, memberKey: "second-core" });
  try {
    const joined = await f.core.join("worker", { displayName: "目标", hostType: "other", projectId: f.project.id, groupId: f.group.id });
    assert.equal(joined.context.memory?.state, "available");
    assert.deepEqual(joined.context.memory?.entries, []);
    await assert.rejects(f.core.memoryOperation("worker", "write", { scope: "project", expectedVersion: 0, clientMutationId: "denied", markdown: "不能写共享记忆" }), { code: "FORBIDDEN" });
    await f.core.memoryOperation("worker", "write", { scope: "global", expectedVersion: 0, clientMutationId: "global-1", markdown: "跨项目私有" });
    await f.core.memoryOperation("worker", "write", { scope: "project-agent", expectedVersion: 0, clientMutationId: "own-1", markdown: "项目内私有" });
    const next = await f.core.waitForMessages("worker", { timeoutMs: 10 });
    assert.equal(next.status, "timeout");
    assert.deepEqual(next.memory?.entries.map(entry => [entry.scope, entry.version, entry.markdown]), [
      ["global", 1, "跨项目私有"], ["project-agent", 1, "项目内私有"],
    ]);
    assert.equal((await f.core.waitForMessages("worker", { timeoutMs: 10 })).memory, undefined, "未变版本不重复注入");
    const secondProject = await f.repos.projects.create({ name: "第二个项目" });
    const secondGroup = await f.repos.groups.create({ projectId: secondProject.id, name: "第二个群" });
    const second = await other.join("worker", { displayName: "目标", hostType: "other", projectId: secondProject.id, groupId: secondGroup.id });
    assert.equal(second.agentId, joined.agentId);
    assert.deepEqual(second.context.memory?.entries.map(entry => entry.markdown), ["跨项目私有"]);
    await assert.rejects(f.core.memoryOperation("worker", "read", { scope: "project-agent", projectId: secondProject.id }), { code: "FORBIDDEN" });
    await f.core.close();
    const stillAvailable = await getMemoryRuntime(f.db).reader.readOwn({ projectId: secondProject.id, memberId: second.memberId, bindingGeneration: "second" });
    assert.equal(stillAvailable.state, "available");
    assert.equal(stillAvailable.entries[0]?.markdown, "跨项目私有");
  } finally { await other.close(); await f.close(); }
});

test("历史读取与直接 ACK 不伪造 MCP 投递，实际 wait 首次投递标记在重投后保持不变", async () => {
  const f = await fixture();
  try {
    const joined = await f.core.join("reader", { displayName: "接收者", hostType: "other", projectId: f.project.id, groupId: f.group.id });
    const human = await f.repos.members.create({ projectId: f.project.id, kind: "human", displayName: "人" });
    await f.repos.groups.addParticipant(f.group.id, human.id);
    const message = await f.repos.messages.create({ groupId: f.group.id, senderMemberId: human.id, body: "历史可见", mentions: [joined.memberId] });
    await f.repos.deliveries.ensure(message.id, joined.memberId);
    assert.equal((await f.core.readHistory("reader", {})).messages[0]?.id, message.id);
    assert.equal((await f.repos.deliveries.get(message.id, joined.memberId))?.firstMcpDeliveredAt, null);
    await f.core.acknowledgeMessage("reader", message.id);
    assert.equal((await f.repos.deliveries.get(message.id, joined.memberId))?.firstMcpDeliveredAt, null);
    const delivered = await f.repos.messages.create({ groupId: f.group.id, senderMemberId: human.id, body: "真实投递", mentions: [joined.memberId] });
    await f.repos.deliveries.ensure(delivered.id, joined.memberId);
    assert.deepEqual((await f.core.waitForMessages("reader", { timeoutMs: 10 })).messages.map(m => m.id), [delivered.id]);
    const first = (await f.repos.deliveries.get(delivered.id, joined.memberId))?.firstMcpDeliveredAt;
    assert.ok(first);
    await f.core.waitForMessages("reader", { timeoutMs: 10 });
    assert.equal((await f.repos.deliveries.get(delivered.id, joined.memberId))?.firstMcpDeliveredAt, first);
    await f.core.acknowledgeMessage("reader", delivered.id);
    assert.equal((await f.repos.deliveries.get(delivered.id, joined.memberId))?.firstMcpDeliveredAt, first);
  } finally { await f.close(); }
});

test("R-P4-C-REQ-001：投递事实写失败不成功出队；修复后重投仍能触发 N=1 总结", async () => {
  const f = await fixture({ ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1 });
  try {
    const joined = await f.core.join("reader", { displayName: "投递接收者", hostType: "other", projectId: f.project.id, groupId: f.group.id });
    const human = await f.repos.members.create({ projectId: f.project.id, kind: "human", displayName: "用户" });
    await f.repos.groups.addParticipant(f.group.id, human.id);
    const message = await f.repos.messages.create({ groupId: f.group.id, senderMemberId: human.id, body: "故障后不可丢来源", mentions: [joined.memberId] });
    await f.repos.deliveries.ensure(message.id, joined.memberId);
    await f.db.exec("CREATE TRIGGER reject_mcp_fact BEFORE UPDATE OF first_mcp_delivered_at ON message_deliveries BEGIN SELECT RAISE(ABORT, 'fixture_delivery_fact_failed'); END");
    await assert.rejects(f.core.waitForMessages("reader", { timeoutMs: 50 }));
    const failed = await f.repos.deliveries.get(message.id, joined.memberId);
    assert.equal(failed?.status, "pending"); assert.equal(failed?.firstMcpDeliveredAt, null);
    assert.equal(f.core.pendingWaitCount, 0);
    await f.db.exec("DROP TRIGGER reject_mcp_fact");
    const delivered = await f.core.waitForMessages("reader", { timeoutMs: 50 });
    assert.deepEqual(delivered.messages.map(row => row.id), [message.id]);
    await f.core.acknowledgeMessage("reader", message.id);
    await new Promise<void>(resolve => scheduleMemoryReconciliation(f.db, "test:confirmed-delivery", async () => { resolve(); }));
    assert.ok((await f.repos.deliveries.get(message.id, joined.memberId))?.firstMcpDeliveredAt);
    const requests = await f.repos.memory.listRequests(f.project.id, joined.agentId);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.messageIds, [message.id]);
  } finally { await f.close(); }
});

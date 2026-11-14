import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { newId } from "../src/server/db/ids.ts";
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
    const stillAvailable = await getMemoryRuntime(f.db).reader.readOwn({ projectId: secondProject.id, memberId: second.memberId, membershipRevision: (await f.repos.members.get(second.memberId))!.membershipRevision, bindingGeneration: "second" });
    assert.equal(stillAvailable.state, "available");
    assert.equal(stillAvailable.entries[0]?.markdown, "跨项目私有");
  } finally { await other.close(); await f.close(); }
});

for (const publishNewer of [false, true]) {
  test(`STD5-005：真实reader取材后wait失权不确认记忆，${publishNewer ? "也不覆盖期间已发布的新版本" : "重试仍携带未发布版本"}`, async () => {
    const f = await fixture();
    const runtime = getMemoryRuntime(f.db), readOwn = runtime.reader.readOwn.bind(runtime.reader);
    try {
      const identity = { displayName: "记忆接收者", hostType: "other", projectId: f.project.id, groupId: f.group.id };
      const joined = await f.core.join("reader", identity);
      assert.deepEqual(joined.context.memory?.entries, []);
      await f.core.memoryOperation("reader", "write", { scope: "global", expectedVersion: 0, clientMutationId: "publication-v1", markdown: "尚未兑现的版本一" });
      const sender = await f.repos.members.create({ projectId: f.project.id, kind: "human", displayName: "人" });
      await f.repos.groups.addParticipant(f.group.id, sender.id);
      const message = await f.repos.messages.create({ groupId: f.group.id, senderMemberId: sender.id, body: "通过任务关系可读", mentions: [] });
      const at = new Date().toISOString();
      const task = await f.repos.tasks.create({ id: newId(), projectId: f.project.id, title: "取材后撤权", body: "", deliveryKind: "code", acceptanceText: "", acceptanceSource: "explicit", labels: [], state: "todo",
        assigneeMemberId: joined.memberId, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1,
        currentReviewRoundId: null, blockedReason: null, author: { kind: "human", actorId: "human:local", displayName: "人" }, createdAt: at, updatedAt: at });
      await f.repos.tasks.linkMessage(f.project.id, { taskId: task.id, messageId: message.id, groupId: f.group.id, createdAt: at });
      let shifted = false;
      runtime.reader.readOwn = async input => {
        const result = await readOwn(input);
        if (!shifted) {
          shifted = true;
          assert.equal(f.db.currentTransactionContext(), undefined, "真实只读子进程取材后不占业务事务");
          assert.equal(result.entries[0]?.version, 1);
          await f.repos.tasks.updateCas(f.project.id, task.id, 1, { assigneeMemberId: sender.id }, at);
          if (publishNewer) {
            await f.core.memoryOperation("reader", "write", { scope: "global", expectedVersion: 1, clientMutationId: "publication-v2", markdown: "已经由join兑现的版本二" });
            const newer = await f.core.join("reader", identity);
            assert.equal(newer.context.memory?.entries[0]?.version, 2);
          }
        }
        return result;
      };
      const cancelled = await f.core.waitForMessages("reader", { timeoutMs: 1000 });
      assert.equal(shifted, true);
      assert.equal(cancelled.status, "cancelled"); assert.deepEqual(cancelled.messages, []);
      assert.equal(cancelled.memory?.state, "unavailable");
      runtime.reader.readOwn = readOwn;
      await f.repos.tasks.updateCas(f.project.id, task.id, 2, { assigneeMemberId: joined.memberId }, at);
      const retry = await f.core.waitForMessages("reader", { timeoutMs: 1000 });
      assert.equal(retry.status, "message"); assert.equal(retry.messages[0]?.id, message.id);
      if (publishNewer) assert.equal(retry.memory, undefined, "取消旧wait不能覆盖join已发布的v2指纹");
      else assert.deepEqual(retry.memory?.entries.map(entry => [entry.version, entry.markdown]), [[1, "尚未兑现的版本一"]]);
      await f.core.acknowledgeMessage("reader", message.id);
      assert.equal((await f.core.waitForMessages("reader", { timeoutMs: 10 })).memory, undefined, "成功兑现后仍抑制未变记忆");
    } finally { runtime.reader.readOwn = readOwn; await f.close(); }
  });
}

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

for (const revoke of ["member", "group"] as const) {
  test(`R-P4-C-S-002：真实 reader 返回前撤销${revoke}访问后不附带私有正文`, async () => {
    const f = await fixture();
    const runtime = getMemoryRuntime(f.db), read = runtime.reader.readOwn.bind(runtime.reader);
    let gated = false, observed!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { observed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    runtime.reader.readOwn = async binding => {
      const result = await read(binding);
      if (gated) { observed(); await gate; }
      return result;
    };
    try {
      const joined = await f.core.join("reader", { displayName: "并发失权成员", hostType: "other", projectId: f.project.id, groupId: f.group.id });
      const canary = "private-memory-after-revocation";
      await f.core.memoryOperation("reader", "write", { scope: "global", expectedVersion: 0, clientMutationId: "canary", markdown: canary });
      await new Promise<void>(resolve => scheduleMemoryReconciliation(f.db, "test:before-revocation", async () => { resolve(); }));
      gated = true;
      const waiting = f.core.waitForMessages("reader", { timeoutMs: 5 });
      watchdog = setTimeout(release, 3000);
      await ready;
      if (revoke === "member") await f.repos.members.setStatus(joined.memberId, "disabled");
      else await f.repos.groups.removeParticipant(f.group.id, joined.memberId);
      release();
      const result = await waiting;
      assert.equal(result.memory?.state, "unavailable");
      assert.deepEqual(result.memory?.entries, []);
      assert.ok(!JSON.stringify(result).includes(canary));
      if (revoke === "member") await assert.rejects(f.core.memoryOperation("reader", "read", { scope: "global" }), { code: "FORBIDDEN" });
      else await assert.rejects(f.core.readHistory("reader", {}), { code: "FORBIDDEN" });
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release(); runtime.reader.readOwn = read; await f.close();
    }
  });
}

for (const revoke of ["group", "member", "group-archive"] as const) {
  test(`#157 join 真实reader返回前${revoke}变化：按当前context兑现或拒绝，不泄漏旧正文`, async () => {
    const f = await fixture();
    const runtime = getMemoryRuntime(f.db), read = runtime.reader.readOwn.bind(runtime.reader);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const identity = { displayName: "入群最终观察", hostType: "other", projectId: f.project.id, groupId: f.group.id };
      const joined = await f.core.join("observer", identity);
      const canary = "join-private-memory-must-not-leak";
      await f.core.memoryOperation("observer", "write", { scope: "global", expectedVersion: 0, clientMutationId: "join-canary", markdown: canary });
      await new Promise<void>(resolve => scheduleMemoryReconciliation(f.db, "test:before-join-revocation", async () => { resolve(); }));
      runtime.reader.readOwn = async binding => { const result = await read(binding); entered(); await gate; return result; };
      const pending = f.core.join("observer", identity).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
      watchdog = setTimeout(release, 3000);
      await ready;
      if (revoke === "group") await f.repos.groups.removeParticipant(f.group.id, joined.memberId);
      else if (revoke === "member") await f.repos.members.setStatus(joined.memberId, "disabled");
      else await f.repos.groups.archive(f.group.id);
      release();
      const result = await pending;
      if (revoke === "group") {
        assert.equal(result.error, undefined);
        assert.equal(result.value!.context.visibility.scope, "none");
        assert.deepEqual(result.value!.context.participants, []);
        assert.deepEqual(result.value!.context.memory?.entries, []);
        assert.ok(!JSON.stringify(result.value).includes(canary));
        runtime.reader.readOwn = read;
        await f.repos.groups.addParticipant(f.group.id, joined.memberId);
        const restored = await f.core.waitForMessages("observer", { timeoutMs: 10 });
        assert.equal(restored.memory?.entries[0]?.markdown, canary, "未兑现版本不能被旧join的指纹吞掉");
      } else {
        assert.equal((result.error as { code?: string })?.code, "FORBIDDEN");
        assert.equal(result.value, undefined);
      }
    } finally { if (watchdog) clearTimeout(watchdog); release(); runtime.reader.readOwn = read; await f.close(); }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Task, WorkEvent } from "../src/shared/tasks.ts";
import type { MemorySummaryPacket } from "../src/shared/memory.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import { WriteFailedError } from "../src/server/db/errors.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const at = "2026-11-11T02:00:00.000Z";
const reader = { readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: 8192 }), close: async () => {} };

for (const engine of ["sqlite", "postgres"] as const) {
  const gating = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} AC-MEM-04 N=1：历史读取+ACK 不生成收据，真实 MCP 标记只补偿一次`, gating, async () => memoryFixture(async (repos, db) => {
    const p = await memoryPeople(repos);
    const visible = async (_access: unknown, ids: readonly string[]) => (await Promise.all(ids.map(id => repos.messages.get(id))))
      .flatMap(message => message ? [{ id: message.id, groupId: message.groupId, text: message.body, createdAt: message.createdAt }] : []);
    const create = () => createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1 }, injectionReader: reader, readVisibleMessages: visible });
    const first = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.outsider.id, body: "只读历史" });
    await repos.deliveries.ensure(first.id, p.member.id);
    assert.ok(await repos.messages.get(first.id));
    await repos.deliveries.recordAttempt(first.id, p.member.id, "acked", at);
    assert.ok((await repos.deliveries.get(first.id, p.member.id))!.firstDeliveredAt);
    assert.equal((await repos.deliveries.get(first.id, p.member.id))!.firstMcpDeliveredAt, null);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    assert.equal((await repos.memory.listRequests(p.project.id, p.agent.id)).length, 0);
    const second = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.outsider.id, body: "实际投递事实" });
    await repos.deliveries.markMcpDelivered(second.id, p.member.id, at);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 1 });
    await repos.deliveries.recordAttempt(second.id, p.member.id, "acked", at);
    await repos.deliveries.markMcpDelivered(second.id, p.member.id, at);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    const requests = await repos.memory.listRequests(p.project.id, p.agent.id);
    assert.equal(requests.length, 1); assert.equal(requests[0]!.trigger, "message_threshold");
    assert.deepEqual(requests[0]!.messageIds, [second.id]);
    assert.deepEqual(await db.query("SELECT message_id FROM memory_message_receipts"), [{ message_id: second.id }]);
  }, engine));

  test(`${engine} R-P4-S-001/AC-MEM-06：不可见前缀不饿死、重启续游标、固定上界与恢复权限回访`, gating, async () => memoryFixture(async (repos, db) => {
    const p = await memoryPeople(repos); const shown = new Set<string>(); const messages = new Map<string, MemorySummaryPacket["messages"][number]>();
    const makeMessage = async (index: number, text = `消息 ${index}`) => {
      const message = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.outsider.id, body: text });
      const markedAt = new Date(Date.parse(at) + index * 1000).toISOString();
      await repos.deliveries.markMcpDelivered(message.id, p.member.id, markedAt);
      messages.set(message.id, { id: message.id, groupId: message.groupId, text: message.body, createdAt: message.createdAt }); return message.id;
    };
    const prefix: string[] = []; for (let i = 0; i < 50; i++) prefix.push(await makeMessage(i));
    const last = await makeMessage(50, "👩🏽‍💻".repeat(100)); shown.add(last);
    const create = () => createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1, summaryInputBytes: 1024 }, injectionReader: reader,
      readVisibleMessages: async (_access, ids) => ids.filter(id => shown.has(id)).map(id => messages.get(id)!) });
    const scope = { kind: "message_threshold" as const, projectId: p.project.id, agentId: p.agent.id, groupId: p.group.id };
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    const first = await repos.memory.getScanCheckpoint(scope);
    assert.ok(first.after); assert.ok(first.through); assert.equal(first.sweep, 1);
    assert.equal((await db.query("SELECT * FROM memory_message_receipts")).length, 0);
    const late = await makeMessage(51); shown.add(late);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 1 }, "重启后只完成原固定上界内的末行");
    const second = await repos.memory.getScanCheckpoint(scope);
    assert.equal(second.after, null); assert.equal(second.through, null);
    const cRequest = (await repos.memory.listRequests(p.project.id, p.agent.id))[0]!;
    assert.deepEqual(cRequest.messageIds, [last]);
    shown.add(prefix[0]!);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 1 }, "下一 sweep 回访权限已恢复的前缀");
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 1 }, "下一页才纳入新到达的末行");
    assert.equal((await db.query("SELECT * FROM memory_message_receipts")).length, 3);
    const packet = await create().readSummaryPacket(p.own, cRequest.id);
    assert.equal(packet.partialInput, true); assert.equal(packet.messages.length, 1);
    assert.ok(Buffer.byteLength(packet.messages[0]!.text) <= 1024);
    assert.equal(packet.messages[0]!.text, "👩🏽‍💻".repeat(packet.messages[0]!.text.length / "👩🏽‍💻".length));
    shown.delete(last);
    const revoked = await create().readSummaryPacket(p.own, cRequest.id);
    assert.deepEqual(revoked.messages, []); assert.equal(revoked.partialInput, true);
    await repos.groups.removeParticipant(p.group.id, p.member.id);
    await assert.rejects(create().readSummaryPacket(p.own, cRequest.id), { name: "ForbiddenError" });
    const before = await repos.memory.getScanCheckpoint(scope);
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    assert.deepEqual(await repos.memory.getScanCheckpoint(scope), before, "失去群权限暂停 scope，不推进 cursor");
  }, engine));

  test(`${engine} AC-MEM-07：触发页失败使收据/计数/request/event/checkpoint 一起回滚`, gating, async () => memoryFixture(async (repos, db) => {
    const p = await memoryPeople(repos);
    const message = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.outsider.id, body: "事务失败后的已提交聊天" });
    await repos.deliveries.markMcpDelivered(message.id, p.member.id, at);
    const service = createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1 }, injectionReader: reader,
      readVisibleMessages: async (_access, ids) => ids.includes(message.id) ? [{ id: message.id, groupId: message.groupId, text: message.body, createdAt: message.createdAt }] : [] });
    const checkpoint = repos.memory.updateScanCheckpointCas;
    repos.memory.updateScanCheckpointCas = async () => { throw new WriteFailedError("checkpoint failed"); };
    assert.deepEqual(await service.reconcileTriggers(p.own), { scheduled: 0 });
    for (const table of ["memory_message_receipts", "memory_trigger_counters", "memory_summary_requests", "memory_scan_checkpoints", "work_events"]) {
      assert.equal(Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n), 0, table);
    }
    assert.equal((await repos.messages.get(message.id))?.body, message.body);
    repos.memory.updateScanCheckpointCas = checkpoint;
    assert.deepEqual(await service.reconcileTriggers(p.own), { scheduled: 1 });
    assert.equal((await repos.memory.listRequests(p.project.id, p.agent.id)).length, 1);
  }, engine));

  test(`${engine} R-P4-S-002：任务通知已 ACK 后重启补偿，来源重开持久取消且不重复物化`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const task: Task = { id: randomUUID(), projectId: p.project.id, title: "完成任务", body: "固定任务事实", deliveryKind: "code", acceptanceText: "固定任务事实", acceptanceSource: "explicit", labels: [], state: "done", assigneeMemberId: p.member.id,
      reviewerMemberId: p.outsider.id, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null,
      author: { kind: "human", actorId: "owner", displayName: "人" }, createdAt: at, updatedAt: at };
    await repos.tasks.create(task);
    const source: WorkEvent = { id: randomUUID(), projectId: p.project.id, recipientMemberId: p.member.id, taskId: task.id,
      kind: "task.review_decided", eventKey: `done:${task.id}:1`, payload: { enteredDone: true, completionRevision: 1, assigneeAgentId: p.agent.id },
      deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null };
    await repos.tasks.enqueueWorkEvent(source);
    const create = () => createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const insert = repos.memory.createRequest;
    repos.memory.createRequest = async () => { throw new WriteFailedError("schedule failed"); };
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    await repos.tasks.acknowledgeWorkEvent(p.project.id, p.member.id, source.id, at);
    assert.deepEqual(await repos.tasks.listUnackedWorkEvents(p.project.id, p.member.id), []);
    repos.memory.createRequest = insert;
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 1 });
    const request = (await repos.memory.listRequests(p.project.id, p.agent.id))[0]!;
    assert.equal(request.sourceWorkEventId, source.id); assert.equal(request.completedTaskRevision, 1); assert.equal(request.contextGroupId, null);
    assert.deepEqual((await create().readSummaryPacket(p.own, request.id)).task, { id: task.id, title: task.title, body: task.body, revision: 1 });
    await repos.tasks.updateCas(p.project.id, task.id, 1, { state: "in-progress" }, at);
    await assert.rejects(create().beginSummary(p.own, request.id, { expectedRevision: 1, clientMutationId: "begin" }), { reason: "memory_summary_source_changed" });
    assert.equal((await repos.memory.getRequest(request.id))!.state, "cancelled");
    assert.deepEqual(await create().reconcileTriggers(p.own), { scheduled: 0 });
    assert.equal((await repos.memory.listRequests(p.project.id, p.agent.id)).length, 1);
    await assert.rejects(create().retrySummary(p.owner, request.id, "retry"), { reason: "memory_summary_source_changed" });
    await repos.tasks.updateCas(p.project.id, task.id, 2, { state: "done" }, at);
    const retry = await create().retrySummary(p.owner, request.id, "retry");
    assert.equal(retry.completedTaskRevision, 3); assert.equal(retry.retryOfRequestId, request.id);
  }, engine));

  test(`${engine} AC-MEM-07：自动安全点仅清理有界过期请求，不改其他群的执行`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); let now = new Date(at);
    const service = createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, summaryAttemptTimeoutMs: 30_000 }, now: () => now,
      injectionReader: reader, readVisibleMessages: async () => [] });
    const own = { ...p.own, injectionBindingGeneration: "timeout-session" };
    const req = await service.reportSessionEnd(own, "end");
    const running = await service.beginSummary(own, req.requestId!, { expectedRevision: 1, clientMutationId: "begin" });
    now = new Date(now.getTime() + 30_001);
    const list = repos.memory.listRequests; let bounded = false;
    repos.memory.listRequests = async (projectId, agentId, state, query) => {
      if (query) { bounded = true; assert.equal(state, "running"); assert.equal(query.limit, 50); assert.ok(query.startedBefore); assert.equal(query.contextGroupId, p.group.id); }
      return list(projectId, agentId, state, query);
    };
    assert.deepEqual(await service.reconcileTriggers(own), { scheduled: 0 }); assert.equal(bounded, true);
    assert.equal((await repos.memory.getRequest(running.id))?.state, "failed");
    assert.equal((await repos.memory.getRequest(running.id))?.error?.code, "memory_summary_timeout");
  }, engine));
}

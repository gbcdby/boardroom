import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { MemoryKey, SelfSummaryEvidence } from "../src/shared/memory.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMemoryService, type MemoryAccess } from "../src/server/memory/service.ts";
import { WriteFailedError } from "../src/server/db/errors.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const reader = { readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: 8192 }), close: async () => {} };
const start = "2026-11-11T01:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// 协议测试的明确声明，不把固定文本当作 AC-MEM-04 的真实模型证据。
function declared(markdown: string): SelfSummaryEvidence {
  return { provenance: "agent-declared", host: "protocol-test", hostVersion: "fixture", invocationId: "fixture-invocation",
    contextId: "target-context", startedAt: start, completedAt: "2026-11-11T01:00:01.000Z",
    promptSha256: sha("authorized fixture context"), outputSha256: sha(markdown), evidenceRef: "fixture:protocol-only" };
}
function bound(access: MemoryAccess, generation = "session-1"): MemoryAccess { return { ...access, injectionBindingGeneration: generation }; }

for (const engine of ["sqlite", "postgres"] as const) {
  const gating = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} AC-MEM-04/05：session-end 持久化、通知 ACK 不是执行、目标独占与完成幂等`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); const access = bound(p.own); const events: string[] = [];
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, now: () => new Date(start), injectionReader: reader,
      readVisibleMessages: async () => [], onWorkEvents: work => { events.push(...work.map(e => e.id)); } });
    assert.deepEqual(await service.reportSessionEnd(p.own, "missing-binding"), { summaryScheduled: false, requestId: null, errorCode: "memory_binding_unavailable" });
    const scheduled = await service.reportSessionEnd(access, "end");
    assert.equal(scheduled.summaryScheduled, true); assert.ok(scheduled.requestId);
    assert.deepEqual(await service.reportSessionEnd(access, "end"), scheduled); assert.equal(events.length, 1);
    const request = (await service.listSummaryRequests(access, p.project.id))[0]!;
    assert.equal(request.state, "pending"); assert.equal(request.revision, 1); assert.equal(request.baseVersion, 0);
    assert.equal(request.contextGroupId, p.group.id); assert.equal(request.evidence, null);
    const event = (await repos.tasks.listUnackedWorkEvents(p.project.id, p.member.id, 100, { contextGroupId: p.group.id }))[0]!;
    assert.equal(event.kind, "memory.summary_requested"); assert.equal(event.payload.requestId, request.id);
    await repos.tasks.acknowledgeWorkEvent(p.project.id, p.member.id, event.id, start, { contextGroupId: p.group.id });
    assert.equal((await service.listSummaryRequests(access, p.project.id))[0]!.state, "pending");
    for (const wrong of [p.owner, bound(p.foreign)]) {
      await assert.rejects(service.readSummaryPacket(wrong, request.id), { name: "ForbiddenError" });
      await assert.rejects(service.beginSummary(wrong, request.id, { expectedRevision: 1, clientMutationId: "forged" }), { name: "ForbiddenError" });
    }
    const before = await repos.memory.getRequest(request.id);
    const packet = await service.readSummaryPacket(access, request.id);
    assert.equal(packet.currentMemory, null); assert.deepEqual(packet.messages, []);
    assert.deepEqual(await repos.memory.getRequest(request.id), before, "只读 packet 不推进状态");
    const begun = await service.beginSummary(access, request.id, { expectedRevision: 1, clientMutationId: "begin" });
    assert.equal(begun.state, "running"); assert.equal(begun.revision, 2); assert.ok(begun.attemptId);
    assert.deepEqual(await service.beginSummary(access, request.id, { expectedRevision: 1, clientMutationId: "begin" }), begun);
    await assert.rejects(service.beginSummary(access, request.id, { expectedRevision: 2, clientMutationId: "second-model" }), { reason: "memory_summary_state_conflict" });
    const markdown = "# 当前项目\n保留用户确认事实，记录已完成的工作。";
    const evidence = declared(markdown);
    const input = { expectedRequestRevision: begun.revision, attemptId: begun.attemptId!, markdown, evidence };
    const result = await service.submitSummary(access, request.id, input);
    assert.equal(result.document.version, 1); assert.equal(result.document.source, "self-summary");
    assert.equal(result.writtenVersion.summaryRequestId, request.id); assert.equal(result.duplicate, false);
    const complete = (await repos.memory.getRequest(request.id))!;
    assert.equal(complete.state, "completed"); assert.equal(complete.revision, 3); assert.deepEqual(complete.evidence, evidence);
    assert.equal(complete.resultSha256, sha(markdown)); assert.equal(complete.resultVersion, 1);
    assert.equal((await service.submitSummary(access, request.id, input)).duplicate, true);
    await assert.rejects(service.submitSummary(access, request.id, { ...input, markdown: "different", evidence: declared("different") }), { reason: "memory_summary_result_conflict" });
    assert.deepEqual(await repos.memory.getRequest(request.id), complete, "终态证据不可改写");
    assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.member.id, 100, { contextGroupId: p.group.id })).length, 0);
    await assert.rejects(service.retrySummary(p.owner, request.id, "retry-complete"), { reason: "memory_summary_not_retryable" });
    const key: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    await service.write(p.owner, key, { expectedVersion: 1, clientMutationId: "manual-after", markdown: "后续人工修订" });
    const replay = await service.submitSummary(access, request.id, input);
    assert.equal(replay.document.version, 2); assert.equal(replay.writtenVersion.version, 1);
    assert.equal(JSON.stringify(await repos.audit.list(p.project.id)).includes(markdown), false);
    const freshSession = await service.reportSessionEnd(bound(p.own, "session-2"), "end");
    assert.notEqual(freshSession.requestId, request.id);
  }, engine));

  test(`${engine} AC-MEM-05/07：人工抢先保留 conflicted，retry 新请求新基准，超时终态不复活`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); const access = bound(p.own); let at = new Date(start);
    const service = createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, summaryAttemptTimeoutMs: 30_000 }, now: () => at,
      injectionReader: reader, readVisibleMessages: async () => [] });
    const key: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    await service.write(p.owner, key, { expectedVersion: 0, clientMutationId: "baseline", markdown: "人工基线" });
    const scheduled = await service.reportSessionEnd(access, "end");
    const begin = await service.beginSummary(access, scheduled.requestId!, { expectedRevision: 1, clientMutationId: "begin" });
    await service.write(p.owner, key, { expectedVersion: 1, clientMutationId: "manual", markdown: "用户已更正" });
    const markdown = "迟到的旧输出";
    await assert.rejects(service.submitSummary(access, begin.id, { expectedRequestRevision: begin.revision, attemptId: begin.attemptId!, markdown, evidence: declared(markdown) }), { reason: "memory_version_conflict" });
    const old = (await repos.memory.getRequest(begin.id))!;
    assert.equal(old.state, "conflicted"); assert.equal(old.evidence, null); assert.equal(old.resultVersion, null);
    assert.equal((await service.read(p.owner, key)).document?.markdown, "用户已更正");
    const retry = await service.retrySummary(p.owner, old.id, "retry");
    assert.equal(retry.baseVersion, 2); assert.equal(retry.retryOfRequestId, old.id); assert.equal(retry.state, "pending");
    assert.deepEqual(await service.retrySummary(p.owner, old.id, "retry"), retry);
    assert.deepEqual(await repos.memory.getRequest(old.id), old);
    const retryBegin = await service.beginSummary(access, retry.id, { expectedRevision: 1, clientMutationId: "new-model" });
    assert.notEqual(retryBegin.attemptId, begin.attemptId);
    at = new Date(at.getTime() + 30_001);
    await assert.rejects(service.submitSummary(access, retry.id, { expectedRequestRevision: retryBegin.revision, attemptId: retryBegin.attemptId!, markdown, evidence: declared(markdown) }), { reason: "memory_summary_timeout" });
    assert.equal((await repos.memory.getRequest(retry.id))!.state, "failed");
    await assert.rejects(service.submitSummary(access, retry.id, { expectedRequestRevision: retryBegin.revision + 1, attemptId: retryBegin.attemptId!, markdown, evidence: declared(markdown) }), { reason: "memory_summary_state_conflict" });
    assert.equal((await service.history(p.owner, key)).length, 2);
  }, engine));

  test(`${engine} AC-MEM-07/§11：完成请求写失败/通知 ACK 失败均回滚正文版本和证据`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); const access = bound(p.own);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, now: () => new Date(start), injectionReader: reader, readVisibleMessages: async () => [] });
    const scheduled = await service.reportSessionEnd(access, "end");
    const begun = await service.beginSummary(access, scheduled.requestId!, { expectedRevision: 1, clientMutationId: "begin" });
    const markdown = "不能部分完成";
    const input = { expectedRequestRevision: begun.revision, attemptId: begun.attemptId!, markdown, evidence: declared(markdown) };
    await assert.rejects(service.submitSummary(access, begun.id, { ...input, evidence: { ...input.evidence, outputSha256: "a".repeat(64) } }), { reason: "memory_invalid_evidence" });
    const update = repos.memory.updateRequestCas;
    repos.memory.updateRequestCas = async (id, version, patch) => { if (patch.state === "completed") throw new WriteFailedError("completion failed"); return update(id, version, patch); };
    await assert.rejects(service.submitSummary(access, begun.id, input), { code: "write_failed" });
    repos.memory.updateRequestCas = update;
    const key: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    assert.equal((await service.read(p.owner, key)).document, null); assert.deepEqual(await service.history(p.owner, key), []);
    assert.deepEqual(await repos.memory.getRequest(begun.id), begun);
    const ack = repos.tasks.acknowledgeWorkEvent;
    repos.tasks.acknowledgeWorkEvent = async () => { throw new WriteFailedError("ack failed"); };
    await assert.rejects(service.submitSummary(access, begun.id, input), { code: "write_failed" });
    repos.tasks.acknowledgeWorkEvent = ack;
    assert.equal((await service.read(p.owner, key)).document, null); assert.deepEqual(await repos.memory.getRequest(begun.id), begun);
    assert.equal((await service.submitSummary(access, begun.id, input)).writtenVersion.version, 1);
  }, engine));

  test(`${engine} AC-MEM-05/07：两个自动结果竞争时一份完成、一份持久冲突，不覆盖胜出版本`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); const access = bound(p.own);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, now: () => new Date(start), injectionReader: reader, readVisibleMessages: async () => [] });
    const a = await service.reportSessionEnd(access, "end-a"); const b = await service.reportSessionEnd(access, "end-b");
    const begun = await Promise.all([a, b].map(result => service.beginSummary(access, result.requestId!, { expectedRevision: 1, clientMutationId: "begin" })));
    const settled = await Promise.allSettled(begun.map((request, index) => {
      const markdown = `独立结果 ${index}`;
      return service.submitSummary(access, request.id, { expectedRequestRevision: request.revision, attemptId: request.attemptId!, markdown, evidence: declared(markdown) });
    }));
    assert.equal(settled.filter(row => row.status === "fulfilled").length, 1);
    const states = (await Promise.all(begun.map(request => repos.memory.getRequest(request.id)))).map(request => request!.state).sort();
    assert.deepEqual(states, ["completed", "conflicted"]);
    const versions = await service.history(p.owner, { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id });
    assert.equal(versions.length, 1); assert.equal(versions[0]!.version, 1);
  }, engine));

  test(`${engine} AC-MEM-06/07：当前群组/成员权限重查、失败重放与调度失败不留下半个请求`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos); const access = bound(p.own); let at = new Date(start);
    const service = createMemoryService({ repos, config: { ...DEFAULT_MEMORY_CONFIG, summaryAttemptTimeoutMs: 30_000 }, now: () => at,
      injectionReader: reader, readVisibleMessages: async () => [] });
    const enqueue = repos.tasks.enqueueWorkEvent;
    repos.tasks.enqueueWorkEvent = async () => { throw new WriteFailedError("enqueue failed"); };
    const failedSchedule = await service.reportSessionEnd(access, "end");
    assert.equal(failedSchedule.summaryScheduled, false); assert.equal(failedSchedule.errorCode, "memory_write_failed");
    assert.equal((await repos.memory.listRequests(p.project.id, p.agent.id)).length, 0);
    assert.equal((await repos.audit.list(p.project.id)).length, 0);
    repos.tasks.enqueueWorkEvent = enqueue;
    const scheduled = await service.reportSessionEnd(access, "end");
    const otherGroup = await repos.groups.create({ projectId: p.project.id, name: "另一个群", participantMemberIds: [p.member.id] });
    const wrongGroup = { ...access, connection: { ...access.connection!, groupId: otherGroup.id } };
    await assert.rejects(service.readSummaryPacket(wrongGroup, scheduled.requestId!), { name: "ForbiddenError" });
    await assert.rejects(service.beginSummary(wrongGroup, scheduled.requestId!, { expectedRevision: 1, clientMutationId: "begin" }), { name: "ForbiddenError" });
    assert.deepEqual(await service.listSummaryRequests(wrongGroup, p.project.id), []);
    const begun = await service.beginSummary(access, scheduled.requestId!, { expectedRevision: 1, clientMutationId: "begin" });
    at = new Date(at.getTime() + 30_001);
    await service.readSummaryPacket(access, begun.id);
    assert.deepEqual(await repos.memory.getRequest(begun.id), begun, "纯 packet 读取不擅自提交 timeout");
    const failed = await service.failSummary(access, begun.id, { expectedRevision: begun.revision, attemptId: begun.attemptId!, code: "model_failed" });
    assert.equal(failed.state, "failed"); assert.equal(failed.error?.code, "memory_summary_timeout");
    const retry = await service.retrySummary(p.owner, failed.id, "retry");
    const fresh = await service.beginSummary(access, retry.id, { expectedRevision: 1, clientMutationId: "new-model" });
    const reported = await service.failSummary(access, fresh.id, { expectedRevision: fresh.revision, attemptId: fresh.attemptId!, code: "model_failed" });
    assert.equal(reported.state, "failed"); assert.equal(reported.evidence, null);
    assert.deepEqual(await service.failSummary(access, fresh.id, { expectedRevision: fresh.revision, attemptId: fresh.attemptId!, code: "model_failed" }), reported);
    await repos.members.setStatus(p.member.id, "disabled");
    await assert.rejects(service.readSummaryPacket(access, fresh.id), { name: "ForbiddenError" });
    await assert.rejects(service.retrySummary(p.owner, failed.id, "inactive"), { reason: "memory_summary_target_inactive" });
    assert.equal((await service.listSummaryRequests(p.owner, p.project.id, p.agent.id)).length, 2);
  }, engine));
}

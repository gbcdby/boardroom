import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Task } from "../src/shared/tasks.ts";
import type { MemorySummaryRequest } from "../src/shared/memory.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const at = "2026-11-11T03:00:00.000Z";
for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} S5-AUDIT-07：任务/设置补偿可恢复disabled引用但不恢复执行，revision始终向前`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const task: Task = { id: randomUUID(), projectId: p.project.id, title: "补偿任务", body: "历史任务投影", labels: [], state: "blocked",
      assigneeMemberId: null, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null,
      blockedReason: "member_removed", author: { kind: "human", actorId: "owner", displayName: "人" }, createdAt: at, updatedAt: at };
    await repos.tasks.create(task); await repos.members.setStatus(p.member.id, "disabled");
    await assert.rejects(repos.tasks.updateCas(p.project.id, task.id, 1, { assigneeMemberId: p.member.id }, at), { code: "invalid_reference" });
    const restored = await repos.tasks.updateLifecycleCas(p.project.id, task.id, 1, { assigneeMemberId: p.member.id,
      reviewerMemberId: p.outsider.id, state: "blocked", blockedReason: "member_inactive" }, at);
    assert.equal(restored.revision, 2); assert.equal(restored.assigneeMemberId, p.member.id); assert.equal(restored.state, "blocked");
    await assert.rejects(repos.tasks.updateLifecycleCas(p.project.id, task.id, 2, { state: "in-progress" }, at), { code: "invalid_reference" });
    await assert.rejects(repos.tasks.updateLifecycleCas(p.project.id, task.id, 1, { assigneeMemberId: null }, at), { code: "conflict" });
    await assert.rejects(repos.tasks.setSettings(p.project.id, 0, p.member.id), { code: "invalid_reference" });
    const settings = await repos.tasks.setSettingsLifecycleCas(p.project.id, 0, p.member.id);
    assert.equal(settings.revision, 1); assert.equal(settings.defaultReviewerMemberId, p.member.id); assert.equal(settings.reviewerValid, false);
    const cleared = await repos.tasks.setSettingsLifecycleCas(p.project.id, settings.revision, null);
    assert.equal(cleared.revision, 2);
    const done = await repos.tasks.create({ ...task, id: randomUUID(), state: "done", blockedReason: null });
    assert.equal((await repos.tasks.updateLifecycleCas(p.project.id, done.id, 1, { assigneeMemberId: p.member.id }, at)).state, "done");
    await repos.mutations.run({ projectIds: [p.project.id], discover: async () => ({ memberIds: [p.member.id], groupIds: [], runtimeIds: [] }) }, async () => {
      const member = (await repos.members.get(p.member.id))!;
      await repos.members.applyLifecycleCas(p.project.id, member.id, member.membershipRevision,
        { displayName: member.displayName, status: "disabled", nodeId: null, role: "normal", removedAt: at }, at);
      const detached = await repos.tasks.updateLifecycleCas(p.project.id, task.id, 2, { assigneeMemberId: null, state: "blocked", blockedReason: "member_removed" }, at);
      assert.equal(detached.revision, 3);
      await assert.rejects(repos.tasks.updateLifecycleCas(p.project.id, task.id, 3, { assigneeMemberId: p.member.id }, at), { code: "invalid_reference" });
      await assert.rejects(repos.tasks.setSettingsLifecycleCas(p.project.id, 2, p.member.id), { code: "invalid_reference" });
    });
    assert.equal((await repos.tasks.get(p.project.id, task.id))!.revision, 3);
  }, engine));

  test(`${engine} S5-AUDIT-07：成员removed后内部摘要取消仍精确CAS，终态证据不伪造不恢复`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const request: MemorySummaryRequest = { id: randomUUID(), projectId: p.project.id, agentId: p.agent.id, recipientMemberId: p.member.id,
      contextGroupId: p.group.id, documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: "old-session",
      taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null, beginMutationId: null,
      resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
    await repos.memory.createRequest(request);
    await repos.mutations.run({ projectIds: [p.project.id], discover: async () => ({ memberIds: [p.member.id], groupIds: [p.group.id], runtimeIds: [] }) }, async () => {
      const member = (await repos.members.get(p.member.id))!;
      await repos.members.applyLifecycleCas(p.project.id, member.id, member.membershipRevision,
        { displayName: member.displayName, status: "disabled", nodeId: null, role: "normal", removedAt: at }, at);
      await repos.memory.cancelForMemberLifecycleCas(p.project.id, p.member.id, request.id, request.revision, at);
      const cancelled = (await repos.memory.getRequest(request.id))!;
      assert.equal(cancelled.revision, 2); assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.evidence, null);
    });
    await assert.rejects(repos.memory.updateRequestCas(request.id, 2, { state: "pending" }), { code: "conflict" });
    await assert.rejects(repos.memory.cancelForMemberLifecycleCas(p.project.id, p.member.id, request.id, 2, at), { code: "conflict" });
    assert.equal((await repos.memory.getRequest(request.id))!.revision, 2);
  }, engine));
}

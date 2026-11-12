import test from "node:test";
import assert from "node:assert/strict";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";
import { createTaskService, type TaskService } from "../src/server/tasks/service.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { WriteFailedError } from "../src/server/db/errors.ts";
import { TaskError } from "../src/server/tasks/errors.ts";
import type { ReviewCandidate, ReviewEvidence, WorkEvent } from "../src/shared/tasks.ts";

// 完成态由真实任务领域链建立；Git 与模型内容是明确声明的协议 fixture。
const candidate: ReviewCandidate = { repositoryRoot: "/fixture", fixedPointInput: "base", baseCommit: "a".repeat(40),
  candidateCommit: "b".repeat(40), policy: "committed-clean", gitVersion: "reopen-protocol-fixture", diff: "+ verified",
  diffSha256: "c".repeat(64), commits: [], commands: [], capturedAt: "2026-11-11T00:00:00.000Z" };
function evidence(axis: string): ReviewEvidence {
  const startedAt = "2026-11-11T00:00:00.000Z", completedAt = "2026-11-11T00:01:00.000Z";
  return { provenance: "reviewer-declared", host: "protocol-fixture", hostVersion: "not-real-model", parentRunId: "reopen-round",
    invocationId: axis, contextId: axis, startedAt, completedAt,
    command: { argv: ["fixture"], cwd: "/fixture", startedAt, completedAt, exitCode: 0 }, promptSha256: "d".repeat(64),
    transcriptSha256: "e".repeat(64), evidenceRef: "reopen-protocol-fixture", baseCommit: candidate.baseCommit,
    candidateCommit: candidate.candidateCommit, diffSha256: candidate.diffSha256 };
}
async function complete(service: TaskService, p: Awaited<ReturnType<typeof memoryPeople>>) {
  let task = await service.create(p.owner, p.project.id, { title: "需要后续恢复的完成任务", body: "目标与范围",
    deliveryKind: "code", acceptanceText: "可复核的验收条件", assigneeMemberId: p.member.id, reviewerMemberId: p.outsider.id,
    repoPath: "/fixture", fixedPoint: "base" });
  task = await service.transition(p.own, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  const start = await service.startReview(p.own, p.project.id, task.id, { expectedRevision: task.revision });
  assert.equal(start.ready, true); task = start.task;
  let round = await service.beginReview(p.foreign, p.project.id, task.id, start.round.id,
    { expectedTaskRevision: task.revision, expectedRoundRevision: start.round.revision });
  for (const axis of ["spec", "standards"] as const) {
    await service.submitReport(p.foreign, p.project.id, task.id, round.id,
      { expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, axis, verdict: "pass",
        body: "只用于完成生命周期的协议 fixture", sources: ["fixture"], evidence: evidence(axis) });
    round = (await service.get(p.owner, p.project.id, task.id)).rounds.find(item => item.id === round.id)!;
  }
  task = await service.decideReview(p.foreign, p.project.id, task.id, round.id,
    { expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, verdict: "pass", reason: "两轴协议检查完成" });
  assert.equal(task.state, "done");
  return task;
}

for (const engine of ["sqlite", "postgres"] as const) {
  for (const lifecycle of ["active", "disabled", "removed"] as const) {
    test(`${engine} R-BR-COLLAB-137-REQ-001/STD-001：${lifecycle} 完成任务重开待办保留旧轮次，实际改派才通知`,
      { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async (repos, db) => {
        const p = await memoryPeople(repos), org = createOrgMutationService({ repos });
        const notified: WorkEvent[] = [], changed: Array<{ taskId: string; revision: number }> = [];
        const service = createTaskService({ repos, captureCandidate: async () => candidate,
          onWorkEvents: events => { notified.push(...events); },
          onTaskChanged: (_projectId, taskId, revision) => { changed.push({ taskId, revision }); } });
        let task = await complete(service, p);
        const orgAccess = { actor: ownerActor(p.project.id) };
        if (lifecycle === "disabled") await org.setMemberStatus(orgAccess, p.project.id, p.member.id, "disabled");
        if (lifecycle === "removed") await org.removeMember(orgAccess, p.project.id, p.member.id);
        task = (await service.get(p.owner, p.project.id, task.id)).task;
        assert.equal(task.state, "done");
        assert.equal(task.assigneeMemberId, lifecycle === "removed" ? null : p.member.id);
        const missing = lifecycle === "removed" ? "assignee_required" : "assignee_invalid";
        assert.deepEqual(task.materialStatus.startExecution.reasonCodes, lifecycle === "active" ? [] : [missing]);
        notified.length = 0; changed.length = 0;
        async function snapshot() {
          return { detail: await service.get(p.owner, p.project.id, task.id), audit: await repos.audit.list(p.project.id, { limit: 250 }),
            events: await db.query("SELECT * FROM work_events WHERE project_id = ? ORDER BY id", [p.project.id]) };
        }
        const before = await snapshot();
        // 两种原始反例必须仍被执行门禁拒绝；恢复入口不放宽直接执行或 done 编辑。
        if (lifecycle !== "active") {
          await assert.rejects(service.transition(p.owner, p.project.id, task.id,
            { expectedRevision: task.revision, state: "in-progress", reason: "旧直接执行路径仍须检查资料" }),
          error => { assert.ok(error instanceof TaskError); assert.equal(error.reason, "task_materials_incomplete"); assert.deepEqual(error.details["reasonCodes"], [missing]); return true; });
        }
        await assert.rejects(service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, title: "尚未重开不能改" }), { reason: "task_reopen_required" });
        const reopen = { expectedRevision: task.revision, state: "todo" as const, reason: "  先重新分派后续负责人  " };
        task = await service.transition(p.owner, p.project.id, task.id, reopen);
        assert.equal(task.state, "todo"); assert.equal(task.revision, before.detail.task.revision + 1);
        assert.equal(task.currentReviewRoundId, null); assert.equal(task.blockedReason, null);
        assert.equal(task.assigneeMemberId, before.detail.task.assigneeMemberId, "重开不能自动替换原负责人");
        assert.equal(task.materialStatus.executionAdmission, "not-issued");
        const after = await snapshot();
        assert.deepEqual(after.detail.rounds, before.detail.rounds, "旧 round 的状态、candidate、decision 与 revision 原样保留");
        assert.deepEqual(after.detail.reports, before.detail.reports);
        assert.deepEqual(after.detail.comments, before.detail.comments);
        assert.deepEqual(after.detail.history.slice(0, -1), before.detail.history);
        assert.deepEqual(after.detail.history.at(-1)?.detail, { from: "done", to: "todo", reason: "先重新分派后续负责人" });
        assert.equal(after.detail.history.at(-1)?.taskRevision, task.revision);
        assert.equal(after.audit.length, before.audit.length + 1);
        const addedAudit = after.audit.find(entry => !before.audit.some(old => old.id === entry.id))!;
        assert.equal(addedAudit.action, "task.transitioned");
        assert.deepEqual(JSON.parse(addedAudit.detail!), { from: "done", to: "todo", reason: "先重新分派后续负责人" });
        assert.deepEqual(after.audit.filter(entry => entry.id !== addedAudit.id), before.audit);
        assert.deepEqual(after.events, before.events, "没有新增 assigned / blocked / review 事件");
        assert.equal(notified.length, 0); assert.deepEqual(changed, [{ taskId: task.id, revision: task.revision }]);
        // 已提交请求的旧 CAS 不重复写入；新的同态请求也不制造重复 history / 通知。
        await assert.rejects(service.transition(p.owner, p.project.id, task.id, reopen), { reason: "task_revision_conflict" });
        await service.transition(p.owner, p.project.id, task.id, { ...reopen, expectedRevision: task.revision });
        assert.deepEqual(await snapshot(), after);
        if (lifecycle !== "active") await assert.rejects(service.transition(p.owner, p.project.id, task.id,
          { expectedRevision: task.revision, state: "in-progress" }), { reason: "task_materials_incomplete" });
        const replacement = await repos.members.create({ projectId: p.project.id, kind: "human", displayName: "后续负责人" });
        task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: replacement.id });
        assert.equal(notified.length, 1); assert.equal(notified[0]?.kind, "task.assigned");
        assert.equal(notified[0]?.recipientMemberId, replacement.id);
        const assigned = await snapshot();
        assert.equal(assigned.events.length, before.events.length + 1);
        task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: replacement.id });
        assert.deepEqual(await snapshot(), assigned, "相同分派不重复通知");
        task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, acceptanceText: "" });
        await assert.rejects(service.transition(p.owner, p.project.id, task.id,
          { expectedRevision: task.revision, state: "in-progress" }), { reason: "task_materials_incomplete" });
        task = await service.update(p.owner, p.project.id, task.id,
          { expectedRevision: task.revision, acceptanceText: "补充后续处理的验收条件" });
        task = await service.transition(p.owner, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
        assert.equal(task.state, "in-progress"); assert.equal(notified.length, 1);
        assert.deepEqual((await service.get(p.owner, p.project.id, task.id)).rounds, before.detail.rounds);
      }, engine));
  }

  test(`${engine} 完成任务待办重开：无 override / 空理由 / 旧 CAS / 归档 / 审计失败均无副作用，旧直接执行路径保留`,
    { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async (repos, db) => {
      const p = await memoryPeople(repos), notified: WorkEvent[] = [], changed: number[] = [];
      const service = createTaskService({ repos, captureCandidate: async () => candidate,
        onWorkEvents: events => { notified.push(...events); }, onTaskChanged: (_p, _t, revision) => { changed.push(revision); } });
      let task = await complete(service, p); notified.length = 0; changed.length = 0;
      const snapshot = async () => ({ detail: await service.get(p.owner, p.project.id, task.id), audit: await repos.audit.list(p.project.id, { limit: 250 }),
        events: await db.query("SELECT * FROM work_events WHERE project_id = ? ORDER BY id", [p.project.id]), notified: [...notified], changed: [...changed] });
      const before = await snapshot();
      await assert.rejects(service.transition(p.owner, p.project.id, task.id,
        { expectedRevision: task.revision, state: "blocked", reason: "不能拿 blocked 替代重开待办" }), { reason: "task_transition_invalid" });
      for (const state of ["todo", "in-progress"] as const) {
        const valid = { expectedRevision: task.revision, state, reason: "有理由也不可以越权" };
        await assert.rejects(service.transition(p.own, p.project.id, task.id, valid), { name: "ForbiddenError" });
        await assert.rejects(service.transition(p.foreign, p.project.id, task.id, valid), { name: "ForbiddenError" });
        await assert.rejects(service.transition(p.owner, p.project.id, task.id, { expectedRevision: task.revision, state }), { reason: "task_reason_required" });
        await assert.rejects(service.transition(p.owner, p.project.id, task.id, { ...valid, reason: " \n " }), { reason: "task_input_invalid" });
        await assert.rejects(service.transition(p.owner, p.project.id, task.id, { ...valid, expectedRevision: task.revision - 1 }), { reason: "task_revision_conflict" });
        await repos.projects.archive(p.project.id);
        await assert.rejects(service.transition(p.owner, p.project.id, task.id, valid), { code: "archived" });
        await repos.projects.restore(p.project.id);
        assert.deepEqual(await snapshot(), before);
      }
      const originalAppend = repos.audit.append;
      repos.audit.append = async () => { throw new WriteFailedError("故意使重开审计失败"); };
      try {
        await assert.rejects(service.transition(p.owner, p.project.id, task.id,
          { expectedRevision: task.revision, state: "todo", reason: "审计必须和状态一起提交" }), { code: "write_failed" });
      } finally { repos.audit.append = originalAppend; }
      assert.deepEqual(await snapshot(), before, "审计失败回滚任务、轮次、历史及事件，不发提交后通知");
      task = await service.transition(p.owner, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress", reason: "旧客户端资料完整可直接继续执行" });
      assert.equal(task.state, "in-progress"); assert.equal(task.revision, before.detail.task.revision + 1);
      const after = await snapshot();
      assert.deepEqual(after.detail.reports, before.detail.reports);
      assert.deepEqual(after.detail.rounds[0]?.decision, before.detail.rounds[0]?.decision);
      assert.deepEqual(after.events, before.events); assert.deepEqual(notified, []);
    }, engine));
}

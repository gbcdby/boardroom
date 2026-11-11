import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import { CaptureBudget } from "../src/server/org/capture-budget.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";

const at = "2026-11-11T12:00:00.000Z";
async function fixture(repos: RepositorySet) {
  const people = await memoryPeople(repos), { project, member, agent } = people;
  const task = await repos.tasks.create({ id: randomUUID(), projectId: project.id, title: "保留阻塞原因", body: "正文不属于补偿采集", labels: [],
    state: "blocked", assigneeMemberId: member.id, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1,
    currentReviewRoundId: null, blockedReason: "原始原因", author: { kind: "human", actorId: "human:local", displayName: "人" }, createdAt: at, updatedAt: at });
  const request = await repos.memory.createRequest({ id: randomUUID(), projectId: project.id, agentId: agent.id, recipientMemberId: member.id,
    contextGroupId: null, documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: randomUUID(),
    taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null,
    beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null });
  return { ...people, owner: { actor: people.owner.actor }, task, request };
}
async function snapshot(repos: RepositorySet, value: Awaited<ReturnType<typeof fixture>>) {
  return {
    member: await repos.members.getIncludingRemoved(value.member.id), task: await repos.tasks.get(value.project.id, value.task.id),
    request: await repos.memory.getRequest(value.request.id), history: await repos.tasks.listHistory(value.project.id, value.task.id),
    facts: await repos.members.retainedFacts(value.member.id), audits: await repos.audit.list(value.project.id),
    participants: await repos.context.query("SELECT group_id, member_id, joined_at FROM group_participants WHERE member_id = ? ORDER BY group_id", [value.member.id]),
    events: await repos.context.query("SELECT id, delivery_state FROM work_events WHERE project_id = ? ORDER BY id", [value.project.id]),
  };
}
class WritesObserved extends CaptureBudget {
  businessWrites: string[] = [];
  override before(sql: string): void {
    super.before(sql);
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/^\s*UPDATE \w+ SET updated_at = updated_at/i.test(sql)) this.businessWrites.push(sql);
  }
}

for (const field of ["name", "blockedReason"] as const) {
  // The existing member CHECK already rejects a name starting with NUL; task reasons allow it.
  for (const bad of field === "name" ? ["前半段\u0000后半段", "前半段\u0000"] : ["前半段\u0000后半段", "\u0000后半段", "前半段\u0000"]) {
    test(`sqlite REQ006：历史${field}含NUL ${JSON.stringify(bad)} 时写前拒绝，完整跨表事实保留`, async () => memoryFixture(async (repos, db) => {
      const value = await fixture(repos);
      // Seed an already-stored value: rejecting only a new API input cannot satisfy this regression.
      if (field === "name") await db.exec("UPDATE members SET display_name = ? WHERE id = ?", [bad, value.member.id]);
      else await db.exec("UPDATE tasks SET blocked_reason = ? WHERE id = ?", [bad, value.task.id]);
      const before = await snapshot(repos, value), budget = new WritesObserved();
      await assert.rejects(budget.run(() => createOrgMutationService({ repos }).removeMember(value.owner, value.project.id, value.member.id)), { code: "audit_capture_budget_exceeded" });
      assert.deepEqual(budget.businessWrites, []);
      assert.deepEqual(await snapshot(repos, value), before);
    }));
  }
}

for (const metadata of ["created_at", "updated_at", "joined_at"] as const) {
  test(`sqlite REQ006：关系元数据${metadata}含NUL也必须写前拒绝`, async () => memoryFixture(async (repos, db) => {
    const value = await fixture(repos), bad = "原始\u0000后缀";
    if (metadata === "joined_at") await db.exec("UPDATE group_participants SET joined_at = ? WHERE member_id = ?", [bad, value.member.id]);
    else await db.exec(`UPDATE members SET ${metadata} = ? WHERE id = ?`, [bad, value.member.id]);
    const before = await snapshot(repos, value), budget = new WritesObserved();
    await assert.rejects(budget.run(() => createOrgMutationService({ repos }).removeMember(value.owner, value.project.id, value.member.id)), { code: "audit_capture_budget_exceeded" });
    assert.deepEqual(budget.businessWrites, []); assert.deepEqual(await snapshot(repos, value), before);
  }));
}

test("sqlite REQ006：分页任务ID含NUL时不使用截断游标或丢弃关系", async () => memoryFixture(async (repos, db) => {
  const original = await fixture(repos), id = "task\u0000suffix";
  await db.exec("UPDATE tasks SET id = ? WHERE id = ?", [id, original.task.id]);
  const value = { ...original, task: { ...original.task, id } }, before = await snapshot(repos, value), budget = new WritesObserved();
  await assert.rejects(budget.run(() => createOrgMutationService({ repos }).removeMember(value.owner, value.project.id, value.member.id)), { code: "audit_capture_budget_exceeded" });
  assert.deepEqual(budget.businessWrites, []); assert.deepEqual(await snapshot(repos, value), before);
}));

for (const field of ["name", "blockedReason"] as const) {
  test(`sqlite REQ006：旧审计JSON中的${field}含转义NUL时撤销也在写前拒绝`, async () => memoryFixture(async (repos, db) => {
    const value = await fixture(repos), service = createOrgMutationService({ repos });
    const removed = await service.removeMember(value.owner, value.project.id, value.member.id);
    const audit = (await repos.audit.get(value.project.id, removed.auditId))!;
    const historical = JSON.parse(audit.before!) as { member: { displayName: string }; tasks: Array<{ blockedReason: string }> };
    if (field === "name") historical.member.displayName = "原始\u0000后缀";
    else historical.tasks[0]!.blockedReason = "原始\u0000后缀";
    // The JSON column itself contains an escaped sequence, so SQL prefix checks alone are insufficient.
    await db.exec("UPDATE audit_log SET before = ? WHERE id = ?", [JSON.stringify(historical), removed.auditId]);
    const before = await snapshot(repos, value), budget = new WritesObserved();
    await assert.rejects(budget.run(() => createAuditCompensationService({ repos }).revoke(value.owner, value.project.id, removed.auditId)), { code: "audit_capture_budget_exceeded" });
    assert.deepEqual(budget.businessWrites, []); assert.deepEqual(await snapshot(repos, value), before);
  }));
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} REQ006：合法Unicode/空或NULL原因仍可移除与撤销完整还原`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async (repos, db) => {
    const value = await fixture(repos), service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const name = "原名😀后半段";
    await db.exec("UPDATE members SET display_name = ? WHERE id = ?", [name, value.member.id]);
    for (const reason of ["前半段😀后半段", "", null]) {
      await db.exec("UPDATE tasks SET blocked_reason = ? WHERE id = ?", [reason, value.task.id]);
      const removed = await service.removeMember(value.owner, value.project.id, value.member.id);
      await compensation.revoke(value.owner, value.project.id, removed.auditId);
      assert.equal((await repos.members.get(value.member.id))!.displayName, name);
      assert.equal((await repos.tasks.get(value.project.id, value.task.id))!.blockedReason, reason);
    }
  }, engine));
}

test("postgres REQ006：数据库拒绝NUL文本，既有字段未改变且补偿仍可用", { skip: pgUnavailable }, async () => memoryFixture(async (repos, db) => {
  const value = await fixture(repos), before = await snapshot(repos, value);
  await assert.rejects(db.exec("UPDATE members SET display_name = ? WHERE id = ?", ["前\u0000后", value.member.id]), { code: "22021" });
  await assert.rejects(db.exec("UPDATE tasks SET blocked_reason = ? WHERE id = ?", ["前\u0000后", value.task.id]), { code: "22021" });
  assert.deepEqual(await snapshot(repos, value), before);
}, "postgres"));

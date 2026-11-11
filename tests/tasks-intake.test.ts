import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import { createTaskService } from "../src/server/tasks/service.ts";
import type { Task } from "../src/shared/tasks.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
type Engine = "sqlite" | "postgres";
async function fixture(engine: Engine, run: (repos: RepositorySet, driver: DbDriver) => Promise<void>, maxVersion = 16) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-task-intake-"));
  const schema = `task_intake_${randomUUID().replaceAll("-", "")}`;
  const driver = engine === "sqlite" ? new SqliteDriver({ dataDir: dir }) : createDbDriver({ dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await driver.connect(); await driver.migrate(migrations.filter(m => m.version <= maxVersion)); await run(createRepositories(driver), driver); }
  finally {
    await driver.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
async function people(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "任务录入" });
  const add = async (name: string) => {
    const agent = await repos.agents.create({ displayName: name, hostType: "codex-cli" });
    return repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: name });
  };
  const worker = await add("执行者"), reviewer = await add("评审者");
  const group = await repos.groups.create({ projectId: project.id, name: "工作群", participantMemberIds: [worker.id, reviewer.id] });
  return { project, worker, reviewer, group, owner: { actor: ownerActor() },
    workerAccess: { actor: actorForMember(worker), connection: { projectId: project.id, groupId: group.id, memberId: worker.id, membershipRevision: worker.membershipRevision } } };
}
function both(name: string, run: (repos: RepositorySet, driver: DbDriver) => Promise<void>, maxVersion = 16) {
  for (const engine of ["sqlite", "postgres"] as const) test(`${engine} S5-T1：${name}`,
    { skip: engine === "postgres" && !pgUrl ? "本地没有真实 PG；待 CI 执行，不以 SQLite 代替" : false }, () => fixture(engine, run, maxVersion));
}

both("只有标题可保存为未分派 todo，刷新可读且无误投通知", async repos => {
  const p = await people(repos), service = createTaskService({ repos });
  const task = await service.create(p.owner, p.project.id, { title: "先记下来" });
  assert.equal(task.title, "先记下来"); assert.equal(task.body, ""); assert.equal(task.state, "todo");
  assert.equal(task.assigneeMemberId, null); assert.equal(task.reviewerMemberId, null); assert.equal(task.revision, 1);
  assert.deepEqual((await service.get(p.owner, p.project.id, task.id)).task, task);
  assert.deepEqual(await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id), []);
  assert.deepEqual(await repos.tasks.listUnackedWorkEvents(p.project.id, p.reviewer.id), []);
  await assert.rejects(service.create(p.workerAccess, p.project.id, { title: "普通成员无创建权" }), { name: "ForbiddenError" });
  await repos.projects.archive(p.project.id);
  await assert.rejects(service.create(p.owner, p.project.id, { title: "已归档不能创建" }), { code: "archived" });
});

both("显式清空与默认评审人不同，实际改派只通知新执行人一次", async repos => {
  const p = await people(repos), service = createTaskService({ repos });
  await service.setSettings(p.owner, p.project.id, { expectedRevision: 0, defaultReviewerMemberId: p.reviewer.id });
  const defaulted = await service.create(p.owner, p.project.id, { title: "使用有效默认" });
  assert.equal(defaulted.reviewerMemberId, p.reviewer.id);
  let task = await service.create(p.owner, p.project.id, { title: "明确不选", reviewerMemberId: null });
  assert.equal(task.reviewerMemberId, null);
  const sameAsAssignee = await service.create(p.owner, p.project.id, { title: "默认不能自评", assigneeMemberId: p.reviewer.id });
  assert.equal(sameAsAssignee.reviewerMemberId, null);
  await assert.rejects(service.create(p.owner, p.project.id, { title: "显式同人拒绝", assigneeMemberId: p.worker.id, reviewerMemberId: p.worker.id }), { reason: "reviewer_is_assignee" });
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.worker.id });
  const assignedRevision = task.revision;
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.taskId === task.id && event.kind === "task.assigned").length, 1);
  const noChange = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.worker.id });
  assert.equal(noChange.revision, assignedRevision);
  await assert.rejects(service.update(p.owner, p.project.id, task.id, { expectedRevision: 1, assigneeMemberId: p.worker.id }), { code: "conflict" });
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: null, reviewerMemberId: null });
  assert.equal(task.assigneeMemberId, null); assert.equal(task.reviewerMemberId, null);
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.taskId === task.id && event.kind === "task.assigned").length, 1);
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.worker.id });
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.taskId === task.id && event.kind === "task.assigned").length, 2);
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.reviewer.id });
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.taskId === task.id).length, 2, "改派不再通知旧负责人");
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.reviewer.id)).filter(event => event.taskId === task.id && event.kind === "task.assigned").length, 1);
  await repos.members.setStatus(p.reviewer.id, "disabled");
  const changed = (await service.get(p.owner, p.project.id, task.id)).task;
  assert.ok(changed.materialStatus.startExecution.reasonCodes.includes("assignee_invalid"));
  assert.deepEqual((await service.list(p.owner, p.project.id)).find(item => item.id === task.id)?.materialStatus, changed.materialStatus, "列表与详情使用相同的当前成员资料观察");
  assert.equal((await service.create(p.owner, p.project.id, { title: "失效默认不阻断录入" })).reviewerMemberId, null);
  await assert.rejects(service.create(p.owner, p.project.id, { title: "显式失效仍拒绝", reviewerMemberId: p.reviewer.id }), { reason: "reviewer_invalid" });
});

both("资料字段受数据库约束，非法类别或来源不会写入", async (repos, db) => {
  const p = await people(repos), service = createTaskService({ repos });
  const task = await service.create(p.owner, p.project.id, { title: "类型约束", deliveryKind: null });
  for (const [column, value] of [["delivery_kind", "unknown"], ["acceptance_source", "fabricated"], ["acceptance_text", null]] as const) {
    await assert.rejects(db.exec(`UPDATE tasks SET ${column} = ? WHERE id = ?`, [value, task.id]));
  }
  assert.deepEqual((await service.get(p.owner, p.project.id, task.id)).task, task);
});

both("交付类型与明确验收持久保存，修改保留原验收快照", async repos => {
  const p = await people(repos), service = createTaskService({ repos });
  let task = await service.create(p.owner, p.project.id, { title: "调查报告", deliveryKind: "finding", acceptanceText: "列明来源、结论和剩余未知" });
  assert.equal(task.deliveryKind, "finding");
  assert.equal(task.acceptanceText, "列明来源、结论和剩余未知");
  assert.equal(task.acceptanceSource, "explicit");
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, acceptanceText: "另加可复核的原始资料引用" });
  const detail = await service.get(p.owner, p.project.id, task.id);
  assert.equal(detail.task.acceptanceText, "另加可复核的原始资料引用");
  assert.deepEqual(detail.history.at(-1)?.detail["acceptanceChange"], {
    before: { text: "列明来源、结论和剩余未知", source: "explicit" },
    after: { text: "另加可复核的原始资料引用", source: "explicit" },
  });
  const noChange = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, acceptanceText: task.acceptanceText });
  assert.equal(noChange.revision, task.revision);
});

both("开始及恢复在事务内检查同一份资料，缺 reviewer 不阻断开始", async repos => {
  const p = await people(repos), service = createTaskService({ repos });
  let task = await service.create(p.owner, p.project.id, { title: "逐项补齐" });
  const reasons = ["assignee_required", "task_goal_required", "task_acceptance_required", "task_delivery_kind_required"];
  await assert.rejects(service.transition(p.owner, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" }),
    (error: any) => error.reason === "task_materials_incomplete" && JSON.stringify(error.details.reasonCodes) === JSON.stringify(reasons));
  let detail = await service.get(p.owner, p.project.id, task.id);
  assert.equal(detail.task.state, "todo"); assert.equal(detail.task.revision, 1);
  assert.deepEqual(detail.task.materialStatus.startExecution.reasonCodes, reasons);
  assert.equal(detail.task.materialStatus.executionAdmission, "not-issued");
  assert.equal("allowed" in detail.task.materialStatus.startExecution, false);
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.worker.id,
    body: "完成确定范围的实现", acceptanceText: "接口与回归证据完整", deliveryKind: "code", reviewerMemberId: null });
  assert.deepEqual(task.materialStatus.startExecution.reasonCodes, []);
  assert.ok(task.materialStatus.submitReview.reasonCodes.includes("reviewer_required"));
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  await assert.rejects(service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: null }), { reason: "task_assignee_clear_requires_pause" });
  await assert.rejects(service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision }), { reason: "task_materials_incomplete" });
  assert.deepEqual(await repos.tasks.listRounds(p.project.id, task.id), []);
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "blocked", reason: "等待补充" });
  task = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, body: "" });
  await assert.rejects(service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" }),
    (error: any) => error.reason === "task_materials_incomplete" && error.details.reasonCodes.includes("task_goal_required"));
  detail = await service.get(p.owner, p.project.id, task.id);
  assert.equal(detail.task.state, "blocked"); assert.equal(detail.task.revision, task.revision);
});

both("非代码任务不会调用 Git 捕获，旧评审在验收变化后失效", async repos => {
  const p = await people(repos); let captures = 0;
  const service = createTaskService({ repos, captureCandidate: async () => { captures++; return {
    repositoryRoot: "/fixture", fixedPointInput: "base", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40),
    policy: "committed-clean", gitVersion: "unit-fixture", diff: "", diffSha256: "c".repeat(64), commits: [], commands: [], capturedAt: "2026-11-11T00:00:00.000Z",
  }; } });
  for (const deliveryKind of ["artifact", "finding"] as const) {
    let task = await service.create(p.owner, p.project.id, { title: "非代码资料", body: "整理实际产物", acceptanceText: "完整可复核", deliveryKind,
      assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/fake", fixedPoint: "placeholder" });
    task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
    const before = await service.get(p.owner, p.project.id, task.id);
    await assert.rejects(service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision }),
      (error: any) => error.reason === "task_materials_incomplete" && error.details.reasonCodes.includes("candidate_type_requires_v2"));
    assert.equal(captures, 0); assert.deepEqual(await service.get(p.owner, p.project.id, task.id), before);
  }
  let task = await service.create(p.owner, p.project.id, { title: "代码资料", body: "实现接口", acceptanceText: "原始验收", deliveryKind: "code",
    assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/fixture", fixedPoint: "base" });
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  const review = await service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision });
  assert.equal(review.ready, true); assert.equal(captures, 1); assert.equal(review.round.specSnapshot.acceptanceText, "原始验收");
  const edited = await service.update(p.owner, p.project.id, task.id, { expectedRevision: review.task.revision, acceptanceText: "修订验收" });
  assert.equal(edited.state, "in-progress"); assert.equal(edited.currentReviewRoundId, null);
  assert.equal((await repos.tasks.getRound(p.project.id, task.id, review.round.id))?.state, "superseded");
  assert.equal((await repos.tasks.getRound(p.project.id, task.id, review.round.id))?.specSnapshot.acceptanceText, "原始验收");
});

both("非空 v15 升级保留原状态修订与评审，旧正文作为可追溯验收来源", async (repos, db) => {
  const p = await people(repos);
  const at = "2026-11-10T00:00:00.000Z";
  const legacy: Task = { id: randomUUID(), projectId: p.project.id, title: "原有任务", body: "旧正文与验收 🧠\n原样保留", labels: ["历史"], state: "blocked",
    assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/original", fixedPoint: "base", revision: 1,
    currentReviewRoundId: null, blockedReason: "原始阻塞", author: { kind: "human", actorId: "owner", displayName: "人" }, createdAt: at, updatedAt: at,
    deliveryKind: "code", acceptanceText: "旧正文与验收 🧠\n原样保留", acceptanceSource: "legacy_task_body" };
  await repos.tasks.create(legacy);
  const done = await repos.tasks.create({ ...legacy, id: randomUUID(), title: "已经完成", state: "done" });
  const round = await repos.tasks.createRound({ id: randomUUID(), projectId: p.project.id, taskId: done.id, revision: 1, taskRevision: 1,
    state: "decided", reviewerMemberId: p.reviewer.id, specSnapshot: { title: done.title, body: done.body, labels: done.labels },
    candidate: null, failure: null, decision: { verdict: "pass", actor: done.author, reason: "原结论", override: true, taskRevision: 1 }, createdAt: at, updatedAt: at });
  await repos.tasks.appendHistory({ id: randomUUID(), projectId: p.project.id, taskId: done.id, action: "task.review_decided", actor: done.author,
    taskRevision: 1, detail: { original: "保留" }, createdAt: at });
  const before = await db.query("SELECT * FROM tasks ORDER BY id");
  const history = await db.query("SELECT * FROM task_history ORDER BY id");
  const rounds = await db.query("SELECT * FROM task_review_rounds ORDER BY id");
  const applied = (await db.migrationState()).applied;
  assert.deepEqual((await db.migrate(migrations)).applied.map(m => m.version), [16, 17]);
  assert.deepEqual((await db.migrationState()).applied.slice(0, applied.length), applied);
  const after = await db.query("SELECT * FROM tasks ORDER BY id");
  assert.deepEqual(after.map(({ delivery_kind: _kind, acceptance_text: _text, acceptance_source: _source, ...original }) => original), before);
  for (const row of after) { assert.equal(row["delivery_kind"], "code"); assert.equal(row["acceptance_text"], row["body"]); assert.equal(row["acceptance_source"], "legacy_task_body"); }
  assert.deepEqual(await db.query("SELECT * FROM task_history ORDER BY id"), history);
  assert.deepEqual(await db.query("SELECT * FROM task_review_rounds ORDER BY id"), rounds);
  assert.equal((await repos.tasks.getRound(p.project.id, done.id, round.id))?.decision?.reason, "原结论");
  assert.equal((await repos.tasks.get(p.project.id, done.id))?.state, "done");
  assert.equal((await db.migrate(migrations)).applied.length, 0);
  const service = createTaskService({ repos });
  const changedBody = await service.update(p.owner, p.project.id, legacy.id, { expectedRevision: 1, body: "后续改目标" });
  assert.equal(changedBody.acceptanceText, legacy.body, "迁移验收是原正文快照，不能跟着后续目标编辑漂移");
  const explicit = await service.update(p.owner, p.project.id, legacy.id, { expectedRevision: changedBody.revision, acceptanceText: legacy.body });
  assert.equal(explicit.acceptanceSource, "explicit");
  assert.deepEqual((await service.get(p.owner, p.project.id, legacy.id)).history.at(-1)?.detail["acceptanceChange"], {
    before: { text: legacy.body, source: "legacy_task_body" }, after: { text: legacy.body, source: "explicit" },
  });
}, 15);

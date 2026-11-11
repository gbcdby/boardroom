import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import { ConflictError, WriteFailedError } from "../src/server/db/errors.ts";
import { createTaskService } from "../src/server/tasks/service.ts";
import { TaskError } from "../src/server/tasks/errors.ts";
import type { ReviewCandidate, ReviewEvidence } from "../src/shared/tasks.ts";

const candidate: ReviewCandidate = { repositoryRoot: "/fixture", fixedPointInput: "base", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40),
  policy: "committed-clean", gitVersion: "unit fixture", diff: "+ implemented", diffSha256: "c".repeat(64), commits: [], commands: [], capturedAt: "2026-11-10T12:00:00.000Z" };
function evidence(axis: string): ReviewEvidence {
  const startedAt = "2026-11-10T12:00:00.000Z", completedAt = "2026-11-10T12:01:00.000Z";
  return { provenance: "reviewer-declared", host: "test-fixture", hostVersion: "unit-only", parentRunId: "round-run", invocationId: `inv-${axis}`, contextId: `ctx-${axis}`,
    startedAt, completedAt, command: { argv: ["test-fixture"], cwd: "/fixture", startedAt, completedAt, exitCode: 0 },
    promptSha256: "d".repeat(64), transcriptSha256: "e".repeat(64), evidenceRef: "unit-only-not-real-model",
    baseCommit: candidate.baseCommit, candidateCommit: candidate.candidateCommit, diffSha256: candidate.diffSha256 };
}

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
async function fixture(run: (repos: RepositorySet) => Promise<void>, engine: "sqlite" | "postgres" = "sqlite") {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-task-service-"));
  const schema = `task_service_${randomUUID().replaceAll("-", "")}`;
  const driver = engine === "sqlite" ? new SqliteDriver({ dataDir: dir }) : createDbDriver({ dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await driver.connect(); await driver.migrate(migrations); await run(createRepositories(driver)); }
  finally {
    await driver.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl });
      await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
async function people(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "服务测试" });
  const add = async (name: string) => {
    const agent = await repos.agents.create({ displayName: name, hostType: "codex-cli" });
    return repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: name });
  };
  const worker = await add("实现者"); const reviewer = await add("评审者");
  const group = await repos.groups.create({ projectId: project.id, name: "讨论", participantMemberIds: [worker.id, reviewer.id] });
  return { project, worker, reviewer, group, owner: { actor: ownerActor() },
    workerAccess: { actor: actorForMember(worker), connection: { projectId: project.id, memberId: worker.id, groupId: group.id, membershipRevision: worker.membershipRevision } },
    reviewerAccess: { actor: actorForMember(reviewer), connection: { projectId: project.id, memberId: reviewer.id, groupId: group.id, membershipRevision: reviewer.membershipRevision } } };
}

test("AC-TASK-01/02：有效默认 reviewer、正文创建、普通成员评论与越权拒绝", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos });
  await service.setSettings(p.owner, p.project.id, { expectedRevision: 0, defaultReviewerMemberId: p.reviewer.id });
  const input = { title: "落实需求", body: "实现并验证", deliveryKind: "code" as const, acceptanceText: "实现并验证", assigneeMemberId: p.worker.id };
  await assert.rejects(service.create(p.workerAccess, p.project.id, input), { name: "ForbiddenError" });
  const task = await service.create(p.owner, p.project.id, input);
  assert.equal(task.reviewerMemberId, p.reviewer.id); assert.equal(task.revision, 1);
  await service.comment(p.workerAccess, p.project.id, task.id, "准备开始");
  const detail = await service.get(p.workerAccess, p.project.id, task.id);
  assert.equal(detail.comments.length, 1); assert.equal(detail.task.revision, 1);
  await assert.rejects(service.update(p.workerAccess, p.project.id, task.id, { expectedRevision: 1, assigneeMemberId: p.reviewer.id }), { name: "ForbiddenError" });
  const running = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: 1, state: "in-progress" });
  assert.equal(running.state, "in-progress");
  await assert.rejects(service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: 1, state: "blocked", reason: "等待" }), { code: "conflict" });
}));

async function reviewConcurrency(repos: RepositorySet): Promise<void> {
  const p = await people(repos); const service = createTaskService({ repos, captureCandidate: async () => candidate });
  let task = await service.create(p.owner, p.project.id, { title: "评审", body: "验收条件", deliveryKind: "code" as const, acceptanceText: "验收条件", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/fixture", fixedPoint: "base" });
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  const start = await service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision });
  assert.equal(start.ready, true); task = start.task;
  const round = await service.beginReview(p.reviewerAccess, p.project.id, task.id, start.round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: start.round.revision });
  await assert.rejects(service.decideReview(p.reviewerAccess, p.project.id, task.id, round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, verdict: "pass", reason: "缺轴不能通过" }), { code: "conflict" });
  const inputs = (["spec", "standards"] as const).map(axis => ({ axis, verdict: "pass" as const, body: `仅为 ${axis} 通道测试`, sources: [axis], evidence: evidence(axis), expectedTaskRevision: task.revision, expectedRoundRevision: round.revision }));
  const results = await Promise.allSettled(inputs.map(input => service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, input)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results[0]!.status === "fulfilled" ? 0 : 1; const loser = 1 - winner;
  let currentRound = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  assert.equal(currentRound.revision, round.revision + 1);
  await service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, { ...inputs[loser]!, expectedRoundRevision: currentRound.revision });
  const won = results[winner]!;
  assert.equal(won.status, "fulfilled");
  if (won.status !== "fulfilled") throw new Error("missing winner");
  const firstId = won.value.id;
  assert.equal((await service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, inputs[winner]!)).id, firstId);
  currentRound = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  assert.equal(currentRound.state, "reported");
  task = await service.decideReview(p.reviewerAccess, p.project.id, task.id, round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: currentRound.revision, verdict: "pass", reason: "两轴完成" });
  assert.equal(task.state, "done");
  let decidedEvents = (await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.kind === "task.review_decided");
  assert.equal(decidedEvents.length, 1);
  assert.equal(decidedEvents[0]!.payload["enteredDone"], true, "记忆触发只依据真实非 done→done 边");
  assert.equal(decidedEvents[0]!.payload["completionRevision"], task.revision);
  assert.equal(decidedEvents[0]!.payload["assigneeAgentId"], p.worker.agentId);
  currentRound = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  task = await service.decideReview(p.owner, p.project.id, task.id, round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: currentRound.revision, verdict: "pass", reason: "补充确认，未重新完成任务", override: true });
  decidedEvents = (await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).filter(event => event.kind === "task.review_decided");
  assert.equal(decidedEvents.filter(event => event.payload["enteredDone"] === true).length, 1, "重复 done 裁决不能再次触发总结");
  assert.equal(decidedEvents.find(event => event.payload["completionRevision"] === task.revision)?.payload["enteredDone"], false);
  currentRound = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  task = await service.decideReview(p.owner, p.project.id, task.id, round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: currentRound.revision, verdict: "changes_requested", reason: "管理者需要补充验收", override: true });
  assert.equal(task.state, "in-progress");
  const detail = await service.get(p.owner, p.project.id, task.id);
  assert.equal(detail.reports.length, 2); assert.equal(detail.comments.filter(comment => comment.kind === "review_report").length, 2);
  assert.ok(detail.history.some(item => (item.detail["previousDecision"] as { verdict?: string } | undefined)?.verdict === "pass"));
}

test("AC-REVIEW-02/03：报告每轴 CAS、成功重放、指定 reviewer 裁决与 manager 覆盖保留原结论", async () => fixture(reviewConcurrency));
test("postgres AC-REVIEW-02/03：两轴并发 CAS、报告重放、裁决与覆盖", { skip: !pgUrl ? "本地没有真实 PG；由 CI 执行，未以 SQLite 代替 PG 通过" : false }, async () => fixture(reviewConcurrency, "postgres"));

test("AC-TASK-03：blocked 跳过空岗上报，subtree 管理与事件 ACK 不冒充执行", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos });
  const root = await repos.org.createNode({ projectId: p.project.id, role: "top_manager", name: "统筹" });
  const branch = await repos.org.createNode({ projectId: p.project.id, parentId: root.id, role: "sub_manager", name: "研发" });
  const empty = await repos.org.createNode({ projectId: p.project.id, parentId: branch.id, role: "sub_manager", name: "空岗" });
  const workerNode = await repos.org.createNode({ projectId: p.project.id, parentId: empty.id, role: "member", name: "实现" });
  await repos.org.assignNode(p.reviewer.id, root.id); await repos.org.assignNode(p.worker.id, workerNode.id);
  const agent = await repos.agents.create({ displayName: "下级管理", hostType: "codex-cli" });
  const manager = await repos.members.create({ projectId: p.project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  await repos.org.assignNode(manager.id, branch.id);
  const access = { actor: actorForMember(manager), connection: { projectId: p.project.id, memberId: manager.id, groupId: p.group.id, membershipRevision: manager.membershipRevision } };
  const task = await service.create(access, p.project.id, { title: "下级任务", body: "需要支持", deliveryKind: "code" as const, acceptanceText: "需要支持", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id });
  await assert.rejects(service.update(access, p.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: p.reviewer.id }), { name: "ForbiddenError" });
  const blocked = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "blocked", reason: "等待信息" });
  const first = await service.deliverWorkEvents(access, p.project.id);
  assert.equal(first[0]?.kind, "task.blocked"); assert.equal(first[0]?.attempts, 1);
  const second = await service.deliverWorkEvents(access, p.project.id);
  assert.equal(second[0]?.attempts, 2);
  await service.acknowledgeWorkEvent(access, p.project.id, first[0]!.id);
  assert.equal((await service.acknowledgeWorkEvent(access, p.project.id, first[0]!.id)).alreadyAcknowledged, true);
  assert.equal((await service.get(p.owner, p.project.id, task.id)).task.state, "blocked");
  assert.equal((await service.get(p.owner, p.project.id, task.id)).task.revision, blocked.revision);
  await assert.rejects(service.listWorkEvents(p.owner, p.project.id), { name: "ForbiddenError" });
  const detail = await service.get(p.owner, p.project.id, task.id);
  assert.deepEqual(detail.history.at(-1)?.detail["escalation"], { recipientMemberId: manager.id, unresolved: false });
}));

test("P4 工作事件按当前群在 LIMIT 前过滤，退群后不再投递该群记忆通知", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos });
  const other = await repos.groups.create({ projectId: p.project.id, name: "另一群", participantMemberIds: [p.worker.id] });
  const put = async (id: string, groupId: string, at: string) => {
    await repos.memory.createRequest({ id, projectId: p.project.id, agentId: p.worker.agentId!, recipientMemberId: p.worker.id,
      contextGroupId: groupId, documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: id,
      taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null,
      attemptId: null, beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null,
      createdAt: at, startedAt: null, finishedAt: null });
    return repos.tasks.enqueueWorkEvent({ id, projectId: p.project.id,
    recipientMemberId: p.worker.id, taskId: null, contextGroupId: groupId, kind: "memory.summary_requested", eventKey: id,
    payload: { requestId: id, trigger: "session_end", requestRevision: 1 }, deliveryState: "pending", attempts: 0,
    createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
  };
  const foreign = await put(randomUUID(), other.id, "2026-11-10T00:00:00.000Z");
  const visible = await put(randomUUID(), p.group.id, "2026-11-10T00:00:01.000Z");
  assert.deepEqual((await service.listWorkEvents(p.workerAccess, p.project.id)).map(event => event.id), [visible.id]);
  assert.deepEqual((await service.deliverWorkEvents(p.workerAccess, p.project.id, 1)).map(event => event.id), [visible.id]);
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id, 10, { contextGroupId: other.id })).find(event => event.id === foreign.id)?.deliveryState, "pending");
  await assert.rejects(service.acknowledgeWorkEvent(p.workerAccess, p.project.id, foreign.id), { code: "not_found" });
  assert.equal((await service.acknowledgeWorkEvent(p.workerAccess, p.project.id, visible.id)).alreadyAcknowledged, false);
  assert.equal((await service.acknowledgeWorkEvent(p.workerAccess, p.project.id, visible.id)).alreadyAcknowledged, true);
  await put(randomUUID(), p.group.id, "2026-11-10T00:00:02.000Z");
  await repos.groups.removeParticipant(p.group.id, p.worker.id);
  assert.deepEqual(await service.listWorkEvents(p.workerAccess, p.project.id), []);
  assert.deepEqual(await service.deliverWorkEvents(p.workerAccess, p.project.id), []);
}));

test("#6：任务评论关系只扩大当前群可读范围，详情与历史不泄露隐藏消息 ID", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos });
  const agent = await repos.agents.create({ displayName: "旁观者", hostType: "codex-cli" });
  const observer = await repos.members.create({ projectId: p.project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  await repos.groups.addParticipant(p.group.id, observer.id);
  const access = { actor: actorForMember(observer), connection: { projectId: p.project.id, memberId: observer.id, groupId: p.group.id, membershipRevision: observer.membershipRevision } };
  const task = await service.create(p.owner, p.project.id, { title: "消息关联", body: "限制群范围", deliveryKind: "code" as const, acceptanceText: "限制群范围", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id });
  const message = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.worker.id, body: "可见性测试" });
  await service.linkMessage(p.owner, p.project.id, task.id, message.id);
  assert.equal(await service.canReadLinkedMessage(access, p.project.id, message.id), false);
  const hidden = await service.get(access, p.project.id, task.id);
  assert.equal(hidden.messageLinks.length, 0);
  assert.equal(JSON.stringify(hidden.history).includes(message.id), false);
  await service.comment(access, p.project.id, task.id, "参与讨论");
  assert.equal(await service.canReadLinkedMessage(access, p.project.id, message.id), true);
  await repos.groups.removeParticipant(p.group.id, observer.id);
  assert.equal(await service.canReadLinkedMessage(access, p.project.id, message.id), false);
  assert.equal((await service.get(access, p.project.id, task.id)).messageLinks.length, 0);
}));

test("评审失败可诊断；Git 采集不锁事务，采集中任务或 managed fence 改变时拒绝提交", async () => fixture(async repos => {
  const p = await people(repos);
  const service = createTaskService({ repos, captureCandidate: async () => { throw new TaskError("review_invalid_ref", "测试无效 ref"); } });
  let task = await service.create(p.owner, p.project.id, { title: "候选", body: "固定版本", deliveryKind: "code" as const, acceptanceText: "固定版本", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/fixture", fixedPoint: "base" });
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  const failed = await service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision });
  assert.equal(failed.ready, false); assert.equal(failed.round.state, "failed"); assert.equal(failed.task.revision, task.revision);
  let entered!: () => void; let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }); const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const concurrent = createTaskService({ repos, captureCandidate: async () => { entered(); await releasePromise; return candidate; } });
  const preparing = concurrent.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision });
  await enteredPromise;
  const edited = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, body: "新的需求" });
  release(); await assert.rejects(preparing, { code: "conflict" });
  let allowed = true;
  const fenced = createTaskService({ repos, captureCandidate: async () => { allowed = false; return candidate; } });
  const fencedAccess = { ...p.workerAccess, runMutation: async <T>(_op: "write" | "consume", fn: () => Promise<T>): Promise<T> => {
    if (!allowed) throw new ConflictError("运行归属已变化"); return fn();
  } };
  await assert.rejects(fenced.startReview(fencedAccess, p.project.id, task.id, { expectedRevision: edited.revision }), { code: "conflict" });
  assert.equal((await service.get(p.owner, p.project.id, task.id)).rounds.length, 1);
}));

test("任务+history+audit+event 原子回滚；失活成员与归档不能写", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos });
  const original = repos.audit.append;
  repos.audit.append = async () => { throw new WriteFailedError("测试审计存储失败"); };
  const input = { title: "原子任务", body: "全部回滚", deliveryKind: "code" as const, acceptanceText: "全部回滚", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id };
  await assert.rejects(service.create(p.owner, p.project.id, input), { code: "write_failed" });
  repos.audit.append = original;
  assert.equal((await repos.tasks.list(p.project.id)).length, 0);
  assert.equal((await repos.tasks.listUnackedWorkEvents(p.project.id, p.worker.id)).length, 0);
  const task = await service.create(p.owner, p.project.id, input);
  await repos.members.setStatus(p.worker.id, "disabled");
  await assert.rejects(service.comment(p.workerAccess, p.project.id, task.id, "过期身份"), { name: "ForbiddenError" });
  await repos.projects.archive(p.project.id);
  await assert.rejects(service.comment(p.owner, p.project.id, task.id, "归档写入"), { code: "archived" });
}));

test("两轴证据必须匹配候选、独立且并行；候选改动会使旧轮失效", async () => fixture(async repos => {
  const p = await people(repos); const service = createTaskService({ repos, captureCandidate: async () => candidate });
  let task = await service.create(p.owner, p.project.id, { title: "证据", body: "双轴验证", deliveryKind: "code" as const, acceptanceText: "双轴验证", assigneeMemberId: p.worker.id, reviewerMemberId: p.reviewer.id, repoPath: "/fixture", fixedPoint: "base" });
  task = await service.transition(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision, state: "in-progress" });
  const started = await service.startReview(p.workerAccess, p.project.id, task.id, { expectedRevision: task.revision }); task = started.task;
  let round = await service.beginReview(p.reviewerAccess, p.project.id, task.id, started.round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: 1 });
  const spec = { axis: "spec" as const, verdict: "changes_requested" as const, body: "仅为证据通道反例", sources: ["task"], evidence: evidence("spec"), expectedTaskRevision: task.revision, expectedRoundRevision: round.revision };
  await assert.rejects(service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, { ...spec, evidence: { ...spec.evidence, candidateCommit: "f".repeat(40) } }), { reason: "review_evidence_candidate_mismatch" });
  await service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, spec);
  round = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  const standards = { ...spec, axis: "standards" as const, verdict: "pass" as const, evidence: evidence("standards"), expectedRoundRevision: round.revision };
  await assert.rejects(service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, { ...standards, evidence: { ...standards.evidence, contextId: spec.evidence.contextId } }), { reason: "review_axes_not_independent" });
  const shifted = { ...standards.evidence, startedAt: "2026-11-10T12:02:00.000Z", completedAt: "2026-11-10T12:03:00.000Z" };
  shifted.command = { ...shifted.command, startedAt: shifted.startedAt, completedAt: shifted.completedAt };
  await assert.rejects(service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, { ...standards, evidence: shifted }), { reason: "review_axes_not_independent" });
  await service.submitReport(p.reviewerAccess, p.project.id, task.id, round.id, standards);
  round = (await repos.tasks.getRound(p.project.id, task.id, round.id))!;
  await assert.rejects(service.decideReview(p.reviewerAccess, p.project.id, task.id, round.id, { expectedTaskRevision: task.revision, expectedRoundRevision: round.revision, verdict: "pass", reason: "不能无视打回" }), { reason: "review_axis_rejected" });
  const updated = await service.update(p.owner, p.project.id, task.id, { expectedRevision: task.revision, body: "修订需求" });
  assert.equal(updated.state, "in-progress"); assert.equal(updated.currentReviewRoundId, null);
  assert.equal((await repos.tasks.getRound(p.project.id, task.id, round.id))?.state, "superseded");
  await assert.rejects(service.decideReview(p.owner, p.project.id, task.id, round.id, { expectedTaskRevision: updated.revision, expectedRoundRevision: round.revision + 1, verdict: "pass", reason: "旧候选不可覆盖", override: true }), { code: "conflict" });
}));

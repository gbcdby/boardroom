import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { RepositoryError } from "../src/server/db/errors.ts";
import { appendAuditEntry } from "../src/server/audit.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import type { Task, ReviewRound, ReviewReport, WorkEvent } from "../src/shared/tasks.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const at = "2026-11-10T12:00:00.000Z";
const author = { kind: "human" as const, actorId: "owner", displayName: "人" };

async function withDb(engine: "sqlite" | "postgres", run: (repos: RepositorySet, db: DbDriver, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-tasks-"));
  const schema = `tasks_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await run(createRepositories(db), db, dir); }
  finally {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl });
      await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function fixture(repos: RepositorySet): Promise<Task> {
  const project = await repos.projects.create({ name: "任务项目" });
  const worker = await repos.agents.create({ displayName: "执行者", hostType: "codex-cli" });
  const reviewer = await repos.agents.create({ displayName: "评审者", hostType: "codex-cli" });
  const assignee = await repos.members.create({ projectId: project.id, agentId: worker.id, kind: "agent", displayName: worker.displayName });
  const reviewerMember = await repos.members.create({ projectId: project.id, agentId: reviewer.id, kind: "agent", displayName: reviewer.displayName });
  return { id: randomUUID(), projectId: project.id, title: "实现任务", body: "验收说明", labels: ["阶段 3"], state: "todo", assigneeMemberId: assignee.id,
    reviewerMemberId: reviewerMember.id, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null, author, createdAt: at, updatedAt: at };
}

const code = (expected: string) => (error: unknown) => error instanceof RepositoryError && error.code === expected;

function roundFor(task: Task): ReviewRound {
  return { id: randomUUID(), taskId: task.id, projectId: task.projectId, revision: 1, taskRevision: task.revision + 1,
    state: "ready", reviewerMemberId: task.reviewerMemberId!, specSnapshot: { title: task.title, body: task.body, labels: task.labels },
    candidate: null, failure: null, decision: null, createdAt: at, updatedAt: at };
}

function reportFor(round: ReviewRound): ReviewReport {
  return { id: randomUUID(), roundId: round.id, taskId: round.taskId, projectId: round.projectId, axis: "spec", verdict: "pass", body: "符合需求", sources: ["spec"],
    evidence: { provenance: "reviewer-declared", host: "codex", hostVersion: "test", parentRunId: "parent", invocationId: "invocation", contextId: "context",
      startedAt: at, completedAt: at, command: { argv: ["codex"], cwd: "/workspace", startedAt: at, completedAt: at, exitCode: 0 },
      promptSha256: "prompt", transcriptSha256: "transcript", evidenceRef: "evidence", baseCommit: "base", candidateCommit: "candidate", diffSha256: "diff" },
    contentSha256: "fixed-content-hash", author, createdAt: at };
}

function eventFor(task: Task): WorkEvent {
  return { id: randomUUID(), projectId: task.projectId, recipientMemberId: task.assigneeMemberId!, taskId: task.id,
    kind: "task.assigned", eventKey: `task:${task.id}:revision:1:assigned`, payload: { revision: 1 }, deliveryState: "pending", attempts: 0,
    createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null };
}

for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；由既有 CI 门控执行" : false;
  test(`${engine} 任务持久化、项目隔离与并发 CAS 仅一次成功`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      assert.deepEqual(await repos.tasks.create(task), task);
      assert.deepEqual(await repos.tasks.get(task.projectId, task.id), task);
      assert.equal(await repos.tasks.get("another-project", task.id), null);
      assert.equal((await repos.tasks.list(task.projectId, { state: "todo", assigneeMemberId: task.assigneeMemberId! })).length, 1);
      const results = await Promise.allSettled([
        repos.tasks.updateCas(task.projectId, task.id, 1, { title: "候选 A" }, at),
        repos.tasks.updateCas(task.projectId, task.id, 1, { title: "候选 B" }, at),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
      assert.ok(code("conflict")(rejected.reason));
      assert.equal((await repos.tasks.get(task.projectId, task.id))?.revision, 2);
      await assert.rejects(() => repos.tasks.updateCas("another-project", task.id, 2, { title: "越界" }, at), code("not_found"));
    });
  });

  test(`${engine} 默认评审设置 CAS、失活/删除失效与归档只读`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      assert.deepEqual(await repos.tasks.getSettings(task.projectId), { projectId: task.projectId, defaultReviewerMemberId: null, revision: 0, reviewerValid: false, invalidReason: "未配置默认评审人。" });
      const settings = await repos.tasks.setSettings(task.projectId, 0, task.reviewerMemberId);
      assert.equal(settings.revision, 1);
      assert.equal(settings.reviewerValid, true);
      await assert.rejects(() => repos.tasks.setSettings(task.projectId, 0, null), code("conflict"));
      await repos.members.setStatus(task.reviewerMemberId!, "disabled");
      assert.equal((await repos.tasks.getSettings(task.projectId)).reviewerValid, false);
      assert.equal((await repos.tasks.getSettings(task.projectId)).defaultReviewerMemberId, task.reviewerMemberId);
      await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, task.projectId, task.reviewerMemberId!);
      assert.equal((await repos.tasks.getSettings(task.projectId)).defaultReviewerMemberId, null);
      await repos.projects.archive(task.projectId);
      await assert.rejects(() => repos.tasks.setSettings(task.projectId, 2, null), code("archived"));
      assert.equal((await repos.tasks.getSettings(task.projectId)).revision, 2, 'v13 移除显式 CAS，不能依靠 FK 静默清引用');
    });
  });

  test(`${engine} 评审轮次与报告固定保存、CAS、同轴幂等及当前轮次引用校验`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const round = roundFor(task);
      assert.deepEqual(await repos.tasks.createRound(round), round);
      assert.deepEqual(await repos.tasks.getRound(task.projectId, task.id, round.id), round);
      assert.equal(await repos.tasks.getRound(task.projectId, "other-task", round.id), null);
      await repos.tasks.updateCas(task.projectId, task.id, 1, { state: "review", currentReviewRoundId: round.id }, at);
      const running = await repos.tasks.updateRoundCas(task.projectId, round.id, 1, { state: "running" }, at);
      assert.equal(running.revision, 2);
      await assert.rejects(() => repos.tasks.updateRoundCas(task.projectId, round.id, 1, { state: "reported" }, at), code("conflict"));
      const report = reportFor(round);
      assert.deepEqual(await repos.tasks.addReport(report), report);
      assert.deepEqual(await repos.tasks.addReport({ ...report, id: randomUUID() }), report);
      await assert.rejects(() => repos.tasks.addReport({ ...report, id: randomUUID(), contentSha256: "different" }), code("conflict"));
      assert.deepEqual(await repos.tasks.listReports(task.projectId, task.id, round.id), [report]);
      const other = { ...task, id: randomUUID() };
      await repos.tasks.create(other);
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, other.id, 1, { currentReviewRoundId: round.id }, at), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, other.id, 1, { currentReviewRoundId: "missing" }, at), code("invalid_reference"));
      await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, task.projectId, task.reviewerMemberId!);
      assert.equal((await repos.tasks.get(task.projectId, task.id))?.reviewerMemberId, null);
      assert.equal((await repos.tasks.getRound(task.projectId, task.id, round.id))?.reviewerMemberId, task.reviewerMemberId);
      assert.deepEqual((await repos.tasks.listReports(task.projectId, task.id))[0]?.author, author);
    });
  });

  test(`${engine} 评论/历史/关联消息隔离、幂等且与任务审计同事务回滚`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const comment = { id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "comment" as const,
        author: { kind: "agent" as const, actorId: task.assigneeMemberId!, displayName: "执行者" }, body: "参与讨论", createdAt: at, reviewReportId: null };
      await repos.tasks.addComment(comment);
      assert.deepEqual(await repos.tasks.listComments(task.projectId, task.id), [comment]);
      assert.equal(await repos.tasks.hasCommented(task.projectId, task.id, task.assigneeMemberId!), true);
      assert.equal(await repos.tasks.hasCommented("other", task.id, task.assigneeMemberId!), false);
      assert.equal(await repos.tasks.hasCommented(task.projectId, task.id, task.reviewerMemberId!), false);
      const group = await repos.groups.create({ projectId: task.projectId, name: "相关群", participantMemberIds: [task.assigneeMemberId!] });
      const message = await repos.messages.create({ groupId: group.id, senderMemberId: task.assigneeMemberId!, body: "相关消息" });
      const link = { taskId: task.id, messageId: message.id, groupId: group.id, createdAt: at };
      assert.deepEqual(await repos.tasks.linkMessage(task.projectId, link), link);
      assert.deepEqual(await repos.tasks.linkMessage(task.projectId, { ...link, createdAt: "later" }), link);
      assert.deepEqual(await repos.tasks.listMessageLinks(task.projectId, task.id), [link]);
      assert.deepEqual(await repos.tasks.linkedTaskIds(task.projectId, message.id), [task.id]);
      await assert.rejects(() => repos.tasks.linkMessage(task.projectId, { ...link, groupId: "wrong-group" }), code("invalid_reference"));
      await assert.rejects(() => repos.transaction(async () => {
        await repos.tasks.updateCas(task.projectId, task.id, 1, { state: "in-progress" }, at);
        await repos.tasks.appendHistory({ id: randomUUID(), taskId: task.id, projectId: task.projectId, action: "task.transitioned", actor: author, taskRevision: 2, detail: { from: "todo" }, createdAt: at });
        await appendAuditEntry(repos.audit, { projectId: task.projectId, actor: { kind: "human", name: "人" }, action: "task.transitioned", targetKind: "task", targetId: task.id, targetName: task.title });
        throw new RepositoryError("write_failed", "故障注入");
      }), code("write_failed"));
      assert.equal((await repos.tasks.get(task.projectId, task.id))?.state, "todo");
      assert.deepEqual(await repos.tasks.listHistory(task.projectId, task.id), []);
      assert.deepEqual(await repos.audit.list(task.projectId), []);
      assert.equal((await repos.tasks.get(task.projectId, task.id))?.revision, 1);
    });
  });

  test(`${engine} 工作事件持久化重投、仅接收人 ACK、幂等与任务状态独立`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const event = eventFor(task);
      assert.deepEqual(await repos.tasks.enqueueWorkEvent(event), event);
      assert.deepEqual(await repos.tasks.enqueueWorkEvent({ ...event, id: randomUUID() }), event);
      await assert.rejects(() => repos.tasks.enqueueWorkEvent({ ...event, id: randomUUID(), eventKey: "no-task", taskId: null }), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.enqueueWorkEvent({ ...event, id: randomUUID(), eventKey: "wrong-task", taskId: "missing" }), code("not_found"));
      const delivered = await repos.tasks.markWorkEventsDelivered(task.projectId, event.recipientMemberId, [event.id], at);
      assert.equal(delivered[0]?.attempts, 1);
      assert.equal(delivered[0]?.deliveryState, "delivered");
      await db.close();
      await db.connect();
      const reopened = createRepositories(db);
      assert.equal((await reopened.tasks.listUnackedWorkEvents(task.projectId, event.recipientMemberId))[0]?.id, event.id);
      const again = await reopened.tasks.markWorkEventsDelivered(task.projectId, event.recipientMemberId, [event.id, event.id], "2026-11-10T12:00:01.000Z");
      assert.equal(again[0]?.attempts, 2);
      assert.equal(again[0]?.firstDeliveredAt, at);
      await assert.rejects(() => reopened.tasks.acknowledgeWorkEvent(task.projectId, task.reviewerMemberId!, event.id, at), code("not_found"));
      assert.equal((await reopened.tasks.acknowledgeWorkEvent(task.projectId, event.recipientMemberId, event.id, at)).alreadyAcknowledged, false);
      assert.equal((await reopened.tasks.acknowledgeWorkEvent(task.projectId, event.recipientMemberId, event.id, at)).alreadyAcknowledged, true);
      assert.deepEqual(await reopened.tasks.listUnackedWorkEvents(task.projectId, event.recipientMemberId), []);
      assert.deepEqual(await reopened.tasks.markWorkEventsDelivered(task.projectId, event.recipientMemberId, [event.id], at), []);
      assert.equal((await reopened.tasks.get(task.projectId, task.id))?.revision, 1);
      assert.equal((await reopened.tasks.get(task.projectId, task.id))?.state, "todo");
      await reopened.projects.archive(task.projectId);
      await assert.rejects(() => reopened.tasks.acknowledgeWorkEvent(task.projectId, event.recipientMemberId, event.id, at), code("archived"));
    });
  });

  test(`${engine} 群组 purge 仅删除消息关联；项目 purge 新表计数完整且保留审计`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      await repos.tasks.setSettings(task.projectId, 0, task.reviewerMemberId);
      const round = await repos.tasks.createRound(roundFor(task));
      const report = await repos.tasks.addReport(reportFor(round));
      await repos.tasks.addComment({ id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "review_report", author,
        body: report.body, createdAt: at, reviewReportId: report.id });
      await repos.tasks.appendHistory({ id: randomUUID(), taskId: task.id, projectId: task.projectId, action: "review", actor: author, taskRevision: 1, detail: {}, createdAt: at });
      await repos.tasks.enqueueWorkEvent(eventFor(task));
      const groups: string[] = [];
      for (const name of ["将删除的群", "保留的群"]) {
        const group = await repos.groups.create({ projectId: task.projectId, name, participantMemberIds: [task.assigneeMemberId!] });
        const message = await repos.messages.create({ groupId: group.id, senderMemberId: task.assigneeMemberId!, body: name });
        await repos.tasks.linkMessage(task.projectId, { taskId: task.id, messageId: message.id, groupId: group.id, createdAt: at });
        groups.push(group.id);
      }
      const audit = await appendAuditEntry(repos.audit, { projectId: task.projectId, actor: { kind: "human", name: "人" }, action: "task.created", targetKind: "task", targetId: task.id, targetName: task.title });
      assert.equal((await repos.groups.previewPurge(groups[0]!)).taskMessageLinks, 1);
      assert.equal((await repos.groups.purge(groups[0]!)).taskMessageLinks, 1);
      assert.equal((await repos.tasks.listMessageLinks(task.projectId, task.id)).length, 1);
      assert.equal((await repos.tasks.listReports(task.projectId, task.id)).length, 1);
      assert.equal((await repos.tasks.listUnackedWorkEvents(task.projectId, task.assigneeMemberId!)).length, 1);
      const preview = await repos.projects.previewPurge(task.projectId);
      for (const key of ["taskSettings", "tasks", "taskComments", "taskHistory", "taskMessageLinks", "reviewRounds", "reviewReports", "workEvents"] as const) assert.equal(preview[key], 1, key);
      assert.deepEqual(await repos.projects.purge(task.projectId), preview);
      for (const table of ["project_task_settings", "tasks", "task_comments", "task_history", "task_message_links", "task_review_rounds", "task_review_reports", "work_events"]) {
        assert.equal(Number((await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))[0]?.c), 0, table);
      }
      assert.ok(await repos.audit.get(task.projectId, audit.id));
    });
  });

  test(`${engine} 所有任务写原语拒绝归档，仍保留只读内容`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const round = await repos.tasks.createRound(roundFor(task));
      const event = await repos.tasks.enqueueWorkEvent(eventFor(task));
      const group = await repos.groups.create({ projectId: task.projectId, name: "群", participantMemberIds: [task.assigneeMemberId!] });
      const message = await repos.messages.create({ groupId: group.id, senderMemberId: task.assigneeMemberId!, body: "消息" });
      await repos.projects.archive(task.projectId);
      const attempts = [
        () => repos.tasks.create({ ...task, id: randomUUID() }),
        () => repos.tasks.updateCas(task.projectId, task.id, 1, { title: "写入" }, at),
        () => repos.tasks.setSettings(task.projectId, 0, task.reviewerMemberId),
        () => repos.tasks.createRound(roundFor(task)),
        () => repos.tasks.updateRoundCas(task.projectId, round.id, 1, { state: "running" }, at),
        () => repos.tasks.addReport(reportFor(round)),
        () => repos.tasks.addComment({ id: randomUUID(), taskId: task.id, projectId: task.projectId, kind: "comment", author, body: "评论", createdAt: at, reviewReportId: null }),
        () => repos.tasks.appendHistory({ id: randomUUID(), taskId: task.id, projectId: task.projectId, action: "changed", actor: author, taskRevision: 1, detail: {}, createdAt: at }),
        () => repos.tasks.linkMessage(task.projectId, { taskId: task.id, messageId: message.id, groupId: group.id, createdAt: at }),
        () => repos.tasks.enqueueWorkEvent(event),
        () => repos.tasks.markWorkEventsDelivered(task.projectId, event.recipientMemberId, [event.id], at),
        () => repos.tasks.acknowledgeWorkEvent(task.projectId, event.recipientMemberId, event.id, at),
      ];
      for (const attempt of attempts) await assert.rejects(attempt, code("archived"));
      assert.deepEqual(await repos.tasks.get(task.projectId, task.id), task);
      assert.deepEqual(await repos.tasks.listRounds(task.projectId, task.id), [round]);
      assert.equal((await repos.tasks.listUnackedWorkEvents(task.projectId, event.recipientMemberId))[0]?.attempts, 0);
      assert.deepEqual(await repos.tasks.listComments(task.projectId, task.id), []);
      assert.deepEqual(await repos.tasks.listReports(task.projectId, task.id), []);
    });
  });

  test(`${engine} 创建轮次后的任务 CAS 失败不留孤轮；成员删除保留任务历史并清理事件`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const round = roundFor(task);
      await assert.rejects(() => repos.transaction(async () => {
        await repos.tasks.createRound(round);
        await repos.tasks.updateCas(task.projectId, task.id, 99, { currentReviewRoundId: round.id }, at);
      }), code("conflict"));
      assert.equal(await repos.tasks.getRound(task.projectId, task.id, round.id), null);
      await repos.tasks.appendHistory({ id: randomUUID(), taskId: task.id, projectId: task.projectId, action: "task.created", actor: author, taskRevision: 1, detail: {}, createdAt: at });
      await repos.tasks.enqueueWorkEvent(eventFor(task));
      await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, task.projectId, task.assigneeMemberId!);
      assert.equal((await repos.tasks.get(task.projectId, task.id))?.assigneeMemberId, null);
      const history = await repos.tasks.listHistory(task.projectId, task.id);
      assert.equal(history.length, 2);
      assert.ok(history.some(h => h.action === 'task.created'));
      assert.ok(history.some(h => h.action === 'member_removed' && h.taskRevision === 2));
      assert.deepEqual(await repos.tasks.listUnackedWorkEvents(task.projectId, task.assigneeMemberId!), []);
    });
  });

  test(`${engine} 停用旧评审人不阻塞无关编辑，新改派仍校验；缺失任务 CAS 冲突`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      await repos.members.setStatus(task.reviewerMemberId!, "disabled");
      const updated = await repos.tasks.updateCas(task.projectId, task.id, 1, { title: "补充说明" }, at);
      assert.equal(updated.title, "补充说明");
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, task.id, 2, { reviewerMemberId: task.reviewerMemberId }, at), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, "missing-task", 1, { title: "错误" }, at), code("conflict"));
    });
  });

  test(`${engine} 指派、轮次、评论、消息和工作事件拒绝跨项目引用`, { skip }, async () => {
    await withDb(engine, async (repos) => {
      const task = await fixture(repos);
      await repos.tasks.create(task);
      const other = await repos.projects.create({ name: "其他项目" });
      const worker = await repos.members.get(task.assigneeMemberId!);
      const reviewer = await repos.members.get(task.reviewerMemberId!);
      const foreignWorker = await repos.members.create({ projectId: other.id, agentId: worker!.agentId!, kind: "agent", displayName: "其他执行者" });
      const foreignReviewer = await repos.members.create({ projectId: other.id, agentId: reviewer!.agentId!, kind: "agent", displayName: "其他评审者" });
      const foreignTask = await repos.tasks.create({ ...task, id: randomUUID(), projectId: other.id, assigneeMemberId: foreignWorker.id, reviewerMemberId: foreignReviewer.id });
      const foreignRound = await repos.tasks.createRound(roundFor(foreignTask));
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, task.id, 1, { assigneeMemberId: foreignWorker.id }, at), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.updateCas(task.projectId, task.id, 1, { currentReviewRoundId: foreignRound.id }, at), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.addComment({ id: randomUUID(), projectId: task.projectId, taskId: foreignTask.id, kind: "comment", author, body: "越界", createdAt: at, reviewReportId: null }), code("not_found"));
      await assert.rejects(() => repos.tasks.addReport({ ...reportFor(foreignRound), projectId: task.projectId, taskId: task.id }), code("invalid_reference"));
      const group = await repos.groups.create({ projectId: other.id, name: "其他群", participantMemberIds: [foreignWorker.id] });
      const message = await repos.messages.create({ groupId: group.id, senderMemberId: foreignWorker.id, body: "其他消息" });
      await assert.rejects(() => repos.tasks.linkMessage(task.projectId, { taskId: task.id, messageId: message.id, groupId: group.id, createdAt: at }), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.enqueueWorkEvent({ ...eventFor(task), recipientMemberId: foreignWorker.id }), code("invalid_reference"));
      await assert.rejects(() => repos.tasks.enqueueWorkEvent({ ...eventFor(task), taskId: foreignTask.id }), code("not_found"));
      assert.deepEqual(await repos.tasks.get(task.projectId, task.id), task);
      assert.deepEqual(await repos.tasks.listComments(task.projectId, task.id), []);
      assert.deepEqual(await repos.tasks.listUnackedWorkEvents(task.projectId, task.assigneeMemberId!), []);
    });
  });
}

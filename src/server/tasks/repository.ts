import type { Task, TaskSettings, TaskState, TaskComment, TaskHistory, TaskMessageLink, ReviewRound, ReviewReport, WorkEvent } from "../../shared/tasks.ts";
import type { RepoCtx } from "../db/repositories.ts";
import { ArchivedError, ConflictError, InvalidArgumentError, InvalidReferenceError, NotFoundError } from "../db/errors.ts";
import { isDeepStrictEqual } from "node:util";

export interface TasksRepository {
  getSettings(projectId: string): Promise<TaskSettings>;
  setSettings(projectId: string, expectedRevision: number, reviewerMemberId: string | null): Promise<TaskSettings>;
  create(task: Task): Promise<Task>;
  get(projectId: string, taskId: string): Promise<Task | null>;
  list(projectId: string, filter?: { state?: TaskState; assigneeMemberId?: string }): Promise<Task[]>;
  updateCas(projectId: string, taskId: string, expectedRevision: number,
    patch: Partial<Pick<Task, 'title'|'body'|'labels'|'state'|'assigneeMemberId'|'reviewerMemberId'|'repoPath'|'fixedPoint'|'currentReviewRoundId'|'blockedReason'>>,
    at: string): Promise<Task>; // UPDATE ... WHERE revision=?；成功恰好 +1，零行 conflict
  addComment(comment: TaskComment): Promise<TaskComment>;
  listComments(projectId: string, taskId: string): Promise<TaskComment[]>;
  appendHistory(history: TaskHistory): Promise<void>;
  listHistory(projectId: string, taskId: string): Promise<TaskHistory[]>;
  hasCommented(projectId: string, taskId: string, memberId: string): Promise<boolean>;
  linkMessage(projectId: string, link: TaskMessageLink): Promise<TaskMessageLink>; // 同键幂等
  listMessageLinks(projectId: string, taskId: string): Promise<TaskMessageLink[]>;
  linkedTaskIds(projectId: string, messageId: string): Promise<string[]>;
  createRound(round: ReviewRound): Promise<ReviewRound>;
  getRound(projectId: string, taskId: string, roundId: string): Promise<ReviewRound | null>;
  listRounds(projectId: string, taskId: string): Promise<ReviewRound[]>;
  updateRoundCas(projectId: string, roundId: string, expectedRevision: number,
    patch: Partial<Pick<ReviewRound, 'state'|'decision'|'failure'>>, at: string): Promise<ReviewRound>;
  addReport(report: ReviewReport): Promise<ReviewReport>; // UNIQUE(round_id, axis)，同内容幂等，异内容冲突
  listReports(projectId: string, taskId: string, roundId?: string): Promise<ReviewReport[]>;
  enqueueWorkEvent(event: WorkEvent): Promise<WorkEvent>; // UNIQUE(recipient_member_id,event_key)
  listUnackedWorkEvents(projectId: string, memberId: string, limit?: number): Promise<WorkEvent[]>;
  markWorkEventsDelivered(projectId: string, memberId: string, ids: string[], at: string): Promise<WorkEvent[]>;
  acknowledgeWorkEvent(projectId: string, memberId: string, id: string, at: string): Promise<{ event: WorkEvent; alreadyAcknowledged: boolean }>;
}

type TaskRow = {
  id: string; project_id: string; title: string; body: string; labels: string; state: TaskState;
  assignee_member_id: string | null; reviewer_member_id: string | null; repo_path: string | null; fixed_point: string | null;
  revision: number; current_review_round_id: string | null; blocked_reason: string | null; author: string; created_at: string; updated_at: string;
};
type RoundRow = {
  id: string; task_id: string; project_id: string; revision: number; task_revision: number; state: ReviewRound["state"];
  reviewer_member_id: string; spec_snapshot: string; candidate: string | null; failure: string | null; decision: string | null;
  created_at: string; updated_at: string;
};
type ReportRow = {
  id: string; round_id: string; task_id: string; project_id: string; axis: ReviewReport["axis"]; verdict: ReviewReport["verdict"];
  body: string; sources: string; evidence: string; content_sha256: string; author: string; created_at: string;
};
type CommentRow = { id: string; task_id: string; project_id: string; kind: TaskComment["kind"]; author: string; body: string; created_at: string; review_report_id: string | null };
type HistoryRow = { id: string; task_id: string; project_id: string; action: string; actor: string; task_revision: number; detail: string; created_at: string };
type LinkRow = { task_id: string; message_id: string; group_id: string; created_at: string };
type EventRow = { id: string; project_id: string; recipient_member_id: string; task_id: string | null; kind: WorkEvent["kind"];
  event_key: string; payload: string; delivery_state: WorkEvent["deliveryState"]; attempts: number; created_at: string;
  first_delivered_at: string | null; last_delivered_at: string | null; acked_at: string | null };

function json(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("undefined");
    return result;
  } catch { throw new InvalidArgumentError("任务数据必须可序列化为 JSON。"); }
}

function toTask(row: TaskRow): Task {
  return { id: row.id, projectId: row.project_id, title: row.title, body: row.body, labels: JSON.parse(row.labels), state: row.state,
    assigneeMemberId: row.assignee_member_id, reviewerMemberId: row.reviewer_member_id, repoPath: row.repo_path, fixedPoint: row.fixed_point,
    revision: row.revision, currentReviewRoundId: row.current_review_round_id, blockedReason: row.blocked_reason,
    author: JSON.parse(row.author), createdAt: row.created_at, updatedAt: row.updated_at };
}

function toRound(row: RoundRow): ReviewRound {
  return { id: row.id, taskId: row.task_id, projectId: row.project_id, revision: row.revision, taskRevision: row.task_revision,
    state: row.state, reviewerMemberId: row.reviewer_member_id, specSnapshot: JSON.parse(row.spec_snapshot),
    candidate: row.candidate === null ? null : JSON.parse(row.candidate), failure: row.failure === null ? null : JSON.parse(row.failure),
    decision: row.decision === null ? null : JSON.parse(row.decision), createdAt: row.created_at, updatedAt: row.updated_at };
}

function toReport(row: ReportRow): ReviewReport {
  return { id: row.id, roundId: row.round_id, taskId: row.task_id, projectId: row.project_id, axis: row.axis, verdict: row.verdict,
    body: row.body, sources: JSON.parse(row.sources), evidence: JSON.parse(row.evidence), contentSha256: row.content_sha256,
    author: JSON.parse(row.author), createdAt: row.created_at };
}

function toComment(row: CommentRow): TaskComment {
  return { id: row.id, taskId: row.task_id, projectId: row.project_id, kind: row.kind, author: JSON.parse(row.author),
    body: row.body, createdAt: row.created_at, reviewReportId: row.review_report_id };
}

function toHistory(row: HistoryRow): TaskHistory {
  return { id: row.id, taskId: row.task_id, projectId: row.project_id, action: row.action, actor: JSON.parse(row.actor),
    taskRevision: row.task_revision, detail: JSON.parse(row.detail), createdAt: row.created_at };
}

function toLink(row: LinkRow): TaskMessageLink {
  return { taskId: row.task_id, messageId: row.message_id, groupId: row.group_id, createdAt: row.created_at };
}

function toEvent(row: EventRow): WorkEvent {
  return { id: row.id, projectId: row.project_id, recipientMemberId: row.recipient_member_id, taskId: row.task_id,
    kind: row.kind, eventKey: row.event_key, payload: JSON.parse(row.payload), deliveryState: row.delivery_state, attempts: row.attempts,
    createdAt: row.created_at, firstDeliveredAt: row.first_delivered_at, lastDeliveredAt: row.last_delivered_at, ackedAt: row.acked_at };
}

function revision(value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new InvalidArgumentError("revision 必须为有效整数。");
}

/** 所有方法复用注入的 RepoCtx；任务、历史、审计和事件可由调用方合成一个事务。 */
export function createTasksRepository(ctx: RepoCtx): TasksRepository {
  async function requireActive(projectId: string): Promise<void> {
    // 可移植的项目行写锁：归档与新任务写入不能在检查之后交错。
    if (await ctx.exec("UPDATE projects SET updated_at = updated_at WHERE id = ? AND archived_at IS NULL", [projectId])) return;
    const project = await ctx.one("SELECT id FROM projects WHERE id = ?", [projectId]);
    if (!project) throw new NotFoundError("任务所属项目不存在。");
    throw new ArchivedError("项目已归档，不能修改任务；请先恢复项目。");
  }

  async function requireMember(projectId: string, memberId: string | null, reviewer = false, active = true): Promise<void> {
    if (memberId === null) return;
    const member = await ctx.one<{ project_id: string; kind: string; status: string }>("SELECT project_id, kind, status FROM members WHERE id = ?", [memberId]);
    if (!member || member.project_id !== projectId) throw new InvalidReferenceError("成员不存在或不属于任务项目。");
    if ((active && member.status !== "active") || (reviewer && member.kind !== "agent")) throw new InvalidReferenceError("任务成员必须有效，评审人必须为在岗 Agent。");
  }

  async function requireTask(projectId: string, taskId: string): Promise<Task> {
    const task = await repo.get(projectId, taskId);
    if (!task) throw new NotFoundError("任务不存在或不属于当前项目。");
    return task;
  }

  async function checkTaskReferences(task: Task, activeAssignee = true, activeReviewer = true): Promise<void> {
    await requireMember(task.projectId, task.assigneeMemberId, false, activeAssignee);
    await requireMember(task.projectId, task.reviewerMemberId, true, activeReviewer);
    if (task.currentReviewRoundId !== null && !await ctx.one("SELECT id FROM task_review_rounds WHERE project_id = ? AND task_id = ? AND id = ?", [task.projectId, task.id, task.currentReviewRoundId])) {
      throw new InvalidReferenceError("当前评审轮次必须存在且属于同一任务与项目。");
    }
  }

  const repo: TasksRepository = {
    async getSettings(projectId) {
      if (!await ctx.one("SELECT id FROM projects WHERE id = ?", [projectId])) throw new NotFoundError("项目不存在。");
      const row = await ctx.one<{ default_reviewer_member_id: string | null; revision: number }>("SELECT default_reviewer_member_id, revision FROM project_task_settings WHERE project_id = ?", [projectId]);
      const reviewerId = row?.default_reviewer_member_id ?? null;
      const member = reviewerId === null ? undefined : await ctx.one<{ project_id: string; kind: string; status: string }>("SELECT project_id, kind, status FROM members WHERE id = ?", [reviewerId]);
      const valid = member?.project_id === projectId && member.kind === "agent" && member.status === "active";
      return { projectId, defaultReviewerMemberId: reviewerId, revision: row?.revision ?? 0, reviewerValid: valid,
        invalidReason: valid ? null : reviewerId === null ? "未配置默认评审人。" : "默认评审人已失效，请重新配置在岗 Agent。" };
    },
    async setSettings(projectId, expectedRevision, reviewerMemberId) {
      revision(expectedRevision, 0);
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        await requireMember(projectId, reviewerMemberId, true);
        if ((await repo.getSettings(projectId)).revision !== expectedRevision) throw new ConflictError("任务设置已更新，请重新读取后再试。");
        const changed = expectedRevision === 0
          ? await ctx.exec("INSERT INTO project_task_settings (project_id, default_reviewer_member_id, revision) VALUES (?, ?, 1) ON CONFLICT (project_id) DO NOTHING", [projectId, reviewerMemberId])
          : await ctx.exec("UPDATE project_task_settings SET default_reviewer_member_id = ?, revision = revision + 1 WHERE project_id = ? AND revision = ?", [reviewerMemberId, projectId, expectedRevision]);
        if (!changed) throw new ConflictError("任务设置已更新，请重新读取后再试。");
        return repo.getSettings(projectId);
      });
    },
    async create(task) {
      return ctx.withTransaction(async () => {
        await requireActive(task.projectId);
        if (task.revision !== 1) throw new InvalidArgumentError("新任务 revision 必须为 1。");
        await checkTaskReferences(task);
        await ctx.exec(`INSERT INTO tasks (id, project_id, title, body, labels, state, assignee_member_id, reviewer_member_id,
          repo_path, fixed_point, revision, current_review_round_id, blocked_reason, author, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [task.id, task.projectId, task.title, task.body, json(task.labels), task.state, task.assigneeMemberId, task.reviewerMemberId,
            task.repoPath, task.fixedPoint, task.revision, task.currentReviewRoundId, task.blockedReason, json(task.author), task.createdAt, task.updatedAt]);
        return (await repo.get(task.projectId, task.id))!;
      });
    },
    async get(projectId, taskId) {
      const row = await ctx.one<TaskRow>("SELECT * FROM tasks WHERE project_id = ? AND id = ?", [projectId, taskId]);
      return row ? toTask(row) : null;
    },
    async list(projectId, filter = {}) {
      const where = ["project_id = ?"];
      const params: unknown[] = [projectId];
      if (filter.state !== undefined) { where.push("state = ?"); params.push(filter.state); }
      if (filter.assigneeMemberId !== undefined) { where.push("assignee_member_id = ?"); params.push(filter.assigneeMemberId); }
      return (await ctx.query<TaskRow>(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY created_at, id`, params)).map(toTask);
    },
    async updateCas(projectId, taskId, expectedRevision, patch, at) {
      revision(expectedRevision);
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        const task = await repo.get(projectId, taskId);
        if (!task || task.revision !== expectedRevision) throw new ConflictError("任务已更新或不存在，请重新读取后再试。");
        const next = { ...task, ...patch };
        await checkTaskReferences(next, patch.assigneeMemberId !== undefined, patch.reviewerMemberId !== undefined);
        const columns = { title: "title", body: "body", labels: "labels", state: "state", assigneeMemberId: "assignee_member_id",
          reviewerMemberId: "reviewer_member_id", repoPath: "repo_path", fixedPoint: "fixed_point", currentReviewRoundId: "current_review_round_id", blockedReason: "blocked_reason" } as const;
        const changes: string[] = [];
        const values: unknown[] = [];
        for (const key of Object.keys(columns) as Array<keyof typeof columns>) {
          if (patch[key] === undefined) continue;
          changes.push(`${columns[key]} = ?`);
          values.push(key === "labels" ? json(patch.labels) : patch[key]);
        }
        changes.push("revision = revision + 1", "updated_at = ?");
        values.push(at, projectId, taskId, expectedRevision);
        if (!await ctx.exec(`UPDATE tasks SET ${changes.join(", ")} WHERE project_id = ? AND id = ? AND revision = ?`, values)) {
          throw new ConflictError("任务已更新，请重新读取后再试。");
        }
        return (await repo.get(projectId, taskId))!;
      });
    },
    async addComment(comment) {
      return ctx.withTransaction(async () => {
        await requireActive(comment.projectId);
        await requireTask(comment.projectId, comment.taskId);
        if (comment.reviewReportId !== null && !await ctx.one("SELECT id FROM task_review_reports WHERE project_id = ? AND task_id = ? AND id = ?", [comment.projectId, comment.taskId, comment.reviewReportId])) {
          throw new InvalidReferenceError("评审评论必须引用同任务与项目的报告。");
        }
        await ctx.exec(`INSERT INTO task_comments (id, task_id, project_id, kind, author, author_actor_id, body, created_at, review_report_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [comment.id, comment.taskId, comment.projectId, comment.kind, json(comment.author), comment.author.actorId, comment.body, comment.createdAt, comment.reviewReportId]);
        return toComment((await ctx.one<CommentRow>("SELECT * FROM task_comments WHERE id = ?", [comment.id]))!);
      });
    },
    async listComments(projectId, taskId) {
      return (await ctx.query<CommentRow>("SELECT * FROM task_comments WHERE project_id = ? AND task_id = ? ORDER BY created_at, id", [projectId, taskId])).map(toComment);
    },
    async appendHistory(history) {
      await ctx.withTransaction(async () => {
        await requireActive(history.projectId);
        await requireTask(history.projectId, history.taskId);
        revision(history.taskRevision);
        await ctx.exec(`INSERT INTO task_history (id, task_id, project_id, action, actor, task_revision, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [history.id, history.taskId, history.projectId, history.action, json(history.actor), history.taskRevision, json(history.detail), history.createdAt]);
      });
    },
    async listHistory(projectId, taskId) {
      return (await ctx.query<HistoryRow>("SELECT * FROM task_history WHERE project_id = ? AND task_id = ? ORDER BY created_at, id", [projectId, taskId])).map(toHistory);
    },
    async hasCommented(projectId, taskId, memberId) {
      return !!await ctx.one("SELECT id FROM task_comments WHERE project_id = ? AND task_id = ? AND author_actor_id = ? LIMIT 1", [projectId, taskId, memberId]);
    },
    async linkMessage(projectId, link) {
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        await requireTask(projectId, link.taskId);
        const message = await ctx.one<{ group_id: string; project_id: string }>("SELECT m.group_id, g.project_id FROM messages m JOIN groups g ON g.id = m.group_id WHERE m.id = ?", [link.messageId]);
        if (!message || message.group_id !== link.groupId || message.project_id !== projectId) throw new InvalidReferenceError("关联消息必须属于同一项目和指定群组。");
        await ctx.exec(`INSERT INTO task_message_links (task_id, message_id, project_id, group_id, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (task_id, message_id) DO NOTHING`, [link.taskId, link.messageId, projectId, link.groupId, link.createdAt]);
        return toLink((await ctx.one<LinkRow>("SELECT * FROM task_message_links WHERE project_id = ? AND task_id = ? AND message_id = ?", [projectId, link.taskId, link.messageId]))!);
      });
    },
    async listMessageLinks(projectId, taskId) {
      return (await ctx.query<LinkRow>("SELECT * FROM task_message_links WHERE project_id = ? AND task_id = ? ORDER BY created_at, message_id", [projectId, taskId])).map(toLink);
    },
    async linkedTaskIds(projectId, messageId) {
      return (await ctx.query<{ task_id: string }>("SELECT task_id FROM task_message_links WHERE project_id = ? AND message_id = ? ORDER BY task_id", [projectId, messageId])).map(row => row.task_id);
    },
    async createRound(round) {
      return ctx.withTransaction(async () => {
        await requireActive(round.projectId);
        await requireTask(round.projectId, round.taskId);
        await requireMember(round.projectId, round.reviewerMemberId, true);
        if (round.revision !== 1) throw new InvalidArgumentError("新评审轮次 revision 必须为 1。");
        revision(round.taskRevision);
        await ctx.exec(`INSERT INTO task_review_rounds (id, task_id, project_id, revision, task_revision, state,
          reviewer_member_id, spec_snapshot, candidate, failure, decision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [round.id, round.taskId, round.projectId, round.revision, round.taskRevision, round.state, round.reviewerMemberId,
            json(round.specSnapshot), round.candidate === null ? null : json(round.candidate), round.failure === null ? null : json(round.failure),
            round.decision === null ? null : json(round.decision), round.createdAt, round.updatedAt]);
        return (await repo.getRound(round.projectId, round.taskId, round.id))!;
      });
    },
    async getRound(projectId, taskId, roundId) {
      const row = await ctx.one<RoundRow>("SELECT * FROM task_review_rounds WHERE project_id = ? AND task_id = ? AND id = ?", [projectId, taskId, roundId]);
      return row ? toRound(row) : null;
    },
    async listRounds(projectId, taskId) {
      return (await ctx.query<RoundRow>("SELECT * FROM task_review_rounds WHERE project_id = ? AND task_id = ? ORDER BY created_at, id", [projectId, taskId])).map(toRound);
    },
    async updateRoundCas(projectId, roundId, expectedRevision, patch, at) {
      revision(expectedRevision);
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        const values: unknown[] = [];
        const changes: string[] = [];
        for (const key of ["state", "decision", "failure"] as const) {
          if (patch[key] === undefined) continue;
          changes.push(`${key} = ?`);
          values.push(key === "state" || patch[key] === null ? patch[key] : json(patch[key]));
        }
        changes.push("revision = revision + 1", "updated_at = ?");
        values.push(at, projectId, roundId, expectedRevision);
        if (!await ctx.exec(`UPDATE task_review_rounds SET ${changes.join(", ")} WHERE project_id = ? AND id = ? AND revision = ?`, values)) {
          throw new ConflictError("评审轮次已更新或不存在，请重新读取后再试。");
        }
        return toRound((await ctx.one<RoundRow>("SELECT * FROM task_review_rounds WHERE project_id = ? AND id = ?", [projectId, roundId]))!);
      });
    },
    async addReport(report) {
      return ctx.withTransaction(async () => {
        await requireActive(report.projectId);
        if (!await repo.getRound(report.projectId, report.taskId, report.roundId)) throw new InvalidReferenceError("报告轮次不存在或不属于当前任务与项目。");
        await ctx.exec(`INSERT INTO task_review_reports (id, round_id, task_id, project_id, axis, verdict, body, sources, evidence, content_sha256, author, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (round_id, axis) DO NOTHING`,
          [report.id, report.roundId, report.taskId, report.projectId, report.axis, report.verdict, report.body,
            json(report.sources), json(report.evidence), report.contentSha256, json(report.author), report.createdAt]);
        const saved = (await ctx.one<ReportRow>("SELECT * FROM task_review_reports WHERE project_id = ? AND task_id = ? AND round_id = ? AND axis = ?", [report.projectId, report.taskId, report.roundId, report.axis]))!;
        if (saved.content_sha256 !== report.contentSha256) throw new ConflictError("本轴报告已固定，不能用不同内容覆盖。");
        return toReport(saved);
      });
    },
    async listReports(projectId, taskId, roundId) {
      return (await ctx.query<ReportRow>(`SELECT * FROM task_review_reports WHERE project_id = ? AND task_id = ?${roundId === undefined ? "" : " AND round_id = ?"} ORDER BY created_at, id`,
        roundId === undefined ? [projectId, taskId] : [projectId, taskId, roundId])).map(toReport);
    },
    async enqueueWorkEvent(event) {
      return ctx.withTransaction(async () => {
        await requireActive(event.projectId);
        await requireMember(event.projectId, event.recipientMemberId);
        if (event.kind.startsWith("task.") && event.taskId === null) throw new InvalidReferenceError("任务事件必须引用真实任务。");
        if (event.taskId !== null) await requireTask(event.projectId, event.taskId);
        if (event.deliveryState !== "pending" || event.attempts !== 0 || event.firstDeliveredAt !== null || event.lastDeliveredAt !== null || event.ackedAt !== null) {
          throw new InvalidArgumentError("新工作事件必须处于尚未投递的初始状态。");
        }
        await ctx.exec(`INSERT INTO work_events (id, project_id, recipient_member_id, task_id, kind, event_key, payload, delivery_state,
          attempts, created_at, first_delivered_at, last_delivered_at, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (recipient_member_id, event_key) DO NOTHING`,
          [event.id, event.projectId, event.recipientMemberId, event.taskId, event.kind, event.eventKey, json(event.payload), event.deliveryState,
            event.attempts, event.createdAt, event.firstDeliveredAt, event.lastDeliveredAt, event.ackedAt]);
        const saved = (await ctx.one<EventRow>("SELECT * FROM work_events WHERE recipient_member_id = ? AND event_key = ?", [event.recipientMemberId, event.eventKey]))!;
        if (saved.project_id !== event.projectId || saved.task_id !== event.taskId || saved.kind !== event.kind || !isDeepStrictEqual(JSON.parse(saved.payload), event.payload)) {
          throw new ConflictError("工作事件幂等键已用于不同内容。");
        }
        return toEvent(saved);
      });
    },
    async listUnackedWorkEvents(projectId, memberId, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new InvalidArgumentError("事件数量必须为正整数。");
      return (await ctx.query<EventRow>("SELECT * FROM work_events WHERE project_id = ? AND recipient_member_id = ? AND delivery_state <> 'acked' ORDER BY created_at, id LIMIT ?",
        [projectId, memberId, limit])).map(toEvent);
    },
    async markWorkEventsDelivered(projectId, memberId, ids, at) {
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        await requireMember(projectId, memberId);
        const result: WorkEvent[] = [];
        for (const id of new Set(ids)) {
          const row = await ctx.one<EventRow>("SELECT * FROM work_events WHERE project_id = ? AND recipient_member_id = ? AND id = ?", [projectId, memberId, id]);
          if (!row) throw new NotFoundError("工作事件不存在或不属于当前接收人。");
          if (row.delivery_state === "acked") continue;
          await ctx.exec("UPDATE work_events SET delivery_state = 'delivered', attempts = attempts + 1, first_delivered_at = COALESCE(first_delivered_at, ?), last_delivered_at = ? WHERE project_id = ? AND recipient_member_id = ? AND id = ? AND delivery_state <> 'acked'", [at, at, projectId, memberId, id]);
          const saved = (await ctx.one<EventRow>("SELECT * FROM work_events WHERE project_id = ? AND recipient_member_id = ? AND id = ?", [projectId, memberId, id]))!;
          if (saved.delivery_state !== "acked") result.push(toEvent(saved));
        }
        return result;
      });
    },
    async acknowledgeWorkEvent(projectId, memberId, id, at) {
      return ctx.withTransaction(async () => {
        await requireActive(projectId);
        await requireMember(projectId, memberId);
        const row = await ctx.one<EventRow>("SELECT * FROM work_events WHERE project_id = ? AND recipient_member_id = ? AND id = ?", [projectId, memberId, id]);
        if (!row) throw new NotFoundError("工作事件不存在或不属于当前接收人。");
        if (row.delivery_state === "acked") return { event: toEvent(row), alreadyAcknowledged: true };
        const changed = await ctx.exec("UPDATE work_events SET delivery_state = 'acked', acked_at = ? WHERE project_id = ? AND recipient_member_id = ? AND id = ? AND delivery_state <> 'acked'", [at, projectId, memberId, id]);
        const saved = (await ctx.one<EventRow>("SELECT * FROM work_events WHERE project_id = ? AND recipient_member_id = ? AND id = ?", [projectId, memberId, id]))!;
        return { event: toEvent(saved), alreadyAcknowledged: changed === 0 };
      });
    },
  };
  return repo;
}

import { createHash } from "node:crypto";
import type { RepositorySet } from "../db/repositories.ts";
import type { Member } from "../db/types.ts";
import { ArchivedError, NotFoundError, RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { actorForMember } from "../authz/actors.ts";
import { orgActorForMember } from "../authz/org-actors.ts";
import { authorize, authorizeOrThrow, ForbiddenError, type Actor, type Capability, type DenyCode } from "../authz/authorize.ts";
import { appendAuditEntry, auditActorFrom } from "../audit.ts";
import type { CreateTaskInput, DecideReviewInput, ReviewCandidate, ReviewReport, ReviewRound, StartReviewResult, SubmitReviewReportInput,
  Task, TaskAuthor, TaskComment, TaskDetail, TaskMessageLink, TaskSettings, TaskState, TransitionTaskInput, UpdateTaskInput, WorkEvent } from "../../shared/tasks.ts";
import { beginTaskReviewSchema, commentTaskSchema, createTaskSchema, decideTaskReviewSchema, linkTaskMessageSchema, listTasksSchema,
  parseTaskInput, startTaskReviewSchema, submitReviewReportSchema, taskSettingsSchema, transitionTaskSchema, updateTaskSchema } from "./schemas.ts";
import { captureReviewCandidate } from "./candidate.ts";
import { TaskError } from "./errors.ts";

export interface TaskAccess {
  readonly actor: Actor;
  readonly connection?: { readonly projectId: string; readonly memberId: string; readonly groupId: string };
  readonly runMutation?: <T>(operation: "write" | "consume", body: () => Promise<T>) => Promise<T>;
}
export interface TaskService {
  getSettings(access: TaskAccess, projectId: string): Promise<TaskSettings>;
  setSettings(access: TaskAccess, projectId: string, input: { expectedRevision: number; defaultReviewerMemberId: string | null }): Promise<TaskSettings>;
  list(access: TaskAccess, projectId: string, filter?: { state?: TaskState; assigneeMemberId?: string }): Promise<Task[]>;
  get(access: TaskAccess, projectId: string, taskId: string): Promise<TaskDetail>;
  create(access: TaskAccess, projectId: string, input: CreateTaskInput): Promise<Task>;
  update(access: TaskAccess, projectId: string, taskId: string, input: UpdateTaskInput): Promise<Task>;
  transition(access: TaskAccess, projectId: string, taskId: string, input: TransitionTaskInput): Promise<Task>;
  comment(access: TaskAccess, projectId: string, taskId: string, body: string): Promise<TaskComment>;
  linkMessage(access: TaskAccess, projectId: string, taskId: string, messageId: string): Promise<TaskMessageLink>;
  canReadLinkedMessage(access: TaskAccess, projectId: string, messageId: string): Promise<boolean>;
  startReview(access: TaskAccess, projectId: string, taskId: string, input: { expectedRevision: number }): Promise<StartReviewResult>;
  beginReview(access: TaskAccess, projectId: string, taskId: string, roundId: string, input: { expectedTaskRevision: number; expectedRoundRevision: number }): Promise<ReviewRound>;
  submitReport(access: TaskAccess, projectId: string, taskId: string, roundId: string, input: SubmitReviewReportInput): Promise<ReviewReport>;
  decideReview(access: TaskAccess, projectId: string, taskId: string, roundId: string, input: DecideReviewInput): Promise<Task>;
  listWorkEvents(access: TaskAccess, projectId: string): Promise<WorkEvent[]>;
  deliverWorkEvents(access: TaskAccess, projectId: string, limit?: number): Promise<WorkEvent[]>;
  acknowledgeWorkEvent(access: TaskAccess, projectId: string, eventId: string): Promise<{ event: WorkEvent; alreadyAcknowledged: boolean }>;
}
export interface TaskServiceOptions {
  readonly repos: RepositorySet;
  readonly now?: () => Date;
  readonly captureCandidate?: (input: { repoPath: string; fixedPoint: string }) => Promise<ReviewCandidate>;
  readonly onWorkEvents?: (events: readonly WorkEvent[]) => void | Promise<void>;
  readonly onTaskChanged?: (projectId: string, taskId: string, revision: number) => void | Promise<void>;
}
type Context = { actor: Actor; author: TaskAuthor; at: string; events: WorkEvent[]; changed: Map<string, number> };
class GuardRollback extends RepositoryError {
  readonly denial: ForbiddenError;
  constructor(denial: ForbiddenError) { super("invalid_argument", denial.message); this.denial = denial; }
}
function deny(capability: Capability, reason: string, code: DenyCode = "forbidden"): never {
  throw new ForbiddenError({ allowed: false, capability, code, reason });
}

/** HTTP/MCP 只负责传输与可信身份；权限、业务状态、CAS 与同事务审计均在此处。 */
export function createTaskService(options: TaskServiceOptions): TaskService {
  const { repos } = options;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const capture = options.captureCandidate ?? captureReviewCandidate;
  async function actorFor(access: TaskAccess, projectId: string, write = false): Promise<Actor> {
    if (access.connection && (access.connection.projectId !== projectId || access.connection.memberId !== access.actor.actorId)) deny("task:view", "连接不属于请求项目或成员。", "out_of_connection");
    if (access.actor.projectId !== null && access.actor.projectId !== projectId) deny("task:view", "不能访问其他项目的任务。", "cross_project");
    let actor = access.actor;
    if (actor.kind === "agent") {
      const member = await repos.members.get(actor.actorId);
      if (!member || member.kind !== "agent" || member.projectId !== projectId || member.status !== "active") deny("task:view", "成员不存在、已离岗或不属于本项目。", "not_a_member");
      actor = (await orgActorForMember(repos, member.id)) ?? actorForMember(member);
    }
    authorizeOrThrow(actor, "task:view", { projectId });
    const project = await repos.projects.get(projectId);
    if (!project) throw new NotFoundError("项目不存在。");
    if (write && project.archivedAt !== null) throw new ArchivedError("项目已归档，请恢复项目后再修改任务。");
    return actor;
  }
  async function authorFor(actor: Actor): Promise<TaskAuthor> {
    return { kind: actor.kind, actorId: actor.actorId,
      displayName: actor.kind === "human" ? "人（owner）" : (await repos.members.get(actor.actorId))?.displayName ?? actor.actorId };
  }
  async function required(projectId: string, taskId: string): Promise<Task> {
    const task = await repos.tasks.get(projectId, taskId);
    if (!task) throw new NotFoundError("任务不存在或不属于当前项目。");
    return task;
  }
  async function validMember(projectId: string, id: string | null, reviewer = false): Promise<Member> {
    if (!id) throw new TaskError(reviewer ? "reviewer_required" : "assignee_required", reviewer ? "请先指定有效的评审 Agent。" : "请先指定任务负责人。", "invalid_reference");
    const member = await repos.members.get(id);
    if (!member || member.projectId !== projectId || member.status !== "active" || (reviewer && member.kind !== "agent")) {
      throw new TaskError(reviewer ? "reviewer_invalid" : "assignee_invalid", reviewer ? "评审人必须是本项目在岗的 Agent。" : "负责人必须是本项目在岗成员。", "invalid_reference");
    }
    return member;
  }
  async function reviewerFor(task: Pick<Task, "projectId" | "assigneeMemberId" | "reviewerMemberId">): Promise<Member> {
    const reviewer = await validMember(task.projectId, task.reviewerMemberId, true);
    if (reviewer.id === task.assigneeMemberId) throw new TaskError("reviewer_is_assignee", "评审人与负责人必须不同。");
    return reviewer;
  }
  async function manage(actor: Actor, task: Pick<Task, "projectId" | "assigneeMemberId">, capability: "task:create" | "task:manage" | "task:override" = "task:manage"): Promise<void> {
    const assignee = task.assigneeMemberId ? await repos.members.get(task.assigneeMemberId) : null;
    authorizeOrThrow(actor, capability, { projectId: task.projectId, nodeId: assignee?.nodeId ?? null });
  }
  async function progress(actor: Actor, task: Task): Promise<void> {
    if (actor.kind === "agent" && actor.actorId === task.assigneeMemberId) {
      authorizeOrThrow(actor, "task:update_own", { projectId: task.projectId, memberId: task.assigneeMemberId });
    } else await manage(actor, task);
  }
  function expect(task: Task, revision: number): void {
    if (task.revision !== revision) throw new TaskError("task_revision_conflict", "任务已被更新，请刷新后重试。", "conflict");
  }
  async function mutate<T>(access: TaskAccess, projectId: string, body: (ctx: Context) => Promise<T>, operation: "write" | "consume" = "write"): Promise<T> {
    const events: WorkEvent[] = []; const changed = new Map<string, number>();
    const work = () => repos.transaction(async () => {
      try {
        const actor = await actorFor(access, projectId, true);
        return await body({ actor, author: await authorFor(actor), at: now(), events, changed });
      } catch (error) {
        if (error instanceof ForbiddenError) throw new GuardRollback(error);
        throw error;
      }
    });
    let result: T;
    try { result = await (access.runMutation ? access.runMutation(operation, work) : work()); }
    catch (error) { if (error instanceof GuardRollback) throw error.denial; throw error; }
    // 提交后的通知失败不能使调用方误认为事务回滚；DB 队列是可靠来源。
    try { if (events.length) await options.onWorkEvents?.(events); }
    catch { console.warn("task_work_event_notification_failed", { projectId }); }
    for (const [taskId, revision] of changed) {
      try { await options.onTaskChanged?.(projectId, taskId, revision); }
      catch { console.warn("task_change_notification_failed", { projectId, taskId }); }
    }
    return result;
  }
  async function history(ctx: Context, task: Task, action: string, detail: Record<string, unknown> = {}, auditDetail = detail): Promise<void> {
    await repos.tasks.appendHistory({ id: newId(), projectId: task.projectId, taskId: task.id, action, actor: ctx.author, taskRevision: task.revision, detail, createdAt: ctx.at });
    await appendAuditEntry(repos.audit, { projectId: task.projectId, actor: auditActorFrom(ctx.actor), action, targetKind: "task", targetId: task.id, targetName: task.title, detail: auditDetail });
    ctx.changed.set(task.id, task.revision);
  }
  async function event(ctx: Context, task: Task, memberId: string | null, kind: WorkEvent["kind"], key: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!memberId) return;
    const record = await repos.tasks.enqueueWorkEvent({ id: newId(), projectId: task.projectId, taskId: task.id, recipientMemberId: memberId,
      kind, eventKey: key, payload: { taskId: task.id, revision: task.revision, ...payload }, deliveryState: "pending", attempts: 0,
      createdAt: ctx.at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    ctx.events.push(record);
  }
  async function supersede(ctx: Context, task: Task): Promise<void> {
    if (!task.currentReviewRoundId) return;
    const round = await repos.tasks.getRound(task.projectId, task.id, task.currentReviewRoundId);
    if (round && round.state !== "superseded") await repos.tasks.updateRoundCas(task.projectId, round.id, round.revision, { state: "superseded" }, ctx.at);
  }
  async function escalation(task: Task): Promise<string | null> {
    const member = task.assigneeMemberId ? await repos.members.get(task.assigneeMemberId) : null;
    const root = await repos.org.getRootNode(task.projectId);
    if (!root) {
      const legacy = await repos.members.getManager(task.projectId);
      return legacy?.status === "active" && legacy.id !== task.assigneeMemberId ? legacy.id : null;
    }
    const nodes = await repos.org.listNodes(task.projectId); const members = await repos.members.listByProject(task.projectId);
    const byNode = new Map(nodes.map(node => [node.id, node]));
    let parentId = member?.nodeId ? byNode.get(member.nodeId)?.parentId ?? null : null;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId); const node = byNode.get(parentId);
      if (!node) break;
      const manager = members.find(item => item.nodeId === parentId && item.status === "active" && item.kind === "agent" && item.id !== task.assigneeMemberId);
      if (manager && ["top_manager", "sub_manager"].includes(node.role)) return manager.id;
      parentId = node.parentId;
    }
    return null;
  }
  async function messageVisible(access: TaskAccess, projectId: string, messageId: string, actor: Actor): Promise<boolean> {
    const message = await repos.messages.get(messageId);
    if (!message) return false;
    const group = await repos.groups.get(message.groupId);
    if (!group || group.projectId !== projectId || (access.connection && access.connection.groupId !== group.id)) return false;
    const members = await repos.groups.participants(group.id);
    const decision = authorize(actor, "group:view", { projectId, groupId: group.id, groupMemberIds: members,
      groupMemberNodeIds: await Promise.all(members.map(async id => (await repos.members.get(id))?.nodeId ?? null)) });
    if (!decision.allowed) return false;
    if (actor.kind === "human" || actor.role === "top_manager" || actor.role === "sub_manager") return true;
    if (message.senderMemberId === actor.actorId || message.mentions.includes(actor.actorId)) return true;
    for (const taskId of await repos.tasks.linkedTaskIds(projectId, messageId)) {
      const task = await repos.tasks.get(projectId, taskId);
      if (task && (task.assigneeMemberId === actor.actorId || task.reviewerMemberId === actor.actorId || await repos.tasks.hasCommented(projectId, taskId, actor.actorId))) return true;
    }
    return false;
  }
  function ownRecipient(access: TaskAccess, actor: Actor, projectId: string): string {
    if (actor.kind !== "agent" || !access.connection || access.connection.memberId !== actor.actorId || access.connection.projectId !== projectId) deny("work_event:own", "工作事件仅由已绑定的接收 Agent 读取和确认。", "not_self");
    authorizeOrThrow(actor, "work_event:own", { projectId, memberId: actor.actorId });
    return actor.actorId;
  }
  async function requiredRound(projectId: string, taskId: string, roundId: string): Promise<ReviewRound> {
    const round = await repos.tasks.getRound(projectId, taskId, roundId);
    if (!round) throw new NotFoundError("评审轮次不存在或不属于当前任务。");
    return round;
  }
  async function requireReviewer(actor: Actor, task: Task, round: ReviewRound): Promise<void> {
    await reviewerFor(task);
    if (actor.kind !== "agent" || actor.actorId !== task.reviewerMemberId || actor.actorId !== round.reviewerMemberId) deny("task:review", "只有本轮指定的评审 Agent 可提交报告和普通裁决。", "not_self");
    authorizeOrThrow(actor, "task:review", { projectId: task.projectId, memberId: round.reviewerMemberId });
  }
  function currentRound(task: Task, round: ReviewRound, taskRevision: number, roundRevision: number, states: readonly ReviewRound["state"][]): void {
    expect(task, taskRevision);
    if (task.currentReviewRoundId !== round.id || round.revision !== roundRevision || !states.includes(round.state)) throw new TaskError("review_round_conflict", "评审轮次已变化，请刷新当前任务与轮次。", "conflict");
    const matchingRevision = round.state === "decided" ? round.decision?.taskRevision : round.taskRevision;
    if (matchingRevision !== task.revision || (round.state !== "decided" && task.state !== "review")) throw new TaskError("review_candidate_stale", "任务已离开这份评审候选，请重新提交评审。", "conflict");
  }
  function verifyEvidence(round: ReviewRound, input: SubmitReviewReportInput, other: ReviewReport | undefined): void {
    const candidate = round.candidate; const evidence = input.evidence;
    if (!candidate || evidence.baseCommit !== candidate.baseCommit || evidence.candidateCommit !== candidate.candidateCommit || evidence.diffSha256 !== candidate.diffSha256) {
      throw new TaskError("review_evidence_candidate_mismatch", "报告证据与本轮固定候选不一致。");
    }
    const start = Date.parse(evidence.startedAt); const end = Date.parse(evidence.completedAt);
    if (!(start < end) || evidence.command.exitCode !== 0 || Date.parse(evidence.command.startedAt) > start || Date.parse(evidence.command.completedAt) < end) {
      throw new TaskError("review_evidence_execution_invalid", "评审命令必须成功，执行时间必须有效并覆盖模型评审区间。");
    }
    if (other && (other.evidence.parentRunId !== evidence.parentRunId || other.evidence.invocationId === evidence.invocationId || other.evidence.contextId === evidence.contextId
      || Math.max(start, Date.parse(other.evidence.startedAt)) >= Math.min(end, Date.parse(other.evidence.completedAt)))) {
      throw new TaskError("review_axes_not_independent", "两轴必须属于同一轮并行调度，使用不同 invocation 和独立上下文，执行区间须重叠。");
    }
  }
  const service: TaskService = {
    async getSettings(access, projectId) { await actorFor(access, projectId); return repos.tasks.getSettings(projectId); },
    async setSettings(access, projectId, input) {
      const value = parseTaskInput(taskSettingsSchema, input);
      return mutate(access, projectId, async ctx => {
        authorizeOrThrow(ctx.actor, "task:settings", { projectId });
        if (value.defaultReviewerMemberId !== null) await validMember(projectId, value.defaultReviewerMemberId, true);
        const settings = await repos.tasks.setSettings(projectId, value.expectedRevision, value.defaultReviewerMemberId);
        await appendAuditEntry(repos.audit, { projectId, actor: auditActorFrom(ctx.actor), action: "task.settings_updated", targetKind: "project", targetId: projectId, targetName: "任务设置", after: settings });
        return settings;
      });
    },
    async list(access, projectId, filter = {}) { const parsed = parseTaskInput(listTasksSchema, filter); await actorFor(access, projectId); return repos.tasks.list(projectId, parsed); },
    async get(access, projectId, taskId) {
      const actor = await actorFor(access, projectId); const task = await required(projectId, taskId);
      const [comments, records, rounds, reports, links] = await Promise.all([repos.tasks.listComments(projectId, taskId), repos.tasks.listHistory(projectId, taskId), repos.tasks.listRounds(projectId, taskId), repos.tasks.listReports(projectId, taskId), repos.tasks.listMessageLinks(projectId, taskId)]);
      const messageLinks: TaskMessageLink[] = [];
      for (const link of links) if (await messageVisible(access, projectId, link.messageId, actor)) messageLinks.push(link);
      return { task, comments, history: records, rounds, reports, messageLinks };
    },
    async create(access, projectId, input) {
      const value = parseTaskInput(createTaskSchema, input);
      return mutate(access, projectId, async ctx => {
        await manage(ctx.actor, { projectId, assigneeMemberId: value.assigneeMemberId }, "task:create");
        await validMember(projectId, value.assigneeMemberId);
        const reviewerMemberId = value.reviewerMemberId ?? (await repos.tasks.getSettings(projectId)).defaultReviewerMemberId;
        await reviewerFor({ projectId, assigneeMemberId: value.assigneeMemberId, reviewerMemberId });
        const task = await repos.tasks.create({ id: newId(), projectId, title: value.title, body: value.body, labels: value.labels ?? [],
          assigneeMemberId: value.assigneeMemberId, reviewerMemberId, repoPath: value.repoPath ?? null, fixedPoint: value.fixedPoint ?? null,
          state: "todo", revision: 1, currentReviewRoundId: null, blockedReason: null, author: ctx.author, createdAt: ctx.at, updatedAt: ctx.at });
        await history(ctx, task, "task.created");
        await event(ctx, task, task.assigneeMemberId, "task.assigned", `task:${task.id}:revision:1:assigned`);
        return task;
      });
    },
    async update(access, projectId, taskId, input) {
      const { expectedRevision, ...patch } = parseTaskInput(updateTaskSchema, input);
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId); await manage(ctx.actor, task); expect(task, expectedRevision);
        if (task.state === "done") throw new TaskError("task_reopen_required", "请先重开已完成任务再修改。", "conflict");
        if (Object.keys(patch).length === 0 || Object.entries(patch).every(([key, value]) => JSON.stringify(task[key as keyof Task]) === JSON.stringify(value))) return task;
        const next = { ...task, ...patch };
        await manage(ctx.actor, next);
        if (patch.assigneeMemberId !== undefined) await validMember(projectId, next.assigneeMemberId);
        if (patch.reviewerMemberId !== undefined) await validMember(projectId, next.reviewerMemberId, true);
        if (next.assigneeMemberId !== null && next.assigneeMemberId === next.reviewerMemberId) throw new TaskError("reviewer_is_assignee", "评审人与负责人必须不同。");
        await supersede(ctx, task);
        const updated = await repos.tasks.updateCas(projectId, taskId, expectedRevision, { ...patch,
          ...(task.state === "review" ? { state: "in-progress" as const } : {}), currentReviewRoundId: null }, ctx.at);
        await history(ctx, updated, "task.updated", { fields: Object.keys(patch), previousRevision: task.revision });
        if (updated.assigneeMemberId !== task.assigneeMemberId) await event(ctx, updated, updated.assigneeMemberId, "task.assigned", `task:${task.id}:revision:${updated.revision}:assigned`);
        return updated;
      });
    },
    async transition(access, projectId, taskId, input) {
      const value = parseTaskInput(transitionTaskSchema, input);
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId); await progress(ctx.actor, task); expect(task, value.expectedRevision);
        if (task.state === value.state) return task;
        const valid: Record<TaskState, readonly TaskState[]> = { todo: ["in-progress", "blocked"], "in-progress": ["blocked"], blocked: ["in-progress"], review: ["in-progress", "blocked"], done: ["in-progress"] };
        if (!valid[task.state].includes(value.state)) throw new TaskError("task_transition_invalid", "此任务状态不能直接切换到目标状态。", "conflict");
        if (task.state === "done") { await manage(ctx.actor, task, "task:override"); if (!value.reason) throw new TaskError("task_reason_required", "重开任务需要说明原因。"); }
        if (value.state === "blocked" && !value.reason) throw new TaskError("task_reason_required", "标记阻塞需要说明原因。");
        await supersede(ctx, task);
        const updated = await repos.tasks.updateCas(projectId, taskId, value.expectedRevision, { state: value.state, blockedReason: value.state === "blocked" ? value.reason! : null, currentReviewRoundId: null }, ctx.at);
        const detail: Record<string, unknown> = { from: task.state, to: updated.state, reason: value.reason ?? null };
        if (updated.state === "blocked") {
          const recipientMemberId = await escalation(updated);
          detail["escalation"] = { recipientMemberId, unresolved: recipientMemberId === null };
          await event(ctx, updated, recipientMemberId, "task.blocked", `task:${taskId}:revision:${updated.revision}:blocked`, { reason: value.reason });
        }
        await history(ctx, updated, "task.transitioned", detail); return updated;
      });
    },
    async comment(access, projectId, taskId, body) {
      const value = parseTaskInput(commentTaskSchema, { body });
      return mutate(access, projectId, async ctx => {
        authorizeOrThrow(ctx.actor, "task:comment", { projectId }); const task = await required(projectId, taskId);
        const comment = await repos.tasks.addComment({ id: newId(), projectId, taskId, kind: "comment", author: ctx.author, body: value.body, createdAt: ctx.at, reviewReportId: null });
        await history(ctx, task, "task.commented", { commentId: comment.id }); return comment;
      });
    },
    async linkMessage(access, projectId, taskId, messageId) {
      parseTaskInput(linkTaskMessageSchema, { messageId });
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId);
        if (!await messageVisible(access, projectId, messageId, ctx.actor)) deny("group:view", "只能关联当前有权读取的群组消息。", "not_visible");
        const prior = (await repos.tasks.listMessageLinks(projectId, taskId)).find(link => link.messageId === messageId);
        if (prior) return prior;
        const message = (await repos.messages.get(messageId))!;
        const link = await repos.tasks.linkMessage(projectId, { taskId, messageId, groupId: message.groupId, createdAt: ctx.at });
        // history 对全项目可读；具体消息引用仅在经过群组过滤的 messageLinks 或受限审计中返回。
        await history(ctx, task, "task.message_linked", { linked: true }, { messageId, groupId: message.groupId }); return link;
      });
    },
    async canReadLinkedMessage(access, projectId, messageId) {
      try { return await messageVisible(access, projectId, messageId, await actorFor(access, projectId)); }
      catch (error) { if (error instanceof ForbiddenError || error instanceof NotFoundError) return false; throw error; }
    },
    async startReview(access, projectId, taskId, input) {
      const value = parseTaskInput(startTaskReviewSchema, input);
      const prepare = async (ctx: Context) => {
        const task = await required(projectId, taskId); await progress(ctx.actor, task); expect(task, value.expectedRevision);
        if (task.state !== "in-progress") throw new TaskError("review_state_invalid", "只有进行中的任务可以提交评审。", "conflict");
        await validMember(projectId, task.assigneeMemberId); await reviewerFor(task);
        return task;
      };
      const snapshot = await mutate(access, projectId, prepare, "consume");
      let candidate: ReviewCandidate | null = null; let failure: ReviewRound["failure"] = null;
      // 真正的 Git 工作在任何 DB/managed authority 事务外，提交时再进入短 fence。
      try {
        if (!snapshot.body.trim()) throw new TaskError("review_spec_required", "任务正文为空，请先写明评审需求与验收条件。");
        if (!snapshot.repoPath || !snapshot.fixedPoint) throw new TaskError("review_source_required", "请先填写仓库路径和 fixed point。");
        candidate = await capture({ repoPath: snapshot.repoPath, fixedPoint: snapshot.fixedPoint });
      } catch (error) {
        failure = { code: error instanceof TaskError ? error.reason : "review_capture_failed", message: error instanceof TaskError ? error.message : "无法获取完整 Git 候选，请检查仓库后重试。" };
      }
      return mutate(access, projectId, async ctx => {
        const task = await prepare(ctx);
        const round: ReviewRound = { id: newId(), projectId, taskId, revision: 1, taskRevision: task.revision + (failure ? 0 : 1),
          state: failure ? "failed" : "ready", reviewerMemberId: task.reviewerMemberId!, specSnapshot: { title: task.title, body: task.body, labels: [...task.labels] },
          candidate, failure, decision: null, createdAt: ctx.at, updatedAt: ctx.at };
        await repos.tasks.createRound(round);
        if (failure) {
          await history(ctx, task, "task.review_failed", { roundId: round.id, failure });
          return { ready: false as const, task, round, error: failure };
        }
        const updated = await repos.tasks.updateCas(projectId, taskId, task.revision, { state: "review", currentReviewRoundId: round.id, blockedReason: null }, ctx.at);
        await history(ctx, updated, "task.review_started", { roundId: round.id, baseCommit: candidate!.baseCommit, candidateCommit: candidate!.candidateCommit, diffSha256: candidate!.diffSha256 });
        await event(ctx, updated, updated.reviewerMemberId, "task.review_ready", `review:${round.id}:ready`, { roundId: round.id });
        return { ready: true as const, task: updated, round };
      });
    },
    async beginReview(access, projectId, taskId, roundId, input) {
      const value = parseTaskInput(beginTaskReviewSchema, input);
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId); const round = await requiredRound(projectId, taskId, roundId);
        await requireReviewer(ctx.actor, task, round);
        currentRound(task, round, value.expectedTaskRevision, value.expectedRoundRevision, ["ready"]);
        const updated = await repos.tasks.updateRoundCas(projectId, roundId, round.revision, { state: "running" }, ctx.at);
        await history(ctx, task, "task.review_begun", { roundId, roundRevision: updated.revision }); return updated;
      });
    },
    async submitReport(access, projectId, taskId, roundId, input) {
      const value = parseTaskInput(submitReviewReportSchema, input);
      const contentSha256 = createHash("sha256").update(JSON.stringify({ axis: value.axis, verdict: value.verdict, body: value.body, sources: value.sources, evidence: value.evidence })).digest("hex");
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId); const round = await requiredRound(projectId, taskId, roundId);
        await requireReviewer(ctx.actor, task, round);
        const reports = await repos.tasks.listReports(projectId, taskId, roundId);
        const previous = reports.find(report => report.axis === value.axis);
        if (previous) {
          if (previous.contentSha256 === contentSha256) return previous;
          throw new TaskError("review_report_immutable", "本轮该轴报告已保存；不能用不同内容覆盖。", "conflict");
        }
        currentRound(task, round, value.expectedTaskRevision, value.expectedRoundRevision, ["running"]);
        const other = reports.find(report => report.axis !== value.axis);
        verifyEvidence(round, value, other);
        // 每个新轴都先 CAS，包括第一轴仍 running；PG 并发的失败方刷新 revision 后再重试。
        await repos.tasks.updateRoundCas(projectId, roundId, round.revision, { state: other ? "reported" : "running" }, ctx.at);
        const report = await repos.tasks.addReport({ id: newId(), projectId, taskId, roundId, axis: value.axis, verdict: value.verdict,
          body: value.body, sources: value.sources, evidence: value.evidence, contentSha256, author: ctx.author, createdAt: ctx.at });
        await repos.tasks.addComment({ id: newId(), projectId, taskId, kind: "review_report", author: ctx.author, body: value.body, createdAt: ctx.at, reviewReportId: report.id });
        await history(ctx, task, "task.review_reported", { roundId, reportId: report.id, axis: report.axis, verdict: report.verdict }); return report;
      });
    },
    async decideReview(access, projectId, taskId, roundId, input) {
      const value = parseTaskInput(decideTaskReviewSchema, input);
      return mutate(access, projectId, async ctx => {
        const task = await required(projectId, taskId); const round = await requiredRound(projectId, taskId, roundId);
        if (value.override) await manage(ctx.actor, task, "task:override"); else await requireReviewer(ctx.actor, task, round);
        currentRound(task, round, value.expectedTaskRevision, value.expectedRoundRevision, value.override ? ["reported", "decided"] : ["reported"]);
        const reports = await repos.tasks.listReports(projectId, taskId, roundId);
        if (!round.candidate || reports.length !== 2 || !reports.some(report => report.axis === "spec") || !reports.some(report => report.axis === "standards")) {
          throw new TaskError("review_reports_required", "完整有效候选与两轴报告齐备后才能裁决。", "conflict");
        }
        if (!value.override && value.verdict === "pass" && reports.some(report => report.verdict !== "pass")) throw new TaskError("review_axis_rejected", "仍有评审轴要求修改，不能作普通通过裁决。", "conflict");
        const updated = await repos.tasks.updateCas(projectId, taskId, task.revision, { state: value.verdict === "pass" ? "done" : "in-progress", blockedReason: null }, ctx.at);
        const decision: NonNullable<ReviewRound["decision"]> = { verdict: value.verdict, actor: ctx.author, reason: value.reason, override: value.override ?? false, taskRevision: updated.revision };
        await history(ctx, updated, "task.review_decided", { roundId, previousDecision: round.decision, decision });
        await repos.tasks.updateRoundCas(projectId, roundId, round.revision, { state: "decided", decision }, ctx.at);
        await event(ctx, updated, updated.assigneeMemberId, "task.review_decided", `review:${roundId}:revision:${round.revision + 1}:decided`, { roundId, decision });
        return updated;
      });
    },
    async listWorkEvents(access, projectId) {
      const actor = await actorFor(access, projectId); return repos.tasks.listUnackedWorkEvents(projectId, ownRecipient(access, actor, projectId));
    },
    async deliverWorkEvents(access, projectId, limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TaskError("work_event_limit_invalid", "工作事件数量须为 1～100。");
      return mutate(access, projectId, async ctx => {
        const memberId = ownRecipient(access, ctx.actor, projectId);
        const events = await repos.tasks.listUnackedWorkEvents(projectId, memberId, limit);
        return repos.tasks.markWorkEventsDelivered(projectId, memberId, events.map(item => item.id), ctx.at);
      }, "consume");
    },
    async acknowledgeWorkEvent(access, projectId, eventId) {
      return mutate(access, projectId, async ctx => repos.tasks.acknowledgeWorkEvent(projectId, ownRecipient(access, ctx.actor, projectId), eventId, ctx.at));
    },
  };
  return service;
}

import { isWorkEventEligible } from "../tasks/work-event-storage.ts";
import { validateLiveCompletionSource } from '../decisions/storage-validation.ts';
import { createHash } from "node:crypto";
import type { MemoryAuthor, MemoryConfig, MemoryDocument, MemoryInjection, MemoryKey, MemorySummaryPacket, MemorySummaryRequest,
  MemoryVersion, MemoryWriteSource, SelfSummaryEvidence, SubmitMemorySummaryInput, SummaryTrigger, WriteMemoryInput, WriteMemoryResult } from "../../shared/memory.ts";
import type { WorkEvent } from "../../shared/tasks.ts";
import type { RepositorySet } from "../db/repositories.ts";
import type { Member } from "../db/types.ts";
import { ArchivedError, NotFoundError, RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { actorForMember } from "../authz/actors.ts";
import { orgActorForMember } from "../authz/org-actors.ts";
import { authorizeOrThrow, ForbiddenError, type Actor, type Capability, type DenyCode } from "../authz/authorize.ts";
import { appendAuditEntry, auditActorFrom } from "../audit.ts";
import { resolveMemoryConfig } from "../config.ts";
import type { TaskAccess } from "../tasks/service.ts";
import type { MemoryInjectionReader } from "./injection-reader.ts";
import { assertMemoryMarkdown, truncateGraphemes, unavailableMemory } from "./injection.ts";
import { MemoryError } from "./errors.ts";
import { reconcileMessageThresholdPage, reconcileTaskCompletionPage } from "./triggers.ts";
import { discoverDomainMutation, type DomainMutationTargets } from "../mutation-access.ts";

export type MemoryAccess = TaskAccess & { readonly injectionBindingGeneration?: string };
export interface MemoryService {
  list(access: MemoryAccess, projectId: string): Promise<MemoryDocument[]>;
  read(access: MemoryAccess, key: MemoryKey): Promise<{ document: MemoryDocument | null; version: number }>;
  history(access: MemoryAccess, key: MemoryKey, beforeVersion?: number): Promise<MemoryVersion[]>;
  readVersion(access: MemoryAccess, key: MemoryKey, version: number): Promise<MemoryVersion | null>;
  write(access: MemoryAccess, key: MemoryKey, input: WriteMemoryInput): Promise<WriteMemoryResult>;
  inject(access: MemoryAccess): Promise<MemoryInjection>;
  reconcileTriggers(access: MemoryAccess): Promise<{ scheduled: number }>;
  reportSessionEnd(access: MemoryAccess, clientMutationId: string): Promise<{ summaryScheduled: boolean; requestId: string | null; errorCode?: string }>;
  listSummaryRequests(access: MemoryAccess, projectId: string, agentId?: string): Promise<MemorySummaryRequest[]>;
  readSummaryPacket(access: MemoryAccess, requestId: string): Promise<MemorySummaryPacket>;
  beginSummary(access: MemoryAccess, requestId: string, input: { expectedRevision: number; clientMutationId: string }): Promise<MemorySummaryRequest>;
  submitSummary(access: MemoryAccess, requestId: string, input: SubmitMemorySummaryInput): Promise<WriteMemoryResult>;
  failSummary(access: MemoryAccess, requestId: string, input: { expectedRevision: number; attemptId: string; code: string }): Promise<MemorySummaryRequest>;
  retrySummary(access: MemoryAccess, requestId: string, clientMutationId: string): Promise<MemorySummaryRequest>;
}
export interface MemoryServiceOptions {
  repos: RepositorySet;
  config: MemoryConfig;
  now?: () => Date;
  injectionReader: MemoryInjectionReader;
  readVisibleMessages: (access: MemoryAccess, ids: readonly string[]) => Promise<MemorySummaryPacket["messages"]>;
  onWorkEvents?: (events: readonly WorkEvent[]) => void | Promise<void>;
}
type Context = { projectId: string; actor: Actor; member: Member | null; author: MemoryAuthor; at: string; events: WorkEvent[] };
type Outcome<T> = { value: T; error?: never } | { error: MemoryError; value?: never };
type SummarySource = { trigger: SummaryTrigger; triggerKey: string; contextGroupId: string | null;
  taskId?: string | null; completedTaskRevision?: number | null; messageIds?: string[];
  sourceWorkEventId?: string | null; retryOfRequestId?: string | null };
type InvalidSummary = { state: "failed" | "conflicted" | "cancelled"; code: string; message: string };
class GuardRollback extends RepositoryError {
  readonly denial: ForbiddenError;
  constructor(denial: ForbiddenError) { super("invalid_argument", denial.message); this.denial = denial; }
}
function deny(capability: Capability, reason: string, code: DenyCode = "forbidden"): never {
  throw new ForbiddenError({ allowed: false, capability, code, reason });
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) throw new MemoryError("memory_invalid_input", "记忆标识必须是非空的有效字符串。");
}
function integer(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new MemoryError("memory_invalid_input", "记忆版本必须为有效整数。");
}
function validKey(key: MemoryKey): void {
  if (!key || typeof key !== "object") throw new MemoryError("memory_invalid_input", "记忆 scope 无效。");
  if (key.scope === "global" && key.projectId === null) { identifier(key.agentId); return; }
  if (key.scope === "project" && key.agentId === null) { identifier(key.projectId); return; }
  if (key.scope === "project-agent") { identifier(key.projectId); identifier(key.agentId); return; }
  throw new MemoryError("memory_invalid_input", "记忆 scope 与归属不匹配。");
}
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const requestKey = (request: MemorySummaryRequest): MemoryKey => ({ scope: "project-agent", projectId: request.projectId, agentId: request.agentId });
const summaryEventId = (requestId: string) => `memory-summary:${requestId}`;
const unwrap = <T>(outcome: Outcome<T>): T => { if (outcome.error) throw outcome.error; return outcome.value; };
const SUMMARY_INSTRUCTIONS = "请由目标 Agent 使用本次提供且当前有权访问的资料及自身当前项目上下文，重新生成项目记忆。保留人工确认的事实和约束，删除已失效的推断，输出完整 Markdown。不要把全局记忆、其他项目或未授权群组内容复制进来；不要展开任务或消息引用获取额外资料。输入可能经过截断，应把缺失明确视为未知。生成后用当前 request/attempt 提交，不能把旧输出套到新基准。";

function validateEvidence(evidence: SelfSummaryEvidence, markdown: string): void {
  const invalid = () => new MemoryError("memory_invalid_evidence", "总结执行声明必须完整，时间有序且输出 hash 与提交正文一致。");
  if (!evidence || evidence.provenance !== "agent-declared") throw invalid();
  for (const field of ["host", "hostVersion", "invocationId", "contextId", "evidenceRef"] as const) {
    if (typeof evidence[field] !== "string" || !evidence[field].trim() || evidence[field].length > 8192 || evidence[field].includes("\0")) throw invalid();
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.promptSha256) || !/^[a-f0-9]{64}$/i.test(evidence.outputSha256)
    || evidence.outputSha256 !== hash(markdown) || !Number.isFinite(Date.parse(evidence.startedAt))
    || !Number.isFinite(Date.parse(evidence.completedAt)) || Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) throw invalid();
}

/** 入口只提供可信身份；权限、版本、不可变历史和项目审计共用注入的同一 RepoCtx。 */
export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { repos } = options;
  const config = resolveMemoryConfig(options.config);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  function projectOf(access: MemoryAccess, key: MemoryKey): string {
    validKey(key);
    if (key.scope !== "global") return key.projectId;
    // 必须在 owner/project 通用守卫之前拒绝，不能泄漏 global 的存在性或版本。
    if (access.actor.kind !== "agent" || !access.connection) deny("memory:read_own", "全局记忆仅由本体 Agent 的已绑定会话访问。", "not_self");
    return access.connection.projectId;
  }
  async function actorFor(access: MemoryAccess, projectId: string, write = false): Promise<Context> {
    identifier(projectId);
    if (access.connection && (access.connection.projectId !== projectId || access.connection.memberId !== access.actor.actorId)) deny("memory:read_shared", "连接不属于请求项目或成员。", "out_of_connection");
    if (access.actor.projectId !== null && access.actor.projectId !== projectId) deny("memory:read_shared", "不能访问其他项目的记忆。", "cross_project");
    let actor = access.actor; let member: Member | null = null;
    if (actor.kind === "agent") {
      if (!access.connection) deny("memory:read_own", "Agent 必须通过已绑定会话访问记忆。", "out_of_connection");
      member = await repos.members.get(actor.actorId);
      if (!member || member.removedAt !== null || member.kind !== "agent" || member.agentId === null || member.projectId !== projectId || member.status !== "active") deny("memory:read_own", "成员不存在、已离岗或不属于本项目。", "not_a_member");
      if (!Number.isSafeInteger(access.connection.membershipRevision) || access.connection.membershipRevision !== member.membershipRevision) deny("memory:read_own", "成员授权代际已变化，请重新加入会话。", "out_of_connection");
      actor = (await orgActorForMember(repos, member.id)) ?? actorForMember(member);
    }
    authorizeOrThrow(actor, "memory:read_shared", { projectId });
    const project = await repos.projects.get(projectId);
    if (!project) throw new NotFoundError("项目不存在。");
    if (write && project.archivedAt !== null) throw new ArchivedError("项目已归档，记忆保持只读。");
    return { projectId, actor, member, author: { kind: actor.kind, actorId: actor.actorId, agentId: member?.agentId ?? null,
      displayName: member?.displayName ?? "人（owner）" }, at: now(), events: [] };
  }
  async function requireKey(ctx: Context, key: MemoryKey, write = false): Promise<void> {
    if (key.scope === "global") {
      if (!ctx.member || ctx.member.agentId !== key.agentId) deny(write ? "memory:write_own" : "memory:read_own", "全局记忆仅该 Agent 可读写。", "not_self");
      authorizeOrThrow(ctx.actor, write ? "memory:write_own" : "memory:read_own", { projectId: ctx.member.projectId, memberId: ctx.member.id });
      return;
    }
    if (key.scope === "project") {
      authorizeOrThrow(ctx.actor, write ? "memory:write_shared" : "memory:read_shared", { projectId: key.projectId });
      return;
    }
    if (ctx.member?.agentId === key.agentId) {
      authorizeOrThrow(ctx.actor, write ? "memory:write_own" : "memory:read_own", { projectId: key.projectId, memberId: ctx.member.id });
      return;
    }
    const target = await repos.members.findByAgent(key.projectId, key.agentId);
    authorizeOrThrow(ctx.actor, "memory:manage_agent", { projectId: key.projectId, nodeId: target?.nodeId ?? null });
    if (!target && !await repos.memory.get(key)) throw new NotFoundError("目标 Agent 不在本项目，且没有留存的项目记忆。");
  }
  async function mutate<T>(access: MemoryAccess, projectId: string, body: (ctx: Context) => Promise<T>, operation: "write" | "consume" = "write", targets: DomainMutationTargets = {}): Promise<T> {
    let events: WorkEvent[] = [];
    const discover = discoverDomainMutation(access, projectId, targets);
    const work = () => repos.mutations.run({ projectIds: [projectId], discover }, () => repos.transaction(async () => {
      try { const ctx = await actorFor(access, projectId, true); events = ctx.events; return await body(ctx); }
      catch (error) { if (error instanceof ForbiddenError) throw new GuardRollback(error); throw error; }
    }));
    let result: T;
    try { result = await (access.runMutation ? access.runMutation(operation, work, discover) : work()); }
    catch (error) { if (error instanceof GuardRollback) throw error.denial; throw error; }
    try { if (events.length) await options.onWorkEvents?.(events); }
    catch { console.warn("memory_work_event_notification_failed", { projectId }); }
    return result;
  }
  function sourceFor(ctx: Context, key: MemoryKey): MemoryWriteSource {
    if (ctx.actor.kind === "human") return "human";
    return key.scope !== "project" && ctx.member?.agentId === key.agentId ? "agent" : "manager";
  }
  async function writeDocument(ctx: Context, key: MemoryKey, input: WriteMemoryInput, summaryRequestId: string | null = null): Promise<WriteMemoryResult> {
    await requireKey(ctx, key, true);
    const current = await repos.memory.get(key);
    const contentSha256 = hash(input.markdown);
    if (current) {
      const previous = await repos.memory.findMutation(current.id, ctx.actor.actorId, input.clientMutationId);
      if (previous) {
        if (previous.contentSha256 !== contentSha256) throw new MemoryError("memory_mutation_conflict", "同一保存标识不能对应不同内容。", "conflict");
        return { document: current, writtenVersion: previous, duplicate: true };
      }
    }
    if ((current?.version ?? 0) !== input.expectedVersion) throw new MemoryError("memory_version_conflict", "记忆已更新，请保留草稿并读取最新版本。", "conflict");
    const byteLength = assertMemoryMarkdown(input.markdown, config.maxDocumentBytes);
    const next: MemoryDocument = { id: current?.id ?? newId(), key: { ...key }, version: input.expectedVersion + 1,
      markdown: input.markdown, byteLength, updatedAt: ctx.at, updatedBy: ctx.author, source: summaryRequestId === null ? sourceFor(ctx, key) : "self-summary" };
    let document: MemoryDocument;
    try { document = current ? await repos.memory.updateHeadCas(current.id, input.expectedVersion, next) : await repos.memory.insertHead(next); }
    catch (error) {
      if (error instanceof RepositoryError && error.code === "conflict") throw new MemoryError("memory_version_conflict", "记忆已更新，请保留草稿并读取最新版本。", "conflict");
      throw error;
    }
    const writtenVersion = await repos.memory.insertVersion({ id: newId(), documentId: document.id, version: document.version,
      parentVersion: input.expectedVersion, markdown: document.markdown, byteLength, contentSha256, author: ctx.author,
      source: document.source, clientMutationId: input.clientMutationId, summaryRequestId, createdAt: ctx.at });
    if (key.projectId !== null) await appendAuditEntry(repos.audit, { projectId: key.projectId, actor: auditActorFrom(ctx.actor),
      action: "memory.updated", targetKind: "memory", targetId: document.id, targetName: "记忆",
      detail: { scope: key.scope, documentId: document.id, agentId: key.agentId, parentVersion: input.expectedVersion, version: document.version, source: document.source } }, { createdAt: ctx.at });
    return { document, writtenVersion, duplicate: false };
  }
  async function requireGroup(ctx: Context, access: MemoryAccess, groupId: string, write = false): Promise<void> {
    const group = await repos.groups.get(groupId);
    if (!group || group.projectId !== ctx.projectId) {
      deny("group:view", "总结上下文群组不存在或不属于当前项目。", "cross_project");
    }
    const memberIds = await repos.groups.participants(groupId);
    const nodeIds = await Promise.all(memberIds.map(async id => (await repos.members.get(id))?.nodeId ?? null));
    authorizeOrThrow(ctx.actor, "group:view", { projectId: group.projectId, groupId, groupMemberIds: memberIds, groupMemberNodeIds: nodeIds,
      ...(access.connection ? { conn: { projectId: access.connection.projectId, groupIds: [access.connection.groupId] } } : {}) });
    if (write && group.archivedAt !== null) throw new ArchivedError("来源群组已归档，总结执行暂停。");
  }
  async function getRequest(id: string): Promise<MemorySummaryRequest> {
    identifier(id); const request = await repos.memory.getRequest(id);
    if (!request) throw new NotFoundError("总结请求不存在。"); return request;
  }
  async function requireTarget(ctx: Context, access: MemoryAccess, request: MemorySummaryRequest, write = false): Promise<void> {
    if (!ctx.member || ctx.member.id !== request.recipientMemberId || ctx.member.agentId !== request.agentId) {
      deny("memory:read_own", "只有当前请求指定的目标 Agent 可以获取资料和执行总结。", "not_self");
    }
    await requireKey(ctx, requestKey(request), write);
    await requireGroup(ctx, access, request.contextGroupId ?? access.connection!.groupId, write);
  }
  async function summaryAudit(ctx: Context, request: MemorySummaryRequest, action: string): Promise<void> {
    await appendAuditEntry(repos.audit, { projectId: request.projectId, actor: auditActorFrom(ctx.actor), action, targetKind: "memory",
      targetId: request.id, targetName: "记忆总结", detail: { requestId: request.id, agentId: request.agentId, trigger: request.trigger,
        state: request.state, revision: request.revision, baseVersion: request.baseVersion, resultVersion: request.resultVersion,
        ...(request.error ? { errorCode: request.error.code } : {}) } }, { createdAt: ctx.at });
  }
  async function acknowledgeSummary(ctx: Context, request: MemorySummaryRequest): Promise<void> {
    await repos.tasks.acknowledgeWorkEvent(request.projectId, request.recipientMemberId, summaryEventId(request.id), ctx.at,
      request.contextGroupId === null ? undefined : { contextGroupId: request.contextGroupId });
  }
  async function eligibleCompletion(projectId: string, eventId: string, agentId: string): Promise<boolean> {
    if (!await isWorkEventEligible(repos.context, projectId, eventId)) return false;
    const event = await repos.context.one('SELECT * FROM work_events WHERE project_id=? AND id=?', [projectId, eventId]);
    if (!event || event.kind !== 'task.review_decided') return false;
    await validateLiveCompletionSource(repos.context, event);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(String(event.payload)); } catch { return false; }
    return payload?.enteredDone === true && payload.assigneeAgentId === agentId;
  }
  async function createRequest(ctx: Context, target: Member, source: SummarySource, invalid?: InvalidSummary): Promise<{ request: MemorySummaryRequest; created: boolean }> {
    if (!target.agentId || target.kind !== "agent" || target.status !== "active") throw new MemoryError("memory_summary_target_inactive", "目标 Agent 当前不可执行总结。", "conflict");
    if (source.sourceWorkEventId && !await eligibleCompletion(target.projectId, source.sourceWorkEventId, target.agentId!)) {
      throw new MemoryError("memory_summary_source_changed", "来源工作事件已因成员生命周期变化失效。", "conflict");
    }
    const prior = await repos.memory.findRequestByTrigger(target.projectId, target.agentId, source.triggerKey);
    if (prior) return { request: prior, created: false };
    const current = await repos.memory.get({ scope: "project-agent", projectId: target.projectId, agentId: target.agentId });
    const next: MemorySummaryRequest = { id: newId(), projectId: target.projectId, agentId: target.agentId, recipientMemberId: target.id,
      contextGroupId: source.contextGroupId, documentId: current?.id ?? null, baseVersion: current?.version ?? 0, revision: 1,
      state: invalid?.state ?? "pending", trigger: source.trigger, triggerKey: source.triggerKey, taskId: source.taskId ?? null,
      completedTaskRevision: source.completedTaskRevision ?? null, messageIds: source.messageIds ?? [], sourceWorkEventId: source.sourceWorkEventId ?? null,
      retryOfRequestId: source.retryOfRequestId ?? null, attemptId: null, beginMutationId: null, resultVersion: null, resultSha256: null,
      error: invalid ? { code: invalid.code, message: invalid.message } : null, evidence: null, createdAt: ctx.at, startedAt: null, finishedAt: invalid ? ctx.at : null };
    let request: MemorySummaryRequest;
    try { request = await repos.memory.createRequest(next); }
    catch (error) {
      if (error instanceof RepositoryError && error.code === "conflict") {
        const existing = await repos.memory.findRequestByTrigger(target.projectId, target.agentId, source.triggerKey);
        if (existing) return { request: existing, created: false };
      }
      throw error;
    }
    await summaryAudit(ctx, request, invalid ? `memory.summary_${invalid.state}` : "memory.summary_requested");
    if (!invalid) {
      const event = await repos.tasks.enqueueWorkEvent({ id: summaryEventId(request.id), projectId: request.projectId, recipientMemberId: target.id,
        taskId: null, contextGroupId: request.contextGroupId, kind: "memory.summary_requested", eventKey: `memory.summary_requested:${request.id}`,
        payload: { requestId: request.id, requestRevision: request.revision, trigger: request.trigger }, deliveryState: "pending", attempts: 0,
        createdAt: ctx.at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
      ctx.events.push(event);
    }
    return { request, created: true };
  }
  async function invalidSource(request: MemorySummaryRequest): Promise<InvalidSummary | null> {
    if (request.sourceWorkEventId && !await eligibleCompletion(request.projectId, request.sourceWorkEventId, request.agentId)) {
      return { state: "cancelled", code: "memory_summary_source_changed", message: "来源工作事件已因成员生命周期变化失效。" };
    }
    if (request.taskId !== null) {
      const task = await repos.tasks.get(request.projectId, request.taskId);
      if (!task || task.state !== "done" || task.revision !== request.completedTaskRevision) {
        return { state: "cancelled", code: "memory_summary_source_changed", message: "来源任务已变化，旧总结请求已取消。" };
      }
    }
    return null;
  }
  async function invalidRequest(request: MemorySummaryRequest): Promise<InvalidSummary | null> {
    const source = await invalidSource(request); if (source) return source;
    if (request.state === "running" && request.startedAt !== null && Date.parse(now()) - Date.parse(request.startedAt) >= config.summaryAttemptTimeoutMs) {
      return { state: "failed", code: "memory_summary_timeout", message: "本次总结已超过执行期限，请重新安排总结。" };
    }
    if (((await repos.memory.get(requestKey(request)))?.version ?? 0) !== request.baseVersion) {
      return { state: "conflicted", code: "memory_version_conflict", message: "记忆已被更新，旧模型输出不能覆盖当前版本。" };
    }
    return null;
  }
  async function finishInvalid(ctx: Context, request: MemorySummaryRequest, invalid: InvalidSummary): Promise<MemoryError> {
    const updated = await repos.memory.updateRequestCas(request.id, request.revision, { state: invalid.state,
      error: { code: invalid.code, message: invalid.message }, finishedAt: ctx.at });
    await summaryAudit(ctx, updated, `memory.summary_${invalid.state}`);
    await acknowledgeSummary(ctx, updated);
    return new MemoryError(invalid.code, invalid.message, "conflict", { requestId: updated.id, state: updated.state, revision: updated.revision });
  }
  const stateConflict = () => new MemoryError("memory_summary_state_conflict", "总结请求状态已变化，请读取最新请求。", "conflict");
  const revisionConflict = () => new MemoryError("memory_request_conflict", "总结请求版本已变化，请读取最新请求。", "conflict");
  async function completedResult(request: MemorySummaryRequest, attemptId: string, markdown: string): Promise<WriteMemoryResult> {
    if (request.attemptId !== attemptId || request.resultSha256 !== hash(markdown)) throw new MemoryError("memory_summary_result_conflict", "已完成的总结不能替换执行结果。", "conflict");
    const document = await repos.memory.get(requestKey(request));
    const writtenVersion = document && request.resultVersion ? await repos.memory.getVersion(document.id, request.resultVersion) : null;
    if (!document || !writtenVersion || writtenVersion.summaryRequestId !== request.id) throw new MemoryError("memory_summary_result_unavailable", "总结结果版本不可用。", "write_failed");
    return { document, writtenVersion, duplicate: true };
  }
  const service: MemoryService = {
    async list(access, projectId) {
      const ctx = await actorFor(access, projectId); const result: MemoryDocument[] = [];
      for (const doc of await repos.memory.listProject(projectId)) {
        try { await requireKey(ctx, doc.key); result.push(doc); }
        catch (error) { if (!(error instanceof ForbiddenError)) throw error; }
      }
      return result;
    },
    async read(access, key) {
      const ctx = await actorFor(access, projectOf(access, key)); await requireKey(ctx, key);
      const document = await repos.memory.get(key); return { document, version: document?.version ?? 0 };
    },
    async history(access, key, beforeVersion) {
      const ctx = await actorFor(access, projectOf(access, key)); await requireKey(ctx, key);
      if (beforeVersion !== undefined) integer(beforeVersion, 1);
      const document = await repos.memory.get(key); return document ? repos.memory.listVersions(document.id, beforeVersion) : [];
    },
    async readVersion(access, key, version) {
      const ctx = await actorFor(access, projectOf(access, key)); await requireKey(ctx, key); integer(version, 1);
      const document = await repos.memory.get(key); return document ? repos.memory.getVersion(document.id, version) : null;
    },
    async write(access, key, input) {
      const projectId = projectOf(access, key); identifier(input.clientMutationId); integer(input.expectedVersion);
      if (typeof input.markdown !== "string") throw new MemoryError("memory_invalid_input", "记忆正文必须是 Markdown 文本。");
      return mutate(access, projectId, ctx => writeDocument(ctx, key, input), "write", { agentIds: [key.agentId] });
    },
    async inject(access) {
      const binding = access.connection; const generation = access.injectionBindingGeneration;
      if (access.actor.kind !== "agent" || !binding || !generation || binding.memberId !== access.actor.actorId || access.actor.projectId !== binding.projectId ||
        !Number.isSafeInteger(binding.membershipRevision) || binding.membershipRevision < 1) return unavailableMemory(config, "memory_binding_unavailable");
      // 此处只做可信绑定形状检查；真实身份由隔离 SELECT 复核，绝不退回主库追加 ACL 查询。
      try { return await options.injectionReader.readOwn({ memberId: binding.memberId, projectId: binding.projectId, bindingGeneration: generation, membershipRevision: binding.membershipRevision }); }
      catch { return unavailableMemory(config, "memory_reader_unavailable"); }
    },
    async reconcileTriggers(access) {
      if (access.actor.kind !== "agent" || !access.connection) return { scheduled: 0 };
      const projectId = access.connection.projectId; const groupId = access.connection.groupId;
      let scheduled = 0;
      const run = async (kind: string, body: (ctx: Context) => Promise<number>) => {
        try { scheduled += await mutate(access, projectId, body); }
        catch (error) {
          // 已提交的消息/任务不回滚；只记录稳定原因，不打印原文、凭据或驱动错误。
          if (!(error instanceof ForbiddenError) && !(error instanceof ArchivedError)) console.warn("memory_reconcile_failed", {
            projectId, kind, code: error instanceof MemoryError ? error.reason : error instanceof RepositoryError ? error.code : "unavailable",
          });
        }
      };
      await run("expired", async ctx => {
        const cutoff = new Date(Date.parse(ctx.at) - config.summaryAttemptTimeoutMs).toISOString();
        const expired = await repos.memory.listRequests(projectId, ctx.member!.agentId!, "running", { startedBefore: cutoff, limit: 50, contextGroupId: groupId });
        for (const request of expired) {
          if (request.contextGroupId !== null && request.contextGroupId !== groupId) continue;
          await requireTarget(ctx, access, request, true);
          const invalid = await invalidRequest(request); if (invalid) await finishInvalid(ctx, request, invalid);
        }
        return 0;
      });
      // 每安全点共两页来源：任务一页、消息一页，各最多50 raw rows；无 while 追新数据。
      await run("task_completed", ctx => reconcileTaskCompletionPage({ repo: repos.memory, projectId, agentId: ctx.member!.agentId!,
        materialize: async source => {
          if (!await isWorkEventEligible(repos.context, projectId, source.eventId)) return false;
          const task = await repos.tasks.get(projectId, source.taskId);
          const invalid: InvalidSummary | undefined = !task || task.state !== "done" || task.revision !== source.completionRevision
            ? { state: "cancelled", code: "memory_summary_source_changed", message: "来源任务已变化，旧完成记录不再启动总结。" } : undefined;
          const result = await createRequest(ctx, ctx.member!, { trigger: "task_completed", triggerKey: source.triggerKey, contextGroupId: null,
            taskId: source.taskId, completedTaskRevision: source.completionRevision, sourceWorkEventId: source.eventId }, invalid);
          return result.created && result.request.state === "pending";
        },
      }));
      await run("message_threshold", async ctx => {
        await requireGroup(ctx, access, groupId, true);
        return reconcileMessageThresholdPage({ repo: repos.memory, projectId, agentId: ctx.member!.agentId!, memberId: ctx.member!.id,
          groupId, threshold: config.messageThreshold, at: ctx.at,
          visibleIds: async ids => new Set((await options.readVisibleMessages(access, ids))
            .filter(row => ids.includes(row.id) && row.groupId === groupId).map(row => row.id)),
          materialize: async (sequence, messageIds) => {
            const result = await createRequest(ctx, ctx.member!, { trigger: "message_threshold",
              triggerKey: `messages:${groupId}:agent:${ctx.member!.agentId}:threshold:${sequence}`, contextGroupId: groupId, messageIds });
            return result.created && result.request.state === "pending";
          },
        });
      });
      return { scheduled };
    },
    async reportSessionEnd(access, clientMutationId) {
      identifier(clientMutationId);
      if (access.actor.kind !== "agent" || !access.connection) deny("memory:read_own", "只有已绑定的目标 Agent 可以报告会话结束。", "not_self");
      if (!access.injectionBindingGeneration) return { summaryScheduled: false, requestId: null, errorCode: "memory_binding_unavailable" };
      try {
        const request = await mutate(access, access.connection.projectId, async ctx => {
          await requireGroup(ctx, access, access.connection!.groupId, true);
          const triggerKey = `session:${hash(JSON.stringify([ctx.member!.id, access.connection!.projectId, access.connection!.groupId, access.injectionBindingGeneration, clientMutationId]))}`;
          return (await createRequest(ctx, ctx.member!, { trigger: "session_end", triggerKey, contextGroupId: access.connection!.groupId })).request;
        });
        return { summaryScheduled: true, requestId: request.id };
      } catch (error) {
        if (error instanceof ForbiddenError) throw error;
        return { summaryScheduled: false, requestId: null,
          errorCode: error instanceof MemoryError ? error.reason : error instanceof RepositoryError ? `memory_${error.code}` : "memory_schedule_failed" };
      }
    },
    async listSummaryRequests(access, projectId, agentId) {
      const ctx = await actorFor(access, projectId);
      const targets = agentId !== undefined ? [agentId] : [...new Set([
        ...(await repos.members.listByProject(projectId)).flatMap(member => member.agentId ? [member.agentId] : []),
        ...(await repos.memory.listProject(projectId)).flatMap(doc => doc.key.scope === "project-agent" ? [doc.key.agentId] : []),
      ])];
      const result: MemorySummaryRequest[] = [];
      for (const target of targets) {
        identifier(target);
        try { await requireKey(ctx, { scope: "project-agent", projectId, agentId: target }); }
        catch (error) { if (agentId === undefined && error instanceof ForbiddenError) continue; throw error; }
        for (const request of await repos.memory.listRequests(projectId, target)) {
          if (request.contextGroupId !== null && access.connection) {
            try { await requireGroup(ctx, access, request.contextGroupId); }
            catch (error) { if (error instanceof ForbiddenError) continue; throw error; }
          }
          result.push(request);
        }
      }
      return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    async readSummaryPacket(access, requestId) {
      const request = await getRequest(requestId); const ctx = await actorFor(access, request.projectId);
      await requireTarget(ctx, access, request);
      const current = await repos.memory.get(requestKey(request));
      let remaining = config.summaryInputBytes; let partialInput = false;
      const text = (value: string): string => {
        const bounded = truncateGraphemes(value, remaining); remaining -= Buffer.byteLength(bounded, "utf8");
        if (bounded !== value) partialInput = true; return bounded;
      };
      const currentMemory = current ? { ...current, markdown: text(current.markdown) } : null;
      const sourceTask = request.taskId ? await repos.tasks.get(request.projectId, request.taskId) : null;
      let task: MemorySummaryPacket["task"] = null;
      if (sourceTask && sourceTask.state === "done" && sourceTask.revision === request.completedTaskRevision) {
        task = { id: sourceTask.id, title: text(sourceTask.title), body: text(sourceTask.body), revision: sourceTask.revision };
      } else if (request.taskId !== null) partialInput = true;
      const messages: MemorySummaryPacket["messages"] = [];
      for (let offset = 0; offset < request.messageIds.length; offset += 50) {
        if (remaining <= 0) { partialInput = true; break; }
        const ids = request.messageIds.slice(offset, offset + 50);
        const rows = await options.readVisibleMessages(access, ids);
        const visible = new Map(rows.filter(row => ids.includes(row.id) && row.groupId === access.connection!.groupId
          && (request.contextGroupId === null || row.groupId === request.contextGroupId)).map(row => [row.id, row]));
        for (const id of ids) {
          const row = visible.get(id);
          if (!row) { partialInput = true; continue; }
          if (remaining <= 0) { partialInput = true; break; }
          messages.push({ ...row, text: text(row.text) });
        }
      }
      return { request, currentMemory, task, messages, partialInput, instructions: SUMMARY_INSTRUCTIONS };
    },
    async beginSummary(access, requestId, input) {
      integer(input.expectedRevision, 1); identifier(input.clientMutationId);
      const original = await getRequest(requestId);
      return unwrap(await mutate<Outcome<MemorySummaryRequest>>(access, original.projectId, async ctx => {
        const request = await getRequest(requestId); await requireTarget(ctx, access, request, true);
        const duplicate = request.beginMutationId === input.clientMutationId && request.attemptId !== null;
        if (duplicate && !["pending", "running"].includes(request.state)) return { value: request };
        if (request.state !== "pending" && !duplicate) throw stateConflict();
        if (!duplicate && request.revision !== input.expectedRevision) throw revisionConflict();
        const invalid = await invalidRequest(request);
        if (invalid) return { error: await finishInvalid(ctx, request, invalid) };
        if (duplicate) return { value: request };
        const updated = await repos.memory.updateRequestCas(request.id, request.revision,
          { state: "running", attemptId: newId(), beginMutationId: input.clientMutationId, startedAt: ctx.at });
        await summaryAudit(ctx, updated, "memory.summary_begun");
        return { value: updated };
      }, "write", { summaryRequestId: requestId }));
    },
    async submitSummary(access, requestId, input) {
      integer(input.expectedRequestRevision, 1); identifier(input.attemptId);
      if (typeof input.markdown !== "string") throw new MemoryError("memory_invalid_input", "总结正文必须为 Markdown。");
      const original = await getRequest(requestId);
      return unwrap(await mutate<Outcome<WriteMemoryResult>>(access, original.projectId, async ctx => {
        const request = await getRequest(requestId); await requireTarget(ctx, access, request, true);
        if (request.state === "completed") return { value: await completedResult(request, input.attemptId, input.markdown) };
        if (request.state !== "running" || request.attemptId !== input.attemptId) throw stateConflict();
        if (request.revision !== input.expectedRequestRevision) throw revisionConflict();
        const invalid = await invalidRequest(request);
        if (invalid) return { error: await finishInvalid(ctx, request, invalid) };
        assertMemoryMarkdown(input.markdown, config.maxDocumentBytes); validateEvidence(input.evidence, input.markdown);
        try {
          // Savepoint 把数据库 CAS 竞争与真正故障隔离；终态冲突在外层提交，不能随异常回滚。
          const value = await repos.transaction(async () => {
            const result = await writeDocument(ctx, requestKey(request), { expectedVersion: request.baseVersion,
              clientMutationId: `summary:${request.id}:${request.attemptId}`, markdown: input.markdown }, request.id);
            // 写入已持有项目写锁，重新核对 task 防止等待锁期间来源被重开。
            const changed = await invalidSource(request);
            if (changed) throw new MemoryError(changed.code, changed.message, "conflict");
            const updated = await repos.memory.updateRequestCas(request.id, request.revision, { state: "completed", resultVersion: result.document.version,
              resultSha256: hash(input.markdown), evidence: { ...input.evidence }, error: null, finishedAt: ctx.at });
            await summaryAudit(ctx, updated, "memory.summary_completed"); await acknowledgeSummary(ctx, updated);
            return result;
          });
          return { value };
        } catch (error) {
          if (!(error instanceof RepositoryError) || error.code !== "conflict") throw error;
          const latest = await getRequest(request.id);
          if (latest.state === "completed") return { value: await completedResult(latest, input.attemptId, input.markdown) };
          if (latest.state !== "running" || latest.attemptId !== request.attemptId) throw stateConflict();
          if (latest.revision !== request.revision) throw revisionConflict();
          const conflict = await invalidRequest(latest);
          if (conflict) return { error: await finishInvalid(ctx, latest, conflict) };
          throw error;
        }
      }, "write", { summaryRequestId: requestId }));
    },
    async failSummary(access, requestId, input) {
      integer(input.expectedRevision, 1); identifier(input.attemptId);
      if (!/^[a-z][a-z0-9_]{0,95}$/.test(input.code)) throw new MemoryError("memory_invalid_input", "总结失败原因应为简短、稳定的原因码。");
      const original = await getRequest(requestId);
      return mutate(access, original.projectId, async ctx => {
        const request = await getRequest(requestId); await requireTarget(ctx, access, request, true);
        if (request.state === "failed" && request.attemptId === input.attemptId && request.error?.code === input.code) return request;
        if (request.state !== "running" || request.attemptId !== input.attemptId) throw stateConflict();
        if (request.revision !== input.expectedRevision) throw revisionConflict();
        const invalid = await invalidRequest(request);
        const failure = invalid ?? { state: "failed" as const, code: input.code, message: "目标 Agent 报告本次总结失败，原记忆保持不变。" };
        await finishInvalid(ctx, request, failure);
        return getRequest(request.id);
      }, "write", { summaryRequestId: requestId });
    },
    async retrySummary(access, requestId, clientMutationId) {
      identifier(clientMutationId); const original = await getRequest(requestId);
      return mutate(access, original.projectId, async ctx => {
        const old = await getRequest(requestId); await requireKey(ctx, requestKey(old), true);
        if (!["failed", "conflicted", "cancelled"].includes(old.state)) throw new MemoryError("memory_summary_not_retryable", "只有失败、冲突或取消的总结可以重新安排。", "conflict");
        const target = await repos.members.findByAgent(old.projectId, old.agentId);
        if (!target || target.status !== "active" || target.kind !== "agent") throw new MemoryError("memory_summary_target_inactive", "目标 Agent 当前不可执行总结。", "conflict");
        if (old.contextGroupId !== null) await requireGroup(ctx, access, old.contextGroupId, true);
        if (old.sourceWorkEventId && !await eligibleCompletion(old.projectId, old.sourceWorkEventId, old.agentId)) throw new MemoryError("memory_summary_source_changed", "来源工作事件已因成员生命周期变化失效。", "conflict");
        const triggerKey = `retry:${hash(JSON.stringify([old.id, ctx.actor.actorId, clientMutationId]))}`;
        const duplicate = await repos.memory.findRequestByTrigger(old.projectId, old.agentId, triggerKey);
        if (duplicate) return duplicate;
        const task = old.taskId === null ? null : await repos.tasks.get(old.projectId, old.taskId);
        if (old.taskId !== null && (!task || task.state !== "done")) throw new MemoryError("memory_summary_source_changed", "来源任务不再处于已完成状态，不能继续旧任务总结。", "conflict");
        return (await createRequest(ctx, target, { trigger: "retry", triggerKey, contextGroupId: old.contextGroupId,
          taskId: old.taskId, completedTaskRevision: task?.revision ?? null, messageIds: [...old.messageIds],
          sourceWorkEventId: old.sourceWorkEventId, retryOfRequestId: old.id })).request;
      }, "write", { summaryRequestId: requestId });
    },
  };
  return service;
}

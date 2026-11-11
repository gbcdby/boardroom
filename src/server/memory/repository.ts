import type { MemoryKey, MemoryDocument, MemoryVersion, MemorySummaryRequest, SummaryState } from "../../shared/memory.ts";

export type ScanCursor = { at: string; id: string }; // messages: first_mcp_delivered_at+deliveryId；task: event.created_at+eventId
export type ScanScope = { kind: 'message_threshold' | 'task_completed'; projectId: string; agentId: string; groupId: string | null };
export interface ScanCheckpoint { scope: ScanScope; after: ScanCursor | null; through: ScanCursor | null; sweep: number; revision: number }
export interface ScanPage<T> { rows: T[]; nextCursor: ScanCursor | null; hasMore: boolean; scannedCount: number }
export interface TaskCompletionSource { eventId: string; taskId: string; completionRevision: number; assigneeAgentId: string; recipientMemberId: string; triggerKey: string }
export interface MemoryRepository {
  get(key: MemoryKey): Promise<MemoryDocument | null>;
  listProject(projectId: string): Promise<MemoryDocument[]>; // 服务仍逐项ACL过滤
  insertHead(document: MemoryDocument): Promise<MemoryDocument>;
  updateHeadCas(documentId: string, expectedVersion: number, next: MemoryDocument): Promise<MemoryDocument>;
  insertVersion(version: MemoryVersion): Promise<MemoryVersion>;
  findMutation(documentId: string, actorId: string, clientMutationId: string): Promise<MemoryVersion | null>;
  listVersions(documentId: string, beforeVersion?: number, limit?: number): Promise<MemoryVersion[]>;
  getVersion(documentId: string, version: number): Promise<MemoryVersion | null>;
  createRequest(request: MemorySummaryRequest): Promise<MemorySummaryRequest>;
  findRequestByTrigger(projectId: string, agentId: string, triggerKey: string): Promise<MemorySummaryRequest | null>;
  getRequest(requestId: string): Promise<MemorySummaryRequest | null>;
  listRequests(projectId: string, agentId: string, state?: SummaryState, query?: { startedBefore?: string; limit?: number; contextGroupId?: string }): Promise<MemorySummaryRequest[]>;
  updateRequestCas(requestId: string, expectedRevision: number, patch: Partial<MemorySummaryRequest>): Promise<MemorySummaryRequest>;
  /** server-only 移除补偿原语；仅读固定身份/版本，允许目标刚removed，不读取packet/evidence JSON。 */
  cancelForMemberLifecycleCas(projectId: string, memberId: string, requestId: string, expectedRevision: number, at: string): Promise<void>;
  // A/B 固定以下投递/扫描方法的参数：只接受可信的已落库投递/事件，不接受公网请求自报。
  observeDeliveredMessage(input: { projectId: string; agentId: string; groupId: string; messageId: string; threshold: number; at: string }): Promise<{ added: boolean; thresholdSequence: number | null; messageIds: string[] }>;
  getScanCheckpoint(scope: ScanScope): Promise<ScanCheckpoint>; // 无行虚拟revision0；after/through均null
  updateScanCheckpointCas(checkpoint: ScanCheckpoint, expectedRevision: number): Promise<ScanCheckpoint>;
  scanHighWater(scope: ScanScope): Promise<ScanCursor | null>; // 当前已提交来源最大key；固定本轮上界
  unobservedDeliveries(projectId: string, memberId: string, groupId: string, page: { after: ScanCursor | null; through: ScanCursor; limit: number }): Promise<ScanPage<{ messageId: string; groupId: string }>>; // 真投递标记；nextCursor按raw扫描推进
  scanUnmaterializedTaskCompletions(projectId: string, agentId: string, page: { after: ScanCursor | null; through: ScanCursor; limit: number }): Promise<ScanPage<TaskCompletionSource>>; // 不过滤ACK；排除任何状态canonical request
}

import type { RepoCtx } from "../db/repositories.ts";
import { ArchivedError, ConflictError, InvalidArgumentError, InvalidReferenceError, NotFoundError } from "../db/errors.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type HeadRow = { id: string; scope: MemoryKey['scope']; project_id: string | null; agent_id: string | null; version: number;
  markdown: string; byte_length: number; updated_at: string; updated_by: string; source: MemoryDocument['source'] };
type VersionRow = { id: string; document_id: string; version: number; parent_version: number; markdown: string; byte_length: number;
  content_sha256: string; author: string; actor_id: string; source: MemoryVersion['source']; client_mutation_id: string; summary_request_id: string | null; created_at: string };
type RequestRow = { id: string; project_id: string; agent_id: string; recipient_member_id: string; context_group_id: string | null;
  document_id: string | null; base_version: number; revision: number; state: SummaryState; trigger: MemorySummaryRequest['trigger']; trigger_key: string;
  task_id: string | null; completed_task_revision: number | null; message_ids: string; source_work_event_id: string | null; retry_of_request_id: string | null;
  attempt_id: string | null; begin_mutation_id: string | null; result_version: number | null; result_sha256: string | null; error: string | null;
  evidence: string | null; created_at: string; started_at: string | null; finished_at: string | null };
type CheckpointRow = { id: string; kind: ScanScope['kind']; project_id: string; agent_id: string; group_id: string | null;
  after_cursor: string | null; through_cursor: string | null; sweep: number; revision: number };
type CounterRow = { lifetime_count: number; next_threshold: number; configured_n: number; threshold_sequence: number; revision: number };
function toHead(r: HeadRow): MemoryDocument {
  const key: MemoryKey = r.scope === 'global' ? { scope: r.scope, projectId: null, agentId: r.agent_id! }
    : r.scope === 'project' ? { scope: r.scope, projectId: r.project_id!, agentId: null }
      : { scope: r.scope, projectId: r.project_id!, agentId: r.agent_id! };
  return { id: r.id, key, version: r.version, markdown: r.markdown, byteLength: r.byte_length, updatedAt: r.updated_at, updatedBy: JSON.parse(r.updated_by), source: r.source };
}
function toVersion(r: VersionRow): MemoryVersion {
  return { id: r.id, documentId: r.document_id, version: r.version, parentVersion: r.parent_version, markdown: r.markdown, byteLength: r.byte_length,
    contentSha256: r.content_sha256, author: JSON.parse(r.author), source: r.source, clientMutationId: r.client_mutation_id,
    summaryRequestId: r.summary_request_id, createdAt: r.created_at };
}
function toRequest(r: RequestRow): MemorySummaryRequest {
  return { id: r.id, projectId: r.project_id, agentId: r.agent_id, recipientMemberId: r.recipient_member_id, contextGroupId: r.context_group_id,
    documentId: r.document_id, baseVersion: r.base_version, revision: r.revision, state: r.state, trigger: r.trigger, triggerKey: r.trigger_key,
    taskId: r.task_id, completedTaskRevision: r.completed_task_revision, messageIds: JSON.parse(r.message_ids), sourceWorkEventId: r.source_work_event_id,
    retryOfRequestId: r.retry_of_request_id, attemptId: r.attempt_id, beginMutationId: r.begin_mutation_id, resultVersion: r.result_version,
    resultSha256: r.result_sha256, error: r.error === null ? null : JSON.parse(r.error), evidence: r.evidence === null ? null : JSON.parse(r.evidence),
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at };
}
function toCheckpoint(r: CheckpointRow): ScanCheckpoint {
  return { scope: { kind: r.kind, projectId: r.project_id, agentId: r.agent_id, groupId: r.group_id },
    after: r.after_cursor === null ? null : JSON.parse(r.after_cursor), through: r.through_cursor === null ? null : JSON.parse(r.through_cursor), sweep: r.sweep, revision: r.revision };
}
function json(value: unknown): string {
  try { const result = JSON.stringify(value); if (result === undefined) throw new Error(); return result; }
  catch { throw new InvalidArgumentError("记忆数据必须可序列化为 JSON。"); }
}
function integer(value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new InvalidArgumentError("记忆版本/计数必须为有效整数。");
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new InvalidArgumentError("记忆标识不能为空。");
}
function validKey(key: MemoryKey): void {
  if (!key || typeof key !== 'object') throw new InvalidArgumentError("非法记忆 scope。");
  if (key.scope === 'global' && key.projectId === null) { nonempty(key.agentId); return; }
  if (key.scope === 'project' && key.agentId === null) { nonempty(key.projectId); return; }
  if (key.scope === 'project-agent') { nonempty(key.projectId); nonempty(key.agentId); return; }
  throw new InvalidArgumentError("非法记忆 scope/项目/Agent 组合。");
}
function validBody(markdown: string, byteLength: number): void {
  if (typeof markdown !== 'string' || /[\uD800-\uDFFF]/u.test(markdown) || Buffer.byteLength(markdown, 'utf8') !== byteLength) {
    throw new InvalidArgumentError("记忆正文必须是有效 Unicode，byteLength 必须匹配 UTF-8 字节。");
  }
}
function validScope(scope: ScanScope): void {
  nonempty(scope.projectId); nonempty(scope.agentId);
  if (scope.kind === 'message_threshold') { nonempty(scope.groupId); return; }
  if (scope.kind !== 'task_completed' || scope.groupId !== null) throw new InvalidArgumentError("扫描类型与群组范围不匹配。");
}
function scopeId(scope: ScanScope): string { validScope(scope); return json([scope.kind, scope.projectId, scope.agentId, scope.groupId]); }
function validCursor(cursor: ScanCursor | null): void { if (cursor !== null) { nonempty(cursor.at); nonempty(cursor.id); } }
function cursorOrder(a: ScanCursor, b: ScanCursor): number { return a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1; }
function pageWhere(atColumn: string, idColumn: string, page: { after: ScanCursor | null; through: ScanCursor; limit: number }): { sql: string; params: unknown[] } {
  integer(page.limit, 1); if (page.limit > 50) throw new InvalidArgumentError("来源扫描每页最多 50 行。");
  validCursor(page.after); validCursor(page.through);
  if (page.after && cursorOrder(page.after, page.through) > 0) throw new InvalidArgumentError("扫描游标不能超过固定上界。");
  return { sql: `${page.after ? ` AND (${atColumn} > ? OR (${atColumn} = ? AND ${idColumn} > ?))` : ''}
      AND (${atColumn} < ? OR (${atColumn} = ? AND ${idColumn} <= ?))`,
    params: [...(page.after ? [page.after.at, page.after.at, page.after.id] : []), page.through.at, page.through.at, page.through.id] };
}

/** 所有业务写操作复用注入的事务上下文；外层可原子组合正文、历史、审计、事件与扫描。 */
export function createMemoryRepository(ctx: RepoCtx): MemoryRepository {
  async function active(projectId: string): Promise<void> {
    if (await ctx.exec("UPDATE projects SET updated_at = updated_at WHERE id = ? AND archived_at IS NULL", [projectId])) return;
    if (!await ctx.one("SELECT id FROM projects WHERE id = ?", [projectId])) throw new NotFoundError("记忆所属项目不存在。");
    throw new ArchivedError("项目已归档，记忆保持只读。");
  }
  async function groupScope(projectId: string, groupId: string): Promise<void> {
    const row = await ctx.one<{ archived_at: string | null }>("SELECT archived_at FROM groups WHERE id = ? AND project_id = ?", [groupId, projectId]);
    if (!row) throw new InvalidReferenceError("记忆群组不属于该项目。");
    if (row.archived_at !== null) throw new ArchivedError("群组已归档，不能继续观察输入。");
  }
  async function agentMember(projectId: string, agentId: string): Promise<{ id: string }> {
    const member = await ctx.one<{ id: string; removed_at?: string | null }>("SELECT * FROM members WHERE project_id = ? AND agent_id = ? AND kind = 'agent' AND status = 'active'", [projectId, agentId]);
    if (!member || member.removed_at != null) throw new InvalidReferenceError("总结目标必须是本项目未移除的 active Agent 成员。");
    return member;
  }
  async function keyWrite(key: MemoryKey): Promise<void> {
    validKey(key);
    if (key.projectId !== null) await active(key.projectId);
    if (key.agentId !== null && !await ctx.one("SELECT id FROM agents WHERE id = ?", [key.agentId])) throw new InvalidReferenceError("记忆 Agent 身份不存在。");
  }
  async function getHead(id: string): Promise<HeadRow> {
    const row = await ctx.one<HeadRow>("SELECT * FROM memory_documents WHERE id = ?", [id]);
    if (!row) throw new NotFoundError("记忆文档不存在。"); return row;
  }
  const repo: MemoryRepository = {
    async get(key) {
      validKey(key);
      const row = await ctx.one<HeadRow>(`SELECT * FROM memory_documents WHERE scope = ? AND ${key.projectId === null ? 'project_id IS NULL' : 'project_id = ?'} AND ${key.agentId === null ? 'agent_id IS NULL' : 'agent_id = ?'}`,
        [key.scope, ...(key.projectId === null ? [] : [key.projectId]), ...(key.agentId === null ? [] : [key.agentId])]);
      return row ? toHead(row) : null;
    },
    async listProject(projectId) {
      return (await ctx.query<HeadRow>("SELECT * FROM memory_documents WHERE project_id = ? ORDER BY updated_at, id", [projectId])).map(toHead);
    },
    async insertHead(document) {
      return ctx.withTransaction(async () => {
        await keyWrite(document.key); nonempty(document.id); validBody(document.markdown, document.byteLength);
        if (document.version !== 1) throw new InvalidArgumentError("新记忆必须从版本 1 开始。");
        await ctx.exec(`INSERT INTO memory_documents (id, scope, project_id, agent_id, version, markdown, byte_length, updated_at, updated_by, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [document.id, document.key.scope, document.key.projectId, document.key.agentId,
          document.version, document.markdown, document.byteLength, document.updatedAt, json(document.updatedBy), document.source]);
        return toHead(await getHead(document.id));
      });
    },
    async updateHeadCas(documentId, expectedVersion, next) {
      return ctx.withTransaction(async () => {
        integer(expectedVersion, 1); validBody(next.markdown, next.byteLength);
        const previous = toHead(await getHead(documentId));
        if (next.id !== documentId || !isDeepStrictEqual(previous.key, next.key) || next.version !== expectedVersion + 1) throw new InvalidArgumentError("记忆 CAS 只能递增同一文档版本，不能改变 scope。");
        await keyWrite(previous.key);
        if (!await ctx.exec(`UPDATE memory_documents SET version = ?, markdown = ?, byte_length = ?, updated_at = ?, updated_by = ?, source = ?
          WHERE id = ? AND version = ?`, [next.version, next.markdown, next.byteLength, next.updatedAt, json(next.updatedBy), next.source, documentId, expectedVersion])) {
          throw new ConflictError("memory_version_conflict");
        }
        return toHead(await getHead(documentId));
      });
    },
    async insertVersion(version) {
      return ctx.withTransaction(async () => {
        const head = toHead(await getHead(version.documentId)); await keyWrite(head.key);
        validBody(version.markdown, version.byteLength); nonempty(version.author.actorId); nonempty(version.clientMutationId);
        if (version.version !== head.version || version.parentVersion !== version.version - 1 || version.markdown !== head.markdown || version.byteLength !== head.byteLength
          || version.source !== head.source || !isDeepStrictEqual(version.author, head.updatedBy)
          || version.contentSha256 !== createHash('sha256').update(version.markdown).digest('hex')) throw new InvalidArgumentError("版本快照必须匹配当前已 CAS 的正文、作者与 hash。");
        await ctx.exec(`INSERT INTO memory_versions (id, document_id, version, parent_version, markdown, byte_length, content_sha256, author, actor_id,
          source, client_mutation_id, summary_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [version.id, version.documentId, version.version, version.parentVersion, version.markdown, version.byteLength, version.contentSha256,
            json(version.author), version.author.actorId, version.source, version.clientMutationId, version.summaryRequestId, version.createdAt]);
        return (await repo.getVersion(version.documentId, version.version))!;
      });
    },
    async findMutation(documentId, actorId, clientMutationId) {
      const row = await ctx.one<VersionRow>("SELECT * FROM memory_versions WHERE document_id = ? AND actor_id = ? AND client_mutation_id = ?", [documentId, actorId, clientMutationId]);
      return row ? toVersion(row) : null;
    },
    async listVersions(documentId, beforeVersion, limit = 20) {
      integer(limit, 1); if (limit > 100) throw new InvalidArgumentError("记忆历史每页最多 100 个版本。"); if (beforeVersion !== undefined) integer(beforeVersion, 1);
      return (await ctx.query<VersionRow>(`SELECT * FROM memory_versions WHERE document_id = ?${beforeVersion === undefined ? '' : ' AND version < ?'} ORDER BY version DESC LIMIT ?`,
        [documentId, ...(beforeVersion === undefined ? [] : [beforeVersion]), limit])).map(toVersion);
    },
    async getVersion(documentId, version) {
      integer(version, 1); const row = await ctx.one<VersionRow>("SELECT * FROM memory_versions WHERE document_id = ? AND version = ?", [documentId, version]);
      return row ? toVersion(row) : null;
    },
    async createRequest(request) {
      return ctx.withTransaction(async () => {
        await active(request.projectId); integer(request.baseVersion); nonempty(request.triggerKey);
        if (request.evidence !== null) throw new InvalidArgumentError("新总结请求不能预填成功执行证据。");
        if (request.revision !== 1) throw new InvalidArgumentError("新总结请求 revision 必须为 1。");
        const member = await agentMember(request.projectId, request.agentId);
        if (member.id !== request.recipientMemberId) throw new InvalidReferenceError("总结接收人与目标 Agent 身份不匹配。");
        if (request.contextGroupId !== null) await groupScope(request.projectId, request.contextGroupId);
        if (request.documentId !== null) {
          const doc = toHead(await getHead(request.documentId));
          if (doc.key.scope !== 'project-agent' || doc.key.projectId !== request.projectId || doc.key.agentId !== request.agentId) throw new InvalidReferenceError("自动总结只能引用目标 Agent 的项目记忆。");
        }
        if (request.taskId !== null && !await ctx.one("SELECT id FROM tasks WHERE id = ? AND project_id = ?", [request.taskId, request.projectId])) throw new InvalidReferenceError("总结任务不属于该项目。");
        await ctx.exec(`INSERT INTO memory_summary_requests (id, project_id, agent_id, recipient_member_id, context_group_id, document_id,
          base_version, revision, state, trigger, trigger_key, task_id, completed_task_revision, message_ids, source_work_event_id, retry_of_request_id,
          attempt_id, begin_mutation_id, result_version, result_sha256, error, evidence, created_at, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [request.id, request.projectId, request.agentId, request.recipientMemberId, request.contextGroupId, request.documentId,
            request.baseVersion, request.revision, request.state, request.trigger, request.triggerKey, request.taskId, request.completedTaskRevision,
            json(request.messageIds), request.sourceWorkEventId, request.retryOfRequestId, request.attemptId, request.beginMutationId,
            request.resultVersion, request.resultSha256, request.error === null ? null : json(request.error), request.evidence === null ? null : json(request.evidence),
            request.createdAt, request.startedAt, request.finishedAt]);
        return (await repo.getRequest(request.id))!;
      });
    },
    async findRequestByTrigger(projectId, agentId, triggerKey) {
      const row = await ctx.one<RequestRow>("SELECT * FROM memory_summary_requests WHERE project_id = ? AND agent_id = ? AND trigger_key = ?", [projectId, agentId, triggerKey]);
      return row ? toRequest(row) : null;
    },
    async getRequest(requestId) {
      const row = await ctx.one<RequestRow>("SELECT * FROM memory_summary_requests WHERE id = ?", [requestId]); return row ? toRequest(row) : null;
    },
    async listRequests(projectId, agentId, state, query) {
      const cutoff = query?.startedBefore;
      const limit = query?.limit ?? (cutoff === undefined ? undefined : 50);
      if (query?.contextGroupId !== undefined) nonempty(query.contextGroupId);
      const scopeSql = query === undefined ? '' : query.contextGroupId === undefined ? ' AND context_group_id IS NULL' : ' AND (context_group_id IS NULL OR context_group_id = ?)';
      if (limit !== undefined) { integer(limit, 1); if (limit > 50) throw new InvalidArgumentError("总结请求每批最多 50 条。"); }
      if (cutoff !== undefined && (state !== 'running' || typeof cutoff !== 'string' || cutoff.length > 64 || !Number.isFinite(Date.parse(cutoff)))) {
        throw new InvalidArgumentError("过期筛选只用于运行请求，且需要有效时间。");
      }
      return (await ctx.query<RequestRow>(`SELECT * FROM memory_summary_requests WHERE project_id = ? AND agent_id = ?${state === undefined ? '' : ' AND state = ?'}${cutoff === undefined ? '' : ' AND started_at <= ?'}${scopeSql}
        ORDER BY ${cutoff === undefined ? 'created_at' : 'started_at'}, id${limit === undefined ? '' : ' LIMIT ?'}`,
        [projectId, agentId, ...(state === undefined ? [] : [state]), ...(cutoff === undefined ? [] : [cutoff]), ...(query?.contextGroupId === undefined ? [] : [query.contextGroupId]), ...(limit === undefined ? [] : [limit])])).map(toRequest);
    },
    async updateRequestCas(requestId, expectedRevision, patch) {
      return ctx.withTransaction(async () => {
        integer(expectedRevision, 1);
        const allowed = new Set(['revision', 'state', 'attemptId', 'beginMutationId', 'resultVersion', 'resultSha256', 'error', 'evidence', 'startedAt', 'finishedAt']);
        if (Object.keys(patch).some(k => !allowed.has(k)) || (patch.revision !== undefined && patch.revision !== expectedRevision + 1)) throw new InvalidArgumentError("总结请求来源与基准不可改写。");
        const current = await repo.getRequest(requestId); if (!current) throw new NotFoundError("总结请求不存在。");
        await active(current.projectId);
        if (!['pending', 'running'].includes(current.state)) throw new ConflictError("总结终态不可改写；如需重试请创建新请求。");
        const next = { ...current, ...patch, revision: expectedRevision + 1 };
        if ((next.state === 'completed' && (current.state !== 'running' || next.evidence === null || next.resultVersion === null || next.resultSha256 !== next.evidence.outputSha256))
          || (next.state !== 'completed' && next.evidence !== null)) throw new InvalidArgumentError("成功证据只能随完成状态和结果版本原子写入。");
        if (!await ctx.exec(`UPDATE memory_summary_requests SET revision = ?, state = ?, attempt_id = ?, begin_mutation_id = ?, result_version = ?,
          result_sha256 = ?, error = ?, evidence = ?, started_at = ?, finished_at = ? WHERE id = ? AND revision = ?`,
          [next.revision, next.state, next.attemptId, next.beginMutationId, next.resultVersion, next.resultSha256,
            next.error === null ? null : json(next.error), next.evidence === null ? null : json(next.evidence), next.startedAt, next.finishedAt, requestId, expectedRevision])) throw new ConflictError("memory_request_conflict");
        return (await repo.getRequest(requestId))!;
      });
    },
    async cancelForMemberLifecycleCas(projectId, memberId, requestId, expectedRevision, at) {
      integer(expectedRevision, 1); nonempty(memberId); nonempty(requestId);
      await ctx.withTransaction(async () => {
        await active(projectId);
        const current = await ctx.one<{ project_id: string; recipient_member_id: string; state: SummaryState; revision: number }>(
          "SELECT project_id, recipient_member_id, state, revision FROM memory_summary_requests WHERE id = ?", [requestId]);
        if (!current || current.project_id !== projectId || current.recipient_member_id !== memberId
          || current.revision !== expectedRevision || !["pending", "running"].includes(current.state)) throw new ConflictError("memory_request_conflict");
        if (!await ctx.exec(`UPDATE memory_summary_requests SET state = 'cancelled', revision = revision + 1, error = ?, finished_at = ?
          WHERE id = ? AND project_id = ? AND recipient_member_id = ? AND revision = ? AND state IN ('pending', 'running')`,
          [json({ code: "member_removed", message: "目标成员已移除，旧总结请求已取消。" }), at, requestId, projectId, memberId, expectedRevision])) throw new ConflictError("memory_request_conflict");
      });
    },
    async observeDeliveredMessage(input) {
      return ctx.withTransaction(async () => {
        integer(input.threshold, 1); if (input.threshold > 10000) throw new InvalidArgumentError("消息总结阈值最多 10000。");
        await active(input.projectId); await groupScope(input.projectId, input.groupId);
        const member = await agentMember(input.projectId, input.agentId);
        if (!await ctx.one(`SELECT d.id FROM message_deliveries d JOIN messages m ON m.id = d.message_id
          WHERE d.project_id = ? AND d.member_id = ? AND m.group_id = ? AND m.id = ? AND d.first_mcp_delivered_at IS NOT NULL`,
          [input.projectId, member.id, input.groupId, input.messageId])) throw new InvalidReferenceError("消息没有该 Agent 的真实 MCP 投递事实。");
        if (await ctx.one("SELECT message_id FROM memory_message_receipts WHERE agent_id = ? AND message_id = ?", [input.agentId, input.messageId])) return { added: false, thresholdSequence: null, messageIds: [] };
        const scope = [input.projectId, input.agentId, input.groupId];
        await ctx.exec(`INSERT INTO memory_trigger_counters (project_id, agent_id, group_id, lifetime_count, next_threshold, configured_n, threshold_sequence, revision)
          VALUES (?, ?, ?, 0, ?, ?, 0, 1) ON CONFLICT (project_id, agent_id, group_id) DO NOTHING`, [...scope, input.threshold, input.threshold]);
        const previous = (await ctx.one<CounterRow>("SELECT * FROM memory_trigger_counters WHERE project_id = ? AND agent_id = ? AND group_id = ?", scope))!;
        const count = previous.lifetime_count + 1;
        let nextThreshold = previous.configured_n === input.threshold ? previous.next_threshold : previous.lifetime_count + input.threshold;
        const reached = count >= nextThreshold;
        const sequence = previous.threshold_sequence + (reached ? 1 : 0);
        if (reached) nextThreshold += input.threshold;
        // 项目行锁 + revision CAS 同时保护 PG 跨连接计数；收据插入失败会回滚此增量。
        if (!await ctx.exec(`UPDATE memory_trigger_counters SET lifetime_count = ?, next_threshold = ?, configured_n = ?, threshold_sequence = ?, revision = revision + 1
          WHERE project_id = ? AND agent_id = ? AND group_id = ? AND revision = ?`,
          [count, nextThreshold, input.threshold, sequence, ...scope, previous.revision])) throw new ConflictError("memory_counter_conflict");
        await ctx.exec(`INSERT INTO memory_message_receipts (project_id, agent_id, group_id, message_id, first_observed_at, counter_value) VALUES (?, ?, ?, ?, ?, ?)`,
          [...scope, input.messageId, input.at, count]);
        const messageIds = reached ? (await ctx.query<{ message_id: string }>(`SELECT message_id FROM memory_message_receipts
          WHERE project_id = ? AND agent_id = ? AND group_id = ? AND counter_value > ? AND counter_value <= ? ORDER BY counter_value, message_id`,
          [...scope, count - input.threshold, count])).map(r => r.message_id) : [];
        return { added: true, thresholdSequence: reached ? sequence : null, messageIds };
      });
    },
    async getScanCheckpoint(scope) {
      const row = await ctx.one<CheckpointRow>("SELECT * FROM memory_scan_checkpoints WHERE id = ?", [scopeId(scope)]);
      return row ? toCheckpoint(row) : { scope: { ...scope }, after: null, through: null, sweep: 0, revision: 0 };
    },
    async updateScanCheckpointCas(checkpoint, expectedRevision) {
      return ctx.withTransaction(async () => {
        const id = scopeId(checkpoint.scope); integer(expectedRevision); integer(checkpoint.sweep); validCursor(checkpoint.after); validCursor(checkpoint.through);
        if (checkpoint.revision !== expectedRevision + 1 || (checkpoint.after && (!checkpoint.through || cursorOrder(checkpoint.after, checkpoint.through) > 0))) throw new InvalidArgumentError("扫描检查点版本或游标无效。");
        const s = checkpoint.scope; await active(s.projectId); await agentMember(s.projectId, s.agentId); if (s.groupId !== null) await groupScope(s.projectId, s.groupId);
        const after = checkpoint.after === null ? null : json(checkpoint.after); const through = checkpoint.through === null ? null : json(checkpoint.through);
        const changed = expectedRevision === 0
          ? await ctx.exec(`INSERT INTO memory_scan_checkpoints (id, kind, project_id, agent_id, group_id, after_cursor, through_cursor, sweep, revision, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING`, [id, s.kind, s.projectId, s.agentId, s.groupId, after, through, checkpoint.sweep, new Date().toISOString()])
          : await ctx.exec(`UPDATE memory_scan_checkpoints SET after_cursor = ?, through_cursor = ?, sweep = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
            [after, through, checkpoint.sweep, new Date().toISOString(), id, expectedRevision]);
        if (!changed) throw new ConflictError("memory_scan_conflict"); return repo.getScanCheckpoint(s);
      });
    },
    async scanHighWater(scope) {
      validScope(scope);
      const row = scope.kind === 'message_threshold'
        ? await ctx.one<{ at: string; id: string }>(`SELECT d.first_mcp_delivered_at AS at, d.id FROM message_deliveries d
            JOIN messages m ON m.id = d.message_id JOIN members mem ON mem.id = d.member_id
            WHERE d.project_id = ? AND mem.agent_id = ? AND mem.project_id = ? AND m.group_id = ? AND d.first_mcp_delivered_at IS NOT NULL
            ORDER BY d.first_mcp_delivered_at DESC, d.id DESC LIMIT 1`, [scope.projectId, scope.agentId, scope.projectId, scope.groupId])
        : await ctx.one<{ at: string; id: string }>("SELECT created_at AS at, id FROM work_events WHERE project_id = ? AND kind = 'task.review_decided' ORDER BY created_at DESC, id DESC LIMIT 1", [scope.projectId]);
      return row ?? null;
    },
    async unobservedDeliveries(projectId, memberId, groupId, page) {
      const cursor = pageWhere('d.first_mcp_delivered_at', 'd.id', page);
      const raw = await ctx.query<{ id: string; at: string; message_id: string; group_id: string; observed: number }>(`SELECT d.id, d.first_mcp_delivered_at AS at, m.id AS message_id, m.group_id,
        CASE WHEN EXISTS (SELECT 1 FROM memory_message_receipts r WHERE r.agent_id = mem.agent_id AND r.message_id = m.id) THEN 1 ELSE 0 END AS observed
        FROM message_deliveries d JOIN messages m ON m.id = d.message_id JOIN groups g ON g.id = m.group_id JOIN members mem ON mem.id = d.member_id
        WHERE d.project_id = ? AND d.member_id = ? AND mem.project_id = ? AND g.project_id = ? AND m.group_id = ? AND d.first_mcp_delivered_at IS NOT NULL${cursor.sql}
        ORDER BY d.first_mcp_delivered_at, d.id LIMIT ?`, [projectId, memberId, projectId, projectId, groupId, ...cursor.params, page.limit + 1]);
      const scanned = raw.slice(0, page.limit); const last = scanned.at(-1);
      return { rows: scanned.filter(r => !r.observed).map(r => ({ messageId: r.message_id, groupId: r.group_id })),
        nextCursor: last ? { at: last.at, id: last.id } : null, hasMore: raw.length > page.limit, scannedCount: scanned.length };
    },
    async scanUnmaterializedTaskCompletions(projectId, agentId, page) {
      const cursor = pageWhere('created_at', 'id', page);
      const raw = await ctx.query<{ id: string; created_at: string; task_id: string | null; recipient_member_id: string; payload: string }>(`SELECT id, created_at, task_id, recipient_member_id, payload FROM work_events
        WHERE project_id = ? AND kind = 'task.review_decided'${cursor.sql} ORDER BY created_at, id LIMIT ?`, [projectId, ...cursor.params, page.limit + 1]);
      const scanned = raw.slice(0, page.limit); const rows: TaskCompletionSource[] = [];
      for (const event of scanned) {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(event.payload); } catch { continue; }
        if (!payload || typeof payload !== 'object' || payload.enteredDone !== true || payload.assigneeAgentId !== agentId
          || !Number.isSafeInteger(payload.completionRevision) || Number(payload.completionRevision) < 1 || event.task_id === null) continue;
        const completionRevision = Number(payload.completionRevision); const triggerKey = `task:${event.task_id}:done:${completionRevision}:agent:${agentId}`;
        if (await ctx.one(`SELECT id FROM memory_summary_requests WHERE project_id = ? AND agent_id = ? AND (source_work_event_id = ? OR trigger_key = ?) LIMIT 1`,
          [projectId, agentId, event.id, triggerKey])) continue;
        rows.push({ eventId: event.id, taskId: event.task_id, completionRevision, assigneeAgentId: agentId, recipientMemberId: event.recipient_member_id, triggerKey });
      }
      const last = scanned.at(-1);
      return { rows, nextCursor: last ? { at: last.created_at, id: last.id } : null, hasMore: raw.length > page.limit, scannedCount: scanned.length };
    },
  };
  return repo;
}

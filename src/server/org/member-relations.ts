import { isDeepStrictEqual } from "node:util";
import { repositoryDriver, type RepoCtx, type RepositorySet } from "../db/repositories.ts";
import { eligibleWorkEventSql, hasWorkEventInvalidations, type WorkEventInvalidationClosure } from "../tasks/work-event-storage.ts";
import { prepareWorkEventInvalidations } from "../tasks/work-event-lifecycle.ts";
import { prepareLifecycleDecisionCancellations } from "../decisions/lifecycle.ts";
import type { DbRow } from "../db/driver.ts";
import type { Member } from "../db/types.ts";
import { MEMBER_FACT_KINDS } from "../db/types.ts";
import { RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { assertCompleteAuditFields } from "../audit.ts";
import type { MutationDiscover } from "../db/mutation-scope.ts";
import type { MemberCaptureBudget, MemberRelationsSnapshotV2, RestartRequired } from "./compensation-types.ts";
import { MEMBER_CAPTURE_BUDGET } from "./compensation-types.ts";
import { boundedText, CaptureBudget, captureExceeded, safeRevision } from "./capture-budget.ts";
import { conflict } from "./boundary.ts";
import type { TaskState, ReviewRoundState } from "../../shared/tasks.ts";

type TaskProjection = MemberRelationsSnapshotV2["tasks"][number];
type RoundProjection = MemberRelationsSnapshotV2["invalidatedRounds"][number];
type IdRow = { id: string };
type TaskMetadataRow = { id: string; revision: number; assignee_member_id: string | null; reviewer_member_id: string | null; state: TaskState; current_review_round_id: string | null };
type TaskRow = TaskMetadataRow & { blocked_reason: string | null };
type RoundRow = { id: string; task_id: string; revision: number; state: ReviewRoundState };
// SQLite substr/length 会在 NUL 停止。追加非 NUL 字符后 length 未增加，说明前缀不能代表完整源。
// PG TEXT 不接受 NUL；同一表达式对合法文本返回1，对真正的NULL返回NULL。
// 每字段只增加一个标量，原文本投影、查询次数及64KiB单行上界不变。
const prefix = (column: string, bytes = 1024) => `substr(${column}, 1, ${bytes + 1}) AS ${column.split('.').at(-1)},
  length(${column} || '.') - length(${column}) AS __capture_${column.split('.').at(-1)}_terminated`;
function completePrefixes(row: object | undefined): void {
  if (!row) return;
  for (const [key, value] of Object.entries(row)) if (key.startsWith('__capture_') && value !== null && Number(value) !== 1) {
    captureExceeded("关系文本含 NUL，数据库前缀无法完整采集");
  }
}
// JSON 对控制字符最多扩成6字节。4个1025字符ID的元数据行<25KiB；
// id + 8193字符文本独立行<56KiB。合并投影在坏输入下可超过64KiB，不能用作分页上界。
const taskColumns = `${prefix('id')}, revision, ${prefix('assignee_member_id')}, ${prefix('reviewer_member_id')}, state, ${prefix('current_review_round_id')}`;
const taskTextColumns = `${prefix('id')}, ${prefix('blocked_reason', 8192)}`;
const roundColumns = `${prefix('id')}, ${prefix('task_id')}, revision, state`;
function id(value: unknown): string { return boundedText(value)!; }
function nullable(value: unknown): string | null { return boundedText(value, 1024, true); }
function taskProjection(row: TaskRow): TaskProjection {
  if (!['todo', 'in-progress', 'review', 'blocked', 'done'].includes(row.state)) conflict("任务状态损坏。");
  return { taskId: id(row.id), revision: safeRevision(row.revision), assigneeMemberId: nullable(row.assignee_member_id), reviewerMemberId: nullable(row.reviewer_member_id),
    state: row.state, blockedReason: row.blocked_reason === '' ? '' : boundedText(row.blocked_reason, 8192, true), currentReviewRoundId: nullable(row.current_review_round_id) };
}
function roundProjection(row: RoundRow): RoundProjection {
  if (!['ready', 'running', 'reported', 'decided', 'failed', 'superseded'].includes(row.state)) conflict("评审状态损坏。");
  return { roundId: id(row.id), taskId: id(row.task_id), revision: safeRevision(row.revision), state: row.state };
}
function sorted<T>(rows: T[], key: (row: T) => string): T[] { return [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0); }
function uniqueIds(values: readonly string[], max = 512): string[] {
  const found = [...new Set(values)].sort(); if (found.length > max) captureExceeded("单类关系超过预算"); found.forEach(id); return found;
}
/** 原始行游标前进；单次 query <=32 行，类上限的最后一条只作为越界哨兵。 */
async function pages<T extends DbRow>(ctx: RepoCtx, budget: CaptureBudget, columns: string, table: string, where: string, params: readonly unknown[], key = 'id', max = 512): Promise<T[]> {
  const result: T[] = []; let after = '';
  while (true) {
    const limit = Math.min(budget.pageSize(), max - result.length + 1);
    const rows = await ctx.query<T>(`SELECT ${columns} FROM ${table} WHERE ${where} AND ${key} > ? ORDER BY ${key} LIMIT ?`, [...params, after, limit]);
    if (rows.length === 0) break;
    rows.forEach(completePrefixes);
    for (const row of rows) { const current = id(row[key.split('.').at(-1)!]); if (current <= after) conflict("分页关系游标不前进。"); after = current; result.push(row); }
    if (result.length > max) captureExceeded("关系集合超过单类上限");
    if (rows.length < limit) break;
  }
  return result;
}
async function byIds<T extends DbRow>(ctx: RepoCtx, budget: CaptureBudget, columns: string, table: string, projectId: string, values: readonly string[]): Promise<T[]> {
  const ids = uniqueIds(values); const rows: T[] = [];
  for (let start = 0; start < ids.length;) {
    const batch = ids.slice(start, start + budget.pageSize());
    const found = await ctx.query<T>(`SELECT ${columns} FROM ${table} WHERE project_id = ? AND id IN (${batch.map(() => '?').join(',')}) ORDER BY id`, [projectId, ...batch]);
    found.forEach(completePrefixes);
    if (found.length !== batch.length) conflict("被观察关系已删除或不属于项目。"); rows.push(...found);
    start += batch.length;
  }
  return rows;
}
export async function readLifecycleMember(ctx: RepoCtx, memberId: string): Promise<Member | null> {
  const row = await ctx.one<Record<string, unknown>>(`SELECT ${['id', 'project_id', 'agent_id', 'node_id', 'removed_at', 'created_at', 'updated_at'].map(c => prefix(c)).join(',')},
    kind, role, status, membership_revision FROM members WHERE id = ?`, [memberId]);
  if (!row) return null;
  completePrefixes(row);
  // 7个1025字符字段的元数据<44KiB，名字独立投影<50KiB；原8192字节契约不缩小。
  const name = await ctx.one<{ display_name: string }>(`SELECT ${prefix('display_name', 8192)} FROM members WHERE id = ?`, [memberId]);
  if (!name) conflict("读取有界成员投影期间成员已变化。");
  completePrefixes(name);
  if (!['human', 'agent'].includes(String(row.kind)) || !['manager', 'normal'].includes(String(row.role)) || !['active', 'disabled', 'pending'].includes(String(row.status))) conflict("成员字段损坏。");
  return { id: id(row.id), projectId: id(row.project_id), agentId: nullable(row.agent_id), nodeId: nullable(row.node_id), removedAt: nullable(row.removed_at),
    displayName: boundedText(name.display_name, 8192)!, kind: row.kind as Member['kind'], role: row.role as Member['role'], status: row.status as Member['status'],
    membershipRevision: safeRevision(row.membership_revision), createdAt: id(row.created_at), updatedAt: id(row.updated_at) };
}
export interface MemberWatch { watchedTaskIds: string[]; watchedRoundIds: string[]; watchSettings: boolean }
export interface MemberCaptureInput extends MemberWatch { projectId: string; memberId: string; budget: Readonly<MemberCaptureBudget>; tracker?: CaptureBudget }
type Cleanup = {
  requests: Array<{ id: string; revision: number }>;
  sessions: Array<{ id: string; groupId: string }>;
  bindings: Array<{ id: string; runtimeId: string; groupId: string; revision: number; stopped: boolean }>;
  events: Array<{ id: string; recipientMemberId: string }>;
  reservation: { bindingId: string | null; leased: boolean } | null;
  hasStatus: boolean;
};
export interface CapturedMember { snapshot: MemberRelationsSnapshotV2; cleanup: Cleanup }
export function watchFromSnapshots(...snapshots: MemberRelationsSnapshotV2[]): MemberWatch {
  return { watchedTaskIds: uniqueIds(snapshots.flatMap(s => s.tasks.map(t => t.taskId))), watchedRoundIds: uniqueIds(snapshots.flatMap(s => s.invalidatedRounds.map(r => r.roundId))),
    watchSettings: snapshots.some(s => s.settings !== null) };
}
export function emptyMemberSnapshot(projectId: string, memberId: string): MemberRelationsSnapshotV2 {
  return { schema: 'member-relations/v2', projectId, targetId: memberId, presence: 'absent', member: null, participants: [], tasks: [], settings: null,
    invalidatedRounds: [], retained: [], transient: { workEventIds: [], mcpSessionIds: [], runtimeBindingIds: [] } };
}
export async function captureMember(repos: RepositorySet, input: MemberCaptureInput): Promise<CapturedMember> {
  const { projectId, memberId } = input, tracker = CaptureBudget.current() ?? input.tracker ?? new CaptureBudget(input.budget), ctx = repos.context;
  const scope = repos.mutations.current(); if (!scope) throw new RepositoryError('mutation_scope_changed', '成员快照必须在共同事务锁内采集。'); scope.assertCovers([projectId], [memberId]);
  tracker.adoptScope(scope.startedAt);
  if (!await ctx.one('SELECT version FROM schema_migrations WHERE version = 13')) throw new RepositoryError('legacy_incomplete_snapshot', '成员关系补偿需要 v13 schema。');
  const member = await readLifecycleMember(ctx, memberId);
  const cleanup: Cleanup = { requests: [], sessions: [], bindings: [], events: [], reservation: null, hasStatus: false };
  if (member === null) return { snapshot: emptyMemberSnapshot(projectId, memberId), cleanup };
  if (member.projectId !== projectId) conflict("成员身份跨项目。");
  const participants = (await pages<{ group_id: string; joined_at: string }>(ctx, tracker, `${prefix('group_id')}, ${prefix('joined_at')}`, 'group_participants', 'member_id = ?', [memberId], 'group_id', 128))
    .map(row => ({ groupId: id(row.group_id), joinedAt: id(row.joined_at) }));
  const taskRows: TaskMetadataRow[] = [];
  for (const field of ['assignee_member_id', 'reviewer_member_id']) taskRows.push(...await pages<TaskMetadataRow>(ctx, tracker, taskColumns, 'tasks', `project_id = ? AND ${field} = ?`, [projectId, memberId]));
  taskRows.push(...await byIds<TaskMetadataRow>(ctx, tracker, taskColumns, 'tasks', projectId, input.watchedTaskIds));
  // 当前评审可能只保留 reviewer 快照；每类 state 使用独立 seek，绝不扫描历史已终态轮次。
  const currentRounds: RoundRow[] = [];
  for (const state of ['ready', 'running', 'reported']) currentRounds.push(...await pages<RoundRow>(ctx, tracker, roundColumns, 'task_review_rounds', 'project_id = ? AND reviewer_member_id = ? AND state = ?', [projectId, memberId, state]));
  uniqueIds(currentRounds.map(r => id(r.id)));
  taskRows.push(...await byIds<TaskMetadataRow>(ctx, tracker, taskColumns, 'tasks', projectId, currentRounds.map(r => id(r.task_id))));
  const reasons = new Map((await byIds<{ id: string; blocked_reason: string | null }>(ctx, tracker,
    taskTextColumns, 'tasks', projectId, taskRows.map(r => id(r.id)))).map(r => [id(r.id), r.blocked_reason]));
  const tasksById = new Map(taskRows.map(r => [id(r.id), taskProjection({ ...r, blocked_reason: reasons.get(id(r.id))! })]));
  const currentIds = new Set([...tasksById.values()].map(t => t.currentReviewRoundId).filter((v): v is string => v !== null));
  const roundIds = uniqueIds([...input.watchedRoundIds, ...currentIds]);
  const rounds = (await byIds<RoundRow>(ctx, tracker, roundColumns, 'task_review_rounds', projectId, roundIds)).map(roundProjection);
  const tasks = sorted([...tasksById.values()], t => t.taskId); uniqueIds(tasks.map(t => t.taskId));
  // 有旧非当前 ready 行时不把无关 task 混入补偿目标；它已被计入有界读取预算。
  const actualTasks = tasks.filter(t => input.watchedTaskIds.includes(t.taskId) || t.assigneeMemberId === memberId || t.reviewerMemberId === memberId || currentRounds.some(r => r.id === t.currentReviewRoundId));
  const settingsRow = await ctx.one<{ revision: number; default_reviewer_member_id: string | null }>(`SELECT revision, ${prefix('default_reviewer_member_id')} FROM project_task_settings WHERE project_id = ?`, [projectId]);
  completePrefixes(settingsRow);
  const settings = settingsRow && (input.watchSettings || settingsRow.default_reviewer_member_id === memberId)
    ? { projectId, revision: safeRevision(settingsRow.revision), defaultReviewerMemberId: nullable(settingsRow.default_reviewer_member_id) } : null;
  const retained = await repos.members.retainedFacts(memberId);
  for (const state of ['pending', 'running']) cleanup.requests.push(...(await pages<{ id: string; revision: number }>(ctx, tracker, `${prefix('id')}, revision`, 'memory_summary_requests', 'project_id = ? AND recipient_member_id = ? AND state = ?', [projectId, memberId, state]))
    .map(row => ({ id: id(row.id), revision: safeRevision(row.revision) })));
  uniqueIds(cleanup.requests.map(r => r.id));
  cleanup.sessions = (await pages<{ id: string; group_id: string }>(ctx, tracker, `${prefix('id')}, ${prefix('group_id')}`, 'mcp_sessions', "project_id = ? AND member_id = ? AND state = 'connected'", [projectId, memberId])).map(r => ({ id: id(r.id), groupId: id(r.group_id) }));
  cleanup.bindings = (await pages<{ id: string; runtime_id: string; group_id: string; revision: number; stopped: number }>(ctx, tracker,
    `${prefix('b.id')}, ${prefix('b.runtime_id')}, ${prefix('b.group_id')}, b.revision, CASE WHEN b.desired_state = 'stopped' AND s.lease_owner IS NULL AND s.exit_confirmed = 1 AND s.state IN ('stopped','failed') THEN 1 ELSE 0 END AS stopped`,
    'agent_runtime_bindings b LEFT JOIN agent_runner_states s ON s.binding_id = b.id', 'b.project_id = ? AND b.member_id = ?', [projectId, memberId], 'b.id'))
    .map(r => ({ id: id(r.id), runtimeId: id(r.runtime_id), groupId: id(r.group_id), revision: safeRevision(r.revision), stopped: Number(r.stopped) === 1 }));
  const reservation = await ctx.one<{ binding_id: string | null; leased: number }>(`SELECT ${prefix('binding_id')}, CASE WHEN lease_owner IS NULL AND lease_expires_at IS NULL THEN 0 ELSE 1 END AS leased FROM agent_runtime_members WHERE project_id = ? AND member_id = ?`, [projectId, memberId]);
  completePrefixes(reservation);
  cleanup.reservation = reservation ? { bindingId: nullable(reservation.binding_id), leased: Number(reservation.leased) === 1 } : null;
  cleanup.hasStatus = Boolean(await ctx.one("SELECT member_id FROM member_statuses WHERE project_id = ? AND member_id = ?", [projectId, memberId]));
  cleanup.events = (await pages<{ id: string; recipient_member_id: string }>(ctx, tracker, `${prefix('id')}, ${prefix('recipient_member_id')}`, 'work_events', `project_id = ? AND recipient_member_id = ?${await eligibleWorkEventSql(ctx)}`, [projectId, memberId]))
    .map(r => ({ id: id(r.id), recipientMemberId: id(r.recipient_member_id) }));
  const snapshot: MemberRelationsSnapshotV2 = { schema: 'member-relations/v2', projectId, targetId: memberId, presence: member.removedAt === null ? 'present' : 'removed', member, participants,
    tasks: actualTasks, settings, invalidatedRounds: sorted(rounds.filter(r => actualTasks.some(t => t.taskId === r.taskId) || input.watchedRoundIds.includes(r.roundId)), r => r.roundId), retained,
    transient: { workEventIds: cleanup.events.map(r => r.id).sort(), mcpSessionIds: cleanup.sessions.map(r => r.id).sort(), runtimeBindingIds: cleanup.bindings.map(r => r.id).sort() } };
  assertCompleteAuditFields(snapshot); return { snapshot, cleanup };
}
export async function captureMemberRelations(repos: RepositorySet, input: MemberCaptureInput): Promise<MemberRelationsSnapshotV2> {
  const tracker = CaptureBudget.current() ?? input.tracker ?? new CaptureBudget(input.budget);
  return tracker.run(async () => (await captureMember(repos, { ...input, tracker })).snapshot);
}
function equalMembers(a: Member | null, b: Member | null): boolean {
  const projection = (m: Member | null) => m === null ? null : { ...m, updatedAt: undefined };
  return isDeepStrictEqual(projection(a), projection(b));
}
export function equalMemberSnapshot(a: MemberRelationsSnapshotV2, b: MemberRelationsSnapshotV2): boolean {
  return equalMembers(a.member, b.member) && isDeepStrictEqual({ ...a, member: null }, { ...b, member: null });
}
/** 只读计划在项目锁后执行；先列所有引用成员，再统一获取成员/群/运行时锁。 */
export function discoverMemberRelations(projectId: string, memberId: string, watch: MemberWatch, tracker: CaptureBudget,
  extraMembers: readonly string[] = [], extraGroups: readonly string[] = []): MutationDiscover {
  return async tx => {
    const columns = `${prefix('id')}, ${prefix('assignee_member_id')}, ${prefix('reviewer_member_id')}`;
    const refs: Array<{ id: string; assignee_member_id: string | null; reviewer_member_id: string | null }> = [];
    for (const field of ['assignee_member_id', 'reviewer_member_id']) refs.push(...await pages<{ id: string; assignee_member_id: string | null; reviewer_member_id: string | null }>(tx, tracker,
      columns, 'tasks', `project_id = ? AND ${field} = ?`, [projectId, memberId]));
    refs.push(...await byIds<{ id: string; assignee_member_id: string | null; reviewer_member_id: string | null }>(tx, tracker, `${prefix('id')}, ${prefix('assignee_member_id')}, ${prefix('reviewer_member_id')}`, 'tasks', projectId, watch.watchedTaskIds));
    const rounds: Array<{ id: string; task_id: string }> = [];
    for (const state of ['ready', 'running', 'reported']) rounds.push(...await pages<{ id: string; task_id: string }>(tx, tracker,
      `${prefix('id')}, ${prefix('task_id')}`, 'task_review_rounds', 'project_id = ? AND reviewer_member_id = ? AND state = ?', [projectId, memberId, state]));
    refs.push(...await byIds<{ id: string; assignee_member_id: string | null; reviewer_member_id: string | null }>(tx, tracker, columns, 'tasks', projectId, rounds.map(r => id(r.task_id))));
    const groups = await pages<{ group_id: string }>(tx, tracker, prefix('group_id'), 'group_participants', 'member_id = ?', [memberId], 'group_id', 128);
    const bindings = await pages<{ id: string; runtime_id: string; group_id: string }>(tx, tracker, `${prefix('id')}, ${prefix('runtime_id')}, ${prefix('group_id')}`, 'agent_runtime_bindings', 'project_id = ? AND member_id = ?', [projectId, memberId]);
    const events = await pages<{ id: string; recipient_member_id: string; context_group_id: string | null }>(tx, tracker, `${prefix('id')}, ${prefix('recipient_member_id')}, ${prefix('context_group_id')}`, 'work_events', `project_id = ? AND recipient_member_id = ?${await eligibleWorkEventSql(tx)}`, [projectId, memberId]);
    for (const taskId of uniqueIds(refs.map(t => id(t.id)))) for (const state of ['pending','delivered']) events.push(...await pages<{ id: string; recipient_member_id: string; context_group_id: string | null }>(tx, tracker,
      `${prefix('id')}, ${prefix('recipient_member_id')}, ${prefix('context_group_id')}`, 'work_events', `project_id = ? AND task_id = ? AND delivery_state = ?${await eligibleWorkEventSql(tx)}`, [projectId, taskId, state]));
    uniqueIds(events.map(e => id(e.id)));
    const sessions = await pages<{ id: string; group_id: string }>(tx, tracker, `${prefix('id')}, ${prefix('group_id')}`, 'mcp_sessions', "project_id = ? AND member_id = ? AND state = 'connected'", [projectId, memberId]);
    const reservation = await tx.one<{ runtime_id: string }>(`SELECT ${prefix('runtime_id')} FROM agent_runtime_members WHERE project_id = ? AND member_id = ?`, [projectId, memberId]);
    completePrefixes(reservation);
    const decisionOwners = await tx.one('SELECT version FROM schema_migrations WHERE version = 20')
      ? await tx.query<{ id: string }>(`SELECT m.id FROM members m LEFT JOIN org_nodes n ON n.id = m.node_id
          WHERE m.project_id = ? AND (m.role = 'manager' OR n.role IN ('top_manager','sub_manager')) ORDER BY m.id LIMIT 2049`, [projectId]) : [];
    return { memberIds: uniqueIds([memberId, ...extraMembers, ...decisionOwners.map(m => id(m.id)), ...refs.flatMap(r => [nullable(r.assignee_member_id), nullable(r.reviewer_member_id)]).filter((v): v is string => v !== null), ...events.map(e => id(e.recipient_member_id))], 2048),
      groupIds: uniqueIds([...extraGroups, ...groups.map(g => id(g.group_id)), ...bindings.map(b => id(b.group_id)), ...sessions.map(s => id(s.group_id)), ...events.map(e => nullable(e.context_group_id)).filter((v): v is string => v !== null)]),
      runtimeIds: uniqueIds([...bindings.map(b => id(b.runtime_id)), ...(reservation ? [id(reservation.runtime_id)] : [])]) };
  };
}

async function exactExec(ctx: RepoCtx, sql: string, values: unknown[], expected = 1): Promise<void> {
  if (await ctx.exec(sql, values) !== expected) conflict("关系写入行数与采集计划不一致。");
}
async function validateRestoredPosition(repos: RepositorySet, member: Member): Promise<void> {
  if (member.nodeId !== null) {
    const node = await repos.context.one<{ project_id: string; parent_id: string | null }>("SELECT project_id, parent_id FROM org_nodes WHERE id = ?", [member.nodeId]);
    if (!node || node.project_id !== member.projectId || (node.parent_id === null) !== (member.role === 'manager')) conflict("原岗位已不存在或角色不一致。");
    const occupied = await repos.context.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND node_id = ?", [member.projectId, member.nodeId]);
    if (occupied && occupied.id !== member.id) conflict("原岗位已被其他成员占据。");
  }
  if (member.role === 'manager') {
    const manager = await repos.context.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND role = 'manager' AND removed_at IS NULL", [member.projectId]);
    if (manager && manager.id !== member.id) conflict("项目已指定新的负责人。");
  }
}
/** 同一 RepoCtx；所有旧 transient 只失效，恢复永远不复活旧会话、轮次、请求或 binding。 */
export async function applyMemberCompensation(repos: RepositorySet, input: {
  expected: MemberRelationsSnapshotV2; target: MemberRelationsSnapshotV2; compensationAuditId: string; at: string;
  budget: Readonly<MemberCaptureBudget>; tracker?: CaptureBudget;
}): Promise<{ actualBefore: MemberRelationsSnapshotV2; actualAfter: MemberRelationsSnapshotV2; restartRequired: RestartRequired[];
  workEventInvalidations?: WorkEventInvalidationClosure; assertWorkEventAudit(): Promise<void> }> {
  const { expected, target, at, compensationAuditId } = input, ctx = repos.context;
  validateMemberSnapshot(expected, expected.projectId, expected.targetId); validateMemberSnapshot(target, expected.projectId, expected.targetId);
  const tracker = CaptureBudget.current() ?? input.tracker ?? new CaptureBudget(input.budget), watch = watchFromSnapshots(expected, target);
  if (!CaptureBudget.current()) return tracker.run(() => applyMemberCompensation(repos, { ...input, tracker }));
  const captured = await captureMember(repos, { projectId: expected.projectId, memberId: expected.targetId, ...watch, budget: input.budget, tracker });
  if (!equalMemberSnapshot(captured.snapshot, expected)) conflict("成员代际、参与关系、任务设置或保留事实已变化，不能覆盖后续操作。");
  const current = captured.snapshot.member; if (!current) conflict("历史成员身份已被永久删除。");
  if (target.member && (target.member.id !== current.id || target.member.projectId !== current.projectId || target.member.agentId !== current.agentId || target.member.kind !== current.kind || target.member.createdAt !== current.createdAt)) conflict("成员身份不是同一保留身份。");
  const restoring = target.presence === 'present';
  if (restoring && !target.member) conflict();
  if (captured.cleanup.bindings.some(b => !b.stopped) || captured.cleanup.reservation?.leased) throw new RepositoryError('conflict', 'runtime_must_stop_first');
  const desiredMember: Member = restoring ? { ...target.member!, membershipRevision: current.membershipRevision + 1, updatedAt: at, removedAt: null }
    : { ...current, role: 'normal', status: 'disabled', nodeId: null, removedAt: at, membershipRevision: current.membershipRevision + 1, updatedAt: at };
  if (restoring) await validateRestoredPosition(repos, desiredMember);
  // 原潜在参与边只按已核对 before/after 改变；缺群拒绝，归档群仍保留历史边。
  const desiredParticipants = target.presence === 'absent' ? expected.participants : target.participants;
  for (const p of desiredParticipants) if (!await ctx.one("SELECT id FROM groups WHERE project_id = ? AND id = ?", [current.projectId, p.groupId])) conflict("原群组已经永久删除。");
  const expectedTasks = new Map(expected.tasks.map(t => [t.taskId, t]));
  const targetTasks = new Map(target.tasks.map(t => [t.taskId, t]));
  if (target.presence !== 'absent' && !isDeepStrictEqual([...expectedTasks.keys()], [...targetTasks.keys()])) conflict("任务观察闭包不一致。");
  const plans: Array<{ before: TaskProjection; after: TaskProjection }> = [];
  for (const before of expected.tasks) {
    const desired = restoring ? targetTasks.get(before.taskId)! : before;
    if (!desired) conflict();
    const after: TaskProjection = { ...desired, revision: before.revision + 1, currentReviewRoundId: null };
    if (!restoring) {
      after.assigneeMemberId = before.assigneeMemberId === current.id ? null : before.assigneeMemberId;
      after.reviewerMemberId = before.reviewerMemberId === current.id ? null : before.reviewerMemberId;
      after.state = before.state === 'done' ? 'done' : 'blocked';
      after.blockedReason = before.state === 'done' ? before.blockedReason : 'member_removed';
    } else {
      if (after.state === 'review') { after.state = 'in-progress'; after.blockedReason = null; }
      for (const memberId of uniqueIds([after.assigneeMemberId, after.reviewerMemberId].filter((v): v is string => v !== null))) {
        const m = memberId === current.id ? desiredMember : await readLifecycleMember(ctx, memberId);
        if (!m || m.projectId !== current.projectId || m.removedAt !== null) conflict("原任务引用成员已移除或跨项目。");
        if (m.status !== 'active' && after.state !== 'done') { after.state = 'blocked'; after.blockedReason = 'member_inactive'; }
      }
    }
    plans.push({ before, after });
  }
  const events = new Map(captured.cleanup.events.map(e => [e.id, e]));
  for (const { before } of plans) for (const state of ['pending','delivered']) {
    const rows = await pages<{ id: string; recipient_member_id: string }>(ctx, tracker, `${prefix('id')}, ${prefix('recipient_member_id')}`, 'work_events', `project_id = ? AND task_id = ? AND delivery_state = ?${await eligibleWorkEventSql(ctx)}`, [current.projectId, before.taskId, state]);
    for (const r of rows) events.set(id(r.id), { id: id(r.id), recipientMemberId: id(r.recipient_member_id) });
  }
  uniqueIds([...events.keys()]);
  repos.mutations.current()!.assertCovers([current.projectId], uniqueIds([current.id, ...[...events.values()].map(e => e.recipientMemberId),
    ...plans.flatMap(p => [p.after.assigneeMemberId, p.after.reviewerMemberId]).filter((v): v is string => v !== null)], 2048));
  const rounds = expected.invalidatedRounds.filter(r => ['ready','running','reported'].includes(r.state));
  const settingsChanged = expected.settings !== null && (restoring ? target.settings?.defaultReviewerMemberId !== expected.settings.defaultReviewerMemberId : expected.settings.defaultReviewerMemberId === current.id);
  const restoredSettings = restoring ? target.settings?.defaultReviewerMemberId ?? null : expected.settings?.defaultReviewerMemberId === current.id ? null : expected.settings?.defaultReviewerMemberId ?? null;
  if (restoring && restoredSettings !== null) {
    const member = restoredSettings === current.id ? desiredMember : await readLifecycleMember(ctx, restoredSettings);
    if (!member || member.kind !== 'agent' || member.projectId !== current.projectId || member.removedAt !== null) conflict("默认评审人的原身份已经失效。");
  }
  const projections = { ...expected, member: desiredMember, tasks: plans.map(p => p.after), presence: restoring ? 'present' : 'removed',
    participants: desiredParticipants, transient: { workEventIds: [], mcpSessionIds: [], runtimeBindingIds: [] } };
  assertCompleteAuditFields(expected, projections, { compensationAuditId, restartRequired: ['mcp-session','review','runtime-binding','memory-summary'] });
  const workEvents = await hasWorkEventInvalidations(ctx) ? await prepareWorkEventInvalidations(repos.tasks, {
    before: captured.snapshot, eventIds: [...events.keys()], auditId: compensationAuditId, restored: restoring, at,
  }) : null;
  const cancellations = await prepareLifecycleDecisionCancellations(repositoryDriver(repos), current.projectId,
    plans.map(p => p.before.taskId), at, restoring ? 'member_restored' : 'member_removed');
  const cleanup = captured.cleanup;
  const estimatedChanged = 2 + plans.length * 5 + rounds.length + cleanup.requests.length * 2 + cleanup.sessions.length + cleanup.bindings.length * 2 + events.size + expected.participants.length + desiredParticipants.length + 3;
  tracker.plan({ rows: 15 + expected.participants.length + plans.length * 6 + rounds.length + cleanup.bindings.length + cleanup.sessions.length + plans.length * 2,
    bytes: Buffer.byteLength(JSON.stringify(projections)) * 3 + 32768,
    sql: 35 + plans.length * 15 + rounds.length * 2 + cleanup.requests.length * 3 + cleanup.sessions.length + cleanup.bindings.length * 2 + events.size + expected.participants.length + desiredParticipants.length + (workEvents ? 6 + Math.ceil(events.size / 32) : 0) + cancellations.count * 10,
    changedRows: estimatedChanged + cancellations.count * 5 });
  const restart = new Set<RestartRequired>(['mcp-session']);
  if (rounds.length || expected.invalidatedRounds.length || target.invalidatedRounds.length) restart.add('review');
  if (cleanup.bindings.length || target.transient.runtimeBindingIds.length) restart.add('runtime-binding');
  if (cleanup.requests.length || target.retained.length && expected.retained.find(f => f.kind === 'memory-requests')?.revision !== target.retained.find(f => f.kind === 'memory-requests')?.revision) restart.add('memory-summary');
  // 全部验证和预算预检已结束；此后任何失败都必须等实际事务回滚，不能提前响应。
  await cancellations.apply();
  await repos.members.applyLifecycleCas(current.projectId, current.id, current.membershipRevision, desiredMember, at);
  for (const p of expected.participants) if (!desiredParticipants.some(d => d.groupId === p.groupId && d.joinedAt === p.joinedAt)) await exactExec(ctx, 'DELETE FROM group_participants WHERE member_id = ? AND group_id = ? AND joined_at = ?', [current.id, p.groupId, p.joinedAt]);
  for (const p of desiredParticipants) if (!expected.participants.some(d => d.groupId === p.groupId && d.joinedAt === p.joinedAt)) await exactExec(ctx, 'INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)', [p.groupId, current.id, p.joinedAt]);
  for (const r of rounds) await repos.tasks.supersedeRoundLifecycleCas(current.projectId, r.roundId, r.revision, at);
  for (const { before, after } of plans) {
    await repos.tasks.updateLifecycleProjectionCas(current.projectId, before.taskId, before.revision, after, at);
    await repos.tasks.appendHistory({ id: newId(), projectId: current.projectId, taskId: before.taskId, taskRevision: before.revision + 1, action: restoring ? 'member_restored' : 'member_removed',
      actor: { kind: 'human', actorId: 'human:local', displayName: '人' }, detail: { memberId: current.id, auditId: compensationAuditId, restartReview: targetTasks.get(before.taskId)?.state === 'review' }, createdAt: at });
  }
  if (settingsChanged) await repos.tasks.setSettingsLifecycleCas(current.projectId, expected.settings!.revision, restoredSettings);
  for (const request of cleanup.requests) await repos.memory.cancelForMemberLifecycleCas(current.projectId, current.id, request.id, request.revision, at);
  for (const session of cleanup.sessions) await exactExec(ctx, "UPDATE mcp_sessions SET state = 'disconnected', disconnected_at = ?, updated_at = ? WHERE project_id = ? AND member_id = ? AND id = ? AND state = 'connected'", [at, at, current.projectId, current.id, session.id]);
  if (cleanup.hasStatus) await exactExec(ctx, 'DELETE FROM member_statuses WHERE project_id = ? AND member_id = ?', [current.projectId, current.id]);
  if (cleanup.reservation) await exactExec(ctx, 'DELETE FROM agent_runtime_members WHERE project_id = ? AND member_id = ?', [current.projectId, current.id]);
  for (const b of cleanup.bindings) {
    await exactExec(ctx, 'DELETE FROM agent_runner_states WHERE binding_id = ?', [b.id]);
    await exactExec(ctx, 'DELETE FROM agent_runtime_bindings WHERE project_id = ? AND member_id = ? AND id = ? AND revision = ?', [current.projectId, current.id, b.id, b.revision]);
  }
  if (workEvents) await workEvents.apply();
  else for (const event of events.values()) await exactExec(ctx, 'DELETE FROM work_events WHERE project_id = ? AND id = ?', [current.projectId, event.id]);
  for (const { after } of plans) {
    if (after.state === 'done') continue;
    for (const recipientId of uniqueIds([after.assigneeMemberId, after.reviewerMemberId].filter((v): v is string => v !== null))) {
      const recipient = await ctx.one<{ status: string; removed_at: string | null }>('SELECT status, removed_at FROM members WHERE project_id = ? AND id = ?', [current.projectId, recipientId]);
      if (recipient?.status !== 'active' || recipient.removed_at !== null) continue;
      await repos.tasks.enqueueWorkEvent({ id: newId(), projectId: current.projectId, recipientMemberId: recipientId, taskId: after.taskId, contextGroupId: null,
        kind: after.state === 'blocked' ? 'task.blocked' : 'task.assigned', eventKey: `${compensationAuditId}:${after.taskId}:${after.revision}:${recipientId}`,
        payload: { taskId: after.taskId, taskRevision: after.revision, memberId: current.id, reason: after.blockedReason }, deliveryState: 'pending', attempts: 0,
        createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
    }
  }
  const actualAfter = (await captureMember(repos, { projectId: current.projectId, memberId: current.id, ...watch, budget: input.budget, tracker })).snapshot;
  assertCompleteAuditFields(actualAfter); tracker.check();
  return { actualBefore: captured.snapshot, actualAfter, restartRequired: [...restart].sort(),
    ...(workEvents ? { workEventInvalidations: workEvents.auditDetail } : {}),
    assertWorkEventAudit: () => workEvents?.assertAudit() ?? Promise.resolve() };
}

/** 快照 shape 校验不读取历史正文，拒绝跨项目/重复关系/无代际等不完整输入。 */
export function validateMemberSnapshot(value: unknown, projectId: string, memberId: string): MemberRelationsSnapshotV2 {
  const bad = (): never => { throw new RepositoryError('invalid_argument', '成员关系快照缺失、重复或范围不一致。'); };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad();
  const s = value as MemberRelationsSnapshotV2;
  if (s.schema !== 'member-relations/v2' || s.projectId !== projectId || s.targetId !== memberId || !['present','removed','absent'].includes(s.presence)) return bad();
  if (!Array.isArray(s.participants) || !Array.isArray(s.tasks) || !Array.isArray(s.invalidatedRounds) || !Array.isArray(s.retained) || !s.transient || typeof s.transient !== 'object' || Array.isArray(s.transient)) return bad();
  if (s.settings !== null && (typeof s.settings !== 'object' || s.settings === undefined || Array.isArray(s.settings))) return bad();
  if ([...s.participants, ...s.tasks, ...s.invalidatedRounds, ...s.retained].some(v => typeof v !== 'object' || v === null || Array.isArray(v))) return bad();
  const ids = (values: unknown[], max = 512) => { if (values.length > max || values.some(v => typeof v !== 'string' || !v) || values.length !== new Set(values).size || !isDeepStrictEqual(values, [...values].sort())) bad(); values.forEach(v => boundedText(v)); };
  ids(s.participants.map(p => p?.groupId), 128); ids(s.tasks.map(t => t?.taskId)); ids(s.invalidatedRounds.map(r => r?.roundId));
  for (const key of ['workEventIds','mcpSessionIds','runtimeBindingIds'] as const) { if (!Array.isArray(s.transient[key])) bad(); ids(s.transient[key]); }
  if (s.presence === 'absent') {
    if (s.member !== null || s.participants.length || s.tasks.length || s.settings !== null || s.invalidatedRounds.length || s.retained.length || Object.values(s.transient).some(x => x.length)) bad();
  } else {
    const m = s.member;
    if (!m) return bad();
    if (m.id !== memberId || m.projectId !== projectId || !Number.isSafeInteger(m.membershipRevision) || m.membershipRevision < 1 ||
      !['human','agent'].includes(m.kind) || !['active','disabled','pending'].includes(m.status) || !['manager','normal'].includes(m.role) || typeof m.displayName !== 'string' || !m.displayName.trim() ||
      typeof m.createdAt !== 'string' || typeof m.updatedAt !== 'string' || !(m.agentId === null || typeof m.agentId === 'string') || !(m.nodeId === null || typeof m.nodeId === 'string')) bad();
    boundedText(m.displayName, 8192);
    [m.id, m.projectId, m.createdAt, m.updatedAt].forEach(v => id(v));
    [m.agentId, m.nodeId, m.removedAt].forEach(v => nullable(v));
    if (m.kind === 'agent' ? !m.agentId : m.agentId !== null) bad();
    if ((s.presence === 'present') !== (m.removedAt === null) || s.presence === 'removed' && (typeof m.removedAt !== 'string' || m.status !== 'disabled' || m.nodeId !== null || m.role !== 'normal')) bad();
    if (s.retained.length !== 6 || !isDeepStrictEqual(s.retained.map(f => f.kind), [...MEMBER_FACT_KINDS].sort()) || s.retained.some(f => !Number.isSafeInteger(f.revision) || f.revision < 1)) bad();
  }
  for (const p of s.participants) { if (typeof p.joinedAt !== 'string' || !p.joinedAt) bad(); id(p.joinedAt); }
  for (const t of s.tasks) {
    if (!Number.isSafeInteger(t.revision) || t.revision < 1 || !['todo','in-progress','review','blocked','done'].includes(t.state) ||
      [t.assigneeMemberId,t.reviewerMemberId,t.currentReviewRoundId,t.blockedReason].some(v => v !== null && typeof v !== 'string')) bad();
    [t.assigneeMemberId, t.reviewerMemberId, t.currentReviewRoundId].forEach(v => nullable(v));
    if (t.blockedReason !== '') boundedText(t.blockedReason, 8192, true);
  }
  for (const r of s.invalidatedRounds) if (!Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.taskId !== 'string' || !s.tasks.some(t => t.taskId === r.taskId) || !['ready','running','reported','decided','failed','superseded'].includes(r.state)) bad();
  for (const t of s.tasks) if (t.currentReviewRoundId !== null && !s.invalidatedRounds.some(r => r.roundId === t.currentReviewRoundId && r.taskId === t.taskId)) bad();
  if (s.settings !== null && (s.settings.projectId !== projectId || !Number.isSafeInteger(s.settings.revision) || s.settings.revision < 1 || s.settings.defaultReviewerMemberId !== null && typeof s.settings.defaultReviewerMemberId !== 'string')) bad();
  if (s.settings !== null) nullable(s.settings.defaultReviewerMemberId);
  assertCompleteAuditFields(s); return s;
}

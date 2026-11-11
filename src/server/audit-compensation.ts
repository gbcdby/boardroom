import { isDeepStrictEqual } from "node:util";
import { appendAuditEntry, assertCompleteAuditFields, auditActorFrom, isReversible, type AuditRow } from "./audit.ts";
import type { RepoCtx, RepositorySet } from "./db/repositories.ts";
import type { Member, OrgNode } from "./db/types.ts";
import { RepositoryError } from "./db/errors.ts";
import { newId } from "./db/ids.ts";
import { MEMBER_CAPTURE_BUDGET, type MemberRelationsSnapshotV2, type OrgGraphSnapshotV2, type OrgMutationAccess, type ReversalMetadataV2, type RestartRequired } from "./org/compensation-types.ts";
import { conflict, withOrgMutation } from "./org/boundary.ts";
import { applyOrgGraph } from "./org/graph.ts";
import { captureAssignment, statusSnapshot, type AssignmentSnapshotV2, type StatusSnapshotV2 } from "./org/mutations.ts";
import { boundedText, CaptureBudget } from "./org/capture-budget.ts";
import { applyMemberCompensation, discoverMemberRelations, validateMemberSnapshot, watchFromSnapshots } from "./org/member-relations.ts";

type ObjectValue = Record<string, unknown>;
type Snapshot = OrgGraphSnapshotV2 | AssignmentSnapshotV2 | StatusSnapshotV2 | MemberRelationsSnapshotV2;
type ChainAudit = Pick<AuditRow, 'id' | 'projectId' | 'action' | 'targetKind' | 'targetId' | 'detail' | 'reversedAt' | 'reversedByAuditId'>;
type SnapshotAudit = ChainAudit & Pick<AuditRow, 'before' | 'after' | 'targetName'>;
function invalid(message = "审计快照字段不完整或与事件范围不一致。"): never { throw new RepositoryError("invalid_argument", message); }
function broken(): never { throw new RepositoryError("chain_broken", "审计补偿链缺失、循环或前驱不一致，不能推测恢复。"); }
function object(value: unknown): value is ObjectValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function ref(value: unknown): value is string | null { return value === null || text(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function sortedUnique(values: unknown[]): values is string[] {
  return values.every(text) && values.length === new Set(values).size && isDeepStrictEqual(values, [...values].sort());
}
function decode(value: string | null): unknown {
  if (value === null) return null;
  if (Buffer.byteLength(value, "utf8") > 32768) throw new RepositoryError("audit_snapshot_too_large", "历史审计字段超出完整快照上限。");
  try { return JSON.parse(value) as unknown; } catch { return invalid("审计 JSON 损坏，不能补偿。"); }
}
/** 单字段最多 32KiB；分块同时约束数据库返回与 JSON 再转义后的单行字节。 */
async function readAuditField(ctx: RepoCtx, projectId: string, id: string, field: 'before' | 'after' | 'detail' | 'target_name'): Promise<string | null> {
  let result = '', bytes = 0;
  for (let offset = 1; offset <= 32769; offset += 8192) {
    const row = await ctx.one<{ value: string | null }>(`SELECT substr(${field}, ?, 8192) AS value FROM audit_log WHERE project_id = ? AND id = ?`, [offset, projectId, id]);
    if (!row) broken();
    if (row.value === null) return null;
    bytes += Buffer.byteLength(row.value, 'utf8');
    if (bytes > 32768) throw new RepositoryError('audit_snapshot_too_large', '历史审计字段超出完整快照上限。');
    result += row.value;
    // SQL substr 按 Unicode 字符，而不是 JavaScript UTF-16 code units 推进。
    if ([...row.value].length < 8192) return result;
  }
  throw new RepositoryError('audit_snapshot_too_large', '历史审计字段超出完整快照上限。');
}
async function readChainAudit(ctx: RepoCtx, projectId: string, id: string): Promise<ChainAudit | null> {
  const row = await ctx.one<{ id: string; project_id: string; action: string; target_kind: AuditRow['targetKind']; target_id: string; reversed_at: string | null; reversed_by_audit_id: string | null }>(
    `SELECT substr(id, 1, 1025) AS id, substr(project_id, 1, 1025) AS project_id, substr(action, 1, 129) AS action,
       target_kind, substr(target_id, 1, 1025) AS target_id, substr(reversed_at, 1, 129) AS reversed_at,
       substr(reversed_by_audit_id, 1, 1025) AS reversed_by_audit_id FROM audit_log WHERE project_id = ? AND id = ?`, [projectId, id]);
  if (!row) return null;
  return { id: boundedText(row.id)!, projectId: boundedText(row.project_id)!, action: boundedText(row.action, 128)!,
    targetKind: row.target_kind, targetId: boundedText(row.target_id)!, reversedAt: boundedText(row.reversed_at, 128, true),
    reversedByAuditId: boundedText(row.reversed_by_audit_id, 1024, true), detail: await readAuditField(ctx, projectId, id, 'detail') };
}
function validNode(value: unknown, row: ChainAudit): value is OrgNode {
  if (!object(value)) return false;
  return value.id === row.targetId && value.projectId === row.projectId && ref(value.parentId) && value.parentId !== value.id &&
    text(value.name) && ["top_manager", "sub_manager", "member"].includes(String(value.role)) &&
    (value.parentId === null ? value.role === "top_manager" : value.role !== "top_manager") &&
    typeof value.sortOrder === "number" && Number.isFinite(value.sortOrder) && text(value.createdAt) && text(value.updatedAt);
}
function validMember(value: unknown, row: ChainAudit, assignment = false): value is Member {
  if (!object(value)) return false;
  return text(value.id) && (assignment && row.action === "org.auto_place" || value.id === row.targetId) && value.projectId === row.projectId &&
    ref(value.nodeId) && ["manager", "normal"].includes(String(value.role)) && ["active", "disabled", "pending"].includes(String(value.status)) &&
    ["human", "agent"].includes(String(value.kind)) && ref(value.agentId) && text(value.displayName) && text(value.createdAt) && text(value.updatedAt);
}
function validateV2(value: unknown, row: ChainAudit, rootAction: string): Snapshot {
  if (!object(value) || value.projectId !== row.projectId || value.targetId !== row.targetId) invalid();
  if (value.schema === 'member-relations/v2') {
    if (!['member.add', 'member.remove'].includes(rootAction) || row.targetKind !== 'member') invalid();
    return validateMemberSnapshot(value, row.projectId, row.targetId);
  }
  if (value.schema === "org-graph/v2") {
    if (!["org.node_create", "org.node_update", "org.node_delete"].includes(rootAction) || row.targetKind !== "node") invalid();
    if (value.node !== null && !validNode(value.node, row)) invalid();
    if (!Array.isArray(value.childEdges) || !Array.isArray(value.assignments) || !Array.isArray(value.directChildIds) || !sortedUnique(value.directChildIds)) invalid();
    if (value.childEdges.length > 512 || value.assignments.length > 512 || value.directChildIds.length > 512) invalid();
    const childIds: string[] = [], memberIds: string[] = [];
    for (const c of value.childEdges) {
      if (!object(c) || !text(c.nodeId) || c.nodeId === row.targetId || !ref(c.parentId) || c.parentId === c.nodeId) invalid();
      childIds.push(c.nodeId);
    }
    for (const a of value.assignments) {
      if (!object(a) || !text(a.memberId) || !ref(a.nodeId) || !["manager", "normal"].includes(String(a.legacyRole))) invalid();
      if (a.membershipRevision === undefined) throw new RepositoryError("legacy_incomplete_snapshot", "旧岗位图未记录占岗成员代际，不能将历史岗位授予重新加入的实例。");
      if (!revision(a.membershipRevision)) invalid();
      memberIds.push(a.memberId);
    }
    if (!sortedUnique(childIds) || !sortedUnique(memberIds) || !isDeepStrictEqual(value.directChildIds, value.childEdges.filter(c => c.parentId === row.targetId).map(c => c.nodeId))) invalid();
    if (value.node === null && value.directChildIds.length !== 0) invalid();
    return value as unknown as OrgGraphSnapshotV2;
  }
  if (value.schema === "org-assignment/v2") {
    if (!["org.assign", "org.auto_place"].includes(rootAction) || !Array.isArray(value.assignments) || value.assignments.length === 0 || value.assignments.length > 512) invalid();
    if (row.targetKind !== (rootAction === "org.assign" ? "member" : "node")) invalid();
    const ids: string[] = [];
    for (const a of value.assignments) {
      if (!object(a) || !text(a.memberId) || !ref(a.nodeId) || !["manager", "normal"].includes(String(a.legacyRole)) || !revision(a.membershipRevision)) invalid();
      ids.push(a.memberId);
    }
    if (!sortedUnique(ids) || rootAction === "org.assign" && !ids.includes(row.targetId)) invalid();
    return value as unknown as AssignmentSnapshotV2;
  }
  if (value.schema === "member-status/v2") {
    if (!["member.pause", "member.resume", "member.status_change"].includes(rootAction) || row.targetKind !== "member" ||
      !["active", "disabled", "pending"].includes(String(value.status)) || !revision(value.membershipRevision)) invalid();
    return value as unknown as StatusSnapshotV2;
  }
  invalid();
}
function snapshotPair(row: SnapshotAudit, rootAction: string): { before: Snapshot; after: Snapshot } {
  const before = decode(row.before), after = decode(row.after);
  if (object(before) && typeof before.schema === "string") {
    const pair = { before: validateV2(before, row, rootAction), after: validateV2(after, row, rootAction) };
    if (pair.before.schema !== pair.after.schema) invalid();
    if (pair.before.schema === "org-graph/v2" && pair.after.schema === "org-graph/v2") {
      if (!isDeepStrictEqual(pair.before.childEdges.map(c => c.nodeId), pair.after.childEdges.map(c => c.nodeId)) ||
        !isDeepStrictEqual(pair.before.assignments.map(m => [m.memberId, m.membershipRevision]), pair.after.assignments.map(m => [m.memberId, m.membershipRevision]))) invalid();
    }
    return pair;
  }
  if (["org.node_delete", "member.add", "member.remove"].includes(rootAction)) {
    throw new RepositoryError("legacy_incomplete_snapshot", "旧事件缺少完整关系与代际快照，不能可靠撤销；历史仍可查看。");
  }
  if (rootAction === "org.node_update" || rootAction === "org.node_create") {
    if (row.targetKind !== "node" || before !== null && !validNode(before, row) || after !== null && !validNode(after, row) || before === null && after === null) invalid();
    if (rootAction === "org.node_update" && (before === null || after === null)) invalid();
    const graph = (node: unknown): OrgGraphSnapshotV2 => ({ schema: "org-graph/v2", projectId: row.projectId, targetId: row.targetId, node: node as OrgNode | null, childEdges: [], assignments: [], directChildIds: [] });
    return { before: graph(before), after: graph(after) };
  }
  // 兼容旧单纯状态/占岗；绝不把旧 member 单行当完整成员关系恢复。
  const normalizedRow = { ...row, action: rootAction };
  if (!validMember(before, normalizedRow, true) || !validMember(after, normalizedRow, true) || before.id !== after.id || before.agentId !== after.agentId || before.kind !== after.kind) invalid();
  if (["org.assign", "org.auto_place"].includes(rootAction)) {
    const assignment = (m: Member): AssignmentSnapshotV2 => ({ schema: "org-assignment/v2", projectId: row.projectId, targetId: row.targetId,
      assignments: [{ memberId: m.id, nodeId: m.nodeId, legacyRole: m.role, membershipRevision: m.membershipRevision ?? 1 }] });
    return { before: assignment(before), after: assignment(after) };
  }
  if (["member.pause", "member.resume", "member.status_change"].includes(rootAction)) return {
    before: { ...statusSnapshot(before), membershipRevision: before.membershipRevision ?? 1 },
    after: { ...statusSnapshot(after), membershipRevision: after.membershipRevision ?? 1 },
  };
  return invalid();
}
function sameTarget(a: ChainAudit, b: ChainAudit): boolean { return a.projectId === b.projectId && a.targetKind === b.targetKind && a.targetId === b.targetId; }
function metadata(row: ChainAudit): ReversalMetadataV2 | null {
  const detail = decode(row.detail);
  if (!object(detail) || detail.reversal === undefined) return null;
  const r = detail.reversal;
  if (!object(r) || r.version !== 2 || !text(r.rootAuditId) || !text(r.rootAction) || !ref(r.undoesAuditId) || !["forward", "undo", "redo"].includes(String(r.direction))) broken();
  return r as unknown as ReversalMetadataV2;
}
async function chain(repos: RepositorySet, row: ChainAudit): Promise<ReversalMetadataV2> {
  const initial = metadata(row); const seen = new Set<string>(); let current = row; let count = 0;
  while (true) {
    if (++count > 1000 || seen.has(current.id) || !sameTarget(row, current)) broken();
    seen.add(current.id);
    const m = metadata(current);
    if (m && initial && (m.rootAuditId !== initial.rootAuditId || m.rootAction !== initial.rootAction)) broken();
    if (current.action !== "org.revoke" && current.action !== "member.revoke") {
      if (!isReversible(current.action) || m && (m.rootAuditId !== current.id || m.rootAction !== current.action || m.undoesAuditId !== null || m.direction !== "forward")) broken();
      if (initial && (initial.rootAuditId !== current.id || initial.rootAction !== current.action)) broken();
      return initial ?? { version: 2, rootAuditId: current.id, rootAction: current.action, undoesAuditId: row.id === current.id ? null : "legacy", direction: count === 1 ? "forward" : count % 2 === 0 ? "undo" : "redo" };
    }
    let previousId: string | null = m?.undoesAuditId ?? null;
    if (m && (m.direction === "forward" || !previousId)) broken();
    if (!m) {
      const d = decode(current.detail);
      if (object(d) && text(d.undoes)) previousId = d.undoes;
      else previousId = current.reversedByAuditId;
    }
    if (!previousId) broken();
    const previous = await readChainAudit(repos.context, row.projectId, previousId);
    if (!previous || !sameTarget(row, previous) || previous.reversedAt === null || previous.reversedByAuditId !== current.id) broken();
    const pm = metadata(previous);
    if (m && pm && m.direction !== (pm.direction === "undo" ? "redo" : "undo")) broken();
    current = previous;
  }
}
async function applyAssignment(repos: RepositorySet, expected: AssignmentSnapshotV2, target: AssignmentSnapshotV2, at: string) {
  const ids = expected.assignments.map(a => a.memberId);
  if (!isDeepStrictEqual(ids, target.assignments.map(a => a.memberId))) invalid();
  const actualBefore = await captureAssignment(repos, expected.projectId, expected.targetId, ids);
  if (!isDeepStrictEqual(actualBefore, expected)) conflict("成员占岗、legacy 角色或加入代际已变化。");
  for (const a of target.assignments) {
    if (a.membershipRevision !== expected.assignments.find(e => e.memberId === a.memberId)!.membershipRevision) invalid();
    if (a.nodeId !== null) {
      const n = await repos.org.getNode(a.nodeId);
      if (!n || n.projectId !== target.projectId || (n.parentId === null) !== (a.legacyRole === "manager")) conflict("待恢复的岗位已不存在或角色不一致。");
      const occupying = await repos.context.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND node_id = ?", [target.projectId, a.nodeId]);
      if (occupying && !ids.includes(occupying.id)) conflict("待恢复岗位已被其他成员占据。");
    }
    if (a.legacyRole === "manager") {
      const manager = await repos.members.getManager(target.projectId);
      if (manager && !ids.includes(manager.id)) conflict("项目已经有新的负责人。");
    }
  }
  CaptureBudget.current()!.plan({ rows: ids.length * 2 + 5, bytes: Buffer.byteLength(JSON.stringify(target)) * 3 + 8192, sql: ids.length * 4 + 10, changedRows: ids.length * 2 + 2 });
  for (const id of ids) await repos.context.exec("UPDATE members SET node_id = NULL, role = 'normal', updated_at = ? WHERE project_id = ? AND id = ?", [at, target.projectId, id]);
  for (const a of target.assignments) await repos.context.exec("UPDATE members SET node_id = ?, role = ?, updated_at = ? WHERE project_id = ? AND id = ?", [a.nodeId, a.legacyRole, at, target.projectId, a.memberId]);
  const actualAfter = await captureAssignment(repos, target.projectId, target.targetId, ids);
  if (!isDeepStrictEqual(actualAfter, target)) conflict();
  return { actualBefore, actualAfter };
}

export function createAuditCompensationService({ repos, now = () => new Date() }: { repos: RepositorySet; now?: () => Date }) {
  return { async revoke(access: OrgMutationAccess, projectId: string, auditId: string): Promise<AuditRow> {
    // 沿用人的撤销权；不可通过换一个 agent role 获得。
    if (access.actor.kind !== "human" || access.actor.role !== "owner" || access.actor.projectId !== null && access.actor.projectId !== projectId) {
      throw new RepositoryError("invalid_argument", "只有本项目的人（owner）可以撤销审计操作。");
    }
    let plannedMembers: string[] = [];
    let plannedRow: SnapshotAudit | undefined;
    const tracker = CaptureBudget.current() ?? new CaptureBudget(MEMBER_CAPTURE_BUDGET, access.signal);
    return tracker.run(() => withOrgMutation(repos, access, projectId, async tx => {
      const header = await readChainAudit(tx, projectId, auditId);
      if (!header) throw new RepositoryError("not_found", "审计事件不存在。");
      const before = await readAuditField(tx, projectId, auditId, 'before'), after = await readAuditField(tx, projectId, auditId, 'after');
      const targetName = await readAuditField(tx, projectId, auditId, 'target_name');
      if (targetName === null) invalid();
      plannedRow = { ...header, before, after, targetName };
      const values = [decode(before), decode(after)]; const members: string[] = [];
      if (values.every(v => object(v) && v.schema === 'member-relations/v2')) {
        const snapshots = values.map(v => validateMemberSnapshot(v, projectId, (v as ObjectValue).targetId as string));
        if (snapshots[0]!.targetId !== snapshots[1]!.targetId) invalid();
        const extraMembers = snapshots.flatMap(s => [...s.tasks.flatMap(t => [t.assigneeMemberId, t.reviewerMemberId]), s.settings?.defaultReviewerMemberId ?? null]).filter((v): v is string => v !== null);
        const plan = await discoverMemberRelations(projectId, snapshots[0]!.targetId, watchFromSnapshots(...snapshots), tracker, extraMembers, snapshots.flatMap(s => s.participants.map(p => p.groupId)))(tx);
        plannedMembers = [...plan.memberIds]; return plan;
      }
      for (const value of values) {
        if (!object(value)) continue;
        if (Array.isArray(value.assignments)) for (const a of value.assignments) if (object(a) && text(a.memberId)) members.push(a.memberId);
        if (value.schema === "member-status/v2" && text(value.targetId)) members.push(value.targetId);
        if (value.schema === undefined && text(value.id) && value.status !== undefined) members.push(value.id);
      }
      plannedMembers = [...new Set(members)].sort();
      return { memberIds: plannedMembers, groupIds: [], runtimeIds: [] };
    }, async () => {
      // discover 已持共同项目锁；快照与链元数据不在锁外缓存，也无需整行二次加载。
      const row = plannedRow;
      if (!row) broken();
      if (!isReversible(row.action)) throw new RepositoryError("invalid_argument", "该审计动作不提供撤销。");
      if (row.reversedAt !== null) conflict("该事件已经被撤销，请刷新审计列表查看后继事件。");
      const meta = await chain(repos, row), pair = snapshotPair(row, meta.rootAction);
      repos.mutations.current()!.assertCovers([projectId], plannedMembers);
      const id = newId(), at = now().toISOString();
      const reversal: ReversalMetadataV2 = { version: 2, rootAuditId: meta.rootAuditId, rootAction: meta.rootAction, undoesAuditId: row.id,
        direction: meta.direction === "undo" ? "redo" : "undo" };
      assertCompleteAuditFields(pair.before, pair.after, { reversal });
      let actual: { actualBefore: Snapshot; actualAfter: Snapshot };
      let restartRequired: RestartRequired[] = [];
      if (pair.after.schema === 'member-relations/v2' && pair.before.schema === 'member-relations/v2') {
        const result = await applyMemberCompensation(repos, { expected: pair.after, target: pair.before, compensationAuditId: id, at, budget: MEMBER_CAPTURE_BUDGET, tracker });
        actual = result; restartRequired = result.restartRequired;
      } else if (pair.after.schema === "org-graph/v2" && pair.before.schema === "org-graph/v2") {
        actual = await applyOrgGraph(repos, pair.after, pair.before, at, meta.rootAction !== "org.node_update");
      } else if (pair.after.schema === "org-assignment/v2" && pair.before.schema === "org-assignment/v2") {
        actual = await applyAssignment(repos, pair.after, pair.before, at);
      } else if (pair.after.schema === "member-status/v2" && pair.before.schema === "member-status/v2") {
        const member = await repos.members.get(row.targetId);
        if (!member || member.projectId !== projectId || !isDeepStrictEqual(statusSnapshot(member), pair.after)) conflict("成员状态或加入代际已变化。");
        if (pair.before.membershipRevision !== member.membershipRevision) invalid();
        tracker.plan({ rows: 10, bytes: 16384, sql: 10, changedRows: 3 });
        await repos.context.exec("UPDATE members SET status = ?, updated_at = ? WHERE project_id = ? AND id = ? AND membership_revision = ? AND removed_at IS NULL", [pair.before.status, at, projectId, member.id, member.membershipRevision]);
        actual = { actualBefore: statusSnapshot(member), actualAfter: statusSnapshot((await repos.members.get(member.id))!) };
      } else return invalid();
      const next = await appendAuditEntry(repos.audit, { projectId, actor: auditActorFrom(access.actor), action: meta.rootAction.startsWith("org.") ? "org.revoke" : "member.revoke",
        targetKind: row.targetKind, targetId: row.targetId, targetName: row.targetName, before: actual.actualBefore, after: actual.actualAfter,
        detail: { reversal, ...(restartRequired.length ? { restartRequired, normalization: 'new-membership-revision; no-old-session-round-runtime-or-summary' } : {}) } }, { id, createdAt: at });
      if (!await repos.audit.markReversed(projectId, row.id, next.id, at)) conflict("该事件刚被另一个请求撤销。");
      tracker.check(); return next;
    }));
  } };
}

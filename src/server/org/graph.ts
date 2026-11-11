import { isDeepStrictEqual } from "node:util";
import type { RepositorySet } from "../db/repositories.ts";
import type { OrgNode } from "../db/types.ts";
import { MEMBER_CAPTURE_BUDGET, type OrgGraphSnapshotV2 } from "./compensation-types.ts";
import { conflict } from "./boundary.ts";
import { RepositoryError } from "../db/errors.ts";
import { assertCompleteAuditFields } from "../audit.ts";
import { boundedText, captureExceeded, CaptureBudget, safeRevision } from "./capture-budget.ts";

type Edge = { node_id: string; parent_id: string | null };
function pageSize(remaining = 32): number { return Math.min(remaining, CaptureBudget.current()?.pageSize() ?? 32); }
function edgeProjection(row: Edge): OrgGraphSnapshotV2['childEdges'][number] {
  return { nodeId: boundedText(row.node_id)!, parentId: boundedText(row.parent_id, 1024, true) };
}
/** 仅目标岗位需要名字；分列/分块读取，不能让损坏大字段先穿透单行返回预算。 */
async function readSnapshotNode(repos: RepositorySet, nodeId: string): Promise<OrgNode | null> {
  const row = await repos.context.one<{ id: string; project_id: string; parent_id: string | null; role: OrgNode['role'];
    sort_order: number; created_at: string; updated_at: string; name_terminated: number | string }>(
    `SELECT substr(id, 1, 1025) AS id, substr(project_id, 1, 1025) AS project_id, substr(parent_id, 1, 1025) AS parent_id,
       substr(role, 1, 33) AS role, sort_order, substr(created_at, 1, 129) AS created_at, substr(updated_at, 1, 129) AS updated_at,
       length(name || '.') - length(name) AS name_terminated FROM org_nodes WHERE id = ?`, [nodeId]);
  if (!row) return null;
  const node = { id: boundedText(row.id)!, projectId: boundedText(row.project_id)!, parentId: boundedText(row.parent_id, 1024, true),
    role: boundedText(row.role, 32)! as OrgNode['role'], sortOrder: Number(row.sort_order),
    createdAt: boundedText(row.created_at, 128)!, updatedAt: boundedText(row.updated_at, 128)! };
  // SQLite TEXT substr/length 遇 NUL 会停止；先拒绝，不能把截断前缀当完整当前值。
  if (Number(row.name_terminated) !== 1 || !Number.isFinite(node.sortOrder)) conflict('当前岗位字段无法完整校验。');
  let name = '', bytes = 0;
  for (let offset = 1; offset <= 32769; offset += 8192) {
    const chunk = await repos.context.one<{ value: string }>('SELECT substr(name, ?, 8192) AS value FROM org_nodes WHERE id = ?', [offset, nodeId]);
    if (!chunk || typeof chunk.value !== 'string') conflict('当前岗位名称无法完整读取。');
    bytes += Buffer.byteLength(chunk.value, 'utf8');
    if (bytes > 32768) throw new RepositoryError('audit_snapshot_too_large', '当前岗位名称超出完整审计字段上限。');
    name += chunk.value;
    if ([...chunk.value].length < 8192) return { ...node, name };
  }
  throw new RepositoryError('audit_snapshot_too_large', '当前岗位名称超出完整审计字段上限。');
}
export function nodeProjection(node: OrgNode | null): unknown {
  if (node === null) return null;
  return { id: node.id, projectId: node.projectId, parentId: node.parentId, name: node.name, role: node.role, sortOrder: node.sortOrder, createdAt: node.createdAt };
}
export async function captureOrgGraph(repos: RepositorySet, projectId: string, nodeId: string,
  watch: { childIds?: readonly string[]; memberIds?: readonly string[] } = {}, includeRelations = true): Promise<OrgGraphSnapshotV2> {
  const node = await readSnapshotNode(repos, nodeId);
  if (node && node.projectId !== projectId) conflict("岗位快照跨项目。");
  if (!includeRelations) {
    const result: OrgGraphSnapshotV2 = { schema: "org-graph/v2", projectId, targetId: nodeId, node, childEdges: [], assignments: [], directChildIds: [] };
    assertCompleteAuditFields(result); return result;
  }
  const children: OrgGraphSnapshotV2['childEdges'] = [];
  let cursor: string | null = null;
  for (;;) {
    const limit = pageSize(513 - children.length);
    const rows: Edge[] = await repos.context.query<Edge>(`SELECT substr(id, 1, 1025) AS node_id, substr(parent_id, 1, 1025) AS parent_id
      FROM org_nodes WHERE project_id = ? AND parent_id = ?${cursor === null ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`,
      cursor === null ? [projectId, nodeId, limit] : [projectId, nodeId, cursor, limit]);
    children.push(...rows.map(edgeProjection));
    if (children.length > 512) captureExceeded('岗位直接下级超过单次审计范围');
    if (rows.length < limit) break;
    cursor = children.at(-1)!.nodeId;
  }
  const childIds = [...new Set([...(watch.childIds ?? []), ...children.map(c => c.nodeId)])].sort();
  if (childIds.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "岗位关系超出审计预算。");
  const childEdges = new Map(children.map(edge => [edge.nodeId, edge]));
  const missing = childIds.filter(id => !childEdges.has(id));
  for (let start = 0; start < missing.length;) {
    const ids = missing.slice(start, start + pageSize());
    const rows = await repos.context.query<Edge>(`SELECT substr(id, 1, 1025) AS node_id, substr(parent_id, 1, 1025) AS parent_id
      FROM org_nodes WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, [projectId, ...ids]);
    if (rows.length !== ids.length) conflict("需恢复的下级岗位已删除或不属于同项目。");
    for (const row of rows) { const edge = edgeProjection(row); childEdges.set(edge.nodeId, edge); }
    start += ids.length;
  }
  const occupants = await repos.context.query<{ id: string }>('SELECT substr(id, 1, 1025) AS id FROM members WHERE project_id = ? AND node_id = ? ORDER BY id LIMIT ?', [projectId, nodeId, pageSize(2)]);
  const memberIds = [...new Set([...(watch.memberIds ?? []), ...occupants.map(m => boundedText(m.id)!)])].sort();
  if (memberIds.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "岗位成员超出审计预算。");
  const assignments: OrgGraphSnapshotV2["assignments"] = [];
  for (let start = 0; start < memberIds.length;) {
    const ids = memberIds.slice(start, start + pageSize());
    const rows = await repos.context.query<{ id: string; node_id: string | null; role: string; membership_revision: number }>(
      `SELECT substr(id, 1, 1025) AS id, substr(node_id, 1, 1025) AS node_id, substr(role, 1, 33) AS role, membership_revision
       FROM members WHERE project_id = ? AND removed_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [projectId, ...ids]);
    if (rows.length !== ids.length) conflict('原占岗成员已移除或换代。');
    for (const row of rows) {
      if (row.role !== 'manager' && row.role !== 'normal') conflict('原占岗成员的角色无效。');
      assignments.push({ memberId: boundedText(row.id)!, nodeId: boundedText(row.node_id, 1024, true), legacyRole: row.role,
        membershipRevision: safeRevision(row.membership_revision) });
    }
    start += ids.length;
  }
  const result: OrgGraphSnapshotV2 = { schema: "org-graph/v2", projectId, targetId: nodeId, node,
    childEdges: childIds.map(id => childEdges.get(id)!), assignments, directChildIds: children.map(c => c.nodeId) };
  assertCompleteAuditFields(result); return result;
}
export function equalGraph(actual: OrgGraphSnapshotV2, expected: OrgGraphSnapshotV2): boolean {
  return isDeepStrictEqual({ ...actual, node: nodeProjection(actual.node) }, { ...expected, node: nodeProjection(expected.node) });
}
export async function validateParent(repos: RepositorySet, projectId: string, nodeId: string, parentId: string | null): Promise<void> {
  const seen = new Set([nodeId]);
  let id = parentId;
  while (id !== null) {
    if (seen.has(id) || seen.size > 512) conflict("恢复的组织汇报线形成环或超过有界验证范围。");
    seen.add(id);
    const node: { parent_id: string | null } | undefined = await repos.context.one('SELECT substr(parent_id, 1, 1025) AS parent_id FROM org_nodes WHERE project_id = ? AND id = ?', [projectId, id]);
    if (!node) conflict("恢复岗位的父节点已不存在或属于其他项目。");
    id = boundedText(node.parent_id, 1024, true);
  }
}
type PlannedNode = { id: string; parentId: string | null; role: string };
/** 同时覆盖目标节点和全部子边后验证；当前图中的逐边祖先检查不能证明恢复图无环。 */
async function validateRestoredGraph(repos: RepositorySet, target: OrgGraphSnapshotV2): Promise<Map<string, PlannedNode>> {
  const nodes = new Map<string, PlannedNode>(), budget = CaptureBudget.current();
  let cursor: string | null = null;
  for (;;) {
    const limit = budget?.pageSize() ?? Math.min(32, MEMBER_CAPTURE_BUDGET.maxRows - nodes.size + 1);
    // ID 前缀逐值验证后才推进游标。两段 1025 字符即使全部 JSON 转义，单行也小于 64 KiB。
    const rows: Array<{ id: string; parent_id: string | null; role: string }> = await repos.context.query(
      `SELECT substr(id, 1, 1025) AS id, substr(parent_id, 1, 1025) AS parent_id, substr(role, 1, 33) AS role
         FROM org_nodes WHERE project_id = ?${cursor === null ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`,
      cursor === null ? [target.projectId, limit] : [target.projectId, cursor, limit]);
    for (const row of rows) {
      const id = boundedText(row.id)!;
      nodes.set(id, { id, parentId: boundedText(row.parent_id, 1024, true), role: boundedText(row.role, 32)! });
      if (nodes.size > MEMBER_CAPTURE_BUDGET.maxRows) captureExceeded('完整组织图超过累计行数预算');
      cursor = id;
    }
    if (rows.length < limit) break;
  }
  if (target.node === null) nodes.delete(target.targetId);
  else nodes.set(target.targetId, { id: target.targetId, parentId: target.node.parentId, role: target.node.role });
  for (const edge of target.childEdges) {
    const child = nodes.get(edge.nodeId);
    if (!child) conflict('需恢复的下级岗位已不存在或不属于同项目。');
    nodes.set(edge.nodeId, { ...child, parentId: edge.parentId });
  }
  let roots = 0;
  for (const node of nodes.values()) {
    budget?.check();
    if (!['top_manager', 'sub_manager', 'member'].includes(node.role) ||
      (node.parentId === null) !== (node.role === 'top_manager')) conflict('恢复后的岗位根位置与角色不一致。');
    if (node.parentId === null) roots++;
    else if (!nodes.has(node.parentId)) conflict('恢复后的父岗位已不存在或属于其他项目。');
  }
  if (roots !== (nodes.size === 0 ? 0 : 1)) conflict('恢复后的组织必须只有一个根岗位。');
  const complete = new Set<string>();
  for (const node of nodes.values()) {
    const visiting = new Set<string>();
    let id: string | null = node.id;
    while (id !== null && !complete.has(id)) {
      budget?.check();
      if (visiting.has(id)) conflict('恢复后的完整组织汇报线形成环。');
      visiting.add(id); id = nodes.get(id)!.parentId;
    }
    for (const visited of visiting) complete.add(visited);
  }
  return nodes;
}
export async function applyOrgGraph(repos: RepositorySet, expected: OrgGraphSnapshotV2, target: OrgGraphSnapshotV2, at: string, includeRelations = true) {
  const watch = { childIds: [...new Set([...expected.childEdges, ...target.childEdges].map(c => c.nodeId))],
    memberIds: [...new Set([...expected.assignments, ...target.assignments].map(m => m.memberId))] };
  const actualBefore = await captureOrgGraph(repos, expected.projectId, expected.targetId, watch, includeRelations);
  if (!equalGraph(actualBefore, expected)) conflict("岗位内容、直接下级集合、占岗或成员代际已变化，不能覆盖后续修改。");
  if (expected.node && target.node && expected.node.id !== target.node.id) conflict();
  const restoredGraph = await validateRestoredGraph(repos, target);
  for (const assignment of target.assignments) {
    if (assignment.nodeId !== null) {
      const node = restoredGraph.get(assignment.nodeId);
      if (!node || (node.parentId === null) !== (assignment.legacyRole === 'manager')) conflict("待恢复岗位不存在或角色不一致。");
      const occupant = await repos.context.one<{ id: string }>('SELECT substr(id, 1, 1025) AS id FROM members WHERE project_id = ? AND node_id = ?', [target.projectId, assignment.nodeId]);
      const occupantId = occupant ? boundedText(occupant.id)! : null;
      if (occupantId && occupantId !== assignment.memberId && !target.assignments.some(a => a.memberId === occupantId && a.nodeId !== assignment.nodeId)) conflict("待恢复岗位已被其他成员占据。");
    }
  }
  assertCompleteAuditFields(actualBefore, target);
  CaptureBudget.current()?.plan({ rows: target.childEdges.length * 2 + target.assignments.length * 2 + 10,
    bytes: Buffer.byteLength(JSON.stringify(target)) * 3 + 8192, sql: target.childEdges.length + target.assignments.length * 4 + 20,
    changedRows: 3 + target.childEdges.length + target.assignments.length * 2 });
  // 先清本次已确认的占岗，再恢复节点/边，最后回填占岗；唯一约束始终生效。
  for (const a of target.assignments) await repos.context.exec("UPDATE members SET node_id = NULL, role = 'normal', updated_at = ? WHERE project_id = ? AND id = ?", [at, target.projectId, a.memberId]);
  if (target.node) await repos.org.restoreRow({ ...target.node, updatedAt: at });
  for (const edge of target.childEdges) await repos.context.exec("UPDATE org_nodes SET parent_id = ?, updated_at = ? WHERE project_id = ? AND id = ?", [edge.parentId, at, target.projectId, edge.nodeId]);
  if (target.node === null) await repos.context.exec("DELETE FROM org_nodes WHERE project_id = ? AND id = ?", [target.projectId, target.targetId]);
  for (const a of target.assignments) await repos.context.exec("UPDATE members SET node_id = ?, role = ?, updated_at = ? WHERE project_id = ? AND id = ?", [a.nodeId, a.legacyRole, at, target.projectId, a.memberId]);
  const actualAfter = await captureOrgGraph(repos, target.projectId, target.targetId, watch, includeRelations);
  if (!equalGraph(actualAfter, target)) conflict("岗位补偿读回与计划不一致。");
  return { actualBefore, actualAfter };
}

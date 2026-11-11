import { isDeepStrictEqual } from "node:util";
import type { RepositorySet } from "../db/repositories.ts";
import type { OrgNode } from "../db/types.ts";
import type { OrgGraphSnapshotV2 } from "./compensation-types.ts";
import { conflict } from "./boundary.ts";
import { RepositoryError } from "../db/errors.ts";
import { assertCompleteAuditFields } from "../audit.ts";
import { CaptureBudget } from "./capture-budget.ts";

type Edge = { node_id: string; parent_id: string | null };
export function nodeProjection(node: OrgNode | null): unknown {
  if (node === null) return null;
  return { id: node.id, projectId: node.projectId, parentId: node.parentId, name: node.name, role: node.role, sortOrder: node.sortOrder, createdAt: node.createdAt };
}
export async function captureOrgGraph(repos: RepositorySet, projectId: string, nodeId: string,
  watch: { childIds?: readonly string[]; memberIds?: readonly string[] } = {}, includeRelations = true): Promise<OrgGraphSnapshotV2> {
  const node = await repos.org.getNode(nodeId);
  if (node && node.projectId !== projectId) conflict("岗位快照跨项目。");
  if (!includeRelations) {
    const result: OrgGraphSnapshotV2 = { schema: "org-graph/v2", projectId, targetId: nodeId, node, childEdges: [], assignments: [], directChildIds: [] };
    assertCompleteAuditFields(result); return result;
  }
  const children = await repos.context.query<Edge>("SELECT id AS node_id, parent_id FROM org_nodes WHERE project_id = ? AND parent_id = ? ORDER BY id LIMIT 513", [projectId, nodeId]);
  if (children.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "岗位直接下级超过单次审计范围。");
  const childIds = [...new Set([...(watch.childIds ?? []), ...children.map(c => c.node_id)])].sort();
  if (childIds.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "岗位关系超出审计预算。");
  const childEdges: OrgGraphSnapshotV2["childEdges"] = [];
  for (let start = 0; start < childIds.length; start += 32) {
    const ids = childIds.slice(start, start + 32);
    const rows = await repos.context.query<Edge>(`SELECT id AS node_id, parent_id FROM org_nodes WHERE project_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, [projectId, ...ids]);
    if (rows.length !== ids.length) conflict("需恢复的下级岗位已删除或不属于同项目。");
    childEdges.push(...rows.map(r => ({ nodeId: r.node_id, parentId: r.parent_id })));
  }
  const occupants = await repos.context.query<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND node_id = ? ORDER BY id LIMIT 2", [projectId, nodeId]);
  const memberIds = [...new Set([...(watch.memberIds ?? []), ...occupants.map(m => m.id)])].sort();
  if (memberIds.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "岗位成员超出审计预算。");
  const assignments: OrgGraphSnapshotV2["assignments"] = [];
  for (const id of memberIds) {
    const member = await repos.members.get(id);
    if (!member || member.projectId !== projectId) conflict("原占岗成员已移除或换代。");
    assignments.push({ memberId: id, nodeId: member.nodeId, legacyRole: member.role });
  }
  const result: OrgGraphSnapshotV2 = { schema: "org-graph/v2", projectId, targetId: nodeId, node, childEdges, assignments, directChildIds: children.map(c => c.node_id) };
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
    seen.add(id); const node = await repos.org.getNode(id);
    if (!node || node.projectId !== projectId) conflict("恢复岗位的父节点已不存在或属于其他项目。");
    id = node.parentId;
  }
}
export async function applyOrgGraph(repos: RepositorySet, expected: OrgGraphSnapshotV2, target: OrgGraphSnapshotV2, at: string, includeRelations = true) {
  const watch = { childIds: [...new Set([...expected.childEdges, ...target.childEdges].map(c => c.nodeId))],
    memberIds: [...new Set([...expected.assignments, ...target.assignments].map(m => m.memberId))] };
  const actualBefore = await captureOrgGraph(repos, expected.projectId, expected.targetId, watch, includeRelations);
  if (!equalGraph(actualBefore, expected)) conflict("岗位内容、直接下级集合或占岗已变化，不能覆盖后续修改。");
  if (expected.node && target.node && expected.node.id !== target.node.id) conflict();
  if (target.node) {
    await validateParent(repos, target.projectId, target.targetId, target.node.parentId);
    if (target.node.parentId === null) { const root = await repos.org.getRootNode(target.projectId); if (root && root.id !== target.targetId) conflict("项目已有其他根岗位。"); }
  }
  for (const edge of target.childEdges) {
    if (edge.parentId !== target.targetId) await validateParent(repos, target.projectId, edge.nodeId, edge.parentId);
  }
  for (const assignment of target.assignments) {
    if (assignment.nodeId !== null) {
      const node = assignment.nodeId === target.targetId ? target.node : await repos.org.getNode(assignment.nodeId);
      if (!node || node.projectId !== target.projectId) conflict("待恢复岗位不存在。");
      const occupant = await repos.context.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND node_id = ?", [target.projectId, assignment.nodeId]);
      if (occupant && occupant.id !== assignment.memberId && !target.assignments.some(a => a.memberId === occupant.id && a.nodeId !== assignment.nodeId)) conflict("待恢复岗位已被其他成员占据。");
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

import type { RepositorySet } from "../db/repositories.ts";
import type { Member, MemberLifecycleStatus, NewMember, NewOrgNode, OrgNode } from "../db/types.ts";
import { RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { appendAuditEntry, assertCompleteAuditFields, auditActorFrom, type AuditEntry } from "../audit.ts";
import { MEMBER_CAPTURE_BUDGET, type OrgMutationAccess, type ReversalMetadataV2, type RestartRequired } from "./compensation-types.ts";
import { authorizeMutation, conflict, discoverOrgMembers, withOrgMutation } from "./boundary.ts";
import { captureOrgGraph } from "./graph.ts";
import { CaptureBudget, boundedText } from "./capture-budget.ts";
import { applyMemberCompensation, captureMember, discoverMemberRelations, emptyMemberSnapshot, watchFromSnapshots } from "./member-relations.ts";

export type NodePatch = Partial<Pick<OrgNode, "name" | "role" | "parentId" | "sortOrder">>;
export interface AssignmentSnapshotV2 {
  schema: "org-assignment/v2"; projectId: string; targetId: string;
  assignments: Array<{ memberId: string; nodeId: string | null; legacyRole: "manager" | "normal"; membershipRevision: number }>;
}
export interface StatusSnapshotV2 {
  schema: "member-status/v2"; projectId: string; targetId: string;
  status: MemberLifecycleStatus; membershipRevision: number;
}
export interface OrgMutationService {
  addMember(access: OrgMutationAccess, input: NewMember): Promise<{ member: Member; auditId: string }>;
  removeMember(access: OrgMutationAccess, projectId: string, memberId: string): Promise<{ auditId: string; restartRequired: RestartRequired[] }>;
  createNode(access: OrgMutationAccess, input: NewOrgNode): Promise<{ node: OrgNode; auditId: string }>;
  updateNode(access: OrgMutationAccess, projectId: string, nodeId: string, patch: NodePatch): Promise<{ node: OrgNode; auditId: string }>;
  deleteNode(access: OrgMutationAccess, projectId: string, nodeId: string): Promise<{ auditId: string }>;
  assignNode(access: OrgMutationAccess, projectId: string, memberId: string, nodeId: string | null): Promise<{ member: Member; auditId: string }>;
  autoPlaceMember(access: OrgMutationAccess, projectId: string, memberId: string): Promise<{ node: OrgNode | null; auditId: string | null }>;
  setMemberStatus(access: OrgMutationAccess, projectId: string, memberId: string, status: MemberLifecycleStatus): Promise<{ member: Member; auditId: string }>;
}
export function reversalRoot(id: string, action: string): ReversalMetadataV2 {
  return { version: 2, rootAuditId: id, rootAction: action, undoesAuditId: null, direction: "forward" };
}
export async function captureAssignment(repos: RepositorySet, projectId: string, targetId: string, memberIds: readonly string[]): Promise<AssignmentSnapshotV2> {
  const assignments: AssignmentSnapshotV2["assignments"] = [];
  for (const id of [...new Set(memberIds)].sort()) {
    const m = await repos.members.get(id);
    if (!m || m.projectId !== projectId) conflict("占岗成员已移除或不属于同一项目。");
    assignments.push({ memberId: id, nodeId: m.nodeId, legacyRole: m.role, membershipRevision: m.membershipRevision });
  }
  const result: AssignmentSnapshotV2 = { schema: "org-assignment/v2", projectId, targetId, assignments };
  assertCompleteAuditFields(result); return result;
}
export function statusSnapshot(m: Member): StatusSnapshotV2 {
  return { schema: "member-status/v2", projectId: m.projectId, targetId: m.id, status: m.status, membershipRevision: m.membershipRevision };
}
export function createOrgMutationService({ repos, now = () => new Date() }: { repos: RepositorySet; now?: () => Date }): OrgMutationService {
  async function record(entry: AuditEntry, id: string, at: string) {
    const detail = { ...(typeof entry.detail === "object" && entry.detail ? entry.detail : {}), reversal: reversalRoot(id, entry.action) };
    assertCompleteAuditFields(entry.before, entry.after, detail);
    return appendAuditEntry(repos.audit, { ...entry, detail }, { id, createdAt: at });
  }
  const plan = (projectId: string, nodeId?: string, memberId?: string) => async (tx: RepositorySet["context"]) => ({
    memberIds: await discoverOrgMembers(tx, projectId, nodeId, memberId), groupIds: [], runtimeIds: [],
  });
  return {
    async addMember(access, input) {
      const preallocated = input.id ?? newId(), tracker = CaptureBudget.current() ?? new CaptureBudget(MEMBER_CAPTURE_BUDGET, access.signal);
      let memberId = preallocated, restoring = false;
      const watch = { watchedTaskIds: [], watchedRoundIds: [], watchSettings: false };
      const discover = async (tx: RepositorySet['context']) => {
        const existing = input.agentId ? await tx.one<{ id: string; removed_at: string | null }>('SELECT id, removed_at FROM members WHERE project_id = ? AND agent_id = ?', [input.projectId, input.agentId]) : undefined;
        if (existing) {
          if (existing.removed_at === null) throw new RepositoryError('conflict', '该 Agent 已是项目成员。');
          memberId = existing.id; restoring = true;
          return discoverMemberRelations(input.projectId, memberId, watch, tracker)(tx);
        }
        memberId = preallocated; restoring = false;
        return { memberIds: [], newMemberIds: [memberId], groupIds: [], runtimeIds: [] };
      };
      return tracker.run(() => withOrgMutation(repos, access, input.projectId, discover, async () => {
        const actor = await authorizeMutation(repos, access, 'member:manage', { projectId: input.projectId });
        boundedText(input.displayName, 8192);
        const auditId = newId(), at = now().toISOString();
        if (restoring) {
          const before = (await captureMember(repos, { projectId: input.projectId, memberId, ...watch, budget: MEMBER_CAPTURE_BUDGET, tracker })).snapshot;
          if (before.presence !== 'removed' || !before.member) conflict('该历史成员已进入新的加入周期。');
          const target = { ...before, presence: 'present' as const, participants: [], member: { ...before.member, displayName: input.displayName.trim(), role: input.role ?? 'normal',
            status: input.status ?? 'active', nodeId: null, removedAt: null, membershipRevision: before.member.membershipRevision + 1, updatedAt: at } };
          const result = await applyMemberCompensation(repos, { expected: before, target, compensationAuditId: auditId, at, budget: MEMBER_CAPTURE_BUDGET, tracker });
          await record({ projectId: input.projectId, actor: auditActorFrom(actor), action: 'member.add', targetKind: 'member', targetId: memberId, targetName: target.member.displayName,
            before: result.actualBefore, after: result.actualAfter, detail: { explicitReadd: true, restartRequired: result.restartRequired } }, auditId, at);
          return { member: result.actualAfter.member!, auditId };
        }
        const before = emptyMemberSnapshot(input.projectId, memberId);
        assertCompleteAuditFields({ ...input, id: memberId }, { reversal: reversalRoot(auditId, 'member.add') });
        tracker.plan({ rows: 40, bytes: 65536, sql: 50, changedRows: 8 });
        const member = await repos.members.create({ ...input, id: memberId });
        const after = (await captureMember(repos, { projectId: input.projectId, memberId, ...watch, budget: MEMBER_CAPTURE_BUDGET, tracker })).snapshot;
        await record({ projectId: input.projectId, actor: auditActorFrom(actor), action: 'member.add', targetKind: 'member', targetId: memberId, targetName: member.displayName, before, after }, auditId, at);
        tracker.check(); return { member, auditId };
      }));
    },
    async removeMember(access, projectId, memberId) {
      const tracker = CaptureBudget.current() ?? new CaptureBudget(MEMBER_CAPTURE_BUDGET, access.signal), watch = { watchedTaskIds: [], watchedRoundIds: [], watchSettings: false };
      return tracker.run(() => withOrgMutation(repos, access, projectId, discoverMemberRelations(projectId, memberId, watch, tracker), async () => {
        const before = (await captureMember(repos, { projectId, memberId, ...watch, budget: MEMBER_CAPTURE_BUDGET, tracker })).snapshot;
        if (!before.member || before.presence !== 'present') throw new RepositoryError('member_removed', '成员已被移除，请刷新。');
        const actor = await authorizeMutation(repos, access, 'member:manage', { projectId, nodeId: before.member.nodeId });
        const auditId = newId(), at = now().toISOString();
        const target = { ...before, presence: 'removed' as const, member: { ...before.member, status: 'disabled' as const, nodeId: null, role: 'normal' as const,
          removedAt: at, membershipRevision: before.member.membershipRevision + 1, updatedAt: at } };
        const result = await applyMemberCompensation(repos, { expected: before, target, compensationAuditId: auditId, at, budget: MEMBER_CAPTURE_BUDGET, tracker });
        await record({ projectId, actor: auditActorFrom(actor), action: 'member.remove', targetKind: 'member', targetId: memberId, targetName: before.member.displayName,
          before: result.actualBefore, after: result.actualAfter, detail: { restartRequired: result.restartRequired } }, auditId, at);
        tracker.check(); return { auditId, restartRequired: result.restartRequired };
      }));
    },
    async createNode(access, input) {
      const id = input.id ?? newId(), auditId = newId();
      return withOrgMutation(repos, access, input.projectId, plan(input.projectId), async () => {
        const actor = await authorizeMutation(repos, access, "org:manage", { projectId: input.projectId, nodeId: input.parentId ?? null });
        const at = now().toISOString();
        const before = await captureOrgGraph(repos, input.projectId, id);
        if (before.node) conflict("预分配岗位 ID 已存在。");
        const proposed = { ...before, node: { id, projectId: input.projectId, parentId: input.parentId ?? null, name: input.name.trim(), role: input.role,
          sortOrder: input.sortOrder ?? 0, createdAt: at, updatedAt: at } };
        assertCompleteAuditFields(proposed, { reversal: reversalRoot(auditId, "org.node_create") });
        CaptureBudget.current()!.plan({ rows: 20, bytes: Buffer.byteLength(JSON.stringify(proposed)) * 2 + 8192, sql: 30, changedRows: 2 });
        const node = await repos.org.createNode({ ...input, id });
        const after = await captureOrgGraph(repos, input.projectId, id);
        await record({ projectId: input.projectId, actor: auditActorFrom(actor), action: "org.node_create", targetKind: "node", targetId: id, targetName: node.name, before, after }, auditId, at);
        return { node, auditId };
      });
    },
    async updateNode(access, projectId, nodeId, patch) {
      return withOrgMutation(repos, access, projectId, plan(projectId, nodeId), async () => {
        const actor = await authorizeMutation(repos, access, "org:manage", { projectId, nodeId });
        if (patch.parentId !== undefined && patch.parentId !== null) await authorizeMutation(repos, access, "org:manage", { projectId, nodeId: patch.parentId });
        const before = await captureOrgGraph(repos, projectId, nodeId, {}, false);
        if (!before.node) throw new RepositoryError("not_found", "岗位不存在。");
        const auditId = newId(), at = now().toISOString();
        assertCompleteAuditFields({ ...before, node: { ...before.node, ...patch, updatedAt: at } });
        CaptureBudget.current()!.plan({ rows: 20, bytes: Buffer.byteLength(JSON.stringify(before)) * 3 + Buffer.byteLength(JSON.stringify(patch)) * 2, sql: 30, changedRows: 2 });
        const node = await repos.org.updateNode(nodeId, patch);
        const after = await captureOrgGraph(repos, projectId, nodeId, {}, false);
        await record({ projectId, actor: auditActorFrom(actor), action: "org.node_update", targetKind: "node", targetId: nodeId, targetName: node.name, before, after }, auditId, at);
        return { node, auditId };
      });
    },
    async deleteNode(access, projectId, nodeId) {
      return withOrgMutation(repos, access, projectId, plan(projectId, nodeId), async () => {
        const actor = await authorizeMutation(repos, access, "org:manage", { projectId, nodeId });
        const before = await captureOrgGraph(repos, projectId, nodeId);
        if (!before.node) throw new RepositoryError("not_found", "岗位不存在。");
        const auditId = newId(), at = now().toISOString();
        const proposed = { ...before, node: null, directChildIds: [], childEdges: before.childEdges.map(c => ({ ...c, parentId: before.node!.parentId })),
          assignments: before.assignments.map(a => ({ ...a, nodeId: null, legacyRole: "normal" as const })) };
        assertCompleteAuditFields(before, proposed, { reversal: reversalRoot(auditId, "org.node_delete") });
        CaptureBudget.current()!.plan({ rows: before.childEdges.length * 2 + before.assignments.length * 3 + 10,
          bytes: Buffer.byteLength(JSON.stringify(proposed)) * 3 + 8192, sql: 20 + before.assignments.length * 4 + Math.ceil(before.childEdges.length / 32),
          changedRows: 2 + before.childEdges.length + before.assignments.length * 2 });
        await repos.org.deleteNode(nodeId);
        for (const a of before.assignments) await repos.context.exec("UPDATE members SET role = 'normal', updated_at = ? WHERE project_id = ? AND id = ?", [at, projectId, a.memberId]);
        const after = await captureOrgGraph(repos, projectId, nodeId, { childIds: before.directChildIds, memberIds: before.assignments.map(a => a.memberId) });
        await record({ projectId, actor: auditActorFrom(actor), action: "org.node_delete", targetKind: "node", targetId: nodeId, targetName: before.node.name, before, after }, auditId, at);
        return { auditId };
      });
    },
    async assignNode(access, projectId, memberId, nodeId) {
      return withOrgMutation(repos, access, projectId, plan(projectId, nodeId ?? undefined, memberId), async () => {
        const member = await repos.members.get(memberId);
        if (!member || member.projectId !== projectId) throw new RepositoryError("not_found", "成员不存在或不属于项目。");
        const actor = await authorizeMutation(repos, access, "member:manage", { projectId, nodeId: member.nodeId });
        if (nodeId !== null) await authorizeMutation(repos, access, "member:manage", { projectId, nodeId });
        const ids = await discoverOrgMembers(repos.context, projectId, nodeId ?? undefined, memberId);
        const before = await captureAssignment(repos, projectId, memberId, ids);
        const auditId = newId(), at = now().toISOString();
        const target = nodeId === null ? null : await repos.org.getNode(nodeId);
        assertCompleteAuditFields({ ...before, assignments: before.assignments.map(a => a.memberId === memberId ? { ...a, nodeId, legacyRole: target?.parentId === null ? "manager" : "normal" } : a) });
        CaptureBudget.current()!.plan({ rows: ids.length * 3 + 10, bytes: Buffer.byteLength(JSON.stringify(before)) * 3 + 8192, sql: ids.length * 4 + 20, changedRows: ids.length + 2 });
        const updated = await repos.org.assignNode(memberId, nodeId);
        const after = await captureAssignment(repos, projectId, memberId, ids);
        await record({ projectId, actor: auditActorFrom(actor), action: "org.assign", targetKind: "member", targetId: memberId, targetName: updated.displayName, before, after }, auditId, at);
        return { member: updated, auditId };
      });
    },
    async autoPlaceMember(access, projectId, memberId) {
      return withOrgMutation(repos, access, projectId, plan(projectId, undefined, memberId), async () => {
        const member = await repos.members.get(memberId);
        if (!member || member.projectId !== projectId) throw new RepositoryError("not_found", "成员不存在或不属于项目。");
        const actor = await authorizeMutation(repos, access, "member:manage", { projectId, nodeId: member.nodeId });
        if (member.nodeId !== null) return { node: await repos.org.getNode(member.nodeId), auditId: null };
        if (!await repos.org.getRootNode(projectId)) return { node: null, auditId: null };
        const ids = await discoverOrgMembers(repos.context, projectId, undefined, memberId);
        const before = await captureAssignment(repos, projectId, memberId, ids);
        assertCompleteAuditFields({ name: member.displayName });
        CaptureBudget.current()!.plan({ rows: ids.length * 3 + 10, bytes: Buffer.byteLength(JSON.stringify(before)) * 3 + 8192, sql: ids.length * 4 + 20, changedRows: 3 });
        const node = await repos.org.autoPlaceMember(projectId, memberId);
        if (!node) return { node, auditId: null };
        const auditId = newId(), at = now().toISOString();
        // 对外审计目标保持旧 node 语义；before/after 的 member ID 在 assignments 中。
        before.targetId = node.id;
        const after = await captureAssignment(repos, projectId, node.id, ids);
        await record({ projectId, actor: auditActorFrom(actor), action: "org.auto_place", targetKind: "node", targetId: node.id, targetName: node.name, before, after }, auditId, at);
        return { node, auditId };
      });
    },
    async setMemberStatus(access, projectId, memberId, status) {
      return withOrgMutation(repos, access, projectId, plan(projectId, undefined, memberId), async () => {
        const member = await repos.members.get(memberId);
        if (!member || member.projectId !== projectId) throw new RepositoryError("not_found", "成员不存在或不属于项目。");
        const actor = await authorizeMutation(repos, access, "member:manage", { projectId, nodeId: member.nodeId });
        const before = statusSnapshot(member), auditId = newId(), at = now().toISOString();
        assertCompleteAuditFields(before, { ...before, status });
        CaptureBudget.current()!.plan({ rows: 15, bytes: 16384, sql: 20, changedRows: 2 });
        const updated = await repos.members.setStatus(memberId, status), after = statusSnapshot(updated);
        await record({ projectId, actor: auditActorFrom(actor), action: status === "disabled" ? "member.pause" : status === "active" ? "member.resume" : "member.status_change",
          targetKind: "member", targetId: memberId, targetName: member.displayName, before, after }, auditId, at);
        return { member: updated, auditId };
      });
    },
  };
}

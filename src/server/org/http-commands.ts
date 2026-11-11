import { isDeepStrictEqual } from "node:util";
import type { RepositorySet } from "../db/repositories.ts";
import type { Member } from "../db/types.ts";
import { RepositoryError } from "../db/errors.ts";
import { newId } from "../db/ids.ts";
import { appendAuditEntry, assertCompleteAuditFields, auditActorFrom } from "../audit.ts";
import type { OrgMutationAccess } from "./compensation-types.ts";
import { authorizeMutation, conflict, discoverOrgMembers, withOrgMutation } from "./boundary.ts";
import { CaptureBudget } from "./capture-budget.ts";
import { captureAssignment, createOrgMutationService, reversalRoot } from "./mutations.ts";

export interface OrgHttpCommands {
  setManager(access: OrgMutationAccess, projectId: string, memberId: string): Promise<{ member: Member; auditId: string | null }>;
  clearNode(access: OrgMutationAccess, projectId: string, nodeId: string): Promise<{ member: Member | null; auditId: string | null }>;
}

/** 旧 HTTP 语义的领域组合；请求解析和身份/连接授权仍由入口提供。 */
export function createOrgHttpCommands({ repos, now = () => new Date() }: { repos: RepositorySet; now?: () => Date }): OrgHttpCommands {
  const mutations = createOrgMutationService({ repos, now });
  return {
    async setManager(access, projectId, memberId) {
      let rootId: string | null = null;
      return withOrgMutation(repos, access, projectId, async tx => {
        rootId = (await tx.one<{ id: string }>("SELECT id FROM org_nodes WHERE project_id = ? AND parent_id IS NULL", [projectId]))?.id ?? null;
        return { memberIds: await discoverOrgMembers(tx, projectId, rootId ?? undefined, memberId), groupIds: [], runtimeIds: [] };
      }, async () => {
        const budget = CaptureBudget.current()!; budget.adoptScope(repos.mutations.current()!.startedAt);
        const root = await repos.org.getRootNode(projectId);
        if ((root?.id ?? null) !== rootId) throw new RepositoryError("mutation_scope_changed", "项目根岗位已变化，请刷新后重试。");
        const actor = await authorizeMutation(repos, access, "org:manage", { projectId, nodeId: rootId });
        const member = await repos.members.get(memberId);
        if (!member || member.projectId !== projectId) throw new RepositoryError("not_found", "目标成员不存在或不属于项目。");
        const ids = await discoverOrgMembers(repos.context, projectId, rootId ?? undefined, memberId);
        repos.mutations.current()!.assertCovers([projectId], ids);
        const before = await captureAssignment(repos, projectId, memberId, ids);
        const oldRoot = root ? before.assignments.find(assignment => assignment.nodeId === root.id && assignment.memberId !== memberId) : undefined;
        const proposed = { ...before, assignments: before.assignments.map(assignment => ({ ...assignment,
          ...(root ? { nodeId: assignment.memberId === memberId ? root.id : assignment.nodeId === root.id ? null : assignment.nodeId } : {}),
          legacyRole: assignment.memberId === memberId ? "manager" as const : "normal" as const })) };
        if (isDeepStrictEqual(before, proposed)) { budget.check(); return { member, auditId: null }; }
        if (root && !oldRoot) return mutations.assignNode(access, projectId, memberId, root.id);
        const auditId = newId(), at = now().toISOString();
        const detail = { reversal: reversalRoot(auditId, "org.assign") };
        assertCompleteAuditFields(before, proposed, detail);
        budget.plan({ rows: ids.length * 3 + 16, bytes: Buffer.byteLength(JSON.stringify(before)) * 3 + 8192,
          sql: ids.length * 4 + 24, changedRows: ids.length + 2 });
        let updated: Member;
        if (root && oldRoot) {
          // 整体换人只有一个权威审计；不能拆成两个可单独撤销的 service 操作。
          await repos.org.assignNode(oldRoot.memberId, null);
          updated = await repos.org.assignNode(memberId, root.id);
        } else {
          for (const assignment of before.assignments) {
            if (assignment.memberId !== memberId && assignment.legacyRole === "manager") await repos.members.update(assignment.memberId, { role: "normal" });
          }
          updated = await repos.members.update(memberId, { role: "manager" });
        }
        const after = await captureAssignment(repos, projectId, memberId, ids);
        if (!isDeepStrictEqual(after, proposed)) conflict("负责人指派读回与完整计划不一致。");
        await appendAuditEntry(repos.audit, { projectId, actor: auditActorFrom(actor), action: "org.assign", targetKind: "member",
          targetId: memberId, targetName: updated.displayName, before, after, detail }, { id: auditId, createdAt: at });
        budget.check(); return { member: updated, auditId };
      });
    },
    async clearNode(access, projectId, nodeId) {
      return withOrgMutation(repos, access, projectId, async tx => ({
        memberIds: await discoverOrgMembers(tx, projectId, nodeId), groupIds: [], runtimeIds: [],
      }), async () => {
        const budget = CaptureBudget.current()!; budget.adoptScope(repos.mutations.current()!.startedAt);
        await authorizeMutation(repos, access, "org:manage", { projectId, nodeId });
        const node = await repos.org.getNode(nodeId);
        if (!node || node.projectId !== projectId) throw new RepositoryError("not_found", "岗位不存在或不属于项目。");
        // 身份读取在项目与完整成员锁之后，不能使用 API 在锁外找到的旧占岗者。
        const current = await repos.context.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND node_id = ?", [projectId, nodeId]);
        if (!current) { budget.check(); return { member: null, auditId: null }; }
        repos.mutations.current()!.assertCovers([projectId], [current.id]);
        return mutations.assignNode(access, projectId, current.id, null);
      });
    },
  };
}

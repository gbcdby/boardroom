import type { Actor } from "./authz/authorize.ts";
import type { MutationDiscover } from "./db/mutation-scope.ts";
import { RepositoryError } from "./db/errors.ts";

/** 仅服务端可信绑定，不从 HTTP/MCP 请求参数接受。 */
export interface DomainConnection { readonly projectId: string; readonly memberId: string; readonly groupId: string; readonly membershipRevision: number }
export interface DomainAccess { readonly actor: Actor; readonly connection?: DomainConnection }
export interface DomainMutationTargets {
  readonly taskId?: string; readonly roundId?: string; readonly messageId?: string; readonly summaryRequestId?: string;
  readonly memberIds?: readonly (string | null | undefined)[]; readonly agentIds?: readonly (string | null | undefined)[];
  readonly taskDefaults?: boolean; readonly escalation?: boolean;
}

/** 项目锁之后只读发现当前外键/通知接收人；仅取标识，绝不加载正文或模型证据。 */
export function discoverDomainMutation(access: DomainAccess, projectId: string, targets: DomainMutationTargets = {}): MutationDiscover {
  return async tx => {
    const members = new Set<string>((targets.memberIds ?? []).filter((id): id is string => typeof id === "string"));
    const groups = new Set<string>();
    if (access.actor.kind === "agent") members.add(access.actor.actorId);
    if (access.connection) { members.add(access.connection.memberId); groups.add(access.connection.groupId); }
    if (targets.taskId) {
      const row = await tx.one<{ assignee_member_id: string | null; reviewer_member_id: string | null }>(
        "SELECT assignee_member_id, reviewer_member_id FROM tasks WHERE project_id = ? AND id = ?", [projectId, targets.taskId]);
      if (row?.assignee_member_id) members.add(row.assignee_member_id); if (row?.reviewer_member_id) members.add(row.reviewer_member_id);
    }
    if (targets.roundId) {
      const row = await tx.one<{ reviewer_member_id: string }>("SELECT reviewer_member_id FROM task_review_rounds WHERE project_id = ? AND id = ?", [projectId, targets.roundId]);
      if (row) members.add(row.reviewer_member_id);
    }
    if (targets.taskDefaults) {
      const row = await tx.one<{ default_reviewer_member_id: string | null }>("SELECT default_reviewer_member_id FROM project_task_settings WHERE project_id = ?", [projectId]);
      if (row?.default_reviewer_member_id) members.add(row.default_reviewer_member_id);
    }
    if (targets.summaryRequestId) {
      const row = await tx.one<{ recipient_member_id: string; context_group_id: string | null }>(
        "SELECT recipient_member_id, context_group_id FROM memory_summary_requests WHERE project_id = ? AND id = ?", [projectId, targets.summaryRequestId]);
      if (row) { members.add(row.recipient_member_id); if (row.context_group_id) groups.add(row.context_group_id); }
    }
    for (const agentId of new Set(targets.agentIds ?? [])) {
      if (typeof agentId !== "string") continue;
      const row = await tx.one<{ id: string }>("SELECT id FROM members WHERE project_id = ? AND agent_id = ?", [projectId, agentId]);
      if (row) members.add(row.id);
    }
    if (targets.messageId) {
      const row = await tx.one<{ group_id: string }>("SELECT m.group_id FROM messages m JOIN groups g ON g.id = m.group_id WHERE g.project_id = ? AND m.id = ?", [projectId, targets.messageId]);
      if (row) groups.add(row.group_id);
    }
    if (targets.escalation) {
      // 上级通知的实际接收人由锁内最新树决定；预先涵盖所有可能的当前管理岗位。
      const rows = await tx.query<{ id: string }>(`SELECT m.id FROM members m LEFT JOIN org_nodes n ON n.id = m.node_id
        WHERE m.project_id = ? AND (m.role = 'manager' OR n.role IN ('top_manager', 'sub_manager')) ORDER BY m.id LIMIT 2049`, [projectId]);
      for (const row of rows) members.add(row.id);
    }
    if (members.size > 2048 || groups.size > 2048) throw new RepositoryError("mutation_scope_changed", "领域变更目标超过有界计划容量。");
    // 输入的错项目/不存在 ID 留给领域产生原有语义错误，不扩大项目锁闭包。
    const memberIds = members.size ? (await tx.query<{ id: string }>(`SELECT id FROM members WHERE project_id = ? AND id IN (${[...members].map(() => "?").join(",")}) ORDER BY id`, [projectId, ...members])).map(row => row.id) : [];
    const groupIds = groups.size ? (await tx.query<{ id: string }>(`SELECT id FROM groups WHERE project_id = ? AND id IN (${[...groups].map(() => "?").join(",")}) ORDER BY id`, [projectId, ...groups])).map(row => row.id) : [];
    return { memberIds, groupIds, runtimeIds: [] };
  };
}

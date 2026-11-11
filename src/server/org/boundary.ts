import type { RepositorySet, RepoCtx } from "../db/repositories.ts";
import type { MutationDiscover } from "../db/mutation-scope.ts";
import { RepositoryError } from "../db/errors.ts";
import { authorizeOrThrow, type Actor, type Capability, type GuardScope } from "../authz/authorize.ts";
import { actorForMember } from "../authz/actors.ts";
import type { OrgMutationAccess } from "./compensation-types.ts";
import { CaptureBudget } from "./capture-budget.ts";

export function conflict(message = "相关事实已变化，请刷新后核对再操作。"): never {
  throw new RepositoryError("compensation_conflict", message);
}
export async function projectActive(repos: RepositorySet, projectId: string): Promise<void> {
  const p = await repos.context.one<{ archived_at: string | null }>("SELECT archived_at FROM projects WHERE id = ?", [projectId]);
  if (!p) throw new RepositoryError("not_found", "项目不存在。");
  if (p.archived_at !== null) throw new RepositoryError("archived", "已归档项目不能变更组织或补偿；请先恢复项目。");
}
/** 入口传入的 Actor 不是锁内授权缓存。成员状态/岗位必须在共同 scope 内重读。 */
export async function freshActor(repos: RepositorySet, actor: Actor, projectId: string): Promise<Actor> {
  if (actor.kind === "human") return actor;
  const member = await repos.members.get(actor.actorId);
  if (!member || member.projectId !== projectId || member.status !== "active") {
    throw new RepositoryError("member_removed", "当前成员已移除或不可用，请重新核对项目成员身份。");
  }
  if (!member.nodeId) return actorForMember(member);
  const node = await repos.org.getNode(member.nodeId);
  if (!node || node.projectId !== projectId || node.role === "owner") conflict("成员岗位已变化。");
  return { actorId: member.id, kind: "agent", role: node.role, projectId, nodeId: node.id,
    subtreeNodeIds: await repos.org.subtreeNodeIds(node.id) };
}
export async function authorizeMutation(repos: RepositorySet, access: OrgMutationAccess, capability: Capability, scope: GuardScope & { projectId: string }): Promise<Actor> {
  const actor = await freshActor(repos, access.actor, scope.projectId);
  authorizeOrThrow(actor, capability, scope); return actor;
}
export async function withOrgMutation<T>(repos: RepositorySet, access: OrgMutationAccess, projectId: string,
  discover: MutationDiscover, body: () => Promise<T>): Promise<T> {
  const complete: MutationDiscover = async tx => {
    const found = await discover(tx);
    return { ...found, memberIds: [...new Set([...found.memberIds, ...(access.actor.kind === "agent" ? [access.actor.actorId] : [])])] };
  };
  const run = () => repos.transaction(() => repos.mutations.run({ projectIds: [projectId], discover: complete }, async () => {
    await projectActive(repos, projectId); return body();
  }));
  const budget = CaptureBudget.current() ?? new CaptureBudget(undefined, access.signal);
  return budget.run(() => access.runMutation ? access.runMutation(run, complete) : run());
}
export async function discoverOrgMembers(tx: RepoCtx, projectId: string, nodeId?: string, memberId?: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(`SELECT id FROM members WHERE project_id = ? AND
    (node_id = ? OR id = ? OR role = 'manager') ORDER BY id LIMIT 513`, [projectId, nodeId ?? null, memberId ?? null]);
  if (rows.length > 512) throw new RepositoryError("audit_capture_budget_exceeded", "受影响成员数量超过单次审计范围。");
  return rows.map(r => r.id);
}

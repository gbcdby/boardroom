/**
 * T3：群组参与者 roster 构建（路由输入）。
 *
 * MCP core 与 HTTP API 共用同一份实现，避免两处各写一份产生分歧。
 *
 * 参与者来自 group_participants；role 取 members.role；kind 取 members.kind；
 * 在线判定 = 该成员有 connected 的 MCP 会话（人视为在线）。未参与群组者不进入
 * roster，因此可见/唤醒结果天然不含外部成员（隔离）。群组不存在时返回空数组。
 */
import type { RepositorySet } from "../db/repositories.ts";
import type { RoutingMember } from "./routing.ts";

export async function buildRoster(repos: RepositorySet, groupId: string): Promise<RoutingMember[]> {
  const group = (await (repos.groups.get(groupId)));
  if (!group) return [];
  const onlineIds = new Set(
    (await (repos.mcpSessions
      .listByProject(group.projectId)))
      .filter((s) => s.state === "connected")
      .map((s) => s.memberId),
  );
  const roster: RoutingMember[] = [];
  for (const id of (await (repos.groups.participants(groupId)))) {
    const member = (await (repos.members.get(id)));
    if (!member) continue;
    roster.push({
      id: member.id,
      role: member.role,
      kind: member.kind,
      online: member.kind === "human" ? true : onlineIds.has(member.id),
      displayName: member.displayName,
    });
  }
  return roster;
}

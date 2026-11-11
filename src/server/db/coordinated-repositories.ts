import type { RepoCtx, RepositorySet } from './repositories.ts';
import type { MutationDiscovery, MutationLockPlan } from './mutation-scope.ts';
import { InvalidReferenceError, NotFoundError, RepositoryError } from './errors.ts';
import { newId } from './ids.ts';

type IdRow = { id: string };
const empty = (): MutationDiscovery => ({ memberIds: [], groupIds: [], runtimeIds: [] });
function ids(values: readonly string[]): string[] {
  const valuesSet = [...new Set(values)].sort();
  if (valuesSet.length > 2048 || valuesSet.some(v => typeof v !== 'string' || !v.trim())) throw new RepositoryError('mutation_scope_changed', '数据写入范围超过完整计划容量。');
  return valuesSet;
}
async function checkedMembers(ctx: RepoCtx, projectId: string, values: readonly string[]): Promise<string[]> {
  const members = ids(values);
  for (let start = 0; start < members.length; start += 32) {
    const batch = members.slice(start, start + 32);
    const rows = await ctx.query<IdRow>(`SELECT id FROM members WHERE project_id = ? AND id IN (${batch.map(() => '?').join(',')})`, [projectId, ...batch]);
    if (rows.length !== batch.length) throw new InvalidReferenceError('写入引用的成员不存在或不属于同一项目。');
  }
  return members;
}
async function requireProjectOf(ctx: RepoCtx, table: 'members'|'groups'|'org_nodes'|'mcp_sessions', id: string): Promise<string> {
  const row = await ctx.one<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw new NotFoundError(`${table} ${id} 不存在。`);
  return row.project_id;
}
function projectPlan(projectId: string, discover: MutationLockPlan['discover'] = async () => empty()): MutationLockPlan { return { projectIds: [projectId], discover }; }

/** Purge 会触发事实版本和 FK 子行变更，必须先锁完整同项目成员，再锁群和 runtime。 */
export function purgeDiscovery(projectId: string, groupId?: string): MutationLockPlan['discover'] {
  return async tx => {
    const members = await tx.query<IdRow>('SELECT id FROM members WHERE project_id = ? ORDER BY id LIMIT 2049', [projectId]);
    const groups = groupId === undefined ? await tx.query<IdRow>('SELECT id FROM groups WHERE project_id = ? ORDER BY id LIMIT 2049', [projectId]) : [{ id: groupId }];
    const bindings = await tx.query<{ member_id: string; runtime_id: string }>(`SELECT member_id, runtime_id FROM agent_runtime_bindings WHERE project_id = ?${groupId === undefined ? '' : ' AND group_id = ?'} ORDER BY id LIMIT 2049`, groupId === undefined ? [projectId] : [projectId, groupId]);
    const reserved = await tx.query<{ member_id: string; runtime_id: string }>('SELECT member_id, runtime_id FROM agent_runtime_members WHERE project_id = ? ORDER BY member_id LIMIT 2049', [projectId]);
    const authors = await tx.query<{ id: string }>(`SELECT DISTINCT m.sender_member_id AS id FROM messages m JOIN groups g ON g.id = m.group_id WHERE g.project_id = ?${groupId === undefined ? '' : ' AND g.id = ?'} ORDER BY id LIMIT 2049`, groupId === undefined ? [projectId] : [projectId, groupId]);
    const recipients = await tx.query<{ id: string }>(`SELECT DISTINCT d.member_id AS id FROM message_deliveries d JOIN messages m ON m.id = d.message_id JOIN groups g ON g.id = m.group_id WHERE g.project_id = ?${groupId === undefined ? '' : ' AND g.id = ?'} ORDER BY id LIMIT 2049`, groupId === undefined ? [projectId] : [projectId, groupId]);
    return { memberIds: await checkedMembers(tx, projectId, [...members, ...authors, ...recipients].map(m => m.id).concat(bindings.map(b => b.member_id), reserved.map(r => r.member_id))),
      groupIds: ids(groups.map(g => g.id)), runtimeIds: ids([...bindings, ...reserved].map(b => b.runtime_id)) };
  };
}

/** v13 基础数据写入的统一入口装配。旧迁移 fixture 保持旧 schema 可运行。 */
export function coordinateRepositoryWrites(repos: RepositorySet): RepositorySet {
  const ctx = repos.context;
  const enabled = async () => Boolean(await ctx.one('SELECT version FROM schema_migrations WHERE version = 13'));
  function coordinate<A extends unknown[], R>(method: (...args: A) => Promise<R>, plan: (args: A) => Promise<MutationLockPlan> | MutationLockPlan): (...args: A) => Promise<R> {
    return async (...args) => {
      if (!await enabled()) return method(...args);
      const resolved = await plan(args);
      return repos.transaction(() => repos.mutations.run(resolved, () => method(...args)));
    };
  }
  const member = async (memberId: string, runtime = false): Promise<MutationLockPlan> => {
    const projectId = await requireProjectOf(ctx, 'members', memberId);
    return projectPlan(projectId, async tx => {
      const bindings = runtime ? await tx.query<{ group_id: string; runtime_id: string }>('SELECT group_id, runtime_id FROM agent_runtime_bindings WHERE project_id = ? AND member_id = ? ORDER BY id LIMIT 2049', [projectId, memberId]) : [];
      return { memberIds: [memberId], groupIds: ids(bindings.map(b => b.group_id)), runtimeIds: ids(bindings.map(b => b.runtime_id)) };
    });
  };
  const group = async (groupId: string, extraMembers: readonly string[] = [], allParticipants = false): Promise<MutationLockPlan> => {
    const projectId = await requireProjectOf(ctx, 'groups', groupId);
    return projectPlan(projectId, async tx => {
      const participants = allParticipants ? await tx.query<{ member_id: string }>('SELECT member_id FROM group_participants WHERE group_id = ? ORDER BY member_id LIMIT 2049', [groupId]) : [];
      return { memberIds: await checkedMembers(tx, projectId, [...extraMembers, ...participants.map(p => p.member_id)]), groupIds: [groupId], runtimeIds: [] };
    });
  };
  const session = async (sessionId: string): Promise<MutationLockPlan> => {
    const row = await ctx.one<{ project_id: string; member_id: string; group_id: string }>('SELECT project_id, member_id, group_id FROM mcp_sessions WHERE id = ?', [sessionId]);
    if (!row) throw new NotFoundError('MCP 会话不存在。');
    return projectPlan(row.project_id, async () => ({ memberIds: [row.member_id], groupIds: [row.group_id], runtimeIds: [] }));
  };
  const delivery = async (messageId: string, memberId: string): Promise<MutationLockPlan> => {
    const row = await ctx.one<{ group_id: string }>('SELECT group_id FROM messages WHERE id = ?', [messageId]);
    if (!row) throw new InvalidReferenceError('投递引用的消息不存在。');
    return group(row.group_id, [memberId]);
  };
  const org = async (projectId: string, nodeId?: string, memberId?: string): Promise<MutationLockPlan> => projectPlan(projectId, async tx => {
    const rows = await tx.query<IdRow>("SELECT id FROM members WHERE project_id = ? AND (node_id = ? OR id = ? OR role = 'manager') ORDER BY id LIMIT 2049", [projectId, nodeId ?? null, memberId ?? null]);
    return { memberIds: ids(rows.map(m => m.id)), groupIds: [], runtimeIds: [] };
  });

  repos.projects.rename = coordinate(repos.projects.rename.bind(repos.projects), ([id]) => projectPlan(id));
  repos.projects.archive = coordinate(repos.projects.archive.bind(repos.projects), ([id]) => projectPlan(id));
  repos.projects.restore = coordinate(repos.projects.restore.bind(repos.projects), ([id]) => projectPlan(id));
  repos.projects.purge = coordinate(repos.projects.purge.bind(repos.projects), ([id]) => projectPlan(id, purgeDiscovery(id)));
  repos.projects.delete = async id => { await repos.projects.purge(id); };

  const createMember = repos.members.create.bind(repos.members);
  repos.members.create = async input => {
    if (!await enabled()) return createMember(input);
    if (!await ctx.one('SELECT id FROM projects WHERE id = ?', [input.projectId])) throw new InvalidReferenceError('成员所属项目不存在。');
    const planned = { ...input, id: input.id ?? newId() };
    return repos.transaction(() => repos.mutations.run(projectPlan(input.projectId, async () => ({ ...empty(), newMemberIds: [planned.id] })), () => createMember(planned)));
  };
  repos.members.update = coordinate(repos.members.update.bind(repos.members), ([id]) => member(id));
  repos.members.setStatus = coordinate(repos.members.setStatus.bind(repos.members), ([id]) => member(id));
  repos.members.delete = coordinate(repos.members.delete.bind(repos.members), ([id]) => member(id, true));
  repos.members.restoreRow = coordinate(repos.members.restoreRow.bind(repos.members), ([m]) => projectPlan(m.projectId, async () => ({ ...empty(), memberIds: [m.id] })));

  repos.groups.create = coordinate(repos.groups.create.bind(repos.groups), async ([input]) => {
    if (!await ctx.one('SELECT id FROM projects WHERE id = ?', [input.projectId])) throw new InvalidReferenceError('群组所属项目不存在。');
    return projectPlan(input.projectId, async tx => ({ ...empty(), memberIds: await checkedMembers(tx, input.projectId, input.participantMemberIds ?? []) }));
  });
  repos.groups.archive = coordinate(repos.groups.archive.bind(repos.groups), ([id]) => group(id));
  repos.groups.restore = coordinate(repos.groups.restore.bind(repos.groups), ([id]) => group(id));
  repos.groups.addParticipant = coordinate(repos.groups.addParticipant.bind(repos.groups), ([id, memberId]) => group(id, [memberId]));
  repos.groups.removeParticipant = coordinate(repos.groups.removeParticipant.bind(repos.groups), ([id, memberId]) => group(id, [memberId]));
  repos.groups.restoreParticipant = coordinate(repos.groups.restoreParticipant.bind(repos.groups), ([id, memberId]) => group(id, [memberId]));
  repos.groups.purge = coordinate(repos.groups.purge.bind(repos.groups), async ([id]) => { const projectId = await requireProjectOf(ctx, 'groups', id); return projectPlan(projectId, purgeDiscovery(projectId, id)); });
  repos.groups.delete = async id => { await repos.groups.purge(id); };

  repos.messages.create = coordinate(repos.messages.create.bind(repos.messages), ([input]) => group(input.groupId, [input.senderMemberId, ...(input.mentions ?? [])], true));
  repos.deliveries.ensure = coordinate(repos.deliveries.ensure.bind(repos.deliveries), ([id, memberId]) => delivery(id, memberId));
  repos.deliveries.recordAttempt = coordinate(repos.deliveries.recordAttempt.bind(repos.deliveries), ([id, memberId]) => delivery(id, memberId));
  repos.deliveries.markMcpDelivered = coordinate(repos.deliveries.markMcpDelivered.bind(repos.deliveries), ([id, memberId]) => delivery(id, memberId));
  repos.deliveries.delete = coordinate(repos.deliveries.delete.bind(repos.deliveries), ([id, memberId]) => delivery(id, memberId));
  repos.statuses.set = coordinate(repos.statuses.set.bind(repos.statuses), ([projectId, memberId]) => projectPlan(projectId, async tx => ({ ...empty(), memberIds: await checkedMembers(tx, projectId, [memberId]) })));
  repos.statuses.delete = coordinate(repos.statuses.delete.bind(repos.statuses), ([projectId, memberId]) => projectPlan(projectId, async tx => ({ ...empty(), memberIds: await checkedMembers(tx, projectId, [memberId]) })));
  repos.mcpSessions.connect = coordinate(repos.mcpSessions.connect.bind(repos.mcpSessions), ([input]) => group(input.groupId, [input.memberId]));
  repos.mcpSessions.heartbeat = coordinate(repos.mcpSessions.heartbeat.bind(repos.mcpSessions), ([id]) => session(id));
  repos.mcpSessions.disconnect = coordinate(repos.mcpSessions.disconnect.bind(repos.mcpSessions), ([id]) => session(id));
  repos.mcpSessions.delete = coordinate(repos.mcpSessions.delete.bind(repos.mcpSessions), ([id]) => session(id));
  repos.mcpSessions.markAllStale = coordinate(repos.mcpSessions.markAllStale.bind(repos.mcpSessions), async () => {
    const before = await ctx.query<{ project_id: string }>("SELECT DISTINCT project_id FROM mcp_sessions WHERE state = 'connected' ORDER BY project_id LIMIT 2049");
    return { projectIds: ids(before.map(s => s.project_id)), discover: async tx => {
      const rows = await tx.query<{ project_id: string; member_id: string; group_id: string }>("SELECT project_id, member_id, group_id FROM mcp_sessions WHERE state = 'connected' ORDER BY id LIMIT 2049");
      if (rows.some(s => !before.some(p => p.project_id === s.project_id)) || rows.length > 2048) throw new RepositoryError('mutation_scope_changed', '活跃会话项目范围已变化，请重试。');
      return { memberIds: ids(rows.map(r => r.member_id)), groupIds: ids(rows.map(r => r.group_id)), runtimeIds: [] };
    } };
  });

  repos.org.createNode = coordinate(repos.org.createNode.bind(repos.org), async ([input]) => {
    if (!await ctx.one('SELECT id FROM projects WHERE id = ?', [input.projectId])) throw new InvalidReferenceError('岗位所属项目不存在。');
    return projectPlan(input.projectId);
  });
  repos.org.updateNode = coordinate(repos.org.updateNode.bind(repos.org), async ([id]) => org(await requireProjectOf(ctx, 'org_nodes', id), id));
  repos.org.deleteNode = coordinate(repos.org.deleteNode.bind(repos.org), async ([id]) => org(await requireProjectOf(ctx, 'org_nodes', id), id));
  repos.org.assignNode = coordinate(repos.org.assignNode.bind(repos.org), async ([memberId, nodeId]) => org(await requireProjectOf(ctx, 'members', memberId), nodeId ?? undefined, memberId));
  repos.org.autoPlaceMember = coordinate(repos.org.autoPlaceMember.bind(repos.org), ([projectId, memberId]) => org(projectId, undefined, memberId));
  repos.org.restoreRow = coordinate(repos.org.restoreRow.bind(repos.org), ([node]) => projectPlan(node.projectId));
  return repos;
}

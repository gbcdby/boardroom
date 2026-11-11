import type { DbDriver, DbRow } from "./driver.ts";
import type { RepoCtx } from "./repositories.ts";
import { RepositoryError } from "./errors.ts";
import { observeSql, repositorySqlObserver } from "./sql-observer.ts";

export interface MutationDiscovery {
  memberIds: readonly string[];
  newMemberIds?: readonly string[];
  groupIds: readonly string[];
  runtimeIds: readonly string[];
}
export type MutationDiscover = (tx: RepoCtx) => Promise<MutationDiscovery>;
export interface MutationLockPlan { projectIds: readonly string[]; discover: MutationDiscover }
export interface MutationScope {
  readonly projectIds: readonly string[];
  readonly memberIds: readonly string[];
  /** 首个项目锁已取得时的单调时钟值，供补偿预算复用。 */
  readonly startedAt: number;
  assertCovers(projectIds: readonly string[], memberIds: readonly string[]): void;
}
export interface MutationScopeCoordinator {
  run<T>(plan: MutationLockPlan, body: (scope: MutationScope) => Promise<T>): Promise<T>;
  current(): MutationScope | null;
}

type HeldScope = MutationScope & { groupIds: readonly string[]; runtimeIds: readonly string[] };
const stateKey = Symbol("boardroom.mutation-scope");
const coordinators = new WeakMap<DbDriver, MutationScopeCoordinator>();
function changed(message: string): never { throw new RepositoryError("mutation_scope_changed", message); }
function ids(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 2048 || values.some(id => typeof id !== "string" || !id.trim())) changed("变更范围无效或超过有界计划容量。");
  return [...new Set(values)].sort();
}
function subset(wanted: readonly string[], held: readonly string[]): boolean { return wanted.every(id => held.includes(id)); }

/** 唯一 coordinator 按 driver 缓存，锁状态保存在 driver 的物理事务上下文中。 */
export function getMutationScopeCoordinator(db: DbDriver): MutationScopeCoordinator {
  const existing = coordinators.get(db); if (existing) return existing;
  const raw: RepoCtx = {
    query: <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => observeSql(sql, "query", () => db.query<T>(sql, params)),
    one: async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined> => (await observeSql(sql, "query", () => db.query<T>(sql, params)))[0],
    exec: (sql, params) => observeSql(sql, "exec", () => db.exec(sql, params)),
    withTransaction: body => db.transaction(async () => body()),
  };
  const read = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE|CALL|EXECUTE)\b/i.test(sql)) changed("discover 只允许只读查询，不能预先写入或加下层写锁。");
    return raw.query<T>(sql, params);
  };
  const readonlyContext: RepoCtx = { query: read, one: async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined> => (await read<T>(sql, params))[0],
    exec: async () => changed("discover 不允许执行业务写入。"), withTransaction: async () => changed("discover 不允许另开业务事务。") };
  const coordinator: MutationScopeCoordinator = {
    current() { return (db.currentTransactionContext()?.values.get(stateKey) as HeldScope | undefined) ?? null; },
    async run(plan, body) {
      const projectIds = ids(plan.projectIds);
      return db.transaction(async () => {
        const context = db.currentTransactionContext(); if (!context) changed("变更边界缺少物理事务。");
        const held = context.values.get(stateKey) as HeldScope | undefined;
        if (!held && db.kind === "postgres" && repositorySqlObserver()?.bounded) {
          await raw.exec("SET LOCAL lock_timeout = '200ms'");
          await raw.exec("SET LOCAL statement_timeout = '200ms'");
        }
        if (held && !subset(projectIds, held.projectIds)) changed("嵌套变更不能扩大项目范围；请刷新后重试。");
        let startedAt = held?.startedAt ?? performance.now();
        if (!held) {
          for (const [index, projectId] of projectIds.entries()) {
            if (!await raw.exec("UPDATE projects SET updated_at = updated_at WHERE id = ?", [projectId])) changed("项目已删除或变更范围已改变。");
            if (index === 0) startedAt = performance.now();
          }
        }
        const discovery = await plan.discover(readonlyContext);
        const oldMemberIds = ids(discovery.memberIds), newMemberIds = ids(discovery.newMemberIds ?? []);
        const memberIds = ids([...oldMemberIds, ...newMemberIds]);
        const groupIds = ids(discovery.groupIds), runtimeIds = ids(discovery.runtimeIds);
        if (oldMemberIds.some(id => newMemberIds.includes(id))) changed("成员不能同时声明为已存在和新建。");
        if (held) {
          if (!subset(memberIds, held.memberIds) || !subset(groupIds, held.groupIds) || !subset(runtimeIds, held.runtimeIds)) changed("嵌套变更不能追加成员、群组或运行时锁；请刷新后重试。");
          return body(held);
        }
        for (const memberId of memberIds) {
          if (newMemberIds.includes(memberId)) {
            if (await raw.one("SELECT id FROM members WHERE id = ?", [memberId])) changed("预分配的新成员 ID 已存在。");
            continue;
          }
          const member = await raw.one<{ project_id: string }>("SELECT project_id FROM members WHERE id = ?", [memberId]);
          if (!member || !projectIds.includes(member.project_id)) changed("成员不存在或已超出锁定项目。");
          if (!await raw.exec("UPDATE members SET updated_at = updated_at WHERE id = ? AND project_id = ?", [memberId, member.project_id])) changed("成员范围已改变。");
        }
        for (const groupId of groupIds) {
          const group = await raw.one<{ project_id: string }>("SELECT project_id FROM groups WHERE id = ?", [groupId]);
          if (!group || !projectIds.includes(group.project_id)) changed("群组不存在或已超出锁定项目。");
          await raw.exec("UPDATE groups SET updated_at = updated_at WHERE id = ?", [groupId]);
        }
        for (const runtimeId of runtimeIds) {
          if (!await raw.exec("UPDATE agent_runtimes SET updated_at = updated_at WHERE id = ?", [runtimeId])) changed("运行时已删除或范围已改变。");
        }
        const scope: HeldScope = { projectIds, memberIds, groupIds, runtimeIds, startedAt,
          assertCovers(projects, members) { if (!subset(ids(projects), projectIds) || !subset(ids(members), memberIds)) changed("业务触及未预先锁定的项目或成员。"); } };
        context.values.set(stateKey, scope);
        try {
          const result = await body(scope);
          for (const memberId of newMemberIds) {
            const member = await raw.one<{ project_id: string }>("SELECT project_id FROM members WHERE id = ?", [memberId]);
            if (!member || !projectIds.includes(member.project_id)) changed("预分配成员未在同一锁定项目中建立。");
          }
          return result;
        } catch (error) { context.values.delete(stateKey); throw error; }
      });
    },
  };
  coordinators.set(db, coordinator); return coordinator;
}

import type { RepoCtx } from "./db/repositories.ts";
import { newId } from "./db/ids.ts";
import type { Actor } from "./authz/authorize.ts";
import type { OrgChange, OrgChangeAction } from "./org-change-hook.ts";
import { RepositoryError } from "./db/errors.ts";

/**
 * T5（#52）最小审计：单表 append-only 审计日志 + 统一写入/查看/撤销所需的核心形状。
 *
 * 设计依据：spec #45 §6.7 / §8.2（AUDIT-01/02、AC-PROJ-AUDIT-01）与决策票 #30 的
 * Resolution。「最小」＝复用普通表、不引入审计子系统；记录关键操作的
 * actor / action / target(scope) / timestamp，外加足以撤销的 before/after 最小全量快照。
 *
 * 本模块是纯数据 + 持久化 + 映射：不读 org_nodes/members 业务表、不实现反向业务写
 * （补偿事务在 api.ts 的撤销入口里用 T2/T3 既有仓储方法完成），因此不与 repositories
 * 形成运行时循环依赖。
 *
 * #61：持久化经 {@link RepoCtx}（基于 DbDriver 抽象）访问；SQLite 与 PostgreSQL 双方言
 * 通过统一的 `?` 占位符切换，保持阶段 1 默认行为。
 */

// ---------------------------------------------------------------------------
// 事件字典（#30 §2：常量落代码，与 PROJECT_SCOPED_TABLES 注册表同处维护）
// ---------------------------------------------------------------------------

/** `资源.动作` 命名的事件字典；新增事件＝字典条目 + 覆盖测试（code review 检查项）。 */
export const AUDIT_ACTIONS = {
  member_add: "member.add",
  member_remove: "member.remove",
  member_pause: "member.pause",
  member_resume: "member.resume",
  member_status_change: "member.status_change",
  member_revoke: "member.revoke",
  org_node_create: "org.node_create",
  org_node_update: "org.node_update",
  org_node_delete: "org.node_delete",
  org_assign: "org.assign",
  org_auto_place: "org.auto_place",
  org_revoke: "org.revoke",
  project_archive: "project.archive",
  project_restore: "project.restore",
  project_delete: "project.delete",
  project_workspace_update: "project.workspace_update",
  group_archive: "group.archive",
  group_restore: "group.restore",
  group_delete: "group.delete",
  task_created: "task.created",
  task_updated: "task.updated",
  task_transitioned: "task.transitioned",
  task_commented: "task.commented",
  task_message_linked: "task.message_linked",
  task_review_started: "task.review_started",
  task_review_failed: "task.review_failed",
  task_review_begun: "task.review_begun",
  task_review_reported: "task.review_reported",
  task_review_decided: "task.review_decided",
  task_settings_updated: "task.settings_updated",
  memory_updated: "memory.updated",
  memory_summary_requested: "memory.summary_requested",
  memory_summary_begun: "memory.summary_begun",
  memory_summary_completed: "memory.summary_completed",
  memory_summary_failed: "memory.summary_failed",
  memory_summary_conflicted: "memory.summary_conflicted",
  memory_summary_cancelled: "memory.summary_cancelled",
  role_template_create: "role_template.create",
  role_template_copy: "role_template.copy",
  role_template_update: "role_template.update",
  role_template_archive: "role_template.archive",
  role_template_restore: "role_template.restore",
  role_template_delete: "role_template.delete",
  agent_rename: "agent.rename",
  agent_alias_add: "agent.alias_add",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * 可撤销操作集（#30 §3）：成员生命周期 + 组织树/岗位指派的变更，含两类撤销事件本身
 * （「撤销一个撤销」＝重放原变更，链式回滚）。其余事件（归档/恢复＝状态本身可逆、
 * 永久删除＝不可逆）一律明确拒绝撤销。
 */
export const REVERSIBLE_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.member_add,
  AUDIT_ACTIONS.member_remove,
  AUDIT_ACTIONS.member_pause,
  AUDIT_ACTIONS.member_resume,
  AUDIT_ACTIONS.member_status_change,
  AUDIT_ACTIONS.member_revoke,
  AUDIT_ACTIONS.org_node_create,
  AUDIT_ACTIONS.org_node_update,
  AUDIT_ACTIONS.org_node_delete,
  AUDIT_ACTIONS.org_assign,
  AUDIT_ACTIONS.org_auto_place,
  AUDIT_ACTIONS.org_revoke,
];

/** 永久删除事件（不可逆，撤销必须明确拒绝）。 */
export const PERMANENT_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.project_delete,
  AUDIT_ACTIONS.group_delete,
];

/** 归档/恢复：状态本身可逆，不提供「撤销」入口（用正向操作复原）。 */
export const STATE_REVERSIBLE_ACTIONS: readonly AuditAction[] = [
  AUDIT_ACTIONS.project_archive,
  AUDIT_ACTIONS.project_restore,
  AUDIT_ACTIONS.group_archive,
  AUDIT_ACTIONS.group_restore,
];

const REVERSIBLE_SET: ReadonlySet<string> = new Set(REVERSIBLE_ACTIONS as readonly string[]);

export function isReversible(action: string): boolean {
  return REVERSIBLE_SET.has(action);
}

export function isPermanent(action: string): boolean {
  return (PERMANENT_ACTIONS as readonly string[]).includes(action);
}

export function isStateReversible(action: string): boolean {
  return (STATE_REVERSIBLE_ACTIONS as readonly string[]).includes(action);
}

/** 撤销被拒绝时的稳定原因码（#30 §4；前端据此置灰并说明）。 */
export function revokeUnavailableReason(action: string): string | null {
  if (isPermanent(action)) return "permanent_delete";
  if (isStateReversible(action)) return "forward_reversible";
  if (!isReversible(action)) return "action_not_revocable";
  return null;
}

/** 字段超长被截断（#30 §1）；截断事件失去完整快照，不可可靠撤销。 */
export function isTruncated(row: { before: string | null; after: string | null }): boolean {
  return (
    (row.before !== null && row.before.includes('"truncated":true')) ||
    (row.after !== null && row.after.includes('"truncated":true'))
  );
}

// ---------------------------------------------------------------------------
// 形状
// ---------------------------------------------------------------------------

export type AuditTargetKind = "member" | "node" | "role" | "capability" | "group" | "project" | "task" | "memory" | "role_template" | "agent";

/** 全局目录使用 user/NULL；project 审计的历史调用形状与查询边界保持兼容。 */
export type AuditContext = { readonly scope: "user"; readonly projectId: null }
  | { readonly scope: "project"; readonly projectId: string };

/** 审计主体快照（不依赖 JOIN；人的变更一律记录，agent 记其成员 id）。 */
export interface AuditActor {
  readonly kind: "human" | "agent" | "system";
  readonly name: string;
  readonly memberId?: string | null;
}

/** F2 守卫 Actor → 审计主体快照。V1 无认证：人=owner 的兼容映射保持阶段 1 行为。 */
export function auditActorFrom(actor: Actor): AuditActor {
  if (actor.kind === "human") return { kind: "human", name: "人（owner）", memberId: null };
  return { kind: "agent", name: `成员 ${actor.actorId}`, memberId: actor.actorId };
}

/** 写入一条审计事件的入参；before/after 用 JSON 可序列化值，null 表示「事前/事后不存在」。 */
export interface AuditEntry {
  readonly scope?: "project";
  readonly projectId: string;
  readonly actor: AuditActor;
  readonly action: AuditAction | string;
  readonly targetKind: AuditTargetKind;
  readonly targetId: string;
  readonly targetName: string;
  /** 未传 = 不记录快照（SQL NULL）；传 null = 记录「不存在」（JSON "null"）。 */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly changed?: unknown;
  readonly detail?: unknown;
  readonly reversedByAuditId?: string | null;
}

export interface UserAuditEntry extends Omit<AuditEntry, "scope" | "projectId"> {
  readonly scope: "user";
  readonly projectId: null;
}

/** 插入行（reversed_at 由 markReversed 回写，插入时恒为 null）。 */
export interface NewAuditRow {
  readonly id: string;
  readonly projectId: string;
  readonly actorKind: "human" | "agent" | "system";
  readonly actorMemberId: string | null;
  readonly actorName: string;
  readonly action: string;
  readonly targetKind: AuditTargetKind;
  readonly targetId: string;
  readonly targetName: string;
  readonly changed: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly detail: string | null;
  readonly reversedByAuditId: string | null;
  readonly createdAt: string;
}

export interface AuditRow extends NewAuditRow {
  readonly reversedAt: string | null;
}

export type NewUserAuditRow = Omit<NewAuditRow, "projectId"> & { readonly scope: "user"; readonly projectId: null };
export type UserAuditRow = NewUserAuditRow & { readonly reversedAt: string | null };

type AuditRowDb = {
  id: string;
  project_id: string;
  actor_kind: "human" | "agent" | "system";
  actor_member_id: string | null;
  actor_name: string;
  action: string;
  target_kind: AuditTargetKind;
  target_id: string;
  target_name: string;
  changed: string | null;
  before: string | null;
  after: string | null;
  detail: string | null;
  reversed_at: string | null;
  reversed_by_audit_id: string | null;
  created_at: string;
};

function toAuditRow<T extends string | null>(row: Omit<AuditRowDb, "project_id"> & { project_id: T }): Omit<AuditRow, "projectId"> & { projectId: T } {
  return {
    id: row.id,
    projectId: row.project_id,
    actorKind: row.actor_kind,
    actorMemberId: row.actor_member_id,
    actorName: row.actor_name,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetName: row.target_name,
    changed: row.changed,
    before: row.before,
    after: row.after,
    detail: row.detail,
    reversedByAuditId: row.reversed_by_audit_id,
    reversedAt: row.reversed_at,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 序列化与字段级 diff
// ---------------------------------------------------------------------------

/** 单行序列化上限（#30 §1）：超出则截断并写 detail.truncated，截断事件不可撤销。 */
const MAX_FIELD_BYTES = 32 * 1024;

function serialize(value: unknown): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_FIELD_BYTES) {
    return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(json, "utf8") });
  }
  return json;
}

/** v2 可逆事件绝不截断；正向服务在首次业务写入前也调用同一检查。 */
export function assertCompleteAuditFields(...values: unknown[]): void {
  for (const value of values) {
    if (value === undefined) continue;
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_FIELD_BYTES) {
      throw new RepositoryError("audit_snapshot_too_large", "完整审计快照超过单字段 32 KiB，操作未提交；请缩小本次变更范围。");
    }
  }
}

/** 字段级 diff：{"field":{"from":…,"to":…}}，忽略时间戳噪声列。 */
function diffChanged(before: unknown, after: unknown): unknown {
  if (
    typeof before !== "object" || before === null || Array.isArray(before) ||
    typeof after !== "object" || after === null || Array.isArray(after)
  ) {
    return undefined;
  }
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of keys) {
    if (key.endsWith("At")) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed[key] = { from: a[key], to: b[key] };
  }
  return Object.keys(changed).length > 0 ? changed : undefined;
}

/** 解析 JSON 列；SQL NULL 返回 null。 */
export function parseJsonColumn(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repository（append-only + 两列回写）
// ---------------------------------------------------------------------------

export interface AuditFilter {
  readonly action?: string;
  readonly targetKind?: AuditTargetKind;
  readonly targetId?: string;
  /** 游标：只取 id 小于该值的行（id 时间有序）。 */
  readonly beforeId?: string;
  readonly limit?: number;
}

export interface AuditRepository {
  append(row: NewAuditRow): Promise<AuditRow>;
  appendUser(row: NewUserAuditRow): Promise<UserAuditRow>;
  getUser(id: string): Promise<UserAuditRow | null>;
  listUser(filter?: AuditFilter): Promise<UserAuditRow[]>;
  get(projectId: string, id: string): Promise<AuditRow | null>;
  list(projectId: string, filter?: AuditFilter): Promise<AuditRow[]>;
  /** 仅首次回写原事件，竞争失败返回 false；调用者须回滚整个补偿事务。 */
  markReversed(projectId: string, id: string, reversedByAuditId: string, reversedAt: string): Promise<boolean>;
}

/** 创建审计仓储；与其余仓储共享同一个 DbDriver 连接。 */
export function createAuditRepository(ctx: RepoCtx): AuditRepository {
  const insertSql = `INSERT INTO audit_log
       (id, project_id, actor_kind, actor_member_id, actor_name, action,
        target_kind, target_id, target_name, changed, before, after, detail,
        reversed_at, reversed_by_audit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`;
  const getOneSql = "SELECT * FROM audit_log WHERE project_id = ? AND id = ?";
  const markReversedSql = "UPDATE audit_log SET reversed_at = ?, reversed_by_audit_id = ? WHERE project_id = ? AND id = ? AND reversed_at IS NULL";

  return {
    async append(row) {
      if (typeof row.projectId !== "string" || !row.projectId) throw new RepositoryError("invalid_argument", "audit_project_scope_invalid");
      await ctx.exec(insertSql, [
        row.id, row.projectId, row.actorKind, row.actorMemberId, row.actorName, row.action,
        row.targetKind, row.targetId, row.targetName, row.changed, row.before, row.after,
        row.detail, row.reversedByAuditId, row.createdAt,
      ]);
      return { ...row, reversedAt: null };
    },
    async appendUser(row) {
      if (row.scope !== "user" || row.projectId !== null) throw new RepositoryError("invalid_argument", "audit_user_scope_invalid");
      await ctx.exec(`INSERT INTO audit_log (id, scope, project_id, actor_kind, actor_member_id, actor_name, action,
        target_kind, target_id, target_name, changed, before, after, detail, reversed_at, reversed_by_audit_id, created_at)
        VALUES (?, 'user', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [row.id, row.actorKind, row.actorMemberId, row.actorName, row.action, row.targetKind, row.targetId, row.targetName,
        row.changed, row.before, row.after, row.detail, row.reversedByAuditId, row.createdAt]);
      return { ...row, reversedAt: null };
    },
    async getUser(id) {
      const row = await ctx.one<Omit<AuditRowDb, "project_id"> & { project_id: null }>(
        "SELECT * FROM audit_log WHERE scope = 'user' AND project_id IS NULL AND id = ?", [id]);
      return row ? { ...toAuditRow(row), scope: "user" } : null;
    },
    async listUser(filter = {}) {
      const clauses = ["scope = 'user'", "project_id IS NULL"], params: unknown[] = [];
      if (filter.action !== undefined) { clauses.push("action = ?"); params.push(filter.action); }
      if (filter.targetKind !== undefined) { clauses.push("target_kind = ?"); params.push(filter.targetKind); }
      if (filter.targetId !== undefined) { clauses.push("target_id = ?"); params.push(filter.targetId); }
      if (filter.beforeId !== undefined) { clauses.push("id < ?"); params.push(filter.beforeId); }
      params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
      const rows = await ctx.query<Omit<AuditRowDb, "project_id"> & { project_id: null }>(
        `SELECT * FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`, params);
      return rows.map(row => ({ ...toAuditRow(row), scope: "user" as const }));
    },
    async get(projectId, id) {
      const row = await ctx.one<AuditRowDb>(getOneSql, [projectId, id]);
      return row ? toAuditRow(row) : null;
    },
    async list(projectId, filter = {}) {
      const clauses = ["project_id = ?"];
      const params: unknown[] = [projectId];
      if (filter.action !== undefined) { clauses.push("action = ?"); params.push(filter.action); }
      if (filter.targetKind !== undefined) { clauses.push("target_kind = ?"); params.push(filter.targetKind); }
      if (filter.targetId !== undefined) { clauses.push("target_id = ?"); params.push(filter.targetId); }
      if (filter.beforeId !== undefined) { clauses.push("id < ?"); params.push(filter.beforeId); }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      params.push(limit);
      const sql = `SELECT * FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`;
      return (await ctx.query<AuditRowDb>(sql, params)).map(toAuditRow);
    },
    async markReversed(projectId, id, reversedByAuditId, reversedAt) {
      return (await ctx.exec(markReversedSql, [reversedAt, reversedByAuditId, projectId, id])) === 1;
    },
  };
}

/** 写入一条审计事件（供 api.ts 直接埋点与 recorder 复用）。 */
export function appendAuditEntry(repo: AuditRepository, entry: AuditEntry, opts?: { readonly id?: string; readonly createdAt?: string }): Promise<AuditRow>;
export function appendAuditEntry(repo: AuditRepository, entry: UserAuditEntry, opts?: { readonly id?: string; readonly createdAt?: string }): Promise<UserAuditRow>;
export async function appendAuditEntry(
  repo: AuditRepository,
  entry: AuditEntry | UserAuditEntry,
  opts: { readonly id?: string; readonly createdAt?: string } = {},
): Promise<AuditRow | UserAuditRow> {
  if (entry.scope === "user" ? entry.projectId !== null : typeof entry.projectId !== "string" || !entry.projectId) {
    throw new RepositoryError("invalid_argument", "audit_context_invalid");
  }
  if (typeof entry.detail === "object" && entry.detail !== null &&
      (entry.detail as { reversal?: { version?: unknown } }).reversal?.version === 2) {
    assertCompleteAuditFields(entry.before, entry.after, entry.detail);
  }
  const beforeJson = serialize(entry.before);
  const afterJson = serialize(entry.after);
  const changed = entry.changed !== undefined ? entry.changed : diffChanged(entry.before, entry.after);
  const truncated =
    (beforeJson !== null && beforeJson.includes('"truncated":true')) ||
    (afterJson !== null && afterJson.includes('"truncated":true'));
  const detailObj =
    typeof entry.detail === "object" && entry.detail !== null && !Array.isArray(entry.detail)
      ? { ...(entry.detail as Record<string, unknown>), ...(truncated ? { truncated: true } : {}) }
      : { ...(entry.detail === undefined ? {} : { value: entry.detail }), ...(truncated ? { truncated: true } : {}) };

  const row: Omit<NewAuditRow, "projectId"> = {
    id: opts.id ?? newId(),
    actorKind: entry.actor.kind,
    actorMemberId: entry.actor.memberId ?? null,
    actorName: entry.actor.name,
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    targetName: entry.targetName,
    changed: serialize(changed),
    before: beforeJson,
    after: afterJson,
    detail: serialize(Object.keys(detailObj).length > 0 ? detailObj : undefined),
    reversedByAuditId: entry.reversedByAuditId ?? null,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
  return entry.scope === "user" ? repo.appendUser({ ...row, scope: "user", projectId: null }) : repo.append({ ...row, projectId: entry.projectId });
}

// ---------------------------------------------------------------------------
// OrgChangeRecorder 适配器（T2/T3 钩子 → 真实审计写入）
// ---------------------------------------------------------------------------

/** 钩子 action → 审计 action / target 的映射表；保持 OrgChangeRecorder 接口不变。 */
const HOOK_MAP: Readonly<
  Record<OrgChangeAction, { action: AuditAction; targetKind: AuditTargetKind; idOf: (c: OrgChange) => string }>
> = {
  "node.create": { action: AUDIT_ACTIONS.org_node_create, targetKind: "node", idOf: (c) => c.nodeId ?? "" },
  "node.update": { action: AUDIT_ACTIONS.org_node_update, targetKind: "node", idOf: (c) => c.nodeId ?? "" },
  "node.delete": { action: AUDIT_ACTIONS.org_node_delete, targetKind: "node", idOf: (c) => c.nodeId ?? "" },
  "node.assign": { action: AUDIT_ACTIONS.org_assign, targetKind: "member", idOf: (c) => c.memberId ?? "" },
  "member.auto_place": { action: AUDIT_ACTIONS.org_auto_place, targetKind: "node", idOf: (c) => c.nodeId ?? "" },
  "member.disable": { action: AUDIT_ACTIONS.member_pause, targetKind: "member", idOf: (c) => c.memberId ?? "" },
  "member.enable": { action: AUDIT_ACTIONS.member_resume, targetKind: "member", idOf: (c) => c.memberId ?? "" },
  "member.status_change": { action: AUDIT_ACTIONS.member_status_change, targetKind: "member", idOf: (c) => c.memberId ?? "" },
};

/**
 * 把 T2/T3 预留的 noop 钩子换成真实 recorder：经 `StartServerOptions.orgChangeRecorder`
 * 默认注入即把组织/成员变更写入 audit_log，无需改动 T2/T3 的守卫与 repository。
 */
export function createAuditRecorder(repo: AuditRepository): { record(change: OrgChange): Promise<void> } {
  return {
    async record(change: OrgChange): Promise<void> {
      const mapped = HOOK_MAP[change.action];
      if (!mapped) return;
      // auto_place 在无组织树 / 成员已落位时是 no-op（不建新岗位），不产生审计行。
      if (change.action === "member.auto_place" && !mapped.idOf(change)) return;
      const actor: AuditActor = change.actor
        ? { kind: change.actor.kind, name: change.actor.name, ...(change.actor.memberId ? { memberId: change.actor.memberId } : {}) }
        : { kind: "system", name: "系统" };
      await appendAuditEntry(repo, {
        projectId: change.projectId,
        actor,
        action: mapped.action,
        targetKind: mapped.targetKind,
        targetId: mapped.idOf(change),
        targetName: change.targetName ?? mapped.idOf(change),
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
        ...(change.changed !== undefined ? { changed: change.changed } : {}),
        detail: change.detail,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 视图（HTTP 响应 / WebUI 共用）
// ---------------------------------------------------------------------------

export function auditView(row: AuditRow | UserAuditRow) {
  return {
    id: row.id,
    scope: row.projectId === null ? "user" : "project",
    projectId: row.projectId,
    actorKind: row.actorKind,
    actorName: row.actorName,
    actorMemberId: row.actorMemberId,
    action: row.action,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetName: row.targetName,
    changed: parseJsonColumn(row.changed),
    before: parseJsonColumn(row.before),
    after: parseJsonColumn(row.after),
    detail: parseJsonColumn(row.detail),
    reversedAt: row.reversedAt,
    reversedByAuditId: row.reversedByAuditId,
    createdAt: row.createdAt,
    reversible: isReversible(row.action) && !isTruncated(row) && row.before !== null,
  };
}

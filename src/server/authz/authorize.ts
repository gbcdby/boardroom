/**
 * F2（#47）统一权限守卫 `authorize`。
 *
 * 职责：把「谁能对什么做什么」集中成一份**静态权限矩阵 + 边界判定**，供 HTTP / MCP /
 * WebSocket 三类入口在各自调用点复用（GUARD-01、AC-PERM-01、AC-PROJ-GUARD-01）。
 *
 * 设计边界（与票范围一致）：
 * - **纯函数**：不读数据库、不依赖连接或运行时对象。`Actor` / `GuardScope` 都是调用方
 *   注入的纯数据；`org_nodes` / `members` 业务表属 T2（#49），本票只约定对接形状
 *   （`nodeId` / `subtreeNodeIds` / `reach` + 群组参与者节点），后续票按此接 DB。
 * - 角色是**静态枚举**（spec #45 §3 / 决策票 #25），不引入动态 RBAC；岗位＝角色在某个
 *   组织节点上的实例，由 `reach` + `subtreeNodeIds` 表达其管辖范围。
 * - **fail-closed**：未知角色、未知能力点、边界数据缺失一律拒绝，不默认放行。
 * - 阶段 1 单用户、无认证：入口默认注入「人＝owner、reach=project」的 Actor，
 *   因此既有行为不变（票面硬约束）；agent 侧角色矩阵由本模块的静态数据表达。
 */

/** 静态角色枚举（spec #45 §3；决策票 #25）。 */
export const AUTHZ_ROLES = ["owner", "top_manager", "sub_manager", "member"] as const;
export type AuthzRole = (typeof AUTHZ_ROLES)[number];

/**
 * 管辖范围（岗位实例的作用域）：
 * - `project`：全项目（人 / 顶层 manager）；
 * - `subtree`：仅本岗位子树（下级 manager，见 ORG-01/ORG-05）；
 * - `own`：仅自己（普通成员，见 ORG-06）。
 */
export const AUTHZ_REACHES = ["project", "subtree", "own"] as const;
export type ActorReach = (typeof AUTHZ_REACHES)[number];

/** 角色默认管辖范围；T2 可用 `Actor.reach` 按岗位数据覆盖。 */
export const ROLE_REACH: Readonly<Record<AuthzRole, ActorReach>> = {
  owner: "project",
  top_manager: "project",
  sub_manager: "subtree",
  member: "own",
};

/**
 * 守卫主体：某项目内的一个岗位持有者（人或 agent）。
 * 纯数据；T2（#49）从 `members` + `org_nodes` 组装后注入。
 */
export interface Actor {
  /** 主体标识：阶段 2 为 `members.id`；阶段 1 的人用稳定的本地 human id。 */
  readonly actorId: string;
  readonly kind: "human" | "agent";
  readonly role: AuthzRole;
  /** 本主体所属项目：跨项目一律拒绝（NFR-PROJ-01 隔离）。 */
  readonly projectId: string;
  /** 岗位所在的组织节点（`org_nodes.id`）；owner / 未落位时为 null。 */
  readonly nodeId: string | null;
  /**
   * 该岗位可管辖的组织节点集合（**含自身节点**）。
   * `reach === "subtree"` 时必须有值；缺失即无法判定子树边界 → 拒绝。
   * T2 由 org_nodes 递归 CTE 填充；本票由注入的静态数据表达。
   */
  readonly subtreeNodeIds: readonly string[] | null;
  /** 省略时按角色的默认管辖范围（{@link ROLE_REACH}）。 */
  readonly reach?: ActorReach;
}

/** 被请求的目标资源。相关字段缺失即无法判定该条边界 → 拒绝（不默认放行）。 */
export interface GuardScope {
  readonly projectId?: string;
  /** 目标资源所属组织节点（org / member 管理类动作的子树判定输入）。 */
  readonly nodeId?: string | null;
  /** 目标动作的归属成员（self 类动作：状态上报、自己的任务/记忆）。 */
  readonly memberId?: string;
  /** 目标群组。 */
  readonly groupId?: string;
  /** 群组成员（= `group_participants` 的 memberId 列表）。 */
  readonly groupMemberIds?: readonly string[];
  /**
   * 群组成员各自的组织节点，顺序与 `groupMemberIds` 对齐；未落位的成员用 null。
   * 子树可见性/建群范围判定用（ORG-03 / #32）。
   */
  readonly groupMemberNodeIds?: readonly (string | null)[];
}

/**
 * 能力点（capabilities）：权限矩阵的授权单位（spec #45 §4）。
 * 名称是稳定契约：入口层与后续票按名引用，新增能力点只改本文件的两张表。
 */
export type Capability =
  | "project:create"
  | "project:archive"
  | "project:purge"
  | "overview:view"
  | "org:manage"
  | "member:manage"
  | "group:create"
  | "group:archive"
  | "group:purge"
  | "group:view"
  | "group:view_subtree"
  | "group:post"
  | "message:ack"
  | "status:report_own"
  | "task:update_own"
  | "memory:write_own"
  | "interrupt:self"
  | "session:heartbeat";

/**
 * 能力点的边界类型：决定放行前还要校验哪一层范围。
 * - `project`：同项目即可（项目级动作，具体谁能做由矩阵决定）；
 * - `subtree`：目标资源必须落在 actor 管辖范围内（全项目范围视为满足）；
 * - `participation`：actor 必须是目标群组参与者（写消息类）；
 * - `visibility`：群组可见性（参与 ∪ 全项目 ∪ 子树只读，见 ORG-03）；
 * - `self`：只能作用于自己（状态上报、自己的任务/记忆、自己的会话）。
 */
type BoundaryKind = "project" | "subtree" | "participation" | "visibility" | "self";

const CAPABILITY_BOUNDARY: Readonly<Record<Capability, BoundaryKind>> = {
  "project:create": "project",
  "project:archive": "project",
  "project:purge": "project",
  "overview:view": "project",
  "org:manage": "subtree",
  "member:manage": "subtree",
  "group:create": "subtree",
  "group:archive": "subtree",
  "group:purge": "project",
  "group:view": "visibility",
  "group:view_subtree": "visibility",
  "group:post": "participation",
  "message:ack": "participation",
  "status:report_own": "self",
  "task:update_own": "self",
  "memory:write_own": "self",
  "interrupt:self": "self",
  "session:heartbeat": "self",
};

/**
 * 静态权限矩阵：角色 → 能力点集合（spec #45 §3 的角色描述逐条落在这里）。
 *
 * - owner（人）：创建项目、归档、永久删除、撤销/审计、组织与成员管理、全部群组；
 * - top_manager：管理全项目——组织、成员、群组（含只读全部群组）；不能永久删除（LIFE-ARC-01）；
 * - sub_manager：同上但范围限子树（ORG-03/ORG-05），并持有 `group:view_subtree`；
 * - member：只在参与的群组发言、只更新自己的状态/任务/记忆（ORG-06）。
 */
export const ROLE_CAPABILITIES: Readonly<Record<AuthzRole, ReadonlySet<Capability>>> = {
  owner: new Set<Capability>([
    "project:create",
    "project:archive",
    "project:purge",
    "overview:view",
    "org:manage",
    "member:manage",
    "group:create",
    "group:archive",
    "group:purge",
    "group:view",
    "group:view_subtree",
    "group:post",
    "message:ack",
    "status:report_own",
    "task:update_own",
    "memory:write_own",
    "interrupt:self",
    "session:heartbeat",
  ]),
  top_manager: new Set<Capability>([
    "project:archive",
    "overview:view",
    "org:manage",
    "member:manage",
    "group:create",
    "group:archive",
    "group:view",
    "group:view_subtree",
    "group:post",
    "message:ack",
    "status:report_own",
    "task:update_own",
    "memory:write_own",
    "interrupt:self",
    "session:heartbeat",
  ]),
  sub_manager: new Set<Capability>([
    "org:manage",
    "member:manage",
    "group:create",
    "group:archive",
    "group:view",
    "group:view_subtree",
    "group:post",
    "message:ack",
    "status:report_own",
    "task:update_own",
    "memory:write_own",
    "interrupt:self",
    "session:heartbeat",
  ]),
  member: new Set<Capability>([
    "group:view",
    "group:post",
    "message:ack",
    "status:report_own",
    "task:update_own",
    "memory:write_own",
    "interrupt:self",
    "session:heartbeat",
  ]),
};

/** 稳定拒绝码（决策票 #26 的「拒绝语义」）：入口层据此映射 HTTP 403 / MCP FORBIDDEN。 */
export const DENY_CODES = [
  "forbidden",
  "unknown_action",
  "cross_project",
  "out_of_subtree",
  "not_a_member",
  "not_visible",
  "not_self",
] as const;
export type DenyCode = (typeof DENY_CODES)[number];

/**
 * conn-scoped 查询约束：允许之后，后续查询**只能**在这个范围内取数（#37 强制点）。
 * `null` 表示该维度不限（全项目授权）；数组是白名单，查询层据此加 WHERE。
 */
export interface ConnScope {
  readonly projectId: string;
  /** 允许的组织节点（子树）；null = 全项目。 */
  readonly nodeIds: readonly string[] | null;
  /** 明确允许的群组（请求已点名某群组时）；null = 由可见性规则再筛。 */
  readonly groupIds: readonly string[] | null;
}

/** 守卫判定结果：允许（附查询范围）或拒绝（附稳定拒绝码与原因）。 */
export type AuthorizeDecision =
  | { readonly allowed: true; readonly capability: Capability; readonly conn: ConnScope }
  | {
      readonly allowed: false;
      readonly capability: Capability | null;
      readonly code: DenyCode;
      readonly reason: string;
    };

/**
 * 判定 `actor` 能否对 `scope` 指向的资源执行 `capability`。
 * 纯函数：同样入参永远同样结果；不抛错、不改动入参。
 */
export function authorize(actor: Actor, capability: Capability, scope: GuardScope): AuthorizeDecision {
  if (!isKnownCapability(capability)) {
    return deny("unknown_action", null, `未知能力点：${String(capability)}`);
  }
  if (!actor.projectId || (scope.projectId !== undefined && scope.projectId !== actor.projectId)) {
    return deny("cross_project", capability, "目标资源不在该主体所属项目内。");
  }
  const granted = (AUTHZ_ROLES as readonly string[]).includes(actor.role)
    ? ROLE_CAPABILITIES[actor.role]
    : undefined;
  if (!granted || !granted.has(capability)) {
    return deny("forbidden", capability, `角色 ${String(actor.role)} 没有 ${capability} 能力点。`);
  }

  const reach = actor.reach ?? ROLE_REACH[actor.role];
  const boundary = CAPABILITY_BOUNDARY[capability];
  if (boundary === "subtree") {
    const subtreeCheck = checkSubtree(actor, reach, capability, scope);
    if (subtreeCheck) return subtreeCheck;
  } else if (boundary === "participation") {
    if (!scope.groupMemberIds || !scope.groupMemberIds.includes(actor.actorId)) {
      return deny("not_a_member", capability, `主体 ${actor.actorId} 不是目标群组参与者。`);
    }
  } else if (boundary === "visibility") {
    const visible = checkVisibility(actor, reach, capability, scope);
    if (!visible.allowed) return visible.decision;
  } else if (boundary === "self") {
    if (scope.memberId !== undefined && scope.memberId !== actor.actorId) {
      return deny("not_self", capability, "只能作用于自己的状态、任务与记忆。");
    }
  }

  return { allowed: true, capability, conn: connScopeOf(actor, reach, scope) };
}

/** 供入口层与后续票复用：actor 的 conn 查询范围。 */
export function connScopeOf(actor: Actor, reach: ActorReach = actor.reach ?? ROLE_REACH[actor.role], scope: GuardScope = {}): ConnScope {
  return {
    projectId: actor.projectId,
    nodeIds: reach === "subtree" ? (actor.subtreeNodeIds ?? null) : null,
    groupIds: scope.groupId === undefined ? null : [scope.groupId],
  };
}

// ---------------------------------------------------------------------------
// 边界判定
// ---------------------------------------------------------------------------

/** `subtree` 边界：目标资源必须落在 actor 的管辖范围内。 */
function checkSubtree(
  actor: Actor,
  reach: ActorReach,
  capability: Capability,
  scope: GuardScope,
): AuthorizeDecision | null {
  if (reach === "project") return null;
  const subtree = actor.subtreeNodeIds;
  if (reach !== "subtree" || subtree === null || subtree === undefined) {
    return deny("out_of_subtree", capability, "该岗位没有可判定的子树范围。");
  }
  if (scope.nodeId !== undefined) {
    if (scope.nodeId === null || !subtree.includes(scope.nodeId)) {
      return deny("out_of_subtree", capability, `目标节点 ${String(scope.nodeId)} 不在本岗位子树内。`);
    }
  }
  if (scope.groupMemberIds !== undefined) {
    const nodes = scope.groupMemberNodeIds;
    if (!nodes || nodes.length !== scope.groupMemberIds.length) {
      return deny("out_of_subtree", capability, "缺少参与者的组织节点数据，无法判定子树边界。");
    }
    if (nodes.some((nodeId) => nodeId === null || !subtree.includes(nodeId))) {
      return deny("out_of_subtree", capability, "参与者中有成员不属于本岗位子树。");
    }
  }
  return null;
}

/**
 * 群组可见性（ORG-03 / AC-ORG-07）：
 * - 全项目范围（人 / 顶层 manager）：全部群组；
 * - 任何角色：自己参与的群组；
 * - `group:view_subtree` + 子树范围：参与者**全部**属于该子树的群组（只读；写路径走
 *   `participation` 边界，因此只读可见性不会扩成发言权）。
 */
function checkVisibility(
  actor: Actor,
  reach: ActorReach,
  capability: Capability,
  scope: GuardScope,
): { allowed: true; decision: null } | { allowed: false; decision: AuthorizeDecision } {
  if (reach === "project") return ok();
  if (scope.groupMemberIds?.includes(actor.actorId)) return ok();
  const granted = ROLE_CAPABILITIES[actor.role];
  if (granted.has("group:view_subtree") && reach === "subtree") {
    const subtree = actor.subtreeNodeIds;
    const nodes = scope.groupMemberNodeIds;
    if (subtree && nodes && scope.groupMemberIds && nodes.length === scope.groupMemberIds.length) {
      if (nodes.every((nodeId) => nodeId !== null && subtree.includes(nodeId))) return ok();
    }
  }
  return fail(
    deny("not_visible", capability, "该群组不在主体的可见范围内（未参与、且不属可见子树）。"),
  );
}

function ok(): { allowed: true; decision: null } {
  return { allowed: true, decision: null };
}

function fail(decision: AuthorizeDecision): { allowed: false; decision: AuthorizeDecision } {
  return { allowed: false, decision };
}

function isKnownCapability(capability: Capability): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_BOUNDARY, String(capability));
}

function deny(code: DenyCode, capability: Capability | null, reason: string): AuthorizeDecision {
  return { allowed: false, capability, code, reason };
}

// ---------------------------------------------------------------------------
// 拒绝语义与查询守卫（入口层复用）
// ---------------------------------------------------------------------------

/** 拒绝码 → HTTP 状态（决策票 #26）；MCP 侧统一收敛为 `FORBIDDEN` 错误码。 */
const DENY_STATUS: Readonly<Record<DenyCode, number>> = {
  forbidden: 403,
  cross_project: 403,
  out_of_subtree: 403,
  not_a_member: 403,
  not_visible: 403,
  not_self: 403,
  unknown_action: 400,
};

/** 守卫拒绝：入口层据此产出稳定错误载荷（HTTP 403 / MCP FORBIDDEN）。 */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  readonly status: number;
  readonly code: DenyCode;
  readonly capability: Capability | null;

  constructor(decision: Extract<AuthorizeDecision, { allowed: false }>) {
    super(decision.reason);
    this.code = decision.code;
    this.capability = decision.capability;
    this.status = DENY_STATUS[decision.code];
  }
}

/**
 * 判定并在拒绝时抛 {@link ForbiddenError}：给 HTTP / MCP 调用点做「守卫式」调用。
 * 允许时返回收窄后的判定（含 conn 查询范围）。
 */
export function authorizeOrThrow(
  actor: Actor,
  capability: Capability,
  scope: GuardScope,
): Extract<AuthorizeDecision, { allowed: true }> {
  const decision = authorize(actor, capability, scope);
  if (!decision.allowed) throw new ForbiddenError(decision);
  return decision;
}

/** 群组查询守卫的输入：一个群组在项目内的归属与参与者快照。 */
export interface GuardedGroup {
  readonly id: string;
  readonly projectId: string;
  readonly memberIds: readonly string[];
  /** 参与者各自的组织节点（顺序与 `memberIds` 对齐）；缺字段时子树只读可见性判不出来。 */
  readonly memberNodeIds?: readonly (string | null)[];
}

/** 可见群组：`writable=false` 表示只读可见（能看元数据与历史，不唤醒、不能发言）。 */
export interface VisibleGroup {
  readonly id: string;
  readonly writable: boolean;
}

/**
 * conn-scoped 群组查询守卫：把 `authorize` 的判定套到「列出我看到哪些群组」这类查询上，
 * 后续票（T1/T2/T4/T6）据此收窄 SQL/结果集，不必各自实现权限（AC-ORG-07 / AC-IDENT-01）。
 *
 * 判定顺序：先问「能不能发消息」（参与的群组，可写）；否则问「能不能看」
 * （全项目岗位，或 `group:view_subtree` 的子树只读）。看不到的群组直接不出现——不泄漏存在。
 */
export function visibleGroups(actor: Actor, groups: Iterable<GuardedGroup>): VisibleGroup[] {
  const visible: VisibleGroup[] = [];
  for (const group of groups) {
    const scope: GuardScope = {
      projectId: group.projectId,
      groupId: group.id,
      groupMemberIds: group.memberIds,
      ...(group.memberNodeIds === undefined ? {} : { groupMemberNodeIds: group.memberNodeIds }),
    };
    const writable = authorize(actor, "group:post", scope).allowed;
    if (writable || authorize(actor, "group:view", scope).allowed) {
      visible.push({ id: group.id, writable });
    }
  }
  return visible;
}

/**
 * F2（#47）统一权限守卫 `authorize`。
 *
 * 职责：把「谁能对什么做什么」集中成一份**可注入的静态权限矩阵**，供 HTTP / MCP /
 * WebSocket 三类入口在各自的调用点复用（GUARD-01、AC-PERM-01、AC-PROJ-GUARD-01）。
 *
 * 设计边界（与票范围一致）：
 * - 本模块是**纯函数**：不读数据库、不依赖连接或运行时对象；`Actor` / `GuardScope`
 *   都是调用方注入的纯数据。`org_nodes` / `members` 业务表属 T2（#49），本票只约定
 *   actor 携带的对接形状（`nodeId` / `subtreeNodeIds`）与子树判定所需的参与者节点。
 * - 角色是**静态枚举**（spec #45 §3 / 决策票 #25），不引入动态 RBAC；岗位（角色在
 *   某组织节点上的实例）由 `nodeId` + `subtreeNodeIds` 表达。
 * - 阶段 1 单用户、无认证：入口默认注入「人=owner」的 Actor，因此守卫全部放行，
 *   既有行为不变（票面硬约束）。
 */

/** 静态角色枚举（spec #45 §3；决策票 #25）。顺序即权限从高到低。 */
export const AUTHZ_ROLES = ["owner", "top_manager", "sub_manager", "member"] as const;
export type AuthzRole = (typeof AUTHZ_ROLES)[number];

/**
 * 守卫主体：某项目内的一个岗位持有者（人或 agent）。
 * 纯数据；T2（#49）从 `members` + `org_nodes` 组装后注入。
 */
export interface Actor {
  /** 主体标识：阶段 2 为 `members.id`；阶段 1 的人用稳定的本地 human id。 */
  readonly actorId: string;
  readonly kind: "human" | "agent";
  readonly role: AuthzRole;
  /** 本主体所在项目：跨项目一律拒绝（NFR-PROJ-01 隔离）。 */
  readonly projectId: string;
  /** 岗位所在的组织节点；owner / 未落位时为 null。 */
  readonly nodeId: string | null;
  /**
   * 该岗位可管辖的节点集合（**含自身**）。
   * - null = 不限子树（owner / top_manager 的全项目范围，由矩阵授予）；
   * - 数组 = 子树边界（org_nodes 递归 CTE 的结果；T2 提供）。
   */
  readonly subtreeNodeIds: readonly string[] | null;
}

/** 被请求的目标资源（缺字段即无法判定，守卫拒绝——不默认放行）。 */
export interface GuardScope {
  readonly projectId?: string;
  /** 目标资源所属组织节点（org / member 类动作）。 */
  readonly nodeId?: string | null;
  /** 目标成员（self 类动作：任务状态、可写记忆）。 */
  readonly memberId?: string;
  /** 目标群组及其参与者（group 类动作）。 */
  readonly groupId?: string;
  /** 群组成员（= group_participants 的 memberId 列表）。 */
  readonly groupMemberIds?: readonly string[];
  /**
   * 群组成员各自所属的组织节点，顺序与 `groupMemberIds` 对齐；
   * 未落位的成员用 null。子树可见性判定用（ORG-03 / #32）。
   */
  readonly groupMemberNodeIds?: readonly (string | null)[];
}

/**
 * 能力点（capabilities）：权限矩阵的授权单位（spec #45 §4）。
 * 名称是稳定契约：HTTP / MCP / WS 入口与后续票按名引用，新增能力点只改本表。
 */
export type Capability =
  | "project:create"
  | "group:create";

/** 静态权限矩阵：角色 → 能力点集合。集中表达 spec #45 §3 的角色描述。 */
export const ROLE_CAPABILITIES: Readonly<Record<AuthzRole, ReadonlySet<Capability>>> = {
  owner: new Set<Capability>(["project:create", "group:create"]),
  top_manager: new Set<Capability>(["group:create"]),
  sub_manager: new Set<Capability>(),
  member: new Set<Capability>(),
};

/** 守卫判定结果：允许（附查询范围）或拒绝（附稳定拒绝码）。 */
export type AuthorizeDecision =
  | { readonly allowed: true; readonly capability: Capability; readonly conn: ConnScope }
  | { readonly allowed: false; readonly capability: Capability | null; readonly code: DenyCode; readonly reason: string };

/** 稳定拒绝码（决策票 #26 的「拒绝语义」）：入口层据此映射 HTTP 403 / MCP FORBIDDEN。 */
export type DenyCode = "forbidden" | "out_of_subtree" | "not_a_member" | "not_self" | "cross_project";

/**
 * conn-scoped 查询约束：允许之后，后续查询**只能**在这个范围内取数（#37 强制点）。
 * `null` 表示该维度不限（已授权全项目）；数组表示白名单，查询层按它过滤/加 WHERE。
 */
export interface ConnScope {
  readonly projectId: string;
  /** 允许的组织节点（含子树）；null = 全项目。 */
  readonly nodeIds: readonly string[] | null;
  /** 允许的群组；null = 全项目群组，[]= 仅自己参与的群组。 */
  readonly groupIds: readonly string[] | null;
}

/**
 * 判定 `actor` 能否对 `scope` 指向的资源执行 `action`。
 * 纯函数：同样的入参永远得到同样的判定；不产生副作用、不抛错。
 */
export function authorize(actor: Actor, action: Capability, scope: GuardScope): AuthorizeDecision {
  if (!actor.projectId || (scope.projectId !== undefined && scope.projectId !== actor.projectId)) {
    return deny("cross_project", action, "目标资源不在该主体所属项目内。");
  }
  if (!ROLE_CAPABILITIES[actor.role].has(action)) {
    return deny("forbidden", action, `角色 ${actor.role} 没有 ${action} 能力点。`);
  }
  return { allowed: true, capability: action, conn: { projectId: actor.projectId, nodeIds: null, groupIds: null } };
}

function deny(code: DenyCode, capability: Capability, reason: string): AuthorizeDecision {
  return { allowed: false, capability, code, reason };
}

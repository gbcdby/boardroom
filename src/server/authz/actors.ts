/**
 * F2（#47）主体解析：把入口层已有的数据（`members` 行、MCP 会话绑定）映射成守卫 Actor。
 *
 * 阶段 1（localhost / 单用户 / 无认证，spec #45 §5.3 假设 2）没有认证主体，因此：
 * - HTTP / WebSocket 入口默认注入「人 = owner」的**全局主体**（`projectId = null`），
 *   owner 持有全部能力点 → 既有行为不变（票面硬约束）；
 * - MCP 入口的 agent 主体从会话绑定映射，角色按决策票 #25 的兼容规则：
 *   `kind=human → owner`、`role=manager → top_manager`、`role=normal → member`；
 * - `nodeId` / `subtreeNodeIds` 属 T2（#49）的 `org_nodes`：这里一律给 null，
 *   守卫的 project 级判定不受影响，子树边界判定等 T2 注入后生效。
 */
import type { Member, MemberKind, MemberRole } from "../db/types.ts";
import type { Actor, Capability } from "./authorize.ts";
export type { Actor, Capability, GuardScope } from "./authorize.ts";

/** 阶段 1 无认证时人的稳定主体标识（不落 `members` 表，避免与真实成员 ID 混淆）。 */
export const DEFAULT_HUMAN_ACTOR_ID = "human:local";

/** 既有入口点位实际用到的能力点集合（顺序即接入顺序）。 */
export const PROJECT_CAPABILITIES: readonly Capability[] = [
  "project:create",
  "group:create",
  "group:view",
  "group:post",
  "message:ack",
  "status:report_own",
  "interrupt:self",
  "session:heartbeat",
];

/** 阶段 1 角色（manager/normal）→ 阶段 2 静态角色的兼容映射（决策票 #25）。 */
export function toAuthzRole(kind: MemberKind, role: MemberRole | undefined): Actor["role"] {
  if (kind === "human") return "owner";
  return role === "manager" ? "top_manager" : "member";
}

/** 由 `members` 行构造 Actor；T2 落库后在同一处补 `nodeId` / `subtreeNodeIds`。 */
export function actorForMember(member: Pick<Member, "id" | "projectId" | "kind" | "role">): Actor {
  return {
    actorId: member.id,
    kind: member.kind,
    role: toAuthzRole(member.kind, member.role),
    projectId: member.projectId,
    nodeId: null,
    subtreeNodeIds: null,
  };
}

/** MCP 会话绑定 → Actor（`role` 省略时按 normal，与 `join` 契约一致）。 */
export function actorForSession(binding: {
  readonly memberId: string;
  readonly projectId: string;
  readonly kind?: MemberKind;
  readonly role?: MemberRole;
}): Actor {
  return actorForMember({
    id: binding.memberId,
    projectId: binding.projectId,
    kind: binding.kind ?? "agent",
    role: binding.role ?? "normal",
  });
}

/**
 * 「默认人」主体：阶段 1 未认证时 HTTP/WS 的调用者。
 * @param projectId 已知项目上下文时传入（限定 conn 范围）；null = 全局主体（可跨项目）。
 */
export function ownerActor(projectId: string | null = null): Actor {
  return {
    actorId: DEFAULT_HUMAN_ACTOR_ID,
    kind: "human",
    role: "owner",
    projectId,
    nodeId: null,
    subtreeNodeIds: null,
  };
}

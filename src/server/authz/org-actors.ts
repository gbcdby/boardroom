/**
 * T2（#49）真实 DB → F2 守卫 Actor 的装配口。
 *
 * F2（#47）把 `authorize` / `ROLE_CAPABILITIES` / `visibleGroups` 做成纯数据结构，
 * 主体（`Actor.nodeId` / `subtreeNodeIds`）由注入点给出。本模块把 F2 的注入点
 * （`StartServerOptions.authorization`，见 `src/server/server.ts`）接到真实数据：
 *   - `members.node_id` → 岗位节点；
 *   - `org_nodes` 递归 CTE → 子树节点集合；
 *   - 岗位 `role`（静态枚举）→ `Actor.role` / 默认管辖范围 `reach`。
 *
 * **阶段 1 兼容硬约束**：v3→v4 升级后的库默认没有组织树数据（票面要求不回填）。
 * 成员未落位（`nodeId === null`）时本模块一律返回 `null`，由调用方沿用 F2 既有的
 * `actorForMember` / `actorForSession` / `ownerActor` 兼容映射——`owner` 仍持有全量
 * 能力点，阶段 1 链路行为不变（由 `scripts/e2e-phase1.mjs` 全绿回归）。
 */
import type { RepositorySet } from "../db/repositories.ts";
import type { Actor } from "./authorize.ts";
import { actorForMember, actorForSession, ownerActor } from "./actors.ts";
import type { ActorResolution } from "../api.ts";
import type { WsActorContext } from "../ws.ts";
import type { SessionBinding } from "../mcp/core.ts";

/**
 * 由真实组织数据装配一个 agent 成员的 Actor。
 *
 * 只有「agent 成员确实占据了一个非 owner 岗位节点」时才返回带岗位/子树数据的 Actor；
 * 其余（人、未落位成员、owner 岗位）返回 `null`，调用方回退到阶段 1 兼容映射。
 * 这样 `resolveActor` 在升级路径上不会把「默认人」或其它既有主体悄悄换掉。
 */
export function orgActorForMember(repos: RepositorySet, memberId: string): Actor | null {
  const member = repos.members.get(memberId);
  // 人（owner）是内建全局主体，高于 manager；不因占岗而降级为普通角色。
  if (!member || member.kind !== "agent" || member.nodeId === null) return null;
  const node = repos.org.getNode(member.nodeId);
  if (!node || node.role === "owner") return null;
  return {
    actorId: member.id,
    kind: "agent",
    // OrgNodeRole 与 AuthzRole 同值（静态枚举 owner/top_manager/sub_manager/member）。
    role: node.role,
    projectId: member.projectId,
    nodeId: node.id,
    // 递归 CTE 现算：sub_manager 的子树边界（ORG-05）、group:view_subtree 只读范围共用。
    subtreeNodeIds: repos.org.subtreeNodeIds(node.id),
    // 省略 reach：按 ROLE_REACH[role]（project / subtree / own）取默认管辖范围。
  };
}

/** 三处入口共用的主体解析集合，与 `ServerAuthorization` 一一对应。 */
export interface OrgActorResolver {
  /** HTTP：未认证的人请求 = owner；带 memberId 的动作（发消息）按真实岗位解析。 */
  resolveHttpActor(resolution: ActorResolution): Actor | null;
  /** WebSocket：presence 声明；未落位的成员仍按「默认人」处理，行为不变。 */
  resolveWsActor(context: WsActorContext): Actor | null;
  /** MCP：会话绑定（join 时确定）→ 带岗位与子树的 Actor。 */
  actorForMcpBinding(binding: SessionBinding): Actor;
}

/**
 * 装配默认 `authorization`：优先用真实组织数据，无组织数据时逐入口回退到 F2 兼容映射。
 * `startServer` 在未显式注入 `authorization` 时使用本解析器，使运行中的服务读的是
 * 真实 `org_nodes` / `members.node_id`，而不是永远的「默认人」。
 */
export function createOrgActorResolver(repos: RepositorySet): OrgActorResolver {
  return {
    resolveHttpActor(resolution) {
      if (resolution.memberId !== undefined) {
        const orgActor = orgActorForMember(repos, resolution.memberId);
        if (orgActor) return orgActor;
        const member = repos.members.get(resolution.memberId);
        if (member) return actorForMember(member);
      }
      return ownerActor(resolution.projectId);
    },
    resolveWsActor({ projectId, memberId }) {
      if (memberId !== null) {
        const orgActor = orgActorForMember(repos, memberId);
        if (orgActor) return orgActor;
      }
      return ownerActor(projectId);
    },
    actorForMcpBinding(binding) {
      return orgActorForMember(repos, binding.memberId) ?? actorForSession(binding);
    },
  };
}

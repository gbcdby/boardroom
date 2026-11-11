/**
 * F2 领域模型的 TypeScript 类型。
 *
 * 这些类型是持久化边界对外的稳定契约，供 T1–T7 与 repository 层复用。
 * 只描述可持久化字段；运行时对象（WebSocket 连接、宿主进程句柄等）不进入这里。
 */

/**
 * Agent 宿主类型。开放类型：任何已注册宿主适配器的 id + 内建 `"other"`，
 * 不再写死为联合类型。这样既兼容现有 `claude-code` / `codex-cli` / `other`，
 * 又为未来宿主（如 `dsh`）留出扩展空间，无需改核心类型（#56 / NFR-HOST-01）。
 * 宿主 id 的单一事实来源是 `src/server/mcp/adapters/index.ts` 的注册表
 * （`listAdapterIds()` / `defaultRegistry`）；`KNOWN_HOST_TYPES` 仅是方便阅读的已知宿主快照。
 *
 * DB `host_type` 列仍是自由 TEXT（不在此约束），本类型只是 TS 层的开放别名。
 */
export type HostType = string & {};

/** Agent：跨项目的全局身份。 */
export interface Agent {
  readonly id: string;
  readonly displayName: string;
  readonly hostType: HostType;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * 最近一次观察到该 Agent 连接活动的时间（ISO 字符串）。
   * 仅记录可恢复的时间戳；连接是否存活由运行时按心跳推导，不落库。
   */
  readonly lastSeenAt: string | null;
}

export interface NewAgent {
  readonly displayName: string;
  readonly hostType: HostType;
}

/** Project：协作容器。 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * 归档时间（ISO 字符串）；null = 未归档。
   * 归档是**可恢复**的非活跃态（#48 / PROJECT-03、LIFE-ARC-01）：不删数据，
   * 默认列表隐藏、写路径拒绝；恢复即把该列置回 null。
   */
  readonly archivedAt: string | null;
}

export interface NewProject {
  readonly name: string;
  /**
   * 创建项目时同时指定顶层 manager（#48 / PROJECT-02「创建时指定」）：
   * 必须是**已存在的全局 agent**（由 MCP 入群产生），服务端在同一事务里
   * 为该 agent 建本项目的成员岗位并置为 manager。省略 = 留空待分配。
   */
  readonly managerAgentId?: string | null;
}

/** 成员类别：agent 或人。 */
export type MemberKind = "agent" | "human";

/** 阶段 1 的项目级角色（D2）。 */
export type MemberRole = "manager" | "normal";

/**
 * 成员生命周期状态（T3 #50 / LIFE-MEM-01/02/03）。
 *
 * 与 {@link MemberState}（online/offline/waiting/working 运行状态）、
 * {@link McpSessionState}（连接/心跳状态）**分开建模**：
 * 本枚举只表达「成员在不在岗」，不表达在线/离线、也不表达任务状态。
 * - `active`：正常在岗；
 * - `disabled`：已暂停/停用；**保留**身份、历史、数据、岗位与群组参与，不物理删除；
 * - `pending`：待激活（已登记、尚未正式在岗）。
 *
 * 状态可经 `members.setStatus` 在合法转换表内迁移、可恢复；断连不改写本列（LIFE-MEM-03）。
 * 老库升级（迁移 v5）一律默认 `active`，阶段 1 行为不回归。
 */
export type MemberLifecycleStatus = "active" | "disabled" | "pending";

/** v13 持久身份代际；接口先发布，旧 schema 的默认值为 null / 1。 */
export interface MemberLifecycleFields {
  readonly removedAt: string | null;
  readonly membershipRevision: number;
}
export const MEMBER_FACT_KINDS = ["authored-messages", "deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"] as const;
export type MemberFactKind = typeof MEMBER_FACT_KINDS[number];
export interface MemberFactRevision { kind: MemberFactKind; revision: number }

/**
 * 岗位角色的静态枚举（T2 #49；spec #45 §3、决策票 #25/#26 定稿口径）。
 * 与 F2 `AUTHZ_ROLES` 同值：角色静态、岗位动态（角色与岗位分离）；
 * 能力集合由 F2 的 `ROLE_CAPABILITIES` 静态矩阵表达，本表不建角色/能力点 DB 表。
 * `owner` 是人的内建角色，**不建岗位节点**（人是全局主体，决策票 #26）。
 */
export type OrgNodeRole = "owner" | "top_manager" | "sub_manager" | "member";

/**
 * OrgNode：组织树的岗位节点（T2 #49 / 决策票 #24）。
 * 汇报线 = `parent_id`（上级即父节点）；子树边界用递归 CTE 现算。
 * 每项目根层最多一个节点，该位置即「顶层 manager 岗位」；空岗 = 无成员占据。
 */
export interface OrgNode {
  readonly id: string;
  readonly projectId: string;
  /** 上级岗位；null = 根（顶层 manager 岗位）。 */
  readonly parentId: string | null;
  readonly name: string;
  readonly role: OrgNodeRole;
  /** 同级展示顺序（#33 WebUI）。 */
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewOrgNode {
  /** 仅 server-only mutation 入口预分配；公开输入不能自报 ID。 */
  readonly id?: string;
  readonly projectId: string;
  readonly parentId?: string | null;
  readonly name: string;
  readonly role: OrgNodeRole;
  readonly sortOrder?: number;
}

/** Member：agent 或人在某项目中的成员关系与岗位。 */
export interface Member extends MemberLifecycleFields {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string | null;
  readonly kind: MemberKind;
  readonly displayName: string;
  readonly role: MemberRole;
  /**
   * 占据的组织岗位（T2 #49）。null = 未落位；未落位成员的守卫主体走阶段 1 兼容映射
   * （`role` 的 manager/normal → top_manager/member），保证既有库升级路径行为不变。
   */
  readonly nodeId: string | null;
  /** 生命周期状态（T3 #50）；老库默认 active。与运行状态/连接状态分开（见 {@link MemberLifecycleStatus}）。 */
  readonly status: MemberLifecycleStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewMember {
  /** server-only 预分配 ID，供共同锁计划声明新成员。HTTP/MCP 不接受用户自报。 */
  readonly id?: string;
  readonly projectId: string;
  /** kind=agent 时必填；kind=human 时必须省略/为 null。 */
  readonly agentId?: string | null;
  readonly kind: MemberKind;
  readonly displayName: string;
  readonly role?: MemberRole;
  /** 生命周期状态（T3 #50）；省略 = active。可显式登记为 pending（待激活）。 */
  readonly status?: MemberLifecycleStatus;
}

/** Group：项目内聊天空间。 */
export interface Group {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 归档时间（ISO 字符串）；null = 未归档。语义同 {@link Project.archivedAt}（GROUP-04）。 */
  readonly archivedAt: string | null;
}

export interface NewGroup {
  readonly projectId: string;
  readonly name: string;
  /** 初始参与者，必须都是该项目的成员。 */
  readonly participantMemberIds?: readonly string[];
}

/** Message：群组消息。 */
export interface Message {
  readonly id: string;
  readonly groupId: string;
  readonly senderMemberId: string;
  /** 群组内单调递增序号，用于稳定排序。 */
  readonly seq: number;
  readonly body: string;
  /** mention 的成员 ID 列表（不解析语义；解析属于 T3）。 */
  readonly mentions: readonly string[];
  readonly createdAt: string;
}

export interface NewMessage {
  readonly groupId: string;
  readonly senderMemberId: string;
  readonly body: string;
  readonly mentions?: readonly string[];
  /** 可选：外部提供稳定 ID（如重放/幂等导入）；缺省时自动生成。 */
  readonly id?: string;
  /** 发送成员作用域内的稳定请求 ID；缺省不去重，空字符串不写入数据库。 */
  readonly clientMessageId?: string;
}

/** 投递状态。 */
export type DeliveryStatus = "pending" | "delivered" | "acked";

export type DeliveryWake =
  | { readonly decision: "allowed"; readonly reason?: null }
  | { readonly decision: "suppressed"; readonly reason: "consecutive_limit" | "rate_limited" };

/** MessageDelivery：某消息对某成员的一次投递记录（去重键 message+member）。 */
export interface MessageDelivery {
  readonly id: string;
  readonly messageId: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly status: DeliveryStatus;
  /** 发送时判定；null 表示不属于唤醒候选（旧数据也保留 null）。 */
  readonly wakeDecision: "allowed" | "suppressed" | null;
  readonly wakeSuppressedReason: "consecutive_limit" | "rate_limited" | null;
  readonly attemptCount: number;
  readonly firstDeliveredAt: string | null;
  /** 真实 MCP wait 首次返回的时间；ACK 与普通 delivered 状态不能推导此事实。 */
  readonly firstMcpDeliveredAt: string | null;
  readonly lastDeliveredAt: string | null;
  readonly ackedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** MemberStatus：项目成员运行状态（D1），按 (project_id, member_id) 唯一。 */
export interface MemberStatus {
  readonly projectId: string;
  readonly memberId: string;
  readonly state: MemberState;
  readonly updatedAt: string;
}

export type MemberState = "online" | "offline" | "waiting" | "working";

/**
 * McpSession：一个 MCP 会话的连接状态（全局层，D1），持久化「可恢复」的部分。
 *
 * 与 {@link MemberStatus} 分开建模：
 * - McpSession 记录某个 agent 的 MCP 会话在哪个项目/群组、何时连接/断开、最后心跳；
 * - MemberStatus 记录项目成员运行状态（online/offline/waiting/working）。
 * 连接是否**存活**由运行时按心跳推导；表只保存状态与时间戳，不保存连接对象。
 */
export type McpSessionState = "connected" | "disconnected";

export interface McpSession {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly displayName: string;
  readonly hostType: HostType;
  readonly state: McpSessionState;
  readonly connectedAt: string;
  readonly lastHeartbeatAt: string | null;
  readonly disconnectedAt: string | null;
  readonly updatedAt: string;
}

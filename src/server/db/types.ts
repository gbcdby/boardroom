/**
 * F2 领域模型的 TypeScript 类型。
 *
 * 这些类型是持久化边界对外的稳定契约，供 T1–T7 与 repository 层复用。
 * 只描述可持久化字段；运行时对象（WebSocket 连接、宿主进程句柄等）不进入这里。
 */

/** Agent 宿主类型。阶段 1 已知宿主；允许字符串以容纳未来宿主。 */
export type HostType = "claude-code" | "codex-cli" | (string & {});

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
}

export interface NewProject {
  readonly name: string;
}

/** 成员类别：agent 或人。 */
export type MemberKind = "agent" | "human";

/** 阶段 1 的项目级角色（D2）。 */
export type MemberRole = "manager" | "normal";

/** Member：agent 或人在某项目中的成员关系与岗位。 */
export interface Member {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string | null;
  readonly kind: MemberKind;
  readonly displayName: string;
  readonly role: MemberRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewMember {
  readonly projectId: string;
  /** kind=agent 时必填；kind=human 时必须省略/为 null。 */
  readonly agentId?: string | null;
  readonly kind: MemberKind;
  readonly displayName: string;
  readonly role?: MemberRole;
}

/** Group：项目内聊天空间。 */
export interface Group {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
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
}

/** 投递状态。 */
export type DeliveryStatus = "pending" | "delivered" | "acked";

/** MessageDelivery：某消息对某成员的一次投递记录（去重键 message+member）。 */
export interface MessageDelivery {
  readonly id: string;
  readonly messageId: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly firstDeliveredAt: string | null;
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

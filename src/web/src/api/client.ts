/**
 * T1（#14）项目 / 群组 / 成员 HTTP API 的前端客户端与类型。
 *
 * 与 `src/server/api.ts` 的契约一一对应。错误统一以 {@link ApiError} 抛出，
 * 页面据此做基础错误提示。
 */

/** T3（#50）成员生命周期状态（与 member_statuses 的运行状态、mcp_sessions 的连接状态分开）。 */
export type MemberLifecycleStatus = "active" | "disabled" | "pending";

export interface MemberDto {
  id: string;
  projectId: string;
  agentId: string | null;
  kind: "agent" | "human";
  displayName: string;
  role: "manager" | "normal";
  /** T2 #49：占据的组织岗位（null = 未落位）。 */
  nodeId: string | null;
  /** T3 #50：生命周期状态（active / disabled / pending）；老库默认 active，可恢复、不物理删除。 */
  status: MemberLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 归档时间（ISO 字符串）；null = 未归档（T1 #48 / PROJECT-03）。 */
  archivedAt: string | null;
  manager: MemberDto | null;
  /** T4（#51）跨项目概览聚合字段：以下为可选，便于逐步落地与兼容旧缓存。 */
  /** 成员数（含人/agent）。 */
  memberCount?: number;
  /** 活跃群组数。 */
  groupCount?: number;
  /** 项目组消息总数。 */
  messageCount?: number;
  /** 在线成员数（online/waiting/working）。 */
  onlineCount?: number;
  /** 最近一条消息时间（ISO 字符串）；无消息为 null。 */
  lastActivityAt?: string | null;
  /** 项目聚合状态：active = 有成员在线；idle = 无人在线；archived = 已归档（非活跃）。 */
  status?: "active" | "idle" | "archived";
}

export interface GroupDto {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 归档时间（ISO 字符串）；null = 未归档（T1 #48 / GROUP-04）。 */
  archivedAt: string | null;
  /**
   * T2 #49：群组列表端点返回的可写标记。false = 子树只读可见
   * （可看元数据与历史，不唤醒、不能发消息）；其它端点不返回该字段。
   */
  writable?: boolean;
}

/** T2 #49：组织岗位节点（静态角色写在岗位上；汇报线 = parentId）。 */
export interface OrgNodeDto {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  role: "owner" | "top_manager" | "sub_manager" | "member";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  memberId: string | null;
  memberDisplayName: string | null;
}

/** 角色配置入口的目录项：F2 静态角色 → 能力点集合。 */
export interface RoleCatalogEntry {
  role: "owner" | "top_manager" | "sub_manager" | "member";
  capabilities: string[];
  /** owner 是人的内建全局主体，不建岗位节点。 */
  nodeRole: boolean;
}

export interface OrgSnapshot {
  nodes: OrgNodeDto[];
  rootId: string | null;
  roles: RoleCatalogEntry[];
  members: MemberDto[];
}

/**
 * 成员在线/连接状态（T2 建立，T4 扩展）。把分开建模的两层合并展示：
 * - `connection`：全局 MCP 会话连接状态（connected / disconnected / none）；
 * - `state`：项目成员运行状态（online/offline/waiting/working），已结合心跳超时推导；
 * - `stale` / `disconnected` / `heartbeatTimedOut` / `heartbeatStale`：陈旧与断线标记（T4）。
 */
export interface MemberStatusDto {
  memberId: string;
  projectId: string;
  displayName: string | null;
  kind: "agent" | "human" | null;
  agentId: string | null;
  hostType: string | null;
  connection: "connected" | "disconnected" | "none";
  state: "online" | "offline" | "waiting" | "working" | null;
  stale: boolean;
  disconnected: boolean;
  heartbeatTimedOut: boolean;
  heartbeatStale: boolean;
  lastHeartbeatAt: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  updatedAt: string | null;
}

/**
 * T3（#16）消息视图（与 `src/server/api.ts` 的 `MessageView` 对应）。
 */
export interface MessageDto {
  id: string;
  groupId: string;
  seq: number;
  senderMemberId: string;
  senderDisplayName: string | null;
  senderRemoved?: boolean;
  text: string;
  mentions: string[];
  wakeMemberIds: string[];
  visibleMemberIds: string[];
  createdAt: string;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: string;
  readonly status: number;
  readonly reason: string | undefined;

  constructor(status: number, code: string, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...(init.headers ?? {}), "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; reason?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown_error",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      error?.reason,
    );
  }
  return payload as T;
}

/**
 * 永久删除的级联清单（T1 #48）：确认弹窗里给「人」看清楚会清掉什么。
 * 项目与群各自包含实际删除的托管绑定、运行状态和成员预留关系；全局托管配置保留。
 * 群删除保留项目成员，仅清除不再被其他群绑定使用的未占用托管成员预留关系。
 */
export interface ProjectPurgeCascade {
  memberFactRevisions: number;
  memoryDocuments: number;
  memoryVersions: number;
  memorySummaryRequests: number;
  memoryMessageReceipts: number;
  memoryTriggerCounters: number;
  memoryScanCheckpoints: number;
  taskSettings: number;
  tasks: number;
  taskComments: number;
  taskHistory: number;
  taskMessageLinks: number;
  reviewRounds: number;
  reviewReports: number;
  workEvents: number;
  groups: number;
  members: number;
  /** T2 #49：随项目一起清除的组织岗位节点数。 */
  orgNodes: number;
  messages: number;
  deliveries: number;
  memberStatuses: number;
  mcpSessions: number;
  agentRuntimeBindings: number;
  agentRunnerStates: number;
  agentRuntimeMembers: number;
}

export interface GroupPurgeCascade {
  memorySummaryRequests: number;
  memoryMessageReceipts: number;
  memoryTriggerCounters: number;
  memoryScanCheckpoints: number;
  workEvents: number;
  taskMessageLinks: number;
  messages: number;
  deliveries: number;
  participants: number;
  mcpSessions: number;
  agentRuntimeBindings: number;
  agentRunnerStates: number;
  agentRuntimeMembers: number;
}

export interface ProjectPurgeConfirmation {
  kind: "project";
  projectId: string;
  projectName: string;
  archivedAt: string | null;
  cascade: ProjectPurgeCascade;
  token: string;
  expiresAt: string;
}

export interface GroupPurgeConfirmation {
  kind: "group";
  projectId: string;
  groupId: string;
  groupName: string;
  archivedAt: string | null;
  cascade: GroupPurgeCascade;
  token: string;
  expiresAt: string;
}

/** 永久删除的一刀两拍：第一次返回待确认清单，带同一凭据的第二次才删除。 */
export type PurgeOutcome<T> =
  | { readonly state: "confirmation_required"; readonly confirmation: T }
  | { readonly state: "deleted" };

/** 审计事件视图；before/after/detail 是服务端解析后的 JSON 值。 */
export interface AuditEntryDto {
  id: string;
  projectId: string;
  actorKind: "human" | "agent" | "system";
  actorMemberId: string | null;
  actorName: string;
  action: string;
  targetKind: string;
  targetId: string;
  targetName: string;
  changed: unknown;
  before: unknown;
  after: unknown;
  detail: unknown;
  reversible: boolean;
  reversedAt: string | null;
  reversedByAuditId: string | null;
  createdAt: string;
}

async function purgeRequest<C>(pathname: string, token?: string): Promise<PurgeOutcome<C>> {
  const init: RequestInit = { method: "DELETE", headers: { accept: "application/json" } };
  if (token !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify({ confirm: token });
  }
  const response = await fetch(pathname, init);
  if (response.status === 204) return { state: "deleted" };

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 409 && payload?.error?.code === "confirmation_required" && payload.confirmation) {
    return { state: "confirmation_required", confirmation: payload.confirmation as C };
  }
  throw new ApiError(
    response.status,
    payload?.error?.code ?? "unknown_error",
    payload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
  );
}

export const api = {
  listProjects(options?: { includeArchived?: boolean }): Promise<{ projects: ProjectDto[] }> {
    const suffix = options?.includeArchived ? "?includeArchived=true" : "";
    return request("GET", `/api/projects${suffix}`);
  },
  createProject(name: string): Promise<{ project: ProjectDto }> {
    return request("POST", "/api/projects", { name });
  },
  listMembers(projectId: string): Promise<{ members: MemberDto[] }> {
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/members`);
  },
  addHumanMember(projectId: string, displayName: string): Promise<{ member: MemberDto }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/members`, {
      kind: "human",
      displayName,
    });
  },
  removeMember(projectId: string, memberId: string): Promise<void> {
    return request(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}`,
    );
  },
  /** T3 #50：暂停成员（status → disabled），可恢复、不物理删除。 */
  disableMember(projectId: string, memberId: string): Promise<{ member: MemberDto }> {
    return request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}/disable`,
    );
  },
  /** T3 #50：恢复成员（status → active，恢复岗位）。 */
  enableMember(projectId: string, memberId: string): Promise<{ member: MemberDto }> {
    return request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}/enable`,
    );
  },
  /** T3 #50：通用状态转换（非法转换由服务端状态机拒绝）。 */
  setMemberStatus(
    projectId: string,
    memberId: string,
    status: MemberLifecycleStatus,
  ): Promise<{ member: MemberDto }> {
    return request(
      "PUT",
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(memberId)}/lifecycle`,
      { status },
    );
  },
  setManager(projectId: string, memberId: string): Promise<{ project: ProjectDto }> {
    return request("PUT", `/api/projects/${encodeURIComponent(projectId)}/manager`, { memberId });
  },
  listGroups(projectId: string, options?: { includeArchived?: boolean }): Promise<{ groups: GroupDto[] }> {
    const suffix = options?.includeArchived ? "?includeArchived=true" : "";
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/groups${suffix}`);
  },
  createGroup(projectId: string, name: string, participantMemberIds: string[]): Promise<{ group: GroupDto }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/groups`, {
      name,
      participantMemberIds,
    });
  },
  listParticipants(groupId: string): Promise<{ participants: MemberDto[] }> {
    return request("GET", `/api/groups/${encodeURIComponent(groupId)}/participants`);
  },
  listMemberStatuses(projectId: string): Promise<{ memberStatuses: MemberStatusDto[] }> {
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/member-statuses`);
  },
  listMessages(groupId: string): Promise<{ messages: MessageDto[] }> {
    return request("GET", `/api/groups/${encodeURIComponent(groupId)}/messages`);
  },
  sendMessage(groupId: string, senderMemberId: string, text: string, mentions?: string[]): Promise<{ message: MessageDto }> {
    return request("POST", `/api/groups/${encodeURIComponent(groupId)}/messages`, {
      senderMemberId,
      text,
      ...(mentions === undefined ? {} : { mentions }),
    });
  },

  // --- T1 #48：归档 / 恢复 / 永久删除（二次确认）-------------------------

  archiveProject(projectId: string): Promise<{ project: ProjectDto }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/archive`);
  },
  restoreProject(projectId: string): Promise<{ project: ProjectDto }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/restore`);
  },
  /** 不带 token = 取级联清单与确认凭据（不删除）；带 token = 执行永久删除。 */
  purgeProject(projectId: string, token?: string): Promise<PurgeOutcome<ProjectPurgeConfirmation>> {
    return purgeRequest<ProjectPurgeConfirmation>(`/api/projects/${encodeURIComponent(projectId)}`, token);
  },
  archiveGroup(groupId: string): Promise<{ group: GroupDto }> {
    return request("POST", `/api/groups/${encodeURIComponent(groupId)}/archive`);
  },
  restoreGroup(groupId: string): Promise<{ group: GroupDto }> {
    return request("POST", `/api/groups/${encodeURIComponent(groupId)}/restore`);
  },
  purgeGroup(groupId: string, token?: string): Promise<PurgeOutcome<GroupPurgeConfirmation>> {
    return purgeRequest<GroupPurgeConfirmation>(`/api/groups/${encodeURIComponent(groupId)}`, token);
  },

  // --- T2 #49：组织树与角色（WebUI 最小可用）--------------------------------

  getOrg(projectId: string): Promise<OrgSnapshot> {
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/org`);
  },
  createOrgNode(
    projectId: string,
    body: { parentId?: string | null; name: string; role: "top_manager" | "sub_manager" | "member"; sortOrder?: number },
  ): Promise<{ node: OrgNodeDto }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/org/nodes`, body);
  },
  updateOrgNode(
    nodeId: string,
    patch: { name?: string; role?: "top_manager" | "sub_manager" | "member"; parentId?: string | null; sortOrder?: number },
  ): Promise<{ node: OrgNodeDto }> {
    return request("PUT", `/api/org/nodes/${encodeURIComponent(nodeId)}`, patch);
  },
  deleteOrgNode(nodeId: string): Promise<void> {
    return request("DELETE", `/api/org/nodes/${encodeURIComponent(nodeId)}`);
  },
  /** memberId 为 null = 腾出该岗位当前占据者。 */
  assignOrgNode(nodeId: string, memberId: string | null): Promise<{ member: MemberDto | null }> {
    return request("PUT", `/api/org/nodes/${encodeURIComponent(nodeId)}/assignee`, { memberId });
  },
  autoPlaceMember(projectId: string, memberId: string): Promise<{ node: OrgNodeDto | null }> {
    return request("POST", `/api/projects/${encodeURIComponent(projectId)}/org/auto-place`, { memberId });
  },

  // --- T5 #52：审计查看与撤销（人的撤销权）------------------------------

  listAudit(
    projectId: string,
    options?: { action?: string; targetKind?: string; targetId?: string; limit?: number },
  ): Promise<{ entries: AuditEntryDto[] }> {
    const params = new URLSearchParams();
    if (options?.action) params.set("action", options.action);
    if (options?.targetKind) params.set("targetKind", options.targetKind);
    if (options?.targetId) params.set("targetId", options.targetId);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/audit${suffix}`);
  },
  /** 撤销一条可逆审计事件（仅人；agent 被服务端拒绝）。 */
  revokeAudit(projectId: string, auditId: string): Promise<{ entry: AuditEntryDto }> {
    return request(
      "POST",
      `/api/projects/${encodeURIComponent(projectId)}/audit/${encodeURIComponent(auditId)}/revoke`,
    );
  },
};

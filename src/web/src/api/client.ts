/**
 * T1（#14）项目 / 群组 / 成员 HTTP API 的前端客户端与类型。
 *
 * 与 `src/server/api.ts` 的契约一一对应。错误统一以 {@link ApiError} 抛出，
 * 页面据此做基础错误提示。
 */

export interface MemberDto {
  id: string;
  projectId: string;
  agentId: string | null;
  kind: "agent" | "human";
  displayName: string;
  role: "manager" | "normal";
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
}

export interface GroupDto {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 归档时间（ISO 字符串）；null = 未归档（T1 #48 / GROUP-04）。 */
  archivedAt: string | null;
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

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "unknown_error",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
    );
  }
  return payload as T;
}

/**
 * 永久删除的级联清单（T1 #48）：确认弹窗里给「人」看清楚会清掉什么。
 * 项目清群组/群聊/投递/成员/状态/会话；群组只清群聊与参与者关系（成员保留）。
 */
export interface ProjectPurgeCascade {
  groups: number;
  members: number;
  messages: number;
  deliveries: number;
  memberStatuses: number;
  mcpSessions: number;
}

export interface GroupPurgeCascade {
  messages: number;
  deliveries: number;
  participants: number;
  mcpSessions: number;
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
};

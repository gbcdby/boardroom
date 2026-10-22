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
  manager: MemberDto | null;
}

export interface GroupDto {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 成员在线/连接状态（T2）。把分开建模的两层合并展示：
 * - `connection`：全局 MCP 会话连接状态（connected / disconnected / none）；
 * - `state`：项目成员运行状态（online/offline/waiting/working / null）。
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

export const api = {
  listProjects(): Promise<{ projects: ProjectDto[] }> {
    return request("GET", "/api/projects");
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
  listGroups(projectId: string): Promise<{ groups: GroupDto[] }> {
    return request("GET", `/api/projects/${encodeURIComponent(projectId)}/groups`);
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
};

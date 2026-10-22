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
};

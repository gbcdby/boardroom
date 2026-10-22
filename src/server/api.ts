import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { RepositoryError } from "./db/errors.ts";
import { createRepositories, type RepositorySet } from "./db/repositories.ts";
import type { Group, Member, Project } from "./db/types.ts";
import type { Logger } from "./logger.ts";

/**
 * T1（#14）项目 / 群组 / 成员 HTTP API。
 *
 * 只做「人在 WebUI 管理已存在成员」这一层：创建项目、创建群组、添加/移除成员、
 * 列出成员/群组、指定/更换顶层 manager。agent 成员的真实入群由 T2（MCP）产生，
 * 本模块不引入任何占位 agent 数据。
 *
 * 约定：
 * - 路由前缀 `/api`；本模块只处理已确认的路径，未匹配时返回 `matched: false`，
 *   由 server.ts 继续走 404 / MCP / 静态资源。
 * - 错误统一 JSON `{ error: { code, message } }`，`code` 与 F2 repository 错误码一致
 *   （not_found / conflict / invalid_reference / invalid_argument / write_failed）。
 * - 校验与持久化复用 F2 repository（`createRepositories`），不重复实现唯一 manager 约束；
 *   重复指定 manager 由 repository/唯一索引归一为 ConflictError → HTTP 409（D2）。
 */

export interface T1ApiOptions {
  readonly db: Database.Database;
  readonly logger: Logger;
}

export interface T1ApiRouter {
  /**
   * 尝试处理一个 `/api/...` 请求。
   * 返回 true 表示已处理并写完响应；false 表示路径不归本模块管。
   */
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>;
}

/** 错误码 → HTTP 状态。与 repository 层错误码一一对应。 */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  invalid_reference: 400,
  invalid_argument: 400,
  write_failed: 500,
};

const MAX_BODY_BYTES = 1_000_000;

/** 创建 T1 API 路由。日志不记录消息正文等敏感字段（本模块无正文）。 */
export function createT1ApiRouter(options: T1ApiOptions): T1ApiRouter {
  const { db, logger } = options;
  const repos = createRepositories(db);
  const log = logger.child({ component: "api" });

  return {
    async handle(request, response, pathname) {
      const method = request.method ?? "GET";
      try {
        return await route(repos, request, response, method, pathname);
      } catch (error) {
        if (error instanceof RepositoryError) {
          const status = ERROR_STATUS[error.code] ?? 500;
          writeError(response, status, error.code, error.message);
          return true;
        }
        if (error instanceof HttpError) {
          writeError(response, error.status, error.code, error.message);
          return true;
        }
        throw error;
      }
    },
  };

  // -------------------------------------------------------------------------

  async function route(
    r: RepositorySet,
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    pathname: string,
  ): Promise<boolean> {
    const segments = pathname.split("/").filter((s) => s !== "");
    // segments[0] === "api"

    // /api/projects
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "projects") {
      if (method === "POST") {
        const body = await readObjectBody(request);
        const project = r.projects.create({ name: requireString(body, "name") });
        log.info("创建项目", { projectId: project.id });
        writeJson(response, 201, { project: projectView(r, project) });
        return true;
      }
      if (method === "GET") {
        writeJson(response, 200, { projects: r.projects.list().map((p) => projectView(r, p)) });
        return true;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // /api/projects/:id
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "projects") {
      const projectId = decodeSegment(segments[2]!);
      if (method === "GET") {
        const project = requireProject(r, projectId);
        writeJson(response, 200, { project: projectView(r, project) });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    // /api/projects/:id/members
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "members"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "POST") {
        const body = await readObjectBody(request);
        const agentId = optionalStringOrNull(body, "agentId");
        const role = optionalRole(body);
        const member = r.members.create({
          projectId,
          kind: requireMemberKind(body),
          displayName: requireString(body, "displayName"),
          ...(agentId === undefined ? {} : { agentId }),
          ...(role === undefined ? {} : { role }),
        });
        log.info("添加项目成员", { projectId, memberId: member.id });
        writeJson(response, 201, { member: memberView(member) });
        return true;
      }
      if (method === "GET") {
        writeJson(response, 200, { members: r.members.listByProject(projectId).map(memberView) });
        return true;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // /api/projects/:id/members/:memberId
    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "members"
    ) {
      const projectId = decodeSegment(segments[2]!);
      const memberId = decodeSegment(segments[4]!);
      requireProject(r, projectId);
      if (method === "DELETE") {
        const member = r.members.get(memberId);
        if (!member || member.projectId !== projectId) {
          throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}。`);
        }
        r.members.delete(memberId);
        log.info("移除项目成员", { projectId, memberId });
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return true;
      }
      methodNotAllowed(response, ["DELETE"]);
      return true;
    }

    // /api/projects/:id/members/:memberId/status —— T2 成员在线/连接状态（基础展示）
    if (
      segments.length === 6 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "members" &&
      segments[5] === "status"
    ) {
      const projectId = decodeSegment(segments[2]!);
      const memberId = decodeSegment(segments[4]!);
      requireProject(r, projectId);
      const member = r.members.get(memberId);
      if (!member || member.projectId !== projectId) {
        throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      if (method === "GET") {
        writeJson(response, 200, { memberStatus: memberStatusView(r, projectId, memberId) });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    // /api/projects/:id/member-statuses —— 列出项目内所有成员的在线/连接状态（T2）
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "member-statuses"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "GET") {
        const list = r.members.listByProject(projectId).map((m) => memberStatusView(r, projectId, m.id));
        writeJson(response, 200, { memberStatuses: list });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    // /api/projects/:id/manager
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "manager"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "PUT") {
        const body = await readObjectBody(request);
        const memberId = requireString(body, "memberId");
        const member = r.members.get(memberId);
        if (!member || member.projectId !== projectId) {
          throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}，无法指定为 manager。`);
        }
        const current = r.members.getManager(projectId);
        if (current && current.id !== memberId) {
          // 支持「更换」：事务内先把旧 manager 降为 normal，再把新成员升为 manager。
          // 顺序保证任一时刻最多一个 manager（部分唯一索引 ux_members_project_manager）。
          r.transaction(() => {
            r.members.update(current.id, { role: "normal" });
            r.members.update(memberId, { role: "manager" });
          });
          log.info("更换项目 manager", { projectId, from: current.id, to: memberId });
        } else if (member.role !== "manager") {
          // 无现有 manager（或已指定同一成员）：仅提升该成员；留空创建后在此首次指定。
          r.members.update(memberId, { role: "manager" });
          log.info("指定项目 manager", { projectId, memberId });
        }
        writeJson(response, 200, { project: projectView(r, r.projects.get(projectId)!) });
        return true;
      }
      methodNotAllowed(response, ["PUT"]);
      return true;
    }

    // /api/projects/:id/groups
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "groups"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "POST") {
        const body = await readObjectBody(request);
        const name = requireString(body, "name");
        const participantMemberIds = optionalStringArray(body, "participantMemberIds");
        const group = r.groups.create({
          projectId,
          name,
          ...(participantMemberIds === undefined ? {} : { participantMemberIds }),
        });
        log.info("创建群组", { projectId, groupId: group.id });
        writeJson(response, 201, { group: groupView(group) });
        return true;
      }
      if (method === "GET") {
        writeJson(response, 200, { groups: r.groups.listByProject(projectId).map(groupView) });
        return true;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // /api/groups/:id/participants
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "groups" &&
      segments[3] === "participants"
    ) {
      const groupId = decodeSegment(segments[2]!);
      const group = r.groups.get(groupId);
      if (!group) throw new RepositoryError("not_found", `群组 ${groupId} 不存在。`);
      if (method === "GET") {
        const participants = r.groups
          .participants(groupId)
          .map((id) => r.members.get(id))
          .filter((m): m is Member => m !== null)
          .map(memberView);
        writeJson(response, 200, { participants });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  function projectView(r: RepositorySet, project: Project) {
    const manager = r.members.getManager(project.id);
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      manager: manager ? memberView(manager) : null,
    };
  }

  function memberView(member: Member) {
    return {
      id: member.id,
      projectId: member.projectId,
      agentId: member.agentId,
      kind: member.kind,
      displayName: member.displayName,
      role: member.role,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    };
  }

  function groupView(group: Group) {
    return {
      id: group.id,
      projectId: group.projectId,
      name: group.name,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /**
   * 成员在线/连接视图（T2）。
   *
   * 把分开建模的两层合并成一个**只读展示**视图：
   * - `connection`：全局 MCP 会话连接状态（connected / disconnected / none），来自 mcp_sessions；
   * - `state`：项目成员运行状态（online/offline/waiting/working），来自 member_statuses；
   * - `lastHeartbeatAt`：最后一次心跳时间（连接层）。
   * 两者始终分开存储；这里只是展示层拼接，不写回、不互相推导。
   */
  function memberStatusView(r: RepositorySet, projectId: string, memberId: string) {
    const member = r.members.get(memberId);
    const status = r.statuses.get(projectId, memberId);
    const session = r.mcpSessions
      .listByProject(projectId)
      .filter((s) => s.memberId === memberId)
      .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1))[0];
    let connection: "connected" | "disconnected" | "none" = "none";
    if (session) connection = session.state === "connected" ? "connected" : "disconnected";
    return {
      memberId,
      projectId,
      displayName: member?.displayName ?? null,
      kind: member?.kind ?? null,
      agentId: member?.agentId ?? null,
      hostType: session?.hostType ?? null,
      connection,
      state: status?.state ?? null,
      lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
      connectedAt: session?.connectedAt ?? null,
      disconnectedAt: session?.disconnectedAt ?? null,
      updatedAt: status?.updatedAt ?? session?.updatedAt ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  function requireProject(r: RepositorySet, projectId: string): Project {
    const project = r.projects.get(projectId);
    if (!project) throw new RepositoryError("not_found", `项目 ${projectId} 不存在。`);
    return project;
  }
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

/** 本模块内部使用的已知 HTTP 语义错误（非 repository 错误）。 */
class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentError(`${field} 必须是非空字符串。`);
  }
  return value;
}

class InvalidArgumentError extends RepositoryError {
  constructor(message: string) {
    super("invalid_argument", message);
  }
}

function requireMemberKind(body: Record<string, unknown>): "human" | "agent" {
  const value = body["kind"];
  if (value !== "human" && value !== "agent") {
    throw new InvalidArgumentError("kind 必须是 human 或 agent。");
  }
  return value;
}

function optionalStringOrNull(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new InvalidArgumentError(`${field} 必须是字符串。`);
  return value;
}

function optionalRole(body: Record<string, unknown>): "manager" | "normal" | undefined {
  const value = body["role"];
  if (value === undefined) return undefined;
  if (value !== "manager" && value !== "normal") {
    throw new InvalidArgumentError("role 必须是 manager 或 normal。");
  }
  return value;
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new InvalidArgumentError(`${field} 必须是字符串数组。`);
  }
  return value as string[];
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function readObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "请求体过大。");
    raw += chunk;
  }
  if (raw.trim() === "") throw new InvalidArgumentError("请求体不能为空，需为 JSON 对象。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "请求体必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function methodNotAllowed(response: ServerResponse, allowed: string[]): void {
  response.setHeader("allow", allowed.join(", "));
  writeError(response, 405, "method_not_allowed", `该路径只支持：${allowed.join(", ")}。`);
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

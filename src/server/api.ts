import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { HeartbeatConfig } from "./config.ts";
import { RepositoryError } from "./db/errors.ts";
import { createRepositories, type RepositorySet } from "./db/repositories.ts";
import type {
  Group,
  Member,
  McpSession,
  Message as DbMessage,
  OrgNode,
  OrgNodeRole,
  Project,
} from "./db/types.ts";
import type { Logger } from "./logger.ts";
import { parseMentions, resolveWakeAndVisibility, type RoutingMember } from "./chat/routing.ts";
import { buildRoster } from "./chat/roster.ts";
import { resetGroupConsecutiveCount } from "./mcp/core.ts";
import { deriveEffectiveStatus } from "./status.ts";
import {
  AUTHZ_ROLES,
  ROLE_CAPABILITIES,
  authorizeOrThrow,
  ForbiddenError,
  visibleGroups,
  type Actor,
  type AuthorizeDecision,
  type Capability,
  type GuardScope,
} from "./authz/authorize.ts";
import { actorForMember, ownerActor } from "./authz/actors.ts";
import { noopOrgChangeRecorder, type OrgChangeRecorder } from "./org-change-hook.ts";

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
 *   （not_found / conflict / archived / invalid_reference / invalid_argument / write_failed），
 *   权限判定拒绝用 F2 守卫的拒绝码（forbidden / out_of_subtree / …，HTTP 403）。
 * - 校验与持久化复用 F2 repository（`createRepositories`），不重复实现唯一 manager 约束；
 *   重复指定 manager 由 repository/唯一索引归一为 ConflictError → HTTP 409（D2）。
 */

/**
 * F2（#47）守卫主体解析上下文。
 *
 * `memberId` 用于「以某个成员为主体」的调用（例如发消息时的 senderMemberId）：
 * 阶段 1 无认证，主体从请求数据推导；接入认证后此处换成认证主体。
 */
export interface ActorResolution {
  readonly request: IncomingMessage;
  /** 本次请求的项目上下文；尚无项目的动作（创建项目）为 null。 */
  readonly projectId: string | null;
  /** 动作归属的成员 ID；省略 = 以请求发起者本身为主体。 */
  readonly memberId?: string;
}

export interface T1ApiOptions {
  readonly db: Database.Database;
  readonly logger: Logger;
  /**
   * T3：人发送消息后，把消息广播给 WebUI（WebSocket）。可选：测试或无 WS 环境时省略。
   * 广播范围（阶段 1）＝ 人在 WebUI 的视角（可见全部群组消息）。
   */
  readonly onMessage?: (message: MessageView) => void;
  /** D4 心跳配置；用于把连接层心跳时间推导为有效状态（T4）。默认 10s/30s。 */
  readonly heartbeat?: HeartbeatConfig;
  /** 服务端时钟；供测试注入 fake timers。默认 `() => new Date()`。 */
  readonly now?: () => Date;
  /**
   * F2（#47）权限守卫的主体解析点。
   * 省略 = 阶段 1 单用户、无认证：调用者一律是「人（owner）」，守卫放行，既有行为不变。
   * T2（#49）/ 未来多用户在此返回真实主体（含 `nodeId` / `subtreeNodeIds`），
   * 权限判定与拒绝码全部沿用 `authorize`，本模块不自行判断。
   */
  readonly resolveActor?: (resolution: ActorResolution) => Actor | null;
  /**
   * T5（#52）审计/撤销接口钩子：本票只在组织/占岗变更处调用，不写 audit_log。
   * 省略时用空实现；T5 注入真实 recorder 即接上统一审计表与人的撤销权。
   */
  readonly orgChangeRecorder?: OrgChangeRecorder;
}

export interface T1ApiRouter {
  /**
   * 尝试处理一个 `/api/...` 请求。
   * 返回 true 表示已处理并写完响应；false 表示路径不归本模块管。
   */
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>;
}

/** T3：消息视图（HTTP 响应与 WebSocket 广播共用）。 */
export interface MessageView {
  readonly id: string;
  readonly groupId: string;
  readonly seq: number;
  readonly senderMemberId: string;
  readonly senderDisplayName: string | null;
  readonly text: string;
  readonly mentions: readonly string[];
  readonly wakeMemberIds: readonly string[];
  readonly visibleMemberIds: readonly string[];
  readonly createdAt: string;
}

/** 错误码 → HTTP 状态。与 repository 层错误码一一对应。 */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  archived: 409,
  invalid_reference: 400,
  invalid_argument: 400,
  write_failed: 500,
};

const MAX_BODY_BYTES = 1_000_000;

/** 永久删除确认凭据的有效期（PROJECT-03：人二次确认；超时需重新发起）。 */
const PURGE_CONFIRM_TTL_MS = 5 * 60 * 1000;

/** 创建 T1 API 路由。日志不记录消息正文等敏感字段（本模块无正文）。 */
export function createT1ApiRouter(options: T1ApiOptions): T1ApiRouter {
  const { db, logger } = options;
  const repos = createRepositories(db);
  const log = logger.child({ component: "api" });
  const heartbeat: HeartbeatConfig = options.heartbeat ?? { intervalMs: 10_000, timeoutMs: 30_000 };
  const now = options.now ?? (() => new Date());

  /**
   * 待确认的永久删除（T1 #48）：`project:<id>` / `group:<id>` → 一次性凭据与到期时间。
   * 第一刀只登记凭据并返回级联清单，带**同一凭据**的第二刀才真正执行清除。
   * 凭据活在进程内（默认 {@link PURGE_CONFIRM_TTL_MS}）：服务重启后失效，需要重新发起，
   * 不会拿旧凭据删掉重启之后的数据。
   *
   * 必须在 `return { handle }` 之前初始化：路由器工厂靠提前 return 暴露句柄，
   * 之后的 `const` 不会被执行到（详见本文件底部的函数声明区）。
   */
  const pendingPurges = new Map<string, { token: string; expiresAt: number }>();

  // T2 #49 / T5 #52：审计钩子缺省空实现。同样必须在提前 return 之前初始化（TDZ 坑）。
  const orgChangeRecorder: OrgChangeRecorder = options.orgChangeRecorder ?? noopOrgChangeRecorder;

  /** 默认主体：阶段 1 的人（owner）；给定 memberId 时用其成员行推导静态角色。 */
  function resolveDefaultActor(r: RepositorySet, resolution: ActorResolution): Actor {
    if (resolution.memberId) {
      const member = r.members.get(resolution.memberId);
      if (member) return actorForMember(member);
    }
    return ownerActor(resolution.projectId);
  }

  /**
   * 守卫式调用：允许则继续执行并返回**主体 + 判定**，拒绝抛 {@link ForbiddenError}
   * （HTTP 403 + 稳定拒绝码）。调用点一律放在参数/引用校验之后，
   * 保证既有失败路径的状态码与错误码不变。
   *
   * 返回判定里的 `conn` 是 #48 行级收窄的输入：列表端点据此只取主体被允许触碰的行
   * （NFR-PROJ-01 / 决策票 #37 的 conn-scoped 强制点），不依赖调用方自律。
   */
  function guard(
    r: RepositorySet,
    request: IncomingMessage,
    capability: Capability,
    scope: GuardScope,
    memberId?: string,
  ): { actor: Actor; decision: Extract<AuthorizeDecision, { allowed: true }> } {
    const resolution: ActorResolution = {
      request,
      projectId: scope.projectId ?? null,
      ...(memberId === undefined ? {} : { memberId }),
    };
    const actor = options.resolveActor
      ? options.resolveActor(resolution)
      : resolveDefaultActor(r, resolution);
    if (actor === null || actor === undefined) {
      throw new ForbiddenError({
        allowed: false,
        capability,
        code: "forbidden",
        reason: "无法确定请求主体，守卫按 fail-closed 拒绝。",
      });
    }
    return { actor, decision: authorizeOrThrow(actor, capability, scope) };
  }

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
        if (error instanceof ForbiddenError) {
          log.info("权限守卫拒绝", { code: error.code, capability: String(error.capability) });
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
        // F2：创建项目 = project:create（阶段 1 默认人=owner 放行；manager 无此能力点）。
        guard(r, request, "project:create", {});
        // #48 / PROJECT-02：可选「创建时指定」顶层 manager（已有全局 agent）；省略 = 留空待分配。
        const managerAgentId = optionalStringOrNull(body, "managerAgentId");
        const project = r.projects.create({
          name: requireString(body, "name"),
          ...(managerAgentId === undefined ? {} : { managerAgentId }),
        });
        log.info("创建项目", { projectId: project.id });
        writeJson(response, 201, { project: projectView(r, project) });
        return true;
      }
      if (method === "GET") {
        // F2：跨项目清单 = overview:view（OVERVIEW-01：仅人 / 顶层 manager 可见）。
        const { decision } = guard(r, request, "overview:view", {});
        const includeArchived = truthyParam(request, "includeArchived");
        // #48 行级收窄：绑定在某项目上的主体（agent 成员）只看得到自己那个项目；
        // 全局主体（阶段 1 的人）conn.projectId = null → 仍看到全部，行为不变。
        const boundProjectId = decision.conn.projectId;
        const projects = r
          .projects.list({ includeArchived })
          .filter((p) => boundProjectId === null || p.id === boundProjectId);
        writeJson(response, 200, { projects: projects.map((p) => projectView(r, p)) });
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
        guard(r, request, "project:view", { projectId: project.id });
        writeJson(response, 200, { project: projectView(r, project) });
        return true;
      }
      if (method === "DELETE") {
        // T1 #48：项目永久删除（PROJECT-03、LIFE-ARC-02），走二次确认流程。
        await purgeProject(r, request, response, projectId);
        return true;
      }
      methodNotAllowed(response, ["GET", "DELETE"]);
      return true;
    }

    // /api/projects/:id/archive 与 /api/projects/:id/restore —— T1 #48 归档 / 恢复
    // （PROJECT-03、LIFE-ARC-01：归档可恢复，不删任何数据；永久删除走 purge 流程）
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      (segments[3] === "archive" || segments[3] === "restore")
    ) {
      const projectId = decodeSegment(segments[2]!);
      const project = requireProject(r, projectId);
      if (method === "POST") {
        // 归档与恢复共用 `project:archive` 能力点：恢复 = 取消归档，权限同位。
        // 顶层 manager 可归档（LIFE-ARC-01），但矩阵里没有 project:purge → 不能永久删除。
        guard(r, request, "project:archive", { projectId: project.id });
        const next =
          segments[3] === "archive" ? r.projects.archive(project.id) : r.projects.restore(project.id);
        log.info(segments[3] === "archive" ? "归档项目" : "恢复项目", { projectId });
        writeJson(response, 200, { project: projectView(r, next) });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
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
        // F2：增成员 = member:manage（ORG-07；下级 manager 的子树限制待 T2 注入节点数据）。
        guard(r, request, "member:manage", { projectId });
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
        guard(r, request, "member:view", { projectId });
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
        // F2：移除成员 = member:manage。
        guard(r, request, "member:manage", { projectId, memberId });
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
        guard(r, request, "status:view", { projectId });
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
        guard(r, request, "status:view", { projectId });
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
        // F2：指定/更换顶层 manager = org:manage（ORG-04：人可撤销、manager 在管辖范围内调整）。
        guard(r, request, "org:manage", { projectId, memberId });
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
        // F2：建群组 = group:create（GROUP-03）。T2 #49：附上参与者岗位节点，
        // 下级 manager 建群时由守卫的 subtree 边界判定「参与者必须全部落在本子树内」（ORG-05）。
        guard(r, request, "group:create", {
          projectId,
          ...(participantMemberIds === undefined
            ? {}
            : {
                groupMemberIds: participantMemberIds,
                groupMemberNodeIds: nodeIdsOfMembers(r, participantMemberIds),
              }),
        });
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
        // 端点级判定 + 行级收窄：`visibleGroups` 只留下主体可见的群组
        // （参与的、全项目岗位看到的全部、或 sub_manager 子树只读可见的）；不可见者不出现。
        // T2 #49：附上 `memberNodeIds`（来自 members.node_id），group:view_subtree 才有判定依据；
        // 升级库无组织数据时全部为 null，owner/普通成员的行为与阶段 1 一致。
        const { actor } = guard(r, request, "group:view", { projectId });
        const includeArchived = truthyParam(request, "includeArchived");
        const candidates = r.groups.listByProject(projectId, { includeArchived });
        const visible = visibleGroups(
          actor,
          candidates.map((g) => {
            const memberIds = r.groups.participants(g.id);
            return { id: g.id, projectId, memberIds, memberNodeIds: nodeIdsOfMembers(r, memberIds) };
          }),
        );
        const byId = new Map(visible.map((v) => [v.id, v.writable]));
        writeJson(response, 200, {
          groups: candidates
            .filter((g) => byId.has(g.id))
            // writable=false = 子树只读可见（可看元数据与历史，不唤醒、不能发言，AC-ORG-07）。
            .map((g) => ({ ...groupView(g), writable: byId.get(g.id)! })),
        });
        return true;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // /api/groups/:id/archive 与 /api/groups/:id/restore —— T1 #48 群组归档 / 恢复
    // （GROUP-04、LIFE-ARC-01：归档可恢复、不删数据；永久删除走 purge 流程）
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "groups" &&
      (segments[3] === "archive" || segments[3] === "restore")
    ) {
      const groupId = decodeSegment(segments[2]!);
      const group = requireGroup(r, groupId);
      if (method === "POST") {
        // 归档与恢复共用 `group:archive`（owner / 顶层 manager / 下级 manager 限子树）。
        guard(r, request, "group:archive", { projectId: group.projectId, groupId });
        const next = segments[3] === "archive" ? r.groups.archive(groupId) : r.groups.restore(groupId);
        log.info(segments[3] === "archive" ? "归档群组" : "恢复群组", {
          projectId: group.projectId,
          groupId,
        });
        writeJson(response, 200, { group: groupView(next) });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
      return true;
    }

    // /api/groups/:id —— T1 #48：GET 单个群组；DELETE 走二次确认的永久删除（只清群聊与参与者关系）
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "groups") {
      const groupId = decodeSegment(segments[2]!);
      if (method === "GET") {
        const group = requireGroup(r, groupId);
        const facts = groupGuardFacts(r, groupId);
        const { actor } = guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...facts,
        });
        // 只读可见性：复用 visibleGroups 的判定给出 writable，供 WebUI 区分「可参与/只读」。
        const [visibility] = visibleGroups(actor, [
          {
            id: groupId,
            projectId: group.projectId,
            memberIds: facts.groupMemberIds,
            memberNodeIds: facts.groupMemberNodeIds,
          },
        ]);
        writeJson(response, 200, { group: groupView(group), writable: visibility?.writable ?? false });
        return true;
      }
      if (method === "DELETE") {
        await purgeGroup(r, request, response, groupId);
        return true;
      }
      methodNotAllowed(response, ["GET", "DELETE"]);
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
        guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...groupGuardFacts(r, groupId),
        });
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

    // /api/groups/:id/messages —— T3 群人消息发送与历史（人的视角，可见全部）
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "groups" &&
      segments[3] === "messages"
    ) {
      const groupId = decodeSegment(segments[2]!);
      const group = r.groups.get(groupId);
      if (!group) throw new RepositoryError("not_found", `群组 ${groupId} 不存在。`);

      if (method === "POST") {
        const body = await readObjectBody(request);
        const senderMemberId = requireString(body, "senderMemberId");
        const text = requireString(body, "text");
        const explicitMentions = optionalStringArray(body, "mentions") ?? [];

        const sender = r.members.get(senderMemberId);
        if (!sender || sender.projectId !== group.projectId) {
          throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不属于该群组所在项目。`);
        }
        if (!r.groups.participants(groupId).includes(senderMemberId)) {
          throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不是该群组参与者。`);
        }
        // F2：发言 = group:post，以发送者为主体（参与范围由 group_participants 判定）。
        // T2 #49：group:post 是 participation 边界——子树只读可见性不会扩成发言权。
        guard(
          r,
          request,
          "group:post",
          { projectId: group.projectId, groupId, ...groupGuardFacts(r, groupId) },
          senderMemberId,
        );

        const roster = buildRosterFor(r, groupId);
        const parsed = parseMentions(text, roster);
        if (parsed.unknownNames.length > 0) {
          throw new RepositoryError("invalid_argument", `无法解析 @ 名称：${parsed.unknownNames.join("、")}。`);
        }
        for (const id of explicitMentions) {
          if (!roster.some((m) => m.id === id)) {
            throw new RepositoryError("invalid_argument", `被 @ 的成员 ${id} 不是该群组参与者。`);
          }
        }
        const mentionIds = [...new Set([...explicitMentions, ...parsed.mentionIds])];
        const plan = resolveWakeAndVisibility(
          { senderMemberId, mentionIds, mentionsAll: parsed.all },
          roster,
        );
        const persistedMentions = [...new Set([...mentionIds, ...plan.allRecipients])];

        const created = r.transaction(() => {
          const message = r.messages.create({
            groupId,
            senderMemberId,
            body: text,
            mentions: persistedMentions,
          });
          for (const memberId of plan.visible) r.deliveries.ensure(message.id, memberId);
          return message;
        });
        const view = messageView(r, created, plan);
        // T7：人类消息重置该群组的「连续自动回复」计数（防环恢复条件之一）。
        if (sender.kind === "human") resetGroupConsecutiveCount(groupId);
        log.info("发送群组消息", { groupId, messageId: created.id, senderMemberId, via: "http" });
        options.onMessage?.(view);
        writeJson(response, 201, { message: view });
        return true;
      }

      if (method === "GET") {
        // F2：历史读取 = group:view。T2 #49：附上参与者岗位节点，
        // sub_manager 对「参与者全部在子树内」的群组可读历史（只读，不唤醒、不能发言）。
        guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...groupGuardFacts(r, groupId),
        });
        const limitRaw = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("limit");
        const limit = limitRaw === null ? 200 : Math.min(Math.max(Number(limitRaw) || 200, 1), 500);
        const all = r.messages.listByGroup(groupId);
        const page = all.slice(Math.max(0, all.length - limit));
        // 人的视角：可见全部群组消息（阶段 1 单群组）。
        writeJson(response, 200, { messages: page.map((m) => messageView(r, m)) });
        return true;
      }

      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // -----------------------------------------------------------------------
    // T2（#49）组织树与角色（ORG-01..08 / AC-ORG-* / AC-PERM-01）
    //
    // 守卫一律用 `org:manage` / `member:manage`（subtree 边界）：scope.nodeId 是目标岗位，
    // sub_manager 越出自己子树即 `out_of_subtree`（ORG-05）；owner / top_manager 全项目放行。
    // 角色是 F2 的静态枚举（ROLE_CAPABILITIES），只读目录随组织树一起返回，供 WebUI 配置入口使用。
    // 变更只经 T5 审计钩子（本票不写 audit_log）。
    // -----------------------------------------------------------------------

    // GET /api/projects/:id/org —— 组织树 + 占岗成员 + 角色能力点目录
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "projects" && segments[3] === "org") {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "GET") {
        guard(r, request, "project:view", { projectId });
        const nodes = r.org.listNodes(projectId);
        const members = r.members.listByProject(projectId);
        writeJson(response, 200, {
          nodes: nodes.map((n) => orgNodeView(n, memberAtNode(r, projectId, n.id))),
          rootId: r.org.getRootNode(projectId)?.id ?? null,
          roles: roleCatalog(),
          members: members.map(memberView),
        });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    // POST /api/projects/:id/org/nodes —— 建岗位（根 = 顶层 manager；子岗位限管理子树）
    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "org" &&
      segments[4] === "nodes"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "POST") {
        const body = await readObjectBody(request);
        const parentId = optionalStringOrNull(body, "parentId") ?? null;
        const name = requireString(body, "name");
        const role = requireOrgNodeRole(body, "role");
        const sortOrder = optionalSortOrder(body);
        // ORG-05：新岗位的父节点必须落在调用者的管辖子树内（root 仅 owner/top_manager 可建）。
        guard(r, request, "org:manage", { projectId, nodeId: parentId });
        const node = r.org.createNode({
          projectId,
          parentId,
          name,
          role,
          ...(sortOrder === undefined ? {} : { sortOrder }),
        });
        orgChangeRecorder.record({
          projectId,
          action: "node.create",
          nodeId: node.id,
          memberId: null,
          detail: { parentId, role, name },
        });
        log.info("创建组织岗位", { projectId, nodeId: node.id, role });
        writeJson(response, 201, { node: orgNodeView(node, null) });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
      return true;
    }

    // POST /api/projects/:id/org/auto-place —— manager 自动分配新成员岗位（ORG-02/08）
    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "org" &&
      segments[4] === "auto-place"
    ) {
      const projectId = decodeSegment(segments[2]!);
      requireProject(r, projectId);
      if (method === "POST") {
        const body = await readObjectBody(request);
        const memberId = requireString(body, "memberId");
        guard(r, request, "member:manage", { projectId });
        const node = r.org.autoPlaceMember(projectId, memberId);
        orgChangeRecorder.record({
          projectId,
          action: "member.auto_place",
          nodeId: node?.id ?? null,
          memberId,
          detail: { placed: node !== null },
        });
        writeJson(response, 200, {
          node: node ? orgNodeView(node, memberAtNode(r, projectId, node.id)) : null,
        });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
      return true;
    }

    // PUT / DELETE /api/org/nodes/:nodeId —— 改岗位（改名/角色/汇报线/排序）与删岗位
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "org" && segments[2] === "nodes") {
      const nodeId = decodeSegment(segments[3]!);
      const node = r.org.getNode(nodeId);
      if (!node) throw new RepositoryError("not_found", `组织岗位 ${nodeId} 不存在。`);
      if (method === "PUT") {
        const body = await readObjectBody(request);
        const name = body["name"] === undefined ? undefined : requireString(body, "name");
        const role = optionalOrgNodeRole(body);
        const parentId = optionalParentId(body);
        const sortOrder = optionalSortOrder(body);
        const patch: Partial<Pick<OrgNode, "name" | "role" | "parentId" | "sortOrder">> = {
          ...(name === undefined ? {} : { name }),
          ...(role === undefined ? {} : { role }),
          ...(parentId === undefined ? {} : { parentId }),
          ...(sortOrder === undefined ? {} : { sortOrder }),
        };
        guard(r, request, "org:manage", { projectId: node.projectId, nodeId: node.id });
        // 改汇报线时，新的父节点也必须落在管辖子树内（防越级搬迁）。
        if (parentId !== undefined && parentId !== null) {
          guard(r, request, "org:manage", { projectId: node.projectId, nodeId: parentId });
        }
        const updated = r.org.updateNode(nodeId, patch);
        orgChangeRecorder.record({
          projectId: node.projectId,
          action: "node.update",
          nodeId,
          memberId: null,
          detail: { patch },
        });
        writeJson(response, 200, { node: orgNodeView(updated, memberAtNode(r, node.projectId, nodeId)) });
        return true;
      }
      if (method === "DELETE") {
        guard(r, request, "org:manage", { projectId: node.projectId, nodeId: node.id });
        r.org.deleteNode(nodeId);
        orgChangeRecorder.record({
          projectId: node.projectId,
          action: "node.delete",
          nodeId,
          memberId: null,
          detail: {},
        });
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return true;
      }
      methodNotAllowed(response, ["PUT", "DELETE"]);
      return true;
    }

    // PUT /api/org/nodes/:nodeId/assignee —— 成员占岗 / 腾岗（一人一岗、人可调整）
    if (
      segments.length === 5 &&
      segments[0] === "api" &&
      segments[1] === "org" &&
      segments[2] === "nodes" &&
      segments[4] === "assignee"
    ) {
      const nodeId = decodeSegment(segments[3]!);
      const node = r.org.getNode(nodeId);
      if (!node) throw new RepositoryError("not_found", `组织岗位 ${nodeId} 不存在。`);
      if (method === "PUT") {
        const body = await readObjectBody(request);
        // memberId 为 null = 腾出该岗位当前占据者；否则把指定成员指派到该岗位。
        const memberId = optionalStringOrNull(body, "memberId") ?? null;
        guard(r, request, "member:manage", { projectId: node.projectId, nodeId: node.id });
        let targetId = memberId;
        if (targetId === null) {
          const current = memberAtNode(r, node.projectId, nodeId);
          if (!current) {
            writeJson(response, 200, { member: null });
            return true;
          }
          targetId = current.id;
        }
        const member = r.org.assignNode(targetId, memberId === null ? null : nodeId);
        orgChangeRecorder.record({
          projectId: node.projectId,
          action: "node.assign",
          nodeId,
          memberId: targetId,
          detail: { assigned: memberId !== null },
        });
        writeJson(response, 200, { member: memberView(member) });
        return true;
      }
      methodNotAllowed(response, ["PUT"]);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 永久删除的二次确认（PROJECT-03 / LIFE-ARC-01）
  // -------------------------------------------------------------------------
  // 注：待确认凭据表 `pendingPurges` 在路由器工厂顶部初始化（必须早于 `return { handle }`，
  // 否则该 `const` 永远不会执行到，这里只是复用同一个闭包变量）。

  function issuePurgeConfirmation(key: string): { token: string; expiresAt: number } {
    const entry = { token: randomUUID(), expiresAt: Date.now() + PURGE_CONFIRM_TTL_MS };
    pendingPurges.set(key, entry);
    return entry;
  }

  /**
   * 校验并消费确认凭据（一次性：成功执行后立刻失效）。
   * 凭据**不对或已过期时不消费**——失败重试仍用同一凭据即可，不必重新发起；
   * 过期后（{@link PURGE_CONFIRM_TTL_MS}）必须重新拿一份最新的级联清单。
   */
  function consumePurgeConfirmation(key: string, token: string): boolean {
    const entry = pendingPurges.get(key);
    if (entry === undefined) return false;
    if (entry.token !== token || entry.expiresAt < Date.now()) return false;
    pendingPurges.delete(key);
    return true;
  }

  /**
   * 永久删除的一刀两拍（#48：PROJECT-03 / GROUP-04 共用同一流程）。
   *
   * 第一刀不删，只返回级联清单与一次性确认凭据；第二刀带同一凭据才执行 {@link PurgeFlow.execute}。
   * 守卫（能力点）在取凭据之前判定：manager 主体连清单都拿不到（403），人必须确认两次。
   */
  interface PurgeFlow {
    /** 待确认表键：`project:<id>` / `group:<id>`。 */
    readonly key: string;
    readonly capability: Capability;
    readonly scope: GuardScope;
    /** 确认载荷里的资源字段（kind/id/名称/归档位……），随级联清单一起返回。 */
    readonly resource: () => Record<string, unknown>;
    /** 第一刀给「人」看的可读说明：会清掉什么、能不能反悔。 */
    readonly ask: () => string;
    /** 日志事件名。 */
    readonly event: string;
    /** 第一刀的级联清单（只读）。 */
    readonly preview: () => unknown;
    /** 第二刀的实际清除，返回清除行数。 */
    readonly execute: () => unknown;
  }

  async function purgeWithConfirmation(
    r: RepositorySet,
    flow: PurgeFlow,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    guard(r, request, flow.capability, flow.scope);
    const body = await readOptionalObjectBody(request);
    const confirm = typeof body["confirm"] === "string" ? (body["confirm"] as string) : null;

    if (confirm === null) {
      const cascade = flow.preview();
      const entry = issuePurgeConfirmation(flow.key);
      log.info(`${flow.event}：等待二次确认`, { cascade });
      writeJson(response, 409, {
        error: { code: "confirmation_required", message: flow.ask() },
        confirmation: {
          ...flow.resource(),
          cascade,
          token: entry.token,
          expiresAt: new Date(entry.expiresAt).toISOString(),
        },
      });
      return;
    }

    if (!consumePurgeConfirmation(flow.key, confirm)) {
      throw new HttpError(
        400,
        "invalid_confirmation",
        "永久删除的确认凭据无效或已过期，请重新发起以获取最新的级联清单与凭据。",
      );
    }

    const cleared = flow.execute();
    log.info(`${flow.event}：已清除`, { cleared });
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  /** `DELETE /api/projects/:id`：永久删除项目并级联清除其群组/群聊/成员与状态（PROJECT-03、LIFE-ARC-02）。 */
  async function purgeProject(
    r: RepositorySet,
    request: IncomingMessage,
    response: ServerResponse,
    projectId: string,
  ): Promise<void> {
    const project = requireProject(r, projectId);
    await purgeWithConfirmation(
      r,
      {
        key: `project:${project.id}`,
        // 只有「人（owner）」持有 project:purge；顶层 manager 没有 → 403（LIFE-ARC-01）。
        capability: "project:purge",
        scope: { projectId: project.id },
        resource: () => ({
          kind: "project",
          projectId: project.id,
          projectName: project.name,
          archivedAt: project.archivedAt,
        }),
        ask: () =>
          `永久删除项目「${project.name}」会级联清除它的群组、群聊消息、投递、成员与状态，且不可恢复。` +
          "确认无误后请带 confirmation.token 重新发起 DELETE。",
        event: "永久删除项目",
        preview: () => r.projects.previewPurge(project.id),
        execute: () => r.projects.purge(project.id),
      },
      request,
      response,
    );
  }

  /**
   * `DELETE /api/groups/:id`：与项目同构的二次确认流程，但级联范围**只到群聊与参与者关系**
   * （LIFE-ARC-02）：项目成员、其所在其他群组、成员状态都保持不变。
   */
  async function purgeGroup(
    r: RepositorySet,
    request: IncomingMessage,
    response: ServerResponse,
    groupId: string,
  ): Promise<void> {
    const group = requireGroup(r, groupId);
    await purgeWithConfirmation(
      r,
      {
        key: `group:${group.id}`,
        // `group:purge` 同样只有人持有（LIFE-ARC-01）。
        capability: "group:purge",
        scope: { projectId: group.projectId, groupId: group.id },
        resource: () => ({
          kind: "group",
          projectId: group.projectId,
          groupId: group.id,
          groupName: group.name,
          archivedAt: group.archivedAt,
        }),
        ask: () =>
          `永久删除群组「${group.name}」会清除它的群聊消息与参与者关系，且不可恢复；项目成员本身不受影响。` +
          "确认后请带 confirmation.token 重新发起 DELETE。",
        event: "永久删除群组",
        preview: () => r.groups.previewPurge(group.id),
        execute: () => r.groups.purge(group.id),
      },
      request,
      response,
    );
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** T3：从群组参与者构建路由 roster（在线以 connected MCP 会话为准，人视为在线）。 */
  function buildRosterFor(r: RepositorySet, groupId: string): RoutingMember[] {
    return buildRoster(r, groupId);
  }

  /** 消息视图（HTTP/WS 共用）。 */
  function messageView(r: RepositorySet, message: DbMessage, plan?: { wake: readonly string[]; visible: readonly string[] }): MessageView {
    const sender = r.members.get(message.senderMemberId);
    const resolvedPlan =
      plan ??
      resolveWakeAndVisibility(
        { senderMemberId: message.senderMemberId, mentionIds: message.mentions, mentionsAll: false },
        buildRosterFor(r, message.groupId),
      );
    return {
      id: message.id,
      groupId: message.groupId,
      seq: message.seq,
      senderMemberId: message.senderMemberId,
      senderDisplayName: sender?.displayName ?? null,
      text: message.body,
      mentions: message.mentions,
      wakeMemberIds: resolvedPlan.wake,
      visibleMemberIds: resolvedPlan.visible,
      createdAt: message.createdAt,
    };
  }

  function projectView(r: RepositorySet, project: Project) {
    const manager = r.members.getManager(project.id);
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      // T1 #48：归档时间（null = 未归档）。归档对象默认不出现在列表里，但形状一致。
      archivedAt: project.archivedAt,
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
      // T2 #49：占岗锚点（null = 未落位；阶段 1 升级库一律为 null）。
      nodeId: member.nodeId,
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
      // T1 #48：归档时间（null = 未归档）。
      archivedAt: group.archivedAt,
    };
  }

  /** T2 #49：岗位节点视图，附带「谁占据该岗位」。 */
  function orgNodeView(node: OrgNode, member: Member | null) {
    return {
      id: node.id,
      projectId: node.projectId,
      parentId: node.parentId,
      name: node.name,
      role: node.role,
      sortOrder: node.sortOrder,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      memberId: member?.id ?? null,
      memberDisplayName: member?.displayName ?? null,
    };
  }

  /** 某岗位当前的占据成员（一人一岗，至多一个）。 */
  function memberAtNode(r: RepositorySet, projectId: string, nodeId: string): Member | null {
    return r.members.listByProject(projectId).find((m) => m.nodeId === nodeId) ?? null;
  }

  /** T2 #49：角色目录（F2 静态枚举 + 能力点矩阵），WebUI 角色配置入口的数据来源。 */
  function roleCatalog() {
    return AUTHZ_ROLES.map((role) => ({
      role,
      capabilities: [...ROLE_CAPABILITIES[role]],
      // owner 是人的内建全局主体，不建立组织岗位节点。
      nodeRole: role !== "owner",
    }));
  }

  /** 参与者各自的岗位节点（顺序与 memberIds 对齐）；未落位用 null（升级库全部 null）。 */
  function nodeIdsOfMembers(r: RepositorySet, memberIds: readonly string[]): (string | null)[] {
    return memberIds.map((id) => r.members.get(id)?.nodeId ?? null);
  }

  /**
   * T2 #49：群组参与事实（成员 + 岗位节点），供 F2 守卫的 subtree 边界与
   * `group:view_subtree` 只读可见性判定（ORG-03 / #32 / AC-ORG-07）。
   */
  function groupGuardFacts(r: RepositorySet, groupId: string): {
    groupMemberIds: string[];
    groupMemberNodeIds: (string | null)[];
  } {
    const groupMemberIds = r.groups.participants(groupId);
    return { groupMemberIds, groupMemberNodeIds: nodeIdsOfMembers(r, groupMemberIds) };
  }

  /**
   * 成员在线/连接视图（T2 建立，T4 扩展为「有效状态」）。
   *
   * 把分开建模的两层合并成一个**只读展示**视图（D1）：
   * - `connection`：全局 MCP 会话连接状态（connected / disconnected / none），来自 mcp_sessions；
   * - `state`：项目成员运行状态（online/offline/waiting/working），由
   *   {@link deriveEffectiveStatus} 结合心跳超时（D4）推导；
   * - `lastHeartbeatAt`：最后一次心跳时间（连接层），供前端本地判定陈旧/心跳超时。
   * 两层始终分开存储；这里只是展示层推导，不写回、不互相落库。
   */
  function memberStatusView(r: RepositorySet, projectId: string, memberId: string) {
    const member = r.members.get(memberId);
    const status = r.statuses.get(projectId, memberId);
    const session = latestSession(r, projectId, memberId);
    const effective = deriveEffectiveStatus({
      projectId,
      memberId,
      kind: member?.kind ?? "agent",
      displayName: member?.displayName ?? "",
      storedState: status?.state ?? null,
      session,
      heartbeat,
      now: now(),
    });
    return {
      memberId,
      projectId,
      displayName: member?.displayName ?? null,
      kind: member?.kind ?? null,
      agentId: member?.agentId ?? null,
      hostType: effective.hostType,
      connection: effective.connection,
      state: effective.state,
      stale: effective.stale,
      disconnected: effective.disconnected,
      heartbeatTimedOut: effective.heartbeatTimedOut,
      heartbeatStale: effective.heartbeatStale,
      lastHeartbeatAt: effective.lastHeartbeatAt,
      connectedAt: effective.connectedAt,
      disconnectedAt: effective.disconnectedAt,
      updatedAt: status?.updatedAt ?? session?.updatedAt ?? null,
    };
  }

  /** 某成员最近一次 MCP 会话（含已断开历史）。 */
  function latestSession(r: RepositorySet, projectId: string, memberId: string): McpSession | null {
    let best: McpSession | null = null;
    for (const s of r.mcpSessions.listByProject(projectId)) {
      if (s.memberId !== memberId) continue;
      if (best === null || `${s.connectedAt}|${s.updatedAt}` > `${best.connectedAt}|${best.updatedAt}`) best = s;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  function requireProject(r: RepositorySet, projectId: string): Project {
    const project = r.projects.get(projectId);
    if (!project) throw new RepositoryError("not_found", `项目 ${projectId} 不存在。`);
    return project;
  }

  /** T1 #48：群组定位（归档/恢复/永久删除共用）；不存在 → 404。 */
  function requireGroup(r: RepositorySet, groupId: string): Group {
    const group = r.groups.get(groupId);
    if (!group) throw new RepositoryError("not_found", `群组 ${groupId} 不存在。`);
    return group;
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

/** T2 #49：岗位角色是静态枚举，且 owner（人）不建岗位节点。 */
function isNodeRole(value: unknown): value is OrgNodeRole {
  return value === "top_manager" || value === "sub_manager" || value === "member";
}

function requireOrgNodeRole(body: Record<string, unknown>, field: string): OrgNodeRole {
  const value = body[field];
  if (!isNodeRole(value)) {
    throw new InvalidArgumentError(
      `${field} 必须是 top_manager / sub_manager / member（owner 是人的内建角色，不建岗位）。`,
    );
  }
  return value;
}

function optionalOrgNodeRole(body: Record<string, unknown>): OrgNodeRole | undefined {
  const value = body["role"];
  if (value === undefined) return undefined;
  return requireOrgNodeRole(body, "role");
}

/** 区分「未提供」(undefined) 与「显式置空」(null)：后者表示把岗位移到根层（repository 会拒绝）。 */
function optionalParentId(body: Record<string, unknown>): string | null | undefined {
  const value = body["parentId"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new InvalidArgumentError("parentId 必须是字符串或 null。");
  return value;
}

function optionalSortOrder(body: Record<string, unknown>): number | undefined {
  const value = body["sortOrder"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidArgumentError("sortOrder 必须是有限数字。");
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

/** 查询串里的布尔开关：`?x=1|true` 视为真，其余（含缺省）为假。 */
function truthyParam(request: IncomingMessage, name: string): boolean {
  const value = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(name);
  return value === "1" || value === "true";
}

async function readObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(request);
  if (raw.trim() === "") throw new InvalidArgumentError("请求体不能为空，需为 JSON 对象。");
  return parseObjectBody(raw);
}

/**
 * 可选 JSON 体：空体返回 `{}`。用于 `DELETE …?二次确认` 这类「带不带确认凭据都合法」的调用
 * （T1 #48 永久删除的第一刀就没有请求体）。
 */
async function readOptionalObjectBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(request);
  if (raw.trim() === "") return {};
  return parseObjectBody(raw);
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  let raw = "";
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "请求体过大。");
    raw += chunk;
  }
  return raw;
}

function parseObjectBody(raw: string): Record<string, unknown> {
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

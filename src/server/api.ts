import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { HeartbeatConfig } from "./config.ts";
import { RepositoryError } from "./db/errors.ts";
import { createRepositories, type RepositorySet } from "./db/repositories.ts";
import type { Group, Member, McpSession, Message as DbMessage, Project } from "./db/types.ts";
import type { Logger } from "./logger.ts";
import { parseMentions, resolveWakeAndVisibility, type RoutingMember } from "./chat/routing.ts";
import { buildRoster } from "./chat/roster.ts";
import { resetGroupConsecutiveCount } from "./mcp/core.ts";
import { deriveEffectiveStatus } from "./status.ts";
import {
  authorizeOrThrow,
  ForbiddenError,
  type Actor,
  type Capability,
  type GuardScope,
} from "./authz/authorize.ts";
import { actorForMember, ownerActor } from "./authz/actors.ts";

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
 *   （not_found / conflict / invalid_reference / invalid_argument / write_failed），
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
  const heartbeat: HeartbeatConfig = options.heartbeat ?? { intervalMs: 10_000, timeoutMs: 30_000 };
  const now = options.now ?? (() => new Date());

  /** 默认主体：阶段 1 的人（owner）；给定 memberId 时用其成员行推导静态角色。 */
  function resolveDefaultActor(r: RepositorySet, resolution: ActorResolution): Actor {
    if (resolution.memberId) {
      const member = r.members.get(resolution.memberId);
      if (member) return actorForMember(member);
    }
    return ownerActor(resolution.projectId);
  }

  /**
   * 守卫式调用：允许则继续执行，拒绝抛 {@link ForbiddenError}（HTTP 403 + 稳定拒绝码）。
   * 调用点一律放在参数/引用校验之后，保证既有失败路径的状态码与错误码不变。
   */
  function guard(
    r: RepositorySet,
    request: IncomingMessage,
    capability: Capability,
    scope: GuardScope,
    memberId?: string,
  ): void {
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
    authorizeOrThrow(actor, capability, scope);
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
        const project = r.projects.create({ name: requireString(body, "name") });
        log.info("创建项目", { projectId: project.id });
        writeJson(response, 201, { project: projectView(r, project) });
        return true;
      }
      if (method === "GET") {
        // F2：跨项目清单 = overview:view（OVERVIEW-01：仅人 / 顶层 manager 可见）。
        guard(r, request, "overview:view", {});
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
        guard(r, request, "project:view", { projectId: project.id });
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
        // F2：建群组 = group:create（GROUP-03；下级 manager 限子树等 T2 注入节点数据后生效）。
        guard(r, request, "group:create", {
          projectId,
          ...(participantMemberIds === undefined ? {} : { groupMemberIds: participantMemberIds }),
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
        // 端点级判定；「我看到哪些群组」的行级收窄由守卫的 `visibleGroups` 负责（T1/T2/T4 复用）。
        guard(r, request, "group:view", { projectId });
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
        guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          groupMemberIds: r.groups.participants(groupId),
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
        guard(
          r,
          request,
          "group:post",
          { projectId: group.projectId, groupId, groupMemberIds: r.groups.participants(groupId) },
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
        // F2：历史读取 = group:view（可见性判定；阶段 1 人是 owner → 全部可见，行为不变）。
        guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          groupMemberIds: r.groups.participants(groupId),
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

    return false;
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

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbDriver } from "./db/driver.ts";
import type { HeartbeatConfig } from "./config.ts";
import { RepositoryError } from "./db/errors.ts";
import { createRepositories, type PurgeSnapshot, type RepositorySet } from "./db/repositories.ts";
import { purgeDiscovery } from "./db/coordinated-repositories.ts";
import type {
  Group,
  Member,
  MemberLifecycleStatus,
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
import { createTaskService } from "./tasks/service.ts";
import { createIdentityApi } from "./identity/api.ts";
import { createWorkspaceApi, writeWorkspaceError } from "./workspace/api.ts";
import { WorkspaceError } from "./workspace/errors.ts";
import type { ResolvedBoardroomEnvironment } from "./environment.ts";
import { createOrgMutationService } from "./org/mutations.ts";
import { createAuditCompensationService } from "./audit-compensation.ts";
import { createOrgHttpCommands } from "./org/http-commands.ts";
import type { OrgMutationAccess } from "./org/compensation-types.ts";
import { authorizeMutation } from "./org/boundary.ts";
import { buildStatusBoard, deriveEffectiveStatus } from "./status.ts";
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
import { noopOrgChangeRecorder, type OrgChangeRecorder, type OrgChange } from "./org-change-hook.ts";
import {
  AUDIT_ACTIONS,
  appendAuditEntry,
  auditActorFrom,
  auditView,
  revokeUnavailableReason,
  type AuditAction,
  type AuditEntry,
  type AuditRow,
  type AuditTargetKind,
} from "./audit.ts";

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
  readonly db: DbDriver;
  /** 生产入口注入已选择的 S4 环境，不重新推导数据库或保护范围。 */
  readonly environment?: ResolvedBoardroomEnvironment;
  readonly repos?: RepositorySet;
  readonly logger: Logger;
  /**
   * T3：人发送消息后，把消息广播给 WebUI（WebSocket）。可选：测试或无 WS 环境时省略。
   * 广播范围（阶段 1）＝ 人在 WebUI 的视角（可见全部群组消息）。
   */
  readonly onMessage?: (message: MessageView) => void | Promise<void>;
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
  readonly resolveActor?: (resolution: ActorResolution) => Promise<Actor | null>;
  /**
   * 提交后观察钩子；权威审计由 mutation service 与业务在同一事务写入。
   * 观察失败被记录，不改变已提交结果或对外成功响应。
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
  readonly senderRemoved: boolean;
  readonly senderDisplayName: string | null;
  readonly text: string;
  readonly mentions: readonly string[];
  readonly wakeMemberIds: readonly string[];
  readonly visibleMemberIds: readonly string[];
  readonly createdAt: string;
}

/** HTTP 历史、发送响应与提交后的 WebSocket 广播共用同一视图。 */
export async function messageView(r: RepositorySet, message: DbMessage, plan?: { wake: readonly string[]; visible: readonly string[] }): Promise<MessageView> {
  const sender = await r.members.getIncludingRemoved(message.senderMemberId);
  const resolvedPlan = plan ?? resolveWakeAndVisibility(
    { senderMemberId: message.senderMemberId, mentionIds: message.mentions, mentionsAll: false },
    await buildRoster(r, message.groupId),
  );
  return {
    id: message.id,
    groupId: message.groupId,
    seq: message.seq,
    senderMemberId: message.senderMemberId,
    senderDisplayName: sender?.displayName ?? null,
    senderRemoved: sender?.removedAt != null,
    text: message.body,
    mentions: message.mentions,
    wakeMemberIds: resolvedPlan.wake,
    visibleMemberIds: resolvedPlan.visible,
    createdAt: message.createdAt,
  };
}

/** 错误码 → HTTP 状态。与 repository 层错误码一一对应。 */
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  archived: 409,
  invalid_reference: 400,
  invalid_argument: 400,
  write_failed: 500,
  mutation_scope_changed: 409, member_removed: 409, compensation_conflict: 409,
  legacy_incomplete_snapshot: 409, chain_broken: 409,
  audit_snapshot_too_large: 409, audit_capture_budget_exceeded: 409,
  confirmation_changed: 409,
};

const MAX_BODY_BYTES = 1_000_000;

/** 永久删除确认凭据的有效期（PROJECT-03：人二次确认；超时需重新发起）。 */
const PURGE_CONFIRM_TTL_MS = 5 * 60 * 1000;

/** 创建 T1 API 路由。日志不记录消息正文等敏感字段（本模块无正文）。 */
export function createT1ApiRouter(options: T1ApiOptions): T1ApiRouter {
  const { db, logger } = options;
  const repos = options.repos ?? createRepositories(db);
  const tasks = createTaskService({ repos });
  const log = logger.child({ component: "api" });
  const heartbeat: HeartbeatConfig = options.heartbeat ?? { intervalMs: 10_000, timeoutMs: 30_000 };
  const now = options.now ?? (() => new Date());
  const orgMutations = createOrgMutationService({ repos, now });
  const compensations = createAuditCompensationService({ repos, now });
  const orgCommands = createOrgHttpCommands({ repos, now });
  const identityApi = createIdentityApi({ ...options, repos });
  const workspaceApi = createWorkspaceApi({ ...options, repos });

  /**
   * 待确认的永久删除（T1 #48）：`project:<id>` / `group:<id>` → 一次性凭据与到期时间。
   * 第一刀只登记凭据并返回级联清单，带**同一凭据**的第二刀才真正执行清除。
   * 凭据活在进程内（默认 {@link PURGE_CONFIRM_TTL_MS}）：服务重启后失效，需要重新发起，
   * 不会拿旧凭据删掉重启之后的数据。
   *
   * 必须在 `return { handle }` 之前初始化：路由器工厂靠提前 return 暴露句柄，
   * 之后的 `const` 不会被执行到（详见本文件底部的函数声明区）。
   */
  type PendingPurge = { token: string; expiresAt: number; snapshot: PurgeSnapshot<Project | Group, unknown> };
  const pendingPurges = new Map<string, PendingPurge>();

  // T2 #49 / T5 #52：审计钩子缺省空实现。同样必须在提前 return 之前初始化（TDZ 坑）。
  const orgChangeRecorder: OrgChangeRecorder = options.orgChangeRecorder ?? noopOrgChangeRecorder;
  function notifyOrgChange(change: OrgChange): void {
    void Promise.resolve().then(() => orgChangeRecorder.record(change)).catch(error => {
      log.warn("org_change_observer_failed", { error, projectId: change.projectId, action: change.action });
    });
  }
  function mutationAccess(actor: Actor, request: IncomingMessage, response: ServerResponse): OrgMutationAccess {
    const controller = new AbortController();
    if (request.aborted || response.destroyed) controller.abort();
    request.once("aborted", () => controller.abort());
    response.once?.("close", () => { if (!response.writableEnded) controller.abort(); });
    return { actor, signal: controller.signal };
  }


  async function withHttpMutation<T>(r: RepositorySet, projectId: string, memberIds: readonly string[], groupIds: readonly string[], body: () => Promise<T>): Promise<T> {
    const wantedMembers = [...new Set(memberIds)], wantedGroups = [...new Set(groupIds)];
    if (wantedMembers.length > 2048 || wantedGroups.length > 2048) throw new RepositoryError("mutation_scope_changed", "变更目标超过有界范围。");
    return r.transaction(() => r.mutations.run({ projectIds: [projectId], discover: async tx => {
      const rows = await tx.query<{ id: string }>(`SELECT DISTINCT m.id FROM members m LEFT JOIN group_participants gp ON gp.member_id = m.id
        WHERE m.project_id = ? AND (m.id IN (${wantedMembers.map(() => "?").join(",") || "NULL"})
          OR gp.group_id IN (${wantedGroups.map(() => "?").join(",") || "NULL"})) ORDER BY m.id LIMIT 2049`, [projectId, ...wantedMembers, ...wantedGroups]);
      if (rows.length > 2048) throw new RepositoryError("mutation_scope_changed", "实际变更成员超过有界范围。");
      const groups = wantedGroups.length ? await tx.query<{ id: string }>(`SELECT id FROM groups WHERE project_id = ? AND id IN (${wantedGroups.map(() => "?").join(",")}) ORDER BY id`, [projectId, ...wantedGroups]) : [];
      return { memberIds: rows.map(row => row.id), groupIds: groups.map(row => row.id), runtimeIds: [] };
    } }, body));
  }

  /** 默认主体：阶段 1 的人（owner）；给定 memberId 时用其成员行推导静态角色。 */
  async function resolveDefaultActor(r: RepositorySet, resolution: ActorResolution): Promise<Actor> {
    if (resolution.memberId) {
      const member = (await (r.members.get(resolution.memberId)));
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
  async function guard(
    r: RepositorySet,
    request: IncomingMessage,
    capability: Capability,
    scope: GuardScope,
    memberId?: string,
  ): Promise<{ actor: Actor; decision: Extract<AuthorizeDecision, { allowed: true }> }> {
    const resolution: ActorResolution = {
      request,
      projectId: scope.projectId ?? null,
      ...(memberId === undefined ? {} : { memberId }),
    };
    const actor = options.resolveActor
      ? await (options.resolveActor(resolution))
      : await (resolveDefaultActor(r, resolution));
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

  /**
   * T5（#52）审计埋点：经 F2 守卫解析出的真实主体，把变更写入 `audit_log`。
   * `before/after` 传领域对象即可（成员 / 组织节点 / 项目 / 群组快照）；`null`
   * 表示「事前/事后不存在」（创建 / 删除类事件）。供组织与成员变更的补偿撤销使用。
   */
  async function recordAudit(actor: Actor, entry: Omit<AuditEntry, "actor">): Promise<AuditRow> {
    return await (appendAuditEntry(repos.audit, { actor: auditActorFrom(actor), ...entry }));
  }

  /** 撤销被拒绝时的中文说明（前端据此置灰并说明原因）。 */
  const REVOKE_REASON_MESSAGE: Record<string, string> = {
    permanent_delete: "永久删除不可撤销。",
    forward_reversible: "归档/恢复属于状态本身可逆，请用正向操作复原，不提供撤销入口。",
    action_not_revocable: "该操作类型不可撤销。",
    truncated: "该审计事件因字段过长被截断，缺少完整快照，不可撤销。",
  };

  return {
    async handle(request, response, pathname) {
      const method = request.method ?? "GET";
      try {
        if (await identityApi.handle(request, response, pathname)) return true;
        if (await workspaceApi.handle(request, response, pathname)) return true;
        return await route(repos, request, response, method, pathname);
      } catch (error) {
        if (error instanceof WorkspaceError) { writeWorkspaceError(response, error); return true; }
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
        const { actor } = await guard(r, request, "project:create", {});
        // #48 / PROJECT-02：可选「创建时指定」顶层 manager（已有全局 agent）；省略 = 留空待分配。
        const managerAgentId = optionalStringOrNull(body, "managerAgentId");
        const input = {
          name: requireString(body, "name"),
          ...(managerAgentId === undefined ? {} : { managerAgentId }),
        };
        const configured = Object.hasOwn(body, "workspace") ? await workspaceApi.createProject(request, actor, input, body["workspace"]) : null;
        const project = configured?.project ?? await r.projects.create(input);
        log.info("创建项目", { projectId: project.id });
        writeJson(response, 201, { project: (await (projectView(r, project))), ...(configured ? { workspace: configured.workspace.workspace, workspaceRef: configured.workspace.workspaceRef } : {}) });
        return true;
      }
      if (method === "GET") {
        // F2：跨项目清单 = overview:view（OVERVIEW-01：仅人 / 顶层 manager 可见）。
        const { decision } = (await (guard(r, request, "overview:view", {})));
        const includeArchived = truthyParam(request, "includeArchived");
        // #48 行级收窄：绑定在某项目上的主体（agent 成员）只看得到自己那个项目；
        // 全局主体（阶段 1 的人）conn.projectId = null → 仍看到全部，行为不变。
        const boundProjectId = decision.conn.projectId;
        const projects = (await (r
          .projects.list({ includeArchived })))
          .filter((p) => boundProjectId === null || p.id === boundProjectId);
        writeJson(response, 200, { projects: (await Promise.all(projects.map(async (p) => (await (projectView(r, p)))))) });
        return true;
      }
      methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }

    // /api/projects/:id
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "projects") {
      const projectId = decodeSegment(segments[2]!);
      if (method === "GET") {
        const project = (await (requireProject(r, projectId)));
        (await (guard(r, request, "project:view", { projectId: project.id })));
        writeJson(response, 200, { project: (await (projectView(r, project))) });
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
      const project = (await (requireProject(r, projectId)));
      if (method === "POST") {
        // 归档与恢复共用 `project:archive` 能力点：恢复 = 取消归档，权限同位。
        // 顶层 manager 可归档（LIFE-ARC-01），但矩阵里没有 project:purge → 不能永久删除。
        const { actor } = (await (guard(r, request, "project:archive", { projectId: project.id })));
        const next = await withHttpMutation(r, projectId, actor.kind === "agent" ? [actor.actorId] : [], [], async () => {
          const current = await requireProject(r, projectId);
          await authorizeMutation(r, { actor }, "project:archive", { projectId });
          const updated = segments[3] === "archive" ? await r.projects.archive(projectId) : await r.projects.restore(projectId);
          await recordAudit(actor, {
            projectId, action: segments[3] === "archive" ? AUDIT_ACTIONS.project_archive : AUDIT_ACTIONS.project_restore,
            targetKind: "project", targetId: projectId, targetName: current.name, before: current, after: updated,
          });
          return updated;
        });
        log.info(segments[3] === "archive" ? "归档项目" : "恢复项目", { projectId });
        writeJson(response, 200, { project: (await (projectView(r, next))) });
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
      (await (requireProject(r, projectId)));
      if (method === "POST") {
        const body = await readObjectBody(request);
        const agentId = optionalStringOrNull(body, "agentId");
        const role = optionalRole(body);
        const status = optionalLifecycleStatus(body);
        // F2：增成员 = member:manage（ORG-07；下级 manager 的子树限制待 T2 注入节点数据）。
        const { actor } = (await (guard(r, request, "member:manage", { projectId })));
        const { member } = await orgMutations.addMember(mutationAccess(actor, request, response), {
          projectId,
          kind: requireMemberKind(body),
          displayName: requireString(body, "displayName"),
          ...(agentId === undefined ? {} : { agentId }),
          ...(role === undefined ? {} : { role }),
          // T3 #50：可显式登记为 pending（待激活）；省略 = active（阶段 1 行为不变）。
          ...(status === undefined ? {} : { status }),
        });
        log.info("添加项目成员", { projectId, memberId: member.id });
        writeJson(response, 201, { member: memberView(member) });
        return true;
      }
      if (method === "GET") {
        (await (guard(r, request, "member:view", { projectId })));
        writeJson(response, 200, { members: (await (r.members.listByProject(projectId))).map(memberView) });
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
      (await (requireProject(r, projectId)));
      if (method === "DELETE") {
        const member = (await (r.members.get(memberId)));
        if (!member || member.projectId !== projectId) {
          throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}。`);
        }
        // F2：移除成员 = member:manage。
        const { actor } = (await (guard(r, request, "member:manage", { projectId, memberId })));
        await orgMutations.removeMember(mutationAccess(actor, request, response), projectId, memberId);
        log.info("移除项目成员", { projectId, memberId });
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return true;
      }
      methodNotAllowed(response, ["DELETE"]);
      return true;
    }

    // T3（#50）成员生命周期：暂停 / 恢复 / 通用状态转换（LIFE-MEM-01/02、ORG-07）。
    // 三个动作都经 F2 `member:manage` 守卫（subtree 边界：目标成员的岗位节点作为判定输入），
    // 且**无需逐次确认**（与 T1 的永久删除二次确认流程区分）；状态机在 members repository。
    if (
      segments.length === 6 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "members" &&
      (segments[5] === "disable" || segments[5] === "enable" || segments[5] === "lifecycle")
    ) {
      const projectId = decodeSegment(segments[2]!);
      const memberId = decodeSegment(segments[4]!);
      const action = segments[5]!;
      (await (requireProject(r, projectId)));
      const member = (await (r.members.get(memberId)));
      if (!member || member.projectId !== projectId) {
        throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      const allowed = action === "lifecycle" ? ["PUT"] : ["POST"];
      if (method !== allowed[0]) {
        methodNotAllowed(response, allowed);
        return true;
      }
      let status: MemberLifecycleStatus;
      let hookAction: "member.disable" | "member.enable" | "member.status_change";
      if (action === "disable") {
        status = "disabled";
        hookAction = "member.disable";
      } else if (action === "enable") {
        status = "active";
        hookAction = "member.enable";
      } else {
        status = requireLifecycleStatus(await readObjectBody(request));
        hookAction = "member.status_change";
      }
      const { actor } = (await (guard(r, request, "member:manage", { projectId, nodeId: member.nodeId })));
      const from = member.status;
      const { member: updated } = await orgMutations.setMemberStatus(mutationAccess(actor, request, response), projectId, memberId, status);
      // T5 #52：经审计钩子写入 audit_log（含真实主体与 before/after 快照，供撤销复原）。
      notifyOrgChange({
        projectId,
        action: hookAction,
        nodeId: updated.nodeId,
        memberId,
        actor: auditActorFrom(actor),
        targetName: member.displayName,
        before: member,
        after: updated,
        detail: { from, to: updated.status },
      });
      log.info("成员生命周期状态变更", { projectId, memberId, from, to: updated.status });
      writeJson(response, 200, { member: memberView(updated) });
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
      (await (requireProject(r, projectId)));
      const member = (await (r.members.get(memberId)));
      if (!member || member.projectId !== projectId) {
        throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}。`);
      }
      if (method === "GET") {
        (await (guard(r, request, "status:view", { projectId })));
        writeJson(response, 200, { memberStatus: (await (memberStatusView(r, projectId, memberId))) });
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
      (await (requireProject(r, projectId)));
      if (method === "GET") {
        (await (guard(r, request, "status:view", { projectId })));
        const list = (await Promise.all((await (r.members.listByProject(projectId))).map(async (m) => (await (memberStatusView(r, projectId, m.id))))));
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
      (await (requireProject(r, projectId)));
      if (method === "PUT") {
        const body = await readObjectBody(request);
        const memberId = requireString(body, "memberId");
        const member = (await (r.members.get(memberId)));
        if (!member || member.projectId !== projectId) {
          throw new RepositoryError("not_found", `成员 ${memberId} 不属于项目 ${projectId}，无法指定为 manager。`);
        }
        // F2：指定/更换顶层 manager = org:manage（ORG-04：人可撤销、manager 在管辖范围内调整）。
        const { actor } = await guard(r, request, "org:manage", { projectId, memberId });
        const result = await orgCommands.setManager(mutationAccess(actor, request, response), projectId, memberId);
        if (result.auditId) log.info("指定项目 manager", { projectId, memberId, auditId: result.auditId });
        writeJson(response, 200, { project: (await (projectView(r, (await (r.projects.get(projectId)))!))) });
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
      (await (requireProject(r, projectId)));
      if (method === "POST") {
        const body = await readObjectBody(request);
        const name = requireString(body, "name");
        const participantMemberIds = optionalStringArray(body, "participantMemberIds");
        // F2：建群组 = group:create（GROUP-03）。T2 #49：附上参与者岗位节点，
        // 下级 manager 建群时由守卫的 subtree 边界判定「参与者必须全部落在本子树内」（ORG-05）。
        const scope = { projectId, ...(participantMemberIds === undefined ? {} : {
          groupMemberIds: participantMemberIds, groupMemberNodeIds: await nodeIdsOfMembers(r, participantMemberIds),
        }) };
        const { actor } = await guard(r, request, "group:create", scope);
        const group = await withHttpMutation(r, projectId,
          [...(participantMemberIds ?? []), ...(actor.kind === "agent" ? [actor.actorId] : [])], [], async () => {
            await authorizeMutation(r, { actor }, "group:create", { projectId, ...(participantMemberIds === undefined ? {} : {
              groupMemberIds: participantMemberIds, groupMemberNodeIds: await nodeIdsOfMembers(r, participantMemberIds),
            }) });
            return r.groups.create({ projectId, name, ...(participantMemberIds === undefined ? {} : { participantMemberIds }) });
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
        const { actor } = (await (guard(r, request, "group:view", { projectId })));
        const includeArchived = truthyParam(request, "includeArchived");
        const candidates = (await (r.groups.listByProject(projectId, { includeArchived })));
        const visible = visibleGroups(
          actor,
          (await Promise.all(candidates.map(async (g) => {
            const memberIds = (await (r.groups.participants(g.id)));
            return { id: g.id, projectId, memberIds, memberNodeIds: await (nodeIdsOfMembers(r, memberIds)) };
          }))),
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
      const group = (await (requireGroup(r, groupId)));
      if (method === "POST") {
        // 归档与恢复共用 `group:archive`（owner / 顶层 manager / 下级 manager 限子树）。
        const { actor } = (await (guard(r, request, "group:archive", { projectId: group.projectId, groupId })));
        const next = await withHttpMutation(r, group.projectId, actor.kind === "agent" ? [actor.actorId] : [], [groupId], async () => {
          const before = await requireGroup(r, groupId);
          const fresh = await authorizeMutation(r, { actor }, "group:archive", { projectId: group.projectId, groupId, ...(await groupGuardFacts(r, groupId)) });
          const next = segments[3] === "archive" ? await r.groups.archive(groupId) : await r.groups.restore(groupId);
          await recordAudit(fresh, { projectId: group.projectId,
            action: segments[3] === "archive" ? AUDIT_ACTIONS.group_archive : AUDIT_ACTIONS.group_restore,
            targetKind: "group", targetId: group.id, targetName: before.name, before, after: next });
          return next;
        });
        log.info(segments[3] === "archive" ? "归档群组" : "恢复群组", { projectId: group.projectId, groupId });
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
        const group = (await (requireGroup(r, groupId)));
        const facts = (await (groupGuardFacts(r, groupId)));
        const { actor } = (await (guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...facts,
        })));
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
      const group = (await (r.groups.get(groupId)));
      if (!group) throw new RepositoryError("not_found", `群组 ${groupId} 不存在。`);
      if (method === "GET") {
        await guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...(await (groupGuardFacts(r, groupId))),
        });
        const participants = (await Promise.all((await (r.groups
          .participants(groupId)))
          .map(async (id) => (await (r.members.get(id))))))
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
      const group = (await (r.groups.get(groupId)));
      if (!group) throw new RepositoryError("not_found", `群组 ${groupId} 不存在。`);

      if (method === "POST") {
        const body = await readObjectBody(request);
        const senderMemberId = requireString(body, "senderMemberId");
        const text = requireString(body, "text");
        const explicitMentions = optionalStringArray(body, "mentions") ?? [];

        // 先保留公开输入的引用错误语义；提交范围内还会重新读取全部事实。
        const requestedSender = await r.members.get(senderMemberId);
        if (!requestedSender || requestedSender.projectId !== group.projectId || requestedSender.status !== "active") {
          throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不属于该群组所在项目或已停用。`);
        }
        if (!(await r.groups.participants(groupId)).includes(senderMemberId)) {
          throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不是该群组参与者。`);
        }
        const { actor } = await guard(r, request, "group:post", { projectId: group.projectId, groupId, ...(await groupGuardFacts(r, groupId)) }, senderMemberId);
        const { message: created, plan, senderKind } = await withHttpMutation(r, group.projectId,
          [senderMemberId, ...explicitMentions, ...(actor.kind === "agent" ? [actor.actorId] : [])], [groupId], async () => {
          const sender = (await (r.members.get(senderMemberId)));
          if (!sender || sender.projectId !== group.projectId || sender.status !== "active") {
            throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不属于该群组所在项目。`);
          }
          if (!(await (r.groups.participants(groupId))).includes(senderMemberId)) {
            throw new RepositoryError("invalid_reference", `发送者 ${senderMemberId} 不是该群组参与者。`);
          }
          // F2：发言 = group:post，以发送者为主体（参与范围由 group_participants 判定）。
          // T2 #49：group:post 是 participation 边界——子树只读可见性不会扩成发言权。
          await authorizeMutation(r, { actor }, "group:post", { projectId: group.projectId, groupId, ...(await groupGuardFacts(r, groupId)) });

          const roster = (await (buildRosterFor(r, groupId)));
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

          const message = (await (r.messages.create({
            groupId,
            senderMemberId,
            body: text,
            mentions: persistedMentions,
          })));
          // 人的显式触发保留既有恢复语义；同时保存当前 HTTP 路径实际使用的 wake 集合。
          const wakeMembers = new Set(plan.wake);
          for (const memberId of plan.visible) {
            await r.deliveries.ensure(message.id, memberId,
              wakeMembers.has(memberId) ? { decision: "allowed" } : undefined);
          }
          return { message, plan, senderKind: sender.kind };
        });
        const view = (await (messageView(r, created, plan)));
        // T7：人类消息重置该群组的「连续自动回复」计数（防环恢复条件之一）。
        if (senderKind === "human") resetGroupConsecutiveCount(groupId);
        log.info("发送群组消息", { groupId, messageId: created.id, senderMemberId, via: "http" });
        await options.onMessage?.(view);
        writeJson(response, 201, { message: view });
        return true;
      }

      if (method === "GET") {
        // F2：历史读取 = group:view。T2 #49：附上参与者岗位节点，
        // sub_manager 对「参与者全部在子树内」的群组可读历史（只读，不唤醒、不能发言）。
        const { actor } = await guard(r, request, "group:view", {
          projectId: group.projectId,
          groupId,
          ...(await (groupGuardFacts(r, groupId))),
        });
        const limitRaw = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("limit");
        const limit = limitRaw === null ? 200 : Math.min(Math.max(Number(limitRaw) || 200, 1), 500);
        const all = (await (r.messages.listByGroup(groupId)));
        const visible: DbMessage[] = [];
        for (const message of all) {
          if (actor.kind === "human" || await tasks.canReadLinkedMessage({ actor }, group.projectId, message.id)) visible.push(message);
        }
        const page = visible.slice(Math.max(0, visible.length - limit));
        // 人保留群组全量视角；成员与 MCP 共用关联任务 + 群组权限边界。
        writeJson(response, 200, { messages: (await Promise.all(page.map(async (m) => (await (messageView(r, m)))))) });
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
      (await (requireProject(r, projectId)));
      if (method === "GET") {
        (await (guard(r, request, "project:view", { projectId })));
        const nodes = (await (r.org.listNodes(projectId)));
        const members = (await (r.members.listByProject(projectId)));
        writeJson(response, 200, {
          nodes: (await Promise.all(nodes.map(async (n) => orgNodeView(n, (await (memberAtNode(r, projectId, n.id))))))),
          rootId: (await (r.org.getRootNode(projectId)))?.id ?? null,
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
      (await (requireProject(r, projectId)));
      if (method === "POST") {
        const body = await readObjectBody(request);
        const parentId = optionalStringOrNull(body, "parentId") ?? null;
        const name = requireString(body, "name");
        const role = requireOrgNodeRole(body, "role");
        const sortOrder = optionalSortOrder(body);
        // ORG-05：新岗位的父节点必须落在调用者的管辖子树内（root 仅 owner/top_manager 可建）。
        const { actor } = (await (guard(r, request, "org:manage", { projectId, nodeId: parentId })));
        const { node } = await orgMutations.createNode(mutationAccess(actor, request, response), {
          projectId,
          parentId,
          name,
          role,
          ...(sortOrder === undefined ? {} : { sortOrder }),
        });
        // T5 #52：建岗可撤销（撤销＝删岗），写审计。
        notifyOrgChange({
          projectId,
          action: "node.create",
          nodeId: node.id,
          memberId: null,
          actor: auditActorFrom(actor),
          targetName: node.name,
          before: null,
          after: node,
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
      (await (requireProject(r, projectId)));
      if (method === "POST") {
        const body = await readObjectBody(request);
        const memberId = requireString(body, "memberId");
        const { actor } = (await (guard(r, request, "member:manage", { projectId })));
        const beforeMember = (await (r.members.get(memberId)));
        const { node } = await orgMutations.autoPlaceMember(mutationAccess(actor, request, response), projectId, memberId);
        // T5 #52：自动分配可撤销（撤销＝腾岗回 nodeId=null），写审计。
        notifyOrgChange({
          projectId,
          action: "member.auto_place",
          nodeId: node?.id ?? null,
          memberId,
          actor: auditActorFrom(actor),
          targetName: node?.name ?? memberId,
          before: beforeMember ?? null,
          after: node !== null ? (await (r.members.get(memberId))) : (beforeMember ?? null),
          detail: { placed: node !== null },
        });
        writeJson(response, 200, {
          node: node ? orgNodeView(node, (await (memberAtNode(r, projectId, node.id)))) : null,
        });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
      return true;
    }

    // PUT / DELETE /api/org/nodes/:nodeId —— 改岗位（改名/角色/汇报线/排序）与删岗位
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "org" && segments[2] === "nodes") {
      const nodeId = decodeSegment(segments[3]!);
      const node = (await (r.org.getNode(nodeId)));
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
        const { actor } = (await (guard(r, request, "org:manage", { projectId: node.projectId, nodeId: node.id })));
        // 改汇报线时，新的父节点也必须落在管辖子树内（防越级搬迁）。
        if (parentId !== undefined && parentId !== null) {
          (await (guard(r, request, "org:manage", { projectId: node.projectId, nodeId: parentId })));
        }
        const { node: updated } = await orgMutations.updateNode(mutationAccess(actor, request, response), node.projectId, nodeId, patch);
        // T5 #52：改岗可撤销（撤销＝按 before 复原整行），写审计。
        notifyOrgChange({
          projectId: node.projectId,
          action: "node.update",
          nodeId,
          memberId: null,
          actor: auditActorFrom(actor),
          targetName: node.name,
          before: node,
          after: updated,
          detail: { patch },
        });
        writeJson(response, 200, { node: orgNodeView(updated, (await (memberAtNode(r, node.projectId, nodeId)))) });
        return true;
      }
      if (method === "DELETE") {
        const { actor } = (await (guard(r, request, "org:manage", { projectId: node.projectId, nodeId: node.id })));
        await orgMutations.deleteNode(mutationAccess(actor, request, response), node.projectId, nodeId);
        // T5 #52：删岗可撤销（撤销＝按 before 复原整行），写审计。
        notifyOrgChange({
          projectId: node.projectId,
          action: "node.delete",
          nodeId,
          memberId: null,
          actor: auditActorFrom(actor),
          targetName: node.name,
          before: node,
          after: null,
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
      const node = (await (r.org.getNode(nodeId)));
      if (!node) throw new RepositoryError("not_found", `组织岗位 ${nodeId} 不存在。`);
      if (method === "PUT") {
        const body = await readObjectBody(request);
        // memberId 为 null = 腾出该岗位当前占据者；否则把指定成员指派到该岗位。
        const memberId = optionalStringOrNull(body, "memberId") ?? null;
        const { actor } = (await (guard(r, request, "member:manage", { projectId: node.projectId, nodeId: node.id })));
        const beforeMember = memberId === null ? null : await r.members.get(memberId);
        const access = mutationAccess(actor, request, response);
        const { member } = memberId === null
          ? await orgCommands.clearNode(access, node.projectId, nodeId)
          : await orgMutations.assignNode(access, node.projectId, memberId, nodeId);
        // T5 #52：占岗/腾岗可撤销（撤销＝按 before 的 nodeId 复原占岗），写审计。
        if (member) notifyOrgChange({
          projectId: node.projectId,
          action: "node.assign",
          nodeId,
          memberId: member.id,
          actor: auditActorFrom(actor),
          targetName: member.displayName,
          before: beforeMember ?? null,
          after: member,
          detail: { assigned: memberId !== null },
        });
        writeJson(response, 200, { member: member ? memberView(member) : null });
        return true;
      }
      methodNotAllowed(response, ["PUT"]);
      return true;
    }

    // /api/projects/:id/audit —— T5 #52 审计查看（人 / 授权主体可见；行级收窄按项目）
    if (
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "audit"
    ) {
      const projectId = decodeSegment(segments[2]!);
      (await (requireProject(r, projectId)));
      if (method === "GET") {
        // F2：audit:view（owner + 顶层 manager）。阶段 1 默认人=owner 放行，行为不变。
        (await (guard(r, request, "audit:view", { projectId })));
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const action = url.searchParams.get("action") ?? undefined;
        const targetKind = url.searchParams.get("targetKind") ?? undefined;
        const targetId = url.searchParams.get("targetId") ?? undefined;
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? undefined : Number.parseInt(rawLimit, 10);
        const rows = (await (r.audit.list(projectId, {
          ...(action === undefined ? {} : { action }),
          ...(targetKind === undefined ? {} : { targetKind: targetKind as AuditTargetKind }),
          ...(targetId === undefined ? {} : { targetId }),
          ...(limit === undefined || Number.isNaN(limit) ? {} : { limit }),
        })));
        writeJson(response, 200, { entries: rows.map(auditView) });
        return true;
      }
      methodNotAllowed(response, ["GET"]);
      return true;
    }

    // /api/projects/:id/audit/:auditId/revoke —— T5 #52 人的撤销权（org:revoke，仅人）
    if (
      segments.length === 6 &&
      segments[0] === "api" &&
      segments[1] === "projects" &&
      segments[3] === "audit" &&
      segments[5] === "revoke"
    ) {
      const projectId = decodeSegment(segments[2]!);
      (await (requireProject(r, projectId)));
      if (method === "POST") {
        const auditId = decodeSegment(segments[4]!);
        // F2：org:revoke 仅人（owner）。agent 主体在此被 authorize 直接拒绝（#30 §5）。
        const { actor } = (await (guard(r, request, "org:revoke", { projectId })));
        // 锁外只读取有界状态；历史损坏的大正文不能绕过补偿服务的采集预算。
        // 真正快照、链关系与当前权限仍在共同项目锁内重新读取和校验。
        const byteLength = (column: string) => options.db.kind === "postgres" ? `octet_length(${column})` : `length(CAST(${column} AS BLOB))`;
        const truncated = (column: string) => `CASE WHEN ${byteLength(column)} <= 32768 THEN CASE WHEN ${options.db.kind === "postgres" ? "strpos" : "instr"}(${column}, '"truncated":true') > 0 THEN 1 ELSE 0 END ELSE 0 END`;
        const row = await r.context.one<{
          action: string; reversed_at: string | null; before_truncated: number; after_truncated: number;
          before_bytes: number | null; after_bytes: number | null; detail_bytes: number | null; target_name_bytes: number | null;
        }>(`SELECT substr(action, 1, 129) AS action, substr(reversed_at, 1, 129) AS reversed_at,
          ${byteLength("before")} AS before_bytes, ${byteLength("after")} AS after_bytes,
          ${byteLength("detail")} AS detail_bytes, ${byteLength("target_name")} AS target_name_bytes,
          ${truncated("before")} AS before_truncated, ${truncated("after")} AS after_truncated
          FROM audit_log WHERE project_id = ? AND id = ?`, [projectId, auditId]);
        if (!row) throw new RepositoryError("not_found", `审计事件 ${auditId} 不存在。`);
        if (row.reversed_at) {
          throw new RepositoryError("conflict", `审计事件 ${auditId} 已被撤销，不能重复撤销。`);
        }
        const reason = revokeUnavailableReason(row.action);
        if (reason) {
          throw new HttpError(403, reason, REVOKE_REASON_MESSAGE[reason] ?? "该操作不可撤销。");
        }
        // 截断事件失去完整快照，撤销补偿无法还原（#30 §1）。
        if (Number(row.before_truncated) === 1 || Number(row.after_truncated) === 1) {
          throw new HttpError(403, "truncated", REVOKE_REASON_MESSAGE.truncated ?? "该审计事件被截断，不可撤销。");
        }
        if ([row.before_bytes, row.after_bytes, row.detail_bytes, row.target_name_bytes].some(size => Number(size ?? 0) > 32768)) {
          throw new RepositoryError("audit_snapshot_too_large", "历史审计字段超出完整快照上限。");
        }
        const newRow = await compensations.revoke(mutationAccess(actor, request, response), projectId, auditId);
        writeJson(response, 200, { entry: auditView(newRow) });
        return true;
      }
      methodNotAllowed(response, ["POST"]);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // 永久删除的二次确认（PROJECT-03 / LIFE-ARC-01）
  // -------------------------------------------------------------------------
  // 注：待确认凭据表 `pendingPurges` 在路由器工厂顶部初始化（必须早于 `return { handle }`，
  // 否则该 `const` 永远不会执行到，这里只是复用同一个闭包变量）。

  function issuePurgeConfirmation(key: string, snapshot: PurgeSnapshot<Project | Group, unknown>): PendingPurge {
    const entry = { token: randomUUID(), expiresAt: now().getTime() + PURGE_CONFIRM_TTL_MS, snapshot };
    pendingPurges.set(key, entry);
    return entry;
  }

  /**
   * 正确凭据在尝试执行前消费，影响变化/运行限制/事务失败都需要重新预览；不会自动重试删除。
   * 错误 token 不消费当前有效凭据；到期凭据移除，重新预览会替换旧凭据。
   */
  function consumePurgeConfirmation(key: string, token: string): PendingPurge | null {
    const entry = pendingPurges.get(key);
    if (entry === undefined || entry.token !== token) return null;
    pendingPurges.delete(key);
    return entry.expiresAt <= now().getTime() ? null : entry;
  }

  /**
   * 永久删除的一刀两拍（#48：PROJECT-03 / GROUP-04 共用同一流程）。
   *
   * 第一刀不删，只返回级联清单与一次性确认凭据；第二刀带同一凭据才执行 {@link PurgeFlow.execute}。
   * 守卫（能力点）在取凭据之前判定：manager 主体连清单都拿不到（403），人必须确认两次。
   */
  interface PurgeFlow<T extends Project | Group> {
    /** 待确认表键：`project:<id>` / `group:<id>`。 */
    readonly key: string;
    readonly capability: Capability;
    readonly scope: GuardScope;
    /** 确认载荷里的资源字段（kind/id/名称/归档位……），随级联清单一起返回。 */
    readonly resource: (target: T) => Record<string, unknown>;
    /** 第一刀给「人」看的可读说明：会清掉什么、能不能反悔。 */
    readonly ask: (target: T) => string;
    /** 日志事件名。 */
    readonly event: string;
    /** 第一刀的级联清单（只读）。 */
    readonly preview: () => Promise<PurgeSnapshot<T, unknown>>;
    /** 第二刀的实际清除，返回清除行数。 */
    readonly execute: (expectedDigest: string) => Promise<unknown>;
    /** T5 #52：永久删除留痕（不可撤销，但必须可查）。提供被删前快照与级联清单。 */
    readonly audit?: {
      readonly action: AuditAction;
      readonly targetKind: AuditTargetKind;
      readonly targetId: string;
    };
  }

  async function purgeWithConfirmation<T extends Project | Group>(
    r: RepositorySet,
    flow: PurgeFlow<T>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await guard(r, request, flow.capability, flow.scope);
    const body = await readOptionalObjectBody(request);
    const confirm = typeof body["confirm"] === "string" ? (body["confirm"] as string) : null;
    const plan = { projectIds: [flow.scope.projectId!], discover: purgeDiscovery(flow.scope.projectId!, flow.scope.groupId) };

    if (confirm === null) {
      const snapshot = await r.transaction(() => r.mutations.run(plan, async () => {
        await guard(r, request, flow.capability, flow.scope);
        return flow.preview();
      }));
      const { cascade, target } = snapshot;
      const entry = issuePurgeConfirmation(flow.key, snapshot);
      log.info(`${flow.event}：等待二次确认`, { cascade });
      writeJson(response, 409, {
        error: { code: "confirmation_required", message: flow.ask(target) },
        confirmation: {
          ...flow.resource(target),
          cascade,
          token: entry.token,
          expiresAt: new Date(entry.expiresAt).toISOString(),
        },
      });
      return;
    }

    const entry = consumePurgeConfirmation(flow.key, confirm);
    if (!entry) {
      throw new HttpError(
        400,
        "invalid_confirmation",
        "永久删除的确认凭据无效或已过期，请重新发起以获取最新的级联清单与凭据。",
      );
    }

    // 权限、快照复核、stopped gate、删除和权威审计共享物理事务及项目/成员/群/runtime锁。
    // 所有合法写入口都先取得同一项目锁；不能在比较通过与实际清理之间插入新事实。
    const cleared = await r.transaction(() => r.mutations.run(plan, async () => {
      const { actor } = await guard(r, request, flow.capability, flow.scope);
      const counts = await flow.execute(entry.snapshot.digest);
      if (flow.audit) {
        await recordAudit(actor, {
          projectId: flow.scope.projectId!,
          action: flow.audit.action,
          targetKind: flow.audit.targetKind,
          targetId: flow.audit.targetId,
          targetName: entry.snapshot.target.name,
          before: entry.snapshot.target,
          after: null,
          detail: { cascade: counts },
        });
      }
      return counts;
    }));
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
    const project = (await (requireProject(r, projectId)));
    await purgeWithConfirmation(
      r,
      {
        key: `project:${project.id}`,
        // 只有「人（owner）」持有 project:purge；顶层 manager 没有 → 403（LIFE-ARC-01）。
        capability: "project:purge",
        scope: { projectId: project.id },
        resource: (project: Project) => ({
          kind: "project",
          projectId: project.id,
          projectName: project.name,
          archivedAt: project.archivedAt,
        }),
        ask: (project: Project) =>
          `永久删除项目「${project.name}」会级联清除它的群组、群聊消息、投递、成员与状态，且不可恢复。` +
          "确认无误后请带 confirmation.token 重新发起 DELETE。",
        event: "永久删除项目",
        preview: () => r.projects.capturePurge(project.id),
        execute: digest => r.projects.purge(project.id, digest),
        // T5 #52：永久删除留痕（不可撤销）。
        audit: {
          action: AUDIT_ACTIONS.project_delete,
          targetKind: "project",
          targetId: project.id,
        },
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
    const group = (await (requireGroup(r, groupId)));
    await purgeWithConfirmation(
      r,
      {
        key: `group:${group.id}`,
        // `group:purge` 同样只有人持有（LIFE-ARC-01）。
        capability: "group:purge",
        scope: { projectId: group.projectId, groupId: group.id },
        resource: (group: Group) => ({
          kind: "group",
          projectId: group.projectId,
          groupId: group.id,
          groupName: group.name,
          archivedAt: group.archivedAt,
        }),
        ask: (group: Group) =>
          `永久删除群组「${group.name}」会清除它的群聊消息与参与者关系，且不可恢复；项目成员本身不受影响。` +
          "确认后请带 confirmation.token 重新发起 DELETE。",
        event: "永久删除群组",
        preview: () => r.groups.capturePurge(group.id),
        execute: digest => r.groups.purge(group.id, digest),
        // T5 #52：永久删除留痕（不可撤销）。
        audit: {
          action: AUDIT_ACTIONS.group_delete,
          targetKind: "group",
          targetId: group.id,
        },
      },
      request,
      response,
    );
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** T3：从群组参与者构建路由 roster（在线以 connected MCP 会话为准，人视为在线）。 */
  async function buildRosterFor(r: RepositorySet, groupId: string): Promise<RoutingMember[]> {
    return (await (buildRoster(r, groupId)));
  }

  async function projectView(r: RepositorySet, project: Project) {
    const manager = (await (r.members.getManager(project.id)));
    const members = (await (r.members.listByProject(project.id)));
    const groups = (await (r.groups.listByProject(project.id)));
    const messageCount = (await (r.messages.countByProject(project.id)));
    const lastActivityAt = (await (r.messages.latestByProject(project.id)));
    // T4（#51）：跨项目概览——聚合「运行状态 / 成员数 / 群组数 / 最近活跃」。
    // onlineCount 来自状态看板推导（WebSocket/会话在线）；人仅经 WS presence 在线，
    // 此处无 hub，故人按 offline 计（实时看板仍以 WS 推送为准）。
    const statuses = (await (buildStatusBoard(r, project.id, { heartbeat, now: new Date(), humanOnlineMemberIds: [] })));
    const onlineCount = statuses.filter((s) => s.state !== "offline").length;
    const status: "active" | "idle" | "archived" =
      project.archivedAt !== null ? "archived" : onlineCount > 0 ? "active" : "idle";
    return {
      id: project.id,
      name: project.name,
      projectRevision: project.projectRevision,
      workspaceRevision: project.workspaceRevision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      // T1 #48：归档时间（null = 未归档）。归档对象默认不出现在列表里，但形状一致。
      archivedAt: project.archivedAt,
      manager: manager ? memberView(manager) : null,
      // T4（#51）跨项目概览聚合字段：
      memberCount: members.length,
      groupCount: groups.length,
      messageCount,
      onlineCount,
      lastActivityAt,
      status,
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
      // T3 #50：成员生命周期状态（active / disabled / pending）；老库默认 active。
      status: member.status,
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
  async function memberAtNode(r: RepositorySet, projectId: string, nodeId: string): Promise<Member | null> {
    return (await (r.members.listByProject(projectId))).find((m) => m.nodeId === nodeId) ?? null;
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
  async function nodeIdsOfMembers(r: RepositorySet, memberIds: readonly string[]): Promise<(string | null)[]> {
    return (await Promise.all(memberIds.map(async (id) => (await (r.members.get(id)))?.nodeId ?? null)));
  }

  /**
   * T2 #49：群组参与事实（成员 + 岗位节点），供 F2 守卫的 subtree 边界与
   * `group:view_subtree` 只读可见性判定（ORG-03 / #32 / AC-ORG-07）。
   */
  async function groupGuardFacts(r: RepositorySet, groupId: string): Promise<{
    groupMemberIds: string[];
    groupMemberNodeIds: (string | null)[];
  }> {
    const groupMemberIds = (await (r.groups.participants(groupId)));
    return { groupMemberIds, groupMemberNodeIds: await (nodeIdsOfMembers(r, groupMemberIds)) };
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
  async function memberStatusView(r: RepositorySet, projectId: string, memberId: string) {
    const member = (await (r.members.get(memberId)));
    const status = (await (r.statuses.get(projectId, memberId)));
    const session = (await (latestSession(r, projectId, memberId)));
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
  async function latestSession(r: RepositorySet, projectId: string, memberId: string): Promise<McpSession | null> {
    let best: McpSession | null = null;
    for (const s of (await (r.mcpSessions.listByProject(projectId)))) {
      if (s.memberId !== memberId) continue;
      if (best === null || `${s.connectedAt}|${s.updatedAt}` > `${best.connectedAt}|${best.updatedAt}`) best = s;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  async function requireProject(r: RepositorySet, projectId: string): Promise<Project> {
    const project = (await (r.projects.get(projectId)));
    if (!project) throw new RepositoryError("not_found", `项目 ${projectId} 不存在。`);
    return project;
  }

  /** T1 #48：群组定位（归档/恢复/永久删除共用）；不存在 → 404。 */
  async function requireGroup(r: RepositorySet, groupId: string): Promise<Group> {
    const group = (await (r.groups.get(groupId)));
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

/** T3 #50：成员生命周期状态（active / disabled / pending）；非法值 → 400 invalid_argument。 */
function requireLifecycleStatus(body: Record<string, unknown>): MemberLifecycleStatus {
  const value = body["status"];
  if (value !== "active" && value !== "disabled" && value !== "pending") {
    throw new InvalidArgumentError("status 必须是 active / disabled / pending。");
  }
  return value;
}

/** 登记成员时可选的状态；省略 = active（repository 默认），可显式置 pending。 */
function optionalLifecycleStatus(body: Record<string, unknown>): MemberLifecycleStatus | undefined {
  if (body["status"] === undefined) return undefined;
  return requireLifecycleStatus(body);
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

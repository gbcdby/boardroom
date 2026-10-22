import type { Database } from "better-sqlite3";
import type { Logger } from "../logger.ts";
import {
  ConflictError,
  InvalidArgumentError,
  InvalidReferenceError,
  NotFoundError,
  RepositoryError,
} from "../db/errors.ts";
import { createRepositories, type RepositorySet } from "../db/repositories.ts";
import type { McpSession, Member, Message as DbMessage } from "../db/types.ts";
import { invalidArgument, McpToolError, notInGroup } from "./errors.ts";

/**
 * MCP 工具的领域核心（T2 / #15）。
 *
 * F3（#13）的内存 `McpStore` 在这里被替换为 F2 的持久化 repository：
 * - 全局身份（Agent）、项目成员（Member）、连接状态（McpSession）、成员运行状态
 *   （MemberStatus）都落到 SQLite，进程重启后保留、可恢复。
 * - 工具的**对外形状**（工具名、入参、出参、错误码）与 docs/mcp-tool-contract.md 保持一致，
 *   只新增 `heartbeat` 工具；实现内部从内存改为持久化。
 *
 * 关键建模（D1 / STATUS-02）：
 * - 连接状态（McpSession：connected/disconnected + 最后心跳）与成员运行状态
 *   （MemberStatus：online/offline/waiting/working）分开建模、分表存放。
 * - 在线以 MCP 连接/心跳为准，不靠终端画面推断。
 * - 工具返回的 waiting/working 只来自显式 report_status，绝不根据连接状态推断。
 *
 * 等待机制沿用 D6 结论：`wait_for_messages` 由工具自身挂起，有可投递消息/超时/取消时 resolve；
 * 不承诺唤醒空闲宿主或打断在途工具。挂起中的等待是**进程内运行时对象**，不落库；
 * 进程重启后由 agent 重连并重新发起等待（积压补投的持久化扩展留给 T5）。
 */

export interface Heartbeat {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export type HostType = "claude-code" | "codex-cli" | "other";
export type MemberRole = "manager" | "normal";
export type RunStatus = "waiting" | "working";

/** 契约固定的消息形状（不随持久化实现改变）。 */
export interface Message {
  readonly id: string;
  readonly groupId: string;
  readonly senderId: string;
  readonly text: string;
  readonly mentions: readonly string[];
  readonly createdAt: string;
}

/** 一个 MCP 会话的绑定：由 join 建立。与会话连接状态无关。 */
export interface SessionBinding {
  readonly sessionId: string;
  readonly agentId: string;
  readonly memberId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly role: MemberRole;
  readonly displayName: string;
  readonly hostType: HostType;
  /** 持久化的 MCP 会话 id（mcp_sessions 主键），用于心跳/断开。 */
  readonly mcpSessionId: string;
}

export interface JoinParams {
  readonly displayName: string;
  readonly hostType: HostType;
  readonly projectId: string;
  readonly groupId: string;
  readonly role?: MemberRole;
}

export interface JoinResult {
  readonly ok: true;
  readonly memberId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly role: MemberRole;
  readonly heartbeat: Heartbeat;
}

export interface SendMessageParams {
  readonly groupId?: string;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly clientMessageId?: string;
}

export interface SendMessageResult {
  readonly ok: true;
  readonly messageId: string;
  readonly createdAt: string;
  readonly duplicate: boolean;
}

export interface AcknowledgeResult {
  readonly ok: true;
  readonly messageId: string;
  readonly alreadyAcknowledged: boolean;
}

export interface StatusResult {
  readonly ok: true;
  readonly status: RunStatus;
  readonly projectId: string;
  readonly memberId: string;
  readonly updatedAt: string;
}

export interface HeartbeatResult {
  readonly ok: true;
  readonly sessionId: string;
  readonly state: "connected";
  readonly lastHeartbeatAt: string;
}

export interface ReadHistoryParams {
  readonly groupId?: string;
  readonly limit?: number;
  readonly beforeCursor?: string;
}

export interface ReadHistoryResult {
  readonly ok: true;
  readonly messages: Message[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
}

export type WaitStatus = "message" | "timeout" | "cancelled";

export interface WaitResult {
  readonly ok: true;
  readonly status: WaitStatus;
  readonly messages: Message[];
  readonly cursor: string | null;
  readonly drainedBacklog: boolean;
}

export interface WaitParams {
  readonly timeoutMs?: number;
  readonly afterCursor?: string;
  /** 宿主/传输取消信号。 */
  readonly signal?: AbortSignal;
}

export const DEFAULT_HEARTBEAT: Heartbeat = { intervalMs: 10_000, timeoutMs: 30_000 };
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 20;

/** 挂起中的等待（运行时对象，不落库）。 */
interface PendingWait {
  readonly ownerKey: string;
  readonly memberId: string;
  readonly groupId: string;
  readonly resolve: (result: WaitResult) => void;
  readonly settled: () => void;
  done: boolean;
  timer: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
}

/**
 * 跨 core 唤醒：所有活跃 core 共享进程内的注册表，写入消息后可唤醒任意 core 上
 * 同一群组的挂起等待（Streamable HTTP 每个会话一个 core）。
 */
interface CoreInternals {
  readonly core: McpCore;
  resolveGroup(groupId: string): void;
}

const activeRegistrations = new Set<CoreInternals>();

export interface McpCoreOptions {
  readonly logger: Logger;
  readonly db: Database;
  readonly heartbeat?: Heartbeat;
  readonly now?: () => Date;
  /**
   * 主体标识：区分不同传输实例的会话前缀。
   * - Streamable HTTP：`http:<mcpSessionId>`。
   * - stdio：整进程一个 core，键固定。
   * - 测试（InMemoryTransport）：每个成员一个 core，必须不同成员。
   */
  readonly memberKey?: string;
}

export interface McpCore {
  join(sessionId: string, params: JoinParams): JoinResult;
  waitForMessages(sessionId: string, params: WaitParams): Promise<WaitResult>;
  sendMessage(sessionId: string, params: SendMessageParams): SendMessageResult;
  acknowledgeMessage(sessionId: string, messageId: string): AcknowledgeResult;
  reportStatus(sessionId: string, params: { status: RunStatus; projectId?: string; memberId?: string }): StatusResult;
  heartbeat(sessionId: string): HeartbeatResult;
  readHistory(sessionId: string, params: ReadHistoryParams): ReadHistoryResult;
  /** 当前挂起等待数（测试与观测用）。 */
  readonly pendingWaitCount: number;
  /** 某个会话是否已入群（测试用）。 */
  isJoined(sessionId: string): boolean;
  /** 中止本 core 所有挂起等待并以 cancelled 返回；用于优雅关闭。幂等。 */
  close(): void;
  /** 把本 core 的持久化会话标记为断开（保留历史）。 */
  disconnect(): void;
}

const RUNNING_STATES = new Set<RunStatus>(["waiting", "working"]);

/**
 * 创建领域核心。所有工具处理都经过 {@link McpCore}，server 层只负责 MCP 协议装配。
 */
export function createMcpCore(options: McpCoreOptions): McpCore {
  const log = options.logger.child({ component: "mcp-core" });
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;
  const now = options.now ?? (() => new Date());
  const memberKey = options.memberKey ?? "default";

  const repos: RepositorySet = createRepositories(options.db);
  /** 会话键 → 绑定（运行时对象，进程内维护；持久化部分在 mcp_sessions/members/agents）。 */
  const bindings = new Map<string, SessionBinding>();
  /** 本 core 挂起的等待。 */
  const pendingWaits: PendingWait[] = [];
  /** 每位成员最多一个并发等待。 */
  const waitingMembers = new Set<string>();
  /** clientMessageId 幂等映射（进程内：send 时写入 messageId）。 */
  const clientKeys = new Map<string, string>();
  let closed = false;

  const selfKey = (sessionId: string): string => `${memberKey}:${sessionId}`;

  // -------------------------------------------------------------------------
  // 持久化辅助
  // -------------------------------------------------------------------------

  /**
   * 入群持久化：查找/创建全局 Agent → 查找/创建项目 Member → 建立/复用 MCP 会话 → online。
   * 全局身份唯一；跨项目 member 唯一；同 agent+project+group 活跃会话唯一。
   * 冲突以明确错误返回，绝不静默创建重复身份。
   */
  function joinPersisted(
    projectId: string,
    groupId: string,
    displayName: string,
    hostType: HostType,
    role: MemberRole,
  ): { agentId: string; member: Member; session: McpSession } {
    const project = repos.projects.get(projectId);
    if (!project) {
      throw new McpToolError("INVALID_ARGUMENT", `项目 ${projectId} 不存在，请先在 WebUI 创建`, { projectId });
    }
    const group = repos.groups.get(groupId);
    if (!group) {
      throw new McpToolError("INVALID_ARGUMENT", `群组 ${groupId} 不存在，请先在 WebUI 创建`, { groupId });
    }
    if (group.projectId !== projectId) {
      throw new McpToolError("INVALID_ARGUMENT", `群组 ${groupId} 不属于项目 ${projectId}`, { projectId, groupId });
    }

    try {
      return repos.transaction(() => {
        // 1) 全局身份：按 (displayName, hostType) 查找或创建（唯一索引兜底）。
        let agent = repos.agents.findByIdentity(displayName, hostType);
        if (!agent) agent = repos.agents.create({ displayName, hostType });
        const agentId = agent.id;

        // 2) 项目成员：同 agent 在同项目唯一（(project_id, agent_id) 唯一索引）。
        let member = repos.members.findByAgent(projectId, agentId);
        if (!member) {
          // 阶段 1 一个项目只有一个岗位（D2）；入群保留已有 manager，不覆盖。
          member = repos.members.create({
            projectId,
            kind: "agent",
            agentId,
            displayName,
            role: role === "manager" ? "manager" : "normal",
          });
        } else if (member.displayName !== displayName) {
          member = repos.members.update(member.id, { displayName });
        }

        // 3) 群组参与者（幂等）。
        repos.groups.addParticipant(groupId, member.id);

        // 4) MCP 会话（连接状态，D1）：建立或复用活跃会话。
        const session = repos.mcpSessions.connect({
          agentId,
          projectId,
          groupId,
          memberId: member.id,
          displayName,
          hostType,
        });

        // 5) 成员运行状态：连接建立 → online（与连接心跳分开记录）。
        repos.statuses.set(projectId, member.id, "online");

        return { agentId, member, session };
      });
    } catch (error) {
      throw mapRepoError(error, { projectId, groupId, displayName, hostType });
    }
  }

  function touchSession(mcpSessionId: string): void {
    try {
      repos.mcpSessions.heartbeat(mcpSessionId, now().toISOString());
    } catch (error) {
      log.warn("mcp_session_heartbeat_failed", { error, mcpSessionId });
    }
  }

  /** 某成员「自己发送 + 被 @」的可见消息（D3）。 */
  function isVisibleTo(binding: SessionBinding, message: DbMessage): boolean {
    if (message.groupId !== binding.groupId) return false;
    return message.senderMemberId === binding.memberId || message.mentions.includes(binding.memberId);
  }

  /** 从 afterSeq 之后取该成员可见、且未 acked 的消息（积压/唤醒）。 */
  function deliverableSince(binding: SessionBinding, afterSeq: number | undefined): DbMessage[] {
    const list = repos.messages.listByGroup(binding.groupId, {
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    const pending: DbMessage[] = [];
    for (const message of list) {
      if (!isVisibleTo(binding, message)) continue;
      const delivery = repos.deliveries.get(message.id, binding.memberId);
      if (delivery?.status === "acked") continue;
      pending.push(message);
    }
    return pending;
  }

  /** 把一批消息记为「已投递」（至少一次；acked 前可重复读取，靠 acked 过滤去重）。 */
  function markDelivered(
    binding: SessionBinding,
    messages: DbMessage[],
  ): { messages: Message[]; lastSeq: number } {
    const result: Message[] = [];
    for (const message of messages) {
      try {
        repos.deliveries.recordAttempt(message.id, binding.memberId, "delivered");
      } catch (error) {
        log.warn("delivery_record_failed", { error, messageId: message.id });
      }
      result.push(toMessage(message));
    }
    return { messages: result, lastSeq: messages[messages.length - 1]!.seq };
  }

  /** 某成员最后一条非 pending 消息的游标（timeout/cancelled 时回显 afterCursor）。 */
  function lastDeliveredCursor(binding: SessionBinding): string | null {
    const list = repos.messages.listByGroup(binding.groupId);
    let lastSeq: number | null = null;
    for (const message of list) {
      const delivery = repos.deliveries.get(message.id, binding.memberId);
      if (delivery && delivery.status !== "pending") lastSeq = message.seq;
    }
    return lastSeq === null ? null : seqCursor(lastSeq);
  }

  function settle(entry: PendingWait, result: WaitResult): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    const idx = pendingWaits.indexOf(entry);
    if (idx >= 0) pendingWaits.splice(idx, 1);
    waitingMembers.delete(entry.memberId);
    entry.settled();
    entry.resolve(result);
  }

  /**
   * 唤醒本 core 中在该群组等待、且有可投递消息的成员。
   * 由「写入消息的 core」调用，跨 core 时通过注册表遍历所有 core。
   */
  function resolveGroup(groupId: string): void {
    for (const entry of [...pendingWaits]) {
      const binding = bindingByMember(entry.memberId);
      if (!binding || binding.groupId !== groupId) continue;
      const messages = deliverableSince(binding, undefined);
      if (messages.length === 0) continue;
      const delivered = markDelivered(binding, messages);
      settle(entry, {
        ok: true,
        status: "message",
        messages: delivered.messages,
        cursor: seqCursor(delivered.lastSeq),
        drainedBacklog: false,
      });
      return;
    }
  }

  function bindingByMember(memberId: string): SessionBinding | undefined {
    for (const binding of bindings.values()) {
      if (binding.memberId === memberId) return binding;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 工具实现
  // -------------------------------------------------------------------------

  const core: McpCore = {
    join(sessionId, params) {
      if (closed) throw new McpToolError("INTERNAL", "服务端正在关闭");
      const displayName = params.displayName.trim();
      if (displayName.length === 0 || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
        throw invalidArgument(`displayName 必须为 1–${MAX_DISPLAY_NAME_LENGTH} 个字符`, {
          length: displayName.length,
        });
      }
      if (params.projectId.trim() === "" || params.groupId.trim() === "") {
        throw invalidArgument("projectId 与 groupId 必填");
      }
      if (!["claude-code", "codex-cli", "other"].includes(params.hostType)) {
        throw invalidArgument("hostType 必须是 claude-code / codex-cli / other");
      }
      const role: MemberRole = params.role ?? "normal";

      const existing = bindings.get(selfKey(sessionId));
      if (existing) {
        if (
          existing.projectId !== params.projectId ||
          existing.groupId !== params.groupId ||
          existing.displayName !== displayName ||
          existing.hostType !== params.hostType
        ) {
          throw new McpToolError("CONFLICT", "该会话已以不同身份入群，不能重复声明不同身份");
        }
        return toJoinResult(existing, heartbeat);
      }

      const joined = joinPersisted(params.projectId, params.groupId, displayName, params.hostType, role);
      const binding: SessionBinding = {
        sessionId: selfKey(sessionId),
        agentId: joined.agentId,
        memberId: joined.member.id,
        projectId: params.projectId,
        groupId: params.groupId,
        role: joined.member.role,
        displayName,
        hostType: params.hostType,
        mcpSessionId: joined.session.id,
      };
      bindings.set(selfKey(sessionId), binding);
      log.info("member_joined", {
        sessionId,
        memberId: binding.memberId,
        agentId: binding.agentId,
        projectId: binding.projectId,
        groupId: binding.groupId,
        hostType: binding.hostType,
        mcpSessionId: binding.mcpSessionId,
      });
      return toJoinResult(binding, heartbeat);
    },

    async waitForMessages(sessionId, params) {
      const binding = bindingFor(sessionId);
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
        throw invalidArgument(`timeoutMs 必须是 1–${MAX_WAIT_TIMEOUT_MS} 的整数`, { timeoutMs });
      }
      if (waitingMembers.has(binding.memberId)) {
        throw new McpToolError("CONFLICT", "该成员已有一个未完成的等待调用");
      }
      touchSession(binding.mcpSessionId);
      if (params.signal?.aborted) {
        return { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false };
      }

      const afterSeq = cursorToSeq(params.afterCursor);
      const backlog = deliverableSince(binding, afterSeq);
      if (backlog.length > 0) {
        const delivered = markDelivered(binding, backlog);
        log.debug("wait_drained_backlog", { memberId: binding.memberId, count: delivered.messages.length });
        return {
          ok: true,
          status: "message",
          messages: delivered.messages,
          cursor: seqCursor(delivered.lastSeq),
          drainedBacklog: true,
        };
      }

      waitingMembers.add(binding.memberId);
      return await new Promise<WaitResult>((resolve) => {
        const entry: PendingWait = {
          ownerKey: memberKey,
          memberId: binding.memberId,
          groupId: binding.groupId,
          resolve,
          settled: () => {
            if (entry.abortListener && params.signal) {
              params.signal.removeEventListener("abort", entry.abortListener);
            }
          },
          done: false,
          timer: null,
          abortListener: null,
        };
        entry.timer = setTimeout(() => {
          log.debug("wait_timeout", { memberId: binding.memberId, timeoutMs });
          settle(entry, {
            ok: true,
            status: "timeout",
            messages: [],
            cursor: lastDeliveredCursor(binding),
            drainedBacklog: false,
          });
        }, timeoutMs);

        if (params.signal) {
          entry.abortListener = () => {
            log.debug("wait_cancelled", { memberId: binding.memberId });
            settle(entry, {
              ok: true,
              status: "cancelled",
              messages: [],
              cursor: lastDeliveredCursor(binding),
              drainedBacklog: false,
            });
          };
          params.signal.addEventListener("abort", entry.abortListener, { once: true });
        }

        pendingWaits.push(entry);
      });
    },

    sendMessage(sessionId, params) {
      const binding = bindingFor(sessionId);
      touchSession(binding.mcpSessionId);
      const text = params.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw invalidArgument("text 必填且不能为空");
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        throw invalidArgument(`text 不能超过 ${MAX_MESSAGE_LENGTH} 个字符`, { length: text.length });
      }
      const groupId = params.groupId ?? binding.groupId;
      if (groupId !== binding.groupId) {
        throw new McpToolError("FORBIDDEN", "只能向当前入群的群组发送消息");
      }

      if (params.clientMessageId) {
        const existingId = clientKeys.get(`${binding.memberId}:${params.clientMessageId}`);
        if (existingId) {
          const existing = repos.messages.get(existingId);
          return {
            ok: true,
            messageId: existingId,
            createdAt: existing?.createdAt ?? now().toISOString(),
            duplicate: true,
          };
        }
      }

      let created: DbMessage;
      try {
        created = repos.messages.create({
          groupId,
          senderMemberId: binding.memberId,
          body: text,
          mentions: params.mentions ?? [],
        });
      } catch (error) {
        throw mapRepoError(error, { groupId, memberId: binding.memberId });
      }
      if (params.clientMessageId) {
        clientKeys.set(`${binding.memberId}:${params.clientMessageId}`, created.id);
      }
      log.info("message_sent", { memberId: binding.memberId, groupId, messageId: created.id });
      // 新消息写入后，跨 core 唤醒该群组等待中的成员。
      for (const reg of [...activeRegistrations]) reg.resolveGroup(groupId);
      return { ok: true, messageId: created.id, createdAt: created.createdAt, duplicate: false };
    },

    acknowledgeMessage(sessionId, messageId) {
      const binding = bindingFor(sessionId);
      touchSession(binding.mcpSessionId);
      if (typeof messageId !== "string" || messageId.trim() === "") {
        throw invalidArgument("messageId 必填");
      }
      const message = repos.messages.get(messageId);
      if (!message || message.groupId !== binding.groupId) {
        throw new McpToolError("FORBIDDEN", "消息不存在或不在允许范围内", { messageId });
      }
      if (!isVisibleTo(binding, message)) {
        throw new McpToolError("FORBIDDEN", "无权确认该消息", { messageId });
      }
      const delivery = repos.deliveries.get(messageId, binding.memberId);
      const alreadyAcknowledged = delivery?.status === "acked";
      if (!alreadyAcknowledged) {
        repos.deliveries.recordAttempt(messageId, binding.memberId, "acked");
        log.debug("message_acknowledged", { memberId: binding.memberId, messageId });
      }
      return { ok: true, messageId, alreadyAcknowledged };
    },

    reportStatus(sessionId, params) {
      const binding = bindingFor(sessionId);
      touchSession(binding.mcpSessionId);
      if (!RUNNING_STATES.has(params.status)) {
        throw invalidArgument("status 必须是 waiting 或 working");
      }
      const projectId = params.projectId ?? binding.projectId;
      const memberId = params.memberId ?? binding.memberId;
      if (memberId !== binding.memberId) {
        throw new McpToolError("FORBIDDEN", "只能上报自己的运行状态");
      }
      if (projectId !== binding.projectId) {
        throw new McpToolError("FORBIDDEN", "只能上报当前项目的运行状态");
      }
      let updatedAt: string;
      try {
        updatedAt = repos.statuses.set(projectId, memberId, params.status).updatedAt;
      } catch (error) {
        throw mapRepoError(error, { projectId, memberId });
      }
      log.debug("status_reported", { memberId, projectId, status: params.status });
      return { ok: true, status: params.status, projectId, memberId, updatedAt };
    },

    heartbeat(sessionId) {
      const binding = bindingFor(sessionId);
      let session: McpSession;
      try {
        session = repos.mcpSessions.heartbeat(binding.mcpSessionId, now().toISOString());
      } catch (error) {
        throw mapRepoError(error, { mcpSessionId: binding.mcpSessionId });
      }
      try {
        repos.agents.touchLastSeen(binding.agentId, session.lastHeartbeatAt ?? now().toISOString());
      } catch (error) {
        log.warn("touch_last_seen_failed", { error });
      }
      return {
        ok: true,
        sessionId: session.id,
        state: "connected",
        lastHeartbeatAt: session.lastHeartbeatAt ?? now().toISOString(),
      };
    },

    readHistory(sessionId, params) {
      const binding = bindingFor(sessionId);
      touchSession(binding.mcpSessionId);
      const limit = params.limit ?? DEFAULT_HISTORY_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
        throw invalidArgument(`limit 必须是 1–${MAX_HISTORY_LIMIT} 的整数`, { limit });
      }
      const groupId = params.groupId ?? binding.groupId;
      if (groupId !== binding.groupId) {
        throw new McpToolError("FORBIDDEN", "只能读取当前入群群组的历史");
      }
      const visible = repos.messages.listByGroup(groupId).filter((m) => isVisibleTo(binding, m));

      let endIndex = visible.length;
      if (params.beforeCursor) {
        const beforeSeq = cursorToSeq(params.beforeCursor);
        const idx = visible.findIndex((m) => m.seq === beforeSeq);
        if (idx >= 0) endIndex = idx;
      }
      const startIndex = Math.max(0, endIndex - limit);
      const page = visible.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;
      return {
        ok: true,
        messages: page.map(toMessage),
        cursor: page.length > 0 ? seqCursor(page[page.length - 1]!.seq) : null,
        hasMore,
      };
    },

    get pendingWaitCount() {
      return pendingWaits.length;
    },

    isJoined(sessionId) {
      return bindings.has(selfKey(sessionId));
    },

    close() {
      if (closed) return;
      closed = true;
      activeRegistrations.delete(registration);
      let drained = 0;
      for (const entry of [...pendingWaits]) {
        if (entry.ownerKey !== memberKey) continue;
        settle(entry, {
          ok: true,
          status: "cancelled",
          messages: [],
          cursor: null,
          drainedBacklog: false,
        });
        drained += 1;
      }
      log.info("mcp_core_closed", { pendingWaitsDrained: drained });
    },

    disconnect() {
      const at = now().toISOString();
      for (const binding of bindings.values()) {
        try {
          repos.mcpSessions.disconnect(binding.mcpSessionId, at);
          // 连接断开 → 成员运行状态 off（online/waiting/working 都视为离线）。
          repos.statuses.set(binding.projectId, binding.memberId, "offline");
        } catch (error) {
          log.warn("mcp_session_disconnect_failed", { error, mcpSessionId: binding.mcpSessionId });
        }
      }
    },
  };

  const registration: CoreInternals = { core, resolveGroup };
  activeRegistrations.add(registration);

  return core;

  // -------------------------------------------------------------------------
  // 会话绑定
  // -------------------------------------------------------------------------

  function bindingFor(sessionId: string): SessionBinding {
    if (closed) throw new McpToolError("INTERNAL", "服务端正在关闭");
    const binding = bindings.get(selfKey(sessionId));
    if (!binding) throw notInGroup();
    return binding;
  }
}

function toMessage(message: DbMessage): Message {
  return {
    id: message.id,
    groupId: message.groupId,
    senderId: message.senderMemberId,
    text: message.body,
    mentions: message.mentions,
    createdAt: message.createdAt,
  };
}

function toJoinResult(binding: SessionBinding, heartbeat: Heartbeat): JoinResult {
  return {
    ok: true,
    memberId: binding.memberId,
    agentId: binding.agentId,
    projectId: binding.projectId,
    groupId: binding.groupId,
    role: binding.role,
    heartbeat,
  };
}

/** 游标 = `c_<seq>`（群组内单调 seq，稳定且可解析）。 */
function seqCursor(seq: number): string {
  return `c_${seq}`;
}

function cursorToSeq(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const match = /^c_(\d+)$/.exec(cursor);
  if (!match) return undefined;
  return Number(match[1]);
}

/** 把 repository 错误映射为 MCP 业务错误码（不改工具对外形状）。 */
function mapRepoError(error: unknown, ctx: Record<string, unknown>): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case "conflict":
        return new McpToolError("CONFLICT", `身份或成员冲突：${error.message}`, ctx);
      case "invalid_reference":
      case "invalid_argument":
      case "not_found":
        return new McpToolError("INVALID_ARGUMENT", error.message, ctx);
      case "write_failed":
        return new McpToolError("INTERNAL", error.message, ctx);
    }
  }
  if (error instanceof ConflictError) return new McpToolError("CONFLICT", error.message, ctx);
  if (error instanceof InvalidArgumentError || error instanceof InvalidReferenceError || error instanceof NotFoundError) {
    return new McpToolError("INVALID_ARGUMENT", error.message, ctx);
  }
  return new McpToolError("INTERNAL", (error as Error)?.message ?? "服务端内部错误", ctx);
}

/** 进程级优雅关闭：取消所有挂起等待（不影响已返回的调用）。幂等。 */
export function closeAllMcpCores(): void {
  for (const registration of [...activeRegistrations]) {
    registration.core.close();
  }
  activeRegistrations.clear();
}

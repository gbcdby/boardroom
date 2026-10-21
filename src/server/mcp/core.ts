import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.ts";
import { invalidArgument, McpToolError, notInGroup } from "./errors.ts";

/**
 * MCP 工具的领域核心（阶段 1 最小实现）。
 *
 * 本票只做契约与 fake client 测试：状态存在内存里，不接 SQLite。
 * 持久化（F2/T5）、消息路由/可见性/mention（T3）、限流阈值（T7）由后续票替换或扩展。
 *
 * 关键约束（D1）：连接会话状态（session）与成员运行状态（waiting/working）分开建模。
 * 工具返回的 waiting/working 只来自显式 report_status，绝不根据连接状态推断。
 */

export interface Heartbeat {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export type HostType = "claude-code" | "codex-cli" | "other";
export type MemberRole = "manager" | "normal";
export type RunStatus = "waiting" | "working";

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
  readonly memberId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly role: MemberRole;
  readonly displayName: string;
  readonly hostType: HostType;
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

/**
 * 阶段 1 的内存共享存储：多个 core 实例（Streamable HTTP 每个会话一个）
 * 必须共享同一份成员/消息/状态，否则各会话完全隔离。
 *
 * 持久化由 F2/T5 替换；本票只做契约与 fake client 测试。
 */
export interface McpStore {
  readonly sessions: Map<string, SessionBinding>;
  /** 每个群组按创建顺序的消息。 */
  readonly messagesByGroup: Map<string, Message[]>;
  /** 已投递游标：memberId -> 已确认/已投递到的最新 messageId。 */
  readonly deliveredCursor: Map<string, string>;
  /** 已确认集合："memberId:messageId"。 */
  readonly acknowledged: Set<string>;
  /** 客户端幂等键："senderId:clientMessageId" -> messageId。 */
  readonly clientMessageIds: Map<string, string>;
  /** 成员运行状态："projectId:memberId" -> { status, updatedAt }。 */
  readonly runStatus: Map<string, { status: RunStatus; updatedAt: string }>;
  /** 挂起中的等待，所有 core 共享（唤醒时可跨会话解析）。 */
  readonly pendingWaits: PendingWait[];
  /** memberId -> 是否已有未完成的等待。 */
  readonly waitingMembers: Set<string>;
}

/** 已挂在某个 store 上、且仍存活的 core；关闭时据此清理本 core 的挂起等待。 */
interface CoreRegistration {
  readonly store: McpStore;
  readonly memberKey: string;
  readonly waitingMembers: Set<string>;
}

/** 进程内仍存活的 core 注册表；close 时集中清理挂起等待。 */
const activeRegistrations = new Set<CoreRegistration>();

export function createMcpStore(): McpStore {
  return {
    sessions: new Map(),
    messagesByGroup: new Map(),
    deliveredCursor: new Map(),
    acknowledged: new Set(),
    clientMessageIds: new Map(),
    runStatus: new Map(),
    pendingWaits: [],
    waitingMembers: new Set(),
  };
}

export interface McpCoreOptions {
  readonly logger: Logger;
  readonly heartbeat?: Heartbeat;
  readonly now?: () => Date;
  /**
   * 主体标识：把 MCP 会话标识前缀化，避免不同传输实例的会话 ID 冲突。
   *
   * - Streamable HTTP：一个 MCP 客户端会话对应一个 core，`memberKey` 由会话 ID 派生。
   * - stdio：整进程一个 core，键固定。
   * - 测试（InMemoryTransport）：每个成员一个 core，必须是不同成员（各自连接不同 server）。
   */
  readonly memberKey?: string;
  /** 共享存储；缺省时本 core 独占一份（单成员场景）。 */
  readonly store?: McpStore;
}

/** 挂起中等待的内部条目。 */
interface PendingWait {
  readonly entryId: string;
  /** 发起等待的 core（ownerKey）+ 成员；用于 close 时只清理本 core 的等待。 */
  readonly ownerKey: string;
  readonly memberId: string;
  readonly resolve: (result: WaitResult) => void;
  readonly settled: () => void;
  done: boolean;
  timer: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
}

export interface McpCore {
  join(sessionId: string, params: JoinParams): JoinResult;
  waitForMessages(sessionId: string, params: WaitParams): Promise<WaitResult>;
  sendMessage(sessionId: string, params: SendMessageParams): SendMessageResult;
  acknowledgeMessage(sessionId: string, messageId: string): AcknowledgeResult;
  reportStatus(sessionId: string, params: { status: RunStatus; projectId?: string; memberId?: string }): StatusResult;
  readHistory(sessionId: string, params: ReadHistoryParams): ReadHistoryResult;
  /** 当前挂起等待数（测试与观测用）。 */
  readonly pendingWaitCount: number;
  /** 某个会话是否已入群（测试用）。 */
  isJoined(sessionId: string): boolean;
  /** 中止所有挂起等待并以 cancelled 返回；用于优雅关闭。 */
  close(): void;
}

/**
 * 创建领域核心。所有工具处理都经过 {@link McpCore}，server 层只负责 MCP 协议装配。
 */
export function createMcpCore(options: McpCoreOptions): McpCore {
  const log = options.logger.child({ component: "mcp-core" });
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;
  const now = options.now ?? (() => new Date());
  const memberKey = options.memberKey ?? "default";

  /** 把 MCP 会话标识映射为本次 core 内的主体键。 */
  function selfKey(sessionId: string): string {
    return `${memberKey}:${sessionId}`;
  }

  const store = options.store ?? createMcpStore();
  const {
    sessions,
    messagesByGroup,
    deliveredCursor,
    acknowledged,
    clientMessageIds,
    runStatus,
    pendingWaits,
    waitingMembers,
  } = store;

  /** 本 core 注册在 store 上，仅用于 close 时清理「本 core 的」挂起等待。 */
  const registration: CoreRegistration = { store, memberKey, waitingMembers };
  activeRegistrations.add(registration);
  /** 本 core 发起等待时的所有者标记：memberKey + 会话主体键。 */
  const ownerPrefix = memberKey;

  let closed = false;

  function bindingFor(sessionId: string): SessionBinding {
    if (closed) throw new McpToolError("INTERNAL", "服务端正在关闭");
    const binding = sessions.get(selfKey(sessionId));
    if (!binding) throw notInGroup();
    return binding;
  }

  function messagesFor(groupId: string): Message[] {
    let list = messagesByGroup.get(groupId);
    if (!list) {
      list = [];
      messagesByGroup.set(groupId, list);
    }
    return list;
  }

  /** 本 core 拥有的成员 ID 集合（store 可能被多个 core 共享）。 */
  function ownMemberIdSet(): Set<string> {
    const ids = new Set<string>();
    for (const binding of sessions.values()) {
      if (binding.sessionId.startsWith(`${memberKey}:`)) ids.add(binding.memberId);
    }
    return ids;
  }

  /** 从游标之后取该成员「自己发送 + 被 @」的消息（D3 可见范围）。 */
  function deliverableSince(binding: SessionBinding, afterCursor: string | undefined): Message[] {
    const list = messagesFor(binding.groupId);
    let startIndex = 0;
    if (afterCursor) {
      const idx = list.findIndex((message) => message.id === afterCursor);
      if (idx >= 0) startIndex = idx + 1;
    }
    const ownMemberIds = ownMemberIdSet();
    return list
      .slice(startIndex)
      .filter(
        (message) =>
          ownMemberIds.has(message.senderId) ||
          message.mentions.some((mention) => ownMemberIds.has(mention)),
      );
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

  /** 有消息写入时，尝试唤醒该群组里第一个等待中的成员。 */
  function tryResolveWaits(groupId: string): void {
    for (const entry of [...pendingWaits]) {
      const binding = sessionBindingByMember(entry.memberId);
      if (!binding || binding.groupId !== groupId) continue;
      const messages = deliverableSince(binding, deliveredCursor.get(entry.memberId));
      if (messages.length === 0) continue;
      const cursor = messages[messages.length - 1]!.id;
      deliveredCursor.set(entry.memberId, cursor);
      settle(entry, {
        ok: true,
        status: "message",
        messages,
        cursor,
        drainedBacklog: false,
      });
      return;
    }
  }

  function sessionBindingByMember(memberId: string): SessionBinding | undefined {
    // 共享 store：等待可能由另一个 core（另一会话）发起，绑定在 store.sessions 里。
    for (const binding of store.sessions.values()) {
      if (binding.memberId === memberId) return binding;
    }
    return undefined;
  }

  return {
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

      const existing = sessions.get(selfKey(sessionId));
      if (existing) {
        // 幂等：同一会话重复 join 返回同一身份；身份不一致视为冲突。
        if (
          existing.projectId !== params.projectId ||
          existing.groupId !== params.groupId ||
          existing.displayName !== displayName ||
          existing.hostType !== params.hostType
        ) {
          throw new McpToolError("CONFLICT", "该会话已以不同身份入群，不能重复声明不同身份");
        }
        return toJoinResult(existing);
      }

      const binding: SessionBinding = {
        sessionId: selfKey(sessionId),
        memberId: `m_${randomUUID()}`,
        agentId: `a_${randomUUID()}`,
        projectId: params.projectId,
        groupId: params.groupId,
        role,
        displayName,
        hostType: params.hostType,
      };
      sessions.set(selfKey(sessionId), binding);
      log.info("member_joined", {
        sessionId,
        memberId: binding.memberId,
        projectId: binding.projectId,
        groupId: binding.groupId,
        hostType: binding.hostType,
      });
      return toJoinResult(binding);
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
      if (params.signal?.aborted) {
        return { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false };
      }

      // 先看积压：断线重连后首次等待立即返回积压。
      const backlog = deliverableSince(binding, params.afterCursor ?? deliveredCursor.get(binding.memberId));
      if (backlog.length > 0) {
        const cursor = backlog[backlog.length - 1]!.id;
        deliveredCursor.set(binding.memberId, cursor);
        log.debug("wait_drained_backlog", { memberId: binding.memberId, count: backlog.length });
        return { ok: true, status: "message", messages: backlog, cursor, drainedBacklog: true };
      }

      waitingMembers.add(binding.memberId);
      return await new Promise<WaitResult>((resolve) => {
        const entry: PendingWait = {
          entryId: `w_${randomUUID()}`,
          ownerKey: ownerPrefix,
          memberId: binding.memberId,
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
            cursor: deliveredCursor.get(binding.memberId) ?? null,
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
              cursor: deliveredCursor.get(binding.memberId) ?? null,
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
        const key = `${binding.memberId}:${params.clientMessageId}`;
        const existingId = clientMessageIds.get(key);
        if (existingId) {
          const existing = messagesFor(groupId).find((message) => message.id === existingId);
          return {
            ok: true,
            messageId: existingId,
            createdAt: existing?.createdAt ?? now().toISOString(),
            duplicate: true,
          };
        }
      }

      const message: Message = {
        id: `msg_${randomUUID()}`,
        groupId,
        senderId: binding.memberId,
        text,
        mentions: params.mentions ?? [],
        createdAt: now().toISOString(),
      };
      messagesFor(groupId).push(message);
      if (params.clientMessageId) {
        clientMessageIds.set(`${binding.memberId}:${params.clientMessageId}`, message.id);
      }
      log.info("message_sent", { memberId: binding.memberId, groupId, messageId: message.id });
      tryResolveWaits(groupId);
      return { ok: true, messageId: message.id, createdAt: message.createdAt, duplicate: false };
    },

    acknowledgeMessage(sessionId, messageId) {
      const binding = bindingFor(sessionId);
      if (typeof messageId !== "string" || messageId.trim() === "") {
        throw invalidArgument("messageId 必填");
      }
      const message = messagesFor(binding.groupId).find((item) => item.id === messageId);
      if (!message) {
        throw new McpToolError("FORBIDDEN", "消息不存在或不在允许范围内", { messageId });
      }
      const ownMemberIds = ownMemberIdSet();
      const visible =
        ownMemberIds.has(message.senderId) ||
        message.mentions.some((mention) => ownMemberIds.has(mention));
      if (!visible) {
        throw new McpToolError("FORBIDDEN", "无权确认该消息", { messageId });
      }
      const key = `${binding.memberId}:${messageId}`;
      const alreadyAcknowledged = acknowledged.has(key);
      if (!alreadyAcknowledged) {
        acknowledged.add(key);
        deliveredCursor.set(binding.memberId, messageId);
        log.debug("message_acknowledged", { memberId: binding.memberId, messageId });
      }
      return { ok: true, messageId, alreadyAcknowledged };
    },

    reportStatus(sessionId, params) {
      const binding = bindingFor(sessionId);
      if (params.status !== "waiting" && params.status !== "working") {
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
      const updatedAt = now().toISOString();
      runStatus.set(`${projectId}:${memberId}`, { status: params.status, updatedAt });
      log.debug("status_reported", { memberId, projectId, status: params.status });
      return { ok: true, status: params.status, projectId, memberId, updatedAt };
    },

    readHistory(sessionId, params) {
      const binding = bindingFor(sessionId);
      const limit = params.limit ?? DEFAULT_HISTORY_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
        throw invalidArgument(`limit 必须是 1–${MAX_HISTORY_LIMIT} 的整数`, { limit });
      }
      const groupId = params.groupId ?? binding.groupId;
      if (groupId !== binding.groupId) {
        throw new McpToolError("FORBIDDEN", "只能读取当前入群群组的历史");
      }
      const ownMemberIds = ownMemberIdSet();
      const visible = messagesFor(groupId).filter(
        (message) =>
          ownMemberIds.has(message.senderId) ||
          message.mentions.some((mention) => ownMemberIds.has(mention)),
      );

      let endIndex = visible.length;
      if (params.beforeCursor) {
        const idx = visible.findIndex((message) => message.id === params.beforeCursor);
        if (idx >= 0) endIndex = idx;
      }
      const startIndex = Math.max(0, endIndex - limit);
      const page = visible.slice(startIndex, endIndex);
      const hasMore = startIndex > 0;
      return {
        ok: true,
        messages: page,
        cursor: page.length > 0 ? page[page.length - 1]!.id : null,
        hasMore,
      };
    },

    get pendingWaitCount() {
      return pendingWaits.length;
    },

    isJoined(sessionId) {
      return sessions.has(selfKey(sessionId));
    },

    close() {
      if (closed) return;
      closed = true;
      activeRegistrations.delete(registration);
      let drained = 0;
      for (const entry of [...pendingWaits]) {
        if (entry.ownerKey !== ownerPrefix) continue;
        settle(entry, {
          ok: true,
          status: "cancelled",
          messages: [],
          cursor: deliveredCursor.get(entry.memberId) ?? null,
          drainedBacklog: false,
        });
        drained += 1;
      }
      log.info("mcp_core_closed", { pendingWaitsDrained: drained });
    },
  };

  function toJoinResult(binding: SessionBinding): JoinResult {
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
}

/** 进程级优雅关闭：取消所有挂起等待（不影响已返回的调用）。幂等。 */
export function closeAllMcpCores(): void {
  for (const registration of [...activeRegistrations]) {
    for (const entry of [...registration.store.pendingWaits]) {
      if (entry.ownerKey !== registration.memberKey) continue;
      if (entry.done) continue;
      entry.done = true;
      if (entry.timer) clearTimeout(entry.timer);
      const idx = registration.store.pendingWaits.indexOf(entry);
      if (idx >= 0) registration.store.pendingWaits.splice(idx, 1);
      registration.store.waitingMembers.delete(entry.memberId);
      entry.settled();
      entry.resolve({
        ok: true,
        status: "cancelled",
        messages: [],
        cursor: registration.store.deliveredCursor.get(entry.memberId) ?? null,
        drainedBacklog: false,
      });
    }
  }
  activeRegistrations.clear();
}

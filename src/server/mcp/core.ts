import type { Logger } from "../logger.ts";
import type { DbDriver } from "../db/driver.ts";
import {
  ConflictError,
  InvalidArgumentError,
  InvalidReferenceError,
  NotFoundError,
  RepositoryError,
} from "../db/errors.ts";
import { createRepositories, type RepositorySet } from "../db/repositories.ts";
import type { MutationDiscover } from "../db/mutation-scope.ts";
import { newId } from "../db/ids.ts";
import type { McpSession, Member, MemberKind, Message as DbMessage } from "../db/types.ts";
import { invalidArgument, McpToolError, notInGroup } from "./errors.ts";
import { parseMentions, resolveWakeAndVisibility, type RoutingMember } from "../chat/routing.ts";
import { buildRoster } from "../chat/roster.ts";
import {
  authorize,
  type Actor,
  type ActorReach,
  type AuthzRole,
  type Capability,
  type GuardScope,
  ROLE_REACH,
} from "../authz/authorize.ts";
import { actorForMember, actorForSession } from "../authz/actors.ts";
import { orgActorForMember } from "../authz/org-actors.ts";
import { createTaskService, type TaskAccess } from "../tasks/service.ts";
import { invokeTaskOperation, mapTaskToolError, TASK_OBSERVATIONS, type TaskOperation } from "../tasks/mcp.ts";
import { notifyWorkEventCommit, onWorkEventCommit } from "../tasks/events.ts";
import type { WorkEvent } from "../../shared/tasks.ts";
import type { MemoryInjection } from "../../shared/memory.ts";
import { createMemoryService, type MemoryAccess } from "../memory/service.ts";
import { invokeMemoryOperation, mapMemoryToolError, MEMORY_OBSERVATIONS, type MemoryOperation } from "../memory/mcp.ts";
import { getMemoryRuntime, scheduleMemoryReconciliation, cancelMemoryReconciliations } from "../memory/runtime.ts";
import { unavailableMemory } from "../memory/injection.ts";
import { getAdapter, isRegistered, listAdapterIds } from "./adapters/index.ts";
import { createRuntimeRepository } from "../runtime/repository.ts";
import { notifyMessageCommit } from "../runtime/dispatch-events.ts";
import {
  createAntiLoop,
  DEFAULT_ANTI_LOOP_CONFIG,
  type AntiLoop,
  type AntiLoopConfig,
  type WakeSuppressionReason,
  type WakeDecision,
} from "../chat/antiloop.ts";

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

/**
 * `HostType` 改为开放类型（#56 / F1）：任何已注册宿主适配器 id + 内建 `"other"`，
 * 不再写死联合类型。此处从 `db/types.ts` 统一导入并再导出，保持既有导入方不变；
 * 宿主 id 的单一事实来源是 `src/server/mcp/adapters/index.ts` 的注册表
 * （`listAdapterIds()` / `defaultRegistry`）；`KNOWN_HOST_TYPES` 仅是方便阅读的已知宿主快照。
 *
 * T2（#58）：core 的运行期硬编码已收敛到宿主适配层注册表（`src/server/mcp/adapters/index.ts`），
 * 单一事实来源：`join` 白名单用 `isRegistered` 校验、`DEFAULT_HOST_INTERRUPT_CAPABILITY`
 * 硬编码映射已删除（默认打断能力改从 `getAdapter(hostType).capabilities.interrupt` 读取）、
 * `buildInterruptReason` 的 hostType 分支改用 `interruptReasonNote`（注册表字段）。
 * core 不再有任何按 hostType 硬编码的分支/列表。
 */
import type { HostType } from "../db/types.ts";
export type { HostType };
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
  readonly membershipRevision: number;
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

/**
 * T6（#53）MCP 会话上下文：入群（会话建立）时注入，使 agent 在后续对话中知道自己身处哪个
 * 项目/群组、本方岗位与身份、可见性范围与跨项目隔离边界。
 *
 * 可见性范围（`visibility.scope`）由 F2 守卫结果推导：
 * - `write`：`group:post` 经守卫放行（参与者 / 顶层 manager 等）→ 可发言、可唤醒；
 * - `read_only`：`group:post` 被拒但 `group:view` 放行（子树只读可见 `group:view_subtree`）
 *   → 仅含元数据与历史，不暴露发言/唤醒能力；
 * - `none`：既不可写也不可见（异常入群，正常流程不应出现）。
 *
 * 隔离边界（`isolation`）固定 `crossProjectAccess: false`：上下文只含所属项目/群组的参与者，
 * 绝不出现任何跨项目数据（MCPCTX-02 / AC-PROJ-GUARD-01）。
 */
export interface McpSessionContext {
  readonly memory?: MemoryInjection;
  readonly project: { readonly id: string; readonly name: string };
  readonly group: { readonly id: string; readonly name: string };
  readonly identity: {
    readonly memberId: string;
    readonly displayName: string;
    /** 静态角色（F2）：owner / top_manager / sub_manager / member。 */
    readonly role: AuthzRole;
    /** 管辖范围（F2）：own / subtree / project。 */
    readonly reach: ActorReach;
  };
  readonly visibility: {
    /** 能否在群内发言：当且仅当 `group:post` 经 F2 守卫放行。 */
    readonly canPost: boolean;
    /** 能否唤醒他人：仅可写时为真（只读可见性不开放唤醒，CHAT-05）。 */
    readonly canWake: boolean;
    /** 可见性范围：write / read_only / none。 */
    readonly scope: "write" | "read_only" | "none";
  };
  /** 可见参与者名单（均在群内、同属一个项目，绝不跨项目）。 */
  readonly participants: ReadonlyArray<{
    readonly memberId: string;
    readonly displayName: string;
    readonly role: MemberRole;
    readonly kind: MemberKind;
  }>;
  /** 跨项目隔离边界：本会话唯一可访问项目，绝不开放跨项目访问。 */
  readonly isolation: {
    readonly projectId: string;
    readonly crossProjectAccess: false;
    readonly note: string;
  };
}

export interface JoinResult {
  readonly ok: true;
  readonly memberId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly role: MemberRole;
  readonly heartbeat: Heartbeat;
  /** T6（#53）：入群即注入的会话上下文。 */
  readonly context: McpSessionContext;
  readonly workEvents?: WorkEvent[];
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

export type WaitStatus = "message" | "work" | "timeout" | "cancelled";

export interface WaitResult {
  readonly ok: true;
  readonly status: WaitStatus;
  readonly messages: Message[];
  readonly cursor: string | null;
  readonly drainedBacklog: boolean;
  readonly workEvents?: WorkEvent[];
  readonly memory?: MemoryInjection;
}

export interface WaitParams {
  readonly timeoutMs?: number;
  readonly afterCursor?: string;
  /** 宿主/传输取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 打断尝试的三种可观察结果（T6 / #19）。
 *
 * D6（#10）实测：Claude Code **不能打断在途工具调用**；「安全点投递」是唯一可靠语义。
 * 因此：
 * - `accepted`：宿主/适配层回报「已接受打断」。这是尽力而为的乐观结果，**不**保证在途工具
 *   已停止；服务端只据此记录，不改投递语义。
 * - `rejected`：宿主明确拒绝打断（当前轮不允许插入）。
 * - `unsupported`：宿主不支持打断，或宿主能力未知（含 Claude Code 实测、Codex 未验证）。
 * 三者都**不**丢弃消息：无法打断时消息留在持久化队列，在下一安全点由 `wait_for_messages` 送达。
 */
export type InterruptResult = "accepted" | "rejected" | "unsupported";

/** 调用方（宿主适配层/测试）显式申报的宿主打断能力；缺省视为 unsupported。 */
export type HostInterruptCapability = InterruptResult;

export interface InterruptParams {
  /** 显式申报宿主能力（测试/适配层用）；缺省按 hostType 的默认能力。 */
  readonly hostCapability?: HostInterruptCapability;
}

export interface InterruptAttempt {
  readonly ok: true;
  /** 可观察结果：accepted / rejected / unsupported。 */
  readonly result: InterruptResult;
  /**
   * 打断尝试后该成员的运行状态。打断永远不把一条已经进入处理的轮次伪装成 waiting；
   * 这里恒为 `working`（与 T4 waiting/working 语义一致：wait 返回 → working）。
   */
  readonly targetStatus: RunStatus;
  /** running：成员当前处于 working（正在处理）；idle：成员不处于可打断的忙碌轮次。 */
  readonly target: "running" | "idle";
  /** 该次打断尝试的稳定 ID，用于追溯。 */
  readonly attemptId: string;
  readonly attemptedAt: string;
  /** 宿主类型与依据说明，便于写接入文档。 */
  readonly hostType: HostType;
  readonly reason: string;
  /**
   * 该成员此刻是否仍有未投递（pending）消息。无论打断结果如何，消息都保留在持久化队列，
   * 由下一安全点的 `wait_for_messages` 送达；这里只是可观察的提示，不代表模型已处理。
   */
  readonly queuedMessageCount: number;
}

export const DEFAULT_HEARTBEAT: Heartbeat = { intervalMs: 10_000, timeoutMs: 30_000 };
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 20;

/** 挂起中的等待（运行时对象，不落库）。 */
interface WaitDrainRequest {
  readonly drainedBacklog: boolean;
  readonly workOnly?: boolean;
  readonly wakeOnly?: boolean;
}

interface PendingWait {
  readonly ownerKey: string;
  readonly binding: SessionBinding;
  readonly memberId: string;
  readonly groupId: string;
  readonly afterSeq: number | undefined;
  readonly resolve: (result: WaitResult) => void;
  readonly settled: () => void;
  done: boolean;
  settling: boolean;
  deadlineReached: boolean;
  timer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  draining: Promise<boolean> | null;
  readonly drainRequests: WaitDrainRequest[];
  abortListener: (() => void) | null;
}

/**
 * 跨 core 唤醒：所有活跃 core 共享进程内的注册表，写入消息后可唤醒任意 core 上
 * 同一群组的挂起等待（Streamable HTTP 每个会话一个 core）。
 */
interface CoreInternals {
  readonly core: McpCore;
  /**
   * 唤醒本 core 中在该群组等待、且属于 `wakeGate`（T7 限流放行集合）成员的挂起等待。
   * `wakeGate` 为 undefined 表示不额外限流（仅用于内部/补投路径）。
   */
  resolveGroup(groupId: string, wakeGate?: ReadonlySet<string>): void;
}

const activeRegistrations = new Set<CoreInternals>();

/**
 * 进程级共享的防环/限流器（T7）：所有 core 共享同一实例，保证「每群组连续回复」与
 * 「每成员每分钟唤醒」跨会话累计。首次创建时的 config/now 生效；后续 core 复用。
 * 计数为内存计数，进程重启重置（见 docs/t7-antiloop-and-rate-limit.md）。
 */
let sharedAntiLoop: AntiLoop | null = null;
let sharedAntiLoopSignature = "";

function getSharedAntiLoop(options: AntiLoopRuntimeOptions | undefined): AntiLoop {
  const config = options?.config ?? {};
  const signature = JSON.stringify(config);
  if (sharedAntiLoop !== null && sharedAntiLoopSignature === signature) return sharedAntiLoop;
  sharedAntiLoop = createAntiLoop({
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });
  sharedAntiLoopSignature = signature;
  return sharedAntiLoop;
}

/** 仅供测试/观测：重置进程级共享限流器（模拟「进程重启后计数重置」）。 */
export function resetSharedAntiLoopForTests(): void {
  sharedAntiLoop = null;
  sharedAntiLoopSignature = "";
}

/**
 * 显式恢复某群组的连续自动回复计数（T7）。人类消息或显式恢复动作调用它重置计数。
 * 作用于进程级共享限流器；若尚未创建则无操作（下次发送时按 0 开始）。
 * 供 HTTP API（人的消息）与显式恢复路径复用。
 */
export function resetGroupConsecutiveCount(groupId: string): void {
  sharedAntiLoop?.resetGroup(groupId);
}

/**
 * T7（#20）防环/限流运行时配置。
 *
 * 计数与限流器**进程内共享**（见 {@link getSharedAntiLoop}）：HTTP 每个会话一个 core，
 * 但「每群组连续回复」与「每成员每分钟唤醒」都必须跨 core 累计，否则互相限不住。
 * 因此所有 core 共享同一个 {@link AntiLoop} 实例；`now` 与 `config` 取首次创建时的值。
 * stdio 进程只有单个 core，天然共享。
 */
export interface AntiLoopRuntimeOptions {
  /** 覆盖默认阈值（连续上限 / 每成员每分钟上限 / 窗口长度）。 */
  readonly config?: Partial<AntiLoopConfig>;
  /** 注入时钟（毫秒）。测试用模拟时钟；生产默认 Date.now。 */
  readonly now?: () => number;
}

/** 只能由父 supervisor 的专用传输注入；工具参数不能提供此授权。 */
export interface ManagedCoreAuthority {
  readonly identity: JoinParams & { readonly memberId: string };
  run<T>(operation: "join" | "observe" | "write" | "consume" | "disconnect", fn: () => Promise<T>, discover?: MutationDiscover): Promise<T>;
  /** wait 边界决定是否允许下一轮；false 返回取消且不投递新消息。 */
  beforeWait(): Promise<boolean>;
  /** 与投递同一短事务执行，记录离开安全点。 */
  onDelivery(): Promise<void>;
}

export interface McpCoreOptions {
  readonly logger: Logger;
  readonly db: DbDriver;
  readonly repos?: RepositorySet;
  readonly heartbeat?: Heartbeat;
  readonly now?: () => Date;
  /**
   * 主体标识：区分不同传输实例的会话前缀。
   * - Streamable HTTP：`http:<mcpSessionId>`。
   * - stdio：整进程一个 core，键固定。
   * - 测试（InMemoryTransport）：每个成员一个 core，必须不同成员。
   */
  readonly memberKey?: string;
  /** T7：防环/限流运行时配置；缺省使用 D5 默认阈值与真实时钟。 */
  readonly antiLoop?: AntiLoopRuntimeOptions;
  /**
   * F2（#47）权限守卫注入点。省略时用阶段 1 数据推导主体
   * （`members.role` 的 manager/normal → 静态角色 top_manager/member）。
   * T2（#49）落 `org_nodes` 后在这里注入岗位节点与子树范围，守卫与调用点不必再改。
   */
  readonly authz?: McpAuthzOptions;
  readonly managed?: ManagedCoreAuthority;
}

export interface McpAuthzOptions {
  /** 覆盖「会话绑定 → Actor」的映射（注入 nodeId / subtreeNodeIds）。 */
  readonly actorFor?: (binding: SessionBinding) => Promise<Actor>;
}

export interface McpCore {
  join(sessionId: string, params: JoinParams): Promise<JoinResult>;
  waitForMessages(sessionId: string, params: WaitParams): Promise<WaitResult>;
  sendMessage(sessionId: string, params: SendMessageParams): Promise<SendMessageResult>;
  acknowledgeMessage(sessionId: string, messageId: string): Promise<AcknowledgeResult>;
  reportStatus(sessionId: string, params: { status: RunStatus; projectId?: string; memberId?: string }): Promise<StatusResult>;
  /**
   * 尽力尝试打断该成员当前轮（T6 / #19）。结果可观察（accepted/rejected/unsupported）且记录；
   * 不丢弃消息——无法打断时消息保留在队列，等下一安全点送达（D6/CHAT-05）。
   */
  attemptInterrupt(sessionId: string, params?: InterruptParams): Promise<InterruptAttempt>;
  heartbeat(sessionId: string): Promise<HeartbeatResult>;
  readHistory(sessionId: string, params: ReadHistoryParams): Promise<ReadHistoryResult>;
  taskOperation(sessionId: string, operation: TaskOperation, input: unknown): Promise<Record<string, unknown>>;
  memoryOperation(sessionId: string, operation: MemoryOperation, input: unknown): Promise<Record<string, unknown>>;
  /**
   * T8（#21）：唤醒本 core 中在该群组等待、且属于 `wakeGate` 放行集合的成员。
   * 供人的 HTTP 消息路径显式触发（该路径不经过任何 core 的 send_message，因此需外部调用）。
   * `wakeGate` 为 undefined 表示不额外限流。
   */
  resolveGroup(groupId: string, wakeGate?: ReadonlySet<string>): Promise<void>;
  /** 当前挂起等待数（测试与观测用）。 */
  readonly pendingWaitCount: number;
  /** 某个会话是否已入群（测试用）。 */
  isJoined(sessionId: string): boolean;
  /** 中止本 core 所有挂起等待并以 cancelled 返回；用于优雅关闭。幂等。 */
  close(): Promise<void>;
  /** 把本 core 的持久化会话标记为断开（保留历史）。 */
  disconnect(): Promise<void>;
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

  const repos: RepositorySet = options.repos ?? createRepositories(options.db);
  const tasks = createTaskService({ repos, now,
    onWorkEvents: events => notifyWorkEventCommit(options.db, events) });
  const memoryRuntime = getMemoryRuntime(options.db);
  const memory = createMemoryService({ repos, now, config: memoryRuntime.config, injectionReader: memoryRuntime.reader,
    onWorkEvents: events => notifyWorkEventCommit(options.db, events),
    readVisibleMessages: async (access, ids) => {
      const connection = access.connection;
      const binding = connection && [...bindings.values()].find(item => item.memberId === connection.memberId
        && item.projectId === connection.projectId && item.groupId === connection.groupId);
      if (!binding || closed) return [];
      await guard(binding, "group:view", { projectId: binding.projectId, groupId: binding.groupId });
      const messages = [];
      for (const id of new Set(ids)) {
        const message = await repos.messages.get(id);
        if (message && await isVisibleTo(binding, message)) messages.push({ id: message.id, groupId: message.groupId, text: message.body, createdAt: message.createdAt });
      }
      return messages;
    },
  });
  const runtimes = createRuntimeRepository(options.db, { repos });
  /** T7：进程级共享的防环/限流器。 */
  const antiLoop = getSharedAntiLoop(options.antiLoop);
  /** 会话键 → 绑定（运行时对象，进程内维护；持久化部分在 mcp_sessions/members/agents）。 */
  const bindings = new Map<string, SessionBinding>();
  const memoryCoreKey = newId() + ":";
  const injectedVersions = new Map<string, string>();
  /** 本 core 挂起的等待。 */
  const pendingWaits: PendingWait[] = [];
  /** 每位成员最多一个并发等待。 */
  const waitingMembers = new Set<string>();
  let closed = false;
  let unsubscribeWorkEvents = () => {};

  const selfKey = (sessionId: string): string => `${memberKey}:${sessionId}`;

  async function currentBindingMember(binding: SessionBinding, allowInactive = false): Promise<Member> {
    const member = await repos.members.getIncludingRemoved(binding.memberId);
    if (!member || member.projectId !== binding.projectId || member.removedAt !== null) {
      throw new McpToolError("FORBIDDEN", "成员已移除，不能沿用旧连接。", { reason: "member_removed" });
    }
    if (!Number.isSafeInteger(binding.membershipRevision) || member.membershipRevision !== binding.membershipRevision) {
      throw new McpToolError("FORBIDDEN", "成员授权代际已变化，请重新加入会话。", { reason: "membership_changed" });
    }
    if (!allowInactive && member.status !== "active") throw new McpToolError("FORBIDDEN", "当前成员已停用，不能继续访问。", { reason: "inactive_member" });
    return member;
  }

  async function withAccess<T>(binding: SessionBinding | null,
    operation: "join" | "observe" | "write" | "consume" | "disconnect", fn: () => Promise<T>, discover?: MutationDiscover): Promise<T> {
    try {
      if (!binding) return options.managed ? await options.managed.run(operation, fn, discover) : await fn();
      const complete: MutationDiscover = async tx => {
        const found = discover ? await discover(tx) : { memberIds: [], groupIds: [], runtimeIds: [] };
        return { ...found, memberIds: [...new Set([...found.memberIds, binding.memberId])],
          groupIds: [...new Set([...found.groupIds, binding.groupId])] };
      };
      const run = async () => {
        // 停用仍允许同代连接记录退出事实；移除或代际变化不能清理恢复后的新状态。
        await currentBindingMember(binding, operation === "disconnect");
        if (!options.managed) await runtimes.assertExternalJoinAllowed(binding.memberId);
        return fn();
      };
      if (options.managed) return await options.managed.run(operation, run, complete);
      return await repos.mutations.run({ projectIds: [binding.projectId], discover: complete }, run);
    } catch (error) {
      if (error instanceof McpToolError) throw error;
      if (error instanceof RepositoryError && error.code === "conflict") {
        throw new McpToolError("CONFLICT", "运行所有权已变化或成员已由托管运行时预留");
      }
      if (error instanceof RepositoryError && error.code === "mutation_scope_changed") {
        throw new McpToolError("CONFLICT", error.message, { reason: error.code });
      }
      throw error;
    }
  }

  async function taskAccess(binding: SessionBinding): Promise<TaskAccess> {
    return {
      // 任务主体只取真实连接身份，领域服务随后按 DB 当前岗位/状态重新解析权限。
      actor: actorForSession(binding),
      connection: { projectId: binding.projectId, memberId: binding.memberId, groupId: binding.groupId, membershipRevision: binding.membershipRevision },
      runMutation: (operation, body, discover) => withAccess(binding, operation, async () => {
        // 领域冲突先转换，避免被外层运行时 fence 错认成所有权冲突。
        try { return await body(); }
        catch (error) {
          if (error instanceof RepositoryError && error.code === "conflict") throw mapTaskToolError(error);
          throw error;
        }
      }, discover),
    };
  }

  async function memoryAccess(binding: SessionBinding, background = false): Promise<MemoryAccess> {
    return { actor: actorForSession(binding),
      connection: { projectId: binding.projectId, memberId: binding.memberId, groupId: binding.groupId, membershipRevision: binding.membershipRevision },
      injectionBindingGeneration: memoryCoreKey + binding.sessionId,
      runMutation: async (operation, body, discover) => {
        const invoke = () => withAccess(binding, operation, async () => {
          if (closed || bindings.get(binding.sessionId) !== binding) throw new McpToolError("CONFLICT", "记忆会话绑定已失效。");
          try { return await body(); }
          catch (error) {
            // 只有领域 conflict 需先转换以避免运行时 fence 改写原因；
            // 其他错误（包括权限回滚包装）交回 service 恢复原始语义。
            if (error instanceof RepositoryError && error.code === "conflict") throw mapMemoryToolError(error);
            throw error;
          }
        }, discover);
        if (!background || options.db.kind !== "postgres") return await invoke();
        // 自动补偿先设置真实数据库超时，再取得成员/fence 锁；不留下后台占池或锁等待。
        return await options.db.transaction(async () => {
          await options.db.exec("SET LOCAL lock_timeout = '100ms'");
          await options.db.exec("SET LOCAL statement_timeout = '250ms'");
          return await invoke();
        });
      },
    };
  }

  async function memoryAtSafePoint(binding: SessionBinding, force = false): Promise<MemoryInjection | undefined> {
    let injection: MemoryInjection;
    try {
      await withAccess(binding, "observe", () => guard(binding, "group:view", { projectId: binding.projectId, groupId: binding.groupId }));
      injection = await memory.inject(await memoryAccess(binding));
      if (closed || bindings.get(binding.sessionId) !== binding) throw new Error("stale_memory_binding");
      await withAccess(binding, "observe", () => guard(binding, "group:view", { projectId: binding.projectId, groupId: binding.groupId }));
    } catch {
      injection = unavailableMemory(memoryRuntime.config, "memory_binding_unavailable");
    }
    const fingerprint = JSON.stringify({ state: injection.state, errors: injection.errors,
      entries: injection.entries.map(entry => [entry.scope, entry.documentId, entry.version, entry.injectedBytes, entry.truncated]) });
    if (!force && injectedVersions.get(binding.sessionId) === fingerprint) return undefined;
    injectedVersions.set(binding.sessionId, fingerprint);
    return injection;
  }

  function reconcileMemorySoon(binding: SessionBinding): void {
    if (closed) return;
    scheduleMemoryReconciliation(options.db, memoryCoreKey + binding.sessionId, async () => {
      if (closed || bindings.get(binding.sessionId) !== binding) return;
      await memory.reconcileTriggers(await memoryAccess(binding, true));
    }, () => log.warn("memory_reconciliation_failed", { projectId: binding.projectId, memberId: binding.memberId }));
  }

  // -------------------------------------------------------------------------
  // 持久化辅助
  // -------------------------------------------------------------------------

  /**
   * 入群持久化：查找/创建全局 Agent → 查找/创建项目 Member → 建立/复用 MCP 会话 → online。
   * 全局身份唯一；跨项目 member 唯一；同 agent+project+group 活跃会话唯一。
   * 冲突以明确错误返回，绝不静默创建重复身份。
   */
  async function joinPersisted(
    projectId: string,
    groupId: string,
    displayName: string,
    hostType: HostType,
    role: MemberRole,
  ): Promise<{ agentId: string; member: Member; session: McpSession }> {
    const project = await (repos.projects.get(projectId));
    if (!project) {
      throw new McpToolError("INVALID_ARGUMENT", `项目 ${projectId} 不存在，请先在 WebUI 创建`, { projectId });
    }
    const group = await (repos.groups.get(groupId));
    if (!group) {
      throw new McpToolError("INVALID_ARGUMENT", `群组 ${groupId} 不存在，请先在 WebUI 创建`, { groupId });
    }
    if (group.projectId !== projectId) {
      throw new McpToolError("INVALID_ARGUMENT", `群组 ${groupId} 不属于项目 ${projectId}`, { projectId, groupId });
    }

    const newMemberId = newId();
    const discover: MutationDiscover = async tx => {
      const member = await tx.one<{ id: string }>(`SELECT m.id FROM members m JOIN agents a ON a.id = m.agent_id
        WHERE m.project_id = ? AND a.display_name = ? AND a.host_type = ?`, [projectId, displayName, hostType]);
      return { memberIds: member ? [member.id] : [], newMemberIds: member ? [] : [newMemberId], groupIds: [groupId], runtimeIds: [] };
    };
    try {
      return await repos.mutations.run({ projectIds: [projectId], discover }, async scope => {
        // 所有授权与身份事实在项目及成员范围锁取得后重读，不能让普通 join 复活 tombstone。
        const currentProject = await repos.projects.get(projectId), currentGroup = await repos.groups.get(groupId);
        if (!currentProject || !currentGroup || currentGroup.projectId !== projectId) {
          throw new McpToolError("CONFLICT", "项目或群组已变化，请刷新后重新加入。");
        }
        if (currentProject.archivedAt !== null || currentGroup.archivedAt !== null) {
          throw new McpToolError("CONFLICT", "已归档项目或群组不能建立新连接。");
        }
        let agent = await repos.agents.findByIdentity(displayName, hostType);
        if (!agent) agent = await repos.agents.create({ displayName, hostType });
        const agentId = agent.id;
        let member = await repos.members.findByAgentIncludingRemoved(projectId, agentId);
        if (member && member.removedAt !== null) {
          throw new McpToolError("FORBIDDEN", "成员已移除，请由有权限的用户恢复成员后重新加入。", { reason: "member_removed" });
        }
        if (member && member.status !== "active") {
          throw new McpToolError("FORBIDDEN", "成员未激活或已停用，不能建立新连接。", { reason: "inactive_member" });
        }
        if (!member) {
          member = await repos.members.create({ id: newMemberId, projectId, kind: "agent", agentId, displayName,
            role: role === "manager" ? "manager" : "normal" });
        }
        scope.assertCovers([projectId], [member.id]);
        if (!options.managed) await runtimes.assertExternalJoinAllowed(member.id);
        else if (options.managed.identity.memberId !== member.id) {
          throw new McpToolError("FORBIDDEN", "托管通道不能切换成员身份");
        }
        if (member.displayName !== displayName) member = await repos.members.update(member.id, { displayName });
        await repos.groups.addParticipant(groupId, member.id);
        const session = await repos.mcpSessions.connect({ agentId, projectId, groupId, memberId: member.id, displayName, hostType });
        await repos.statuses.set(projectId, member.id, "online");
        return { agentId, member, session };
      });
    } catch (error) {
      throw mapRepoError(error, { projectId, groupId, displayName, hostType });
    }
  }

  async function touchSession(mcpSessionId: string): Promise<void> {
    try {
      const binding = [...bindings.values()].find((item) => item.mcpSessionId === mcpSessionId) ?? null;
      await withAccess(binding, "observe", () => repos.mcpSessions.heartbeat(mcpSessionId, now().toISOString()));
    } catch (error) {
      log.warn("mcp_session_heartbeat_failed", { error, mcpSessionId });
    }
  }

  /**
   * 构建群组参与者 roster（T3 路由输入）。
   *
   * 参与者来自 group_participants；role 取 members.role；kind 取 members.kind；
   * 在线判定 = 该成员有 connected 的 MCP 会话（人视为在线）。未参与群组者不进入 roster，
   * 因此可见/唤醒结果天然不含外部成员（隔离）。
   */
  async function buildRosterFor(groupId: string): Promise<RoutingMember[]> {
    return await (buildRoster(repos, groupId));
  }

  /**
   * F2（#47）统一守卫调用点：会话绑定 → Actor，带上本连接的 conn 作用域
   * （阶段 1 一个会话只绑定一个群组）与群组参与者事实，交给 `authorize` 判定；
   * 拒绝时按 MCP 契约抛 `FORBIDDEN`，并在 details 里给出稳定拒绝码。
   */
  async function guard(binding: SessionBinding, capability: Capability, scope: GuardScope, denyMessage?: string): Promise<void> {
    const member = await currentBindingMember(binding);
    const decision = authorize(
      (await options.authz?.actorFor?.(binding)) ?? (await orgActorForMember(repos, binding.memberId)) ?? actorForMember(member),
      capability,
      {
        ...scope,
        ...(scope.groupId !== undefined && scope.groupMemberIds === undefined
          ? { groupMemberIds: await (repos.groups.participants(scope.groupId)) }
          : {}),
        conn: { projectId: binding.projectId, groupIds: [binding.groupId] },
      },
    );
    if (!decision.allowed) {
      log.warn("authorize_denied", {
        memberId: binding.memberId,
        capability,
        deny: decision.code,
      });
      throw new McpToolError("FORBIDDEN", denyMessage ?? decision.reason, {
        deny: decision.code,
        capability: String(decision.capability ?? capability),
      });
    }
  }

  /**
   * 等待循环 ↔ waiting/working 的对应（T4 / AGENT-04）。
   *
   * 子 spec 要求 waiting/working「由该成员在当前项目的显式状态信号驱动」。两类显式信号：
   * 1. 宿主主动调用 `report_status`（当前 T2 已有契约，保留不变）；
   * 2. 宿主处于 `wait_for_messages` 等待循环：开始等待 = 显式「我在等」→ waiting；
   *    等待返回（拿到消息 / 超时 / 取消）= 已离开等待、进入下一轮处理 → working。
   *
   * 这里只在**运行时**把等待循环映射为成员运行状态写入 member_statuses；不推断终端画面
   * （STATUS-02），不改连接状态（D1）。持久的 status 仍只是 waiting/working/online/offline。
   * 若宿主在等待中从未进入等待循环（如已结束本轮），则不会触发 waiting——符合
   * 「不承诺唤醒空闲宿主」的边界。
   */
  async function markWaiting(binding: SessionBinding): Promise<void> {
    try {
      await withAccess(binding, "observe", () => repos.statuses.set(binding.projectId, binding.memberId, "waiting"));
    } catch (error) {
      log.warn("status_waiting_write_failed", { error, memberId: binding.memberId });
    }
  }

  async function markWorking(binding: SessionBinding): Promise<void> {
    try {
      await withAccess(binding, "observe", () => repos.statuses.set(binding.projectId, binding.memberId, "working"));
    } catch (error) {
      log.warn("status_working_write_failed", { error, memberId: binding.memberId });
    }
  }

  /** 某成员对该消息的可见性（T3 路由规则：普通=自己发送+被@；manager=全部；人=全部）。 */
  async function isVisibleTo(binding: SessionBinding, message: DbMessage): Promise<boolean> {
    if (message.groupId !== binding.groupId) return false;
    return (await repos.messages.listVisibleForMember(binding, { messageId: message.id, limit: 1 })).length > 0;
  }

  /** 从 afterSeq 之后取该成员可见、且未 acked 的消息（积压/唤醒）。 */
  async function deliverableSince(binding: SessionBinding, afterSeq: number | undefined): Promise<DbMessage[]> {
    await guard(binding, "group:view", { projectId: binding.projectId, groupId: binding.groupId });
    return await repos.messages.listVisibleForMember(binding, { unackedOnly: true,
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
  }

  /** 把一批消息记为「已投递」（至少一次；acked 前可重复读取，靠 acked 过滤去重）。 */
  async function markDelivered(
    binding: SessionBinding,
    messages: DbMessage[],
  ): Promise<{ messages: Message[]; lastSeq: number }> {
    return await withAccess(binding, "consume", async () => {
    const result: Message[] = [];
    for (const message of messages) {
      // 投递事实是可恢复性的组成部分；持久化失败时整批回滚、保留积压，
      // 不成功返回消息后再让 ACK 永久抹掉缺失的首次投递来源。
      await (repos.deliveries.markMcpDelivered(message.id, binding.memberId));
      result.push(toMessage(message));
    }
    if (options.managed) await options.managed.onDelivery();
    return { messages: result, lastSeq: messages[messages.length - 1]!.seq };
    });
  }

  /** 某成员最后一条非 pending 消息的游标（timeout/cancelled 时回显 afterCursor）。 */
  async function lastDeliveredCursor(binding: SessionBinding): Promise<string | null> {
    const lastSeq = await repos.messages.lastDeliveredSeq(binding);
    return lastSeq === null ? null : seqCursor(lastSeq);
  }

  async function settle(entry: PendingWait, result: WaitResult): Promise<void> {
    if (entry.done) return;
    const finish = (value: WaitResult): void => {
      if (entry.done) return;
      entry.done = true; entry.drainRequests.length = 0;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      const idx = pendingWaits.indexOf(entry);
      if (idx >= 0) pendingWaits.splice(idx, 1);
      waitingMembers.delete(entry.memberId);
      entry.settled(); entry.resolve(value);
    };
    const cancelled = (): WaitResult => ({ ok: true, status: 'cancelled', messages: [], cursor: null, drainedBacklog: false,
      memory: unavailableMemory(memoryRuntime.config, 'memory_binding_unavailable') });
    // 关闭/取消可在外部reader等待期间抢先结束，但绝不携带正在准备的旧payload。
    if (closed || result.status === 'cancelled') { finish(closed ? cancelled() : result); return; }
    if (entry.settling) return;
    entry.settling = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    const binding = entry.binding;
    let published = false;
    try {
      // 状态写入真实提交后才能继续；这里不能使用吞错的best-effort markWorking。
      await withAccess(binding, 'observe', async () => {
        await guard(binding, 'group:view', { projectId: binding.projectId, groupId: binding.groupId });
        await repos.statuses.set(binding.projectId, binding.memberId, 'working');
      });
      const injection = await memoryAtSafePoint(binding);
      // 投递事实已在drain的consume事务提交。最终发布段只做可信fresh校验：
      // 检查和resolve处在同一持锁边界，没有锁释放后的异步payload返回窗口。
      await withAccess(binding, 'consume', async () => {
        if (entry.done) return;
        if (closed || bindings.get(binding.sessionId) !== binding) throw new McpToolError('FORBIDDEN', '等待所绑定的会话已失效。');
        await guard(binding, 'group:view', { projectId: binding.projectId, groupId: binding.groupId });
        for (const message of result.messages) {
          if (!(await repos.messages.listVisibleForMember(binding, { messageId: message.id, limit: 1 })).length) {
            throw new McpToolError('FORBIDDEN', '消息在最终兑现前已失去可见权限。');
          }
        }
        if (result.workEvents?.length) {
          const current = new Set((await tasks.listWorkEvents(await taskAccess(binding), binding.projectId)).map(event => event.id));
          if (result.workEvents.some(event => !current.has(event.id))) throw new McpToolError('FORBIDDEN', '工作事件在最终兑现前已失效。');
        }
        // 可能经过多条ACL查询；在同步resolve前再经过managed fence/代际校验。
        await withAccess(binding, 'consume', async () => {
          if (entry.done) return;
          if (closed || bindings.get(binding.sessionId) !== binding) throw new McpToolError('FORBIDDEN', '等待所绑定的会话已失效。');
          finish(injection ? { ...result, memory: injection } : result);
          published = true;
        });
      });
    } catch (error) {
      log.warn('wait_settlement_rejected', { error, memberId: binding.memberId });
      finish(cancelled());
    } finally { entry.settling = false; }
    if (published) reconcileMemorySoon(binding);
  }

  /** 串行结算同一次等待，工作事件不会扩大聊天的 mention 唤醒范围。 */
  async function drainWait(entry: PendingWait, binding: SessionBinding, input: WaitDrainRequest, finalCheck = false): Promise<boolean> {
    if (entry.done || (entry.deadlineReached && !finalCheck)) return false;
    // 正在读取的快照可能早于新通知。最多保留积压、聊天唤醒、工作通知各一次重扫；
    // 保留各自的唤醒限制，不能用工作轮询覆盖聊天唤醒，也不能放宽 anti-loop 门控。
    if (!entry.drainRequests.some(request => request.drainedBacklog === input.drainedBacklog
      && request.workOnly === input.workOnly && request.wakeOnly === input.wakeOnly)) {
      entry.drainRequests.push(input);
    }
    if (entry.draining) return await entry.draining;
    async function drainSnapshot(input: WaitDrainRequest): Promise<boolean> {
      const access = await taskAccess(binding);
      const available = await withAccess(binding, "observe", () => tasks.listWorkEvents(access, binding.projectId));
      if (input.workOnly && available.length === 0) return false;
      const delivered = await withAccess(binding, "consume", async () => {
        if (entry.done) return null;
        // 取得共同项目/成员范围后按最新岗位、参与边和任务关系读取；不投递锁外旧 ACL 快照。
        let messages = await deliverableSince(binding, entry.afterSeq);
        if (input.wakeOnly && available.length === 0) {
          const roster = await buildRosterFor(binding.groupId);
          messages = messages.filter(message => resolveWakeAndVisibility({ senderMemberId: message.senderMemberId,
            mentionIds: message.mentions, mentionsAll: false }, roster).wake.includes(binding.memberId));
        }
        const workEvents = available.length ? await tasks.deliverWorkEvents(access, binding.projectId) : [];
        const batch = messages.length ? await markDelivered(binding, messages) : null;
        if (workEvents.length && !batch && options.managed) await options.managed.onDelivery();
        return { workEvents, batch };
      });
      if (!delivered || entry.done) return false;
      if (!delivered.batch && delivered.workEvents.length === 0) return false;
      await settle(entry, { ok: true, status: delivered.batch ? "message" : "work",
        messages: delivered.batch?.messages ?? [],
        cursor: delivered.batch ? seqCursor(delivered.batch.lastSeq) : await lastDeliveredCursor(binding),
        drainedBacklog: input.drainedBacklog,
        ...(delivered.workEvents.length ? { workEvents: delivered.workEvents } : {}),
      });
      return true;
    }
    const pending = (async () => {
      try {
        while (!entry.done && entry.drainRequests.length > 0) {
          if (await drainSnapshot(entry.drainRequests.shift()!)) return true;
        }
        return false;
      } finally { entry.draining = null; }
    })();
    entry.draining = pending;
    return await pending;
  }

  async function resolveWorkEvents(events?: readonly WorkEvent[]): Promise<void> {
    for (const entry of [...pendingWaits]) {
      const binding = bindingByMember(entry.memberId);
      if (!binding || (events && !events.some(event => event.projectId === binding.projectId && event.recipientMemberId === binding.memberId))) continue;
      try { await drainWait(entry, binding, { drainedBacklog: false, workOnly: true }); }
      catch (error) {
        log.warn("work_event_delivery_failed", { error, memberId: binding.memberId });
        await settle(entry, { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false });
      }
    }
  }

  /**
   * 唤醒本 core 中在该群组等待、且「按路由规则应被唤醒」的成员。
   * 由「写入消息的 core」调用，跨 core 时通过注册表遍历所有 core。
   *
   * 唤醒判定用 chat/routing 的 wake 集合（普通 agent 只被 @、manager 被其他成员消息、
   * 发送者排除）。可见但非唤醒的消息（例如普通 agent 自己发的）不会触发等待方返回。
   */
  async function resolveGroupInternal(groupId: string, wakeGate?: ReadonlySet<string>): Promise<void> {
    for (const entry of [...pendingWaits]) {
      const binding = bindingByMember(entry.memberId);
      if (!binding || binding.groupId !== groupId) continue;
      // T7：限流门控——某成员不在放行集合内则本次不唤醒（其消息仍为 pending，后续补投）。
      if (wakeGate && !wakeGate.has(binding.memberId)) continue;
      try { await drainWait(entry, binding, { drainedBacklog: false, wakeOnly: true }); } catch (error) {
        await settle(entry, { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false });
        if (options.managed) continue;
        throw error;
      }
    }
  }

  function bindingByMember(memberId: string): SessionBinding | undefined {
    for (const binding of bindings.values()) {
      if (binding.memberId === memberId) return binding;
    }
    return undefined;
  }

  /**
   * T7：判定一条消息的发送者类别（人类 / agent）。
   * 经 MCP `send_message` 的消息发送者都是 agent；这里按成员 kind 兜底判定，
   * 为将来「人通过 MCP 发送」保留正确语义（人类消息重置连续计数）。
   */
  async function senderKindOf(memberId: string): Promise<"agent" | "human"> {
    try {
      return (await (repos.members.get(memberId)))?.kind === "human" ? "human" : "agent";
    } catch (error) {
      // 查库失败不静默：记录 warn（仅错误摘要与 memberId，不含消息正文），再兜底为 agent。
      log.warn("sender_kind_lookup_failed", { error, memberId });
      return "agent";
    }
  }

  // -------------------------------------------------------------------------
  // 工具实现
  // -------------------------------------------------------------------------

  const core: McpCore = {
    async join(sessionId, params) {
      if (options.managed) {
        const expected = options.managed.identity;
        if (params.displayName !== expected.displayName || params.hostType !== expected.hostType ||
          params.projectId !== expected.projectId || params.groupId !== expected.groupId ||
          (params.role !== undefined && params.role !== (expected.role ?? "normal"))) {
          throw new McpToolError("FORBIDDEN", "托管通道仅允许当前绑定身份");
        }
      }
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
      if (!isRegistered(params.hostType)) {
        throw invalidArgument(
          `未知 hostType：请先注册宿主适配器（${[...listAdapterIds()].sort().join(" / ")}）`,
        );
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
        return toJoinResult(existing, heartbeat, await (buildSessionContext(existing)));
      }

      const joined = await (joinPersisted(params.projectId, params.groupId, displayName, params.hostType, role));
      const binding: SessionBinding = {
        sessionId: selfKey(sessionId),
        agentId: joined.agentId,
        memberId: joined.member.id,
        membershipRevision: joined.member.membershipRevision,
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
      return toJoinResult(binding, heartbeat, await buildSessionContext(binding));
    },

    async taskOperation(sessionId, operation, input) {
      const binding = bindingFor(sessionId);
      try {
        const access = await taskAccess(binding);
        const invoke = async () => {
          try { return await invokeTaskOperation(tasks, access, binding.projectId, operation, input); }
          catch (error) { throw mapTaskToolError(error); }
        };
        if (TASK_OBSERVATIONS.has(operation)) return await withAccess(binding, "observe", invoke);
        // 长 Git 采集不持有运行时/数据库锁，服务的每次短提交重新使用 runMutation fence。
        await withAccess(binding, "observe", async () => {});
        return await invoke();
      } catch (error) { throw mapTaskToolError(error); }
    },

    async memoryOperation(sessionId, operation, input) {
      const binding = bindingFor(sessionId);
      try {
        const access = await memoryAccess(binding);
        const invoke = async () => {
          try { return await invokeMemoryOperation(memory, access, binding, operation, input); }
          catch (error) { throw mapMemoryToolError(error); }
        };
        if (MEMORY_OBSERVATIONS.has(operation)) return await withAccess(binding, "observe", invoke);
        await withAccess(binding, "observe", async () => {});
        return await invoke();
      } catch (error) { throw mapMemoryToolError(error); }
    },

    async waitForMessages(sessionId, params) {
      const binding = bindingFor(sessionId);
      if (options.managed && !await options.managed.beforeWait()) {
        return { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false };
      }
      await withAccess(binding, "observe", async () => {});
      const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
        throw invalidArgument(`timeoutMs 必须是 1–${MAX_WAIT_TIMEOUT_MS} 的整数`, { timeoutMs });
      }
      if (waitingMembers.has(binding.memberId)) {
        throw new McpToolError("CONFLICT", "该成员已有一个未完成的等待调用");
      }
      await (touchSession(binding.mcpSessionId));
      if (params.signal?.aborted) {
        return { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false };
      }

      // #61/PG：先登记挂起等待（入队 pendingWaits + waitingMembers），再做任何异步读取。
      // PostgreSQL 下 deliverableSince / markWaiting 是网络往返、延迟更大；若不先登记，
      // 唤醒（resolveGroup）可能在等待登记前执行，导致消息漏投（SQLite 延迟小不易暴露）。
      const afterSeq = cursorToSeq(params.afterCursor);
      waitingMembers.add(binding.memberId);
      let entry!: PendingWait;
      const waitPromise = new Promise<WaitResult>((resolve) => {
        entry = {
          ownerKey: memberKey,
          binding,
          memberId: binding.memberId,
          groupId: binding.groupId,
          afterSeq,
          resolve,
          settled: () => {
            if (entry.abortListener && params.signal) {
              params.signal.removeEventListener("abort", entry.abortListener);
            }
          },
          done: false,
          settling: false,
          deadlineReached: false,
          timer: null,
          pollTimer: null,
          draining: null,
          drainRequests: [],
          abortListener: null,
        };
        entry.timer = setTimeout(async () => {
          // 到期后不再接收新重扫，收束已有有限队列和一次最终检查。
          // 不强行中断 DB 查询，但慢查询也不能被每秒 poll 无限续期。
          entry.deadlineReached = true;
          if (entry.pollTimer) clearInterval(entry.pollTimer);
          log.debug("wait_timeout", { memberId: binding.memberId, timeoutMs });
          try {
            if (await drainWait(entry, binding, { drainedBacklog: false, workOnly: true }, true)) return;
            await settle(entry, { ok: true, status: "timeout", messages: [], cursor: await lastDeliveredCursor(binding), drainedBacklog: false });
          } catch (error) {
            log.warn("wait_work_event_check_failed", { error, memberId: binding.memberId });
            await settle(entry, { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false });
          }
        }, timeoutMs);
        // stdio 与 HTTP 可处于不同进程；持久查询补足进程内通知，仍只在宿主已挂起的 wait 安全点返回。
        entry.pollTimer = setInterval(() => { void resolveWorkEvents(); }, 1000);
        entry.pollTimer.unref();
        if (params.signal) {
          entry.abortListener = async () => {
            log.debug("wait_cancelled", { memberId: binding.memberId });
            await (settle(entry, {
              ok: true,
              status: "cancelled",
              messages: [],
              cursor: await (lastDeliveredCursor(binding)),
              drainedBacklog: false,
            }));
          };
          params.signal.addEventListener("abort", entry.abortListener, { once: true });
        }
        pendingWaits.push(entry);
      });

      try {
        await drainWait(entry, binding, { drainedBacklog: true });
      } catch (error) {
        await settle(entry, { ok: true, status: "cancelled", messages: [], cursor: null, drainedBacklog: false });
        throw error;
      }
      if (!entry.done) {
        await markWaiting(binding);
        if (entry.done && !closed) await markWorking(binding);
      }
      return await waitPromise;
    },

    async sendMessage(sessionId, params) {
      const binding = bindingFor(sessionId);
      await withAccess(binding, "write", async () => {});
      await (touchSession(binding.mcpSessionId));
      const text = params.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        throw invalidArgument("text 必填且不能为空");
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        throw invalidArgument(`text 不能超过 ${MAX_MESSAGE_LENGTH} 个字符`, { length: text.length });
      }
      const groupId = params.groupId ?? binding.groupId;
      // F2（#47）：跨群组写入由统一守卫判定（conn 作用域 + group:post 参与范围）。
      await (guard(binding, "group:post", { projectId: binding.projectId, groupId }, "只能向当前入群的群组发送消息"));

      // T5：消息落库与「可见成员的 pending 投递」在同一事务内完成，避免中途崩溃留下
      // 消息可见却无任何投递记录的半成品（NFR-01/NFR-09）。即便极端情况下缺失投递记录，
      // wait_for_messages 的 deliverableSince 仍按「未 acked」补投，不丢消息（见测试）。
      const discover: MutationDiscover = async tx => {
        const rows = await tx.query<{ id: string }>(`SELECT m.id FROM group_participants gp JOIN members m ON m.id = gp.member_id
          JOIN groups g ON g.id = gp.group_id WHERE gp.group_id = ? AND g.project_id = ? AND m.project_id = ? ORDER BY m.id LIMIT 2049`,
          [groupId, binding.projectId, binding.projectId]);
        if (rows.length > 2048) throw new RepositoryError("mutation_scope_changed", "当前群组接收成员超过有界变更范围。");
        return { memberIds: rows.map(row => row.id), groupIds: [groupId], runtimeIds: [] };
      };
      let persisted: { message: DbMessage; duplicate: true } |
        { message: DbMessage; duplicate: false; decision: WakeDecision; plan: ReturnType<typeof resolveWakeAndVisibility> };
      try {
        persisted = await withAccess(binding, "write", async () => {
          await guard(binding, "group:post", { projectId: binding.projectId, groupId }, "只能向当前入群的群组发送消息");
          // 事务外查重只是优化；并发请求必须在实际提交范围内再查，并由唯一索引兜底。
          if (params.clientMessageId) {
            const existing = await repos.messages.findByClientKey(binding.memberId, params.clientMessageId);
            if (existing) return { message: existing, duplicate: true as const };
          }
          // T3：mention 解析。显式 mentions 入参（稳定 ID）+ 正文里的 @ 名称/@all 合并。
          const roster = await (buildRosterFor(groupId));
          const parsed = parseMentions(text, roster);
          if (parsed.unknownNames.length > 0) {
            // 无效 mention 明确报错（失败路径之一），不静默丢弃。
            throw new McpToolError("INVALID_ARGUMENT", `无法解析 @ 名称：${parsed.unknownNames.join("、")}`, {
              unknownNames: parsed.unknownNames,
            });
          }
          const explicitMentions = (params.mentions ?? []).filter((id) => {
            // 显式 mention 必须是本群参与者（防止跨群/外部 ID 泄漏）。
            if (!roster.some((m) => m.id === id)) {
              throw new McpToolError("INVALID_ARGUMENT", `被 @ 的成员 ${id} 不是当前群组参与者`, { memberId: id });
            }
            return true;
          });
          const mentionIds = [...new Set([...explicitMentions, ...parsed.mentionIds])];

          // @all：展开为发送时在线参与者快照，并把快照成员写入持久化 mentions，
          // 使历史/投递与「发送时在线」一致（CHAT-02）。
          const plan = resolveWakeAndVisibility(
            { senderMemberId: binding.memberId, mentionIds, mentionsAll: parsed.all },
            roster,
          );
          const persistedMentions = [...new Set([...mentionIds, ...plan.allRecipients])];

          const message = await (repos.messages.create({
            groupId,
            senderMemberId: binding.memberId,
            body: text,
            // 持久化解析后的稳定成员 ID（含 @all 快照），不存 @all 语义本身。
            mentions: persistedMentions,
            ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}),
          }));
          // 去重胜者才登记防环。判定与所有投递一起提交，通知只在提交成功后发出。
          // 防环计数仍是进程内状态；后续写入回滚时可能保守多计一次，不撤销其他请求的计数。
          const decision = antiLoop.registerMessage({
            groupId,
            senderKind: await senderKindOf(binding.memberId),
            candidateWake: plan.wake,
          });
          const allowed = new Set(decision.allowed);
          // 为所有「可见」成员建立 pending 投递（含发送者自己，便于自身历史一致性）。
          // 只对 visible 建投递，保证未参与/不可见成员无投递记录（不泄漏）。
          for (const memberId of plan.visible) {
            const reason = decision.suppressed.get(memberId);
            await repos.deliveries.ensure(message.id, memberId,
              reason ? { decision: "suppressed", reason } :
                allowed.has(memberId) ? { decision: "allowed" } : undefined);
          }
          return { message, duplicate: false as const, decision, plan };
        }, discover);
      } catch (error) {
        // 跨连接/进程竞争唯一键：失败事务已经回滚，再读取已提交胜者。
        if (params.clientMessageId && error instanceof RepositoryError && error.code === "conflict") {
          const existing = await repos.messages.findByClientKey(binding.memberId, params.clientMessageId);
          if (existing) return { ok: true, messageId: existing.id, createdAt: existing.createdAt, duplicate: true };
        }
        throw mapRepoError(error, { groupId, memberId: binding.memberId });
      }
      const created = persisted.message;
      if (persisted.duplicate) return { ok: true, messageId: created.id, createdAt: created.createdAt, duplicate: true };
      const { decision, plan } = persisted;
      await notifyMessageCommit(options.db, created.id);
      log.info("message_sent", {
        memberId: binding.memberId,
        groupId,
        messageId: created.id,
        wake: plan.wake,
        visible: plan.visible,
      });

      // T7：报告本次已持久化的防环/限流判定。被抑制的 pending 投递继续保留，
      // 主动 wait 可补投；不会因为发送重试而重新登记限流或发布相同唤醒提示。
      if (decision.suppressed.size > 0) {
        // 只记结构化元信息（原因、成员、计数），不记消息正文（NFR-05 / T7 可观察性）。
        const byReason: Record<WakeSuppressionReason, string[]> = { consecutive_limit: [], rate_limited: [] };
        for (const [memberId, reason] of decision.suppressed) byReason[reason].push(memberId);
        log.warn("wake_suppressed", {
          groupId,
          messageId: created.id,
          consecutiveAutoReplies: decision.consecutiveAutoReplies,
          consecutiveLimit: antiLoop.config.maxConsecutiveAutoReplies,
          consecutiveCapReached: decision.consecutiveCapReached,
          rateLimited: byReason.rate_limited,
          consecutiveLimited: byReason.consecutive_limit,
          maxWakesPerMinutePerMember: antiLoop.config.maxWakesPerMinutePerMember,
        });
      }

      // 新消息写入后，跨 core 唤醒该群组等待中的成员：只唤醒「路由 wake 集合 ∩ 限流放行」。
      if (decision.allowed.length > 0) {
        const allowedSet = new Set(decision.allowed);
        // #61：resolveGroup 已改为异步（返回 Promise<void>）。此处必须等待唤醒完成，
        // 否则唤醒作为未 await 的微任务会在 sendMessage 返回、withCtx 关闭驱动后才执行，
        // 查询会因「尚未 connect」失败（原同步语义是在发送返回前完成唤醒）。
        const wakeTasks = [...activeRegistrations].map((reg) => reg.resolveGroup(groupId, allowedSet));
        await Promise.allSettled(wakeTasks);
      }
      return { ok: true, messageId: created.id, createdAt: created.createdAt, duplicate: false };
    },

    async acknowledgeMessage(sessionId, messageId) {
      const binding = bindingFor(sessionId);
      await (touchSession(binding.mcpSessionId));
      if (typeof messageId !== "string" || messageId.trim() === "") {
        throw invalidArgument("messageId 必填");
      }
      const message = await (repos.messages.get(messageId));
      if (!message) {
        throw new McpToolError("FORBIDDEN", "消息不存在或不在允许范围内", { messageId });
      }
      // F2（#47）：确认动作同样受 conn 作用域与参与范围约束。
      await (guard(binding, "message:ack", { projectId: binding.projectId, groupId: message.groupId }, "消息不存在或不在允许范围内"));
      if (!await (isVisibleTo(binding, message))) {
        throw new McpToolError("FORBIDDEN", "无权确认该消息", { messageId });
      }
      const delivery = await (repos.deliveries.get(messageId, binding.memberId));
      const alreadyAcknowledged = delivery?.status === "acked";
      if (!alreadyAcknowledged) {
        await (repos.deliveries.recordAttempt(messageId, binding.memberId, "acked"));
        log.debug("message_acknowledged", { memberId: binding.memberId, messageId });
      }
      return { ok: true, messageId, alreadyAcknowledged };
    },

    async reportStatus(sessionId, params) {
      const binding = bindingFor(sessionId);
      await (touchSession(binding.mcpSessionId));
      if (!RUNNING_STATES.has(params.status)) {
        throw invalidArgument("status 必须是 waiting 或 working");
      }
      const projectId = params.projectId ?? binding.projectId;
      const memberId = params.memberId ?? binding.memberId;
      // F2（#47）：状态上报是 self 边界（ORG-06 只更新自己的状态），项目上下文受 conn 约束。
      await (guard(binding, "status:report_own", { projectId, memberId }, "只能上报自己的运行状态与当前项目"));
      let updatedAt: string;
      try {
        updatedAt = (await (repos.statuses.set(projectId, memberId, params.status))).updatedAt;
      } catch (error) {
        throw mapRepoError(error, { projectId, memberId });
      }
      log.debug("status_reported", { memberId, projectId, status: params.status });
      return { ok: true, status: params.status, projectId, memberId, updatedAt };
    },

    async attemptInterrupt(sessionId, params) {
      const binding = bindingFor(sessionId);
      // F2（#47）：打断只作用于自己的会话（self 边界）。
      await (guard(binding, "interrupt:self", { projectId: binding.projectId, memberId: binding.memberId }));
      await (touchSession(binding.mcpSessionId));

      // 成员当前运行状态（显式信号驱动，T4）：什么决定「是否处于可打断的忙碌轮次」。
      const currentState = (await (repos.statuses.get(binding.projectId, binding.memberId)))?.state ?? "online";
      const target: "running" | "idle" = currentState === "working" ? "running" : "idle";

      // 宿主能力：显式申报优先；缺省按 hostType 在注册表中的声明能力（单一事实来源）。
      // getAdapter 对任意 hostType 都返回合法适配器（未知回退到 UNKNOWN_ADAPTER，interrupt=unsupported）。
      const result: InterruptResult =
        params?.hostCapability ?? getAdapter(binding.hostType).capabilities.interrupt;

      // 打断永远不把已进入处理的轮次伪装成 waiting；恒为 working（与「wait 返回 → working」一致）。
      // 若成员已不在可打断的忙碌轮次（idle），仅记录一次尝试，不改运行状态。
      if (target === "running") await (markWorking(binding));

      // 消息是否仍在队列（可观察；必须与「模型已处理」区分）。
      const queuedMessageCount = (await (repos.deliveries.listPending(binding.projectId, binding.memberId))).length;

      const reason = buildInterruptReason(result, binding.hostType, target);
      const attempt: InterruptAttempt = {
        ok: true,
        result,
        targetStatus: "working",
        target,
        attemptId: newId(),
        attemptedAt: now().toISOString(),
        hostType: binding.hostType,
        reason,
        queuedMessageCount,
      };
      log.info("interrupt_attempted", {
        memberId: binding.memberId,
        hostType: binding.hostType,
        result,
        target,
        queuedMessageCount,
        attemptId: attempt.attemptId,
      });
      return attempt;
    },

    async heartbeat(sessionId) {
      const binding = bindingFor(sessionId);
      await (guard(binding, "session:heartbeat", { projectId: binding.projectId }));
      let session: McpSession;
      try {
        session = await (repos.mcpSessions.heartbeat(binding.mcpSessionId, now().toISOString()));
      } catch (error) {
        throw mapRepoError(error, { mcpSessionId: binding.mcpSessionId });
      }
      try {
        await (repos.agents.touchLastSeen(binding.agentId, session.lastHeartbeatAt ?? now().toISOString()));
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

    async readHistory(sessionId, params) {
      const binding = bindingFor(sessionId);
      await (touchSession(binding.mcpSessionId));
      const limit = params.limit ?? DEFAULT_HISTORY_LIMIT;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
        throw invalidArgument(`limit 必须是 1–${MAX_HISTORY_LIMIT} 的整数`, { limit });
      }
      const groupId = params.groupId ?? binding.groupId;
      // F2（#47）：历史读取受 conn 作用域 + 可见性判定（替代手写的群组比较）。
      await (guard(binding, "group:view", { projectId: binding.projectId, groupId }, "只能读取当前入群群组的历史"));
      let beforeSeq: number | undefined;
      if (params.beforeCursor) {
        const candidate = cursorToSeq(params.beforeCursor);
        // 沿用既有约定：未知/不可见的 beforeCursor 不改变当前可见页。
        if (candidate !== undefined && (await repos.messages.listVisibleForMember(binding, { atSeq: candidate, limit: 1 })).length) beforeSeq = candidate;
      }
      const visible = await repos.messages.listVisibleForMember(binding, { newestFirst: true, limit: limit + 1,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) });
      const hasMore = visible.length > limit;
      const page = visible.slice(0, limit).reverse();
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

    // T8（#21）：把内部的 resolveGroup 暴露给 HTTP 消息路径跨 core 唤醒。
    async resolveGroup(groupId, wakeGate) {
      await (resolveGroupInternal(groupId, wakeGate));
    },

    async close() {
      if (closed) return;
      closed = true;
      cancelMemoryReconciliations(options.db, memoryCoreKey);
      injectedVersions.clear();
      unsubscribeWorkEvents();
      activeRegistrations.delete(registration);
      let drained = 0;
      for (const entry of [...pendingWaits]) {
        if (entry.ownerKey !== memberKey) continue;
        await (settle(entry, {
          ok: true,
          status: "cancelled",
          messages: [],
          cursor: null,
          drainedBacklog: false,
        }));
        drained += 1;
      }
      log.info("mcp_core_closed", { pendingWaitsDrained: drained });
    },

    async disconnect() {
      const at = now().toISOString();
      for (const binding of bindings.values()) {
        try {
          await withAccess(binding, "disconnect", async () => {
            await repos.mcpSessions.disconnect(binding.mcpSessionId, at);
            await repos.statuses.set(binding.projectId, binding.memberId, "offline");
          });
        } catch (error) {
          log.warn("mcp_session_disconnect_failed", { error, mcpSessionId: binding.mcpSessionId });
        }
      }
    },
  };

  const registration: CoreInternals = { core, resolveGroup: resolveGroupInternal };
  activeRegistrations.add(registration);
  unsubscribeWorkEvents = onWorkEventCommit(options.db, resolveWorkEvents);

  // 短工具整体与 fence 检查处于同一事务；长等待在真正出队时再次检查。
  return {
    ...core,
    join: async (sid, params) => {
      // gateway 的 join 完成回调先确认通道就绪，再以 consume fence 领取持久工作事件。
      const result = await withAccess(bindings.get(selfKey(sid)) ?? null, "join", () => core.join(sid, params));
      const binding = bindingFor(sid);
      const access = await taskAccess(binding);
      const pending = await withAccess(binding, "observe", () => tasks.listWorkEvents(access, binding.projectId));
      const workEvents = pending.length ? await withAccess(binding, "consume", async () => {
        const events = await tasks.deliverWorkEvents(access, binding.projectId);
        if (events.length && options.managed) await options.managed.onDelivery();
        return events;
      }) : [];
      const injection = await memoryAtSafePoint(binding, true);
      reconcileMemorySoon(binding);
      return { ...result, context: { ...result.context, ...(injection ? { memory: injection } : {}) },
        ...(workEvents.length ? { workEvents } : {}) };
    },
    acknowledgeMessage: (sid, id) => withAccess(bindingFor(sid), "write", () => core.acknowledgeMessage(sid, id)),
    reportStatus: (sid, params) => withAccess(bindingFor(sid), "observe", () => core.reportStatus(sid, params)),
    heartbeat: (sid) => withAccess(bindingFor(sid), "observe", () => core.heartbeat(sid)),
    readHistory: (sid, params) => withAccess(bindingFor(sid), "consume", () => core.readHistory(sid, params)),
    attemptInterrupt: (sid, params) => withAccess(bindingFor(sid), "observe", () => core.attemptInterrupt(sid, params)),
    get pendingWaitCount() { return core.pendingWaitCount; },
  };

  // -------------------------------------------------------------------------
  // 会话绑定
  // -------------------------------------------------------------------------

  function bindingFor(sessionId: string): SessionBinding {
    if (closed) throw new McpToolError("INTERNAL", "服务端正在关闭");
    const binding = bindings.get(selfKey(sessionId));
    if (!binding) throw notInGroup();
    return binding;
  }

  /**
   * T6（#53）：入群时构建会话上下文，经 F2 守卫收窄可见性/行级范围。
   *
   * - 可见性（`write` / `read_only` / `none`）由 `group:post` 与 `group:view` 的守卫结果推导；
   *   只读可见的群组不暴露发言/唤醒能力（CHAT-05 / ORG-07）。
   * - 参与者名单只取本群组、本项目成员，绝不跨项目（MCPCTX-02 / AC-PROJ-GUARD-01）。
   * - 隔离边界固定 `crossProjectAccess: false`。
   */
  async function buildSessionContext(binding: SessionBinding): Promise<McpSessionContext> {
    const project = await (repos.projects.get(binding.projectId));
    const group = await (repos.groups.get(binding.groupId));
    const actor = (await (options.authz?.actorFor?.(binding))) ?? actorForSession(binding);
    const participantIds = await (repos.groups.participants(binding.groupId));
    const scope: GuardScope = {
      projectId: binding.projectId,
      groupId: binding.groupId,
      groupMemberIds: participantIds,
      groupMemberNodeIds: (await Promise.all(participantIds.map(async (id) => (await (repos.members.get(id)))?.nodeId ?? null))),
    };
    const canPost = authorize(actor, "group:post", scope).allowed;
    const canView = canPost || authorize(actor, "group:view", scope).allowed;
    const visibilityScope: McpSessionContext["visibility"]["scope"] = canPost
      ? "write"
      : canView
        ? "read_only"
        : "none";
    const participants = canView
      ? (await Promise.all(participantIds
          .map(async (id) => await (repos.members.get(id)))))
          .filter((m): m is Member => m !== null)
          .map((m) => ({
            memberId: m.id,
            displayName: m.displayName,
            role: m.role,
            kind: m.kind,
          }))
      : [];
    return {
      project: { id: project!.id, name: project!.name },
      group: { id: group!.id, name: group!.name },
      identity: {
        memberId: binding.memberId,
        displayName: binding.displayName,
        role: actor.role,
        reach: actor.reach ?? ROLE_REACH[actor.role],
      },
      visibility: { canPost, canWake: canPost, scope: visibilityScope },
      participants,
      isolation: {
        projectId: binding.projectId,
        crossProjectAccess: false,
        note: "本 MCP 会话仅可访问所属项目，跨项目数据不会出现在上下文中。",
      },
    };
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

function toJoinResult(
  binding: SessionBinding,
  heartbeat: Heartbeat,
  context: McpSessionContext,
): JoinResult {
  return {
    ok: true,
    memberId: binding.memberId,
    agentId: binding.agentId,
    projectId: binding.projectId,
    groupId: binding.groupId,
    role: binding.role,
    heartbeat,
    context,
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

/** 打断尝试的人类可读依据（随结果返回，便于写入接入文档/追溯）。 */
function buildInterruptReason(result: InterruptResult, hostType: HostType, target: "running" | "idle"): string {
  // 宿主实测说明取自注册表（单一事实来源）；未声明时回退到「宿主能力未知」。
  // 现存宿主的 interruptReasonNote 已包含与旧 hostType 分支逐字相同的解释文本（兼容既有测试）。
  const hostNote = getAdapter(hostType).interruptReasonNote ?? "宿主能力未知";
  if (target === "idle") return `成员当前不处于可打断的忙碌轮次（idle）；${hostNote}`;
  switch (result) {
    case "accepted":
      return `宿主适配层回报已接受打断（尽力而为，不保证在途工具已停止）；消息保留在队列直到下一安全点`;
    case "rejected":
      return `宿主明确拒绝打断当前轮；消息保留在队列直到下一安全点`;
    case "unsupported":
      return `服务端不阻塞、消息不丢，但无法打断在途工具；${hostNote}；消息在下一安全点投递`;
  }
}

/** 把 repository 错误映射为 MCP 业务错误码（不改工具对外形状）。 */function mapRepoError(error: unknown, ctx: Record<string, unknown>): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof RepositoryError) {
    switch (error.code) {
      case "conflict":
        return new McpToolError("CONFLICT", `身份或成员冲突：${error.message}`, ctx);
      case "archived":
        // #48：目标项目/群组已归档，写路径拒绝（恢复后放行）。
        return new McpToolError("CONFLICT", error.message, ctx);
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

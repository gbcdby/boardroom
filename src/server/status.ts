import type { HeartbeatConfig } from "./config.ts";
import type { RepositorySet } from "./db/repositories.ts";
import type { McpSession, MemberState } from "./db/types.ts";

/**
 * T4（#17）状态看板领域层：把「连接状态 + 成员运行状态 + 心跳时间戳」推导为
 * WebUI 可展示的**有效状态**。
 *
 * 关键建模（D1 / STATUS-01/02/03，保持两层分开）：
 * - **连接层**（全局 MCP 会话，`mcp_sessions`）：agent 是否 connected，以及 `last_heartbeat_at`。
 * - **成员运行层**（项目成员，`member_statuses`）：online/offline/waiting/working，仅由显式信号驱动。
 * - 本模块只做**只读推导**：不写库、不把连接存活写回 member_statuses，也不根据终端画面推断。
 *
 * 判定规则（时间以传入的 `now` 为准，便于 fake timers 测试）：
 * 1. 人（kind=human）：仅显示 online（WebUI WebSocket 已连接 + 心跳未超时）或 offline；
 *    **绝不**显示 waiting/working——人不执行 agent 轮次（子 spec STATUS-02/AC-CORE-06）。
 * 2. Agent 的连接存活 = 有 `state=connected` 的 MCP 会话，且其 `last_heartbeat_at`
 *    距 now 未超过 `heartbeat.timeoutMs`（D4 默认 30s）。超过即视为心跳超时。
 * 3. Agent 的有效状态：
 *    - 未连接 / 心跳超时 → `offline`；若该成员**曾**上报过 waiting/working（持久层仍是它们）
 *      或存在断开的历史会话，则额外标记 `stale`（陈旧），并给出 `lastHeartbeatAt` / `disconnectedAt`。
 *    - 已连接且心跳有效 → 采用 `member_statuses.state`（online/waiting/working；若持久层是 offline
 *      则按 online 处理，因为连接已恢复但尚未显式上报运行状态）。
 *    - 会话断开（disconnected）→ `offline` + `stale=true`（断线）。
 * 4. `lastHeartbeatAt` 作为**独立字段**返回，在 `timeoutMs..2*timeoutMs` 之间额外标记 `heartbeatStale`
 *    （用于「陈旧」渐变展示：仍在线但心跳变慢）；超过 2*timeoutMs 直接判离线。
 */

/** 连接层状态（全局 MCP 会话）。 */
export type ConnectionState = "connected" | "disconnected" | "none";

/** 推导后的有效展示状态。 */
export interface EffectiveStatus {
  readonly projectId: string;
  readonly memberId: string;
  readonly kind: "agent" | "human";
  readonly displayName: string;
  /** 有效运行状态（已结合心跳超时与断线）。 */
  readonly state: MemberState;
  /** 连接层原始状态。人若无 MCP 会话则为 none。 */
  readonly connection: ConnectionState;
  /** 心跳时间距 now 是否超过 timeoutMs（仅在从未连接/断开时也可能为 true）。 */
  readonly heartbeatTimedOut: boolean;
  /** 心跳时间距 now 是否超过 2*timeoutMs（更强超时，直接离线）。 */
  readonly heartbeatStale: boolean;
  /** 断线或心跳超时导致的陈旧：成员曾在线过但现在不再是有效在线/等待/工作。 */
  readonly stale: boolean;
  /** 断线（会话被标记为 disconnected 且有断开时间）。 */
  readonly disconnected: boolean;
  readonly lastHeartbeatAt: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly hostType: string | null;
  readonly updatedAt: string | null;
}

export interface DeriveContext {
  readonly heartbeat: HeartbeatConfig;
  readonly now: Date;
}

/**
 * 推导单个成员的有效状态。纯函数：只读取传入的持久化快照，便于单测与 fake timers。
 */
export function deriveEffectiveStatus(input: {
  readonly projectId: string;
  readonly memberId: string;
  readonly kind: "agent" | "human";
  readonly displayName: string;
  /** 持久化的运行状态（可能为 null）。 */
  readonly storedState: MemberState | null;
  /** 该成员最近一次 MCP 会话（含已断开的历史）；无则 null。 */
  readonly session: McpSession | null;
  readonly heartbeat: HeartbeatConfig;
  readonly now: Date;
}): EffectiveStatus {
  const { heartbeat, now } = input;
  const session = input.session;

  // 人：不执行 agent 轮次，不显示 waiting/working。人的「在线」只由 WebUI 连接派生
  // （见 status-board 的 humanPresence）；这里无会话 → 默认 offline，不把持久状态透出为 waiting/working。
  if (input.kind === "human") {
    const online = input.storedState === "online";
    return base(input, {
      state: online ? "online" : "offline",
      connection: "none",
      heartbeatTimedOut: false,
      heartbeatStale: false,
      stale: false,
      disconnected: false,
      lastHeartbeatAt: null,
      connectedAt: null,
      disconnectedAt: null,
      hostType: null,
      updatedAt: null,
    });
  }

  // Agent：连接存活 = connected 会话 + 心跳在 timeoutMs 内。
  const refTime = session?.lastHeartbeatAt ?? session?.connectedAt ?? null;
  const ageMs = refTime === null ? Infinity : now.getTime() - Date.parse(refTime);
  const heartbeatTimedOut = ageMs > heartbeat.timeoutMs;
  const heartbeatStale = ageMs > heartbeat.timeoutMs * 2;

  const connection: ConnectionState = session === null ? "none" : session.state === "connected" ? "connected" : "disconnected";
  const disconnected = connection === "disconnected";
  const live = connection === "connected" && !heartbeatTimedOut;

  let state: MemberState;
  let stale: boolean;
  if (live) {
    // 连接有效：采用显式运行状态。持久层若为 offline（尚未重新上报），视为 online。
    state = input.storedState === null || input.storedState === "offline" ? "online" : input.storedState;
    stale = false;
  } else {
    state = "offline";
    stale = disconnected || input.storedState !== null || session !== null;
    // 心跳超时（会话仍标 connected 但时间过久）也属陈旧。
    if (heartbeatTimedOut && connection === "connected") stale = true;
  }

  return base(input, {
    state,
    connection,
    heartbeatTimedOut,
    heartbeatStale,
    stale,
    disconnected,
    lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
    connectedAt: session?.connectedAt ?? null,
    disconnectedAt: session?.disconnectedAt ?? null,
    hostType: session?.hostType ?? null,
    updatedAt: session?.updatedAt ?? null,
  });
}

function base(
  input: { projectId: string; memberId: string; kind: "agent" | "human"; displayName: string },
  fields: Omit<EffectiveStatus, "projectId" | "memberId" | "kind" | "displayName">,
): EffectiveStatus {
  return {
    projectId: input.projectId,
    memberId: input.memberId,
    kind: input.kind,
    displayName: input.displayName,
    ...fields,
  };
}

/**
 * 按项目列出所有成员的有效状态。人的「在线」需要 WebUI 在线集合，由调用方注入。
 * 这里只覆盖 agent 会话推导与人成员的持久状态（offline/online）。
 */
export async function deriveProjectStatuses(
  repos: RepositorySet,
  projectId: string,
  ctx: DeriveContext,
): Promise<EffectiveStatus[]> {
  const sessions = (await (repos.mcpSessions.listByProject(projectId)));
  return (await Promise.all((await (repos.members.listByProject(projectId))).map(async (member) => {
    const session = latestSessionForMember(sessions, member.id);
    const stored = (await (repos.statuses.get(projectId, member.id)));
    return deriveEffectiveStatus({
      projectId,
      memberId: member.id,
      kind: member.kind,
      displayName: member.displayName,
      storedState: stored?.state ?? null,
      session,
      heartbeat: ctx.heartbeat,
      now: ctx.now,
    });
  })));
}

/** 取某成员最近一次会话（按 connectedAt 倒序，其次 updatedAt）。 */
function latestSessionForMember(sessions: readonly McpSession[], memberId: string): McpSession | null {
  let best: McpSession | null = null;
  for (const session of sessions) {
    if (session.memberId !== memberId) continue;
    if (best === null || sessionSortKey(session) > sessionSortKey(best)) best = session;
  }
  return best;
}

function sessionSortKey(session: McpSession): string {
  return `${session.connectedAt}|${session.updatedAt}|${session.id}`;
}

/**
 * 状态看板快照（T4 WebUI 消费）。
 *
 * 与 {@link deriveProjectStatuses} 相同的推导，但额外把「人」的在线与 WebUI presence 合并：
 * 人没有 MCP 会话，其在线来自 WebSocket 连接（`humanOnlineMemberIds`）；不在线的成员显示 offline。
 * 人**永远**不会出现 waiting/working。只读，不写库。
 */
export async function buildStatusBoard(
  repos: RepositorySet,
  projectId: string,
  ctx: DeriveContext & { readonly humanOnlineMemberIds?: readonly string[] },
): Promise<EffectiveStatus[]> {
  const humanOnline = new Set(ctx.humanOnlineMemberIds ?? []);
  const sessions = (await (repos.mcpSessions.listByProject(projectId)));
  return (await Promise.all((await (repos.members.listByProject(projectId))).map(async (member) => {
    const session = latestSessionForMember(sessions, member.id);
    const stored = (await (repos.statuses.get(projectId, member.id)));
    if (member.kind === "human") {
      const online = humanOnline.has(member.id);
      return deriveEffectiveStatus({
        projectId,
        memberId: member.id,
        kind: "human",
        displayName: member.displayName,
        storedState: online ? "online" : "offline",
        session: null,
        heartbeat: ctx.heartbeat,
        now: ctx.now,
      });
    }
    return deriveEffectiveStatus({
      projectId,
      memberId: member.id,
      kind: member.kind,
      displayName: member.displayName,
      storedState: stored?.state ?? null,
      session,
      heartbeat: ctx.heartbeat,
      now: ctx.now,
    });
  })));
}

/**
 * T3（#16）消息路由域服务：mention 解析、@all 快照、唤醒规则与可见性。
 *
 * 这是一个**纯函数**模块，不依赖数据库、网络或运行时对象，便于以单元测试覆盖
 * （NFR-08）。上层的 MCP core / HTTP API / WebSocket 都调用同一套规则，避免三处各写
 * 一份、产生分歧。
 *
 * 规则来源：子 spec #2 §5.3 / §6.3（CHAT-01..04、CHAT-08）、决策 D3 #6、D5 #8、
 * `CONTEXT.md`「自己参与的消息（阶段 1）」。卡片内规则：
 *
 * - **mention 解析**：正文里的 `@xxx` 用稳定成员 ID 或显示名解析到成员 ID；`@all` /
 *   `@全体` 展开为「发送时群组在线参与者快照」。
 * - **唤醒（wake）**：
 *   - 普通 agent：只被「被 @」（含 @all 快照中的自己）唤醒；
 *   - 顶层 manager：被项目内其他成员的**任何**群组消息唤醒；
 *   - 人：不涉及唤醒（人通过 WebUI 实时观察，不是 MCP 等待方）；
 *   - **发送者永不唤醒自己**（含 manager）。
 * - **可见（visible / 可投递）**：
 *   - 普通 agent：自己发送 + 被 @（D3）；
 *   - manager：项目内群组的所有消息；
 *   - 人：全部（阶段 1 单群组）。
 * - **隔离**：只考虑传入 roster（该群组的参与者）。roster 之外的成员绝不会出现
 *   在可见/唤醒/广播结果里——未参与群组者不会通过聊天/历史/投递泄漏。
 *
 * 注意（与 T7 的边界）：本票只做「发送者排除」这一条防自触发。每群组连续自动回复
 * 上限、每成员每分钟限流由 T7 负责，不在本模块。这里也没有「忙碌打断」（T6）。
 */

/** @all 的别名（大小写不敏感）。中文「全体」是常见写法。 */
export const ALL_MENTION_ALIASES = ["all", "全体", "所有人", "大家"] as const;

/** 路由所需的成员视图（来自该群组参与者）。 */
export interface RoutingMember {
  readonly id: string;
  readonly role: "manager" | "normal";
  readonly kind: "agent" | "human";
  /** 是否为「在线」参与者（用于 @all 快照；人视为在线）。 */
  readonly online: boolean;
  /** 显示名（可选；用于按显示名解析 @mention）。 */
  readonly displayName?: string;
}

/** 路由所需的成员显示名（用于按显示名解析 @mention）。 */
export interface RoutingMemberName {
  readonly id: string;
  readonly displayName: string;
}

/** 待路由的消息（只含路由相关字段）。 */
export interface RoutingMessage {
  readonly senderMemberId: string;
  /** 已解析为稳定成员 ID 的显式 @（不含 @all）。 */
  readonly mentionIds: readonly string[];
  /** 是否使用了 @all / @全体。 */
  readonly mentionsAll: boolean;
}

/** 路由结果。 */
export interface RoutingPlan {
  /** @all 展开出的接收者（在线参与者快照，不含发送者）。 */
  readonly allRecipients: readonly string[];
  /** 应被唤醒（会触发其 MCP 等待方返回）的成员 ID。 */
  readonly wake: readonly string[];
  /** 可见/可投递该消息的成员 ID（发送者 + 被 @ + manager + 人）。 */
  readonly visible: readonly string[];
}

export interface ParseMentionsResult {
  /** 解析出的稳定成员 ID（去重、按出现顺序）。 */
  readonly mentionIds: readonly string[];
  /** 是否包含 @all / @全体。 */
  readonly all: boolean;
  /** 无法解析的 @ 名称（不静默丢弃；上层可据此告警或忽略）。 */
  readonly unknownNames: readonly string[];
}

/** `@` 之后允许的名称字符：字母数字、下划线、连字符、CJK。遇到空白/标点停止。 */
const MENTION_TOKEN = /@([\p{L}\p{N}_\-]+)/gu;

/**
 * 解析正文中的 mention。
 *
 * - 命中顺序：先按**稳定成员 ID**精确匹配（消除同名歧义），否则按**显示名**
 *   （大小写不敏感）匹配；一个名字命中多名成员时全部保留（不静默择一）。
 * - `@all` / `@全体` / 其它别名 → 置 `all=true`，不逐人展开（展开需要在线快照，
 *   由 {@link resolveWakeAndVisibility} 依据 roster 完成）。
 * - 无法解析的名称记入 `unknownNames`，由调用方决定如何处理（不静默丢弃）。
 */
export function parseMentions(
  text: string,
  roster: readonly (RoutingMember & Partial<RoutingMemberName>)[],
  names?: readonly RoutingMemberName[],
): ParseMentionsResult {
  const byId = new Set(roster.map((m) => m.id));
  const nameSource: readonly RoutingMemberName[] =
    names ??
    roster
      .filter((m): m is RoutingMember & RoutingMemberName => typeof (m as RoutingMemberName).displayName === "string")
      .map((m) => ({ id: m.id, displayName: m.displayName }));

  const mentionIds: string[] = [];
  const unknownNames: string[] = [];
  const seen = new Set<string>();
  let all = false;

  for (const match of text.matchAll(MENTION_TOKEN)) {
    const raw = match[1]!;
    const lower = raw.toLowerCase();
    if ((ALL_MENTION_ALIASES as readonly string[]).includes(lower) || (ALL_MENTION_ALIASES as readonly string[]).includes(raw)) {
      all = true;
      continue;
    }
    // 1) 稳定 ID 精确匹配（优先，消除显示名歧义）。
    if (byId.has(raw)) {
      if (!seen.has(raw)) {
        seen.add(raw);
        mentionIds.push(raw);
      }
      continue;
    }
    // 2) 显示名匹配（大小写不敏感；同名可命中多人）。
    const hits = nameSource.filter((m) => m.displayName.toLowerCase() === lower);
    if (hits.length > 0) {
      for (const hit of hits) {
        if (!seen.has(hit.id)) {
          seen.add(hit.id);
          mentionIds.push(hit.id);
        }
      }
      continue;
    }
    unknownNames.push(raw);
  }

  return { mentionIds, all, unknownNames };
}

/**
 * 计算一条消息的路由计划（@all 快照、唤醒集合、可见集合）。
 *
 * 纯函数：只读取传入的 roster，不产生副作用。roster 即「该群组参与者」，因此未参与
 * 群组者天然不会出现在结果中（隔离）。
 */
export function resolveWakeAndVisibility(
  message: RoutingMessage,
  roster: readonly RoutingMember[],
): RoutingPlan {
  const byId = new Map(roster.map((m) => [m.id, m]));
  const sender = byId.get(message.senderMemberId);

  // @all：发送时在线参与者快照（排除发送者本人）。
  const allRecipients: string[] = [];
  if (message.mentionsAll) {
    for (const m of roster) {
      if (!m.online) continue;
      if (m.id === message.senderMemberId) continue;
      allRecipients.push(m.id);
    }
  }

  // 显式 @ 只保留 roster 内成员（外部/非法 ID 忽略，不泄漏）。
  const explicitMentioned = message.mentionIds.filter((id) => byId.has(id) && id !== message.senderMemberId);

  const wakeSet = new Set<string>();
  const visibleSet = new Set<string>();

  for (const m of roster) {
    // 发送者：始终能看见自己发的消息；但永不唤醒自己。
    if (m.id === message.senderMemberId) {
      visibleSet.add(m.id);
      continue;
    }

    const mentioned = explicitMentioned.includes(m.id) || allRecipients.includes(m.id);

    switch (m.kind) {
      case "human":
        // 人可见全部群组消息；无唤醒概念。
        visibleSet.add(m.id);
        break;
      case "agent":
        if (m.role === "manager") {
          // manager：可见项目内群组所有消息；被其他成员的**任何**消息唤醒。
          visibleSet.add(m.id);
          wakeSet.add(m.id);
        } else {
          // 普通 agent：只被 @ 唤醒；可见 = 自己发送（已在上面处理）+ 被 @。
          if (mentioned) {
            visibleSet.add(m.id);
            wakeSet.add(m.id);
          }
        }
        break;
    }
  }

  // 发送者明确排除在唤醒之外（含 manager）。
  wakeSet.delete(message.senderMemberId);
  // 不存在的 sender 也不应产生任何可见/唤醒（防御）。
  void sender;

  return {
    allRecipients,
    wake: [...wakeSet].sort(),
    visible: [...visibleSet].sort(),
  };
}

/** 某成员是否可见某条已持久化的消息（用于历史/投递过滤）。 */
export function isMessageVisibleTo(message: RoutingMessage, roster: readonly RoutingMember[], memberId: string): boolean {
  const plan = resolveWakeAndVisibility(message, roster);
  return plan.visible.includes(memberId);
}

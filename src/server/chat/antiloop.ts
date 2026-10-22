/**
 * T7（#20）防自触发 / 防环 domain service：连续自动回复上限 + 每成员唤醒速率限流。
 *
 * 这是**纯逻辑 + 注入时钟**的模块，不依赖数据库、网络或运行时对象，便于以单元测试覆盖
 * （NFR-08）、用模拟时钟验证窗口语义。上层的 MCP core（`send_message` / `wait_for_messages`）
 * 在本模块给出的「允许唤醒成员」上再叠加 T3 的 wake 集合（发送者排除）。
 *
 * 规则来源：子 spec #2 §5.3 / §6.3（CHAT-07、NFR-10）、验收 AC-CORE-09；决策 D5 #8；
 * ticket #20。与 T3 的边界：T3 负责「发送者排除」与 mention/可见性；本模块只做
 *
 * 1. **每群组连续自动回复上限**（CHAT-07）。定义：同一群组内，从「人类消息或显式外部触发」
 *    之后开始，由 agent 发起、其间没有人类消息或显式恢复的**连续 agent 消息**计数。达到
 *    `maxConsecutiveAutoReplies`（默认 6）后，**停止自动唤醒其他 agent**，直到人发消息或
 *    显式恢复（`resetGroup`）后才重新计数。发送者本来就不会被自己唤醒（T3），达到上限后
 *    其余 agent 也不再被自动唤醒。触发上限的 agent 消息仍然持久化，不被丢弃。
 *
 * 2. **每成员唤醒速率限流**（NFR-10）。按成员累计，**跨群组**；滚动 1 分钟窗口内最多被唤醒
 *    `maxWakesPerMinutePerMember`（默认 20）次。manager 的跨群唤醒计入**同一成员**的限流，
 *    不做单独配额（D5）。超限的唤醒不丢弃：消息已持久化（`message_deliveries` 为 pending），
 *    等待窗口滚动、移出窗口后由后续 `wait_for_messages` 补投。
 *
 * 计数为**进程内内存计数**，进程重启后重置（阶段 1 的取舍，见
 * `docs/t7-antiloop-and-rate-limit.md`）。
 */

/** 默认阈值（D5 #8）。可在 AppConfig 中覆盖。 */
export const DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES = 6;
export const DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER = 20;
/** 每成员唤醒速率窗口：滚动 1 分钟。 */
export const WAKE_RATE_WINDOW_MS = 60_000;

export interface AntiLoopConfig {
  /** 每群组连续自动回复上限（默认 6）。 */
  readonly maxConsecutiveAutoReplies: number;
  /** 每成员滚动窗口内最多被唤醒次数（默认 20）。 */
  readonly maxWakesPerMinutePerMember: number;
  /** 窗口长度（毫秒），默认 60000。可注入以便测试。 */
  readonly wakeRateWindowMs: number;
}

export const DEFAULT_ANTI_LOOP_CONFIG: AntiLoopConfig = {
  maxConsecutiveAutoReplies: DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES,
  maxWakesPerMinutePerMember: DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER,
  wakeRateWindowMs: WAKE_RATE_WINDOW_MS,
};

/** 一次唤醒被拒绝的原因（用于日志/事件，不含消息正文）。 */
export type WakeSuppressionReason = "consecutive_limit" | "rate_limited";

/** 对一个候选唤醒的决定。 */
export interface WakeDecision {
  /** 本次允许唤醒的成员 ID（已按 T3 wake 集合过滤并按成员逐个限流）。 */
  readonly allowed: readonly string[];
  /** 被抑制的唤醒：成员 → 原因。 */
  readonly suppressed: ReadonlyMap<string, WakeSuppressionReason>;
  /** 群组当前连续自动回复计数（本消息计入后）。 */
  readonly consecutiveAutoReplies: number;
  /** 本消息是否因达到连续上限而**停止**自动唤醒（本消息是「触碰上限的那条」或已超限）。 */
  readonly consecutiveCapReached: boolean;
}

export interface AntiLoopOptions {
  readonly config?: Partial<AntiLoopConfig>;
  /** 时钟，默认返回当前时间毫秒；测试注入模拟时钟。 */
  readonly now?: () => number;
}

export interface AntiLoop {
  readonly config: AntiLoopConfig;
  /**
   * 登记一条消息并决定其可唤醒的成员。
   *
   * - `senderKind === "human"`：人类消息 → 重置本群组连续计数为 0（本消息不消耗计数），
   *   之后所有候选唤醒都通过成员限流检查。
   * - `senderKind === "agent"`：agent 消息 → 本群组连续计数 +1。若计数器 > 上限，则停止
   *   所有自动唤醒（`consecutive_limit`）；否则对候选唤醒逐个应用成员速率限流。
   *
   * 候选唤醒 `candidateWake` 通常是 T3 `resolveWakeAndVisibility().wake`（已排除发送者）。
   * 返回的 `allowed` 是最终允许唤醒的成员；不在其中的成员对应消息仍需持久化
   * （调用方负责，见 MCP core）。
   */
  registerMessage(input: {
    readonly groupId: string;
    readonly senderKind: "agent" | "human";
    readonly candidateWake: readonly string[];
  }): WakeDecision;

  /** 显式恢复某群组的连续自动回复计数（人为/管理动作）。 */
  resetGroup(groupId: string): void;

  /** 当前某群组的连续自动回复计数（观测/测试）。 */
  consecutiveCount(groupId: string): number;

  /** 某成员在当前滚动窗口内已被计数（并允许）的唤醒次数（观测/测试）。 */
  wakeCountInWindow(memberId: string): number;
}

/**
 * 创建防环/限流器。计数全部在内存中，进程重启重置。
 */
export function createAntiLoop(options: AntiLoopOptions = {}): AntiLoop {
  const config: AntiLoopConfig = {
    maxConsecutiveAutoReplies:
      options.config?.maxConsecutiveAutoReplies ?? DEFAULT_ANTI_LOOP_CONFIG.maxConsecutiveAutoReplies,
    maxWakesPerMinutePerMember:
      options.config?.maxWakesPerMinutePerMember ?? DEFAULT_ANTI_LOOP_CONFIG.maxWakesPerMinutePerMember,
    wakeRateWindowMs: options.config?.wakeRateWindowMs ?? DEFAULT_ANTI_LOOP_CONFIG.wakeRateWindowMs,
  };
  if (!Number.isInteger(config.maxConsecutiveAutoReplies) || config.maxConsecutiveAutoReplies <= 0) {
    throw new RangeError(`maxConsecutiveAutoReplies 必须是正整数，收到：${config.maxConsecutiveAutoReplies}`);
  }
  if (!Number.isInteger(config.maxWakesPerMinutePerMember) || config.maxWakesPerMinutePerMember <= 0) {
    throw new RangeError(
      `maxWakesPerMinutePerMember 必须是正整数，收到：${config.maxWakesPerMinutePerMember}`,
    );
  }
  if (!Number.isInteger(config.wakeRateWindowMs) || config.wakeRateWindowMs <= 0) {
    throw new RangeError(`wakeRateWindowMs 必须是正整数，收到：${config.wakeRateWindowMs}`);
  }

  const now = options.now ?? (() => Date.now());

  /** 群组 → 连续自动回复计数。 */
  const consecutive = new Map<string, number>();
  /** 成员 → 本窗口内已允许的唤醒时间戳（毫秒，升序）。 */
  const wakeTimestamps = new Map<string, number[]>();

  /** 读取某成员在「当前时刻」回看的滚动窗口内的唤醒时间戳（惰性裁剪过期项）。 */
  function activeTimestamps(memberId: string, at: number): number[] {
    const list = wakeTimestamps.get(memberId);
    if (!list) return [];
    const cutoff = at - config.wakeRateWindowMs;
    // 丢弃窗口外的旧记录（时间戳升序，从头切）。
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i += 1;
    if (i > 0) {
      list.splice(0, i);
      wakeTimestamps.set(memberId, list);
    }
    return list;
  }

  return {
    config,

    registerMessage(input) {
      const at = now();
      const groupId = input.groupId;

      // 人类消息 / 显式触发：重置本群组连续计数（本消息本身不消耗连续自动回复额度）。
      if (input.senderKind === "human") {
        consecutive.set(groupId, 0);
      } else {
        consecutive.set(groupId, (consecutive.get(groupId) ?? 0) + 1);
      }
      const count = consecutive.get(groupId) ?? 0;
      const capReached = count > config.maxConsecutiveAutoReplies;

      const suppressed = new Map<string, WakeSuppressionReason>();
      const allowed: string[] = [];

      for (const memberId of input.candidateWake) {
        if (capReached) {
          suppressed.set(memberId, "consecutive_limit");
          continue;
        }
        const active = activeTimestamps(memberId, at);
        if (active.length >= config.maxWakesPerMinutePerMember) {
          suppressed.set(memberId, "rate_limited");
          continue;
        }
        // 记录一次允许的唤醒（跨群组累计到同一成员）。
        active.push(at);
        wakeTimestamps.set(memberId, active);
        allowed.push(memberId);
      }

      return {
        allowed,
        suppressed,
        consecutiveAutoReplies: count,
        consecutiveCapReached: capReached,
      };
    },

    resetGroup(groupId) {
      consecutive.set(groupId, 0);
    },

    consecutiveCount(groupId) {
      return consecutive.get(groupId) ?? 0;
    },

    wakeCountInWindow(memberId) {
      return activeTimestamps(memberId, now()).length;
    },
  };
}

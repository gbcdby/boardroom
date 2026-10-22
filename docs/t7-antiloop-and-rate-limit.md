# T7：防自触发 / 防环（连续回复上限 + 每成员唤醒限流）

状态：已实现（T7 #20）
日期：2026-10-22
来源：子 spec #2 §5.3 / §6.3（CHAT-07、NFR-10）、验收 AC-CORE-09；决策 D5 #8（#8）；
ticket #20；工具契约 `docs/mcp-tool-contract.md` §2.2（`RATE_LIMITED`）、§3.3（`send_message`）。

本文记录阶段 1 的防自触发 / 防环机制：**每群组连续自动回复上限**、**每成员跨群唤醒速率限流**
（manager 计入同一成员）、超限消息的持久化/延迟投递、恢复条件与阈值配置。**本票不做**重连
积压（T5 #18）、忙碌打断（T6 #19）、通用工作流引擎、跨项目全局配额、任务通知（阶段 3）。

## 1. 与 T3 的边界

T3（#16）已落地「发送者排除」这一条最基本的防自触发：`resolveWakeAndVisibility` 的 wake 集合
**永不含发送者**（含 manager、含人，CHAT-04 / AC-CORE-09）。T7 在其上补齐另外两层：

1. **每群组连续自动回复上限**（CHAT-07）；
2. **每成员滚动窗口唤醒速率限流**（NFR-10）。

T3 的 mention/可见性规则**不改**。T7 只在 T3 给出的 `wake` 集合上再做一次门控；可见性
（`visible`）与历史读取不受限流影响——超限消息对可见成员依然可见、可 `read_history`、可被
`wait_for_messages` 补投。

## 2. 落点与 seam

- **域服务** `src/server/chat/antiloop.ts`（`createAntiLoop`）：纯逻辑 + 注入时钟，无 DB/网络。
  单元测试覆盖（NFR-08）用模拟时钟验证窗口与计数语义。
- **MCP 集成** `src/server/mcp/core.ts`：
  - `send_message` 在持久化消息、建立 `pending` 投递之后，调用 `antiLoop.registerMessage`
    计算本消息「允许唤醒」的成员；只用它派生出的放行集合去 `resolveGroup`（唤醒面）。
  - 进程级**共享**限流器 `getSharedAntiLoop`：所有 core（HTTP 每会话一个、stdio 单例）共享
    同一实例，保证「每群组连续回复」与「每成员每分钟唤醒」跨会话累计，否则互相限不住。
  - `resolveGroup(groupId, wakeGate?)` 增加门控：不在放行集合内的成员本次不被唤醒，其消息
    仍保持 `pending`，等窗口滚动/恢复后由后续 `wait_for_messages` 补投。
- **HTTP API** `src/server/api.ts`：人发送消息（`sender.kind === "human"`）时调用
  `resetGroupConsecutiveCount(groupId)` 重置该群组连续计数（恢复条件之一）。
- **配置** `src/server/config.ts`：新增 `antiLoop.maxConsecutiveAutoReplies` /
  `antiLoop.maxWakesPerMinutePerMember`，可由配置文件或环境变量覆盖（见 §6）。

## 3. 每群组连续自动回复上限（CHAT-07）

**定义**：同一群组内，由 agent 发起、其间没有人类消息或显式恢复的连续 agent 消息计数。

- 每条 **agent** 消息使该群组计数 +1；每条 **人类**消息或显式 `resetGroup` 使计数归零。
- 计数 `<= maxConsecutiveAutoReplies`（默认 6）时，正常按 T3 `wake` 集合唤醒。
- 计数 **> 上限**（即第 7 条 agent 连续消息起）时，**停止自动唤醒其他 agent**：本次消息的
  所有候选唤醒都被抑制（原因 `consecutive_limit`）。
- 触发上限的 agent 消息**仍然持久化**并为可见成员建 `pending` 投递，不丢弃。
- 恢复：人发消息 或 显式恢复（`resetGroup`）后计数归零，重新允许自动唤醒。
- 发送者本来就不会被自己唤醒（T3）；上限语义针对「被唤醒的其他 agent」。

> 例：manager 连续发 7 条 @普通成员的消息。前 6 条各唤醒一次；第 7 条不再唤醒，但第 7 条
> 仍写入历史，成员可 `read_history` 看到，或在其后的人消息重置计数后由后续 `wait` 补投。

## 4. 每成员跨群唤醒速率限流（NFR-10）

- 按**成员**累计、**跨群组**：同一成员无论被哪个群组唤醒，都计到同一份记录。
- 滚动窗口 1 分钟（`WAKE_RATE_WINDOW_MS = 60000`，可注入）：窗口内已被允许的唤醒次数
  `<= maxWakesPerMinutePerMember`（默认 20）时放行；超出的候选唤醒被抑制（原因 `rate_limited`）。
- **manager 的跨群唤醒计入同一成员**（D5）：manager 在多个群组被摘要/转发唤醒时，不设单独
  配额，统一记在 manager 这个成员名下。
- 逐成员判定：一次发送中可能一部分候选成员被限流、其余放行。原因优先级：连续上限（群组级）
  先于速率限流（成员级）。
- 超限消息**不丢弃**：仍持久化、保有 `pending` 投递。窗口滚动（`now - ts > window`）后旧记录
  被惰性裁剪，后续 `wait_for_messages` 能补投。

## 5. 超限持久化 / 延迟投递与恢复条件（与 T5 契约一致）

T7 复用 T3 已有的持久化结构（`messages` + `message_deliveries`，`pending/delivered/acked`），
不新增表、不改迁移：

- **限流只限制「唤醒」这一动作**，不影响消息落库与 `pending` 投递记录。
- 被抑制的成员：其投递记录保持 `pending`（未被 `markDelivered`）。`wait_for_messages` 的积压
  路径（T5 语义）会跳过 `acked`、返回所有可见且非 acked 的消息，因此被抑制的消息在窗口滚动
  或计数恢复后**自然补投**，无需 T7 单独实现补投队列。
- 恢复条件：① 人类消息（重置连续计数）；② 显式恢复 `resetGroup`；③ 速率窗口滚动过期。
- 与 T5（#18）的接口约定：T7 **不**实现重连积压策略；它只保证「不因限流而删除/标记投递完成」。
  T5 的持久化补投直接受益于这里「超限仍 `pending`」的约定。

## 6. 阈值配置与默认值（D5）

| 配置项 | 环境变量 | 默认 | 含义 |
| --- | --- | --- | --- |
| `antiLoop.maxConsecutiveAutoReplies` | `AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES` | `6` | 每群组连续自动回复上限 |
| `antiLoop.maxWakesPerMinutePerMember` | `AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER` | `20` | 每成员滚动 1 分钟唤醒上限（跨群） |

优先级：环境变量 > 配置文件 > 默认值。示例见 `config.example.json`。窗口长度固定 60s，
仅在单元测试中通过注入覆盖（`wakeRateWindowMs`），生产不暴露配置。

## 7. 计数是否跨重启

**计数为进程内内存计数，进程重启后重置**（阶段 1 取舍，ticket #20「风险/待定」）。共享限流器
`getSharedAntiLoop` 保存在模块级变量中；`resetSharedAntiLoopForTests` 仅测试用。生产重启 =
计数清零；这不破坏正确性（防环是尽力而为的上限），但重启后前 6 条连续回复、前 20 次唤醒额度
会重新可用。若需跨重启持久化，可后续把计数迁移到 SQLite（不在本票）。

## 8. 可观察性

- `wake_suppressed`（`warn`）：一条消息存在被抑制的唤醒时记录。字段仅含结构化元信息：
  `groupId`、`messageId`、`consecutiveAutoReplies`、`consecutiveLimit`、`consecutiveCapReached`、
  `rateLimited`（成员 ID 列表）、`consecutiveLimited`（成员 ID 列表）、`maxWakesPerMinutePerMember`。
  **不含消息正文**（`logger` 对 `content/body/text` 等键名整体脱敏，NFR-05）。
- `message_sent`（`info`）保留原有 `wake`/`visible` 字段。

## 9. 测试

- `tests/antiloop.test.ts`（11 例，单元、模拟时钟）：默认阈值、6 次上限、人类重置、显式 reset、
  按群组隔离、20 次/分钟、跨群累计、窗口滚动放行、逐成员部分限流、配置覆盖、连续上限优先。
- `tests/antiloop-mcp.test.ts`（5 例，MCP 工具边界 + 真实 SQLite）：发送者不被自己唤醒（且限流不
  误伤正常唤醒）、6 次上限后停止唤醒且人类消息重置、20 次限流 + 超限不丢 + 窗口重置补投、配置
  覆盖、日志可诊断且不含正文。
- `tests/config.test.ts`：默认值与覆盖、非正整数报错。

## 10. 未决 / 风险

- 阈值可能误伤正常协作；通过配置与 T8 真实场景校准，默认规则不改（ticket「风险」）。
- T7 未实现：重连积压策略（T5）、打断（T6）、跨项目全局配额、任务通知（阶段 3）。
- HTTP 人的消息重置连续计数依赖 `api.ts` 显式调用 `resetGroupConsecutiveCount`；绕过 HTTP 直接
  写库（如测试）需自行调用该函数或走真实发送路径，否则连续计数不会重置。

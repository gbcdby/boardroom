# T6（#19）尽力打断与安全点投递

状态：已实现（阶段 1 / 纵向切片）
日期：2026-10-22
前置：`docs/t2-mcp-join-and-online.md`（T2 mcp_sessions / 投递）、`docs/t3-chat-and-routing.md`（可见性与唤醒）、
`docs/t4-status-and-heartbeat.md`（waiting/working）、`docs/mcp-tool-contract.md`（工具契约）。
来源：子 spec #2；决策票 **D6 #10**（宿主能力实测）；本票 #19；并行票 T5 #18、T7 #20。
覆盖：CHAT-05、AGENT-05；AC-CORE-07、AC-CORE-10（宿主能力记录部分）。

> **一句话结论**：服务端**不能打断正在执行的工具调用**，也不声称能唤醒空闲宿主。
> 可靠语义只有两条：**服务端不阻塞**、**消息不丢**。agent 忙碌时消息进入持久化队列，
> 在**下一安全点**（agent 再次进入 `wait_for_messages`）投递。打断是「尽力而为」，结果
> 必须**可观察**并记录为 `accepted / rejected / unsupported`，其中 `unsupported` 是 Claude Code
> 的实测结论。

## 1. 能力边界（D6 #10 实测结论，不得写成更强的承诺）

| 能力 | 是否可以承诺 | 依据 |
| --- | --- | --- |
| 服务端结束 agent 的**等待循环**并让其在同一轮内拿到消息 | ✅ 可以 | D6 §2：`wait_for_messages` 由工具自身挂起并 resolve（实测 453ms 后返回） |
| agent 忙碌时消息**进入队列、不丢** | ✅ 可以 | 本票 + T5：持久化 `message_deliveries`，至少一次 |
| **打断正在执行的工具调用** | ❌ **不可以** | D6 §4：注入新消息 12s 后 `wait_for_messages` 仍 pending；注入消息排在后面 |
| 唤醒已结束当前轮、不在等待中的**空闲宿主** | ❌ 不可以 | D6 §2 边界、§7 |
| Codex 的等待/打断行为 | ⚠️ **未验证** | D6 §6：Codex 配额耗尽（到 2026-10-27），无法发起带工具调用的轮次 |

因此本票把 AC-CORE-07 的「尽力打断」如实表述为：**服务端不阻塞 + 消息不丢 + 下一安全点投递**。
CHAT-05（不丢消息）由持久化队列保证；「打断」不作为可靠能力对外承诺。

## 2. 三个可观察的打断结果（契约）

打断通过领域核心 `McpCore.attemptInterrupt(sessionId, params?)` 表达（`src/server/mcp/core.ts`），
返回 `InterruptAttempt`：

```jsonc
{
  "ok": true,
  "result": "accepted" | "rejected" | "unsupported", // 三种可观察结果
  "targetStatus": "working",                          // 与 T4 一致：不把处理中的轮次伪装成 waiting
  "target": "running" | "idle",                       // 是否处于可打断的忙碌轮次
  "attemptId": "01...",                               // 稳定 ID，用于追溯
  "attemptedAt": "2026-10-22T...",
  "hostType": "claude-code",
  "reason": "……",                                    // 人类可读依据（写清“不能打断在途工具”）
  "queuedMessageCount": 2                             // 仍有未投递消息（≠ 模型已处理）
}
```

| `result` | 含义 | 服务端后续行为 |
| --- | --- | --- |
| `accepted` | 宿主/适配层**回报**已接受打断（尽力而为，**不**保证在途工具已停止） | 记录；消息仍保留在队列直到下一安全点 |
| `rejected` | 宿主明确拒绝打断当前轮 | 记录；消息保留在队列 |
| `unsupported` | 宿主不支持打断，或能力未知（Claude Code 实测；Codex 未验证） | 记录；消息保留在队列 |

**注入方式**：`attemptInterrupt` 的 `hostCapability` 参数允许宿主适配层/测试**显式申报**能力；
缺省按 `hostType` 的默认能力（`DEFAULT_HOST_INTERRUPT_CAPABILITY`：`claude-code`/`codex-cli`/`other`
均为 `unsupported`）。**不**根据终端画面或猜测推断打断成功——只有显式申报 `accepted` 才记为 accepted。

### 2.1 为什么没有新增 MCP 工具 `attempt_interrupt`

本票硬约束：**不改 MCP 工具名/错误码**。断言的语义在领域核心层实现并为测试固定：
- MCP 工具清单仍是固定的 7 个（`tests/interrupt-mcp.test.ts` 断言不变）；
- 宿主侧可通过既有 `wait_for_messages`（下一安全点）拿到积压消息，这是可靠路径；
- 若将来需要把打断尝试暴露给宿主，可另开票在 `docs/mcp-tool-contract.md` 增补工具——本票不擅自新增。

## 3. 安全点投递（唯一可靠语义）

1. agent 在等待循环中 → 成员状态 `waiting`（T4）；
2. 有人发消息 → 写 `messages` + 为**可见**成员建 `message_deliveries(status='pending')`（T3）；
3. 若等待中的成员属于唤醒集合 → `wait_for_messages` 立即返回 `status:"message"`，同时把成员状态置 `working`（T4：wait 返回 → working）；
4. 若 agent 正忙（正在处理上一批，处于 `working`）→ 新消息**只入队**（`pending`），**不推进游标、不丢弃**；
5. agent 处理完、**下一次进入 `wait_for_messages`**（下一安全点）→ 先拉 `pending` 积压并返回。

**「已投递到队列」≠「模型已处理」**：`delivered`/`pending` 只表示服务端已写入待投递；只有 agent
显式 `acknowledge_message` 才记为 `acked`。状态（waiting/working）与投递（pending/delivered/acked）
分开建模，互不替代（D1）。

## 4. 与相邻票的兼容

- **T4（状态）**：`attemptInterrupt` 不改等待循环映射；打断后 `targetStatus` 恒为 `working`，
  不伪造 `waiting`。idle（不在忙碌轮次）时只记录尝试，不改状态。
- **T5（重连积压 / 至少一次）**：本票复用 `message_deliveries` 的 `pending/delivered/acked` 语义。
  acked 前同一消息**可重复读取**（至少一次），靠 `acknowledge_message` 去重。T5 合并后
  `repositories.deliveries.listPending` 的语义为 `status <> 'acked'`（含已投递未确认的 `delivered`），
  因此 `InterruptAttempt.queuedMessageCount` = **未 ack 的消息数**（不只是 `pending`），这与
  「至少一次、不丢消息」一致，T6 采用该语义。T6 不新增重连策略，
  也不改 T5 的补投游标（`afterCursor`）。测试固定了「未 ack 可重读、ack 后不再投递」。
- **T7（防环/限流）**：本票不实现限流阈值；`attemptInterrupt` 与普通工具一样刷新会话心跳，
  限流由 T7 在工具层统一处理。

## 5. 失败路径与重试

| 场景 | 行为 |
| --- | --- |
| 宿主不响应（unsupported） | `result:"unsupported"`；消息留在队列；下一安全点投递 |
| 打断被拒绝（rejected） | `result:"rejected"`；消息留在队列；下一安全点投递 |
| 投递超时 | `wait_for_messages` 以 `status:"timeout"` 正常返回，`pending` 不清除；下次等待再投 |
| 重复投递 | `message_deliveries` 按 `(message_id, member_id)` 唯一，重复写入幂等，不重复计数 |
| 重复确认 | `acknowledge_message` 幂等（`alreadyAcknowledged:true`） |

「服务端不阻塞」：发起打断尝试/发送消息都不会因为 agent 忙碌而阻塞；写入即返回，投递异步于 agent 的下一安全点。

## 6. 宿主能力记录（与 D6 #10 / T8 对齐）

来源：D6（#10）resolution 与本仓库 `.agent-output/impl-phase1/host-evidence/` 的实测记录；本票**未重跑**宿主，
直接引用既有证据（见 §6.3）。

### 6.1 Claude Code —— 实测 **不支持打断**

- 版本：**Claude Code 2.1.233**；MCP SDK 1.32.1；Node v24.14.0；macOS；测试时间 2026-10-21（UTC）。
- 命令/条件：agent 正挂起于 `wait_for_messages(timeout_seconds=120)` 时，用
  `--input-format stream-json` 注入新用户消息。
- 结果：**12 秒后该工具调用仍在挂起**；注入的消息排在后面，直到等待自然返回才被处理
  （D6 `logs/claude-interrupt-clean.jsonl`）。
- **结论：`unsupported`。** 不能打断在途工具调用，也不声称唤醒空闲宿主。

### 6.2 Codex CLI —— **未验证**（配额阻塞）

- 版本：**Codex CLI 0.163.0**。
- 条件：`codex exec --skip-git-repo-check "..."` 实测返回
  `You've hit your usage limit ... try again at Oct 27th, 2026 3:21 PM`（并伴随 `426 Upgrade Required`），
  无法发起带工具调用的轮次。
- 已证实的只有 MCP 传输层（握手、`tools/list`）与 `codex mcp add/list` 配置登记。
- **结论：等待/打断/重连语义均为「未验证」，按 `unsupported` 处理（不写成事实）。**
  需在配额恢复后另开票补测。

### 6.3 证据索引

- D6 #10 resolution（本节结论的一手来源）。
- `.agent-output/impl-phase1/host-evidence/2026-10-22-t2-dual-host-smoke.md`（Claude Code 连接/工具调用；
  Codex 配额阻塞记录）。
- `.agent-output/impl-phase1/host-evidence/2026-10-22-host-recheck.md`（复核：Claude 可用、Codex 配额阻塞）。

## 7. 实现落点

- 领域核心：`src/server/mcp/core.ts`
  - 新增类型 `InterruptResult` / `HostInterruptCapability` / `InterruptParams` / `InterruptAttempt`、
    `DEFAULT_HOST_INTERRUPT_CAPABILITY`；
  - 新增方法 `McpCore.attemptInterrupt`（记录日志事件 `interrupt_attempted`）；
  - 复用既有 `waitForMessages`（安全点投递）、`deliveries`（pending/delivered/acked）。
- 测试：
  - `tests/interrupt-core.test.ts`：accepted / rejected / unsupported 三路径、安全点投递不丢消息、
    T4 状态一致、T5 至少一次兼容、重复投递幂等。
  - `tests/interrupt-mcp.test.ts`：MCP 边界工具清单固定（不新增工具名）、忙碌失败路径下一安全点送达。
- **未新增数据库迁移**：直接复用 `message_deliveries` 与 `member_statuses`；未改已应用迁移。

## 8. 未做 / 风险

- 不做重连积压（T5）、防环/限流（T7）、任务通知（阶段 3）。
- 不做 wrapper / 宿主 hook / 未经验证的强制中断机制；**不保证**唤醒完全空闲宿主。
- Codex 打断行为未验证（配额），不得写成承诺。
- `accepted` 只代表宿主适配层**回报**接受，不等于在途工具已停止；服务端不改变投递语义以依赖它。

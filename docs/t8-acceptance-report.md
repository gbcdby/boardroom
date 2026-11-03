# T8 双宿主端到端验收报告（阶段 1 收口）

状态：已实现（T8 #21，阶段 1 收口验收）；**2026-11-03 完成真实双宿主补验，AC-CORE-01..11 全部通过**
日期：2026-10-22（初版）；2026-11-03（真实宿主补验）
来源：子 spec #2 §8（AC-CORE-01..11）、§8.1（测试 seam）、§6.10（CONFIG-03）；决策 D6 #10；ticket #21。
关联文档：`docs/mcp-tool-contract.md`、`docs/t1..t7-*.md`、`docs/getting-started-mcp.md`。
证据：`scripts/e2e-phase1.mjs`（可复现脚本）、`.agent-output/impl-phase1/host-evidence/2026-10-22-t8-e2e-and-hosts.md`；真实宿主补验：`.agent-output/real-host-retest/README.md`。

> 本报告逐项复核 AC-CORE-01..11，给出「通过 / 部分 / 阻塞」结论与证据。
> 结论只来自实测；未验证能力不写成通过。**2026-11-03 更新：** Codex 配额恢复后，用真实 Claude Code 2.1.233 + 真实 Codex CLI 0.166.0 补验了此前阻塞的 AC-CORE-02/10/11（详见 §6），结论转为通过。

## 1. 验收结论总表

| 验收项 | 结论 | 证据（一句话） |
| --- | --- | --- |
| AC-CORE-01 | ✅ 通过 | E2E：`/api/health` 200 + status=ok、`/` 返回 HTML、SQLite 初始化、`/mcp` 端点存在；F1 测试 |
| AC-CORE-02 | ✅ 通过（2026-11-03 真实补验） | 真实 Claude Code 2.1.233 + 真实 Codex CLI 0.166.0 均通过 MCP 真实 `join`（hostType 各自正确），无 wrapper |
| AC-CORE-03 | ✅ 通过 | E2E：人建项目/群组/成员 → 指定 A 为 manager → A、B 经 MCP 入群显示 connected/online |
| AC-CORE-04 | ✅ 通过 | E2E：普通 agent 仅被 @；manager 被任何成员消息唤醒；发送者不被唤醒；T3 单测 |
| AC-CORE-05 | ✅ 通过 | E2E：@ 单人、@all 均按定义工作；@all 只覆盖在线参与者快照（离线不补投，T5 测试）；**2026-11-03 真实双宿主 @all 补验通过** |
| AC-CORE-06 | ✅ 通过 | E2E：等待中 waiting、收到消息处理时 working；T4 fake-timers 测试 |
| AC-CORE-07 | ✅ 通过 | E2E：忙碌期消息入队、不丢、下一安全点（再次 wait）送达；ack 后不重投；**「打断」=尽力而为，不承诺打断在途工具** |
| AC-CORE-08 | ✅ 通过 | E2E：重启后消息保留、断线 agent 重连复用身份并立即补投积压；未重连者显示离线（不臆造在线）；**2026-11-03 真实宿主重启后重连补积压补验通过** |
| AC-CORE-09 | ✅ 通过 | E2E：manager 不唤醒自己；连续 agent 消息前 6 条实时唤醒、第 7 条不再实时唤醒但持久化；T7 单测 |
| AC-CORE-10 | ✅ 通过（2026-11-03 真实补验） | 真实 Claude Code + 真实 Codex CLI 均实测「等待中由服务端投递结束等待、同一轮继续」（活跃唤醒 `drainedBacklog:false`）；重连补投；「不能打断在途工具、不能唤醒空闲宿主」边界记录在案 |
| AC-CORE-11 | ✅ 通过（2026-11-03 真实补验） | **真实双宿主**：人 + Claude Code + Codex CLI 完成双向 @（人→agent、agent→agent 两向）、@all、waiting/working、服务端重启后断线重连；非模拟第二 agent |

## 2. 逐项说明

### AC-CORE-01 服务端 localhost 启动、SQLite 初始化、WebUI 可访问 —— ✅ 通过
- E2E `scripts/e2e-phase1.mjs`：`GET /api/health` → 200 且 `status:"ok"`；`GET /` → 200 HTML；`data/agent-studio.db` 已建；`server.mcpUrl` 以 `/mcp` 结尾。
- 仅绑定 `127.0.0.1`（CONFIG-02），F1 测试覆盖。证据：E2E 输出 + `tests/http.test.ts`、`tests/database.test.ts`。

### AC-CORE-02 两个宿主通过 MCP 入群；无 wrapper；不要求自动入群 —— ✅ 通过（2026-11-03 真实补验）
- **Claude Code 2.1.233（真实）**：以 Streamable HTTP（`/mcp`）接入，真实 `join` 返回 `{"ok":true,"memberId":"01M6GVF53W..."}`，服务端状态 `connected/online`。证据 `.agent-output/real-host-retest/claude-join.out`。
- **Codex CLI 0.166.0（真实）**：配额已恢复（2026-10-27 后），以 Streamable HTTP 接入后真实 `join` 返回 `{"ok":true,"memberId":"01M6GVGCQ5..."}`。证据 `.agent-output/real-host-retest/codex-join.out`。
- **无 wrapper、不要求自动入群**：接入即通过标准 MCP 工具 `join` 主动入群，无任何包装进程或自动入群机制（见 `docs/getting-started-mcp.md`）。
- **结论**：两个真实宿主均完成 MCP 真实入群，通过。

### AC-CORE-03 人创建项目/群组，两个 agent 加入同一群组并在线 —— ✅ 通过
- E2E：`POST /api/projects` → `POST /api/projects/:id/members`（人）→ `POST .../groups`（含人参与者）→ 两个 MCP 客户端 `join` → `PUT .../manager` 指定 A → `GET .../member-statuses` 显示 A、B 均 `connection:connected, state:online`。
- 证据：E2E 步骤 + `tests/projects-api.test.ts`。

### AC-CORE-04 普通 agent 只被 @ 唤醒；manager 被其他成员消息唤醒 —— ✅ 通过
- E2E：人 @B 单人，B 收到、manager A（未点名）也收到；发送者（人）不被唤醒。
- 路由规则由 `src/server/chat/routing.ts` 唯一实现；单测 `tests/chat-routing.test.ts`、集成 `tests/chat-routing-mcp.test.ts`。

### AC-CORE-05 @ 单人/多人/全体按定义工作；@all 只覆盖当前群组在线参与者 —— ✅ 通过
- E2E：@单人、@all 均正确路由；`@all` 展开为**发送时在线参与者快照**（离线成员不在快照内，T5 有专测 `@all 离线边界`）。
- @多人（多 @ 只唤醒被点名者）由 `tests/chat-routing.test.ts` 覆盖。

### AC-CORE-06 agent 等待显示 waiting、处理时显示 working —— ✅ 通过
- E2E：B 进入 `wait_for_messages` 后 `GET .../members/:id/status` → `state:waiting`；收到消息返回后 → `state:working`。
- 状态推导 `src/server/status.ts`；fake-timers 测试 `tests/status-domain.test.ts`、`tests/status-heartbeat-http.test.ts`、`tests/status-loop.test.ts`。**不靠终端画面推断**（STATUS-02）。

### AC-CORE-07 忙碌 agent 尽力打断；无法打断时消息不丢、下一安全点送达 —— ✅ 通过（按 D6 语义）
- E2E：B 处于 working 时人再发 @B，消息入队（pending）不丢；B 下一次进入 `wait_for_messages`（下一安全点）拿到；ack 后不再重投。
- **能力边界（D6 #10 实测，写入文档）**：服务端**不能打断正在执行的工具调用**；「打断」只表述为「服务端不阻塞 + 消息不丢 + 下一安全点投递」，`attemptInterrupt` 结果可观察（`accepted/rejected/unsupported`，Claude Code 实测 `unsupported`）。见 `docs/t6-interrupt-and-safe-point.md`、`tests/interrupt-*.test.ts`。

### AC-CORE-08 服务端重启后消息保留；重连 agent 收到允许范围内积压 —— ✅ 通过
- E2E：重启同一数据目录后 `GET .../messages` 仍含重启前消息；B 用新会话 `join` 复用同一 `memberId`，`wait_for_messages` 立即返回 `drainedBacklog:true`；未重连的 A 显示 `disconnected/offline`（不臆造在线）。
- 证据：`tests/t5-restart-recovery.test.ts`、`tests/t5-restart-http.test.ts`、E2E。

### AC-CORE-09 连续对话不会无限自触发；manager 不唤醒自己 —— ✅ 通过
- E2E：manager A 发消息，A 的 `wait_for_messages` 超时（未收到自己的消息）；连续 7 条 agent @B，前 6 条实时唤醒 B、第 7 条不再实时唤醒（`consecutive_limit`）但持久化、`read_history` 可读（不丢）。
- 证据：`tests/antiloop.test.ts`（11 例）、`tests/antiloop-mcp.test.ts`（5 例）。
- 注：防环计数为**进程内内存**，重启后重置（T7 取舍，见 `docs/t7-antiloop-and-rate-limit.md` §7）。

### AC-CORE-10 记录并文档化两个宿主的实际等待/打断能力 —— ✅ 通过（2026-11-03 真实补验）
- **Claude Code 2.1.233（真实补验）**：`wait_for_messages` 挂起后，人经 HTTP 发消息能**实时结束等待、同一轮继续**：实测发消息前服务端 `state=waiting`(13s)，返回 `status:"message"`、`drainedBacklog:false`，收到精确 messageId（`.agent-output/real-host-retest/claude-livewake2.out`）。
- **Codex CLI 0.166.0（真实补验）**：同样支持「等待→服务端投递结束等待→同一轮继续」：发消息前 `state=waiting`(52s)，返回 `drainedBacklog:false`（`.agent-output/real-host-retest/codex-livewake2.out`、`codex-state-seq.log`）。
- **重连**：两者均不保留跨会话 MCP 状态，恢复靠服务端持久化 + 重连后主动 join/拉取；真实串接验证见 §6（重启后 `drainedBacklog:true`）。
- **边界（D6 实测，未变）**：两个宿主**都不能打断在途工具调用**；不能唤醒已结束当前轮、未等待的空闲宿主；`attemptInterrupt` 对二者为 `unsupported`。见 `docs/getting-started-mcp.md` §4「已知限制」。
- 完整记录见 `.agent-output/real-host-retest/README.md`。

### AC-CORE-11 人 + 2 agent 双向 @、等待、断线重连完整走通 —— ✅ 通过（2026-11-03 真实补验）
- **真实双宿主已跑通**（非模拟）：人 + 真实 Claude Code + 真实 Codex CLI 在 Streamable HTTP 上完成：
  - 人→@Claude、人→@Codex（等待中活唤醒，均 `drainedBacklog:false`）；
  - agent↔agent 双向 @（Claude→Codex、Codex→Claude，均真实宿主，`drainedBacklog:false`）；
  - @all 双宿主同时等待、`wakeMemberIds` 覆盖两者、同一 messageId；
  - waiting/working 状态；服务端重启后消息保留，真实 Claude / Codex 重连首等待 `drainedBacklog:true` 补投积压。
- 证据与复现：`.agent-output/real-host-retest/README.md`（`claude-*`/`codex-*`/`ab-*`/`ba2-*`/`all-*`/`reconnect-*`）。
- 复现脚本：`node scripts/e2e-phase1.mjs`（回归）+ `.agent-output/real-host-retest/launch-server.mjs`（真实宿主编排）。

## 3. 集成本次发现并修复的缺陷

**缺陷**：人经 HTTP 发送的消息**不能实时唤醒**正在 MCP `wait_for_messages` 等待中的 agent（只能等超时/下次 wait 才补投），不满足 NFR-03「定向消息 2s 内送达」。

**根因**：MCP `send_message` 在 core 内部跨 core 唤醒挂起等待；人的消息走 HTTP API，不经过任何 core 的 `send_message`，故挂起等待不被结算。

**修复（最小、不改 MCP 工具契约）**：
- `src/server/mcp/transport.ts`：新增 `McpSessionsHandler.wakeGroup(groupId, wakeGate)`，遍历所有 HTTP 会话的 core。
- `src/server/mcp/core.ts`：`McpCore` 接口暴露 `resolveGroup`（内部实现改名 `resolveGroupInternal`）。
- `src/server/server.ts`：`broadcastMessage` 在 WS 广播后调用 `mcpHandler.wakeGroup(...)`。
- 回归测试：`tests/t8-human-wake.test.ts`（人的单发 / @all 实时唤醒等待中的 agent）。

**理由**：这是集成验收暴露的真实缺陷（人作为发起方在阶段 1 是核心路径），最小修复在传输层补一次跨 core 唤醒，不扩大范围、不改业务规则。

## 4. 例外与后续计划

1. **Codex 真实宿主验证（AC-CORE-02/10/11 的 Codex 部分）—— 已关闭（2026-11-03）**：Codex CLI 0.166.0 配额已恢复，已用真实 Codex 走通 join / 双向 @ / 等待活唤醒 / 重启后重连补积压（见 §6）。原阻塞不再有效。
2. **Claude Code 真实 LLM 轮次回放 —— 已完成（2026-11-03）**：用 `claude -p` 真实驱动完成 join→wait→send→reconnect 全链路（见 §6）。
3. **打断能力**：阶段 1 不承诺打断在途工具（D6），文档已固化；真实 Claude/Codex 均 `unsupported`；若未来宿主/适配层提供真正的会话控制，另开票评估。
4. **防环计数跨重启**：进程内内存计数，重启重置（T7 取舍）；如需跨重启持久化，后续票迁移到 SQLite。

## 5. 不做 / 边界（重申）

- 阶段 2–5 功能、生产打包、公网/认证/多用户；wrapper、自动入群、强制唤醒空闲宿主。
- 不改阶段 1 子 spec 的需求/验收标准；未用 mock 冒充真实双宿主验收。自动化回归 `scripts/e2e-phase1.mjs` 用 MCP SDK 客户端（同 wire 协议）承担第二个 agent；真实双宿主另见 §6（Claude Code + Codex CLI 真机）。

## 6. 真实双宿主补验（2026-11-03）

原报告因 Codex 配额阻塞（至 2026-10-27）把 AC-CORE-02/10/11 标为「部分」。配额恢复后做了真机补验：

- 环境：Claude Code 2.1.233、Codex CLI 0.166.0、Node v24.14.0、本仓库 `startServer`（127.0.0.1:4399，Streamable HTTP `/mcp`）。
- 传输：两个宿主都用 **Streamable HTTP** 接入，故人类 HTTP 消息可实时结束宿主挂起的 `wait_for_messages`。

| 补验项 | 宿主 | 结果 |
| --- | --- | --- |
| 真实 join | Claude Code / Codex CLI | 均 `{"ok":true,...}`，服务端 `connected/online` |
| 等待中活唤醒 | Claude Code / Codex CLI | 发消息前 `state=waiting`，返回 `drainedBacklog:false` 且 messageId 精确匹配 |
| agent↔agent 双向 @ | Claude↔Codex | 两向均真实宿主、`drainedBacklog:false` |
| @all | 两宿主同时等待 | `wakeMemberIds` 覆盖两者、同一 messageId、均 `drainedBacklog:false` |
| 重启后重连补积压 | Claude Code / Codex CLI | 重启前排队消息，重连首等待 `drainedBacklog:true`、messageId 一致 |

- 附加（超出原始 spec 宿主范围）：DeepSeek Harness（dsh 0.2.1-rc.5）以 `hostType=other` 也完成真实 join + 等待活唤醒（`drainedBacklog:false`）；记录于证据索引，作为可行性参考，不变更阶段 1 spec 的宿主范围。
- 证据索引与复现：`.agent-output/real-host-retest/README.md`。

# T8 双宿主端到端验收报告（阶段 1 收口）

状态：已实现（T8 #21，阶段 1 收口验收）
日期：2026-10-22
来源：子 spec #2 §8（AC-CORE-01..11）、§8.1（测试 seam）、§6.10（CONFIG-03）；决策 D6 #10；ticket #21。
关联文档：`docs/mcp-tool-contract.md`、`docs/t1..t7-*.md`、`docs/getting-started-mcp.md`。
证据：`scripts/e2e-phase1.mjs`（可复现脚本）、`.agent-output/impl-phase1/host-evidence/2026-10-22-t8-e2e-and-hosts.md`。

> 本报告逐项复核 AC-CORE-01..11，给出「通过 / 部分 / 阻塞」结论与证据。
> 结论只来自实测；**未验证能力（尤其是 Codex 侧等待/打断/重连）一律标注为「阻塞 / 未验证」，不写成通过**。

## 1. 验收结论总表

| 验收项 | 结论 | 证据（一句话） |
| --- | --- | --- |
| AC-CORE-01 | ✅ 通过 | E2E：`/api/health` 200 + status=ok、`/` 返回 HTML、SQLite 初始化、`/mcp` 端点存在；F1 测试 |
| AC-CORE-02 | ⚠️ **部分（Codex 阻塞）** | Claude Code 侧 `✔ Connected` + MCP join/工具真实可用；**Codex 侧仅配置登记，工具轮次被配额阻塞未验证** |
| AC-CORE-03 | ✅ 通过 | E2E：人建项目/群组/成员 → 指定 A 为 manager → A、B 经 MCP 入群显示 connected/online |
| AC-CORE-04 | ✅ 通过 | E2E：普通 agent 仅被 @；manager 被任何成员消息唤醒；发送者不被唤醒；T3 单测 |
| AC-CORE-05 | ✅ 通过 | E2E：@ 单人、@all 均按定义工作；@all 只覆盖在线参与者快照（离线不补投，T5 测试） |
| AC-CORE-06 | ✅ 通过 | E2E：等待中 waiting、收到消息处理时 working；T4 fake-timers 测试 |
| AC-CORE-07 | ✅ 通过 | E2E：忙碌期消息入队、不丢、下一安全点（再次 wait）送达；ack 后不重投；**「打断」=尽力而为，不承诺打断在途工具** |
| AC-CORE-08 | ✅ 通过 | E2E：重启后消息保留、断线 agent 重连复用身份并立即补投积压；未重连者显示离线（不臆造在线） |
| AC-CORE-09 | ✅ 通过 | E2E：manager 不唤醒自己；连续 agent 消息前 6 条实时唤醒、第 7 条不再实时唤醒但持久化；T7 单测 |
| AC-CORE-10 | ⚠️ **部分（Codex 阻塞）** | Claude Code 实测记录完整（不能打断在途工具、不唤醒空闲宿主、重连靠服务端持久化）；**Codex 未验证** |
| AC-CORE-11 | ⚠️ **部分（Codex 阻塞）** | 「人 + 2 agent」双向 @/等待/断线重连在 **Claude Code 真实宿主连接层 + MCP SDK 模拟第二 agent** 范围内完整跑通；**非双真实宿主** |

## 2. 逐项说明

### AC-CORE-01 服务端 localhost 启动、SQLite 初始化、WebUI 可访问 —— ✅ 通过
- E2E `scripts/e2e-phase1.mjs`：`GET /api/health` → 200 且 `status:"ok"`；`GET /` → 200 HTML；`data/agent-studio.db` 已建；`server.mcpUrl` 以 `/mcp` 结尾。
- 仅绑定 `127.0.0.1`（CONFIG-02），F1 测试覆盖。证据：E2E 输出 + `tests/http.test.ts`、`tests/database.test.ts`。

### AC-CORE-02 两个宿主通过 MCP 入群；无 wrapper；不要求自动入群 —— ⚠️ 部分（Codex 阻塞）
- **Claude Code 2.1.233**：`claude mcp add ... -- node src/server/mcp/stdio.ts` → `claude mcp list` 显示 `✔ Connected`；MCP 入群、心跳、状态上报在本机 stdio 上真实调用成功并落 SQLite（见 T2 证据与本票 §2）。
- **Codex CLI 0.163.0**：`codex mcp add/list` 配置登记可用（Status=enabled），但 `codex exec` 命中 `You've hit your usage limit ... Oct 27th, 2026`，**带工具调用的轮次无法发起**，因此 Codex 的「入群工具调用」未验证。
- **无 wrapper、不要求自动入群**：接入即通过标准 MCP 工具 `join` 主动入群，无任何包装进程或自动入群机制（见 `docs/getting-started-mcp.md`）。
- **结论**：连接与协议层通过；**真实 Codex 入群属于验收阻塞例外**，不写成通过。

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

### AC-CORE-10 记录并文档化两个宿主的实际等待/打断能力 —— ⚠️ 部分（Codex 阻塞）
- **Claude Code 2.1.233（实测，D6 + 本票复核）**：
  - 能结束等待循环：`wait_for_messages` 由工具自身挂起，有消息时**同一轮内**返回（实测 453ms 返回）；
  - **不能打断在途工具调用**：等待中注入新消息，12s 后工具仍 pending（D6 `logs/claude-interrupt-clean.jsonl`）；
  - **不唤醒已结束当前轮、未等待的空闲宿主**；
  - 重连：宿主不保留跨会话 MCP 状态，恢复完全靠**服务端持久化 + 重连后主动 join/拉取**（本票 E2E 验证）。
- **Codex CLI 0.163.0**：配额阻塞（`You've hit your usage limit ... Oct 27th, 2026`），**等待/打断/重连均未验证**，按 `unsupported` 处理，不写成已支持。
- 完整记录见 `docs/getting-started-mcp.md` §4「已知限制」与 `.agent-output/impl-phase1/host-evidence/2026-10-22-t8-e2e-and-hosts.md`。

### AC-CORE-11 人 + 2 agent 双向 @、等待、断线重连完整走通 —— ⚠️ 部分（Codex 阻塞）
- **真实范围内已跑通**：E2E 在「Claude Code 真实宿主连接层 + MCP SDK 客户端（与 Claude Code 同 wire 协议）模拟第二 agent」下完整跑通：入群在线 → 人→@A、A→@B、B→@all 双向 @ → waiting/working → 断线重连补积压 → 无无限自触发。
- **验收阻塞例外**：**未取得「Claude Code 真实 LLM 轮次 + Codex 真实 LLM 轮次」的双真实宿主回放**——Claude Code 本次 LLM 轮次受模型后端 429 限流，Codex 受配额阻塞。这部分明确标注为阻塞，**不伪造「双真实宿主」通过**。
- 复现：`node scripts/e2e-phase1.mjs`。

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

1. **Codex 真实宿主验证（AC-CORE-02/10/11 的 Codex 部分）**：Codex CLI 0.163.0 配额到 2026-10-27。恢复后需补测：
   - `codex exec` 能发起轮次后，用真实 Codex 走通 join/双向 @/等待/打断/重连；建议**新开一张票挂在本票（#21）之后**，或挂 #15/#19。
   - 已知风险：Codex 的等待/打断/重连语义至今**未实测**，接入文档按「未验证/按 unsupported 处理」表述。
2. **Claude Code 真实 LLM 轮次回放**：本次因模型后端 429 未取得，需在配额恢复后用 `claude -p` 驱动完整 join→wait→send 回放。当前以 MCP 连接层 `✔ Connected` + MCP SDK 客户端（同 wire 协议）作为证据。
3. **打断能力**：阶段 1 不承诺打断在途工具（D6），文档已固化；若未来宿主/适配层提供真正的会话控制，另开票评估。
4. **防环计数跨重启**：进程内内存计数，重启重置（T7 取舍）；如需跨重启持久化，后续票迁移到 SQLite。

## 5. 不做 / 边界（重申）

- 阶段 2–5 功能、生产打包、公网/认证/多用户；wrapper、自动入群、强制唤醒空闲宿主。
- 不改阶段 1 子 spec 的需求/验收标准；未用 mock 冒充真实双宿主验收（第二 agent 由同 wire 协议的 MCP SDK 客户端驱动，已如实标注）。

# T4：等待/工作状态与状态看板

状态：已实现（T4 #17）
日期：2026-10-22
来源：子 spec #2 §6.4、§6.5、§8.2；决策 D1 #4、D4 #7；ticket #17；覆盖 AGENT-04、STATUS-01/02/03、AC-CORE-06。
前置：`docs/t2-mcp-join-and-online.md`（T2 已落地 mcp_sessions / member_statuses / report_status / heartbeat）。

本文说明阶段 1 的「状态」实现：**状态模型**（连接层 vs 成员运行层）、**心跳/超时判定**、
**waiting/working 的驱动方式**、**人与 agent 的区别**、**WebUI 状态看板与实时更新**、**陈旧/断线/重连恢复**与**已知边界**。

## 1. 状态模型（D1 / STATUS-04：分开建模）

两层始终分表存放、互不写入：

| 层 | 落点 | 取值 | 谁驱动 |
| --- | --- | --- | --- |
| **连接状态**（全局 MCP 会话） | `mcp_sessions`（`state` + `last_heartbeat_at`） | `connected` / `disconnected` | join 建立；heartbeat / 任意工具调用刷新；关闭/回收/重启置 disconnected |
| **成员运行状态**（项目成员） | `member_statuses`（按 `(project_id, member_id)`） | `online` / `offline` / `waiting` / `working` | join → online；`report_status` 或等待循环 → waiting/working；断开 → offline |

**任务状态不属于阶段 1**（STATUS-04 边界）：`member_statuses.state` 的 CHECK 只允许上述四个值；
`tests/status-domain.test.ts` 有断言守护「无 done 等任务状态」。

## 2. 有效状态推导（`src/server/status.ts`）

WebUI 展示的「有效状态」由 `deriveEffectiveStatus` / `buildStatusBoard` 以**只读**方式推导，
不写库、不把连接存活写回 `member_statuses`、**不根据终端画面推断**（STATUS-02）。

判定规则（时间通过 `now` 注入，便于 fake timers 测试）：

1. **心跳超时**：`age = now - lastHeartbeatAt`（无心跳则用 `connectedAt`）。
   - `age > timeoutMs`（D4 默认 30s）→ `heartbeatTimedOut = true`；
   - `age > 2*timeoutMs` → `heartbeatStale = true`（更强的超时，展示为「心跳变慢」渐变）。
2. **agent 连接存活** = 存在 `connected` 会话且 `!heartbeatTimedOut`。
   - 存活 → 采用 `member_statuses.state`；若持久层为 `offline`（重连后尚未重新上报），按 `online` 处理。
   - 不存活 → `offline`；并置 `stale`（曾上报过 waiting/working 或存在历史会话）/ `disconnected`（会话被标 disconnected）。
3. **人（kind=human）**：只可能 `online` / `offline`；**绝不**出现 waiting/working（人不执行 agent 轮次）。
   人的「在线」来自 WebUI WebSocket 连接（见 §4 的 presence），不看 MCP 会话。

`GET /api/projects/:id/members/:m/status` 与 `GET /api/projects/:id/member-statuses`
返回的视图在此基础上补充字段：`stale`、`disconnected`、`heartbeatTimedOut`、`heartbeatStale`、`lastHeartbeatAt`。

## 3. 心跳与超时（D4）

- 心跳 interval **10s** / timeout **30s**，可配置（`AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` /
  `AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS` 或配置文件 `heartbeat.{intervalMs,timeoutMs}`；`timeoutMs` 必须 > `intervalMs`）。
- agent 侧：`join` 建立连接会话并写 `last_heartbeat_at`；任意工具调用（含 `wait_for_messages`、`send_message`、
  新增的 `heartbeat`）都会刷新会话心跳。心跳超时后状态端点显示**离线 + 陈旧（心跳超时）**；
  刷新心跳后**恢复在线**（见 `tests/status-heartbeat-http.test.ts` 的 fake timers 实测）。
- WebUI / 服务端推送：状态看板由服务端按 `intervalMs` 周期广播；前端本地也会据 `lastHeartbeatAt`
  做平滑判定，避免只在两次推送之间冻结。

## 4. waiting/working 的驱动（AGENT-04 / AC-CORE-06）

waiting/working **只由显式信号驱动**，两类：

1. 宿主主动 `report_status`（T2 已有的契约，形状不变）；
2. **等待循环 ↔ 状态对应**（T4 新增，`src/server/mcp/core.ts`）：
   - 进入 `wait_for_messages`（尚无积压、真正挂起）→ 写 `waiting`；
   - 等待返回（拿到消息 / 超时 / 取消）→ 写 `working`（已离开等待、进入处理）；
   - 立即拿到积压（`drainedBacklog`）时不在等待中停留，直接 `working`。

  这一映射只在**运行时**发生；宿主不处于等待循环时不产生 waiting，符合「不承诺唤醒空闲宿主」的边界。
  若要更精确的「处理完成回到 waiting」，宿主可在处理结束后再 `report_status("waiting")`。

`tests/status-loop.test.ts`（真实 MCP 客户端）验证：进入等待 → `waiting`；拿到消息返回 → `working`。

**人 vs agent**：`report_status` 只对 agent 会话有效（需先 join）；人没有 MCP 会话、不进入等待循环，
所以人永远不会被写成 waiting/working。`buildStatusBoard` 对人强制只输出 online/offline。

## 5. WebUI 状态看板与实时更新（STATUS-01/03、WEBUI-02）

- 页面：`src/web/src/views/StatusBoardView.vue`（路由 `/status`，导航「状态看板」），
  展示组件 `src/web/src/components/StatusBoard.vue`。
- 实时：`src/web/src/composables/useStatusBoardSocket.ts` 连接 `/ws`：
  - 连接后发送 `{type:"presence", projectId, memberId}` 声明「人在该项目在线」；
  - 接收服务端 `status_update`（`scope:"project"` 的项目快照）并更新本地状态表；
  - 断线自动重连（2s），重连后重新声明 presence。
- 展示：人只显示「在线/离线」；agent 显示「在线/离线/等待中/工作中」，并附「断线 / 心跳超时 / 陈旧 / 心跳变慢」提示。
- 服务端：`src/server/ws.ts` 新增 `status_update` 事件与 `presence` 处理，`broadcastProjectStatus`
  **只发给对该项目可见的客户端**（声明了其它项目的客户端不发），避免跨项目泄漏；`server.broadcastStatus(projectId)`
  供测试/事件驱动立即推送，另有按 `intervalMs` 的周期广播。

## 6. 失败路径与恢复（STATUS-03）

| 场景 | 表现 | 恢复 |
| --- | --- | --- |
| 状态信号丢失（未上报） | 连接有效时显示 `online`（不回退为 waiting/working） | 宿主下次 `report_status` / 进入等待循环即可 |
| 心跳超时（> timeoutMs） | `offline` + `heartbeatTimedOut` / `stale` | 宿主刷新心跳（任意工具调用/`heartbeat`）→ 回 `online`/原运行态 |
| 会话断开（关闭/DELETE/回收/重启） | `offline` + `disconnected` + `stale` | agent 重连 `join` → 回 `online`；重启后遗留会话在启动时统一置断开、状态置 offline（不臆造在线） |
| 人断开 WebSocket | presence 清除 → 该人显示 `offline` | 重连 `/ws` 并重新声明 presence → 回 `online` |

实测（`node .agent-output/t4-smoke.mjs`，短心跳 interval 500ms / timeout 1500ms，真实服务）：
wait 循环中 `waiting` → 返回后 `working` → 停心跳约 2s `offline/stale/timedOut` → `heartbeat` 后回到 `working`。
实测（`node .agent-output/t4-smoke2.mjs`）：`terminateSession()` 后 `connection=disconnected, state=offline,
stale=true, disconnected=true`。这两个脚本是冒烟证据，非自动化用例；确定性判定由 fake timers 测试覆盖。

## 7. 测试覆盖与边界（诚实说明）

自动化测试（`npm test`，`node --test`）：

- `tests/status-domain.test.ts`：有效状态推导（waiting/working、人只 online/offline、断线、陈旧渐变）；
  **fake timers 30s 超时**（恰好 30s 仍在线、30s+1ms 超时 → offline+stale）。
- `tests/status-heartbeat-http.test.ts`：真实 HTTP 状态端点 + 可注入时钟，**fake timers 实测**心跳 20s 在线、
  30s+1ms→offline+stale、恢复心跳→回在线；人端点不出现 waiting/working。
- `tests/status-loop.test.ts`：真实 MCP 客户端进入等待→waiting、返回→working；`(project,member)` 隔离。
- `tests/status-ws.test.ts`：WS `status_update` 快照携带 agent 状态、人只 online/offline；**跨项目隔离**；
  WebSocket 断线清除 presence；实时快照经 WS 推送。
- `tests/webui-e2e.test.ts`：构建产物包含状态看板文案（状态看板/等待中/工作中/在线/离线/断线/心跳超时）
  与 `status_update`/`presence` 事件名；`/status` 深链可加载（沿用既有「构建→提供→断言」模式）。

**WebUI E2E 覆盖边界**：未引入浏览器驱动（Playwright 等），因此不覆盖真实 DOM 渲染、点击事件绑定与
CSS 呈现；覆盖的是「产物已打包关键 UI + 前端使用的同一组 HTTP/WS 契约走通」。状态推导逻辑本身由服务端单测覆盖，
前端只做薄展示，故该边界可接受。

## 8. 未做 / 边界

- 群聊/@/可见性/路由（T3）；断线积压与消息补发（T5）；忙碌打断（T6）；防环（T7）；双宿主端到端验收（T8）。
- 任务状态（阶段 3）、组织权限/下级 manager（阶段 2）。
- **不靠终端画面推断运行状态**（STATUS-02 硬约束）：waiting/working 仅来自显式信号。
- WebSocket/SSE 更新 ≠ 消息进入模型上下文 ≠ 唤醒空闲宿主（见 `AGENTS.md` 技术边界）；
  本票只让 WebUI 实时看到状态，不承诺唤醒效应。
- 不改已应用迁移（T4 未新增迁移）；不改 MCP 工具名/错误码（`report_status` 形状不变）。

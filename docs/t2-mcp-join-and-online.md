# T2：双宿主 MCP 入群与在线

状态：已实现（T2 #15）
日期：2026-10-22
来源：子 spec #2 §6.1、§8.2；决策 D1 #4、D2 #5、D4 #7、D6 #10；ticket #15；工具契约 `docs/mcp-tool-contract.md`。
真实宿主证据：`.agent-output/impl-phase1/host-evidence/2026-10-22-t2-dual-host-smoke.md`。

本文说明阶段 1 的 MCP 入群/在线实现：如何从 F3 的内存 `McpStore` 迁移到 F2 持久化、身份唯一性与
连接/成员状态的建模、宿主接入配置示例（Claude Code / Codex CLI），以及已知限制（含 Codex 阻塞）。

## 1. 从内存 store 到 F2 持久化

F3（#13）用进程内 `McpStore`（Map）承载成员/消息/状态，仅够契约与 fake client 测试。T2 把
`src/server/mcp/core.ts` 的核心全部改为读写 F2 的 SQLite repository（`createRepositories(db)`）：

| 领域对象 | F3 内存 | T2 持久化落点 |
| --- | --- | --- |
| 全局身份 | `SessionBinding` 内随机 `agentId` | `agents` 表（`(display_name, host_type)` 唯一） |
| 项目成员关系 | `SessionBinding` 内随机 `memberId` | `members` 表（`kind='agent'`，绑定 `agent_id`） |
| 群组参与 | 无 | `group_participants`（入群即加入目标群组） |
| 连接状态（全局） | 无独立模型 | `mcp_sessions` 表（connected/disconnected + 心跳） |
| 成员运行状态 | `runStatus` Map | `member_statuses` 表（online/offline/waiting/working） |
| 消息 | `messagesByGroup` Map | `messages` 表（群组内 seq 单调） |
| 投递/确认 | `deliveredCursor`/`acknowledged` | `message_deliveries` 表（至少一次 + 去重） |

工具**对外形状（工具名、入参、出参、错误码）保持不变**（见 `docs/mcp-tool-contract.md`），只新增
`heartbeat` 工具。挂起中的 `wait_for_messages` 仍是**运行时对象**（不落库）；进程内跨会话唤醒靠
一份共享的挂起等待注册表，跨进程/重启由 agent 重连后重新等待（积压补投扩展留 T5）。

数据库迁移以**追加**方式加入 `version: 2 mcp_sessions_and_agent_identity`（不改已应用 migration）：
- `ux_agents_identity`：`agents(display_name, host_type)` 唯一 —— 同一 agent 全局唯一；
- `mcp_sessions` 表：会话 id、绑定的 agent/项目/群组/成员、state、连接/心跳/断开时间；
  `ux_mcp_sessions_active`：同 `(agent_id, project_id, group_id)` 至多一个活跃（connected）会话。

## 2. 身份唯一性、连接状态与成员状态（建模）

### 2.1 全局身份（Agent）唯一
入群时按 `(displayName, hostType)` 查找已有 `Agent`，命中则复用其 `agentId`，否则创建。
唯一索引兜底：相同显示名 + 宿主类型**始终映射到同一个全局身份**，不会静默创建重复身份。
- 同名不同宿主 = 不同身份（例：`Alice/claude-code` ≠ `Alice/codex-cli`）。
- 同一会话重复 `join` 但声明不同身份 → `CONFLICT`（不静默改身份）。

### 2.2 项目成员关系（Member）
同一 agent 在同一项目只有一条 `Member`（`(project_id, agent_id)` 唯一）。入群时若已存在则复用；
若显示名变化则更新。阶段 1 一个项目只有一个岗位（D2）：入群**不覆盖**已由 WebUI 指定的 `role=manager`。

### 2.3 连接状态 vs 成员运行状态（D1 / STATUS-02，分开建模）
- **连接状态（全局 MCP 会话层）**：`mcp_sessions.state ∈ {connected, disconnected}` + `last_heartbeat_at`。
  由 `join` 建立、`heartbeat` / 任何工具调用刷新心跳、会话关闭/回收/进程重启置为 disconnected。
- **成员运行状态（项目成员层）**：`member_statuses.state ∈ {online, offline, waiting, working}`。
  仅由显式信号驱动：`join` → online；`report_status` → waiting/working；断开 → offline。
- 两层**分表存放、互不写入/推导**。WebUI 展示时只做只读拼接（`GET /api/projects/:id/member-statuses`），
  连接 `connected` 与成员 `waiting/working` 是两个独立字段。
- **在线以 MCP 连接/心跳为准，绝不根据终端画面推断**。

## 3. MCP 工具行为（T2 落地）

| 工具 | T2 行为要点 |
| --- | --- |
| `join` | 校验项目/群组存在（无效 → `INVALID_ARGUMENT`，不静默建）；查找/创建 Agent 与 Member；加入群组；建立连接会话；成员状态置 online；返回 `memberId`/`agentId`/heartbeat。 |
| `wait_for_messages` | 工具自身挂起（D6）；有可投递消息/超时/取消时返回；等待期间刷新连接心跳。 |
| `send_message` | 落 `messages` + `message_deliveries`；`clientMessageId` 幂等；写入后跨会话唤醒等待者。 |
| `acknowledge_message` | 至少一次投递 + 重复确认幂等（acked 后不再投递）。 |
| `report_status` | 写 `member_statuses`（waiting/working）；只允许上报自己 / 当前项目。 |
| `heartbeat`（新增） | 刷新会话心跳与 Agent `last_seen_at`；**不改**成员运行状态。 |
| `read_history` | 只返回「自己发送 + 被 @」消息（D3）。 |

失败路径（均返回明确错误码，不静默）：未入群 `NOT_IN_GROUP`；身份冲突 `CONFLICT`；无效项目/群组/参数
`INVALID_ARGUMENT`；越权确认/读取 `FORBIDDEN`。

## 4. 宿主接入配置示例

> 版本：Claude Code 2.1.233，Codex CLI 0.163.0（macOS，Node ≥ 24）。传输：**stdio 默认**（两端均实测
> 握手通过）；Streamable HTTP 可选（D6）。**不使用 SSE**。真实 smoke 证据见上文 host-evidence 文档。

### 4.1 Claude Code（stdio）—— 实测可用
```bash
claude mcp add agent-studio -s local \
  -e AGENT_STUDIO_DATA_DIR=/绝对路径/到/项目数据目录 \
  -e AGENT_STUDIO_HEARTBEAT_INTERVAL_MS=10000 \
  -e AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS=30000 \
  -- node /绝对路径/src/server/mcp/stdio.ts
claude mcp list          # 期望：agent-studio ... ✔ Connected
```
或单次会话注入（`--mcp-config` + `--strict-mcp-config`）：
```json
{ "mcpServers": { "agent-studio": {
  "command": "node",
  "args": ["/绝对路径/src/server/mcp/stdio.ts"],
  "env": { "AGENT_STUDIO_DATA_DIR": "/绝对路径/数据目录" }
} } }
```
接入后，让 agent 调用 `join`（参数：`displayName`、`hostType="claude-code"`、`projectId`、`groupId`，
项目/群组需先在 WebUI 创建）。stdio 与 HTTP 服务**必须使用同一 `AGENT_STUDIO_DATA_DIR`**，才能看到同一份
项目/群组/成员。

### 4.2 Codex CLI（stdio）—— 配置可用，工具调用未验证（配额阻塞）
```bash
codex mcp add agent-studio --env AGENT_STUDIO_DATA_DIR=/绝对路径/到/数据目录 \
  -- node /绝对路径/src/server/mcp/stdio.ts
codex mcp list
```
Codex 侧带工具调用的轮次本次无法验证（配额耗尽，见 §5）。

### 4.3 Streamable HTTP（可选）
服务启动后 MCP 端点为 `http://127.0.0.1:<port>/mcp`（与健康检查/WS/WebUI 同端口）。
- Claude Code：`claude mcp add --transport http agent-studio http://127.0.0.1:4317/mcp`
- Codex CLI：`codex mcp add agent-studio --url http://127.0.0.1:4317/mcp`
HTTP 模式每次会话独立 `Mcp-Session-Id`；Codex 结束会 `DELETE`，Claude 不发（服务端按
`MCP_SESSION_IDLE_TIMEOUT_MS` 默认 5 分钟回收）。**不要依赖 SSE**（Codex 不支持）。

## 5. 已知限制

1. **不能唤醒空闲宿主、不能打断在途工具调用**（D6）：`wait_for_messages` 只在 agent 主动处于工具调用中时
   有效；不在等待时无法被服务端唤醒。等待建议 25–60s 短周期轮转。
2. **Codex CLI 工具调用未验证（阻塞例外）**：本机 Codex 模型后端配额耗尽（`You've hit your usage limit …
   Oct 27th, 2026`），无法发起带工具调用的轮次。已证实的仅 MCP 配置登记。**AC-CORE-02 未通过（Codex 部分阻塞）。**
   需在配额恢复后补测（建议另开票挂在 #15 之后）。
3. **Claude Code LLM 轮次本次受模型配额限制（429）**：MCP 连接（`✔ Connected`）与官方 SDK 客户端的真实
   工具调用已验证；但 LLM 驱动的 `join` 回放因后端限流未取得，如实记录为环境限制，不写成成功。
4. **重启后的在线判定**：进程重启把所有遗留 `connected` 会话置 `disconnected`、成员 `offline`；恢复完全依赖
   服务端持久化 + agent 重连主动 join/心跳。**完整断线积压/重连回放（T5）未实现。**
5. **单项目单群组**：数据按 project/group 作用域建模，多项目隔离验证属阶段 2。
6. 提示注入风险：agent 会读取其他成员消息正文，接入文档提醒；阶段 1 仅 localhost、无认证。

## 6. WebUI 基础展示

`ProjectsView`（`src/web/src/views/ProjectsView.vue`）新增「成员在线状态」区块：每位成员显示
连接状态（已连接/已断开/未连接）与运行状态（在线/离线/等待中/工作中），并提供「刷新状态」。
数据来自只读端点 `GET /api/projects/:id/member-statuses`。完整状态看板（waiting/working 时序、
陈旧标记、断线提示等）留给 T4。

## 7. 不做 / 边界

- 群聊/@/可见性（T3）；完整状态看板（T4）；断线重连积压（T5）；忙碌打断（T6）；防环（T7）；双宿主完整
  端到端验收（T8）；wrapper / 自动入群 / 强制唤醒空闲宿主。
- 不改已应用迁移；不改 MCP 工具契约对外形状（仅新增 `heartbeat` 工具，其余不变）。

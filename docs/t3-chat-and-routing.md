# T3：群聊、@ 与唤醒/可见性

状态：已实现（T3 #16）
日期：2026-10-22
来源：子 spec #2 §5.3、§6.3（CHAT-01..04、CHAT-08）、决策 D3 #6、D5 #8；ticket #16；
`CONTEXT.md`「自己参与的消息（阶段 1）」；工具契约 `docs/mcp-tool-contract.md`。

本文记录阶段 1 的消息路由与可见性规则：mention 解析、@all 在线快照、普通 agent / 顶层
manager / 发送者的唤醒排除、可见范围、未参与群组隔离，以及消息持久化、稳定 ID、去重与
WebSocket 顺序。**本票只实现路由/可见性/发送；重连积压（T5）、忙碌打断（T6）、限流与防环
阈值（T7）不在本票。**

## 1. 落点与 seam

- **路由域服务** `src/server/chat/routing.ts`：纯函数（无 DB/网络），是三个调用方
  （MCP core、HTTP API、WebSocket 广播）共用的唯一规则来源。以单元测试覆盖（NFR-08）。
- **MCP 投递** `src/server/mcp/core.ts`：`send_message` 解析 mention → 计算路由计划 →
  持久化并把 `pending` 投递给**可见**成员 → 仅唤醒 **wake** 集合；`wait_for_messages`
  只返回可见且属于唤醒范围的消息；`read_history` 按可见性过滤。
- **HTTP API** `src/server/api.ts`：
  - `POST /api/groups/:id/messages` 人发送消息（`senderMemberId`、`text`、可选 `mentions` 稳定 ID）；
  - `GET /api/groups/:id/messages?limit=` 人的历史（可见全部群组消息）。
- **WebSocket** `src/server/ws.ts` + `server.ts`：人通过 HTTP 发送后，服务端广播
  `{ type: "message", message }` 给 WebUI 连接。
- **WebUI** `src/web/src/views/ChatView.vue`（路由 `/chat`）：选择项目/群组/发送身份，
  发送、历史、实时（WS `message` 事件）与 @ 成员点选。

## 2. mention 解析（CHAT-01 / CHAT-02）

`parseMentions(text, roster)`：

- 语法：`@` 后接字母/数字/下划线/连字符/CJK，遇到空白或标点结束。
- **解析优先级**：先按**稳定成员 ID** 精确匹配（`@<memberId>`，消除同名歧义）；未命中再按
  **显示名**（大小写不敏感）。同一显示名命中多名成员时**全部保留**（不静默择一）。
- **@all**：别名 `@all` / `@全体` / `@所有人` / `@大家`（大小写不敏感）→ 置 `all=true`，
  在路由阶段展开为**发送时在线参与者快照**，不逐人解析。
- **无效应答**：无法解析的 `@名称` 记入 `unknownNames`，发送端返回明确错误
  （MCP `INVALID_ARGUMENT` / HTTP 400），不静默丢弃。
- 显式 `mentions` 入参必须是本群参与者（跨群/外部 ID 直接拒绝），防止越权投递。

## 3. 唤醒规则（CHAT-03 / CHAT-04 / 发送者排除）

`resolveWakeAndVisibility(message, roster)` 计算 `wake` 集合：

| 接收者 | 是否被唤醒 | 说明 |
| --- | --- | --- |
| 普通 agent | 仅被 **@**（显式 @ 或 @all 快照含自己） | 不被未点名消息唤醒 |
| 顶层 manager | 被项目内**其他成员的任何群组消息**唤醒 | 无需被点名 |
| 人 | 不涉及唤醒 | 人在 WebUI 实时观察，不走 `wait_for_messages` |
| **发送者** | **永不唤醒自己**（含 manager、含人） | CHAT-04 / AC-CORE-09 |

- **多 @** 只唤醒被点名者；其它普通 agent 不被唤醒。
- **@all** 只覆盖**发送时在线**的参与者（离线成员不在快照内），且不含发送者。
- 唤醒判定在 `resolveGroup` 中逐条执行：可见但非唤醒范围的消息（例如普通 agent 自己发的）
  不会结束其它等待。

> **与 T7 的边界**：本票只做「发送者排除」这一条防自触发。每群组连续自动回复上限 6、
> 每成员 20 次/分钟等阈值与限流**不在本票**（T7 负责）。

## 4. 可见性（CHAT-03 / D3）

`resolveWakeAndVisibility` 同时产出 `visible`（可读/可投递）集合：

| 接收者 | 可见范围 |
| --- | --- |
| 普通 agent | **自己发送 + 被 @**（D3） |
| 顶层 manager | 项目内群组**全部**消息 |
| 人 | **全部**群组消息（阶段 1 单群组） |
| 未参与群组者 | **不可见**（roster 不含其，无投递、无历史、无广播） |

- `read_history` / `wait_for_messages` 的返回、`message_deliveries` 的建立、WebSocket 广播，
  全部以 `visible` 为准。未参与者既没有投递记录，也读不到历史与实时事件（隔离，CHAT-03）。

## 5. 消息持久化、稳定 ID、去重（CHAT-08）

- 消息写入 `messages` 表：`id`（ULID 形状稳定 ID）、`group_id`、`sender_member_id`、
  群组内单调 `seq`、`body`、`mentions`（**解析后的稳定成员 ID 数组**，@all 已展开为快照）、
  `created_at`。`seq` 在同一事务内取 `max+1`，保证群组内顺序稳定。
- **幂等/去重**：外部提供的重复 `id` → `ConflictError`；MCP `send_message` 的
  `clientMessageId` 相同 + 相同发送者 → 返回原消息、`duplicate: true`，不重复落库。
- 投递：对每条消息为所有 `visible` 成员 `ensure` 一条 `pending` 投递记录；`wait_for_messages`
  命中后记 `delivered`，`acknowledge_message` 记 `acked`（oked 后不再投递）。

## 6. WebSocket 顺序（WEBUI-02）

- 人发送消息后服务端广播 `message` 事件；事件里的 `seq` 与持久化顺序一致，WebUI 按 `seq`
  排序展示。测试 `tests/chat-http-ws.test.ts` 验证连发 3 条 WS 事件顺序与 `seq` 一致。
- 广播范围：阶段 1 WebUI 连接即人的视角，单群组内全部消息均在人的可见范围内。MCP agent 的
  投递**不经过** WebSocket（走 `wait_for_messages`）。

## 7. 失败路径

| 场景 | MCP | HTTP |
| --- | --- | --- |
| 空消息 | `INVALID_ARGUMENT` | 400 `invalid_argument` |
| 无效 / 未知 mention | `INVALID_ARGUMENT`（含 `unknownNames`） | 400 `invalid_argument` |
| 非参与者发送 / 越权群组 | `FORBIDDEN` | 400 `invalid_reference` |
| 重复消息 ID | `CONFLICT`；`clientMessageId` 返回 duplicate | 仓库层 409（HTTP 层目前不暴露外部 ID 入参） |
| 未入群 | `NOT_IN_GROUP` | — |

## 8. 测试覆盖（NFR-08）

- `tests/chat-routing.test.ts`：路由域服务单元测试（mention 单人/多人/@all、@all 在线快照、
  多 @ 只唤醒被点名者、manager/普通/发送者排除、可见性、未参与隔离、空 roster）。
- `tests/chat-routing-mcp.test.ts`：MCP 投递集成（普通 agent 只被 @、manager 被未点名消息唤醒、
  发送者排除、未参与群组不可见、manager/普通 read_history 范围、@all 快照、无效/空消息）。
- `tests/chat-http-ws.test.ts`：HTTP 发送/历史、@all 展开、失败路径、非参与者拒绝、WS 实时顺序。
- `tests/webui-e2e.test.ts`：`/chat` 路由可加载、ChatView 使用的同一组 HTTP 接口走通发送与历史、
  构建产物含群聊关键文案与 `/messages` 调用。**边界**：不做真实浏览器 DOM 交互（本机无浏览器驱动），
  前端为薄封装，故「接口走通 + 页面已打包」视为表单可用；DOM 渲染/点击/浏览器内 WS 未覆盖。

## 9. 已知限制 / 未做

- 重连积压的持久化补投（`afterCursor` 的跨进程边界）属 T5；本票 `wait_for_messages` 的
  `afterCursor` 在进程内可用，重启后的完整积压状态机不在本票。
- 忙碌打断（T6）、限流与防环阈值（T7）不在本票。
- 真实双宿主的唤醒延迟属 T8；本票只用 fake client / smoke 验证路由与投递。
- 与 T4 并行：T4 改 status/WebUI 状态看板与心跳超时。本票不改心跳超时逻辑、不实现看板；
  两票都触及 `src/server/api.ts` 与 `src/web`，合并时注意冲突（本票只新增消息路由与 ChatView，
  不修改 T2 已有的成员状态视图）。

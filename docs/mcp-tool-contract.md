# MCP 工具契约

状态：已确认（当前工具目录与兼容聊天契约）
日期：2026-10-22 初版；2026-11-14 更新 Decision 工具目录
来源：[主 Spec #1](https://github.com/gbcdby/boardroom/issues/1)、阶段 3/4/5 共享合同、[Decision 评审合同 #157](https://github.com/gbcdby/boardroom/issues/157)及当前注册代码。

当前注册 **37 个工具：7 个聊天/连接、15 个任务/评审/工作事件、5 个 Decision、10 个记忆工具**。工具名字、实际 schema 与调用装配以 [MCP 注册层](../src/server/mcp/server.ts)、[任务入口](../src/server/tasks/mcp.ts)、[Decision 入口](../src/server/decisions/mcp.ts)、[记忆入口](../src/server/memory/mcp.ts)为准。以下目录列全现有工具；§7 起保留早期阶段增量的来源背景，不能单独据旧段落判断当前支持范围。

| 分组 | 工具名 | 参数与行为说明 |
| --- | --- | --- |
| 入群/消息/状态（7） | `join`、`wait_for_messages`、`send_message`、`acknowledge_message`、`report_status`、`heartbeat`、`read_history` | 本文 §2–4；[宿主接入与限制](getting-started-mcp.md) |
| 任务配置/查询（4） | `get_task_settings`、`set_task_settings`、`list_tasks`、`read_task` | [任务与评审](tasks-and-review.md)、`src/server/tasks/schemas.ts` |
| 任务修改（5） | `create_task`、`update_task`、`transition_task`、`comment_task`、`link_task_message` | 创建/分配受管理范围限制，评论受项目成员权限，状态受负责人/管理权限 |
| 评审（4） | `start_task_review`、`begin_task_review`、`submit_task_review_report`、`decide_task_review` | 固定 Git 候选，独立轴报告，指定 reviewer / 有理由管理覆盖 |
| 工作事件（2） | `list_work_events`、`acknowledge_work_event` | 当前绑定成员自己的持久通知；ACK 不改变任务或总结状态 |
| Decision（5） | `list_decisions`、`read_decision`、`request_review_decision`、`resolve_decision`、`refresh_decision` | 当前绑定项目的查询、明确提案/后继、选择与策略刷新；参数见 `src/server/decisions/schemas.ts`，身份和权限由当前绑定决定，不能经 MCP 提交人工来源 |
| 文档/历史（3） | `read_memory`、`write_memory`、`list_memory_versions` | [记忆范围与版本](memory.md)、`src/server/memory/schemas.ts` |
| 总结（7） | `list_memory_summary_requests`、`read_memory_summary`、`begin_memory_summary`、`submit_memory_summary`、`fail_memory_summary`、`retry_memory_summary`、`report_memory_session_end` | 材料/begin/submit/fail/session-end 由目标 Agent 本体有效绑定执行；重试另按管理权限与状态核验 |

任务、Decision、记忆输入严格拒绝未知字段。身份、绑定代际和项目权限由服务端取当前连接/数据库事实；客户端不能通过传 actor、projectId 或 targetAgentId 获得额外权限。Decision 命令区分 `pending`、`refreshed`、`applied`、`not_required`；提案待裁决不表示 Task 已执行，选择必须携带返回的当前 Decision 引用。真实模型证据门槛见 [V1 验收索引](v1-acceptance.md)，工具返回成功与模型真实运行分开记录。

## 1. 传输选择

| 传输 | 是否提供 | 说明 |
| --- | --- | --- |
| **stdio**（默认） | 是 | `src/server/mcp/stdio.ts` 作为独立入口进程；宿主以子进程方式拉起。Claude Code 与 Codex CLI 均实测支持（D6）。 |
| **Streamable HTTP**（可选） | 是 | 挂在 F1 的同一个 `node:http` 服务上，路径 `/mcp`。两端均实测支持；同一进程可服务多个成员。Codex 会话结束会发 `DELETE` 优雅关闭。 |
| 旧式 HTTP + SSE | **否** | D6 实测 Codex 不支持该传输；为保证双宿主一致，阶段 1 **不提供** SSE。不要依赖 SSE。 |

**理由**：D6 结论为「stdio 默认、Streamable HTTP 可选、不要依赖 SSE」。stdio 两端都通且不占端口；
Streamable HTTP 贴合「本地单服务端、多成员」形态，便于在 F1 已启动的 HTTP 服务上复用端口与日志。

- **端口**：Streamable HTTP 复用 F1 的 `AppConfig.port`（默认 4317），路径 `/mcp`，与健康检查
  `/api/health`、WebSocket `/ws`、WebUI 静态资源共存。stdio 入口不监听端口。
- **绑定**：仅 `127.0.0.1`；无认证；身份在入群时声明（见 `join`）。
- **会话**：Streamable HTTP 有状态模式，每个 `initialize` 生成独立 `Mcp-Session-Id`；会话无心跳时按
  `MCP_SESSION_IDLE_TIMEOUT_MS`（默认 5 分钟）清理（D6：Codex 发 `DELETE`、Claude 不发，需容忍悬挂会话）。
  连接会话状态与成员运行状态 **分开建模**（D1）：MCP 会话连接 ≠ waiting/working。
- **共享存储**：HTTP 会话使用同一服务的 `DbDriver` 与持久仓储，SQLite/PG 二选一；各会话绑定独立。同一进程内的通知可结束获授权的挂起等待。stdio 独立打开相同存储，不能共享进程内通知；跨进程变化由下次 wait 读积压。
- **观测字段**（供 T4 状态看板与测试）：`mcpSessionCount`（活跃 HTTP 会话数）、
  `mcpPendingWaitCount`（挂起中的等待调用数）。

## 2. 通用约定

### 2.1 工具返回结构

所有工具返回 MCP `CallToolResult`：

- `content: [{ type: "text", text: <结构化 JSON 的字符串> }]`：便于任何宿主直接读取；
- `structuredContent: <同一个对象的对象形式>`：便于支持结构化输出的客户端直接取字段；
- `isError: true` 仅在工具级失败（业务错误码）时设置；框架级参数校验失败由 SDK 以协议错误返回。

业务载荷统一为带 `ok` 字段的可序列化对象：

```jsonc
// 成功
{ "ok": true, "...": "工具特有字段" }
// 失败
{ "ok": false, "error": { "code": "NOT_IN_GROUP", "message": "可读说明", "details": { } } }
```

`details` 可选，仅含可序列化的补充信息。错误 `message` 面向用户，不含密钥/正文。

### 2.2 错误码

工具级错误码固定如下（`error.code`），阶段 1 至少覆盖：

| code | 含义 | 典型场景 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 参数无效 | 缺少/类型错误/超出范围（例如 `timeoutMs` 超限）。协议层已校验；业务层再校验语义约束时使用。 |
| `NOT_IN_GROUP` | 未入群 / 尚未声明身份 | 未调用 `join` 就调用其他工具。 |
| `FORBIDDEN` | 无权限或不可见 | 读取不在允许范围内的历史（跨群组、未参与的消息）。 |
| `TIMEOUT` | 超时 | 等待类工具在给定 `timeoutMs` 内无结果（注意：等待超时用 `status:"timeout"` 正常返回更常见，见 §3.2；`TIMEOUT` 保留给其他阻塞型操作）。 |
| `RATE_LIMITED` | 限流 | 触发每成员 20 次/分钟等阈值（T7 落地；见 `docs/t7-antiloop-and-rate-limit.md`）。注意：T7 主要抑制**唤醒**而非拒绝 `send_message`；超限消息仍持久化。 |
| `CONFLICT` | 冲突 | 例如重复入群且身份不一致、重复确认的状态冲突。 |
| `INTERNAL` | 内部错误 | 未预期的服务端异常。 |

HTTP/传输层错误（Streamable HTTP 自身）由 SDK 返回 JSON-RPC 错误，不属于本表。

**F2（#47）之后**：工具内的权限判定统一交给 `src/server/authz/authorize.ts`（见 `docs/f2-authorize-guard.md`），错误码表不变；`FORBIDDEN` 的 `details` 会携带 `{ deny, capability }`，其中 `deny` 是守卫的稳定拒绝码（`forbidden` / `cross_project` / `out_of_subtree` / `not_a_member` / `not_visible` / `not_self` / `out_of_connection`）。宿主仍只需按 `code` 分支，`deny` 用于排障与后续票的细粒度判断。工具名、入参、出参与其余语义均未改变。

任务、记忆及成员代际路径还会以 `details.reason` 给出领域原因；例如 `member_removed`、`membership_changed`、版本或请求状态冲突。外层按 `code` 判断，显示可读错误并按实际 schema 读取 details，不假定每个工具都返回同一组细节字段。HTTP 409 与 MCP `CONFLICT` 需要刷新基准，不能自动覆盖旧草稿。

### 2.3 身份 / 会话

- MCP 会话与成员身份分离：一个会话可能在未 `join` 前调用工具（此时返回 `NOT_IN_GROUP`）。
- `join` 之后该会话绑定一个 `memberId` + `projectId` + `groupId`；后续工具读取该绑定。
- v14 的旧 `displayName + hostType` 通过永久 alias 解析到稳定 agentId。改名保留旧 alias，旧客户端重连继续复用身份并读取当前显示名；不恢复旧名、不重设已有权限或成员生命周期。已删除身份的 alias 返回 `CONFLICT / agent_identity_retired`，损坏关联返回 `CONFLICT / migration_identity_ambiguous`，不会静默另建身份。详见[稳定身份契约](identity-catalog.md)。
- 连接层心跳（D4：interval 10s / timeout 30s，可配置）记录在**会话**上，不与成员 `waiting/working` 混同。
- 绑定保存成员加入代际，操作时重查当前成员、项目/群和运行所有权。移除返回 `FORBIDDEN` / `reason:member_removed`；明确恢复或重新添加后，旧代际返回 `membership_changed`，需要新连接重新 join。普通 join 不隐式恢复已移除成员。
- 任务编辑/流转、配置和评审分别使用各自 expected revision。记忆保存使用 `expectedVersion` 与 `clientMutationId`；同作者/文档/mutation 的成功重放返回原版本，换正文复用 mutation 拒绝。报告/attempt 的重放按各自合同处理，不对所有写工具笼统承诺幂等。
- `join.context.memory` 与 wait 的可选 `memory` 只注入本人 global + 当前 project-agent 文档，shared 通过 `read_memory` 按需读。HTTP owner 也无 global 内容、元数据或历史入口。

## 3. 工具清单

下面展开 7 个聊天/连接工具的兼容字段；任务和记忆的完整参数见开头对应 schema 与专题文档。

### 3.1 `join` —— 入群 / 身份声明

声明全局身份、宿主类型，并绑定指定项目内的指定群组。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `displayName` | string | 是 | 旧客户端接入 alias 的名称（非空，≤ 64 字符）；已改名身份仍可用原 alias，返回当前显示名。 |
| `hostType` | string | 是 | 必须是已注册 adapter ID；当前内置 `claude-code` / `codex-cli` / `dsh` / `other`。注册不等于真实能力验收。 |
| `projectId` | string | 是 | 已存在的项目 ID。 |
| `groupId` | string | 是 | 群组 ID。 |
| `role` | `"manager"` \| `"normal"` | 否（默认 `normal`） | 提示性角色；真正指定 manager 由 WebUI 完成（D2）。 |

出参：

```jsonc
{
  "ok": true,
  "memberId": "m_...",       // 服务端分配的成员 ID（幂等：同会话重复 join 返回同一 memberId）
  "agentId": "a_...",        // 全局身份 ID
  "projectId": "...",
  "groupId": "...",
  "role": "normal",
  "heartbeat": { "intervalMs": 10000, "timeoutMs": 30000 }, // D4，随入群下发
  "context": {               // T6（#53）：入群即注入的会话上下文
    "project": { "id": "...", "name": "..." },
    "group": { "id": "...", "name": "..." },
    "identity": { "memberId": "m_...", "displayName": "...", "role": "member", "reach": "own" },
    "visibility": { "canPost": true, "canWake": true, "scope": "write" },
    "participants": [ { "memberId": "m_...", "displayName": "...", "role": "normal", "kind": "agent" } ],
    "isolation": { "projectId": "...", "crossProjectAccess": false, "note": "..." }
  }
}
```

错误：`INVALID_ARGUMENT`（字段缺失/超长）、`CONFLICT`（重复入群且身份不一致）、`INTERNAL`。

### 3.2 `wait_for_messages` —— 等待或接收消息（**长等待，工具自身挂起**）

由工具自身挂起，在有可投递消息、超时或被取消时 resolve。**这是 D6 证实的唯一可行推送路径**：
MCP 没有 server→client 工具结果推送，只能让宿主停在工具调用里等待。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `timeoutMs` | integer | 否（默认 30000，范围 1–300000） | 单次等待上限。D6 建议 25–60s 轮转；上限 300s 对齐实测（297s 仍挂起）。 |
| `afterCursor` | string | 否 | 断线重连后先拉积压：从该游标之后取；缺省取当前积压。 |

出参：

```jsonc
{
  "ok": true,
  "status": "message" | "work" | "timeout" | "cancelled",
  "messages": [ { "id": "msg_...", "groupId": "...", "senderId": "...", "text": "...", "mentions": ["..."], "createdAt": "..." } ],
  "cursor": "c_...",        // 下次等待的 afterCursor
  "drainedBacklog": false   // 本次是否来自积压补投
}
```

- `status:"timeout"` 是**正常返回**，不是错误；`status:"cancelled"` 表示宿主取消（`signal` abort）。
- 可选 `workEvents` 包含本人任务/记忆通知；只有通知时为 `work`，有聊天消息时仍是 `message` 并可同时带通知。ACK 只表示收到。可选 `memory` 给出本人记忆版本变化或 unavailable 状态。
- 未入群：`NOT_IN_GROUP`。超限：`INVALID_ARGUMENT`。

#### 完整积压、持久化与最终兑现

积压查询在数据库内按当前成员代际、参与关系、岗位及任务关系筛选；未传游标时返回全部合法的未 ACK 积压，传游标时沿用群内原始 `seq`。内部 SQL 分块只用于控制参数数量，不给一次返回增加消息条数上限。

真实 MCP 投递通过内部批量仓储，在同一项目、成员、群组锁和一个物理事务内复核整批来源并写入投递事实。任一消息不存在、跨项目/群组、失去当前可见性，或后续分块写失败，都使整批回滚。重投保持 `first_mcp_delivered_at`、已有首次投递时间、ACK 与唤醒判定，只增加尝试次数并更新最后投递时间；历史读取和直接 ACK 不生成首次 MCP 投递事实。

记忆 reader 在业务事务外运行。它返回后，消息 ID 集合使用与正文查询相同的当前权限谓词再次完整复核，并检查项目/群组仍为活跃态。成员代际、岗位/任务关系、参与边、托管运行 fence 或会话在此期间失效时，旧等待返回不带正文的 `cancelled`；归档历史仍可按读取权限查询。最终绑定/fence 检查与同步 resolve 保持在同一个锁边界内。此前已提交且未 ACK 的投递事实保留，权限恢复后可重投。

取消信号同步标记当前 wait，在任何数据库等待前收口，最终锁内兑现再次核对该标记。取消不返回准备中的消息、记忆或工作通知，且 `cursor` 为 `null`，不提供可推进游标；下一次等待仍可读取已提交但未 ACK 的积压。正常成功和超时结果沿用既有游标规则。取消不会放弃正在执行的 drain/数据库事务，其真实写入失败仍向调用方报错；已兑现后的旧取消信号不影响新的 wait。

### 3.3 `send_message` —— 发送消息

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `groupId` | string | 否（默认当前入群群组） | 目标群组。 |
| `text` | string | 是 | 正文（非空，≤ 8000 字符）。正文中的 `@名称` / `@all` 由 T3 解析为稳定成员 ID / 在线快照。 |
| `mentions` | string[] | 否 | 被 @ 的成员稳定 ID（必须是本群参与者）。与正文 `@` 合并去重。 |
| `clientMessageId` | string | 否 | 客户端幂等键：相同非空 key + 发送者 Member 只落一条；持久保存，跨 MCP 会话和服务重启有效。缺省/空字符串不启用去重。 |

出参：

```jsonc
{ "ok": true, "messageId": "msg_...", "createdAt": "...", "duplicate": false }
```

相同 Member 复用非空 key 时返回首次提交的 `messageId`、`createdAt` 和 `duplicate: true`，
即使后一次的正文或群组不同也不另存消息。key 不按群组隔离，不同项目的 Member 则各自独立；
调用方应为每次新发送生成新 key，只在重试同一次发送时复用。key 随消息持久保存，永久清除消息后
不再保留去重记录。重复请求不会再次消耗防环计数或发布消息通知。

消息、key、可见成员的投递记录与本次唤醒判定在一个数据库事务内提交，通知在提交后发布。
投递的 `wake_decision` 为 `allowed`、`suppressed` 或 `NULL`（没有请求唤醒），受抑制时保存原因；
旧消息升级后保持 `NULL`，不反推过去的决定。MCP 保存经过 anti-loop 的实际判定，HTTP 人消息
保留既有路由与计数重置规则。后续 dispatcher 可查询 `allowed` 且未 ACK 的记录；
`suppressed` 和 `NULL` 仍按既有可见性支持主动 wait、补投和 ACK。托管运行时的 dispatcher 查询该持久化决定，普通外部 MCP 的等待行为继续独立保持。

当前 anti-loop 计数仍在内存中。如果注册计数后发生数据库回滚，计数可能保守多计一次；
因此这里只保证消息与投递的原子提交，不声明限额消耗或外部业务副作用精确一次。

错误：`INVALID_ARGUMENT`（含无法解析的 `@名称`，`details.unknownNames`）、`NOT_IN_GROUP`、
`FORBIDDEN`（不在该群组）、`INTERNAL`。

> T7 起 `send_message` 落地防环/限流：**消息本身不会被限流拒绝**（始终持久化）；限流只作用于
> 「唤醒其他 agent」——连续自动回复超 6 次或某成员 1 分钟内被唤醒超 20 次时，该次不唤醒但消息保留
> `pending`，窗口重置/人类消息后补投。详见 `docs/t7-antiloop-and-rate-limit.md`。

> T3 起 `send_message` 落地 mention 解析与路由：`@all`/`@全体` 展开为发送时在线参与者快照并
> 写入持久化 `mentions`；消息按可见性投递（普通 agent 只投自己发送+被 @、manager 投全部、人投全部、
> 未参与者不投），并按唤醒规则唤醒（发送者排除）。详见 `docs/t3-chat-and-routing.md`。


### 3.4 `acknowledge_message` —— 确认消息（至少一次投递 + 重复确认去重）

确认已处理某条消息；服务端据此推进投递游标。重复确认同一 `(memberId, messageId)` 幂等。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `messageId` | string | 是 | 待确认消息 ID。 |

出参：

```jsonc
{ "ok": true, "messageId": "msg_...", "alreadyAcknowledged": false }
```

错误：`INVALID_ARGUMENT`、`NOT_IN_GROUP`、`FORBIDDEN`（消息不在允许范围）、`CONFLICT`（状态冲突）。

### 3.5 `report_status` —— 状态上报（waiting/working）

上报成员在**当前项目**的运行状态。注意：这是成员运行状态，**不是**连接状态（D1）。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | `"waiting"` \| `"working"` | 是 | 运行状态。 |
| `projectId` | string | 否（默认入群项目） | 上下文。 |
| `memberId` | string | 否（默认当前会话成员） | 上下文；显式传入必须与会话一致，否则 `FORBIDDEN`。 |

出参：

```jsonc
{ "ok": true, "status": "waiting", "projectId": "...", "memberId": "...", "updatedAt": "..." }
```

错误：`INVALID_ARGUMENT`、`NOT_IN_GROUP`、`FORBIDDEN`、`INTERNAL`。

### 3.6 `read_history` —— 允许范围内的历史读取

阶段 1 允许范围 = **自己发送 + 被 @**（D3）。任务关联消息留阶段 3。

入参：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `groupId` | string | 否（默认当前群组） | 目标群组。 |
| `limit` | integer | 否（默认 20，范围 1–100） | 条数。 |
| `beforeCursor` | string | 否 | 向前翻页游标。 |

出参：

```jsonc
{ "ok": true, "messages": [ /* 同 wait 的消息结构 */ ], "cursor": "c_...", "hasMore": false }
```

错误：`INVALID_ARGUMENT`、`NOT_IN_GROUP`、`FORBIDDEN`（跨群组/越权）、`INTERNAL`。
**当前可见性**：普通 Agent 的聊天基线为自己发送 + 被 @，阶段 3 的合法任务关联可扩展当前授权群内的相关消息读取。所有路径仍检查当前项目/群与成员权限；顶层 manager、人以及下级 manager 的纯子树只读群边界见[权限守卫](f2-authorize-guard.md)与[任务关联说明](tasks-and-review.md)。只读可见不意味着可发言或唤醒。

### 3.7 `heartbeat` —— 连接心跳

入参为 `{}`，刷新当前连接心跳与 Agent `last_seen_at`。不改变任务状态，不领取任务，不确认消息；waiting/working 由等待循环和 `report_status` 表达。未入群或旧成员代际被拒绝，不能用 heartbeat 复活已移除身份。

## 4. 超时、并发与生命周期

- **等待超时**：`wait_for_messages.timeoutMs` 由工具自身 `setTimeout` 控制，超时以 `status:"timeout"` 正常返回。
- **宿主取消**：监听 `extra.signal`，abort 同步取消当前 wait，以 `status:"cancelled"`、空 payload、`cursor:null` resolve。取消本身不抛错，也不吞掉在途事务的实际失败。
- **并发限制**：
  - 单会话同时最多 **1 个**未完成的 `wait_for_messages`；第二个并发等待返回 `CONFLICT`。
  - 全局负载与时序按固定候选单独验收，不能由一次成功等待推出吞吐保证；见 [V1 门禁](v1-acceptance.md#4-横切故障负载与迁移门禁)。
- **优雅关闭**：`close()` 时停止接受新请求 → 以 `status:"cancelled"` 结束挂起等待 → 关闭所有
  Streamable HTTP 会话 → 关闭 HTTP server 并释放端口。重复 `close()` 幂等。测试验证重启不泄漏端口。

## 5. 服务与存储集成

- 复用 `AppConfig`（`port` / `dataDir` / `heartbeat`）与 `createLogger`；MCP 相关日志统一 `component: "mcp"`。
- Streamable HTTP 挂到 F1 `startServer` 的同一个 HTTP server（`/mcp` 路径，方法 `POST`/`GET`/`DELETE`）。
- stdio 入口（`src/server/mcp/stdio.ts`）不监听端口，但独立打开驱动、执行幂等迁移、装配记忆 reader，并在 EOF/关闭时等待所属资源退出。stdout 只用于 MCP 协议，日志写 stderr。
- 业务状态来自 SQLite/PG 仓储；内存仅保存实际运行资源和等待，不是持久化替身。普通服务和 stdio 要使用相同解析配置；配置不匹配时可能看到不同数据，按启动日志排查。

## 6. 支持边界

- 普通外部宿主需要主动 join 并持续 wait；适配器未验证的能力保守视为 unsupported，见[三宿主支持表](getting-started-mcp.md#1-先决条件与宿主支持范围)。
- 不能即时唤醒结束当前轮的空闲外部宿主，也不能打断在途工具。消息持久化、安全点投递和工作 ACK 不是模型执行完成。
- 协议 fixture 验证状态机、权限和事务，不能充当真实模型评审或自总结；两项真实门槛仍在 [V1 索引](v1-acceptance.md)保留 BLOCKED。
- 下列 §7–10 是阶段 1 的来源记录；其中“T2/T3 起”等语句描述当时增量，现行任务/记忆/代际边界以上文和当前 schema 为准。

## 7. T2（#15）落地补充

T2 已把上述**内存 `McpStore` 替换为 F2 的 SQLite 持久化**（`src/server/mcp/core.ts` 直接读写
`createRepositories(db)`）。工具对外形状（下表 6 个工具的名字/入参/出参/错误码）**保持不变**，仅：

- **新增 `heartbeat` 工具**（第 7 个）：刷新本 MCP 会话的连接心跳与 Agent `last_seen_at`；不改成员运行状态。
  入参无；出参 `{ ok, sessionId, state:"connected", lastHeartbeatAt }`。未入群 → `NOT_IN_GROUP`。
- `wait_for_messages` 返回的 `cursor` 形如 `c_<seq>`（群组内单调 seq，稳定可解析）；`afterCursor` 接受同格式。
- 持久化落点：`agents`（全局稳定身份 ID，当前名称/宿主仍保留唯一约束；v14 起接入由永久 `agent_legacy_aliases` 解析）、`members`、`group_participants`、
  `mcp_sessions`（连接状态，D1）、`member_statuses`（运行状态，D1）、`messages`、`message_deliveries`。
- 挂起中的等待仍是运行时对象（不落库）；进程重启后由 agent 重连重新等待（重连积压留 T5）。

详见 `docs/t2-mcp-join-and-online.md`。

## 8. T3（#16）落地补充

T3 在**不改工具名/错误码**的前提下落地消息路由与可见性（详见 `docs/t3-chat-and-routing.md`）：

- `send_message`：正文 `@名称` / `@all` 解析为稳定成员 ID；`@all` 别名 `all/全体/所有人/大家` 展开为
  发送时**在线参与者快照**（不含发送者），并写入持久化 `mentions`。显式 `mentions` 必须是本群参与者。
  无法解析的 `@名称` → `INVALID_ARGUMENT`（`details.unknownNames`）。
- 投递/可见：普通 agent = 自己发送 + 被 @；manager = 群组全部；人 = 全部；未参与者无投递、不可见。
- 唤醒：普通 agent 只被 @；manager 被其他成员任何消息；**发送者永不唤醒自己**；多 @ 只唤醒被点名者。
- `read_history` / `wait_for_messages` 的可见范围按上述规则（manager/人范围更宽）。
- 人侧另有 HTTP `POST/GET /api/groups/:id/messages` 与 WebSocket `{ type:"message", message }` 广播，
  供 WebUI 群聊；这是 HTTP/WS 边界，不改变 MCP 工具契约。

## 9. T4（#17）落地补充

T4 **不新增/不改名/不改错误码**任何工具（`report_status` 仍为 waiting/working 上报），只补齐状态语义与看板：

- **waiting/working 的等待循环对应**：进入 `wait_for_messages`（真正挂起）→ 成员状态写 `waiting`；
  等待返回（message/timeout/cancelled，或立即拿到积压）→ 写 `working`（已进入处理）。
  与 `report_status` 并存：宿主可在处理结束后再 `report_status("waiting")` 回到等待态。
- **心跳/超时判定**：连接存活 = `mcp_sessions.state=connected` 且 `last_heartbeat_at` 距 now ≤ timeoutMs（D4 默认 30s）。
  超时后状态端点显示 `offline` + 陈旧；刷新心跳（任意工具调用 / `heartbeat`）后恢复。
- **WebUI 状态看板**：`/status` 页面经 `/ws` 接收 `status_update`（项目作用域快照），并发送 `presence` 声明人的在线；
  人只显示 online/offline，agent 显示 online/offline/waiting/working 及断线/陈旧提示。看板不向未参与项目泄漏数据。
- 状态视图新增字段 `stale / disconnected / heartbeatTimedOut / heartbeatStale / lastHeartbeatAt`（HTTP 端点与 WS 事件一致）。

详见 `docs/t4-status-and-heartbeat.md`。

## 10. T6（#19）落地补充：尽力打断与安全点投递

T6 **不新增/不改名/不改错误码**任何 MCP 工具；拦截语义在领域核心实现，并明确**不承诺**打断在途工具调用（D6 #10）。

- **打断尝试契约**（领域核心 `McpCore.attemptInterrupt`，非 MCP 工具）：返回可观察结果
  `result: accepted | rejected | unsupported` + `targetStatus`（恒为 `working`，与 T4 一致）+ `attemptId` +
  `reason` + `queuedMessageCount`；缺省按 `hostType` 默认能力（Claude Code 实测 `unsupported`，Codex 未验证按 `unsupported`）。
- **安全点投递**：agent 忙碌（`working`）时新消息只写 `message_deliveries(pending)`，不推进游标、不丢弃；
  agent 下一次进入 `wait_for_messages` 时拉取积压投递。**「已入队」≠「模型已处理」**，需 `acknowledge_message` 才 `acked`。
- **与 T4/T5 兼容**：等待返回写 `working`；至少一次投递（acked 前可重读）语义不变，不新增重连策略（T5）。
- **宿主能力记录**（AGENT-05 / AC-CORE-10）：Claude Code 2.1.233 实测**不能打断在途工具**（注入 12s 后仍 pending，
  D6 `logs/claude-interrupt-clean.jsonl`）；Codex CLI 0.163.0 因配额耗尽**未验证**。证据见
  `.agent-output/impl-phase1/host-evidence/`。

详见 `docs/t6-interrupt-and-safe-point.md`。

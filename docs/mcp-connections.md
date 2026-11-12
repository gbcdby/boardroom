# 外部 MCP 连接与工具目录

状态：已确认的 S7 连接/目录服务范围，候选实现待独立交付验收

日期：2026-11-12

需求与验收权威：[S7 #142](https://github.com/gbcdby/boardroom/issues/142)、[连接目录服务 #159](https://github.com/gbcdby/boardroom/issues/159)。

## 保存与明确发现

`/api/mcp/connections` 是当前 localhost 单用户的全局管理入口，沿用本地同源和全局人类 Actor 的管理权限。普通清单、目录、领域事件和错误只暴露稳定标识及状态，不携带 endpoint、argv 或 credentialRef。配置编辑读取有单独的本地管理端点；它的响应包含原配置，不能当作模型上下文或普通目录 DTO。

登记只保存 `name`、`enabled`、传输声明及配置版本。每次 `PUT` 必须提供 `expectedRevision`；成功后追加新版本、推进连接 revision，旧版本与工具快照保留。写入和发现均有 `requestId`，相同请求重放原结果，重复 ID 携带不同内容返回冲突。重放旧修改的结果可能不是当前版本，当前状态以 `GET` 为准。

显式 `POST .../discover` 同时执行本地检查和目录刷新：先持久记录请求对应的配置 revision，随后通过该配置进行 MCP 握手与完整工具分页，最后在数据库事务中发布完整快照。更新或停用配置后到达的旧结果记为 `superseded`，同一配置版本上较旧的并发发现也不能覆盖更新请求的结果。新版本不会自动沿用旧版本的当前目录；历史快照仍可按 digest 读取。

失败、坏响应、部分分页、重复工具名、循环游标、取消和超时均不替换上一份完整目录。读取和服务重启不会自动联网、启动外部进程、安装软件或重试发现。服务不发出 `tools/call`。

## API

表中 `:id` 是返回的 `connectionId`；配置 revision 与发现 `attemptId` 分开标识。

| 方法与路径 | 输入/响应 |
| --- | --- |
| `GET /api/mcp/connections` | `{ connections: McpConnectionView[] }` |
| `POST /api/mcp/connections` | `{ requestId, name, enabled, transport }` → `{ connection }` |
| `GET /api/mcp/connections/:id` | `McpConnectionView`，含当前完整快照与最近发现记录 |
| `PUT /api/mcp/connections/:id` | `{ requestId, expectedRevision, name, enabled, transport }` → `{ connection }` |
| `GET /api/mcp/connections/:id/revisions/:revision/configuration` | 本地配置编辑读取 `{ configuration }` |
| `POST /api/mcp/connections/:id/discover` | `{ requestId, expectedRevision }` → `{ attempt }`，等待本次完成或返回既有记录 |
| `GET /api/mcp/connections/:id/discoveries/:attemptId` | `{ attempt }` |
| `POST /api/mcp/connections/:id/discoveries/:attemptId/cancel` | `{}` → `{ attempt }`；重复取消不产生额外发现 |
| `GET /api/mcp/connections/:id/catalogs/:digest` | 历史完整 `{ snapshot }` |

Streamable HTTP 配置示例：

```json
{
  "requestId": "register-example-1",
  "name": "本地工具服务",
  "enabled": true,
  "transport": { "type": "streamable-http", "endpoint": "http://127.0.0.1:9000/mcp" }
}
```

`transport` 也可登记 `{ "type": "stdio", "command": "命令", "args": [] }`。两种传输均可保存可选 `credentialRef`，只保存引用。HTTP endpoint 不接受 userinfo、query 或 fragment，传输字段不接受任意 headers、env 或授权布尔值。

连接视图的 `state` 是 `registered`、`discovered` 或 `disabled`；`discovered` 表示有该配置版本的历史完整目录，不表示现在保持在线。`modelState` 固定为 `not_provided`。工具身份由连接 ID、连接 revision、原名和 schema digest 组成；跨连接同名和 schema 变更不会混成旧身份。元数据和 schema 视为不可信声明，不授予权限，也不执行 schema 中的内容。

发现记录中的 `running`、`cancel_requested` 是持久请求状态，不证明另一个进程仍在运行或资源已经关闭。进程异常退出后不会根据时间或旧 owner ID 冒认资源归属；未完成记录继续保留，用户可读取状态并用新 requestId 明确重试。服务只中断本实例拥有的连接；其他实例发出的取消先保存请求，原执行者提交结果前会检查该状态。

## 取消、清理与通知

用户取消、HTTP 请求断开、服务关闭会中断本实例的在途发现。关闭覆盖正在等数据库事务的请求，在数据库关闭前等待本实例发现结束。配置停用禁止新连接，并中断本实例使用旧 revision 的发现；其他实例迟到结果通过持久 revision 检查拒绝发布。

每次拥有的 Streamable HTTP 会话先尝试有界 `DELETE`，再关闭本地 transport。`cleanup` 区分 `not_opened`、`closed`、`remote_unsupported` 和 `remote_unknown`：对端不支持删除或未确认远端清理时，不把本地关闭当成远端会话已回收。默认发现期限 10 秒，单次清理另有 2 秒期限；最多 64 页、4096 个工具、8 MiB 协议响应，并沿用目录内核的 JSON 深度与大小限制。

`onMcpConnectionChange` 提供同一 driver 的全局领域订阅，仅在外层事务提交后发出连接/目录 ID、revision 等非秘密提示。嵌套事务回滚或维护门禁拒绝不发成功提示。订阅者可重新查询数据库，观察者错误不撤销已提交结果。通知不是状态权威，也不提供跨进程投递保证；重读持久状态可恢复遗漏。此入口未增加项目 `ResourceChange` 或 WebSocket 广播范围。

已持久化终态的同 requestId 重放直接返回保存的收据，不等待正在发布该终态的原执行。`close` 等待自有外部资源实际清理及结果持久化尝试收尾，资源收尾本身不证明终态已提交；提交失败仍返回 `mcp_discovery_result_not_persisted`。关闭不等待正在调用它的观察者返回，原发现响应仍在其异步通知完整返回后结束。起始通知内关闭尚未出站的请求，会先持久化停止结果，随后完成通知，保持零出站。

## 当前能力与证据边界

| 组合 | 当前行为 | 本票验证方式 |
| --- | --- | --- |
| 无凭据 Streamable HTTP | 真实 initialize、版本/能力校验、tools/list 完整分页、不可变目录 | 真实 loopback HTTP 协议测试服务；包含不可连、坏/循环分页、schema 特殊键、取消和清理诊断 |
| 需要 credentialRef | 可保存；发现 `blocked / credential_unavailable` | 自动化拒绝路径，未接入通用可信凭据 resolver |
| 外部 stdio | 可保存；发现 `blocked / launch_unavailable` | 自动化拒绝路径，未接入通用可信 launcher，没有子进程执行证据 |
| SQLite / PostgreSQL | v19 持久连接/版本/目录/请求；受共同事务和维护 guards 保护 | `tests/mcp-connections*.test.ts`；真实 PG 需显式配置专用测试库，跳过不算通过 |
| 模型/原生宿主装载、ToolSelection、Profile/Binding、tools/call | 本服务不提供这些能力 | 没有真实宿主装载或调用证据；完整页面/宿主消费由相应后续范围验收 |

六张新表均属全局业务数据，参与全值 copy/compare 和全库 clear；项目/群组 purge 保留这些数据。迁移只追加 v19，不改历史 checksum。服务复用 `DbDriver`，维护状态下不绕过写入门禁；如果发现已清理但结果无法落库，返回 `mcp_discovery_result_not_persisted`，不会谎称终态已保存。

作者协议测试、独立需求/标准审查、三项 CI 与真实宿主验收各自有独立证据范围。本文说明当前接口和保守支持范围，不代表整个 S7 或 UI 已通过验收。

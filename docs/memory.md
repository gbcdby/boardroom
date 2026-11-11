# 三层记忆与 Agent 自总结

范围与验收以 [Spec #108](https://github.com/gbcdby/boardroom/issues/108) 和 Tickets #113～#117 为准。本文描述实现合同；PR、测试与真实模型是否通过，以对应候选的验收记录为准。

## 使用方式与可见范围

项目导航的「记忆」页面可以维护项目共享文档和获授权的成员文档。编辑器显示 UTF-8 字节数、当前版本与保存结果；空文档以版本 0 开始。历史正文以文本显示，选择「带入草稿」后仍需显式保存，形成新版本。发生 409 冲突时保留草稿，先查看最新正文并明确接受新基准，再保存。

| 作用域 | 可读写主体 | 自动注入 |
| --- | --- | --- |
| Agent 全局 | 只允许本体 Agent 的有效 MCP 绑定；人、manager 和其他 Agent 均无入口 | 同一 Agent 跨项目共享 |
| 项目共享 | 项目成员可读；人和当前有权管理项目的 manager 可写 | 按需调用 `read_memory` |
| 项目 + Agent | 本体 Agent、人和当前有管辖权的 manager；下级 manager 受实际子树限制 | 只在当前项目注入本人文档 |

管理页面不展示 Agent 全局记忆的正文、元数据或历史。项目归档后保持只读。停用或已离开成员的历史文档仍供有权限的管理者维护，自动总结不为失活目标运行。删群清理该群的来源、请求与通知，保留项目文档和版本；删项目清理其记忆数据，保留 Agent 全局记忆。

## 自动注入与资源

`join.context.memory` 返回本人两层记忆；`wait_for_messages.memory` 在安全点返回变化后的版本或失败状态，相同版本不重复附加。注入含 `state`、`entries`、`maxBytes` 和 `errors`，每层标明原始/实际字节数及是否截断。客户端应使用新结果更新上下文，不将 `unavailable` 当作旧正文仍有效。

注入只通过服务拥有的只读子进程访问数据库，同一 DbDriver 共用一个 reader。最多一个在途读取、八个排队请求；正常响应预算 500 ms，超时后真实子进程受到终止与熔断管理。SQLite 使用 readonly/query_only；PostgreSQL 使用独立只读连接，不占用主业务池。关闭单个 MCP 会话不终止其他会话的 reader；服务/stdio 关闭等待所属资源退出。没有主库补读兜底。

自动触发补扫在消息响应的事务结束后排队，同一数据库串行，绑定任务合并且排队数量有界。每次最多扫描两页、每页 50 个原始来源，保存固定上界与游标；不可见来源推进游标但不计数，下一轮可重查权限。PG 自动写路径在取得成员锁之前设置真实 lock/statement 超时；失败事务回滚，来源留待下个安全点补扫。

## 自总结流程

平台持久化总结请求，由指定 Agent 用自己的上下文生成正文。平台不会凭空调用一个模型或用字符串拼接冒充自总结。

1. 任务真实进入 done、本人实际收到第 N 条可见消息，或 Agent 明确调用 `report_memory_session_end` 时，安排项目 + Agent 总结请求。
2. `memory.summary_requested` 是可重投的工作通知。`acknowledge_work_event` 只确认收到通知，不改变请求状态，也不表示模型已执行。
3. 本体 Agent 用 `read_memory_summary` 读取当前授权材料，再用 `begin_memory_summary` 接手，取得新的 attempt。材料查询保持只读。
4. Agent 生成完整 Markdown，通过 `submit_memory_summary` 提交正文、请求修订、attempt 与执行来源声明。正文、不可变版本、成功状态、证据和通知确认在同一事务提交。
5. 失败使用 `fail_memory_summary`；超时、来源任务变化、人工新版本分别保留 failed、cancelled、conflicted。管理者可以安排一次新请求，重新读取基准并等待新的模型输出，不能给旧输出换版本后重试。

请求状态为 pending / running / completed / failed / conflicted / cancelled。只有成功完成才保存 `SelfSummaryEvidence`；其 `provenance` 固定为 `agent-declared`，含 host/version、invocation/context、起止时间、prompt/output SHA-256 和 evidenceRef。平台检查格式与提交正文 hash；这不证明宿主真的运行过模型。真实模型验收必须另有实际调用、输出与上下文证据。

消息历史读取、直接 ACK、旧库 delivered 状态都不能回填真实 MCP 投递标记。任务通知即使已 ACK，仍可由持久任务来源补偿。断线、transport EOF、超时或进程退出都不是逻辑 session-end。

## HTTP 与 MCP

HTTP 仅限当前本地同源管理边界；不接受请求自行声明 actor 或会话代际。

| HTTP | 结果 |
| --- | --- |
| GET `/api/memory-settings` | `{ settings }`，五个实际有效的记忆设置 |
| GET `/api/projects/:p/memories` | `{ documents }`，经 ACL 过滤 |
| GET / PUT `.../memories/shared` | 读取 `{ document, version }`；写入直接返回 `WriteMemoryResult` |
| GET / PUT `.../memories/agents/:agentId` | 同上，当前权限重新验证 |
| GET 文档路径 + `/versions?beforeVersion=N` | `{ versions }`，历史分页 |
| GET 文档路径 + `/versions/:version` | `{ version }`，相同 ACL 下读取具体版本 |
| GET `.../agents/:agentId/summary-requests` | `{ requests }`，持久请求状态 |
| POST `.../memories/summary-requests/:id/retry` | `{ request }`，body 为 `{ clientMutationId }` |

写文档 body 为 `{ expectedVersion, clientMutationId, markdown }`。同一作者、文档和 mutation ID 的重放返回原写入版本；内容不同则拒绝。版本冲突返回 HTTP 409；MCP 使用 CONFLICT。字段严格校验，未知字段拒绝。没有 global HTTP 路由，也没有 owner 执行 packet/begin/submit/fail 的 HTTP 入口。

新增 MCP 工具：`read_memory`、`write_memory`、`list_memory_versions`、`list_memory_summary_requests`、`read_memory_summary`、`begin_memory_summary`、`submit_memory_summary`、`fail_memory_summary`、`retry_memory_summary`、`report_memory_session_end`。scope 为 `global` / `project` / `project-agent`；项目、成员身份和绑定代际由当前连接提供。完整参数 schema 位于 `src/server/memory/mcp.ts` 与 `schemas.ts`。

## 配置与验证

配置仍按默认值 → 配置文件 → 环境变量加载，修改后正常重启生效。

| `memory` 字段 | 默认 | 环境变量 |
| --- | ---: | --- |
| messageThreshold | 50 | AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD |
| maxDocumentBytes | 32768 | AGENT_STUDIO_MEMORY_MAX_DOCUMENT_BYTES |
| maxInjectedBytes | 8192 | AGENT_STUDIO_MEMORY_MAX_INJECTED_BYTES |
| summaryInputBytes | 65536 | AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES |
| summaryAttemptTimeoutMs | 900000 | AGENT_STUDIO_MEMORY_SUMMARY_ATTEMPT_TIMEOUT_MS |

正文与注入预算按 UTF-8 计算；注入按 grapheme 边界截断，避免切坏 emoji/组合字符。文档保存超限时拒绝，不截断用户草稿。

`npm run e2e:memory` 使用真实 HTTP/MCP SDK 和数据库，检查权限、版本冲突、新请求、证据原子提交、消息阈值与注入；摘要正文是明确标注的协议夹具，报告保留 `realModelSummary: NOT_RUN`。真实 PG 表锁下的主消息/ACK/status 与实际回滚见 `tests/memory-mcp-postgres.test.ts`。没有配置真实 PG 时该项 SKIP，由 CI 的 PG 服务执行，不能以 SQLite 通过代替。

**AC-MEM-04 已收到独立真实宿主验收的 PASS 回传。** [阶段 4 候选记录](https://github.com/gbcdby/boardroom/issues/117#issuecomment-6789491909)绑定 `0182ecee29760430e81ca5511f449c45b7125b12`；[阶段 5 集成补验](https://github.com/gbcdby/boardroom/issues/117#issuecomment-6790050561)绑定 `533e49da5d4e9d4a236d68e0bc23c03411caa5b1`。在 macOS 26.5.2 / SQLite 上，目标 Codex CLI 0.167.0 自身上下文完成三个触发、人工先写冲突与新请求重算，最终注入 v4。执行、原始 hash 核对与平台读回归属于报告中的独立执行者；交付方承接回传，没有把它写成本机或后续候选重新运行。

平台保存 completed 夹具、WebUI 显示成功、调用工作 ACK 或声明正确 hash，仍不能单独证明模型执行。真实模型、协议、PG、浏览器证据及后续候选适用性分别保留在 [Spec #108](https://github.com/gbcdby/boardroom/issues/108)及 [Ticket #117](https://github.com/gbcdby/boardroom/issues/117)。macOS PostgreSQL 未在这次外部执行中覆盖，托管 profile 的支持边界也未改变。

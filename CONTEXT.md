# CONTEXT.md — 项目独有记忆

> 保存跨会话仍有效的非显而易见知识：术语、踩坑、宿主差异和待验证假设。维护规则见 `AGENTS.md` 的「项目记忆」；原独立记忆技能已于 2026-11-10 退役。
>
> 不放在这里：宏观架构与架构决策 → `docs/architecture/`；开发流程决策 → `AGENTS.md`、`docs/agent-workflow.md` 或 issue；map、spec、ticket → GitHub Issues；过程材料 → `.agent-output/`。
>
> 条目注明日期、适用范围和证据；未复现的推测放入「待验证」。软上限约 150 行，超出时合并重复、淘汰过时内容或升级。

## 易混淆术语

> 以下定义自 2026-10-18 起适用；来源列即证据。

| 术语 | 在本项目中的含义 | 来源 |
| --- | --- | --- |
| Agent vs Member | Agent 是跨项目的全局身份；Member 是 agent 或人在某个项目中的成员关系与岗位。 | `docs/architecture/agent-studio.md` §4.1 |
| Project vs Group | Project 是协作容器（成员、组织树、任务板、记忆）；Group 是项目内的聊天空间，参与者是项目成员子集。 | 同上 |
| Status vs 任务状态 | Status 是成员的在线/离线、等待/工作中的运行状态；任务状态属于 Task，两者分开建模。 | 同上 |
| Agent 连接状态 vs Status | Agent 连接状态是全局 MCP 会话状态（connected/disconnected、最后心跳）；Status 是项目成员的 online/offline/waiting/working，按 `(project_id, member_id)` 记录。 | 决策票 #4（D1，2026-10-18） |
| role（阶段 1） | Member 的项目级角色字段；阶段 1 只有 `manager` / `normal`，每项目最多一个顶层 manager；完整角色模型在阶段 2。 | 决策票 #5（D2，2026-10-18） |
| legacy `members.role='manager'`（T2 #49 起） | **不再是真实角色**，只是组织树根节点（顶层 manager 岗位）的阶段 1 兼容投影：旧 `ux_members_project_manager` 索引在迁移 v4 移除，唯一性下沉到 `members` repository 应用层；占据/让出根节点时同步升降。真实角色看 `org_nodes.role`（静态枚举）与 F2 `ROLE_CAPABILITIES`。升级库默认无组织数据，未落位成员走 `actorForMember` 兼容映射（人=owner），因此阶段 1 行为不变。 | 决策票 #24/#25/#26、T2 #49 |
| 角色 vs 岗位（T2 #49 起） | 角色是静态枚举 `owner/top_manager/sub_manager/member` 的能力集合定义（不落库）；岗位是 `org_nodes` 节点上的实例，`members.node_id` 指向它。二者正交：`node_id` 管「谁占哪个岗」，节点 `role` 管「该岗位是什么角色」。 | 决策票 #25、T2 #49 |
| 自己参与的消息 | 2026-11-11 核对：普通 Agent 的聊天基线为自己发送 + 被 @；阶段 3 的合法任务关系可扩展当前授权群内的关联消息读取，但不扩大跨项目/跨群或 mention 唤醒范围。 | 决策票 #6；`docs/tasks-and-review.md`、`tests/tasks-service.test.ts` |
| fixed point | 双轴评审的 diff 基准点（commit SHA、分支、tag 等）；评审记录必须可追溯，未提交候选另记录完整工作树身份。 | `docs/architecture/agent-studio.md` §6.7；`.agents/skills/worker-review/SKILL.md`（2026-11-10 技能迁移） |
| 三层记忆 | Agent 全局记忆、项目共享记忆、项目+agent 记忆；作用域、读写权限和注入方式不同。 | `docs/architecture/agent-studio.md` §6.8 |
| 状态看板 vs 跨项目总览 | 2026-11-11 S6 #138 候选更正旧路由记录：项目成员状态进入 `/projects/:projectId/members?tab=status`，旧 `/status` 与项目 `/status` 继续规范化；`/` 为不绑定当前项目的协作总览。自 #31 起共用全局 human presence（memberId 级引用计数），不因切项目只保留当前人的在线。 | 决策票 #31/#40、PR #149；`src/web/src/router.ts`、`useCurrentProject.ts`；CI43090889252 navigation 实测；候选未合并 |
| 成员移除 vs 暂停 | 2026-11-11 的 v13 工程候选：暂停保留岗位；移除保留 Member 历史身份并推进 membershipRevision。显式重新添加复用 ID、用新代际且不默认复活旧群关系；撤销不复活旧 MCP/评审/托管/总结执行。 | `docs/t3-member-lifecycle.md`、`src/server/db/migrations/member-lifecycle.ts`、`tests/member-compensation.test.ts`；最终运行状态见 V1 索引 |

## 宿主差异（Claude Code / Codex CLI）

> 只在实际测试后填写，记录版本、测试条件、可复现结果和日期。

| 宿主 | 版本 | 能力 / 差异 | 测试条件与结果 | 日期 |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.233 | 传输：stdio、Streamable HTTP、旧式 SSE 全支持（`claude mcp add --transport stdio\|sse\|http`）。 | 三种传输均完成 `initialize` + `tools/list` + `tools/call` 实测。 | 2026-10-21 |
| Claude Code | 2.1.233 | 长等待：服务端可在任意时刻结束等待，agent 在同一轮内拿到结果继续执行。 | `wait_for_messages(120s)` 挂起 453ms 后由服务端投递，工具立即返回，本轮继续至结束（10.2s）。 | 2026-10-21 |
| Claude Code | 2.1.233 | 长等待无短硬超时：实测 297s 仍在挂起。 | 10 次 30s 采样，工具始终 pending。 | 2026-10-21 |
| Claude Code | 2.1.233 | **不能打断在途工具调用**：等待期间注入用户消息，不会取消正在执行的工具。 | `--input-format stream-json` 注入消息后 12s，`wait_for_messages` 仍 pending。 | 2026-10-21 |
| Claude Code | 2.1.233 | 重连：宿主不保留跨会话 MCP 状态；积压需服务端持久化，重连后首次等待立即补投。 | 进程退出→服务端留存→新会话 `initialize`→`drained_backlog: true`。 | 2026-10-21 |
| Codex CLI | 0.163.0 | 传输：仅 stdio 与 Streamable HTTP（`codex mcp add -- <cmd>` / `--url`）；**不支持 SSE**。 | 两种传输均完成 `initialize` + `tools/list`；HTTP 会话结束发 `DELETE` 优雅关闭。 | 2026-10-21 |
| Codex CLI | 0.166.0 | 等待：`wait_for_messages` 挂起后可被服务端投递结束、同一轮继续；重连靠服务端持久化、重连首等待补投；**不能打断在途工具**（`unsupported`）；不支持 SSE。 | Streamable HTTP 真实接入：join 成功；等待中 `state=waiting` 后收到人消息（`drainedBacklog:false`）；agent↔agent 双向 @；服务端重启后重连 `drainedBacklog:true`。 | 2026-11-03 |
| DeepSeek Harness (dsh) | 0.2.1-rc.5 | 第三个正式宿主，当前注册 `hostType="dsh"`；历史实测使用 other，已迁移。修正旧“正式标识待定/双传输可承诺”表述：适配器未声明独立验证传输，reconnect/interrupt unsupported、wakeIdle false。 | 随库 `evidence/real-host-retest/` 只证实当时 Streamable HTTP join 与活跃 wait 收消息；无重连原始证据。 | 实测 2026-11-03；2026-11-11 对照 `src/server/mcp/adapters/dsh.ts` 修订 |

## 踩坑记录

> 只记录实际复现、未来可能再次遇到的问题。每条包含：现象、原因、结论/做法、适用范围、证据。

| 现象 | 原因 | 结论 / 做法 | 适用范围 | 证据 |
| --- | --- | --- | --- | --- |
| Codex 0.167.0 反复把评审 expectedRoundRevision 发为字符串 | 多个任务字段复用同一 Zod 实例，对外 MCP schema 生成兄弟属性 $ref；该实测宿主未正确解析 | 为公开字段使用独立实例并保留原约束，不用字符串 coercion 放宽修订号。2026-11-11 外部复测在 main `89af568` 确认内联 schema、指定 Codex reviewer begin 成功及非指定成员 `FORBIDDEN / not_self` | macOS 26.5.2 / SQLite、Codex 0.167.0 原生 MCP；只覆盖 begin 成功/拒绝，完整新格式双轴与自总结仍未重跑；原 Claude reviewer 证据保留原对象 | [#107 原始回传](https://github.com/gbcdby/boardroom/issues/107#issuecomment-6789489800)；[V1 索引 §2.4](docs/v1-acceptance.md#24-合并后的外部局部复测)承接 `recheck-report.md`；`src/server/tasks/schemas.ts`、`tests/mcp-server.test.ts` |
| 原型 MCP server 在宿主被杀后日志暴涨到 1.2G；默认 stdout 断管还可导致进程退出 | 同步 try/catch 不捕获流的异步 error；向已断 stderr 递归记录错误会放大故障 | 同步写入捕获之外，默认异步流只装一个 error 监听器并共享健康计数；错误处理不递归写断开的流 | stdio MCP、服务默认日志 sink | 原型历史；2026-11-10 PR #90，`tests/logger.test.ts` 真实 EPIPE 回归 |
| 托管 runner 正常安全停止被误记失败 | MCP 业务和 stop 控制帧共用匿名管道，先关 transport 会截断停止请求 | 先发自有 child 的安全点停止，真正 exited 后再关完整通道；意外 MCP 断连仅先关闭业务侧并记录 transport_lost，忙碌进程不按启动超时强杀 | `runtime/gateway.ts`、`runtime/supervisor.ts` | 2026-11-10 #89 / PR #90，独立真实隔离替身安全点探针 |
| Claude 认证失败却只有 ready/usage_unavailable，退出后可能自动重试 | 实际 2.1.322 返回顶层 `assistant.error=authentication_failed`，末帧仍为 `result.subtype=success` 且 `is_error=true` | 只识别白名单结构化枚举，保留 auth_required；断连不能覆盖，等待显式 retry，不猜正文或 stderr | Claude 2.1.322 托管输出与 supervisor | 2026-11-10 #86/#89，实际 CLI 无凭据、零网络出口探针；`tests/runtime-host.test.ts` / `runtime-supervisor.test.ts` |
| 路径不重叠且直接访问已隔离，工作根仍能改外部控制文件 | 预置硬链接共享 inode；受保护根或子目录的 bind alias 即使 nlink=1 仍指向原文件树 | 对实际 RW 根 FD 检查硬链接/特殊文件/嵌套挂载，并按 mountinfo 的设备、文件系统根及相对位置比较保护范围；session 目录先核验预期位置再写入 | Linux 托管准备及放行门禁；不承诺防御其他恶意宿主进程并发改挂载 | 2026-11-10 #86/#89，真实 namespace 合成 canary；`tests/runtime-filesystem-boundary.test.ts` |
| `claude auth status` 报 loggedIn，但原生 OAuth 托管条件仍未满足 | 新设备使用 settings 中的 Magpie 代理认证与第三方模型；剥离 ANTHROPIC 环境后真实 CLI 返回 authentication_failed | 分开记录协议面、认证来源及 launcher 隔离证据；不将代理成功轮次登记为官方 OAuth/Linux profile | 官方 CLI 2.1.322，macOS arm64 代理环境；不推广到所有登录方式 | 2026-11-11 [PR #90 跨设备交接](https://github.com/gbcdby/boardroom/pull/90#issuecomment-6774231847) |
| resume 的会话累计金额被拆成两次 invocation 快照 | 宿主事件只能表达 invocation，scope/epoch 每次 attempt 重建；num_turns 也不是结果顺序 | token 与金额分项声明 scope，按实际 SID 归属并保留稳定内部引用；以已验证 result_index 与 generation 排序，不求和累计快照 | 代理环境 2.1.322 的 0.021495→0.024667 反例及合成端到端回归；完整官方用量 schema 仍未验证 | 2026-11-11 #87/#89，R-64-NATIVE-003；`runtime-supervisor.test.ts` / `runtime-observability.test.ts` |
| 去掉高级 argv 的拒绝分支后，CLI 仍在初始化前退出 | 原 user namespace 将身份映射为 UID 0；官方 CLI 拒绝 root 的 bypassPermissions | 隔离内使用实际非零 UID/GID 并继续移除全部 capabilities；两档分别验证，不能伪造容器检测或沿用 Auto profile | Linux 官方 CLI 2.1.322，无凭据/零出口初始化探针；模型和完整高级档仍待验收 | 2026-11-11 #86/#89，R-64-NATIVE-004；`tests/runtime-advanced-mode.test.ts` |
| 已过时：旧入口的 model invocation 限制（2026-11-04 历史） | 当时的部分技能声明 `disable-model-invocation: true`；旧技能已于 2026-11-10 退役 | **2026-11-10 修订**：撤销原“直接读盘绕过限制”的做法。按当前 `AGENTS.md` 调用新体系；另行接入的技能仍须遵守其调用限制，不代用户作出未授权的决定 | 仅作历史提醒，不是当前入口或调用授权 | #31 历史；2026-11-10 技能迁移与 `AGENTS.md` 的「工作流与生效技能」 |
| 给 `createT1ApiRouter` 加闭包内 `const` 状态（#48 永久删除待确认表）后，请求直接 500 `Cannot access 'pendingPurges' before initialization` | 该工厂函数**先 `return { handle }`**，后面的函数声明靠 hoisting 才能被调用；写在 `return` 之后的 `const`/`let` 永远不会初始化（TDZ） | 新增闭包状态必须声明在 `return` 之前（本仓库 `src/server/api.ts` 的结构就是「先 return，再写函数声明区」）；排查同类问题先看错误是否为 ReferenceError | `src/server/api.ts` 及其他「提前 return + 下方函数声明」的工厂 | 2026-11-04 #48 实现期；修复见同分支提交 |
| 测试里 `await client.close(); await transport.terminateSession()` 之后，服务端 `mcp_sessions` 仍是 `connected`（成员一直 online） | MCP SDK `StreamableHTTPClientTransport.close()` 会 `abortController.abort()`；随后 `terminateSession()` 里的 DELETE fetch 用的正是这个**已 abort 的 signal**，DELETE 根本没到服务端，`onclose→core.disconnect()` 不触发 | 必须**先** `await transport.terminateSession()` 发 DELETE（触发服务端 onclose / 会话断开 / 运行状态回落 offline），**再** `await client.close()`。仅 `client.close()` 的既有清理顺序不适用于「要验证断开态」的用例 | 所有用 `StreamableHTTPClientTransport` 验证「断开/离线」的测试；仅做收尾清理时顺序无所谓 | 2026-11-05 #50 LIFE-MEM-03 用例调试；SDK `dist/esm/client/streamableHttp.js` `close()` / `terminateSession()` |
| `dbDriver=postgres` 上 `wait_for_messages` 漏投消息（AC-CORE-05/04 失败、`status=undefined`），服务端报 `error: LIMIT must not be negative`（SQLSTATE `2201W`）；同一代码在 SQLite 下全通过 | SQLite 把 `LIMIT -1` 解释为「不限」，PostgreSQL 拒绝负数 LIMIT；`repositories.listByGroup` 原以 `limit ?? -1` 拼 `LIMIT ?`，PG 上直接抛错 | 双方言共用的分页查询在 `limit<=0` 时**省略 LIMIT 子句**，不要传负数；PG 运行态异常先看 SQLSTATE / 错误码，别只怀疑唤醒竞态 | 所有经 `DbDriver` 双方言执行的 `LIMIT` / `OFFSET` 查询 | 2026-11-06 #61 真实 PG 复现与修复；`src/server/db/repositories.ts` `listByGroup`；PR #75 的 `fix(#61)` 提交 |
| feature 分支 HEAD 上 `npm test` / `tsc` 全绿，合并到 `main` 后同一套命令立刻变成 2 个测试失败 + 5 个 tsc 错误 | `main` 在分支分叉后由 `c345f3a` 新增了 `tests/host-adapter-converge.test.ts` 的 AC-HOST-01/04 用例，按旧同步 API 编写；#61 把 `core.join` / `attemptInterrupt` / `close` / `ctx.spawn` 改为 async，Git 文本合并无冲突但语义不兼容（未 `await`） | 验收不能只在 feature 分支做；**合并后必须在合并后的 `main` 树复跑** `tsc` / `npm test` / e2e 才能宣布通过；凡改动公共 API 签名（尤其 sync→async），把分叉点之后 `main` 的改动视为集成风险 | 所有改动公共 API 签名的票；长期分支与 `main` 并行演进时 | 2026-11-06 PR #75 合并（`a7081d8`）后复验、PR #76（`9d75ea8`）修复；#61 更正评论 |
| v13 复制/清库不能简单使用完全相反表序 | 成员和六类事实的真实 trigger 会生成/推进 member_fact_revisions；过早清它会使后续事实删除缺基准 | 复制最后用源值替换事实版本；清空先删事实、再删 Member/事实版本。不要停用 trigger 或伪造 revision | SQLite/PG 非空复制与项目 purge；当前工程实现，最终双引擎结果单列 | 2026-11-11 静态核对 `src/server/db/migrate-data.ts`、`tests/member-facts.test.ts`、`tests/migrate-data.test.ts` |
| Agent 的 send/wait/ACK 通过，但网页实时列表仍停在旧消息 | 原 WebSocket 广播只装配在 HTTP 发消息回调，MCP 提交通知没有 WebUI 订阅者 | 同一服务进程的 WebUI 订阅 driver 粒度提交后通知，HTTP/MCP 共用消息视图；幂等重试不重播。协议与真实 DOM 分开验收 | 同进程 HTTP/MCP 服务；不扩大为跨进程 stdio 广播保证 | 2026-11-11 CI 42955289947 浏览器负例；`tests/chat-http-ws.test.ts` 真实 MCP/HTTP/WebSocket RED→GREEN，最新 DOM 结果单列 |
| 群删除若直接用整个成员事实版本，其他群写入/ACK/空扫描也会使确认失效；原 API 删除提交后才写审计 | `member_fact_revisions` 按成员汇总多群事实，且观测推进不等于删除范围增加；分开事务会留下已删业务但无审计 | 捕获实际删除对象/关系的稳定投影；compare、purge 和审计共用原项目锁/事务。删群还需捕获最后绑定消失后才删除的 runtime reservation | #130 项目/群永久删除快照；不改变成员补偿的事实版本语义 | 2026-11-11 `src/server/db/purge-impact.ts`、`tests/purge-confirmation.test.ts` SQLite 同数替换/无关群/观测字段/失败回滚实测；PG/Chromium 由各自 CI 记录单列 |
| 浏览器报告全 PASS，原生截图仍显示首次聊天未贴底、退出强制配色后白底浅字 | 负载脚本每轮预先滚底，未覆盖首次进入；媒体切换只比较边界 token，未检查实际画布。具体产品根因与修正须另据固定候选证明 | 分别验收正常/延迟历史加载、布局变化与主动翻阅历史；颜色模式进入/退出须检查实际截图和文字背景组合，不能只据 CSS 值或报告状态收口 | S6 #138/#144 的 Chromium 验收；不外推所有浏览器或真实手机键盘 | 2026-11-11 PR #149，CI43090889252 / tree8e86c0b3，artifact13890125303 的原图与 trace；两独立轴保留真实 CI 成功及视觉失败 |

## 待验证

> 记录影响实现选择、尚未实测的技术假设；产品需求层面的待定项见 `docs/architecture/agent-studio.md` §10.2。

| 假设 / 问题 | 影响 | 验证方法 | 状态 |
| --- | --- | --- | --- |
| Codex CLI 的等待/打断/重连行为是否与 Claude Code 一致 | 决定能否对 Codex 承诺「安全点投递」和等待循环 | Codex 配额恢复后（约 2026-10-27）重跑 | 已验证（2026-11-03，0.166.0）：等待活唤醒与重连补投与 Claude 一致；打断同为 `unsupported` |
| Claude Code `MCP_TOOL_TIMEOUT` / `MCP_TOOL_IDLE_TIMEOUT` 的默认值 | 决定单次等待时长上限的保守取值 | 显式设置环境变量做对照实验 | 待验证 |
| 宿主被强制杀死（非优雅退出）后的 MCP 会话回收时延 | 决定服务端会话清理超时 | 杀进程后轮询服务端会话表 | 待验证 |
| 托管原生 Claude 的 Auto、常驻、resume、认证刷新与用量 schema | 决定是否可填 `VERIFIED_HOST_PROFILES`；历史外部 MCP 证据不能替代 | 在符合 profile 的 Linux + 官方 OAuth + 固定出口环境，通过实际 launcher 分档验收 | 2026-11-11：Linux 2.1.322 已有无凭据初始化/失败路径证据；macOS 代理补验仅覆盖协议面。完整模型轮次与官方用量仍缺证据，支持表为空，见 #86/#89/PR #90 |

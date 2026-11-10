# CONTEXT.md — 项目独有记忆

> 保存跨会话仍有效的非显而易见知识：术语、踩坑、宿主差异和待验证假设。维护规则见 `AGENTS.md` 的「项目记忆」；原独立记忆技能已于 2026-11-10 退役。
>
> 不放在这里：宏观架构与架构决策 → `docs/architecture/`；开发流程决策 → `AGENTS.md` 或 issue；map、spec、ticket → GitHub Issues；过程材料 → `.agent-output/`。
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
| 自己参与的消息（阶段 1） | 阶段 1 只覆盖自己发送 + 被 @；任务关联消息留阶段 3，最终定义在阶段 3 重新确认。 | 决策票 #6（D3，2026-10-18） |
| fixed point | 双轴评审的 diff 基准点（commit SHA、分支、tag 等）；评审记录必须可追溯，未提交候选另记录完整工作树身份。 | `docs/architecture/agent-studio.md` §6.7；`.agents/skills/worker-review/SKILL.md`（2026-11-10 技能迁移） |
| 三层记忆 | Agent 全局记忆、项目共享记忆、项目+agent 记忆；作用域、读写权限和注入方式不同。 | `docs/architecture/agent-studio.md` §6.8 |
| 状态看板 vs 跨项目总览 | 状态看板 = **项目作用域的成员级明细**（阶段 1 现路由 `/status`，`StatusBoardView.vue`）；跨项目总览 = 阶段 2 的 `/` 页，**只到每项目计数**，无成员明细。自 #31 起两者共用同一条**不绑项目的全局 human presence**（memberId 级连接引用计数），所以「人在所有项目都算在线」是设计而非 bug。 | 决策票 #31（2026-11-04）、#40（子地图 #35） |

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
| DeepSeek Harness (dsh) | 0.2.1-rc.5 | 第三个正式支持宿主（已入产品基线/主 spec）；`@deepseek-ai/dsh-mcp-client` 支持 `stdio`/`streamable-http`。当前代码以 `hostType=other` 接入，正式 `hostType="dsh"` 与宿主适配器由决策票 #43 定稿。 | Streamable HTTP 真实接入 boardroom：join 成功；等待中 `state=waiting` 后收到人消息（`drainedBacklog:false`）。 | 2026-11-03 |

## 踩坑记录

> 只记录实际复现、未来可能再次遇到的问题。每条包含：现象、原因、结论/做法、适用范围、证据。

| 现象 | 原因 | 结论 / 做法 | 适用范围 | 证据 |
| --- | --- | --- | --- | --- |
| 原型 MCP server 在宿主被杀后日志暴涨到 1.2G | stderr 已断（EPIPE），`uncaughtException` 处理里又写 stderr，递归触发自身 | 日志写入必须 try/catch 包裹；EPIPE 单独短路，且对 uncaught 限次记录 | 任何 stdio MCP server | `.agent-output/d6-host-capability/` 修复前后对比 |
| 已过时：旧入口的 model invocation 限制（2026-11-04 历史） | 当时的部分技能声明 `disable-model-invocation: true`；旧技能已于 2026-11-10 退役 | **2026-11-10 修订**：撤销原“直接读盘绕过限制”的做法。按当前 `AGENTS.md` 调用新体系；另行接入的技能仍须遵守其调用限制，不代用户作出未授权的决定 | 仅作历史提醒，不是当前入口或调用授权 | #31 历史；2026-11-10 技能迁移与 `AGENTS.md` 的「工作流与生效技能」 |
| 给 `createT1ApiRouter` 加闭包内 `const` 状态（#48 永久删除待确认表）后，请求直接 500 `Cannot access 'pendingPurges' before initialization` | 该工厂函数**先 `return { handle }`**，后面的函数声明靠 hoisting 才能被调用；写在 `return` 之后的 `const`/`let` 永远不会初始化（TDZ） | 新增闭包状态必须声明在 `return` 之前（本仓库 `src/server/api.ts` 的结构就是「先 return，再写函数声明区」）；排查同类问题先看错误是否为 ReferenceError | `src/server/api.ts` 及其他「提前 return + 下方函数声明」的工厂 | 2026-11-04 #48 实现期；修复见同分支提交 |
| 测试里 `await client.close(); await transport.terminateSession()` 之后，服务端 `mcp_sessions` 仍是 `connected`（成员一直 online） | MCP SDK `StreamableHTTPClientTransport.close()` 会 `abortController.abort()`；随后 `terminateSession()` 里的 DELETE fetch 用的正是这个**已 abort 的 signal**，DELETE 根本没到服务端，`onclose→core.disconnect()` 不触发 | 必须**先** `await transport.terminateSession()` 发 DELETE（触发服务端 onclose / 会话断开 / 运行状态回落 offline），**再** `await client.close()`。仅 `client.close()` 的既有清理顺序不适用于「要验证断开态」的用例 | 所有用 `StreamableHTTPClientTransport` 验证「断开/离线」的测试；仅做收尾清理时顺序无所谓 | 2026-11-05 #50 LIFE-MEM-03 用例调试；SDK `dist/esm/client/streamableHttp.js` `close()` / `terminateSession()` |
| `dbDriver=postgres` 上 `wait_for_messages` 漏投消息（AC-CORE-05/04 失败、`status=undefined`），服务端报 `error: LIMIT must not be negative`（SQLSTATE `2201W`）；同一代码在 SQLite 下全通过 | SQLite 把 `LIMIT -1` 解释为「不限」，PostgreSQL 拒绝负数 LIMIT；`repositories.listByGroup` 原以 `limit ?? -1` 拼 `LIMIT ?`，PG 上直接抛错 | 双方言共用的分页查询在 `limit<=0` 时**省略 LIMIT 子句**，不要传负数；PG 运行态异常先看 SQLSTATE / 错误码，别只怀疑唤醒竞态 | 所有经 `DbDriver` 双方言执行的 `LIMIT` / `OFFSET` 查询 | 2026-11-06 #61 真实 PG 复现与修复；`src/server/db/repositories.ts` `listByGroup`；PR #75 的 `fix(#61)` 提交 |
| feature 分支 HEAD 上 `npm test` / `tsc` 全绿，合并到 `main` 后同一套命令立刻变成 2 个测试失败 + 5 个 tsc 错误 | `main` 在分支分叉后由 `c345f3a` 新增了 `tests/host-adapter-converge.test.ts` 的 AC-HOST-01/04 用例，按旧同步 API 编写；#61 把 `core.join` / `attemptInterrupt` / `close` / `ctx.spawn` 改为 async，Git 文本合并无冲突但语义不兼容（未 `await`） | 验收不能只在 feature 分支做；**合并后必须在合并后的 `main` 树复跑** `tsc` / `npm test` / e2e 才能宣布通过；凡改动公共 API 签名（尤其 sync→async），把分叉点之后 `main` 的改动视为集成风险 | 所有改动公共 API 签名的票；长期分支与 `main` 并行演进时 | 2026-11-06 PR #75 合并（`a7081d8`）后复验、PR #76（`9d75ea8`）修复；#61 更正评论 |

## 待验证

> 记录影响实现选择、尚未实测的技术假设；产品需求层面的待定项见 `docs/architecture/agent-studio.md` §10.2。

| 假设 / 问题 | 影响 | 验证方法 | 状态 |
| --- | --- | --- | --- |
| Codex CLI 的等待/打断/重连行为是否与 Claude Code 一致 | 决定能否对 Codex 承诺「安全点投递」和等待循环 | Codex 配额恢复后（约 2026-10-27）重跑 | 已验证（2026-11-03，0.166.0）：等待活唤醒与重连补投与 Claude 一致；打断同为 `unsupported` |
| Claude Code `MCP_TOOL_TIMEOUT` / `MCP_TOOL_IDLE_TIMEOUT` 的默认值 | 决定单次等待时长上限的保守取值 | 显式设置环境变量做对照实验 | 待验证 |
| 宿主被强制杀死（非优雅退出）后的 MCP 会话回收时延 | 决定服务端会话清理超时 | 杀进程后轮询服务端会话表 | 待验证 |

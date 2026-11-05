# F2：统一权限守卫 `authorize`

状态：已确认
日期：2026-11-04
来源：ticket #47（父 spec #45 阶段 2；需求 GUARD-01；验收 AC-PERM-01、AC-PROJ-GUARD-01）；决策票 #25（角色）、#26（守卫）、#37（隔离强制点）、#32（子树可见性）

本文只写守卫的**契约与边界**：能力点、拒绝语义、接入点位、以及留给 T2（#49）的对接接口。逐条 ticket 状态见 GitHub Issues。

## 1. 定位

`src/server/authz/authorize.ts` 是服务端唯一的权限判定入口。HTTP（`src/server/api.ts`）、MCP（`src/server/mcp/core.ts`）、WebSocket（`src/server/ws.ts`）三类入口在各自的点位调用它，**不再自行比较角色或群组归属**（GUARD-01）。

守卫是纯函数：不读数据库、不依赖连接与运行时对象、不抛「未授权」以外的异常、不改动入参。判定所需的组织与参与关系由调用方注入纯数据（`Actor` + `GuardScope`），因此权限矩阵可以先于 `org_nodes` / `members` 业务表落地——这正是本基础票的意义：后续纵向切片票（T1–T6）不必各自实现权限。

强制点收敛在两处（#37）：

1. `authorize` —— 服务端守卫，回答「允许 / 拒绝」；
2. `ConnScope` / `visibleGroups` —— conn-scoped 查询约束，回答「允许之后还能查哪些行」。

不依赖 agent 自律，也不依赖前端隐藏按钮。

## 2. 角色与管辖范围

角色是**静态枚举**（决策票 #25，不引入动态 RBAC）：

| 角色 | 对应 spec #45 §3 | 默认管辖范围（`reach`） |
| --- | --- | --- |
| `owner` | 人：创建项目、撤销/审计关键操作、二次确认永久删除 | `project`（可为全局主体） |
| `top_manager` | 顶层 manager：管理全项目、可见全部群组、增删/暂停成员 | `project` |
| `sub_manager` | 下级 manager：管理其子树；子树内全员属该子树的群组只读可见 | `subtree` |
| `member` | 普通成员：只在参与的群组发言，只更新自己的状态/任务/记忆 | `own` |

`reach` 三值：`project`（全项目）、`subtree`（仅本岗位子树，权限随子树边界——ORG-05）、`own`（仅自己，ORG-06）。岗位＝角色在某个组织节点上的实例，由 `Actor.nodeId` + `Actor.subtreeNodeIds` 表达；本票不建表，`subtreeNodeIds` 由注入的静态数据给出，T2 改为 org_nodes 递归 CTE 的结果。

阶段 1 的项目级 `members.role`（`manager` / `normal`）按 `src/server/authz/actors.ts` 映射，不做数据迁移：

- `kind = human` → `owner`
- `kind = agent` 且 `role = manager` → `top_manager`
- `kind = agent` 且 `role = normal`（或缺省）→ `member`

## 3. 能力点与边界

能力点是权限矩阵的授权单位（`Capability`），名称是稳定契约；**新增能力点只改 `authorize.ts` 的两张表**（`CAPABILITY_BOUNDARY` 与 `ROLE_CAPABILITIES`）。放行 = 「角色持有该能力点」且「目标资源落在边界内」两件事同时成立。

能力点全集与角色授予以 `ROLE_CAPABILITIES` 为准（下表与它一一对应，2026-11-04 校对）。

| 能力点 | 边界 | owner | top_manager | sub_manager | member | 需求出处 |
| --- | --- | --- | --- | --- | --- | --- |
| `project:create` | project | ✓ | | | | PROJECT-01 |
| `project:view` | project | ✓ | ✓ | ✓ | ✓ | §6.1 |
| `project:archive` | project | ✓ | ✓ | | | PROJECT-03 |
| `project:purge`（永久删除） | project | ✓ | | | | LIFE-ARC-01（manager 不能永久删除） |
| `overview:view`（跨项目/项目清单） | project | ✓ | ✓ | | | OVERVIEW-01 |
| `org:manage`（组织与汇报线） | subtree | ✓ | ✓ | ✓ 限子树 | | ORG-04 / ORG-05 |
| `member:manage`（增删/暂停成员） | subtree | ✓ | ✓ | ✓ 限子树 | | ORG-07 |
| `member:view`（项目花名册） | project | ✓ | ✓ | ✓ | | GROUP-02 |
| `status:view`（状态看板读数） | project | ✓ | ✓ | ✓ | | STATUS-01（行级子树收窄交 T4） |
| `group:create` | subtree | ✓ | ✓ | ✓ 限子树 | | GROUP-03 |
| `group:archive` | subtree | ✓ | ✓ | ✓ 限子树 | | GROUP-04 |
| `group:purge`（永久删除） | project | ✓ | | | | GROUP-04 / LIFE-ARC-01 |
| `group:view` | visibility | ✓ 全部 | ✓ 全部 | ✓ 参与＋子树 | ✓ 仅参与 | ORG-03 / AC-IDENT-01 |
| `group:view_subtree` | visibility | ✓ | ✓ | ✓ 只读 | | ORG-03 / #32 |
| `group:post`（发言） | participation | 需参与 | 需参与 | 需参与 | 需参与 | CHAT-01 |
| `message:ack`（确认投递） | participation | ✓ | ✓ | ✓ | ✓ | AC-CORE 投递 |
| `status:report_own` / `task:update_own` / `memory:write_own` / `interrupt:self` / `session:heartbeat` | self | ✓ | ✓ | ✓ | ✓ | ORG-06 / STATUS / T6 |

边界语义：

- **project**：同项目即通过（跨项目一律拒绝，NFR-PROJ-01）。
- **subtree**：目标节点必须落在 `subtreeNodeIds`；群组的参与者节点必须全部落在子树内（ORG-05 不越级）。`reach = project` 视为天然满足；`reach = own` 按「自己所在的那一个节点」处理。
- **participation**：主体必须在 `groupMemberIds` 里。写路径一律走这条，所以**子树只读可见性不会被扩成发言权**。
- **visibility**：`reach = project` 全部可见；否则「自己参与的」∪「（持有 `group:view_subtree` 且）参与者全部属于本子树的」。看不到的群组在结果里不出现，不泄漏其存在。
- **self**：`scope.memberId` 必须等于主体自身。
- **fail-closed**：未知角色、未知能力点、边界数据缺失、主体无法解析 → 拒绝。

端点级与行级的分工：`authorize` 在端点上校验能力点（未点名具体资源时不带 `groupId` / 参与者数据即跳过行级范围判定）；「我能看到哪些群组/成员」由 `visibleGroups(actor, groups)` 逐行判定，返回 `{ id, writable }`，`writable = false` 即 spec 的只读可见性（看元数据与历史、不唤醒、不能发消息）。T2/T4 复用同一函数，或直接用允许判定返回的 `ConnScope.nodeIds` / `groupIds` 生成 SQL 约束。

## 4. 拒绝语义与错误码

拒绝码（`DenyCode`）是稳定字符串，入口按各自协议映射；语义与状态码集中在这里，调用点不再自造。

| 拒绝码 | 含义 | HTTP | MCP | WebSocket |
| --- | --- | --- | --- | --- |
| `forbidden` | 角色没有该能力点（含主体无法解析） | 403 `{error:{code:"forbidden"}}` | `FORBIDDEN` | `error` 帧 `code:"forbidden"` |
| `cross_project` | 目标不在主体所属项目（agent 主体未绑定项目亦此码） | 403 | `FORBIDDEN` | 同上 |
| `out_of_subtree` | 目标节点/参与者越出岗位子树 | 403 | `FORBIDDEN` | 同上 |
| `not_a_member` | 主体不是目标群组参与者 | 403 | `FORBIDDEN` | 同上 |
| `not_visible` | 群组不在主体可见范围 | 403 | `FORBIDDEN` | 同上 |
| `not_self` | 试图操作他人的状态/任务/记忆 | 403 | `FORBIDDEN` | 同上 |
| `out_of_connection` | 越出本连接被绑定的项目/群组 | 403 | `FORBIDDEN` | 同上 |
| `unknown_action` | 未知能力点（调用方编程错误） | 400 | `INTERNAL` | — |

MCP 侧沿用契约里的 `FORBIDDEN` 码不变，并在 `details` 附 `{ deny, capability }`；WS 侧 `error.code` 固定 `forbidden`，具体拒绝码放 `deny` 字段。阶段 1 的既有拒绝（跨群组发/读消息、上报他人状态）因此**错误码与文案都不变**，只是判定来源换成了统一守卫。

撤销权（人高于 manager，ORG-04 / AUDIT-02）在矩阵里表现为：只有 `owner` 持有 `project:purge`、`group:purge`；`overview:view`、`org:manage` 等按角色分层。审计写入与撤销动作本身属 T5（#52），本票只给出能力点与判定入口。

## 5. 接入点位清单

HTTP（`src/server/api.ts`，守卫一律排在参数与引用校验之后，保持既有 400/404 语义）：

| 路由 | 能力点 |
| --- | --- |
| `POST /api/projects` | `project:create` |
| `GET /api/projects` | `overview:view` |
| `GET /api/projects/:id` | `project:view` |
| `POST /api/projects/:id/members`、`DELETE …/members/:memberId` | `member:manage` |
| `POST …/members/:memberId/disable`、`POST …/members/:memberId/enable`、`PUT …/members/:memberId/lifecycle`（T3 #50） | `member:manage`（subtree 边界取目标成员的 `node_id`） |
| `GET /api/projects/:id/members` | `member:view` |
| `GET …/members/:memberId/status`、`GET …/member-statuses` | `status:view` |
| `PUT /api/projects/:id/manager` | `org:manage` |
| `POST /api/projects/:id/groups` | `group:create` |
| `GET /api/projects/:id/groups`、`GET /api/groups/:id/participants`、`GET /api/groups/:id/messages` | `group:view` |
| `POST /api/groups/:id/messages` | `group:post`（以 `senderMemberId` 为主体） |

MCP（`src/server/mcp/core.ts`，拒绝时 `FORBIDDEN` + `details.deny`）：

| 工具 | 能力点 | 说明 |
| --- | --- | --- |
| `send_message` | `group:post` | conn 作用域 = 会话绑定的群组 |
| `read_history` | `group:view` | 同上；阶段 1 只允许读本群历史 |
| `acknowledge_message` | `message:ack` | 群组归属由守卫判定，消息可见性仍由 T3 路由 |
| `report_status` | `status:report_own` | self 边界 + 项目上下文由 conn 判定 |
| `attempt_interrupt` | `interrupt:self` | 只作用于自己的会话 |
| `heartbeat` | `session:heartbeat` | self |

`join` 不设守卫：它是身份注册与连接建立（AGENTS.md「身份注册、连接心跳、工作状态、任务状态分开建模」），此时还不存在可鉴权的会话主体；入群之后的每个动作都过守卫。`wait_for_messages` 的取数范围由 T3 的路由可见性（`resolveWakeAndVisibility` + `deliveries`）决定，其输入 roster 只含该群组参与者——与守卫同源，本票不重复实现，也不改动投递语义。

WebSocket（`src/server/ws.ts`）：`presence` 帧是「在该项目里在线」的写入，按 `status:view` 鉴权；被拒时回 `error` 帧且不记录 presence。看板广播本身沿用「按声明项目过滤接收者」的既有 conn 范围约束，行级收窄由 T4 用 `visibleGroups` / `ConnScope` 完成。

## 6. 阶段 1 行为不变

V1 仍是 localhost / 单用户 / 无认证（spec #45 §5.3 假设 2）。三个入口的主体解析在不注入时都返回「人（owner）」，owner 持有全部能力点，因此既有链路的行为不变，由阶段 1 全量用例回归（`npm test`）。这不是把权限关掉，而是把「默认主体」明确写在一处，避免各入口自行判断。

## 7. 留给后续票的对接接口

| 注入点 | 位置 | 用途 |
| --- | --- | --- |
| `T1ApiOptions.resolveActor(resolution)` | `src/server/api.ts` | 认证主体 / 以某成员为主体；#48 起 `guard()` 把主体与判定一并返回给列表端点做行级收窄 |
| `McpCoreOptions.authz.actorFor(binding)` | `src/server/mcp/core.ts` | 会话 → 带岗位节点与子树的 Actor |
| `WebSocketHubOptions.resolveActor({projectId, memberId})` | `src/server/ws.ts` | 连接主体 |
| `StartServerOptions.authorization` | `src/server/server.ts` | 装配上述三个解析点的统一入口 |
| `Actor.nodeId` / `subtreeNodeIds` / `reach` | `src/server/authz/authorize.ts` | T2 由 `org_nodes` 递归 CTE 填充，守卫与调用点无需再改 |
| `GuardScope.groupMemberNodeIds`、`GuardedGroup.memberNodeIds` | 同上 | T2 由 `members.node_id` + `group_participants` 组装 |
| `visibleGroups(actor, groups)` | 同上 | **T1 #48 已接入** `GET /api/projects/:id/groups`（只返回主体可见的群组，不可见者不出现）；T2/T4/T6 继续复用同一函数 |

T2（#49）需要新增角色或能力点时，只改 `authorize.ts` 的两张表并补对应单测；不要在入口里写 `if (role === ...)`。

## 8. 验证

```bash
npm test            # 全量 248 用例；含阶段 1 回归（默认人=owner 行为不变）
npm run typecheck   # tsc + vue-tsc
node --test tests/authorize-guard.test.ts tests/authorize-actors.test.ts \
            tests/authorize-mcp.test.ts tests/authorize-callsites.test.ts   # 守卫本体 41 用例
```

阶段 1 端到端脚本（真实 HTTP + MCP Streamable HTTP 链路）在守卫接入后复跑通过：`npm run build:web && node scripts/e2e-phase1.mjs` → AC-CORE-01/02/03/04/05/06/07/08/09/11 全 PASS（29 通过 / 0 失败），即「默认人=owner 放行、既有行为不变」得到链路级证据。该脚本的既有说明仍适用：AC-CORE-02/10/11 的真实 Codex 宿主部分不由本脚本伪造。

守卫单测覆盖三类路径（AC-PROJ-GUARD-01）：正常放行、越权拒绝（含 fail-closed）、子树边界（含只读可见性不扩成写权限）；接入点位另见 `tests/authorize-mcp.test.ts`（MCP 工具边界）与 `tests/authorize-callsites.test.ts`（HTTP 403 / WS 拒绝帧）。未实测项：本票不涉及宿主能力，无需宿主侧验证记录。

## 9. 不包含

- `org_nodes` / `members` 等业务表结构与迁移（T2 #49）；角色配置 UI（T2 #49）。
- 审计写入与撤销动作（T5 #52）；本票只给 `audit` 之外的能力点判定入口与拒绝语义。
- 认证、会话签发、多用户账号（V1 不含，spec #45 §5.2）。

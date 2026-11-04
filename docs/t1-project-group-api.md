# T1：项目 / 群组创建、顶层 manager 指定与生命周期

状态：已实现（T1 #14 创建与 manager；T1 #48 生命周期与隔离）
日期：2026-10-22（#14）；2026-11-04（#48）
来源：子 spec #2 §6.2、§6.9、§8.2；决策 D2 #5；ticket #14。
阶段 2 来源：子 spec #45 §6.1、§6.4、§8；ticket #48（PROJECT-01..03、GROUP-01..04、LIFE-ARC-01/02）。

本文说明 T1 交付的 HTTP API 契约与 WebUI 页面。#14 的范围是「人在 WebUI 中管理已存在的成员」：
创建项目、创建群组、添加/移除项目成员、指定/更换顶层 manager、查看成员与群组参与者。
#48 在其上补同一批资源的**生命周期与隔离**：归档 / 恢复、永久删除（人二次确认 + 级联清除）、
一项目多群组与参与者约束、跨项目数据隔离与按主体的行级收窄。
**真实 agent 成员的入群由 MCP 产生**——本文两票都不引入占位 agent 数据；#48 也不改 MCP 工具契约，
只在 repository 写入边界上让 MCP 与 HTTP 共享「归档拒写」这同一条规则。

## 1. HTTP API

- 全部端点挂在 `/api` 下，仅 `127.0.0.1`、无认证（CONFIG-02）。
- 请求/响应为 JSON；空响应为 `204 No Content`。
- 稳定 ID 复用 F2 的 `newId()`（UUIDv7 → 26 位 Crockford Base32）。
- 校验与持久化复用 F2 repository（`src/server/db/repositories.ts`），不重复实现唯一 manager 约束。

### 1.1 错误格式

所有业务错误返回统一 JSON：

```json
{ "error": { "code": "<code>", "message": "<面向用户的可读说明>" } }
```

`code` 与 F2 repository 错误码一致，HTTP 状态映射：

| code | HTTP | 场景 |
| --- | --- | --- |
| `invalid_argument` | 400 | 名称为空、kind/role 非法、请求体非对象等语义校验失败 |
| `invalid_reference` | 400 | 跨项目引用（如群组参与者不是项目成员）、引用不存在的成员 |
| `not_found` | 404 | 项目 / 群组 / 成员不存在 |
| `conflict` | 409 | 其他唯一约束冲突（注意：正常更换 manager 走 200，不再返回 409） |
| `archived` | 409 | 目标项目/群组已归档，写路径拒绝（#48：恢复后放行；由 repository 写入边界统一判定） |
| `confirmation_required` | 409 | 永久删除缺少二次确认凭据（#48：响应体带 `confirmation` 级联清单与一次性 `token`） |
| `invalid_confirmation` | 400 | 永久删除的确认凭据无效或已过期（#48：需重新发起获取最新清单） |
| `write_failed` | 500 | 底层写入失败（已回滚） |
| `invalid_json` / `payload_too_large` | 400 / 413 | 请求体非法 / 过大 |
| `method_not_allowed` | 405 | 路径存在但方法不支持 |

### 1.2 端点

| 方法 | 路径 | 入参（JSON 体） | 成功响应 | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects` | `{ name: string }` | `201 { project }` | 创建项目；**manager 可留空**，返回 `manager: null`。名称不要求唯一。PROJECT-02 的「创建时指定」在**同一创建流程内**由 `PUT /manager` 完成——项目成员必须先于岗位存在，创建请求里没有可引用的成员。 |
| `GET` | `/api/projects` | — | `200 { projects: Project[] }` | 列出项目（缺省不含已归档）。人/顶层 manager 的跨项目清单；绑定在某项目的主体只看得到该项目（#48 行级收窄）。 |
| `GET` | `/api/projects/:id` | — | `200 { project }` | 单个项目（含 `manager`）。 |
| `POST` | `/api/projects/:id/members` | `{ kind: "human"\|"agent", displayName: string, agentId?: string, role?: "manager"\|"normal" }` | `201 { member }` | 添加项目成员。`kind=human` 不绑 agent；`kind=agent` 需已存在的 `agentId`（T2 产生）。缺省 `role=normal`。 |
| `GET` | `/api/projects/:id/members` | — | `200 { members: Member[] }` | 列出项目成员。 |
| `DELETE` | `/api/projects/:id/members/:memberId` | — | `204` | 移除项目成员（连同其群组参与者关系级联删除）。 |
| `PUT` | `/api/projects/:id/manager` | `{ memberId: string }` | `200 { project }` | **指定或更换**顶层 manager。无 manager 时指定；已有 manager A 时指定另一成员 B 会在**同一事务内**把 A 降为 `normal`、B 升为 `manager`（始终保持最多一个 manager）。同一成员重复 PUT 幂等 200。 |
| `POST` | `/api/projects/:id/groups` | `{ name: string, participantMemberIds?: string[] }` | `201 { group }` | 创建群组；初始参与者必须都是该项目成员（GROUP-02），越界返回 `invalid_reference`。 |
| `GET` | `/api/projects/:id/groups` | — | `200 { groups: Group[] }` | 列出项目的群组（缺省不含已归档；按主体可见性逐行收窄）。 |
| `GET` | `/api/groups/:id/participants` | — | `200 { participants: Member[] }` | 列出群组参与者（展开为成员对象）。 |
| `POST` | `/api/projects/:id/archive` | — | `200 { project }` | **归档项目**（#48 PROJECT-03 / LIFE-ARC-01）。可恢复、不删数据；已归档时幂等 200。 |
| `POST` | `/api/projects/:id/restore` | — | `200 { project }` | **恢复项目**（同一能力点 `project:archive`）。`archivedAt` 置回 null。 |
| `DELETE` | `/api/projects/:id` | `{ confirm?: string }` | `409 confirmation_required` 或 `204` | **永久删除项目**（#48 PROJECT-03 / LIFE-ARC-02）。不带 `confirm` 只返回级联清单与一次性凭据；带同一 `confirm` 才在单事务内级联清除。 |
| `GET` | `/api/groups/:id` | — | `200 { group }` | 单个群组（含 `archivedAt`）。 |
| `POST` | `/api/groups/:id/archive` | — | `200 { group }` | **归档群组**（#48 GROUP-04）。 |
| `POST` | `/api/groups/:id/restore` | — | `200 { group }` | **恢复群组**。 |
| `DELETE` | `/api/groups/:id` | `{ confirm?: string }` | `409 confirmation_required` 或 `204` | **永久删除群组**：只清群聊消息/投递与参与者关系（外加随群组消失的会话记录），**项目成员保留**（LIFE-ARC-02）。 |
| `GET` | `/api/projects/:id/groups?includeArchived=true` | — | `200 { groups }` | 连已归档群组一起列出；缺省只列未归档（#48）。`/api/projects?includeArchived=true` 同理。 |

### 1.3 对象形状

```ts
Project = { id, name, createdAt, updatedAt, archivedAt: string|null, manager: Member | null }
Member  = { id, projectId, agentId: string|null, kind: "human"|"agent", displayName, role: "manager"|"normal", createdAt, updatedAt }
Group   = { id, projectId, name, createdAt, updatedAt, archivedAt: string|null }
```

`archivedAt`（#48）：ISO 字符串 = 已归档；`null` = 未归档。归档是**可恢复的非活跃态**，
永久删除才是清除数据。

### 1.4 关键约束

- **D2 每项目最多一个顶层 manager**：由数据库部分唯一索引 `ux_members_project_manager` 强制。
  API 的 `PUT /manager` 支持**更换**：已有 manager 时在事务内先降旧、再升新（顺序保证任一时刻不出现两个 manager），
  因此正常「更换 manager」返回 200，不触发 409。
- **GROUP-02 参与者只能来自项目成员**：由 repository 的 `groups.create` / `addParticipant` 校验。
- 阶段 1 只验收一个项目/一个群组，但数据按 project/group 作用域建模，便于阶段 2 扩展。

### 1.5 生命周期与隔离（#48）

**归档（PROJECT-03 / GROUP-04 / LIFE-ARC-01）**

- 实现：`projects.archived_at` / `groups.archived_at`（迁移 v3，`NULL` = 未归档）；恢复只把该列置回 `NULL`。
- 列表默认只返回未归档对象，`?includeArchived=true` 连归档一起返回；归档对象仍可按 ID 定位与读取历史。
- **写路径在 repository 这一唯一写入边界拒绝**（HTTP 与 MCP 共享同一规则）：
  归档项目内不能建群组/加成员/改成员；归档群组或其项目归档时不能发消息。错误码 `archived`（409）。
- 主体边界：`project:archive` / `group:archive` 由人（owner）与 manager 持有；
  **永久删除只有人能做**（`project:purge` / `group:purge` 不在 manager 能力集内 → 403 `forbidden`），
  顶层 manager 可归档但不能删除（LIFE-ARC-01）。

**永久删除与二次确认（PROJECT-03 / GROUP-04 / LIFE-ARC-02）**

- 流程：第一刀 `DELETE` 不删数据，返回 `409 { error.code: "confirmation_required", confirmation }`，
  其中 `confirmation.cascade` 是「会被清掉什么」的计数清单、`confirmation.token` 是一次性确认凭据
  （进程内有效 5 分钟，服务重启后失效需重新发起）；第二刀带 `{ "confirm": "<token>" }` 才执行。
  凭据不符 → `400 invalid_confirmation`；凭据只在成功执行时被消费，失败重试仍可用同一凭据。
- 级联范围（单事务内显式「子 → 父」删除，不只依赖外键级联）：
  - **项目**：群组、群聊消息、投递记录、参与者关系、成员、成员状态、MCP 会话记录，最后删项目本身。
    全局 `agents` 身份**不删**（同一 agent 可在其他项目继续任职，AC-IDENT-01）。
  - **群组**：该群组的消息与投递、参与者关系、随群组消失的 MCP 会话记录。**成员本身与其所在其他群组不动。**
  - 任务与评论（阶段 3）、三层记忆（阶段 4）尚未建表；落库后按同一清单形状补进 `cascade`，
    删除顺序与本表一致（此为当前实现的边界，未验证的行为不写成已完成）。

**跨项目隔离（PROJECT-01 / NFR-PROJ-01 / 决策票 #37）**

- 强制点：`authorize` 守卫 + conn-scoped 行级收窄，不依赖调用方自律。
  - `GET /api/projects`：绑定在某项目的主体（agent 成员）只看得到自己那个项目（取守卫判定里的 `conn.projectId`）；
    阶段 1 的人是不绑项目的全局主体 → 仍看到全部，既有行为不变。
  - `GET /api/projects/:id/groups`：用守卫的 `visibleGroups` 逐行收窄——只返回主体参与的群组
    （或全项目岗位看到的全部）；不可见的群组**不出现**，不泄漏其存在。
  - 越出所属项目：`403 cross_project`；同项目内未参与的群组读历史：`403 not_visible`（AC-IDENT-01）。
- 同一 agent 参与两个项目：全局身份（`agents`，按 `display_name + host_type` 唯一）相同，
  项目内成员岗位（`members`）各自独立；MCP 会话只绑定入群时的项目/群组，跨项目发言被
  `out_of_connection` 挡住。

## 2. WebUI 页面

- 路由：`/projects` 为「项目与群组」工作台（`src/web/src/views/ProjectsView.vue`）。
  `/groups`、`/members` 在阶段 1 重定向到 `/projects`（群组在项目页内创建与展示）。
- 导航：顶部导航简化为「概览 / 项目与群组 / 设置」。
- 页面能力：
  - 创建项目（输入名称 → 创建）；项目以标签页切换。
  - 项目详情显示顶层 manager（未指定时显示「未指定」）。
  - 成员区：添加人成员、移除成员、对任一非 manager 成员点「设为 manager」（已有 manager 时即更换）。
  - 群组区：输入群组名、用复选框从**项目成员**中选择参与者、创建群组；列出现有群组及其参与者。
  - 基础错误提示：接口错误以红色文本显示；成功反馈（含更换 manager）以绿色文本显示。
  - **生命周期（#48）**：项目面板与每个群组行提供「归档 / 恢复 / 永久删除」；
    「显示已归档」开关切换列表范围；点「永久删除」先取级联清单并在页面内显示确认面板
    （列出将被清除的群组/成员/消息等计数与凭据到期时间），人点「确认永久删除」才执行，「取消」不删。
- 前端 API 客户端：`src/web/src/api/client.ts`（与 §1 契约一一对应）。

## 3. 测试与验证

- `tests/projects-api.test.ts`：HTTP API 契约（创建项目/成员/群组、manager 首次指定/更换/幂等/非成员被拒、
  GROUP-02 越界、重启保留）。
- `tests/webui-e2e.test.ts`：WebUI 轻量 E2E——构建产物含关键 UI 文案（含 #48 的归档/永久删除按钮文案）、
  `/projects` 深链可加载、表单所用同一组 HTTP 接口走通完整流程。**非浏览器 Playwright 交互**（见文件头说明覆盖边界）。
- `tests/project-lifecycle.test.ts`（#48，seam = 项目/群组生命周期 API + 数据隔离边界）：
  项目与群组的归档/恢复与列表可见性；归档态写路径拒绝；项目/群组永久删除的二次确认、
  凭据校验与级联清除（含重启后仍为已删除）；主体边界（manager 可归档不可永久删除）；
  跨项目隔离与按主体收窄（含普通成员 `cross_project` / `not_visible`）；
  一项目多群组的聊天室序号与历史独立、同成员参与多群组；
  同一 agent 跨项目的独立岗位与群聊不泄漏（真实 MCP Streamable HTTP 工具边界）；
  每项目独立顶层 manager。

## 4. 不做 / 边界

- Agent 通过 MCP 入群与在线（T2 #15）；群聊与消息（T3）；状态看板（T4）。
- 组织树、下级 manager 的子树范围、完整角色配置（T2 #49）；成员状态机（T3 #50）；审计写入（T5 #52）。
- 本票（#48）已交付：多项目隔离、归档/恢复、永久删除二次确认与级联清除、一项目多群组与参与者约束。
- 群组参与者的**事后增删端点**未提供（票面只要求创建时从项目成员中选、同成员可参与多群组）；
  `groups.addParticipant` / `removeParticipant` 已在 repository 层可用，补端点时按 GROUP-02 复用即可。
- 「清除 manager（回到留空）」的独立操作未提供；当前通过直接把另一成员指定为 manager 完成更换。

# T1：项目 / 群组创建与顶层 manager 指定

状态：已实现（T1 #14）
日期：2026-10-22
来源：子 spec #2 §6.2、§6.9、§8.2；决策 D2 #5；ticket #14。

本文说明 T1 交付的 HTTP API 契约与 WebUI 页面。范围严格限定为「人在 WebUI 中管理已存在的成员」：
创建项目、创建群组、添加/移除项目成员、指定/更换顶层 manager、查看成员与群组参与者。
**真实 agent 成员的入群由 T2（MCP）产生**——本票不引入任何占位 agent 数据，也不改 MCP 工具契约。

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
| `conflict` | 409 | 重复指定 manager（D2：每项目最多一个顶层 manager） |
| `write_failed` | 500 | 底层写入失败（已回滚） |
| `invalid_json` / `payload_too_large` | 400 / 413 | 请求体非法 / 过大 |
| `method_not_allowed` | 405 | 路径存在但方法不支持 |

### 1.2 端点

| 方法 | 路径 | 入参（JSON 体） | 成功响应 | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects` | `{ name: string }` | `201 { project }` | 创建项目；**manager 可留空**，返回 `manager: null`。名称不要求唯一。 |
| `GET` | `/api/projects` | — | `200 { projects: Project[] }` | 列出全部项目（阶段 1 只验收单个，但接口是列表）。 |
| `GET` | `/api/projects/:id` | — | `200 { project }` | 单个项目（含 `manager`）。 |
| `POST` | `/api/projects/:id/members` | `{ kind: "human"\|"agent", displayName: string, agentId?: string, role?: "manager"\|"normal" }` | `201 { member }` | 添加项目成员。`kind=human` 不绑 agent；`kind=agent` 需已存在的 `agentId`（T2 产生）。缺省 `role=normal`。 |
| `GET` | `/api/projects/:id/members` | — | `200 { members: Member[] }` | 列出项目成员。 |
| `DELETE` | `/api/projects/:id/members/:memberId` | — | `204` | 移除项目成员（连同其群组参与者关系级联删除）。 |
| `PUT` | `/api/projects/:id/manager` | `{ memberId: string }` | `200 { project }` | 指定顶层 manager。**重复指定另一成员返回 409 conflict**；重复指定同一成员幂等返回 200。 |
| `POST` | `/api/projects/:id/groups` | `{ name: string, participantMemberIds?: string[] }` | `201 { group }` | 创建群组；初始参与者必须都是该项目成员（GROUP-02），越界返回 `invalid_reference`。 |
| `GET` | `/api/projects/:id/groups` | — | `200 { groups: Group[] }` | 列出项目的群组。 |
| `GET` | `/api/groups/:id/participants` | — | `200 { participants: Member[] }` | 列出群组参与者（展开为成员对象）。 |

### 1.3 对象形状

```ts
Project = { id, name, createdAt, updatedAt, manager: Member | null }
Member  = { id, projectId, agentId: string|null, kind: "human"|"agent", displayName, role: "manager"|"normal", createdAt, updatedAt }
Group   = { id, projectId, name, createdAt, updatedAt }
```

### 1.4 关键约束

- **D2 每项目最多一个顶层 manager**：由数据库部分唯一索引 `ux_members_project_manager` 强制；
  API 在写入前先检查现有 manager，重复指定返回 409，不静默覆盖。
- **GROUP-02 参与者只能来自项目成员**：由 repository 的 `groups.create` / `addParticipant` 校验。
- 阶段 1 只验收一个项目/一个群组，但数据按 project/group 作用域建模，便于阶段 2 扩展。

## 2. WebUI 页面

- 路由：`/projects` 为「项目与群组」工作台（`src/web/src/views/ProjectsView.vue`）。
  `/groups`、`/members` 在阶段 1 重定向到 `/projects`（群组在项目页内创建与展示）。
- 导航：顶部导航简化为「概览 / 项目与群组 / 设置」。
- 页面能力：
  - 创建项目（输入名称 → 创建）；项目以标签页切换。
  - 项目详情显示顶层 manager（未指定时显示「未指定」）。
  - 成员区：添加人成员、移除成员、对任一非 manager 成员点「设为 manager」。
  - 群组区：输入群组名、用复选框从**项目成员**中选择参与者、创建群组；列出现有群组及其参与者。
  - 基础错误提示：接口错误（含 409 重复 manager）以红色文本显示；成功反馈以绿色文本显示。
- 前端 API 客户端：`src/web/src/api/client.ts`（与 §1 契约一一对应）。

## 3. 测试与验证

- `tests/projects-api.test.ts`：HTTP API 契约（创建项目/成员/群组、manager 指定与 409、GROUP-02 越界、
  重启保留）。
- `tests/webui-e2e.test.ts`：WebUI 轻量 E2E——构建产物含关键 UI 文案、`/projects` 深链可加载、
  表单所用同一组 HTTP 接口走通完整流程。**非浏览器 Playwright 交互**（见文件头说明覆盖边界）。

## 4. 不做 / 边界

- Agent 通过 MCP 入群与在线（T2）；群聊与消息（T3）；状态看板（T4）；多项目/多群组生命周期（阶段 2）。
- 组织树、下级 manager、完整权限矩阵、归档/删除（阶段 2/5）、审计视图。
- 更换 manager 的「先清除再指定」独立操作未提供（阶段 1 通过 409 明确拒绝重复指定；后续可按需补）。

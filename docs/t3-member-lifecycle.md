# T3：成员生命周期（状态机与守卫）

状态：已实现（ticket #50）
日期：2026-11-05
来源：子 spec #45 §6.3 / §6.4 / §8.1（LIFE-MEM-01..03、LIFE-ARC-01/02、AC-LIFE-01/02、ORG-07）；决策票 #27（成员生命周期）、#28（归档/删除）；ticket #50。
复用：F2 #47 `authorize` / `ForbiddenError` / `resolveActor`（`docs/f2-authorize-guard.md`）；T1 #48 归档错误码与 purge 二次确认（`docs/t1-project-group-api.md`）；T2 #49 `org` repository / `OrgChangeRecorder` 钩子（`docs/architecture/data-model.md` §1.5）；F1 #46 迁移机制。

本文说明 T3 交付的**成员状态机与守卫限制**。项目/群组的归档、恢复、永久删除二次确认与级联清除由 T1（#48）交付，本文**不重复造该流程**，只在成员相关部分复核并接入守卫。

## 1. 定位与范围

- **本期包含**：成员状态枚举 `active / disabled / pending`；可恢复、不物理删除的状态机；disable/re-enable；成员管理端点接入 F2 守卫（`member:manage` + subtree 边界）；守卫限制 manager 不能永久删除；LIFE-MEM-03（断连不删除成员）。
- **不包含**：组织树结构（T2 #49）、审计写入与撤销（T5 #52，**只留钩子**）、状态看板/跨项目概览（T4）、MCP 上下文注入（T6）、任务/评论/记忆表（阶段 3/4）。
- **与 T1 的分工**：归档/恢复/永久删除的**流程、二次确认凭据、级联清单**全部沿用 T1；T3 只验证「删群组保留成员及其状态、删项目清除成员」这一成员相关边界，不改动 T1 的删除代码路径。

## 2. 数据模型

`members.status`（迁移 v5 `member_lifecycle_status`，见 `docs/architecture/data-model.md` §1.6 / §4）：

- 静态枚举 `active / disabled / pending`，`NOT NULL DEFAULT 'active'` + CHECK 约束；`ix_members_project_status` 索引。
- **与 `member_statuses.state`（online/offline/waiting/working 运行状态）、`mcp_sessions`（连接/心跳状态）分开建模**：断连不删除成员、不改写本列（LIFE-MEM-03），在线/离线由连接/心跳表达。
- 老库（v4 → v5）只加列、默认 `active`、不回填业务数据，阶段 1 既有成员/入群链路行为不变（AC-CORE-* 由 `scripts/e2e-phase1.mjs` 回归）。
- `Member` 形状新增 `status` 字段；`GET /api/projects/:id/members`、`GET …/org` 的成员列表、`memberView`（含 `project.manager`、群组参与者）均带上该字段。

## 3. 状态机（唯一写入边界 `MembersRepository.setStatus`）

| 当前 \ 目标 | active | disabled | pending |
| --- | --- | --- | --- |
| `active` | 幂等 no-op | ✅ 暂停（disable） | ❌ `conflict` |
| `disabled` | ✅ 恢复（re-enable，恢复岗位） | 幂等 no-op | ❌ `conflict`（须先回 active） |
| `pending` | ✅ 激活（enable） | ✅ 暂停 | 幂等 no-op |

- `pending` 是**创建时**的「待激活」初态（登记成员但尚未正式在岗）；激活后不再回到 pending。
- 语义（LIFE-MEM-01/02）：`disable` 只改 `status` 与 `updated_at`；成员行、身份、角色、岗位(`node_id`)、群组参与、消息/投递历史、运行状态、连接状态**一行都不动**（保留历史与数据、不物理删除）。`re-enable` 回到 `active`，岗位与数据原样恢复生效——不清除/重建 `org_nodes`。
- 失败路径：未知状态 → `InvalidArgumentError`（400 `invalid_argument`）；非法转换 → `ConflictError`（409 `conflict`）；成员不存在 → `NotFoundError`（404）；归档项目 → `ArchivedError`（409 `archived`，复用 T1 归档写规则）；重复暂停/恢复 = 幂等 200（ORG-07 无需逐次确认）。
- 状态是持久化字段：重启后保留（`tests/member-lifecycle.test.ts` 重启用例）。

> 决策票 #27（移除 vs 暂停的精确语义：暂停是否让出岗位/群组）仍为「待决」，本实现按 spec #45 §6.3 的**已确认结论**取保守口径：暂停保留岗位与数据、恢复即回到原岗位有效态；不引入「暂停腾出组织节点、恢复重建」的额外行为，避免与 T2 组织树及阶段 1 兼容路径冲突。该取舍记入 ticket 上报的 `unresolved`。

## 4. HTTP API

全部端点挂在 `/api` 下（127.0.0.1、无认证），错误格式 `{ error: { code, message } }`；守卫一律排在参数/引用校验之后，保持既有 400/404/409/403 语义。

| 方法 | 路径 | 入参 | 成功 | 说明 |
| --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:id/members` | `{ kind, displayName, agentId?, role?, status? }` | `201 { member }` | T1 端点；T3 增可选 `status`（省略 = `active`，可登记为 `pending`）。守卫 `member:manage`。 |
| `POST` | `/api/projects/:id/members/:memberId/disable` | — | `200 { member }` | 暂停（→ disabled）。**无需二次确认**（与 T1 永久删除流程区分）。守卫 `member:manage` + subtree。 |
| `POST` | `/api/projects/:id/members/:memberId/enable` | — | `200 { member }` | 恢复 / 激活（→ active，恢复岗位）。同上。 |
| `PUT` | `/api/projects/:id/members/:memberId/lifecycle` | `{ status: "active"\|"disabled"\|"pending" }` | `200 { member }` | 通用状态转换；非法转换 409、未知状态 400。同上。 |

> 路径选择：已有 `GET /api/projects/:id/members/:memberId/status` 是 T2 的**在线/连接状态视图**（`connection`/`state`），为避免两种「status」语义混淆，通用生命周期转换放在 `/lifecycle`。

`Member` 视图形状（新增 `status`）：

```ts
Member = { id, projectId, agentId, kind, displayName, role, nodeId, status, createdAt, updatedAt }
```

## 5. 守卫（依赖 F2 / T1，不重复实现）

- 三个成员生命周期端点与 `POST /members` 都调用 `guard(..., "member:manage", { projectId, nodeId: 目标成员.nodeId })`：
  能力点来自 F2 `ROLE_CAPABILITIES`，`subtree` 边界由 F2 `checkSubtree` 判定（下级 manager 越出自己子树即 `out_of_subtree`；owner / top_manager 全项目放行）。
- **ORG-07**：顶层 manager 持有 `member:manage`，可添加/移除/暂停成员，无需逐次确认（暂停/恢复直接 200）。普通成员无该能力点 → 403 `forbidden`（fail-closed）。
- **AC-LIFE-01 / LIFE-ARC-01**：`project:purge` / `group:purge` 只有人（owner）持有；顶层 manager 可 `project:archive` / `group:archive`（归档可恢复）但发起永久删除连确认清单都拿不到（403，含 `project:purge` / `group:purge` 原因）。该能力矩阵与 T1 的二次确认流程均为既有实现，本票只做接入与复核，不重写。
- **AC-LIFE-02 / LIFE-ARC-02**（T1 级联，成员相关复核）：删群组只清该群组的群聊消息/投递/参与者关系/会话记录，`members` 与其 `status` 保留；删项目清除其 `members`（含状态）、`member_statuses`、`mcp_sessions`、`org_nodes`、群组与群聊。任务/评论（阶段 3）、三层记忆（阶段 4）尚未建表，按决策票 #28 的「阶段 2 级联边界」处理，落库后按同一清单形状补进——**当前不声称已覆盖**（见 §8）。

## 6. LIFE-MEM-03：断连不删除成员

- 连接断开（MCP 会话 `disconnected`、运行状态回落 `offline`）只发生在 `mcp_sessions` / `member_statuses` 两层，**不删除 `members` 行、不把生命周期状态改写成 disabled/pending**。
- 在线/离线通过连接与心跳状态表达（`GET …/members/:id/status` 的 `connection` / `state`），本票**不重复实现 T4 状态看板**，也不改动既有 `deriveEffectiveStatus` / roster / 唤醒路由。
- 真实 MCP 入群 → 断开（Streamable HTTP `terminateSession()` 发 DELETE 触发服务端 `onclose`）→ 花名册仍含该成员且 `status: active` 的链路用例见 `tests/member-lifecycle.test.ts`。

## 7. 审计钩子（只留钩子，不写 audit_log）

成员状态变更在 HTTP 入口调用 `OrgChangeRecorder.record`，action 为 `member.disable` / `member.enable` / `member.status_change`，`detail` 带 `{ from, to }`；缺省 `noopOrgChangeRecorder` 不产生任何写入。审计表与人的撤销动作属 T5 #52，注入真实 recorder 即可，无需改动守卫与 repository。

## 8. WebUI

`src/web/src/views/ProjectsView.vue` 成员区增加生命周期状态徽章（在岗 / 已暂停 / 待激活）与「暂停成员 / 恢复成员」按钮；`src/web/src/api/client.ts` 增加 `disableMember` / `enableMember` / `setMemberStatus`。状态徽章与右侧「连接 / 运行状态」分列，避免把在岗状态与在线状态混为一谈。

## 9. 测试与验证

- `tests/member-lifecycle.test.ts`（seam：**成员状态机 + 归档/删除守卫**）：
  - repository 段：枚举与默认 active、disable 保留历史/数据/岗位、re-enable 恢复岗位、合法转换表/幂等/非法转换拒绝、归档写规则、重启持久化；
  - HTTP 段：生命周期端点与错误码、pending 登记/激活、守卫（ORG-07 / AC-LIFE-01）、AC-LIFE-02 级联的成员相关部分、LIFE-MEM-03 真实 MCP 断连。
- `tests/schema.test.ts`：`EXPECTED_VERSION = 5`、v2→v5 / v3→v5 / v4→v5 升级、`status` 默认与 CHECK 约束。
- 全量：`npm test`（0 fail）、`npm run typecheck`、`npm run build:web && node scripts/e2e-phase1.mjs`（AC-CORE 全通过，阶段 1 不回归）。

## 10. 不做 / 边界

- 不引入组织树结构（T2）、审计写入（T5）、状态看板（T4）、MCP 上下文注入（T6）。
- 不改 T1 的归档/恢复/永久删除流程与级联清单，不改 MCP 工具契约与唤醒/投递路由。
- 决策票 #27 未决的「移除 vs 暂停」精确语义按 §3 保守口径实现；任务/评论/记忆的级联清除属阶段 3/4（决策票 #28），本期不补建表。

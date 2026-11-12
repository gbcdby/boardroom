# 角色库、稳定身份与旧配置只读来源

日期：2026-11-11。范围：[S2-T1 #134](https://github.com/gbcdby/boardroom/issues/134)，依据 [S2 #126](https://github.com/gbcdby/boardroom/issues/126) 的 `BR-COLLAB-DESIGN-20261111-D`。本文说明本票已实现的服务、HTTP 契约和 v14 数据边界；合并、远端 CI 与整体验收状态以票据记录为准。

## 1. 对象与权威来源

| 对象 | 当前持久来源 | 本票提供的操作 |
| --- | --- | --- |
| RoleTemplate | `role_templates` 当前修订头、`role_template_versions` 不可变版本 | 创建、复制、编辑、归档、恢复、版本读取和删除影响预览 |
| Agent | 既有 `agents.id` | 读取、显示名 CAS 改名、追加旧客户端别名 |
| 旧客户端身份 | `agent_legacy_aliases` 的 `(display_name, host_type) → agent_id` | 永久保留、冲突拒绝、只追加 |
| Profile 来源视图 | 既有 `agent_runtimes` 与 Agent 宿主类型 | 只读，标记 `authority: legacy`、`writable: false`、`migrated: false` |
| Binding 来源视图 | 既有 runtime binding、runner 与成员关联 | 完整配置/快照/意图/观察的只读检查 |
| 全局目录审计 | 既有 `audit_log` 的 `scope: user`、`project_id: NULL` | 与目录修改同事务写入、独立只读查询 |

旧 runtime 是当前唯一可写配置权威。这里没有新增可写 Profile、GroupBinding 或 Run 表，也没有迁移启动动作。新 Agent 完整配置页面、创建流程、技能安装/启用和调度由各自范围交付。外部接入 Agent 没有 runtime 时，Profile 来源返回 `mode: external`、`source: null`，不会生成可启动配置。

## 2. 职责模板与版本

RoleTemplate 使用稳定的 `roleTemplateId`。创建从 revision 1 开始；编辑、归档和恢复产生新的不可变版本，旧版本仍可按 ID 与修订号读取。修改请求携带 `expectedRevision`，过期基准返回 `409 / role_revision_conflict`，不能覆盖他人的编辑。相同归档状态的请求在基准仍匹配时幂等。

字段为 `name`、`purpose`、`instructions` 和 `recommendedSkillRefs`。名称最多 64 字符，职责描述最多 2,000 字符，指令最多 16,000 字符，推荐技能最多 64 项；不接受未知字段。推荐引用格式为：

```json
{
  "skillId": "skill-id",
  "version": "immutable-version-id",
  "contentDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

`version` 是不可变版本 ID 的公开字段，不是显示用 semver；`contentDigest` 是 64 位小写十六进制摘要。同一 skillId/version 不能重复。此处保存推荐元数据，不安装、运行或自动启用技能，也不以推荐引用代替后续技能存在性与执行授权检查。

职责名称和正文不参与 `ROLE_CAPABILITIES` 或组织岗位授权计算。将模板命名为 manager、owner 等不会提升权限，也不会改写 Member 的 role、岗位或生命周期。

复制操作锁定来源的当前修订并校验 `expectedRevision`，为副本生成新的稳定 ID 和 revision 1；`copiedFrom` 固定为来源 ID/修订，来源后续编辑不会改变副本。副本初态未归档。数据库复合外键保护该固定版本，复制来源 ID 与修订必须同时为空或同时非空。

删除影响包含当前 revision、将删除的全部版本、具体引用以及 `allowedActions`。当前实际引用消费者是其他模板版本的 `role-copy` 来源；尚未建立的 Profile/Binding 不伪造引用。只要任何历史版本仍引用该模板，删除返回 `role_template_in_use`，可选择归档。没有引用的模板可在确认后删除本体和版本，原审计保留。

HTTP 删除分两次：第一次 DELETE 提交 `expectedRevision`，返回 `409 / confirmation_required`、影响清单及五分钟有效的确认 token；第二次提交同一修订和 `confirm` token。事务内再次检查修订与引用，预览后出现新引用也会拒绝。token 保存在当前服务进程，重启后需重新预览。

## 3. 稳定 Agent 与旧 alias

`agents.id` 是持久身份。显示名可改，`(displayName, hostType)` 是旧客户端接入的永久 alias。v14 从所有现存 Agent 精确回填初始 alias，不重建 Agent、Member、消息或 runtime 身份。

改名请求使用 `expectedDisplayName` 做 CAS；成功后原 alias 保留，同时为新名称预留 alias。两个身份争用同一个 alias 时只有一个能成功，另一方完整回滚；不能合并身份、抢占旧 alias 或按相似名称猜测关联。追加 alias 同样保留原 agentId，且不会改写 Agent 的宿主类型。

旧 MCP `join` 仍提交原有 `displayName`、`hostType` 等字段。服务端先解析 alias，再按 agentId 查找项目成员。改名后的旧 alias 重连复用 Agent/Member ID，返回和会话使用当前 Agent 显示名；旧客户端的名称不会将新名称改回。已有成员的 role、岗位、移除状态及加入代际继续遵守原规则，自报 manager 不会修改权限。改名本身不批量重写历史作者、运行意图或成员事实。

低层 repository 保留原有“删除未被引用 Agent”的能力。删除时同事务为全部 alias 记录 `retired_at`，alias 和旧稳定 ID 都不能复用；通过旧 alias 再 join 返回 `CONFLICT / agent_identity_retired`。若 Agent 仍被 Member 等引用，删除失败并回滚退休标记。退休记录只描述已知删除，不是全局停用开关。

没有退休标记但目标 Agent 缺失、当前身份缺 alias，或 alias 对应另一个 Agent 时，返回 `migration_identity_ambiguous` 及具体原因；不能当作“未注册”静默创建新身份。未升级到 v14 的数据库仍使用旧名称/宿主查找，读预检标记 `aliasCatalogState: pre-migration`，不写回 alias。

解析入口不以数据库正常情况下的唯一约束代替导入数据校验：同一旧键存在多行时返回 `legacy_alias_duplicate`，预检保留所有冲突行的 Agent 引用。当前名称/宿主键与 alias 目标不一致、目标自身的当前 alias 缺失/损坏、目标的其他 alias 重复或占用了另一活 Agent 当前键，同样拒绝。旧 MCP 接入、repository 查找及改名/追加 alias 在各自入口直接检查，不要求用户先手动预检；失败不创建 Agent/Member，也不改名或合并。检查限定于涉及的身份与别名，其他完整身份继续可解析。

历史 `other → dsh` 转换先在同一事务检查全部目标 alias 冲突，再保留 other alias 并为同一 agentId 追加 dsh alias。任何冲突都回滚整批宿主/alias 变更，显示名保持当前值。示例数据的直接 Agent 插入也登记初始 alias。

## 4. 旧 Profile 与 Binding 的只读预检

`createLegacyConfigInspector` 在一次自己的数据库事务内捕获 Agent、runtime、binding、runner、reservation、Member、项目、群、参与关系和 alias。PostgreSQL 使用 `REPEATABLE READ READ ONLY`；SQLite 复用驱动事务的一致快照。调用方已持事务时返回 `legacy_inspection_requires_own_snapshot`，避免借用未知隔离级别。此操作会读取数据库，但不写业务行、消费意图或推进状态。

报告包含 `observedAt`、`sourceDigest`、问题及来源视图。sourceDigest 只对该次报告捕获的来源行计算，不能当作完整业务库备份摘要。每个问题附带实际 agentId、runtimeId、bindingId、memberId、projectId、groupId 或 alias 引用，便于定位损坏数据。

预检检查 runtime 到 Agent 的一对一关系、成员 Agent/项目、群所属项目、群参与关系、runtime reservation、runner 和 alias。合法的同一 runtime 跨项目/跨群 binding 保留为各自独立来源。孤立引用、身份错配及导入造成的一个 Agent 对应多个 runtime 返回 `migration_identity_ambiguous`；不会任选一个 runtime，也不会改写原数据来消除冲突。

Agent/runtime 公共来源的问题以固定集合传播给相关 binding。单个 binding 的损坏 JSON、快照或局部关联问题只进入该 binding 和报告汇总，不因 ID 排序污染同 runtime 的其他 binding，也不抹去仍有效的公共 Profile 来源。报告可以整体标记存在异常，同时保留健康 binding 的完整 view/effective 和可读快照。

Profile 来源保留 backend、configVersion、runtimeRevision 和完整非目录默认值。旧默认 workdir 单独标为 `legacyWorkdir`，不会提升为跨项目全局写入目录。Binding 则保留：

| 事实 | 输出位置与含义 |
| --- | --- |
| 完整有效配置及字段来源 | `view.effective` 与原 runtime resolver 返回的完整 `RuntimeBindingView` |
| 原始高级选择 | `raw.advancedJson` 与 `advanced.raw` |
| 当前高级策略及有效性 | `advanced.effectiveStrategy`、`validity`（not_selected / effective / invalidated_by_revision） |
| 当前启动意图 | 原 binding 的 desiredState、intentRevision、resetSessionRequested 和 requestedSnapshot |
| 实际 runner | 原 runner 的 applied、SID、session key、进程身份、owner/generation、状态和退出确认 |
| 三种配置来源 | `snapshots.requested`、`snapshots.applied`、`snapshots.effective` 各自独立的配置、目录、版本与摘要 |
| 损坏来源的原值 | `raw.runtimeRow`、`raw.bindingRow`、`raw.runnerRow` 及原始 JSON，即使无法构造有效 view 也保留 |

原高级选择可能仍存储在数据库，但因为 runtime 或 binding 修订变化已经失效。预检沿用原 resolver 的真实有效性计算，保留失效选择及原因，不把它包装成新修订上的有效选择。当前仍有效的高级模式也保留其事实，同时标记后续迁移需要再次确认。

所有来源的 workdir 都标记 `workspace_mapping_required`，表示后续需要逐项映射到目标项目/工作区。requested、applied 和 effective 不同会列出 `non_equivalent_snapshots`；旧进程尚未确认退出列出 `process_exit_unknown`。这些提示不会修改 desiredState、pendingChanges、SID 或 resetSessionRequested。

## 5. 冻结快照选择

`selectLegacyConfigSnapshot` 是纯选择器，只消费一次预检捕获的 Binding，不再次读取配置。按以下顺序取第一份存在的完整来源：

1. `requestedSnapshot`：保留明确请求的原始快照。
2. `runner.applied`：没有 requested 时保留实际已应用快照。
3. 该次预检捕获的完整 `effective`：前两者都不存在时使用。

返回 `configSnapshotRef` 包含 authority、source kind/sourceId、runtimeId、bindingId、agentId、原 digest、原 runtime/binding versions 和 configVersion。sourceId 使用原 binding 主键，applied 的 runner 主键同样是 bindingId。存储来源同时返回原始 JSON；各来源另有原 JSON 字节摘要 `rawDigest`，不替换其配置 digest。

JSON 无效、已存快照 digest 不匹配、未知配置版本、backend 错配或身份歧义会阻塞选择；尤其不能把损坏的 requested 当作不存在而降级选择 applied/effective。输出始终为 `activationAllowed: false`。目录映射、权限再次确认与进程退出确认均交由后续明确的迁移/执行流程完成。

## 6. 本地管理 HTTP 契约

全部入口复用本地用户管理边界：Host 为 localhost/127.0.0.1，提供 Origin 时必须同源；actor 必须为全局 human 并具备现有 `runtime:manage` 能力。Agent 或项目作用域 actor 不能管理目录。JSON 写请求最多 64 KiB，字段严格校验。

| 方法与路径 | 请求或结果 |
| --- | --- |
| GET /api/roles | `{roles}`；可用 `includeArchived=true` |
| POST /api/roles | 完整 RoleTemplateInput → `{role}`，201 |
| GET /api/roles/:id | `{role}` 当前版本 |
| GET /api/roles/:id/revisions/:revision | `{role}` 固定历史版本 |
| PUT /api/roles/:id | 完整字段 + expectedRevision → `{role}` |
| POST /api/roles/:id/copy | expectedRevision、name → 新 `{role}`，201 |
| POST /api/roles/:id/archive 或 restore | expectedRevision → `{role}` |
| GET /api/roles/:id/delete-impact | `{impact}`，只读 |
| DELETE /api/roles/:id | expectedRevision、可选 confirm；确认后 204 |
| GET /api/agents | `{agents: [{agent, aliases}]}` |
| GET /api/agents/:id | `{agent, aliases}` |
| PATCH /api/agents/:id | expectedDisplayName、displayName → `{agent, aliases}` |
| GET /api/agents/:id/aliases | `{aliases}` |
| POST /api/agents/:id/aliases | displayName、hostType → `{agent, aliases}`，201 |
| GET /api/agents/:id/profile | `{profile, bindings, observedAt, sourceDigest, code, issues}` |
| GET /api/legacy-config/preflight | 完整只读报告；存在身份/配置错误时 409 |
| GET /api/legacy-config/bindings/:id | `{binding}` |
| GET /api/legacy-config/bindings/:id/config-snapshot | `{selection}`；选择被阻塞时 409 |
| GET /api/user/audit | `{entries}`；可选 limit（1–200）、beforeId |

Profile、legacy Binding、预检与快照入口的写请求返回 `409 / legacy_config_read_only`、`authority: legacy`、`migrated: false`，并提供原 runtime 写入口。存在多个歧义 runtime 时不给出可写目标。Agent 集合没有创建方法；这些管理入口没有新增 MCP 工具。

## 7. 审计、迁移与验证边界

目录创建/编辑/复制/归档/恢复/删除和 Agent 改名/alias 新增，与 `scope: user` 审计在同一事务提交。审计失败回滚业务变更。user scope 的 project_id 必须为空，project scope 必须非空，数据库 CHECK 强制一致性；不创建伪项目来承载全局操作。

v14 保留原 audit_log 所有字段、历史内容及原项目索引，为全局审计追加索引和 target kind。旧项目审计查询/撤销继续按项目作用域执行，不混入 user 记录。此前 v1–v13 SQL/checksum 不变。

跨库搬运将 alias、职责头和全部不可变版本列入业务表，先复制头，再按复制来源依赖顺序复制版本；退休 alias 和 user 审计同样保留。Member 事实版本仍最后按源值复制，维持 v13 的事实基准。清空目标时先移除职责版本再移除职责头，不把来源引用级联删掉。

针对性证据入口：`identity-catalog-migration.test.ts`（非空升级、复制/清空与半空来源负例）、`agent-aliases.test.ts`（CAS、碰撞、退休、真实 MCP SDK 重连）、`identity-catalog.test.ts`（不可变引用、权限/技能边界、审计回滚）、`legacy-config-inspection.test.ts`（多来源、失效高级选择、损坏/歧义、全表不变）和 `identity-api.test.ts`（真实 HTTP 管理与只读拒绝）。双引擎 fixture 使用真实 SQLite/PostgreSQL，PostgreSQL 仅在配置真实测试 URL 时执行，否则明确 skip；运行结果不能替代远端数据库/平台 CI 或独立两轴审查。

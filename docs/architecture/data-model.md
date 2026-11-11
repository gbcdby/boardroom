# 数据模型与持久化

状态：已确认
日期：2026-10-22 初版；2026-11-11 补 v11/v12/v13 任务、记忆、成员代际与共同事务边界
来源：F2 #12、阶段 2 Spec #45、阶段 3 Spec #104、阶段 4 Spec #108、阶段 5 Spec #109。

本文描述服务端的持久化实体、关系、约束、迁移与事务边界。具体 DDL 以[迁移入口](../../src/server/db/migrations/index.ts)及其子模块为准。v13 属当前工程候选；实现存在不代表该候选已合并、上线或完成双引擎验收，实际状态见 [V1 索引](../v1-acceptance.md)。运行默认 SQLite，可选 PostgreSQL；产品 AC-CORE-01 的 PostgreSQL 验收要求不等于修改默认驱动。

## 1. 实体与关系

Agent 是跨项目身份，Member 是项目中的关系；组织节点、群组、任务和项目记忆归 Project。群组通过参与关系关联 Member，消息保留发送者并有逐接收者投递记录。Member 的生命周期不替代连接、运行或任务状态。

| 实体 | 含义 | 关键字段 |
| --- | --- | --- |
| **Agent** | 跨项目的全局身份 | `display_name`、`host_type`、`last_seen_at` |
| **Project** | 协作容器；按项目作用域建模（阶段 2 起多项目并用） | `name`、`archived_at` |
| **Member** | agent 或人在项目中的成员关系、岗位与加入代际 | `project_id`、`agent_id`、`kind`、`role`、`node_id`、`status`、`removed_at`、`membership_revision` |
| **OrgNode** | 组织岗位节点（多层树，汇报线 = `parent_id`） | `project_id`、`parent_id`、`name`、`role`、`sort_order` |
| **Group** | 项目内聊天空间（一项目多群组） | `project_id`、`name`、`archived_at` |
| **group_participants** | 群组参与者（多对多关系表） | `group_id`、`member_id` |
| **Message** | 群组消息 | `group_id`、`sender_member_id`、`seq`、`body`、`mentions` |
| **MessageDelivery** | 某消息对某成员的投递记录 | `message_id`、`member_id`、`status`、`attempt_count` |
| **MemberStatus** | 项目成员运行状态 | `project_id`、`member_id`、`state` |
| **AgentRuntime** | 全局托管配置，关联既有 Agent 身份层 | `agent_id`、`defaults_json`、`config_version`、`revision` |
| **RuntimeBinding** | 一个 runtime 在项目/群的显式绑定和启动意图 | `runtime_id`、`project_id`、`group_id`、`member_id`、`overrides_json`、`desired_state` |
| **RunnerState / RuntimeMember** | 进程观察状态与同 Member 唯一运行权 | `lease_owner`、`generation`、`applied_json`、`exit_confirmed`、`process_identity_json` |
| **RuntimeEvent / UsageSnapshot** | 有界诊断历史及独立累计用量基线 | 白名单事件、来源/版本/作用域/epoch、序号、覆盖与可靠性 |
| **Task / ReviewRound / ReviewReport** | 项目任务、固定候选、独立分轴报告与裁决 | 项目/任务复合引用、单调 revision、`spec_snapshot`、`candidate`、`axis`、声明证据 |
| **WorkEvent** | 本人持久工作通知，与聊天投递分离 | `recipient_member_id`、`event_key`、`context_group_id`、`delivery_state` |
| **MemoryDocument / MemoryVersion** | 三层文档当前值与不可变历史 | `scope`、项目/Agent 唯一键、version、UTF-8 bytes、hash、mutation ID |
| **SummaryRequest / Receipt / Counter / Checkpoint** | 自总结状态、首次投递来源和有界扫描恢复 | attempt/revision、触发去重键、真实 MCP 投递、固定上界与游标 |
| **MemberFactRevision** | 六类保留事实的单调版本 | `(member_id, kind)`、`revision`；由真实表 trigger 维护 |

### 1.1 Agent vs Member（D1）

- **Agent** 是全局身份，跨项目存在。连接相关字段只持久化可恢复的 `last_seen_at`（最近观察到的连接活动时间）；**连接是否存活由运行时按心跳推导，连接对象不落库**。
- **Member** 是 agent 或人在某个项目中的成员关系。`kind='agent'` 的成员必须绑定 `agent_id`；`kind='human'` 的成员不绑定（由 CHECK 强制）。
- 同一 Agent 可在多个项目中各有一个 Member；`(project_id, agent_id)` 唯一。

### 1.2 Status vs Agent 连接状态（D1）

- `member_statuses` 按 `(project_id, member_id)` 唯一记录运行状态：`online / offline / waiting / working`。
- **Status 与 Agent 连接状态分开建模**：Status 是项目成员作用域的运行状态；Agent 连接状态是全局 MCP 会话层面、由心跳推导的瞬时状态。两者不共用表、不互相写入。
- **与任务状态分开**：v11 的 Task 使用 todo / in-progress / review / blocked / done，不复用 MemberStatus。

### 1.3 项目级 role（D2）与阶段 2 兼容投影

- `members.role` 取值 `manager` / `normal`，默认 `normal`。
- 阶段 1 由部分唯一索引 `ux_members_project_manager ON members(project_id) WHERE role='manager'` 强制「每项目最多一个顶层 manager」。
- **T2 #49（迁移 v4）已移除该索引**（与多层组织树冲突）。此后 `members.role` 只是**阶段 1 兼容投影**：
  真实顶层岗位由组织树根节点（`org_nodes`，`role='top_manager'`）表达，「至多一个 legacy manager」的不变量
  下沉到 `members` repository 应用层校验；占据/让出根节点时同步升降 `role`，保证升级路径与 T1 API 一致。

### 1.4 归档标记（阶段 2 #48）

- `projects.archived_at` 与 `groups.archived_at`（迁移 v3）：`NULL` = 未归档，非空 = 归档时间（ISO 文本）。
- 归档是**可恢复的非活跃态**：不加状态枚举、不搬数据、不建归档表；恢复只把该列置回 `NULL`。
- 读侧默认只取未归档行（列表带 `includeArchived` 可选放宽）；写侧在 repository 这一唯一写入边界拒绝
  （`ArchivedError` / code `archived`），HTTP 与 MCP 因此共享同一规则。
- **归档 ≠ 删除**：永久删除由 repository 的 `purge` 显式级联清除（见 §7），与归档标记无关。

### 1.5 组织树、角色与能力点（阶段 2 T2 #49）

- `org_nodes` 表达「岗位 + 汇报线」：`parent_id` 自关联形成多层树（人 → 顶层 manager → 下级 manager / 成员），
  **递归 CTE 现算子树**（SQLite 侧 `WITH RECURSIVE`，统一 `?` 占位符经 F1 方言抽象），不建闭包表。
- 根节点（`parent_id IS NULL`）每项目最多一个（`ux_org_nodes_single_root`），该位置即唯一的顶层 manager 岗位；
  空岗（无成员占据）允许存在。
- **角色与岗位分离**：`org_nodes.role` 是静态枚举 `owner / top_manager / sub_manager / member`（与 F2
  `AUTHZ_ROLES` 同值）；`owner` 是人的内建全局主体，不建节点。能力点不落库，由 F2 的
  `ROLE_CAPABILITIES` / `CAPABILITY_BOUNDARY` 静态矩阵表达；`group:view_subtree` 让下级 manager 对
  「参与者全部落在自己子树内」的群组只读可见（可看元数据与历史，不唤醒、不能发言，决策票 #32）。
- `members.node_id` 是刚性外键锚点：`ON DELETE SET NULL` 保证删岗位只腾出岗位、成员保留；
  `ux_members_node` 保证「一人一岗、一岗一实例」。删岗位时子树提升到父，不级联删。
- **阶段 1 兼容硬约束**：v3→v4 迁移只建结构、**不回填组织数据**，升级后的库默认无组织树；
  `resolveActor` 在无占岗数据时回退到 `members.role` 的 manager/normal → top_manager/member 兼容映射
  （默认人 = owner 全量能力点），因此 AC-CORE-* 不回归。
- v5 增加成员在岗状态，v6 增加审计，v11 增加任务，v13 增加保留身份/事实版本。当前组织和成员领域变更与完整审计同事务提交，旧入口观察钩子不替代权威审计。

### 1.6 成员生命周期状态（阶段 2 T3 #50）

- `members.status`（迁移 v5）是「成员在不在岗」的**持久化标记**，静态枚举
  `active / disabled / pending`（CHECK 约束 + `NOT NULL DEFAULT 'active'`）：
  - `active`：正常在岗；`disabled`：已暂停/停用；`pending`：待激活（登记后尚未正式在岗）。
- **与其它状态严格分开建模**（`AGENTS.md`「身份注册、连接心跳、工作状态、任务状态分开建模」）：
  - `member_statuses.state`（online/offline/waiting/working）是项目成员**运行状态**；
  - `mcp_sessions`（connected/disconnected + 心跳）是**连接状态**；
  - `members.status` 是**生命周期/在岗状态**。断连不删除成员、不改写本列（LIFE-MEM-03），
    在线/离线由连接与心跳表达，不复用本枚举。
- **状态机**（唯一写入边界 `MembersRepository.setStatus`，`src/server/db/repositories.ts`）：
  `active → disabled`（暂停）、`disabled → active`（re-enable 恢复岗位）、
  `pending → active | disabled`（激活 / 暂停）；同态幂等，表外转换（如 `disabled → pending`）
  抛 `ConflictError`，未知值 `InvalidArgumentError`，归档项目 `ArchivedError`（复用 T1 归档写规则）。
- **可恢复、不物理删除**（LIFE-MEM-01/02）：disable 修改成员 `status`/`updated_at` 并记录审计，保留身份、role、岗位、群组关系与历史，不清除/重建 `org_nodes`。当前业务权限检查会拒绝失活成员，re-enable 恢复 active；它与 v13 的移除/新加入代际不同。
- 老库升级（v4 → v5）只 `ALTER TABLE ADD COLUMN`，**默认 `active`、不回填业务数据**，
  阶段 1 既有成员/入群链路行为不变（AC-CORE-* 由 `scripts/e2e-phase1.mjs` 回归）。
- 当前状态变更经 `createOrgMutationService` 记录前后状态和加入代际，与审计同事务提交。移除是独立于 status 的墓碑状态，不能以 enable 绕过；见 §1.10。

### 1.7 可选托管运行时

托管配置不复用 Agent、Member、MCP session 或成员工作状态。创建配置原子建立新身份和绑定，初态停止；既有外部身份不被按显示名接管。配置默认值和显式覆盖分别持久化，保存只递增修订；明确应用捕获版本快照，正常恢复继续使用已应用快照。高级权限策略绑定到配置修订，下一次编辑默认失效。

`agent_runtime_members` 是成员级 reservation 与 owner/generation 的串行点。同 Member 不同群一次只有一个 runner；跨项目 Member 独立。MCP 入群、出队、ACK、回复和状态回写都检查受信通道身份及 fence。租约过期不等于进程已退出；跨重启恢复需验证 launcher 协议、系统 boot ID、PID namespace 和 start ticks，只有确认旧 wrapper 及其隔离树退出后才以旧 fence/身份/过期租约原子释放。PID 本身只作展示，绝不用于杀旧进程。

删除或永久清除配置关联范围必须先停止、确认退出并释放 owner。普通配置删除保留 Agent/Member 身份和消息历史；项目/群永久清除仍按原范围执行，并清理相应绑定。运行观测历史独立于业务消息与审计，轮转不回填投递、ACK 或成员状态；用量累计基线独立于事件轮转，避免把首次、回退或断档的累计值误作新增消耗。

各用量指标独立声明 invocation 或 session 作用域。会话累计快照使用绑定与实际已关联宿主 SID 导出的内部引用，跨进程续接保留同一 scope/epoch；公开观测不保存原 SID。已验证结果帧的来源序号与 runner generation 一起决定顺序，新 generation 可从序号 0 开始，重放或旧代次不能覆盖较新快照。同会话累计回退会持续标记不可靠；明确新会话才建立独立计数，未知基线不生成差额。该顺序与可靠性信息保留在既有快照 payload，不新增计费表或迁移。

### 1.8 任务、评审与工作事件（v11）

[tasks.ts](../../src/server/db/migrations/tasks.ts) 增加八张业务表：`project_task_settings`、`tasks`、`task_review_rounds`、`task_review_reports`、`task_comments`、`task_history`、`task_message_links`、`work_events`，并扩展审计目标类型。

- task、round、report 和 comment 使用项目/任务复合外键，不能只凭一个 ID 跨项目关联。任务状态、指派与配置更新使用修订 CAS；没有设置行时 API 使用 revision 0，首个持久行从 1 开始。
- round 固定任务快照与 Git candidate，保存 ready/running/reported/decided/failed/superseded。`UNIQUE(round_id, axis)` 保证同轮每轴一份报告，报告携带来源、正文 hash 与 `reviewer-declared` 执行声明；report 与对应 comment 同事务写入。
- 工作事件以 `(recipient_member_id, event_key)` 去重。事件 ACK 只改变投递状态，不推进任务、批准评审或完成总结。任务历史、业务变更、审计和通知在同一事务提交，提交后唤醒失败不回滚已经完成的业务。
- 按项目状态/时间、负责人、轮次/报告/评论索引查询；成员移除仍保留作者与历史。v13 追加按负责人、reviewer、接收者的稳定 ID seek 索引，用于有界生命周期扫描。

### 1.9 三层记忆、版本与来源（v12）

[memory.ts](../../src/server/db/migrations/memory.ts) 增加 `memory_documents`、`memory_versions`、`memory_summary_requests`、`memory_message_receipts`、`memory_trigger_counters`、`memory_scan_checkpoints` 六表，并扩展审计目标。

文档通过 CHECK 和部分唯一索引区分 `global(agent_id)`、`project(project_id)`、`project-agent(project_id, agent_id)`。global 的 project_id 必须为空；shared 的 agent_id 必须为空。文档头只保存当前版本；不存在时 API 返回 null/version 0，第一次写入建立版本 1。历史以 `(document_id, version)` 唯一，parent_version 等于 version - 1；同文档/作者/clientMutationId 唯一保证成功重放返回原版本，内容变化不能复用同一 mutation。

总结请求有六种状态、base_version、revision、attempt、触发键和可选结果证据，`UNIQUE(project_id, agent_id, trigger_key)` 去重。完成时文档/历史/请求/证据/通知确认原子提交，人工版本先到使旧结果 conflicted；重试建立新请求和新基准。目标已移除或来源权限变化不能沿用旧绑定提交。

`message_deliveries.first_mcp_delivered_at` 记录首次真实 MCP 投递，升级时不从 delivered/acked 推断旧行。receipt 以 `(agent_id, message_id)` 去重，counter 按项目/Agent/群保存寿命计数与阈值，checkpoint 保存 after_cursor、through_cursor、sweep 与 revision。不可见来源推进 raw cursor 但不计数，固定上界和下一轮扫查避免前缀饿死。`work_events.context_group_id` 为可空群上下文，决定事件过滤和删群范围。

自动注入使用单独的只读 reader 进程和真实数据库资源，不借主库补读；读取时和返回前均检查当前绑定/ACL。global 仅本体 Agent，HTTP 人类 owner 也不能读正文、存在性、历史。更多使用语义见[记忆文档](../memory.md)。

### 1.10 保留身份、加入代际与六类事实版本（v13）

[member-lifecycle.ts](../../src/server/db/migrations/member-lifecycle.ts) 追加 `members.removed_at` 与 `membership_revision`，初始代际为 1、上限为 JavaScript 安全整数。移除态要求 disabled、node_id 为 NULL、legacy role 为 normal。trigger 阻止代际倒退，移除标记每次改变必须恰好递增 1；同 Agent/项目唯一键保留，不制造第二个历史身份。

普通 `members.get/listByProject` 只取有效成员；历史发送者用包括已移除身份的 lookup。移除保留作者与消息/投递等事实，普通 join 返回 `member_removed`；有权管理者显式 re-add 复用 Member ID，使用新代际并清除旧潜在群参与。撤销移除则只在完整快照/事实均匹配时恢复允许的关系，同样推进代际。旧 MCP 绑定、旧 ACK 和迟到总结均不能沿用旧代际；任务/settings 修订也不回拨，旧评审、托管绑定和在途总结需要重新建立。

`member_fact_revisions` 的主键为 `(member_id, kind)`，外键随 Member 硬删除级联。升级为每个既有 Member 建六行初始 revision=1，新 Member 由初始化 trigger 建同样基准。它保存下列真实表的变化事实，不保存计数摘要来猜测是否改变：

| kind | 触发表 | 关联 Member |
| --- | --- | --- |
| authored-messages | messages | sender_member_id |
| deliveries | message_deliveries | member_id |
| memory-requests | memory_summary_requests | recipient_member_id |
| memory-receipts | memory_message_receipts | project_id + agent_id |
| memory-counters | memory_trigger_counters | project_id + agent_id |
| memory-checkpoints | memory_scan_checkpoints | project_id + agent_id |

SQLite 使用 AFTER INSERT/UPDATE/DELETE trigger；PG 使用等价 PL/pgSQL trigger。UPDATE 只在列明的事实字段变化时推进版本，纯 updated_at 观察更新不推进；改变归属时同时推进旧、新成员。删除再增加同样行数也会改变版本，能够发现同量替换。缺少事实基准或达到安全整数上限时拒绝原写入并回滚，不自动补行、重置或绕过 trigger。

成员的 `ix_members_effective` 与参与/任务/轮次/请求/事件/会话/绑定/组织 seek 索引用于有界采集。完整补偿快照使用有版本的 graph/assignment/member-status/member-relations schema，记录根审计与 undo/redo 方向。旧不完整删除/关系快照安全返回 `legacy_incomplete_snapshot`，历史仍可读；兼容解析只用于具备足够事实的旧简单事件。

## 2. 稳定 ID 方案

- 采用 **UUIDv7 值编码为 26 位 Crockford Base32**（ULID 形状），实现见 `src/server/db/ids.ts`。
- 128 位布局（大端）：`[0..5]` 48 位毫秒时间戳 · `[6..7]` 16 位同毫秒计数器 · `[8..15]` 64 位随机数。
- 特性：
  - **时间有序**：编码后字符串字典序与插入时间顺序一致；同毫秒内计数器单调递增。
  - **全局唯一**：随机数 + 计数器组合；每毫秒容量（65536）耗尽时借位到下一毫秒，避免碰撞。
  - **零依赖**：仅用 `globalThis.crypto.getRandomValues`。
- **约定**：
  - 消息 ID 在创建时生成；**同一 ID 不得重复插入**（主键冲突归一为 `ConflictError`）。
  - Message 另有群组内单调递增 `seq`（`max+1`，同一事务内分配），与 ID 一起提供稳定排序与游标分页；失败回滚时不消耗序号。
  - 允许外部在需要幂等导入/重放时提供 ID（`NewMessage.id`）。

## 3. 投递可靠性（NFR-02）

- `message_deliveries` 以 `(message_id, member_id)` 唯一索引去重，记录 `status(pending/delivered/acked)`、`attempt_count`、`first_delivered_at`、`last_delivered_at`、`acked_at`。
- **至少一次投递**：重复投递时 `attempt_count` 递增，`first_delivered_at` 保持不变，`last_delivered_at` 更新。
- **去重**：`ensure(message, member)` 幂等；`recordAttempt` 对同一对 `(message, member)` 只更新一条。
- **重连补发**：`deliveries.listPending(project_id, member_id)` 按消息 `seq` 返回仍为 `pending` 的积压记录。
- v7 将 `client_message_id` 和 allowed/suppressed/NULL 唤醒事实与消息一起持久化；防环抑制不等于删消息。v12 的首次 MCP 投递标记与通用 attempt/ACK 分开，历史读取和直接 ACK 不产生总结计数来源。

## 4. 迁移策略

- 迁移以版本号递增定义在 `src/server/db/migrations/index.ts`，由 F1 的 runner（`src/server/db/migrate.ts`）执行。
- **只追加、不改已应用迁移**：runner 对已应用迁移校验 SQL checksum，改写会报错。
- 每条迁移在独立事务内执行；失败整体回滚，版本不前进。
- 空库首次启动自动应用全部迁移；重复启动幂等（已应用版本不重复执行）。
- 当前版本：
  - `1 init_domain_model`：建立全部领域表、索引与外键（F2）。
  - `2 mcp_sessions_and_agent_identity`：Agent 全局身份唯一索引 + `mcp_sessions` 连接状态表（T2）。
  - `3 archive_flags_for_project_and_group`：项目/群组 `archived_at` 标记与列表索引（T1 #48）。
  - `4 org_tree_and_static_roles`：`org_nodes` 组织树、`members.node_id` 占岗锚点、
    `ux_org_nodes_single_root` / `ux_members_node` 唯一索引；移除与多层树冲突的旧
    `ux_members_project_manager`（T2 #49）。**不回填组织数据**，升级库默认无组织树。
  - `5 member_lifecycle_status`：`members.status` 生命周期枚举（active/disabled/pending）、
    CHECK 约束、`NOT NULL DEFAULT 'active'` 与 `ix_members_project_status` 索引（T3 #50）。
    **只加列、默认 active、不回填**，升级库老成员一律 active（见 §1.6）。
  - F1 只建立 `schema_migrations` 版本表，无领域表。
  - `6 init_audit_log`：组织/成员生命周期最小审计。
  - `7 durable_message_dispatch`：持久化发送幂等键及 allowed/suppressed/NULL 唤醒决定。
  - `8 managed_runtime_configuration_and_ownership`：托管配置、绑定、成员 reservation 与 runner 状态。
  - `9 managed_runtime_observability`：事件、观测健康计数与用量快照。
  - `10 managed_runtime_process_identity`：追加只读恢复使用的内核进程身份；老行保持 NULL，不推断旧所有权。
  - `11 tasks_reviews_and_work_events`：项目任务、默认 reviewer、固定轮次、两轴报告/评论、历史、消息关联与持久工作事件。
  - `12 memory_documents_summaries_and_scan_checkpoints`：三层文档/历史、自总结请求、首次投递收据/计数/游标；追加真实 MCP 投递标记和群上下文事件。
  - `13 member_tombstones_and_retained_fact_revisions`：保留身份墓碑、单调加入代际、六类事实版本/双引擎 trigger 与有界采集索引。
- 生产迁移保持 SQLite/PostgreSQL 可执行；跨驱动搬运使用 `migrate-data.ts` 的对应目标 DDL、列复制与逐表校验。托管表、已应用快照、进程归属和观测基线均在搬运范围内。
- `schema.test.ts` 校验当前版本及老库升级，`runtime-repository.test.ts` 与 `migrate-data.test.ts` 检查非空配置、投递和所有权的保留。只读内核核验不依赖迁移重造 PID。

跨驱动复制不修改旧迁移 checksum。源库使用同版本 schema 后只读打开；目标先迁移，再按外键顺序复制。成员插入和事实表复制会触发目标 revision 递增，因此 **member_fact_revisions 最后复制**：先移除目标自动生成的版本行，再原值写入源版本，并逐键/值核对。不能把目标触发出的临时 revision 当源库事实。

清空目标时先删六类事实，让仍存在的 Member 基准接收删除 trigger；再删除 Member，随后清理剩余事实版本。不能简单把 copy-last 表放到反向顺序首位，否则删除事实时会失去基准而失败。项目 purge 同样在硬删 Member 前清完依赖事实，成员事实版本由外键级联；普通移除不硬删它们。rollback 只处理指定目标，保留源数据；具体命令见[接入与迁移说明](../getting-started-mcp.md#数据迁移与恢复)。

## 5. 事务与并发

- SQLite 连接参数（见 `database.ts`）：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 写操作通过 `repositories.transaction()` 或各写方法内置事务执行：`BEGIN IMMEDIATE` 取得写锁；嵌套调用使用 `SAVEPOINT`，内层失败只回滚内层。
- **失败不静默**：底层写入失败归一为明确错误类型（`ConflictError` / `InvalidReferenceError` / `InvalidArgumentError` / `WriteFailedError`）后抛出；事务失败整体回滚，不会留下半写状态。
- **WAL 读写并发**：WAL 模式下读不阻塞写、写不阻塞读（同一进程内实测见 `tests/persistence.test.ts`）。写锁串行化由 `BEGIN IMMEDIATE` 与 `busy_timeout` 处理。
- **只持久化可恢复字段**：运行时对象（WebSocket 连接、定时器、进程句柄）不进入数据库。

### 5.1 共同变更锁序与范围

[mutation-scope.ts](../../src/server/db/mutation-scope.ts) 为同一 DbDriver 缓存唯一 coordinator，锁范围放在驱动的**物理事务上下文**，由[协调仓储](../../src/server/db/coordinated-repositories.ts)及领域入口共用。取得、使用权限和业务写入处于同一边界；租约、世代或 UI 状态不能代替数据库当前事实。

1. 项目 ID 去重排序，先锁 Project 行。
2. 在项目锁内以只读 discover 收集实际成员、群组和 runtime 范围；discover 不能业务写入、另开事务或预先取得下层锁。
3. Member ID 去重排序后逐个锁定，包含真实发送/接收、指派、总结目标和补偿受影响成员；预分配新 ID 需确认未存在，并在提交前确认确实建立于锁定项目。
4. Group ID 排序加锁，再按 runtime ID 排序加锁；之后才进入已声明范围的业务关系写入与读回。

嵌套操作只能使用已经持有范围的子集，不能中途追加项目、成员、群组或 runtime 锁。发现关系变化或触及未覆盖 ID 时返回 `mutation_scope_changed`，整个外层操作回滚后由调用方读取新事实，不在持锁过程中猜测扩大计划。MCP join、发送/投递/ACK、心跳、任务/记忆、组织/成员和托管写路径遵循同一序列；不以某个 API 的局部前置查询作为最终授权。

有界审计采集在 PG 上于首个项目锁前设置真实 lock_timeout/statement_timeout；累计行数、返回字节、SQL 数、计划写行和工作时长由 observer 记录。SQLite 的原生语句不能靠 Promise 超时伪装取消；超限后的错误必须等真实回滚结束。当前预算和用户恢复方法见[生命周期文档](../t3-member-lifecycle.md#3-审计撤销重做与安全冲突)。

## 6. 错误模型

| 错误 | code | 触发场景 |
| --- | --- | --- |
| `NotFoundError` | `not_found` | 更新/删除不存在的实体 |
| `ConflictError` | `conflict` | 重复 ID、每项目第二个 manager、投递违规重复等唯一约束 |
| `InvalidReferenceError` | `invalid_reference` | 引用不存在的项目/成员/群组；跨项目/跨群组引用；发送者非群组参与者 |
| `InvalidArgumentError` | `invalid_argument` | 空名称、非法 kind/role/state、human 绑 agent 等语义校验失败 |
| `WriteFailedError` | `write_failed` | 连接关闭、磁盘满、只读、I/O 等底层写入失败（已回滚） |
| `ArchivedError` | `archived` | 目标项目/群组已归档时的写入（#48：建群组、加/改成员、发消息等；恢复后放行） |
| `RepositoryError` | `member_removed` / `mutation_scope_changed` / `compensation_conflict` | 成员已移除、实际锁范围变化或当前快照不匹配，拒绝覆盖后续操作 |
| `RepositoryError` | `legacy_incomplete_snapshot` / `audit_capture_budget_exceeded` | 旧快照无法完整恢复，或有界采集/执行超过预算；不做部分补偿 |

上层（T1–T7、MCP、HTTP）应依据 `code` 分支处理，向调用方返回明确错误，而非吞掉写入失败。

## 7. 数据访问边界（repository 层）

`src/server/db/repositories.ts` 的 `createRepositories(db)` 返回共享同一连接的 repository 集合，供 T1–T7 复用：

| repository | 主要方法 |
| --- | --- |
| `agents` | `create / get / list / update / touchLastSeen / delete / insertRaw` |
| `projects` | `create / get / list({includeArchived}) / rename / archive / restore / previewPurge / purge / delete` |
| `members` | 有效成员读、历史作者 lookup、状态与生命周期 CAS；有权限的领域 service 负责移除/重新添加/完整审计，低层 delete 不是用户移除入口 |
| `org`（T2 #49） | `createNode / getNode / listNodes / getRootNode / subtreeNodeIds / updateNode / deleteNode / assignNode / autoPlaceMember / nodeOfMember` |
| `groups` | `create / get / listByProject({includeArchived}) / archive / restore / previewPurge / purge / participants / addParticipant / removeParticipant / delete` |
| `messages` | `create / get / listByGroup({afterSeq, limit})` |
| `deliveries` | `ensure / get / recordAttempt / listPending / delete` |
| `statuses` | `set / get / listByProject / delete` |
| `tasks` | 默认 reviewer、任务/轮次 CAS、报告/评论/历史、关联消息、持久工作事件 |
| `memory` | 文档头/不可变版本、请求/attempt CAS、真实来源收据/计数/固定扫描 checkpoint |
| （set 级） | `transaction(fn)` |

类型定义见 `src/server/db/types.ts`；错误类型见 `src/server/db/errors.ts`。

**永久删除（purge）的级联范围（#48 / LIFE-ARC-02）**：在单个事务内按「子 → 父」显式删除，
不只依赖外键级联，好让「确认清单里的计数」与「实际清除的行」一一对应，也便于 M1 按方言重写。

- `projects.purge(id)` 先确认关联托管运行停止，再清记忆请求/收据/计数/checkpoint、项目版本/文档；随后清工作事件、评论/历史/关联、报告/轮次/任务/设置；再清消息投递/消息、参与/会话/状态、runtime reservation/runner/绑定、群组、成员（包括墓碑身份）、组织和项目。六类事实在 Member 仍存在时删除，Member 硬删最终级联其事实版本。保留全局 Agent、global 记忆与既有审计。
- `groups.purge(id)` 清当前群上下文的记忆请求/工作事件/收据/计数/checkpoint、任务消息链接，再清投递/消息、参与/会话和群绑定后删群。保留项目 Member、任务/评论、项目文档及版本和 global 记忆；不会按项目扩大删除。
- `PurgeCounts` / `GroupPurgeCounts` 的新表计数与前端二次确认文案一起演进，实际清除结果需要双引擎逐键核对。详见[仓储实现](../../src/server/db/repositories.ts)及[生命周期说明](../t3-member-lifecycle.md#4-归档永久删除与资料保留)。

## 8. 验证与能力边界

- 当前模型支持多项目/群组、组织、任务与三层记忆；`mentions` 持久化稳定成员 ID，语义解析/路由与权限仍由领域服务负责。
- 迁移/索引/trigger、共同锁序、补偿并发/回滚和跨驱动复制分别有实际测试入口。`tests/member-facts.test.ts`、`tests/mutation-scope.test.ts`、`tests/coordinated-data.test.ts`、`tests/member-compensation.test.ts`、`tests/migrate-data.test.ts` 不应被仅 SQLite 的一组结果代替。
- 持久 completed/declared evidence 不证明外部模型执行过；读取/迁移正确也不等于真实浏览器、原生宿主或性能通过。最终结论关联同候选 [V1 证据索引](../v1-acceptance.md)。

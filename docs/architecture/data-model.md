# 数据模型与持久化

状态：已确认
日期：2026-10-22（2026-11-05 补 T2 #49 组织树、T3 #50 成员生命周期状态）
来源：F2 #12（子 spec #2 §4/§6.5/§8.2）；决策 D1 #4、D2 #5；T2 #49（决策票 #24/#25/#26/#32）；T3 #50（决策票 #27/#28、spec #45 §6.3/§6.4）。

本文描述服务端的持久化数据模型：实体、关系、约束、ID 方案、迁移策略与事务边界。它是长期有效的架构说明，供 T1–T7 与后续阶段复用；具体表结构以 `src/server/db/migrations/index.ts` 为准。

## 1. 实体与关系

```
Agent (全局身份)
  └─< Member (项目成员关系, 项目级 role) >─ Project
OrgNode (组织岗位, 树) ─┬─> Project
  └─< 自关联 parent_id（汇报线）
        └─< Member.node_id（占岗锚点）
Group (项目内聊天空间) >─ Project
  └─< group_participants >─ Member
Message >─ Group, Member(发送者)
  └─< MessageDelivery >─ Member
MemberStatus >─ Project + Member
```

| 实体 | 含义 | 关键字段 |
| --- | --- | --- |
| **Agent** | 跨项目的全局身份 | `display_name`、`host_type`、`last_seen_at` |
| **Project** | 协作容器；按项目作用域建模（阶段 2 起多项目并用） | `name`、`archived_at` |
| **Member** | agent 或人在项目中的成员关系与岗位 | `project_id`、`agent_id`、`kind`、`role`、`node_id`、`status` |
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

### 1.1 Agent vs Member（D1）

- **Agent** 是全局身份，跨项目存在。连接相关字段只持久化可恢复的 `last_seen_at`（最近观察到的连接活动时间）；**连接是否存活由运行时按心跳推导，连接对象不落库**。
- **Member** 是 agent 或人在某个项目中的成员关系。`kind='agent'` 的成员必须绑定 `agent_id`；`kind='human'` 的成员不绑定（由 CHECK 强制）。
- 同一 Agent 可在多个项目中各有一个 Member；`(project_id, agent_id)` 唯一。

### 1.2 Status vs Agent 连接状态（D1）

- `member_statuses` 按 `(project_id, member_id)` 唯一记录运行状态：`online / offline / waiting / working`。
- **Status 与 Agent 连接状态分开建模**：Status 是项目成员作用域的运行状态；Agent 连接状态是全局 MCP 会话层面、由心跳推导的瞬时状态。两者不共用表、不互相写入。
- **与任务状态分开**：阶段 1 不实现任务；任务状态属于未来的 Task 实体，不复用 MemberStatus。

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
- 成员生命周期状态（T3 #50，见 §1.6）迁移 v5 已在 `members.status` 落地；审计写入与撤销（T5 #52）、
  任务表（阶段 3）不属本票；本票只在入口留 `OrgChangeRecorder` 接口钩子，不写 `audit_log`
  （T3 的成员状态变更同样只调用该钩子，见 `src/server/org-change-hook.ts`）。

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
- **可恢复、不物理删除**（LIFE-MEM-01/02）：disable 只改 `status` 与 `updated_at`，
  成员行、身份(`agent_id`/`kind`/`display_name`)、`role`、岗位(`node_id`)、群组参与关系、
  消息/投递历史、`member_statuses`、`mcp_sessions` 一行都不动；re-enable 回到 `active`，
  岗位与数据原样恢复生效（不清除/重建 `org_nodes`）。
- 老库升级（v4 → v5）只 `ALTER TABLE ADD COLUMN`，**默认 `active`、不回填业务数据**，
  阶段 1 既有成员/入群链路行为不变（AC-CORE-* 由 `scripts/e2e-phase1.mjs` 回归）。
- 状态变更在 HTTP 入口只调用 `OrgChangeRecorder` 钩子（`member.disable` / `member.enable` /
  `member.status_change`），**不写 `audit_log`**（审计写入与撤销属 T5 #52）。

### 1.7 可选托管运行时

托管配置不复用 Agent、Member、MCP session 或成员工作状态。创建配置原子建立新身份和绑定，初态停止；既有外部身份不被按显示名接管。配置默认值和显式覆盖分别持久化，保存只递增修订；明确应用捕获版本快照，正常恢复继续使用已应用快照。高级权限策略绑定到配置修订，下一次编辑默认失效。

`agent_runtime_members` 是成员级 reservation 与 owner/generation 的串行点。同 Member 不同群一次只有一个 runner；跨项目 Member 独立。MCP 入群、出队、ACK、回复和状态回写都检查受信通道身份及 fence。租约过期不等于进程已退出；跨重启恢复需验证 launcher 协议、系统 boot ID、PID namespace 和 start ticks，只有确认旧 wrapper 及其隔离树退出后才以旧 fence/身份/过期租约原子释放。PID 本身只作展示，绝不用于杀旧进程。

删除或永久清除配置关联范围必须先停止、确认退出并释放 owner。普通配置删除保留 Agent/Member 身份和消息历史；项目/群永久清除仍按原范围执行，并清理相应绑定。运行观测历史独立于业务消息与审计，轮转不回填投递、ACK 或成员状态；用量累计基线独立于事件轮转，避免把首次、回退或断档的累计值误作新增消耗。

各用量指标独立声明 invocation 或 session 作用域。会话累计快照使用绑定与实际已关联宿主 SID 导出的内部引用，跨进程续接保留同一 scope/epoch；公开观测不保存原 SID。已验证结果帧的来源序号与 runner generation 一起决定顺序，新 generation 可从序号 0 开始，重放或旧代次不能覆盖较新快照。同会话累计回退会持续标记不可靠；明确新会话才建立独立计数，未知基线不生成差额。该顺序与可靠性信息保留在既有快照 payload，不新增计费表或迁移。

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
- 生产迁移保持 SQLite/PostgreSQL 可执行；跨驱动搬运使用 `migrate-data.ts` 的对应目标 DDL、列复制与逐表校验。托管表、已应用快照、进程归属和观测基线均在搬运范围内。
- `schema.test.ts` 校验当前版本及老库升级，`runtime-repository.test.ts` 与 `migrate-data.test.ts` 检查非空配置、投递和所有权的保留。只读内核核验不依赖迁移重造 PID。

## 5. 事务与并发

- SQLite 连接参数（见 `database.ts`）：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- 写操作通过 `repositories.transaction()` 或各写方法内置事务执行：`BEGIN IMMEDIATE` 取得写锁；嵌套调用使用 `SAVEPOINT`，内层失败只回滚内层。
- **失败不静默**：底层写入失败归一为明确错误类型（`ConflictError` / `InvalidReferenceError` / `InvalidArgumentError` / `WriteFailedError`）后抛出；事务失败整体回滚，不会留下半写状态。
- **WAL 读写并发**：WAL 模式下读不阻塞写、写不阻塞读（同一进程内实测见 `tests/persistence.test.ts`）。写锁串行化由 `BEGIN IMMEDIATE` 与 `busy_timeout` 处理。
- **只持久化可恢复字段**：运行时对象（WebSocket 连接、定时器、进程句柄）不进入数据库。

## 6. 错误模型

| 错误 | code | 触发场景 |
| --- | --- | --- |
| `NotFoundError` | `not_found` | 更新/删除不存在的实体 |
| `ConflictError` | `conflict` | 重复 ID、每项目第二个 manager、投递违规重复等唯一约束 |
| `InvalidReferenceError` | `invalid_reference` | 引用不存在的项目/成员/群组；跨项目/跨群组引用；发送者非群组参与者 |
| `InvalidArgumentError` | `invalid_argument` | 空名称、非法 kind/role/state、human 绑 agent 等语义校验失败 |
| `WriteFailedError` | `write_failed` | 连接关闭、磁盘满、只读、I/O 等底层写入失败（已回滚） |
| `ArchivedError` | `archived` | 目标项目/群组已归档时的写入（#48：建群组、加/改成员、发消息等；恢复后放行） |

上层（T1–T7、MCP、HTTP）应依据 `code` 分支处理，向调用方返回明确错误，而非吞掉写入失败。

## 7. 数据访问边界（repository 层）

`src/server/db/repositories.ts` 的 `createRepositories(db)` 返回共享同一连接的 repository 集合，供 T1–T7 复用：

| repository | 主要方法 |
| --- | --- |
| `agents` | `create / get / list / update / touchLastSeen / delete / insertRaw` |
| `projects` | `create / get / list({includeArchived}) / rename / archive / restore / previewPurge / purge / delete` |
| `members` | `create / get / listByProject / getManager / update / setStatus / delete`（T3 #50：`setStatus` 为生命周期状态机唯一写入边界） |
| `org`（T2 #49） | `createNode / getNode / listNodes / getRootNode / subtreeNodeIds / updateNode / deleteNode / assignNode / autoPlaceMember / nodeOfMember` |
| `groups` | `create / get / listByProject({includeArchived}) / archive / restore / previewPurge / purge / participants / addParticipant / removeParticipant / delete` |
| `messages` | `create / get / listByGroup({afterSeq, limit})` |
| `deliveries` | `ensure / get / recordAttempt / listPending / delete` |
| `statuses` | `set / get / listByProject / delete` |
| （set 级） | `transaction(fn)` |

类型定义见 `src/server/db/types.ts`；错误类型见 `src/server/db/errors.ts`。

**永久删除（purge）的级联范围（#48 / LIFE-ARC-02）**：在单个事务内按「子 → 父」显式删除，
不只依赖外键级联，好让「确认清单里的计数」与「实际清除的行」一一对应，也便于 M1 按方言重写。

- `projects.purge(id)`：`message_deliveries`（按项目）→ `messages`（按项目内群组）→ `group_participants`
  → `groups` → `mcp_sessions` → `member_statuses` → `members` → **`org_nodes`（T2 #49，成员先删避免悬空占岗外键）**
  → `projects`。`PurgeCounts` 增加 `orgNodes` 计数；全局 `agents` 不删（同一 agent 可在其他项目继续任职）。
- `groups.purge(id)`：该群组的 `message_deliveries` → `messages` → `group_participants` → `mcp_sessions`
  → `groups`。**`members` 与 `member_statuses` 不动**——这是与删项目的关键差别。
- 任务、评论（阶段 3）与三层记忆（阶段 4）落库后按同一顺序补进清单；当前不声称已覆盖。
- **T3 #50 复核**：成员生命周期状态不改变上述级联边界——删群组不动 `members`（含 `status`），
  删项目清除其 `members`；任务/评论/记忆表尚未建表（决策票 #28），阶段 2 的级联清单即当前已落库范围。

## 8. 阶段 1 边界

- 只验收单个项目/群组，但模型按 project/group 作用域建模，避免阶段 2 迁移。
- 不实现：mention 解析与唤醒/可见性规则（T3）、状态转换（T4）、重连积压策略（T5）、任务与任务状态、完整角色/权限矩阵（阶段 2）。
- `mentions` 只持久化被 @ 的成员 ID 数组（JSON），语义解析与路由由上层负责。

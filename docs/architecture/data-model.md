# 数据模型与持久化

状态：已确认
日期：2026-10-22
来源：F2 #12（子 spec #2 §4/§6.5/§8.2）；决策 D1 #4、D2 #5。

本文描述服务端的持久化数据模型：实体、关系、约束、ID 方案、迁移策略与事务边界。它是长期有效的架构说明，供 T1–T7 与后续阶段复用；具体表结构以 `src/server/db/migrations/index.ts` 为准。

## 1. 实体与关系

```
Agent (全局身份)
  └─< Member (项目成员关系, 项目级 role) >─ Project
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
| **Member** | agent 或人在项目中的成员关系与岗位 | `project_id`、`agent_id`、`kind`、`role` |
| **Group** | 项目内聊天空间（一项目多群组） | `project_id`、`name`、`archived_at` |
| **group_participants** | 群组参与者（多对多关系表） | `group_id`、`member_id` |
| **Message** | 群组消息 | `group_id`、`sender_member_id`、`seq`、`body`、`mentions` |
| **MessageDelivery** | 某消息对某成员的投递记录 | `message_id`、`member_id`、`status`、`attempt_count` |
| **MemberStatus** | 项目成员运行状态 | `project_id`、`member_id`、`state` |

### 1.1 Agent vs Member（D1）

- **Agent** 是全局身份，跨项目存在。连接相关字段只持久化可恢复的 `last_seen_at`（最近观察到的连接活动时间）；**连接是否存活由运行时按心跳推导，连接对象不落库**。
- **Member** 是 agent 或人在某个项目中的成员关系。`kind='agent'` 的成员必须绑定 `agent_id`；`kind='human'` 的成员不绑定（由 CHECK 强制）。
- 同一 Agent 可在多个项目中各有一个 Member；`(project_id, agent_id)` 唯一。

### 1.2 Status vs Agent 连接状态（D1）

- `member_statuses` 按 `(project_id, member_id)` 唯一记录运行状态：`online / offline / waiting / working`。
- **Status 与 Agent 连接状态分开建模**：Status 是项目成员作用域的运行状态；Agent 连接状态是全局 MCP 会话层面、由心跳推导的瞬时状态。两者不共用表、不互相写入。
- **与任务状态分开**：阶段 1 不实现任务；任务状态属于未来的 Task 实体，不复用 MemberStatus。

### 1.3 项目级 role（D2）

- `members.role` 取值 `manager` / `normal`，默认 `normal`。
- **每项目最多一个顶层 manager**：由部分唯一索引 `ux_members_project_manager ON members(project_id) WHERE role='manager'` 强制。不同项目各自可有一个 manager。
- 阶段 1 只此两值；完整角色/权限矩阵留阶段 2。

### 1.4 归档标记（阶段 2 #48）

- `projects.archived_at` 与 `groups.archived_at`（迁移 v3）：`NULL` = 未归档，非空 = 归档时间（ISO 文本）。
- 归档是**可恢复的非活跃态**：不加状态枚举、不搬数据、不建归档表；恢复只把该列置回 `NULL`。
- 读侧默认只取未归档行（列表带 `includeArchived` 可选放宽）；写侧在 repository 这一唯一写入边界拒绝
  （`ArchivedError` / code `archived`），HTTP 与 MCP 因此共享同一规则。
- **归档 ≠ 删除**：永久删除由 repository 的 `purge` 显式级联清除（见 §7），与归档标记无关。

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
  - F1 只建立 `schema_migrations` 版本表，无领域表。
- 迁移 SQL 双方言中立（`ALTER TABLE ADD COLUMN` + 普通索引）；业务表按 PostgreSQL 方言重写属 M1 #54。

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
| `members` | `create / get / listByProject / getManager / update / delete` |
| `groups` | `create / get / listByProject({includeArchived}) / archive / restore / previewPurge / purge / participants / addParticipant / removeParticipant / delete` |
| `messages` | `create / get / listByGroup({afterSeq, limit})` |
| `deliveries` | `ensure / get / recordAttempt / listPending / delete` |
| `statuses` | `set / get / listByProject / delete` |
| （set 级） | `transaction(fn)` |

类型定义见 `src/server/db/types.ts`；错误类型见 `src/server/db/errors.ts`。

**永久删除（purge）的级联范围（#48 / LIFE-ARC-02）**：在单个事务内按「子 → 父」显式删除，
不只依赖外键级联，好让「确认清单里的计数」与「实际清除的行」一一对应，也便于 M1 按方言重写。

- `projects.purge(id)`：`message_deliveries`（按项目）→ `messages`（按项目内群组）→ `group_participants`
  → `groups` → `mcp_sessions` → `member_statuses` → `members` → `projects`。
  全局 `agents` 不删（同一 agent 可在其他项目继续任职）。
- `groups.purge(id)`：该群组的 `message_deliveries` → `messages` → `group_participants` → `mcp_sessions`
  → `groups`。**`members` 与 `member_statuses` 不动**——这是与删项目的关键差别。
- 任务、评论（阶段 3）与三层记忆（阶段 4）落库后按同一顺序补进清单；当前不声称已覆盖。

## 8. 阶段 1 边界

- 只验收单个项目/群组，但模型按 project/group 作用域建模，避免阶段 2 迁移。
- 不实现：mention 解析与唤醒/可见性规则（T3）、状态转换（T4）、重连积压策略（T5）、任务与任务状态、完整角色/权限矩阵（阶段 2）。
- `mentions` 只持久化被 @ 的成员 ID 数组（JSON），语义解析与路由由上层负责。

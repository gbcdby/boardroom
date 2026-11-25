# S4-T3 不可变记忆对象：只读兼容迁移设计（候选 A）

状态：草案  
日期：2026-11-25  
关联：GitHub Issue #161（S4-T3，产物 `S4/memory-object-authority`）；依赖 #152 命名产物释放；v2 切换归 #162 activation binding  
适用基线：当前 main 的 21 条生产迁移（v1–v21），迁移号由总控串行分配

## 0. 本包边界（先读）

这是**只读兼容迁移设计包**，仅比较迁移形态、列出门禁同步点和草案 DDL。本包：

- 不注册迁移，不修改 `src/server/db/migrations/**`、`schema_migrations` 或任何 SQL 注册点；
- 不改变生产读写路径；v1 仍以 `memory_documents.markdown` / `memory_versions.markdown` 为唯一权威正文；
- 不改变旧 global 身份边界：旧 wire global 仍 Agent 私有、不扩权，旧文档按 note 保留；规则与自动摘要写权分离（issue #161「结果与范围」「验收与完成」）；
- 不写死迁移号：#161 票据仍为 `schema：需要，UNASSIGNED`（issue #161 正文「阶段／schema」行），本设计不占用、不预留 v22 或任何号码；
- 不实现 #162 的 activation binding、格式激活、旧路径切换或回退；
- 不修改任何 `src/`、`tests/`、迁移注册文件或冻结合同源。

文中所有 SQL 均为**未注册、临时草案、不执行**；真正落地必须先由总控赋号并释放产物，再以候选 B（见末章）单独设计、实现和验收。

## 1. 现状：v12 记忆表与正文语义

权威定义：`src/server/db/migrations/memory.ts:4-6`（`version: 12`，name `memory_documents_summaries_and_scan_checkpoints`）。当前普通迁移数组以它为 v12，末条为 v21（`src/server/db/migrations/index.ts:35`、`src/server/db/migrations/index.ts:440-455`；`src/server/db/migrations/work-event-delivery-invalidations.ts:20`）。

### 1.1 `memory_documents`

`src/server/db/migrations/memory.ts:8-26`：

- 列（10 列）：`id TEXT PRIMARY KEY NOT NULL`、`scope TEXT NOT NULL`、`project_id TEXT`、`agent_id TEXT`、`version INTEGER NOT NULL`、`markdown TEXT NOT NULL`、`byte_length INTEGER NOT NULL`、`updated_at TEXT NOT NULL`、`updated_by TEXT NOT NULL`、`source TEXT NOT NULL`。
- 约束：`scope ∈ {'global','project','project-agent'}`；`version >= 1`；`byte_length >= 0`；`source ∈ {'agent','human','manager','self-summary'}`；`scope/project_id/agent_id` 三者组合必须匹配 global / project / project-agent 三种形态。
- 外键：`project_id → projects(id) ON DELETE CASCADE`；`agent_id → agents(id) ON DELETE RESTRICT`。
- 索引：唯一部分索引 `ux_memory_global(agent_id) WHERE scope='global'`、`ux_memory_project(project_id) WHERE scope='project'`、`ux_memory_project_agent(project_id,agent_id) WHERE scope='project-agent'`；普通索引 `ix_memory_documents_project(project_id, updated_at, id)`。
- global 形态边界：`memory.ts:19-21` 的 CHECK 明确 global 必须 `project_id IS NULL AND agent_id IS NOT NULL`（project 与 project-agent 的对应形态见同段 CHECK），配合 `ux_memory_global(agent_id) WHERE scope='global'`（`:23`），旧 wire global 仍 Agent 私有、不扩权；旧文档按 note 保留，规则与自动摘要写权分离（issue #161「结果与范围」「验收与完成」）。
- 正文：`markdown` 是唯一内联正文列；表中**没有** `content_sha256`，也**没有**对象存储引用列。

### 1.2 `memory_versions`

`src/server/db/migrations/memory.ts:27-43`：

- 列（13 列）：`id TEXT PRIMARY KEY NOT NULL`、`document_id TEXT NOT NULL`、`version INTEGER NOT NULL`、`parent_version INTEGER NOT NULL`、`markdown TEXT NOT NULL`、`byte_length INTEGER NOT NULL`、`content_sha256 TEXT NOT NULL`、`author TEXT NOT NULL`、`actor_id TEXT NOT NULL`、`source TEXT NOT NULL`、`client_mutation_id TEXT NOT NULL`、`summary_request_id TEXT`、`created_at TEXT NOT NULL`。
- 约束：`version >= 1`；`parent_version = version - 1`；`byte_length >= 0`；`source` 同上四值；`UNIQUE (document_id, version)`；`UNIQUE (document_id, actor_id, client_mutation_id)`。
- 外键：`document_id → memory_documents(id) ON DELETE CASCADE`。
- 索引：SQLite 两个 UNIQUE 约束对应 `(document_id,version)`、`(document_id,actor_id,client_mutation_id)`；PG 侧固定目录可见的是**对应约束的索引**，名称为 `memory_versions_document_id_version_key`（`(document_id,version)`）和 `memory_versions_document_id_actor_id_client_mutation_id_key`（`(document_id,actor_id,client_mutation_id)`），另有主键索引 `memory_versions_pkey`（`src/server/storage/maintenance/layout-memory-collector.ts:549-551`）；这些不是 SQLite 侧索引名。
- 正文与摘要：`markdown` 内联正文，`byte_length` 是其 UTF-8 字节数，`content_sha256` 是该正文的 64 位十六进制 SHA-256。

### 1.3 `memory_summary_requests`

`src/server/db/migrations/memory.ts:44-76`：

- 列（25 列）：`id`、`project_id`、`agent_id`、`recipient_member_id`、`context_group_id`、`document_id`、`base_version`、`revision`、`state`、`trigger`、`trigger_key`、`task_id`、`completed_task_revision`、`message_ids`、`source_work_event_id`、`retry_of_request_id`、`attempt_id`、`begin_mutation_id`、`result_version`、`result_sha256`、`error`、`evidence`、`created_at`、`started_at`、`finished_at`。主键为 `id`。
- 约束：`base_version >= 0`；`revision >= 1`；`state ∈ {'pending','running','completed','failed','conflicted','cancelled'}`；`trigger ∈ {'task_completed','message_threshold','session_end','retry'}`；`completed_task_revision >= 1`（可空）；`result_version >= 1`（可空）；`UNIQUE (project_id, agent_id, trigger_key)`；复合外键 `(project_id, task_id) → tasks(project_id,id) ON DELETE CASCADE`。
- 外键：`project_id → projects(id) ON DELETE CASCADE`；`agent_id → agents(id) ON DELETE RESTRICT`；`recipient_member_id → members(id) ON DELETE CASCADE`；`context_group_id → groups(id) ON DELETE CASCADE`；`document_id → memory_documents(id) ON DELETE SET NULL`。
- 索引：`ix_memory_requests_agent(project_id,agent_id,state,created_at,id)`、`ix_memory_requests_expiry(project_id,agent_id,state,started_at,id)`、`ix_memory_requests_source(source_work_event_id)`、`ix_memory_requests_group(context_group_id)`。PG 固定目录另有 `ix_memory_requests_recipient_seek`（`src/server/storage/maintenance/layout-memory-collector.ts:545`），属于既有冻结对象，不在本包变更范围。
- `result_sha256` 是**结果版本正文摘要**的可空列，不是另一种摘要语义：完成总结时写入 `hash(input.markdown)`（`src/server/memory/service.ts:492`，`hash` 定义为 `sha256(...,'utf8')`，见 `:74`），必须与 `evidence.outputSha256` 一致（`src/server/memory/repository.ts:254`；同一输入证据在 `service.ts:86-87` 也要求 `outputSha256 === hash(markdown)`），且 M2 P0 进一步要求等于结果版本的正文 hash（`src/server/identity/internal/m2-p0-memory.ts:151`，evidence 同值见 `:153`）。因此它与该请求产生的 `memory_versions.content_sha256` 同值；「用途/来源不同」不能写成「不等于正文摘要」。

> 同批 v12 还创建了 `memory_message_receipts`、`memory_trigger_counters`、`memory_scan_checkpoints`，并改写 `message_deliveries` / `work_events` / `audit_log`；本设计只比较记忆对象接入，不重开 v12 已应用 SQL。

### 1.4 正文 / `content_sha256` / `byte_length` 的运行语义

证据：`src/server/memory/repository.ts:92-95`、`src/server/memory/repository.ts:174-183`、`src/server/storage/maintenance/layout-memory-inventory.ts:134-148`。

- 正文必须是有效 Unicode，禁止孤立代理项；`byte_length` 必须等于 `Buffer.byteLength(markdown, 'utf8')`，不是 JS 字符串长度。
- 版本写入前校验 `content_sha256 === sha256(markdown utf8 bytes).hex`（代码形式 `createHash('sha256').update(version.markdown).digest('hex')`），并校验版本正文、字节数、source、作者与已 CAS 的 head 完全一致。
- inventory 校验器（`src/server/storage/maintenance/layout-memory-inventory.ts:134-148`）对解码后的行再次核对同一语义：文档正文 `body.length === row.byte_length`（`:134`）；版本正文既要求 `body.length === row.byte_length`，也要求 `sha256(body) === row.content_sha256`（`:147-148`）。`layout-memory-collector.ts` 的职责不同：SQLite 侧只核对三表列数 ≤64 且规范化列等于冻结 manifest（`:360-371`），PG 侧核对固定目录段的行数/字段边界/预算与 `section.sha256` 指纹（`:591-603`），并对 columns/indexes 做固定 profile（`:641-642`）；它不逐行校验正文摘要。
- 因此冻结的三张表列名、顺序、可空性和类型本身就是正文语义的一部分；任何新方案都必须保持「v1 正文仍从 DB 内联列读取」，不能让 DB head 领先已落盘正文，也不能在 v2 未激活时改写这些值。

## 2. 迁移设计空间

两方案共同前提：旧 markdown 在 v2 切换前仍是唯一权威；旧 wire global 仍 Agent 私有、不扩权，旧文档按 note 保留，规则与自动摘要写权分离（issue #161）。v2 的格式激活、read/write binding 与回退属于 #162 activation binding，不在本设计内。两者都必须保留旧单元格与 rowid（含 PG `attnum` 顺序语义），不改旧迁移 checksum，不修改 `schema_migrations`，且迁移号由总控另行分配。

### 2.1 方案一：新建独立对象引用表（不改旧列）

形态：保留 `memory_documents` / `memory_versions` / `memory_summary_requests` 的列和索引原样；另建一张（或按版本拆两张）只存对象引用的表，通过 `document_id` / `version` 指向现有版本，引用字段至少包含 `storage_id`、`object_format`、`content_sha256`、`byte_length`，并按 `scope + owner + document_kind` 做权限与作用域约束。

优点：

- 旧表列集合、collector 冻结列清单、PG 列指纹和 M1 表值校验的**列部分**不变；旧读写 SQL 不用改；
- 旧单元格/rowid 保持原样，旧 checksum 域完全不动；
- v1/v2 可自然隔离：未激活时新表为空或未写入，旧路径照常服务。

代价与缺口：

- 新增逻辑表会改变维护目录规模（58 表夹具、73 表/776 列冻结合同）以及 guard manifest 的表集合；
- `BUSINESS_TABLES` / PG 镜像 / M1_READ_PLAN、purge impact capture、purge counts 与删除顺序、夹具非空种子、collector 冻结 manifest 都要按新表扩展；
- 若新表存有权威摘要但旧列仍权威，必须明确「引用不是权威」的读写规则，否则产生双写/双权威；
- 与 `s4p-allowed-delta-contract/r1` 的 4+2 加列合同直接不同，属于合同偏差项，需总控裁决。

### 2.2 方案二：给旧表追加 4+2 列（符合 `s4p-allowed-delta-contract/r1`）

形态：按已冻结的 `s4p-allowed-delta-contract/r1` 精确追加列：

- `memory_documents` +4：`document_kind`、`body_storage_id`、`body_object_format`、`body_content_sha256`；
- `memory_versions` +2：`body_storage_id`、`body_object_format`；
- 合计 6 列，源目录 M2-P1 `72 tables / 763 columns` → 目标逻辑目录 `73 tables / 776 columns`（其中额外表/列来自同一冻结布局包，不由本设计自行推断）。

优点：

- 与冻结合同的目标逻辑目录一致，不新增表名，guard manifest 的**表集合**不变；
- 对象字段与旧版本行同生命周期，便于 #162 在行级读取 ref 并保留旧 markdown 作为 v1 回退；
- 「exact old cells and rowid」可由只追加可空列实现，旧行内容不动。

代价与缺口：

- 三张冻结表的列清单、可空性、PG `attnum/attname/type/default/collation` 指纹与 collector 的 `canonicalJson(table.columns)` 校验全部要随合同修订；
- 非空夹具需覆盖新列语义或明确新列初始为 NULL 且不得被当作 v1 权威；
- 仍需注册新迁移号、双库 DDL、checksum、M1/PG 镜像与 purge digest 同步；
- 若新列被写成 NOT NULL 或触发回填，会破坏「exact old cells」；须由合同明确初始值和激活前读写规则。

### 2.3 本包的相对结论（不裁决）

- **兼容优先**：两方案在 v2 激活前都必须保持旧 markdown 唯一权威；本包不提出任何默认切换。
- **合同优先**：若以 `s4p-allowed-delta-contract/r1` 为不可变基线，方案二是唯一不动表集合的加列路径；若以「旧表冻结列完全不改」为硬约束，方案一需先修订或另立合同。
- 选择权属于总控；差异列为 §5 裁决项。本包只记录影响面，不把任一方案写成已接受事实。

## 3. 维护门禁同步点清单

以下是任一方案真正落地时必须逐项核对的同步点；本包**不改**这些文件。

1. **M1 复制 / 清理业务表**
   - `src/server/db/migrate-data.ts:76-151`：`BUSINESS_TABLES` 当前 **58 项**（46 条字面条目 + `:147-149` 展开 `DECISION_TABLES` 的 12 张 decision 表；`src/server/decisions/tables.ts:4-1821` 为该静态注册表），含记忆表 `memory_documents`(:103)、`memory_versions`(:104)、`memory_summary_requests`(:127)、`memory_trigger_counters`(:128)、`memory_scan_checkpoints`(:129)、`memory_message_receipts`(:132)。新表须按外键安全顺序插入；加列须同步 `valueColumns` / `keyColumns` 定义（若涉及）。
   - `src/server/db/migrate-data.ts:153-159`：`REVERSE_TABLE_ORDER` 由 `BUSINESS_TABLES` 反转并特殊处理 `member_fact_revisions`；复制/清空正确性依赖此顺序。
   - `src/server/db/migrate-data.ts:358-380`：`PG_BUSINESS_SCHEMA_MIGRATIONS` 为 PG 私有 v1–v6 DDL + 共享 v7–v21；生产 `migrations` 不动。新迁移若要覆盖 PG，必须同时进入生产数组与 PG 镜像数组。
   - `src/server/db/migrate-data.ts:383-385`：`M1_READ_PLAN` 用 `BUSINESS_TABLES` 与两方言 catalog 列表，并带 `validateDecisionStorageGraph` / `validateWorkEventInvalidations`；新对象引用若参与关系校验，必须纳入验证边界。

2. **purge impact 逐表 capture**
   - `src/server/db/purge-impact.ts:34-42`：`purgeImpactDigest` 按 `schema_migrations` 版本门控，`capture()` 对每张表 `SELECT *` 后按 `canonicalRow` 排序进 sha256。
   - `src/server/db/purge-impact.ts:18-27`：`ignored` 只列出已声明的易变字段；新表若含身份/引用事实，不得随意加入忽略列表。
   - `src/server/db/purge-impact.ts:84-91`：v12 分支逐表 capture `memory_documents`、`memory_versions`、`memory_summary_requests` 及三张伴随表；项目与群组作用域分别处理。新表需增加 project / group 分支的 capture 并决定版本门控。

3. **repositories purge 删除顺序与 counts**
   - `src/server/db/repositories.ts:644-649`：项目 purge counts 中六类 memory 计数；`src/server/db/repositories.ts:686-690`：群组 purge counts 中四类 memory 计数。
   - `src/server/db/repositories.ts:1061-1115`：项目 purge 先校验 `expectedDigest`（:1065），再按「子 → 父」显式删除：summary/receipt/counter/checkpoint → versions → documents（:1078-1084），注释明确不依赖级联顺序（:1090-1091）。
   - `src/server/db/repositories.ts:1463-1508`：群组 purge 先校验 digest（:1467），再删 summary requests / work events / 三张群组表（:1483-1488），members 与 member_statuses 不动。
   - 新表须同时进入 counts、digest 捕获和显式删除顺序；否则确认清单与实际删除会不一致。

4. **58 表非空夹具**
   - `tests/helpers/decisions-migration-fixture.ts:17`：`DECISION_MIGRATION_TABLES` 固定 58 张表（已逐项计数核同）。
   - `tests/helpers/decisions-migration-fixture.ts:19-20`、`:139-141`：描述为「SQLite 原始 58 表非空源」，并在返回前对每张表断言 `count > 0`。
   - 方案一新增表需加入清单并种真实行；方案二加列需让夹具/校验理解新列，不能靠空值通过。

5. **内存 collector 冻结列清单与指纹**
   - `src/server/storage/maintenance/layout-memory-inventory.ts:13-18`：三张表名和列顺序被冻结，注释明确「New columns/OIDs need an explicit contract revision」；`:324-328` 用 `canonicalJson(table.columns) === canonicalJson(tableColumns[index])` 拒绝形状变化，并核对 `expectedCount` / 行多重集 digest。
   - `src/server/storage/maintenance/layout-memory-collector.ts:49-54`：同样冻结三表列清单；`:264-274` 对 SQLite/PG 原始列做固定形状校验；`:360-371` 在真实 SQLite catalog 上核对列数 ≤64 且规范化列等于冻结 manifest；`:243` 校验冻结 manifest 的 `ref === snapshots/${sha256}/database-manifests.json`；`:276-281` 另核对 manifest 字节长度、sha256、规范 JSON 及按固定结构重建一致。
   - `src/server/storage/maintenance/layout-memory-collector.ts:591-603`：`pgCatalogSection` 对固定目录段执行行数/字段边界/预算校验，并在 `section.sha256` 存在时用 `sha256(canonicalJson(rows))` 比对固定指纹；`:641-642` 另对 columns/indexes 做固定 profile 校验。具体列行见 `:473-520`，索引行见 `:537-551`。
   - 任一加表或加列都必须以**显式合同修订**更新冻结 manifest 与指纹，不能在运行时放宽 `unsupported_catalog`。

6. **guard manifest digest 与 admission**
   - `src/server/storage/schema-guards.ts:27-30`：`manifest(kind,tables)` 以协议号、方言、表清单和生成的 guard 定义计算 sha256；SQLite 覆盖除 `storage_maintenance`/`storage_source_clients` 外所有表（`:31-35`），PG 覆盖当前 schema 下普通/分区/外部表（`:62-66`）。
   - `src/server/storage/schema-guards.ts:48-52`、`:88-92`：`assertSqliteGuardCoverage` / `assertPostgresGuardCoverage` 比对状态中的 `guardManifestDigest`，不一致即 `guard_incomplete`。`:54-60`、`:94-99` 的 `extend*StorageGuards` 只允许在已准入的迁移真实事务内安装并更新 digest，禁止自动修复。
   - 方案一新增表会改变表集合与 digest，必须在赋号迁移事务内扩展；方案二仅加列，表集合不变，digest 本身不因加列改变，但仍不得绕过准入断言。
   - `src/server/storage/admission.ts:72-75`：`admission='open'` 时 `activeMigrationId` 与 `planDigest` 必须为 null；非 open 则必须齐全。`:113-117` 的 `assertStorageAdmission` 要求普通工作处于 open 且身份/epoch 匹配。本包不提出打开维护窗口，也不设置任何 activeMigrationId。

## 4. 迁移号、checksum 与冻结校验

- **v22 已被 M2 占用**：`src/server/identity/internal/m2-controlled-migration-contract.ts:1-4` 明确 #153 issuecomment-7021777100 接受 D01–D05，`kind: controlled-m22-value-definition`、`version: 22`、`name: profile_configuration_authority`（:20-22）；它是受控值合同，没有 `up/upPostgres`、不进入普通迁移数组，checksum 域为 `m2-fixed-phase-source/v1` SQLite `41d93b6d6ad261c5` / PG `aece9775f7cdfdda`（:27-31）。总控接受依据见 [#153 评论](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7021777100)。
- #161 仍 `UNASSIGNED`，且 ticket 明确「迁移号由总控串行分配」「不改旧 checksum」（issue #161 正文「依赖、产物与写入」「验收与完成」）。本设计不写死新号，不把 v22 当可复用号。
- 当前生产迁移数仍 **21**：`src/server/db/migrations/index.ts:35-455` 含 v1–v21，最大普通号见 `work-event-delivery-invalidations.ts:20`。本包不新增条目，`schema_migrations` 不变。
- **checksum 机制**：`src/server/db/migrate.ts:24-27` 先按方言解析 `upPostgres`（PG）或回退 `up`；`:182-187` 的 `checksumOf(sql)` 是 `createHash('sha256').update(sql).digest('hex').slice(0, 16)`。两方言独立；旧 checksum 不接受改动（`:79-87` 在迁移前校验已应用行的 checksum）。草案 SQL 尚未注册，故没有也不应生成正式 checksum。

## 5. 与冻结合同的偏差：待总控裁决项

已从 `src/server/storage/maintenance/layout-publication/fixed-sources.ts:10-11` 解出冻结的 `s4p-allowed-delta-contract/r1`（原文为 inert base64 字节，状态 `PROPOSED`）：

- `sourceCatalog: M2-P1-72-tables-763-columns`；
- `targetLogicalCatalog: S4-layout-73-tables-776-columns`；
- `rules` 含 `exact old cells and rowid`、`memory_documents` 追加上述 4 列、`memory_versions` 追加上述 2 列、`exact one user storage.layout.activate audit`、`exact registered migration only; none assigned here`、`core R30-R39 control and authority transfer unchanged`、`storage_layout_state seven exact logical fields`；
- `semanticRule: V09`、`callerAllowlist: forbidden`、`sourceRetiredLogicalCatalog: S4-source-retired-73-tables-770-columns`。

裁决项：

1. 选方案一（不改旧列、新增引用表）还是方案二（4+2 加列）。方案一偏离 `targetLogicalCatalog` 的 73 表/776 列与显式加列规则；方案二与合同一致但必须修订 collector/inventory 的冻结列与 PG 指纹。
2. 若选方案一，`s4p-allowed-delta-contract/r1` 是修订、取代还是另立并行合同；`S4-source-retired-73-tables-770-columns` 与源/目标目录如何重述。
3. 新列/新表在激活前是否允许 NULL、是否回填，以及「exact old cells and rowid」的验证边界。
4. 赋号时机与 #152 产物释放、#162 activation binding 的先后关系；迁移数从 21 递增的具体号码。
5. 58 表夹具、memory collector 冻结 manifest / PG 指纹、guard digest 的更新由哪份合同授权，并要求独立需求轴与标准轴复审。

## 6. 双库 DDL 草案（未注册、临时草案、不执行）

下列 SQL 仅用于表达候选形状，**未注册、临时草案、不执行**；不得复制到 `src/server/db/migrations/**` 或任何注册数组，也不得据此更新 `schema_migrations`。真实迁移必须待总控赋号、合同裁决、双轴审查和准确候选冻结后另行实现。

草案若涉及 global 形态，必须复述 `src/server/db/migrations/memory.ts:19-21` 的既有 CHECK：**global 必须 `agent_id IS NOT NULL AND project_id IS NULL`**（另两种形态见同段 CHECK）；不得为旧 wire global 扩权，旧文档仍按 note 保留，规则与自动摘要写权分离（issue #161）。以下引用表草案据此带上对应 CHECK。

### 6.1 方案一：独立对象引用表（未注册、临时草案、不执行）

```sql
-- 未注册、临时草案、不执行（SQLite）
CREATE TABLE memory_object_refs (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  CHECK ((scope = 'global' AND project_id IS NULL AND agent_id IS NOT NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL)
    OR (scope = 'project-agent' AND project_id IS NOT NULL AND agent_id IS NOT NULL)),
  document_kind TEXT NOT NULL CHECK (document_kind = 'note'),
  body_storage_id TEXT NOT NULL,
  body_object_format TEXT NOT NULL,
  body_content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  FOREIGN KEY (document_id, version) REFERENCES memory_versions(document_id, version) ON DELETE CASCADE,
  UNIQUE (document_id, version, document_kind)
);
CREATE INDEX ix_memory_object_refs_scope
  ON memory_object_refs (scope, project_id, agent_id, document_kind);
```

```sql
-- 未注册、临时草案、不执行（PostgreSQL）
CREATE TABLE memory_object_refs (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  CHECK ((scope = 'global' AND project_id IS NULL AND agent_id IS NOT NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND agent_id IS NULL)
    OR (scope = 'project-agent' AND project_id IS NOT NULL AND agent_id IS NOT NULL)),
  document_kind TEXT NOT NULL CHECK (document_kind = 'note'),
  body_storage_id TEXT NOT NULL,
  body_object_format TEXT NOT NULL,
  body_content_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  FOREIGN KEY (document_id, version) REFERENCES memory_versions(document_id, version) ON DELETE CASCADE,
  UNIQUE (document_id, version, document_kind)
);
CREATE INDEX ix_memory_object_refs_scope
  ON memory_object_refs (scope, project_id, agent_id, document_kind);
```

草案约束出处（均非注册内容）：`project_id → projects(id) ON DELETE CASCADE` 对齐 `memory.ts:11`；`version >= 1` 与 `UNIQUE (document_id, version)` 对齐 `memory.ts:30,41`（PG 对应约束索引见 `layout-memory-collector.ts:550`），因此引用表可用 `(document_id, version)` 复合外键指向结果版本并在版本删除时级联，父版本删除语义与 `memory.ts:29` 的 `ON DELETE CASCADE` 一致；`document_kind = 'note'` 取自当前实际枚举 `layout-memory-inventory.ts:37` 与 `src/server/memory/read-projection.ts:14` / `src/server/memory/publication-plan.ts:14`，后续若冻结新 kind 须走合同修订，不在本草案自行扩值。两方言草案仍为**未注册、临时草案、不执行**。

### 6.2 方案二：旧表 4+2 加列（未注册、临时草案、不执行）

```sql
-- 未注册、临时草案、不执行（SQLite）
ALTER TABLE memory_documents ADD COLUMN document_kind TEXT;
ALTER TABLE memory_documents ADD COLUMN body_storage_id TEXT;
ALTER TABLE memory_documents ADD COLUMN body_object_format TEXT;
ALTER TABLE memory_documents ADD COLUMN body_content_sha256 TEXT;
ALTER TABLE memory_versions ADD COLUMN body_storage_id TEXT;
ALTER TABLE memory_versions ADD COLUMN body_object_format TEXT;
```

```sql
-- 未注册、临时草案、不执行（PostgreSQL）
ALTER TABLE memory_documents ADD COLUMN document_kind TEXT;
ALTER TABLE memory_documents ADD COLUMN body_storage_id TEXT;
ALTER TABLE memory_documents ADD COLUMN body_object_format TEXT;
ALTER TABLE memory_documents ADD COLUMN body_content_sha256 TEXT;
ALTER TABLE memory_versions ADD COLUMN body_storage_id TEXT;
ALTER TABLE memory_versions ADD COLUMN body_object_format TEXT;
```

草案列均不加 NOT NULL、不回填、不改旧单元格；若合同裁决要求 NOT NULL 或回填，需重开 §5 裁决项。草案不含 guard 扩展、purge、夹具或 collector 同步代码，不能独立执行。

**checksum 登记办法（仅说明，不执行）**：赋号后分别取 `migrationSql(migration,'sqlite')` 与 `migrationSql(migration,'postgres')`，各自计算 `sha256(sql).hex().slice(0,16)` 并绑定到该方言已应用行；两方言独立，互不复用，旧迁移 checksum 一律保持不变。M2 v22 的 `m2-fixed-phase-source/v1` 是另一受控域，不与普通迁移 checksum 混用。

## 7. 下一片候选（候选 B：赋号后惰性只加表）

本片不实现。候选 B 的范围限定为：**总控赋号后**，在双库惰性创建经裁决的新表／新列结构；不回填、不切换默认读写、不激活 v2、不改旧 markdown 权威。

### 7.1 进入判据

- #152 命名产物已释放，#161 迁移号由总控明确分配，v22 仍归属 M2；
- §5 裁决项有书面结论，`s4p-allowed-delta-contract` 或替代合同的修订已冻结；
- #162 activation binding 的接口边界已确认，候选 B 的改动不提前实现其激活逻辑；
- 真实候选固定提交/tree、独立需求轴与标准轴审查完成。

### 7.2 验收判据

1. 迁移只注册于总控分配的单一号码；SQLite/PG catalog 各自 checksum 按 `sha256(sql).hex().slice(0,16)` 独立计算；`schema_migrations` 仅追加该行，v1–v21 旧 checksum 不变，迁移数按赋号递增。
2. 旧读写路径与 v1 权威不变；未激活时旧 markdown 仍可完整读写，DB head 不领先耐久正文，新结构没有隐式成为权威；旧 wire global 仍 Agent 私有、不扩权，旧文档按 note 保留，规则与自动摘要写权分离（issue #161）。
3. M1 `BUSINESS_TABLES` / PG 镜像 / `M1_READ_PLAN`、`REVERSE_TABLE_ORDER` 覆盖新增结构；双库 copy/clear 往返保持非空表真实行与顺序。
4. `purgeImpactDigest` 的项目/群 capture、`projectPurgeCounts` / `groupPurgeCounts` 与显式 DELETE 顺序一致；`expectedDigest` 变化能阻止删除。
5. 58 表夹具扩展后每张表仍有真实非空行；memory collector 的冻结列清单、冻结 manifest 与 PG 固定指纹按显式合同修订更新，旧形状拒绝仍有效。
6. guard manifest digest 在准入事务内扩展并回读一致；`admission='open'` 约束与 activeMigrationId/planDigest 关系不被放宽；`guard_incomplete` / `metadata_invalid` 仍按原语义失败。
7. 适用 SQLite/PG、协议与文件系统证据分开记录；未实测项保持 `unsupported` / NOT_RUN，不声称切换已完成。

### 7.3 主要风险

- 目录漂移：新表/新列改变 58/73/776 基线，冻结 manifest 或 PG 指纹若未同步会被 collector 拒绝；
- 双权威：v2 未激活时若新 ref 被当作正文来源，会与旧 markdown 冲突，且 DB head 可能领先耐久对象；
- 维护遗漏：purge 顺序、counts、impact digest 或 M1 反向清理任一漏项，会造成确认清单与实际删除不一致；
- guard/admission：新增表未纳入 manifest 或在非 open 状态下扩展，会造成 `guard_incomplete`，不得靠关闭门禁修复；
- 号段冲突：误用 v22 或提前占用未授权号码，与 M2 受控值合同冲突；
- 回填与耐久：惰性创建后若 old 行无 ref，#162 激活必须有可验证的回退/拒绝路径，不能在候选 B 中静默补齐或宣称已完成对象权威迁移。

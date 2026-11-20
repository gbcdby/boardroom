# 存储维护命令

状态：已确认。日期：2026-11-18。

本页说明旧 v1 来源的维护计划、查看、执行、恢复和取消入口。维护快照达到 `snapshot_ready` 后，源仍处于维护封存状态；这一步不激活新存储布局。后续数据转换、目标发布和正常服务启动分别遵守各自的交付合同。详细规格、当前资格和发布结论以 [S4-T2 / #152](https://github.com/gbcdby/boardroom/issues/152) 为准。

命令存在、计划保存成功、工程测试通过都不表示当前主机具备生产维护资格。实际执行仍会检查所选源、原生文件系统能力、写者退出、数据库状态、持久化和隔离恢复。遇到 `unsupported_durability`、`backup_capability_unavailable` 或未知写者时，应按结果解决相应条件，不能修改 journal、资格记录或源控制表来让检查通过。

## 1. 选择来源并保存计划

使用项目要求的 Node.js 24，从已知的原启动目录运行命令。配置选择规则见[环境解析与旧数据来源预检](environment-resolution.md)。先查看来源清单：

```bash
node scripts/inspect-storage.ts --legacy-cwd /absolute/legacy-project
```

`inspect-storage` 读取已知配置、文件头及迁移元数据，不打开 SQLite 或连接 PostgreSQL。`--legacy-cwd` 可以重复，以补充明确已知的旧启动目录；它不会全盘搜索。确定唯一所选源后，记录清单中的 `selectedSourceId`。维护命令的 `--expected-source-id` 必须与本次重新解析的选择一致。

以下路径和值均需替换为实际值；路径参数必须是绝对路径：

```bash
node scripts/storage-maintenance.ts plan \
  --expected-source-id '<selectedSourceId>' \
  --control-root /absolute/maintenance-control \
  --target-root /absolute/planned-target \
  --legacy-cwd /absolute/legacy-project
```

`plan` 是逻辑只读预览，会打开所选数据库以观察计划所需信息；它不同于不连接数据库的 `inspect-storage`。预览返回表计数、所需能力与阻断项，不保存计划，也不授权后续执行。

明确选择后，使用同一组来源与路径参数保存不可变计划：

```bash
node scripts/storage-maintenance.ts persist-plan \
  --expected-source-id '<selectedSourceId>' \
  --control-root /absolute/maintenance-control \
  --target-root /absolute/planned-target \
  --legacy-cwd /absolute/legacy-project \
  --output-version 2
```

保存结果在计划持久化、重新读回和资源关闭后输出。`executionAuthorized` 仍为 `false`。若命令失败，控制根中可能已存在计划产物；先核对实际来源与控制根，不根据失败退出推断所有写入都已回滚。

`persist-plan` 的默认输出以及显式 `--output-version 1` 保持原 v1 字段集合。准备后续维护命令时使用 v2，以同时取得持久计划中的 `expectedSource`。该选项仅属于 `persist-plan`，其他命令不接受；未知或重复参数会在解析阶段拒绝，只有 `--legacy-cwd` 可重复。

## 2. 后续命令的固定输入

`inspect`、`execute`、`resume`、`cancel` 都需要同一份持久计划及来源绑定。输入对应如下：

| 参数 | 来源与含义 |
| --- | --- |
| `--expected-source-id` | 来源清单与 `persist-plan` 输出的 `source.sourceId` |
| `--control-root` | 保存该计划所用的控制根 |
| `--target-root` | 该计划所选的目标根 |
| `--migration-id` | 保存结果的 `migrationId` |
| `--plan-digest` | 保存结果的 `planDigest`，64 位小写十六进制 |
| `--plan-bytes` | 保存结果的 `planRef.bytes`，保留十进制字符串 |
| `--expected-source-kind` | v2 保存结果的 `expectedSource.kind`，`sqlite` 或 `postgres` |
| `--expected-database-instance-id` | v2 保存结果的 `expectedSource.databaseInstanceId` |
| `--expected-source-identity-digest` | v2 保存结果的 `expectedSource.identityDigest` |
| `--data-dir`、`--legacy-cwd` | 需要时沿用原来源选择；均为绝对路径，后者可重复 |

命令根据摘要确定控制根下的不可变计划位置，再检查实际内容与来源。不要传入 inline plan、任意备份路径、SQL、模块路径或成功标志；这些不属于入口参数。

以下 Bash 数组仅用于避免后续例子重复列出参数。将占位值替换为上表中的实际输出：

```bash
maintenance_args=(
  --expected-source-id '<selectedSourceId>'
  --control-root /absolute/maintenance-control
  --target-root /absolute/planned-target
  --migration-id '<migrationId>'
  --plan-digest '<planDigest>'
  --plan-bytes '<planRef.bytes>'
  --expected-source-kind '<expectedSource.kind>'
  --expected-database-instance-id '<expectedSource.databaseInstanceId>'
  --expected-source-identity-digest '<expectedSource.identityDigest>'
  --legacy-cwd /absolute/legacy-project
)
```

## 3. 查看、执行与恢复

查看指定计划的已验证状态：

```bash
node scripts/storage-maintenance.ts inspect "${maintenance_args[@]}"
```

`inspect` 不接收 request ID 或预期 head，也不通过查看来登记新 controller、修补 journal 或推进阶段。需要查看尚无持久计划的来源时使用 `inspect-storage`。返回的 `observedAnchor` 是一次只读观察，`authority` 为 `observation-only`；它不是持锁许可，后续写命令必须重新核对。

历史 `snapshot_ready` 仍可能有当前阻断。`source_writer_active` 表示所绑定的原进程仍在运行；`source_writer_unknown` 的具体诊断会区分原生身份无法读取，以及原进程已退出但尚未记录结束观测。前者需要先解决身份读取条件；后者可在原进程正常退出后，使用新的 request ID 和当前 `observedAnchor` 发起 `resume`。只读查看和同 key 回读不会补写结束事件，新命令会重新核对实际来源并完成所需的隔离恢复验证。

写命令另外需要三个参数：

| 参数 | 规则 |
| --- | --- |
| `--request-id` | 本次命令的稳定标识，1–100 个英文字母、数字、下划线或短横线 |
| `--expected-phase` | 本次命令开始前的准确阶段：`planned`、`quiesced`、`snapshot_ready`，或无 journal 时的 `none` |
| `--expected-journal-digest` | 同一次观察对应的准确 journal SHA-256，或无 journal 时的 `none` |

两个 `none` 必须同时使用，且只适用于真实尚无 journal 的起点。来源、计划或 head 已变化时，命令会拒绝旧预期，不会覆盖新的状态。

首次执行示例：

```bash
node scripts/storage-maintenance.ts execute "${maintenance_args[@]}" \
  --request-id maintenance-execute-001 \
  --expected-phase none \
  --expected-journal-digest none
```

一次命令会在固定维护执行器中按已验证状态继续实际工作。调用者应等待命令退出，并同时检查 JSON 的 `result`、`failure` 和进程退出码；收到某个阶段结果或子进程发出结果帧，都不能替代完整资源收尾和实际退出。

重试和继续前进是两种不同操作：

- **重试同一次请求：**保留相同命令、request ID 和全部原输入，包括原 expected phase/head。服务只识别已锚定的合法请求前缀，不把同一个 key 当成新的推进请求。相同 key 携带不同输入会被拒绝。
- **在确认状态后继续：**先查看准确状态，再发起新的 `resume` 请求，使用新的 request ID 以及本次观察的 phase/head。服务重新观察源、旧 controller、事务和 native 资源，满足条件后才继续。

```bash
node scripts/storage-maintenance.ts resume "${maintenance_args[@]}" \
  --request-id maintenance-resume-002 \
  --expected-phase '<observedAnchor.phase>' \
  --expected-journal-digest '<observedAnchor.journal.sha256>'
```

不要把执行到一半的超时、连接断开或进程退出理解成事务必然回滚。若 COMMIT 结果、后端退出或资源关闭仍未知，保留原控制根与结果，等待实际资源状态可被确认；再次命令仍可能返回 `maintenance_busy` 或 `recovery_required`。不要删除锁、强杀身份未确认的进程、手动改控制表，或换 request ID 绕过未完成的收尾。

## 4. 取消与重新启动

`cancel` 只用于已经建立合法封存证据的 `quiesced` 或 `snapshot_ready` 状态；它不能把尚未建立该证据的 planned 状态当作安全取消。使用新 request ID 与准确观察值：

```bash
node scripts/storage-maintenance.ts cancel "${maintenance_args[@]}" \
  --request-id maintenance-cancel-003 \
  --expected-phase '<observedAnchor.phase>' \
  --expected-journal-digest '<observedAnchor.journal.sha256>'
```

取消先记录 intent，再在真实安全停止条件成立后提交独立 terminal。intent 已锚定而终结未确认时返回 `cancel_pending`；这时不能继续普通 advance 或发布 ready。恢复命令会按取消状态完成应有的终结，不将它解释为继续迁移。

只有 `cancelled` 表示已确认的终结结果，并给出 `terminalJournal`、新的 `openedFenceEpoch` 和 `restartRequired: true`。开放源与 fence epoch 前进属于同一原子终结；原服务、旧 source client 或旧 receipt 不会因此自动恢复写权限。按正常停止/启动流程重新打开原来源，让新客户端走原 admission/claim 流程。不要复用旧进程或旧 epoch 证明。

## 5. PostgreSQL 的隔离校验目标

源 PostgreSQL 仍由原配置及 `AGENT_STUDIO_PG_CONNECTION_STRING` 选择。实际恢复校验另需一个明确准备好的专用目标，其完整凭据通过固定 worker 的可信启动环境提供：

| 环境变量 | 作用 |
| --- | --- |
| `AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_CONNECTION_STRING` | 专用 verification 数据库的显式连接串 |
| `AGENT_STUDIO_MAINTENANCE_PG_VERIFICATION_SCHEMA` | 可选 schema；省略时为 `public` |

schema 必须与源一致；省略不会从源推导。只设置 schema、空连接串或非法 descriptor 会拒绝。SQLite 不使用这两个变量。缺少 verification 配置不会自动建立数据库、选用源库或改用计划中的未来 active 目标。

通过本地可信凭据配置设置连接串，不把真实密码放进 request ID、命令参数、journal 或公开日志。worker 解析配置后，adapter 还会实际检查目标与源的物理身份不同、目标空目录与会话状态、角色/权限、advisory lock、fsync/recovery 以及恢复后的完整内容。连接串可解析不等于目标已验证。

`public` 恢复沿用固定 PG16 原生工具与完整 TOC 校验，在一个事务中恢复允许的 schema 内容，保留 owner、ACL 和 comment。具体工具版本要求见[开发与检查](../README.md#开发与检查)及当前候选能力声明。原 300 秒 public 恢复成功期限与真实 child/backend 收尾要求保持；超时后的清理可继续等待，但不能延长成功预算或重新报告成功。

## 6. 结果与下一步

| `result.status` | 操作者应如何理解 |
| --- | --- |
| `paused` | 返回已验证的 `planned` 或 `quiesced` 进度。保留引用，需要推进时重新观察并使用新的 resume 请求 |
| `snapshot_ready` | 已验证的维护快照可供后续受信流程使用；源仍封存，尚未激活新存储 |
| `blocked` | 本次检查未满足条件；查看安全 blocker，解决原因后再观察 |
| `recovery_required` | 存在需要核实的 journal、提交或资源状态；先恢复准确观察，不推断已回滚 |
| `cancel_pending` | intent 已存在，安全停止或原子终结尚未确认；保持取消语义继续恢复 |
| `cancelled` | 终结已确认，按 `restartRequired` 重新启动原来源；旧客户端和旧 epoch 仍失效 |

`failure` 非空，或结果为 `blocked`、`recovery_required`、`cancel_pending` 时，CLI 以非零退出码结束。其他状态仍须结合其含义判断，不能仅以退出码 0 推断迁移完成。安全输出保留稳定错误码与必要引用，不公开 DSN、配置正文、原生工具 stderr 或内部凭据。

新进程复用历史 ready 时仍需重新核对实际来源、控制历史和隔离恢复，历史 snapshot/receipt 不是可转交的运行许可。保留计划、journal 与维护产物，后续消费只通过项目提供的受信入口完成；本页不提供任意 callback、插件加载、HTTP 或 MCP 执行维护的通道。

## 7. Linux SQLite 路径观察组件

开发和维护诊断可单独构建一个 Linux SQLite 扩展，用于在实际只读连接上观察 `main` 的当前 VFS 路径是否移动。使用项目锁定的依赖，在仓库根目录运行：

```bash
node scripts/build-sqlite-path-check.mjs
```

该命令仅支持 Linux x64/arm64，固定使用 `/usr/bin/cc` 和已安装的 `better-sqlite3` 所带头文件；它不下载依赖，也不接受编译器、扩展或目标路径参数。编译进程使用固定环境，不继承 `CC`、`CFLAGS`、`CPATH` 等搜索或注入变量。原 postinstall 与其他平台构建流程保持原有职责。

组件写入本仓库的 `build/maintenance-platform/sqlite-path-check-linux-<arch>/`。二进制和 manifest 分别按完整 SHA-256 保存在不可变位置，最后原子发布 `current.json`。并发构建遇到已有构建锁会失败；失败不会删除其他 attempt 的锁、原有代际或已发布 manifest。源码、依赖或构建脚本变化后应重新运行该固定命令，不能手工改 manifest 让旧产物匹配。

内部零参数入口 `inspectSelectedSqlitePathBinding()` 使用既有环境解析器重新选择来源，自行打开已存在的只读 SQLite 连接。需要从仓库根目录直接做一次观察时，可以运行：

```bash
node --input-type=module -e 'const {inspectSelectedSqlitePathBinding} = await import("./src/server/storage/internal/sqlite-path-observation.ts"); console.log(JSON.stringify(await inspectSelectedSqlitePathBinding()));'
```

来源由原配置、环境变量和当前启动目录选择，规则仍见[环境解析与旧数据来源预检](environment-resolution.md)。缺失来源或选择冲突会拒绝；入口不会新建数据库、执行 migration 或自动安装组件。它核对所加载组件、源文件 pin 和目录身份，并在同一只读事务内对读取前后进行路径观察。SQLite 自身仍可能涉及 WAL/SHM 的读取或锁行为，因此“只读”描述的是数据库逻辑操作。

成功结果的 scope 为 `sqlite-main-path-observation/v1`，只包含源路径、pin 的 device/inode、组件摘要、路径观察和 schema version。只有数据库及本次持有的文件描述符都已确认关闭，才返回 `retirement: "closed"`。若关闭结果未知，进程保留实际 owner 和仍需要的资源，后续本入口返回 `native_retirement_unknown`；调用者不能以传入确认值、定时等待或重复调用来宣告退休。

`HAS_MOVED = 0` 只表示当前 VFS 路径观察通过。它不返回 SQLite 实际数据库 FD，也不能排除“路径替换后恢复”的 ABA 窗口；单独打开的源 pin 不能消除这个限制。本结果不授予 P1 准入、写权限或生产 native 资格，后续同连接准入、terminal/CF17 和完整 G1 仍须完成各自合同。

## 8. SQLite 原始行与元数据关联观察

SQ-D02 I02 提供有限的五表观察组件。接受来源为 [#153 的 SQ-D02 设计](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7026485094)。它能够观察原始 SQLite 格、控制行、authority 与 receipt 的值关联；成功的固定范围是 `raw-and-metadata-links`，不会授予准入或产生 writer。

| 入口 | 输入与读取来源 | 成功结果的范围 |
| --- | --- | --- |
| `inspectSqliteProfileAdmissionValue(input)`，位于 `identity/sqlite-profile-admission-values.ts` | 仅 primitive JSON 字符串；调用方提供的脱离数据库 DTO | 严格原始值与可在 DTO 内核对的元数据关联；没有 native 证明 |
| `inspectSelectedSqliteProfileObservation()`，位于 `storage/internal/sqlite-path-observation.ts` | 零参数；沿既有环境解析器自行选择并打开实际已存在的 SQLite | 在同一实际只读连接、同一事务取得 DTO，再用同一请求预算计算上述有限观察，实际退休后返回 |

原生入口复用上一节的固定 Linux 组件。构建完成后，在仓库根目录运行：

```bash
node --input-type=module -e 'const {inspectSelectedSqliteProfileObservation} = await import("./src/server/storage/internal/sqlite-path-observation.ts"); console.log(JSON.stringify(await inspectSelectedSqliteProfileObservation()));'
```

该入口不收 path、数据库句柄、SQL、callback、预算、验证器或已通过标记。它不创建缺失数据库，不执行 migration，不登记格式或 native tuple。成功结果包含 `pathObservation`、`observation`、`retirement: "closed"` 和 `sourceFileDescriptorQualification: "not_qualified"`。其中 `observation.nativeSource: "not_run"` 保留纯值核自身没有原生证明的含义；外层只增加实际路径和读事务观察，仍受上一节的 VFS/ABA 限制。

### 固定 DTO 与物理布局边界

DTO 的根键精确为 `contract`、`sourceKind`、`textEncoding`、`columns`、`control`、`authority`、`activationReceipts`、`migrations`、`clients`。contract 是 `sqlite-profile-admission-observation/r1`，sourceKind 是 `sqlite`。各表部分精确为 `{rows:[{rowid,cells}]}`。`columns` 必须列出固定五表的完整列全序；不能扩展查询。rowid 是 canonical signed int64 十进制字符串，INTEGER 主键格还必须与其一致。

| 固定表 | DTO 部分 | 列数 |
| --- | --- | ---: |
| `storage_maintenance` | `control` | 15 |
| `storage_source_clients` | `clients` | 17 |
| `config_authority` | `authority` | 5 |
| `config_activation_receipts` | `activationReceipts` | 17 |
| `schema_migrations` | `migrations` | 4 |

`profile: "P0"` 在该固定 DTO 中只表示 protocol 1、精确迁移账本 1–21、没有 authority/receipt/terminal 的元数据分类。三编码原生正例使用的是 **15/17 列的 protocol 1 形状 fixture**，不证明原物理 P0 布局已受支持。旧 control 14 列、client 16 列且没有 authority/receipt 表的数据库，在本有限 reader 中明确返回 `source_contract_mismatch`，保持原数据库不变。既有 P0 driver 和 strict1 parser 继续处理其原路径；它们没有被接到本观察入口或放宽。

P1 元数据观察要求 protocol 2、唯一 authority singleton、local source binding、对应 receipt 的完整 17 格及 canonical payload/digest 冗余、当前 guard digest 与 receipt writer pair、精确受控迁移 22，以及原 control counter/anchor 组合。client17 保留原 storage type、NULL、rowid、日期和编码字节，并检查源 UUID、基础 counter 与格式配对。真实 host/process/session 归属、完整 CF 生命周期和引用的 physical/capture/upgrade 产物内容仍未执行。

sealed P1 加 terminal NULL 返回 `phase: "sealed-awaiting-b"`；这仍拒绝业务准入。open P1 加 NULL、错 authority/receipt/source、混合格式会失败；没有 P0/fresh 回退。terminal-present 使用 [I03 的原八键解码核](profile-terminal-values.md)，沿同一个 `AuditRequest` 检查原 canonical 文本、安全 epoch+1、activation/receipt、takeoverPlan，以及当前 q/ref/digest 与 terminal 锚、open 和 epochAfter 的关联。当前锚恰为 terminal 时可以返回 `phase: "terminal-present"`；后来窗口需要完整 current-window replay，在本有限 reader 中仍为 `unsupported_shape`，不能仅靠 E/q 单调接受。

上述结果没有读取 durable terminal 图，也没有核对引用的 physical source/capture/upgrade 等实际产物内容。输出明确保留 `terminalClosure`、`finalSchemaAndGuards`、`clientLifecycle` 为 `not_run`。原生有限 P1 fixture 另验证了 raw 读取、组件 JSON 和 terminal 解码始终只有一个真实请求预算；该 fixture 不被标记为完整合法 P1/S1/G1 或 native 资格正例。

### 固定查询与生产前计费

`sqlite-profile-read-source.ts` 保留接受原件的 **32 条 SQL**，原件为 66,179 bytes、SHA-256 `802d88a34b9ac31f22072fb8a95e05e3e009e5558b4a61d12392e6e895d62713`。为落实实际列目录检查，另有 **10 条固定派生读**：每表一条 `Q-COLUMN-METADATA-*` 和一条 `Q-COLUMNS-*`。组件 manifest 因而明确记录总计 **42 条 SQL、29 条只读查询、32 条原件查询、10 条派生目录查询、5 表、58 列**，并包含派生 SQL 的 bytes/SHA。其余固定 C 程序仅为惰性来源，没有开放执行器。

所有表读取和目录读取明确限定 `main`。派生目录先读取 `sqlite_schema.sql` 的类型和 `octet_length`，按长度预付 SQLite 内部目录字段、比较和结果开销，再执行只返回一个布尔值的精确 cid/name/type/notnull/default/pk/hidden 比较。额外列、缺列、错误类型、默认值、主键或隐藏列都不能只靠已知列名通过；这仍不是完整 S1/G1 schema 或 guard manifest 验证。

每张表逐 rowid 执行固定 FIRST/NEXT metadata 查询，每次最多一行，包含最后一次空结果；不会 `.all()` 导出全表。metadata 使用直接 `typeof(column)` 和 `octet_length(column)`。本轮实际 SQLite bytecode 检查确认对应 Column flags 为 128/192，metadata 中没有 CAST/hex payload producer。各格类型、字节数、单格限制、累计范围和预算核对完毕，才能执行同事务、同 rowid 的 Q-VALUE。

| 生产者 | 同一请求中的前置收费 |
| --- | --- |
| 组件文件、资源 owner、关闭记录 | 有限路径/owner/收尾记录先预付；文件按 stat 大小预付读取、分配、摘要及 JSON 工作 |
| metadata | 固定列数决定 native/JS wrapper、字段数、类型字符串和 int64 长度上界；空结果也付费 |
| text 原值 | 分别预付 CAST 读/拷贝、hex 原字节读与两倍输出、lower 读/写、native 到 JS 读/拷贝，之后才运行值查询 |
| semantic decode | 沿同一个 `AuditRequest` 继续核 raw hex、fatal UTF-8/UTF-16le/UTF-16be 解码、原字节 roundtrip、JSON、摘要及关联 |
| 输出和退休 | 成功结果完整 measure 后预付冻结/序列化；ROLLBACK、close、有限失败与退休 owner 已提前保留资源 |

原 limits 保持不变：input 16 MiB、单 raw 4 MiB、rawTotal 8 MiB、field 32 KiB、output 1 MiB、nodes 250,000、depth 64、rows 100,000、characters 64 MiB、work 4,000,000。原失败输出的 characters 2,048/work 128 预留也保留。原生读取和纯值消费不重置请求；相同请求内实际产生的不同拷贝与遍历分别付费。

超大 TEXT 和错误 BLOB storage 的实际反例在第一次 raw value get 之前失败。WAL 并发提交反例确认 metadata/value 读保持同一连接、同一快照。预算失败加 close 未知时，私有 owner 仍保留原 `resource_limit`、关闭失败及实际 DB/文件描述符；后续调用拒绝新开资源。派生私有故障观察与原入口的正常运行证据分开记录，不作为完整原生资格。

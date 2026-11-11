# 环境解析与旧数据来源预检

本文件说明当前兼容阶段的实际行为。统一入口是 [`resolveBoardroomEnvironment`](../src/server/environment.ts)，旧调用方仍可使用 [`loadConfig`](../src/server/config.ts)。HTTP、stdio、管理命令、托管运行时的管理目录和记忆读取辅助进程共用解析结果。

当前阶段仍使用 v1 数据库及数据库内记忆正文。没有新增业务 schema、移动数据或启用 v2 存储；`~/.boardroom` 下的新目录多数是规划位置。相关需求与后续迁移合同见 [S4 #128](https://github.com/gbcdby/boardroom/issues/128)，本阶段实施范围见 [#132](https://github.com/gbcdby/boardroom/issues/132)。

## 配置和路径选择

1. 内部调用方可以提供完整 `AppConfig`。它是可信装配参数，不接受 HTTP/MCP 任意路径输入；不会重新加载配置文件或环境变量。旧的手工配置对象、测试的 `port: 0` 继续可用。
2. `BOARDROOM_HOME` 必须是绝对路径；未设置时采用系统用户目录下的 `.boardroom`。解析器不会改写 `HOME`。
3. 配置文件依次为显式 `AGENT_STUDIO_CONFIG`、`<homeRoot>/config.json`、旧 `<cwd>/config.json`。显式文件缺失、不可读或 JSON 无效均报错，不退回另一份配置。显式选择后不再加载当前 cwd 的另一份默认配置。
4. 环境变量覆盖对应文件字段。显式空字段同样进入字段校验，不能借空值悄悄回到另一个源。SQLite/PostgreSQL 选择与所有原有心跳、防环、记忆限额设置仍由共同配置解析处理。
5. v1 文件的相对 `dataDir` 和旧环境变量中的相对 `AGENT_STUDIO_DATA_DIR` 仍以本次原启动 cwd 为基准。v2 文件里的相对资源路径以配置文件目录为基准。最终 descriptor 固定规范绝对路径。

因此，需要从不同 cwd 指向同一旧数据库时，请把旧配置里的 `dataDir` 或 `AGENT_STUDIO_DATA_DIR` 固定为绝对路径。显式 v1 配置文件的位置本身不会改变旧相对路径的含义。

```sh
AGENT_STUDIO_CONFIG=/absolute/path/config.json node src/server/index.ts
AGENT_STUDIO_CONFIG=/absolute/path/config.json node src/server/mcp/stdio.ts
```

合法 fresh v1 仍允许沿用原 `<cwd>/data` 初始化行为。配置错误、歧义、恢复状态或未激活 v2 都会在连接、迁移、建目录前被拒绝。stdio 诊断只写 stderr，stdout 留给 MCP 协议；HTTP 进程的配置拒绝也输出稳定错误码和恢复动作。

## 解析结果与消费者

`ResolvedBoardroomEnvironment` 包含 `layoutVersion`、`homeRoot`、`configFile`、`stateRoot`、`skillsRoot`、`memoryRoot`、`runtimeRoot`、`workspacesRoot`、`artifactsRoot`、`storageId`、`databaseDescriptor`、`startupState`、`paths`、`protectedPaths`、`diagnostics`、`inventory` 和有效 `config`。

| 字段或范围 | 当前含义 |
| --- | --- |
| `config.dataDir` | 已选择的 v1 管理数据目录；保持兼容，不从新根推导替代空库 |
| SQLite `databaseDescriptor.sqlitePath` | 实际规范数据库文件，可以与管理目录分开，也可具有非默认文件名 |
| SQLite `sourcePath`、`identity` | 原入口和设备/inode 身份；用于连接前核实原文件及链接没有换源 |
| PG descriptor | 仅供可信连接装配及 IPC 持有连接串；不能把完整 environment/config 写入日志或接口响应 |
| `stateRoot`、`skillsRoot`、`memoryRoot`、`artifactsRoot` | v1 下是新布局的 `planned` 目标，未获准作为新的业务可写存储 |
| `runtimeRoot` | v1 继续为实际 `dataDir/managed`，标记 `legacy` |
| `workspacesRoot` | `planned`，与受保护范围分开；路径存在或解析成功不构成项目 RW 授权 |
| `storageId` | 配置声明的实例 ID，可能为 null；单凭此字段不代表新存储已激活 |
| `writable` | 是否允许本版本沿用选中的 v1 源；真正启动还会核实文件身份及实际目录权限 |

`loadConfig` 会调用 `assertEnvironmentWritable`，然后将同一 environment 附到配置。`startServer` 对手工 `AppConfig` 也做相同解析和门禁。`databaseDriverOptions` 将 descriptor 交给驱动；SQLite 驱动连接前再次验证原路径、真实位置、设备/inode 及硬链接数，对已有文件使用 `fileMustExist`。移动、替换、符号链接改向或不可访问会返回 `storage_source_changed`，不会创建替代空库。解析后新增硬链接也会在连接门禁被拒绝。

SQLite 权限检查针对数据库的真实父目录，那里需要保存 WAL 辅助文件；管理目录有写权限不能代替真实父目录权限。路径规范化不会创建缺失目录，也不会把悬挂链接当成 fresh 目录。

服务连接成功后，`databaseForConnectedReader` 给 fresh v1 捕获刚建立文件的身份；只读记忆 helper 通过可信 IPC 接收相同来源，不读取配置、不从子进程 cwd 猜数据库。现有查询限额、超时、熔断、只读连接及 membershipRevision 守卫继续生效。

日志使用 `describeDatabase` 的显式白名单。SQLite 公开规范位置和文件身份；PG 只公开数据库种类、配置指纹及 `configuration_only`。指纹表示同一配置，不能证明连接成功、两个 DSN 指向同一物理数据库，或数据库格式已经激活。

## 来源发现与启动状态

`inspectLegacyStorage` 只检查所选源、当前或明确传入的旧启动目录，以及已解析的新目标位置。不递归扫描机器，不按修改时间选择，不打开 SQLite 驱动，不连接 PostgreSQL。SQLite 证据来自普通文件、16 字节格式头、大小、设备/inode、硬链接数和 WAL 是否存在；它不读取业务行或验证全库完整性。

| 状态 | 当前行为 |
| --- | --- |
| `fresh` | 没有已知已有源或新格式恢复证据；只允许兼容 v1 的原默认初始化 |
| `legacy_found`，当前源已命中 | 继续使用该确切旧源。显式配置或数据目录可作为多个纯 legacy 来源中的明确选择 |
| `legacy_found`，仅别处发现 | 当前源为空而另一个已知旧目录有库；拒绝新建空库，返回 `legacy_migration_required`，要求明确旧配置/绝对数据目录 |
| `ambiguous` | 多个未明确选择的旧源，或新旧不同源混存；拒绝写入，不合并、不按时间猜选 |
| `recovery_required` | 未完成/无法解析的 journal、悬挂迁移目录、格式证据缺失、storageId 不一致、维护标记、无效 SQLite 头或多硬链接数据库；返回相应恢复动作 |
| `active` | 保留给未来可核验的新格式激活状态。本实现没有 v2 数据库激活验证能力，因此不会返回此状态 |

只有规范路径和设备/inode 均相同的 SQLite 别名才会去重；普通符号链接因此沿用真实文件对应的 WAL。主数据库的硬链接数大于 1 时返回 `storage_source_ambiguous` 并要求恢复，即使只发现其中一个名字，也不能继续选择或连接。硬链接共享 inode，但不同文件名可能对应不同 WAL，不能由 inode 相同推断它们包含相同的已提交内容。操作方需停止相关连接，核对原数据库及其 WAL 的一致快照，恢复到唯一文件入口；预检不会删除硬链接或辅助文件。

只有真正不存在的迁移记录目录可以忽略。`state/migrations` 目录项存在但链接目标缺失时返回 `migration_incomplete`；目录不可读等访问错误同样阻断启动，不会新建目录或将其当成 fresh。显式旧目录刚好名为 `state` 不会因此被升级为 v2。反过来，显式选择旧源不能绕过新目标的维护、journal、storageId 或新旧混存问题。

`layoutVersion: 2`、配置和 `storage.json` 中相同的 storageId、`active: true` 或 journal 的 `completed` 文字都不是数据库激活证据。只有配置 storageId 却没有格式声明，或只有完成 journal 却缺少元数据，同样要求恢复。本阶段不创建新格式标记。

主要稳定错误为 `config_invalid`、`legacy_migration_required`、`storage_source_ambiguous`、`storage_root_mismatch`、`storage_maintenance`、`migration_incomplete` 和 `storage_source_changed`。`ConfigError` 提供 `code` 与 `recoveryAction`；错误不转发 JSON 原文、PG 连接串或底层可能包含凭据的异常。

stdio 对非配置类启动失败统一输出 `stdio_startup_failed` 和固定恢复指引，不转发驱动、迁移、传输或其他底层异常正文。该边界也覆盖非 Error 抛出值，不依赖连接串中特定凭据字段的名称或编码形式。

## 管理命令

只读来源预检输出可安全序列化的 inventory：

```sh
node scripts/inspect-storage.ts
node scripts/inspect-storage.ts --legacy-cwd /absolute/old/start-directory
node scripts/inspect-storage.ts --data-dir /absolute/old/data
```

`--legacy-cwd` 可重复。该命令不建立业务库、目录或 SQLite 辅助文件；其验收要求文件摘要和目录列表保持不变。对 PostgreSQL 只返回配置证据，不声称已核实业务记录。

历史宿主类型迁移预览也使用同一来源规则：

```sh
node scripts/migrate-other-to-dsh.ts --dry-run
node scripts/migrate-other-to-dsh.ts --data-dir /absolute/existing/data --dry-run
```

`--data-dir` 覆盖数据目录，但不会把选中的 PostgreSQL 改成 SQLite；该历史管理命令目前只支持既有 SQLite。缺库、未激活格式、歧义或恢复状态会拒绝操作，不初始化空库或自动执行 schema 迁移。正常执行仍是显式的历史 host-type 改写，不是 v2 数据迁移。

**SQL dry-run 与文件系统零写入预检有不同职责。** SQL dry-run 使用 `fileMustExist`、`readonly` 和 `query_only`，不改业务数据或主数据库文件，并正确读取已经提交到 WAL 的内容。SQLite 正常协调可能建立或更新 `-wal/-shm` 辅助文件；此命令不承诺目录完全不变，不删除这些文件，也不使用会忽略 WAL 的 immutable 主文件快照。需要文件系统零写入清单时使用 `inspect-storage`。

[`scripts/migrate-data.ts`](../scripts/migrate-data.ts) 的显式 source/target 语义保持独立；统一启动配置不替代迁移工具已指定的来源与目标。

## 边界与检查入口

受保护范围包括规划中的 state/skills/memory、配置、控制源码、实际旧数据及 runtime 管理目录。不能把整个 homeRoot 直接作为模型可写根；workspaces 和未来实例私有 session 还需各自的授权及实际隔离验证。这里的真实路径和权限预检不是固定 FD、别名防护、宿主 RW 隔离或资源租约证据。

回归入口为 [`environment.test.ts`](../tests/environment.test.ts)、[`environment-entrypoints.test.ts`](../tests/environment-entrypoints.test.ts) 和 [`environment-management.test.ts`](../tests/environment-management.test.ts)。它们覆盖来源不变、配置优先级、v1/v2 相对路径、恢复状态、脱敏、SQLite 换源拒绝、真实入口失败和跨 cwd 项目/记忆一致性；还需运行现有配置、驱动、HTTP/MCP 与记忆回归。POSIX 权限测试需要非 root 用户；真实 PostgreSQL、其他 OS 和最终集成结果按对应候选的实际 CI 记录，不从配置清单或 SQLite 结果推断。

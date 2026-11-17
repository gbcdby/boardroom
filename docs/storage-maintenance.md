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

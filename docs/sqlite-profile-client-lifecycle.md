# SQLite 隔离管理 client 生命周期组件

状态：已确认（有限组件范围）。日期：2026-11-20。具体实现候选的独立双轴审查与 CI 另记于 PR。

本组件落实 [#153 接受的 SQ-D02](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7026485094) 中 I04 允许独立交付的有限机制：实际 local-management B/C 资源、出生、完整 17 格 CAS、实际事务终态和 `C-NATIVE-END-OPEN`。它提供可重复运行的隔离诊断，没有生产源写入装配。

## 入口和结果

`src/server/storage/internal/sqlite-profile-client-owner.ts` 只有一个导出：

```ts
inspectIsolatedSqliteProfileClientLifecycle()
```

入口不接收参数。传入任何参数，包括 `undefined`、对象、Proxy 或回调，都会返回 `unsupported_shape`，不会读取参数。一次调用自行创建一个专属临时目录、独占 SQLite 文件和源文件描述符，然后实际运行完整的有限生命周期。它不会调用环境 resolver，也不会打开 selected existing source。

成功结果是冻结的 detached 值：

```ts
{
  ok: true,
  value: {
    scope: "isolated-sqlite-native-management-lifecycle",
    qualification: "component-only; not-P1-admission",
    birth: { rowid: string, cells: TypedCell[] },
    ended: { rowid: string, cells: TypedCell[] },
    transactions: { committed: 1, rolledBack: 1, notAdmitted: 0 },
    retirement: "closed"
  }
}
```

`birth` 与 `ended` 均包含原列序的全部 17 格；rowid、INTEGER 使用十进制字符串，TEXT/BLOB 使用原 UTF-8 字节的小写 hex。输出没有 owner、handle、SQL executor、可复用的准入标记或可由调用方传回的写能力。此处的 `closed` 只描述本次自有隔离资源的已知退休。

## 实际资源顺序

1. 工厂创建本次文件、pin 和 B；在该文件初始化明确标为隔离 fixture 的两张表，实际安装原三条 source-client guard SQL，另对 fixture control 禁止任何后续 DML。
2. 新短寿出生 C 在真实 `BEGIN IMMEDIATE` 中读取 control 和全部 clients，检查本次随机 client/process instance 未占用，按实际 `max(rowid)` 分配 rowid。
3. C 执行固定 `C-BIRTH`，完整 readback，再读取原 control。只有 COMMIT 已知并且 C 实际关闭后，B 才进入可执行有限观察事务的状态。
4. B 分别运行一次实际 ROLLBACK 和 COMMIT。每个 T 重新读取源、完整 control 和自己的 17 格。事务期间没有业务 DML，出生 session envelope 始终保留原三个零 counter；只有私有实际事务计数推进。
5. 终结先拒绝新事务并撤销 step/代际，实际关闭 B。只有 B 关闭已知，才打开新的短寿终结 C。
6. C 在自己的 `BEGIN IMMEDIATE` 中重读同源 control 和原 birth，构造原 `C-NATIVE-END-OPEN` 的七格后态，完整 CAS、readback、control 复核并 COMMIT。
7. C 实际关闭后，关闭源 pin，再按原 inode 与专属目录身份移除本次文件和空目录。任何未知都不会进入成功结果。

出生后的 session 仍是原 `formatVersion: 1`、唯一 `native-management` SQLite session；connectionId 来自本次实际 owner。最终 session state 为 `closed`，counter 来自实际 B 事务结果，drainReceipt 保持 `null`。C 是结算资源，没有伪登记为第二个 session。

## 固定 SQL、类型和权限边界

模块直接消费 `sqlite-profile-read-source.ts` 的原固定查询数据，未另建查询源。有限调用图选择原 32 条中的 13 条：两表各自的 metadata-first/next/value、encoding、rowid 分配、birth、native end open 和三条事务命令。没有公开的 `execute(id, params)` 或通用 `transaction(callback)`。

`C-NATIVE-END-OPEN` 只更新：

| 列 | 来源 |
| --- | --- |
| `db_sessions_json` | 本 owner 的实际已关闭 B、原 connectionId/sourceIdentity 和真实 counter |
| `observed_epoch` | 本次 C 的原 control epoch |
| `drain_epoch` | `NULL` |
| `drain_state` | `none` |
| `drain_receipt_digest` | `NULL` |
| `last_observed_at` | 本次实际观察时间 |
| `ended_at` | 同一观察时间 |

其余十格及 rowid 保持原值。SQL 的 WHERE 包含 rowid 与全部 17 格的 SQLite storage class、`BINARY` 精确值；`changes` 必须为 1。SQLite affinity 或文本比较规则不能替代原 raw preimage。

私有 owner 在自己实际持有的每个 handle 注册原 format/row ABI，实际执行 `SQLITE_PROFILE_GUARD_DEFINITIONS` 中三条 source-client guard 原 SQL。format 函数严格声明六个参数：表、事件、databaseInstanceId、fenceEpoch、guardManifestDigest、writerFormatDigest；row 函数接收 38 个参数：表、事件、旧/新 rowid、17 个 OLD、17 个 NEW。

两个回调共享私有 L/T/O 核：检查实际 C 身份、T 对象和代际、同 T 完整 control 快照、当前同步 O，以及 O 与本 owner 内部计算的计划 pre/post 全格一致。format 再精确比较实际原六参数，row 再精确比较 native OLD/NEW。它们不执行 SQL、I/O、预算变更或产生可保存的 token。出生仅允许当前出生 C 的 INSERT，终结仅允许已知 B 关闭后的专属 C 的精确 UPDATE；B 不能借此写 control 或 clients。原 DELETE guard 的无条件拒绝保持原样。

rowid 选择发生在实际 `BEGIN IMMEDIATE` 中。空表或最大值小于 1 时取 1，否则使用精确 int64 的 `max+1`。`9223372036854775807` 耗尽时在 INSERT 前拒绝，不经 JavaScript Number 舍入。

## Unknown 和失败

COMMIT 抛错不等于未提交，close 抛错不等于尚未关闭。组件保留原 native throw、原 clientId、原出生/计划后态、实际句柄和 T 身份，进入强引用的私有 pending owner 集合。

| 窗口 | 保留与拒绝行为 |
| --- | --- |
| 出生 COMMIT unknown | 保留计划出生、原 B/C；不生成新 clientId 或重试出生 |
| 出生 C close unknown | 即使 birth 已提交、C 后续显示已关闭，也保留 B/C，不接纳 B 事务 |
| B COMMIT/ROLLBACK unknown | 不根据事后 `inTransaction=false` 改写为已知终态或推进 counter |
| B close unknown | 不打开终结 C，不构造 ended row |
| 终结 C COMMIT unknown | 保留准确计划后态和实际 C；已落库的 ended 值不会变成成功退休声明 |
| 终结 C close 或 pin close unknown | 保留 owner 与文件，不重试关闭，不把已关闭的数字 FD 再用作句柄 |

已知失败会撤销 O/T 并实际 ROLLBACK；同一 T 的 reentry 或错误具有 sticky 效果，调用方即使吞掉内部错误也不能继续 COMMIT。错误结果只给固定 code，不输出 native 错误正文。`source_changed`、`step_mismatch`、`transaction_unknown` 与 `native_retirement_unknown` 分开。

## 同请求预算

一个零参数调用只有一个原 `AuditRequest`，B/C、两表读取、编码、比较、实际写入和输出均累计到该请求。原 limits 与 2048 字符失败预留没有调整，也不开放外部预算配置。

| Producer | 执行前的界限与计费 |
| --- | --- |
| 新目录、文件、FD、B/C、失败记录 | 固定有限资源图；先预付关闭、rollback 和文件退休需要的空间与工作 |
| 固定 SQL prepare/get | SQL 长度、声明列数、最多一行结果及 rowFactory 的 key/code/map 容器 |
| metadata | 每格 `typeof` 与 `octet_length`，含最后空结果；超出原 field/rawTotal 先拒绝 |
| value | 在同 T metadata 后预付 CAST、hex、lower、驱动结果、解码及快照；再执行 value query |
| format/row/CAS | 原六个 format 参数及固定 control 子查询、17 格两侧快照、38 个 row 参数、两次 L/T/O 检查、绑定、native run 与完整 readback |
| JSON、typed 输出 | 实际字节上界、容器和编码复制；输出预算在 typed hex 生产前保留 |

预算失败仍使用此前预付的有限退休路径。不会通过新建 `AuditRequest` 或重新执行 boundary 来继续生产。

## 资格和后继接线

隔离库只有 15 格 control 与 17 格 clients 两张 fixture 表。guard 值是明确无效的 `I04_ISOLATED_NOT_G1`。writer 字段复用原 guard 所编译期待的 writer descriptor literal，来源只是固定组件，未以 receipt/currentFormat 的名义取得资格。库内没有 receipt 或 terminal，不是合法 P1 样例。schema fixture 的 DDL、初始 control INSERT 及固定 source-client guards 仅安装到此自有隔离文件。

本片注册和实际执行 format/row UDF 的范围是隔离 fixture 的固定出生/终结步骤。它不消费 `Q-SOURCE` 的 native 扩展检查，不声称 final G1 或完整 currentFormat。独立 file pin 的 inode/path 观察也不等于证明 SQLite 自身 native FD 归属。process JSON 使用真实 pid/平台/instanceId 及原 `process_local_only` 标记，不能当作 CF03 的独立进程核验。

后继 I05 仍需完整 source selection/native binding、最终 S1/G1/tuple、真实 A/B 原件、完整历史及当前 terminal gate、原 CF03 inventory 和相应领域固定程序。届时必须在实际拥有源资源的私有装配中消费这些核；不能将本次 detached 值或 I02 的只读 observation 作为 permit 传入。

本片没有实现普通双 session、draining 结束、maintenance-controller/CF05、CF02 digest producer、SRC 的双库业务闭包，未修改原 P0 native-management、旧 closed-only CF parser、memory typed owner 或 production registry。

## 验证入口

`tests/sqlite-profile-client-owner.test.ts` 的正常成功和参数拒绝运行原候选。其余故障窗口使用隔离派生模块观察私有状态，分别记录原文件与派生文件的 bytes/SHA；派生观察不会向产品添加注入 hook。FD 关闭后抛错的用例单独披露替换位置，并确实先执行原 native close。

覆盖包括：实际 B/C 顺序、原 open envelope 不被 counter 改写、实际安装原 guard SQL、原六参数 format 注册/逐参数拒绝、38 参数 row 逐项拒绝、错 T/代际/plan pre/post、native 错 postimage 被原 row guard 拒绝、O/T 已撤而 COMMIT 尚未执行时实际拒写、17 格及 rowid 漂移时实际 CAS 为零并 rollback、int64 rowid 边界、client/process 冲突、source rename、同请求预算、metadata 在 hex 前拒绝大字段、reentry、各类 COMMIT/ROLLBACK/close unknown。定向回归同时运行原 SQLite owner、query source、guard source、值观察和 P0 native-management 测试。

这些是作者实现自查入口。非作者需求/标准审查、PR CI 和完整生产资格分别记录。

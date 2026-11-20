# SRC-I1a：固定 typed 全表纯值规划器

本组件对应 SRC-D01 R1 加已接受 R2 的有限 SRC-I1a 切片。它已经实现完整行结构、键和 FK 比较以及固定步骤的值规划；它没有实现完整 SRC-I1、历史文件 resolver 或 native SRC-I2。

入口是 `src/server/storage/internal/source-transfer-planner.ts` 的 `planSourceTransferValues(input: unknown)`。只接受 primitive JSON text，返回原 C2 `AuditResult`。输入包含固定 contract、`replace` 或 `clear`、source 和 target；clear 的 source 必须为 null。每个 frame 带 source 值身份、SQLite UTF-8 标记，以及固定顺序的全部 72 表 / 763 列、count、int64 rowid 和所有 raw typed cells。不能传入 SQL、callback、计划步骤、预算、许可、passed 或期望的 after。

## 已完成的值职责

- 65 表按 source 原 rowid 和全列值替换；3 个历史表做全 typed 并集；4 个目标表全值保持。source authority、两个 control 和迁移账本均不复制到目标。
- 同历史 PK 只在全部声明列相同的情况下复用目标行，source rowid 不参加该比较。新增历史按固定 typed PK 顺序分配目标最小未用正 int64 rowid。原目标历史 rowid 保持。
- 核对 72 个 PK、每表 rowid 和 93 个非 PK UNIQUE（76 个表内约束及 17 个显式 UNIQUE index），包含固定 partial predicate 与 SQL NULL 排除规则。
- 核对全部 173 个 FK；23 个原声明 deferred FK 仅保留其原延迟属性，另外 150 个使用原立即规则。固定表序、org_nodes 和 role_template_versions 的实际 self DAG 决定行序。不存在全局延迟或关闭 FK 的接口。
- 输出 34 条原 trigger 的精确身份与调用计数。主步骤只有 INSERT/DELETE；原 UPDATE guards 不触发。六类 fact INSERT/DELETE 的副作用逐行携带 before/after。目标旧 counter 溢出在输出计划前拒绝。
- member 插入生成六个初值为 1 的 provisional facts。它们的 rowid 是明确的 `native-rowid-readback` 数据要求，不能冒充真实 rowid。最后逐行删除 provisional facts，并恢复 source facts 的完整原值及 rowid。
- 输出完整 source、72 表 before/after、固定顺序的 71 表稳定投影和固定阶段步骤。稳定投影仅排除 storage_source_clients，并按 typed PK 排序；完整本次 before/after 仍包括这些客户行，singleton 的任一变化都会保留在稳定投影中。

## 精确支持的比较域

raw grammar 保留 SQL NULL、int64 decimal、原 TEXT/BLOB hex 与有限 REAL 的 64 位表示。TEXT 要求 UTF-8 精确往返；PG、UTF-16、非法 UTF-8、非有限 REAL 和 NULL PK 不在本组件支持域。BINARY key 比较保留 TEXT 与 BLOB 区别。INTEGER/REAL 数值键按精确数学值比较，不把 int64 转成 Number 后比较，因此整数 `9007199254740993` 与 REAL `9007199254740992` 不会误合并。

TEXT-affinity 键上的数值 storage class、INTEGER-affinity 键上的 TEXT storage class明确拒绝；本组件没有实现一套不完整的 SQLite affinity 强转。保留非键的 raw 值并不保证它可以通过 native CHECK 或无损绑定；这些检查仍必须由后继收口。

## 同一请求预算

入口复用原 C2 `boundary` 和同一个 `AuditRequest`，不是按 frame、表或 decoder 创建新额度。它保留原较小上限：输入 16 MiB、250,000 nodes、深度 64、100,000 rows、单 raw 4 MiB / 累计 raw 8 MiB、4,000,000 work units、64 MiB character passes、输出 1 MiB，并把直接原件/strict row 要求限制为 2,048 项。原件传递闭包未解析，因此该上限不能代替后继完整闭包账本。

读取、比较、key 复制、排序 comparator、结果构造和 trigger 副作用均消费同一 ledger；费用在相应工作前收取。输入和输出端还有原 C2 的扫描、序列化及 freeze 费用。返回的 `charges` **仅是 planner 追加收费收据**；它不冒称可读取 C2 的私有计数。没有 caller-selected limits 或预算 hook。

## 后继接点和限制

`artifactRequirements` 固定列出直接 evidence-ref 列及 strict M2/audit 行位置，含 frame、table、rowid、typed PK 和 raw 值。`requirementCoverage` 明确其传递提取尚未完成。resolver 应从已经返回的完整原行读取严格值格式及实际原件，不能扫描任意 JSON 字符串作授权或把输入 ref 当可执行路径。

每个成功结果仍带 `remainingChecks`：完整 CHECK/领域逻辑语义、原件及保留引用闭包、每端自己的 authority/terminal/journal、目标与源当前 runtime/CF17、实际物理源/catalog、无损 native read/bind、provisional rowid 真实读回、已接受 SRC-I0/final G1 owner 装配、同 handle 窗口、完整 native 读回和 commit/rollback/close。

这些结果只是可审查的数据。产品装配必须由实际 source/target owner 自行采集当前 frame 并关闭全部未完成检查；不得接受调用者提交的 plan 作为 O、准入或写权限。源 receipt 和来源包只用于历史。尤其 source-only ownedExits 支持的 runner，不能因此通过保留目标 clients 的目标当前 runtime 检查。新目标/P0 自身 A/B、P0 M1、PG/native 能力和 registry 均未由本组件改变。

测试夹具 `tests/fixtures/source-transfer-structural.json` 是完整列宽、非空、明确 SYNTHETIC 的结构值输入。其配置 JSON/控制证明未宣称通过完整领域解码或 native P1；不能拿纯值正向冒充真实设备、owner、权限或数据库运行记录。

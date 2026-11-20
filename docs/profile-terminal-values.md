# Profile terminal 有限值组件

状态：草案（已接受 SQ-D02 的实现说明，待独立审查）；日期：2026-11-20。

本组件实现 #153 已接受 SQ-D02 的 I03 第一片：`ProfileCompletionBinding` 与三个 M2 v4 journal 事件的严格值解码，以及已选记录的 SELF 投影。入口只接收 primitive JSON string，返回深冻结、脱离输入对象的值。它供元数据观察和后续完整 replay 核复用。

设计接受依据为 [SQ-D02 接受记录](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7026485094)。采用的 `TERMINAL-FIXED-SOURCE.json` 25 个 definition 与 `EFFECTIVE-OWNER-SCHEMAS.json` 完全一致；后者 SHA-256 为 `a63e52e7e2dd48d274c4843abb059a7d79175929b4e9ec15ddf00a7d554c2231`。事件的局部等式和摘要使用有效 durable-r2 `SEMANTIC-RULES.md` 的 R01、R19–R25，源 SHA-256 为 `fcef56c7c2ebcf66fdd3ddfc411440e92e6f399ebe33a451d35ee2ac4a873c8f`。

## 入口与范围

| 入口 | 输入 | 返回值与实际检查 |
| --- | --- | --- |
| `parseProfileCompletionBinding(input)` | 原 binding 的 canonical JSON string | 原八个字段及嵌套 ref、非负安全 epoch、`epochAfter = epochBefore + 1`、正安全 terminal sequence |
| `inspectM2ProfileJournalValue(input)` | 原 `JointSelectedBytesR2` 的 journal 分支：`{artifact, kind: "journal", bytesHex}` 的 canonical JSON string | `scope: "terminal-value-only"`、原 `record`、派生 `journalAnchor` 与 `completion`；核本件实际 byte count、SHA、准确 journal 路径、canonical bytes、严格结构和记录内可计算的关系 |

binding 的准确字段为 `activation`、`takeoverPlan`、`migrationId`、`s4PlanDigest`、`sourceIdentityDigest`、`epochBefore`、`epochAfter`、`terminal`。`terminal` 恰含 `record` 与 `sequence`；`record` 恰含 `artifactId` 与 `digest`。`activationRef`、`terminalRecordRef` 等 prose 别名不被接受。所有对象均拒绝多键和缺键。

三个事件保持原 envelope `formatVersion: 4`，A/B body 保持原 `formatVersion: 1`。本组件不把旧 `parseJournal` 扩成接受 v4。

| event | body 与局部关系 |
| --- | --- |
| `s2_profile_committed` | 固定 phase、原 `ProfileCommitRecord`、精确 sealed/SELF/null 后态；内外 migration、plan digest、request digest、G、E 一致；前驱 EvidenceRef 与 outer previous 一致、sequence 恰加一；按固定 `commit-profile-takeover` 域重算请求摘要 |
| `s2_profile_owner_acquired` | 只接受 `m2-profile-owner-acquired/r2`；phase 仍为 `s2_profile_committed`；G 恰加一且 outer G 等于 `toGeneration`，固定 sealed/P2/SELF/null 后态 |
| `s2_profile_completed` | 原 `ProfileCompletionRecord`、固定 open/P2/SELF/SELF_BINDING 后态；outer E 等于 before E，after E 恰加一且不溢出；G 保持；内外 migration/plan/request/前驱关系一致；按固定 `finish-profile-takeover` 域重算请求摘要 |

三事件均要求已有前驱，拒绝新 genesis。所选记录路径为原 S4 的 `journals/{migrationId}/{sequence}-{actualSha256}.json`。普通 request ID 保留其 Unicode 内容，B 的 `:finish` 后缀不被误套入 MigrationId 的 ASCII 限制；该 ID 是否等于所选 seed ID 加后缀，需完整引用检查后判定。

## SELF 的有限意义

只有本件实际 bytes、长度、SHA、路径和 canonical 形式均通过后，才生成 `journalAnchor = {record: {artifactId: selected.ref, digest: selected.sha256}, sequence: record.sequence}`。原 record 的 `SELF` 字符串保持原样，展开结果不进入本件 hash 域。

A 和 owner 的 `completion` 为 `null`。B 的 completion 从本记录已解码的 activation、takeoverPlan、migration、plan digest、source identity、before/after epoch 及上述 anchor 投影。该值尚未与外部 receipt、plan、physical observation 的实际原件作完整关联；成功只表示本件的值投影成立。其它普通字符串不会因内容等于 `SELF` 而展开。

本片不读取文件或数据库，也不实现完整只读 resolver、旧 prefix/JA/r2 owner/JB replay、CF/P-C、当前 later window、native qualification 或 writer factory。记录中未被选择的 refs、它们的日期和完整业务关系、历史/当前控制值，均留给对应完整核。返回值不能换取 writer 或表示数据库已准入。

## 同一请求内的解析与预算

I02 使用私有 `identity/internal/profile-terminal-values.ts` 的 `parseProfileCompletionBindingText(text, r)`。它接收同一 `AuditRequest`，不会新建 boundary 或重置计数；输入应是调用方按实际数据库 encoding 已严格解码的 terminal TEXT。

私有 `parseAuditJsonText(text, r)` 复用原 strict scanner，检查 duplicate keys、合法 Unicode、精确安全整数和语法深度后才 `JSON.parse`。每件 JSON 的语法根深度为 0，全部节点、文字和工作量仍累计到同一 `r`；引用图深度由完整图核另行检查。该 helper 只负责严格语法，所属 codec 继续承担 canonical 和字段语义。

沿用原 C2 限额：input 16 MiB、单 raw 4 MiB、raw total 8 MiB、nodes 250000、depth 64、characters 64 MiB、work 4000000、output 1 MiB、field 32 KiB；更低原字段上限取交集。失败保留原 2048 字节及 128 工作量预留，错误只使用原固定有限结构。

| producer | 执行前的累计收费 |
| --- | --- |
| 内层 strict JSON | UTF-8 长度扫描；token、切片、解码字符串、最终 parse 的读/复制；原 scanner 节点、键和数字检查 |
| raw bytes | 原 hex/raw 总量检查，fatal UTF-8 与精确 roundtrip，以及本值组件的额外解码/复制费用 |
| canonical | 字符串逐项估算后才编码，固定对象键数组和排序工作先付费；排序比较、动态键读取和精确 token 比较各自付费。直接遍历 token，不反复拼接整个子树 |
| SHA 与请求摘要 | UTF-16 读取、UTF-8 转换与 hash 遍历分别预付；固定请求对象和摘要输出也记入本请求 |
| SELF 与返回结果 | 在构造 detached 记录前预留节点；最终由同一 boundary 测量输出、计费并深冻结 |

定向测试包含三事件完整正例、逐层缺/多键、旧 owner/r1、伪后态、局部身份与摘要漂移、字节与路径漂移、双层非 canonical 输入、hostile getter/Proxy 零调用、安全计数边界、累计 node/text 耗尽和完整 nested parse 加输出的 N/N+1 字节边界。原 C2、P1 authority 和旧 journal 回归另行保留。

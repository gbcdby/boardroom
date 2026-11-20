# 完整 M2 origin 的纯值闭包

本实现交付 #153 / SQ-D02 的完整 `m2-origin` 值分支，并将它接入已有
`validateM2HistoryClosure` 的 `m2-observation.p1` 消费者。它读取调用方提供的
primitive JSON string 和其中完整选件原字节，验证历史、业务转换与当前准确
A/B 投影。成功值始终是 `classification: "observation"`。

接受依据为 [SQ-D02](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7026485094)、
其有效 EG durable-r2 的 `API.md` / `SEMANTIC-RULES.md` / `CLIENT-FACTS.md` /
`ACTIVATION-CLIENTS.md`，以及有效 P-C Stage1b-r2 的 `API.md` /
`M2-ARTIFACT-RULES.md` / `DURABLE-BRIDGE.md`。
M2 的六原件、八角色静态映射由
[准确接受记录](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7030475256)
固定；`m2-durable-fixed-sources.ts` 保留这些不可执行合同源的完整原字节身份。
这些身份与实际 schema、guard、row、M22 摘要分别核对。

## 两个实际消费者

| 入口 | 输入与范围 | 成功输出 |
| --- | --- | --- |
| `verifyM2DurableClosure(input)` | `m2-durable-validation/r2` 的 canonical C-R3 string，唯一 `roots: {kind: "m2-origin", closure}` | `durable-m2-origin-values`；从真实选件派生的 completion、G/E、cursor/resumeAt 和准确已检查件数 |
| `validateM2HistoryClosure(input)` | 原 `m2-history-closure-input/r2` string；P0 保持原消费者，P1 要求完整 origin history，且 inline observation 是准确 pre-B 或 B 初始窗口 | `complete-history-value-closure`；完整 72 表、47 项适用规则、原 input/history/每表摘要、原固定 native remaining |

外层 P-C string 可以非 canonical；duplicate key、非法 surrogate、数值词法、
深度和所有原上限仍先检查。EG 外层必须是准确 C-R3。所选旧 S4 原件继续使用
C-S4，M2/PC 新原件使用各自固定 C-R3 域，binary source 保持其原 bytes。
公开入口不读取 caller 对象、Proxy、getter 或 `toJSON`。

`p1-window`、两个 layout root、`p1-source-cut`、`p1-source-history`、
`layout-history` 与 P1 proposed deletion 仍明确拒绝。特别是普通运行期间
修改后的 P1 observation 不能沿旧 M2 初始窗口返回完整成功；它需要自身的
later source window。P0 的已有删除/保留图行为继续由原实现承担。

## 实际执行的闭包

| 接受义务 | 本实现的固定消费者 |
| --- | --- |
| R01–R06：选件 bytes、路径、准确引用角色、规范域、原 parser | `m2-p0-request`、`m2-durable-graph` 与原 `FState` / S4 strict codecs；实际 SHA 和原 ArtifactRef 三字段均核同 |
| R07/R21：完整旧来源与 ready 前驱 | 原 P0 closure、原 `readJournalValues` / `readSnapshotValues`，再重放 capture 后的合法 bridge/登记/observation；capture 与 A 前最新控制值分开 |
| R08：固定升级域 | `checkM2Upgrade` 核旧 Md 的 S0/G0、descriptor/plan/receipt 的 S1/G1、固定 backend/M22/decoder/client-format 合同身份 |
| R09–R15：真实旧业务转换 | `checkM2Capture` / `checkM2InitialBusiness`；十表 capture、managed/external profile、稳定 binding、requested/applied/effective 三来源、slot 原 raw JSON/revision、workspace/advanced 关系 |
| R16–R18：目标和精确 A delta | 九表、binding 六列、runner 两列、准确 audit 模板、旧业务/rowid/重数、21 条原 migration 与精确 22、authority/receipt 原 PA 行；A 只升级 coordinator 的两项 format 值 |
| R19–R25：A、owner 后继、B 与 proof | 完整 journal 连续关系和请求域；每个 owner 执行 CF01–06 的 17 原格、真实前态、actor/runtime/session、G+1；四个 post-A domain 从同一个 pre-B 历史派生；B 的 epoch 与 SELF completion |
| R26–R29：精确闭包和来源输出 | 缺件、重件、错误角色和 unused selection 拒绝；P-C 扩展实际 origin history 与 authority 行，派生 terminal 并与 inline 原格核同 |
| M201–M204 与原 P-C 业务规则 | `checkM2CurrentValues` 与原 keys / identity / tasks-decisions-work-events / audit-memory / configuration-runtime 消费者，在认证 current view 中检查全部适用历史与关系 |

`SourceToTargetManifest.seed` 必须等 `TakeoverPlan.seed`，其 `targetRows`
必须等 `AllowedDeltaManifest.targetRows`。这是 R16 的同计划目标原件关系，
不能只验证两个引用各自长得像 ArtifactRef。两条全图重锚反例曾实际通过旧草稿，
现均在语义阶段拒绝。

选中的 legacy-equivalence 必须具有对应 snapshot 的 `mappedValidity:
"equivalent"`，且 `equivalenceEvidenceDigest` 是同一实际选中证据的摘要。
缺证据的其它 captured slots 保留原 reconfirmation/invalidated 值。

pre-B 与 B 的业务保存比较实际完整 metadata 和排序后的原 row frames，保留
重复行和 rowid。已验证相等后的摘要复用只复用确定的字节结果；它不把摘要相等
当作原格保存关系的替代品。

## 一个累计请求与固定上限

新入口与历史、当前 view 共用一个实际私有 P0 state。下游不能传入 meter、
自定义 schema、callback、validator、limits 或新的 request 来分割预算。

| 项目 | 原上限 |
| --- | ---: |
| 外层 UTF-8 | 16 MiB |
| selected 原 bytes 合计 / 单件 | 8 MiB / 4 MiB |
| selected / evidence / journal 节点数 | 各 4096 |
| JSON nodes / 边与中间 tuple | 各 250,000 |
| 累计 raw rows | 100,000 |
| 深度 | 64 |
| 累计读写 bytes / work | 64 MiB / 4,000,000 |
| 成功输出 | 1 MiB |
| 原 P0 失败预留 | 4096 bytes + 128 work |

P-A value/row 的 16 MiB 本地上限，以及 profile-authority 单值的 **1 MiB**
上限取原交集；同请求借用不会把它们合并成一个更宽的上限。每次语法/字段/深度
义务仍按当前 occurrence 执行；更深处的同一 JSON 字节不能借浅位置的结果过关。

完整 0/1/2 owner 图最初真实触及累计 bytes/work/tuple 上限，随后只通过删除
实际重复操作使正例通过：

- 私有 owned scanner 一次严格扫描构造自有数据、计算 UTF-8 和节点深度；
  正常成功路径删去另一遍 `JSON.parse` 和整体 UTF-8 长度扫描。原 `scanP0Json`
  和直接 `createP0Request` 保留默认路径。
- 在已经读到完整固定 M2 envelope 身份和 selected byte count 时，同一次
  hex 单元读取可以生成实际 Buffer。分配及写入前预付，完整 SHA 仍实际读取；
  字段乱序、转义、错误长度和未完成 buffer 都不能借用半成品，已发生费用不退还。
- C-R3 与 C-S4 分开记录准确源域。C-S4 保留有限小数、UTF-16 键序和合法
  lone-surrogate 转义；只有实际通过 R3 的交集才标记 R3 语法事实。
- 精确源 span 使用 UTF-8 byte offset；R3 只保留 root/payload 所需数据，S4
  同扫描保留原 nested canonical 消费者实际需要的对象/数组 span。
- 同一认证不可变 encoding 可复用原字节身份；完整逐格 `copyEncoding` 成功后
  的 clone 才能共享该身份。外观相同对象、普通 `Object.freeze` 或其它 request
  都不能命中。独立 `scanCr3`、role、context、CF 和 current 关系继续执行。
- 固定 schema enum 预编译、无副作用 `anyOf` 在实际成功时结束；`oneOf`
  保留唯一性，只有静态证明互斥的固定 tuple tag 才直接定位其分支。
- 输入摘要以原准确域流式读取**所有** selected bytesHex、evidence 和 graph；
  输出 size 沿原 canonical 字节计数，省去仅为计数而建立的第二棵 token 树。

没有通过降低计费、提高上限、删 source 原件、修改 hash domain、减少完整业务
行或关闭校验来获得成功。未知异常保持原有限错误，既不读取属性也不回显原数据。

## 证据范围

完整 fixture 使用真实 SQLite migrations 1–21、全部 61/615 旧目录、非空
Agent/runtime/binding/runner/member/alias 关系、三个不同的原来源，以及
72/763 目标目录。实际 SQLite `page_size=512` 和 `secure_delete=ON` 只让
固定快照更紧凑且可重建；没有手工改 binary、删数据或修改预算。

0、1、2 个 after-A owner 后继均通过两个公开入口，P-C 同时核 pre-B 与 B。
每个 B 输入的 `inputDigest` 及全部 72 个 table digest 用独立原 canonical
算法重新计算。1/2 owner 图含历史 P0 v1 client、A 的两格升级、真实 CF17
前后集及 owner→owner 交接；有限 CF 单测不代替这些完整根。

原 typed core 固定提交 `772aae0` 与新默认/owned grammar 的 264 个 SQLite/PG、
61/72 表、列/OID/NULL/int64/rowid/sequence 向量逐值、逐错误路径核同。
新 scanner 还覆盖 canonical 差异、数学整数、surrogate、重复 key、深度、
UTF-8 byte span、`__proto__` own data、跨 request 身份与实际删除的扫描调用。
原 P0 facade、S4 client refinements、P-A value/row、authority 与 terminal
codec 回归另行执行。完整 EG/P-C 端到端构造目前以 SQLite 为证据；PG 完整根
未由这些 fixture 声称通过。

## 仍保留的边界

本结果不能证明真实 native schema/guard 已安装、真实 source FD 与数据库身份、
同一个实际事务窗口、native restore、sequence 排他、FS durability、live writer
资格或生产 registration。S1/G1 的本值分支按接受字段在 descriptor、receipt、
J_A、proof、pre-B/current control 与 terminal 间核同，不从 pc-catalog value
digest 合成另一个 native S1/G1 摘要。

公开 factory/registry 保持原状态。固定只读 resolver 的 I/O 绑定、完整
`p1-window` 与 layout 闭包需要各自完整消费者后才能推进；这里的 observation
不可拼装成 permit，也不关闭整个 SQ-D02、P-C 或 G1/native ticket。

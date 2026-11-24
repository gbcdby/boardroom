# 设计与形式化验证结果

## 结论

本切片修复了统一消费账本模型中的三个语义问题（未来 epoch 领取、旧代际观察改写状态、错误变体不可达），并在合法终态加入受限自环以消除人为死锁。随后为 R2/R3 增加两个隔离错误变体开关与配置：fixed 保持原语义且在新目录重跑仍 `PASS_WITHIN_SCOPE`；`AtMostOneReply` 与 `UnknownStaysAssigned` 分别在对应错误变体中被反例命中，敏感性已演示。这些结论只对 TLA+ 模型成立；#312/#314 仍是设计基线而非已接受实施主线，实现状态 `NOT_ASSESSED`，不表示业务实现已验证或产物可释放。错误变体的 `COUNTEREXAMPLE` 仅作敏感性证据，不计入交付通过记录。

| 层次 | 状态 | 证据位置 / 未执行原因 |
|---|---|---|
| 模型检查（fixed） | PASS_WITHIN_SCOPE | 当前快照 `.agent-output/s8-314-tla/small-fixed-r2r3/result.json`、`tlc.log`、`messages.json`、`input/`；旧快照 `small-fixed-v3/` 保留 |
| 模型敏感性检查 | DEMONSTRATED（R1/R2/R3；R4 限制见下） | `NoDoubleClaim` `.agent-output/s8-314-tla/bug-double-claim-v2/`；`AtMostOneReply` `.agent-output/s8-314-tla/bug-double-reply/`；`UnknownStaysAssigned` `.agent-output/s8-314-tla/bug-unknown-changes-state/`；`NoStaleHandled` 旧反例 `.agent-output/s8-314-tla/small/` |
| 可选源码对应核验 | NOT_ASSESSED | 本轮为 design 模式，未进入 align，未读取/核对实现作为证据 |
| 独立模型复核 | NOT_RUN | 本轮不组织独立复核；作者自查不替代复核 |
| 交接材料 | COMPLETE（含列明未覆盖项） | `contract.md`、`handoff.md`、本报告 |

## 实际检查范围

- 请求模式：design；用户要求 subagent 使用 free model 完成本 TLA+ 切片；不修改业务实现、项目测试或部署配置。
- 需求、设计决策、模型性质与启用配置：R1–R4 对应 `NoDoubleClaim`、`AtMostOneReply`/`ReplyMatchesDisposition`、`UnknownStaysAssigned`、`NoStaleHandled`，另有 `TypeOK`；性质名未变、死锁检查在所有配置中保持开启。`fixed.cfg` 启用六项不变式；`bug-double-claim.cfg`（R1）启用 `TypeOK` + `NoDoubleClaim`；新增 `bug-double-reply.cfg`（R2）启用 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition`；新增 `bug-unknown-changes-state.cfg`（R3）启用 `TypeOK` + `UnknownStaysAssigned`。四个配置均启用 `SPECIFICATION Spec` 且未使用 `CONSTRAINT`。新增常量 `ReplyGuardEnabled`/`UnknownGuardEnabled` 在 fixed 与 R1 变体为 `TRUE`，R2/R3 变体各自只关闭一个开关，互不干扰。
- 模型 / 配置 / 工具摘要：当前模型 SHA-256 `ca26804cf7f79475f8c676fd730b97c5f4ab0f27ec2af8aeef9c8fd9495310c8`；`fixed.cfg` SHA-256 `fdf6be03264f815c9a7c20dca88808ee9cca16d36e492405e11fc6c7b5220df9`；`bug-double-claim.cfg` SHA-256 `f36c7fc0b99c794bdccdef304e4bdd267f26ac74870e2341c6bac0a66fedda3d`；`bug-double-reply.cfg` SHA-256 `3a45ead0b85c2541df235caaea59e8e0993d63d2cebaef93400e6baf011155f9`；`bug-unknown-changes-state.cfg` SHA-256 `dd9baaf0aeec0d68a8b5c4cff86188ebcc7e0fec92b4d8795d3b476a369ba664`；manifest SHA-256 `af35784f0b26ed1e9f68f892bce48b634c43150aa35c9d013578ab1bc2ad60a2`。TLC 报告版本 `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`，jar SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`（本地复用，未下载）。
- 运行命令（绝对路径参数，新目录）：
  - fixed 重跑：`python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile small --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/small-fixed-r2r3`
  - R2 错误变体：同上，参数改为 `--profile bug-double-reply --out .agent-output/s8-314-tla/bug-double-reply`。
  - R3 错误变体：同上，参数改为 `--profile bug-unknown-changes-state --out .agent-output/s8-314-tla/bug-unknown-changes-state`。
  - 历史命令采用旧清单/模型快照：`--profile small --out .agent-output/s8-314-tla/small-fixed-v3`、`--profile bug-double-claim --out .agent-output/s8-314-tla/bug-double-claim-v2`。
- 参数规模、故障、恢复、调度与公平性假设：`W={w1,w2}, C={acp,mcp}, E={0,1}, G={0,1}`；`DuplicateAllowed=FALSE`（fixed/R2/R3）/ `TRUE`（R1 错误变体）；`ReplyGuardEnabled=TRUE`（fixed/R1/R3）/ `FALSE`（R2 错误变体）；`UnknownGuardEnabled=TRUE`（fixed/R1/R2）/ `FALSE`（R3 错误变体）；`replyCount` 域为有限 `0..2`，fixed 下由守卫保证只到达 0/1。包含重复领取、unknown、旧代际到达、mode 切换与 fence；排除崩溃恢复、外部副作用、真实 DB/FS 与活性公平性。
- 完成状态及可达状态统计：
  - `small-fixed-r2r3`（当前 fixed）：`status=PASS_WITHIN_SCOPE`，`reason=COMPLETE_MODEL_CHECK`，`completed=true`，`implementation_status=NOT_ASSESSED`，生成 13437 / 不同 2532 / 剩余 0，进程退出码 0，错误码 `[]`，警告码 `[]`。与旧 `small-fixed-v3` 状态计数一致，确认新增开关未改变 fixed 语义。
  - `bug-double-reply`：`status=COUNTEREXAMPLE`，`completed=false`，`implementation_status=NOT_ASSESSED`，生成 799 / 不同 469 / 剩余 327，TLC 退出码 12，错误码 `[2110, 2121]`；`messages.json` 命中 `Invariant AtMostOneReply is violated.`。
  - `bug-unknown-changes-state`：`status=COUNTEREXAMPLE`，`completed=false`，`implementation_status=NOT_ASSESSED`，生成 37 / 不同 31 / 剩余 23，TLC 退出码 12，错误码 `[2110, 2121]`；`messages.json` 命中 `Invariant UnknownStaysAssigned is violated.`。
  - 历史快照：`small-fixed-v3` 为 `PASS_WITHIN_SCOPE`（13437/2532/0）；`bug-double-claim-v2` 为 `COUNTEREXAMPLE`（52/29/21，错误码 `[2110, 2121]`）。
- 关键路径可达性和敏感性证据：R2 反例轨迹 `Receive(w1)` → `Claim(w1,acp,ep=0,gen=0)` → `Observe(success)` → `PublishReply`（`replyCount` 0→1）→ 再次 `PublishReply`（1→2）→ 违反 `AtMostOneReply`；R3 反例轨迹 `Receive(w1)` → `Claim(w1,acp,ep=0,gen=0)` → `Observe(unknown)` 将 `status` 改为 `needs_attention` → 违反 `UnknownStaysAssigned`；旧反例轨迹（未来 epoch 领取 + Observe 置 handled）、bug 双领轨迹（同一 w1 两次 claim）和中间死锁轨迹（全终态 + epoch 饱和）均保存在各自 `messages.json`/`tlc.log`。
- 原始反例和重新检查证据：见“发现及处理”；旧证据全部保留，未覆盖、未删除，也未编辑 runner 结果。

## 发现及处理

1. **旧 fixed 反例（未来 epoch 领取）**：`.agent-output/s8-314-tla/small/`，`NoStaleHandled is violated.`。轨迹为 `Receive(w1)` → `Claim` 使用 `ep=1` 而当时 `modeEpoch=0` → `Observe` 将 `status` 置为 `handled`；性质要求存在 `ep <= modeEpoch` 的 claim，因此失败。这是模型语义错误，不是性质过强。处理：在 `Claim` 增加 `e = modeEpoch`，不删性质、不放宽 `<=` 为更弱条件。该证据保留作为 `NoStaleHandled` 敏感性证明，不代表当前模型失败。
2. **旧代际观察可改写状态（额外语义问题）**：原 `Observe` 只要求存在匹配 claim 且 `status=assigned`，因此 `ep < modeEpoch` 的 claim 也能写 `status/outcome`，与 R4「旧代际观察不能改写当前状态或产生 Reply」冲突。处理：`Observe` 增加 `owner[w] = c` 与 `e = modeEpoch`，旧代际结果只能走 `StaleArrival` 空动作。未因此新增或改名性质；该方向缺少单独变异运行，列为缺口。
3. **错误变体不可达（敏感性空洞）**：原 `Claim` 要求 `status = pending`，首次领取后即无第二次领取，`DuplicateAllowed=TRUE` 无法产生反例。处理：允许领取尝试在 `pending` 或 `assigned` 上发生，唯一性仍由 `DuplicateAllowed=FALSE` 的 `claims` 互斥守卫承担。结果：`bug-double-claim-v2` 在 `Receive(w1)` → `Claim(acp,0,0)` → `Claim(mcp,0,1)` 后报告 `Invariant NoDoubleClaim is violated.`，证明该性质能捕获重复领取。该反例只用于敏感性检查，不计入交付通过记录。
4. **终态死锁（中间运行）**：按用户指定路径运行 `small-fixed-v2` 时，在 `NoStaleHandled` 反例修复后暴露 `Deadlock reached.`（错误码 2114）：所有 WorkItem 为 `needs_attention`，`modeEpoch=1` 已是 `E` 上限，无其它动作。这是有限 epoch 下的合法终止，不是业务性质违反。处理：新增仅在该状态启用的 `Terminal` 自环，`checks_deadlock` 仍为 `true`；随后在**新目录** `small-fixed-v3` 得到 `PASS_WITHIN_SCOPE`。`small-fixed-v2` 原始结果保留，未覆盖为通过。

5. **R2 重复 Reply 敏感性缺口（本轮补齐）**：原 `replyCount` 域为 `{0,1}` 且 `PublishReply` 直接把计数写为 1，错误变体无从表达第二次发布。处理：域改为有限 `0..2`，新增 `ReplyGuardEnabled` 开关，`ReplyLimit = IF ReplyGuardEnabled THEN 1 ELSE 2`，`PublishReply` 在计数小于上限时加一。fixed 保持 `TRUE`，只能从 0→1；`bug-double-reply.cfg` 置 `FALSE`，在 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(success)` → `PublishReply` → 再次 `PublishReply` 后 `replyCount=2`，`Invariant AtMostOneReply is violated.`。未删改 `AtMostOneReply`/`ReplyMatchesDisposition`，未关闭死锁检查，未用 `CONSTRAINT` 过滤。
6. **R3 unknown 状态改写敏感性缺口（本轮补齐）**：新增 `UnknownGuardEnabled` 开关；fixed 保持 `TRUE` 时 `unknown` 分支仍为 `status'=status`，`bug-unknown-changes-state.cfg` 置 `FALSE` 后改为 `needs_attention`。反例 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(unknown)` 直接命中 `Invariant UnknownStaysAssigned is violated.`。两个开关相互隔离：R2 变体中 `UnknownGuardEnabled=TRUE`，R3 变体中 `ReplyGuardEnabled=TRUE`。模型文本变化后在**新目录** `small-fixed-r2r3` 重跑 fixed，仍为 `PASS_WITHIN_SCOPE` 且状态计数与旧快照一致；两个错误变体只作为敏感性证据，不混入交付通过记录。

## 交接与可选回检

- 设计契约：`contract.md` 记录需求到性质、模型边界、基线/变更与检查计划；`handoff.md` 记录 O1–O7 语义义务、C1–C6 回归场景与返回验证条件。
- 回归场景是测试规格，不是已执行测试；实现方需自行编写、运行并提供证据，未执行保持 NOT_RUN。
- 未覆盖的代码级问题：真实并发原子性、DB/FS 语义、宿主投递、崩溃恢复、外部副作用、needs_attention 人工流程、组合系统性质。
- 仅 align：本轮未进入 align，无源码对应表、无内容标识、无对应基线推进。
- 外部测试证据：未提供；不把模型 PASS 当作外部测试结果。

## 限制

- `PASS_WITHIN_SCOPE` 仅表示在 `W=2,C=2,E={0,1},G=2`、给定动作与公平性/故障假设下完成穷举检查；不覆盖任意规模、活性或真实实现。
- 错误变体 `COUNTEREXAMPLE` 是预期的敏感性证据，不是交付通过证据；它与 fixed PASS 分开记录，且只覆盖各自被关闭的守卫。变异检查不能证明所有遗漏都已排除。
- 用户指定的旧 fixed 输出目录 `small-fixed-v2` 实际记录了中间死锁反例，最终通过运行先位于新目录 `small-fixed-v3`；R2/R3 开关加入后又在**新目录** `small-fixed-r2r3` 重跑通过。所有历史运行目录均保留，未覆盖或删除。
- 当前 fixed 结论以 `small-fixed-r2r3/result.json` 与其 `input/` 快照（模型 SHA `ca2680…`、manifest SHA `af3578…`）为准；旧反例仍对应旧模型快照，不代表当前模型失败。R4「旧代际观察无状态效果」仍无单独命名的不变式或专门变异运行，仅由 `Claim`/`Observe` 守卫与可达性表达。
- 未做独立模型复核；作者自查不替代独立复核。实现状态保持 NOT_ASSESSED，产物释放、合并、关票均不在本切片范围。

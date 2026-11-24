# 设计与形式化验证结果

## 结论

本切片修复了统一消费账本模型中的三个语义问题（未来 epoch 领取、旧代际观察改写状态、错误变体不可达），并在合法终态加入受限自环以消除人为死锁；随后为 R2/R3 增加两个隔离错误变体开关与配置。本轮进一步为 R4 增加显式不变式 `NoStaleEffect` 与诊断位 `staleEffect`，并新增隔离开关 `StaleGuardEnabled`：fixed 与 R1/R2/R3 错误变体保持旧代际空动作语义，`bug-stale-arrival` 关闭开关后旧代际结果确实写状态/Reply 并置位，`NoStaleEffect` 被反例命中。fixed 在新目录 `small-fixed-r4` 仍 `PASS_WITHIN_SCOPE`（状态计数与上一轮一致），四个错误变体在各自新目录 `COUNTEREXAMPLE`，分别命中目标性质。这些结论只对 TLA+ 模型成立；#312/#314 仍是设计基线而非已接受实施主线，实现状态 `NOT_ASSESSED`，不表示业务实现已验证或产物可释放。错误变体的 `COUNTEREXAMPLE` 仅作敏感性证据，与 fixed PASS 分开记录，不计入交付通过记录。

| 层次 | 状态 | 证据位置 / 未执行原因 |
|---|---|---|
| 模型检查（fixed） | PASS_WITHIN_SCOPE | 当前快照 `.agent-output/s8-314-tla/small-fixed-r4/result.json`、`tlc.log`、`messages.json`、`input/`；旧快照 `small-fixed-r2r3/`、`small-fixed-v3/` 保留 |
| 模型敏感性检查 | DEMONSTRATED（R1/R2/R3/R4） | `NoDoubleClaim` `.agent-output/s8-314-tla/bug-double-claim-r4/`；`AtMostOneReply` `.agent-output/s8-314-tla/bug-double-reply-r4/`；`UnknownStaysAssigned` `.agent-output/s8-314-tla/bug-unknown-changes-state-r4/`；`NoStaleEffect` `.agent-output/s8-314-tla/bug-stale-arrival/`；`NoStaleHandled` 旧反例 `.agent-output/s8-314-tla/small/` |
| 可选源码对应核验 | NOT_ASSESSED | 本轮为 design 模式，未进入 align，未读取/核对实现作为证据 |
| 独立模型复核 | NOT_RUN | 本轮不组织独立复核；作者自查不替代复核 |
| 交接材料 | COMPLETE（含列明未覆盖项） | `contract.md`、`handoff.md`、本报告 |

## 实际检查范围

- 请求模式：design；用户要求 subagent 使用 free model 完成本 TLA+ 切片；不修改业务实现、项目测试或部署配置。
- 需求、设计决策、模型性质与启用配置：R1–R4 对应 `NoDoubleClaim`、`AtMostOneReply`/`ReplyMatchesDisposition`、`UnknownStaysAssigned`、`NoStaleHandled` + `NoStaleEffect`，另有 `TypeOK`；性质名未变、死锁检查在所有配置中保持开启。`fixed.cfg` 启用七项不变式；`bug-double-claim.cfg` 启用 `TypeOK` + `NoDoubleClaim` + `NoStaleEffect`；`bug-double-reply.cfg` 启用 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition` + `NoStaleEffect`；`bug-unknown-changes-state.cfg` 启用 `TypeOK` + `UnknownStaysAssigned` + `NoStaleEffect`；`bug-stale-arrival.cfg` 启用 `TypeOK` + `NoStaleEffect`。五份配置均启用 `SPECIFICATION Spec` 且未使用 `CONSTRAINT`。新增常量 `StaleGuardEnabled` 在 fixed 与 R1/R2/R3 变体为 `TRUE`，只在 R4 变体为 `FALSE`。
- 模型 / 配置 / 工具摘要：当前模型 SHA-256 `aa073f7a48996593841417d17e4d9ded1c5f3510c5eec54c9938cc65c14761ce`；`fixed.cfg` SHA-256 `8dc21e973ebb0a29b3f0d0225e62d720120bb601ff770e509158edfba63251d1`；`bug-double-claim.cfg` SHA-256 `3a258018bd53cc2f0ead6514ff4c8a7614699ab05b331b56abb5e296e98f9a17`；`bug-double-reply.cfg` SHA-256 `0d960267263d97eaba8fe07099f8650bb7f400fab234de1f80095f430b0f6b1a`；`bug-unknown-changes-state.cfg` SHA-256 `5e791e63bd1dfc83da85acb4863c686a7e44e98f8c483a07735173bd25172363`；新增 `bug-stale-arrival.cfg` SHA-256 `bcd64650184c08c2c14f28aa9a4de6595cf6e3796b14ac703adf20c2600a40fa`；manifest SHA-256 `5e5a95cf3c2eea8d5ac3f2c093060a609cb395b356788417f754260c46702638`。TLC 报告版本 `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`，jar SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`（本地复用，未下载）。
- 运行命令（在候选 worktree 根执行，`--jar` 为绝对路径，`--out` 均为新目录；历史目录未覆盖）：
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile small --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/small-fixed-r4`
  - 同上，参数改为 `--profile bug-stale-arrival --out .agent-output/s8-314-tla/bug-stale-arrival`
  - 同上，参数改为 `--profile bug-double-claim --out .agent-output/s8-314-tla/bug-double-claim-r4`
  - 同上，参数改为 `--profile bug-double-reply --out .agent-output/s8-314-tla/bug-double-reply-r4`
  - 同上，参数改为 `--profile bug-unknown-changes-state --out .agent-output/s8-314-tla/bug-unknown-changes-state-r4`
- 参数规模、故障、恢复、调度与公平性假设：`W={w1,w2}, C={acp,mcp}, E={0,1}, G={0,1}`；`DuplicateAllowed=FALSE`（fixed/R2/R3/R4）/ `TRUE`（R1 错误变体）；`ReplyGuardEnabled=TRUE`（fixed/R1/R3/R4）/ `FALSE`（R2 错误变体）；`UnknownGuardEnabled=TRUE`（fixed/R1/R2/R4）/ `FALSE`（R3 错误变体）；`StaleGuardEnabled=TRUE`（fixed/R1/R2/R3）/ `FALSE`（R4 错误变体）；`replyCount` 域为有限 `0..2`，fixed 下由守卫保证只到达 0/1。包含重复领取、unknown、旧代际到达、mode 切换与 fence；排除崩溃恢复、外部副作用、真实 DB/FS 与活性公平性。
- 完成状态及可达状态统计（runner `result.json` 原始摘要）：

| 目录 / profile | status | reason | completed | 生成 / 不同 / 剩余状态 | 进程退出码 | error_codes | warning_codes |
|---|---|---|---|---|---:|---|---|
| `small-fixed-r4` / small | PASS_WITHIN_SCOPE | COMPLETE_MODEL_CHECK | true | 13437 / 2532 / 0 | 0 | `[]` | `[]` |
| `bug-stale-arrival` / R4 | COUNTEREXAMPLE | PROPERTY_OR_DEADLOCK_VIOLATION | false | 188 / 148 / 115 | 12 | `[2110, 2121]` | `[]` |
| `bug-double-claim-r4` / R1 | COUNTEREXAMPLE | PROPERTY_OR_DEADLOCK_VIOLATION | false | 52 / 29 / 21 | 12 | `[2110, 2121]` | `[]` |
| `bug-double-reply-r4` / R2 | COUNTEREXAMPLE | PROPERTY_OR_DEADLOCK_VIOLATION | false | 799 / 469 / 327 | 12 | `[2110, 2121]` | `[]` |
| `bug-unknown-changes-state-r4` / R3 | COUNTEREXAMPLE | PROPERTY_OR_DEADLOCK_VIOLATION | false | 37 / 31 / 23 | 12 | `[2110, 2121]` | `[]` |

  五次运行的 `implementation_status` 均为 `NOT_ASSESSED`，`completed` 只在 fixed 为 true；反例运行提前停止，剩余队列非零属预期。fixed 状态计数与旧 `small-fixed-r2r3`、`small-fixed-v3` 一致，说明新增 `staleEffect` 与 `StaleGuardEnabled` 未改变 fixed 可达语义。
- 反例命中的不变式（`messages.json` 2110 消息）：`bug-stale-arrival` 为 `Invariant NoStaleEffect is violated.`；`bug-double-claim-r4` 为 `Invariant NoDoubleClaim is violated.`；`bug-double-reply-r4` 为 `Invariant AtMostOneReply is violated.`；`bug-unknown-changes-state-r4` 为 `Invariant UnknownStaysAssigned is violated.`。四者 2121 消息均为 `The behavior up to this point is:`。
- 关键路径可达性和敏感性证据（本轮新目录）：
  - R4 反例业务顺序：`Receive(w1)` → `Claim(w1,acp,ep=0,gen=0)`（`status=assigned`、`owner[w1]=acp`）→ `SwitchMode(1,mcp)`（`modeEpoch=1`，`fenced[acp]=FALSE`、`fenced[mcp]=TRUE`）→ 旧 `ep=0` claim 的 `StaleArrival(res=success)` 写 `status[w1]=handled`、`outcome[w1]=success`、`replyCount[w1]:0→1`，`staleEffect: FALSE→TRUE` → 首次违反 `NoStaleEffect`。原始轨迹见 `bug-stale-arrival/tlc.log` 与 `messages.json`（第 5 步）。
  - R2 反例：`Receive(w1)` → `Claim(w1,acp,0,0)` → `Observe(success)` → `PublishReply`（`replyCount` 0→1）→ 再次 `PublishReply`（1→2）→ 违反 `AtMostOneReply`。
  - R3 反例：`Receive(w1)` → `Claim(w1,acp,0,0)` → `Observe(unknown)` 写 `needs_attention` → 违反 `UnknownStaysAssigned`。
  - R1 反例：`Receive(w1)` → `Claim(acp,0,0)` → `Claim(mcp,0,1)` → 违反 `NoDoubleClaim`。
  - 旧反例轨迹（未来 epoch 领取 + Observe 置 handled）与中间死锁轨迹（全终态 + epoch 饱和）仍保存在历史目录，未覆盖。
- 原始反例和重新检查证据：见“发现及处理”；旧证据全部保留，未覆盖、未删除，也未编辑 runner 结果。

## 发现及处理

1. **旧 fixed 反例（未来 epoch 领取）**：`.agent-output/s8-314-tla/small/`，`NoStaleHandled is violated.`。轨迹为 `Receive(w1)` → `Claim` 使用 `ep=1` 而当时 `modeEpoch=0` → `Observe` 将 `status` 置为 `handled`。这是模型语义错误，不是性质过强。处理：在 `Claim` 增加 `e = modeEpoch`，不删性质。该证据保留作为敏感性证明，不代表当前模型失败。
2. **旧代际观察可改写状态（额外语义问题）**：原 `Observe` 只要求匹配 claim 且 `status=assigned`，因此 `ep < modeEpoch` 的 claim 也能写 `status/outcome`。处理：`Observe` 增加 `owner[w]=c` 与 `e=modeEpoch`，旧代际结果只能走 `StaleArrival`；本轮再以 `NoStaleEffect` 命名该保证并补上隔离错误变体，缺口已关闭。
3. **错误变体不可达（敏感性空洞）**：原 `Claim` 要求 `status=pending`，重复领取不可达。处理：允许在 `pending`/`assigned` 上尝试领取，唯一性由 `DuplicateAllowed=FALSE` 守卫承担；`bug-double-claim-r4` 再次确认反例可达。
4. **终态死锁（中间运行）**：`small-fixed-v2` 在所有 WorkItem 为 `needs_attention` 且 `modeEpoch=1` 饱和时报告死锁（错误码 2114）。处理：新增仅在该状态启用的 `Terminal` 自环，死锁检查仍开启；后续 `small-fixed-v3` 及本轮 `small-fixed-r4` 均通过。本轮加入 `staleEffect` 后未出现新死锁，未改动 `Terminal` 语义。
5. **R2 重复 Reply 敏感性缺口**：`ReplyGuardEnabled` 开关 + `ReplyLimit`；`bug-double-reply-r4` 命中 `AtMostOneReply`。R2/R3 轮已处理，本轮随配置更新在新目录复跑确认。
6. **R3 unknown 状态改写敏感性缺口**：`UnknownGuardEnabled` 开关；`bug-unknown-changes-state-r4` 命中 `UnknownStaysAssigned`。同上在新目录复跑确认。
7. **R4 旧代际“无效果”缺少命名不变式与变异证据（本轮补齐）**：新增 `staleEffect` 诊断位（初值 `FALSE`，纳入 `TypeOK`，所有动作显式维护）与不变式 `NoStaleEffect == staleEffect = FALSE`；新增隔离常量 `StaleGuardEnabled`，fixed 与既有错误变体为 `TRUE`，`bug-stale-arrival.cfg` 为 `FALSE`。后者使 `StaleArrival` 在旧 epoch claim 返回时写 `status/outcome/replyCount` 并置 `staleEffect=TRUE`，在 `bug-stale-arrival/` 命中 `Invariant NoStaleEffect is violated.`，证明该性质能捕获旧代际状态/Reply 效果。未删除 `NoStaleHandled`，未关闭死锁检查，未用 `CONSTRAINT` 过滤；fixed 在新目录 `small-fixed-r4` 保持 `PASS_WITHIN_SCOPE`。

## 交接与可选回检

- 设计契约：`contract.md` 记录需求到性质、模型边界、基线/变更与检查计划；`handoff.md` 记录 O1–O7 语义义务、C1–C6 回归场景与返回验证条件。
- 回归场景是测试规格，不是已执行测试；实现方需自行编写、运行并提供证据，未执行保持 NOT_RUN。
- 未覆盖的代码级问题：真实并发原子性、DB/FS 语义、宿主投递、崩溃恢复、外部副作用、needs_attention 人工流程、组合系统性质。
- 仅 align：本轮未进入 align，无源码对应表、无内容标识、无对应基线推进；实现状态保持 `NOT_ASSESSED`。
- 外部测试证据：未提供；不把模型 PASS 当作外部测试结果。

## 限制

- `PASS_WITHIN_SCOPE` 仅表示在 `W=2,C=2,E={0,1},G=2`、给定动作与公平性/故障假设下完成穷举检查；不覆盖任意规模、活性或真实实现。
- 错误变体 `COUNTEREXAMPLE` 是预期的敏感性证据，不是交付通过证据；它与 fixed PASS 分开记录，且只覆盖各自被关闭的守卫。变异检查不能证明所有遗漏都已排除。
- 用户指定的旧输出目录全部保留：`.agent-output/s8-314-tla/small/`、`small-fixed-v2/`、`small-fixed-v3/`、`small-fixed-r2r3/`、`bug-double-claim-v2/`、`bug-double-reply/`、`bug-unknown-changes-state/` 未被覆盖或删除。本轮五个目录均为新建。
- 当前 fixed 结论以 `small-fixed-r4/result.json` 与其 `input/` 快照（模型 SHA `aa073f…`、manifest SHA `5e5a95…`）为准；旧反例仍对应旧模型快照，不代表当前模型失败。
- `NoStaleEffect` 的敏感性由 `bug-stale-arrival` 单一隔离变体演示；它覆盖“旧 epoch claim 在 mode 切换后返回迟到结果”这一路径，不替代实现层的代际校验测试。
- 未做独立模型复核；作者自查不替代独立复核，状态保持 `NOT_RUN`。实现状态保持 `NOT_ASSESSED`，产物释放、合并、关票均不在本切片范围。

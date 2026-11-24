# 设计与形式化验证交接

## 接收方先读

- 目标功能和用户需求来源：S8 #314「统一消费账本、代际隔离及形式化验证」；设计基线为 #312/#314 票面，二者均**不是已接受的实施主线**。
- 交接文档版本 / 内容标识：`docs/design/s8-delivery-accounting/` 下三份文档；当前模型 SHA-256 `aa073f7a48996593841417d17e4d9ded1c5f3510c5eec54c9938cc65c14761ce`，manifest SHA-256 `5e5a95cf3c2eea8d5ac3f2c093060a609cb395b356788417f754260c46702638`。
- 关联契约、项目适配记录和设计决策：`contract.md`、`report.md`、`tla/`、`verification.json`；实现对应未进入 align 模式。
- 当前模型结果：fixed 配置 `PASS_WITHIN_SCOPE`（当前快照 `.agent-output/s8-314-tla/small-fixed-r4/`；旧快照 `small-fixed-r2r3/`、`small-fixed-v3/` 保留）；错误变体 `COUNTEREXAMPLE`（`.agent-output/s8-314-tla/bug-double-claim-r4/`、`bug-double-reply-r4/`、`bug-unknown-changes-state-r4/`、`bug-stale-arrival/`），仅作敏感性证据，与 fixed PASS 分开，不计入交付通过记录。
- 实现对应状态：NOT_ASSESSED。模型通过不代表业务实现已验证，也不代表任何产物可以释放或部署。
- 阻塞问题与尚待决策项：needs_attention 的人工处理/对账语义、真实宿主原子性与持久化机制、独立模型复核（本轮 `NOT_RUN`）。R1–R4 的形式化敏感性证据均已具备，但回归测试仍待实现方执行。

本材料可交给任意实现者。材料完整不代表模型通过，更不代表业务实现已经完成。

## 必须保持的业务保证

| 需求 ID | 业务性质（自然语言） | 模型性质 / 证据 | 依赖的环境条件 |
|---|---|---|---|
| R1 | 同一 WorkItem 至多一个有效领取/owner；已领取项再次收到领取尝试也必须拒绝 | `NoDoubleClaim`：fixed 通过，`bug-double-claim-r4` 反例证明可捕获 | 领取互斥与状态/owner 变更原子；拟议，未核实 |
| R2 | 同一 WorkItem 至多一个 Reply，且 Reply 只能在 handled 后产生 | `AtMostOneReply`、`ReplyMatchesDisposition`：fixed 通过；`bug-double-reply-r4` 中第二次 `PublishReply` 使 `replyCount=2`，命中 `AtMostOneReply` 反例 | 幂等键持久化；拟议 |
| R3 | outcome 为 unknown 后状态保持 assigned | `UnknownStaysAssigned`：fixed 通过；`bug-unknown-changes-state-r4` 中 unknown 改写 `needs_attention`，命中反例 | unknown 判定与状态写入顺序；拟议 |
| R4 | 旧代际观察/迟到响应不能改写状态或产生 Reply；handled 不能由未来 epoch 支撑 | `NoStaleHandled` + `NoStaleEffect`：fixed 通过；旧 `small/` 反例展示未来 epoch 缺口，`bug-stale-arrival/` 展示旧代际写状态/Reply 并命中 `NoStaleEffect` | epoch 单调、fencing 先于切换、代际校验先于状态写入；拟议 |

`NoStaleEffect == staleEffect = FALSE`，其中 `staleEffect` 是诊断位：fixed 与 R1/R2/R3 变体所有动作保持 `FALSE`；仅 `bug-stale-arrival` 关闭 `StaleGuardEnabled` 后由 `StaleArrival` 置 `TRUE`。该不变式已纳入所有五份配置的 `INVARIANTS` 与 `verification.json` 的 `expected_invariants`。

## 实现语义义务

| 义务 ID | 必须满足的语义 | 关联需求 / 模型动作 | 实现方需提供的依据 | 不满足时的影响 |
|---|---|---|---|---|
| O1 | `Claim` 只接受 `e = modeEpoch`；未来 epoch 的领取必须被拒绝 | R1/R4，`Claim` | 当前 epoch 来源、校验与拒绝路径的真实机制与测试 | 旧反例重演，handled 可被未来代际支撑 |
| O2 | 领取互斥覆盖 `pending` 和 `assigned` 两种状态；重复领取不能只靠 `status = pending` 阻挡 | R1，`Claim` + `DuplicateAllowed` 守卫 | CAS/唯一约束/锁等机制说明与并发实测 | 双通道同时消费同一消息 |
| O3 | 领取记录、`status`、`owner` 的变更必须处在同一个可线性化边界内 | R1/R2，`Claim` | 事务范围或等价原子机制证据 | 双领或无主 assigned 状态 |
| O4 | `Observe` 只接受当前 epoch 且属于当前 `owner` 的领取记录；旧代际结果不得写 `status/outcome/replyCount`，也不得触发 Reply —— 对应 `NoStaleEffect` | R4，`Observe`/`StaleArrival`/`NoStaleEffect` | 代际校验顺序与拒绝路径证据；旧 epoch 结果注入后的状态/Reply 观测 | 旧结果改写当前状态或触发二次 Reply，模型反例可直接重演 |
| O5 | `PublishReply` 仅在 `handled` 且尚未发布时产生一次 Reply | R2，`PublishReply` | 幂等键与唯一约束证据 | 重复外部副作用 |
| O6 | `SwitchMode` 单调递增 `modeEpoch`，先 fence 旧通道再允许新通道；切换后的对账在模型外 | R4，`SwitchMode` | 切换顺序与对账入口证据 | ACP/MCP 双路投递 |
| O7 | `needs_attention` 的后续人工处理、崩溃恢复与消息重试语义由实现层定义，不能借模型 PASS 省略 | R3，`Terminal` 边界 | 状态机与运维/人工流程说明 | 工作项永久卡住被误当合法终态 |

## 可自由选择与须返回讨论的事项

- 可自由选择的机制：数据库唯一约束、CAS、事务锁、应用层互斥或等价方案均可；只要能满足 O1–O6 并可提供证据，模型不规定具体技术栈。R4 的 `staleEffect` 只是模型诊断位，实现不需要暴露同名变量，但必须提供可观测的“旧代际结果未产生状态/Reply 效果”证据。
- 已确定的部分：状态名与语义（`pending/assigned/handled/needs_attention`、`unknown` 保持 `assigned`）、epoch 与 generation 分离、单 WorkItem 单 owner、Reply 最多一次、旧代际无效果。
- 尚未决策或待确认：真实持久化 schema、对账流程、needs_attention 的人工闭环、外部投递的可查询/可撤销能力。
- 不可无说明改变：R1–R4 的业务保证、fencing 先于切换、`NOT_ASSESSED` 的实现状态以及有限检查范围。

## 模型与可复现证据

- 模型 / 配置 / manifest：`docs/design/s8-delivery-accounting/tla/DeliveryLedger.tla`（SHA-256 `aa073f7a48996593841417d17e4d9ded1c5f3510c5eec54c9938cc65c14761ce`）、`fixed.cfg`（`8dc21e973ebb0a29b3f0d0225e62d720120bb601ff770e509158edfba63251d1`）、`bug-double-claim.cfg`（`3a258018bd53cc2f0ead6514ff4c8a7614699ab05b331b56abb5e296e98f9a17`）、`bug-double-reply.cfg`（`0d960267263d97eaba8fe07099f8650bb7f400fab234de1f80095f430b0f6b1a`）、`bug-unknown-changes-state.cfg`（`5e791e63bd1dfc83da85acb4863c686a7e44e98f8c483a07735173bd25172363`）、新增 `bug-stale-arrival.cfg`（`bcd64650184c08c2c14f28aa9a4de6595cf6e3796b14ac703adf20c2600a40fa`）、`docs/design/s8-delivery-accounting/verification.json`（SHA-256 `5e5a95cf3c2eea8d5ac3f2c093060a609cb395b356788417f754260c46702638`）。
- 新增配置开关与诊断位：`ReplyGuardEnabled`、`UnknownGuardEnabled`、`StaleGuardEnabled` 为配置级隔离开关；fixed 与 R1 变体三者均 `TRUE`，R2 仅前者 `FALSE`，R3 仅后者 `FALSE`，R4 仅 `StaleGuardEnabled=FALSE`。`staleEffect` 为布尔诊断位，纳入 `TypeOK`，所有动作显式 `UNCHANGED` 或赋值；fixed 下始终 `FALSE`。`replyCount` 域为有限 `0..2`，fixed 下仍只到达 0/1；所有性质名和死锁检查未变，也未使用 `CONSTRAINT`。
- 工具：v1.7.4 / TLC 2.19，jar SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`，Java `/opt/homebrew/opt/openjdk@17/bin/java`，runner `.agents/skills/worker-tla/scripts/run_tlc.py`。jar 由本地已核对摘要文件复用，未下载新工具。
- 实际命令（均在候选 worktree 根执行，`--jar` 为绝对路径，`--out` 均为新目录）：
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile small --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/small-fixed-r4`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-stale-arrival --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-stale-arrival`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-double-claim --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-double-claim-r4`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-double-reply --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-double-reply-r4`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-unknown-changes-state --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-unknown-changes-state-r4`
- 完整结果、原始日志与反例（`result.json`、`tlc.log`、`messages.json`）：
  - `small-fixed-r4/`：`PASS_WITHIN_SCOPE` / `COMPLETE_MODEL_CHECK`，生成 13437 / 不同 2532 / 剩余 0，`completed=true`，退出码 0，错误码 `[]`，警告码 `[]`，`implementation_status=NOT_ASSESSED`。状态计数与旧 `small-fixed-r2r3`、`small-fixed-v3` 一致。
  - `bug-stale-arrival/`：`COUNTEREXAMPLE` / `PROPERTY_OR_DEADLOCK_VIOLATION`，`Invariant NoStaleEffect is violated.`，生成 188 / 不同 148 / 剩余 115，`completed=false`，退出码 12，错误码 `[2110, 2121]`，`implementation_status=NOT_ASSESSED`。
  - `bug-double-claim-r4/`：`COUNTEREXAMPLE`，`Invariant NoDoubleClaim is violated.`，生成 52 / 不同 29 / 剩余 21，退出码 12，错误码 `[2110, 2121]`。
  - `bug-double-reply-r4/`：`COUNTEREXAMPLE`，`Invariant AtMostOneReply is violated.`，生成 799 / 不同 469 / 剩余 327，退出码 12，错误码 `[2110, 2121]`。
  - `bug-unknown-changes-state-r4/`：`COUNTEREXAMPLE`，`Invariant UnknownStaysAssigned is violated.`，生成 37 / 不同 31 / 剩余 23，退出码 12，错误码 `[2110, 2121]`。
  - 历史目录 `small/`、`small-fixed-v2/`、`small-fixed-v3/`、`small-fixed-r2r3/`、`bug-double-claim-v2/`、`bug-double-reply/`、`bug-unknown-changes-state/` 全部保留，未覆盖、未删除；runner 结果未编辑。
- 有限规模、启用性质、故障与公平性：`W=2,C=2,E={0,1},G=2`；fixed 启用七项不变式 + 死锁检查；`bug-double-claim.cfg` 启用 `TypeOK` + `NoDoubleClaim` + `NoStaleEffect`；`bug-double-reply.cfg` 启用 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition` + `NoStaleEffect`；`bug-unknown-changes-state.cfg` 启用 `TypeOK` + `UnknownStaysAssigned` + `NoStaleEffect`；`bug-stale-arrival.cfg` 启用 `TypeOK` + `NoStaleEffect`；均为死锁检查开启、`liveness: NOT_CHECKED`、无公平性假设。
- 可达性与敏感性证据：`NoDoubleClaim` 由 `bug-double-claim-r4` 反例证明可捕获；`AtMostOneReply` 由 `bug-double-reply-r4` 两次 `PublishReply` 反例证明可捕获；`UnknownStaysAssigned` 由 `bug-unknown-changes-state-r4` unknown 改写状态的反例证明可捕获；`NoStaleEffect` 由 `bug-stale-arrival` 旧代际写状态/Reply 的反例证明可捕获；`NoStaleHandled` 由旧 `small/` 反例证明可捕获。R4 旧快照与当前 fixed 快照分开保存。

## 实现方的回归场景

| 场景 ID / 需求 | 初始条件和输入 | 关键交错 / 故障顺序 | 应观察的业务结果 | 所需控制能力 / 证据来源 |
|---|---|---|---|---|
| C1 / R1 | `w1` 已由 `acp` 在 epoch 0 领取，`status=assigned` | 第二个通道 `mcp` 对同一 `w1` 发起 epoch 0 领取 | 第二次领取被拒绝；`claims` 中 `wi=w1` 记录数仍为 1，`owner` 不被改写 | 可重复并发领取；`bug-double-claim-r4/messages.json` 第 4 步反例 |
| C2 / R4 | `modeEpoch=0`，`w1` 为 `pending` | 携带 `ep=1` 的领取尝试，随后观察 success | 领取被拒绝，`status` 不得变为 `handled` | 可注入未来 epoch；旧 `small/messages.json` 反例 |
| C3 / R4 | `w1` 在 epoch 0 已由 `acp` 领取，`status=assigned`，`replyCount=0` | 先 `SwitchMode(1,mcp)`，再让 epoch 0 的 claim 返回 success | `status/outcome/replyCount` 不变，不产生 Reply；对应 `NoStaleEffect` 保持为 TRUE | 可控 mode 切换与旧结果注入；`bug-stale-arrival/tlc.log` 第 4–5 步反例 |
| C4 / R2 | `w1=handled`，`replyCount=0` | 连续两次发布 Reply | 只有一次成功，第二次被幂等拒绝；`replyCount<=1` | 可重复发布与外部副作用记录；`bug-double-reply-r4/messages.json` 中 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(success)` → `PublishReply` → 再次 `PublishReply`（`replyCount=2` 命中 `AtMostOneReply`） |
| C5 / R3 | `w1` 观察结果 `unknown` | 随后尝试再次领取或改变状态 | `status` 保持 `assigned`，无第二执行 | 可控观察结果与领取尝试；`bug-unknown-changes-state-r4/messages.json` 中 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(unknown)` 将状态改为 `needs_attention`（命中 `UnknownStaysAssigned`） |
| C6 / R4 | 初始 `modeEpoch=0`，`w1` 由 `acp` 在 epoch 0 领取，`status=assigned`，`replyCount=0`；`mcp` 初始被 fence | ① `SwitchMode(1,mcp)`：`modeEpoch=1`，`fenced[acp]=TRUE`、`fenced[mcp]=FALSE`；② 旧 `ep=0` claim 返回 success（迟到响应） | 旧通道 `acp` 的迟到响应被拒绝：`status` 仍为 `assigned`、`outcome` 仍为 `none`、`replyCount` 仍为 0；新通道 `mcp` 可按 epoch 1 正常领取。模型错误变体在该顺序下写 `status=handled`、`outcome=success`、`replyCount=1`、`staleEffect=TRUE`，命中 `NoStaleEffect` | 可控 epoch 切换、通道 fence 状态与旧结果注入；`bug-stale-arrival/tlc.log` 反例顺序为 `Receive(w1)` → `Claim(w1,acp,ep=0,gen=0)` → `SwitchMode(1,mcp)` → `StaleArrival(res=success)` → 违反 `NoStaleEffect`；实现方需提供业务可观测的拒绝证据 |

这里是测试规格；实际编写、执行与通用代码审查由接收方安排。未提供真实测试证据时保持 NOT_RUN。

## 返回验证的条件

- 状态转移、参与者、并发度、原子性或持久化边界变化：需要重新评估 O1–O7 与模型范围。
- 消息、重试、取消、崩溃恢复或外部效果语义变化：需要更新模型/清单并重跑受影响 profile。
- 关键需求 / 环境条件 / 运行语义变化：R1–R4 或 epoch/fence 语义变化需回到需求流程，不直接改性质名掩盖反例。
- 实现方无法满足某项义务或发现新交错：返回具体交错与证据；由用户决定是否进入 align。
- 接收方返回内容：实际修改内容标识、覆盖文件与符号、义务到机制的映射、已运行测试证据、语义变化及未解决问题。

## 未覆盖事项

- 活性、公平性、最终完成与调度饥饿（`NOT_CHECKED`）。
- 崩溃/恢复、消息丢失、真实超时、租约、持久化可见性与真实数据库/文件系统语义。
- ACP/真实宿主能力、外部副作用、跨项目泄露与组合系统性质。
- `needs_attention` 的人工处理、fencing 后对账流程。
- 代码级并发、语言运行时语义与通用代码审查；实现对应状态 NOT_ASSESSED。
- `NoStaleEffect` 的敏感性只覆盖“旧 epoch claim 在 mode 切换后返回迟到结果”这一路径，不替代实现层代际校验测试。
- 独立模型复核：本轮 NOT_RUN；作者自查不能替代独立复核。

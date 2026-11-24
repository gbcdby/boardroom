# 设计与形式化验证交接

## 接收方先读

- 目标功能和用户需求来源：S8 #314「统一消费账本、代际隔离及形式化验证」；设计基线为 #312/#314 票面，二者均**不是已接受的实施主线**。
- 交接文档版本 / 内容标识：`docs/design/s8-delivery-accounting/` 下三份文档；当前模型 SHA-256 `ca26804cf7f79475f8c676fd730b97c5f4ab0f27ec2af8aeef9c8fd9495310c8`，manifest SHA-256 `af35784f0b26ed1e9f68f892bce48b634c43150aa35c9d013578ab1bc2ad60a2`。
- 关联契约、项目适配记录和设计决策：`contract.md`、`report.md`、`tla/`、`verification.json`；实现对应未进入 align 模式。
- 当前模型结果：fixed 配置 `PASS_WITHIN_SCOPE`（当前快照 `.agent-output/s8-314-tla/small-fixed-r2r3/`；旧快照 `small-fixed-v3/` 保留）；错误变体 `COUNTEREXAMPLE`（`.agent-output/s8-314-tla/bug-double-claim-v2/`、`bug-double-reply/`、`bug-unknown-changes-state/`），仅作敏感性证据，不计入交付通过记录。
- 实现对应状态：NOT_ASSESSED。模型通过不代表业务实现已验证，也不代表任何产物可以释放或部署。
- 阻塞问题与尚待决策项：needs_attention 的人工处理/对账语义、真实宿主原子性与持久化机制、旧代际无效果性质的单独敏感性证据、独立模型复核（本轮 NOT_RUN）。R2/R3 的敏感性缺口已由本轮错误变体补齐。

本材料可交给任意实现者。材料完整不代表模型通过，更不代表业务实现已经完成。

## 必须保持的业务保证

| 需求 ID | 业务性质（自然语言） | 模型性质 / 证据 | 依赖的环境条件 |
|---|---|---|---|
| R1 | 同一 WorkItem 至多一个有效领取/owner；已领取项再次收到领取尝试也必须拒绝 | `NoDoubleClaim`：fixed 通过，`bug-double-claim-v2` 反例证明可捕获 | 领取互斥与状态/owner 变更原子；拟议，未核实 |
| R2 | 同一 WorkItem 至多一个 Reply，且 Reply 只能在 handled 后产生 | `AtMostOneReply`、`ReplyMatchesDisposition`：fixed 通过；`bug-double-reply/` 中第二次 `PublishReply` 使 `replyCount=2`，命中 `AtMostOneReply` 反例 | 幂等键持久化；拟议 |
| R3 | outcome 为 unknown 后状态保持 assigned | `UnknownStaysAssigned`：fixed 通过；`bug-unknown-changes-state/` 中 unknown 改写 `needs_attention`，命中反例 | unknown 判定与状态写入顺序；拟议 |
| R4 | 旧代际观察不能改写状态或产生 Reply；handled 不能由未来 epoch 支撑 | `NoStaleHandled` 加 `Claim`/`Observe` 守卫：fixed 通过；旧反例展示未来 epoch 缺口 | epoch 单调、fencing 先于切换；拟议 |

## 实现语义义务

| 义务 ID | 必须满足的语义 | 关联需求 / 模型动作 | 实现方需提供的依据 | 不满足时的影响 |
|---|---|---|---|---|
| O1 | `Claim` 只接受 `e = modeEpoch`；未来 epoch 的领取必须被拒绝 | R1/R4，`Claim` | 当前 epoch 来源、校验与拒绝路径的真实机制与测试 | 旧反例重演，handled 可被未来代际支撑 |
| O2 | 领取互斥覆盖 `pending` 和 `assigned` 两种状态；重复领取不能只靠 `status = pending` 阻挡 | R1，`Claim` + `DuplicateAllowed` 守卫 | CAS/唯一约束/锁等机制说明与并发实测 | 双通道同时消费同一消息 |
| O3 | 领取记录、`status`、`owner` 的变更必须处在同一个可线性化边界内 | R1/R2，`Claim` | 事务范围或等价原子机制证据 | 双领或无主 assigned 状态 |
| O4 | `Observe` 只接受当前 epoch 且属于当前 `owner` 的领取记录；旧代际结果不得写 `status/outcome/replyCount` | R4，`Observe`/`StaleArrival` | 代际校验顺序与拒绝路径证据 | 旧结果改写当前状态或触发二次 Reply |
| O5 | `PublishReply` 仅在 `handled` 且尚未发布时产生一次 Reply | R2，`PublishReply` | 幂等键与唯一约束证据 | 重复外部副作用 |
| O6 | `SwitchMode` 单调递增 `modeEpoch`，先 fence 旧通道再允许新通道；切换后的对账在模型外 | R4，`SwitchMode` | 切换顺序与对账入口证据 | ACP/MCP 双路投递 |
| O7 | `needs_attention` 的后续人工处理、崩溃恢复与消息重试语义由实现层定义，不能借模型 PASS 省略 | R3，`Terminal` 边界 | 状态机与运维/人工流程说明 | 工作项永久卡住被误当合法终态 |

## 可自由选择与须返回讨论的事项

- 可自由选择的机制：数据库唯一约束、CAS、事务锁、应用层互斥或等价方案均可；只要能满足 O1–O6 并可提供证据，模型不规定具体技术栈。
- 已确定的部分：状态名与语义（`pending/assigned/handled/needs_attention`、`unknown` 保持 `assigned`）、epoch 与 generation 分离、单 WorkItem 单 owner、Reply 最多一次、旧代际无效果。
- 尚未决策或待确认：真实持久化 schema、对账流程、needs_attention 的人工闭环、外部投递的可查询/可撤销能力。
- 不可无说明改变：R1–R4 的业务保证、fencing 先于切换、`NOT_ASSESSED` 的实现状态以及有限检查范围。

## 模型与可复现证据

- 模型 / 配置 / manifest：`docs/design/s8-delivery-accounting/tla/DeliveryLedger.tla`（SHA-256 `ca26804cf7f79475f8c676fd730b97c5f4ab0f27ec2af8aeef9c8fd9495310c8`）、`fixed.cfg`（`fdf6be03264f815c9a7c20dca88808ee9cca16d36e492405e11fc6c7b5220df9`）、`bug-double-claim.cfg`（`f36c7fc0b99c794bdccdef304e4bdd267f26ac74870e2341c6bac0a66fedda3d`）、`bug-double-reply.cfg`（`3a45ead0b85c2541df235caaea59e8e0993d63d2cebaef93400e6baf011155f9`）、`bug-unknown-changes-state.cfg`（`dd9baaf0aeec0d68a8b5c4cff86188ebcc7e0fec92b4d8795d3b476a369ba664`）、`docs/design/s8-delivery-accounting/verification.json`（SHA-256 `af35784f0b26ed1e9f68f892bce48b634c43150aa35c9d013578ab1bc2ad60a2`）。
- 新增配置开关：`ReplyGuardEnabled` 与 `UnknownGuardEnabled` 为配置级隔离开关；fixed 与 R1 变体均为 `TRUE`，R2 变体仅前者 `FALSE`，R3 变体仅后者 `FALSE`。`replyCount` 域为有限 `0..2`，fixed 下仍只到达 0/1；所有性质名和死锁检查未变，也未使用 `CONSTRAINT`。
- 工具：v1.7.4 / TLC 2.19，jar SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`，Java `/opt/homebrew/opt/openjdk@17/bin/java`，runner `.agents/skills/worker-tla/scripts/run_tlc.py`。jar 由本地已核对摘要文件复用，未下载新工具。
- 实际命令（均在仓库根执行，`--jar` 为绝对路径，`--out` 均为新目录）：
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile small --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/small-fixed-r2r3`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-double-claim --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-double-claim-v2`（历史快照，旧清单/模型）
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-double-reply --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-double-reply`
  - `python3 .agents/skills/worker-tla/scripts/run_tlc.py --manifest docs/design/s8-delivery-accounting/verification.json --profile bug-unknown-changes-state --jar "$PWD/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar" --java /opt/homebrew/opt/openjdk@17/bin/java --out .agent-output/s8-314-tla/bug-unknown-changes-state`
- 完整结果、原始日志与反例：`small-fixed-r2r3/result.json`、`tlc.log`、`messages.json`（PASS，生成 13437 / 不同 2532 / 剩余 0，`completed=true`，退出码 0，错误码 `[]`）；`bug-double-reply/result.json`、`tlc.log`、`messages.json`（`Invariant AtMostOneReply is violated.`，生成 799 / 不同 469 / 剩余 327，`completed=false`，退出码 12，错误码 `[2110, 2121]`）；`bug-unknown-changes-state/result.json`、`tlc.log`、`messages.json`（`Invariant UnknownStaysAssigned is violated.`，生成 37 / 不同 31 / 剩余 23，`completed=false`，退出码 12，错误码 `[2110, 2121]`）；`bug-double-claim-v2/result.json`（`NoDoubleClaim` 反例，历史快照）；旧反例在 `.agent-output/s8-314-tla/small/`，中间死锁证据在 `.agent-output/s8-314-tla/small-fixed-v2/`。所有 runner 结果的 `implementation_status` 均为 `NOT_ASSESSED`，未编辑。
- 有限规模、启用性质、故障与公平性：`W=2,C=2,E={0,1},G=2`；fixed 启用六项不变式 + 死锁检查；`bug-double-claim.cfg` 启用 `TypeOK` + `NoDoubleClaim`；`bug-double-reply.cfg` 启用 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition`；`bug-unknown-changes-state.cfg` 启用 `TypeOK` + `UnknownStaysAssigned`；均为死锁检查开启、`liveness: NOT_CHECKED`、无公平性假设。
- 可达性与敏感性证据：`NoDoubleClaim` 由 `bug-double-claim-v2` 反例证明可捕获；`AtMostOneReply` 由 `bug-double-reply` 中两次 `PublishReply` 反例证明可捕获；`UnknownStaysAssigned` 由 `bug-unknown-changes-state` 中 unknown 改写状态的反例证明可捕获；`NoStaleHandled` 由旧 `small/` 反例证明可捕获。旧代际状态改写仍无单独变异运行证据。R4 的旧快照与当前 fixed 快照分开保存。
- 有源码时的评估内容标识：NOT_ASSESSED；本轮未进行源码对应核验。

## 实现方的回归场景

| 场景 ID / 需求 | 初始条件和输入 | 关键交错 / 故障顺序 | 应观察的业务结果 | 所需控制能力 / 证据来源 |
|---|---|---|---|---|
| C1 / R1 | `w1` 已由 `acp` 在 epoch 0 领取，`status=assigned` | 第二个通道 `mcp` 对同一 `w1` 发起 epoch 0 领取 | 第二次领取被拒绝；`claims` 中 `wi=w1` 记录数仍为 1，`owner` 不被改写 | 可重复并发领取；`bug-double-claim-v2/messages.json` 第 4 步反例 |
| C2 / R4 | `modeEpoch=0`，`w1` 为 `pending` | 携带 `ep=1` 的领取尝试，随后观察 success | 领取被拒绝，`status` 不得变为 `handled` | 可注入未来 epoch；旧 `small/messages.json` 反例 |
| C3 / R4 | `w1` 在 epoch 0 已领取，`status=assigned` | 切换到 epoch 1 后，旧 claim 返回 success | `status/outcome/replyCount` 不变，不产生 Reply | 可控 mode 切换与旧结果注入 |
| C4 / R2 | `w1=handled`，`replyCount=0` | 连续两次发布 Reply | 只有一次成功，第二次被幂等拒绝；`replyCount<=1` | 可重复发布与外部副作用记录；`bug-double-reply/messages.json` 中 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(success)` → `PublishReply` → 再次 `PublishReply`（`replyCount=2` 命中 `AtMostOneReply`） |
| C5 / R3 | `w1` 观察结果 `unknown` | 随后尝试再次领取或改变状态 | `status` 保持 `assigned`，无第二执行 | 可控观察结果与领取尝试；`bug-unknown-changes-state/messages.json` 中 `Receive(w1)` → `Claim(acp,0,0)` → `Observe(unknown)` 将状态改为 `needs_attention`（命中 `UnknownStaysAssigned`） |
| C6 / R4 | epoch 0 下 `acp` 未领取，`mcp` 被 fence | `SwitchMode(1,mcp)` 后 `acp` 尝试领取 | 旧通道领取被拒绝；新通道可按当前 epoch 领取 | 可控切换与通道身份 |

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
- 旧代际观察“无状态效果”没有单独命名的不变式或变异运行证据。
- 代码级并发、语言运行时语义与通用代码审查；实现对应状态 NOT_ASSESSED。
- 独立模型复核：本轮 NOT_RUN；作者自查不能替代独立复核。

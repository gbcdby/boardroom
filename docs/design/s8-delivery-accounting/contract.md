# 设计与验证契约

## 任务

- 项目 / 功能：boardroom / S8 #314「统一消费账本、代际隔离及形式化验证」TLA+ 切片。
- 模式：design（总控指定；用户要求 subagent 使用 free model 执行本切片）。
- 用户需求及已确认规则的来源：本轮总控任务；[#312](https://github.com/gbcdby/boardroom/issues/312) 子 spec 与 [#314](https://github.com/gbcdby/boardroom/issues/314) ticket。二者当前状态是**设计基线**，不是已接受的实施主线，不构成对现有 main 的已验收承诺。
- 设计边界及适配记录：仅限 `docs/design/s8-delivery-accounting/` 下的 TLA+ 模型、配置、验证清单与交接文档；不修改业务实现、项目测试或部署配置。
- 现有源码内容标识：NOT_ASSESSED。本轮没有以源码对应核验为目的读取或改动 `src/`；模型语义来自 #312/#314 的拟议边界，不冒充实现事实。

## 调用方与设计决策

- 真实调用场景和可观察结果：ACP 与 external_mcp 共用一条 WorkItem → Run → DeliveryDisposition → Reply 账本；一个 WorkItem 从 `pending` 经领取进入 `assigned`，最终为 `handled` 或 `needs_attention`；结果未知时保持 `assigned`，不二次执行、不暗中切换通道兜底。跨通道切换必须先 fencing、再对账。
- 接口输入、输出、错误及未知结果：模型动作 `Receive(w)`；`Claim(w,c,e,g)` 携带通道 `c`、epoch `e`、generation `g`；`Observe(w,c,e,g,res)` 的 `res ∈ {success, failure, unknown}`；`PublishReply(w)`；`StaleArrival(w,c,e,g,res)` 在 `StaleGuardEnabled=TRUE` 下为旧代际空动作，在隔离错误变体下写状态/Reply 并置 `staleEffect=TRUE`；`SwitchMode(e2,cNew)` 单调推进 epoch 并 fence 其它通道；`Terminal` 为合法终态自环。
- 状态所有权、生命周期、提交与外部效果边界：账本状态为设计拟议的单一所有权；`owner[w]` 表示当前领取通道，`claims` 记录领取身份，`replyCount` 约束幂等发布，`staleEffect` 是 R4 诊断位。事务边界、持久化、真实宿主投递与对账机制均为实现义务，未在模型中核实。
- 关键结构选择及理由：
  - `Claim` 只允许 `e = modeEpoch`，禁止未来 epoch 预领取；这是旧反例指出的真实语义缺口。
  - `Claim` 的前置状态允许 `pending` 或 `assigned`，使“已领取项再次收到领取尝试”可达；唯一性由 `DuplicateAllowed = FALSE` 一侧的 `claims` 互斥守卫表达，而不是靠把 `status` 锁死为 `pending` 来人为消灭敏感性。
  - `Observe` 要求 `owner[w] = c`、`e = modeEpoch` 且存在匹配的 claim；旧 epoch 结果只能通过 `StaleArrival` 表达为无状态效果。
  - `StaleGuardEnabled` 与 `staleEffect`：fixed 与 R1/R2/R3 既有错误变体关闭开关前均为 `TRUE`，旧代际到达保持空动作；仅 `bug-stale-arrival.cfg` 置 `FALSE`，让 `StaleArrival` 写 `status/outcome/replyCount` 并置诊断位 `TRUE`，使 `NoStaleEffect` 可被命中。`staleEffect` 纳入 `TypeOK`，所有动作显式 `UNCHANGED` 或赋值，fixed 下不允许无约束变化。
  - `Terminal` 仅在所有 WorkItem 已处于 `handled`/`needs_attention` 且 `E` 中无更高 epoch 时启用；死锁检查保持开启，不用全局自环掩盖意外卡死。
- 方案是否依赖尚未确认的条件：依赖“领取互斥与状态变更原子”“fencing 先于切换”“needs_attention 的人工处理/对账在模型外”等条件；均列为实现义务而非已核实事实。
- 验证工具选择及未覆盖的代码级问题：TLC 适合协议交错、epoch 隔离与重复领取；不覆盖真实并发竞态、数据库/文件系统语义、崩溃恢复、外部副作用及真实宿主能力。

## 需求到性质

| 需求 ID | 必须满足的业务保证 | 性质名 | 类型 | 启用配置 | 未覆盖项与接收方 |
|---|---|---|---|---|---|
| R1 | 同一 WorkItem 至多一个有效领取/owner，结果未知时也拒绝第二次执行 | `NoDoubleClaim` | safety / invariant | `fixed.cfg`、`bug-double-claim.cfg` | 真实 CAS/唯一约束归属实现方 |
| R2 | 同一 WorkItem 至多一个幂等 Reply，且 Reply 仅来自 handled | `AtMostOneReply`、`ReplyMatchesDisposition` | safety / invariant | `fixed.cfg`、`bug-double-reply.cfg` | 外部投递副作用未建模 |
| R3 | `outcome_unknown` 后状态保持 `assigned` | `UnknownStaysAssigned` | safety / invariant | `fixed.cfg`、`bug-unknown-changes-state.cfg` | 真实 unknown 判定与恢复语义未评估 |
| R4 | 旧代际观察/迟到响应不能改写当前状态或产生 Reply；handled 必须由本 epoch 或更早的合法 claim 支撑 | `NoStaleHandled`、`NoStaleEffect` | safety / invariant | `fixed.cfg`、`bug-stale-arrival.cfg`（另三份错误变体也启用 `NoStaleEffect` 作为非干扰检查） | 真实代际校验与状态写入顺序归属实现方 |
| 类型边界 | 所有变量取值在声明域内（`replyCount` 为有限 `0..2`） | `TypeOK` | 类型 / invariant | 五份配置 | 不能替代业务性质；fixed 下由守卫保证不达到 2 |

性质名保持为 `TypeOK`、`NoDoubleClaim`、`AtMostOneReply`、`ReplyMatchesDisposition`、`UnknownStaysAssigned`、`NoStaleHandled`、`NoStaleEffect`，未删除、未放宽。`NoStaleEffect` 是本轮新增的 R4 显式不变式（`staleEffect = FALSE`）；旧代际“无效果”不再只由动作守卫和可达性表达。

## 模型边界

- 状态、参与者与动作：`W={w1,w2}`、`C={acp,mcp}`、`E={0,1}`、`G={0,1}`；配置常量 `DuplicateAllowed`、`ReplyGuardEnabled`、`UnknownGuardEnabled`、`StaleGuardEnabled`；状态变量 `status/outcome/owner/claims/replyCount/modeEpoch/fenced/staleEffect`，其中 `replyCount` 取有限域 `0..2`；动作见上文。
- 错误变体的隔离方式：`ReplyGuardEnabled=FALSE` 只放宽 `PublishReply` 上限为 2；`UnknownGuardEnabled=FALSE` 只让 `unknown` 观察写 `needs_attention`；`StaleGuardEnabled=FALSE` 只让旧代际 `StaleArrival` 写状态/Reply 并置 `staleEffect=TRUE`。fixed 与 R1 变体三个开关均为 `TRUE`；R2/R3/R4 变体各自只关闭一个。五份配置都保留了自身相关的性质子集且全部启用 `NoStaleEffect`，使用同一 `Spec` 并保持死锁检查，不使用 `CONSTRAINT`。
- 可交错 / 可故障的步骤：领取与观察可交错；重复领取尝试在 `bug-double-claim` 变体中可达；unknown 结果、旧代际到达、模式切换与 fence 均可达；`bug-stale-arrival` 中旧 claim 在 epoch 切换后返回迟到结果可达。
- 原子性义务与已核实依据：`Claim` 的互斥与 `status/owner/claims` 更新被视为一个原子步骤，这是**拟议实现义务**，不是源码证据；`Observe` 的判定与状态更新同理。
- 持久化、提交、确认与外部效果：账本变量代表设计层面的持久视图；真实事务、确认延迟、投递外部效果与幂等键存储未建模。
- 并发、重试、重复、丢失、乱序、故障与恢复：包含重复领取、旧代际乱序到达与 epoch 切换；不包含崩溃/恢复、消息丢失与真实超时。
- 活性依赖的调度、公平性和环境条件：`liveness: NOT_CHECKED`；无公平性假设，不宣称任何最终完成性质。
- 有限规模、抽象方式与排除行为：`E` 上限为 1，因此 epoch 饱和后的终态需要显式自环；排除真实宿主、DB/FS、外部副作用、人工 needs_attention 流程与组合系统性质。
- 合法终止与死锁的区分：`Terminal` 只覆盖所有 WorkItem 已终态且 epoch 饱和的合法结束；其它无动作状态仍会被 TLC 报为死锁。
- 关键性质敏感性证据：`NoStaleHandled` 由旧 fixed 反例（未来 epoch claim）证明可捕获；`NoDoubleClaim` 由 `bug-double-claim-r4` 反例证明可捕获；`AtMostOneReply` 由 `bug-double-reply-r4` 第二次 `PublishReply`（`replyCount=2`）证明可捕获；`UnknownStaysAssigned` 由 `bug-unknown-changes-state-r4` 中 unknown 写 `needs_attention` 证明可捕获；`NoStaleEffect` 由 `bug-stale-arrival` 中旧代际结果写状态/Reply 并置位诊断位证明可捕获。旧 `small/`、`bug-double-claim-v2/` 等反例仍保留为历史证据。
- 关键路径可达证据：当前 fixed 运行 `small-fixed-r4` 生成 13437 个状态、2532 个不同状态、队列剩余 0；与上一轮 `small-fixed-r2r3` 状态计数一致，说明新增 R4 变量/开关未改变 fixed 可达语义。状态数本身不证明业务路径全覆盖。
- 未确认条件及其影响：若实现不能原子保证领取互斥或 epoch 守卫，模型通过结论不适用于该实现。

## 基线与变更

- 需求 / 设计 / 模型 / 配置内容标识：
  - 旧模型 SHA-256 `dfd07e92785785b78046e619b682ea8599feb318070fcacd566d76aa7b13f4f6`（见旧运行 `small/result.json`）；上一轮模型 SHA-256 `f4edb383650a17280d6ae882e1172a1bfee0d6d35a36bf6b5d63cc56b5823e1c`；R2/R3 轮模型 SHA-256 `ca26804cf7f79475f8c676fd730b97c5f4ab0f27ec2af8aeef9c8fd9495310c8`；当前模型 SHA-256 `aa073f7a48996593841417d17e4d9ded1c5f3510c5eec54c9938cc65c14761ce`。
  - `fixed.cfg` 当前 SHA-256 `8dc21e973ebb0a29b3f0d0225e62d720120bb601ff770e509158edfba63251d1`（新增 `StaleGuardEnabled=TRUE` 与 `NoStaleEffect`，语义未变；R2/R3 轮为 `fdf6be03264f815c9a7c20dca88808ee9cca16d36e492405e11fc6c7b5220df9`）；`bug-double-claim.cfg` 当前 `3a258018bd53cc2f0ead6514ff4c8a7614699ab05b331b56abb5e296e98f9a17`；`bug-double-reply.cfg` 当前 `0d960267263d97eaba8fe07099f8650bb7f400fab234de1f80095f430b0f6b1a`；`bug-unknown-changes-state.cfg` 当前 `5e791e63bd1dfc83da85acb4863c686a7e44e98f8c483a07735173bd25172363`；新增 `bug-stale-arrival.cfg` SHA-256 `bcd64650184c08c2c14f28aa9a4de6595cf6e3796b14ac703adf20c2600a40fa`。
  - `verification.json` 当前 SHA-256 `5e5a95cf3c2eea8d5ac3f2c093060a609cb395b356788417f754260c46702638`（所有 profile 增加 `NoStaleEffect`，新增 R4 错误变体 profile；上一轮为 `af35784f0b26ed1e9f68f892bce48b634c43150aa35c9d013578ab1bc2ad60a2`）；本轮五次新运行的 manifest 快照与它一致。
- 新增、删除或修改的性质：新增不变式 `NoStaleEffect`；新增常量 `StaleGuardEnabled`、变量 `staleEffect`（非性质，纳入 `TypeOK` 并在所有动作中显式维护）；所有配置追加启用 `NoStaleEffect`。未删除、未改名或放宽任何性质。
- 假设、规模、检查选项变化及理由：规模、workers、heap、死锁检查未变；`StaleGuardEnabled` 是隔离 R4 错误的配置开关，`staleEffect` 是诊断位，二者不改变 fixed 业务语义；新增终态自环沿用既有 `Terminal` 模式，本轮未因 R4 改动出现新死锁。
- 业务保证变化及决策依据：无业务保证变化；R4 由“仅守卫表达”升级为“命名不变式 + 隔离错误变体”，不改变“旧代际无状态/Reply 效果”的要求。
- 旧证据失效范围：`.agent-output/s8-314-tla/small/`、`small-fixed-v2/`、`small-fixed-v3/`、`small-fixed-r2r3/`、`bug-double-claim-v2/`、`bug-double-reply/`、`bug-unknown-changes-state/` 全部保留，不覆盖、不删除；它们对应各自版本的历史输入，当前结论以 `small-fixed-r4/` 与各 `-r4/` 错误变体目录为准。

## 检查计划

- `small` / `fixed.cfg`：`W={w1,w2}, C={acp,mcp}, E={0,1}, G={0,1}, DuplicateAllowed=FALSE, ReplyGuardEnabled=TRUE, UnknownGuardEnabled=TRUE, StaleGuardEnabled=TRUE`，七项不变式 + 死锁检查，120 秒、1 worker、512 MB；目标 `PASS_WITHIN_SCOPE`。
- `bug-double-claim` / `bug-double-claim.cfg`：`DuplicateAllowed=TRUE`，其余开关为 `TRUE`，隔离 R1 错误变体，检查 `TypeOK` + `NoDoubleClaim` + `NoStaleEffect` + 死锁；目标 `COUNTEREXAMPLE`，不作为交付通过证据。
- `bug-double-reply` / `bug-double-reply.cfg`：`ReplyGuardEnabled=FALSE`，其余开关保持 fixed，隔离 R2 错误变体，检查 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition` + `NoStaleEffect` + 死锁；目标 `COUNTEREXAMPLE`，不作为交付通过证据。
- `bug-unknown-changes-state` / `bug-unknown-changes-state.cfg`：`UnknownGuardEnabled=FALSE`，其余开关保持 fixed，隔离 R3 错误变体，检查 `TypeOK` + `UnknownStaysAssigned` + `NoStaleEffect` + 死锁；目标 `COUNTEREXAMPLE`，不作为交付通过证据。
- `bug-stale-arrival` / `bug-stale-arrival.cfg`：`StaleGuardEnabled=FALSE`，其余开关保持 fixed，隔离 R4 错误变体，检查 `TypeOK` + `NoStaleEffect` + 死锁；目标 `COUNTEREXAMPLE`，不作为交付通过证据。
- 本轮实际运行（全部新建目录，未覆盖旧证据）：`small-fixed-r4` 得到 `PASS_WITHIN_SCOPE`（13437/2532/0）；`bug-stale-arrival` 命中 `Invariant NoStaleEffect is violated.`（188/148/115）；模型与全部配置变更后，既有错误变体在新目录 `bug-double-claim-r4`、`bug-double-reply-r4`、`bug-unknown-changes-state-r4` 分别命中 `NoDoubleClaim`、`AtMostOneReply`、`UnknownStaysAssigned`。
- 待解决风险：模型 PASS 不替代源码对应或真实测试；独立模型复核仍为 `NOT_RUN`。

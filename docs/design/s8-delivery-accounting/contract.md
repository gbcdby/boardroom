# 设计与验证契约

## 任务

- 项目 / 功能：boardroom / S8 #314「统一消费账本、代际隔离及形式化验证」TLA+ 切片。
- 模式：design（总控指定；用户要求 subagent 使用 free model 执行本切片）。
- 用户需求及已确认规则的来源：本轮总控任务；[#312](https://github.com/gbcdby/boardroom/issues/312) 子 spec 与 [#314](https://github.com/gbcdby/boardroom/issues/314) ticket。二者当前状态是**设计基线**，不是已接受的实施主线，不构成对现有 main 的已验收承诺。
- 设计边界及适配记录：仅限 `docs/design/s8-delivery-accounting/` 下的 TLA+ 模型、配置、验证清单与交接文档；不修改业务实现、项目测试或部署配置。
- 现有源码内容标识：NOT_ASSESSED。本轮没有以源码对应核验为目的读取或改动 `src/`；模型语义来自 #312/#314 的拟议边界，不冒充实现事实。

## 调用方与设计决策

- 真实调用场景和可观察结果：ACP 与 external_mcp 共用一条 WorkItem → Run → DeliveryDisposition → Reply 账本；一个 WorkItem 从 `pending` 经领取进入 `assigned`，最终为 `handled` 或 `needs_attention`；结果未知时保持 `assigned`，不二次执行、不暗中切换通道兜底。跨通道切换必须先 fencing、再对账。
- 接口输入、输出、错误及未知结果：模型动作 `Receive(w)`；`Claim(w,c,e,g)` 携带通道 `c`、epoch `e`、generation `g`；`Observe(w,c,e,g,res)` 的 `res ∈ {success, failure, unknown}`；`PublishReply(w)`；`StaleArrival(w,c,e,g,res)` 为旧代际空动作；`SwitchMode(e2,cNew)` 单调推进 epoch 并 fence 其它通道；`Terminal` 为合法终态自环。
- 状态所有权、生命周期、提交与外部效果边界：账本状态为设计拟议的单一所有权；`owner[w]` 表示当前领取通道，`claims` 记录领取身份，`replyCount` 约束幂等发布。事务边界、持久化、真实宿主投递与对账机制均为实现义务，未在模型中核实。
- 关键结构选择及理由：
  - `Claim` 只允许 `e = modeEpoch`，禁止未来 epoch 预领取；这是旧反例指出的真实语义缺口。
  - `Claim` 的前置状态允许 `pending` 或 `assigned`，使“已领取项再次收到领取尝试”可达；唯一性由 `DuplicateAllowed = FALSE` 一侧的 `claims` 互斥守卫表达，而不是靠把 `status` 锁死为 `pending` 来人为消灭敏感性。
  - `Observe` 要求 `owner[w] = c`、`e = modeEpoch` 且存在匹配的 claim；旧 epoch 结果只能通过 `StaleArrival` 表达为无状态效果。
  - `Terminal` 仅在所有 WorkItem 已处于 `handled`/`needs_attention` 且 `E` 中无更高 epoch 时启用；死锁检查保持开启，不用全局自环掩盖意外卡死。
- 方案是否依赖尚未确认的条件：依赖“领取互斥与状态变更原子”“fencing 先于切换”“needs_attention 的人工处理/对账在模型外”等条件；均列为实现义务而非已核实事实。
- 验证工具选择及未覆盖的代码级问题：TLC 适合协议交错、epoch 隔离与重复领取；不覆盖真实并发竞态、数据库/文件系统语义、崩溃恢复、外部副作用及真实宿主能力。

## 需求到性质

| 需求 ID | 必须满足的业务保证 | 性质名 | 类型 | 启用配置 | 未覆盖项与接收方 |
|---|---|---|---|---|---|
| R1 | 同一 WorkItem 至多一个有效领取/owner，结果未知时也拒绝第二次执行 | `NoDoubleClaim` | safety / invariant | `fixed.cfg`、`bug-double-claim.cfg` | 真实 CAS/唯一约束归属实现方 |
| R2 | 同一 WorkItem 至多一个幂等 Reply，且 Reply 仅来自 handled | `AtMostOneReply`、`ReplyMatchesDisposition` | safety / invariant | `fixed.cfg`、`bug-double-reply.cfg` | 外部投递副作用未建模 |
| R3 | `outcome_unknown` 后状态保持 `assigned` | `UnknownStaysAssigned` | safety / invariant | `fixed.cfg`、`bug-unknown-changes-state.cfg` | 真实 unknown 判定与恢复语义未评估 |
| R4 | 旧代际观察不能改写当前状态或产生 Reply；handled 必须由本 epoch 或更早的合法 claim 支撑，不能由未来 epoch 支撑 | `NoStaleHandled`（配合 `Claim`/`Observe` 守卫） | safety / invariant + action guard | `fixed.cfg` | 旧代际“无效果”没有单独命名的不变式；由动作守卫与模型可达性表达，需在实现回归中覆盖 |
| 类型边界 | 所有变量取值在声明域内（`replyCount` 为有限 `0..2`） | `TypeOK` | 类型 / invariant | 四份配置 | 不能替代业务性质；fixed 下由守卫保证不达到 2 |

性质名保持为 `TypeOK`、`NoDoubleClaim`、`AtMostOneReply`、`ReplyMatchesDisposition`、`UnknownStaysAssigned`、`NoStaleHandled`，未删除、未放宽。

## 模型边界

- 状态、参与者与动作：`W={w1,w2}`、`C={acp,mcp}`、`E={0,1}`、`G={0,1}`；配置常量 `DuplicateAllowed`、`ReplyGuardEnabled`、`UnknownGuardEnabled`；状态变量 `status/outcome/owner/claims/replyCount/modeEpoch/fenced`，其中 `replyCount` 取有限域 `0..2`；动作见上文。
- 错误变体的隔离方式：`ReplyGuardEnabled=FALSE` 只放宽 `PublishReply` 的上限为 2，`UnknownGuardEnabled=FALSE` 只让 `unknown` 观察写 `needs_attention`；fixed 与 R1 变体两个开关均为 `TRUE`。四份配置都未删除或改名性质（错误变体只启用与自身需求相关的子集）、使用同一 `Spec` 并保持死锁检查，不使用 `CONSTRAINT`。
- 可交错 / 可故障的步骤：领取与观察可交错；重复领取尝试在 `bug-double-claim` 变体中可达；unknown 结果、旧代际到达、模式切换与 fence 均可达。
- 原子性义务与已核实依据：`Claim` 的互斥与 `status/owner/claims` 更新被视为一个原子步骤，这是**拟议实现义务**，不是源码证据；`Observe` 的判定与状态更新同理。
- 持久化、提交、确认与外部效果：账本变量代表设计层面的持久视图；真实事务、确认延迟、投递外部效果与幂等键存储未建模。
- 并发、重试、重复、丢失、乱序、故障与恢复：包含重复领取、旧代际乱序到达与 epoch 切换；不包含崩溃/恢复、消息丢失与真实超时。
- 活性依赖的调度、公平性和环境条件：`liveness: NOT_CHECKED`；无公平性假设，不宣称任何最终完成性质。
- 有限规模、抽象方式与排除行为：`E` 上限为 1，因此 epoch 饱和后的终态需要显式自环；排除真实宿主、DB/FS、外部副作用、人工 needs_attention 流程与组合系统性质。
- 合法终止与死锁的区分：`Terminal` 只覆盖所有 WorkItem 已终态且 epoch 饱和的合法结束；其它无动作状态仍会被 TLC 报为死锁。
- 关键性质敏感性证据：`NoStaleHandled` 由旧 fixed 反例（未来 epoch claim）证明可捕获；`NoDoubleClaim` 由 `bug-double-claim-v2` 反例证明可捕获；`AtMostOneReply` 由 `bug-double-reply` 中第二次 `PublishReply`（`replyCount=2`）反例证明可捕获；`UnknownStaysAssigned` 由 `bug-unknown-changes-state` 中 unknown 写 `needs_attention` 的反例证明可捕获。旧代际状态改写未单独做变异检查，列为缺口。
- 关键路径可达证据：当前 fixed 运行 `small-fixed-r2r3` 生成 13437 个状态、2532 个不同状态、队列剩余 0；旧 fixed 与 bug 变体反例给出具体轨迹。状态数本身不证明业务路径全覆盖。
- 未确认条件及其影响：若实现不能原子保证领取互斥或 epoch 守卫，模型通过结论不适用于该实现。

## 基线与变更

- 需求 / 设计 / 模型 / 配置内容标识：
  - 旧模型 SHA-256 `dfd07e92785785b78046e619b682ea8599feb318070fcacd566d76aa7b13f4f6`（见旧运行 `small/result.json`）；上一轮模型 SHA-256 `f4edb383650a17280d6ae882e1172a1bfee0d6d35a36bf6b5d63cc56b5823e1c`；当前模型 SHA-256 `ca26804cf7f79475f8c676fd730b97c5f4ab0f27ec2af8aeef9c8fd9495310c8`。
  - `fixed.cfg` SHA-256 `fdf6be03264f815c9a7c20dca88808ee9cca16d36e492405e11fc6c7b5220df9`（新增加两个 `TRUE` 常量绑定，语义未变）；`bug-double-claim.cfg` SHA-256 `f36c7fc0b99c794bdccdef304e4bdd267f26ac74870e2341c6bac0a66fedda3d`（同样只新增 `TRUE` 绑定）；新增 `bug-double-reply.cfg` SHA-256 `3a45ead0b85c2541df235caaea59e8e0993d63d2cebaef93400e6baf011155f9`；新增 `bug-unknown-changes-state.cfg` SHA-256 `dd9baaf0aeec0d68a8b5c4cff86188ebcc7e0fec92b4d8795d3b476a369ba664`。
  - `verification.json` SHA-256 `af35784f0b26ed1e9f68f892bce48b634c43150aa35c9d013578ab1bc2ad60a2`（新增两个错误变体 profile 与开关参数说明）；本轮三次新运行快照中的 manifest 与它一致。
- 新增、删除或修改的性质：无性质增删或改名；新增 `Terminal` 动作（非性质），修正 `Claim` 与 `Observe` 守卫；本轮新增两个配置级开关与 `ReplyLimit` 定义（非性质），`replyCount` 类型域由 `{0,1}` 扩为有限 `0..2`。
- 假设、规模、检查选项变化及理由：规模、workers、heap、死锁检查与 manifest 假设均未变；`Claim` 守卫与终态自环属于模型语义修正，理由见报告“发现及处理”。R2/R3 开关只在对应隔离错误变体中关闭，fixed 语义经新目录重跑确认未变（状态计数与旧快照一致）。
- 业务保证变化及决策依据：无业务保证变化；修正只用于阻止未来 epoch 领取、旧代际状态改写与空洞的错误变体，并为 R2/R3 提供可捕获反例的隔离变异。
- 旧证据失效范围：`.agent-output/s8-314-tla/small/` 的 `NoStaleHandled` 反例仍准确描述**旧模型**，保留作为敏感性证据；它不代表当前模型失败。`.agent-output/s8-314-tla/small-fixed-v2/` 的死锁反例描述加入 epoch 守卫后、尚未加入终态自环的中间模型，也保留。

## 检查计划

- `small` / `fixed.cfg`：`W={w1,w2}, C={acp,mcp}, E={0,1}, G={0,1}, DuplicateAllowed=FALSE, ReplyGuardEnabled=TRUE, UnknownGuardEnabled=TRUE`，六项不变式 + 死锁检查，120 秒、1 worker、512 MB；目标 `PASS_WITHIN_SCOPE`。
- `bug-double-claim` / `bug-double-claim.cfg`：`DuplicateAllowed=TRUE`，其余开关为 `TRUE`，隔离 R1 错误变体，只检查 `TypeOK` + `NoDoubleClaim` + 死锁；目标 `COUNTEREXAMPLE`，不作为交付通过证据。
- `bug-double-reply` / `bug-double-reply.cfg`：`ReplyGuardEnabled=FALSE`，其余开关保持 fixed，隔离 R2 错误变体，检查 `TypeOK` + `AtMostOneReply` + `ReplyMatchesDisposition` + 死锁；目标 `COUNTEREXAMPLE`（`AtMostOneReply`），不作为交付通过证据。
- `bug-unknown-changes-state` / `bug-unknown-changes-state.cfg`：`UnknownGuardEnabled=FALSE`，其余开关保持 fixed，隔离 R3 错误变体，检查 `TypeOK` + `UnknownStaysAssigned` + 死锁；目标 `COUNTEREXAMPLE`（`UnknownStaysAssigned`），不作为交付通过证据。
- 本轮实际运行：历史快照先在 `small-fixed-v2` 得到死锁反例；加入 `Terminal` 后在新目录 `small-fixed-v3` 得到 `PASS_WITHIN_SCOPE`，`bug-double-claim-v2` 得到 `COUNTEREXAMPLE`。R2/R3 开关加入并更新模型文本后，在**新目录** `small-fixed-r2r3` 重跑 fixed 得到 `PASS_WITHIN_SCOPE`（13437/2532/0，与旧快照一致）；`bug-double-reply` 与 `bug-unknown-changes-state` 分别得到目标不变式反例。所有目录均为新建，旧目录未覆盖或删除。
- 待解决风险：旧代际状态改写缺少单独变异检查；模型 PASS 不替代源码对应或真实测试；独立模型复核仍为 `NOT_RUN`。

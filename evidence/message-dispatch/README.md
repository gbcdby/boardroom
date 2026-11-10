# 消息提交与唤醒判定：有限模型证据

日期：2026-11-10。模式：`design`。关联设计：[消息触发与幂等 #66](https://github.com/gbcdby/boardroom/issues/66)、[共存数据模型 #67](https://github.com/gbcdby/boardroom/issues/67)。

**两个正确配置的有限安全性检查通过；这不是源码正确性证明。**四个错误变体分别产生预期反例，两个可达性探针产生预期见证。模型记录保留独立模型审查 `NOT_RUN`、实现评估 `NOT_ASSESSED`、活性 `NOT_CHECKED`。实际数据库和 SDK 验证单独记录在 [implementation-verification.json](implementation-verification.json)，来自应用测试与 CI，不能由模型结果推导。没有真实 harness 测试结论。

## 文件与身份

- [模型](model/DurableMessage.tla)：真实执行的最终模型。
- [运行清单](verification.json)：8 个配置的性质、参数、时间预算与排除项。
- [结构化结果](results.json)：原始 run ID、时间、状态数、结论及文件摘要。
- [原始日志](logs/)：每个最终运行的 TLC 原始输出，逐字节保留。日志中的临时解析路径仅是当时的执行痕迹；本目录的复跑不依赖那些路径。

模型 SHA-256：`831c9cfeee02af8a175e608a87475e47300222f15083af9708b7ea48643424d2`。
工具：官方 TLA+ v1.7.4 / TLC 2.19，jar SHA-256：`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`；本轮使用 OpenJDK 21.0.13。jar 与状态缓存不入库。

源码背景为 `7d49da30bfcc657aa67b8b76052f7d24af7c326a`，只用于理解原设计；不能把此模型结果归为当前实现的运行通过。

## 模型覆盖

两个并发请求 worker，每个最多两次尝试，最多一次可发生于提交前后、通知前后的服务进程崩溃。每条消息有 allowed、suppressed、仅可见三类接收者。两种正确配置分别覆盖同一 Member/key 的竞争，以及两个 Member 使用相同客户端 key 字符串的隔离。

模型要求消息、持久化 key 与全部可见投递/唤醒判定原子提交，事务内权威查重后返回已有消息或新建完整消息；提示只在提交后发布。崩溃可丢失易失提示，已提交数据库仍可供查询恢复。主动 ACK 包含受抑制投递；runner 查询只取 allowed 且未 ACK。

未采用状态裁剪、对称归约或公平性假设。死锁检查开启，只有请求全部结束、投递全部 ACK 的合法终态自循环。未证明最终投递、最终响应或任意规模正确；未覆盖实际 SQL 隔离/序号分配、anti-loop 计数持久化、runner lease、harness 执行、外部业务副作用。

| 配置 | 结果 | 不同状态 | 关联性质/见证 |
| --- | --- | ---: | --- |
| `same-key` | PASS_WITHIN_SCOPE | 1,633 | 8 项不变式，队列清空 |
| `different-senders` | PASS_WITHIN_SCOPE | 22,809 | 8 项不变式，队列清空 |
| `bug-split-commit` | COUNTEREXAMPLE | 5 | `CompleteEnvelope`：message/key 与 deliveries 分离提交 |
| `bug-stale-read` | COUNTEREXAMPLE | 49 | `AtMostOneMessage`：两个请求均读到不存在、提交未重查 |
| `bug-volatile-key` | COUNTEREXAMPLE | 256 | `AtMostOneMessage`：重启丢 key 后重复落消息 |
| `bug-wake-filter` | COUNTEREXAMPLE | 14 | `OnlyAllowedWake`：只看 pending 就选择受抑制投递 |
| `reach-concurrent-read` | 预期探针反例 | 6 | 并发读取“key 尚不存在”可达 |
| `reach-recovery` | 预期探针反例 | 789 | 丢提示崩溃→恢复查询→duplicate 回读→抑制投递 ACK 可达 |

八项不变式为 `TypeOK`、`AtMostOneMessage`、`CompleteEnvelope`、`StableReply`、`DurableKeyMatches`、`OnlyAllowedWake`、`AtMostOneHint`、`HintAfterCommit`。探针故意增加一个否定目标可达状态的不变式，出现对应反例证明路径可达，不属于产品失败。错误变体只改变其命名所指的一项条件，不能作为正确设计配置运行。

## 标准 TLC 复跑

从仓库根执行。先按[官方 v1.7.4 发布](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)取得 jar，并核对上列摘要；`BOARDROOM_TLC_JAR` 使用本机真实绝对路径。此例使用标准 TLC CLI，不依赖本次临时目录：

```bash
export BOARDROOM_TLC_JAR=/absolute/path/to/tla2tools.jar
sha256sum "$BOARDROOM_TLC_JAR"
export BOARDROOM_TLC_STATES="$(mktemp -d)"
cd evidence/message-dispatch/model
java -Xmx512m -XX:+UseParallelGC -cp "$BOARDROOM_TLC_JAR" tlc2.TLC \
  -workers 1 -metadir "$BOARDROOM_TLC_STATES" \
  -config same-key.cfg DurableMessage
```

将 `same-key.cfg` 换为表中的其他配置名即可；每次使用新的 `BOARDROOM_TLC_STATES` 目录。两个正确配置应完成模型检查，4 个错误配置与2个探针应报告表中指定的不变式违反。工具错误、超时或其他反例不能当成预期结果。

也可在仓库根使用项目已存在的受控执行器，输出放到新的 `.agent-output/` 子目录：

```bash
python3 .agents/skills/tla-verify-design/scripts/run_tlc.py \
  --manifest evidence/message-dispatch/verification.json \
  --profile same-key --jar "$BOARDROOM_TLC_JAR" \
  --out .agent-output/message-dispatch-recheck/same-key
```

受控执行器会核对 jar 摘要、配置实际启用的性质和完整探索证据。这里记录的是历史最终运行，不代替未来修改后的重跑。

## 实现义务

- 同一个真实事务内提交 message、key、所有 visible delivery 与 wake 判定；提交前不发布提示。
- 独立异步请求不得串用事务句柄。SQLite 顶层事务串行；PostgreSQL 顶层事务独占客户端；嵌套仅属于同一异步执行上下文。模型没有证明这些机制已经落实。
- 以数据库唯一约束和提交时权威查重处理竞争；duplicate 分支不再次注册 anti-loop、不再次通知。key 属于 Member，不是全局 Agent。
- HTTP 人消息与 MCP 两个生产入口均需满足提交约束；保留既有人的连续计数重置行为。旧 NULL 唤醒判定不能回填成 allowed。
- `suppressed` / NULL 仍保留给主动 wait/backlog，allowed + 未 ACK 才进入触发查询。ACK 不代表业务任务完成。
- anti-loop 在失败事务前已更新时的保守多抑制、跨重启计数重置须单独说明，不能由本模型推导 quota 精确一次。

改变 key 作用域、幂等记录保留策略、wake 重评规则、事务边界或消费者拓扑时，重新评估模型与实现证据。原始工具结果中的 `implementation_status` 不得改写为已证明实现。

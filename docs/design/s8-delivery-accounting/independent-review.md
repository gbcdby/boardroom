# S8 #314 TLA+ 模型独立复核报告

## 复核身份与结论

本复核由独立形式化复核员完成，不是 PR #327/#328/#329 作者的作者自查。复核对象为已合入 main 的候选提交 `f1c94db26ff089c162c8dc9ad2e7614b8178b05d`（tree `e7f9df1fbafc98721e9b25b5f9bcd9ed746553c2`）；该提交是合并提交 `4655e8b24cff0fd37e355ebe72416648b395e531` 的第二父提交，合并后 tree 同为 `e7f9df1fbafc98721e9b25b5f9bcd9ed746553c2`。

独立复核结论：`REVIEWED`，未发现模型、配置、工具摘要、运行证据与作者报告之间的实质差异。fixed profile 为 `PASS_WITHIN_SCOPE`（13437/2532/0，死锁检查开启，`implementation_status=NOT_ASSESSED`）；四个隔离错误变体均为 `COUNTEREXAMPLE`，分别命中作者报告声明的目标不变式。该结论只覆盖 TLA+ 模型与有限配置，不表示 S8 #314 整票完成，也不表示实现已评估、真实测试已运行或产物可释放。

## 固定对象与摘要核对

以下摘要在复核开始时从当前工作树计算，并与 `report.md`、`contract.md`、`handoff.md` 中记录逐项比对一致：

| 对象 | SHA-256 |
| --- | --- |
| `docs/design/s8-delivery-accounting/tla/DeliveryLedger.tla` | `aa073f7a48996593841417d17e4d9ded1c5f3510c5eec54c9938cc65c14761ce` |
| `fixed.cfg` | `8dc21e973ebb0a29b3f0d0225e62d720120bb601ff770e509158edfba63251d1` |
| `bug-double-claim.cfg` | `3a258018bd53cc2f0ead6514ff4c8a7614699ab05b331b56abb5e296e98f9a17` |
| `bug-double-reply.cfg` | `0d960267263d97eaba8fe07099f8650bb7f400fab234de1f80095f430b0f6b1a` |
| `bug-unknown-changes-state.cfg` | `5e791e63bd1dfc83da85acb4863c686a7e44e98f8c483a07735173bd25172363` |
| `bug-stale-arrival.cfg` | `bcd64650184c08c2c14f28aa9a4de6595cf6e3796b14ac703adf20c2600a40fa` |
| `docs/design/s8-delivery-accounting/verification.json` | `5e5a95cf3c2eea8d5ac3f2c093060a609cb395b356788417f754260c46702638` |
| 工具 jar `.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

jar 为本地复用，未下载；复核完成后再次计算摘要仍一致。Java 为 `/opt/homebrew/opt/openjdk@17/bin/java`，报告版本 `openjdk version "17.0.20.1"`。TLC 自报 `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`。runner 为 `.agents/skills/worker-tla/scripts/run_tlc.py`，本次运行记录中的 runner SHA-256 为 `ca5811a8cae5d31961185b0ba53868f3ea885a1ee614150d873d61044ff18f5a`。

## 配置与禁用设施检查

`verification.json` 的五个 profile 与对应 cfg 的实际启用项完全一致，`expected_properties` 均为 `[]`，`checks_deadlock` 均为 `true`，`deadlock_reason` 均为 `null`：

| profile | cfg 实际启用的不变式 |
| --- | --- |
| `small` | `TypeOK`, `NoDoubleClaim`, `AtMostOneReply`, `ReplyMatchesDisposition`, `UnknownStaysAssigned`, `NoStaleHandled`, `NoStaleEffect` |
| `bug-double-claim` | `TypeOK`, `NoDoubleClaim`, `NoStaleEffect` |
| `bug-double-reply` | `TypeOK`, `AtMostOneReply`, `ReplyMatchesDisposition`, `NoStaleEffect` |
| `bug-unknown-changes-state` | `TypeOK`, `UnknownStaysAssigned`, `NoStaleEffect` |
| `bug-stale-arrival` | `TypeOK`, `NoStaleEffect` |

五份 cfg 均使用 `SPECIFICATION Spec`，未出现 `CONSTRAINT`、`ACTION_CONSTRAINT`、`VIEW`、`SYMMETRY`、`ALIAS`、`POSTCONDITION` 或 `CHECK_DEADLOCK FALSE`。模型中没有随机、外部 I/O 或状态式终止辅助设施；runner 的固定 BFS 参数由证据记录，未传递额外 TLC 参数。目标性质没有被放进搜索约束，也没有删性质、改名、放宽或关闭死锁检查。

## 独立重跑命令

本机默认 `python3` 为 3.9.13，不满足 runner 声明的 Python 3.10+；本次使用 `/usr/local/bin/python3.10`（Python 3.10.17），其余工具均按任务指定。五个输出目录均为新建，未覆盖作者既有目录。

```text
/usr/local/bin/python3.10 /Users/gabengcuidebeiye/claude/boardroom/.agents/skills/worker-tla/scripts/run_tlc.py --manifest /Users/gabengcuidebeiye/claude/boardroom/docs/design/s8-delivery-accounting/verification.json --profile small --jar /Users/gabengcuidebeiye/claude/boardroom/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar --java /opt/homebrew/opt/openjdk@17/bin/java --out /Users/gabengcuidebeiye/claude/boardroom/.agent-output/s8-314-tla/independent-small
```

```text
/usr/local/bin/python3.10 /Users/gabengcuidebeiye/claude/boardroom/.agents/skills/worker-tla/scripts/run_tlc.py --manifest /Users/gabengcuidebeiye/claude/boardroom/docs/design/s8-delivery-accounting/verification.json --profile bug-double-claim --jar /Users/gabengcuidebeiye/claude/boardroom/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar --java /opt/homebrew/opt/openjdk@17/bin/java --out /Users/gabengcuidebeiye/claude/boardroom/.agent-output/s8-314-tla/independent-bug-double-claim
```

```text
/usr/local/bin/python3.10 /Users/gabengcuidebeiye/claude/boardroom/.agents/skills/worker-tla/scripts/run_tlc.py --manifest /Users/gabengcuidebeiye/claude/boardroom/docs/design/s8-delivery-accounting/verification.json --profile bug-double-reply --jar /Users/gabengcuidebeiye/claude/boardroom/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar --java /opt/homebrew/opt/openjdk@17/bin/java --out /Users/gabengcuidebeiye/claude/boardroom/.agent-output/s8-314-tla/independent-bug-double-reply
```

```text
/usr/local/bin/python3.10 /Users/gabengcuidebeiye/claude/boardroom/.agents/skills/worker-tla/scripts/run_tlc.py --manifest /Users/gabengcuidebeiye/claude/boardroom/docs/design/s8-delivery-accounting/verification.json --profile bug-unknown-changes-state --jar /Users/gabengcuidebeiye/claude/boardroom/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar --java /opt/homebrew/opt/openjdk@17/bin/java --out /Users/gabengcuidebeiye/claude/boardroom/.agent-output/s8-314-tla/independent-bug-unknown-changes-state
```

```text
/usr/local/bin/python3.10 /Users/gabengcuidebeiye/claude/boardroom/.agents/skills/worker-tla/scripts/run_tlc.py --manifest /Users/gabengcuidebeiye/claude/boardroom/docs/design/s8-delivery-accounting/verification.json --profile bug-stale-arrival --jar /Users/gabengcuidebeiye/claude/boardroom/.agent-output/design-tla-doc-sync/same-key/tool/tla2tools.jar --java /opt/homebrew/opt/openjdk@17/bin/java --out /Users/gabengcuidebeiye/claude/boardroom/.agent-output/s8-314-tla/independent-bug-stale-arrival
```

## 五次 TLC 原始结果

runner 终端返回的 `status`、`reason` 与 `result.json` 一致。下表为 `result.json` 的原始摘要；“生成/不同/剩余”依次为 `generated_states/distinct_states/remaining_states`。

| 输出目录 / profile | status | reason | completed | 生成/不同/剩余 | runner 退出码 | Java 退出码 | error_codes | warning_codes | 不变式违反消息 | implementation_status |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| `independent-small` / `small` | `PASS_WITHIN_SCOPE` | `COMPLETE_MODEL_CHECK` | true | 13437/2532/0 | 0 | 0 | `[]` | `[]` | 无 | `NOT_ASSESSED` |
| `independent-bug-double-claim` / `bug-double-claim` | `COUNTEREXAMPLE` | `PROPERTY_OR_DEADLOCK_VIOLATION` | false | 52/29/21 | 2 | 12 | `[2110, 2121]` | `[]` | `Invariant NoDoubleClaim is violated.` | `NOT_ASSESSED` |
| `independent-bug-double-reply` / `bug-double-reply` | `COUNTEREXAMPLE` | `PROPERTY_OR_DEADLOCK_VIOLATION` | false | 799/469/327 | 2 | 12 | `[2110, 2121]` | `[]` | `Invariant AtMostOneReply is violated.` | `NOT_ASSESSED` |
| `independent-bug-unknown-changes-state` / `bug-unknown-changes-state` | `COUNTEREXAMPLE` | `PROPERTY_OR_DEADLOCK_VIOLATION` | false | 37/31/23 | 2 | 12 | `[2110, 2121]` | `[]` | `Invariant UnknownStaysAssigned is violated.` | `NOT_ASSESSED` |
| `independent-bug-stale-arrival` / `bug-stale-arrival` | `COUNTEREXAMPLE` | `PROPERTY_OR_DEADLOCK_VIOLATION` | false | 188/148/115 | 2 | 12 | `[2110, 2121]` | `[]` | `Invariant NoStaleEffect is violated.` | `NOT_ASSESSED` |

四次反例运行没有超时、没有中断；`completed=false` 与剩余队列非零是提前停止的预期表现，不能作为全状态空间通过证据。fixed 运行完整结束、队列为空、无错误码和警告码。

## 初态与关键动作可达性

- fixed `tlc.log` 消息 2190 记录 `Finished computing initial states: 1 distinct state generated at 2026-11-24 20:08:09.`；初态非空。消息 2199 记录 `13437 states generated, 2532 distinct states found, 0 states left on queue.`，消息 2193 记录 `Model checking completed. No error has been found.`。
- 错误变体的 `messages.json` 2217 轨迹直接见证：`Receive`（各反例第 2 步）、`Claim`（第 3 步；重复领取反例第 4 步）、`Observe(success)`（重复 Reply 反例第 4 步）、`Observe(unknown)`（unknown 反例第 4 步）、`PublishReply`（重复 Reply 反例第 5、6 步）、`SwitchMode`（旧代际反例第 4 步）、`StaleArrival`（旧代际反例第 5 步）。这些运行与 fixed 共用同一模型和规模，仅按隔离设计切换一个守卫开关。
- `Terminal` 在本次五份日志中没有单独的状态步轨迹证据。模型中它只在所有 WorkItem 为 `handled`/`needs_attention` 且 `E` 内无更高 epoch 时提供自环；fixed 完整搜索开启死锁检查且未报告死锁，未见该合法终态出口隐藏意外卡死。这里不把“无死锁”写成 `Terminal` 的显式单步轨迹证据。
- 状态数非零只说明有限模型中有可达状态，不证明业务路径全覆盖；本项检查只用于排除空初态、性质空洞通过和明显不可达的敏感性探针。

## 与作者报告的差异

- 模型、五份 cfg、`verification.json`、jar 的 SHA-256 与 `report.md` 记录一致，无差异。
- 五个 profile 的 status、reason、状态计数、退出码/错误码、命中不变式与作者报告一致，无差异。
- 输出目录不同：本次使用 `independent-*`，作者使用 `small-fixed-r4` 及 `-r4`/`bug-stale-arrival` 目录；旧目录未覆盖。
- 命令解释器不同：作者报告写 `python3`，本次因本机默认 `python3` 为 3.9.13 而使用绝对路径 `/usr/local/bin/python3.10`；manifest、profile、jar、Java、输出目录参数与任务指定一致。这是环境适配，不是模型或结果差异。
- 作者报告把“独立模型复核”记为 `NOT_RUN`；本文件是该独立复核的记录，不改变 `report.md`。本次复核状态为 `REVIEWED`，不等于作者自查，也不等于整票完成。

## 仍缺项与边界

- 五次 runner 结果的 `implementation_status` 均为 `NOT_ASSESSED`；本复核未进入 `align`，没有源码对应核验，也没有 refinement 结论。
- 真实项目测试为 `NOT_RUN`；反例只给出回归场景规格，实际实现测试由实现方编写、执行并提供证据。
- S8 #312/#314 仍是设计基线，未接受为实施主线；独立复核通过不表示票已验收或可关闭。
- 产物命名与释放由交付总控决定；本复核不宣称产物已释放、不建 PR、不评论 GitHub、不关票。
- 有限检查不覆盖任意规模、活性/公平性、崩溃恢复、真实 DB/FS 语义、宿主投递、外部副作用与组合系统性质；错误变体 `COUNTEREXAMPLE` 仅作敏感性证据，不计入交付通过记录。

## 变更范围

本复核只新增本文件；未修改 `DeliveryLedger.tla`、五份 cfg、`verification.json`、`report.md`、`handoff.md`、`contract.md`，未修改 `src/`、`tests/`、`.github/`、票面/Spec/标签或 `work-suite.json`，未编辑 runner 结果，未覆盖既有 `.agent-output` 运行目录。

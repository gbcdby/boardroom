# 审查结果

schema_version: work-result/v1
work_id: <工作标识>
skill: review-work
outcome: <PASS | FAIL | INCONCLUSIVE | BLOCKED | NOT_RUN>

## Subject

- kind: <worktree | commit | candidate | artifact>
- id: <完整候选真实身份>
- base_id: <目标基线的真实身份>
- head_id: <实际 head；适用时填写>
- merge_base_id: <实际共同祖先；适用时填写>
- contract_id: <当前需求与标准版本或固定出处>
- environment_id: <相关实际环境；未执行时说明>
- worktree_digest: <实际计算得到时填写>
- producer: <审查者及其与作者的关系>
- independence: <independent | self_check；记录实际关系>
- coverage: <已读路径、staged / unstaged / untracked、依赖和消费者范围>

## 分轴结论

| Axis | Outcome | 依据 | 覆盖及缺口 |
| --- | --- | --- | --- |
| requirements | <PASS / FAIL / INCONCLUSIVE / NOT_RUN> | <当前契约> | <范围> |
| standards | <PASS / FAIL / INCONCLUSIVE / NOT_RUN> | <实际标准> | <范围> |

## Findings

| id | axis | severity | blocking | status | subject_id | location | rule_or_acceptance | trigger / impact | evidence_ids | recommended_action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <R-work-001> | <requirements / standards> | <项目等级> | <true / false> | <OPEN / FIX_REPORTED / VERIFIED / ACCEPTED_RISK / DISMISSED> | <候选> | <路径与位置> | <条款> | <触发条件及影响> | <E-1> | <最小修正或检查> |

## Evidence

| id | locator | kind | scope | status | producer | subject_id |
| --- | --- | --- | --- | --- | --- | --- |
| <E-1> | <固定源码、日志或复现位置> | <source_inspection / execution / historical> | <实际支持的结论> | <原始状态；静态 OBSERVED，历史 HISTORICAL> | <实际执行者及工具版本> | <原候选身份> |

历史材料另存 raw_status 和原日期；测试通过只支持其检查范围。审查者未运行的命令不能写成本人已验证。
静态检查结论使用单独的 assessment=PASS/FAIL/INCONCLUSIVE/NOT_RUN；保留 status=OBSERVED。旧候选证据保留原身份并标 relation=background；复用时另记录当前候选的适用性核验、所引用证据 ID 与 transfer_basis。

## Unresolved

<未关闭阻断项、未覆盖轴或路径、独立性与环境缺口；没有则 []。>

## Changed assumptions

<基线、需求、设计、环境或风险假设变化；没有则 []。>

## Next action

<修正、验证、重新设计或交接的具体下一步及负责人。>

## 复审记录

<仅复审时填写：上一轮 subject_id，新范围，稳定 finding ID 的状态变化，新发现问题及累计覆盖缺口。>

整体 PASS 只用于约定必需范围完成且没有未解决阻断问题；不代表运行时、合并或发布通过。简单任务可用同等字段的紧凑文本，不必复制全部空表。

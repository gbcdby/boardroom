# 验证结果

schema_version: work-result/v1
work_id: <工作标识>
skill: worker-verify
outcome: <PASS | FAIL | INCONCLUSIVE | BLOCKED | NOT_RUN>

## Subject

- kind: <worktree | commit | candidate | artifact | model>
- id: <本次真实候选或产物身份>
- base_id: <实际基线；适用时填写>
- contract_id: <当前验收或设计版本>
- environment_id: <实际环境配置与版本标识>
- worktree_digest: <实际计算得到时填写>
- producer: <执行者；注明是否也是作者>

## 验证范围

<本次明确结论覆盖什么；必须检查哪些项；未覆盖哪些宿主、模型、环境或输入。>

| 检查 ID | 验收或风险 | 必需 | 方法 / 命令 / 输入 | 结论 | Evidence IDs |
| --- | --- | --- | --- | --- | --- |
| <V-1> | <AC-1> | <yes / no> | <实际工作目录和命令> | <PASS / FAIL / INCONCLUSIVE / NOT_RUN> | <E-1> |

## Evidence

| id | locator | kind | scope | status | producer | subject_id |
| --- | --- | --- | --- | --- | --- | --- |
| <E-1> | <原始日志、固定源或运行记录位置> | <execution / source_inspection / model_check / sdk_integration / real_host / historical> | <实际覆盖的行为> | <原工具状态；静态为 OBSERVED，历史为 HISTORICAL> | <执行者、工具版本> | <原候选身份> |

按需记录 exit_code、起止时间、environment_id、raw_status、模型配置与性质、真实 harness 和模型版本。退出码与检查含义分别记录，不能只写“看起来正常”。历史材料保留原日期和原候选。
用可选 assessment=PASS/FAIL/INCONCLUSIVE/NOT_RUN 表达当前范围的检查结论，不改写 OBSERVED、completed 等原始 status。旧候选证据保留原身份并标 relation=background；跨版本复用另记录当前对象的适用性核验、引用证据 ID 和 transfer_basis。

## Unresolved

<必需但未完成的检查、已确认失败、未覆盖边界及具体原因；没有则 []。>

## Changed assumptions

<输入假设变化以及对其他证据有效性的影响；没有则 []。>

## Next action

<下一步、建议负责人和必要材料；环境失败交给环境负责人，已确认实现失败交给实现负责人。>

## 人类摘要

<用几句话说明当前结论、最大剩余风险和需要人决定的具体事项；无需人决定时说明可继续的下一步。>

PASS 只覆盖上述明确范围。存在必需未知项时整体不能 PASS；已经确认产品失败时不能仅因另有环境问题而隐藏 FAIL。作者检查不能冒充独立验证。简单任务可省略表格，保留同等信息。

## 机器交接约束（接收方需要时）

使用 work-result/v1，包含 schema_version、work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action；subject 含 kind 和真实版本身份 id，evidence、unresolved、changed_assumptions 为数组。每项证据含 id、locator、scope、status、producer、subject_id。

JSON 交接时，next_action 与 evidence.scope 使用非空文本，结构化详情另放扩展字段；subject.id 使用含真实版本的不可变身份。引用不同对象的原始材料时保留原 subject_id 并标 relation=background，直接结论绑定当前对象；独立工具的原报告原样保留，由交接层包装，不要求它改用本格式。

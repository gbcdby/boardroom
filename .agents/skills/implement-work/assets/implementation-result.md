# 实现结果

schema_version: work-result/v1
work_id: <沿用工作标识，或创建本次本地标识>
skill: implement-work
outcome: <COMPLETE | FAIL | INCONCLUSIVE | BLOCKED | NOT_RUN>

## Subject

- kind: <worktree | commit | candidate | artifact>
- id: <真实提交、真实快照摘要或可重建产物标识>
- base_id: <实际基线；不适用时省略>
- contract_id: <需求、验收或设计的版本与出处>
- environment_id: <实际环境标识；未执行时注明>
- worktree_digest: <确实计算得到时才填写>
- owner: <本工作单元唯一写入负责人>
- changed_paths: <包含新增、修改、删除以及未跟踪文件>

## 实现与验收对应

| 验收 ID | 改动及路径 | 实际检查 | 剩余范围 |
| --- | --- | --- | --- |
| <AC-1> | <变更> | <evidence ID 或 NOT_RUN> | <内容或无> |

## Evidence

| id | locator | kind | scope | status | producer | subject_id |
| --- | --- | --- | --- | --- | --- | --- |
| <E-1> | <命令、原始日志或固定来源> | <execution / source_inspection / historical> | <实际覆盖的行为> | <原工具状态；静态为 OBSERVED，历史为 HISTORICAL> | <执行者、工具版本> | <此证据实际对应的候选> |

记录执行环境、时间、退出码、失败原因及日志位置。历史证据另记 raw_status、原日期和原候选。作者运行的检查标记为作者检查，不写成独立验证。

## Unresolved

<尚未实现、失败、未运行、待审查或不能确认的事项；空时写 []。>

## Changed assumptions

<与输入相比发生变化的假设及其影响；空时写 []。>

## Next action

<下一步、负责人、所需输入；有现存权限时继续，不额外制造审批。>

COMPLETE 只表示当前实现职责的产物完成；不代表独立审查、候选集成、合并或发布完成。不能完整填写时保留未知值，不补造证据。简单任务可用包含同等信息的紧凑文字。

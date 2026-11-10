# 实现交接

默认使用下面的必要部分或等价短文本；仅接收方需要结构化数据时转换成 `work-result/v1`。

## 对象与产物

- 工作标识；`ticket_ref` 与有效 `spec_ref`：
- 负责人、写入范围、已满足的前置产物与版本：
- 实际候选：〈真实提交、内容摘要或可重建快照〉
- 基线与实际变更：〈含新增、修改、删除与未跟踪文件〉

| 验收 ID | 实际改动与自查依据 | 未覆盖或需后续检查的部分 |
| --- | --- | --- |

## 证据与缺口

每项证据保留出处、对象、范围、原始状态、执行者，以及有关环境和时间。明确作者自查、独立检查、静态观察和历史结果；缺少记录不得写成检查已通过或未执行。

- 尚未实现、失败、未运行、待审查或不能确认的事项：
- 与输入相比变化的假设，以及需返回设计的问题：
- 建议下一步、接收者与必要条件：

`COMPLETE` 只表示当前实现与必需自查完成；不代表独立审查、整体集成、合并或发布完成。

## 机器记录（仅按需）

字段：`schema_version: work-result/v1`、`work_id`、`skill: worker-implement`、`outcome`、`subject`、`evidence`、`unresolved`、`changed_assumptions`、`next_action`。
`subject` 含 `kind/id` 及必要的基线、契约和环境信息；`id` 使用真实候选身份。
每项 `evidence` 含 `id/locator/kind/scope/status/producer/subject_id`；`scope` 与 `next_action` 是非空文本，集合字段为数组。

# 任务计划

按需填充，复用现有记录，不创建重复的 Spec 正文。临时任务编号标为草案；实际平台编号以工具返回为准。

## Spec 目录

- `spec_ref`：〈权威位置与有效修订〉
- 规划范围与实际交付终点：〈本次覆盖什么〉
- 共同约束与整体验收：〈引用 Spec 对应章节／编号〉
- 依赖的权威位置：〈关系或字段来源；下表只作阅读视图〉

| Ticket | 交付结果 | 验收编号 | 前置产物与释放条件 |
| --- | --- | --- | --- |
| 〈稳定任务引用〉 | 〈可独立检查的结果〉 | 〈AC 编号〉 | 〈依赖及条件；无则说明〉 |

## 单张 Ticket

- `ticket_ref`、`spec_ref`：〈任务标识、所属 Spec 及有效修订〉
- `acceptance_ids`：〈覆盖编号〉
- `scope`：〈修改边界、共享资源、明确不含的范围〉
- `depends_on`：〈每项前置任务、产物身份与解除阻塞条件〉
- `deliverables`：〈接收者实际需要的产物〉
- `completion_condition`：〈本票必需检查和交付终点〉
- 负责人／所需能力：〈沿用已分派负责人，或写所需能力〉
- 返回设计或总控的条件：〈共同约束、范围、输入变化〉

## 规划检查

- 未覆盖的验收条件、缺失引用或循环：〈没有也说明检查范围〉
- 并行写入或资源冲突及串行条件：
- 集成、迁移与整体运行验收由哪些任务承担：
- 未决条件与受影响任务；其余可继续规划的部分：
- 本次实际写入的位置、修订；未写入内容标草案：
- 建议下一步与接收者：〈不将建议表述为已经分派〉

普通文本交接保留上述必要事实即可。

## 按需机器交接

仅接收方需要时生成 `work-result/v1`：`schema_version`、`work_id`、`skill`、`outcome`、`subject`、`evidence`、`unresolved`、`changed_assumptions`、`next_action`。`subject` 含 `kind` 和真实修订身份 `id`；证据记录 `id/locator/scope/status/producer/subject_id`。`next_action` 和 `evidence.scope` 为非空文本；`evidence/unresolved/changed_assumptions` 为数组。保留原证据对象，跨版本引用标 `relation: background`；规划或静态核对不能写成运行验证通过。

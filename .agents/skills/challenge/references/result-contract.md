# 按需机器交接

仅在接收方需要结构化结果时使用，先核对其实际约定；有对应校验器时检查后交接。人类短报不自动附本记录。

- `schema_version: work-result/v1`；必需字段：`work_id`、`skill`、`outcome`、`subject`、`evidence`、`unresolved`、`changed_assumptions`、`next_action`。
- `subject` 含 `kind` 与绑定真实修订的 `id`；稳定任务编号不足以标识版本，聚合视图列出真实对象。无法取得版本时说明缺口，不伪造身份。
- `evidence` 是数组，每项含 `id`、`locator`、`scope`、`status`、`producer`、`subject_id`。`scope` 与 `next_action` 为非空文本；`unresolved`、`changed_assumptions` 为数组。
- 证据保留来源、实际对象和原状态。静态观察用 `OBSERVED` 并注明 `source_inspection`；旧实测用 `HISTORICAL`。跨对象或旧版本引用保留原 `subject_id` 并标 `relation: background`，另行核对当前适用性。
- 顶层 `outcome` 只选 `COMPLETE`、`PASS`、`FAIL`、`INCONCLUSIVE`、`BLOCKED`、`NOT_RUN`。实际检查才用 `PASS`／`FAIL`，未执行用 `NOT_RUN`；工具原报告保持原格式。

`COMPLETE` 表示约定推敲结束，仍可有分歧和未知；关键结论证据不足用 `INCONCLUSIVE`，缺必要资料或判断用 `BLOCKED`。讨论完成、意见一致、设计接受、技术检查与操作授权分别记录。

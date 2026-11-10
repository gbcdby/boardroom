# 工作流程改进

- 工作 ID：
- 触发事件与原始证据：
- 适用项目、任务类别和范围：
- 现有规则与授权来源：

## 问题与最小改进

- 已确认的失败机制：
- 原本应当发现或防止问题的环节：
- 基线版本与候选版本：
- 改进位置及作用机制：
- 保持不变的验收和权限边界：

## 预先约定的评估

- 样本集合、标签依据和留出方式：
- harness、模型、工具、Skill 与环境标识：
- 主指标、质量约束与不能退化的类别：
- 人工总负担、运行成本和统计口径：
- 接受、停止和回退条件：

## 实际结果

| 样本或类别 | 基线结果 | 候选结果 | 人工与运行成本 | 证据和限制 |
| --- | --- | --- | --- | --- |

- 误报与有害建议：
- 未运行、失败与中断：
- 样本不足或不可比较条件：

## 采用状态

- 仅建议 / 隔离评估 / 有限试用 / 已启用 / 已回退：
- 实际执行事实与范围：
- 待决事项与必要前提：

## work-result/v1

- `schema_version`：`work-result/v1`

- `work_id`：
- `skill`：`worker-improve-workflow`
- `outcome`：`COMPLETE / PASS / FAIL / INCONCLUSIVE / BLOCKED / NOT_RUN`
- `subject`：真实基线、候选、评估集合与配置标识
- `evidence`：出处、范围、状态、提供者与版本
- `unresolved`：
- `changed_assumptions`：
- `next_action`：

## 机器交接约束（接收方需要时）

使用 work-result/v1，包含 schema_version、work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action；subject 含 kind 和真实版本身份 id，evidence、unresolved、changed_assumptions 为数组。每项证据含 id、locator、scope、status、producer、subject_id。

JSON 交接时，next_action 与 evidence.scope 使用非空文本，结构化详情另放扩展字段；subject.id 使用含真实版本的不可变身份。引用不同对象的原始材料时保留原 subject_id 并标 relation=background，直接结论绑定当前对象；独立工具的原报告原样保留，由交接层包装，不要求它改用本格式。

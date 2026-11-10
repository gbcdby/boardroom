# 工作定界

- 工作 ID：
- 本次调查终点：
- 项目与调查对象版本：
- 已有授权和范围来源：

## 目标与事实

- 用户需要的可观察结果：
- 实际行为或已知基线：
- 保持不变的承诺：
- 本次范围与非目标：

| 证据 ID | 类型 | 观察与来源 | 对象和环境 | 限制 |
| --- | --- | --- | --- | --- |

## 验收条件

| 条件 ID | 可观察结果 | 核验方法 | 必要前提 |
| --- | --- | --- | --- |

## 未知与决定

- 已排除的假设：
- 仍会改变行动的未知：
- 需要人的决定（没有则写无）：
- 推荐与替代、代价、等待影响：

## work-result/v1

- `schema_version`：`work-result/v1`

- `work_id`：
- `skill`：`worker-investigate`
- `outcome`：`COMPLETE / INCONCLUSIVE / BLOCKED / NOT_RUN`
- `subject`：至少 `kind`、`id`；按需附基线、契约、环境或工作树摘要
- `evidence`：上述证据引用，保留范围、状态、提供者与版本
- `unresolved`：
- `changed_assumptions`：
- `next_action`：

## 机器交接约束（接收方需要时）

使用 work-result/v1，包含 schema_version、work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action；subject 含 kind 和真实版本身份 id，evidence、unresolved、changed_assumptions 为数组。每项证据含 id、locator、scope、status、producer、subject_id。

JSON 交接时，next_action 与 evidence.scope 使用非空文本，结构化详情另放扩展字段；subject.id 使用含真实版本的不可变身份。引用不同对象的原始材料时保留原 subject_id 并标 relation=background，直接结论绑定当前对象；独立工具的原报告原样保留，由交接层包装，不要求它改用本格式。

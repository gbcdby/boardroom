# 发布记录

- work_id：
- delivery_target：
- 来源提交/组合版本：
- 产物版本与摘要：
- 构建条件：
- 配置版本：
- 目标环境/渠道：
- 已有授权及适用范围：

## 发布前证据

列实际对象、运行过的检查、结果与限制。未执行项明确标出。

## 实际操作与回执

列每个必要操作的稳定标识、实际结果与查询依据。响应丢失时先核对事实。

## 目标位置验收

记录实际运行版本、入口、场景、观察窗口与结果。

## 恢复

触发条件、恢复授权、产物/配置/数据各自状态与复验。

## 交接

实际到达位置、未解决项、改变的前提和下一步。

## 机器交接约束（接收方需要时）

使用 work-result/v1，包含 schema_version、work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action；subject 含 kind 和真实版本身份 id，evidence、unresolved、changed_assumptions 为数组。每项证据含 id、locator、scope、status、producer、subject_id。

JSON 交接时，next_action 与 evidence.scope 使用非空文本，结构化详情另放扩展字段；subject.id 使用含真实版本的不可变身份。引用不同对象的原始材料时保留原 subject_id 并标 relation=background，直接结论绑定当前对象；独立工具的原报告原样保留，由交接层包装，不要求它改用本格式。

# 机器交接

仅接收方需要时使用 work-result/v1，包含 schema_version、work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action。outcome 使用 COMPLETE/PASS/FAIL/INCONCLUSIVE/BLOCKED/NOT_RUN。subject 含 kind 与实际版本身份 id，证据含 id、locator、scope、status、producer、subject_id；`evidence`、`unresolved`、`changed_assumptions` 为数组。保留平台原始状态、对象与证据范围。

JSON 交接时，next_action 与 evidence.scope 使用非空文本，结构化详情另放扩展字段；subject.id 使用含真实版本的不可变身份。引用不同对象的原始材料时保留原 subject_id 并标 relation=background，直接结论绑定当前对象；独立工具的原报告原样保留，由交接层包装，不要求它改用本格式。

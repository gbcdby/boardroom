# 方法来源与适配

本文仅索引设计启发，不是运行依赖，也不授权调用外部技能。

- pstack `architect`：借鉴用户显式设置设计停点，以及人在执行中改变判断后重新检查问题与设计的机制。这里由现有交付能力管理后续执行，不把设计、实现和人工批准合成同一阶段。来源：[固定版本](https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/skills/architect/SKILL.md)。
- pstack `Pause safely`：借鉴明确暂停意图、安全边界和可恢复现场；不继承自动 WIP 提交、固定临时路径或假设可取消全部宿主的做法。来源：[固定版本](https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/skills/poteto-mode/playbooks/pause-safely.md)。
- 当前工作套件：沿用工作契约中授权与证据分离、单一权威记录、对象版本，以及房间取消中的 STOPPED_AT_SAFE_POINT / STOP_PENDING / CANNOT_CONFIRM 语义。安装有 deliver-work 或 work-in-room 时可使用其允许组合的方法；缺少技能时依然按本入口的最小步骤完成职责，不猜测工具能力。

以上内容已按跨项目、跨语言和跨宿主场景重新组织。真正的身份、权限、所有权和停止能力由项目工具及宿主提供；字段和自然语言约定不能制造硬保证。

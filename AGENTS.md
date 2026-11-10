# boardroom

Agent Studio 是本地跨 Agent 协作平台；当前范围为单用户、localhost、无认证。远程或多用户能力须单独确认范围。

## 项目资料

- 当前用法与能力见 `README.md`；产品基线与架构见 `docs/architecture/agent-studio.md`。
- 宏观架构、范围和架构决策保留在 `docs/`，归档规则见 `docs/README.md`；详细 spec、ticket、决策地图、依赖和状态以 GitHub Issues 为准，不在仓库复制。
- 开发约定写入本文件或 issue；过程材料、日志、草稿和生成产物放 `.agent-output/`。
- 正式文档、Issue/PR 和用户交流使用中文；标识符、命令、路径及 API 名称保留原文。

## 工作流与生效技能

- 技能位于 `.agents/skills/`；保持 `.claude/skills → ../.agents/skills` 软链接。修改技能资源时同步 `work-suite.json` 的版本与摘要。
- 变更交付前完成独立的需求轴与标准轴审查；作者自查不能替代。变更走 PR，审查及必要检查完成时 ready，有缺口时 draft；合并依据当前有效授权。
- PR 引用相关 issue，不使用 `Closes #N`。验收及必要审查完成、关票授权有效时，由交付负责人更新 ticket；合并不附带关票、删分支或部署，不自动 force-push。

## 项目记忆

- 非平凡任务先查 `CONTEXT.md` 的相关章节，关键结论回到当前源码、正式文档或实测证据核对。
- 只记非显而易见、跨会话有效的项目事实，注明日期、适用范围和证据；推测放「待验证」。区分产品要求与当前行为，不记录凭据。
- 更新前重读、查重，局部修订并保留他人的有效内容；纠正旧结论注明理由与替代来源。软上限约 150 行，没有新事实就不更新。

## GitHub Issues

- 标题前缀：`[主 spec]`、`[子 spec]`、`[ticket]`、`[决策地图]`、`[决策]`；F1/T1 等短号放在前缀后，issue 编号不复用、不重排。
- 保留主 spec → 一层子 spec → ticket、决策地图 → 决策票的父子关系与双向链接。子 spec 不扩大父范围；ticket 关联需求/验收 ID 和依赖。简单任务不强制另建 spec 或票。
- spec / ticket 最多一个就绪标签；不用 `in-progress`、`phase:*`、`type:*` 标签表达进度或层级。这不改变产品 Task 状态。

| 标签 | 用法 |
| --- | --- |
| `needs-info` | 缺少信息或决定，包括未解决的规格草案；单纯依赖其他票用 `blocked_by`。 |
| `ready-for-agent` | 仅用于规格、验收明确的 ticket；执行前仍核对依赖、负责人和授权。 |
| `ready-for-human` | 确有待人的评审、裁决、合并决定或实测；已有授权能推进时不重复挂起。 |
| `wontfix` | 已取代、已放弃或决定不做；按授权关闭。 |

- 已接受的 spec 保持开放、无就绪标签，正文保留接受依据；没有标签不等于已批准。拆票或子票完成不自动关闭 spec，相关工作完成且不再维护时才按授权关闭。ticket 达到交付终点并完成必要审查后关闭，关闭时清理就绪标签。
- 依赖优先使用平台 blocking 关系，否则写 `blocked_by`。assignee 表示约定负责人，不是原子领取或租约；不能仅按编号或文件不重叠判断可并行。
- 地图使用 `decision:map`；决策票使用 `decision:research`、`decision:prototype`、`decision:interview`、`decision:task`，不叠加就绪标签。按标签识别类别，冲突先核对修正；关票时移除 `decision:*`，在地图保留结论与链接。
- 决策标签只分类，不决定授权或固定人工介入。调查、原型可在范围内自主推进；只有证据无法替代的人的判断才提问，不代答。标签变更、改派和关票均遵守当前授权。

## 技术边界

- 消息持久化、投递、进入模型上下文、启动执行轮次是不同环节；MCP 连接不保证唤醒空闲宿主或中断在途工具。
- 连接状态、成员运行状态与 Task 状态分开；heartbeat、ACK、working 不代表领取、完成或批准，终端变化也不代表模型内部状态。
- 宿主能力须有真实宿主实测证据；未实测按 `unsupported` 保守声明，不把静态推断或未复现能力写成实测结论。接入验收见 `docs/getting-started-mcp.md`。

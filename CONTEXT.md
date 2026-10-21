# CONTEXT.md — 项目独有记忆

> 保存跨会话仍有效的非显而易见知识：术语、踩坑、宿主差异和待验证假设。维护规则见 `.agents/skills/project-memory/SKILL.md`。
>
> 不放在这里：宏观架构与架构决策 → `docs/architecture/`；开发流程决策 → `AGENTS.md` 或 issue；map、spec、ticket → GitHub Issues；过程材料 → `.agent-output/`。
>
> 条目注明日期、适用范围和证据；未复现的推测放入「待验证」。软上限约 150 行，超出时合并重复、淘汰过时内容或升级。

## 易混淆术语

> 以下定义自 2026-10-18 起适用；来源列即证据。

| 术语 | 在本项目中的含义 | 来源 |
| --- | --- | --- |
| Agent vs Member | Agent 是跨项目的全局身份；Member 是 agent 或人在某个项目中的成员关系与岗位。 | `docs/architecture/agent-studio.md` §4.1 |
| Project vs Group | Project 是协作容器（成员、组织树、任务板、记忆）；Group 是项目内的聊天空间，参与者是项目成员子集。 | 同上 |
| Status vs 任务状态 | Status 是成员的在线/离线、等待/工作中的运行状态；任务状态属于 Task，两者分开建模。 | 同上 |
| Agent 连接状态 vs Status | Agent 连接状态是全局 MCP 会话状态（connected/disconnected、最后心跳）；Status 是项目成员的 online/offline/waiting/working，按 `(project_id, member_id)` 记录。 | 决策票 #4（D1，2026-10-18） |
| role（阶段 1） | Member 的项目级角色字段；阶段 1 只有 `manager` / `normal`，每项目最多一个顶层 manager；完整角色模型在阶段 2。 | 决策票 #5（D2，2026-10-18） |
| 自己参与的消息（阶段 1） | 阶段 1 只覆盖自己发送 + 被 @；任务关联消息留阶段 3，最终定义在阶段 3 重新确认。 | 决策票 #6（D3，2026-10-18） |
| fixed point | 双轴评审的 diff 基准点（commit SHA、分支、tag 等）；评审记录必须可追溯。 | `docs/architecture/agent-studio.md` §6.7；`.agents/skills/code-review/SKILL.md` |
| 三层记忆 | Agent 全局记忆、项目共享记忆、项目+agent 记忆；作用域、读写权限和注入方式不同。 | `docs/architecture/agent-studio.md` §6.8 |

## 宿主差异（Claude Code / Codex CLI）

> 只在实际测试后填写，记录版本、测试条件、可复现结果和日期。

| 宿主 | 版本 | 能力 / 差异 | 测试条件与结果 | 日期 |
| --- | --- | --- | --- | --- |
| | | | | |

## 踩坑记录

> 只记录实际复现、未来可能再次遇到的问题。每条包含：现象、原因、结论/做法、适用范围、证据。

暂无已确认记录。

## 待验证

> 记录影响实现选择、尚未实测的技术假设；产品需求层面的待定项见 `docs/architecture/agent-studio.md` §10.2。

| 假设 / 问题 | 影响 | 验证方法 | 状态 |
| --- | --- | --- | --- |
| | | | |

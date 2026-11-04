# AGENTS.md

本文件是本仓库的通用 agent 工作约定，适用于 Claude Code、Codex 及在此仓库工作的其他 AI agent。开始工作前先阅读。

## 项目概况

Agent Studio 是一个本地运行的跨 Agent 协作平台。Claude Code、Codex CLI 等作为保留各自上下文与身份的独立成员参与；人在 WebUI 中参与群聊、设定组织架构、管理任务和记忆。

当前处于需求/方案阶段。产品基线见 `docs/architecture/agent-studio.md`；decision map、详细 spec、ticket、依赖与状态以 GitHub Issues 为准。技术栈为 Node/TypeScript + PostgreSQL + WebSocket + MCP + Vue 3，默认 localhost、单用户、无认证；架构基线支持未来远程/多用户（V1 仍单用户/无认证，具体范围待立项重评）。

## 工作约定

### 临时文件

- 临时文件、草稿、调研记录、日志和生成产物写入 `.agent-output/`。
- 不要把临时文件散落在仓库根目录、`docs/` 或未来的源码目录。

### 项目记忆

- 开始非平凡任务前查阅 `CONTEXT.md`；它只记非显而易见、跨会话有效的事实。维护规则见 `project-memory` 技能。

### 技能目录

- 技能存放在 `.agents/skills/`；`.claude/skills` 是指向它的软链接，不要打破。
- Codex 元数据放在每个技能的 `agents/openai.yaml`。
- 技能尽量保持项目无关；项目专属约定写入「项目适配」。

### 工作流

大型未知探索先用 `decision-map` 画图；普通需求澄清用 `interview`。

| 步骤 | 技能 | 产出 |
| --- | --- | --- |
| 固化需求 | `to-spec` | 主 spec，再子 spec；一次一份 |
| 拆票 | `to-tickets` | ticket，挂 `ready-for-agent` |
| 实现 | `implement` / `implement-spec` | 代码；测试循环由 `tdd` 承担 |
| 评审 | `code-review` | 标准轴 + 需求轴报告 |
| 交付 | `pr` | PR 描述与 PR（评审通过 ready / 待评审 draft） |

`to-spec`、`to-tickets`、`implement`、`implement-spec`、`interview`、`decision-map`、`handoff` 需用户显式触发；`code-review`、`pr`、`tdd`、`research`、`prototype`、`project-memory` 可在流程内自动调用。`implement-spec` 只做调度，实现由子 agent 完成。

辅助技能：`research` 查事实、`prototype` 试方案、`project-memory` 维护 `CONTEXT.md`、`handoff` 做交接。

简单任务可跳过 spec 与拆票：有代码改动的按 `tdd` 实现，然后 `code-review` → `pr` 创建 PR。评审不可跳过。

### 正式文档与归档

- 仓库文档只保留宏观架构、产品级范围基线和架构决策；详细 spec、ticket 全部进入 GitHub Issues，`docs/` 不留副本。
- 开发流程决策写在 `AGENTS.md` 或 issue。
- 文档结构、归档和 PR 规则见 `docs/README.md`。

### 文档与证据

- 不把静态核查、推断或未复现的能力写成实测结论。
- 引入外部候选项目或依赖前，核对版本、维护状态和许可证。
- 新结论写入文档、`AGENTS.md` 或 issue；聊天中的临时判断不构成确认。

### 协作

- 正式文档、issue/PR 内容和与用户的交流使用中文；代码标识符、命令、路径、协议/API 名称可保留英文。
- 不重复询问已明确的要求：WebUI 人工群聊、多成员通信、@、状态看板、普通启动后通过 MCP 入群。
- 交接文档不代表最终批准；以用户最新指令为准。
- 本项目独立于其他项目，不自动带入其他项目的专有约束。

## 必须保持清晰的技术边界

- WebSocket/SSE 更新 ≠ 消息写入持久化信箱 ≠ 消息进入模型上下文 ≠ 模型开始新的执行轮次。
- 仅配置 MCP 不承诺唤醒任意空闲宿主；通用 MCP 也不等于跨宿主运行中的中断能力。
- 长等待工具只在 agent 保持等待循环时有效；宿主 hooks、channel、队列或会话控制属于独立适配层。
- mentions 的存在 ≠ 精确的定向唤醒能力；@ 标记、可见范围和唤醒范围需要分别约定。
- 身份注册、连接心跳、工作状态、任务完成状态分开建模；处理状态陈旧和断线。
- 终端画面变化只能推断活动，不能当作精确的模型内部状态。

## 分期与里程碑

见 `docs/architecture/agent-studio.md` 第 9 节。

# AGENTS.md

本文件是本仓库的通用 agent 工作约定，适用于 Claude Code、Codex 及在此仓库工作的其他 AI agent。开始工作前先阅读。

## 项目概况

Agent Studio 是一个本地运行的跨 Agent 协作平台。Claude Code、Codex CLI 等作为保留各自上下文与身份的独立成员参与；人在 WebUI 中参与群聊、设定组织架构、管理任务和记忆。

当前已实现聊天与 MCP 主链路，以及多项目、组织、成员生命周期和审计等能力；当前入口与限制见 `README.md`，产品基线见 `docs/architecture/agent-studio.md`。decision map、详细 spec、ticket、依赖与状态以 GitHub Issues 为准。技术栈为 Node/TypeScript + SQLite（默认，可配置 PostgreSQL）+ WebSocket + MCP + Vue 3，默认 localhost、单用户、无认证；架构基线支持未来远程/多用户（V1 仍单用户/无认证，具体范围待立项重评）。

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

### 通用技能体系试运行

boardroom 是跨项目、跨语言技能体系的首个试验场。新入口存放在同一 `.agents/skills/` 下，版本和内容摘要见 `.agents/skills/work-suite.json`。这些文件提供工作方法与交接约定；真实工具、权限、任务归属和外部结果仍由项目已有系统决定。

日常用 `deliver-work` 推进已授权目标，用只读 `brief-project` 掌握架构、行为、累计变化与必要决定。其余技能按实际缺口使用，不要求每项任务经历全部步骤。

| 技能 | 职责 |
| --- | --- |
| `deliver-work` | 识别终点、组织依赖、推进、恢复与交付回执 |
| `frame-work` | 调查想法、反馈与改进，明确事实、范围和验收 |
| `design-work` | 行为、职责、接口、架构变化与验证路径 |
| `tla-verify-design` | 独立承担设计与 TLA+/TLC 验证，交出实现义务 |
| `implement-work` | 按契约实现与获得小步反馈 |
| `verify-work` | 执行当前候选所需的实际检查并保存证据 |
| `review-work` | 独立检查需求与标准，覆盖完整 WIP 与复审增量 |
| `land-work` | PR、反馈、CI、集成候选及已有授权内的合并 |
| `release-work` | 目标包含发布或部署时，完成产物与目标位置验收 |
| `brief-project` | 只读呈现事实、证据、累计架构变化与决策 |
| `work-in-room` | 跨 harness 协作、可靠收信、分工、交接与取消 |
| `improve-workflow` | 将漏检、误报或协作失效转成有证据的流程改进 |

沿用现有用户触发限制、TDD 前置条件、评审与 PR 规则。调用原技能前核对其实际契约；不能通过直接读盘绕过 invocation 限制。用户选择原入口时遵循该入口，新技能不伪称已经调用未运行的 Matt 或 pstack 组件，也不替原技能补造批准。

跨技能交接使用 `work-result/v1` 或等价紧凑文本；格式细节与校验器位于 `deliver-work`。共同字段为 work_id、skill、outcome、subject、evidence、unresolved、changed_assumptions、next_action。独立工具的原始报告保留，由外层交接封装。阶段完成、模型通过、运行通过、PR ready、实际合并和目标环境验收分别记录。小改动只做与风险有关的检查，不生成无关模型或逐字镜像测试。

房间接入先读取 `work-in-room/references/boardroom.md` 并核对当前 schema。当前 MCP 仅有 join、wait_for_messages、send_message、acknowledge_message、report_status、heartbeat、read_history。没有原子任务领取、租约、启动 harness 或合并工具时，使用外部权威记录、明确协调者和隔离工作区；这只是协作约定，不是运行时锁。

默认把成果、关键变化、证据缺口和必要决定聚合给人，不要求逐条阅读 Agent 对话。复用已有有效授权；简报、消息 ACK、模型多数同意和人的沉默均不创建新批准。

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

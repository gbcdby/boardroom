# 文档目录

本目录保存宏观架构、范围与项目工作流程；其他内容归属见下表。临时草稿、访谈记录、调研、原型和 agent 输出放在 `.agent-output/`。

## 目录结构

| 文档 | 内容 |
| --- | --- |
| [agent-workflow.md](agent-workflow.md) | 可调整的 Agent 工作流程 |
| [architecture/agent-studio.md](architecture/agent-studio.md) | 产品宏观架构、范围与验收基线 |
| [architecture/data-model.md](architecture/data-model.md) | 持久化数据模型、v13 事实版本、v14 角色/别名、v15 项目工作区与共同事务边界 |
| [identity-catalog.md](identity-catalog.md) | 角色不可变版本、稳定身份与永久 alias、旧配置只读来源及本地管理 API |
| [project-workspaces.md](project-workspaces.md) | 项目工作目录、v15 配置版本/CAS、原子创建、路径预检、旧目录来源映射及删除/复制边界 |
| [f2-authorize-guard.md](f2-authorize-guard.md) | 统一权限矩阵、拒绝语义、接入点位 |
| [policy-kernel.md](policy-kernel.md) | 纯策略求值、默认规则、解释预览与实际执行的边界 |
| [mcp-tool-contract.md](mcp-tool-contract.md) | 当前工具目录、绑定/CAS 与聊天契约 |
| [mcp-connections.md](mcp-connections.md) | 外部 MCP 连接版本、显式工具发现、完整目录、取消与当前支持边界 |
| [t1-project-group-api.md](t1-project-group-api.md) | 项目/群组/成员 HTTP 与早期 WebUI 契约 |
| [t3-member-lifecycle.md](t3-member-lifecycle.md) | 当前成员生命周期、移除、审计补偿与删除范围 |
| [getting-started-mcp.md](getting-started-mcp.md) | 安装、双数据库、三宿主 MCP 配置与限制 |
| [tasks-and-review.md](tasks-and-review.md) | 任务、固定 Git 候选与独立双轴评审 |
| [memory.md](memory.md) | 三层记忆、版本/冲突与目标 Agent 自总结 |
| [settings.md](settings.md) | 只读有效配置、来源、刷新与重启生效 |
| [environment-resolution.md](environment-resolution.md) | HTTP/stdio 共用环境解析、旧源只读预检、严格失败与存储恢复边界 |
| [settings-and-audit.md](settings-and-audit.md) | 设置、审计撤销/重做、移除与恢复的用户操作 |
| [v1-acceptance.md](v1-acceptance.md) | 全部 46 项 AC 的证据索引与实际缺口 |
| [t8-acceptance-report.md](t8-acceptance-report.md) | 保留原日期和对象的阶段 1 历史验收报告 |

被取代的架构文档按需要归档到 `docs/archive/`，不删去旧证据的日期与对象。

## 内容归属

开始使用见[安装与 MCP 接入](getting-started-mcp.md)。任务与评审见 [tasks-and-review.md](tasks-and-review.md)，记忆权限与冲突见 [memory.md](memory.md)，有效配置见 [settings.md](settings.md)，审计和恢复流程见 [settings-and-audit.md](settings-and-audit.md)。

[V1 验收索引](v1-acceptance.md)区分最终候选的 PASS / FAIL / BLOCKED / NOT_RUN、静态 OBSERVED 与历史背景。[T8 报告](t8-acceptance-report.md)保留原阶段、原宿主版本与日期，不作为后续任务评审/记忆真实模型结果。

| 内容 | 位置 |
| --- | --- |
| 产品宏观架构、范围、领域模型、阶段、产品级需求与验收基线 | `docs/architecture/` |
| 架构决策 | `docs/architecture/` 下的相应文档 |
| 开发门槛、工具、协作约定 | `AGENTS.md` 或 issue |
| 可调整的 Agent 工作流程 | [agent-workflow.md](agent-workflow.md) |
| decision map、详细 spec、子 spec、ticket、依赖与状态 | GitHub Issues |
| 临时草稿、访谈、调研、原型、日志 | `.agent-output/` |
| 跨会话项目记忆 | `CONTEXT.md` |

## 规则

- 架构文档只写长期有效的结论、范围、边界、约束和决策；不写逐条任务状态、排期过程或迁移记录。
- 文件名使用 kebab-case slug；文档开头标注状态与日期。状态取值：`草案`、`已确认`、`已取代`、`已放弃`。
- 架构决策可以并入相应架构文档，或在 `docs/architecture/` 下按需新增文档；不强制单独的决策文件格式。
- 架构文档变更走 PR，至少经过一次独立文档或代码评审；合并到默认分支由人决定。用户已明确授权当前合并时，由 `worker-land` 核对必要门禁后执行并回读结果，无需重复询问。
- 被整体取代的架构文档移动到 `docs/archive/`，保留原文件名，并在开头标注归档日期和状态。
- PR 描述引用相关 issue；ticket 由 `deliver` 生命周期负责人在验收及必要审查完成、关票授权有效时协调更新，PR 不使用 `Closes #N`。当前技能入口与记忆维护规则见 `AGENTS.md`。

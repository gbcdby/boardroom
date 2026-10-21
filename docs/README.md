# 文档目录

本目录只保存宏观架构与范围文档；其他内容归属见下表。临时草稿、访谈记录、调研、原型和 agent 输出放在 `.agent-output/`。

## 目录结构

```
docs/
├── README.md
├── architecture/
│   └── agent-studio.md       # 产品宏观架构、范围与验收基线
└── archive/                  # 已取代或废弃的架构文档（按需创建）
```

## 内容归属

| 内容 | 位置 |
| --- | --- |
| 产品宏观架构、范围、领域模型、阶段、产品级需求与验收基线 | `docs/architecture/` |
| 架构决策 | `docs/architecture/` 下的相应文档 |
| 开发流程、工具、协作约定 | `AGENTS.md` 或 issue |
| decision map、详细 spec、子 spec、ticket、依赖与状态 | GitHub Issues |
| 临时草稿、访谈、调研、原型、日志 | `.agent-output/` |
| 跨会话项目记忆 | `CONTEXT.md` |

## 规则

- 架构文档只写长期有效的结论、范围、边界、约束和决策；不写逐条任务状态、排期过程或迁移记录。
- 文件名使用 kebab-case slug；文档开头标注状态与日期。状态取值：`草案`、`已确认`、`已取代`、`已放弃`。
- 架构决策可以并入相应架构文档，或在 `docs/architecture/` 下按需新增文档；不强制单独的决策文件格式。
- 架构文档变更走 PR，至少经过一次文档或代码评审；合并到默认分支由人决定。
- 被整体取代的架构文档移动到 `docs/archive/`，保留原文件名，并在开头标注归档日期和状态。
- PR 描述引用相关 issue；ticket 由 `implement` / `implement-spec` 在评审通过后关闭，PR 不使用 `Closes #N`。

---
name: to-tickets
description: 在已确认的 spec 或子 spec、范围稳定后，将其拆分为可独立实现和验收的 ticket：纵向切片、显式 blocked_by、写入前概览确认。用于「拆票」「拆分任务」「生成实施票」「ticket 拆分」等场景。
disable-model-invocation: true
---

# Ticket 拆分

## 调用方式

本技能由用户显式触发。完成后提示用户下一步（`implement` 单票或 `implement-spec` 整份）；不要自动开始实现。

## 目标

把已确认的 spec 或子 spec 拆成可执行、可测试、可追溯的 ticket。拆票不重新定义需求；需要改变范围或验收标准时，先回到 spec，而不是在 ticket 里临时决定。

## 主 spec、子 spec 与 ticket

- 主 spec 描述产品级范围；子 spec 细化一个阶段或模块；ticket 是执行单元。
- 只允许一层父子关系：主 spec → 子 spec → ticket。
- 每个 ticket 必须链接所属子 spec 和主 spec。
- 子 spec 维护自己的 ticket 列表；主 spec 维护子 spec 列表。

## 项目适配

本技能默认使用下列约定；宿主项目有不同规范时，以宿主项目为准：

| 用途 | 默认约定 | 说明 |
| --- | --- | --- |
| 正式 spec | issue tracker | 以 `AGENTS.md` / 项目约定为准 |
| ticket | issue tracker | 一票一个 issue |
| ticket 编号 | issue 编号 | 不复用、不重排 |
| ticket 标题 | `[ticket] <短号> <标题>` | 短号区分基础票（F）与纵向切片票（T） |
| 初始就绪标签 | `ready-for-agent` | 表示规格完整、agent 可直接接手 |
| 活跃状态 | assignee 认领 | 认领即所有权，不要新增进度标签 |
| 完成 | 关闭 issue | 保留完整历史 |
| 临时输出 | `.agent-output/` | 放拆票草稿和过程记录 |
| 文档语言 | 项目约定语言；无约定时跟随用户语言 | 本仓库使用中文 |

本项目使用 GitHub Issues：ticket 直接创建为 issue，以 issue 编号作为 ticket 编号。

### 标签约定（项目适配）

ticket 只使用下列就绪标签之一，不使用 `type:*`、`phase:*` 或进度标签：

| 标签 | 含义 |
| --- | --- |
| `ready-for-agent` | 待开始，规格完整，agent 可直接接手 |
| `ready-for-human` | 实现完成待评审，或需要人裁决、实测、合并 |
| `needs-info` | 被缺失信息或未决决策阻塞 |
| `wontfix` | 不再实施；同时关闭 |

- ticket 初始状态为 `ready-for-agent`；spec 永不打这个标签。
- 一张 ticket 最多一个就绪标签。被 `blocked_by` 阻塞不是 `needs-info`。
- 完成即关闭 issue，不保留就绪标签。
- 阶段和所属 spec 由父 issue 关系表达。

## 前置条件（硬门禁）

开始拆票前，必须同时满足：

- 来源 spec 已确认：开放且不带 `needs-info`；带 `needs-info` 的草案不能拆票。
- 范围稳定：没有会改变 ticket 切分的阻塞性待定项；缺失信息先回到 `to-spec` 或询问用户。
- 只处理当前批次：一次只拆一份已确认子 spec 或一个明确阶段，不预先把所有阶段都拆完。
- 先出概览并确认：必须向用户展示简短概览，获得明确确认后才能写入 ticket。

用户说「拆票」不等于可以直接写入；概览确认是单独的一步。

## 拆票原则

### 纵向切片

每张 ticket 是一条 **tracer bullet**：窄但完整地穿过数据、接口、UI 和测试，而不是某一层的横向切片。

- 完成后的 ticket 可以独立演示或验证。
- 一张 ticket 应能在一个全新的上下文窗口内实现；如果实现时必须重新通读整份 spec，说明票太大。
- 优先让相邻 ticket 共享同一组测试 seam，减少新 seam 的数量。

### 基础票是例外

工程骨架、公共数据模型、测试基线这类**基础票**无法自然地纵向切片，可以作为例外：

- 明确标注为「基础票 / prefactor」，并尽量缩小范围。
- 基础票先做，后续票在它的基础上切纵向路径。
- 不要把基础票扩展到整个阶段的所有层。

### 宽重构用 expand–contract

一个机械修改的影响面横跨整个代码库、无法单独保持绿色时，不要强行纵向切片，改用三步序列：

1. **expand**：并存新旧两种形态，旧调用点不受影响。
2. **migrate**：按影响面分批迁移调用点；每批一张 ticket，依赖 expand，批间保持 CI 绿色。
3. **contract**：删除旧形态；依赖所有迁移批次。

每批票都在 `blocked_by` 中写明前置关系；无法单独保持绿色时，用一张最终的 integrate-and-verify 票收口。

### 行为优先

ticket 描述可观察的行为、接口契约和验收标准，不写容易过时的文件路径或代码片段。

例外：如果原型产出的状态机、reducer、schema 或类型形状比文字更精确，可以内联决策相关的片段，并注明来源；只保留承载决策的部分，不放完整示例代码。

## 拆票流程

1. 阅读 `AGENTS.md`、项目约定、父 spec、当前子 spec 和已有 ticket，使用项目术语。
2. 确定批次边界：本次只拆哪一份子 spec 或哪个阶段。
3. 建立 ticket 映射，至少包含：
   - 稳定编号与标题；
   - 交付的可观察行为；
   - 目标、范围、不包含；
   - 显式 `blocked_by`（没有则写「无，可立即开始」）；
   - 覆盖的需求 ID；
   - 覆盖的验收标准 ID；
   - 测试 seam 与可独立测试的完成定义。
4. 检查覆盖和依赖：
   - 当前子 spec 范围内的需求和验收标准都有 ticket 覆盖；
   - 没有无来源的 ticket，也没有重复职责；
   - 依赖构成 DAG，无环；
   - 计算 ready frontier：所有 blockers 已完成的 ticket 才能开始；
   - 标出可并行波次和必须串行的部分；
   - 列出会阻塞拆票的 spec 缺口。
5. **写入前概览（必须）**：
   - 只展示简短概览，不展示完整 ticket 正文；
   - 包含来源 spec、批次、票数、编号/标题、交付行为、`blocked_by`、覆盖、可并行波次、缺口和发布位置；
   - 询问用户：粒度是否合适？阻塞边是否正确？是否有票需要合并或再拆？
   - 使用宿主提供的确认方式（如 `AskUserQuestion`）让用户选择「确认写入 / 调整 / 暂停」；
   - 用户要求调整时，修改映射并重新展示，不得直接写入。
6. 只有获得明确确认后，才发布 ticket；按依赖顺序创建 issue，blockers 在前，优先使用平台原生的 blocking 关系；没有原生关系时在正文写 `blocked_by`。
7. 每个 ticket 使用 `references/ticket-template.md`，标题加 `[ticket]` 前缀，初始就绪标签为 `ready-for-agent`。
8. 写入后：
   - 更新子 spec issue 的 ticket 列表；
   - spec 的就绪标签不变；
   - 更新 issue 中的关联链接和标题前缀。
9. 校验：
   - ticket 数量、编号与概览一致；
   - 每个 ticket 都能链接回子 spec 和主 spec；
   - 覆盖矩阵完整，依赖 DAG 有效，ready frontier 可计算；
   - 每张 ticket 恰好一个就绪标签，且没有 spec 被打上 `ready-for-agent`；
   - 没有过程性内容、过时路径或未验证能力承诺。
10. 到此停止。除非用户另行要求，不自动开始实现或修改源码。

## 写入前概览格式

概览应能在一屏内看完，建议：

```text
拆票概览
- 来源 spec：<issue 链接>（<状态>）
- 批次：<阶段/模块>
- 票数：N
- 发布位置：GitHub Issues

| 编号 | 标题 | 交付行为 | 覆盖 | blocked_by |
| --- | --- | --- | --- | --- |
| <issue 编号> | ... | ... | ... | 无 |
| <issue 编号> | ... | ... | ... | <issue 编号> |

- 可并行波次：...
- 缺口 / 待定：...
```

不要在概览里粘贴 ticket 正文、实现细节或大段 spec 原文。

## Ticket 内容要求

每个 ticket 至少包含：

- 稳定编号、状态和阶段/批次；
- 父 spec 和所属子 spec 的链接；
- `blocked_by`；
- 覆盖的需求 ID 和验收标准 ID；
- 交付的可观察行为；
- 范围与不包含；
- 接口契约、状态机或关键设计约束（避免过时路径）；
- 测试 seam、验收与测试；
- 风险 / 待定；
- 完成定义。

要求：

- 一张 ticket 对应一个可独立实现、测试和评审的交付物。
- 不把后端、UI、验证混成一张巨型 ticket，也不按单个文件过度拆分。
- ticket 不引入 spec 中没有的新需求。
- 一张 ticket 只属于一个子 spec；跨 spec 的工作先拆分。
- 完成定义必须包含自动化测试；涉及宿主能力时，区分已实现和待实测。
- 规模以「一个全新上下文窗口能完成」为准；超出时继续切分。

## 质量检查

- [ ] 来源 spec 已确认，不是草案。
- [ ] 写入前已向用户展示简短概览并获得明确确认。
- [ ] 当前批次的需求和验收标准全部有 ticket 覆盖。
- [ ] 每张票是纵向切片，或明确标注为基础票 / expand–contract 批次。
- [ ] 每张票能在一个全新上下文窗口内完成。
- [ ] 没有重复、遗漏或无来源的 ticket。
- [ ] `blocked_by` 构成 DAG，无环；ready frontier 和并行波次清楚。
- [ ] 每个 ticket 链接回所属子 spec 和主 spec。
- [ ] ticket 不依赖会过时的文件路径或代码片段。
- [ ] 子 spec 的 ticket 列表已更新；每张 ticket 恰好一个就绪标签，spec 未被误打 `ready-for-agent`。
- [ ] ticket 标题带 `[ticket]` 前缀，短号与概览一致。
- [ ] ticket 数量、编号与概览一致。
- [ ] 没有过程性内容；没有把未验证能力写成事实。
- [ ] 没有在拆票过程中开始实现。

## 与其他技能的关系

技能链路见项目的 agent 约定文件（如 `AGENTS.md`）。项目没有对应技能时，按项目实际流程执行。

- `to-spec`：负责把已确认需求固化为主 spec 或子 spec；不直接创建 ticket。
- `to-tickets`：只接收已确认的 spec，先概览确认，再拆分和发布 ticket。
- `implement`：按单张 ticket 执行；实现前确认依赖已完成。
- `implement-spec`：按 ticket 任务图和 ready frontier 执行整份 spec。
- `code-review`：以 ticket 所属子 spec 和主 spec 为需求轴审查实现。
- `pr`：在实现与评审完成后生成结构化 PR。

## 复用

本技能依赖 `references/ticket-template.md`；复制到其他项目时保留目录结构（至少 `SKILL.md` + `references/`），并按宿主项目调整编号和状态约定。

## 反模式

- 没有向用户展示概览就写入 ticket。
- 把完整 ticket 正文当成概览展示，让用户难以快速确认。
- 从草案 spec 拆票。
- 给 spec 打 `ready-for-agent`。
- 用 `phase:*`、`type:*` 或 `in-progress` 标签表达阶段和进度。
- 一次预写所有阶段的 ticket。
- 按层横向切票：所有数据层一张、所有接口一张、所有 UI 一张。
- 把一张 ticket 做成跨多个模块的巨型任务，或按单个文件过度拆分。
- 把宽重构强行切成无法单独保持绿色的纵向切片。
- 忽略 `blocked_by`，按编号顺序实现。
- 在 ticket 里写死文件路径或会过时的代码片段。
- 创建没有需求/验收映射的 ticket。
- 一张 ticket 同时服务多个子 spec。
- 在 ticket 里新增 spec 没有的需求或验收标准。
- 拆票后未经用户要求就开始实现。

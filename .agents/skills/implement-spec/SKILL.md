---
name: implement-spec
description: 按 ticket 任务图执行一整份已确认的 spec：计算 ready frontier、调度子 agent 逐票实现、最终统一 code-review。主 agent 只做调度，不亲自写实现。用于用户明确要求「把这份 spec 做完」「整份实现」「按任务图连续执行」的场景；单票实现使用 implement。
disable-model-invocation: true
---

# 整份 Spec 实现

## 调用方式

本技能由用户显式触发。全部 ticket 完成后调用 `code-review`（模型可触发）；评审通过后可调用 `pr` 生成描述并创建 ready PR，合并到默认分支由用户决定。

## 目标

把一份已确认 spec 关联的全部 ticket 实现到同一条 integration branch 上，并在最后统一做 `code-review`。ticket 不是线性步骤，而是带 `blocked_by` 的**任务图**；任何时刻只有 blockers 已完成的 ticket 可以开始，这些 ticket 构成 **ready frontier**。

这是高自主度的执行模式：只在该 spec 的 ticket 已拆好、用户明确要求整份执行时使用。单票实现使用 `implement`。

## 角色分离（硬规则）

主 agent 只做调度：派票、核对、合并、跑验证、维护 issue 状态，一律不写业务代码。

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| 主 agent | 建任务图、算 frontier、派票、核对范围、合并、跑验证、写 ticket 状态、关闭 issue、发起 `code-review` | 写实现代码、写测试、改业务文件 |
| 实现子 agent | 一张票的实现与测试（按 `tdd`）、自测、报告结果 | 跨票改动、改 spec、合并分支、关闭 ticket |

- 跑验证和合并是调度职责，不是实现：主 agent 只执行已有测试命令并看结果，不改测试也不改实现。
- 主 agent 不因「票很小」或「顺手」而自己动手；发现自己在改业务文件时立即停下，改派子 agent。
- 宿主不支持子 agent 时停止并向用户报告，不要退化成主 agent 亲自实现。
- 主 agent 的上下文只保留任务图、状态和子 agent 回报的结论；核对范围时只读改动文件清单和 diff 摘要，不读入完整实现。

## 分支与 PR 模型

- 每张票的实现单元是「一张票一个分支」；宿主支持且用户同意并行时，再为每张票配独立 worktree。
- **预合并**：每票完成并通过主 agent 核对后，合并回 integration branch；票分支不单独提 PR。
- **一个 PR**：整份 spec 只在最后提一个 PR，integration branch → 默认分支，覆盖该 spec 的全部 ticket。
- 默认分支只在用户合并该 PR 时更新。

## 前置条件（硬门禁）

- 来源 spec 已确认；ticket 已拆好并通过用户确认。
- ticket 的 `blocked_by` 构成 DAG，无环；ready frontier 可计算。
- 没有会改变实现的阻塞性待定项；有缺口时先回到 spec/ticket，不在执行中临时决定。
- 用户明确要求整份执行；用户只要求某一张票时使用 `implement`。
- 当前分支干净，或用户已确认可以创建 integration branch。
- 宿主支持子 agent；不支持时先报告，由用户决定是否改用 `implement` 逐票执行。

## 流程

1. 读取 spec 和全部 ticket，建立任务图。先报告：票数、ready frontier、并行波次、预计串行链。
2. 创建 integration branch，从用户指定的基准点分出；不要直接在默认分支上实现。
3. 按 frontier 派票给实现子 agent：
   - 每票开工前确认 `blocked_by` 已完成；
   - 宿主支持 git worktree 且用户同意并行时，为每张票开独立 worktree 和分支；否则串行复用同一工作区。把实际选择明确告诉用户，不要假定宿主能力；
   - 子 agent 按 `implement` 的规则做这一票，按 `tdd` 在已确认的 seam 上推进红绿循环；
   - 与 `implement` 的差异：子 agent 只实现和自测，不更新 ticket 标签、不关闭 ticket、不单独发起 `code-review`；这些由主 agent 统一处理；
   - 子 agent 回报：改动文件、测试结果、验证命令、未决问题；
   - 涉及宿主能力时，子 agent 记录实际命令和版本。
4. 主 agent 验收并合并每票结果：核对改动范围是否与 ticket 一致，合并回 integration branch，合并后立即运行相关测试和类型检查，保持集成分支可构建。
5. 每完成一票，把该 ticket 的就绪标签从 `ready-for-agent` 换成 `ready-for-human` 并写入验证记录；重算 frontier，有新票解锁时再派下一批。
6. 全部 ticket 完成后，在 integration branch 上运行全量测试，并调用 `code-review` 做双轴审查。
7. 修复审查中确认的阻塞问题；修复同样派给子 agent，主 agent 只复核。修复后重新运行全量测试和 `code-review`，直到无阻塞问题。
8. 收尾：用 `pr` 为 integration branch → 默认分支生成**一个** PR，覆盖该 spec 的全部 ticket；票分支不单独提 PR。是否合并由用户决定。
9. 关闭 issue：评审通过后逐张关闭已完成的 ticket，关闭时移除就绪标签。spec 按 `to-spec` 的状态规则处理：仍需维护时保持开放，不再维护时才关闭。PR 被打回或关闭时重新打开对应 ticket。
10. 清理临时 worktree 和票分支（若有），保留 integration branch 供评审。
11. 到此停止：未收到用户指令，不合并到默认分支，不自动开始下一份 spec。

## 并行与合并规则

- 只并行 ready frontier 上的 ticket；被阻塞的票不得提前开始。
- 使用 worktree 时，每张票的 worktree 必须基于 integration branch 的当前顶端；开工前确认，落后时先 rebase/merge。串行复用同一工作区时，开工前先把工作区更新到 integration branch 最新状态。
- 派票时只给上下文指针：指向 spec、ticket、调研笔记和已有提交，不复制大段内容。
- 合并保持小步、频繁；解决冲突后重跑测试。无法保持绿色的合并先回到对应 ticket 修复。
- 子 agent 的职责是完成一张票，不是扩大范围或修改其他票。
- 主 agent 对每票结果做范围核对后才合并；范围超出的部分退回重做，不自行删改。

## 停止与升级

遇到以下情况立即停止并向用户报告，不自行猜测：

- spec 或 ticket 存在未决的阻塞性问题；
- ticket 与 spec 冲突，或验收标准无法验证；
- 依赖关系出现循环或与实际实现不符；
- 宿主能力不足以完成关键验证，或宿主不支持子 agent；
- 子 agent 连续两次未能按 ticket 范围交付；
- 合并后无法保持 integration branch 可构建且短时间内无法定位。

报告内容：卡在哪张票、阻塞原因、已尝试的动作、需要用户决定的事项。

## 完成判据

- 所有 ticket 完成，验证记录已写入。
- integration branch 上全量测试通过。
- `code-review` 两个轴均无阻塞问题，或例外已记录并经用户确认。
- 审查和实现过程可追溯：fixed point、宿主版本、验证命令有记录。
- 主 agent 未直接修改业务文件。
- 只产生一个 PR（integration branch → 默认分支），票分支没有各自的 PR。
- ticket 已关闭，未残留就绪标签。
- 没有把未验证能力写成事实。
- 合并到默认分支的动作留给用户。

## 反模式

- 主 agent 自己写实现或测试（含「票小就顺手改」）。
- 宿主不支持子 agent 时悄悄退化成主 agent 亲自实现。
- 子 agent 越权改 ticket 标签、关闭 ticket 或自行发起 `code-review`。
- 审查通过后仍把已完成的 ticket 留在开放状态。
- 每张票单独提 PR，或票分支未经合并就留在 integration branch 之外。
- 按 ticket 编号顺序实现，忽略 `blocked_by`。
- 并行执行被阻塞的 ticket。
- 直接在默认分支上实现。
- 跳过最终 `code-review` 或只做单轴审查。
- 子 agent 各自解释 spec，产生范围漂移。
- 把整份 spec 和所有 ticket 正文复制进每个子 agent 的提示词，造成上下文污染。
- 审查发现的问题只修一部分就宣布完成。
- 未经用户确认自动合并到默认分支。

## 与其他技能的关系

- `implement`：单票实现规则；子 agent 执行每票时复用它。
- `tdd`：每张票的红绿循环。
- `code-review`：全部票完成后统一双轴审查。
- `pr`：收尾时生成 PR 描述。

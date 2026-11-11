# 任务与双轴评审

状态：已确认（实现与使用说明；最终验收独立记录）
日期：2026-11-10；2026-11-11 更新生命周期与验证边界
需求来源：[主 Spec #1](https://github.com/gbcdby/boardroom/issues/1)，AC-TASK-01～03、AC-REVIEW-01～05。

任务归属于当前项目。任务板使用 `todo → in-progress → review → done`，阻塞单独显示为 `blocked`。编辑、状态、配置和评审操作使用对应的当前修订号；遇到 409 先读取最新数据，本地草稿保留，不能自动覆盖别人的改动。

入口为 `/projects/:projectId/tasks`，详情为 `/projects/:projectId/tasks/:taskId`。顶部项目选择与聊天、组织、记忆共用；URL 项目优先。有未保存输入时切项目先确认，取消不改变 URL 或草稿。页面加载/写入失败可重试；409 应先比较新旧数据，再用明确的新修订提交。

## 使用流程

1. 在项目任务页明确选择默认评审 Agent。评审成员必须在岗，并与负责人不同；失效配置会说明原因，不猜测替代人。
2. 人或有管理范围的 manager 创建任务，填写标题、正文、标签、负责人、仓库路径及 fixed point。普通项目成员可评论，负责人可推进自己的任务。
3. 指派通知持久保存。Agent 在 `join` 或 `wait_for_messages` 安全点领取；确认事件只表示收到，不代表任务开始或完成。离线宿主保持待处理，平台不据此承诺启动外部 CLI。
4. 负责人进入进行中。阻塞时必须写原因，系统沿岗位汇报线跳过空岗寻找有效 manager；没有接收者时仍保留未解决记录。
5. 提交评审时固定任务快照、base commit、candidate commit、完整 diff 和命令记录。真实 Git 采集发生在短事务之外，提交前重新验证权限、运行所有权和任务修订。
6. 指定 reviewer 接手评审，运行两个并行且上下文独立的评审：Spec 检查任务要求；Standards 优先检查仓库规范，再用代码坏味道作为判断提示。两份报告分别写入评论，不能合并为排名。
7. 两轴均通过才能作普通通过裁决。打回返回进行中；人或有管辖权的 manager 可在两份报告齐备后写理由覆盖，原报告、原结论及覆盖原因保留。

## Git 候选与失败处理

首版接收已提交、工作区与索引都干净的候选。fixed point 必须可解析为提交；空 diff、未提交修改、缺少任务正文、不可用仓库、超限或不支持的工作区会记录失败轮次并说明原因。失败不推进任务修订/状态。改正文、指派或候选会使旧轮次失效，旧报告保留，但不能用于新候选通过。

候选检查不运行仓库的 clean/process filter、fsmonitor、external diff、textconv、hooks 或签名验证程序。禁用全部 Git 传输与缺失对象懒拉取；对象不完整时失败。直接比较固定树、索引及文件原始字节，支持 SHA-1/SHA-256 Git 对象；子模块、稀疏/转换工作区或无法完整表示的 diff 明确拒绝。命令超时 10 秒、diff 上限 2 MiB、提交列表上限 200；不会截断后冒充完整候选。

## 公开入口

HTTP 为 `/api/projects/:projectId/tasks` 及任务详情、`transitions`、`comments`、`message-links`、`reviews` 子资源；默认评审配置为 `/api/projects/:projectId/task-settings`。修改需要同源 JSON 请求，字段严格校验，客户端不能指定 actor 或直接覆盖修订。

| MCP 工具 | 用途 |
| --- | --- |
| `get_task_settings` / `set_task_settings` | 查询/配置明确默认评审成员 |
| `list_tasks` / `read_task` | 任务、历史、固定轮次和分轴指引 |
| `create_task` / `update_task` | 创建、编辑与改派，受管理范围限制 |
| `transition_task` / `comment_task` | 状态与阻塞原因；项目成员评论 |
| `link_task_message` | 显式关联有权读取的当前群消息 |
| `start_task_review` / `begin_task_review` | 固定候选；指定 reviewer 接手 |
| `submit_task_review_report` / `decide_task_review` | 单轴报告与声明证据；本轮裁决 |
| `list_work_events` / `acknowledge_work_event` | 当前绑定成员自己的持久工作通知 |

字段权威定义为 `src/shared/tasks.ts` 与 `src/server/tasks/schemas.ts`。MCP 的项目、成员与群组来自 join 绑定；传入不同 projectId 被拒绝。普通成员参与任务后可读取关联消息，但仍要通过当前项目、群组和连接权限；退群、停用或改派会重新判断。任务关联不扩大 mention 唤醒范围。

`wait_for_messages` 新增 `status: "work"` 和可选 `workEvents`。同时有聊天消息时仍是 `status: "message"`，两者可以一起返回。未确认事件会重投，宿主应按事件 ID 去重，再明确开始任务。运行所有权过期后不能投递、ACK 或写入。

## 数据与页面

v11 新增任务配置、任务、评论、历史、消息关联、评审轮次、报告和工作事件八张表。业务修改、历史、审计和事件在同一 RepoCtx 事务提交；通知失败不会把已经提交的业务误报为失败。SQLite 与 PostgreSQL 使用相同约束，数据复制覆盖新表。

归档项目可读但禁止写入。删除群组清除关联消息链接和该群上下文工作事件，保留项目任务与评论；删除项目清理全部任务实体及事件，保留既有审计。移除成员保留任务、评论、报告及作者身份。审计补偿或重新添加不会倒退任务/配置修订，也不会复活旧评审执行；需要重新接入、重新提交评审的情况见[生命周期说明](t3-member-lifecycle.md#当前-v13-行为与审计恢复)。

页面使用唯一当前项目上下文。URL 项目优先，其次上次选择、首个有效项目。旧链接会规范化。切换项目前确认未保存草稿；确认后清理旧项目草稿、身份和订阅，取消则保留原上下文。任务操作可用键盘及按钮完成，不依赖拖拽。评审报告分别呈现，详细执行记录按需展开。

## 验证与真实模型门槛

`npm test` 覆盖状态、权限、隔离、事务、并发及生命周期；配置 `AGENT_STUDIO_PG_TEST_URL` 后执行真实 PostgreSQL 用例。`npm run e2e:tasks` 使用真实 HTTP、MCP SDK、Git 与数据库跑创建→通知→候选→两轴 CAS→裁决→覆盖。其报告明确为协议夹具，**不计作 AC-REVIEW-04 真实模型评审**。

在已登录、可以正常执行模型的 Codex CLI 环境，可将 `read_task` 或 HTTP 详情保存为 JSON，再执行：

```sh
node scripts/run-review-axes.mjs task-detail.json /path/to/codex
```

脚本固定输入，并行启动两个只读、独立临时上下文，保留精确 CLI 版本、argv、时间、上下文 ID、prompt/JSONL hash 和独立输出；不会修改登录目录，也不会自动提交报告或裁决。CLI 失败、缺少真实模型事件、两轴未重叠或候选变化都会返回失败。指定 reviewer 必须核对真实输出、标准来源与需求覆盖，再用平台工具分别提交报告和裁决；两轴竞争同一 revision 时，失败一轴刷新轮次后重试。

### 采集报告的完整性合同

每轴 prompt 使用 `boardroom-review-report/v1`：第一行 `Review-Axis: spec` 或 `Review-Axis: standards`，第二个非空行为唯一的 `Verdict: PASS` 或 `Verdict: CHANGES_REQUESTED`；然后依次为 `## Evidence`、`## Risks and gaps`、`## Checks`，每节填写实际正文。最后一行必须是本轴的 `<!-- review-report-complete:spec -->` 或 `<!-- review-report-complete:standards -->`。禁止只返回标记、空章节、未替换的模板或把整份报告包在代码围栏中；完整正文仍受平台 64 KiB 上限约束。

`evidence.json` 分轴保存 `modelOutputCollected`、`reportComplete`、`reportVerdict`、`reportValidationErrors` 和精确正文 `outputSha256`；汇总保存 `failureReasons`。正文、JSONL、stderr 和 prompt 在失败时仍保留。任何一轴缺结论、存在重复/矛盾结论、缺少章节/结束标记、轴不符或 CLI 失败，整体返回 `BLOCKED_OR_FAILED` 和非零退出码；不会自动重跑直到得到通过。一次完整的 `CHANGES_REQUESTED` 报告也可以得到 `READY_FOR_REVIEWER`，表示材料可供 reviewer 检查，并不代表任务通过。

结构校验不能证明结论合理、需求覆盖充分或原始执行真实。reviewer 仍须检查实际宿主、标准来源、文件证据和未执行范围，再自行提交与裁决。新增完整性规则由采集脚本回归验证；修订后的 prompt 尚未在真实 CLI 上重新执行，不能把合成事件回归称为原生复验。历史报告保留原始版本与格式，不能补写标记后宣称为新合同下的原生执行结果。

平台接受的执行证据始终标记为 `reviewer-declared`；结构和 hash 校验不能证明外部模型已经运行。AC-REVIEW-04 需要真实完成的评审、两份原始执行记录、平台轮次与报告 ID、裁决后的状态读回。[2026-11-11 阶段 3 独立实测回传](https://github.com/gbcdby/boardroom/issues/107#issuecomment-6789489800)已在应用候选 `5c7f87f20c31f78eac9be5875e644d44033e3648` 完成：macOS 26.5.2 / SQLite，两个 Codex CLI 0.167.0 隔离上下文并行，指定 Claude Code 2.1.233 reviewer 提交两轴并裁决；[阶段 5 补验](https://github.com/gbcdby/boardroom/issues/107#issuecomment-6790049547)另绑定 `533e49da5d4e9d4a236d68e0bc23c03411caa5b1`。执行与原始材料核对归原独立执行者，交付方承接正式报告，未将其写成本机或修复后候选重跑。

该回传发现 Codex reviewer 误读兄弟属性 `$ref`。任务工具现为每个公开字段导出内联类型和原有约束，仍拒绝字符串修订号及无效整数；没有改变 CAS、权限或裁决语义。实际 MCP schema/协议回归验证了这一表示修正，修复后真实 Codex reviewer 仍未重跑。已完成的 Claude reviewer 路径保留原候选身份，后续适用性与合并状态见 [Spec #104](https://github.com/gbcdby/boardroom/issues/104)及 [PR #99](https://github.com/gbcdby/boardroom/pull/99)。此前本机只读 Codex 运行目录的失败仍是该环境的历史事实，不代表外部实测未执行。

完整 46 项验收映射、候选身份、历史证据与尚未执行范围见 [V1 验收证据索引](v1-acceptance.md)。`scripts/run-review-axes.mjs` 只产出真实执行材料，不自动替 reviewer 接受报告、覆盖裁决或合并代码。

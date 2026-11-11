# V1 验收证据索引

状态：草案（证据映射已建立，最终候选与运行结果待固定）
日期：2026-11-11
范围：[主 Spec #1](https://github.com/gbcdby/boardroom/issues/1)、[阶段 5 Spec #109](https://github.com/gbcdby/boardroom/issues/109)、[Ticket #112](https://github.com/gbcdby/boardroom/issues/112)。验收要求取自[产品基线 §8](architecture/agent-studio.md#8-产品验收基线)。

**本索引包含全部 46 个 V1 验收项，目前不是 V1 通过报告。** 最终整合候选、真实 PostgreSQL、浏览器和合并后复验仍需关联实际结果；真实任务模型评审与目标 Agent 自总结尚无本轮合格证据。下面的运行结论为 43 项 `NOT_RUN`、3 项 `BLOCKED`，没有以静态检查或旧记录推定的 `PASS`。

## 1. 候选与记录口径

本文的源码与入口核对基线是 `3a6bb6fe4feba25fdb78fef3121f92ae60707c4d`，tree 为 `1edcac1f7390b68984f0640f5e4e2c5f49c8b4c4`，开始核对时工作树干净；另只读核对到 `8857b86a027964d490322f725eb185603a566bc8` 的完整审计读取与生产入口增量。2026-11-11T03:06:55Z 读取到的文档检查环境为 Linux 6.18.57 x86_64、Node v24.22.1、npm 11.9.0。这些核对是 **OBSERVED**：确认要求、代码、测试入口和历史出处，不是运行产品或验证每项行为。

每个 AC 记录由下表共同字段、命令目录和该 AC 行合并得到。最终执行者应逐条填写实际数据，不能只把整张表改成绿色。

| 字段 | 本版值与填写规则 |
| --- | --- |
| `acceptanceId` | 每行唯一 AC ID，与产品基线的 46 项一一对应。 |
| `candidateCommit` / `tree` | `null`：最终运行候选尚未冻结。上述源码核对基线不冒充最终候选。执行后写完整 commit/tree。 |
| `dirtyManifest` | `null`：未开始最终运行。执行时记录完整 staged、unstaged、untracked 清单；干净候选明确写 `[]`。 |
| `command` | 每行列出的命令组及指定测试/场景；正式结果保存真实 argv、工作目录、退出码。命令存在不代表已执行。 |
| `environment` | `null`：最终运行环境未记录。分别记录 OS、架构、Node/npm、数据库及版本、浏览器、宿主 CLI 精确版本；不保存凭据。 |
| `observedAt` | `null`：未在最终候选执行。完成后记录 UTC 起止时间；历史记录保留自己的日期。 |
| `status` | 只用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。测试工具的 SKIP 是该范围未验证，不是 PASS。静态检查另标 OBSERVED。 |
| `evidence` | 每行给出可复现入口和证据要求；当前没有最终候选运行产物。执行后填写可读取的 CI run/artifact 或报告位置、摘要及对应对象。 |
| `limitation` / `nextAction` | 每行末列明确尚缺范围与下一步。模型环境阻塞详见 §5；不能用协议夹具替代。 |

数据库、HTTP/MCP、真实浏览器、真实宿主模型分别记录。一次 SDK 调用只证明该协议路径；`reviewer-declared` / `agent-declared` 元数据只证明声明被校验和保存。消息入库、进入模型上下文、开始模型轮次和成功完成任务是不同事实。

## 2. 命令与证据目录

以下命令在干净检出的仓库根运行。安装、端口、临时数据、两种数据库与 MCP 接入步骤见[接入指南](getting-started-mcp.md)；设置的配置快照与重启说明见[设置文档](settings.md)。数据库测试必须使用专用测试库，不能指向用户正在使用的数据。

| 命令组 | 可复现入口 | 能证明的范围与应保留产物 |
| --- | --- | --- |
| `C-BASE` | `npm ci`；`npm run typecheck`；`npm run build`；`npm test` | 依赖、类型、构建和实际执行的自动化用例。保留完整日志、通过/失败/跳过数量；未配置 PG 时不覆盖 PG。 |
| `C-CORE` | `npm run e2e` | 生产 HTTP + MCP SDK 的聊天、状态、防环与重启链；[脚本](../scripts/e2e-phase1.mjs)。不启动真实 Claude/Codex。 |
| `C-TASK` | `npm run e2e:tasks` | 真 HTTP/MCP/Git/数据库的任务、通知、固定候选、报告 CAS 和裁决；[脚本](../scripts/e2e-tasks.mjs)。报告正文为 synthetic 协议夹具，不能证明模型评审。 |
| `C-MEM` | `npm run e2e:memory` | 真 HTTP/MCP/数据库的记忆权限、人工优先、请求/版本、触发和注入；[脚本](../scripts/e2e-memory.mjs)。保留 `realModelSummary: NOT_RUN`。 |
| `C-DB` | 在设置 `AGENT_STUDIO_PG_TEST_URL` 的专用 PG 环境运行 `npm test`；以 `AGENT_STUDIO_DB_DRIVER=postgres`、`AGENT_STUDIO_PG_CONNECTION_STRING` 再运行 `C-CORE` / `C-TASK` / `C-MEM` | 真实 PG 路径独立取证，另保留 SQLite 结果。迁移/复制/回滚另见 `tests/member-facts.test.ts`、`tests/migrate-data.test.ts`、`tests/tasks-migrations.test.ts`、`tests/memory-repository.test.ts`。 |
| `C-UI` | `python scripts/e2e-webui.py`；`python scripts/e2e-tasks-web.py`；`python scripts/e2e-memory-web.py`；`python scripts/e2e-settings-web.py` | 安装 Playwright 及 Chromium 后执行真实页面操作、报告和截图；先 `npm run build`。默认产物在 `.agent-output/{webui,tasks-web,memory-web,settings-web}-e2e/`。SFC/DOM 定向测试不等同于 Chromium。 |
| `C-MANAGED` | `python scripts/e2e-managed-web.py --ci`；`node --test 'tests/runtime-*.test.ts'` | 托管配置、状态和隔离协议。脚本使用 synthetic fixture，不能放行原生 CLI profile，也不替代外部真实宿主。 |
| `C-HOST` | 按[三宿主指南](getting-started-mcp.md)配置真实 CLI，执行 `join → wait → send/ACK → 断开 → 新会话 join/wait` | 保存精确 CLI 版本、原始命令/输出、project/group/member/message ID、等待前后状态和重连结果。两 SDK 客户端不是两个真实宿主。 |
| `C-REVIEW` | `node scripts/run-review-axes.mjs task-detail.json /path/to/codex`，再由指定 reviewer 显式提交两轴报告并裁决 | 输入必须是当前任务与固定轮次；两隔离上下文并行、真实模型事件、标准来源、fixed point、原始输出和最终平台状态都要保存。见[任务与评审](tasks-and-review.md)。当前 BLOCKED。 |
| `C-SELF-SUMMARY` | 目标 Agent 在自己的有效 MCP 绑定中依次 `read_memory_summary → begin_memory_summary → submit_memory_summary` | 先由真实任务 done、N 条首次 MCP 投递或显式 session-end 触发；保留触发来源、request/attempt/version ID、真实模型原始输出及人工竞争测试。见[记忆文档](memory.md)。当前 BLOCKED。 |
| `C-INSTALL` | 独立目录干净检出 → `npm ci` → 类型/必要测试 → `npm start` → health/页面深链 → MCP tools/list 与实际领域操作 → 正常停止 → 同数据重启 | 保存 Node/npm/OS/数据库/CLI 版本、启动日志、实际端口和重启后数据读回；HTTP 200、HTML 或 tools/list 单独不能证明完整使用流程。 |
| `C-LOAD` | `node --test --test-concurrency=1 tests/lifecycle-load.acceptance.ts`；`python scripts/e2e-v1-load-web.py --ci --db sqlite`；在专用 PG 环境追加 `--db postgres` | 前者为真实数据库 + SDK InMemoryTransport，后者为生产 HTTP/MCP 与 Chromium DOM。逐次记录 1000/10,000 历史下的 remove/undo/redo、SQL/返回量、消息/ACK/心跳与 DOM 时延，不能互相替代。 |

`C-DB` 的两个 PG 变量用途不同：`AGENT_STUDIO_PG_TEST_URL` 门控测试文件，`AGENT_STUDIO_PG_CONNECTION_STRING` 供实际服务和 SDK e2e 连接；仅设置前者不会把 e2e 切到 PG。更换数据库驱动不搬迁数据。浏览器脚本的安装与运行命令见[接入指南 §8](getting-started-mcp.md#8-验收与可重复验证)。

`C-INSTALL` 的生产 smoke 自动化入口为 `node scripts/e2e-install.mjs`，使用实际 `npm start/prestart`、独立临时配置/data、可选 PG 新 schema，检查 HTTP、32 个 MCP 工具、实际消息/ACK、正常关闭与同数据重启。数据库选择沿用 `AGENT_STUDIO_DB_DRIVER` + `AGENT_STUDIO_PG_CONNECTION_STRING`，原始报告为 `.agent-output/install-e2e/{sqlite,postgres}.json`。脚本已经集成；最终候选结果仍需下表关联。干净检出的 `npm ci` 由安装环境/CI 单独记录，不由脚本伪造。

## 3. 全部 46 项映射

表中的文件均为当前基线存在的入口，`evidence` 只指明待绑定的证据来源。每行 `status` 针对最终候选；测试名称里出现 AC 编号或旧报告写“通过”不会改变该状态。

### 3.1 通信核心：11 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-CORE-01 | localhost 启动、真实 PG 初始化/连接、WebUI 可访问 | `C-INSTALL`、`C-DB`、`C-UI`；`tests/http.test.ts`、`tests/postgres-smoke.test.ts`、`tests/settings-server.test.ts` | NOT_RUN | 原阶段 1 SQLite 记录不覆盖修订后的 PG 要求；补最终候选 PG + 生产页面结果。 |
| AC-CORE-02 | Claude Code、Codex CLI 各经 MCP 入群，无 wrapper、无需自动入群 | `C-HOST`；历史 `H-HOST` 仅背景 | NOT_RUN | 做宿主/绑定/权限变化影响分析，必要真实复验；SDK `hostType` 字符串不能充当宿主。 |
| AC-CORE-03 | 人在 WebUI 建项目/群，两个 Agent 加入并在线 | `C-CORE`、`C-UI`；`tests/projects-api.test.ts`、`tests/webui-e2e.test.ts` | NOT_RUN | 协议与 UI 分别记录；若声称真实双宿主，再关联 `C-HOST`。 |
| AC-CORE-04 | 普通成员只被 @；manager 被其他成员消息唤醒 | `C-CORE`；`tests/chat-routing.test.ts`、`tests/chat-routing-mcp.test.ts`、`tests/t8-human-wake.test.ts` | NOT_RUN | 验证实际参与关系、发送者不自唤醒和持久投递事实。 |
| AC-CORE-05 | 真实双宿主中 @单人/多人/全体正确，@all 只展开当时在线参与者 | `C-HOST`、`C-CORE`；`tests/chat-routing.test.ts`、`tests/t5-restart-recovery.test.ts` | NOT_RUN | `H-HOST` 仅旧对象；离线普通成员不因 @all 新增补投资格。 |
| AC-CORE-06 | 等待显示 waiting，处理显示 working | `C-CORE`、`C-UI`；`tests/status-domain.test.ts`、`tests/status-heartbeat-http.test.ts`、`tests/status-ws.test.ts` | NOT_RUN | 从 HTTP/WS 状态与实际工具返回取证；终端画面不能证明模型内部状态。 |
| AC-CORE-07 | 忙碌期尽力打断；不支持时保留到安全点 | `C-CORE`；`tests/interrupt-core.test.ts`、`tests/interrupt-mcp.test.ts`、`tests/message-durability.test.ts` | NOT_RUN | 三宿主当前打断均 unsupported；验证保留与下一次 wait，不能写成已打断。 |
| AC-CORE-08 | 服务重启后消息保留，重连只补允许积压 | `C-CORE`、`C-HOST`；`tests/t5-restart-http.test.ts`、`tests/t5-restart-recovery.test.ts` | NOT_RUN | 同数据重启，读回消息、ACK/游标和身份；不把旧连接标记当在线证明。 |
| AC-CORE-09 | 连续对话有界，manager 不唤醒自己 | `C-CORE`；`tests/antiloop.test.ts`、`tests/antiloop-mcp.test.ts` | NOT_RUN | 验证阈值、持久消息与抑制事实；计数重启重置是已有边界。 |
| AC-CORE-10 | 记录真实双宿主等待/打断和空闲唤醒限制 | `C-HOST`；`H-HOST`、`H-DSH`；[接入支持表](getting-started-mcp.md#1-先决条件与宿主支持范围) | NOT_RUN | 用户文档静态已核对；最终记录须保留适用版本和历史证据影响分析。 |
| AC-CORE-11 | 人 + 两真实 Agent 双向 @、等待、断开和重连 | `C-HOST`；`C-CORE` 作协议回归；历史 `H-HOST` | NOT_RUN | 未把历史完整链推广成本候选 PASS；保留对应消息和新会话结果。 |

### 3.2 项目、组织、身份、生命周期、状态与权限：15 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-PROJ-01 | 多项目的消息、任务、记忆隔离 | `C-DB`、`C-TASK`、`C-MEM`、`C-UI`；`tests/project-lifecycle.test.ts`、`tests/tasks-http.test.ts`、`tests/memory-service.test.ts` | NOT_RUN | 同候选组合验证，不能仅看列表隐藏或阶段 2 消息测试。 |
| AC-PROJ-02 | 多群、参与者来自项目成员、同人多群 | `C-CORE`、`C-UI`；`tests/projects-api.test.ts`、`tests/project-lifecycle.test.ts` | NOT_RUN | 验证跨项目成员引用拒绝、群各自消息顺序和历史。 |
| AC-PROJ-03 | 人/顶层 manager 建群；下级 manager 限子树 | `C-DB`；`tests/org-authz.test.ts`、`tests/authorize-guard.test.ts`、`tests/projects-api.test.ts` | NOT_RUN | 同时测允许与拒绝路径，不能用本地 owner 请求代替下级 actor。 |
| AC-ORG-01 | 多层树与顶层/子树管理边界 | `C-DB`、`C-UI`；`tests/org-tree.test.ts`、`tests/org-authz.test.ts`、`tests/org-mutations.test.ts` | NOT_RUN | 核对真实角色、树变更和最终组织页面。 |
| AC-ORG-02 | 组织/汇报线修改生效，人可撤销且有审计 | `C-DB`、`C-UI`；`tests/org-mutations.test.ts`、`tests/audit-compensation.test.ts` | NOT_RUN | 包含删除岗位的边/占岗恢复、重复撤销、冲突和审计失败零提交。 |
| AC-ORG-03 | WebUI 配角色、自动落位、人调整 | `C-UI`；`tests/org-tree.test.ts`、`tests/audit-compensation.test.ts`、`tests/management-ui.test.ts` | NOT_RUN | 验证真实落位与后续调整；静态按钮存在不足以通过。 |
| AC-ORG-04 | 顶层 manager 添加/移除/暂停成员，无人确认；人可撤销 | `C-DB`；`tests/member-lifecycle.test.ts`、`tests/member-compensation.test.ts`、`tests/mcp-lifecycle-scope.test.ts` | NOT_RUN | 包含 v13 墓碑/加入代际、作者保留、显式重新添加及旧会话拒绝；补生产入口与 UI。 |
| AC-ORG-05 | 独立 Agent 承担岗位，同项目一人一岗 | `C-DB`；`tests/org-tree.test.ts`、`tests/project-lifecycle.test.ts`、`tests/repositories.test.ts` | NOT_RUN | 验证唯一约束与跨项目不同 Member；托管 profile 仍不开放。 |
| AC-ORG-06 | 人独立/协作创建组织，确认角色、调整岗位 | `C-UI`；`tests/org-authz.test.ts`、`tests/org-mutations.test.ts`、`tests/management-ui.test.ts` | NOT_RUN | 保存创建、角色选择和人调整的实际结果；不把提示性 join role 当角色授权。 |
| AC-ORG-07 | 下级 manager 的参与群正常，纯子树群只读；顶层/人全可见 | `C-DB`；`tests/org-authz.test.ts`、`tests/authorize-mcp.test.ts`、`tests/mcp-context.test.ts` | NOT_RUN | 同时验证 list/history 可见、post/wake 拒绝与上下文不泄露。 |
| AC-IDENT-01 | 同 Agent 跨项目独立岗位/记忆，历史受参与范围约束 | `C-DB`、`C-MEM`；`tests/project-lifecycle.test.ts`、`tests/memory-service.test.ts`、`tests/tasks-service.test.ts` | NOT_RUN | 验证全局本人记忆与项目文档分离；任务关联不扩大跨群权限。 |
| AC-LIFE-01 | 归档可恢复；人二次确认永久删除，manager 不可删除 | `C-DB`、`C-UI`；`tests/project-lifecycle.test.ts`、`tests/management-ui.test.ts` | NOT_RUN | 验证两次确认与实际删除；归档后的 task/memory 写必须拒绝。 |
| AC-LIFE-02 | 项目清其群/任务/评论/记忆；删群保留项目任务/文档 | `C-DB`；`tests/project-lifecycle.test.ts`、`tests/tasks-repository.test.ts`、`tests/memory-repository.test.ts`、`tests/member-facts.test.ts` | NOT_RUN | 新表/来源/通知级联逐键核对；删群只清关联与群上下文资料，Agent global 保留。 |
| AC-STATUS-01 | 在线/离线/等待/工作与断线/陈旧明确 | `C-CORE`、`C-UI`；`tests/status-domain.test.ts`、`tests/status-ws.test.ts`、`tests/status-ui.test.ts` | NOT_RUN | 验证迟到快照、切项目/身份和网络恢复，不能只看截图。 |
| AC-PERM-01 | owner/top/sub/member 矩阵，所有未授权操作拒绝 | `C-DB`、`C-TASK`、`C-MEM`、`C-MANAGED`；`tests/authorize-guard.test.ts`、`tests/org-authz.test.ts`、`tests/settings-http.test.ts` | NOT_RUN | 包含 HTTP/MCP 元数据、错误、历史版本、managed fence；global 对人也不开放。 |

### 3.3 任务与评审：8 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-TASK-01 | 完整任务字段，指派负责人/reviewer | `C-TASK`、`C-UI`；`tests/tasks-input.test.ts`、`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | NOT_RUN | 保存输入、API 读回及详情；空 repo/fixed point 不冒充有效评审候选。 |
| AC-TASK-02 | 人/manager 创建指派、成员评论、负责人流转、越权改派拒绝 | `C-DB`、`C-TASK`；`tests/tasks-authz.test.ts`、`tests/tasks-http.test.ts`、`tests/tasks-mcp.test.ts` | NOT_RUN | 各主体及子树实际调用，修订冲突不自动重试覆盖。 |
| AC-TASK-03 | 五状态与 blocked 沿汇报线升级 | `C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | NOT_RUN | 空岗跳过，无接收人保留 unresolved；工作 ACK 不推进任务状态。 |
| AC-REVIEW-01 | 明确默认 reviewer、真实固定 diff；无效/空候选前置失败 | `C-TASK`；`tests/tasks-candidate.test.ts`、`tests/tasks-service.test.ts` | NOT_RUN | 测失败 round 可诊断、候选干净和采集中权限/修订变化；不能截断后通过。 |
| AC-REVIEW-02 | Spec/Standards 两报告独立，进入评论，不跨轴排名 | `C-DB`、`C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | NOT_RUN | 这里只覆盖合同/持久化/UI；真实隔离并行模型执行另归 REVIEW-04。 |
| AC-REVIEW-03 | reviewer 通过到 done、打回进行中、manager 有原因覆盖 | `C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/tasks-mcp.test.ts` | NOT_RUN | 原报告/原裁决与 override 原因保留；报告不全不能普通通过。 |
| AC-REVIEW-04 | Claude 或 Codex 完成真实任务双轴评审，命令/版本/fixed point 可追溯 | `C-REVIEW`；环境记录 `B-NATIVE` | BLOCKED | Codex 在模型前初始化失败；需正常原生环境、真实并行隔离上下文及平台裁决读回。 |
| AC-REVIEW-05 | 报告保留标准来源、任务要求、结论与证据 | `C-TASK`、`C-UI`；`tests/tasks-input.test.ts`、`tests/tasks-service.test.ts`；[报告流程](tasks-and-review.md) | NOT_RUN | 区分声明字段校验与真实外部证据；实际报告还需来源可读、绑定同一候选。 |

### 3.4 记忆：7 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-MEM-01 | global 仅本体 Agent 读写、跨项目本人注入 | `C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-mcp.test.ts`、`tests/memory-injection.test.ts` | NOT_RUN | 其他 Agent、owner、manager 连存在性/历史也不能窥探；HTTP 无 global 入口。 |
| AC-MEM-02 | 共享文档成员读、manager/人写、显式拉取 | `C-MEM`、`C-UI`；`tests/memory-http.test.ts`、`tests/memory-service.test.ts` | NOT_RUN | 验证实时 ACL、列表/历史同边界、归档只读，不能把 shared 自动注入。 |
| AC-MEM-03 | project-agent 本人/授权管理者可读写、本人项目内注入 | `C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-reader.test.ts`、`tests/memory-mcp.test.ts` | NOT_RUN | 子树与失活/已移除目标文档维护分别核对；读取期间撤权也不能附带正文。 |
| AC-MEM-04 | 三种真实触发自总结、新版本、人工优先 | `C-MEM`、`C-SELF-SUMMARY`；`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts`；`B-NATIVE` | BLOCKED | 协议夹具可验证触发/CAS，真实目标模型尚缺；N 计数只能来自首次真实 MCP 投递。 |
| AC-MEM-05 | 执行中人工编辑、版本历史可查 | `C-MEM`、`C-UI`；`tests/memory-http.test.ts`、`tests/memory-ui.test.ts`、`tests/memory-summary.test.ts` | NOT_RUN | 409 保留草稿、显式采用新基准、迟到响应隔离；两自动结果竞争不覆盖胜者。 |
| AC-MEM-06 | 普通 Agent 不能经记忆/聊天读取未参与群消息 | `C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts` | NOT_RUN | 检查 packet 输入、任务关联、不可见前缀分页与退群后权限；不能只验证页面无入口。 |
| AC-MEM-07 | 总结失败不阻断主流程，有可诊断状态 | `C-MEM`、`C-DB`；`tests/memory-mcp-postgres.test.ts`、`tests/memory-reader.test.ts`、`tests/memory-runtime.test.ts`、`tests/memory-stdio.test.ts` | NOT_RUN | 需真实 reader/PG 阻塞、超时终止、回滚、ACK 后补偿与 EOF 清理；延时 Promise 不是独立资源证据。 |

### 3.5 收尾：5 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-HARD-01 | 自动化覆盖 mention/权限/状态/记忆/隔离 | `C-BASE`、`C-DB`、`C-CORE`、`C-TASK`、`C-MEM`；各域测试见前表 | NOT_RUN | 绑定最终 commit/tree，保留全部 skip/fail；不得把多个旧候选拼成全绿。 |
| AC-HARD-02 | 重启、断线、MCP 超时、无效 ref 等故障 | `C-CORE`、`C-TASK`、`C-MEM`、`C-DB`；§4 故障矩阵 | NOT_RUN | 区分产品错误、环境不可用和未执行；模型失败不能记成模型成功路径。 |
| AC-HARD-03 | 跨项目/群隔离与未授权读拒绝 | `C-DB`、`C-TASK`、`C-MEM`、`C-UI`；`tests/current-project-ui.test.ts`、`tests/domain-mutation-scope.test.ts`、`tests/mcp-lifecycle-scope.test.ts` | NOT_RUN | 数据、领域、HTTP/MCP、浏览器四层分别取证；含切项目旧请求/草稿和旧加入代际。 |
| AC-HARD-04 | 可复现安装/启动/三宿主配置和限制说明 | `C-INSTALL`、`C-HOST`；[接入](getting-started-mcp.md)、[任务](tasks-and-review.md)、[记忆](memory.md)、[设置与审计](settings-and-audit.md) | NOT_RUN | 文档静态核对不替代干净安装；macOS 主环境结果不能由 Linux 自动推出。 |
| AC-HARD-05 | 全部 V1 AC 通过，或有明确有效例外 | 完整本索引 + 独立需求/标准审查 + 最终 PR/主线结果 | BLOCKED | REVIEW-04、MEM-04 尚无本轮真实证据，其他最终检查未齐；没有新豁免，#83 例外不能扩用。 |

## 4. 横切故障、负载与迁移门禁

这些门禁补充 46 项映射，不新增或缩减主 Spec AC。

| 范围 | 当前入口 / 必须观察的结果 | 本版状态与缺口 |
| --- | --- | --- |
| 重启、断开、MCP 超时 | `C-CORE`；`tests/mcp-http.test.ts`、`tests/t5-restart-http.test.ts`、`tests/mcp-lifecycle-scope.test.ts`；消息/游标持久化，旧会话不能越过加入代际，新会话权限正确 | NOT_RUN：最终组合待运行。 |
| 写入/审计/补偿失败 | `tests/api-mutation-atomic.test.ts`、`tests/org-mutations.test.ts`、`tests/member-compensation.test.ts`、`tests/audit-compensation.test.ts`；整笔回滚，后续修改导致安全冲突，不部分复原 | NOT_RUN：SQLite 与真实 PG 分列。 |
| 无效/空/脏 Git 候选与外部程序 | `tests/tasks-candidate.test.ts`、`tests/tasks-service.test.ts`；失败轮次可读，10 秒/2 MiB/200 commits 预算，不运行 hooks/filter/外部 diff 或懒拉取 | NOT_RUN：保留实际 canary 和退出结果。 |
| 记忆 reader 真阻塞与关闭 | `tests/memory-reader.test.ts`、`tests/memory-mcp-postgres.test.ts`、`tests/memory-runtime.test.ts`、`tests/memory-stdio.test.ts`；独立只读进程、超时有界、消息/ACK/status 可用、真实事务回滚 | NOT_RUN：PG 表锁证据不可由 SQLite 或模拟延时替代。 |
| 触发与请求恢复 | `tests/memory-mcp.test.ts`、`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts`；首次 MCP 投递、不可见前缀 raw cursor、持久 checkpoint、已 ACK 任务事件的补建、来源重开取消 | NOT_RUN：人工优先与失败恢复协议不等于真实模型完成。 |
| 非空 v12 → v13 | `tests/member-facts.test.ts`；历史作者保留、六类事实版本基准/trigger、旧 checksum 不变、移除代际单调 | NOT_RUN：最终 SQLite/PG 均需实际运行。 |
| v13 ↔ v13 数据复制与回滚 | `tests/migrate-data.test.ts`、[迁移 CLI](../scripts/migrate-data.ts)；tasks/memory/receipts/checkpoints/投递/审计/removed/事实版本逐键核对，事实版本最后复制，回滚只处理目标 | NOT_RUN：独立目标库；源数据与凭据不变。 |
| NFR-03 时序 | 真实待收消息的 MCP Agent ≤2 秒收到；WebUI ≤1 秒展示。记录发送、wait 返回、DOM 可见单调时间与精确 message ID；并发补偿期间也测 | NOT_RUN：后续时序脚本/命令待冻结。现 `tests/t8-human-wake.test.ts` 只验证 5 秒等待返回消息，不能独自证明 2 秒；截图不能证明 1 秒。 |
| NFR-04 固定负载 | 3 并发 Agent、5 项目、每项目至多 5 群、每群 3 参与者、1000 条消息；明确每组实际计数。另列 10k 历史/大正文压力样本和 remove/undo 逐次 SQL 行数、字节与耗时 | NOT_RUN：后续负载命令待冻结；不同数据量不混成一个结论。 |
| NFR-07 平台 | 记录真实 OS/架构；macOS 是产品首要环境 | NOT_RUN：本次文档核对只有 Linux 信息，不外推 macOS 产品验收。 |

## 5. 真实模型阻塞与历史材料

### B-NATIVE：本轮原生模型环境

2026-11-11 01:17:37–01:19:23 UTC 的只读恢复核查记录：`/opt/codex/bin/codex --version` 返回 `codex-cli 0.167.0-alpha.4`，登录状态可读；继承的 Codex 运行目录仍是只读挂载。此前最小原生调用在模型前退出 1，错误为 `failed to initialize in-process app-server client: Read-only file system (os error 30)`，没有模型 JSONL。环境未改变，恢复核查未重复同一模型探测。

该事实的范围是环境阻塞：版本/登录读取成功不是任务评审或自总结成功。详细记录为交付记录中的 `native-cli-resume-check.md`，关联 [Spec #109](https://github.com/gbcdby/boardroom/issues/109) / [Ticket #112](https://github.com/gbcdby/boardroom/issues/112)；原始本地材料需随最终验收归档为可读取产物，不能只保留机器上的绝对路径。

解除条件是正常的原生模型运行环境，然后分别完成 `C-REVIEW` 和 `C-SELF-SUMMARY`。仅修复 CLI 启动、验证登录或换成预制报告都不足以通过。不得复制凭据、改运行目录以绕过只读挂载，或把 SDK/托管旧例外改名为真实模型证据。

### 历史背景清单

| evidence ID | 对象与日期 | 来源 | relation / 可复用范围 |
| --- | --- | --- | --- |
| H-HOST | 2026-11-03，Claude Code 2.1.233、Codex CLI 0.166.0、Node v24.14.0，阶段 1 外部 Streamable HTTP | [T8 历史报告](t8-acceptance-report.md) | background：join、活跃等待、双向 @、重连能力的旧记录。原始输出部分只在当时本地留档；不是当前 commit、当前 CLI 或真实任务/记忆验收。 |
| H-DSH | 2026-11-03，DSH 0.2.1-rc.5、Node v24.14.0，当时 `hostType=other` | [随库索引](../evidence/real-host-retest/README.md)、[join](../evidence/real-host-retest/dsh-join.out)、[wait](../evidence/real-host-retest/dsh-wait.out) | background：仅 join 与活跃 wait。当前已注册 `dsh`；reconnect、空闲唤醒、在途打断仍 unsupported，不扩大旧输出含义。 |
| H-MANAGED | 可选托管运行时的既有独立交付 | [Spec #83](https://github.com/gbcdby/boardroom/issues/83)、[README 支持边界](../README.md#可选托管-agent-运行时) | background：只在原批准对象与范围内有效；支持表为空，不能代替 REVIEW-04/MEM-04。 |

历史证据若用于本轮结论，需记录新旧候选差异、受影响权限/协议/宿主路径、哪些结论仍适用、哪些要重跑。主架构 §8 的 DSH 历史注释与 §10.2 的保守声明存在旧文字差异；本索引采用随库证据与当前适配器的实际边界，不因此修改主 Spec 要求。T8 原报告的日期、对象和结论保持原样。

## 6. 最终交付应补齐什么

1. 冻结整合候选的 commit/tree/dirty manifest，运行必要的 SQLite、真实 PG、协议、浏览器、安装与负载时序检查；为每项 AC 关联实际环境、时间、命令和可读产物。
2. 真实宿主历史证据经影响分析后决定必要复验；REVIEW-04 和 MEM-04 保持独立真实模型门槛。环境仍阻塞时记录阻塞与下一动作，不能宣称 HARD-05 通过。
3. 需求轴与标准轴由独立审查者审同一候选。修正后只复验实际受影响范围，保留旧报告的对象身份。
4. 将 PR CI 与实际合并、合并后主线复验分别记录。PR 已合并不等于 V1 全项验收，也不表示已部署。

本版没有新增验收例外。若随后有明确授权的例外，逐项保存 `acceptanceIds / reason / exactScope / knownRisk / followUp / acceptanceAuthority / date`；不能只写“已知问题”或把旧例外扩大范围。

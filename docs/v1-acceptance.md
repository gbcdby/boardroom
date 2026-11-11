# V1 验收证据索引

状态：工程候选验收已取证；V1 整体仍为 BLOCKED
日期：2026-11-11
范围：[主 Spec #1](https://github.com/gbcdby/boardroom/issues/1)、[阶段 5 Spec #109](https://github.com/gbcdby/boardroom/issues/109)、[Ticket #112](https://github.com/gbcdby/boardroom/issues/112)。验收要求取自[产品基线 §8](architecture/agent-studio.md#8-产品验收基线)。

**本索引包含全部 46 个 V1 验收项：37 项 PASS、6 项 NOT_RUN、3 项 BLOCKED。** 固定工程候选的真实 PostgreSQL、协议、安装重启、Chromium 和负载检查已经通过；尚缺的 6 项真实宿主 Core 验收，以及 REVIEW-04、MEM-04 和整体 HARD-05，均未以 SDK、合成报告或历史记录代替。macOS 首要平台验收 NFR-07 另记 `NOT_RUN`，因此本索引不宣告 V1 全项通过。

## 1. 候选与记录口径

本轮产品代码候选为 `4f1b5ebfd61eb2fc9f5d9da89a211e43b47ceaee`，tree 为 `5729fea69cb1a9e8c7c1f86dd65ff02023d1e8b3`；同树远端提交为 [`6c8f400bb63d2c6a4beb96a4d2afab0098ae4d1c`](https://github.com/gbcdby/boardroom/commit/6c8f400bb63d2c6a4beb96a4d2afab0098ae4d1c)。[CI 42959198409](https://github.com/gbcdby/boardroom/actions/runs/42959198409) 实际检出的 merge commit 为 `10797d3450a648d2868d9c7745db6c3dc9243477`，tree 与上述产品代码候选一致。不同 commit 身份保留在此，不能因 tree 相同而省略实际运行对象。

本文是工程候选之后的**纯文档增量**；它记录该工程候选的证据，不要求把本文自己的 commit 再填回本文形成递归绑定。产品代码变更需要重新判断证据有效范围；仅更新索引不能把未执行项变为通过。工程候选与后续文档的交付、独立审查及合并状态以 [PR #119 当前记录](https://github.com/gbcdby/boardroom/pull/119)为准；本文不据 CI 成功宣告已经合并、完成主线复验或部署。

每个 AC 记录由下表共同字段、命令目录、§2.1 证据组和该 AC 行合并得到。状态按该项完整范围判断；同组的自动化检查通过，也不代表未启动的真实宿主通过。

| 字段 | 本版值与填写规则 |
| --- | --- |
| `acceptanceId` | 每行唯一 AC ID，与产品基线的 46 项一一对应。 |
| `candidateCommit` / `tree` | 工程候选、远端同树提交和 CI 实际 merge commit 如上；共同 tree 为 `5729fea69cb1a9e8c7c1f86dd65ff02023d1e8b3`。历史证据另列对象，不能拼接为本候选结果。 |
| `dirtyManifest` | 工程 CI 为 `[]`：双数据库安装报告 `worktree: ""`，浏览器负载报告 `dirty: false`。本文工作树从工程候选干净检出，后续增量仅此文件。 |
| `command` | 每行列出的命令组及指定测试/场景；正式结果保存真实 argv、工作目录、退出码。命令存在不代表已执行。 |
| `environment` | CI：Ubuntu 24.04 runner，Linux `7.0.0-1017-azure x86_64`，Node `v24.22.2`，npm `11.19.1`，PostgreSQL `16.15`；SQLite 使用锁定依赖 `better-sqlite3 13.0.3`，报告未单列 SQLite 内核版本。Chromium `151.0.7922.34` / Playwright `1.62.0`。本地补充检查为 Linux、Node v24.22.1、npm 11.9.0；原生 CLI 环境独立见 `B-NATIVE`。 |
| `observedAt` | 2026-11-11 UTC：CI 干净安装始于 04:26:27，全量测试于 04:31:46 完成，独立负载于 04:32:11 完成，协议/安装于 04:32:51 完成；页面/DOM 时间见证据组。日志包含更精确的各步骤时间。 |
| `status` | 只用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。测试工具的 SKIP 是该范围未验证，不是 PASS。静态检查另标 OBSERVED。 |
| `evidence` | `E-*` 为本候选证据；`B-NATIVE` 为环境阻塞；`H-*` 仅历史背景。报告通过数量、跳过项及合成模型边界都保留。 |
| `limitation` / `nextAction` | 每行末列明确尚缺范围与下一步。模型环境阻塞详见 §5；不能用协议夹具替代。 |

数据库、HTTP/MCP、真实浏览器、真实宿主模型分别记录。一次 SDK 调用只证明该协议路径；`reviewer-declared` / `agent-declared` 元数据只证明声明被校验和保存。消息入库、进入模型上下文、开始模型轮次和成功完成任务是不同事实。

46 项分为：可由当前工程行为验收的 **36 项**、要求实际宿主或模型的 **8 项**（CORE-02/03/05/07/10/11、REVIEW-04、MEM-04）、安装与文档 **1 项**（HARD-04），以及整体完成条件 **1 项**（HARD-05）。CORE-03 的页面操作、CORE-07 的可靠投递回退、CORE-10 的支持表即使已有协议或文档证据，也不能单独通过其真实宿主范围。macOS 属于横切 NFR-07，单列状态，不增加第 47 个 AC。

交付负责人已冻结同一产品候选的独立两轴结论，完整报告随 [PR #119](https://github.com/gbcdby/boardroom/pull/119) 保存：需求轴工程符合性 PASS、完整需求 INCONCLUSIVE / 工作 BLOCKED，REQ001–006 已验证，报告 SHA-256 `e37294fb6d1cb5b4232be53adeae478cb579be5b0433ab7fdc456d48412acf68`；标准轴代码 PASS，STD001–005 已验证，报告 SHA-256 `14177f291efaf305b3e97d962725e59e73772ba7b90c2603c49e8fdb7b80af9e`。这些是产品候选的独立结论；本文为作者整理的证据索引，后续纯文档增量仍随 PR 检查。

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

`C-INSTALL` 的生产 smoke 自动化入口为 `node scripts/e2e-install.mjs`，使用实际 `npm start/prestart`、独立临时配置/data、可选 PG 新 schema，检查 HTTP、32 个 MCP 工具、实际消息/ACK、正常关闭与同数据重启。数据库选择沿用 `AGENT_STUDIO_DB_DRIVER` + `AGENT_STUDIO_PG_CONNECTION_STRING`，原始报告为 `.agent-output/install-e2e/{sqlite,postgres}.json`，本轮结果为 `E-INSTALL`。干净检出的 `npm ci` 由安装环境/CI 单独记录，不由脚本伪造。

### 2.1 本轮证据组

共同 CI 为 [42959198409](https://github.com/gbcdby/boardroom/actions/runs/42959198409)，数据库 job [130321417993](https://github.com/gbcdby/boardroom/actions/runs/42959198409/job/130321417993) 与浏览器 job [130321418111](https://github.com/gbcdby/boardroom/actions/runs/42959198409/job/130321418111) 均为 SUCCESS。下表结果已回读完整日志和下载的 JSON 报告；artifact 的存在本身不是通过依据。命令与产物归属可对照 [CI 配置](../.github/workflows/database-ci.yml)。

| evidence ID | 实际入口与产物 | 本轮结果及边界 |
| --- | --- | --- |
| `E-LOCAL` | 工程候选的 `npm test` / `npm run typecheck`；交付记录 `phase5-full-final-delta.log`、`phase5-types-final-delta.log` | 已回读：1006 项，820 PASS、186 SKIP、0 FAIL，双类型检查退出 0。未配置真实 PG 的本地跳过项不作 PG 证据。 |
| `E-BASE` | 数据库 job：`npm ci`、`C-BASE` 与启用 PG 的 `C-DB`；完整 job 日志 | PASS：干净安装、双类型、构建通过；1006 项中 975 PASS、31 SKIP、0 FAIL。真实 PG 故障/锁序/预算/迁移已执行；跳过范围下述单列。 |
| `E-CORE` | 数据库 job：SQLite / PostgreSQL 分别 `C-CORE`，完整 SDK 端到端日志 | PASS：两数据库各 29/29，0 失败；日志明确为“协议范围”。不能通过真实宿主 CORE-02/03/05/07/10/11。 |
| `E-TASK` | [`tasks-protocol-1`](https://github.com/gbcdby/boardroom/actions/runs/42959198409/artifacts/13828533293)：源目录 `tasks-e2e/`，artifact 内 `{sqlite,postgres}.json` | PASS：两数据库各 8/8；`applicationCommit/applicationTree` 与 §1 一致。`realModelReview: NOT_RUN`，synthetic 两轴输出不放行 REVIEW-04。 |
| `E-MEM` | [`memory-protocol-1`](https://github.com/gbcdby/boardroom/actions/runs/42959198409/artifacts/13828038834)：源目录 `memory-e2e/`，artifact 内 `{sqlite,postgres}.json` | PASS：两数据库各 6/6；候选身份一致。`realModelSummary: NOT_RUN`，真实 MCP 投递与真实模型总结分别判断。 |
| `E-UI` | [`managed-web-browser-1`](https://github.com/gbcdby/boardroom/actions/runs/42959198409/artifacts/13828741463)：`{managed-web,webui,tasks-web,memory-web,settings-web}-e2e/report.json` 及截图 | PASS：2026-11-11T04:27:14Z–04:28:39Z 完成 5 份页面报告。真实 Chromium + 临时 SQLite；任务/总结正文为 synthetic，`modelInvocation: NOT_RUN`。`webui-before` 仅基线截图。 |
| `E-INSTALL` | [`install-1`](https://github.com/gbcdby/boardroom/actions/runs/42959198409/artifacts/13827779328)：源目录 `install-e2e/`，artifact 内仅 `{sqlite,postgres}.json`；启动/关闭结果见 JSON 的 `checks/starts`，同次执行日志见数据库 job | PASS：两数据库实际 `npm start/prestart`、5 个已构建页面深链、32 个 MCP 工具、真实消息/ACK、正常停止与相同数据/配置重启；各 5 项检查，无错误。04:32:36Z–04:32:51Z；不外推原生 CLI 或 macOS。 |
| `E-LOAD-SQL` | [`lifecycle-load-1`](https://github.com/gbcdby/boardroom/actions/runs/42959198409/artifacts/13829250025)：源目录 `lifecycle-load/`，artifact 内 `{sqlite,postgres,sqlite-unmentioned-history,postgres-unmentioned-history}.json` | PASS：4/4 用例；两数据库 × 已 ACK/未 mention 两类历史 × 两档消息 × 6 次翻转，共 48 次独立记录。实际 SQL/返回行/字节/预算/消息/心跳/ACK；归属由同一 job 检出日志固定，独立于 DOM。 |
| `E-LOAD-WEB` | 同一浏览器 artifact：`v1-load-web/{sqlite,postgres}/report.json` 与 1000/10000 档原始报告 | PASS：2026-11-11T04:28:45Z–04:29:20Z，两数据库 × 两档历史 × 每档 6 次，共 24 轮。真实 HTTP/MCP 与 Chromium 并发补偿时序；SQL/返回量预算仍由 `E-LOAD-SQL` 独立证明。 |

CI artifact 的保存期限为 7 天。最终交付记录应保留可读取的报告或下载归档引用；本索引不把机器上的临时绝对路径当作长期公开证据。

`E-BASE` 的 **31 个 SKIP 全部来自可选托管运行时的真实隔离检查**：30 个 R3（含 5 个嵌套挂载场景）及 1 个 R6 gateway 停止场景，缺少已核实的 bwrap 0.12.0 / mount、net namespace 原语，涉及真实挂载/身份/权限、别名与硬链接 canary、隔离 gateway 停止及进程恢复归属。它们不是 PostgreSQL 用例跳过，也没有被算作 PASS；生产原生托管 profile 仍按 unsupported 声明。该环境限制与 `B-NATIVE` 的 Codex 运行目录只读是两个独立事实，不能混为已执行模型。

下载归档的 SHA-256 已逐个核对：

| artifact | SHA-256 |
| --- | --- |
| `lifecycle-load-1` | `4236b75f60f62000f7e009025d7fab33b69e025fdc84d77e95469053bddaffb1` |
| `tasks-protocol-1` | `619bf88e2e69a162abb7667233cccc99381ec0b6f93bb92327c601fe30217c7a` |
| `memory-protocol-1` | `7beee3988d135cd2c83d9d2f669932bec02934b70d848f3f2e3e4e79c43110f5` |
| `install-1` | `185c989fff7ab5d83978906018fbed37e201630d0c7bdae805a4dd8d5a823530` |

浏览器归档 ZIP 的 SHA-256 为 `b7e3dbc090ee0da6ec83f518af3c36dc092be80414f050e97957710bc2022d75`。报告记录 Chromium `151.0.7922.34`、Playwright `1.62.0`、Linux `7.0.0-1017-azure x86_64`、Node `v24.22.2`；负载报告的实际 commit/tree 与 §1 一致，`dirty: false`。工作台 32 个布局/10 项交互、任务 8/6、记忆 11/7、设置 8/5、托管页面 4/10 均通过；记忆 30 项、设置 36 项文字对比度检查达到 4.5。1440/768/390 视口、浅深色、键盘焦点、409 草稿保留、切项目迟到响应、只读设置失败恢复等实际范围以各报告的逐项 `checks` 为准。

`E-LOAD-WEB` 下表给出各档 6 轮的最大值，便于核对量级；判据仍是**每轮单独通过**，不是平均值或总耗时。完整报告保留 message ID、发送/wait/ACK/heartbeat/DOM 单调时间、实际历史数量与正文哈希、每轮 errors 和清理结果。浏览器运行不启动真实原生模型。

| 数据库 | 历史消息档 | 通过轮数 | 最大 mutation | 最大 MCP wait | 最大 DOM 可见 |
| --- | --- | --- | --- | --- | --- |
| SQLite | 1000 | 6/6 | 40.794 ms | 67.207 ms | 79.1 ms |
| SQLite | 10000 | 6/6 | 51.525 ms | 78.025 ms | 83.5 ms |
| PostgreSQL | 1000 | 6/6 | 100.182 ms | 242.288 ms | 216.2 ms |
| PostgreSQL | 10000 | 6/6 | 94.437 ms | 282.547 ms | 226.3 ms |

以上各轮分别满足 mutation ≤500 ms、MCP ≤2000 ms、DOM ≤1000 ms。SQL 资源证据来自独立的 `E-LOAD-SQL`：固定 3 个 Agent、5 项目、25 群、每群 3 参与者；已 ACK 历史的 1000/10000 档含 3000/30000 条投递记录，10000 档正文约 6.59 MB；另有未 mention 历史的约 30.14 MB 正文压力样本。补偿查询不扫描消息或投递历史，逐次 SQL 101–122 条、返回 77–90 行、返回行 JSON 的 UTF-8 表示最多 14743 字节；SQL 数包含 RepoCtx 与 coordinator，排除驱动 BEGIN/COMMIT/SAVEPOINT 控制语句，字节数不是网络线上的传输字节。

48 次数据库资源记录中，最大 mutation 204.084 ms、消息投递 339.158 ms、发送至 ACK 369.655 ms、heartbeat 205.771 ms；每次均单独验限。不同数据库、历史类型、数据量和 HTTP/DOM 场景仍分别保存原始记录，不能将这些最大值当作跨平台性能承诺。

## 3. 全部 46 项映射

表中的文件均为当前工程候选存在的入口；`E-*` 指向本轮运行，`C-*` 给出复现命令。每行 `status` 针对该 AC 的完整要求；测试名称里出现 AC 编号或旧报告写“通过”不会改变该状态。

### 3.1 通信核心：11 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-CORE-01 | localhost 启动、真实 PG 初始化/连接、WebUI 可访问 | `E-BASE/E-INSTALL/E-UI`；`C-INSTALL`、`C-DB`、`C-UI`；`tests/http.test.ts`、`tests/postgres-smoke.test.ts`、`tests/settings-server.test.ts` | PASS | 真实 PG 初始化、服务生产入口与 Chromium 页面均已执行；原阶段 1 SQLite 记录不用于替代本次 PG 要求。 |
| AC-CORE-02 | Claude Code、Codex CLI 各经 MCP 入群，无 wrapper、无需自动入群 | `B-NATIVE/H-HOST`；`C-HOST`；历史 `H-HOST` 仅背景 | NOT_RUN | 做宿主/绑定/权限变化影响分析，必要真实复验；SDK `hostType` 字符串不能充当宿主。 |
| AC-CORE-03 | 人在 WebUI 建项目/群，两个 Agent 加入并在线 | `E-CORE/E-UI（部分）`；`C-CORE`、`C-UI`；`tests/projects-api.test.ts`、`tests/webui-e2e.test.ts` | NOT_RUN | 工程证据只覆盖页面建项目/群和 SDK 在线状态；本项仍需两真实宿主在该候选入同群并在线。 |
| AC-CORE-04 | 普通成员只被 @；manager 被其他成员消息唤醒 | `E-BASE/E-CORE`；`C-CORE`；`tests/chat-routing.test.ts`、`tests/chat-routing-mcp.test.ts`、`tests/t8-human-wake.test.ts` | PASS | 实际参与关系、定向投递、manager 接收他人消息及发送者不自唤醒通过；进入模型轮次仍须宿主证据。 |
| AC-CORE-05 | 真实双宿主中 @单人/多人/全体正确，@all 只展开当时在线参与者 | `E-CORE（部分）/H-HOST`；`C-HOST`、`C-CORE`；`tests/chat-routing.test.ts`、`tests/t5-restart-recovery.test.ts` | NOT_RUN | `H-HOST` 仅旧对象；离线普通成员不因 @all 新增补投资格。 |
| AC-CORE-06 | 等待显示 waiting，处理显示 working | `E-BASE/E-CORE/E-UI`；`C-CORE`、`C-UI`；`tests/status-domain.test.ts`、`tests/status-heartbeat-http.test.ts`、`tests/status-ws.test.ts` | PASS | HTTP/WS 与显式 MCP 状态链通过；waiting/working 是平台观察状态，终端画面或 ACK 不证明模型内部状态。 |
| AC-CORE-07 | 忙碌期尽力打断；不支持时保留到安全点 | `E-BASE/E-CORE（部分）`；`C-CORE`；`tests/interrupt-core.test.ts`、`tests/interrupt-mcp.test.ts`、`tests/message-durability.test.ts` | NOT_RUN | 工程证据只覆盖保留与下一次 wait；三宿主在途打断均按 unsupported 声明，真实忙碌宿主的安全点回退仍未复验。 |
| AC-CORE-08 | 服务重启后消息保留，重连只补允许积压 | `E-BASE/E-CORE/E-INSTALL`；`C-CORE`、`C-HOST`；`tests/t5-restart-http.test.ts`、`tests/t5-restart-recovery.test.ts` | PASS | 同数据服务重启与 SDK 重连读回消息、ACK/游标和身份；真实 CLI 重连复验仍在 CORE-11 中单列。 |
| AC-CORE-09 | 连续对话有界，manager 不唤醒自己 | `E-BASE/E-CORE`；`C-CORE`；`tests/antiloop.test.ts`、`tests/antiloop-mcp.test.ts` | PASS | 阈值、持久消息与抑制事实通过；防环计数重启重置是既有边界。 |
| AC-CORE-10 | 记录真实双宿主等待/打断和空闲唤醒限制 | `B-NATIVE/H-HOST/H-DSH`；`C-HOST`；`H-HOST`、`H-DSH`；[接入支持表](getting-started-mcp.md#1-先决条件与宿主支持范围) | NOT_RUN | 支持表及旧版本来源已核对；当前候选与 CLI 的实际等待/打断/空闲限制尚未实测，文档完整不替代该项。 |
| AC-CORE-11 | 人 + 两真实 Agent 双向 @、等待、断开和重连 | `E-CORE（部分）/H-HOST`；`C-HOST`；`C-CORE` 作协议回归；历史 `H-HOST` | NOT_RUN | 未把历史完整链推广成本候选 PASS；保留对应消息和新会话结果。 |

### 3.2 项目、组织、身份、生命周期、状态与权限：15 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-PROJ-01 | 多项目的消息、任务、记忆隔离 | `E-BASE/E-TASK/E-MEM/E-UI`；`C-DB`、`C-TASK`、`C-MEM`、`C-UI`；`tests/project-lifecycle.test.ts`、`tests/tasks-http.test.ts`、`tests/memory-service.test.ts` | PASS | 同候选覆盖消息、任务、记忆及切项目旧请求隔离；服务端拒绝与页面范围均有证据。 |
| AC-PROJ-02 | 多群、参与者来自项目成员、同人多群 | `E-BASE/E-CORE/E-UI`；`C-CORE`、`C-UI`；`tests/projects-api.test.ts`、`tests/project-lifecycle.test.ts` | PASS | 跨项目参与者引用拒绝、多群历史与顺序验证通过；创建与成员选择有实际浏览器操作。 |
| AC-PROJ-03 | 人/顶层 manager 建群；下级 manager 限子树 | `E-BASE`；`C-DB`；`tests/org-authz.test.ts`、`tests/authorize-guard.test.ts`、`tests/projects-api.test.ts` | PASS | owner/top/sub 不同主体的允许与拒绝路径通过；未用 owner 请求代替下级 actor。 |
| AC-ORG-01 | 多层树与顶层/子树管理边界 | `E-BASE/E-UI`；`C-DB`、`C-UI`；`tests/org-tree.test.ts`、`tests/org-authz.test.ts`、`tests/org-mutations.test.ts` | PASS | 树结构、真实角色/子树授权、组织变更与页面交互通过。 |
| AC-ORG-02 | 组织/汇报线修改生效，人可撤销且有审计 | `E-BASE/E-UI`；`C-DB`、`C-UI`；`tests/org-mutations.test.ts`、`tests/audit-compensation.test.ts` | PASS | 删除岗位的边/占岗恢复、重复撤销、后续修改冲突和审计写后失败零提交均通过。 |
| AC-ORG-03 | WebUI 配角色、自动落位、人调整 | `E-BASE/E-UI`；`C-UI`；`tests/org-tree.test.ts`、`tests/audit-compensation.test.ts`、`tests/management-ui.test.ts` | PASS | 角色/落位/人调整的服务与页面测试通过；存在按钮不是此项判据。 |
| AC-ORG-04 | 顶层 manager 添加/移除/暂停成员，无人确认；人可撤销 | `E-BASE/E-UI`；`C-DB`；`tests/member-lifecycle.test.ts`、`tests/member-compensation.test.ts`、`tests/phase5-fault-matrix.test.ts`、`tests/phase5-concurrency-matrix.test.ts`、`tests/mcp-lifecycle-scope.test.ts` | PASS | v13 墓碑/加入代际、作者保留、显式重新添加、旧会话拒绝及完整关系连续补偿通过；旧执行状态不复活。 |
| AC-ORG-05 | 独立 Agent 承担岗位，同项目一人一岗 | `E-BASE`；`C-DB`；`tests/org-tree.test.ts`、`tests/project-lifecycle.test.ts`、`tests/repositories.test.ts` | PASS | 唯一占岗与跨项目独立 Member 验证通过；这不开放尚无支持 profile 的原生托管启动。 |
| AC-ORG-06 | 人独立/协作创建组织，确认角色、调整岗位 | `E-BASE/E-UI`；`C-UI`；`tests/org-authz.test.ts`、`tests/org-mutations.test.ts`、`tests/management-ui.test.ts` | PASS | 创建、角色确认与人调整的授权/持久化/页面行为通过；join 提示性 role 不作为角色授权。 |
| AC-ORG-07 | 下级 manager 的参与群正常，纯子树群只读；顶层/人全可见 | `E-BASE`；`C-DB`；`tests/org-authz.test.ts`、`tests/authorize-mcp.test.ts`、`tests/mcp-context.test.ts` | PASS | 列表/history 可见范围、只读子树 post/wake 拒绝及上下文不泄漏均通过。 |
| AC-IDENT-01 | 同 Agent 跨项目独立岗位/记忆，历史受参与范围约束 | `E-BASE/E-MEM`；`C-DB`、`C-MEM`；`tests/project-lifecycle.test.ts`、`tests/memory-service.test.ts`、`tests/tasks-service.test.ts` | PASS | 同 Agent 的独立项目 Member、本人 global 与项目文档分离、群历史范围通过；任务关联不扩大群权限。 |
| AC-LIFE-01 | 归档可恢复；人二次确认永久删除，manager 不可删除 | `E-BASE/E-UI`；`C-DB`、`C-UI`；`tests/project-lifecycle.test.ts`、`tests/management-ui.test.ts` | PASS | 确认/取消路径与领域永久删除、manager 拒绝、归档后的 task/memory 只读通过。 |
| AC-LIFE-02 | 项目清其群/任务/评论/记忆；删群保留项目任务/文档 | `E-BASE/E-MEM`；`C-DB`；`tests/project-lifecycle.test.ts`、`tests/tasks-repository.test.ts`、`tests/memory-repository.test.ts`、`tests/member-facts.test.ts` | PASS | 新表/来源/通知级联逐键验证通过；删群只清关联与群上下文资料，项目任务/文档和 Agent global 保留。 |
| AC-STATUS-01 | 在线/离线/等待/工作与断线/陈旧明确 | `E-BASE/E-CORE/E-UI`；`C-CORE`、`C-UI`；`tests/status-domain.test.ts`、`tests/status-ws.test.ts`、`tests/status-ui.test.ts` | PASS | 迟到快照、项目/身份切换、陈旧/离线和网络恢复均有行为测试，未仅依据截图。 |
| AC-PERM-01 | owner/top/sub/member 矩阵，所有未授权操作拒绝 | `E-BASE/E-TASK/E-MEM/E-UI`；`C-DB`、`C-TASK`、`C-MEM`、`C-MANAGED`；`tests/authorize-guard.test.ts`、`tests/org-authz.test.ts`、`tests/settings-http.test.ts` | PASS | HTTP/MCP 的列表/元数据/错误/历史/managed fence 权限验证通过；global 对人也不开放；真实隔离 profile 的 31 SKIP 单列于 E-BASE。 |

### 3.3 任务与评审：8 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-TASK-01 | 完整任务字段，指派负责人/reviewer | `E-BASE/E-TASK/E-UI`；`C-TASK`、`C-UI`；`tests/tasks-input.test.ts`、`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | PASS | 真实 UI 保存、HTTP 读回与完整详情一致；空 repo/fixed point 不冒充有效评审候选。 |
| AC-TASK-02 | 人/manager 创建指派、成员评论、负责人流转、越权改派拒绝 | `E-BASE/E-TASK`；`C-DB`、`C-TASK`；`tests/tasks-authz.test.ts`、`tests/tasks-http.test.ts`、`tests/tasks-mcp.test.ts` | PASS | 各主体与子树的真实调用通过；409 不自动重试覆盖，越权改派拒绝。 |
| AC-TASK-03 | 五状态与 blocked 沿汇报线升级 | `E-BASE/E-TASK/E-UI`；`C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | PASS | 五状态与汇报线升级通过；空岗跳过，无接收人保留 unresolved，工作 ACK 不推进任务。 |
| AC-REVIEW-01 | 明确默认 reviewer、真实固定 diff；无效/空候选前置失败 | `E-BASE/E-TASK`；`C-TASK`；`tests/tasks-candidate.test.ts`、`tests/tasks-service.test.ts` | PASS | 真实 Git 固定候选、无效/空/脏候选、采集中权限/修订变化及可诊断失败 round 通过，未截断后接受。 |
| AC-REVIEW-02 | Spec/Standards 两报告独立，进入评论，不跨轴排名 | `E-BASE/E-TASK/E-UI`；`C-DB`、`C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/task-ui.test.ts` | PASS | 合同、持久化、评论和 UI 两轴分开呈现通过；报告正文是 synthetic，真实隔离并行模型执行仍归 REVIEW-04。 |
| AC-REVIEW-03 | reviewer 通过到 done、打回进行中、manager 有原因覆盖 | `E-BASE/E-TASK/E-UI`；`C-TASK`、`C-UI`；`tests/tasks-service.test.ts`、`tests/tasks-mcp.test.ts` | PASS | 普通通过/打回、manager 原因覆盖及再次覆盖通过；原报告/裁决保留，报告不全不能普通通过。 |
| AC-REVIEW-04 | Claude 或 Codex 完成真实任务双轴评审，命令/版本/fixed point 可追溯 | `B-NATIVE`；`C-REVIEW`；环境记录 `B-NATIVE` | BLOCKED | Codex 在模型前初始化失败；需正常原生环境、真实并行隔离上下文及平台裁决读回。 |
| AC-REVIEW-05 | 报告保留标准来源、任务要求、结论与证据 | `E-BASE/E-TASK/E-UI`；`C-TASK`、`C-UI`；`tests/tasks-input.test.ts`、`tests/tasks-service.test.ts`；[报告流程](tasks-and-review.md) | PASS | 标准来源、任务要求、候选与声明字段校验/保存通过；此结果不认证 synthetic 输出来自真实外部模型。 |

### 3.4 记忆：7 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-MEM-01 | global 仅本体 Agent 读写、跨项目本人注入 | `E-BASE/E-MEM`；`C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-mcp.test.ts`、`tests/memory-injection.test.ts` | PASS | 其他 Agent、owner、manager 的存在性/历史窥探均拒绝；本人跨项目注入通过，HTTP 无 global 入口。 |
| AC-MEM-02 | 共享文档成员读、manager/人写、显式拉取 | `E-BASE/E-MEM/E-UI`；`C-MEM`、`C-UI`；`tests/memory-http.test.ts`、`tests/memory-service.test.ts` | PASS | 实时 ACL、列表/历史同边界、显式拉取与归档只读通过；shared 不自动注入。 |
| AC-MEM-03 | project-agent 本人/授权管理者可读写、本人项目内注入 | `E-BASE/E-MEM`；`C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-reader.test.ts`、`tests/memory-mcp.test.ts` | PASS | 子树和失活/已移除目标文档维护边界通过；读取期间撤权也不返回正文。 |
| AC-MEM-04 | 三种真实触发自总结、新版本、人工优先 | `E-MEM（协议部分）/B-NATIVE`；`C-MEM`、`C-SELF-SUMMARY`；`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts`；`B-NATIVE` | BLOCKED | 协议夹具可验证触发/CAS，真实目标模型尚缺；N 计数只能来自首次真实 MCP 投递。 |
| AC-MEM-05 | 执行中人工编辑、版本历史可查 | `E-BASE/E-MEM/E-UI`；`C-MEM`、`C-UI`；`tests/memory-http.test.ts`、`tests/memory-ui.test.ts`、`tests/memory-summary.test.ts` | PASS | 执行状态中的人工写入、409 草稿/新基准、历史、迟到响应与自动结果竞争通过；真实模型调用仍在 MEM-04 单列。 |
| AC-MEM-06 | 普通 Agent 不能经记忆/聊天读取未参与群消息 | `E-BASE/E-MEM`；`C-MEM`、`C-DB`；`tests/memory-service.test.ts`、`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts` | PASS | packet 输入、任务关联、不可见前缀分页与退群后权限通过，不以页面无入口替代服务端拒绝。 |
| AC-MEM-07 | 总结失败不阻断主流程，有可诊断状态 | `E-BASE/E-MEM`；`C-MEM`、`C-DB`；`tests/memory-mcp-postgres.test.ts`、`tests/memory-reader.test.ts`、`tests/memory-runtime.test.ts`、`tests/memory-stdio.test.ts` | PASS | 独立 reader/真实 PG 阻塞、超时、回滚、ACK 后补偿与 stdio EOF 清理通过；模型不可用仍保持真实失败状态。 |

### 3.5 收尾：5 项

| acceptanceId | 验收要求 | command / evidence 入口 | status | limitation / nextAction |
| --- | --- | --- | --- | --- |
| AC-HARD-01 | 自动化覆盖 mention/权限/状态/记忆/隔离 | `E-BASE/E-CORE/E-TASK/E-MEM`；`C-BASE`、`C-DB`、`C-CORE`、`C-TASK`、`C-MEM`；各域测试见前表 | PASS | 同一 tree 的类型、构建与全量测试通过；1006 项中的 31 个环境 SKIP 明列，不以多个旧候选拼接。 |
| AC-HARD-02 | 重启、断线、MCP 超时、无效 ref 等故障 | `E-BASE/E-CORE/E-TASK/E-MEM/E-LOAD-SQL/E-LOAD-WEB`；`C-CORE`、`C-TASK`、`C-MEM`、`C-DB`；§4 故障矩阵 | PASS | 故障/并发/预算/重启/无效 ref 均有本候选证据；模型环境失败仅记录阻塞，不记作模型成功路径。 |
| AC-HARD-03 | 跨项目/群隔离与未授权读拒绝 | `E-BASE/E-TASK/E-MEM/E-UI`；`C-DB`、`C-TASK`、`C-MEM`、`C-UI`；`tests/current-project-ui.test.ts`、`tests/domain-mutation-scope.test.ts`、`tests/mcp-lifecycle-scope.test.ts` | PASS | 数据、领域、HTTP/MCP 与 Chromium 分层通过，包含切项目草稿/旧请求、成员移除后的旧加入代际。 |
| AC-HARD-04 | 可复现安装/启动/三宿主配置和限制说明 | `E-INSTALL/H-HOST/H-DSH`；`C-INSTALL`；[接入](getting-started-mcp.md)、[任务](tasks-and-review.md)、[记忆](memory.md)、[设置与审计](settings-and-audit.md) | PASS | 干净 Linux CI 真实安装/启动与双数据库重启通过；三宿主配置及已知限制有文档。原生宿主复验归六项 Core，macOS 归 NFR-07，均未被本项放行。 |
| AC-HARD-05 | 全部 V1 AC 通过，或有明确有效例外 | `全部证据组及独立审查`；完整本索引 + 独立需求/标准审查 + 最终 PR/主线结果 | BLOCKED | 37 项工程/安装通过，6 项原生 Core 未执行，REVIEW-04/MEM-04 阻塞，macOS 尚缺；没有新豁免，#83 例外不能扩用。 |

## 4. 横切故障、负载与迁移门禁

这些门禁补充 46 项映射，不新增或缩减主 Spec AC。

| 范围 | 当前入口 / 必须观察的结果 | 本版状态与缺口 |
| --- | --- | --- |
| 重启、断开、MCP 超时 | `E-BASE/E-CORE/E-INSTALL`；`tests/mcp-http.test.ts`、`tests/t5-restart-http.test.ts`、`tests/mcp-lifecycle-scope.test.ts`；消息/游标持久化，旧会话不能越过加入代际，新会话权限正确 | PASS：生产服务与 SDK 链通过；真实 CLI 重连仍按六项 Core 的未执行范围单列。 |
| S5-AUDIT-07 / 11 完整关系与逐步失败 | `E-BASE`；`tests/phase5-fault-matrix.test.ts` 加既有 `api-mutation-atomic`、`member-compensation`、`audit-compensation`；完整关系 remove 与 5 次补偿读回；13 个 remove/undo 故障场景均在成员、task/settings、round、request、通知、audit 或 reversed 的真实 DML 后抛错 | PASS：SQLite/PG 分别逐表比对历史字节、作者、事实版本、审计与 reversed；同连接失败后可继续正常提交。 |
| S5-AUDIT-11 / 13 竞争与锁序 | `E-BASE`；`tests/phase5-concurrency-matrix.test.ts`、`tests/domain-mutation-scope.test.ts`、`tests/runtime-mutation-scope.test.ts`；18 个普通/managed MCP、HTTP remove/undo、task/memory、join、runtime/binding 入口；remove/undo/改派、claim/remove 及跨项目 delete/addBinding 闭包扩大 | PASS：真实 PG 独立连接和数据库屏障，项目锁先于 member/runtime；无 40P01，仅完整提交或稳定冲突。SQLite 结果只作串行兼容证据。 |
| S5-AUDIT-14 预算与真实取消 | `E-BASE`；`tests/capture-budget-boundaries.test.ts`、`tests/capture-budget-pagination.test.ts`；2048 返回行、2 MiB UTF-8、512 SQL、2048 改变行、32 KiB 快照、128 参与边/512 关系及长字段的恰限与超限，整批返回计费 | PASS：真实 PG 57014 后 rollback 与同连接复用；SQLite 原生长查询返回后拒绝并回滚，不声称可中途取消；NUL/最坏转义未截断后接受。 |
| 无效/空/脏 Git 候选与外部程序 | `E-BASE/E-TASK`；`tests/tasks-candidate.test.ts`、`tests/tasks-service.test.ts`；失败轮次可读，10 秒/2 MiB/200 commits 预算，不运行 hooks/filter/外部 diff 或懒拉取 | PASS：真实 Git、外部程序 canary 和退出结果通过；不代表模型完成评审。 |
| 记忆 reader 真阻塞与关闭 | `E-BASE/E-MEM`；`tests/memory-reader.test.ts`、`tests/memory-mcp-postgres.test.ts`、`tests/memory-runtime.test.ts`、`tests/memory-stdio.test.ts`；独立只读进程、超时有界、消息/ACK/status 可用、真实事务回滚 | PASS：包含实际 PG 表锁、独立 reader 超时及 EOF 清理，未以 SQLite 或延时 Promise 替代。 |
| 触发与请求恢复 | `E-BASE/E-MEM`；`tests/memory-mcp.test.ts`、`tests/memory-triggers.test.ts`、`tests/memory-summary.test.ts`；首次 MCP 投递、不可见前缀 raw cursor、持久 checkpoint、已 ACK 任务事件的补建、来源重开取消 | PASS：触发、人工优先与失败恢复协议通过；真实目标模型完成仍为 MEM-04 BLOCKED。 |
| 非空 v12 → v13 / S5-AUDIT-15 | `E-BASE`；`tests/member-facts.test.ts`；历史作者保留、六类事实版本基准/trigger、旧 checksum 不变、移除代际单调；插入/删除/替换/回改、FK 级联与事务回滚 | PASS：SQLite 与真实 PG 均已执行。 |
| v13 ↔ v13 数据复制与回滚 | `E-BASE`；`tests/migrate-data.test.ts`、[迁移 CLI](../scripts/migrate-data.ts)；tasks/memory/receipts/checkpoints/投递/审计/removed/事实版本逐键核对，事实版本最后复制，回滚只处理目标 | PASS：双向独立目标库验证，源数据未受回滚影响。 |
| 只读设置与真实重启 | `E-BASE/E-UI/E-INSTALL`；`tests/settings-server.test.ts`、`tests/settings-http.test.ts`、`tests/settings-ui.test.ts` 与 `scripts/e2e-settings-web.py`；白名单实际配置/来源、环境覆盖、改文件不热加载、正常重启生效、随机实际端口一致 | PASS：生产 HTTP/真实 Chromium 均取证；刷新失败保旧值/时间，无保存或假重启按钮，受控剪贴板失败不报成功。 |
| NFR-03 时序 | `E-LOAD-SQL/E-LOAD-WEB`，命令为 `C-LOAD`；真实待收消息 ≤2 秒、WebUI ≤1 秒；记录发送、wait 返回、ACK/heartbeat 和 DOM 可见单调时间及精确 message ID；补偿并发下逐次验证 | PASS（Linux）：48 次数据库资源记录与 24 轮 HTTP/DOM 记录分别验限；未用普通 5 秒 wait 或截图代替。 |
| NFR-04 / S5-AUDIT-16 固定负载 | `E-LOAD-SQL/E-LOAD-WEB`；3 并发 Agent、5 项目、每项目 5 群、每群 3 参与者、1000 条消息的实际清单；另列 10000 条/大正文及未 mention 历史；每档 6 次 remove/undo/redo 翻转 | PASS（Linux）：每次 mutation ≤500ms、MCP ≤2s、DOM ≤1s；SQL/返回量与 DOM 分开，各数据库/数据档分别通过。 |
| NFR-07 平台 | 记录真实 OS/架构；macOS 是产品首要环境 | NOT_RUN：本轮工程验证是 Linux；尚无该候选 macOS 实测，不作跨平台通过结论。 |

## 5. 真实模型阻塞与历史材料

### B-NATIVE：本轮原生模型环境

2026-11-11 01:17:37–01:19:23 UTC 的只读恢复核查记录：`/opt/codex/bin/codex --version` 返回 `codex-cli 0.167.0-alpha.4`，登录状态可读；继承的 Codex 运行目录仍是只读挂载。此前最小原生调用在模型前退出 1，错误为 `failed to initialize in-process app-server client: Read-only file system (os error 30)`，没有模型 JSONL。环境未改变，恢复核查未重复同一模型探测。

2026-11-11T04:12:14.506593Z 再次只读核对确认：`/home/agent` 所在挂载可写，但 `/home/agent/.codex` 是独立只读挂载，`writable: false`。本次只检查文件系统与访问权限，**未重复模型调用、未复制凭据、未改变运行目录**。不能把父目录可写或 CLI 登录成功理解为阻塞已解除。

该事实的范围是环境阻塞：版本/登录读取成功不是任务评审或自总结成功。交付记录包括 `native-cli-resume-check.md`（SHA-256 `b3d9ce907cbcb696f261c9c478f13fd7edc8c3235ed7aef19df8be83343e47ed`）及 `native-cli-readonly-recheck-20261111.json`，关联 [Spec #109](https://github.com/gbcdby/boardroom/issues/109) / [Ticket #112](https://github.com/gbcdby/boardroom/issues/112)。初始失败的原始 stderr 为 133 字节，SHA-256 `ac45fa2da13b377015236d8241d591493c6df7085a78a3844b8d2d87b8946d9c`；模型 JSONL 为 0 字节，没有可计作模型执行的输出。原始材料需随最终验收归档为可读取产物，不能只保留机器上的临时绝对路径。

解除条件是正常的原生模型运行环境，然后分别完成 `C-REVIEW` 和 `C-SELF-SUMMARY`。仅修复 CLI 启动、验证登录或换成预制报告都不足以通过。不得复制凭据、改运行目录以绕过只读挂载，或把 SDK/托管旧例外改名为真实模型证据。

### 历史背景清单

| evidence ID | 对象与日期 | 来源 | relation / 可复用范围 |
| --- | --- | --- | --- |
| H-HOST | 2026-11-03，Claude Code 2.1.233、Codex CLI 0.166.0、Node v24.14.0，阶段 1 外部 Streamable HTTP | [T8 历史报告](t8-acceptance-report.md) | background：join、活跃等待、双向 @、重连能力的旧记录。原始输出部分只在当时本地留档；不是当前 commit、当前 CLI 或真实任务/记忆验收。 |
| H-DSH | 2026-11-03，DSH 0.2.1-rc.5、Node v24.14.0，当时 `hostType=other` | [随库索引](../evidence/real-host-retest/README.md)、[join](../evidence/real-host-retest/dsh-join.out)、[wait](../evidence/real-host-retest/dsh-wait.out) | background：仅 join 与活跃 wait。当前已注册 `dsh`；reconnect、空闲唤醒、在途打断仍 unsupported，不扩大旧输出含义。 |
| H-MANAGED | 可选托管运行时的既有独立交付 | [Spec #83](https://github.com/gbcdby/boardroom/issues/83)、[README 支持边界](../README.md#可选托管-agent-运行时) | background：只在原批准对象与范围内有效；支持表为空，不能代替 REVIEW-04/MEM-04。 |
| H-P5-CI | 2026-11-11，旧工程候选 `ab5fc086347cf84b0cb8fd04658ec671a14e708f`，CI 实际 `8dac3fe349f7b456ec51c31f4ab27a1dd2451713`，同 tree `32aaf5318658efbd96c6936355bd52450377b415` | [CI 42957360213](https://github.com/gbcdby/boardroom/actions/runs/42957360213)；原数据库日志和浏览器报告 | background：数据库 990 项中 958 PASS、31 SKIP、1 FAIL；唯一失败为 PG 旧 generation 挂起 wait。浏览器页面与两数据库 24 轮负载单独 PASS，整次 CI 不是全绿。之后的 wait、未发布记忆指纹、NUL 修复属于本轮新候选，不能把旧通过项直接复标。 |

历史证据若用于本轮结论，需记录新旧候选差异、受影响权限/协议/宿主路径、哪些结论仍适用、哪些要重跑。主架构 §8 的 DSH 历史注释与 §10.2 的保守声明存在旧文字差异；本索引采用随库证据与当前适配器的实际边界，不因此修改主 Spec 要求。T8 原报告的日期、对象和结论保持原样。

## 6. 尚需完成的验收与交付记录

1. 六项 Core 真实宿主范围仍需在有效的 Claude Code / Codex CLI 环境执行并保存版本、命令、消息 ID 和新会话结果；DSH 仅按已证实支持范围记录。历史材料保持原日期和对象。
2. 原生模型环境恢复后，分别完成 REVIEW-04 真实双轴评审与 MEM-04 三触发目标自总结；支持这两项的协议/数据库通过不解除真实模型门槛。无有效例外时 HARD-05 保持 BLOCKED。
3. 在真实 macOS 首要环境补 NFR-07 安装、接入及相关行为检查；当前 Linux CI、安装和性能数据不能自动推广。
4. 将 `E-*` 产物及 `B-NATIVE` 原始材料归档到可持续读取的交付记录，并在 [PR #119](https://github.com/gbcdby/boardroom/pull/119) 保留工程候选、纯文档增量和独立需求/标准审查的对象身份。作者整理证据不替代独立审查。
5. 实际合并和合并后主线复验按 PR/主线的新记录核对。PR CI 已通过不等于 PR 已合并；即使合并，也不等于 V1 全项验收或部署。

本版没有新增验收例外。若随后有明确授权的例外，逐项保存 `acceptanceIds / reason / exactScope / knownRisk / followUp / acceptanceAuthority / date`；不能只写“已知问题”或把旧例外扩大范围。

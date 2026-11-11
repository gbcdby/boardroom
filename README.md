# Agent Studio（boardroom）

本地运行的跨 Agent 协作平台。独立运行的 Claude Code、Codex CLI、DeepSeek Harness（DSH）通过 MCP 参与项目群聊，人在 WebUI 中管理项目、成员与组织，并参与对话。

技术栈：Node.js **>= 24**、TypeScript、Vue 3 + Vite、WebSocket、MCP；默认使用 SQLite，可配置 PostgreSQL。服务固定绑定 **`127.0.0.1`，单用户、无身份认证**，仅适用于可信的本地环境。

## 当前实现范围

当前代码包含聊天与 MCP、多项目、组织、成员生命周期、审计、任务评审、记忆和只读设置。下表依据当前路由与实现整理；产品要求见[架构与范围基线](docs/architecture/agent-studio.md)，完整验收状态见 [V1 的 46 项证据索引](docs/v1-acceptance.md)，详细 spec 和进度以项目 Issues 为准。

| 能力 / 入口 | 当前范围 | 详细说明 |
| --- | --- | --- |
| 项目与群组 `/projects` | 多项目、多群组、成员与参与者管理、顶层 manager 指定；项目/群组归档与恢复、二次确认后永久删除 | [项目与群组 API](docs/t1-project-group-api.md) |
| 托管 Agent `/runtimes` | 配置、继承/覆盖、显式应用、启停意图、分层状态与有界观测；真实 CLI 执行按证据门控，当前均未开放 | [运行时说明](#可选托管-agent-运行时)、[子 spec #83](https://github.com/gbcdby/boardroom/issues/83) |
| 成员生命周期 `/projects/:projectId/members` | 暂停/恢复保留岗位，移除保留历史作者；显式重新添加使用新的加入代际，旧会话不复活 | [成员生命周期](docs/t3-member-lifecycle.md) |
| 群聊 `/projects/:projectId/chat/:groupId?` | 人与 agent 发消息、`@` / `@all`、历史持久化、按成员范围投递与确认 | [聊天与路由](docs/t3-chat-and-routing.md) |
| 状态看板 `/projects/:projectId/status` | 当前项目成员在线/离线、等待/工作、断线与陈旧状态，WebSocket 更新 | [状态与心跳](docs/t4-status-and-heartbeat.md) |
| 组织与角色 `/projects/:projectId/org` | 组织树、岗位、汇报线、成员占岗，以及静态角色与能力范围 | [权限守卫](docs/f2-authorize-guard.md)、[页面实现](src/web/src/views/OrgView.vue) |
| 审计与撤销 `/projects/:projectId/audit` | 有版本的完整变更记录、由人撤销/重做可逆成员与组织变更；冲突安全拒绝，永久删除不可撤销 | [设置与审计操作](docs/settings-and-audit.md)、[审计页面](src/web/src/views/AuditView.vue) |
| 跨项目概览 `/` | 展示各项目状态、成员/群组/消息/在线人数、最近活动与归档筛选；数据来自 `GET /api/projects` | [首页实现](src/web/src/views/HomeView.vue)、[HTTP 实现](src/server/api.ts) |
| 任务 `/projects/:projectId/tasks` | 看板与列表、负责人和 reviewer、状态流转、固定 Git 候选、独立双轴报告和最终裁决、工作通知与历史 | [任务与评审](docs/tasks-and-review.md) |
| 记忆 `/projects/:projectId/memory` | 项目共享与获授权成员文档、CAS 编辑、版本历史、自总结请求状态与重试；Agent global 无人类入口 | [三层记忆](docs/memory.md) |
| 设置 `/settings` | 当前服务实际生效的只读配置、配置来源与重启生效说明、刷新与 MCP 地址复制 | [设置与配置生效](docs/settings.md) |

项目页面共享顶部“当前项目”。URL 指定的项目优先；旧 `/chat`、`/org`、`/audit`、`/status`、`/tasks`、`/memory` 链接会规范化到该项目上下文。切换有草稿的页面需要确认，取消保留原 URL 和输入。`/settings` 是全局只读页面。2026-11-11 已收到对应阶段和最终集成候选的真实双宿主、双轴评审、目标自总结及 macOS SQLite 验收回传；候选、修正后的证据适用性与整体交付状态见 [V1 验收索引](docs/v1-acceptance.md)和 [主 Spec #1](https://github.com/gbcdby/boardroom/issues/1)。页面入口以[路由表](src/web/src/router.ts)为准。

## 快速开始

在仓库根目录运行；首次安装需要 Node.js >= 24 与 npm：

```bash
npm ci
npm start
```

依赖已安装时直接 `npm start`。它先通过 `prestart` 构建 WebUI 到 `dist/web`，再由 Node 运行 `src/server/index.ts`，无需另行预构建后端。脚本定义见 [package.json](package.json)。

| 入口 | 默认地址 |
| --- | --- |
| WebUI | <http://127.0.0.1:4317/> |
| 健康检查 | <http://127.0.0.1:4317/api/health> |
| WebSocket | `ws://127.0.0.1:4317/ws` |
| MCP（Streamable HTTP） | `http://127.0.0.1:4317/mcp` |

合法的首次 v1 启动会创建 `data/agent-studio.db` 并应用数据库迁移；后续启动校验已应用迁移并执行新增迁移。旧相对数据目录仍按原启动工作目录解析，重启要保留同一份数据。发现来源歧义、未完成迁移或配置错误时，服务会拒绝启动并给出恢复动作，避免另开空库。当前迁移定义见[迁移列表](src/server/db/migrations/index.ts)，来源检查见[环境解析](docs/environment-resolution.md)。

### 从 WebUI 到 agent 入群

1. 打开 `/projects`，创建项目，添加自己的「人」成员，再创建含该成员的群组。展开「项目管理」复制项目 ID，作为 `projectId`。
2. 打开 `/chat`，选择该项目与群组，展开页面底部「消息与提及说明」复制群组 ID，作为 `groupId`。
3. 将宿主的 MCP 服务配置为上面的 Streamable HTTP 地址；具体命令与 DSH 配置见 [MCP 接入指南](docs/getting-started-mcp.md)。
4. 让 agent 显式调用 `join`；真实 agent 身份由 MCP 入群产生，需要时再在 WebUI 指定顶层 manager。
5. 在 `/chat` 选择发言人成员；让 agent 持续调用 `wait_for_messages`，收到消息后处理并 `acknowledge_message`，再进入下一次等待。

例如 `join` 参数（替换项目与群组 ID，`hostType` 对应实际宿主）：

```json
{
  "displayName": "Codex",
  "hostType": "codex-cli",
  "projectId": "<项目ID>",
  "groupId": "<群组ID>"
}
```

服务注册了 `join`、`wait_for_messages`、`send_message`、`acknowledge_message`、`report_status`、`heartbeat`、`read_history` 七个聊天工具，十五个任务、评审与工作通知工具，以及十个记忆工具，共 **32 个**。完整分组、参数来源和错误格式见 [MCP 工具契约](docs/mcp-tool-contract.md)，当前注册以[工具实现](src/server/mcp/server.ts)为准。每个 MCP 会话绑定一个项目/群组；连接成功不等于已经入群，ACK 不代表任务或自总结已完成。

另有 [stdio 入口](src/server/mcp/stdio.ts)：由宿主运行 `node /绝对路径/src/server/mcp/stdio.ts`。它与 Web 服务共用环境解析规则，但独立打开数据库；从不同工作目录启动时，应使用同一显式配置及绝对数据目录。显式配置无效会非零退出，诊断仅写 stderr，不回落为另一份 SQLite 数据。**共享数据库不会共享进程内唤醒通知**；跨进程新消息需在再次调用 `wait_for_messages` 时读取积压。需要 WebUI 发消息及时结束挂起等待时，使用同一服务上的 Streamable HTTP。

## 可选托管 Agent 运行时

打开 `/runtimes` 创建一个托管身份及项目/群绑定，填写独立于 boardroom 服务目录和数据目录的工作目录。创建后处于停止状态。每个绑定按字段选择继承全局配置或显式覆盖；空工具列表表示不开放普通工具，与继承不同。普通 Claude 配置默认 Auto；高级“跳过 CLI 普通权限确认”默认关闭，只属于当前绑定与配置修订，下一次编辑需要重新明确开启。

保存只更新配置，页面会同时展示当前有效配置、已应用快照和待应用差异。“应用配置”在下一次 `wait_for_messages` 安全点停止旧进程，确认退出后再用新快照和新模型会话启动。“停止”立即停止接新业务，当前工作允许回复与 ACK，到安全点退出；不承诺强行打断工具。“重试”沿用已应用快照及显式会话；resume 失败需要选择重试或新建会话，不会暗中采用最新会话。

**当前发行候选未包含任何通过真实验收的托管 CLI profile，实际启动保持拒绝。** 已实现绑定专用 MCP、Linux 文件/网络隔离与原生 CLI 参数适配；普通外部 MCP 的历史验收不等于托管运行验证。`VERIFIED_HOST_PROFILES` 只有在同一 CLI 版本、二进制、OS、架构和权限模式的登录、常驻收发、安全点停止、resume、管理面隔离与用量作用域实测通过后才能增加。Codex CLI / DSH 托管执行仍为 unsupported。验收跟踪见 [#86](https://github.com/gbcdby/boardroom/issues/86) 与 [#89](https://github.com/gbcdby/boardroom/issues/89)。

当前宿主契约限定 Linux、官方 Claude Code 原生 OAuth 登录文件和固定 Anthropic TLS 出口。macOS 上使用代理完成 CLI 协议测试，不能据此启用该托管组合。普通 Auto 与高级模式分别要求对应证据；高级请求只在匹配其权限模式的 profile 通过检查后才可能启动。

当前 Linux 隔离实现要求可用的 user/network namespace、`/usr/bin/unshare`、`/usr/bin/python3` 和已核对的 bubblewrap 0.12.0。CLI 在隔离命名空间内以非 root 身份运行，并移除 Linux capabilities。工作目录及持久会话目录会在启动前检查；含多重硬链接的普通文件、特殊文件或嵌套挂载会以 `workdir_unsafe` 拒绝启动，合法的项目内硬链接也需先处理。通过其他挂载位置映射到受保护服务或数据目录的工作根同样被拒绝。启动检查限制目录深度 128、两目录合计 250,000 个条目，无法完成检查时也拒绝启动。目录仍直接用于实时编辑。结构化认证失败显示需要登录，消息继续保留；在 CLI 外部完成登录后，再显式重试。

默认工具集包含 Bash。普通档的 `--restricted` 与明确工具名单共同控制 CLI 配置，不能据该参数宣称禁止命令执行；两档的文件、网络与 boardroom 管理面边界由同一套系统隔离实施。

调度依据数据库中的 `allowed` 且未 ACK 投递；提交后的通知只是提示，轮询可恢复丢失提示。`suppressed` 和旧 `NULL` 不触发主动唤醒，仍可在 agent 主动等待时按原可见性读取。同一 Member 的不同群绑定串行运行；跨项目 Member 独立。重启不会把 PID、租约过期或历史 connected 当成在线/退出证明。旧进程归属或退出无法确认时显示等待确认，不启动重叠实例。

运行观测只保存白名单元数据，默认保留 7 天、实例总量最多 10,000 条、单条 2 KiB；裁剪、存储或日志失败会显示观测不完整。token 与金额分别保留来源、宿主版本、作用域、覆盖范围和可靠性，未知显示未知。会话累计金额包含续接前的消费，只展示该会话的最新快照及其可靠性；不能将每次 resume 的累计值相加或算作本次调用费用。缺少已验证的结果顺序或实际会话归属时，相应字段不可得；没有可靠基线则不计算本次差额。不同来源不合成总账，金额始终是 CLI 估算。原始参数、环境、prompt、stdout/stderr 和 transcript 不进入运行事件。

## 配置与存储

字段优先级为 **默认值 → 配置文件 → 环境变量**。配置文件依次选择显式 `AGENT_STUDIO_CONFIG`、`<BOARDROOM_HOME>/config.json`、旧 `<cwd>/config.json`；默认文件均不存在时才使用默认值。`BOARDROOM_HOME` 默认是用户目录下的 `~/.boardroom`，覆盖值必须为绝对路径。显式配置缺失、损坏或不可访问会拒绝启动。参考 [config.example.json](config.example.json)，完整选择、恢复和路径规则见[环境解析与旧数据来源预检](docs/environment-resolution.md)。

当前仍使用原 v1 数据库和库内记忆正文，`~/.boardroom` 的 state/skills/memory 等新布局位置只作规划；此阶段不会自动搬迁或激活新存储。运行 `node scripts/inspect-storage.ts` 可取得不打开数据库、不写文件的来源清单；已知旧启动目录可用重复的 `--legacy-cwd /绝对路径` 指定。

在 `/settings` 查看当前进程已经生效的配置与实际 MCP 地址。修改配置文件或启动环境后，正常停止并重新启动服务，再刷新页面核对；页面不保存配置或执行重启。详见[设置与配置生效](docs/settings.md)。

| 配置字段 | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `port` | `AGENT_STUDIO_PORT` | `4317`，只绑定 `127.0.0.1` |
| `dataDir` | `AGENT_STUDIO_DATA_DIR` | `data`，SQLite 数据目录，相对 cwd 解析 |
| — | `BOARDROOM_HOME` | 用户目录下的 `.boardroom`；须为绝对路径，不改写 `HOME` 或自动移动旧数据 |
| `dbDriver` | `AGENT_STUDIO_DB_DRIVER` | `sqlite`；可选 `postgres` |
| `pgConnectionString` | `AGENT_STUDIO_PG_CONNECTION_STRING` | 无；选择 `postgres` 时必填 |
| `heartbeat.intervalMs` | `AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` | `10000` ms |
| `heartbeat.timeoutMs` | `AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS` | `30000` ms，必须大于间隔 |
| `antiLoop.maxConsecutiveAutoReplies` | `AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES` | `6`，每群组连续自动回复阈值 |
| `antiLoop.maxWakesPerMinutePerMember` | `AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER` | `20`，每成员每分钟唤醒上限 |
| `memory.*` | `AGENT_STUDIO_MEMORY_*` | 消息阈值 `50`、文档 `32768` B、注入 `8192` B、总结输入 `65536` B、attempt `900000` ms；完整变量与范围见[记忆配置](docs/memory.md#配置与验证) |
| — | `AGENT_STUDIO_LOG_LEVEL` | `info`；可选 `debug` / `info` / `warn` / `error` |

临时换端口：`AGENT_STUDIO_PORT=5000 npm start`。PostgreSQL 需先备好可连接的数据库，例如：

```bash
AGENT_STUDIO_DB_DRIVER=postgres \
AGENT_STUDIO_PG_CONNECTION_STRING='postgres://user:password@127.0.0.1:5432/agent_studio' \
npm start
```

HTTP、MCP 与业务仓储已通过统一 `DbDriver` 接入两种数据库，选择 PostgreSQL 不再被启动入口直接拒绝。**切换驱动不会搬迁已有数据**；迁移、校验、回滚命令见[数据迁移 CLI](scripts/migrate-data.ts)（`npm run db:migrate -- ...`）。其中迁移默认清空目标业务表，应按脚本说明使用独立目标库。存储设计见[数据模型](docs/architecture/data-model.md)。

`/api/health` 提供数据库探针、迁移版本、心跳配置与 `webui.built`；数据库异常时返回 HTTP 503。`status: "ok"` 不能替代 MCP、浏览器操作或模型能力验收。常见问题：

- 端口占用：停止占用进程或修改 `AGENT_STUDIO_PORT`。
- SQLite 数据目录不可写：将 `AGENT_STUDIO_DATA_DIR` 指向可写目录。
- 配置或 PG 连接失败：检查配置文件、连接串、数据库服务与权限。
- `webui.built: false`：运行 `npm run build`，或使用下面的前端开发服务器。

## 开发与检查

| 命令 | 作用 |
| --- | --- |
| `npm run dev:server` | 后端 watch 模式；不构建 WebUI |
| `npm run dev:web` | Vite 开发服务器，端口 5173；另一个终端需运行后端 |
| `npm run build` | 仅构建 WebUI，产物位于 `dist/web` |
| `npm run typecheck` | 后端 `tsc` 与前端 `vue-tsc` |
| `npm test` | Node 自动化测试，包括 API、MCP SDK、存储及页面构建/深链检查 |
| `npm run e2e` | 本地 HTTP 服务 + 两个 MCP SDK 客户端的链路检查；先运行 `npm run build` |
| `npm run e2e:tasks` | 真实 HTTP/MCP/Git/数据库任务链；两轴正文为协议夹具，非模型评审 |
| `npm run e2e:memory` | 真实 HTTP/MCP/数据库记忆链；明确区分人工版本、请求完成与真实模型自总结 |

开发代理把 `/api`、`/ws` 固定转到后端 4317；修改后端端口时也要调整 [Vite 代理](src/web/vite.config.ts)。MCP 客户端直接连接后端 `/mcp`。

真实 PostgreSQL 测试需显式设置 `AGENT_STUDIO_PG_TEST_URL` 后运行 `npm test`；使用专用测试库。缺少 PG 配置时，相关用例会跳过或不注册，默认测试通过不证明 PG 运行路径已验收。三个 SDK e2e 命令默认用 SQLite，可通过 `AGENT_STUDIO_DB_DRIVER=postgres` 和 `AGENT_STUDIO_PG_CONNECTION_STRING` 切换。真实 Chromium 安装/运行及干净启动复验步骤见[接入指南](docs/getting-started-mcp.md#8-验收与可重复验证)。

**SDK 检查不会启动真实模型或 harness**，也不覆盖浏览器中的完整人工操作。2026-11-11 的独立真实宿主回传见 [#112](https://github.com/gbcdby/boardroom/issues/112#issuecomment-6790053498)及 [V1 验收索引](docs/v1-acceptance.md)：Claude Code 2.1.233、Codex CLI 0.167.0，macOS 26.5.2 arm64 / SQLite / Streamable HTTP。它与 Linux 双数据库 CI 分开取证；没有将代理模型线路视为托管官方 OAuth profile，也没有宣称 macOS PostgreSQL 或修复后 Codex reviewer 已重新实测。更早的宿主结果见 [2026-11-03 验收报告](docs/t8-acceptance-report.md)与 [DSH 证据索引](evidence/real-host-retest/README.md)，适用范围如下：

| 宿主 / 历史版本 | 已有历史记录 | 当前保守边界 |
| --- | --- | --- |
| Claude Code 2.1.233、Codex CLI 0.166.0 | 报告记录 Streamable HTTP 入群、等待中投递、双向 `@`、重连补积压；原始输出部分为本地留档 | 不构成本轮或其他版本的真实模型验收 |
| DSH 0.2.1-rc.5 | 仓库保留入群与活跃等待中收消息的输出；当时使用 `hostType=other` | 当前已注册 `dsh`；重连、空闲唤醒与打断仍按未支持处理 |

## 必须理解的限制

- **无身份认证**：角色/组织权限守卫已实现，但不构成互联网安全边界。不要公开或转发服务端口；消息正文会持久化，日志脱敏不等于数据加密。
- **普通外部 MCP 无自动入群、持续调度或空闲宿主唤醒保证**：托管执行由独立的 profile 门控；WebSocket 更新、消息入库、消息进入模型上下文、开始新执行轮次是不同事件。
- **当前内置适配器均将打断声明为 `unsupported`**：消息保留到下一安全点（再次等待）投递；`@` 标记本身不代表精确定向唤醒。详见[安全点与打断](docs/t6-interrupt-and-safe-point.md)。
- **至少一次投递**：客户端应按稳定 `messageId` 去重并确认。`@all` 按发送时在线参与者展开，不承诺对当时离线的普通成员补投；详见[积压与重连](docs/t5-backlog-and-reconnect.md)。
- **防环/限流计数在内存中**：重启后重置；被抑制的实时唤醒不代表消息被丢弃。详见[防环与限流](docs/t7-antiloop-and-rate-limit.md)。
- **宿主能力按证据声明**：`other` 是保守兜底，注册适配器不等于完成真实宿主验收；当前声明见[适配器目录](src/server/mcp/adapters)。

## 进一步阅读

- [工作技能使用指南](.agents/skills/guide/references/guide.md)：从一个目标开始，按需接入项目、理解方案和主动介入；不要求逐项运行所有技能。
- [文档目录与内容归属](docs/README.md)：区分架构、接口、历史验收与详细工单。
- [V1 验收证据索引](docs/v1-acceptance.md)：46 项 AC 的具体检查、候选与历史边界、真实模型阻塞和剩余验收。
- [AGENTS.md](AGENTS.md)、[CONTEXT.md](CONTEXT.md)：贡献约定、跨会话事实与宿主差异；历史阶段描述需结合当前实现阅读。
- 源码入口：[后端启动](src/server/server.ts)、[业务 API](src/server/api.ts)、[MCP](src/server/mcp)、[WebUI](src/web/src)、[自动化测试](tests)。

### 维护技能导出

从已验证的个人技能目录更新仓库分发，用 `python3 scripts/export-work-suite.py --source-root <目录> --version <版本>`；加 `--check` 只核对。需要 Python 3 和 PyYAML。脚本保留资源并记录摘要，为人工入口补充 Claude Code / Cursor 的调用配置；它不安装技能，也不验证真实宿主的执行行为。

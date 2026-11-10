# Agent Studio（boardroom）

本地运行的跨 Agent 协作平台。独立运行的 Claude Code、Codex CLI、DeepSeek Harness（DSH）通过 MCP 参与项目群聊，人在 WebUI 中管理项目、成员与组织，并参与对话。

技术栈：Node.js **>= 24**、TypeScript、Vue 3 + Vite、WebSocket、MCP；默认使用 SQLite，可配置 PostgreSQL。服务固定绑定 **`127.0.0.1`，单用户、无身份认证**，仅适用于可信的本地环境。

## 当前实现范围

当前代码包含聊天与 MCP 主链路，以及多项目、组织、成员生命周期和审计功能。下表依据当前路由与实现整理；产品后续规划见[架构与范围基线](docs/architecture/agent-studio.md)，详细 spec 和进度以项目 Issues 为准。

| 能力 / 入口 | 当前范围 | 详细说明 |
| --- | --- | --- |
| 项目与群组 `/projects` | 多项目、多群组、成员与参与者管理、顶层 manager 指定；项目/群组归档与恢复、二次确认后永久删除 | [项目与群组 API](docs/t1-project-group-api.md) |
| 成员生命周期 `/projects` | 暂停与恢复成员，保留历史、数据与岗位；与在线/离线状态分开 | [成员生命周期](docs/t3-member-lifecycle.md) |
| 群聊 `/chat` | 人与 agent 发消息、`@` / `@all`、历史持久化、按成员范围投递与确认 | [聊天与路由](docs/t3-chat-and-routing.md) |
| 状态看板 `/status` | 项目成员在线/离线、等待/工作、断线与陈旧状态，WebSocket 更新 | [状态与心跳](docs/t4-status-and-heartbeat.md) |
| 组织与角色 `/org` | 组织树、岗位、汇报线、成员占岗，以及静态角色与能力范围 | [权限守卫](docs/f2-authorize-guard.md)、[页面实现](src/web/src/views/OrgView.vue) |
| 审计与撤销 `/audit` | 变更记录、由人撤销可逆的成员/组织变更；永久删除不可撤销，归档/恢复使用对应正向操作 | [审计页面](src/web/src/views/AuditView.vue) |
| 跨项目概览 `/status` | 展示各项目状态、成员/群组/消息/在线人数、最近活动与归档筛选；数据来自 `GET /api/projects` | [状态页实现](src/web/src/views/StatusBoardView.vue)、[HTTP 实现](src/server/api.ts) |

首页 `/` 目前展示健康与连接信息，仍保留早期“工程骨架”文案；跨项目概览请打开 `/status`。`/settings` 仍是占位页。**任务板、任务认领/调度和三层记忆尚未提供**，不应把架构规划当作当前能力。页面入口以[路由表](src/web/src/router.ts)为准。

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

默认首次启动会创建 `data/agent-studio.db` 并应用数据库迁移；后续启动校验已应用迁移并执行新增迁移。数据目录相对进程工作目录解析，重启要保留同一份数据。当前迁移定义见[迁移列表](src/server/db/migrations/index.ts)。

### 从 WebUI 到 agent 入群

1. 打开 `/projects`，创建项目，添加自己的「人」成员，再创建含该成员的群组。从项目标题下方复制项目 ID，作为 `projectId`。
2. 打开 `/chat`，选择该项目与群组，从页面底部「当前群组」旁复制群组 ID，作为 `groupId`。
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

服务注册了 `join`、`wait_for_messages`、`send_message`、`acknowledge_message`、`report_status`、`heartbeat`、`read_history` 七个工具。参数、游标、可见范围和错误格式见 [MCP 工具契约](docs/mcp-tool-contract.md)；当前注册以[工具实现](src/server/mcp/server.ts)为准。每个 MCP 会话绑定一个项目/群组，连接成功不等于已经入群。

另有 [stdio 入口](src/server/mcp/stdio.ts)：由宿主运行 `node /绝对路径/src/server/mcp/stdio.ts`。它独立打开数据库，必须与 Web 服务使用同一存储配置（SQLite 使用相同的绝对数据目录）。**共享数据库不会共享进程内唤醒通知**；跨进程新消息需在再次调用 `wait_for_messages` 时读取积压。需要 WebUI 发消息及时结束挂起等待时，使用同一服务上的 Streamable HTTP。

## 配置与存储

优先级为 **默认值 → 配置文件 → 环境变量**。`AGENT_STUDIO_CONFIG` 可指定配置文件；未设置时读取 `<cwd>/config.json`，默认文件不存在则使用默认值。参考 [config.example.json](config.example.json)，实际解析规则见 [config.ts](src/server/config.ts)。

| 配置字段 | 环境变量 | 默认值 / 说明 |
| --- | --- | --- |
| `port` | `AGENT_STUDIO_PORT` | `4317`，只绑定 `127.0.0.1` |
| `dataDir` | `AGENT_STUDIO_DATA_DIR` | `data`，SQLite 数据目录，相对 cwd 解析 |
| `dbDriver` | `AGENT_STUDIO_DB_DRIVER` | `sqlite`；可选 `postgres` |
| `pgConnectionString` | `AGENT_STUDIO_PG_CONNECTION_STRING` | 无；选择 `postgres` 时必填 |
| `heartbeat.intervalMs` | `AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` | `10000` ms |
| `heartbeat.timeoutMs` | `AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS` | `30000` ms，必须大于间隔 |
| `antiLoop.maxConsecutiveAutoReplies` | `AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES` | `6`，每群组连续自动回复阈值 |
| `antiLoop.maxWakesPerMinutePerMember` | `AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER` | `20`，每成员每分钟唤醒上限 |
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

开发代理把 `/api`、`/ws` 固定转到后端 4317；修改后端端口时也要调整 [Vite 代理](src/web/vite.config.ts)。MCP 客户端直接连接后端 `/mcp`。

真实 PostgreSQL 测试需显式设置 `AGENT_STUDIO_PG_TEST_URL` 后运行 `npm test`；使用专用测试库。缺少 PG 配置时，相关用例会跳过或不注册，默认测试通过不证明 PG 运行路径已验收。`npm run e2e` 默认用 SQLite，可通过 `AGENT_STUDIO_DB_DRIVER=postgres` 和 `AGENT_STUDIO_PG_CONNECTION_STRING` 切换。

**SDK 检查不会启动真实模型或 harness**，也不覆盖浏览器中的完整人工操作。脚本输出中关于 Claude/Codex 的历史措辞，不应当作本次真实宿主验收。历史宿主结果见 [2026-11-03 验收报告](docs/t8-acceptance-report.md)与 [DSH 证据索引](evidence/real-host-retest/README.md)，适用范围如下：

| 宿主 / 历史版本 | 已有历史记录 | 当前保守边界 |
| --- | --- | --- |
| Claude Code 2.1.233、Codex CLI 0.166.0 | 报告记录 Streamable HTTP 入群、等待中投递、双向 `@`、重连补积压；原始输出部分为本地留档 | 不构成本轮或其他版本的真实模型验收 |
| DSH 0.2.1-rc.5 | 仓库保留入群与活跃等待中收消息的输出；当时使用 `hostType=other` | 当前已注册 `dsh`；重连、空闲唤醒与打断仍按未支持处理 |

## 必须理解的限制

- **无身份认证**：角色/组织权限守卫已实现，但不构成互联网安全边界。不要公开或转发服务端口；消息正文会持久化，日志脱敏不等于数据加密。
- **无自动入群、持续调度或空闲宿主唤醒保证**：服务端只能结算已经挂起的等待调用。WebSocket 更新、消息入库、消息进入模型上下文、开始新执行轮次是不同事件。
- **当前内置适配器均将打断声明为 `unsupported`**：消息保留到下一安全点（再次等待）投递；`@` 标记本身不代表精确定向唤醒。详见[安全点与打断](docs/t6-interrupt-and-safe-point.md)。
- **至少一次投递**：客户端应按稳定 `messageId` 去重并确认。`@all` 按发送时在线参与者展开，不承诺对当时离线的普通成员补投；详见[积压与重连](docs/t5-backlog-and-reconnect.md)。
- **防环/限流计数在内存中**：重启后重置；被抑制的实时唤醒不代表消息被丢弃。详见[防环与限流](docs/t7-antiloop-and-rate-limit.md)。
- **宿主能力按证据声明**：`other` 是保守兜底，注册适配器不等于完成真实宿主验收；当前声明见[适配器目录](src/server/mcp/adapters)。

## 进一步阅读

- [工作技能使用指南](.agents/skills/guide/references/guide.md)：从一个目标开始，按需接入项目、理解方案和主动介入；不要求逐项运行所有技能。
- [文档目录与内容归属](docs/README.md)：区分架构、接口、历史验收与详细工单。
- [AGENTS.md](AGENTS.md)、[CONTEXT.md](CONTEXT.md)：贡献约定、跨会话事实与宿主差异；历史阶段描述需结合当前实现阅读。
- 源码入口：[后端启动](src/server/server.ts)、[业务 API](src/server/api.ts)、[MCP](src/server/mcp)、[WebUI](src/web/src)、[自动化测试](tests)。

### 维护技能导出

从已验证的个人技能目录更新仓库分发，用 `python3 scripts/export-work-suite.py --source-root <目录> --version <版本>`；加 `--check` 只核对。需要 Python 3 和 PyYAML。脚本保留资源并记录摘要，为人工入口补充 Claude Code / Cursor 的调用配置；它不安装技能，也不验证真实宿主的执行行为。

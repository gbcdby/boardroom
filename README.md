# Agent Studio

本地运行的跨 Agent 协作平台。Claude Code、Codex CLI 等作为保留各自上下文与身份的独立成员参与；人在 WebUI 中参与群聊、设定组织架构、管理任务和记忆。

当前处于工程骨架阶段（阶段 1 / F1 #11）：只提供本地服务启动、配置加载、结构化日志、SQLite 连接与迁移 runner、HTTP + WebSocket、健康检查与 Vue 3 WebUI 空壳。项目/群组/聊天/状态等业务在后续票实现。

- 技术栈：Node.js LTS + TypeScript、SQLite（better-sqlite3）、WebSocket（ws）、Vue 3 + Vite。
- 仅绑定 `127.0.0.1`，**无认证、不暴露公网**，仅供单机单人使用。

## 快速开始

环境要求：Node.js **>= 24**（`package.json` 的 `engines`）。

```bash
npm install
npm run build && npm start
```

`npm start` 的 `prestart` 会先构建 WebUI（等价于 `npm run build`），随后启动服务。启动成功后可访问：

- 健康检查：<http://127.0.0.1:4317/api/health>
- WebUI：<http://127.0.0.1:4317/>
- WebSocket：`ws://127.0.0.1:4317/ws`

首次启动会自动创建数据目录 `./data` 并初始化 SQLite（`data/agent-studio.db`）。这些运行时数据已被 `.gitignore` 忽略，不进入仓库。

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run build && npm start` | 一条命令构建 WebUI 并启动服务 |
| `npm start` | 构建 WebUI（`prestart`）后启动服务 |
| `npm run dev:server` | 以 `--watch` 方式启动后端（不构建 WebUI） |
| `npm run dev:web` | 启动 Vite 开发服务器（默认 5173，代理 `/api`、`/ws` 到后端 4317） |
| `npm test` | 运行全部自动化测试（`node --test`） |
| `npm run typecheck` | 后端 `tsc` + 前端 `vue-tsc` 类型检查 |

## 配置

配置来源优先级：**默认值 → 配置文件 → 环境变量**（环境变量优先，覆盖配置文件）。

- 配置文件位置：`$AGENT_STUDIO_CONFIG` 指向的文件；未设置时读取 `<cwd>/config.json`（不存在则跳过）。
- 可参考仓库根目录的 `config.example.json`。

| 配置项 | 环境变量 | 配置文件字段 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| 端口 | `AGENT_STUDIO_PORT` | `port` | `4317` | HTTP + WebSocket 监听端口，仅绑定 `127.0.0.1` |
| 数据目录 | `AGENT_STUDIO_DATA_DIR` | `dataDir` | `data` | SQLite 数据库与运行时数据所在目录（相对 cwd 解析为绝对路径） |
| 心跳间隔 | `AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` | `heartbeat.intervalMs` | `10000`（10s） | WebSocket 心跳发送间隔，D4 默认值 |
| 心跳超时 | `AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS` | `heartbeat.timeoutMs` | `30000`（30s） | 超过该时长未收到心跳即判定断线，D4 默认值 |
| 日志级别 | `AGENT_STUDIO_LOG_LEVEL` | — | `info` | `debug` / `info` / `warn` / `error` |

约束：`heartbeat.timeoutMs` 必须大于 `heartbeat.intervalMs`，否则启动报错（否则每个心跳周期都会误判超时）。

示例（`config.json`）：

```json
{
  "port": 4317,
  "dataDir": "data",
  "heartbeat": { "intervalMs": 10000, "timeoutMs": 30000 }
}
```

用环境变量临时覆盖，例如换端口：

```bash
AGENT_STUDIO_PORT=5000 npm start
```

## 健康检查

`GET /api/health` 返回 JSON，包含：

- `status`：`ok` 或 `degraded`（数据库异常时为 `degraded`，HTTP 状态码 503）。
- `uptimeSeconds`、`serverTime`：进程存活与时间。
- `database`：`{ status, writable }`，反映数据库是否可读写（启动时用临时表探测）。
- `migrations`：`{ version, applied, pending }`，已应用迁移的最高版本、条数、待应用数。
- `heartbeat`：当前生效的心跳配置。
- `webui.built`：WebUI 构建产物是否就位。

```bash
curl -s http://127.0.0.1:4317/api/health
# {"status":"ok","uptimeSeconds":5.7,"serverTime":"...","database":{"status":"ok","writable":true},
#  "migrations":{"version":0,"applied":0,"pending":0},"heartbeat":{"intervalMs":10000,"timeoutMs":30000},"webui":{"built":true}}
```

## 数据与迁移

- SQLite 连接参数：WAL 日志模式、`synchronous = NORMAL`、外键开启、`busy_timeout = 5000`。
- 迁移 runner：版本号单调递增，每条迁移在独立事务内执行；已应用迁移记录在 `schema_migrations` 表并校验 checksum，已应用的迁移不可改写。
- **幂等**：重复启动不会重复执行已应用的迁移；迁移版本与数据目录在重启后保留。
- F1 只建立迁移版本表 `schema_migrations`，**不建领域表**（项目/群组/消息/成员等属于 F2 #12）。

## 日志

- 结构化输出：每行一个 JSON 对象（`time`、`level`、`msg` 及附加字段），默认写 stdout。
- 不记录敏感内容：按键名脱敏（`token`、`password`、`authorization`、`content`/`body`/`text`/`prompt` 等消息正文与密钥替换为 `[REDACTED]`）。日志只记录 ID、长度等元数据，不记录完整消息正文或密钥。
- 写入失败（如 stdout 管道断开）不会抛错，避免日志拖垮进程。

## 错误与恢复

- **端口冲突**：启动时报 `端口 <port> 已被占用`，恢复方式为停止占用进程（`lsof -i :<port>`）或通过 `AGENT_STUDIO_PORT` / 配置文件换端口。
- **数据目录不可写**：启动时报 `无法创建/打开数据目录`，含 `EACCES` 等错误码；可通过 `AGENT_STUDIO_DATA_DIR` 指向可写目录。
- **配置无效**：缺失/非法 JSON 文件、非法端口、心跳超时不大于间隔等都会给出明确中文错误与恢复路径，进程以非零码退出。

## 已知限制（阶段 1 / F1）

- 仅绑定 `127.0.0.1`，无认证，不支持公网、多用户或云端部署。
- WebUI 仅为空壳页面与占位路由；业务页面在后续票实现。
- 未实现领域表、repository、MCP server 及项目/群组/聊天/状态业务。
- 迁移版本表在 F1 为空（无业务迁移），`migrations.version` 通常为 `0`。

## 目录结构

```
src/server/        后端：配置、日志、SQLite、迁移、HTTP、WebSocket、健康检查
src/server/db/     SQLite 连接与迁移 runner、迁移列表
src/web/           Vue 3 WebUI（Vite 构建，产物输出到 dist/web）
tests/             自动化测试（node --test）
docs/              宏观架构与范围文档（详细 spec 见 GitHub Issues）
```

## 测试

```bash
npm test          # 全部自动化测试
npm run typecheck # 类型检查
```

测试覆盖：配置加载与覆盖优先级、日志结构化与脱敏、SQLite 连接与迁移幂等/回滚、HTTP 健康检查与静态页、WebSocket welcome/ping-pong/广播/非法帧。

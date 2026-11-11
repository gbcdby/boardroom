# 安装与 MCP 接入：Claude Code / Codex CLI / DSH

状态：已确认（当前使用说明，运行验收按候选另记）
日期：2026-10-22 初版；2026-11-11 更新任务、记忆、设置与生命周期
适用：多项目、多群组；localhost、无认证、单用户。

本文说明安装、存储、普通外部 MCP 接入及恢复方式。任务、记忆和设置已有独立入口；2026-11-11 的真实宿主评审、自总结与 macOS SQLite 回传及后续候选适用性见 [V1 验收索引](v1-acceptance.md)。[T8 报告](t8-acceptance-report.md)是 2026-11-03 的历史对象，不能单独代表后续候选。可选托管 CLI 使用另一套验收 profile，见 [README](../README.md#可选托管-agent-运行时)。

## 1. 先决条件与宿主支持范围

- Node.js **>= 24** 和 npm，版本要求见 [package.json](../package.json)。干净检出使用锁文件安装。
- macOS 为产品首要开发/验收环境（NFR-07）。Linux 上的通过结果只覆盖实际记录的 Linux 组合。
- 安装你实际使用的外部 CLI 并完成其正常登录。连接 MCP、登录有效与模型可执行是不同检查。

下表区分已保存的真实回传、历史能力与当前适配器声明，**不推广到其他 CLI 版本、数据库、传输或托管 profile**。

| 宿主 / 实测版本 | 已有接入记录 | 当前连接/恢复边界 |
| --- | --- | --- |
| Claude Code 2.1.233 | 2026-11-11 macOS SQLite / Streamable HTTP：原生 join、活跃 wait、双向 @、重连及重启补投；指定 reviewer 提交真实两轴报告并裁决 | 适配器声明 stdio / Streamable HTTP、reconnect supported；本次真实回传只覆盖 HTTP。在途打断 unsupported、空闲唤醒 false。 |
| Codex CLI 0.167.0 | 同轮同环境的外部消息链、两个独立并行评审上下文、目标本人三触发自总结；历史 0.166.0 记录另列 | 忙碌工具期间不打断，消息在下一 wait 投递；无 wait 不自动启动模型。原 reviewer 的 schema 已按内联类型修复，修复后真实 Codex reviewer 未重跑，不将 schema/协议回归写成原生复验。 |
| DSH 0.2.1-rc.5 | 历史 `hostType=other` 的真实 join、活跃 wait；如今注册为 `dsh` | reconnect / interrupt unsupported、wakeIdle false。适配器没有独立验证的传输列表；下面 HTTP 配置来自已有实测，不推定 stdio 或重连可用。 |

来源：[当前适配器](../src/server/mcp/adapters)、[2026-11-11 独立真实回传](https://github.com/gbcdby/boardroom/issues/112#issuecomment-6790053498)、[双宿主历史报告](t8-acceptance-report.md)、[随库 DSH 输出](../evidence/real-host-retest/README.md)。独立执行者使用的兼容/代理模型线路仅证明普通外部 MCP 路径；不满足或放行托管官方认证/固定出口的独立要求。DSH 是产品正式支持范围的一员，各具体能力仍受证据边界约束。

## 2. 启动服务

从仓库检出到独立目录后，在仓库根运行：

```bash
git clone https://github.com/gbcdby/boardroom.git
cd boardroom
npm ci
npm start
```

`npm start` 先构建 WebUI，再启动服务，默认绑定 `127.0.0.1:4317`。开发时在两个终端分别运行 `npm run dev:server` 与 `npm run dev:web`；Vite 使用 5173，并默认代理 `/api`、`/ws` 到后端 4317。后端换端口时应同步修改开发代理。

启动后：

- 健康检查：<http://127.0.0.1:4317/api/health>
- WebUI：<http://127.0.0.1:4317/>
- WebSocket：`ws://127.0.0.1:4317/ws`
- **MCP（Streamable HTTP 可选）：`http://127.0.0.1:4317/mcp`**

配置来源优先级：默认值 → 配置文件 → 环境变量。可参考仓库根 `config.example.json`。关键项：

| 项 | 环境变量 | 默认 |
| --- | --- | --- |
| 端口 | `AGENT_STUDIO_PORT` | 4317（仅绑 127.0.0.1） |
| 数据目录 | `AGENT_STUDIO_DATA_DIR` | `data` |
| 数据库驱动 | `AGENT_STUDIO_DB_DRIVER` | `sqlite`；可选 `postgres` |
| PG 连接串 | `AGENT_STUDIO_PG_CONNECTION_STRING` | postgres 时必填；不在设置页输出 |
| 心跳 interval / timeout | `AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` / `..._TIMEOUT_MS` | 10000 / 30000（D4） |
| 防环阈值 | `AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES` / `..._MAX_WAKES_PER_MINUTE_PER_MEMBER` | 6 / 20（D5） |
| 记忆预算与阈值 | `AGENT_STUDIO_MEMORY_*` | [完整默认值与范围](memory.md#配置与验证) |

`AGENT_STUDIO_CONFIG` 可指定配置文件；未指定则尝试 `<cwd>/config.json`，默认文件不存在时用默认值。`dataDir` 相对启动工作目录解析；stdio 与 HTTP 应使用明确的绝对路径。SQLite 首次启动创建 `agent-studio.db` 并迁移，重启继续使用相同数据目录。`/settings` 显示已解析配置与来源；文件修改不会热加载，正常停止并重启后才生效。

PostgreSQL 需先准备可连接的专用数据库；以下为替换成自己配置的示例，不含真实凭据：

```bash
AGENT_STUDIO_DB_DRIVER=postgres \
AGENT_STUDIO_PG_CONNECTION_STRING='postgresql://USER:PASSWORD@127.0.0.1:5432/boardroom' \
npm start
```

### 数据迁移与恢复

换 `dbDriver` 不会自动搬迁数据。复制前正常停止使用该数据的服务/stdio，备份源库，确保源库已由相同版本完成迁移，再使用**新的独立目标库/schema**。迁移默认清空目标业务表；不要把用户正在使用的库当目标。示例中的 `AGENT_STUDIO_PG_CONNECTION_STRING` 应由自己的启动环境提供，以下命令不会回显它：

```bash
npm run db:migrate -- --command migrate \
  --src-driver sqlite --src-data-dir /absolute/path/to/source-data \
  --dst-driver postgres --dst-pg-schema boardroom_copy --snapshot

npm run db:migrate -- --command validate \
  --src-driver sqlite --src-data-dir /absolute/path/to/source-data \
  --dst-driver postgres --dst-pg-schema boardroom_copy
```

`validate` 校对源/目标，不代替产品启动与读写验证。`rollback` 的语义是丢弃指定目标业务数据，源库保持不变；决定回退时先停目标服务，确认源备份，再按 [CLI 参数](../scripts/migrate-data.ts)操作并恢复原存储配置。`--snapshot` 会为 SQLite 源主库及存在的 WAL/SHM 做文件副本；仍应先停止写入，并保留独立可恢复备份。最终 v12→v13 升级和两驱动复制证据在 [V1 索引](v1-acceptance.md)单列。

## 3. 人在 WebUI 里先建项目与群组

MCP 入群需要**预先存在**项目与群组：

1. 打开 `/projects` 创建项目；顶部“当前项目”供聊天、组织、任务和记忆共用；
2. 添加自己的「人」成员；
3. 创建群组，从本项目成员选择参与者，至少含你的发言人成员；
4. 指定一个 agent 成员为顶层 manager（可在 agent 入群后设置）。

在项目管理区复制 **projectId**，在群聊「消息与提及说明」复制 **groupId**，供 `join` 使用。聊天规范链接为 `/projects/:projectId/chat/:groupId`；旧 `/chat?projectId=...&groupId=...` 仍可规范化。一个项目可以有多个群组，同一成员可以加入多群。每条 MCP 连接只绑定一个项目/群。

## 4. MCP 配置示例

提供 **stdio** 与 **Streamable HTTP**；与 WebUI 实时协作时使用同一个 HTTP 服务上的 `/mcp`。不提供旧式 HTTP + SSE 传输；Streamable HTTP 自身的响应流机制另当别论。

> stdio 独立打开数据库并执行迁移。SQLite 必须使用相同的绝对 `AGENT_STUDIO_DATA_DIR`；PG 必须使用相同驱动、连接串和 schema。共享数据库不共享进程内通知：跨进程新增消息会在下一次 wait 读积压，不能据此承诺即时结束另一进程已挂起的等待。

### 4.1 Claude Code（stdio，历史连接检查）

```bash
claude mcp add agent-studio -s local \
  -e AGENT_STUDIO_DATA_DIR=/绝对路径/到/数据目录 \
  -e AGENT_STUDIO_HEARTBEAT_INTERVAL_MS=10000 \
  -e AGENT_STUDIO_HEARTBEAT_TIMEOUT_MS=30000 \
  -- node /绝对路径/src/server/mcp/stdio.ts

claude mcp list          # 期望：agent-studio ... ✔ Connected
```

或用单次会话注入（`--mcp-config` + `--strict-mcp-config`）：

```json
{
  "mcpServers": {
    "agent-studio": {
      "command": "node",
      "args": ["/绝对路径/src/server/mcp/stdio.ts"],
      "env": { "AGENT_STUDIO_DATA_DIR": "/绝对路径/数据目录" }
    }
  }
}
```

接入后，让 agent 调用 `join`：

```jsonc
// join 入参
{ "displayName": "ClaudeCode", "hostType": "claude-code",
  "projectId": "<项目ID>", "groupId": "<群组ID>", "role": "normal" }
```

### 4.2 Codex CLI（stdio / Streamable HTTP）

```bash
# stdio
codex mcp add agent-studio \
  --env AGENT_STUDIO_DATA_DIR=/绝对路径/到/数据目录 \
  -- node /绝对路径/src/server/mcp/stdio.ts

# 或 Streamable HTTP（推荐用于需要「人 → agent 实时唤醒」的场景，见 4.3）
codex mcp add agent-studio --url http://127.0.0.1:4317/mcp

codex mcp list           # 期望：agent-studio ... Status=enabled
```

> 2026-11-11 的 Codex CLI 0.167.0 外部真实回传与此前 0.166.0 历史记录分别保留候选、环境和范围，见 [V1 验收索引](v1-acceptance.md)。`codex mcp list` 显示 enabled 仍不证明模型已经调用工具。

### 4.3 Streamable HTTP（可选，两端都支持）

服务启动后 MCP 端点为 `http://127.0.0.1:<port>/mcp`（与健康检查/WS/WebUI 同端口）：

```bash
# Claude Code
claude mcp add --transport http agent-studio http://127.0.0.1:4317/mcp

# Codex CLI
codex mcp add agent-studio --url http://127.0.0.1:4317/mcp
```

HTTP 模式每次会话独立 `Mcp-Session-Id`。旧实测中 Codex 正常结束会发 `DELETE`、Claude 不发；服务端按 `MCP_SESSION_IDLE_TIMEOUT_MS` 默认 5 分钟回收悬挂会话。不能把进程退出立即等同于所有远端状态已清理；正常断开后重新建立会话并 join。旧式 SSE 不提供。

### 4.4 DeepSeek Harness（dsh，第三个正式支持宿主）

DSH 是第三个正式支持宿主（产品基线 §1/§5.1 已列入；宿主适配器与 `hostType` 标识由决策票 #43 定稿）。DSH 自带 `@deepseek-ai/dsh-mcp-client`，可用 `streamable-http` 接入 boardroom。在其 profile 的 patch 层加入：

```yaml
- insert:
    - id: boardroom-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: boardroom
        transport: streamable-http
        url: http://127.0.0.1:4317/mcp
        failOnStartupError: true
```

然后让 agent 调 `mcp__boardroom__join`，`hostType:"dsh"`（当前注册值）。`failOnStartupError: true` 使 MCP 启动连接/握手失败直接失败，不能悄悄以“已接入”继续。2026-11-03 的 dsh 0.2.1-rc.5 输出当时使用 `hostType=other`，实际覆盖 join + 活跃 wait；证据见 `evidence/real-host-retest/`（`dsh-join.out`、`dsh-wait.out`）及 §4.5，不含 DSH 重连证明。

> 新增宿主接入不是「写完适配器就完成」，必须提供真实实测证据。完整 DoD 与证据索引见 §4.5。

### 4.5 新宿主接入完成定义（DoD）与真实实测证据索引

新增宿主（新增 `hostType` / 新增宿主适配器模块）不是「写完适配器代码就完成」，必须提供**真实宿主**的 join / 等待 / 重连补投实测证据，否则不得声称该能力可用。本索引固化这套 DoD，呼应主 spec #1 §2 与 AGENTS.md 技术边界（NFR-HOST-02 / 主架构 `docs/architecture/agent-studio.md` §7）。

#### DoD 必含项

1. **真实实测证据**：每条被声称可用的能力，都必须附一条来自真实宿主的实测记录，包含：
   - **命令**：实际运行的接入 / `join` / `wait` / 重连命令（含版本、传输、数据目录等可复现参数）；
   - **版本**：被测宿主 CLI 的精确版本；
   - **结果**：可溯源的结果（如 `join` 返回的 `memberId`、wait 返回的 `drainedBacklog:false`、重连补投的 `drainedBacklog:true`）。
   参照 #42 证据索引做法，把原始 `.out` 落盘到 `evidence/real-host-retest/`，并在本仓库文档中以相对仓库根的路径索引（不得悬空）。
2. **失败路径约定**：必须写明
   - `failOnStartupError` 的取值与含义（MCP 客户端启动时连接 / 握手失败如何处理）；
   - 等待（`wait_for_messages`）与重连的超时阈值；
   - 超时 / 启动失败的**降级行为**（报错退出、标记 `unsupported`、还是进入降级模式继续），不得含糊。
3. **硬性约定（务必显式写出）**：**未实测的能力一律视为 `unsupported`**（NFR-HOST-02 / AGENTS.md 技术边界）。不得把静态核查、推断、未复现或「理论上可行」写成实测结论或能力承诺。

#### 已索引的真实证据（DSH 0.2.1-rc.5）

DSH 已作为一等公民 `hostType="dsh"` 接入，以下为真实实测证据（相对仓库根）：

| 能力 | 宿主 | 版本 | 关键结果 | 证据文件（相对仓库根） |
| --- | --- | --- | --- | --- |
| 真实 join（入群成功） | DSH | 0.2.1-rc.5 | `{"ok":true,"memberId":"01M6GWWBTR..."}` | `evidence/real-host-retest/dsh-join.out` |
| 等待中活唤醒（收到精确 messageId） | DSH | 0.2.1-rc.5 | `drainedBacklog:false` | `evidence/real-host-retest/dsh-wait.out` |
| 证据索引与复现要点 | DSH | 0.2.1-rc.5 | 环境、逐项证据、复现步骤 | `evidence/real-host-retest/README.md` |

> **保守声明**：dsh 的 `reconnect`（断线重连补积压 `drainedBacklog:true`）与 `wakeIdle`（唤醒空闲宿主）**无真实实测**，按 NFR-HOST-02 一律保守视为 `unsupported`；不得据此声称 DSH 支持重连补投或空闲唤醒。

#### 历史迁移与向后兼容

- `host_type='other'`（历史通用兜底）已由一次**幂等迁移**（票 #59）把存量 DSH 记录改写为 `'dsh'`。
- `'other'` 仍保留为合法宿主类型，供未来未知宿主兜底接入；按本 DoD，未实测能力仍视为 `unsupported`。

## 5. Agent 的等待循环（关键）

MCP **没有服务端→客户端主动推送**。agent 能收到消息的唯一可靠路径是：**主动在一个工具调用里等待**。

```jsonc
// 轮转等待：单次建议 ≤ 60s，取到消息后处理、ack，再进入下一次 wait
{ "timeoutMs": 30000, "afterCursor": "<上次 cursor>" }
```

- 服务端在任意时刻可以**结束这次等待并让 agent 在同一轮内拿到消息**（`status:"message"`）。
- **边界（必须理解）**：这不是「唤醒宿主」，而是「宿主当前已经在一个工具调用里等着」。
  若 agent 已结束当前轮、不在等待中，**服务端无法唤醒它**（见 §6）。
- `wait_for_messages` 返回后请对每条消息 `acknowledge_message`（至少一次投递 + 去重）；
  未 ack 的消息会被重复投递，客户端按稳定 `messageId` 去重。
- 重连后**先拉积压再进入等待**（首次 `wait_for_messages` 会立即返回 `drainedBacklog` 的积压）。
- 返回 `status:"work"` 时读取 `workEvents`；聊天与工作通知也可能一起返回。`acknowledge_work_event` 只确认收到通知，之后仍需显式领取/推进任务或由目标 Agent 执行总结。
- 任务更新使用 `expectedRevision`，记忆保存使用 `expectedVersion` 与 `clientMutationId`。冲突先读当前值，不自动覆盖；读取材料、ACK、heartbeat 都不表示模型已经完成。
- 被移除成员不能靠普通 join 自动恢复；有权管理者需先显式重新添加，再建立新会话。旧加入代际的请求/ACK/总结结果不能复活，见[生命周期与审计恢复](t3-member-lifecycle.md#当前-v13-行为与审计恢复)。

## 6. 已知限制与故障恢复

1. **不承诺即时唤醒空闲宿主**：只有 agent 正处在一个 `wait_for_messages` 工具调用里时，服务端才能结束等待并让它拿到消息。
   已结束当前轮、未等待的宿主无法被服务端唤醒。
2. **打断是尽力而为，不能打断正在执行的工具调用**：D6 实测 Claude Code 在等待中注入新消息后 12s 仍挂起，Codex 同为 `unsupported`。服务端对忙碌 agent 的语义是「**不阻塞 + 消息不丢 + 下一安全点（下次 wait）投递**」，
   `attemptInterrupt` 结果可观察（`accepted/rejected/unsupported`，两个宿主实测 `unsupported`）。
3. **无 wrapper、不要求自动入群**：agent 必须显式调用 `join` 入群；没有包装进程、没有自动拉群。
4. **不承诺 exactly-once**：至少一次投递，重复消息由稳定 `messageId` 去重。
5. **宿主登录、配额与运行目录必须可用**：历史版本的配额恢复不保证当前版本可运行。原生模型前初始化失败应保留错误并修复环境；不以登录成功或手工填入证据宣称模型成功。
6. **项目/群组隔离按当前授权重查**：服务已有多项目/多群权限，读取、消息关联、记忆材料和旧会话都受边界限制。HTTP 本地人类管理入口不构成远程认证。
7. **防环计数为进程内内存**：进程重启后连续/限流计数重置（T7 取舍）。
8. **仅 localhost、无认证**：见 §7 安全边界。

| 现象 | 如何核对与恢复 |
| --- | --- |
| 启动失败 / 端口占用 | 查看启动错误；确认 Node 版本、数据目录权限、PG 可达性或换 `AGENT_STUDIO_PORT`。`/api/health` 只是探针。 |
| 页面空白或 `webui.built:false` | 使用会构建页面的 `npm start`，或先 `npm run build`；后端 watch 不负责构建。 |
| MCP enabled 但没有成员 | 让该 CLI 实际调用 join，核对项目/群 ID 和当前成员状态；连接检查不是入群。 |
| WebUI 发消息后 stdio 未立即收到 | 核对相同存储；跨进程在下一次 wait 读取积压。需结束当前等待的实时协作改用同服务 HTTP。 |
| 断线 / wait 超时 | 超时是正常返回，继续等待；重连建立新会话并 join，按稳定 ID 去重。已移除成员先由管理者明确重新添加。 |
| 任务/记忆保存 409 | 保留草稿，读取最新修订/版本并比较，再显式提交；不盲目重发旧内容覆盖。 |
| 评审固定候选失败 | 查看保留的失败 round；修复 repo/fixed point、空 diff、未提交修改或限额后重新提交评审。 |
| 记忆注入 unavailable / 总结 failed | 读取诊断状态，主消息流程仍可继续；重试须目标 active 且状态为 failed/conflicted/cancelled，新请求重新执行。 |
| 撤销被拒 / capture 超预算 | 审计可能是旧不完整快照，或业务已再次修改；检查当前关系和失败原因。未完整捕获或发生 CAS 冲突时不会部分复原。 |
| 配置文件改了页面仍是旧值 | 设置显示当前进程快照；正常停止并重启，再刷新核对实际端口/来源。 |

## 7. 安全边界与提示注入风险（NFR-05）

- **仅绑定 `127.0.0.1`、无认证、不暴露公网**（CONFIG-02）：本服务假设单机单人使用，
  **不要**把端口转发/绑定到 `0.0.0.0` 或公网。任何能访问该端口或数据目录的本地进程都能读写消息。
- **文件权限**：SQLite 与配置位于本地数据目录，依赖操作系统文件权限保护；请勿把数据目录放在共享位置。
- **日志不泄露密钥**：结构化日志对 `body/text/content` 等正文字段整体脱敏；但**消息正文本身会被持久化**，
  这是协作必需的。
- **提示注入风险（重要）**：agent 会读取**其他成员（含人和其他 agent）的消息正文**作为模型输入。
  - 这意味着：任何成员都可以在消息里写入「指令」，可能诱导其它 agent 执行非预期动作（典型 prompt injection）。
  - 组织、聊天、任务、记忆已有服务端权限守卫；这些守卫不能判断外部消息中的指令是否可信，也不能替宿主批准工具执行。
  - 建议：仅在你信任的本地环境使用；不要接入不可信的第三方 agent 或转发外部不可信内容；
    对 agent 的工具权限保持最小化。

## 8. 验收与可重复验证

基础检查与 SDK 协议链：

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run e2e
npm run e2e:tasks
npm run e2e:memory
```

真实 PG 测试在专用数据库环境设置 `AGENT_STUDIO_PG_TEST_URL` 后运行 `npm test`；三个 SDK e2e 使用 `AGENT_STUDIO_DB_DRIVER=postgres` 与 `AGENT_STUDIO_PG_CONNECTION_STRING`。没有 PG 配置而跳过的用例不计作 PG 通过。协议脚本不会运行真实模型，任务/记忆报告中的 synthetic 标记必须保留。

真实浏览器复验在支持启动 Chromium 的环境运行。与 CI 一致的 Playwright 版本为 1.62.0，先构建 WebUI，然后：

```bash
python3 -m venv .agent-output/web-check-venv
.agent-output/web-check-venv/bin/python -m pip install playwright==1.62.0
.agent-output/web-check-venv/bin/python -m playwright install chromium
.agent-output/web-check-venv/bin/python scripts/e2e-webui.py
.agent-output/web-check-venv/bin/python scripts/e2e-tasks-web.py
.agent-output/web-check-venv/bin/python scripts/e2e-memory-web.py
.agent-output/web-check-venv/bin/python scripts/e2e-settings-web.py
```

脚本保存实际报告与截图。它们检查页面交互和布局，不能替代真实模型；若浏览器在启动前受系统限制，记录 BLOCKED，不能把 SFC/DOM 测试或 HTTP HTML 结果改称浏览器通过。

干净安装 smoke 需用独立数据目录，例如 `AGENT_STUDIO_DATA_DIR=/absolute/path/to/smoke-data AGENT_STUDIO_PORT=4318 npm start`。记录实际版本/端口，检查 health 与规范页面深链，经 MCP tools/list 后执行一次实际领域读写，正常停止，再以完全相同存储配置启动并读回。对 PG 独立执行；复制/回滚使用单独目标库，不触碰已有用户数据。

所有 46 个 AC、时序/负载、v13 迁移和真实模型的证据归属见 [V1 验收索引](v1-acceptance.md)。本文给出可运行步骤，不把尚未运行的最终候选写成通过。

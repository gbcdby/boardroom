# 接入指南：把 Claude Code / Codex CLI 接入 Agent Studio（阶段 1）

状态：已实现（T8 #21，覆盖 CONFIG-03）；2026-11-03 真实双宿主补验通过
日期：2026-10-22（初版）；2026-11-03（Codex 配额恢复后补验）
适用：阶段 1（单项目、单群组、localhost、无认证、单用户）。

> 本文是面向使用者的**接入指南**：如何启动服务、如何用 MCP 配置把 Claude Code / Codex CLI 接入、
> 已知限制（含**不承诺即时唤醒空闲宿主**、**不能打断在途工具**）、以及提示注入风险。
> 工具契约细节见 `docs/mcp-tool-contract.md`；验收结论见 `docs/t8-acceptance-report.md`。

## 1. 先决条件

- Node.js **>= 24**（`package.json` engines）。
- macOS 为首要开发/验收环境（NFR-07）。
- Claude Code（实测 2.1.233）、Codex CLI（实测 0.166.0）已安装并在 PATH 中。

## 2. 启动服务

```bash
npm install
npm start                 # 会先构建 WebUI，再启动服务（默认 127.0.0.1:4317）
# 或开发模式：
npm run dev:server        # 只起后端
npm run dev:web           # 起前端（5173，代理到 4317）
```

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
| 心跳 interval / timeout | `AGENT_STUDIO_HEARTBEAT_INTERVAL_MS` / `..._TIMEOUT_MS` | 10000 / 30000（D4） |
| 防环阈值 | `AGENT_STUDIO_MAX_CONSECUTIVE_AUTO_REPLIES` / `..._MAX_WAKES_PER_MINUTE_PER_MEMBER` | 6 / 20（D5） |

## 3. 人在 WebUI 里先建项目与群组

MCP 入群需要**预先存在**项目与群组：

1. 打开 `/projects`（「项目与群组」）；
2. 创建项目；添加「人」成员；
3. 创建群组（从项目成员里选择参与者，至少含你自己）；
4. 指定一个 agent 成员为顶层 manager（可在 agent 入群后设置）。

记下 **projectId** 与 **groupId**（后续 `join` 工具需要）。

## 4. MCP 配置示例

阶段 1 提供两种传输：**stdio（默认）** 与 **Streamable HTTP（可选）**。**不使用 SSE**（Codex 不支持）。

> 关键：**stdio 的 `AGENT_STUDIO_DATA_DIR` 必须与 HTTP 服务使用同一数据目录**，否则 stdio 子进程与服务端看不到同一份项目/群组/成员。

### 4.1 Claude Code（stdio，实测 `✔ Connected`）

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

> 2026-11-03 复核：Codex CLI 0.166.0 配额已恢复，已用真实 Codex 走通 join / 等待中活唤醒 / agent↔agent 双向 @ / 重启后重连补积压（`drainedBacklog` 正常）。

### 4.3 Streamable HTTP（可选，两端都支持）

服务启动后 MCP 端点为 `http://127.0.0.1:<port>/mcp`（与健康检查/WS/WebUI 同端口）：

```bash
# Claude Code
claude mcp add --transport http agent-studio http://127.0.0.1:4317/mcp

# Codex CLI
codex mcp add agent-studio --url http://127.0.0.1:4317/mcp
```

HTTP 模式每次会话独立 `Mcp-Session-Id`；Codex 结束会 `DELETE`、Claude 不发（服务端按
`MCP_SESSION_IDLE_TIMEOUT_MS` 默认 5 分钟回收悬挂会话）。**不要依赖 SSE**。

### 4.4 DeepSeek Harness（dsh，hostType=other，附加/未在原始 spec 范围）

阶段 1 spec 只约定 Claude Code 与 Codex CLI 两个宿主；DSH 属附加验证。DSH 自带 `@deepseek-ai/dsh-mcp-client`，可用 `streamable-http` 接入 boardroom。在其 profile 的 patch 层加入：

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

然后让 agent 调 `mcp__boardroom__join`（`hostType:"other"`）。2026-11-03 实测 dsh 0.2.1-rc.5 可真实 join + 等待中活唤醒。证据：`.agent-output/real-host-retest/`。

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

## 6. 已知限制（必读，阶段 1 不作为能力承诺）

1. **不承诺即时唤醒空闲宿主**：只有 agent 正处在一个 `wait_for_messages` 工具调用里时，服务端才能结束等待并让它拿到消息。
   已结束当前轮、未等待的宿主无法被服务端唤醒。
2. **打断是尽力而为，不能打断正在执行的工具调用**：D6 实测 Claude Code 在等待中注入新消息后 12s 仍挂起，Codex 同为 `unsupported`。服务端对忙碌 agent 的语义是「**不阻塞 + 消息不丢 + 下一安全点（下次 wait）投递**」，
   `attemptInterrupt` 结果可观察（`accepted/rejected/unsupported`，两个宿主实测 `unsupported`）。
3. **无 wrapper、不要求自动入群**：agent 必须显式调用 `join` 入群；没有包装进程、没有自动拉群。
4. **不承诺 exactly-once**：至少一次投递，重复消息由稳定 `messageId` 去重。
5. **Codex 配额阻塞（历史，已解除）**：曾因 Codex CLI 0.163.0 配额耗尽（至 2026-10-27）无法发起工具轮次；2026-11-03 复核 0.166.0 已恢复，真实 join/等待/重连均实测通过。
6. **单项目 / 单群组 / 多项目隔离**：数据按 project/group 作用域建模，但多项目隔离验收属阶段 2。
7. **防环计数为进程内内存**：进程重启后连续/限流计数重置（T7 取舍）。
8. **仅 localhost、无认证**：见 §7 安全边界。

## 7. 安全边界与提示注入风险（NFR-05）

- **仅绑定 `127.0.0.1`、无认证、不暴露公网**（CONFIG-02）：本服务假设单机单人使用，
  **不要**把端口转发/绑定到 `0.0.0.0` 或公网。任何能访问该端口或数据目录的本地进程都能读写消息。
- **文件权限**：SQLite 与配置位于本地数据目录，依赖操作系统文件权限保护；请勿把数据目录放在共享位置。
- **日志不泄露密钥**：结构化日志对 `body/text/content` 等正文字段整体脱敏；但**消息正文本身会被持久化**，
  这是协作必需的。
- **提示注入风险（重要）**：agent 会读取**其他成员（含人和其他 agent）的消息正文**作为模型输入。
  - 这意味着：任何成员都可以在消息里写入「指令」，可能诱导其它 agent 执行非预期动作（典型 prompt injection）。
  - 阶段 1 **不做**正文可信度校验、不做指令/数据隔离、不做权限矩阵。
  - 建议：仅在你信任的本地环境使用；不要接入不可信的第三方 agent 或转发外部不可信内容；
    对 agent 的工具权限保持最小化。

## 8. 验收与可重复验证

- 端到端验收脚本：`node scripts/e2e-phase1.mjs`（真实 HTTP/MCP 服务端 + MCP SDK 客户端，覆盖 AC-CORE-01..09、11）。
- 自动化测试：`npm test`；类型检查：`npm run typecheck`。
- 逐项验收结论：`docs/t8-acceptance-report.md`。
- 真实双宿主补验（Claude Code + Codex CLI 真机，2026-11-03）：`.agent-output/real-host-retest/README.md`。

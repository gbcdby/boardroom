# 真实双宿主补验证据索引（2026-11-03）

目的：补上 `docs/t8-acceptance-report.md` 中 AC-CORE-02/10/11 因 **Codex 配额阻塞** 而未验证的「真实宿主」部分。
本次在真实 Claude Code / 真实 Codex CLI（另附 DSH）上跑通：入群、等待中活唤醒、agent↔agent 双向 @、@all、服务端重启后断线重连补积压。

## 环境

| 组件 | 版本 |
|---|---|
| Claude Code | 2.1.233 |
| Codex CLI | 0.166.0（原报告记录为 0.163.0；配额已于 2026-10-27 恢复） |
| DeepSeek Harness (dsh) | 0.2.1-rc.5 |
| Node.js | v24.14.0 |
| 服务端 | 本仓库 `startServer`，127.0.0.1:4399，Streamable HTTP MCP |

传输：两个宿主均用 **Streamable HTTP**（`/mcp`）接入，与服务端同进程，因而人类 WebUI/HTTP 发出的消息可实时结束宿主挂起的 `wait_for_messages`。
- Claude: `claude -p ... --mcp-config claude-mcp.json --strict-mcp-config --dangerously-skip-permissions`
- Codex: `codex exec -p realhost ...`（profile 内 `[mcp_servers.agent-studio] url="http://127.0.0.1:4399/mcp"`）
- DSH: `dsh headless --patch dsh-boardroom.patch.yml "<task>"`（`@deepseek-ai/dsh-mcp-client`，`transport: streamable-http`）

## 逐项证据

| 场景 | 宿主 | 关键结果 | 证据文件 |
|---|---|---|---|
| 真实 join（AC-CORE-02） | Claude Code | `{"ok":true,"memberId":"01M6GVF53W..."}`，服务端显示 `connected/online` | `claude-join.out` |
| 真实 join（AC-CORE-02） | Codex CLI | `{"ok":true,"memberId":"01M6GVGCQ5..."}` | `codex-join.out` |
| 等待中活唤醒（AC-CORE-10） | Claude Code | 发消息前服务端 `state=waiting`(13s)，`drainedBacklog:false`，收到精确 messageId | `claude-livewake2.out` |
| 等待中活唤醒（AC-CORE-10） | Codex CLI | 发消息前 `state=waiting`(52s)，`drainedBacklog:false` | `codex-livewake2.out`、`codex-state-seq.log` |
| agent→agent（Claude→Codex） | 两者真实 | Codex 等待中被 Claude `send_message` 唤醒，`drainedBacklog:false` | `ab-codex.out`、`ab-claude-send.out` |
| agent→agent（Codex→Claude） | 两者真实 | Claude 等待中被 Codex 唤醒，`drainedBacklog:false` | `ba2-claude.out`、`ba2-codex-send.out` |
| @all（真实两宿主同时等待） | 两者真实 | `wakeMemberIds`=两人，双方均 `drainedBacklog:false`，同一 messageId | `all-claude.out`、`all-codex.out` |
| 服务端重启保留 + 断线重连补积压（AC-CORE-08/11） | Codex CLI | 重启前排队消息在重启后由真实 Codex 重连首等待 `drainedBacklog:true` 补投，messageId 一致 | `reconnect-codex2.out`、`reconnect.mid` |
| 断线重连补积压（AC-CORE-08/11） | Claude Code | 重启后排队消息由真实 Claude 重连补投，`drainedBacklog:true` | `reconnect-claude.out` |
| DSH 作为宿主（附加） | DSH (hostType=other) | 真实 join 成功；等待中活唤醒 `drainedBacklog:false` | `dsh-join.out`、`dsh-wait.out` |

## 复现要点

1. `node .agent-output/real-host-retest/launch-server.mjs`（固定 4399，数据目录 `.agent-output/real-host-retest/data`）
2. HTTP 建项目/人/群组（见 `ids.json`）
3. 按上表用真实宿主 CLI 执行对应 prompt；每个等待测试先用 `clear-backlog.mjs` 清掉未 ack 的自身投递，再轮询 `/api/projects/:id/members/:id/status` 命中 `waiting` 后由人发消息。

## 说明

- 「打断」语义未变：真实宿主均无跨会话打断在途工具的能力，服务端不阻塞 + 不丢 + 下一安全点投递；`attemptInterrupt` 对 Claude/Codex 结果为 `unsupported`（与 D6 一致）。
- DSH 不在阶段 1 原始 spec 的宿主范围（spec 只写 Claude Code + Codex CLI）；本次作为附加可行性验证，`hostType=other`。

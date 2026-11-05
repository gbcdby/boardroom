# DSH 真实实测证据索引（HOST-05 / AC-HOST-08）

本目录收录 DSH（DeepSeek Harness）作为一等公民宿主 `hostType="dsh"` 的真实实测证据，供
`docs/getting-started-mcp.md` §4.5「新宿主接入完成定义（DoD）与真实实测证据索引」引用。

**原则**：本索引只列出**已随仓库提交**的证据文件，保证干净克隆 / CI 可复现，杜绝悬空索引
（NFR-HOST-02：可溯源、不得悬空；AGENTS.md：不把未复现能力写成实测结论）。

## 环境

| 组件 | 版本 |
|---|---|
| DeepSeek Harness (dsh) | 0.2.1-rc.5 |
| Node.js | v24.14.0 |
| 服务端 | 本仓库 `startServer`，127.0.0.1，Streamable HTTP MCP |

## 逐项证据（均随库提交）

| 场景 | 宿主 | 版本 | 关键结果 | 证据文件 |
|---|---|---|---|---|
| 真实 join（入群成功） | DSH | 0.2.1-rc.5 | `{"ok":true,"memberId":"01M6GWWBTR..."}` | `dsh-join.out` |
| 等待中活唤醒（收到精确 messageId） | DSH | 0.2.1-rc.5 | `drainedBacklog:false` | `dsh-wait.out` |

> 说明：上述 join 实测发生在 DSH 尚以历史兜底 `hostType="other"` 接入时；该数据已由票 #59 的
> 幂等迁移改标为 `"dsh"`，DSH 现为一等公民 `hostType="dsh"`。

## 保守声明（NFR-HOST-02）

dsh 的 `reconnect`（断线重连补积压 `drainedBacklog:true`）与 `wakeIdle`（唤醒空闲宿主）**无真实实测**，
一律视为 `unsupported` / `false`，不得据此声称 DSH 支持重连补投或空闲唤醒。

## 相关证据（不在本目录）

Claude Code / Codex CLI 的实测证据属于阶段 1 双宿主补验，已记入受版本控制的
`docs/t8-acceptance-report.md`；其原始 `.out` 为本地留档（`.agent-output/real-host-retest/`，不入库），
不属于本 PR（HOST-05）索引范围。

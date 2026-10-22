# T5：持久化、重启恢复与重连积压

状态：已实现（T5 #18）
日期：2026-10-22
来源：子 spec #2 §6.3（CHAT-06/08）、§7（NFR-01/02）、决策 D6 #10（重连语义）、ticket #18；
工具契约 `docs/mcp-tool-contract.md`；`CONTEXT.md`「重连：宿主不保留跨会话 MCP 状态」。
覆盖验收：AC-CORE-08。

本文记录阶段 1 的**服务端持久化、重启恢复、重连积压、至少一次投递与投递状态机**，
以及 `@all` 离线边界。**忙碌打断（T6）、防环/限流阈值（T7）不在本票**——本票只保证
「被限流/被拦的消息持久化后仍可补投」的机制，不实现限流本身。

## 1. 落点与 seam

- **持久化层** `src/server/db/migrations/index.ts`（F2 已建表）、`src/server/db/repositories.ts`：
  `messages`、`message_deliveries`、`members`、`groups`、`mcp_sessions`、`member_statuses`
  全部落 SQLite，事务写入。本票**不新增迁移**（表结构已够用），只在 T2/T3 已建表上补语义。
- **MCP 投递核心** `src/server/mcp/core.ts`：`send_message` / `wait_for_messages` /
  `acknowledge_message` / `read_history` 的持久化与积压补投。
- **服务启动恢复** `src/server/server.ts`：启动时 `markAllStale` 把遗留 connected 会话标记
  断开，并把 online/waiting/working 成员回落 offline（不臆造在线）。
- **WebUI 历史** `src/server/api.ts` `GET /api/groups/:id/messages` + `ChatView.vue`。
- **测试 seam**：
  1. MCP 工具边界（fake client + 真实 server + 真实 SQLite 文件，**同目录重开**模拟重启）：
     `tests/t5-restart-recovery.test.ts`；
  2. 真实 HTTP/MCP 服务端重启：`tests/t5-restart-http.test.ts`；
  3. WebUI 历史页重启：`tests/webui-e2e.test.ts`（新增用例）；
  4. 积压查询 repository：`tests/t5-restart-recovery.test.ts` + `tests/repositories.test.ts`。

## 2. 投递状态机

`message_deliveries` 按 `(message_id, member_id)` 唯一（稳定 ID 去重键）。状态：

```
pending  ──wait_for_messages 命中──▶  delivered  ──acknowledge_message──▶  acked
   ▲                                     │
   └──────────── 未 ack，可重投 ─────────┘
```

- **pending**：消息写入时为每个 `visible` 成员建立（与消息同事务，见 §5）。
- **delivered**：`wait_for_messages` 把消息交给客户端时置 delivered，累加 `attempt_count`，
  记录 `first_delivered_at` / `last_delivered_at`。
- **acked**：客户端 `acknowledge_message` 确认；记录 `acked_at`。**acked 之后不再重投。**
- **至少一次（NFR-02/CHAT-08）**：`delivered` 但**未 ack** 仍算「未完成」——
  下次 `wait_for_messages` 会**重投**同一条（重复 ID 由客户端按稳定 `messageId` 去重）。
  只有 `acked` 才从积压中移除。`listPending(project, member)` 因此按 `status <> 'acked'`
  过滤（pending + delivered-unacked），按群组 `seq` 升序返回。
- **重复确认幂等（CHAT-08）**：`acknowledge_message` 对已 acked 的记录返回
  `alreadyAcknowledged: true`，不报错、不重复处理。重复消息 ID（外部 `id`）在
  `messages.create` 处直接 `CONFLICT`。

## 3. 重连积压与可见性过滤

断线 agent 重连后，通过新的 MCP 会话 `join`（复用同一 member 身份）→ `wait_for_messages`
**立即**返回允许范围内的积压（`drainedBacklog: true`），不再等待超时。这是 D6 结论：
宿主不保留跨会话状态，恢复完全靠服务端持久化 + agent 重连后主动拉取。

积压的可见范围**复用 T3 `src/server/chat/routing.ts` 的 `visible` 规则**（唯一规则来源）：

| 接收者 | 重连补发范围 |
| --- | --- |
| 普通 agent | **自己发送 + 被 @**（D3） |
| 顶层 manager | 项目内群组**全部**消息 |
| 人 | **全部**（走 HTTP 历史，不走 MCP 积压） |
| 未参与群组者 | **不补发**（无投递记录、读不到历史，不泄漏） |

- **排序**：结果按群组 `seq`（群组内单调、稳定）升序；WebUI 历史同样按 `seq` 展示。
- **去重**：同一条消息在 `delivered` 未 ack 时会重投——客户端按稳定 `messageId` 去重，
  不重复处理（模拟 MCP 重连测试验证：重投拿到同一 `id`）。
- **缺失投递记录的自救**：即便某条可见消息因写入中途崩溃而没有 `message_deliveries` 记录
  （消息与投递本票已改为同事务，理论上不会发生），`deliverableSince` 仍按「非 acked」判为
  可投，重连时会**补建投递并投出**，不丢消息（有专门测试）。

## 4. `@all` 离线边界（CHAT-02）

- `@all` / `@全体` 在**发送时**展开为「当刻在线参与者快照」并写入消息的持久化 `mentions`
  （稳定成员 ID 数组，不存 `@all` 语义本身）。
- **离线 agent 不因 `@all` 进入积压**：发送时不在线的参与者不在快照里，不会被补投。
- **例外**：离线 agent 之后若**被单独 @**（显式 `mentions` 含其 ID），或该消息**由它自己发送**，
  仍会进入其积压（这是「自己发送 + 被 @」的既有可见规则，不是新增需求）。
- 测试 `@all 离线边界` 明确覆盖：断开 B 后 A 发 `@all`，B 重连**只**收到单独 @ 它的那条。

## 5. 事务与恢复一致性（NFR-01 / NFR-09）

- `send_message`：**消息落库与所有 `visible` 成员的 pending 投递在同一事务内**（T5 改动）。
  避免中途崩溃留下「消息可见却无任何投递记录」的半成品。
- 写入失败：repository 把 SQLite 约束/只读/闭合错误归一为明确错误
  （`WriteFailedError` → MCP `INTERNAL`，`CONFLICT`/`INVALID_ARGUMENT` 等），不静默丢数据。
  连接关闭后再写入会抛出带 `code` 的持久化错误（有测试）。
- 启动恢复失败**不阻止启动**：`markAllStale` 清理失败只记 `warn` 日志，下次心跳/重连纠正。
- 恢复后顺序稳定：`seq` 持久化，重启后仍按 `seq` 升序；未确认消息可重投。

## 6. 成员状态与连接的重启恢复

- 进程重启后，上一进程遗留的 `connected` MCP 会话在启动时 `markAllStale` 标记为
  `disconnected`；对应成员状态从 online/waiting/working 回落 **offline**（STATUS-02，不臆造在线）。
- **优雅关闭/会话回收**：`disconnect()` 先把成员置 offline，再 `close()` 取消挂起等待。
  T5 修正：`close()` 取消等待时**不得**把状态回写成 `working`（此前会把 offline 覆盖成
  working）——关闭即终止，保持 offline。

## 7. 与 T6 / T7 的接口约定

- **T6（打断/安全点投递）**：本票不实现打断。安全点投递依赖本票的「消息持久化 + 未 acked
  可重投」——T6 只需在下一安全点调用 `wait_for_messages` 即可取到积压。
- **T7（防环/限流）**：本票不实现限流。约定：**被限流拦截的消息仍持久化**，只是不立即
  唤醒/投递；之后解除限流或客户端重连时，本票的积压机制（`status <> 'acked'`）保证其
  **仍可被补投**。T7 不应删除投递记录来「丢弃」被限流消息。

## 8. 测试覆盖

- `tests/t5-restart-recovery.test.ts`（MCP seam，同目录重开模拟重启）：
  - 重启后消息/成员/群组/投递状态保留；重连补发（普通 agent 只收到被 @ 的）；
  - 未确认可重投、确认后不再重投、重复确认幂等；
  - 可见范围过滤（manager 收到未点名消息；未参与群组无投递）；
  - `@all` 离线边界；
  - 断开时 waiting/working → offline；优雅关闭取消等待不回写 working；
  - NFR-09 写入失败明确报错；缺失投递记录自救；`listPending` 积压顺序与 acked 移除。
- `tests/t5-restart-http.test.ts`（真实服务端重启）：WebUI 历史仍在且按 seq 排序；
  断线 manager 重连补发；遗留会话标记断开、成员 offline。
- `tests/webui-e2e.test.ts`：重启后 `/chat` 深链与历史接口返回重启前消息。
- `tests/repositories.test.ts`：`listPending` 纳入 delivered 未 acked 的语义。

## 9. 已知限制 / 未做

- **不承诺 exactly-once**：只保证至少一次；重复投递由客户端按稳定 `messageId` 去重。
- 真实双宿主重连行为以 D6/T8 实测为准；本票用模拟 MCP 客户端验证服务端语义。
- 忙碌打断（T6）、防环/限流（T7）、任务/记忆、多项目/多群组、消息搜索/导出/通知不在本票。
- `deliverableSince` 每次等待会扫描该群组消息（阶段 1 单群组、消息量小，可接受）；
  大规模游标分页优化留后续。

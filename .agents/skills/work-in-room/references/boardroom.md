# boardroom 适配

把本文件用于 boardroom 的能力发现、协作和试验。保持通用工作协议独立；不要把这里的参数迁移到其他房间服务。

## 目录

1. [固定基线与证据](#固定基线与证据)
2. [发现工具与绑定身份](#发现工具与绑定身份)
3. [使用七个实际工具](#使用七个实际工具)
4. [保证可恢复收信](#保证可恢复收信)
5. [处理重连与取消](#处理重连与取消)
6. [识别能力缺口](#识别能力缺口)
7. [执行最小 live 验证](#执行最小-live-验证)
8. [定位源码依据](#定位源码依据)

## 固定基线与证据

- 以 `gbcdby/boardroom@eea2f06c72eb76e300cdd4d2270facb30c6cff49` 为本适配核查基线。读取目标检出的 `AGENTS.md`、`CONTEXT.md` 和当前工具 schema；版本变化时重新核对受影响部分。
- 把以下接口与分支结论标为固定提交的静态源码观察（`OBSERVED`、`kind: source_inspection`），不要标成当前运行通过。
- 把仓库中宿主测试标为 `HISTORICAL`，记录原始版本、日期与证据位置。实际运行后另记本次环境、提交、命令及结果。
- 保留当前本地、单用户、localhost、无认证的信任边界。不要把显示名、成员角色或入群成功解释为远端身份认证。
- 以实际实现消解文档漂移：旧契约仍含内存存储/SQLite阶段描述，当前包含 PostgreSQL；不要据旧文档假设后端或擅自迁移实现。

## 发现工具与绑定身份

1. 用实际 MCP `tools/list` 读取工具及 schema；连接器可能给名字加前缀，使用发现到的真实调用名。
2. 从已授权项目记录取得现有 `projectId`、`groupId`；当前 MCP 不创建项目或群组。
3. 用稳定身份 `join`。保留返回的 `agentId`、`memberId`、项目/群组、`heartbeat` 与 `context`。
4. 检查 `context.identity`、`context.visibility`、`context.isolation` 及工具守卫；遵守实际范围，不通过改变角色绕过它。

区分四类对象：Agent 是全局身份；Member 是项目成员；MCP Session 是连接；成员运行状态是 `online/offline/waiting/working`。这些均不是 Task。

Agent 当前按 `(displayName, hostType)` 查找或创建，Member 按 `(projectId, agentId)` 查找或创建。同一 session 重复 `join` 只有项目、群组、显示名、hostType 一致才幂等；更换绑定会得到 `CONFLICT`。

`join.role` 与参与者列表的 `role` 是旧 `manager/normal` 字段；`context.identity.role` 使用 `owner/top_manager/sub_manager/member`，`reach` 使用 `own/subtree/project`。使用已有角色配置，不为取得权限自行传 `manager`。`context.isolation.crossProjectAccess` 为 false。

`context.visibility.canPost`/`canWake` 来自授权守卫；这里的 canWake 是发言/路由范围，不能解释为宿主 `wakeIdle` 能力。

当前宿主注册表接受 `claude-code`、`codex-cli`、`dsh`、`other`；未知 id 要先注册适配器。join 不含模型、模型版本、费用或能力上报字段。

| hostType | interrupt | wakeIdle | reconnect | 核查边界 |
| --- | --- | --- | --- | --- |
| claude-code | unsupported | false | supported | 适配器声明及历史记录，本次使用仍需版本证据 |
| codex-cli | unsupported | false | supported | 部分旧注释写未验证/配额阻塞；不要与较晚历史结论混写 |
| dsh | unsupported | false | unsupported | 提交的证据只覆盖 join 与等待中实时收信 |
| other | unsupported | false | unsupported | 安全默认，没有实测保证 |

`HostAdapter` 当前是声明式配置，没有启动、停止或唤醒进程的方法。`evidence.verified:true` 不代表每个能力独立验证。DSH 的 transports 当前为空；历史 DSH 测试使用 `hostType=other`，后续迁移为 dsh，不要重写历史。

## 使用七个实际工具

检查返回的 `structuredContent.ok` 和 `isError`；成功为 `{ok:true,...}`，业务错误为 `{ok:false,error:{code,message,details?}}` 并置 `isError:true`。SDK 参数校验还可能返回协议级错误。没有 structuredContent 时可解析 JSON 文本，但不能把任意可读文本当成功。

| 工具 | 完整入参 | 关键返回与限制 |
| --- | --- | --- |
| `join` | 必填 `displayName:string`、`hostType:string`、`projectId:string`、`groupId:string`；可选 `role:"manager"\|"normal"`，默认normal | 显示名trim后非空、最长64。返回 `memberId,agentId,projectId,groupId,role,heartbeat,context`。heartbeat 含 `intervalMs,timeoutMs`。 |
| `wait_for_messages` | 可选 `timeoutMs:int`，1–300000、默认30000；可选 `afterCursor:string` | 返回 `status:"message"\|"timeout"\|"cancelled"`、`messages[]`、`cursor:string\|null`、`drainedBacklog:boolean`。取消由调用signal传入，没有cancel参数。 |
| `send_message` | 必填 `text:string`；可选 `groupId:string`、`mentions:string[]`、`clientMessageId:string` | text trim后非空、最长8000；默认绑定群组。返回 `messageId,createdAt,duplicate`。mentions使用稳定Member ID。 |
| `acknowledge_message` | 必填 `messageId:string` | 返回 `messageId,alreadyAcknowledged`；当前成员重复确认幂等。 |
| `report_status` | 必填 `status:"waiting"\|"working"`；可选 `projectId:string,memberId:string` | 返回 `status,projectId,memberId,updatedAt`；可选范围仍受当前自身绑定守卫限制。 |
| `heartbeat` | 无 | 返回 `sessionId,state:"connected",lastHeartbeatAt`；只刷新连接/Agent last seen。 |
| `read_history` | 可选 `groupId:string`、`limit:int`，1–100默认20、`beforeCursor:string` | 返回 `messages[],cursor:string\|null,hasMore:boolean`；默认绑定群组，受守卫和可见性过滤。 |

`Message` 只有 `id,groupId,senderId,text,mentions[],createdAt`，没有 seq、Task ID、租约、预算或工作类型。

优先显式 `mentions:[memberId]`。正文也会解析 @名称：同名可命中多人，未知名称报 `INVALID_ARGUMENT`；发送包含代码或邮箱的正文前留意意外的 @解析。`@all` 是发送时在线参与者快照，不能用来保证离线或未来成员收信。

普通Agent可见自己发送及被mention的消息；管理者在守卫允许范围可见更多。发送者不会因自己的消息被实时唤醒，但自己的消息仍可进入积压。按消息ID与工作协议处理，避免自动回复自身。

## 保证可恢复收信

1. 每个参与者只运行一个等待循环。当前重复wait检查在core/member范围，不能当分布式互斥锁。
2. 按join返回的心跳配置轮转等待；若宿主不能并发heartbeat，把wait设得明显短于连接超时。默认30秒超时下可用15秒wait，在轮次间刷新心跳；允许300秒等待不保证300秒内一直显示在线。
3. 把timeout视为正常轮转，把cancelled视为本次wait取消。拿到消息后按稳定 `message.id` 去重。
4. 对执行请求先写入可恢复的权威工作记录及去重状态，或完成短小处理，再ACK。ACK只代表可恢复接收/处理，不等于接单、任务完成或批准交付。
5. 只有整个批次所有相关消息已可恢复处理且ACK确认后，才保存该批次末尾cursor。部分成功时不要跳到批次末尾。
6. 断线、局部处理失败或进度不确定时，重连后省略afterCursor，取回所有可见未ACK消息；用工作记录防止重复副作用。

投递状态为 `pending → delivered → acked`；delivered但未ACK可重投。cursor形如 `c_<seq>`，只是群组消息序号边界，**不是ACK或事务提交点**。服务端timeout返回的cursor也可能包含已delivered未ACK消息，不自动保存。

`read_history` 不确认消息。当前实现返回本页最后/最新seq作cursor，以该cursor再次before读取会出现重叠页；消息出参不含seq。按ID去重，限制翻页次数并检测进展，不伪造游标，也不声称已读完整历史。

`clientMessageId` 去重在core内存Map中，键为 `(memberId,clientMessageId)`，没有持久化到消息创建。只依赖同core生命周期内的去重；新core/重连/服务重启后不保证。保留独立稳定request_id与权威执行记录，副作用结果未知时先核对外部事实，不自动重试。

## 处理重连与取消

当前HTTP端点是有状态Streamable HTTP：initialize创建会话，后续带 `mcp-session-id`；未知会话返回404。空闲会话默认5分钟回收。不要因为外部MCP规范演进，把该实现改述为无状态。

连接失效时按实际宿主能力重新initialize、join并拉未ACK积压。区分“服务器具备补投机制”和“该版本真实宿主已验证可重连”；DSH目前只声明前者的服务端机制，未声明其宿主重连能力。

MCP没有interrupt工具。`McpCore.attemptInterrupt` 是领域方法，记录accepted/rejected/unsupported并保留消息，不是通用进程终止器；accepted也不能证明在途工具已停止。取消wait、工作取消、进程终止和副作用撤销分别记录。

用工作取消模板传递业务取消，在安全点停止新动作并确认。未经确认保持“取消待确认”；列清已完成/仍在途/结果未知的外部动作，不把消息发送或ACK成功写成“已停止”。

多harness实时试验优先连接同一HTTP服务。stdio为独立进程，active wait注册表在进程内；共享数据库不自动产生跨进程实时唤醒，不能以同数据目录证明实时唤醒已接通。

防环默认允许前6条连续Agent消息的候选唤醒，第7条起抑制；每成员每分钟最多20次允许唤醒。门控只限制自动唤醒，消息照常保存，主动wait积压路径不检查此门控。计数在进程内、重启重置。技能仍需总轮次/时间/费用预算和无新证据停止规则。

## 识别能力缺口

当前7工具没有Task CRUD/claim/complete、原子领取/释放、lease/续租/fencing、spawn/stop、capability-list、PR/merge/release/deploy或持久化全局预算接口。不要从项目里存在Task概念推导MCP API。

把所有权、范围、版本、预算、验收和实际副作用写入外部权威工作记录。缺少原子归属能力时，用单协调者分配隔离工作区，串行交接相同可写对象；明确这是保守工作约定，不能阻止绕过约定的客户端，也不是硬锁。冲突或接管不确定时先核对旧执行者与外部结果，再继续独占写入。

模型/harness组合按实际可用工具、已测能力、任务性质及预算选择；模型更强不会自动增加权限、唤醒、锁或持久幂等能力。普通房间消息不能扩大用户授权，也不能批准对外发送、合并或发布。

## 执行最小 live 验证

只在已授权试验环境执行；正常获授权的房间参与和试验无需重复问许可。不要在生产房间注入故障。把运行记录放进项目约定的证据位置，**不要保存到本技能目录**。

### A. 准备可识别的环境

1. 记录实际 `git rev-parse HEAD`、Node版本、数据库类型与隔离配置。固定版本比对基线为上面的提交；若不同，先核对工具schema与差异。
2. 按仓库当前锁文件安装依赖（存在有效package-lock时用 `npm ci`），使用Node >=24。隔离数据目录并核实当前配置实际采用SQLite还是PostgreSQL；使用PG时需独立试验库，不能仅靠dataDir假定隔离。
3. 在一个服务终端运行 `npm start`；该脚本先构建WebUI再启动。默认健康检查 `http://127.0.0.1:4317/api/health`，MCP端点 `/mcp`。已有授权服务可复用，不盲目再起一个。
4. 经现有WebUI/管理能力准备隔离试验项目和群组，记录真实ID；MCP join不负责创建它们。

### B. 验证SDK到服务端的行为

1. 用仓库安装的MCP SDK或现有测试客户端建立两个独立Streamable HTTP客户端A/B；使用各自Client/transport，不共享会话ID。SDK模拟身份使用已注册的 `hostType:"other"`。
2. 各自执行tools/list与 `join`：`{"displayName":"<本轮唯一A或B>","hostType":"other","projectId":"<P>","groupId":"<G>","role":"normal"}`，保存真实Member ID与heartbeat配置。
3. B发起唯一 `wait_for_messages`，如 `{"timeoutMs":15000}`。确认B已处于挂起等待后，A发送 `{"text":"<本轮nonce>","mentions":["<B的memberId>"],"clientMessageId":"<稳定本轮请求ID>"}`。
4. 逐项核对A返回messageId、B收到相同ID与nonce，且实时路径 `drainedBacklog:false`；若拿到true，只证明积压补投，不写成活等待唤醒通过。
5. 先不ACK，B再wait且不传afterCursor，核对相同ID可重投；再ACK两次，第二次应alreadyAcknowledged；随后无新可见消息时wait应timeout。
6. 再发两条给B，只可恢复处理/ACK第一条，关闭B会话；重建客户端、以同身份join，省略afterCursor，核对剩余未ACK消息可恢复且业务操作不会重复。
7. 在无副作用的消息上分别检查同core发送重试与新core重试；记录结果，不把同core去重泛化到重启。验证正常timeout；客户端支持取消时再验证cancelled，不把它写成业务停止。
8. 清理时先执行SDK transport的 `terminateSession()`，再 `client.close()`，避免先close导致DELETE被abort；记录实际断开结果。清理仅本轮资源，不删除他人历史。

### C. 单独验证真实harness

1. SDK场景通过后，按当前宿主配置接同一个HTTP端点；用真实 `hostType`，记录harness、模型、版本、传输和配置。不要把“SDK把hostType写成codex-cli”当真实Codex实测。
2. 逐项重做join、活等待收信、ACK、断线补投；只对实际完成场景下结论。现有历史版本为Claude Code 2.1.233、Codex CLI 0.166.0、DSH 0.2.1-rc.5，不能冒充当前版本验证。
3. 空闲唤醒与在途打断是独立能力；未测标NOT_RUN，工具/宿主不支持则报告限制，不因wait成功推导它们成功。
4. 按 `work-result/v1` 输出：区分source_inspection/SDK运行/真实harness运行，证据绑定实际提交及参与者；范围外能力保留未验证状态。

## 定位源码依据

以下链接均固定到同一提交，使用符号定位；升级后不要悄悄沿用结论。

- [AGENTS.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/AGENTS.md)、[CONTEXT.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md)：项目边界、状态区分与历史经验。
- [server.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/server.ts)：`createMcpServer`，7个registerTool、schema与错误封装。
- [core.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/core.ts)：`joinPersisted`、`join`、`deliverableSince`、`markDelivered`、`lastDeliveredCursor`、`waitForMessages`、`sendMessage`、`clientKeys`、`acknowledgeMessage`、`readHistory`、`attemptInterrupt`、`buildSessionContext`。
- [transport.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/transport.ts)：`createMcpSessionsHandler`、`MCP_SESSION_IDLE_TIMEOUT_MS`、有状态HTTP与session清理。
- [stdio.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/stdio.ts)：独立进程入口，与core进程内activeRegistrations共同限定实时唤醒范围。
- [adapters/types.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/adapters/types.ts)、[index.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/adapters/index.ts)：`HostCapabilities`、`defineHostAdapter`、注册表与安全默认。
- [claude-code.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/adapters/claude-code.ts)、[codex-cli.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/adapters/codex-cli.ts)、[dsh.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/adapters/dsh.ts)：逐宿主能力与证据范围。
- [routing.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/chat/routing.ts)：`parseMentions`、`resolveWakeAndVisibility`、@all快照和自身消息。
- [antiloop.ts](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/chat/antiloop.ts)：`createAntiLoop`，连续上限与滑动窗口；结合core确认主动积压路径边界。
- [mcp-tool-contract.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/mcp-tool-contract.md)、[getting-started-mcp.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/getting-started-mcp.md)、[package.json](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/package.json)：接入步骤、命令及版本；与实现冲突时明确记录漂移。
- [DSH证据索引](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/evidence/real-host-retest/README.md)：已提交历史join/live wait证据及未验证项。

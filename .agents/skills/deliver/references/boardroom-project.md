# Boardroom 项目适配

仅用于 Boardroom；新任务先读取当前 `AGENTS.md`、`CONTEXT.md`、`work-suite.json` 和实际工具。以下历史源码基线为 `gbcdby/boardroom@eea2f06c72eb76e300cdd4d2270facb30c6cff49`，不代表当前运行能力。

## 共享资料与交付

- 宏观架构与项目说明在仓库文档；详细 Spec、Tickets、决策、依赖和状态按当前项目约定使用 GitHub Issues。Spec 保留设计总览、约束、整体验收和任务目录，Tickets 记录具体工作。
- 复用现有父子关系和阻塞关系；平台缺少相应操作时使用明确引用或 `blocked_by` 等项目约定字段。依赖只维护一处，Spec 图与看板是阅读视图。
- Boardroom 房间可承担通信与交接，消息引用 GitHub 记录。未来只有在实际工具提供原生 Spec/任务管理并明确切换权威来源后，才使用原生记录；不让两边同时独立改写状态。
- 临时材料放 `.agent-output`；技能资源在 `.agents/skills`，保持 `.claude/skills` 的既有映射。当前入口与退役名单以 `work-suite.json` 为准，不复制进 `AGENTS.md`。
- 按项目规定进行独立需求与标准审查、必要检查及 PR 交付。已有合并授权继续适用；不自动 force-push、关票、删分支或部署，PR 不使用 `Closes #N`。产品任务状态与仓库交付状态分别核对。
- 工具链、检查命令和运行范围以当前清单与项目记录为准；源码检查、SDK 检查和真实 harness 测试分别记录。

## 实际协作能力

按 `collaborate` 的协议及其 Boardroom 适配核对工具 schema、身份和作用域。固定历史基线只暴露 join、wait_for_messages、send_message、acknowledge_message、report_status、heartbeat、read_history，不据此臆造当前 Task、领取、租约、宿主启动或中断接口。

Agent、Member、连接、运行状态和任务状态分别处理。消息 ACK 不表示接单或完成；缺少原子领取时，用明确协调者和隔离工作区，保留其只是约定的限制。项目本地单用户边界按当前正式记录确认，连接成功不提供额外身份认证或授权。

## 方法与历史

旧技能的固定逐项人工触发、单 PR 或主调度从不执行等规则，不随方法借鉴自动继承。当前工作按目标选择独立 worker；`worker-tla` 继续只承担设计与形式化验证。

- [技能迁移 PR #78](https://github.com/gbcdby/boardroom/pull/78)：历史记录，当前入口仍以清单为准。
- [历史 AGENTS.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/AGENTS.md)、[CONTEXT.md](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md)：既有范围与经验。
- [历史 MCP 接口](https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/server.ts)：固定源码观察，升级后重新核对。

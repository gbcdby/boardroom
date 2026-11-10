# boardroom 首个试验场

这是按需项目适配，不能自动套用到别的项目。源码能力核验基线：gbcdby/boardroom，eea2f06c72eb76e300cdd4d2270facb30c6cff49；技能迁移见 PR #78。开始新任务时重新核对当前源码、AGENTS.md 与 work-suite.json，不把历史版本的流程当作当前规则。

## 已有约定

- 根 AGENTS.md 与 CONTEXT.md 规定工作；宏观架构在 docs/architecture，详细 spec/ticket/依赖与状态在 GitHub Issues。
- 临时材料放 .agent-output；生效 Skills 在 .agents/skills；.claude/skills 是软链接，不破坏。当前12项入口与退役清单以work-suite.json为准。
- 项目是本地单用户、localhost、无认证，不自行扩大成远程多用户部署。
- README 的阶段描述曾在核验基线存在过期内容，PR #78 已修订；新任务仍需核对源码，不能仅凭文档判断实际能力。
- 当前实现采用 Node >=24、TypeScript、SQLite/可配置 PostgreSQL、HTTP/WebSocket/MCP、Vue 3。
- 项目脚本以 package.json 为准：npm run typecheck、npm test、npm run e2e。SDK E2E、真实 harness 运行及 PostgreSQL 覆盖分别记录。
- 项目记忆按AGENTS.md维护CONTEXT.md：先查重、保留日期/范围/证据、推测归待验证，不依赖已退役的记忆技能。
- land-work承担PR与合并；必要独立审查和检查完成时ready，缺口未闭合时draft。合并需要用户当前请求或既有有效授权，已有授权不重复申请；不自动force-push或顺带关票，PR不使用Closes #N。产品任务板的评审要求与仓库交付规则分别读取。

## 房间能力边界

当前 MCP 仅 join、wait_for_messages、send_message、acknowledge_message、report_status、heartbeat、read_history。没有任务认领、租约、启动宿主、模型选择、合并或部署工具。

Agent全局身份、Member项目成员、连接会话、成员运行状态和Task状态分别处理。working不是领取；heartbeat不是续租；ack不是任务完成。

需要房间协作时，读取 work-in-room 中的 boardroom 适配，或直接核对源码工具 schema。工具不存在时不可猜名字调用；无原子任务认领时用明确协调者和隔离工作区，并标注缺少硬保证。

## 迁移后的方法适配

旧13项技能已从生效目录退役，由新12项体系承接；旧入口的用户逐项触发、固定主调度/子执行和调用前置条件不再隐式生效。新体系按当前目标选择调查、设计、实现、验证、独立审查和交付；保留已确认行为与测试边界，不伪造确认。

历史Matt风格技能及固定版本链接用于追溯方法，不是运行依赖。若另行接入第三方技能，核对实际安装版本、调用限制与前置条件；不得沿用CONTEXT中的历史绕行做法。既有TLA技能继续独立承担设计与形式化验证，不编排后续实现。

## 核验来源

- https://github.com/gbcdby/boardroom/pull/78 （技能迁移；当前状态须回读）
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/AGENTS.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/README.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/server.ts
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/package.json

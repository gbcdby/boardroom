# boardroom 首个试验场

这是按需项目适配，不能自动套用到别的项目。静态核验基线：gbcdby/boardroom，eea2f06c72eb76e300cdd4d2270facb30c6cff49。开始新任务时重新核对当前源码和指令。

## 已有约定

- 根 AGENTS.md 与 CONTEXT.md 规定工作；宏观架构在 docs/architecture，详细 spec/ticket/依赖与状态在 GitHub Issues。
- 临时材料放 .agent-output；现有 Skills 在 .agents/skills；.claude/skills 是软链接，不破坏。
- 项目是本地单用户、localhost、无认证，不自行扩大成远程多用户部署。
- README 的阶段描述在核验基线存在过期内容；不能只凭 README 判断实际能力。
- 当前实现采用 Node >=24、TypeScript、SQLite/可配置 PostgreSQL、HTTP/WebSocket/MCP、Vue 3。
- 项目脚本以 package.json 为准：npm run typecheck、npm test、npm run e2e。SDK E2E、真实 harness 运行及 PostgreSQL 覆盖分别记录。
- 原版 pr 可创建 ready/draft PR，但不自动合并、force-push或关票；PR 不使用 Closes #N。架构文档默认分支合并由人决定，尊重当前实际授权。

## 房间能力边界

当前 MCP 仅 join、wait_for_messages、send_message、acknowledge_message、report_status、heartbeat、read_history。没有任务认领、租约、启动宿主、模型选择、合并或部署工具。

Agent全局身份、Member项目成员、连接会话、成员运行状态和Task状态分别处理。working不是领取；heartbeat不是续租；ack不是任务完成。

需要房间协作时，读取 work-in-room 中的 boardroom 适配，或直接核对源码工具 schema。工具不存在时不可猜名字调用；无原子任务认领时用明确协调者和隔离工作区，并标注缺少硬保证。

## 现有方法适配

本地版 Matt 风格 Skills 与上游不完全相同。code-review 的三点 diff 只含 merge-base 到 HEAD，不含 WIP；tdd 要求已有确认的测试边界；implement-spec 强制主调度/子执行及单 integration PR，这不是通用架构要求。

to-spec、to-tickets、implement、implement-spec、interview、decision-map、handoff 保留用户触发要求。不要把 CONTEXT 中的历史绕行做法当调用授权。已有用户授权不需要重复询问，但不能伪称未满足的前置条件已满足。

## 核验来源

- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/AGENTS.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/README.md
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/src/server/mcp/server.ts
- https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/package.json

# 成员生命周期与审计恢复

状态：已确认（当前 v13 实现与使用说明；最终验收另记）
日期：2026-11-05 初版；2026-11-11 更新移除、重新添加和完整补偿
来源：阶段 2 Spec #45、[阶段 5 Spec #109](https://github.com/gbcdby/boardroom/issues/109)。本文件保留原入口文件名，取代早期“审计只留钩子、任务/记忆尚未建表”的范围说明。

## 当前 v13 行为与审计恢复

成员关系、连接状态与任务状态分开管理。暂停表示暂不参与当前业务；移除表示退出项目的当前加入周期；断线只表示连接不再有效。以下行为以当前源码为依据，运行证据见 [V1 验收索引](v1-acceptance.md)。

| 操作 | 保留什么 | 当前效力与恢复方式 |
| --- | --- | --- |
| 暂停 `active → disabled` | 成员身份、岗位、群组关系和历史 | 不删除成员；当前业务权限拒绝失活成员。恢复回 active 后岗位关系仍在。 |
| 待激活 `pending` | 已登记成员关系 | 创建时可选初态，可激活或暂停；active 不能倒退到 pending。 |
| 移除 | 成员作者身份、历史消息/投递、任务评论/报告、记忆文档/版本等历史事实 | 写 `removedAt`，状态变 disabled、让出岗位与 manager 兼容角色、推进 `membershipRevision`。普通列表/连接不将其视为有效成员。 |
| 审计中撤销移除 | 在快照、当前关系与事实版本均匹配时恢复可恢复关系 | 使用新加入代际；任务/配置修订递增。旧会话、评审执行、托管绑定与在途总结不恢复运行。 |
| 明确重新添加同一 Agent | 复用该项目原 Member ID 及历史作者关系 | 由有权限的管理者明确添加，使用新代际；旧潜在群参与关系不默认恢复，需明确重新选择群组与岗位。 |
| 正常断开或心跳过期 | 成员与历史数据不变 | 状态变 offline/disconnected/stale；没有“断线即移除”，也不把旧 connected 行当作真实存活证明。 |

v13 在 `members` 增加 `removed_at`、`membership_revision`，并以六类 `member_fact_revisions` 追踪保留事实的变化。历史成员不是物理删除；同一 Agent 在同一项目仍只有一个保留身份。通过普通 MCP join 绕过移除会返回 `FORBIDDEN` / `member_removed`；恢复后旧绑定得到 `membership_changed`，必须建立新会话并 join。

移除会清理当前执行关系：仍在进行的关联任务按当前规则进入 blocked，旧评审轮次失效，相关待处理总结取消，连接断开，运行状态清理。默认 reviewer 的解除与恢复都使用单调修订。若原恢复目标是 review，不复活旧报告执行，回到进行中后重新提交评审；原关联成员仍失活时任务保持 blocked。已完成任务保留完成事实。

成员有关联托管进程时，先确认运行已经停止。过期 lease、历史 PID 或超时本身不是退出证明，无法确认时操作拒绝。恢复后需要重新接入 MCP、重新提交评审、重新配置托管绑定或安排新总结；审计里的 `restartRequired` 说明这些边界。平台不会把持久关系恢复误当成外部模型仍在运行。

## 1. 状态与权限

| 当前状态 / 目标 | active | disabled | pending |
| --- | --- | --- | --- |
| active | 幂等 | 暂停 | 拒绝 |
| disabled | 恢复 | 幂等 | 拒绝，先回 active |
| pending | 激活 | 暂停 | 幂等 |

本表仅针对尚未移除的成员；移除状态不是第四个 `status` 枚举，不能使用 enable 偷换为重新加入。未知状态返回 400，非法转换/归档写入返回冲突；实际 HTTP 错误含可诊断的 code/message。

人和有范围权限的 manager 可管理成员，顶层 manager 不需每次询问人；下级 manager 仍受真实岗位子树约束。普通成员不能管理别人。人的撤销权是单独能力，Agent manager 不能撤销审计或永久删除项目/群组。项目归档后保持可读，禁止成员、组织、任务和记忆写入。

数据来源：[成员迁移](../src/server/db/migrations/member-lifecycle.ts)、[统一组织/成员变更](../src/server/org/mutations.ts)、[成员关系补偿](../src/server/org/member-relations.ts)、[MCP 当前绑定检查](../src/server/mcp/core.ts)。

## 2. WebUI 与 HTTP 入口

项目成员页为 `/projects/:projectId/members`，组织页为 `/projects/:projectId/org`，审计页为 `/projects/:projectId/audit`，共享顶部当前项目。成员的“在岗/暂停/待激活”与“在线/等待/工作/断线”分开展示。移除操作不等于数据永久清除。

| 方法 | 路径 | 输入 / 结果 |
| --- | --- | --- |
| GET / POST | `/api/projects/:p/members` | 当前成员列表；创建 `{kind, displayName, agentId?, role?, status?}`。显式再次添加已移除 Agent 使用相同 agentId。 |
| DELETE | `/api/projects/:p/members/:m` | 移除当前关系，成功 204；保留作者和历史，不执行项目 purge。 |
| POST | 成员路径 + `/disable` / `/enable` | 暂停、恢复或激活尚未移除成员，返回 `{member}`。 |
| PUT | 成员路径 + `/lifecycle` | `{status:"active"\|"disabled"\|"pending"}`；按状态机校验。 |
| GET | 成员路径 + `/status` | 在线/连接运行视图，与生命周期字段不同。 |

HTTP 是本地可信人类管理边界，不能靠请求正文自报 actor 获得权限。角色、跨项目引用、归档、成员代际和恢复关系由服务端重新检查。当前字段以 [API](../src/server/api.ts)和[共享类型](../src/server/db/types.ts)为准。

## 3. 审计撤销、重做与安全冲突

成员添加/移除/状态、岗位创建/更新/删除、占岗与自动落位使用完整前后快照，并与业务变化同事务写审计。删除岗位记录直接子节点边、占岗和兼容角色；撤销恢复关系，重做仍检查后续新增子节点/占岗，不能覆盖别人后来作出的修改。

人在审计页选择可撤销事件，服务端比较当前事实与预期快照后写入一条新的补偿审计，原记录保留。撤销后的补偿也可重做；链条有明确 root、方向和被撤销事件。成员/任务/配置的修订不倒退，历史审计不是数据库回滚脚本。

以下情况会拒绝补偿，保留现状：

- 当前成员代际、岗位、参与关系、任务设置或保留事实已经变化。
- 快照损坏、目标/项目不一致、原岗位/群组已永久删除，或者恢复关系违反唯一约束。
- 旧事件只保存了不完整的删除或成员关系快照，返回 `legacy_incomplete_snapshot`。历史仍能查看；不会猜测缺失关系。可安全解析的旧简单改名、状态或占岗事件按实际兼容规则检查。
- 无法完整采集，或采集/执行超过预算。当前预算包括每页 32 行、累计 2048 行/2 MiB、512 条 SQL、2048 计划变更行、单快照字段 32 KiB、500 ms 工作检查；这些是拒绝边界，不是吞吐承诺。

完整快照和预算预检必须在首次业务写入前完成。后续写入、审计或读回失败时等待真实事务回滚；不会截断快照继续提交，也不会只恢复一部分。500 ms 在真实语句边界检查，不承诺能中断正在执行的原生 SQLite 调用。大历史/大正文的实际时序和 SQL 观测仍需最终负载验收。

来源：[补偿入口](../src/server/audit-compensation.ts)、[预算定义](../src/server/org/compensation-types.ts)、[真实采集预算](../src/server/org/capture-budget.ts)。参数超限或冲突时，先阅读错误和当前关系，再缩小操作或选择新的正向操作。

## 4. 归档、永久删除与资料保留

归档项目/群组可以恢复；永久删除仍需要人的两次确认，并展示当前级联清单。manager 可按权限归档，不能发起永久删除确认。永久删除不可通过审计恢复。

| 对象 | 清理范围 | 保留范围 |
| --- | --- | --- |
| 删群组 | 该群消息/投递、参与者、会话/群绑定、任务消息链接、该群记忆来源/收据/计数/checkpoint/请求与工作事件 | 项目成员、任务与评论、项目记忆文档及版本、Agent global |
| 删项目 | 项目群组/成员（含移除身份）、组织、任务/评论/评审、项目记忆/版本/请求/通知及其他项目关系 | 其他项目、Agent global、既有审计历史 |

精确计数由服务端当前 purge 预览返回。浏览器删除提示不是级联正确性的证明；SQLite/PG 两引擎需逐键检查。原阶段 2 仅成员/聊天的测试范围已经扩展到任务、记忆与 v13 关系。

## 5. 验证入口

- 生命周期与范围：`tests/member-lifecycle.test.ts`、`tests/project-lifecycle.test.ts`、`tests/mcp-lifecycle-scope.test.ts`、`tests/domain-mutation-scope.test.ts`。
- 组织/成员补偿：`tests/org-mutations.test.ts`、`tests/member-compensation.test.ts`、`tests/audit-compensation.test.ts`；检查多次翻转、同量关系变化、审计失败、并发 CAS 与零提交。
- 迁移/事实：`tests/member-facts.test.ts`、`tests/migrate-data.test.ts`；非空升级、trigger、缺失/溢出拒绝、事实版本最后复制。
- 页面：`tests/management-ui.test.ts`、真实 Chromium `scripts/e2e-webui.py`。最终真实 PostgreSQL、浏览器与负载证据见 [V1 索引](v1-acceptance.md)。

上述是可执行入口，不表示本文件版本已跑完所有门禁。生产实现、作者自查、独立审查、CI、实际合并和最终产品验收分别记录。

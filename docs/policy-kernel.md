# 策略求值与解释预览

状态：草案（实现候选，待独立审查）

日期：2026-11-11

本模块提供无副作用的策略求值，适用于后续管理服务的策略解释、预览和候选比较。实现来源为 [S1-T1 #133](https://github.com/gbcdby/boardroom/issues/133)，需求与验收继续由 Issue 维护。

**当前结果只表示观察结论。** 所有 `PolicyEvaluation` 固定为 `mode: 'observation'`、`executionAdmission: 'not-issued'`，包括 `outcome: 'auto'`。模块尚未接入实际权限读取、Decision、授权更新或 Run 准入；现有 authz、TaskService 和 ReviewRound 仍按原有路径工作。

## 入口与调用

公开函数见 [policy/index.ts](../src/server/policy/index.ts)，输入和解释 DTO 见 [shared/policy.ts](../src/shared/policy.ts)。

| API | 行为 |
| --- | --- |
| `normalizePolicyAction(input)` | 严格解析已定义动作，返回规范 `action` 和 `actionDigest`；拒绝未知 kind、字段和不合法引用。 |
| `composePolicyRules({ global, project? })` | 验证文档并组合全局与项目规则，返回有效规则及来源；不修改输入。 |
| `createDefaultPolicy(revision)` | 使用显式修订号生成独立的默认全局策略数据；不写数据库或配置。 |
| `evaluateAction(request)` | 返回处置结果、规则/授权匹配解释、缺失事实和执行前提。 |
| `previewPolicy(request)` | 返回 `{ kind: 'policy-preview', sideEffects: 'none', evaluation }`。 |
| `PolicyInputError` | 无效输入抛出此错误；`code` 为 `action_input_invalid`、`policy_input_invalid` 或 `context_input_invalid`，`fields` 去重并排序。 |

`PolicyEvaluationRequest` 包含 `action`、`stage`、`policies` 和 `context`。`stage` 为 `proposal` 或 `execution`；`context` 提供显式时间 `evaluatedAt`、一致快照身份 `policyRevision`、动作注册表 `registry` 和 `TrustedPolicyFacts`。

注册表的条目只含 `kind`、`handlerId`、`revision`、`available`。它描述可信适配器声明的能力，不持有可调用执行器，也不主动发现宿主。没有可用注册条目的动作返回 `deny`；列入动作 schema 不等于产品已提供对应 handler。

下面的包装示例使用仓库根目录下的相对导入路径。调用方必须从有权读取的当前服务/适配器加载参数，不能把 HTTP/MCP 正文中的 `context` 或模型声明直接当作可信事实：

```ts
import { previewPolicy } from "./src/server/policy/index.ts";
import type { PolicyDocuments, PolicyEvaluationContext, PolicyStage } from "./src/shared/policy.ts";

export function inspectLoadedAction(
  action: unknown,
  stage: PolicyStage,
  policies: PolicyDocuments,
  context: PolicyEvaluationContext,
) {
  return previewPolicy({ action, stage, policies, context });
}
```

完整可执行输入见 [policy-fixture.ts](../tests/helpers/policy-fixture.ts)。该 fixture 中的 handler 与可信快照都是测试构造数据，不代表生产能力已接通。

## 默认处置与规则覆盖

默认值以复用有效授权、让负责人处理日常取舍为目标。最终结果仍受当前阶段守卫、授权与预算约束，以及所有有效规则共同限制。

| 类别 | 动作或条件 | 默认处置 |
| --- | --- | --- |
| 授权内常规工作 | `task.execute`、`runtime.start_authorized` | `auto` |
| 组织、技术和常规重试取舍 | `task.assign`、`task.replan`、`review.decide`、`runtime.retry_authorized` | `owner` |
| 已授权交付 | `delivery.create_pr`、`delivery.merge`、`delivery.deploy`、`delivery.publish`；CI、独立审查、目标版本等前提满足 | `auto` |
| 范围或授权变更 | `scope.change`、`authorization.expand` | `human`，需要新的用户选择 |
| 用户保留项或可补足的授权/预算缺口 | 具有提案资格且允许相应变更 | `human`，列出执行前提 |
| 禁止、越界、无相应阶段资格、不可委托或执行硬权限失败 | 可信事实确认阻断 | `deny` |

常规工作和已授权交付无需因换会话、拆票或重复预览再次索要许可；组织与技术取舍由负责人处理。这里的 `owner` 表示策略要求的项目决策者，不提升为 authz 的 `owner` 角色。

规则只允许动作种类、项目 ID、受控资源引用、候选是否变化、可信授权是否匹配、预算/重试是否额度内、用户保留标记等条件。条件之间取 AND，选择器数组内部取 OR；资源选择器可以匹配 `expectedSubjectRevisions` 中任一受控引用。schema 拒绝脚本、任意表达式、额外字段和冲突规则 ID。

全局 `locked: true` 或 `overridable: false` 的规则不能被项目覆盖。项目 `overrides` 必须完整替换一个存在且明确可覆盖的 `ruleId`；附加项目规则不会替换原规则。所有命中按 `auto < owner < human < deny` 取最严格结果，显示顺序不影响语义；空命中使用带 `builtin.default.*` 来源的对应动作默认规则。

## 可信事实与两阶段边界

服务层应提供当前主体及成员代际、项目和对象生命周期、目标版本与候选摘要、阶段守卫结果、已核实授权、grant 当前修订/epoch、预算、重试额度和交付检查。内核只解释这些输入，不自行证明其来源，也不查询真实权限。

必需事实不足时返回 `status: 'evaluation_incomplete'`、`outcome: 'deny'` 和 `missingFacts`；未知值不会默认为已授权或低风险。预算使用非负安全整数单位；`requiredUnits: 0` 表示可信适配器已核实无需支出。无法度量支出或所需可用预算时，不承诺自动支出权。

`proposal` 检查当前对象可读性、`proposal:create` 资格、现有提案范围、允许的动作种类及可委托边界。在这些条件满足时，尚缺的有界授权或可调整预算可以成为 `human` 提案的执行前提。请求中的新增资源仅为未验证描述；内核不会读取、枚举、挂载或启动它们。

`execution` 另外检查资源权限、能力、执行范围、当前授权、宿主支持和禁止标记。任何硬前提失败均为 `deny`，策略和 standing grant 不能抵消。该阶段得到 `auto` 依然只是观察结果；真正执行仍需后续服务重新读取当前权限和目标、验证所需决策来源、预留额度并取得真正准入。

## Grant 复用与新用户选择

`PolicyGrantFact` 是可信适配器加载的快照，不是本模块新增的持久授权模型。匹配核对当前 revision/authorizationEpoch、撤销状态、主体、项目、动作种类、全部受控引用、候选及动作摘要绑定、有效期限、剩余次数、预算和重试约束。解释包含匹配的 `grantRefs`，以及每份授权的 `grantChecks`；旧、撤销、错资源或超约束的授权给出具体不匹配理由。

`existingAuthorization` 表示可信来源核实的其他当前授权，不接受模型自行声明。匹配 grant 不新增静态角色能力，也不消耗或预留次数。

`requiresFreshHuman` 的结果至少为 `human`，且 schema 不允许它以 `authorizationMatched` 条件免除新选择。即使 standing grant 匹配，解释仍保留 `fresh_human_required`；本模块不创建或验证一份真实用户选择。

## 版本、摘要与重放

公共 schema 版本为 `POLICY_SCHEMA_VERSION = 1`，默认规则/守卫修订为 `DEFAULT_POLICY_REVISION = 1`。这不是数据库迁移版本。

`actionDigest` 为 `sha256:` 加上 SHA-256 的十六进制结果。哈希输入是 UTF-8 编码的 `boardroom.action.v1\n` 与规范 JSON 的拼接，其中 `\n` 表示一个 LF 字符。对象键按 JavaScript UTF-16 顺序排序，字符串使用 `JSON.stringify` 转义；受控引用列表按 `[kind, id]` 的 JSON 编码排序。请求资源和请求动作种类按集合去重并排序，标识符及描述按 schema trim；不解析路径或进行 Unicode 归一化。固定向量见 [policy-input.test.ts](../tests/policy-input.test.ts)。

摘要绑定规范动作及其对象引用和预期修订；`stage`、求值时间、调用者身份、grant 和策略内容不参与动作摘要。两阶段可以使用同一 actionDigest，但摘要不代表任何主体拥有执行权。

解释保存 `policyRevision`、`globalRevision`、`projectRevision`、`defaultRevision`、`registryRevision`、UTC 格式的 `evaluatedAt`、命中规则、有效来源、授权引用和处置理由。内核不读取 `Date.now()` 或生成持久修订。需要完整重放的调用方应保留原动作、策略及可信上下文输入；解释 DTO 不包含全部可信事实。

## 验证范围与后续接入

直接测试位于 `tests/policy-*.test.ts`，覆盖白名单拒绝、固定摘要、规则排列、锁定与覆盖、资源选择器、缺失事实、两阶段权限、失效 grant、fresh-human 和无副作用预览。具体命令和按候选运行的结果由关联 PR/验收记录维护。

[policy-preview.test.ts](../tests/policy-preview.test.ts) 在完成现有迁移的 SQLite 数据库旁调用预览，比较前后完整数据库镜像、写计数、工作事件和 runner 状态，并冻结输入核对 grant 次数及预算不变。这些证据覆盖纯预览，不代表真实 handler、持久授权或额度领取并发已经验收。

当前模块没有 PolicyDocument CRUD/HTTP 页面、Decision/Conversation/UserInitiation/AuthorizationGrant 持久化、授权更新、Run、执行 handler、额度事务或 UI。后续接入必须继续沿用实际权限与资源边界，不能将 `observation` / `not-issued` 结果直接转换成副作用准入。

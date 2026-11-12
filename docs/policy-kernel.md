# 策略配置、求值与解释预览

状态：草案（实现候选，待独立审查）

日期：2026-11-11

本模块提供无副作用的策略求值，以及全局/项目策略的持久配置和版本读取。纯内核来源为 [S1-T1 #133](https://github.com/gbcdby/boardroom/issues/133)，持久服务来源为 [S1-T2 #151](https://github.com/gbcdby/boardroom/issues/151)，需求与验收继续由 Issue 维护。

**当前结果只表示观察结论。** 所有 `PolicyEvaluation` 固定为 `mode: 'observation'`、`executionAdmission: 'not-issued'`，包括 `outcome: 'auto'`。模块尚未接入实际权限读取、Decision、授权更新或 Run 准入；现有 authz、TaskService 和 ReviewRound 仍按原有路径工作。

## 入口与调用

纯函数见 [policy/index.ts](../src/server/policy/index.ts)，持久服务见 [configuration.ts](../src/server/policy/configuration.ts)，输入和解释 DTO 见 [shared/policy.ts](../src/shared/policy.ts)。纯函数入口保持不依赖数据库。

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

当前模块提供下文的 PolicyDocument 管理服务与 HTTP API，没有策略管理页面、Decision/Conversation/UserInitiation/AuthorizationGrant 持久化、授权更新、Run、执行 handler 或额度事务。后续接入必须继续沿用实际权限与资源边界，不能将 `observation` / `not-issued` 结果直接转换成副作用准入。

## 持久配置与启动初始化

数据库是唯一可写权威。v17 新增 `policy_documents` 当前头与 `policy_document_versions` 历史版本两表；全局键为 `user`，项目键为 `project:<projectId>`。项目头受项目外键约束，历史版本的组合主键为 `(document_id, revision)`。服务只追加版本、推进头，不提供修改或删除历史的 API；项目物理删除与全库清空按各自既有流程处理历史。`config.json`、工作目录或文件视图不会成为另一份可写规则来源。

HTTP 与 stdio 的可信启动均在环境校验、数据库迁移成功之后，监听/传输连接和后台写入之前调用 `initializePolicyConfiguration`。首次在同一事务中写 `createDefaultPolicy(1)`、head、不可变版本，以及真实 `system / policy-bootstrap` 的 user scope `policy.initialize` 审计。已有 head 时校验并读取原版本；并发/重复初始化不重复审计、不覆盖用户规则。初始化写入或审计失败整体回滚，启动失败；当前内容损坏也不会自动回退默认。迁移本身不 seed，数据复制目标因此保持空表。

普通 GET、历史列表、有效规则和 preview 不调用初始化。全局尚未初始化时，当前配置/有效规则/预览和列表返回 `policy_not_initialized`；请求一个不存在的固定历史版本则为 `policy_version_not_found`。项目未保存过策略时，当前 `policy` 为 `null`、`projectRevision` 为 `null`，显式继承全局规则且不创建项目头。保存 `{ rules: [], overrides: [] }` 会保留一次明确的项目版本与审计，表示当前无项目附加/覆盖规则。

`PersistedPolicyDocument` 返回完整 `document`，以及：

| 字段 | 含义 |
| --- | --- |
| `ref` | `scope`、`projectId`、`revision`、`contentDigest`，标识固定内容。 |
| `defaultRevision` | 保存该版本时的默认规则/守卫版本。 |
| `basedOnGlobalRevision` | 项目保存时实际核对的全局版本；全局文档为 `null`。 |
| `createdBy`、`createdAt` | 可信创建者 kind/id 与 UTC 时间；客户端不能填写。 |

`contentDigest` 是 UTF-8 `boardroom.policy-document.v1\n` 加 `canonicalJson(document)` 的 SHA-256，返回 64 个十六进制字符；这里的 `\n` 为 LF。完整规范正文保存在版本表，读取时同时核对 schema、作用域、修订、规范字节和摘要。审计 `before/after` 保留固定 `ref`，`detail` 保留默认/基于全局修订与配置操作标记；完整历史不依赖审计正文，既有 32KiB 限制不变。

`getEffective` 用单条 SELECT 的快照读取全局与项目当前头，复用 `composePolicyRules`，返回两个持久文档、`globalRevision/projectRevision/defaultRevision`、规则及其 `source`、`policyRevision`，以及 `observation/not-issued`。规则锁定和可覆盖属性保留在返回的全局原文档；被覆盖规则的 source 明确给出 `replacedGlobalRevision`。`policyRevision` 绑定全局摘要、项目摘要及默认版本；它是当前组合的内容身份，不是执行授权。

## 保存事务与全局/项目组合一致性

所有管理读写均要求既有可信本地 human 管理身份；全局管理要求非项目局限的身份。项目入口继续检查真实项目和既有管理范围。归档项目可读取历史与预览，保存必须先显式恢复。Agent/MCP 主体和跨项目管理被拒绝。

全局 PUT 必须带正整数 `expectedRevision`；项目 PUT 首次带 `expectedRevision: null`，以后带当前项目修订，并始终带 `expectedGlobalRevision`。字段白名单直接复用纯内核 schema；scope、projectId、schemaVersion、revision、创建者与时间由服务端构造，不能从正文覆盖。

项目保存先持有现有 mutation coordinator 的项目锁，再取得全局 head 行锁；全局保存只取全局 head 锁。取得锁后读取实际全局修订，再校验组合、CAS 当前头、追加版本、写审计并提交。全局更新不在持有全局锁后反向索取项目锁，因此与项目保存保持同一锁顺序。版本冲突、组合冲突、审计或版本写入失败均不留下部分提交。

全局规则改变前，在相同事务内读取并重新组合**所有已有项目策略，包括归档项目**。删除覆盖目标、把它锁定或设为不可覆盖、或新增与项目附加规则同 ID 的全局规则，会拒绝整次全局保存，并列出冲突项目、项目修订、字段路径与项目策略修复入口。用户先显式修正项目覆盖再重试；不会自动删掉覆盖、回退默认或部分保存。项目保存与全局改变串行经过同一全局 head 锁，不能提交一个从未校验过的组合。

全局扫描与项目 purge 并发时可能保守报告一个正在删除的项目冲突；重新读取后重试即可。任何未提交的全局修改均不作为当前有效配置返回。归档/恢复项目不会修改策略 revision。

## 正式 HTTP 契约

路由挂在现有本地管理 API，仅接受 `localhost` / `127.0.0.1` Host 和同源 Origin（无 Origin 的本地调用也允许）。身份由既有受信 resolver 提供；正文不能自报 user/actor。所有响应 `cache-control: no-store`；写入/预览要求 JSON，正文上限 1,000,000 字节，超限拒绝而不截断。

下表中 `BASE` 为 `/api/policies/global` 或 `/api/projects/:id/policy`。

| 方法/路径 | 输入 | 成功响应 |
| --- | --- | --- |
| `GET BASE` | 无正文 | `{ policy: PersistedPolicyDocument \| null }`；全局成功时非 null。 |
| `PUT` 全局 BASE | `{ expectedRevision, rules }` | 200 `{ policy }`，新的全局版本。 |
| `PUT` 项目 BASE | `{ expectedRevision, expectedGlobalRevision, rules, overrides }` | 200 `{ policy }`，首次也是 200。 |
| `GET BASE/versions` | 可选 `limit` 1–100，默认 50；可选正整数 `beforeRevision` | `{ current: PolicyDocumentRef \| null, versions: PolicyVersionMetadata[] }`，按修订倒序；历史内容通过下一行读取。 |
| `GET BASE/versions/:revision` | 正整数固定修订 | `{ policy }`，完整不可变文档。 |
| `GET BASE/effective` | 无正文 | `{ effective: EffectivePolicyConfiguration }`。 |
| `POST BASE/preview` | `{ draft?, action?, stage? }` | `{ preview: PolicyConfigurationPreview }`，零写入。 |

未知字段、未知或重复查询参数均拒绝。不支持 DELETE 策略或版本；清空项目附加/覆盖内容仍使用带 CAS 的 PUT，保留历史。

配置错误响应为 `{ error: { code, reason, message, fields, current, conflicts } }`。`current` 是冲突时最新可读引用，供前端保留用户草稿并请求比较，不代表服务端已保存该草稿。组合冲突条目为 `{ projectId, projectRevision, fields, repairEndpoint }`。字段路径会指出如 `project.overrides.default.task.assign` 的具体规则。

| HTTP | `reason` / `code` | 含义 |
| --- | --- | --- |
| 400 | `policy_input_invalid`、`policy_action_scope_mismatch`、`policy_query_invalid` | 字段/规则/阶段或路径作用域无效。 |
| 400 | `policy_json_required`、`policy_invalid_json`、`policy_body_too_large` | 请求格式或大小不合约。 |
| 403 | `forbidden` | 非可信 human、越过管理范围或不同源。 |
| 404 | `policy_project_not_found`、`policy_version_not_found` | 项目或固定版本不存在。 |
| 409 | `policy_not_initialized` | 可信启动尚未完成初始化；GET 不代替启动。 |
| 409 | `policy_revision_conflict`、`policy_global_revision_conflict` | head 已变化；响应指明实际 current。 |
| 409 | `policy_project_conflict` | 全局候选与现有项目配置不兼容，整次未提交。 |
| 409 | `archived`、`mutation_scope_changed` | 沿用项目生命周期与 mutation 边界。 |
| 500 | `policy_storage_invalid`、`write_failed` | 持久数据校验或写入失败；不返回底层 SQL/正文。 |
| 405 | `method_not_allowed` | 不支持的方法，附 Allow。 |

现有 repository 错误保留既有 `code`（如 `archived`），不承诺每个错误都包含配置冲突字段。HTTP API 不注册任何 MCP 写工具。

## 管理预览与执行能力

`draft` 只接受本入口可编辑的字段：全局 `{ rules }`，项目 `{ rules, overrides }`；省略表示预览当前持久配置。返回 `source: current | draft`、当前 `base` 固定引用，以及单独的 `candidate` 文档/有效规则。草稿候选使用拟下一 revision，**不代表该 revision 已存在**；保存仍需重新进行 CAS 和所有项目组合校验。全局草稿预览只解释候选全局规则，不承诺能够通过所有项目的保存校验。

动作预览必须同时提供 `action` 与 `stage`，动作的 projectId 必须等于入口作用域；全局入口对应 null。客户端 `facts/context/registry/policyRevision/actor` 均不接受。当前切片未建立可信执行事实或 handler 适配器，服务端使用空注册表与空事实调用原 `previewPolicy`，返回 `action.availability: unavailable`、`reason: trusted_adapter_unavailable`；纯内核给出 `handler_unavailable` 和 `deny`。它不会伪造一个可用 handler 再补“已授权”事实。

所有管理预览固定 `mode: observation`、`executionAdmission: not-issued`、`sideEffects: none`，不会写策略、审计、工作事件、队列或 runner。未来添加事实适配器时仍须保持可信来源；缺失必需事实只能按原内核返回 `evaluation_incomplete`，不能自动放宽。

## 迁移、删除与检查范围

v17 仅新增两张策略表，并按现有双数据库方式重建 `audit_log` 以扩展 `policy_document` target kind。原 user/project scope、全部列值、审计 ID、撤销引用和四个审计索引保留，旧迁移 SQL/checksum 不变。v16 仍归 #137；`tests/fixtures/policy-task-intake-v16.ts` 是带准确来源 commit、原文件摘要的真实 v16 测试输入，不是生产迁移或依赖释放。兼容测试分别构造非空 v15 与执行了真实 v16 的输入；最终生产清单出现 v16 时改用并核对实际定义，避免重复注册。

全库 copy/compare/clear 清单包含策略头和全部版本，校验规范正文、摘要、scope、revision、创建者/时间及全局/默认来源，不仅核对行数与主键。迁移目标不初始化默认，复制后启动读取已有全局版本。项目 purge 显式先删策略版本再删策略头，返回 `policyDocuments/policyVersions` 两项计数；项目策略及其历史进入删除影响摘要。保存或历史变化使旧确认失效；群删除、其他项目和全局策略不受影响。永久删除的审计仍按既有规则保留。

`tests/policy-config*.test.ts` 包含真实数据库服务、正式 HTTP socket、stdio SDK/HTTP 重启、CAS/组合交错、回滚、迁移、复制/清库/删除和零写入预览检查。SQLite 与 PostgreSQL 用同一行为矩阵，PG 未配置时明确 skip；不能将本地 SQLite 通过当作 PG 通过。具体候选日志、独立需求/标准审查与 CI 结果由 #151/PR 记录。未覆盖策略页面、实际执行/撤权、模型宿主、旧二进制写入 fence 或产品发布。

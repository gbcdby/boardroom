# 工具目录与选择计划内核

本模块提供 [S7-T1 #145](https://github.com/gbcdby/boardroom/issues/145) 的纯解析边界。没有 HTTP/MCP 注册入口、网络请求、进程启动、数据库读写、凭据读取或工具调用。

## 入口与输出

| 函数 | 输入 | 返回 |
| --- | --- | --- |
| inspectMcpConnection | 明确连接声明、修订、启用状态、stdio/HTTP 配置及可选 credentialRef | 不含端点、命令、参数、凭据引用的连接投影；含配置摘要 |
| createToolCatalogSnapshot | 连接声明、调用方提供的观察时间和发现结果 | 确定性、递归冻结的目录快照 |
| readToolCatalogSnapshot | 已保存的 JSON 快照 | 重新核对 schema、引用及快照摘要后的冻结快照 |
| resolveToolPlan | 作用域、固定目录、明确选择、同作用域的当前可用范围 | 常驻 schema、按需摘要、缺项及原因；固定为 observation / not-issued |
| previewToolSchema | 相同的当前观察输入和精确 ToolRef | 仍被选择且可用的 schema 预览；其他返回 null |

所有入口接受 unknown 并做运行时校验。非法输入抛出 CapabilityInputError，错误只包含固定代码，不回显输入正文。输入不被修改，返回值递归冻结。连接声明不会执行安装或启动命令；HTTP URL 拒绝用户信息、query 与 fragment，认证只能使用独立 credentialRef，不接受 headers/env 等原始凭据字段。传输名称仅声明配置形状，不代表真实宿主支持。

## 身份、版本与外部数据

工具引用包含 connectionId、connectionRevision、原始 name 与 schemaDigest。toolKey 对结构化元组求摘要，不通过拼接显示名消歧。inputSchema 或 outputSchema 改动形成新 schemaDigest；描述和 hint 变更形成新目录快照，但不授予权限。目录按原名排序，对象字段顺序不影响身份；数组顺序保留。observedAt 标记调用方的实际观察输入，也参与 snapshotDigest。

schema 只接受纯 JSON 对象，根 type 必须为 object，properties/required 采用 MCP 形状检查。未知 JSON Schema 关键字和原样属性名保留；不加载远程引用、不编译 JSON Schema，也不执行参数验证。实际调用接入必须使用相应 dialect 的参数验证器。循环、访问器、toJSON、Proxy、函数、undefined、非有限数、特殊对象、稀疏数组、symbol 与额外非枚举属性拒绝。每次 JSON 解析限制深度 64、节点 100000、字符串及键合计 2000000 UTF-16 单元。失败目录没有可提供工具。

快照摘要只验证内容一致，不验证来源真实性。可信控制层负责提供真实目录/当前修订；不能从模型、未认证请求或任意文件读取后仅凭摘要把内容视为可信。

## 选择与许可的接入合同

ToolPlanScope 是本模块所需的**群实例观察投影**，包含 projectId、groupId、groupBindingId、instanceId、instanceGeneration、conversationId、conversationEpoch、configurationRevision、authorizationEpoch。它不代替 S2 的公共身份模型；本批不支持总管准入或把总管伪造成群实例。后续接入时由 S2 owner 提供投影适配。

selections 只接受已经明确选定的 toolRef、resident/on-demand、required/optional 和 sourceRef。推荐内容、角色名称、工具描述、readOnlyHint 不能生成选择或许可。S2 仍保存真实 Profile/Binding 和选择来源；本模块不建第二份可写配置。

availability 必须由可信控制层读取当前 S1/S2/S3 状态后构造：

- scope 必须与计划的全部作用域/代际/修订相同，防止旧群/实例的许可快照混入新上下文。
- connections 保存当前连接投影及其授权结果；allowedTools 是精确 ToolRef 白名单。连接启用、连接许可、工具许可和版本必须同时满足。
- 每个连接只能提供一份当前状态和一份本次选定的目录快照。重复、冲突或两个同名选择直接拒绝，版本选择由调用方先解决。
- 常驻工具得到完整 schema；按需集合只得到获准摘要。previewToolSchema 每次重新解析当前观察输入，没有可凭旧 plan/key 绕过的共享缓存。

这些参数是可信调用方的观察输入，**不是凭证**；调用方传入 authorized=true 不能成为真实执行授权。模块不判断来源是否可信，不签发执行权、不产生加载回执，也不证明 schema 已进入模型。后续网关必须在每次真实调用前重新检查 S1 策略、S2 身份/执行代际及 S3 资源/Run 条件。

selectionCompleteness 只表示 required 选择是否齐备，不是 Task/Run readiness。optional 缺项返回 requires-explicit-policy，由上层根据已明确的降级策略处理；本模块不自动放行、不换宽权限工具。普通选择修改生成新 planDigest，不原地修改旧计划；许可收紧后的新预览排除撤回项，但无法撤回已经发生的外部效果。

## 验证

运行 node --test tests/mcp-capability-catalog.test.ts tests/mcp-capability-plan.test.ts。这些检查是纯模块行为证明；真实连接、数据库、宿主装载、模型轮次、工具调用及撤权执行必须另行验证。

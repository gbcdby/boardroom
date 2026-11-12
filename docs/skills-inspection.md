# Skills 本地只读检查与选择预览

对应 Ticket #136（BR-COLLAB-S3-T2），消费 S2 `legacy-config-inspection/v1` 与 S4 环境解析结果。本切片提供本地技能目录的事实检查和确定性选择预览，不改变现有 legacy runtime 配置权威。没有新增数据库表、HTTP/MCP 路由或运行入口。

## 入口和结果

| 入口 | 输入与职责 | 输出 |
| --- | --- | --- |
| `inspectLocalSkillPackages` | 明确选中的包目录、集合目录、work-suite 清单；只读完整相对资源树 | 包元数据、每个文件摘要、内容摘要、来源别名、清单核对结果、结构化问题 |
| `resolveSkills` | 已检查候选、Project/Profile/群选择、精确版本映射、S2 原快照引用和来源修订 | `skill-lock-preview/v1` 或可定位来源的冲突 |
| `inspectSkillCatalog` | 实际 S4 环境对象和明确来源 | 服务级目录 DTO；保留 `skillsRoot` 的 `planned/legacy` 状态 |
| `previewLegacySkills` | S2 实际 binding 检查结果、与目标快照关联的选择事实、候选来源 | 通过 S2 唯一选择器取得原快照，再组合目录与解析结果 |
| `scripts/inspect-skills.ts` | 可信本机命令行参数 | 目录 JSON；问题退出码为 1，成功为 0 |

所有输出明确保留 `readOnly: true`、`activationAllowed: false`。锁的 authority 是 `preview-only`；成功状态叫 `resolved-preview`。不存在 `available`、调用接受回执或宿主加载回执。

命令行例子（将 `/absolute/boardroom` 替换成实际绝对路径）：

```sh
node scripts/inspect-skills.ts --work-suite /absolute/boardroom
node scripts/inspect-skills.ts --collection /absolute/boardroom/.claude/skills
node scripts/inspect-skills.ts --package /absolute/my-skill
node scripts/inspect-skills.ts --help
```

参数可以重复。不传来源时返回空目录，不自动扫描当前项目、用户目录或环境规划的包库。`--work-suite` 读取指定仓库下 `.agents/skills/work-suite.json`。CLI 只使用 S4 投影中的路径/状态，不连接业务数据库，也不输出连接串、源文件正文或脚本内容。

## 包边界与内容身份

显式来源必须是无 `..` 的绝对本地目录。集合入口只枚举一层含 `SKILL.md` 的包目录；`.claude/skills` 与 `.agents/skills` 若指向相同真实目录，只枚举一次，各来源别名仍保留。包根可以通过用户显式选中的目录别名定位，但包内的符号链接必须保持相对、解析后仍位于该包内。合法内部文件/目录链接保留原始相对布局；目录环、包外链接、绝对链接、损坏链接均不能形成成功包。

完整条目清单包含普通文件、目录、符号链接、相对路径、文件字节数、文件 SHA-256 和链接目标。包 `contentDigest` 是对 `skill-content/v1` 及按路径排序的完整条目清单进行规范化 JSON 后计算的 SHA-256；对象键按代码点排序。任何资源内容变化、资源增删、目录/链接结构变化都会改变摘要。来源目录路径不进入包内容摘要，允许同内容跨来源合并。

本票没有导入不可变版本。每个包的 `versionId` 固定为 `null`，另提供 `skill-preview:sha256:<contentDigest>` 作为诊断引用。不要把这个诊断引用当成 S1 所需的持久 `versionId`。

work-suite/v1 校验每个声明文件的实际 SHA-256、完整文件集合、名称和标准相对包路径；记录清单自身 SHA-256。当前导出协议中 `add-disable-model-invocation` 的 `source_sha256` 也按原导出变换逐字节反算核对。清单重复 JSON 键、重复名称/文件、未知变换、缺文件、额外文件、摘要不符会报错。清单只是数据，不执行其中指向的任何资源。

文件读取使用有界 fd 读取，核对普通文件、读前/读后身份与资源树变化。FIFO、socket、设备文件会拒绝；多硬链接文件因来源边界不明也拒绝。该检查是可信本机来源的只读预检，不能替代之后运行时的操作系统隔离、资源授权或运行前重新核对。

默认预算如下；可信服务调用方可显式调小或调整为正整数，不改变扫描与调用权限：

| 范围 | 默认上限 |
| --- | --- |
| 包数量 | 256 |
| 每包文件/目录/链接条目 | 4096 |
| 包目录深度 | 32 |
| 单文件 | 8 MiB |
| 单包累计读取 | 64 MiB |
| 本次包及清单累计读取 | 256 MiB |
| 单个 work-suite 清单 | 1 MiB |
| SKILL frontmatter / agents 策略 YAML | 64 KiB |

## 元数据和人工调用限制

使用直接依赖 `yaml@2.8.3` 解析真实 YAML 1.2 core 数据；拒绝重复键、自定义/显式标签、锚点、别名、多文档和不符合字段类型的值。不会把 YAML 文本中的字符串片段匹配成权限设置。

识别的调用来源包括：

- `SKILL.md` 的布尔 `disable-model-invocation`。
- `agents/openai.yaml` 的嵌套布尔 `policy.allow_implicit_invocation`。
- `SKILL.md` 的 `boardroom.invocationMode`。
- 经摘要核对的 work-suite `invocation` 声明。

任一来源要求人工发起时结果为 `user-only`，允许自动的声明不能覆盖它。没有可靠识别到调用约束的第三方包保留 `unknown`。同摘要来源合并时仍保留严格的调用条件。当前 work-suite 的 `auto/challenge/guide/setup/steer` 五个入口保留用户专用限制。

所有锁条目的 `invocationEligible` 都是 `false`。勾选、目录预览、解析成功都不构成人工发起，不消费 nonce、不登记 invocation、不提供正文/脚本给 Agent，不批准运行、联网或写入工作区。`implicit-or-explicit` 只是来源元数据分类，也不是 Boardroom 的执行授权。

## 资源和精确依赖数据

`name`、`description` 必须是有效元数据，显示用 `version` 可选且为字符串。显式资源和依赖可放在顶层 `resources/dependencies` 或 `boardroom` 扩展中；两处声明按完整内容合并。依赖只接受精确内容摘要或已存在的精确版本 ID，不解析 semver 范围，不联网查找或安装。

```yaml
---
name: sample
version: "1.0.0"
description: 供本地目录检查的样例
boardroom:
  invocationMode: user-only
  dependencies:
    - skillName: helper
      pin:
        versionId: existing-immutable-version-id
  resources:
    - path: references/checklist.md
      required: true
---
```

资源路径必须是包内规范相对文件路径并存在。`pin` 只能有 `versionId` 或 `contentDigest` 中的一个；内容摘要必须为 64 位小写十六进制。字段声明存在但结构不受支持时报告 `metadata_invalid`，不会静默丢掉依赖约束。正文中提到其他技能不等于显式依赖；`allowed-tools` 等其他源元数据不提升 Boardroom 权限。

## 确定性选择和冲突

选择按 Project → Profile → 群的明确配置层组合。每个配置层有 ownerId、原 revision 和选择列表。没有明确启用的扫描候选不会自动进入锁。群/Profile 可以显式增删和固定版本；没有覆盖的 pin 继续继承。所有明确启用项默认 required，显式 `required: false` 才是 optional。

Project 的 required/locked 不能被后续层停用或换成不兼容版本；locked 只允许在 Project 层定义。Project 可锁定停用状态，后续层也不能擅自启用。同一配置层含矛盾重复项时返回结构化冲突。

同名同内容合并来源；同名不同内容必须由精确 pin 消除歧义。`knownVersions` 只接受调用方已有目录的 `versionId → skillName/contentDigest` 映射；本票不生成该映射、不写入目录。声明 semver、相似名称、扫描次序都不能替代精确版本。

依赖按精确约束展开；精确依赖可以解除未 pin 根技能的歧义。required 传递到依赖。显式禁用的依赖、缺失版本、不兼容 pin、依赖环都会返回冲突。每个冲突带 Project/Profile/群/依赖来源以及候选引用。依赖图另限制为 256 个节点、4096 次展开边，防止无界解析。

当前预览没有用户定义的降级策略，因此 optional 项解析失败也保留冲突，不默默丢弃。无技能是合法结果，锁中条目为空。

包、来源、选择、依赖和映射的输入排列不会改变解析结果或锁摘要。锁记录选定条目、来源解释、完整选择事实、精确版本映射、候选目录摘要、全部配置修订、工作区修订与原 S2 快照引用。输出复制原值，后续修改调用方输入不会改写已有锁。

## S2 与 S4 的来源保真

`previewLegacySkills` 必须消费 `createLegacyConfigInspector` 实际产生的 binding 检查结果，由 S2 的 `selectLegacyConfigSnapshot` 唯一选择 requested → applied → effective。配置损坏或身份不唯一时阻断，不能降级为另一份配置。

选择层没有在旧 runtime 中新增权威存储。调用方要显式传入 `selectionSnapshot`，把这组选择事实关联到原 `configSnapshotRef`；不能用最新 Profile 选择替换旧快照中的来源事实。这是可信服务装配契约，不是可接收任意客户端自报来源的公共接口。

- 已固定 requested/applied 使用原 snapshotRef、原 runtime/binding revisions 和原选择层修订。最新 pending 配置变化不会覆盖这个目标。
- effective 是未固定预览，必须提供当前选择来源修订和当前快照引用对照；缺少对照或任何来源变化都会返回 `source_changed`。
- 用户明确 apply/新目标快照后，S2 选择器产出的目标引用改变；拿旧 selectionSnapshot 继续预览也会返回 `source_changed`。
- S2 原 rawJson 和选择原因保留在服务结果中；本服务不重写原始工作目录、原权限选择或会话状态。

S4 的 `skillsRoot` 按真实 resolver 结果投影为 `planned/legacy`，`materialized` 始终为 false。不创建 `~/.boardroom/skills`、不创建 v2 存储、不把 source package 复制进项目、不改 AGENTS.md、SKILL.md、宿主配置或现有数据库。项目工作区服务 #135 不构成本预览的依赖；工作区修订由已验证调用方显式提供，无工作区时为 null。

## 验证入口与后续边界

```sh
node --test tests/skill-inventory.test.ts tests/skill-resolver.test.ts tests/skill-preview.test.ts
npm run typecheck
```

行为检查覆盖真实 work-suite 逐包/逐文件校验和别名、源树不变、YAML 结构、内部/外部链接与特殊文件、预算边界、明确资源依赖、精确 pin、required/locked、依赖图、乱序稳定、输出值独立、CLI 无副作用及真实 S2/S4 组合。S2 组合测试使用真实 SQLite，并提供同一 PostgreSQL 用例；没有 PG 配置时明确 skip，由数据库 CI 执行。

本切片没有数据库迁移、API 权限改动、运行时装配、包持久导入、挂载、UserInitiation/nonce/调用记录，也没有宿主加载或 available 证据。之后的导入/装配/执行工作需要各自独立的契约和验证，不能把这里的诊断摘要直接当作已导入版本或运行授权。

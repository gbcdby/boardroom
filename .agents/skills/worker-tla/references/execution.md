# 执行与证据协议

## 目录

- [依赖与工具固定](#依赖与工具固定)
- [运行清单](#运行清单)
- [执行命令](#执行命令)
- [通过判定与输出](#通过判定与输出)
- [支持范围](#支持范围)
- [附带案例与脚本检查](#附带案例与脚本检查)
- [持续集成](#持续集成)

## 依赖与工具固定

业务实现语言没有限制；附带脚本使用 Python 3.10+ 标准库，TLC 使用 Java 11+。无需特定 IDE、包管理器、MCP 服务或容器。工具依赖与业务运行环境分别记录。

默认工具固定在官方 v1.7.4 / TLC 2.19（2024-08-08），不是声称它是最新版本。`assets/toolchain.json` 保存官方来源、SHA-256 与实际验证日期；不打包 Java 或工具 jar。

先复用摘要一致的已有 jar。需要下载时执行：

```text
python <skill>/scripts/fetch_tlc.py --dest <absolute-tool-path>/tla2tools.jar
```

`<skill>`、`<absolute-tool-path>` 是需要替换的路径。Unix 常见命令为 `python3`，Windows 可使用可用的 `python` 或 `py -3`；以实际环境为准。执行时传递参数数组，不将路径拼入未转义的 shell 命令。

下载器只获取固定官方发布地址并核对摘要；已存在的不同内容不会被覆盖。网络不可用时继续可做的分析，报告缺失依赖，不绕过环境访问限制。不要安装系统级 Java 或改环境配置来掩盖权限问题。

升级工具时从可信官方发布确认来源，更新来源、版本与摘要，重新运行已知错误／修复及失败状态案例。标签名称不等于内容固定；摘要才绑定实际字节。不能仅为消除摘要错误而填写未知文件的摘要。

## 运行清单

复制并填写 `assets/verification.template.json`。清单位于功能验证目录，`model.root` 相对清单解析；`entry` 和 `config` 相对模型根目录解析。

| 字段 | 要求 |
|---|---|
| `schema_version` | 整数 `1` |
| `tool.version` | 显式版本说明；真实报告版本也会从工具输出保存 |
| `tool.sha256` | 工具 jar 的固定 64 位十六进制摘要 |
| `model.root` | 专门的模型目录相对路径；不要设为整个业务项目 |
| `model.entry` | 根目录内的入口 `.tla` 相对路径 |
| `profiles.<name>.config` | 根目录内的 `.cfg` 相对路径 |
| `timeout_seconds` | 本次 TLC 运行的正数秒预算；Java 探测另有短预算 |
| `workers`、`heap_mb` | 正整数；可复现小模型优先一个 worker |
| `expected_invariants` | 本次计划启用的不变式简单操作符名称数组 |
| `expected_properties` | 本次计划启用的时序性质名称数组；不检查时显式 `[]` |
| `checks_deadlock` | 显式布尔值，与配置一致；TLC 默认开启 |
| `deadlock_reason` | 关闭死锁检查时必须提供非空理由 |
| `scope` | 对象，写明具体规模、覆盖与排除内容；应与配置相符 |
| `assumptions` | 字符串数组，列出环境、公平性和原子性条件 |

配置中实际启用的不变式／性质集合必须分别与清单完全一致，至少启用一项。注释中的性质不算启用。增加、删除或更名性质应同时更新需求对应并解释差异，不能只改清单来迎合错误配置。

可在清单顶层记录 `requirements` 等背景信息，它们随清单快照保存；执行器不判断自然语言含义。不要把项目测试命令塞进 profile，执行器拒绝未知 profile 字段。

## 执行命令

```text
python <skill>/scripts/run_tlc.py --manifest <feature>/verification.json --profile small --jar <absolute-tool-path>/tla2tools.jar --out <feature>/runs/<new-run-id>
```

可加 `--java <executable-or-path>` 指定已有 Java。`--jar` 必须是绝对文件路径；`--out` 必须不存在且位于 `model.root` 外。输出目录已存在时拒绝覆盖，保留旧证据。

执行器复制 `.tla` 和 `.cfg` 输入、单独复制已核对的 jar，固定普通 BFS 模型检查，使用参数数组调用 Java。TLC 自身执行语法和语义分析；不要声称额外运行了独立 SANY，除非实际另行执行。

执行器清除可能改变 Java／TLA 搜索行为的环境注入变量，仅记录被清除的变量名。它不执行清单中的业务命令，也不传递任意额外 JVM／TLC 参数。

## 通过判定与输出

只有本次进程正常退出、出现模型检查／成功／完成消息、有非零可达状态、队列为空且没有错误，才可产生 `PASS_WITHIN_SCOPE`。同时必须通过性质清单、配置和工具摘要检查。

| 结果 | 脚本退出码 | 含义 |
|---|---:|---|
| `PASS_WITHIN_SCOPE` | 0 | 指定有限模型及性质的检查完成 |
| `COUNTEREXAMPLE` | 2 | 性质违反、断言失败或死锁等，需要分析 |
| `INCONCLUSIVE` | 3 | 超时、终止、资源限制或缺少完成证据 |
| `TOOL_ERROR` | 4 | 语法、配置、依赖或执行器不支持的用法 |

`NOT_RUN` 是未调用工具时的工作流状态，runner 不会将它当成成功。配置错误会尽量在新目录写入结果；若目录已存在或无法创建，读取命令输出，并明确没有生成新结果。

每次运行保留：

- `result.json`：状态、原因、开始／结束时间、实际命令、原始退出状态、资源中断信息、统计、检查清单与版本。
- `manifest.json`、`input/`：清单与模型／配置快照；结果包含文件 SHA-256 和 runner 本身的摘要。
- `tool/tla2tools.jar`：本次实际工具字节；结果保存摘要和 Java／TLC 报告版本。
- `tlc.log`：完整原始输出，包含反例状态序列。
- `messages.json`：TLC `-tool` 协议消息的结构化列表，不是通用实现轨迹格式。
- `states/`：本次工具状态文件；保留失败证据所需部分，清理时遵循项目规则。
- `runtime-home/`、`tmp/`：本次运行隔离的工具偏好与临时目录，不读取或改变用户原有工具偏好。

固定版本不支持新版 `-dumpTrace json`，所以执行器不传递该参数。需要其他轨迹格式时先验证具体工具版本，不能把当前 `messages.json` 冒充 JSON 状态轨迹。

`completed` 只有完整通过时为真；反例提前停止不是完成全状态探索。`implementation_status` 始终从 `NOT_ASSESSED` 开始。不要篡改工具结果文件来表示实现已评估；用户明确请求 `align` 时，使用单独的只读对应记录与报告。

## 支持范围

执行器接受标准模块及模型根目录内的本地 `.tla` 依赖、常规 `SPECIFICATION` 或 `INIT` + `NEXT`、字面常量绑定、简单名称的 `INVARIANT(S)`／`PROPERTY/PROPERTIES`、死锁设置。

执行器有意不支持模拟、任意额外参数、定义覆写、Java 覆写、外部模块 jar、符号链接、`CONSTRAINT`、`ACTION_CONSTRAINT`、`VIEW`、`SYMMETRY`、`ALIAS`、`POSTCONDITION` 等扩展。源码中的已知随机、真实时钟（`JavaTime`）、主动终止、状态式或外部 I/O 辅助设施也会被保守拒绝。完整名单以 `scripts/run_tlc.py` 的检查为准。

这些限制是执行器的范围，不表示 TLA+ 本身不支持相关能力。复杂项目需要这些能力时，先记录必要性与影响，使用经过专门审查的独立运行方式并保留同等证据；不要删掉关键语义以迁就 runner，也不要绕过限制后声称仍使用了受控流程。

源码检查属于保守词法检查，不是 TLA+ 语义证明或防恶意代码沙箱；同名普通标识符也可能被拒绝。模型真实性、关键路径可达性、假设合理性和实现对应仍由建模与审查步骤负责。非零状态数不证明目标业务路径已覆盖。

## 附带案例与脚本检查

`assets/examples/` 提供两个独立清单：

| 清单 | 配置 | 预期 |
|---|---|---|
| `idempotency.json` | `bug` / `fixed` | 重复副作用反例 / 有限模型安全性与活性通过 |
| `latest-result.json` | `bug` / `fixed` | 已收到结果的版本回退反例 / 有限模型安全性与活性通过 |

它们是说明和工具校验案例，不替代用户项目模型。每个案例的故障范围、原子性和公平性写在模型注释及清单中；不要把“最高已收到版本”误当成“最新发出请求”。

运行执行器回归检查：

```text
python <skill>/scripts/test_runner.py --jar <absolute-tool-path>/tla2tools.jar
```

不提供 jar 时只运行协议和输入检查，真实 TLC 用例会跳过，必须如实报告。用例覆盖实际通过、反例、空初态、遗漏性质、摘要不符、超时、中断和旧输出保护；测试夹具中的模拟消息仅用于分类器测试，不是模型验证证据。

## 持续集成

在已授权的现有质量流程中调用相同脚本；每次新建目录、固定配置，退出码非零即保留未通过状态。不要通过复用旧 `result.json`、忽略退出码或搜索成功字符串绕过检查。

真实实现测试交由实现方独立安排；本 Skill 只交付回归场景与未覆盖义务，不编写或运行项目测试。引用外部测试记录时核对提供方、命令、结果与实际源码内容标识。模型、工具、配置、需求或相关实现变动时重新评估证据，不能只监控 `.tla` 变化。

## 一手资料

- [官方固定版本发布](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)
- [TLA+ 官方工具使用](https://github.com/tlaplus/tlaplus/blob/master/USE.md)
- [官方工具选项与版本差异](https://github.com/tlaplus/tlaplus/blob/master/general/docs/current-tools.md)
- [官方消息代码](https://github.com/tlaplus/tlaplus/blob/master/tlatools/org.lamport.tlatools/src/tlc2/output/EC.java)

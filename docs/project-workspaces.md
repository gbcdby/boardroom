# 项目工作区配置与旧目录核对

本文说明当前实现的管理 API 与持久化约束。设计与交付范围以 [S3 Spec #127](https://github.com/gbcdby/boardroom/issues/127) 和 [实施票 #135](https://github.com/gbcdby/boardroom/issues/135) 为准。

## 当前能力

项目可以保存一个已存在的工作目录，也可以显式保存 `rootPath: null`，作为讨论项目。创建项目时可同时提交工作区；路径检查、项目、可选负责人关系、工作区版本与审计共同成功，失败不会留下半个项目。

工作区配置由项目持有。已有托管 runtime 的默认目录、绑定覆盖、requested/applied 快照、SID 和实际 cwd 继续保持原值。此入口只保存后续运行可消费的配置；`isolated` 与 `serialized` 是偏好，不表示已创建工作副本或取得写租约。预检和保存结果始终带 `runReady: false`、`requiresRevalidation: true`。

目录检查复用已经选定的 S4 环境及 `canonicalizePath`。生产 HTTP 装配显式传入 `ResolvedBoardroomEnvironment`；其他嵌入式调用方没有传入环境时，工作区入口返回 `workspace_environment_unavailable`，不根据 cwd 猜数据库和保护范围。`~/.boardroom` 新布局仍处于原环境描述的 planned 状态，不因项目保存而创建或启用。

## 配置版本与稳定引用

| 字段 | 含义 |
| --- | --- |
| `projectRevision` | 项目配置的 CAS 基准，初值为 1。改名、归档/恢复、工作区保存会推进；幂等归档/恢复、锁操作、群聊活动与运行心跳不推进 |
| `workspaceRevision` | 项目工作区不可变版本。0 表示从未显式配置；每次成功保存递增，包括 `rootPath: null` |
| `workspaceRef` | `{ projectId, workspaceRevision }`，可读取对应历史配置；项目永久删除后失效 |
| `savedProjectRevision` | 某个工作区版本保存成功时的项目配置版本 |
| `rootPath` | 用户提交的原绝对路径，保留符号链接入口和原始拼写 |
| `canonicalRoot` | S4 规范化得到的真实目录 |
| `rootIdentity` | 设备、inode 和创建时间观察值；按字符串保存，避免整数精度损失 |
| `physicalResourceKey` | 从真实根身份派生。同一物理根在不同项目或不同符号链接入口下得到相同 key |

`expectedProjectRevision` 必须取自最近读取的项目或工作区状态；时间戳不参与 CAS。两个请求提交同一基准，最多一个写入成功。失败保留原配置与版本，调用方可以保留自己的编辑草稿。

未带工作区的项目创建仍生成 `projectRevision=1`、`workspaceRevision=0`。带工作区创建在同一事务内保存第一份工作区，返回 `projectRevision=2`、`workspaceRevision=1`。

同一项目的 `mutationId` 标识一次工作区保存。相同 ID、相同输入及原 CAS 基准重放时返回该次保存的固定结果，不再次推进版本，也不重新应用旧目录；ID 对应不同输入时返回 `workspace_mutation_conflict`。较早的请求被重放后，应另行 GET 当前状态；重放结果中的版本代表原操作。创建新项目本身仍沿用原创建协议，工作区的 mutation ID 不充当跨项目的创建幂等键。

## HTTP 管理入口

这些入口沿用 localhost 单用户部署和现有权限矩阵。写入、任意路径预检及旧目录映射使用现有 `runtime:manage`，当前仅本地人类 owner 可执行；普通配置读取使用 `project:view`。所有项目读取和写入均按项目作用域检查。归档项目可查看，不能保存或解绑。

| 入口 | 请求与响应 |
| --- | --- |
| `POST /api/projects` | 原创建字段加可选 `workspace` 对象；返回原 `project` 视图及本次 `workspace`、`workspaceRef` |
| `POST /api/workspaces/preflight` | `{ rootPath }`；返回 `{ preflight }`，不创建项目或目录 |
| `GET /api/projects/:id/workspace` | 返回 `ProjectWorkspaceState`，包含项目/工作区版本、当前配置和稳定引用 |
| `PUT /api/projects/:id/workspace` | `{ expectedProjectRevision, mutationId, rootPath, mode? }`；返回本次保存的状态 |
| `DELETE /api/projects/:id/workspace` | `{ expectedProjectRevision, mutationId }`；追加 `rootPath: null` 版本并保留模式偏好及历史配置，不删除用户目录 |
| `GET /api/projects/:id/workspace/versions/:revision` | 返回 `{ workspace }`，读取固定的历史版本 |
| `POST /api/projects/:id/workspace/revalidate` | `{ workspaceRevision }`；重新检查该版本的根入口、身份和保护范围。成功仍不表示 Run ready |
| `GET /api/projects/:id/workspace/legacy-mapping` | 当前项目所有旧绑定的只读目录报告；重复的 `bindingId` 查询参数可限定本次参与映射的绑定 |

创建示例：

```json
{
  "name": "产品项目",
  "workspace": {
    "rootPath": "/Users/example/projects/product",
    "mode": "isolated",
    "mutationId": "workspace-create-01"
  }
}
```

保存示例：

```json
{
  "expectedProjectRevision": 2,
  "mutationId": "workspace-change-02",
  "rootPath": null,
  "mode": "serialized"
}
```

`mode` 省略时为 `isolated`；合法值仅有 `isolated`、`serialized`。`workspace: null` 不是讨论项目写法，讨论项目必须提交对象中的 `rootPath: null`。未知工作区字段会被拒绝，避免调用方误以为设置已经保存。

字段错误保留现有 `error.code` 与可分支的 `reason`，并提供 `fieldErrors`：

```json
{
  "error": {
    "code": "invalid_argument",
    "reason": "path_not_absolute",
    "message": "工作目录必须使用绝对路径。",
    "fieldErrors": {
      "rootPath": {
        "code": "path_not_absolute",
        "message": "工作目录必须使用绝对路径。"
      }
    }
  }
}
```

常见路径原因包括 `path_invalid`、`path_not_absolute`、`path_missing`、`path_not_directory`、`path_inaccessible`、`protected_path`。CAS 与 mutation 冲突为 HTTP 409。根被替换、符号链接改向、保存后目录不可访问或进入新的保护范围时，重新验证返回 HTTP 409、`error.code=workspace_changed`。

## 路径与 Git 观察

已有目录必须可读且可进入。系统 state、skills、memory、runtime、artifacts、实际数据源、选定配置文件和应用目录的保护范围由 S4 提供；工作目录不能与这些范围重叠，父目录与符号链接别名也会检查。预检不创建缺失目录，不写 `AGENTS.md` 或 Skills。

Git 检查只读取仓库元数据、索引和原文件字节。命令关闭 optional locks、fsmonitor、hooks 和外部 diff/textconv，排除继承的 `GIT_*` 定向变量，避免工作目录内配置触发外部程序；不会调用可能运行 clean filters 的工作树状态转换。所有命令必须识别 `--no-lazy-fetch`，另以空的 `GIT_ALLOW_PROTOCOL` 白名单禁止传输；partial clone/promisor 缺少对象时只报告观察不可用，不补取对象、不执行 remote helper。旧 Git 若不支持该命令行开关则明确失败为 `unavailable`，不会仅依赖可能被忽略的环境变量继续检查。

`repositoryInfo` 区分 `git`、`not_git`、`unavailable`，并报告 HEAD、索引变化、原始文件差异和未跟踪文件数量。`comparison=raw_bytes_no_filters` 表示保守的原始字节比较：例如 Git clean filter 或换行转换可能让原始字节与索引不同，因此脏状态只是观察。子模块、超出读取上限或读取不完整时使用 `complete=false`，不能在缺少依据时报告干净。

预检开始和完成时会比较根身份；保存提交前再次核对。上述时点检查无法替代后续 Run 的权限核对、文件系统边界检查、物理资源租约和实际 cwd 回执。

## 旧目录映射

报告消费 S2 `createLegacyConfigInspector` 捕获的原事实，并调用唯一的 `selectLegacyConfigSnapshot`。选择优先级仍由 S2 管理：原 requestedSnapshot、原 applied、已捕获的完整 effective；损坏的请求快照不能当作缺失后降级。

每个绑定分别保留三类快照的原目录、kind、source ID、digest 和版本引用，各自进行路径预检。`selectedSource` 表示原保存意图的唯一选择，不把最新 effective 改写成原 applied。S2 原问题及捕获摘要也随绑定返回；目录无效时保留原输入和具体字段原因。

本次选定绑定的全部可用目录一致且合法时，报告给出 `status=suggestion`，包含目录与各选定来源。任一快照目录无效、同一绑定的原快照目录不同、不同绑定目录不同或来源不可选择时，返回 `status=unresolved` 和具体原因。不会选择公共父目录、取最近时间值或默认扩大路径范围。选择子集时，外项目绑定被拒绝，不让未参与的其他绑定决定本次结果。

建议只是一份可检查的结果；读取不创建 Workspace、不写审计或 runtime，也不应用迁移。需要保存时仍通过显式的工作区保存入口。现有旧 runtime workdir 写入兼容行为在本阶段保持原样，后续完整配置权威迁移另行交付。

## 数据与删除边界

v15 追加 `projects.project_revision`、`projects.workspace_revision` 和 `project_workspace_versions`。工作区版本只追加；CAS head、不可变快照与审计在共同项目 mutation scope 的同一事务内提交。审计复用 project target，动作是 `project.workspace_update`。

项目永久删除的影响摘要覆盖 head 和全部工作区版本；预览后配置变化会令确认失效。清单的 `workspaceVersions` 是实际将删除的版本行数。删除只清库内配置，用户原目录、源码、未提交/未跟踪文件、AGENTS 和 Skills 保留。删群保留项目工作区。

跨库复制按父表到子表写入工作区版本，校验 head、全部版本内容、根身份、观察、mutation ID 与输入摘要；清库以反向外键顺序处理。原有 v13 成员事实版本的最后复制/最后清理顺序继续保留。v1–v14 迁移正文与 checksum 不变。

针对性检查入口为 `tests/workspace-preflight.test.ts`、`tests/workspace-service.test.ts`、`tests/workspace-mapping.test.ts` 和 `tests/workspace-api.test.ts`。SQLite、真实 PostgreSQL、浏览器与最终组合候选证据分别记录，单库通过不能代替其他门控。

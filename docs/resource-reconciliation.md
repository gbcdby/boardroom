# 资源更新与草稿对账

状态：已确认（实现合同；运行及交付证据另行记录）  
日期：2026-11-12  
范围：[S5 #129](https://github.com/gbcdby/boardroom/issues/129) §5–6、[S5-T5 #173](https://github.com/gbcdby/boardroom/issues/173)。当前接入 Task 列表、详情及项目任务设置。

## 两个通知通道

Agent 的 WorkEvent 继续使用自己的持久投递、重投和 ACK。浏览器的资源通知不读取或确认这条队列，也不把收到提示当成任务开始、完成或批准。

浏览器向现有 `/ws` 发送 `{type:"resource.subscribe", projectId}`，用 `projectId:null` 解除订阅。该订阅不声明人的在线 presence。服务端先核验项目读取权限，再返回 `resource.subscribed`；发送每个提示前重新解析当前主体、检查作用域。新订阅立即取代旧选择，异步权限结果不能恢复旧选择。没有订阅、跨项目、权限被撤销或未知实体都不会走无范围广播。

`resource.changed` 仅包含 `type/projectId/entity/id/revision`。当前实体为 `task`、`task-settings`；新增模块须同时扩展自己的读取权限检查，不能借用 Task 权限。正文、评论、理由、凭据和整个实体不会进入提示。`revision` 表示源对象版本，**不是事件游标**：评论、历史和评审记录可能改变详情而不推进 Task 的编辑 CAS，因此相同版本的提示仍要触发读取。

HTTP 与同进程 MCP 给同一 driver 的 `notifyResourceChange` 发送变化。通知队列存放在物理事务上下文，以不可变替换方式维护；保存点回滚会一同恢复队列。两个 driver 只在最外 COMMIT 成功、事务上下文与串行队列/连接占用释放后执行订阅者。外层回滚不发送提示，订阅者异常不会改变已经提交的业务结果。普通 GET 不产生变化提示。独立 stdio 进程没有共享这份内存订阅表，依赖页面定期对账。

## 读取与版本

Task 列表、详情及任务设置 GET 在完成当前授权与读取后，对实际 JSON 响应计算 SHA-256 ETag；`If-None-Match` 命中返回 304。完整详情的 ETag 包括评论、历史和评审记录，不能用 Task revision 替代。旧 ETag 不绕过新的权限检查。

`useResourceReconciliation` 为当前页面合并逻辑刷新，读取函数可通过 `reader.get` 同时读取所需资源，条件缓存按 URL 和当前作用域隔离。首次、项目/实体/上下文代际变化、WS 重连及恢复可见时读取当前视图；可见页每 15 秒兜底，隐藏页暂停周期请求。收到变化立即读取；在途的多个提示合并为一次后续读取。单次逻辑读取最多等待 10 秒，防止一个丢失响应永久占据刷新入口。

重连、恢复可见、切换作用域和本地提交会作废相关旧读取。即使取消没有阻止旧响应到达，旧代际仍不能写回缓存或页面。消费者提供 `accepts` 检查实体版本单调性；Task 还保留已见评论、历史和评审轮次。当前 Task 没有单项删除入口，其完整列表不能丢掉已确认提交的任务；项目删除由项目作用域处理。未来有删除语义的资源需按自身合同处理删除，不能直接套用此检查。

读取失败保留最后成功的值与读取时间；首次失败显示失败，不能显示为空项目。连接中断显示“离线 / 可能不是最新”。心跳、连接成功和失效提示都不是完整数据快照。未知事件或无法解释的提示触发当前视图的完整条件读取。

## 草稿边界

列表合并已有行的数据，保留已选布局、状态筛选、相对顺序及 keyed 控件；后台读取不重新展示初次加载状态，也不调用导航滚动恢复。创建输入及默认 reviewer 选择独立于远端快照。

详情的已保存事实和编辑 draft 分开。远端更新可更新标题、状态、评论及评审记录，编辑字段与 `baseRevision` 保持原值，并显示最新字段供比较。409 后读取仍不自动换基准；用户明确采用后，合并自己修改过的字段，再另行保存。结果未知时继续禁止盲目重试。

默认 reviewer、阻塞/重开理由和裁决理由也固定输入时的保存基准；裁决还绑定当前 Round ID/revision。远端变化后，原输入保留，须明确核对当前任务或候选后采用新基准。普通评论不修改编辑 CAS，其输入不会被资源读取清空。既有离开页面/切换项目的草稿确认继续生效。

## 消费者接入

1. 用明确 `projectId` 与包含实体标识、项目上下文代际的 `key` 调用 `setScope`。离开或更换目标时更新作用域，不复用旧请求的缓存。
2. 在 `read(scope, reader)` 中读取当前权威响应；`onValue` 只更新已保存事实，不能重置正在编辑的 draft。实体版本的规则由其模块提供 `accepts`。
3. 本地 mutation 先核对回执仍属于当前目标，再调用 `committed` 作废提交前读、可选合入真实回执、重新读取完整视图。不要把 WS payload 填进实体对象。
4. 用 `connection/error/lastSuccessAt` 展示连接及读取状态。卸载时释放订阅、计时器和读取；Vue 包装已注册 scope cleanup。

验证入口为 `resource-commit`、`resource-http-ws`、`resource-reconciliation`、`resource-stdio`、`task-resource-ui` 测试及现有 Task 回归。`scripts/e2e-resource-web.py` 运行临时服务并检查真实 Chromium 的 390/1440 页面；SFC renderer 与受控可见性边界只提供行为证据，不能替代原生布局、焦点、滚动和可见性验收。PostgreSQL、macOS 与三 job CI 仍按项目原门槛独立执行。


### 真实浏览器运行与证据

先执行 `npm run build`，再运行 `python scripts/e2e-resource-web.py`。Python Playwright 与 CI 容器固定为 1.62.0；脚本显式选择该版本的完整 Chromium，便于观察原生窗口最小化和恢复。`--chromium /path/to/chromium` 仅供已安装的本地浏览器使用，报告保留实际可执行文件与浏览器版本。

脚本使用专属临时目录、随机 localhost 端口和独立 stdio 子进程，不连接用户数据库。网络故障夹具只代理真实 HTTP/WS 字节，可丢弃资源提示、断开连接或暂缓真实 GET 响应；业务修改始终经实际 HTTP 或 MCP 服务。隐藏验收关闭 Playwright 的焦点模拟并最小化 Chromium 窗口，检查原生 `visibilityState` 与可信 `visibilitychange`；不覆写页面可见性、不冻结 JavaScript、不用虚拟时钟。若执行环境不能形成原生隐藏，报告保留 `INCONCLUSIVE` 且脚本非零退出。

390/1440 两个宽度分别检查非零滚动、焦点/筛选、真实 409、草稿/基准、MCP 更新、独立 stdio 与丢包后的真实周期读取、断线最后值/时间、隐藏暂停和恢复、迟到详情及旧项目响应。报告同时核对创建的 Agent WorkEvent 仍未 ACK。完整窗口/布局效果只由截图和实际浏览器检查支持，协议夹具自查不代替这些证据。

默认产物在 `.agent-output/resource-web-e2e/`：候选及工作树摘要、逐项 `report.json`、两个宽度的截图与 trace、原始 fixture stdout/stderr 和 HTTP/WS 事件。退出时关闭本次创建的连接、服务和 stdio，并确认临时目录回收。现有 `managed-web-browser` job 运行该入口并上传这一目录；任何必需场景失败或未证实都会使该步骤失败，不改变三 job 门槛。

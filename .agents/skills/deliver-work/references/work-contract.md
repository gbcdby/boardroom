# 工作契约 v1

## 权威记录

复用项目已有 issue、任务系统或文件。房间只提供通信时，消息引用外部记录，不另建一份互相漂移的任务真相。详细日志、模型、截图、diff 和 PR 保留为专业产物，记录只索引它们。

每项工作至少明确：
- work_id：稳定身份；一次执行另用 run_id，不因重试生成新工作。
- goal 与 delivery_target：可观察结果及本次终点。
- scope、acceptance：边界和稳定验收 ID。
- contract_id 与 authorization_ref：当前契约及既有授权出处。
- owner、write_scope、dependencies：当前责任和依赖；不把文本字段当分布式锁。
- subject：当前实际对象；id 使用不可变内容身份，按需保留 base_id、contract_id、environment_id、worktree_digest。
- evidence_refs、unresolved、next_action：证据、缺口与下一步。
- state：active、waiting_decision、blocked、delivered、cancelled。阶段结果和整体状态分开。

## 阶段结果 work-result/v1

schema_version 为 work-result/v1；字段见 assets/work-result.template.json。next_action 和 evidence.scope 是非空文本；复杂详情可放单独的扩展字段。外部工具原报告保持不变，由交接层封装并引用，不要求第三方工具实现此格式。

outcome：
- COMPLETE：当前职责已交出所需产物；调查完成、设计完成或简报完成不意味实现正确。
- PASS：声明范围内的检查通过；必须有对应对象的实际证据。
- FAIL：检查发现违反要求。
- INCONCLUSIVE：现有证据不足、资源耗尽或结果仍未知。
- BLOCKED：明确前置条件、权限或依赖缺失。
- NOT_RUN：尚未执行。

subject.kind 可以是 design、model、workspace、commit、integration_candidate、artifact、deployment、project_view 或 workflow。工作树对象包含暂存、未暂存和相关未跟踪文件；多仓或多产物系统记录组合身份。

evidence 每项含 id、locator、scope、status、producer、subject_id；按需加 kind、observed_at、environment_id、relation。直接支持当前结论的 relation=direct（默认），背景材料 relation=background，跨版本沿用需注明 transfer_basis 并实际评估适用性，不能自动视为 direct。

status 保留来源的原始状态；若来源状态不是 PASS 类，但已完成明确范围的检查，可另记 assessment=PASS/FAIL/INCONCLUSIVE/NOT_RUN。例如静态审查保留 status=OBSERVED、kind=source_inspection，并用 assessment=PASS 表达该次审查的结论；CLI 的 completed 与 exit_code 原样保留，再给范围明确的 assessment。assessment 不能把未运行、历史、失败或未知证据改写成当前通过。

subject.id 与 evidence.subject_id 都使用包含版本的不可变身份；额外的 version 不替代内容身份。跨版本复用保留旧证据的原 subject_id 并标 background，另建针对当前对象的适用性核验记录，引用旧证据 ID、transfer_basis 和检查范围。后者证明的只是该范围仍适用，不自动扩展原运行覆盖。

状态保留原始语义：PASS_WITHIN_SCOPE 只适用于模型范围；OBSERVED 是静态观察；HISTORICAL 是历史记录；NOT_RUN、TOOL_ERROR、INCONCLUSIVE 均不是运行通过。一个字段或校验器不能证明提供者没有伪造证据。

## 证据失效

候选内容、相关 base、契约、环境、验证工具或权限前提变化时，重新评估受影响证据；不要求毫无关联的文案变化重跑整个系统。记录复用理由与剩余覆盖。

合并前核对当前候选与实际集成基线。多个独立 PR 的通过不能自动推出组合通过。人工批准与质量证据分别处理，按项目规则判断批准能否转移。

## 决策与人的视图

决策卡保留：decision_id、需要决定什么、推荐项、替代项、证据、影响、可撤销性、期限和等待后果。只有范围、前提、权限后果仍兼容时复用旧决定。

区分 observed_at（看过或观察过）与 accepted_baseline（明确接受的架构基线）。简报可展示事实，不能推进接受基线或授予权限。

## 终点事实

- investigated/designed：相应调查或设计产物完成，缺口明确。
- verified：指定候选在约定范围得到所需验证。
- pr_ready：当前 PR 满足约定 ready 条件；不等于 merged。
- merged：平台确认实际目标分支包含结果，完成项目规定的主线检查。
- published：指定产物在约定渠道可获取。
- deployed：目标环境实际运行指定产物与配置。
- accepted：在实际交付位置通过约定验收。

工具返回值、命令 exit 0、截图绿灯都需要解释其真正对应的事实。

# 方法来源与采用边界

仅在追溯方法来源、评估上游差异或调整本 skill 时阅读本文件。
本 skill 用独立的中文写法组织设计与形式化验证流程。
pstack 是方法参考，不是运行依赖；本 skill 不执行或冒充原版 pstack skills。
不要求安装、调用或编排 pstack、Matt skills 或其他开发工作流。

## 本 skill 的职责

- 分析设计承诺、状态、动作、原子性和环境假设，并建立 TLA+ 模型。
- 执行模型检查、解释反例、验证模型对关键错误的敏感性。
- 阅读必要的实现代码，记录模型与实现的对应关系及尚未确认的条件。
- 交付设计、模型、运行证据及后续实现需要满足的约束。
- 不实现业务代码，不承担通用代码审查，不建立实际应用 E2E 编排。
- 由用户独立选择后续实现与审查工具；它们不是本 skill 的阶段或依赖。

## 固定参考版本

- 上游：[cursor/plugins 中的 pstack][pstack]。
- 作者：Lauren Tan；以官方 [plugin.json][manifest] 与 [LICENSE][license] 为据。
- 版本：`0.15.36`。
- Commit：`6b0300214a09fd6029cfb7077043125758cd1fd2`。
- 下列链接固定到该 commit；不能据此断言较新版本行为相同。

## 借鉴的方法

| 上游文件 | 借鉴重点 | 在本 skill 中的适配 |
| --- | --- | --- |
| [architect][architect] | 理解既有系统，比较结构方案，再确定边界 | 从实际使用方式、状态所有权及故障场景提取设计约束；按任务需要比较方案 |
| [create-formal-verification-skill][create-formal] | 从重要承诺选验证问题；检查模型对应关系及故障变体 | 把适合状态与交错分析的问题交给 TLA+/TLC；通过隔离的错误模型检验关键性质 |
| [maintain-formal-verification-skill][maintain-formal] | 区分模型过时、需求变化与实现缺陷；记录同步范围 | 维护性质、动作、实现位置及已核对版本的对应关系，明确待确认项 |

### 设计与模型敏感性

- 先找用户真正关心的承诺，不以“容易检查”为理由替换重要问题。
- 从现有系统提取候选不变量时，区分当前行为、期望行为及尚无证据的假设。
- 把模型动作的原子性与实际事务、锁、版本检查或其他机制对应起来。
- 在隔离目录中改变模型的关键保护条件，检查预期性质能否捕获错误。
- 将性质违例与语法错误、执行失败、超时分开；后者不能证明模型敏感。
- 保留正确模型的独立运行结果，不把故障变体的失败混入基线结论。
- 只有代码或规格级验证器才能回答的问题，记录为范围外并给出交接要求。

### 对应关系维护

- 记录已核对的文件、符号、性质及版本；无实现代码时标为待实现或未核对。
- 后续核对需考虑语义变化、移动或拆分的代码，以及新增的状态写入者。
- 区分“模型过时”“设计承诺确实变化”“疑似实现缺陷”和“证据不足”。
- 按证据更新模型，不能为得到通过结果而弱化性质或改写环境假设。
- 检查未完成时不提前推进已核对版本；模型通过不代表实现已经对应。

## 刻意未继承的行为

- 不继承 architect 的默认实现阶段，也不增加固定的逐阶段人工批准要求。
- 不绑定 how、why、arena、interrogate 或特定模型名称、Task 参数及并行代理策略。
- 不复制 Cursor 专用目录、自动化、外部搜索、通知、发布或合并流程。
- 不默认生成并安装额外的项目 skill；项目模型与对应资料即可承载本次工作。
- 不引入 statechart 的 TypeScript、mise、Pele 或其多轮规则移除诊断协议。
- 不把实际应用的 Launch、Doctor、Drive、Evidence、Cleanup 纳入本 skill 编排。

## 拆分后的交接风险

- 原子性与环境假设在实现时失效：交接必须写明每个关键动作需要的保证及性质；后续实现有差异时由用户带回核对。
- 实现变更后模型仍保持绿色：交接必须保留覆盖范围与已核对版本；未核对的新实现不能沿用旧的对应结论。

## 署名与许可

pstack 的固定版本使用 MIT 许可；复制上游代码或实质性文本时需保留其版权及许可声明。
本 skill 参考工作方法并独立表述；为保留来源信息，附上上游许可全文 [pstack-license.txt](pstack-license.txt)。
该文件对应 pstack 上游材料，不将本 skill 的其他内容声明为由 Lauren Tan 编写，也不替其另行指定许可。

[pstack]: https://github.com/cursor/plugins/tree/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack
[manifest]: https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/plugin.json
[license]: https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/LICENSE
[architect]: https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/architect/SKILL.md
[create-formal]: https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/create-formal-verification-skill/SKILL.md
[maintain-formal]: https://github.com/cursor/plugins/blob/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack/skills/maintain-formal-verification-skill/SKILL.md

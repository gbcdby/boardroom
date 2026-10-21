---
name: decision-map
description: 把超过一个上下文窗口的大型未知探索绘成共享决策地图：destination、决策票、blocking、frontier、模糊区与 out of scope，逐票收敛直到路线清晰。用于「这件事太大，先探路」「先别写 spec，先把未知理清」等场景；不用于直接实现。
disable-model-invocation: true
---

# 决策地图

## 调用方式

本技能由用户显式触发。interview 类决策票提示用户运行 `interview`；`research` 和 `prototype` 是模型可触发的，可在支持 Skill 工具的宿主中调用。路线清晰后提示用户进入 `to-spec` 或实现链路，不要自动继续。

## 目标

一个想法太大，一个会话装不下，通往目的地的路还看不清。决策地图先把这段路画出来，再逐张解决**决策票**，直到路线清晰、没有必须先决定的事。

默认只做规划，不做事：每张票解决一个问题，地图完成时可以直接交给 spec、ticket 拆分或实现。

## 适用与不适用

- 适用：跨多个会话、多个 agent 或多人协作的大型未知探索；需要先 research、prototype 或反复讨论才能定方向的工作。
- 不适用：普通需求澄清用 `interview`；范围已清楚时直接进入 `to-spec` 和 `to-tickets`；实现用 `implement` 或 `implement-spec`。

## 核心概念

- **Destination（目的地）**：这次探索要到达什么——一份 spec、一个已锁定的决策，或一次变更。目的地决定范围，第一步就是把它写清楚。
- **Map（地图）**：一个持久化的索引，记录目的地、已决事项、模糊区和 out of scope。地图不保存决策正文，只指向承载它的决策票。
- **Decision ticket（决策票）**：一个可以精确表述的问题，答案是一个决策或调查结果，不是一段实现。
- **Blocking / frontier**：决策票之间用 blocking 关系连接；所有 blockers 已关闭、且尚未被认领的开放票构成 frontier。
- **模糊区**：知道它迟早要决定、但现在还说不清的问题。它放在地图的「尚未明确」里，等 frontier 推进后再毕业成票。
- **Out of scope**：超出 destination 的工作。它不是模糊区，不会毕业；明确排除并记录。

## 存放与命名

- 地图和决策票放在项目的 issue tracker。
- 地图是一个 issue；决策票是它的子 issue。
- 在给人看的叙述、决策记录和地图索引里使用**标题**，不要只写编号或 slug；编号和链接跟在标题里。
- 地图是索引，不是仓库：一个决策只在一个地方保存正文，地图只写一行摘要和链接。

## 项目适配

本项目（Agent Studio）使用 GitHub Issues：决策地图直接创建为一个 issue，决策票创建为它的子 issue。地图和票的状态通过 issue 开闭和 assignee 认领表达。

### 标签约定（项目适配）

| 标签 | 用在哪 |
| --- | --- |
| `decision:map` | 决策地图 issue |
| `decision:research` | research 决策票 |
| `decision:prototype` | prototype 决策票 |
| `decision:interview` | interview 决策票 |
| `decision:task` | task 决策票 |

规则：

- 地图和决策票只挂 `decision:*`，不挂就绪标签。
- 类型标签已编码 AFK / HITL：`research` 是 AFK，`prototype` 和 `interview` 是 HITL，`task` 按正文。
- 解析类型读标签，不读正文；冲突时以标签为准并修正正文。
- 关闭决策票时移除 `decision:*`，超出 destination 的票在地图 Out of scope 留一行。
- 不使用 `phase:*` 标签。

### 标题前缀（项目适配）

| 前缀 | 对象 |
| --- | --- |
| `[决策地图]` | 决策地图 |
| `[决策]` | 决策票 |

### frontier 判定

地图下开放、无未关闭 blocker、未被 assignee 认领的子 issue，按地图顺序取第一张。开工第一步是 assign。

## 决策票类型

每张票标明一种类型，类型同时是标签（`decision:<type>`）：

| 类型 | 标签 | AFK/HITL | 技能 |
| --- | --- | --- | --- |
| research | `decision:research` | AFK | `research` |
| prototype | `decision:prototype` | HITL | `prototype` |
| interview | `decision:interview` | HITL | `interview`；agent 不得代替人回答 |
| task | `decision:task` | 按正文 | 手工动作，不产生决策但解除阻塞 |

决策票不是实现票。需要写生产代码、补测试、交付功能时，转到 `to-spec` / `to-tickets` / `implement`。

## 绘制地图（chart）

1. **命名 destination**：用一两句话写清这次探索要到达什么。目的地决定范围，先定它。
2. **广度访谈**：用 `interview` 做一次广度优先的扫描，铺开整个空间，找出当前可表述的决策和第一批可立即开始的票。如果扫完发现没有雾、整件事一个会话就能完成，就不需要地图；停下来问用户是否直接进入 spec 或实现。
3. **创建地图**：填写 Destination、Notes；Decisions so far 留空；把还说不清的模糊区写进「尚未明确」；把明确超出目的地的工作写进 Out of scope。地图打 `decision:map` 标签，标题前缀 `[决策地图]`。
4. **创建可表述的决策票**：只创建现在就能把问题说清楚的票，按类型打 `decision:<type>` 标签、标题前缀 `[决策]`；先创建票，再第二遍连 blocking（票需要先有标识才能互相引用）。说不清的留在模糊区，不要预先切成票。
5. **可选：并行调查**：对 AFK 的 research 票，可以在宿主支持时并行启动后台调查；结果写回票或链接，不直接改实现。
6. **停止**：绘图本身是一次会话的工作；只画图，不解决票。

## 推进地图（work）

1. **加载地图**：先读低分辨率的地图，不一次读完所有票的正文。
2. **选择票**：用户点名时用点名的票；否则取 frontier 中的第一张。开工前先**认领**（assign 或等价标记），让并发会话跳过它。
3. **按类型解决**：读票上的 `decision:<type>` 标签，调用对应技能；需要时再拉取相关票的完整正文。不要用正文猜类型，标签与正文冲突时以标签为准。
4. **记录结论**：把答案写成 resolution 评论或记录，关闭票，在地图的 Decisions so far 追加一行摘要和链接。
5. **更新地图**：把新暴露的可表述问题建成新票并连 blocking；把已经能说清的模糊区毕业成票；被证明超出 destination 的票关闭并移入 Out of scope。
6. 一次会话最多解决一张决策票；research 票可以并行。其他会话可能同时在推进 frontier，编辑前先确认最新状态。

## 地图模板

```markdown
## Destination

<到达终点时是什么样子；一两句话，每次会话先读它>

## Notes

<领域、需要参考的技能、本次探索的固定偏好>

## Decisions so far

- [<已关闭票标题>](<链接>): <一行结论摘要>

## 尚未明确

- <在范围内、但暂时无法精确表述的问题；随 frontier 推进逐步毕业>

## Out of scope

- <明确超出 destination 的工作及原因；不会毕业>
```

## 决策票模板

```markdown
## Question

<这张票要解决的决策或调查问题；一个问题一张票>

## Type

<research | prototype | interview | task>（与 `decision:<type>` 标签一致，便于人阅读）

## Blocked by

<阻塞它的票，或「无，可立即开始」>

## Resolved when

<什么证据或回答足以关闭这张票>
```

## 规则

- **先规划，再行动**：决策票回答「该怎么做」，不是「把它做出来」。到达地图边缘时转到实现流程。
- **一个决策只存一处**：正文在票里，地图只做索引，避免两处内容漂移。
- **票要精确，模糊区可以暂时说不清**：现在能把问题说清楚就建票，哪怕还被阻塞；说不清就留在模糊区。
- **认领即所有权**：开放且未认领的票才是 frontier；并发会话不要抢已认领的票。
- **按标题交流**：给人看的文字用票的标题，编号只作为链接的一部分。
- **证据优先**：research 和 prototype 的结论必须带来源或可复现记录；未验证的推测明确标注。

## 完成判据

- 没有开放的决策票，也没有仍会影响路线的模糊区。
- 每个决策都有可追溯的记录和来源。
- 目的地已经清晰：可以直接进入 `to-spec`、`to-tickets` 或实现，且没有必须再决定的事项。
- Out of scope 已记录，不会在后续被误当作待办。

## 反模式

- 直接冲向 destination，跳过探路。
- 把决策票写成实现票，或在地图里直接写生产代码。
- 预先切分模糊区，制造一堆还说不清的票。
- 把决策只留在聊天里，地图和票没有记录。
- 一次会话解决多张票，导致上下文和证据混乱。
- 并发会话不认领就开工，重复劳动。
- 用编号代替标题交流，读者无法快速理解。
- 把超出 destination 的工作塞进模糊区或待办。

## 与其他技能的关系

- `interview`：解决 interview 类决策票；也可在绘图阶段做广度扫描。普通需求访谈不需要地图。
- `research`：解决 research 类决策票，产出带来源的事实。
- `prototype`：解决 prototype 类决策票，用一次性原型提高讨论精度。
- `to-spec`：目的地是正式 spec 时，路线清晰后进入。
- `to-tickets` / `implement` / `implement-spec`：目的地是实现时，按正常交付链路继续。

# 方法来源与适配

本技能独立编写，吸收以下方法，不依赖安装上游技能。

- Matt Pocock 的 `grill-me` / `grilling`：人工入口与可复用方法分开；先自行查证事实，按问题依赖组织讨论并提供推荐。这里按用户指定的深度收束，不要求穷尽设计树或把常规决定全部交给人。
  - https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grill-me/SKILL.md
  - https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grilling/SKILL.md
- poteto 的 pstack `in-your-own-words` / `sharpen`：重述目标以发现误解，补足专业方法、原始材料与外部验证依据，保留属于用户的选择。这里将这些方法用于约定范围内的共同推敲，不自动扩大任务或进入实现。
  - https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/skills/in-your-own-words/SKILL.md
  - https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/skills/sharpen/SKILL.md

调用控制由目标宿主支持的元数据与真实权限机制共同决定。禁用隐式调用不等于已验证的人类身份或额外工具授权；移植时核对实际加载方式，不借上游组合示例绕过调用拒绝。

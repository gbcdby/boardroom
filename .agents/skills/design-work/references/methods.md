# 方法来源与适配边界

本文的工作边界、输出协议和视图要求为本体系自行设计。

- Matt Pocock，[How To Make Codebases AI Agents Love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love)：借鉴简单接口、模块边界和便于理解的系统组合。
- poteto，[The Complete Guide to pstack Pt. 2](https://x.com/poteto/status/2097732320606507506)：借鉴用研究与原型改进设计，再形成战术执行计划。
- poteto，[状态图与形式化验证示例](https://x.com/poteto/status/2112736749281759566)：借鉴把行为与反例表达为人能理解的场景；该帖第一张通知示例由作者标明是假想示例。
- [pstack statechart 官方说明](https://github.com/cursor/plugins/blob/main/pstack/skills/statechart/SKILL.md)：借鉴模型结果到可读视图的投影，具体可用能力须核对所用版本。

本 Skill 不原样调用 pstack architect，也不继承其继续实现的默认行为。引用不构成安装、调用或扩大权限的授权；原版入口和组件各自的调用限制继续有效。

# 方法来源与适配边界

本 Skill 的只读限制、基线对比和返回协议为本体系设计。

- Matt Pocock，[How To Make Codebases AI Agents Love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love)：借鉴让人理解接口与系统组合的思路。
- Addy Osmani 等，[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/)：借鉴按需要解释具体子系统、用证据支持理解，以及衡量人的注意力成本。
- Matt 的 [wait-what](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/wait-what/SKILL.md)：吸收交流没讲清时补上下文、简洁重述的意图，不要求安装或自动调用该人工入口。
- pstack 的 [技能说明](https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/README.md)：借鉴 how/why/teach 的分层理解与 ketchup 的回看视角，继续遵守本技能只读范围。

这里不自动接受设计、生成新的模型检查结果或调度实现。引用上游方法不构成自动调用上游 Skill 的授权；原始资料的日期和版本不能移植成当前项目的实测结果。

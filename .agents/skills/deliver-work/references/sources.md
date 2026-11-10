# 方法来源与适配

本 Skill 为自有通用编排方法，不是对上游命令的原样代理。使用具体上游 Skill 时另核对当前版本与调用限制。

- Matt Pocock：可验证切片、TDD、标准/规格双轴方法。参考 https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d ，不继承其特定tracker、必须用户调用入口或单PR组织方式。
- pstack：实证设计、真实操作面验证、恢复与证据。参考 https://github.com/cursor/plugins/tree/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack 。不强制固定模型、固定并行通道或其宿主限定。
- poteto，设计与原型：https://x.com/poteto/status/2097732320606507506 ；可靠循环：https://x.com/poteto/status/2069824386283319343 。
- Addy Osmani 等，审查和人的总负担：https://claude.dev/blog/solving-code-review-at-anthropic/ 。采用质量与人工负担共同度量，不照搬企业审批人数和固定轮次。
- 既有 tla-verify-design 独立承担设计/模型检查，不承担业务实现或编排。

语义正确的图与真实证据有助于理解，但图形渲染、多个模型赞同或历史通过记录都不能替代本次需要的检查。

# 候选、证据与授权

## 候选身份

记录工作ID、仓库、PR、head、base、merge-base、相关契约版本和所需环境。工作树审查另记录内容快照/摘要及未跟踪文件；release产物不能只用代码HEAD替代。

把三个问题分别回答：
1. 变更是什么：当前候选的实际内容。
2. 为什么能接受：针对这个对象的审查与验证。
3. 是否允许操作：已有请求、规则和必要批准。

## 集成复验

单个分支通过、两个PR分别通过、无文本冲突，都不能证明组合通过。对公共API/数据/迁移变化，核对分叉后新增消费者与目标分支变化；使用平台提供的集成候选或可复现的本地等价候选，记录差异。

如果证据可沿用，写明不受本次变更影响的范围与理由。不能用“改动小”概括所有变化。必要门槛仍以平台事实为准。

## 审批

按当前项目规则判断新提交是否使审批失效。机器审查不能充当明确要求的人工批准。风险分类器提供建议，不自行降低规则或授予写权限。

## 失败和超时

队列失败或CI未完成不能标merged。合并已发生后的检查失败不能标“没有改动”。超时或响应丢失时查询实际副作用；不把相同HTTP请求重试当恰好一次保证。

## 方法来源

- Matt双轴审查与PR方法：https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
- pstack PR/Babysit/Shipping思想：https://github.com/cursor/plugins/tree/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack
- Addy等人的审查体系：https://claude.dev/blog/solving-code-review-at-anthropic/

这是自有适配。pstack的Babysit可止于merge-ready，Shipping不等同于生产部署；不能因方法同名推断实际终点。

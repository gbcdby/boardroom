# boardroom 交付适配

基线：gbcdby/boardroom@eea2f06c72eb76e300cdd4d2270facb30c6cff49；执行时重新读取当前AGENTS和docs/README。

- 详细spec/ticket以GitHub Issues为准，不在docs复制一份。
- 仓库本地pr Skill已经包含PR创建，区别于曾研究的上游纯模板；原版限制自动合并、force-push和关票。
- PR不使用Closes #N。架构文档PR须评审，默认分支合并由人决定；其他操作也核对实际任务授权。
- 当前房间MCP没有PR、merge或Task工具。用真实GitHub连接或项目已有CLI，不能通过房间消息宣布已合并。
- 候选验证命令按package.json选用；真实harness、SDK、SQLite与PostgreSQL证据分开。
- 历史PR #75在分支通过后，组合进main仍因同步到异步API消费者不兼容失败，#76修复。历史事实用于选验证范围，不能作为当前候选通过证据。

来源：
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/README.md
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/.agents/skills/pr/SKILL.md
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md

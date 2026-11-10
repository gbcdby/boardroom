# boardroom 交付适配

源码能力核验基线：gbcdby/boardroom@eea2f06c72eb76e300cdd4d2270facb30c6cff49；技能迁移见PR #78。执行时重新读取当前AGENTS、docs/README与work-suite.json，历史规则不自动充当当前门禁。

- 详细spec/ticket以GitHub Issues为准，不在docs复制一份。
- 旧pr入口随旧13项技能退役，PR与合并由land-work承接。创建/更新、合并、关票和部署分别核对已有授权，不能因调用技能取得额外权限。
- PR不使用Closes #N。架构文档PR须独立评审；默认分支合并由人决定，用户当前请求或既有授权已覆盖时完成门禁后直接执行并回读，不重复申请。
- 不自动force-push，不顺带关闭issue、删除分支或部署；ticket由deliver-work生命周期负责人在验收与必要审查完成、关票授权有效时协调更新。
- 当前房间MCP没有PR、merge或Task工具。用真实GitHub连接或项目已有CLI，不能通过房间消息宣布已合并。
- 候选验证命令按package.json选用；真实harness、SDK、SQLite与PostgreSQL证据分开。
- 历史PR #75在分支通过后，组合进main仍因同步到异步API消费者不兼容失败，#76修复。历史事实用于选验证范围，不能作为当前候选通过证据。

来源：
https://github.com/gbcdby/boardroom/pull/78 （技能迁移；当前状态须回读）
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/docs/README.md
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/.agents/skills/pr/SKILL.md （退役前历史来源，不作为调用依赖）
https://github.com/gbcdby/boardroom/blob/eea2f06c72eb76e300cdd4d2270facb30c6cff49/CONTEXT.md

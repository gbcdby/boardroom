# 宿主与调用配置

按当前宿主及其实际版本检查发现路径、调用方式和元数据支持。下面是 2026-11-10 核对的官方文档约定，不是本套件已在所有宿主实测的结论。

## 调用方式

| 宿主 | 人显式选择技能 | 禁止自动选用的配置 |
| --- | --- | --- |
| ChatGPT | 在支持技能选择的界面使用 `@` | 按当前产品的技能元数据与实际加载结果核对 |
| Codex CLI / IDE | `/skills` 或 `$skill-name` | `agents/openai.yaml` 中 `policy.allow_implicit_invocation: false` |
| Claude Code | `/skill-name`；插件入口可能有命名空间 | `SKILL.md` frontmatter 中 `disable-model-invocation: true` |
| Cursor | 在技能菜单选择 `/skill-name` | `SKILL.md` frontmatter 中 `disable-model-invocation: true` |

支持程度受宿主、版本和安装方式影响。找不到入口时检查实际安装位置、名字冲突和当前目录；不要只根据配置文件存在就判定宿主已发现它。

## 本套件的分发方式

个人技能的规范源保留 `name`、`description` frontmatter；四个人工入口在 `agents/openai.yaml` 中声明 `allow_implicit_invocation: false`。

仓库导出为 `challenge-work`、`steer-work`、`setup-work`、`ask-work` 的 `SKILL.md` 增加 `disable-model-invocation: true`，正文保持一致。导出清单记录来源摘要、导出摘要和这项变换；其余入口继续允许按需选用。读取实际清单核对，不手工维护另一份版本表。

导出到其他环境时使用该环境认可的安装或生成方式。不要修改只读的上游技能，不通过直接读文件执行来绕过宿主拒绝。

## 核验范围

至少分开检查：发现、人的显式调用、模型自动选用的限制，以及所需工具是否实际可用。安装成功、语法通过或文档有说明都不能替代这些检查。

没有真实宿主时，记录“配置已核对，调用行为待实测”。尤其不能把消息已投递或 ACK 当作宿主已停止、取消已完成或操作已获批准。

技能入口限制只控制加载和调用方式；人类身份、工具权限、远端副作用及进程控制仍由真实运行时承担。普通自然语言控制指令继续有效，不要求用户记住技能名才有暂停或改向权。

## 官方来源

- OpenAI：[Build skills](https://learn.chatgpt.com/docs/build-skills)，显式调用与 `allow_implicit_invocation`。
- Anthropic：[Extend Claude with skills](https://code.claude.com/docs/en/skills)，调用控制与 frontmatter。
- Cursor：[Agent Skills](https://cursor.com/docs/skills)，发现目录与关闭自动调用。

执行时复核与当前宿主有关的文档和工具，不把这里的日期当作永久能力保证。

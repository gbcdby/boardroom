# #152 应用源状态保全：单次有界资格证据

合同是 [Fs source-preservation r2 正式接受记录](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6881600918)，固定正文 SHA256 `e1a875ac0084ef6eb62bad117255498b214ff7ff41bb68a37d92c422a6289a2e`。
本目录是新 profile `linux-native-ext4-fid-fsuuid-source-state-v1` 的隔离资格候选，不启用生产 registry，不实现 Fs scanner/Node-API/service/R05，不释放 S4 三项产物。

## 可执行范围

本地只运行编译、ABI 与离线结构/窗口控制：

```sh
python3 scripts/qualification/fs-source-preservation/run.py --mode local-check --out /absolute/new/output
```

本地入口没有 sudo、mount、UID 切换或实际目标 source getter。历史真实原件只用于新诊断结构分析，窗口测试使用明确的合成健康记录，均不能作为新 profile 的运行资格。

独立源码双轴后，只有新专属分支 `qualification/152-fs-source-preservation-r1` 的 push 可触发专属 workflow。没有 workflow_dispatch/main/PR 触发，不改变 database-ci 或任何 required check。实际 runner 必须精确等于 profile 的 kernel release/version/arch；标签、旧 run 或工具缺失不替代实际检查，不安装工具或重复执行求匹配。

```sh
python3 scripts/qualification/fs-source-preservation/run.py --mode hosted-linux --out "$GITHUB_WORKSPACE/.agent-output/fs-source-preservation-evidence"
```

最多两个 64 MiB 自有 image、总普通 payload ≤1 MiB。普通 probe ≤3秒、阶段≤60秒、fixture≤300秒且预留30秒清理、job≤10分钟、artifact≤64MiB。root 只在 marker+真实 backing inode绑定的自有 `/tmp/brsp-*` 目录和私有 mount namespace 准备、观察、flush、回收这两个 image。provider 是非零 UID/GID、无附属组、五类 capabilities 全0、NNP1；不从 root 回执获得生产权限。

三轮正向原件和完整块/JBD2闭包必须先严格重算通过，才另行在自有B镜像执行一次真实错误负控。B重新挂载后，先由普通provider完成健康context；root持有该source的O_PATH及同一健康目录，核真实loop backing、native UUID/inode2、sysfs对象和立即重读的有效`errors=remount-ro`及`nowarn_on_error`（拒绝`warn_on_error`），并验证root-only `trigger_fs_error`属性，才写入固定故障标记。任何关联/策略不符在写之前拒绝。此动作会故意改变B的错误状态和journal，是单列的root故障控制；绝不作用宿主挂载，不成为普通provider的诊断允许集合。随后普通provider必须观察精确一次`trigger_test_error`并在content open前拒绝；最后独立收集错误SB/journal/卸载和清理原件，不复位错误或重新标健康。

## 输出及解释

| 原件 | 可证明范围 | 不能推出 |
| --- | --- | --- |
| `provider-*.stdout`、真实 command receipt、`windows/*-reap.json` | 同一 FD 的 UUID/FID/bytes/配置、13项同源健康字段，源FD关闭和进程实际reap后的有界窗口 | 诊断事务最终提交、未来所有错误已可见 |
| 缺 getter 负例 | 固定不存在的 sysfs 属性产生真实 ENOENT，普通内容 open 未进入 | 自然硬件错误或完整迟发错误恢复已经测试 |
| 独立自有B的可见kernel错误负例 | 已核绑定与remount-ro策略后，真实root错误注入和普通getter拒绝；源FD/native收尾及错误字段原件可核 | 自然硬件故障、潜伏错误全部已见、后续生产恢复已实现，或把故障写归入普通读取白名单 |
| A/B defaults、mount/alias、kernel notes/package/module 原件 | 当前 getter、有效 override 和设备关系的真实观察 | 完整 vendor源码映射、普通 backing 对象或 writer 覆盖已接受 |
| SB、完整 JBD2、物理 journal block mapping | 精确单 SB sample 的 descriptor/tag/payload/commit 与 CRC32C、具体事务序列 | 整个 journal 可任意改写 |
| 16384个设备块摘要及变化块原字节 | 本次自有 device 全域观察的差异归属，额外块立即拒绝；原始hash读取窗口明确非原子 | 整个生产设备零写或运行时审计过 raw block |
| mount/unmount 时点及实际 write sectors | 规定的 needs_recovery清除、写时/写量精确公式和独立 harness记账 | 把卸载行为归给 provider，或用“后台活动”豁免未知变化 |
| cleanup/handoff/detach回执 | 挂载/loop/children真收束及自有文件归属交接 | 未知资源已自动清理 |

`integrity=PASS` 只表示完整原件可由同一严格消费者重算，M05 PASS 只覆盖故障注入之前固定 fixture 的应用域与诊断/卸载归属；故障写入的错误域不使用M05诊断分类。`qualification=INCONCLUSIVE`、`production_runtime=UNSUPPORTED`、空 registry/qualified builds 始终明确。M01/M02/M04 的完整条目、生产迟发异常的下一 live/恢复拒绝、R05完整产品闭包仍分别待证；exit0不能被当作这些门通过。可见kernel错误负控只有实际新job原件经严格消费后才标观察成功，本地合成控制不替代它。

## 实现与边界

`diagnostics.py` 只接受4KiB ext4、完整4MiB internal JBD2/csum-v3/64bit、一个不跨环的SB事务；未知features、额外payload/revoke/事务、任何应用/错误域变化均拒绝。完整 source bytes/FID 及原 namespace/权限不变；物理 sample 明确是写入。

`window.py` 独立消费原始字段与close/reap顺序，不信 native 的 healthy/complete布尔值单独证明事实。健康字节必须与固定 fresh fixture 的明确零错误前提一致；不将既有错误重设基线。Tcut来自实际reap后观察，而非 sysfs快照的提交屏障。后续生产 live/Jq/ready/recovery组合尚未实现，不能从本模块获得授权。

`support.py`/`observer.py` 按 `reuse.json` 从 R04 固定原件逐字复用；`native.py` 只提取未修改的 ABI/同FD/原配置检查函数。旧 R04 脚本、原始 ZIP、FAIL/unsupported结论没有修改。本目录的新 `run.py` 沿用原有有界资源管理顺序，增加新政策的窗口/块原件，未复制旧 COLD verdict。

历史 test fixtures 明确为 run43472449599/attempt1/job132047558944/artifact14060533424 的所列原件，来源及压缩前后 SHA 在 `tests/fixtures/fs-source-preservation/provenance.json`。旧 M05仍是 FAIL / PROVIDER_PERSISTENT_SB_SAMPLE；新分析只说明该已发生事务能被新政策精确解释，不能给新运行注册资格。

固定机制源码为 Linux commit `028ef9c96e96197026887c0f092424679298aae8`：

- `fs/ext4/file.c` 的 `ext4_sample_last_mounted`；`fs/ext4/sysfs.c` 的只读错误字段；`fs/ext4/super.c` 的 `ext4_update_super`。
- `fs/jbd2/journal.c` 的 super checksum、clean log恢复、`jbd2_journal_destroy`/mark-empty；`recovery.c` 的 descriptor/commit/tag checksums；`commit.c` 与 `include/linux/jbd2.h` 的精确布局。

这些 primary source 是机制依据。vendor build 对应没有独立接受前，不能用上游版本替代目标构建资格。

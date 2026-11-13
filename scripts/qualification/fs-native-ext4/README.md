# #152 native-ext4 有限资格入口

权威合同：[S4-T2-Fs-native-ext4-r3-20261113-01](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6852650119)。本目录只实现 EX4-Q01–Q12 的一次有界资格，不是生产 Node-API、Fs parser/service 或支持条目注册。产品不引用本目录。

`accepted_provider_profiles=[]`、`qualified_kernel_builds=[]`、B1 OPEN、历史产品 delete/recreate FAIL_UNRESOLVED、旧 overlay FAIL/BLOCKED、三个 S4 产物未释放及 #153 BLOCKED 保持。任何 summary PASS 都只指本次有限原生检查；R04 独立核验及 R05 产品闭包仍未完成。

## 入口和预算

本地只运行无提权编译与资格消费者控制：

```sh
python3 scripts/qualification/fs-native-ext4/run.py --mode local-check --out /absolute/new/evidence-directory
```

它不会执行 sudo、mount、loop 或资格 provider；所有真实 Q 行明确 NOT_RUN_ENVIRONMENT。证据输出目录必须是新的规范路径。

经后续独立审查和发布授权后，专属 `qualification/152-native-ext4-r3` 分支的 push 可触发新增 workflow。入口再核固定仓库/分支/event、实际 SHA/tree、clean checkout、原非零 runner UID/GID、实际 kernel/image 和工具。当前交付不触发这个入口，也不修改原 database-ci 的三个 job 或旧 overlay 资格分支。

资格 harness 在自己带 marker 的全新目录、独立私有 mount namespace 内创建 64 MiB sparse image；记录 mkfs 完整参数、UUID、feature/superblock 输出和实际 mountinfo。关闭 lazy inode/journal 初始化。固定请求 rw、data=ordered、relatime、errors=remount-ro。只用一次完整普通 umount→loop detach→同一未改 image reattach→mount；结束时再普通卸载、分离和删除自有 fixture。

非零原 runner 身份的 provider/mutator 子进程清空五类 capabilities 和 supplementary groups、设置 NoNewPrivs。provider 是只读 C probe；测试准备和普通变更由独立标记的 harness/mutator 执行。没有生产提权依赖、open_by_handle_at、xattr token、hardlink pin 或 daemon。

预算：每组≤16对象、两组payload累计≤1 MiB、compile≤10s、child≤3s、stage≤60s、fixture≤300s（预留30s收尾）、job≤10分钟、真实 inode 复用追加总计≤32次且≤2s。未在预算内观察到 file 和 directory 复用时保留 BLOCKED，Q07依赖这两类真实 native receipt，不生成随机 handle 来补证据。

## 证据与边界

- probe 的同 FD 前后观测包括 fstat、独立 legacy/unique statx 请求、fstatfs、UUID16 和 type1/FID8；unique 输出槽为 uint64_t，保存完整 opaque bytes；在两次观测之间从同一仍持有 FD 读取原字节。每次 handle 观测只有一次128-byte上限调用，无 EOVERFLOW 扩容重试。
- openat2 使用 BENEATH、NO_SYMLINKS、NO_MAGICLINKS、NO_XDEV；保留 owner、单链接普通文件、目录、O_NOATIME、当次 root/路径复验与明确 FD close 回执。路径替换负例以真实 SIGSTOP 窗口协调独立 mutator；FD close/reuse 必须有唯一 test-only 施加回执、同 PID/object、合法相同数字 old/new FD、实际前后换对象及预期 path 守卫拒绝，未注入或注入失败不能通过。
- Q03 在 Q01 首次 provider open 前，观察实际 FS root 本身和所有测试组路径的完整可读 xattr、精确 stat/时间、content hash 和 inode flags；独立 cold control/provider 及 observer-only 复读各保留差异，control 变化不抵销 provider 变化，FS root 没有非 atime 修改豁免。
- Q07 为**资格消费者模型**的 synthetic 相等 stat/time 输入，两个 FID 必须来自 Q06 的真实重用收据。它不声称真实时钟全部相等，也不代替 R05 生产 Fs→新进程 service 闭包。
- Q08 由新 consumer 进程从磁盘严格解码 fsync 后的完整冻结对象集、metadata/witness/native 及关联 raw batch，再重开 native 子进程，以实际磁盘记录比较当前观测和当次 mount。父进程只核摘要与比较回执，不传内存 expected；缺记录、改变 observations 后重算 sidecar 或重复 JSON 字段均拒绝。Q09 复用该消费路径，只称一次真实 FS 生命周期，OS reboot NOT_RUN。
- Q11 errno/字段故障注入有明确 synthetic 来源；错误 mount ID 从真实值派生有效且必定不同的非零 uint64 值并保存原值/注入值。真实路径、跨 mount、owner、取消与进程超时另存原始回执。实际原生能力/身份不足按 raw errno/identity 记 BLOCKED，原件不足记 INCONCLUSIVE，已证明的 metadata/FID 矛盾记 FAIL。
- profile JSON 验证通过后按源码原字节留存；没有重序列化、重排字段或放松源码摘要绑定。local、fixture、hosted 三个落证入口使用同一生成函数。
- fixture 封存与 hosted 导入共用严格消费者：固定 schema/profile/candidate/binary、精确且唯一的 Q01–Q12、PASS 的 payload/必需原件、全部实际文件的 SHA256SUMS、场景/子进程退出边界及 raw stdout 关联一起核对。PASS 原件按该场景的对象集及 mode 重走既有 native、cold、recreation/reuse、冻结记录、子进程消费、生命周期和负例判据；只有标签、非空占位 JSON 或同步重算的摘要不能通过。合法 BLOCKED/INCONCLUSIVE 行保留其类型，不要求伪补成功原件。缺行、未知行、缺件、错摘要、超时、cleanup 不确定或流程 exit0 均不能构成资格 PASS。
- mountinfo 只能说明当次类型/配置。资格 fixture 的显式 mount 命令与 mkfs features 保留为实验事实；**没有生产 runtime matcher**，不能据省略默认项或 fixture feature 集推定生产源。任何实际支持条目仍须 R04 提供无新增生产权限的当前 FD 匹配证明。
- ext4 generation 的随机32位残余风险沿共享设计保留；本目录不增加无限碰撞证明，也不豁免普通 unlink/create、同 inode 或相等时间比较负例。

`summary.json`、`cleanup.json`、environment/candidate/binary/profile、各 syscall/errno 原件、前后 source diff、持久观测、mount/loop/image hash、命令退出/reap 和 SHA256SUMS 一起交给独立 reviewer。完整 UUID/FID/路径仅在私有 artifact；控制台只输出状态。所有资格前的生产输出仍为空。

## 复用来源

`support.py` 的 Evidence、alarm、身份检查、规范路径、有限读取和同设备清理来自旧 overlay 固定提交 `4f451623e1dbaf680b33dc8a99fff72e009637a4` 的 `scripts/qualification/fs-identity/run.py`。C 的 Linux v6.18 UAPI assertions、只读 syscall、身份记录和 opaque 输出采用其 `probe.c` 的公共部分。新 profile、same-FD字节、路径控制及 ext4 生命周期独立实现；没有继承旧实验 verdict。官方 UAPI 来源与旧内容摘要见 profile.json。

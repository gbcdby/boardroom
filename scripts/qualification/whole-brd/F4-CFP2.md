# CFP2 clean regular 有限 native 目标

工程依据为 [#152 技术接受 7030904017](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7030904017)。新 profile 为 `whole-brd-f4-cfp2-clean-regular-v1`。公共源码保持 `PRIVATE_CATALOG_SHA256=None`，不能从参数、环境或 catalog 覆盖。

该目标组合准确 `native/maintenance-source-files.c` 的 `source_work_execute`、`worker_close_slot` 和 metadata/mount helpers，与新的有限 C driver。静态链接用 section GC 去除未调用 N-API，既不提供 N-API 替身，也不把这个调用图当成生产 TypeScript/Node invocation。

## 资源与观察顺序

原 DM guest 的 bootstrap、P1、metadata、无内容 control、四张 64 MiB 完整块快照、device calibration、topology/census、清理及最窄 effect classifier 保持原义。新 profile 只为第二轮 selected child 调用新目标；原 F3/DM 仍调用旧 ordinary。

新 ordinary 在首次 source lookup 前设置 D0。它不先调用会打开 `/mnt/brd` 的旧 `dm_load_source`，而由唯一 Dp 首次打开实际源，核固定私有 root 元数据，由实际 device 解析 sysfs 并核本次 run 的 DM name/uuid、正反拓扑。严格消费者还把该 device、boot、namespace 与原外层 DM ioctl、metadata、完整块和同次 child receipt 绑定。

| 顺序 | 实际资源与动作 |
| --- | --- |
| 初始 | 独立 Dp 与提前 O_PATH M；完整 fresh environment；同 FS UUID/FID、flags、xattr、成员 |
| 读窗口 | 从 Dp 独立 open R 与 V；R 唯一 fsync、固定 payload 一次读取及 EOF；R/V 存活时重开 F、核完整身份并实际 close F |
| regular 收尾 | R 完整后验后 close；原 V 唯一 fsync、完整后验和 fresh environment 后 close；此后不再 open/dup regular 源 |
| parent/tail | Dp 成员后验和唯一 fsync；原 FD 唯一移动为 A，旧 owner 失效；M/A fresh environment、A 实际 GET_TUNE，全部辅助 FD 结束 |
| 结束 | 原 worker 先 close A、再 close M，A 错误仍尝试 M；未知 close 不重试；所有计数/比较完成、实际 join 后才构成 Tcut |

`BRDCF4` 帧只由独立新消费者读取；它不会被转换为旧 ordinary JSON。消费者检查连续 seq、同 run/PID、原始字节、role/FD/order、真实 rc/errno、独立计数、metadata 全时戳、源/挂载、三阶段双向 fresh environment、aux EOF/close 和原 D0。普通文件控制的 `owned-file-control` scope 无法进入 guest 成功路径。

## 预算与结果

沿用 512 MiB / 1 vCPU、三个 compiler invocation 合计 10 秒、prepare 60 秒、ordinary child 3 秒、产品 D0 120 秒、mkfs 30 秒、stage 60 秒、fixture 300 秒、business 290 秒、outer 600 秒、TERM 2 秒 / reap 3 秒。serial 8 MiB、管理加 native 帧 7 MiB、单帧 64 KiB；artifact 64 MiB、compressed 16 MiB / expanded 32 MiB；恰四张完整 64 MiB 快照。

新状态仅 `CFP2_CLEAN_REGULAR_NATIVE_MECHANISM_OBSERVED`，且始终 `qualification=UNSUPPORTED`、`production_bound=false`、`commit_barrier=false`、空 provider/kernel registry。raw trace 完成不等于 guest 成功：原自然 exit 0、实际 reap、三 pipe EOF、收尾和最后 artifact seal 仍是必须条件。未知 block 变化继续由原 classifier 拒绝。

## 纯检查与后续门

`python3 -B tests/whole-brd-f4-cfp2.test.py -v` 只实际编译/检查 ELF、消费明确合成的 raw trace 与完整块 fixture，并在自有普通临时文件执行资源正反控制；它不启动 guest、不访问块设备、不调用 DM/mkfs/mount/module，不构造或消费 execution claim。合成 kernel notes 替换只限测试自身，不能成为固定内核原件。

G-C2 私有输入闭包、G-C3 精确 source/input/BUNDLE 双轴接受及总控释放之后，才能安排新的一次 guest 执行。公共工程检查不替代该证据。clean-existing 是当前唯一输入：完整 Node/DB/plan、WR1 联合接合、dirty/cancel/crash/目录/absent、完整 M04/CFP2、R05/B1 与生产资格保留原门。

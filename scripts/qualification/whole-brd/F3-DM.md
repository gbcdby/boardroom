# Whole-brd F3：独立 DM-linear 观察 profile

`whole-brd-f3-dm-linear-v1` 是 #152 的独立工程 profile。它在新建的整个 64 MiB ram0 上建立一个 DM linear 设备，使用同一 DM 设备进行格式化、四次完整块观察和两轮普通只读探针。成功状态仅为 `F3_DM_SOURCE_PRESERVATION_OBSERVED`；`qualification=UNSUPPORTED`、`production_bound=false`、`commit_barrier=false`，provider / kernel registry 仍为空。源码及纯控制通过不表示已实际运行、已取得 Fs 资格或完成 #152。

权威范围：[DM 八路径接续](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6899760900)、[SP-r2](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6881600918)。原 whole-ram0 attempt 保留 `FAILED_NO_RETRY / UNSUPPORTED`；它的全零计数不能转作无写入证明。旧 `f3.py` 和 13 个既有 helper / 配置不变，原设备 fence、分类器和预算仍有效。

## 显式入口与准确来源

新 profile 只在 `f3-build.py` 的既有 `FIXED_F3_INPUT_CLOSURE_NOT_BOOTED` 输入分支使用。请求必须恰好包含 `run_id`、`input_kind`、`input_root`、`profile`，最后一项必须等于上述固定字符串。请求不能提供任意设备、表、解码器、预算、控制程序、成功标记或旧 boot / FD / claim。省略 profile 时使用既有 F3 分支；旧五字段输入不能套用 DM profile。

完整来源绑定在原 `SOURCE_NAMES` 上增加 `f3-dm.py`、`f3-dm-guest.c`、`f3-dm-uapi.h`、本说明及 `tests/whole-brd-f3-dm.test.py`。payload 仍由原精确 member / ELF / 字节合同构成；仅替换其完整摘要所绑定的 guest helper。新构建仍为同三个编译步骤：host gate、原 SP probe 对象、选中的 guest 静态链接；共享 10 秒编译预算及 60 秒准备预算。mke2fs 的全部选项、UUID、hash_seed、环境和 30 秒 owner 预算保持，只将源设备路径替换为本次 DM 节点。

公开源码的 `PRIVATE_CATALOG_SHA256` 仍为 `None`。新输入分支在输出目录、编译、claim 或子进程创建之前拒绝；请求和环境不能提供另一 pin。真实私有输入、独立源码变体、完整新 BUNDLE 和单次运行各自需要准确身份及既有流程的审查、调度记录；这里不保存私有库存或路由摘要。新源码不能复用旧失败 attempt 的许可或运行目录。

## 单一设备、ABI 与双向关系

固定 UAPI 来自 Linux `028ef9c96e96197026887c0f092424679298aae8` 的 [dm-ioctl.h](https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/include/uapi/linux/dm-ioctl.h) 与 [dm-ioctl.c](https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/drivers/md/dm-ioctl.c)。新头文件只声明本 profile 所需结构和九个命令，并用编译期断言固定 x86_64 little-endian 布局。

- ABI 必须是 4.50.0；每次 fresh buffer 固定 16 KiB，满额不扩容或重试。请求 `data_start=312`；无参数返回的有效 header 到 `data` offset 305。VERSION 只覆写 version；空 LIST 返回 312 字节。这些长度按具体命令区分。
- 控制节点实际绑定 `/sys/class/misc/device-mapper/dev` 与 `/sys/dev/char/10:236`。初始完整 DM list 必须为空。新名称 `br-f3-<run UUID 去连字符>`、UUID `boardroom-f3-dm:<run UUID>`，不指定 persistent minor。
- 设备 major/minor 来自本次 CREATE 的实际返回，后续只按唯一 UUID 查询；不用假定 `dm-0`。name、UUID、dev、active / inactive / suspended / readonly 状态必须符合当前唯一阶段。未知 flags、额外数据、坏 NUL、错大小或表边界均拒绝。
- 仅一个 active linear target：start 0、length 131072 sectors、参数 `1:0 0`。请求 next 与响应 next 的基准不同，消费者分别核验精确单表；唯一 dependency 必须是 ram0。
- 每次边界回读包含实际 DM sysfs realpath / inode、节点 lstat / fstat / rdev / 64 MiB、DM slaves `{ram0}` / holders 空、ram0 holders `{本次实际 dm-N}` / slaves 空、两者无 partition、完整 `/sys/block` 等于同次 P1 基线加 ram0 和该 DM。源 held FD 的 statx / statmount / mountinfo 反向绑定这个动态设备，不能仅靠字符串名。

上述原始返回值在建图、校准后、两轮测量前后、remove 前取得并保存。open_count 是可能过时的内核观察，不能单独证明没有 writer；所有权还依赖下面的 actor / FD / 节点闭包。官方 [linear target](https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/drivers/md/dm-linear.c) 和 [DM I/O accounting](https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/drivers/md/dm.c) 仅支持机制推断；实际固定 kernel 的可用性仍需新现场。

## 绕行排除、校准与正式窗口

建图前只允许 PID1 以原只读 ram0 FD 核 geometry。DM active 后，实际关闭所有 raw ram0 FD，核同一 owned node 身份并 unlink；直到卸载 brd 不再创建或打开它。正式块读取来自 DM 节点；不会用 ram0 的 stat 代替 DM 的计数。

七个无 child 边界的实际 census 枚举全部用户进程及其 FD，固定只允许 PID1，其他实际进程必须以 stat flags 证明为 kernel thread。PID / start identity 需两次一致，读不到、额外用户进程、未知 FD、关闭错误均失败。完整 initramfs 节点扫描有界，只接受 console、null、本次 DM 节点及 DM control；两轮边界不能有额外挂载。普通 child 在固定入口实际回读继承 FD，不能持有 block / control；它随后按原 SP probe 打开并持有合法只读目录 / 文件 FD，完成所有 getters、一次内容读取、路径复核和 close。

格式化 child 在 fork、stdio 重定向和已知 FD 关闭之后、固定 `execveat` 之前，实际枚举一次全部 FD。此时只允许 null stdin、两根输出 pipe、已核 inode / mode / size 的 mke2fs 执行 FD 和本次枚举 FD；后二者必须带 `CLOEXEC`，枚举 FD 需要实际关闭成功。原始 `BRDDM-MKFS` 记录随格式化 stdout 保留，并绑定同一次 child wait 的 PID。这是固定 exec 之前的继承 FD 证据，不声称已取得 mke2fs 执行后的 FD 清单。

校准仅在 mkfs 前、同一实际 DM 节点的 `O_RDWR | O_DIRECT` FD 上执行五个同步 4 KiB 操作：read A、write 非零 A5 pattern B、read B、restore A、read A。每步保存原始 17 字段 stat、真实 I/O rc / errno、内容和 close；要求恰好 3 reads / 24 read sectors、2 writes / 16 write sectors，没有 merges、discard、flush、inflight、回退或未观察到的 I/O。`queue/iostats` 必须实际为 1，程序不设置它。失败不重试、不进入格式化；校准不是第五次完整快照，也不证明真实 ext4 窗口必然通过。

之后沿用原 prepare、control、ordinary 两轮以及四张 64 MiB 全块观察。仅真实读到的零块编码零游程；短读、遗漏、重复、非规范编码或未确认关闭不能补成零。原 block0 / journal 全量、精确 mount +8 sectors / unmount 公式、字节白名单、错误健康项、同源 UUID/FID、Tcut 之前全部 native FD 关闭和 owner reap 的条件保持。唯一计数源和 filesystem sb_id 绑定本次 DM。

DM 观察在原始串行流中的位置必须实际包围对应的格式化、快照、round 与 cleanup；独立一条看似正确的 DM 序列不能替代这些关联。所有 DM、校准、census、普通 FD 原件保留为有限 artifacts。

## 收尾与预算

正常顺序是 child 退出 / join → 本轮 unmount → 最后 stat / 完整快照 → DM FD 全部关闭 → UUID 状态 / 表 / 拓扑回读 → 普通 REMOVE → 空 LIST、实际 sysfs / dev link 消失、ram0 holders 空 → 核 owned 节点再 unlink → 原 brd unload → 全部关闭及自然 poweroff。没有 deferred remove、remove-all、force、自动第二次 attempt。原错和 cleanup 错分别保留；unknown close / owner / unmount / remove 不能写成已回收。

| 约束 | 原数值 |
| --- | --- |
| VM | 512 MiB、1 vCPU |
| 编译 / 准备 | 三次共享 10 秒 / 总 60 秒 |
| 普通 child / mke2fs / 阶段 | 3 / 30 / 60 秒 |
| fixture / 业务截止 / 外层 job | 300 / 290 / 600 秒 |
| TERM / kill-reap | 2 / 3 秒 |
| serial / F3 管理帧合计 / 单帧 | 8 MiB / 7 MiB / 64 KiB |
| artifact / 压缩 / 展开 | 64 / 16 / 32 MiB |
| 全块观察 | 四次 64 MiB；总解码 256 MiB |

DM 新证据使用原预算，达到上限即失败。runner 仍使用原 OwnedChild / Pump / QMP、固定 argv/env/cwd、独占 claim、真实退出和最后 artifact seal/close 条件。最终观察成功要求选中 profile 的状态严格匹配；不改变旧 allowlist 或将 `RESULT.json` 单独视作全部资源已关闭证明。

## 纯控制与剩余真实证明

标准 Linux CI 在原 F3 纯控制步骤调用 `python3 -B tests/whole-brd-f3-dm.test.py`。合成 ABI / topology / census / stat / 串行记录只检验消费者的正反行为；完整串行控制显式替代 native 窗口，不能作为原生资格证据。测试不能启动 guest、DM ioctl、mke2fs、module 或 mount。C/UAPI 的 `-fsyntax-only` 检查不生成对象、二进制或 BUNDLE，也不验证实际静态链接。

待真实证明的对象包括：固定 kernel 中 DM 4.50 / linear 实际可用，iostats=1，五步计数正确，同源 ext4 两轮满足原公式，所有 FD / actor / 节点闭包在原预算内完整输出，以及实际 remove / unload。任何失败保留本次原件与 `FAILED_NO_RETRY`，返回具体接口或设计缺口；不得在现场放宽旧分类条件求通过。

# F0B/F1：私有原件采集准备

本片承接 [#152 接受范围](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6890398295)，实现 static guest helper、固定最小 initramfs 与真实父进程监督。F0 原有 `prepare` / 1–2 个拟议 target 配置保持不变；本片 **fixture targets 为 0**。内核自带块对象按实际枚举记录，不把本片零 target 写成全系统零设备。

[S05 后续接受范围](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6891835320)将私有控制接口改为自有子进程标准流，并将串口与启动错误分开保存。S05 实现、纯检查和有限非 VM 见证不授予 S06 新 guest 尝试。

资格始终为 `UNSUPPORTED`。本片不加载 brd、不创建 block node/fixture target、不 mkfs、mount ext4、freeze/thaw、运行 DB、生产/native 资格 target 或接入 provider。`POLICY_INPUTS_CAPTURED` 只表示所需原件已取得，不表示 effective policy 已被独立解释或放行后续 F2、M04/Fs、S4 产物。

## 文件与边界

| 文件 | 职责 |
| --- | --- |
| `f0b.py` | 零 target 固定计划；严格 newc/gzip 白名单与预算；私有 serial 帧解码、ordinary 身份及来源一致性检查。 |
| `guest.c` | 仅 `bootstrap` / `collect` 两入口。PID1 保留管理身份；子进程逐项清 capability bounding / ambient / I/P/E、groups、UID/GID 与 NNP 后 exec 固定 collector。 |
| `host-gate.c` | 先 exec gate，让父进程取得 Popen/pidfd；parent-death signal 与父身份确认后等待 ACK，再 fexecve 已固定的普通文件句柄。另有编译内固定的轻量 witness target。 |
| `supervise.py` | 只拥有自己创建的 Popen/pidfd、三标准流和串口 pipe；实际 exec/incarnation 绑定、pidfd TERM/KILL、有界 wait/reap、排空与句柄收尾。没有从 JSON/PID 重建清理权限。 |
| `transport.py` | 私有固定 stdio/fdset argv；父进程独占工件与写入前硬限额；三路公平排空、固定 QMP 命令和响应校验。QMP 只借用 FD。 |
| `build.py` | 离线验证固定资产/所选库/固件目录，逐项记录实际编译命令与 ELF 摘要，生成和检查 gzip/newc；没有启动行为。 |
| `ownership-witness.py` | 显式调用的一轮非 VM 见证：观察器→受控父→单个 gate/固定 target；通过创建时保留的 pidfd 转移、父故障、实际 wait/reap 取证。标准 CI 不调用。 |
| `pipe-witness.py` | 另行接受的一轮 ≤3 秒、无 VM/无 socket 见证，只执行固定 gate 的内置 pipe target；核新增继承 FD、分离标准流、真实 reap/EOF。其控制回复不是 QEMU 运行证据；标准 CI 不调用。 |
| `run.py` | 仅在精确实现独审和总控确认真实前置后，运行一次已固定 bundle。默认导入不执行；没有重试/替换环境路线。 |

## 离线构建

`build.py` 请求只含 `run_id` 与 `qemu`、`kernel`、`bios`、`busybox`、`qemu_data`、`library_manifest`、`notes` 的固定路径。前四者摘要来自 F0 `inputs.json`；库清单和 vendor notes 的来源摘要固定在构建入口。请求、摘要与 bundle 只是字节绑定，均不代替运行接受。

```sh
python3 -B scripts/qualification/whole-brd/build.py --request /absolute/fixed-request.json --output /absolute/new-output-directory
```

每次编译≤10 秒，准备 stage≤60 秒；输出目录必须新建。编译器实际路径/摘要、源码摘要、argv、返回值、stdout/stderr、实际耗时与 ELF 身份进入 `BUNDLE.json`。只接受 ELF64 x86_64 EXEC、无 INTERP/DYNAMIC segment 的 helper/gate。最终归档为 gzip/newc，压缩≤16 MiB、展开≤32 MiB；仅包含固定 BusyBox/helper、`/init`、所需空目录、固定配置、`bin/sh` 链接以及 console/null 字符节点。不会在宿主 mknod。

QEMU 固件目录里的名称由固定目录枚举取得，有界记录实际普通文件字节和链接文字；它们不作为 argv 拼接字段。输入 argv 路径仍用 F0 严格单根/无逗号检查。固件目录记录不声称全部链接目标已被 QEMU 加载；缺失/运行不支持必须留下实际失败，不能自动下载。

## 真实身份与原件

collector 直接读取 before/after `/proc/self/status`，要求四列 UID/GID 均 1000、Groups 空、五个 capability 集合全零、NNP=1，并保留实际 PID/PPID。bootstrap 回执使用 `management` 类型；它不能替代 `ordinary` 记录。

固定的一次 pass 包括自身 stat/maps/namespace 身份、uname、version/osrelease、boot_id、完整 notes、cmdline、mountinfo/modules、brd 存在性和 sys/block 名称枚举。这里的 maps 指 `uid_map` / `gid_map`；不转储完整进程地址空间。每项保留固定路径、顺序、原长度/字节、EOF、errno 与 close errno。notes 使用十六进制帧保留二进制字节。缺项、帧截断/交错、身份条件不符或后端原错误均不会被管理退出码填成成功。

原 cmdline 保持：

```text
console=ttyS0,115200n8 rdinit=/init loglevel=4 panic=0 bdev_allow_write_mounted=0
```

不添加 `max_loop=0`，不假定 `/sys/block` 为空。实际 notes、boot、cmdline 和来源链尚须真实 guest 原件；离线 parser 正例不计作 actual ordinary 证据。

## 父监督与一次运行

父进程先取得自己刚创建的 Popen 和实际 pidfd，再 ACK。gate 在自身 exec 后设置 PDEATHSIG/复查父进程，并降低本子进程 AS 为 2 GiB、CPU 累积为 300 秒、core 为 0；若现有限制更低就失败，不提高限制。gate 本身的私有文件句柄与之后的 executable 句柄都被固定；QEMU exec 后再次绑定实际 `/proc/<owned-child>/exe`、start ticks 与父身份。

资源配置、实际开销、未知 cgroup 限额和未预留容量各自记录。512 MiB / 1 vCPU 不等于宿主已有资源保证。启动≤60 秒、ordinary pass≤3 秒、fixture≤300 秒；串口≤8 MiB、stderr≤1 MiB、QMP 两方向合计≤1 MiB、运行证据≤64 MiB。父进程逐次写前限制字节，超限保存前缀并失败；不新增影响 QEMU 内部文件的 RLIMIT_FSIZE。原错误优先，清理结果另外保留；强制回收或清理 wait timeout 不会变成正常采集成功。

实际回收完成与运行正常退出分别判断。已 reap 的非零退出或信号终止保留原 returncode，总结果为 `GUEST_FAILED`；退出结果缺失或未证为 `EXIT_UNPROVEN`，不能由完整 ordinary 帧补成成功。更早的原错误仍优先。串口关闭失败保留原 errno，cleanup 标为未证并继续其它句柄收尾及已有串口/结果保存；失败关闭不隐式重试。

QMP 等待区分提前退出和实际期限：缺失回复且 child 已退出时保存 returncode，ordinary 尚未开始则为 `BOOT_FAILED`；child 仍存活并到达原三秒期限才为 `TIMEOUT`。退出前已写入的完整回复仍消费；错 ID、截断、每帧 64 KiB 或 16 项事件上限均拒绝。保留 serial、first-error、回收与单次 claim，历史运行原件不回写。

QMP 专用本次 child 的 stdin/stdout，启动 stderr 使用独立 pipe；不再创建或连接宿主 Unix/TCP 控制 socket。额外串口匿名 pipe 由父创建，gate 核 FIFO、写模式、dev/inode 和不同 FD 后继承。私有 argv 仅使用固定 `-add-fd fd=<owned>,set=1` 和 `file,id=serial,path=/dev/fdset/1,append=on`。这是 QEMU 内部 fdset 语法，无宿主路径打开回退；不允许外部 FD/JSON 授权，也不放宽普通 `/dev`、`/proc` 资产路径拒绝。

父进程在新建 0700 输出目录持有 dirfd，以 `O_EXCL|O_NOFOLLOW` 创建并保留 0600 原件文件，逐项核普通文件/owner/nlink/身份。QEMU 只取得匿名 pipe 的写端，不取得工件路径或 FD。三个输出并行排空、独立保存原字节和错误；QMP 只发送 capabilities、quit。fdset 可能保留 writer，故普通结束标记后发 quit，真实 reap 后才验证最终 EOF，不能先等待 EOF 造成死等。所有关闭异常分别保留，不跳过其余收尾或覆盖更早错误。

运行入口需要已独审的 bundle 摘要及新的输出目录。摘要不是授权 token；本实现交付阶段不执行此入口：

```sh
python3 -B scripts/qualification/whole-brd/run.py --bundle /absolute/BUNDLE.json --bundle-sha256 EXACT_ACCEPTED_SHA256 --output /absolute/new-run-output
```

固定 bundle 旁使用 exclusive `EXECUTION-ATTEMPT.json` 消费一次尝试。输出目录独占且保留原件；不连接替代 socket、不按进程名称扫描、不向数值 PID 发信号。退出状态、wait/reap、FD 关闭、原件身份和最终 metadata 收尾分别记录；失败后不自动启动第二个 guest。最终 RESULT/MANIFEST 自身关闭如失败，不能编码到其自身原字节，调用方必须同时保留入口最终 stdout/退出码；已有文件绝不覆盖。

## 持续回归与尚未运行项

```sh
python3 -B tests/whole-brd-f0b.test.py
```

标准 Linux job 只增加这条纯标准库命令。它使用自有临时普通文件和离线字节向量，不下载资产、不编译/运行 helper，不启动 child/guest、模块、设备或资格 target；失败直接传递，job/matrix/权限未变。

作者交接应分别标识：纯控制、实际 static 编译/ELF、实际归档、已消费的旧父死亡见证、新 pipe 见证，以及 **NOT_RUN 的真实 QEMU stdio/fdset、guest/ordinary**。旧来源片段只能按未变范围转移；内置 target 的控制回复不能代替实际 QEMU。作者结果不替代独立需求轴和标准轴。真实一次 boot 留待总控在精确候选审查与真实前置消费后决定。

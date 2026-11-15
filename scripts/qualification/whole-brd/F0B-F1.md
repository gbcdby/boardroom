# F0B/F1：私有原件采集准备

本片承接 [#152 接受范围](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6890398295)，实现 static guest helper、固定最小 initramfs 与真实父进程监督。F0 原有 `prepare` / 1–2 个拟议 target 配置保持不变；本片 **fixture targets 为 0**。内核自带块对象按实际枚举记录，不把本片零 target 写成全系统零设备。

资格始终为 `UNSUPPORTED`。本片不加载 brd、不创建 block node/fixture target、不 mkfs、mount ext4、freeze/thaw、运行 DB、生产/native 资格 target 或接入 provider。`POLICY_INPUTS_CAPTURED` 只表示所需原件已取得，不表示 effective policy 已被独立解释或放行后续 F2、M04/Fs、S4 产物。

## 文件与边界

| 文件 | 职责 |
| --- | --- |
| `f0b.py` | 零 target 固定计划；严格 newc/gzip 白名单与预算；私有 serial 帧解码、ordinary 身份及来源一致性检查。 |
| `guest.c` | 仅 `bootstrap` / `collect` 两入口。PID1 保留管理身份；子进程逐项清 capability bounding / ambient / I/P/E、groups、UID/GID 与 NNP 后 exec 固定 collector。 |
| `host-gate.c` | 先 exec gate，让父进程取得 Popen/pidfd；parent-death signal 与父身份确认后等待 ACK，再 fexecve 已固定的普通文件句柄。另有编译内固定的轻量 witness target。 |
| `supervise.py` | 只拥有自己创建的 Popen/pidfd；实际 exec/incarnation 绑定；同一 QMP 连接、pidfd TERM/KILL、有界 wait/reap、串口排空与句柄收尾。没有从 JSON/PID 重建清理权限。 |
| `build.py` | 离线验证固定资产/所选库/固件目录，逐项记录实际编译命令与 ELF 摘要，生成和检查 gzip/newc；没有启动行为。 |
| `ownership-witness.py` | 显式调用的一轮非 VM 见证：观察器→受控父→单个 gate/固定 target；通过创建时保留的 pidfd 转移、父故障、实际 wait/reap 取证。标准 CI 不调用。 |
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

资源配置、实际开销、未知 cgroup 限额和未预留容量各自记录。512 MiB / 1 vCPU 不等于宿主已有资源保证。启动≤60 秒、ordinary pass≤3 秒、fixture≤300 秒；串口≤8 MiB、运行证据≤64 MiB。原错误优先，清理结果另外保留；强制回收或清理 wait timeout 不会变成正常采集成功。

实际回收完成与运行正常退出分别判断。已 reap 的非零退出或信号终止保留原 returncode，总结果为 `GUEST_FAILED`；退出结果缺失或未证为 `EXIT_UNPROVEN`，不能由完整 ordinary 帧补成成功。更早的原错误仍优先。串口关闭失败保留原 errno，cleanup 标为未证并继续其它句柄收尾及已有串口/结果保存；失败关闭不隐式重试。

运行入口需要已独审的 bundle 摘要及新的输出目录。摘要不是授权 token；本实现交付阶段不执行此入口：

```sh
python3 -B scripts/qualification/whole-brd/run.py --bundle /absolute/BUNDLE.json --bundle-sha256 EXACT_ACCEPTED_SHA256 --output /absolute/new-run-output
```

固定 bundle 旁使用 exclusive `EXECUTION-ATTEMPT.json` 消费一次尝试。专用 `/tmp/boardroom-brd-<run_id>` 目录以 0700 新建并保留目录身份。只连接该目录的 QMP；不连接替代 socket、不按进程名称扫描、不向数值 PID 发信号。退出状态、wait/reap、fd 关闭和目录清理分别记录；失败后不自动启动第二个 guest。

## 持续回归与尚未运行项

```sh
python3 -B tests/whole-brd-f0b.test.py
```

标准 Linux job 只增加这条纯标准库命令。它使用自有临时普通文件和离线字节向量，不下载资产、不编译/运行 helper，不启动 child/guest、模块、设备或资格 target；失败直接传递，job/matrix/权限未变。

作者交接应分别标识：纯控制、实际 static 编译/ELF、实际归档、单轮本地 child 见证，以及 **NOT_RUN 的 QMP/guest/ordinary**。作者结果不替代独立需求轴和标准轴。真实一次 boot 留待总控在精确候选审查与真实前置消费后决定。

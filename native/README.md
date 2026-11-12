# macOS 存储维护原生接缝

此目录仅服务于 #152 的维护前缀。`maintenance-darwin.c` 提供固定、只读观察或精确 FD 同步操作；不运行 shell、不发送进程信号、不接受任意命令，也不承担迁移阶段状态。

## 构建与安装

需要 macOS 的 Xcode Command Line Tools（`/usr/bin/cc`、系统 SDK 和 libproc）。`npm ci` 的 `postinstall` 只在 Darwin 尝试编译；缺少工具时保留普通应用功能，维护操作明确返回能力不可用。Linux 的安装行为不变。

在实际 macOS 维护环境或 CI 上，以下命令必须成功；它不会将缺少平台或编译工具记为跳过：

```sh
node scripts/build-maintenance-platform.mjs --required
node --test --test-concurrency=1 tests/maintenance-darwin.acceptance.ts
```

生成物位于已忽略的 `build/maintenance-platform/`，不随源码提交。运行时仅执行本包固定位置、当前用户拥有的单链接可执行文件。没有原生组件时，普通入口仍能登记 `process_local_only`，该身份不能作为独立维护停写证据。

## 能力与边界

| 操作 | 可观察事实与失败条件 |
| --- | --- |
| 文件或目录同步 | 仅使用调用者继承的 FD 3；核实同一 dev/inode、本地 APFS、文件单链接；调用 `F_FULLFSYNC`，任何失败直接阻塞。无 barrier 或普通 fsync 降级。 |
| SQLite 控制提交 | 启用并回读 `synchronous=FULL`、`fullfsync=ON`、`checkpoint_fullfsync=ON`；固定窄扩展通过 `SQLITE_FCNTL_HAS_MOVED` 核验真实连接，允许 SQLite 合法复用本适配已证句柄；main/WAL/SHM 按实际操作归属，提交后额外核实强同步。 |
| 源写者库存 | 仅枚举当前 UID 的进程；只返回已知源文件或明确目录树匹配的 vnode FD/内存映射，按真实 dev/inode 匹配。权限不足、身份变化或枚举不完整保留阻塞。当前进程也必须逐个核对句柄，不按 PID 整批放行。 |
| 文件边界 | 只接受当前用户拥有、无 group/other 写位、无 extended ACL 的源文件；目录树根须私有，并拒绝设置 `MNT_IGNORE_OWNERSHIP` 的卷。目录链、符号链接、硬链接、持有句柄与 sidecar 替换仍由平台和 SQLite 适配共同复验。 |
| 进程身份 | libproc 的 UID、PID 和微秒精度启动时间，加内核 boot session UUID；PID 复用或换次启动不能视为相同进程。它不替代已有托管 wrapper 的真实退出证明。 |
| 主机绑定 | `gethostuuid` 的持久主机标识只进入私有摘要；不在公共回执或日志输出原值。 |

原生适配的目标验证环境为 macOS arm64 / 本地 APFS。具体支持结论必须以同候选 macOS CI 的实际系统、Node/libuv、SQLite 版本及测试记录为准。网络盘、Windows、未知写者或未证明安全停止的模型宿主仍阻塞维护。本地敌对管理员能够替换文件或拆除数据库防护，继续适用 #152 r3 的明确排除边界。

`powerLossTested` 始终为 `false`。能力回执记录实际系统调用成功、原子名称发布和子进程故障恢复；CI 中的 SIGKILL 不被表述为物理断电实验。维护协调器还必须保持数据库锚点、当前代际和完整恢复链的独立核验。

## 一手依据

- [Node 24.22.2 的 libuv fs.c](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/unix/fs.c)：Darwin 的 Node sync 先尝试 `F_FULLFSYNC`，失败后可能退为 barrier 或 fsync；单独的成功返回不能辨明采用了哪一层。
- [Apple fsync 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)及 [fcntl 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)：解释普通刷新与请求设备缓存落盘的差别；实际设备行为仍需独立证据。
- [macOS 26 XNU 的 fcntl 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/kern_descrip.c)、[proc_info 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/proc_info.c)及 [libproc 公共接口](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/libsyscall/wrappers/libproc/libproc.h)：对应 vnode 同步、进程/FD/映射枚举和身份观察。
- [Apple 的 ACL 条目接口实现](https://github.com/apple-oss-distributions/Libc/blob/Libc-1725.0.11/posix1e/acl_entry.c)及 [FD ACL 接口实现](https://github.com/apple-oss-distributions/Libc/blob/Libc-1725.0.11/posix1e/acl_file.c)：Darwin 的条目成功值为 0，空集为 -1/EINVAL；与 Linux 的约定不同。
- [SQLite 文件控制接口](https://sqlite.org/c3ref/c_fcntl_begin_atomic_write.html)：`SQLITE_FCNTL_HAS_MOVED` 核对当前连接打开的文件是否仍为原路径，避免以“出现新 FD”误判 SQLite 的合法句柄复用。

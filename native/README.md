# macOS 存储维护原生接缝

此目录仅服务于 #152 的维护前缀。`maintenance-darwin.c` 提供固定、只读观察或精确 FD 同步操作；不运行 shell、不发送进程信号、不接受任意命令，也不承担迁移阶段状态。

`postgres-public-directory.c` 是 public 验证恢复独用的 Node-API 接缝。在 Node 进程内对已绑定目录 FD 执行 `openat` / `fstatat`，只接受内部生成的六类私有 `.public-*` 叶名称。它不提供源文件系统快照、任意路径访问或迁移协调能力。Darwin 的 `/dev/fd/N` 可用于末端文件 FD，不能作为目录 FD 子路径创建的替代。

## 构建与安装

需要 macOS 的 Xcode Command Line Tools（`/usr/bin/cc`、系统 SDK 和 libproc）。`npm ci` 的 `postinstall` 只在 Darwin 尝试编译；缺少工具时保留普通应用功能，维护操作明确返回能力不可用。Linux 的安装行为不变。

在实际 macOS 维护环境或 CI 上，以下命令必须成功；它不会将缺少平台或编译工具记为跳过：

```sh
node scripts/build-maintenance-platform.mjs --required
node --test --test-concurrency=1 tests/maintenance-darwin.acceptance.ts
```

生成物位于已忽略的 `build/maintenance-platform/`，不随源码提交。运行时仅执行本包固定位置、当前用户拥有的单链接可执行文件。没有原生组件时，普通入口仍能登记 `process_local_only`，该身份不能作为独立维护停写证据。

public 目录接缝产物为 `postgres-public-directory-<arch>.node`，权限 0700，运行时核对固定路径、owner、普通文件和单链接。它使用 `native/node-api/v24.22.1/` 的四个上游公开 C headers（附 LICENSE 与 `SOURCES.json` 原文 SHA），以公开 Node-API 8 编译，不使用 V8/Node 私有接口，不在安装时下载 headers。实际 Node 必须支持 Node-API 8；构建和资格记录分别保留 headers 版本、runtime Node/NAPI、compiler 和产物摘要。该组件构建失败只使 public 恢复不可用，不删除已构建的库存工具或 SQLite 扩展；`--required` 仍失败。

目录借用 FD 在 async queue 前复制并保持到真实完成；文件 raw FD 在交给 TS 后由 try/finally 覆盖元数据、abort 与 adoption 的所有失败。读取使用 O_NONBLOCK|O_NOFOLLOW，返回后严格拒绝非普通文件，再由 public helper 保留完整 sealed 身份/摘要和目录复验。O_NONBLOCK 消除 FIFO 等待对端的路径，不意味着任意内核 I/O 可强制取消。取消或期限到达仍须等待已经发起的操作完成并关闭其 FD，不能提前声明结束。

真实 Darwin 资格还须执行以下生产桥控制，然后运行原 public PG 五场景；Linux 的便携 C 控制不能代替 Darwin 的末端 descriptor adoption、offset 或原生 PG 消费证据：

```sh
node --test --test-concurrency=1 tests/maintenance-postgres-public-directory.test.ts tests/maintenance-postgres-public-directory.acceptance.ts
```

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

## 隔离文件副本恢复目录接缝

`maintenance-restore-directory.c` 与 `restore-directory.ts` 仅服务于 #152 已持久 Fs/payload 的隔离文件副本恢复。Darwin 安装单独构建 `maintenance-restore-directory-<arch>.node`，失败只阻塞此组件，不删除或放宽既有 observer、SQLite 或 public 组件。构建复用同一组有校验摘要的 Node-API 8 headers，运行时核固定包内路径、当前 owner、0700、普通文件与单链接。

所有创建均相对于已持有且核实 dev/inode 的父目录 FD，逐次只接受一个不含斜杠、NUL、`.` 或 `..` 的叶名称。Linux 使用 `/proc/self/fd/N/leaf`；Darwin 使用 `mkdirat`/`openat`，先复制父目录 FD 再排入工作队列，完成后关闭借用 FD。Darwin 只通过末端 `/dev/fd/N` 接收新开文件或目录 FD，不把它当目录子路径。恢复时即使原父目录路径被单向替换为符号链接，实际 mkdir/create 仍落在原已固定目录；路径绑定复查失败时保留本次残留并报告失败，不向新指向的外部目录写入。

同 host 的 Fs 已知源根、absent 根既存祖先及每项源身份在目标创建前与实际目标祖先比较，不能因源目录改名就将其变成可写的 attempt。创建前完整枚举 `plans`、`journals`、`snapshots` 的实际目录后代，将其 dev/inode 与 attempt 祖先比较，拒绝预置的后代 bind alias；不只比较三个顶层路径。保护域检查最多读取 16384 项、深入 64 层，遇到链接、重复物理目录、非私有目录、无法完整读取或检查期间变化即失败，不能将不完整枚举当作不重叠证明。

源文件内容不加 UTF-8/JSON 限制；目录只比较类型、完整成员和数值权限，不比较异文件系统的原 st_size。恢复文件的只读 FD 保留到目录同步之后，再核对精确字节、摘要、身份与权限；目录最终模式仍与 manifest 比较。chmod 前另留只读末端 FD，支持 mode 000。所有异步读回、同步及 FileHandle 关闭实际结束后，在同一同步末段复验这些 FD 的身份、权限、大小、mtime/ctime、目录成员变更事实、固定路径和明确 absence，随后同步关闭末端 FD；任何关闭失败仍阻止成功。这给出了本次恢复操作完成时的有界事实检查，不声称抵御敌对进程任意并发改写或保证返回后永久不变。输入受 16 MiB manifest、4096 entries、256 个目录及 512 个描述符的本地预算限制；每个非 absent 条目计两个 FD，另预留 10 个用于目标根、固定祖先与瞬时 acquisition，超限在创建恢复目标前失败。

以下两份测试在 Linux 执行真实生产路径及相同 C 源码的便携 ABI 控制；在 Darwin 执行安装得到的实际组件。便携 C 控制不替代 Darwin 的末端 FD 接收、APFS 同步或同候选 macOS CI 结果。

```sh
node --test tests/maintenance-restore-directory.test.ts tests/maintenance-restore-files.test.ts
```

本组件不采集 live 源，不赋予 Fs/provider 资格，不改变 public 接缝的 `.public-*` 白名单，不生成完整 V/R/Jr 或释放任何 S4 命名产物。失败保留首错、关闭错误及本次已创建目标；不自动清理或覆盖其他目录。

`powerLossTested` 始终为 `false`。能力回执记录实际系统调用成功、原子名称发布和子进程故障恢复；CI 中的 SIGKILL 不被表述为物理断电实验。维护协调器还必须保持数据库锚点、当前代际和完整恢复链的独立核验。

## 一手依据

- [Node 24.22.2 的 libuv fs.c](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/unix/fs.c)：Darwin 的 Node sync 先尝试 `F_FULLFSYNC`，失败后可能退为 barrier 或 fsync；单独的成功返回不能辨明采用了哪一层。
- [Apple fsync 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)及 [fcntl 手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)：解释普通刷新与请求设备缓存落盘的差别；实际设备行为仍需独立证据。
- [macOS 26 XNU 的 fcntl 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/kern_descrip.c)、[proc_info 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/kern/proc_info.c)及 [libproc 公共接口](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/libsyscall/wrappers/libproc/libproc.h)：对应 vnode 同步、进程/FD/映射枚举和身份观察。
- [Apple 的 ACL 条目接口实现](https://github.com/apple-oss-distributions/Libc/blob/Libc-1725.0.11/posix1e/acl_entry.c)及 [FD ACL 接口实现](https://github.com/apple-oss-distributions/Libc/blob/Libc-1725.0.11/posix1e/acl_file.c)：Darwin 的条目成功值为 0，空集为 -1/EINVAL；与 Linux 的约定不同。
- [SQLite 文件控制接口](https://sqlite.org/c3ref/c_fcntl_begin_atomic_write.html)：`SQLITE_FCNTL_HAS_MOVED` 核对当前连接打开的文件是否仍为原路径，避免以“出现新 FD”误判 SQLite 的合法句柄复用。


## Linux P0–P2：不透明源 FD 与普通原生事实（不具备 Fs 资格）

#152 的源文件原生接缝 P 已固定完整原始 getter、同 FD FID/UUID/健康状态、profile 与 open-at 交付合同。当前 P0–P2 只完成以下子能力，不属于完整 P，也不发放可用于迁移的源资格：

- **native/maintenance-source-files.c**：Node-API 8 的私有 napi_wrap owner；只通过 openat2 打开真实只读根和子叶，子项强制 RESOLVE_BENEATH、RESOLVE_NO_XDEV、RESOLVE_NO_SYMLINKS 与 RESOLVE_NO_MAGICLINKS。不导出 FD、任意 syscall 或写入口。observe/readAt/readDirectory 始终使用同一个真实持有的 FD。
- **source-file-native.ts**：当前 scope 内一次性使用、显式关闭子 owner；失败、子 owner 遗漏或关闭未知都不返回可消费成功。返回的是事实而不是资格标志。生产加载检查 Node-API、实际当前 UID、单链接普通文件和 0700 权限；缺少/编译失败保持 unavailable。
- **source-file-profile.ts**：当前支持表为空，生产匹配始终拒绝 backup_capability_unavailable；不得从本基础 observe 数据、测试替身或调用者 proof 生成 source-preservation 资格、Fs/Jq/Tcut。

P1 的 `observeStatx()` 保留原始 mask、设备/ino、mount ID、btime、attributes/mask；未返回的 optional 字段为 null。P2 的 `observeExtended()` 同步借用当前 owner 的同一 FD，读取 `FS_IOC_GETFSUUID`、带 `AT_EMPTY_PATH | AT_HANDLE_FID | AT_HANDLE_MNT_ID_UNIQUE` 的 `name_to_handle_at`、`FS_IOC_GETFLAGS` 以及 `flistxattr/fgetxattr`，不重新按路径打开、不导出数字 FD，也不申请权限。前后 fstat（含 uid/gid、mode、nlink、size、atime/mtime/ctime）及 fstatfs 类型不一致时拒绝整个观察。

每个 getter 返回 `observed` 或 `unavailable`、原始 syscall rc/errno 及原始值；未执行的调用用 null rc/errno。权限、系统调用、长度、身份或枚举未知均为 unavailable，值为 null；不会用零值代替。UUID 长度限 1..16 bytes；FID 使用固定 128-byte 缓冲，不按 EOVERFLOW 扩容或重试，返回原始 type/bytes 与 u64 unique mount ID。普通 inode flags 以无符号 32 位 BigInt 返回。xattr 名称和值都是 Buffer，不经过 UTF-8 替换；只涵盖当前普通权限可枚举且可读取的属性，隐藏/特权属性不被推断。集合按原始名称排序并复读名称清单，最多 64 项、名称加值总计 65536 bytes，任何缺失、ERANGE、超额或枚举变化都不返回部分成功集合。

声明依据为固定 [Linux v6.18 fs.h](https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/fs.h)、[fcntl.h](https://github.com/torvalds/linux/blob/v6.18/include/uapi/linux/fcntl.h)、[fhandle.c](https://github.com/torvalds/linux/blob/v6.18/fs/fhandle.c) 与 [ioctl.c](https://github.com/torvalds/linux/blob/v6.18/fs/ioctl.c)。构建静态核对 fsuuid2/file_handle 布局及 ioctl/flag 编码；仅补缺失声明，不猜 syscall 编号。缺少 FID syscall 声明时该事实明确为 ABI unavailable。

Linux 的此组件须显式执行以下两行，普通 npm ci / postinstall **不会**启用；现有 macOS 构建和保守失败语义不变：

    node scripts/build-maintenance-platform.mjs --source-files
    node --test tests/maintenance-source-file-native.test.ts

编译使用仓库随附已逐项校验 SHA256 的 Node 24.22.1 Node-API 8 headers，输出位于已忽略的 build/maintenance-platform/maintenance-source-files-linux-<arch>.node，权限 0700。真实完整 P 仍需十三项健康字段、source-state、完整窗口与固定非空支持资格，严格验证 Linux 内核/挂载/FD 引用与后续 S/C 的原生正反例；未验收前 production_enable 继续 false。

测试中的真实文件/目录、原始 xattr、预算、权限及关闭后拒绝只属于 **Linux 普通 getter/ABI 控制**。独立临时 addon 的固定 syscall 故障注入只检验 unavailable 与 rc/errno 保留，不代表真实权限失败或资格证据。它们不证明 macOS、正式 Profile、源不变窗口、物理断电耐久、迁移 journal、S4 三个命名产物或可用的公共迁移入口。

## Linux P3：真实 owner 上的固定上下文与保守 profile 匹配

P3 保留 P0–P2 原始 getter，并增加独立 `STATX_MNT_ID_UNIQUE` 观察。LEGACY 与 UNIQUE 是不同的 ID 空间，各自与同一 FD 的原始结果绑定，不能通过两个数值相等或互相填充来建立关系。原生 owner、scope、bootstrap 和 profile 状态分别保存在私有 owner 与 WeakMap 中；调用者的同形对象、复制对象、子 owner、已关闭 owner 或已结束 scope 都不能取得根上下文或资格。返回的诊断字段与摘要不具有授权作用。

目录根可继续提供普通原始事实。正式 S 在打开首个子文件内容前必须完成固定 matcher 与 `beforeContent()`；读取结束后须调用 `afterContent()` 并完成 S 自身的 source-state 和窗口核验。P 的窗口摘要绑定本次实际环境，不能被当作永久源身份，也不单独签发 Tcut。

文件根先通过 O_PATH 取得 metadata-only bootstrap，并独立持有真实父目录辅助 owner。它不能读取内容、列目录或调用可读 FD getter。固定异步工厂通过本包 profile 初始化器完成真实同源环境、健康与固定注册表预检后，才可由父目录相对只读 openat2 创建新的 NONBLOCK/NOATIME 内容 owner。新旧 owner 和原路径的身份必须交叉核验；bootstrap 与父辅助的关闭须已确认，才能把新的 owner 交给 S。旧 owner 不更换 FD，失败的 promotion 不能重试；普通原始 native API 控制不等于通过了这项生产预检。

上下文 ABI 只接收固定原生 collector 的完整类型与字段：进程/namespace、uname 与实际 notes、LEGACY/UNIQUE/statmount/mountinfo、原始 tune/options/mb_groups/journal task 与 ioprio、真实设备绑定和有界关系图，以及同源 sysfs 下的十三项健康字段。原件中的每次调用保留实际 rc/errno；未执行用 null，unavailable 不填零，不由调用者提交 proof、回调、成功 bool 或自证 digest。未知字段、错误类型、无法确认 EOF/关闭或不完整枚举均不能升级为成功上下文。

配置、挂载与设备原件在十三项健康读取后进行后验；需要双采样的 fact 保持一个共同原件值和两段完整调用记录，后段 operation 加 `-after`。每段分别具备真实 EOF、完整字节数和关闭成功，不能把两段长度合并后与一个值比较。两段共享每 fact 最多 256 次实际 read/getdents、全局 2 MiB 原始读取和 32768 次调用预算；null 占位不计实际调用。图最多 64 节点、128 边、16 层。资源 trace 逐个核对实际持有、使用与收尾，不能用最后一条 close=0 代表全部资源关闭；未知关闭保留首错与其他辅助错误，不能重新关闭可能已复用的数字 FD。

固定支持表仍为空。完整内核 build/source/config 对照（M01）、完整有效 options 与 journal-task lifetime lease（M02）、普通权限下 backing 与写者覆盖证明（M04）仍是未证义务。相同 PID、零健康值、可读原件、合成解析正控或普通主机 getter 成功都不能解除它们。当前生产 matcher 继续返回 `backup_capability_unavailable`，既不生成 source-preservation 资格，也不启用公共迁移。一次上下文失败会锁定该根/profile 的失败，后续观察不能将它重置为新的正常基线。

P3 测试分别记录真实临时文件 owner/getter 与完整 collector 的组合结果、隔离纯 ABI/profile 机械解析控制、固定链接故障控制。纯解析副本只导出无副作用函数，不修改注册表或注册合成 owner/profile；固定链接测试把原字节 TS 模块放在独立包内，仍使用正常固定 addon 路径，没有生产加载覆盖接口。内容打开故障对实际 NONBLOCK/NOATIME file open 判别，验证完整原生预检后的空表拒绝发生在该打开之前。

必要的原生负控覆盖短读的 256 次边界、无 EOF、全局 2 MiB、伪文件 close 未知、源 metadata 后验变化、目录 closedir 未知和失败子 owner 的身份/关闭双错。用于全局预算的固定伪源只能产生无 EOF 的 unavailable，不能充当真实 sysfs/健康或资格正控。真实运行环境无法打开 `/sys` 或无法绑定其设备/健康目录时，完整原件明确保持 unavailable，不把未知当成正常零值。fatal collector 错误和未知关闭即使被调用者 catch，scope 也会保留失败；首错和真正的 opaque cleanup owner 不因后续清理诊断丢失，已知资源继续收束。

这些本机普通控制不代替 S 的固定组合检查、独立 REQ/STD、同候选 CI 或真实 qualification。对 statmount/mountinfo/process/config/health 的纯机械正控保留全部未证义务，不能签发成功 profile，也不能把 DM 构建或现场实验转成 P3 资格。

## #161 E3：memory object 隔离机械内核

`memory-objects.c` 是独立的 Node-API 8 组件。它实现真实目录与文件 owner、UTF-8/SHA256、不可覆盖发布、同 FD 核验、强同步和收尾；普通 addon **没有 root factory**，也未接入应用启动、source-client、LayoutWindow、数据库保存或 `objects_ready`。本段不表示已取得生产资格。工程范围依据 #161 [E3 接受记录](https://github.com/gbcdby/boardroom/issues/161#issuecomment-6975971607)、[调用预算补充](https://github.com/gbcdby/boardroom/issues/161#issuecomment-6976492513)及[结果解析补充](https://github.com/gbcdby/boardroom/issues/161#issuecomment-6977509921)。

显式构建：

```bash
node scripts/build-memory-objects.mjs
node --test --test-concurrency=1 tests/memory-object-native.test.ts
```

构建不接受参数，不受 `CC`、`CFLAGS` 或测试开关选择影响，不修改 postinstall、package 或 CI。固定 `/usr/bin/cc`、C11、Node-API 8 与仓库内 v24.22.1 headers；逐项核对四个 headers 和 LICENSE 的源 SHA。Linux 使用 shared/PIC/pthread/libdl，Darwin 使用 bundle/dynamic_lookup/pthread。固定产物是 `build/memory-objects/memory-objects-<platform>-<arch>.node`，当前用户、单链接、0700，通过临时文件原子替换。失败只清本组件临时文件。Linux/Darwin 缺编译器、headers 或实际 ABI 时构建及测试失败，不静默跳过。

普通 JS 出口精确为 `abiInfo`、`prepare`、`readVerify`、`revalidatePrepared`、`closePrepared`、`closeRoot`、`observeRoot`。`abiInfo().rootFactory` 固定为 `not-installed`。所有 owner 必须属于本映像的私有 C registry，普通同形对象、复制值及其他 addon owner 均不签发权限。五个异步方法返回 Promise；拒绝与文件故障返回固定代码、首错、后续实际收尾错误和真实资源观察，`observeRoot` 的无效 owner 使用固定脱敏错误。

结果使用自有 data property，避免继承 setter。五个异步方法的顶层结果还在首次 freeze 前加入不可枚举、不可写、不可配置的自有 `then: undefined`，避免 Promise 解析读取 `Object.prototype.then`。原型与枚举字段保持一致；嵌套 `MemoryObjectRef` 仍精确为四字段，能够通过 E2 的严格解析。普通 addon 不输出路径、正文错误片段、FD 数值或任意系统调用入口。

同一实际 dev/ino 的 root 使用同一账本，存续期间 storageId 和最大正文长度不可改变。最多 8 个对象操作在途（包括 prepared 和未完成责任），最多 64 个实际 owned/reserved/unknown FD；每次 open/dup 先预留。每个正文最多 1 MiB，固定 64 KiB 读写块，每次操作最多 256 个普通调用，已有 FD 收尾另有最多 64 个 close 记录。普通预算耗尽后不再执行 fstat/unlink/sync；临时项未清理时，即使 `fdUnknown` 为零，原 operation/root 也保持 retained，不能返回 closed/prepared。close 错误不重试数字 FD，已关闭后复用的无关 FD 不会被旧 owner 再关闭。

异步工作在 queue 前取得 C 与 NAPI 引用。短账本锁不跨越可调用 JS 的 Node-API 创建过程；同步 `async_hooks` 重入参与同一账本。root close 等待真实 staging/completion，控制 work 忙时让出线程池，每个 work 仅排队一次，在其 complete 后删除。后续控制 work 保留原关闭 invocation 的 120 秒截止时间；同 env/root 重复关闭合并，最多 8 个关闭等待环境通过原子预留登记，避免无界控制队列。这些收尾控制不发放新的对象槽或 FD 额度。Worker 退出使用 Node-API 8 async cleanup hook；清理覆盖本 env 的实际 C operation，包含未能交付 JS wrapper 的结果。单个 wrapper 的 GC 不关闭其他活 wrapper。旧 record 的代际与引用持续到旧 wrapper 消失，防止地址复用恢复旧权限。

本映像在任何 root 获取前只 pin 一次：private anchor 的 `dladdr` 定位、`RTLD_NOLOAD` 取得已加载映像引用，再以固定注册符号核相同 image base。成功引用保留到进程退出，不在最后 Worker 退出时释放。失败在 root/文件 owner 产生前拒绝。这样 unknown 账本不会因最后一个 Worker 卸载 addon 而消失。

目录固定为已存在的私有 root、`objects`、`objects/sha256`、`objects/.staging`，仅按 digest 创建两位 shard。Linux root 内部使用 openat2 的 BENEATH/NO_XDEV/NO_SYMLINKS/NO_MAGICLINKS；Darwin 使用相对 openat/NOFOLLOW 与实际身份/FS 核验。canonical 在 open 前拒绝非普通文件，打开仍固定 NONBLOCK/NOFOLLOW/CLOEXEC；FIFO 不等待写端。临时文件为 native 随机 O_EXCL/0600，发布仅用 renameat2 NOREPLACE 或 renameatx_np EXCL。EEXIST 自行核验并同步真实只读 canonical FD；Linux 使用 fsync，Darwin 使用 F_FULLFSYNC（含目录），没有普通 rename、覆盖或同步降级。

按 [Linux 外祖先 flags 补充](https://github.com/gbcdby/boardroom/issues/161#issuecomment-6979534426)，选定 root 之前的外部祖先（含 `/`）使用 `O_PATH|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW`，只要求实际目录遍历权限。首次获取和异路径重新获取都按末段区分选定 root；root 本身及内部目录仍使用 `O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK`，保留当前 UID、0700、身份、文件系统与强同步要求。外祖先仍保留 openat2 的 BENEATH/NO_SYMLINKS/NO_MAGICLINKS、打开后的实际 S_ISDIR 与逐层身份后验；全部实际 FD 计入同一预算并显式关闭。没有读取、写入或同步 O_PATH 祖先，也不修改其权限。Darwin 原 flags 不变。Linux 控制实际核对 search-only 祖先、所持 FD flags、symlink/无 search 权限/私有根非 0700/根替换拒绝及资源归零；CI 的隔离目录权限保持原样。

测试 fixture 是另编 translation unit，包含相同生产 C 文件；普通构建无法选择它。固定故障、hold、实际 FD 诊断及临时 root 获取仅存在于测试产物。`short-one` 只命中指定一次；`short-repeat` 是独立的固定测试 action，从指定序号起每次真实 read/write 请求最多 1 byte，直到实际普通预算耗尽，不修改计数或伪造成功。未知 close 和最后 env 退出的控制在专属 child 中运行并等待整个 child 实际退出。现有 Linux/macOS 完整测试 glob 会真实编译和执行该文件，Darwin 的实际只读 FD/目录 F_FULLFSYNC 和最后 Worker 生命周期仍必须由对应 CI 验证。

fixture 的同步 FD hold 关闭同样登记真实 operation task 与 C 引用，root close 必须等它完成；root 已占有关闭任务时，fixture 返回固定 `owner_closing`，不并行触碰该 FD。填满边界的 invocation 持有 dispatch 与独立引用，直到 hold wrapper 注册或失败责任挂账后才释放。诊断快照只在账本锁内复制 FD、状态与固定 role；第 65 个 FD 的用例先证明已有真实 `open` 事件，再要求预算拒绝前后该计数不增加。

分配负控明确是 `FAULT_INJECTED`，不是实际 OOM：`native-dispatch/fail-before` 的 occurrence 按每次 dispatch 中两个有序分配边界累计，先 C job calloc，再 `napi_create_promise`；1 保留 job 拒绝，2 拒绝同次 Promise 创建，后者进入与真实 Node-API 失败相同的固定 `napi_generic_failure` 分支。trace 分别为 `fixture-job-allocation` 和 `fixture-promise-allocation`，不能自选状态。该点的 hold 仍只作用于工作线程实际 dispatch。`native-complete/fail-before` 在实际 native 结束后、JS 结果构造前拒绝分配，走与真实构造错误相同的 retained 判定；hold 仍留在真实 native completion 前。异步固定错误通过 Node-API 的 uncaught-exception 递送机制报告，挂账先于递送，不假装返回成功结果。测试核实际 prepared/FD、新正文撤销、GC、Worker 退出及 unknown 责任。

Node 24 的 Node-API 8 在禁用 JS 时可能返回 `napi_pending_exception`；只有 `napi_is_exception_pending` 查询成功且实际为 false，才按退出处理，真实 pending exception 仍是构造失败。canonical 前后 stat 比较 Linux `st_mtim/st_ctim` 或 Darwin `st_mtimespec/st_ctimespec` 的秒及纳秒，读取中同秒修改已读字节仍须拒绝。测试日志绑定当前 C/fixture 源、两个实际 addon 摘要、Node/NAPI、compiler、OS、UID 与实际文件系统类型。

本组件不提供生产 source/window factory、真实 collector、数据库 commit/CAS、schema/guard 编号、迁移阶段推进、delegated child 或跨独立 registered client 的资源 realm。双进程发布测试只证明 noreplace 机械语义，不证明全 host 的 64 FD 配额；#152、FULL-Q 与整票资格门保持原要求。

# #152 R04 d1 有界证据候选

权威仍为 [#152 r3](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6852650119)；本次执行计划为 [R04 d1 归档](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6857609667)。它只实现隔离的 M01–M05 原件产出、严格离线消费和失败关闭骨架，不实现生产正向 matcher、Node-API/Fs/service 接线或 R05，不注册支持条目。

## 固定边界

- 实际目标必须为 `profile.json` 中的 Linux x86_64 / `7.0.0-1017-azure` 精确 version。runner 更换、工具缺失、接口/权限不可用只记 BLOCKED/INCONCLUSIVE，不安装工具或重复运行求命中。
- 普通 probe 使用非零 UID/GID、空附属组、全部五类 capabilities 为零、NNP=1。所有源文件普通打开采用 O_RDONLY|O_NOATIME|NOFOLLOW；root harness 只对自己新建的两个 64 MiB image 准备、观察、flush、回收。没有 production 新权限、源写入或 fallback。
- 同一个 held FD 上保留 fstat/statx/fstatfs/UUID/FID、GET_TUNE、GETFLAGS 和 statmount 原始结构；当前 unique/legacy ID、dev、sysfs 对象、proc options、mountinfo 与前后重验共同消费。SET 能力位不是 GET 有效位。所有未解释的配置、feature 和 backing 条件保持 UNKNOWN/UNSUPPORTED。
- 完整根以实际 mount root `/`、同挂载 O_PATH inode2、非 IDMAP 与原 source/path/writer 守卫为条件。whole-root bind 只收机械事实；原生产 writer 覆盖仍未证明。subdirectory alias、IDMAP/跨 mount、未知 backing 均不能获得准入；不虚构 `bind=false`。
- `match_runtime` 的 registry 为永久空的本候选骨架。用户 JSON、null、环境变量、完整证据或一次未见 SB 变化都不能创建受支持条目。实际 fields 将交独立设计解释，不能从 fixture mkfs 参数或 mountinfo 缺省省略填入生产值。

## M01–M05 与 COLD-01

M01 保存 ordinary getter/raw ABI、uname、kernel notes 和实际可读 ext4 module 资料。vendor 对应源码/构建关联不凭 uname 或 module 名补造，未证明则 INCONCLUSIVE。M02 使用 A/B 两个真实 FS 的不同持久 ACL 默认值和显式 `acl` mount override；provider 独立读同 FD getter 与绑定的 proc 原件。精确 effective 表、mounted-live feature 动态位及每个省略项仍需独立解释。M03 记录 root/dir/file/absent-ancestor 的真实返回、visible flags 与 DAX 有效位。M04 收 whole-root/subdirectory bind 原件；idmap 没有施加，保留 NOT_RUN。

M05 的准备挂载与冷挂载均是不同、短于 64 UTF-8 bytes 的路径。准备写入单列；冷观察轮先用只做 O_PATH/lstat/xattr 的新 observer，绝不复用会打开 regular file 的旧 Q03 observer。内容基线在未挂载时由 debugfs 只读 raw image 取得。随后分别进行 directory/O_PATH 控制轮和首次 ordinary content open 轮。probe 记录唯一 ordinary-open 的 PID/FD/单调时间及同 FD bytes/path guards。每轮的 pre、post、flush、unmount 四个原始 1024-byte SB 和前后 internal-journal 原件分别保存；flush 明确使用目录 FD，不能与 provider 行为混在一起。

只有控制轮稳定、同一真实 image/UUID、严格先后链、完整源观察域、实际 ordinary bytes 和新短路径对应的 `s_last_mounted`/checksum 持久变化共同成立，消费者才报告 COLD FAIL。全 image 任意差异不会直接归给 provider。未见变化始终 INCONCLUSIVE，不证明第一次 open 前可用的生产 cold rule。发现写入不再重试普通 open，不预热、换深路径或换 ro；后续无普通文件读取的配置记录不解除该 FAIL。root、loops、挂载、所有 children 必须有真实回执；只清理 marker 与 backing inode 共同绑定的自有资源，未知则保留。

## 执行和原件消费

本地只允许：

```sh
python3 scripts/qualification/fs-native-ext4-r04/run.py --mode local-check --out /absolute/new/output
```

它运行无提权编译、纯 ABI 输出和离线消费者控制；不会 mount、切 UID、运行目标 getter 或调用 sudo。M01–M05 全部仍 NOT_RUN。测试生成到文件、完整 manifest、再由同一消费者严格消费；缺少/篡改/误绑定/伪造 PASS/cleanup 不完整均拒绝。synthetic 原件显式标注，默认消费者拒绝作为 hosted 证据。

未来只有独立源码审查后获派的 `qualification/152-native-ext4-r04-d1` push 会触发新专用 workflow；没有 workflow_dispatch、自动重跑、main/PR 触发或 database-ci 改动。候选绑定实际 main `77c76fddcf1aa78a4fdcb87454d0b199e30b84f8`。每个 job ≤10min，compile≤10s，普通 probe≤3s，stage≤60s，fixture≤300s（内留30s清理）；最多三个冷观察轮和一组 defaults 变体、两 image、普通 payload≤1MiB、每类对象≤8。动作原件和完全列举的文件 manifest 在同一 artifact 中；最终资格结论仍由独立 verifier 作出。

`checks.consume(files, exact_source, exact_profile_bytes)` 会重新核源码/二进制/原 profile 字节、全部原件清单、真实返回/权限/同 FD/mount/cold 顺序及清理状态，再计算摘要。`integrity=PASS` 仅表示原件集合完整、语义可消费；M01–M04 不自动成为生产条目，M05 只有 FAIL/INCONCLUSIVE。外层同时保留真实 job/run/source 与 copied fixture 的再消费回执。exit0 也不是 profile PASS。

## 原资格与开放门槛

旧 [b9604f6b / run43437222508](https://github.com/gbcdby/boardroom/actions/runs/43437222508) 八文件和 Q01–12 原件冻结保留，既有有限 PASS 不重跑；旧 Q03 未声称 SB 全覆盖，Q09 是 detach/reattach，不是 OS reboot。本候选对 reference `support.py` 与 C 基础身份观察作可追溯复用，新的 cold observer、原件和 workflow 都在独立目录。

accepted_provider_profiles=[]、qualified_kernel_builds=[]、B1 OPEN、R05 NOT_IMPLEMENTED_NOT_RUN、旧 overlay FAIL/BLOCKED、历史产品 FAIL_UNRESOLVED、#153 BLOCKED、三项 S4 输出未释放。Fs v2 严格分支、既定 opaque-FID 假设、source/host/DB/plan/owner/link/writer/FD/预算语义不变；不存在无限历史零碰撞新要求。

## Primary sources（机制，不是实际 vendor build 验收）

- [GET_TUNE UAPI](https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/ext4.h)、[ext4 ioctl](https://github.com/torvalds/linux/blob/v7.0/fs/ext4/ioctl.c)
- [statmount UAPI](https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/mount.h)、[x86_64 syscall 457](https://github.com/torvalds/linux/blob/v7.0/arch/x86/entry/syscalls/syscall_64.tbl)
- [ordinary file sampling](https://github.com/torvalds/linux/blob/v7.0/fs/ext4/file.c)、[O_PATH](https://github.com/torvalds/linux/blob/v7.0/fs/open.c)、[directory open](https://github.com/torvalds/linux/blob/v7.0/fs/ext4/dir.c)
- [ext4 SB/options](https://github.com/torvalds/linux/blob/v7.0/fs/ext4/super.c)、[sysfs/proc registration](https://github.com/torvalds/linux/blob/v7.0/fs/ext4/sysfs.c)
- [harness LOOP_GET_STATUS64](https://github.com/torvalds/linux/blob/v7.0/include/uapi/linux/loop.h)：只用于自有资源物理归属，不给普通生产 provider 添加块设备权限。
- [loop 状态与清理](https://github.com/torvalds/linux/blob/v7.0/drivers/block/loop.c)、[JBD2 原始布局](https://github.com/torvalds/linux/blob/v7.0/include/linux/jbd2.h)：清理错误不得当作释放；journal 需匹配真实完整几何，未声称已验证所有事务内容。

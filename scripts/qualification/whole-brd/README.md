# whole-brd F0 准备

本目录对应 [#152 已接受的 F0 范围](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6889709365)：严格输入、资源预算、独占实例与回收接口、具体 provider 的离线准备。`f0.py` 只生成未授信计划、核对普通输入文件字节和读取有限 host 元数据；没有 launch/run、下载、安装、mount、module 或设备操作入口。

## 具体 provider 与输入

选择 **Debian 13 amd64 上私有解包的 QEMU 10.0.13 / TCG**，machine 为 `pc-q35-10.0`，CPU `max`、单 vCPU、512MiB guest RAM。使用 exact `7.0.0-1017-azure` kernel、SeaBIOS 和待接受的最小 initramfs；没有 guest 引导磁盘、网络、宿主 FS share、block passthrough 或 KVM fallback。QEMU 的 direct Linux boot 接口由上游 [Linux boot](https://www.qemu.org/docs/master/system/linuxboot.html) 与 [invocation](https://www.qemu.org/docs/master/system/invocation.html) 文档说明。

`inputs.json` 固定官方包 URL、版本、大小、摘要及已读取的 ELF/kernel 摘要。准备过程中已在专用目录解包 5 个工具包和 9 个明确缺失的声明依赖；未安装到系统。实际只读 `--version`、`-accel help`、`-machine help` 成功，分别确认 10.0.13、TCG 和指定 machine。只列帮助不证明 TCG 已经启动或 host 可以执行 guest。

现有宿主共享库仍属于运行输入，必须另有完整文件摘要清单并在使用前复核。仅取得 QEMU 包或 loader 当前无缺项不足以绑定全部未来运行路径。官方 HTTPS 的 InRelease→Packages→deb 摘要/大小已对应；独立 OpenPGP 验签未执行。上述准备适用本地 Debian 13；标准 CI 的 Ubuntu 24.04 发行版兼容性和可启动能力仍未验证。

最小 initramfs 与真实 ordinary observer 由后继 F0B/F1 的具体范围定义，F0 不伪造其字节、权限结果或实际能力。预计的 boot 参数 `bdev_allow_write_mounted=0` 仅是输入，不是实际 effective false 的证据。

## 使用与状态

请求只接受 canonical UUIDv4 与明确数量：

```json
{"run_id":"412e9c36-df93-4cbb-b77a-4047c52a343a","target_count":1}
```

示例 UUID 仅供离线解析。UUID/计划中的目录不是已取得的 lease 或所有权。实际运行必须使用新 scope 的独占目录和真实父子进程句柄。

```sh
python3 -B scripts/qualification/whole-brd/f0.py plan --request /absolute/path/request.json
python3 -B scripts/qualification/whole-brd/f0.py inspect-host
python3 -B scripts/qualification/whole-brd/f0.py bind-inputs --manifest /absolute/path/offline-inputs.json
python3 -B scripts/qualification/whole-brd/f0.py preview --request /absolute/path/request.json --assets /absolute/path/asset-paths.json
```

`plan` 不读取目标。`inspect-host` 只读 uname、UID/GID、OS release、自己的权限/限额及 PATH 定位；它不会运行 QEMU，也不把 PATH 中无工具等同专用目录无工具。`bind-inputs` 先固定普通 regular 输入对象，再有界读取并比摘要；任何缺失、symlink、目录、超限、错误或摘要不匹配都不会成为匹配结果。`preview` 仅输出固定 argv，完全不执行。

`offline-inputs.json` 使用以下格式，允许名为 `qemu`、`kernel`、`bios`、`busybox`、`initramfs` 的离线输入。摘要来自被接受的固定输入包，不是授权 token：

```json
{
  "kernel": {
    "path": "/absolute/path/vmlinuz-7.0.0-1017-azure",
    "sha256": "824225c877a300b88b14d6ec09e0eee20dc88b16e3d390acfc1f464f696ef032",
    "max_bytes": 33554432
  }
}
```

`asset-paths.json` 只允许 `qemu`、`kernel`、`initramfs`、`bios`、`qemu_data` 五个绝对普通输入路径；不允许扩展 argv、设备/proc/sys 路径、逗号/控制字符或 `..`。即使预览成功，也没有验证这些路径的实际输入字节或授予启动权。

| 输出 | 精确含义 |
| --- | --- |
| `PREPARED_UNTRUSTED` | 限定计划形成；actual instance 仍为空，目标 `created=false`。 |
| `MATCHED_OFFLINE_BYTES` | 本次普通输入字节匹配提供的摘要；不证明已加载或执行。 |
| `MISSING` / `REJECTED` | 保留缺项/原 errno 或拒绝原因；不回填默认事实。 |
| `HOST_METADATA_ONLY` | 仅当前宿主元数据，不是 guest 或 source capability。 |
| `PREVIEW_NOT_EXECUTED` | 固定命令描述，未执行。 |
| `BINDING_CONSISTENT_NOT_AUTHORIZATION` | 提供的两组清理身份字段相等；不是已取得句柄或可杀进程的许可。 |

所有输出保持 `guest_execution=NOT_RUN` 或没有 actual instance，资格保持 `UNSUPPORTED`。输入不能插入管理者声称的 ordinary PASS、已加载状态、KVM、额外设备或权限选项。

## 预算与所有权

默认拟议一个 64MiB 目标，最多两个，总计不超过 128MiB；F0 不创建这些目标。第二个目标的实际用途仍须在后继接受的控制范围内。`rd_nr` 只预建；精确 brd 源中的按需 `brd_probe` 还可能增加设备，cleanup 是整个模块范围，所以参数或 namespace 不构成全局数量与回收权证明。

| 资源 | 固定准备约束 |
| --- | --- |
| 隔离边界 | 自有整个 QEMU guest/内核实例；未创建，不触碰共享 host brd。 |
| guest RAM / CPU | 512MiB / 1 vCPU；host address-space 拟议上限 2GiB，实际可用性仍待 F0B。 |
| 引导磁盘 | 0；只用固定 kernel/initramfs/BIOS 输入。 |
| initramfs | 压缩 ≤16MiB、展开 ≤32MiB；F0B/F1 中无 brd 文件或自动装载动作。 |
| 时间 | boot≤60s、ordinary probe≤3s、fixture≤300s、job≤600s；失败不自动增大或重试。 |
| 输出 | serial≤8MiB、证据≤64MiB；输入工具/包的离线存储另外计账。 |

`cleanup_contract(raw_request, expected, observed)` 的两个 binding 都必须包含 `run_id`、`boot_id`、`parent_pid`、`pid`、`start_ticks`、`uid`、`executable_sha256`。错实例、父进程、boot、UID、start ticks、可执行字节或字段不全均拒绝。

**匹配 JSON 不建立进程所有权。** 后继 supervisor 必须保留自己创建的真实子进程对象和 pidfd，不能从 receipt/PID 重新构造权限。契约只规定 owned QMP quit→有界等待→仍持有父句柄时 TERM/KILL→真实 wait/reap；没有 signal 调用。不能凭数值 PID 或 process-group 批量清理其他会话。强制收束成功仍保留原 timeout/错误，不能改成正常 ordinary 完成；实际 EOF、wait status 和资源收尾要分别记录。

## 验证与集成

```sh
python3 -B tests/whole-brd-f0.test.py
```

这些是标准库纯控制：有限 JSON、固定预算、固定命令预览、身份矛盾拒绝，以及自有临时 regular 文件的离线匹配/拒绝。它们不下载或执行 QEMU/BusyBox 等工具，不读取实际 source，不启动 guest/native target，不创建 VM/块设备，不装载模块，不做资格运行。Linux CI 在已有 M02/Fs 两条 Python 离线命令后执行本命令；失败直接传递，现有 job/matrix/权限不变。

F0B/F1 必须另行固定并接受实际 bootstrap、ordinary 身份边界、完整输入和回收方案，才可进入一次真实 guest 观察。后续 M04、Fs、restore、耐久性和 provider registry 沿原门分别验收；本目录不释放它们。

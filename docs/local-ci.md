# 本地 CI 入口

状态：草案，2026-11-20。

## 目的

`scripts/ci/local-ci.mjs` 把云端 workflow 中可以本地执行的步骤集中为快速入口，用于在等待 GitHub Actions 前发现类型、构建、纯控制和目标测试失败。它不修改测试门槛；所有省略均在摘要中记为 SKIP 并说明原因，只改变执行位置与并发方式。

## 用法

```bash
npm run ci:local                       # 默认 preflight
npm run ci:local -- --focus=tests/foo.test.ts,tests/bar.test.ts
npm run ci:local -- --shard=3/8
npm run ci:local:full -- --jobs=4
npm run ci:local -- --no-web --no-native
```

- `preflight`：typecheck、Web 构建、原生维护工具构建、Python 纯控制、分区合同，以及 macOS 上的原生维护定向回归。
- `--focus`：只跑指定测试文件。
- `--shard=i/8`：跑一个 macOS 全量分片。
- `--full`：本地并行跑 8 个 macOS 分片，日志写入 `.agent-output/local-ci/`。
- `--jobs=N`：本地并行度，默认 4。
- `--no-web` / `--no-native`：跳过 Web 构建或原生维护工具构建，仅用于定位环境问题；被省略的步骤及其 macOS 原生回归会逐项记为 SKIP，摘要顶层同时记录选项，不能作为完整结果。
- `--skip-local-limited`：显式跳过 `tests/maintenance-sqlite.test.ts` 中仅两项已知本机 libproc 受限用例；同文件其余四项仍执行，跳过项记为 SKIP，CI macos-26 仍执行完整文件。

结果摘要写入 `.agent-output/local-ci/summary.json`，包含每步命令、退出码、耗时、平台、Node 版本、影响覆盖范围的选项与各 SKIP 原因。

## 边界

- 本机 Node、macOS 版本和内核与 GitHub runner 不完全一致；本地红/绿都不能替代云端对准确候选的验收。
- Linux 16 分片依赖 Ubuntu 24.04、Node 24.22.3、PostgreSQL 16.16 镜像、16.15 私有工具和非 root隔离，当前脚本只复现其纯控制部分；Linux 专属原生用例需用 Docker 定向或云端分片。
- Chromium job 依赖同次运行的 artifact ID 绑定和固定容器；本地 UI 脚本只能用于排查。
- 工具不自动改 workflow、不上传产物、不合并 PR，也不把本地结果写成云端 PASS。

## 云端减负

`.github/workflows/database-ci.yml` 已同步调整：PR 与 main 推送默认只跑 `smoke`（typecheck、构建、本地入口的通用控制）；完整 8+16 分片与 Chromium 全矩阵仅在 `workflow_dispatch` 勾选 `full_matrix`，或 PR 打 `ci-full` 标签时运行。该调整降低云端排队，但把最终全矩阵证据改为按需取得；仓库分支保护若要求原检查名，需由仓库管理员相应调整，否则合并仍会等待这些检查。

本地入口不是云端等价替代：它用于快速发现问题和缩小范围，最终仍以按需全矩阵及准确 checkout/tree、artifact 证据为准。

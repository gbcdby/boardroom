# BR-S4-T2-REFREEZE-20261123-R2 · 设计基准归档
> 状态：草案（2026-11-23）。本目录只归档重冻候选 R2 的**不可变身份指针与 manifest**；详细 spec、ticket 状态、验收矩阵与原始结果以 GitHub Issues 及本地 `.agent-output/` 为准，不在仓库复制。

本目录是 [#152](https://github.com/gbcdby/boardroom/issues/152) 重冻候选 R2 的**设计基准与证据索引**，用于把"重新冻结"落到可核验的 git tree。它不是实现、不是验收通过、不是资格登记、不是三项 S4 命名产物的释放。

## 身份

- 候选 ID：`BR-S4-T2-REFREEZE-20261123-R2`（supersedes `BR-S4-T2-REFREEZE-20261123-R1`，R1 再指向历史 `S4-T2-design-r3`；历史链不改写、不继承其静态 SHA）。
- 状态：`ACCEPTED_DESIGN_BASELINE_FOR_REEVIDENCE`（总控 [书面接受 7086510893](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086510893)）。
- 基线：main `0834f9e56001745d6cfff38f06654a44e944d911` / tree `9b500b69cc8af7e8116443c8469f181205173d6f`。
- 规范性来源（逐字节一致，不在本目录复制）：`S4-T2-design-r3` 设计正文 SHA256 `c3c5ada2cb10f1a84c33bd45cbaf77b898ff04bcb0fd1a2af75117d451147d9f`（43315 B）、接口合同 `12ae676ab06826576e0e45766a3d9e3c747bc4f652c8afd89e90a8be32469d61`（10841 B），与 #152 票面登记指纹相同。
- 新静态身份：本目录 `MANIFEST.json` 以成员真实 bytes/SHA256 另行登记，**不**复用历史 manifest `92f9c613eb82f2d5b0266887e160021a793b8de39963e4a93dab133b783ca372`，也不复用 `MD02.sourceContract` `7e622d40…`。补写会改变静态 SHA，故新候选另起身份。原候选、r2 历史 FAIL 与反例、41 文件冻结包缺失事实原样保留，不改写、不冒充原字节。

## 范围

覆盖单用户 localhost / 无认证前提下、已绑定源的 `planned → quiesced → snapshot_ready` 一致性协议与 `cancel/resume`：SQLite 与 PG16.15 的 fence、drain、journal、备份、隔离恢复校验与幂等。

不转换业务数据、不激活 v2 或首个用户初始化、不改文件正文写入协议、不消费未释放产物、**不启用任何新增受信 server component**；schema 历史状态 `UNASSIGNED`，后续阶段恢复与生产资格保持 `NOT_RUN`。

## 门槛与隔离

16 条与新增受信组件无关的门槛进入承接：G01 三段接口、G02 planned 源绑定、G03 业务表 DML guard、G05 同源互斥、G06 写者枚举与 fail-closed、G07 quiesced 单次 seal、G08 内容寻址 journal、G09 产物耐久发布、G10 SQLite 备份与独立恢复校验、G12 Fs 源清单排除、G13 B 闭包、G14 隔离目标恢复精确校验、G15 snapshot_ready CAS、G16 cancel/resume、G17 五间隙崩溃续跑、G18 幂等令牌。

- 逐条依据、main 落点、补写义务与所需运行证据见本地差距表 `.agent-output/auto-20261123/152-gap-and-refreeze-draft.md` 与重建验收矩阵 `.agent-output/auto-20261123/validation-matrix-reconstructed.md`（均为 `RECONSTRUCTED_NOT_ORIGINAL`，Git 忽略，不在此复制）。
- **矩阵 112 格实测列全部 `NOT_RUN`，0 条门槛可标 PASS。** 静态实现不等于运行通过。

两条 `NOT_RUN / EXCLUDED_BY_USER_DECISION_20261123`（用户 [2026-11-23 否决 7086197702](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7086197702)）：

- **G04**：PG 64 catalog 的 SHARE/SRE `SECURITY DEFINER` helper 安装、owner / ACL、生命周期与资格，全条排除。
- **G11 的 catalog 锁子项**：任何以 `acquire_share()` / `acquire_sre()` 成功取得 64 catalog 锁作为生产成功路径的表述。D1 unsupported 清单（普通 GRANT、C-owned definer/view、READ ONLY 补足、ACCESS SHARE、advisory 锁、两次相等 SELECT、模型假设）不得替代。

不安装、不 GRANT、不签资格、不把 `PROPOSED_DESIGN_NOT_INSTALLED` 写成资格、不把本机或 CI 绿测写成 CAP01 通过。恢复该路径只能由用户明确撤销 2026-11-23 否决，总控不得自行重启。

## 权威记录（状态以 GitHub Issues 为准）

| 内容 | 位置 |
| --- | --- |
| 用户两项决定 | [#153 评论 7086197702](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7086197702) |
| 决定在本票落点 | [#152 评论 7086198252](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086198252) |
| 重冻阶段合同 | [#152 评论 7086260528](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086260528) |
| R1 登记 / R2 接受 | [#152 评论 7086316264](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086316264)、[7086510893](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086510893) |
| 既有运行证据盘点 | [#152 评论 7086570134](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086570134) |
| 验收矩阵重建登记 | [#152 评论 7086636937](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086636937) |
| 原始结果第一 / 二批 | [#152 评论 7086716655](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086716655)、[7086789189](https://github.com/gbcdby/boardroom/issues/152#issuecomment-7086789189) |

三项 S4 命名产物 `S4/storage-maintenance`、`S4/consistent-storage-snapshot`、`S4/migration-plan-journal` 仍共同 `NOT_RELEASED`；整票 #152 仍 `OPEN` / `BLOCKED_BY_ARTIFACTS`。票面 `acceptance_ids` / `blocked_by` / 范围 / 完成条件原样保留，不在此复制。

## 边界

未实测宿主保持 `unsupported/NOT_RUN`；关票仍需单独有效授权；auto 不新增合并 / 发布 / 删除权限；不使用 `Closes #N`。本目录只固定候选身份与证据索引，不降低验收、不放宽断言、不把静态核对或本机绿测写成验收通过。

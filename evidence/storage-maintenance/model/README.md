# C3 控制协议有限模型（AC50）

本目录是 [#152 已接受 C3 设计](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6955824232) §15 / C3-AC50 的 **design/check** 产物，归属见 [模型工作记录](https://github.com/gbcdby/boardroom/issues/152#issuecomment-6955905552)。未进行源码 `align`；`implementation_status=NOT_ASSESSED`，不构成生产资格、真实数据库/文件系统验证、独立审查或 #152 三项产物释放。

2026-11-18 的 r5 检查：16 个有限配置 `PASS_WITHIN_SCOPE`，14 个隔离 mutation 找到指定安全性质反例，6 个否定可达性 probe 找到目标状态。此版修订独立需求审查指出的历史 S/Md 与当前 H 绑定、只读请求结果性质缺口；作者实跑完成，独立复审仍待执行。原 r4（commit `24e63d3`）的 14/12/6 及此前三个 `INCONCLUSIVE` 原件保留，不能用新范围改写旧结论。

## 状态与动作边界

`C3Protocol.tla` 使用两个不同、不可复用的实际 native incarnation `p` / `q`，每个最多一个命令；数据库状态由 `db` 表示，worker/其保留的结果记录由 `w` 表示。operation mutex 与实际 source owner 集合 `sources` 独立。锁丢失不会释放源事务，进程退出也不会把独立 source backend 推断成 rollback。

每个新 source window 重取 facts 和 token。写事务的 `Prepare → Publish → Submit → ActualCommit → Response → CloseSource` 分开：已提交的后端可以在 mutex 丢失或进程退出后实际 COMMIT；响应丢失和 source close unknown 分别失败。unknown 只可由原 owner 的显式 `ConfirmOriginalClose` 解除，没有必然发生的假设。`FinishCleanup / EmitFrame / NormalExit / Reap / Deliver` 也分别建模。

first、takeover、recapture 各用独立事务；bootstrap → staged → registered 需要实际登记提交、成功响应、成功关闭及新窗口读回。cancel intent 与 terminal 独立，terminal 原子 E+1/open/清 active；下一 migration 另做 enter。新的 executor 不继承旧进程的 restore token。D/Md、B/U、V 分三步，必须在同一新窗口完成；guard 受当前 token、factory、window、源锁和 mutex 限定。

`frozen` 是五个 frozen 字段组成的**整体相等 token**；receipt、origin、selected 也使用符号相等值。`RawRows` 是按完整 actor 集合定义的映射，保存模型实际表示的 identity、rowEpoch 和 ended 值，R0 也保存该映射；不再把 row 仅表示为成员集合。`Token` 同时包含模型实际表示的完整 maintenance 控制字段。模型未逐字节表示五字段、16 列 raw row、artifact 编码和文件元数据，其余原生字段与 OID/类型仍须由实现提供真实绑定。`Qualified` / `TypedBinding` 是明确外部前提，两个否定配置检查其为 false 时不产生提交；没有填入真实资格结论。quiesced/ready/pending 初态假设其已有合法历史闭包；planned 配置检查本轮 first/takeover/recapture 建立过程。

首个失败值独立保留；后续失败 payload 合并为 `later-error`，每次出现仍保留一个序列元素，不按值去重。结果记录可以在 executor 死亡后继续接收其独立 backend/cleanup 的结果；这不表示死亡进程继续执行代码。具体错误对象 identity、后续不同 payload 及 IPC 格式仍需真实实现验收。

## 本轮需求审查修订

原独立 REQ 的 `R-C3-MODEL-REQ-001` 指出，r4 的 FinishRead 将当前 H 同时当成归档恢复 token，不能检查历史 S/Md 的完整控制值。r5 增加 `db.selectedControl`：first/recapture 固定其提交后的完整 S token，takeover/ready/intent/terminal 都不能改写它；新 epoch 的 enter 清空本轮 selected，等待新的真实 capture。初始 quiesced/ready/pending 的 S 属于已声明的合法历史前缀假设，固定为对应 quiesced 状态，之后的 ready/intent 只改变 H。

实际三步 restore 完成后分别记录 `restored`（不可变 S/Md）与 `restoredLive`（本次当前 H）；ready 和 guard 都要求二者分别匹配。历史 guard 的真实 reach trace 第18和25态中，S仍为head0/gen1/空rows，而H为head1/gen2/包含p的完整raw row，restore/guard没有把H覆盖进S。归档与当前token是有限等值义务，不是源码私有对象、跨窗口许可或真实restore已获证明。

`R-C3-MODEL-REQ-002` 指出，r4 ExactRequest只约束写history，不能发现只读progress的错误结果。r5在只读窗口保留该次实际head与history观察，独立检查交付progress对应的digest、非空连续suffix、合法操作事件prefix及最初expected epoch/head。性质使用观察快照，之后其他命令的合法变化不会倒改已返回的历史结果。原C4无故障same/conflict切片不删，新增C6/F1的same与conflict切片，确保first提交后进程故障、原source关闭后真正能到达只读返回。

模型修改没有增加fault fairness、删旧性质、缩小原32配置的参与者/提交/故障范围。全部原32配置已在当前模型重跑，其generated/distinct/remaining统计与原r4相同；这只是范围核对，不是源码refinement。两项finding是否VERIFIED由独立复审决定，作者报告不自行关闭。

## 性质与解释边界

所有正常配置启用以下 23 个 invariant。表中的“前提/排除”限制模型结论，不减少原设计要求。

| 性质 | 模型实际检查 | 前提 / 未检查内容 |
| --- | --- | --- |
| `TypeOK` | phase、epoch、owner、row、窗口、历史长度在列明有限域 | 仅列明状态域；不是完整 SQL schema 验证 |
| `SourceExclusive` | 实际 source owner 至多一个 | 原生排他性是实现义务；mutation 去掉它能失败 |
| `DurableAnchors` | 每次写前已有 durable token；ready 绑定 epoch/origin/selected | 文件 flush、目录 durability 与散列算法未验证 |
| `FreshCommit` | 每次写与当前 proof window 相同，单 actor 后续写窗口严格增加 | source window 对真实连接/事务的映射未评估 |
| `ExactRequest` | 写提交来自当前 expected 或已验证本次命令；replay 不写 | 只约束写history；只读返回另由下列Replay性质覆盖 |
| `FrozenOrigin` | receipt 取 planned g；first 固定 origin/frozen/R0；后续保持 | 五字段整体 token；不是逐字段编码证明 |
| `OwnRegistration` | takeover 仅新增实际 actor；ended 的旧 actor 已实际退出 | p/q 不复用；任意 PID 重用、第三 incarnation 未覆盖 |
| `RegisteredAfterCommit` | registered 必须有本人 row、登记响应和 source close | 原子提交及新窗口读回是动作义务，不是源码事实 |
| `CancelBarrier` | intent 后只允许 takeover、terminal、下一 migration enter | 仅本目录 cancel 前缀及有限新 epoch |
| `TerminalAtomic` | terminal 唯一动作同时 E+1/open/清 active，保留 g/rows | 原子 SQL transaction 是实现义务；未建模逐 SQL statement |
| `EpochFence` | 下一 migration 仅从 terminal open 进入并增加 epoch | 最多两次 migration；不是无限 epoch 归纳证明 |
| `GuardScoped` | guard 必须在本进程当前源窗口、锁、registered、ready token 内 | 真实 callback 生命周期、语言闭包未评估 |
| `FailureSticky` | 首错保持原值，有错不能交付成功 | 后续 payload 抽象相同；不验证真实 ExceptionGraph |
| `GatewayCompletion` | 成功结果须 frame、真实 exit、reap、cleanup/source closed、无错 | 具体 stdout/IPC 编码及宿主进程语义未验证 |
| `QualificationGate` | 不合格或 unknown encoding 时历史为空 | 合格性是外部条件，不是模型自动授予能力 |
| `HistoricalR0` | first 的历史 rows 均已实际退出且 row epoch 早于本轮 | next epoch 切片有历史 p；完整 raw 字段用 token 抽象 |
| `IndependentTransactions` | 同 actor 的所有实际 COMMIT 使用严格递增 source window | 真实 BEGIN/COMMIT/source-close 由实现提供 |
| `CompleteRestoreBinding` | ready的archive完整token等于selected S/Md，独立live token等于本次H，并保持frozen/receipt | 覆盖所有已建模控制/row字段；实际16列codec与D/B/U未验证 |
| `FailuresRetained` | 每次注入故障至少对应一个保留错误元素 | 允许同一故障传播再产生诊断；不证明后续对象 identity |
| `SelectedSnapshotImmutable` | 只有first/recapture建立S控制token，后继保留；新epoch清空再capture | 已有合法S的初态是前提，不重建全部历史 |
| `HistoricalRestoreBinding` | restore的归档token与当时S一致，live token与当时H一致 | guard再分别绑定当前S/H；实际restore对象/后端实现未验证 |
| `ReplayExactDigest` | 已交付progress的同key记录digest等于原请求 | 在实际只读观察history上检查，不误用后来全局head |
| `ReplayExactPrefix` | progress来自非空、exact observed head、连续且操作合法的suffix，绑定首条expected epoch/head | 事件prefix有限；任意畸形字节链解析未建模 |

所有安全配置没有 fairness。`CHECK_DEADLOCK FALSE` 是因为 unknown 资源可以永久不返回、有限命令可以终止；没有声称无死锁。单独 `stable-liveness` 使用 `WF_vars(Next)`，只在**无故障、资格成立、串行启动、有限动作图**中检查 `EventuallyBothDelivered`。这不证明故障后的无条件恢复，也没有强制未知进程退出。

## 有限配置矩阵与实测状态

`C` 是最多写提交数；只读事务仍分实际 COMMIT/响应/关闭。`F` 是最多注入故障出现次数，0 表示 `AllowFaults=FALSE`。一次 lost response、提交时 abort、异常/unknown close、mutex loss、crash 或 cleanup error 各消耗一次；由既有失败导致的确定性传播不再消耗。F=1/2 是明确的模型动作预算，**没有使用 `CONSTRAINT`、目标 invariant 假设、symmetry 或 view 裁掉坏状态**。未解决事务/close/进程仍可永久停留。

“串行”仅指 q 等 p 被 reap 再启动；p 的独立 source 仍可能尚未关闭。“并发”允许两个命令交错。每行都检查 COMMIT/响应/close 分离，具体业务交错只以本行为准，不能把各切片拼接为任意组合证明。

| 配置 | 初态及命令 | 启动 / C / F | generated / distinct | 共同覆盖与遗漏 |
| --- | --- | --- | --- | --- |
| `smoke` | planned execute→resume/new | 并发 / 5 / 0 | 891 / 571 | first→takeover→recapture→ready、两 actor；无故障或 cancel |
| `advance-faults` | planned execute→resume/new | 并发 / 6 / 1 | 69,582 / 37,037 | 初次、接管、恢复与一次任意注入故障；无 cancel 命令 |
| `cancel-epoch` | quiesced cancel→execute/new | 串行 / 8 / 0 | 214 / 149 | intent→terminal→下一 epoch→first/接管/ready；无注入故障 |
| `cancel-faults` | quiesced cancel→resume/new | 并发 / 8 / 1 | 40,584 / 21,270 | 两 actor、cancel intent/terminal、新 epoch、一次故障的共同组合 |
| `pending-faults` | 已有 intent 的 quiesced，cancel→resume/new | 串行 / 7 / 1 | 5,968 / 3,773 | pending 恢复到 terminal/下一 epoch，含一次故障；intent 前缀作前提 |
| `ready-faults` | ready guard→resume/new | 串行 / 2 / 1 | 4,892 / 3,314 | ready 新进程、重新 restore/guard、一次故障；已有 ready 闭包作前提 |
| `two-faults` | 已有 intent 的 quiesced，cancel→resume/new | 串行 / 2 / 2 | 22,626 / 13,004 | pending→接管/terminal 短前缀，两故障含首错+cleanup；**不覆盖下一 epoch 完整路径** |
| `guard` | ready guard→resume/new | 串行 / 2 / 0 | 115 / 86 | 新进程 restore 后 guard 与回收；无故障 |
| `same-key` | planned execute→同 key | 串行 / 4 / 0 | 82 / 69 | 健康旧 row 未 ended 时只读 replay 被拒；不证明故障后所有合法 replay |
| `conflict` | planned execute→同 key 不同输入 | 串行 / 4 / 0 | 82 / 69 | input conflict 判定与失败回收；提交预算已满，不单独作为“不能新增提交”的判别证据 |
| `stale` | planned execute→旧 expected 新 key | 串行 / 4 / 0 | 82 / 69 | expected 判定与失败回收；同上，另有 C=5 的有效 stale mutation |
| `unqualified` | planned，Qualified=false | 并发 / 1 / 0 | 114 / 66 | 不合格前提拒绝，未运行真实 qualification |
| `unknown-encoding` | planned，TypedBinding=false | 并发 / 1 / 0 | 114 / 66 | 未知 typed binding 拒绝，未运行真实 decoder |
| `replay-faults` | planned execute→同key | 串行 / 6 / 1 | 4,314 / 2,934 | first已提交后故障，真实只读progress可达；含新digest/head/prefix性质 |
| `replay-conflict-faults` | planned execute→同key不同digest | 串行 / 6 / 1 | 4,144 / 2,804 | 同一可达故障切片，错误digest不能交付progress |
| `stable-liveness` | planned execute→resume/new | 串行 / 5 / 0 | 133 / 103 | 上述稳定环境的有条件活性，额外启用 temporal property |

这 16 行均为完整 BFS、剩余队列 0。每个配置只含两个单次 executor，最多两个 migration；任意更多 actor、更多故障和更长历史未证明。原 r4 的通用 raw manifest 中 `covered_interleavings_and_faults` 是套件功能清单；此表明确其逐配置适用范围。

## 敏感性反例与实现回归输入

所有 `bug-*` 配置通过 `Fault` 及所需有限参数表示隔离错误；正常配置固定 `Fault="none"`。原12个mutation仍检查TypeOK和其指定目标性质，新增两项与正常配置一样启用全部23性质；原6个reach仍只检查对应否定可达性谓词。它们**预期**返回 `COUNTEREXAMPLE`，不是生产协议失败。列出的顺序来自保留的实际 trace，真实业务代码回归为 `NOT_RUN`。

| 配置 → 首次违反性质 | 最短轨迹中的关键顺序 / 需保留的实现断言 | 轨迹状态数 |
| --- | --- | --- |
| `bug-undurable` → `DurableAnchors` | Prepare→绕过 Publish→Submit→ActualCommit；DB 不得指向未 durable 闭包 | 8 |
| `bug-stale` → `ExactRequest` | p 完成、exit/reap 后 q 用旧 expected，放过检查并实际写第 5 次；必须拒绝 | 58 |
| `bug-terminal` → `TerminalAtomic` | intent 后 terminal 只 open、不 E+1/清 active；事务不得分裂终态 | 26 |
| `bug-cancel-advance` → `CancelBarrier` | intent 实际提交后仍 recapture；不得再 advance/ready | 26 |
| `bug-promotion` → `RegisteredAfterCommit` | takeover Submit 后、实际 COMMIT 前 Promote；不得提早 registered | 17 |
| `bug-proof` → `FreshCommit` | first 已关闭，下一事务复用先前窗口 proof；必须 fresh | 17 |
| `bug-guard` → `GuardScoped` | guard 已签发，CloseSource 后仍有效；scope 关闭必须失效 | 29 |
| `bug-gateway` → `GatewayCompletion` | cleanup/frame 后、真实 exit/reap 前 Deliver；gateway 不得提前成功 | 49 |
| `bug-first-error` → `FailureSticky` | Crash 的首错后，原结果记录收到 cleanup error 覆盖首值；首错不得被晚到结果替换 | 4 |
| `bug-source-overlap` → `SourceExclusive` | p 持源→LoseMutex→q 取得 mutex→错误地同时取得源；源 owner 不得重叠 | 8 |
| `bug-foreign-registration` → `OwnRegistration` | p takeover 为 q 写 row；只能登记真实 factory 自身 | 17 |
| `bug-refreeze` → `FrozenOrigin` | first 固定后 recapture 改 frozen；必须保持五字段整体相同 | 26 |
| `bug-restore-current-as-archive` → `HistoricalRestoreBinding` | 历史ready→新owner takeover→三步restore，把H写入archive结果；必须保留原S/Md完整控制值 | 18 |
| `bug-replay-digest` → `ReplayExactDigest` | first实际COMMIT→Crash→原source关闭/reap→同key不同digest只读progress；必须拒绝错误请求结果 | 26 |

`bug-stale-r3` 在 C=4 时曾完成但未找到预期反例，因为 p 已用完提交预算。这是**旧敏感性配置不足**；r4 只把该 mutation 的 C 改为 5，得到上述真实反例，未删除或减弱性质。正常 stale/conflict C=4 配置的限制如上表明示。

六个 `reach-*` 使用否定可达状态的 `Never*` predicate；出现反例表示目标路径可达，不能作为完整安全检查：

| Probe | 目标及实际关键事件 | generated / distinct / trace states |
| --- | --- | --- |
| `reach-ready` | first、takeover、recapture、三步 restore、ready，cleanup/exit/reap 后交付 | 325 / 268 / 51 |
| `reach-cancelled` | intent、terminal，真实 exit/reap 后交付 cancelled | 34 / 33 / 33 |
| `reach-next-epoch` | cancel 已终结，q 新命令实际提交 enter | 58 / 48 / 40 |
| `reach-late-commit` | Submit→LoseMutex→ActualCommit；未把失锁推断成 rollback | 417 / 228 / 10 |
| `reach-same-key` | first 实际 COMMIT→Crash→原 source close/reap；q 同 key 只读 progress | 1,373 / 913 / 26 |
| `reach-guard` | ready 的新进程 takeover/restore 后，在新源窗口使用 guard | 26 / 25 / 25 |

## 复现

工具为官方 `v1.7.4 / TLC 2.19`，JAR SHA-256 为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`；本次 OpenJDK 21.0.13。`worker-tla/scripts/run_tlc.py` 摘要为 `ca5811a8cae5d31961185b0ba53868f3ea885a1ee614150d873d61044ff18f5a`。当前模型 SHA-256 为 `93e570161695354b31663b4376a7c9ba6edf3fb0b558c033e6ddf2ff211f0b06`。

从仓库根目录，在已安装 worker-tla skill、Python 3 和 Java 的环境运行。`worker_tla` 填实际 skill 根目录。第一次下载目标必须尚不存在；网络拒绝时停止并记录，不绕过权限。

```bash
worker_tla=/path/to/worker-tla
python3 "$worker_tla/scripts/fetch_tlc.py" --dest "$PWD/.agent-output/tools/tla2tools.jar"
```

过程 manifest 与日志不提交。以下从持久 cfg 生成新的过程 manifest；配置中的实际 invariant/property 列表、常量和行为声明保留原样，runner 会再次核对。

```bash
python3 - <<'PY'
from pathlib import Path
import json, re
root = Path('evidence/storage-maintenance/model').resolve()
profiles = {}
for cfg in sorted(root.glob('*.cfg')):
    text = cfg.read_text()
    sections = {'INVARIANTS': [], 'PROPERTIES': []}
    section = None
    for line in text.splitlines():
        key = line.strip()
        if key in sections:
            section = key
        elif re.match(r'^[A-Z_]+(?:\s|$)', key):
            section = None
        elif section and key:
            sections[section].append(key)
    profiles[cfg.stem] = {
        'config': cfg.name, 'timeout_seconds': 120, 'workers': 1, 'heap_mb': 1024,
        'expected_invariants': sections['INVARIANTS'],
        'expected_properties': sections['PROPERTIES'], 'checks_deadlock': False,
        'deadlock_reason': 'Unknown resources may remain unresolved; see model README.',
        'scope': {'source': 'README finite configuration matrix', 'config': text},
        'assumptions': ['README state/action/property boundaries; implementation NOT_ASSESSED.']}
manifest = {'schema_version': 1, 'feature': 'C3-AC50 design/check only',
    'tool': {'version': 'v1.7.4 / TLC 2.19',
             'sha256': '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'},
    'model': {'root': '../evidence/storage-maintenance/model', 'entry': 'C3Protocol.tla'},
    'profiles': profiles}
out = Path('.agent-output'); out.mkdir(exist_ok=True)
(out / 'c3-replay-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
python3 "$worker_tla/scripts/run_tlc.py" \
  --manifest .agent-output/c3-replay-manifest.json --profile cancel-faults \
  --jar "$PWD/.agent-output/tools/tla2tools.jar" --out .agent-output/c3-replay-cancel-faults
```

替换 `--profile` 和一个尚不存在的 `--out` 即可复现其他行。正常配置预期退出 0；mutation 和 reach probe 预期退出 2 并有对应性质反例。`result.json`、`tlc.log`、`messages.json`、input/tool 快照和 manifest 原件由 runner 保留。不能只根据进程退出或控制台末行判定通过。

## 原证据及接续边界

当前证据入口为修订工作区 `.agent-output/C3-MODEL-EVIDENCE-r5.json`（SHA256 `d4155781aef8fdf1b3ad87b94581b8d0f0ddfa3a5e0859b43d27790ec8c1b015`），包含每次运行、模型/cfg/tool/runner/result/log 摘要、状态数及完整 trace 位置；每个 `.agent-output/c3-tlc-<profile>-r5/` 保留当前原件；原模型工作区r4文件不动。过程 report/manifest 由交付记录引用，不进入本目录。原始工具输出始终为 `implementation_status=NOT_ASSESSED`。

历史保留：`advance-faults-r1`（60.66 秒）、`advance-faults-r3`（120.97 秒）及 `reach-same-key-r3`（61.38 秒）的未设全局故障次数预算组合均 `INCONCLUSIVE`（它们仍有 actor/提交/cleanup 等有限域）；不能以当前 1/2 次故障配置覆盖其结论。`smoke-r1` 是量词同名导致的 SANY `TOOL_ERROR`，修正语法后重新运行；未把它当协议反例。原r4独立STD仅为artifact范围PASS，REQ为上述两个P2；r5作者已完成有限修订，原REQ reviewer与新的独立STD reviewer尚待复审。新delta作者/root不能复用自己的旧STD来审批本次修改。

实现仍须提供真实 mutex/source ownership、SQL 原子提交、fs durability、fresh facts、全部 raw/frozen/typed bytes、实际 D/B/U/V、native qualification、原 owner cleanup、error identity、gateway IPC/exit 的证据。若增加 actor/restart、超过本次故障预算、拆分原子 transaction、改变 commit/response/close、取消或幂等含义、native 资源规则，或出现模型未含的真实交错，应返回模型扩展检查。本目录没有为这些未知项授予通过，也不承担后续实现/合并调度。

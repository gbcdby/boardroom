# PostgreSQL 固定目录锁组件

状态：已确认。日期：2026-11-20。

本组件提供已确认 H04 模块的固定源码与严格观察值边界，供后继受信维护实现复用。完整设计及释放条件以 [S2-T2 / #153 的 H04 R2 接受记录](https://github.com/gbcdby/boardroom/issues/153#issuecomment-7026910564)为准。本页说明组件的使用范围，不授予安装或连接现有数据库的权限。

## 固定原件

`src/server/storage/maintenance/postgres-catalog-guard/fixed-module.ts` 导出深冻结的 SQL、模块清单、直接依赖清单及两个清单的原始文件摘要。导入不会连接数据库或执行 SQL。

| 导出 | 内容 |
| --- | --- |
| `PG_CATALOG_GUARD_SQL` | `acquire_share` / `acquire_sre` 的准确 CREATE FUNCTION 与 `prosrc` 字节 |
| `PG_CATALOG_GUARD_MODULE` | 准确函数属性、目的对应 ACL、64 个固定目录及成本向量 |
| `PG_CATALOG_GUARD_DEPENDENCIES` | 固定直接语义依赖；保留未取得 native 资格的声明 |
| `PG_CATALOG_GUARD_SOURCE_DIGESTS` | 两份未改清单的完整 SHA-256 |

两份清单保留被接受原件中的 R1 候选名、`PROPOSED_DESIGN_NOT_INSTALLED`、`NOT_RUN` 等历史字段。R2 没有更改这两份原件或 helper 字节；这些字段不是当前测试结果，也不会被导入过程改写成安装事实。

固定 SQL 只适用于 PostgreSQL `server_version_num=160015` 且非 recovery。两函数均为零参数 `SECURITY DEFINER`，在原调用事务中以固定顺序对 64 个目录取得 NOWAIT 锁。函数返回 `void`，不会产生 permit、receipt 或新的事务。成功返回也不证明调用者拥有原生连接、服务 epoch 或完整维护资格。

## 严格观察值

`observation-values.ts` 提供两个纯值入口：

- `parsePgCatalogGuardModuleObservation(text)`：读取单个本地模块观察值。
- `comparePgCatalogGuardModuleObservations(text)`：读取仅含 `source` 与 `target` 的观察值对，检查明确的跨 cluster 模块映射。

输入必须是 primitive JSON 字符串。对象、Buffer、回调、boxed String 都会被拒绝，也不会调用其 getter、`toJSON` 或转换函数。失败仅返回固定错误码 `catalog_guard_module_value_invalid`，不回显原文本。

单个值的固定版本是 `boardroom-pg16-catalog-guard-module-observation-value/v1`。它包含 server version、本地 cluster/database/管理员/caller/namespace/language/function OID 绑定、整个模块 namespace 的对象/注释/标签/扩展/default-ACL 观察，以及两个函数的准确原件和 effective ACL。原始 ACL 为 NULL 时，采集者须先按数据库原生默认规则展开；解析器不猜默认权限。未知字段、重复 JSON 键、错误类型、缺项、非规范 OID、角色或函数别名、任一 body 字节或函数属性变化、额外对象或权限均拒绝。ACL 只按明确 tuple 排序；不规范化函数正文或角色名。

OID 是范围 `1..4294967295` 的无前导零十进制字符串；不同对象 class 的相同数字不自动等同。标识符保留准确 UTF-8 名称，最多 63 字节且没有 NUL。JSON 数值字段只接受安全整数的整数写法，不接受 `-0`、小数或指数写法。文本上限为 16 MiB、嵌套深度 64、节点数 250000；这些仅约束本值解析器，不是数据库操作的新预算。

成功结果深冻结，明确带有：

```json
{
  "classification": "catalog-guard-module-observation-value",
  "executionAdmission": "not-issued",
  "nativeOwnership": "unproven",
  "directDependencyCatalog": "unproven"
}
```

`observation` 携带解析后的值。值内部一致不代表实际数据库上存在这些对象；任何调用者均可构造同形 JSON。组件不把解析结果登记进 native owner 表，不创建连接或 epoch，也不采集完整角色成员链、PL/pgSQL handler/native binary 或 transitive dependency 资格。真实采集和 owner 关联仍须由后继私有工厂完成。

跨 cluster 比较要求 source 为 `source-control`、target 为 `verification-only`、cluster systemIdentifier 不同、管理员名称保持一致。唯一 caller purpose 映射是模块 C → V，目标 V 只有 SHARE 权限。两端动态 OID 可以相同或不同，但每端链接必须准确。入口没有应用行、历史 receipt 或 archive 参数，因此不会改写历史源 OID、应用 owner、数据或函数正文。

## 消费与计费边界

当前组件没有接到 `postgres.ts` 的生产成功路径，没有安装命令、schema migration、provider registry 或 caller 可选的 SQL/预算 hook。既有 P0/M1 模式及普通 B 的只读事务保持各自职责。

后继真实调用必须在原 ledger 中预付 helper 内部的 3 个谓词与 1 个 LOCK utility，原 wire observer 只计外层调用一次，总固定 SQL 上界为 5。64 个 relation 请求不是 64 条 SQL。全部实际目录读回、结果行与字节、监控和清理仍计入原操作，不开新预算或重置成功 deadline。

H04 R2 的目标恢复后验仍需要同一真实 V：工具退出后重新开始 RC/RW，首查询为固定 SHARE，完整目录保护与全部 72 张应用表 AX、真实 writer/sequence 排他成立后才进行 fresh RC 完整比较。纯值组件不实现这一程序，不复用旧 RR/RO 后验来冒充它。

## 组件验证

纯值与固定原件测试：

```sh
node --test tests/maintenance-postgres-catalog-guard.test.ts
```

真实机制测试只使用已明确提供的私有 PG 16.15 工具路径：

```sh
AGENT_STUDIO_PG_RESTART_BIN=/absolute/private/usr/lib/postgresql/16/bin \
  node --test tests/maintenance-postgres-catalog-guard-native.test.ts
```

该测试自行 `initdb`、启动真实 postgres child，在唯一临时 data directory、localhost 临时端口和自有测试角色中创建两份固定模块。它核对准确版本、实际目录和 cluster 身份，检查真实 `pg_proc` / ACL、C 与 B/V 权限边界、void 返回、64 锁、事务模式、NOWAIT 和 SAVEPOINT/ROLLBACK。结束时确认实际子进程退出后清理自己的临时目录。

未配置工具路径时明确 skip；显式配置但程序缺失或不是 16.15 时失败。测试不读取外部 PG URL，也不连接 CI 的主 16.16 service。隔离 fixture 的 trust 认证、同一 cluster 内两个测试数据库只支持上述机制用例，不证明生产 server epoch、完整 CAP01/PD-O04、不同 cluster 的完整恢复或 R2 后验资格。真实结果由本次固定候选的测试记录说明，不能由源码中的测试存在推导 PASS。

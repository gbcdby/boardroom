/**
 * 持久化驱动抽象与连接工厂（F1 #46）。
 *
 * 目标：SQLite 与 PostgreSQL 双驱动可经配置切换（`dbDriver`，默认 SQLite），
 * 阶段 1 既有行为不回归。业务仓储经本文件的 DbDriver 抽象访问持久化
 * （#61），不再直接持有 SQLite 句柄；全量切 PG 与数据迁移由 M1（#54）完成；
 * 本层是 #61 的落点与回滚开关（改配置切回 sqlite 即回滚）。
 *
 * Seam：本文件的 DbDriver 接口 + createDbDriver 工厂（ticket #46 确认的测试 seam）。
 */
import type { DbDriverKind } from "../config.ts";
import { ConfigError } from "../config.ts";
import type { AppliedMigration, Migration, MigrationRunResult } from "./migrate.ts";
import type { SqlDialect } from "./dialect.ts";
import { createSqliteDriver } from "./drivers/sqlite.ts";
import { createPostgresDriver } from "./drivers/postgres.ts";

/** 一次查询的行结果。 */
export type DbRow = Record<string, unknown>;

/** 同一物理事务（含 SAVEPOINT）共享的内部状态；事务结束后不可继续使用。 */
export interface DbTransactionContext { readonly values: Map<symbol, unknown> }

/** 事务会话：事务内的语句只在事务可见范围内生效。 */
export interface DbTransaction {
  /** 读取查询；参数使用统一 `?` 占位符。 */
  query<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * 执行语句（DDL/DML），不返回行；返回值为影响行数（与 SQLite `changes` 对齐，
   * 便于仓储层保留 `result.changes === 0` 这类「写未命中」判定）。
   */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
}

/** 持久化驱动公共接口：connect → migrate → query/transaction → close。 */
export interface DbDriver {
  readonly kind: DbDriverKind;
  /** 本方言的 SQL 差异面（占位符、事务语句、类型映射、基线 DDL）。 */
  readonly dialect: SqlDialect;
  /** 仅当前异步事务链可见；嵌套仓储/工厂不能各自生成另一份锁集合。 */
  currentTransactionContext(): DbTransactionContext | undefined;
  /** 建立并验证连接（SQLite 打开文件；PG 建立连接池并握手）。幂等。 */
  connect(): Promise<void>;
  /** 按版本升序执行未应用的迁移；定义校验与 checksum 跨方言一致。 */
  migrate(migrations: readonly Migration[]): Promise<MigrationRunResult>;
  /** 读取当前迁移版本与已应用记录。 */
  migrationState(): Promise<{ version: number; applied: AppliedMigration[] }>;
  /** 读取查询；参数使用统一 `?` 占位符，由方言渲染。 */
  query<T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /**
   * 执行语句（DDL/DML），不返回行；返回值为影响行数（与 SQLite `changes` 对齐）。
   * 多语句迁移由 migrate() 内部处理，本方法面向仓储层的单语句读写。
   */
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  /** 单个写事务：fn  reject 即整体回滚并向上抛出。支持 SAVEPOINT 嵌套（#61）。 */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
  /** 关闭连接/连接池。未连接或已关闭时静默返回（幂等）。 */
  close(): Promise<void>;
}

/** 连接工厂入参（来自 AppConfig 的持久化相关子集）。 */
export interface DbDriverOptions {
  /** 缺省即 sqlite（DEFAULT_DB_DRIVER），兼容既有配置对象。 */
  readonly dbDriver?: DbDriverKind;
  /** SQLite 数据目录；dbDriver=sqlite 时必须。 */
  readonly dataDir?: string;
  /** PostgreSQL 连接串；dbDriver=postgres 时必须。 */
  readonly pgConnectionString?: string;
  /**
   * PG 专用：连接后创建并锁定到该 schema（SET search_path）。
   * 用于冒烟测试与未来多库共用实例的隔离；缺省不动 search_path。
   */
  readonly pgSchema?: string;
}

/** 连接/驱动层运行错误；message 面向用户，包含恢复路径（NFR-PROJ-05）。 */
export class DriverConnectionError extends Error {
  override readonly name = "DriverConnectionError";
}

/**
 * 连接工厂：按配置产出对应驱动实例（不触发网络/文件 IO）。
 *
 * - `sqlite`（默认）：阶段 1 行为，打开 dataDir 下的 agent-studio.db。
 * - `postgres`：需要 pgConnectionString；缺省时报 ConfigError 并给出配置指引。
 */
export function createDbDriver(options: DbDriverOptions): DbDriver {
  const kind = options.dbDriver ?? "sqlite";
  if (kind === "sqlite") {
    if (options.dataDir === undefined || options.dataDir.trim() === "") {
      throw new ConfigError(
        "dbDriver=sqlite 需要 dataDir。请设置 AGENT_STUDIO_DATA_DIR 或配置文件中的 dataDir 字段。",
      );
    }
    return createSqliteDriver({ dataDir: options.dataDir });
  }
  if (options.pgConnectionString === undefined || options.pgConnectionString.trim() === "") {
    throw new ConfigError(
      "dbDriver=postgres 但缺少 PG 连接串。请设置 AGENT_STUDIO_PG_CONNECTION_STRING " +
        "postgres://user:password@host:port/database 或配置文件中的 pgConnectionString 字段。",
    );
  }
  return createPostgresDriver({
    connectionString: options.pgConnectionString,
    ...(options.pgSchema === undefined ? {} : { schema: options.pgSchema }),
  });
}

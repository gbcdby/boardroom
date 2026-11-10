/**
 * PostgreSQL 驱动（F1 #46）：基于 node-postgres 连接池的
 * connect/migrate/query/transaction 接入与方言抽象落点。
 *
 * 边界（务必保持诚实）：阶段 1 业务仓储仍以 SQLite 为准，本驱动只提供
 * 驱动层能力与迁移版本表基线；业务表按方言重写、既有数据搬迁与回滚脚本
 * 属于 M1（#54）。
 */
import { Pool, type PoolClient, type QueryResult } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { OperationQueue } from "../operation-queue.ts";
import {
  MIGRATION_TABLE,
  MigrationError,
  checksumOf,
  migrationSql,
  validateAndSort,
  type AppliedMigration,
  type Migration,
  type MigrationRunResult,
} from "../migrate.ts";
import { postgresDialect } from "../dialect.ts";
import { DriverConnectionError, type DbDriver, type DbRow, type DbTransaction } from "../driver.ts";

export interface PostgresDriverOptions {
  readonly connectionString: string;
  /** 连接后创建并锁定到的 schema（经启动参数 options 设 search_path）。 */
  readonly schema?: string;
}

/** 合法 schema 标识符：仅字母数字下划线，且不以数字开头。 */
const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PostgresDriver implements DbDriver {
  readonly kind = "postgres" as const;
  readonly dialect = postgresDialect;

  private readonly connectionString: string;
  private readonly schema: string | undefined;
  private pool: Pool | null = null;
  /** 按异步调用链绑定连接；不相关请求不能共享另一个事务的客户端。 */
  private readonly transactionScope = new AsyncLocalStorage<{ client: PoolClient; queue: OperationQueue }>();
  /** SAVEPOINT 计数器。 */
  private spCounter = 0;

  constructor(options: PostgresDriverOptions) {
    this.connectionString = options.connectionString;
    this.schema = options.schema;
    if (this.schema !== undefined && !SCHEMA_IDENTIFIER.test(this.schema)) {
      throw new DriverConnectionError(
        `PG schema 名 "${this.schema}" 不是合法标识符（仅允许字母、数字、下划线，不能以数字开头）。`,
      );
    }
  }

  async connect(): Promise<void> {
    if (this.pool !== null) return;
    const pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      connectionTimeoutMillis: 5_000,
      ...(this.schema === undefined
        ? {}
        : { options: `-c search_path=${this.schema}` }),
    });
    pool.on("error", () => {
      // 空闲连接错误已由后续查询向调用方传播；此处只防止进程级 unhandled error。
    });
    this.pool = pool;
    try {
      await pool.query("SELECT 1");
      if (this.schema !== undefined) {
        // search_path 指向的 schema 必须先存在，否则后续 DDL 全部失败。
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema()}`);
      }
    } catch (error) {
      await pool.end().catch(() => {});
      this.pool = null;
      throw new DriverConnectionError(
        `无法连接 PostgreSQL（${this.sanitizedConnectionString()}）：${this.sanitize(errorText(error))}。` +
          `请确认数据库服务已启动、AGENT_STUDIO_PG_CONNECTION_STRING 与权限配置正确；` +
          `回滚方式：保持/改回 AGENT_STUDIO_DB_DRIVER=sqlite 即恢复阶段 1 行为。`,
      );
    }
  }

  /**
   * 执行未应用的迁移：与 SQLite 运行器同一套定义校验、checksum 与版本语义，
   * SQL 经方言渲染（迁移期保留回滚路径：配置切回 sqlite，PG 数据不受影响即回滚）。
   */
  async migrate(migrations: readonly Migration[]): Promise<MigrationRunResult> {
    const ordered = validateAndSort(migrations);
    const pool = this.requirePool();
    await pool.query(this.dialect.migrationTableDdl());

    const applied = new Map<number, AppliedMigration>();
    for (const row of await this.readAppliedMigrations()) {
      applied.set(row.version, row);
    }

    for (const migration of ordered) {
      const existing = applied.get(migration.version);
      const checksum = checksumOf(migrationSql(migration, "postgres"));
      if (existing !== undefined && existing.checksum !== checksum) {
        throw new MigrationError(
          `迁移 ${migration.version} "${migration.name}" 已应用，但 SQL 内容与当前代码不一致` +
            `（checksum ${existing.checksum} → ${checksum}）。` +
            `已应用的迁移不可修改；请新增一条迁移。`,
        );
      }
    }

    const newlyApplied: Migration[] = [];
    for (const migration of ordered) {
      if (applied.has(migration.version)) continue;
      await this.applyOne(migration);
      newlyApplied.push(migration);
    }
    const state = await this.migrationState();
    return { applied: newlyApplied, version: state.version };
  }

  async migrationState(): Promise<{ version: number; applied: AppliedMigration[] }> {
    const rows = await this.readAppliedMigrations();
    const highest = rows.reduce((max, row) => Math.max(max, row.version), 0);
    return { version: highest, applied: rows };
  }

  async query<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const scope = this.transactionScope.getStore();
    const execute = () => (scope?.client ?? this.requirePool()).query(this.dialect.renderParameters(sql), [...params]);
    const result = await (scope ? scope.queue.run(execute) : execute());
    return result.rows as T[];
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const scope = this.transactionScope.getStore();
    const execute = () => (scope?.client ?? this.requirePool()).query(this.dialect.renderParameters(sql), [...params]);
    const result = await (scope ? scope.queue.run(execute) : execute());
    return result.rowCount ?? 0;
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    // 真正的嵌套调用复用当前异步上下文客户端；独立请求各自向池取连接。
    // 并行兄弟子事务在父队列中串行，不能让一方回滚覆盖另一方的 SAVEPOINT。
    const parent = this.transactionScope.getStore();
    if (parent) return parent.queue.run(() => this.runTransaction(fn, parent.client, parent.queue));
    const client = await this.requirePool().connect();
    try { return await this.runTransaction(fn, client); }
    finally { client.release(); }
  }

  private async runTransaction<T>(fn: (tx: DbTransaction) => Promise<T>, client: PoolClient, parent?: OperationQueue): Promise<T> {
    const nested = parent !== undefined;
    const queue = new OperationQueue(parent);
    const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
      const current = this.transactionScope.getStore()?.queue;
      return (current?.isWithin(queue) ? current : queue).run(operation);
    };
    const render = (sql: string): string => this.dialect.renderParameters(sql);
    const sp = nested ? `s${++this.spCounter}` : null;
    const tx: DbTransaction = {
      query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) =>
        enqueue(async () => (await client.query(render(sql), [...params])).rows as R[]),
      // 事务内 exec：返回影响行数（与 SQLite `changes` 对齐，#61）。
      exec: async (sql, params: readonly unknown[] = []) => enqueue(async () => {
        const r = await client.query(render(sql), [...params]);
        return r.rowCount ?? 0;
      }),
    };
    try {
      if (nested) await client.query(`SAVEPOINT ${sp}`);
      else await client.query(this.dialect.beginTransaction());
      const scope = { client, queue };
      try {
        const result = await this.transactionScope.run(scope, () => fn(tx));
        await queue.drain();
        if (nested) await client.query(`RELEASE SAVEPOINT ${sp}`);
        else await client.query(this.dialect.commit());
        return result;
      } catch (error) {
        await queue.drain();
        try {
          if (nested) {
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            await client.query(`RELEASE SAVEPOINT ${sp}`);
          }
          else await client.query(this.dialect.rollback());
        } catch {
          // 事务可能已因错误终止；保留原始错误。
        }
        throw error;
      }
    } finally {
      queue.close();
    }
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool !== null) {
      await pool.end().catch(() => {});
    }
  }

  private async applyOne(migration: Migration): Promise<void> {
    const client = await this.requirePool().connect();
    const upSql = migrationSql(migration, "postgres");
    try {
      await client.query(this.dialect.beginTransaction());
      await client.query(upSql); // 迁移脚本为无参多语句，走简单查询协议
      await client.query(
        this.dialect.renderParameters(
          `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        ),
        [migration.version, migration.name, checksumOf(upSql), new Date().toISOString()],
      );
      await client.query(this.dialect.commit());
    } catch (error) {
      try {
        await client.query(this.dialect.rollback());
      } catch {
        // 事务可能已因错误终止；保留原始错误。
      }
      throw new MigrationError(
        `迁移 ${migration.version} "${migration.name}" 执行失败：${errorText(error)}。` +
          `该迁移已整体回滚，数据库版本仍为上一个成功版本。`,
      );
    } finally {
      client.release();
    }
  }

  private async readAppliedMigrations(): Promise<AppliedMigration[]> {
    const result: QueryResult = await this.requirePool().query(
      `SELECT version, name, checksum, applied_at FROM ${MIGRATION_TABLE} ORDER BY version`,
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      version: Number(row["version"]),
      name: String(row["name"]),
      checksum: String(row["checksum"]),
      appliedAt:
        row["applied_at"] instanceof Date ? row["applied_at"].toISOString() : String(row["applied_at"]),
    }));
  }

  private requirePool(): Pool {
    if (this.pool === null) {
      throw new DriverConnectionError("PostgreSQL 驱动尚未 connect()，无法执行查询。");
    }
    return this.pool;
  }

  private quotedSchema(): string {
    return `"${this.schema as string}"`;
  }

  /** 连接串脱敏：URL 形式隐去口令，key=value 形式同样处理。 */
  private sanitizedConnectionString(): string {
    try {
      const url = new URL(this.connectionString);
      if (url.password !== "") url.password = "***";
      if (url.username !== "") url.username = "***";
      return url.toString();
    } catch {
      return this.connectionString.replace(/(password=)(\S+)/gi, "$1***");
    }
  }

  /** 错误文本脱敏：连接串里能解析出口令时，从文本中抹掉。 */
  private sanitize(text: string): string {
    let out = text;
    try {
      const url = new URL(this.connectionString);
      if (url.password !== "") out = out.split(url.password).join("***");
    } catch {
      const match = /password=(\S+)/i.exec(this.connectionString);
      const password = match?.[1];
      if (password !== undefined) out = out.split(password).join("***");
    }
    return out;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPostgresDriver(options: PostgresDriverOptions): PostgresDriver {
  return new PostgresDriver(options);
}

/**
 * SQLite 驱动（F1 #46）：包装阶段 1 既有的 openDatabase/runMigrations，
 * 对外提供 DbDriver 接口；`handle` 暴露 better-sqlite3 连接，
 * 让既有 repository/HTTP/MCP 调用点在 M1 迁移前保持不变。
 */
import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { OperationQueue } from "../operation-queue.ts";
import { openDatabase } from "../database.ts";
import {
  readMigrationState,
  runMigrations,
  type AppliedMigration,
  type Migration,
  type MigrationRunResult,
} from "../migrate.ts";
import { sqliteDialect } from "../dialect.ts";
import type { DbDriver, DbRow, DbTransaction, DbTransactionContext } from "../driver.ts";

export interface SqliteDriverOptions {
  readonly dataDir: string;
}

export class SqliteDriver implements DbDriver {
  readonly kind = "sqlite" as const;
  readonly dialect = sqliteDialect;

  private readonly dataDir: string;
  private opened: { db: Database.Database; file: string } | null = null;
  /** SAVEPOINT 计数器：用于嵌套事务（事务内再开事务，#61）。 */
  private spCounter = 0;
  private readonly transactionScope = new AsyncLocalStorage<OperationQueue>();
  private readonly transactionIdentity = new AsyncLocalStorage<DbTransactionContext & { active: boolean }>();
  private readonly operations = new OperationQueue();

  /** 单连接顶层操作排队；只有同一异步调用链中的操作才属于嵌套事务。 */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return (this.transactionScope.getStore() ?? this.operations).run(operation);
  }

  constructor(options: SqliteDriverOptions) {
    this.dataDir = options.dataDir;
  }

  currentTransactionContext(): DbTransactionContext | undefined {
    const context = this.transactionIdentity.getStore();
    return context?.active ? context : undefined;
  }

  /** better-sqlite3 连接句柄（阶段 1 调用点继续使用）；须先 connect()。 */
  get handle(): Database.Database {
    if (this.opened === null) {
      throw new Error("SqliteDriver 尚未 connect()，不能取用 handle。");
    }
    return this.opened.db;
  }

  /** 数据库文件绝对路径；须先 connect()。 */
  get file(): string {
    if (this.opened === null) {
      throw new Error("SqliteDriver 尚未 connect()，不能取用 file。");
    }
    return this.opened.file;
  }

  async connect(): Promise<void> {
    if (this.opened !== null) return;
    // openDatabase 抛 DatabaseSetupError（含恢复路径），原样向上传播。
    this.opened = openDatabase(this.dataDir);
  }

  async migrate(migrations: readonly Migration[]): Promise<MigrationRunResult> {
    return runMigrations(this.handle, migrations);
  }

  async migrationState(): Promise<{ version: number; applied: AppliedMigration[] }> {
    const state = readMigrationState(this.handle);
    return { version: state.version, applied: [...state.applied] };
  }

  async query<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.serialize(async () => this.handle.prepare(sql).all(...params) as T[]);
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    // DbDriver.exec 是单语句接口：无参数的 DML 也必须返回真实顶层 changes。
    // prepare 同时在执行前拒绝多语句；迁移仍由 runMigrations 使用原生 exec。
    return this.serialize(async () => this.handle.prepare(sql).run(...params).changes);
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const parent = this.transactionScope.getStore();
    return this.serialize(() => this.runTransaction(fn, parent));
  }

  private async runTransaction<T>(fn: (tx: DbTransaction) => Promise<T>, parent?: OperationQueue): Promise<T> {
    const db = this.handle;
    const nested = parent !== undefined;
    const identity = this.transactionIdentity.getStore() ?? { values: new Map<symbol, unknown>(), active: true };
    const savedValues = nested ? new Map(identity.values) : undefined;
    const scope = new OperationQueue(parent);
    const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
      const current = this.transactionScope.getStore();
      return (current?.isWithin(scope) ? current : scope).run(operation);
    };
    const tx: DbTransaction = {
      query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) =>
        enqueue(async () => db.prepare(sql).all(...params) as R[]),
      // 事务内 exec：返回影响行数，与 SQLite `changes` 对齐（#61）。
      exec: async (sql, params: readonly unknown[] = []) =>
        enqueue(async () => db.prepare(sql).run(...params).changes),
    };
    // 嵌套事务（事务内再开事务，#61）用 SAVEPOINT 实现，回滚时只回到保存点，
    // 不影响外层；非嵌套走阶段 1 的 BEGIN IMMEDIATE 语义。
    const sp = nested ? `s${++this.spCounter}` : null;
    if (nested) db.exec(`SAVEPOINT ${sp}`);
    else db.exec(this.dialect.beginTransaction());
    try {
      const result = await this.transactionIdentity.run(identity, () => this.transactionScope.run(scope, () => fn(tx)));
      await scope.drain();
      if (nested) db.exec(`RELEASE SAVEPOINT ${sp}`);
      else db.exec(this.dialect.commit());
      return result;
    } catch (error) {
      await scope.drain();
      try {
        if (nested) {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          // 数据和在保存点内取得的锁一同回滚；不能继续复用其锁范围元数据。
          // 仅恢复保存点前的条目，保留父事务原本已持有的 scope。
          identity.values.clear();
          for (const [key, value] of savedValues!) identity.values.set(key, value);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
        } else {
          db.exec(this.dialect.rollback());
        }
      } catch {
        // 事务可能已因错误终止，回滚语句本身失败时保留原始错误。
      }
      throw error;
    } finally {
      scope.close();
      if (!nested) identity.active = false;
    }
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      if (this.opened !== null && this.opened.db.open) this.opened.db.close();
      this.opened = null;
    });
  }
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  return new SqliteDriver(options);
}

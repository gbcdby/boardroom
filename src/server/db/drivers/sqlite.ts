/**
 * SQLite 驱动（F1 #46）：包装阶段 1 既有的 openDatabase/runMigrations，
 * 对外提供 DbDriver 接口；`handle` 暴露 better-sqlite3 连接，
 * 让既有 repository/HTTP/MCP 调用点在 M1 迁移前保持不变。
 */
import type Database from "better-sqlite3";
import { openDatabase } from "../database.ts";
import {
  readMigrationState,
  runMigrations,
  type AppliedMigration,
  type Migration,
  type MigrationRunResult,
} from "../migrate.ts";
import { sqliteDialect } from "../dialect.ts";
import type { DbDriver, DbRow, DbTransaction } from "../driver.ts";

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

  constructor(options: SqliteDriverOptions) {
    this.dataDir = options.dataDir;
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
    return this.handle.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    if (params.length === 0) {
      this.handle.exec(sql);
      return 0;
    }
    return this.handle.prepare(sql).run(...params).changes;
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    const db = this.handle;
    const tx: DbTransaction = {
      query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) =>
        db.prepare(sql).all(...params) as R[],
      // 事务内 exec：返回影响行数，与 SQLite `changes` 对齐（#61）。
      exec: async (sql, params: readonly unknown[] = []) => {
        if (params.length === 0) {
          db.exec(sql);
          return 0;
        }
        return db.prepare(sql).run(...params).changes;
      },
    };
    // 嵌套事务（事务内再开事务，#61）用 SAVEPOINT 实现，回滚时只回到保存点，
    // 不影响外层；非嵌套走阶段 1 的 BEGIN IMMEDIATE 语义。
    const nested = db.inTransaction;
    const sp = nested ? `s${++this.spCounter}` : null;
    if (nested) db.exec(`SAVEPOINT ${sp}`);
    else db.exec(this.dialect.beginTransaction());
    try {
      const result = await fn(tx);
      if (nested) db.exec(`RELEASE SAVEPOINT ${sp}`);
      else db.exec(this.dialect.commit());
      return result;
    } catch (error) {
      try {
        if (nested) {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
        } else {
          db.exec(this.dialect.rollback());
        }
      } catch {
        // 事务可能已因错误终止，回滚语句本身失败时保留原始错误。
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.opened !== null && this.opened.db.open) {
      this.opened.db.close();
    }
    this.opened = null;
  }
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  return new SqliteDriver(options);
}

/**
 * SQLite 驱动（F1 #46）：包装阶段 1 既有的 openDatabase/runMigrations，
 * 对外提供 DbDriver 接口；`handle` 暴露 better-sqlite3 连接，
 * 让既有 repository/HTTP/MCP 调用点在 M1 迁移前保持不变。
 */
import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { OperationQueue } from "../operation-queue.ts";
import { openDatabase, DatabaseSetupError, probeReadWrite, DATABASE_FILE_NAME } from "../database.ts";
import { assertSqliteSingleLink, assertSqliteSourceUnchanged, type SqliteDatabaseDescriptor } from "../../environment.ts";
import { ConfigError } from "../../config-error.ts";
import {
  readMigrationState,
  runMigrations,
  type AppliedMigration,
  type Migration,
  type MigrationRunResult,
} from "../migrate.ts";
import { sqliteDialect } from "../dialect.ts";
import type { DbDriver, DbRow, DbTransaction, DbTransactionContext } from "../driver.ts";
import { assertSqliteStartupAdmission } from "../../storage/sqlite-startup.ts";
import { assertStorageAdmission, readSqliteMaintenanceState, StorageMaintenanceError,
  type StorageAdmissionIdentity } from "../../storage/admission.ts";
import { storageDrainClientToCheck, assertStorageDrainClient } from "../../storage/drain-boundary.ts";

export interface SqliteDriverOptions {
  readonly dataDir: string;
  readonly sqlitePath?: string;
  readonly sqliteSource?: SqliteDatabaseDescriptor;
}

export class SqliteDriver implements DbDriver {
  readonly kind = "sqlite" as const;
  readonly dialect = sqliteDialect;

  private readonly dataDir: string;
  private readonly sqlitePath: string | undefined;
  private readonly sqliteSource: SqliteDatabaseDescriptor | undefined;
  private opened: { db: Database.Database; file: string } | null = null;
  private admissionIdentity: StorageAdmissionIdentity | undefined;
  private fileIdentity: {dev:bigint;ino:bigint} | undefined;
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
    this.sqlitePath = options.sqlitePath;
    this.sqliteSource = options.sqliteSource;
    if ((this.sqlitePath !== undefined && !path.isAbsolute(this.sqlitePath)) ||
      (this.sqliteSource && this.sqliteSource.sqlitePath !== this.sqlitePath)) throw new ConfigError("SQLite descriptor 的规范文件路径不一致。");
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
    if (this.sqliteSource) assertSqliteSourceUnchanged(this.sqliteSource, true);
    else assertSqliteSingleLink(this.sqlitePath ?? path.resolve(this.dataDir, DATABASE_FILE_NAME));
    if (this.sqlitePath === undefined) {
      this.opened = openDatabase(this.dataDir);
      this.fileIdentity = statSync(this.opened.file,{bigint:true});
      this.checkAdmission();
      return;
    }
    let db: Database.Database | undefined;
    try {
      assertSqliteStartupAdmission(this.sqlitePath);
      if (!this.sqliteSource?.identity) mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
      // 已存在源不得触发 CREATE；先核实 inode，再允许任何 pragma/迁移写入。
      db = new Database(this.sqlitePath, { fileMustExist: this.sqliteSource?.identity != null });
      if (this.sqliteSource?.identity) assertSqliteSourceUnchanged(this.sqliteSource, true);
      else assertSqliteSingleLink(this.sqlitePath);
      assertStorageAdmission(readSqliteMaintenanceState(db));
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      probeReadWrite(db);
      this.opened = { db, file: this.sqlitePath };
      this.fileIdentity = statSync(this.sqlitePath,{bigint:true});
      this.checkAdmission();
    } catch (error) {
      db?.close();
      if (error instanceof ConfigError) throw error;
      throw new DatabaseSetupError(`无法打开已解析的 SQLite 数据源（${(error as NodeJS.ErrnoException).code ?? "unknown"}）。请检查原文件与实际父目录权限后重试。`);
    }
  }

  async migrate(migrations: readonly Migration[]): Promise<MigrationRunResult> {
    return this.serialize(async () => {
      this.checkAdmission();
      const result=runMigrations(this.handle, migrations);
      this.checkAdmission();
      return result;
    });
  }

  async migrationState(): Promise<{ version: number; applied: AppliedMigration[] }> {
    const state = readMigrationState(this.handle);
    return { version: state.version, applied: [...state.applied] };
  }

  async query<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.serialize(async () => {
      const statement=this.handle.prepare(sql);
      // SQLite checkpoint cannot run inside a transaction. This exact connection-control
      // operation moves already committed WAL pages only; it never admits business SQL.
      // It is serialized with this client's work, checked before execution, and real
      // checkpoint locks remain visible to the maintenance physical-lock check.
      if (/^\s*PRAGMA\s+wal_checkpoint\s*\(\s*(?:PASSIVE|FULL|RESTART|TRUNCATE)\s*\)\s*;?\s*$/i.test(sql)) {
        this.checkAdmission();
        return statement.all(...params) as T[];
      }
      // Native metadata, not SQL-prefix guessing. RETURNING/CTE writes require real transaction admission.
      if (statement.readonly || this.currentTransactionContext()) return statement.all(...params) as T[];
      return this.runTransaction(async tx => tx.query<T>(sql,params));
    });
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    // DbDriver.exec 是单语句接口：无参数的 DML 也必须返回真实顶层 changes。
    // prepare 同时在执行前拒绝多语句；迁移仍由 runMigrations 使用原生 exec。
    return this.serialize(async () => {
      const statement=this.handle.prepare(sql);
      if (this.currentTransactionContext()) return statement.run(...params).changes;
      if (statement.readonly) {this.checkAdmission();return statement.run(...params).changes;}
      return this.runTransaction(async tx => tx.exec(sql,params));
    });
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
      if (!nested) this.checkAdmission();
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
      this.admissionIdentity = undefined;
      this.fileIdentity = undefined;
    });
  }

  private checkAdmission(): void {
    if (this.sqliteSource?.identity) assertSqliteSourceUnchanged(this.sqliteSource,true);
    const identity=statSync(this.file,{bigint:true});
    if (this.fileIdentity && (identity.dev!==this.fileIdentity.dev || identity.ino!==this.fileIdentity.ino || identity.nlink!==1n))
      throw new StorageMaintenanceError("metadata_invalid");
    const state=readSqliteMaintenanceState(this.handle,this.admissionIdentity!==undefined);
    const cleanupClient=storageDrainClientToCheck(this,state,this.admissionIdentity);
    if (cleanupClient) assertStorageDrainClient(this.handle.prepare("SELECT * FROM storage_source_clients WHERE client_id=?").get(cleanupClient) as Record<string,unknown>|undefined,state!,this.admissionIdentity!);
    else assertStorageAdmission(state,this.admissionIdentity);
    if (state && !this.admissionIdentity) this.admissionIdentity={databaseInstanceId:state.databaseInstanceId,fenceEpoch:state.fenceEpoch};
  }
}

export function createSqliteDriver(options: SqliteDriverOptions): SqliteDriver {
  return new SqliteDriver(options);
}

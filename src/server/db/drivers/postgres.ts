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
import { commitCallbacks, runCommitCallbacks, type CommitCallback } from "../after-commit.ts";
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
import { DriverConnectionError, type DbDriver, type DbDriverOptions, type DbReadSnapshot, type DbRow, type DbTransaction, type DbTransactionContext } from "../driver.ts";
import { assertStorageAdmission, readPostgresMaintenanceState, StorageMaintenanceError, type StorageAdmissionIdentity } from "../../storage/admission.ts";
import { assertPostgresGuardCoverage, extendPostgresStorageGuards } from "../../storage/schema-guards.ts";
import { storageDrainClientToCheck, assertStorageDrainClient } from "../../storage/drain-boundary.ts";
import { withM1Cleanup } from "../m1-resources.ts";

interface M1PinnedConnection {
  readonly client: PoolClient;
  readonly queue: OperationQueue;
  active: boolean;
  failed?: unknown;
  check?: (read: DbReadSnapshot) => Promise<void>;
}

export interface PostgresDriverOptions {
  readonly initializationOnConnect?: "normal" | "none";
  readonly connectionString: string;
  /** 连接后创建并锁定到的 schema（经启动参数 options 设 search_path）。 */
  readonly schema?: string;
}

/** 合法 schema 标识符：仅字母数字下划线，且不以数字开头。 */
const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PostgresDriver implements DbDriver {
  readonly kind = "postgres" as const;
  readonly dialect = postgresDialect;
  readonly initializationOnConnect: "normal" | "none";

  private readonly connectionString: string;
  private readonly schema: string | undefined;
  private pool: Pool | null = null;
  private admissionIdentity: StorageAdmissionIdentity | undefined;
  /** 按异步调用链绑定连接；不相关请求不能共享另一个事务的客户端。 */
  private readonly transactionScope = new AsyncLocalStorage<{ client: PoolClient; queue: OperationQueue }>();
  private readonly transactionIdentity = new AsyncLocalStorage<DbTransactionContext & { active: boolean }>();
  /** SAVEPOINT 计数器。 */
  private spCounter = 0;
  private readonly m1Pin = new AsyncLocalStorage<M1PinnedConnection>();
  private m1PinActive = false;

  constructor(options: PostgresDriverOptions) {
    this.initializationOnConnect = options.initializationOnConnect ?? "normal";
    this.connectionString = options.connectionString;
    this.schema = options.schema;
    if (this.schema !== undefined && !SCHEMA_IDENTIFIER.test(this.schema)) {
      throw new DriverConnectionError(
        `PG schema 名 "${this.schema}" 不是合法标识符（仅允许字母、数字、下划线，不能以数字开头）。`,
      );
    }
  }

  currentTransactionContext(): DbTransactionContext | undefined {
    const context = this.transactionIdentity.getStore();
    return context?.active ? context : undefined;
  }

  /** Internal M1 descriptor, not identity evidence. The M1 factory still verifies every fact. */
  m1ExistingSourceOptions(): DbDriverOptions {
    return { dbDriver: "postgres", pgConnectionString: this.connectionString, initializationOnConnect: "none",
      ...(this.schema === undefined ? {} : { pgSchema: this.schema }) };
  }

  /** M1 target only: inspect, explicit CREATE, existing migration code and copy keep one client. */
  async withM1PinnedConnection<T>(use: () => Promise<T>): Promise<T> {
    if (this.initializationOnConnect !== "none" || this.m1PinActive || this.currentTransactionContext())
      throw new Error("m1_target_requires_uninitialized_own_connection");
    const client = await this.requirePool().connect();
    const pin: M1PinnedConnection = { client, queue: new OperationQueue(), active: true };
    const onError = (error: Error): void => { pin.failed ??= error; };
    client.on("error", onError);
    this.m1PinActive = true;
    return withM1Cleanup(() => this.m1Pin.run(pin, async () => {
      const result = await use();
      this.assertM1Pin(pin);
      return result;
    }), [async () => {
      await pin.queue.drain();
      pin.active = false;
      pin.queue.close();
      this.m1PinActive = false;
      try { client.release(pin.failed !== undefined); } finally { client.off("error", onError); }
    }]);
  }

  /** Called after inspect/CREATE in that same physical transaction; cannot be rebound. */
  bindM1Target(check: (read: DbReadSnapshot) => Promise<void>): void {
    const pin = this.m1Pin.getStore();
    if (!pin || pin.check || !this.currentTransactionContext()) throw new Error("m1_target_binding_invalid");
    this.assertM1Pin(pin);
    pin.check = check;
  }

  private assertM1Pin(pin: M1PinnedConnection): void {
    if (!pin.active) throw new Error("m1_target_lease_ended");
    if (pin.failed !== undefined) throw pin.failed;
  }

  private async checkM1Pin(client: PoolClient): Promise<void> {
    const pin = this.m1Pin.getStore();
    if (!pin) {
      if (this.m1PinActive) throw new Error("m1_target_lease_owned_elsewhere");
      return;
    }
    this.assertM1Pin(pin);
    if (pin.client !== client) throw new Error("m1_target_client_changed");
    if (pin.check) await pin.check({ query: async <R extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(this.dialect.renderParameters(sql), [...params])).rows as R[] });
  }

  private async withClient<T>(use: (client: PoolClient) => Promise<T>): Promise<T> {
    const current = this.transactionScope.getStore();
    if (current) return use(current.client);
    const pin = this.m1Pin.getStore();
    if (pin) return pin.queue.run(async () => { this.assertM1Pin(pin); return use(pin.client); });
    if (this.m1PinActive) throw new Error("m1_target_lease_owned_elsewhere");
    const client = await this.requirePool().connect();
    // Pool's error listener only covers idle clients. A leased source can die while the
    // target is working, between queries; retain that error without an uncaught event.
    let connectionFailure: Error | undefined;
    const onError = (error: Error): void => { connectionFailure ??= error; };
    client.on("error", onError);
    try {
      const result = await use(client);
      if (connectionFailure) throw connectionFailure;
      return result;
    } finally {
      try { client.release(connectionFailure); } finally { client.off("error", onError); }
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
      await this.withClient(probe => this.checkAdmission(probe,false));
      if (this.schema !== undefined && this.initializationOnConnect === "normal") {
        // search_path 指向的 schema 必须先存在，否则后续 DDL 全部失败。
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema()}`);
      }
    } catch (error) {
      this.pool = null;
      const failure = error instanceof StorageMaintenanceError ? error : new DriverConnectionError(
        `无法连接 PostgreSQL（${this.sanitizedConnectionString()}）：${this.sanitize(errorText(error))}。` +
          `请确认数据库服务已启动、AGENT_STUDIO_PG_CONNECTION_STRING 与权限配置正确；` +
          `回滚方式：保持/改回 AGENT_STUDIO_DB_DRIVER=sqlite 即恢复阶段 1 行为。`,
      );
      if (this.initializationOnConnect === "none")
        return withM1Cleanup(async () => { throw failure; }, [() => pool.end()]);
      await pool.end().catch(() => {});
      throw failure;
    }
  }

  /**
   * 执行未应用的迁移：与 SQLite 运行器同一套定义校验、checksum 与版本语义，
   * SQL 经方言渲染（迁移期保留回滚路径：配置切回 sqlite，PG 数据不受影响即回滚）。
   */
  async migrate(migrations: readonly Migration[]): Promise<MigrationRunResult> {
    const ordered = validateAndSort(migrations);
    this.requirePool();
    await this.transaction(async tx => {await tx.exec(this.dialect.migrationTableDdl());});
    await this.withClient(async probe => {if (await readPostgresMaintenanceState(probe)) await assertPostgresGuardCoverage(probe);});

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
    await this.withClient(current => this.checkAdmission(current,false));
    return { applied: newlyApplied, version: state.version };
  }

  async migrationState(): Promise<{ version: number; applied: AppliedMigration[] }> {
    const rows = await this.readAppliedMigrations();
    const highest = rows.reduce((max, row) => Math.max(max, row.version), 0);
    return { version: highest, applied: rows };
  }

  async query<T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const scope = this.transactionScope.getStore();
    if (!scope) return this.transaction(async tx => tx.query<T>(sql,params));
    const execute = () => (scope?.client ?? this.requirePool()).query(this.dialect.renderParameters(sql), [...params]);
    const result = await (scope ? scope.queue.run(execute) : execute());
    return result.rows as T[];
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    const scope = this.transactionScope.getStore();
    if (!scope) return this.transaction(async tx => tx.exec(sql,params));
    const execute = () => (scope?.client ?? this.requirePool()).query(this.dialect.renderParameters(sql), [...params]);
    const result = await (scope ? scope.queue.run(execute) : execute());
    return result.rowCount ?? 0;
  }

  async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    // 真正的嵌套调用复用当前异步上下文客户端；独立请求各自向池取连接。
    // 并行兄弟子事务在父队列中串行，不能让一方回滚覆盖另一方的 SAVEPOINT。
    const parent = this.transactionScope.getStore();
    if (parent) return parent.queue.run(() => this.runTransaction(fn, parent.client, parent.queue));
    const callbacks: CommitCallback[] = [];
    const result = await this.withClient(client => this.runTransaction(fn, client, undefined, false, callbacks));
    await runCommitCallbacks(callbacks);
    return result;
  }

  async readSnapshot<T>(fn: (snapshot: DbReadSnapshot) => Promise<T>): Promise<T> {
    if (this.currentTransactionContext()) throw new Error("read_snapshot_requires_own_transaction");
    if (this.m1PinActive) throw new Error("m1_target_lease_cannot_open_another_snapshot");
    return this.withClient(client => this.runTransaction(tx => fn({ query: tx.query }), client, undefined, true));
  }

  private async runTransaction<T>(fn: (tx: DbTransaction) => Promise<T>, client: PoolClient, parent?: OperationQueue, readOnly = false,
    callbacks: CommitCallback[] = []): Promise<T> {
    const nested = parent !== undefined;
    const identity = this.transactionIdentity.getStore() ?? { values: new Map<symbol, unknown>(), active: true };
    const savedValues = nested ? new Map(identity.values) : undefined;
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
      else await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : this.dialect.beginTransaction());
      const scope = { client, queue };
      try {
        // READ ONLY is enforced by PG before the first gate query. FOR SHARE is a write
        // lock and cannot be used in a read-only transaction; normal transactions retain it.
        if (!nested) { await this.checkM1Pin(client); await this.checkAdmission(client,!readOnly,!readOnly); }
        const result = await this.transactionIdentity.run(identity, () => this.transactionScope.run(scope, () => fn(tx)));
        await queue.drain();
        if (nested) await client.query(`RELEASE SAVEPOINT ${sp}`);
        else {
          await this.checkM1Pin(client);
          const committed = await client.query(this.dialect.commit());
          // body 捕获语句错误后 PG 仍可能以 ROLLBACK tag 正常响应 COMMIT。
          if (committed.command !== "COMMIT") {
            throw new Error(`PostgreSQL 事务未确认提交（可能已 aborted）：COMMIT 返回 ${committed.command}。`);
          }
          if (!readOnly) callbacks.push(...commitCallbacks(identity));
        }
        return result;
      } catch (error) {
        await queue.drain();
        try {
          if (nested) {
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            // PostgreSQL 会释放保存点后取得的行锁，元数据必须回到相同边界。
            identity.values.clear();
            for (const [key, value] of savedValues!) identity.values.set(key, value);
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
      if (!nested) identity.active = false;
    }
  }

  async close(): Promise<void> {
    if (this.m1PinActive) throw new Error("m1_target_lease_still_active");
    const pool = this.pool;
    this.pool = null;
    this.admissionIdentity = undefined;
    if (pool !== null) {
      if (this.initializationOnConnect === "none") await pool.end();
      else await pool.end().catch(() => {});
    }
  }

  private async applyOne(migration: Migration): Promise<void> {
    const upSql = migrationSql(migration, "postgres");
    return this.withClient(async client => {
      try {
        await client.query(this.dialect.beginTransaction());
        await this.checkM1Pin(client);
        await this.checkAdmission(client,true);
        if (await readPostgresMaintenanceState(client)) await assertPostgresGuardCoverage(client);
        await client.query(upSql); // 迁移脚本为无参多语句，走简单查询协议
        await extendPostgresStorageGuards(client);
        await client.query(
          this.dialect.renderParameters(
            `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
          ),
          [migration.version, migration.name, checksumOf(upSql), new Date().toISOString()],
        );
        await this.checkM1Pin(client);
        const committed = await client.query(this.dialect.commit());
        if (committed.command !== "COMMIT") throw new Error(`PostgreSQL 迁移未确认提交：COMMIT 返回 ${committed.command}。`);
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
      }
    });
  }

  private async readAppliedMigrations(): Promise<AppliedMigration[]> {
    const result: QueryResult = await this.withClient(client => client.query(
      `SELECT version, name, checksum, applied_at FROM ${MIGRATION_TABLE} ORDER BY version`,
    ));
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

  private async checkAdmission(client: PoolClient, lock: boolean, allowCleanup = true): Promise<void> {
    const state=await readPostgresMaintenanceState(client,{required:this.admissionIdentity!==undefined,lock});
    const cleanupClient=allowCleanup ? storageDrainClientToCheck(this,state,this.admissionIdentity) : null;
    if (cleanupClient) assertStorageDrainClient((await client.query("SELECT * FROM storage_source_clients WHERE client_id=$1 FOR SHARE",[cleanupClient])).rows[0],state!,this.admissionIdentity!);
    else assertStorageAdmission(state,this.admissionIdentity);
    if (state && !this.admissionIdentity) this.admissionIdentity={databaseInstanceId:state.databaseInstanceId,fenceEpoch:state.fenceEpoch};
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

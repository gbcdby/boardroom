import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { assertSqliteSourceUnchanged, type SqliteDatabaseDescriptor } from "../environment.ts";
import { createDbDriver, type DbDriver, type DbDriverOptions, type DbReadSnapshot, type DbRow } from "./driver.ts";
import { PostgresDriver } from "./drivers/postgres.ts";
import { SqliteDriver } from "./drivers/sqlite.ts";
import { MigrationError } from "./migrate.ts";
import { assertM1Binding, describeM1Sqlite, readM1SourceBinding,
  type M1ReadPlan, type M1Rows, type M1SourceBinding } from "./m1-inspection.ts";
import { withM1Cleanup } from "./m1-resources.ts";

export interface M1PgSession {
  readonly pid: number;
  readonly databaseOid: string;
  readonly roleOid: string;
  readonly backendStart: string;
  readonly xactStart: string;
  readonly nonce: string;
}

const permitBrand: unique symbol = Symbol("m1-source-permit");
export interface M1SourcePermit { readonly [permitBrand]: true }
export interface M1PermitFacts {
  readonly rows: M1Rows;
  readonly binding: M1SourceBinding;
  readonly owner?: M1PgSession;
  readonly reader?: M1PgSession;
  readonly assertAlive: () => Promise<void>;
}
const permits = new WeakMap<M1SourcePermit, M1PermitFacts>();

export function m1PermitFacts(permit: M1SourcePermit): M1PermitFacts {
  const facts = permits.get(permit);
  if (!facts) throw new MigrationError("m1_source_permit_inactive");
  return facts;
}

/** No driver or exec capability is returned to consumers. */
export interface M1ExistingSource extends DbReadSnapshot {
  readonly kind: "sqlite" | "postgres";
  withBatch<T>(use: (permit: M1SourcePermit) => Promise<T>): Promise<T>;
  readSnapshot<T>(use: (read: DbReadSnapshot) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function materialize(read: DbReadSnapshot, plan: M1ReadPlan): Promise<M1Rows> {
  const tables: Record<string, readonly Readonly<DbRow>[]> = Object.create(null) as Record<string, readonly Readonly<DbRow>[]>;
  for (const table of plan.tables) {
    const rows = await read.query(table.readSql ?? `SELECT * FROM ${table.name}`);
    if (table.readSql) {
      // Recursive ordering can omit a disconnected cycle. Count in this SAME view;
      // never re-read raw rows or silently certify the reduced batch as complete.
      const [count] = await read.query(`SELECT COUNT(*) AS count FROM ${table.name}`);
      if (!Number.isSafeInteger(Number(count?.count)) || Number(count?.count) !== rows.length)
        throw new MigrationError(`m1_source_ordered_read_incomplete:${table.name}`);
    }
    tables[table.name] = Object.freeze(rows.map(row => {
      // Business storage is scalar TEXT/NULL/integer. Reject mutable driver values instead
      // of claiming a frozen row also freezes a Buffer/object hidden inside it.
      if (Object.values(row).some(value => value !== null && typeof value === "object" || typeof value === "function"))
        throw new MigrationError(`m1_source_non_scalar_value:${table.name}`);
      return Object.freeze({ ...row });
    }));
  }
  const frozen = Object.freeze(tables);
  plan.validate(frozen);
  return frozen;
}

async function pgSession(read: DbReadSnapshot, nonce: string): Promise<M1PgSession> {
  await read.query("SELECT pg_stat_clear_snapshot()");
  const rows = await read.query(`SELECT pid, datid::text AS database_oid, usesysid::text AS role_oid,
    backend_start::text AS backend_start, xact_start::text AS xact_start, application_name
    FROM pg_stat_activity WHERE pid=pg_backend_pid() AND usename=current_user AND datname=current_database()`);
  const row = rows[0];
  if (rows.length !== 1 || !row || !Number.isInteger(row.pid) || typeof row.database_oid !== "string"
    || typeof row.role_oid !== "string" || typeof row.backend_start !== "string" || typeof row.xact_start !== "string"
    || row.application_name !== nonce) throw new MigrationError("m1_owner_witness_unavailable");
  return Object.freeze({ pid: Number(row.pid), databaseOid: row.database_oid, roleOid: row.role_oid,
    backendStart: row.backend_start, xactStart: row.xact_start, nonce });
}

/** Timestamps are compared by PostgreSQL, preserving microseconds and timezone semantics. */
export async function assertM1PgOwnerWitness(read: DbReadSnapshot, owner: M1PgSession, own = false): Promise<void> {
  await read.query("SELECT pg_stat_clear_snapshot()");
  const rows = await read.query(`SELECT a.pid FROM pg_stat_activity a
    WHERE a.pid=? AND a.datid=?::oid AND a.usesysid=?::oid
      AND a.datname=current_database() AND a.usename=current_user
      AND a.backend_start=?::timestamptz AND a.xact_start=?::timestamptz
      AND a.application_name=? AND a.state IN ('active','idle in transaction')
      AND ${own ? "a.pid=pg_backend_pid()" : "a.pid<>pg_backend_pid()"}
      AND (SELECT COUNT(*) FROM pg_stat_activity b WHERE b.datid=a.datid
        AND b.usesysid=a.usesysid AND b.application_name=a.application_name)=1`,
  [owner.pid, owner.databaseOid, owner.roleOid, owner.backendStart, owner.xactStart, owner.nonce]);
  if (rows.length !== 1 || rows[0]!.pid !== owner.pid) throw new MigrationError("m1_owner_witness_mismatch");
}

/** Both SQLite opens are NO_CREATE. PG does not initialize a namespace or version table. */
export async function openM1SourceExisting(options: DbDriverOptions, plan: M1ReadPlan): Promise<M1ExistingSource> {
  const kind = options.dbDriver ?? "sqlite";
  let sqlite: SqliteDatabaseDescriptor | undefined;
  let preflight: M1SourceBinding | undefined;
  if (kind === "sqlite") {
    sqlite = describeM1Sqlite(options, true);
    assertSqliteSourceUnchanged(sqlite);
    const reader = new Database(sqlite.sqlitePath, { readonly: true, fileMustExist: true });
    preflight = await withM1Cleanup(async () => {
      reader.pragma("query_only=ON");
      reader.exec("BEGIN");
      const read: DbReadSnapshot = { query: async <T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []) =>
        reader.prepare(sql).all(...params) as T[] };
      const binding = await readM1SourceBinding(read, kind, plan, { sqlite: sqlite! });
      reader.exec("COMMIT");
      assertSqliteSourceUnchanged(sqlite!);
      return binding;
    }, [async () => { reader.close(); }]);
  }
  const fixedOptions: DbDriverOptions = { ...options, initializationOnConnect: "none",
    ...(sqlite ? { sqlitePath: sqlite.sqlitePath, sqliteSource: sqlite } : {}) };
  const driver = createDbDriver(fixedOptions);
  const location = { ...(sqlite ? { sqlite } : {}), ...(options.pgSchema === undefined ? {} : { pgSchema: options.pgSchema }) };
  try {
    await driver.connect();
    const actual = kind === "sqlite" ? await readM1SourceBinding(driver, kind, plan, location)
      : await driver.readSnapshot(read => readM1SourceBinding(read, kind, plan, location));
    if (preflight) assertM1Binding(actual, preflight);
    const initial = actual;
    if (sqlite) assertSqliteSourceUnchanged(sqlite);
    return Object.freeze({ kind,
      query: <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => driver.query<T>(sql, params),
      withBatch: <T>(use: (permit: M1SourcePermit) => Promise<T>) =>
        withM1SourceOwner(driver, plan, initial, fixedOptions, use),
      readSnapshot: <T>(use: (read: DbReadSnapshot) => Promise<T>) => driver.readSnapshot(async read => {
        assertM1Binding(await readM1SourceBinding(read, kind, plan, location), initial);
        return use(read);
      }),
      close: () => driver.close(),
    });
  } catch (error) {
    return withM1Cleanup(async () => { throw error; }, [() => driver.close()]);
  }
}

async function withM1SourceOwner<T>(
  source: DbDriver, plan: M1ReadPlan, initial: M1SourceBinding | undefined,
  options: DbDriverOptions, use: (permit: M1SourcePermit) => Promise<T>,
): Promise<T> {
  if (source.kind === "postgres" && source.currentTransactionContext())
    throw new MigrationError("m1_postgres_source_requires_own_transaction");
  const sqlite = source.kind === "sqlite" ? describeM1Sqlite(options, true) : undefined;
  const location = { ...(sqlite ? { sqlite } : {}), ...(options.pgSchema === undefined ? {} : { pgSchema: options.pgSchema }) };
  return source.transaction(async tx => {
    const context = source.currentTransactionContext();
    if (!context) throw new MigrationError("m1_source_transaction_unavailable");
    const read: DbReadSnapshot = { query: tx.query };
    const binding = await readM1SourceBinding(read, source.kind, plan, location);
    if (initial) assertM1Binding(binding, initial);
    let owner: M1PgSession | undefined;
    let readerSession: M1PgSession | undefined;
    if (source.kind === "postgres") {
      const nonce = `boardroom-m1:${randomBytes(16).toString("hex")}`;
      const [set] = await tx.query("SELECT set_config('application_name', ?, true) AS nonce", [nonce]);
      if (set?.nonce !== nonce || Buffer.byteLength(nonce, "ascii") > 63) throw new MigrationError("m1_owner_nonce_invalid");
      owner = await pgSession(read, nonce);
      await assertM1PgOwnerWitness(read, owner, true);
    }
    const assertAlive = async (): Promise<void> => {
      if (source.currentTransactionContext() !== context) throw new MigrationError("m1_source_owner_ended");
      if (sqlite) assertSqliteSourceUnchanged(sqlite);
      if (owner) await assertM1PgOwnerWitness(read, owner, true);
      assertM1Binding(await readM1SourceBinding(read, source.kind, plan, location), binding);
    };
    let rows: M1Rows;
    if (source.kind === "postgres") {
      // The only fresh reader factory is this existing-only opener. No arbitrary normal factory or RC fallback.
      const reader = await openM1SourceExisting(options, plan);
      rows = await withM1Cleanup(() => reader.readSnapshot(async snapshot => {
        assertM1Binding(await readM1SourceBinding(snapshot, "postgres", plan, location), binding);
        await assertM1PgOwnerWitness(snapshot, owner!);
        const [session] = await snapshot.query("SELECT current_setting('application_name') AS nonce");
        readerSession = await pgSession(snapshot, String(session?.nonce));
        if (readerSession.pid === owner!.pid) throw new MigrationError("m1_reader_not_independent");
        const batch = await materialize(snapshot, plan);
        await assertM1PgOwnerWitness(snapshot, owner!);
        assertM1Binding(await readM1SourceBinding(snapshot, "postgres", plan, location), binding);
        return batch;
      }), [() => reader.close()]);
    } else rows = await materialize(read, plan);
    await assertAlive();
    const permit: M1SourcePermit = Object.freeze({ [permitBrand]: true as const });
    permits.set(permit, Object.freeze({ rows, binding, assertAlive,
      ...(owner ? { owner } : {}), ...(readerSession ? { reader: readerSession } : {}) }));
    try {
      const result = await use(permit);
      await assertAlive();
      return result;
    } finally { permits.delete(permit); }
  });
}

/** Borrowed drivers are not closed. This only promises the boundary after helper entry. */
export async function withM1BorrowedSource<T>(source: DbDriver, plan: M1ReadPlan,
  use: (permit: M1SourcePermit) => Promise<T>): Promise<T> {
  let options: DbDriverOptions;
  if (source instanceof PostgresDriver) options = source.m1ExistingSourceOptions();
  else if (source instanceof SqliteDriver) options = { dataDir: path.dirname(source.file), sqlitePath: source.file };
  else throw new MigrationError("m1_source_requires_existing_reader_configuration");
  return withM1SourceOwner(source, plan, undefined, options, use);
}

import { statSync } from "node:fs";
import path from "node:path";
import { assertSqliteSingleLink, assertSqliteSourceUnchanged, canonicalizePath,
  type SqliteDatabaseDescriptor } from "../environment.ts";
import { assertStorageAdmission, parseStorageMaintenanceState, type StorageMaintenanceState } from "../storage/admission.ts";
import { DATABASE_FILE_NAME } from "./database.ts";
import type { DbDriverOptions, DbReadSnapshot, DbRow } from "./driver.ts";
import { checksumOf, migrationSql, validateAndSort, MigrationError, type Migration } from "./migrate.ts";

export interface M1TableRead { readonly name: string; readonly readSql?: string }
export type M1Rows = Readonly<Record<string, readonly Readonly<DbRow>[]>>;
export interface M1ReadPlan {
  readonly tables: readonly M1TableRead[];
  readonly catalogs: Readonly<Record<"sqlite" | "postgres", readonly (readonly Migration[])[]>>;
  readonly validate: (rows: M1Rows) => void;
}

export interface M1PgNamespace {
  readonly database: string;
  readonly databaseOid: string;
  readonly schema: string;
  readonly schemaOid: string | null;
  readonly serverAddress: string | null;
  readonly serverPort: number | null;
  readonly postmasterStart: string;
}
export interface M1SourceBinding {
  readonly kind: "sqlite" | "postgres";
  readonly maintenance: StorageMaintenanceState;
  readonly versions: readonly DbRow[];
  readonly relations: readonly DbRow[];
  readonly postgres?: M1PgNamespace;
  readonly sqlite?: SqliteDatabaseDescriptor;
}

/** Uses the existing resolver and inode boundary; never creates a path. */
export function describeM1Sqlite(options: DbDriverOptions, required: boolean): SqliteDatabaseDescriptor {
  if (!options.dataDir?.trim()) throw new MigrationError("m1_sqlite_data_dir_required");
  if (options.sqliteSource) {
    assertSqliteSourceUnchanged(options.sqliteSource);
    if (required && !options.sqliteSource.identity) throw new MigrationError("m1_source_missing");
    return options.sqliteSource;
  }
  const sourcePath = path.resolve(options.sqlitePath ?? path.join(options.dataDir, DATABASE_FILE_NAME));
  const sqlitePath = canonicalizePath(sourcePath);
  let identity: SqliteDatabaseDescriptor["identity"] = null;
  try {
    const stat = statSync(sqlitePath, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new MigrationError("m1_sqlite_file_identity_invalid");
    assertSqliteSingleLink(sqlitePath);
    identity = { device: String(stat.dev), inode: String(stat.ino) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required) throw error;
  }
  return Object.freeze({ kind: "sqlite", dataDir: options.dataDir, sourcePath, sqlitePath, identity });
}

export async function readM1PgNamespace(read: DbReadSnapshot, configuredSchema?: string): Promise<M1PgNamespace> {
  const [row] = await read.query(`SELECT current_database() AS database_name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_schema() AS current_schema, inet_server_addr()::text AS server_address,
    inet_server_port() AS server_port,
    to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS postmaster_start,
    n.nspname AS schema_name, n.oid::text AS schema_oid
    FROM (SELECT 1) AS one LEFT JOIN pg_namespace n ON n.nspname=COALESCE(?, current_schema())`,
  [configuredSchema ?? null]);
  if (!row || typeof row.database_name !== "string" || typeof row.database_oid !== "string"
    || typeof row.postmaster_start !== "string") throw new MigrationError("m1_postgres_identity_unavailable");
  const schema = configuredSchema ?? row.current_schema;
  if (typeof schema !== "string" || !schema) throw new MigrationError("m1_postgres_namespace_missing");
  if (row.schema_oid !== null && (row.schema_name !== schema || row.current_schema !== schema))
    throw new MigrationError("m1_postgres_namespace_mismatch");
  return Object.freeze({ database: row.database_name, databaseOid: row.database_oid,
    schema, schemaOid: row.schema_oid === null ? null : String(row.schema_oid),
    serverAddress: row.server_address === null ? null : String(row.server_address),
    serverPort: row.server_port === null ? null : Number(row.server_port), postmasterStart: row.postmaster_start });
}

export async function readM1Versions(read: DbReadSnapshot): Promise<readonly DbRow[]> {
  // No migrationState(): its SQLite implementation deliberately creates the version table.
  return read.query("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
}

/** Match one entire catalog, never a per-version mixture of dialect definitions. */
export function assertM1Versions(rows: readonly DbRow[], catalogs: readonly (readonly Migration[])[], kind: "sqlite" | "postgres"):
  readonly Migration[] {
  const matching = catalogs.find(catalog => {
    const ordered = validateAndSort(catalog);
    return rows.length === ordered.length && ordered.every((migration, i) => {
      const row = rows[i];
      return row && Number(row.version) === migration.version && row.name === migration.name
        && row.checksum === checksumOf(migrationSql(migration, kind));
    });
  });
  if (!matching) throw new MigrationError("m1_source_version_or_checksum_mismatch");
  return matching;
}

export async function readM1SourceBinding(
  read: DbReadSnapshot, kind: "sqlite" | "postgres", plan: M1ReadPlan,
  location: { readonly pgSchema?: string; readonly sqlite?: SqliteDatabaseDescriptor } = {},
): Promise<M1SourceBinding> {
  const names = [...plan.tables.map(t => t.name), "schema_migrations", "storage_maintenance", "storage_source_clients"].sort();
  let relations: DbRow[];
  let postgres: M1PgNamespace | undefined;
  if (kind === "postgres") {
    postgres = await readM1PgNamespace(read, location.pgSchema);
    if (!postgres.schemaOid) throw new MigrationError("m1_source_namespace_missing");
    relations = [];
    for (const name of names) {
      const rows = await read.query(`SELECT c.relname AS name, c.oid::text AS oid, n.oid::text AS namespace_oid,
        n.nspname AS namespace_name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid=to_regclass(?)`, [name]);
      const row = rows[0];
      if (rows.length !== 1 || !row || row.name !== name || row.namespace_oid !== postgres.schemaOid
        || row.namespace_name !== postgres.schema || !["r", "p"].includes(String(row.relkind)))
        throw new MigrationError(`m1_source_relation_mismatch:${name}`);
      relations.push(row);
    }
  } else {
    if (!location.sqlite?.identity) throw new MigrationError("m1_source_file_identity_required");
    assertSqliteSourceUnchanged(location.sqlite);
    relations = await read.query(`SELECT name, type, rootpage, sql FROM sqlite_schema
      WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY name`, names);
    if (relations.length !== names.length || relations.some((row, i) => row.name !== names[i] || row.type !== "table"))
      throw new MigrationError("m1_source_relation_missing");
  }
  const maintenance = parseStorageMaintenanceState(await read.query("SELECT * FROM storage_maintenance"));
  assertStorageAdmission(maintenance);
  const versions = await readM1Versions(read);
  assertM1Versions(versions, plan.catalogs[kind], kind);
  return Object.freeze({ kind, maintenance, versions: Object.freeze(versions.map(row => Object.freeze({ ...row }))),
    relations: Object.freeze(relations.map(row => Object.freeze({ ...row }))),
    ...(postgres ? { postgres } : {}), ...(location.sqlite ? { sqlite: location.sqlite } : {}) });
}

export function assertM1Binding(actual: M1SourceBinding, expected: M1SourceBinding): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new MigrationError("m1_source_binding_changed");
}

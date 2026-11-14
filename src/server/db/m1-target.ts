import { closeSync, fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { assertSqliteSourceUnchanged, canonicalizePath, type SqliteDatabaseDescriptor } from "../environment.ts";
import { createDbDriver, type DbDriver, type DbDriverOptions, type DbReadSnapshot, type DbRow } from "./driver.ts";
import { PostgresDriver } from "./drivers/postgres.ts";
import { SqliteDriver } from "./drivers/sqlite.ts";
import { checksumOf, migrationSql, validateAndSort, MigrationError, type Migration } from "./migrate.ts";
import { describeM1Sqlite, readM1PgNamespace, readM1Versions, type M1ReadPlan } from "./m1-inspection.ts";
import { m1PermitFacts, type M1SourcePermit } from "./m1-source.ts";
import { withM1Cleanup } from "./m1-resources.ts";

function targetCatalog(applied: readonly DbRow[], plan: M1ReadPlan, kind: "sqlite" | "postgres"): readonly Migration[] {
  const catalogs = plan.catalogs[kind];
  if (!applied.length) return catalogs.at(-1)!;
  const catalog = catalogs.find(list => {
    const ordered = validateAndSort(list);
    return applied.length <= ordered.length && applied.every((row, i) => {
      const expected = ordered[i];
      return expected && Number(row.version) === expected.version && row.name === expected.name
        && row.checksum === checksumOf(migrationSql(expected, kind));
    });
  });
  if (!catalog) throw new MigrationError("m1_target_version_or_checksum_mismatch");
  return catalog;
}

async function inspectTargetCatalog(read: DbReadSnapshot, plan: M1ReadPlan, kind: "sqlite" | "postgres"):
  Promise<readonly Migration[]> {
  const tables = kind === "sqlite"
    ? await read.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    : await read.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')");
  if (!tables.some(table => table.name === "schema_migrations")) {
    if (tables.length) throw new MigrationError("m1_target_unversioned_nonempty_namespace");
    return targetCatalog([], plan, kind);
  }
  return targetCatalog(await readM1Versions(read), plan, kind);
}

/** Resolve actual files/namespaces, including aliases; URL strings are never the proof. */
export async function assertM1DifferentTarget(target: DbDriver, read: DbReadSnapshot, permit: M1SourcePermit): Promise<void> {
  const source = m1PermitFacts(permit).binding;
  if (target.kind !== source.kind) return;
  if (target instanceof SqliteDriver && source.sqlite) {
    const actual = describeM1Sqlite({ dataDir: path.dirname(target.file), sqlitePath: target.file }, true);
    if (actual.sqlitePath === source.sqlite.sqlitePath || actual.identity?.device === source.sqlite.identity?.device
      && actual.identity?.inode === source.sqlite.identity?.inode) throw new MigrationError("m1_source_target_same_database");
  } else if (target instanceof PostgresDriver && source.postgres) {
    const actual = await readM1PgNamespace(read, target.m1ExistingSourceOptions().pgSchema);
    const expected = source.postgres;
    if (actual.database === expected.database && actual.databaseOid === expected.databaseOid
      && actual.schema === expected.schema && actual.schemaOid === expected.schemaOid) {
      const [same] = await read.query("SELECT pg_postmaster_start_time()=?::timestamptz AS same_start", [expected.postmasterStart]);
      if (same?.same_start === true || actual.serverAddress === expected.serverAddress && actual.serverPort === expected.serverPort)
        throw new MigrationError("m1_source_target_same_database");
    }
  } else throw new MigrationError("m1_target_identity_unavailable");
}

interface ParentPlan { readonly path: string; readonly device: bigint; readonly inode: bigint }
function parentPlan(directory: string): ParentPlan {
  let current = directory;
  for (;;) {
    try {
      const stat = statSync(current, { bigint: true });
      if (!stat.isDirectory()) throw new MigrationError("m1_target_parent_not_directory");
      return { path: current, device: stat.dev, inode: stat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

function createExclusiveSqlite(plan: SqliteDatabaseDescriptor, parent: ParentPlan): SqliteDatabaseDescriptor {
  if (canonicalizePath(plan.sourcePath) !== plan.sqlitePath) throw new MigrationError("m1_target_path_changed");
  const stat = statSync(parent.path, { bigint: true });
  if (!stat.isDirectory() || stat.dev !== parent.device || stat.ino !== parent.inode)
    throw new MigrationError("m1_target_parent_changed");
  mkdirSync(path.dirname(plan.sqlitePath), { recursive: true });
  // O_EXCL is the creation boundary. An object that appeared after inspect is never adopted.
  const fd = openSync(plan.sqlitePath, "wx", 0o600);
  try {
    const file = fstatSync(fd, { bigint: true });
    if (!file.isFile() || file.nlink !== 1n) throw new MigrationError("m1_target_file_identity_invalid");
    const descriptor: SqliteDatabaseDescriptor = { ...plan, identity: { device: String(file.dev), inode: String(file.ino) } };
    assertSqliteSourceUnchanged(descriptor);
    return descriptor;
  } finally { closeSync(fd); }
}

/** Source permit is process-local and valid only while its original admission owner is alive. */
export async function withM1TargetLease<T>(options: DbDriverOptions, permit: M1SourcePermit,
  plan: M1ReadPlan, use: (target: DbDriver) => Promise<T>): Promise<T> {
  const facts = m1PermitFacts(permit);
  await facts.assertAlive();
  if ((options.dbDriver ?? "sqlite") === "postgres") {
    const target = createDbDriver({ ...options, initializationOnConnect: "none" });
    if (!(target instanceof PostgresDriver)) throw new MigrationError("m1_target_driver_invalid");
    return withM1Cleanup(async () => {
      await target.connect();
      return target.withM1PinnedConnection(async () => {
        let catalog: readonly Migration[] = [];
        // Both inspection and the first possible CREATE happen in this one physical transaction.
        await target.transaction(async tx => {
          const inspected = await readM1PgNamespace(tx, options.pgSchema);
          await assertM1DifferentTarget(target, tx, permit);
          catalog = inspected.schemaOid === null ? targetCatalog([], plan, "postgres") : await inspectTargetCatalog(tx, plan, "postgres");
          await facts.assertAlive();
          const still = await readM1PgNamespace(tx, options.pgSchema);
          if (JSON.stringify(still) !== JSON.stringify(inspected)) throw new MigrationError("m1_target_namespace_changed");
          if (inspected.schemaOid === null) {
            // Identifier was checked by PostgresDriver. No IF NOT EXISTS race suppression.
            await tx.exec(`CREATE SCHEMA "${inspected.schema}"`);
          }
          const bound = await readM1PgNamespace(tx, options.pgSchema);
          if (!bound.schemaOid) throw new MigrationError("m1_target_namespace_missing_after_create");
          target.bindM1Target(async read => {
            await facts.assertAlive();
            if (JSON.stringify(await readM1PgNamespace(read, options.pgSchema)) !== JSON.stringify(bound))
              throw new MigrationError("m1_target_namespace_changed");
          });
        });
        await target.migrate(catalog);
        return use(target);
      });
    }, [() => target.close()]);
  }

  let descriptor = describeM1Sqlite(options, false);
  const source = facts.binding.sqlite;
  if (source && (descriptor.sqlitePath === source.sqlitePath || descriptor.identity !== null
    && descriptor.identity.device === source.identity?.device && descriptor.identity.inode === source.identity?.inode))
    throw new MigrationError("m1_source_target_same_database");
  let target: DbDriver | undefined;
  return withM1Cleanup(async () => {
    let catalog: readonly Migration[];
    if (descriptor.identity) {
      target = createDbDriver({ ...options, initializationOnConnect: "none", sqlitePath: descriptor.sqlitePath, sqliteSource: descriptor });
      await target.connect();
      catalog = await inspectTargetCatalog(target, plan, "sqlite");
      await facts.assertAlive();
      assertSqliteSourceUnchanged(descriptor);
    } else {
      const parent = parentPlan(path.dirname(descriptor.sqlitePath));
      await facts.assertAlive();
      descriptor = createExclusiveSqlite(descriptor, parent);
      target = createDbDriver({ ...options, initializationOnConnect: "none", sqlitePath: descriptor.sqlitePath, sqliteSource: descriptor });
      await target.connect();
      catalog = targetCatalog([], plan, "sqlite");
    }
    await target.migrate(catalog);
    await facts.assertAlive();
    assertSqliteSourceUnchanged(descriptor);
    return use(target);
  }, [async () => { await target?.close(); }]);
}

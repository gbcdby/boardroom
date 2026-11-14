import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createDbDriver, type DbDriver, type DbDriverOptions, type DbReadSnapshot, type DbRow } from "../../src/server/db/driver.ts";
import { migrations } from "../../src/server/db/migrations/index.ts";
import { withM1Cleanup } from "../../src/server/db/m1-resources.ts";
import { DECISION_MIGRATION_TABLES, seedDecisionMigrationSource } from "./decisions-migration-fixture.ts";

export const m1PgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
export interface M1Fixture { readonly db: DbDriver; readonly options: DbDriverOptions; readonly directory?: string; close(): Promise<void> }

export async function m1Sqlite(seed = false, version?: number): Promise<M1Fixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boardroom-m1-control-"));
  const options: DbDriverOptions = { dbDriver: "sqlite", dataDir: directory };
  const db = createDbDriver(options);
  const close = () => withM1Cleanup(async () => {}, [() => db.close(), () => rm(directory, { recursive: true, force: true })]);
  try {
    await db.connect();
    await db.migrate(version === undefined ? migrations : migrations.filter(m => m.version <= version));
    if (seed) await seedDecisionMigrationSource(db);
    return { db, options, directory, close };
  } catch (error) { return withM1Cleanup(async () => { throw error; }, [close]); }
}

export function m1Schema(): string { return `m1_d2_${randomBytes(8).toString("hex")}`; }
export async function m1PgControl<T>(use: (client: Client) => Promise<T>): Promise<T> {
  if (!m1PgUrl) throw new Error("m1_real_postgres_required");
  const client = new Client({ connectionString: m1PgUrl });
  return withM1Cleanup(async () => { await client.connect(); return use(client); }, [() => client.end()]);
}
export async function m1DropSchema(schema: string): Promise<void> {
  assert.match(schema, /^[A-Za-z_][A-Za-z0-9_]*$/);
  await m1PgControl(async client => { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
}

export async function m1Postgres(): Promise<M1Fixture> {
  if (!m1PgUrl) throw new Error("m1_real_postgres_required");
  const schema = m1Schema();
  const options: DbDriverOptions = { dbDriver: "postgres", pgConnectionString: m1PgUrl, pgSchema: schema };
  const db = createDbDriver(options);
  const close = () => withM1Cleanup(async () => {}, [() => db.close(), () => m1DropSchema(schema)]);
  try { await db.connect(); await db.migrate(migrations); return { db, options, close }; }
  catch (error) { return withM1Cleanup(async () => { throw error; }, [close]); }
}

export type M1CapturedRows = Readonly<Record<string, readonly DbRow[]>>;
export async function m1Capture(read: DbReadSnapshot): Promise<M1CapturedRows> {
  const result: Record<string, DbRow[]> = {};
  for (const table of DECISION_MIGRATION_TABLES) result[table] = await read.query(`SELECT * FROM ${table}`);
  return result;
}

/** All-column oracle comes from SQLite's actual declared storage types, not M1 valueColumns. */
export async function m1ValueOracle(source: DbReadSnapshot): Promise<(rows: M1CapturedRows) => Record<string, string[]>> {
  const columns: Record<string, { name: string; integer: boolean }[]> = {};
  for (const table of DECISION_MIGRATION_TABLES) {
    columns[table] = (await source.query(`PRAGMA table_info(${table})`)).map(row => ({
      name: String(row.name), integer: /INT/i.test(String(row.type)),
    }));
  }
  return rows => Object.fromEntries(DECISION_MIGRATION_TABLES.map(table => [table, rows[table]!.map(row => {
    assert.deepEqual(Object.keys(row).sort(), columns[table]!.map(c => c.name).sort(), `${table}: actual schema columns`);
    return JSON.stringify(columns[table]!.map(column => {
      const value = row[column.name];
      if (value === null || !column.integer) return [column.name, typeof value, value];
      assert.ok(typeof value === "string" || typeof value === "number" || typeof value === "bigint", `${table}.${column.name}: integer storage`);
      if (typeof value === "number") assert.ok(Number.isSafeInteger(value));
      return [column.name, "integer", BigInt(value).toString()];
    }));
  }).sort()]));
}

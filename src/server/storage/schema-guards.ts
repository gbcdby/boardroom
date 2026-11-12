import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { PoolClient } from "pg";
import { readSqliteMaintenanceState, readPostgresMaintenanceState, StorageMaintenanceError } from "./admission.ts";

export const STORAGE_CONTROL_TABLES = ["storage_maintenance", "storage_source_clients"] as const;
const excluded = new Set<string>(STORAGE_CONTROL_TABLES);
function quote(name: string): string { return `"${name.replaceAll('"','""')}"`; }
function triggerName(table: string, event: string): string {
  return `br_storage_${createHash("sha256").update(table).digest("hex").slice(0,24)}_${event}`;
}
const events = ["insert","update","delete"] as const;
function sqliteGuard(table: string, event: typeof events[number]): string {
  return `CREATE TRIGGER ${quote(triggerName(table,event))} BEFORE ${event.toUpperCase()} ON ${quote(table)}
WHEN COALESCE((SELECT admission FROM storage_maintenance WHERE singleton=1),'sealed') NOT IN ('open','draining')
BEGIN SELECT RAISE(ABORT,'BOARDROOM_STORAGE_MAINTENANCE'); END`;
}
const pgBody = `DECLARE gate TEXT;
BEGIN
  EXECUTE format('SELECT admission FROM %I.storage_maintenance WHERE singleton=1 FOR SHARE', TG_TABLE_SCHEMA) INTO gate;
  IF gate IS NULL OR gate NOT IN ('open','draining') THEN
    RAISE EXCEPTION 'BOARDROOM_STORAGE_MAINTENANCE' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;`;
const pgFunction = `CREATE FUNCTION boardroom_storage_write_guard() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $maintenance$${pgBody}$maintenance$`;
function manifest(kind: "sqlite"|"postgres", tables: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify({protocol:1,kind,tables,
    definition:kind==="sqlite" ? tables.flatMap(t=>events.map(e=>sqliteGuard(t,e))) : pgBody})).digest("hex");
}
function sqliteTables(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string;sql:string}[];
  if (rows.some(r=>/^CREATE VIRTUAL TABLE/i.test(r.sql))) throw new StorageMaintenanceError("guard_incomplete");
  return rows.map(r=>r.name).filter(t=>!excluded.has(t));
}
function sqliteVerify(db: Database.Database, install: boolean): string {
  const tables = sqliteTables(db);
  const guards = new Map((db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'br_storage_%'").all() as {name:string;sql:string}[]).map(r=>[r.name,r.sql]));
  for (const table of tables) for (const event of events) {
    const name=triggerName(table,event), sql=sqliteGuard(table,event), existing=guards.get(name);
    if (existing === undefined && install) db.exec(sql);
    else if (existing !== sql) throw new StorageMaintenanceError("guard_incomplete");
    guards.delete(name);
  }
  if (guards.size) throw new StorageMaintenanceError("guard_incomplete");
  return manifest("sqlite",tables);
}
export function assertSqliteGuardCoverage(db: Database.Database): string {
  const state=readSqliteMaintenanceState(db,true)!;
  const hash=sqliteVerify(db,false);
  if (hash!==state.guardManifestDigest) throw new StorageMaintenanceError("guard_incomplete");
  return hash;
}
/** Called only inside an admitted schema migration's real transaction, never as auto-repair. */
export function extendSqliteStorageGuards(db: Database.Database): void {
  if (!readSqliteMaintenanceState(db)) return;
  if (!db.inTransaction) throw new StorageMaintenanceError("metadata_invalid");
  const hash=sqliteVerify(db,true);
  db.prepare("UPDATE storage_maintenance SET guard_manifest_digest=? WHERE singleton=1").run(hash);
}

async function pgTables(client: Pick<PoolClient,"query">): Promise<string[]> {
  const rows=(await client.query("SELECT c.relname AS name,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','f') ORDER BY c.relname")).rows;
  if (rows.some(r=>r.relkind!=="r")) throw new StorageMaintenanceError("guard_incomplete");
  return rows.map(r=>String(r.name)).filter(t=>!excluded.has(t));
}
async function pgVerify(client: Pick<PoolClient,"query">, install:boolean): Promise<string> {
  const tables=await pgTables(client);
  const functions=(await client.query("SELECT p.prosrc,p.provolatile,p.prosecdef,p.prorettype::regtype::text AS result FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname='boardroom_storage_write_guard'")).rows;
  if (functions.length===0 && install) await client.query(pgFunction);
  else if (functions.length!==1 || functions[0]?.prosrc!==pgBody || functions[0]?.provolatile!=="v" || functions[0]?.prosecdef!==false || functions[0]?.result!=="trigger") throw new StorageMaintenanceError("guard_incomplete");
  const rows=(await client.query(`SELECT t.tgname,c.relname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgconstraint::text,p.proname,n.nspname AS function_schema,current_schema() AS schema
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE s.nspname=current_schema() AND t.tgname LIKE 'br_storage_%'`)).rows;
  const guards=new Map(rows.map(r=>[String(r.tgname),r]));
  for (const table of tables) {
    const name=triggerName(table,"write"), existing=guards.get(name);
    if (!existing && install) await client.query(`CREATE TRIGGER ${quote(name)} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quote(table)} FOR EACH STATEMENT EXECUTE FUNCTION boardroom_storage_write_guard()`);
    else if (!existing || Number(existing.tgtype)!==62 || existing.tgenabled!=="O" || existing.tgisinternal!==false
      || existing.tgconstraint!=="0" || existing.relname!==table || existing.proname!=="boardroom_storage_write_guard" || existing.function_schema!==existing.schema)
      throw new StorageMaintenanceError("guard_incomplete");
    guards.delete(name);
  }
  if (guards.size) throw new StorageMaintenanceError("guard_incomplete");
  return manifest("postgres",tables);
}
export async function assertPostgresGuardCoverage(client: Pick<PoolClient,"query">): Promise<string> {
  const state=(await readPostgresMaintenanceState(client,{required:true}))!;
  const hash=await pgVerify(client,false);
  if (hash!==state.guardManifestDigest) throw new StorageMaintenanceError("guard_incomplete");
  return hash;
}
/** The migration runner owns BEGIN/COMMIT and has already checked existing guards. */
export async function extendPostgresStorageGuards(client: Pick<PoolClient,"query">): Promise<void> {
  if (!await readPostgresMaintenanceState(client)) return;
  const hash=await pgVerify(client,true);
  await client.query("UPDATE storage_maintenance SET guard_manifest_digest=$1 WHERE singleton=1",[hash]);
}

import type { PoolClient } from "pg";
import { checksumOf, migrationSql } from "../../db/migrate.ts";
import { migrations } from "../../db/migrations/index.ts";
import { assertPostgresGuardCoverage } from "../schema-guards.ts";
import { canonicalJson } from "./canonical.ts";
import { MaintenanceFailure } from "./error.ts";
import { buildDatabaseManifests, digestRowMultiset } from "./manifests.ts";
import type { DatabaseManifests, Json } from "./types.ts";

export type PostgresReader = Pick<PoolClient, "query">;
export const POSTGRES_TYPE_PROFILE = ["16", "17", "20", "21", "23", "25", "114", "700", "701", "1042", "1043",
  "1082", "1083", "1114", "1184", "1186", "1266", "1700", "2950", "3802"] as const;
const supportedTypes = new Set<string>(POSTGRES_TYPE_PROFILE);
export function quotePostgresIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

/** Values arrive through explicit ::text projections, never pg's numeric/date/JSON parsers. */
export function encodePostgresCell(typeOid: string, value: string | null): Json {
  if (!supportedTypes.has(typeOid)) throw new MaintenanceFailure("schema_guard_incomplete");
  if (value !== null && typeof value !== "string") throw new MaintenanceFailure("snapshot_invalid");
  return [`pg:${typeOid}`, value];
}

export interface PostgresTable { readonly oid: string; readonly name: string }
export interface PostgresCatalog {
  readonly schema: Json;
  readonly tables: readonly PostgresTable[];
  readonly columns: ReadonlyMap<string, readonly Readonly<Record<string, Json>>[]>;
  readonly sequence: Readonly<Record<string, Json>>;
}
async function rows(client: PostgresReader, sql: string, parameters: unknown[] = []): Promise<Readonly<Record<string, Json>>[]> {
  const result = (await client.query(sql, parameters)).rows;
  // Driver-created Dates, lossy integers and non-JSON objects are never silently serialized.
  try { canonicalJson(result); }
  catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
  return result as Readonly<Record<string, Json>>[];
}

function acl(expression: string): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object('grantor',grantor.rolname,
    'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,
    'privilege',a.privilege_type,'grantable',a.is_grantable)
    ORDER BY grantor.rolname,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,a.privilege_type,a.is_grantable)
    FROM pg_catalog.aclexplode(${expression}) a
    LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee),'[]'::jsonb)`;
}

export async function listPostgresTables(client: PostgresReader, schema: string): Promise<PostgresTable[]> {
  const found = (await client.query(`SELECT c.oid::text,c.relname AS name,c.relkind,c.relpersistence,c.relispartition,
      c.relrowsecurity,c.relforcerowsecurity,c.reltablespace::text,am.amname
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','S') ORDER BY c.relname`, [schema])).rows;
  if (!found.length || found.some(r => r.relkind !== "r" || r.relpersistence !== "p" || r.relispartition
    || r.relrowsecurity || r.relforcerowsecurity || r.reltablespace !== "0" || r.amname !== "heap"))
    throw new MaintenanceFailure("schema_guard_incomplete");
  return found.map(row => ({ oid: String(row.oid), name: String(row.name) }));
}

/** Plain guarded application schema profile; unsupported state is rejected before dumping. */
async function assertScopeClosure(client: PostgresReader, schema: string): Promise<void> {
  const unsupported = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname<>'plpgsql') OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_publication) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_subscription WHERE subdbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_server) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid OR c.oid=i.inhparent
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid
      LEFT JOIN pg_catalog.pg_type element ON element.oid=t.typelem
      LEFT JOIN pg_catalog.pg_class element_table ON element_table.oid=element.typrelid
      WHERE n.nspname=$1 AND NOT (t.typtype='c' AND c.relkind='r'
        OR t.typcategory='A' AND element.typtype='c' AND element_table.relkind='r')) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_conversion c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid=o.opfnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid=d.dictnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_ts_parser p JOIN pg_catalog.pg_namespace n ON n.oid=p.prsnamespace WHERE n.nspname=$1) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_ts_template t JOIN pg_catalog.pg_namespace n ON n.oid=t.tmplnamespace WHERE n.nspname=$1)
    AS unsupported`, [schema])).rows[0]?.unsupported;
  if (unsupported !== false) throw new MaintenanceFailure("schema_guard_incomplete");
  // pg_depend also catches outward/inward FKs, defaults, custom types/collations and extension membership.
  const cross = (await client.query(`SELECT 1 FROM (SELECT * FROM pg_catalog.pg_depend WHERE classid<>0 AND refclassid<>0) d
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.classid,d.objid,d.objsubid) origin
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) target
    WHERE ((origin.schema=$1 AND target.schema IS NOT NULL AND target.schema NOT IN ($1,'pg_catalog'))
       OR (target.schema=$1 AND origin.schema IS NOT NULL AND origin.schema NOT IN ($1,'pg_catalog')))
      AND NOT (d.deptype='i' AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass
        AND origin.schema='pg_toast' AND target.schema=$1
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_class toast_relation WHERE toast_relation.oid=d.objid AND toast_relation.relkind='t'))
    LIMIT 1`, [schema])).rows;
  if (cross.length) throw new MaintenanceFailure("schema_guard_incomplete");
  const labels = (await client.query(`SELECT 1 FROM pg_catalog.pg_seclabel l
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(l.classoid,l.objoid,l.objsubid) object
    WHERE object.schema=$1 OR (l.classoid='pg_namespace'::regclass AND l.objoid=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1)) LIMIT 1`, [schema])).rows;
  if (labels.length) throw new MaintenanceFailure("schema_guard_incomplete");
}

/** The production migration table has one identity sequence. It is not MVCC/table-lock protected.
 * Only its exact internal ownership/dependency profile is supported; the adapter additionally
 * requires sealed/no writers and compares these values before/after dump and actual restoration.
 */
async function readMigrationSequence(client: PostgresReader, schema: string): Promise<Readonly<Record<string, Json>>> {
  const sequences = await rows(client, `SELECT s.relname AS name,s.oid::text AS oid,r.rolname AS owner,
    s.relpersistence AS persistence,s.reltablespace::text AS tablespace,q.seqtypid::text AS type_oid,
    q.seqstart::text AS start,q.seqincrement::text AS increment,q.seqmax::text AS maximum,q.seqmin::text AS minimum,
    q.seqcache::text AS cache,q.seqcycle AS cycle,t.relname AS owner_table,a.attname AS owner_column,
    a.attidentity AS identity,d.deptype AS dependency_type,tn.nspname AS owner_schema,
    ${acl("COALESCE(s.relacl,pg_catalog.acldefault('s',s.relowner))")} AS acl,
    pg_catalog.obj_description(s.oid,'pg_class') AS comment,
    (SELECT count(*)::text FROM pg_catalog.pg_depend incoming WHERE incoming.refclassid='pg_class'::regclass
      AND incoming.refobjid=s.oid) AS incoming_dependencies
    FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid JOIN pg_catalog.pg_roles r ON r.oid=s.relowner
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.objsubid=0
      AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class t ON t.oid=d.refobjid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE n.nspname=$1 AND s.relkind='S' ORDER BY s.relname`, [schema]);
  const sequence = sequences[0];
  if (sequences.length !== 1 || !sequence || sequence.owner_schema !== schema || sequence.owner_table !== "schema_migrations"
    || sequence.owner_column !== "version" || sequence.identity !== "d" || sequence.dependency_type !== "i"
    || sequence.incoming_dependencies !== "0" || sequence.type_oid !== "23" || sequence.cache !== "1"
    || sequence.persistence !== "p" || sequence.tablespace !== "0") throw new MaintenanceFailure("schema_guard_incomplete");
  // OIDs change on restoration. The semantic OWNED BY identity is retained above instead.
  const { oid: _oid, ...manifest } = sequence;
  return manifest;
}

export async function readPostgresSequenceState(client: PostgresReader, schema: string, name: string): Promise<readonly Json[]> {
  const state = (await client.query(`SELECT last_value::text,is_called::text FROM ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`)).rows;
  if (state.length !== 1 || typeof state[0].last_value !== "string" || !["true", "false"].includes(state[0].is_called))
    throw new MaintenanceFailure("snapshot_invalid");
  return [[encodePostgresCell("20", state[0].last_value), encodePostgresCell("16", state[0].is_called)]];
}

export function readPostgresMigrationFunctionBodies(sql: string): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  const header = /CREATE\s+FUNCTION\s+([A-Za-z_]\w*)\s*\(\)\s+RETURNS\s+trigger\s+LANGUAGE\s+plpgsql\s+AS\s+/gi;
  for (let match = header.exec(sql); match; match = header.exec(sql)) {
    const delimiter = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(header.lastIndex))?.[0];
    if (!delimiter) throw new MaintenanceFailure("schema_guard_incomplete");
    const start = header.lastIndex + delimiter.length;
    // SQL keywords are case-insensitive; dollar tags are not. A regexp /i
    // backreference would incorrectly accept $Tag$ ... $tag$ as a closed body.
    const end = sql.indexOf(delimiter, start);
    if (end < 0) throw new MaintenanceFailure("schema_guard_incomplete");
    bodies.set(match[1]!, sql.slice(start, end));
    header.lastIndex = end + delimiter.length;
  }
  return bodies;
}

function knownFunctionBodies(): ReadonlyMap<string, string> {
  const bodies = new Map<string, string>();
  for (const migration of migrations) {
    const sql = migrationSql(migration, "postgres");
    for (const [name, body] of readPostgresMigrationFunctionBodies(sql)) bodies.set(name, body);
  }
  return bodies;
}

export async function readPostgresRoles(client: PostgresReader, names: readonly string[]): Promise<Json> {
  return rows(client, `WITH RECURSIVE selected(oid) AS (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])
    UNION SELECT membership.roleid FROM pg_catalog.pg_auth_members membership JOIN selected ON selected.oid=membership.member
    ) SELECT rolname AS name,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
    rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text AS valid_until,
    COALESCE(ARRAY(SELECT value FROM unnest(rolconfig) value ORDER BY value),'{}') AS settings,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('role',parent.rolname,'grantor',grantor.rolname,
      'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY parent.rolname,grantor.rolname)
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor WHERE m.member=r.oid),'[]'::jsonb) AS memberships
    FROM pg_catalog.pg_roles r WHERE oid IN (SELECT oid FROM selected) ORDER BY rolname`, [[...names]]);
}

export async function readPostgresEnvironment(client: PostgresReader): Promise<Json> {
  const database = await rows(client, `SELECT pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,
    d.datcollate AS collate,d.datctype AS ctype,d.datlocprovider AS locale_provider,d.daticulocale AS icu_locale,
    d.daticurules AS icu_rules,d.datcollversion AS collation_version,t.spcname AS default_tablespace
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_tablespace t ON t.oid=d.dattablespace WHERE d.datname=current_database()`);
  if (database.length !== 1 || database[0]!.default_tablespace !== "pg_default") throw new MaintenanceFailure("schema_guard_incomplete");
  const settings = await rows(client, `SELECT CASE WHEN s.setdatabase=0 THEN 'cluster-role' ELSE 'database-role' END AS scope,
    CASE WHEN s.setrole=0 THEN 'ALL' ELSE r.rolname END AS role,
    ARRAY(SELECT value FROM unnest(s.setconfig) value ORDER BY value) AS settings
    FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
    WHERE s.setdatabase=0 OR s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
    ORDER BY scope,role`);
  const extensions = await rows(client, `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,
    r.rolname AS owner,e.extrelocatable AS relocatable FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace JOIN pg_catalog.pg_roles r ON r.oid=e.extowner ORDER BY e.extname`);
  return { database, settings, extensions };
}

/** Full restorable catalog for the declared, closed schema. Physical OIDs are identity, not restore equality. */
export async function readPostgresCatalog(client: PostgresReader, schema: string): Promise<PostgresCatalog> {
  await assertScopeClosure(client, schema);
  try { await assertPostgresGuardCoverage(client); }
  catch { throw new MaintenanceFailure("schema_guard_incomplete"); }
  const applied = await rows(client, `SELECT m.version::text AS version,m.name,m.checksum,m.applied_at::text AS applied_at
    FROM ${quotePostgresIdentifier(schema)}.schema_migrations AS m ORDER BY m.version`);
  if (applied.length !== migrations.length || applied.some((row, i) => row.version !== String(migrations[i]!.version)
    || row.name !== migrations[i]!.name || row.checksum !== checksumOf(migrationSql(migrations[i]!, "postgres"))))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const tables = await listPostgresTables(client, schema);
  const sequence = await readMigrationSequence(client, schema);
  const namespace = await rows(client, `SELECT n.nspname AS name,r.rolname AS owner,
    ${acl("COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))")} AS acl,
    pg_catalog.obj_description(n.oid,'pg_namespace') AS comment
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname=$1`, [schema]);
  if (namespace.length !== 1) throw new MaintenanceFailure("source_missing");
  const relations = await rows(client, `SELECT c.relname AS name,r.rolname AS owner,c.relkind AS kind,
    c.relpersistence AS persistence,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
    c.relreplident AS replica_identity,am.amname AS access_method,
    COALESCE(ARRAY(SELECT value FROM unnest(c.reloptions) value ORDER BY value),'{}') AS options,
    ${acl("COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))")} AS acl,
    pg_catalog.obj_description(c.oid,'pg_class') AS comment
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid=c.relowner LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`, [schema]);
  // Column ACLs add to table privileges. NULL/empty means no column grants; aclexplode
  // accepts NULL but rejects a zero-dimensional '{}' ACL. Preserve every nonempty ACL.
  const allColumns = await rows(client, `SELECT c.relname AS table_name,a.attname AS name,
    (row_number() OVER(PARTITION BY c.oid ORDER BY a.attnum))::text AS position,
    a.atttypid::text AS type_oid,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    a.atttypmod AS type_modifier,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,
    a.attstorage AS storage,a.attcompression AS compression,a.attstattarget AS statistics,
    co.collname AS collation,cn.nspname AS collation_schema,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_expression,
    ${acl("CASE WHEN pg_catalog.cardinality(a.attacl)>0 THEN a.attacl END")} AS acl,
    pg_catalog.col_description(c.oid,a.attnum) AS comment
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [schema]);
  if (allColumns.some(c => !supportedTypes.has(String(c.type_oid)) || c.generated !== ""
    || (c.identity !== "" && !(c.table_name === "schema_migrations" && c.name === "version" && c.identity === "d"))))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const columns = new Map<string, readonly Readonly<Record<string, Json>>[]>();
  for (const table of tables) {
    const entries = allColumns.filter(column => column.table_name === table.name);
    if (!entries.length) throw new MaintenanceFailure("schema_guard_incomplete");
    columns.set(table.name, entries);
  }
  const constraints = await rows(client, `SELECT c.conname AS name,r.relname AS table_name,c.contype AS type,
    c.condeferrable AS deferrable,c.condeferred AS initially_deferred,c.convalidated AS validated,
    pg_catalog.pg_get_constraintdef(c.oid,false) AS definition,
    pg_catalog.obj_description(c.oid,'pg_constraint') AS comment
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace
    LEFT JOIN pg_catalog.pg_class r ON r.oid=c.conrelid WHERE n.nspname=$1 ORDER BY r.relname,c.conname`, [schema]);
  if (constraints.some(c => c.validated !== true)) throw new MaintenanceFailure("schema_guard_incomplete");
  const indexes = await rows(client, `SELECT idx.relname AS name,t.relname AS table_name,am.amname AS access_method,
    pg_catalog.pg_get_indexdef(i.indexrelid,0,false) AS definition,i.indisvalid AS valid,i.indisready AS ready,
    i.indisclustered AS clustered,i.indisreplident AS replica_identity,
    COALESCE(ARRAY(SELECT value FROM unnest(idx.reloptions) value ORDER BY value),'{}') AS options,
    idx.reltablespace::text AS tablespace,pg_catalog.obj_description(idx.oid,'pg_class') AS comment
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid=idx.relam WHERE n.nspname=$1 ORDER BY t.relname,idx.relname`, [schema]);
  if (indexes.some(index => !index.valid || !index.ready || index.tablespace !== "0" || index.access_method !== "btree"))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const functions = await rows(client, `SELECT p.proname AS name,p.prokind AS kind,p.pronargs AS argument_count,
    l.lanname AS language,p.prosrc AS body,p.prosecdef AS security_definer,p.provolatile AS volatility,
    r.rolname AS owner,pg_catalog.pg_get_functiondef(p.oid) AS definition,
    ${acl("COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))")} AS acl,
    pg_catalog.obj_description(p.oid,'pg_proc') AS comment
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE n.nspname=$1 ORDER BY p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid)`, [schema]);
  const expectedFunctions = knownFunctionBodies();
  if (functions.length !== expectedFunctions.size + 1 || functions.some(f => f.kind !== "f" || f.argument_count !== 0
    || f.language !== "plpgsql" || f.security_definer !== false
    || (f.name !== "boardroom_storage_write_guard" && f.body !== expectedFunctions.get(String(f.name)))))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const triggers = await rows(client, `SELECT c.relname AS table_name,t.tgname AS name,
    t.tgenabled AS enabled,pg_catalog.pg_get_triggerdef(t.oid,false) AS definition,
    pg_catalog.obj_description(t.oid,'pg_trigger') AS comment
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`, [schema]);
  const internalTriggers = await rows(client, `SELECT c.relname AS table_name,co.conname AS constraint_name,
    t.tgtype AS event_type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred,
    pn.nspname AS function_schema,p.proname AS function_name
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    LEFT JOIN pg_catalog.pg_constraint co ON co.oid=t.tgconstraint
    WHERE n.nspname=$1 AND t.tgisinternal ORDER BY c.relname,co.conname,t.tgtype,p.proname`, [schema]);
  if (triggers.some(t => t.enabled !== "O") || internalTriggers.some(t => t.enabled !== "O" || !t.constraint_name))
    throw new MaintenanceFailure("schema_guard_incomplete");
  const defaults = await rows(client, `SELECT r.rolname AS owner,d.defaclobjtype AS type,
    ${acl("d.defaclacl")} AS acl FROM pg_catalog.pg_default_acl d
    JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    WHERE n.nspname=$1 ORDER BY r.rolname,d.defaclobjtype`, [schema]);
  // Global default ACLs are external schema dependencies and are not selected by --schema.
  if ((await client.query("SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclnamespace=0 LIMIT 1")).rows.length)
    throw new MaintenanceFailure("schema_guard_incomplete");
  const environment = await readPostgresEnvironment(client);
  const roleNames = new Set<string>();
  const collectRoles = (value: Json): void => {
    if (Array.isArray(value)) { for (const item of value) collectRoles(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["owner", "grantor", "grantee"].includes(key) && typeof item === "string" && item !== "PUBLIC") roleNames.add(item);
      else collectRoles(item);
    }
  };
  collectRoles([namespace, relations, allColumns, functions, defaults, environment, sequence]);
  const roles = await readPostgresRoles(client, [...roleNames].sort());
  return { tables, columns, sequence, schema: { profile: "boardroom-pg16-closed-schema-v1", serverMajor: 16,
    scope: { kind: "schema", name: schema, clusterRolesIncluded: false }, typeProfile: POSTGRES_TYPE_PROFILE,
    namespace, relations, columns: allColumns, constraints, indexes, functions, triggers, internalTriggers,
    defaultPrivileges: defaults, environment, requiredRoles: roles, migrationIdentitySequence: sequence, migrations: applied } };
}

function rawCell(typeOid: string, value: string | null): Json {
  if (value === null) return null;
  if (typeOid === "16") return value === "true";
  if (typeOid === "21" || typeOid === "23") {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) throw new MaintenanceFailure("snapshot_invalid");
    return integer;
  }
  return value;
}

export async function readPostgresManifests(client: PostgresReader, schema: string): Promise<DatabaseManifests> {
  const catalog = await readPostgresCatalog(client, schema);
  const manifests: DatabaseManifests["tables"][number][] = [];
  const controlRows: { storage_maintenance: Readonly<Record<string, Json>>[]; storage_source_clients: Readonly<Record<string, Json>>[] } = {
    storage_maintenance: [], storage_source_clients: [],
  };
  for (const table of catalog.tables) {
    const columns = catalog.columns.get(table.name)!;
    const expressions = columns.map(column => column.type_oid === "1042"
      ? `pg_catalog.bpcharout(${quotePostgresIdentifier(String(column.name))})::pg_catalog.text`
      : `${quotePostgresIdentifier(String(column.name))}::pg_catalog.text`);
    const records = (await client.query({ text: `SELECT ${expressions.join(",")} FROM ${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(table.name)}`,
      rowMode: "array" })).rows as (string | null)[][];
    const encoded = records.map(record => columns.map((column, index) => encodePostgresCell(String(column.type_oid), record[index]!)));
    manifests.push({ name: table.name, columns, ...digestRowMultiset(encoded) });
    if (table.name === "storage_maintenance" || table.name === "storage_source_clients") {
      controlRows[table.name] = records.map(record => Object.fromEntries(columns.map((column, index) =>
        [String(column.name), rawCell(String(column.type_oid), record[index]!)]))).sort((a, b) =>
          canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
    }
  }
  const sequenceName = String(catalog.sequence.name);
  manifests.push({ name: sequenceName, columns: [{ name: "last_value", type_oid: "20" }, { name: "is_called", type_oid: "16" }],
    ...digestRowMultiset(await readPostgresSequenceState(client, schema, sequenceName)) });
  return buildDatabaseManifests("postgres", catalog.schema, manifests, controlRows);
}

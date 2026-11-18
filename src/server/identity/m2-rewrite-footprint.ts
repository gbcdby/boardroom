import type { DbReadSnapshot } from "../db/driver.ts";
import { checksumOf, migrationSql } from "../db/migrate.ts";
import { migrations } from "../db/migrations/index.ts";
import { canonicalJson, sha256 } from "../storage/maintenance/canonical.ts";

type Dialect = "sqlite" | "postgres";
type Code = "invalid_dialect" | "catalog_unavailable" | "catalog_budget" | "unsupported_catalog"
  | "unexpected_inbound_fk" | "legacy_unique_mismatch" | "migration_baseline_mismatch";
type Scalar = string | number | boolean | null;
type Row = Readonly<Record<string, Scalar>>;
const errors = new WeakMap<object, Code>();
const CODES: readonly Code[] = ["invalid_dialect", "catalog_unavailable", "catalog_budget", "unsupported_catalog", "unexpected_inbound_fk", "legacy_unique_mismatch", "migration_baseline_mismatch"];

export class M2RewriteFootprintError extends Error {
  override readonly name = "M2RewriteFootprintError";
  readonly code: Code;
  constructor(code: Code) {
    const fixed = CODES.includes(code) ? code : "catalog_unavailable";
    super(`M2_REWRITE_FOOTPRINT: ${fixed}`); this.code = fixed; errors.set(this, fixed);
  }
}

export interface M2ForeignKeyFootprint {
  readonly schema: string; readonly table: string; readonly tableOid: string | null;
  readonly id: string; readonly name: string | null;
  readonly targetSchema: string; readonly targetTable: string; readonly targetOid: string | null;
  readonly updateAction: string; readonly deleteAction: string; readonly match: string;
  readonly deferrable: boolean | null; readonly initiallyDeferred: boolean | null;
  readonly validated: boolean | null; readonly local: boolean | null;
  readonly parent: string | null; readonly inheritanceCount: number | null; readonly noInherit: boolean | null;
  readonly pairs: readonly Row[];
}
export interface M2IndexFootprint { readonly metadata: Row; readonly items: readonly Row[] }
export interface M2RelationFootprint {
  readonly schema: string; readonly name: string; readonly oid: string | null;
  readonly createSql: string | null; readonly metadata: Row; readonly columns: readonly Row[];
  readonly foreignKeys: readonly M2ForeignKeyFootprint[]; readonly indexes: readonly M2IndexFootprint[];
  readonly constraints: readonly Row[] | null; readonly triggers: readonly Row[];
}
export interface M2UniqueFootprint {
  readonly keys: readonly string[]; readonly constraintName: string | null;
  readonly indexName: string; readonly indexOid: string | null; readonly flags: Row;
}
/** Structural evidence only: no SourceRef, writer permission or executable rewrite. */
export interface M2RewriteFootprint {
  readonly kind: "m2-rewrite-footprint"; readonly dialect: Dialect;
  readonly namespace: { readonly name: string; readonly oid: string | null };
  readonly migrations: readonly Row[]; readonly relations: readonly M2RelationFootprint[];
  readonly incomingForeignKeys: readonly M2ForeignKeyFootprint[];
  readonly legacyBindingUniques: readonly M2UniqueFootprint[]; readonly digest: string;
}

const COLUMNS = {
  agent_runner_states: "binding_id state phase generation lease_owner lease_expires_at applied_json harness_session_id session_key session_state pid exit_confirmed observed_at started_at attempt_count next_retry_at last_error_code last_exit_code last_exit_signal permission_observed updated_at process_identity_json",
  agent_runtime_bindings: "id runtime_id project_id group_id member_id revision overrides_json advanced_json desired_state intent_revision requested_snapshot_json reset_session_requested created_at updated_at",
  agent_runtime_members: "member_id runtime_id project_id binding_id generation lease_owner lease_expires_at updated_at",
  storage_maintenance: "singleton database_instance_id control_root_json mutex_identity_json fence_epoch admission active_migration_id plan_digest owner_generation journal_record_ref journal_digest journal_sequence protocol_version guard_manifest_digest",
  storage_source_clients: "client_id database_instance_id entrypoint build_id protocol_version host_identity_json process_identity_json db_sessions_json registered_epoch observed_epoch drain_epoch drain_state drain_receipt_digest registered_at last_observed_at ended_at",
} as const;
type Table = keyof typeof COLUMNS;
const TABLES = Object.keys(COLUMNS) as Table[];
const FOCUS = "('agent_runner_states','agent_runtime_bindings','agent_runtime_members','storage_maintenance','storage_source_clients')";
const OIDS = "(?::oid,?::oid,?::oid,?::oid,?::oid)";
const NEW_RELATIONS = new Set("agent_profiles agent_profile_versions group_bindings group_binding_config_versions legacy_config_captures config_snapshots config_detach_snapshots config_workspace_mappings config_authority config_activation_receipts config_mutation_receipts".split(" "));
const INTEGER_COLUMNS = new Set([
  "agent_runtime_bindings.revision", "agent_runtime_bindings.intent_revision", "agent_runtime_bindings.reset_session_requested",
  "agent_runner_states.generation", "agent_runner_states.pid", "agent_runner_states.exit_confirmed", "agent_runner_states.attempt_count", "agent_runner_states.last_exit_code",
  "agent_runtime_members.generation", "storage_maintenance.singleton", "storage_maintenance.protocol_version", "storage_source_clients.protocol_version",
]);
const BIGINT_COLUMNS = new Set([
  "storage_maintenance.fence_epoch", "storage_maintenance.owner_generation", "storage_maintenance.journal_sequence",
  "storage_source_clients.registered_epoch", "storage_source_clients.observed_epoch", "storage_source_clients.drain_epoch",
]);
const REQUIRED_INDEXES: Readonly<Record<string, { readonly table: Table; readonly keys: readonly string[] }>> = {
  ix_runtime_bindings_project: { table: "agent_runtime_bindings", keys: ["project_id", "group_id"] },
  ix_runtime_bindings_desired: { table: "agent_runtime_bindings", keys: ["desired_state"] },
  ix_bindings_member_seek: { table: "agent_runtime_bindings", keys: ["member_id", "id"] },
  ix_runtime_members_runtime: { table: "agent_runtime_members", keys: ["runtime_id"] },
  storage_source_clients_epoch: { table: "storage_source_clients", keys: ["registered_epoch", "ended_at"] },
};
const UNIQUE_KEYS = [["runtime_id", "project_id", "group_id"], ["member_id", "group_id"]] as const;
const BYTE_LIMIT = 2 * 1024 * 1024;
function fail(code: Code = "unsupported_catalog"): never { throw new M2RewriteFootprintError(code); }
function str(row: Row, key: string): string { return row[key] as string; }
function num(row: Row, key: string): number { return row[key] as number; }
function bit(value: Scalar | undefined): boolean { if (value !== 0 && value !== 1) fail(); return value === 1; }
function same(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((x, i) => x === b[i]); }
function cmp(a: string, b: string): number {
  const aa = Array.from(a), bb = Array.from(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const delta = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!; if (delta) return delta;
  }
  return aa.length - bb.length;
}
function unique(rows: readonly Row[], key: string): void {
  if (new Set(rows.map(r => r[key])).size !== rows.length) fail();
}
function members(rows: readonly Row[], key: string, allowed: readonly string[]): void {
  const set = new Set(allowed); if (rows.some(r => !set.has(str(r, key)))) fail();
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Copy each external array/row from one own-key snapshot. No getter/toJSON/prototype inspection. */
function snapshotRows(input: unknown, shape: string): Row[] {
  if (!Array.isArray(input)) fail();
  const keys = Reflect.ownKeys(input);
  const descriptors = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(input, k)]));
  const length = descriptors.get("length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) fail();
  if (length.value > 4096) fail("catalog_budget");
  if (keys.length !== length.value + 1) fail();
  const fields = shape.split(" ").map(part => part.split(":"));
  const allowed = new Set(fields.map(([name]) => name));
  const copied: Row[] = [];
  for (let i = 0; i < length.value; i++) {
    const entry = descriptors.get(String(i));
    if (!entry || !("value" in entry) || !entry.enumerable || entry.value === null || typeof entry.value !== "object") fail();
    const rowKeys = Reflect.ownKeys(entry.value);
    if (rowKeys.length !== fields.length || rowKeys.some(k => typeof k !== "string" || !allowed.has(k))) fail();
    const row = Object.create(null) as Record<string, Scalar>;
    for (const key of rowKeys as string[]) {
      const d = Object.getOwnPropertyDescriptor(entry.value, key);
      if (!d || !("value" in d) || !d.enumerable) fail();
      const v: unknown = d.value;
      const pattern = fields.find(([name]) => name === key)![1]!;
      if (v === null && pattern.endsWith("?")) { row[key] = null; continue; }
      const kind = pattern[0];
      if (kind === "s" || kind === "o" || kind === "z") {
        if (typeof v !== "string") fail();
        if (Buffer.byteLength(v, "utf8") > 65536) fail("catalog_budget");
        if ((kind === "o" || kind === "z") && (!/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > 4294967295n || kind === "o" && v === "0")) fail();
      } else if (kind === "n") { if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0)) fail(); }
      else if (kind === "b") { if (typeof v !== "boolean") fail(); }
      else fail();
      row[key] = v as Scalar;
    }
    copied.push(row);
  }
  return copied;
}
function reader(snapshot: DbReadSnapshot) {
  let queries = 0, bytes = 0;
  return async (sql: string, shape: string, params: readonly unknown[] = []): Promise<Row[]> => {
    if (++queries > 16) fail("catalog_budget");
    const rows = snapshotRows(await snapshot.query(sql, params), shape);
    bytes += Buffer.byteLength(canonicalJson(rows), "utf8");
    if (bytes > BYTE_LIMIT) fail("catalog_budget");
    return rows;
  };
}
type Reader = ReturnType<typeof reader>;
function baseline(rows: readonly Row[], dialect: Dialect): void {
  const expected = migrations.filter(m => m.version <= 21).slice().sort((a, b) => a.version - b.version);
  if (rows.length !== 21 || expected.length !== 21 || expected.some((m, i) => m.version !== i + 1
    || rows[i]!.version !== m.version || rows[i]!.name !== m.name || rows[i]!.checksum !== checksumOf(migrationSql(m, dialect)))) fail("migration_baseline_mismatch");
}
function columns(table: Table, rows: Row[], dialect: Dialect): Row[] {
  rows.sort((a, b) => num(a, "ordinal") - num(b, "ordinal"));
  const expected = COLUMNS[table].split(" ");
  if (rows.length !== expected.length || rows.some((r, i) => r.name !== expected[i] || r.ordinal !== i + (dialect === "sqlite" ? 0 : 1))) fail();
  for (const row of rows) {
    const key = `${table}.${str(row, "name")}`;
    const type = BIGINT_COLUMNS.has(key) ? "BIGINT" : INTEGER_COLUMNS.has(key) ? "INTEGER" : "TEXT";
    if (dialect === "sqlite") {
      if (row.type !== type || row.hidden !== 0) fail(); bit(row.not_null);
      if (!Number.isSafeInteger(row.pk) || num(row, "pk") < 0) fail();
    } else if (row.type_oid !== ({ TEXT: "25", INTEGER: "23", BIGINT: "20" } as const)[type]
      || row.dropped !== false || row.identity !== "" || row.generated !== "") fail();
  }
  return rows;
}
function indexKeys(index: M2IndexFootprint, dialect: Dialect): string[] | null {
  const m = index.metadata;
  if (dialect === "sqlite") {
    if (m.partial !== 0) return null;
    const key = index.items.filter(i => i.key === 1);
    if (!key.length || key.some(i => typeof i.name !== "string" || num(i, "cid") < 0 || i.desc !== 0 || i.collation !== "BINARY")) return null;
    return key.map(i => str(i, "name"));
  }
  if (m.predicate !== null || m.expressions !== null || m.valid !== true || m.ready !== true || m.live !== true
    || m.immediate !== true || m.nulls_not_distinct !== false || m.access_method !== "btree" || m.key_count !== m.item_count) return null;
  if (!index.items.length || index.items.some(i => i.key !== true || typeof i.name !== "string" || num(i, "attnum") <= 0 || i.options !== 0)) return null;
  return index.items.map(i => str(i, "name"));
}
function incoming(fks: readonly M2ForeignKeyFootprint[], namespace: string, dialect: Dialect): M2ForeignKeyFootprint[] {
  const result = fks.filter(fk => fk.targetSchema === namespace && TABLES.includes((dialect === "sqlite" ? fk.targetTable.toLowerCase() : fk.targetTable) as Table));
  const signatures = [
    ["agent_runner_states", "binding_id", "agent_runtime_bindings", "id", "CASCADE"],
    ["agent_runtime_members", "binding_id", "agent_runtime_bindings", "id", "RESTRICT"],
    ["storage_source_clients", "database_instance_id", "storage_maintenance", "database_instance_id", "NO ACTION"],
  ];
  if (result.length !== 3 || signatures.some(([table, from, target, to, deletion]) => result.filter(fk => fk.schema === namespace
    && fk.table === table && fk.targetTable === target && fk.pairs.length === 1 && fk.pairs[0]!.from_column === from
    && fk.pairs[0]!.to_column === to && fk.updateAction === "NO ACTION" && fk.deleteAction === deletion
    && (dialect === "sqlite" ? fk.match === "NONE" : fk.match === "SIMPLE" && fk.validated === true && fk.deferrable === false
      && fk.initiallyDeferred === false && fk.local === true && fk.parent === "0" && fk.inheritanceCount === 0)).length !== 1)) fail("unexpected_inbound_fk");
  return result;
}
function keyRequirements(relations: readonly M2RelationFootprint[], dialect: Dialect): M2UniqueFootprint[] {
  const binding = relations.find(r => r.name === "agent_runtime_bindings")!;
  const uniques = binding.indexes.filter(i => dialect === "sqlite" ? i.metadata.unique === 1 && i.metadata.origin !== "pk"
    : i.metadata.unique === true && i.metadata.primary !== true);
  if (uniques.length !== 2) fail("legacy_unique_mismatch");
  const found = UNIQUE_KEYS.map(keys => {
    const candidates = uniques.filter(i => same(indexKeys(i, dialect) ?? [], keys));
    if (candidates.length !== 1) fail("legacy_unique_mismatch");
    const index = candidates[0]!;
    let constraintName: string | null = null;
    if (dialect === "sqlite") { if (index.metadata.origin !== "u") fail("legacy_unique_mismatch"); }
    else {
      const constraints = binding.constraints!.filter(c => c.type === "u" && c.index_oid === index.metadata.oid);
      const expectedPositions = keys.map(k => String(binding.columns.find(c => c.name === k)!.ordinal)).join(",");
      if (constraints.length !== 1 || constraints[0]!.keys !== expectedPositions || constraints[0]!.deferrable !== false
        || constraints[0]!.deferred !== false || constraints[0]!.validated !== true) fail("legacy_unique_mismatch");
      constraintName = str(constraints[0]!, "name");
    }
    return { keys: [...keys], constraintName, indexName: str(index.metadata, "name"),
      indexOid: dialect === "postgres" ? str(index.metadata, "oid") : null, flags: index.metadata };
  });
  for (const relation of relations) {
    const primary = COLUMNS[relation.name as Table].split(" ")[0]!;
    if (dialect === "sqlite") {
      const pk = relation.columns.filter(c => c.pk !== 0);
      if (pk.length !== 1 || pk[0]!.name !== primary || pk[0]!.pk !== 1) fail();
    } else {
      const pk = relation.constraints!.filter(c => c.type === "p");
      if (pk.length !== 1 || pk[0]!.keys !== "1") fail();
      const index = relation.indexes.find(i => i.metadata.oid === pk[0]!.index_oid);
      if (!index || index.metadata.primary !== true || !same(indexKeys(index, dialect) ?? [], [primary])) fail();
    }
    const otherUnique = relation.name === "agent_runner_states" ? "session_key" : relation.name === "storage_maintenance" ? "database_instance_id" : null;
    if (otherUnique && !relation.indexes.some(i => (dialect === "sqlite" ? i.metadata.unique === 1 : i.metadata.unique === true)
      && same(indexKeys(i, dialect) ?? [], [otherUnique]))) fail();
  }
  for (const [name, requirement] of Object.entries(REQUIRED_INDEXES)) {
    const found = relations.find(r => r.name === requirement.table)!.indexes.filter(i => i.metadata.name === name);
    if (found.length !== 1 || (dialect === "sqlite" ? found[0]!.metadata.unique !== 0 : found[0]!.metadata.unique !== false)
      || !same(indexKeys(found[0]!, dialect) ?? [], requirement.keys)) fail();
  }
  return found;
}

async function sqlite(q: Reader) {
  const catalog = await q("SELECT type,name,tbl_name AS table_name,sql AS definition FROM main.sqlite_schema ORDER BY type,name LIMIT 4097",
    "type:s name:s table_name:s definition:s?");
  if (catalog.some(r => !["table", "index", "view", "trigger"].includes(str(r, "type")))
    || new Set(catalog.map(r => canonicalJson([r.type, r.name]))).size !== catalog.length) fail();
  if (catalog.some(r => NEW_RELATIONS.has(str(r, "name").toLowerCase()))) fail("migration_baseline_mismatch");
  const tables = await q("SELECT name,type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 4097",
    "name:s type:s ncol:n wr:n strict:n");
  if (tables.length > 256) fail("catalog_budget");
  unique(tables, "name");
  if (tables.some(r => r.type !== "table")) fail();
  for (const table of tables) { if (num(table, "ncol") < 1) fail(); bit(table.wr); bit(table.strict); }
  const applied = await q("SELECT version,name,checksum FROM main.schema_migrations ORDER BY version LIMIT 4097", "version:n name:s checksum:s");
  baseline(applied, "sqlite");
  const allColumns = await q(`SELECT t.name AS table_name,x.cid AS ordinal,x.name,x.type,x."notnull" AS not_null,x.dflt_value AS default_expression,x.pk,x.hidden
    FROM pragma_table_list AS t JOIN pragma_table_xinfo(t.name,'main') AS x
    WHERE t.schema='main' AND t.name IN ${FOCUS} ORDER BY t.name,x.cid LIMIT 4097`,
  "table_name:s ordinal:n name:s type:s not_null:n default_expression:s? pk:n hidden:n");
  if (allColumns.length > 512) fail("catalog_budget");
  members(allColumns, "table_name", TABLES);
  const fkRows = await q(`SELECT t.name AS table_name,f.id,f.seq,f."table" AS target_table,f."from" AS from_column,f."to" AS to_column,
    f.on_update AS update_action,f.on_delete AS delete_action,f.match
    FROM pragma_table_list AS t JOIN pragma_foreign_key_list(t.name,'main') AS f
    WHERE t.schema='main' AND t.type='table' AND t.name NOT GLOB 'sqlite_*' ORDER BY t.name,f.id,f.seq LIMIT 4097`,
  "table_name:s id:n seq:n target_table:s from_column:s to_column:s? update_action:s delete_action:s match:s");
  members(fkRows, "table_name", tables.map(t => str(t, "name")));
  const fkGroups = new Map<string, Row[]>();
  for (const row of fkRows) { const key = `${str(row, "table_name")}\0${num(row, "id")}`; const group = fkGroups.get(key) ?? []; group.push(row); fkGroups.set(key, group); }
  const fks: M2ForeignKeyFootprint[] = [];
  for (const rows of fkGroups.values()) {
    const first = rows[0]!;
    if (num(first, "id") < 0 || rows.some((r, i) => r.seq !== i || ["target_table", "update_action", "delete_action", "match"].some(k => r[k] !== first[k]))) fail();
    if (!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(str(first, "update_action"))
      || !["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(str(first, "delete_action"))) fail();
    fks.push({ schema: "main", table: str(first, "table_name"), tableOid: null, id: String(first.id), name: null,
      targetSchema: "main", targetTable: str(first, "target_table"), targetOid: null, updateAction: str(first, "update_action"), deleteAction: str(first, "delete_action"), match: str(first, "match"),
      deferrable: null, initiallyDeferred: null, validated: null, local: null, parent: null, inheritanceCount: null, noInherit: null,
      pairs: rows.map(r => ({ ordinal: r.seq!, from_column: r.from_column!, to_column: r.to_column!, from_attnum: null, to_attnum: null })) });
  }
  const indexRows = await q(`SELECT t.name AS table_name,i.seq,i.name,i."unique" AS "unique",i.origin,i.partial
    FROM pragma_table_list AS t JOIN pragma_index_list(t.name,'main') AS i WHERE t.schema='main' AND t.name IN ${FOCUS}
    ORDER BY t.name,i.name LIMIT 4097`, "table_name:s seq:n name:s unique:n origin:s partial:n");
  const itemRows = await q(`SELECT t.name AS table_name,i.name AS index_name,x.seqno AS ordinal,x.cid,x.name,x."desc" AS "desc",x.coll AS collation,x."key" AS "key"
    FROM pragma_table_list AS t JOIN pragma_index_list(t.name,'main') AS i JOIN pragma_index_xinfo(i.name,'main') AS x
    WHERE t.schema='main' AND t.name IN ${FOCUS} ORDER BY t.name,i.name,x.seqno LIMIT 4097`,
  "table_name:s index_name:s ordinal:n cid:n name:s? desc:n collation:s key:n");
  members(indexRows, "table_name", TABLES); members(itemRows, "table_name", TABLES);
  if (itemRows.some(item => !indexRows.some(i => i.table_name === item.table_name && i.name === item.index_name))) fail();
  const relations = TABLES.map(name => {
    const table = tables.find(r => r.name === name), definition = catalog.filter(r => r.type === "table" && r.name === name);
    if (!table || definition.length !== 1 || definition[0]!.definition === null) fail();
    bit(table.wr); bit(table.strict);
    const cols = columns(name, allColumns.filter(r => r.table_name === name), "sqlite");
    if (table.ncol !== cols.length) fail();
    const indexes = indexRows.filter(r => r.table_name === name).map(row => {
      bit(row.unique); bit(row.partial); if (!["c", "u", "pk"].includes(str(row, "origin"))) fail();
      const items = itemRows.filter(r => r.table_name === name && r.index_name === row.name);
      if (items.length > 32) fail("catalog_budget");
      if (!items.length || items.some((i, n) => i.ordinal !== n)) fail();
      for (const item of items) { bit(item.key); bit(item.desc); }
      const original = catalog.filter(c => c.type === "index" && c.name === row.name && c.table_name === name);
      if (original.length !== 1) fail();
      return { metadata: { ...row, oid: null, definition: original[0]!.definition! }, items };
    });
    unique(indexes.map(i => i.metadata), "name");
    return { schema: "main", name, oid: null, createSql: str(definition[0]!, "definition"), metadata: { ...table,
      persistence: null, partition: null, row_security: null, force_row_security: null, access_method: null, inheritance: null }, columns: cols,
      foreignKeys: fks.filter(f => f.table === name), indexes, constraints: null,
      triggers: catalog.filter(r => r.type === "trigger" && r.table_name === name).sort((a, b) => cmp(str(a, "name"), str(b, "name"))) };
  });
  return { namespace: { name: "main", oid: null }, applied, relations, fks };
}

async function postgres(q: Reader) {
  const namespaces = await q("SELECT n.nspname AS name,n.oid::text AS oid FROM pg_catalog.pg_namespace AS n WHERE n.nspname=pg_catalog.current_schema() LIMIT 4097", "name:s oid:o");
  if (namespaces.length !== 1) fail();
  const namespace = { name: str(namespaces[0]!, "name"), oid: str(namespaces[0]!, "oid") };
  const catalog = await q(`SELECT c.oid::text AS oid,c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    c.relispartition AS partition,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,a.amname AS access_method,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits AS h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid) AS inheritance
    FROM pg_catalog.pg_class AS c LEFT JOIN pg_catalog.pg_am AS a ON a.oid=c.relam WHERE c.relnamespace=?::oid ORDER BY c.relname LIMIT 4097`,
  "oid:o name:s kind:s persistence:s partition:b row_security:b force_row_security:b access_method:s? inheritance:b", [namespace.oid]);
  unique(catalog, "name"); unique(catalog, "oid");
  if (catalog.filter(r => ["r", "p", "v", "m", "f"].includes(str(r, "kind"))).length > 256) fail("catalog_budget");
  if (catalog.some(r => NEW_RELATIONS.has(str(r, "name")))) fail("migration_baseline_mismatch");
  const tableRow = (name: string) => {
    const r = catalog.find(c => c.name === name);
    if (!r || r.kind !== "r" || r.persistence !== "p" || r.partition !== false || r.row_security !== false
      || r.force_row_security !== false || r.inheritance !== false || r.access_method !== "heap") fail();
    return r;
  };
  const selected = TABLES.map(tableRow), ids = selected.map(r => str(r, "oid"));
  const migrationOid = str(tableRow("schema_migrations"), "oid");
  const applied = await q(`SELECT m.version,m.name,m.checksum FROM schema_migrations AS m
    WHERE m.tableoid=?::oid AND pg_catalog.to_regclass('schema_migrations')::oid=?::oid
      AND (SELECT n.oid FROM pg_catalog.pg_namespace AS n WHERE n.nspname=pg_catalog.current_schema())=?::oid
    ORDER BY m.version LIMIT 4097`, "version:n name:s checksum:s", [migrationOid, migrationOid, namespace.oid]);
  baseline(applied, "postgres");
  const allColumns = await q(`SELECT a.attrelid::text AS table_oid,a.attnum AS ordinal,a.attname AS name,a.atttypid::text AS type_oid,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_expression,a.attisdropped AS dropped,
    a.attidentity AS identity,a.attgenerated AS generated,a.attcollation::text AS collation_oid
    FROM pg_catalog.pg_attribute AS a LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid IN ${OIDS} AND a.attnum>0 ORDER BY a.attrelid,a.attnum LIMIT 4097`,
  "table_oid:o ordinal:n name:s type_oid:z type:s not_null:b default_expression:s? dropped:b identity:s generated:s collation_oid:z", ids);
  if (allColumns.length > 512) fail("catalog_budget");
  members(allColumns, "table_oid", ids);
  const constraints = await q(`SELECT c.conrelid::text AS table_oid,c.oid::text AS oid,c.conname AS name,c.contype AS type,
    c.conindid::text AS index_oid,pg_catalog.array_to_string(c.conkey,',') AS keys,pg_catalog.array_to_string(c.confkey,',') AS target_keys,
    c.condeferrable AS deferrable,c.condeferred AS deferred,c.convalidated AS validated,c.conislocal AS local,
    c.conparentid::text AS parent,c.coninhcount AS inheritance_count,c.connoinherit AS no_inherit,
    pg_catalog.pg_get_constraintdef(c.oid,false) AS definition
    FROM pg_catalog.pg_constraint AS c WHERE c.conrelid IN ${OIDS} ORDER BY c.conrelid,c.oid LIMIT 4097`,
  "table_oid:o oid:o name:s type:s index_oid:z keys:s? target_keys:s? deferrable:b deferred:b validated:b local:b parent:z inheritance_count:n no_inherit:b definition:s", ids);
  if (constraints.some(c => !["p", "u", "f", "c"].includes(str(c, "type")))) fail();
  members(constraints, "table_oid", ids); unique(constraints, "oid");
  const fkRows = await q(`SELECT c.oid::text AS id,c.conname AS name,c.conrelid::text AS table_oid,n.nspname AS schema_name,t.relname AS table_name,
    c.confrelid::text AS target_oid,rn.nspname AS target_schema,rt.relname AS target_table,
    c.confupdtype AS update_action,c.confdeltype AS delete_action,c.confmatchtype AS match,
    c.condeferrable AS deferrable,c.condeferred AS deferred,c.convalidated AS validated,c.conislocal AS local,
    c.conparentid::text AS parent,c.coninhcount AS inheritance_count,c.connoinherit AS no_inherit,
    pg_catalog.cardinality(c.conkey) AS key_count,pg_catalog.cardinality(c.confkey) AS target_key_count,
    k.ordinality::integer AS ordinal,k.attnum AS from_attnum,c.confkey[k.ordinality::integer] AS to_attnum,
    a.attname AS from_column,ra.attname AS to_column
    FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_class AS t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid=t.relnamespace JOIN pg_catalog.pg_class AS rt ON rt.oid=c.confrelid
    JOIN pg_catalog.pg_namespace AS rn ON rn.oid=rt.relnamespace
    CROSS JOIN LATERAL pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(attnum,ordinality)
    LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
    LEFT JOIN pg_catalog.pg_attribute AS ra ON ra.attrelid=c.confrelid AND ra.attnum=c.confkey[k.ordinality::integer]
    WHERE c.contype='f' AND (c.conrelid IN ${OIDS} OR c.confrelid IN ${OIDS}) ORDER BY n.nspname,t.relname,c.oid,k.ordinality LIMIT 4097`,
  "id:o name:s table_oid:o schema_name:s table_name:s target_oid:o target_schema:s target_table:s update_action:s delete_action:s match:s deferrable:b deferred:b validated:b local:b parent:z inheritance_count:n no_inherit:b key_count:n target_key_count:n ordinal:n from_attnum:n to_attnum:n from_column:s to_column:s", [...ids, ...ids]);
  for (const row of fkRows) {
    const from = ids.indexOf(str(row, "table_oid")), to = ids.indexOf(str(row, "target_oid"));
    if (from < 0 && to < 0 || from >= 0 && (row.schema_name !== namespace.name || row.table_name !== TABLES[from])
      || to >= 0 && (row.target_schema !== namespace.name || row.target_table !== TABLES[to])) fail();
  }
  const groups = new Map<string, Row[]>();
  for (const row of fkRows) { const group = groups.get(str(row, "id")) ?? []; group.push(row); groups.set(str(row, "id"), group); }
  const actions: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  const matches: Record<string, string> = { s: "SIMPLE", f: "FULL", p: "PARTIAL" };
  const fks: M2ForeignKeyFootprint[] = [];
  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (rows.length !== first.key_count || rows.length !== first.target_key_count || rows.some((r, i) => r.ordinal !== i + 1
      || Object.keys(first).filter(k => !["ordinal", "from_attnum", "to_attnum", "from_column", "to_column"].includes(k)).some(k => r[k] !== first[k]))) fail();
    const update = actions[str(first, "update_action")], deletion = actions[str(first, "delete_action")], match = matches[str(first, "match")];
    if (!update || !deletion || !match) fail();
    fks.push({ schema: str(first, "schema_name"), table: str(first, "table_name"), tableOid: str(first, "table_oid"), id: str(first, "id"), name: str(first, "name"),
      targetSchema: str(first, "target_schema"), targetTable: str(first, "target_table"), targetOid: str(first, "target_oid"), updateAction: update, deleteAction: deletion, match,
      deferrable: first.deferrable as boolean, initiallyDeferred: first.deferred as boolean, validated: first.validated as boolean,
      local: first.local as boolean, parent: str(first, "parent"), inheritanceCount: num(first, "inheritance_count"), noInherit: first.no_inherit as boolean,
      pairs: rows.map(r => ({ ordinal: r.ordinal!, from_column: r.from_column!, to_column: r.to_column!, from_attnum: r.from_attnum!, to_attnum: r.to_attnum! })) });
  }
  const indexes = await q(`SELECT i.indrelid::text AS table_oid,i.indexrelid::text AS oid,c.relname AS name,i.indisunique AS "unique",i.indisprimary AS primary,
    i.indisexclusion AS exclusion,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indimmediate AS immediate,
    i.indnullsnotdistinct AS nulls_not_distinct,i.indisclustered AS clustered,i.indisreplident AS replica_identity,i.indcheckxmin AS check_xmin,
    i.indnatts AS item_count,i.indnkeyatts AS key_count,a.amname AS access_method,
    pg_catalog.pg_get_expr(i.indexprs,i.indrelid,false) AS expressions,pg_catalog.pg_get_expr(i.indpred,i.indrelid,false) AS predicate,
    pg_catalog.pg_get_indexdef(i.indexrelid,0,false) AS definition
    FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid=i.indexrelid JOIN pg_catalog.pg_am AS a ON a.oid=c.relam
    WHERE i.indrelid IN ${OIDS} ORDER BY i.indrelid,c.relname LIMIT 4097`,
  "table_oid:o oid:o name:s unique:b primary:b exclusion:b valid:b ready:b live:b immediate:b nulls_not_distinct:b clustered:b replica_identity:b check_xmin:b item_count:n key_count:n access_method:s expressions:s? predicate:s? definition:s", ids);
  const items = await q(`SELECT i.indrelid::text AS table_oid,i.indexrelid::text AS index_oid,k.ordinality::integer AS ordinal,
    k.attnum,a.attname AS name,k.ordinality<=i.indnkeyatts AS key,
    i.indcollation[(k.ordinality-1)::integer]::text AS collation_oid,i.indclass[(k.ordinality-1)::integer]::text AS opclass_oid,
    i.indoption[(k.ordinality-1)::integer]::integer AS options,pg_catalog.pg_get_indexdef(i.indexrelid,k.ordinality::integer,false) AS definition
    FROM pg_catalog.pg_index AS i CROSS JOIN LATERAL pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum,ordinality)
    LEFT JOIN pg_catalog.pg_attribute AS a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
    WHERE i.indrelid IN ${OIDS} ORDER BY i.indexrelid,k.ordinality LIMIT 4097`,
  "table_oid:o index_oid:o ordinal:n attnum:n name:s? key:b collation_oid:z? opclass_oid:z? options:n? definition:s", ids);
  const triggers = await q(`SELECT t.tgrelid::text AS table_oid,t.oid::text AS oid,t.tgname AS name,t.tgenabled AS enabled,t.tgtype::integer AS type,
    t.tgconstraint::text AS constraint_oid,t.tgisinternal AS internal,p.oid::text AS function_oid,n.nspname AS function_schema,p.proname AS function_name,
    pg_catalog.pg_get_triggerdef(t.oid,false) AS definition FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_proc AS p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace WHERE t.tgrelid IN ${OIDS} AND NOT t.tgisinternal ORDER BY t.tgrelid,t.tgname LIMIT 4097`,
  "table_oid:o oid:o name:s enabled:s type:n constraint_oid:z internal:b function_oid:o function_schema:s function_name:s definition:s", ids);
  members(indexes, "table_oid", ids); members(items, "table_oid", ids); members(triggers, "table_oid", ids);
  unique(indexes, "oid"); unique(triggers, "oid");
  if (items.some(item => !indexes.some(index => index.oid === item.index_oid && index.table_oid === item.table_oid))) fail();
  const relations = selected.map((meta, i) => {
    const oid = str(meta, "oid"), name = TABLES[i]!;
    const ownIndexes = indexes.filter(x => x.table_oid === oid).map(index => {
      const values = items.filter(x => x.index_oid === index.oid);
      if (values.length > 32 || num(index, "item_count") > 32) fail("catalog_budget");
      if (!values.length || values.length !== index.item_count || num(index, "key_count") < 1 || num(index, "key_count") > values.length
        || values.some((v, n) => v.ordinal !== n + 1 || v.table_oid !== oid || v.key !== (n < num(index, "key_count")))) fail();
      return { metadata: index, items: values };
    });
    unique(ownIndexes.map(x => x.metadata), "name"); unique(ownIndexes.map(x => x.metadata), "oid");
    const ownFks = fks.filter(f => f.tableOid === oid), ownConstraints = constraints.filter(c => c.table_oid === oid);
    const fkConstraints = ownConstraints.filter(c => c.type === "f");
    if (ownFks.length !== fkConstraints.length || ownFks.some(f => {
      const c = fkConstraints.find(c => c.oid === f.id);
      return !c || c.name !== f.name || c.keys !== f.pairs.map(p => p.from_attnum).join(",")
        || c.target_keys !== f.pairs.map(p => p.to_attnum).join(",") || c.deferrable !== f.deferrable
        || c.deferred !== f.initiallyDeferred || c.validated !== f.validated || c.local !== f.local
        || c.parent !== f.parent || c.inheritance_count !== f.inheritanceCount || c.no_inherit !== f.noInherit;
    })) fail();
    return { schema: namespace.name, name, oid, createSql: null, metadata: { ...meta, wr: null, strict: null, ncol: null },
      columns: columns(name, allColumns.filter(x => x.table_oid === oid), "postgres"),
      foreignKeys: ownFks, indexes: ownIndexes, constraints: ownConstraints, triggers: triggers.filter(t => t.table_oid === oid) };
  });
  return { namespace, applied, relations, fks };
}

/** The caller owns the actual consistent read transaction. This function issues SELECTs only. */
export async function readM2RewriteFootprint(snapshot: DbReadSnapshot, dialect: Dialect): Promise<M2RewriteFootprint> {
  try {
    if (dialect !== "sqlite" && dialect !== "postgres") fail("invalid_dialect");
    const data = await (dialect === "sqlite" ? sqlite(reader(snapshot)) : postgres(reader(snapshot)));
    for (const relation of data.relations) {
      relation.indexes.sort((a, b) => cmp(str(a.metadata, "name"), str(b.metadata, "name")));
      relation.foreignKeys.sort((a, b) => cmp(a.id, b.id));
      relation.constraints?.sort((a, b) => cmp(str(a, "oid"), str(b, "oid")));
      relation.triggers.sort((a, b) => cmp(str(a, "name"), str(b, "name")));
    }
    const foreignKeys = incoming(data.fks, data.namespace.name, dialect).sort((a, b) => cmp(a.table, b.table) || cmp(a.id, b.id));
    const value = { kind: "m2-rewrite-footprint" as const, dialect, namespace: data.namespace, migrations: data.applied,
      relations: data.relations.sort((a, b) => cmp(a.name, b.name)), incomingForeignKeys: foreignKeys,
      legacyBindingUniques: keyRequirements(data.relations, dialect) };
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded, "utf8") > BYTE_LIMIT) fail("catalog_budget");
    return freeze({ ...value, digest: sha256(`boardroom:m2-rewrite-footprint:internal\0${encoded}`) });
  } catch (error) {
    const code = error !== null && (typeof error === "object" || typeof error === "function") ? errors.get(error) : undefined;
    throw new M2RewriteFootprintError(code ?? "catalog_unavailable");
  }
}

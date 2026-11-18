import type { M2RewriteFootprint, M2RelationFootprint, M2ForeignKeyFootprint, M2IndexFootprint } from "./m2-rewrite-footprint.ts";
import { canonicalJson, sha256 } from "../storage/maintenance/canonical.ts";

type Dialect = "sqlite" | "postgres";
type Code = "invalid_footprint" | "catalog_budget" | "unsupported_control_catalog";
type Scalar = string | number | boolean | null;
type Row = Readonly<Record<string, Scalar>>;
type Json = Scalar | Json[] | { [key: string]: Json };
const errors = new WeakMap<object, Code>();

export class M2ControlSchemaSqlError extends Error {
  override readonly name = "M2ControlSchemaSqlError";
  readonly code: Code;
  constructor(code: Code) {
    const fixed = code === "catalog_budget" || code === "unsupported_control_catalog" ? code : "invalid_footprint";
    super(`M2_CONTROL_SCHEMA_SQL: ${fixed}`);
    this.code = fixed; errors.set(this, fixed);
  }
}
export interface M2ControlSqlStep { readonly id: string; readonly sql: string }
export interface M2ControlSqlCheck extends M2ControlSqlStep {
  readonly params: readonly (string | number)[];
  readonly expected: "zero_rows";
}
/** 内部固定计划值；不持有连接、事务、source/window 或执行权限。 */
export interface M2ControlSchemaSqlPlan {
  readonly kind: "m2-control-schema-sql";
  readonly dialect: Dialect;
  readonly footprintDigest: string;
  readonly namespace: { readonly name: string; readonly oid: string | null };
  readonly locks: readonly M2ControlSqlStep[];
  readonly prechecks: readonly M2ControlSqlCheck[];
  readonly writesBeforeCopyCheck: readonly M2ControlSqlStep[];
  readonly copyChecks: readonly M2ControlSqlCheck[];
  readonly cleanupWrites: readonly M2ControlSqlStep[];
  readonly finalChecks: readonly M2ControlSqlCheck[];
  readonly preserve: readonly { readonly table: string; readonly columns: readonly string[]; readonly sqliteRowid: boolean }[];
  readonly digest: string;
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
const INTEGER_COLUMNS = new Set([
  "agent_runtime_bindings.revision", "agent_runtime_bindings.intent_revision", "agent_runtime_bindings.reset_session_requested",
  "agent_runner_states.generation", "agent_runner_states.pid", "agent_runner_states.exit_confirmed", "agent_runner_states.attempt_count", "agent_runner_states.last_exit_code",
  "agent_runtime_members.generation", "storage_maintenance.singleton", "storage_maintenance.protocol_version", "storage_source_clients.protocol_version",
]);
const BIGINT_COLUMNS = new Set([
  "storage_maintenance.fence_epoch", "storage_maintenance.owner_generation", "storage_maintenance.journal_sequence",
  "storage_source_clients.registered_epoch", "storage_source_clients.observed_epoch", "storage_source_clients.drain_epoch",
]);
const UNIQUE_KEYS = [["runtime_id", "project_id", "group_id"], ["member_id", "group_id"]] as const;
const REQUIRED_INDEXES = {
  ix_runtime_bindings_project: ["agent_runtime_bindings", ["project_id", "group_id"]],
  ix_runtime_bindings_desired: ["agent_runtime_bindings", ["desired_state"]],
  ix_bindings_member_seek: ["agent_runtime_bindings", ["member_id", "id"]],
  ix_runtime_members_runtime: ["agent_runtime_members", ["runtime_id"]],
  storage_source_clients_epoch: ["storage_source_clients", ["registered_epoch", "ended_at"]],
} as const;
const MAX_BYTES = 2 * 1024 * 1024;
function fail(code: Code = "invalid_footprint"): never { throw new M2ControlSchemaSqlError(code); }
function requireValue(condition: unknown, code: Code = "invalid_footprint"): asserts condition { if (!condition) fail(code); }
function equal(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function cmp(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!; if (difference) return difference;
  }
  return left.length - right.length;
}
function ordered(values: readonly string[]): void { requireValue(values.every((v, i) => i === 0 || cmp(values[i - 1]!, v) < 0)); }
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** 按 JSON 展开逐次计费；只反射 own data descriptors，不运行 getter/toJSON。 */
function copyInput(input: unknown): Json {
  let bytes = 0, nodes = 0;
  const path = new Set<object>();
  const charge = (amount: number) => { if (amount > MAX_BYTES - bytes) fail("catalog_budget"); bytes += amount; };
  const stringBytes = (text: string) => {
    if (Buffer.byteLength(text, "utf8") > 65536) fail("catalog_budget");
    return Buffer.byteLength(JSON.stringify(text), "utf8");
  };
  function copy(value: unknown, depth: number): Json {
    if (depth > 64 || ++nodes > 250000) fail("catalog_budget");
    if (value === null) { charge(4); return null; }
    if (typeof value === "string") { charge(stringBytes(value)); return value; }
    if (typeof value === "boolean") { charge(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      requireValue(Number.isSafeInteger(value) && !Object.is(value, -0)); charge(String(value).length); return value;
    }
    requireValue(value !== null && typeof value === "object" && !path.has(value));
    path.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      const array = Array.isArray(value);
      requireValue(keys.every(key => typeof key === "string"));
      if (keys.length > 250001) fail("catalog_budget");
      const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(value, key)]));
      if (array) {
        const length = descriptors.get("length");
        requireValue(length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 && !Object.is(length.value, -0) && !length.enumerable);
        if (length.value > 4096) fail("catalog_budget");
        requireValue(keys.length === length.value + 1);
        charge(2 + Math.max(0, length.value - 1));
        const out: Json[] = [];
        for (let i = 0; i < length.value; i++) {
          const descriptor = descriptors.get(String(i));
          requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
          out.push(copy(descriptor.value, depth + 1));
        }
        return out;
      }
      charge(2 + Math.max(0, keys.length - 1));
      const out = Object.create(null) as { [key: string]: Json };
      for (const key of keys as string[]) {
        const descriptor = descriptors.get(key);
        requireValue(descriptor && "value" in descriptor && descriptor.enumerable);
        charge(stringBytes(key) + 1);
        out[key] = copy(descriptor.value, depth + 1);
      }
      return out;
    } finally { path.delete(value); }
  }
  return copy(input, 0);
}
function object(value: unknown, fields: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value), expected = fields.split(" ");
  requireValue(keys.length === expected.length && keys.every(key => expected.includes(key)));
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] { requireValue(Array.isArray(value)); return value; }
function row(value: unknown, shape: string): Row {
  const fields = shape.split(" ").map(s => s.split(":")), result = object(value, fields.map(f => f[0]).join(" "));
  for (const [key, pattern] of fields) {
    const v = result[key!], kind = pattern![0];
    if (v === null && pattern!.endsWith("?")) continue;
    if (kind === "s" || kind === "o" || kind === "z") {
      requireValue(typeof v === "string");
      if (kind !== "s") requireValue(/^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= 4294967295n && (kind !== "o" || v !== "0"));
    } else if (kind === "n") requireValue(typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0));
    else if (kind === "b") requireValue(typeof v === "boolean");
    else if (kind === "0") requireValue(v === null);
    else fail();
  }
  return result as Row;
}
const str = (value: Row, key: string) => value[key] as string;
const num = (value: Row, key: string) => value[key] as number;
function bit(value: Scalar | undefined): void { requireValue(value === 0 || value === 1); }
function quote(value: string): string {
  requireValue(value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 63 && Buffer.from(value, "utf8").toString("utf8") === value);
  return `"${value.replaceAll('"', '""')}"`;
}
function indexKeys(index: M2IndexFootprint, dialect: Dialect): string[] | null {
  const m = index.metadata;
  if (dialect === "sqlite") {
    const keys = index.items.filter(i => i.key === 1);
    if (m.partial !== 0 || !keys.length || keys.some(i => typeof i.name !== "string" || num(i, "cid") < 0 || i.desc !== 0 || i.collation !== "BINARY")) return null;
    return keys.map(i => str(i, "name"));
  }
  if (m.predicate !== null || m.expressions !== null || m.valid !== true || m.ready !== true || m.live !== true
    || m.immediate !== true || m.nulls_not_distinct !== false || m.access_method !== "btree" || m.key_count !== m.item_count) return null;
  if (!index.items.length || index.items.some(i => i.key !== true || typeof i.name !== "string" || num(i, "attnum") <= 0 || i.options !== 0)) return null;
  return index.items.map(i => str(i, "name"));
}
function validateForeignKey(value: unknown, dialect: Dialect): M2ForeignKeyFootprint {
  const f = object(value, "schema table tableOid id name targetSchema targetTable targetOid updateAction deleteAction match deferrable initiallyDeferred validated local parent inheritanceCount noInherit pairs");
  const { pairs, ...metadata } = f;
  row(metadata, dialect === "sqlite"
    ? "schema:s table:s tableOid:0 id:s name:0 targetSchema:s targetTable:s targetOid:0 updateAction:s deleteAction:s match:s deferrable:0 initiallyDeferred:0 validated:0 local:0 parent:0 inheritanceCount:0 noInherit:0"
    : "schema:s table:s tableOid:o id:o name:s targetSchema:s targetTable:s targetOid:o updateAction:s deleteAction:s match:s deferrable:b initiallyDeferred:b validated:b local:b parent:z inheritanceCount:n noInherit:b");
  const actions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];
  requireValue(actions.includes(f.updateAction as string) && actions.includes(f.deleteAction as string));
  requireValue(dialect === "sqlite" ? f.schema === "main" && f.targetSchema === "main" && /^(0|[1-9][0-9]*)$/.test(f.id as string) && f.match === "NONE"
    : ["SIMPLE", "FULL", "PARTIAL"].includes(f.match as string) && (f.inheritanceCount as number) >= 0);
  const parsed = list(pairs).map(p => row(p, dialect === "sqlite" ? "ordinal:n from_column:s to_column:s? from_attnum:0 to_attnum:0" : "ordinal:n from_column:s to_column:s from_attnum:n to_attnum:n"));
  requireValue(parsed.length > 0 && parsed.every((p, i) => p.ordinal === i + (dialect === "sqlite" ? 0 : 1)
    && (dialect === "sqlite" || num(p, "from_attnum") > 0 && num(p, "to_attnum") > 0)));
  return f as unknown as M2ForeignKeyFootprint;
}
function validateRelation(value: unknown, table: Table, namespace: M2RewriteFootprint["namespace"], dialect: Dialect): M2RelationFootprint {
  const r = object(value, "schema name oid createSql metadata columns foreignKeys indexes constraints triggers");
  requireValue(r.schema === namespace.name && r.name === table);
  row({ oid: r.oid, createSql: r.createSql }, dialect === "sqlite" ? "oid:0 createSql:s" : "oid:o createSql:0");
  const meta = row(r.metadata, dialect === "sqlite"
    ? "name:s type:s ncol:n wr:n strict:n persistence:0 partition:0 row_security:0 force_row_security:0 access_method:0 inheritance:0"
    : "oid:o name:s kind:s persistence:s partition:b row_security:b force_row_security:b access_method:s? inheritance:b wr:0 strict:0 ncol:0");
  requireValue(meta.name === table);
  if (dialect === "sqlite") { requireValue(meta.type === "table"); bit(meta.wr); bit(meta.strict); }
  else requireValue(meta.oid === r.oid && meta.kind === "r" && meta.persistence === "p" && meta.partition === false
    && meta.row_security === false && meta.force_row_security === false && meta.inheritance === false && meta.access_method === "heap");
  const columns = list(r.columns).map(c => row(c, dialect === "sqlite"
    ? "table_name:s ordinal:n name:s type:s not_null:n default_expression:s? pk:n hidden:n"
    : "table_oid:o ordinal:n name:s type_oid:z type:s not_null:b default_expression:s? dropped:b identity:s generated:s collation_oid:z"));
  const expected = COLUMNS[table].split(" ");
  requireValue(columns.length === expected.length && (dialect !== "sqlite" || meta.ncol === columns.length));
  columns.forEach((c, i) => {
    requireValue(c.ordinal === i + (dialect === "sqlite" ? 0 : 1) && c.name === expected[i]);
    const key = `${table}.${str(c, "name")}`;
    const type = BIGINT_COLUMNS.has(key) ? "BIGINT" : INTEGER_COLUMNS.has(key) ? "INTEGER" : "TEXT";
    if (dialect === "sqlite") { requireValue(c.table_name === table && c.type === type && c.hidden === 0 && num(c, "pk") >= 0); bit(c.not_null); }
    else requireValue(c.table_oid === r.oid && c.type_oid === ({ TEXT: "25", INTEGER: "23", BIGINT: "20" } as const)[type]
      && c.type === ({ TEXT: "text", INTEGER: "integer", BIGINT: "bigint" } as const)[type]
      && c.dropped === false && c.identity === "" && c.generated === "");
  });
  const foreignKeys = list(r.foreignKeys).map(f => validateForeignKey(f, dialect));
  ordered(foreignKeys.map(f => f.id));
  for (const f of foreignKeys) {
    requireValue(f.schema === namespace.name && f.table === table && f.tableOid === r.oid);
    for (const p of f.pairs) requireValue(columns.some(c => c.name === p.from_column && (dialect === "sqlite" || c.ordinal === p.from_attnum)));
  }
  const indexes = list(r.indexes).map(value => {
    const index = object(value, "metadata items");
    const m = row(index.metadata, dialect === "sqlite"
      ? "table_name:s seq:n name:s unique:n origin:s partial:n oid:0 definition:s?"
      : "table_oid:o oid:o name:s unique:b primary:b exclusion:b valid:b ready:b live:b immediate:b nulls_not_distinct:b clustered:b replica_identity:b check_xmin:b item_count:n key_count:n access_method:s expressions:s? predicate:s? definition:s");
    if (dialect === "sqlite") { requireValue(m.table_name === table && num(m, "seq") >= 0 && ["c", "u", "pk"].includes(str(m, "origin"))); bit(m.unique); bit(m.partial); }
    else requireValue(m.table_oid === r.oid && num(m, "item_count") >= 1 && num(m, "key_count") >= 1 && num(m, "key_count") <= num(m, "item_count"));
    const items = list(index.items).map(v => row(v, dialect === "sqlite"
      ? "table_name:s index_name:s ordinal:n cid:n name:s? desc:n collation:s key:n"
      : "table_oid:o index_oid:o ordinal:n attnum:n name:s? key:b collation_oid:z? opclass_oid:z? options:n? definition:s"));
    requireValue(items.length > 0 && items.length <= 32 && (dialect !== "postgres" || m.item_count === items.length));
    items.forEach((item, i) => {
      requireValue(item.ordinal === i + (dialect === "sqlite" ? 0 : 1));
      if (dialect === "sqlite") {
        bit(item.desc); bit(item.key);
        requireValue(item.table_name === table && item.index_name === m.name && num(item, "cid") >= -2);
        requireValue(num(item, "cid") < 0 ? item.name === null : columns.some(c => c.ordinal === item.cid && c.name === item.name));
      } else {
        requireValue(item.table_oid === r.oid && item.index_oid === m.oid && item.key === (i < num(m, "key_count")) && num(item, "attnum") >= 0);
        requireValue(item.attnum === 0 ? item.name === null : columns.some(c => c.ordinal === item.attnum && c.name === item.name));
      }
    });
    return { metadata: m, items };
  });
  ordered(indexes.map(i => str(i.metadata, "name")));
  if (dialect === "sqlite") requireValue(equal(indexes.map(i => num(i.metadata, "seq")).sort((a, b) => a - b), indexes.map((_, i) => i)));
  let constraints: Row[] | null = null;
  if (dialect === "sqlite") requireValue(r.constraints === null);
  else {
    constraints = list(r.constraints).map(c => row(c, "table_oid:o oid:o name:s type:s index_oid:z keys:s? target_keys:s? deferrable:b deferred:b validated:b local:b parent:z inheritance_count:n no_inherit:b definition:s"));
    ordered(constraints.map(c => str(c, "oid")));
    requireValue(new Set(constraints.map(c => c.name)).size === constraints.length);
    for (const c of constraints) {
      requireValue(c.table_oid === r.oid && ["c", "p", "u", "f"].includes(str(c, "type")) && num(c, "inheritance_count") >= 0);
      if (c.keys !== null) requireValue(typeof c.keys === "string" && /^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(c.keys)
        && c.keys.split(",").every(n => columns.some(column => column.ordinal === Number(n))));
      if (c.target_keys !== null) requireValue(c.type === "f" && typeof c.target_keys === "string" && /^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(c.target_keys));
      if (c.type === "p" || c.type === "u") requireValue(indexes.some(i => i.metadata.oid === c.index_oid && i.metadata.unique === true
        && equal(indexKeys(i, dialect), str(c, "keys").split(",").map(n => columns[Number(n) - 1]!.name))));
      if (c.type === "c") requireValue(c.index_oid === "0" && c.target_keys === null);
    }
    const foreign = constraints.filter(c => c.type === "f");
    requireValue(foreign.length === foreignKeys.length && foreignKeys.every(f => {
      const c = foreign.find(c => c.oid === f.id);
      return c && c.name === f.name && c.keys === f.pairs.map(p => p.from_attnum).join(",") && c.target_keys === f.pairs.map(p => p.to_attnum).join(",")
        && c.deferrable === f.deferrable && c.deferred === f.initiallyDeferred && c.validated === f.validated && c.local === f.local
        && c.parent === f.parent && c.inheritance_count === f.inheritanceCount && c.no_inherit === f.noInherit;
    }));
  }
  const triggers = list(r.triggers).map(t => row(t, dialect === "sqlite" ? "type:s name:s table_name:s definition:s?"
    : "table_oid:o oid:o name:s enabled:s type:n constraint_oid:z internal:b function_oid:o function_schema:s function_name:s definition:s"));
  ordered(triggers.map(t => str(t, "name")));
  for (const t of triggers) requireValue(dialect === "sqlite" ? t.type === "trigger" && t.table_name === table && typeof t.definition === "string" : t.table_oid === r.oid && t.internal === false);
  return { schema: namespace.name, name: table, oid: r.oid as string | null, createSql: r.createSql as string | null, metadata: meta, columns, foreignKeys, indexes, constraints, triggers };
}
function validateInput(value: Json): M2RewriteFootprint {
  const root = object(value, "kind dialect namespace migrations relations incomingForeignKeys legacyBindingUniques digest");
  requireValue(root.kind === "m2-rewrite-footprint" && (root.dialect === "sqlite" || root.dialect === "postgres") && typeof root.digest === "string" && /^[0-9a-f]{64}$/.test(root.digest));
  const dialect = root.dialect;
  const n = row(root.namespace, dialect === "sqlite" ? "name:s oid:0" : "name:s oid:o");
  const namespace = { name: str(n, "name"), oid: n.oid as string | null };
  if (dialect === "sqlite") requireValue(namespace.name === "main"); else quote(namespace.name);
  const applied = list(root.migrations).map(m => row(m, "version:n name:s checksum:s"));
  requireValue(equal(applied, BASELINE[dialect]));
  const rawRelations = list(root.relations); requireValue(rawRelations.length === TABLES.length);
  const relations = rawRelations.map((r, i) => validateRelation(r, TABLES[i]!, namespace, dialect));
  if (dialect === "postgres") requireValue(new Set(relations.map(r => r.oid)).size === relations.length);
  const allIndexes = relations.flatMap(r => r.indexes);
  requireValue(new Set(allIndexes.map(i => i.metadata.name)).size === allIndexes.length);
  if (dialect === "postgres") requireValue(new Set(allIndexes.map(i => i.metadata.oid)).size === allIndexes.length);
  if (dialect === "postgres") {
    requireValue(new Set([...relations.map(r => r.oid), ...allIndexes.map(i => i.metadata.oid)]).size === relations.length + allIndexes.length);
    const constraints = relations.flatMap(r => r.constraints!);
    requireValue(new Set(constraints.map(c => c.oid)).size === constraints.length);
    const triggers = relations.flatMap(r => r.triggers);
    requireValue(new Set(triggers.map(t => t.oid)).size === triggers.length);
  }
  const ownedForeignKeys = relations.flatMap(r => r.foreignKeys);
  for (const f of ownedForeignKeys) {
    const target = relations.find(r => r.schema === f.targetSchema && r.name === f.targetTable);
    if (target) {
      requireValue(target.oid === f.targetOid);
      for (const p of f.pairs) requireValue(target.columns.some(c => c.name === p.to_column && (dialect === "sqlite" || c.ordinal === p.to_attnum)));
    } else if (dialect === "postgres") requireValue(!relations.some(r => r.oid === f.targetOid));
  }
  const incoming = list(root.incomingForeignKeys).map(f => validateForeignKey(f, dialect));
  const expectedIncoming = ownedForeignKeys.filter(f => f.targetSchema === namespace.name && TABLES.includes(f.targetTable as Table)).sort((a, b) => cmp(a.table, b.table) || cmp(a.id, b.id));
  requireValue(equal(incoming, expectedIncoming) && incoming.length === 3);
  const signatures = [["agent_runner_states", "binding_id", "agent_runtime_bindings", "id", "CASCADE"],
    ["agent_runtime_members", "binding_id", "agent_runtime_bindings", "id", "RESTRICT"],
    ["storage_source_clients", "database_instance_id", "storage_maintenance", "database_instance_id", "NO ACTION"]];
  for (const [table, from, target, to, deletion] of signatures) requireValue(incoming.filter(f => f.table === table && f.targetTable === target
    && f.pairs.length === 1 && f.pairs[0]!.from_column === from && f.pairs[0]!.to_column === to && f.updateAction === "NO ACTION" && f.deleteAction === deletion
    && (dialect === "sqlite" ? f.match === "NONE" : f.match === "SIMPLE" && f.validated === true && f.deferrable === false && f.initiallyDeferred === false && f.local === true && f.parent === "0" && f.inheritanceCount === 0)).length === 1);
  const binding = relations.find(r => r.name === "agent_runtime_bindings")!;
  const bindingIndexes = binding.indexes.filter(i => dialect === "sqlite" ? i.metadata.unique === 1 && i.metadata.origin !== "pk" : i.metadata.unique === true && i.metadata.primary !== true);
  requireValue(bindingIndexes.length === 2);
  const uniques = list(root.legacyBindingUniques); requireValue(uniques.length === 2);
  uniques.forEach((value, i) => {
    const u = object(value, "keys constraintName indexName indexOid flags");
    requireValue(equal(u.keys, UNIQUE_KEYS[i]) && typeof u.indexName === "string");
    const index = bindingIndexes.find(index => index.metadata.name === u.indexName);
    requireValue(index && equal(indexKeys(index, dialect), UNIQUE_KEYS[i]) && equal(index.metadata, u.flags));
    if (dialect === "sqlite") requireValue(u.constraintName === null && u.indexOid === null && index.metadata.origin === "u");
    else {
      requireValue(u.indexOid === index.metadata.oid);
      const constraints = binding.constraints!.filter(c => c.type === "u" && c.index_oid === index.metadata.oid);
      requireValue(constraints.length === 1 && constraints[0]!.name === u.constraintName && constraints[0]!.deferrable === false && constraints[0]!.deferred === false && constraints[0]!.validated === true);
    }
  });
  for (const relation of relations) {
    const primary = relation.columns[0]!.name;
    if (dialect === "sqlite") requireValue(equal(relation.columns.filter(c => c.pk !== 0).map(c => [c.name, c.pk]), [[primary, 1]]));
    else {
      const pks = relation.constraints!.filter(c => c.type === "p");
      requireValue(pks.length === 1 && pks[0]!.keys === "1" && relation.indexes.some(i => i.metadata.oid === pks[0]!.index_oid && i.metadata.primary === true && equal(indexKeys(i, dialect), [primary])));
    }
    const extra = relation.name === "agent_runner_states" ? "session_key" : relation.name === "storage_maintenance" ? "database_instance_id" : null;
    if (extra) requireValue(relation.indexes.some(i => i.metadata.unique === (dialect === "sqlite" ? 1 : true) && equal(indexKeys(i, dialect), [extra])));
  }
  for (const [name, [table, keys]] of Object.entries(REQUIRED_INDEXES)) {
    const indexes = relations.find(r => r.name === table)!.indexes.filter(i => i.metadata.name === name);
    requireValue(indexes.length === 1 && indexes[0]!.metadata.unique === (dialect === "sqlite" ? 0 : false) && equal(indexKeys(indexes[0]!, dialect), keys));
  }
  const { digest, ...withoutDigest } = root;
  requireValue(digest === sha256(`boardroom:m2-rewrite-footprint:internal\0${canonicalJson(withoutDigest)}`));
  return root as unknown as M2RewriteFootprint;
}

function sqliteSupported(relation: M2RelationFootprint): void {
  const table = relation.name as "storage_maintenance" | "storage_source_clients";
  const maintenance = table === "storage_maintenance";
  const code: Code = "unsupported_control_catalog";
  requireValue(relation.createSql === SQLITE_BASELINE[table] && relation.metadata.wr === 0 && relation.metadata.strict === 0 && !relation.triggers.length, code);
  requireValue(equal(relation.columns, SQLITE_CONTROL_COLUMNS[table]), code);
  requireValue(relation.indexes.length === (maintenance ? 1 : 2), code);
  const auto = relation.indexes.filter(i => i.metadata.origin === (maintenance ? "u" : "pk"));
  requireValue(auto.length === 1 && auto[0]!.metadata.unique === 1 && auto[0]!.metadata.definition === null
    && equal(indexKeys(auto[0]!, "sqlite"), [maintenance ? "database_instance_id" : "client_id"]), code);
  for (const index of relation.indexes) {
    const keyCount = index.items.filter(i => i.key === 1).length;
    requireValue(index.metadata.partial === 0 && index.items.length === keyCount + 1 && index.items.every((item, i) => item.desc === 0 && item.collation === "BINARY"
      && (i < keyCount ? item.key === 1 && num(item, "cid") >= 0 : item.key === 0 && item.cid === -1 && item.name === null)), code);
  }
  if (!maintenance) {
    const index = relation.indexes.find(i => i.metadata.name === "storage_source_clients_epoch");
    requireValue(index && index.metadata.origin === "c" && index.metadata.unique === 0
      && index.metadata.definition === "CREATE INDEX storage_source_clients_epoch ON storage_source_clients(registered_epoch, ended_at)", code);
  }
}
function postgresSupported(relation: M2RelationFootprint): string {
  const code: Code = "unsupported_control_catalog", maintenance = relation.name === "storage_maintenance";
  const constraints = relation.constraints!, ordinal = maintenance ? "13" : "5";
  requireValue(!relation.triggers.length && relation.indexes.length === 2, code);
  requireValue(!constraints.some(c => c.name === "br_m2_storage_client_format_pair"), code);
  const checks = constraints.filter(c => c.type === "c");
  const protocol = checks.filter(c => typeof c.keys === "string" && c.keys.split(",").includes(ordinal));
  requireValue(protocol.length === 1, code);
  const p = protocol[0]!;
  requireValue(p.keys === ordinal && p.definition === "CHECK ((protocol_version = 1))" && p.validated === true && p.local === true
    && p.deferrable === false && p.deferred === false && p.parent === "0" && p.inheritance_count === 0 && p.no_inherit === false, code);
  const signatures = maintenance ? ["1", "5", "6", "9", "12", "14", "3,4,6,7,8,10,11,12", "10,11,12", "8"] : ["3", "9", "10", "11", "12", "13", "11,12,13"];
  const actual = checks.filter(c => c !== p).map(c => typeof c.keys === "string" ? c.keys.split(",").map(Number).sort((a, b) => a - b).join(",") : "").sort();
  requireValue(equal(actual, [...signatures].sort()), code);
  const others = constraints.filter(c => c.type !== "c");
  requireValue(others.length === 2 && others.filter(c => c.type === "p").length === 1
    && others.filter(c => c.type === (maintenance ? "u" : "f")).length === 1, code);
  if (maintenance) {
    const unique = others.find(c => c.type === "u")!;
    requireValue(unique.keys === "2" && unique.deferrable === false && unique.deferred === false && unique.validated === true, code);
  }
  const expectedKeys = maintenance ? [["singleton"], ["database_instance_id"]] : [["client_id"], ["registered_epoch", "ended_at"]];
  for (const keys of expectedKeys) requireValue(relation.indexes.filter(i => equal(indexKeys(i, "postgres"), keys)).length === 1, code);
  for (const index of relation.indexes) requireValue(index.metadata.exclusion === false, code);
  quote(str(p, "name"));
  return str(p, "name");
}

/** 只构造已冻结的计划；外部 owner 仍须持有全源锁并逐一执行所有检查。 */
export function buildM2ControlSchemaSql(footprint: M2RewriteFootprint): M2ControlSchemaSqlPlan {
  try {
    const input = validateInput(copyInput(footprint));
    const maintenance = input.relations.find(r => r.name === "storage_maintenance")!;
    const clients = input.relations.find(r => r.name === "storage_source_clients")!;
    const substitutions: Record<string, string> = {};
    const parameters: Record<string, string> = {};
    if (input.dialect === "sqlite") { sqliteSupported(maintenance); sqliteSupported(clients); }
    else {
      const m = postgresSupported(maintenance), c = postgresSupported(clients);
      substitutions.schema = quote(input.namespace.name); substitutions.maintenance_protocol_check = quote(m); substitutions.clients_protocol_check = quote(c);
      parameters["namespace.oid"] = input.namespace.oid!; parameters["namespace.name"] = input.namespace.name;
      parameters["storage_maintenance.oid"] = maintenance.oid!; parameters["storage_source_clients.oid"] = clients.oid!;
      parameters.maintenance_protocol_check = m; parameters.clients_protocol_check = c;
    }
    const substitute = (sql: string) => sql.replace(/\{\{(schema|maintenance_protocol_check|clients_protocol_check)\}\}/g, (_, name: string) => substitutions[name]!);
    const checks = (group: readonly CheckTemplate[]): M2ControlSqlCheck[] => group.map(check => ({ id: check.id, sql: substitute(check.sql),
      params: check.params ? [...check.params] : check.parameterSources!.map(source => parameters[source]!), expected: "zero_rows" }));
    const templates = CHECKS[input.dialect];
    const writes = input.dialect === "sqlite" ? SQLITE_WRITES.map(step => ({ ...step })) : PG_WRITES.map(step => ({ id: step.id, sql: substitute(step.sql) }));
    const value = {
      kind: "m2-control-schema-sql" as const, dialect: input.dialect, footprintDigest: input.digest,
      namespace: { ...input.namespace },
      locks: input.dialect === "sqlite" ? [] : [{ id: "pg-control-lock", sql: substitute(PG_LOCK) }],
      prechecks: checks(templates.prechecks), writesBeforeCopyCheck: input.dialect === "sqlite" ? writes.slice(0, 9) : writes,
      copyChecks: checks(templates.copyChecks), cleanupWrites: input.dialect === "sqlite" ? writes.slice(9) : [], finalChecks: checks(templates.finalChecks),
      preserve: TABLES.map(table => ({ table, columns: COLUMNS[table].split(" "), sqliteRowid: input.dialect === "sqlite" })),
    };
    const groups = [value.locks, value.prechecks, value.writesBeforeCopyCheck, value.copyChecks, value.cleanupWrites, value.finalChecks];
    const limits = [1, 4, 9, 3, 2, 4];
    requireValue(groups.every((group, i) => group.length <= limits[i]!), "catalog_budget");
    requireValue(groups.flat().reduce((total, step) => total + Buffer.byteLength(step.sql, "utf8"), 0) <= 65536, "catalog_budget");
    return frozen({ ...value, digest: sha256(`boardroom:m2-control-schema-sql:internal\0${canonicalJson(value)}`) });
  } catch (error) {
    const code = error !== null && (typeof error === "object" || typeof error === "function") ? errors.get(error) : undefined;
    throw new M2ControlSchemaSqlError(code ?? "invalid_footprint");
  }
}

// 下列固定 SQL 与基线逐字来自 #153 comment 6981060973 的 r3 规范；不执行 metadata.definition。
interface CheckTemplate { readonly id: string; readonly sql: string; readonly params?: readonly (string | number)[]; readonly parameterSources?: readonly string[] }
const BASELINE = {
  "sqlite": [
    {
      "version": 1,
      "name": "init_domain_model",
      "checksum": "534798acc4ec7687"
    },
    {
      "version": 2,
      "name": "mcp_sessions_and_agent_identity",
      "checksum": "18ad103c3a9081cb"
    },
    {
      "version": 3,
      "name": "archive_flags_for_project_and_group",
      "checksum": "5865e8ee7f9a688d"
    },
    {
      "version": 4,
      "name": "org_tree_and_static_roles",
      "checksum": "a5699fee5a7019af"
    },
    {
      "version": 5,
      "name": "member_lifecycle_status",
      "checksum": "48ce13f7ab312d56"
    },
    {
      "version": 6,
      "name": "init_audit_log",
      "checksum": "635cb226eb65752f"
    },
    {
      "version": 7,
      "name": "durable_message_dispatch",
      "checksum": "083c2b57a71e4fab"
    },
    {
      "version": 8,
      "name": "managed_runtime_configuration_and_ownership",
      "checksum": "ed69150da53ba378"
    },
    {
      "version": 9,
      "name": "managed_runtime_observability",
      "checksum": "da19e79e0150d4eb"
    },
    {
      "version": 10,
      "name": "managed_runtime_process_identity",
      "checksum": "4af4975ceb238dd0"
    },
    {
      "version": 11,
      "name": "tasks_reviews_and_work_events",
      "checksum": "2164d612ed427deb"
    },
    {
      "version": 12,
      "name": "memory_documents_summaries_and_scan_checkpoints",
      "checksum": "978bc02e3d0159c7"
    },
    {
      "version": 13,
      "name": "member_tombstones_and_retained_fact_revisions",
      "checksum": "5762a9bcbe4357c9"
    },
    {
      "version": 14,
      "name": "identity_catalog_roles_aliases_user_audit",
      "checksum": "d9d771a84099de1a"
    },
    {
      "version": 15,
      "name": "project_workspace_configuration_versions",
      "checksum": "1d5d47c1934bcbbb"
    },
    {
      "version": 16,
      "name": "task_intake_materials",
      "checksum": "be002cb0d7fc02d6"
    },
    {
      "version": 17,
      "name": "policy_configuration_versions",
      "checksum": "4d79c82fbf92f293"
    },
    {
      "version": 18,
      "name": "storage_maintenance_fence_and_clients_v1",
      "checksum": "8567c8062e31d04a"
    },
    {
      "version": 19,
      "name": "mcp_connections_and_catalog_snapshots",
      "checksum": "b1c4794d65b3d0d7"
    },
    {
      "version": 20,
      "name": "decision_review_authority",
      "checksum": "b60fa551e9937a73"
    },
    {
      "version": 21,
      "name": "work_event_delivery_invalidations",
      "checksum": "71e4c22136a10244"
    }
  ],
  "postgres": [
    {
      "version": 1,
      "name": "init_domain_model",
      "checksum": "3c93f13aeecbd306"
    },
    {
      "version": 2,
      "name": "mcp_sessions_and_agent_identity",
      "checksum": "18ad103c3a9081cb"
    },
    {
      "version": 3,
      "name": "archive_flags_for_project_and_group",
      "checksum": "5865e8ee7f9a688d"
    },
    {
      "version": 4,
      "name": "org_tree_and_static_roles",
      "checksum": "a5699fee5a7019af"
    },
    {
      "version": 5,
      "name": "member_lifecycle_status",
      "checksum": "48ce13f7ab312d56"
    },
    {
      "version": 6,
      "name": "init_audit_log",
      "checksum": "635cb226eb65752f"
    },
    {
      "version": 7,
      "name": "durable_message_dispatch",
      "checksum": "083c2b57a71e4fab"
    },
    {
      "version": 8,
      "name": "managed_runtime_configuration_and_ownership",
      "checksum": "ed69150da53ba378"
    },
    {
      "version": 9,
      "name": "managed_runtime_observability",
      "checksum": "da19e79e0150d4eb"
    },
    {
      "version": 10,
      "name": "managed_runtime_process_identity",
      "checksum": "4af4975ceb238dd0"
    },
    {
      "version": 11,
      "name": "tasks_reviews_and_work_events",
      "checksum": "2164d612ed427deb"
    },
    {
      "version": 12,
      "name": "memory_documents_summaries_and_scan_checkpoints",
      "checksum": "978bc02e3d0159c7"
    },
    {
      "version": 13,
      "name": "member_tombstones_and_retained_fact_revisions",
      "checksum": "e4ebb5ef90356a14"
    },
    {
      "version": 14,
      "name": "identity_catalog_roles_aliases_user_audit",
      "checksum": "d9d771a84099de1a"
    },
    {
      "version": 15,
      "name": "project_workspace_configuration_versions",
      "checksum": "1d5d47c1934bcbbb"
    },
    {
      "version": 16,
      "name": "task_intake_materials",
      "checksum": "be002cb0d7fc02d6"
    },
    {
      "version": 17,
      "name": "policy_configuration_versions",
      "checksum": "4d79c82fbf92f293"
    },
    {
      "version": 18,
      "name": "storage_maintenance_fence_and_clients_v1",
      "checksum": "9a9f8488740cc632"
    },
    {
      "version": 19,
      "name": "mcp_connections_and_catalog_snapshots",
      "checksum": "b1c4794d65b3d0d7"
    },
    {
      "version": 20,
      "name": "decision_review_authority",
      "checksum": "5c40e8bfb19f2110"
    },
    {
      "version": 21,
      "name": "work_event_delivery_invalidations",
      "checksum": "ddd14adb135d10cc"
    }
  ]
} as const;
const SQLITE_BASELINE = {
  "storage_maintenance": "CREATE TABLE storage_maintenance (\n  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n  database_instance_id TEXT NOT NULL UNIQUE,\n  control_root_json TEXT,\n  mutex_identity_json TEXT,\n  fence_epoch BIGINT NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),\n  admission TEXT NOT NULL DEFAULT 'open' CHECK (admission IN ('open','draining','sealed')),\n  active_migration_id TEXT,\n  plan_digest TEXT,\n  owner_generation BIGINT NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),\n  journal_record_ref TEXT,\n  journal_digest TEXT,\n  journal_sequence BIGINT NOT NULL DEFAULT 0 CHECK (journal_sequence >= 0),\n  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),\n  guard_manifest_digest TEXT NOT NULL CHECK (length(guard_manifest_digest) = 64),\n  CHECK ((admission = 'open' AND active_migration_id IS NULL AND plan_digest IS NULL)\n    OR (admission IN ('draining','sealed') AND active_migration_id IS NOT NULL AND plan_digest IS NOT NULL\n      AND control_root_json IS NOT NULL AND mutex_identity_json IS NOT NULL\n      AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND journal_sequence > 0)),\n  CHECK ((journal_sequence = 0 AND journal_record_ref IS NULL AND journal_digest IS NULL)\n    OR (journal_sequence > 0 AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND length(journal_digest)=64)),\n  CHECK (plan_digest IS NULL OR length(plan_digest)=64)\n)",
  "storage_source_clients": "CREATE TABLE storage_source_clients (\n  client_id TEXT PRIMARY KEY,\n  database_instance_id TEXT NOT NULL REFERENCES storage_maintenance(database_instance_id),\n  entrypoint TEXT NOT NULL CHECK (entrypoint IN ('http','stdio','local-management','owned-background','maintenance-controller')),\n  build_id TEXT NOT NULL,\n  protocol_version INTEGER NOT NULL CHECK (protocol_version=1),\n  host_identity_json TEXT NOT NULL,\n  process_identity_json TEXT NOT NULL,\n  db_sessions_json TEXT NOT NULL,\n  registered_epoch BIGINT NOT NULL CHECK (registered_epoch>=0),\n  observed_epoch BIGINT NOT NULL CHECK (observed_epoch>=0),\n  drain_epoch BIGINT CHECK (drain_epoch IS NULL OR drain_epoch>=0),\n  drain_state TEXT NOT NULL DEFAULT 'none' CHECK (drain_state IN ('none','requested','draining','drained','cancel_pending','cancelled')),\n  drain_receipt_digest TEXT,\n  registered_at TEXT NOT NULL,\n  last_observed_at TEXT NOT NULL,\n  ended_at TEXT,\n  CHECK (drain_receipt_digest IS NULL OR length(drain_receipt_digest)=64),\n  CHECK (drain_state<>'drained' OR (drain_epoch IS NOT NULL AND drain_receipt_digest IS NOT NULL))\n)"
} as const;
const SQLITE_CONTROL_COLUMNS = {
  "storage_maintenance": [
    {
      "table_name": "storage_maintenance",
      "ordinal": 0,
      "name": "singleton",
      "type": "INTEGER",
      "not_null": 0,
      "default_expression": null,
      "pk": 1,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 1,
      "name": "database_instance_id",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 2,
      "name": "control_root_json",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 3,
      "name": "mutex_identity_json",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 4,
      "name": "fence_epoch",
      "type": "BIGINT",
      "not_null": 1,
      "default_expression": "0",
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 5,
      "name": "admission",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": "'open'",
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 6,
      "name": "active_migration_id",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 7,
      "name": "plan_digest",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 8,
      "name": "owner_generation",
      "type": "BIGINT",
      "not_null": 1,
      "default_expression": "0",
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 9,
      "name": "journal_record_ref",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 10,
      "name": "journal_digest",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 11,
      "name": "journal_sequence",
      "type": "BIGINT",
      "not_null": 1,
      "default_expression": "0",
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 12,
      "name": "protocol_version",
      "type": "INTEGER",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_maintenance",
      "ordinal": 13,
      "name": "guard_manifest_digest",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    }
  ],
  "storage_source_clients": [
    {
      "table_name": "storage_source_clients",
      "ordinal": 0,
      "name": "client_id",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 1,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 1,
      "name": "database_instance_id",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 2,
      "name": "entrypoint",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 3,
      "name": "build_id",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 4,
      "name": "protocol_version",
      "type": "INTEGER",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 5,
      "name": "host_identity_json",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 6,
      "name": "process_identity_json",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 7,
      "name": "db_sessions_json",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 8,
      "name": "registered_epoch",
      "type": "BIGINT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 9,
      "name": "observed_epoch",
      "type": "BIGINT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 10,
      "name": "drain_epoch",
      "type": "BIGINT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 11,
      "name": "drain_state",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": "'none'",
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 12,
      "name": "drain_receipt_digest",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 13,
      "name": "registered_at",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 14,
      "name": "last_observed_at",
      "type": "TEXT",
      "not_null": 1,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    },
    {
      "table_name": "storage_source_clients",
      "ordinal": 15,
      "name": "ended_at",
      "type": "TEXT",
      "not_null": 0,
      "default_expression": null,
      "pk": 0,
      "hidden": 0
    }
  ]
} as const;
const SQLITE_WRITES: readonly M2ControlSqlStep[] = [
  {
    "id": "save-maintenance",
    "sql": "CREATE TEMP TABLE \"__br_m2_control_saved_maintenance\" AS SELECT rowid AS \"__br_m2_saved_rowid\", \"singleton\",\"database_instance_id\",\"control_root_json\",\"mutex_identity_json\",\"fence_epoch\",\"admission\",\"active_migration_id\",\"plan_digest\",\"owner_generation\",\"journal_record_ref\",\"journal_digest\",\"journal_sequence\",\"protocol_version\",\"guard_manifest_digest\" FROM main.storage_maintenance;"
  },
  {
    "id": "save-clients",
    "sql": "CREATE TEMP TABLE \"__br_m2_control_saved_clients\" AS SELECT rowid AS \"__br_m2_saved_rowid\", \"client_id\",\"database_instance_id\",\"entrypoint\",\"build_id\",\"protocol_version\",\"host_identity_json\",\"process_identity_json\",\"db_sessions_json\",\"registered_epoch\",\"observed_epoch\",\"drain_epoch\",\"drain_state\",\"drain_receipt_digest\",\"registered_at\",\"last_observed_at\",\"ended_at\" FROM main.storage_source_clients;"
  },
  {
    "id": "drop-clients",
    "sql": "DROP TABLE main.storage_source_clients;"
  },
  {
    "id": "drop-maintenance",
    "sql": "DROP TABLE main.storage_maintenance;"
  },
  {
    "id": "create-maintenance",
    "sql": "CREATE TABLE main.storage_maintenance (\n  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n  database_instance_id TEXT NOT NULL UNIQUE,\n  control_root_json TEXT,\n  mutex_identity_json TEXT,\n  fence_epoch BIGINT NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),\n  admission TEXT NOT NULL DEFAULT 'open' CHECK (admission IN ('open','draining','sealed')),\n  active_migration_id TEXT,\n  plan_digest TEXT,\n  owner_generation BIGINT NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),\n  journal_record_ref TEXT,\n  journal_digest TEXT,\n  journal_sequence BIGINT NOT NULL DEFAULT 0 CHECK (journal_sequence >= 0),\n  protocol_version INTEGER NOT NULL CHECK (protocol_version IN (1,2)),\n  guard_manifest_digest TEXT NOT NULL CHECK (length(guard_manifest_digest) = 64),\n  profile_takeover_terminal_json TEXT,\n  CHECK ((admission = 'open' AND active_migration_id IS NULL AND plan_digest IS NULL)\n    OR (admission IN ('draining','sealed') AND active_migration_id IS NOT NULL AND plan_digest IS NOT NULL\n      AND control_root_json IS NOT NULL AND mutex_identity_json IS NOT NULL\n      AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND journal_sequence > 0)),\n  CHECK ((journal_sequence = 0 AND journal_record_ref IS NULL AND journal_digest IS NULL)\n    OR (journal_sequence > 0 AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND length(journal_digest)=64)),\n  CHECK (plan_digest IS NULL OR length(plan_digest)=64)\n);"
  },
  {
    "id": "create-clients",
    "sql": "CREATE TABLE main.storage_source_clients (\n  client_id TEXT PRIMARY KEY,\n  database_instance_id TEXT NOT NULL REFERENCES storage_maintenance(database_instance_id),\n  entrypoint TEXT NOT NULL CHECK (entrypoint IN ('http','stdio','local-management','owned-background','maintenance-controller')),\n  build_id TEXT NOT NULL,\n  protocol_version INTEGER NOT NULL CHECK (protocol_version IN (1,2)),\n  host_identity_json TEXT NOT NULL,\n  process_identity_json TEXT NOT NULL,\n  db_sessions_json TEXT NOT NULL,\n  registered_epoch BIGINT NOT NULL CHECK (registered_epoch>=0),\n  observed_epoch BIGINT NOT NULL CHECK (observed_epoch>=0),\n  drain_epoch BIGINT CHECK (drain_epoch IS NULL OR drain_epoch>=0),\n  drain_state TEXT NOT NULL DEFAULT 'none' CHECK (drain_state IN ('none','requested','draining','drained','cancel_pending','cancelled')),\n  drain_receipt_digest TEXT,\n  registered_at TEXT NOT NULL,\n  last_observed_at TEXT NOT NULL,\n  ended_at TEXT,\n  writer_format_digest TEXT,\n  CHECK ((protocol_version=1 AND writer_format_digest IS NULL)\n    OR (protocol_version=2 AND writer_format_digest IS NOT NULL AND length(writer_format_digest)=64)),\n  CHECK (drain_receipt_digest IS NULL OR length(drain_receipt_digest)=64),\n  CHECK (drain_state<>'drained' OR (drain_epoch IS NOT NULL AND drain_receipt_digest IS NOT NULL))\n);"
  },
  {
    "id": "copy-maintenance",
    "sql": "INSERT INTO main.storage_maintenance(\"singleton\",\"database_instance_id\",\"control_root_json\",\"mutex_identity_json\",\"fence_epoch\",\"admission\",\"active_migration_id\",\"plan_digest\",\"owner_generation\",\"journal_record_ref\",\"journal_digest\",\"journal_sequence\",\"protocol_version\",\"guard_manifest_digest\",profile_takeover_terminal_json) SELECT \"singleton\",\"database_instance_id\",\"control_root_json\",\"mutex_identity_json\",\"fence_epoch\",\"admission\",\"active_migration_id\",\"plan_digest\",\"owner_generation\",\"journal_record_ref\",\"journal_digest\",\"journal_sequence\",\"protocol_version\",\"guard_manifest_digest\",NULL FROM temp.\"__br_m2_control_saved_maintenance\";"
  },
  {
    "id": "copy-clients",
    "sql": "INSERT INTO main.storage_source_clients(rowid,\"client_id\",\"database_instance_id\",\"entrypoint\",\"build_id\",\"protocol_version\",\"host_identity_json\",\"process_identity_json\",\"db_sessions_json\",\"registered_epoch\",\"observed_epoch\",\"drain_epoch\",\"drain_state\",\"drain_receipt_digest\",\"registered_at\",\"last_observed_at\",\"ended_at\",writer_format_digest) SELECT \"__br_m2_saved_rowid\",\"client_id\",\"database_instance_id\",\"entrypoint\",\"build_id\",\"protocol_version\",\"host_identity_json\",\"process_identity_json\",\"db_sessions_json\",\"registered_epoch\",\"observed_epoch\",\"drain_epoch\",\"drain_state\",\"drain_receipt_digest\",\"registered_at\",\"last_observed_at\",\"ended_at\",NULL FROM temp.\"__br_m2_control_saved_clients\";"
  },
  {
    "id": "create-client-index",
    "sql": "CREATE INDEX main.storage_source_clients_epoch ON storage_source_clients(registered_epoch, ended_at);"
  },
  {
    "id": "drop-saved-clients",
    "sql": "DROP TABLE temp.\"__br_m2_control_saved_clients\";"
  },
  {
    "id": "drop-saved-maintenance",
    "sql": "DROP TABLE temp.\"__br_m2_control_saved_maintenance\";"
  }
];
const PG_LOCK = "LOCK TABLE {{schema}}.storage_maintenance, {{schema}}.storage_source_clients IN ACCESS EXCLUSIVE MODE NOWAIT;";
const PG_WRITES: readonly M2ControlSqlStep[] = [
  {
    "id": "pg-alter-maintenance",
    "sql": "ALTER TABLE {{schema}}.storage_maintenance\n  ADD COLUMN profile_takeover_terminal_json pg_catalog.text,\n  DROP CONSTRAINT {{maintenance_protocol_check}} RESTRICT,\n  ADD CONSTRAINT {{maintenance_protocol_check}} CHECK (protocol_version OPERATOR(pg_catalog.=) 1 OR protocol_version OPERATOR(pg_catalog.=) 2);"
  },
  {
    "id": "pg-alter-clients",
    "sql": "ALTER TABLE {{schema}}.storage_source_clients\n  ADD COLUMN writer_format_digest pg_catalog.text,\n  DROP CONSTRAINT {{clients_protocol_check}} RESTRICT,\n  ADD CONSTRAINT {{clients_protocol_check}} CHECK (protocol_version OPERATOR(pg_catalog.=) 1 OR protocol_version OPERATOR(pg_catalog.=) 2),\n  ADD CONSTRAINT br_m2_storage_client_format_pair CHECK (\n    (protocol_version OPERATOR(pg_catalog.=) 1 AND writer_format_digest IS NULL)\n    OR (protocol_version OPERATOR(pg_catalog.=) 2 AND writer_format_digest IS NOT NULL\n        AND pg_catalog.length(writer_format_digest) OPERATOR(pg_catalog.=) 64));"
  }
];
const CHECKS: Readonly<Record<Dialect, {readonly prechecks: readonly CheckTemplate[]; readonly copyChecks: readonly CheckTemplate[]; readonly finalChecks: readonly CheckTemplate[]}>> = {
  "sqlite": {
    "prechecks": [
      {
        "id": "sqlite-fk-on-and-valid",
        "sql": "WITH checked(violation) AS (\n SELECT CASE\n  WHEN EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('pragma_foreign_keys','pragma_foreign_key_check'))\n    OR EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN ('pragma_foreign_keys','pragma_foreign_key_check'))\n    THEN 'pragma_name_shadow'\n  WHEN (SELECT foreign_keys FROM main.pragma_foreign_keys()) IS NOT 1 THEN 'foreign_keys_off'\n  WHEN EXISTS(SELECT 1 FROM main.pragma_foreign_key_check()) THEN 'foreign_key_violation'\n  ELSE NULL END\n)\nSELECT violation FROM checked WHERE violation IS NOT NULL;",
        "params": []
      },
      {
        "id": "sqlite-reserved-and-shadow",
        "sql": "SELECT 'main_reserved_name' AS violation FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('__br_m2_control_saved_maintenance','__br_m2_control_saved_clients')\nUNION ALL SELECT 'temp_reserved_or_shadow' FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN ('__br_m2_control_saved_maintenance','__br_m2_control_saved_clients','storage_maintenance','storage_source_clients');",
        "params": []
      },
      {
        "id": "sqlite-temp-unknown-dependencies",
        "sql": "SELECT 'temp_view_or_trigger' AS violation FROM temp.sqlite_schema WHERE type IN ('view','trigger');",
        "params": []
      }
    ],
    "copyChecks": [
      {
        "id": "sqlite-copy-maintenance",
        "sql": "SELECT 'old_typed_cell_or_rowid_mismatch' AS violation WHERE\n (SELECT count(*) FROM main.storage_maintenance) IS NOT (SELECT count(*) FROM temp.\"__br_m2_control_saved_maintenance\")\n OR EXISTS (SELECT 1 FROM temp.\"__br_m2_control_saved_maintenance\" AS b LEFT JOIN main.storage_maintenance AS a ON a.rowid=b.\"__br_m2_saved_rowid\"\n WHERE a.rowid IS NULL OR\n typeof(a.\"singleton\") IS NOT typeof(b.\"singleton\") OR a.\"singleton\" IS NOT b.\"singleton\" OR (typeof(a.\"singleton\") IN ('text','blob') AND hex(a.\"singleton\") IS NOT hex(b.\"singleton\")) OR\n typeof(a.\"database_instance_id\") IS NOT typeof(b.\"database_instance_id\") OR a.\"database_instance_id\" IS NOT b.\"database_instance_id\" OR (typeof(a.\"database_instance_id\") IN ('text','blob') AND hex(a.\"database_instance_id\") IS NOT hex(b.\"database_instance_id\")) OR\n typeof(a.\"control_root_json\") IS NOT typeof(b.\"control_root_json\") OR a.\"control_root_json\" IS NOT b.\"control_root_json\" OR (typeof(a.\"control_root_json\") IN ('text','blob') AND hex(a.\"control_root_json\") IS NOT hex(b.\"control_root_json\")) OR\n typeof(a.\"mutex_identity_json\") IS NOT typeof(b.\"mutex_identity_json\") OR a.\"mutex_identity_json\" IS NOT b.\"mutex_identity_json\" OR (typeof(a.\"mutex_identity_json\") IN ('text','blob') AND hex(a.\"mutex_identity_json\") IS NOT hex(b.\"mutex_identity_json\")) OR\n typeof(a.\"fence_epoch\") IS NOT typeof(b.\"fence_epoch\") OR a.\"fence_epoch\" IS NOT b.\"fence_epoch\" OR (typeof(a.\"fence_epoch\") IN ('text','blob') AND hex(a.\"fence_epoch\") IS NOT hex(b.\"fence_epoch\")) OR\n typeof(a.\"admission\") IS NOT typeof(b.\"admission\") OR a.\"admission\" IS NOT b.\"admission\" OR (typeof(a.\"admission\") IN ('text','blob') AND hex(a.\"admission\") IS NOT hex(b.\"admission\")) OR\n typeof(a.\"active_migration_id\") IS NOT typeof(b.\"active_migration_id\") OR a.\"active_migration_id\" IS NOT b.\"active_migration_id\" OR (typeof(a.\"active_migration_id\") IN ('text','blob') AND hex(a.\"active_migration_id\") IS NOT hex(b.\"active_migration_id\")) OR\n typeof(a.\"plan_digest\") IS NOT typeof(b.\"plan_digest\") OR a.\"plan_digest\" IS NOT b.\"plan_digest\" OR (typeof(a.\"plan_digest\") IN ('text','blob') AND hex(a.\"plan_digest\") IS NOT hex(b.\"plan_digest\")) OR\n typeof(a.\"owner_generation\") IS NOT typeof(b.\"owner_generation\") OR a.\"owner_generation\" IS NOT b.\"owner_generation\" OR (typeof(a.\"owner_generation\") IN ('text','blob') AND hex(a.\"owner_generation\") IS NOT hex(b.\"owner_generation\")) OR\n typeof(a.\"journal_record_ref\") IS NOT typeof(b.\"journal_record_ref\") OR a.\"journal_record_ref\" IS NOT b.\"journal_record_ref\" OR (typeof(a.\"journal_record_ref\") IN ('text','blob') AND hex(a.\"journal_record_ref\") IS NOT hex(b.\"journal_record_ref\")) OR\n typeof(a.\"journal_digest\") IS NOT typeof(b.\"journal_digest\") OR a.\"journal_digest\" IS NOT b.\"journal_digest\" OR (typeof(a.\"journal_digest\") IN ('text','blob') AND hex(a.\"journal_digest\") IS NOT hex(b.\"journal_digest\")) OR\n typeof(a.\"journal_sequence\") IS NOT typeof(b.\"journal_sequence\") OR a.\"journal_sequence\" IS NOT b.\"journal_sequence\" OR (typeof(a.\"journal_sequence\") IN ('text','blob') AND hex(a.\"journal_sequence\") IS NOT hex(b.\"journal_sequence\")) OR\n typeof(a.\"protocol_version\") IS NOT typeof(b.\"protocol_version\") OR a.\"protocol_version\" IS NOT b.\"protocol_version\" OR (typeof(a.\"protocol_version\") IN ('text','blob') AND hex(a.\"protocol_version\") IS NOT hex(b.\"protocol_version\")) OR\n typeof(a.\"guard_manifest_digest\") IS NOT typeof(b.\"guard_manifest_digest\") OR a.\"guard_manifest_digest\" IS NOT b.\"guard_manifest_digest\" OR (typeof(a.\"guard_manifest_digest\") IN ('text','blob') AND hex(a.\"guard_manifest_digest\") IS NOT hex(b.\"guard_manifest_digest\")))\n OR EXISTS (SELECT 1 FROM main.storage_maintenance AS a LEFT JOIN temp.\"__br_m2_control_saved_maintenance\" AS b ON a.rowid=b.\"__br_m2_saved_rowid\" WHERE b.\"__br_m2_saved_rowid\" IS NULL);",
        "params": []
      },
      {
        "id": "sqlite-copy-clients",
        "sql": "SELECT 'old_typed_cell_or_rowid_mismatch' AS violation WHERE\n (SELECT count(*) FROM main.storage_source_clients) IS NOT (SELECT count(*) FROM temp.\"__br_m2_control_saved_clients\")\n OR EXISTS (SELECT 1 FROM temp.\"__br_m2_control_saved_clients\" AS b LEFT JOIN main.storage_source_clients AS a ON a.rowid=b.\"__br_m2_saved_rowid\"\n WHERE a.rowid IS NULL OR\n typeof(a.\"client_id\") IS NOT typeof(b.\"client_id\") OR a.\"client_id\" IS NOT b.\"client_id\" OR (typeof(a.\"client_id\") IN ('text','blob') AND hex(a.\"client_id\") IS NOT hex(b.\"client_id\")) OR\n typeof(a.\"database_instance_id\") IS NOT typeof(b.\"database_instance_id\") OR a.\"database_instance_id\" IS NOT b.\"database_instance_id\" OR (typeof(a.\"database_instance_id\") IN ('text','blob') AND hex(a.\"database_instance_id\") IS NOT hex(b.\"database_instance_id\")) OR\n typeof(a.\"entrypoint\") IS NOT typeof(b.\"entrypoint\") OR a.\"entrypoint\" IS NOT b.\"entrypoint\" OR (typeof(a.\"entrypoint\") IN ('text','blob') AND hex(a.\"entrypoint\") IS NOT hex(b.\"entrypoint\")) OR\n typeof(a.\"build_id\") IS NOT typeof(b.\"build_id\") OR a.\"build_id\" IS NOT b.\"build_id\" OR (typeof(a.\"build_id\") IN ('text','blob') AND hex(a.\"build_id\") IS NOT hex(b.\"build_id\")) OR\n typeof(a.\"protocol_version\") IS NOT typeof(b.\"protocol_version\") OR a.\"protocol_version\" IS NOT b.\"protocol_version\" OR (typeof(a.\"protocol_version\") IN ('text','blob') AND hex(a.\"protocol_version\") IS NOT hex(b.\"protocol_version\")) OR\n typeof(a.\"host_identity_json\") IS NOT typeof(b.\"host_identity_json\") OR a.\"host_identity_json\" IS NOT b.\"host_identity_json\" OR (typeof(a.\"host_identity_json\") IN ('text','blob') AND hex(a.\"host_identity_json\") IS NOT hex(b.\"host_identity_json\")) OR\n typeof(a.\"process_identity_json\") IS NOT typeof(b.\"process_identity_json\") OR a.\"process_identity_json\" IS NOT b.\"process_identity_json\" OR (typeof(a.\"process_identity_json\") IN ('text','blob') AND hex(a.\"process_identity_json\") IS NOT hex(b.\"process_identity_json\")) OR\n typeof(a.\"db_sessions_json\") IS NOT typeof(b.\"db_sessions_json\") OR a.\"db_sessions_json\" IS NOT b.\"db_sessions_json\" OR (typeof(a.\"db_sessions_json\") IN ('text','blob') AND hex(a.\"db_sessions_json\") IS NOT hex(b.\"db_sessions_json\")) OR\n typeof(a.\"registered_epoch\") IS NOT typeof(b.\"registered_epoch\") OR a.\"registered_epoch\" IS NOT b.\"registered_epoch\" OR (typeof(a.\"registered_epoch\") IN ('text','blob') AND hex(a.\"registered_epoch\") IS NOT hex(b.\"registered_epoch\")) OR\n typeof(a.\"observed_epoch\") IS NOT typeof(b.\"observed_epoch\") OR a.\"observed_epoch\" IS NOT b.\"observed_epoch\" OR (typeof(a.\"observed_epoch\") IN ('text','blob') AND hex(a.\"observed_epoch\") IS NOT hex(b.\"observed_epoch\")) OR\n typeof(a.\"drain_epoch\") IS NOT typeof(b.\"drain_epoch\") OR a.\"drain_epoch\" IS NOT b.\"drain_epoch\" OR (typeof(a.\"drain_epoch\") IN ('text','blob') AND hex(a.\"drain_epoch\") IS NOT hex(b.\"drain_epoch\")) OR\n typeof(a.\"drain_state\") IS NOT typeof(b.\"drain_state\") OR a.\"drain_state\" IS NOT b.\"drain_state\" OR (typeof(a.\"drain_state\") IN ('text','blob') AND hex(a.\"drain_state\") IS NOT hex(b.\"drain_state\")) OR\n typeof(a.\"drain_receipt_digest\") IS NOT typeof(b.\"drain_receipt_digest\") OR a.\"drain_receipt_digest\" IS NOT b.\"drain_receipt_digest\" OR (typeof(a.\"drain_receipt_digest\") IN ('text','blob') AND hex(a.\"drain_receipt_digest\") IS NOT hex(b.\"drain_receipt_digest\")) OR\n typeof(a.\"registered_at\") IS NOT typeof(b.\"registered_at\") OR a.\"registered_at\" IS NOT b.\"registered_at\" OR (typeof(a.\"registered_at\") IN ('text','blob') AND hex(a.\"registered_at\") IS NOT hex(b.\"registered_at\")) OR\n typeof(a.\"last_observed_at\") IS NOT typeof(b.\"last_observed_at\") OR a.\"last_observed_at\" IS NOT b.\"last_observed_at\" OR (typeof(a.\"last_observed_at\") IN ('text','blob') AND hex(a.\"last_observed_at\") IS NOT hex(b.\"last_observed_at\")) OR\n typeof(a.\"ended_at\") IS NOT typeof(b.\"ended_at\") OR a.\"ended_at\" IS NOT b.\"ended_at\" OR (typeof(a.\"ended_at\") IN ('text','blob') AND hex(a.\"ended_at\") IS NOT hex(b.\"ended_at\")))\n OR EXISTS (SELECT 1 FROM main.storage_source_clients AS a LEFT JOIN temp.\"__br_m2_control_saved_clients\" AS b ON a.rowid=b.\"__br_m2_saved_rowid\" WHERE b.\"__br_m2_saved_rowid\" IS NULL);",
        "params": []
      }
    ],
    "finalChecks": [
      {
        "id": "sqlite-new-values-null",
        "sql": "SELECT 'non_null_new_terminal' AS violation FROM main.storage_maintenance WHERE profile_takeover_terminal_json IS NOT NULL\nUNION ALL SELECT 'non_null_new_writer_format' FROM main.storage_source_clients WHERE writer_format_digest IS NOT NULL;",
        "params": []
      },
      {
        "id": "sqlite-final-fk",
        "sql": "WITH checked(violation) AS (\n SELECT CASE\n  WHEN EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('pragma_foreign_keys','pragma_foreign_key_check'))\n    OR EXISTS(SELECT 1 FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN ('pragma_foreign_keys','pragma_foreign_key_check'))\n    THEN 'pragma_name_shadow'\n  WHEN (SELECT foreign_keys FROM main.pragma_foreign_keys()) IS NOT 1 THEN 'foreign_keys_off'\n  WHEN EXISTS(SELECT 1 FROM main.pragma_foreign_key_check()) THEN 'foreign_key_violation'\n  ELSE NULL END\n)\nSELECT violation FROM checked WHERE violation IS NOT NULL;",
        "params": []
      },
      {
        "id": "sqlite-backups-absent",
        "sql": "SELECT 'main_reserved_name' AS violation FROM main.sqlite_schema WHERE name COLLATE NOCASE IN ('__br_m2_control_saved_maintenance','__br_m2_control_saved_clients')\nUNION ALL SELECT 'temp_reserved_name' FROM temp.sqlite_schema WHERE name COLLATE NOCASE IN ('__br_m2_control_saved_maintenance','__br_m2_control_saved_clients');",
        "params": []
      },
      {
        "id": "sqlite-fixed-target-catalog",
        "sql": "SELECT 'target_catalog_mismatch' AS violation WHERE\n NOT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='storage_maintenance' AND sql=?)\n OR NOT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='storage_source_clients' AND sql=?)\n OR NOT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type='index' AND name='storage_source_clients_epoch' AND tbl_name='storage_source_clients' AND sql=?)\n OR (SELECT count(*) FROM main.sqlite_schema WHERE tbl_name='storage_maintenance')<>2\n OR (SELECT count(*) FROM main.sqlite_schema WHERE tbl_name='storage_source_clients')<>3;",
        "params": [
          "CREATE TABLE storage_maintenance (\n  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n  database_instance_id TEXT NOT NULL UNIQUE,\n  control_root_json TEXT,\n  mutex_identity_json TEXT,\n  fence_epoch BIGINT NOT NULL DEFAULT 0 CHECK (fence_epoch >= 0),\n  admission TEXT NOT NULL DEFAULT 'open' CHECK (admission IN ('open','draining','sealed')),\n  active_migration_id TEXT,\n  plan_digest TEXT,\n  owner_generation BIGINT NOT NULL DEFAULT 0 CHECK (owner_generation >= 0),\n  journal_record_ref TEXT,\n  journal_digest TEXT,\n  journal_sequence BIGINT NOT NULL DEFAULT 0 CHECK (journal_sequence >= 0),\n  protocol_version INTEGER NOT NULL CHECK (protocol_version IN (1,2)),\n  guard_manifest_digest TEXT NOT NULL CHECK (length(guard_manifest_digest) = 64),\n  profile_takeover_terminal_json TEXT,\n  CHECK ((admission = 'open' AND active_migration_id IS NULL AND plan_digest IS NULL)\n    OR (admission IN ('draining','sealed') AND active_migration_id IS NOT NULL AND plan_digest IS NOT NULL\n      AND control_root_json IS NOT NULL AND mutex_identity_json IS NOT NULL\n      AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND journal_sequence > 0)),\n  CHECK ((journal_sequence = 0 AND journal_record_ref IS NULL AND journal_digest IS NULL)\n    OR (journal_sequence > 0 AND journal_record_ref IS NOT NULL AND journal_digest IS NOT NULL AND length(journal_digest)=64)),\n  CHECK (plan_digest IS NULL OR length(plan_digest)=64)\n)",
          "CREATE TABLE storage_source_clients (\n  client_id TEXT PRIMARY KEY,\n  database_instance_id TEXT NOT NULL REFERENCES storage_maintenance(database_instance_id),\n  entrypoint TEXT NOT NULL CHECK (entrypoint IN ('http','stdio','local-management','owned-background','maintenance-controller')),\n  build_id TEXT NOT NULL,\n  protocol_version INTEGER NOT NULL CHECK (protocol_version IN (1,2)),\n  host_identity_json TEXT NOT NULL,\n  process_identity_json TEXT NOT NULL,\n  db_sessions_json TEXT NOT NULL,\n  registered_epoch BIGINT NOT NULL CHECK (registered_epoch>=0),\n  observed_epoch BIGINT NOT NULL CHECK (observed_epoch>=0),\n  drain_epoch BIGINT CHECK (drain_epoch IS NULL OR drain_epoch>=0),\n  drain_state TEXT NOT NULL DEFAULT 'none' CHECK (drain_state IN ('none','requested','draining','drained','cancel_pending','cancelled')),\n  drain_receipt_digest TEXT,\n  registered_at TEXT NOT NULL,\n  last_observed_at TEXT NOT NULL,\n  ended_at TEXT,\n  writer_format_digest TEXT,\n  CHECK ((protocol_version=1 AND writer_format_digest IS NULL)\n    OR (protocol_version=2 AND writer_format_digest IS NOT NULL AND length(writer_format_digest)=64)),\n  CHECK (drain_receipt_digest IS NULL OR length(drain_receipt_digest)=64),\n  CHECK (drain_state<>'drained' OR (drain_epoch IS NOT NULL AND drain_receipt_digest IS NOT NULL))\n)",
          "CREATE INDEX storage_source_clients_epoch ON storage_source_clients(registered_epoch, ended_at)"
        ]
      }
    ]
  },
  "postgres": {
    "prechecks": [
      {
        "id": "pg-source-identities",
        "parameterSources": [
          "namespace.oid",
          "namespace.name",
          "storage_maintenance.oid",
          "storage_source_clients.oid"
        ],
        "sql": "WITH e AS (SELECT ?::pg_catalog.oid AS namespace_oid,?::pg_catalog.text AS namespace_name,?::pg_catalog.oid AS maintenance_oid,?::pg_catalog.oid AS clients_oid)\nSELECT 'source_identity_mismatch' AS violation FROM e WHERE\n pg_catalog.current_schema() IS NULL OR pg_catalog.current_schema()::pg_catalog.text OPERATOR(pg_catalog.<>) e.namespace_name\n OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace AS n WHERE n.oid OPERATOR(pg_catalog.=) e.namespace_oid AND n.nspname::pg_catalog.text OPERATOR(pg_catalog.=) e.namespace_name)\n OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_am AS a ON a.oid OPERATOR(pg_catalog.=) c.relam WHERE c.oid OPERATOR(pg_catalog.=) e.maintenance_oid AND c.relnamespace OPERATOR(pg_catalog.=) e.namespace_oid AND c.relname::pg_catalog.text OPERATOR(pg_catalog.=) 'storage_maintenance' AND c.relkind OPERATOR(pg_catalog.=) 'r' AND c.relpersistence OPERATOR(pg_catalog.=) 'p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND a.amname::pg_catalog.text OPERATOR(pg_catalog.=) 'heap')\n OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_am AS a ON a.oid OPERATOR(pg_catalog.=) c.relam WHERE c.oid OPERATOR(pg_catalog.=) e.clients_oid AND c.relnamespace OPERATOR(pg_catalog.=) e.namespace_oid AND c.relname::pg_catalog.text OPERATOR(pg_catalog.=) 'storage_source_clients' AND c.relkind OPERATOR(pg_catalog.=) 'r' AND c.relpersistence OPERATOR(pg_catalog.=) 'p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND a.amname::pg_catalog.text OPERATOR(pg_catalog.=) 'heap');"
      },
      {
        "id": "pg-no-rewrite-dependencies",
        "parameterSources": [
          "storage_maintenance.oid",
          "storage_source_clients.oid"
        ],
        "sql": "WITH target(oid) AS (VALUES (?::pg_catalog.oid),(?::pg_catalog.oid))\nSELECT 'unknown_rewrite_dependency' AS violation FROM pg_catalog.pg_rewrite AS r\nWHERE EXISTS(SELECT 1 FROM target AS t WHERE r.ev_class OPERATOR(pg_catalog.=) t.oid) OR EXISTS (\n SELECT 1 FROM pg_catalog.pg_depend AS d WHERE d.classid OPERATOR(pg_catalog.=) 'pg_catalog.pg_rewrite'::pg_catalog.regclass AND d.objid OPERATOR(pg_catalog.=) r.oid\n AND d.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_class'::pg_catalog.regclass AND EXISTS(SELECT 1 FROM target AS t WHERE d.refobjid OPERATOR(pg_catalog.=) t.oid)) LIMIT 1;"
      },
      {
        "id": "pg-no-enabled-event-trigger",
        "parameterSources": [],
        "sql": "SELECT 'enabled_event_trigger' AS violation FROM pg_catalog.pg_event_trigger WHERE evtenabled OPERATOR(pg_catalog.<>) 'D' LIMIT 1;"
      },
      {
        "id": "pg-format-constraint-name-free",
        "parameterSources": [
          "storage_source_clients.oid"
        ],
        "sql": "SELECT 'format_constraint_name_taken' AS violation FROM pg_catalog.pg_constraint WHERE conrelid OPERATOR(pg_catalog.=) ?::pg_catalog.oid AND conname::pg_catalog.text OPERATOR(pg_catalog.=) 'br_m2_storage_client_format_pair' LIMIT 1;"
      }
    ],
    "copyChecks": [],
    "finalChecks": [
      {
        "id": "pg-new-columns-exact",
        "parameterSources": [
          "storage_maintenance.oid",
          "storage_source_clients.oid"
        ],
        "sql": "WITH expected(table_oid,ordinal,name) AS (VALUES (?::pg_catalog.oid,15,'profile_takeover_terminal_json'),(?::pg_catalog.oid,17,'writer_format_digest'))\nSELECT 'new_column_mismatch' AS violation FROM expected AS e WHERE NOT EXISTS (\n SELECT 1 FROM pg_catalog.pg_attribute AS a LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid OPERATOR(pg_catalog.=) a.attrelid AND d.adnum OPERATOR(pg_catalog.=) a.attnum\n WHERE a.attrelid OPERATOR(pg_catalog.=) e.table_oid AND a.attnum OPERATOR(pg_catalog.=) e.ordinal AND a.attname::pg_catalog.text OPERATOR(pg_catalog.=) e.name AND a.atttypid OPERATOR(pg_catalog.=) 25 AND a.atttypmod OPERATOR(pg_catalog.=) '-1'::pg_catalog.int4\n AND NOT a.attnotnull AND NOT a.attisdropped AND a.attidentity OPERATOR(pg_catalog.=) '' AND a.attgenerated OPERATOR(pg_catalog.=) '' AND d.oid IS NULL\n AND a.attcollation OPERATOR(pg_catalog.=) (SELECT typcollation FROM pg_catalog.pg_type WHERE oid OPERATOR(pg_catalog.=) 25));"
      },
      {
        "id": "pg-new-values-null",
        "parameterSources": [],
        "sql": "SELECT 'non_null_new_terminal' AS violation FROM {{schema}}.storage_maintenance WHERE profile_takeover_terminal_json IS NOT NULL\nUNION ALL SELECT 'non_null_new_writer_format' FROM {{schema}}.storage_source_clients WHERE writer_format_digest IS NOT NULL;"
      },
      {
        "id": "pg-new-check-metadata",
        "parameterSources": [
          "storage_maintenance.oid",
          "maintenance_protocol_check",
          "storage_source_clients.oid",
          "clients_protocol_check",
          "storage_source_clients.oid"
        ],
        "sql": "WITH expected(table_oid,name,keys) AS (VALUES (?::pg_catalog.oid,?::pg_catalog.text,ARRAY[13]::pg_catalog.int2[]),(?::pg_catalog.oid,?::pg_catalog.text,ARRAY[5]::pg_catalog.int2[]),(?::pg_catalog.oid,'br_m2_storage_client_format_pair',ARRAY[5,17]::pg_catalog.int2[]))\nSELECT 'new_check_metadata_mismatch' AS violation FROM expected AS e WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c\n WHERE c.conrelid OPERATOR(pg_catalog.=) e.table_oid AND c.conname::pg_catalog.text OPERATOR(pg_catalog.=) e.name AND c.contype OPERATOR(pg_catalog.=) 'c' AND c.convalidated AND c.conislocal\n AND NOT c.condeferrable AND NOT c.condeferred AND c.conparentid OPERATOR(pg_catalog.=) 0 AND c.coninhcount OPERATOR(pg_catalog.=) 0 AND NOT c.connoinherit\n AND (SELECT pg_catalog.array_agg(k ORDER BY k USING OPERATOR(pg_catalog.<)) FROM pg_catalog.unnest(c.conkey) AS u(k)) OPERATOR(pg_catalog.=) e.keys) OPERATOR(pg_catalog.<>) 1;"
      }
    ]
  }
};

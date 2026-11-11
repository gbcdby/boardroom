/**
 * M1（#54）数据迁移与回滚工具：在 SQLite / PostgreSQL 之间搬迁业务数据。
 *
 * 设计要点：
 * - 复用 F1（#46）的 DbDriver / createDbDriver 连接工厂打开「源」与「目标」，
 *   不绕过驱动直连（约束：迁移工具不得改动既有业务 schema）。
 * - 目标 PG 的建表 DDL 由本文件私有的 `PG_BUSINESS_SCHEMA_MIGRATIONS` 提供
 *   （业务表 v1–v6 的 PG 方言镜像），与 `migrations/index.ts` 的 SQLite DDL 平行；
 *   生产 `migrations` 完全不动，满足「不改动既有业务 schema」硬约束。
 *   PG 镜像仅在 `messages.mentions` 上省略了 `json_valid/json_type` 检查
 *   （PG 无这两个函数；仓库层写入前已校验 JSON，见 repositories）。
 * - 源库全程只读：迁移 = 把源库全量业务数据写入目标库；回滚 = 丢弃目标库
 *   （源库不受影响，切回源驱动即恢复阶段 1 行为）。可选 `--snapshot` 对 SQLite
 *   源库做文件级快照作为额外安全网。
 * - 业务表按外键依赖顺序拷贝（父表先于子表），`org_nodes` 经递归 CTE 按层级
 *   （父在上）排序，保证 PG/SQLite 在事务内的即时外键检查都能通过。
 * - 不迁移 `schema_migrations`（纯元数据）。
 */
import { copyFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";

import { DATABASE_FILE_NAME } from "./database.ts";
import { createDbDriver } from "./driver.ts";
import type { DbDriver, DbDriverOptions, DbRow, DbTransaction } from "./driver.ts";
import type { Migration } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { durableMessageDispatch } from "./migrations/message-dispatch.ts";
import { managedRuntime } from "./migrations/runtime.ts";
import { runtimeObservabilityMigration } from "./migrations/runtime-observability.ts";
import { runtimeProcessIdentityMigration } from "./migrations/runtime-process-identity.ts";
import { tasksMigration } from "./migrations/tasks.ts";
import { memoryMigration } from "./migrations/memory.ts";

// ---------------------------------------------------------------------------
// 业务表清单（外键安全的拷贝顺序：父表先于子表）
// ---------------------------------------------------------------------------

/** 单张业务表的拷贝/校验规格。 */
export interface TableSpec {
  /** 表名。 */
  readonly name: string;
  /** 作为主键的「键列」，用于跨库一致性校验（复合主键用多列）。 */
  readonly keyColumns: readonly string[];
  /** 覆盖默认 `SELECT *` 的源读取 SQL（如 org_nodes 的层级排序）。 */
  readonly readSql?: string;
}

/**
 * 业务表（不含 `schema_migrations`）。
 * 顺序（外键安全，父表先于子表；`org_nodes` 先于 `members` 因其持有
 * `members.node_id` 外键）：
 * agents → projects → org_nodes → members → groups → group_participants
 * → messages → message_deliveries → member_statuses → mcp_sessions → audit_log。
 */
export const BUSINESS_TABLES: readonly TableSpec[] = [
  { name: "agents", keyColumns: ["id"] },
  { name: "projects", keyColumns: ["id"] },
  { name: "memory_documents", keyColumns: ["id"] },
  { name: "memory_versions", keyColumns: ["id"] },
  {
    name: "org_nodes",
    keyColumns: ["id"],
    // 父节点先于子节点，保证即时外键检查通过。
    readSql: [
      "WITH RECURSIVE _depth AS (",
      "  SELECT id, 0 AS depth FROM org_nodes WHERE parent_id IS NULL",
      "  UNION ALL",
      "  SELECT c.id, p.depth + 1 FROM org_nodes c INNER JOIN _depth p ON c.parent_id = p.id",
      ")",
      "SELECT n.* FROM org_nodes n INNER JOIN _depth d ON n.id = d.id ORDER BY d.depth, n.id",
    ].join("\n"),
  },
  { name: "members", keyColumns: ["id"] },
  { name: "project_task_settings", keyColumns: ["project_id"] },
  { name: "tasks", keyColumns: ["id"] },
  { name: "task_review_rounds", keyColumns: ["id"] },
  { name: "task_review_reports", keyColumns: ["id"] },
  { name: "task_comments", keyColumns: ["id"] },
  { name: "task_history", keyColumns: ["id"] },
  { name: "groups", keyColumns: ["id"] },
  { name: "work_events", keyColumns: ["id"] },
  { name: "memory_summary_requests", keyColumns: ["id"] },
  { name: "memory_trigger_counters", keyColumns: ["project_id", "agent_id", "group_id"] },
  { name: "memory_scan_checkpoints", keyColumns: ["id"] },
  { name: "group_participants", keyColumns: ["group_id", "member_id"] },
  { name: "messages", keyColumns: ["id"] },
  { name: "memory_message_receipts", keyColumns: ["agent_id", "message_id"] },
  { name: "task_message_links", keyColumns: ["task_id", "message_id"] },
  { name: "message_deliveries", keyColumns: ["id"] },
  { name: "member_statuses", keyColumns: ["project_id", "member_id"] },
  { name: "mcp_sessions", keyColumns: ["id"] },
  { name: "audit_log", keyColumns: ["id"] },
  { name: "agent_runtimes", keyColumns: ["id"] },
  { name: "agent_runtime_bindings", keyColumns: ["id"] },
  { name: "agent_runner_states", keyColumns: ["binding_id"] },
  { name: "agent_runtime_members", keyColumns: ["member_id"] },
  { name: "agent_runtime_events", keyColumns: ["id"] },
  { name: "agent_runtime_observation_meta", keyColumns: ["id"] },
  { name: "agent_runtime_usage_snapshots", keyColumns: ["id"] },
];

/** 清空目标表时使用的反向顺序（子表先于父表），避免删除触发外键冲突。 */
const REVERSE_TABLE_ORDER: readonly string[] = [...BUSINESS_TABLES]
  .map((t) => t.name)
  .reverse();

// ---------------------------------------------------------------------------
// PostgreSQL 业务表 DDL（v1–v6 的 PG 方言镜像；生产 SQLite DDL 完全不动）
// ---------------------------------------------------------------------------

const PG_INIT_DOMAIN_MODEL: Migration = {
  version: 1,
  name: "init_domain_model",
  up: [
    `CREATE TABLE agents (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      host_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT,
      CHECK (length(trim(display_name)) > 0),
      CHECK (length(trim(host_type)) > 0)
    )`,
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(trim(name)) > 0)
    )`,
    `CREATE TABLE members (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('agent','human')),
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('manager','normal')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(trim(display_name)) > 0),
      CHECK ((kind = 'agent' AND agent_id IS NOT NULL) OR (kind = 'human' AND agent_id IS NULL))
    )`,
    `CREATE UNIQUE INDEX ux_members_project_manager ON members (project_id) WHERE role = 'manager'`,
    `CREATE INDEX ix_members_project ON members (project_id)`,
    `CREATE UNIQUE INDEX ux_members_project_agent ON members (project_id, agent_id) WHERE agent_id IS NOT NULL`,
    `CREATE TABLE groups (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(trim(name)) > 0)
    )`,
    `CREATE INDEX ix_groups_project ON groups (project_id)`,
    `CREATE TABLE group_participants (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, member_id)
    )`,
    `CREATE INDEX ix_group_participants_member ON group_participants (member_id)`,
    `CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      sender_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      seq INTEGER NOT NULL,
      body TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      CHECK (seq > 0)
    )`,
    `CREATE UNIQUE INDEX ux_messages_group_seq ON messages (group_id, seq)`,
    `CREATE INDEX ix_messages_group_seq ON messages (group_id, seq)`,
    `CREATE TABLE message_deliveries (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending','delivered','acked')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      first_delivered_at TEXT,
      last_delivered_at TEXT,
      acked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX ux_deliveries_message_member ON message_deliveries (message_id, member_id)`,
    `CREATE INDEX ix_deliveries_member_status ON message_deliveries (project_id, member_id, status)`,
    `CREATE TABLE member_statuses (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('online','offline','waiting','working')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, member_id)
    )`,
    `CREATE UNIQUE INDEX ux_member_statuses_scope ON member_statuses (project_id, member_id)`,
    `CREATE INDEX ix_member_statuses_state ON member_statuses (project_id, state)`,
  ].join(";\n"),
};

const PG_MCP_SESSIONS_AND_AGENT_IDENTITY: Migration = {
  version: 2,
  name: "mcp_sessions_and_agent_identity",
  up: [
    `CREATE UNIQUE INDEX ux_agents_identity ON agents (display_name, host_type)`,
    `CREATE TABLE mcp_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      host_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'connected' CHECK (state IN ('connected','disconnected')),
      connected_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      disconnected_at TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX ix_mcp_sessions_agent ON mcp_sessions (agent_id)`,
    `CREATE INDEX ix_mcp_sessions_state ON mcp_sessions (state)`,
    `CREATE UNIQUE INDEX ux_mcp_sessions_active ON mcp_sessions (agent_id, project_id, group_id) WHERE state = 'connected'`,
  ].join(";\n"),
};

const PG_ARCHIVE_FLAGS: Migration = {
  version: 3,
  name: "archive_flags_for_project_and_group",
  up: [
    `ALTER TABLE projects ADD COLUMN archived_at TEXT`,
    `ALTER TABLE groups ADD COLUMN archived_at TEXT`,
    `CREATE INDEX ix_projects_archived ON projects (archived_at)`,
    `CREATE INDEX ix_groups_project_archived ON groups (project_id, archived_at)`,
  ].join(";\n"),
};

const PG_ORG_TREE_AND_STATIC_ROLES: Migration = {
  version: 4,
  name: "org_tree_and_static_roles",
  up: [
    `CREATE TABLE org_nodes (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id TEXT NULL REFERENCES org_nodes(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','top_manager','sub_manager','member')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(trim(name)) > 0)
    )`,
    `CREATE UNIQUE INDEX ux_org_nodes_single_root ON org_nodes (project_id) WHERE parent_id IS NULL`,
    `CREATE INDEX ix_org_nodes_project ON org_nodes (project_id)`,
    `CREATE INDEX ix_org_nodes_parent ON org_nodes (parent_id)`,
    `ALTER TABLE members ADD COLUMN node_id TEXT REFERENCES org_nodes(id) ON DELETE SET NULL`,
    `CREATE UNIQUE INDEX ux_members_node ON members (node_id) WHERE node_id IS NOT NULL`,
    `DROP INDEX ux_members_project_manager`,
  ].join(";\n"),
};

const PG_MEMBER_LIFECYCLE_STATUS: Migration = {
  version: 5,
  name: "member_lifecycle_status",
  up: [
    `ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending'))`,
    `CREATE INDEX ix_members_project_status ON members (project_id, status)`,
  ].join(";\n"),
};

const PG_INIT_AUDIT_LOG: Migration = {
  version: 6,
  name: "init_audit_log",
  up: [
    `CREATE TABLE audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
      actor_member_id TEXT,
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('member','node','role','capability','group','project')),
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      changed TEXT,
      before TEXT,
      after TEXT,
      detail TEXT,
      reversed_at TEXT,
      reversed_by_audit_id TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX ix_audit_project_created ON audit_log (project_id, created_at, id)`,
    `CREATE INDEX ix_audit_project_target ON audit_log (project_id, target_kind, target_id, id)`,
    `CREATE INDEX ix_audit_project_action ON audit_log (project_id, action)`,
  ].join(";\n"),
};

/**
 * PG 目标库的业务表建表 DDL（与 `migrations/index.ts` 的 SQLite DDL 平行镜像）。
 * 生产 `migrations` 完全不动；此处仅在 `messages.mentions` 省略了 PG 不支持的
 * `json_valid/json_type` 检查（仓库层写入前已校验 JSON）。
 */
export const PG_BUSINESS_SCHEMA_MIGRATIONS: readonly Migration[] = [
  PG_INIT_DOMAIN_MODEL,
  PG_MCP_SESSIONS_AND_AGENT_IDENTITY,
  PG_ARCHIVE_FLAGS,
  PG_ORG_TREE_AND_STATIC_ROLES,
  PG_MEMBER_LIFECYCLE_STATUS,
  PG_INIT_AUDIT_LOG,
  durableMessageDispatch,
  managedRuntime,
  runtimeObservabilityMigration,
  runtimeProcessIdentityMigration,
  tasksMigration,
  memoryMigration,
];

// ---------------------------------------------------------------------------
// 驱动打开 / 目标建表 / 清空
// ---------------------------------------------------------------------------

/** 按配置打开并连接一个驱动（源或目标）。 */
export async function openDriver(options: DbDriverOptions): Promise<DbDriver> {
  const driver = createDbDriver(options);
  await driver.connect();
  return driver;
}

/** 在目标库创建业务表（PG 用镜像 DDL，SQLite 用生产 DDL）。幂等。 */
export async function ensureTargetSchema(driver: DbDriver): Promise<void> {
  const list = driver.kind === "postgres" ? PG_BUSINESS_SCHEMA_MIGRATIONS : migrations;
  await driver.migrate(list);
}

/** 清空目标库全部业务表（反向外键顺序删除，不触碰 `schema_migrations`）。 */
export async function clearTargetTables(driver: DbDriver): Promise<void> {
  await driver.transaction(async (tx) => {
    for (const name of REVERSE_TABLE_ORDER) {
      await tx.exec(`DELETE FROM ${name}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 拷贝 / 校验
// ---------------------------------------------------------------------------

async function copyTable(source: DbDriver, tx: DbTransaction, spec: TableSpec): Promise<number> {
  const rows = await source.query<DbRow>(spec.readSql ?? `SELECT * FROM ${spec.name}`);
  for (const row of rows) {
    const cols = Object.keys(row);
    if (cols.length === 0) continue;
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${spec.name} (${cols.join(", ")}) VALUES (${placeholders})`;
    await tx.exec(sql, Object.values(row));
  }
  return rows.length;
}

/** 按外键顺序把源库业务表全量拷贝进目标库（单事务）。返回每张表的行数。 */
export async function copyAllTables(
  source: DbDriver,
  target: DbDriver,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await target.transaction(async (tx) => {
    for (const spec of BUSINESS_TABLES) {
      counts[spec.name] = await copyTable(source, tx, spec);
    }
  });
  return counts;
}

function keyOf(row: DbRow, cols: readonly string[]): string {
  return JSON.stringify(cols.map((c) => row[c]));
}

export interface TableValidation {
  readonly table: string;
  readonly sourceCount: number;
  readonly targetCount: number;
  readonly countMatch: boolean;
  readonly keysMatch: boolean;
}

export interface ValidationReport {
  readonly tables: readonly TableValidation[];
  readonly ok: boolean;
}

/** 逐表校验行数相等 + 主键集合一致（跨库一致性）。 */
export async function compareData(source: DbDriver, target: DbDriver): Promise<ValidationReport> {
  const tables: TableValidation[] = [];
  let ok = true;
  for (const spec of BUSINESS_TABLES) {
    const srcRows = await source.query<DbRow>(
      `SELECT ${spec.keyColumns.join(", ")} FROM ${spec.name}`,
    );
    const dstRows = await target.query<DbRow>(
      `SELECT ${spec.keyColumns.join(", ")} FROM ${spec.name}`,
    );
    const srcKeys = new Set(srcRows.map((r) => keyOf(r, spec.keyColumns)));
    const dstKeys = new Set(dstRows.map((r) => keyOf(r, spec.keyColumns)));
    const countMatch = srcRows.length === dstRows.length;
    const keysMatch = srcKeys.size === dstKeys.size && [...srcKeys].every((k) => dstKeys.has(k));
    if (!countMatch || !keysMatch) ok = false;
    tables.push({
      table: spec.name,
      sourceCount: srcRows.length,
      targetCount: dstRows.length,
      countMatch,
      keysMatch,
    });
  }
  return { tables, ok };
}

/** 打开源/目标驱动并校验（用于 `validate` 命令与迁移后自检）。 */
export async function validateData(
  sourceOpts: DbDriverOptions,
  targetOpts: DbDriverOptions,
): Promise<ValidationReport> {
  const source = await openDriver(sourceOpts);
  const target = await openDriver(targetOpts);
  try {
    return await compareData(source, target);
  } finally {
    await source.close();
    await target.close();
  }
}

// ---------------------------------------------------------------------------
// 顶层流程
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  /** 迁移前对 SQLite 源库做文件级快照（安全网；源库全程只读，回滚无需依赖快照）。 */
  readonly snapshotSource?: boolean;
  /** 目标库已有业务数据是否先清空再写（默认 true，保证可重复迁移）。 */
  readonly clear?: boolean;
}

export interface MigrateReport {
  readonly direction: string;
  readonly perTableCounts: Record<string, number>;
  readonly totalRows: number;
  readonly validation: ValidationReport;
  readonly snapshot?: string | undefined;
}

/**
 * 数据迁移主流程：打开源/目标 → 目标建表 → （可选清空目标）→ 拷贝 → 自检。
 * 源库全程只读。
 */
export async function migrateData(
  sourceOpts: DbDriverOptions,
  targetOpts: DbDriverOptions,
  opts: MigrateOptions = {},
): Promise<MigrateReport> {
  let snapshot: string | undefined;
  if (opts.snapshotSource === true && sourceOpts.dbDriver !== "postgres" && sourceOpts.dataDir !== undefined) {
    snapshot = await snapshotSqliteSource(sourceOpts.dataDir);
  }

  const source = await openDriver(sourceOpts);
  const target = await openDriver(targetOpts);
  try {
    await ensureTargetSchema(target);
    if (opts.clear !== false) {
      await clearTargetTables(target);
    }
    const perTableCounts = await copyAllTables(source, target);
    const validation = await compareData(source, target);
    const totalRows = Object.values(perTableCounts).reduce((a, b) => a + b, 0);
    return {
      direction: `${source.kind}->${target.kind}`,
      perTableCounts,
      totalRows,
      validation,
      snapshot,
    };
  } finally {
    await source.close();
    await target.close();
  }
}

export interface RollbackReport {
  readonly targetKind: string;
  readonly clearedTables: readonly string[];
  readonly droppedSchema?: string;
}

/**
 * 回滚：丢弃目标库的业务数据（源库未改动，切回源驱动即恢复阶段 1 行为）。
 * PG 且指定了 pgSchema 时可用 `dropSchema` 直接 DROP 整个 schema。
 */
export async function rollbackTarget(
  targetOpts: DbDriverOptions,
  opts: { readonly dropSchema?: boolean } = {},
): Promise<RollbackReport> {
  const target = await openDriver(targetOpts);
  try {
    if (opts.dropSchema === true && target.kind === "postgres" && targetOpts.pgSchema !== undefined) {
      await target.exec(`DROP SCHEMA IF EXISTS "${targetOpts.pgSchema}" CASCADE`);
      return { targetKind: target.kind, clearedTables: [], droppedSchema: targetOpts.pgSchema };
    }
    await clearTargetTables(target);
    return { targetKind: target.kind, clearedTables: BUSINESS_TABLES.map((t) => t.name) };
  } finally {
    await target.close();
  }
}

// ---------------------------------------------------------------------------
// SQLite 源库快照（可选安全网）
// ---------------------------------------------------------------------------

/**
 * 对 SQLite 源库做文件级快照（主库 + WAL/SHM）；返回主库快照路径。
 * 仅作为安全网：源库全程只读，实际回滚并不依赖此快照。
 */
export async function snapshotSqliteSource(dataDir: string): Promise<string> {
  const base = path.join(dataDir, DATABASE_FILE_NAME);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${base}.pre-migration.${stamp}.snapshot`;
  await copyFile(base, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = `${base}${suffix}`;
    try {
      await access(sibling);
      await copyFile(sibling, `${dest}${suffix}`);
    } catch {
      // 文件不存在则跳过（如非 WAL 模式）。
    }
  }
  return dest;
}

/** #152 r3 §5.4：原生管理能力与固定迁移操作共同封装，无 raw handle / 任意 SQL 回调。 */
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { ConfigError } from "../config-error.ts";
import { assertSqliteSourceUnchanged, type SqliteDatabaseDescriptor } from "../environment.ts";
import { checksumOf, migrationSql } from "../db/migrate.ts";
import { migrations } from "../db/migrations/index.ts";
import { assertStorageAdmission, readSqliteMaintenanceState, StorageMaintenanceError,
  type StorageAdmissionIdentity } from "./admission.ts";
import { assertSqliteGuardCoverage } from "./schema-guards.ts";

export const NATIVE_MANAGEMENT_BUILD = "boardroom-native-management-v1";
declare const nativeManagementLease: unique symbol;
export interface NativeManagementLease {
  readonly [nativeManagementLease]: true;
  readonly mode: "write" | "readonly-dry-run";
  readonly source: SqliteDatabaseDescriptor;
  readonly registeredEpoch: number | null;
  close(): Promise<void>;
}
interface NativeTransactions { committed: number; rolledBack: number; notAdmitted: number }
interface LeaseState {
  readonly db: Database.Database;
  readonly mode: NativeManagementLease["mode"];
  readonly source: SqliteDatabaseDescriptor;
  readonly sourceIdentity: Record<string, unknown>;
  readonly identity: StorageAdmissionIdentity;
  readonly clientId: string | null;
  readonly connectionId: string;
  readonly processInstanceId: string;
  readonly hostJson: string;
  readonly processJson: string;
  readonly registeredAt: string;
  readonly originalSessionsJson: string;
  readonly transactions: NativeTransactions;
  sourceFd: number | null;
  revoked: boolean;
  active: boolean;
  closed: boolean;
}
const leases = new WeakMap<NativeManagementLease, LeaseState>();
function leaseError(): ConfigError {
  return new ConfigError("原生管理操作需要未关闭且无外部事务的受信本地 lease。", "storage_maintenance");
}
function requireLease(lease: NativeManagementLease): LeaseState {
  const state = leases.get(lease);
  if (!state || state.revoked || state.closed || !state.db.open) throw leaseError();
  return state;
}

// 与 source-client 回执相同的 canonical JSON v1。此模块不依赖应用入口生命周期。
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new StorageMaintenanceError("metadata_invalid");
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

function currentProcessIdentity(instanceId: string): Record<string, unknown> {
  const local = { version: 1, platform: process.platform, pid: process.pid, instanceId };
  if (process.platform === "linux") {
    try {
      const kernelBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const pidNamespace = readlinkSync("/proc/self/ns/pid");
      const stat = readFileSync("/proc/self/stat", "utf8");
      const end = stat.lastIndexOf(") ");
      const startTicks = stat.slice(end + 2).trim().split(/\s+/)[19];
      if (end < 0 || !startTicks || !/^\d+$/.test(startTicks) || !/^pid:\[\d+\]$/.test(pidNamespace)
        || !/^[a-f0-9-]{36}$/.test(kernelBootId)) throw new Error();
      return { ...local, verification: "linux_proc_identity_v1", kernelBootId, pidNamespace, startTicks };
    } catch { /* 本地操作仍可运行；此降级身份不能向维护 inventory 声称可独立核验进程。 */ }
  }
  return { ...local, verification: "process_local_only" };
}

function assertSource(source: SqliteDatabaseDescriptor, fd: number | null = null): void {
  if (!source.identity) throw new ConfigError("原生管理仅接受已存在的 SQLite 数据源。", "legacy_migration_required");
  assertSqliteSourceUnchanged(source);
  if (fd !== null) {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== source.identity.device || String(stat.ino) !== source.identity.inode)
      throw new ConfigError("原生管理源句柄与已选择的 SQLite 源不一致。", "storage_source_changed");
  }
}

/** 只查询现有 schema；不得调用会 CREATE/migrate 的 readMigrationState/runMigrations。 */
function assertKnownSchema(db: Database.Database): void {
  try {
    const rows = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as
      { version: number; name: string; checksum: string }[];
    const expected = [...migrations].sort((a, b) => a.version - b.version);
    if (rows.length !== expected.length || rows.some((row, index) => row.version !== expected[index]!.version
      || row.name !== expected[index]!.name || row.checksum !== checksumOf(migrationSql(expected[index]!, "sqlite"))))
      throw new Error();
    db.prepare(`SELECT client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,
      process_identity_json,db_sessions_json,registered_epoch,observed_epoch,drain_epoch,drain_state,
      drain_receipt_digest,registered_at,last_observed_at,ended_at FROM storage_source_clients LIMIT 0`).all();
  } catch { throw new StorageMaintenanceError("metadata_invalid"); }
  assertSqliteGuardCoverage(db);
}

function assertOwnClient(db: Database.Database, state: LeaseState): void {
  const row = db.prepare("SELECT * FROM storage_source_clients WHERE client_id=?").get(state.clientId) as Record<string, unknown> | undefined;
  if (!row || row.database_instance_id !== state.identity.databaseInstanceId || row.entrypoint !== "local-management"
    || row.build_id !== NATIVE_MANAGEMENT_BUILD || row.protocol_version !== 1 || row.registered_epoch !== state.identity.fenceEpoch
    || row.host_identity_json !== state.hostJson || row.process_identity_json !== state.processJson
    || row.db_sessions_json !== state.originalSessionsJson || row.registered_at !== state.registeredAt || row.ended_at !== null
    || canonical(currentProcessIdentity(state.processInstanceId)) !== state.processJson)
    throw new StorageMaintenanceError("metadata_invalid");
}

function sessionEnvelope(state: Pick<LeaseState, "sourceIdentity" | "connectionId" | "transactions">,
  closed: boolean, drainReceipt: Record<string, unknown> | null = null): Record<string, unknown> {
  return { formatVersion: 1, sourceIdentity: state.sourceIdentity,
    sessions: [{ kind: "sqlite", owner: "native-management", connectionId: state.connectionId,
      state: closed ? "closed" : "open", nativeTransactions: { ...state.transactions } }], drainReceipt };
}

export async function openNativeManagementSource(input: Readonly<{
  source: SqliteDatabaseDescriptor;
  mode: NativeManagementLease["mode"];
  expectedOpenEpoch?: number;
}>): Promise<NativeManagementLease> {
  if (input.mode !== "write" && input.mode !== "readonly-dry-run") throw leaseError();
  if (input.expectedOpenEpoch !== undefined && (!Number.isSafeInteger(input.expectedOpenEpoch) || input.expectedOpenEpoch < 0))
    throw new StorageMaintenanceError("metadata_invalid");
  if (input.source.kind !== "sqlite" || !path.isAbsolute(input.source.sqlitePath) || !path.isAbsolute(input.source.sourcePath))
    throw new StorageMaintenanceError("metadata_invalid");
  const source: SqliteDatabaseDescriptor = Object.freeze({ ...input.source,
    identity: input.source.identity ? Object.freeze({ ...input.source.identity }) : null });
  assertSource(source);
  let sourceFd: number | null = null;
  let db: Database.Database | null = null;
  try {
    sourceFd = openSync(source.sqlitePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    assertSource(source, sourceFd);
    db = new Database(source.sqlitePath, { readonly: input.mode === "readonly-dry-run", fileMustExist: true });
    assertSource(source, sourceFd);
    if (input.mode === "readonly-dry-run") db.pragma("query_only = ON");
    else db.pragma("foreign_keys = ON");
    const nativeDb = db;
    const processInstanceId = randomUUID();
    const processJson = canonical(currentProcessIdentity(processInstanceId));
    const hostJson = canonical({ version: 1, hostname: hostname(), platform: process.platform });
    const sourceIdentity = { kind: "sqlite", sourcePath: source.sourcePath, sqlitePath: source.sqlitePath, ...source.identity };
    const connectionId = randomUUID();
    const clientId = input.mode === "write" ? randomUUID() : null;
    const registeredAt = new Date().toISOString();
    const transactions = { committed: 0, rolledBack: 0, notAdmitted: 0 };
    const originalSessionsJson = canonical(sessionEnvelope({ sourceIdentity, connectionId, transactions }, false));
    const register = nativeDb.transaction((): StorageAdmissionIdentity => {
      assertSource(source, sourceFd);
      const marker = readSqliteMaintenanceState(nativeDb, true)!;
      if (input.mode === "write") assertStorageAdmission(marker, input.expectedOpenEpoch === undefined ? undefined
        : { databaseInstanceId: marker.databaseInstanceId, fenceEpoch: input.expectedOpenEpoch });
      assertKnownSchema(nativeDb);
      if (clientId) nativeDb.prepare(`INSERT INTO storage_source_clients
        (client_id,database_instance_id,entrypoint,build_id,protocol_version,host_identity_json,process_identity_json,
          db_sessions_json,registered_epoch,observed_epoch,registered_at,last_observed_at)
        VALUES(?,?,'local-management',?,1,?,?,?,?,?,?,?)`).run(clientId, marker.databaseInstanceId, NATIVE_MANAGEMENT_BUILD,
        hostJson, processJson, originalSessionsJson, marker.fenceEpoch, marker.fenceEpoch, registeredAt, registeredAt);
      assertSource(source, sourceFd);
      return { databaseInstanceId: marker.databaseInstanceId, fenceEpoch: marker.fenceEpoch };
    });
    const identity = input.mode === "write" ? register.immediate() : register.deferred();
    assertSource(source, sourceFd);
    const state: LeaseState = { db, mode: input.mode, source, sourceIdentity, identity, clientId, connectionId,
      processInstanceId, hostJson, processJson, registeredAt, originalSessionsJson, transactions, sourceFd,
      revoked: false, active: false, closed: false };
    const lease = Object.freeze({ mode: input.mode, source, registeredEpoch: clientId ? identity.fenceEpoch : null,
      async close() { closeLease(state); } }) as NativeManagementLease;
    leases.set(lease, state);
    return lease;
  } catch (error) {
    if (db?.open) db.close();
    if (sourceFd !== null) closeSync(sourceFd);
    throw error;
  }
}

function closeLease(state: LeaseState): void {
  if (state.closed) return;
  state.revoked = true;
  if (state.active || state.db.inTransaction) throw leaseError();
  // 先真实关闭工作连接和源 FD。控制回执不授予任何域写能力，也不能拿 ended_at 当 OS 退出证明。
  if (state.db.open) state.db.close();
  if (state.sourceFd !== null) { closeSync(state.sourceFd); state.sourceFd = null; }
  if (state.mode === "readonly-dry-run") { state.closed = true; return; }
  assertSource(state.source);
  const control = new Database(state.source.sqlitePath, { fileMustExist: true });
  try {
    assertSource(state.source);
    control.pragma("synchronous = FULL");
    control.transaction(() => {
      assertSource(state.source);
      const marker = readSqliteMaintenanceState(control, true)!;
      if (marker.databaseInstanceId !== state.identity.databaseInstanceId) throw new StorageMaintenanceError("metadata_invalid");
      // sealed 之后的登记/回执不得刷新；失败保持旧 client blocker，由协调者核实。
      if (marker.admission === "sealed") throw new StorageMaintenanceError("active");
      assertOwnClient(control, state);
      const now = new Date().toISOString();
      let receipt: Record<string, unknown> | null = null;
      if (marker.admission === "draining") {
        if (marker.fenceEpoch !== state.identity.fenceEpoch + 1) throw new StorageMaintenanceError("epoch_changed");
        receipt = { formatVersion: 1, kind: "source-client-drain", clientId: state.clientId,
          entrypoint: "local-management", buildId: NATIVE_MANAGEMENT_BUILD, databaseInstanceId: marker.databaseInstanceId,
          sourceIdentityDigest: digest(state.sourceIdentity), processIdentityDigest: digest(JSON.parse(state.processJson)),
          registeredEpoch: state.identity.fenceEpoch, drainEpoch: marker.fenceEpoch, ownerGeneration: marker.ownerGeneration,
          migrationId: marker.activeMigrationId, planDigest: marker.planDigest,
          quiescence: { activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true },
          ownedExits: [], nativeTransactions: { ...state.transactions }, completedAt: now };
      }
      const sessionsJson = canonical(sessionEnvelope(state, true, receipt));
      const result = control.prepare(`UPDATE storage_source_clients SET db_sessions_json=?,observed_epoch=?,
        drain_epoch=?,drain_state=?,drain_receipt_digest=?,last_observed_at=?,ended_at=?
        WHERE client_id=? AND database_instance_id=? AND registered_epoch=? AND ended_at IS NULL`).run(
        sessionsJson, marker.fenceEpoch, receipt ? marker.fenceEpoch : null, receipt ? "drained" : "none",
        receipt ? digest(receipt) : null, now, now, state.clientId, state.identity.databaseInstanceId, state.identity.fenceEpoch);
      if (result.changes !== 1) throw new StorageMaintenanceError("metadata_invalid");
      assertSource(state.source);
    }).immediate();
  } finally { if (control.open) control.close(); }
  state.closed = true;
}

/** 公开入口只接受本模块创建的 lease；不存在 raw Database overload 或 SQL callback。 */
export function migrateOtherToDsh(lease: NativeManagementLease): MigrationReport {
  const state = requireLease(lease);
  if (state.active || state.db.inTransaction) throw leaseError();
  const readonly = state.mode === "readonly-dry-run";
  let admitted = false;
  let committed = false;
  state.active = true;
  try {
    assertSource(state.source, state.sourceFd);
    const transaction = state.db.transaction(() => {
      assertSource(state.source, state.sourceFd);
      const marker = readSqliteMaintenanceState(state.db, true)!;
      if (readonly) {
        if (!state.db.readonly || state.db.pragma("query_only", { simple: true }) !== 1
          || marker.databaseInstanceId !== state.identity.databaseInstanceId) throw new StorageMaintenanceError("metadata_invalid");
      } else {
        assertStorageAdmission(marker, state.identity);
        assertOwnClient(state.db, state);
      }
      assertKnownSchema(state.db);
      admitted = true;
      const report = migrateAdmittedOtherToDsh(state.db, readonly);
      if (state.revoked || !state.db.open || !state.db.inTransaction) throw leaseError();
      assertSource(state.source, state.sourceFd);
      const current = readSqliteMaintenanceState(state.db, true)!;
      if (readonly) {
        if (current.databaseInstanceId !== state.identity.databaseInstanceId) throw new StorageMaintenanceError("metadata_invalid");
      } else { assertStorageAdmission(current, state.identity); assertOwnClient(state.db, state); }
      return report;
    });
    const report = readonly ? transaction.deferred() : transaction.immediate();
    committed = true;
    if (!readonly) state.transactions.committed++;
    assertSource(state.source, state.sourceFd);
    return report;
  } catch (error) {
    if (!readonly && !committed) state.transactions[admitted ? "rolledBack" : "notAdmitted"]++;
    throw error;
  } finally { state.active = false; }
}

/** 迁移报告。 */
export interface MigrationReport {
  /** agents 中被改写（other→dsh）的行数。 */
  readonly changedAgents: number;
  /** mcp_sessions 中被改写（other→dsh）的行数。 */
  readonly changedSessions: number;
  /** agents 中本就已是 `'dsh'`、被跳过的行数。 */
  readonly skippedAgents: number;
  /** mcp_sessions 中本就已是 `'dsh'`、被跳过的行数。 */
  readonly skippedSessions: number;
  /** 会违反 `ux_agents_identity` 唯一索引的 `display_name` 名单（迁移中止时非空）。 */
  readonly collisions: readonly string[];
  /** 是否处于 dry-run（只做 pre-flight + 报告、不执行改写）。 */
  readonly dryRun: boolean;
}

interface Preflight {
  readonly otherAgents: number;
  readonly dshAgents: number;
  readonly otherSessions: number;
  readonly dshSessions: number;
  readonly collisions: string[];
}

/** 迁移因会破坏 `ux_agents_identity` 唯一索引而中止；`report` 含冲突 `display_name` 名单。 */
export class HostTypeMigrationCollisionError extends Error {
  override readonly name = "HostTypeMigrationCollisionError";
  readonly report: MigrationReport;

  constructor(report: MigrationReport) {
    super(
      `检测到 ${report.collisions.length} 个 display_name 同时拥有 'other' 与 'dsh' 行，` +
        `迁移会违反 ux_agents_identity 唯一索引，已中止。冲突：${report.collisions.join(", ")}`,
    );
    this.report = report;
  }
}

function countRows(db: Database.Database, table: string, hostType: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE host_type = ?`)
    .get(hostType) as { c: number };
  return row.c;
}

function hasAliases(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version = 14").get());
}

/**
 * Pre-flight：统计将受影响 / 将跳过 / 会冲突的行。
 *
 * 冲突判定：同一 `display_name` 同时有 `'other'` 与 `'dsh'` 两行 —— 把 `'other'` 改写为 `'dsh'`
 * 会产生重复 `(display_name, host_type)`，触发 `ux_agents_identity` 唯一索引冲突。
 */
function preflight(db: Database.Database): Preflight {
  const otherAgents = countRows(db, "agents", "other");
  const dshAgents = countRows(db, "agents", "dsh");
  const otherSessions = countRows(db, "mcp_sessions", "other");
  const dshSessions = countRows(db, "mcp_sessions", "dsh");

  const collisions = new Set((
    db
      .prepare(
        `SELECT display_name FROM agents
         WHERE host_type IN ('other', 'dsh')
         GROUP BY display_name
         HAVING COUNT(DISTINCT host_type) > 1`,
      )
      .all() as { display_name: string }[]
  ).map((r) => r.display_name));
  if (hasAliases(db)) {
    const reserved = db.prepare(`SELECT a.display_name FROM agents a JOIN agent_legacy_aliases l
      ON l.display_name = a.display_name AND l.host_type IN ('other', 'dsh')
      WHERE a.host_type = 'other' AND (l.agent_id <> a.id OR l.retired_at IS NOT NULL)`).all() as { display_name: string }[];
    for (const row of reserved) collisions.add(row.display_name);
  }

  return { otherAgents, dshAgents, otherSessions, dshSessions, collisions: [...collisions].sort() };
}

/**
 * 把历史 `host_type='other'` 行改写为 `'dsh'`（agents 与 mcp_sessions）。
 *
 * - 幂等：重跑改变 0 行；`repos.agents.create({ hostType: 'other' })` 在迁移后仍合法。
 * - 事务：整段在 `db.transaction` 内；若 pre-flight 检测到唯一索引冲突则抛错并整体回滚。
 * - dry-run：只跑 pre-flight + 返回报告，不执行任何改写（事务内只读，天然不改动）。
 *
 * @throws {HostTypeMigrationCollisionError} 当存在会破坏 `ux_agents_identity` 的冲突时。
 */
function migrateAdmittedOtherToDsh(db: Database.Database, isDry: boolean): MigrationReport {
  const pre = preflight(db);

  if (pre.collisions.length > 0) {
    throw new HostTypeMigrationCollisionError({
      changedAgents: 0,
      changedSessions: 0,
      skippedAgents: pre.dshAgents,
      skippedSessions: pre.dshSessions,
      collisions: pre.collisions,
      dryRun: isDry,
    });
  }

  if (isDry) {
    return {
      changedAgents: pre.otherAgents,
      changedSessions: pre.otherSessions,
      skippedAgents: pre.dshAgents,
      skippedSessions: pre.dshSessions,
      collisions: [],
      dryRun: true,
    };
  }

  const now = new Date().toISOString();
  if (hasAliases(db)) {
    // 全部目标冲突已在同一事务预检。保留原 alias，仅追加相同稳定 ID 的新宿主 alias。
    const rows = db.prepare("SELECT id, display_name, created_at FROM agents WHERE host_type = 'other'").all() as
      { id: string; display_name: string; created_at: string }[];
    const insert = db.prepare(`INSERT INTO agent_legacy_aliases (display_name, host_type, agent_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (display_name, host_type) DO NOTHING`);
    for (const row of rows) {
      insert.run(row.display_name, "other", row.id, row.created_at);
      insert.run(row.display_name, "dsh", row.id, now);
    }
  }
  const agentRes = db
    .prepare(`UPDATE agents SET host_type = 'dsh', updated_at = ? WHERE host_type = 'other'`)
    .run(now);
  const sessionRes = db
    .prepare(`UPDATE mcp_sessions SET host_type = 'dsh', updated_at = ? WHERE host_type = 'other'`)
    .run(now);

  return {
    changedAgents: agentRes.changes,
    changedSessions: sessionRes.changes,
    skippedAgents: pre.dshAgents,
    skippedSessions: pre.dshSessions,
    collisions: [],
    dryRun: false,
  };
}

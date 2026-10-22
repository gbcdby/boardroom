import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/** 一条迁移。版本号必须唯一且单调递增。 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  /** 单条或多条 SQL 语句；在事务内执行。 */
  readonly up: string;
}

/** 迁移版本表名。 */
export const MIGRATION_TABLE = "schema_migrations";

export interface MigrationState {
  /** 已应用的最高版本；没有任何迁移时为 0。 */
  readonly version: number;
  /** 已应用的迁移记录，按版本升序。 */
  readonly applied: readonly AppliedMigration[];
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationRunResult {
  /** 本次实际执行的迁移。 */
  readonly applied: readonly Migration[];
  /** 执行后的最高版本。 */
  readonly version: number;
}

/** 迁移定义不合法或已应用迁移被改写。 */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

/**
 * 按版本升序执行尚未应用的迁移。
 *
 * - 幂等：已记录在 {@link MIGRATION_TABLE} 的版本不会重复执行。
 * - 每条迁移在独立事务内执行；失败时该条整体回滚，版本不前进。
 * - 已应用迁移的 SQL 被改写时报错，避免本地库与代码定义漂移。
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[]): MigrationRunResult {
  const ordered = validateAndSort(migrations);
  ensureMigrationTable(db);

  const applied = new Map<number, AppliedMigration>();
  for (const row of readAppliedRows(db)) {
    applied.set(row.version, row);
  }

  // 先校验所有已应用迁移的 checksum，避免执行到一半才发现漂移。
  for (const migration of ordered) {
    const existing = applied.get(migration.version);
    if (existing === undefined) continue;
    if (existing.checksum !== checksumOf(migration)) {
      throw new MigrationError(
        `迁移 ${migration.version} "${migration.name}" 已应用（${existing.appliedAt}），` +
          `但 SQL 内容与当前代码不一致（checksum ${existing.checksum} → ${checksumOf(migration)}）。` +
          `已应用的迁移不可修改；请新增一条迁移，或删除本地数据目录后重新初始化。`,
      );
    }
  }

  const newlyApplied: Migration[] = [];
  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    applyOne(db, migration);
    newlyApplied.push(migration);
  }

  return { applied: newlyApplied, version: readMigrationState(db).version };
}

/** 读取当前迁移版本与已应用记录。 */
export function readMigrationState(db: Database.Database): MigrationState {
  ensureMigrationTable(db);
  const applied = readAppliedRows(db);
  const highest = applied.reduce((max, row) => Math.max(max, row.version), 0);
  return { version: highest, applied };
}

function applyOne(db: Database.Database, migration: Migration): void {
  const insert = db.prepare(
    `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.up);
    insert.run(migration.version, migration.name, checksumOf(migration), new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能已因错误结束。
    }
    throw new MigrationError(
      `迁移 ${migration.version} "${migration.name}" 执行失败：${(error as Error).message}。` +
        `该迁移已整体回滚，数据库版本仍为上一个成功版本。`,
    );
  }
}

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    );
  `);
}

function readAppliedRows(db: Database.Database): AppliedMigration[] {
  const rows = db
    .prepare(`SELECT version, name, checksum, applied_at FROM ${MIGRATION_TABLE} ORDER BY version`)
    .all() as { version: number; name: string; checksum: string; applied_at: string }[];
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

function validateAndSort(migrations: readonly Migration[]): readonly Migration[] {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new MigrationError(`迁移版本必须是正整数，收到：${String(migration.version)}。`);
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(`迁移版本 ${migration.version} 重复定义。`);
    }
    if (migration.name.trim() === "") {
      throw new MigrationError(`迁移 ${migration.version} 缺少名称。`);
    }
    seen.add(migration.version);
  }
  return [...migrations].sort((a, b) => a.version - b.version);
}

function checksumOf(migration: Migration): string {
  return createHash("sha256").update(migration.up).digest("hex").slice(0, 16);
}

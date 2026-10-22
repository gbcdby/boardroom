import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** 数据库文件名；位于配置的 dataDir 下。 */
export const DATABASE_FILE_NAME = "agent-studio.db";

/** 数据目录 / 数据库初始化失败；message 面向用户，包含恢复路径。 */
export class DatabaseSetupError extends Error {
  override readonly name = "DatabaseSetupError";
}

export interface OpenDatabaseResult {
  readonly db: Database.Database;
  /** 数据库文件的绝对路径。 */
  readonly file: string;
}

/**
 * 确保数据目录存在并打开 SQLite 连接。
 *
 * 连接参数：WAL（允许 WebUI 读与写入并发）、NORMAL 同步、外键开启。
 * 任何失败都转换为带恢复路径的 {@link DatabaseSetupError}。
 */
export function openDatabase(dataDir: string, fileName = DATABASE_FILE_NAME): OpenDatabaseResult {
  const resolvedDir = path.resolve(dataDir);
  const file = path.join(resolvedDir, fileName);

  try {
    mkdirSync(resolvedDir, { recursive: true });
  } catch (error) {
    throw new DatabaseSetupError(
      `无法创建数据目录 ${resolvedDir}：${describeCode(error)}。` +
        `请确认该路径的父目录存在且当前用户有写权限，或通过 AGENT_STUDIO_DATA_DIR 指向可写目录。`,
    );
  }

  let db: Database.Database;
  try {
    db = new Database(file);
  } catch (error) {
    throw new DatabaseSetupError(
      `无法打开数据库 ${file}：${describeCode(error)}。` +
        `请确认数据目录 ${resolvedDir} 可写、磁盘未满；也可通过 AGENT_STUDIO_DATA_DIR 更换数据目录。`,
    );
  }

  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    probeReadWrite(db);
  } catch (error) {
    db.close();
    throw new DatabaseSetupError(
      `数据库 ${file} 初始化失败：${describeCode(error)}。` +
        `请确认数据目录 ${resolvedDir} 可读写（WAL 模式需要在该目录创建 -wal/-shm 文件），` +
        `或通过 AGENT_STUDIO_DATA_DIR 指向可写目录。`,
    );
  }

  return { db, file };
}

/**
 * 探测数据库可读写：在事务内建一张临时表再回滚。
 *
 * 只读挂载、只读文件权限、磁盘满都会在这里失败，而不是等到第一次业务写入。
 */
export function probeReadWrite(db: Database.Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _rw_probe (id INTEGER)");
    db.exec("DROP TABLE IF EXISTS _rw_probe");
    db.exec("ROLLBACK");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能已因错误结束，忽略。
    }
    throw error;
  }
}

function describeCode(error: unknown): string {
  const err = error as NodeJS.ErrnoException;
  const code = err?.code ?? "unknown";
  const message = err?.message ? `，${err.message}` : "";
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `${code} 权限不足${message}`;
    case "ENOSPC":
      return `${code} 磁盘空间不足${message}`;
    case "ENOTDIR":
      return `${code} 路径中存在同名文件${message}`;
    case "SQLITE_READONLY":
      return `${code} 数据库只读${message}`;
    default:
      return `${code}${message}`;
  }
}

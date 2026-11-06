import type { DbDriver } from "./db/driver.ts";
import type { HeartbeatConfig } from "./config.ts";
import type { MigrationState } from "./db/migrate.ts";

export type HealthStatus = "ok" | "degraded";

export interface DatabaseHealth {
  readonly status: "ok" | "error";
  readonly writable: boolean;
  readonly error?: string;
}

export interface MigrationHealth {
  /** 已应用的最高版本。 */
  readonly version: number;
  /** 已应用的迁移条数。 */
  readonly applied: number;
  /** 代码中定义但尚未应用的迁移条数。 */
  readonly pending: number;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly uptimeSeconds: number;
  readonly serverTime: string;
  readonly database: DatabaseHealth;
  readonly migrations: MigrationHealth;
  readonly heartbeat: HeartbeatConfig;
  readonly webui: { readonly built: boolean };
}

export interface HealthCheckOptions {
  readonly db: DbDriver;
  readonly heartbeat: HeartbeatConfig;
  readonly startedAt: number;
  /** 代码中定义的迁移总数。 */
  readonly migrationCount: number;
  /** WebUI 构建产物是否就位。 */
  readonly webuiBuilt: boolean;
  readonly now?: () => Date;
}

/**
 * 组装健康检查结果。
 *
 * 至少反映：进程存活（能响应即存活）、数据库可读写、迁移版本。
 * 数据库异常时整体为 degraded，HTTP 层对应返回 503。
 */
export async function buildHealthReport(options: HealthCheckOptions): Promise<HealthReport> {
  const now = options.now ?? (() => new Date());

  let database: DatabaseHealth;
  let migrations: MigrationHealth;
  try {
    // #61：健康探针经 DbDriver 抽象，兼容 SQLite 与 PostgreSQL。
    // SELECT 1 验证可读；空事务（BEGIN/COMMIT）验证可写能力；migrationState 验证迁移元数据。
    await options.db.query("SELECT 1");
    await options.db.transaction(async () => {});
    const state: MigrationState = await options.db.migrationState();
    database = { status: "ok", writable: true };
    migrations = {
      version: state.version,
      applied: state.applied.length,
      pending: Math.max(0, options.migrationCount - state.applied.length),
    };
  } catch (error) {
    database = { status: "error", writable: false, error: (error as Error).message };
    migrations = { version: -1, applied: 0, pending: options.migrationCount };
  }

  return {
    status: database.status === "ok" ? "ok" : "degraded",
    uptimeSeconds: Math.round((Date.now() - options.startedAt) / 100) / 10,
    serverTime: now().toISOString(),
    database,
    migrations,
    heartbeat: options.heartbeat,
    webui: { built: options.webuiBuilt },
  };
}

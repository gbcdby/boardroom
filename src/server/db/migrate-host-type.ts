/**
 * #59（T3 / HOST-04）一次性数据迁移：历史 `host_type='other'` → `'dsh'`。
 *
 * 背景：F1（#56）/ T1（#57）/ T2（#58）已把 `dsh` 收敛为一等宿主 —— join 现在接受任意
 * `isRegistered(hostType)`，`hostType='dsh'` 已经能成功入群（DSH 身份接纳由 #57/#58 完成）。
 * 本文件只负责**补历史数据**：把早期以 `'other'` 落库的 DSH 会话/全局身份重新标为 `'dsh'`，
 * 使它们在数据中与一等 `dsh` 宿主对齐。
 *
 * 设计约束（HOST-04 / D4）：
 *  - 幂等：已为 `'dsh'` 的行被 `UPDATE ... WHERE host_type='other'` 自然跳过；重跑改变 0 行。
 *  - 备份/可回滚：整段更新包在 `db.transaction(...)` 内；失败整体回滚。
 *  - 不破坏 `ux_agents_identity` 唯一索引（agents(display_name, host_type)）：执行前做 pre-flight，
 *    若某 `display_name` 同时拥有 `'other'` 与 `'dsh'` 行（迁移会产生重复键），则**中止**并报告冲突名单。
 *  - 保留 `'other'` 作为未来未知宿主的合法值：本迁移只改写历史 `'other'`，不在任何地方禁止 `'other'`。
 *  - 这是**按需**运行的函数，不进入 `migrations` 数组（否则每次开新库都会跑、且改动迁移 checksum）。
 *
 * 注意：本文件只依赖当前主线的 better-sqlite3 直接 API（`db.transaction` / `db.prepare` / `db.exec`），
 * 不触碰 #61 的 DbDriver 抽象（该 WIP 已 stash，与此迁移无关）。
 */
import type Database from "better-sqlite3";

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

export interface MigrateOptions {
  /** 只做 pre-flight 与报告、不执行任何改写。默认 false。 */
  readonly dryRun?: boolean;
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

  const collisions = (
    db
      .prepare(
        `SELECT display_name FROM agents
         WHERE host_type IN ('other', 'dsh')
         GROUP BY display_name
         HAVING COUNT(DISTINCT host_type) > 1`,
      )
      .all() as { display_name: string }[]
  ).map((r) => r.display_name);

  return { otherAgents, dshAgents, otherSessions, dshSessions, collisions };
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
export function migrateOtherToDsh(db: Database.Database, opts: MigrateOptions = {}): MigrationReport {
  const dryRun = opts.dryRun ?? false;

  const txn = db.transaction((isDry: boolean): MigrationReport => {
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
  });

  return txn(dryRun);
}

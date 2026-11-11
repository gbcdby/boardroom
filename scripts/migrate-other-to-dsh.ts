/**
 * #59（T3 / HOST-04）一次性数据迁移 CLI：历史 `host_type='other'` → `'dsh'`。
 *
 * 这是对 `src/server/db/migrate-host-type.ts` 的按需运行入口，默认**不**接入应用启动流程
 * （一次性迁移 = 按需执行）。运行前会自动做 pre-flight 冲突检测，存在 `ux_agents_identity`
 * 冲突时会中止并列出冲突 `display_name`，绝不静默破坏唯一索引。
 *
 * 用法：
 *   node scripts/migrate-other-to-dsh.ts [--data-dir <dir>] [--dry-run]
 *
 * 数据目录优先级：--data-dir > 环境变量 > 统一 resolver 所选配置；只操作既有 SQLite。
 * 建议先 `--dry-run` 预览受影响行数，确认无误后再实跑。
 */
import Database from "better-sqlite3";
import { ConfigError } from "../src/server/config-error.ts";
import { resolveBoardroomEnvironment, assertEnvironmentSelected, assertEnvironmentWritable, assertSqliteSourceUnchanged } from "../src/server/environment.ts";
import { migrateOtherToDsh, HostTypeMigrationCollisionError } from "../src/server/db/migrate-host-type.ts";

async function main(): Promise<void> {
  const env = { ...process.env };
  let dryRun = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--data-dir" && args[i + 1] && !args[i + 1]!.startsWith("--")) env["AGENT_STUDIO_DATA_DIR"] = args[++i]!;
    else throw new ConfigError("用法：migrate-other-to-dsh.ts [--data-dir <dir>] [--dry-run]。");
  }
  const environment = await resolveBoardroomEnvironment({ env });
  assertEnvironmentSelected(environment);
  const database = environment.databaseDescriptor;
  if (database.kind !== "sqlite") throw new ConfigError("此历史 host-type 管理命令仅支持既有 SQLite；PostgreSQL 配置不会回落本地库。");
  if (!database.identity) throw new ConfigError("未找到既有 SQLite 数据库；此管理命令不会建库或执行 schema 迁移。", "legacy_migration_required");
  if (!dryRun) await assertEnvironmentWritable(environment);
  assertSqliteSourceUnchanged(database);
  const db = new Database(database.sqlitePath, { readonly: dryRun, fileMustExist: true });
  try {
    assertSqliteSourceUnchanged(database);
    if (dryRun) db.pragma("query_only = ON");
    else db.pragma("foreign_keys = ON");
    console.log(`数据库：${database.sqlitePath}`);
    console.log(`模式：${dryRun ? "DRY-RUN（不执行改写）" : "执行"}`);
    const report = migrateOtherToDsh(db, { dryRun });
    console.log("迁移报告：");
    console.log(`  agents 改写（other→dsh）：${report.changedAgents}`);
    console.log(`  mcp_sessions 改写      ：${report.changedSessions}`);
    console.log(`  agents 跳过（已 dsh）  ：${report.skippedAgents}`);
    console.log(`  mcp_sessions 跳过     ：${report.skippedSessions}`);
    console.log(`  ux_agents_identity 冲突：${report.collisions.length}`);
    if (report.collisions.length > 0) {
      console.log(`  冲突 display_name：${report.collisions.join(", ")}`);
    }
    console.log(report.dryRun ? "DRY-RUN 完成（未改动任何数据）。" : "迁移完成。");
  } finally {
    if (db.open) db.close();
  }
}

await main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(`[${error.code}] ${error.message}\n恢复方式：${error.recoveryAction}`);
  else if (error instanceof HostTypeMigrationCollisionError) {
    console.error("迁移中止：检测到会破坏 ux_agents_identity 唯一索引的冲突。");
    console.error(`冲突 display_name：${error.report.collisions.join(", ")}`);
  } else console.error("迁移失败：请检查所选数据库格式、权限与一致备份。未自动更换数据源。");
  process.exitCode = 1;
});

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
 * 数据目录优先级：--data-dir > 环境变量 AGENT_STUDIO_DATA_DIR > ./data。
 * 建议先 `--dry-run` 预览受影响行数，确认无误后再实跑。
 */
import path from "node:path";

import { openDatabase } from "../src/server/db/database.ts";
import { migrateOtherToDsh, HostTypeMigrationCollisionError } from "../src/server/db/migrate-host-type.ts";

function resolveDataDir(): string {
  const flagIdx = process.argv.indexOf("--data-dir");
  if (flagIdx >= 0 && process.argv[flagIdx + 1] !== undefined) {
    return process.argv[flagIdx + 1];
  }
  return process.env["AGENT_STUDIO_DATA_DIR"] ?? path.resolve("data");
}

function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

function main(): void {
  const dataDir = resolveDataDir();
  const dryRun = isDryRun();
  const { db, file } = openDatabase(dataDir);

  try {
    console.log(`数据库：${file}`);
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
  } catch (error) {
    if (error instanceof HostTypeMigrationCollisionError) {
      console.error("迁移中止：检测到会破坏 ux_agents_identity 唯一索引的冲突。");
      console.error(`冲突 display_name：${error.report.collisions.join(", ")}`);
    } else {
      console.error("迁移失败：", error instanceof Error ? error.message : error);
    }
    process.exit(1);
  } finally {
    if (db.open) db.close();
  }
}

main();

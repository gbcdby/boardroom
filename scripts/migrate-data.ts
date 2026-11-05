/**
 * M1（#54）数据迁移 CLI：在 SQLite / PostgreSQL 之间迁移与回滚业务数据。
 *
 * 用法：
 *   node scripts/migrate-data.ts --command migrate \
 *     --src-driver sqlite --src-data-dir ./data \
 *     --dst-driver postgres --dst-pg-url postgres://u:p@127.0.0.1:15432/db --dst-pg-schema boardroom_m1 \
 *     [--snapshot] [--no-clear]
 *
 *   node scripts/migrate-data.ts --command validate \
 *     --src-driver sqlite --src-data-dir ./data \
 *     --dst-driver postgres --dst-pg-url postgres://u:p@127.0.0.1:15432/db --dst-pg-schema boardroom_m1
 *
 *   node scripts/migrate-data.ts --command rollback \
 *     --dst-driver postgres --dst-pg-url postgres://u:p@127.0.0.1:15432/db --dst-pg-schema boardroom_m1 [--drop-schema]
 *
 * 连接串也可经环境变量提供：AGENT_STUDIO_PG_TEST_URL / AGENT_STUDIO_PG_CONNECTION_STRING。
 * SQLite 数据目录可经 --src-data-dir / --dst-data-dir 或 AGENT_STUDIO_DATA_DIR 提供。
 *
 * 回滚语义：源库全程只读；回滚即丢弃目标库业务数据（或 DROP 目标 schema），
 * 切回源驱动（dbDriver=sqlite）即恢复阶段 1 行为。
 */
import path from "node:path";

import {
  compareData,
  migrateData,
  openDriver,
  rollbackTarget,
  type RollbackReport,
  type ValidationReport,
} from "../src/server/db/migrate-data.ts";
import type { DbDriverOptions } from "../src/server/db/driver.ts";

interface CliArgs {
  command: "migrate" | "validate" | "rollback";
  srcDriver: "sqlite" | "postgres";
  srcDataDir?: string;
  srcPgUrl?: string;
  srcPgSchema?: string;
  dstDriver: "sqlite" | "postgres";
  dstDataDir?: string;
  dstPgUrl?: string;
  dstPgSchema?: string;
  snapshot: boolean;
  noClear: boolean;
  dropSchema: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    command: "migrate",
    srcDriver: "sqlite",
    dstDriver: "sqlite",
    snapshot: false,
    noClear: false,
    dropSchema: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      i++;
      return v;
    };
    switch (arg) {
      case "--command":
        a.command = next() as CliArgs["command"];
        break;
      case "--src-driver":
        a.srcDriver = next() as CliArgs["srcDriver"];
        break;
      case "--src-data-dir":
        a.srcDataDir = next();
        break;
      case "--src-pg-url":
        a.srcPgUrl = next();
        break;
      case "--src-pg-schema":
        a.srcPgSchema = next();
        break;
      case "--dst-driver":
        a.dstDriver = next() as CliArgs["dstDriver"];
        break;
      case "--dst-data-dir":
        a.dstDataDir = next();
        break;
      case "--dst-pg-url":
        a.dstPgUrl = next();
        break;
      case "--dst-pg-schema":
        a.dstPgSchema = next();
        break;
      case "--snapshot":
        a.snapshot = true;
        break;
      case "--no-clear":
        a.noClear = true;
        break;
      case "--drop-schema":
        a.dropSchema = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return a;
}

function pgUrlFrom(argValue: string | undefined): string | undefined {
  return argValue ?? process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
}

function toOpts(
  driver: "sqlite" | "postgres",
  dataDir: string | undefined,
  pgUrl: string | undefined,
  pgSchema: string | undefined,
): DbDriverOptions {
  if (driver === "postgres") {
    const url = pgUrlFrom(pgUrl);
    if (url === undefined) {
      throw new Error(
        "postgres 连接串缺失：请用 --dst-pg-url / --src-pg-url 或环境变量 " +
          "AGENT_STUDIO_PG_TEST_URL / AGENT_STUDIO_PG_CONNECTION_STRING 提供。",
      );
    }
    return { dbDriver: "postgres", pgConnectionString: url, ...(pgSchema === undefined ? {} : { pgSchema }) };
  }
  const dir = dataDir ?? process.env["AGENT_STUDIO_DATA_DIR"] ?? path.resolve("data");
  return { dbDriver: "sqlite", dataDir: dir };
}

function formatValidation(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push("表                源行数  目标行数  行数  键集");
  for (const t of report.tables) {
    const count = t.countMatch ? "OK" : "✗";
    const keys = t.keysMatch ? "OK" : "✗";
    lines.push(
      `${t.table.padEnd(18)} ${String(t.sourceCount).padStart(6)} ${String(t.targetCount).padStart(9)}  ${count.padEnd(4)} ${keys}`,
    );
  }
  lines.push(report.ok ? "校验：通过 ✅" : "校验：失败 ❌");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const srcOpts = toOpts(args.srcDriver, args.srcDataDir, args.srcPgUrl, args.srcPgSchema);
  const dstOpts = toOpts(args.dstDriver, args.dstDataDir, args.dstPgUrl, args.dstPgSchema);

  if (args.command === "migrate") {
    const report = await migrateData(srcOpts, dstOpts, {
      snapshotSource: args.snapshot,
      clear: !args.noClear,
    });
    console.log(`迁移方向：${report.direction}`);
    console.log(`迁移行数合计：${report.totalRows}`);
    console.log("逐表行数：");
    for (const [table, count] of Object.entries(report.perTableCounts)) {
      console.log(`  ${table.padEnd(18)} ${count}`);
    }
    if (report.snapshot !== undefined) console.log(`源库快照：${report.snapshot}`);
    console.log("一致性校验：");
    console.log(formatValidation(report.validation));
    if (!report.validation.ok) {
      throw new Error("迁移后一致性校验未通过。");
    }
  } else if (args.command === "validate") {
    const report = await compareDataViaDrivers(srcOpts, dstOpts);
    console.log("一致性校验：");
    console.log(formatValidation(report));
    if (!report.ok) throw new Error("一致性校验未通过。");
  } else if (args.command === "rollback") {
    const rb: RollbackReport = await rollbackTarget(dstOpts, { dropSchema: args.dropSchema });
    if (rb.droppedSchema !== undefined) {
      console.log(`回滚：已 DROP schema "${rb.droppedSchema}"（目标 PG）。`);
    } else {
      console.log(`回滚：已清空目标库业务表（${rb.clearedTables.length} 张）。源库未改动。`);
    }
  } else {
    throw new Error(`未知命令：${args.command}`);
  }
}

// 校验走独立驱动开合（与 migrate 自检路径一致，但更轻量）。
async function compareDataViaDrivers(
  srcOpts: DbDriverOptions,
  dstOpts: DbDriverOptions,
): Promise<ValidationReport> {
  const src = await openDriver(srcOpts);
  const dst = await openDriver(dstOpts);
  try {
    return await compareData(src, dst);
  } finally {
    await src.close();
    await dst.close();
  }
}

main().catch((error) => {
  console.error("迁移工具失败：", error instanceof Error ? error.message : error);
  process.exit(1);
});

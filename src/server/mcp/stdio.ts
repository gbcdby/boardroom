/**
 * MCP stdio 入口：作为独立进程被宿主（Claude Code / Codex CLI）拉起。
 *
 * 只建立 stdio 传输，不监听端口、不读 WebUI 构建产物。
 * T2（#15）：工具直接读写 F2 的 SQLite（与 HTTP 服务共享同一数据目录），
 * 因此 stdio 也需要打开数据库、执行迁移（幂等），并在退出时把本会话标记为断开。
 *
 * 配置沿用 F1：心跳从 loadConfig 读取（读不到则用默认值），日志写 stderr（stdout 被
 * MCP 协议独占，绝不能写日志）。
 *
 * 用法：
 *   node src/server/mcp/stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { ConfigError, loadConfig, type HeartbeatConfig } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrate.ts";
import { migrations } from "../db/migrations/index.ts";
import { createLogger } from "../logger.ts";
import { createMcpCore } from "./core.ts";
import { createMcpServer } from "./server.ts";

async function main(): Promise<void> {
  // 日志写 stderr：stdout 属于 MCP 线协议，不能混入日志。
  const logger = createLogger({
    level: (process.env["AGENT_STUDIO_LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
    write: (chunk: string) => void process.stderr.write(chunk),
  });

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // 无配置时仍可使用默认值启动；但 stdio 需要数据目录，故用默认 dataDir 兜底。
      logger.warn("配置无效，使用默认数据目录与心跳", { error });
      config = null;
    } else {
      throw error;
    }
  }
  const heartbeat: HeartbeatConfig | undefined = config?.heartbeat;

  // 打开数据库并执行迁移（幂等）；stdio 与 HTTP 服务共享同一数据目录。
  // 无有效配置时退回 "./data"（与 loadConfig 默认一致）。
  const dataDir = config?.dataDir ?? path.resolve("data");
  const opened = openDatabase(dataDir);
  runMigrations(opened.db, migrations);

  const core = createMcpCore({
    logger,
    db: opened.db,
    memberKey: "stdio",
    ...(heartbeat === undefined ? {} : { heartbeat }),
  });
  const server = createMcpServer({ core, logger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp_stdio_connected", { pid: process.pid, database: opened.file });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到退出信号，正在关闭 stdio", { signal });
    // 连接断开：把本会话标记为 disconnected、成员状态 offline（状态可恢复）。
    core.disconnect();
    core.close();
    try {
      await server.close();
    } catch (error) {
      logger.error("关闭 stdio 时出错", { error });
    }
    if (opened.db.open) opened.db.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

await main().catch((error) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`配置无效：${error.message}\n`);
  } else {
    process.stderr.write(`stdio 启动失败：${(error as Error)?.message ?? String(error)}\n`);
  }
  process.exitCode = 1;
});

/**
 * MCP stdio 入口：作为独立进程被宿主（Claude Code / Codex CLI）拉起。
 *
 * 只建立 stdio 传输，不监听端口、不启动数据库迁移、不读 WebUI 构建产物。
 * 配置沿用 F1：心跳从 loadConfig 读取（读不到则用默认值），日志写 stderr（stdout 被
 * MCP 协议独占，绝不能写日志）。
 *
 * 用法：
 *   node src/server/mcp/stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, type HeartbeatConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import { createMcpCore } from "./core.ts";
import { createMcpServer } from "./server.ts";

async function main(): Promise<void> {
  // 日志写 stderr：stdout 属于 MCP 线协议，不能混入日志。
  const logger = createLogger({
    level: (process.env["AGENT_STUDIO_LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
    write: (chunk: string) => void process.stderr.write(chunk),
  });

  let heartbeat: HeartbeatConfig | undefined;
  try {
    const config = await loadConfig();
    heartbeat = config.heartbeat;
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn("配置无效，使用默认心跳", { error });
    } else {
      throw error;
    }
  }

  const core = createMcpCore({
    logger,
    memberKey: "stdio",
    ...(heartbeat === undefined ? {} : { heartbeat }),
  });
  const server = createMcpServer({ core, logger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp_stdio_connected", { pid: process.pid });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到退出信号，正在关闭 stdio", { signal });
    core.close();
    try {
      await server.close();
    } catch (error) {
      logger.error("关闭 stdio 时出错", { error });
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

await main();

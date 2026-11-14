import { ConfigError, loadConfig } from "./config.ts";
import { describeDatabase } from "./environment.ts";
import { createLogger } from "./logger.ts";
import { ServerStartupError, startServer } from "./server.ts";

/** 进程入口：加载配置 → 启动服务 → 注册优雅退出。 */
async function main(): Promise<void> {
  const logger = createLogger({
    level: (process.env["AGENT_STUDIO_LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
  });

  let config;
  try {
    config = await loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`配置无效 [${error.code}]：${error.message}\n恢复方式：${error.recoveryAction}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  logger.info("配置已加载", {
    port: config.port,
    dataDir: config.dataDir,
    heartbeat: config.heartbeat,
    configFile: config.configFile,
    database: describeDatabase(config.environment!.databaseDescriptor),
    startupState: config.environment!.startupState,
  });

  let server;
  try {
    server = await startServer({ config, logger });
  } catch (error) {
    if (error instanceof ServerStartupError) {
      logger.error("启动失败", { error });
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("收到退出信号，正在关闭", { signal });
    try {
      await server.close();
    } catch (error) {
      logger.error("关闭时出错", { error });
      process.exitCode = 1;
    }
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
}

await main();

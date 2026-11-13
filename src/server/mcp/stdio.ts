/**
 * MCP stdio 入口：作为独立进程被宿主（Claude Code / Codex CLI）拉起。
 *
 * 只建立 stdio 传输，不监听端口、不读 WebUI 构建产物。
 * T2（#15）：工具直接读写 F2 的 SQLite（与 HTTP 服务共享同一数据目录），
 * 因此 stdio 也需要打开数据库、执行迁移（幂等），并在退出时把本会话标记为断开。
 *
 * 配置统一从 loadConfig 读取；任何配置错误均在连接前终止，日志写 stderr（stdout 被
 * MCP 协议独占，绝不能写日志）。
 *
 * 用法：
 *   node src/server/mcp/stdio.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { ConfigError, loadConfig } from "../config.ts";
import { databaseForConnectedReader } from "../environment.ts";
import { createDbDriver } from "../db/driver.ts";
import { migrations } from "../db/migrations/index.ts";
import { createRepositories } from "../db/repositories.ts";
import { initializePolicyConfiguration } from "../policy/configuration.ts";
import { createLogger } from "../logger.ts";
import { createMcpCore } from "./core.ts";
import { createMcpServer } from "./server.ts";
import { registerMemoryRuntime, closeMemoryRuntime, pauseMemoryRuntime } from "../memory/runtime.ts";
import { registerStorageSourceClient, storageClientDriverOptions } from "../storage/source-client.ts";
import { StorageMaintenanceError } from "../storage/admission.ts";

async function main(): Promise<void> {
  // 日志写 stderr：stdout 属于 MCP 线协议，不能混入日志。
  const logger = createLogger({
    level: (process.env["AGENT_STUDIO_LOG_LEVEL"] as "debug" | "info" | "warn" | "error") ?? "info",
    write: (chunk: string) => void process.stderr.write(chunk),
  });

  const config = await loadConfig();
  const heartbeat = config.heartbeat;

  // 打开持久化驱动并执行迁移（幂等）；stdio 与 HTTP 服务共享同一数据目录。
  const environment = config.environment!;
  const clientId = randomUUID();
  const driver = createDbDriver(storageClientDriverOptions(environment, clientId));
  await driver.connect();
  try { await driver.migrate(migrations); } catch (error) { await driver.close(); throw error; }
  const storageClient = await registerStorageSourceClient({ db: driver, clientId, entrypoint: "stdio",
    database: databaseForConnectedReader(environment.databaseDescriptor) });
  let ownedCore: ReturnType<typeof createMcpCore> | undefined;
  let ownedServer: ReturnType<typeof createMcpServer> | undefined;
  let maintenanceClosing = false;
  await storageClient.bind({
    stopNewWork() { maintenanceClosing = true; pauseMemoryRuntime(driver); },
    async disconnectSessions() {
      await ownedCore?.close({ drain: true }); await ownedCore?.disconnect({ strict: true }); await ownedServer?.close();
    },
    async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; },
    async observeOwnedExit() { throw new StorageMaintenanceError("active"); },
    closeMemory: () => closeMemoryRuntime(driver),
  });
  storageClient.startWatching();
  try {
    await storageClient.run(async () => {
    await initializePolicyConfiguration(createRepositories(driver));
    await storageClient.assertAdmission();
    registerMemoryRuntime(driver, {
      database: databaseForConnectedReader(environment.databaseDescriptor),
      ...(config.memory ? { config: config.memory } : {}),
      onDiagnostic: code => logger.warn("memory_reader_unavailable", { code }),
    });
    });
  } catch (error) { await storageClient.close(); throw error; }
  await storageClient.assertAdmission();

  const core = createMcpCore({
    logger,
    db: driver,
    memberKey: "stdio",
    ...(heartbeat === undefined ? {} : { heartbeat }),
    ...(config.antiLoop ? { antiLoop: { config: config.antiLoop } } : {}),
  });
  ownedCore = core;
  const server = createMcpServer({ core, logger });
  ownedServer = server;
  const transport = new StdioServerTransport();
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
    logger.info("收到退出信号，正在关闭 stdio", { signal });
    await storageClient.refresh().catch(() => {});
    if (maintenanceClosing) {
      try { await storageClient.waitForDrain(); await storageClient.close(); }
      catch { logger.error("stdio_maintenance_drain_incomplete"); process.exitCode = 1; }
      return;
    }
    // 连接断开：把本会话标记为 disconnected、成员状态 offline（状态可恢复）。
    pauseMemoryRuntime(driver);
    for (const close of [() => core.close({ drain: true }), () => core.disconnect({ strict: true }), () => server.close(),
      () => closeMemoryRuntime(driver), () => storageClient.close()]) {
      try { await close(); }
      catch { logger.error("关闭 stdio 资源失败"); process.exitCode = 1; }
    }
    })();
    return shuttingDown;
  };
  // 宿主正常关闭 stdin 也是资源关闭，不是一次 Agent 声明的逻辑 session-end。
  process.stdin.once("end", () => void shutdown("stdin_end"));
  process.stdin.once("close", () => void shutdown("stdin_close"));
  server.server.onclose = () => { if (!maintenanceClosing) void shutdown("transport_close"); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  try {
    await server.connect(transport);
    logger.info("mcp_stdio_connected", { pid: process.pid, database: driver.kind });
  } catch (error) { await shutdown("startup_failed"); throw error; }
}

await main().catch((error) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`配置无效 [${error.code}]：${error.message}\n恢复方式：${error.recoveryAction}\n`);
  } else {
    // 驱动/迁移/传输异常可含 DSN、任意配置值或服务端原文；不能依赖凭据关键字猜测。
    // 仅输出固定诊断，不读取或转发 message、stack、cause 或非 Error 的 String 值。
    process.stderr.write("stdio 启动失败 [stdio_startup_failed]。\n恢复方式：请检查数据库服务、连接配置、路径权限和应用版本后重试；不会自动切换数据源。\n");
  }
  process.exitCode = 1;
});

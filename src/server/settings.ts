import type { EffectiveSettings } from "../shared/settings.ts";
import { DEFAULT_DB_DRIVER, DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES, DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER,
  resolveMemoryConfig, type AppConfig } from "./config.ts";

/** 仅从启动快照和真实监听地址构造白名单；不读文件、环境或数据库。 */
export function buildEffectiveSettings(input: {
  config: AppConfig;
  address: { host: "127.0.0.1"; port: number };
  startedAt: string;
}): EffectiveSettings {
  const { config, address, startedAt } = input;
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) throw new Error("settings_listening_port_invalid");
  const memory = resolveMemoryConfig(config.memory);
  const httpBaseUrl = `http://${address.host}:${address.port}`;
  return {
    service: { host: address.host, port: address.port, httpBaseUrl,
      websocketUrl: `ws://${address.host}:${address.port}/ws`, mcpHttpUrl: `${httpBaseUrl}/mcp` },
    storage: { driver: config.dbDriver ?? DEFAULT_DB_DRIVER, dataDirectory: config.dataDir,
      postgresConfigured: typeof config.pgConnectionString === "string" && config.pgConnectionString.length > 0 },
    heartbeat: { intervalMs: config.heartbeat.intervalMs, timeoutMs: config.heartbeat.timeoutMs },
    antiLoop: { maxConsecutiveAutoReplies: config.antiLoop?.maxConsecutiveAutoReplies ?? DEFAULT_MAX_CONSECUTIVE_AUTO_REPLIES,
      maxWakesPerMinutePerMember: config.antiLoop?.maxWakesPerMinutePerMember ?? DEFAULT_MAX_WAKES_PER_MINUTE_PER_MEMBER },
    memory: { messageThreshold: memory.messageThreshold, maxDocumentBytes: memory.maxDocumentBytes,
      maxInjectedBytes: memory.maxInjectedBytes, summaryInputBytes: memory.summaryInputBytes,
      summaryAttemptTimeoutMs: memory.summaryAttemptTimeoutMs },
    configuration: { filePath: config.configFile, precedence: ["defaults", "file", "environment"], activation: "restart-required", startedAt },
  };
}

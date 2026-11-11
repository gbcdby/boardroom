import type { MemoryConfig } from "./memory.ts";

/** 当前进程已生效的全局设置；只允许约定的公开字段，不包含连接串或凭据。 */
export interface EffectiveSettings {
  service: { host: "127.0.0.1"; port: number; httpBaseUrl: string; websocketUrl: string; mcpHttpUrl: string };
  storage: { driver: "sqlite" | "postgres"; dataDirectory: string; postgresConfigured: boolean };
  heartbeat: { intervalMs: number; timeoutMs: number };
  antiLoop: { maxConsecutiveAutoReplies: number; maxWakesPerMinutePerMember: number };
  memory: MemoryConfig;
  configuration: {
    filePath: string | null;
    precedence: ["defaults", "file", "environment"];
    activation: "restart-required";
    startedAt: string;
  };
}

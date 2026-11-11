import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/server/config.ts";
import { buildEffectiveSettings } from "../src/server/settings.ts";

test("S5-CONFIG-01/02：设置来自实际解析值，逐字段白名单不泄漏连接串和未知字段", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-settings-"));
  try {
    await writeFile(path.join(directory, "config.json"), JSON.stringify({
      port: 5555, dataDir: "./from-file", heartbeat: { intervalMs: 5000, timeoutMs: 20000 },
      antiLoop: { maxConsecutiveAutoReplies: 4, maxWakesPerMinutePerMember: 15 },
      memory: { messageThreshold: 75, maxDocumentBytes: 16384 },
      pgConnectionString: "postgres://user:file-secret@internal-db:5432/data?token=file-query-secret",
      privatePath: "/private/file-path-canary", credentials: "file-credentials-canary",
    }));
    const config = await loadConfig({ cwd: directory, env: {
      AGENT_STUDIO_PORT: "6001", AGENT_STUDIO_DATA_DIR: "./from-env",
      AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "7000", AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: "90",
      AGENT_STUDIO_PG_CONNECTION_STRING: "postgres://private-user:percent%2Fsecret@internal-db:5432/data?token=env-query-secret",
      PRIVATE_ENV_CANARY: "private-env-value",
    } });
    const polluted = Object.assign(config, { rawArgv: ["argv-canary"], nestedUnknown: { token: "unknown-canary" } });
    Object.assign(polluted.heartbeat, { privateKey: "heartbeat-canary" });
    Object.assign(polluted.memory!, { privateKey: "memory-canary" });
    const result = buildEffectiveSettings({ config: polluted, address: { host: "127.0.0.1", port: 49321 }, startedAt: "2026-11-11T03:00:00.000Z" });
    assert.deepEqual(result, {
      service: { host: "127.0.0.1", port: 49321, httpBaseUrl: "http://127.0.0.1:49321", websocketUrl: "ws://127.0.0.1:49321/ws", mcpHttpUrl: "http://127.0.0.1:49321/mcp" },
      storage: { driver: "sqlite", dataDirectory: path.join(directory, "from-env"), postgresConfigured: true },
      heartbeat: { intervalMs: 7000, timeoutMs: 20000 },
      antiLoop: { maxConsecutiveAutoReplies: 4, maxWakesPerMinutePerMember: 15 },
      memory: { messageThreshold: 90, maxDocumentBytes: 16384, maxInjectedBytes: 8192, summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000 },
      configuration: { filePath: path.join(directory, "config.json"), precedence: ["defaults", "file", "environment"], activation: "restart-required", startedAt: "2026-11-11T03:00:00.000Z" },
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|canary|private-user|internal-db|private-env-value|rawArgv|nestedUnknown|pgConnectionString/);
    assert.equal(config.port, 6001, "展示真实监听端口不回写启动配置");
    Object.assign(config.heartbeat, { intervalMs: 1234 });
    Object.assign(config.memory!, { messageThreshold: 1 });
    assert.equal(result.heartbeat.intervalMs, 7000, "响应不持有原配置的可变引用");
    assert.equal(result.memory.messageThreshold, 90);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("S5-CONFIG-01：旧的手工启动配置采用同一缺省，未监听端口不能冒充实际地址", () => {
  const config: AppConfig = { port: 0, dataDir: "/visible/data", configFile: null, heartbeat: { intervalMs: 10000, timeoutMs: 30000 } };
  const result = buildEffectiveSettings({ config, address: { host: "127.0.0.1", port: 4317 }, startedAt: "2026-11-11T03:00:00.000Z" });
  assert.equal(result.storage.driver, "sqlite");
  assert.equal(result.storage.postgresConfigured, false);
  assert.equal(result.configuration.filePath, null);
  assert.deepEqual(result.antiLoop, { maxConsecutiveAutoReplies: 6, maxWakesPerMinutePerMember: 20 });
  assert.deepEqual(result.memory, { messageThreshold: 50, maxDocumentBytes: 32768, maxInjectedBytes: 8192, summaryInputBytes: 65536, summaryAttemptTimeoutMs: 900000 });
  assert.throws(() => buildEffectiveSettings({ config, address: { host: "127.0.0.1", port: 0 }, startedAt: "2026-11-11T03:00:00.000Z" }), /settings_listening_port_invalid/);
});

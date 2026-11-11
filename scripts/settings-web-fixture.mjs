#!/usr/bin/env node
/** 生产 startServer、临时配置与 SQLite。夹具控制重启，不调用模型或伪装成页面操作。 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/server/config.ts";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";

/** 独立导出真实服务生命周期，允许在无 Chromium 的环境验证夹具。 */
export async function startSettingsBrowserFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-settings-web-"));
  const configFile = path.join(directory, "config.json");
  const dataDirectory = path.join(directory, `项目资料-${"shared-notes-".repeat(8)}<img src=x onerror=globalThis.settingsXss=1>`);
  const fileValues = {
    port: 4317, dataDir: "./unused-file-directory", heartbeat: { intervalMs: 5000, timeoutMs: 20000 },
    antiLoop: { maxConsecutiveAutoReplies: 4, maxWakesPerMinutePerMember: 13 },
    memory: { messageThreshold: 75, maxDocumentBytes: 32768, maxInjectedBytes: 4096, summaryInputBytes: 32768, summaryAttemptTimeoutMs: 180000 },
    pgConnectionString: "postgres://fixture:encoded%2Fsecret-canary@private-db/data?token=query-canary",
    privateDiagnostic: "unknown-config-canary",
  };
  const environment = { AGENT_STUDIO_CONFIG: configFile, AGENT_STUDIO_DATA_DIR: dataDirectory,
    AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "6000", PRIVATE_SETTINGS_CANARY: "environment-canary" };
  let server, changed = false, closed = false;
  const logger = createLogger({ write() {} });
  async function start(port) {
    const config = await loadConfig({ cwd: directory, env: environment });
    return startServer({ config: { ...config, port }, logger, webRoot: path.resolve(import.meta.dirname, "../dist/web") });
  }
  async function close() {
    if (closed) return; closed = true;
    try { await server?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
  try {
    await writeFile(configFile, JSON.stringify(fileValues));
    server = await start(0);
  } catch (error) { await close(); throw error; }
  return {
    info: { url: server.url, configFile, dataDirectory,
      initial: { messageThreshold: 75, heartbeatIntervalMs: 6000, heartbeatTimeoutMs: 20000 },
      updated: { messageThreshold: 88, heartbeatTimeoutMs: 24000 },
      scope: "real production server / actual config file and environment precedence / isolated temporary SQLite / no model invocation" },
    async command(action) {
      assert.equal(closed, false);
      if (action === "change-config") {
        await writeFile(configFile, JSON.stringify({ ...fileValues,
          heartbeat: { ...fileValues.heartbeat, timeoutMs: 24000 },
          memory: { ...fileValues.memory, messageThreshold: 88 },
        }));
        changed = true;
        return { changed: true };
      }
      if (action === "restart") {
        assert.equal(changed, true, "先修改夹具配置，再正常关闭和启动服务");
        const port = server.port;
        await server.close(); server = undefined;
        // 沿用夹具实际分配的监听端口与同一数据配置，页面地址保持可用。
        server = await start(port);
        return { url: server.url, restarted: true };
      }
      throw new Error("unsupported_settings_fixture_command");
    }, close,
  };
}

async function main() {
  let fixture, closing;
  const close = (code = 0) => closing ??= (async () => { await fixture?.close(); })().then(() => process.exit(code), () => process.exit(1));
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
  try {
    fixture = await startSettingsBrowserFixture();
    process.stdout.write(`${JSON.stringify(fixture.info)}\n`);
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const command = JSON.parse(line);
      process.stdout.write(`${JSON.stringify({ id: command.id, result: await fixture.command(command.action) })}\n`);
    }
    await close();
  } catch (error) {
    process.stderr.write(`settings_web_fixture_failed: ${error instanceof Error ? error.stack : "unknown"}\n`);
    await close(1);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import type { EffectiveSettings } from "../src/shared/settings.ts";

async function readSettings(server: RunningServer): Promise<EffectiveSettings> {
  const response = await fetch(`${server.url}/api/settings`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  return (await response.json() as { settings: EffectiveSettings }).settings;
}

async function databaseSnapshot(server: RunningServer) {
  const tables = await server.database.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const snapshot: Record<string, unknown[]> = {};
  for (const table of tables) {
    // 表名来自当前 SQLite schema，不接受 API 或文件输入。
    snapshot[table.name] = await server.database.query(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
  }
  return snapshot;
}

test("S5-CONFIG-01/02/04：生产服务展示实际配置与随机端口，读请求不改数据，磁盘修改只在正常重启后生效", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-settings-server-"));
  const configFile = path.join(directory, "settings.json");
  const logs: string[] = [];
  const logger = createLogger({ write: (line) => { logs.push(line); } });
  const fileValues = {
    port: 4317, dataDir: "./file-data", heartbeat: { intervalMs: 5000, timeoutMs: 22000 },
    antiLoop: { maxConsecutiveAutoReplies: 8, maxWakesPerMinutePerMember: 12 },
    memory: { messageThreshold: 60, maxDocumentBytes: 16384, maxInjectedBytes: 4096, summaryInputBytes: 8192, summaryAttemptTimeoutMs: 120000 },
    pgConnectionString: "postgres://file-user:file-secret-canary@private-db/data?key=file-query-canary",
    credentials: "file-credentials-canary", privatePath: "/private/internal-path-canary",
  };
  const env = {
    AGENT_STUDIO_CONFIG: configFile, AGENT_STUDIO_PORT: "5999", AGENT_STUDIO_DATA_DIR: "./live-data",
    AGENT_STUDIO_HEARTBEAT_INTERVAL_MS: "7000", AGENT_STUDIO_MAX_WAKES_PER_MINUTE_PER_MEMBER: "18",
    AGENT_STUDIO_MEMORY_MESSAGE_THRESHOLD: "90", AGENT_STUDIO_MEMORY_SUMMARY_INPUT_BYTES: "32768",
    AGENT_STUDIO_PG_CONNECTION_STRING: "postgres://env-user:encoded%2Fsecret-canary@private-db/data?token=env-query-canary",
    SETTINGS_TEST_PRIVATE_ENV: "environment-canary",
  };
  let server: RunningServer | undefined;
  try {
    await writeFile(configFile, JSON.stringify(fileValues));
    const loaded = await loadConfig({ cwd: directory, env });
    assert.equal(loaded.port, 5999);
    // 随机端口仅隔离测试监听；其余字段原样来自真实文件/default/env 解析。
    const config = Object.assign({ ...loaded, port: 0 }, { privateInternal: "startup-object-canary" });
    const beforeStart = Date.now();
    server = await startServer({ config, logger });
    const project = await createRepositories(server.database).projects.create({ name: "设置只读验收保留数据" });
    const before = await databaseSnapshot(server), originalFile = await readFile(configFile, "utf8");
    const first = await readSettings(server);
    assert.equal(first.service.host, "127.0.0.1");
    assert.equal(first.service.port, server.port);
    assert.ok(first.service.port > 0);
    assert.equal(first.service.httpBaseUrl, server.url);
    assert.equal(first.service.websocketUrl, server.wsUrl);
    assert.equal(first.service.mcpHttpUrl, server.mcpUrl);
    assert.deepEqual(first.storage, { driver: "sqlite", dataDirectory: path.join(directory, "live-data"), postgresConfigured: true });
    assert.deepEqual(first.heartbeat, { intervalMs: 7000, timeoutMs: 22000 });
    assert.deepEqual(first.antiLoop, { maxConsecutiveAutoReplies: 8, maxWakesPerMinutePerMember: 18 });
    assert.deepEqual(first.memory, { messageThreshold: 90, maxDocumentBytes: 16384, maxInjectedBytes: 4096, summaryInputBytes: 32768, summaryAttemptTimeoutMs: 120000 });
    assert.equal(first.configuration.filePath, configFile);
    assert.deepEqual(first.configuration.precedence, ["defaults", "file", "environment"]);
    assert.equal(first.configuration.activation, "restart-required");
    assert.ok(Date.parse(first.configuration.startedAt) >= beforeStart);
    assert.ok(Date.parse(first.configuration.startedAt) <= Date.now());
    const memoryResponse = await fetch(`${server.url}/api/memory-settings`);
    assert.equal(memoryResponse.status, 200);
    assert.deepEqual((await memoryResponse.json() as { settings: unknown }).settings, first.memory);
    const head = await fetch(`${server.url}/api/settings`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal(head.headers.get("cache-control"), "no-store");
    assert.deepEqual(await databaseSnapshot(server), before, "GET/HEAD 和记忆设置读取没有改变持久化数据");
    assert.equal(await readFile(configFile, "utf8"), originalFile, "读取没有改写配置文件");
    const updatedFile = JSON.stringify({ ...fileValues,
      heartbeat: { intervalMs: 9000, timeoutMs: 45000 },
      memory: { ...fileValues.memory, messageThreshold: 70, maxDocumentBytes: 32768 },
    });
    await writeFile(configFile, updatedFile);
    assert.deepEqual(await readSettings(server), first, "已运行进程不会热读取磁盘新值");
    assert.equal(await readFile(configFile, "utf8"), updatedFile);
    await server.close(); server = undefined;
    const next = await loadConfig({ cwd: directory, env });
    server = await startServer({ config: { ...next, port: 0 }, logger });
    const restarted = await readSettings(server);
    assert.deepEqual(restarted.heartbeat, { intervalMs: 7000, timeoutMs: 45000 }, "环境覆盖继续生效，未覆盖文件值随重启更新");
    assert.equal(restarted.memory.maxDocumentBytes, 32768);
    assert.equal(restarted.memory.messageThreshold, 90);
    assert.notEqual(restarted.configuration.startedAt, first.configuration.startedAt);
    assert.equal(restarted.service.httpBaseUrl, server.url);
    assert.deepEqual((await (await fetch(`${server.url}/api/memory-settings`)).json() as { settings: unknown }).settings, restarted.memory);
    assert.equal((await createRepositories(server.database).projects.get(project.id))?.name, project.name, "重启使用同一数据配置并保留业务数据");
    for (const text of [JSON.stringify(first), JSON.stringify(restarted), logs.join("")]) {
      assert.doesNotMatch(text, /canary|private-db|file-user|env-user|pgConnectionString|privateInternal|credentials/);
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("S5-CONFIG-03：生产挂载使用可信全局主体，拒绝 Agent 和写入请求", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-settings-auth-"));
  let agent = true;
  let server: RunningServer | undefined;
  try {
    server = await startServer({ config: { port: 0, dataDir: directory, configFile: null, heartbeat: { intervalMs: 10000, timeoutMs: 30000 } },
      logger: createLogger({ write() {} }), authorization: { resolveHttpActor: async ({ projectId }) => {
        assert.equal(projectId, null);
        return agent ? { ...ownerActor(), kind: "agent" } : ownerActor();
      } } });
    const rejected = await fetch(`${server.url}/api/settings?actor=owner`, { headers: { "x-actor": "owner" } });
    assert.equal(rejected.status, 403);
    assert.doesNotMatch(await rejected.text(), /dataDirectory|filePath/);
    agent = false;
    assert.equal((await readSettings(server)).configuration.filePath, null);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${server.url}/api/settings`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ port: 6001, actor: "owner" }) });
      assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
    assert.equal((await readSettings(server)).service.port, server.port);
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});

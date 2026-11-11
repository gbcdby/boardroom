import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, writeFile, rename, symlink, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/server/config.ts";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JoinResult } from "../src/server/mcp/core.ts";

const root = path.resolve(import.meta.dirname, "..");
const stdioEntry = path.join(root, "src/server/mcp/stdio.ts");

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_STUDIO_") || name === "BOARDROOM_HOME" || name === "NODE_OPTIONS") delete env[name];
  return { ...env, ...extra };
}

test("S4-AC01: stdio 显式缺失配置在 connect/migrate/建目录前失败", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-entry-"));
  try {
    const trace = path.join(dir, "trace.mjs");
    await writeFile(trace, `import { writeSync } from 'node:fs';
import { SqliteDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/sqlite.ts")).href)};
for (const method of ['connect', 'migrate']) {
  const original = SqliteDriver.prototype[method];
  SqliteDriver.prototype[method] = function(...args) { writeSync(3, method + '\\n'); return original.apply(this, args); };
}`);
    const before = await readdir(dir);
    const result = spawnSync(process.execPath, ["--import", trace, stdioEntry], {
      cwd: dir, env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: path.join(dir, "missing.json") }),
      input: "", encoding: "utf8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    assert.equal(result.error, undefined);
    assert.deepEqual({ code: result.status, stdout: result.stdout, calls: result.output[3], files: await readdir(dir) },
      { code: 1, stdout: "", calls: "", files: before });
    assert.match(result.stderr, /config_invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("S4-AC01: HTTP/stdio 配置错误矩阵在连接和 mkdir 前失败，诊断不泄露配置原文", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-strict-errors-"));
  try {
    const trace = path.join(dir, "trace.mjs");
    await writeFile(trace, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { SqliteDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/sqlite.ts")).href)};
import { PostgresDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/postgres.ts")).href)};
for (const Driver of [SqliteDriver,PostgresDriver]) for (const method of ['connect','migrate']) {
  const original = Driver.prototype[method];
  Driver.prototype[method] = function(...args) { fs.writeSync(3, method+'\\n'); return original.apply(this,args); };
}
const mkdir = fs.mkdirSync; fs.mkdirSync = (...args) => { fs.writeSync(3,'mkdir\\n'); return mkdir(...args); }; syncBuiltinESMExports();`);
    const secret = "do-not-print-config-secret";
    const broken = path.join(dir, "broken.json"); await writeFile(broken, `{"pgConnectionString":"${secret}"`);
    const pg = path.join(dir, "pg.json"); await writeFile(pg, JSON.stringify({ dbDriver: "postgres", extra: secret }));
    const v2 = path.join(dir, "v2.json"); await writeFile(v2, JSON.stringify({ layoutVersion: 2, storageId: "unactivated" }));
    const cases = [
      { AGENT_STUDIO_CONFIG: path.join(dir, "missing.json") },
      { AGENT_STUDIO_CONFIG: broken }, { AGENT_STUDIO_CONFIG: pg },
      { BOARDROOM_HOME: "relative-home" }, { AGENT_STUDIO_CONFIG: v2 },
    ];
    const before = await readdir(dir);
    for (const entry of [stdioEntry, path.join(root, "src/server/index.ts")]) for (const overrides of cases) {
      const result = spawnSync(process.execPath, ["--import", trace, entry], { cwd: dir,
        env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), ...overrides }), input: "", encoding: "utf8", timeout: 8000,
        stdio: ["pipe", "pipe", "pipe", "pipe"] });
      assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, ""); assert.equal(result.output[3], "");
      assert.match(result.stderr, /config_invalid|legacy_migration_required/);
      assert.equal(result.stderr.includes(secret), false);
      assert.deepEqual(await readdir(dir), before);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("S4-AC01: 实际非 root POSIX 拒绝不可读配置与 SQLite 真实父目录无写权限", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "需要非 root POSIX 权限环境，未用 mock 代替" : false,
  timeout: 15_000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-permissions-"));
  const actualDir = path.join(dir, "actual"); const legacy = path.join(dir, "legacy"); const file = path.join(dir, "unreadable.json");
  try {
    await mkdir(legacy); await writeFile(file, "{}");
    const db = createDbDriver({ dataDir: actualDir }); await db.connect(); await db.migrate(migrations); await db.close();
    const actual = path.join(actualDir, "agent-studio.db"); await symlink(actual, path.join(legacy, "agent-studio.db"));
    const before = await readFile(actual); const names = await readdir(actualDir);
    await chmod(file, 0); await chmod(actualDir, 0o555);
    for (const entry of [stdioEntry, path.join(root, "src/server/index.ts")]) {
      for (const override of [{ AGENT_STUDIO_CONFIG: file }, { AGENT_STUDIO_DATA_DIR: legacy }]) {
        const result = spawnSync(process.execPath, [entry], { cwd: dir, env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), ...override }),
          input: "", encoding: "utf8", timeout: 8000 });
        assert.equal(result.error, undefined); assert.equal(result.status, 1);
        assert.equal(result.stdout, ""); assert.match(result.stderr, /config_invalid/);
        assert.deepEqual(await readFile(actual), before); assert.deepEqual(await readdir(actualDir), names);
        assert.equal((await readdir(dir)).includes("data"), false);
      }
    }
  } finally {
    await chmod(file, 0o600).catch(() => {}); await chmod(actualDir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("S4-AC01: HTTP/stdio 从不同 cwd 同一显式配置读取两个项目及同库记忆（每项目独立会话）", { timeout: 25_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-entry-consistency-"));
  const actualDir = path.join(dir, "actual"); const legacy = path.join(dir, "legacy");
  const httpCwd = path.join(dir, "http"); const stdioCwd = path.join(dir, "stdio");
  for (const directory of [legacy, httpCwd, stdioCwd]) await mkdir(directory);
  const db = createDbDriver({ dataDir: actualDir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const fixtures: { projectId: string; groupId: string; agentId: string; displayName: string; text: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const project = await repos.projects.create({ name: `project-${i}` });
    const agent = await repos.agents.create({ displayName: `reader-${i}`, hostType: "other" });
    const member = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: agent.displayName });
    const group = await repos.groups.create({ projectId: project.id, name: "group", participantMemberIds: [member.id] });
    const text = `same-database-memory-${i}`;
    await repos.memory.insertHead({ id: randomUUID(), key: { scope: "project-agent", projectId: project.id, agentId: agent.id },
      version: 1, markdown: text, byteLength: Buffer.byteLength(text), updatedAt: new Date().toISOString(),
      updatedBy: { kind: "agent", actorId: member.id, agentId: agent.id, displayName: agent.displayName }, source: "agent" });
    fixtures.push({ projectId: project.id, groupId: group.id, agentId: agent.id, displayName: agent.displayName, text });
  }
  await db.close();
  const actual = path.join(actualDir, "selected.sqlite"); await rename(path.join(actualDir, "agent-studio.db"), actual);
  await symlink(actual, path.join(legacy, "agent-studio.db"));
  const config = path.join(dir, "explicit.json"); await writeFile(config, JSON.stringify({ dataDir: legacy }));
  const env = cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config, AGENT_STUDIO_LOG_LEVEL: "error" });
  const fixture = path.join(dir, "http-fixture.mjs");
  const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.join(root, relative)).href);
  await writeFile(fixture, `import { loadConfig } from ${moduleUrl("src/server/config.ts")};
import { startServer } from ${moduleUrl("src/server/server.ts")};
import { createLogger } from ${moduleUrl("src/server/logger.ts")};
const config = await loadConfig();
const server = await startServer({config: {...config, port: 0}, logger: createLogger({write: () => {}})});
process.send({url:server.url,mcpUrl:server.mcpUrl,sqlitePath:server.database.file});
process.on('message', async () => { await server.close(); process.disconnect(); });`);
  const http = fork(fixture, [], { cwd: httpCwd, env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const httpExit = once(http, "exit"); let errors = ""; http.stderr!.on("data", chunk => { errors += String(chunk); });
  try {
    const [ready] = await Promise.race([once(http, "message"), httpExit.then(() => { throw new Error(`HTTP fixture exited: ${errors}`); })]) as [{ url: string; mcpUrl: string; sqlitePath: string }];
    assert.equal(ready.sqlitePath, actual);
    const list = await (await fetch(`${ready.url}/api/projects`)).json() as { projects: { id: string }[] };
    assert.deepEqual(list.projects.map(p => p.id).sort(), fixtures.map(p => p.projectId).sort());
    for (const fixture of fixtures) {
      const httpTransport = new StreamableHTTPClientTransport(new URL(ready.mcpUrl));
      const httpClient = new Client({ name: "same-source-http", version: "1" });
      const stdioTransport = new StdioClientTransport({ command: process.execPath, args: [stdioEntry], cwd: stdioCwd,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), stderr: "pipe" });
      const stdioClient = new Client({ name: "same-source-stdio", version: "1" });
      let stdioErrors = ""; stdioTransport.stderr?.on("data", chunk => { stdioErrors += String(chunk); });
      try {
        await httpClient.connect(httpTransport as unknown as Parameters<Client["connect"]>[0]);
        const join = { displayName: fixture.displayName, hostType: "other", projectId: fixture.projectId, groupId: fixture.groupId };
        const h = (await httpClient.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(h.ok, true); assert.equal(h.projectId, fixture.projectId); assert.equal(h.agentId, fixture.agentId);
        assert.deepEqual(h.context.memory?.entries.map(entry => entry.markdown), [fixture.text]);
        await stdioClient.connect(stdioTransport as unknown as Parameters<Client["connect"]>[0]);
        const s = (await stdioClient.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(s.ok, true, stdioErrors); assert.equal(s.projectId, fixture.projectId); assert.equal(s.agentId, fixture.agentId);
        assert.deepEqual(s.context.memory?.entries.map(entry => entry.markdown), [fixture.text]);
      } finally {
        await httpTransport.terminateSession().catch(() => {}); await httpClient.close();
        await stdioClient.close(); await stdioTransport.close();
      }
    }
    assert.deepEqual(await readdir(httpCwd), []); assert.deepEqual(await readdir(stdioCwd), []);
  } finally {
    if (http.exitCode === null && http.signalCode === null) http.send({ close: true });
    const force = setTimeout(() => http.kill("SIGKILL"), 3000);
    await httpExit; clearTimeout(force);
    await rm(dir, { recursive: true, force: true });
  }
});

test("S4 HTTP: 既有源解析后被移动时启动拒绝，不能创建新的空库", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-http-source-"));
  try {
    const db = createDbDriver({ dataDir: dir });
    await db.connect(); await db.migrate(migrations); await db.close();
    const config = await loadConfig({ cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: dir } });
    const original = path.join(dir, "agent-studio.db");
    await rename(original, path.join(dir, "moved.sqlite"));
    await assert.rejects(async () => {
      const server = await startServer({ config: { ...config, port: 0 }, logger: createLogger({ level: "error", write: () => {} }) });
      await server.close();
    }, { code: "storage_source_changed" });
    assert.deepEqual(await readdir(dir), ["moved.sqlite"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

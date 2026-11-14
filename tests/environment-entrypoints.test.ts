import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, writeFile, rename, symlink, chmod, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, fork, type ChildProcess } from "node:child_process";
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
import type { MemoryDocument } from "../src/shared/memory.ts";
import { createMemoryReaderObservation, withCleanup, type ExpectedMemoryEntry } from "./helpers/memory-reader-observer.ts";
import { Client as PgClient } from "pg";

const root = path.resolve(import.meta.dirname, "..");
const stdioEntry = path.join(root, "src/server/mcp/stdio.ts");

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("AGENT_STUDIO_") || name === "BOARDROOM_HOME" || name === "NODE_OPTIONS") delete env[name];
  return { ...env, ...extra };
}

async function closeHttpFixture(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await withCleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
      child.send({ close: true }, error => error ? reject(error) : resolve());
    });
  }, () => exited, () => clearTimeout(force));
}

interface StoredMemoryFixture { projectId: string; agentId: string; documentId: string; text: string }
function expectedMemory(fixture: StoredMemoryFixture): ExpectedMemoryEntry[] {
  return [{ scope: "project-agent", documentId: fixture.documentId, version: 1, markdown: fixture.text }];
}

async function assertStoredMemory(client: Client, fixture: StoredMemoryFixture, otherProjectId: string): Promise<void> {
  // #108 §6：显式领域读取不依赖首次 join 尽力注入的 500ms 额外等待预算。
  const response = await client.callTool({ name: "read_memory", arguments: { scope: "project-agent", projectId: fixture.projectId } });
  const result = response.structuredContent as { ok: boolean; document: MemoryDocument | null; version: number };
  assert.notEqual(response.isError, true); assert.equal(result.ok, true); assert.ok(result.document);
  assert.deepEqual({ id: result.document.id, key: result.document.key, version: result.document.version, markdown: result.document.markdown },
    { id: fixture.documentId, key: { scope: "project-agent", projectId: fixture.projectId, agentId: fixture.agentId }, version: 1, markdown: fixture.text });
  assert.equal(result.version, 1);
  const denied = await client.callTool({ name: "read_memory", arguments: { scope: "project-agent", projectId: otherProjectId } });
  const failure = denied.structuredContent as { ok: boolean; error: { code: string; details?: { reason?: string } } };
  assert.equal(denied.isError, true); assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "FORBIDDEN"); assert.equal(failure.error.details?.reason, "out_of_connection");
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

test("REQ-001: 真实 PG 连接失败不泄漏 query 凭据，HTTP 对照与 stdio 协议保持安全", { timeout: 20_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-pg-diagnostic-"));
  try {
    const canary = "REVIEW_SYNTHETIC_QUERY_PASSWORD_132";
    const config = path.join(dir, "config.json");
    await writeFile(config, JSON.stringify({ dbDriver: "postgres", pgConnectionString: `postgres://tester@127.0.0.1:1/no_database?password=${canary}` }));
    const trace = path.join(dir, "trace.mjs");
    await writeFile(trace, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { SqliteDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/sqlite.ts")).href)};
import { PostgresDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/postgres.ts")).href)};
for (const [kind, Driver] of [['sqlite', SqliteDriver], ['postgres', PostgresDriver]]) for (const method of ['connect', 'migrate']) {
  const original = Driver.prototype[method];
  Driver.prototype[method] = function(...args) { fs.writeSync(3, kind + '.' + method + '\\n'); return original.apply(this, args); };
}
const mkdir = fs.mkdirSync; fs.mkdirSync = (...args) => { fs.writeSync(3, 'mkdir\\n'); return mkdir(...args); }; syncBuiltinESMExports();`);
    const before = await readdir(dir);
    for (const entry of [path.join(root, "src/server/index.ts"), stdioEntry]) {
      const result = spawnSync(process.execPath, ["--import", trace, entry], { cwd: dir,
        env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config, AGENT_STUDIO_LOG_LEVEL: "error" }),
        input: "", encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      const diagnostic = result.stdout + result.stderr;
      t.diagnostic(JSON.stringify({ entry: entry === stdioEntry ? "stdio" : "http", exitCode: result.status,
        calls: result.output[3], canaryPresent: diagnostic.includes(canary), filesUnchanged: JSON.stringify(await readdir(dir)) === JSON.stringify(before) }));
      assert.equal(result.error, undefined); assert.equal(result.status, 1);
      assert.equal(result.output[3], "postgres.connect\n");
      assert.deepEqual(await readdir(dir), before);
      assert.equal(diagnostic.includes(canary), false);
      assert.equal(diagnostic.includes("postgres://"), false);
      if (entry === stdioEntry) {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /stdio_startup_failed/);
        assert.match(result.stderr, /恢复方式/);
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("REQ-001: stdio 不转发任意底层 Error 或非 Error 原文", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-opaque-diagnostic-"));
  try {
    const canary = "SYNTHETIC_UNSTRUCTURED_DRIVER_DETAIL_132";
    const preload = path.join(dir, "failure.mjs");
    for (const expression of [`new Error(${JSON.stringify(canary)})`, JSON.stringify(canary)]) {
      await writeFile(preload, `import { PostgresDriver } from ${JSON.stringify(pathToFileURL(path.join(root, "src/server/db/drivers/postgres.ts")).href)};
PostgresDriver.prototype.connect = async function() { throw ${expression}; };`);
      const before = await readdir(dir);
      const result = spawnSync(process.execPath, ["--import", preload, stdioEntry], { cwd: dir,
        env: cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DB_DRIVER: "postgres",
          AGENT_STUDIO_PG_CONNECTION_STRING: "postgres://tester@127.0.0.1:1/no_database" }),
        input: "", encoding: "utf8", timeout: 8000 });
      assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes(canary), false); assert.match(result.stderr, /stdio_startup_failed/);
      assert.deepEqual(await readdir(dir), before);
    }
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

test("S4-AC01: HTTP/stdio 从不同 cwd 同一显式配置读取两个项目及同库记忆（每项目独立会话）", { timeout: 25_000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-entry-consistency-"));
  const actualDir = path.join(dir, "actual"); const legacy = path.join(dir, "legacy");
  const httpCwd = path.join(dir, "http"); const stdioCwd = path.join(dir, "stdio");
  for (const directory of [legacy, httpCwd, stdioCwd]) await mkdir(directory);
  const db = createDbDriver({ dataDir: actualDir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const fixtures: (StoredMemoryFixture & { groupId: string; displayName: string })[] = [];
  for (let i = 0; i < 2; i++) {
    const project = await repos.projects.create({ name: `project-${i}` });
    const agent = await repos.agents.create({ displayName: `reader-${i}`, hostType: "other" });
    const member = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: agent.displayName });
    const group = await repos.groups.create({ projectId: project.id, name: "group", participantMemberIds: [member.id] });
    const text = `same-database-memory-${i}`, documentId = randomUUID();
    await repos.memory.insertHead({ id: documentId, key: { scope: "project-agent", projectId: project.id, agentId: agent.id },
      version: 1, markdown: text, byteLength: Buffer.byteLength(text), updatedAt: new Date().toISOString(),
      updatedBy: { kind: "agent", actorId: member.id, agentId: agent.id, displayName: agent.displayName }, source: "agent" });
    fixtures.push({ projectId: project.id, groupId: group.id, agentId: agent.id, displayName: agent.displayName, text, documentId });
  }
  await db.close();
  const actual = path.join(actualDir, "selected.sqlite"); await rename(path.join(actualDir, "agent-studio.db"), actual);
  await symlink(actual, path.join(legacy, "agent-studio.db"));
  const config = path.join(dir, "explicit.json"); await writeFile(config, JSON.stringify({ dataDir: legacy }));
  const env = cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config, AGENT_STUDIO_LOG_LEVEL: "error" });
  const identity = await stat(actual, { bigint: true });
  const expectedDatabase = { kind: "sqlite" as const, sqlitePath: await realpath(actual), sourcePath: path.join(legacy, "agent-studio.db"),
    identity: { device: String(identity.dev), inode: String(identity.ino) } };
  const httpObservation = await createMemoryReaderObservation(dir, "http");
  const fixture = path.join(dir, "http-fixture.mjs");
  const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.join(root, relative)).href);
  await writeFile(fixture, `import { loadConfig } from ${moduleUrl("src/server/config.ts")};
import { startServer } from ${moduleUrl("src/server/server.ts")};
import { createLogger } from ${moduleUrl("src/server/logger.ts")};
const config = await loadConfig();
const server = await startServer({config: {...config, port: 0}, logger: createLogger({write: () => {}})});
process.send({url:server.url,mcpUrl:server.mcpUrl,sqlitePath:server.database.file});
process.on('message', async () => { await server.close(); process.disconnect(); });`);
  const http = fork(fixture, [], { cwd: httpCwd, env, execArgv: ["--import", httpObservation.preload], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const httpExit = once(http, "exit"); let errors = ""; http.stderr!.on("data", chunk => { errors += String(chunk); });
  await withCleanup(async () => {
    const [ready] = await Promise.race([once(http, "message"), httpExit.then(() => { throw new Error(`HTTP fixture exited: ${errors}`); })]) as [{ url: string; mcpUrl: string; sqlitePath: string }];
    assert.equal(ready.sqlitePath, await realpath(actual));
    const list = await (await fetch(`${ready.url}/api/projects`)).json() as { projects: { id: string }[] };
    assert.deepEqual(list.projects.map(p => p.id).sort(), fixtures.map(p => p.projectId).sort());
    for (const [i, fixture] of fixtures.entries()) {
      const httpTransport = new StreamableHTTPClientTransport(new URL(ready.mcpUrl));
      const httpClient = new Client({ name: "same-source-http", version: "1" });
      const stdioObservation = await createMemoryReaderObservation(dir, `stdio-${i}`);
      const stdioTransport = new StdioClientTransport({ command: process.execPath, args: ["--import", stdioObservation.preload, stdioEntry], cwd: stdioCwd,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), stderr: "pipe" });
      const stdioClient = new Client({ name: "same-source-stdio", version: "1" });
      let stdioErrors = ""; stdioTransport.stderr?.on("data", chunk => { stdioErrors += String(chunk); });
      await withCleanup(async () => {
        await httpClient.connect(httpTransport as unknown as Parameters<Client["connect"]>[0]);
        const join = { displayName: fixture.displayName, hostType: "other", projectId: fixture.projectId, groupId: fixture.groupId };
        const h = (await httpClient.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(h.ok, true); assert.equal(h.projectId, fixture.projectId); assert.equal(h.agentId, fixture.agentId);
        t.diagnostic(JSON.stringify({ transport: "http", projectIndex: i,
          injection: await httpObservation.assertInjection(h.context.memory, expectedMemory(fixture), expectedDatabase) }));
        await assertStoredMemory(httpClient, fixture, fixtures[1 - i]!.projectId);
        await stdioClient.connect(stdioTransport as unknown as Parameters<Client["connect"]>[0]);
        const s = (await stdioClient.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(s.ok, true, stdioErrors); assert.equal(s.projectId, fixture.projectId); assert.equal(s.agentId, fixture.agentId);
        t.diagnostic(JSON.stringify({ transport: "stdio", projectIndex: i,
          injection: await stdioObservation.assertInjection(s.context.memory, expectedMemory(fixture), expectedDatabase) }));
        await assertStoredMemory(stdioClient, fixture, fixtures[1 - i]!.projectId);
      }, () => httpTransport.terminateSession(), () => httpClient.close(),
      () => stdioObservation.closeAndAudit(expectedDatabase, () => stdioClient.close(), () => stdioTransport.close()));
    }
    assert.deepEqual(await readdir(httpCwd), []); assert.deepEqual(await readdir(stdioCwd), []);
  }, () => httpObservation.closeAndAudit(expectedDatabase, () => closeHttpFixture(http, httpExit)),
  () => rm(dir, { recursive: true, force: true }));
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

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
test("S4-AC01 PostgreSQL: HTTP/stdio 跨 cwd 共用显式 PG 源与记忆，绝不创建 SQLite", {
  skip: pgUrl ? false : "未配置真实 PostgreSQL；保留真实连接的 CI 门控，不以配置清单或 SQLite 代替 PASS", timeout: 30_000,
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-pg-entry-"));
  const schema = `env_${randomUUID().replaceAll("-", "")}`;
  const admin = new PgClient({ connectionString: pgUrl! }); await admin.connect();
  const url = new URL(pgUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
  const db = createDbDriver({ dbDriver: "postgres", pgConnectionString: url.href });
  let stopHttp: (() => Promise<void>) | undefined;
  await withCleanup(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await db.connect(); await db.migrate(migrations);
    const repos = createRepositories(db);
    const fixtures: { projectId: string; groupId: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const project = await repos.projects.create({ name: `PG-${i}` });
      const group = await repos.groups.create({ projectId: project.id, name: "PG group" });
      fixtures.push({ projectId: project.id, groupId: group.id });
    }
    const httpCwd = path.join(dir, "http"); const stdioCwd = path.join(dir, "stdio"); await mkdir(httpCwd); await mkdir(stdioCwd);
    const config = path.join(dir, "pg.json");
    await writeFile(config, JSON.stringify({ dataDir: path.join(dir, "management"), dbDriver: "postgres", pgConnectionString: url.href }));
    const env = cleanEnv({ BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config, AGENT_STUDIO_LOG_LEVEL: "error" });
    const expectedDatabase = { kind: "postgres" as const, connectionString: url.href };
    const httpObservation = await createMemoryReaderObservation(dir, "pg-http");
    const script = path.join(dir, "http.mjs"); const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(path.join(root, relative)).href);
    await writeFile(script, `import { loadConfig } from ${moduleUrl("src/server/config.ts")};
import { startServer } from ${moduleUrl("src/server/server.ts")};
import { createLogger } from ${moduleUrl("src/server/logger.ts")};
const server = await startServer({config:{...await loadConfig(),port:0},logger:createLogger({write:()=>{}})});
process.send({url:server.url,mcpUrl:server.mcpUrl,kind:server.database.kind});
process.on('message',async()=>{await server.close();process.disconnect();});`);
    const http = fork(script, [], { cwd: httpCwd, env, execArgv: ["--import", httpObservation.preload], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(http, "exit");
    stopHttp = () => httpObservation.closeAndAudit(expectedDatabase, () => closeHttpFixture(http, exited));
    const [ready] = await Promise.race([once(http, "message"), exited.then(() => { throw new Error("PG HTTP fixture exited before ready"); })]) as [{ url: string; mcpUrl: string; kind: string }];
    assert.equal(ready.kind, "postgres");
    const projects = await (await fetch(`${ready.url}/api/projects`)).json() as { projects: { id: string }[] };
    assert.deepEqual(projects.projects.map(p => p.id).sort(), fixtures.map(p => p.projectId).sort());
    for (const [i, fixture] of fixtures.entries()) {
      const transport = new StreamableHTTPClientTransport(new URL(ready.mcpUrl));
      const client = new Client({ name: "PG HTTP", version: "1" });
      const stdioObservation = await createMemoryReaderObservation(dir, `pg-stdio-${i}`);
      const stdio = new StdioClientTransport({ command: process.execPath, args: ["--import", stdioObservation.preload, stdioEntry], cwd: stdioCwd, stderr: "ignore",
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) });
      const other = new Client({ name: "PG stdio", version: "1" });
      await withCleanup(async () => {
        await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
        const join = { ...fixture, displayName: `pg-reader-${i}`, hostType: "other" };
        const joined = (await client.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(joined.ok, true);
        t.diagnostic(JSON.stringify({ transport: "pg-http", projectIndex: i,
          injection: await httpObservation.assertInjection(joined.context.memory, [], expectedDatabase) }));
        const text = `PG committed memory ${i}`, documentId = randomUUID();
        await repos.memory.insertHead({ id: documentId, key: { scope: "project-agent", projectId: fixture.projectId, agentId: joined.agentId },
          version: 1, markdown: text, byteLength: Buffer.byteLength(text), updatedAt: new Date().toISOString(),
          updatedBy: { kind: "agent", actorId: joined.memberId, agentId: joined.agentId, displayName: join.displayName }, source: "agent" });
        const stored = { ...fixture, agentId: joined.agentId, documentId, text };
        await assertStoredMemory(client, stored, fixtures[1 - i]!.projectId);
        await other.connect(stdio as unknown as Parameters<Client["connect"]>[0]);
        const observed = (await other.callTool({ name: "join", arguments: join })).structuredContent as unknown as JoinResult;
        assert.equal(observed.ok, true); assert.equal(observed.agentId, joined.agentId); assert.equal(observed.projectId, fixture.projectId);
        t.diagnostic(JSON.stringify({ transport: "pg-stdio", projectIndex: i,
          injection: await stdioObservation.assertInjection(observed.context.memory, expectedMemory(stored), expectedDatabase) }));
        await assertStoredMemory(other, stored, fixtures[1 - i]!.projectId);
      }, () => transport.terminateSession(), () => client.close(),
      () => stdioObservation.closeAndAudit(expectedDatabase, () => other.close(), () => stdio.close()));
    }
    assert.deepEqual(await readdir(httpCwd), []); assert.deepEqual(await readdir(stdioCwd), []);
    assert.equal((await readdir(dir)).includes("management"), false);
  }, () => stopHttp?.(), () => db.close(), () => admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
  () => admin.end(), () => rm(dir, { recursive: true, force: true }));
});

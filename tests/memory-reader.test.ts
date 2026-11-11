import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMemoryInjectionReader } from "../src/server/memory/injection-reader.ts";
import { memoryPgUrl, pgUnavailable } from "./helpers/memory-fixture.ts";

async function fixture(body: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-reader-")); const file = path.join(dir, "reader.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE members(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,kind TEXT,status TEXT);
    CREATE TABLE memory_documents(id TEXT PRIMARY KEY,scope TEXT,project_id TEXT,agent_id TEXT,version INTEGER,markdown TEXT,byte_length INTEGER,updated_at TEXT,updated_by TEXT,source TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT);
    INSERT INTO members VALUES('member','project','agent','agent','active'),('other','project','other-agent','agent','active');`);
  const insert = db.prepare("INSERT INTO memory_documents VALUES(?,?,?,?,1,?,?,?,?,'agent')");
  const author = JSON.stringify({ kind: "agent", actorId: "member", agentId: "agent", displayName: "A" });
  for (const [id, scope, project, agent, text] of [["g", "global", null, "agent", "global private"], ["p", "project-agent", "project", "agent", "own project"],
    ["else", "project-agent", "elsewhere", "agent", "other project secret"], ["o", "global", null, "other-agent", "other agent secret"]]) {
    insert.run(id, scope, project, agent, text, Buffer.byteLength(text!), "2026-11-10T00:00:00Z", author);
  }
  db.close();
  try { await body(file, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("AC-MEM-01/03：专属读取只选真实绑定Agent两层，成员撤销后不返回旧正文", async () => fixture(async file => {
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG });
  try {
    const input = { memberId: "member", projectId: "project", bindingGeneration: "1" };
    const result = await reader.readOwn(input);
    assert.equal(result.state, "available"); assert.deepEqual(result.entries.map(entry => entry.markdown), ["global private", "own project"]);
    assert.equal((await reader.readOwn({ ...input, projectId: "elsewhere" })).state, "unavailable");
    const db = new Database(file); db.prepare("UPDATE members SET status='disabled' WHERE id='member'").run(); db.close();
    assert.equal((await reader.readOwn(input)).state, "unavailable");
    assert.equal((await reader.readOwn(input)).entries.length, 0);
  } finally { await reader.close(); }
}));

test("R-P4-S-003：同步SQLite阻塞隔离、1个进程/8排队、超时熔断与终止，不阻塞主库写入", async () => fixture(async (file, dir) => {
  const probe = path.join(dir, "native-block.mjs");
  const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
  await writeFile(probe, `import Database from ${JSON.stringify(modulePath)};
    const db = new Database(':memory:');
    db.function('native_pause', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000));
    process.on('message', message => {
      if(message.type==='init') process.send({type:'ready'});
      if(message.type==='read') { process.send({type:'probe-started'}); db.prepare('SELECT native_pause()').get(); }
    });`);
  const children: ChildProcess[] = []; let started!: () => void;
  const blocked = new Promise<void>(resolve => { started = resolve; });
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG,
    spawnChild: () => { const child = fork(probe, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      children.push(child); child.on("message", (message: { type?: string }) => { if (message.type === "probe-started") started(); }); return child; } });
  try {
    const batch = Array.from({ length: 20 }, (_, i) => reader.readOwn({ memberId: `m${i}`, projectId: "project", bindingGeneration: "1" }));
    await blocked;
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    const db = new Database(file); db.prepare("INSERT INTO messages VALUES('message','main flow continues')").run();
    await new Promise(resolve => setTimeout(resolve, 80)); clearInterval(timer);
    assert.ok(ticks >= 3); assert.equal((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c, 1); db.close();
    const results = await Promise.all(batch);
    assert.equal(results.filter(result => result.errors[0]?.code === "memory_reader_busy").length, 11);
    assert.equal(children.length, 1); assert.ok(results.every(result => result.state === "unavailable"));
    if (children[0]!.exitCode === null && children[0]!.signalCode === null) await once(children[0]!, "exit");
    const again = await reader.readOwn({ memberId: "new", projectId: "project", bindingGeneration: "2" });
    assert.equal(again.errors[0]?.code, "memory_reader_circuit_open"); assert.equal(children.length, 1);
  } finally { await reader.close(); }
}));

test("R-P4-S-003：同一绑定新代际取代排队/在途请求，旧回复不污染新会话", async () => fixture(async file => {
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG });
  try {
    const input = { memberId: "member", projectId: "project", bindingGeneration: "old" };
    const old = reader.readOwn(input); const fresh = reader.readOwn({ ...input, bindingGeneration: "new" });
    assert.equal((await old).errors[0]?.code, "memory_binding_changed");
    assert.equal((await fresh).state, "available");
  } finally { await reader.close(); }
}));

test("R-P4-S-003：子进程实际退出后立即清理在途读取，不等满调用 deadline", async () => fixture(async (file, dir) => {
  const probe = path.join(dir, "exit-before-read.mjs");
  await writeFile(probe, "process.on('message', () => process.exit(0));");
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG,
    spawnChild: () => fork(probe, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }) });
  try {
    const result = await reader.readOwn({ memberId: "member", projectId: "project", bindingGeneration: "1" });
    assert.equal(result.errors[0]?.code, "memory_reader_exited");
  } finally { await reader.close(); }
}));

test("R-P4-S-003：生产 SQLite 只读连接原语实际拒写，关闭后无遗留进程", async () => fixture(async (file, dir) => {
  const probe = path.join(dir, "readonly-probe.mjs");
  const module = new URL("../src/server/memory/injection-reader-child.ts", import.meta.url).href;
  await writeFile(probe, `import { openReadonlyMemorySqlite } from ${JSON.stringify(module)};
    const db = openReadonlyMemorySqlite(${JSON.stringify(file)});
    let code = null;
    try { db.prepare("INSERT INTO messages VALUES('forbidden','cannot write')").run(); }
    catch (error) { code = error.code; }
    process.send({ code, readonly: db.readonly, queryOnly: db.pragma('query_only', {simple:true}) });
    db.close(); process.disconnect();`);
  const child = fork(probe, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const [result] = await once(child, "message") as [{ code: string; readonly: boolean; queryOnly: number }];
    assert.equal(result.code, "SQLITE_READONLY"); assert.equal(result.readonly, true); assert.equal(result.queryOnly, 1);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    const check = new Database(file); assert.equal((check.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0); check.close();
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } }
}));

test("R-P4-S-003：原生阻塞未退出时不创建替代，关闭等待实际 SIGKILL 退出", async () => fixture(async (file, dir) => {
  const probe = path.join(dir, "ignore-term.mjs");
  const modulePath = createRequire(import.meta.url).resolve("better-sqlite3");
  await writeFile(probe, `import Database from ${JSON.stringify(modulePath)};
    process.on('SIGTERM', () => {});
    const db = new Database(':memory:');
    db.function('blocked', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000));
    process.on('message', message => {
      if(message.type==='init') process.send({type:'ready'});
      if(message.type==='read') db.prepare('SELECT blocked()').get();
    });`);
  const children: ChildProcess[] = []; let hard!: () => void;
  const hardTimeout = new Promise<void>(resolve => { hard = resolve; });
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG,
    onDiagnostic: code => { if (code === "memory_reader_hard_timeout") hard(); },
    spawnChild: () => { const child = fork(probe, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child); return child; } });
  try {
    const result = await reader.readOwn({ memberId: "member", projectId: "project", bindingGeneration: "1" });
    assert.equal(result.errors[0]?.code, "memory_reader_timeout"); await hardTimeout;
    assert.equal(children[0]!.exitCode, null); assert.equal(children[0]!.signalCode, null);
    assert.equal((await reader.readOwn({ memberId: "member", projectId: "project", bindingGeneration: "new" })).errors[0]?.code, "memory_reader_circuit_open");
    assert.equal(children.length, 1); await reader.close();
    assert.equal(children[0]!.signalCode, "SIGKILL"); assert.throws(() => process.kill(children[0]!.pid!, 0), { code: "ESRCH" });
  } finally { await reader.close(); }
}));

async function postgresReaderFixture(body: (admin: Client, schema: string, connectionString: string, name: string) => Promise<void>): Promise<void> {
  const schema = `memory_reader_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: memoryPgUrl }); await admin.connect();
  const url = new URL(memoryPgUrl!); url.searchParams.set("application_name", schema);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(`CREATE TABLE members(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,kind TEXT,status TEXT);
      CREATE TABLE memory_documents(id TEXT PRIMARY KEY,scope TEXT,project_id TEXT,agent_id TEXT,version INTEGER,markdown TEXT);
      INSERT INTO members VALUES('member','project','agent','agent','active');
      INSERT INTO memory_documents VALUES('global','global',NULL,'agent',1,'private-global'),('project','project-agent','project','agent',1,'private-project');`);
    await body(admin, schema, url.toString(), schema);
  } finally {
    await admin.query("ROLLBACK"); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
}

test("postgres R-P4-S-003：真实 lock_timeout 结束查询，20次注入仅一个专属连接/子进程", { skip: pgUnavailable }, async () => postgresReaderFixture(async (admin, schema, connectionString, name) => {
  const children: ChildProcess[] = [];
  const reader = createMemoryInjectionReader({ database: { kind: "postgres", connectionString, schema }, config: DEFAULT_MEMORY_CONFIG,
    spawnChild: () => { const child = fork(fileURLToPath(new URL("../src/server/memory/injection-reader-child.ts", import.meta.url)), [],
      { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child); return child; } });
  const input = { memberId: "member", projectId: "project", bindingGeneration: "1" };
  try {
    assert.equal((await reader.readOwn(input)).state, "available");
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name=$1", [name])).rows[0].n), 1);
    await admin.query("BEGIN"); await admin.query("LOCK memory_documents IN ACCESS EXCLUSIVE MODE");
    const results = await Promise.all(Array.from({ length: 20 }, () => reader.readOwn(input)));
    assert.ok(results.every(result => result.errors[0]?.code === "memory_reader_query_failed"), "服务器100ms锁超时先于父500ms deadline，不用延时模拟");
    if (children[0]!.exitCode === null && children[0]!.signalCode === null) await once(children[0]!, "exit");
    assert.equal(children.length, 1);
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name=$1 AND state='active'", [name])).rows[0].n), 0);
    assert.equal((await reader.readOwn(input)).errors[0]?.code, "memory_reader_circuit_open");
    await admin.query("ROLLBACK");
  } finally { await reader.close(); }
}));

test("postgres R-P4-S-003：实际 statement_timeout 与 readonly session 拒写", { skip: pgUnavailable }, async () => postgresReaderFixture(async (admin, schema, connectionString) => {
  const input = { memberId: "member", projectId: "project", bindingGeneration: "1" };
  let reader = createMemoryInjectionReader({ database: { kind: "postgres", connectionString, schema }, config: DEFAULT_MEMORY_CONFIG });
  try {
    assert.equal((await reader.readOwn(input)).state, "available");
    await admin.query(`ALTER TABLE memory_documents RENAME TO memory_documents_raw;
      CREATE FUNCTION slow_memory(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN $1; END $$;
      CREATE VIEW memory_documents AS SELECT id,scope,project_id,agent_id,version,slow_memory(markdown) AS markdown FROM memory_documents_raw;`);
    const result = await reader.readOwn(input);
    assert.equal(result.errors[0]?.code, "memory_reader_query_failed", "SQL在250ms超时并结束，而不是只停止等待");
    await reader.close();
    await admin.query(`DROP VIEW memory_documents; CREATE TABLE write_probe(id INTEGER);
      CREATE FUNCTION forbidden_memory(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO write_probe VALUES(1); RETURN $1; END $$;
      CREATE VIEW memory_documents AS SELECT id,scope,project_id,agent_id,version,forbidden_memory(markdown) AS markdown FROM memory_documents_raw;`);
    reader = createMemoryInjectionReader({ database: { kind: "postgres", connectionString, schema }, config: DEFAULT_MEMORY_CONFIG });
    assert.equal((await reader.readOwn(input)).errors[0]?.code, "memory_reader_query_failed");
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS n FROM write_probe")).rows[0].n), 0, "生产只读session拒绝SELECT函数中的写入");
    await admin.query("BEGIN"); await admin.query("SELECT * FROM memory_documents");
    assert.ok(Number((await admin.query("SELECT COUNT(*) AS n FROM write_probe")).rows[0].n) > 0, "同一探针在可写连接确实会写，避免空测试");
    await admin.query("ROLLBACK");
  } finally { await reader.close(); }
}));

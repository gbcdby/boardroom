import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMemoryInjectionReader } from "../src/server/memory/injection-reader.ts";

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

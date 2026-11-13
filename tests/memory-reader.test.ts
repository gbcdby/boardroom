import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath, stat, rename, copyFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { DEFAULT_MEMORY_CONFIG, loadConfig } from "../src/server/config.ts";
import { createMemoryInjectionReader } from "../src/server/memory/injection-reader.ts";
import { memoryPgUrl, pgUnavailable } from "./helpers/memory-fixture.ts";
import type { MemoryInjection } from "../src/shared/memory.ts";
import { assertInjectionContract, createMemoryReaderObservation, safeReaderDatabase, withCleanup, type ReaderPhase } from "./helpers/memory-reader-observer.ts";

async function fixture(body: (file: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-reader-")); const file = path.join(dir, "reader.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE members(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,kind TEXT,status TEXT,removed_at TEXT,membership_revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE memory_documents(id TEXT PRIMARY KEY,scope TEXT,project_id TEXT,agent_id TEXT,version INTEGER,markdown TEXT,byte_length INTEGER,updated_at TEXT,updated_by TEXT,source TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,body TEXT);
    INSERT INTO members(id,project_id,agent_id,kind,status) VALUES('member','project','agent','agent','active'),('other','project','other-agent','agent','active');`);
  const insert = db.prepare("INSERT INTO memory_documents VALUES(?,?,?,?,1,?,?,?,?,'agent')");
  const author = JSON.stringify({ kind: "agent", actorId: "member", agentId: "agent", displayName: "A" });
  for (const [id, scope, project, agent, text] of [["g", "global", null, "agent", "global private"], ["p", "project-agent", "project", "agent", "own project"],
    ["else", "project-agent", "elsewhere", "agent", "other project secret"], ["o", "global", null, "other-agent", "other agent secret"]]) {
    insert.run(id, scope, project, agent, text, Buffer.byteLength(text!), "2026-11-10T00:00:00Z", author);
  }
  db.close();
  try { await body(file, dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function realHelper(dir: string, cwd: string, holdReady = false) {
  const script = path.join(dir, `reader-harness-${randomUUID()}.mjs`);
  await writeFile(script, `const send = process.send.bind(process);
let held;
${holdReady ? `process.send = function(message, ...rest) {
  if (message?.type === 'ready') { held = [message, ...rest]; send({type:'probe-ready-held'}); return true; }
  return send(message, ...rest);
};
process.on('message', message => {
  if (message?.type === 'probe-release-ready' && held) { const saved = held; held = undefined; send(...saved); }
});` : ""}
await import(${JSON.stringify(new URL("../src/server/memory/injection-reader-child.ts", import.meta.url).href)});
send({type:'probe-loaded'});`);
  const child = fork(script, [], { cwd, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return monitorChild(child);
}

function monitorChild(child: ChildProcess) {
  const exit = once(child, "exit");
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<{ type: string; resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const waiter of waiters) waiter.reject(error); waiters.clear(); };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`memory helper exited before expected IPC: ${code}/${signal}`)));
  child.on("message", (raw: unknown) => {
    const message = raw as Record<string, unknown>; messages.push(message);
    for (const waiter of [...waiters]) if (message["type"] === waiter.type) { waiters.delete(waiter); waiter.resolve(message); }
  });
  async function message(type: string): Promise<Record<string, unknown>> {
    const previous = messages.find(value => value["type"] === type); if (previous) return previous;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`memory helper missing ${type}`)); }, 5000);
      const waiter = { type, resolve: (value: Record<string, unknown>) => { clearTimeout(timer); resolve(value); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); } };
      waiters.add(waiter);
    });
  }
  return { child, exit, messages, message,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      try { await exit; } finally { clearTimeout(force); }
    },
  };
}

/** 真实 production reader/helper；只由 IPC 门控 ready，并在首次 timeout 已被接受后施加单一故障。 */
async function lateReaderFixture(dir: string, file: string, mode: string) {
  const observation = await createMemoryReaderObservation(dir, "late");
  const gate = path.join(dir, "ready-gate.mjs"), ownerScript = path.join(dir, "reader-owner.mjs");
  const childModule = new URL("../src/server/memory/injection-reader-child.ts", import.meta.url);
  await writeFile(gate, `const send = process.send.bind(process); let held;
process.send = function(message, ...rest) {
  if (message?.type === 'ready') { held = [message, ...rest]; send({type:'probe-ready-held'}); return true; }
  if (message?.type === 'result' && ${JSON.stringify(mode)} === 'protocol') message = {...message, nonce:'wrong-late-nonce'};
  return send(message, ...rest);
};
process.on('message', message => {
  if (message?.type === 'probe-release-ready' && held) { const saved = held; held = undefined; send(...saved); }
  if (message?.type === 'probe-crash') process.exit(23);
});
await import(${JSON.stringify(childModule.href)});
send({type:'probe-loaded'});`);
  await writeFile(ownerScript, `import { fork } from 'node:child_process';
import { createMemoryInjectionReader } from ${JSON.stringify(new URL("../src/server/memory/injection-reader.ts", import.meta.url).href)};
import { DEFAULT_MEMORY_CONFIG } from ${JSON.stringify(new URL("../src/server/config.ts", import.meta.url).href)};
const child = fork(${JSON.stringify(fileURLToPath(childModule))}, [], {execArgv:['--import',${JSON.stringify(gate)}],stdio:['ignore','ignore','ignore','ipc']});
await new Promise(resolve => child.on('message', message => {
  if (message.type === 'probe-loaded') resolve();
  if (message.type === 'probe-ready-held') process.send({type:'held'});
  if (message.type === 'error' || message.type === 'result') process.send({type:'late-' + message.type});
}));
child.on('exit', (code, signal) => process.send({type:'helper-exit',code,signal}));
const reader = createMemoryInjectionReader({database:{kind:'sqlite',sqlitePath:${JSON.stringify(file)}},config:DEFAULT_MEMORY_CONFIG,spawnChild:()=>child});
process.on('message', async message => {
  if (message.type === 'release') child.send({type:'probe-release-ready'});
  if (message.type === 'crash') child.send({type:'probe-crash'});
  if (message.type === 'close') { await reader.close(); process.disconnect(); }
});
const memory = await reader.readOwn({memberId:'member',projectId:'project',membershipRevision:1,bindingGeneration:'late-audit'});
process.send({type:'injection',memory});`);
  const owner = monitorChild(fork(ownerScript, [], { cwd: dir, execArgv: ["--import", observation.preload], stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  return { observation, owner,
    async close() {
      const force = setTimeout(() => owner.child.kill("SIGKILL"), 3000);
      await withCleanup(async () => {
        if (owner.child.exitCode === null && owner.child.signalCode === null) await new Promise<void>((resolve, reject) => {
          owner.child.send({ type: "close" }, error => error ? reject(error) : resolve());
        });
      }, () => owner.exit, () => clearTimeout(force));
    },
  };
}

for (const mode of ["query", "protocol", "process-exit", "controlled-close", "watchdog"] as const) {
  test(`S4 最终观察审计：已接受 timeout 后真实 ${mode} 不遗漏`, { timeout: 10_000 }, async () => fixture(async (file, dir) => {
    const { observation, owner, close } = await lateReaderFixture(dir, file, mode);
    const database = { kind: "sqlite" as const, sqlitePath: file };
    await withCleanup(async () => {
      await owner.message("held");
      const memory = (await owner.message("injection"))["memory"] as MemoryInjection;
      assert.equal(await observation.assertInjection(memory, [], database), "budget-degraded");
      if (mode === "query") {
        const db = new Database(file); try { db.exec("DROP TABLE memory_documents"); } finally { db.close(); }
        owner.child.send({ type: "release" }); await owner.message("late-error");
      }
      if (mode === "process-exit") {
        owner.child.send({ type: "crash" }); assert.equal((await owner.message("helper-exit"))["code"], 23);
      }
      if (mode === "watchdog") assert.equal((await owner.message("helper-exit"))["signal"], "SIGTERM");
      const audit = observation.closeAndAudit(database, async () => {
        // 故障也可发生在受控 close 标记之后；标记不能豁免协议错误。
        if (mode === "protocol") { owner.child.send({ type: "release" }); await owner.message("late-result"); }
      }, close);
      if (mode === "controlled-close" || mode === "watchdog") await audit;
      else await assert.rejects(audit, error => error instanceof assert.AssertionError
        && error.message.includes(mode === "query" ? '"phase":"query-error"' : mode === "protocol" ? '"nonce":"wrong-late-nonce"' : '"code":"23"'));
    }, () => owner.close());
  }));
}

test("S4 最终观察审计：原断言和 close 失败不跳过审计，删除前保留全部异常", async () => fixture(async (file, dir) => {
  const { observation, owner, close } = await lateReaderFixture(dir, file, "query");
  const original = new Error("original assertion"), closeFailure = new Error("controlled close failure");
  let deleted = false;
  await withCleanup(async () => {
    await owner.message("held");
    const memory = (await owner.message("injection"))["memory"] as MemoryInjection;
    const database = { kind: "sqlite" as const, sqlitePath: file };
    assert.equal(await observation.assertInjection(memory, [], database), "budget-degraded");
    await assert.rejects(withCleanup(async () => { throw original; },
      () => observation.closeAndAudit(database, async () => {
        const db = new Database(file); try { db.exec("DROP TABLE memory_documents"); } finally { db.close(); }
        owner.child.send({ type: "release" }); await owner.message("late-error"); throw closeFailure;
      }, close), async () => { await rm(dir, { recursive: true, force: true }); deleted = true; }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
      const cleanup = error.errors[1]; assert.ok(cleanup instanceof AggregateError);
      assert.equal(cleanup.errors.length, 2); assert.equal(cleanup.errors[0], closeFailure);
      assert.ok(cleanup.errors[1] instanceof assert.AssertionError);
      assert.match(cleanup.errors[1].message, /"phase":"query-error"/); return true;
    });
    assert.equal(deleted, true);
  }, () => owner.close());
}));

test("S4-AC01 helper：不同 cwd 的真实 ready 后读回规范 descriptor 的本人记忆", async () => fixture(async (file, dir) => {
  const legacy = path.join(dir, "legacy"); await mkdir(legacy); await symlink(file, path.join(legacy, "agent-studio.db"));
  const configFile = path.join(dir, "explicit.json"); await writeFile(configFile, JSON.stringify({ dataDir: legacy }));
  const identity = await stat(file, { bigint: true });
  for (const name of ["http-cwd", "stdio-cwd"]) {
    const cwd = path.join(dir, name); await mkdir(cwd);
    const config = await loadConfig({ cwd, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: configFile } });
    const database = config.environment!.databaseDescriptor;
    assert.equal(database.kind, "sqlite");
    assert.deepEqual(safeReaderDatabase(database), { kind: "sqlite", sqlitePath: await realpath(file), sourcePath: path.join(legacy, "agent-studio.db"),
      identity: { device: String(identity.dev), inode: String(identity.ino) } });
    const helper = await realHelper(dir, cwd);
    try {
      await helper.message("probe-loaded");
      helper.child.send({ type: "init", database, config: DEFAULT_MEMORY_CONFIG });
      await helper.message("ready"); // 真实初始化完成是本用例的前提，不要求首次尽力注入一定成功。
      const input = { nonce: randomUUID(), memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: name };
      helper.child.send({ type: "read", ...input });
      const response = await helper.message("result");
      const result = response["result"] as MemoryInjection;
      assert.deepEqual({ ...response, result: undefined }, { type: "result", ...input, result: undefined });
      assert.equal(result.state, "available"); assert.deepEqual(result.errors, []);
      assert.deepEqual(result.entries.map(entry => [entry.scope, entry.documentId, entry.version, entry.markdown]),
        [["global", "g", 1, "global private"], ["project-agent", "p", 1, "own project"]]);
      assert.deepEqual(await readdir(cwd), []);
    } finally { await helper.close(); }
  }
}));

for (const change of ["move", "replace", "retarget"] as const) {
  test(`S4-AC01 helper：descriptor 解析后 ${change} 被真实子进程拒绝，不创建替代库`, async () => fixture(async (file, dir) => {
    const legacy = path.join(dir, "legacy"), cwd = path.join(dir, "other-cwd"); await mkdir(legacy); await mkdir(cwd);
    const source = path.join(legacy, "agent-studio.db"); await symlink(file, source);
    const config = await loadConfig({ cwd, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: legacy } });
    const database = config.environment!.databaseDescriptor;
    const moved = path.join(dir, "moved.sqlite"); await rename(file, moved);
    if (change === "replace") await copyFile(moved, file);
    if (change === "retarget") { await rm(source); await symlink(moved, source); }
    const helper = await realHelper(dir, cwd);
    try {
      await helper.message("probe-loaded");
      const names = await readdir(dir), original = await readFile(moved);
      const replacement = change === "replace" ? await readFile(file) : null;
      helper.child.send({ type: "init", database, config: DEFAULT_MEMORY_CONFIG });
      assert.deepEqual(await helper.message("error"), { type: "error", code: "memory_reader_query_failed" });
      assert.equal(helper.messages.some(message => message["type"] === "ready"), false);
      assert.deepEqual(await readdir(dir), names); assert.deepEqual(await readFile(moved), original);
      if (replacement) assert.deepEqual(await readFile(file), replacement);
      else await assert.rejects(stat(file), { code: "ENOENT" });
      assert.deepEqual(await readdir(cwd), []);
    } finally { await helper.close(); }
  }));
}

test("R-P4-S-003：真实 ready 被事件门控时保留500ms降级，迟到正文不回填且熔断不增生reader", async t => fixture(async (file, dir) => {
  const helper = await realHelper(dir, dir, true);
  let reader: ReturnType<typeof createMemoryInjectionReader> | undefined;
  try {
    await helper.message("probe-loaded"); // 先安装生产 IPC 监听，不能把 init 丢失伪装成慢启动。
    const diagnostics: string[] = []; let spawns = 0;
    reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG,
      onDiagnostic: code => diagnostics.push(code), spawnChild: () => { spawns++; return helper.child; } });
    const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "held-ready" };
    const began = performance.now(), pending = reader.readOwn(input);
    await helper.message("probe-ready-held");
    const result = await pending;
    assert.deepEqual(diagnostics, ["memory_reader_timeout"]);
    assert.equal(result.state, "unavailable"); assert.deepEqual(result.entries, []);
    assert.deepEqual(result.errors, [{ scope: "global", code: "memory_reader_timeout" }, { scope: "project-agent", code: "memory_reader_timeout" }]);
    assert.equal(helper.messages.some(message => message["type"] === "result"), false);
    t.diagnostic(JSON.stringify({ readerBudgetMs: 500, observedWaitMs: performance.now() - began, diagnostic: diagnostics[0] }));
    helper.child.send({ type: "probe-release-ready" }); // 只在真实 deadline 已观测后放行，无固定 sleep。
    const late = (await helper.message("result"))["result"] as MemoryInjection;
    assert.equal(late.state, "available"); assert.deepEqual(late.errors, []);
    assert.deepEqual(late.entries.map(entry => entry.markdown), ["global private", "own project"]);
    assert.equal(await pending, result); assert.deepEqual(result.entries, []);
    const next = await reader.readOwn({ ...input, bindingGeneration: "after-late-result" });
    assert.equal(next.state, "unavailable"); assert.deepEqual(next.entries, []);
    assert.deepEqual(next.errors, [{ scope: "global", code: "memory_reader_circuit_open" }, { scope: "project-agent", code: "memory_reader_circuit_open" }]);
    assert.equal(spawns, 1);
  } finally { await reader?.close(); await helper.close(); }
}));

test("S4 注入断言：完整timeout证据才允许降级，异owner及介入query/协议/进程错误仍失败", () => {
  const database = { kind: "sqlite" as const, sqlitePath: "/fixture/selected.sqlite" };
  const timeout: MemoryInjection = { state: "unavailable", entries: [], maxBytes: 8192,
    errors: [{ scope: "global", code: "memory_reader_timeout" }, { scope: "project-agent", code: "memory_reader_timeout" }] };
  const events: ReaderPhase[] = [
    { phase: "fork", owner: 10, reader: "10/1", atMs: 1 },
    { phase: "init", owner: 10, reader: "10/1", atMs: 2, database },
    { phase: "timer-fired", owner: 10, reader: "10/1", atMs: 502, budgetMs: 500 },
  ];
  const confirmed = new Set<string>();
  assert.equal(assertInjectionContract(timeout, [], events, database, confirmed), "budget-degraded");
  const circuit = { ...timeout, errors: timeout.errors.map(error => ({ ...error, code: "memory_reader_circuit_open" })) };
  assert.equal(assertInjectionContract(circuit, [], events, database, confirmed), "budget-degraded");
  assert.throws(() => assertInjectionContract(circuit, [], events, database, new Set(["20/1"])));
  assert.throws(() => assertInjectionContract(timeout, [], events.slice(0, 2), database, new Set()));
  for (const code of ["memory_reader_query_failed", "memory_binding_unavailable", "memory_reader_ipc_failed", "unexpected"]) {
    assert.throws(() => assertInjectionContract({ ...timeout, errors: [timeout.errors[0]!, { scope: "project-agent", code }] }, [], events, database, new Set()));
  }
  for (const phase of ["query-error", "ipc-error", "process-error", "exit", "result"]) {
    assert.throws(() => assertInjectionContract(circuit, [], [...events, { phase, owner: 10, reader: "10/1", atMs: 510 }], database, confirmed));
  }
});

test("AC-MEM-01/03：专属读取只选真实绑定Agent两层，成员撤销后不返回旧正文", async () => fixture(async file => {
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG });
  try {
    const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "1" };
    const result = await reader.readOwn(input);
    assert.equal(result.state, "available"); assert.deepEqual(result.entries.map(entry => entry.markdown), ["global private", "own project"]);
    assert.equal((await reader.readOwn({ ...input, projectId: "elsewhere" })).state, "unavailable");
    const db = new Database(file); db.prepare("UPDATE members SET status='disabled' WHERE id='member'").run(); db.close();
    assert.equal((await reader.readOwn(input)).state, "unavailable");
    assert.equal((await reader.readOwn(input)).entries.length, 0);
  } finally { await reader.close(); }
}));

test("AC-HARD：记忆 helper 单查询拒绝 removed 与恢复后旧成员 epoch", async () => fixture(async file => {
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG });
  const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "same-generation" };
  try {
    assert.equal((await reader.readOwn(input)).state, "available");
    const db = new Database(file);
    // status is deliberately still active: removed is an independent revocation fact.
    db.prepare("UPDATE members SET removed_at='2026-11-11T00:00:00Z',membership_revision=2 WHERE id='member'").run();
    assert.equal((await reader.readOwn({ ...input, membershipRevision: 2 })).state, "unavailable");
    db.prepare("UPDATE members SET removed_at=NULL,membership_revision=3 WHERE id='member'").run();
    assert.equal((await reader.readOwn(input)).state, "unavailable");
    assert.equal((await reader.readOwn({ ...input, membershipRevision: 3 })).state, "available");
    db.close();
    assert.equal((await reader.readOwn({ ...input, membershipRevision: undefined! })).errors[0]?.code, "memory_binding_unavailable");
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
    const batch = Array.from({ length: 20 }, (_, i) => reader.readOwn({ memberId: `m${i}`, projectId: "project", membershipRevision: 1, bindingGeneration: "1" }));
    await blocked;
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    const db = new Database(file); db.prepare("INSERT INTO messages VALUES('message','main flow continues')").run();
    await new Promise(resolve => setTimeout(resolve, 80)); clearInterval(timer);
    assert.ok(ticks >= 3); assert.equal((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c, 1); db.close();
    const results = await Promise.all(batch);
    assert.equal(results.filter(result => result.errors[0]?.code === "memory_reader_busy").length, 11);
    assert.equal(children.length, 1); assert.ok(results.every(result => result.state === "unavailable"));
    if (children[0]!.exitCode === null && children[0]!.signalCode === null) await once(children[0]!, "exit");
    const again = await reader.readOwn({ memberId: "new", projectId: "project", membershipRevision: 1, bindingGeneration: "2" });
    assert.equal(again.errors[0]?.code, "memory_reader_circuit_open"); assert.equal(children.length, 1);
  } finally { await reader.close(); }
}));

test("R-P4-S-003：同一绑定新代际取代排队/在途请求，旧回复不污染新会话", async () => fixture(async file => {
  const reader = createMemoryInjectionReader({ database: { kind: "sqlite", sqlitePath: file }, config: DEFAULT_MEMORY_CONFIG });
  try {
    const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "old" };
    const old = reader.readOwn(input); const fresh = reader.readOwn({ ...input, membershipRevision: 1, bindingGeneration: "new" });
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
    const result = await reader.readOwn({ memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "1" });
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
    const result = await reader.readOwn({ memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "1" });
    assert.equal(result.errors[0]?.code, "memory_reader_timeout"); await hardTimeout;
    assert.equal(children[0]!.exitCode, null); assert.equal(children[0]!.signalCode, null);
    assert.equal((await reader.readOwn({ memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "new" })).errors[0]?.code, "memory_reader_circuit_open");
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
    await admin.query(`CREATE TABLE members(id TEXT PRIMARY KEY,project_id TEXT,agent_id TEXT,kind TEXT,status TEXT,removed_at TEXT,membership_revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE memory_documents(id TEXT PRIMARY KEY,scope TEXT,project_id TEXT,agent_id TEXT,version INTEGER,markdown TEXT);
      INSERT INTO members(id,project_id,agent_id,kind,status) VALUES('member','project','agent','agent','active');
      INSERT INTO memory_documents VALUES('global','global',NULL,'agent',1,'private-global'),('project','project-agent','project','agent',1,'private-project');`);
    await body(admin, schema, url.toString(), schema);
  } finally {
    await admin.query("ROLLBACK"); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
}

for (const overrideUri of [false, true]) {
  function readerDatabase(connectionString: string, schema: string): { kind: "postgres"; connectionString: string; schema?: string } {
    if (!overrideUri) return { kind: "postgres", connectionString, schema };
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema} -c default_transaction_read_only=off -c lock_timeout=0`);
    url.searchParams.set("statement_timeout", "0");
    url.searchParams.set("lock_timeout", "0");
    // 不传 descriptor.schema，验证合法 URI search_path 被保留，而防护参数仍固定生效。
    return { kind: "postgres", connectionString: url.toString() };
  }
test(`postgres R-P4-S-003/C-S-001 URI override=${overrideUri}：真实 lock_timeout 结束查询，20次注入仅一个专属连接/子进程`, { skip: pgUnavailable }, async () => postgresReaderFixture(async (admin, schema, connectionString, name) => {
  const children: ChildProcess[] = [];
  const reader = createMemoryInjectionReader({ database: readerDatabase(connectionString, schema), config: DEFAULT_MEMORY_CONFIG,
    spawnChild: () => { const child = fork(fileURLToPath(new URL("../src/server/memory/injection-reader-child.ts", import.meta.url)), [],
      { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child); return child; } });
  const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "1" };
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

test(`postgres R-P4-S-003/C-S-001 URI override=${overrideUri}：实际 statement_timeout 与 readonly session 拒写`, { skip: pgUnavailable }, async () => postgresReaderFixture(async (admin, schema, connectionString) => {
  const input = { memberId: "member", projectId: "project", membershipRevision: 1, bindingGeneration: "1" };
  let reader = createMemoryInjectionReader({ database: readerDatabase(connectionString, schema), config: DEFAULT_MEMORY_CONFIG });
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
    reader = createMemoryInjectionReader({ database: readerDatabase(connectionString, schema), config: DEFAULT_MEMORY_CONFIG });
    assert.equal((await reader.readOwn(input)).errors[0]?.code, "memory_reader_query_failed");
    assert.equal(Number((await admin.query("SELECT COUNT(*) AS n FROM write_probe")).rows[0].n), 0, "生产只读session拒绝SELECT函数中的写入");
    await admin.query("BEGIN"); await admin.query("SELECT * FROM memory_documents");
    assert.ok(Number((await admin.query("SELECT COUNT(*) AS n FROM write_probe")).rows[0].n) > 0, "同一探针在可写连接确实会写，避免空测试");
    await admin.query("ROLLBACK");
  } finally { await reader.close(); }
}));
}

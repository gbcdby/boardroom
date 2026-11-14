import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { verifyStorageDrainReceipt } from "../src/server/storage/source-client.ts";

const logger = createLogger({ level: "error", write() {} });
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 500; i += 1) { if (check()) return; await delay(10); }
  assert.fail(message);
}
async function ownedChildren(parentPid: number) {
  const found: { pid: number; startTicks: string }[] = [];
  for (const entry of await readdir("/proc")) if (/^\d+$/.test(entry)) {
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
      if (Number(fields[1]) === parentPid && fields[19]) found.push({ pid: Number(entry), startTicks: fields[19] });
    } catch { /* A concurrently exited process is not an observed live child. */ }
  }
  return found;
}
function enterDrain(db: Database.Database) {
  db.prepare(`UPDATE storage_maintenance SET admission='draining',fence_epoch=1,owner_generation=1,
    active_migration_id='entrypoint-fixture',plan_digest=?,control_root_json='{}',mutex_identity_json='{}',
    journal_record_ref='fixture',journal_digest=?,journal_sequence=1`).run("a".repeat(64), "b".repeat(64));
}
function stdioProcess(dir: string) {
  const child = spawn(process.execPath, [path.resolve("src/server/mcp/stdio.ts")], {
    cwd: dir, env: { PATH: process.env.PATH, AGENT_STUDIO_DATA_DIR: dir, AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_LOG_LEVEL: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "", buffered = "", id = 0, invalidStdout = false;
  const replies = new Map<number, (result: any) => void>();
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffered += chunk;
    for (let end; (end = buffered.indexOf("\n")) >= 0;) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const value = JSON.parse(line); if (value.id !== undefined) { replies.get(value.id)?.(value); replies.delete(value.id); } }
      catch { invalidStdout = true; }
    }
  });
  return { child, exited, get stderr() { return stderr; }, get invalidStdout() { return invalidStdout; },
    notify(method: string) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); },
    async call(method: string, params: unknown): Promise<any> {
      const next = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(next); reject(new Error(`stdio response missing: ${method}`)); }, 5000);
        replies.set(next, value => { clearTimeout(timer); resolve(value); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
      });
    },
    async close() { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } },
  };
}

test("#152 真实HTTP/独立stdio/reader共同停新、断连和关闭；取消只由新client恢复", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-entrypoint-drain-"));
  let server: RunningServer = await startServer({ config: { port: 0, dataDir: dir, configFile: null,
    heartbeat: { intervalMs: 1000, timeoutMs: 3000 } }, logger });
  const control = new Database(path.join(dir, "agent-studio.db"));
  const stdio = stdioProcess(dir);
  try {
    const repos = createRepositories(server.database);
    const project = await repos.projects.create({ name: "真实维护" });
    const group = await repos.groups.create({ projectId: project.id, name: "stdio群" });
    const init = await stdio.call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "drain-test", version: "1" } });
    assert.ok(init.result); stdio.notify("notifications/initialized");
    const joined = await stdio.call("tools/call", { name: "join", arguments: { displayName: "stdio本人", hostType: "other", projectId: project.id, groupId: group.id } });
    assert.equal(joined.result.structuredContent.context.memory.state, "available", "实际reader应已启动读取");
    const beforeClients = control.prepare("SELECT * FROM storage_source_clients ORDER BY entrypoint").all() as Record<string, unknown>[];
    assert.deepEqual(beforeClients.map(r => r.entrypoint), ["http", "stdio"]);
    const stdioIdentity = JSON.parse(String(beforeClients[1]!.process_identity_json));
    assert.equal(stdioIdentity.pid, stdio.child.pid);
    const readers = process.platform === "linux" ? await ownedChildren(stdio.child.pid!) : [];
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${stdio.child.pid}/stat`, "utf8");
      assert.equal(stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], stdioIdentity.startTicks);
      assert.ok(readers.length > 0, "真实stdio记忆reader应有当前自有子进程");
    }
    const originalClient = server.storageClient.clientId;
    enterDrain(control);
    const refused = await fetch(`${server.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"不应创建"}' });
    assert.equal(refused.status, 503); assert.equal((await refused.json() as any).error, "storage_maintenance");
    await server.storageClient.waitForDrain();
    await until(() => Number((control.prepare("SELECT count(*) n FROM storage_source_clients WHERE drain_state='drained'").get() as any).n) === 2,
      `stdio没有真实收束: ${stdio.stderr}`);
    const [code, signal] = await stdio.exited;
    assert.equal(code, 0, stdio.stderr); assert.equal(signal, null); assert.equal(stdio.invalidStdout, false);
    if (process.platform === "linux") {
      await until(() => readers.every(({ pid, startTicks }) => {
        try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] !== startTicks; }
        catch { return !existsSync(`/proc/${pid}`); }
      }), "真实memory reader未退出");
      assert.equal(existsSync(`/proc/${stdio.child.pid}`), false);
      t.diagnostic(JSON.stringify({ proof: "linux_proc_and_child_exit", stdioExited: true, readersExited: readers.length,
        sourceClientIdentityMatched: true, memoryReturned: "available" }));
    }
    const state = control.prepare("SELECT database_instance_id FROM storage_maintenance").get() as any;
    for (const row of control.prepare("SELECT * FROM storage_source_clients").all() as Record<string, unknown>[]) {
      verifyStorageDrainReceipt(row, { databaseInstanceId: state.database_instance_id, fenceEpoch: 1, ownerGeneration: 1,
        migrationId: "entrypoint-fixture", planDigest: "a".repeat(64) });
    }
    assert.equal((control.prepare("SELECT state FROM mcp_sessions").get() as any).state, "disconnected");
    assert.equal((control.prepare("SELECT count(*) n FROM memory_summary_requests").get() as any).n, 0);
    assert.equal((control.prepare("SELECT count(*) n FROM projects").get() as any).n, 1);
    control.exec("UPDATE storage_maintenance SET admission='sealed'");
    const diagnostic = await fetch(`${server.url}/api/storage-maintenance`);
    assert.equal(diagnostic.status, 503); assert.equal((await diagnostic.json() as any).status, "drained");
    await assert.rejects(startServer({ config: { port: 0, dataDir: dir, configFile: null, heartbeat: { intervalMs: 1000, timeoutMs: 3000 } }, logger }),
      { code: "storage_maintenance" });
    const rejectedStdio = stdioProcess(dir);
    try {
      const [rejectedCode] = await rejectedStdio.exited; assert.equal(rejectedCode, 1);
      assert.match(rejectedStdio.stderr, /storage_maintenance/); assert.equal(rejectedStdio.invalidStdout, false);
    } finally { await rejectedStdio.close(); }
    control.exec("UPDATE storage_maintenance SET admission='open',fence_epoch=2,active_migration_id=NULL,plan_digest=NULL");
    await server.storageClient.refresh();
    await assert.rejects(server.storageClient.run(async () => {}), /epoch_changed/);
    server = await server.reopenAfterMaintenance();
    assert.notEqual((control.prepare("SELECT ended_at FROM storage_source_clients WHERE client_id=?").get(originalClient) as any).ended_at, null);
    assert.notEqual(server.storageClient.clientId, originalClient); assert.equal(server.storageClient.identity.fenceEpoch, 2);
    assert.equal((await fetch(`${server.url}/api/projects`)).status, 200);
    assert.equal((await createRepositories(server.database).projects.get(project.id))!.name, "真实维护");
  } finally { await stdio.close(); await server.close(); control.close(); await rm(dir, { recursive: true, force: true }); }
});

test("#152 已接纳但未读完HTTP body的请求必须真正结束，不能提前发布drain回执", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-http-inflight-"));
  const server = await startServer({ config: { port: 0, dataDir: dir, configFile: null, heartbeat: { intervalMs: 1000, timeoutMs: 3000 } }, logger });
  const control = new Database(path.join(dir, "agent-studio.db"));
  const response = new Promise<number>((resolve, reject) => {
    const req = request(`${server.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" } }, res => {
      res.resume(); res.once("end", () => resolve(res.statusCode!));
    }); req.on("error", reject); req.write('{"name":"');
    void (async () => {
      await delay(30); enterDrain(control); await server.storageClient.refresh(); await delay(30);
      assert.equal((control.prepare("SELECT drain_receipt_digest d FROM storage_source_clients").get() as any).d, null);
      req.end('late"}');
    })().catch(reject);
  });
  try {
    const status = await response; assert.ok(status >= 400);
    await server.storageClient.waitForDrain();
    assert.equal((control.prepare("SELECT count(*) n FROM projects").get() as any).n, 0);
  } finally { await server.close(); control.close(); await rm(dir, { recursive: true, force: true }); }
});

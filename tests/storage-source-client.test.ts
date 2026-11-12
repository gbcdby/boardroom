import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createMcpSessionsHandler } from "../src/server/mcp/transport.ts";
import { createLogger } from "../src/server/logger.ts";
import { databaseForConnectedReader } from "../src/server/environment.ts";
import { registerStorageSourceClient, storageReceiptDigest, verifyStorageDrainReceipt } from "../src/server/storage/source-client.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function drain(db: Database.Database) {
  db.prepare(`UPDATE storage_maintenance SET admission='draining',fence_epoch=1,owner_generation=1,
    active_migration_id='fixture',plan_digest=?,control_root_json='{}',mutex_identity_json='{}',
    journal_record_ref='fixture',journal_digest=?,journal_sequence=1`).run("a".repeat(64), "b".repeat(64));
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "br-source-client-"));
  const db = new SqliteDriver({ dataDir: dir }); await db.connect(); await db.migrate(migrations);
  // Match the resolver contract even when tmpdir() contains a directory alias.
  const database = databaseForConnectedReader({ kind: "sqlite", dataDir: realpathSync(dir),
    sqlitePath: realpathSync(db.file), sourcePath: db.file, identity: null });
  const control = new Database(db.file);
  const client = await registerStorageSourceClient({ db, database, entrypoint: "http" });
  return { dir, db, database, control, client, async close() {
    await client.close().catch(() => {}); control.close(); await db.close(); await rm(dir, { recursive: true, force: true });
  } };
}

test("#152 client停新并等待真实在途工作，回执只能在业务连接关闭后发布", async () => {
  const f = await fixture(); const running = deferred(); const finish = deferred(); let paused = false; let disconnected = false;
  try {
    await f.client.bind({ stopNewWork() { paused = true; },
      async disconnectSessions() { disconnected = true; await f.db.exec("UPDATE projects SET name=name"); },
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; },
      async observeOwnedExit() { throw new Error("no_owned_process"); }, async closeMemory() {} });
    const work = f.client.run(async () => { running.resolve(); await finish.promise; }); await running.promise;
    drain(f.control); await f.client.refresh(); await turn();
    assert.equal(paused, true); assert.equal(disconnected, true);
    assert.equal(f.client.diagnostic.status, "draining");
    assert.equal((f.control.prepare("SELECT drain_receipt_digest AS d FROM storage_source_clients").get() as { d: unknown }).d, null);
    await assert.rejects(f.client.run(async () => {}), /storage_maintenance/);
    await assert.rejects(f.db.exec("UPDATE projects SET name='forbidden'"), /storage_maintenance/);
    finish.resolve(); await work;
    const receipt = await f.client.waitForDrain();
    assert.deepEqual(receipt.quiescence, { activeTransactions: 0, activeJobs: 0, openFileWriters: 0, businessConnectionsClosed: true });
    assert.throws(() => f.db.handle, /尚未 connect/);
    const row = f.control.prepare("SELECT * FROM storage_source_clients").get() as Record<string, unknown>;
    assert.equal(row.drain_state, "drained"); assert.equal(row.drain_receipt_digest, storageReceiptDigest(receipt));
    const expected = { databaseInstanceId: receipt.databaseInstanceId, fenceEpoch: 1, ownerGeneration: 1,
      migrationId: receipt.migrationId, planDigest: receipt.planDigest };
    assert.deepEqual(verifyStorageDrainReceipt(row, expected), receipt);
    assert.throws(() => verifyStorageDrainReceipt(row, { ...expected, ownerGeneration: 2 }), /drain_receipt_invalid/);
    assert.throws(() => verifyStorageDrainReceipt(row, { ...expected, planDigest: "c".repeat(64) }), /drain_receipt_invalid/);
    const nativeReceipt = { ...receipt, buildId: "boardroom-native-management-v1", entrypoint: "local-management",
      nativeTransactions: { committed: 1, rolledBack: 2, notAdmitted: 3 } };
    const nativeRow = { ...row, build_id: nativeReceipt.buildId, entrypoint: nativeReceipt.entrypoint,
      db_sessions_json: JSON.stringify({ ...JSON.parse(String(row.db_sessions_json)), drainReceipt: nativeReceipt }),
      drain_receipt_digest: storageReceiptDigest(nativeReceipt) };
    assert.deepEqual(verifyStorageDrainReceipt(nativeRow, expected), nativeReceipt);
    f.control.exec("UPDATE storage_maintenance SET admission='sealed'");
    const frozen = f.control.prepare("SELECT * FROM storage_source_clients").get();
    await f.client.refresh(); await f.client.close();
    assert.deepEqual(f.control.prepare("SELECT * FROM storage_source_clients").get(), frozen, "sealed后不能刷新封存回执");
  } finally { finish.resolve(); await f.close(); }
});

test("#152 close失败保留draining；不生成完成回执，重复drain不重复执行生命周期", async () => {
  const f = await fixture(); let calls = 0;
  try {
    await f.client.bind({ stopNewWork() {}, async disconnectSessions() {},
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() {},
      async closeMemory() { calls += 1; throw new Error("synthetic_file_handle_still_open"); } });
    drain(f.control); await f.client.refresh();
    await assert.rejects(f.client.waitForDrain(), /drain_incomplete/); await f.client.refresh();
    assert.equal(calls, 1); assert.equal(f.client.diagnostic.status, "blocked");
    const row = f.control.prepare("SELECT drain_state,drain_receipt_digest FROM storage_source_clients").get();
    assert.deepEqual(row, { drain_state: "draining", drain_receipt_digest: null });
  } finally { await f.close(); }
});

test("#152 source替换拒绝控制回执且不生成新空库；坏/旧回执拒绝", async () => {
  const f = await fixture();
  try {
    await rename(path.join(f.dir, "agent-studio.db"), path.join(f.dir, "moved.db"));
    await assert.rejects(f.client.refresh(), { code: "storage_source_changed" });
    assert.equal(f.client.diagnostic.status, "blocked");
    assert.throws(() => verifyStorageDrainReceipt({ db_sessions_json: "{}" }, { databaseInstanceId: "a".repeat(32), fenceEpoch: 1, ownerGeneration: 1,
      migrationId: "fixture", planDigest: "a".repeat(64) }), /drain_receipt_invalid/);
  } finally { await f.close(); }
});

test("#152 真实MCP断连持久化失败向维护传播，不能保留connected却发布drained", async () => {
  const f = await fixture(); const repos = createRepositories(f.db);
  const core = createMcpCore({ db: f.db, repos, logger: createLogger({ level: "error", write() {} }) });
  try {
    const project = await repos.projects.create({ name: "断连失败" });
    const group = await repos.groups.create({ projectId: project.id, name: "群" });
    await core.join("session", { displayName: "自己", hostType: "other", projectId: project.id, groupId: group.id });
    repos.mcpSessions.disconnect = async () => { throw new Error("synthetic_disconnect_write_failed"); };
    await f.client.bind({ stopNewWork() {},
      async disconnectSessions() { await core.close({ drain: true }); await core.disconnect({ strict: true }); },
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() {}, async closeMemory() {} });
    drain(f.control); await f.client.refresh();
    await assert.rejects(f.client.waitForDrain(), /drain_incomplete/);
    assert.equal((f.control.prepare("SELECT state FROM mcp_sessions").get() as any).state, "connected");
    assert.equal((f.control.prepare("SELECT drain_receipt_digest d FROM storage_source_clients").get() as any).d, null);
  } finally { await core.close(); await f.close(); }
});

test("#152 普通HTTP关闭保留既有容错，后续strict关闭仍暴露缓存失败且不发布回执", async () => {
  const f = await fixture();
  const handler = createMcpSessionsHandler({ db: f.db, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
    logger: createLogger({ level: "error", write() {} }) });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      if (!await handler.handle(request, response, text ? JSON.parse(text) : undefined)) response.end();
    } catch { response.statusCode = 500; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
  const client = new Client({ name: "close-failure", version: "1" });
  try {
    await f.client.bind({ stopNewWork() {}, disconnectSessions: () => handler.close({ strict: true }),
      async stopOwnedRuntime() { return { ownedExits: [], unknownOwners: [] }; }, async observeOwnedExit() {}, async closeMemory() {} });
    const repos = createRepositories(f.db);
    const project = await repos.projects.create({ name: "关闭缓存" });
    const group = await repos.groups.create({ projectId: project.id, name: "群" });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const joined = await client.callTool({ name: "join", arguments: { displayName: "自己", hostType: "other", projectId: project.id, groupId: group.id } });
    assert.notEqual(joined.isError, true);
    f.control.exec(`CREATE TRIGGER fail_disconnect BEFORE UPDATE OF state ON mcp_sessions
      WHEN NEW.state='disconnected' BEGIN SELECT RAISE(ABORT,'synthetic_disconnect_write_failed'); END`);
    await handler.close();
    assert.equal((f.control.prepare("SELECT state FROM mcp_sessions").get() as any).state, "connected");
    await assert.rejects(handler.close({ strict: true }), /mcp_http_close_incomplete/);
    drain(f.control); await f.client.refresh();
    await assert.rejects(f.client.waitForDrain(), /drain_incomplete/);
    assert.equal((f.control.prepare("SELECT drain_receipt_digest d FROM storage_source_clients").get() as any).d, null);
  } finally {
    await client.close(); await handler.close().catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close();
  }
});

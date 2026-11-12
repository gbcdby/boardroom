import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { runMigrations } from "../src/server/db/migrate.ts";
import { migrations } from "../src/server/db/migrations/index.ts";

const root = path.resolve(import.meta.dirname, "..");
const databaseUrl = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
const admissionUrl = new URL("../src/server/storage/native-management-admission.ts", import.meta.url).href;
const helperUrl = new URL("../src/server/db/migrate-host-type.ts", import.meta.url).href;

async function fixture(body: (db: Database.Database, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-native-concurrency-"));
  const db = new Database(path.join(dir, "agent-studio.db"), { timeout: 0 });
  try {
    db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
    runMigrations(db, migrations);
    db.prepare("INSERT INTO agents(id,display_name,host_type,created_at,updated_at) VALUES('old','legacy','other','t','t')").run();
    await body(db, dir);
  } finally { if (db.open) db.close(); await rm(dir, { recursive: true, force: true }); }
}

function beginMaintenance(db: Database.Database): void {
  // Narrow controller fixture; no claim about D's production journal or full inventory.
  db.prepare(`UPDATE storage_maintenance SET admission='draining',fence_epoch=fence_epoch+1,owner_generation=1,
    active_migration_id='fixture-maintenance',plan_digest=?,control_root_json='{}',mutex_identity_json='{}',
    journal_record_ref='fixture-record',journal_digest=?,journal_sequence=1 WHERE singleton=1`).run("a".repeat(64), "b".repeat(64));
}

function launch(args: string[], dir: string): {
  child: ChildProcess;
  held: Promise<Record<string, unknown>>;
  completed: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, args, { cwd: dir,
    env: { PATH: process.env["PATH"], BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 15_000, killSignal: "SIGKILL" });
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", data => { stdout += String(data); });
  child.stderr!.on("data", data => { stderr += String(data); });
  const held = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on("message", message => { if ((message as Record<string, unknown>).type === "held") resolve(message as Record<string, unknown>); });
    child.once("error", reject);
    child.once("close", (code, signal) => reject(new Error(`child_before_hold:${code}:${signal}:${stderr}`)));
  });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, held, completed };
}

function holdCode(release: string): string {
  return `const release = ${JSON.stringify(release)};
const pause = new Int32Array(new SharedArrayBuffer(4));
function hold(inTransaction) {
  process.send({type:'held',inTransaction});
  const deadline = Date.now() + 10000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('test_release_timeout');
    Atomics.wait(pause, 0, 0, 10);
  }
}`;
}

test("#152 native 真实 CLI：登记后暂停、controller 提交 draining，helper 事务拒绝而非沿用预检 open", async () => fixture(async (db, dir) => {
  const release = path.join(dir, "release");
  const preload = path.join(dir, "pause-cli.mjs");
  await writeFile(preload, `import {existsSync} from 'node:fs';
${holdCode(release)}
const log = console.log;
console.log = (...args) => { log(...args); if (String(args[0]).startsWith('模式：执行')) hold(false); };
`);
  const run = launch(["--import", preload, path.join(root, "scripts/migrate-other-to-dsh.ts"), "--data-dir", dir], dir);
  let result;
  try {
    await run.held;
    const registered = db.prepare("SELECT entrypoint,ended_at FROM storage_source_clients").all();
    assert.deepEqual(registered, [{ entrypoint: "local-management", ended_at: null }]);
    beginMaintenance(db);
  } finally {
    await writeFile(release, "continue");
    result = await run.completed;
  }
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /\[storage_maintenance\]/);
  assert.deepEqual(db.prepare("SELECT host_type FROM agents").all(), [{ host_type: "other" }]);
  assert.deepEqual(db.prepare("SELECT * FROM agent_legacy_aliases").all(), []);
  const row = db.prepare("SELECT drain_state,drain_epoch,ended_at,db_sessions_json FROM storage_source_clients").get() as Record<string, unknown>;
  assert.equal(row.drain_state, "drained"); assert.equal(row.drain_epoch, 1);
  assert.equal(typeof row.ended_at, "string");
  assert.deepEqual(JSON.parse(String(row.db_sessions_json)).drainReceipt.nativeTransactions,
    { committed: 0, rolledBack: 0, notAdmitted: 1 });
}));

test("#152 native CLI：写已提交但关闭回执失败时不报整次完成，保留未收束 client", async () => fixture(async (db, dir) => {
  const preload = path.join(dir, "fail-receipt.mjs");
  await writeFile(preload, `import Database from ${JSON.stringify(databaseUrl)};
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (/UPDATE storage_source_clients SET/.test(sql)) statement.run = () => { throw new Error('fixture_receipt_failed'); };
  return statement;
};
`);
  const result = spawnSync(process.execPath, ["--import", preload, path.join(root, "scripts/migrate-other-to-dsh.ts"), "--data-dir", dir], {
    cwd: dir, env: { PATH: process.env["PATH"], BOARDROOM_HOME: path.join(dir, "home") }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes("迁移完成。"), false);
  assert.deepEqual(db.prepare("SELECT host_type FROM agents").all(), [{ host_type: "dsh" }], "提交事实保留，不把回执失败伪称业务回滚");
  assert.deepEqual(db.prepare("SELECT ended_at,drain_receipt_digest FROM storage_source_clients").get(),
    { ended_at: null, drain_receipt_digest: null });
}));

for (const outcome of ["commit", "rollback"] as const) test(
  `#152 native 真实子进程：已接纳写事务持真实锁直到 ${outcome}，controller 不得提前 draining`,
  async () => fixture(async (db, dir) => {
    const release = path.join(dir, "release");
    const preload = path.join(dir, "hold-transaction.mjs");
    await writeFile(preload, `import Database from ${JSON.stringify(databaseUrl)};
import {existsSync} from 'node:fs';
${holdCode(release)}
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function(sql) {
  const statement = prepare.call(this, sql);
  if (/UPDATE agents SET host_type/.test(sql)) {
    const owner = this;
    const run = statement.run;
    statement.run = function(...args) {
      const result = run.apply(this, args);
      hold(owner.inTransaction);
      if (${JSON.stringify(outcome)} === 'rollback') throw new Error('fixture_after_real_update');
      return result;
    };
  }
  return statement;
};
`);
    const script = path.join(dir, "migrate-child.mjs");
    await writeFile(script, `import {statSync} from 'node:fs';
import {openNativeManagementSource} from ${JSON.stringify(admissionUrl)};
import {migrateOtherToDsh} from ${JSON.stringify(helperUrl)};
const sqlitePath = ${JSON.stringify(path.join(dir, "agent-studio.db"))};
const stat = statSync(sqlitePath, {bigint:true});
const lease = await openNativeManagementSource({mode:'write',source:{kind:'sqlite',dataDir:${JSON.stringify(dir)},
  sourcePath:sqlitePath,sqlitePath,identity:{device:String(stat.dev),inode:String(stat.ino)}}});
try {
  const report = migrateOtherToDsh(lease);
  console.log(JSON.stringify({report}));
} catch (error) {
  if (error.message !== 'fixture_after_real_update') throw error;
  console.log(JSON.stringify({rolledBack:true}));
} finally { await lease.close(); }
`);
    const run = launch(["--import", preload, script], dir);
    let result;
    try {
      const held = await run.held;
      assert.equal(held.inTransaction, true);
      assert.deepEqual(db.prepare("SELECT host_type FROM agents").all(), [{ host_type: "other" }], "未提交数据对另一个连接不可见");
      assert.deepEqual(db.prepare("SELECT ended_at FROM storage_source_clients").all(), [{ ended_at: null }]);
      assert.throws(() => beginMaintenance(db), (error: unknown) => (error as { code: string }).code === "SQLITE_BUSY");
      assert.deepEqual(db.prepare("SELECT admission,fence_epoch FROM storage_maintenance").get(), { admission: "open", fence_epoch: 0 });
    } finally {
      await writeFile(release, "continue");
      result = await run.completed;
    }
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr);
    if (outcome === "commit") {
      assert.equal(JSON.parse(result.stdout).report.changedAgents, 1);
      assert.deepEqual(db.prepare("SELECT host_type FROM agents").all(), [{ host_type: "dsh" }]);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_legacy_aliases").get() as { n: number }).n, 2);
    } else {
      assert.equal(JSON.parse(result.stdout).rolledBack, true);
      assert.deepEqual(db.prepare("SELECT host_type FROM agents").all(), [{ host_type: "other" }]);
      assert.deepEqual(db.prepare("SELECT * FROM agent_legacy_aliases").all(), []);
    }
    const client = db.prepare("SELECT * FROM storage_source_clients").get() as Record<string, unknown>;
    assert.equal(typeof client.ended_at, "string");
    assert.deepEqual(JSON.parse(String(client.db_sessions_json)).sessions[0].nativeTransactions,
      { committed: outcome === "commit" ? 1 : 0, rolledBack: outcome === "rollback" ? 1 : 0, notAdmitted: 0 });
    beginMaintenance(db);
    assert.deepEqual(db.prepare("SELECT admission,fence_epoch FROM storage_maintenance").get(), { admission: "draining", fence_epoch: 1 });
  }),
);

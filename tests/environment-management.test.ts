import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { createDbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";

const root = path.resolve(import.meta.dirname, "..");
function run(script: string, cwd: string, env: NodeJS.ProcessEnv, args: string[] = [], preload?: string) {
  return spawnSync(process.execPath, [...preload ? ["--import", preload] : [], path.join(root, "scripts", script), ...args], {
    cwd, env: { PATH: process.env["PATH"], ...env }, encoding: "utf8", timeout: 15_000,
  });
}
async function fixture(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-management-"));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("S4 管理命令: PostgreSQL 配置不能回落 SQLite，拒绝时无新目录/文件", async () => fixture(async dir => {
  const config = path.join(dir, "config.json"); const secret = "never-print-this-password";
  await writeFile(config, JSON.stringify({ dbDriver: "postgres", pgConnectionString: `postgres://user:${secret}@localhost:1/example` }));
  const before = await readdir(dir);
  const result = run("migrate-other-to-dsh.ts", dir, { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config }, ["--dry-run"]);
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  assert.match(result.stderr, /SQLite/); assert.equal((result.stderr + result.stdout).includes(secret), false);
  assert.deepEqual(await readdir(dir), before);
}));

test("S4 管理命令: --data-dir 覆盖配置，dry-run 只读既有 SQLite 实际文件", async () => fixture(async dir => {
  const selected = path.join(dir, "selected"); const override = path.join(dir, "override");
  for (const [dataDir, count] of [[selected, 1], [override, 2]] as const) {
    const db = createDbDriver({ dataDir }); await db.connect(); await db.migrate(migrations);
    try {
      const repos = createRepositories(db);
      for (let i = 0; i < count; i++) await repos.agents.create({ displayName: `old-${i}`, hostType: "other" });
    } finally { await db.close(); }
  }
  const actual = path.join(override, "source.sqlite"); await rename(path.join(override, "agent-studio.db"), actual);
  await symlink(actual, path.join(override, "agent-studio.db"));
  const config = path.join(dir, "config.json"); await writeFile(config, JSON.stringify({ dataDir: selected }));
  const guard = path.join(dir, "readonly-guard.mjs");
  await writeFile(guard, `import Database from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href)};
const transaction = Database.prototype.transaction;
Database.prototype.transaction = function(fn) {
  if (!this.readonly || this.pragma('query_only', {simple:true}) !== 1) throw new Error('dry_run_not_readonly');
  return transaction.call(this, fn);
};`);
  const before = await readFile(actual); const names = await readdir(override);
  const result = run("migrate-other-to-dsh.ts", dir, { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config }, ["--data-dir", override, "--dry-run"], guard);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agents 改写（other→dsh）：2/);
  assert.ok(result.stdout.includes(actual));
  assert.deepEqual(await readFile(actual), before);
  // 此既有 SQL 预览允许 SQLite 的正常 WAL 协调，不宣称文件系统零写入；新源清单另作零写入验收。
  assert.deepEqual((await readdir(override)).filter(name => name !== "source.sqlite-wal" && name !== "source.sqlite-shm"), names);
  const check = new Database(actual, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(check.prepare("SELECT host_type FROM agents ORDER BY display_name").all(), [{ host_type: "other" }, { host_type: "other" }]); }
  finally { check.close(); }
  assert.equal((await readdir(dir)).includes("data"), false);
}));

test("S4 管理 dry-run: 读取已提交的 WAL 内容，不把 immutable 主文件快照当真实数据", async () => fixture(async dir => {
  const dataDir = path.join(dir, "source"); const db = createDbDriver({ dataDir });
  try {
    await db.connect(); await db.migrate(migrations);
    const repos = createRepositories(db);
    await repos.agents.create({ displayName: "checkpointed", hostType: "other" });
    await db.query("PRAGMA wal_checkpoint(TRUNCATE)");
    await repos.agents.create({ displayName: "only-in-wal", hostType: "other" });
    const main = path.join(dataDir, "agent-studio.db");
    const before = await readFile(main);
    assert.ok((await readFile(`${main}-wal`)).length > 32);
    const result = run("migrate-other-to-dsh.ts", dir, { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: dataDir }, ["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agents 改写（other→dsh）：2/);
    assert.deepEqual(await readFile(main), before);
    assert.deepEqual(await db.query("SELECT host_type FROM agents ORDER BY display_name"), [{ host_type: "other" }, { host_type: "other" }]);
  } finally { await db.close(); }
}));

test("S4 管理命令: fresh/missing 源不能被 dry-run 初始化", async () => fixture(async dir => {
  const result = run("migrate-other-to-dsh.ts", dir, { BOARDROOM_HOME: path.join(dir, "home") }, ["--dry-run"]);
  assert.equal(result.status, 1); assert.match(result.stderr, /legacy_migration_required/);
  assert.deepEqual(await readdir(dir), []);
}));

test("S4 inspect-storage CLI: PG 配置和未知字段脱敏，运行前后目录一致", async () => fixture(async dir => {
  const secret = "inspection-secret-canary";
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({ dbDriver: "postgres", pgConnectionString: `postgres://u:${secret}@127.0.0.1:1/db`, customSecret: secret }));
  const result = run("inspect-storage.ts", dir, { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: config });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const inventory = JSON.parse(result.stdout);
  assert.equal(inventory.sources[0].database.verification, "configuration_only");
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.deepEqual(await readdir(dir), ["config.json"]);
}));

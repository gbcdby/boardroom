import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PlanPreview } from "../scripts/storage-maintenance.ts";

const cli = fileURLToPath(new URL("../scripts/storage-maintenance.ts", import.meta.url));
const secret = "plan-cli-private-canary-DO-NOT-PRINT";
function environment(config: string, home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_STUDIO_") || key === "BOARDROOM_HOME" || key === "NODE_OPTIONS") delete env[key];
  return { ...env, AGENT_STUDIO_CONFIG: config, BOARDROOM_HOME: home };
}
function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, forbidOrdinaryDriver = false) {
  const guard = `
    import { SqliteDriver } from ${JSON.stringify(new URL("../src/server/db/drivers/sqlite.ts", import.meta.url).href)};
    import { PostgresDriver } from ${JSON.stringify(new URL("../src/server/db/drivers/postgres.ts", import.meta.url).href)};
    for (const Driver of [SqliteDriver, PostgresDriver]) for (const method of ["connect", "migrate"])
      Driver.prototype[method] = async () => { throw new Error("ordinary-driver-is-forbidden-in-plan"); };
  `;
  const preloads = forbidOrdinaryDriver ? ["--import", `data:text/javascript,${encodeURIComponent(guard)}`] : [];
  const result = spawnSync(process.execPath, [...preloads, cli, ...args], { cwd, env, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("P152-PLAN-06: 非 plan 与非法参数在读取坏配置前拒绝，且错误不泄漏输入", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-plan-cli-args-"));
  try {
    const config = path.join(dir, "config.json");
    await writeFile(config, `{broken:${secret}`);
    const env = environment(config, path.join(dir, "home"));
    const valid = ["plan", "--expected-source-id", "not-observed", "--control-root", path.join(dir, "control"), "--target-root", path.join(dir, "target")];
    for (const args of [[], ["execute"], ["resume"], ["cancel"], ["persist"], ["inspectMigration"], ["plan"],
      [...valid, "--unknown", secret], [...valid, "--target-root", path.join(dir, "other")],
      ["plan", "--expected-source-id", "x", "--control-root", "relative", "--target-root", path.join(dir, "target")]]) {
      const result = run(args, dir, env);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^\[config_invalid\] 用法：/);
      for (const value of [secret, config, dir, "Error:", " at "]) assert.ok(!result.stderr.includes(value));
    }
    const malformed = run(valid, dir, env);
    assert.equal(malformed.status, 1); assert.equal(malformed.stdout, "");
    assert.match(malformed.stderr, /^\[config_invalid\] 无法完成/);
    for (const value of [secret, config, dir, "Error:", " at "]) assert.ok(!malformed.stderr.includes(value));
    assert.deepEqual(await readdir(dir), ["config.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function sqliteFixture() {
  const [{ default: Database }, { runMigrations }, { migrations }, { resolveBoardroomEnvironment }, { readSqliteManifests }] = await Promise.all([
    import("better-sqlite3"), import("../src/server/db/migrate.ts"), import("../src/server/db/migrations/index.ts"),
    import("../src/server/environment.ts"), import("../src/server/storage/maintenance/sqlite-manifests.ts"),
  ]);
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-plan-cli-sqlite-"));
  const dataDir = path.join(dir, "data"), file = path.join(dataDir, "agent-studio.db"), config = path.join(dir, "config.json");
  await mkdir(dataDir);
  const writer = new Database(file);
  try {
    writer.exec("CREATE TABLE plan_cli_observation(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    runMigrations(writer, migrations);
    writer.pragma("journal_mode=WAL"); writer.pragma("wal_autocheckpoint=0");
    writer.prepare("INSERT INTO plan_cli_observation VALUES(?,?)").run("checkpointed", "old row");
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.prepare("INSERT INTO plan_cli_observation VALUES(?,?)").run("wal-only", secret);
    await writeFile(config, JSON.stringify({ dataDir, dbDriver: "sqlite", pgConnectionString: `postgres://unused:${secret}@unused.invalid/not-a-source` }), { mode: 0o600 });
    const env = environment(config, path.join(dir, "home"));
    const resolved = await resolveBoardroomEnvironment({ cwd: dir, env });
    assert.equal(resolved.startupState, "legacy_found");
    assert.ok(resolved.inventory.selectedSourceId);
    const control = path.join(dataDir, "maintenance-control"), target = path.join(dir, "target");
    const args = ["plan", "--expected-source-id", resolved.inventory.selectedSourceId, "--control-root", control, "--target-root", target];
    return { dir, dataDir, file, config, env, writer, resolved, control, target, args,
      logical: () => readSqliteManifests(writer),
      async close() { writer.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { writer.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}

function readPreview(stdout: string): PlanPreview {
  const value = JSON.parse(stdout) as PlanPreview;
  assert.deepEqual(Object.keys(value).sort(), ["formatVersion", "command", "result", "observationMode", "persisted", "executionAuthorized",
    "source", "observedAt", "tableCounts", "requiredCapabilities", "blockers"].sort());
  assert.deepEqual(Object.keys(value.source).sort(), ["databaseKind", "sourceId"]);
  assert.equal(value.formatVersion, 1); assert.equal(value.command, "plan"); assert.equal(value.result, "preview");
  assert.equal(value.observationMode, "logical_read_only"); assert.equal(value.persisted, false); assert.equal(value.executionAuthorized, false);
  assert.ok(Number.isFinite(Date.parse(value.observedAt)));
  assert.ok(Object.values(value.tableCounts).every(count => typeof count === "string" && /^[0-9]+$/.test(count)));
  assert.ok(value.requiredCapabilities.includes("source-files-inventory"));
  for (const blocker of value.blockers) assert.deepEqual(Object.keys(blocker).sort(), ["code", "subjectRef"]);
  return value;
}
async function assertNoArtifacts(f: Awaited<ReturnType<typeof sqliteFixture>>) {
  for (const file of [f.control, f.target, path.join(f.dir, "home")]) await assert.rejects(stat(file), { code: "ENOENT" });
}
const platformTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;

platformTest("P152-PLAN-01/02/05: 真实 SQLite CLI 读到已提交 WAL，保留全部逻辑值且只输出安全预览", async () => {
  const f = await sqliteFixture();
  try {
    const before = f.logical(), files = await readdir(f.dataDir);
    assert.ok((await stat(`${f.file}-wal`)).size > 0);
    const otherCwd = path.join(f.dir, "other-cwd"); await mkdir(otherCwd);
    for (const cwd of [f.dir, otherCwd]) {
      const result = run(f.args, cwd, f.env, true);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
      const preview = readPreview(result.stdout);
      assert.deepEqual(preview.source, { sourceId: f.resolved.inventory.selectedSourceId, databaseKind: "sqlite" });
      assert.equal(preview.tableCounts.plan_cli_observation, "2");
      assert.ok(preview.blockers.some(blocker => blocker.code === "source_writer_unknown"), "真实仍持有源的父进程不能被预览称为已停止");
      for (const hidden of [secret, f.dir, "postgres://", "configDigest", "clientInventory", "sourceIdentity", "immutablePlan", "snapshot_ready"])
        assert.ok(!result.stdout.includes(hidden), hidden);
      assert.deepEqual(f.logical(), before);
      assert.deepEqual(await readdir(f.dataDir), files);
      await assertNoArtifacts(f);
    }
  } finally { await f.close(); }
});

platformTest("P152-PLAN-04: 错来源与保护路径严格拒绝，不修复、不建计划或空目标库", async () => {
  const f = await sqliteFixture();
  try {
    const before = f.logical();
    const wrongSource = [...f.args]; wrongSource[2] = `wrong-${secret}`;
    const protectedTarget = [...f.args]; protectedTarget[6] = path.join(f.resolved.runtimeRoot, "new-target");
    const protectedControl = [...f.args]; protectedControl[4] = path.join(f.resolved.workspacesRoot, "control");
    for (const [args, code] of [[wrongSource, "source_changed"], [protectedTarget, "target_conflict"], [protectedControl, "control_root_mismatch"]] as const) {
      const result = run(args, f.dir, f.env, true);
      assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(result.stderr.startsWith(`[${code}]`), result.stderr);
      assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes(f.dir));
      assert.deepEqual(f.logical(), before); await assertNoArtifacts(f);
    }
  } finally { await f.close(); }
});

platformTest("P152-PLAN-01/04: 绝对目录别名支持只读预览，仍拒绝源重叠与控制目标碰撞", async () => {
  const f = await sqliteFixture();
  try {
    const alias = path.join(f.dir, "location-alias");
    await symlink(await realpath(f.dir), alias, "dir");
    const args = [...f.args], before = f.logical();
    args[4] = path.join(alias, "data", "maintenance-control");
    args[6] = path.join(alias, "future-target", "missing-tail");
    const result = run(args, f.dir, f.env, true);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const preview = readPreview(result.stdout);
    assert.equal(preview.source.sourceId, f.resolved.inventory.selectedSourceId);
    assert.equal(preview.tableCounts.plan_cli_observation, "2");
    assert.ok(!result.stdout.includes(alias));
    assert.deepEqual(f.logical(), before);
    await assert.rejects(stat(path.join(f.dir, "future-target")), { code: "ENOENT" });
    const protectedTarget = [...args]; protectedTarget[6] = path.join(alias, "data", "agent-studio.db");
    const collision = [...args]; collision[6] = args[4]!;
    for (const [input, code] of [[protectedTarget, "target_conflict"], [collision, "control_root_mismatch"]] as const) {
      const rejected = run(input, f.dir, f.env, true);
      assert.equal(rejected.status, 1); assert.equal(rejected.stdout, "");
      assert.ok(rejected.stderr.startsWith(`[${code}]`), rejected.stderr);
      assert.deepEqual(f.logical(), before); await assertNoArtifacts(f);
    }
  } finally { await f.close(); }
});

platformTest("P152-PLAN-04: 预检 ID 对应的源缺失或被替换时，CLI 不创建或接纳替代源", async t => {
  for (const replaced of [false, true]) await t.test(replaced ? "replaced" : "missing", async () => {
    const f = await sqliteFixture();
    try {
      const moved = `${f.file}.moved`;
      await rename(f.file, moved);
      if (replaced) await copyFile(moved, f.file);
      const result = run(f.args, f.dir, f.env, true);
      assert.equal(result.status, 1); assert.equal(result.stdout, "");
      assert.match(result.stderr, /^\[(source_missing|source_changed|legacy_migration_required)\]/);
      if (!replaced) await assert.rejects(stat(f.file), { code: "ENOENT" });
      await assertNoArtifacts(f);
    } finally { await f.close(); }
  });
});

platformTest("P152-PLAN-04: 坏 guard 保持拒绝，不执行 schema 迁移或修复", async () => {
  const f = await sqliteFixture();
  try {
    const guard = f.writer.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'br_storage_%' LIMIT 1").get() as { name: string };
    f.writer.exec(`DROP TRIGGER "${guard.name.replaceAll('"', '""')}"`);
    const snapshot = () => ({ schema: f.writer.prepare("SELECT * FROM sqlite_schema ORDER BY type,name").all(),
      control: f.writer.prepare("SELECT * FROM storage_maintenance").all(), clients: f.writer.prepare("SELECT * FROM storage_source_clients").all(),
      data: f.writer.prepare("SELECT * FROM plan_cli_observation ORDER BY id").all() });
    const before = snapshot(), result = run(f.args, f.dir, f.env, true);
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[(schema_guard_incomplete|migration_incomplete)\]/);
    assert.deepEqual(snapshot(), before); await assertNoArtifacts(f);
  } finally { await f.close(); }
});

platformTest("P152-PLAN-01/04: 多个隐式旧源拒绝；明确 data-dir 后仍核原 source ID", async () => {
  const f = await sqliteFixture();
  try {
    const { default: Database } = await import("better-sqlite3");
    const otherCwd = path.join(f.dir, "other-source"), otherData = path.join(otherCwd, "data");
    await mkdir(otherData, { recursive: true });
    const other = new Database(path.join(otherData, "agent-studio.db"));
    try { other.exec("CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('other source')"); }
    finally { other.close(); }
    await rm(f.config);
    const env = { ...f.env }; delete env["AGENT_STUDIO_CONFIG"];
    const args = [...f.args, "--legacy-cwd", otherCwd], before = f.logical();
    const ambiguous = run(args, f.dir, env, true);
    assert.equal(ambiguous.status, 1); assert.equal(ambiguous.stdout, "");
    assert.match(ambiguous.stderr, /^\[storage_source_ambiguous\]/);
    const selected = run([...args, "--data-dir", f.dataDir], f.dir, env, true);
    assert.equal(selected.status, 0, selected.stderr); assert.equal(selected.stderr, "");
    const result = readPreview(selected.stdout);
    assert.equal(result.source.sourceId, f.resolved.inventory.selectedSourceId);
    assert.equal(result.tableCounts.plan_cli_observation, "2");
    assert.deepEqual(f.logical(), before); await assertNoArtifacts(f);
  } finally { await f.close(); }
});

platformTest("P152-PLAN-03/05: PG 配置拒绝不会回落已有 SQLite 或泄漏连接输入", async () => {
  const f = await sqliteFixture();
  try {
    const before = f.logical();
    await writeFile(f.config, JSON.stringify({ dataDir: f.dataDir, dbDriver: "postgres", pgConnectionString: secret }), { mode: 0o600 });
    const { resolveBoardroomEnvironment } = await import("../src/server/environment.ts");
    const selected = await resolveBoardroomEnvironment({ cwd: f.dir, env: f.env });
    assert.equal(selected.databaseDescriptor.kind, "postgres"); assert.ok(selected.inventory.selectedSourceId);
    const args = [...f.args]; args[2] = selected.inventory.selectedSourceId;
    const result = run(args, f.dir, f.env, true);
    assert.equal(result.status, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[source_missing\]/); assert.ok(!result.stderr.includes(secret)); assert.ok(!result.stderr.includes(f.dir));
    assert.deepEqual(f.logical(), before); await assertNoArtifacts(f);
  } finally { await f.close(); }
});

const testUrl = process.env["AGENT_STUDIO_PG_TEST_URL"];
test("P152-PLAN-03: 真实 PG16 CLI 只读预览，无登记/schema 改写且实际 backend 收束", {
  skip: testUrl ? false : "AGENT_STUDIO_PG_TEST_URL 未配置；真实 PG CLI NOT_RUN", timeout: 60_000,
}, async () => {
  if (!testUrl) throw new Error("PG test requires an explicit test database");
  const [{ Client }, { PostgresDriver }, { migrations }, { createPostgresMaintenanceAdapter }, { resolveBoardroomEnvironment }] = await Promise.all([
    import("pg"), import("../src/server/db/drivers/postgres.ts"), import("../src/server/db/migrations/index.ts"),
    import("../src/server/storage/maintenance/postgres.ts"), import("../src/server/environment.ts"),
  ]);
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-plan-cli-pg-")), databaseName = `br_m152_plan_${randomUUID().replaceAll("-", "")}`;
  const sourceUrl = new URL(testUrl); sourceUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: testUrl });
  const driver = new PostgresDriver({ connectionString: sourceUrl.toString() });
  let created = false, adapter: Awaited<ReturnType<typeof createPostgresMaintenanceAdapter>> | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`); created = true;
    await driver.connect(); await driver.migrate(migrations);
    await driver.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,$2,$3,$4)", ["plan-cli", secret, "t", "t"]);
    await driver.close();
    const dataDir = path.join(dir, "data"), config = path.join(dir, "config.json"), control = path.join(dataDir, "control"), target = path.join(dir, "target");
    await mkdir(dataDir);
    await writeFile(config, JSON.stringify({ dataDir, dbDriver: "postgres", pgConnectionString: sourceUrl.toString() }), { mode: 0o600 });
    const env = environment(config, path.join(dir, "home"));
    const resolved = await resolveBoardroomEnvironment({ cwd: dir, env }); assert.ok(resolved.inventory.selectedSourceId);
    adapter = await createPostgresMaintenanceAdapter({ kind: "postgres", connectionString: sourceUrl.toString() }, undefined);
    const before = await adapter.observe();
    const result = run(["plan", "--expected-source-id", resolved.inventory.selectedSourceId, "--control-root", control, "--target-root", target], dir, env, true);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    const preview = readPreview(result.stdout);
    assert.deepEqual(preview.source, { sourceId: resolved.inventory.selectedSourceId, databaseKind: "postgres" });
    assert.equal(preview.tableCounts.projects, "1");
    for (const hidden of [secret, sourceUrl.toString(), dir]) assert.ok(!result.stdout.includes(hidden));
    assert.deepEqual(await adapter.observe(), before);
    assert.equal((await admin.query("SELECT count(*)::text AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1", [databaseName])).rows[0]?.count, "0");
    for (const file of [control, target, path.join(dir, "home"), path.join(dataDir, "agent-studio.db")])
      await assert.rejects(stat(file), { code: "ENOENT" });
  } finally {
    await adapter?.close(); await driver.close();
    try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
    finally { await admin.end(); await rm(dir, { recursive: true, force: true }); }
  }
});

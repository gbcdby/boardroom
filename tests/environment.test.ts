import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, symlink, rename, link, stat, readlink, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { databaseDriverOptions, inspectLegacyStorage, resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { loadConfig } from "../src/server/config.ts";
import { createDbDriver } from "../src/server/db/driver.ts";

async function fixture<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-env-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("S4 resolver: 未激活布局保留 fresh v1 的 cwd/data，新路径仅 planned 且解析不写目录", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); await mkdir(cwd);
    const homeRoot = path.join(dir, "boardroom");
    const env = await resolveBoardroomEnvironment({ cwd, env: { BOARDROOM_HOME: homeRoot } });
    assert.equal(env.layoutVersion, 1);
    assert.equal(env.startupState, "fresh");
    assert.equal(env.config.dataDir, path.join(await realpath(cwd), "data"));
    assert.equal(env.runtimeRoot, path.join(await realpath(cwd), "data/managed"));
    assert.equal(env.paths.runtime.status, "legacy");
    assert.equal(env.paths.skills.status, "planned");
    assert.equal(env.paths.memory.status, "planned");
    assert.equal(env.paths.workspaces.status, "planned");
    assert.equal(env.paths.workspaces.protected, false);
    assert.equal(env.paths.state.protected, true);
    assert.equal(env.storageId, null);
    assert.equal(env.writable, true);
    assert.deepEqual(await readdir(dir), ["cwd"]);
  });
});

test("S4 SQLite: 使用 DB symlink 的真实非默认文件名，连接前移动/替换/改链不能创建替代库", async () => {
  await fixture(async dir => {
    const actualDir = path.join(dir, "actual");
    const seeded = await seed(actualDir, "exact-original");
    const actual = path.join(actualDir, "original.sqlite"); await rename(seeded, actual);
    const legacy = path.join(dir, "legacy"); await mkdir(legacy);
    const link = path.join(legacy, "agent-studio.db"); await symlink(actual, link);
    const options = { cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: legacy } };
    const resolved = await resolveBoardroomEnvironment(options);
    assert.equal(resolved.config.dataDir, await realpath(legacy));
    assert.equal(resolved.databaseDescriptor.kind, "sqlite");
    assert.equal(resolved.databaseDescriptor.kind === "sqlite" && resolved.databaseDescriptor.sqlitePath, await realpath(actual));
    const driver = createDbDriver(databaseDriverOptions(resolved));
    try { await driver.connect(); assert.deepEqual(await driver.query("SELECT name FROM evidence"), [{ name: "exact-original" }]); }
    finally { await driver.close(); }
    assert.equal((await readdir(actualDir)).includes("agent-studio.db"), false);

    const beforeMove = await resolveBoardroomEnvironment(options);
    await rename(actual, path.join(actualDir, "moved.sqlite"));
    const moved = createDbDriver(databaseDriverOptions(beforeMove));
    await assert.rejects(moved.connect(), { code: "storage_source_changed" });
    assert.equal((await readdir(actualDir)).includes("original.sqlite"), false);
    await seed(actualDir, "replacement");
    await rename(path.join(actualDir, "agent-studio.db"), actual);
    const replaced = createDbDriver(databaseDriverOptions(beforeMove));
    await assert.rejects(replaced.connect(), { code: "storage_source_changed" });

    const beforeLink = await resolveBoardroomEnvironment(options);
    await rm(link); await symlink(path.join(actualDir, "moved.sqlite"), link);
    const switched = createDbDriver(databaseDriverOptions(beforeLink));
    await assert.rejects(switched.connect(), { code: "storage_source_changed" });
  });
});

async function seed(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "agent-studio.db");
  const db = new Database(file);
  try { db.pragma("journal_mode = WAL"); db.exec("CREATE TABLE evidence (name TEXT NOT NULL)"); db.prepare("INSERT INTO evidence VALUES (?)").run(name); }
  finally { db.close(); }
  return file;
}

function readInDriverProcess(options: ReturnType<typeof databaseDriverOptions>): { rows?: unknown[]; code?: string; recoveryAction?: string } {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const { createDbDriver } = await import(process.argv[1]);
    const driver = createDbDriver(JSON.parse(process.argv[2]));
    try {
      await driver.connect();
      process.stdout.write(JSON.stringify({ rows: await driver.query("SELECT name FROM evidence ORDER BY rowid") }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, recoveryAction: error.recoveryAction }));
    } finally { await driver.close(); }
  `, new URL("../src/server/db/driver.ts", import.meta.url).href, JSON.stringify(options)], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("S4 STD001: 硬链接主库与 WAL 可能分裂，来源预检拒绝选择且文件不变", async () => {
  await fixture(async dir => {
    const originalCwd = path.join(dir, "original"); const originalDir = path.join(originalCwd, "data");
    const aliasDir = path.join(dir, "hardlink"); await mkdir(originalDir, { recursive: true }); await mkdir(aliasDir);
    const originalFile = path.join(originalDir, "agent-studio.db"); const aliasFile = path.join(aliasDir, "agent-studio.db");
    const original = new Database(originalFile);
    try {
      original.pragma("journal_mode = WAL");
      original.exec("CREATE TABLE evidence(name TEXT); INSERT INTO evidence VALUES('checkpointed')");
      original.pragma("wal_checkpoint(TRUNCATE)");
      await link(originalFile, aliasFile);
      original.exec("INSERT INTO evidence VALUES('committed-only-in-original-wal')");
      assert.equal((await stat(originalFile)).nlink, 2);
      const beforeNames = await readdir(originalDir); const before = await Promise.all(beforeNames.map(name => readFile(path.join(originalDir, name))));
      const options = { cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: aliasDir }, knownLegacyCwds: [originalCwd] };
      const resolved = await resolveBoardroomEnvironment(options);
      assert.equal(resolved.startupState, "recovery_required");
      assert.equal(resolved.writable, false);
      assert.equal(resolved.inventory.sources.length, 2, "不同规范文件名的 WAL 来源不能按 inode 合并");
      assert.ok(resolved.inventory.sources.every(source => source.linkCount === "2"));
      assert.equal(resolved.diagnostics[0]?.code, "storage_source_ambiguous");
      assert.match(resolved.diagnostics[0]?.recoveryAction ?? "", /WAL/);
      await assert.rejects(loadConfig(options), { code: "storage_source_ambiguous" });
      assert.deepEqual(await inspectLegacyStorage(options), resolved.inventory);
      const onlyKnownAlias = await resolveBoardroomEnvironment({ ...options, knownLegacyCwds: [] });
      assert.equal(onlyKnownAlias.inventory.sources.length, 1);
      assert.equal(onlyKnownAlias.writable, false, "未发现另一个名字也不能绕过实际硬链接数");
      assert.equal(onlyKnownAlias.diagnostics[0]?.code, "storage_source_ambiguous");
      assert.deepEqual(await readdir(originalDir), beforeNames);
      assert.deepEqual(await Promise.all(beforeNames.map(name => readFile(path.join(originalDir, name)))), before);
      assert.deepEqual(await readdir(aliasDir), ["agent-studio.db"]);
      assert.deepEqual(await readdir(dir), ["hardlink", "original"]);
      assert.deepEqual(original.prepare("SELECT name FROM evidence ORDER BY rowid").all(), [
        { name: "checkpointed" }, { name: "committed-only-in-original-wal" },
      ]);
    } finally { original.close(); }
  });
});

test("S4 STD001: 解析后新增硬链接，descriptor 和旧驱动入口连接前均拒绝", async () => {
  await fixture(async dir => {
    const originalDir = path.join(dir, "original"); const originalFile = await seed(originalDir, "checkpointed");
    const resolved = await resolveBoardroomEnvironment({ cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: originalDir } });
    assert.equal(resolved.writable, true);
    const aliasDir = path.join(dir, "hardlink"); await mkdir(aliasDir);
    const aliasFile = path.join(aliasDir, "agent-studio.db"); await link(originalFile, aliasFile);
    for (const options of [databaseDriverOptions(resolved), { dataDir: aliasDir }, { dataDir: aliasDir, sqlitePath: aliasFile }]) {
      const result = readInDriverProcess(options);
      assert.equal(result.code, "storage_source_ambiguous");
      assert.match(result.recoveryAction ?? "", /WAL/);
      assert.equal(result.rows, undefined);
    }
    assert.deepEqual(await readdir(originalDir), ["agent-studio.db"]);
    assert.deepEqual(await readdir(aliasDir), ["agent-studio.db"]);
    assert.equal((await stat(originalFile)).nlink, 2);
  });
});

test("S4 STD001: 普通 symlink 仍共用真实 WAL，独立进程读到已提交的两行", async () => {
  await fixture(async dir => {
    const originalCwd = path.join(dir, "original"); const originalDir = path.join(originalCwd, "data");
    const aliasDir = path.join(dir, "symlink"); await mkdir(originalDir, { recursive: true }); await mkdir(aliasDir);
    const originalFile = path.join(originalDir, "agent-studio.db"); const aliasFile = path.join(aliasDir, "agent-studio.db");
    const original = new Database(originalFile);
    try {
      original.pragma("journal_mode = WAL");
      original.exec("CREATE TABLE evidence(name TEXT); INSERT INTO evidence VALUES('checkpointed')");
      original.pragma("wal_checkpoint(TRUNCATE)");
      await symlink(originalFile, aliasFile);
      original.exec("INSERT INTO evidence VALUES('committed-only-in-original-wal')");
      const resolved = await resolveBoardroomEnvironment({ cwd: dir,
        env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: aliasDir }, knownLegacyCwds: [originalCwd] });
      assert.equal(resolved.writable, true);
      assert.equal(resolved.inventory.sources.length, 1);
      assert.equal((await stat(originalFile)).nlink, 1);
      assert.deepEqual(readInDriverProcess(databaseDriverOptions(resolved)), { rows: [
        { name: "checkpointed" }, { name: "committed-only-in-original-wal" },
      ] });
      assert.deepEqual(await readdir(aliasDir), ["agent-studio.db"]);
    } finally { original.close(); }
  });
});

test("S4 STD002: 仅真正缺失的 journal 目录可忽略，悬挂链接要求恢复且不建目录", async () => {
  await fixture(async dir => {
    const home = path.join(dir, "home"); const state = path.join(home, "state"); await mkdir(state, { recursive: true });
    const options = { cwd: dir, env: { BOARDROOM_HOME: home } };
    assert.equal((await resolveBoardroomEnvironment(options)).startupState, "fresh");
    const missingTarget = path.join(dir, "missing-journal-root"); const journal = path.join(state, "migrations");
    await symlink(missingTarget, journal, "dir");
    const resolved = await resolveBoardroomEnvironment(options);
    assert.equal(resolved.startupState, "recovery_required");
    assert.equal(resolved.writable, false);
    assert.equal(resolved.diagnostics[0]?.code, "migration_incomplete");
    assert.ok(resolved.diagnostics[0]?.recoveryAction);
    await assert.rejects(loadConfig(options), { code: "migration_incomplete" });
    assert.deepEqual(await inspectLegacyStorage(options), resolved.inventory);
    assert.equal(await readlink(journal), missingTarget);
    assert.deepEqual(await readdir(state), ["migrations"]);
    assert.deepEqual(await readdir(dir), ["home"]);
  });
});

test("S4 STD002: 真实不可读的 journal 目录仍严格拒绝", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "需要非 root POSIX 权限" : false,
}, async () => {
  await fixture(async dir => {
    const home = path.join(dir, "home"); const journal = path.join(home, "state/migrations"); await mkdir(journal, { recursive: true });
    await chmod(journal, 0);
    try {
      await assert.rejects(loadConfig({ cwd: dir, env: { BOARDROOM_HOME: home } }), { code: "config_invalid" });
      assert.deepEqual(await readdir(path.dirname(journal)), ["migrations"]);
      assert.deepEqual(await readdir(dir), ["home"]);
    } finally { await chmod(journal, 0o700); }
  });
});

test("S4-AC02: 清单只读发现唯一旧库、多个不同旧库拒绝默开 fresh", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); await mkdir(cwd);
    const old = path.join(dir, "known-old");
    const file = await seed(path.join(old, "data"), "old-project");
    const before = await readFile(file); const names = await readdir(path.dirname(file));
    const options = { cwd, env: { BOARDROOM_HOME: path.join(dir, "home") }, knownLegacyCwds: [path.relative(cwd, old)] };
    const one = await inspectLegacyStorage(options);
    assert.equal(one.startupState, "legacy_found");
    assert.equal(one.sources.length, 1);
    assert.equal(one.sources[0]?.database.kind, "sqlite");
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(path.dirname(file)), names);
    await assert.rejects(loadConfig(options), { code: "legacy_migration_required" });
    await seed(path.join(cwd, "data"), "other-project");
    const two = await inspectLegacyStorage(options);
    assert.equal(two.startupState, "ambiguous");
    assert.equal(two.sources.length, 2);
    await assert.rejects(loadConfig(options), { code: "storage_source_ambiguous" });
    const check = new Database(file, { readonly: true, fileMustExist: true });
    try { assert.deepEqual(check.prepare("SELECT name FROM evidence").all(), [{ name: "old-project" }]); }
    finally { check.close(); }
    assert.deepEqual(await readdir(dir), ["cwd", "known-old"]);
  });
});

test("S4-AC02: 新目标 metadata/journal 不足以激活，显式旧选择也不能绕过恢复", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); await mkdir(cwd);
    const home = path.join(dir, "home"); await mkdir(path.join(home, "state/migrations"), { recursive: true });
    const oldDir = path.join(dir, "old"); await seed(oldDir, "preserved");
    const config = path.join(dir, "explicit.json"); await writeFile(config, JSON.stringify({ dataDir: oldDir }));
    const options = { cwd, env: { BOARDROOM_HOME: home, AGENT_STUDIO_CONFIG: config } };
    await writeFile(path.join(home, "state/storage.json"), JSON.stringify({ layoutVersion: 2, storageId: "store-A" }));
    const metadata = await inspectLegacyStorage(options);
    assert.equal(metadata.startupState, "recovery_required");
    await assert.rejects(loadConfig(options), { code: "migration_incomplete" });
    await writeFile(path.join(home, "state/migrations/one.json"), JSON.stringify({ phase: "db_activated" }));
    const interrupted = await inspectLegacyStorage(options);
    assert.equal(interrupted.startupState, "recovery_required");
    assert.ok(interrupted.diagnostics.some(d => d.code === "migration_incomplete"));
    await writeFile(config, JSON.stringify({ layoutVersion: 2, storageId: "store-B", dataDir: oldDir }));
    const mismatched = await inspectLegacyStorage(options);
    assert.ok(mismatched.diagnostics.some(d => d.code === "storage_root_mismatch"));
    await assert.rejects(loadConfig(options), { code: "storage_root_mismatch" });
  });
});

test("S4-AC01: 显式配置 > 用户根 > 旧 cwd；v1 相对数据保持启动 cwd，env 覆盖不重写 HOME", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); const home = path.join(dir, "home"); const files = path.join(dir, "configs");
    for (const directory of [cwd, home, files]) await mkdir(directory);
    const canonicalCwd = await realpath(cwd);
    await writeFile(path.join(cwd, "config.json"), JSON.stringify({ port: 4401, dataDir: "cwd-selected" }));
    await writeFile(path.join(home, "config.json"), JSON.stringify({ port: 4402, dataDir: "home-selected" }));
    const explicit = path.join(files, "explicit.json"); await writeFile(explicit, JSON.stringify({ port: 4403, dataDir: "old-relative" }));
    const homeBefore = process.env["HOME"];
    const base = { cwd, env: { BOARDROOM_HOME: home } };
    const fromHome = await loadConfig(base);
    assert.equal(fromHome.port, 4402); assert.equal(fromHome.dataDir, path.join(canonicalCwd, "home-selected"));
    await writeFile(path.join(cwd, "config.json"), "not selected JSON, must not override explicit selection");
    const selected = await loadConfig({ cwd, env: { BOARDROOM_HOME: home, AGENT_STUDIO_CONFIG: explicit } });
    assert.equal(selected.port, 4403); assert.equal(selected.dataDir, path.join(canonicalCwd, "old-relative"));
    const override = await loadConfig({ cwd, env: { BOARDROOM_HOME: home, AGENT_STUDIO_CONFIG: explicit,
      AGENT_STUDIO_DATA_DIR: "env-relative", AGENT_STUDIO_PORT: "4404" } });
    assert.equal(override.dataDir, path.join(canonicalCwd, "env-relative")); assert.equal(override.port, 4404);
    assert.equal(process.env["HOME"], homeBefore);
  });
});

test("S4-AC01: v2 相对文件资源按配置目录，仅返回 planned，匹配 metadata 也不伪造 active", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); const files = path.join(dir, "config-dir"); await mkdir(cwd); await mkdir(files);
    const canonicalFiles = await realpath(files);
    const file = path.join(files, "config.json");
    await writeFile(file, JSON.stringify({ layoutVersion: 2, storageId: "store-A", dataDir: "db", stateRoot: "state",
      memoryRoot: "mem", skillsRoot: "skills", runtimeRoot: "runtime", workspacesRoot: "workspaces", artifactsRoot: "artifacts" }));
    const options = { cwd, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: file } };
    const resolved = await resolveBoardroomEnvironment(options);
    assert.equal(resolved.config.dataDir, path.join(canonicalFiles, "db"));
    for (const [key, relative] of [["stateRoot", "state"], ["memoryRoot", "mem"], ["skillsRoot", "skills"], ["runtimeRoot", "runtime"], ["workspacesRoot", "workspaces"], ["artifactsRoot", "artifacts"]] as const) {
      assert.equal(resolved[key], path.join(canonicalFiles, relative));
    }
    assert.equal(resolved.storageId, "store-A"); assert.equal(resolved.writable, false);
    assert.ok(Object.values(resolved.paths).every(item => item.status === "planned"));
    await assert.rejects(loadConfig(options), { code: "legacy_migration_required" });
    assert.deepEqual(await readdir(files), ["config.json"]);
    await mkdir(path.join(files, "state"));
    await writeFile(path.join(files, "state/storage.json"), JSON.stringify({ layoutVersion: 2, storageId: "store-A", active: true }));
    assert.equal((await inspectLegacyStorage(options)).startupState, "recovery_required");
    const overridden = await resolveBoardroomEnvironment({ cwd, env: { ...options.env, AGENT_STUDIO_DATA_DIR: "v1-env-relative" } });
    assert.equal(overridden.config.dataDir, path.join(await realpath(cwd), "v1-env-relative"));
  });
});

test("S4-AC02: 显式已有旧源可以解开多个 legacy 源，新旧混存仍硬阻断", async () => {
  await fixture(async dir => {
    const old = path.join(dir, "old"); const cwd = path.join(dir, "cwd");
    await seed(old, "selected"); await seed(path.join(cwd, "data"), "other");
    const options = { cwd, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_DATA_DIR: old } };
    const config = await loadConfig(options);
    assert.equal(config.dataDir, await realpath(old)); assert.equal(config.environment?.startupState, "legacy_found");
    assert.equal(config.environment?.inventory.sources.length, 2);
    await seed(path.join(dir, "home/state"), "unverified-new");
    assert.equal((await inspectLegacyStorage(options)).startupState, "ambiguous");
    await assert.rejects(loadConfig(options), { code: "storage_source_ambiguous" });
  });
});

test("S4 PG: 清单只承诺配置存在，输出白名单不含连接串/未知配置字段", async () => {
  await fixture(async dir => {
    const file = path.join(dir, "config.json");
    const canary = "secret-canary-never-public";
    await writeFile(file, JSON.stringify({ dbDriver: "postgres", pgConnectionString: `postgres://user:${canary}@localhost:5432/example?password=${canary}`,
      password: canary, extra: { token: canary } }));
    const inventory = await inspectLegacyStorage({ cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: file } });
    assert.equal(inventory.startupState, "legacy_found");
    assert.deepEqual(Object.keys(inventory.sources[0]!.database).sort(), ["kind", "locationId", "verification"]);
    assert.equal(inventory.sources[0]!.database.kind === "postgres" && inventory.sources[0]!.database.verification, "configuration_only");
    assert.equal(JSON.stringify(inventory).includes(canary), false);
    assert.equal(JSON.stringify(inventory).includes("postgres://"), false);
  });
});

test("S4 配置: 显式空覆盖是错误，不得偷偷使用文件值或 SQLite 默认", async () => {
  await fixture(async dir => {
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ dataDir: "old", dbDriver: "postgres", pgConnectionString: "postgres://u:p@localhost/db" }));
    for (const name of ["AGENT_STUDIO_DATA_DIR", "AGENT_STUDIO_DB_DRIVER", "AGENT_STUDIO_PG_CONNECTION_STRING"]) {
      await assert.rejects(loadConfig({ cwd: dir, env: { BOARDROOM_HOME: path.join(dir, "home"), AGENT_STUDIO_CONFIG: file, [name]: "" } }), { code: "config_invalid" });
    }
    assert.deepEqual(await readdir(dir), ["config.json"]);
  });
});

test("S4 恢复: 不完整 storageId 配置、损坏 metadata、只有完成 journal 都不能冒充 fresh", async () => {
  await fixture(async dir => {
    const home = path.join(dir, "home"); await mkdir(path.join(home, "state/migrations"), { recursive: true });
    const config = path.join(dir, "config.json");
    const options = { cwd: dir, env: { BOARDROOM_HOME: home, AGENT_STUDIO_CONFIG: config } };
    await writeFile(config, JSON.stringify({ storageId: "partial-format" }));
    assert.equal((await inspectLegacyStorage(options)).startupState, "recovery_required");
    await assert.rejects(loadConfig(options), { code: "migration_incomplete" });
    await writeFile(config, "{}");
    await writeFile(path.join(home, "state/storage.json"), "{ broken metadata");
    assert.equal((await inspectLegacyStorage(options)).startupState, "recovery_required");
    await rm(path.join(home, "state/storage.json"));
    await writeFile(path.join(home, "state/migrations/done.json"), JSON.stringify({ phase: "completed" }));
    assert.equal((await inspectLegacyStorage(options)).startupState, "recovery_required");
    await assert.rejects(loadConfig(options), { code: "migration_incomplete" });
    await rm(path.join(home, "state/migrations/done.json"));
    await mkdir(path.join(home, "state/migrations/unknown-format"));
    assert.equal((await inspectLegacyStorage(options)).startupState, "recovery_required");
  });
});

test("S4 旧源: 真实文件别名去重；显式旧路径位于计划 state 也不能仅按目录升级格式", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); await seed(path.join(cwd, "data"), "one-source");
    const alias = path.join(dir, "alias"); await symlink(cwd, alias);
    const options = { cwd, env: { BOARDROOM_HOME: path.join(dir, "home") }, knownLegacyCwds: [alias] };
    const inventory = await inspectLegacyStorage(options);
    assert.equal(inventory.startupState, "legacy_found"); assert.equal(inventory.sources.length, 1);
    assert.ok(inventory.sources[0]!.locations.length > 1);
    const home = path.join(dir, "legacy-home"); const old = path.join(home, "state"); await seed(old, "legacy-state-dir");
    const config = await loadConfig({ cwd: dir, env: { BOARDROOM_HOME: home, AGENT_STUDIO_DATA_DIR: old } });
    assert.equal(config.environment?.layoutVersion, 1); assert.equal(config.environment?.startupState, "legacy_found");
  });
});

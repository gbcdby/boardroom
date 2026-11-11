import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { inspectLegacyStorage, resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { loadConfig } from "../src/server/config.ts";

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
    assert.equal(env.config.dataDir, path.join(cwd, "data"));
    assert.equal(env.runtimeRoot, path.join(cwd, "data/managed"));
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

async function seed(directory: string, name: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "agent-studio.db");
  const db = new Database(file);
  try { db.exec("CREATE TABLE evidence (name TEXT NOT NULL)"); db.prepare("INSERT INTO evidence VALUES (?)").run(name); }
  finally { db.close(); }
  return file;
}

test("S4-AC02: 清单只读发现唯一旧库、多个不同旧库拒绝默开 fresh", async () => {
  await fixture(async dir => {
    const cwd = path.join(dir, "cwd"); await mkdir(cwd);
    const old = path.join(dir, "known-old");
    const file = await seed(path.join(old, "data"), "old-project");
    const before = await readFile(file); const names = await readdir(path.dirname(file));
    const options = { cwd, env: { BOARDROOM_HOME: path.join(dir, "home") }, knownLegacyCwds: [old] };
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

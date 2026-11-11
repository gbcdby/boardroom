import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ownerActor } from "../src/server/authz/actors.ts";
import { BUSINESS_TABLES } from "../src/server/db/migrate-data.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { inspectWorkspaceRoot } from "../src/server/workspace/preflight.ts";
import { createWorkspaceService } from "../src/server/workspace/service.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

const access = { actor: ownerActor() };

async function sourceFixture() {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "boardroom-workspace-semantics-"));
  const source = await realpath(sourcePath);
  const lexicalRoot = path.join(source, "code"), actualRoot = path.join(source, "actual");
  await mkdir(lexicalRoot); await mkdir(path.join(actualRoot, "child"), { recursive: true });
  const alias = path.join(lexicalRoot, "link");
  await symlink(path.join(actualRoot, "child"), alias);
  // path.join(alias, "..") 会词法消去 link；测试必须原样提交操作系统处理的路径。
  const rawRoot = `${alias}${path.sep}..`;
  return { source, lexicalRoot, actualRoot, alias, rawRoot, close: () => rm(sourcePath, { recursive: true, force: true }) };
}

async function fixture(engine: typeof identityEngines[number]) {
  const f = await identityFixture(engine, 15), source = await sourceFixture();
  const environment = await resolveBoardroomEnvironment({ cwd: f.dir,
    env: { BOARDROOM_HOME: path.join(f.dir, "home"), AGENT_STUDIO_DATA_DIR: f.dir } });
  const service = createWorkspaceService({ repos: f.repos, environment });
  return { ...f, ...source, environment, service, async close() { await f.close(); await source.close(); } };
}

async function identity(directory: string) {
  const info = await stat(directory, { bigint: true });
  return { device: String(info.dev), inode: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}

async function allRows(db: DbDriver) {
  const result: Record<string, unknown> = {};
  for (const table of BUSINESS_TABLES) result[table.name] = await db.query(`SELECT * FROM ${table.name} ORDER BY ${table.keyColumns.join(", ")}`);
  return result;
}

async function protectedAlias(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(path.join(f.environment.skillsRoot, "child"), { recursive: true });
  await rm(f.alias); await symlink(path.join(f.environment.skillsRoot, "child"), f.alias);
  assert.equal(await realpath(f.rawRoot), await realpath(f.environment.skillsRoot));
  assert.notDeepEqual(await identity(f.rawRoot), await identity(f.lexicalRoot), "真实目录必须与词法父目录不同");
}

test("S3 路径正控制：普通 child/.. 保留原输入并解析现有父目录", async () => {
  const f = await sourceFixture();
  try {
    const environment = await resolveBoardroomEnvironment({ cwd: f.source, env: { BOARDROOM_HOME: path.join(f.source, "home") } });
    const rawRoot = `${path.join(f.actualRoot, "child")}${path.sep}..`;
    const observed = await inspectWorkspaceRoot(rawRoot, environment);
    assert.equal(observed.rootPath, rawRoot); assert.equal(observed.canonicalRoot, f.actualRoot);
    assert.deepEqual(observed.rootIdentity, await identity(f.actualRoot));
    assert.equal(observed.physicalResourceKey, (await inspectWorkspaceRoot(f.actualRoot, environment)).physicalResourceKey);
  } finally { await f.close(); }
});

test("R-BR-COLLAB-135-STD-001：合法 link/.. 的规范根、身份和 Git 观察使用同一实际目录", async () => {
  const f = await sourceFixture();
  const git = (...args: string[]) => { const result = spawnSync("git", args, { cwd: f.actualRoot, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  try {
    const environment = await resolveBoardroomEnvironment({ cwd: f.source, env: { BOARDROOM_HOME: path.join(f.source, "home") } });
    git("init", "-q"); await writeFile(path.join(f.actualRoot, "tracked.txt"), "same physical root\n"); git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const observed = await inspectWorkspaceRoot(f.rawRoot, environment), direct = await inspectWorkspaceRoot(f.actualRoot, environment);
    assert.equal(observed.rootPath, f.rawRoot);
    assert.deepEqual({ canonicalRoot: observed.canonicalRoot, rootIdentity: observed.rootIdentity,
      physicalResourceKey: observed.physicalResourceKey, repositoryInfo: observed.repositoryInfo },
    { canonicalRoot: await realpath(f.rawRoot), rootIdentity: await identity(f.actualRoot),
      physicalResourceKey: direct.physicalResourceKey, repositoryInfo: direct.repositoryInfo });
    assert.equal(observed.repositoryInfo?.kind, "git"); assert.equal(observed.repositoryInfo?.topLevel, f.actualRoot);
    assert.equal(observed.repositoryInfo?.head, git("rev-parse", "HEAD").trim());
    assert.equal(observed.repositoryInfo?.dirty, false);
  } finally { await f.close(); }
});

for (const engine of identityEngines) {
  test(`${engine} R-BR-COLLAB-135-STD-001：受保护 link/.. 在预检/保存/创建均拒绝，业务表逐值不变`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await protectedAlias(f);
      const project = await f.repos.projects.create({ name: "已有项目" });
      const manager = await f.repos.agents.create({ displayName: "创建负责人", hostType: "other" });
      const before = await allRows(f.db), outcomes: unknown[] = [];
      const operations = [
        () => f.service.preflight(access, f.rawRoot),
        () => f.service.save(access, project.id, { rootPath: f.rawRoot, mode: "isolated", expectedProjectRevision: 1, mutationId: "protected-save" }),
        () => f.service.createProject(access, { name: "不得留下", managerAgentId: manager.id }, { rootPath: f.rawRoot, mode: "isolated", mutationId: "protected-create" }),
      ];
      for (const operation of operations) {
        try { await operation(); outcomes.push("accepted"); }
        catch (error) { outcomes.push((error as { reason?: string }).reason); }
      }
      assert.deepEqual({ outcomes, rows: await allRows(f.db) },
        { outcomes: ["protected_path", "protected_path", "protected_path"], rows: before });
    } finally { await f.close(); }
  });

  test(`${engine} R-BR-COLLAB-135-STD-001：历史错误规范根/受保护身份快照复验失败，不改写历史`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "旧快照" });
      const saved = await f.service.save(access, project.id, { rootPath: f.lexicalRoot, mode: "isolated", expectedProjectRevision: 1, mutationId: "old-version" });
      await protectedAlias(f);
      // 只在 fixture 中重建旧缺陷已允许的持久状态；生产保护范围不变。
      const actual = await inspectWorkspaceRoot(f.environment.skillsRoot, { ...f.environment, protectedPaths: [] });
      await f.db.exec(`UPDATE project_workspace_versions SET root_path = ?, canonical_root = ?, root_identity_json = ?, physical_resource_key = ?
        WHERE project_id = ? AND workspace_revision = ?`,
      [f.rawRoot, f.lexicalRoot, JSON.stringify(actual.rootIdentity), actual.physicalResourceKey, project.id, saved.workspaceRevision]);
      const before = await allRows(f.db);
      await assert.rejects(f.service.revalidate(access, saved.workspaceRef!), { code: "workspace_changed", reason: "workspace_changed" });
      assert.deepEqual(await allRows(f.db), before);
      assert.equal((await f.service.getVersion(access, saved.workspaceRef!))?.rootPath, f.rawRoot);
    } finally { await f.close(); }
  });

  test(`${engine} S3 路径持久化：合法 link/.. 保留原输入，根替换/链接改向复验失败且配置不变`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "合法链接" });
      const saved = await f.service.save(access, project.id, { rootPath: f.rawRoot, mode: "isolated", expectedProjectRevision: 1, mutationId: "valid-alias" });
      assert.equal(saved.workspace?.rootPath, f.rawRoot); assert.equal(saved.workspace?.canonicalRoot, f.actualRoot);
      assert.deepEqual(saved.workspace?.rootIdentity, await identity(f.actualRoot));
      assert.deepEqual(await f.service.getVersion(access, saved.workspaceRef!), saved.workspace);
      assert.equal((await f.service.revalidate(access, saved.workspaceRef!)).runReady, false);
      const before = await allRows(f.db);
      const oldRoot = path.join(f.source, "old-actual");
      await rename(f.actualRoot, oldRoot); await mkdir(path.join(f.actualRoot, "child"), { recursive: true });
      await assert.rejects(f.service.revalidate(access, saved.workspaceRef!), { reason: "workspace_changed" });
      // 即使链接回到原物理根，原规范路径已变化，也必须要求重新保存。
      await rm(f.alias); await symlink(path.join(oldRoot, "child"), f.alias);
      await assert.rejects(f.service.revalidate(access, saved.workspaceRef!), { reason: "workspace_changed" });
      assert.deepEqual(await allRows(f.db), before);
      assert.deepEqual(await f.service.getVersion(access, saved.workspaceRef!), saved.workspace);
    } finally { await f.close(); }
  });
}

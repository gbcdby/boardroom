import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceService } from "../src/server/workspace/service.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { clearTargetTables, compareData, copyAllTables } from "../src/server/db/migrate-data.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { identityFixture, identityEngines, identitySkip } from "./helpers/identity-fixture.ts";

const access = { actor: ownerActor() };
async function fixture(engine: typeof identityEngines[number]) {
  const f = await identityFixture(engine, 15);
  const sourcePath = await mkdtemp(path.join(tmpdir(), "boardroom-workspace-source-")); const root = await realpath(sourcePath);
  const environment = await resolveBoardroomEnvironment({ cwd: f.dir,
    env: { BOARDROOM_HOME: path.join(f.dir, "home"), AGENT_STUDIO_DATA_DIR: f.dir } });
  const service = createWorkspaceService({ repos: f.repos, environment });
  return { ...f, root, environment, service, async close() { await f.close(); await rm(sourcePath, { recursive: true, force: true }); } };
}

for (const engine of identityEngines) {
  test(`${engine} S3 版本/CAS：旧项目未绑定、讨论 root=null、并发仅一次成功、固定引用仍能读取`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "工作目录" });
      const empty = await f.service.get(access, project.id);
      assert.equal(empty.projectRevision, 1); assert.equal(empty.workspaceRevision, 0); assert.equal(empty.workspace, null);
      const initial = await f.service.save(access, project.id, { expectedProjectRevision: 1, mutationId: "discussion", rootPath: null, mode: "isolated" });
      assert.equal(initial.workspaceRevision, 1); assert.equal(initial.workspace?.rootPath, null);
      const competing = await Promise.allSettled(["first", "second"].map(mutationId => f.service.save(access, project.id,
        { expectedProjectRevision: initial.projectRevision, mutationId, rootPath: f.root, mode: "serialized" })));
      assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
      const rejected = competing.find(r => r.status === "rejected");
      assert.equal(rejected?.status === "rejected" && rejected.reason.reason, "workspace_revision_conflict");
      const current = await f.service.get(access, project.id);
      assert.equal(current.workspaceRevision, 2); assert.equal(current.projectRevision, 3);
      assert.deepEqual(await f.service.getVersion(access, initial.workspaceRef!), initial.workspace);
      assert.equal((await f.db.query("SELECT * FROM project_workspace_versions")).length, 2);
      const repeated = await f.service.save(access, project.id,
        { expectedProjectRevision: 1, mutationId: "discussion", rootPath: null, mode: "isolated" });
      assert.deepEqual(repeated, initial, "重放原 mutation 返回原结果，不重新应用旧目录");
      await assert.rejects(f.service.save(access, project.id,
        { expectedProjectRevision: 1, mutationId: "discussion", rootPath: f.root, mode: "isolated" }), { reason: "workspace_mutation_conflict" });
      assert.deepEqual(await f.service.get(access, project.id), current);
    } finally { await f.close(); }
  });

  test(`${engine} S3 原子创建：路径错误不留项目，保存审计失败不留项目/成员/工作区`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await assert.rejects(f.service.createProject(access, { name: "不得留下" }, { rootPath: path.join(f.dir, "missing"), mode: "isolated", mutationId: "invalid" }), { reason: "path_missing" });
      assert.equal((await f.repos.projects.list()).length, 0);
      const agent = await f.repos.agents.create({ displayName: "负责人", hostType: "other" });
      const original = f.repos.audit.append;
      f.repos.audit.append = async () => { throw new Error("audit failed"); };
      try { await assert.rejects(f.service.createProject(access, { name: "回滚", managerAgentId: agent.id }, { rootPath: f.root, mode: "isolated", mutationId: "rollback" })); }
      finally { f.repos.audit.append = original; }
      assert.equal((await f.repos.projects.list()).length, 0);
      assert.equal((await f.db.query("SELECT * FROM members")).length, 0);
      assert.equal((await f.db.query("SELECT * FROM project_workspace_versions")).length, 0);
      const created = await f.service.createProject(access, { name: "有效" }, { rootPath: f.root, mode: "isolated", mutationId: "create" });
      assert.equal(created.workspace.workspace?.canonicalRoot, f.root);
      assert.equal(created.project.id, created.workspace.projectId);
    } finally { await f.close(); }
  });

  test(`${engine} S3 生命周期与权限：项目元数据推进项目版本，归档/越权/旧版本拒绝，群删除不改变工作区`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "旧名" });
      await f.repos.projects.rename(project.id, "新名");
      assert.equal((await f.service.get(access, project.id)).projectRevision, 2);
      await assert.rejects(f.service.save(access, project.id, { rootPath: null, mode: "isolated", expectedProjectRevision: 1, mutationId: "stale-name" }), { reason: "workspace_revision_conflict" });
      await assert.rejects(f.service.save({ actor: ownerActor("another-project") }, project.id,
        { rootPath: null, mode: "isolated", expectedProjectRevision: 2, mutationId: "foreign" }), { code: "cross_project" });
      await f.repos.projects.archive(project.id);
      assert.equal((await f.service.get(access, project.id)).projectRevision, 3);
      await assert.rejects(f.service.save(access, project.id, { rootPath: null, mode: "isolated", expectedProjectRevision: 3, mutationId: "archived" }), { code: "archived" });
      await f.repos.projects.restore(project.id);
      assert.equal((await f.service.get(access, project.id)).projectRevision, 4);
      const saved = await f.service.save(access, project.id, { rootPath: f.root, mode: "isolated", expectedProjectRevision: 4, mutationId: "saved" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "可删群" });
      await f.repos.groups.purge(group.id);
      assert.deepEqual(await f.service.get(access, project.id), saved);
      const cleared = await f.service.clear(access, project.id, { expectedProjectRevision: saved.projectRevision, mutationId: "clear" });
      assert.equal(cleared.workspace?.rootPath, null);
      assert.equal((await f.service.getVersion(access, saved.workspaceRef!))?.rootPath, f.root);
    } finally { await f.close(); }
  });

  test(`${engine} S3 改绑只变配置：原 runtime 三快照/SID/cwd 与 AGENTS/Skills 原字节不变`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "原运行" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "原群" });
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const created = await runtimes.create({ name: "原实例", backend: "claude-code", defaults: { workdir: f.root }, bindings: [{ projectId: project.id, groupId: group.id }] });
      const binding = created.bindings[0]!.binding;
      await runtimes.intent(binding.id, "start");
      const fence = await runtimes.claim(binding.id, "existing-run"); await runtimes.setSession(fence, "original-sid");
      await mkdir(path.join(f.root, "skills")); await writeFile(path.join(f.root, "AGENTS.md"), "不能改\n");
      await writeFile(path.join(f.root, "skills/SKILL.md"), "原技能\n");
      const tables = ["agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members"];
      const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
      const saved = await f.service.save(access, project.id, { rootPath: f.root, mode: "isolated", expectedProjectRevision: 1, mutationId: "bind" });
      await f.service.save(access, project.id, { rootPath: null, mode: "serialized", expectedProjectRevision: saved.projectRevision, mutationId: "unbind" });
      assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`))), before);
      assert.equal(await readFile(path.join(f.root, "AGENTS.md"), "utf8"), "不能改\n");
      assert.equal(await readFile(path.join(f.root, "skills/SKILL.md"), "utf8"), "原技能\n");
    } finally { await f.close(); }
  });

  test(`${engine} S3 purge 计数/摘要：新旧 Workspace 事实都参与确认，失败无副作用，最终只清库内配置`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "可清除" });
      const initial = await f.repos.projects.capturePurge(project.id);
      await f.service.save(access, project.id, { rootPath: f.root, mode: "isolated", expectedProjectRevision: 1, mutationId: "new-fact" });
      await assert.rejects(f.repos.projects.purge(project.id, initial.digest), { code: "confirmation_changed" });
      const snapshot = await f.repos.projects.capturePurge(project.id);
      assert.equal(snapshot.cascade.workspaceVersions, 1);
      const counts = await f.repos.projects.purge(project.id, snapshot.digest);
      assert.equal(counts.workspaceVersions, 1); assert.equal((await f.db.query("SELECT * FROM project_workspace_versions")).length, 0);
      await writeFile(path.join(f.root, "still-owned-by-user"), "保留原目录");
      assert.equal(await readFile(path.join(f.root, "still-owned-by-user"), "utf8"), "保留原目录");
    } finally { await f.close(); }
  });

  test(`sqlite→${engine} S3 非空版本复制与清库：CAS、历史路径、观测和 mutation 摘要逐值保留`, { skip: identitySkip(engine) }, async () => {
    const source = await fixture("sqlite"), target = await fixture(engine);
    try {
      const p = await source.repos.projects.create({ name: "复制配置" });
      const first = await source.service.save(access, p.id, { rootPath: source.root, mode: "isolated", expectedProjectRevision: 1, mutationId: "first" });
      await source.service.save(access, p.id, { rootPath: null, mode: "serialized", expectedProjectRevision: first.projectRevision, mutationId: "second" });
      await copyAllTables(source.db, target.db); assert.equal((await compareData(source.db, target.db)).ok, true);
      assert.deepEqual(await target.db.query("SELECT * FROM project_workspace_versions ORDER BY workspace_revision"), await source.db.query("SELECT * FROM project_workspace_versions ORDER BY workspace_revision"));
      await clearTargetTables(target.db);
      assert.equal((await target.db.query("SELECT * FROM projects")).length, 0);
      assert.equal((await target.db.query("SELECT * FROM project_workspace_versions")).length, 0);
    } finally { await source.close(); await target.close(); }
  });

  test(`${engine} S3 v14 非空升级 v15 保留旧数据与 checksum，已有项目获得真实配置版本`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 14);
    try {
      const p = await f.repos.projects.create({ name: "旧版本" });
      const before = (await f.db.query("SELECT * FROM projects"))[0];
      const checksums = (await f.db.migrationState()).applied;
      assert.equal((await f.db.migrate(migrations)).version, 15);
      const after = (await f.db.query("SELECT * FROM projects"))[0]!;
      assert.equal(after.project_revision, 1); assert.equal(after.workspace_revision, 0);
      const { project_revision, workspace_revision, ...old } = after; assert.deepEqual(old, before);
      assert.deepEqual((await f.db.migrationState()).applied.slice(0, 14), checksums);
      assert.equal((await f.repos.projects.get(p.id))?.projectRevision, 1);
      assert.equal((await f.db.migrate(migrations)).applied.length, 0);
    } finally { await f.close(); }
  });
}

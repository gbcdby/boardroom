import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, realpath, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapLegacyWorkspaces } from "../src/server/workspace/legacy-mapping.ts";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "../src/server/identity/legacy-config-inspection.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { snapshotRuntimeConfig } from "../src/server/runtime/config.ts";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { identityFixture, identityEngines, identitySkip } from "./helpers/identity-fixture.ts";

async function fixture(engine: typeof identityEngines[number]) {
  const f = await identityFixture(engine);
  const sourceBase = await mkdtemp(path.join(tmpdir(), "boardroom-workspace-mapping-"));
  const environment = await resolveBoardroomEnvironment({ cwd: f.dir, env: { BOARDROOM_HOME: path.join(f.dir, "home"), AGENT_STUDIO_DATA_DIR: f.dir } });
  return { ...f, sourceBase, environment, async close() { await f.close(); await rm(sourceBase, { recursive: true, force: true }); } };
}

for (const engine of identityEngines) {
  test(`${engine} S3 映射保留三原路径/版本引用：requested 选择不被最新 effective 覆盖，目录不一留 unresolved`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const dirs = ["applied", "requested", "effective"].map(name => path.join(f.sourceBase, name));
      for (const dir of dirs) await mkdir(dir);
      const environment = f.environment;
      const p = await f.repos.projects.create({ name: "三份来源" });
      const g = await f.repos.groups.create({ projectId: p.id, name: "原绑定" });
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const created = await runtimes.create({ name: "旧实例", backend: "claude-code", defaults: { workdir: dirs[0]! }, bindings: [{ projectId: p.id, groupId: g.id }] });
      const id = created.bindings[0]!.binding.id;
      await runtimes.intent(id, "start"); const fence = await runtimes.claim(id, "old-run");
      await runtimes.setSession(fence, "old-SID"); await runtimes.markExit(fence, { exitCode: 0 });
      await runtimes.updateDefaults(created.runtime.id, 1, { workdir: dirs[1]! }); await runtimes.intent(id, "apply");
      await runtimes.updateDefaults(created.runtime.id, 2, { workdir: dirs[2]! });
      const tables = ["agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "project_workspace_versions", "audit_log"];
      const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
      const inspection = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
      const result = await mapLegacyWorkspaces(inspection, p.id, environment);
      const binding = result.bindings[0]!;
      assert.equal(result.status, "unresolved"); assert.equal(result.suggestion, null);
      assert.equal(binding.selectedSource?.kind, "requestedSnapshot");
      assert.deepEqual(binding.selectedSource, selectLegacyConfigSnapshot(inspection.bindings[0]!).configSnapshotRef);
      assert.deepEqual(binding.snapshots.map(source => [source.kind, source.rootPath]),
        [["requestedSnapshot", await realpath(dirs[1]!)], ["applied", await realpath(dirs[0]!)], ["effective", await realpath(dirs[2]!)]]);
      assert.ok(binding.unresolvedReasons.includes("snapshot_directories_differ"));
      assert.equal(result.activationAllowed, false); assert.equal(result.readOnly, true);
      assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`))), before);
    } finally { await f.close(); }
  });

  test(`${engine} S3 映射同根仅给建议；限定参与绑定，外项目/损坏来源不被降级或自动选公共父目录`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const a = path.join(f.sourceBase, "source-a"), b = path.join(f.sourceBase, "source-b"); await mkdir(a); await mkdir(b);
      const environment = f.environment;
      const p = await f.repos.projects.create({ name: "本项目" }), other = await f.repos.projects.create({ name: "外项目" });
      const groups = await Promise.all(["甲", "乙"].map(name => f.repos.groups.create({ projectId: p.id, name })));
      const outside = await f.repos.groups.create({ projectId: other.id, name: "外群" });
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const created = await runtimes.create({ name: "多旧绑定", backend: "claude-code", defaults: { workdir: a },
        bindings: [...groups.map(group => ({ projectId: p.id, groupId: group.id })), { projectId: other.id, groupId: outside.id, overrides: { workdir: b } }] });
      const own = created.bindings.filter(binding => binding.binding.projectId === p.id).map(binding => binding.binding.id);
      const foreign = created.bindings.find(binding => binding.binding.projectId === other.id)!.binding.id;
      const inspector = createLegacyConfigInspector({ db: f.db, repos: f.repos });
      const coherent = await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment);
      assert.equal(coherent.status, "suggestion"); assert.equal(coherent.suggestion?.canonicalRoot, await realpath(a));
      assert.equal(coherent.bindings.length, 2); assert.equal(coherent.suggestion?.sources.length, 2);
      await assert.rejects(mapLegacyWorkspaces(await inspector.preflight(), p.id, environment, [foreign]), { reason: "workspace_binding_out_of_project" });
      await runtimes.updateBinding(own[1]!, { runtimeRevision: 1, bindingRevision: 1, overrides: { workdir: b } });
      const split = await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment);
      assert.equal(split.status, "unresolved"); assert.equal(split.suggestion, null); assert.ok(split.unresolvedReasons.includes("binding_directories_differ"));
      assert.equal((await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment, [own[0]!])).status, "suggestion");
      await runtimes.intent(own[0]!, "start"); const source = (await runtimes.getBinding(own[0]!))!.binding.requestedSnapshot!;
      const invalid = snapshotRuntimeConfig(source.backend, { ...source.config, workdir: "relative-original" }, source.versions, source.advancedStrategy);
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [JSON.stringify(invalid), own[0]!]);
      const invalidReport = await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment, [own[0]!]);
      assert.equal(invalidReport.status, "unresolved");
      assert.equal(invalidReport.bindings[0]?.selectedSource?.kind, "requestedSnapshot");
      assert.equal(invalidReport.bindings[0]?.snapshots.find(source => source.kind === "requestedSnapshot")?.issue?.code, "path_not_absolute");
      assert.equal(invalidReport.bindings[0]?.snapshots.find(source => source.kind === "requestedSnapshot")?.rootPath, "relative-original");
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", ["{ corrupt", own[0]!]);
      const corrupt = await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment, [own[0]!]);
      assert.equal(corrupt.status, "unresolved"); assert.equal(corrupt.bindings[0]?.selectedSource, null);
      assert.ok(corrupt.bindings[0]?.unresolvedReasons.includes("legacy_config_invalid"));
      await rm(b, { recursive: true });
      const missing = await mapLegacyWorkspaces(await inspector.preflight(), p.id, environment, [own[1]!]);
      assert.equal(missing.status, "unresolved"); assert.equal(missing.bindings[0]?.snapshots[0]?.issue?.code, "path_missing");
    } finally { await f.close(); }
  });
}

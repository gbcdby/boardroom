import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveBoardroomEnvironment } from "../src/server/environment.ts";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "../src/server/identity/legacy-config-inspection.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { previewLegacySkills, inspectSkillCatalog } from "../src/server/skills/preview.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import type { SkillSelectionSources } from "../src/shared/skills.ts";

for (const engine of identityEngines) test(`${engine} Skills 服务真实消费 S2 原快照与 S4 规划路径，不写任何旧配置/调用状态`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine);
  try {
    const packageRoot = path.join(f.dir, "sample"); await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: sample\ndescription: 用户入口\ndisable-model-invocation: true\n---\n不得自动调用\n");
    const environment = await resolveBoardroomEnvironment({ cwd: f.dir, env: { BOARDROOM_HOME: path.join(f.dir, "future-home") } });
    const project = await f.repos.projects.create({ name: "Skills 只读消费" });
    const group = await f.repos.groups.create({ projectId: project.id, name: "固定意图" });
    const appliedGroup = await f.repos.groups.create({ projectId: project.id, name: "固定 applied" });
    const effectiveGroup = await f.repos.groups.create({ projectId: project.id, name: "未固定" });
    const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
    const runtime = await runtimes.create({ name: "旧配置保真", backend: "claude-code", defaults: { workdir: f.dir, model: "original" },
      bindings: [group, appliedGroup, effectiveGroup].map(group => ({ projectId: project.id, groupId: group.id })) });
    const requestedId = runtime.bindings[0]!.binding.id, appliedId = runtime.bindings[1]!.binding.id, effectiveId = runtime.bindings[2]!.binding.id;
    await runtimes.intent(requestedId, "start");
    await runtimes.intent(appliedId, "start"); const fence = await runtimes.claim(appliedId, "skills-fixture"); await runtimes.markExit(fence, { exitCode: 0 });
    await runtimes.updateDefaults(runtime.runtime.id, 1, { workdir: f.dir, model: "pending-new" });
    const inspector = createLegacyConfigInspector({ db: f.db, repos: f.repos });
    const captured = await inspector.preflight();
    const sources: SkillSelectionSources = { project: null, profile: { ownerId: runtime.runtime.agentId, revision: 1,
      selections: [{ skillName: "sample", enabled: true }] }, group: null };
    const currentRevisions = { project: null, profile: { ownerId: runtime.runtime.agentId, revision: 2 }, group: null, workspaceRevision: null };
    const tables = ["agents", "members", "groups", "group_participants", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "agent_legacy_aliases", "agent_runtime_events", "agent_runtime_usage_snapshots", "audit_log"];
    const captureDb = () => Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
    const before = await captureDb(), directories = await readdir(f.dir);
    for (const [id, kind] of [[requestedId, "requestedSnapshot"], [appliedId, "applied"]] as const) {
      const binding = captured.bindings.find(item => item.bindingId === id)!, selected = selectLegacyConfigSnapshot(binding);
      const result = await previewLegacySkills({ environment, binding, selectionSnapshot: { configSnapshotRef: selected.configSnapshotRef!, sources, workspaceRevision: null },
        inventory: { packageRoots: [packageRoot] }, currentRevisions });
      assert.equal(result.resolution.state, "resolved-preview");
      assert.deepEqual(result.resolution.lock!.configSnapshotRef, selected.configSnapshotRef);
      assert.equal(result.configSelection.configSnapshotRef?.kind, kind);
      assert.equal(result.resolution.lock!.configSnapshotRef.versions.runtimeRevision, 1);
      assert.equal(result.resolution.lock!.sourceRevisions.profile?.revision, 1);
      assert.equal(result.resolution.lock!.entries[0]?.invocationMode, "user-only");
      assert.equal(result.resolution.lock!.entries[0]?.invocationEligible, false);
      assert.equal(result.configSelection.rawJson, selected.rawJson);
      assert.equal(result.environment.skills.status, "planned"); assert.equal(result.environment.materialized, false);
      assert.equal(result.readOnly, true); assert.equal(result.activationAllowed, false);
    }
    const binding = captured.bindings.find(item => item.bindingId === effectiveId)!, selected = selectLegacyConfigSnapshot(binding);
    const stale = await previewLegacySkills({ environment, binding, selectionSnapshot: { configSnapshotRef: selected.configSnapshotRef!, sources, workspaceRevision: null },
      inventory: { packageRoots: [packageRoot] }, currentRevisions });
    assert.equal(stale.resolution.conflicts[0]?.code, "source_changed");
    const empty = await inspectSkillCatalog({ environment, inventory: {} });
    assert.deepEqual(empty.inventory.packages, []); assert.equal(empty.environment.skills.status, "planned");
    assert.deepEqual(await captureDb(), before); assert.deepEqual(await readdir(f.dir), directories);
    assert.ok(!directories.includes("future-home"));
    const currentSources = { ...sources, profile: { ...sources.profile!, revision: 2 } };
    const fresh = await previewLegacySkills({ environment, binding, selectionSnapshot: { configSnapshotRef: selected.configSnapshotRef!, sources: currentSources, workspaceRevision: null },
      inventory: { packageRoots: [packageRoot] }, currentRevisions });
    assert.equal(fresh.resolution.state, "resolved-preview"); assert.equal(fresh.resolution.lock!.fixed, false);
    const incomplete = await previewLegacySkills({ environment, binding, selectionSnapshot: { configSnapshotRef: selected.configSnapshotRef!, sources: currentSources, workspaceRevision: null },
      inventory: { packageRoots: [packageRoot, path.join(f.dir, "missing")] }, currentRevisions });
    assert.equal(incomplete.resolution.conflicts[0]?.code, "inventory_invalid"); assert.equal(incomplete.resolution.lock, null);
    const oldBinding = captured.bindings.find(item => item.bindingId === requestedId)!;
    const original = selectLegacyConfigSnapshot(oldBinding);
    await runtimes.intent(requestedId, "apply");
    const newBinding = (await inspector.preflight()).bindings.find(item => item.bindingId === requestedId)!;
    const beforeNewPreview = await captureDb();
    const changedIntent = await previewLegacySkills({ environment, binding: newBinding,
      selectionSnapshot: { configSnapshotRef: original.configSnapshotRef!, sources, workspaceRevision: null }, inventory: { packageRoots: [packageRoot] }, currentRevisions });
    assert.equal(changedIntent.resolution.conflicts[0]?.code, "source_changed");
    const invalidIdentity = await previewLegacySkills({ environment, binding: { ...newBinding, identityValid: false },
      selectionSnapshot: { configSnapshotRef: original.configSnapshotRef!, sources, workspaceRevision: null }, inventory: {}, currentRevisions });
    assert.equal(invalidIdentity.resolution.conflicts[0]?.code, "config_snapshot_invalid");
    assert.deepEqual(await captureDb(), beforeNewPreview);

  } finally { await f.close(); }
});

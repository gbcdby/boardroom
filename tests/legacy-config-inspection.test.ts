import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "../src/server/identity/legacy-config-inspection.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { snapshotRuntimeConfig } from "../src/server/runtime/config.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

for (const engine of identityEngines) {
  for (const brokenIndex of [0, 1]) test(`${engine} R-134-STD-002：排序第 ${brokenIndex + 1} 个 binding 损坏不污染同 runtime 的健康 binding`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const project = await f.repos.projects.create({ name: "独立绑定来源" });
      const groups = await Promise.all(["前", "后"].map(name => f.repos.groups.create({ projectId: project.id, name })));
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const runtime = await runtimes.create({ name: "同 runtime 不同来源", backend: "claude-code", defaults: { workdir: f.dir },
        bindings: groups.map((group, i) => ({ projectId: project.id, groupId: group.id, overrides: { model: `独立模型 ${i}` } })) });
      const ids = runtime.bindings.map(binding => binding.binding.id).sort();
      const brokenId = ids[brokenIndex]!, healthyId = ids[1 - brokenIndex]!;
      const expectedHealthy = (await runtimes.getBinding(healthyId))!;
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", ["{ broken source", brokenId]);
      const capture = () => Promise.all(["agent_runtimes", "agent_runtime_bindings", "agent_runner_states"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
      const before = await capture();
      const report = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
      assert.equal(report.code, "legacy_config_invalid", "报告仍标记存在无效来源");
      assert.equal(report.profiles[0]!.source?.runtimeId, runtime.runtime.id, "局部坏请求不抹去完好的公共 Profile 来源");
      const broken = report.bindings.find(binding => binding.bindingId === brokenId)!;
      const healthy = report.bindings.find(binding => binding.bindingId === healthyId)!;
      assert.equal(broken.configurationValid, false); assert.equal(broken.view, null);
      assert.equal(selectLegacyConfigSnapshot(broken).code, "legacy_config_invalid");
      assert.equal(broken.raw.requestedSnapshotJson, "{ broken source");
      assert.equal(healthy.identityValid, true); assert.equal(healthy.configurationValid, true);
      assert.deepEqual(healthy.view, expectedHealthy);
      assert.deepEqual(healthy.snapshots.effective!.snapshot, expectedHealthy.effective);
      assert.ok(healthy.issues.every(issue => issue.refs["bindingId"] !== brokenId));
      assert.equal(selectLegacyConfigSnapshot(healthy).code, null);
      assert.equal(selectLegacyConfigSnapshot(healthy).configSnapshotRef?.kind, "effective");
      assert.deepEqual(await capture(), before);
    } finally { await f.close(); }
  });

  test(`${engine} readonly preflight 完整保留三快照、原高级选择、跨项目目录与 SID；恢复选择不消费意图`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const dirs = ["applied", "requested", "effective", "other-project"].map(name => path.join(f.dir, name));
      for (const dir of dirs) await mkdir(dir);
      // 这些快照由 runtime 写入口产生；它本来就用 realpath 保存目录，macOS /var 是符号链接。
      const canonicalDirs = await Promise.all(dirs.map(dir => realpath(dir)));
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const project = await f.repos.projects.create({ name: "原项目" }), otherProject = await f.repos.projects.create({ name: "另一项目" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "三快照" });
      const appliedGroup = await f.repos.groups.create({ projectId: project.id, name: "只保留 applied" });
      const otherGroup = await f.repos.groups.create({ projectId: otherProject.id, name: "有效高级选择" });
      const created = await runtimes.create({ name: "旧配置身份", backend: "claude-code", defaults: { workdir: dirs[0]!, model: "first" },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      const id = created.bindings[0]!.binding.id;
      await runtimes.updateBinding(id, { runtimeRevision: 1, bindingRevision: 1, overrides: { model: "group-model" }, advancedStrategy: "bypassPermissions" });
      await runtimes.intent(id, "start");
      const fence = await runtimes.claim(id, "real-fixture-owner");
      await runtimes.setSession(fence, "real-old-SID");
      await runtimes.markExit(fence, { exitCode: 0 });
      await runtimes.updateDefaults(created.runtime.id, 1, { workdir: dirs[1]!, model: "second", systemPrompt: "第二版" });
      await runtimes.updateBinding(id, { runtimeRevision: 2, bindingRevision: 2, overrides: { model: "group-model" }, advancedStrategy: "bypassPermissions" });
      await runtimes.intent(id, "apply");
      await runtimes.updateDefaults(created.runtime.id, 2, { workdir: dirs[2]!, model: "third", tools: ["Read"], systemPrompt: "第三版" });
      const appliedOnly = await runtimes.addBinding(created.runtime.id, { projectId: project.id, groupId: appliedGroup.id, overrides: { model: "own-model", systemPrompt: "" } });
      await runtimes.intent(appliedOnly.binding.id, "start"); const appliedFence = await runtimes.claim(appliedOnly.binding.id, "applied-owner");
      await runtimes.markExit(appliedFence, { exitCode: 0 });
      const other = await runtimes.addBinding(created.runtime.id, { projectId: otherProject.id, groupId: otherGroup.id,
        overrides: { workdir: dirs[3]!, model: null, tools: [], systemPrompt: "项目独立覆盖" } });
      await runtimes.updateBinding(other.binding.id, { runtimeRevision: 3, bindingRevision: 1,
        overrides: other.binding.overrides, advancedStrategy: "bypassPermissions" });
      const viewBefore = (await runtimes.getBinding(id))!;
      const tables = ["agents", "members", "groups", "group_participants", "agent_legacy_aliases", "agent_runtimes",
        "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "agent_runtime_events", "agent_runtime_usage_snapshots", "audit_log"];
      const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const inspector = createLegacyConfigInspector({ db: f.db, repos: f.repos, now: () => new Date("2026-11-11T12:00:00.000Z") });
      const report = await inspector.preflight();
      assert.equal(report.authority, "legacy"); assert.equal(report.migrated, false); assert.equal(report.readOnly, true);
      assert.equal(report.code, null); assert.equal(report.profiles.length, 1); assert.equal(report.bindings.length, 3);
      const observed = report.bindings.find(binding => binding.bindingId === id)!;
      assert.deepEqual(observed.view, viewBefore);
      assert.equal(observed.advanced?.validity, "invalidated_by_revision");
      assert.deepEqual(observed.advanced?.raw, { strategy: "bypassPermissions", runtimeRevision: 2, bindingRevision: 3 });
      assert.equal(observed.view!.effective.advancedStrategy, null);
      assert.equal(observed.snapshots.applied!.workdir, canonicalDirs[0]);
      assert.equal(observed.snapshots.requested!.workdir, canonicalDirs[1]);
      assert.equal(observed.snapshots.effective!.workdir, canonicalDirs[2]);
      assert.deepEqual(observed.snapshots.applied!.ref.versions, { runtimeRevision: 1, bindingRevision: 2 });
      assert.deepEqual(observed.snapshots.requested!.ref.versions, { runtimeRevision: 2, bindingRevision: 3 });
      assert.deepEqual(observed.snapshots.effective!.ref.versions, { runtimeRevision: 3, bindingRevision: 3 });
      const selected = selectLegacyConfigSnapshot(observed);
      assert.equal(selected.configSnapshotRef?.kind, "requestedSnapshot");
      assert.equal(selected.configSnapshotRef?.sourceId, id);
      assert.deepEqual(selected.snapshot, viewBefore.binding.requestedSnapshot);
      assert.equal(selected.activationAllowed, false);
      assert.ok(selected.reasons.includes("workspace_mapping_required"));
      assert.ok(selected.reasons.includes("migration_reconfirmation_required"));
      assert.equal(observed.view!.binding.resetSessionRequested, true);
      assert.equal(observed.view!.runner.harnessSessionId, "real-old-SID");
      assert.equal(observed.view!.pendingChanges, true);
      const raw = (await f.db.query<{ requested_snapshot_json: string; advanced_json: string }>("SELECT requested_snapshot_json, advanced_json FROM agent_runtime_bindings WHERE id = ?", [id]))[0]!;
      assert.equal(observed.raw.requestedSnapshotJson, raw.requested_snapshot_json); assert.equal(observed.raw.advancedJson, raw.advanced_json);
      const second = report.bindings.find(binding => binding.bindingId === appliedOnly.binding.id)!;
      assert.equal(selectLegacyConfigSnapshot(second).configSnapshotRef?.kind, "applied");
      const third = report.bindings.find(binding => binding.bindingId === other.binding.id)!;
      assert.equal(third.advanced!.validity, "effective");
      const expected = snapshotRuntimeConfig("claude-code", { model: null, workdir: canonicalDirs[3]!, tools: [], systemPrompt: "项目独立覆盖", permissionMode: "auto" },
        { runtimeRevision: 3, bindingRevision: 2 }, "bypassPermissions");
      assert.equal(third.snapshots.effective!.snapshot.digest, expected.digest);
      assert.deepEqual(third.view!.effective.sources, { model: "override", workdir: "override", tools: "override", systemPrompt: "override", permissionMode: "default" });
      assert.equal(selectLegacyConfigSnapshot(third).configSnapshotRef?.kind, "effective");
      assert.notEqual(third.memberId, observed.memberId);
      assert.ok(report.issues.some(issue => issue.reason === "non_equivalent_snapshots"));
      assert.deepEqual(await inspector.preflight(), report, "同一数据与观察时点可重放");
      assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`))), before);
      assert.deepEqual(await runtimes.getBinding(id), viewBefore);
    } finally { await f.close(); }
  });
  test(`${engine} 只读检查保留导入 requested 的非规范原目录、JSON 和 digest，不调用 realpath 重写来源`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const directory = path.join(f.dir, "source"); await mkdir(directory);
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const project = await f.repos.projects.create({ name: "原始目录" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "保留原请求" });
      const runtime = await runtimes.create({ name: "旧目录来源", backend: "claude-code", defaults: { workdir: directory },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      const id = runtime.bindings[0]!.binding.id;
      await runtimes.intent(id, "start");
      const original = (await runtimes.getBinding(id))!.binding.requestedSnapshot!;
      const rawWorkdir = `${directory}/../source`;
      const imported = snapshotRuntimeConfig(original.backend, { ...original.config, workdir: rawWorkdir }, original.versions, original.advancedStrategy);
      const rawJson = JSON.stringify(imported, null, 2);
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [rawJson, id]);
      const before = await f.db.query("SELECT * FROM agent_runtime_bindings ORDER BY id");
      const report = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
      const source = report.bindings[0]!;
      assert.equal(report.code, null);
      assert.equal(source.snapshots.effective!.workdir, await realpath(directory));
      assert.equal(source.snapshots.requested!.workdir, rawWorkdir);
      assert.equal(source.snapshots.requested!.rawJson, rawJson);
      assert.equal(source.snapshots.requested!.ref.digest, imported.digest);
      assert.equal(source.snapshots.requested!.digestValid, true);
      const selected = selectLegacyConfigSnapshot(source);
      assert.deepEqual(selected.snapshot, imported);
      assert.equal(selected.rawJson, rawJson);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_runtime_bindings ORDER BY id"), before);
    } finally { await f.close(); }
  });
  test(`${engine} 非法 Agent/member/项目/群关联与 alias 冲突返回具体引用，不猜身份、不回写`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const p = await f.repos.projects.create({ name: "正确项目" }), p2 = await f.repos.projects.create({ name: "不相干项目" });
      const g = await f.repos.groups.create({ projectId: p.id, name: "正确群" });
      const runtime = await runtimes.create({ name: "原 runtime", backend: "claude-code", defaults: { workdir: f.dir }, bindings: [{ projectId: p.id, groupId: g.id }] });
      const other = await f.repos.agents.create({ displayName: "另一个身份", hostType: "claude-code" });
      const wrongMember = await f.repos.members.create({ projectId: p2.id, agentId: other.id, kind: "agent", displayName: "另一个成员" });
      const id = runtime.bindings[0]!.binding.id;
      await f.db.exec("UPDATE agent_runtime_bindings SET member_id = ? WHERE id = ?", [wrongMember.id, id]);
      await f.db.exec("UPDATE agent_legacy_aliases SET agent_id = ? WHERE display_name = ? AND host_type = ?", [other.id, "原 runtime", "claude-code"]);
      const before = await f.db.query("SELECT * FROM agent_runtime_bindings ORDER BY id");
      const report = await createLegacyConfigInspector({ db: f.db, repos: f.repos }).preflight();
      assert.equal(report.code, "migration_identity_ambiguous");
      assert.ok(report.issues.some(issue => issue.reason === "binding_member_agent_mismatch" && issue.refs["bindingId"] === id && issue.refs["memberId"] === wrongMember.id));
      assert.ok(report.issues.some(issue => issue.reason === "binding_member_project_mismatch"));
      assert.ok(report.issues.some(issue => issue.reason === "binding_participant_missing"));
      assert.ok(report.issues.some(issue => issue.reason === "legacy_alias_conflict" && issue.refs["aliasAgentId"] === other.id));
      assert.equal(selectLegacyConfigSnapshot(report.bindings[0]!).code, "migration_identity_ambiguous");
      assert.equal(selectLegacyConfigSnapshot(report.bindings[0]!).configSnapshotRef, null);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_runtime_bindings ORDER BY id"), before);
      assert.equal((await f.repos.agents.list()).length, 2);
    } finally { await f.close(); }
  });

  test(`${engine} 损坏请求快照和未知配置版本阻塞选择，不回退 applied、不覆盖原始意图`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const p = await f.repos.projects.create({ name: "配置版本" }), g = await f.repos.groups.create({ projectId: p.id, name: "版本群" });
      const runtime = await runtimes.create({ name: "配置身份", backend: "claude-code", defaults: { workdir: f.dir }, bindings: [{ projectId: p.id, groupId: g.id }] });
      const id = runtime.bindings[0]!.binding.id;
      await runtimes.intent(id, "start"); const fence = await runtimes.claim(id, "snapshot-owner");
      await runtimes.setSession(fence, "old-snapshot-SID"); await runtimes.markExit(fence, { exitCode: 0 });
      await runtimes.intent(id, "apply");
      const raw = (await f.db.query<{ requested_snapshot_json: string }>("SELECT requested_snapshot_json FROM agent_runtime_bindings WHERE id = ?", [id]))[0]!.requested_snapshot_json;
      const corrupt = JSON.stringify({ ...JSON.parse(raw), digest: "0".repeat(64) }, null, 2);
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [corrupt, id]);
      const inspector = createLegacyConfigInspector({ db: f.db });
      const invalid = (await inspector.preflight()).bindings[0]!;
      assert.equal(invalid.raw.requestedSnapshotJson, corrupt);
      assert.equal(invalid.snapshots.requested!.ref.digest, "0".repeat(64));
      assert.ok(invalid.issues.some(issue => issue.reason === "snapshot_digest_mismatch"));
      assert.equal(selectLegacyConfigSnapshot(invalid).code, "legacy_config_invalid");
      assert.equal(selectLegacyConfigSnapshot(invalid).configSnapshotRef, null);
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", ["{ broken json", id]);
      const broken = (await inspector.preflight()).bindings[0]!;
      assert.equal(broken.raw.requestedSnapshotJson, "{ broken json");
      assert.equal(broken.raw.runnerRow!["harness_session_id"], "old-snapshot-SID");
      assert.ok(Number(broken.raw.bindingRow["intent_revision"]) > 0);
      assert.equal(selectLegacyConfigSnapshot(broken).configSnapshotRef, null);
      await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", [raw, id]);
      await f.db.exec("UPDATE agent_runtimes SET config_version = 7 WHERE id = ?", [runtime.runtime.id]);
      const unknown = await inspector.preflight();
      assert.equal(unknown.code, "legacy_config_invalid");
      assert.ok(unknown.issues.some(issue => issue.reason === "legacy_config_version_unsupported"));
      assert.equal(selectLegacyConfigSnapshot(unknown.bindings[0]!).configSnapshotRef, null);
      assert.equal((await f.db.query<{ requested_snapshot_json: string }>("SELECT requested_snapshot_json FROM agent_runtime_bindings WHERE id = ?", [id]))[0]!.requested_snapshot_json, raw);
    } finally { await f.close(); }
  });

  test(`${engine} v13 只读来源适用于未升级 alias 的旧库；外部 Agent 不伪造可启动 Profile`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine, 13);
    try {
      const external = await f.repos.agents.create({ displayName: "仅外部连接身份", hostType: "other" });
      const before = (await f.db.migrationState()).applied;
      const inspector = createLegacyConfigInspector({ db: f.db });
      const report = await inspector.preflight();
      assert.equal(report.aliasCatalogState, "pre-migration"); assert.equal(report.code, null);
      const profile = await inspector.profile(external.id);
      assert.equal(profile.profile.mode, "external"); assert.equal(profile.profile.source, null);
      assert.equal(profile.profile.writable, false); assert.equal(profile.profile.migrated, false);
      assert.deepEqual(profile.profile.runtimeIds, []); assert.deepEqual(profile.bindings, []);
      assert.deepEqual((await f.db.migrationState()).applied, before);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_runtimes"), []);
    } finally { await f.close(); }
  });

  test(`${engine} 非法导入库违反 runtime→Agent 一对一时返回全部 runtime 引用，绝不选一个合并`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const p = await f.repos.projects.create({ name: "导入数据" }), g = await f.repos.groups.create({ projectId: p.id, name: "一对一检查" });
      const one = await runtimes.create({ name: "第一身份", backend: "claude-code", defaults: { workdir: f.dir }, bindings: [{ projectId: p.id, groupId: g.id }] });
      const two = await runtimes.create({ name: "第二身份", backend: "claude-code", defaults: { workdir: f.dir }, bindings: [{ projectId: p.id, groupId: g.id }] });
      // 故意构造导入/手改库中缺唯一约束的坏数据；生产 schema 的一对一约束仍原样存在。
      if (engine === "sqlite") {
        await f.db.exec("PRAGMA foreign_keys = OFF");
        await f.db.exec("CREATE TABLE imported_runtimes AS SELECT * FROM agent_runtimes");
        await f.db.exec("DROP TABLE agent_runtimes");
        await f.db.exec("ALTER TABLE imported_runtimes RENAME TO agent_runtimes");
        await f.db.exec("PRAGMA foreign_keys = ON");
      } else await f.db.exec("ALTER TABLE agent_runtimes DROP CONSTRAINT agent_runtimes_agent_id_key");
      await f.db.exec("UPDATE agent_runtimes SET agent_id = ? WHERE id = ?", [one.runtime.agentId, two.runtime.id]);
      const before = await f.db.query("SELECT * FROM agent_runtimes ORDER BY id");
      const report = await createLegacyConfigInspector({ db: f.db }).preflight();
      assert.equal(report.code, "migration_identity_ambiguous");
      const issue = report.issues.find(issue => issue.reason === "runtime_agent_not_unique")!;
      assert.deepEqual(issue.refs["runtimeIds"], [one.runtime.id, two.runtime.id].sort());
      assert.equal(report.profiles.find(profile => profile.agentId === one.runtime.agentId)!.mode, "ambiguous");
      assert.equal(report.profiles.find(profile => profile.agentId === one.runtime.agentId)!.source, null);
      assert.ok(report.bindings.every(binding => selectLegacyConfigSnapshot(binding).code === "migration_identity_ambiguous"));
      assert.deepEqual(await f.db.query("SELECT * FROM agent_runtimes ORDER BY id"), before);
    } finally { await f.close(); }
  });
}

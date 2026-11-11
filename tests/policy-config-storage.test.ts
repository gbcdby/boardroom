import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyConfiguration, initializePolicyConfiguration } from "../src/server/policy/configuration.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { clearTargetTables, compareData, copyAllTables } from "../src/server/db/migrate-data.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";

const access = { actor: ownerActor() };
for (const engine of identityEngines) {
  test(`sqlite→${engine} S1 copy/clear：全局/项目历史逐值保留，目标迁移不seed，摘要/元数据变化可被校验发现`, { skip: identitySkip(engine) }, async () => {
    const source = await identityFixture("sqlite"), target = await identityFixture(engine);
    try {
      assert.deepEqual(await target.db.query("SELECT * FROM policy_documents"), []);
      assert.deepEqual(await target.db.query("SELECT * FROM audit_log"), []);
      const initial = await initializePolicyConfiguration(source.repos), service = createPolicyConfiguration({ repos: source.repos });
      const project = await source.repos.projects.create({ name: "复制策略" });
      await service.updateGlobal(access, { expectedRevision: 1, rules: [] });
      await service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 2, rules: [], overrides: [] });
      await service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 2,
        rules: [{ ruleId: "extra.local", when: {}, outcome: "human", reason: "归档历史也保留", requiresFreshHuman: true }], overrides: [] });
      const tables = ["policy_documents", "policy_document_versions", "audit_log"];
      const before = await Promise.all(tables.map(table => source.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const counts = await copyAllTables(source.db, target.db);
      assert.equal(counts.policy_documents, 2); assert.equal(counts.policy_document_versions, 4);
      assert.deepEqual(await Promise.all(tables.map(table => target.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`))), before);
      assert.equal((await compareData(source.db, target.db)).ok, true);
      const copied = createPolicyConfiguration({ repos: target.repos });
      assert.equal((await copied.getEffective(access, project.id)).projectRevision, 2);
      assert.deepEqual(await copied.getGlobalVersion(access, 1), initial);
      await initializePolicyConfiguration(target.repos);
      assert.equal((await copied.getGlobal(access)).document.revision, 2);
      await target.db.exec("UPDATE policy_document_versions SET created_by_id = 'changed' WHERE document_id = 'user' AND revision = 1");
      assert.equal((await compareData(source.db, target.db)).ok, false, "保持同一主键的元数据差异也必须报告");
      await clearTargetTables(target.db);
      for (const table of tables) assert.deepEqual(await target.db.query(`SELECT * FROM ${table}`), []);
      assert.deepEqual(await Promise.all(tables.map(table => source.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`))), before);
    } finally { await source.close(); await target.close(); }
  });

  test(`${engine} S1 purge：新增/历史策略参与影响摘要，旧确认失败，群删除及项目删除保留全局/其他项目`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const global = await initializePolicyConfiguration(f.repos), service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "删除策略" }), other = await f.repos.projects.create({ name: "保留策略" });
      const group = await f.repos.groups.create({ projectId: project.id, name: "群" });
      const original = await f.repos.projects.capturePurge(project.id), groupPreview = await f.repos.groups.capturePurge(group.id);
      await service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] });
      const keep = await service.updateProject(access, other.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] });
      await assert.rejects(f.repos.projects.purge(project.id, original.digest), { code: "confirmation_changed" });
      const once = await f.repos.projects.capturePurge(project.id);
      await service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 1, rules: [], overrides: [] });
      await assert.rejects(f.repos.projects.purge(project.id, once.digest), { code: "confirmation_changed" });
      await f.repos.groups.purge(group.id, groupPreview.digest);
      assert.equal((await service.getProject(access, project.id))!.document.revision, 2);
      const historyChange = await f.repos.projects.capturePurge(project.id);
      await f.db.exec("UPDATE policy_document_versions SET created_at = ? WHERE document_id = ? AND revision = 1",
        ["2026-11-11T00:00:00.000Z", `project:${project.id}`]);
      await assert.rejects(f.repos.projects.purge(project.id, historyChange.digest), { code: "confirmation_changed" });
      const current = await f.repos.projects.capturePurge(project.id);
      assert.equal(current.cascade.policyDocuments, 1); assert.equal(current.cascade.policyVersions, 2);
      const counts = await f.repos.projects.purge(project.id, current.digest);
      assert.equal(counts.policyDocuments, 1); assert.equal(counts.policyVersions, 2);
      assert.deepEqual(await service.getGlobal(access), global); assert.deepEqual(await service.getProject(access, other.id), keep);
      assert.equal((await f.db.query("SELECT * FROM policy_document_versions WHERE document_id = ?", [`project:${project.id}`])).length, 0);
      assert.equal((await f.db.query("SELECT * FROM audit_log WHERE project_id = ?", [project.id])).length, 2, "历史审计按既有规则保留");
    } finally { await f.close(); }
  });

  test(`${engine} S1 完整版本：大于32KiB规则正文不丢，审计使用版本引用，损坏当前不会回退默认`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const service = createPolicyConfiguration({ repos: f.repos });
      const rules = Array.from({ length: 30 }, (_, i) => ({ ruleId: `large.rule${i}`, when: {}, outcome: "human", reason: "完整策略内容".repeat(250),
        requiresFreshHuman: true, locked: false, overridable: true }));
      const saved = await service.updateGlobal(access, { expectedRevision: 1, rules });
      const row = (await f.db.query<{ document_json: string }>("SELECT document_json FROM policy_document_versions WHERE document_id = 'user' AND revision = 2"))[0]!;
      assert.ok(Buffer.byteLength(row.document_json) > 32768);
      assert.deepEqual((await service.getGlobalVersion(access, 2)).document.rules, rules);
      const audits = await f.repos.audit.listUser({ limit: 10 });
      const audit = audits.find(entry => entry.action === "policy.update")!;
      assert.deepEqual(JSON.parse(audit.after!), saved.ref); assert.ok(JSON.stringify(audit).length < 32768);
      await f.db.exec("UPDATE policy_document_versions SET document_json = '{}' WHERE document_id = 'user' AND revision = 2");
      await assert.rejects(service.getGlobal(access), { reason: "policy_storage_invalid" });
      await assert.rejects(initializePolicyConfiguration(f.repos), { reason: "policy_storage_invalid" });
      assert.equal((await f.db.query("SELECT * FROM policy_document_versions")).length, 2);
      assert.equal((await f.db.query("SELECT * FROM audit_log")).length, 2);
    } finally { await f.close(); }
  });
}

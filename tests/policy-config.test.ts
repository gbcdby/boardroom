import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyConfiguration, initializePolicyConfiguration } from "../src/server/policy/configuration.ts";
import { createDefaultPolicy } from "../src/server/policy/defaults.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { identityFixture, identityEngines, identitySkip } from "./helpers/identity-fixture.ts";

const access = { actor: ownerActor() };

for (const engine of identityEngines) {
  test(`${engine} S1 项目并发保存及审计失败：同一expectedRevision仅一份新历史，失败后头/历史/审计一致`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "项目并发" });
      const input = { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] };
      const outcomes = await Promise.allSettled([service.updateProject(access, project.id, input), service.updateProject(access, project.id, input)]);
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
      const rejected = outcomes.find(result => result.status === "rejected");
      assert.equal(rejected?.status === "rejected" && rejected.reason.reason, "policy_revision_conflict");
      const snapshot = () => Promise.all(["policy_documents", "policy_document_versions", "audit_log"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const before = await snapshot(), append = f.repos.audit.append;
      f.repos.audit.append = async () => { throw new Error("injected project audit failure"); };
      try { await assert.rejects(service.updateProject(access, project.id, { ...input, expectedRevision: 1 }), { code: "write_failed" }); }
      finally { f.repos.audit.append = append; }
      assert.deepEqual(await snapshot(), before);
      assert.equal((await service.listProjectVersions(access, project.id)).versions.length, 1);
    } finally { await f.close(); }
  });

  test(`${engine} S1 配置初始化：持久默认、读取零写入、重复启动不改版本或审计`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const service = createPolicyConfiguration({ repos: f.repos });
      await assert.rejects(service.getGlobal(access), { reason: "policy_not_initialized" });
      assert.equal((await f.db.query("SELECT * FROM audit_log")).length, 0);
      const initialized = await initializePolicyConfiguration(f.repos);
      assert.deepEqual(initialized.document, createDefaultPolicy(1));
      assert.equal(initialized.createdBy.kind, "system");
      assert.equal(initialized.createdBy.id, "policy-bootstrap");
      const snapshot = () => Promise.all(["policy_documents", "policy_document_versions", "audit_log"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const before = await snapshot();
      assert.equal(before[0]!.length, 1); assert.equal(before[1]!.length, 1); assert.equal(before[2]!.length, 1);
      assert.deepEqual(await service.getGlobal(access), initialized);
      assert.deepEqual(await initializePolicyConfiguration(f.repos), initialized);
      assert.deepEqual(await createPolicyConfiguration({ repos: f.repos }).getGlobal(access), initialized);
      assert.deepEqual(await snapshot(), before);
      const audit = before[2]![0]!;
      assert.equal(audit.scope, "user"); assert.equal(audit.project_id, null);
      assert.equal(audit.action, "policy.initialize");
      assert.equal((await f.repos.projects.list({ includeArchived: true })).length, 0);
    } finally { await f.close(); }
  });

  test(`${engine} S1 全局保存：CAS只提交一份版本，历史不可变且审计失败整体回滚`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos);
      const service = createPolicyConfiguration({ repos: f.repos });
      const rules = initial.document.rules.map((rule, i) => i === 0 ? { ...rule, reason: "用户保存的新理由" } : rule);
      const second = await service.updateGlobal(access, { expectedRevision: 1, rules });
      assert.equal(second.document.revision, 2); assert.equal(second.createdBy.kind, "human");
      assert.deepEqual(await service.getGlobalVersion(access, 1), initial);
      const result = await Promise.allSettled(["竞争甲", "竞争乙"].map(reason => service.updateGlobal(access,
        { expectedRevision: 2, rules: rules.map((rule, i) => i === 0 ? { ...rule, reason } : rule) })));
      assert.equal(result.filter(row => row.status === "fulfilled").length, 1);
      const rejected = result.find(row => row.status === "rejected");
      assert.equal(rejected?.status === "rejected" && rejected.reason.reason, "policy_revision_conflict");
      assert.equal(rejected?.status === "rejected" && rejected.reason.current.revision, 3);
      const versions = await service.listGlobalVersions(access);
      assert.deepEqual(versions.versions.map(version => version.ref.revision), [3, 2, 1]);
      assert.equal(versions.current?.revision, 3);
      assert.deepEqual(await service.getGlobalVersion(access, 2), second);
      const snapshot = () => Promise.all(["policy_documents", "policy_document_versions", "audit_log"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const before = await snapshot(), append = f.repos.audit.appendUser;
      f.repos.audit.appendUser = async () => { throw new Error("injected audit failure"); };
      try { await assert.rejects(service.updateGlobal(access, { expectedRevision: 3, rules }), { code: "write_failed" }); }
      finally { f.repos.audit.appendUser = append; }
      assert.deepEqual(await snapshot(), before);
      assert.equal((await service.getGlobal(access)).document.revision, 3);
    } finally { await f.close(); }
  });

  test(`${engine} S1 项目继承与覆盖：首次CAS为null，保存绑定全局版本且返回真实规则来源`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos), service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "项目策略" });
      const inherited = await service.getEffective(access, project.id);
      assert.equal(inherited.project, null); assert.equal(inherited.projectRevision, null);
      assert.equal(inherited.globalRevision, 1); assert.equal(inherited.defaultRevision, 1);
      assert.equal((await f.db.query("SELECT * FROM policy_documents")).length, 1);
      const original = initial.document.rules.find(rule => rule.ruleId === "default.task.assign")!;
      const override = { ruleId: original.ruleId, when: original.when, outcome: "human" as const, reason: "分派也须用户点头", requiresFreshHuman: true };
      const first = await service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [override] });
      assert.equal(first.document.revision, 1); assert.equal(first.basedOnGlobalRevision, 1);
      const effective = await service.getEffective(access, project.id);
      const rule = effective.rules.find(entry => entry.rule.ruleId === override.ruleId)!;
      assert.equal(rule.rule.outcome, "human"); assert.equal(rule.source.scope, "project-override");
      assert.equal(rule.source.replacedGlobalRevision, 1);
      assert.equal(effective.executionAdmission, "not-issued");
      await assert.rejects(service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] }), { reason: "policy_revision_conflict" });
      await service.updateGlobal(access, { expectedRevision: 1, rules: initial.document.rules });
      await assert.rejects(service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 1, rules: [], overrides: [] }), { reason: "policy_global_revision_conflict" });
      assert.deepEqual(await service.getProjectVersion(access, project.id, 1), first);
      const saved = await service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 2, rules: [], overrides: [] });
      assert.equal(saved.document.revision, 2); assert.equal(saved.basedOnGlobalRevision, 2);
      assert.equal((await service.getEffective(access, project.id)).rules.find(entry => entry.rule.ruleId === override.ruleId)?.source.scope, "global");
      assert.deepEqual((await service.listProjectVersions(access, project.id)).versions.map(version => version.ref.revision), [2, 1]);
    } finally { await f.close(); }
  });

  test(`${engine} S1 M1：全局删除/锁定与项目同ID冲突整次拒绝，归档项目不遗漏`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos), service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "归档覆盖" });
      const override = { ruleId: "default.task.assign", when: { actionKinds: ["task.assign" as const] }, outcome: "human" as const, reason: "需确认", requiresFreshHuman: false };
      await service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [override] });
      await f.repos.projects.archive(project.id);
      const snapshot = () => Promise.all(["policy_documents", "policy_document_versions", "audit_log"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const before = await snapshot();
      for (const rules of [
        initial.document.rules.filter(rule => rule.ruleId !== override.ruleId),
        initial.document.rules.map(rule => rule.ruleId === override.ruleId ? { ...rule, locked: true, overridable: false } : rule),
        initial.document.rules.map(rule => rule.ruleId === override.ruleId ? { ...rule, overridable: false } : rule),
      ]) {
        await assert.rejects(service.updateGlobal(access, { expectedRevision: 1, rules }), error => {
          assert.equal((error as { reason: string }).reason, "policy_project_conflict");
          assert.deepEqual((error as { conflicts: unknown }).conflicts, [{ projectId: project.id, projectRevision: 1,
            fields: ["project.overrides.default.task.assign"], repairEndpoint: `/api/projects/${project.id}/policy` }]);
          return true;
        });
        assert.deepEqual(await snapshot(), before);
      }
      await assert.rejects(service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 1, rules: [], overrides: [] }), { code: "archived" });
      await f.repos.projects.restore(project.id);
      const extra = { ...override, ruleId: "extra.local" };
      await service.updateProject(access, project.id, { expectedRevision: 1, expectedGlobalRevision: 1, rules: [extra], overrides: [] });
      await assert.rejects(service.updateGlobal(access, { expectedRevision: 1, rules: [...initial.document.rules, { ...extra, locked: false, overridable: true }] }), { reason: "policy_project_conflict" });
      await service.updateProject(access, project.id, { expectedRevision: 2, expectedGlobalRevision: 1, rules: [], overrides: [] });
      const saved = await service.updateGlobal(access, { expectedRevision: 1, rules: initial.document.rules.map(rule => rule.ruleId === override.ruleId ? { ...rule, locked: true, overridable: false } : rule) });
      assert.equal(saved.document.revision, 2);
      assert.equal((await service.getEffective(access, project.id)).globalRevision, 2);
    } finally { await f.close(); }
  });

  test(`${engine} S1 M1 并发：新覆盖与全局锁定只能提交一个有效组合`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos), service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "交错保存" });
      const ruleId = "default.task.assign", override = { ruleId, when: { actionKinds: ["task.assign" as const] }, outcome: "human" as const, reason: "覆盖", requiresFreshHuman: false };
      const results = await Promise.allSettled([
        service.updateProject(access, project.id, { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [override] }),
        service.updateGlobal(access, { expectedRevision: 1, rules: initial.document.rules.map(rule => rule.ruleId === ruleId ? { ...rule, locked: true, overridable: false } : rule) }),
      ]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      const failure = results.find(result => result.status === "rejected");
      assert.ok(failure?.status === "rejected");
      assert.ok(["policy_global_revision_conflict", "policy_project_conflict"].includes(failure.reason.reason));
      const effective = await service.getEffective(access, project.id);
      assert.ok(effective.globalRevision === 1 && effective.projectRevision === 1 || effective.globalRevision === 2 && effective.projectRevision === null);
      assert.equal((await f.db.query("SELECT * FROM policy_document_versions")).length, 2);
      assert.equal((await f.db.query("SELECT * FROM audit_log WHERE action LIKE 'policy.%'")).length, 2);
    } finally { await f.close(); }
  });

  test(`${engine} S1 拒绝与回滚：Agent/跨项目/非法规则/版本写失败均不留下部分版本`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const initial = await initializePolicyConfiguration(f.repos), service = createPolicyConfiguration({ repos: f.repos });
      const project = await f.repos.projects.create({ name: "边界" });
      const snapshot = () => Promise.all(["policy_documents", "policy_document_versions", "audit_log"].map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
      const before = await snapshot(), globalUpdate = { expectedRevision: 1, rules: initial.document.rules };
      const projectUpdate = { expectedRevision: null, expectedGlobalRevision: 1, rules: [], overrides: [] };
      for (const actor of [{ ...ownerActor(), kind: "agent" as const }, ownerActor("another-project")]) {
        await assert.rejects(service.updateGlobal({ actor }, globalUpdate), { name: "ForbiddenError" });
        await assert.rejects(service.updateProject({ actor }, project.id, projectUpdate), { name: "ForbiddenError" });
        await assert.rejects(service.getGlobalVersion({ actor }, 1), { name: "ForbiddenError" });
      }
      for (const input of [
        { ...globalUpdate, script: "allow()" },
        { ...globalUpdate, rules: [...initial.document.rules, initial.document.rules[0]] },
        { ...globalUpdate, rules: [{ ...initial.document.rules[0], locked: true, overridable: true }] },
      ]) await assert.rejects(service.updateGlobal(access, input), { reason: "policy_input_invalid" });
      await assert.rejects(service.updateProject(access, project.id, { ...projectUpdate, projectId: "forged" }), { reason: "policy_input_invalid" });
      await assert.rejects(service.updateProject(access, project.id, { ...projectUpdate, overrides: [{ ruleId: "default.scope.change", when: {}, outcome: "auto", reason: "不能绕过锁定", requiresFreshHuman: false }] }), { reason: "policy_input_invalid" });
      assert.deepEqual(await snapshot(), before);
      const exec = f.repos.context.exec;
      f.repos.context.exec = async (sql, params) => { if (sql.startsWith("INSERT INTO policy_document_versions")) throw new Error("injected version failure"); return exec(sql, params); };
      try { await assert.rejects(service.updateProject(access, project.id, projectUpdate), { code: "write_failed" }); }
      finally { f.repos.context.exec = exec; }
      assert.deepEqual(await snapshot(), before);
    } finally { await f.close(); }
  });

  test(`${engine} S1 并发初始化及初始化审计失败：无半份默认，重启不覆盖已修改配置`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const appendUser = f.repos.audit.appendUser;
      f.repos.audit.appendUser = async () => { throw new Error("initialization audit failed"); };
      try { await assert.rejects(initializePolicyConfiguration(f.repos), { code: "write_failed" }); }
      finally { f.repos.audit.appendUser = appendUser; }
      assert.equal((await f.db.query("SELECT * FROM policy_documents")).length, 0);
      assert.equal((await f.db.query("SELECT * FROM policy_document_versions")).length, 0);
      const [a, b] = await Promise.all([initializePolicyConfiguration(f.repos), initializePolicyConfiguration(f.repos)]);
      assert.deepEqual(a, b); assert.equal((await f.db.query("SELECT * FROM audit_log")).length, 1);
      const service = createPolicyConfiguration({ repos: f.repos });
      const userSaved = await service.updateGlobal(access, { expectedRevision: 1, rules: [] });
      assert.deepEqual(await initializePolicyConfiguration(f.repos), userSaved);
      assert.equal((await f.db.query("SELECT * FROM audit_log")).length, 2);
    } finally { await f.close(); }
  });
}

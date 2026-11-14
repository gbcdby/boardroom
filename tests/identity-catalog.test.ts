import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityCatalog } from "../src/server/identity/catalog.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { ROLE_CAPABILITIES } from "../src/server/authz/authorize.ts";
import { identityEngines, identityFixture, identitySkip } from "./helpers/identity-fixture.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";

for (const engine of identityEngines) {
  test(`${engine} 角色 create/edit CAS 保留不可变版本；职责名与推荐 Skills 不授予能力`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const catalog = createIdentityCatalog({ repos: f.repos });
      const access = { actor: ownerActor() };
      const capabilities = [...ROLE_CAPABILITIES.member];
      const editable = { name: "负责人", purpose: "负责汇总", instructions: "先核对证据",
        recommendedSkillRefs: [{ skillId: "review", version: "immutable-version-1", contentDigest: "a".repeat(64) }] };
      const role = await catalog.roles.create(access, editable);
      assert.equal(role.revision, 1); assert.ok(role.roleTemplateId);
      assert.deepEqual([...ROLE_CAPABILITIES.member], capabilities);
      assert.equal((await f.repos.agents.list()).length, 0); assert.equal((await f.repos.projects.list()).length, 0);
      const writes = await Promise.allSettled([
        catalog.roles.update(access, role.roleTemplateId, 1, { ...editable, name: "实施者" }),
        catalog.roles.update(access, role.roleTemplateId, 1, { ...editable, name: "评审者" }),
      ]);
      assert.equal(writes.filter(row => row.status === "fulfilled").length, 1);
      const rejected = writes.find(row => row.status === "rejected");
      assert.match(String(rejected?.status === "rejected" && rejected.reason), /role_revision_conflict/);
      assert.deepEqual(await catalog.roles.getVersion(role.roleTemplateId, 1), role);
      assert.equal((await catalog.roles.get(role.roleTemplateId))?.revision, 2);
      const entries = await f.repos.audit.listUser();
      assert.equal(entries.length, 2);
      assert.ok(entries.every(entry => entry.scope === "user" && entry.projectId === null));
      assert.deepEqual(await f.repos.audit.list("made-up-project"), []);
      assert.deepEqual(await f.db.query("SELECT * FROM agent_runtimes"), []);
      await assert.rejects(catalog.roles.create({ actor: { ...ownerActor(), kind: "agent" } },
        { name: "owner", purpose: "", instructions: "", recommendedSkillRefs: [] }), /仅本地用户/);
    } finally { await f.close(); }
  });
  test(`${engine} 复制固定历史版本，归档保留引用；在用删除拒绝，未使用删除保留审计`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const catalog = createIdentityCatalog({ repos: f.repos }), access = { actor: ownerActor() };
      const fields = { name: "原角色", purpose: "原职责", instructions: "原指令", recommendedSkillRefs: [] };
      const original = await catalog.roles.create(access, fields);
      const copied = await catalog.roles.copy(access, original.roleTemplateId, 1, "已固定副本");
      assert.notEqual(copied.roleTemplateId, original.roleTemplateId);
      assert.deepEqual(copied.copiedFrom, { roleTemplateId: original.roleTemplateId, revision: 1 });
      await catalog.roles.update(access, original.roleTemplateId, 1, { ...fields, instructions: "原角色后来修改" });
      assert.equal((await catalog.roles.get(copied.roleTemplateId))!.instructions, "原指令");
      const archived = await catalog.roles.archive(access, original.roleTemplateId, 2);
      assert.equal(archived.revision, 3); assert.ok(archived.archivedAt);
      assert.equal((await catalog.roles.list()).length, 1); assert.equal((await catalog.roles.list(true)).length, 2);
      const impact = await catalog.roles.deleteImpact(original.roleTemplateId);
      assert.equal(impact.deletable, false); assert.deepEqual(impact.allowedActions, ["archive"]);
      assert.deepEqual(impact.references, [{ kind: "role-copy", roleTemplateId: copied.roleTemplateId, revision: 1, sourceRevision: 1 }]);
      await assert.rejects(catalog.roles.remove(access, original.roleTemplateId, 3), /role_template_in_use/);
      assert.equal((await catalog.roles.getVersion(original.roleTemplateId, 1))!.instructions, "原指令");
      const restored = await catalog.roles.restore(access, original.roleTemplateId, 3);
      assert.equal(restored.revision, 4); assert.equal(restored.archivedAt, null);
      const unused = await catalog.roles.create(access, { ...fields, name: "从未使用" });
      assert.equal((await catalog.roles.deleteImpact(unused.roleTemplateId)).deletable, true);
      await assert.rejects(catalog.roles.remove(access, unused.roleTemplateId, 2), /role_revision_conflict/);
      await catalog.roles.remove(access, unused.roleTemplateId, 1);
      assert.equal(await catalog.roles.get(unused.roleTemplateId), null);
      assert.equal((await f.repos.audit.listUser({ targetId: unused.roleTemplateId })).length, 2);
      assert.equal((await f.repos.projects.list()).length, 0);
    } finally { await f.close(); }
  });

  test(`${engine} 目录对托管 Agent 改名/加 alias 只写身份和 user 审计，不消费配置意图`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      const catalog = createIdentityCatalog({ repos: f.repos }), access = { actor: ownerActor() };
      const project = await f.repos.projects.create({ name: "原项目" }), group = await f.repos.groups.create({ projectId: project.id, name: "原群" });
      const runtimes = createRuntimeRepository(f.db, { repos: f.repos });
      const runtime = await runtimes.create({ name: "原托管名", backend: "claude-code", defaults: { workdir: f.dir, model: "old" },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      const bindingId = runtime.bindings[0]!.binding.id;
      await runtimes.intent(bindingId, "start");
      await runtimes.updateDefaults(runtime.runtime.id, 1, { workdir: f.dir, model: "pending" });
      const tables = ["agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "members"];
      const before = await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`)));
      const updated = await catalog.agents.rename(access, runtime.runtime.agentId, "原托管名", "用户改名");
      assert.equal(updated.agent.id, runtime.runtime.agentId); assert.equal(updated.agent.displayName, "用户改名");
      await catalog.agents.addAlias(access, runtime.runtime.agentId, { displayName: "明确接入名", hostType: "claude-code" });
      assert.deepEqual(await Promise.all(tables.map(table => f.db.query(`SELECT * FROM ${table} ORDER BY 1`))), before);
      assert.equal((await runtimes.getBinding(bindingId))!.pendingChanges, true);
      assert.equal((await f.repos.audit.listUser()).length, 2);
      assert.deepEqual(await f.repos.audit.list(project.id), []);
      const persistedAudit = f.repos.audit.appendUser;
      f.repos.audit.appendUser = async () => { throw new Error("audit persistence unavailable"); };
      await assert.rejects(catalog.agents.rename(access, runtime.runtime.agentId, "用户改名", "必须回滚"), /audit persistence unavailable/);
      f.repos.audit.appendUser = persistedAudit;
      assert.equal((await f.repos.agents.get(runtime.runtime.agentId))!.displayName, "用户改名");
      assert.equal(await f.repos.agents.findByIdentity("必须回滚", "claude-code"), null);
    } finally { await f.close(); }
  });
}

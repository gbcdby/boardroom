import test from "node:test";
import assert from "node:assert/strict";
import { ownerActor } from "../../src/server/authz/actors.ts";
import { actorForMember } from "../../src/server/authz/actors.ts";
import { ForbiddenError } from "../../src/server/authz/authorize.ts";
import { ConflictError, InvalidArgumentError, InvalidReferenceError } from "../../src/server/db/errors.ts";
import { createProfileConfigService } from "../../src/server/identity/profile-config-service.ts";
import { identityFixture, identitySkip } from "../helpers/identity-fixture.ts";

const access = { actor: ownerActor() };
const profileContent = {
  preferredHost: null,
  model: "model-a",
  instructions: "",
  defaultRoleRef: null,
  skillSelection: [],
  toolSelection: [],
  memorySelection: [],
  maxConcurrentInstances: 1,
  legacyCompatibility: null,
};
const nextProfileContent = { ...profileContent, model: "model-b" };
const bindingContent = { roleRef: null, profileOverrides: {} };

async function fixture(engine: "sqlite" | "postgres") {
  const f = await identityFixture(engine, 22);
  const agent = await f.repos.agents.create({ displayName: "配置主体", hostType: "claude-code" });
  const project = await f.repos.projects.create({ name: "配置项目" });
  const group = await f.repos.groups.create({ projectId: project.id, name: "配置群" });
  const member = await f.repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: "配置成员" });
  await f.repos.groups.addParticipant(group.id, member.id);
  return { ...f, agent, project, group, member, service: createProfileConfigService({ db: f.db }) };
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} B1a 头/不可变版本/compat 映射/回执审计同事务落库`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      const first = await f.service.createProfile(access, { agentId: f.agent.id, content: profileContent, mutationId: "m-profile-1" });
      assert.equal(first.revision, 1);
      assert.match(first.contentDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual(await f.service.getProfile(f.agent.id), first);

      const second = await f.service.saveProfile(access, { agentId: f.agent.id, expectedRevision: 1,
        content: nextProfileContent, mutationId: "m-profile-2" });
      assert.equal(second.revision, 2);
      assert.notEqual(second.contentDigest, first.contentDigest);
      assert.deepEqual(await f.service.getProfile(f.agent.id), second);
      assert.deepEqual(await f.service.getProfileVersion(f.agent.id, 1), first, "历史版本不可改写");
      const versions = await f.service.listProfileVersions(f.agent.id);
      assert.deepEqual(versions.map(v => v.revision), [1, 2]);
      assert.deepEqual((await f.service.listCompatMappings("profile", f.agent.id)).map(m => [m.revision, m.compatRevision]), [[1, 1], [2, 2]]);
      const receipt = await f.service.getReceipt("m-profile-2");
      assert.ok(receipt);
      assert.equal(receipt!.operation, "profile.save");
      assert.equal((receipt!.result as { readonly saved: { readonly ref: { readonly contentDigest: string } } }).saved.ref.contentDigest, second.contentDigest);
      const audit = await f.service.getAudit(receipt!.auditId);
      assert.ok(audit);
      assert.equal(audit!.mutationId, "m-profile-2");
      assert.equal(audit!.targetKind, "profile");
      const counts = await f.db.query("SELECT (SELECT COUNT(*) FROM agent_profiles) AS heads, (SELECT COUNT(*) FROM agent_profile_versions) AS versions, (SELECT COUNT(*) FROM config_compat_revisions) AS compat, (SELECT COUNT(*) FROM config_mutation_receipts) AS receipts, (SELECT COUNT(*) FROM config_mutation_audit) AS audit");
      assert.deepEqual(Object.values(counts[0]!).map(Number), [1, 2, 2, 2, 2]);
      assert.equal(Object.keys(f.service).some(name => /delete|update|remove|purge/i.test(name)), false, "无历史写接口");
    } finally { await f.close(); }
  });

  test(`${engine} B1a CAS 只成功一个，失败不留下半版本或回执`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await f.service.createProfile(access, { agentId: f.agent.id, content: profileContent, mutationId: "m-cas-0" });
      const results = await Promise.allSettled([
        f.service.saveProfile(access, { agentId: f.agent.id, expectedRevision: 1, content: nextProfileContent, mutationId: "m-cas-a" }),
        f.service.saveProfile(access, { agentId: f.agent.id, expectedRevision: 1, content: profileContent, mutationId: "m-cas-b" }),
      ]);
      assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
      const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      assert.equal(rejected.reason instanceof ConflictError, true);
      assert.equal((await f.service.getProfile(f.agent.id))!.revision, 2);
      assert.equal((await f.service.listProfileVersions(f.agent.id)).length, 2);
      const fulfilledIndex = results.findIndex(r => r.status === "fulfilled");
      const casIds = ["m-cas-a", "m-cas-b"] as const;
      const expectedReceipts = ["m-cas-0", casIds[fulfilledIndex]!];
      const receipts = await f.db.query("SELECT mutation_id FROM config_mutation_receipts ORDER BY mutation_id");
      assert.deepEqual(receipts.map(r => r.mutation_id).sort(), expectedReceipts.sort());
      assert.equal(receipts.length, 2, "冲突方不写回执");
    } finally { await f.close(); }
  });

  test(`${engine} B1a 权限与注入检查在内部服务层，Binding 作用域不可跨项目`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await assert.rejects(f.service.createProfile({ actor: actorForMember({ id: f.member.id, projectId: f.project.id,
        kind: "agent", role: "normal" }) }, { agentId: f.agent.id, content: profileContent, mutationId: "m-denied" }), ForbiddenError);
      await assert.rejects(f.service.createProfile(access, { agentId: f.agent.id,
        content: { ...profileContent, injected: true }, mutationId: "m-injected" }), InvalidArgumentError);
      const polluted = JSON.parse(`${JSON.stringify(profileContent).slice(0, -1)},"__proto__":{"injected":true}}`);
      await assert.rejects(f.service.createProfile(access, { agentId: f.agent.id, content: polluted, mutationId: "m-polluted" }), InvalidArgumentError);
      const created = await f.service.createProfile(access, { agentId: f.agent.id, content: profileContent, mutationId: "m-ok" });
      assert.equal(created.revision, 1);
      await assert.rejects(f.service.createBinding(access, { bindingId: "binding-wrong", agentId: f.agent.id,
        projectId: f.project.id, groupId: "missing-group", memberId: f.member.id, content: bindingContent,
        mutationId: "m-wrong-scope" }), InvalidReferenceError);
      const binding = await f.service.createBinding(access, { bindingId: "binding-1", agentId: f.agent.id,
        projectId: f.project.id, groupId: f.group.id, memberId: f.member.id, content: bindingContent, mutationId: "m-binding-1" });
      assert.equal(binding.revision, 1);
      const saved = await f.service.saveBinding(access, { bindingId: "binding-1", expectedRevision: 1,
        content: { roleRef: null, profileOverrides: { model: "binding-model" } }, mutationId: "m-binding-2" });
      assert.equal(saved.revision, 2);
      assert.deepEqual((await f.service.listCompatMappings("binding", "binding-1")).map(m => [m.revision, m.compatRevision]), [[1, 1], [2, 2]]);
      assert.equal((await f.service.getReceipt("m-binding-2"))!.operation, "binding.save");
      assert.equal((await f.service.getAudit((await f.service.getReceipt("m-binding-2"))!.auditId))!.targetKind, "binding");
    } finally { await f.close(); }
  });

  test(`${engine} B1a 回执/审计冲突时整事务回滚，当前头与 compat 不前进`, { skip: identitySkip(engine) }, async () => {
    const f = await fixture(engine);
    try {
      await f.service.createProfile(access, { agentId: f.agent.id, content: profileContent, mutationId: "m-same" });
      await assert.rejects(f.service.saveProfile(access, { agentId: f.agent.id, expectedRevision: 1,
        content: nextProfileContent, mutationId: "m-same" }));
      assert.equal((await f.service.getProfile(f.agent.id))!.revision, 1);
      assert.equal((await f.service.listProfileVersions(f.agent.id)).length, 1);
      assert.equal((await f.service.listCompatMappings("profile", f.agent.id)).length, 1);
      const rows = await f.db.query("SELECT (SELECT COUNT(*) FROM config_mutation_receipts) AS receipts, (SELECT COUNT(*) FROM config_mutation_audit) AS audit");
      assert.deepEqual(Object.values(rows[0]!).map(Number), [1, 1]);
    } finally { await f.close(); }
  });
}

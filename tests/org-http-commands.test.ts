import test from "node:test";
import assert from "node:assert/strict";
import { createOrgHttpCommands } from "../src/server/org/http-commands.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { actorForMember, ownerActor } from "../src/server/authz/actors.ts";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";

const owner = { actor: ownerActor() };
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" ? pgUnavailable : false;
  test(`${engine} S5-AUDIT：无组织树的manager更换用完整指派快照，连续五次翻转保留独立姓名`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "兼容负责人" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "旧负责人", role: "manager" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "新负责人" });
    const commands = createOrgHttpCommands({ repos }); const compensation = createAuditCompensationService({ repos });
    const changed = await commands.setManager(owner, p.id, next.id);
    assert.equal(changed.member.role, "manager"); assert.ok(changed.auditId);
    const original = (await repos.audit.get(p.id, changed.auditId))!;
    assert.equal(original.action, "org.assign"); assert.equal(original.targetId, next.id);
    assert.deepEqual(JSON.parse(original.before!).assignments.map((item: { memberId: string }) => item.memberId), [old.id, next.id].sort());
    assert.equal((await repos.members.get(old.id))!.role, "normal");
    assert.equal((await commands.setManager(owner, p.id, next.id)).auditId, null);
    await repos.members.update(next.id, { displayName: "另改姓名" });
    let latest = original;
    for (let i = 0; i < 5; i++) {
      const undone = await compensation.revoke(owner, p.id, latest.id);
      assert.equal(JSON.parse(undone.detail!).reversal.undoesAuditId, latest.id);
      assert.equal(JSON.parse(undone.detail!).reversal.rootAuditId, original.id);
      assert.equal((await repos.members.get(old.id))!.role, i % 2 === 0 ? "manager" : "normal");
      assert.equal((await repos.members.get(next.id))!.role, i % 2 === 0 ? "normal" : "manager");
      assert.equal((await repos.members.get(next.id))!.displayName, "另改姓名");
      latest = undone;
    }
    assert.equal((await repos.audit.list(p.id)).length, 6);
  }, engine));

  test(`${engine} S5-AUDIT：已有根占岗时整组换人只写一条审计，连续翻转及后续占岗冲突`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "根岗位负责人" });
    const root = await repos.org.createNode({ projectId: p.id, name: "统筹", role: "top_manager" });
    const child = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "原岗位", role: "member" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "前任" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "继任" });
    const outsider = await repos.members.create({ projectId: p.id, kind: "human", displayName: "后续占岗者" });
    await repos.org.assignNode(old.id, root.id); await repos.org.assignNode(next.id, child.id);
    const commands = createOrgHttpCommands({ repos }); const compensation = createAuditCompensationService({ repos });
    const changed = await commands.setManager(owner, p.id, next.id); assert.ok(changed.auditId);
    assert.equal(changed.member.nodeId, root.id); assert.equal(changed.member.role, "manager");
    assert.equal((await repos.members.get(old.id))!.nodeId, null); assert.equal((await repos.members.get(old.id))!.role, "normal");
    assert.equal((await commands.setManager(owner, p.id, next.id)).auditId, null);
    assert.equal((await repos.audit.list(p.id)).length, 1);
    await repos.members.update(old.id, { displayName: "前任独立姓名" }); await repos.members.update(next.id, { displayName: "继任独立姓名" });
    let latest = (await repos.audit.get(p.id, changed.auditId))!;
    for (let i = 0; i < 6; i++) {
      const priorId = latest.id; latest = await compensation.revoke(owner, p.id, priorId);
      assert.equal(JSON.parse(latest.detail!).reversal.undoesAuditId, priorId);
      assert.equal((await repos.members.get(old.id))!.nodeId, i % 2 === 0 ? root.id : null);
      assert.equal((await repos.members.get(next.id))!.nodeId, i % 2 === 0 ? child.id : root.id);
      assert.equal((await repos.members.getManager(p.id))!.id, i % 2 === 0 ? old.id : next.id);
      assert.equal((await repos.members.get(old.id))!.displayName, "前任独立姓名");
      assert.equal((await repos.members.get(next.id))!.displayName, "继任独立姓名");
    }
    await repos.org.assignNode(outsider.id, child.id);
    await assert.rejects(compensation.revoke(owner, p.id, latest.id), { code: "compensation_conflict" });
    assert.equal((await repos.members.get(outsider.id))!.nodeId, child.id);
    assert.equal((await repos.audit.get(p.id, latest.id))!.reversedAt, null);
    assert.equal((await repos.audit.list(p.id)).length, 7);
  }, engine));

  test(`${engine} S5-AUDIT：清岗锁内读取当前占岗者，空岗不写audit且不会误清旧成员新岗位`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "清空岗位" });
    const root = await repos.org.createNode({ projectId: p.id, name: "统筹", role: "top_manager" });
    const slot = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "待清岗位", role: "member" });
    const elsewhere = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "新岗位", role: "member" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "原占岗者" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "现占岗者" });
    const commands = createOrgHttpCommands({ repos }), mutations = createOrgMutationService({ repos });
    assert.deepEqual(await commands.clearNode(owner, p.id, slot.id), { member: null, auditId: null });
    assert.equal((await repos.audit.list(p.id)).length, 0);
    await repos.org.assignNode(old.id, slot.id);
    const cleared = await commands.clearNode(owner, p.id, slot.id); assert.equal(cleared.member?.id, old.id); assert.equal(cleared.member?.nodeId, null); assert.ok(cleared.auditId);
    await createAuditCompensationService({ repos }).revoke(owner, p.id, cleared.auditId);
    let changed = false;
    const access = { actor: owner.actor, runMutation: async <T>(body: () => Promise<T>): Promise<T> => {
      if (!changed) {
        changed = true;
        await mutations.assignNode(owner, p.id, old.id, elsewhere.id);
        await mutations.assignNode(owner, p.id, next.id, slot.id);
      }
      return body();
    } };
    const current = await commands.clearNode(access, p.id, slot.id);
    assert.equal(current.member?.id, next.id); assert.equal(current.member?.nodeId, null);
    assert.equal((await repos.members.get(old.id))!.nodeId, elsewhere.id);
    const manager = await commands.setManager(owner, p.id, next.id);
    assert.equal(manager.member.nodeId, root.id); assert.equal(manager.member.role, "manager");
    const emptyRoot = await commands.clearNode(owner, p.id, root.id);
    assert.equal(emptyRoot.member?.role, "normal"); assert.equal(await repos.members.getManager(p.id), null);
  }, engine));

  test(`${engine} S5-AUDIT：空岗也复核权限，旧manager主体在降级后不能继续换人`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "锁内权限" });
    const root = await repos.org.createNode({ projectId: p.id, name: "统筹", role: "top_manager" });
    const slot = await repos.org.createNode({ projectId: p.id, parentId: root.id, name: "空岗", role: "member" });
    const agent = await repos.agents.create({ displayName: "旧授权", hostType: "other" });
    const manager = await repos.members.create({ projectId: p.id, agentId: agent.id, kind: "agent", displayName: "旧授权" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "候选人" });
    await repos.org.assignNode(manager.id, root.id);
    const commands = createOrgHttpCommands({ repos }), mutations = createOrgMutationService({ repos });
    const denied = { actor: { ...ownerActor(p.id), role: "member" as const } };
    await assert.rejects(commands.clearNode(denied, p.id, slot.id), { name: "ForbiddenError" });
    assert.equal((await repos.audit.list(p.id)).length, 0);
    let demoted = false;
    const stale = { actor: actorForMember((await repos.members.get(manager.id))!), runMutation: async <T>(body: () => Promise<T>): Promise<T> => {
      if (!demoted) { demoted = true; await mutations.assignNode(owner, p.id, manager.id, null); }
      return body();
    } };
    await assert.rejects(commands.setManager(stale, p.id, next.id), { name: "ForbiddenError" });
    assert.equal((await repos.members.get(next.id))!.role, "normal");
    assert.equal((await repos.audit.list(p.id)).length, 1, "只有先发生的降级记录，不能提交被拒绝的换人");
    await assert.rejects(commands.clearNode({ actor: { ...stale.actor, role: "owner" } }, p.id, slot.id), { name: "ForbiddenError" });
    await repos.projects.archive(p.id);
    await assert.rejects(commands.clearNode(owner, p.id, slot.id), { code: "archived" });
  }, engine));

  test(`${engine} S5-AUDIT：审计失败原子回滚legacy/root整组与清岗，取消不提交`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "原子回滚" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "旧", role: "manager" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "新" });
    const commands = createOrgHttpCommands({ repos });
    const append = repos.audit.append; repos.audit.append = async () => { throw new Error("injected audit failure"); };
    try {
      await assert.rejects(commands.setManager(owner, p.id, next.id), { code: "write_failed" });
      assert.equal((await repos.members.getManager(p.id))!.id, old.id);
      const root = await repos.org.createNode({ projectId: p.id, name: "统筹", role: "top_manager" });
      await repos.org.assignNode(old.id, root.id);
      await assert.rejects(commands.setManager(owner, p.id, next.id), { code: "write_failed" });
      await assert.rejects(commands.clearNode(owner, p.id, root.id), { code: "write_failed" });
      assert.equal((await repos.members.get(old.id))!.nodeId, root.id); assert.equal((await repos.members.getManager(p.id))!.id, old.id);
      assert.equal((await repos.members.get(next.id))!.nodeId, null); assert.equal((await repos.members.get(next.id))!.role, "normal");
      assert.equal((await repos.audit.list(p.id)).length, 0);
    } finally { repos.audit.append = append; }
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(commands.setManager({ actor: owner.actor, signal: cancelled.signal }, p.id, next.id), { code: "audit_capture_budget_exceeded" });
    assert.equal((await repos.audit.list(p.id)).length, 0);
  }, engine));

  test(`${engine} S5-AUDIT：固定32KiB快照及真实500ms预算在业务写前拒绝`, { skip }, async () => memoryFixture(async repos => {
    const p = await repos.projects.create({ name: "预算边界" });
    const old = await repos.members.create({ projectId: p.id, kind: "human", displayName: "原负责人", role: "manager" });
    const next = await repos.members.create({ projectId: p.id, kind: "human", displayName: "候选人" });
    const commands = createOrgHttpCommands({ repos, now: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 510);
      return new Date();
    } });
    await assert.rejects(commands.setManager(owner, p.id, next.id), { code: "audit_capture_budget_exceeded" });
    const longId = await repos.members.create({ id: "large-id-" + "x".repeat(33000), projectId: p.id, kind: "human", displayName: "过长历史标识" });
    await assert.rejects(createOrgHttpCommands({ repos }).setManager(owner, p.id, longId.id), { code: "audit_snapshot_too_large" });
    assert.equal((await repos.members.getManager(p.id))!.id, old.id); assert.equal((await repos.members.get(next.id))!.role, "normal");
    assert.equal((await repos.audit.list(p.id)).length, 0);
  }, engine));
}

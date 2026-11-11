import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryKey } from "../src/shared/memory.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { actorForMember } from "../src/server/authz/actors.ts";
import { WriteFailedError } from "../src/server/db/errors.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const reader = { readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: DEFAULT_MEMORY_CONFIG.maxInjectedBytes }), close: async () => {} };
for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} AC-MEM-02/05：人工版本、丢响应重放、同 mutation 不同内容拒绝及同 ACL 版本详情`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const key: MemoryKey = { scope: "project", projectId: p.project.id, agentId: null };
    assert.deepEqual(await service.read(p.owner, key), { document: null, version: 0 });
    assert.deepEqual(await service.list(p.owner, p.project.id), []);
    const first = await service.write(p.owner, key, { expectedVersion: 0, clientMutationId: "first", markdown: "# 项目约定\n保持原文 🧠" });
    assert.equal(first.document.version, 1); assert.equal(first.document.source, "human"); assert.equal(first.duplicate, false);
    const next = await service.write(p.owner, key, { expectedVersion: 1, clientMutationId: "next", markdown: "人工修订" });
    assert.equal(next.document.version, 2);
    const repeated = await service.write(p.owner, key, { expectedVersion: 0, clientMutationId: "first", markdown: first.document.markdown });
    assert.equal(repeated.duplicate, true); assert.equal(repeated.document.version, 2); assert.equal(repeated.writtenVersion.version, 1);
    await assert.rejects(service.write(p.owner, key, { expectedVersion: 0, clientMutationId: "first", markdown: "不是原请求" }), { reason: "memory_mutation_conflict" });
    await assert.rejects(service.write(p.owner, key, { expectedVersion: 1, clientMutationId: "stale", markdown: "旧版本" }), { reason: "memory_version_conflict" });
    assert.deepEqual(await service.readVersion(p.owner, key, 1), first.writtenVersion);
    assert.equal(await service.readVersion(p.owner, key, 99), null);
    assert.deepEqual((await service.history(p.owner, key, 2)).map(v => v.version), [1]);
    assert.equal((await repos.audit.list(p.project.id)).filter(row => row.action === "memory.updated").length, 2);
    assert.equal(JSON.stringify(await repos.audit.list(p.project.id)).includes(first.document.markdown), false);
    const global: MemoryKey = { scope: "global", projectId: null, agentId: p.agent.id };
    await assert.rejects(service.read(p.owner, global), { name: "ForbiddenError" });
    await assert.rejects(service.readVersion(p.owner, global, 1), { name: "ForbiddenError" });
    for (let version = 3; version <= 23; version++) await service.write(p.owner, key, { expectedVersion: version - 1, clientMutationId: `v${version}`, markdown: String(version) });
    assert.equal((await service.history(p.owner, key)).length, 20);
    assert.equal((await service.readVersion(p.owner, key, 1))?.markdown, first.document.markdown);
  }, engine));

  test(`${engine} AC-MEM-01/02/03/06：三层 ACL、当前岗位子树和失活目标维护`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const global: MemoryKey = { scope: "global", projectId: null, agentId: p.agent.id };
    await service.write(p.own, global, { expectedVersion: 0, clientMutationId: "private", markdown: "仅本体的全局事实" });
    await assert.rejects(service.read(p.foreign, global), { name: "ForbiddenError" });
    await assert.rejects(service.history(p.owner, global), { name: "ForbiddenError" });
    await assert.rejects(service.write(p.owner, global, { expectedVersion: 1, clientMutationId: "forged", markdown: "owner 越权" }), { name: "ForbiddenError" });
    assert.equal((await repos.audit.list(p.project.id)).length, 0);
    assert.deepEqual(await service.list(p.owner, p.project.id), []);
    const second = await repos.projects.create({ name: "第二项目" });
    const secondMember = await repos.members.create({ projectId: second.id, agentId: p.agent.id, kind: "agent", displayName: p.agent.displayName });
    const secondGroup = await repos.groups.create({ projectId: second.id, name: "第二群", participantMemberIds: [secondMember.id] });
    const secondAccess = { actor: actorForMember(secondMember), connection: { projectId: second.id, memberId: secondMember.id, groupId: secondGroup.id, membershipRevision: secondMember.membershipRevision } };
    assert.equal((await service.read(secondAccess, global)).document?.markdown, "仅本体的全局事实");
    const own: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    await service.write(p.own, own, { expectedVersion: 0, clientMutationId: "own", markdown: "项目私有" });
    await assert.rejects(service.read(secondAccess, own), { name: "ForbiddenError" });
    await assert.rejects(service.read(p.foreign, own), { name: "ForbiddenError" });
    await assert.rejects(service.readVersion(p.foreign, own, 1), { name: "ForbiddenError" });
    assert.deepEqual(await service.list(p.foreign, p.project.id), []);
    const shared: MemoryKey = { scope: "project", projectId: p.project.id, agentId: null };
    await service.write(p.owner, shared, { expectedVersion: 0, clientMutationId: "shared", markdown: "大家可读" });
    assert.equal((await service.read(p.own, shared)).document?.markdown, "大家可读");
    await assert.rejects(service.write(p.own, shared, { expectedVersion: 1, clientMutationId: "no", markdown: "普通成员不可写" }), { name: "ForbiddenError" });
    const root = await repos.org.createNode({ projectId: p.project.id, name: "管理", role: "top_manager" });
    const sub = await repos.org.createNode({ projectId: p.project.id, parentId: root.id, name: "子树管理", role: "sub_manager" });
    const leaf = await repos.org.createNode({ projectId: p.project.id, parentId: sub.id, name: "成员", role: "member" });
    await repos.org.assignNode(p.outsider.id, sub.id); await repos.org.assignNode(p.member.id, leaf.id);
    await service.write(p.foreign, shared, { expectedVersion: 1, clientMutationId: "manager-shared", markdown: "下级 manager 维护共享" });
    assert.equal((await service.read(p.foreign, own)).document?.markdown, "项目私有");
    await assert.rejects(service.read(p.foreign, global), { name: "ForbiddenError" });
    await repos.members.setStatus(p.member.id, "disabled");
    const managed = await service.write(p.foreign, own, { expectedVersion: 1, clientMutationId: "maintain", markdown: "失活目标仍可维护" });
    assert.equal(managed.document.source, "manager");
    await assert.rejects(service.read(p.own, own), { name: "ForbiddenError" });
    await repos.org.updateNode(sub.id, { role: "member" });
    await assert.rejects(service.read(p.foreign, own), { name: "ForbiddenError" });
    await repos.projects.archive(p.project.id);
    assert.equal((await service.read(p.owner, own)).document?.version, 2);
    await assert.rejects(service.write(p.owner, own, { expectedVersion: 2, clientMutationId: "archived", markdown: "禁止" }), { code: "archived" });
  }, engine));

  test(`${engine} AC-MEM-05/07：版本与 audit 失败全回滚，两个相同基准只成功一次`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const key: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    const appendVersion = repos.memory.insertVersion;
    repos.memory.insertVersion = async () => { throw new WriteFailedError("注入版本失败"); };
    await assert.rejects(service.write(p.own, key, { expectedVersion: 0, clientMutationId: "failed", markdown: "不应留存" }), { code: "write_failed" });
    repos.memory.insertVersion = appendVersion;
    assert.equal((await service.read(p.own, key)).document, null);
    const first = await service.write(p.own, key, { expectedVersion: 0, clientMutationId: "first", markdown: "原内容" });
    const appendAudit = repos.audit.append;
    repos.audit.append = async () => { throw new WriteFailedError("注入审计失败"); };
    await assert.rejects(service.write(p.own, key, { expectedVersion: 1, clientMutationId: "audit-fail", markdown: "也不能留存" }), { code: "write_failed" });
    repos.audit.append = appendAudit;
    assert.equal((await service.read(p.own, key)).document?.markdown, first.document.markdown);
    assert.equal((await service.history(p.own, key)).length, 1);
    const concurrent = await Promise.allSettled(["A", "B"].map(markdown => service.write(p.own, key, { expectedVersion: 1, clientMutationId: markdown, markdown })));
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await service.read(p.own, key)).version, 2);
  }, engine));

  test(`${engine} AC-MEM-03：离项目保留文档可维护，不为从未加入的 Agent 跨域造文档`, { skip: engine === "postgres" ? pgUnavailable : false }, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const unjoined = await repos.agents.create({ displayName: "未加入本项目", hostType: "codex-cli" });
    const unknown: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: unjoined.id };
    await assert.rejects(service.write(p.owner, unknown, { expectedVersion: 0, clientMutationId: "outside", markdown: "不创建无项目归属的记忆" }), { code: "not_found" });
    const key: MemoryKey = { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id };
    const original = await service.write(p.owner, key, { expectedVersion: 0, clientMutationId: "before-leaving", markdown: "项目历史" });
    await createOrgMutationService({ repos }).removeMember({ actor: p.owner.actor }, p.project.id, p.member.id);
    assert.equal(await repos.members.get(p.member.id), null);
    assert.ok((await repos.members.getIncludingRemoved(p.member.id))?.removedAt);
    assert.deepEqual((await service.read(p.owner, key)).document, original.document);
    assert.equal((await service.readVersion(p.owner, key, 1))?.markdown, "项目历史");
    await assert.rejects(service.read(p.own, key), { name: "ForbiddenError" });
    assert.equal((await service.write(p.owner, key, { expectedVersion: 1, clientMutationId: "after-leaving", markdown: "离岗后人工维护" })).document.version, 2);
  }, engine));
}

test("AC-MEM-01/07：自动注入仅传可信绑定给 reader，不借主库追加 ACL 查询", async () => memoryFixture(async repos => {
  const p = await memoryPeople(repos); let calls = 0;
  const service = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, readVisibleMessages: async () => [], injectionReader: {
    close: async () => {}, readOwn: async binding => { calls++; assert.equal(binding.memberId, p.member.id); return reader.readOwn(); },
  } });
  repos.members.get = async () => { throw new Error("不得调用共享主库"); };
  repos.projects.get = async () => { throw new Error("不得调用共享主库"); };
  repos.memory.get = async () => { throw new Error("不得调用共享主库"); };
  assert.equal((await service.inject({ ...p.own, injectionBindingGeneration: "binding-1" })).state, "available");
  assert.equal((await service.inject(p.owner)).state, "unavailable");
  assert.equal(calls, 1);
}));

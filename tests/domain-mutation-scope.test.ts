import assert from "node:assert/strict";
import test from "node:test";
import { createTaskService, type TaskAccess } from "../src/server/tasks/service.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import type { MutationDiscover } from "../src/server/db/mutation-scope.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";

const reader = { readOwn: async () => ({ state: "available" as const, entries: [], errors: [], maxBytes: 8192 }), close: async () => {} };
for (const engine of ["sqlite", "postgres"] as const) {
  const gating = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} S5-AUDIT-13：领域计划穿过authority，锁全体目标后task/memory写可嵌套提交`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    let planned = 0;
    const access: TaskAccess = { actor: p.owner.actor,
      runMutation: async <T>(_operation: "write" | "consume", body: () => Promise<T>, discover?: MutationDiscover): Promise<T> => {
        assert.ok(discover, "领域必须把完整目标计划交给最外层authority"); planned++;
        return repos.mutations.run({ projectIds: [p.project.id], discover }, async scope => {
          assert.ok(scope.memberIds.includes(p.member.id));
          return body();
        });
      } };
    const tasks = createTaskService({ repos });
    const task = await tasks.create(access, p.project.id, { title: "共同锁", body: "跨目标引用", assigneeMemberId: p.member.id, reviewerMemberId: p.outsider.id });
    assert.equal(task.assigneeMemberId, p.member.id);
    const memory = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const result = await memory.write(access, { scope: "project-agent", projectId: p.project.id, agentId: p.agent.id },
      { expectedVersion: 0, clientMutationId: "owner", markdown: "锁内人工维护" });
    assert.equal(result.document.version, 1); assert.equal(planned, 2);
  }, engine));

  test(`${engine} S5-AUDIT-09：移除再恢复后旧epoch无法读取或写入，当前新绑定可以`, gating, async () => memoryFixture(async repos => {
    const p = await memoryPeople(repos);
    const old = { ...p.own, connection: { ...p.own.connection!, membershipRevision: p.member.membershipRevision } };
    const tasks = createTaskService({ repos });
    const memory = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG, injectionReader: reader, readVisibleMessages: async () => [] });
    const key = { scope: "project-agent" as const, projectId: p.project.id, agentId: p.agent.id };
    await memory.write(old, key, { expectedVersion: 0, clientMutationId: "before", markdown: "旧周期" });
    await repos.mutations.run({ projectIds: [p.project.id], discover: async () => ({ memberIds: [p.member.id], groupIds: [], runtimeIds: [] }) }, async () => {
      const removed = await repos.members.applyLifecycleCas(p.project.id, p.member.id, p.member.membershipRevision,
        { displayName: p.member.displayName, status: "disabled", role: "normal", nodeId: null, removedAt: new Date().toISOString() }, new Date().toISOString());
      await repos.members.applyLifecycleCas(p.project.id, p.member.id, removed.membershipRevision,
        { displayName: p.member.displayName, status: "active", role: "normal", nodeId: null, removedAt: null }, new Date().toISOString());
    });
    await assert.rejects(memory.read(old, key), { name: "ForbiddenError" });
    await assert.rejects(memory.write(old, key, { expectedVersion: 1, clientMutationId: "late", markdown: "不能恢复旧授权" }), { name: "ForbiddenError" });
    await assert.rejects(tasks.list(old, p.project.id), { name: "ForbiddenError" });
    const current = (await repos.members.get(p.member.id))!;
    const fresh = { ...old, connection: { ...old.connection, membershipRevision: current.membershipRevision } };
    assert.equal((await memory.read(fresh, key)).version, 1); assert.deepEqual(await tasks.list(fresh, p.project.id), []);
  }, engine));
}

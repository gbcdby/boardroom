import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import type { MutationLockPlan, MutationScope } from "../src/server/db/mutation-scope.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";
import { memoryFixture, memoryPgUrl, pgUnavailable } from "./helpers/memory-fixture.ts";

const scopeChanged = (error: unknown) => error instanceof Error && "code" in error && error.code === "mutation_scope_changed";
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" ? pgUnavailable : false;
  test(`${engine} S5-AUDIT-13：runtime member/fence 复用共同scope并在最外层发现业务目标`, { skip }, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "统一运行范围" });
    const group = await repos.groups.create({ projectId: project.id, name: "绑定群" });
    const target = await repos.members.create({ projectId: project.id, kind: "human", displayName: "业务目标" });
    const runtime = createRuntimeRepository(db, { repos });
    const created = await runtime.create({ name: "范围执行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: project.id, groupId: group.id }] });
    const binding = created.bindings[0]!.binding;
    await runtime.withMemberLock(binding.memberId, async () => {
      assert.ok(repos.mutations.current(), "兼容入口本身必须先取得共同项目/成员scope");
      repos.mutations.current()!.assertCovers([project.id], [binding.memberId]);
    });
    await runtime.intent(binding.id, "start");
    const fence = await runtime.claim(binding.id, "scope-test");
    const discover = async () => ({ memberIds: [target.id], groupIds: [], runtimeIds: [] });
    await runtime.withFence(fence, async () => {
      const scope = repos.mutations.current(); assert.ok(scope);
      scope.assertCovers([project.id], [binding.memberId, target.id]);
      await repos.mutations.run({ projectIds: [project.id], discover }, async () => {
        await repos.context.exec("UPDATE members SET display_name = ? WHERE id = ?", ["已处理", target.id]);
      });
    }, {}, discover);
    assert.equal((await repos.members.get(target.id))!.displayName, "已处理");
    await runtime.markExit(fence, { exitCode: 0 });
  }, engine));

  test(`${engine} S5-AUDIT-13：runtime 删除闭包在项目锁前改变时整体回滚，不补拿新项目`, { skip }, async () => memoryFixture(async (repos, db) => {
    const p = await repos.projects.create({ name: "原项目" }); const g = await repos.groups.create({ projectId: p.id, name: "原群" });
    const p2 = await repos.projects.create({ name: "新项目" }); const g2 = await repos.groups.create({ projectId: p2.id, name: "新群" });
    const other = createRuntimeRepository(db, { repos });
    const created = await other.create({ name: "闭包执行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: p.id, groupId: g.id }] });
    let inserted = false;
    const injected: RepositorySet = { ...repos, mutations: {
      current: () => repos.mutations.current(),
      async run<T>(plan: MutationLockPlan, body: (scope: MutationScope) => Promise<T>): Promise<T> {
        if (!inserted) { inserted = true; await other.addBinding(created.runtime.id, { projectId: p2.id, groupId: g2.id }); }
        return repos.mutations.run(plan, body);
      },
    } };
    const runtime = createRuntimeRepository(db, { repos: injected });
    await assert.rejects(runtime.delete(created.runtime.id), scopeChanged);
    assert.ok(inserted); assert.equal((await other.get(created.runtime.id))!.bindings.length, 2);
    await other.delete(created.runtime.id); assert.equal(await other.get(created.runtime.id), null);
  }, engine));

  test(`${engine} S5-AUDIT-09/13：removed阻止运行与重新绑定，清理退出仍保留真实fence`, { skip }, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "撤销执行" }); const group = await repos.groups.create({ projectId: project.id, name: "执行群" });
    const runtime = createRuntimeRepository(db, { repos });
    const created = await runtime.create({ name: "撤销运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: project.id, groupId: group.id }] });
    const binding = created.bindings[0]!.binding;
    await runtime.intent(binding.id, "start"); const fence = await runtime.claim(binding.id, "revocation-test");
    // Fault injection creates a valid tombstone while an old fence still exists; cleanup must remain possible.
    await db.exec("UPDATE members SET removed_at = ?, status = 'disabled', membership_revision = membership_revision + 1 WHERE id = ?", [new Date().toISOString(), binding.memberId]);
    assert.equal(await runtime.isScopeActive(binding.id), false);
    await assert.rejects(runtime.withFence(fence, async () => assert.fail("撤销后不能执行新业务")), /member_removed/);
    await runtime.intent(binding.id, "stop"); await runtime.markExit(fence, { exitCode: 0 });
    await runtime.removeBinding(binding.id);
    await assert.rejects(runtime.addBinding(created.runtime.id, { projectId: project.id, groupId: group.id }), /member_removed/);
    await assert.rejects(runtime.withMemberLock(binding.memberId, () => runtime.assertExternalJoinAllowed(binding.memberId)), /member_removed/);
    assert.equal((await repos.members.getIncludingRemoved(binding.memberId))!.membershipRevision, 2);
    assert.equal((await runtime.get(created.runtime.id))!.bindings.length, 0);
  }, engine));

  test(`${engine} S5-AUDIT-13：仅改全局默认持runtime scope，随后不能反向追加项目锁`, { skip }, async () => memoryFixture(async (repos, db) => {
    const p = await repos.projects.create({ name: "默认配置" }); const g = await repos.groups.create({ projectId: p.id, name: "群" });
    const runtime = createRuntimeRepository(db, { repos });
    const created = await runtime.create({ name: "默认执行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: p.id, groupId: g.id }] });
    await db.transaction(async () => {
      await runtime.updateDefaults(created.runtime.id, 1, { workdir: process.cwd(), model: "new-model" });
      await assert.rejects(repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => {}), scopeChanged);
    });
    assert.equal((await runtime.get(created.runtime.id))!.runtime.revision, 2);
  }, engine));
}

test("postgres S5-AUDIT-13：真实成员锁竞争不持runtime等待project，取消预算内无锁序环", { skip: pgUnavailable }, async () => memoryFixture(async (repos, db) => {
  const project = await repos.projects.create({ name: "锁序竞争" }); const group = await repos.groups.create({ projectId: project.id, name: "群" });
  const runtime = createRuntimeRepository(db, { repos });
  const created = await runtime.create({ name: "锁序运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: project.id, groupId: group.id }] });
  const binding = created.bindings[0]!.binding;
  const schema = String((await db.query("SELECT current_schema() AS name"))[0]!.name);
  assert.match(schema, /^[A-Za-z_][A-Za-z0-9_]*$/);
  const holder = new Client({ connectionString: memoryPgUrl }); await holder.connect();
  let pending: Promise<{ error: unknown | null }> | null = null;
  try {
    await holder.query(`SET search_path TO "${schema}"`); await holder.query("BEGIN");
    await holder.query("SET LOCAL lock_timeout='250ms'");
    await holder.query("UPDATE projects SET updated_at=updated_at WHERE id=$1", [project.id]);
    await holder.query("UPDATE members SET updated_at=updated_at WHERE id=$1", [binding.memberId]);
    let reportPid!: (pid: number) => void; const workerPid = new Promise<number>(resolve => { reportPid = resolve; });
    pending = db.transaction(async () => {
      reportPid(Number((await db.query("SELECT pg_backend_pid() AS pid"))[0]!.pid));
      await runtime.updateBinding(binding.id, { runtimeRevision: 1, bindingRevision: 1, overrides: { model: "same-lock-order" } });
    }).then(() => ({ error: null }), error => ({ error }));
    const pid = await workerPid; let waiting = false;
    for (let i = 0; i < 200; i++) {
      await holder.query("SELECT pg_stat_clear_snapshot()");
      waiting = (await holder.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type === "Lock";
      if (waiting) break; await delay(5);
    }
    assert.ok(waiting, "真实worker应等待被持有的项目/成员锁");
    // An old runtime-first implementation holds this row while waiting for the member,
    // producing an actual PostgreSQL lock timeout here. Correct project-first order leaves it free.
    await holder.query("UPDATE agent_runtimes SET revision=revision WHERE id=$1", [created.runtime.id]);
    await holder.query("COMMIT");
    assert.equal((await pending).error, null);
    assert.equal((await runtime.getBinding(binding.id))!.binding.revision, 2);
  } finally {
    await holder.query("ROLLBACK"); await pending; await holder.end();
  }
}, "postgres"));

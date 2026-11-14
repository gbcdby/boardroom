import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { DbDriver } from "../src/server/db/driver.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import { createTaskService } from "../src/server/tasks/service.ts";
import { createMemoryService } from "../src/server/memory/service.ts";
import { closeMemoryRuntime } from "../src/server/memory/runtime.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createLogger } from "../src/server/logger.ts";
import { memoryFixture, memoryPeople, pgUnavailable } from "./helpers/memory-fixture.ts";
import { assertProjectBeforeLowerLocks, barrier, interleaveProjectWriters, observeLocks, RemovePairDiagnostics, startActualApi, withIndependentPgDrivers, type Outcome } from "./helpers/phase5-concurrency-fixture.ts";
import { seedCompleteMemberRelations, snapshotRelationsDatabase } from "./helpers/phase5-relations-fixture.ts";

const access = { actor: ownerActor() }, logger = createLogger({ level: "error", write() {} });
const entries = ["普通 MCP consume", "managed MCP consume/fence", "HTTP remove", "HTTP undo", "task 改派", "task settings", "memory write", "普通 join",
  "runtime create", "binding add", "binding update", "binding intent", "binding remove", "runtime claim", "runtime renew", "runtime patchRunner", "runtime markExit", "runtime delete"] as const;
type Entry = typeof entries[number];

async function entryFixture(entry: Entry, repos: RepositorySet, db: DbDriver) {
  const f = await memoryPeople(repos);
  const secondGroup = await repos.groups.create({ projectId: f.project.id, name: "另一绑定群" });
  const replacement = await repos.members.create({ projectId: f.project.id, kind: "human", displayName: "新负责人" });
  const runtime = createRuntimeRepository(db, { repos });
  const created = await runtime.create({ name: "锁序运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: f.project.id, groupId: f.group.id }] });
  const binding = created.bindings[0]!.binding;
  const cleanups: (() => Promise<void>)[] = [];
  const tasks = createTaskService({ repos });
  const task = await tasks.create(access, f.project.id, { title: "入口锁序任务", body: "保留正文", assigneeMemberId: f.member.id, reviewerMemberId: f.outsider.id });
  let run!: () => Promise<void>;
  if (entry === "普通 MCP consume" || entry === "普通 join") {
    const core = createMcpCore({ db, repos, logger, memberKey: "matrix-ordinary" });
    cleanups.push(() => core.close());
    const params = { projectId: f.project.id, groupId: f.group.id, displayName: "普通锁序成员", hostType: "other" as const };
    if (entry === "普通 join") run = async () => {
      const result = await core.join("session", params); assert.equal(result.ok, true);
      assert.equal((await repos.members.get(result.memberId))!.status, "active");
      assert.equal((await repos.mcpSessions.listByProject(f.project.id)).filter(s => s.memberId === result.memberId && s.state === "connected").length, 1);
    };
    else {
      const joined = await core.join("session", params);
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "必须读到的真实历史", mentions: [joined.memberId] });
      run = async () => { assert.ok((await core.readHistory("session", { limit: 20 })).messages.some(m => m.id === message.id)); };
    }
  } else if (entry === "managed MCP consume/fence") {
    await runtime.intent(binding.id, "start");
    const fence = await runtime.claim(binding.id, "managed-matrix");
    const core = createMcpCore({ db, repos, logger, memberKey: "matrix-managed", managed: {
      identity: { displayName: created.runtime.name, hostType: "claude-code", projectId: f.project.id, groupId: f.group.id, memberId: binding.memberId },
      run: (operation, body, discover) => runtime.withFence(fence, body, { requireRunningIntent: operation === "consume" }, discover),
      beforeWait: async () => true, onDelivery: async () => {},
    } });
    cleanups.push(() => core.close());
    await core.join("session", { displayName: created.runtime.name, hostType: "claude-code", projectId: f.project.id, groupId: f.group.id });
    const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "fence 内可见的历史", mentions: [binding.memberId] });
    run = async () => {
      assert.ok((await core.readHistory("session", { limit: 20 })).messages.some(m => m.id === message.id));
      assert.equal((await runtime.checkFence(fence)).runner.owner, fence.owner);
    };
  } else if (entry === "HTTP remove" || entry === "HTTP undo") {
    const http = await startActualApi(db); cleanups.push(() => http.close());
    if (entry === "HTTP remove") run = async () => {
      const result = await http.call("DELETE", `/api/projects/${f.project.id}/members/${f.member.id}`);
      assert.equal(result.status, 204, JSON.stringify(result.body));
      assert.equal(await repos.members.get(f.member.id), null);
      assert.equal((await repos.tasks.get(f.project.id, task.id))!.assigneeMemberId, null);
    };
    else {
      const removed = await createOrgMutationService({ repos }).removeMember(access, f.project.id, f.member.id);
      run = async () => {
        const result = await http.call("POST", `/api/projects/${f.project.id}/audit/${removed.auditId}/revoke`);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.ok(await repos.members.get(f.member.id));
        assert.ok((await repos.audit.get(f.project.id, removed.auditId))!.reversedAt);
      };
    }
  } else if (entry === "task 改派") run = async () => {
    const changed = await tasks.update(access, f.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: replacement.id });
    assert.equal(changed.revision, task.revision + 1); assert.equal(changed.assigneeMemberId, replacement.id);
    assert.equal((await repos.tasks.listUnackedWorkEvents(f.project.id, replacement.id)).filter(e => e.taskId === task.id).length, 1);
  };
  else if (entry === "task settings") run = async () => {
    assert.equal((await tasks.setSettings(access, f.project.id, { expectedRevision: 0, defaultReviewerMemberId: f.outsider.id })).revision, 1);
  };
  else if (entry === "memory write") {
    const memory = createMemoryService({ repos, config: DEFAULT_MEMORY_CONFIG,
      injectionReader: { readOwn: async () => ({ state: "available", entries: [], errors: [], maxBytes: 8192 }), close: async () => {} }, readVisibleMessages: async () => [] });
    run = async () => {
      const saved = await memory.write(access, { scope: "project-agent", projectId: f.project.id, agentId: f.agent.id }, { expectedVersion: 0, clientMutationId: "matrix", markdown: "锁内人工记忆" });
      assert.equal(saved.document.version, 1);
      assert.equal((await repos.memory.getVersion(saved.document.id, 1))!.markdown, "锁内人工记忆");
    };
  } else if (entry === "runtime create") run = async () => {
    const result = await runtime.create({ name: "新运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: f.project.id, groupId: secondGroup.id }] });
    assert.equal(result.bindings.length, 1); assert.ok(await repos.members.get(result.bindings[0]!.binding.memberId));
  };
  else if (entry === "binding add") run = async () => {
    await runtime.addBinding(created.runtime.id, { projectId: f.project.id, groupId: secondGroup.id });
    assert.equal((await runtime.get(created.runtime.id))!.bindings.length, 2);
  };
  else if (entry === "binding update") run = async () => {
    const result = await runtime.updateBinding(binding.id, { runtimeRevision: 1, bindingRevision: 1, overrides: { model: "lock-order-fixture" } });
    assert.equal(result.binding.revision, 2); assert.equal(result.binding.overrides.model, "lock-order-fixture");
  };
  else if (entry === "binding intent") run = async () => {
    assert.equal((await runtime.intent(binding.id, "start")).binding.desiredState, "running");
  };
  else if (entry === "binding remove") run = async () => {
    await runtime.removeBinding(binding.id); assert.equal(await runtime.getBinding(binding.id), null);
    assert.ok(await runtime.get(created.runtime.id));
    assert.equal((await db.query("SELECT member_id FROM agent_runtime_members WHERE member_id = ?", [binding.memberId])).length, 0);
  };
  else if (entry === "runtime delete") run = async () => {
    await runtime.delete(created.runtime.id); assert.equal(await runtime.get(created.runtime.id), null);
    assert.equal(await runtime.getBinding(binding.id), null);
  };
  else {
    await runtime.intent(binding.id, "start");
    if (entry === "runtime claim") run = async () => {
      const fence = await runtime.claim(binding.id, "matrix-owner");
      assert.equal((await runtime.checkFence(fence)).runner.generation, 1);
      assert.equal((await runtime.getBinding(binding.id))!.runner.exitConfirmed, false);
    };
    else {
      const fence = await runtime.claim(binding.id, "matrix-owner", { leaseMs: 5000 });
      const oldExpiry = (await runtime.getBinding(binding.id))!.runner.leaseExpiresAt!;
      if (entry === "runtime renew") run = async () => {
        await runtime.renew(fence, 30000); assert.ok((await runtime.getBinding(binding.id))!.runner.leaseExpiresAt! > oldExpiry);
      };
      else if (entry === "runtime patchRunner") run = async () => {
        assert.equal((await runtime.patchRunner(fence, { phase: "working" })).runner.phase, "working");
      };
      else run = async () => {
        const result = await runtime.markExit(fence, { exitCode: 0 });
        assert.equal(result.runner.exitConfirmed, true); assert.equal(result.runner.owner, null);
      };
    }
  }
  // Isolate the foreground entry from previously queued synthetic background scans.
  await closeMemoryRuntime(db);
  return { ...f, task, runtimeId: created.runtime.id, binding, run,
    async close() { for (const close of cleanups.reverse()) await close(); await closeMemoryRuntime(db); } };
}

for (const entry of entries) {
  test(`sqlite S5-AUDIT-13 入口兼容：${entry} 真实行为及每事务项目优先`, async () => memoryFixture(async (repos, db) => {
    const f = await entryFixture(entry, repos, db), trace = observeLocks(db);
    try { await f.run(); assertProjectBeforeLowerLocks(trace.locks); }
    finally { trace.restore(); await f.close(); }
  }));

  test(`postgres S5-AUDIT-13 与真实 task comment 交错：${entry} 等项目锁时不占成员/runtime`, { skip: pgUnavailable, timeout: 15000 }, async t => withIndependentPgDrivers(async (owner, ownerDb, worker, workerDb, probe) => {
    const f = await entryFixture(entry, worker, workerDb);
    try {
      const outcomes = await interleaveProjectWriters({ firstDb: ownerDb, secondDb: workerDb, probe, projectId: f.project.id,
        secondAfterFirstWork: entry === "HTTP remove" || entry === "HTTP undo",
        first: () => createTaskService({ repos: owner }).comment(access, f.project.id, f.task.id, "独立连接提交的真实评论"), second: f.run });
      assert.equal(outcomes.first.ok, true, failureText(outcomes.first));
      assert.equal(outcomes.second.ok, true, failureText(outcomes.second));
      assert.equal((await owner.tasks.listComments(f.project.id, f.task.id)).filter(c => c.body === "独立连接提交的真实评论").length, 1);
      t.diagnostic(JSON.stringify({ entry, first: outcomes.firstLocks.map(l => `${l.phase}:${l.table}`), second: outcomes.secondLocks.map(l => `${l.phase}:${l.table}`) }));
    } finally { await f.close(); }
  }));
}

function failureText(outcome: Outcome<unknown>) { return outcome.ok ? "" : String(outcome.error); }
function failureCode(outcome: Outcome<unknown>) { assert.equal(outcome.ok, false); return (outcome as { error: { code: string } }).error.code; }
async function withPairDrivers(engine: "sqlite" | "postgres", body: (a: RepositorySet, aDb: DbDriver, b: RepositorySet, bDb: DbDriver, probe?: Client) => Promise<void>, onCleanupError?: (stage: string, error: unknown) => void) {
  if (engine === "postgres") return withIndependentPgDrivers(body, onCleanupError);
  return memoryFixture((repos, db) => body(repos, db, repos, db));
}
async function runPair(input: { firstDb: DbDriver; secondDb: DbDriver; probe: Client | undefined; projectId: string; first: () => Promise<unknown>; second: () => Promise<unknown>; diagnostic?: RemovePairDiagnostics; secondAfterFirstWork?: boolean }) {
  if (input.probe) return interleaveProjectWriters({ ...input, probe: input.probe });
  // SQLite validates only the serial outcome oracle, never the PostgreSQL lock/concurrency claim.
  const outcome = (operation: () => Promise<unknown>): Promise<Outcome<unknown>> => operation().then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  return { first: await outcome(input.first), second: await outcome(input.second) };
}

for (const engine of ["sqlite", "postgres"] as const) for (const first of ["remove", "undo"] as const) {
  test(`${engine} S5-AUDIT-11/13 ${engine === "postgres" ? "真实双连接交错" : "仅串行语义"} remove 与补偿链 undo（${first} 先），只有一个完整移除代际`, { skip: engine === "postgres" ? pgUnavailable : false, timeout: 15000 }, async () => withPairDrivers(engine, async (a, aDb, b, bDb, probe) => {
    const f = await seedCompleteMemberRelations(a, aDb);
    const orgA = createOrgMutationService({ repos: a }), orgB = createOrgMutationService({ repos: b });
    const compensationA = createAuditCompensationService({ repos: a }), compensationB = createAuditCompensationService({ repos: b });
    const removed = await orgA.removeMember(access, f.project.id, f.member.id);
    const restored = await compensationA.revoke(access, f.project.id, removed.auditId);
    const baseline = await snapshotRelationsDatabase(aDb);
    const result = await runPair({ firstDb: aDb, secondDb: bDb, probe, projectId: f.project.id,
      secondAfterFirstWork: true,
      first: () => first === "remove" ? orgA.removeMember(access, f.project.id, f.member.id) : compensationA.revoke(access, f.project.id, restored.id),
      second: () => first === "remove" ? compensationB.revoke(access, f.project.id, restored.id) : orgB.removeMember(access, f.project.id, f.member.id) });
    assert.equal(result.first.ok, true, failureText(result.first));
    assert.equal(failureCode(result.second), first === "remove" ? "compensation_conflict" : "member_removed");
    const after = await snapshotRelationsDatabase(aDb);
    for (const table of ["messages", "message_deliveries", "group_participants", "memory_documents", "memory_versions", "memory_summary_requests", "member_fact_revisions"]) {
      assert.deepEqual(after[table], baseline[table]);
    }
    assert.equal(await a.members.get(f.member.id), null);
    assert.equal((await a.members.getIncludingRemoved(f.member.id))!.membershipRevision, f.member.membershipRevision + 3);
    assert.equal((await a.audit.get(f.project.id, restored.id))!.reversedAt !== null, first === "undo");
    assert.equal(after.audit_log!.length, 3, "只有一个竞争者可新增审计，失败补偿不能留下另一条");
    for (const task of f.tasks) {
      const current = (await a.tasks.get(f.project.id, task.id))!;
      assert.equal(current.revision, task.revision + 3);
      assert.equal(current.state, task.state === "done" ? "done" : "blocked");
      assert.equal(current.assigneeMemberId, task.assigneeMemberId === f.member.id ? null : task.assigneeMemberId);
      assert.equal(current.reviewerMemberId, task.reviewerMemberId === f.member.id ? null : task.reviewerMemberId);
      assert.equal(current.currentReviewRoundId, null);
    }
    assert.equal((await a.tasks.getSettings(f.project.id)).revision, 4);
    for (const table of ["agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "member_statuses"]) assert.deepEqual(after[table], []);
  }));
}

for (const engine of ["sqlite", "postgres"] as const) for (const pair of ["remove/remove", "undo/undo", "改派/remove", "remove/改派", "改派/undo", "undo/改派"] as const) {
  test(`${engine} S5-AUDIT-11/13 ${engine === "postgres" ? "真实双连接交错" : "仅串行语义"} 完整关系 ${pair}，成功事务完整且迟到写稳定冲突`, { skip: engine === "postgres" ? pgUnavailable : false, timeout: 15000 }, async t => {
    const collect = engine === "postgres" && (pair === "remove/remove" || pair === "undo/undo");
    let diagnostic: RemovePairDiagnostics | undefined;
    try {
      await withPairDrivers(engine, async (a, aDb, b, bDb, probe) => {
        const f = await seedCompleteMemberRelations(a, aDb);
        const replacement = await a.members.create({ projectId: f.project.id, kind: "human", displayName: "并发新负责人" });
        const orgA = createOrgMutationService({ repos: a }), orgB = createOrgMutationService({ repos: b });
        const undoA = createAuditCompensationService({ repos: a }), undoB = createAuditCompensationService({ repos: b });
        const original = pair.includes("undo") ? await orgA.removeMember(access, f.project.id, f.member.id) : null;
        const baseline = await snapshotRelationsDatabase(aDb);
        const task = (await a.tasks.get(f.project.id, f.tasks[0]!.id))!;
        const operations = (repos: RepositorySet, name: string): (() => Promise<unknown>) => {
          if (name === "remove") return () => (repos === a ? orgA : orgB).removeMember(access, f.project.id, f.member.id);
          if (name === "undo") return () => (repos === a ? undoA : undoB).revoke(access, f.project.id, original!.auditId);
          return () => createTaskService({ repos }).update(access, f.project.id, task.id, { expectedRevision: task.revision, assigneeMemberId: replacement.id });
        };
        const [firstName, secondName] = pair.split("/");
        if (collect) diagnostic = new RemovePairDiagnostics(f.project.id, t.name);
        const verifyOutcomes = async () => {
          const outcome = await runPair({ firstDb: aDb, secondDb: bDb, probe, projectId: f.project.id,
            secondAfterFirstWork: secondName === "remove" || secondName === "undo",
            first: operations(a, firstName!), second: operations(b, secondName!), ...(diagnostic ? { diagnostic } : {}) });
          assert.equal(outcome.first.ok, true, failureText(outcome.first));
          if (pair === "改派/remove") assert.equal(outcome.second.ok, true, failureText(outcome.second));
          else {
            const code = failureCode(outcome.second);
            assert.equal(code, pair === "remove/remove" ? "member_removed" : pair === "remove/改派" || pair === "undo/改派" ? "conflict" : "compensation_conflict");
          }
        };
        if (diagnostic) await diagnostic.check("outcome_assertions", verifyOutcomes); else await verifyOutcomes();
        const verifyRelations = async () => {
          const after = await snapshotRelationsDatabase(aDb);
          diagnostic?.relations(baseline, after);
          for (const table of ["messages", "message_deliveries", "memory_documents", "memory_versions", "group_participants", "memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints"]) {
            assert.deepEqual(after[table], baseline[table], `${pair}: 竞争不能损害 ${table} 历史事实`);
          }
          const actualTask = (await a.tasks.get(f.project.id, task.id))!;
          if (firstName === "改派") { assert.equal(actualTask.assigneeMemberId, replacement.id); assert.equal(actualTask.revision, task.revision + 1); }
          if (pair === "remove/改派") { assert.equal(actualTask.assigneeMemberId, null); assert.equal(actualTask.state, "blocked"); }
          if (pair === "undo/改派") { assert.equal(actualTask.assigneeMemberId, f.member.id); assert.equal(actualTask.state, "in-progress"); }
          const present = firstName === "undo";
          assert.equal(Boolean(await a.members.get(f.member.id)), present);
          if (original) {
            assert.equal((await a.audit.get(f.project.id, original.auditId))!.reversedAt !== null, firstName === "undo");
            assert.equal((await a.audit.list(f.project.id, { action: "member.revoke" })).length, firstName === "undo" ? 1 : 0);
            assert.deepEqual(after.memory_summary_requests, baseline.memory_summary_requests, "撤销/改派不能复活旧总结请求");
            assert.deepEqual(after.member_fact_revisions, baseline.member_fact_revisions);
          }
          assert.equal((await a.audit.list(f.project.id, { action: "member.remove" })).length, 1);
          assert.equal((await a.tasks.getSettings(f.project.id)).defaultReviewerMemberId, present ? f.member.id : null);
          for (const table of ["agent_runtime_bindings", "agent_runner_states", "agent_runtime_members", "member_statuses"]) assert.deepEqual(after[table], []);
          for (const request of f.requests.filter(r => r.state === "pending" || r.state === "running")) {
            assert.equal((await a.memory.getRequest(request.id))!.state, "cancelled");
            assert.equal((await a.memory.getRequest(request.id))!.revision, 2);
          }
        };
        if (diagnostic) {
          // An outcome mismatch still fails, but cannot prevent the original relation readback and connection evidence.
          await diagnostic.check("relation_assertions", verifyRelations);
          await diagnostic.inspectConnections(aDb, bDb, probe!);
        } else await verifyRelations();
      }, collect ? (stage, error) => { if (diagnostic) diagnostic.failure(stage, error); else throw error; } : undefined);
    } catch (error) { if (!diagnostic) throw error; diagnostic.failure("fixture", error); }
    if (diagnostic) {
      try { t.diagnostic(JSON.stringify(diagnostic.report())); } catch (error) { diagnostic.failure("diagnostic_output", error); }
      diagnostic.throwIfFailed();
    }
  });
}

for (const engine of ["sqlite", "postgres"] as const) for (const first of ["claim", "remove"] as const) {
  test(`${engine} S5-AUDIT-11/13 ${engine === "postgres" ? "真实双连接交错" : "仅串行语义"} ${first} 先执行，不部分清理或复活旧 fence`, { skip: engine === "postgres" ? pgUnavailable : false, timeout: 15000 }, async () => withPairDrivers(engine, async (a, aDb, b, bDb, probe) => {
    const project = await a.projects.create({ name: "claim 与成员移除" });
    const group = await a.groups.create({ projectId: project.id, name: "运行群" });
    const runtimeA = createRuntimeRepository(aDb, { repos: a }), runtimeB = createRuntimeRepository(bDb, { repos: b });
    const created = await runtimeA.create({ name: "竞争运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: project.id, groupId: group.id }] });
    const binding = created.bindings[0]!.binding;
    const orgA = createOrgMutationService({ repos: a }), orgB = createOrgMutationService({ repos: b });
    if (first === "claim") await runtimeA.intent(binding.id, "start");
    const outcomes = await runPair({ firstDb: aDb, secondDb: bDb, probe, projectId: project.id,
      secondAfterFirstWork: first === "claim",
      first: () => first === "claim" ? runtimeA.claim(binding.id, "winner") : orgA.removeMember(access, project.id, binding.memberId),
      second: () => first === "claim" ? orgB.removeMember(access, project.id, binding.memberId) : runtimeB.claim(binding.id, "stale-claim") });
    assert.equal(outcomes.first.ok, true, failureText(outcomes.first));
    assert.equal(failureCode(outcomes.second), first === "claim" ? "conflict" : "not_found");
    if (first === "claim") {
      assert.match(failureText(outcomes.second), /runtime_must_stop_first/);
      const view = (await runtimeA.getBinding(binding.id))!;
      assert.equal(view.runner.owner, "winner"); assert.equal(view.runner.exitConfirmed, false);
      assert.ok(await a.members.get(binding.memberId)); assert.deepEqual(await a.audit.list(project.id), []);
      const fence = { bindingId: binding.id, memberId: binding.memberId, owner: "winner", generation: view.runner.generation };
      await runtimeA.intent(binding.id, "stop"); await runtimeA.markExit(fence, { exitCode: 0 });
      const removed = await orgA.removeMember(access, project.id, binding.memberId);
      await createAuditCompensationService({ repos: a }).revoke(access, project.id, removed.auditId);
      await assert.rejects(runtimeB.renew(fence), { code: "not_found" });
      assert.equal(await runtimeA.getBinding(binding.id), null);
    } else {
      assert.equal(await a.members.get(binding.memberId), null); assert.equal(await runtimeA.getBinding(binding.id), null);
      assert.equal((await a.audit.list(project.id, { action: "member.remove" })).length, 1);
      assert.deepEqual(await aDb.query("SELECT * FROM agent_runtime_members"), []);
    }
  }));
}

for (const pauseAt of ["项目锁之前", "runtime 锁之前"] as const) {
  test(`postgres S5-AUDIT-13 跨项目 delete/addBinding ${pauseAt}扩大闭包，整笔 scope_changed 且不补拿项目锁`, { skip: pgUnavailable, timeout: 15000 }, async () => withIndependentPgDrivers(async (a, aDb, b, bDb) => {
    const p1 = await a.projects.create({ name: "既有项目" }), p2 = await a.projects.create({ name: "新增项目" });
    const g1 = await a.groups.create({ projectId: p1.id, name: "既有群" }), g2 = await a.groups.create({ projectId: p2.id, name: "新增群" });
    const runtimeA = createRuntimeRepository(aDb, { repos: a }), runtimeB = createRuntimeRepository(bDb, { repos: b });
    const runtime = await runtimeA.create({ name: "跨项目运行者", backend: "claude-code", defaults: { workdir: process.cwd() }, bindings: [{ projectId: p1.id, groupId: g1.id }] });
    const arrived = barrier(), release = barrier(); let paused = false;
    const trace = observeLocks(aDb, async lock => {
      if (!paused && lock.phase === "attempt" && lock.table === (pauseAt === "项目锁之前" ? "projects" : "agent_runtimes")) {
        paused = true; arrived.resolve(); await release.promise;
      }
    });
    const removal = runtimeA.delete(runtime.runtime.id).then(() => ({ error: null }), error => ({ error }));
    try {
      await Promise.race([arrived.promise, removal.then(r => { throw r.error ?? new Error("删除未到达预期真实锁屏障"); })]);
      const added = await runtimeB.addBinding(runtime.runtime.id, { projectId: p2.id, groupId: g2.id });
      assert.equal(added.binding.projectId, p2.id);
      const afterAdd = await snapshotRelationsDatabase(bDb);
      release.resolve();
      const result = await removal;
      assert.equal((result.error as { code: string })?.code, "mutation_scope_changed");
      assert.deepEqual(await snapshotRelationsDatabase(bDb), afterAdd, "失败删除不能损害任一项目的新旧 binding/member/reservation");
      assert.equal((await runtimeB.get(runtime.runtime.id))!.bindings.length, 2);
      assert.equal(trace.locks.some(l => l.table === "projects" && l.id === p2.id), false, "不允许持 member/runtime 后追加新项目锁");
      assert.equal(trace.errors.includes("40P01"), false);
    } finally { release.resolve(); await removal; trace.restore(); }
  }));
}

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";
import { CaptureBudget } from "../src/server/org/capture-budget.ts";
import { MEMBER_CAPTURE_BUDGET } from "../src/server/org/compensation-types.ts";
import { captureMemberRelations, readLifecycleMember } from "../src/server/org/member-relations.ts";
import { createOrgMutationService, reversalRoot } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import { appendAuditEntry, type AuditEntry } from "../src/server/audit.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import type { RepositorySet } from "../src/server/db/repositories.ts";
import type { DbDriver } from "../src/server/db/driver.ts";
import type { Task } from "../src/shared/tasks.ts";
import type { MemorySummaryRequest } from "../src/shared/memory.ts";

const access = { actor: ownerActor() }, at = "2026-11-11T12:00:00.000Z";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value,
  (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
const exceeded = (error: unknown) => (error as { code?: string }).code === "audit_capture_budget_exceeded";

/** Measures completed, actual driver results; never supplies results or changes budget counters. */
class ObservedBudget extends CaptureBudget {
  completedSql = 0;
  returnedRows = 0;
  returnedBytes = 0;
  affectedRows = 0;
  queries: Array<{ sql: string; rows: unknown[] }> = [];
  override after(sql: string, result: unknown, kind: "query" | "exec"): void {
    this.completedSql++;
    if (kind === "query" && Array.isArray(result)) {
      this.returnedRows += result.length;
      this.returnedBytes += result.reduce((total, row: unknown) => total + bytes(row), 0);
      this.queries.push({ sql, rows: result });
    } else if (kind === "exec" && typeof result === "number" && !/^\s*(SET|UPDATE \w+ SET updated_at = updated_at)/i.test(sql)) {
      this.affectedRows += result;
    }
    super.after(sql, result, kind);
  }
}

async function scalarRows(db: DbDriver): Promise<void> {
  await db.exec("CREATE TABLE budget_scalars (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
  await db.transaction(async tx => {
    for (let start = 1; start <= 2049; start += 128) {
      const ids = Array.from({ length: Math.min(128, 2050 - start) }, (_, i) => start + i);
      await tx.exec(`INSERT INTO budget_scalars (id, value) VALUES ${ids.map(() => "(?, 0)").join(",")}`, ids);
    }
  });
}

async function person(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "固定预算验收" });
  const agent = await repos.agents.create({ displayName: "边界成员", hostType: "fixture" });
  const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  return { project, agent, member };
}

async function related(repos: RepositorySet) {
  const people = await person(repos), { project, member, agent } = people;
  const task: Task = { id: randomUUID(), projectId: project.id, title: "保留真实业务关系", body: "不应采集的正文", labels: [],
    state: "blocked", assigneeMemberId: member.id, reviewerMemberId: member.id, repoPath: null, fixedPoint: null,
    revision: 1, currentReviewRoundId: null, blockedReason: "先前原因", author: { kind: "human", actorId: "human:local", displayName: "预算测试" }, createdAt: at, updatedAt: at };
  await repos.tasks.create(task);
  const request: MemorySummaryRequest = { id: randomUUID(), projectId: project.id, agentId: agent.id, recipientMemberId: member.id,
    contextGroupId: null, documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: randomUUID(),
    taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null,
    beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
  await repos.memory.createRequest(request);
  return { ...people, task, request };
}

async function persisted(repos: RepositorySet, value: Awaited<ReturnType<typeof related>>) {
  return {
    member: await repos.members.getIncludingRemoved(value.member.id),
    task: await repos.tasks.get(value.project.id, value.task.id),
    history: await repos.tasks.listHistory(value.project.id, value.task.id),
    request: await repos.memory.getRequest(value.request.id),
    facts: await repos.members.retainedFacts(value.member.id),
    audits: await repos.audit.list(value.project.id),
    events: await repos.context.query("SELECT id, delivery_state FROM work_events WHERE project_id = ? ORDER BY id", [value.project.id]),
  };
}

async function capture(repos: RepositorySet, projectId: string, memberId: string, tracker: CaptureBudget) {
  // Read-only capture needs the project/member lock; it does not mutate group rows.
  return tracker.run(() => repos.mutations.run({ projectIds: [projectId], discover: async () => ({ memberIds: [memberId], groupIds: [], runtimeIds: [] }) },
    () => captureMemberRelations(repos, { projectId, memberId, watchedTaskIds: [], watchedRoundIds: [], watchSettings: false,
      budget: MEMBER_CAPTURE_BUDGET, tracker })));
}

for (const engine of ["sqlite", "postgres"] as const) {
  const gate = { skip: engine === "postgres" ? pgUnavailable : false };

  test(`${engine} S5-AUDIT-14：累计2048真实返回行恰限接受，第2049行拒绝并回滚`, gate, async () => memoryFixture(async (repos, db) => {
    await scalarRows(db);
    for (const limit of [2048, 2049]) {
      const budget = new ObservedBudget();
      const operation = () => repos.transaction(() => budget.run(async () => {
        budget.plan({ rows: 2048, bytes: 65536, sql: 66, changedRows: 1 });
        await repos.context.exec("UPDATE budget_scalars SET value = value + 1 WHERE id = 1");
        for (let start = 0; start < limit; start += 32) {
          await repos.context.query("SELECT id FROM budget_scalars WHERE id > ? ORDER BY id LIMIT ?", [start, Math.min(32, limit - start)]);
        }
      }));
      if (limit === 2048) await operation(); else await assert.rejects(operation, exceeded);
      assert.equal(budget.returnedRows, limit); assert.equal(budget.stats.rows, limit);
      assert.equal(Number((await db.query<{ value: number }>("SELECT value FROM budget_scalars WHERE id = 1"))[0]!.value), 1);
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：累计2097152真实UTF8返回字节恰限接受，多1字节整笔回滚`, gate, async () => memoryFixture(async (repos, db) => {
    await db.exec("CREATE TABLE budget_byte_marker (value INTEGER NOT NULL)"); await db.exec("INSERT INTO budget_byte_marker VALUES (0)");
    for (const extra of [0, 1]) {
      const budget = new ObservedBudget();
      const operation = () => repos.transaction(() => budget.run(async () => {
        budget.plan({ rows: 33, bytes: 2097152, sql: 34, changedRows: 1 });
        await repos.context.exec("UPDATE budget_byte_marker SET value = value + 1");
        // Each complete JSON row is <=65536 bytes, so only the aggregate limit can fail.
        for (let i = 0; i < 31; i++) await repos.context.query("SELECT ? AS value", ["x".repeat(65536 - 12)]);
        await repos.context.query("SELECT ? AS value", ["x".repeat(65523 - 12)]);
        await repos.context.query("SELECT ? AS value", ["x".repeat(1 + extra)]);
      }));
      if (extra === 0) await operation(); else await assert.rejects(operation, exceeded);
      assert.equal(budget.returnedBytes, 2097152 + extra); assert.equal(budget.stats.bytes, budget.returnedBytes);
      assert.ok(budget.queries.every(query => query.rows.every(row => bytes(row) <= 65536)));
      assert.equal(Number((await db.query<{ value: number }>("SELECT value FROM budget_byte_marker"))[0]!.value), 1);
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：第512条真实SQL可完成，第513条在送往驱动前拒绝`, gate, async () => memoryFixture(async (repos) => {
    for (const count of [512, 513]) {
      const budget = new ObservedBudget();
      const operation = () => repos.transaction(() => budget.run(async () => {
        for (let i = 0; i < count; i++) await repos.context.query("SELECT 1 AS value WHERE 1 = 0");
      }));
      if (count === 512) await operation(); else await assert.rejects(operation, exceeded);
      assert.equal(budget.completedSql, 512); assert.equal(budget.stats.sql, count);
      assert.equal(budget.returnedRows, 0); assert.equal(budget.returnedBytes, 0);
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：2048写计划及真实影响行恰限，多1计划写前拒绝、多1实际写回滚`, gate, async () => memoryFixture(async (repos, db) => {
    await scalarRows(db);
    const refused = new ObservedBudget();
    await assert.rejects(repos.transaction(() => refused.run(async () => {
      refused.plan({ rows: 0, bytes: 0, sql: 65, changedRows: 2049 });
      await repos.context.exec("UPDATE budget_scalars SET value = 99");
    })), exceeded);
    assert.equal(refused.completedSql, 0);
    for (const extra of [0, 1]) {
      const budget = new ObservedBudget();
      const operation = () => repos.transaction(() => budget.run(async () => {
        budget.plan({ rows: 0, bytes: 0, sql: 65, changedRows: 2048 });
        for (let start = 0; start < 2048; start += 32) {
          await repos.context.exec("UPDATE budget_scalars SET value = value + 1 WHERE id > ? AND id <= ?", [start, start + 32]);
        }
        if (extra) await repos.context.exec("UPDATE budget_scalars SET value = value + 1 WHERE id = 2049");
      }));
      if (extra === 0) await operation(); else await assert.rejects(operation, exceeded);
      assert.equal(budget.affectedRows, 2048 + extra); assert.equal(budget.stats.changedRows, budget.affectedRows);
      const rows = await db.query<{ id: number; value: number }>("SELECT id, value FROM budget_scalars ORDER BY id");
      assert.equal(rows.length, 2049);
      assert.ok(rows.every(row => Number(row.value) === (Number(row.id) <= 2048 ? 1 : 0)), "所有已执行 UPDATE 必须随超限一同回滚");
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：before/after/detail分别32768字节完整入库，32769拒绝不追加`, gate, async () => memoryFixture(async (repos) => {
    const { project, member } = await person(repos);
    for (const field of ["before", "after", "detail"] as const) for (const size of [32768, 32769]) {
      const id = randomUUID(), reversal = reversalRoot(id, "member.pause");
      const base = field === "detail" ? { reversal, pad: "" } : { pad: "" };
      const value = { ...base, pad: "x".repeat(size - bytes(base)) };
      assert.equal(bytes(value), size);
      const entry: AuditEntry = { projectId: project.id, actor: { kind: "human", name: "预算测试" }, action: "member.pause",
        targetKind: "member", targetId: member.id, targetName: member.displayName, before: null, after: null,
        detail: { reversal }, [field]: value };
      const previous = await repos.audit.list(project.id);
      const operation = () => repos.transaction(() => appendAuditEntry(repos.audit, entry, { id, createdAt: at }));
      if (size === 32768) {
        await operation();
        const stored = (await repos.audit.get(project.id, id))![field]!;
        assert.equal(Buffer.byteLength(stored), size); assert.deepEqual(JSON.parse(stored), value);
      } else {
        await assert.rejects(operation, { code: "audit_snapshot_too_large" });
        assert.deepEqual(await repos.audit.list(project.id), previous); assert.equal(await repos.audit.get(project.id, id), null);
      }
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：128参与边完整采集，129哨兵拒绝，公开移除零提交`, gate, async () => memoryFixture(async (repos, db) => {
    const { project, member } = await person(repos);
    const add = async (index: number) => {
      const groupId = `group-${String(index).padStart(4, "0")}`;
      await db.exec("INSERT INTO groups (id, project_id, name, created_at, updated_at) VALUES (?, ?, '边界群', ?, ?)", [groupId, project.id, at, at]);
      await db.exec("INSERT INTO group_participants (group_id, member_id, joined_at) VALUES (?, ?, ?)", [groupId, member.id, at]);
    };
    await db.transaction(async () => { for (let i = 0; i < 128; i++) await add(i); });
    const exact = await capture(repos, project.id, member.id, new ObservedBudget());
    assert.equal(exact.participants.length, 128);
    await add(128);
    const over = new ObservedBudget();
    await assert.rejects(capture(repos, project.id, member.id, over), exceeded);
    assert.equal(over.queries.filter(query => /FROM group_participants/.test(query.sql)).flatMap(query => query.rows).length, 129);
    const before = await repos.members.getIncludingRemoved(member.id), facts = await repos.members.retainedFacts(member.id);
    await assert.rejects(createOrgMutationService({ repos }).removeMember(access, project.id, member.id), exceeded);
    assert.deepEqual(await repos.members.getIncludingRemoved(member.id), before); assert.deepEqual(await repos.members.retainedFacts(member.id), facts);
    assert.equal((await db.query("SELECT group_id FROM group_participants WHERE member_id = ?", [member.id])).length, 129);
    assert.equal((await repos.audit.list(project.id)).length, 0);
  }, engine));

  test(`${engine} S5-AUDIT-14：512工作事件完整采集，513哨兵拒绝，公开移除不删通知`, gate, async () => memoryFixture(async (repos, db) => {
    const { project, member } = await person(repos);
    const add = async (index: number) => {
      const id = `event-${String(index).padStart(4, "0")}`;
      await db.exec("INSERT INTO work_events (id, project_id, recipient_member_id, kind, event_key, payload, delivery_state, attempts, created_at) VALUES (?, ?, ?, 'fixture', ?, '{}', 'pending', 0, ?)",
        [id, project.id, member.id, id, at]);
    };
    await db.transaction(async () => { for (let i = 0; i < 512; i++) await add(i); });
    const exact = await capture(repos, project.id, member.id, new ObservedBudget());
    assert.equal(exact.transient.workEventIds.length, 512);
    await add(512);
    const over = new ObservedBudget();
    await assert.rejects(capture(repos, project.id, member.id, over), exceeded);
    assert.equal(over.queries.filter(query => /FROM work_events/.test(query.sql)).flatMap(query => query.rows).length, 513);
    await assert.rejects(createOrgMutationService({ repos }).removeMember(access, project.id, member.id), exceeded);
    assert.deepEqual(await repos.members.getIncludingRemoved(member.id), member);
    assert.equal((await db.query("SELECT id FROM work_events WHERE recipient_member_id = ?", [member.id])).length, 513);
    assert.equal((await repos.audit.list(project.id)).length, 0);
  }, engine));

  test(`${engine} S5-AUDIT-14：名字8192字节完整保留，UTF8多1字节及1MiB源只取有界前缀`, gate, async () => memoryFixture(async (repos, db) => {
    const value = await related(repos), { member } = value;
    const exact = "汉".repeat(2730) + "ab"; assert.equal(Buffer.byteLength(exact), 8192);
    await db.exec("UPDATE members SET display_name = ? WHERE id = ?", [exact, member.id]);
    assert.equal((await new ObservedBudget().run(() => readLifecycleMember(repos.context, member.id)))!.displayName, exact);
    for (const text of [exact + "c", "x".repeat(1024 * 1024)]) {
      await db.exec("UPDATE members SET display_name = ? WHERE id = ?", [text, member.id]);
      const before = await persisted(repos, value), budget = new ObservedBudget();
      await assert.rejects(budget.run(() => createOrgMutationService({ repos }).removeMember(access, value.project.id, member.id)), exceeded);
      assert.deepEqual(await persisted(repos, value), before);
      const probes = budget.queries.filter(query => /AS display_name/.test(query.sql));
      assert.ok(probes.length > 0);
      assert.ok(probes.every(query => query.sql.includes("substr(display_name, 1, 8193)")));
      assert.ok(probes.every(query => query.rows.every(row => [...(row as { display_name: string }).display_name].length <= 8193)));
      assert.ok(budget.returnedBytes < 65536, "超长源正文未整体进入采集");
    }
  }, engine));

  test(`${engine} S5-AUDIT-14：任务原因8192恰限可移除/撤销，8193拒绝保留所有跨表事实`, gate, async () => memoryFixture(async (repos, db) => {
    const value = await related(repos), service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    await db.exec("UPDATE tasks SET blocked_reason = ? WHERE id = ?", ["x".repeat(8192), value.task.id]);
    const removed = await service.removeMember(access, value.project.id, value.member.id);
    await compensation.revoke(access, value.project.id, removed.auditId);
    assert.equal((await repos.tasks.get(value.project.id, value.task.id))!.blockedReason, "x".repeat(8192));
    await db.exec("UPDATE tasks SET blocked_reason = ? WHERE id = ?", ["x".repeat(8193), value.task.id]);
    const before = await persisted(repos, value), budget = new ObservedBudget();
    await assert.rejects(budget.run(() => service.removeMember(access, value.project.id, value.member.id)), exceeded);
    assert.deepEqual(await persisted(repos, value), before);
    assert.ok(budget.queries.some(query => query.sql.includes("substr(blocked_reason, 1, 8193)")));
    assert.ok(budget.queries.every(query => !/SELECT\s+\*|\bbody\b|\bOFFSET\b/i.test(query.sql)));
  }, engine));

  test(`${engine} S5-AUDIT-14：公开撤销拒绝32769历史字段，原审计和成员/任务/请求事实不变`, gate, async () => memoryFixture(async (repos, db) => {
    const value = await related(repos), service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const removed = await service.removeMember(access, value.project.id, value.member.id);
    const original = (await repos.audit.get(value.project.id, removed.auditId))!;
    const snapshot = JSON.parse(original.before!) as Record<string, unknown>;
    const withPad = { ...snapshot, boundaryFixture: "" };
    const tooLarge = JSON.stringify({ ...withPad, boundaryFixture: "x".repeat(32769 - bytes(withPad)) });
    assert.equal(Buffer.byteLength(tooLarge), 32769);
    await db.exec("UPDATE audit_log SET before = ? WHERE id = ?", [tooLarge, removed.auditId]);
    const before = await persisted(repos, value), budget = new ObservedBudget();
    await assert.rejects(budget.run(() => compensation.revoke(access, value.project.id, removed.auditId)), { code: "audit_snapshot_too_large" });
    assert.deepEqual(await persisted(repos, value), before);
    const probes = budget.queries.filter(query => /substr\(before, \?, 8192\)/.test(query.sql));
    // UTF-8 may reach the byte limit before five character-sized chunks; count actual bytes.
    assert.ok(probes.length > 0 && probes.length <= 5);
    assert.equal(probes.flatMap(query => query.rows).reduce<number>((total, row) => total + Buffer.byteLength((row as { value: string }).value), 0), 32769);
    assert.ok(budget.queries.every(query => !/SELECT\s+\*|\bOFFSET\b/i.test(query.sql)));
  }, engine));
}

test("sqlite S5-AUDIT-14：真实native长查询返回后检查500ms并回滚，不声称中途取消", async () => memoryFixture(async (repos, db) => {
  const { project } = await person(repos);
  await db.exec("CREATE TABLE budget_cancel_marker (value INTEGER NOT NULL)"); await db.exec("INSERT INTO budget_cancel_marker VALUES (0)");
  const budget = new ObservedBudget(); let passedSlowQuery = false;
  const start = performance.now();
  await assert.rejects(budget.run(() => repos.mutations.run({ projectIds: [project.id], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => {
    budget.plan({ rows: 1, bytes: 128, sql: 3, changedRows: 2 });
    await repos.context.exec("UPDATE budget_cancel_marker SET value = 1");
    // Real recursive rows execute inside SQLite, without JS sleeps or mocked timing.
    await repos.context.query("WITH RECURSIVE ticks(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM ticks WHERE value < 12000000) SELECT sum(value) AS total FROM ticks");
    passedSlowQuery = true; await repos.context.exec("UPDATE budget_cancel_marker SET value = 2");
  })), exceeded);
  assert.ok(performance.now() - start >= 500);
  const query = budget.queries.find(item => item.sql.startsWith("WITH RECURSIVE"));
  assert.deepEqual(query!.rows, [{ total: 12000000 * 12000001 / 2 }], "native 查询确实返回了真实结果，然后才拒绝");
  assert.equal(passedSlowQuery, false);
  assert.deepEqual(await db.query("SELECT value FROM budget_cancel_marker"), [{ value: 0 }]);
  await db.exec("UPDATE budget_cancel_marker SET value = 3");
  assert.deepEqual(await db.query("SELECT value FROM budget_cancel_marker"), [{ value: 3 }]);
}));

test("postgres S5-AUDIT-14：真实57014后ROLLBACK TO SAVEPOINT完成，同一物理连接可再写", { skip: pgUnavailable }, async () => memoryFixture(async (repos, db) => {
  const { project } = await person(repos);
  await db.exec("CREATE TABLE budget_cancel_marker (value INTEGER NOT NULL)"); await db.exec("INSERT INTO budget_cancel_marker VALUES (0)");
  await db.transaction(async tx => {
    const pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    const budget = new ObservedBudget(); let passedSlowQuery = false;
    await assert.rejects(budget.run(() => repos.mutations.run({ projectIds: [project.id], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => {
      assert.equal((await repos.context.one<{ statement_timeout: string }>("SHOW statement_timeout"))!.statement_timeout, "200ms");
      budget.plan({ rows: 1, bytes: 128, sql: 3, changedRows: 2 });
      await repos.context.exec("UPDATE budget_cancel_marker SET value = 1");
      await repos.context.query("SELECT pg_sleep(1)");
      passedSlowQuery = true; await repos.context.exec("UPDATE budget_cancel_marker SET value = 2");
    })), { code: "57014" });
    assert.equal(passedSlowQuery, false);
    assert.equal((await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]!.pid, pid);
    assert.deepEqual(await tx.query("SELECT value FROM budget_cancel_marker"), [{ value: 0 }]);
    assert.equal(repos.mutations.current(), null, "保存点回滚不能留下已释放的 scope");
    await tx.exec("UPDATE budget_cancel_marker SET value = 3");
  });
  assert.deepEqual(await db.query("SELECT value FROM budget_cancel_marker"), [{ value: 3 }]);
}, "postgres"));

test("postgres S5-AUDIT-14：公开remove审计触发器被真实SQL超时取消，全部业务及事实ROLLBACK完成", { skip: pgUnavailable }, async () => memoryFixture(async (repos, db) => {
  const value = await related(repos), before = await persisted(repos, value);
  await db.exec("CREATE TABLE budget_cancel_marker (value INTEGER NOT NULL)"); await db.exec("INSERT INTO budget_cancel_marker VALUES (0)");
  await db.exec(`CREATE FUNCTION budget_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_sleep(1); UPDATE budget_cancel_marker SET value = 9; RETURN NEW;
  END $$`);
  await db.exec("CREATE TRIGGER budget_slow_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION budget_slow_audit()");
  // This fixture has no parallel callers, so the pool has one connection; verify its actual PID.
  const pid = (await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
  let rejected: unknown;
  try { await createOrgMutationService({ repos }).removeMember(access, value.project.id, value.member.id); }
  catch (error) { rejected = error; }
  assert.ok(exceeded(rejected));
  let cause = rejected as { code?: string; cause?: unknown } | undefined;
  while (cause && cause.code !== "57014") cause = cause.cause as typeof cause;
  assert.equal(cause?.code, "57014", "必须保留真正的 PostgreSQL query_canceled，不能以 JS 超时冒充");
  assert.equal((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]!.pid, pid);
  assert.deepEqual(await persisted(repos, value), before);
  assert.deepEqual(await db.query("SELECT value FROM budget_cancel_marker"), [{ value: 0 }]);
  assert.equal(db.currentTransactionContext(), undefined);
  await db.exec("DROP TRIGGER budget_slow_audit ON audit_log");
  await db.exec("UPDATE budget_cancel_marker SET value = 3");
  const removed = await createOrgMutationService({ repos }).removeMember(access, value.project.id, value.member.id);
  assert.ok(removed.auditId); assert.deepEqual(await db.query("SELECT value FROM budget_cancel_marker"), [{ value: 3 }]);
}, "postgres"));

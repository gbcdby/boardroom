import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryFixture, pgUnavailable } from "./helpers/memory-fixture.ts";
import { CaptureBudget } from "../src/server/org/capture-budget.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { readLifecycleMember } from "../src/server/org/member-relations.ts";

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value,
  (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
class MeasuredBudget extends CaptureBudget {
  actualRows = 0;
  actualBytes = 0;
  batches: Array<{ sql: string; rows: number; bytes: number; remainingBytes: number }> = [];
  override after(sql: string, result: unknown, kind: "query" | "exec"): void {
    if (kind === "query" && Array.isArray(result)) {
      const bytes = result.reduce((total, row: unknown) => total + encodedBytes(row), 0);
      this.batches.push({ sql, rows: result.length, bytes, remainingBytes: this.limits.maxReturnedBytes - this.stats.bytes });
      this.actualRows += result.length; this.actualBytes += bytes;
    }
    super.after(sql, result, kind);
  }
}
const exceeded = (error: unknown) => (error as { code?: string }).code === "audit_capture_budget_exceeded";

for (const engine of ["sqlite", "postgres"] as const) {
  const gate = { skip: engine === "postgres" ? pgUnavailable : false };
  test(`${engine} STD5-003：首行超限仍完整计入数据库已经返回的整批数据`, gate, async () => memoryFixture(async (repos) => {
    const budget = new MeasuredBudget();
    await assert.rejects(budget.run(() => repos.context.query("SELECT ? AS value UNION ALL SELECT ? AS value", ["x".repeat(65536), "已经返回的第二行"])), exceeded);
    assert.equal(budget.actualRows, 2);
    assert.equal(budget.stats.rows, budget.actualRows);
    assert.equal(budget.stats.bytes, budget.actualBytes);
  }, engine));

  test(`${engine} STD5-003：剩余字节收窄真实查询页，最多多取一个64KiB哨兵`, gate, async () => memoryFixture(async (repos, db) => {
    await db.exec("CREATE TABLE budget_pages (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    await db.transaction(async tx => {
      for (let i = 1; i <= 64; i++) await tx.exec("INSERT INTO budget_pages (id, value) VALUES (?, ?)", [i, "x".repeat(60000)]);
    });
    const budget = new MeasuredBudget();
    await assert.rejects(budget.run(async () => {
      let after = 0;
      while (true) {
        const rows = await repos.context.query<{ id: number; value: string }>("SELECT id, value FROM budget_pages WHERE id > ? ORDER BY id LIMIT ?", [after, budget.pageSize()]);
        if (!rows.length) break;
        after = rows.at(-1)!.id;
      }
    }), exceeded);
    assert.equal(budget.stats.rows, budget.actualRows);
    assert.equal(budget.stats.bytes, budget.actualBytes);
    assert.ok(budget.actualBytes <= budget.limits.maxReturnedBytes + 65536, JSON.stringify(budget.batches));
    for (const batch of budget.batches) assert.ok(batch.rows <= Math.max(1, Math.floor(batch.remainingBytes / 65536) + 1));
  }, engine));

  test(`${engine} STD5-003：90个双引用任务拒绝前完整计费，无额外正文、业务或审计提交`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "字节分页回归" });
    const agent = await repos.agents.create({ displayName: "预算目标", hostType: "fixture" });
    const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
    const at = "2026-11-11T00:00:00.000Z";
    await db.transaction(async tx => {
      for (let i = 0; i < 90; i++) await tx.exec("INSERT INTO tasks (id, project_id, title, body, labels, state, assignee_member_id, reviewer_member_id, revision, blocked_reason, author, created_at, updated_at) VALUES (?, ?, '任务', '不应采集的任务正文', '[]', 'blocked', ?, ?, 1, ?, '{}', ?, ?)",
        [randomUUID(), project.id, member.id, member.id, "\u0001".repeat(2000), at, at]);
    });
    const beforeFacts = await repos.members.retainedFacts(member.id);
    const budget = new MeasuredBudget();
    await assert.rejects(budget.run(() => createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, project.id, member.id)),
      error => exceeded(error) || (error as { code?: string }).code === "audit_snapshot_too_large");
    assert.equal(budget.stats.rows, budget.actualRows);
    assert.equal(budget.stats.bytes, budget.actualBytes);
    assert.ok(budget.actualBytes <= budget.limits.maxReturnedBytes + 65536, JSON.stringify(budget.batches.at(-1)));
    assert.ok(budget.batches.every(batch => !/SELECT\s+\*|\bbody\b|\bOFFSET\b/i.test(batch.sql)));
    assert.deepEqual(await repos.members.getIncludingRemoved(member.id), member);
    assert.deepEqual(await repos.members.retainedFacts(member.id), beforeFacts);
    assert.equal((await repos.audit.list(project.id)).length, 0);
    assert.deepEqual(await db.query("SELECT DISTINCT revision, assignee_member_id, reviewer_member_id FROM tasks WHERE project_id = ?", [project.id]),
      [{ revision: 1, assignee_member_id: member.id, reviewer_member_id: member.id }]);
  }, engine));

  test(`${engine} STD5-003：转义最坏字段分开读取，单投影保持64KiB且不截断原字段`, gate, async () => memoryFixture(async (repos, db) => {
    const project = await repos.projects.create({ name: "宽投影" });
    const member = await repos.members.create({ id: "m" + "\u0001".repeat(1023), projectId: project.id, kind: "human", displayName: "临时名" });
    const name = "\u0001".repeat(8192), stamp = "\u0001".repeat(1024);
    await db.exec("UPDATE members SET display_name = ?, created_at = ?, updated_at = ? WHERE id = ?", [name, stamp, stamp, member.id]);
    const budget = new MeasuredBudget();
    const actual = await budget.run(() => readLifecycleMember(repos.context, member.id));
    assert.equal(actual!.displayName, name);
    assert.equal(actual!.createdAt, stamp); assert.equal(actual!.updatedAt, stamp);
    assert.ok(budget.actualBytes > 65536, "多个字段合并确实会超过单行上界");
    assert.ok(budget.batches.every(batch => batch.bytes <= 65536));
    assert.equal(budget.stats.bytes, budget.actualBytes);
  }, engine));
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { createOrgMutationService } from "../src/server/org/mutations.ts";
import { createAuditCompensationService } from "../src/server/audit-compensation.ts";
import type { Task } from "../src/shared/tasks.ts";
import type { MemorySummaryRequest } from "../src/shared/memory.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const access = { actor: ownerActor() }, at = "2026-11-11T12:00:00.000Z";
async function withDb(engine: "sqlite" | "postgres", body: (repos: RepositorySet, db: DbDriver) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-member-v2-")), schema = `member_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await body(createRepositories(db), db); }
  finally {
    await db.close();
    if (engine === "postgres") { const admin = new Client({ connectionString: pgUrl }); await admin.connect(); try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); } }
    await rm(dir, { recursive: true, force: true });
  }
}
function task(projectId: string, memberId: string, state: Task["state"] = "in-progress"): Task {
  return { id: randomUUID(), projectId, title: "保留任务", body: "任务正文不属于补偿采集", deliveryKind: "code", acceptanceText: "任务正文不属于补偿采集", acceptanceSource: "explicit", labels: [], state, assigneeMemberId: memberId, reviewerMemberId: memberId,
    repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null,
    author: { kind: "human", actorId: "human:local", displayName: "人" }, createdAt: at, updatedAt: at };
}
function request(projectId: string, memberId: string, agentId: string): MemorySummaryRequest {
  return { id: randomUUID(), projectId, agentId, recipientMemberId: memberId, contextGroupId: null, documentId: null, baseVersion: 0, revision: 1,
    state: "pending", trigger: "session_end", triggerKey: randomUUID(), taskId: null, completedTaskRevision: null, messageIds: [], sourceWorkEventId: null,
    retryOfRequestId: null, attemptId: null, beginMutationId: null, resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null };
}
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；交 CI 执行" : false;
  test(`${engine} 移除与五次补偿保留历史作者，任务设置revision前进，旧连接总结不复活`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: "成员关系" });
    const agent = await repos.agents.create({ displayName: "A", hostType: "fixture" });
    const m = await repos.members.create({ projectId: p.id, kind: "agent", agentId: agent.id, displayName: "A" });
    const h = await repos.members.create({ projectId: p.id, kind: "human", displayName: "人" });
    const g = await repos.groups.create({ projectId: p.id, name: "群", participantMemberIds: [m.id, h.id] });
    const message = await repos.messages.create({ groupId: g.id, senderMemberId: m.id, body: "真实历史", mentions: [h.id] });
    await repos.deliveries.recordAttempt(message.id, m.id, "acked", at);
    const delivery = await repos.deliveries.get(message.id, m.id);
    const session = await repos.mcpSessions.connect({ agentId: agent.id, projectId: p.id, groupId: g.id, memberId: m.id, displayName: "A", hostType: "fixture" });
    await repos.statuses.set(p.id, m.id, "working");
    const t = await repos.tasks.create(task(p.id, m.id));
    const done = await repos.tasks.create(task(p.id, m.id, "done"));
    await repos.tasks.setSettings(p.id, 0, m.id);
    const req = request(p.id, m.id, agent.id); await repos.memory.createRequest(req);
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const removed = await service.removeMember(access, p.id, m.id);
    assert.equal(await repos.members.get(m.id), null);
    assert.equal((await repos.members.getIncludingRemoved(m.id))!.membershipRevision, 2);
    assert.equal((await repos.tasks.get(p.id, t.id))!.state, "blocked");
    assert.equal((await repos.tasks.get(p.id, t.id))!.assigneeMemberId, null);
    assert.equal((await repos.tasks.get(p.id, done.id))!.state, "done");
    assert.equal((await repos.memory.getRequest(req.id))!.state, "cancelled");
    assert.equal((await repos.memory.getRequest(req.id))!.error!.code, "member_removed");
    assert.equal((await repos.tasks.getSettings(p.id)).defaultReviewerMemberId, null);
    assert.equal((await repos.groups.participants(g.id)).includes(m.id), false);
    let previous = (await repos.audit.get(p.id, removed.auditId))!;
    for (let i = 0; i < 5; i++) {
      const next = await compensation.revoke(access, p.id, previous.id);
      const present = i % 2 === 0;
      assert.equal(Boolean(await repos.members.get(m.id)), present);
      assert.equal((await repos.members.getIncludingRemoved(m.id))!.membershipRevision, 3 + i);
      const current = (await repos.tasks.get(p.id, t.id))!;
      assert.equal(current.revision, 3 + i); assert.equal(current.assigneeMemberId, present ? m.id : null);
      assert.equal(current.state, present ? "in-progress" : "blocked");
      assert.equal((await repos.tasks.getSettings(p.id)).revision, 3 + i);
      assert.equal((await repos.groups.participants(g.id)).includes(m.id), present);
      assert.equal((await repos.memory.getRequest(req.id))!.state, "cancelled");
      assert.deepEqual(await repos.deliveries.get(message.id, m.id), delivery);
      assert.equal((await repos.messages.get(message.id))!.senderMemberId, m.id);
      assert.equal((await db.query<{state:string}>("SELECT state FROM mcp_sessions WHERE id = ?", [session.id]))[0]!.state, "disconnected");
      assert.equal(await repos.statuses.get(p.id, m.id), null);
      previous = next;
    }
    assert.equal((await repos.tasks.get(p.id, done.id))!.state, "done");
    assert.equal((await repos.tasks.listHistory(p.id, t.id)).length, 6);
    assert.equal((await db.query("SELECT id FROM work_events WHERE task_id = ? AND kind = 'task.review_decided'", [done.id])).length, 0);
  }));
  test(`${engine} undo add 不擦除后增关系或同量变更事实，正常 remove 可重新捕获`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: "旧add边界" }), service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const added = await service.addMember(access, { projectId: p.id, kind: "human", displayName: "人" });
    const g = await repos.groups.create({ projectId: p.id, name: "后来群", participantMemberIds: [added.member.id] });
    const message = await repos.messages.create({ groupId: g.id, senderMemberId: added.member.id, body: "正文" });
    await assert.rejects(() => compensation.revoke(access, p.id, added.auditId), { code: "compensation_conflict" });
    const removed = await service.removeMember(access, p.id, added.member.id);
    await db.exec("UPDATE messages SET body = ? WHERE id = ?", ["改后再改回", message.id]);
    await db.exec("UPDATE messages SET body = ? WHERE id = ?", ["正文", message.id]);
    await assert.rejects(() => compensation.revoke(access, p.id, removed.auditId), { code: "compensation_conflict" });
    assert.equal((await repos.audit.get(p.id, removed.auditId))!.reversedAt, null);
    assert.equal((await repos.messages.get(message.id))!.body, "正文");
  }));
  test(`${engine} 成员审计失败回滚代际与跨表CAS，任务后改拒绝整笔补偿`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "原子失败" }), a = await repos.agents.create({ displayName: "Agent", hostType: "fixture" });
    const m = await repos.members.create({ projectId: p.id, kind: "agent", agentId: a.id, displayName: "Agent" });
    const t = await repos.tasks.create(task(p.id, m.id)); await repos.tasks.setSettings(p.id, 0, m.id);
    const req = request(p.id, m.id, a.id); await repos.memory.createRequest(req);
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const append = repos.audit.append; repos.audit.append = async () => { throw new Error("injected audit failure"); };
    await assert.rejects(() => service.removeMember(access, p.id, m.id), /injected audit failure/);
    repos.audit.append = append;
    assert.equal((await repos.members.get(m.id))!.membershipRevision, 1);
    assert.equal((await repos.tasks.get(p.id, t.id))!.revision, 1);
    assert.equal((await repos.tasks.getSettings(p.id)).revision, 1);
    assert.equal((await repos.memory.getRequest(req.id))!.state, "pending");
    const removed = await service.removeMember(access, p.id, m.id);
    await repos.tasks.updateCas(p.id, t.id, 2, { title: "后来更改" }, at);
    await assert.rejects(() => compensation.revoke(access, p.id, removed.auditId), { code: "compensation_conflict" });
    assert.equal(await repos.members.get(m.id), null);
    assert.equal((await repos.tasks.getSettings(p.id)).defaultReviewerMemberId, null);
  }));
  test(`${engine} 空成员 add 五次翻转与显式 readd 使用同身份新代际，旧潜在关系不默认复活`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: "新增周期" }), a = await repos.agents.create({ displayName: "周期Agent", hostType: "fixture" });
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const added = await service.addMember(access, { projectId: p.id, agentId: a.id, kind: 'agent', displayName: '周期Agent' });
    let current = (await repos.audit.get(p.id, added.auditId))!;
    for (let i = 0; i < 5; i++) {
      current = await compensation.revoke(access, p.id, current.id);
      assert.equal((await repos.members.getIncludingRemoved(added.member.id))!.membershipRevision, 2 + i);
      assert.equal(Boolean(await repos.members.get(added.member.id)), i % 2 !== 0);
    }
    await compensation.revoke(access, p.id, current.id);
    const g = await repos.groups.create({ projectId: p.id, name: '旧群', participantMemberIds: [added.member.id] });
    const removed = await service.removeMember(access, p.id, added.member.id);
    const readd = await service.addMember(access, { projectId: p.id, agentId: a.id, kind: 'agent', displayName: '新的显示名' });
    assert.equal(readd.member.id, added.member.id);
    assert.equal((await repos.groups.participants(g.id)).includes(added.member.id), false);
    assert.equal((await repos.members.findByAgentIncludingRemoved(p.id, a.id))!.id, added.member.id);
    await assert.rejects(() => compensation.revoke(access, p.id, removed.auditId), { code: 'compensation_conflict' });
  }));
  test(`${engine} 评审旧轮次仅失效；失活成员恢复指派仍 blocked，超长正文不进入补偿查询`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: "历史轮次" }), a = await repos.agents.create({ displayName: "Reviewer", hostType: "fixture" });
    const m = await repos.members.create({ projectId: p.id, agentId: a.id, kind: 'agent', displayName: 'Reviewer' });
    const t = task(p.id, m.id); t.body = '长正文'.repeat(300000); await repos.tasks.create(t);
    const roundId = randomUUID();
    await repos.tasks.createRound({ id: roundId, taskId: t.id, projectId: p.id, revision: 1, taskRevision: 2, state: 'ready', reviewerMemberId: m.id,
      specSnapshot: { title: t.title, body: t.body, labels: [] }, candidate: null, failure: null, decision: null, createdAt: at, updatedAt: at });
    await repos.tasks.updateCas(p.id, t.id, 1, { state: 'review', currentReviewRoundId: roundId }, at);
    await repos.tasks.setSettings(p.id, 0, m.id); await repos.members.setStatus(m.id, 'disabled');
    const originalQuery = repos.context.query, originalOne = repos.context.one;
    const inspected: string[] = [];
    const inspect = (sql: string) => { inspected.push(sql); assert.doesNotMatch(sql, /SELECT\s+\*\s+FROM\s+(tasks|task_review_rounds|memory_summary_requests|messages)\b/i); };
    repos.context.query = async (sql, params) => { inspect(sql); return originalQuery(sql, params); };
    repos.context.one = async (sql, params) => { inspect(sql); return originalOne(sql, params); };
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    const removed = await service.removeMember(access, p.id, m.id);
    const undo = await compensation.revoke(access, p.id, removed.auditId);
    repos.context.query = originalQuery; repos.context.one = originalOne;
    assert.ok(inspected.length > 30);
    assert.equal((await repos.tasks.get(p.id, t.id))!.state, 'blocked');
    assert.equal((await repos.tasks.get(p.id, t.id))!.currentReviewRoundId, null);
    assert.equal((await repos.tasks.get(p.id, t.id))!.body, t.body);
    assert.equal((await repos.tasks.getRound(p.id, t.id, roundId))!.state, 'superseded');
    assert.equal((await repos.tasks.getRound(p.id, t.id, roundId))!.revision, 2);
    assert.equal((await repos.tasks.getSettings(p.id)).reviewerValid, false);
    assert.ok(JSON.parse(undo.detail!).restartRequired.includes('review'));
    assert.equal(Number((await db.query<{ c: number | string }>("SELECT COUNT(*) AS c FROM task_review_rounds WHERE task_id = ?", [t.id]))[0]!.c), 1);
  }));
  test(`${engine} runtime gate 不以过期lease代替退出，移除和恢复不复活绑定配置`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: '运行关系' }), a = await repos.agents.create({ displayName: 'Managed', hostType: 'fixture' });
    const m = await repos.members.create({ projectId: p.id, kind: 'agent', agentId: a.id, displayName: 'Managed' });
    const g = await repos.groups.create({ projectId: p.id, name: '群', participantMemberIds: [m.id] });
    const runtimeId = randomUUID(), bindingId = randomUUID();
    await db.exec('INSERT INTO agent_runtimes (id, agent_id, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [runtimeId, a.id, '{"testOnly":true}', at, at]);
    await db.exec('INSERT INTO agent_runtime_bindings (id, runtime_id, project_id, group_id, member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [bindingId, runtimeId, p.id, g.id, m.id, at, at]);
    await db.exec("INSERT INTO agent_runner_states (binding_id, state, lease_owner, lease_expires_at, exit_confirmed, updated_at) VALUES (?, 'failed', 'old-owner', '2020-01-01T00:00:00Z', 0, ?)", [bindingId, at]);
    await db.exec('INSERT INTO agent_runtime_members (member_id, runtime_id, project_id, updated_at) VALUES (?, ?, ?, ?)', [m.id, runtimeId, p.id, at]);
    const service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
    await assert.rejects(() => service.removeMember(access, p.id, m.id), /runtime_must_stop_first/);
    await db.exec('UPDATE agent_runner_states SET lease_owner = NULL, lease_expires_at = NULL WHERE binding_id = ?', [bindingId]);
    await assert.rejects(() => service.removeMember(access, p.id, m.id), /runtime_must_stop_first/);
    await db.exec('UPDATE agent_runner_states SET exit_confirmed = 1 WHERE binding_id = ?', [bindingId]);
    const removed = await service.removeMember(access, p.id, m.id);
    assert.ok(removed.restartRequired.includes('runtime-binding'));
    await assert.rejects(() => repos.members.create({ projectId: p.id, kind: 'agent', agentId: a.id, displayName: 'ordinary join' }), { code: 'member_removed' });
    await compensation.revoke(access, p.id, removed.auditId);
    for (const [table, key] of [['agent_runtime_bindings', 'id'], ['agent_runner_states', 'binding_id']] as const) assert.equal((await db.query(`SELECT ${key} FROM ${table} WHERE ${key} = ?`, [bindingId])).length, 0);
    assert.equal((await db.query('SELECT member_id FROM agent_runtime_members WHERE member_id = ?', [m.id])).length, 0);
    assert.equal((await db.query('SELECT id FROM agent_runtimes WHERE id = ?', [runtimeId])).length, 1);
    const row = (await repos.audit.get(p.id, removed.auditId))!;
    assert.doesNotMatch(row.before!, /defaults_json|testOnly|lease_owner|harness_session_id/);
  }));
  test(`${engine} 采集超限在首次业务写前拒绝；执行中超时等待真实回滚`, { skip }, async () => withDb(engine, async (repos, db) => {
    const p = await repos.projects.create({ name: '预算' }), m = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '成员' });
    await repos.transaction(async () => { for (let i = 0; i < 129; i++) await repos.groups.create({ projectId: p.id, name: `群${i}`, participantMemberIds: [m.id] }); });
    const service = createOrgMutationService({ repos });
    if (engine === 'sqlite') await db.exec("CREATE TRIGGER deny_budget_write BEFORE UPDATE OF removed_at ON members BEGIN SELECT RAISE(ABORT, 'unexpected_business_write_before_budget'); END");
    await assert.rejects(() => service.removeMember(access, p.id, m.id), { code: 'audit_capture_budget_exceeded' });
    assert.equal((await repos.members.get(m.id))!.membershipRevision, 1);
    assert.equal((await repos.audit.list(p.id)).length, 0);
    if (engine === 'sqlite') await db.exec('DROP TRIGGER deny_budget_write');
    const other = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '少量关系' });
    const append = repos.audit.append;
    repos.audit.append = async row => { await new Promise(resolve => setTimeout(resolve, 520)); return append(row); };
    await assert.rejects(() => service.removeMember(access, p.id, other.id), { code: 'audit_capture_budget_exceeded' });
    repos.audit.append = append;
    assert.equal((await repos.members.get(other.id))!.membershipRevision, 1);
    assert.equal((await repos.audit.list(p.id)).length, 0);
  }));
}

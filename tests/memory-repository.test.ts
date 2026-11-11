import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { createDbDriver, type DbDriver } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories, type RepositorySet } from "../src/server/db/repositories.ts";
import { RepositoryError } from "../src/server/db/errors.ts";
import { appendAuditEntry } from "../src/server/audit.ts";
import type { MemoryDocument, MemoryKey, MemoryVersion, MemorySummaryRequest } from "../src/shared/memory.ts";
import type { Task, WorkEvent } from "../src/shared/tasks.ts";
import type { ScanScope } from "../src/server/memory/repository.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const at = "2026-11-10T12:00:00.000Z";
const author = { kind: "human" as const, actorId: "owner", agentId: null, displayName: "人" };
const code = (expected: string) => (error: unknown) => error instanceof RepositoryError && error.code === expected;
async function withDb(engine: "sqlite" | "postgres", run: (repos: RepositorySet, db: DbDriver) => Promise<void>, schemaVersion = 12): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-"));
  const schema = `memory_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations.filter(m => m.version <= schemaVersion)); await run(createRepositories(db), db); }
  finally {
    await db.close();
    if (engine === "postgres") {
      const admin = new Client({ connectionString: pgUrl }); await admin.connect();
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
async function fixture(repos: RepositorySet) {
  const project = await repos.projects.create({ name: "记忆项目" });
  const agent = await repos.agents.create({ displayName: "目标 Agent", hostType: "codex-cli" });
  const member = await repos.members.create({ projectId: project.id, agentId: agent.id, kind: "agent", displayName: agent.displayName });
  const group = await repos.groups.create({ projectId: project.id, name: "取材群", participantMemberIds: [member.id] });
  return { project, agent, member, group };
}
function document(key: MemoryKey, markdown = "# 记忆\n保留 emoji 🧠"): MemoryDocument {
  return { id: randomUUID(), key, version: 1, markdown, byteLength: Buffer.byteLength(markdown), updatedAt: at, updatedBy: author, source: "human" };
}
function version(doc: MemoryDocument, mutationId: string = randomUUID()): MemoryVersion {
  return { id: randomUUID(), documentId: doc.id, version: doc.version, parentVersion: doc.version - 1, markdown: doc.markdown,
    byteLength: doc.byteLength, contentSha256: createHash("sha256").update(doc.markdown).digest("hex"), author: doc.updatedBy,
    source: doc.source, clientMutationId: mutationId, summaryRequestId: null, createdAt: doc.updatedAt };
}
function request(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<MemorySummaryRequest> = {}): MemorySummaryRequest {
  return { id: randomUUID(), projectId: f.project.id, agentId: f.agent.id, recipientMemberId: f.member.id, contextGroupId: f.group.id,
    documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "message_threshold", triggerKey: randomUUID(), taskId: null,
    completedTaskRevision: null, messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null, beginMutationId: null,
    resultVersion: null, resultSha256: null, error: null, evidence: null, createdAt: at, startedAt: null, finishedAt: null, ...patch };
}

for (const engine of ["sqlite", "postgres"] as const) {
  test(`${engine} 过期运行请求在 SQL 内按开始时间筛选并限制数量，不被未过期前缀饿死`, { skip: engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL" : false }, async () => withDb(engine, async repos => {
    const f = await fixture(repos);
    const otherGroup = await repos.groups.create({ projectId: f.project.id, name: "不在当前绑定内", participantMemberIds: [f.member.id] });
    for (let i = 0; i < 52; i++) await repos.memory.createRequest(request(f, { state: "running", contextGroupId: otherGroup.id, startedAt: "2026-11-10T09:00:00.000Z", attemptId: `foreign-${i}` }));
    for (let i = 0; i < 52; i++) await repos.memory.createRequest(request(f, { state: "running", startedAt: "2026-11-10T13:00:00.000Z", attemptId: `fresh-${i}` }));
    const expired = [];
    for (let i = 0; i < 3; i++) {
      const row = request(f, { state: "running", startedAt: `2026-11-10T10:00:0${i}.000Z`, attemptId: `old-${i}` });
      await repos.memory.createRequest(row); expired.push(row.id);
    }
    assert.deepEqual((await repos.memory.listRequests(f.project.id, f.agent.id, "running", { startedBefore: at, limit: 2, contextGroupId: f.group.id })).map(row => row.id), expired.slice(0, 2));
    assert.deepEqual(await repos.memory.listRequests(f.project.id, f.agent.id, "running", { startedBefore: at, limit: 2 }), []);
    await assert.rejects(repos.memory.listRequests(f.project.id, f.agent.id, "running", { startedBefore: at, limit: 51 }), { code: "invalid_argument" });
  }));
}
function event(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<WorkEvent> = {}): WorkEvent {
  return { id: randomUUID(), projectId: f.project.id, recipientMemberId: f.member.id, taskId: null, contextGroupId: f.group.id,
    kind: "memory.summary_requested", eventKey: randomUUID(), payload: { requestId: "request", requestRevision: 1, trigger: "session_end" },
    deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null, ...patch };
}
const projectMemoryCounts = ["memoryDocuments", "memoryVersions", "memorySummaryRequests", "memoryMessageReceipts", "memoryTriggerCounters", "memoryScanCheckpoints"] as const;
const groupMemoryCounts = ["memorySummaryRequests", "memoryMessageReceipts", "memoryTriggerCounters", "memoryScanCheckpoints", "workEvents"] as const;
async function seedMemoryArtifacts(repos: RepositorySet) {
  const f = await fixture(repos);
  const docs = [document({ scope: "global", projectId: null, agentId: f.agent.id }),
    document({ scope: "project", projectId: f.project.id, agentId: null }),
    document({ scope: "project-agent", projectId: f.project.id, agentId: f.agent.id })];
  docs[2]!.updatedBy = { kind: "agent", actorId: f.member.id, agentId: f.agent.id, displayName: f.member.displayName };
  docs[2]!.source = "agent";
  await repos.transaction(async () => {
    for (const doc of docs) { await repos.memory.insertHead(doc); await repos.memory.insertVersion(version(doc)); }
  });
  const sender = await repos.members.create({ projectId: f.project.id, kind: "human", displayName: "历史发信人" });
  await repos.groups.addParticipant(f.group.id, sender.id);
  const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: sender.id, body: "保留的取材事实" });
  await repos.deliveries.markMcpDelivered(message.id, f.member.id, at);
  await repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: message.id, threshold: 1, at });
  const summary = request(f, { documentId: docs[2]!.id, baseVersion: 1, messageIds: [message.id] });
  await repos.memory.createRequest(summary);
  assert.deepEqual(await repos.memory.getRequest(summary.id), summary);
  const work = event(f, { payload: { requestId: summary.id, requestRevision: 1, trigger: summary.trigger } });
  await repos.tasks.enqueueWorkEvent(work);
  for (const kind of ["message_threshold", "task_completed"] as const) {
    const scope = { kind, projectId: f.project.id, agentId: f.agent.id, groupId: kind === "message_threshold" ? f.group.id : null };
    await repos.memory.updateScanCheckpointCas({ scope, after: null, through: await repos.memory.scanHighWater(scope), sweep: 1, revision: 1 }, 0);
  }
  return { ...f, docs, summary, work, message };
}
async function summaryEvent(repos: RepositorySet, f: Awaited<ReturnType<typeof fixture>>, contextGroupId: string | null, createdAt = at) {
  const summary = request(f, { contextGroupId, trigger: "session_end" });
  await repos.memory.createRequest(summary);
  return repos.tasks.enqueueWorkEvent(event(f, { contextGroupId, createdAt,
    payload: { requestId: summary.id, requestRevision: summary.revision, trigger: summary.trigger } }));
}
async function taskFixture(repos: RepositorySet, f: Awaited<ReturnType<typeof fixture>>) {
  const task: Task = { id: randomUUID(), projectId: f.project.id, title: "完成来源任务", body: "固定验收", labels: [], state: "todo",
    assigneeMemberId: f.member.id, reviewerMemberId: f.member.id, repoPath: null, fixedPoint: null, revision: 1,
    currentReviewRoundId: null, blockedReason: null, author, createdAt: at, updatedAt: at };
  return repos.tasks.create(task);
}
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；交既有 CI 门控执行" : false;
  test(`${engine} 三层 head/version 真实持久化、跨项目 global CAS 和历史幂等键`, { skip }, async () => {
    await withDb(engine, async repos => {
      const f = await fixture(repos);
      const key: MemoryKey = { scope: "global", agentId: f.agent.id, projectId: null };
      assert.equal(await repos.memory.get(key), null);
      const doc = document(key); const v1 = version(doc, "first");
      await repos.transaction(async () => { await repos.memory.insertHead(doc); await repos.memory.insertVersion(v1); });
      assert.deepEqual(await repos.memory.get(key), doc);
      assert.deepEqual(await repos.memory.findMutation(doc.id, "owner", "first"), v1);
      assert.deepEqual(await repos.memory.listProject(f.project.id), []);
      const save = (text: string) => repos.transaction(async () => {
        const next = { ...doc, version: 2, markdown: text, byteLength: Buffer.byteLength(text) };
        await repos.memory.updateHeadCas(doc.id, 1, next); await repos.memory.insertVersion(version(next)); return next;
      });
      const results = await Promise.allSettled([save("候选 A"), save("候选 B")]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(code("conflict")((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason));
      assert.equal((await repos.memory.get(key))!.version, 2);
      assert.deepEqual(await repos.memory.getVersion(doc.id, 1), v1);
      assert.deepEqual((await repos.memory.listVersions(doc.id)).map(v => v.version), [2, 1]);
      assert.deepEqual((await repos.memory.listVersions(doc.id, 2)).map(v => v.version), [1]);
      assert.deepEqual(await repos.audit.list(f.project.id), []);
      await assert.rejects(() => repos.memory.updateHeadCas(doc.id, 2, { ...doc, version: 3, key: { scope: "project", projectId: f.project.id, agentId: null } }), code("invalid_argument"));
      const head = (await repos.memory.get(key))!;
      await assert.rejects(() => repos.transaction(async () => {
        const next = { ...head, version: 3 }; await repos.memory.updateHeadCas(doc.id, 2, next);
        await repos.memory.insertVersion({ ...version(next), clientMutationId: "first" });
      }), code("conflict"));
      assert.equal((await repos.memory.get(key))!.version, 2);
    });
  });
  test(`${engine} 真实 MCP 首次投递标记、ACK 不计数、阈值批次及收据去重`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const makeMessage = () => repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "需要记忆" });
      const m1 = await makeMessage();
      await repos.deliveries.recordAttempt(m1.id, f.member.id, "acked", at);
      assert.equal((await repos.deliveries.get(m1.id, f.member.id))!.firstMcpDeliveredAt, null);
      const scope = { kind: "message_threshold" as const, projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id };
      assert.equal(await repos.memory.scanHighWater(scope), null);
      await assert.rejects(() => repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: m1.id, threshold: 2, at }), code("invalid_reference"));
      const m2 = await makeMessage(); const m3 = await makeMessage();
      await repos.deliveries.markMcpDelivered(m2.id, f.member.id, at);
      await repos.deliveries.recordAttempt(m2.id, f.member.id, "acked", at);
      await repos.deliveries.markMcpDelivered(m2.id, f.member.id, "2026-11-10T12:01:00.000Z");
      assert.equal((await repos.deliveries.get(m2.id, f.member.id))!.firstMcpDeliveredAt, at);
      assert.equal((await repos.deliveries.get(m2.id, f.member.id))!.status, "acked");
      await repos.deliveries.markMcpDelivered(m3.id, f.member.id, at);
      const observe = (id: string) => repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: id, threshold: 2, at });
      const results = await Promise.all([observe(m2.id), observe(m3.id), observe(m2.id)]);
      assert.equal(results.filter(r => r.added).length, 2);
      const threshold = results.find(r => r.thresholdSequence !== null)!;
      assert.equal(threshold.thresholdSequence, 1); assert.deepEqual(new Set(threshold.messageIds), new Set([m2.id, m3.id]));
      assert.equal((await db.query<{ lifetime_count: number }>("SELECT lifetime_count FROM memory_trigger_counters"))[0]!.lifetime_count, 2);
      const high = (await repos.memory.scanHighWater(scope))!;
      const scanned = await repos.memory.unobservedDeliveries(f.project.id, f.member.id, f.group.id, { after: null, through: high, limit: 2 });
      assert.equal(scanned.rows.length, 0); assert.equal(scanned.scannedCount, 2); assert.ok(scanned.nextCursor);
    });
  });
  test(`${engine} 群清理准确计数并保留三层文档、历史和任务扫描位置`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await seedMemoryArtifacts(repos);
      const preview = await repos.groups.previewPurge(f.group.id);
      for (const key of groupMemoryCounts) assert.equal(preview[key], 1, key);
      assert.deepEqual(await repos.groups.purge(f.group.id), preview);
      for (const doc of f.docs) {
        assert.deepEqual(await repos.memory.get(doc.key), doc);
        assert.equal((await repos.memory.listVersions(doc.id)).length, 1);
      }
      assert.equal(await repos.memory.getRequest(f.summary.id), null);
      for (const table of ["memory_summary_requests", "memory_message_receipts", "memory_trigger_counters", "work_events"]) {
        assert.equal(Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n), 0, table);
      }
      assert.deepEqual(await db.query("SELECT kind, group_id FROM memory_scan_checkpoints"), [{ kind: "task_completed", group_id: null }]);
      assert.ok(await repos.members.get(f.member.id));
    });
  });
  test(`${engine} 项目清理准确计数、只删除项目记忆并保留 global 历史`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await seedMemoryArtifacts(repos);
      const preview = await repos.projects.previewPurge(f.project.id);
      for (const key of projectMemoryCounts) assert.equal(preview[key], ["memoryDocuments", "memoryVersions", "memoryScanCheckpoints"].includes(key) ? 2 : 1, key);
      assert.deepEqual(await repos.projects.purge(f.project.id), preview);
      assert.equal(await repos.projects.get(f.project.id), null);
      assert.deepEqual(await repos.memory.get(f.docs[0]!.key), f.docs[0]);
      assert.equal((await repos.memory.listVersions(f.docs[0]!.id)).length, 1);
      for (const doc of f.docs.slice(1)) assert.equal(await repos.memory.get(doc.key), null);
      for (const table of ["memory_summary_requests", "memory_message_receipts", "memory_trigger_counters", "memory_scan_checkpoints", "work_events"]) {
        assert.equal(Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n), 0, table);
      }
    });
  });
  test(`${engine} 成员清理请求和事件但保留稳定 Agent 文档及历史作者`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await seedMemoryArtifacts(repos);
      await repos.members.delete(f.member.id);
      assert.equal(await repos.memory.getRequest(f.summary.id), null);
      assert.equal(Number((await db.query<{ n: number | string }>("SELECT COUNT(*) AS n FROM work_events"))[0]!.n), 0);
      for (const doc of f.docs) {
        assert.deepEqual(await repos.memory.get(doc.key), doc);
        assert.deepEqual((await repos.memory.listVersions(doc.id))[0]!.author, doc.updatedBy);
      }
      assert.equal((await repos.messages.get(f.message.id))!.body, "保留的取材事实");
    });
  });
  test(`${engine} v11 fixture 无记忆表时返回零计数并完成群和项目清理`, { skip }, async () => {
    await withDb(engine, async repos => {
      const f = await fixture(repos);
      for (const key of projectMemoryCounts) assert.equal((await repos.projects.previewPurge(f.project.id))[key], 0, key);
      for (const key of groupMemoryCounts) assert.equal((await repos.groups.previewPurge(f.group.id))[key], 0, key);
      await repos.groups.purge(f.group.id); await repos.projects.purge(f.project.id);
    }, 11);
  });
  test(`${engine} v11 升级 v12 保留旧审计、checksum 与索引且不伪造 MCP 投递事实`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "旧版投递" });
      await repos.deliveries.recordAttempt(message.id, f.member.id, "acked", at);
      const audit = await appendAuditEntry(repos.audit, { projectId: f.project.id, actor: { kind: "human", name: "人" }, action: "org.node_update",
        targetKind: "node", targetId: "old-node", targetName: "旧岗位", before: { name: "旧名" }, after: { name: "新名" }, detail: { keep: true } });
      await repos.audit.markReversed(f.project.id, audit.id, "compensation", at);
      const oldAudit = await repos.audit.get(f.project.id, audit.id);
      const oldMigrations = (await db.migrationState()).applied;
      assert.equal((await db.migrate(migrations)).version, 12);
      assert.deepEqual((await db.migrationState()).applied.slice(0, 11), oldMigrations);
      assert.deepEqual(await repos.audit.get(f.project.id, audit.id), oldAudit);
      assert.equal((await repos.deliveries.get(message.id, f.member.id))!.firstMcpDeliveredAt, null);
      const indexes = await db.query<{ name: string }>(engine === "sqlite"
        ? "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'"
        : "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_log'");
      for (const name of ["ix_audit_project_created", "ix_audit_project_target", "ix_audit_project_action"]) assert.ok(indexes.some(row => row.name === name));
      const memoryAudit = await appendAuditEntry(repos.audit, { projectId: f.project.id, actor: { kind: "human", name: "人" }, action: "memory.updated",
        targetKind: "memory", targetId: "document", targetName: "项目记忆" });
      assert.equal((await repos.audit.get(f.project.id, memoryAudit.id))!.targetKind, "memory");
      assert.deepEqual((await db.migrate(migrations)).applied, []);
    }, 11);
  });
  test(`${engine} 错群和缺失群上下文均不能 ACK；同群幂等也不能绕过群边界`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const other = await repos.groups.create({ projectId: f.project.id, name: "其他群", participantMemberIds: [f.member.id] });
      const work = await summaryEvent(repos, f, f.group.id);
      await assert.rejects(() => repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at, { contextGroupId: other.id }), code("not_found"));
      await assert.rejects(() => repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at), code("not_found"));
      assert.deepEqual(await db.query("SELECT delivery_state, attempts, acked_at FROM work_events WHERE id = ?", [work.id]), [{ delivery_state: "pending", attempts: 0, acked_at: null }]);
      const ack = await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at, { contextGroupId: f.group.id });
      assert.equal(ack.alreadyAcknowledged, false); assert.equal(ack.event.deliveryState, "acked");
      const again = await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, "2026-11-10T12:05:00.000Z", { contextGroupId: f.group.id });
      assert.equal(again.alreadyAcknowledged, true); assert.equal(again.event.ackedAt, at);
      await assert.rejects(() => repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at, { contextGroupId: other.id }), code("not_found"));
      assert.equal((await repos.memory.getRequest(String(work.payload.requestId)))!.state, "pending");
    });
  });
  test(`${engine} 工作事件群过滤先于 LIMIT，混合错群投递批次原子回滚`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const other = await repos.groups.create({ projectId: f.project.id, name: "早到但不可见的群", participantMemberIds: [f.member.id] });
      const foreign = await summaryEvent(repos, f, other.id);
      await summaryEvent(repos, f, other.id);
      const unbound = await summaryEvent(repos, f, null, "2026-11-10T12:01:00.000Z");
      const bound = await summaryEvent(repos, f, f.group.id, "2026-11-10T12:02:00.000Z");
      assert.deepEqual((await repos.tasks.listUnackedWorkEvents(f.project.id, f.member.id, 2, { contextGroupId: f.group.id })).map(row => row.id), [unbound.id, bound.id]);
      assert.deepEqual((await repos.tasks.listUnackedWorkEvents(f.project.id, f.member.id, 2)).map(row => row.id), [unbound.id]);
      await assert.rejects(() => repos.tasks.markWorkEventsDelivered(f.project.id, f.member.id, [unbound.id, foreign.id], at, { contextGroupId: f.group.id }), code("not_found"));
      await assert.rejects(() => repos.tasks.markWorkEventsDelivered(f.project.id, f.member.id, [bound.id], at), code("not_found"));
      for (const id of [unbound.id, bound.id, foreign.id]) assert.deepEqual(await db.query("SELECT delivery_state, attempts, first_delivered_at FROM work_events WHERE id = ?", [id]), [{ delivery_state: "pending", attempts: 0, first_delivered_at: null }]);
      const delivered = await repos.tasks.markWorkEventsDelivered(f.project.id, f.member.id, [unbound.id, bound.id, bound.id], at, { contextGroupId: f.group.id });
      assert.deepEqual(delivered.map(row => row.id), [unbound.id, bound.id]);
      assert.ok(delivered.every(row => row.attempts === 1 && row.firstDeliveredAt === at));
      await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, bound.id, at, { contextGroupId: f.group.id });
      await assert.rejects(() => repos.tasks.markWorkEventsDelivered(f.project.id, f.member.id, [bound.id], at, { contextGroupId: other.id }), code("not_found"));
    });
  });
  test(`${engine} v11 无 context_group_id 列时工作事件投递与 ACK 保持兼容`, { skip }, async () => {
    await withDb(engine, async repos => {
      const f = await fixture(repos); const task = await taskFixture(repos, f);
      const work = await repos.tasks.enqueueWorkEvent(event(f, { contextGroupId: null, taskId: task.id, kind: "task.assigned", payload: { revision: 1 } }));
      assert.deepEqual((await repos.tasks.listUnackedWorkEvents(f.project.id, f.member.id, 1, { contextGroupId: f.group.id })).map(row => row.id), [work.id]);
      assert.equal((await repos.tasks.markWorkEventsDelivered(f.project.id, f.member.id, [work.id], at, { contextGroupId: f.group.id }))[0]!.attempts, 1);
      assert.equal((await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at)).alreadyAcknowledged, false);
      assert.equal((await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, work.id, at, { contextGroupId: f.group.id })).alreadyAcknowledged, true);
    }, 11);
  });
  test(`${engine} 消息扫描固定 high-water，已观察空页推进且重连读回持久 checkpoint`, { skip }, async () => {
    await withDb(engine, async (initialRepos, db) => {
      let repos = initialRepos;
      const f = await fixture(repos);
      const scope: ScanScope = { kind: "message_threshold", projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id };
      const messages: string[] = [];
      const add = async (index: number, when: string) => {
        const m = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: `输入 ${index}` });
        await repos.deliveries.markMcpDelivered(m.id, f.member.id, when);
        await db.exec("UPDATE message_deliveries SET id = ? WHERE message_id = ? AND member_id = ?", [`delivery-${index}`, m.id, f.member.id]);
        messages.push(m.id);
      };
      for (let i = 1; i <= 3; i++) await add(i, at);
      for (const id of messages.slice(0, 2)) await repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: id, threshold: 10, at });
      const high = (await repos.memory.scanHighWater(scope))!;
      assert.deepEqual(high, { at, id: "delivery-3" });
      const first = await repos.memory.unobservedDeliveries(f.project.id, f.member.id, f.group.id, { after: null, through: high, limit: 2 });
      assert.deepEqual(first, { rows: [], nextCursor: { at, id: "delivery-2" }, hasMore: true, scannedCount: 2 });
      await repos.memory.updateScanCheckpointCas({ scope, after: first.nextCursor, through: high, sweep: 1, revision: 1 }, 0);
      await add(4, "2026-11-10T12:01:00.000Z");
      await db.close(); await db.connect(); repos = createRepositories(db);
      const checkpoint = await repos.memory.getScanCheckpoint(scope);
      assert.deepEqual(checkpoint, { scope, after: first.nextCursor, through: high, sweep: 1, revision: 1 });
      const last = await repos.memory.unobservedDeliveries(f.project.id, f.member.id, f.group.id, { after: checkpoint.after, through: checkpoint.through!, limit: 2 });
      assert.deepEqual(last, { rows: [{ messageId: messages[2], groupId: f.group.id }], nextCursor: high, hasMore: false, scannedCount: 1 });
      const candidates = await Promise.allSettled([1, 2].map(() => repos.memory.updateScanCheckpointCas({ ...checkpoint, after: last.nextCursor, revision: 2 }, 1)));
      assert.equal(candidates.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(code("conflict")((candidates.find(r => r.status === "rejected") as PromiseRejectedResult).reason));
      assert.equal((await repos.memory.getScanCheckpoint(scope)).revision, 2);
      await repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: messages[2]!, threshold: 10, at });
      const nextHigh = (await repos.memory.scanHighWater(scope))!;
      assert.deepEqual(nextHigh, { at: "2026-11-10T12:01:00.000Z", id: "delivery-4" });
      assert.deepEqual((await repos.memory.unobservedDeliveries(f.project.id, f.member.id, f.group.id, { after: null, through: nextHigh, limit: 50 })).rows, [{ messageId: messages[3], groupId: f.group.id }]);
      await assert.rejects(() => repos.memory.unobservedDeliveries(f.project.id, f.member.id, f.group.id, { after: null, through: high, limit: 51 }), code("invalid_argument"));
    });
  });
  test(`${engine} task completion 扫描越过 50 条无效前缀，ACK 无关且 pending/failed 请求去重`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos); const task = await taskFixture(repos, f);
      const scope: ScanScope = { kind: "task_completed", projectId: f.project.id, agentId: f.agent.id, groupId: null };
      const emit = async (index: number, payload: Record<string, unknown>, when = at) => repos.tasks.enqueueWorkEvent(event(f, {
        id: `completion-${String(index).padStart(3, "0")}`, contextGroupId: null, taskId: task.id, kind: "task.review_decided", payload, createdAt: when,
      }));
      for (let i = 0; i <= 50; i++) await emit(i, { enteredDone: false, assigneeAgentId: f.agent.id, completionRevision: i + 1 });
      const completed = [];
      for (let i = 51; i <= 54; i++) completed.push(await emit(i, { enteredDone: true, assigneeAgentId: f.agent.id, completionRevision: i + 1 }));
      await repos.tasks.acknowledgeWorkEvent(f.project.id, f.member.id, completed[0]!.id, at);
      for (const [i, state] of [[1, "failed"], [2, "pending"]] as const) {
        const work = completed[i]!;
        const summary = request(f, { contextGroupId: null, trigger: "task_completed", taskId: task.id, completedTaskRevision: Number(work.payload.completionRevision), sourceWorkEventId: work.id,
          triggerKey: `task:${task.id}:done:${work.payload.completionRevision}:agent:${f.agent.id}` });
        await repos.memory.createRequest(summary);
        if (state === "failed") await repos.memory.updateRequestCas(summary.id, 1, { state, error: { code: "input_unavailable", message: "输入不可用" }, finishedAt: at });
      }
      const high = (await repos.memory.scanHighWater(scope))!;
      await emit(55, { enteredDone: true, assigneeAgentId: f.agent.id, completionRevision: 56 }, "2026-11-10T12:01:00.000Z");
      const first = await repos.memory.scanUnmaterializedTaskCompletions(f.project.id, f.agent.id, { after: null, through: high, limit: 50 });
      assert.deepEqual(first, { rows: [], nextCursor: { at, id: "completion-049" }, hasMore: true, scannedCount: 50 });
      await repos.memory.updateScanCheckpointCas({ scope, after: first.nextCursor, through: high, revision: 1, sweep: 1 }, 0);
      await db.close(); await db.connect();
      const resumed = createRepositories(db);
      const checkpoint = await resumed.memory.getScanCheckpoint(scope);
      const second = await resumed.memory.scanUnmaterializedTaskCompletions(f.project.id, f.agent.id, { after: checkpoint.after, through: checkpoint.through!, limit: 2 });
      assert.equal(second.scannedCount, 2); assert.equal(second.hasMore, true);
      assert.deepEqual(second.rows.map(row => row.eventId), [completed[0]!.id]);
      const materialized = await resumed.memory.scanUnmaterializedTaskCompletions(f.project.id, f.agent.id, { after: second.nextCursor, through: high, limit: 2 });
      assert.deepEqual(materialized, { rows: [], nextCursor: { at, id: completed[2]!.id }, hasMore: true, scannedCount: 2 });
      const tail = await resumed.memory.scanUnmaterializedTaskCompletions(f.project.id, f.agent.id, { after: materialized.nextCursor, through: high, limit: 2 });
      assert.equal(tail.scannedCount, 1); assert.equal(tail.hasMore, false);
      assert.deepEqual(tail.rows, [{ eventId: completed[3]!.id, taskId: task.id, completionRevision: 55, assigneeAgentId: f.agent.id,
        recipientMemberId: f.member.id, triggerKey: `task:${task.id}:done:55:agent:${f.agent.id}` }]);
      assert.deepEqual((await resumed.memory.scanUnmaterializedTaskCompletions(f.project.id, "different-agent", { after: first.nextCursor, through: high, limit: 50 })).rows, []);
    });
  });
  test(`${engine} 投递事实、收据计数、请求事件、审计和 checkpoint 复用同一事务，失败零残留`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "原子触发" });
      const beforeDelivery = await repos.deliveries.get(message.id, f.member.id);
      const scope: ScanScope = { kind: "message_threshold", projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id };
      const materialize = (fail: boolean) => repos.transaction(async () => {
        await repos.deliveries.markMcpDelivered(message.id, f.member.id, at);
        const receipt = await repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: message.id, threshold: 1, at });
        if (!receipt.added) return null;
        const summary = request(f, { triggerKey: `threshold:${receipt.thresholdSequence}`, messageIds: receipt.messageIds });
        await repos.memory.createRequest(summary);
        await repos.tasks.enqueueWorkEvent(event(f, { payload: { requestId: summary.id, requestRevision: 1, trigger: summary.trigger } }));
        await appendAuditEntry(repos.audit, { projectId: f.project.id, actor: { kind: "system", name: "记忆触发" }, action: "memory.summary_requested",
          targetKind: "memory", targetId: summary.id, targetName: "待总结请求" });
        const high = (await repos.memory.scanHighWater(scope))!;
        await repos.memory.updateScanCheckpointCas({ scope, after: high, through: high, sweep: 1, revision: 1 }, 0);
        if (fail) throw new Error("forced-after-checkpoint");
        return summary;
      });
      await assert.rejects(() => materialize(true), /forced-after-checkpoint/);
      for (const table of ["memory_message_receipts", "memory_trigger_counters", "memory_summary_requests", "memory_scan_checkpoints", "work_events", "audit_log"]) {
        assert.equal(Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n), 0, table);
      }
      assert.deepEqual(await repos.deliveries.get(message.id, f.member.id), beforeDelivery);
      assert.equal((await repos.memory.getScanCheckpoint(scope)).revision, 0);
      const retried = await Promise.all([materialize(false), materialize(false)]);
      const saved = retried.find(row => row !== null)!;
      assert.equal(retried.filter(row => row !== null).length, 1);
      assert.deepEqual(await repos.memory.getRequest(saved.id), saved);
      for (const table of ["memory_message_receipts", "memory_trigger_counters", "memory_summary_requests", "memory_scan_checkpoints", "work_events", "audit_log"]) {
        assert.equal(Number((await db.query<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n), 1, table);
      }
      assert.equal(Number((await db.query<{ lifetime_count: number | string }>("SELECT lifetime_count FROM memory_trigger_counters"))[0]!.lifetime_count), 1);
      assert.deepEqual(saved.messageIds, [message.id]);
      assert.equal((await repos.deliveries.get(message.id, f.member.id))!.firstMcpDeliveredAt, at);
    });
  });
  test(`${engine} request CAS 唯一领取，完成证据和正文版本原子保存且终态不可覆盖`, { skip }, async () => {
    await withDb(engine, async repos => {
      const f = await fixture(repos);
      const doc = document({ scope: "project-agent", projectId: f.project.id, agentId: f.agent.id });
      await repos.transaction(async () => { await repos.memory.insertHead(doc); await repos.memory.insertVersion(version(doc)); });
      const summary = request(f, { documentId: doc.id, baseVersion: 1 });
      await repos.memory.createRequest(summary);
      const claim = (attemptId: string) => repos.memory.updateRequestCas(summary.id, 1, { state: "running", attemptId, beginMutationId: attemptId, startedAt: at });
      const claims = await Promise.allSettled([claim("attempt-a"), claim("attempt-b")]);
      assert.equal(claims.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(code("conflict")((claims.find(r => r.status === "rejected") as PromiseRejectedResult).reason));
      const running = (await repos.memory.getRequest(summary.id))!;
      assert.equal(running.state, "running"); assert.equal(running.revision, 2);
      await assert.rejects(() => repos.memory.updateRequestCas(summary.id, 2, { contextGroupId: null }), code("invalid_argument"));
      await assert.rejects(() => repos.memory.updateRequestCas(summary.id, 2, { state: "completed", resultVersion: 2, resultSha256: "missing-evidence" }), code("invalid_argument"));
      assert.deepEqual(await repos.memory.getRequest(summary.id), running);
      const markdown = "# 测试生成正文\n仅验证数据通道，不是真实模型执行证据。";
      const hash = createHash("sha256").update(markdown).digest("hex");
      const evidence = { provenance: "agent-declared" as const, host: "fixture-only", hostVersion: "test", invocationId: "fixture-invocation", contextId: "fixture-context",
        startedAt: at, completedAt: "2026-11-10T12:01:00.000Z", promptSha256: "f".repeat(64), outputSha256: hash, evidenceRef: "fixture:memory-repository" };
      const next: MemoryDocument = { ...doc, version: 2, markdown, byteLength: Buffer.byteLength(markdown), source: "self-summary", updatedAt: evidence.completedAt,
        updatedBy: { kind: "agent", actorId: f.member.id, agentId: f.agent.id, displayName: f.member.displayName } };
      const complete = (expectedRevision: number) => repos.transaction(async () => {
        await repos.memory.updateHeadCas(doc.id, 1, next);
        await repos.memory.insertVersion({ ...version(next), summaryRequestId: summary.id });
        return repos.memory.updateRequestCas(summary.id, expectedRevision, { state: "completed", resultVersion: 2, resultSha256: hash, evidence, finishedAt: evidence.completedAt });
      });
      await assert.rejects(() => complete(1), code("conflict"));
      assert.deepEqual(await repos.memory.get(doc.key), doc);
      assert.equal((await repos.memory.listVersions(doc.id)).length, 1);
      assert.deepEqual(await repos.memory.getRequest(summary.id), running);
      const completed = await complete(2);
      assert.deepEqual(await repos.memory.getRequest(summary.id), completed);
      assert.deepEqual(completed.evidence, evidence);
      assert.equal(completed.revision, 3); assert.equal(completed.finishedAt, evidence.completedAt);
      assert.deepEqual(await repos.memory.get(doc.key), next);
      assert.equal((await repos.memory.getVersion(doc.id, 2))!.summaryRequestId, summary.id);
      await assert.rejects(() => repos.memory.updateRequestCas(summary.id, 3, { state: "running", evidence: null }), code("conflict"));
      assert.deepEqual(await repos.memory.getRequest(summary.id), completed);
    });
  });
  test(`${engine} 归档保留读取并冻结正文、请求、收据和 checkpoint 写入`, { skip }, async () => {
    await withDb(engine, async repos => {
      const f = await seedMemoryArtifacts(repos);
      await repos.projects.archive(f.project.id, at);
      for (const doc of f.docs) assert.deepEqual(await repos.memory.get(doc.key), doc);
      assert.deepEqual(await repos.memory.getRequest(f.summary.id), f.summary);
      const doc = f.docs[2]!;
      await assert.rejects(() => repos.memory.updateHeadCas(doc.id, 1, { ...doc, version: 2 }), code("archived"));
      await assert.rejects(() => repos.memory.updateRequestCas(f.summary.id, 1, { state: "running", attemptId: "attempt", startedAt: at }), code("archived"));
      await assert.rejects(() => repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: f.message.id, threshold: 1, at }), code("archived"));
      const checkpoint = await repos.memory.getScanCheckpoint({ kind: "message_threshold", projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id });
      await assert.rejects(() => repos.memory.updateScanCheckpointCas({ ...checkpoint, revision: 2 }, 1), code("archived"));
      assert.equal((await repos.memory.get(doc.key))!.version, 1);
      assert.equal((await repos.memory.getRequest(f.summary.id))!.revision, 1);
    });
  });
}

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
import type { MemoryDocument, MemoryKey, MemoryVersion, MemorySummaryRequest } from "../src/shared/memory.ts";
import type { Task, WorkEvent } from "../src/shared/tasks.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const at = "2026-11-10T12:00:00.000Z";
const author = { kind: "human" as const, actorId: "owner", agentId: null, displayName: "人" };
const code = (expected: string) => (error: unknown) => error instanceof RepositoryError && error.code === expected;
async function withDb(engine: "sqlite" | "postgres", run: (repos: RepositorySet, db: DbDriver) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-memory-"));
  const schema = `memory_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await run(createRepositories(db), db); }
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
function event(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<WorkEvent> = {}): WorkEvent {
  return { id: randomUUID(), projectId: f.project.id, recipientMemberId: f.member.id, taskId: null, contextGroupId: f.group.id,
    kind: "memory.summary_requested", eventKey: randomUUID(), payload: { requestId: "request", requestRevision: 1, trigger: "session_end" },
    deliveryState: "pending", attempts: 0, createdAt: at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null, ...patch };
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
}

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
import { MEMBER_FACT_KINDS } from "../src/server/db/types.ts";
import type { MemorySummaryRequest } from "../src/shared/memory.ts";

const pgUrl = process.env["AGENT_STUDIO_PG_TEST_URL"] ?? process.env["AGENT_STUDIO_PG_CONNECTION_STRING"];
const at = "2026-11-11T00:00:00.000Z";
async function withDb(engine: "sqlite" | "postgres", body: (repos: RepositorySet, db: DbDriver) => Promise<void>, version = 13) {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-member-facts-"));
  const schema = `facts_${randomUUID().replaceAll("-", "")}`;
  const db = createDbDriver(engine === "sqlite" ? { dbDriver: "sqlite", dataDir: dir } : { dbDriver: "postgres", pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations.filter(m => m.version <= version)); await body(createRepositories(db), db); }
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
  const project = await repos.projects.create({ name: "保留事实" });
  const agent = await repos.agents.create({ displayName: "Agent", hostType: "fixture" });
  const member = await repos.members.create({ projectId: project.id, kind: "agent", agentId: agent.id, displayName: agent.displayName });
  const other = await repos.members.create({ projectId: project.id, kind: "human", displayName: "人" });
  const group = await repos.groups.create({ projectId: project.id, name: "取材", participantMemberIds: [member.id, other.id] });
  return { project, agent, member, other, group };
}
async function facts(db: DbDriver, memberId: string): Promise<Record<string, number>> {
  return Object.fromEntries((await db.query<{ kind: string; revision: number | string }>("SELECT kind, revision FROM member_fact_revisions WHERE member_id = ? ORDER BY kind", [memberId]))
    .map(row => [row.kind, Number(row.revision)]));
}
for (const engine of ["sqlite", "postgres"] as const) {
  const skip = engine === "postgres" && !pgUrl ? "未配置真实 PostgreSQL；交 CI 执行" : false;
  test(`${engine} v12 有历史作者升级 v13：六行基准、旧 checksum 与历史事实保留`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const message = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "不可回扫或重写的历史正文", mentions: [f.other.id], clientMessageId: "old-client-key" });
      await repos.deliveries.recordAttempt(message.id, f.other.id, "acked", at);
      const old = (await db.migrationState()).applied;
      assert.equal((await db.migrate(migrations)).version, 13);
      assert.deepEqual((await db.migrationState()).applied.slice(0, 12), old);
      for (const member of [f.member, f.other]) {
        assert.deepEqual(await facts(db, member.id), Object.fromEntries(MEMBER_FACT_KINDS.map(kind => [kind, 1])));
        assert.deepEqual(await db.query("SELECT removed_at, membership_revision FROM members WHERE id = ?", [member.id]), [{ removed_at: null, membership_revision: 1 }]);
      }
      assert.deepEqual(await repos.messages.get(message.id), message);
      assert.equal((await repos.deliveries.get(message.id, f.other.id))!.firstMcpDeliveredAt, null);
      await db.exec("UPDATE members SET status = 'disabled', node_id = NULL, role = 'normal', removed_at = ?, membership_revision = membership_revision + 1 WHERE id = ?", [at, f.member.id]);
      await assert.rejects(() => db.exec("UPDATE members SET status = 'active' WHERE id = ?", [f.member.id]));
      assert.equal(await repos.members.get(f.member.id), null);
      assert.equal(await repos.members.findByAgent(f.project.id, f.agent.id), null);
      assert.deepEqual((await repos.members.listByProject(f.project.id)).map(member => member.id), [f.other.id]);
      assert.deepEqual(await repos.groups.participants(f.group.id), [f.other.id]);
      const historical = await repos.members.getIncludingRemoved(f.member.id);
      assert.equal(historical!.removedAt, at); assert.equal(historical!.membershipRevision, 2);
      assert.equal((await repos.members.findByAgentIncludingRemoved(f.project.id, f.agent.id))!.id, f.member.id);
      await assert.rejects(() => repos.members.setStatus(f.member.id, "active"));
      await assert.rejects(() => repos.groups.addParticipant(f.group.id, f.member.id));
      await assert.rejects(() => repos.org.assignNode(f.member.id, null));
      assert.deepEqual((await repos.members.retainedFacts(f.member.id)).map(fact => fact.revision), [1, 1, 1, 1, 1, 1]);
      await repos.mutations.run({ projectIds: [f.project.id], discover: async () => ({ memberIds: [f.member.id], groupIds: [], runtimeIds: [] }) }, async () => {
        const restored = await repos.members.applyLifecycleCas(f.project.id, f.member.id, 2,
          { displayName: historical!.displayName, status: "active", nodeId: null, role: "normal", removedAt: null }, at);
        assert.equal(restored.membershipRevision, 3);
        await assert.rejects(() => repos.members.applyLifecycleCas(f.project.id, f.member.id, 2,
          { displayName: historical!.displayName, status: "disabled", nodeId: null, role: "normal", removedAt: at }, at), /加入周期/);
      });
      assert.equal((await repos.members.get(f.member.id))!.membershipRevision, 3);
      assert.equal((await repos.messages.get(message.id))!.senderMemberId, f.member.id);
    }, 12);
  });
  test(`${engine} 六类事实由真实表写入推进，updated_at 不推进，回滚/同量替换/归属变化可检测`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      const baseline = await facts(db, f.member.id);
      assert.equal(Object.keys(baseline).length, 6);
      const m = await repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "首条" });
      assert.equal((await facts(db, f.member.id))["authored-messages"], 2);
      await db.exec("UPDATE messages SET body = ? WHERE id = ?", ["修改", m.id]);
      await db.exec("UPDATE messages SET body = ? WHERE id = ?", ["首条", m.id]);
      assert.equal((await facts(db, f.member.id))["authored-messages"], 4);
      await db.exec("UPDATE messages SET sender_member_id = ? WHERE id = ?", [f.other.id, m.id]);
      assert.equal((await facts(db, f.member.id))["authored-messages"], 5);
      assert.equal((await facts(db, f.other.id))["authored-messages"], 2);
      await repos.deliveries.markMcpDelivered(m.id, f.member.id, at);
      const delivered = (await facts(db, f.member.id))["deliveries"]!;
      assert.ok(delivered > 1);
      await db.exec("UPDATE message_deliveries SET updated_at = ? WHERE message_id = ? AND member_id = ?", ["2026-11-11T00:01:00.000Z", m.id, f.member.id]);
      assert.equal((await facts(db, f.member.id))["deliveries"], delivered);
      const summary: MemorySummaryRequest = { id: randomUUID(), projectId: f.project.id, agentId: f.agent.id, recipientMemberId: f.member.id, contextGroupId: f.group.id,
        documentId: null, baseVersion: 0, revision: 1, state: "pending", trigger: "session_end", triggerKey: "fact-test", taskId: null, completedTaskRevision: null,
        messageIds: [], sourceWorkEventId: null, retryOfRequestId: null, attemptId: null, beginMutationId: null, resultVersion: null, resultSha256: null, error: null,
        evidence: null, createdAt: at, startedAt: null, finishedAt: null };
      await repos.memory.createRequest(summary);
      assert.equal((await facts(db, f.member.id))["memory-requests"], 2);
      await repos.memory.observeDeliveredMessage({ projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id, messageId: m.id, threshold: 2, at });
      assert.equal((await facts(db, f.member.id))["memory-receipts"], 2);
      assert.ok((await facts(db, f.member.id))["memory-counters"]! > 1);
      const scope = { kind: "message_threshold" as const, projectId: f.project.id, agentId: f.agent.id, groupId: f.group.id };
      await repos.memory.updateScanCheckpointCas({ scope, after: null, through: await repos.memory.scanHighWater(scope), revision: 1, sweep: 1 }, 0);
      assert.equal((await facts(db, f.member.id))["memory-checkpoints"], 2);
      await db.exec("UPDATE memory_scan_checkpoints SET updated_at = ? WHERE project_id = ?", ["2026-11-11T00:02:00.000Z", f.project.id]);
      assert.equal((await facts(db, f.member.id))["memory-checkpoints"], 2);
      const beforeRollback = await facts(db, f.member.id);
      await assert.rejects(() => repos.transaction(async () => { await repos.memory.updateRequestCas(summary.id, 1, { state: "cancelled", finishedAt: at }); throw new Error("rollback-facts"); }), /rollback-facts/);
      assert.deepEqual(await facts(db, f.member.id), beforeRollback);
      await repos.groups.purge(f.group.id);
      const after = await facts(db, f.member.id);
      for (const kind of ["deliveries", "memory-requests", "memory-receipts", "memory-counters", "memory-checkpoints"]) assert.ok(after[kind]! > beforeRollback[kind]!, kind);
    });
  });
  test(`${engine} 事实版本缺行和安全整数溢出拒绝原写入，不自动重置`, { skip }, async () => {
    await withDb(engine, async (repos, db) => {
      const f = await fixture(repos);
      await db.exec("DELETE FROM member_fact_revisions WHERE member_id = ? AND kind = 'authored-messages'", [f.member.id]);
      await assert.rejects(() => repos.members.retainedFacts(f.member.id), /事实版本缺失/);
      await assert.rejects(() => repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "不能写入" }));
      assert.equal((await repos.messages.listByGroup(f.group.id)).length, 0);
      await db.exec("INSERT INTO member_fact_revisions (member_id, kind, revision) VALUES (?, 'authored-messages', 9007199254740991)", [f.member.id]);
      await assert.rejects(() => repos.messages.create({ groupId: f.group.id, senderMemberId: f.member.id, body: "也不能写入" }));
      assert.equal((await repos.messages.listByGroup(f.group.id)).length, 0);
      assert.equal((await facts(db, f.member.id))["authored-messages"], Number.MAX_SAFE_INTEGER);
    });
  });
}

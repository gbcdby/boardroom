import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createMcpCore, resetSharedAntiLoopForTests } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";
import { PostgresDriver } from "../src/server/db/drivers/postgres.ts";
import { Client as PgClient } from "pg";
import { randomBytes } from "node:crypto";

const logger = createLogger({ write: () => {} });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-durable-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect();
  await db.migrate(migrations);
  const repos = createRepositories(db);
  const project = await repos.projects.create({ name: "Durability" });
  const group = await repos.groups.create({ projectId: project.id, name: "Messages" });
  resetSharedAntiLoopForTests();
  const cores: ReturnType<typeof createMcpCore>[] = [];
  async function spawn(displayName: string, driver = db) {
    const core = createMcpCore({ db: driver, logger, antiLoop: { config: { maxConsecutiveAutoReplies: 2 } } });
    cores.push(core);
    const joined = await core.join(displayName, {
      displayName, hostType: "other", projectId: project.id, groupId: group.id,
    });
    return { core, session: displayName, memberId: joined.memberId };
  }
  return {
    dir, db, repos, project, group, spawn,
    async close() {
      for (const core of cores) await core.close();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("幂等键在新 MCP core 与数据库重开后仍返回原消息", async () => {
  const f = await fixture();
  let reopened: SqliteDriver | undefined;
  try {
    const first = await f.spawn("sender");
    const sent = await first.core.sendMessage(first.session, { text: "durable", clientMessageId: "request-1" });
    await first.core.close();
    await f.db.close();
    reopened = new SqliteDriver({ dataDir: f.dir });
    await reopened.connect();
    const second = await f.spawn("sender", reopened);
    const retry = await second.core.sendMessage(second.session, { text: "durable", clientMessageId: "request-1" });
    assert.equal(retry.messageId, sent.messageId);
    assert.equal(retry.createdAt, sent.createdAt);
    assert.equal(retry.duplicate, true);
    assert.equal((await createRepositories(reopened).messages.listByGroup(f.group.id)).length, 1);
    await second.core.close();
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test("并发同 key 只落一条消息，重复请求不消耗防环额度", async () => {
  const f = await fixture();
  try {
    const sender = await f.spawn("sender");
    const recipient = await f.spawn("recipient");
    const request = { text: "first", mentions: [recipient.memberId], clientMessageId: "same-key" };
    const results = await Promise.all(Array.from({ length: 4 }, () => sender.core.sendMessage(sender.session, request)));
    assert.equal(new Set(results.map((r) => r.messageId)).size, 1);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    const second = await sender.core.sendMessage(sender.session, { ...request, text: "second", clientMessageId: "second-key" });
    const row = await f.db.query<{ wake_decision: string }>(
      "SELECT wake_decision FROM message_deliveries WHERE message_id = ? AND member_id = ?",
      [second.messageId, recipient.memberId],
    );
    assert.equal(row[0]?.wake_decision, "allowed");
    assert.equal((await f.repos.messages.listByGroup(f.group.id)).length, 2);
  } finally { await f.close(); }
});

test("唤醒判定与消息一起持久化，抑制的消息仍能主动补投和确认", async () => {
  const f = await fixture();
  try {
    const sender = await f.spawn("sender");
    const recipient = await f.spawn("recipient");
    for (let i = 0; i < 3; i += 1) {
      await sender.core.sendMessage(sender.session, { text: `message-${i}`, mentions: [recipient.memberId], clientMessageId: `key-${i}` });
    }
    const decisions = await f.db.query<{ wake_decision: string; wake_suppressed_reason: string | null }>(
      `SELECT d.wake_decision, d.wake_suppressed_reason FROM message_deliveries d
       JOIN messages m ON m.id = d.message_id WHERE d.member_id = ? ORDER BY m.seq`, [recipient.memberId],
    );
    assert.deepEqual(decisions, [
      { wake_decision: "allowed", wake_suppressed_reason: null },
      { wake_decision: "allowed", wake_suppressed_reason: null },
      { wake_decision: "suppressed", wake_suppressed_reason: "consecutive_limit" },
    ]);
    const own = await f.db.query<{ wake_decision: string | null }>(
      "SELECT wake_decision FROM message_deliveries WHERE member_id = ?", [sender.memberId],
    );
    assert.ok(own.every((r) => r.wake_decision === null));
    assert.equal((await f.repos.deliveries.listWakeable(f.project.id, recipient.memberId)).length, 2);
    assert.equal((await f.repos.deliveries.listWakeable(f.project.id, sender.memberId)).length, 0);
    const backlog = await recipient.core.waitForMessages(recipient.session, { timeoutMs: 5 });
    assert.equal(backlog.messages.length, 3);
    assert.equal(backlog.drainedBacklog, true);
    for (const message of backlog.messages) await recipient.core.acknowledgeMessage(recipient.session, message.id);
    assert.equal((await f.repos.deliveries.listPending(f.project.id, recipient.memberId)).length, 0);
    assert.equal((await f.repos.deliveries.listWakeable(f.project.id, recipient.memberId)).length, 0);
  } finally { await f.close(); }
});

test("不相关并发事务各自提交/回滚，不能误认成嵌套事务", async () => {
  const f = await fixture();
  try {
    const entered = deferred();
    const release = deferred();
    const failing = f.repos.transaction(async () => {
      await f.repos.projects.create({ name: "must-rollback" });
      entered.resolve();
      await release.promise;
      throw new Error("rollback-marker");
    });
    const failed = assert.rejects(failing, /rollback-marker/);
    await entered.promise;
    const otherRepos = createRepositories(f.db);
    const survivor = otherRepos.projects.create({ name: "must-commit" });
    await setImmediate();
    release.resolve();
    await failed;
    const committed = await survivor;
    assert.equal((await otherRepos.projects.get(committed.id))?.name, "must-commit");
    assert.ok(!(await f.repos.projects.list()).some((p) => p.name === "must-rollback"));
  } finally { await f.close(); }
});

test("部分投递写入失败会回滚消息和 key，重试可以完整提交", async () => {
  const f = await fixture();
  try {
    const sender = await f.spawn("sender");
    const recipient = await f.spawn("recipient");
    await f.db.exec(`CREATE TRIGGER reject_second_delivery BEFORE INSERT ON message_deliveries
      WHEN (SELECT COUNT(*) FROM message_deliveries WHERE message_id = NEW.message_id) = 1
      BEGIN SELECT RAISE(ABORT, 'injected-delivery-failure'); END`);
    const request = { text: "atomic", mentions: [recipient.memberId], clientMessageId: "atomic-request" };
    await assert.rejects(sender.core.sendMessage(sender.session, request), /injected-delivery-failure/);
    assert.equal((await f.repos.messages.listByGroup(f.group.id)).length, 0);
    assert.equal((await f.repos.deliveries.listPending(f.project.id, sender.memberId)).length, 0);
    assert.equal(await f.repos.messages.findByClientKey(sender.memberId, request.clientMessageId), null);
    await f.db.exec("DROP TRIGGER reject_second_delivery");
    const sent = await sender.core.sendMessage(sender.session, request);
    assert.equal(sent.duplicate, false);
    assert.equal((await f.repos.messages.listByGroup(f.group.id)).length, 1);
    assert.equal((await f.repos.deliveries.listPending(f.project.id, recipient.memberId)).length, 1);
  } finally { await f.close(); }
});

test("key 按 Member 隔离；没有 key 的合法重复消息仍会分别保存", async () => {
  const f = await fixture();
  try {
    const first = await f.spawn("first");
    const second = await f.spawn("second");
    const a = await first.core.sendMessage(first.session, { text: "one", clientMessageId: "shared" });
    const b = await second.core.sendMessage(second.session, { text: "two", clientMessageId: "shared" });
    assert.notEqual(a.messageId, b.messageId);
    await first.core.sendMessage(first.session, { text: "repeated" });
    await first.core.sendMessage(first.session, { text: "repeated" });
    assert.equal((await f.repos.messages.listByGroup(f.group.id)).length, 4);
  } finally { await f.close(); }
});

test("v6 消息升级保持 ACK 与原文，不为旧消息反推唤醒决定", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-v6-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect();
  try {
    await db.migrate(migrations.filter((m) => m.version <= 6));
    const repos = createRepositories(db);
    const project = await repos.projects.create({ name: "Legacy" });
    const member = await repos.members.create({ projectId: project.id, kind: "human", displayName: "Legacy" });
    const group = await repos.groups.create({ projectId: project.id, name: "Legacy", participantMemberIds: [member.id] });
    const at = "2026-11-01T00:00:00.000Z";
    await db.exec("INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at) VALUES (?, ?, ?, 1, ?, '[]', ?)",
      ["legacy-message", group.id, member.id, "preserved body", at]);
    await db.exec(`INSERT INTO message_deliveries
      (id, message_id, member_id, project_id, status, attempt_count, acked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'acked', 1, ?, ?, ?)`, ["legacy-delivery", "legacy-message", member.id, project.id, at, at, at]);
    await db.migrate(migrations);
    assert.equal((await repos.messages.get("legacy-message"))?.body, "preserved body");
    const delivery = await repos.deliveries.get("legacy-message", member.id);
    assert.equal(delivery?.status, "acked");
    assert.equal(delivery?.ackedAt, at);
    assert.equal(delivery?.wakeDecision, null);
    assert.equal(delivery?.wakeSuppressedReason, null);
    assert.equal((await repos.deliveries.listWakeable(project.id, member.id)).length, 0);
    assert.deepEqual((await db.migrate(migrations)).applied, []);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("PostgreSQL：并发重试唯一、事务回滚隔离、唤醒事实落库", {
  skip: !process.env["AGENT_STUDIO_PG_TEST_URL"] && "未配置真实 PostgreSQL",
  timeout: 30_000,
}, async () => {
  const url = process.env["AGENT_STUDIO_PG_TEST_URL"]!;
  const schema = `dispatch_${randomBytes(6).toString("hex")}`;
  const db = new PostgresDriver({ connectionString: url, schema });
  const cores: ReturnType<typeof createMcpCore>[] = [];
  await db.connect();
  try {
    await db.migrate(migrations);
    const repos = createRepositories(db);
    const project = await repos.projects.create({ name: "PG" });
    const group = await repos.groups.create({ projectId: project.id, name: "PG" });
    for (let i = 0; i < 2; i += 1) {
      const core = createMcpCore({ db, logger });
      cores.push(core);
      await core.join(`pg-${i}`, { displayName: "same-sender", hostType: "other", projectId: project.id, groupId: group.id });
    }
    const receiver = createMcpCore({ db, logger });
    cores.push(receiver);
    const recipient = await receiver.join("pg-receiver", {
      displayName: "receiver", hostType: "other", projectId: project.id, groupId: group.id,
    });
    const sent = await Promise.all(cores.slice(0, 2).map((core, i) => core.sendMessage(`pg-${i}`, {
      text: "atomic", mentions: [recipient.memberId], clientMessageId: "pg-key",
    })));
    assert.equal(sent[0]?.messageId, sent[1]?.messageId);
    assert.equal(sent.filter((r) => r.duplicate).length, 1);
    assert.equal((await repos.messages.listByGroup(group.id)).length, 1);
    const wakeable = await repos.deliveries.listWakeable(project.id, recipient.memberId);
    assert.equal(wakeable.length, 1);
    assert.equal(wakeable[0]?.messageId, sent[0]?.messageId);
    const entered = deferred();
    const release = deferred();
    const failing = assert.rejects(repos.transaction(async () => {
      await repos.projects.create({ name: "must-rollback" });
      entered.resolve();
      await release.promise;
      throw new Error("pg-rollback");
    }), /pg-rollback/);
    await entered.promise;
    const other = createRepositories(db);
    const committed = await other.projects.create({ name: "must-commit" });
    release.resolve();
    await failing;
    assert.equal((await other.projects.get(committed.id))?.name, "must-commit");
    assert.ok(!(await repos.projects.list()).some((p) => p.name === "must-rollback"));
  } finally {
    for (const core of cores) await core.close();
    await db.close();
    const admin = new PgClient({ connectionString: url });
    await admin.connect();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
});

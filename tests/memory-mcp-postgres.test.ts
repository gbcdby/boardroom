import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";
import { DEFAULT_MEMORY_CONFIG } from "../src/server/config.ts";
import { closeMemoryRuntime, registerMemoryRuntime, scheduleMemoryReconciliation } from "../src/server/memory/runtime.ts";
import { memoryFixture, memoryPgUrl, pgUnavailable } from "./helpers/memory-fixture.ts";

test("真实 PG 锁住记忆表时 MCP 投递、ACK、status 可继续；后台真实回滚、释放锁后补扫不丢来源", { skip: pgUnavailable, timeout: 15000 }, async () => memoryFixture(async (repos, db) => {
  const schema = String((await db.query("SELECT current_schema() AS name"))[0]!["name"]);
  assert.match(schema, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  registerMemoryRuntime(db, { database: { kind: "postgres", connectionString: memoryPgUrl!, schema },
    config: { ...DEFAULT_MEMORY_CONFIG, messageThreshold: 1 } });
  const core = createMcpCore({ db, logger: createLogger({ write() {} }) });
  const lock = new Client({ connectionString: memoryPgUrl });
  await lock.connect();
  const query = db.query.bind(db);
  try {
    const project = await repos.projects.create({ name: "记忆锁隔离" });
    const group = await repos.groups.create({ projectId: project.id, name: "真实 MCP" });
    const joined = await core.join("reader", { projectId: project.id, groupId: group.id, displayName: "实际接收者", hostType: "other" });
    assert.equal(joined.context.memory?.state, "available");
    await core.memoryOperation("reader", "write", { scope: "project-agent", expectedVersion: 0, clientMutationId: "base", markdown: "已有事实" });
    // 等待此前安全点任务实际退出；后面的观测只属于被锁期间的补扫。
    await new Promise<void>(resolve => scheduleMemoryReconciliation(db, "test:before-lock", async () => { resolve(); }));
    const human = await repos.members.create({ projectId: project.id, kind: "human", displayName: "用户" });
    await repos.groups.addParticipant(group.id, human.id);
    const message = await repos.messages.create({ groupId: group.id, senderMemberId: human.id, body: "本次应被补扫的消息", mentions: [joined.memberId] });
    await repos.deliveries.ensure(message.id, joined.memberId);
    let attempted!: () => void;
    const actualMemoryRead = new Promise<void>(resolve => { attempted = resolve; });
    db.query = async (sql, params) => {
      if (/FROM memory_documents\b/.test(sql)) attempted();
      return await query(sql, params);
    };
    await lock.query("BEGIN");
    await lock.query(`LOCK TABLE "${schema}".memory_documents IN ACCESS EXCLUSIVE MODE`);
    const began = performance.now();
    const wait = await core.waitForMessages("reader", { timeoutMs: 25 });
    assert.equal(wait.messages[0]?.id, message.id);
    assert.equal(wait.memory?.state, "unavailable");
    assert.ok(performance.now() - began < 1500, "记忆读取预算不能拖住消息响应");
    let observeTimer!: ReturnType<typeof setTimeout>;
    await Promise.race([actualMemoryRead, new Promise<never>((_, reject) => { observeTimer = setTimeout(() => reject(new Error("没有观测到真实自动补扫读取记忆表")), 2000); })]).finally(() => clearTimeout(observeTimer));
    const ackAt = performance.now();
    assert.equal((await core.acknowledgeMessage("reader", message.id)).ok, true);
    assert.equal((await core.reportStatus("reader", { status: "working" })).ok, true);
    assert.ok(performance.now() - ackAt < 1000, "自动总结的实际锁等待必须有界，不能耗尽主库处理能力");
    // 该队列屏障只有在真实事务返回后才运行；不是超时 Promise 抛弃后台任务。
    await new Promise<void>(resolve => scheduleMemoryReconciliation(db, "test:after-failed-scan", async () => { resolve(); }));
    assert.equal(Number((await query("SELECT COUNT(*) AS count FROM memory_message_receipts WHERE message_id = ?", [message.id]))[0]!["count"]), 0);
    assert.equal((await repos.memory.listRequests(project.id, joined.agentId)).length, 0);
    const blocked = await lock.query("SELECT COUNT(*)::int AS count FROM pg_locks WHERE relation = $1::regclass AND NOT granted", [`"${schema}".memory_documents`]);
    assert.equal(blocked.rows[0].count, 0, "没有遗留等待记忆表锁的数据库工作");
    await lock.query("ROLLBACK");
    db.query = query;
    await core.waitForMessages("reader", { timeoutMs: 20 });
    const deadline = Date.now() + 2500;
    let requests = await repos.memory.listRequests(project.id, joined.agentId);
    while (requests.length === 0 && Date.now() < deadline) { await delay(20); requests = await repos.memory.listRequests(project.id, joined.agentId); }
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.trigger, "message_threshold");
    assert.deepEqual(requests[0]!.messageIds, [message.id]);
    assert.equal((await repos.deliveries.get(message.id, joined.memberId))?.status, "acked", "通知补扫不复活已确认聊天");
  } finally {
    db.query = query;
    await lock.query("ROLLBACK").catch(() => {}); await lock.end();
    await core.close(); await closeMemoryRuntime(db);
  }
}, "postgres"));

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { SqliteDriver } from "../src/server/db/drivers/sqlite.ts";
import type { DbRow } from "../src/server/db/driver.ts";
import { migrations } from "../src/server/db/migrations/index.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createMcpCore } from "../src/server/mcp/core.ts";
import { createLogger } from "../src/server/logger.ts";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "boardroom-tasks-mcp-"));
  const db = new SqliteDriver({ dataDir: dir });
  await db.connect(); await db.migrate(migrations);
  const repos = createRepositories(db);
  const project = await repos.projects.create({ name: "任务 MCP" });
  const group = await repos.groups.create({ projectId: project.id, name: "本群" });
  const otherGroup = await repos.groups.create({ projectId: project.id, name: "另一群" });
  const logger = createLogger({ write: () => {} });
  const core = createMcpCore({ db, logger });
  const manager = await core.join("manager", { displayName: "统筹", hostType: "other", projectId: project.id, groupId: group.id, role: "manager" });
  const worker = await core.join("worker", { displayName: "执行", hostType: "other", projectId: project.id, groupId: group.id });
  const reviewer = await core.join("reviewer", { displayName: "评审", hostType: "other", projectId: project.id, groupId: group.id });
  const observer = await core.join("observer", { displayName: "观察", hostType: "other", projectId: project.id, groupId: group.id });
  return { db, repos, project, group, otherGroup, logger, core, manager, worker, reviewer, observer,
    async create() { return (await core.taskOperation("manager", "create", { title: "任务", body: "明确范围", assigneeMemberId: worker.memberId, reviewerMemberId: reviewer.memberId })).task as { id: string; revision: number; state: string }; },
    async close() { await core.close(); await db.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("MCP 工作通知兑现等待、未确认重投，ACK 不推进任务；冲突不误报运行所有权", async () => {
  const f = await fixture();
  try {
    const waiting = f.core.waitForMessages("worker", { timeoutMs: 1500 });
    for (let i = 0; i < 100 && f.core.pendingWaitCount === 0; i++) await setImmediate();
    assert.equal(f.core.pendingWaitCount, 1);
    const task = await f.create();
    const first = await waiting;
    assert.equal(first.status, "work");
    assert.equal(first.workEvents?.[0]?.kind, "task.assigned");
    assert.equal(first.workEvents?.[0]?.taskId, task.id);
    const replay = await f.core.waitForMessages("worker", { timeoutMs: 10 });
    assert.equal(replay.workEvents?.[0]?.id, first.workEvents?.[0]?.id);
    await f.core.taskOperation("worker", "ack_work_event", { eventId: first.workEvents![0]!.id });
    assert.equal((await f.repos.tasks.get(f.project.id, task.id))?.state, "todo");
    assert.equal((await f.core.waitForMessages("worker", { timeoutMs: 10 })).status, "timeout");
    await assert.rejects(f.core.taskOperation("reviewer", "ack_work_event", { eventId: first.workEvents![0]!.id }), error => (error as { code: string }).code === "INVALID_ARGUMENT");
    await f.core.taskOperation("worker", "transition", { taskId: task.id, expectedRevision: 1, state: "in-progress" });
    await assert.rejects(f.core.taskOperation("manager", "update", { taskId: task.id, expectedRevision: 1, title: "旧写入" }), error => {
      assert.equal((error as { code: string }).code, "CONFLICT");
      assert.doesNotMatch((error as Error).message, /运行所有权/); return true;
    });
    await assert.rejects(f.core.taskOperation("worker", "create", { title: "越权", body: "", assigneeMemberId: f.worker.memberId, reviewerMemberId: f.reviewer.memberId }), error => (error as { code: string }).code === "FORBIDDEN");
  } finally { await f.close(); }
});

test("任务关联仅扩大同群合规读取，评论关系有效，退出群或跨群不能获得正文及链接", async () => {
  const f = await fixture();
  try {
    const sent = await f.core.sendMessage("manager", { text: "关联前仅评审者可见", mentions: [f.reviewer.memberId] });
    assert.equal((await f.core.readHistory("worker", {})).messages.length, 0);
    const task = await f.create();
    await f.core.taskOperation("manager", "link_message", { taskId: task.id, messageId: sent.messageId });
    assert.equal((await f.core.readHistory("worker", {})).messages[0]?.id, sent.messageId);
    assert.equal((await f.core.readHistory("observer", {})).messages.length, 0);
    await f.core.taskOperation("observer", "comment", { taskId: task.id, body: "参与此任务" });
    assert.equal((await f.core.readHistory("observer", {})).messages[0]?.id, sent.messageId);
    const other = createMcpCore({ db: f.db, logger: f.logger });
    try {
      await other.join("worker-other", { displayName: "执行", hostType: "other", projectId: f.project.id, groupId: f.otherGroup.id });
      const detail = await other.taskOperation("worker-other", "read", { taskId: task.id });
      assert.deepEqual(detail.messageLinks, []);
      assert.equal((await other.readHistory("worker-other", {})).messages.length, 0);
    } finally { await other.close(); }
    await f.repos.groups.removeParticipant(f.group.id, f.worker.memberId);
    await assert.rejects(f.core.readHistory("worker", {}), error => (error as { code: string }).code === "FORBIDDEN");
  } finally { await f.close(); }
});

test("MCP 重建 core 后 join 重投未 ACK 事件，不能用 projectId 或 actor 越过绑定", async () => {
  const f = await fixture();
  let recovered: ReturnType<typeof createMcpCore> | undefined;
  try {
    const task = await f.create();
    const pending = await f.core.waitForMessages("worker", { timeoutMs: 10 });
    await f.core.close();
    recovered = createMcpCore({ db: f.db, logger: f.logger });
    const joined = await recovered.join("restored", { displayName: "执行", hostType: "other", projectId: f.project.id, groupId: f.group.id });
    assert.equal(joined.workEvents?.[0]?.id, pending.workEvents?.[0]?.id);
    await assert.rejects(recovered.taskOperation("restored", "read", { projectId: "other", taskId: task.id }), error => (error as { code: string }).code === "FORBIDDEN");
    await assert.rejects(recovered.taskOperation("restored", "read", { taskId: task.id, actor: "owner" }), error => (error as { code: string }).code === "INVALID_ARGUMENT");
  } finally { await recovered?.close(); await f.close(); }
});

test("任务事件兑现同一次等待时保留 afterCursor，不重复投递游标前的未 ACK 消息", async () => {
  const f = await fixture();
  try {
    await f.core.sendMessage("manager", { text: "已读取但尚未ACK的旧消息", mentions: [f.worker.memberId] });
    const earlier = await f.core.waitForMessages("worker", { timeoutMs: 100 });
    assert.equal(earlier.messages.length, 1);
    const waiting = f.core.waitForMessages("worker", { timeoutMs: 2000, afterCursor: earlier.cursor! });
    for (let i = 0; i < 100 && f.core.pendingWaitCount === 0; i++) await setImmediate();
    const task = await f.create();
    const event = await waiting;
    assert.equal(event.status, "work");
    assert.deepEqual(event.messages, []);
    assert.equal(event.workEvents?.[0]?.taskId, task.id);
    await f.core.taskOperation("worker", "ack_work_event", { eventId: event.workEvents![0]!.id });
    assert.equal(f.core.pendingWaitCount, 0);
    assert.equal((await f.core.waitForMessages("worker", { timeoutMs: 10, afterCursor: earlier.cursor! })).status, "timeout");
  } finally { await f.close(); }
});

test("初始聊天查询已取空快照时到达的唤醒，仍在当前 wait 内重扫并投递", async () => {
  const f = await fixture();
  const originalQuery = f.db.query.bind(f.db);
  let captured!: () => void;
  let release!: () => void;
  const snapshot = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let armed = true;
  f.db.query = async <T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    const rows = await originalQuery<T>(sql, params);
    // 暂停真实 SQL 的响应；驱动队列已释放，新消息可实际提交。
    if (armed && sql.startsWith("SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq")) {
      armed = false;
      assert.equal(rows.length, 0);
      captured();
      await gate;
    }
    return rows;
  };
  try {
    const waiting = f.core.waitForMessages("worker", { timeoutMs: 1000 });
    await snapshot;
    const sending = f.core.sendMessage("manager", { text: "查询快照之后到达", mentions: [f.worker.memberId] });
    let inserted = false;
    for (let i = 0; i < 100; i++) {
      const rows = await originalQuery("SELECT COUNT(*) AS count FROM messages");
      if (Number(rows[0]?.count) > 0) { inserted = true; break; }
      await setImmediate();
    }
    assert.equal(inserted, true);
    await setImmediate();
    await setImmediate();
    release();
    const sent = await sending;
    const result = await waiting;
    assert.equal(result.status, "message");
    assert.deepEqual(result.messages.map(message => message.id), [sent.messageId]);
    assert.equal(result.drainedBacklog, false);
    assert.equal(f.core.pendingWaitCount, 0);
  } finally { release(); f.db.query = originalQuery; await f.close(); }
});

test("慢于轮询间隔的空查询不会使已到期的 wait 无限重新排队", async () => {
  const f = await fixture();
  const originalQuery = f.db.query.bind(f.db);
  let reads = 0;
  f.db.query = async <T extends DbRow = DbRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
    const rows = await originalQuery<T>(sql, params);
    if (sql.includes("FROM work_events") && sql.includes("delivery_state") && sql.includes("ORDER BY")) {
      reads++;
      // 查询本身完成且释放真实 DB 队列，仅让响应晚于 1 秒轮询周期。
      await delay(1100);
    }
    return rows;
  };
  const controller = new AbortController();
  const rescue = setTimeout(() => controller.abort(), 4000);
  try {
    const result = await f.core.waitForMessages("worker", { timeoutMs: 100, signal: controller.signal });
    assert.equal(result.status, "timeout", "必须自行到期，而非依赖救援取消");
    assert.ok(reads <= 2, "到期后只收束已有读取和一次最终检查");
    assert.equal(f.core.pendingWaitCount, 0);
  } finally { clearTimeout(rescue); controller.abort(); f.db.query = originalQuery; await f.close(); }
});

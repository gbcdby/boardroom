import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createLogger } from '../src/server/logger.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { createTaskService } from '../src/server/tasks/service.ts';
import { WriteFailedError } from '../src/server/db/errors.ts';
import type { DbDriver } from '../src/server/db/driver.ts';
import type { RepositorySet } from '../src/server/db/repositories.ts';
import { closeMemoryRuntime, registerMemoryRuntime, scheduleMemoryReconciliation } from '../src/server/memory/runtime.ts';
import { memoryFixture, memoryPgUrl, pgUnavailable } from './helpers/memory-fixture.ts';

const logger = createLogger({ level: 'error', write() {} });
function gate() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function room(repos: RepositorySet, db: DbDriver) {
  const project = await repos.projects.create({ name: '#154 取消边界' });
  const group = await repos.groups.create({ projectId: project.id, name: '消息' });
  const core = createMcpCore({ repos, db, logger, memberKey: 'cancellation' });
  const identity = { projectId: project.id, groupId: group.id, displayName: '取消接收者', hostType: 'other' };
  const joined = await core.join('receiver', identity);
  const sender = await repos.members.create({ projectId: project.id, kind: 'human', displayName: '人' });
  await repos.groups.addParticipant(group.id, sender.id);
  const message = () => repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: 'CANCEL_PREPARED_MESSAGE', mentions: [joined.memberId] });
  return { project, group, core, joined, identity, message };
}

test("#152 explicit core drain waits for a real in-flight wait after immediate cancellation", async () => memoryFixture(async (repos, db) => {
  const database = { kind: 'sqlite' as const,
    sqlitePath: String((await db.query('PRAGMA database_list')).find(row => row['name'] === 'main')!['file']) };
  const runtime = registerMemoryRuntime(db, { database });
  const r = await room(repos, db), entered = gate(), release = gate();
  const original = runtime.reader.readOwn.bind(runtime.reader);
  let drained = false;
  try {
    await r.message();
    runtime.reader.readOwn = async input => { const result = await original(input); entered.resolve(); await release.promise; return result; };
    const waiting = r.core.waitForMessages('receiver', { timeoutMs: 1000 });
    await entered.promise;
    await r.core.close(); assert.equal(r.core.pendingWaitCount, 0);
    const closing = r.core.close({ drain: true }).then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    release.resolve(); await closing;
    assert.equal((await waiting).status, 'cancelled'); assert.equal(drained, true);
  } finally { release.resolve(); await r.core.close({ drain: true }); await closeMemoryRuntime(db); }
}));

for (const engine of ['sqlite', 'postgres'] as const) {
  const options = { skip: engine === 'postgres' ? pgUnavailable : false, timeout: 15000 };
  for (const point of ['consume', 'reader', 'final-acl', 'close-final-acl'] as const) {
    test(`${engine} R-BR-COLLAB-154-REQ-001 ${point}期间取消不兑现消息/记忆/工作通知，未ACK事实可重投`, options, async t => memoryFixture(async (repos, db) => {
      const database = engine === 'sqlite'
        ? { kind: 'sqlite' as const, sqlitePath: String((await db.query('PRAGMA database_list')).find(row => row['name'] === 'main')!['file']) }
        : { kind: 'postgres' as const, connectionString: memoryPgUrl!, schema: String((await db.query('SELECT current_schema() AS name'))[0]!['name']) };
      const runtime = registerMemoryRuntime(db, { database }), readOwn = runtime.reader.readOwn.bind(runtime.reader);
      const r = await room(repos, db), controller = new AbortController(), entered = gate(), release = gate();
      const mark = repos.deliveries.markMcpDeliveredBatch, visible = repos.messages.listVisibleIdsForMember, lastSeq = repos.messages.lastDeliveredSeq;
      let finalReads = 0, cursorReads = 0, fresh: ReturnType<typeof createMcpCore> | undefined;
      let pending: ReturnType<typeof r.core.waitForMessages> | undefined;
      const timer = setTimeout(() => { entered.reject(new Error(`未抵达 ${point} 真实交错点`)); release.resolve(); }, 5000);
      const pause = async (locked: boolean) => {
        assert.equal(Boolean(db.currentTransactionContext()), locked);
        assert.equal(Boolean(repos.mutations.current()), locked, '消费和最终ACL持有原项目/成员锁，reader不持有业务锁');
        entered.resolve(); await release.promise;
      };
      try {
        const message = await r.message();
        await r.core.memoryOperation('receiver', 'write', { scope: 'global', expectedVersion: 0, clientMutationId: 'cancel-memory', markdown: 'CANCEL_PRIVATE_MEMORY' });
        const reviewer = await repos.agents.create({ displayName: '独立评审', hostType: 'other' });
        const reviewerMember = await repos.members.create({ projectId: r.project.id, kind: 'agent', agentId: reviewer.id, displayName: reviewer.displayName });
        const task = await createTaskService({ repos }).create({ actor: ownerActor() }, r.project.id, {
          title: 'CANCEL_WORK_EVENT', body: '', assigneeMemberId: r.joined.memberId, reviewerMemberId: reviewerMember.id,
        });
        const event = (await repos.tasks.listUnackedWorkEvents(r.project.id, r.joined.memberId))[0]!;
        assert.equal(event.taskId, task.id);
        // 执行完先前安全点安排的真实补扫，再只控制这一次取消；不关闭 memory。
        await new Promise<void>(resolve => scheduleMemoryReconciliation(db, 'test:before-cancellation', async () => { resolve(); }));
        repos.messages.lastDeliveredSeq = async scope => { cursorReads++; return lastSeq(scope); };
        if (point === 'consume') repos.deliveries.markMcpDeliveredBatch = async (scope, ids, at) => {
          await mark(scope, ids, at); await pause(true);
        };
        else if (point === 'reader') runtime.reader.readOwn = async input => {
          const value = await readOwn(input); await pause(false); return value;
        };
        else repos.messages.listVisibleIdsForMember = async (scope, ids, active) => {
          const idsNow = await visible(scope, ids, active);
          if (active?.requireActive && ++finalReads === 2) await pause(true);
          return idsNow;
        };
        pending = r.core.waitForMessages('receiver', { timeoutMs: 1000, signal: controller.signal });
        await entered.promise;
        assert.equal(db.currentTransactionContext(), undefined, '取消来自锁外独立调用链');
        if (point === 'close-final-acl') await r.core.close(); else controller.abort();
        const pendingImmediately = r.core.pendingWaitCount, cancelCursorReads = cursorReads;
        release.resolve();
        const cancelled = await pending;
        t.diagnostic(JSON.stringify({ point, status: cancelled.status, messageCount: cancelled.messages.length, pendingImmediately, cancelCursorReads }));
        assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.messages, []); assert.equal(cancelled.workEvents, undefined);
        assert.equal(cancelled.cursor, null, '取消不提供可能跳过未兑现消息的推进游标'); assert.equal(cancelled.drainedBacklog, false);
        assert.deepEqual(cancelled.memory?.entries ?? [], []);
        assert.ok(!JSON.stringify(cancelled).includes('CANCEL_'));
        assert.equal(pendingImmediately, 0, '取消立即从当前wait收口，不等游标查询/事务放行');
        assert.equal(cancelCursorReads, 0, '取消不能为数据库游标追加等待');
        const delivery = (await repos.deliveries.get(message.id, r.joined.memberId))!;
        assert.equal(delivery.status, 'delivered'); assert.ok(delivery.firstMcpDeliveredAt); assert.equal(delivery.ackedAt, null);
        assert.equal((await repos.tasks.listUnackedWorkEvents(r.project.id, r.joined.memberId))[0]!.id, event.id);
        repos.deliveries.markMcpDeliveredBatch = mark; repos.messages.listVisibleIdsForMember = visible; repos.messages.lastDeliveredSeq = lastSeq; runtime.reader.readOwn = readOwn;
        let retry = r.core;
        if (point === 'close-final-acl') {
          fresh = createMcpCore({ repos, db, logger, memberKey: 'after-cancel-close' }); await fresh.join('receiver', r.identity); retry = fresh;
        }
        const next = await retry.waitForMessages('receiver', { timeoutMs: 1000 });
        assert.equal(next.status, 'message'); assert.deepEqual(next.messages.map(value => value.id), [message.id]);
        assert.equal(next.cursor, `c_${message.seq}`); assert.equal(next.workEvents?.[0]?.id, event.id);
        const redelivery = (await repos.deliveries.get(message.id, r.joined.memberId))!;
        assert.equal(redelivery.firstMcpDeliveredAt, delivery.firstMcpDeliveredAt); assert.equal(redelivery.attemptCount, delivery.attemptCount + 1);
        assert.equal(redelivery.ackedAt, null);
      } finally {
        clearTimeout(timer); release.resolve(); repos.deliveries.markMcpDeliveredBatch = mark; repos.messages.listVisibleIdsForMember = visible;
        repos.messages.lastDeliveredSeq = lastSeq; runtime.reader.readOwn = readOwn;
        await pending?.catch(() => {}); await fresh?.close(); await r.core.close(); await closeMemoryRuntime(db);
      }
    }, engine));
  }

  test(`${engine} R-BR-COLLAB-154-REQ-001 预取消和空闲取消仅作用于当前wait，成功/timeout保持原游标`, options, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db), preAborted = new AbortController();
    const set = repos.statuses.set;
    try {
      const message = await r.message();
      preAborted.abort();
      const before = await r.core.waitForMessages('receiver', { timeoutMs: 1000, signal: preAborted.signal, afterCursor: 'c_0' });
      assert.equal(before.status, 'cancelled'); assert.equal(before.cursor, null); assert.deepEqual(before.messages, []);
      assert.equal(await repos.deliveries.get(message.id, r.joined.memberId), null);
      const completed = new AbortController();
      const success = await r.core.waitForMessages('receiver', { timeoutMs: 1000, signal: completed.signal });
      assert.equal(success.status, 'message'); assert.equal(success.cursor, `c_${message.seq}`);
      completed.abort(); // 已兑现的旧 signal 不能取消下一个 wait。
      await r.core.acknowledgeMessage('receiver', message.id);
      const timed = await r.core.waitForMessages('receiver', { timeoutMs: 20, afterCursor: success.cursor! });
      assert.equal(timed.status, 'timeout'); assert.equal(timed.cursor, success.cursor); assert.deepEqual(timed.messages, []);
      const waiting = gate(), idleController = new AbortController();
      repos.statuses.set = async (pid, mid, state) => {
        const result = await set(pid, mid, state); if (mid === r.joined.memberId && state === 'waiting') waiting.resolve(); return result;
      };
      const pending = r.core.waitForMessages('receiver', { timeoutMs: 1000, signal: idleController.signal, afterCursor: success.cursor! });
      await waiting.promise; idleController.abort();
      const idle = await pending;
      assert.equal(idle.status, 'cancelled'); assert.equal(idle.cursor, null); assert.deepEqual(idle.messages, []);
      repos.statuses.set = set;
      const nextMessage = await r.message();
      const next = await r.core.waitForMessages('receiver', { timeoutMs: 1000 });
      assert.deepEqual(next.messages.map(value => value.id), [nextMessage.id]); assert.equal(next.cursor, `c_${nextMessage.seq}`);
      assert.equal(r.core.pendingWaitCount, 0);
    } finally { repos.statuses.set = set; await r.core.close(); await closeMemoryRuntime(db); }
  }, engine));

  test(`${engine} R-BR-COLLAB-154-REQ-001 取消不吞掉在途投递写失败，事务真实回滚后仍能重投`, options, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db), controller = new AbortController(), entered = gate(), release = gate(), exec = repos.context.exec;
    const failure = new WriteFailedError('取消期间真实投递写失败 seam');
    let armed = true;
    const timer = setTimeout(() => { entered.reject(new Error('未抵达写失败交错点')); release.resolve(); }, 5000);
    try {
      const message = await r.message();
      repos.context.exec = async (sql, params) => {
        const changed = await exec(sql, params);
        if (armed && /UPDATE message_deliveries SET/.test(sql) && /first_mcp_delivered_at/.test(sql)) {
          armed = false; assert.ok(db.currentTransactionContext()); entered.resolve(); await release.promise; throw failure;
        }
        return changed;
      };
      const pending = r.core.waitForMessages('receiver', { timeoutMs: 1000, signal: controller.signal });
      const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await entered.promise; controller.abort(); release.resolve();
      const result = await outcome;
      assert.equal(result.value, null); assert.equal(result.error, failure, '外层仍等待真实drain完成并传播原写错误');
      assert.equal(await repos.deliveries.get(message.id, r.joined.memberId), null, '已执行的块随真实事务回滚');
      repos.context.exec = exec;
      const retried = await r.core.waitForMessages('receiver', { timeoutMs: 1000 });
      assert.deepEqual(retried.messages.map(value => value.id), [message.id]);
      assert.equal((await repos.deliveries.get(message.id, r.joined.memberId))!.attemptCount, 1);
    } finally { clearTimeout(timer); release.resolve(); repos.context.exec = exec; await r.core.close(); await closeMemoryRuntime(db); }
  }, engine));
}

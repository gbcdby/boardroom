import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createLogger } from '../src/server/logger.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { WriteFailedError } from '../src/server/db/errors.ts';
import { newId } from '../src/server/db/ids.ts';
import type { DbTransaction } from '../src/server/db/driver.ts';
import { memoryFixture, memoryPgUrl, pgUnavailable } from './helpers/memory-fixture.ts';
import { createRuntimeRepository } from '../src/server/runtime/repository.ts';
import { registerMemoryRuntime, closeMemoryRuntime, scheduleMemoryReconciliation } from '../src/server/memory/runtime.ts';

const logger = createLogger({ level: 'error', write() {} });
function gate() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
for (const engine of ['sqlite', 'postgres'] as const) for (const revoke of ['epoch', 'group', 'task', 'status-write'] as const) {
  test(`${engine} R-P5-C-REQ-004：真实consume提交后${revoke}变化，旧wait不得兑现payload且未ACK可重投`,
    { skip: engine === 'postgres' ? pgUnavailable : false }, async () => memoryFixture(async (repos, db) => {
      const p = await repos.projects.create({ name: `最终兑现 ${revoke}` }), group = await repos.groups.create({ projectId: p.id, name: '群' });
      const core = createMcpCore({ db, repos, logger, memberKey: 'old' });
      const sender = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '发送者' });
      await repos.groups.addParticipant(group.id, sender.id);
      const joined = await core.join('receiver', { projectId: p.id, groupId: group.id, displayName: '接收者', hostType: 'other' });
      const message = await repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: `不得泄露的旧payload-${revoke}`,
        mentions: revoke === 'task' ? [] : [joined.memberId] });
      const at = new Date().toISOString();
      const task = revoke === 'task' ? await repos.tasks.create({ id: newId(), projectId: p.id, title: '动态可读范围', body: '', labels: [], state: 'todo',
        assigneeMemberId: joined.memberId, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null,
        blockedReason: null, author: { kind: 'human', actorId: 'human:local', displayName: '人' }, createdAt: at, updatedAt: at }) : null;
      if (task) await repos.tasks.linkMessage(p.id, { taskId: task.id, messageId: message.id, groupId: group.id, createdAt: at });
      const transaction = db.transaction.bind(db), setStatus = repos.statuses.set;
      let injectedAfterPhysicalCommit = false, fresh: ReturnType<typeof createMcpCore> | undefined;
      db.transaction = async <T>(body: (tx: DbTransaction) => Promise<T>): Promise<T> => {
        const result = await transaction(body);
        if (!injectedAfterPhysicalCommit && (result as { batch?: { messages?: unknown[] } } | null)?.batch?.messages?.length) {
          assert.equal(db.currentTransactionContext(), undefined, '交错必须在物理consume COMMIT之后');
          injectedAfterPhysicalCommit = true;
          if (revoke === 'epoch') {
            const removed = await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, p.id, joined.memberId);
            await createAuditCompensationService({ repos }).revoke({ actor: ownerActor() }, p.id, removed.auditId);
          } else if (revoke === 'group') await repos.groups.removeParticipant(group.id, joined.memberId);
          else if (revoke === 'task') await repos.tasks.updateCas(p.id, task!.id, 1, { assigneeMemberId: sender.id }, at);
          else repos.statuses.set = async (pid, mid, state) => {
            if (mid === joined.memberId && state === 'working') throw new WriteFailedError('真实最终状态写入失败 seam');
            return setStatus(pid, mid, state);
          };
        }
        return result;
      };
      try {
        const result = await core.waitForMessages('receiver', { timeoutMs: 1000 });
        assert.equal(injectedAfterPhysicalCommit, true);
        assert.equal(result.status, 'cancelled'); assert.deepEqual(result.messages, []); assert.equal(result.cursor, null);
        assert.equal(result.workEvents, undefined); assert.ok(!JSON.stringify(result).includes(message.body));
        const delivery = (await repos.deliveries.get(message.id, joined.memberId))!;
        assert.equal(delivery.status, 'delivered'); assert.ok(delivery.firstMcpDeliveredAt); assert.equal(delivery.ackedAt, null);
        db.transaction = transaction; repos.statuses.set = setStatus;
        let retry = core;
        if (revoke === 'epoch') {
          assert.equal((await repos.members.get(joined.memberId))!.membershipRevision, 3);
          fresh = createMcpCore({ db, repos, logger, memberKey: 'fresh' });
          await fresh.join('receiver', { projectId: p.id, groupId: group.id, displayName: '接收者', hostType: 'other' });
          retry = fresh;
        } else if (revoke === 'group') await repos.groups.addParticipant(group.id, joined.memberId);
        else if (revoke === 'task') await repos.tasks.updateCas(p.id, task!.id, 2, { assigneeMemberId: joined.memberId }, at);
        const repeated = await retry.waitForMessages('receiver', { timeoutMs: 1000 });
        assert.deepEqual(repeated.messages.map(m => m.id), [message.id]);
        assert.equal((await repos.deliveries.get(message.id, joined.memberId))?.firstMcpDeliveredAt, delivery.firstMcpDeliveredAt);
      } finally { db.transaction = transaction; repos.statuses.set = setStatus; await fresh?.close(); await core.close(); }
    }, engine));
}

for (const engine of ['sqlite', 'postgres'] as const) {
  test(`${engine} R-P5-C-REQ-004：真实consume提交后managed停止，最终兑现重新检查运行fence`,
    { skip: engine === 'postgres' ? pgUnavailable : false }, async () => memoryFixture(async (repos, db) => {
      const project = await repos.projects.create({ name: '最终运行fence' }), group = await repos.groups.create({ projectId: project.id, name: '群' });
      const runtime = createRuntimeRepository(db, { repos });
      const created = await runtime.create({ name: '受托管接收者', backend: 'claude-code', defaults: { workdir: process.cwd() },
        bindings: [{ projectId: project.id, groupId: group.id }] });
      const view = created.bindings[0]!;
      await runtime.intent(view.binding.id, 'start');
      const fence = await runtime.claim(view.binding.id, 'settlement-fixture');
      const identity = { displayName: view.runtime.name, hostType: view.runtime.backend, projectId: project.id, groupId: group.id, memberId: view.binding.memberId };
      const core = createMcpCore({ db, repos, logger, memberKey: 'managed-settlement', managed: {
        identity,
        run: (operation, body, discover) => runtime.withFence(fence, body, { requireRunningIntent: operation === 'consume' }, discover),
        beforeWait: async () => (await runtime.checkFence(fence)).binding.desiredState === 'running',
        onDelivery: async () => { await runtime.patchRunner(fence, { phase: 'working' }); },
      } });
      const transaction = db.transaction.bind(db);
      let stoppedAfterCommit = false;
      try {
        const joined = await core.join('receiver', identity);
        const sender = await repos.members.create({ projectId: project.id, kind: 'human', displayName: '人' });
        await repos.groups.addParticipant(group.id, sender.id);
        const message = await repos.messages.create({ groupId: group.id, senderMemberId: sender.id, body: '停止后不兑现', mentions: [joined.memberId] });
        db.transaction = async <T>(body: (tx: DbTransaction) => Promise<T>): Promise<T> => {
          const result = await transaction(body);
          if (!stoppedAfterCommit && (result as { batch?: { messages?: unknown[] } } | null)?.batch?.messages?.length) {
            assert.equal(db.currentTransactionContext(), undefined); stoppedAfterCommit = true;
            await runtime.intent(view.binding.id, 'stop');
          }
          return result;
        };
        const result = await core.waitForMessages('receiver', { timeoutMs: 1000 });
        assert.equal(stoppedAfterCommit, true); assert.equal(result.status, 'cancelled'); assert.deepEqual(result.messages, []);
        assert.equal((await runtime.getBinding(view.binding.id))!.binding.desiredState, 'stopped');
        assert.equal((await repos.members.get(joined.memberId))!.membershipRevision, 1, '由运行fence拒绝，未改变成员代际');
        const delivery = (await repos.deliveries.get(message.id, joined.memberId))!;
        assert.equal(delivery.status, 'delivered'); assert.ok(delivery.firstMcpDeliveredAt); assert.equal(delivery.ackedAt, null);
      } finally { db.transaction = transaction; await core.close(); }
    }, engine));
}

for (const engine of ['sqlite', 'postgres'] as const) for (const change of ['disabled', 'epoch', 'role', 'task', 'group-archive', 'project-archive', 'close'] as const) {
  test(`${engine} #154 真实reader返回待兑现时${change}，完整旧payload取消且恢复后可重投`,
    { skip: engine === 'postgres' ? pgUnavailable : false, timeout: 15000 }, async () => memoryFixture(async (repos, db) => {
      // 使用 fixture 的真实数据库描述符；仅把 reader 返回后的完成点作为可控交错，不替代数据库或 ACL。
      const database = engine === 'sqlite'
        ? { kind: 'sqlite' as const, sqlitePath: String((await db.query('PRAGMA database_list')).find(row => row['name'] === 'main')!['file']) }
        : { kind: 'postgres' as const, connectionString: memoryPgUrl!, schema: String((await db.query('SELECT current_schema() AS name'))[0]!['name']) };
      const runtime = registerMemoryRuntime(db, { database }), readOwn = runtime.reader.readOwn.bind(runtime.reader);
      const project = await repos.projects.create({ name: `reader期间 ${change}` });
      const group = await repos.groups.create({ projectId: project.id, name: '消息兑现' });
      const core = createMcpCore({ repos, db, logger, memberKey: 'held-reader' });
      let fresh: ReturnType<typeof createMcpCore> | undefined;
      const entered = gate(), release = gate();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const identity = { projectId: project.id, groupId: group.id, displayName: '外部取材接收者', hostType: 'other' };
        const joined = await core.join('receiver', identity);
        const sender = await repos.members.create({ projectId: project.id, kind: 'human', displayName: '发送者' });
        await repos.groups.addParticipant(group.id, sender.id);
        const root = change === 'role' ? await repos.org.createNode({ projectId: project.id, name: '总管', role: 'top_manager' }) : null;
        const ordinary = root ? await repos.org.createNode({ projectId: project.id, parentId: root.id, name: '普通岗', role: 'member' }) : null;
        if (root) await repos.org.assignNode(joined.memberId, root.id);
        const at = new Date().toISOString(), ids = Array.from({ length: change === 'task' ? 129 : 1 }, () => newId());
        await repos.transaction(() => repos.mutations.run({ projectIds: [project.id], discover: async () => ({
          memberIds: [sender.id, joined.memberId], groupIds: [group.id], runtimeIds: [],
        }) }, async () => {
          for (let start = 0; start < ids.length; start += 32) {
            const batch = ids.slice(start, start + 32), params: unknown[] = [];
            for (const [offset, id] of batch.entries()) {
              const seq = start + offset + 1;
              params.push(id, group.id, sender.id, seq, `不得泄露的旧消息 ${change}/${seq}`,
                JSON.stringify((change === 'role' || change === 'task') && seq === ids.length ? [] : [joined.memberId]), at);
            }
            await repos.context.exec(`INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at)
              VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',')}`, params);
          }
        }));
        const task = change === 'task' ? await repos.tasks.create({ id: newId(), projectId: project.id, title: '最后一块的动态权限', body: '', labels: [], state: 'todo',
          assigneeMemberId: joined.memberId, reviewerMemberId: null, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null,
          blockedReason: null, author: { kind: 'human', actorId: 'human:local', displayName: '人' }, createdAt: at, updatedAt: at }) : null;
        if (task) await repos.tasks.linkMessage(project.id, { taskId: task.id, messageId: ids.at(-1)!, groupId: group.id, createdAt: at });
        // 让 join 已安排的真实后台事务完成，再只控制这次 reader 与撤权的交错；没有关闭补扫。
        await new Promise<void>(resolve => scheduleMemoryReconciliation(db, 'test:before-held-reader', async () => { resolve(); }));
        runtime.reader.readOwn = async input => {
          try {
            const result = await readOwn(input);
            // reader 成功或按原预算降级都必须走同一个消息最终权限检查。
            assert.equal(db.currentTransactionContext(), undefined, '外部 reader 等待不持有业务事务/成员锁');
            entered.resolve(); await release.promise; return result;
          } catch (error) { entered.reject(error); throw error; }
        };
        const pending = core.waitForMessages('receiver', { timeoutMs: 1000 });
        timer = setTimeout(() => { entered.reject(new Error('未抵达 reader 交错点')); release.resolve(); }, 5000);
        await entered.promise;
        const before = await repos.context.query('SELECT message_id, first_mcp_delivered_at FROM message_deliveries WHERE member_id = ? ORDER BY message_id', [joined.memberId]);
        assert.equal(before.length, ids.length); assert.ok(before.every(row => row.first_mcp_delivered_at !== null), '整批 consume 已真实提交');
        if (change === 'disabled') await repos.members.setStatus(joined.memberId, 'disabled');
        else if (change === 'epoch') {
          const removed = await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, project.id, joined.memberId);
          await createAuditCompensationService({ repos }).revoke({ actor: ownerActor() }, project.id, removed.auditId);
        } else if (change === 'role') await repos.org.assignNode(joined.memberId, ordinary!.id);
        else if (change === 'task') await repos.tasks.updateCas(project.id, task!.id, 1, { assigneeMemberId: sender.id }, at);
        else if (change === 'group-archive') await repos.groups.archive(group.id);
        else if (change === 'project-archive') await repos.projects.archive(project.id);
        else await core.close();
        release.resolve();
        const result = await pending;
        assert.equal(result.status, 'cancelled'); assert.deepEqual(result.messages, []); assert.equal(result.cursor, null);
        assert.equal(result.workEvents, undefined); assert.ok(!JSON.stringify(result).includes('不得泄露的旧消息'));
        runtime.reader.readOwn = readOwn;
        if (change === 'disabled') await repos.members.setStatus(joined.memberId, 'active');
        else if (change === 'role') await repos.org.assignNode(joined.memberId, root!.id);
        else if (change === 'task') await repos.tasks.updateCas(project.id, task!.id, 2, { assigneeMemberId: joined.memberId }, at);
        else if (change === 'group-archive') await repos.groups.restore(group.id);
        else if (change === 'project-archive') await repos.projects.restore(project.id);
        let retry = core;
        if (change === 'epoch' || change === 'close') {
          fresh = createMcpCore({ repos, db, logger, memberKey: 'held-reader-retry' }); await fresh.join('receiver', identity); retry = fresh;
        }
        const retried = await retry.waitForMessages('receiver', { timeoutMs: 1000 });
        assert.equal(retried.status, 'message'); assert.deepEqual(retried.messages.map(message => message.id), ids);
        assert.deepEqual(await repos.context.query('SELECT message_id, first_mcp_delivered_at FROM message_deliveries WHERE member_id = ? ORDER BY message_id', [joined.memberId]), before);
      } finally {
        if (timer) clearTimeout(timer); release.resolve(); runtime.reader.readOwn = readOwn;
        await fresh?.close(); await core.close(); await closeMemoryRuntime(db);
      }
    }, engine));
}

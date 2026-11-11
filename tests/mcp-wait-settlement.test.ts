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
import { memoryFixture, pgUnavailable } from './helpers/memory-fixture.ts';
import { createRuntimeRepository } from '../src/server/runtime/repository.ts';

const logger = createLogger({ level: 'error', write() {} });
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
      const task = revoke === 'task' ? await repos.tasks.create({ id: newId(), projectId: p.id, title: '动态可读范围', body: '', deliveryKind: "code", acceptanceText: '', acceptanceSource: "explicit", labels: [], state: 'todo',
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip, identityPgUrl } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createLogger } from '../src/server/logger.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { registerMemoryRuntime, closeMemoryRuntime } from '../src/server/memory/runtime.ts';

function gate() { let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const cases = [['join','task-member'], ['join','same-member-restored'], ['join','group-archive'], ['work-event-wait','group-archive']] as const;
for (const engine of identityEngines) for (const [operation,change] of cases) {
  test(`${engine}: #157 ${operation} checks final delivery eligibility after real reader returns (${change})`, { skip: identitySkip(engine), timeout: 15000 }, async () => {
    const f = await identityFixture(engine); const entered = gate(), release = gate();
    let core: ReturnType<typeof createMcpCore> | undefined, restoreReader = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos);
      const group = await f.repos.groups.create({ projectId: p.project.id, name: 'join最后兑现', participantMemberIds: [p.reviewer.id] });
      const database = engine === 'sqlite' ? { kind: 'sqlite' as const, sqlitePath: String((await f.db.query('PRAGMA database_list')).find(r => r.name === 'main')!.file) }
        : { kind: 'postgres' as const, connectionString: identityPgUrl!, schema: String((await f.db.query('SELECT current_schema() AS name'))[0]!.name) };
      const runtime = registerMemoryRuntime(f.db, { database }), read = runtime.reader.readOwn.bind(runtime.reader);
      restoreReader = () => { runtime.reader.readOwn = read; };
      let hold = operation === 'join';
      runtime.reader.readOwn = async input => { const result = await read(input);
        assert.equal(f.db.currentTransactionContext(), undefined, '真实隔离 reader 返回时不能持有业务事务');
        if (hold) { entered.resolve(); await release.promise; } return result; };
      core = createMcpCore({ db: f.db, repos: f.repos, logger: createLogger({ write() {} }), memberKey: `join-final-${change}` });
      const agent = (await f.repos.agents.get(p.reviewer.agentId!))!;
      const identity = { projectId: p.project.id, groupId: group.id, displayName: agent.displayName, hostType: agent.hostType };
      if (operation === 'work-event-wait') { await core.join('reviewer', identity); hold = true; }
      const pending = (operation === 'join' ? core.join('reviewer', identity) : core.waitForMessages('reviewer', { timeoutMs: 1000 }))
        .then(value => ({ ok: !('status' in value && value.status === 'cancelled'), value }), error => ({ ok: false, error }));
      timer = setTimeout(() => { entered.reject(new Error('未抵达真实reader完成交错点')); release.resolve(); }, 5000);
      await entered.promise;
      if (operation === 'work-event-wait') assert.deepEqual(await f.db.query('SELECT id FROM messages WHERE group_id=?', [group.id]), [], '只有 WorkEvent，不能依赖消息 ID 的可见性查询校验归档');
      const before = (await f.db.query("SELECT * FROM work_events WHERE recipient_member_id=? AND kind='task.review_ready'", [p.reviewer.id]))[0]!;
      assert.equal(before.delivery_state, 'delivered'); assert.ok(before.first_delivered_at); assert.equal(before.acked_at, null);
      if (change === 'task-member') await createOrgMutationService({ repos: f.repos }).removeMember(p.owner, p.project.id, p.worker.id);
      else if (change === 'same-member-restored') {
        const removed = await createOrgMutationService({ repos: f.repos }).removeMember(p.owner, p.project.id, p.reviewer.id);
        await createAuditCompensationService({ repos: f.repos }).revoke(p.owner, p.project.id, removed.auditId);
      } else await f.repos.groups.archive(group.id);
      release.resolve(); const result = await pending;
      assert.equal(result.ok, false, '失效后不能兑现已准备的工作事件或记忆');
      if (operation === 'work-event-wait') {
        assert.ok('value' in result && 'status' in result.value);assert.equal(result.value.status, 'cancelled');
        assert.deepEqual(result.value.messages, []);assert.equal(result.value.workEvents, undefined);
      }
      assert.deepEqual((await f.db.query('SELECT * FROM work_events WHERE id=?', [before.id]))[0], before, '取消响应不删除原事件、不伪造ACK');
      if (change === 'task-member') assert.equal((await f.repos.members.get(p.reviewer.id))!.membershipRevision, 1, '即使接收者自己的代际未变，关联任务失效仍要拒绝');
      if (change === 'same-member-restored') assert.equal((await f.repos.members.get(p.reviewer.id))!.membershipRevision, 3);
    } finally { if (timer) clearTimeout(timer); release.resolve(); restoreReader(); await core?.close({ drain: true }); await closeMemoryRuntime(f.db); await f.close(); }
  });
}

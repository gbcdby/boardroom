import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createLogger } from '../src/server/logger.ts';
import { newId } from '../src/server/db/ids.ts';
import type { DbRow } from '../src/server/db/driver.ts';
import type { MessageReadScope, RepositorySet } from '../src/server/db/repositories.ts';
import { WriteFailedError } from '../src/server/db/errors.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { closeMemoryRuntime } from '../src/server/memory/runtime.ts';
import { memoryFixture, pgUnavailable } from './helpers/memory-fixture.ts';

const logger = createLogger({ level: 'error', write() {} });
async function people(repos: RepositorySet, name = '批量接收者') {
  const project = await repos.projects.create({ name: '#154 批量投递' });
  const sender = await repos.members.create({ projectId: project.id, kind: 'human', displayName: '人' });
  const agent = await repos.agents.create({ displayName: name, hostType: 'other' });
  const receiver = await repos.members.create({ projectId: project.id, kind: 'agent', agentId: agent.id, displayName: agent.displayName });
  const group = await repos.groups.create({ projectId: project.id, name: '批量群', participantMemberIds: [sender.id, receiver.id] });
  const scope: MessageReadScope = { projectId: project.id, groupId: group.id, memberId: receiver.id, membershipRevision: receiver.membershipRevision };
  return { project, sender, receiver, agent, group, scope };
}

/** 仅播种消息来源；不预造任何 MCP 投递、ACK 或记忆收据。 */
async function seed(repos: RepositorySet, p: Awaited<ReturnType<typeof people>>, count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId());
  const at = '2026-11-11T10:00:00.000Z';
  await repos.transaction(() => repos.mutations.run({ projectIds: [p.project.id], discover: async () => ({
    memberIds: [p.sender.id, p.receiver.id], groupIds: [p.group.id], runtimeIds: [],
  }) }, async () => {
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50), params: unknown[] = [];
      for (const [offset, id] of batch.entries()) params.push(id, p.group.id, p.sender.id, start + offset + 1, `真实消息来源 ${start + offset + 1}`, JSON.stringify([p.receiver.id]), at);
      await repos.context.exec(`INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at)
        VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(',')}`, params);
    }
  }));
  return ids;
}

for (const engine of ['sqlite', 'postgres'] as const) {
  const gate = { skip: engine === 'postgres' ? pgUnavailable : false };
  test(`${engine} #154 批量投递跨参数分块：257条逐列保真、ACK不复活和真实重投`, gate, async () => memoryFixture(async repos => {
    const p = await people(repos), ids = await seed(repos, p, 257);
    const oldAt = '2026-11-11T11:00:00.000Z', firstAt = '2026-11-11T12:00:00.000Z', secondAt = '2026-11-11T13:00:00.000Z';
    await repos.deliveries.recordAttempt(ids[0]!, p.receiver.id, 'acked', oldAt);
    await repos.deliveries.ensure(ids[1]!, p.receiver.id, { decision: 'allowed' });
    const query = repos.context.query, one = repos.context.one, exec = repos.context.exec;
    let reads = 0, writes = 0, maxParameters = 0;
    repos.context.query = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => {
      reads++; maxParameters = Math.max(maxParameters, params?.length ?? 0); return query<T>(sql, params);
    };
    repos.context.one = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => {
      reads++; maxParameters = Math.max(maxParameters, params?.length ?? 0); return one<T>(sql, params);
    };
    repos.context.exec = async (sql, params) => {
      writes++; maxParameters = Math.max(maxParameters, params?.length ?? 0); return exec(sql, params);
    };
    try { await repos.deliveries.markMcpDeliveredBatch(p.scope, ids, firstAt); }
    finally { repos.context.query = query; repos.context.one = one; repos.context.exec = exec; }
    assert.ok(maxParameters <= 999, `单条参数数 ${maxParameters} 不得依赖较高SQLite/PG参数上限`);
    assert.ok(reads < 40 && writes < 20, `257条需批量往返，实际 reads=${reads} writes=${writes}`);
    const first = await repos.context.query('SELECT * FROM message_deliveries WHERE member_id = ? ORDER BY message_id', [p.receiver.id]);
    assert.equal(first.length, ids.length);
    const firstById = new Map(first.map(row => [String(row.message_id), row]));
    for (const id of ids) {
      const row = firstById.get(id)!;
      assert.equal(row.project_id, p.project.id); assert.equal(row.member_id, p.receiver.id);
      assert.equal(row.first_mcp_delivered_at, firstAt); assert.equal(row.last_delivered_at, firstAt); assert.equal(row.updated_at, firstAt);
      assert.equal(row.first_delivered_at, id === ids[0] ? oldAt : firstAt);
      assert.equal(row.acked_at, id === ids[0] ? oldAt : null);
      assert.equal(row.status, id === ids[0] ? 'acked' : 'delivered');
      assert.equal(row.attempt_count, id === ids[0] ? 2 : 1);
      assert.equal(row.wake_decision, id === ids[1] ? 'allowed' : null);
    }
    await repos.deliveries.markMcpDeliveredBatch(p.scope, ids, secondAt);
    const second = await repos.context.query('SELECT * FROM message_deliveries WHERE member_id = ? ORDER BY message_id', [p.receiver.id]);
    for (const row of second) {
      const before = firstById.get(String(row.message_id))!;
      assert.deepEqual(row, { ...before, attempt_count: Number(before.attempt_count) + 1, last_delivered_at: secondAt, updated_at: secondAt });
    }
  }, engine));

  test(`${engine} #154 真实wait保留257条完整积压，正文不为最终复核重载且查询次数有界`, gate, async t => memoryFixture(async (repos, db) => {
    const p = await people(repos), ids = await seed(repos, p, 257);
    const core = createMcpCore({ repos, db, logger, memberKey: 'batch-count' });
    await core.join('receiver', { projectId: p.project.id, groupId: p.group.id, displayName: p.agent.displayName, hostType: 'other' });
    const query = repos.context.query, one = repos.context.one;
    let reads = 0, bodyRows = 0;
    const observe = (value: unknown) => {
      for (const row of Array.isArray(value) ? value : value ? [value] : []) {
        if (typeof row === 'object' && row !== null && 'body' in row && 'mentions' in row) bodyRows++;
      }
    };
    repos.context.query = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => {
      reads++; const result = await query<T>(sql, params); observe(result); return result;
    };
    repos.context.one = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => {
      reads++; const result = await one<T>(sql, params); observe(result); return result;
    };
    try {
      const result = await core.waitForMessages('receiver', { timeoutMs: 1000 });
      assert.equal(result.status, 'message'); assert.deepEqual(result.messages.map(m => m.id), ids); assert.equal(result.cursor, 'c_257');
      t.diagnostic(JSON.stringify({ messages: result.messages.length, reads, bodyRows }));
      assert.ok(reads < 250, `完整257条积压不能逐消息重复一套查询，实际${reads}条读取`);
      assert.equal(bodyRows, 257, '最终权限重验只需标识，不能把每条正文再加载一遍');
    } finally {
      repos.context.query = query; repos.context.one = one; await core.close(); await closeMemoryRuntime(db);
    }
  }, engine));

  test(`${engine} #154 后续SQL分块真实失败时，既有ACK及所有新投递整批回滚`, gate, async () => memoryFixture(async (repos, db) => {
    const p = await people(repos), ids = await seed(repos, p, 257);
    await repos.deliveries.recordAttempt(ids[0]!, p.receiver.id, 'acked', '2026-11-11T11:00:00.000Z');
    const before = await repos.context.query('SELECT * FROM message_deliveries ORDER BY id');
    const exec = repos.context.exec;
    let updates = 0;
    const physicalTransactions = new Set<unknown>();
    repos.context.exec = async (sql, params) => {
      if (/UPDATE message_deliveries SET/.test(sql)) {
        physicalTransactions.add(db.currentTransactionContext());
        if (++updates === 2) {
          assert.ok(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM message_deliveries'))!.count) > before.length,
            '故障前确实已执行前块写入，而非入口提前拒绝');
          assert.equal((await repos.deliveries.get(ids[0]!, p.receiver.id))?.attemptCount, 2);
          throw new WriteFailedError('第二个真实 UPDATE 分块注入存储失败');
        }
      }
      return exec(sql, params);
    };
    try { await assert.rejects(repos.deliveries.markMcpDeliveredBatch(p.scope, ids), { code: 'write_failed' }); }
    finally { repos.context.exec = exec; }
    assert.equal(updates, 2); assert.equal(physicalTransactions.size, 1); assert.ok(!physicalTransactions.has(undefined));
    assert.deepEqual(await repos.context.query('SELECT * FROM message_deliveries ORDER BY id'), before);
  }, engine));

  test(`${engine} #154 非法或失效来源不能通过合法前缀产生部分投递`, gate, async () => memoryFixture(async repos => {
    const p = await people(repos), ids = await seed(repos, p, 257);
    const otherGroup = await repos.groups.create({ projectId: p.project.id, name: '另一个群', participantMemberIds: [p.sender.id, p.receiver.id] });
    const other = await repos.messages.create({ groupId: otherGroup.id, senderMemberId: p.sender.id, body: '同项目另一群', mentions: [p.receiver.id] });
    const foreign = await people(repos, '外项目接收者'), foreignIds = await seed(repos, foreign, 1);
    const invisible = await repos.messages.create({ groupId: p.group.id, senderMemberId: p.sender.id, body: '未提及接收者' });
    await repos.deliveries.ensure(ids[0]!, p.receiver.id, { decision: 'suppressed', reason: 'rate_limited' });
    const before = await repos.context.query('SELECT * FROM message_deliveries ORDER BY id');
    const rejectAll = async (scope: MessageReadScope, values: readonly string[]) => {
      await assert.rejects(repos.deliveries.markMcpDeliveredBatch(scope, values));
      assert.deepEqual(await repos.context.query('SELECT * FROM message_deliveries ORDER BY id'), before);
    };
    // 非法项放在超过两块的尾部，不能靠只验证首块或静默丢弃尾部通过。
    for (const id of ['missing-message', other.id, foreignIds[0]!, invisible.id, ids[0]!, '', '   ', 17 as unknown as string]) {
      await rejectAll(p.scope, [...ids, id]);
    }
    for (const revision of [0, 1.5, Number.NaN, p.scope.membershipRevision + 1]) await rejectAll({ ...p.scope, membershipRevision: revision }, ids);
    await rejectAll({ ...p.scope, projectId: foreign.project.id }, ids);
    await rejectAll({ ...p.scope, groupId: foreign.group.id }, ids);
    await rejectAll({ ...p.scope, memberId: p.sender.id, membershipRevision: p.sender.membershipRevision }, ids);
    await repos.members.setStatus(p.receiver.id, 'disabled'); await rejectAll(p.scope, ids);
    await repos.members.setStatus(p.receiver.id, 'active');
    await repos.groups.removeParticipant(p.group.id, p.receiver.id); await rejectAll(p.scope, ids);
    await repos.groups.addParticipant(p.group.id, p.receiver.id);
    await repos.groups.archive(p.group.id); await rejectAll(p.scope, ids); await repos.groups.restore(p.group.id);
    await repos.projects.archive(p.project.id); await rejectAll(p.scope, ids); await repos.projects.restore(p.project.id);
    const removed = await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, p.project.id, p.receiver.id);
    await rejectAll(p.scope, ids);
    await createAuditCompensationService({ repos }).revoke({ actor: ownerActor() }, p.project.id, removed.auditId);
    await rejectAll(p.scope, ids);
    const current = (await repos.members.get(p.receiver.id))!;
    assert.equal(current.membershipRevision, p.scope.membershipRevision + 2);
    await repos.deliveries.markMcpDeliveredBatch({ ...p.scope, membershipRevision: current.membershipRevision }, ids);
    assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM message_deliveries'))!.count), ids.length);
    assert.equal((await repos.deliveries.get(ids[0]!, p.receiver.id))?.wakeSuppressedReason, 'rate_limited');
  }, engine));
}

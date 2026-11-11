import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createDbDriver, type DbDriver } from '../src/server/db/driver.ts';
import { migrations } from '../src/server/db/migrations/index.ts';
import { createRepositories, type RepositorySet } from '../src/server/db/repositories.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
const pgUrl = process.env['AGENT_STUDIO_PG_TEST_URL'] ?? process.env['AGENT_STUDIO_PG_CONNECTION_STRING'];
const at = '2026-11-11T00:00:00.000Z';
async function withDb(engine: 'sqlite' | 'postgres', body: (repos: RepositorySet, db: DbDriver, schema: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'boardroom-data-scope-')), schema = `data_${randomUUID().replaceAll('-', '')}`;
  const db = createDbDriver(engine === 'sqlite' ? { dataDir: dir } : { dbDriver: 'postgres', pgConnectionString: pgUrl!, pgSchema: schema });
  try { await db.connect(); await db.migrate(migrations); await body(createRepositories(db), db, schema); }
  finally { await db.close(); if (engine === 'postgres') { const c = new Client({ connectionString: pgUrl }); await c.connect(); try { await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await c.end(); } } await rm(dir, { recursive: true, force: true }); }
}
test('postgres 真实三连接屏障：等项目锁的成员写入不预先占有成员锁', { skip: !pgUrl ? '未配置真实 PostgreSQL；交 CI 执行' : false, timeout: 10000 }, async () => {
  await withDb('postgres', async (repos, _db, schema) => {
    const p = await repos.projects.create({ name: '锁序' }), m = await repos.members.create({ projectId: p.id, kind: 'human', displayName: '目标' });
    const second = createDbDriver({ dbDriver: 'postgres', pgConnectionString: pgUrl!, pgSchema: schema }); await second.connect();
    const other = createRepositories(second), third = new Client({ connectionString: pgUrl }); await third.connect();
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const owner = repos.mutations.run({ projectIds: [p.id], discover: async () => ({ memberIds: [], groupIds: [], runtimeIds: [] }) }, async () => { locked(); await release; });
    let contender: Promise<{ error?: unknown }> | undefined;
    try {
      await ready;
      let observed!: (name: string) => void;
      const firstLock = new Promise<string>(resolve => { observed = resolve; });
      const observe = (sql: string) => { const match = sql.match(/^\s*UPDATE (projects|members)\b/i); if (match) observed(match[1]!); };
      const rawExec = second.exec.bind(second), contextExec = other.context.exec;
      second.exec = (sql, params) => { observe(sql); return rawExec(sql, params); };
      other.context.exec = (sql, params) => { observe(sql); return contextExec(sql, params); };
      contender = other.members.setStatus(m.id, 'disabled').then(() => ({}), error => ({ error }));
      // race 仅选择测试屏障/异常，不取消 SQL，也不把等待当作已回滚。
      const first = await Promise.race([firstLock, contender.then(result => { throw result.error ?? new Error('写入不应越过仍持有的项目锁'); })]);
      assert.equal(first, 'projects');
      await third.query(`SET search_path TO "${schema}"`); await third.query('BEGIN');
      await third.query('SELECT id FROM members WHERE id = $1 FOR UPDATE NOWAIT', [m.id]);
      await third.query('ROLLBACK');
      unlock(); await owner;
      assert.deepEqual(await contender, {});
      assert.equal((await repos.members.get(m.id))!.status, 'disabled');
    } finally {
      unlock(); await owner.catch(() => {}); if (contender) await contender;
      await third.query('ROLLBACK').catch(() => {}); await third.end(); await second.close();
    }
  });
});
for (const engine of ['sqlite', 'postgres'] as const) {
  const skip = engine === 'postgres' && !pgUrl ? '未配置真实 PostgreSQL；交 CI 执行' : false;
  test(`${engine} 数据写入口复用共同项目/成员范围，移除成员不能写消息投递状态或连接`, { skip }, async () => withDb(engine, async (repos) => {
    const p = await repos.projects.create({ name: '共同范围' });
    const a = await repos.agents.create({ displayName: 'Agent', hostType: 'fixture' });
    const m = await repos.members.create({ projectId: p.id, kind: 'agent', agentId: a.id, displayName: 'Agent' });
    const exec = repos.context.exec;
    repos.context.exec = async (sql, args) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) assert.ok(repos.mutations.current(), `缺少共同 scope: ${sql}`);
      return exec(sql, args);
    };
    const g = await repos.groups.create({ projectId: p.id, name: '群', participantMemberIds: [m.id] });
    const message = await repos.messages.create({ groupId: g.id, senderMemberId: m.id, body: '历史' });
    await repos.deliveries.ensure(message.id, m.id);
    await repos.statuses.set(p.id, m.id, 'online');
    const session = await repos.mcpSessions.connect({ projectId: p.id, agentId: a.id, groupId: g.id, memberId: m.id, displayName: 'Agent', hostType: 'fixture' });
    await createOrgMutationService({ repos }).removeMember({ actor: ownerActor() }, p.id, m.id);
    for (const action of [() => repos.messages.create({ groupId: g.id, senderMemberId: m.id, body: '旧连接迟到' }),
      () => repos.deliveries.ensure(message.id, m.id), () => repos.deliveries.recordAttempt(message.id, m.id, 'acked'),
      () => repos.statuses.set(p.id, m.id, 'working'), () => repos.mcpSessions.connect({ projectId: p.id, agentId: a.id, groupId: g.id, memberId: m.id, displayName: 'Agent', hostType: 'fixture' }),
      () => repos.mcpSessions.heartbeat(session.id, at)]) await assert.rejects(action);
    assert.deepEqual(await repos.deliveries.listPending(p.id, m.id), []);
    assert.equal((await repos.deliveries.get(message.id, m.id))!.status, 'pending');
    assert.equal((await repos.messages.get(message.id))!.body, '历史');
    await assert.rejects(() => repos.members.delete(m.id), /mutation service|生命周期/);
  }));
  test(`${engine} 群 purge 只清目标闭包的 orphan reservation；项目 purge 计入并最后删除事实版本`, { skip }, async () => withDb(engine, async (repos, db) => {
    const a = await repos.agents.create({ displayName: 'Runtime', hostType: 'fixture' });
    const p = await repos.projects.create({ name: '目标' }), other = await repos.projects.create({ name: '保留' });
    const m = await repos.members.create({ projectId: p.id, kind: 'agent', agentId: a.id, displayName: 'Runtime' });
    const foreign = await repos.members.create({ projectId: other.id, kind: 'agent', agentId: a.id, displayName: 'Runtime' });
    const g = await repos.groups.create({ projectId: p.id, name: '目标群', participantMemberIds: [m.id] });
    const runtimeId = randomUUID(), bindingId = randomUUID();
    await db.exec('INSERT INTO agent_runtimes (id, agent_id, defaults_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [runtimeId, a.id, '{}', at, at]);
    for (const [projectId, memberId] of [[p.id, m.id], [other.id, foreign.id]]) await db.exec('INSERT INTO agent_runtime_members (member_id, runtime_id, project_id, updated_at) VALUES (?, ?, ?, ?)', [memberId, runtimeId, projectId, at]);
    await db.exec('INSERT INTO agent_runtime_bindings (id, runtime_id, project_id, group_id, member_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [bindingId, runtimeId, p.id, g.id, m.id, at, at]);
    await db.exec('INSERT INTO agent_runner_states (binding_id, updated_at) VALUES (?, ?)', [bindingId, at]);
    await repos.messages.create({ groupId: g.id, senderMemberId: m.id, body: '先清事实再清member' });
    const scopeOrder: string[] = [], originalExec = db.exec.bind(db);
    db.exec = async (sql, params) => { if (/^UPDATE (projects|members|groups|agent_runtimes) SET updated_at = updated_at/i.test(sql)) scopeOrder.push(sql.match(/^UPDATE (\w+)/)![1]!); return originalExec(sql, params); };
    const counts = await repos.groups.purge(g.id);
    assert.equal(counts.agentRuntimeMembers, 1);
    assert.ok(await db.query('SELECT member_id FROM agent_runtime_members WHERE member_id = ?', [foreign.id]).then(r => r[0]));
    assert.equal((await db.query('SELECT member_id FROM agent_runtime_members WHERE member_id = ?', [m.id])).length, 0);
    assert.ok(scopeOrder.indexOf('projects') < scopeOrder.indexOf('members'));
    assert.ok(scopeOrder.indexOf('members') < scopeOrder.indexOf('groups'));
    const before = await repos.projects.previewPurge(p.id);
    assert.equal(before.memberFactRevisions, 6);
    assert.deepEqual(await repos.projects.purge(p.id), before);
    assert.equal((await db.query('SELECT member_id FROM member_fact_revisions WHERE member_id = ?', [m.id])).length, 0);
    assert.equal((await db.query('SELECT member_id FROM member_fact_revisions WHERE member_id = ?', [foreign.id])).length, 6);
    assert.ok(await repos.agents.get(a.id));
    assert.equal((await db.query('SELECT id FROM agent_runtimes WHERE id = ?', [runtimeId])).length, 1);
  }));
}

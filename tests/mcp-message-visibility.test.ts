import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createLogger } from '../src/server/logger.ts';
import { newId } from '../src/server/db/ids.ts';
import type { RepositorySet } from '../src/server/db/repositories.ts';
import type { DbDriver, DbRow } from '../src/server/db/driver.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { memoryFixture, pgUnavailable } from './helpers/memory-fixture.ts';

const logger = createLogger({ level: 'error', write() {} });
async function room(repos: RepositorySet, db: DbDriver) {
  const project = await repos.projects.create({ name: '读取过滤' });
  const members = [];
  for (const displayName of ['发送者', '接收者', '其他成员']) {
    const agent = await repos.agents.create({ displayName, hostType: 'other' });
    members.push(await repos.members.create({ projectId: project.id, kind: 'agent', agentId: agent.id, displayName }));
  }
  const [sender, receiver, other] = members;
  const group = await repos.groups.create({ projectId: project.id, name: '当前群', participantMemberIds: members.map(m => m.id) });
  const core = createMcpCore({ repos, db, logger, memberKey: 'visibility-test' });
  await core.join('receiver', { projectId: project.id, groupId: group.id, displayName: receiver!.displayName, hostType: 'other' });
  return { project, group, sender: sender!, receiver: receiver!, other: other!, core };
}
async function task(repos: RepositorySet, projectId: string, assigneeMemberId: string, reviewerMemberId: string) {
  const at = new Date().toISOString();
  return repos.tasks.create({ id: newId(), projectId, title: '当前可见关系', body: '不读取任务正文判定消息权限', deliveryKind: "code", acceptanceText: '不读取任务正文判定消息权限', acceptanceSource: "explicit", labels: [], state: 'todo',
    assigneeMemberId, reviewerMemberId, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null,
    author: { kind: 'human', actorId: 'human:local', displayName: '人' }, createdAt: at, updatedAt: at });
}

for (const engine of ['sqlite', 'postgres'] as const) {
  const gate = { skip: engine === 'postgres' ? pgUnavailable : false };
  test(`${engine} 已有普通岗位时旧legacy manager不得扩大消息权限，未落位兼容角色仍有效`, gate, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db);
    try {
      const root = await repos.org.createNode({ projectId: r.project.id, name: '根', role: 'top_manager' });
      const ordinary = await repos.org.createNode({ projectId: r.project.id, parentId: root.id, name: '普通岗', role: 'member' });
      await repos.org.assignNode(r.receiver.id, ordinary.id);
      // 既有成员仓储仍允许独立修改兼容 role，模拟升级数据/历史调用留下的旧投影；没有篡改 SQL。
      await repos.members.update(r.receiver.id, { role: 'manager' });
      const hidden = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '真实岗位不应读取的无提及正文' });
      const scope = { projectId: r.project.id, groupId: r.group.id, memberId: r.receiver.id, membershipRevision: r.receiver.membershipRevision };
      assert.deepEqual(await repos.messages.listVisibleForMember(scope), []);
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages, []);
      assert.equal((await r.core.waitForMessages('receiver', { timeoutMs: 20 })).status, 'timeout');
      await assert.rejects(r.core.acknowledgeMessage('receiver', hidden.id), { code: 'FORBIDDEN' });
      assert.equal(await repos.deliveries.get(hidden.id, r.receiver.id), null);
      await repos.org.assignNode(r.receiver.id, null);
      await repos.members.update(r.receiver.id, { role: 'manager' });
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [hidden.id]);
      assert.deepEqual((await r.core.waitForMessages('receiver', { timeoutMs: 100 })).messages.map(m => m.id), [hidden.id]);
    } finally { await r.core.close(); }
  }, engine));
  test(`${engine} 不可见大前缀与已ACK消息在数据库内过滤，原始seq及真实投递事实不丢失`, gate, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db);
    const hiddenBody = '不可见历史正文🙂'.repeat(256), at = new Date().toISOString();
    try {
      await repos.transaction(async () => {
        for (let start = 0; start < 1200; start += 32) {
          const params: unknown[] = [], values = [];
          for (let i = start; i < Math.min(start + 32, 1200); i++) {
            values.push('(?, ?, ?, ?, ?, ?, ?)'); params.push(newId(), r.group.id, r.sender.id, i + 1, hiddenBody, '[]', at);
          }
          await repos.context.exec(`INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at) VALUES ${values.join(',')}`, params);
        }
      });
      const acked = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '已经确认', mentions: [r.receiver.id] });
      await repos.deliveries.recordAttempt(acked.id, r.receiver.id, 'acked', at);
      const expected = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '前缀之后的可见消息', mentions: [r.receiver.id] });
      const query = repos.context.query, one = repos.context.one;
      let hiddenBodiesLoaded = 0, sqlCount = 0;
      const observe = (value: unknown) => {
        for (const row of Array.isArray(value) ? value : value ? [value] : []) {
          if (typeof row === 'object' && row !== null && 'body' in row && row.body === hiddenBody) hiddenBodiesLoaded++;
        }
      };
      repos.context.query = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => { sqlCount++; const rows = await query<T>(sql, params); observe(rows); return rows; };
      repos.context.one = async <T extends DbRow = DbRow>(sql: string, params?: readonly unknown[]) => { sqlCount++; const row = await one<T>(sql, params); observe(row); return row; };
      try {
        const first = await r.core.waitForMessages('receiver', { timeoutMs: 100 });
        assert.equal(first.status, 'message'); assert.deepEqual(first.messages.map(m => m.id), [expected.id]);
        assert.equal(first.cursor, 'c_1202');
        const delivered = (await repos.deliveries.get(expected.id, r.receiver.id))!;
        assert.ok(delivered.firstMcpDeliveredAt); assert.equal(delivered.status, 'delivered');
        const again = await r.core.waitForMessages('receiver', { timeoutMs: 100 });
        assert.deepEqual(again.messages.map(m => m.id), [expected.id], '未ACK可重复投递');
        assert.equal((await repos.deliveries.get(expected.id, r.receiver.id))?.firstMcpDeliveredAt, delivered.firstMcpDeliveredAt);
        await r.core.acknowledgeMessage('receiver', expected.id);
        const empty = await r.core.waitForMessages('receiver', { timeoutMs: 30 });
        assert.equal(empty.status, 'timeout'); assert.equal(empty.cursor, 'c_1202');
        assert.equal(hiddenBodiesLoaded, 0, '权限/ACK筛选不能在正文全量加载之后发生');
        assert.ok(sqlCount < 700, `一次群查询不能随1200条不可见前缀增加逐行ACL查询，实测${sqlCount}条`);
      } finally { repos.context.query = query; repos.context.one = one; }
    } finally { await r.core.close(); }
  }, engine));
  test(`${engine} 后加任务关联按当前负责人/评审人/评论者扩展可见范围，既往ACK不重新出队且不跨群`, gate, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db), at = new Date().toISOString();
    try {
      const a = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '负责人关联' });
      const b = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '评审人关联' });
      const c = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '评论关联' });
      const d = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '后来的提及', mentions: [r.receiver.id] });
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [d.id]);
      await r.core.acknowledgeMessage('receiver', d.id);
      const beforeLink = await r.core.waitForMessages('receiver', { timeoutMs: 20 });
      assert.equal(beforeLink.status, 'timeout'); assert.equal(beforeLink.cursor, `c_${d.seq}`);
      const ownerTask = await task(repos, r.project.id, r.receiver.id, r.other.id);
      const reviewTask = await task(repos, r.project.id, r.sender.id, r.receiver.id);
      const commentTask = await task(repos, r.project.id, r.sender.id, r.other.id);
      for (const [related, message] of [[ownerTask, a], [reviewTask, b], [commentTask, c]] as const) {
        await repos.tasks.linkMessage(r.project.id, { taskId: related.id, messageId: message.id, groupId: r.group.id, createdAt: at });
      }
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [a.id, b.id, d.id]);
      await repos.tasks.addComment({ id: newId(), taskId: commentTask.id, projectId: r.project.id, kind: 'comment',
        author: { kind: 'agent', actorId: r.receiver.id, displayName: r.receiver.displayName }, body: '加入讨论', createdAt: at, reviewReportId: null });
      const otherGroup = await repos.groups.create({ projectId: r.project.id, name: '同项目另一群', participantMemberIds: [r.sender.id, r.receiver.id] });
      const outside = await repos.messages.create({ groupId: otherGroup.id, senderMemberId: r.sender.id, body: '不能由连接跨群带出' });
      await repos.tasks.linkMessage(r.project.id, { taskId: ownerTask.id, messageId: outside.id, groupId: otherGroup.id, createdAt: at });
      const visible = await r.core.readHistory('receiver', {});
      assert.deepEqual(visible.messages.map(m => m.id), [a.id, b.id, c.id, d.id]);
      await assert.rejects(r.core.readHistory('receiver', { groupId: otherGroup.id }), { code: 'FORBIDDEN' });
      await assert.rejects(r.core.acknowledgeMessage('receiver', outside.id), { code: 'FORBIDDEN' });
      const arrived = await r.core.waitForMessages('receiver', { timeoutMs: 50 });
      assert.deepEqual(arrived.messages.map(m => m.id), [a.id, b.id, c.id], '不缓存不可见前缀的high-water；后关联的旧消息仍是积压');
      assert.equal(arrived.cursor, `c_${c.seq}`);
      const beyond = await r.core.waitForMessages('receiver', { timeoutMs: 20, afterCursor: `c_${d.seq}` });
      assert.equal(beyond.status, 'timeout', '显式原始seq游标仍由调用者选择范围');
    } finally { await r.core.close(); }
  }, engine));
  test(`${engine} 当前岗位与参与边决定可读范围，跨项目/退群/停用/移除及旧代际均拒绝`, gate, async () => memoryFixture(async (repos, db) => {
    const r = await room(repos, db), owner = { actor: ownerActor() };
    const scope = { projectId: r.project.id, groupId: r.group.id, memberId: r.receiver.id, membershipRevision: r.receiver.membershipRevision };
    try {
      const hidden = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '没有提及' });
      const own = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.receiver.id, body: '自己的消息' });
      // 精确 JSON 成员匹配，不能以 LIKE/子串误授提及权限。
      await repos.context.exec('UPDATE messages SET mentions = ? WHERE id = ?', [JSON.stringify([`${r.receiver.id}-suffix`]), hidden.id]);
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [own.id]);
      const root = await repos.org.createNode({ projectId: r.project.id, name: '根', role: 'top_manager' });
      const sub = await repos.org.createNode({ projectId: r.project.id, parentId: root.id, name: '下级', role: 'sub_manager' });
      await repos.org.assignNode(r.receiver.id, root.id);
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [hidden.id, own.id]);
      await repos.org.assignNode(r.receiver.id, sub.id);
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [hidden.id, own.id]);
      await repos.org.assignNode(r.receiver.id, null);
      assert.deepEqual((await r.core.readHistory('receiver', {})).messages.map(m => m.id), [own.id], '不使用join时旧role缓存');
      const human = await repos.members.create({ projectId: r.project.id, kind: 'human', displayName: '人' });
      assert.deepEqual((await repos.messages.listVisibleForMember({ ...scope, memberId: human.id, membershipRevision: human.membershipRevision })).map(m => m.id), [hidden.id, own.id]);
      const otherProject = await repos.projects.create({ name: '其他项目' });
      const otherGroup = await repos.groups.create({ projectId: otherProject.id, name: '其他项目的群' });
      assert.deepEqual(await repos.messages.listVisibleForMember({ ...scope, projectId: otherProject.id }), []);
      assert.deepEqual(await repos.messages.listVisibleForMember({ ...scope, groupId: otherGroup.id }), []);
      assert.equal(await repos.messages.lastDeliveredSeq({ ...scope, projectId: otherProject.id }), null);
      await repos.groups.removeParticipant(r.group.id, r.receiver.id);
      await assert.rejects(r.core.readHistory('receiver', {}), { code: 'FORBIDDEN' });
      await assert.rejects(r.core.waitForMessages('receiver', { timeoutMs: 20 }), { code: 'FORBIDDEN' });
      assert.deepEqual(await repos.messages.listVisibleForMember(scope), []);
      await repos.groups.addParticipant(r.group.id, r.receiver.id);
      await repos.members.setStatus(r.receiver.id, 'disabled');
      await assert.rejects(r.core.readHistory('receiver', {}), { code: 'FORBIDDEN' });
      assert.deepEqual(await repos.messages.listVisibleForMember(scope), []);
      await repos.members.setStatus(r.receiver.id, 'active');
      const removed = await createOrgMutationService({ repos }).removeMember(owner, r.project.id, r.receiver.id);
      await assert.rejects(r.core.readHistory('receiver', {}), { code: 'FORBIDDEN' });
      assert.deepEqual(await repos.messages.listVisibleForMember(scope), []);
      await createAuditCompensationService({ repos }).revoke(owner, r.project.id, removed.auditId);
      await assert.rejects(r.core.readHistory('receiver', {}), error => (error as { details?: { reason?: string } }).details?.reason === 'membership_changed');
      assert.deepEqual(await repos.messages.listVisibleForMember(scope), []);
      const current = (await repos.members.get(r.receiver.id))!;
      assert.deepEqual((await repos.messages.listVisibleForMember({ ...scope, membershipRevision: current.membershipRevision })).map(m => m.id), [own.id]);
    } finally { await r.core.close(); }
  }, engine));
  test(`${engine} 129条可见积压全部保留；历史SQL分页只按既有limit收窄并保留raw seq`, gate, async t => memoryFixture(async (repos, db) => {
    const r = await room(repos, db);
    async function measuredWait(label: string, afterCursor?: string) {
      const query = repos.context.query, one = repos.context.one;
      let sql = 0, messageBodyRows = 0;
      const observe = (rows: DbRow[]) => { for (const row of rows) if ('body' in row && 'mentions' in row) messageBodyRows++; };
      repos.context.query = async <T extends DbRow = DbRow>(statement: string, params?: readonly unknown[]) => {
        sql++; const rows = await query<T>(statement, params); observe(rows); return rows;
      };
      repos.context.one = async <T extends DbRow = DbRow>(statement: string, params?: readonly unknown[]) => {
        sql++; const row = await one<T>(statement, params); if (row) observe([row]); return row;
      };
      const started = performance.now();
      try {
        const result = await r.core.waitForMessages('receiver', { timeoutMs: 100, ...(afterCursor ? { afterCursor } : {}) });
        const elapsedMs = performance.now() - started;
        t.diagnostic(JSON.stringify({ label, messages: result.messages.length, elapsedMs, sql, messageBodyRows }));
        assert.ok(elapsedMs < 2000, `${label} 完整积压读取耗时 ${elapsedMs}ms`);
        return result;
      } finally { repos.context.query = query; repos.context.one = one; }
    }
    try {
      const all = [];
      const invisible = await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: '不改变历史beforeCursor含义' });
      for (let i = 0; i < 129; i++) all.push(await repos.messages.create({ groupId: r.group.id, senderMemberId: r.sender.id, body: `积压 ${i}`, mentions: [r.receiver.id] }));
      const first = await r.core.readHistory('receiver', { limit: 7 });
      assert.deepEqual(first.messages.map(m => m.id), all.slice(-7).map(m => m.id)); assert.equal(first.hasMore, true); assert.equal(first.cursor, 'c_130');
      const preceding = await r.core.readHistory('receiver', { limit: 7, beforeCursor: `c_${all.at(-7)!.seq}` });
      assert.deepEqual(preceding.messages.map(m => m.id), all.slice(-14, -7).map(m => m.id));
      assert.deepEqual(await r.core.readHistory('receiver', { limit: 7, beforeCursor: `c_${invisible.seq}` }), first);
      assert.deepEqual(await r.core.readHistory('receiver', { limit: 7, beforeCursor: 'c_999999' }), first);
      const backlog = await measuredWait('首次129条积压');
      assert.deepEqual(backlog.messages.map(m => m.id), all.map(m => m.id), '没有引入32/50条内部截断');
      await r.core.acknowledgeMessage('receiver', all[0]!.id);
      const partial = await measuredWait('显式游标后69条', `c_${all[59]!.seq}`);
      assert.deepEqual(partial.messages.map(m => m.id), all.slice(60).map(m => m.id));
      const again = await measuredWait('未ACK的128条重投');
      assert.deepEqual(again.messages.map(m => m.id), all.slice(1).map(m => m.id), '显式游标不把较早的未ACK积压静默标记已读');
    } finally { await r.core.close(); }
  }, engine));
}

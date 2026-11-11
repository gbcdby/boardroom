import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpCore } from '../src/server/mcp/core.ts';
import { createMcpServer } from '../src/server/mcp/server.ts';
import { createLogger } from '../src/server/logger.ts';
import { ownerActor } from '../src/server/authz/actors.ts';
import { createOrgMutationService } from '../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../src/server/audit-compensation.ts';
import { CaptureBudget } from '../src/server/org/capture-budget.ts';
import { newId } from '../src/server/db/ids.ts';
import type { RepositorySet } from '../src/server/db/repositories.ts';
import type { DbDriver } from '../src/server/db/driver.ts';
import type { Group, Member, Project } from '../src/server/db/types.ts';
import { memoryFixture, pgUnavailable } from './helpers/memory-fixture.ts';

/**
 * S5-AUDIT-16 独立负载门禁：不要与全量单测多进程争抢 CPU 后比较固定 NFR。
 * node --test --test-concurrency=1 tests/lifecycle-load.acceptance.ts
 * 真实 SQLite/PG + 真实 MCP server/SDK。InMemoryTransport 不声称验证 HTTP/DOM/原生模型。
 */
type ProjectLoad = { project: Project; members: Member[]; groups: Group[] };
type Payload = { ok: boolean; [key: string]: unknown };
const logger = createLogger({ level: 'error', write() {} });
const access = { actor: ownerActor() };
const rounded = (n: number) => Number(n.toFixed(3));

class MeasuredBudget extends CaptureBudget {
  readonly statements: string[] = [];
  readonly invokedAt = performance.now();
  acquiredAt: number | null = null;
  plannedAt: number | null = null;
  override before(sql: string): void { this.statements.push(sql); super.before(sql); }
  override after(sql: string, result: unknown, kind: 'query' | 'exec'): void {
    super.after(sql, result, kind);
    if (this.acquiredAt === null && /^\s*UPDATE projects SET updated_at = updated_at/i.test(sql)) this.acquiredAt = performance.now();
  }
  override plan(cost: { rows: number; bytes: number; sql: number; changedRows: number }): void {
    super.plan(cost); this.plannedAt ??= performance.now();
  }
  measure() {
    const endedAt = performance.now();
    return { elapsedMs: rounded(endedAt - this.invokedAt), lockWaitMs: this.acquiredAt === null ? null : rounded(this.acquiredAt - this.invokedAt),
      captureAndVerifyMs: this.acquiredAt === null || this.plannedAt === null ? null : rounded(this.plannedAt - this.acquiredAt),
      applyReadbackAndAuditMs: this.plannedAt === null ? null : rounded(endedAt - this.plannedAt), ...this.stats,
      retainedFactReads: this.statements.filter(sql => /FROM\s+member_fact_revisions\b/i.test(sql)).length };
  }
}

async function clientFor(db: DbDriver, name: string, projectId: string, groupId: string) {
  const core = createMcpCore({ db, logger, memberKey: `${name}:${projectId}:${groupId}` });
  const server = createMcpServer({ core, logger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `load-${name}`, version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  async function call(tool: string, args: Record<string, unknown>): Promise<Payload> {
    const result = await client.callTool({ name: tool, arguments: args });
    const part = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text');
    assert.ok(part?.text, `${tool} 必须返回真实工具响应`);
    const payload = JSON.parse(part.text) as Payload;
    assert.equal(result.isError === true, false, `${tool}: ${part.text}`);
    assert.equal(payload.ok, true, `${tool}: ${part.text}`);
    return payload;
  }
  try {
    const joined = await call('join', { displayName: name, hostType: 'other', projectId, groupId });
    return { call, joined, async close() { await client.close(); await server.close(); await core.close(); } };
  } catch (error) { await client.close(); await server.close(); await core.close(); throw error; }
}

async function createLoad(repos: RepositorySet): Promise<ProjectLoad[]> {
  const agents = [];
  for (const displayName of ['Load A', 'Load B', 'Load C']) agents.push(await repos.agents.create({ displayName, hostType: 'other' }));
  const projects: ProjectLoad[] = [];
  for (let i = 0; i < 5; i++) {
    const project = await repos.projects.create({ name: `固定负载 ${i + 1}` });
    const members = [];
    for (const agent of agents) members.push(await repos.members.create({ projectId: project.id, kind: 'agent', agentId: agent.id, displayName: agent.displayName }));
    const groups = [];
    for (let j = 0; j < 5; j++) groups.push(await repos.groups.create({ projectId: project.id, name: `群 ${j + 1}`, participantMemberIds: members.map(member => member.id) }));
    projects.push({ project, members, groups });
  }
  const target = projects[0]!, memberId = target.members[2]!.id, at = new Date().toISOString();
  await repos.tasks.create({ id: newId(), projectId: target.project.id, title: '固定负载下保留的指派', body: '正文不是补偿输入', labels: [], state: 'in-progress',
    assigneeMemberId: memberId, reviewerMemberId: memberId, repoPath: null, fixedPoint: null, revision: 1, currentReviewRoundId: null, blockedReason: null,
    author: { kind: 'human', actorId: 'human:local', displayName: '人' }, createdAt: at, updatedAt: at });
  await repos.tasks.setSettings(target.project.id, 0, memberId);
  return projects;
}

/** 负载播种不模拟一次真实投递：旧 ACK 行的 first_mcp_delivered_at 保持 NULL。 */
async function seedHistory(repos: RepositorySet, projects: ProjectLoad[], perGroup: number, large: boolean, unmentioned = false): Promise<number> {
  let bodyBytes = 0;
  const at = new Date().toISOString(), largeBody = '资料档案🧠'.repeat(16000);
  await repos.transaction(() => repos.mutations.run({ projectIds: projects.map(p => p.project.id), discover: async () => ({
    memberIds: projects.flatMap(p => p.members.map(m => m.id)), groupIds: projects.flatMap(p => p.groups.map(g => g.id)), runtimeIds: [],
  }) }, async () => {
    for (const p of projects) for (const g of p.groups) {
      const current = await repos.context.one<{ seq: number | string }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE group_id = ?', [g.id]);
      const first = Number(current!.seq), mentions = unmentioned ? '[]' : JSON.stringify(p.members.slice(0, 2).map(m => m.id));
      for (let start = 0; start < perGroup; start += 32) {
        const messageParams: unknown[] = [], deliveryParams: unknown[] = [], messageValues: string[] = [], deliveryValues: string[] = [];
        for (let i = start; i < Math.min(start + 32, perGroup); i++) {
          const id = newId(), body = unmentioned
            ? `历史 ${String(first + i + 1).padStart(5, '0')}：${large ? '长正文🙂'.repeat(256) : '普通协作记录，无提及。'}`
            : large && i === 0 ? largeBody : `历史短消息 ${first + i + 1}`;
          bodyBytes += Buffer.byteLength(body);
          messageValues.push('(?, ?, ?, ?, ?, ?, ?)');
          messageParams.push(id, g.id, p.members[2]!.id, first + i + 1, body, mentions, at);
          for (const member of unmentioned ? [] : p.members) {
            deliveryValues.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            deliveryParams.push(newId(), id, member.id, p.project.id, 'acked', 1, at, at, at, at, at);
          }
        }
        await repos.context.exec(`INSERT INTO messages (id, group_id, sender_member_id, seq, body, mentions, created_at) VALUES ${messageValues.join(',')}`, messageParams);
        if (deliveryValues.length) await repos.context.exec(`INSERT INTO message_deliveries (id, message_id, member_id, project_id, status, attempt_count, first_delivered_at, last_delivered_at, acked_at, created_at, updated_at) VALUES ${deliveryValues.join(',')}`, deliveryParams);
      }
    }
  }));
  return bodyBytes;
}

for (const engine of ['sqlite', 'postgres'] as const) {
 for (const profile of ['acked-history', 'unmentioned-history'] as const) {
  const unmentioned = profile === 'unmentioned-history';
  test(`${engine} ${profile} S5-AUDIT-16 固定 V1 与 10000 历史负载，每次补偿及真实 MCP 投递独立验限`,
    { skip: engine === 'postgres' ? pgUnavailable : false, timeout: 120000 }, async t => {
      const report = { schemaVersion: 1, engine, profile, node: process.version, platform: process.platform, transport: 'MCP SDK InMemoryTransport',
        limits: { mutationMs: 500, deliveryAndAckMs: 2000 }, status: 'RUNNING', error: null as string | null,
        fixture: { agents: 3, projects: 5, groupsPerProject: 5, membersPerGroup: 3, messageBodiesAreFixtureData: true },
        measurements: { sql: '实际 RepoCtx 查询/写入与 coordinator 锁语句；不含 driver 的 BEGIN/COMMIT/SAVEPOINT 控制语句',
          bytes: '实际返回行 JSON 表示的 UTF-8 字节；不是数据库协议线上的传输字节',
          stages: '等待首个项目锁；capture/verify 直到完整计划通过；apply/readback/audit 直到真实事务返回' },
        scope: '组织/成员补偿与同库真实 MCP 消息、ACK、心跳；不含 HTTP、DOM、macOS 或原生模型',
        phases: [] as Array<Record<string, unknown>>, operations: [] as Array<Record<string, unknown>> };
      try {
        await memoryFixture(async (repos, db) => {
          const projects = await createLoad(repos), target = projects[0]!, survivor = projects[1]!;
          const targetId = target.members[2]!.id, service = createOrgMutationService({ repos }), compensation = createAuditCompensationService({ repos });
          let cumulativeBytes = 0;
          for (let phase = 0; phase < 2; phase++) {
            // 第二种负载对应真实 HTTP 暴露的瓶颈：全部历史集中于主项目5群、无@、无delivery、wait不传afterCursor。
            cumulativeBytes += await seedHistory(repos, unmentioned ? [target] : projects,
              unmentioned ? phase === 0 ? 200 : 1800 : phase === 0 ? 40 : 360, phase === 1, unmentioned);
            const historyMessages = phase === 0 ? 1000 : 10000;
            const count = Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM messages'))!.count);
            assert.equal(count, historyMessages + phase * 6);
            assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM agents'))!.count), 3);
            assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM projects'))!.count), 5);
            assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM groups'))!.count), 25);
            assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM members WHERE removed_at IS NULL'))!.count), 15);
            assert.equal(Number((await repos.context.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM group_participants'))!.count), 75);
            const byteLength = db.kind === 'postgres' ? 'OCTET_LENGTH(body)' : 'LENGTH(CAST(body AS BLOB))';
            const storedBodyBytes = Number((await repos.context.one<{ bytes: number | string }>(`SELECT SUM(${byteLength}) AS bytes FROM messages`))!.bytes);
            assert.ok(storedBodyBytes >= cumulativeBytes && storedBodyBytes - cumulativeBytes < 1024);
            if (phase === 1) assert.ok(cumulativeBytes > 5 * 1024 * 1024, '第二档确有多 MiB 正文，不能只增加行数');
            report.phases.push({ historyMessages, historicalDeliveryRows: unmentioned ? 0 : historyMessages * 3, historicalBodyBytes: cumulativeBytes, storedBodyBytes,
              historicalGroups: unmentioned ? 5 : 25, waitUsesAfterCursor: !unmentioned, priorProtocolMessages: phase * 6 });
            // 每档使用不同群、各六次消息，遵守默认连续自动回复上限，不改阈值、不 reset。
            const group = target.groups[phase]!;
            const sender = await clientFor(db, 'Load A', target.project.id, group.id);
            const receiver = await clientFor(db, 'Load B', target.project.id, group.id);
            // 第三个全局 Agent 的其他项目实例在运行；移除不会跨项目停掉它。
            const heart = await clientFor(db, 'Load C', survivor.project.id, survivor.groups[phase]!.id);
            assert.equal(sender.joined['memberId'], target.members[0]!.id); assert.equal(receiver.joined['memberId'], target.members[1]!.id);
            const facts = await repos.members.retainedFacts(targetId);
            let cursor = `c_${Number((await repos.context.one<{ seq: number | string }>('SELECT MAX(seq) AS seq FROM messages WHERE group_id = ?', [group.id]))!.seq)}`;
            let previousAuditId: string | undefined;
            try {
              for (let step = 0; step < 6; step++) {
                const waitStarted = performance.now();
                const waiting = receiver.call('wait_for_messages', { ...(unmentioned ? {} : { afterCursor: cursor }), timeoutMs: 1900 });
                const budget = new MeasuredBudget();
                const operation = step === 0 ? 'remove' : step % 2 === 1 ? 'undo/restore' : 'redo/remove';
                const mutation = budget.run(async () => {
                  const result = previousAuditId === undefined
                    ? await service.removeMember(access, target.project.id, targetId)
                    : await compensation.revoke(access, target.project.id, previousAuditId);
                  return { auditId: 'auditId' in result ? result.auditId : result.id, measurement: budget.measure() };
                });
                const heartbeatStarted = performance.now();
                const heartbeat = heart.call('heartbeat', {}).then(payload => ({ payload, elapsedMs: rounded(performance.now() - heartbeatStarted) }));
                const sendStarted = performance.now();
                const traffic = (async () => {
                  const sent = await sender.call('send_message', { text: `实时负载 ${historyMessages}/${step}`, mentions: [target.members[1]!.id] });
                  const sendMs = rounded(performance.now() - sendStarted);
                  const delivered = await waiting;
                  const deliveryMs = rounded(performance.now() - waitStarted);
                  assert.equal(delivered['status'], 'message', '合法范围内消息必须实际投递');
                  const messages = delivered['messages'] as Array<{ id: string; text: string }>;
                  assert.equal(messages.length, 1); assert.equal(messages[0]!.id, sent['messageId']);
                  assert.equal(messages[0]!.text, `实时负载 ${historyMessages}/${step}`);
                  const ackStarted = performance.now();
                  const acknowledged = await receiver.call('acknowledge_message', { messageId: sent['messageId'] });
                  const ackMs = rounded(performance.now() - ackStarted), sendToAckMs = rounded(performance.now() - sendStarted);
                  assert.equal(acknowledged['alreadyAcknowledged'], false);
                  return { messageId: sent['messageId'] as string, cursor: delivered['cursor'] as string, sendMs, deliveryMs, ackMs, sendToAckMs };
                })();
                const settled = await Promise.allSettled([mutation, heartbeat, traffic] as const);
                const failure = settled.find(result => result.status === 'rejected');
                if (failure?.status === 'rejected') {
                  report.operations.push({ historyMessages, step, operation, status: 'FAIL', mutation: budget.measure(), error: String(failure.reason) });
                  throw failure.reason;
                }
                const [changed, beat, chat] = settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as [Awaited<typeof mutation>, Awaited<typeof heartbeat>, Awaited<typeof traffic>];
                previousAuditId = changed.auditId; cursor = chat.cursor;
                const observation = { historyMessages, step, operation, mutation: changed.measurement, heartbeatMs: beat.elapsedMs, traffic: chat };
                report.operations.push({ ...observation, sqlTrace: budget.statements }); t.diagnostic(JSON.stringify(observation));
                assert.ok(changed.measurement.elapsedMs <= 500, `第 ${phase}/${step} 次 ${operation} ${changed.measurement.elapsedMs}ms >500ms`);
                assert.ok(chat.deliveryMs <= 2000 && chat.ackMs <= 2000 && chat.sendToAckMs <= 2000, `第 ${phase}/${step} 次投递/ACK超出2秒`);
                assert.ok(beat.elapsedMs <= 2000); assert.equal(beat.payload['state'], 'connected');
                assert.ok(!budget.statements.some(sql => /\bFROM\s+(messages|message_deliveries)\b/i.test(sql)), '补偿不能扫描历史消息/投递');
                assert.ok(budget.statements.filter(sql => /FROM\s+member_fact_revisions\b/i.test(sql)).every(sql => /LIMIT\s+7/i.test(sql)), '每次事实采集固定六类并保留一行异常哨兵');
                assert.ok(changed.measurement.retainedFactReads > 0);
                const stored = await repos.deliveries.get(chat.messageId, target.members[1]!.id);
                assert.equal(stored?.status, 'acked'); assert.ok(stored?.firstMcpDeliveredAt);
                assert.deepEqual(await repos.members.retainedFacts(targetId), facts, '非目标聊天不得改变被移除身份的历史事实');
                const current = await repos.members.getIncludingRemoved(targetId);
                assert.equal(Boolean(current?.removedAt), step % 2 === 0);
                assert.equal((await repos.groups.participants(group.id)).includes(targetId), step % 2 !== 0);
                assert.equal((await repos.tasks.getSettings(target.project.id)).defaultReviewerMemberId, step % 2 !== 0 ? targetId : null);
              }
            } finally { await sender.close(); await receiver.close(); await heart.close(); }
          }
        }, engine);
        report.status = 'PASS';
      } catch (error) { report.status = 'FAIL'; report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); throw error; }
      finally {
        const directory = path.resolve('.agent-output/lifecycle-load');
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${engine}${unmentioned ? '-unmentioned-history' : ''}.json`), `${JSON.stringify(report, null, 2)}\n`);
      }
    });
 }
}

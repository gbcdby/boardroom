import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client as PgClient } from 'pg';
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

type LoadBranch = 'wait' | 'mutation' | 'heartbeat' | 'traffic';
type LoadOrigin = { branch: LoadBranch; historyMessages: number; step: number; branchId: number };
type QueryCategory = 'begin' | 'commit' | 'rollback' | 'rollback-savepoint' | 'savepoint' | 'release-savepoint'
  | 'project-lock' | 'lock-timeout-100' | 'lock-timeout-200' | 'statement-timeout-200' | 'statement-timeout-250' | 'other';
type DiagnosticEvent = {
  event: 'query-start' | 'query-end' | 'query-end-unobserved' | 'branch-start' | 'branch-end';
  origin?: LoadOrigin; queryId?: number; clientId?: number; backendPid?: number | null; category?: QueryCategory;
  outcome?: 'fulfilled' | 'rejected' | 'sync-throw'; elapsedMs?: number; sqlState?: string | null;
};
type QueryObservation = { startedAt: number; data: DiagnosticEvent; custom: boolean };

/** 仅此接受门的被动 last-N 观察；不是 PG 锁图，也不把异步来源认定为锁拥有者。 */
class LoadDiagnostics {
  private readonly origin = new AsyncLocalStorage<LoadOrigin>();
  private readonly clients = new WeakMap<object, number>();
  private readonly events: Array<{ value: DiagnosticEvent & { sequence: number; atMs: number }; bytes: number }> = [];
  private readonly startedAt = performance.now();
  private readonly wallStartedAt = new Date().toISOString();
  private head = 0; private count = 0; private bytes = 0; private sequence = 0;
  private queryId = 0; private clientId = 0; private branchId = 0;
  private dropped = 0; private errors = 0; private unobservedEnds = 0;
  private readonly maxEvents = 4096;
  private readonly maxBytes = 4 * 1024 * 1024;
  private record(data: DiagnosticEvent): void {
    try {
      const value = { ...data, sequence: ++this.sequence, atMs: rounded(performance.now() - this.startedAt) };
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > this.maxBytes) { this.dropped++; return; }
      while (this.count && (this.count === this.maxEvents || this.bytes + bytes > this.maxBytes)) {
        this.bytes -= this.events[this.head]!.bytes; this.head = (this.head + 1) % this.maxEvents;
        this.count--; this.dropped++;
      }
      this.events[(this.head + this.count) % this.maxEvents] = { value, bytes }; this.count++; this.bytes += bytes;
    } catch { this.errors++; }
  }
  private state(error: unknown): string | null {
    try {
      const code: unknown = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
      return code === '55P03' || code === '57014' || code === '40P01' || code === '25P02' ? code : null;
    } catch { return null; }
  }
  private start(client: object, input: unknown): QueryObservation | undefined {
    try {
      const text: unknown = typeof input === 'string' ? input
        : input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'text')?.value : undefined;
      const sql = typeof text === 'string' ? text.slice(0, 256).trim() : '';
      let category: QueryCategory = 'other';
      if (/^BEGIN\b/i.test(sql)) category = 'begin';
      else if (/^COMMIT\b/i.test(sql)) category = 'commit';
      else if (/^ROLLBACK TO\b/i.test(sql)) category = 'rollback-savepoint';
      else if (/^ROLLBACK\b/i.test(sql)) category = 'rollback';
      else if (/^SAVEPOINT\b/i.test(sql)) category = 'savepoint';
      else if (/^RELEASE SAVEPOINT\b/i.test(sql)) category = 'release-savepoint';
      else if (/^UPDATE projects SET updated_at = updated_at WHERE id = /i.test(sql)) category = 'project-lock';
      else if (/^SET LOCAL lock_timeout = '100ms'$/i.test(sql)) category = 'lock-timeout-100';
      else if (/^SET LOCAL lock_timeout = '200ms'$/i.test(sql)) category = 'lock-timeout-200';
      else if (/^SET LOCAL statement_timeout = '200ms'$/i.test(sql)) category = 'statement-timeout-200';
      else if (/^SET LOCAL statement_timeout = '250ms'$/i.test(sql)) category = 'statement-timeout-250';
      let clientId = this.clients.get(client);
      if (clientId === undefined) { clientId = ++this.clientId; this.clients.set(client, clientId); }
      const pid: unknown = Object.getOwnPropertyDescriptor(client, 'processID')?.value;
      const origin = this.origin.getStore();
      const data: DiagnosticEvent = { event: 'query-start', queryId: ++this.queryId, clientId, category,
        backendPid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        ...(origin ? { origin } : {}) };
      const custom = Boolean(input && typeof input === 'object' && typeof Object.getOwnPropertyDescriptor(input, 'submit')?.value === 'function');
      const observed = { startedAt: performance.now(), data, custom }; this.record(data); return observed;
    } catch { this.errors++; return undefined; }
  }
  private end(observed: QueryObservation | undefined, outcome: NonNullable<DiagnosticEvent['outcome']>, error?: unknown): void {
    try {
      if (observed) this.record({ ...observed.data, event: 'query-end', outcome,
        elapsedMs: rounded(performance.now() - observed.startedAt), sqlState: this.state(error) });
    } catch { this.errors++; }
  }
  wrapQuery(original: typeof PgClient.prototype.query): typeof PgClient.prototype.query {
    const trace = this;
    return function(this: PgClient, ...args: unknown[]) {
      const observed = trace.start(this, args[0]);
      let result: unknown;
      try { result = Reflect.apply(original, this, args); }
      catch (error) { trace.end(observed, 'sync-throw', error); throw error; }
      // Do not replace callback/config arguments or custom Query objects. The
      // ordinary driver's native Promise is observed without replacing it.
      try {
        if (result instanceof Promise && !observed?.custom) {
          void Promise.prototype.then.call(result, () => trace.end(observed, 'fulfilled'), (error: unknown) => trace.end(observed, 'rejected', error));
        } else {
          trace.unobservedEnds++;
          if (observed) trace.record({ ...observed.data, event: 'query-end-unobserved' });
        }
      } catch { trace.errors++; }
      return result;
    } as typeof PgClient.prototype.query;
  }
  run<T>(branch: LoadBranch, historyMessages: number, step: number, body: () => Promise<T>): Promise<T> {
    const origin = { branch, historyMessages, step, branchId: ++this.branchId }, startedAt = performance.now();
    try { this.record({ event: 'branch-start', origin }); } catch { this.errors++; }
    const finish = (outcome: NonNullable<DiagnosticEvent['outcome']>, error?: unknown) => {
      try { this.record({ event: 'branch-end', origin, outcome, elapsedMs: rounded(performance.now() - startedAt), sqlState: this.state(error) }); }
      catch { this.errors++; }
    };
    let result: Promise<T>;
    try { result = this.origin.run(origin, body); }
    catch (error) { finish('sync-throw', error); throw error; }
    try { void Promise.prototype.then.call(result, () => finish('fulfilled'), (error: unknown) => finish('rejected', error)); }
    catch { this.errors++; }
    return result;
  }
  snapshot() {
    try {
      const events = Array.from({ length: this.count }, (_, index) => this.events[(this.head + index) % this.maxEvents]!.value);
      return { schema: 'load-pg-query-observation/v1', wallStartedAt: this.wallStartedAt,
        maxEvents: this.maxEvents, maxBytes: this.maxBytes, retainedBytes: this.bytes, dropCount: this.dropped,
        diagnosticErrors: this.errors, unobservedQueryEnds: this.unobservedEnds,
        firstRetainedAtMs: events[0]?.atMs ?? null, observedUntilMs: rounded(performance.now() - this.startedAt),
        semantics: 'client query elapsed includes local queue/network/server; origin is inherited ancestry, not lock ownership; callback/custom/non-Promise ends are unobserved; pre-query gaps unattributed; no lock graph', events };
    } catch { return { schema: 'load-pg-query-observation/v1', diagnosticUnavailable: true, diagnosticErrors: ++this.errors }; }
  }
}

/** No MockTracker: its per-call history would retain SQL parameters/results. */
function installLoadQueryDiagnostics(diagnostics: LoadDiagnostics): () => void {
  const original = Object.getOwnPropertyDescriptor(PgClient.prototype, 'query');
  assert.ok(original && typeof original.value === 'function', 'pg query must be an own data method');
  const installed = { ...original, value: diagnostics.wrapQuery(original.value as typeof PgClient.prototype.query) };
  Object.defineProperty(PgClient.prototype, 'query', installed);
  return () => {
    assert.deepEqual(Object.getOwnPropertyDescriptor(PgClient.prototype, 'query'), installed, 'pg query diagnostics installation owner changed');
    Object.defineProperty(PgClient.prototype, 'query', original);
  };
}

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
  await repos.tasks.create({ id: newId(), projectId: target.project.id, title: '固定负载下保留的指派', body: '正文不是补偿输入', deliveryKind: "code", acceptanceText: '正文不是补偿输入', acceptanceSource: "explicit", labels: [], state: 'in-progress',
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
      const diagnostics = engine === 'postgres' ? new LoadDiagnostics() : undefined;
      // after runs even if the body/report fails, preserving the original body
      // error when restoration also fails. There is only one hook per test.
      if (diagnostics) t.after(installLoadQueryDiagnostics(diagnostics));
      const report = { schemaVersion: 1, engine, profile, node: process.version, platform: process.platform, transport: 'MCP SDK InMemoryTransport',
        limits: { mutationMs: 500, deliveryAndAckMs: 2000 }, status: 'RUNNING', error: null as string | null,
        fixture: { agents: 3, projects: 5, groupsPerProject: 5, membersPerGroup: 3, messageBodiesAreFixtureData: true },
        measurements: { sql: '实际 RepoCtx 查询/写入与 coordinator 锁语句；不含 driver 的 BEGIN/COMMIT/SAVEPOINT 控制语句',
          bytes: '实际返回行 JSON 表示的 UTF-8 字节；不是数据库协议线上的传输字节',
          stages: '等待首个项目锁；capture/verify 直到完整计划通过；apply/readback/audit 直到真实事务返回',
          failureTiming: '失败 mutation.elapsedMs 保留原 allSettled 后采样；query/branch 失败瞬间另见 pgDiagnostics；allSettledElapsedMs 是各支路整体等待' },
        scope: '组织/成员补偿与同库真实 MCP 消息、ACK、心跳；不含 HTTP、DOM、macOS 或原生模型',
        pgDiagnostics: null as ReturnType<LoadDiagnostics['snapshot']> | null,
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
                const stepStarted = performance.now();
                const observed = <T>(branch: LoadBranch, body: () => Promise<T>): Promise<T> =>
                  diagnostics ? diagnostics.run(branch, historyMessages, step, body) : body();
                const waitStarted = performance.now();
                const waiting = observed('wait', () => receiver.call('wait_for_messages', { ...(unmentioned ? {} : { afterCursor: cursor }), timeoutMs: 1900 }));
                const budget = new MeasuredBudget();
                const operation = step === 0 ? 'remove' : step % 2 === 1 ? 'undo/restore' : 'redo/remove';
                const mutation = observed('mutation', () => budget.run(async () => {
                  const result = previousAuditId === undefined
                    ? await service.removeMember(access, target.project.id, targetId)
                    : await compensation.revoke(access, target.project.id, previousAuditId);
                  return { auditId: 'auditId' in result ? result.auditId : result.id, measurement: budget.measure() };
                }));
                const heartbeatStarted = performance.now();
                const heartbeat = observed('heartbeat', () => heart.call('heartbeat', {}).then(payload => ({ payload, elapsedMs: rounded(performance.now() - heartbeatStarted) })));
                const sendStarted = performance.now();
                const traffic = observed('traffic', async () => {
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
                });
                const settled = await Promise.allSettled([mutation, heartbeat, traffic] as const);
                const allSettledElapsedMs = rounded(performance.now() - stepStarted);
                const failure = settled.find(result => result.status === 'rejected');
                if (failure?.status === 'rejected') {
                  report.operations.push({ historyMessages, step, operation, status: 'FAIL', mutation: budget.measure(),
                    sqlTrace: budget.statements, allSettledElapsedMs,
                    settled: settled.map((result, index) => ({ branch: ['mutation', 'heartbeat', 'traffic'][index], status: result.status })),
                    error: String(failure.reason) });
                  throw failure.reason;
                }
                const [changed, beat, chat] = settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as [Awaited<typeof mutation>, Awaited<typeof heartbeat>, Awaited<typeof traffic>];
                previousAuditId = changed.auditId; cursor = chat.cursor;
                const observation = { historyMessages, step, operation, mutation: changed.measurement, heartbeatMs: beat.elapsedMs, traffic: chat, allSettledElapsedMs };
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
        report.pgDiagnostics = diagnostics?.snapshot() ?? null;
        const directory = path.resolve('.agent-output/lifecycle-load');
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${engine}${unmentioned ? '-unmentioned-history' : ''}.json`), `${JSON.stringify(report, null, 2)}\n`);
      }
    });
 }
}

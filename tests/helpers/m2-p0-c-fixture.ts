import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createServer } from 'node:http';
import { M2_HISTORY_TABLES, type HistoryObservationInput, type RawCell } from '../../src/server/identity/m2-history-contracts.ts';
import { identityFixture } from './identity-fixture.ts';
import { decisionDomainFixture } from './decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../../src/server/policy/configuration.ts';
import { createDecisionService } from '../../src/server/decisions/service.ts';
import { actorForMember } from '../../src/server/authz/actors.ts';
import { createTaskService } from '../../src/server/tasks/service.ts';
import { createOrgMutationService } from '../../src/server/org/mutations.ts';
import { createAuditCompensationService } from '../../src/server/audit-compensation.ts';
import type { LiveDecisionView } from '../../src/shared/decisions.ts';
import { createTaskApi } from '../../src/server/tasks/api.ts';
import { createLogger } from '../../src/server/logger.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ref = (name: string) => ({ ref: `family-fixture/${name}`, bytes: '1', sha256: sha(name) });
export interface P0CInput {
  contract: 'm2-history-closure-input/r2';
  graph: { kind: 'm2-observation'; observation: HistoryObservationInput; origin: null };
  artifacts: []; evidence: []; proposedDeletion: null;
}

/** Captures all actual SQLite cell classes and TEXT bytes. Selection metadata is
 * deliberately only a family test carrier, never an artifact/provenance proof. */
export function captureP0CInput(databasePath: string): P0CInput {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const tables = M2_HISTORY_TABLES.filter(table => table.columnsP0.length).map(table => {
      const columns = table.columnsP0.map(column => column.name);
      const projection = columns.flatMap(column => [`typeof("${column}")`, `"${column}"`, `hex(CAST("${column}" AS BLOB))`]);
      const rows = sqlite.prepare(`SELECT rowid,${projection.join(',')} FROM "${table.name}" ORDER BY rowid`).raw().safeIntegers().all() as unknown[][];
      return { name: table.name, columnContract: ref(table.name), columnContractValueDigest: sha(`${table.name}/columns`), columns,
        count: String(rows.length), rows: rows.map(row => ({ rowid: String(row[0]), cells: columns.map((_, i): RawCell => {
          const [kind, value, hex] = row.slice(1 + i * 3, 4 + i * 3);
          if (kind === 'null') return ['null'];
          if (kind === 'integer') return ['integer', String(value)];
          if (kind === 'text') return ['text', (hex as string).toLowerCase()];
          if (kind === 'blob') return ['blob', (hex as string).toLowerCase()];
          assert.equal(kind, 'real'); const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value as number); return ['real64be', bytes.toString('hex')];
        }) })) };
    });
    return { contract: 'm2-history-closure-input/r2', graph: { kind: 'm2-observation', origin: null,
      observation: { contract: 'm2-history-observation/r1', backend: 'sqlite', phase: 'p0', configFormat: 1,
        source: { kind: 'sqlite', databaseInstanceId: '1'.repeat(32), identityDigest: sha('family-source') },
        physicalSourceRef: { artifactId: 'family-physical', digest: sha('family-physical') },
        snapshotReceiptRef: { artifactId: 'family-snapshot', digest: sha('family-snapshot') },
        catalog: ref('catalog'), textEncoding: { backend: 'sqlite', name: 'UTF-8' }, tables, sequences: [] } },
      artifacts: [], evidence: [], proposedDeletion: null };
  } finally { sqlite.close(); }
}

export function p0CValue(input: P0CInput, table: string, ordinal: number, column: string): string | number | null {
  const selected = input.graph.observation.tables.find(value => value.name === table)!;
  const cell = selected.rows[ordinal]!.cells[selected.columns.indexOf(column)]!;
  if (cell[0] === 'null') return null;
  if (cell[0] === 'integer') return Number(cell[1]);
  assert.equal(cell[0], 'text'); return Buffer.from(cell[1]!, 'hex').toString('utf8');
}
export function setP0CValue(input: P0CInput, table: string, ordinal: number, column: string, value: string | number | null): void {
  const selected = input.graph.observation.tables.find(value => value.name === table)!;
  selected.rows[ordinal]!.cells[selected.columns.indexOf(column)] = value === null ? ['null']
    : typeof value === 'number' ? ['integer', String(value)] : ['text', Buffer.from(value).toString('hex')];
}
export function p0CRows(input: P0CInput, table: string): Record<string, string | number | null>[] {
  const selected = input.graph.observation.tables.find(value => value.name === table)!;
  return selected.rows.map((_, ordinal) => Object.fromEntries(selected.columns.map(column => [column, p0CValue(input, table, ordinal, column)])));
}
export function appendP0CRow(input: P0CInput, table: string, row: Readonly<Record<string, unknown>>): void {
  const selected = input.graph.observation.tables.find(value => value.name === table)!;
  const rowid = selected.rows.reduce((max, value) => {
    assert.ok(value.rowid !== null, 'C fixture append uses its real SQLite source');
    return BigInt(value.rowid) > max ? BigInt(value.rowid) : max;
  }, 0n) + 1n;
  assert.deepEqual(Object.keys(row).sort(), [...selected.columns].sort());
  selected.rows.push({ rowid: String(rowid), cells: selected.columns.map((column): RawCell => {
    const value = row[column];
    if (value === null) return ['null'];
    if (typeof value === 'number') { assert.ok(Number.isSafeInteger(value)); return ['integer', String(value)]; }
    assert.equal(typeof value, 'string'); return ['text', Buffer.from(value as string).toString('hex')];
  }) });
  selected.count = String(selected.rows.length);
}

export async function makeP0CPendingFixture() {
  const fixture = await identityFixture('sqlite');
  try {
    await initializePolicyConfiguration(fixture.repos);
    const source = await decisionDomainFixture(fixture.repos);
    return { ...fixture, source, input: captureP0CInput(path.join(fixture.dir, 'agent-studio.db')) };
  } catch (error) { await fixture.close(); throw error; }
}

/** Real Task/Decision/member producers; only external review execution evidence
 * is declared synthetic by the existing domain fixture. No fake repository. */
export async function makeP0CFixture(options: { lifecycle?: boolean } = {}) {
  const fixture = await identityFixture('sqlite');
  try {
    await initializePolicyConfiguration(fixture.repos);
    const source = await decisionDomainFixture(fixture.repos);
    const decisions = createDecisionService(fixture.db, { now: () => new Date('2026-11-19T00:02:00.000Z') });
    const live = (await decisions.list(source.owner, source.project.id)).decisions.find(value => value.recordKind === 'live-review-decision') as LiveDecisionView;
    assert.ok(live);
    const resolved = await decisions.resolve({ actor: actorForMember(source.manager) }, source.project.id, live.ref.decisionId,
      { decisionRef: live.ref, choiceId: 'approve', reason: '完整固定候选', idempotencyKey: 'p0-c-complete' });
    await source.service.comment(source.owner, source.project.id, source.task.id, '历史注释');
    const group = await fixture.repos.groups.create({ projectId: source.project.id, name: '保留消息关联', participantMemberIds: [source.worker.id] });
    const message = await fixture.repos.messages.create({ groupId: group.id, senderMemberId: source.worker.id, body: '历史消息' });
    await source.service.linkMessage(source.owner, source.project.id, source.task.id, message.id);
    let current = (await fixture.repos.tasks.get(source.project.id, source.task.id))!;
    current = await source.service.transition(source.owner, source.project.id, source.task.id,
      { expectedRevision: current.revision, state: 'todo', reason: '验证不可变完成事实不依赖当前状态' });
    await source.service.update(source.owner, source.project.id, source.task.id, { expectedRevision: current.revision, title: '后续标题' });
    let unfinished = await source.service.create(source.owner, source.project.id, { title: '失败轮次与生命周期', body: '候选读取失败保持历史',
      deliveryKind: 'code', acceptanceText: '保留失败原因', assigneeMemberId: source.worker.id, reviewerMemberId: source.reviewer.id,
      repoPath: '/declared-fixture', fixedPoint: 'base' });
    unfinished = await source.service.transition(source.workerAccess, source.project.id, unfinished.id, { expectedRevision: unfinished.revision, state: 'in-progress' });
    const failing = createTaskService({ repos: fixture.repos, captureCandidate: async () => { throw new Error('declared fixture capture failure'); },
      now: () => new Date('2026-11-19T00:03:00.000Z') });
    const failed = await failing.startReview(source.workerAccess, source.project.id, unfinished.id, { expectedRevision: unfinished.revision });
    assert.equal(failed.ready, false);
    unfinished = await source.service.transition(source.workerAccess, source.project.id, unfinished.id,
      { expectedRevision: unfinished.revision, state: 'blocked', reason: '已声明的阻塞' });
    if (options.lifecycle) {
      const removed = await createOrgMutationService({ repos: fixture.repos }).removeMember(source.owner, source.project.id, source.worker.id);
      await createAuditCompensationService({ repos: fixture.repos }).revoke(source.owner, source.project.id, removed.auditId);
    }
    return { ...fixture, source, resolved, unfinished, input: captureP0CInput(path.join(fixture.dir, 'agent-studio.db')) };
  } catch (error) { await fixture.close(); throw error; }
}

/** Uses an actual loopback HTTP request to the production UI adapter. No forged
 * TrustedLocalDecisionRequest or caller-provided provenance is constructed. */
export async function makeP0CHumanFixture(choiceId: 'approve' | 'reject' | 'request_changes' = 'approve') {
  const fixture = await identityFixture('sqlite');
  let closeHttp: (() => Promise<void>) | undefined;
  try {
    await initializePolicyConfiguration(fixture.repos); const source = await decisionDomainFixture(fixture.repos);
    const decisions = createDecisionService(fixture.db);
    const live = (await decisions.list(source.owner, source.project.id)).decisions[0] as LiveDecisionView;
    const api = createTaskApi({ db: fixture.db, logger: createLogger({ write: () => {} }) });
    const server = createServer((request, response) => {
      void api.handle(request, response, new URL(request.url ?? '/', 'http://127.0.0.1').pathname).then(handled => {
        if (!handled) { response.statusCode = 404; response.end(); }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    closeHttp = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${source.project.id}/decisions/${live.ref.decisionId}/choices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionRef: live.ref, choiceId, reason: '声明为测试的真实本地请求', clientMutationId: `p0-c-${choiceId}` }),
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    await closeHttp(); closeHttp = undefined;
    return { ...fixture, source, result, input: captureP0CInput(path.join(fixture.dir, 'agent-studio.db')) };
  } catch (error) { await closeHttp?.(); await fixture.close(); throw error; }
}

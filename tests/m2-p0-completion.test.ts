import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DECISION_TABLES } from '../src/server/decisions/tables.ts';
import { canonicalJson } from '../src/server/policy/canonical.ts';
import { validateDecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';
import { validateWorkEventInvalidations } from '../src/server/tasks/work-event-storage.ts';
import { StorageInvalid, getStorageInvalidIdentity, withStorageInvalidRow } from '../src/server/decisions/storage-error.ts';
import { WorkEventStorageInvalid, getWorkEventStorageInvalidIdentity } from '../src/server/tasks/work-event-storage.ts';
import { storageFixture } from './helpers/decisions-fixture.mjs';

test('P0 consumer errors preserve their original identity without inspecting unknown throws', () => {
  let reads = 0;
  const unknown = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
  for (const value of [unknown, null, undefined, 1, 'secret', Symbol('secret'), () => {}]) {
    assert.equal(getStorageInvalidIdentity(value), undefined);
    assert.equal(getWorkEventStorageInvalidIdentity(value), undefined);
  }
  assert.equal(reads, 0);
  assert.equal(getStorageInvalidIdentity(Object.create(StorageInvalid.prototype)), undefined);
  assert.equal(getWorkEventStorageInvalidIdentity(Object.create(WorkEventStorageInvalid.prototype)), undefined);
  const decision = new StorageInvalid('decision_executions', 'completion_binding');
  const work = new WorkEventStorageInvalid('incomplete_closure');
  assert.equal(decision.message, 'decision_storage_invalid:decision_executions:completion_binding');
  assert.equal(work.message, 'work_event_storage_invalid:incomplete_closure');
  Object.defineProperty(decision, 'stage', { value: 'changed' });
  Object.defineProperty(work, 'stage', { get() { reads++; throw null; } });
  assert.deepEqual(getStorageInvalidIdentity(decision), { column: 'decision_executions', stage: 'completion_binding' });
  assert.deepEqual(getWorkEventStorageInvalidIdentity(work), { stage: 'incomplete_closure' });
  assert.equal(Object.isFrozen(getStorageInvalidIdentity(decision)), true);
  assert.equal(Object.isFrozen(getWorkEventStorageInvalidIdentity(work)), true);
  assert.equal(reads, 0);
});

test('trusted row metadata retains the innermost actual object and leaves unknown throws untouched', () => {
  const inner = Object.freeze({ id: 'inner' }), outer = Object.freeze({ id: 'outer' });
  const error = new StorageInvalid('decision_records.status', 'terminal_graph_incomplete');
  assert.throws(() => withStorageInvalidRow(outer, () => withStorageInvalidRow(inner, () => { throw error; })), value => value === error);
  assert.equal(getStorageInvalidIdentity(error)?.row, inner);
  let reads = 0;
  const hostile = new Proxy({}, { get() { reads++; throw null; }, getPrototypeOf() { reads++; throw null; } });
  assert.throws(() => withStorageInvalidRow(outer, () => { throw hostile; }), value => value === hostile);
  assert.equal(reads, 0);
});

test('real graph and nested Decision binding failures retain the failing source row', () => {
  const first = storageFixture('first', 'one').graph, second = storageFixture('second', 'two').graph;
  const graph = Object.fromEntries(Object.keys(first).map(table => [table, [...first[table]!, ...second[table]!]]));
  validateDecisionStorageGraph(graph);
  const record = graph.decision_records![1]!;
  record.status = 'pending';
  assert.throws(() => validateDecisionStorageGraph(graph), error => {
    const identity = getStorageInvalidIdentity(error);
    return identity?.stage === 'terminal_graph_incomplete' && identity.row === record;
  });
  record.status = 'resolved';
  const action = graph.decision_action_requests![1]!, report = graph.task_review_reports![2]!;
  report.body = 'different';
  assert.throws(() => validateDecisionStorageGraph(graph), error => {
    const identity = getStorageInvalidIdentity(error);
    return identity?.stage === 'content_digest' && identity.row === action;
  });
  const event = { id: 'event', recipient_member_id: 'member' };
  assert.throws(() => validateWorkEventInvalidations({ members: [{ id: 'member', removed_at: 'removed' }], work_events: [event] }), error => {
    const identity = getWorkEventStorageInvalidIdentity(error);
    return identity?.stage === 'removed_member_unmarked_event' && identity.row === event;
  });
});

test('legacy consumer catch paths do not inspect a hostile JSON parser exception', () => {
  const originalParse = JSON.parse;
  let probes = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { probes++; throw null; }, get() { probes++; throw null; } });
  const source = { id: 'h', project_id: 'p', task_id: 't', detail: '{}' };
  const raw = canonicalJson(source);
  const graph: Record<string, Record<string, unknown>[]> = Object.fromEntries(DECISION_TABLES.map(table => [table.name, []]));
  graph.projects = [{ id: 'p' }]; graph.tasks = [{ id: 't', project_id: 'p' }]; graph.task_history = [source];
  graph.decision_legacy_records = [{ id: 'l', project_id: 'p', task_id: 't', round_id: null,
    source_table: 'task_history', source_id: 'h', raw_text: raw, raw_digest: createHash('sha256').update(raw).digest('hex'),
    chain_status: 'malformed', diagnostics_json: '["decision_invalid"]', imported_at: '2026-11-19T00:00:00.000Z' }];
  try {
    JSON.parse = ((text: string, ...args: unknown[]) => {
      if (text === raw || text === 'hostile-before') throw hostile;
      return originalParse(text, ...(args as []));
    }) as typeof JSON.parse;
    assert.throws(() => validateDecisionStorageGraph(graph), value => getStorageInvalidIdentity(value)?.stage === 'json');
    assert.throws(() => validateWorkEventInvalidations({ projects: [{ id: 'p' }],
      members: [{ id: 'm', project_id: 'p', membership_revision: 2, removed_at: 'at' }],
      work_events: [{ id: 'e', project_id: 'p', recipient_member_id: 'm' }],
      audit_log: [{ id: 'a', project_id: 'p', scope: 'project', target_kind: 'member', target_id: 'm', action: 'member.remove', created_at: 'at', before: 'hostile-before' }],
      work_event_delivery_invalidations: [{ work_event_id: 'e', project_id: 'p', cause_member_id: 'm', cause_from_revision: 1,
        cause_to_revision: 2, cause_action: 'removed', cause_audit_id: 'a', invalidated_at: 'at' }],
    }), value => getWorkEventStorageInvalidIdentity(value)?.stage === 'audit_snapshot');
  } finally { JSON.parse = originalParse; }
  assert.equal(probes, 0);
});

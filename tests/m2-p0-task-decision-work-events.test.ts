import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chargeP0, createP0Request, p0Usage, retainP0Rows, withP0Guard } from '../src/server/identity/internal/m2-p0.ts';
import { checkP0TaskDecisionWorkEvents, P0_C_RULES } from '../src/server/identity/internal/m2-p0-task-decision-work-events.ts';
import { lookupP0CompletionSource } from '../src/server/identity/internal/m2-p0-completion.ts';
import { planLegacyImport } from '../src/server/decisions/legacy.ts';
import { assertDecisionDecodedFrame, createDecisionDecodedFrame, decodeDecisionRow, validateCopyRow } from '../src/server/decisions/text-codec.ts';
import type { DecisionDecodedFrame } from '../src/server/decisions/text-codec.ts';
import { validateDecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';
import type { DecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';
import { getStorageInvalidIdentity } from '../src/server/decisions/storage-error.ts';
import { assertP0CStorageSyntaxFrame, createP0CStorageSyntaxFrame, p0CAuditDetailUnavailable, P0CContext } from '../src/server/identity/internal/m2-p0-c-shadow.ts';
import type { P0CStorageSyntaxFrame } from '../src/server/identity/internal/m2-p0-c-shadow.ts';
import { validateWorkEventInvalidations } from '../src/server/tasks/work-event-storage.ts';
import { canonicalJson } from '../src/server/policy/canonical.ts';
import type { P0Request, P0Result, P0Rule, P0View } from '../src/server/identity/internal/m2-p0.ts';
import { appendP0CRow, makeP0CFixture, makeP0CHumanFixture, makeP0CPendingFixture, p0CRows, p0CValue, setP0CValue, type P0CInput } from './helpers/m2-p0-c-fixture.ts';

let input: P0CInput;
before(async () => { const f = await makeP0CFixture({ lifecycle: true }); input = f.input; await f.close(); });
after(() => { /* Fixture owns and closes its real SQLite source before value checks. */ });
function ok<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function request(value = input): P0Request { return ok(createP0Request(JSON.stringify(value))); }
function rejected(result: P0Result<unknown>, rule?: P0Rule): void {
  assert.equal(result.ok, false); if (result.ok) return;
  assert.notEqual(result.error.code, 'resource_limit', 'A/runtime budgeting is not semantic evidence');
  if (rule) assert.equal(result.error.rule, rule);
  assert.ok(result.error.location, 'known family failure retains the original row location');
  assert.equal(/secret|payload|candidate|member-id/.test(JSON.stringify(result.error)), false, 'public errors contain no raw identifiers or values');
}
function ordinal(table: string, predicate: (row: Record<string, string | number | null>) => boolean): number {
  const found = p0CRows(input, table).findIndex(predicate); assert.notEqual(found, -1, table); return found;
}
function mutateJson(value: P0CInput, table: string, index: number, column: string, mutate: (object: Record<string, any>) => void): void {
  const object = JSON.parse(p0CValue(value, table, index, column) as string) as Record<string, any>;
  mutate(object); setP0CValue(value, table, index, column, JSON.stringify(object));
}

test('P0-C consumes the real Task/Decision/lifecycle graph and immutable completion after reopen', () => {
  const req = request(), before = JSON.stringify(req.input), observed = ok(checkP0TaskDecisionWorkEvents(req));
  assert.equal(observed.classification, 'task-decision-work-event-observation');
  assert.equal(observed.fullSemanticClosure, 'not-performed'); assert.deepEqual(observed.rules, P0_C_RULES); assert.equal(P0_C_RULES.length, 20);
  assert.equal(JSON.stringify(req.input), before);
  const event = req.original.rows('work_events')[ordinal('work_events', row => row.kind === 'task.review_decided')]!;
  const source = ok(withP0Guard(req, () => lookupP0CompletionSource(req, req.original, observed.completion, event)));
  assert.equal(source?.branch, 'decision'); assert.equal(source?.enteredDone, true); assert.equal(source?.invalidated, true);
  assert.ok(source?.execution); assert.ok(Object.isFrozen(source));
  const task = p0CRows(input, 'tasks').find(row => row.id === source?.taskId)!;
  assert.notEqual(task.state, 'done'); assert.ok(Number(task.revision) > source!.completionRevision!);
  const usage = p0Usage(req); assert.ok(usage.work > 0 && usage.bytes > 0 && usage.nodes > 0 && usage.tuples > 0);
});

test('completion index binds request, current view, and retained row identities', () => {
  const req = request(), observed = ok(checkP0TaskDecisionWorkEvents(req));
  const event = req.original.rows('work_events')[ordinal('work_events', row => row.kind === 'task.review_decided')]!;
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as typeof event.table));
  const retained = retainP0Rows(req, rows);
  const failed = withP0Guard(req, () => lookupP0CompletionSource(req, retained, observed.completion, event));
  assert.equal(failed.ok, false);
  const second = ok(checkP0TaskDecisionWorkEvents(req, retained));
  assert.equal(ok(withP0Guard(req, () => lookupP0CompletionSource(req, retained, second.completion, event)))?.branch, 'decision');
  const other = request();
  assert.equal(withP0Guard(other, () => lookupP0CompletionSource(other, other.original, observed.completion, event)).ok, false);
});

test('C rejects foreign and forged empty views before any view property or prototype read', () => {
  const req = request(), other = request();
  const forged = { phase: 'retained-graph', rowCount: 0, rows: () => [] } as unknown as P0View;
  assert.equal(checkP0TaskDecisionWorkEvents(req, forged).ok, false);
  assert.equal(checkP0TaskDecisionWorkEvents(req, other.original).ok, false);
  let probes = 0;
  const hostile = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; } }) as P0View;
  assert.equal(checkP0TaskDecisionWorkEvents(req, hostile).ok, false);
  assert.equal(probes, 0);
});

test('an unknown throw inside the real legacy codec produces only the fixed opaque error', () => {
  const changed = structuredClone(input), sentinel = '__p0_proxy_sentinel__';
  mutateJson(changed, 'decision_action_requests', 0, 'candidate_envelope_json', value => { value.task.labels = [sentinel]; });
  const req = request(changed), originalSort = Array.prototype.sort;
  let probes = 0, thrown = 0;
  const hostile = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; } });
  try {
    Array.prototype.sort = function(compare) {
      if (this.includes(sentinel)) { thrown++; throw hostile; }
      return originalSort.call(this, compare);
    };
    const result = checkP0TaskDecisionWorkEvents(req);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'invalid_value'); assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
  } finally { Array.prototype.sort = originalSort; }
  assert.equal(thrown, 1); assert.equal(probes, 0);
});

test('R2 actual legacy parser throws stay opaque across original and retained passes', () => {
  const changed = structuredClone(input), source: Record<string, string | number | null> = { ...p0CRows(input, 'task_history')[0]!, id: 'r2-legacy-diagnostics',
    action: 'task.review_decided', task_revision: 1, detail: '{invalid legacy detail' };
  const imported = planLegacyImport({ projectId: source.project_id as string, taskId: source.task_id as string,
    histories: [source], rounds: [], at: '2026-11-19T00:00:00.000Z', liveHistoryIds: new Set() });
  assert.equal(imported.rows.length, 1); appendP0CRow(changed, 'task_history', source); appendP0CRow(changed, 'decision_legacy_records', imported.rows[0]!);
  const audits = p0CRows(changed, 'audit_log');
  const markerAudit = audits.findIndex(row => typeof row.detail === 'string' && row.detail.includes('workEventInvalidations'));
  const displayAudit = audits.findIndex(row => typeof row.detail === 'string' && row.detail.length > 20 && !row.detail.includes('workEventInvalidations'));
  const liveHistory = p0CRows(changed, 'task_history').findIndex(row => row.action === 'task.review_decided' && typeof row.detail === 'string' && row.detail.includes('decisionRef'));
  const controls = [
    ['decision_action_requests', 0, 'candidate_envelope_json', '/decisions/text-codec.ts'],
    ['task_review_rounds', 0, 'spec_snapshot', '/decisions/storage-validation.ts'],
    ['task_review_reports', 0, 'sources', '/decisions/storage-validation.ts'],
    ['task_review_reports', 0, 'evidence', '/decisions/storage-validation.ts'],
    ['task_history', liveHistory, 'detail', '/decisions/storage-validation.ts'],
    ['decision_legacy_records', 0, 'diagnostics_json', '/decisions/row-validation.ts'],
    ['audit_log', markerAudit, 'before', '/tasks/work-event-storage.ts'],
    ['audit_log', displayAudit, 'detail', '/tasks/work-event-storage.ts'],
  ] as const;
  for (const phase of ['original', 'retained']) for (const [table, index, column, nativeConsumer] of controls) {
    assert.ok(index >= 0); const raw = p0CValue(changed, table, index, column); assert.equal(typeof raw, 'string');
    const req = request(changed); let view = req.original;
    if (phase === 'retained') {
      ok(checkP0TaskDecisionWorkEvents(req));
      view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks')));
    }
    const native = JSON.parse; let injections = 0, probes = 0;
    const poison = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; }, ownKeys() { probes++; throw null; } });
    let result: P0Result<unknown>;
    try {
      JSON.parse = function(text: string, ...rest: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never) {
        // A newly created Error is trusted diagnostic data. Its stack selects
        // the actual legacy parse, rather than faulting A's earlier admission.
        if (text === raw && new Error().stack!.includes(nativeConsumer)) { injections++; throw poison; }
        return native(text, ...rest);
      };
      result = checkP0TaskDecisionWorkEvents(req, view);
    } finally { JSON.parse = native; }
    assert.equal(injections, 1, `${phase}/${table}.${column}`); assert.equal(probes, 0); assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'invalid_value'); assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
  }
});

test('R2 unknown native failure in the real member snapshot validator is not re-certified as WE02', () => {
  for (const phase of ['original', 'retained']) {
    const req = request(); let view = req.original;
    if (phase === 'retained') { ok(checkP0TaskDecisionWorkEvents(req)); view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'))); }
    const native = JSON.stringify; let probes = 0, injections = 0;
    const poison = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; }, ownKeys() { probes++; throw null; } });
    let result: P0Result<unknown>;
    try {
      JSON.stringify = function(value: unknown, ...rest: unknown[]) {
        if (value !== null && typeof value === 'object' && (value as { schema?: unknown }).schema === 'member-relations/v2') { injections++; throw poison; }
        return Reflect.apply(native, JSON, [value, ...rest]);
      } as typeof JSON.stringify;
      result = checkP0TaskDecisionWorkEvents(req, view);
    } finally { JSON.stringify = native; }
    assert.equal(injections, 1); assert.equal(probes, 0); assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'invalid_value'); assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
  }
});

test('R2 syntax frame uses only A syntax results and binds request, graph, pass and actual audit row', () => {
  const changed = structuredClone(input), audit = ordinal('audit_log', row => typeof row.detail === 'string' && !row.detail.includes('workEventInvalidations'));
  setP0CValue(changed, 'audit_log', audit, 'detail', '{legacy unavailable');
  const req = request(changed), c = new P0CContext(req, req.original), frame = createP0CStorageSyntaxFrame(c);
  assert.equal(p0CAuditDetailUnavailable(frame, c.graph.audit_log![audit]!), true);
  const other = new P0CContext(req, req.original), foreign = request(changed);
  const retained = new P0CContext(req, retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'))));
  for (const graph of [other.graph, new P0CContext(foreign, foreign.original).graph, retained.graph])
    assert.throws(() => validateWorkEventInvalidations(graph, frame));
  assert.throws(() => p0CAuditDetailUnavailable(frame, { ...c.graph.audit_log![audit] }));
  let probes = 0;
  const poison = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; }, ownKeys() { probes++; throw null; } });
  assert.throws(() => createP0CStorageSyntaxFrame(poison as P0CContext));
  assert.throws(() => assertP0CStorageSyntaxFrame(poison as P0CStorageSyntaxFrame, c.graph));
  assert.throws(() => p0CAuditDetailUnavailable(frame, poison)); assert.equal(probes, 0);
  ok(checkP0TaskDecisionWorkEvents(req));
});

test('R2 generic legacy display grammar remains available to the full audit scan without semantic-success caching', () => {
  const index = ordinal('audit_log', row => typeof row.detail === 'string' && row.detail.length > 20 && !row.detail.includes('workEventInvalidations'));
  for (const raw of ['{legacy unavailable', 'null', '1e9999', '9007199254740993', '-0', '{"x":1,"x":2}', '"text"', '[]']) {
    const changed = structuredClone(input); setP0CValue(changed, 'audit_log', index, 'detail', raw);
    const req = request(changed); ok(checkP0TaskDecisionWorkEvents(req));
    const view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks')));
    ok(checkP0TaskDecisionWorkEvents(req, view));
  }
  const changed = structuredClone(input); setP0CValue(changed, 'audit_log', index, 'detail', '{"workEventInvalidations":{"schema":"unknown","eventIds":[]}}');
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-WE03');
});

test('legacy candidate label sorting is reserved before the original decoder runs', () => {
  const changed = structuredClone(input);
  mutateJson(changed, 'decision_action_requests', 0, 'candidate_envelope_json', value => {
    value.task.labels = Array.from({ length: 1200 }, (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(36)}`);
  });
  const req = request(changed), result = checkP0TaskDecisionWorkEvents(req);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'resource_limit');
});

test('retained C pass cannot obtain a fresh meter after the original C observation', () => {
  const req = request(); ok(checkP0TaskDecisionWorkEvents(req));
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'));
  const retained = retainP0Rows(req, rows);
  ok(withP0Guard(req, () => chargeP0(req, { work: 4_000_000 - p0Usage(req).work - 1 })));
  const result = checkP0TaskDecisionWorkEvents(req, retained);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'resource_limit');
});

test('a Decision candidate is decoded once per row in each graph pass, including retained', () => {
  const req = request();
  const raw = p0CRows(input, 'decision_action_requests')[0]!.candidate_envelope_json;
  const equalRawRows = p0CRows(input, 'decision_action_requests').filter(row => row.candidate_envelope_json === raw).length;
  const parse = JSON.parse;
  let decoded = 0;
  try {
    JSON.parse = function(text: string, ...rest: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never) {
      if (text === raw) decoded++;
      return parse(text, ...rest);
    };
    ok(checkP0TaskDecisionWorkEvents(req));
    // A's lexical/JSON admission parses each field once; the old real decoder
    // proves it once independently. Its later consumers reuse that owned value.
    assert.equal(decoded, equalRawRows * 2, 'original pass repeats a real candidate decoder');
    const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'));
    const retained = retainP0Rows(req, rows), before = decoded;
    ok(checkP0TaskDecisionWorkEvents(req, retained));
    // A may share immutable parsed bytes, but C must build a fresh decoder frame.
    assert.equal(decoded - before, equalRawRows, 'retained pass reuses original semantic proof or repeats its decoder');
  } finally { JSON.parse = parse; }
});

test('decoded frames bind exact request, view, pass, graph and frozen row without reflecting forged tokens', () => {
  const req = request(), c = new P0CContext(req, req.original);
  const frame = createDecisionDecodedFrame(c.graph, req, req.original, c);
  assert.doesNotThrow(() => assertDecisionDecodedFrame(frame, c.graph, req, req.original, c));
  for (const args of [
    [Object.freeze({ ...c.graph }), req, req.original, c],
    [c.graph, {}, req.original, c], [c.graph, req, {}, c], [c.graph, req, req.original, {}],
  ] as const) assert.throws(() => assertDecisionDecodedFrame(frame, args[0], args[1], args[2], args[3]));
  assert.throws(() => validateDecisionStorageGraph(Object.freeze({ ...c.graph }), frame));
  const row = c.graph.decision_action_requests![0]!;
  assert.throws(() => validateCopyRow('decision_action_requests', Object.freeze({ ...row }), frame));
  assert.throws(() => createDecisionDecodedFrame({ ...c.graph }, req, req.original, c));
  let probes = 0;
  const hostile = new Proxy({}, { get() { probes++; throw null; }, getPrototypeOf() { probes++; throw null; } }) as DecisionDecodedFrame;
  assert.throws(() => validateDecisionStorageGraph(c.graph, hostile));
  assert.throws(() => validateCopyRow('decision_action_requests', row, hostile));
  assert.equal(probes, 0);
  const value = decodeDecisionRow('decision_action_requests.candidate_envelope_json', row, frame) as { task: { labels: string[] } };
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.task)); assert.ok(Object.isFrozen(value.task.labels));
  assert.throws(() => value.task.labels.push('cannot-change-owned-decoder-value'));
  assert.equal(decodeDecisionRow('decision_action_requests.candidate_envelope_json', row, frame), value);
});

test('decoded reuse preserves the old consumer failure stage, column and actual source row', () => {
  const req = request(), c = new P0CContext(req, req.original);
  const changed = (table: string, at: number, patch: Record<string, unknown>): DecisionStorageGraph => Object.freeze({
    ...c.graph, [table]: Object.freeze(c.graph[table]!.map((row, index) => index === at ? Object.freeze({ ...row, ...patch }) : row)),
  });
  const action = c.graph.decision_action_requests![0]!;
  const completionAt = c.graph.work_events!.findIndex(row => row.kind === 'task.review_decided');
  const event = c.graph.work_events![completionAt]!;
  const badPayload = { ...JSON.parse(event.payload as string), completionRevision: 99999 };
  const historyAt = c.graph.task_history!.findIndex(row => row.action === 'task.review_decided');
  const controls: DecisionStorageGraph[] = [
    changed('decision_action_requests', 0, { action_digest: `sha256:${'f'.repeat(64)}` }),
    changed('decision_action_requests', 0, { candidate_envelope_json: ` ${action.candidate_envelope_json}` }),
    changed('decision_records', 0, { predecessor_decision_id: c.graph.decision_records![0]!.id }),
    changed('decision_review_heads', 0, { head_revision: 99999 }),
    changed('task_history', historyAt, { actor: JSON.stringify({ kind: 'human', actorId: 'changed-source', displayName: '' }) }),
    changed('work_events', completionAt, { payload: JSON.stringify(badPayload) }),
    Object.freeze({ ...c.graph, tasks: Object.freeze([]) }),
    Object.freeze({ ...c.graph, decision_action_requests: Object.freeze([action, action]) }),
  ];
  for (const graph of controls) {
    const failure = (frame?: DecisionDecodedFrame) => {
      try { validateDecisionStorageGraph(graph, frame); assert.fail('negative control was accepted'); }
      catch (error) { const identity = getStorageInvalidIdentity(error); assert.ok(identity); return identity; }
    };
    const legacy = failure(), frame = createDecisionDecodedFrame(graph, req, req.original, graph), prepared = failure(frame);
    assert.equal(prepared.column, legacy.column); assert.equal(prepared.stage, legacy.stage); assert.equal(prepared.row, legacy.row);
  }
});

test('legacy native canonical encoding reserves every nested output before entering the old consumer', () => {
  const changed = structuredClone(input), round = p0CRows(input, 'task_review_rounds')[0]!;
  const imported = planLegacyImport({ projectId: round.project_id as string, taskId: round.task_id as string,
    histories: [], rounds: [round], at: '2026-11-19T00:00:00.000Z', liveHistoryIds: new Set() });
  assert.equal(imported.rows.length, 1);
  // The legacy round grammar preserves historical values. Its fixed keys and
  // identity/revision cannot justify narrowing an inner value to today's SQL type.
  let nested: unknown = ['x'.repeat(5000), 1_000_000_000_000_000];
  for (let i = 0; i < 20; i++) nested = { a: nested };
  const raw = canonicalJson({ ...round, spec_snapshot: nested });
  const legacy = { ...imported.rows[0]!, raw_text: raw, raw_digest: createHash('sha256').update(raw).digest('hex') };
  appendP0CRow(changed, 'decision_legacy_records', legacy);
  const req = request(changed), c = new P0CContext(req, req.original), row = c.rows('decision_legacy_records')[0]!;
  const value = c.json(row, 'raw_text', 'PC1B-DEC11');
  ok(withP0Guard(req, () => chargeP0(req, { bytes: 64 * 1024 * 1024 - p0Usage(req).bytes - 128 * 1024 })));
  let entered = false;
  const result = withP0Guard(req, () => {
    c.reserveCanonicalKeys(value, 4, c.site(row, 'PC1B-DEC11', 'raw_text'));
    entered = true;
    return canonicalJson(value);
  });
  assert.equal(result.ok, false, 'nested native output was not reserved');
  if (!result.ok) {
    assert.equal(result.error.code, 'resource_limit');
    assert.equal(result.error.location!.table, 'decision_legacy_records');
    assert.equal(result.error.location!.rowOrdinal, row.origin.rowOrdinal);
  }
  assert.equal(entered, false, 'resource rejection came after the native encoder');
});

test('pre-Decision completion preserves nullable task and original boolean/number fields', () => {
  for (const payload of [{}, { enteredDone: 'true', completionRevision: '7', assigneeAgentId: null },
    { enteredDone: true, completionRevision: 7, assigneeAgentId: 'declared-historical-agent' }]) {
    const changed = structuredClone(input), base = p0CRows(input, 'work_events')[0]!;
    appendP0CRow(changed, 'work_events', { ...base, id: 'pre-decision-event', task_id: null,
      kind: 'task.review_decided', event_key: 'pre-decision-completion', payload: JSON.stringify(payload) });
    const req = request(changed), observed = ok(checkP0TaskDecisionWorkEvents(req)), event = req.original.rows('work_events').at(-1)!;
    const source = ok(withP0Guard(req, () => lookupP0CompletionSource(req, req.original, observed.completion, event)))!;
    assert.equal(source.branch, 'legacy'); assert.equal(source.taskId, null); assert.equal(source.execution, null);
    assert.equal(source.enteredDone, payload.enteredDone === true);
    assert.equal(source.completionRevision, typeof payload.completionRevision === 'number' ? payload.completionRevision : null);
  }
  const changed = structuredClone(input), base = p0CRows(input, 'work_events')[0]!;
  for (const [key, payload] of [['decision:orphan:effect', {}], ['pre-decision-completion', { decisionRef: null }]] as const) {
    const control = structuredClone(changed);
    appendP0CRow(control, 'work_events', { ...base, id: 'orphan-event', kind: 'task.review_decided', event_key: key, payload: JSON.stringify(payload) });
    rejected(checkP0TaskDecisionWorkEvents(request(control)), 'PC1B-DEC10');
  }
});

test('R5 evidence=[] is rejected by the full ReviewEvidence grammar before old graph digest acceptance', () => {
  const changed = structuredClone(input);
  setP0CValue(changed, 'task_review_reports', 0, 'evidence', '[]');
  const result = checkP0TaskDecisionWorkEvents(request(changed)); rejected(result, 'PC1B-TASK02');
  if (!result.ok) assert.equal(result.error.location!.columnOrdinal,
    changed.graph.observation.tables.find(table => table.name === 'task_review_reports')!.columns.indexOf('evidence') + 1);
});

test('report execution interval/candidate and independent axes use all immutable evidence fields', () => {
  for (const mutate of [
    (e: Record<string, any>) => { e.command.exitCode = 1; },
    (e: Record<string, any>) => { e.baseCommit = 'f'.repeat(40); },
    (e: Record<string, any>) => { e.completedAt = e.startedAt; },
    (e: Record<string, any>) => { e.command.startedAt = e.completedAt; },
  ]) {
    const changed = structuredClone(input); mutateJson(changed, 'task_review_reports', 0, 'evidence', mutate);
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-TASK02');
  }
  const changed = structuredClone(input), first = JSON.parse(p0CValue(changed, 'task_review_reports', 0, 'evidence') as string);
  mutateJson(changed, 'task_review_reports', 1, 'evidence', e => { e.contextId = first.contextId; });
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-TASK02');
});

test('Task current round/member scope and every registered immutable history path are checked', () => {
  const badCurrent = structuredClone(input);
  setP0CValue(badCurrent, 'tasks', 0, 'current_review_round_id', 'missing-secret-target');
  rejected(checkP0TaskDecisionWorkEvents(request(badCurrent)), 'PC1B-TASK01');
  const controls: [string, (detail: Record<string, any>) => void][] = [
    ['task.created', d => { d.extra = true; }],
    ['task.updated', d => { d.previousRevision += 50; }],
    ['task.transitioned', d => { d.escalation = { recipientMemberId: null, unresolved: false }; }],
    ['task.commented', d => { d.commentId = 'missing-secret-comment'; }],
    ['task.message_linked', d => { d.messageId = 'invented-edge'; }],
    ['task.review_failed', d => { d.failure.message = 'changed'; }],
    ['task.review_started', d => { d.baseCommit = 'f'.repeat(40); }],
    ['task.review_begun', d => { d.roundRevision = 999; }],
    ['task.review_reported', d => { d.verdict = 'changes_requested'; }],
    ['member_removed', d => { d.auditId = 'missing-secret-audit'; }],
    ['member_restored', d => { d.memberId = 'missing-secret-member-id'; }],
  ];
  for (const [action, mutate] of controls) {
    const changed = structuredClone(input), index = ordinal('task_history', row => row.action === action);
    mutateJson(changed, 'task_history', index, 'detail', mutate);
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-TASK03');
  }
});

test('registered Decision scalar, snapshot, terminal, report and cursor failures keep their exact rule/source', async t => {
  const cases: [P0Rule, (changed: P0CInput) => void][] = [
    ['PC1B-DEC01', changed => setP0CValue(changed, 'decision_records', 0, 'status', 'unsupported')],
    ['PC1B-DEC02', changed => setP0CValue(changed, 'decision_action_requests', 0, 'action_digest', `sha256:${'0'.repeat(64)}`)],
    ['PC1B-DEC03', changed => mutateJson(changed, 'decision_records', 0, 'policy_evaluation_json', value => { value.policy.global.contentDigest = '0'.repeat(64); })],
    ['PC1B-DEC04', changed => mutateJson(changed, 'decision_command_receipts', 0, 'response_json', value => { value.task.revision = 999; })],
    ['PC1B-DEC06', changed => setP0CValue(changed, 'decision_executions', 0, 'effect_key', 'changed-effect')],
    ['PC1B-DEC08', changed => setP0CValue(changed, 'task_review_reports', 0, 'body', 'altered immutable report')],
    ['PC1B-DEC09', changed => {
      mutateJson(changed, 'decision_command_receipts', 0, 'response_json', value => {
        value.receipt.resultDecisionRef.revision = 999; value.decisionRef.revision = 999;
      });
      setP0CValue(changed, 'decision_command_receipts', 0, 'result_decision_revision', 999);
    }],
    ['PC1B-DEC10', changed => mutateJson(changed, 'work_events', ordinal('work_events', row => row.kind === 'task.review_decided'), 'payload', value => { value.enteredDone = false; })],
    ['PC1B-DEC11', changed => mutateJson(changed, 'task_review_rounds', ordinal('task_review_rounds', row => row.decision !== null), 'decision', value => { value.reason = 'changed immutable projection'; })],
    ['PC1B-DEC12', changed => setP0CValue(changed, 'decision_change_heads', 0, 'revision', 999)],
  ];
  for (const [rule, mutate] of cases) {
    await t.test(rule, () => { const changed = structuredClone(input); mutate(changed);
      rejected(checkP0TaskDecisionWorkEvents(request(changed)), rule); });
  }
});

test('DEC05 a real pending Decision cannot claim a terminal graph without resolution and execution', async () => {
  const f = await makeP0CPendingFixture();
  try {
    ok(checkP0TaskDecisionWorkEvents(request(f.input)));
    assert.equal(p0CRows(f.input, 'decision_resolutions').length, 0);
    assert.equal(p0CRows(f.input, 'decision_executions').length, 0);
    const changed = structuredClone(f.input);
    setP0CValue(changed, 'decision_records', 0, 'status', 'resolved');
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-DEC05');
  } finally { await f.close(); }
});

test('DEC07 real HTTP human initiation cycle remains exact; no-effect outcomes do not create completion', async () => {
  for (const choice of ['approve', 'reject', 'request_changes'] as const) {
    const f = await makeP0CHumanFixture(choice);
    try {
      ok(checkP0TaskDecisionWorkEvents(request(f.input)));
      const changed = structuredClone(f.input);
      setP0CValue(changed, 'decision_local_initiations', 0, 'consumed_at', '2026-11-19T09:00:00.000Z');
      rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-DEC07');
      if (choice !== 'approve') {
        assert.equal(p0CRows(f.input, 'work_events').some(row => row.kind === 'task.review_decided'), false);
        assert.equal(p0CRows(f.input, 'decision_executions')[0]!.status, 'not_required');
      }
    } finally { await f.close(); }
  }
});

test('Task ordinary and lifecycle event variants keep exact key spelling and historical routes', () => {
  const selected = [
    ordinal('work_events', row => row.kind === 'task.assigned' && Object.hasOwn(JSON.parse(row.payload as string), 'revision')),
    ordinal('work_events', row => row.kind === 'task.blocked' && Object.hasOwn(JSON.parse(row.payload as string), 'revision')),
    ordinal('work_events', row => ['task.assigned', 'task.blocked'].includes(row.kind as string) && Object.hasOwn(JSON.parse(row.payload as string), 'taskRevision')),
    ordinal('work_events', row => row.kind === 'task.review_ready'),
  ];
  for (const index of selected) {
    const changed = structuredClone(input); setP0CValue(changed, 'work_events', index, 'event_key', 'bad-secret-key');
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-TASK03');
  }
  const changed = structuredClone(input);
  mutateJson(changed, 'work_events', selected[2]!, 'payload', value => { value.revision = value.taskRevision; delete value.taskRevision; });
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-TASK03');
});

test('Decision requested/resolved notices and outcome history protect their own sources', () => {
  const requested = ordinal('work_events', row => row.kind === 'decision.requested');
  const resolved = ordinal('work_events', row => row.kind === 'decision.resolved');
  for (const [index, mutate] of [[requested, (v: Record<string, any>) => { v.decisionRevision = 999; }],
    [resolved, (v: Record<string, any>) => { v.choiceId = 'reject'; }]] as const) {
    const changed = structuredClone(input); mutateJson(changed, 'work_events', index, 'payload', mutate);
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-DEC13');
  }
  const changed = structuredClone(input), history = ordinal('task_history', row => row.action === 'decision.resolved');
  setP0CValue(changed, 'task_history', history, 'created_at', '2026-11-19T09:00:00.000Z');
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-DEC13');
});

test('live completion cannot lose an execution even if its event is ACKed and Task advances', () => {
  const changed = structuredClone(input), index = ordinal('work_events', row => row.kind === 'task.review_decided');
  setP0CValue(changed, 'work_events', index, 'delivery_state', 'acked');
  const req = request(changed); ok(checkP0TaskDecisionWorkEvents(req));
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'));
  const event = req.original.rows('work_events')[index]!;
  const retained = retainP0Rows(req, rows.filter(row => row !== event && !(row.table === 'work_event_delivery_invalidations'
    && row.raw.cells[0]?.[0] === 'text' && row.raw.cells[0]?.[1] === event.raw.cells[0]?.[1])));
  const result = checkP0TaskDecisionWorkEvents(req, retained); rejected(result, 'PC1B-DEC10');
  if (!result.ok) assert.equal(result.error.code, 'retained_reference_conflict');
});

test('WE audit closure still requires markers when all sidecars are omitted', () => {
  const req = request(); ok(checkP0TaskDecisionWorkEvents(req));
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'));
  const retained = retainP0Rows(req, rows.filter(row => row.table !== 'work_event_delivery_invalidations'));
  const result = checkP0TaskDecisionWorkEvents(req, retained); rejected(result, 'PC1B-WE03');
  if (!result.ok) assert.equal(result.error.code, 'retained_reference_conflict');
});

test('WE marker requires actual cause, membership generation, and complete snapshot grammar', () => {
  for (const [column, value] of [['cause_to_revision', 99], ['cause_member_id', 'missing-secret-member-id'], ['invalidated_at', 'different']] as const) {
    const changed = structuredClone(input); setP0CValue(changed, 'work_event_delivery_invalidations', 0, column, value);
    rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-WE01');
  }
  const marker = p0CRows(input, 'work_event_delivery_invalidations')[0]!;
  const auditIndex = ordinal('audit_log', row => row.id === marker.cause_audit_id);
  const changed = structuredClone(input);
  mutateJson(changed, 'audit_log', auditIndex, 'before', snapshot => { snapshot.transient.workEventIds = []; });
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-WE03');
  const extraClosure = structuredClone(input);
  mutateJson(extraClosure, 'audit_log', auditIndex, 'detail', detail => { detail.workEventInvalidations.extra = true; });
  rejected(checkP0TaskDecisionWorkEvents(request(extraClosure)), 'PC1B-WE03');

  const invalidSnapshot = structuredClone(input);
  mutateJson(invalidSnapshot, 'audit_log', auditIndex, 'before', snapshot => { snapshot.member.membershipRevision = 0; });
  const invalid = checkP0TaskDecisionWorkEvents(request(invalidSnapshot));
  rejected(invalid, 'PC1B-WE02');
  if (!invalid.ok) { assert.equal(invalid.error.location!.table, 'work_event_delivery_invalidations'); assert.equal(invalid.error.location!.rowOrdinal, 0); }
});

test('WE04 removed recipient cannot retain an unmarked original event', () => {
  const marked = new Set(p0CRows(input, 'work_event_delivery_invalidations').map(row => row.work_event_id));
  const eventIndex = ordinal('work_events', row => !marked.has(row.id));
  const event = p0CRows(input, 'work_events')[eventIndex]!;
  const memberIndex = ordinal('members', row => row.id === event.recipient_member_id);
  const changed = structuredClone(input); setP0CValue(changed, 'members', memberIndex, 'removed_at', '2026-11-19T09:00:00.000Z');
  const result = checkP0TaskDecisionWorkEvents(request(changed)); rejected(result, 'PC1B-WE04');
  if (!result.ok) { assert.equal(result.error.location!.table, 'work_events'); assert.equal(result.error.location!.rowOrdinal, eventIndex); }
});

test('WE03 permits original/sidecar paired removal without rewriting its immutable audit closure', () => {
  const req = request(), observed = ok(checkP0TaskDecisionWorkEvents(req));
  const markers = p0CRows(input, 'work_event_delivery_invalidations');
  const eventIndex = ordinal('work_events', row => row.kind === 'task.assigned' && markers.some(marker => marker.work_event_id === row.id));
  const id = p0CRows(input, 'work_events')[eventIndex]!.id;
  const markerIndex = markers.findIndex(marker => marker.work_event_id === id);
  const event = req.original.rows('work_events')[eventIndex]!, marker = req.original.rows('work_event_delivery_invalidations')[markerIndex]!;
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as typeof event.table));
  const retained = retainP0Rows(req, rows.filter(row => row !== event && row !== marker));
  ok(checkP0TaskDecisionWorkEvents(req, retained));
  assert.deepEqual(retained.rows('audit_log'), req.original.rows('audit_log'));
  assert.equal(ok(withP0Guard(req, () => lookupP0CompletionSource(req, req.original, observed.completion, event))), null);
});

test('message-linked history survives the group purge of its separate message/link rows', () => {
  const req = request(); ok(checkP0TaskDecisionWorkEvents(req));
  const linkedHistory = req.original.rows('task_history')[ordinal('task_history', row => row.action === 'task.message_linked')]!;
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as typeof linkedHistory.table));
  const retained = retainP0Rows(req, rows.filter(row => !['groups', 'messages', 'task_message_links'].includes(row.table)));
  ok(checkP0TaskDecisionWorkEvents(req, retained));
  assert.ok(retained.rows('task_history').includes(linkedHistory));
});

test('unknown history action names use the opaque object branch without prototype grammar dispatch', () => {
  for (const action of ['__proto__', 'constructor']) {
    const changed = structuredClone(input), index = ordinal('task_history', row => row.action === 'task.created');
    setP0CValue(changed, 'task_history', index, 'action', action);
    setP0CValue(changed, 'task_history', index, 'detail', '{"__proto__":{"unknownId":"not-a-strong-edge"},"constructor":true}');
    ok(checkP0TaskDecisionWorkEvents(request(changed)));
  }
});

test('real legacy importer retains malformed historical text and requires its exact original source', () => {
  const changed = structuredClone(input), original = p0CRows(input, 'task_history')[0]!;
  const source: Record<string, string | number | null> = { ...original, id: 'declared-malformed-history',
    action: 'task.review_decided', task_revision: 1, detail: '{invalid legacy detail' };
  const imported = planLegacyImport({ projectId: source.project_id as string, taskId: source.task_id as string,
    histories: [source], rounds: [], at: '2026-11-19T00:00:00.000Z', liveHistoryIds: new Set() });
  assert.equal(imported.projections.length, 0); assert.equal(imported.rows.length, 1);
  assert.equal(imported.rows[0]!.chain_status, 'malformed');
  appendP0CRow(changed, 'task_history', source); appendP0CRow(changed, 'decision_legacy_records', imported.rows[0]!);
  const req = request(changed); ok(checkP0TaskDecisionWorkEvents(req));
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as 'tasks'));
  const history = req.original.rows('task_history').at(-1)!, legacy = req.original.rows('decision_legacy_records').at(-1)!;
  for (const remove of [history, legacy]) {
    const fresh = request(changed), omitted = fresh.original.rows(remove.table).find(row => row.rowOrdinal === remove.rowOrdinal)!;
    const kept = fresh.input.graph.observation.tables.flatMap(table => fresh.original.rows(table.name as 'tasks')).filter(row => row !== omitted);
    const result = checkP0TaskDecisionWorkEvents(fresh, retainP0Rows(fresh, kept)); rejected(result, 'PC1B-DEC11');
    if (!result.ok) assert.equal(result.error.code, 'retained_reference_conflict');
  }
  assert.ok(rows.includes(history));
  setP0CValue(changed, 'decision_legacy_records', 0, 'raw_digest', '0'.repeat(64));
  rejected(checkP0TaskDecisionWorkEvents(request(changed)), 'PC1B-DEC11');
});

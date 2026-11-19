import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { chargeP0, createP0Request, p0Usage, retainP0Rows } from '../src/server/identity/internal/m2-p0.ts';
import type { P0Request, P0Result, P0Rule, P0Table, P0View } from '../src/server/identity/internal/m2-p0.ts';
import { checkP0TaskDecisionWorkEvents } from '../src/server/identity/internal/m2-p0-task-decision-work-events.ts';
import { checkP0AuditMemory, P0_D_RULES } from '../src/server/identity/internal/m2-p0-audit-memory.ts';
import type { P0CompletionIndex } from '../src/server/identity/internal/m2-p0-completion.ts';
import { P0DContext } from '../src/server/identity/internal/m2-p0-d-context.ts';
import { auditChainSteps, type AuditChainValue } from '../src/server/audit-compensation.ts';
import { getRepositoryErrorCode } from '../src/server/db/errors.ts';
import { makeP0DFixture } from './helpers/m2-p0-d-fixture.ts';
import { appendP0CRow, p0CRows, p0CValue, setP0CValue, type P0CInput } from './helpers/m2-p0-c-fixture.ts';

let input: P0CInput;
before(async () => { const f = await makeP0DFixture(); input = f.input; await f.close(); });
function ok<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function request(value = input): P0Request { return ok(createP0Request(JSON.stringify(value))); }
function run(value = input) { const req = request(value), c = ok(checkP0TaskDecisionWorkEvents(req)); return checkP0AuditMemory(req, c.completion); }
function rejected(result: P0Result<unknown>, rule: P0Rule): void {
  assert.equal(result.ok, false); if (result.ok) return;
  assert.equal(result.error.rule, rule); assert.ok(result.error.location);
  assert.notEqual(result.error.code, 'resource_limit');
}
function ordinal(table: string, predicate: (row: Record<string, string | number | null>) => boolean): number {
  const found = p0CRows(input, table).findIndex(predicate); assert.ok(found >= 0, table); return found;
}
function changeJson(value: P0CInput, table: string, index: number, column: string, change: (object: any) => void): void {
  const object = JSON.parse(p0CValue(value, table, index, column) as string); change(object);
  setP0CValue(value, table, index, column, JSON.stringify(object));
}
function retained(value: P0CInput, select: (row: { table: string; rowOrdinal: number }) => boolean) {
  const req = request(value), first = ok(checkP0TaskDecisionWorkEvents(req)); ok(checkP0AuditMemory(req, first.completion));
  const view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as P0Table)).filter(select));
  const second = ok(checkP0TaskDecisionWorkEvents(req, view)); return checkP0AuditMemory(req, second.completion, view);
}

test('D consumes actual audit compensation, full Memory history and C completion after later edits', () => {
  const req = request(), c = ok(checkP0TaskDecisionWorkEvents(req)), observed = ok(checkP0AuditMemory(req, c.completion));
  assert.equal(observed.classification, 'audit-memory-observation'); assert.deepEqual(observed.rules, P0_D_RULES);
  assert.equal(observed.fullSemanticClosure, 'not-performed'); assert.equal(P0_D_RULES.length, 8);
  assert.ok(p0Usage(req).bytes > 0);
});

test('MEM01 checks old immutable version bodies, not only the current head', () => {
  const changed = structuredClone(input); setP0CValue(changed, 'memory_versions', 0, 'markdown', 'changed-old-body');
  rejected(run(changed), 'PC1B-MEM01');
});

test('MEM05 notification protects the request and accepts its original revision after completion', () => {
  const req = request(), c = ok(checkP0TaskDecisionWorkEvents(req)); ok(checkP0AuditMemory(req, c.completion));
  const completedOrdinal = p0CRows(input, 'memory_summary_requests').findIndex(row => row.state === 'completed');
  assert.ok(completedOrdinal >= 0);
  const removed = req.original.rows('memory_summary_requests')[completedOrdinal]!;
  const rows = req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as typeof removed.table)).filter(row => row !== removed);
  const retained = retainP0Rows(req, rows), retainedC = ok(checkP0TaskDecisionWorkEvents(req, retained));
  const result = checkP0AuditMemory(req, retainedC.completion, retained); rejected(result, 'PC1B-MEM05');
  if (!result.ok) assert.equal(result.error.code, 'retained_reference_conflict');
});

test('MEM02 completed result binds the immutable version, even after the document head advances', () => {
  const changed = structuredClone(input), index = p0CRows(input, 'memory_summary_requests').findIndex(row => row.state === 'completed');
  assert.ok(index >= 0); assert.equal(p0CValue(input, 'memory_summary_requests', index, 'result_version'), 2);
  setP0CValue(changed, 'memory_summary_requests', index, 'result_sha256', '0'.repeat(64));
  rejected(run(changed), 'PC1B-MEM02');
});

test('AUD01 preserves all legacy display JSON kinds, invalid display availability and exact raw cells', () => {
  for (const raw of ['null', 'true', 'false', '[]', '{}', '"legacy"', '1.5', '9007199254740993', '1e9999', '-0', '{invalid']) {
    const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'fixture.display');
    setP0CValue(changed, 'audit_log', index, 'changed', raw);
    const req = request(changed), before = JSON.stringify(req.input), c = ok(checkP0TaskDecisionWorkEvents(req));
    const result = ok(checkP0AuditMemory(req, c.completion)); assert.equal(JSON.stringify(req.input), before);
    assert.equal(result.availability.some(value => value.code === 'legacy-display-unavailable' && value.location.rowOrdinal === index), raw === '{invalid');
  }
});

test('AUD01 accepts historical display over 32KiB and does not invent target/project/actor entity edges', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'fixture.display');
  setP0CValue(changed, 'audit_log', index, 'changed', JSON.stringify('a'.repeat(33000)));
  for (const column of ['project_id', 'actor_member_id', 'target_id']) setP0CValue(changed, 'audit_log', index, column, 'purged-history-identity');
  setP0CValue(changed, 'audit_log', index, 'detail', '{"reversal":{"rootAuditId":"arbitrary-text"},"id":"not-an-edge"}');
  ok(run(changed));
});

test('AUD01 scope remains exact even for display-only history', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'fixture.display');
  setP0CValue(changed, 'audit_log', index, 'scope', 'user'); rejected(run(changed), 'PC1B-AUD01');
});

test('AUD02 does not downgrade malformed required semantic JSON to display unavailable', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
  setP0CValue(changed, 'audit_log', index, 'detail', '');
  const result = run(changed); rejected(result, 'PC1B-AUD02');
  if (!result.ok) assert.equal(result.error.code, 'semantic_unsupported');
});

test('AUD02 strict v2 metadata rejects extra fields and invalid directions', () => {
  for (const change of [(value: any) => { value.reversal.extra = true; }, (value: any) => { value.reversal.direction = 'undo'; }]) {
    const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
    changeJson(changed, 'audit_log', index, 'detail', change); rejected(run(changed), 'PC1B-AUD02');
  }
});

test('AUD02 all predecessor and reverse links remain strong in retained history', () => {
  const index = ordinal('audit_log', row => row.action === 'org.node_update');
  const result = retained(input, row => row.table !== 'audit_log' || row.rowOrdinal !== index);
  rejected(result, 'PC1B-AUD02'); if (!result.ok) assert.equal(result.error.code, 'retained_reference_conflict');
  const changed = structuredClone(input); setP0CValue(changed, 'audit_log', index, 'reversed_by_audit_id', 'missing-audit');
  rejected(run(changed), 'PC1B-AUD02');
});

test('AUD03 actual finite fractional sortOrder survives, malformed after snapshot locates after', () => {
  const index = ordinal('audit_log', row => row.action === 'org.node_update');
  assert.equal(JSON.parse(p0CValue(input, 'audit_log', index, 'after') as string).node.sortOrder, 1.5);
  const changed = structuredClone(input); changeJson(changed, 'audit_log', index, 'after', value => { value.node.role = 'unsupported'; });
  const result = run(changed); rejected(result, 'PC1B-AUD03');
  if (!result.ok) { assert.equal(result.error.location!.rowOrdinal, index); assert.equal(result.error.location!.columnOrdinal, 13); }
});

test('AUD03 compares whole child and membership-generation sets, without requiring snapshot entities live', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
  for (const column of ['before', 'after']) changeJson(changed, 'audit_log', index, column, value => {
    value.childEdges = [{ nodeId: 'snapshot-only-child', parentId: null }];
    value.assignments = [{ memberId: 'snapshot-only-member', nodeId: null, legacyRole: 'normal', membershipRevision: 7 }];
  });
  ok(run(changed));
  changeJson(changed, 'audit_log', index, 'after', value => { value.assignments[0].membershipRevision = 8; });
  rejected(run(changed), 'PC1B-AUD03');
});

test('AUD03 requires assignment identities and status generations to agree across each immutable pair', () => {
  const template = p0CRows(input, 'audit_log').find(row => row.action === 'fixture.display')!;
  for (const kind of ['assignment-generation', 'assignment-members', 'status-generation'] as const) {
    const common = { projectId: template.project_id, targetId: 'purged-member' };
    const assignment = { schema: 'org-assignment/v2', ...common,
      assignments: [{ memberId: 'purged-member', nodeId: null, legacyRole: 'normal', membershipRevision: 7 }] };
    const status = { schema: 'member-status/v2', ...common, status: 'disabled', membershipRevision: 7 };
    const snapshot = kind === 'status-generation' ? status : assignment;
    for (const corrupt of [false, true]) {
      const changed = structuredClone(input), before = structuredClone(snapshot), action = kind === 'status-generation' ? 'member.pause' : 'org.assign';
      if (corrupt) {
        if (kind === 'status-generation') (before as typeof status).membershipRevision++;
        else if (kind === 'assignment-generation') (before as typeof assignment).assignments[0]!.membershipRevision++;
        else (before as typeof assignment).assignments.push({ memberId: 'purged-other', nodeId: null, legacyRole: 'normal', membershipRevision: 7 });
      }
      appendP0CRow(changed, 'audit_log', { ...template, id: 'pair-proof', action, target_kind: 'member', target_id: common.targetId,
        changed: null, before: JSON.stringify(before), after: JSON.stringify(snapshot),
        detail: JSON.stringify({ reversal: { version: 2, rootAuditId: 'pair-proof', rootAction: action, undoesAuditId: null, direction: 'forward' } }),
        reversed_at: null, reversed_by_audit_id: null });
      const index = p0CRows(changed, 'audit_log').length - 1;
      for (const phase of ['original', 'retained'] as const) {
        // A rejected pass poisons its own request, so each negative phase uses
        // a fresh authentic request and the actual owned retained view.
        const req = request(changed), raw = JSON.stringify(req.input);
        const view = phase === 'original' ? req.original : retainP0Rows(req,
          req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as P0Table)));
        const c = ok(checkP0TaskDecisionWorkEvents(req, view));
        const result = checkP0AuditMemory(req, c.completion, view);
        assert.equal(JSON.stringify(req.input), raw);
        if (!corrupt) { ok(result); continue; }
        rejected(result, 'PC1B-AUD03'); if (result.ok) assert.fail();
        assert.equal(result.error.code, phase === 'original' ? 'semantic_invariant_failed' : 'retained_reference_conflict');
        assert.equal(result.error.location!.rowOrdinal, index); assert.equal(result.error.location!.columnOrdinal, 13);
        assert.equal(result.error.conflicts[0]?.condition, 'immutable-history-mismatch');
      }
    }
  }
});

test('AUD03 legacy normalized assignment/status pairs preserve explicit generations and nullish fallback', () => {
  const template = p0CRows(input, 'audit_log').find(row => row.action === 'fixture.display')!;
  const cases: readonly (readonly [number | null | undefined, number | null | undefined, boolean])[] = [
    [undefined, undefined, true], [undefined, 1, true], [1, undefined, true], [null, 1, true], [1, null, true],
    [7, 7, true], [2, 1, false], [1, 2, false], [undefined, 2, false], [2, null, false],
  ];
  for (const action of ['org.assign', 'org.auto_place', 'member.pause', 'member.resume', 'member.status_change']) {
    for (const [beforeRevision, afterRevision, valid] of cases) {
      const changed = structuredClone(input);
      const member = { id: 'purged-legacy-member', projectId: template.project_id, nodeId: null, role: 'normal',
        status: 'active', kind: 'human', agentId: null, displayName: '历史成员', createdAt: 'old-create', updatedAt: 'old-update' };
      const before = { ...member, membershipRevision: beforeRevision };
      const after = { ...member, status: action === 'member.pause' ? 'disabled' : 'active', membershipRevision: afterRevision };
      appendP0CRow(changed, 'audit_log', { ...template, id: 'legacy-pair-proof', action,
        target_kind: action === 'org.auto_place' ? 'node' : 'member',
        target_id: action === 'org.auto_place' ? 'purged-legacy-node' : member.id,
        changed: null, before: JSON.stringify(before), after: JSON.stringify(after),
        detail: JSON.stringify({ reversal: { version: 2, rootAuditId: 'legacy-pair-proof', rootAction: action, undoesAuditId: null, direction: 'forward' } }),
        reversed_at: null, reversed_by_audit_id: null });
      const index = p0CRows(changed, 'audit_log').length - 1;
      for (const phase of ['original', 'retained'] as const) {
        const req = request(changed), raw = JSON.stringify(req.input);
        const view = phase === 'original' ? req.original : retainP0Rows(req,
          req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as P0Table)));
        const c = ok(checkP0TaskDecisionWorkEvents(req, view)), result = checkP0AuditMemory(req, c.completion, view);
        assert.equal(JSON.stringify(req.input), raw);
        if (valid) { ok(result); continue; }
        rejected(result, 'PC1B-AUD03'); if (result.ok) assert.fail();
        assert.equal(result.error.code, phase === 'original' ? 'semantic_invariant_failed' : 'retained_reference_conflict');
        assert.equal(result.error.location!.rowOrdinal, index); assert.equal(result.error.location!.columnOrdinal, 13);
        assert.equal(result.error.conflicts[0]?.condition, 'immutable-history-mismatch');
      }
    }
  }
});

test('AUD03 legacy incomplete snapshots are explicit historical availability', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'member.add');
  setP0CValue(changed, 'audit_log', index, 'before', 'null'); setP0CValue(changed, 'audit_log', index, 'after', '{"old":"member"}');
  const value = ok(run(changed)); assert.ok(value.availability.some(item => item.code === 'legacy-nonreversible-audit' && item.location.rowOrdinal === index));
});

test('AUD02 legacy reversed_by predecessor fallback and simple node snapshots keep their original meaning', () => {
  const changed = structuredClone(input), template = p0CRows(input, 'audit_log').find(row => row.action === 'fixture.display')!;
  const before = { id: 'old-node', projectId: template.project_id, parentId: null, name: 'before', role: 'top_manager',
    sortOrder: 1.5, createdAt: 'old-created', updatedAt: 'old-updated' };
  const after = { ...before, name: 'after' };
  appendP0CRow(changed, 'audit_log', { ...template, id: 'legacy-root', action: 'org.node_update', target_kind: 'node', target_id: before.id,
    changed: null, before: JSON.stringify(before), after: JSON.stringify(after), detail: '{}',
    reversed_at: 'legacy-reversal-time', reversed_by_audit_id: 'legacy-reverse' });
  appendP0CRow(changed, 'audit_log', { ...template, id: 'legacy-reverse', action: 'org.revoke', target_kind: 'node', target_id: before.id,
    changed: null, before: JSON.stringify(after), after: JSON.stringify(before), detail: '{}', reversed_at: null, reversed_by_audit_id: 'legacy-root' });
  ok(run(changed));
  const reverse = p0CRows(changed, 'audit_log').length - 1;
  setP0CValue(changed, 'audit_log', reverse, 'reversed_by_audit_id', 'missing-legacy-predecessor');
  rejected(run(changed), 'PC1B-AUD02');
  setP0CValue(changed, 'audit_log', reverse, 'reversed_by_audit_id', null);
  setP0CValue(changed, 'audit_log', reverse, 'detail', '{"undoes":"legacy-root"}');
  ok(run(changed));
});

test('AUD03 old simple member status and assignment snapshots preserve missing-generation fallback', () => {
  const template = p0CRows(input, 'audit_log').find(row => row.action === 'fixture.display')!;
  const before = { id: 'old-member', projectId: template.project_id, nodeId: null, role: 'normal', status: 'active', kind: 'agent',
    agentId: 'purged-embedded-agent', displayName: 'historical member', createdAt: 'old-created', updatedAt: 'old-updated' };
  for (const action of ['member.status_change', 'org.assign']) {
    const changed = structuredClone(input);
    appendP0CRow(changed, 'audit_log', { ...template, id: 'old-simple-member', action, target_kind: 'member', target_id: before.id,
      changed: null, before: JSON.stringify(before), after: JSON.stringify({ ...before, status: 'disabled' }), detail: null,
      reversed_at: null, reversed_by_audit_id: null });
    ok(run(changed));
    const index = p0CRows(changed, 'audit_log').length - 1;
    changeJson(changed, 'audit_log', index, 'after', value => { value.agentId = 'other-embedded-agent'; });
    rejected(run(changed), 'PC1B-AUD03');
  }
});

test('MEM01 preserves all scope keys, strict authors and head body/source identity', () => {
  for (const [column, value] of [['updated_by', '{"kind":"human","actorId":"x","agentId":null,"displayName":"x","extra":true}'],
    ['source', 'human'], ['markdown', 'different-head']] as const) {
    const changed = structuredClone(input); setP0CValue(changed, 'memory_documents', 0, column, value); rejected(run(changed), 'PC1B-MEM01');
  }
});

test('MEM01 version.author.actorId is the persisted actor_id and old history cannot be deleted', () => {
  const changed = structuredClone(input); setP0CValue(changed, 'memory_versions', 0, 'actor_id', 'different-actor'); rejected(run(changed), 'PC1B-MEM01');
  const index = ordinal('memory_versions', row => row.version === 1 && row.source === 'human');
  rejected(retained(input, row => row.table !== 'memory_versions' || row.rowOrdinal !== index), 'PC1B-MEM01');
});

test('MEM02 version historical source may disappear, while an extant source must have the same project-agent key', () => {
  const changed = structuredClone(input), index = ordinal('memory_versions', row => row.summary_request_id === null);
  setP0CValue(changed, 'memory_versions', index, 'summary_request_id', 'missing-old-request');
  assert.ok(ok(run(changed)).availability.some(item => item.code === 'missing-soft-source'));
  setP0CValue(changed, 'memory_versions', index, 'summary_request_id', p0CValue(input, 'memory_summary_requests', 0, 'id'));
  const result = run(changed); rejected(result, 'PC1B-MEM02');
  if (!result.ok) {
    assert.equal(result.error.location!.table, 'memory_versions'); assert.equal(result.error.location!.rowOrdinal, index);
    const table = changed.graph.observation.tables.find(value => value.name === 'memory_versions')!;
    assert.equal(result.error.location!.columnOrdinal, table.columns.indexOf('summary_request_id') + 1);
  }
});

test('AUD03 proves scalar grammar before the old consumer can coerce attacker JSON objects', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
  changeJson(changed, 'audit_log', index, 'after', value => { value.node.role = { toString: null, valueOf: null }; });
  rejected(run(changed), 'PC1B-AUD03');
});

test('AUD03 a known missing legacy generation does not hide malformed sibling v2 fields or pair edges', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
  for (const column of ['before', 'after']) changeJson(changed, 'audit_log', index, column, value => {
    value.assignments = [{ memberId: 'old-snapshot-member', nodeId: null, legacyRole: 'normal' }];
  });
  assert.ok(ok(run(changed)).availability.some(value => value.code === 'legacy-nonreversible-audit'));
  changeJson(changed, 'audit_log', index, 'after', value => { value.node.projectId = 'another-project'; });
  rejected(run(changed), 'PC1B-AUD03');
});

test('MEM02 source and retry references are directional soft history, including absent message selectors', () => {
  const changed = structuredClone(input), index = ordinal('memory_summary_requests', row => row.trigger === 'retry');
  setP0CValue(changed, 'memory_summary_requests', index, 'retry_of_request_id', 'missing-prior-request');
  setP0CValue(changed, 'memory_summary_requests', index, 'source_work_event_id', 'missing-prior-source');
  setP0CValue(changed, 'memory_summary_requests', index, 'message_ids', '["missing-prior-message"]');
  const result = ok(run(changed)); assert.ok(result.availability.filter(value => value.code === 'missing-soft-source').length >= 3);
});

test('MEM02 extant retry cannot silently switch project/agent/task source', () => {
  const changed = structuredClone(input), index = ordinal('memory_summary_requests', row => row.trigger === 'retry');
  setP0CValue(changed, 'memory_summary_requests', index, 'retry_of_request_id', p0CValue(input, 'memory_summary_requests', index, 'id'));
  rejected(run(changed), 'PC1B-MEM02');
});

test('MEM02 evidence grammar, time order and actual output digest remain mandatory', () => {
  const index = ordinal('memory_summary_requests', row => row.state === 'completed');
  for (const change of [(v: any) => { v.provenance = 'platform-verified'; }, (v: any) => { v.outputSha256 = '0'.repeat(64); },
    (v: any) => { v.completedAt = '2000-01-01T00:00:00Z'; }, (v: any) => { v.host = '\0'; }]) {
    const changed = structuredClone(input); changeJson(changed, 'memory_summary_requests', index, 'evidence', change);
    rejected(run(changed), 'PC1B-MEM02');
  }
});

test('MEM02 error and author JSON are exact shape; duplicate decoded keys are rejected before consumption', () => {
  const failed = ordinal('memory_summary_requests', row => row.state === 'failed');
  const changed = structuredClone(input); setP0CValue(changed, 'memory_summary_requests', failed, 'error', '{"code":"x","message":"x","extra":true}');
  rejected(run(changed), 'PC1B-MEM02');
  setP0CValue(changed, 'memory_summary_requests', failed, 'error', '{"code":"x","co\\u0064e":"y","message":"x"}');
  rejected(run(changed), 'PC1B-RAW01');
});

test('MEM03 checkpoint cursor is a strict ordered position and is not a live entity reference', () => {
  const changed = structuredClone(input), index = 0;
  setP0CValue(changed, 'memory_scan_checkpoints', index, 'after_cursor', '{"at":"a","id":"no-such-row"}');
  setP0CValue(changed, 'memory_scan_checkpoints', index, 'through_cursor', '{"at":"b","id":"also-absent"}'); ok(run(changed));
  setP0CValue(changed, 'memory_scan_checkpoints', index, 'after_cursor', '{"at":"z","id":"no-such-row"}'); rejected(run(changed), 'PC1B-MEM03');
  setP0CValue(changed, 'memory_scan_checkpoints', index, 'after_cursor', '{"at":"a","id":"x","extra":true}'); rejected(run(changed), 'PC1B-MEM03');
});

test('MEM03 checkpoint ID is the exact producer tuple and counter limits are preserved', () => {
  const changed = structuredClone(input); setP0CValue(changed, 'memory_scan_checkpoints', 0, 'id', 'not-the-producer-tuple'); rejected(run(changed), 'PC1B-MEM03');
  const other = structuredClone(input); setP0CValue(other, 'memory_trigger_counters', 0, 'configured_n', 10001); rejected(run(other), 'PC1B-MEM03');
});

test('MEM03 deleting receipts does not recount lifetime counters; surviving receipts keep their real message FK', () => {
  ok(retained(input, row => row.table !== 'memory_message_receipts'));
  const message = p0CValue(input, 'memory_message_receipts', 0, 'message_id');
  const index = ordinal('messages', row => row.id === message);
  rejected(retained(input, row => row.table !== 'messages' || row.rowOrdinal !== index), 'PC1B-MEM03');
});

test('MEM04 authentic completion token cannot be forged, crossed between requests or reused for retained rows', () => {
  const req = request(), other = request(), observed = ok(checkP0TaskDecisionWorkEvents(req));
  for (const token of [{} as P0CompletionIndex, ok(checkP0TaskDecisionWorkEvents(other)).completion]) {
    const result = checkP0AuditMemory(req, token); assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
  }
  const view = retainP0Rows(req, req.input.graph.observation.tables.flatMap(table => req.original.rows(table.name as P0Table)));
  assert.equal(checkP0AuditMemory(req, observed.completion, view).ok, false);
  ok(checkP0AuditMemory(req, ok(checkP0TaskDecisionWorkEvents(req, view)).completion, view));
});

test('MEM04 legacy pre-Decision source may disappear without losing its request or notification', () => {
  const requestIndex = ordinal('memory_summary_requests', row => row.trigger === 'task_completed' && row.completed_task_revision === 1);
  const eventId = p0CValue(input, 'memory_summary_requests', requestIndex, 'source_work_event_id');
  const eventIndex = ordinal('work_events', row => row.id === eventId);
  const result = ok(retained(input, row => row.table !== 'work_events' || row.rowOrdinal !== eventIndex));
  assert.ok(result.availability.some(value => value.code === 'missing-soft-source' && value.location.rowOrdinal === requestIndex));
});

test('MEM04 an extant completion must match immutable agent/revision/trigger identity, while ACK is irrelevant', () => {
  const index = ordinal('memory_summary_requests', row => row.trigger === 'task_completed' && row.state === 'completed');
  for (const [column, value] of [['completed_task_revision', 999], ['trigger_key', 'different-trigger']] as const) {
    const changed = structuredClone(input); setP0CValue(changed, 'memory_summary_requests', index, column, value); rejected(run(changed), 'PC1B-MEM04');
  }
});

test('MEM05 fixed event identity, saved revision and context are checked against the actual request', () => {
  const index = ordinal('work_events', row => row.kind === 'memory.summary_requested' && row.context_group_id !== null);
  for (const [column, value] of [['event_key', 'wrong-key'], ['id', 'wrong-notification'], ['context_group_id', null]] as const) {
    const changed = structuredClone(input); setP0CValue(changed, 'work_events', index, column, value); rejected(run(changed), 'PC1B-MEM05');
  }
  const changed = structuredClone(input); changeJson(changed, 'work_events', index, 'payload', value => { value.requestRevision = 1000; }); rejected(run(changed), 'PC1B-MEM05');
});

test('MEM05 initial cancelled request without a notification is legitimate, and deleting a request plus its notification preserves version history', () => {
  const cancelled = ordinal('memory_summary_requests', row => row.state === 'cancelled');
  const id = p0CValue(input, 'memory_summary_requests', cancelled, 'id');
  assert.equal(p0CRows(input, 'work_events').some(row => row.id === `memory-summary:${id}`), false); ok(run());
  const complete = ordinal('memory_summary_requests', row => row.state === 'completed'), completeId = p0CValue(input, 'memory_summary_requests', complete, 'id');
  const event = ordinal('work_events', row => row.id === `memory-summary:${completeId}`);
  ok(retained(input, row => !(row.table === 'memory_summary_requests' && row.rowOrdinal === complete) && !(row.table === 'work_events' && row.rowOrdinal === event)));
});

test('D rejects hostile request/view/token without reading properties or prototypes', () => {
  const req = request(), completion = ok(checkP0TaskDecisionWorkEvents(req)).completion;
  let touches = 0;
  const poison = new Proxy({}, { get() { touches++; throw 0; }, getPrototypeOf() { touches++; throw 0; }, ownKeys() { touches++; throw 0; }, getOwnPropertyDescriptor() { touches++; throw 0; } });
  assert.equal(checkP0AuditMemory(poison as P0Request, completion).ok, false);
  assert.equal(checkP0AuditMemory(req, completion, poison as P0View).ok, false);
  assert.equal(checkP0AuditMemory(req, poison as P0CompletionIndex).ok, false); assert.equal(touches, 0);
});

test('D actual shared Memory body native unknown throw remains unlocated and opaque', () => {
  const req = request(), completion = ok(checkP0TaskDecisionWorkEvents(req)).completion;
  new P0DContext(req, req.original); // Own all scalar decodes first; injection is in the actual shared body kernel.
  const body = p0CValue(input, 'memory_documents', 0, 'markdown');
  let touches = 0, throws = 0;
  const poison = new Proxy({}, { get() { touches++; throw 0; }, getPrototypeOf() { touches++; throw 0; }, ownKeys() { touches++; throw 0; } });
  const original = Buffer.from;
  Buffer.from = function (...args: any[]) { if (args[0] === body) { throws++; throw poison; } return Reflect.apply(original, Buffer, args); } as typeof Buffer.from;
  let result: P0Result<unknown>;
  try { result = checkP0AuditMemory(req, completion); } finally { Buffer.from = original; }
  assert.equal(throws, 1); assert.equal(touches, 0); assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.code, 'invalid_value'); assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
});

test('D actual shared audit snapshot sort unknown throw remains unlocated and opaque', () => {
  const changed = structuredClone(input), index = ordinal('audit_log', row => row.action === 'org.node_update');
  for (const column of ['before', 'after']) changeJson(changed, 'audit_log', index, column, value => {
    value.childEdges = [{ nodeId: 'd-unknown-native-sort', parentId: value.targetId }];
    value.directChildIds = ['d-unknown-native-sort'];
  });
  const req = request(changed), completion = ok(checkP0TaskDecisionWorkEvents(req)).completion;
  let touches = 0, throws = 0;
  const poison = new Proxy({}, { get() { touches++; throw 0; }, getPrototypeOf() { touches++; throw 0; }, ownKeys() { touches++; throw 0; } });
  const original = Array.prototype.sort;
  Array.prototype.sort = function (compare?: any) {
    if (this.length === 1 && this[0] === 'd-unknown-native-sort') { throws++; throw poison; }
    return Reflect.apply(original, this, [compare]);
  };
  let result: P0Result<unknown>;
  try { result = checkP0AuditMemory(req, completion); } finally { Array.prototype.sort = original; }
  assert.equal(throws, 1); assert.equal(touches, 0); assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.code, 'invalid_value'); assert.equal(result.error.rule, null); assert.equal(result.error.location, null); }
});

test('D reserves work against the same A ledger and cannot clear exhaustion on retry', () => {
  const req = request(), completion = ok(checkP0TaskDecisionWorkEvents(req)).completion;
  chargeP0(req, { bytes: 64 * 1024 * 1024 - p0Usage(req).bytes });
  const result = checkP0AuditMemory(req, completion); assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'resource_limit');
  assert.deepEqual(checkP0AuditMemory(req, completion), result);
  assert.equal(p0Usage(req).bytes, 64 * 1024 * 1024);
});

test('AUD02 actual shared transition kernel preserves the 1000-node boundary and cycle rejection', () => {
  function walk(count: number, cycle = false): void {
    const packets: AuditChainValue[] = Array.from({ length: count }, (_, index) => ({
      row: { id: `chain-${index}`, projectId: 'historical-project', targetKind: 'node', targetId: 'historical-node',
        action: index === 0 ? 'org.node_update' : 'org.revoke', detail: null,
        reversedAt: index === count - 1 ? null : 'old-time', reversedByAuditId: index === count - 1 ? null : `chain-${index + 1}` },
      detail: index === 0 ? null : { undoes: `chain-${index - 1}` },
    }));
    if (cycle) packets[0] = { row: { ...packets[0]!.row, action: 'org.revoke' }, detail: { undoes: 'chain-0' } };
    const rows = new Map(packets.map(packet => [packet.row.id, packet]));
    const walker = auditChainSteps(packets.at(-1)!); let step = walker.next();
    while (!step.done) step = walker.next(rows.get(step.value) ?? null);
    assert.equal(step.value.rootAuditId, 'chain-0');
  }
  walk(1000);
  for (const run of [() => walk(1001), () => walk(2, true)]) assert.throws(run, error => getRepositoryErrorCode(error) === 'chain_broken');
});

test('AUD03 registered graph snapshots retain the exact 512-element boundary', () => {
  const index = ordinal('audit_log', row => row.action === 'org.node_update');
  for (const count of [512, 513]) {
    const changed = structuredClone(input);
    for (const column of ['before', 'after']) changeJson(changed, 'audit_log', index, column, value => {
      value.childEdges = Array.from({ length: count }, (_, i) => ({ nodeId: `c${String(i).padStart(3, '0')}`, parentId: null }));
      value.directChildIds = [];
    });
    const result = run(changed); if (count === 512) ok(result); else rejected(result, 'PC1B-AUD03');
  }
});

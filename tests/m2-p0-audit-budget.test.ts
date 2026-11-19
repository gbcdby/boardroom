import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { chargeP0, createP0Request, p0Usage, retainP0Rows, withP0Guard } from '../src/server/identity/internal/m2-p0.ts';
import type { P0Request, P0Result, P0Table, P0View } from '../src/server/identity/internal/m2-p0.ts';
import { checkP0TaskDecisionWorkEvents } from '../src/server/identity/internal/m2-p0-task-decision-work-events.ts';
import { checkP0AuditMemory } from '../src/server/identity/internal/m2-p0-audit-memory.ts';
import { noteDAvailability } from '../src/server/identity/internal/m2-p0-audit.ts';
import type { P0DAvailability } from '../src/server/identity/internal/m2-p0-audit.ts';
import { P0DContext } from '../src/server/identity/internal/m2-p0-d-context.ts';
import { makeP0DFixture } from './helpers/m2-p0-d-fixture.ts';
import { appendP0CRow, p0CRows, type P0CInput } from './helpers/m2-p0-c-fixture.ts';

let input: P0CInput;
before(async () => { const fixture = await makeP0DFixture(); input = fixture.input; await fixture.close(); });
function ok<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
function fixture(action: string): P0CInput {
  const value = structuredClone(input), template = p0CRows(input, 'audit_log').find(row => row.action === 'fixture.display')!;
  for (const table of value.graph.observation.tables) { table.rows = []; table.count = '0'; }
  const member = { id: 'old-member', projectId: template.project_id, nodeId: null, role: 'normal', status: 'active', kind: 'human',
    agentId: null, displayName: '历史成员', createdAt: 'created', updatedAt: 'updated', membershipRevision: 7 };
  const node = { id: 'old-node', projectId: template.project_id, parentId: null, name: '岗位', role: 'top_manager', sortOrder: 0.5,
    createdAt: 'created', updatedAt: 'updated' };
  const isNode = action.startsWith('org.node_'), targetKind = isNode || action === 'org.auto_place' ? 'node' : 'member';
  appendP0CRow(value, 'audit_log', { ...template, id: 'budget-audit', action, target_kind: targetKind,
    target_id: targetKind === 'node' ? node.id : member.id, changed: null,
    before: JSON.stringify(isNode ? action === 'org.node_create' ? null : node : member),
    after: JSON.stringify(isNode ? { ...node, name: '更新岗位' } : { ...member, nodeId: 'old-node', status: 'disabled' }),
    detail: JSON.stringify({ reversal: { version: 2, rootAuditId: 'budget-audit', rootAction: action, undoesAuditId: null, direction: 'forward' } }),
    reversed_at: null, reversed_by_audit_id: null });
  return value;
}
function context(value: P0CInput, phase: 'original' | 'retained'): { request: P0Request; view: P0View } {
  const request = ok(createP0Request(JSON.stringify(value)));
  if (phase === 'original') return { request, view: request.original };
  const c = ok(checkP0TaskDecisionWorkEvents(request)); ok(checkP0AuditMemory(request, c.completion));
  return { request, view: retainP0Rows(request, request.input.graph.observation.tables.flatMap(table => request.original.rows(table.name as P0Table))) };
}
function resource(result: P0Result<unknown>): void {
  assert.equal(result.ok, false); if (result.ok) return; assert.equal(result.error.code, 'resource_limit');
}

for (const action of ['org.assign', 'org.auto_place', 'member.pause', 'member.resume', 'member.status_change', 'org.node_create', 'org.node_update']) {
  test(`旧 ${action} 的实际归一化在原图和保留图各自收节点费，满额先拒绝`, () => {
    for (const phase of ['original', 'retained'] as const) {
      for (const remaining of [10000, 0]) {
        const { request, view } = context(fixture(action), phase), completion = ok(checkP0TaskDecisionWorkEvents(request, view)).completion;
        const original = P0DContext.prototype.json; let beforeNodes = 0, hits = 0;
        P0DContext.prototype.json = function(row, column, rule, policy) {
          const parsed = Reflect.apply(original, this, [row, column, rule, policy]);
          if (row.values.id === 'budget-audit' && column === 'after' && rule === 'PC1B-AUD03' && policy === 'finite') {
            chargeP0(request, { nodes: 250000 - p0Usage(request).nodes - remaining }); beforeNodes = p0Usage(request).nodes; hits++;
          }
          return parsed;
        };
        let result;
        try { result = checkP0AuditMemory(request, completion, view); } finally { P0DContext.prototype.json = original; }
        assert.equal(hits, 1);
        if (remaining === 0) { resource(result); assert.equal(p0Usage(request).nodes, 250000); }
        else { ok(result); assert.ok(p0Usage(request).nodes - beforeNodes >= (action.includes('assign') || action === 'org.auto_place' ? 36 : 22)); }
      }
    }
  });
}

test('availability 的真实索引在零/一 tuple 余额不插入，精确余额成功且缓存命中不重复插入', () => {
  for (const remaining of [0, 1, 2]) {
    const request = ok(createP0Request(JSON.stringify(fixture('org.assign')))), c = new P0DContext(request, request.original);
    const row = c.rows('audit_log')[0]!, output: P0DAvailability[] = [];
    chargeP0(request, { tuples: 250000 - p0Usage(request).tuples - remaining });
    const originalSet = Set.prototype.add, originalWeakMap = WeakMap.prototype.set; let inserts = 0;
    Set.prototype.add = function(value) { if (new Error().stack?.split('\n')[2]?.includes('at noteDAvailability ')) inserts++; return Reflect.apply(originalSet, this, [value]); };
    WeakMap.prototype.set = function(key, value) { if (new Error().stack?.split('\n')[2]?.includes('at noteDAvailability ')) inserts++; return Reflect.apply(originalWeakMap, this, [key, value]); };
    let result;
    try {
      result = withP0Guard(request, () => { noteDAvailability(c, output, row, 'PC1B-AUD01', 'changed', 'legacy-display-unavailable');
        noteDAvailability(c, output, row, 'PC1B-AUD01', 'changed', 'legacy-display-unavailable'); return output.length; });
    } finally { Set.prototype.add = originalSet; WeakMap.prototype.set = originalWeakMap; }
    if (remaining < 2) { resource(result); assert.equal(inserts, 0); assert.equal(output.length, 0); }
    else { assert.equal(ok(result), 1); assert.equal(inserts, 2); assert.equal(p0Usage(request).tuples, 250000); }
  }
});

test('审计链实际 packet 在其费用不足时不插入，原/保留两遍均保留逐边收费', () => {
  for (const phase of ['original', 'retained'] as const) for (const remaining of [10000, 0]) {
    const { request, view } = context(fixture('org.assign'), phase), completion = ok(checkP0TaskDecisionWorkEvents(request, view)).completion;
    const originalBytes = P0DContext.prototype.bytes, originalSet = WeakMap.prototype.set; let hits = 0, packets = 0;
    P0DContext.prototype.bytes = function(row, column) {
      const value = Reflect.apply(originalBytes, this, [row, column]);
      if (row.values.id === 'budget-audit' && column === 'id' && hits === 0) { hits++; chargeP0(request, { tuples: 250000 - p0Usage(request).tuples - remaining }); }
      return value;
    };
    WeakMap.prototype.set = function(key, value) { if (new Error().stack?.split('\n')[2]?.includes('at packet ')) packets++; return Reflect.apply(originalSet, this, [key, value]); };
    let result;
    try { result = checkP0AuditMemory(request, completion, view); } finally { P0DContext.prototype.bytes = originalBytes; WeakMap.prototype.set = originalSet; }
    assert.equal(hits, 1);
    if (remaining === 0) { resource(result); assert.equal(packets, 0); }
    else { ok(result); assert.equal(packets, 1); }
  }
});

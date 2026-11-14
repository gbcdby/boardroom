import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { initializePolicyConfiguration } from '../src/server/policy/configuration.ts';
import { createDecisionService } from '../src/server/decisions/service.ts';
import { actorForMember } from '../src/server/authz/actors.ts';
import { readDecisionProjectGraph } from '../src/server/decisions/repository.ts';
import { validateDecisionStorageGraph } from '../src/server/decisions/storage-validation.ts';
import { StorageInvalid } from '../src/server/decisions/storage-error.ts';
import type { LiveDecisionView } from '../src/shared/decisions.ts';

for (const engine of identityEngines) test(`${engine}: R-157-STD-002 live completion binds immutable assignee, stable Agent and actual enteredDone`, { skip: identitySkip(engine) }, async () => {
  const f = await identityFixture(engine);
  try {
    await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db);
    const first = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === 'live-review-decision' && d.isCurrent) as LiveDecisionView;
    const manager = { actor: actorForMember(p.manager) };
    const applied = await service.resolve(manager, p.project.id, first.ref.decisionId,
      { decisionRef: first.ref, choiceId: 'approve', reason: '真实完成', idempotencyKey: 'complete' });
    const execution = applied.receipt.execution; assert.ok(execution?.status === 'succeeded');
    const graph = await f.db.readSnapshot(read => readDecisionProjectGraph(read, p.project.id));
    const original = graph.work_events!.find(row => row.id === execution.workEventIds[0])!;
    const mutatePayload = (row: Record<string, unknown>, patch: Record<string, unknown>) => { row.payload = JSON.stringify({ ...JSON.parse(String(row.payload)), ...patch }); };
    for (const [name, mutate] of [
      ['recipient', (row: Record<string, unknown>) => { row.recipient_member_id = p.reviewer.id; }],
      ['assigneeAgentId', (row: Record<string, unknown>) => mutatePayload(row, { assigneeAgentId: p.reviewer.agentId })],
      ['enteredDone', (row: Record<string, unknown>) => mutatePayload(row, { enteredDone: false })],
    ] as const) {
      const bad = structuredClone(graph), row = bad.work_events!.find(e => e.id === original.id)!;
      mutate(row); assert.throws(() => validateDecisionStorageGraph(bad), StorageInvalid, name);
      await f.db.exec('UPDATE work_events SET recipient_member_id=?,payload=? WHERE id=?', [row.recipient_member_id, row.payload, row.id]);
      await assert.rejects(f.db.readSnapshot(read => readDecisionProjectGraph(read, p.project.id)), StorageInvalid);
      const through = await f.repos.memory.scanHighWater({ kind: 'task_completed', projectId: p.project.id, agentId: p.reviewer.agentId!, groupId: null });
      assert.ok(through);
      await assert.rejects(f.repos.memory.scanUnmaterializedTaskCompletions(p.project.id, p.reviewer.agentId!, { after: null, through, limit: 50 }), StorageInvalid,
        'Memory cannot accept a corrupt new live completion, including a transplanted target Agent');
      await f.db.exec('UPDATE work_events SET recipient_member_id=?,payload=? WHERE id=?', [original.recipient_member_id, original.payload, original.id]);
    }
    const incomplete = { ...structuredClone(graph), work_events: [] };
    assert.throws(() => validateDecisionStorageGraph(incomplete), StorageInvalid, 'missing actual effect event');
    const round = (await f.repos.tasks.getRound(p.project.id, p.task.id, p.round.id))!;
    const corrected = await p.service.decideReview(manager, p.project.id, p.task.id, p.round.id,
      { expectedTaskRevision: applied.task.revision, expectedRoundRevision: round.revision, verdict: 'pass', reason: '已 done 后明确同结论更正', override: true });
    assert.equal(corrected.state, 'applied');
    const after = await f.db.readSnapshot(read => readDecisionProjectGraph(read, p.project.id));
    const effects = after.work_events!.filter(e => e.kind === 'task.review_decided');
    assert.deepEqual(effects.map(e => JSON.parse(String(e.payload)).enteredDone).sort(), [false, true]);
    const through = await f.repos.memory.scanHighWater({ kind: 'task_completed', projectId: p.project.id, agentId: p.worker.agentId!, groupId: null });
    const sources = await f.repos.memory.scanUnmaterializedTaskCompletions(p.project.id, p.worker.agentId!, { after: null, through: through!, limit: 50 });
    assert.deepEqual(sources.rows.map(s => s.eventId), [original.id]);
  } finally { await f.close(); }
});

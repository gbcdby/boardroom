import test from 'node:test';
import assert from 'node:assert/strict';
import { identityEngines, identityFixture, identitySkip } from './helpers/identity-fixture.ts';
import { decisionDomainFixture } from './helpers/decision-domain-fixture.ts';
import { createDecisionService } from '../src/server/decisions/service.ts';
import { initializePolicyConfiguration, createPolicyConfiguration } from '../src/server/policy/configuration.ts';
import { actorForMember } from '../src/server/authz/actors.ts';
import { DB_REVIEW_HANDLER } from '../src/server/decisions/effect.ts';
import type { DecisionService } from '../src/server/decisions/service.ts';
import type { LiveDecisionView } from '../src/shared/decisions.ts';

type Domain = Awaited<ReturnType<typeof decisionDomainFixture>>;
async function current(service: DecisionService, p: Domain): Promise<LiveDecisionView> {
  const value = (await service.list(p.owner, p.project.id)).decisions.find(d => d.recordKind === 'live-review-decision' && d.isCurrent);
  assert.ok(value && value.recordKind === 'live-review-decision'); return value;
}
for (const engine of identityEngines) {
  test(`${engine}: R-157-REQ-001 matching head cannot supersede an identical pending canonical action`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), first = await current(service, p);
      const manager = { actor: actorForMember(p.manager) };
      const tables = ['decision_action_requests','decision_records','decision_review_heads','decision_changes','work_events','task_history','audit_log'];
      const capture = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await f.db.query(`SELECT * FROM ${table}`)).map(row => JSON.stringify(row)).sort()])));
      const before = await capture();
      const input = { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, proposedVerdict: 'pass' as const,
        requestedPath: 'management' as const, reason: '新理由不得覆盖原不可变提案', expectedHead: first.head, idempotencyKey: 'matching-pending' };
      const result = await service.request(manager, p.slot, input);
      assert.deepEqual(result.decisionRef, first.ref); assert.deepEqual(result.head, first.head); assert.equal(result.state, 'pending');
      assert.equal(result.current.actionRequest.proposalReason, first.actionRequest.proposalReason);
      assert.deepEqual(await capture(), before, 'only the new command receipt may be added');
      const again = await service.request(manager, p.slot, { ...input, reason: '另一条理由', idempotencyKey: 'another-matching-pending' });
      assert.deepEqual(again.decisionRef, first.ref); assert.deepEqual(await capture(), before);
      const receipts = await f.db.query('SELECT * FROM decision_command_receipts'); assert.equal(receipts.length, 2);
      await assert.rejects(service.request(manager, p.slot, { ...input, expectedHead: { ...first.head, headRevision: first.head.headRevision + 1 }, idempotencyKey: 'wrong-head' }), { reason: 'head_revision_conflict' });
      assert.deepEqual(await f.db.query('SELECT * FROM decision_command_receipts'), receipts);
      assert.deepEqual(await capture(), before);
    } finally { await f.close(); }
  });

  test(`${engine}: #157 terminal choices notify the current reviewer and assignee exactly once without false completion`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos);
      for (const choiceId of ['approve', 'reject', 'request_changes'] as const) {
        const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), decision = await current(service, p);
        const manager = { actor: actorForMember(p.manager) }, input = { decisionRef: decision.ref, choiceId, reason: '实际终局结果', idempotencyKey: `notify-${choiceId}` };
        const applied = await service.resolve(manager, p.project.id, decision.ref.decisionId, input);
        const events = await f.db.query("SELECT * FROM work_events WHERE project_id=? AND kind='decision.resolved' ORDER BY recipient_member_id", [p.project.id]);
        assert.deepEqual(events.map(e => e.recipient_member_id).sort(), [p.worker.id, p.reviewer.id].sort());
        for (const event of events) {
          assert.equal(event.event_key, `decision:${decision.ref.decisionId}:${applied.decisionRef.revision}:${event.recipient_member_id}:resolved`);
          assert.deepEqual(JSON.parse(String(event.payload)), { taskId: p.task.id, roundId: p.round.id, decisionRef: applied.decisionRef,
            choiceId, executionStatus: applied.state === 'applied' ? 'succeeded' : 'not_required', verdict: choiceId === 'approve' ? 'pass' : null });
          assert.equal(event.delivery_state, 'pending'); assert.equal(event.acked_at, null);
        }
        const histories = await f.repos.tasks.listHistory(p.project.id, p.task.id);
        const outcome = histories.find(h => h.action === 'decision.resolved'); assert.ok(outcome);
        assert.equal(outcome.actor.actorId, p.manager.id); assert.equal(outcome.detail.choiceId, choiceId);
        assert.equal((await f.db.query("SELECT * FROM work_events WHERE project_id=? AND kind='task.review_decided'", [p.project.id])).length, choiceId === 'approve' ? 1 : 0);
        assert.equal(applied.task.revision, p.task.revision + (choiceId === 'approve' ? 1 : 0));
        await service.resolve(manager, p.project.id, decision.ref.decisionId, input);
        await service.resolve(manager, p.project.id, decision.ref.decisionId, { ...input, idempotencyKey: `equivalent-${choiceId}` });
        assert.deepEqual(await f.db.query("SELECT * FROM work_events WHERE project_id=? AND kind='decision.resolved' ORDER BY recipient_member_id", [p.project.id]), events);
        assert.deepEqual(await f.repos.tasks.listHistory(p.project.id, p.task.id), histories);
      }
    } finally { await f.close(); }
  });

  test(`${engine}: R-157-STD-001 legacy cannot invent a pending head CAS; explicit native successor and decided correction remain valid`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db);
      const manager = { actor: actorForMember(p.manager) }, first = await current(service, p);
      const tables = ['decision_action_requests','decision_records','decision_review_heads','decision_command_receipts','decision_executions','decision_changes','tasks','task_review_rounds','task_history','work_events','audit_log'];
      const capture = async () => Object.fromEntries(await Promise.all(tables.map(async name => [name, await f.db.query(`SELECT * FROM ${name} ORDER BY ${name === 'decision_review_heads' ? 'task_id' : name === 'decision_changes' ? 'revision' : 'id'}`)])));
      const before = await capture();
      const legacy = { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, verdict: 'changes_requested' as const, reason: '未观察 head 的相反提案', override: true };
      await assert.rejects(p.service.decideReview(manager, p.project.id, p.task.id, p.round.id, legacy), error => {
        const actual = error as { reason?: string; details?: { head?: unknown; currentRef?: unknown } };
        assert.equal(actual.reason, 'head_revision_conflict'); assert.deepEqual(actual.details?.head, first.head); assert.deepEqual(actual.details?.currentRef, first.ref); return true;
      });
      assert.deepEqual(await capture(), before, 'rejected legacy command has no successor, receipt, effect or audit');
      const proposed = await service.request(manager, p.slot, { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision,
        proposedVerdict: 'changes_requested', reason: '明确观察当前 head 后替代', requestedPath: 'management', expectedHead: first.head, idempotencyKey: 'explicit-head' });
      assert.equal(proposed.state, 'pending'); assert.equal(proposed.head.headRevision, 2);
      assert.equal((await service.get(p.owner, p.project.id, first.ref.decisionId) as LiveDecisionView).status, 'superseded');
      const applied = await service.resolve(manager, p.project.id, proposed.decisionRef.decisionId,
        { decisionRef: proposed.decisionRef, choiceId: 'approve', reason: '应用明确替代', idempotencyKey: 'apply-head' });
      const decided = (await f.repos.tasks.getRound(p.project.id, p.task.id, p.round.id))!;
      assert.equal(decided.state, 'decided');
      const corrected = await p.service.decideReview(manager, p.project.id, p.task.id, p.round.id,
        { expectedTaskRevision: applied.task.revision, expectedRoundRevision: decided.revision, verdict: 'pass', reason: '已裁决后使用新 CAS 明确更正', override: true });
      assert.equal(corrected.state, 'applied'); assert.equal(corrected.head.headRevision, 3); assert.equal(corrected.task.state, 'done');
    } finally { await f.close(); }
  });

  test(`${engine}: #157 command receipts preserve pending history, reasons, actors and equivalent terminal replay`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db);
      const manager = { actor: actorForMember(p.manager) }, decision = await current(service, p);
      assert.equal(decision.requiredAuthority, 'owner'); assert.equal(decision.savedEvaluation.purpose, 'eligibility-observation');
      assert.deepEqual(await f.db.query('SELECT * FROM decision_executions'), []);
      const before = await f.db.query('SELECT * FROM decision_records');
      await service.get(p.owner, p.project.id, decision.ref.decisionId); await service.list(p.owner, p.project.id); await service.changes(p.owner, p.project.id, 0);
      assert.deepEqual(await f.db.query('SELECT * FROM decision_records'), before, 'reads never create approval, refresh or receipt');
      const legacy = { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, verdict: 'pass' as const, reason: '评审者明确请求' };
      const pending = await p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, legacy);
      assert.equal(pending.state, 'pending'); assert.equal(pending.receipt.httpStatus, 202); assert.equal(pending.task.state, 'review');
      assert.deepEqual(await f.db.query('SELECT * FROM decision_local_initiations'), []);
      await assert.rejects(p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, { ...legacy, reason: '同旧 CAS 改理由' }), { reason: 'idempotency_conflict' });
      const input = { decisionRef: decision.ref, choiceId: 'approve' as const, reason: '实际管理者理由', idempotencyKey: 'manager-apply' };
      const applied = await service.resolve(manager, p.project.id, decision.ref.decisionId, input);
      assert.equal(applied.state, 'applied'); assert.equal(applied.current.resolution?.authority, 'owner');
      assert.equal(applied.current.resolution?.actor.id, p.manager.id); assert.equal(applied.current.resolution?.actualExecutionPath, 'management');
      const replay = await p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, legacy);
      assert.equal(replay.replay, 'same-key'); assert.equal(replay.state, 'pending'); assert.equal(replay.receipt.httpStatus, 202);
      assert.equal(replay.current.status, 'resolved'); assert.deepEqual(replay.receipt, pending.receipt);
      const equivalent = await service.resolve(manager, p.project.id, decision.ref.decisionId, { ...input, idempotencyKey: 'another-key', reason: '不能覆盖已保存理由' });
      assert.equal(equivalent.replay, 'equivalent'); assert.deepEqual(equivalent.receipt, applied.receipt);
      await assert.rejects(service.resolve(manager, p.project.id, decision.ref.decisionId, { ...input, choiceId: 'reject', idempotencyKey: 'opposite' }), { reason: 'decision_terminal' });
      assert.equal((await f.db.query('SELECT * FROM decision_command_receipts')).length, 2);
      assert.equal((await f.db.query('SELECT * FROM decision_executions')).length, 1);
      await f.repos.members.setStatus(p.reviewer.id, 'disabled');
      await assert.rejects(p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, legacy), { name: 'ForbiddenError' }, 'receipt cannot bypass current read authorization');
    } finally { await f.close(); }
  });

  test(`${engine}: #157 policy changes commit a durable 409; fresh keys cannot create human provenance or conceal deny`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), policy = createPolicyConfiguration({ repos: f.repos });
      const manager = { actor: actorForMember(p.manager) }, decision = await current(service, p);
      let global = await policy.getGlobal(p.owner);
      await policy.updateGlobal(p.owner, { expectedRevision: global.ref.revision, rules: global.document.rules.map(r => r.ruleId === 'default.review.decide' ? { ...r, outcome: 'human', requiresFreshHuman: true } : r) });
      const input = { decisionRef: decision.ref, choiceId: 'approve' as const, reason: '旧策略下选择', idempotencyKey: 'old-choice' };
      const refreshed = await service.resolve(manager, p.project.id, decision.ref.decisionId, input);
      assert.equal(refreshed.state, 'refreshed'); assert.equal(refreshed.receipt.httpStatus, 409); assert.equal(refreshed.decisionRef.revision, decision.ref.revision + 1);
      assert.deepEqual((await service.resolve(manager, p.project.id, decision.ref.decisionId, input)).receipt, refreshed.receipt);
      for (const choiceId of ['approve', 'reject', 'request_changes'] as const)
        await assert.rejects(service.resolve(manager, p.project.id, decision.ref.decisionId, { decisionRef: refreshed.decisionRef, choiceId, reason: '不能自发人工来源', idempotencyKey: choiceId }), { reason: 'human_intent_required' });
      await assert.rejects(service.chooseLocal(p.owner, p.project.id, decision.ref.decisionId,
        { decisionRef: refreshed.decisionRef, choiceId: 'approve', reason: '不能猜测来源对象', clientMutationId: 'forged-local' }, {} as never), { reason: 'source_binding_mismatch' });
      global = await policy.getGlobal(p.owner);
      await policy.updateGlobal(p.owner, { expectedRevision: global.ref.revision, rules: global.document.rules.map(r => r.ruleId === 'default.review.decide' ? { ...r, outcome: 'deny', requiresFreshHuman: false } : r) });
      const denied = await service.refresh(manager, p.project.id, decision.ref.decisionId, { decisionRef: refreshed.decisionRef, idempotencyKey: 'refresh-deny' });
      assert.equal(denied.state, 'refreshed'); assert.equal(denied.requiredAuthority, null);
      await assert.rejects(service.resolve(manager, p.project.id, decision.ref.decisionId, { decisionRef: denied.decisionRef, choiceId: 'reject', reason: '不能用拒绝隐藏策略阻塞', idempotencyKey: 'deny-reject' }), { reason: 'forbidden' });
      for (const table of ['decision_user_events','decision_local_initiations','decision_resolutions','decision_executions']) assert.deepEqual(await f.db.query(`SELECT * FROM ${table}`), []);
      assert.equal((await f.repos.tasks.get(p.project.id, p.task.id))!.state, 'review');
      const originalReplay = await service.resolve(manager, p.project.id, decision.ref.decisionId, input);
      assert.equal(originalReplay.receipt.httpStatus, 409); assert.deepEqual(originalReplay.receipt, refreshed.receipt);
      assert.equal(originalReplay.current.ref.revision, denied.decisionRef.revision);
    } finally { await f.close(); }
  });

  test(`${engine}: #157 successors require current head; rejected old compatibility commands cannot reopen unchanged CAS`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db), manager = { actor: actorForMember(p.manager) };
      const first = await current(service, p), legacy = { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, verdict: 'pass' as const, reason: '原请求' };
      const pending = await p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, legacy);
      const rejected = await service.resolve(manager, p.project.id, first.ref.decisionId, { decisionRef: first.ref, choiceId: 'request_changes', reason: '退回提案，不改变任务 verdict', idempotencyKey: 'return-proposal' });
      assert.equal(rejected.state, 'not_required'); assert.equal(rejected.task.revision, p.task.revision); assert.equal(rejected.current.execution?.status, 'not_required');
      assert.equal((await f.repos.tasks.getRound(p.project.id, p.task.id, p.round.id))!.state, 'reported');
      assert.deepEqual((await p.service.decideReview(p.reviewerAccess, p.project.id, p.task.id, p.round.id, legacy)).receipt, pending.receipt);
      await assert.rejects(p.service.decideReview(manager, p.project.id, p.task.id, p.round.id, { ...legacy, override: true }), { reason: 'decision_terminal' });
      const requested = { expectedTaskRevision: p.task.revision, expectedRoundRevision: p.round.revision, proposedVerdict: 'changes_requested' as const,
        requestedPath: 'management' as const, reason: '明确新提案', idempotencyKey: 'new-proposal' };
      await assert.rejects(service.request(manager, p.slot, requested), { reason: 'decision_terminal' });
      const next = await service.request(manager, p.slot, { ...requested, expectedHead: first.head });
      assert.notEqual(next.decisionRef.decisionId, first.ref.decisionId); assert.equal(next.head.headRevision, first.head.headRevision + 1);
      assert.equal(next.current.actionRequest.action.payload.choice, 'changes_requested');
      const stored = await f.db.query('SELECT * FROM decision_records WHERE id=?', [first.ref.decisionId]);
      assert.equal(stored[0]!.status, 'resolved'); assert.equal(stored[0]!.revision, rejected.decisionRef.revision);
      await assert.rejects(service.request(manager, p.slot, { ...requested, idempotencyKey: 'stale-head', expectedHead: first.head }), { reason: 'head_revision_conflict' });
      const applied = await service.resolve(manager, p.project.id, next.decisionRef.decisionId, { decisionRef: next.decisionRef, choiceId: 'approve', reason: '批准明确的修改要求', idempotencyKey: 'apply-successor' });
      assert.equal(applied.task.state, 'in-progress'); assert.equal(applied.current.execution?.verdict, 'changes_requested');
      assert.deepEqual(await f.db.query('SELECT * FROM decision_records WHERE id=?', [first.ref.decisionId]), stored);
      assert.equal((await f.db.query("SELECT * FROM work_events WHERE kind='task.review_decided'")).length, 1);
    } finally { await f.close(); }
  });

  test(`${engine}: #157 Task changes and project archive cancel pending while terminal records remain byte-for-byte`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db);
      const first = await current(service, p);
      await p.service.update(p.owner, p.project.id, p.task.id, { expectedRevision: p.task.revision, body: '明确更换验收候选' });
      const cancelled = await service.get(p.owner, p.project.id, first.ref.decisionId); assert.equal(cancelled.recordKind, 'live-review-decision');
      if (cancelled.recordKind !== 'live-review-decision') throw new Error('live required'); assert.equal(cancelled.status, 'cancelled');
      const q = await decisionDomainFixture(f.repos), second = await current(service, q);
      await f.repos.projects.archive(q.project.id);
      const archived = await service.get(q.owner, q.project.id, second.ref.decisionId); assert.equal(archived.recordKind, 'live-review-decision');
      if (archived.recordKind !== 'live-review-decision') throw new Error('live required'); assert.equal(archived.status, 'cancelled');
      const before = await f.db.query('SELECT * FROM decision_records ORDER BY id');
      await f.repos.projects.restore(q.project.id);
      assert.deepEqual(await f.db.query('SELECT * FROM decision_records ORDER BY id'), before);
      await assert.rejects(service.resolve({ actor: actorForMember(q.manager) }, q.project.id, second.ref.decisionId,
        { decisionRef: second.ref, choiceId: 'approve', reason: '恢复项目不能复活旧批准', idempotencyKey: 'after-restore' }), { reason: 'decision_terminal' });
    } finally { await f.close(); }
  });

  test(`${engine}: #157 an unavailable real handler cannot be replaced by a policy outcome`, { skip: identitySkip(engine) }, async () => {
    const f = await identityFixture(engine);
    try {
      await initializePolicyConfiguration(f.repos); const p = await decisionDomainFixture(f.repos), service = createDecisionService(f.db,
        { handler: { ...DB_REVIEW_HANDLER, available: false } }), decision = await current(service, p);
      await assert.rejects(service.resolve({ actor: actorForMember(p.manager) }, p.project.id, decision.ref.decisionId,
        { decisionRef: decision.ref, choiceId: 'approve', reason: '真实 handler 不可用', idempotencyKey: 'handler-disabled' }), { reason: 'handler_unavailable' });
      assert.deepEqual(await f.db.query('SELECT * FROM decision_command_receipts'), []);
      assert.deepEqual(await f.db.query('SELECT * FROM decision_executions'), []);
    } finally { await f.close(); }
  });
}

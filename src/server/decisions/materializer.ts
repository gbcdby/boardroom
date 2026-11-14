import { randomUUID } from 'node:crypto';
import type { DbDriver } from '../db/driver.ts';
import { createRepositories } from '../db/repositories.ts';
import type { DomainAccess } from '../mutation-access.ts';
import { actorForMember } from '../authz/actors.ts';
import { orgActorForMember } from '../authz/org-actors.ts';
import { appendAuditEntry } from '../audit.ts';
import { notifyResourceChange } from '../resource-changes.ts';
import { notifyWorkEventCommit } from '../tasks/events.ts';
import type { DbReviewHandlerDescriptorV1 } from '../policy/db-review.ts';
import type { ReviewSlot, ReviewPolicyActionV1, ReviewLockedTransaction } from './types.ts';
import { createDecisionRepository } from './repository.ts';
import { withLockedReviewTransaction, assertReviewTransaction } from './locked-transaction.ts';
import { encode } from './text-codec.ts';
import { DB_REVIEW_HANDLER } from './effect.ts';
import { activeMember, observeReviewPolicy, readCurrentReview, reviewAction, routeReviewOwner } from './review-state.ts';

/** 报告 hook/启动回填只有提案职责；不调用 resolver 或 Task 效果。 */
export async function materializeLockedReview(guard: ReviewLockedTransaction,
  input: { origin: 'review-reports' | 'legacy-bootstrap'; at: string; handler?: DbReviewHandlerDescriptorV1 }) {
  const { db, repos, slot } = assertReviewTransaction(guard);
  const existing = await db.query('SELECT * FROM decision_review_heads WHERE project_id=? AND task_id=? AND round_id=?',
    [slot.projectId, slot.taskId, slot.roundId]);
  if (existing.length) return { created: false, decisionId: String(existing[0]!.current_decision_id) };
  const subject = await readCurrentReview(repos, slot);
  if (subject.round.state !== 'reported') return { created: false, decisionId: null };
  const reviewer = subject.reviewer;
  // 无可重建的当前成员时不伪造 principal；显式初始化保留原逐来源诊断。
  if (!activeMember(reviewer, slot.projectId) || reviewer.kind !== 'agent' || reviewer.id !== subject.round.reviewerMemberId) {
    return { created: false, decisionId: null };
  }
  const actor = (await orgActorForMember(repos, reviewer.id)) ?? actorForMember(reviewer);
  const verdict = subject.reports.every(r => r.verdict === 'pass') ? 'pass' : 'changes_requested';
  const normalized = reviewAction(subject, verdict);
  const observation = await observeReviewPolicy(guard, subject, actor, 'reviewer', normalized.action as ReviewPolicyActionV1,
    input.handler ?? DB_REVIEW_HANDLER, 'eligibility-observation', 'proposal', input.at);
  const required = observation.status === 'evaluation_incomplete' || observation.outcome === 'deny' ? null
    : observation.requiresFreshHuman ? 'human' : observation.outcome;
  const assigned = required === 'auto' ? reviewer.id : required === 'owner' ? await routeReviewOwner(repos, subject) : null;
  const blocked = required === null ? observation.status === 'evaluation_incomplete' ? 'evaluation_incomplete'
    : observation.reasons[0]?.code ?? 'policy_denied' : required === 'owner' && !assigned ? 'assignee_unavailable' : null;
  const requestId = randomUUID(), decisionId = randomUUID();
  const rowSlot = { project_id: slot.projectId, task_id: slot.taskId, round_id: slot.roundId };
  await createDecisionRepository(db).write(guard, async writer => {
    await writer.insert('decision_action_requests', { id: requestId, ...rowSlot,
      action_json: encode('decision_action_requests.action_json', normalized.action),
      candidate_envelope_json: encode('decision_action_requests.candidate_envelope_json', subject.envelope),
      action_digest: normalized.actionDigest, candidate_digest: subject.candidateDigest,
      expected_task_revision: subject.task.revision, expected_round_revision: subject.round.revision,
      proposed_verdict: verdict, proposal_reason_json: encode('decision_action_requests.proposal_reason_json', '根据两轴评审报告生成待裁决提案'),
      requested_path: 'materializer', origin: input.origin, created_by_kind: 'system', created_by_id: 'review-materializer', created_at: input.at });
    await writer.insert('decision_records', { id: decisionId, ...rowSlot, action_request_id: requestId, action_digest: normalized.actionDigest,
      generation: 1, revision: 1, status: 'pending', required_authority: required, assignee_member_id: assigned,
      blocked_reason_code: blocked, policy_evaluation_json: encode('decision_records.policy_evaluation_json', observation),
      predecessor_decision_id: null, predecessor_legacy_id: null, created_at: input.at, updated_at: input.at });
    await writer.replaceHead({ ...rowSlot, head_revision: 1, current_decision_id: decisionId }, null);
    await writer.appendChange({ decisionId, decisionRevision: 1, kind: 'created', at: input.at });
    await appendAuditEntry(repos.audit, { projectId: slot.projectId, actor: { kind: 'system', name: 'review-materializer', memberId: null },
      action: 'decision.requested', targetKind: 'decision', targetId: decisionId, targetName: subject.task.title,
      detail: { ...slot, decisionId, decisionRevision: 1, requiredAuthority: required, blockedReason: blocked } });
    if (assigned) {
      const event = await repos.tasks.enqueueWorkEvent({ id: randomUUID(), projectId: slot.projectId, recipientMemberId: assigned,
        taskId: slot.taskId, kind: 'decision.requested', eventKey: `decision:${decisionId}:1:${assigned}:requested`,
        payload: { taskId: slot.taskId, decisionId, decisionRevision: 1 }, deliveryState: 'pending', attempts: 0,
        createdAt: input.at, firstDeliveredAt: null, lastDeliveredAt: null, ackedAt: null });
      await notifyWorkEventCommit(db, [event]);
    }
    await notifyResourceChange(db, { projectId: slot.projectId, entity: 'decision', id: decisionId, revision: 1 });
  });
  return { created: true, decisionId };
}

export async function materializeReview(db: DbDriver, access: DomainAccess, slot: ReviewSlot, at: string,
  handler?: DbReviewHandlerDescriptorV1) {
  // 历史 schema fixture 可以提交原报告；实际启动必先完成 v20 迁移及显式 initializer。
  if (!(await db.query('SELECT version FROM schema_migrations WHERE version=20')).length) return;
  return withLockedReviewTransaction(db, access, slot, guard => materializeLockedReview(guard,
    { origin: 'review-reports', at, ...(handler ? { handler } : {}) }));
}

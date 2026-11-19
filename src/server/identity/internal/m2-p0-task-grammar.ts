// Fixed Task/WorkEvent persistent grammars from PC r2 TASK-HISTORY-PATHS.
// User text and external evidence references are never recursively treated as row IDs.
import { z } from 'zod';
import { reviewCommandSchema, reviewEvidenceSchema } from '../../tasks/schemas.ts';

const text = z.string();
const id = z.string().min(1).max(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const state = z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']);
const verdict = z.enum(['pass', 'changes_requested']);
const axis = z.enum(['spec', 'standards']);
const acceptanceSource = z.enum(['explicit', 'legacy_task_body']);
export const p0TaskAuthorSchema = z.object({ kind: z.enum(['human', 'agent']), actorId: id, displayName: text }).strict();
export const p0DecisionRefSchema = z.object({ decisionId: id, projectId: id, revision,
  actionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
export const p0ReviewDecisionSchema = z.object({ verdict, actor: p0TaskAuthorSchema, reason: text,
  override: z.boolean(), taskRevision: revision, decisionRef: p0DecisionRefSchema.optional() }).strict();
export const p0ReviewFailureSchema = z.object({ code: text, message: text }).strict();
export const p0ReviewSnapshotSchema = z.object({ title: text, body: text, labels: z.array(text),
  deliveryKind: z.enum(['code', 'artifact', 'finding']).nullable().optional(),
  acceptanceText: text.optional(), acceptanceSource: acceptanceSource.optional() }).strict();
export const p0ReviewCandidateSchema = z.object({ repositoryRoot: text, fixedPointInput: text,
  baseCommit: text, candidateCommit: text, policy: z.literal('committed-clean'), gitVersion: text,
  diff: text, diffSha256: digest, commits: z.array(z.object({ sha: text, subject: text }).strict()),
  commands: z.array(reviewCommandSchema), capturedAt: text }).strict();
export { reviewEvidenceSchema as p0ReviewEvidenceSchema };
export const p0StringArraySchema = z.array(text);
export const p0ResolvedOutcomeSchema = z.object({ taskId: id, roundId: id, decisionRef: p0DecisionRefSchema,
  choiceId: z.enum(['approve', 'reject', 'request_changes']), executionStatus: z.enum(['succeeded', 'not_required']),
  verdict: verdict.nullable() }).strict();

export const P0_HISTORY_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  'task.created': z.object({}).strict(),
  'task.updated': z.object({ fields: z.array(text), previousRevision: revision,
    acceptanceChange: z.object({ before: z.object({ text, source: acceptanceSource }).strict(),
      after: z.object({ text, source: acceptanceSource }).strict() }).strict().optional() }).strict(),
  'task.transitioned': z.object({ from: state, to: state, reason: text.nullable(),
    escalation: z.object({ recipientMemberId: id.nullable(), unresolved: z.boolean() }).strict().optional() }).strict(),
  'task.commented': z.object({ commentId: id }).strict(),
  'task.message_linked': z.object({ linked: z.literal(true) }).strict(),
  'task.review_failed': z.object({ roundId: id, failure: p0ReviewFailureSchema }).strict(),
  'task.review_started': z.object({ roundId: id, baseCommit: text, candidateCommit: text, diffSha256: digest }).strict(),
  'task.review_begun': z.object({ roundId: id, roundRevision: revision }).strict(),
  'task.review_reported': z.object({ roundId: id, reportId: id, axis, verdict }).strict(),
  'task.review_decided': z.object({ roundId: id, decision: p0ReviewDecisionSchema, decisionRef: p0DecisionRefSchema.optional(),
    previousDecision: p0ReviewDecisionSchema.nullable() }).strict(),
  'decision.resolved': p0ResolvedOutcomeSchema,
  member_removed: z.object({ memberId: id, auditId: id, restartReview: z.boolean() }).strict(),
  member_restored: z.object({ memberId: id, auditId: id, restartReview: z.boolean() }).strict(),
});

const taskEvent = { taskId: id, revision };
export const p0OrdinaryAssignedSchema = z.object(taskEvent).strict();
export const p0OrdinaryBlockedSchema = z.object({ ...taskEvent, reason: text }).strict();
export const p0LifecycleEventSchema = z.object({ taskId: id, taskRevision: revision, memberId: id, reason: text.nullable() }).strict();
export const p0ReviewReadySchema = z.object({ ...taskEvent, roundId: id }).strict();
export const p0LiveCompletionSchema = z.object({ ...taskEvent, roundId: id, decision: p0ReviewDecisionSchema,
  decisionRef: p0DecisionRefSchema.optional(), enteredDone: z.boolean(), completionRevision: revision,
  assigneeAgentId: id.nullable() }).strict();
export const p0DecisionRequestedSchema = z.object({ taskId: id, decisionId: id, decisionRevision: revision }).strict();
export const p0MemoryNoticeSchema = z.object({ requestId: id, requestRevision: revision,
  trigger: z.enum(['task_completed', 'message_threshold', 'session_end', 'retry']) }).strict();

/** Same immutable execution/candidate constraints as tasks/service.ts:verifyEvidence. */
export function p0EvidenceMatchesCandidate(evidence: z.infer<typeof reviewEvidenceSchema>, candidate: z.infer<typeof p0ReviewCandidateSchema>): boolean {
  const start = Date.parse(evidence.startedAt), end = Date.parse(evidence.completedAt);
  return evidence.baseCommit === candidate.baseCommit && evidence.candidateCommit === candidate.candidateCommit
    && evidence.diffSha256 === candidate.diffSha256 && start < end && evidence.command.exitCode === 0
    && Date.parse(evidence.command.startedAt) <= start && Date.parse(evidence.command.completedAt) >= end;
}
export function p0EvidenceAxesIndependent(left: z.infer<typeof reviewEvidenceSchema>, right: z.infer<typeof reviewEvidenceSchema>): boolean {
  return left.parentRunId === right.parentRunId && left.invocationId !== right.invocationId && left.contextId !== right.contextId
    && Math.max(Date.parse(left.startedAt), Date.parse(right.startedAt)) < Math.min(Date.parse(left.completedAt), Date.parse(right.completedAt));
}

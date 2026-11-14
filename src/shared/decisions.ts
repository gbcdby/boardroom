import type { PolicyEvaluation } from "./policy.ts";
import type { TaskView } from "./tasks.ts";

export type Id = string;
export type Digest = string;
export type Revision = number;
export type IsoTime = string;
export type ReviewVerdict = 'pass' | 'changes_requested';
/** request_changes returns the proposal; it does NOT apply review verdict changes_requested. */
export type DecisionChoice = 'approve' | 'reject' | 'request_changes';
export type DecisionStatus = 'pending' | 'resolved' | 'superseded' | 'cancelled' | 'expired';
export type RequiredAuthority = 'auto' | 'owner' | 'human';
export interface ActorRef { readonly kind: 'human' | 'agent'; readonly id: Id }
export interface DecisionRef {
  readonly decisionId: Id;
  readonly revision: Revision;
  readonly actionDigest: Digest;
  readonly projectId: Id;
}
export interface ReviewSlot { readonly projectId: Id; readonly taskId: Id; readonly roundId: Id }
export interface ReviewHeadRef extends ReviewSlot {
  readonly headRevision: Revision;
  readonly currentDecisionId: Id;
}
export interface PolicyRef {
  readonly policyRevision: string;
  readonly global: { readonly revision: Revision; readonly contentDigest: Digest };
  readonly project: { readonly revision: Revision; readonly contentDigest: Digest } | null;
  readonly defaultRevision: Revision;
}
/** Same shape/hash as the review branch of released PolicyAction v1. No override/reason. */
export interface ReviewPolicyActionV1 {
  readonly schemaVersion: 1;
  readonly kind: 'review.decide';
  readonly projectId: Id;
  readonly subjectRef: { readonly kind: 'review-round'; readonly id: Id };
  readonly expectedSubjectRevisions: readonly [
    { readonly subjectRef: { readonly kind: 'review-round'; readonly id: Id }; readonly revision: Revision },
    { readonly subjectRef: { readonly kind: 'task'; readonly id: Id }; readonly revision: Revision }
  ];
  readonly candidateDigest: Digest;
  readonly payload: { readonly choice: ReviewVerdict };
}
export interface ReviewActionRequest extends ReviewSlot {
  readonly id: Id;
  readonly action: ReviewPolicyActionV1;
  readonly actionDigest: Digest;
  readonly candidateEnvelope: ReviewCandidateEnvelopeV1;
  readonly origin: 'review-reports' | 'legacy-bootstrap' | 'user-request' | 'agent-request';
  readonly createdBy: ActorRef | { readonly kind: 'system'; readonly id: 'review-materializer' };
  readonly proposalReason: string;
  /** Records initial command intent, grants nothing; actual effect path is rechecked. */
  readonly requestedPath: 'reviewer' | 'management' | 'materializer';
  readonly createdAt: IsoTime;
}
export interface PolicyObservation {
  readonly factsContract: 's1.db-review-locked/v1';
  readonly purpose: 'eligibility-observation' | 'resolver-check';
  readonly evaluationPrincipal: ActorRef | null;
  readonly mode: 'observation';
  readonly executionAdmission: 'not-issued';
  readonly status: 'evaluated' | 'evaluation_incomplete';
  readonly outcome: 'auto' | 'owner' | 'human' | 'deny';
  readonly requiresFreshHuman: boolean;
  readonly policy: PolicyRef;
  readonly matchedRuleIds: readonly string[];
  readonly reasons: readonly { readonly code: string; readonly message: string; readonly ruleId: string }[];
  readonly missingFacts: readonly string[];
  readonly grantRefs: readonly [];
  readonly evaluatedAt: IsoTime;
  /** Full released PolicyEvaluation is persisted alongside this display envelope. */
  readonly fullEvaluation: PolicyEvaluation;
}
export interface LocalHumanProvenanceReceipt {
  readonly sourceContract: 's1.local-db-decision-choice/v1';
  readonly transferMode: 'same-transaction-only';
  readonly authorityBasis: 'same-transaction-current-permissions';
  readonly initiationId: Id;
  readonly userEventId: Id;
  readonly actor: { readonly kind: 'human'; readonly id: 'human:local' };
  readonly receiptId: Id;
  readonly issuedAt: IsoTime;
  readonly consumedAt: IsoTime;
  // Deliberately no nonce, authorizationEpoch, conversation, binding, Run or skill fields.
}
export interface DecisionResolution {
  readonly id: Id;
  readonly inputDecisionRef: DecisionRef;
  readonly choiceId: DecisionChoice;
  /** Actual resolver authority: a real local human resolution records human,
   * independently of requiredAuthority / policy outcome (which may be owner). */
  readonly authority: RequiredAuthority;
  readonly actor: ActorRef;
  readonly reason: string;
  readonly actualExecutionPath: 'reviewer' | 'management' | 'no-effect';
  readonly provenance: LocalHumanProvenanceReceipt | {
    readonly kind: 'current-actor-command'; readonly actor: ActorRef; readonly commandReceiptId: Id;
  };
  readonly policy: PolicyRef;
  readonly permissionSnapshotDigest: Digest;
  readonly resolvedAt: IsoTime;
}
/** Only durable local DB outcomes exist in this slice. Not a Run/Instance admission. */
export type DbReviewExecution = {
  readonly kind: 'db-review-execution/v1'; readonly id: Id; readonly decisionId: Id;
  readonly effectKey: string; readonly status: 'succeeded'; readonly verdict: ReviewVerdict;
  readonly before: { readonly taskRevision: Revision; readonly roundRevision: Revision };
  readonly after: { readonly taskRevision: Revision; readonly roundRevision: Revision };
  readonly taskHistoryId: Id; readonly workEventIds: readonly Id[];
} | {
  readonly kind: 'db-review-execution/v1'; readonly id: Id; readonly decisionId: Id;
  readonly effectKey: string; readonly status: 'not_required'; readonly verdict: null;
};
export interface LiveDecisionView {
  readonly recordKind: 'live-review-decision';
  readonly ref: DecisionRef;
  readonly head: ReviewHeadRef;
  readonly isCurrent: boolean;
  readonly actionRequest: ReviewActionRequest;
  readonly status: DecisionStatus;
  readonly requiredAuthority: RequiredAuthority | null;
  readonly savedEvaluation: PolicyObservation;
  readonly currentPolicy: PolicyRef;
  readonly freshness: 'current' | 'policy_changed' | 'candidate_changed' | 'lifecycle_changed';
  readonly assigneeMemberId: Id | null;
  readonly blockedReason: string | null;
  readonly predecessor: { readonly kind: 'live'; readonly decisionId: Id } | { readonly kind: 'legacy'; readonly legacyId: Id } | null;
  readonly supersededBy: DecisionRef | null; // Derived from immutable successor edge.
  readonly resolution: DecisionResolution | null;
  readonly execution: DbReviewExecution | null;
  readonly allowedOperations: readonly ('refresh' | 'approve' | 'reject' | 'request_changes' | 'propose-successor')[];
  readonly createdAt: IsoTime;
  readonly updatedAt: IsoTime;
}
/** A legacy diagnostic can have no valid Round; this does not relax any live slot. */
export interface LegacyReviewDecisionView extends Omit<ReviewSlot, 'roundId'> {
  readonly roundId: Id | null;
  readonly recordKind: 'legacy-review-fact';
  readonly legacyId: Id;
  readonly source: { readonly table: 'task_history' | 'task_review_rounds'; readonly id: Id; readonly rawDigest: Digest };
  readonly chainStatus: 'verified' | 'projection-only' | 'ambiguous' | 'malformed';
  readonly originalActor: unknown;
  readonly originalDecision: unknown;
  readonly originalPreviousDecision: unknown;
  readonly originalTaskRevision: Revision | null;
  readonly canResolve: false;
  readonly newApprovalProvenance: null;
  readonly diagnosticCodes: readonly string[];
}
export type DecisionView = LiveDecisionView | LegacyReviewDecisionView;
export interface RequestReviewDecisionInput {
  readonly expectedTaskRevision: Revision;
  readonly expectedRoundRevision: Revision;
  readonly proposedVerdict: ReviewVerdict;
  readonly reason: string;
  readonly requestedPath: 'reviewer' | 'management';
  readonly expectedHead?: ReviewHeadRef;
  readonly idempotencyKey: string;
}
/** MCP input. No actor, authority, nonce, source or userInitiationRef fields accepted. */
export interface ResolveAgentDecisionInput {
  readonly decisionRef: DecisionRef;
  readonly choiceId: DecisionChoice;
  readonly reason: string;
  readonly idempotencyKey: string;
}
/** Only the trusted local UI HTTP adapter may invoke the human source path. */
export interface ChooseLocalUiDecisionInput {
  readonly decisionRef: DecisionRef;
  readonly choiceId: DecisionChoice;
  readonly reason: string;
  readonly clientMutationId: string;
}
export interface RefreshDecisionInput { readonly decisionRef: DecisionRef; readonly idempotencyKey: string }
export interface DecisionCommandReceipt {
  readonly receiptId: Id;
  readonly operation: 'request-review' | 'resolve' | 'refresh' | 'legacy-decide';
  readonly actor: ActorRef;
  readonly requestDigest: Digest;
  readonly inputDecisionRef: DecisionRef | null;
  readonly resultDecisionRef: DecisionRef;
  readonly head: ReviewHeadRef;
  readonly result: 'pending' | 'applied' | 'not_required' | 'refreshed';
  readonly httpStatus: 200 | 202 | 409;
  /** Logical normalized command; preserves each caller reason, not storage encodings. */
  readonly command: CanonicalDecisionCommandV1;
  readonly resolutionId: Id | null;
  readonly execution: DbReviewExecution | null;
  readonly committedAt: IsoTime;
}
/** response_json contains this immutable committed snapshot, not later current state. */
export interface DecisionStoredResponseV1 {
  readonly schemaVersion: 'decision-response/v1';
  readonly state: 'applied' | 'pending' | 'not_required' | 'refreshed';
  readonly reason: 'policy_changed' | null;
  readonly receipt: DecisionCommandReceipt;
  readonly task: TaskView;
  readonly decisionRef: DecisionRef;
  readonly head: ReviewHeadRef;
  readonly requiredAuthority: RequiredAuthority | null;
  readonly blockedReason: string | null;
}
/** HTTP status/state is the stored original result even after a later resolution. */
export interface DecisionCommandResult extends DecisionStoredResponseV1 {
  readonly replay: 'none' | 'same-key' | 'equivalent';
  readonly current: LiveDecisionView;
}
export type DecisionErrorCode = 'forbidden' | 'idempotency_conflict' | 'decision_revision_conflict'
  | 'head_revision_conflict' | 'decision_terminal' | 'candidate_changed' | 'policy_changed'
  | 'human_intent_required' | 'evaluation_incomplete' | 'assignee_unavailable'
  | 'review_reports_required' | 'review_axis_rejected' | 'task_materials_incomplete'
  | 'review_candidate_stale' | 'source_binding_mismatch' | 'source_not_transferable'
  | 'source_already_consumed' | 'handler_unavailable' | 'fact_contract_mismatch'
  | 'legacy_fact_not_resolvable' | 'policy_not_initialized' | 'decision_storage_invalid';
export interface DecisionError {
  readonly code: DecisionErrorCode;
  readonly message: string;
  readonly currentRef?: DecisionRef; // Present only after current read permission passes.
  readonly head?: ReviewHeadRef;
  readonly missingFacts?: readonly string[];
}
export interface DecisionChange {
  readonly projectId: Id; readonly revision: Revision; readonly taskId: Id;
  readonly decisionId: Id; readonly decisionRevision: Revision;
  readonly kind: 'created' | 'refreshed' | 'resolved' | 'superseded' | 'cancelled' | 'expired';
}


export interface ReviewCandidateEnvelopeV1 extends ReviewSlot {
  readonly task: {
    readonly title: string; readonly body: string; readonly labels: readonly string[];
    readonly deliveryKind: 'code' | 'artifact' | 'finding' | null;
    readonly acceptanceText: string; readonly acceptanceSource: 'explicit' | 'legacy_task_body';
    readonly assigneeMemberId: Id | null; readonly reviewerMemberId: Id | null;
    readonly repoPath: string | null; readonly fixedPoint: string | null;
  };
  readonly roundSpecSnapshot: {
    readonly title: string; readonly body: string; readonly labels: readonly string[];
    readonly deliveryKind?: 'code' | 'artifact' | 'finding' | null;
    readonly acceptanceText?: string; readonly acceptanceSource?: 'explicit' | 'legacy_task_body';
  };
  readonly candidate: {
    readonly repositoryRoot: string; readonly fixedPointInput: string;
    readonly baseCommit: string; readonly candidateCommit: string; readonly policy: 'committed-clean';
    readonly diffSha256: string; readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  };
  /** Exact two axes, sorted by axis; labels are sorted; commits retain their source order. */
  readonly reports: readonly [
    { readonly axis: 'spec'; readonly id: Id; readonly contentSha256: string; readonly verdict: ReviewVerdict },
    { readonly axis: 'standards'; readonly id: Id; readonly contentSha256: string; readonly verdict: ReviewVerdict }
  ];
}
export type CanonicalDecisionCommandV1 = ReviewSlot & { readonly actor: ActorRef } & (
  { readonly operation: 'request-review'; readonly input: Omit<RequestReviewDecisionInput, 'idempotencyKey'> } |
  { readonly operation: 'resolve'; readonly input: Omit<ResolveAgentDecisionInput, 'idempotencyKey'> } |
  { readonly operation: 'refresh'; readonly input: Omit<RefreshDecisionInput, 'idempotencyKey'> } |
  { readonly operation: 'legacy-decide'; readonly input: {
    readonly expectedTaskRevision: Revision; readonly expectedRoundRevision: Revision;
    readonly verdict: ReviewVerdict; readonly reason: string; readonly override: boolean;
  } }
);
/** Exact UI command provenance; no client actor/source claims are accepted at ingress. */
export interface LocalUiCommandV1 {
  readonly kind: 'ui-decision-choice' | 'legacy-decide';
  readonly command: CanonicalDecisionCommandV1;
  readonly clientMutationId: string;
}

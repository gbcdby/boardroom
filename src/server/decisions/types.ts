import type { Id, Digest, Revision, IsoTime, ReviewSlot, DecisionRef, ActorRef, PolicyRef, ReviewPolicyActionV1, DecisionChoice } from "../../shared/decisions.ts";
export type * from "../../shared/decisions.ts";

declare const transactionBrand: unique symbol;
declare const currentEffectBrand: unique symbol;
/** Constructible only by actual repositories transaction/scope helpers, savepoint aware. */
export interface ReviewLockedTransaction {
  readonly [transactionBrand]: true;
  readonly physicalTransactionIdentity: object;
  readonly slot: ReviewSlot;
  readonly scopeFullyLocked: true;
  readonly globalPolicyHeadLocked: true;
}
/** Recreated after all current checks; never returned to HTTP/MCP/registry consumers. */
export interface CurrentDbReviewEffectGuard {
  readonly [currentEffectBrand]: true;
  readonly transaction: ReviewLockedTransaction;
  readonly inputRef: DecisionRef;
  readonly actualActor: ActorRef;
  readonly actualPath: 'reviewer' | 'management';
  readonly policy: PolicyRef;
  readonly permittedAction: ReviewPolicyActionV1;
}
/** Internal only. Never serializable as a future/transferable public UserInitiation. */
export interface LocalDbDecisionChoiceInitiationV1 {
  readonly sourceContract: 's1.local-db-decision-choice/v1';
  readonly kind: 'decision-choice';
  readonly authorityBasis: 'same-transaction-current-permissions';
  readonly transferMode: 'same-transaction-only';
  readonly initiationId: Id; readonly userEventId: Id; readonly nonce: string;
  readonly actor: { readonly kind: 'human'; readonly id: 'human:local' };
  readonly decisionRef: DecisionRef; readonly choiceId: DecisionChoice;
  readonly requestDigest: Digest;
  readonly transaction: ReviewLockedTransaction;
  readonly authorizationEpoch?: never; readonly conversationRef?: never; readonly skillRef?: never;
}

/** Historical current-permission facts, never recomputed as authority during copy/replay. */
export interface PermissionSnapshotV1 extends ReviewSlot {
  readonly schemaVersion: 'db-review-permissions/v1';
  readonly actor: ActorRef; readonly active: boolean;
  readonly membershipRevision: Revision | null;
  readonly currentMembershipRevision: Revision | null;
  readonly projectActive: boolean; readonly readAllowed: boolean;
  readonly capability: 'task:review' | 'task:override' | null;
  readonly capabilityAllowed: boolean; readonly inScope: boolean;
  readonly actualPath: 'reviewer' | 'management' | 'no-effect';
  readonly checkedAt: IsoTime;
}
/** JSON.stringify(logical normalized reason), with outer quotes. Never a DTO value. */
export type StoredReasonJsonText = string;
/** canonicalJson(strict typed object), kept byte-for-byte. Never cast to SQL JSON/JSONB. */
export type StoredCanonicalJsonText = string;
export type DecisionTextColumn =
  | 'decision_action_requests.action_json'
  | 'decision_action_requests.candidate_envelope_json'
  | 'decision_action_requests.proposal_reason_json'
  | 'decision_records.policy_evaluation_json'
  | 'decision_user_events.command_json'
  | 'decision_resolutions.reason_json'
  | 'decision_resolutions.policy_evaluation_json'
  | 'decision_resolutions.permission_snapshot_json'
  | 'decision_command_receipts.response_json'
  | 'decision_executions.work_event_ids_json';
/** A single private codec owns every typed column; schema IDs never come from callers. */
export interface DecisionTextCodecV1 {
  readonly schemaVersion: 'decision-text-codec/v1';
  encode(column: DecisionTextColumn, validatedLogicalValue: unknown): string;
  decode(column: DecisionTextColumn, originalText: string): unknown;
  /** Must validate typed columns and cross-field digest/binding integrity, without rewriting. */
  validateCopyRow(table: string, originalRow: Readonly<Record<string, unknown>>): void;
}

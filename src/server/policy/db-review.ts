import type { PolicyEvaluation, PolicyReason } from "../../shared/policy.ts";

/** #157 B3：这些 server-only 合同只供已取得当前事务事实的可信服务使用。 */
export interface PolicyRef {
  readonly policyRevision: string;
  readonly global: { readonly revision: number; readonly contentDigest: string };
  readonly project: { readonly revision: number; readonly contentDigest: string } | null;
  readonly defaultRevision: number;
}
export interface ReviewPolicyActionV1 {
  readonly schemaVersion: 1;
  readonly kind: "review.decide";
  readonly projectId: string;
  readonly subjectRef: { readonly kind: "review-round"; readonly id: string };
  readonly expectedSubjectRevisions: readonly [
    { readonly subjectRef: { readonly kind: "review-round"; readonly id: string }; readonly revision: number },
    { readonly subjectRef: { readonly kind: "task"; readonly id: string }; readonly revision: number },
  ];
  readonly candidateDigest: string;
  readonly payload: { readonly choice: "pass" | "changes_requested" };
}
export interface DbReviewHandlerDescriptorV1 {
  readonly handlerId: "s1.review-decide.db/v1";
  readonly revision: 1;
  readonly kind: "review.decide";
  readonly available: boolean;
  readonly effects: "single-database-transaction";
  readonly resources: "database-only";
  readonly delegation: "none";
  readonly deferredEffects: "none";
  readonly grantUse: "none";
}
export interface DbReviewLockedFactsV1 {
  readonly factsContract: "s1.db-review-locked/v1";
  readonly authorityBasis: "same-transaction-current-permissions";
  readonly purpose: "eligibility-observation" | "resolver-check";
  readonly principal: {
    readonly actorId: string;
    readonly active: boolean;
    readonly membershipRevision: number | null;
    readonly currentMembershipRevision: number | null;
  };
  readonly project: { readonly projectId: string; readonly active: boolean };
  readonly subjects: readonly {
    readonly subjectRef: { readonly kind: "task" | "review-round"; readonly id: string };
    readonly revision: number;
    readonly active: boolean;
    readonly candidateDigest: string | null;
  }[];
  readonly proposal: {
    readonly readAllowed: boolean; readonly createAllowed: boolean; readonly inScope: boolean;
    readonly kindAllowed: boolean; readonly delegable: boolean; readonly prohibited: boolean;
  };
  readonly execution: {
    readonly resourceAccess: boolean; readonly capabilityAllowed: boolean; readonly inScope: boolean;
    readonly authorizationCurrent: boolean; readonly hostSupported: boolean; readonly prohibited: boolean;
  };
  readonly authorization: {
    readonly existingAuthorization: boolean;
    readonly grants: readonly [];
    readonly authorizationEpoch?: never;
  };
  readonly budget: { readonly requiredUnits: 0; readonly availableUnits: 0; readonly mayRequestIncrease: false };
  readonly retries: { readonly requested: 0; readonly available: 0; readonly mayRequestIncrease: false };
  readonly userReserved: false;
  readonly delivery?: never;
}
export interface DbReviewPolicyRequestV1 {
  readonly contractVersion: "s1.db-review-policy/v1";
  readonly action: ReviewPolicyActionV1;
  readonly stage: "proposal" | "execution";
  readonly policy: PolicyRef;
  readonly documents: unknown;
  readonly handler: DbReviewHandlerDescriptorV1;
  readonly facts: DbReviewLockedFactsV1;
  readonly evaluatedAt: string;
}
export interface PolicyObservation {
  readonly factsContract: "s1.db-review-locked/v1";
  readonly purpose: "eligibility-observation" | "resolver-check";
  readonly evaluationPrincipal: { readonly kind: "human" | "agent"; readonly id: string } | null;
  readonly mode: "observation";
  readonly executionAdmission: "not-issued";
  readonly status: "evaluated" | "evaluation_incomplete";
  readonly outcome: "auto" | "owner" | "human" | "deny";
  readonly requiresFreshHuman: boolean;
  readonly policy: PolicyRef;
  readonly matchedRuleIds: readonly string[];
  readonly reasons: readonly PolicyReason[];
  readonly missingFacts: readonly string[];
  readonly grantRefs: readonly [];
  readonly evaluatedAt: string;
  readonly fullEvaluation: PolicyEvaluation;
}

export { evaluateDbReviewPolicyV1 } from "./evaluator.ts";
export { DbReviewPolicyInputError } from "./schemas.ts";

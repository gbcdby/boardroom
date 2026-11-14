import type { PolicyAction, PolicyActionKind, PolicyEvaluationRequest, PolicyGrantFact, PolicyPayloadByKind, PolicySubjectRef } from "../../src/shared/policy.ts";
import { createDefaultPolicy } from "../../src/server/policy/index.ts";

const payloads: PolicyPayloadByKind = {
  "task.execute": { operation: "implement" },
  "task.assign": { assigneeMemberId: "worker-1" },
  "task.replan": { change: "technical-choice", planDigest: "b".repeat(64) },
  "review.decide": { choice: "pass" },
  "runtime.start_authorized": { configurationRevision: 2 },
  "runtime.retry_authorized": { previousAttemptId: "attempt-1" },
  "scope.change": { requestedResources: ["unverified:/new/workspace"], reason: "需要新增工作区" },
  "authorization.expand": { requestedActionKinds: ["delivery.merge"], requestedResources: ["unverified:repository"], reason: "申请有界合并授权" },
  "delivery.create_pr": { repositoryId: "repo-1", sourceRef: "feature", targetRef: "main" },
  "delivery.merge": { pullRequestRef: "pr-1", targetRef: "main" },
  "delivery.deploy": { artifactDigest: "b".repeat(64), targetRef: "staging" },
  "delivery.publish": { artifactDigest: "b".repeat(64), targetRef: "package" },
};

/** 人工构造的可信快照只供纯求值测试；不声明仓库已提供这些 handler。 */
export function policyFixture(kind: PolicyActionKind = "task.execute"): PolicyEvaluationRequest {
  const subjectKind: PolicySubjectRef["kind"] = kind.startsWith("delivery.") ? "delivery"
    : kind.startsWith("runtime.") ? "runtime" : kind === "review.decide" ? "review-round"
      : kind === "scope.change" || kind === "authorization.expand" ? "project" : "task";
  const subjectRef = { kind: subjectKind, id: "subject-1" };
  const action = {
    schemaVersion: 1, kind, projectId: "project-1", subjectRef,
    expectedSubjectRevisions: [{ subjectRef, revision: 3 }], candidateDigest: "a".repeat(64), payload: payloads[kind],
  } as PolicyAction;
  return {
    action, stage: "proposal", policies: { global: createDefaultPolicy(1) },
    context: {
      evaluatedAt: "2026-11-11T12:00:00.000Z", policyRevision: "snapshot-1",
      registry: { revision: 1, handlers: [{ kind, handlerId: `fixture:${kind}`, revision: 1, available: true }] },
      facts: {
        principal: { actorId: "manager-1", active: true, membershipRevision: 2, currentMembershipRevision: 2 },
        project: { projectId: "project-1", active: true },
        subjects: [{ subjectRef, revision: 3, candidateDigest: action.candidateDigest, active: true }],
        proposal: { readAllowed: true, createAllowed: true, inScope: true, kindAllowed: true, delegable: true, prohibited: false },
        execution: { resourceAccess: true, capabilityAllowed: true, inScope: true, authorizationCurrent: true, hostSupported: true, prohibited: false },
        authorization: { authorizationEpoch: 4, existingAuthorization: true, grants: [] },
        budget: { requiredUnits: 0, availableUnits: 0, mayRequestIncrease: true },
        retries: { requested: 0, available: 3, mayRequestIncrease: true },
        userReserved: false,
        delivery: { ciPassed: true, independentReviewPassed: true, targetCurrent: true },
      },
    },
  };
}

export function policyGrantFixture(request: PolicyEvaluationRequest): PolicyGrantFact {
  const action = request.action as PolicyAction;
  return {
    grantId: "grant-1", revision: 2, currentRevision: 2, authorizationEpoch: 4,
    provenanceRef: "user-event-1", actorId: "manager-1", projectId: action.projectId,
    actionKinds: [action.kind], subjects: action.expectedSubjectRevisions.map(ref => ref.subjectRef),
    candidateDigest: action.candidateDigest, actionDigest: null,
    validFrom: "2026-11-11T11:00:00.000Z", expiresAt: "2026-11-12T12:00:00.000Z",
    revoked: false, remainingUses: 2, budgetLimit: 5, retryLimit: 2,
  };
}

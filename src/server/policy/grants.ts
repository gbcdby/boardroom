import type { NormalizedPolicyAction, PolicyGrantCheck, PolicyGrantFact, PolicyGrantRef } from "../../shared/policy.ts";
import { subjectKey } from "./schemas.ts";

interface GrantMatchContext {
  readonly actorId: string;
  readonly authorizationEpoch: number;
  readonly evaluatedAt: string;
  readonly requiredBudgetUnits: number;
  readonly requestedRetries: number;
}

/** 只匹配可信快照，不保留/消费次数，不生成授权，也不替代执行阶段守卫。 */
export function matchPolicyGrants(
  normalized: NormalizedPolicyAction,
  context: GrantMatchContext,
  grants: readonly PolicyGrantFact[],
): { refs: PolicyGrantRef[]; checks: PolicyGrantCheck[] } {
  const { action, actionDigest } = normalized;
  const now = Date.parse(context.evaluatedAt);
  const refs: PolicyGrantRef[] = [];
  const checks: PolicyGrantCheck[] = [];
  for (const grant of grants) {
    const reasons: string[] = [];
    if (grant.revision !== grant.currentRevision) reasons.push("revision_changed");
    if (grant.authorizationEpoch !== context.authorizationEpoch) reasons.push("authorization_epoch_changed");
    if (grant.revoked) reasons.push("revoked");
    if (grant.actorId !== context.actorId) reasons.push("actor_mismatch");
    if (grant.projectId !== action.projectId) reasons.push("project_mismatch");
    if (!grant.actionKinds.includes(action.kind)) reasons.push("action_kind_mismatch");
    const resources = new Set(grant.subjects.map(subjectKey));
    if (action.expectedSubjectRevisions.some(ref => !resources.has(subjectKey(ref.subjectRef)))) reasons.push("resource_mismatch");
    if (grant.candidateDigest !== null && grant.candidateDigest !== action.candidateDigest) reasons.push("candidate_mismatch");
    if (grant.actionDigest !== null && grant.actionDigest !== actionDigest) reasons.push("action_digest_mismatch");
    if (grant.validFrom !== null && now < Date.parse(grant.validFrom)) reasons.push("not_yet_valid");
    if (grant.expiresAt !== null && now >= Date.parse(grant.expiresAt)) reasons.push("expired");
    if (grant.remainingUses !== null && grant.remainingUses <= 0) reasons.push("uses_exhausted");
    if (grant.budgetLimit !== null && context.requiredBudgetUnits > grant.budgetLimit) reasons.push("budget_limit_exceeded");
    if (grant.retryLimit !== null && context.requestedRetries > grant.retryLimit) reasons.push("retry_limit_exceeded");
    checks.push({ grantId: grant.grantId, revision: grant.revision, matched: reasons.length === 0, reasons: reasons.sort() });
    if (!reasons.length) refs.push({ grantId: grant.grantId, revision: grant.revision, provenanceRef: grant.provenanceRef });
  }
  return { refs, checks };
}

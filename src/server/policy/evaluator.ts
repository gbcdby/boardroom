import type {
  EffectivePolicyRule, PolicyEvaluation, PolicyEvaluationRequest, PolicyExecutionPrerequisite, PolicyGrantCheck,
  PolicyGrantRef, PolicyOutcome, PolicyPreview, PolicyReason, PolicyRuleMatch, PolicyRuleSource, TrustedPolicyFacts,
} from "../../shared/policy.ts";
import { DEFAULT_HUMAN_ACTOR_ID } from "../authz/actors.ts";
import { compareText, normalizePolicyAction } from "./canonical.ts";
import type { DbReviewPolicyRequestV1, PolicyObservation } from "./db-review.ts";
import { DEFAULT_POLICY_REVISION, defaultRuleFor } from "./defaults.ts";
import { matchPolicyGrants } from "./grants.ts";
import { composePolicyRules } from "./rules.ts";
import { DbReviewPolicyInputError, parseDbReviewPolicyRequestV1, parseEvaluationRequest, subjectKey } from "./schemas.ts";

const severity: Readonly<Record<PolicyOutcome, number>> = { auto: 0, owner: 1, human: 2, deny: 3 };
const COMMON_FACTS = ["principal.actorId", "principal.active", "principal.membershipRevision", "principal.currentMembershipRevision", "project.projectId", "project.active", "subjects"] as const;
const PROPOSAL_FACTS = ["proposal.readAllowed", "proposal.createAllowed", "proposal.inScope", "proposal.kindAllowed", "proposal.delegable", "proposal.prohibited"] as const;
const EXECUTION_FACTS = ["execution.resourceAccess", "execution.capabilityAllowed", "execution.inScope", "execution.authorizationCurrent", "execution.hostSupported", "execution.prohibited"] as const;
const POLICY_FACTS = ["authorization.authorizationEpoch", "authorization.existingAuthorization", "authorization.grants", "budget.requiredUnits", "budget.availableUnits", "budget.mayRequestIncrease", "retries.requested", "retries.available", "retries.mayRequestIncrease", "userReserved"] as const;
const DB_REVIEW_POLICY_FACTS = POLICY_FACTS.filter(path => path !== "authorization.authorizationEpoch");
const DELIVERY_FACTS = ["delivery.ciPassed", "delivery.independentReviewPassed", "delivery.targetCurrent"] as const;

function missingPaths(facts: TrustedPolicyFacts, paths: readonly string[]): string[] {
  return paths.filter(path => {
    let value: unknown = facts;
    for (const part of path.split(".")) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
    return value === undefined;
  }).map(path => `facts.${path}`);
}

/** 管理服务可直接展示此 DTO；不得把它传给 Run 或副作用入口当作准入。 */
export function previewPolicy(input: PolicyEvaluationRequest): PolicyPreview {
  return { kind: "policy-preview", sideEffects: "none", evaluation: evaluateAction(input) };
}

/** 纯观察：不接收数据库、执行器或额度写入能力；任何 outcome 都不签发 admission。 */
export function evaluateAction(input: PolicyEvaluationRequest): PolicyEvaluation {
  const { request, missingFacts: missingRecordFields } = parseEvaluationRequest(input);
  return evaluateParsedRequest(request, missingRecordFields, "authorization-epoch/v1");
}

/** 独立的 DB-only 观察入口；不接收执行器，也不返回事务 guard 或执行许可。 */
export function evaluateDbReviewPolicyV1(input: DbReviewPolicyRequestV1): PolicyObservation {
  const request = parseDbReviewPolicyRequestV1(input);
  const fullEvaluation = evaluateParsedRequest({
    action: request.action, policies: request.documents, stage: request.stage,
    context: {
      evaluatedAt: request.evaluatedAt, policyRevision: request.policy.policyRevision,
      registry: { revision: request.handler.revision, handlers: [request.handler] }, facts: request.facts,
    },
  }, [], "s1.db-review-locked/v1");
  const mismatchedRefs: string[] = [];
  if (request.policy.global.revision !== fullEvaluation.globalRevision) mismatchedRefs.push("policy.global.revision");
  if ((request.policy.project?.revision ?? null) !== fullEvaluation.projectRevision) mismatchedRefs.push("policy.project.revision");
  if (request.policy.defaultRevision !== fullEvaluation.defaultRevision) mismatchedRefs.push("policy.defaultRevision");
  if (mismatchedRefs.length) throw new DbReviewPolicyInputError(mismatchedRefs);
  return {
    factsContract: request.facts.factsContract, purpose: request.facts.purpose,
    evaluationPrincipal: { kind: request.facts.principal.actorId === DEFAULT_HUMAN_ACTOR_ID ? "human" : "agent", id: request.facts.principal.actorId },
    mode: fullEvaluation.mode, executionAdmission: fullEvaluation.executionAdmission,
    status: fullEvaluation.status, outcome: fullEvaluation.outcome, requiresFreshHuman: fullEvaluation.requiresFreshHuman,
    policy: request.policy, matchedRuleIds: fullEvaluation.matchedRuleIds, reasons: fullEvaluation.reasons,
    missingFacts: fullEvaluation.missingFacts, grantRefs: [], evaluatedAt: fullEvaluation.evaluatedAt, fullEvaluation,
  };
}

/** 两个严格入口解析之后才能调用；合同选择不作为公开输入或可跳过检查的 API。 */
function evaluateParsedRequest(
  request: ReturnType<typeof parseEvaluationRequest>["request"], missingRecordFields: readonly string[],
  factsContract: "authorization-epoch/v1" | "s1.db-review-locked/v1",
): PolicyEvaluation {
  const normalized = normalizePolicyAction(request.action);
  const { action } = normalized;
  const composed = composePolicyRules(request.policies);
  const { context, stage } = request;
  const facts = context.facts;
  const matches: PolicyRuleMatch[] = [];
  const reasons: PolicyReason[] = [];
  const prerequisites: PolicyExecutionPrerequisite[] = [];
  const grantRefs: PolicyGrantRef[] = [];
  const grantChecks: PolicyGrantCheck[] = [];
  let missingFacts: string[] = [];

  function add(ruleId: string, outcome: PolicyOutcome, message: string, source: PolicyRuleSource, fresh = false, code = "rule_matched"): void {
    matches.push({ ruleId, outcome, requiresFreshHuman: fresh, source });
    reasons.push({ code, message, ruleId });
    if (fresh) prerequisite("fresh_human_required", "本动作需要新的真实用户选择；已有 standing grant 不免除本次选择。");
  }
  function gate(code: string, outcome: PolicyOutcome, message: string, fresh = false): void {
    const ruleId = `guard.${code}`;
    add(ruleId, outcome, message, { scope: "guard", ruleId, revision: DEFAULT_POLICY_REVISION, projectId: action.projectId }, fresh, code);
  }
  function prerequisite(code: PolicyExecutionPrerequisite["code"], message: string): void {
    if (!prerequisites.some(item => item.code === code)) prerequisites.push({ code, message });
  }
  function finish(): PolicyEvaluation {
    const ordered = matches.sort((a, b) => compareText(a.ruleId, b.ruleId));
    const outcome = ordered.reduce<PolicyOutcome>((current, match) => severity[match.outcome] > severity[current] ? match.outcome : current, "auto");
    return {
      ...normalized, schemaVersion: 1, mode: "observation", executionAdmission: "not-issued", stage,
      status: missingFacts.length ? "evaluation_incomplete" : "evaluated", outcome,
      policyRevision: context.policyRevision, globalRevision: composed.globalRevision, projectRevision: composed.projectRevision,
      defaultRevision: DEFAULT_POLICY_REVISION, registryRevision: context.registry.revision, evaluatedAt: new Date(context.evaluatedAt).toISOString(),
      matchedRuleIds: ordered.map(match => match.ruleId), matchedRules: ordered,
      effectiveSource: ordered.filter(match => match.outcome === outcome).map(match => match.source),
      grantRefs: grantRefs.sort((a, b) => compareText(a.grantId, b.grantId)), grantChecks: grantChecks.sort((a, b) => compareText(a.grantId, b.grantId)),
      requiresFreshHuman: ordered.some(match => match.requiresFreshHuman),
      reasons: reasons.sort((a, b) => compareText(a.ruleId, b.ruleId) || compareText(a.code, b.code)),
      missingFacts: [...new Set(missingFacts)].sort(), executionPrerequisites: prerequisites.sort((a, b) => compareText(a.code, b.code)),
    };
  }
  function incomplete(paths: readonly string[]): PolicyEvaluation {
    missingFacts = [...paths];
    gate("evaluation_incomplete", "deny", "缺少必需可信事实；请由对应权限、对象或额度适配器补齐列出的字段。");
    return finish();
  }

  if (composed.projectRevision !== null && composed.projectId !== action.projectId) {
    gate("policy_scope_mismatch", "deny", "项目策略不属于本动作的项目。");
    return finish();
  }
  if (!context.registry.handlers.some(handler => handler.kind === action.kind && handler.available)) {
    gate("handler_unavailable", "deny", "没有可用的已注册 handler；选择策略不会增加执行能力。");
    return finish();
  }
  if (missingRecordFields.length) return incomplete(missingRecordFields);
  const missingGuards = missingPaths(facts, [...COMMON_FACTS, ...(stage === "proposal" ? PROPOSAL_FACTS : EXECUTION_FACTS)]);
  if (missingGuards.length) return incomplete(missingGuards);
  const subjects = new Map(facts.subjects!.map(fact => [subjectKey(fact.subjectRef), fact]));
  const missingSubjects = action.expectedSubjectRevisions.filter(ref => !subjects.has(subjectKey(ref.subjectRef)))
    .map(ref => `facts.subjects.${subjectKey(ref.subjectRef)}`);
  if (missingSubjects.length) return incomplete(missingSubjects);
  if (!facts.principal!.active || !facts.project!.active || action.expectedSubjectRevisions.some(ref => !subjects.get(subjectKey(ref.subjectRef))!.active)) gate("lifecycle_inactive", "deny", "主体、项目或目标已停用。");
  if (facts.principal!.membershipRevision !== facts.principal!.currentMembershipRevision) gate("membership_changed", "deny", "成员代际已改变，旧上下文不能继续提出或执行动作。");
  if (facts.project!.projectId !== action.projectId) gate("project_scope_mismatch", "deny", "当前可信项目范围与动作不一致。");
  if (stage === "proposal") {
    const proposal = facts.proposal!;
    if (!proposal.readAllowed) gate("proposal_read_forbidden", "deny", "无权读取当前提案对象。");
    if (!proposal.createAllowed) gate("proposal_forbidden", "deny", "当前主体没有 proposal:create 资格。");
    if (!proposal.inScope) gate("proposal_out_of_scope", "deny", "提案超出现有可提出范围，不提前访问新资源。");
    if (!proposal.kindAllowed) gate("proposal_kind_forbidden", "deny", "当前主体不能提出该类动作。");
    if (!proposal.delegable || proposal.prohibited) gate("proposal_non_delegable", "deny", "请求为不可委托能力或明确禁止事项。");
  } else {
    for (const [field, allowed] of Object.entries(facts.execution!)) {
      if (field === "prohibited" ? allowed : !allowed) gate(`execution_${field}`, "deny", `执行硬前提 ${field} 不满足；策略不能补授权限。`);
    }
  }
  if (matches.some(match => match.outcome === "deny")) return finish();

  const requiredPolicyFacts = factsContract === "authorization-epoch/v1" ? POLICY_FACTS : DB_REVIEW_POLICY_FACTS;
  const missingPolicy = missingPaths(facts, [...requiredPolicyFacts, ...(action.kind.startsWith("delivery.") ? DELIVERY_FACTS : [])]);
  if (facts.budget?.requiredUnits === null) missingPolicy.push("facts.budget.requiredUnits");
  if (facts.budget?.requiredUnits !== 0 && facts.budget?.availableUnits === null) missingPolicy.push("facts.budget.availableUnits");
  if (missingPolicy.length) return incomplete(missingPolicy);
  const candidateChanged = action.expectedSubjectRevisions.some(ref => subjects.get(subjectKey(ref.subjectRef))!.revision !== ref.revision)
    || subjects.get(subjectKey(action.subjectRef))!.candidateDigest !== action.candidateDigest;
  const budgetExceeded = facts.budget!.requiredUnits! > (facts.budget!.availableUnits ?? 0);
  const retriesExceeded = facts.retries!.requested! > facts.retries!.available!;
  if (factsContract === "authorization-epoch/v1") {
    const matchingGrants = matchPolicyGrants(normalized, {
      actorId: facts.principal!.actorId!, authorizationEpoch: facts.authorization!.authorizationEpoch!, evaluatedAt: context.evaluatedAt,
      requiredBudgetUnits: facts.budget!.requiredUnits!, requestedRetries: facts.retries!.requested!,
    }, facts.authorization!.grants!);
    grantRefs.push(...matchingGrants.refs);
    grantChecks.push(...matchingGrants.checks);
  }
  const authorizationMatched = facts.authorization!.existingAuthorization! || grantRefs.length > 0;
  if (!authorizationMatched) {
    gate("authorization_required", stage === "execution" ? "deny" : "human", "未找到当前作用域和前提内的可信授权。");
    prerequisite("authorization_required", "由有权 handler 建立有界授权后，重新检查实际执行权限。");
  }
  if (budgetExceeded) {
    gate("budget_exceeded", stage === "execution" || !facts.budget!.mayRequestIncrease ? "deny" : "human", "动作超过当前可核实预算。");
    prerequisite("budget_increase_required", "只有允许重新设定的预算可由用户批准变更；预览不消耗或增加额度。");
  }
  if (retriesExceeded) {
    gate("retries_exceeded", stage === "execution" || !facts.retries!.mayRequestIncrease ? "deny" : "human", "动作超过当前重试额度。");
    prerequisite("retry_increase_required", "补齐明确的重试授权/额度后重新求值。");
  }
  if (candidateChanged) {
    gate("candidate_changed", stage === "execution" ? "deny" : "human", "目标版本或候选摘要已变化，原动作快照不能直接执行。");
    prerequisite("candidate_refresh_required", "按当前目标生成新的动作候选，不复用旧候选批准。");
  }
  if (facts.userReserved) gate("user_reserved", "human", "这是用户保留事项，需要新的用户选择。", true);
  if (action.kind === "authorization.expand" || action.kind === "scope.change") gate("scope_or_authorization_change", "human", "范围或授权变更须由真实用户选择与类型化 handler 处理。", true);
  if (action.kind.startsWith("delivery.") && (!facts.delivery!.ciPassed || !facts.delivery!.independentReviewPassed || !facts.delivery!.targetCurrent)) {
    gate("delivery_checks_incomplete", "deny", "交付所需 CI、独立审查或目标版本条件尚未满足。");
    prerequisite("delivery_checks_required", "补齐交付检查与当前目标版本；批准不豁免这些条件。");
  }

  function matchesRule({ rule }: EffectivePolicyRule): boolean {
    const when = rule.when;
    return (when.actionKinds === undefined || when.actionKinds.includes(action.kind))
      && (when.projectIds === undefined || (action.projectId !== null && when.projectIds.includes(action.projectId)))
      && (when.subjects === undefined || when.subjects.some(ref => action.expectedSubjectRevisions.some(controlled => subjectKey(ref) === subjectKey(controlled.subjectRef))))
      && (when.candidateChanged === undefined || when.candidateChanged === candidateChanged)
      && (when.authorizationMatched === undefined || when.authorizationMatched === authorizationMatched)
      && (when.budget === undefined || when.budget === (budgetExceeded ? "exceeded" : "within"))
      && (when.retries === undefined || when.retries === (retriesExceeded ? "exceeded" : "within"))
      && (when.userReserved === undefined || when.userReserved === facts.userReserved);
  }
  const policyMatches = composed.rules.filter(matchesRule);
  if (!policyMatches.length) {
    const fallback = defaultRuleFor(action.kind);
    const ruleId = `builtin.${fallback.ruleId}`;
    add(ruleId, fallback.outcome, fallback.reason, { scope: "default", ruleId, revision: DEFAULT_POLICY_REVISION, projectId: action.projectId }, fallback.requiresFreshHuman);
  } else for (const { rule, source } of policyMatches) add(rule.ruleId, rule.outcome, rule.reason, source, rule.requiresFreshHuman);
  return finish();
}

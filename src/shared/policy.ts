/** S1-T1：纯策略输入/解释合同；这些 DTO 不构成权限、批准或执行准入。 */
export const POLICY_SCHEMA_VERSION = 1 as const;
export const POLICY_ACTION_KINDS = [
  "task.execute", "task.assign", "task.replan", "review.decide",
  "runtime.start_authorized", "runtime.retry_authorized", "scope.change", "authorization.expand",
  "delivery.create_pr", "delivery.merge", "delivery.deploy", "delivery.publish",
] as const;
export type PolicyActionKind = (typeof POLICY_ACTION_KINDS)[number];
export type PolicyStage = "proposal" | "execution";
export type PolicyOutcome = "auto" | "owner" | "human" | "deny";

export const POLICY_SUBJECT_KINDS = ["task", "review-round", "project", "workspace", "runtime", "delivery", "authorization"] as const;
export interface PolicySubjectRef {
  readonly kind: (typeof POLICY_SUBJECT_KINDS)[number];
  readonly id: string;
}
export interface PolicySubjectRevision {
  readonly subjectRef: PolicySubjectRef;
  readonly revision: number;
}

export interface PolicyPayloadByKind {
  "task.execute": { readonly operation: "read" | "investigate" | "verify" | "implement" };
  "task.assign": { readonly assigneeMemberId: string };
  "task.replan": { readonly change: "decompose" | "dependencies" | "technical-choice" | "repair"; readonly planDigest: string };
  "review.decide": { readonly choice: "pass" | "changes_requested" };
  "runtime.start_authorized": { readonly configurationRevision: number };
  "runtime.retry_authorized": { readonly previousAttemptId: string };
  // 新资源只是未验证描述；内核不读取、解析或挂载它们。
  "scope.change": { readonly requestedResources: readonly string[]; readonly reason: string };
  "authorization.expand": { readonly requestedActionKinds: readonly PolicyActionKind[]; readonly requestedResources: readonly string[]; readonly reason: string };
  "delivery.create_pr": { readonly repositoryId: string; readonly sourceRef: string; readonly targetRef: string };
  "delivery.merge": { readonly pullRequestRef: string; readonly targetRef: string };
  "delivery.deploy": { readonly artifactDigest: string; readonly targetRef: string };
  "delivery.publish": { readonly artifactDigest: string; readonly targetRef: string };
}
interface PolicyActionBase {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly projectId: string | null;
  readonly subjectRef: PolicySubjectRef;
  readonly expectedSubjectRevisions: readonly PolicySubjectRevision[];
  readonly candidateDigest: string | null;
}
export type PolicyAction = {
  [K in PolicyActionKind]: PolicyActionBase & { readonly kind: K; readonly payload: PolicyPayloadByKind[K] }
}[PolicyActionKind];

export interface NormalizedPolicyAction {
  readonly action: PolicyAction;
  /** sha256: + SHA-256(UTF-8("boardroom.action.v1\n" + canonical JSON))。 */
  readonly actionDigest: string;
}

/** 所有条件取 AND；选择器数组内部取 OR。没有脚本、表达式、优先级或隐式顺序。 */
export interface PolicyConditions {
  readonly actionKinds?: readonly PolicyActionKind[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
  /** 任一受控引用匹配即可命中，包括 expectedSubjectRevisions 中的依赖资源。 */
  readonly subjects?: readonly PolicySubjectRef[] | undefined;
  readonly candidateChanged?: boolean | undefined;
  readonly authorizationMatched?: boolean | undefined;
  readonly budget?: "within" | "exceeded" | undefined;
  readonly retries?: "within" | "exceeded" | undefined;
  readonly userReserved?: boolean | undefined;
}
export interface PolicyRule {
  readonly ruleId: string;
  readonly when: PolicyConditions;
  readonly outcome: PolicyOutcome;
  readonly reason: string;
  readonly requiresFreshHuman: boolean;
}
export interface GlobalPolicyRule extends PolicyRule {
  readonly locked: boolean;
  readonly overridable: boolean;
}
export interface GlobalPolicyDocument {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly scope: "user";
  readonly revision: number;
  readonly rules: readonly GlobalPolicyRule[];
}
export interface ProjectPolicyDocument {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly scope: "project";
  readonly projectId: string;
  readonly revision: number;
  readonly rules: readonly PolicyRule[];
  /** 完整替换明确允许覆盖的全局规则；没有删除、通配覆盖或新增权限字段。 */
  readonly overrides: readonly PolicyRule[];
}
export interface PolicyDocuments {
  readonly global: GlobalPolicyDocument;
  readonly project?: ProjectPolicyDocument | undefined;
}
export interface PolicyRuleSource {
  readonly scope: "global" | "project" | "project-override" | "default" | "guard";
  readonly ruleId: string;
  readonly revision: number | null;
  readonly projectId: string | null;
  readonly replacedGlobalRevision?: number | undefined;
}
export interface EffectivePolicyRule {
  readonly rule: PolicyRule;
  readonly source: PolicyRuleSource;
}
export interface ComposedPolicyRules {
  readonly globalRevision: number;
  readonly projectRevision: number | null;
  readonly projectId: string | null;
  readonly rules: readonly EffectivePolicyRule[];
}

/** 可信适配器提供的已加载快照；不是持久 AuthorizationGrant，也不是客户端自证。 */
export interface PolicyGrantFact {
  readonly grantId: string;
  readonly revision: number;
  readonly currentRevision: number;
  readonly authorizationEpoch: number;
  readonly provenanceRef: string;
  readonly actorId: string;
  readonly projectId: string | null;
  readonly actionKinds: readonly PolicyActionKind[];
  readonly subjects: readonly PolicySubjectRef[];
  readonly candidateDigest: string | null;
  readonly actionDigest: string | null;
  readonly validFrom: string | null;
  readonly expiresAt: string | null;
  readonly revoked: boolean;
  readonly remainingUses: number | null;
  readonly budgetLimit: number | null;
  readonly retryLimit: number | null;
}
export interface PolicySubjectFact extends PolicySubjectRevision {
  readonly active: boolean;
  readonly candidateDigest: string | null;
}
/**
 * 仅可信服务/适配器能构造；禁止把 HTTP/MCP 正文或模型判断直接转为本类型。
 * 可缺字段是为了报告 evaluation_incomplete，缺值从不默认为有权/低风险。
 */
export interface TrustedPolicyFacts {
  readonly principal?: {
    readonly actorId?: string | undefined;
    readonly active?: boolean | undefined;
    readonly membershipRevision?: number | null | undefined;
    readonly currentMembershipRevision?: number | null | undefined;
  } | undefined;
  readonly project?: { readonly projectId?: string | null | undefined; readonly active?: boolean | undefined } | undefined;
  readonly subjects?: readonly PolicySubjectFact[] | undefined;
  readonly proposal?: {
    readonly readAllowed?: boolean | undefined; readonly createAllowed?: boolean | undefined;
    readonly inScope?: boolean | undefined; readonly kindAllowed?: boolean | undefined;
    readonly delegable?: boolean | undefined; readonly prohibited?: boolean | undefined;
  } | undefined;
  readonly execution?: {
    readonly resourceAccess?: boolean | undefined; readonly capabilityAllowed?: boolean | undefined;
    readonly inScope?: boolean | undefined; readonly authorizationCurrent?: boolean | undefined;
    readonly hostSupported?: boolean | undefined; readonly prohibited?: boolean | undefined;
  } | undefined;
  readonly authorization?: {
    readonly authorizationEpoch?: number | undefined;
    readonly existingAuthorization?: boolean | undefined;
    readonly grants?: readonly PolicyGrantFact[] | undefined;
  } | undefined;
  readonly budget?: {
    /** 0 表示可信适配器确认无需支出；null 表示尚不能度量，不是无限额度。 */
    readonly requiredUnits?: number | null | undefined;
    readonly availableUnits?: number | null | undefined;
    readonly mayRequestIncrease?: boolean | undefined;
  } | undefined;
  readonly retries?: {
    readonly requested?: number | undefined; readonly available?: number | undefined; readonly mayRequestIncrease?: boolean | undefined;
  } | undefined;
  readonly userReserved?: boolean | undefined;
  readonly delivery?: {
    readonly ciPassed?: boolean | undefined; readonly independentReviewPassed?: boolean | undefined; readonly targetCurrent?: boolean | undefined;
  } | undefined;
}
export interface PolicyActionRegistry {
  readonly revision: number;
  /** 只有已注册且 available 的 handler 才能被评估；这不是可调用执行器。 */
  readonly handlers: readonly {
    readonly kind: PolicyActionKind; readonly handlerId: string; readonly revision: number; readonly available: boolean;
  }[];
}
export interface PolicyEvaluationContext {
  readonly evaluatedAt: string;
  /** 调用方读取一致快照后提供的版本身份；内核不生成持久修订。 */
  readonly policyRevision: string;
  readonly registry: PolicyActionRegistry;
  readonly facts: TrustedPolicyFacts;
}
export interface PolicyEvaluationRequest {
  readonly action: unknown;
  readonly stage: PolicyStage;
  readonly policies: unknown;
  readonly context: PolicyEvaluationContext;
}
export interface PolicyReason {
  readonly code: string;
  readonly message: string;
  readonly ruleId: string;
}
export interface PolicyExecutionPrerequisite {
  readonly code: "authorization_required" | "budget_increase_required" | "retry_increase_required" | "candidate_refresh_required" | "delivery_checks_required" | "fresh_human_required";
  readonly message: string;
}
export interface PolicyGrantRef {
  readonly grantId: string; readonly revision: number; readonly provenanceRef: string;
}
export interface PolicyGrantCheck {
  readonly grantId: string; readonly revision: number; readonly matched: boolean; readonly reasons: readonly string[];
}
export interface PolicyRuleMatch {
  readonly ruleId: string;
  readonly outcome: PolicyOutcome;
  readonly requiresFreshHuman: boolean;
  readonly source: PolicyRuleSource;
}
export interface PolicyEvaluation extends NormalizedPolicyAction {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly mode: "observation";
  /** 所有结果均为观察，auto 也不能用作执行准入。 */
  readonly executionAdmission: "not-issued";
  readonly stage: PolicyStage;
  readonly status: "evaluated" | "evaluation_incomplete";
  readonly policyRevision: string;
  readonly globalRevision: number;
  readonly projectRevision: number | null;
  readonly defaultRevision: number;
  readonly registryRevision: number;
  readonly evaluatedAt: string;
  readonly outcome: PolicyOutcome;
  readonly matchedRuleIds: readonly string[];
  readonly matchedRules: readonly PolicyRuleMatch[];
  readonly effectiveSource: readonly PolicyRuleSource[];
  readonly grantRefs: readonly PolicyGrantRef[];
  readonly grantChecks: readonly PolicyGrantCheck[];
  readonly requiresFreshHuman: boolean;
  readonly reasons: readonly PolicyReason[];
  readonly missingFacts: readonly string[];
  readonly executionPrerequisites: readonly PolicyExecutionPrerequisite[];
}
export interface PolicyPreview {
  readonly kind: "policy-preview";
  readonly sideEffects: "none";
  readonly evaluation: PolicyEvaluation;
}

/** S1-T2：持久配置引用仅标识规则来源，不是批准、grant 或执行许可。 */
export type PolicyDocument = GlobalPolicyDocument | ProjectPolicyDocument;
export interface PolicyDocumentRef {
  readonly scope: "user" | "project";
  readonly projectId: string | null;
  readonly revision: number;
  readonly contentDigest: string;
}
export interface PolicyVersionMetadata {
  readonly ref: PolicyDocumentRef;
  readonly defaultRevision: number;
  /** 保存项目配置时实际校验的全局版本；全局文档为 null。 */
  readonly basedOnGlobalRevision: number | null;
  readonly createdBy: { readonly kind: "human" | "system"; readonly id: string };
  readonly createdAt: string;
}
export interface PersistedPolicyDocument<D extends PolicyDocument = PolicyDocument> extends PolicyVersionMetadata {
  readonly document: D;
}
export interface EffectivePolicyConfiguration extends ComposedPolicyRules {
  readonly policyRevision: string;
  readonly defaultRevision: number;
  readonly global: PersistedPolicyDocument<GlobalPolicyDocument>;
  readonly project: PersistedPolicyDocument<ProjectPolicyDocument> | null;
  readonly mode: "observation";
  readonly executionAdmission: "not-issued";
}
export interface PolicyCombinationConflict {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly fields: readonly string[];
  readonly repairEndpoint: string;
}

/** 草稿的 candidate 仅用于比较；base 是当前已持久版本，草稿不改变它。 */
export interface PolicyConfigurationPreview {
  readonly kind: "policy-configuration-preview";
  readonly source: "current" | "draft";
  readonly mode: "observation";
  readonly executionAdmission: "not-issued";
  readonly sideEffects: "none";
  readonly base: { readonly global: PolicyDocumentRef; readonly project: PolicyDocumentRef | null; readonly policyRevision: string };
  readonly candidate: ComposedPolicyRules & { readonly global: GlobalPolicyDocument; readonly project: ProjectPolicyDocument | null };
  readonly action: { readonly availability: "unavailable"; readonly reason: "trusted_adapter_unavailable"; readonly preview: PolicyPreview } | null;
}

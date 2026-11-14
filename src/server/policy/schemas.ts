import { z } from "zod";
import { POLICY_ACTION_KINDS, POLICY_SCHEMA_VERSION, POLICY_SUBJECT_KINDS } from "../../shared/policy.ts";
import type { PolicyAction, PolicySubjectRef } from "../../shared/policy.ts";

export type PolicyInputErrorCode = "action_input_invalid" | "policy_input_invalid" | "context_input_invalid";
export class PolicyInputError extends Error {
  readonly code: PolicyInputErrorCode;
  readonly fields: readonly string[];
  constructor(code: PolicyInputErrorCode, fields: readonly string[]) {
    const stableFields = [...new Set(fields)].sort();
    super(`${code}：请检查 ${stableFields.join("、")}。`);
    this.name = "PolicyInputError";
    this.code = code;
    this.fields = stableFields;
  }
}

const id = z.string().trim().min(1).max(200);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const description = z.string().trim().min(1).max(2000);
export const subjectRefSchema = z.object({ kind: z.enum(POLICY_SUBJECT_KINDS), id }).strict();
const subjectRevisionSchema = z.object({ subjectRef: subjectRefSchema, revision }).strict();
const baseAction = {
  schemaVersion: z.literal(POLICY_SCHEMA_VERSION), projectId: id.nullable(), subjectRef: subjectRefSchema,
  expectedSubjectRevisions: z.array(subjectRevisionSchema).min(1).max(100), candidateDigest: digest.nullable(),
};
const resources = z.array(z.string().trim().min(1).max(4096)).min(1).max(100);
const artifactPayload = z.object({ artifactDigest: digest, targetRef: id }).strict();
export const policyActionSchema = z.discriminatedUnion("kind", [
  z.object({ ...baseAction, kind: z.literal("task.execute"), payload: z.object({ operation: z.enum(["read", "investigate", "verify", "implement"]) }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("task.assign"), payload: z.object({ assigneeMemberId: id }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("task.replan"), payload: z.object({ change: z.enum(["decompose", "dependencies", "technical-choice", "repair"]), planDigest: digest }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("review.decide"), payload: z.object({ choice: z.enum(["pass", "changes_requested"]) }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("runtime.start_authorized"), payload: z.object({ configurationRevision: revision }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("runtime.retry_authorized"), payload: z.object({ previousAttemptId: id }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("scope.change"), payload: z.object({ requestedResources: resources, reason: description }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("authorization.expand"), payload: z.object({ requestedActionKinds: z.array(z.enum(POLICY_ACTION_KINDS)).min(1).max(POLICY_ACTION_KINDS.length), requestedResources: resources, reason: description }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("delivery.create_pr"), payload: z.object({ repositoryId: id, sourceRef: id, targetRef: id }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("delivery.merge"), payload: z.object({ pullRequestRef: id, targetRef: id }).strict() }).strict(),
  z.object({ ...baseAction, kind: z.literal("delivery.deploy"), payload: artifactPayload }).strict(),
  z.object({ ...baseAction, kind: z.literal("delivery.publish"), payload: artifactPayload }).strict(),
]).superRefine((action, ctx) => {
  const refs = action.expectedSubjectRevisions.map(item => subjectKey(item.subjectRef));
  if (new Set(refs).size !== refs.length || !refs.includes(subjectKey(action.subjectRef))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedSubjectRevisions"], message: "引用必须唯一并包含动作主体" });
  }
  const validSubjects: Readonly<Record<PolicyAction["kind"], readonly PolicySubjectRef["kind"][]>> = {
    "task.execute": ["task"], "task.assign": ["task"], "task.replan": ["task"], "review.decide": ["review-round"],
    "runtime.start_authorized": ["runtime"], "runtime.retry_authorized": ["runtime"],
    "scope.change": ["project", "workspace", "runtime"], "authorization.expand": ["project", "task", "authorization"],
    "delivery.create_pr": ["delivery"], "delivery.merge": ["delivery"], "delivery.deploy": ["delivery"], "delivery.publish": ["delivery"],
  };
  if (!validSubjects[action.kind].includes(action.subjectRef.kind)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectRef"], message: "主体类型与动作不符" });
  }
});

/** 无分隔符碰撞的引用编码；不读取引用所代表的资源。 */
export function subjectKey(ref: PolicySubjectRef): string { return JSON.stringify([ref.kind, ref.id]); }

const ruleShape = {
  ruleId: z.string().regex(/^(?!builtin\.|guard\.)[a-z][a-z0-9._-]{0,99}$/),
  when: z.object({
    actionKinds: z.array(z.enum(POLICY_ACTION_KINDS)).min(1).max(POLICY_ACTION_KINDS.length).optional(),
    projectIds: z.array(id).min(1).max(100).optional(), subjects: z.array(subjectRefSchema).min(1).max(100).optional(),
    candidateChanged: z.boolean().optional(), authorizationMatched: z.boolean().optional(),
    budget: z.enum(["within", "exceeded"]).optional(), retries: z.enum(["within", "exceeded"]).optional(), userReserved: z.boolean().optional(),
  }).strict(),
  outcome: z.enum(["auto", "owner", "human", "deny"]), reason: description, requiresFreshHuman: z.boolean(),
};
function checkFreshHuman(rule: z.infer<typeof ruleSchema>, ctx: z.RefinementCtx): void {
  if (rule.requiresFreshHuman && (rule.outcome === "auto" || rule.outcome === "owner" || rule.when.authorizationMatched !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiresFreshHuman"], message: "新人工选择不能依赖 standing grant 或低于 human" });
  }
}
const ruleSchema = z.object(ruleShape).strict();
export const policyDocumentsSchema = z.object({
  global: z.object({
    schemaVersion: z.literal(POLICY_SCHEMA_VERSION), scope: z.literal("user"), revision,
    rules: z.array(z.object({ ...ruleShape, locked: z.boolean(), overridable: z.boolean() }).strict().superRefine((rule, ctx) => {
      checkFreshHuman(rule, ctx);
      if (rule.locked && rule.overridable) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["overridable"], message: "锁定规则不可覆盖" });
    })).max(200),
  }).strict(),
  project: z.object({
    schemaVersion: z.literal(POLICY_SCHEMA_VERSION), scope: z.literal("project"), projectId: id, revision,
    rules: z.array(ruleSchema.superRefine(checkFreshHuman)).max(200),
    overrides: z.array(ruleSchema.superRefine(checkFreshHuman)).max(200),
  }).strict().optional(),
}).strict();

const units = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// 格式合法仍可能得到 NaN；拒绝不能解析的时间，避免授权期限比较失效。
const timestamp = z.string().max(40).datetime({ offset: true })
  .refine(value => Number.isFinite(Date.parse(value)), { message: "时间必须可解析为有效时刻" });
const grantSchema = z.object({
  grantId: id, revision, currentRevision: revision, authorizationEpoch: units, provenanceRef: id, actorId: id, projectId: id.nullable(),
  actionKinds: z.array(z.enum(POLICY_ACTION_KINDS)).min(1).max(POLICY_ACTION_KINDS.length),
  subjects: z.array(subjectRefSchema).min(1).max(100), candidateDigest: digest.nullable(),
  actionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(), validFrom: timestamp.nullable(), expiresAt: timestamp.nullable(),
  revoked: z.boolean(), remainingUses: units.nullable(), budgetLimit: units.nullable(), retryLimit: units.nullable(),
}).strict();
const trustedFactsSchema = z.object({
  principal: z.object({ actorId: id, active: z.boolean(), membershipRevision: revision.nullable(), currentMembershipRevision: revision.nullable() }).partial().strict().optional(),
  project: z.object({ projectId: id.nullable(), active: z.boolean() }).partial().strict().optional(),
  subjects: z.array(subjectRevisionSchema.extend({ active: z.boolean(), candidateDigest: digest.nullable() })).max(100).optional(),
  proposal: z.object({ readAllowed: z.boolean(), createAllowed: z.boolean(), inScope: z.boolean(), kindAllowed: z.boolean(), delegable: z.boolean(), prohibited: z.boolean() }).partial().strict().optional(),
  execution: z.object({ resourceAccess: z.boolean(), capabilityAllowed: z.boolean(), inScope: z.boolean(), authorizationCurrent: z.boolean(), hostSupported: z.boolean(), prohibited: z.boolean() }).partial().strict().optional(),
  authorization: z.object({ authorizationEpoch: units, existingAuthorization: z.boolean(), grants: z.array(grantSchema).max(200) }).partial().strict().optional(),
  budget: z.object({ requiredUnits: units.nullable(), availableUnits: units.nullable(), mayRequestIncrease: z.boolean() }).partial().strict().optional(),
  retries: z.object({ requested: units, available: units, mayRequestIncrease: z.boolean() }).partial().strict().optional(),
  userReserved: z.boolean().optional(),
  delivery: z.object({ ciPassed: z.boolean(), independentReviewPassed: z.boolean(), targetCurrent: z.boolean() }).partial().strict().optional(),
}).strict().superRefine((facts, ctx) => {
  const subjects = facts.subjects?.map(fact => subjectKey(fact.subjectRef)) ?? [];
  const grantIds = facts.authorization?.grants?.map(grant => grant.grantId) ?? [];
  if (new Set(subjects).size !== subjects.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subjects"], message: "主体事实重复" });
  if (new Set(grantIds).size !== grantIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization", "grants"], message: "授权事实重复" });
});
const evaluationRequestSchema = z.object({
  action: z.unknown(), policies: z.unknown(), stage: z.enum(["proposal", "execution"]),
  context: z.object({
    evaluatedAt: timestamp, policyRevision: id,
    registry: z.object({
      revision, handlers: z.array(z.object({ kind: z.enum(POLICY_ACTION_KINDS), handlerId: id, revision, available: z.boolean() }).strict()).max(POLICY_ACTION_KINDS.length),
    }).strict().superRefine((registry, ctx) => {
      if (new Set(registry.handlers.map(handler => handler.kind)).size !== registry.handlers.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["handlers"], message: "动作注册重复" });
      }
    }),
    facts: z.unknown(),
  }).strict(),
}).strict();

/** 缺失可信记录字段是调查缺口；类型错误/未知字段仍是无效输入。 */
export function parseEvaluationRequest(input: unknown) {
  const envelope = parsePolicyInput(evaluationRequestSchema, input, "context_input_invalid");
  const parsedFacts = trustedFactsSchema.safeParse(envelope.context.facts);
  let missingFacts: string[] = [];
  if (!parsedFacts.success) {
    const incomplete = parsedFacts.error.issues.every(issue => issue.code === "invalid_type" && issue.received === "undefined");
    if (!incomplete) parsePolicyInput(trustedFactsSchema, envelope.context.facts, "context_input_invalid");
    missingFacts = parsedFacts.error.issues.map(issue => ["facts", ...issue.path].join("."));
  }
  return {
    request: { ...envelope, context: { ...envelope.context, facts: parsedFacts.success ? parsedFacts.data : {} as z.infer<typeof trustedFactsSchema> } },
    missingFacts,
  };
}

/** 新合同的错误不改变已发布 v1 的输入错误类型和拒绝语义。 */
export class DbReviewPolicyInputError extends Error {
  readonly code = "fact_contract_mismatch";
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    const stableFields = [...new Set(fields)].sort();
    super(`fact_contract_mismatch：请检查 ${stableFields.join("、")}。`);
    this.name = "DbReviewPolicyInputError";
    this.fields = stableFields;
  }
}

const dbReviewActionSchema = policyActionSchema.refine(action => action.kind === "review.decide"
  && action.projectId !== null && action.candidateDigest !== null
  && action.expectedSubjectRevisions.length === 2
  && action.expectedSubjectRevisions[0]?.subjectRef.kind === "review-round"
  && action.expectedSubjectRevisions[1]?.subjectRef.kind === "task", { message: "仅接受完整的 DB review 动作" });
const dbReviewSubjectSchema = z.object({
  subjectRef: z.object({ kind: z.enum(["task", "review-round"]), id }).strict(),
  revision, active: z.boolean(), candidateDigest: digest.nullable(),
}).strict();
const dbReviewFactsSchema = z.object({
  factsContract: z.literal("s1.db-review-locked/v1"),
  authorityBasis: z.literal("same-transaction-current-permissions"),
  purpose: z.enum(["eligibility-observation", "resolver-check"]),
  principal: z.object({ actorId: id, active: z.boolean(), membershipRevision: revision.nullable(), currentMembershipRevision: revision.nullable() }).strict(),
  project: z.object({ projectId: id, active: z.boolean() }).strict(),
  subjects: z.array(dbReviewSubjectSchema).max(100),
  proposal: z.object({ readAllowed: z.boolean(), createAllowed: z.boolean(), inScope: z.boolean(), kindAllowed: z.boolean(), delegable: z.boolean(), prohibited: z.boolean() }).strict(),
  execution: z.object({ resourceAccess: z.boolean(), capabilityAllowed: z.boolean(), inScope: z.boolean(), authorizationCurrent: z.boolean(), hostSupported: z.boolean(), prohibited: z.boolean() }).strict(),
  authorization: z.object({ existingAuthorization: z.boolean(), grants: z.tuple([]) }).strict(),
  budget: z.object({ requiredUnits: z.literal(0), availableUnits: z.literal(0), mayRequestIncrease: z.literal(false) }).strict(),
  retries: z.object({ requested: z.literal(0), available: z.literal(0), mayRequestIncrease: z.literal(false) }).strict(),
  userReserved: z.literal(false),
}).strict().superRefine((facts, ctx) => {
  const subjects = facts.subjects.map(fact => subjectKey(fact.subjectRef));
  if (new Set(subjects).size !== subjects.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subjects"], message: "主体事实重复" });
});
const dbReviewPolicyRequestSchema = z.object({
  contractVersion: z.literal("s1.db-review-policy/v1"),
  action: dbReviewActionSchema, stage: z.enum(["proposal", "execution"]),
  policy: z.object({
    policyRevision: id,
    global: z.object({ revision, contentDigest: digest }).strict(),
    project: z.object({ revision, contentDigest: digest }).strict().nullable(),
    defaultRevision: revision,
  }).strict(),
  documents: z.unknown(),
  handler: z.object({
    handlerId: z.literal("s1.review-decide.db/v1"), revision: z.literal(1), kind: z.literal("review.decide"), available: z.boolean(),
    effects: z.literal("single-database-transaction"), resources: z.literal("database-only"),
    delegation: z.literal("none"), deferredEffects: z.literal("none"), grantUse: z.literal("none"),
  }).strict(),
  facts: dbReviewFactsSchema, evaluatedAt: timestamp,
}).strict();

/** 所有层级拒绝额外字段；零预算是固定 handler 合同，不是缺省值或未知预算的替身。 */
export function parseDbReviewPolicyRequestV1(input: unknown) {
  const parsed = dbReviewPolicyRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new DbReviewPolicyInputError(parsed.error.issues.flatMap(issue =>
      issue.code === "unrecognized_keys" ? issue.keys.map(key => [...issue.path, key].join(".")) : [issue.path.join(".") || "input"]));
  }
  return parsed.data;
}

export function parsePolicyInput<T>(schema: z.ZodType<T>, input: unknown, code: PolicyInputErrorCode): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new PolicyInputError(code, parsed.error.issues.flatMap(issue =>
      issue.code === "unrecognized_keys" ? issue.keys.map(key => [...issue.path, key].join(".")) : [issue.path.join(".") || "input"]));
  }
  return parsed.data;
}

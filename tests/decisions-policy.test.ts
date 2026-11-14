import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../src/server/policy/index.ts";
import type { DbReviewPolicyRequestV1 } from "../src/server/policy/db-review.ts";
import { POLICY_ACTION_KINDS } from "../src/shared/policy.ts";
import type { GlobalPolicyRule, PolicyDocuments, PolicyEvaluationRequest, PolicyOutcome, PolicyRule } from "../src/shared/policy.ts";
import { policyFixture, policyGrantFixture } from "./helpers/policy-fixture.ts";

function reviewRequest(): DbReviewPolicyRequestV1 {
  return {
    contractVersion: "s1.db-review-policy/v1",
    action: {
      schemaVersion: 1, kind: "review.decide", projectId: "project-1",
      subjectRef: { kind: "review-round", id: "round-1" },
      expectedSubjectRevisions: [
        { subjectRef: { kind: "review-round", id: "round-1" }, revision: 3 },
        { subjectRef: { kind: "task", id: "task-1" }, revision: 7 },
      ],
      candidateDigest: "a".repeat(64), payload: { choice: "pass" },
    },
    stage: "execution",
    policy: {
      policyRevision: "snapshot-1", global: { revision: 1, contentDigest: "b".repeat(64) },
      project: null, defaultRevision: 1,
    },
    documents: { global: policy.createDefaultPolicy(1) },
    handler: {
      handlerId: "s1.review-decide.db/v1", revision: 1, kind: "review.decide", available: true,
      effects: "single-database-transaction", resources: "database-only",
      delegation: "none", deferredEffects: "none", grantUse: "none",
    },
    facts: {
      factsContract: "s1.db-review-locked/v1", authorityBasis: "same-transaction-current-permissions",
      purpose: "resolver-check",
      principal: { actorId: "reviewer-1", active: true, membershipRevision: 2, currentMembershipRevision: 2 },
      project: { projectId: "project-1", active: true },
      subjects: [
        { subjectRef: { kind: "review-round", id: "round-1" }, revision: 3, active: true, candidateDigest: "a".repeat(64) },
        { subjectRef: { kind: "task", id: "task-1" }, revision: 7, active: true, candidateDigest: null },
      ],
      proposal: { readAllowed: true, createAllowed: true, inScope: true, kindAllowed: true, delegable: true, prohibited: false },
      execution: { resourceAccess: true, capabilityAllowed: true, inScope: true, authorizationCurrent: true, hostSupported: true, prohibited: false },
      authorization: { existingAuthorization: true, grants: [] },
      budget: { requiredUnits: 0, availableUnits: 0, mayRequestIncrease: false },
      retries: { requested: 0, available: 0, mayRequestIncrease: false },
      userReserved: false,
    },
    evaluatedAt: "2026-11-13T12:00:00.000Z",
  };
}

/** 只用于已发布 v1 的对照输入；真实新入口从不构造或传入 epoch。 */
function legacyRequest(request: DbReviewPolicyRequestV1): PolicyEvaluationRequest {
  const { principal, project, subjects, proposal, execution, authorization, budget, retries, userReserved } = request.facts;
  const { kind, handlerId, revision, available } = request.handler;
  return {
    action: request.action, policies: request.documents, stage: request.stage,
    context: {
      evaluatedAt: request.evaluatedAt, policyRevision: request.policy.policyRevision,
      registry: { revision, handlers: [{ kind, handlerId, revision, available }] },
      facts: { principal, project, subjects, proposal, execution,
        authorization: { ...authorization, authorizationEpoch: 4 }, budget, retries, userReserved },
    },
  };
}
function factMismatch(input: unknown, label: string): void {
  assert.throws(() => policy.evaluateDbReviewPolicyV1(input as DbReviewPolicyRequestV1),
    error => error instanceof policy.DbReviewPolicyInputError && error.code === "fact_contract_mismatch", label);
}
function withDocuments(documents: PolicyDocuments): DbReviewPolicyRequestV1 {
  const request = reviewRequest();
  return { ...request, documents, policy: {
    ...request.policy, global: { ...request.policy.global, revision: documents.global.revision },
    project: documents.project ? { revision: documents.project.revision, contentDigest: "c".repeat(64) } : null,
  } };
}
function rule(ruleId: string, outcome: PolicyOutcome): PolicyRule {
  return { ruleId, outcome, when: { actionKinds: ["review.decide"] }, reason: `规则 ${ruleId}`, requiresFreshHuman: false };
}
function globalRule(ruleId: string, outcome: PolicyOutcome, overridable = false): GlobalPolicyRule {
  return { ...rule(ruleId, outcome), locked: !overridable, overridable };
}
function documents(globals: readonly GlobalPolicyRule[], rules: readonly PolicyRule[] = [], overrides: readonly PolicyRule[] = []): PolicyDocuments {
  return {
    global: { schemaVersion: 1, scope: "user", revision: 2, rules: globals },
    project: { schemaVersion: 1, scope: "project", projectId: "project-1", revision: 3, rules, overrides },
  };
}

test("#157 V01：原 review v1 的 choice、摘要与完整求值逐值保持", () => {
  // 独立 Python hashlib + 显式规范 JSON 的固定向量；不是由新入口生成期望。
  const digests = {
    pass: "sha256:b8344a4a3316cb50c2f0870276479ac9d211b9f5272fd748573625f751538969",
    changes_requested: "sha256:a3cd4375a194fd2501a4668af680bfb2251c6546646d2bf1d552c9a84473b93c",
  };
  for (const choice of ["pass", "changes_requested"] as const) for (const stage of ["proposal", "execution"] as const) {
    const base = reviewRequest();
    const request = { ...base, stage, action: { ...base.action, payload: { choice } } };
    const legacy = legacyRequest(request);
    const oldResult = policy.evaluateAction(legacy);
    const result = policy.evaluateDbReviewPolicyV1(request);
    assert.equal(result.fullEvaluation.actionDigest, digests[choice]);
    assert.deepEqual(result.fullEvaluation, oldResult);
    assert.deepEqual(policy.previewPolicy(legacy).evaluation, oldResult);
  }
});

test("#157 V02：旧 v1 即使 grants 为空且已有授权，缺 epoch 仍拒绝且不选择新分支", () => {
  for (const stage of ["proposal", "execution"] as const) {
    const legacy = legacyRequest({ ...reviewRequest(), stage });
    const input = { ...legacy, context: { ...legacy.context, facts: { ...legacy.context.facts,
      authorization: { existingAuthorization: true, grants: [] },
    } } };
    const result = policy.evaluateAction(input);
    assert.equal(result.status, "evaluation_incomplete");
    assert.equal(result.outcome, "deny");
    assert.deepEqual(result.missingFacts, ["facts.authorization.authorizationEpoch"]);
    assert.deepEqual(policy.previewPolicy(input).evaluation, result);
    assert.equal(result.executionAdmission, "not-issued");
  }
});

test("#157 V03：旧 v1 保持 epoch 类型、额外字段与 schema 的拒绝语义", () => {
  const legacy = legacyRequest(reviewRequest());
  for (const authorizationEpoch of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4"]) {
    const invalid = { ...legacy, context: { ...legacy.context, facts: { ...legacy.context.facts,
      authorization: { ...legacy.context.facts.authorization, authorizationEpoch },
    } } };
    assert.throws(() => policy.evaluateAction(invalid as PolicyEvaluationRequest),
      error => error instanceof policy.PolicyInputError && error.code === "context_input_invalid");
  }
  for (const invalid of [
    { ...legacy, contractVersion: "s1.db-review-policy/v1" },
    { ...legacy, context: { ...legacy.context, facts: { ...legacy.context.facts, factsContract: "s1.db-review-locked/v1" } } },
    { ...legacy, context: { ...legacy.context, facts: { ...legacy.context.facts,
      authorization: { ...legacy.context.facts.authorization, grantUse: "none" },
    } } },
  ]) assert.throws(() => policy.evaluateAction(invalid),
    error => error instanceof policy.PolicyInputError && error.code === "context_input_invalid");
  assert.throws(() => policy.evaluateAction({ ...legacy, action: { ...reviewRequest().action, schemaVersion: 2 } }),
    error => error instanceof policy.PolicyInputError && error.code === "action_input_invalid");
});

test("#157 V04：完整无 epoch 的 DB review 事实只返回当前策略观察", () => {
  assert.equal(typeof policy.evaluateDbReviewPolicyV1, "function", "独立的严格 DB review API 必须存在");
  const request = reviewRequest();
  const result = policy.evaluateDbReviewPolicyV1(request);
  assert.equal(result.factsContract, "s1.db-review-locked/v1");
  assert.equal(result.purpose, "resolver-check");
  assert.deepEqual(result.evaluationPrincipal, { kind: "agent", id: "reviewer-1" });
  assert.equal(result.status, "evaluated");
  assert.equal(result.outcome, "owner");
  assert.equal(result.mode, "observation");
  assert.equal(result.executionAdmission, "not-issued");
  assert.deepEqual(result.grantRefs, []);
  assert.deepEqual(result.missingFacts, []);
  assert.deepEqual(result.policy, request.policy);
  assert.deepEqual(result.matchedRuleIds, ["default.review.decide"]);
  assert.equal(result.fullEvaluation.executionAdmission, "not-issued");
  assert.deepEqual(result.fullEvaluation.grantRefs, []);
  assert.deepEqual(result.fullEvaluation.grantChecks, []);
});

test("#157 V04：观察不能返回与实际规则文档不一致的策略版本身份", () => {
  const request = reviewRequest();
  const inputs = [
    { ...request, policy: { ...request.policy, global: { ...request.policy.global, revision: 2 } } },
    { ...request, policy: { ...request.policy, defaultRevision: 2 } },
    { ...request, policy: { ...request.policy, project: { revision: 2, contentDigest: "c".repeat(64) } } },
    { ...request, documents: { global: policy.createDefaultPolicy(1), project: {
      schemaVersion: 1, scope: "project", projectId: "project-1", revision: 2, rules: [], overrides: [],
    } } },
  ];
  for (const input of inputs) assert.throws(() => policy.evaluateDbReviewPolicyV1(input),
    error => error instanceof policy.DbReviewPolicyInputError && error.code === "fact_contract_mismatch"
      && error.fields.some(field => field.startsWith("policy.")));
});

test("#157 V05：新分支拒绝任何 epoch、非空 grants 和非 none 的 grantUse", () => {
  const request = reviewRequest();
  for (const authorizationEpoch of [0, 2, null, undefined]) factMismatch({ ...request, facts: { ...request.facts,
    authorization: { ...request.facts.authorization, authorizationEpoch },
  } }, `不能以 ${String(authorizationEpoch)} 代替 epoch`);
  for (const grants of [[policyGrantFixture(legacyRequest(request))], [{}], "none", undefined]) factMismatch({
    ...request, facts: { ...request.facts, authorization: { ...request.facts.authorization, grants } },
  }, "grants 必须是显式空 tuple");
  for (const grantUse of ["match", "optional", undefined]) factMismatch({ ...request, handler: { ...request.handler, grantUse } }, "handler 不得消费 grant");
  factMismatch({ ...request, facts: { ...request.facts, authorization: { ...request.facts.authorization, memberRevision: 2 } } }, "不能自造授权代际字段");
});

test("#157 V06：所有非 review 动作及 Coordinator、skill 合同均不能进入新分支", () => {
  const request = reviewRequest();
  for (const kind of POLICY_ACTION_KINDS.filter(kind => kind !== "review.decide")) {
    const action = policyFixture(kind).action;
    assert.doesNotThrow(() => policy.normalizePolicyAction(action), "反例仍是原 v1 合法动作");
    factMismatch({ ...request, action }, kind);
  }
  for (const handlerId of ["coordinator.review/v1", "skill.review/v1"]) factMismatch({
    ...request, handler: { ...request.handler, handlerId },
  }, handlerId);
  for (const input of [
    { ...request, contractVersion: "s1.coordinator/v1" },
    { ...request, facts: { ...request.facts, factsContract: "trusted-policy/v1" } },
    { ...request, facts: { ...request.facts, authorityBasis: "standing-grant" } },
    { ...request, handler: { ...request.handler, kind: "runtime.start_authorized" } },
    { ...request, facts: { ...request.facts, skillRef: "skill-1" } },
  ]) factMismatch(input, "非 DB review 合同");
});

test("#157 V07：外部、未来、Run 和未知资源用量不能改写成零支出获准", () => {
  const request = reviewRequest();
  const handlers = [
    { effects: "external" }, { effects: "future" }, { resources: "network" },
    { delegation: "coordinator" }, { deferredEffects: "scheduled" }, { requiresRun: true }, { runId: "run-1" },
  ];
  for (const change of handlers) factMismatch({ ...request, handler: { ...request.handler, ...change } }, JSON.stringify(change));
  for (const change of [
    { requiredUnits: 1 }, { requiredUnits: null }, { availableUnits: 1 }, { availableUnits: null }, { mayRequestIncrease: true },
  ]) factMismatch({ ...request, facts: { ...request.facts, budget: { ...request.facts.budget, ...change } } }, JSON.stringify(change));
  for (const change of [{ requested: 1 }, { available: 1 }, { mayRequestIncrease: true }]) factMismatch({
    ...request, facts: { ...request.facts, retries: { ...request.facts.retries, ...change } },
  }, JSON.stringify(change));
  factMismatch({ ...request, facts: { ...request.facts, delivery: { ciPassed: true, independentReviewPassed: true, targetCurrent: true } } }, "不接受交付事实");
  factMismatch({ ...request, facts: { ...request.facts, userReserved: true } }, "DB review 无单独保留位，需以当前策略表达");
});

test("#157 V08：不可用 handler 返回拒绝，缺失、假 ID 或 revision 被严格拒绝", () => {
  const request = reviewRequest();
  const result = policy.evaluateDbReviewPolicyV1({ ...request, handler: { ...request.handler, available: false } });
  assert.equal(result.outcome, "deny");
  assert.equal(result.executionAdmission, "not-issued");
  assert.deepEqual(result.matchedRuleIds, ["guard.handler_unavailable"]);
  assert.ok(result.reasons.some(reason => reason.code === "handler_unavailable"));
  for (const handler of [undefined, { ...request.handler, handlerId: "fake:s1.review-decide.db/v1" },
    { ...request.handler, revision: 2 }, { ...request.handler, available: undefined }]) factMismatch({ ...request, handler }, "必须匹配当前已注册描述");
});

test("#157 V05：新 envelope 每层 strict，缺当前硬事实也不能被忽略或默认补全", () => {
  const request = reviewRequest();
  const cases = [
    { ...request, permit: true },
    { ...request, action: { ...request.action, override: true } },
    { ...request, action: { ...request.action, payload: { choice: "pass", approved: true } } },
    { ...request, action: { ...request.action, projectId: null } },
    { ...request, action: { ...request.action, candidateDigest: null } },
    { ...request, action: { ...request.action, expectedSubjectRevisions: [request.action.expectedSubjectRevisions[0]] } },
    { ...request, policy: { ...request.policy, grantUse: "none" } },
    { ...request, policy: { ...request.policy, global: { ...request.policy.global, locked: true } } },
    { ...request, facts: { ...request.facts, lowRisk: true } },
    { ...request, facts: { ...request.facts, principal: { ...request.facts.principal, kind: "human" } } },
    { ...request, facts: { ...request.facts, project: { ...request.facts.project, role: "owner" } } },
    { ...request, facts: { ...request.facts, subjects: [{ ...request.facts.subjects[0], current: true }, request.facts.subjects[1]] } },
    { ...request, facts: { ...request.facts, subjects: [...request.facts.subjects, request.facts.subjects[0]] } },
    { ...request, facts: { ...request.facts, proposal: { ...request.facts.proposal, approved: true } } },
    { ...request, facts: { ...request.facts, execution: { ...request.facts.execution, capabilityAllowed: undefined } } },
    { ...request, facts: { ...request.facts, execution: { ...request.facts.execution, hardPermission: true } } },
    { ...request, facts: { ...request.facts, authorization: { ...request.facts.authorization, existingAuthorization: undefined } } },
    { ...request, facts: { ...request.facts, budget: { ...request.facts.budget, currency: "free" } } },
    { ...request, facts: { ...request.facts, retries: { ...request.facts.retries, unlimited: true } } },
    { ...request, facts: { ...request.facts, principal: undefined } },
    { ...request, evaluatedAt: "not-a-time" },
  ];
  cases.forEach((input, index) => factMismatch(input, `严格合同反例 ${index + 1}`));
});

test("#157 V09：当前每项执行硬权限和 existingAuthorization 均独立阻断 auto", () => {
  const request = withDocuments(documents([globalRule("review.auto", "auto")]));
  for (const field of ["resourceAccess", "capabilityAllowed", "inScope", "authorizationCurrent", "hostSupported", "prohibited"] as const) {
    const input = { ...request, facts: { ...request.facts, execution: { ...request.facts.execution, [field]: field === "prohibited" } } };
    const result = policy.evaluateDbReviewPolicyV1(input);
    assert.equal(result.outcome, "deny", field);
    assert.deepEqual(result.fullEvaluation, policy.evaluateAction(legacyRequest(input)), field);
    assert.ok(result.reasons.some(reason => reason.code === `execution_${field}`));
  }
  const input = { ...request, facts: { ...request.facts, authorization: { ...request.facts.authorization, existingAuthorization: false } } };
  const execution = policy.evaluateDbReviewPolicyV1(input);
  assert.equal(execution.outcome, "deny");
  assert.ok(execution.reasons.some(reason => reason.code === "authorization_required"));
  const proposal = policy.evaluateDbReviewPolicyV1({ ...input, stage: "proposal" });
  assert.equal(proposal.outcome, "human");
  assert.equal(proposal.executionAdmission, "not-issued");
});

test("#157 V09：提案资格、当前成员代际、项目与全部受控对象保持硬拒绝", () => {
  const request = reviewRequest();
  for (const field of ["readAllowed", "createAllowed", "inScope", "kindAllowed", "delegable", "prohibited"] as const) {
    const input: DbReviewPolicyRequestV1 = { ...request, stage: "proposal", facts: { ...request.facts,
      proposal: { ...request.facts.proposal, [field]: field === "prohibited" },
    } };
    assert.equal(policy.evaluateDbReviewPolicyV1(input).outcome, "deny", field);
  }
  const facts = [
    { ...request.facts, principal: { ...request.facts.principal, active: false } },
    { ...request.facts, principal: { ...request.facts.principal, currentMembershipRevision: 3 } },
    { ...request.facts, project: { ...request.facts.project, active: false } },
    { ...request.facts, project: { ...request.facts.project, projectId: "other-project" } },
    ...request.facts.subjects.map((_, index) => ({ ...request.facts,
      subjects: request.facts.subjects.map((subject, at) => ({ ...subject, active: at !== index })),
    })),
  ];
  for (const current of facts) for (const stage of ["proposal", "execution"] as const) {
    const input = { ...request, stage, facts: current };
    const result = policy.evaluateDbReviewPolicyV1(input);
    assert.equal(result.outcome, "deny");
    assert.deepEqual(result.fullEvaluation, policy.evaluateAction(legacyRequest(input)));
  }
  const missing = policy.evaluateDbReviewPolicyV1({ ...request, facts: { ...request.facts, subjects: [request.facts.subjects[0]!] } });
  assert.equal(missing.status, "evaluation_incomplete");
  assert.equal(missing.outcome, "deny");
  assert.deepEqual(missing.missingFacts, ['facts.subjects.["task","task-1"]']);
});

test("#157 V10 纯边界：资格观察保持真实主体和 not-issued，深冻结输入没有改写或时钟副作用", t => {
  const base = reviewRequest();
  const request: DbReviewPolicyRequestV1 = { ...base, stage: "proposal", facts: { ...base.facts, purpose: "eligibility-observation" } };
  const before = structuredClone(request);
  function freezeDeep(value: unknown): void {
    if (value !== null && typeof value === "object") {
      Object.values(value).forEach(freezeDeep);
      Object.freeze(value);
    }
  }
  freezeDeep(request);
  t.mock.method(Date, "now", () => { throw new Error("纯观察不得读取当前时钟"); });
  for (let i = 0; i < 3; i++) {
    const observation = policy.evaluateDbReviewPolicyV1(request);
    assert.equal(observation.purpose, "eligibility-observation");
    assert.deepEqual(observation.evaluationPrincipal, { kind: "agent", id: "reviewer-1" });
    assert.equal(observation.executionAdmission, "not-issued");
    assert.equal(observation.fullEvaluation.executionAdmission, "not-issued");
    factMismatch(observation, "观察不能作为下一次求值的可信事实");
    factMismatch(JSON.parse(JSON.stringify(observation)), "序列化观察也不成为可信事实");
  }
  assert.deepEqual(request, before);
  assert.equal(Object.hasOwn(request.facts.authorization, "authorizationEpoch"), false);
  const human = policy.evaluateDbReviewPolicyV1({ ...base, facts: { ...base.facts,
    principal: { actorId: "human:local", active: true, membershipRevision: null, currentMembershipRevision: null },
  } });
  assert.deepEqual(human.evaluationPrincipal, { kind: "human", id: "human:local" });
  assert.equal(human.outcome, "owner", "实际主体身份与所需策略层级是独立字段");
  assert.equal(human.executionAdmission, "not-issued");
});

test("#157 V11：重排、选择器与当前授权规则结果一致，human/fresh 不被附加 auto/owner 降级", () => {
  const fresh = { ...globalRule("review.fresh", "human"), requiresFreshHuman: true };
  const authorized = { ...globalRule("review.authorized", "auto"), when: { authorizationMatched: true } };
  const selected = { ...globalRule("review.selected", "owner"), when: {
    actionKinds: ["review.decide"] as const, projectIds: ["other-project", "project-1"],
    subjects: [{ kind: "task" as const, id: "task-1" }, { kind: "review-round" as const, id: "round-1" }],
    candidateChanged: false, budget: "within" as const, retries: "within" as const, userReserved: false,
  } };
  const globals = [fresh, authorized, selected];
  const extras = [rule("project.auto", "auto"), rule("project.owner", "owner")];
  const expected = policy.evaluateDbReviewPolicyV1(withDocuments(documents(globals, extras)));
  assert.equal(expected.outcome, "human");
  assert.equal(expected.requiresFreshHuman, true);
  assert.ok(expected.fullEvaluation.executionPrerequisites.some(item => item.code === "fresh_human_required"));
  for (const order of [globals, [...globals].reverse(), [authorized, fresh, selected]]) for (const projectOrder of [extras, [...extras].reverse()]) {
    const input = withDocuments(documents(order, projectOrder));
    const result = policy.evaluateDbReviewPolicyV1(input);
    assert.deepEqual(result, expected);
    assert.deepEqual(result.fullEvaluation, policy.evaluateAction(legacyRequest(input)));
  }
  const reordered = { ...selected, when: { ...selected.when, projectIds: [...selected.when.projectIds].reverse(),
    subjects: [...selected.when.subjects].reverse() } };
  assert.deepEqual(policy.evaluateDbReviewPolicyV1(withDocuments(documents([reordered, fresh, authorized], extras))), expected);
});

test("#157 V11：明确项目覆盖、锁定规则和重复规则沿用原算法", () => {
  const original = globalRule("review.approval", "human", true);
  const replacement = rule(original.ruleId, "auto");
  const input = withDocuments(documents([original], [], [replacement]));
  const result = policy.evaluateDbReviewPolicyV1(input);
  assert.equal(result.outcome, "auto");
  assert.deepEqual(result.fullEvaluation, policy.evaluateAction(legacyRequest(input)));
  assert.deepEqual(result.fullEvaluation.effectiveSource, [{ scope: "project-override", ruleId: original.ruleId,
    revision: 3, projectId: "project-1", replacedGlobalRevision: 2 }]);
  assert.equal(policy.evaluateDbReviewPolicyV1(withDocuments(documents([original], [rule("project.deny", "deny")], [replacement]))).outcome, "deny");
  const invalidDocuments = [
    documents([{ ...original, locked: true, overridable: false }], [], [replacement]),
    documents([original, original]),
    documents([original], [replacement]),
    documents([original], [], [replacement, replacement]),
    documents([original], [], [rule("missing.rule", "auto")]),
    documents([{ ...globalRule("bad.fresh", "owner"), requiresFreshHuman: true }]),
    documents([{ ...globalRule("bad.fresh-auth", "human"), requiresFreshHuman: true, when: { authorizationMatched: true } }]),
  ];
  for (const docs of invalidDocuments) {
    const request = withDocuments(docs);
    for (const evaluate of [() => policy.evaluateDbReviewPolicyV1(request), () => policy.evaluateAction(legacyRequest(request))]) {
      assert.throws(evaluate, error => error instanceof policy.PolicyInputError && error.code === "policy_input_invalid");
    }
  }
});

test("#157 V11：默认回退、当前候选变化与项目范围拒绝同旧 v1", () => {
  const request = withDocuments(documents([]));
  const fallback = policy.evaluateDbReviewPolicyV1(request);
  assert.equal(fallback.outcome, "owner");
  assert.deepEqual(fallback.matchedRuleIds, ["builtin.default.review.decide"]);
  for (const change of [
    { revision: 4 }, { candidateDigest: "d".repeat(64) },
  ]) for (const stage of ["proposal", "execution"] as const) {
    const input = { ...request, stage, facts: { ...request.facts,
      subjects: request.facts.subjects.map((subject, at) => at === 0 ? { ...subject, ...change } : subject),
    } };
    const result = policy.evaluateDbReviewPolicyV1(input);
    assert.equal(result.outcome, stage === "proposal" ? "human" : "deny");
    assert.deepEqual(result.fullEvaluation, policy.evaluateAction(legacyRequest(input)));
  }
  const docs = documents([]);
  const wrongScope = withDocuments({ ...docs, project: { ...docs.project!, projectId: "other-project" } });
  const denied = policy.evaluateDbReviewPolicyV1(wrongScope);
  assert.equal(denied.outcome, "deny");
  assert.deepEqual(denied.matchedRuleIds, ["guard.policy_scope_mismatch"]);
  assert.deepEqual(denied.fullEvaluation, policy.evaluateAction(legacyRequest(wrongScope)));
});

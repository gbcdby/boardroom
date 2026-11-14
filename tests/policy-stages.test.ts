import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction, PolicyInputError } from "../src/server/policy/index.ts";
import type { PolicyEvaluationRequest, TrustedPolicyFacts } from "../src/shared/policy.ts";
import { policyFixture } from "./helpers/policy-fixture.ts";

function withFacts(request: PolicyEvaluationRequest, changes: Partial<TrustedPolicyFacts>): PolicyEvaluationRequest {
  return { ...request, context: { ...request.context, facts: { ...request.context.facts, ...changes } } };
}

for (const kind of ["authorization.expand", "scope.change", "task.execute"] as const) {
  test(`S1-AC04：${kind} 的有界扩权/预算提案进入 human；同一缺权动作不能执行`, () => {
    const base = policyFixture(kind);
    const request = withFacts(base, {
      authorization: { authorizationEpoch: 4, existingAuthorization: false, grants: [] },
      budget: { requiredUnits: 10, availableUnits: 5, mayRequestIncrease: true },
      execution: { ...base.context.facts.execution, authorizationCurrent: false, resourceAccess: false },
    });
    const proposal = evaluateAction(request);
    assert.equal(proposal.outcome, "human");
    assert.ok(proposal.executionPrerequisites.some(item => item.code === "authorization_required"));
    assert.ok(proposal.executionPrerequisites.some(item => item.code === "budget_increase_required"));
    assert.equal(evaluateAction({ ...request, stage: "execution" }).outcome, "deny");
    for (const field of ["readAllowed", "createAllowed", "inScope", "kindAllowed", "delegable"] as const) {
      const denied = evaluateAction(withFacts(request, { proposal: { ...request.context.facts.proposal, [field]: false } }));
      assert.equal(denied.outcome, "deny", field);
    }
    assert.equal(evaluateAction(withFacts(request, { proposal: { ...request.context.facts.proposal, prohibited: true } })).outcome, "deny");
  });
}

test("S1-AC04：执行逐项硬前提均不可被 auto 文本放宽；缺执行事实明确不完整", () => {
  const request = { ...policyFixture(), stage: "execution" as const };
  for (const field of ["resourceAccess", "capabilityAllowed", "inScope", "authorizationCurrent", "hostSupported"] as const) {
    const result = evaluateAction(withFacts(request, { execution: { ...request.context.facts.execution, [field]: false } }));
    assert.equal(result.outcome, "deny", field);
  }
  assert.equal(evaluateAction(withFacts(request, { execution: { ...request.context.facts.execution, prohibited: true } })).outcome, "deny");
  const incomplete = evaluateAction(withFacts(request, { execution: undefined }));
  assert.equal(incomplete.status, "evaluation_incomplete");
  assert.equal(incomplete.outcome, "deny");
  assert.equal(evaluateAction(withFacts(policyFixture(), { execution: undefined })).outcome, "auto", "提案不假定新资源的执行权限");
});

test("S1-AC04：停用/代际改变/跨项目事实拒绝，提案资格不绕过生命周期", () => {
  const request = policyFixture();
  const changes: Partial<TrustedPolicyFacts>[] = [
    { principal: { ...request.context.facts.principal, active: false } },
    { principal: { ...request.context.facts.principal, currentMembershipRevision: 3 } },
    { project: { projectId: "other-project", active: true } },
    { project: { projectId: "project-1", active: false } },
    { subjects: request.context.facts.subjects!.map(subject => ({ ...subject, active: false })) },
  ];
  for (const change of changes) for (const stage of ["proposal", "execution"] as const) {
    assert.equal(evaluateAction(withFacts({ ...request, stage }, change)).outcome, "deny");
  }
});

test("S1-AC04：可重设预算/重试额度提案交给人，不可重设或执行阶段拒绝", () => {
  const request = policyFixture();
  for (const mayRequestIncrease of [true, false]) {
    const overBudget = withFacts(request, { budget: { requiredUnits: 1, availableUnits: 0, mayRequestIncrease } });
    const overRetries = withFacts(request, { retries: { requested: 4, available: 3, mayRequestIncrease } });
    for (const candidate of [overBudget, overRetries]) {
      assert.equal(evaluateAction(candidate).outcome, mayRequestIncrease ? "human" : "deny");
      assert.equal(evaluateAction({ ...candidate, stage: "execution" }).outcome, "deny");
    }
  }
  assert.equal(evaluateAction(withFacts(request, { budget: { requiredUnits: 0, availableUnits: null, mayRequestIncrease: false } })).outcome, "auto", "已核实不支出不需要虚构预算");
  assert.equal(evaluateAction(withFacts(request, { budget: { requiredUnits: null, availableUnits: 0, mayRequestIncrease: false } })).status, "evaluation_incomplete");
});

test("S1-AC04：候选变更需要重建提案；交付 CI/双轴/目标版本不能由批准豁免", () => {
  const request = policyFixture("delivery.merge");
  const changed = withFacts(request, { subjects: request.context.facts.subjects!.map(subject => ({ ...subject, revision: 4 })) });
  assert.equal(evaluateAction(changed).outcome, "human");
  assert.equal(evaluateAction({ ...changed, stage: "execution" }).outcome, "deny");
  for (const field of ["ciPassed", "independentReviewPassed", "targetCurrent"] as const) {
    assert.equal(evaluateAction(withFacts(request, { delivery: { ...request.context.facts.delivery, [field]: false } })).outcome, "deny", field);
  }
  assert.equal(evaluateAction(withFacts(request, { delivery: undefined })).status, "evaluation_incomplete");
});

test("S1-AC04：未知可信字段、身份自报、预算无限数与注册冲突拒绝", () => {
  const request = policyFixture();
  const invalid: unknown[] = [
    withFacts(request, { ...{ lowRisk: true } } as TrustedPolicyFacts),
    { ...request, context: { ...request.context, facts: { ...request.context.facts, humanApproved: true } } },
    withFacts(request, { budget: { requiredUnits: 1, availableUnits: Infinity, mayRequestIncrease: true } }),
    { ...request, context: { ...request.context, registry: { revision: 1, handlers: [...request.context.registry.handlers, ...request.context.registry.handlers] } } },
  ];
  for (const input of invalid) assert.throws(() => evaluateAction(input as PolicyEvaluationRequest), error => error instanceof PolicyInputError && error.code === "context_input_invalid");
});

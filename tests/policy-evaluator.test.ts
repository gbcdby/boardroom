import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction } from "../src/server/policy/index.ts";
import type { PolicyActionKind, PolicyOutcome, TrustedPolicyFacts } from "../src/shared/policy.ts";
import { policyFixture } from "./helpers/policy-fixture.ts";

const defaults: readonly [PolicyActionKind, PolicyOutcome][] = [
  ["task.execute", "auto"], ["task.assign", "owner"], ["task.replan", "owner"], ["review.decide", "owner"],
  ["runtime.start_authorized", "auto"], ["runtime.retry_authorized", "owner"], ["scope.change", "human"], ["authorization.expand", "human"],
  ["delivery.create_pr", "auto"], ["delivery.merge", "auto"], ["delivery.deploy", "auto"], ["delivery.publish", "auto"],
];
for (const [kind, outcome] of defaults) test(`S1-AC04 默认：${kind} → ${outcome}，可解释且没有执行准入`, () => {
  const result = evaluateAction(policyFixture(kind));
  assert.equal(result.status, "evaluated");
  assert.equal(result.outcome, outcome);
  assert.equal(result.executionAdmission, "not-issued");
  assert.equal(result.mode, "observation");
  assert.ok(result.matchedRuleIds.length);
  assert.ok(result.effectiveSource.some(source => source.scope === "global"));
  assert.equal(result.globalRevision, 1);
  assert.equal(result.projectRevision, null);
  assert.equal(result.evaluatedAt, "2026-11-11T12:00:00.000Z");
});

test("S1-AC04：缺必需可信事实返回 evaluation_incomplete，undefined 不会成为 auto", () => {
  const request = policyFixture();
  for (const key of ["principal", "project", "subjects", "proposal", "authorization", "budget", "retries", "userReserved"] as const) {
    const facts: TrustedPolicyFacts = { ...request.context.facts, [key]: undefined };
    const result = evaluateAction({ ...request, context: { ...request.context, facts } });
    assert.equal(result.status, "evaluation_incomplete", key);
    assert.equal(result.outcome, "deny", key);
    assert.ok(result.missingFacts.some(path => path.startsWith(`facts.${key}`)), key);
  }
  const missingLeaf = evaluateAction({ ...request, context: { ...request.context, facts: {
    ...request.context.facts, budget: { requiredUnits: 3, availableUnits: null, mayRequestIncrease: true },
  } } });
  assert.equal(missingLeaf.status, "evaluation_incomplete");
  assert.ok(missingLeaf.missingFacts.includes("facts.budget.availableUnits"));
});

test("S1-AC04：不存在/不可用的 handler 不被默认 auto 伪装为支持", () => {
  const request = policyFixture("delivery.merge");
  for (const handlers of [[], [{ ...request.context.registry.handlers[0]!, available: false }]]) {
    const result = evaluateAction({ ...request, context: { ...request.context, registry: { revision: 1, handlers } } });
    assert.equal(result.outcome, "deny");
    assert.ok(result.reasons.some(reason => reason.code === "handler_unavailable"));
  }
});

test("S1-AC04：可信对象/授权快照缺字段同样返回缺项，而不是猜出完整事实", () => {
  const request = policyFixture();
  const facts = { ...request.context.facts, subjects: [{ ...request.context.facts.subjects![0]!, candidateDigest: undefined }] } as unknown as TrustedPolicyFacts;
  const result = evaluateAction({ ...request, context: { ...request.context, facts } });
  assert.equal(result.status, "evaluation_incomplete");
  assert.equal(result.outcome, "deny");
  assert.ok(result.missingFacts.includes("facts.subjects.0.candidateDigest"));
});

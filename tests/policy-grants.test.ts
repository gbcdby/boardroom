import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction, normalizePolicyAction } from "../src/server/policy/index.ts";
import type { PolicyEvaluationRequest, PolicyGrantFact } from "../src/shared/policy.ts";
import { policyFixture, policyGrantFixture } from "./helpers/policy-fixture.ts";

function withGrant(grantChanges: Partial<PolicyGrantFact> = {}): PolicyEvaluationRequest {
  const request = policyFixture("delivery.merge");
  return { ...request, context: { ...request.context, facts: {
    ...request.context.facts,
    authorization: { authorizationEpoch: 4, existingAuthorization: false, grants: [{ ...policyGrantFixture(request), ...grantChanges }] },
    budget: { requiredUnits: 3, availableUnits: 5, mayRequestIncrease: true },
    retries: { requested: 1, available: 3, mayRequestIncrease: true },
  } } };
}

test("S1-AC04：匹配的既有授权可复用，解释保留真实 grant 修订和来源", () => {
  const request = withGrant();
  const result = evaluateAction(request);
  assert.equal(result.outcome, "auto");
  assert.deepEqual(result.grantRefs, [{ grantId: "grant-1", revision: 2, provenanceRef: "user-event-1" }]);
  assert.deepEqual(result.grantChecks, [{ grantId: "grant-1", revision: 2, matched: true, reasons: [] }]);
  assert.equal(result.executionPrerequisites.length, 0);
  assert.deepEqual(evaluateAction(structuredClone(request)), result);
});

const invalidGrants: readonly [string, Partial<PolicyGrantFact>][] = [
  ["revision_changed", { currentRevision: 3 }],
  ["authorization_epoch_changed", { authorizationEpoch: 3 }],
  ["revoked", { revoked: true }],
  ["actor_mismatch", { actorId: "other-agent" }],
  ["project_mismatch", { projectId: "other-project" }],
  ["action_kind_mismatch", { actionKinds: ["task.execute"] }],
  ["resource_mismatch", { subjects: [{ kind: "delivery", id: "other-delivery" }] }],
  ["candidate_mismatch", { candidateDigest: "c".repeat(64) }],
  ["action_digest_mismatch", { actionDigest: `sha256:${"c".repeat(64)}` }],
  ["not_yet_valid", { validFrom: "2026-11-11T12:00:01.000Z" }],
  ["expired", { expiresAt: "2026-11-11T12:00:00.000Z" }],
  ["uses_exhausted", { remainingUses: 0 }],
  ["budget_limit_exceeded", { budgetLimit: 2 }],
  ["retry_limit_exceeded", { retryLimit: 0 }],
];
for (const [reason, changes] of invalidGrants) test(`S1-AC04：${reason} grant 不匹配；提案 human，执行 deny`, () => {
  const request = withGrant(changes);
  const result = evaluateAction(request);
  assert.equal(result.outcome, "human");
  assert.deepEqual(result.grantRefs, []);
  assert.ok(result.grantChecks[0]?.reasons.includes(reason));
  assert.ok(result.executionPrerequisites.some(item => item.code === "authorization_required"));
  assert.equal(evaluateAction({ ...request, stage: "execution" }).outcome, "deny");
});

test("S1-AC04：精确 actionDigest 绑定可匹配；新候选/新资源不会复用旧摘要授权", () => {
  const request = withGrant();
  const bound = normalizePolicyAction(request.action).actionDigest;
  assert.equal(evaluateAction(withGrant({ actionDigest: bound })).outcome, "auto");
  const action = normalizePolicyAction(request.action).action;
  assert.equal(evaluateAction({ ...withGrant({ actionDigest: bound }), action: { ...action, candidateDigest: "d".repeat(64) } }).outcome, "human");
});

test("S1-AC04：standing grant 不免除 requiresFreshHuman，也不补齐执行硬权限", () => {
  const request = withGrant();
  const reserved = evaluateAction({ ...request, context: { ...request.context, facts: { ...request.context.facts, userReserved: true } } });
  assert.equal(reserved.outcome, "human");
  assert.equal(reserved.requiresFreshHuman, true);
  assert.equal(reserved.grantRefs.length, 1);
  assert.ok(reserved.executionPrerequisites.some(item => item.code === "fresh_human_required"));
  const denied = evaluateAction({ ...request, stage: "execution", context: { ...request.context, facts: {
    ...request.context.facts, execution: { ...request.context.facts.execution, resourceAccess: false },
  } } });
  assert.equal(denied.outcome, "deny");
  assert.ok(denied.reasons.some(reason => reason.code === "execution_resourceAccess"));
});

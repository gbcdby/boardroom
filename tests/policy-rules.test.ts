import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAction } from "../src/server/policy/index.ts";
import type { GlobalPolicyRule, PolicyAction, PolicyDocuments, PolicyOutcome, PolicyRule } from "../src/shared/policy.ts";
import { policyFixture, policyGrantFixture } from "./helpers/policy-fixture.ts";

function rule(ruleId: string, outcome: PolicyOutcome): PolicyRule {
  return { ruleId, when: { actionKinds: ["task.execute"] }, outcome, reason: `规则 ${ruleId}`, requiresFreshHuman: false };
}
function globalRule(ruleId: string, outcome: PolicyOutcome, overridable = false): GlobalPolicyRule {
  return { ...rule(ruleId, outcome), locked: !overridable, overridable };
}
function policies(globals: readonly GlobalPolicyRule[], rules: readonly PolicyRule[] = [], overrides: readonly PolicyRule[] = []): PolicyDocuments {
  return { global: { schemaVersion: 1, scope: "user", revision: 4, rules: globals },
    project: { schemaVersion: 1, scope: "project", projectId: "project-1", revision: 7, rules, overrides } };
}
function permutations<T>(items: readonly T[]): T[][] {
  return items.length === 0 ? [[]] : items.flatMap((item, index) => permutations(items.filter((_, at) => at !== index)).map(tail => [item, ...tail]));
}

test("S1-AC04：规则 144 种排列均得相同结果、命中集合、来源与解释", () => {
  const request = policyFixture();
  const globals = [globalRule("global.auto", "auto"), globalRule("global.human", "human"), globalRule("global.owner", "owner"),
    { ...globalRule("global.unmatched", "deny"), when: { projectIds: ["other-project"] } }];
  const extras = [rule("project.auto", "auto"), rule("project.owner", "owner"), rule("project.deny", "deny")];
  const expected = evaluateAction({ ...request, policies: policies(globals, extras) });
  assert.equal(expected.outcome, "deny");
  assert.deepEqual(expected.effectiveSource, [{ scope: "project", ruleId: "project.deny", revision: 7, projectId: "project-1" }]);
  for (const order of permutations(globals)) for (const projectOrder of permutations(extras)) {
    assert.deepEqual(evaluateAction({ ...request, policies: policies(order, projectOrder) }), expected);
  }
});

test("S1-AC04：附加 auto 不能降低 human/deny；只能明确替换可覆盖 ruleId", () => {
  const request = policyFixture();
  const original = globalRule("global.approval", "human", true);
  assert.equal(evaluateAction({ ...request, policies: policies([original], [rule("extra.auto", "auto")]) }).outcome, "human");
  const replacement = rule(original.ruleId, "auto");
  const lowered = evaluateAction({ ...request, policies: policies([original], [], [replacement]) });
  assert.equal(lowered.outcome, "auto");
  assert.deepEqual(lowered.effectiveSource, [{ scope: "project-override", ruleId: original.ruleId, revision: 7, projectId: "project-1", replacedGlobalRevision: 4 }]);
  const strict = evaluateAction({ ...request, policies: policies([original], [rule("extra.deny", "deny"), rule("extra.auto", "auto")], [replacement]) });
  assert.equal(strict.outcome, "deny");
  const locked = globalRule("global.locked", "human");
  assert.equal(evaluateAction({ ...request, policies: policies([original, locked], [], [replacement]) }).outcome, "human");
});

test("S1-AC04：空命中按动作默认回退；错误项目策略不能混入有效规则", () => {
  const request = policyFixture("task.assign");
  const result = evaluateAction({ ...request, policies: policies([globalRule("unmatched", "deny")]) });
  assert.equal(result.outcome, "owner");
  assert.deepEqual(result.matchedRuleIds, ["builtin.default.task.assign"]);
  assert.equal(result.effectiveSource[0]?.scope, "default");
  const docs = policies([]);
  assert.equal(evaluateAction({ ...request, policies: { ...docs, project: { ...docs.project, projectId: "wrong-project" } } }).outcome, "deny");
});

test("S1-AC04：真实授权可被规则匹配，fresh-human 规则仍保留新用户来源要求", () => {
  const request = policyFixture();
  const grant = policyGrantFixture(request);
  const fresh: GlobalPolicyRule = { ...globalRule("global.fresh", "human"), requiresFreshHuman: true };
  const authorized: GlobalPolicyRule = { ...globalRule("global.authorized", "auto"), when: { authorizationMatched: true } };
  const result = evaluateAction({ ...request, policies: policies([fresh, authorized]), context: { ...request.context, facts: {
    ...request.context.facts, authorization: { authorizationEpoch: 4, existingAuthorization: false, grants: [grant] },
  } } });
  assert.equal(result.outcome, "human");
  assert.equal(result.requiresFreshHuman, true);
  assert.deepEqual(result.matchedRuleIds, ["global.authorized", "global.fresh"]);
  assert.ok(result.executionPrerequisites.some(item => item.code === "fresh_human_required"));
});

test("S1-AC04：grant、可信引用与集合条件的排列不改变解释", () => {
  const request = policyFixture();
  const grant = policyGrantFixture(request);
  const grants = [grant, { ...grant, grantId: "grant-2", provenanceRef: "user-event-2" }];
  const docs = policies([{ ...globalRule("global.sets", "auto"), when: {
    actionKinds: ["task.execute", "task.assign"], projectIds: ["project-2", "project-1"], subjects: [{ kind: "task", id: "other" }, { kind: "task", id: "subject-1" }],
  } }]);
  const base = { ...request, policies: docs, context: { ...request.context, facts: {
    ...request.context.facts, authorization: { authorizationEpoch: 4, existingAuthorization: false, grants },
  } } };
  const expected = evaluateAction(base);
  const original = docs.global.rules[0]!;
  assert.deepEqual(evaluateAction({ ...base, policies: policies([{ ...original, when: {
    actionKinds: [...original.when.actionKinds!].reverse(), projectIds: [...original.when.projectIds!].reverse(), subjects: [...original.when.subjects!].reverse(),
  } }]), context: { ...base.context, facts: { ...base.context.facts, authorization: { ...base.context.facts.authorization, grants: [...grants].reverse() } } } }), expected);
});

test("S1-AC04：资源选择器保护每个受控引用，不能仅检查主 subjectRef", () => {
  const request = policyFixture();
  const action = request.action as PolicyAction;
  const workspace = { kind: "workspace", id: "restricted-workspace" } as const;
  const result = evaluateAction({ ...request,
    action: { ...action, expectedSubjectRevisions: [...action.expectedSubjectRevisions, { subjectRef: workspace, revision: 1 }] },
    context: { ...request.context, facts: { ...request.context.facts, subjects: [
      ...request.context.facts.subjects!, { subjectRef: workspace, revision: 1, active: true, candidateDigest: null },
    ] } },
    policies: policies([{ ...globalRule("global.resource-boundary", "deny"), when: { subjects: [workspace] } }]),
  });
  assert.equal(result.outcome, "deny");
  assert.deepEqual(result.matchedRuleIds, ["global.resource-boundary"]);
});

test("S1-AC04：可信快照中的无关对象不扩大动作作用域，也不误拦授权内工作", () => {
  const request = policyFixture();
  const result = evaluateAction({ ...request, context: { ...request.context, facts: {
    ...request.context.facts, subjects: [...request.context.facts.subjects!, {
      subjectRef: { kind: "task", id: "unrelated-inactive" }, revision: 7, active: false, candidateDigest: null,
    }],
  } } });
  assert.equal(result.outcome, "auto");
});

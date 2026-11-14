import test from "node:test";
import assert from "node:assert/strict";
import { composePolicyRules, normalizePolicyAction, PolicyInputError } from "../src/server/policy/index.ts";
import type { GlobalPolicyRule, PolicyRule } from "../src/shared/policy.ts";

const action = {
  schemaVersion: 1,
  kind: "task.execute",
  projectId: "project-1",
  subjectRef: { kind: "task", id: "task-1" },
  expectedSubjectRevisions: [
    { subjectRef: { kind: "task", id: "task-1" }, revision: 3 },
    { subjectRef: { kind: "workspace", id: "workspace-1" }, revision: 2 },
  ],
  candidateDigest: "a".repeat(64),
  payload: { operation: "implement" },
};

test("S1-AC04：动作键序及无序引用排列不改变规范动作摘要", () => {
  const first = normalizePolicyAction(action);
  const reordered = normalizePolicyAction({
    payload: { operation: "implement" }, candidateDigest: action.candidateDigest,
    expectedSubjectRevisions: [...action.expectedSubjectRevisions].reverse(),
    subjectRef: { id: "task-1", kind: "task" }, projectId: "project-1", kind: "task.execute", schemaVersion: 1,
  });
  assert.deepEqual(reordered, first);
  assert.match(first.actionDigest, /^sha256:[a-f0-9]{64}$/);
  // 独立 Python hashlib + 显式 canonical JSON 已核对的跨实现固定向量。
  assert.equal(first.actionDigest, "sha256:d35a6b3ce4f49ddf25fe8e30ca326ac7fc3be354a2f1aa4365debea27eb5330e");
  assert.notEqual(normalizePolicyAction({ ...action, payload: { operation: "verify" } }).actionDigest, first.actionDigest);
});

const humanRule: GlobalPolicyRule = {
  ruleId: "delivery.approval", when: { actionKinds: ["delivery.merge"] },
  outcome: "human", reason: "合并需确认", requiresFreshHuman: false, locked: false, overridable: true,
};
const replacement: PolicyRule = {
  ruleId: humanRule.ruleId, when: humanRule.when, outcome: "auto", reason: "项目已有合并约定", requiresFreshHuman: false,
};
function documents(overrides: readonly PolicyRule[] = [replacement]) {
  return {
    global: { schemaVersion: 1, scope: "user", revision: 3, rules: [humanRule] },
    project: { schemaVersion: 1, scope: "project", projectId: "project-1", revision: 4, rules: [], overrides },
  };
}
test("S1-AC04：项目只通过明确 ruleId 替换可覆盖全局规则并保留来源", () => {
  const result = composePolicyRules(documents());
  assert.deepEqual(result.rules, [{ rule: replacement, source: {
    scope: "project-override", ruleId: humanRule.ruleId, revision: 4, projectId: "project-1", replacedGlobalRevision: 3,
  } }]);
  const extra = { ...replacement, ruleId: "project.extra", outcome: "deny" };
  const input = documents();
  assert.equal(composePolicyRules({ ...input, project: { ...input.project, rules: [extra] } }).rules.length, 2);
});

test("S1-AC04：锁定、未声明可覆盖、重名、删规则、额外覆盖字段与任意表达式拒绝", () => {
  const input = documents();
  const cases: unknown[] = [
    { ...input, global: { ...input.global, rules: [{ ...humanRule, locked: true, overridable: false }] } },
    { ...input, global: { ...input.global, rules: [{ ...humanRule, overridable: false }] } },
    { ...input, global: { ...input.global, rules: [humanRule, humanRule] } },
    { ...input, project: { ...input.project, rules: [replacement] } },
    documents([{ ...replacement, ruleId: "missing.rule" }]),
    { ...input, project: { ...input.project, overrides: [{ ...replacement, delete: true }] } },
    { ...input, project: { ...input.project, overrides: [{ ...replacement, locked: false }] } },
    { ...input, project: { ...input.project, overrides: [{ ...replacement, when: { expression: "return true" } }] } },
    { ...input, project: { ...input.project, overrides: [null] } },
    { ...input, project: { ...input.project, overrides: [{ ...replacement, requiresFreshHuman: true }] } },
  ];
  for (const value of cases) assert.throws(() => composePolicyRules(value), error => error instanceof PolicyInputError && error.code === "policy_input_invalid");
});

test("S1-AC04：未知动作、自报权限/风险、脚本和重复引用均以稳定错误拒绝", () => {
  for (const input of [
    { ...action, kind: "shell.execute" },
    { ...action, lowRisk: true },
    { ...action, payload: { operation: "implement", authorized: true } },
    { ...action, payload: { operation: "implement", expression: "process.exit()" } },
    { ...action, expectedSubjectRevisions: [...action.expectedSubjectRevisions, action.expectedSubjectRevisions[0]] },
    { ...action, expectedSubjectRevisions: [] },
    { ...action, subjectRef: { kind: "project", id: "project-1" } },
  ]) {
    assert.throws(() => normalizePolicyAction(input), error => error instanceof PolicyInputError && error.code === "action_input_invalid");
  }
});

import type { ComposedPolicyRules, EffectivePolicyRule, PolicyConditions, PolicyRule } from "../../shared/policy.ts";
import { compareText } from "./canonical.ts";
import { parsePolicyInput, policyDocumentsSchema, PolicyInputError, subjectKey } from "./schemas.ts";

function normalizeRule(rule: PolicyRule): PolicyRule {
  const when: PolicyConditions = {
    ...rule.when,
    ...(rule.when.actionKinds ? { actionKinds: [...new Set(rule.when.actionKinds)].sort() } : {}),
    ...(rule.when.projectIds ? { projectIds: [...new Set(rule.when.projectIds)].sort() } : {}),
    ...(rule.when.subjects ? { subjects: [...new Map(rule.when.subjects.map(ref => [subjectKey(ref), ref])).values()]
      .sort((a, b) => compareText(subjectKey(a), subjectKey(b))) } : {}),
  };
  return { ruleId: rule.ruleId, when, outcome: rule.outcome, reason: rule.reason, requiresFreshHuman: rule.requiresFreshHuman };
}

/** 输入只能是已加载的用户/项目策略快照；组合不修改原文档。 */
export function composePolicyRules(input: unknown): ComposedPolicyRules {
  const { global, project } = parsePolicyInput(policyDocumentsSchema, input, "policy_input_invalid");
  const conflicts: string[] = [];
  function uniqueRules(rules: readonly PolicyRule[], field: string): Map<string, PolicyRule> {
    const result = new Map<string, PolicyRule>();
    for (const rule of rules) {
      if (result.has(rule.ruleId)) conflicts.push(`${field}.${rule.ruleId}`);
      result.set(rule.ruleId, rule);
    }
    return result;
  }
  uniqueRules(global.rules, "global.rules");
  const extras = uniqueRules(project?.rules ?? [], "project.rules");
  const overrides = uniqueRules(project?.overrides ?? [], "project.overrides");
  const originals = new Map(global.rules.map(rule => [rule.ruleId, rule]));
  for (const ruleId of extras.keys()) {
    if (originals.has(ruleId) || overrides.has(ruleId)) conflicts.push(`project.rules.${ruleId}`);
  }
  for (const ruleId of overrides.keys()) {
    const original = originals.get(ruleId);
    if (!original || original.locked || !original.overridable) conflicts.push(`project.overrides.${ruleId}`);
  }
  if (conflicts.length) throw new PolicyInputError("policy_input_invalid", conflicts);

  const rules: EffectivePolicyRule[] = global.rules.map(original => {
    const replacement = overrides.get(original.ruleId);
    return replacement && project ? {
      rule: normalizeRule(replacement), source: {
        scope: "project-override", ruleId: original.ruleId, revision: project.revision,
        projectId: project.projectId, replacedGlobalRevision: global.revision,
      },
    } : {
      rule: normalizeRule(original), source: { scope: "global", ruleId: original.ruleId, revision: global.revision, projectId: null },
    };
  });
  if (project) for (const rule of extras.values()) rules.push({
    rule: normalizeRule(rule), source: { scope: "project", ruleId: rule.ruleId, revision: project.revision, projectId: project.projectId },
  });
  return {
    globalRevision: global.revision, projectRevision: project?.revision ?? null, projectId: project?.projectId ?? null,
    rules: rules.sort((a, b) => compareText(a.rule.ruleId, b.rule.ruleId)),
  };
}

import { POLICY_ACTION_KINDS } from "../../shared/policy.ts";
import type { GlobalPolicyDocument, GlobalPolicyRule, PolicyActionKind } from "../../shared/policy.ts";
import { parsePolicyInput, policyDocumentsSchema } from "./schemas.ts";

export const DEFAULT_POLICY_REVISION = 1 as const;

/** 负责人是项目决策者；owner 不代表绕过 authz 或把权限提升为本地人。 */
export function defaultRuleFor(kind: PolicyActionKind): GlobalPolicyRule {
  const owner = ["task.assign", "task.replan", "review.decide", "runtime.retry_authorized"].includes(kind);
  const human = kind === "authorization.expand" || kind === "scope.change";
  return {
    ruleId: `default.${kind}`, when: { actionKinds: [kind] },
    outcome: human ? "human" : owner ? "owner" : "auto",
    reason: human ? "改变范围或授权需要新的用户选择；批准本身不产生执行权限。"
      : owner ? "组织、技术或重试取舍由项目负责人决定并汇报。"
        : kind.startsWith("delivery.") ? "已有明确交付授权且所需检查满足，可沿用授权处理本动作。"
          : "授权内且事实完整的常规工作，无需重复人工确认。",
    requiresFreshHuman: human, locked: human, overridable: !human,
  };
}

/** 返回独立数据，供未来持久服务显式保存；本函数不写配置或数据库。 */
export function createDefaultPolicy(revision: number): GlobalPolicyDocument {
  return parsePolicyInput(policyDocumentsSchema, {
    global: { schemaVersion: 1, scope: "user", revision, rules: POLICY_ACTION_KINDS.map(defaultRuleFor) },
  }, "policy_input_invalid").global;
}

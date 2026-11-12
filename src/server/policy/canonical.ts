import { createHash } from "node:crypto";
import type { NormalizedPolicyAction, PolicyAction } from "../../shared/policy.ts";
import { parsePolicyInput, policyActionSchema, subjectKey } from "./schemas.ts";

/** 仅用于已验证 JSON 数据：对象键按 JS UTF-16 顺序排序，数组顺序由各 schema 的语义决定。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => compareText(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function normalizePolicyAction(input: unknown): NormalizedPolicyAction {
  const parsed = parsePolicyInput(policyActionSchema, input, "action_input_invalid");
  let action: PolicyAction = {
    ...parsed,
    expectedSubjectRevisions: [...parsed.expectedSubjectRevisions].sort((a, b) => compareText(subjectKey(a.subjectRef), subjectKey(b.subjectRef))),
  };
  if (action.kind === "scope.change") {
    // 资源描述/动作种类是集合，重复不增加范围；排序不依赖系统 locale。
    action = { ...action, payload: { ...action.payload, requestedResources: [...new Set(action.payload.requestedResources)].sort() } };
  }
  if (action.kind === "authorization.expand") {
    action = { ...action, payload: { ...action.payload,
      requestedResources: [...new Set(action.payload.requestedResources)].sort(),
      requestedActionKinds: [...new Set(action.payload.requestedActionKinds)].sort(),
    } };
  }
  return { action, actionDigest: `sha256:${createHash("sha256").update(`boardroom.action.v1\n${canonicalJson(action)}`, "utf8").digest("hex")}` };
}

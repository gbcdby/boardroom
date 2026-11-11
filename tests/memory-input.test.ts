import test from "node:test";
import assert from "node:assert/strict";
import { invokeMemoryOperation, MEMORY_COMMANDS } from "../src/server/memory/mcp.ts";
import type { MemoryService, MemoryAccess } from "../src/server/memory/service.ts";
import { actorForSession } from "../src/server/authz/actors.ts";

const binding = { projectId: "project-one", agentId: "agent-one", memberId: "member-one", groupId: "group-one" };
const access: MemoryAccess = { actor: actorForSession(binding), connection: binding, injectionBindingGeneration: "trusted-generation" };
function stub() {
  const calls: unknown[] = [];
  const service = { read: async (...args: unknown[]) => { calls.push(args); return { document: null, version: 0 }; },
    write: async (...args: unknown[]) => { calls.push(args); return {}; },
    submitSummary: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as MemoryService;
  return { service, calls };
}
test("记忆 MCP 全局身份来自可信绑定，项目范围与伪造字段在调用服务前拒绝", async () => {
  const f = stub();
  const read = await invokeMemoryOperation(f.service, access, binding, "read", { scope: "global" });
  assert.deepEqual(read, { ok: true, document: null, version: 0 });
  assert.deepEqual((f.calls[0] as unknown[])[1], { scope: "global", agentId: "agent-one", projectId: null });
  for (const input of [
    { scope: "global", targetAgentId: "another" },
    { scope: "project-agent", projectId: "foreign" },
  ]) await assert.rejects(invokeMemoryOperation(f.service, access, binding, "read", input), { code: "FORBIDDEN" });
  for (const field of ["actor", "memberId", "agentId", "source", "bindingGeneration", "firstMcpDeliveredAt"]) {
    await assert.rejects(invokeMemoryOperation(f.service, access, binding, "read", { scope: "global", [field]: "forged" }), error => (error as { reason: string }).reason === "memory_input_invalid");
  }
  assert.equal(f.calls.length, 1);
});
test("记忆 MCP 写入保持正文和 CAS，不能写 revision 或伪造 self-summary 来源", async () => {
  const f = stub();
  const input = { scope: "project-agent", targetAgentId: "target", expectedVersion: 0, clientMutationId: "save-1", markdown: "# 文本\n  🧠" };
  await invokeMemoryOperation(f.service, access, binding, "write", input);
  assert.deepEqual((f.calls[0] as unknown[])[1], { scope: "project-agent", projectId: binding.projectId, agentId: "target" });
  assert.deepEqual((f.calls[0] as unknown[])[2], { expectedVersion: 0, clientMutationId: "save-1", markdown: input.markdown });
  for (const patch of [{ source: "self-summary" }, { expectedVersion: -1 }, { clientMutationId: "" }, { markdown: "\ud800" }]) {
    await assert.rejects(invokeMemoryOperation(f.service, access, binding, "write", { ...input, ...patch }));
  }
  assert.equal(f.calls.length, 1);
});
test("自总结入口只接收 attempt 与声明证据，平台验证来源和畸形摘要被拒绝", async () => {
  const f = stub();
  const evidence = { provenance: "agent-declared", host: "fixture", hostVersion: "unit-only",
    invocationId: "inv", contextId: "ctx", startedAt: "2026-11-11T00:00:00Z", completedAt: "2026-11-11T00:01:00Z",
    promptSha256: "a".repeat(64), outputSha256: "b".repeat(64), evidenceRef: "unit-only-not-model" };
  const input = { requestId: "request", expectedRequestRevision: 2, attemptId: "attempt", markdown: "声明不是模型实测", evidence };
  await invokeMemoryOperation(f.service, access, binding, "submit_summary", input);
  assert.equal(f.calls.length, 1);
  for (const patch of [{ provenance: "platform-verified" }, { outputSha256: "short" }, { completedAt: "invalid" }]) {
    await assert.rejects(invokeMemoryOperation(f.service, access, binding, "submit_summary", { ...input, evidence: { ...evidence, ...patch } }));
  }
  assert.equal(f.calls.length, 1);
  assert.equal(Object.keys(MEMORY_COMMANDS).length, 10);
});

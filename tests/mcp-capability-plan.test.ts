import test from "node:test";
import assert from "node:assert/strict";
import { createToolCatalogSnapshot } from "../src/server/mcp/capabilities/catalog.ts";
import { resolveToolPlan, previewToolSchema } from "../src/server/mcp/capabilities/plan.ts";

function fixture() {
  const catalog = createToolCatalogSnapshot({
    connection: { connectionId: "boardroom", revision: 1, enabled: true,
      transport: { type: "streamable-http", endpoint: "http://localhost:9999/mcp" } },
    observedAt: "2026-11-12T00:00:00Z",
    discovery: { status: "available", tools: [
      { name: "send", description: "发送消息", inputSchema: { type: "object" } },
      { name: "search", description: "搜索知识", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "deploy", description: "UNAUTHORIZED_SECRET_DESCRIPTION", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ] },
  });
  const ref = (name: string) => catalog.tools.find((tool) => tool.ref.name === name)!.ref;
  const scope = { projectId: "p1", groupId: "g1", groupBindingId: "b1", instanceId: "i1",
    instanceGeneration: 1, conversationId: "c1", conversationEpoch: 1, configurationRevision: 1, authorizationEpoch: 1 };
  return {
    catalog, ref, scope,
    input: { scope, catalogs: [catalog], selections: [
      { toolRef: ref("send"), mode: "resident", requirement: "required", sourceRef: "profile/p1@1" },
      { toolRef: ref("search"), mode: "on-demand", requirement: "optional", sourceRef: "binding/b1@1" },
      { toolRef: ref("deploy"), mode: "resident", requirement: "optional", sourceRef: "binding/b1@1" },
    ], availability: { scope, connections: [{ ...catalog.connection, authorized: true }], allowedTools: [ref("send"), ref("search")] } },
  };
}

test("S7 按显式选择和当前许可先裁剪，再区分常驻 schema 与按需摘要", () => {
  const { input, ref } = fixture();
  const plan = resolveToolPlan(input);
  assert.equal(plan.mode, "observation");
  assert.equal(plan.executionAdmission, "not-issued");
  assert.deepEqual(plan.initialTools.map((tool) => tool.ref.name), ["send"]);
  assert.deepEqual(plan.onDemandTools.map((tool) => tool.ref.name), ["search"]);
  assert.equal("inputSchema" in plan.onDemandTools[0]!, false);
  assert.equal(JSON.stringify(plan).includes("UNAUTHORIZED_SECRET_DESCRIPTION"), false);
  assert.deepEqual(plan.unavailable.map((item) => [item.toolRef.name, item.reason]), [["deploy", "not_authorized"]]);
  assert.equal(plan.selectionCompleteness, "complete");
  assert.equal(plan.missingOptionalCount, 1);
  assert.equal(plan.optionalDegradation, "requires-explicit-policy");
  const schema = previewToolSchema(input, ref("search"));
  assert.equal(schema?.tool.ref.name, "search");
  assert.deepEqual(schema?.tool.inputSchema, { type: "object", properties: { query: { type: "string" } } });
  assert.equal(schema?.executionAdmission, "not-issued");
  assert.equal(previewToolSchema(input, ref("deploy")), null);
});

test("S7 已许可目录和角色提示本身不启用工具；不接受第二份身份/角色控制源", () => {
  const { input, ref } = fixture();
  const empty = resolveToolPlan({ ...input, selections: [] });
  assert.deepEqual(empty.initialTools, []);
  assert.deepEqual(empty.onDemandTools, []);
  assert.equal(previewToolSchema({ ...input, selections: [] }, ref("send")), null);
  for (const extra of [{ role: "owner" }, { recommendations: [ref("deploy")] }, { executionAdmission: "approved" }]) {
    assert.throws(() => resolveToolPlan({ ...input, ...extra }), /invalid_plan_input/);
  }
  const denied = resolveToolPlan({ ...input, availability: { ...input.availability, allowedTools: [] } });
  assert.deepEqual(denied.initialTools, []);
  assert.deepEqual(denied.onDemandTools, []);
  assert.equal(denied.selectionCompleteness, "required-missing");
  assert.equal(denied.missingRequiredCount, 1);
  assert.equal(JSON.stringify(denied).includes("UNAUTHORIZED_SECRET_DESCRIPTION"), false);
});

test("S7 每一作用域/代际变化都隔离计划；旧 scope 的许可快照不可用于新上下文", () => {
  const { input, scope } = fixture();
  const initial = resolveToolPlan(input);
  for (const [field, value] of Object.entries(scope)) {
    const changed = { ...scope, [field]: typeof value === "number" ? value + 1 : value + "-other" };
    assert.throws(() => resolveToolPlan({ ...input, scope: changed }), /availability_scope_mismatch/);
    const next = resolveToolPlan({ ...input, scope: changed, availability: { ...input.availability, scope: changed } });
    assert.notEqual(next.scopeDigest, initial.scopeDigest, field);
    assert.notEqual(next.planDigest, initial.planDigest, field);
    assert.equal(next.executionAdmission, "not-issued");
  }
});

test("S7 普通保存形成新计划，实时许可收紧使新预览拒绝旧 schema，旧计划保持原事实", () => {
  const { input, ref } = fixture();
  const first = resolveToolPlan(input);
  const firstJson = JSON.stringify(first);
  const reordered = resolveToolPlan({ ...input, selections: [...input.selections].reverse(),
    availability: { ...input.availability, allowedTools: [...input.availability.allowedTools].reverse() } });
  assert.deepEqual(reordered, first);
  const configured = resolveToolPlan({ ...input, selections: input.selections.map((selection) =>
    selection.toolRef.name === "search" ? { ...selection, mode: "resident" } : selection) });
  assert.notEqual(configured.planDigest, first.planDigest);
  assert.deepEqual(configured.initialTools.map((tool) => tool.ref.name), ["search", "send"]);
  const scope = { ...input.scope, authorizationEpoch: 2 };
  const revoked = { ...input, scope, availability: {
    ...input.availability, scope, allowedTools: [ref("send")],
  } };
  const next = resolveToolPlan(revoked);
  assert.deepEqual(next.onDemandTools, []);
  assert.equal(previewToolSchema(revoked, ref("search")), null);
  assert.notEqual(next.planDigest, first.planDigest);
  assert.equal(JSON.stringify(first), firstJson);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.scope), true);
});

test("S7 required/optional 和缺失原因准确，不自动扩大选择或允许降级", () => {
  const { input, ref, catalog } = fixture();
  const onlySend = { ...input, selections: [input.selections[0]!] };
  const check = (change: Record<string, unknown>, reason: string) => {
    const plan = resolveToolPlan({ ...onlySend, ...change });
    assert.deepEqual(plan.initialTools, []);
    assert.deepEqual(plan.onDemandTools, []);
    assert.equal(plan.unavailable[0]?.reason, reason);
    assert.equal(plan.selectionCompleteness, "required-missing");
    assert.equal(plan.missingRequiredCount, 1);
    assert.equal(plan.executionAdmission, "not-issued");
  };
  const state = input.availability.connections[0]!;
  check({ availability: { ...input.availability, connections: [] } }, "not_configured");
  check({ availability: { ...input.availability, connections: [{ ...state, enabled: false }] } }, "connection_disabled");
  check({ availability: { ...input.availability, connections: [{ ...state, authorized: false }] } }, "not_authorized");
  check({ availability: { ...input.availability, connections: [{ ...state, revision: 2 }] } }, "connection_revision_mismatch");
  check({ availability: { ...input.availability, connections: [{ ...state, configurationDigest: "0".repeat(64) }] } }, "connection_configuration_mismatch");
  check({ catalogs: [] }, "catalog_unavailable");
  const missingRef = { ...ref("send"), name: "missing" };
  check({ selections: [{ ...input.selections[0], toolRef: missingRef }],
    availability: { ...input.availability, allowedTools: [missingRef] } }, "tool_missing");
  const oldRef = { ...ref("send"), schemaDigest: "0".repeat(64) };
  check({ selections: [{ ...input.selections[0], toolRef: oldRef }],
    availability: { ...input.availability, allowedTools: [oldRef] } }, "schema_mismatch");
  for (const status of ["not_discovered", "connection_failed", "discovery_failed"]) {
    const failed = createToolCatalogSnapshot({
      connection: { connectionId: "boardroom", revision: 1, enabled: true,
        transport: { type: "streamable-http", endpoint: "http://localhost:9999/mcp" } },
      observedAt: catalog.observedAt, discovery: { status },
    });
    check({ catalogs: [failed] }, status);
  }
  const optional = resolveToolPlan({ ...onlySend, selections: [{ ...input.selections[0], requirement: "optional" }],
    availability: { ...input.availability, allowedTools: [] } });
  assert.equal(optional.selectionCompleteness, "complete");
  assert.equal(optional.missingRequiredCount, 0);
  assert.equal(optional.missingOptionalCount, 1);
  assert.equal(optional.optionalDegradation, "requires-explicit-policy");
});

test("S7 同名 A/B 连接只提供已选的那一份，凭据/连接目录修订纳入计划身份", () => {
  const { input, catalog } = fixture();
  const other = createToolCatalogSnapshot({
    connection: { connectionId: "other", revision: 3, enabled: true,
      transport: { type: "stdio", command: "not-executed", args: [], credentialRef: "credentials/other" } },
    observedAt: catalog.observedAt,
    discovery: { status: "available", tools: [
      { name: "send", description: "仅 B 服务", inputSchema: { type: "object", properties: { b: { type: "number" } } } },
    ] },
  });
  const otherRef = other.tools[0]!.ref;
  const next = resolveToolPlan({
    ...input, catalogs: [catalog, other],
    selections: [...input.selections, { toolRef: otherRef, mode: "on-demand", requirement: "required", sourceRef: "binding/b1@1" }],
    availability: { ...input.availability,
      connections: [...input.availability.connections, { ...other.connection, authorized: true }],
      allowedTools: [...input.availability.allowedTools, otherRef] },
  });
  assert.deepEqual(next.initialTools.map((tool) => tool.ref.connectionId), ["boardroom"]);
  assert.deepEqual(next.onDemandTools.map((tool) => [tool.ref.connectionId, tool.ref.name]), [["boardroom", "search"], ["other", "send"]]);
  assert.equal(JSON.stringify(next).includes("credentials/other"), false);
  assert.equal(JSON.stringify(next).includes("not-executed"), false);
  assert.notEqual(next.planDigest, resolveToolPlan(input).planDigest);
});

test("S7 重复/歧义来源、无效代际、伪造引用及篡改目录拒绝", () => {
  const { input, ref } = fixture();
  assert.throws(() => resolveToolPlan({ ...input, catalogs: [...input.catalogs, ...input.catalogs] }), /duplicate_catalog/);
  assert.throws(() => resolveToolPlan({ ...input, selections: [...input.selections, input.selections[0]] }), /duplicate_selection/);
  assert.throws(() => resolveToolPlan({ ...input, availability: { ...input.availability, connections: [
    ...input.availability.connections, ...input.availability.connections,
  ] } }), /duplicate_connection/);
  assert.throws(() => resolveToolPlan({ ...input, availability: { ...input.availability, allowedTools: [ref("send"), ref("send")] } }), /duplicate_allowance/);
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.throws(() => resolveToolPlan({ ...input, scope: { ...input.scope, instanceGeneration: generation } }), /invalid_plan_input/);
  }
  assert.throws(() => previewToolSchema(input, { ...ref("send"), runId: "forged" }), /invalid_tool_ref/);
  const tampered = JSON.parse(JSON.stringify(input.catalogs));
  tampered[0].tools[0].inputSchema.extra = true;
  assert.throws(() => resolveToolPlan({ ...input, catalogs: tampered }), /snapshot_integrity_mismatch/);
});

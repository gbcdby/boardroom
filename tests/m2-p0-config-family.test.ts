import test from "node:test";
import assert from "node:assert/strict";
import { checkP0ConfigurationFamily } from "../src/server/identity/internal/m2-p0-config-family.ts";
import { createP0Request, retainP0Rows, readP0Text, readP0Json, p0RowSite, withP0Guard, chargeP0, p0Usage } from "../src/server/identity/internal/m2-p0.ts";
import type { P0Result, P0Request, P0View } from "../src/server/identity/internal/m2-p0.ts";
import { inspectMcpConnection, createToolCatalogSnapshot } from "../src/server/mcp/capabilities/catalog.ts";
import { canonicalJson as mcpCanonical } from "../src/server/mcp/capabilities/json.ts";
import { eCore, eAdd, eSet, ePolicy, ePolicyHead, eRuntime, E_TIME, E_DIGEST } from "./helpers/m2-p0-e-fixture.ts";
import type { EInput } from "./helpers/m2-p0-e-fixture.ts";
import { p0Fixture } from "./helpers/m2-p0-a-fixture.ts";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { createRuntimeRepository } from "../src/server/runtime/repository.ts";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "../src/server/identity/legacy-config-inspection.ts";
import { readLegacyConfigCapture } from "../src/server/identity/legacy-config-capture.ts";
import { createRuntimeObservability } from "../src/server/runtime/observability.ts";
import { RUNTIME_EVENT_NAMES } from "../src/server/runtime/observation-types.ts";
import { newId } from "../src/server/db/ids.ts";
import { createLogger } from "../src/server/logger.ts";
import { PolicyInputError, policyInputErrorCode, policyDocumentsSchema } from "../src/server/policy/schemas.ts";
import { CapabilityInputError, capabilityInputErrorCode } from "../src/server/mcp/capabilities/json.ts";
function ok<T>(result: P0Result<T>): T { if (!result.ok) assert.fail(JSON.stringify(result.error)); return result.value; }
const request = (input: EInput) => ok(createP0Request(JSON.stringify(input)));
function failure(input: EInput, rule: string, code = "semantic_invariant_failed") {
  const result = checkP0ConfigurationFamily(request(input)); assert.equal(result.ok, false);
  if (result.ok) assert.fail(); assert.equal(result.error.rule, rule); assert.equal(result.error.code, code); return result.error;
}
for (const backend of ["sqlite", "postgres"] as const) {
  test(`RT01 owned runner requires its exact reservation in both graphs (${backend})`, () => {
    for (const broken of ["orphan", "owner", "generation", "expiry"] as const) {
      const input = eCore(backend); eRuntime(input);
      for (const table of ["agent_runner_states", "agent_runtime_members"] as const) {
        eSet(input, table, 0, "lease_owner", "same-owner");
        eSet(input, table, 0, "lease_expires_at", "2000-01-01T00:00:00.000Z");
      }
      eSet(input, "agent_runtime_members", 0, "binding_id", "binding");
      if (broken === "orphan") for (const column of ["binding_id", "lease_owner", "lease_expires_at"]) eSet(input, "agent_runtime_members", 0, column, null);
      else if (broken === "owner") eSet(input, "agent_runtime_members", 0, "lease_owner", "different-owner");
      else if (broken === "generation") eSet(input, "agent_runner_states", 0, "generation", 5);
      else eSet(input, "agent_runtime_members", 0, "lease_expires_at", "2001-01-01T00:00:00.000Z");
      const req = request(input);
      for (const retained of [false, true]) {
        const view = retained ? retainP0Rows(req, input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0]))) : req.original;
        const result = checkP0ConfigurationFamily(req, view);
        assert.equal(result.ok, false, broken); if (result.ok) assert.fail();
        assert.equal(result.error.rule, "PC1B-RT01");
        assert.equal(result.error.code, retained ? "retained_reference_conflict" : "semantic_invariant_failed");
        assert.equal(result.error.location?.table, "agent_runner_states"); assert.equal(result.error.location?.rowOrdinal, 0);
      }
    }
    const released = eCore(backend); eRuntime(released);
    eSet(released, "agent_runner_states", 0, "generation", 99);
    const req = request(released); ok(checkP0ConfigurationFamily(req));
    ok(checkP0ConfigurationFamily(req, retainP0Rows(req, released.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0])))));
  });
  test(`MCP01 reserves derived projection nodes before the real URL consumer (${backend})`, () => {
    const input = eCore(backend), declaration = { connectionId: "connection", revision: 1, enabled: false,
      transport: { type: "streamable-http", endpoint: "https://example.test/not-contacted" } };
    const projection = inspectMcpConnection(declaration);
    eAdd(input, "mcp_connections", { id: "connection", revision: 1, discovery_sequence: 0, created_at: E_TIME, updated_at: E_TIME });
    eAdd(input, "mcp_connection_versions", { connection_id: "connection", revision: 1, name: "Name", configuration_json: JSON.stringify(declaration), configuration_digest: projection.configurationDigest, created_at: E_TIME });
    for (const retained of [false, true]) {
      const req = request(input), row = req.original.rows("mcp_connection_versions")[0]!;
      ok(withP0Guard(req, () => readP0Json(req, row, "configuration_json", "reference", p0RowSite(req, req.original, row, "configuration_json"))));
      if (retained) ok(checkP0ConfigurationFamily(req));
      const view = retained ? retainP0Rows(req, input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0]))) : req.original;
      // Old reservation: three 13-node declarations plus one family node.
      chargeP0(req, { nodes: 250000 - p0Usage(req).nodes - 40 });
      const NativeURL = globalThis.URL; let calls = 0;
      let result: ReturnType<typeof checkP0ConfigurationFamily>;
      try {
        globalThis.URL = class extends NativeURL { constructor(input: string | URL, base?: string | URL) { calls++; super(input, base); } };
        result = checkP0ConfigurationFamily(req, view);
      } finally { globalThis.URL = NativeURL; }
      assert.equal(calls, 0); assert.equal(result.ok, false); if (result.ok) assert.fail();
      assert.equal(result.error.code, "resource_limit");
      assert.deepEqual(checkP0ConfigurationFamily(req, view), result);
    }
  });
  test(`POL01 checks all versions but composes only actual current pairs (${backend})`, () => {
    const input = eCore(backend), rule = { ruleId: "old.rule", when: {}, outcome: "auto", reason: "old", requiresFreshHuman: false };
    ePolicy(input, { schemaVersion: 1, scope: "user", revision: 1, rules: [{ ...rule, locked: false, overridable: true }] });
    ePolicy(input, { schemaVersion: 1, scope: "user", revision: 2, rules: [] });
    ePolicy(input, { schemaVersion: 1, scope: "project", projectId: "p", revision: 1, rules: [], overrides: [rule] }, 1);
    ePolicy(input, { schemaVersion: 1, scope: "project", projectId: "p", revision: 2, rules: [], overrides: [] }, 2);
    ePolicyHead(input, "user", 2); ePolicyHead(input, "project", 2);
    const req = request(input); ok(checkP0ConfigurationFamily(req));
    const all = input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0]));
    const retained = retainP0Rows(req, all.filter(r => !(r.table === "policy_document_versions" && r.rowOrdinal === 0)));
    const deleted = checkP0ConfigurationFamily(req, retained); assert.equal(deleted.ok, false);
    if (deleted.ok) assert.fail(); assert.equal(deleted.error.code, "retained_reference_conflict");
    assert.equal(deleted.error.location?.rowOrdinal, 2);
    eSet(input, "policy_documents", 1, "revision", 1); failure(input, "PC1B-POL01");
  });
  test(`POL01 original canonical bytes and domain digest remain exact (${backend})`, () => {
    const input = eCore(backend); ePolicy(input, { schemaVersion: 1, scope: "user", revision: 1, rules: [] }); ePolicyHead(input, "user", 1);
    ok(checkP0ConfigurationFamily(request(input)));
    eSet(input, "policy_document_versions", 0, "content_digest", "b".repeat(64)); failure(input, "PC1B-POL01");
  });
  test(`WS01 resolves exact head while retaining distinct raw/canonical roots (${backend})`, () => {
    const input = eCore(backend); eSet(input, "projects", 0, "workspace_revision", 2);
    for (const revision of [1, 2]) eAdd(input, "project_workspace_versions", { project_id: "p", workspace_revision: revision, project_revision: revision,
      root_path: "/link", canonical_root: "/real", mode: "isolated", root_identity_json: '{"device":"1","inode":"2","birthtimeNs":"3"}',
      physical_resource_key: "observed", repository_info_json: '{"kind":"not_git","topLevel":null,"head":null,"dirty":null,"trackedChangedCount":null,"untrackedCount":null,"indexChanged":null,"complete":true,"comparison":"raw_bytes_no_filters","reason":null}', observed_at: E_TIME, mutation_id: `ws-${revision}`, input_digest: E_DIGEST, updated_at: E_TIME });
    ok(checkP0ConfigurationFamily(request(input))); eSet(input, "projects", 0, "workspace_revision", 3); failure(input, "PC1B-WS01");
    eSet(input, "projects", 0, "workspace_revision", 2); eSet(input, "project_workspace_versions", 0, "project_revision", 6); failure(input, "PC1B-WS01");
  });
  test(`MCP historical exact projection, receipt and snapshot remain local values (${backend})`, () => {
    const input = eCore(backend), declaration = { connectionId: "connection", revision: 7, enabled: true,
      transport: { type: "streamable-http", endpoint: "http://127.0.0.1:1/never-contacted" } };
    const projection = inspectMcpConnection(declaration), snapshot = createToolCatalogSnapshot({ connection: declaration, observedAt: E_TIME,
      discovery: { status: "available", tools: [{ name: "tool", inputSchema: { type: "object", properties: {} } }] } });
    eAdd(input, "mcp_connections", { id: "connection", revision: 7, discovery_sequence: 9, created_at: E_TIME, updated_at: E_TIME });
    eAdd(input, "mcp_connection_versions", { connection_id: "connection", revision: 7, name: "Name", configuration_json: mcpCanonical(declaration), configuration_digest: projection.configurationDigest, created_at: E_TIME });
    eAdd(input, "mcp_catalog_snapshots", { id: snapshot.snapshotDigest, connection_id: "connection", connection_revision: 7, snapshot_json: mcpCanonical(snapshot), observed_at: E_TIME });
    eAdd(input, "mcp_catalog_heads", { connection_id: "connection", connection_revision: 7, snapshot_id: snapshot.snapshotDigest });
    eAdd(input, "mcp_connection_mutations", { request_id: "mutation", input_digest: E_DIGEST, connection_id: "connection",
      result_json: mcpCanonical({ ...projection, name: "Name", createdAt: E_TIME, updatedAt: E_TIME }), created_at: E_TIME });
    eAdd(input, "mcp_discovery_attempts", { id: "attempt", request_id: "request", input_digest: E_DIGEST, connection_id: "connection", connection_revision: 7,
      sequence: 9, owner_id: "owner", status: "connection_failed", error_code: "connection_failed", snapshot_id: null, cleanup: "not_opened", protocol_version: null, page_count: null, created_at: E_TIME, finished_at: E_TIME });
    ok(checkP0ConfigurationFamily(request(input))); // A failed latest attempt does not invalidate an earlier catalogue.
    eSet(input, "mcp_catalog_snapshots", 0, "observed_at", "2026-11-18T00:00:00.000Z"); failure(input, "PC1B-MCP02");
    eSet(input, "mcp_catalog_snapshots", 0, "observed_at", E_TIME);
    eSet(input, "mcp_catalog_heads", 0, "connection_revision", 8); failure(input, "PC1B-MCP02");
    eSet(input, "mcp_catalog_heads", 0, "connection_revision", 7);
    eSet(input, "mcp_discovery_attempts", 0, "status", "succeeded");
    eSet(input, "mcp_discovery_attempts", 0, "error_code", null); failure(input, "PC1B-MCP02");
    eSet(input, "mcp_discovery_attempts", 0, "snapshot_id", snapshot.snapshotDigest); ok(checkP0ConfigurationFamily(request(input)));
    eSet(input, "mcp_discovery_attempts", 0, "status", "connection_failed"); failure(input, "PC1B-MCP02");
    eSet(input, "mcp_discovery_attempts", 0, "snapshot_id", null);
    eSet(input, "mcp_connection_mutations", 0, "result_json", mcpCanonical({ ...projection, name: "Changed", createdAt: E_TIME, updatedAt: E_TIME }));
    failure(input, "PC1B-MCP03");
    eSet(input, "mcp_connection_mutations", 0, "result_json", null); failure(input, "PC1B-MCP03", "semantic_unsupported");
    eSet(input, "mcp_connection_versions", 0, "configuration_json", mcpCanonical({ ...declaration, connectionId: "other" }));
    failure(input, "PC1B-MCP01");
  });
}

test("POL01 reserves effective rules and source metadata before actual composition", () => {
  const input = eCore();
  ePolicy(input, { schemaVersion: 1, scope: "user", revision: 1, rules: [] }); ePolicyHead(input, "user", 1);
  ePolicy(input, { schemaVersion: 1, scope: "project", projectId: "p", revision: 1, rules: Array.from({ length: 200 }, (_, index) => ({
    ruleId: `rule-${String(index).padStart(3, "0")}`, when: {}, outcome: "auto", reason: "legal", requiresFreshHuman: false })), overrides: [] }, 1);
  ePolicyHead(input, "project", 1);
  for (const retained of [false, true]) {
    const req = request(input);
    for (const row of req.original.rows("policy_document_versions")) ok(withP0Guard(req, () => readP0Json(req, row, "document_json", "reference", p0RowSite(req, req.original, row, "document_json"))));
    if (retained) ok(checkP0ConfigurationFamily(req));
    const view = retained ? retainP0Rows(req, input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0]))) : req.original;
    chargeP0(req, { nodes: 250000 - p0Usage(req).nodes - 8931 });
    const native = policyDocumentsSchema.safeParse; let projectComposeCalls = 0;
    let result: ReturnType<typeof checkP0ConfigurationFamily>;
    try {
      policyDocumentsSchema.safeParse = function (...args) {
        if (args[0] !== null && typeof args[0] === "object" && Object.hasOwn(args[0], "project")) projectComposeCalls++;
        return Reflect.apply(native, this, args);
      };
      result = checkP0ConfigurationFamily(req, view);
    } finally { policyDocumentsSchema.safeParse = native; }
    assert.equal(projectComposeCalls, 0); assert.equal(result.ok, false); if (result.ok) assert.fail();
    assert.equal(result.error.code, "resource_limit"); assert.deepEqual(checkP0ConfigurationFamily(req, view), result);
  }
});
test("E keeps generic historical observations after binding deletion and never normalizes their raw JSON", () => {
  const input = eCore();
  const payload = '{ "historical":true, "bindingId":"deleted", "values":[0.5] }';
  eAdd(input, "agent_runtime_events", { id: "event", binding_id: "deleted", observed_at: E_TIME, event_name: "old.kind", payload });
  const req = request(input); ok(checkP0ConfigurationFamily(req));
  assert.equal(ok(withP0Guard(req, () => readP0Text(req, req.original.rows("agent_runtime_events")[0]!, "payload"))), payload);
});
test("E authenticates request/view before any hostile property access", () => {
  let traps = 0; const proxy = new Proxy({}, { get() { traps++; throw new Error("secret"); }, ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return null; } });
  const req = request(eCore()), other = request(eCore());
  for (const [r, view] of [[proxy, undefined], [req, proxy], [req, other.original]] as const) {
    const result = checkP0ConfigurationFamily(r as P0Request, view as P0View | undefined); assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  assert.equal(traps, 0);
});

for (const backend of ["sqlite", "postgres"] as const) {
  test(`RT01 preserves old snapshots and invalidated advanced choice (${backend})`, () => {
    const input = eCore(backend); eRuntime(input);
    eSet(input, "members", 0, "status", "removed"); // Identity is not current membership authorization.
    const req = request(input), result = ok(checkP0ConfigurationFamily(req));
    assert.deepEqual(result.runtimeUsability[1], { table: "agent_runtime_bindings", rowOrdinal: 0, usable: true, selected: "requestedSnapshot", advanced: "invalidated_by_revision" });
    assert.equal(ok(withP0Guard(req, () => readP0Text(req, req.original.rows("agent_runner_states")[0]!, "session_key"))), "claude-code:old-SID");
    eSet(input, "agent_runtime_bindings", 0, "requested_snapshot_json", null);
    assert.equal(ok(checkP0ConfigurationFamily(request(input))).runtimeUsability[1]!.selected, "applied");
    eSet(input, "agent_runner_states", 0, "applied_json", null);
    assert.equal(ok(checkP0ConfigurationFamily(request(input))).runtimeUsability[1]!.selected, "effective");
  });
  test(`RT01 invalid nonselected JSON remains raw and never falls back (${backend})`, () => {
    for (const raw of ["{ malformed", "null", '{"backend":"claude-code"}']) {
      const input = eCore(backend); eRuntime(input); eSet(input, "agent_runtime_bindings", 0, "requested_snapshot_json", raw);
      const req = request(input), result = ok(checkP0ConfigurationFamily(req));
      assert.equal(result.runtimeUsability[1]!.usable, false); assert.equal(result.runtimeUsability[1]!.selected, null);
      assert.equal(ok(withP0Guard(req, () => readP0Text(req, req.original.rows("agent_runtime_bindings")[0]!, "requested_snapshot_json"))), raw);
    }
    const processNull = eCore(backend); eRuntime(processNull); eSet(processNull, "agent_runner_states", 0, "process_identity_json", "null");
    assert.equal(ok(checkP0ConfigurationFamily(request(processNull))).runtimeUsability[1]!.usable, false, "JSON null is not nullable SQL NULL in the old inspector");
  });
  test(`RT01 scope, ownership and exact process grammar reject independently (${backend})`, () => {
    const badScope = eCore(backend); eRuntime(badScope); eSet(badScope, "members", 0, "agent_id", "other"); failure(badScope, "PC1B-RT01");
    const input = eCore(backend); eRuntime(input);
    for (const table of ["agent_runtime_members", "agent_runner_states"] as const) {
      eSet(input, table, 0, "lease_owner", "owner"); eSet(input, table, 0, "lease_expires_at", "2000-01-01T00:00:00.000Z");
    }
    eSet(input, "agent_runtime_members", 0, "binding_id", "b"); ok(checkP0ConfigurationFamily(request(input)));
    eSet(input, "agent_runner_states", 0, "generation", 5); failure(input, "PC1B-RT01");
    eSet(input, "agent_runner_states", 0, "generation", 4); eSet(input, "agent_runner_states", 0, "process_identity_json", '{"version":1}');
    failure(input, "PC1B-RT01", "semantic_unsupported");
  });
  test(`RT01 retained strong identity targets preserve original row locations (${backend})`, () => {
    const input = eCore(backend); eRuntime(input); const req = request(input); ok(checkP0ConfigurationFamily(req));
    const keep = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0])).filter(r => r.table !== "agents");
    const result = checkP0ConfigurationFamily(req, retainP0Rows(req, keep)); assert.equal(result.ok, false);
    if (result.ok) assert.fail(); assert.equal(result.error.code, "retained_reference_conflict"); assert.equal(result.error.rule, "PC1B-RT01");
    assert.equal(result.error.location?.table, "agent_runtimes"); assert.equal(result.error.location?.rowOrdinal, 0);
  });
}

function copyRows(input: EInput, table: string, rows: readonly Record<string, unknown>[]): void {
  for (const row of rows) {
    const values: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(row)) { assert.ok(value === null || typeof value === "string" || typeof value === "number"); values[key] = value; }
    eAdd(input, table, values);
  }
}
test("RT01 agrees with the actual SQLite inspector and selector, including a broken sibling", async () => {
  const f = await identityFixture("sqlite");
  try {
    const p = await f.repos.projects.create({ name: "P0 runtime differential" });
    const groups = await Promise.all(["old", "sibling"].map(name => f.repos.groups.create({ projectId: p.id, name })));
    const repo = createRuntimeRepository(f.db, { repos: f.repos });
    const created = await repo.create({ name: "Historical runtime", backend: "claude-code", defaults: { workdir: f.dir }, bindings: groups.map(g => ({ projectId: p.id, groupId: g.id })) });
    const first = created.bindings[0]!.binding.id, second = created.bindings[1]!.binding.id;
    await repo.updateBinding(first, { runtimeRevision: 1, bindingRevision: 1, overrides: {}, advancedStrategy: "bypassPermissions" });
    await repo.intent(first, "start"); const fence = await repo.claim(first, "native-fixture-owner"); await repo.markExit(fence, { exitCode: 0 });
    await repo.updateDefaults(created.runtime.id, 1, { workdir: f.dir, model: "next" }); await repo.intent(first, "apply");
    await repo.updateDefaults(created.runtime.id, 2, { workdir: f.dir, model: "latest" });
    await f.db.exec("UPDATE agent_runtime_bindings SET requested_snapshot_json = ? WHERE id = ?", ["{ broken requested", second]);
    const inspector = createLegacyConfigInspector({ db: f.db, repos: f.repos, now: () => new Date(E_TIME) });
    const old = await inspector.preflight(), capture = await f.db.readSnapshot(readLegacyConfigCapture);
    const input = p0Fixture("sqlite"); for (const [table, rows] of Object.entries(capture.rows)) copyRows(input, table, rows);
    const observed = ok(checkP0ConfigurationFamily(request(input)));
    for (let ordinal = 0; ordinal < capture.rows.agent_runtime_bindings.length; ordinal++) {
      const row = capture.rows.agent_runtime_bindings[ordinal]!, prior = old.bindings.find(b => b.bindingId === row.id)!;
      const result = observed.runtimeUsability.find(x => x.table === "agent_runtime_bindings" && x.rowOrdinal === ordinal)!;
      assert.equal(result.usable, prior.configurationValid); assert.equal(result.selected, selectLegacyConfigSnapshot(prior).configSnapshotRef?.kind ?? null);
      if (prior.advanced) assert.equal(result.advanced, prior.advanced.validity);
    }
    assert.deepEqual(await f.db.readSnapshot(readLegacyConfigCapture), capture, "P0 did not change the actual captured source");
  } finally { await f.close(); }
});

test("RT02 accepts all actual event producers and stored usage without live binding or recomputed sums", async () => {
  const f = await identityFixture("sqlite");
  try {
    const logger = createLogger({ write() {} }), now = () => Date.parse(E_TIME), bindingId = newId();
    const obs = createRuntimeObservability({ db: f.db, logger, now });
    for (const event of RUNTIME_EVENT_NAMES) assert.equal((await obs.record({ event, bindingId, signal: "SIGALRM", runnerGeneration: 7 })).stored, true);
    const usage = { bindingId, source: "codex-cli" as const, harnessVersion: "0.167.0-alpha.4", metric: "inputTokens" as const,
      scope: "session" as const, scopeId: newId(), epochId: newId(), sequence: 1, runnerGeneration: 7, reportedAt: E_TIME,
      coverage: "complete" as const, value: 20, cumulative: true, schemaVerified: true, zeroMeaningful: true, successful: true };
    assert.equal((await obs.observeUsage(usage)).stored, true);
    assert.equal((await obs.observeUsage({ ...usage, sequence: 2, value: 25 })).stored, true);
    const input = eCore();
    for (const table of ["agent_runtime_events", "agent_runtime_usage_snapshots", "agent_runtime_observation_meta"]) copyRows(input, table, await f.db.query(`SELECT * FROM ${table} ORDER BY 1`));
    const req = request(input); ok(checkP0ConfigurationFamily(req));
    const all = req.input.graph.observation.tables.flatMap(t => req.original.rows(t.name as Parameters<P0View["rows"]>[0]));
    ok(checkP0ConfigurationFamily(req, retainP0Rows(req, all.filter(r => r.table !== "agent_runtime_events"))));
    const table = input.graph.observation.tables.find(t => t.name === "agent_runtime_usage_snapshots")!;
    const payload = JSON.parse(ok(withP0Guard(req, () => readP0Text(req, req.original.rows("agent_runtime_usage_snapshots")[0]!, "payload")))!);
    delete payload.runnerGeneration; eSet(input, table.name, 0, "payload", JSON.stringify(payload));
    ok(checkP0ConfigurationFamily(request(input))); // Explicit old no-generation baseline branch.
    payload.sequence = 3; eSet(input, table.name, 0, "payload", JSON.stringify(payload)); failure(input, "PC1B-RT02");
    payload.sequence = 2; payload.value = 1.5; eSet(input, table.name, 0, "payload", JSON.stringify(payload)); failure(input, "PC1B-RT02", "semantic_unsupported");
  } finally { await f.close(); }
});

test("trusted legacy error identities do not inspect unknown exceptions", () => {
  let traps = 0; const value = new Proxy({}, { get() { traps++; throw 0; }, getPrototypeOf() { traps++; throw 0; }, ownKeys() { traps++; throw 0; } });
  assert.equal(policyInputErrorCode(value), undefined); assert.equal(capabilityInputErrorCode(value), undefined); assert.equal(traps, 0);
  const policy = new PolicyInputError("policy_input_invalid", ["fixed"]), mcp = new CapabilityInputError("invalid_snapshot");
  assert.equal(policyInputErrorCode(policy), "policy_input_invalid"); assert.equal(capabilityInputErrorCode(mcp), "invalid_snapshot");
  assert.equal(policy.name, "PolicyInputError"); assert.equal(mcp.message, "invalid_snapshot");
});

test("MCP URL validation propagates an unknown constructor failure without laundering it", () => {
  const input = eCore(), endpoint = "http://127.0.0.1:1/never-contacted";
  const declaration = { connectionId: "fault-boundary", revision: 1, enabled: true,
    transport: { type: "streamable-http", endpoint } };
  const projection = inspectMcpConnection(declaration);
  eAdd(input, "mcp_connections", { id: declaration.connectionId, revision: 1, discovery_sequence: 0, created_at: E_TIME, updated_at: E_TIME });
  eAdd(input, "mcp_connection_versions", { connection_id: declaration.connectionId, revision: 1, name: "Boundary",
    configuration_json: mcpCanonical(declaration), configuration_digest: projection.configurationDigest, created_at: E_TIME });
  const req = request(input); ok(checkP0ConfigurationFamily(req));
  let traps = 0, hits = 0;
  const unknown = new Proxy({}, { get() { traps++; throw 0; }, getPrototypeOf() { traps++; throw 0; }, ownKeys() { traps++; throw 0; } });
  const NativeURL = globalThis.URL;
  globalThis.URL = class extends NativeURL {
    constructor(value: string | URL, base?: string | URL) {
      if (value === endpoint) { hits++; throw unknown; }
      super(value, base);
    }
  };
  try {
    const result = checkP0ConfigurationFamily(req); assert.equal(result.ok, false);
    if (result.ok) assert.fail();
    assert.equal(result.error.code, "invalid_value"); assert.equal(result.error.rule, null); assert.equal(result.error.location, null);
    assert.equal(hits, 1); assert.equal(traps, 0);
    assert.throws(() => inspectMcpConnection(declaration), error => capabilityInputErrorCode(error) === "invalid_connection",
      "default native reader retains its old catch behavior");
  } finally { globalThis.URL = NativeURL; }
  assert.equal(hits, 2); assert.equal(traps, 0);
});

test("E uses the original global ledger and cannot restart after budget exhaustion", () => {
  const input = eCore(); eRuntime(input); const req = request(input), before = p0Usage(req);
  ok(withP0Guard(req, () => chargeP0(req, { bytes: 67_108_864 - before.bytes - 128 })));
  const result = checkP0ConfigurationFamily(req); assert.equal(result.ok, false); if (result.ok) assert.fail(); assert.equal(result.error.code, "resource_limit");
  const again = checkP0ConfigurationFamily(req); assert.equal(again.ok, false); if (again.ok) assert.fail(); assert.equal(again.error.code, "resource_limit");
});

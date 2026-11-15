import test from "node:test";
import assert from "node:assert/strict";
import { createMcpCatalogApi, McpRequestError } from "../src/web/src/api/mcp-connections.ts";
import type { McpConnectionView, McpDiscoveryAttempt, McpSaveInput } from "../src/web/src/api/mcp-connections.ts";
import { createMcpCatalogState } from "../src/web/src/composables/useMcpCatalogState.ts";

const digest = "a".repeat(64), at = "2026-11-14T00:00:00.000Z";
const receipt = (id = "c1", revision = 1) => ({ connectionId: id, revision, name: id, enabled: true,
  transport: "streamable-http" as const, credentialConfigured: false, configurationDigest: digest, createdAt: at, updatedAt: at });
const view = (id = "c1", revision = 1) => ({ connection: receipt(id, revision), state: "registered" as const,
  modelState: "not_provided" as const, currentSnapshot: null, lastDiscovery: null });
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const attempt = (attemptId = "a1", status: McpDiscoveryAttempt["status"] = "running", sequence = 1): McpDiscoveryAttempt => ({
  attemptId, connectionId: "c1", connectionRevision: 1, sequence, status, errorCode: null, snapshotId: null,
  cleanup: "remote_unknown", protocolVersion: null, pages: null, createdAt: at, finishedAt: status === "running" || status === "cancel_requested" ? null : at,
});

test("MCP-A05: malformed successful receipt remains unknown; no secrets or raw error enter UI errors", async () => {
  const api = createMcpCatalogApi(async () => json({ connection: { ...receipt(), endpoint: "secret-canary" } }));
  await assert.rejects(api.save(null, { requestId: "r1", name: "c1", enabled: true,
    transport: { type: "streamable-http", endpoint: "http://localhost/mcp" } }), (e: unknown) => {
    assert.ok(e instanceof McpRequestError); assert.equal(e.uncertain, true); assert.doesNotMatch(e.message, /secret-canary/); return true;
  });
});

test("MCP-A07: logical GET deadline rejects even if transport ignores abort; all reads use no-store", async () => {
  let init: RequestInit | undefined;
  const api = createMcpCatalogApi(async (_url, options) => { init = options; return new Promise<Response>(() => {}); }, 8);
  await assert.rejects(api.list(), /读取超时/); assert.equal(init?.cache, "no-store");
});

test("MCP-A05: unknown save freezes original identity/input and only explicit replay recovers it", async () => {
  const writes: string[] = []; let saved = false;
  const api = createMcpCatalogApi(async (_url, init) => {
    if (init?.method === "POST") { writes.push(String(init.body)); if (writes.length === 1) return json({}, 503);
      saved = true; return json({ connection: receipt() }, 201); }
    return json({ connections: saved ? [view()] : [] });
  });
  const state = createMcpCatalogState({ api, requestId: () => "save-1" });
  await state.refresh(); state.openCreate();
  state.editor.value!.name = "c1"; state.editor.value!.endpoint = "http://localhost/mcp";
  await state.saveEditor(); assert.equal(state.saveOperation.value?.state, "unknown");
  assert.equal(state.closeEditor(), false); await state.refresh(); assert.equal(writes.length, 1);
  state.editor.value!.name = "attempted-new-input";
  await state.recoverSave(); assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
  assert.equal(state.editor.value, null); assert.equal(state.connections.value[0]?.connection.name, "c1"); state.dispose();
});

test("MCP-A05/07: stale selected-scope response cannot restore old data; reads coalesce and never discover", async () => {
  const late = deferred<Response>(); let reads = 0; const methods: string[] = [];
  const api = createMcpCatalogApi(async (_url, init) => {
    methods.push(init?.method ?? "GET"); reads++;
    if (reads === 2) return late.promise;
    return json({ connections: [view("c1", reads > 2 ? 2 : 1), view("c2", reads > 2 ? 3 : 1)] });
  });
  const state = createMcpCatalogState({ api }); await state.refresh();
  const pending = state.refresh(); const duplicate = state.refresh(); state.select("c2");
  late.resolve(json({ connections: [view("c1"), view("c2")] })); await Promise.all([pending, duplicate]);
  await state.refresh(); assert.equal(state.selectedId.value, "c2"); assert.equal(state.selected.value?.connection.revision, 3);
  assert.ok(methods.every(m => m === "GET")); state.dispose();
});

test("MCP-A07: read failure preserves last successful facts, 403 revokes caches and configuration", async () => {
  let status = 200;
  const api = createMcpCatalogApi(async () => status === 200 ? json({ connections: [view()] }) : json({ error: { code: "forbidden", message: "private-error-canary" } }, status));
  const state = createMcpCatalogState({ api }); await state.refresh(); const lastRead = state.lastRead.value;
  status = 503; await state.refresh(); assert.equal(state.connections.value.length, 1); assert.equal(state.lastRead.value, lastRead);
  status = 403; await state.refresh(); assert.equal(state.connections.value.length, 0); assert.equal(state.forbidden.value, true);
  assert.equal(state.editor.value, null); assert.doesNotMatch(state.readError.value ?? "", /private-error-canary/); state.dispose();
});

test("MCP-A05: same-key conflict preserves the unresolved save and cannot allocate a replacement identity", async () => {
  const writes: string[] = []; let keys = 0;
  const api = createMcpCatalogApi(async (_url, init) => {
    if (init?.method === "POST") { writes.push(String(init.body)); return writes.length === 1 ? json({}, 503) : json({ error: { code: "mcp_request_conflict" } }, 409); }
    return json({ connections: [] });
  });
  const state = createMcpCatalogState({ api, requestId: () => `r${++keys}` }); state.openCreate();
  state.editor.value!.name = "c1"; state.editor.value!.endpoint = "http://localhost/mcp";
  await state.saveEditor(); await state.recoverSave();
  assert.equal(state.saveOperation.value?.state, "unknown"); assert.equal(state.closeEditor(), false);
  await state.saveEditor(); assert.equal(keys, 1); assert.equal(writes[0], writes[1]); state.dispose();
});

test("MCP-A05/A06: unknown discovery cannot adopt a foreign latest or create a new key; exact same-key recovery unlocks independent discovery", async () => {
  let latest = attempt("foreign", "running", 7), keys = 0; const writes: { url: string; body: string }[] = [];
  const api = createMcpCatalogApi(async (url, init) => {
    const u = String(url);
    if (init?.method === "POST") { writes.push({ url: u, body: String(init.body) });
      if (writes.length === 1) return json({}, 503);
      latest = attempt(writes.length === 2 ? "owned" : "independent", "running", writes.length + 7);
      return json({ attempt: latest }); }
    if (u.includes("/discoveries/")) return json({ attempt: attempt(u.split("/").at(-1), "running", u.endsWith("owned") ? 9 : 10) });
    const current: McpConnectionView = { ...view(), lastDiscovery: latest };
    return u === "/api/mcp/connections" ? json({ connections: [current] }) : json(current);
  });
  const state = createMcpCatalogState({ api, requestId: () => `d${++keys}` }); await state.refresh();
  await state.discover(true); assert.equal(state.discoveries.value.c1?.state, "unknown");
  await state.refresh(); assert.equal(Object.keys(state.ownedAttempts.value).length, 0);
  await state.cancelAttempt(latest); await state.discover(true); assert.equal(keys, 1); assert.equal(writes.length, 1);
  await state.recoverDiscovery(); assert.equal(writes[0]?.body, writes[1]?.body); assert.equal(state.discoveries.value.c1?.attempt?.attemptId, "owned");
  await state.discover(true); assert.equal(keys, 2); assert.equal(state.ownedAttempts.value.c1?.length, 2);
  assert.equal(state.ownedAttempts.value.c1?.find(a => a.attemptId === "owned")?.cleanup, "remote_unknown"); state.dispose();
});

test("MCP-A02: revision conflict preserves draft and explicitly adopts a fresh CAS baseline", async () => {
  let head = 1; const writes: McpSaveInput[] = [];
  const api = createMcpCatalogApi(async (url, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return json({ error: { code: "mcp_connection_revision_conflict" } }, 409); }
    if (String(url).endsWith("/configuration")) return json({ configuration: { connectionId: "c1", revision: head, enabled: true, transport: { type: "streamable-http", endpoint: `http://localhost/v${head}` } } });
    return String(url) === "/api/mcp/connections" ? json({ connections: [view("c1", head)] }) : json(view("c1", head));
  });
  const state = createMcpCatalogState({ api, requestId: () => "edit-1" }); await state.refresh(); await state.openEditor();
  state.editor.value!.name = "preserved draft"; head = 2; await state.saveEditor();
  assert.equal(state.editor.value?.name, "preserved draft"); assert.equal(state.editor.value?.baseRevision, 1); assert.equal(state.selected.value?.connection.revision, 2);
  await state.adoptRevision(); assert.equal(state.editor.value?.baseRevision, 2); assert.equal(state.editor.value?.name, "preserved draft");
  assert.equal(state.editor.value?.endpoint, "http://localhost/v1"); assert.equal(writes[0]?.expectedRevision, 1); state.dispose();
});

test("MCP-A07: one reconciliation deadline bounds list plus exact-attempt reads", async () => {
  let slow = false, reconciliationAborted = false;
  const transport = createMcpCatalogApi(async url => String(url).includes("/discoveries/") && slow ? new Promise<Response>(() => {})
    : json({ connections: [view()] }), 200);
  const api = { ...transport, attempt: (id: string, aid: string, signal?: AbortSignal) => {
    signal?.addEventListener("abort", () => { reconciliationAborted = true; }); return transport.attempt(id, aid, signal);
  } };
  const state = createMcpCatalogState({ api, readTimeoutMs: 10 }); await state.refresh();
  state.ownedAttempts.value.c1 = [attempt()]; slow = true; await state.refresh();
  assert.equal(reconciliationAborted, true, "the enclosing reconciliation deadline must stop the attempt read");
  assert.match(state.readError.value ?? "", /读取超时/); assert.equal(state.reading.value, false); state.dispose();
});

test("MCP-A07: changing selection clears the old history pending state and rejects its late response", async () => {
  const late = deferred<Response>();
  const api = createMcpCatalogApi(async url => String(url).includes("/catalogs/") ? late.promise : json({ connections: [view(), view("c2")] }));
  const state = createMcpCatalogState({ api }); await state.refresh(); const load = state.loadHistory(digest);
  assert.equal(state.historyLoading.value, true); state.select("c2");
  assert.equal(state.historyLoading.value, false); late.resolve(json({ invalid: true })); await load;
  assert.equal(state.historical.value, null); assert.equal(state.historyError.value, null); state.dispose();
});

test("MCP-A05: an unpersisted terminal discovery receipt stays unknown with its original request", async () => {
  const writes: string[] = [];
  const api = createMcpCatalogApi(async (_url, init) => {
    if (init?.method === "POST") { writes.push(String(init.body)); return json({ error: { code: "mcp_discovery_result_not_persisted" } }, 409); }
    return String(_url) === "/api/mcp/connections" ? json({ connections: [view()] }) : json(view());
  });
  const state = createMcpCatalogState({ api, requestId: () => "unpersisted-1" }); await state.refresh(); await state.discover();
  assert.equal(state.discoveries.value.c1?.state, "unknown"); await state.discover(true); assert.equal(writes.length, 1);
  await state.recoverDiscovery(); assert.equal(writes[0], writes[1]); state.dispose();
});

test("MCP-A07: visible fallback runs every 15 seconds, pauses while hidden and resumes with GET only", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] }); const methods: string[] = [];
  const api = createMcpCatalogApi(async (_url, init) => { methods.push(init?.method ?? "GET"); return json({ connections: [view()] }); });
  const state = createMcpCatalogState({ api }); state.start(); await new Promise(resolve => setImmediate(resolve));
  const initial = methods.length; t.mock.timers.tick(14_999); await new Promise(resolve => setImmediate(resolve)); assert.equal(methods.length, initial);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(methods.length, initial + 1);
  state.setVisible(false); t.mock.timers.tick(45_000); await new Promise(resolve => setImmediate(resolve)); assert.equal(methods.length, initial + 1);
  state.setVisible(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(methods.length, initial + 2);
  assert.ok(methods.every(m => m === "GET")); state.dispose();
});

test("MCP-A05/A06: a delayed running observation cannot erase an already known cancel request", async () => {
  let current = attempt("owned", "cancel_requested");
  const api = createMcpCatalogApi(async url => String(url).includes("/discoveries/")
    ? json({ attempt: current }) : json({ connections: [{ ...view(), lastDiscovery: current }] }));
  const state = createMcpCatalogState({ api }); await state.refresh();
  state.ownedAttempts.value.c1 = [current];
  current = attempt("owned", "running"); await state.refresh();
  assert.equal(state.ownedAttempts.value.c1?.[0]?.status, "cancel_requested");
  assert.equal(state.selected.value?.lastDiscovery?.status, "cancel_requested");
  state.dispose();
});

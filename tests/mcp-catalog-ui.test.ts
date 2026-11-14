import test from "node:test";
import assert from "node:assert/strict";
import { byTestId, find, input, json, settle, textOf, withPage } from "./helpers/web-ui.ts";

test("T11-A01: global MCP empty state follows a successful read, and failures do not masquerade as empty", async () => {
  let failure = false;
  await withPage("McpCatalogView", url => url.startsWith("/api/projects") ? json({ projects: [] })
    : failure ? json({ error: { code: "unavailable" } }, 503) : json({ connections: [] }), async root => {
    assert.match(textOf(root), /MCP/);
    assert.ok(byTestId(root, "mcp-empty"));
    failure = true; byTestId(root, "mcp-refresh").props.onClick(); await settle();
    assert.ok(byTestId(root, "mcp-read-error"));
    assert.equal(find(root, e => e.props["data-testid"] === "mcp-empty"), undefined);
  }, { path: "/settings" });
});

test("T11-A02/A05: a create form preserves uncertain input and requires explicit same-key recovery", async () => {
  const writes: string[] = [];
  await withPage("McpCatalogView", (url, init) => {
    if (url.startsWith("/api/projects")) return json({ projects: [] });
    if (init?.method === "POST") { writes.push(String(init.body)); return json({}, 503); }
    return json({ connections: [] });
  }, async root => {
    byTestId(root, "mcp-create").props.onClick(); await settle();
    await input(byTestId(root, "mcp-name"), "研发目录");
    await input(byTestId(root, "mcp-endpoint"), "http://localhost:5999/mcp");
    await byTestId(root, "mcp-save").props.onClick(); await settle();
    assert.equal(writes.length, 1);
    assert.match(textOf(byTestId(root, "mcp-save-unknown")), /结果待核实/);
    assert.equal(byTestId(root, "mcp-name").props.disabled, true);
    byTestId(root, "mcp-refresh").props.onClick(); await settle();
    assert.equal(writes.length, 1);
    await byTestId(root, "mcp-recover-save").props.onClick(); await settle();
    assert.equal(writes.length, 2); assert.equal(writes[0], writes[1]);
  }, { path: "/settings" });
});

const observedAt = "2026-11-14T00:00:00.000Z", hash = "a".repeat(64);
const publicConnection = { connectionId: "c1", revision: 1, enabled: true, transport: "streamable-http",
  configurationDigest: hash, credentialConfigured: false };
function catalogView(snapshotDigest = "b".repeat(64)) {
  return { connection: { ...publicConnection, name: "目录来源", createdAt: observedAt, updatedAt: observedAt },
    state: "discovered", modelState: "not_provided", lastDiscovery: null,
    currentSnapshot: { kind: "tool-catalog-snapshot", formatVersion: 1, connection: publicConnection,
      observedAt, discoveryStatus: "available", snapshotDigest, tools: [{
        ref: { connectionId: "c1", connectionRevision: 1, name: "stable_tool", schemaDigest: hash },
        toolKey: "tool_" + hash, title: "稳定工具", inputSchema: { type: "object" },
      }] } };
}

test("T11-A08: background catalog observations retain the filter and exact tool selection", async () => {
  let current = catalogView();
  await withPage("McpCatalogView", url => url.startsWith("/api/projects") ? json({ projects: [] })
    : json({ connections: [current] }), async root => {
    await input(byTestId(root, "mcp-tool-filter"), "stable");
    byTestId(root, "mcp-tool-0").props.onClick(); await settle();
    assert.ok(byTestId(root, "mcp-tool-details"));
    current = catalogView("c".repeat(64));
    await byTestId(root, "mcp-refresh").props.onClick(); await settle();
    assert.equal(byTestId(root, "mcp-tool-filter").value, "stable");
    assert.ok(byTestId(root, "mcp-tool-details"));
    assert.equal(byTestId(root, "mcp-tool-0").props["aria-pressed"], true);
  }, { path: "/settings" });
});

test("T11-A03: discovery records expose actual protocol, pagination and observation times", async () => {
  const current = { ...catalogView(), lastDiscovery: { attemptId: "foreign", connectionId: "c1", connectionRevision: 1,
    sequence: 1, status: "succeeded", errorCode: null, snapshotId: "b".repeat(64), cleanup: "closed",
    protocolVersion: "2025-11-25", pages: 2, createdAt: observedAt, finishedAt: observedAt } };
  await withPage("McpCatalogView", url => url.startsWith("/api/projects") ? json({ projects: [] })
    : json({ connections: [current] }), async root => {
    const record = textOf(byTestId(root, "mcp-latest-attempt"));
    assert.match(record, /协议 2025-11-25/); assert.match(record, /2 页/); assert.match(record, /开始/); assert.match(record, /结束/);
  }, { path: "/settings" });
});

test("T11-A06: independently starting discovery keeps a known foreign record without gaining cancellation ownership", async () => {
  const old = { attemptId: "foreign-old", connectionId: "c1", connectionRevision: 1, sequence: 1,
    status: "running", errorCode: null, snapshotId: null, cleanup: "remote_unknown", protocolVersion: null,
    pages: null, createdAt: observedAt, finishedAt: null };
  const completed = { ...old, attemptId: "owned-new", sequence: 2, status: "succeeded", snapshotId: "b".repeat(64),
    cleanup: "closed", protocolVersion: "2025-11-25", pages: 2, finishedAt: observedAt };
  let latest: typeof old | typeof completed = old; const writes: string[] = [];
  await withPage("McpCatalogView", (url, init) => {
    if (url.startsWith("/api/projects")) return json({ projects: [] });
    if (init?.method === "POST") { writes.push(url); latest = completed; return json({ attempt: completed }); }
    if (url.includes("/discoveries/")) return json({ attempt: old });
    const current = { ...catalogView(), lastDiscovery: latest };
    return url === "/api/mcp/connections" ? json({ connections: [current] }) : json(current);
  }, async root => {
    byTestId(root, "mcp-new-attempt").props.onClick(); await settle();
    byTestId(root, "confirm-submit").props.onClick(); await settle();
    const retained = byTestId(root, "mcp-known-attempt");
    assert.match(textOf(retained), /foreign-old/); assert.match(textOf(retained), /发现进行中/);
    assert.match(textOf(retained), /远端清理结果未知/);
    assert.equal(find(retained, e => e.props["data-testid"] === "mcp-cancel-attempt"), undefined);
    assert.match(textOf(byTestId(root, "mcp-owned-attempt")), /owned-new/);
    assert.deepEqual(writes, ["/api/mcp/connections/c1/discover"]);
  }, { path: "/settings" });
});

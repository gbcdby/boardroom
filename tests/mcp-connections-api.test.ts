import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createT1ApiRouter } from "../src/server/api.ts";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";
import { onMcpConnectionChange, type McpConnectionView, type McpDiscoveryAttempt } from "../src/server/mcp/connections/service.ts";
import { identityFixture } from "./helpers/identity-fixture.ts";
import { discoveryTestServer, discoveryTool } from "./helpers/mcp-discovery-server.ts";

const logger = createLogger({ level: "error", write() {} });
async function readAttempt(response: Response | Promise<Response>): Promise<McpDiscoveryAttempt> {
  return ((await (await response).json()) as { attempt: McpDiscoveryAttempt }).attempt;
}
async function fixture() {
  const f = await identityFixture();
  const router = createT1ApiRouter({ db: f.db, logger, resolveActor: async ({ request }) =>
    request.headers["x-test-actor"] === "agent" ? { ...ownerActor(), kind: "agent" }
      : request.headers["x-test-actor"] === "project-human" ? ownerActor("bound-project") : ownerActor() });
  const server = createServer((req, res) => { void router.handle(req, res, new URL(req.url!, "http://localhost").pathname)
    .then(matched => { if (!matched) { res.writeHead(404); res.end(); } })
    .catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  return { ...f, router, origin, async request(url: string, method = "GET", value?: unknown, headers: Record<string, string> = {}) {
    return fetch(`${origin}${url}`, { method, headers: { ...headers, ...(value === undefined ? {} : { "content-type": "application/json" }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  }, async close() { await router.close?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); } };
}
const fields = (endpoint: string) => ({ name: "本地登记", enabled: true, transport: { type: "streamable-http", endpoint } });

test("S7 HTTP 明确动作才发现；目录/错误脱敏且全局本地用户、CAS、能力边界生效", async () => {
  const f = await fixture(), upstream = await discoveryTestServer({ page: () => ({ tools: [discoveryTool("one")] }) });
  try {
    const input = { ...fields(upstream.endpoint), requestId: "register" };
    const created = await f.request("/api/mcp/connections", "POST", input);
    assert.equal(created.status, 201);
    const { connection } = await created.json() as { connection: { connectionId: string; revision: number } };
    const item = `/api/mcp/connections/${connection.connectionId}`;
    assert.equal(upstream.methods.length, 0, "登记和普通读取不触发握手");
    const before = await (await f.request(item)).json() as { state: string; modelState: string; currentSnapshot: unknown };
    assert.equal(before.state, "registered"); assert.equal(before.modelState, "not_provided"); assert.equal(before.currentSnapshot, null);
    const discovered = await f.request(`${item}/discover`, "POST", { requestId: "check", expectedRevision: 1 });
    assert.equal(discovered.status, 200);
    const { attempt } = await discovered.json() as { attempt: { status: string; snapshotId: string; attemptId: string } };
    assert.equal(attempt.status, "succeeded");
    const catalog = await f.request(`${item}/catalogs/${attempt.snapshotId}`); assert.equal(catalog.status, 200);
    assert.doesNotMatch(await catalog.text(), /127\.0\.0\.1|owned-fixture-session/);
    assert.equal((await f.request(`${item}/discoveries/${attempt.attemptId}`)).status, 200);
    assert.equal((await f.request(item, "PUT", { ...input, requestId: "bad-cas", expectedRevision: 8 })).status, 409);
    assert.equal((await f.request("/api/mcp/connections", "POST", { ...input, requestId: "extra", authorized: true })).status, 400);
    assert.equal((await f.request("/api/mcp/connections", "POST", { ...input, requestId: "bad-endpoint", transport: {
      type: "streamable-http", endpoint: "https://user:secret@example.invalid/?token=private" } })).status, 400);
    assert.equal((await f.request(`${item}/tools/call`, "POST", {})).status, 404);
    const configuration = await (await f.request(`${item}/revisions/1/configuration`)).json() as { configuration: { transport: { endpoint: string } } };
    assert.equal(configuration.configuration.transport.endpoint, upstream.endpoint);
    const calls = upstream.methods.length;
    for (const headers of [{ "x-test-actor": "agent" }, { "x-test-actor": "project-human" }, { origin: "http://untrusted.invalid" }]) {
      assert.equal((await f.request("/api/mcp/connections", "GET", undefined, headers)).status, 403);
      assert.equal((await f.request(`${item}/revisions/1/configuration`, "GET", undefined, headers)).status, 403);
      assert.equal((await f.request(`${item}/discover`, "POST", { requestId: "forbidden", expectedRevision: 1 }, headers)).status, 403);
    }
    assert.equal(upstream.methods.length, calls);
    const blocked = await f.request("/api/mcp/connections", "POST", { name: "待授权", enabled: true, requestId: "stdio",
      transport: { type: "stdio", command: "npm", args: ["private-argv"] } });
    const saved = await blocked.json() as { connection: { connectionId: string } };
    const check = await readAttempt(f.request(`/api/mcp/connections/${saved.connection.connectionId}/discover`, "POST", { requestId: "stdio-check", expectedRevision: 1 }));
    assert.equal(check.status, "blocked"); assert.equal(check.errorCode, "launch_unavailable");
    assert.doesNotMatch(JSON.stringify(check), /private-argv|npm/);
  } finally { await f.close(); await upstream.close(); }
});

test("S7 HTTP 用户取消和路由关闭回收真实自有会话，取消不发布目录", { timeout: 15_000 }, async () => {
  const f = await fixture();
  let hit!: () => void, release!: () => void;
  let arrived = new Promise<void>(resolve => { hit = resolve; });
  let hold = new Promise<void>(resolve => { release = resolve; });
  const upstream = await discoveryTestServer({ page: async () => { hit(); await hold; return { tools: [discoveryTool("late")] }; } });
  try {
    const { connection } = await (await f.request("/api/mcp/connections", "POST", { ...fields(upstream.endpoint), requestId: "register" })).json() as { connection: { connectionId: string } };
    const item = `/api/mcp/connections/${connection.connectionId}`;
    const pending = f.request(`${item}/discover`, "POST", { requestId: "cancel", expectedRevision: 1 });
    await arrived;
    const { lastDiscovery } = await (await f.request(item)).json() as { lastDiscovery: { attemptId: string } };
    const requested = await readAttempt(f.request(`${item}/discoveries/${lastDiscovery.attemptId}/cancel`, "POST", {}));
    assert.equal(requested.status, "cancel_requested");
    assert.equal((await readAttempt(pending)).status, "cancelled");
    release();
    arrived = new Promise<void>(resolve => { hit = resolve; }); hold = new Promise<void>(resolve => { release = resolve; });
    const closing = f.request(`${item}/discover`, "POST", { requestId: "close", expectedRevision: 1 });
    await arrived; await f.router.close();
    assert.equal((await readAttempt(closing)).status, "cancelled"); release();
    assert.equal(upstream.deletes, 2);
    assert.equal((await (await f.request(item)).json() as McpConnectionView).currentSnapshot, null);
  } finally { release(); await f.close(); await upstream.close(); }
});

test("S7 真实 startServer 关闭等待自有外部发现回收；重启读取持久取消结果", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "br-mcp-close-"));
  let hit!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { hit = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const upstream = await discoveryTestServer({ page: async () => { hit(); await hold; return { tools: [discoveryTool("late")] }; } });
  const options = { config: { port: 0, dataDir: dir, heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 }, configFile: null }, logger };
  let server = await startServer(options);
  try {
    const response = await fetch(`${server.url}/api/mcp/connections`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fields(upstream.endpoint), requestId: "register" }) });
    const { connection } = await response.json() as { connection: { connectionId: string } };
    const item = `/api/mcp/connections/${connection.connectionId}`;
    const request = fetch(`${server.url}${item}/discover`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "closing", expectedRevision: 1 }) }).then(async response => response.json(), () => null);
    await arrived; await server.close(); release(); await request;
    assert.equal(upstream.deletes, 1);
    server = await startServer(options);
    const restored = await (await fetch(`${server.url}${item}`)).json() as McpConnectionView;
    assert.equal(restored.lastDiscovery?.status, "cancelled"); assert.equal(restored.currentSnapshot, null);
    assert.equal(restored.modelState, "not_provided");
  } finally { release(); await server.close(); await upstream.close(); await rm(dir, { recursive: true, force: true }); }
});

test("S7 真实 HTTP 请求断开传播取消，持久结果与自有连接回收一致", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let hit!: () => void, release!: () => void, done!: () => void;
  const arrived = new Promise<void>(resolve => { hit = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const cancelled = new Promise<void>(resolve => { done = resolve; });
  const upstream = await discoveryTestServer({ page: async () => { hit(); await hold; return { tools: [] }; } });
  const stop = onMcpConnectionChange(f.db, async event => {
    if (!event.attemptId) return;
    const row = (await f.db.query<{ status: string }>("SELECT status FROM mcp_discovery_attempts WHERE id=?", [event.attemptId]))[0];
    if (row?.status === "cancelled") done();
  });
  try {
    const { connection } = await (await f.request("/api/mcp/connections", "POST", { ...fields(upstream.endpoint), requestId: "register" })).json() as { connection: { connectionId: string } };
    const controller = new AbortController(), item = `/api/mcp/connections/${connection.connectionId}`;
    const request = fetch(`${f.origin}${item}/discover`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ requestId: "disconnect", expectedRevision: 1 }) });
    const disconnected = assert.rejects(request, { name: "AbortError" });
    await arrived; controller.abort(); await disconnected; await cancelled; release();
    const view = await (await f.request(item)).json() as McpConnectionView;
    assert.equal(view.lastDiscovery!.status, "cancelled"); assert.equal(view.currentSnapshot, null);
    assert.equal(upstream.deletes, 1);
  } finally { stop(); release(); await f.close(); await upstream.close(); }
});

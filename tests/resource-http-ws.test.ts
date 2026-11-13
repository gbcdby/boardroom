import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type RunningServer, type ServerAuthorization } from "../src/server/server.ts";
import { createRepositories } from "../src/server/db/repositories.ts";
import { createLogger } from "../src/server/logger.ts";
import { ownerActor } from "../src/server/authz/actors.ts";

async function withServer(run: (server: RunningServer) => Promise<void>, authorization?: ServerAuthorization) {
  const directory = await mkdtemp(path.join(tmpdir(), "boardroom-resource-http-"));
  const server = await startServer({ config: { port: 0, dataDir: directory, configFile: null, heartbeat: { intervalMs: 10000, timeoutMs: 30000 } }, logger: createLogger({ write: () => {} }), ...(authorization ? { authorization } : {}) });
  try { await run(server); } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
}
async function write(server: RunningServer, method: string, url: string, value: unknown) {
  return fetch(server.url + url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}
async function watchSocket(server: RunningServer) {
  const socket = new WebSocket(server.wsUrl);
  const events: Record<string, any>[] = [];
  socket.addEventListener("message", event => events.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const waitFor = async (match: (event: Record<string, any>) => boolean) => {
    if (events.some(match)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.removeEventListener("message", check); reject(new Error("等待资源事件超时")); }, 2000);
      const check = () => { if (events.some(match)) { clearTimeout(timer); socket.removeEventListener("message", check); resolve(); } };
      socket.addEventListener("message", check);
    });
  };
  return { socket, events, waitFor, async barrier() {
    const sentAt = `barrier-${events.length}-${Math.random()}`; socket.send(JSON.stringify({ type: "ping", sentAt })); await waitFor(event => event.type === "pong" && event.sentAt === sentAt);
  }, async subscribe(projectId: string | null) {
    socket.send(JSON.stringify({ type: "resource.subscribe", projectId })); await waitFor(event => event.type === "resource.subscribed" && event.projectId === projectId);
  } };
}

test("真实 HTTP/MCP resource.changed 只发标识和版本，评论不推进 Task CAS 仍可条件 GET；页面读取不 ACK Agent", async () => {
  await withServer(async server => {
    const repos = createRepositories(server.database), project = await repos.projects.create({ name: "资源刷新" });
    const group = await repos.groups.create({ projectId: project.id, name: "协作" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
    const client = new Client({ name: "resource-test", version: "1" });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse((response.content as Array<{ type: string; text: string }>).find(block => block.type === "text")!.text);
    };
    const joined = await call("join", { displayName: "统筹", hostType: "other", projectId: project.id, groupId: group.id, role: "manager" });
    const ws = await watchSocket(server);
    try {
      await ws.subscribe(project.id);
      assert.equal(server.humanPresenceCount(project.id), 0, "资源订阅不制造人的在线 presence");
      const collection = `/api/projects/${project.id}/tasks`;
      const created = await write(server, "POST", collection, { title: "私有标题", body: "正文不进入提示", assigneeMemberId: joined.memberId });
      assert.equal(created.status, 201); const { task } = await created.json() as any;
      await ws.waitFor(event => event.type === "resource.changed" && event.id === task.id);
      assert.deepEqual(ws.events.find(event => event.type === "resource.changed"), { type: "resource.changed", projectId: project.id, entity: "task", id: task.id, revision: 1 });
      const initial = await fetch(server.url + `${collection}/${task.id}`);
      const etag = initial.headers.get("etag"); assert.ok(etag);
      const before = await initial.json() as any;
      const unchanged = await fetch(server.url + `${collection}/${task.id}`, { headers: { "if-none-match": etag } });
      assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), "");
      await call("comment_task", { taskId: task.id, body: "MCP 提交的新评论" });
      await ws.waitFor(() => ws.events.filter(event => event.type === "resource.changed" && event.id === task.id).length === 2);
      const changed = await fetch(server.url + `${collection}/${task.id}`, { headers: { "if-none-match": etag } });
      assert.equal(changed.status, 200); assert.notEqual(changed.headers.get("etag"), etag);
      const after = await changed.json() as any;
      assert.equal(after.task.revision, before.task.revision);
      assert.equal(after.comments[0].body, "MCP 提交的新评论");
      const pending = await repos.context.query<{ acked_at: string | null }>("SELECT acked_at FROM work_events WHERE task_id = ?", [task.id]);
      assert.equal(pending.length, 1); assert.equal(pending[0]!.acked_at, null);
      assert.equal((await write(server, "PATCH", `${collection}/${task.id}`, { expectedRevision: 999, title: "拒绝" })).status, 409);
      await ws.barrier();
      assert.equal(ws.events.filter(event => event.type === "resource.changed").length, 2, "拒绝不发成功");
      const listed = await fetch(server.url + collection); assert.ok(listed.headers.get("etag"));
      assert.equal((await fetch(server.url + collection, { headers: { "if-none-match": listed.headers.get("etag")! } })).status, 304);
    } finally { ws.socket.close(); await transport.terminateSession(); await client.close(); }
  });
});

test("资源 WS 显式订阅项目且发送前重验当前授权；旧订阅、未授权和无订阅收不到 ID", async () => {
  let allowed = true, forbiddenProject = "";
  await withServer(async server => {
    const repos = createRepositories(server.database), project = await repos.projects.create({ name: "授权范围" });
    const other = await repos.projects.create({ name: "不可见范围" }); forbiddenProject = other.id;
    const ws = await watchSocket(server), unscoped = await watchSocket(server);
    try {
      await ws.subscribe(project.id);
      await write(server, "POST", `/api/projects/${other.id}/tasks`, { title: "别的项目" });
      await ws.barrier(); await unscoped.barrier();
      assert.equal(ws.events.filter(event => event.type === "resource.changed").length, 0);
      assert.equal(unscoped.events.filter(event => event.type === "resource.changed").length, 0);
      allowed = false;
      await write(server, "POST", `/api/projects/${project.id}/tasks`, { title: "已撤销读权限" });
      await ws.barrier();
      assert.equal(ws.events.filter(event => event.type === "resource.changed").length, 0);
      allowed = true;
      ws.socket.send(JSON.stringify({ type: "resource.subscribe", projectId: other.id }));
      await ws.waitFor(event => event.type === "error" && event.code === "forbidden");
      await write(server, "POST", `/api/projects/${project.id}/tasks`, { title: "不可保留旧订阅" });
      await ws.barrier();
      assert.equal(ws.events.filter(event => event.type === "resource.changed").length, 0);
    } finally { ws.socket.close(); unscoped.socket.close(); }
  }, { resolveWsActor: async ({ projectId }) => allowed && projectId !== forbiddenProject ? ownerActor(projectId) : null });
});

test("真实 HTTP 审计写失败使 Task/history 一起回滚，无 resource.changed 成功提示", async () => {
  await withServer(async server => {
    const repos = createRepositories(server.database), project = await repos.projects.create({ name: "回滚对账" });
    const collection = `/api/projects/${project.id}/tasks`;
    const task = (await (await write(server, "POST", collection, { title: "提交前" })).json() as any).task;
    const before = await (await fetch(server.url + `${collection}/${task.id}`)).json();
    const ws = await watchSocket(server);
    try {
      await ws.subscribe(project.id);
      await server.database.exec("CREATE TRIGGER resource_test_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action = 'task.updated' BEGIN SELECT RAISE(ABORT, 'resource test rollback'); END");
      const response = await write(server, "PATCH", `${collection}/${task.id}`, { expectedRevision: 1, title: "必须回滚" });
      // 仓储既有 normalizeError 将 SQLite trigger 的约束拒绝映射为400。
      assert.equal(response.status, 400);
      assert.match((await response.json() as any).error.message, /resource test rollback/);
      await ws.barrier();
      assert.equal(ws.events.filter(event => event.type === "resource.changed").length, 0);
      assert.deepEqual(await (await fetch(server.url + `${collection}/${task.id}`)).json(), before);
    } finally { ws.socket.close(); }
  });
});

test("条件 GET 每次先检查当前读取权限，旧 ETag 不能把拒绝变成304", async () => {
  let allowed = true;
  await withServer(async server => {
    const repos = createRepositories(server.database), project = await repos.projects.create({ name: "ETag 授权" });
    const collection = `/api/projects/${project.id}/tasks`;
    const task = (await (await write(server, "POST", collection, { title: "仅授权可读" })).json() as any).task;
    const first = await fetch(server.url + `${collection}/${task.id}`), etag = first.headers.get("etag"); assert.ok(etag);
    allowed = false;
    const denied = await fetch(server.url + `${collection}/${task.id}`, { headers: { "if-none-match": etag } });
    assert.equal(denied.status, 403); assert.equal(denied.headers.get("etag"), null);
    assert.equal((await denied.json() as any).task, undefined);
  }, { resolveHttpActor: async ({ projectId }) => allowed ? ownerActor(projectId) : null });
});

#!/usr/bin/env node
/** #173 专属临时服务。代理只转发真实 HTTP/WS，并按测试指令丢包/断开；不生成成功业务响应。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { errorMonitor } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket, WebSocketServer } from "ws";
import { startServer } from "../src/server/server.ts";
import { createLogger } from "../src/server/logger.ts";
import { createRepositories } from "../src/server/db/repositories.ts";

const root = await mkdtemp(path.join(tmpdir(), "boardroom-resource-web-"));
const dataDir = path.join(root, "data"), home = path.join(root, "home");
process.env.BOARDROOM_HOME = home;
const events = [], sockets = new Set(), held = [];
const network = { dropResources: false, blocked: false, holdPath: null };
let server, proxy, websocketServer, httpClient, httpTransport, stdioClient, stdioTransport, closing;
let stdioStderr = "";
let nextRequestId = 0;
const event = (kind, fields = {}) => events.push({ kind, at: Date.now(), ...fields });
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
// 可选旁录独立于原验收 events；不改请求头/URL、响应字节或错误传播。
const diagnostic = { enabled: process.argv.includes("--diagnostics"), status: "COMPLETE", events: [],
  bytes: 0, dropped: 0, maxEvents: 4096, maxBytes: 1024 * 1024 };
const observe = (kind, fields = {}) => {
  if (!diagnostic.enabled) return;
  try {
    const item = { kind, at: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...fields };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (diagnostic.events.length >= diagnostic.maxEvents || diagnostic.bytes + size > diagnostic.maxBytes) {
      diagnostic.status = "INCOMPLETE"; diagnostic.dropped++; return;
    }
    diagnostic.events.push(item); diagnostic.bytes += size;
  } catch { diagnostic.status = "INCOMPLETE"; diagnostic.dropped++; }
};
const socketIdentity = socket => ({ localAddress: socket.localAddress ?? null, localPort: socket.localPort ?? null,
  remoteAddress: socket.remoteAddress ?? null, remotePort: socket.remotePort ?? null });
function observeRequest(request, response, entry) {
  if (!diagnostic.enabled) return;
  observe("proxy.ingress", { ...entry, socket: socketIdentity(request.socket) });
  for (const kind of ["aborted", "close", "end", "error"]) request.on(kind === "error" ? errorMonitor : kind, error => observe(`request.${kind}`,
    { ...entry, complete: request.complete, destroyed: request.destroyed, errorCode: error?.code ?? null }));
  for (const kind of ["finish", "close", "error"]) response.on(kind === "error" ? errorMonitor : kind, error => observe(`downstream.${kind}`,
    { ...entry, headersSent: response.headersSent, writableEnded: response.writableEnded,
      writableFinished: response.writableFinished, destroyed: response.destroyed, errorCode: error?.code ?? null }));
}


async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  const content = JSON.parse(result.content.find(item => item.type === "text").text);
  assert.equal(content.ok, true, JSON.stringify(content));
  return content;
}
async function close() {
  closing ??= (async () => {
    const failures = [];
    async function attempt(operation) { try { await operation(); } catch (error) { failures.push(String(error)); } }
    for (const socket of sockets) socket.terminate();
    for (const response of held) {
      observe("cleanup.destroy_held", response.entry); response.response.destroy();
    }
    await attempt(async () => { if (proxy?.listening) { const done = new Promise(resolve => proxy.close(resolve)); proxy.closeAllConnections(); await done; } });
    await attempt(() => websocketServer ? new Promise(resolve => websocketServer.close(resolve)) : undefined);
    await attempt(() => httpTransport?.terminateSession());
    await attempt(() => httpClient?.close());
    await attempt(() => stdioClient?.close());
    await attempt(() => stdioTransport?.close());
    await attempt(() => server?.close());
    await attempt(() => rm(root, { recursive: true, force: true }));
    send({ event: "closed", root, failures, stdioStderr, ...(diagnostic.enabled ? { diagnostics: diagnostic } : {}) });
    if (failures.length) process.exitCode = 1;
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().then(() => process.exit(process.exitCode ?? 0)); });

try {
  server = await startServer({ config: { port: 0, dbDriver: "sqlite", dataDir, configFile: null,
    heartbeat: { intervalMs: 1000, timeoutMs: 10000 } }, logger: createLogger({ write() {} }),
    webRoot: path.resolve(import.meta.dirname, "../dist/web") });
  const repos = createRepositories(server.database), records = [];
  for (const name of ["资源刷新甲", "资源刷新乙"]) {
    const project = await repos.projects.create({ name });
    const group = await repos.groups.create({ projectId: project.id, name: `${name} 协作` });
    records.push({ project, group });
  }
  httpClient = new Client({ name: "resource-browser-http", version: "1" });
  httpTransport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
  await httpClient.connect(httpTransport);
  records[1].memberId = (await call(httpClient, "join", { displayName: "HTTP 验收统筹", hostType: "other",
    projectId: records[1].project.id, groupId: records[1].group.id, role: "manager" })).memberId;
  stdioClient = new Client({ name: "resource-browser-stdio", version: "1" });
  stdioTransport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(import.meta.dirname, "../src/server/mcp/stdio.ts")], cwd: root, stderr: "pipe",
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), BOARDROOM_HOME: home,
      AGENT_STUDIO_DATA_DIR: dataDir, AGENT_STUDIO_DB_DRIVER: "sqlite", AGENT_STUDIO_LOG_LEVEL: "error" } });
  stdioTransport.stderr?.on("data", chunk => { stdioStderr = (stdioStderr + String(chunk)).slice(-16000); });
  await stdioClient.connect(stdioTransport);
  records[0].memberId = (await call(stdioClient, "join", { displayName: "stdio 验收统筹", hostType: "other",
    projectId: records[0].project.id, groupId: records[0].group.id, role: "manager" })).memberId;

  proxy = createServer((request, response) => {
    const entry = { requestId: ++nextRequestId, method: request.method, path: request.url, ifNoneMatch: request.headers["if-none-match"] ?? null };
    event("http.request", entry);
    observeRequest(request, response, entry);
    if (network.blocked) { event("http.offline", entry); response.writeHead(503); response.end("test network disconnected"); return; }
    // 捕获上游真实字节；延迟场景只延后交付，不改状态、ETag 或正文。
    const upstream = httpRequest(new URL(request.url, server.url), { method: request.method, headers: request.headers }, result => {
      observe("upstream.headers", { ...entry, status: result.statusCode, etag: result.headers.etag ?? null });
      if (diagnostic.enabled) for (const kind of ["aborted", "close", "error"]) result.on(kind === "error" ? errorMonitor : kind, error =>
        observe(`upstream.response.${kind}`, { ...entry, complete: result.complete, destroyed: result.destroyed, errorCode: error?.code ?? null }));
      const chunks = [];
      result.on("data", chunk => chunks.push(chunk));
      result.on("end", () => {
        const body = Buffer.concat(chunks), headers = result.headers, status = result.statusCode;
        event("http.response", { ...entry, status, etag: headers.etag ?? null });
        observe("upstream.complete", { ...entry, status, etag: headers.etag ?? null, bytes: body.length,
          ...(diagnostic.enabled ? { bodySha256: createHash("sha256").update(body).digest("hex") } : {}) });
        const deliver = () => {
          observe("delivery.attempt", { ...entry, status, destroyed: response.destroyed });
          if (!response.destroyed) {
            response.writeHead(status, headers); response.end(body);
            observe("delivery.queued", { ...entry, status, bytes: body.length });
          } else observe("delivery.skipped_destroyed", entry);
        };
        if (network.holdPath === request.url && request.method === "GET") {
          network.holdPath = null; held.push({ response, deliver, path: request.url, entry }); event("http.held", entry);
        } else deliver();
      });
    });
    if (diagnostic.enabled) {
      upstream.on("socket", socket => {
        observe("upstream.socket", { ...entry, socket: socketIdentity(socket) });
        if (socket.connecting) socket.once("connect", () => observe("upstream.connect", { ...entry, socket: socketIdentity(socket) }));
      });
      for (const kind of ["finish", "close", "error"]) upstream.on(kind === "error" ? errorMonitor : kind, error =>
        observe(`upstream.request.${kind}`, { ...entry, destroyed: upstream.destroyed, errorCode: error?.code ?? null }));
    }
    upstream.on("error", error => { event("http.error", { ...entry, message: error.message }); if (!response.destroyed) { response.writeHead(502); response.end(); } });
    request.pipe(upstream);
  });
  websocketServer = new WebSocketServer({ noServer: true });
  proxy.on("upgrade", (request, socket, head) => {
    if (network.blocked) { event("ws.rejected"); socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
    websocketServer.handleUpgrade(request, socket, head, downstream => {
      const upstream = new WebSocket(new URL(request.url, server.wsUrl));
      const pending = [];
      sockets.add(downstream); sockets.add(upstream);
      event("ws.connected");
      downstream.on("message", (data, binary) => {
        let frame; try { frame = JSON.parse(String(data)); } catch { /* 仍原样转发。 */ }
        if (String(frame?.type).startsWith("resource.")) event("ws.client", { frame });
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else pending.push({ data, binary });
      });
      upstream.on("open", () => { for (const item of pending) upstream.send(item.data, { binary: item.binary }); });
      upstream.on("message", (data, binary) => {
        let frame; try { frame = JSON.parse(String(data)); } catch { /* 非 JSON 仍原样转发。 */ }
        const dropped = network.dropResources && frame?.type === "resource.changed";
        if (String(frame?.type).startsWith("resource.")) event(dropped ? "ws.dropped" : "ws.forwarded", { frame });
        if (!dropped && downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
      });
      downstream.on("close", () => { event("ws.closed"); sockets.delete(downstream); upstream.terminate(); });
      upstream.on("close", () => { sockets.delete(upstream); if (downstream.readyState === WebSocket.OPEN) downstream.close(); });
      for (const socket of [downstream, upstream]) socket.on("error", error => { event("ws.error", { message: error.message }); socket.terminate(); });
    });
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  send({ event: "ready", url: `http://127.0.0.1:${proxy.address().port}`, writeUrl: server.url,
    records, root, dataDir, fixturePid: process.pid, stdioPid: stdioTransport.pid,
    evidenceScope: "real HTTP/MCP/stdio/WS; controlled network faults; no model execution" });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let command;
    try {
      command = JSON.parse(line);
      let result;
      if (command.op === "network") {
        for (const key of ["dropResources", "blocked"]) if (command[key] !== undefined) { assert.equal(typeof command[key], "boolean"); network[key] = command[key]; }
        if (command.holdPath !== undefined) { assert.ok(command.holdPath === null || /^\/api\/projects\/.+\/tasks(?:\/[^/]+)?$/.test(command.holdPath)); network.holdPath = command.holdPath; }
        if (network.blocked) for (const socket of sockets) socket.terminate();
        event("network.control", { ...network }); result = { ...network };
      } else if (command.op === "release") {
        result = held.splice(0).map(item => { const browserCancelled = item.response.destroyed;
          observe("release.requested", { ...item.entry, browserCancelled }); item.deliver(); event("http.released", { path: item.path, browserCancelled }); return item.path; });
      } else if (command.op === "mcp") {
        assert.ok(["update_task", "comment_task"].includes(command.name));
        assert.ok(["stdio", "http"].includes(command.transport));
        result = await call(command.transport === "stdio" ? stdioClient : httpClient, command.name, command.args);
        event("mcp.committed", { transport: command.transport, name: command.name, taskId: command.args.taskId, revision: result.task?.revision });
      } else if (command.op === "diagnostics" && diagnostic.enabled) {
        result = diagnostic;
      } else if (command.op === "snapshot") {
        result = { events, network: { ...network }, stdioPid: stdioTransport.pid, heldPaths: held.map(item => item.path),
          workEvents: await repos.context.query("SELECT task_id, acked_at FROM work_events ORDER BY id") };
      } else throw new Error("unknown_fixture_command");
      send({ id: command.id, ok: true, result });
    } catch (error) { send({ id: command?.id, ok: false, error: String(error) }); }
  }
} catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
finally { await close(); }

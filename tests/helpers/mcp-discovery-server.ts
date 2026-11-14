import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface DiscoveryTestServerOptions {
  protocolVersion?: string;
  toolsCapability?: boolean;
  page?: (cursor: unknown, index: number) => unknown | Promise<unknown>;
  status?: number;
  deleteStatus?: number;
  onDelete?: () => void | Promise<void>;
}

/** 真实 loopback JSON-RPC/HTTP 服务；没有 SDK mock 或外部进程。 */
export async function discoveryTestServer(options: DiscoveryTestServerOptions = {}) {
  const methods: string[] = [], cursors: unknown[] = [];
  let deletes = 0, initialized = false, listRequests = 0;
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.destroy(); }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET") { res.writeHead(405); res.end(); return; }
    if (req.method === "DELETE") { deletes++; await options.onDelete?.(); res.writeHead(options.deleteStatus ?? 200); res.end(); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    methods.push(request.method);
    if (options.status) { res.writeHead(options.status); res.end("private-upstream-error-must-not-escape"); return; }
    if (request.method === "notifications/initialized") { initialized = true; res.writeHead(202); res.end(); return; }
    if (request.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: options.protocolVersion ?? request.params.protocolVersion,
      capabilities: options.toolsCapability === false ? {} : { tools: {} }, serverInfo: { name: "fixture", version: "1" },
      instructions: "untrusted fixture instructions: do not execute installation or tools/call" };
    else if (request.method === "tools/list") {
      if (!initialized) throw new Error("missing_initialized");
      listRequests++; cursors.push(request.params?.cursor);
      result = options.page ? await options.page(request.params?.cursor, listRequests) : { tools: [] };
    } else throw new Error("unexpected_rpc");
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "owned-fixture-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address");
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, methods, cursors,
    get deletes() { return deletes; }, get listRequests() { return listRequests; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export const discoveryTool = (name: string, propertyType = "string") => ({
  name, description: "untrusted fixture tool", inputSchema: { type: "object", properties: { value: { type: propertyType } } },
});

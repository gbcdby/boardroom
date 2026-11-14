import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { T1ApiOptions } from "../../api.ts";
import { ownerActor } from "../../authz/actors.ts";
import { ForbiddenError } from "../../authz/authorize.ts";
import { requireCatalogUser, type CatalogAccess } from "../../identity/catalog.ts";
import { StorageMaintenanceError } from "../../storage/admission.ts";
import { CapabilityInputError } from "../capabilities/json.ts";
import { McpConnectionError } from "./errors.ts";
import { createMcpConnections } from "./service.ts";

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function methods(res: ServerResponse, allowed: readonly string[]) {
  res.setHeader("allow", allowed.join(", "));
  json(res, 405, { error: { code: "method_not_allowed", message: "此入口不支持该操作。" } });
}
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return Boolean(host && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new McpConnectionError("mcp_connection_json_required");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
    if (bytes > 1_000_000) throw new McpConnectionError("mcp_connection_body_too_large");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new McpConnectionError("mcp_connection_invalid_json"); }
}

/** 现有 localhost 单用户管理边界；不注册模型工具、不改变 Profile/Binding 或 WebSocket 权限。 */
export function createMcpConnectionsApi(options: T1ApiOptions) {
  const service = createMcpConnections({ db: options.db, ...(options.now ? { now: options.now } : {}) });
  async function access(request: IncomingMessage): Promise<CatalogAccess> {
    const actor = options.resolveActor ? await options.resolveActor({ request, projectId: null }) : ownerActor();
    if (!actor) throw new McpConnectionError("forbidden", 403);
    const result = { actor }; requireCatalogUser(result); return result;
  }
  return {
    close: () => service.close(),
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
      if (!/^\/api\/mcp\/connections(\/|$)/.test(pathname)) return false;
      try {
        if (!sameOrigin(req)) throw new McpConnectionError("forbidden", 403);
        const user = await access(req), method = req.method ?? "GET";
        let parts: string[];
        try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
        catch { throw new McpConnectionError("mcp_connection_path_invalid"); }
        if (parts.length === 3) {
          if (method === "GET") json(res, 200, { connections: await service.list(user) });
          else if (method === "POST") json(res, 201, { connection: await service.create(user, await body(req)) });
          else methods(res, ["GET", "POST"]);
          return true;
        }
        const id = parts[3]!;
        if (parts.length === 4) {
          if (method === "GET") json(res, 200, await service.get(user, id));
          else if (method === "PUT") json(res, 200, { connection: await service.update(user, id, await body(req)) });
          else methods(res, ["GET", "PUT"]);
          return true;
        }
        if (parts.length === 5 && parts[4] === "discover") {
          if (method !== "POST") methods(res, ["POST"]);
          else {
            const input = await body(req), controller = new AbortController();
            const abort = () => { if (!res.writableEnded) controller.abort(); };
            req.once("aborted", abort); res.once("close", abort);
            if (req.aborted || res.destroyed) controller.abort();
            try { json(res, 200, { attempt: await service.discover(user, id, input, controller.signal) }); }
            finally { req.off("aborted", abort); res.off("close", abort); }
          }
          return true;
        }
        if (parts.length === 6 && parts[4] === "catalogs") {
          if (method === "GET") json(res, 200, { snapshot: await service.snapshot(user, id, parts[5]!) });
          else methods(res, ["GET"]);
          return true;
        }
        if (parts.length === 6 && parts[4] === "discoveries") {
          if (method === "GET") json(res, 200, { attempt: await service.attempt(user, id, parts[5]!) });
          else methods(res, ["GET"]);
          return true;
        }
        if (parts.length === 7 && parts[4] === "discoveries" && parts[6] === "cancel") {
          if (method !== "POST") methods(res, ["POST"]);
          else {
            if (!z.object({}).strict().safeParse(await body(req)).success) throw new McpConnectionError("mcp_connection_input_invalid");
            json(res, 200, { attempt: await service.cancel(user, id, parts[5]!) });
          }
          return true;
        }
        if (parts.length === 7 && parts[4] === "revisions" && parts[6] === "configuration") {
          if (method === "GET") {
            if (!/^[1-9][0-9]*$/.test(parts[5]!)) throw new McpConnectionError("mcp_connection_input_invalid");
            json(res, 200, { configuration: await service.configuration(user, id, Number(parts[5])) });
          } else methods(res, ["GET"]);
          return true;
        }
        json(res, 404, { error: { code: "not_found", message: "未找到连接或目录入口。" } });
      } catch (error) {
        if (error instanceof StorageMaintenanceError) throw error;
        if (error instanceof ForbiddenError || error instanceof McpConnectionError && error.status === 403)
          json(res, 403, { error: { code: "forbidden", message: "仅本地用户可以管理全局 MCP 连接与目录。" } });
        else if (error instanceof McpConnectionError || error instanceof CapabilityInputError)
          json(res, error instanceof McpConnectionError ? error.status : 400, { error: { code: error.code,
            message: "连接输入、状态或版本不满足本次操作，请检查后重试。" } });
        else { options.logger.warn("mcp_connection_api_failed"); json(res, 500, { error: { code: "internal_error", message: "MCP 连接目录请求失败。" } }); }
      }
      return true;
    },
  };
}

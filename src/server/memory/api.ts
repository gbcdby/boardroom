import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { DbDriver } from "../db/driver.ts";
import { createRepositories } from "../db/repositories.ts";
import { RepositoryError } from "../db/errors.ts";
import type { Logger } from "../logger.ts";
import type { ActorResolution } from "../api.ts";
import { ForbiddenError, type Actor } from "../authz/authorize.ts";
import { ownerActor } from "../authz/actors.ts";
import type { MemoryKey } from "../../shared/memory.ts";
import { MemoryError } from "./errors.ts";
import { createMemoryService, type MemoryAccess } from "./service.ts";
import { getMemoryRuntime } from "./runtime.ts";
import { notifyWorkEventCommit } from "../tasks/events.ts";
import { memoryHistoryQuerySchema, memoryMutationSchema, parseMemoryInput, writeMemorySchema } from "./schemas.ts";

const statusFor: Record<string, number> = { not_found: 404, conflict: 409, archived: 409,
  invalid_reference: 400, invalid_argument: 400, write_failed: 500 };
const noQuery = z.object({}).strict();
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function notFound(response: ServerResponse): void { json(response, 404, { error: { code: "not_found", message: "记忆接口不存在。" } }); }
function methodNotAllowed(response: ServerResponse): void { json(response, 405, { error: { code: "method_not_allowed", message: "此记忆接口不支持该操作。" } }); }
function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  return !!host && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    && (request.headers.origin === undefined || request.headers.origin === `http://${host}`);
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new MemoryError("memory_input_invalid", "记忆写入需要 application/json。");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_500_000) throw new MemoryError("memory_input_too_large", "记忆请求超过上限。");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MemoryError("memory_input_invalid", "记忆请求不是有效 JSON。"); }
}

/** HTTP 只开放项目记忆管理；全局私有记忆与目标 Agent 的摘要执行均走绑定 MCP。 */
export function createMemoryApi(options: { db: DbDriver; logger: Logger;
  resolveActor?: (resolution: ActorResolution) => Promise<Actor | null>;
}): { handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> } {
  const runtime = getMemoryRuntime(options.db), log = options.logger.child({ component: "memory-api" });
  const repos = createRepositories(options.db);
  const service = createMemoryService({ repos, config: runtime.config, injectionReader: runtime.reader,
    readVisibleMessages: async () => [], onWorkEvents: events => notifyWorkEventCommit(options.db, events) });
  return { async handle(request, response, pathname) {
    if (pathname !== "/api/memory-settings" && !/^\/api\/projects\/[^/]+\/memories(\/|$)/.test(pathname)) return false;
    try {
      if (!sameOrigin(request)) { json(response, 403, { error: { code: "forbidden", message: "仅接受本地同源记忆请求。" } }); return true; }
      let parts: string[];
      try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new MemoryError("memory_input_invalid", "记忆路径编码无效。"); }
      const projectId = pathname === "/api/memory-settings" ? null : parts[2]!;
      const actor = options.resolveActor ? await options.resolveActor({ request, projectId }) : ownerActor(projectId);
      if (!actor) throw new ForbiddenError({ allowed: false, capability: "memory:read_shared", code: "forbidden", reason: "无法确定记忆请求主体。" });
      const access: MemoryAccess = { actor }, method = request.method ?? "GET";
      const query = Object.fromEntries(new URL(request.url ?? pathname, "http://127.0.0.1").searchParams);
      if (projectId === null) {
        if (actor.kind !== "human" || actor.role !== "owner") throw new ForbiddenError({ allowed: false, capability: "memory:read_shared", code: "forbidden", reason: "仅本地所有者可以读取有效记忆设置。" });
        parseMemoryInput(noQuery, query);
        if (method === "GET") json(response, 200, { settings: runtime.config });
        else methodNotAllowed(response);
        return true;
      }
      if (parts.length === 4) {
        parseMemoryInput(noQuery, query);
        if (method === "GET") json(response, 200, { documents: await service.list(access, projectId) });
        else methodNotAllowed(response);
        return true;
      }
      if (parts.length === 7 && parts[4] === "summary-requests" && parts[6] === "retry") {
        parseMemoryInput(noQuery, query);
        if (method === "POST") {
          // owner 也可能是全局主体；不能忽略 URL 项目而修改另一个项目的请求。
          const summary = await repos.memory.getRequest(parts[5]!);
          if (!summary || summary.projectId !== projectId) { notFound(response); return true; }
          json(response, 200, { request: await service.retrySummary(access, summary.id, parseMemoryInput(memoryMutationSchema, await readBody(request)).clientMutationId) });
        }
        else methodNotAllowed(response);
        return true;
      }
      const key: MemoryKey | null = parts[4] === "shared" ? { scope: "project", projectId, agentId: null }
        : parts[4] === "agents" && parts[5] ? { scope: "project-agent", projectId, agentId: parts[5] } : null;
      if (!key) { notFound(response); return true; }
      const tail = parts.slice(key.scope === "project" ? 5 : 6);
      if (tail.length === 0) {
        parseMemoryInput(noQuery, query);
        if (method === "GET") json(response, 200, await service.read(access, key));
        else if (method === "PUT") json(response, 200, await service.write(access, key, parseMemoryInput(writeMemorySchema, await readBody(request))));
        else methodNotAllowed(response);
      } else if (tail.length === 1 && tail[0] === "versions") {
        const input = parseMemoryInput(memoryHistoryQuerySchema, query);
        if (method === "GET") json(response, 200, { versions: await service.history(access, key, input.beforeVersion) });
        else methodNotAllowed(response);
      } else if (tail.length === 2 && tail[0] === "versions") {
        parseMemoryInput(noQuery, query);
        if (!/^[1-9]\d*$/.test(tail[1]!) || !Number.isSafeInteger(Number(tail[1]))) throw new MemoryError("memory_input_invalid", "记忆版本必须是正整数。");
        if (method === "GET") json(response, 200, { version: await service.readVersion(access, key, Number(tail[1])) });
        else methodNotAllowed(response);
      } else if (key.scope === "project-agent" && tail.length === 1 && tail[0] === "summary-requests") {
        parseMemoryInput(noQuery, query);
        if (method === "GET") json(response, 200, { requests: await service.listSummaryRequests(access, projectId, key.agentId) });
        else methodNotAllowed(response);
      } else notFound(response);
    } catch (error) {
      if (error instanceof ForbiddenError) json(response, 403, { error: { code: error.code, message: error.message } });
      else if (error instanceof RepositoryError) json(response, statusFor[error.code] ?? 500,
        { error: { code: error.code, message: error.message, ...(error instanceof MemoryError ? { reason: error.reason } : {}) } });
      else {
        // 不输出请求正文、源材料或数据库连接信息。
        log.error("memory_request_failed");
        json(response, 500, { error: { code: "internal_error", message: "记忆操作失败，请重试。" } });
      }
    }
    return true;
  } };
}

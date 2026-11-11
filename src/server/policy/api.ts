import type { IncomingMessage, ServerResponse } from "node:http";
import type { T1ApiOptions } from "../api.ts";
import { ownerActor } from "../authz/actors.ts";
import { ForbiddenError } from "../authz/authorize.ts";
import { RepositoryError } from "../db/errors.ts";
import { createRepositories } from "../db/repositories.ts";
import { createPolicyConfiguration, requirePolicyUser } from "./configuration.ts";
import { PolicyConfigurationError } from "./configuration-errors.ts";

// 与现有管理 API 同量级的硬上限；超限不截断成另一份有效规则。
const MAX_BODY_BYTES = 1_000_000;
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value));
}
function methods(res: ServerResponse, allowed: string[]) {
  res.setHeader("allow", allowed.join(", ")); json(res, 405, { error: { code: "method_not_allowed", message: "此入口不支持该操作。" } });
}
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return Boolean(host && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new PolicyConfigurationError("policy_json_required");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
    if (bytes > MAX_BODY_BYTES) throw new PolicyConfigurationError("policy_body_too_large"); chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new PolicyConfigurationError("policy_invalid_json"); }
}

/** 仅挂现有可信本地用户 HTTP 管理边界；无 MCP 注册、执行器、授权或默认初始化。 */
export function createPolicyApi(options: T1ApiOptions) {
  const repos = options.repos ?? createRepositories(options.db), service = createPolicyConfiguration({ repos, ...(options.now ? { now: options.now } : {}) });
  return { async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const globalPath = /^\/api\/policies\/global(?:\/|$)/.test(pathname);
    const projectPath = /^\/api\/projects\/[^/]+\/policy(?:\/|$)/.test(pathname);
    if (!globalPath && !projectPath) return false;
    try {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "forbidden", message: "仅接受本地同源策略管理请求。" } }); return true; }
      let parts: string[];
      try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw new PolicyConfigurationError("policy_path_invalid"); }
      const projectId = globalPath ? null : parts[2]!;
      const actor = options.resolveActor ? await options.resolveActor({ request: req, projectId }) : ownerActor();
      if (!actor) throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden", reason: "无法确定本地用户。" });
      const access = { actor }; requirePolicyUser(access, projectId);
      const rest = parts.slice(globalPath ? 3 : 4), method = req.method ?? "GET";
      const query = new URL(req.url!, "http://localhost").searchParams;
      const allowedQuery = rest.length === 1 && rest[0] === "versions" ? ["limit", "beforeRevision"] : [];
      if ([...query.keys()].some(key => !allowedQuery.includes(key) || query.getAll(key).length !== 1)) throw new PolicyConfigurationError("policy_query_invalid");
      if (rest.length === 0) {
        if (method === "GET") json(res, 200, { policy: projectId === null ? await service.getGlobal(access) : await service.getProject(access, projectId) });
        else if (method === "PUT") json(res, 200, { policy: projectId === null ? await service.updateGlobal(access, await body(req)) : await service.updateProject(access, projectId, await body(req)) });
        else methods(res, ["GET", "PUT"]);
      } else if (rest.length === 1 && rest[0] === "effective") {
        if (method === "GET") json(res, 200, { effective: await service.getEffective(access, projectId) }); else methods(res, ["GET"]);
      } else if (rest.length === 1 && rest[0] === "preview") {
        if (method === "POST") json(res, 200, { preview: await service.preview(access, projectId, await body(req)) }); else methods(res, ["POST"]);
      } else if (rest.length === 1 && rest[0] === "versions") {
        if (method !== "GET") methods(res, ["GET"]);
        else {
          const input = Object.fromEntries([...query.entries()].map(([key, value]) => [key, Number(value)]));
          json(res, 200, projectId === null ? await service.listGlobalVersions(access, input) : await service.listProjectVersions(access, projectId, input));
        }
      } else if (rest.length === 2 && rest[0] === "versions") {
        if (method === "GET") json(res, 200, { policy: projectId === null ? await service.getGlobalVersion(access, Number(rest[1])) : await service.getProjectVersion(access, projectId, Number(rest[1])) });
        else methods(res, ["GET"]);
      } else json(res, 404, { error: { code: "not_found", message: "未找到策略入口。" } });
    } catch (error) {
      if (error instanceof ForbiddenError) json(res, 403, { error: { code: "forbidden", message: "只有作用域内的可信本地用户可以管理策略。" } });
      else if (error instanceof PolicyConfigurationError) json(res, error.status, { error: { code: error.code, reason: error.reason,
        message: error.status === 409 ? "策略版本或项目覆盖已变化，请查看冲突信息后重新保存。" : error.status === 404 ? "策略版本或项目不存在。" : error.status === 400 ? "策略输入字段无效。" : "策略存储不可用，操作未提交。",
        fields: error.fields, current: error.current, conflicts: error.conflicts } });
      else if (error instanceof RepositoryError) {
        const status = error.code === "not_found" ? 404 : ["conflict", "archived", "mutation_scope_changed", "audit_snapshot_too_large"].includes(error.code) ? 409 : error.code === "write_failed" ? 500 : 400;
        json(res, status, { error: { code: error.code, reason: error.code, message: status === 409 ? "项目状态或策略版本已变化，请刷新后重试。" : "策略请求未完成，操作未提交。" } });
      } else { options.logger.warn("policy_configuration_api_failed"); json(res, 500, { error: { code: "internal_error", message: "策略请求失败。" } }); }
    }
    return true;
  } };
}

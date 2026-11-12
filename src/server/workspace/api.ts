import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { T1ApiOptions } from "../api.ts";
import type { NewProject } from "../db/types.ts";
import { createRepositories } from "../db/repositories.ts";
import { NotFoundError } from "../db/errors.ts";
import { authorizeOrThrow, ForbiddenError, type Actor } from "../authz/authorize.ts";
import { ownerActor } from "../authz/actors.ts";
import { createLegacyConfigInspector } from "../identity/legacy-config-inspection.ts";
import { createWorkspaceService, parseWorkspaceInput, workspaceCreateSchema, workspaceSaveSchema, workspaceClearSchema } from "./service.ts";
import { WorkspaceError } from "./errors.ts";
import { mapLegacyWorkspaces } from "./legacy-mapping.ts";

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value));
}
export function writeWorkspaceError(res: ServerResponse, error: WorkspaceError) {
  json(res, error.code === "conflict" || error.code === "workspace_changed" ? 409 : 400, { error: { code: error.code, reason: error.reason,
    message: error.message, fieldErrors: error.field === null ? {} : { [error.field]: { code: error.reason, message: error.message } } } });
}
function sameOrigin(req: IncomingMessage) {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
    throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden", reason: "仅接受本地同源工作区管理请求。" });
  }
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new WorkspaceError("workspace_json_required", "工作区请求体必须为 JSON。", "workspace");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 65536) throw new WorkspaceError("workspace_input_too_large", "工作区请求体过大。", "workspace");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WorkspaceError("workspace_json_invalid", "工作区请求体不是有效 JSON。", "workspace"); }
}

/** 仍装配到现有 localhost 管理 API；不添加 Agent/MCP 管理入口或运行准备状态。 */
export function createWorkspaceApi(options: T1ApiOptions) {
  const repos = options.repos ?? createRepositories(options.db);
  const environment = () => {
    if (!options.environment) throw new WorkspaceError("workspace_environment_unavailable", "管理入口未注入已选择的存储环境，不能推测工作区保护范围。", null, true);
    return options.environment;
  };
  let servicePromise: Promise<ReturnType<typeof createWorkspaceService>> | null = null;
  const service = () => servicePromise ??= Promise.resolve(createWorkspaceService({ repos, environment: environment(), ...(options.now ? { now: options.now } : {}) }));
  const inspector = createLegacyConfigInspector({ db: options.db, repos, ...(options.now ? { now: options.now } : {}) });
  async function access(req: IncomingMessage, projectId: string | null, capability: "project:view" | "runtime:manage") {
    const actor = options.resolveActor ? await options.resolveActor({ request: req, projectId }) : ownerActor(projectId);
    if (!actor) throw new ForbiddenError({ allowed: false, capability, code: "forbidden", reason: "无法确定请求主体。" });
    authorizeOrThrow(actor, capability, projectId === null ? {} : { projectId }); return { actor };
  }
  return {
    async createProject(req: IncomingMessage, actor: Actor, input: NewProject, raw: unknown) {
      sameOrigin(req);
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new WorkspaceError("workspace_json_required", "工作区请求体必须为 JSON。", "workspace");
      return (await service()).createProject({ actor }, input, parseWorkspaceInput(workspaceCreateSchema, raw));
    },
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
      if (pathname !== "/api/workspaces/preflight" && !/^\/api\/projects\/[^/]+\/workspace(?:\/|$)/.test(pathname)) return false;
      sameOrigin(req);
      const method = req.method ?? "GET";
      let parts: string[];
      try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new WorkspaceError("workspace_input_invalid", "工作区路径包含无效编码。", "projectId"); }
      const denied = (allowed: string[]) => { res.setHeader("allow", allowed.join(", ")); json(res, 405, { error: { code: "method_not_allowed", message: "此工作区入口不支持该操作。" } }); };
      if (pathname === "/api/workspaces/preflight") {
        const actor = await access(req, null, "runtime:manage");
        if (method !== "POST") denied(["POST"]);
        else { const fields = parseWorkspaceInput(z.object({ rootPath: workspaceCreateSchema.shape.rootPath }).strict(), await body(req));
          json(res, 200, { preflight: await (await service()).preflight(actor, fields.rootPath) }); }
        return true;
      }
      const projectId = parts[2]!;
      const actor = await access(req, projectId, method === "GET" && parts[4] !== "legacy-mapping" ? "project:view" : "runtime:manage");
      if (!await repos.projects.get(projectId)) throw new NotFoundError("项目不存在。");
      const workspaces = await service();
      if (parts.length === 4) {
        if (method === "GET") json(res, 200, await workspaces.get(actor, projectId));
        else if (method === "PUT") json(res, 200, await workspaces.save(actor, projectId, parseWorkspaceInput(workspaceSaveSchema, await body(req))));
        else if (method === "DELETE") json(res, 200, await workspaces.clear(actor, projectId, parseWorkspaceInput(workspaceClearSchema, await body(req))));
        else denied(["GET", "PUT", "DELETE"]);
        return true;
      }
      if (parts.length === 6 && parts[4] === "versions") {
        if (method !== "GET") denied(["GET"]);
        else { const workspace = await workspaces.getVersion(actor, { projectId, workspaceRevision: Number(parts[5]) });
          if (!workspace) throw new NotFoundError("工作区版本不存在。"); json(res, 200, { workspace }); }
        return true;
      }
      if (parts.length === 5 && parts[4] === "revalidate") {
        if (method !== "POST") denied(["POST"]);
        else { const value = parseWorkspaceInput(z.object({ workspaceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(), await body(req));
          json(res, 200, await workspaces.revalidate(actor, { projectId, workspaceRevision: value.workspaceRevision })); }
        return true;
      }
      if (parts.length === 5 && parts[4] === "legacy-mapping") {
        if (method !== "GET") denied(["GET"]);
        else { const query = new URL(req.url!, "http://localhost").searchParams, selected = query.has("bindingId") ? query.getAll("bindingId") : undefined;
          json(res, 200, await mapLegacyWorkspaces(await inspector.preflight(), projectId, await environment(), selected)); }
        return true;
      }
      return false;
    },
  };
}

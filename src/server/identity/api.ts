import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ActorResolution, T1ApiOptions } from "../api.ts";
import { ownerActor } from "../authz/actors.ts";
import { ForbiddenError } from "../authz/authorize.ts";
import { ConflictError, InvalidArgumentError, NotFoundError, RepositoryError } from "../db/errors.ts";
import { createRepositories } from "../db/repositories.ts";
import { auditView } from "../audit.ts";
import { createIdentityCatalog, requireCatalogUser, roleTemplateInputSchema, type CatalogAccess } from "./catalog.ts";
import { createLegacyConfigInspector, selectLegacyConfigSnapshot } from "./legacy-config-inspection.ts";

const revision = z.number().int().positive();
const expected = z.object({ expectedRevision: revision }).strict();
const update = roleTemplateInputSchema.extend({ expectedRevision: revision });
const copy = z.object({ expectedRevision: revision, name: roleTemplateInputSchema.shape.name }).strict();
const remove = z.object({ expectedRevision: revision, confirm: z.string().min(1).max(128).optional() }).strict();
const rename = z.object({ expectedDisplayName: z.string().min(1).max(64), displayName: roleTemplateInputSchema.shape.name }).strict();
const alias = z.object({ displayName: roleTemplateInputSchema.shape.name, hostType: z.string().min(1).max(128) }).strict();

function json(res: ServerResponse, status: number, value?: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(status === 204 ? undefined : JSON.stringify(value));
}
function methods(res: ServerResponse, allowed: string[]) {
  res.setHeader("allow", allowed.join(", ")); json(res, 405, { error: { code: "method_not_allowed", message: "此入口不支持该写入方式。" } });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new InvalidArgumentError("identity_catalog_input_invalid"); return result.data;
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new InvalidArgumentError("identity_catalog_json_required");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
    if (bytes > 65_536) throw new InvalidArgumentError("identity_catalog_body_too_large"); chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new InvalidArgumentError("identity_catalog_invalid_json"); }
}
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return Boolean(host && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)
    && (req.headers.origin === undefined || req.headers.origin === `http://${host}`));
}

/** 装配到现有本地用户 HTTP 管理边界；不注册 MCP 管理工具或新的可写 Profile。 */
export function createIdentityApi(options: T1ApiOptions) {
  const repos = options.repos ?? createRepositories(options.db), now = options.now ?? (() => new Date());
  const catalog = createIdentityCatalog({ repos, now }), inspector = createLegacyConfigInspector({ db: options.db, repos, now });
  const pendingDeletes = new Map<string, { token: string; revision: number; expiresAt: number }>();
  async function access(req: IncomingMessage): Promise<CatalogAccess> {
    const resolution: ActorResolution = { request: req, projectId: null };
    const actor = options.resolveActor ? await options.resolveActor(resolution) : ownerActor();
    if (!actor) throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden", reason: "无法确定本地用户。" });
    const result = { actor }; requireCatalogUser(result); return result;
  }
  function readOnly(res: ServerResponse, writeEndpoint: string | null, readEndpoint: string) {
    json(res, 409, { error: { code: "legacy_config_read_only", message: "此处只展示旧配置来源。当前配置仍由原 runtime 入口维护。" },
      authority: "legacy", migrated: false, writeEndpoint, readEndpoint });
  }
  return { async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!/^\/api\/(roles|agents|legacy-config)(\/|$)/.test(pathname) && pathname !== "/api/user/audit") return false;
    try {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "forbidden", message: "仅接受本地同源管理请求。" } }); return true; }
      const user = await access(req), method = req.method ?? "GET";
      let parts: string[];
      try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { throw new InvalidArgumentError("identity_path_invalid"); }
      if (parts[1] === "roles") {
        if (parts.length === 2) {
          if (method === "GET") json(res, 200, { roles: await catalog.roles.list(new URL(req.url!, "http://localhost").searchParams.get("includeArchived") === "true") });
          else if (method === "POST") json(res, 201, { role: await catalog.roles.create(user, parse(roleTemplateInputSchema, await body(req))) });
          else methods(res, ["GET", "POST"]);
          return true;
        }
        const id = parts[2]!;
        if (parts.length === 3) {
          if (method === "GET") { const role = await catalog.roles.get(id); if (!role) throw new NotFoundError("role_template_not_found"); json(res, 200, { role }); }
          else if (method === "PUT") { const { expectedRevision, ...fields } = parse(update, await body(req)); json(res, 200, { role: await catalog.roles.update(user, id, expectedRevision, fields) }); }
          else if (method === "DELETE") {
            const value = parse(remove, await body(req)), impact = await catalog.roles.deleteImpact(id);
            if (impact.revision !== value.expectedRevision) throw new ConflictError("role_revision_conflict");
            if (!impact.deletable) { json(res, 409, { error: { code: "conflict", reason: "role_template_in_use", message: "角色仍有历史引用，请使用归档。" }, impact }); return true; }
            if (value.confirm === undefined) {
              for (const [key, pending] of pendingDeletes) if (pending.expiresAt <= now().getTime()) pendingDeletes.delete(key);
              const confirmation = { token: randomUUID(), revision: impact.revision, expiresAt: now().getTime() + 300_000 };
              pendingDeletes.set(id, confirmation);
              json(res, 409, { error: { code: "confirmation_required", message: "请核对将删除的未使用角色及版本后再次确认。" }, impact, confirmation });
            } else {
              const pending = pendingDeletes.get(id);
              if (!pending || pending.token !== value.confirm || pending.revision !== value.expectedRevision || pending.expiresAt <= now().getTime()) throw new ConflictError("role_delete_confirmation_invalid");
              await catalog.roles.remove(user, id, value.expectedRevision); pendingDeletes.delete(id); json(res, 204);
            }
          } else methods(res, ["GET", "PUT", "DELETE"]);
          return true;
        }
        if (parts.length === 4 && parts[3] === "delete-impact") {
          if (method === "GET") json(res, 200, { impact: await catalog.roles.deleteImpact(id) }); else methods(res, ["GET"]); return true;
        }
        if (parts.length === 4 && ["copy", "archive", "restore"].includes(parts[3]!)) {
          if (method !== "POST") methods(res, ["POST"]);
          else if (parts[3] === "copy") { const value = parse(copy, await body(req)); json(res, 201, { role: await catalog.roles.copy(user, id, value.expectedRevision, value.name) }); }
          else { const value = parse(expected, await body(req)); json(res, 200, { role: await catalog.roles[parts[3] === "archive" ? "archive" : "restore"](user, id, value.expectedRevision) }); }
          return true;
        }
        if (parts.length === 5 && parts[3] === "revisions") {
          if (method !== "GET") methods(res, ["GET"]);
          else { const role = await catalog.roles.getVersion(id, parse(revision, Number(parts[4]))); if (!role) throw new NotFoundError("role_version_not_found"); json(res, 200, { role }); }
          return true;
        }
      }
      if (parts[1] === "agents") {
        if (parts.length === 2) { if (method === "GET") json(res, 200, { agents: await catalog.agents.list() }); else methods(res, ["GET"]); return true; }
        const id = parts[2]!;
        if (parts.length === 3) {
          if (method === "GET") json(res, 200, await catalog.agents.get(id));
          else if (method === "PATCH") { const value = parse(rename, await body(req)); json(res, 200, await catalog.agents.rename(user, id, value.expectedDisplayName, value.displayName)); }
          else methods(res, ["GET", "PATCH"]); return true;
        }
        if (parts.length === 4 && parts[3] === "aliases") {
          if (method === "GET") json(res, 200, { aliases: (await catalog.agents.get(id)).aliases });
          else if (method === "POST") json(res, 201, await catalog.agents.addAlias(user, id, parse(alias, await body(req))));
          else methods(res, ["GET", "POST"]); return true;
        }
        if (parts.length === 4 && parts[3] === "profile") {
          if (method === "GET") json(res, 200, await inspector.profile(id));
          else {
            await catalog.agents.get(id);
            const sources = await repos.context.query<{ id: string }>("SELECT id FROM agent_runtimes WHERE agent_id = ? ORDER BY id", [id]);
            readOnly(res, sources.length === 1 ? `/api/runtimes/${sources[0]!.id}` : sources.length === 0 ? "/api/runtimes" : null, pathname);
          }
          return true;
        }
      }
      if (parts[1] === "legacy-config") {
        if (parts.length === 3 && parts[2] === "preflight") {
          if (method === "GET") { const report = await inspector.preflight(); json(res, report.code === null ? 200 : 409, report); }
          else readOnly(res, "/api/runtimes", pathname); return true;
        }
        if (parts[2] === "bindings" && (parts.length === 4 || parts.length === 5 && parts[4] === "config-snapshot")) {
          if (method !== "GET") readOnly(res, `/api/runtime-bindings/${parts[3]}`, pathname);
          else {
            const binding = await inspector.binding(parts[3]!);
            if (parts.length === 4) json(res, 200, { binding });
            else { const selection = selectLegacyConfigSnapshot(binding); json(res, selection.code === null ? 200 : 409, { selection }); }
          }
          return true;
        }
      }
      if (pathname === "/api/user/audit") {
        if (method !== "GET") methods(res, ["GET"]);
        else {
          const query = new URL(req.url!, "http://localhost").searchParams, limit = query.get("limit"), beforeId = query.get("beforeId");
          const entries = await repos.audit.listUser({ ...(limit === null ? {} : { limit: parse(z.number().int().min(1).max(200), Number(limit)) }),
            ...(beforeId === null ? {} : { beforeId: parse(z.string().min(1).max(128), beforeId) }) });
          json(res, 200, { entries: entries.map(auditView) });
        }
        return true;
      }
      json(res, 404, { error: { code: "not_found", message: "未找到目录或只读来源入口。" } });
    } catch (error) {
      if (error instanceof ForbiddenError) json(res, 403, { error: { code: "forbidden", message: "仅本地用户可以管理全局职责和身份目录。" } });
      else if (error instanceof RepositoryError) {
        const status = error.code === "not_found" ? 404 : ["conflict", "archived", "migration_identity_ambiguous", "audit_snapshot_too_large"].includes(error.code) ? 409 : error.code === "write_failed" ? 500 : 400;
        json(res, status, { error: { code: error.code, reason: /^[a-z][a-z0-9_]{1,80}$/.test(error.message) ? error.message : error.code,
          message: status === 409 ? "对象、版本或引用已变化，请刷新后重试。" : status === 404 ? "对象不存在。" : status === 400 ? "输入字段或范围无效。" : "目录写入失败，操作未提交。" } });
      } else { options.logger.warn("identity_catalog_api_failed"); json(res, 500, { error: { code: "internal_error", message: "身份目录请求失败。" } }); }
    }
    return true;
  } };
}

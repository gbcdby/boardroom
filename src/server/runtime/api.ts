import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { DbDriver } from "../db/driver.ts";
import { createRepositories } from "../db/repositories.ts";
import { RepositoryError, InvalidArgumentError, NotFoundError } from "../db/errors.ts";
import { ownerActor } from "../authz/actors.ts";
import { authorizeOrThrow, ForbiddenError } from "../authz/authorize.ts";
import type { ActorResolution } from "../api.ts";
import type { Actor } from "../authz/authorize.ts";
import type { HeartbeatConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { buildStatusBoard } from "../status.ts";
import { createRuntimeRepository } from "./repository.ts";
import type { RuntimeBindingView, RuntimeView } from "./types.ts";
import type { RuntimeObservability } from "./observation-types.ts";
import type { RuntimeSupervisor } from "./supervisor.ts";

const id = z.string().min(1).max(100);
const config = z.object({
  model: z.string().min(1).max(200).nullable().optional(),
  workdir: z.string().min(1).max(4096).optional(),
  tools: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
  systemPrompt: z.string().max(16000).optional(),
  permissionMode: z.enum(["auto", "manual", "workspace-write"]).optional(),
}).strict();
const defaults = config.extend({ workdir: z.string().min(1).max(4096) });
const newBinding = z.object({ projectId: id, groupId: id, overrides: config.optional() }).strict();
const createSchema = z.object({ name: z.string().min(1).max(64),
  backend: z.enum(["claude-code", "codex-cli", "dsh"]), defaults,
  bindings: z.array(newBinding).min(1).max(100) }).strict();
const revision = z.number().int().nonnegative();
const updateSchema = z.object({ expectedRevision: revision, defaults }).strict();
const bindingSchema = z.object({ runtimeRevision: revision, bindingRevision: revision, overrides: config,
  advancedStrategy: z.literal("bypassPermissions").nullable().optional() }).strict();
const actionSchema = z.object({ action: z.enum(["start", "stop", "apply", "retry", "new-session"]),
  expectedIntentRevision: revision, runtimeRevision: revision.optional(), bindingRevision: revision.optional() }).strict()
  .refine(value => !["start", "apply", "new-session"].includes(value.action)
    || (value.runtimeRevision !== undefined && value.bindingRevision !== undefined));

/** JSON 没有 undefined；显式移除 Zod optional 的空属性，保持领域契约的精确可选语义。 */
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new InvalidArgumentError("runtime_json_required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) throw new InvalidArgumentError("runtime_body_too_large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InvalidArgumentError("runtime_invalid_json"); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidArgumentError("runtime_input_invalid");
  return result.data;
}

/** 无认证本地产品仍拒绝浏览器跨站配置写入；这不是执行隔离的替代品。 */
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${host}`;
}

export function createRuntimeApi(options: {
  db: DbDriver;
  logger: Logger;
  heartbeat: HeartbeatConfig;
  observations: RuntimeObservability;
  supervisor: RuntimeSupervisor;
  resolveActor?: (resolution: ActorResolution) => Promise<Actor | null>;
}): { handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> } {
  const repo = createRuntimeRepository(options.db);
  const repos = createRepositories(options.db);

  async function guard(req: IncomingMessage, projectId: string | null): Promise<void> {
    const actor = options.resolveActor ? await options.resolveActor({ request: req, projectId }) : ownerActor(projectId);
    if (!actor || (projectId === null && actor.projectId !== null)) {
      throw new ForbiddenError({ allowed: false, capability: "runtime:manage", code: "forbidden", reason: "需要本地管理主体。" });
    }
    authorizeOrThrow(actor, "runtime:manage", projectId === null ? {} : { projectId });
  }

  async function publicBinding(view: RuntimeBindingView) {
    const { harnessSessionId, processIdentity: _processIdentity, ...runner } = view.runner;
    const status = (await buildStatusBoard(repos, view.binding.projectId, {
      heartbeat: options.heartbeat, now: new Date(),
    })).find(member => member.memberId === view.binding.memberId) ?? null;
    const counts = (await options.db.query(`SELECT
      SUM(CASE WHEN d.wake_decision = 'allowed' AND d.status <> 'acked' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN d.wake_decision = 'suppressed' AND d.status <> 'acked' THEN 1 ELSE 0 END) AS suppressed,
      SUM(CASE WHEN d.status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN d.status = 'acked' THEN 1 ELSE 0 END) AS acked
      FROM message_deliveries d JOIN messages m ON m.id = d.message_id
      WHERE d.member_id = ? AND m.group_id = ?`, [view.binding.memberId, view.binding.groupId]))[0];
    const unknownExit = !runner.exitConfirmed && (!runner.leaseExpiresAt || Date.parse(runner.leaseExpiresAt) <= Date.now());
    const scopeActive = await repo.isScopeActive(view.binding.id);
    const reason = unknownExit ? "awaiting_exit" : !scopeActive ? "scope_inactive"
      : runner.nextRetryAt && Date.parse(runner.nextRetryAt) > Date.now()
      ? "backoff" : runner.lastErrorCode;
    const summary = view.binding.desiredState === "stopped"
      ? runner.exitConfirmed ? "stopped" : "stopping"
      : unknownExit ? "queued" : runner.state === "stopping" ? "stopping"
        : ["transport_lost", "permission_required", "protocol_invalid"].includes(runner.lastErrorCode ?? "") ? "error"
          : runner.state === "running" ? "running"
          : runner.state === "failed" && !runner.nextRetryAt ? "error" : "queued";
    return { ...view, runner: { ...runner, hasSession: harnessSessionId !== null },
      status: { summary, reason, queuedCount: Number(counts?.queued ?? 0), suppressedCount: Number(counts?.suppressed ?? 0),
        deliveryCounts: { pending: Number(counts?.pending ?? 0), delivered: Number(counts?.delivered ?? 0), acked: Number(counts?.acked ?? 0) },
        member: status, capability: options.supervisor.capability(view.binding.id) } };
  }
  async function publicRuntime(view: RuntimeView) {
    return { runtime: view.runtime, bindings: await Promise.all(view.bindings.map(publicBinding)) };
  }
  async function requiredBinding(bindingId: string) {
    const view = await repo.getBinding(bindingId);
    if (!view) throw new NotFoundError("runtime_binding_not_found");
    return view;
  }

  return { async handle(req, res, pathname) {
    if (!(pathname === "/api/runtimes" || pathname.startsWith("/api/runtimes/") || pathname.startsWith("/api/runtime-bindings/"))) return false;
    try {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "forbidden", message: "仅接受本地同源管理请求。" } }); return true; }
      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = req.method ?? "GET";
      if (parts[1] === "runtimes") {
        await guard(req, null);
        if (parts.length === 2 && method === "GET") {
          json(res, 200, { runtimes: await Promise.all((await repo.list()).map(publicRuntime)) }); return true;
        }
        if (parts.length === 2 && method === "POST") {
          const input = parse(createSchema, await body(req));
          const view = await repo.create({ ...input, defaults: compact(input.defaults), bindings: input.bindings.map(b => ({
            projectId: b.projectId, groupId: b.groupId, ...(b.overrides ? { overrides: compact(b.overrides) } : {}),
          })) });
          await options.observations.record({ event: "runtime.created", runtimeId: view.runtime.id, configRevision: view.runtime.revision });
          json(res, 201, { runtime: await publicRuntime(view) }); return true;
        }
        if (parts.length === 3 && method === "GET") {
          const view = await repo.get(parts[2]!);
          if (!view) throw new NotFoundError("runtime_not_found");
          json(res, 200, { runtime: await publicRuntime(view) }); return true;
        }
        if (parts.length === 3 && method === "PUT") {
          const input = parse(updateSchema, await body(req));
          const view = await repo.updateDefaults(parts[2]!, input.expectedRevision, compact(input.defaults));
          await options.observations.record({ event: "runtime.updated", runtimeId: view.runtime.id, configRevision: view.runtime.revision });
          json(res, 200, { runtime: await publicRuntime(view) }); return true;
        }
        if (parts.length === 3 && method === "DELETE") {
          await repo.delete(parts[2]!); json(res, 204, null); return true;
        }
        if (parts.length === 4 && parts[3] === "bindings" && method === "POST") {
          const input = parse(newBinding.extend({ expectedRuntimeRevision: revision.optional() }), await body(req));
          const view = await repo.addBinding(parts[2]!, { projectId: input.projectId, groupId: input.groupId,
            ...(input.overrides ? { overrides: compact(input.overrides) } : {}) }, input.expectedRuntimeRevision);
          await options.observations.record({ event: "binding.created", bindingId: view.binding.id, runtimeId: view.runtime.id,
            projectId: view.binding.projectId, memberId: view.binding.memberId });
          json(res, 201, { binding: await publicBinding(view) }); return true;
        }
      } else if (parts[1] === "runtime-bindings" && parts[2]) {
        const existing = await requiredBinding(parts[2]);
        await guard(req, existing.binding.projectId);
        if (parts.length === 3 && method === "GET") {
          json(res, 200, { binding: await publicBinding(existing) }); return true;
        }
        if (parts.length === 3 && method === "PUT") {
          const input = parse(bindingSchema, await body(req));
          const view = await repo.updateBinding(parts[2], { ...compact(input), overrides: compact(input.overrides) });
          await options.observations.record({ event: "binding.updated", bindingId: view.binding.id, runtimeId: view.runtime.id,
            projectId: view.binding.projectId, memberId: view.binding.memberId, configRevision: view.binding.revision });
          json(res, 200, { binding: await publicBinding(view) }); return true;
        }
        if (parts.length === 3 && method === "DELETE") {
          await repo.removeBinding(parts[2]); json(res, 204, null); return true;
        }
        if (parts.length === 4 && parts[3] === "actions" && method === "POST") {
          const input = parse(actionSchema, await body(req));
          const expectedConfig = input.runtimeRevision !== undefined && input.bindingRevision !== undefined
            ? { runtimeRevision: input.runtimeRevision, bindingRevision: input.bindingRevision } : undefined;
          const view = await repo.intent(parts[2], input.action, input.expectedIntentRevision, expectedConfig);
          await options.observations.record({ event: input.action === "stop" ? "stop_requested" : input.action === "retry" ? "retry_requested" : "start_requested",
            bindingId: view.binding.id, runtimeId: view.runtime.id, projectId: view.binding.projectId,
            memberId: view.binding.memberId, configRevision: view.binding.revision });
          options.supervisor.notify();
          json(res, 200, { binding: await publicBinding(view) }); return true;
        }
        if (parts.length === 4 && parts[3] === "observations" && method === "GET") {
          const [events, usage, health] = await Promise.all([options.observations.list({ bindingId: parts[2], limit: 100 }),
            options.observations.listUsage({ bindingId: parts[2] }), options.observations.health()]);
          json(res, 200, { events, usage, health }); return true;
        }
      }
      json(res, 404, { error: { code: "not_found", message: "未找到托管运行时操作。" } });
    } catch (error) {
      if (error instanceof ForbiddenError) json(res, 403, { error: { code: "forbidden", message: "仅本地管理者可管理托管运行时。" } });
      else if (error instanceof RepositoryError) {
        const status = error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "archived" ? 409 : error.code === "write_failed" ? 500 : 400;
        const reason = /^runtime_[a-z_]{1,60}$/.test(error.message) ? error.message : error.code;
        json(res, status, { error: { code: error.code, reason, message: status === 409
          ? "状态或版本已变化，请刷新；删除前须确认相关进程已停止。"
          : status === 400 ? "配置无效，请检查字段、工作目录和引用关系。"
            : status === 404 ? "对象不存在。" : "托管配置写入失败。" } });
      } else {
        options.logger.warn("runtime_api_failed");
        json(res, 500, { error: { code: "internal_error", message: "托管运行时操作失败。" } });
      }
    }
    return true;
  } };
}

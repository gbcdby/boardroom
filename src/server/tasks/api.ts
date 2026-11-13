import type { IncomingMessage, ServerResponse } from "node:http";
import type { DbDriver } from "../db/driver.ts";
import { createRepositories } from "../db/repositories.ts";
import { InvalidArgumentError, RepositoryError } from "../db/errors.ts";
import { TaskError } from "./errors.ts";
import type { Logger } from "../logger.ts";
import type { ActorResolution } from "../api.ts";
import type { Actor } from "../authz/authorize.ts";
import { ForbiddenError } from "../authz/authorize.ts";
import { ownerActor } from "../authz/actors.ts";
import { createTaskService, type TaskAccess } from "./service.ts";
import { notifyWorkEventCommit } from "./events.ts";
import { notifyResourceChange } from "../resource-changes.ts";
import { conditionalJson } from "../conditional-json.ts";
import {
  parseTaskInput, createTaskSchema, updateTaskSchema, transitionTaskSchema, commentTaskSchema,
  linkTaskMessageSchema, startTaskReviewSchema, beginTaskReviewSchema, submitReviewReportSchema,
  decideTaskReviewSchema, taskSettingsSchema, listTasksSchema,
} from "./schemas.ts";

const errorStatus: Record<string, number> = { not_found: 404, conflict: 409, archived: 409,
  invalid_reference: 400, invalid_argument: 400, write_failed: 500 };
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new InvalidArgumentError("任务写入需要 application/json。");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_500_000) throw new InvalidArgumentError("任务请求过大。");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InvalidArgumentError("任务请求不是有效 JSON。"); }
}
function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  return request.headers.origin === undefined || request.headers.origin === `http://${host}`;
}

export function createTaskApi(options: { db: DbDriver; logger: Logger;
  resolveActor?: (resolution: ActorResolution) => Promise<Actor | null>;
}): { handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> } {
  const log = options.logger.child({ component: "tasks-api" });
  const service = createTaskService({ repos: createRepositories(options.db),
    onWorkEvents: events => notifyWorkEventCommit(options.db, events),
    onResourceChanged: change => notifyResourceChange(options.db, change) });
  return { async handle(request, response, pathname) {
    if (!/^\/api\/projects\/[^/]+\/(tasks|task-settings)(\/|$)/.test(pathname)) return false;
    try {
      if (!sameOrigin(request)) { json(response, 403, { error: { code: "forbidden", message: "仅接受本地同源任务请求。" } }); return true; }
      let parts: string[];
      try { parts = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new InvalidArgumentError("任务路径编码无效。"); }
      const projectId = parts[2]!;
      const actor = options.resolveActor ? await options.resolveActor({ request, projectId }) : ownerActor(projectId);
      if (!actor) throw new ForbiddenError({ allowed: false, capability: "task:view", code: "forbidden", reason: "无法确定任务请求主体。" });
      const access: TaskAccess = { actor };
      const method = request.method ?? "GET";
      if (parts[3] === "task-settings" && parts.length === 4) {
        if (method === "GET") conditionalJson(request, response, { settings: await service.getSettings(access, projectId) });
        else if (method === "PUT") json(response, 200, { settings: await service.setSettings(access, projectId, parseTaskInput(taskSettingsSchema, await body(request))) });
        else json(response, 405, { error: { code: "method_not_allowed", message: "此接口支持 GET / PUT。" } });
        return true;
      }
      if (parts[3] !== "tasks") { json(response, 404, { error: { code: "not_found", message: "任务接口不存在。" } }); return true; }
      if (parts[3] === "tasks" && parts.length === 4) {
        if (method === "GET") {
          const query = Object.fromEntries(new URL(request.url ?? pathname, "http://127.0.0.1").searchParams);
          conditionalJson(request, response, { tasks: await service.list(access, projectId, parseTaskInput(listTasksSchema, query)) });
        } else if (method === "POST") json(response, 201, { task: await service.create(access, projectId, parseTaskInput(createTaskSchema, await body(request))) });
        else json(response, 405, { error: { code: "method_not_allowed", message: "此接口支持 GET / POST。" } });
        return true;
      }
      const taskId = parts[4]!;
      if (parts.length === 5) {
        if (method === "GET") conditionalJson(request, response, await service.get(access, projectId, taskId));
        else if (method === "PATCH") json(response, 200, { task: await service.update(access, projectId, taskId, parseTaskInput(updateTaskSchema, await body(request))) });
        else json(response, 405, { error: { code: "method_not_allowed", message: "此接口支持 GET / PATCH。" } });
        return true;
      }
      if (method === "POST" && parts.length === 6) {
        const input = await body(request);
        switch (parts[5]) {
          case "transitions": json(response, 200, { task: await service.transition(access, projectId, taskId, parseTaskInput(transitionTaskSchema, input)) }); return true;
          case "comments": json(response, 201, { comment: await service.comment(access, projectId, taskId, parseTaskInput(commentTaskSchema, input).body) }); return true;
          case "message-links": json(response, 200, { link: await service.linkMessage(access, projectId, taskId, parseTaskInput(linkTaskMessageSchema, input).messageId) }); return true;
          case "reviews": {
            const result = await service.startReview(access, projectId, taskId, parseTaskInput(startTaskReviewSchema, input));
            json(response, result.ready ? 201 : 400, result); return true;
          }
        }
      }
      if (method === "POST" && parts.length === 8 && parts[5] === "reviews") {
        const roundId = parts[6]!;
        const input = await body(request);
        switch (parts[7]) {
          case "begin": json(response, 200, { round: await service.beginReview(access, projectId, taskId, roundId, parseTaskInput(beginTaskReviewSchema, input)) }); return true;
          case "reports": json(response, 201, { report: await service.submitReport(access, projectId, taskId, roundId, parseTaskInput(submitReviewReportSchema, input)) }); return true;
          case "decision": json(response, 200, { task: await service.decideReview(access, projectId, taskId, roundId, parseTaskInput(decideTaskReviewSchema, input)) }); return true;
        }
      }
      json(response, 404, { error: { code: "not_found", message: "任务接口不存在。" } });
    } catch (error) {
      if (error instanceof ForbiddenError) json(response, 403, { error: { code: error.code, message: error.message } });
      else if (error instanceof RepositoryError) {
        const reason = "reason" in error && typeof error.reason === "string" ? error.reason : undefined;
        json(response, errorStatus[error.code] ?? 500, { error: { code: error.code, message: error.message, ...(reason ? { reason } : {}),
          ...(error instanceof TaskError ? { details: error.details } : {}) } });
      } else {
        log.error("task_request_failed", { error });
        json(response, 500, { error: { code: "internal_error", message: "任务操作失败，请重试。" } });
      }
    }
    return true;
  } };
}

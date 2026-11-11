import type { IncomingMessage, ServerResponse } from "node:http";
import type { EffectiveSettings } from "../../shared/settings.ts";
import type { ActorResolution } from "../api.ts";
import type { Actor } from "../authz/authorize.ts";
import { ownerActor } from "../authz/actors.ts";
import type { Logger } from "../logger.ts";

function localOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const match = host?.match(/^(127\.0\.0\.1|localhost)(?::([0-9]+))?$/);
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  return request.headers.origin === undefined || request.headers.origin === `http://${host}`;
}

/** 全局只读管理入口。主体来自可信装配层，不读取正文、query 或 header 自报身份。 */
export function createSettingsApi(options: {
  getSettings: () => EffectiveSettings | Promise<EffectiveSettings>;
  resolveActor?: (resolution: ActorResolution) => Promise<Actor | null>;
  logger?: Pick<Logger, "warn">;
}): { handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> } {
  return { async handle(request, response, pathname) {
    if (pathname !== "/api/settings") return false;
    const method = request.method ?? "GET";
    function json(status: number, body: unknown): void {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        ...(status === 405 ? { allow: "GET, HEAD" } : {}),
      });
      response.end(method === "HEAD" ? undefined : JSON.stringify(body));
    }
    try {
      if (!localOrigin(request)) {
        json(403, { error: { code: "forbidden", message: "仅接受本地同源设置请求。" } });
      } else if (method !== "GET" && method !== "HEAD") {
        json(405, { error: { code: "method_not_allowed", message: "设置仅支持只读查询。" } });
      } else {
        const actor = options.resolveActor ? await options.resolveActor({ request, projectId: null }) : ownerActor();
        if (!actor || actor.kind !== "human" || actor.role !== "owner" || actor.projectId !== null) {
          json(403, { error: { code: "forbidden", message: "仅本地所有者可以读取全局设置。" } });
        } else json(200, { settings: await options.getSettings() });
      }
    } catch {
      // 配置和原始异常可能含路径、连接串、凭据；日志与响应只保留稳定原因。
      options.logger?.warn("settings_read_failed");
      json(500, { error: { code: "internal_error", message: "设置读取失败，请重试。" } });
    }
    return true;
  } };
}

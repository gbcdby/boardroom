import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 调用方必须先完成当前授权和读取；ETag 覆盖实际快照，包括不推进编辑 CAS 的评论。 */
export function conditionalJson(request: IncomingMessage, response: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
  const tags = request.headers["if-none-match"]?.split(",").map(tag => tag.trim().replace(/^W\//, "")) ?? [];
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-cache", etag };
  if (tags.includes(etag) || tags.includes("*")) { response.writeHead(304, headers); response.end(); }
  else { response.writeHead(200, headers); response.end(json); }
}

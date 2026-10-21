import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticHandlerOptions {
  /** WebUI 构建产物目录（绝对路径）。 */
  readonly root: string;
  /** SPA 回落的入口文件，默认 index.html。 */
  readonly indexFile?: string;
}

/**
 * 创建 WebUI 静态资源处理器。
 *
 * - 命中真实文件时直接返回；
 * - 无扩展名的路径回落到 index.html（前端路由刷新可用）；
 * - 拒绝越出 root 的路径（`..`、编码后的分隔符）。
 */
export function createStaticHandler(options: StaticHandlerOptions) {
  const root = path.resolve(options.root);
  const indexFile = options.indexFile ?? "index.html";

  return async function handleStatic(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }

    const pathname = decodePathname(request.url ?? "/");
    if (pathname === null) {
      writeNotFound(response);
      return true;
    }

    const resolved = resolveWithinRoot(root, pathname);
    if (resolved === null) {
      writeNotFound(response);
      return true;
    }

    const file = await findFile(resolved);
    if (file !== null) {
      await sendFile(response, file, request.method === "HEAD");
      return true;
    }

    // 无扩展名（如 /projects/123）视为前端路由，回落 index.html。
    if (path.extname(pathname) === "") {
      const index = path.join(root, indexFile);
      if (await isFile(index)) {
        await sendFile(response, index, request.method === "HEAD");
        return true;
      }
    }

    return false;
  };
}

/** WebUI 构建产物是否就位（供健康检查展示）。 */
export async function isWebUiBuilt(root: string): Promise<boolean> {
  return isFile(path.join(root, "index.html"));
}

function decodePathname(url: string): string | null {
  const raw = url.split("?")[0] ?? "/";
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 归一化后仍必须位于 root 内，否则返回 null。 */
function resolveWithinRoot(root: string, pathname: string): string | null {
  if (pathname.includes("\0")) return null;
  const normalized = path.posix.normalize(pathname);
  if (normalized.includes("..")) return null;
  const resolved = path.resolve(root, `.${path.posix.sep}${normalized}`);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

async function findFile(candidate: string): Promise<string | null> {
  try {
    const stats = await stat(candidate);
    if (stats.isFile()) return candidate;
    if (stats.isDirectory()) {
      const index = path.join(candidate, "index.html");
      if (await isFile(index)) return index;
    }
    return null;
  } catch {
    return null;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function sendFile(response: ServerResponse, file: string, headOnly: boolean): Promise<void> {
  const stats = await stat(file);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": stats.size,
    "cache-control": "no-cache",
  });
  if (headOnly) {
    response.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(response);
  });
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not Found");
}

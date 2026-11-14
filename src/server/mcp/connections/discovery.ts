import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { createToolCatalogSnapshot, readMcpConnectionDeclaration, type ToolCatalogSnapshot } from "../capabilities/catalog.ts";
import { McpDiscoveryFailure, type DiscoveryCleanup, type DiscoveryFailureState } from "./errors.ts";

export interface McpDiscoveryResult {
  readonly snapshot: ToolCatalogSnapshot;
  readonly protocolVersion: string;
  readonly pages: number;
  readonly cleanup: DiscoveryCleanup;
}
export interface McpDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}
// SDK schema 校验协议形状；保留原 JSON，避免其 record 转换删除 __proto__ 等合法 schema 键。
const toolsResult = z.custom<ListToolsResult>(value => ListToolsResultSchema.safeParse(value).success);

/** 当前精确支持无凭据 Streamable HTTP；没有通用 stdio/credential 授权边界就拒绝执行。
 * 每次仅 initialize / tools/list；不装载 schema 验证器，不响应上游任意执行建议。
 */
export async function discoverMcpCatalog(input: unknown, options: McpDiscoveryOptions = {}): Promise<McpDiscoveryResult> {
  const connection = readMcpConnectionDeclaration(input);
  if (!connection.enabled) throw new McpDiscoveryFailure("connection_disabled", "blocked");
  if (connection.transport.credentialRef !== undefined) throw new McpDiscoveryFailure("credential_unavailable", "blocked");
  if (connection.transport.type !== "streamable-http") throw new McpDiscoveryFailure("launch_unavailable", "blocked");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) throw new McpDiscoveryFailure("discovery_timeout_invalid", "blocked");
  if (options.signal?.aborted) throw new McpDiscoveryFailure("discovery_cancelled", "cancelled");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const operation = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const endpoint = new URL(connection.transport.endpoint);
  let bytes = 0, cleanup: DiscoveryCleanup = "closed", phase: "connect" | "list" = "connect";
  let closing = false, terminationUnsupported = false;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { redirect: "error", credentials: "omit" },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      const target = new URL(url);
      const method = init?.method ?? "GET";
      if (target.href !== endpoint.href || !["GET", "POST", "DELETE"].includes(method)) throw new Error("discovery_target_changed");
      const signal = closing && method === "DELETE" ? AbortSignal.timeout(2000)
        : AbortSignal.any([operation, ...(init?.signal ? [init.signal] : [])]);
      const response = await fetch(target, { ...init, signal, redirect: "error", credentials: "omit" });
      if (method === "DELETE" && response.status === 405) terminationUnsupported = true;
      if (!response.body || method === "DELETE") return response;
      const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error("discovery_response_limit");
        controller.enqueue(chunk);
      } }));
      return new Response(limited, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  // Empty advertised capabilities reject upstream sampling/elicitation requests. No automatic list-change handler.
  const client = new Client({ name: "boardroom-catalog-discovery", version: "1" }, { capabilities: {} });
  client.onerror = () => { /* Errors become the stable failure below; never log upstream bodies. */ };
  let result: Omit<McpDiscoveryResult, "cleanup"> | undefined;
  let failure: { code: string; state: DiscoveryFailureState } | undefined;
  try {
    // SDK 的 sessionId getter 返回 undefined，与其 Transport 可选属性在 exactOptionalPropertyTypes 下不兼容。
    await client.connect(transport as Transport, { signal: operation, timeout: timeoutMs });
    if (!transport.protocolVersion || !client.getServerCapabilities()?.tools) {
      throw new McpDiscoveryFailure("discovery_capability_missing", "discovery_failed");
    }
    phase = "list";
    const tools: unknown[] = [], seen = new Set<string>();
    let cursor: string | undefined, pages = 0;
    do {
      if (++pages > 64) throw new McpDiscoveryFailure("discovery_page_limit", "discovery_failed");
      // Client.listTools caches/compiles output schemas for actual invocation. This boundary never invokes tools.
      const page = await client.request({ method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
        toolsResult, { signal: operation, timeout: timeoutMs });
      for (const tool of page.tools) {
        tools.push({ name: tool.name, inputSchema: tool.inputSchema,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        });
      }
      if (tools.length > 4096) throw new McpDiscoveryFailure("discovery_tool_limit", "discovery_failed");
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (!cursor || cursor.length > 8192 || seen.has(cursor)) throw new McpDiscoveryFailure("discovery_cursor_invalid", "discovery_failed");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    operation.throwIfAborted();
    const snapshot = createToolCatalogSnapshot({ connection, observedAt: (options.now ?? (() => new Date()))().toISOString(),
      discovery: { status: "available", tools } });
    result = { snapshot, protocolVersion: transport.protocolVersion, pages };
  } catch (error) {
    if (options.signal?.aborted) failure = { code: "discovery_cancelled", state: "cancelled" };
    else if (deadline.signal.aborted) failure = { code: "discovery_timed_out", state: "timed_out" };
    else if (error instanceof McpDiscoveryFailure) failure = { code: error.code, state: error.state };
    else failure = { code: phase === "connect" ? "connection_failed" : "discovery_invalid_response", state: phase === "connect" ? "connection_failed" : "discovery_failed" };
  } finally {
    clearTimeout(timer); closing = true;
    // Cleanup is scoped to the session obtained by this transport; it uses its own bounded deadline even after cancellation.
    if (transport.sessionId !== undefined) {
      try { await transport.terminateSession(); if (terminationUnsupported) cleanup = "remote_unsupported"; }
      catch { cleanup = "remote_unknown"; }
    }
    await client.close().catch(() => { cleanup = "remote_unknown"; });
  }
  if (failure) throw new McpDiscoveryFailure(failure.code, failure.state, cleanup);
  return { ...result!, cleanup };
}

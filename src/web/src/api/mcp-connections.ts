import { z } from "zod";

// Browser-owned DTOs. No server runtime, endpoint or credential projection is imported.
const id = z.string().min(1).max(256).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
const projection = z.object({ connectionId: id, revision, enabled: z.boolean(),
  transport: z.enum(["streamable-http", "stdio"]), configurationDigest: digest, credentialConfigured: z.boolean() }).strict();
const receiptSchema = projection.extend({ name: z.string().min(1).max(128), createdAt: date, updatedAt: date }).strict();
const schemaObject = z.custom<Record<string, unknown>>(v => v !== null && typeof v === "object" && !Array.isArray(v));
const toolSchema = z.object({ ref: z.object({ connectionId: id, connectionRevision: revision, name: id, schemaDigest: digest }).strict(),
  toolKey: z.string().regex(/^tool_[a-f0-9]{64}$/), title: z.string().max(4096).optional(), description: z.string().max(65_536).optional(),
  inputSchema: schemaObject, outputSchema: schemaObject.optional(), annotations: z.object({ title: z.string().max(4096).optional(),
    readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional() }).strict().optional() }).strict();
const snapshotSchema = z.object({ kind: z.literal("tool-catalog-snapshot"), formatVersion: z.literal(1), connection: projection,
  observedAt: date, discoveryStatus: z.enum(["available", "not_discovered", "connection_failed", "discovery_failed"]),
  tools: z.array(toolSchema).max(4096), snapshotDigest: digest }).strict().refine(s => {
  const names = new Set(s.tools.map(t => t.ref.name)), keys = new Set(s.tools.map(t => t.toolKey));
  return names.size === s.tools.length && keys.size === s.tools.length
    && (s.discoveryStatus === "available" || s.tools.length === 0)
    && s.tools.every(t => t.ref.connectionId === s.connection.connectionId && t.ref.connectionRevision === s.connection.revision);
});
const attemptSchema = z.object({ attemptId: id, connectionId: id, connectionRevision: revision, sequence: revision,
  status: z.enum(["running", "cancel_requested", "succeeded", "blocked", "connection_failed", "discovery_failed", "cancelled", "timed_out", "superseded"]),
  errorCode: z.string().max(128).nullable(), snapshotId: digest.nullable(),
  cleanup: z.enum(["pending", "not_opened", "closed", "remote_unsupported", "remote_unknown"]),
  protocolVersion: z.string().max(64).nullable(), pages: z.number().int().nonnegative().nullable(), createdAt: date, finishedAt: date.nullable() }).strict();
const viewSchema = z.object({ connection: receiptSchema, state: z.enum(["registered", "discovered", "disabled"]),
  modelState: z.literal("not_provided"), currentSnapshot: snapshotSchema.nullable(), lastDiscovery: attemptSchema.nullable() }).strict().refine(v =>
  (!v.currentSnapshot || v.currentSnapshot.connection.connectionId === v.connection.connectionId
    && v.currentSnapshot.connection.revision === v.connection.revision && v.currentSnapshot.connection.configurationDigest === v.connection.configurationDigest)
  && (!v.lastDiscovery || v.lastDiscovery.connectionId === v.connection.connectionId && v.lastDiscovery.connectionRevision <= v.connection.revision)
  && v.state === (!v.connection.enabled ? "disabled" : v.currentSnapshot ? "discovered" : "registered"));
const configurationSchema = z.object({ connectionId: id, revision, enabled: z.boolean(),
  transport: z.object({ type: z.literal("streamable-http"), endpoint: z.string().min(1).max(8192) }).strict() }).strict();

export type McpConnectionReceipt = z.infer<typeof receiptSchema>;
export type McpConnectionView = z.infer<typeof viewSchema>;
export type McpCatalogSnapshot = z.infer<typeof snapshotSchema>;
export type McpCatalogTool = z.infer<typeof toolSchema>;
export type McpDiscoveryAttempt = z.infer<typeof attemptSchema>;
export type McpConfiguration = z.infer<typeof configurationSchema>;
export interface McpSaveInput { readonly requestId: string; readonly name: string; readonly enabled: boolean;
  readonly expectedRevision?: number; readonly transport: { readonly type: "streamable-http"; readonly endpoint: string } }
export interface McpDiscoverInput { readonly requestId: string; readonly expectedRevision: number }

export class McpRequestError extends Error {
  readonly status: number; readonly code: string; readonly uncertain: boolean;
  constructor(message: string, status = 0, code = "unavailable", uncertain = false) {
    super(message); this.name = "McpRequestError"; this.status = status; this.code = code; this.uncertain = uncertain;
  }
}
export function isEditable(connection: McpConnectionReceipt): boolean {
  return connection.transport === "streamable-http" && !connection.credentialConfigured;
}
export function isAttemptPending(attempt: McpDiscoveryAttempt): boolean {
  return attempt.status === "running" || attempt.status === "cancel_requested";
}
const path = (connectionId: string) => `/api/mcp/connections/${encodeURIComponent(connectionId)}`;

export function createMcpCatalogApi(fetcher: typeof fetch = (...args) => fetch(...args), readTimeoutMs = 10_000) {
  async function call<T>(method: string, url: string, schema: z.ZodType<T>, input?: unknown, signal?: AbortSignal): Promise<T> {
    const write = method !== "GET", controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new McpRequestError(write ? "请求已停止，结果仍待核实。" : "读取已停止。", 0, "aborted", write));
        combined.addEventListener("abort", onAbort, { once: true });
        if (combined.aborted) onAbort();
        timer = setTimeout(() => {
          reject(new McpRequestError(write ? "等待回执超时，结果仍待核实。" : "读取超时，请重新读取。", 0, "timeout", write));
          controller.abort();
        }, write ? 35_000 : readTimeoutMs);
      });
      const transport = async () => {
        const response = await fetcher(url, { method, cache: "no-store", signal: combined,
          headers: { accept: "application/json", ...(write ? { "content-type": "application/json" } : {}) },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
        let value: unknown;
        try { value = await response.json(); } catch { value = undefined; }
        if (!response.ok) {
          const raw = (value as { error?: { code?: unknown } } | undefined)?.error?.code;
          const code = typeof raw === "string" && /^[a-z0-9_]{1,128}$/.test(raw) ? raw : "request_failed";
          const message = response.status === 403 ? "当前没有读取或管理全局 MCP 连接的权限。"
            : response.status === 404 ? "未找到这个连接、发现记录或目录。"
            : response.status === 409 ? "连接已变化或请求身份冲突；请核对最新版本，原编辑稿已保留。"
            : response.status >= 500 ? "服务暂时无法确认本次请求。" : "请求未被接受，请检查输入与当前连接状态。";
          const unresolved = ["mcp_request_conflict", "mcp_request_incomplete", "mcp_discovery_result_not_persisted"].includes(code);
          throw new McpRequestError(message, response.status, code, write && (response.status >= 500 || unresolved));
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new McpRequestError(write ? "收到无法核实的回执，请保留原请求继续核查。" : "读取结果不完整，请重新读取。", 200, "invalid_response", write);
        return parsed.data;
      };
      return await Promise.race([transport(), deadline]);
    } catch (error) {
      if (error instanceof McpRequestError) throw error;
      throw new McpRequestError(write ? "未收到可靠回执，结果仍待核实。" : "暂时无法读取，请检查连接后重试。", 0, "network_error", write);
    } finally { if (timer !== undefined) clearTimeout(timer); if (onAbort) combined.removeEventListener("abort", onAbort); }
  }
  return {
    async list(signal?: AbortSignal) {
      const result = await call("GET", "/api/mcp/connections", z.object({ connections: z.array(viewSchema) }).strict()
        .refine(x => new Set(x.connections.map(v => v.connection.connectionId)).size === x.connections.length), undefined, signal);
      return result.connections;
    },
    async get(id: string, signal?: AbortSignal) { return call("GET", path(id), viewSchema.refine(v => v.connection.connectionId === id), undefined, signal); },
    async configuration(id: string, revision: number, signal?: AbortSignal) {
      return (await call("GET", `${path(id)}/revisions/${revision}/configuration`, z.object({ configuration: configurationSchema.refine(c => c.connectionId === id && c.revision === revision) }).strict(), undefined, signal)).configuration;
    },
    async save(id: string | null, input: McpSaveInput, signal?: AbortSignal) {
      return (await call(id === null ? "POST" : "PUT", id === null ? "/api/mcp/connections" : path(id), z.object({ connection: receiptSchema.refine(c =>
        (id === null || c.connectionId === id) && c.revision === (input.expectedRevision ?? 0) + 1 && c.name === input.name
        && c.enabled === input.enabled && isEditable(c)) }).strict(), input, signal)).connection;
    },
    async discover(id: string, input: McpDiscoverInput, signal?: AbortSignal) {
      return (await call("POST", `${path(id)}/discover`, z.object({ attempt: attemptSchema.refine(a => a.connectionId === id && a.connectionRevision === input.expectedRevision) }).strict(), input, signal)).attempt;
    },
    async attempt(id: string, attemptId: string, signal?: AbortSignal) {
      return (await call("GET", `${path(id)}/discoveries/${encodeURIComponent(attemptId)}`, z.object({ attempt: attemptSchema.refine(a => a.connectionId === id && a.attemptId === attemptId) }).strict(), undefined, signal)).attempt;
    },
    async cancel(id: string, attemptId: string, signal?: AbortSignal) {
      return (await call("POST", `${path(id)}/discoveries/${encodeURIComponent(attemptId)}/cancel`, z.object({ attempt: attemptSchema.refine(a => a.connectionId === id && a.attemptId === attemptId) }).strict(), {}, signal)).attempt;
    },
    async snapshot(id: string, digest: string, signal?: AbortSignal) {
      return (await call("GET", `${path(id)}/catalogs/${encodeURIComponent(digest)}`, z.object({ snapshot: snapshotSchema.refine(s => s.connection.connectionId === id && s.snapshotDigest === digest) }).strict(), undefined, signal)).snapshot;
    },
  };
}
export type McpCatalogApi = ReturnType<typeof createMcpCatalogApi>;

import { z } from "zod";
import { CapabilityInputError, cloneJson, digestJson, freezeData } from "./json.ts";
import type { JsonObject, ReadonlyJsonObject } from "./json.ts";

export const opaqueIdSchema = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const credentialRefSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_./:-]+$/);
const endpointSchema = z.string().min(1).max(8192).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const connectionDeclarationSchema = z.object({
  connectionId: opaqueIdSchema,
  revision: revisionSchema,
  enabled: z.boolean(),
  transport: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("streamable-http"), endpoint: endpointSchema,
      credentialRef: credentialRefSchema.optional(),
    }).strict(),
    z.object({
      type: z.literal("stdio"), command: z.string().min(1).max(4096).refine((value) => !value.includes("\0")),
      args: z.array(z.string().max(4096).refine((value) => !value.includes("\0"))).max(128),
      credentialRef: credentialRefSchema.optional(),
    }).strict(),
  ]),
}).strict();
export type McpConnectionDeclaration = Readonly<z.infer<typeof connectionDeclarationSchema>>;

/** 仅供可信配置持久化/协议边界消费；普通目录仍使用脱敏 ConnectionProjection。 */
export function readMcpConnectionDeclaration(input: unknown): McpConnectionDeclaration {
  return freezeData(parseData(connectionDeclarationSchema, input, "invalid_connection"));
}

export const connectionProjectionSchema = z.object({
  connectionId: opaqueIdSchema, revision: revisionSchema, enabled: z.boolean(),
  transport: z.enum(["stdio", "streamable-http"]), configurationDigest: digestSchema,
  credentialConfigured: z.boolean(),
}).strict();
export type ConnectionProjection = Readonly<z.infer<typeof connectionProjectionSchema>>;

export function parseData<S extends z.ZodTypeAny>(schema: S, input: unknown, code: string): z.infer<S> {
  const result = schema.safeParse(cloneJson(input));
  if (!result.success) throw new CapabilityInputError(code);
  return result.data;
}

/** 只检查声明并返回不含端点/argv/凭据引用的投影，不建立连接或执行命令。 */
export function inspectMcpConnection(input: unknown): ConnectionProjection {
  const connection = readMcpConnectionDeclaration(input);
  return freezeData({
    connectionId: connection.connectionId, revision: connection.revision, enabled: connection.enabled,
    transport: connection.transport.type, configurationDigest: digestJson(connection),
    credentialConfigured: connection.transport.credentialRef !== undefined,
  });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// cloneJson 已检查全部值；此处不使用会剔除 __proto__ key 的 record 转换。
const toolSchemaObject = z.custom<JsonObject>((schema) =>
  isObject(schema) && schema.type === "object"
  && (schema.properties === undefined || isObject(schema.properties))
  && (schema.required === undefined || Array.isArray(schema.required)
    && schema.required.every((key) => typeof key === "string"))
);
const annotationsSchema = z.object({
  title: z.string().max(4096).optional(),
  readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional(),
}).strict();
const definitionSchema = z.object({
  name: opaqueIdSchema,
  title: z.string().max(4096).optional(),
  description: z.string().max(65_536).optional(),
  inputSchema: toolSchemaObject,
  outputSchema: toolSchemaObject.optional(),
  annotations: annotationsSchema.optional(),
}).strict();
export const toolRefSchema = z.object({
  connectionId: opaqueIdSchema, connectionRevision: revisionSchema,
  name: opaqueIdSchema, schemaDigest: digestSchema,
}).strict();
export type ToolRef = Readonly<z.infer<typeof toolRefSchema>>;
const entrySchema = definitionSchema.omit({ name: true }).extend({
  ref: toolRefSchema, toolKey: z.string().regex(/^tool_[a-f0-9]{64}$/),
}).strict();
export interface CatalogTool {
  readonly ref: ToolRef;
  readonly toolKey: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema: ReadonlyJsonObject;
  readonly outputSchema?: ReadonlyJsonObject | undefined;
  readonly annotations?: Readonly<z.infer<typeof annotationsSchema>> | undefined;
}
const failureStatusSchema = z.enum(["not_discovered", "connection_failed", "discovery_failed"]);
const observedAtSchema = z.string().datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value))).transform((value) => new Date(value).toISOString());
const createInputSchema = z.object({
  connection: connectionDeclarationSchema, observedAt: observedAtSchema,
  discovery: z.union([
    z.object({ status: z.literal("available"), tools: z.array(definitionSchema).max(4096) }).strict(),
    z.object({ status: failureStatusSchema }).strict(),
  ]),
}).strict();
const snapshotSchema = z.object({
  kind: z.literal("tool-catalog-snapshot"), formatVersion: z.literal(1),
  connection: connectionProjectionSchema, observedAt: observedAtSchema,
  discoveryStatus: z.enum(["available", "not_discovered", "connection_failed", "discovery_failed"]),
  tools: z.array(entrySchema).max(4096), snapshotDigest: digestSchema,
}).strict();
export interface ToolCatalogSnapshot {
  readonly kind: "tool-catalog-snapshot";
  readonly formatVersion: 1;
  readonly connection: ConnectionProjection;
  readonly observedAt: string;
  readonly discoveryStatus: "available" | "not_discovered" | "connection_failed" | "discovery_failed";
  readonly tools: readonly CatalogTool[];
  readonly snapshotDigest: string;
}

export function toolRefKey(ref: ToolRef): string {
  // 结构化元组避免连接名/工具名中的分隔符造成命名空间碰撞。
  return "tool_" + digestJson([ref.connectionId, ref.connectionRevision, ref.name, ref.schemaDigest]);
}

function schemaDigest(tool: { inputSchema: unknown; outputSchema?: unknown }): string {
  return digestJson({
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  });
}

export function createToolCatalogSnapshot(input: unknown): ToolCatalogSnapshot {
  const parsed = parseData(createInputSchema, input, "invalid_catalog");
  const connection = inspectMcpConnection(parsed.connection);
  const names = new Set<string>();
  const tools: z.infer<typeof entrySchema>[] = [];
  if (parsed.discovery.status === "available") {
    for (const definition of parsed.discovery.tools) {
      if (names.has(definition.name)) throw new CapabilityInputError("duplicate_tool");
      names.add(definition.name);
      const { name, ...metadata } = definition;
      const ref = {
        connectionId: connection.connectionId, connectionRevision: connection.revision,
        name, schemaDigest: schemaDigest(definition),
      };
      tools.push({ ...metadata, ref, toolKey: toolRefKey(ref) });
    }
  }
  tools.sort((a, b) => a.ref.name < b.ref.name ? -1 : a.ref.name > b.ref.name ? 1 : 0);
  const body = {
    kind: "tool-catalog-snapshot" as const, formatVersion: 1 as const,
    connection, observedAt: parsed.observedAt, discoveryStatus: parsed.discovery.status, tools,
  };
  return freezeData({ ...body, snapshotDigest: digestJson(body) });
}

/** 重新验证序列化快照的内容完整性；摘要不证明来源可信或授予权限。 */
export function readToolCatalogSnapshot(input: unknown): ToolCatalogSnapshot {
  const snapshot = parseData(snapshotSchema, input, "invalid_snapshot");
  const names = new Set<string>();
  for (const tool of snapshot.tools) {
    if (names.has(tool.ref.name)) throw new CapabilityInputError("duplicate_tool");
    names.add(tool.ref.name);
    if (tool.ref.connectionId !== snapshot.connection.connectionId
      || tool.ref.connectionRevision !== snapshot.connection.revision
      || tool.ref.schemaDigest !== schemaDigest(tool) || tool.toolKey !== toolRefKey(tool.ref)) {
      throw new CapabilityInputError("snapshot_integrity_mismatch");
    }
  }
  if (snapshot.discoveryStatus !== "available" && snapshot.tools.length > 0) {
    throw new CapabilityInputError("snapshot_integrity_mismatch");
  }
  const { snapshotDigest, ...body } = snapshot;
  if (snapshotDigest !== digestJson(body)) throw new CapabilityInputError("snapshot_integrity_mismatch");
  return freezeData(snapshot);
}

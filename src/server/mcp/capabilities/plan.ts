import { z } from "zod";
import {
  connectionProjectionSchema, opaqueIdSchema, parseData, readToolCatalogSnapshot,
  revisionSchema, toolRefKey, toolRefSchema,
} from "./catalog.ts";
import type { CatalogTool, ToolCatalogSnapshot, ToolRef } from "./catalog.ts";
import { CapabilityInputError, canonicalJson, digestJson, freezeData } from "./json.ts";
import type { DeepReadonly } from "./json.ts";

/**
 * S7 纯预览所需的群实例投影。由可信控制层从 S2 读取后构造，
 * 不是 S2 的身份 DTO，不建立 Profile/Binding，也不接受模型自报的身份。
 */
const scopeSchema = z.object({
  projectId: opaqueIdSchema, groupId: opaqueIdSchema, groupBindingId: opaqueIdSchema,
  instanceId: opaqueIdSchema, instanceGeneration: revisionSchema,
  conversationId: opaqueIdSchema, conversationEpoch: revisionSchema,
  configurationRevision: revisionSchema, authorizationEpoch: revisionSchema,
}).strict();
export type ToolPlanScope = DeepReadonly<z.infer<typeof scopeSchema>>;
const selectionSchema = z.object({
  toolRef: toolRefSchema,
  mode: z.enum(["resident", "on-demand"]),
  requirement: z.enum(["required", "optional"]),
  sourceRef: opaqueIdSchema,
}).strict();
export type ResolvedToolSelection = DeepReadonly<z.infer<typeof selectionSchema>>;
const currentConnectionSchema = connectionProjectionSchema.extend({ authorized: z.boolean() }).strict();
const requestSchema = z.object({
  scope: scopeSchema,
  catalogs: z.array(z.unknown()).max(128),
  selections: z.array(selectionSchema).max(4096),
  availability: z.object({
    scope: scopeSchema,
    connections: z.array(currentConnectionSchema).max(128),
    allowedTools: z.array(toolRefSchema).max(16_384),
  }).strict(),
}).strict();

export type UnavailableReason =
  | "not_configured" | "connection_disabled" | "not_authorized"
  | "connection_revision_mismatch" | "connection_configuration_mismatch"
  | "catalog_unavailable" | "not_discovered" | "connection_failed" | "discovery_failed"
  | "tool_missing" | "schema_mismatch";
export interface UnavailableSelection {
  readonly toolRef: ToolRef;
  readonly mode: "resident" | "on-demand";
  readonly requirement: "required" | "optional";
  readonly sourceRef: string;
  readonly reason: UnavailableReason;
}
type SelectedDefinition = CatalogTool & {
  readonly sourceRef: string;
  readonly requirement: "required" | "optional";
  readonly selectionReason: "explicit-selection";
};
type SelectedSummary = Pick<CatalogTool, "ref" | "toolKey" | "title" | "description"> & {
  readonly sourceRef: string;
  readonly requirement: "required" | "optional";
  readonly selectionReason: "explicit-selection";
};
export interface ToolPlanPreview {
  readonly kind: "tool-plan-preview";
  readonly formatVersion: 1;
  readonly mode: "observation";
  readonly executionAdmission: "not-issued";
  readonly scope: ToolPlanScope;
  readonly scopeDigest: string;
  readonly planDigest: string;
  readonly catalogRefs: readonly {
    readonly connectionId: string; readonly connectionRevision: number; readonly snapshotDigest: string;
  }[];
  readonly initialTools: readonly SelectedDefinition[];
  readonly onDemandTools: readonly SelectedSummary[];
  readonly unavailable: readonly UnavailableSelection[];
  readonly selectionCompleteness: "complete" | "required-missing";
  readonly missingRequiredCount: number;
  readonly missingOptionalCount: number;
  readonly optionalDegradation: "none" | "requires-explicit-policy";
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const selectedNameKey = (ref: ToolRef): string => canonicalJson([ref.connectionId, ref.name]);

function buildPlan(input: unknown): { plan: ToolPlanPreview; schemas: ReadonlyMap<string, SelectedDefinition> } {
  const parsed = parseData(requestSchema, input, "invalid_plan_input");
  if (canonicalJson(parsed.scope) !== canonicalJson(parsed.availability.scope)) {
    throw new CapabilityInputError("availability_scope_mismatch");
  }
  const catalogs = new Map<string, ToolCatalogSnapshot>();
  for (const raw of parsed.catalogs) {
    const catalog = readToolCatalogSnapshot(raw);
    if (catalogs.has(catalog.connection.connectionId)) throw new CapabilityInputError("duplicate_catalog");
    catalogs.set(catalog.connection.connectionId, catalog);
  }
  const connections = new Map<string, z.infer<typeof currentConnectionSchema>>();
  for (const connection of parsed.availability.connections) {
    if (connections.has(connection.connectionId)) throw new CapabilityInputError("duplicate_connection");
    connections.set(connection.connectionId, connection);
  }
  const allowed = new Set<string>();
  for (const ref of parsed.availability.allowedTools) {
    const key = toolRefKey(ref);
    if (allowed.has(key)) throw new CapabilityInputError("duplicate_allowance");
    allowed.add(key);
  }
  const selections = [...parsed.selections].sort((a, b) => compare(selectedNameKey(a.toolRef), selectedNameKey(b.toolRef)));
  const seen = new Set<string>();
  const initialTools: SelectedDefinition[] = [];
  const onDemandTools: SelectedSummary[] = [];
  const unavailable: UnavailableSelection[] = [];
  const schemas = new Map<string, SelectedDefinition>();
  const usedCatalogs = new Map<string, ToolCatalogSnapshot>();
  for (const selection of selections) {
    const nameKey = selectedNameKey(selection.toolRef);
    if (seen.has(nameKey)) throw new CapabilityInputError("duplicate_selection");
    seen.add(nameKey);
    const ref = selection.toolRef;
    const current = connections.get(ref.connectionId);
    const catalog = catalogs.get(ref.connectionId);
    let reason: UnavailableReason | undefined;
    if (!current) reason = "not_configured";
    else if (!current.enabled) reason = "connection_disabled";
    else if (!current.authorized) reason = "not_authorized";
    else if (current.revision !== ref.connectionRevision) reason = "connection_revision_mismatch";
    // 在选入模型投影前裁剪明确许可；角色/描述/hint 不在这个判断中。
    else if (!allowed.has(toolRefKey(ref))) reason = "not_authorized";
    else if (!catalog) reason = "catalog_unavailable";
    else if (catalog.connection.revision !== current.revision) reason = "connection_revision_mismatch";
    else if (catalog.connection.configurationDigest !== current.configurationDigest
      || catalog.connection.enabled !== current.enabled
      || catalog.connection.transport !== current.transport
      || catalog.connection.credentialConfigured !== current.credentialConfigured) {
      reason = "connection_configuration_mismatch";
    } else if (catalog.discoveryStatus !== "available") reason = catalog.discoveryStatus;
    let definition: CatalogTool | undefined;
    if (!reason && catalog) {
      definition = catalog.tools.find((entry) => entry.ref.name === ref.name);
      if (!definition) reason = "tool_missing";
      else if (definition.ref.schemaDigest !== ref.schemaDigest) reason = "schema_mismatch";
    }
    if (reason) {
      unavailable.push({ ...selection, reason });
      continue;
    }
    // 只有已选择、已许可、版本吻合的定义才能进入模型投影。
    if (!definition || !catalog) throw new CapabilityInputError("invalid_plan_input");
    const selected: SelectedDefinition = {
      ...definition, sourceRef: selection.sourceRef, requirement: selection.requirement,
      selectionReason: "explicit-selection",
    };
    schemas.set(definition.toolKey, selected);
    usedCatalogs.set(catalog.connection.connectionId, catalog);
    if (selection.mode === "resident") initialTools.push(selected);
    else onDemandTools.push({
      ref: definition.ref, toolKey: definition.toolKey,
      ...(definition.title === undefined ? {} : { title: definition.title }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
      sourceRef: selection.sourceRef, requirement: selection.requirement, selectionReason: "explicit-selection",
    });
  }
  const missingRequiredCount = unavailable.filter((selection) => selection.requirement === "required").length;
  const missingOptionalCount = unavailable.length - missingRequiredCount;
  // 绑定完整的观察输入版本，但不把未授权目录正文放入返回对象。
  const planDigest = digestJson({
    formatVersion: 1, scope: parsed.scope, selections,
    catalogs: [...catalogs.values()].map((catalog) => ({
      connectionId: catalog.connection.connectionId, snapshotDigest: catalog.snapshotDigest,
    })).sort((a, b) => compare(a.connectionId, b.connectionId)),
    connections: [...connections.values()].sort((a, b) => compare(a.connectionId, b.connectionId)),
    allowedTools: [...allowed].sort(),
  });
  const plan: ToolPlanPreview = freezeData({
    kind: "tool-plan-preview", formatVersion: 1, mode: "observation", executionAdmission: "not-issued",
    scope: parsed.scope, scopeDigest: digestJson(parsed.scope), planDigest,
    catalogRefs: [...usedCatalogs.values()].sort((a, b) => compare(a.connection.connectionId, b.connection.connectionId))
      .map((catalog) => ({
        connectionId: catalog.connection.connectionId, connectionRevision: catalog.connection.revision,
        snapshotDigest: catalog.snapshotDigest,
      })),
    initialTools, onDemandTools, unavailable,
    selectionCompleteness: missingRequiredCount === 0 ? "complete" : "required-missing",
    missingRequiredCount, missingOptionalCount,
    optionalDegradation: missingOptionalCount === 0 ? "none" : "requires-explicit-policy",
  });
  return { plan, schemas };
}

/**
 * 仅供可信控制层的纯观察函数。availability 必须来自当前 S1/S2/S3 事实；
 * 参数不是凭证，返回值不签发执行权，不表示已提供/已加载或真实调用成功。
 */
export function resolveToolPlan(input: unknown): ToolPlanPreview {
  return buildPlan(input).plan;
}

/** 按需 schema 的纯投影；每次重新解析当前范围，不能凭旧 plan/key 取回已撤项。 */
export function previewToolSchema(input: unknown, requestedRef: unknown): Readonly<{
  kind: "tool-schema-preview"; mode: "observation"; executionAdmission: "not-issued";
  scopeDigest: string; planDigest: string; tool: SelectedDefinition;
}> | null {
  const ref = parseData(toolRefSchema, requestedRef, "invalid_tool_ref");
  const { plan, schemas } = buildPlan(input);
  const tool = schemas.get(toolRefKey(ref));
  if (!tool) return null;
  return freezeData({
    kind: "tool-schema-preview", mode: "observation", executionAdmission: "not-issued",
    scopeDigest: plan.scopeDigest, planDigest: plan.planDigest, tool,
  });
}

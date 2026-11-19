import { z } from "zod";
import { connectionProjectionSchema, inspectMcpConnectionOwnedValue, readToolCatalogSnapshot } from "../../mcp/capabilities/catalog.ts";
import type { ConnectionProjection, ToolCatalogSnapshot } from "../../mcp/capabilities/catalog.ts";
import { capabilityInputErrorCode } from "../../mcp/capabilities/json.ts";
import { EContext, digestValue } from "./m2-p0-e-context.ts";
import type { P0Row } from "./m2-p0.ts";
const DECLARATION = "PC1B-MCP01", CATALOG = "PC1B-MCP02", MUTATION = "PC1B-MCP03";
const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
// Stored flat receipt, not the mutation input and not an invented nested projection.
const receiptSchema = connectionProjectionSchema.extend({ name: z.string(), createdAt: z.string(), updatedAt: z.string() }).strict();
const projectionFields = ["connectionId", "revision", "enabled", "transport", "configurationDigest", "credentialConfigured"] as const;

function originalError(ctx: EContext, error: unknown, row: P0Row, rule: typeof DECLARATION | typeof CATALOG, column: string): never {
  const code = capabilityInputErrorCode(error);
  if (code === "json_limit_exceeded") ctx.fail(row, rule, "budget-exceeded", column, "resource_limit");
  if (code === "snapshot_integrity_mismatch" || code === "duplicate_tool") ctx.fail(row, rule, "immutable-history-mismatch", column);
  if (code === "invalid_json" || code === "invalid_connection" || code === "invalid_snapshot") ctx.fail(row, rule, "format-mismatch", column, "semantic_unsupported");
  throw error;
}
function sameProjection(ctx: EContext, actual: ConnectionProjection, expected: ConnectionProjection, row: P0Row,
  rule: typeof CATALOG | typeof MUTATION, column: string, target: P0Row): void {
  ctx.charge(projectionFields.length);
  for (const field of projectionFields) ctx.equal(actual[field], expected[field], row, rule, column, "identity-mismatch", target);
}

export function checkP0Mcp(ctx: EContext): void {
  const connections = ctx.index("mcp_connections", ["id"], DECLARATION);
  const versions = ctx.index("mcp_connection_versions", ["connection_id", ["revision", "integer"]], DECLARATION);
  const snapshots = ctx.index("mcp_catalog_snapshots", ["id"], CATALOG);
  ctx.charge(2, 0, undefined, 0, 2);
  const projections = new Map<P0Row, ConnectionProjection>(), catalogs = new Map<P0Row, ToolCatalogSnapshot>();
  for (const row of ctx.rows("mcp_connection_versions")) {
    const id = ctx.text(row, "connection_id", DECLARATION), revision = ctx.integer(row, "revision", DECLARATION, 1);
    ctx.target(connections, [id], row, DECLARATION, "connection_id");
    const input = ctx.json(row, "configuration_json", DECLARATION), site = ctx.site(row, DECLARATION, "configuration_json");
    // Owned inspect -> declaration clone+schema, URL.canParse + actual URL,
    // canonical digest clone+encoding, freezes; the traversal bound includes both URL scans.
    ctx.reserve(input, site, 3, 1, 8);
    // The real consumer also constructs a distinct six-field projection:
    // one object, six keys and six scalar values, beyond its three input clones.
    ctx.charge(13, 0, site, 13, 13);
    let projection: ConnectionProjection;
    try { projection = inspectMcpConnectionOwnedValue(input); }
    catch (error) { return originalError(ctx, error, row, DECLARATION, "configuration_json"); }
    ctx.equal(projection.connectionId, id, row, DECLARATION, "connection_id");
    ctx.equal(projection.revision, revision, row, DECLARATION, "revision");
    ctx.equal(projection.configurationDigest, ctx.text(row, "configuration_digest", DECLARATION), row, DECLARATION, "configuration_digest", "bytes-mismatch");
    ctx.text(row, "name", DECLARATION); ctx.text(row, "created_at", DECLARATION);
    ctx.charge(1, 0, site, 0, 1); projections.set(row, projection);
  }
  for (const row of ctx.rows("mcp_connections")) {
    ctx.target(versions, [ctx.text(row, "id", DECLARATION), ctx.integer(row, "revision", DECLARATION, 1)], row, DECLARATION, "revision");
    ctx.integer(row, "discovery_sequence", DECLARATION); ctx.text(row, "created_at", DECLARATION); ctx.text(row, "updated_at", DECLARATION);
  }
  for (const row of ctx.rows("mcp_catalog_snapshots")) {
    const id = ctx.text(row, "connection_id", CATALOG), revision = ctx.integer(row, "connection_revision", CATALOG, 1);
    const version = ctx.target(versions, [id, revision], row, CATALOG, "connection_revision");
    const input = ctx.json(row, "snapshot_json", CATALOG, "finite"), site = ctx.site(row, CATALOG, "snapshot_json");
    // Actual reader: initial clone/schema, disjoint schema/toolRef digest trees,
    // full body digest, and freeze. Six full-tree clone bounds include wrappers.
    ctx.reserve(input, site, 6, 3, 12);
    let snapshot: ToolCatalogSnapshot;
    try { snapshot = readToolCatalogSnapshot(input); }
    catch (error) { return originalError(ctx, error, row, CATALOG, "snapshot_json"); }
    ctx.equal(snapshot.snapshotDigest, ctx.text(row, "id", CATALOG), row, CATALOG, "id", "bytes-mismatch");
    ctx.equal(snapshot.connection.connectionId, id, row, CATALOG, "connection_id");
    ctx.equal(snapshot.connection.revision, revision, row, CATALOG, "connection_revision");
    ctx.equal(snapshot.observedAt, ctx.text(row, "observed_at", CATALOG), row, CATALOG, "observed_at");
    sameProjection(ctx, snapshot.connection, projections.get(version)!, row, CATALOG, "snapshot_json", version);
    ctx.charge(1, 0, site, 0, 1); catalogs.set(row, snapshot);
  }
  for (const row of ctx.rows("mcp_catalog_heads")) {
    const snapshotRow = ctx.target(snapshots, [ctx.text(row, "snapshot_id", CATALOG)], row, CATALOG, "snapshot_id");
    const snapshot = catalogs.get(snapshotRow)!;
    ctx.equal(snapshot.connection.connectionId, ctx.text(row, "connection_id", CATALOG), row, CATALOG, "connection_id", "scope-mismatch", snapshotRow);
    ctx.equal(snapshot.connection.revision, ctx.integer(row, "connection_revision", CATALOG, 1), row, CATALOG, "connection_revision", "scope-mismatch", snapshotRow);
  }
  for (const row of ctx.rows("mcp_discovery_attempts")) {
    const id = ctx.text(row, "connection_id", CATALOG), revision = ctx.integer(row, "connection_revision", CATALOG, 1);
    ctx.target(versions, [id, revision], row, CATALOG, "connection_revision");
    ctx.schema(requestId, ctx.text(row, "request_id", CATALOG), row, CATALOG, "request_id");
    ctx.schema(digestValue, ctx.text(row, "input_digest", CATALOG), row, CATALOG, "input_digest");
    ctx.text(row, "id", CATALOG); ctx.text(row, "owner_id", CATALOG); ctx.integer(row, "sequence", CATALOG, 1);
    const status = ctx.oneOf(row, "status", CATALOG, ["running", "cancel_requested", "succeeded", "blocked", "connection_failed", "discovery_failed", "cancelled", "timed_out", "superseded"]);
    const cleanup = ctx.oneOf(row, "cleanup", CATALOG, ["pending", "not_opened", "closed", "remote_unsupported", "remote_unknown"]);
    const snapshotId = ctx.nullableText(row, "snapshot_id", CATALOG), finished = ctx.nullableText(row, "finished_at", CATALOG);
    const error = ctx.nullableText(row, "error_code", CATALOG);
    ctx.nullableText(row, "protocol_version", CATALOG); ctx.nullableInteger(row, "page_count", CATALOG); ctx.text(row, "created_at", CATALOG);
    if (snapshotId !== null) {
      const target = ctx.target(snapshots, [snapshotId], row, CATALOG, "snapshot_id"), snapshot = catalogs.get(target)!;
      ctx.equal(snapshot.connection.connectionId, id, row, CATALOG, "connection_id", "scope-mismatch", target);
      ctx.equal(snapshot.connection.revision, revision, row, CATALOG, "connection_revision", "scope-mismatch", target);
      if (status !== "succeeded" || snapshot.discoveryStatus !== "available") ctx.fail(row, CATALOG, "state-mismatch", "snapshot_id");
    }
    if (status === "succeeded" && (snapshotId === null || error !== null)) ctx.fail(row, CATALOG, "conditional-target-required", "snapshot_id");
    const pending = status === "running" || status === "cancel_requested";
    if (pending ? finished !== null || cleanup !== "pending" || snapshotId !== null : finished === null || cleanup === "pending") ctx.fail(row, CATALOG, "state-mismatch", "status");
  }
  for (const row of ctx.rows("mcp_connection_mutations")) {
    ctx.schema(requestId, ctx.text(row, "request_id", MUTATION), row, MUTATION, "request_id");
    ctx.schema(digestValue, ctx.text(row, "input_digest", MUTATION), row, MUTATION, "input_digest");
    ctx.text(row, "created_at", MUTATION);
    const input = ctx.json(row, "result_json", MUTATION);
    const receipt = ctx.schema(receiptSchema, input, row, MUTATION, "result_json");
    ctx.equal(receipt.connectionId, ctx.nullableText(row, "connection_id", MUTATION), row, MUTATION, "connection_id");
    const version = ctx.target(versions, [receipt.connectionId, receipt.revision], row, MUTATION, "result_json");
    const head = ctx.target(connections, [receipt.connectionId], row, MUTATION, "connection_id");
    sameProjection(ctx, receipt, projections.get(version)!, row, MUTATION, "result_json", version);
    ctx.equal(receipt.name, ctx.text(version, "name", MUTATION), row, MUTATION, "result_json", "immutable-history-mismatch", version);
    ctx.equal(receipt.createdAt, ctx.text(head, "created_at", MUTATION), row, MUTATION, "result_json", "immutable-history-mismatch", head);
    ctx.equal(receipt.updatedAt, ctx.text(version, "created_at", MUTATION), row, MUTATION, "result_json", "immutable-history-mismatch", version);
  }
}

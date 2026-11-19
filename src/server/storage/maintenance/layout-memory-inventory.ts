import { z } from "zod";
import { canonicalJson, digestJson, sha256 } from "./canonical.ts";
import { digestRowMultiset } from "./manifests.ts";
import { hash, ref, source } from "./parse-primitives.ts";
import { copyLayoutInternalData, getLayoutValueErrorCode, LayoutValueError } from "./layout-values.ts";
import type { ReadonlyDeep } from "./layout-values.ts";
import type { ArtifactRef, Json, SourceRef } from "./types.ts";

const MAX_BODY_BYTES = 1_048_576;
const MAX_DOCUMENTS = 4096;
const MAX_VERSIONS = 16384;
const MAX_SUMMARIES = 16384;
const tableNames = ["memory_documents", "memory_versions", "memory_summary_requests"] as const;
// Frozen projection of db/migrations/memory.ts v12. New columns/OIDs need an explicit contract revision.
const tableColumns = [
  ["id", "scope", "project_id", "agent_id", "version", "markdown", "byte_length", "updated_at", "updated_by", "source"],
  ["id", "document_id", "version", "parent_version", "markdown", "byte_length", "content_sha256", "author", "actor_id", "source", "client_mutation_id", "summary_request_id", "created_at"],
  ["id", "project_id", "agent_id", "recipient_member_id", "context_group_id", "document_id", "base_version", "revision", "state", "trigger", "trigger_key", "task_id", "completed_task_revision", "message_ids", "source_work_event_id", "retry_of_request_id", "attempt_id", "begin_mutation_id", "result_version", "result_sha256", "error", "evidence", "created_at", "started_at", "finished_at"],
] as const;
const integerColumns: readonly (readonly number[])[] = [[4, 6], [2, 3, 5], [6, 7, 12, 18]];
const nullableColumns: readonly (readonly number[])[] = [[2, 3], [11], [4, 5, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24]];
const tableLimits = [MAX_DOCUMENTS, MAX_VERSIONS, MAX_SUMMARIES];
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const storageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const memoryId = z.string().max(512).refine(value => value.trim().length > 0 && !value.includes("\0"));
const timestamp = z.string().max(64).datetime({ offset: true });
const counter = z.number().int().nonnegative().safe();
const writeSource = z.enum(["agent", "human", "manager", "self-summary"]);
const authorSchema = z.object({ kind: z.enum(["human", "agent"]), actorId: memoryId, agentId: memoryId.nullable(), displayName: z.string() }).strict();
const keySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global"), projectId: z.null(), agentId: memoryId }).strict(),
  z.object({ scope: z.literal("project"), projectId: memoryId, agentId: z.null() }).strict(),
  z.object({ scope: z.literal("project-agent"), projectId: memoryId, agentId: memoryId }).strict(),
]);
const objectSchema = z.object({ objectFormat: z.literal("utf8-sha256-v1"), storageId, contentSha256: hash,
  byteLength: counter.max(MAX_BODY_BYTES) }).strict();
const documentSchema = z.object({ documentId: memoryId, legacyKey: keySchema, documentKind: z.literal("note"),
  currentVersion: counter.positive(), updatedAt: timestamp, updatedByRaw: z.string(), source: writeSource, sourceRowDigest: hash }).strict();
const versionSchema = z.object({ versionId: memoryId, documentId: memoryId, version: counter.positive(), parentVersion: counter,
  object: objectSchema, relativePath: z.string(), actorId: memoryId, clientMutationId: memoryId, summaryRequestId: memoryId.nullable(),
  authorRaw: z.string(), source: writeSource, createdAt: timestamp, sourceRowDigest: hash }).strict();
const tableSummarySchema = z.object({ name: z.enum(tableNames), count: decimal, digest: hash }).strict();
const inventorySchema = z.object({ contract: z.literal("layout-memory-inventory-value/r1"), source, frozenManifest: ref, storageId,
  tables: z.array(tableSummarySchema).length(3), documents: z.array(documentSchema), versions: z.array(versionSchema),
  objects: z.array(objectSchema), totalVersionBodyBytes: decimal, uniqueObjectBodyBytes: decimal, inventoryDigest: hash }).strict();
const frozenTableSchema = z.object({ name: z.string(), columns: z.array(z.string()), expectedCount: decimal, expectedDigest: hash,
  rows: z.array(z.array(z.unknown())) }).strict();
const inputSchema = z.object({ contract: z.literal("layout-memory-input/r1"), source, frozenManifest: ref, storageId,
  dialect: z.enum(["sqlite", "postgres"]), tables: z.array(frozenTableSchema) }).strict();

export type EncodedCell = readonly ["text" | "integer", string] | readonly ["null"]
  | readonly ["pg:25" | "pg:23", string | null];
export type FrozenTableValue = { name: typeof tableNames[number]; columns: readonly string[]; expectedCount: string;
  expectedDigest: string; rows: readonly (readonly EncodedCell[])[] };
export type FrozenMemoryInputValue = { contract: "layout-memory-input/r1"; source: SourceRef; frozenManifest: ArtifactRef;
  storageId: string; dialect: "sqlite" | "postgres"; tables: readonly FrozenTableValue[] };
export type PlannedMemoryObjectRefValue = z.infer<typeof objectSchema>;
export type InventoryDocumentValue = z.infer<typeof documentSchema>;
export type InventoryVersionValue = z.infer<typeof versionSchema>;
export type LayoutMemoryInventoryValue = z.infer<typeof inventorySchema>;

function requireValue(condition: unknown, code: LayoutValueError["code"] = "inventory_integrity"): asserts condition {
  if (!condition) throw new LayoutValueError(code);
}
function typed<T>(schema: z.ZodType<T>, value: unknown, code: LayoutValueError["code"] = "inventory_integrity"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new LayoutValueError(code);
  return result.data;
}
function author(raw: string) {
  try { return validateMemoryAuthorValue(copyLayoutInternalData(JSON.parse(raw), "inventory")); }
  catch (error) {
    if (getLayoutValueErrorCode(error) === "budget_exceeded") throw error;
    throw new LayoutValueError("inventory_integrity");
  }
}

/** Shared shape only. P0 supplies the exact value read by its owning JSON guard;
 * the original raw consumer above retains its legacy parser/error behavior. */
export function validateMemoryAuthorValue(value: unknown): z.infer<typeof authorSchema> { return typed(authorSchema, value); }

export type MemoryScalarRow = Readonly<Record<string, string | number | null>>;
export type MemoryRowsInput = Readonly<{
  documents: readonly Readonly<{ row: MemoryScalarRow; author: unknown }>[];
  versions: readonly Readonly<{ row: MemoryScalarRow; author: unknown }>[];
  summaries: readonly MemoryScalarRow[];
}>;
type MemoryDocumentCore = Omit<InventoryDocumentValue, 'sourceRowDigest'> & {
  readonly row: MemoryScalarRow; readonly authorValue: z.infer<typeof authorSchema>; readonly body: Buffer; readonly bodySha256: string;
};
type MemoryVersionCore = Omit<InventoryVersionValue, 'sourceRowDigest' | 'object' | 'relativePath'> & {
  readonly row: MemoryScalarRow; readonly authorValue: z.infer<typeof authorSchema>; readonly body: Buffer; readonly bodySha256: string;
};
const memoryRowFailures = new WeakMap<object, Readonly<{ row: MemoryScalarRow; column: string }>>();
export function getMemoryRowFailure(error: unknown): Readonly<{ row: MemoryScalarRow; column: string }> | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? memoryRowFailures.get(error) : undefined;
}
function memoryRow<T>(row: MemoryScalarRow, column: string, run: () => T): T {
  try { return run(); }
  catch (error) {
    if (getLayoutValueErrorCode(error) !== undefined && !memoryRowFailures.has(error as object))
      memoryRowFailures.set(error as object, Object.freeze({ row, column }));
    throw error;
  }
}
function memoryRequire(condition: unknown, row: MemoryScalarRow, column: string, code: LayoutValueError['code'] = 'inventory_integrity'): asserts condition {
  if (!condition) memoryRow(row, column, () => requireValue(false, code));
}
function typedMemoryRow<T>(schema: z.ZodType<T>, value: unknown, row: MemoryScalarRow, columns: Readonly<Record<string, string>>): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // These issues are the schema's own returned diagnostics, not a thrown value.
  // Only its fixed first-level field selects a compiled source column.
  const field = result.error.issues[0]?.path[0];
  const column = typeof field === 'string' && Object.hasOwn(columns, field) ? columns[field]! : 'id';
  return memoryRow(row, column, () => { throw new LayoutValueError('inventory_integrity'); });
}

/** Complete legacy row/version/body/author/summary core, without storage IDs,
 * artifact refs, frozen-manifest claims or a repository. The inventory builder
 * and P0 each call this on their actual decoded rows, once per invocation. */
export function validateLegacyMemoryRows(input: MemoryRowsInput): Readonly<{
  documents: readonly MemoryDocumentCore[]; versions: readonly MemoryVersionCore[];
}> {
  requireValue(input.documents.length <= MAX_DOCUMENTS && input.versions.length <= MAX_VERSIONS
    && input.summaries.length <= MAX_SUMMARIES, 'budget_exceeded');
  const documents = input.documents.map(({ row, author: decoded }) => {
    const values = typedMemoryRow(documentSchema.omit({ sourceRowDigest: true }), {
      documentId: row.id, legacyKey: { scope: row.scope, projectId: row.project_id, agentId: row.agent_id }, documentKind: 'note',
      currentVersion: row.version, updatedAt: row.updated_at, updatedByRaw: row.updated_by, source: row.source,
    }, row, { documentId: 'id', legacyKey: 'scope', currentVersion: 'version', updatedAt: 'updated_at', updatedByRaw: 'updated_by', source: 'source' });
    const authorValue = memoryRow(row, 'updated_by', () => validateMemoryAuthorValue(decoded));
    const body = memoryRow(row, 'markdown', () => { requireValue(typeof row.markdown === 'string'); return bodyBytes(row.markdown); });
    memoryRequire(body.length === row.byte_length, row, 'byte_length');
    return { ...values, row, authorValue, body, bodySha256: sha256(body) };
  });
  const versions = input.versions.map(({ row, author: decoded }) => {
    const values = typedMemoryRow(versionSchema.omit({ sourceRowDigest: true, object: true, relativePath: true }), {
      versionId: row.id, documentId: row.document_id, version: row.version, parentVersion: row.parent_version,
      actorId: row.actor_id, clientMutationId: row.client_mutation_id, summaryRequestId: row.summary_request_id,
      authorRaw: row.author, source: row.source, createdAt: row.created_at,
    }, row, { versionId: 'id', documentId: 'document_id', version: 'version', parentVersion: 'parent_version', actorId: 'actor_id',
      clientMutationId: 'client_mutation_id', summaryRequestId: 'summary_request_id', authorRaw: 'author', source: 'source', createdAt: 'created_at' });
    const authorValue = memoryRow(row, 'author', () => validateMemoryAuthorValue(decoded));
    const body = memoryRow(row, 'markdown', () => { requireValue(typeof row.markdown === 'string'); return bodyBytes(row.markdown); });
    const bodySha256 = sha256(body);
    memoryRequire(body.length === row.byte_length, row, 'byte_length');
    memoryRequire(bodySha256 === row.content_sha256, row, 'content_sha256');
    return { ...values, row, authorValue, body, bodySha256 };
  });
  const byDocument = new Map<string, MemoryDocumentCore>(), keys = new Set<string>();
  for (const document of documents) {
    memoryRequire(!byDocument.has(document.documentId), document.row, 'id'); byDocument.set(document.documentId, document);
    const key = JSON.stringify([document.legacyKey.scope, document.legacyKey.projectId, document.legacyKey.agentId]);
    memoryRequire(!keys.has(key), document.row, 'scope'); keys.add(key);
  }
  const sorted = [...versions].sort((a, b) => compare(a.documentId, b.documentId) || a.version - b.version || compare(a.versionId, b.versionId));
  const heads = new Map<string, MemoryVersionCore>(), ids = new Set<string>(), mutations = new Set<string>(), bodies = new Map<string, Buffer>();
  for (const version of sorted) {
    memoryRequire(!ids.has(version.versionId), version.row, 'id'); ids.add(version.versionId);
    const document = byDocument.get(version.documentId);
    memoryRequire(document, version.row, 'document_id', 'incomplete_inventory');
    const expected = (heads.get(version.documentId)?.version ?? 0) + 1;
    memoryRequire(version.version === expected && version.version <= document.currentVersion
      && version.parentVersion === version.version - 1, version.row, 'version', 'incomplete_inventory');
    const mutation = JSON.stringify([version.documentId, version.actorId, version.clientMutationId]);
    memoryRequire(!mutations.has(mutation), version.row, 'client_mutation_id'); mutations.add(mutation);
    memoryRequire(version.authorValue.actorId === version.actorId, version.row, 'author');
    const prior = bodies.get(version.bodySha256);
    memoryRequire(!prior || prior.length === version.body.length && prior.equals(version.body), version.row, 'markdown');
    if (!prior) bodies.set(version.bodySha256, version.body);
    heads.set(version.documentId, version);
  }
  for (const document of documents) {
    const head = heads.get(document.documentId);
    memoryRequire(head && head.version === document.currentVersion, document.row, 'version', 'incomplete_inventory');
    // The strict author grammar has exactly four scalar fields. Field equality
    // is the same canonical-value equation without encoding a second JSON tree.
    memoryRequire(head.source === document.source && head.authorValue.kind === document.authorValue.kind
      && head.authorValue.actorId === document.authorValue.actorId && head.authorValue.agentId === document.authorValue.agentId
      && head.authorValue.displayName === document.authorValue.displayName, document.row, 'updated_by');
    memoryRequire(head.bodySha256 === document.bodySha256 && head.body.length === document.body.length && head.body.equals(document.body), document.row, 'markdown');
  }
  const summaryIds = new Set<string>(), summaryKeys = new Set<string>();
  for (const row of input.summaries) {
    const id = memoryRow(row, 'id', () => typed(memoryId, row.id));
    memoryRequire(!summaryIds.has(id), row, 'id'); summaryIds.add(id);
    const key = JSON.stringify([row.project_id, row.agent_id, row.trigger_key]);
    memoryRequire(!summaryKeys.has(key), row, 'trigger_key'); summaryKeys.add(key);
    memoryRow(row, 'base_version', () => typed(counter, row.base_version));
    memoryRow(row, 'revision', () => typed(counter.positive(), row.revision));
    for (const field of ['completed_task_revision', 'result_version']) if (row[field] !== null)
      memoryRow(row, field, () => typed(counter.positive(), row[field]));
    memoryRow(row, 'state', () => typed(z.enum(['pending', 'running', 'completed', 'failed', 'conflicted', 'cancelled']), row.state));
    memoryRow(row, 'trigger', () => typed(z.enum(['task_completed', 'message_threshold', 'session_end', 'retry']), row.trigger));
    for (const field of ['created_at', 'started_at', 'finished_at']) if (row[field] !== null)
      memoryRow(row, field, () => typed(timestamp, row[field]));
  }
  return { documents, versions };
}
function bodyBytes(markdown: string): Buffer {
  requireValue(Buffer.byteLength(markdown, "utf8") <= MAX_BODY_BYTES, "budget_exceeded");
  return Buffer.from(markdown, "utf8");
}
function decodeCell(cell: unknown, dialect: FrozenMemoryInputValue["dialect"], table: number, column: number): string | number | null {
  requireValue(Array.isArray(cell), "unsupported_shape");
  const integer = integerColumns[table]!.includes(column);
  const nullable = nullableColumns[table]!.includes(column);
  if (dialect === "sqlite" && cell.length === 1 && cell[0] === "null") {
    requireValue(nullable); return null;
  }
  requireValue(cell.length === 2, "unsupported_shape");
  const expected = dialect === "sqlite" ? integer ? "integer" : "text" : integer ? "pg:23" : "pg:25";
  requireValue(cell[0] === expected, "unsupported_shape");
  if (cell[1] === null) { requireValue(dialect === "postgres" && nullable); return null; }
  requireValue(typeof cell[1] === "string", "unsupported_shape");
  if (integer) {
    requireValue(/^(0|-?[1-9][0-9]*)$/.test(cell[1]), "invalid_value");
    const value = Number(cell[1]);
    requireValue(Number.isSafeInteger(value));
    if (dialect === "postgres") requireValue(value >= -2147483648 && value <= 2147483647);
    return value;
  }
  if (dialect === "postgres") return cell[1];
  requireValue(/^(?:[0-9a-f]{2})*$/.test(cell[1]), "invalid_value");
  if (tableColumns[table]![column] === "markdown") requireValue(cell[1].length <= 2 * MAX_BODY_BYTES, "budget_exceeded");
  const bytes = Buffer.from(cell[1], "hex");
  try {
    // ignoreBOM=true preserves a leading BOM as content instead of consuming it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    requireValue(Buffer.from(text, "utf8").equals(bytes));
    return text;
  } catch { throw new LayoutValueError("inventory_integrity"); }
}
function objectPath(digest: string) { return `objects/sha256/${digest.slice(0, 2)}/${digest}.md`; }
function compare(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
function contractData(value: unknown, contract: string) {
  const safe = copyLayoutInternalData(value, "inventory");
  if (safe && typeof safe === "object" && "contract" in safe && typeof safe.contract === "string")
    requireValue(safe.contract === contract, "unsupported_shape");
  return safe;
}

/** Checks data closure only; it cannot prove that an original snapshot or body exists. */
function checkInventory(value: LayoutMemoryInventoryValue) {
  requireValue(value.documents.length <= MAX_DOCUMENTS && value.versions.length <= MAX_VERSIONS
    && value.objects.length <= MAX_VERSIONS, "budget_exceeded");
  for (const [index, table] of value.tables.entries()) {
    requireValue(table.name === tableNames[index], "unsupported_shape");
    requireValue(Number(table.count) <= tableLimits[index]!, "budget_exceeded");
  }
  requireValue(value.tables[0]!.count === String(value.documents.length) && value.tables[1]!.count === String(value.versions.length), "incomplete_inventory");
  const documents = new Map<string, InventoryDocumentValue>();
  const keys = new Set<string>();
  let previousId: string | undefined;
  for (const document of value.documents) {
    requireValue(previousId === undefined || compare(previousId, document.documentId) < 0);
    previousId = document.documentId;
    const key = canonicalJson(document.legacyKey);
    requireValue(!keys.has(key)); keys.add(key);
    documents.set(document.documentId, document);
    author(document.updatedByRaw);
  }
  const objects = new Map<string, PlannedMemoryObjectRefValue>();
  let previousObject: PlannedMemoryObjectRefValue | undefined;
  for (const object of value.objects) {
    requireValue(object.storageId === value.storageId);
    requireValue(!previousObject || compare(previousObject.contentSha256, object.contentSha256) < 0
      || previousObject.contentSha256 === object.contentSha256 && previousObject.byteLength < object.byteLength);
    requireValue(!objects.has(object.contentSha256));
    objects.set(object.contentSha256, object); previousObject = object;
  }
  const ids = new Set<string>();
  const mutations = new Set<string>();
  const usedObjects = new Set<string>();
  const heads = new Map<string, InventoryVersionValue>();
  let previousVersion: InventoryVersionValue | undefined;
  let total = 0n;
  for (const version of value.versions) {
    requireValue(!previousVersion || compare(previousVersion.documentId, version.documentId) < 0
      || previousVersion.documentId === version.documentId && (previousVersion.version < version.version
        || previousVersion.version === version.version && compare(previousVersion.versionId, version.versionId) < 0));
    previousVersion = version;
    requireValue(!ids.has(version.versionId)); ids.add(version.versionId);
    const document = documents.get(version.documentId);
    requireValue(document);
    const expected = (heads.get(version.documentId)?.version ?? 0) + 1;
    requireValue(version.version === expected && version.version <= document.currentVersion
      && version.parentVersion === version.version - 1, "incomplete_inventory");
    const mutation = canonicalJson([version.documentId, version.actorId, version.clientMutationId]);
    requireValue(!mutations.has(mutation)); mutations.add(mutation);
    requireValue(author(version.authorRaw).actorId === version.actorId);
    const object = objects.get(version.object.contentSha256);
    requireValue(object && version.object.storageId === value.storageId && canonicalJson(object) === canonicalJson(version.object));
    requireValue(version.relativePath === objectPath(version.object.contentSha256));
    usedObjects.add(version.object.contentSha256); heads.set(version.documentId, version);
    total += BigInt(version.object.byteLength);
  }
  for (const document of value.documents) {
    const head = heads.get(document.documentId);
    requireValue(head && head.version === document.currentVersion, "incomplete_inventory");
    requireValue(head.source === document.source && canonicalJson(author(head.authorRaw)) === canonicalJson(author(document.updatedByRaw)));
  }
  requireValue(usedObjects.size === objects.size);
  requireValue(value.totalVersionBodyBytes === total.toString()
    && value.uniqueObjectBodyBytes === [...objects.values()].reduce((sum, object) => sum + BigInt(object.byteLength), 0n).toString());
  const { inventoryDigest, ...withoutDigest } = value;
  requireValue(digestJson(withoutDigest) === inventoryDigest);
}

export function parseLayoutMemoryInventoryValue(value: unknown): ReadonlyDeep<LayoutMemoryInventoryValue> {
  const parsed = typed(inventorySchema, contractData(value, "layout-memory-inventory-value/r1"), "invalid_value");
  checkInventory(parsed);
  return copyLayoutInternalData(parsed, "inventory") as ReadonlyDeep<LayoutMemoryInventoryValue>;
}

export function buildLayoutMemoryInventory(value: unknown): ReadonlyDeep<LayoutMemoryInventoryValue> {
  const input = typed(inputSchema, contractData(value, "layout-memory-input/r1"), "invalid_value");
  requireValue(input.source.kind === input.dialect, "value_conflict");
  requireValue(input.tables.length === 3, input.tables.length < 3 ? "incomplete_inventory" : "unsupported_shape");
  const tables: z.infer<typeof tableSummarySchema>[] = [];
  const decoded: Record<string, string | number | null>[][] = [];
  for (const [index, table] of input.tables.entries()) {
    requireValue(table.name === tableNames[index] && canonicalJson(table.columns) === canonicalJson(tableColumns[index]), "unsupported_shape");
    requireValue(table.rows.length <= tableLimits[index]!, "budget_exceeded");
    requireValue(String(table.rows.length) === table.expectedCount, "incomplete_inventory");
    const digest = digestRowMultiset(table.rows as readonly Json[]);
    requireValue(digest.digest === table.expectedDigest);
    tables.push({ name: tableNames[index]!, ...digest });
    decoded.push(table.rows.map(row => {
      requireValue(row.length === tableColumns[index]!.length, "unsupported_shape");
      return Object.fromEntries(row.map((cell, column) => [tableColumns[index]![column]!, decodeCell(cell, input.dialect, index, column)]));
    }));
  }
  const checked = validateLegacyMemoryRows({
    documents: decoded[0]!.map(row => ({ row, author: author(row.updated_by as string) })),
    versions: decoded[1]!.map(row => ({ row, author: author(row.author as string) })), summaries: decoded[2]!,
  });
  const documents: InventoryDocumentValue[] = checked.documents.map(({ row }, index) => typed(documentSchema, {
    documentId: row.id, legacyKey: { scope: row.scope, projectId: row.project_id, agentId: row.agent_id }, documentKind: "note",
    currentVersion: row.version, updatedAt: row.updated_at, updatedByRaw: row.updated_by, source: row.source,
    sourceRowDigest: digestJson(input.tables[0]!.rows[index]),
  }));
  const objectBytes = new Map<string, { ref: PlannedMemoryObjectRefValue; bytes: Buffer }>();
  let total = 0n;
  const versions: InventoryVersionValue[] = checked.versions.map(({ row, body: bytes, bodySha256: digest }, index) => {
    const object: PlannedMemoryObjectRefValue = { objectFormat: "utf8-sha256-v1", storageId: input.storageId, contentSha256: digest, byteLength: bytes.length };
    const prior = objectBytes.get(digest);
    // Equality remains byte-for-byte even when the content digest is shared.
    requireValue(!prior || prior.ref.byteLength === bytes.length && prior.bytes.equals(bytes));
    if (!prior) objectBytes.set(digest, { ref: object, bytes });
    total += BigInt(bytes.length);
    return typed(versionSchema, { versionId: row.id, documentId: row.document_id, version: row.version, parentVersion: row.parent_version,
      object, relativePath: objectPath(digest), actorId: row.actor_id, clientMutationId: row.client_mutation_id,
      summaryRequestId: row.summary_request_id, authorRaw: row.author, source: row.source, createdAt: row.created_at,
      sourceRowDigest: digestJson(input.tables[1]!.rows[index]) });
  });
  // message_ids/error/evidence stay original TEXT in the frozen table digest.
  // summary_request_id has no FK: the shared core does not resurrect a request.
  documents.sort((left, right) => compare(left.documentId, right.documentId));
  versions.sort((left, right) => compare(left.documentId, right.documentId) || left.version - right.version || compare(left.versionId, right.versionId));
  const objects = [...objectBytes.values()].map(entry => entry.ref).sort((left, right) => compare(left.contentSha256, right.contentSha256) || left.byteLength - right.byteLength);
  const output = { contract: "layout-memory-inventory-value/r1" as const, source: input.source, frozenManifest: input.frozenManifest,
    storageId: input.storageId, tables, documents, versions, objects, totalVersionBodyBytes: total.toString(),
    uniqueObjectBodyBytes: objects.reduce((sum, object) => sum + BigInt(object.byteLength), 0n).toString() };
  return parseLayoutMemoryInventoryValue({ ...output, inventoryDigest: digestJson(output) });
}

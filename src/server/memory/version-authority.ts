import { canonicalJson, digestJson } from "../storage/maintenance/canonical.ts";
import { parseLayoutMemoryInventoryValue } from "../storage/maintenance/layout-memory-inventory.ts";
import type { InventoryDocumentValue, InventoryVersionValue, LayoutMemoryInventoryValue } from "../storage/maintenance/layout-memory-inventory.ts";
import { getLayoutValueErrorCode, LayoutValueError } from "../storage/maintenance/layout-values.ts";
import type { ReadonlyDeep } from "../storage/maintenance/layout-values.ts";
import { parseMemoryObjectRef } from "./object-ref.ts";
import type { MemoryObjectRef } from "./object-ref.ts";

export type MemoryVersionScope = "global" | "project" | "project-agent";
const SCOPES: readonly MemoryVersionScope[] = ["global", "project", "project-agent"];

type ErrorCode = LayoutValueError["code"];
type LegacyKey = ReadonlyDeep<InventoryDocumentValue["legacyKey"]>;
type VersionSource = InventoryVersionValue["source"];
type DocumentSource = InventoryDocumentValue["source"];

export interface MemoryVersionNodeValue {
  readonly documentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly parentVersion: number;
  readonly object: Readonly<MemoryObjectRef>;
  readonly relativePath: string;
  readonly actorId: string;
  readonly clientMutationId: string;
  readonly summaryRequestId: string | null;
  readonly authorRaw: string;
  readonly source: VersionSource;
  readonly createdAt: string;
  readonly sourceRowDigest: string;
}

export interface MemoryVersionHeadValue {
  readonly documentId: string;
  readonly legacyKey: LegacyKey;
  readonly documentKind: InventoryDocumentValue["documentKind"];
  readonly currentVersion: number;
  readonly updatedAt: string;
  readonly updatedByRaw: string;
  readonly source: DocumentSource;
  readonly sourceRowDigest: string;
  readonly version: Readonly<MemoryVersionNodeValue>;
}

export interface MemoryVersionChainValue {
  readonly documentId: string;
  readonly legacyKey: LegacyKey;
  readonly headVersionId: string;
  readonly versions: readonly Readonly<MemoryVersionNodeValue>[];
  readonly digest: string;
}

export interface MemoryVersionLayerValue {
  readonly scope: MemoryVersionScope;
  readonly heads: readonly Readonly<MemoryVersionHeadValue>[];
  readonly chains: readonly Readonly<MemoryVersionChainValue>[];
  readonly objects: readonly Readonly<MemoryObjectRef>[];
  readonly digest: string;
}

export interface MemoryVersionAuthorityValue {
  readonly contract: "memory-version-authority-value/r1";
  readonly inventoryDigest: string;
  readonly storageId: string;
  readonly layers: readonly Readonly<MemoryVersionLayerValue>[];
  readonly unreferencedObjects: readonly Readonly<MemoryObjectRef>[];
  readonly digest: string;
}

function fail(code: ErrorCode): never { throw new LayoutValueError(code); }
function requireValue(condition: unknown, code: ErrorCode = "inventory_integrity"): asserts condition {
  if (!condition) fail(code);
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareRef(left: Readonly<MemoryObjectRef>, right: Readonly<MemoryObjectRef>): number {
  return compareText(left.contentSha256, right.contentSha256) || left.byteLength - right.byteLength
    || compareText(left.storageId, right.storageId) || compareText(left.objectFormat, right.objectFormat);
}
function objectValue(value: unknown): Readonly<MemoryObjectRef> {
  try { return parseMemoryObjectRef(value); }
  catch { return fail("inventory_integrity"); }
}

function versionNode(version: InventoryVersionValue, objects: ReadonlyMap<string, Readonly<MemoryObjectRef>>): Readonly<MemoryVersionNodeValue> {
  const object = objects.get(version.object.contentSha256);
  requireValue(object && canonicalJson(object) === canonicalJson(objectValue(version.object)), "inventory_integrity");
  return Object.freeze({
    documentId: version.documentId, versionId: version.versionId, version: version.version,
    parentVersion: version.parentVersion, object, relativePath: version.relativePath, actorId: version.actorId,
    clientMutationId: version.clientMutationId, summaryRequestId: version.summaryRequestId,
    authorRaw: version.authorRaw, source: version.source, createdAt: version.createdAt,
    sourceRowDigest: version.sourceRowDigest,
  });
}

function build(inventory: ReadonlyDeep<LayoutMemoryInventoryValue>): Readonly<MemoryVersionAuthorityValue> {
  const safe = parseLayoutMemoryInventoryValue(inventory);
  const documents = new Map<string, InventoryDocumentValue>();
  const byScope = new Map<MemoryVersionScope, Map<string, InventoryDocumentValue>>(
    SCOPES.map(scope => [scope, new Map<string, InventoryDocumentValue>()]),
  );
  for (const document of safe.documents) {
    const key = document.legacyKey;
    requireValue(SCOPES.includes(key.scope), "unsupported_shape");
    requireValue((key.scope === "global") === (key.projectId === null)
      && (key.scope === "project") === (key.agentId === null), "value_conflict");
    requireValue(!documents.has(document.documentId), "inventory_integrity");
    documents.set(document.documentId, document);
    byScope.get(key.scope)!.set(document.documentId, document);
  }

  const inventoryObjects = new Map<string, Readonly<MemoryObjectRef>>();
  for (const object of safe.objects) {
    const ref = objectValue(object);
    requireValue(!inventoryObjects.has(ref.contentSha256), "inventory_integrity");
    inventoryObjects.set(ref.contentSha256, ref);
  }

  const versionLists = new Map<string, InventoryVersionValue[]>();
  const versionIds = new Set<string>();
  const mutations = new Set<string>();
  const scopeRefs = new Map<MemoryVersionScope, Map<string, Readonly<MemoryObjectRef>>>(
    SCOPES.map(scope => [scope, new Map<string, Readonly<MemoryObjectRef>>()]),
  );
  const referenced = new Set<string>();
  for (const version of safe.versions) {
    requireValue(!versionIds.has(version.versionId), "inventory_integrity");
    versionIds.add(version.versionId);
    const mutation = canonicalJson([version.documentId, version.actorId, version.clientMutationId]);
    requireValue(!mutations.has(mutation), "inventory_integrity");
    mutations.add(mutation);
    const document = documents.get(version.documentId);
    requireValue(document, "incomplete_inventory");
    requireValue(version.parentVersion === version.version - 1, "incomplete_inventory");
    const list = versionLists.get(version.documentId);
    requireValue(!list || list[list.length - 1]!.version === version.version - 1, "incomplete_inventory");
    if (list) list.push(version);
    else versionLists.set(version.documentId, [version]);

    const ref = objectValue(version.object);
    const expected = inventoryObjects.get(version.object.contentSha256);
    requireValue(expected && canonicalJson(expected) === canonicalJson(ref), "inventory_integrity");
    const refKey = canonicalJson(ref);
    scopeRefs.get(document.legacyKey.scope)!.set(refKey, ref);
    referenced.add(refKey);
  }

  const layers = SCOPES.map(scope => {
    const heads: Readonly<MemoryVersionHeadValue>[] = [];
    const chains: Readonly<MemoryVersionChainValue>[] = [];
    const scopedDocuments = [...byScope.get(scope)!.values()].sort((a, b) => compareText(a.documentId, b.documentId));
    for (const document of scopedDocuments) {
      const versions = versionLists.get(document.documentId);
      requireValue(versions && versions.length > 0, "incomplete_inventory");
      const nodes = versions.map(version => versionNode(version, inventoryObjects));
      for (const [index, node] of nodes.entries())
        requireValue(node.version === index + 1 && node.parentVersion === index, "incomplete_inventory");
      const head = nodes[nodes.length - 1]!;
      requireValue(head.version === document.currentVersion && head.source === document.source, "value_conflict");
      const chainPayload = { documentId: document.documentId, legacyKey: document.legacyKey,
        headVersionId: head.versionId, versions: Object.freeze(nodes) };
      chains.push(Object.freeze({ ...chainPayload, digest: digestJson(chainPayload) }));
      const headPayload = { documentId: document.documentId, legacyKey: document.legacyKey,
        documentKind: document.documentKind, currentVersion: document.currentVersion, updatedAt: document.updatedAt,
        updatedByRaw: document.updatedByRaw, source: document.source, sourceRowDigest: document.sourceRowDigest,
        version: head };
      heads.push(Object.freeze(headPayload));
    }
    const objects = [...scopeRefs.get(scope)!.values()].sort(compareRef);
    const payload = { scope, heads: Object.freeze(heads), chains: Object.freeze(chains), objects: Object.freeze(objects) };
    return Object.freeze({ ...payload, digest: digestJson(payload) });
  });

  const unreferencedObjects = [...inventoryObjects.values()].filter(ref => !referenced.has(canonicalJson(ref))).sort(compareRef);
  const payload = { contract: "memory-version-authority-value/r1" as const, inventoryDigest: safe.inventoryDigest,
    storageId: safe.storageId, layers: Object.freeze(layers), unreferencedObjects: Object.freeze(unreferencedObjects) };
  return Object.freeze({ ...payload, digest: digestJson(payload) });
}

/** Pure projection of a frozen inventory. It grants no storage, publication or head-switch authority. */
export function buildMemoryVersionAuthority(inventory: ReadonlyDeep<LayoutMemoryInventoryValue>): Readonly<MemoryVersionAuthorityValue> {
  try { return build(inventory); }
  catch (error) { throw new LayoutValueError(getLayoutValueErrorCode(error) ?? "invalid_value"); }
}

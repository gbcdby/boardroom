import { canonicalJson, digestJson } from "../storage/maintenance/canonical.ts";
import type { InventoryDocumentValue } from "../storage/maintenance/layout-memory-inventory.ts";
import { getLayoutValueErrorCode, LayoutValueError } from "../storage/maintenance/layout-values.ts";
import { memoryObjectRelativeKey, parseMemoryObjectRef } from "./object-ref.ts";
import type { MemoryObjectRef } from "./object-ref.ts";
import type { MemoryVersionAuthorityValue, MemoryVersionHeadValue, MemoryVersionScope } from "./version-authority.ts";

type ErrorCode = LayoutValueError["code"];
type LegacyKey = MemoryVersionHeadValue["legacyKey"];
type DocumentKind = InventoryDocumentValue["documentKind"];

const CONTRACT = "memory-read-projection-value/r1" as const;
const SCOPES: readonly MemoryVersionScope[] = Object.freeze(["global", "project", "project-agent"]);
const DOCUMENT_KINDS: readonly DocumentKind[] = Object.freeze(["note"]);
const SELECTOR_FIELDS = Object.freeze(["scope", "projectId", "agentId", "documentKind", "documentId"] as const);
const KEY_FIELDS = Object.freeze(["scope", "projectId", "agentId"] as const);
const AUTHORITY_FIELDS = Object.freeze(["contract", "inventoryDigest", "storageId", "layers", "unreferencedObjects", "digest"] as const);
const LAYER_FIELDS = Object.freeze(["scope", "heads", "chains", "objects", "digest"] as const);
const HEAD_FIELDS = Object.freeze(["documentId", "legacyKey", "documentKind", "currentVersion", "updatedAt", "updatedByRaw", "source",
  "sourceRowDigest", "version"] as const);
const CHAIN_FIELDS = Object.freeze(["documentId", "legacyKey", "headVersionId", "versions", "digest"] as const);
const NODE_FIELDS = Object.freeze(["documentId", "versionId", "version", "parentVersion", "object", "relativePath", "actorId",
  "clientMutationId", "summaryRequestId", "authorRaw", "source", "createdAt", "sourceRowDigest"] as const);

/** Strict selector for one frozen memory document. Omitting `version` reads the current head. */
export interface MemoryReadSelectorValue {
  readonly scope: MemoryVersionScope;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly documentKind: DocumentKind;
  readonly documentId: string;
  readonly version?: number;
}

/** Pure value projection. It grants no body, permission, publication or execution authority. */
export interface MemoryReadProjectionValue {
  readonly contract: typeof CONTRACT;
  readonly authorityDigest: string;
  readonly legacyKey: LegacyKey;
  readonly documentKind: DocumentKind;
  readonly documentId: string;
  readonly headVersion: number;
  readonly selectedVersion: number;
  readonly parentVersion: number;
  readonly object: Readonly<MemoryObjectRef>;
  readonly relativePath: string;
  readonly digest: string;
}

interface SelectorInput {
  readonly scope: MemoryVersionScope;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly documentKind: DocumentKind;
  readonly documentId: string;
  readonly hasVersion: boolean;
  readonly version: number | undefined;
}

interface AuthorityInput {
  readonly digest: string;
  readonly storageId: string;
  readonly layers: readonly unknown[];
}

interface SnapshotBudget { nodes: number }

function fail(code: ErrorCode): never { throw new LayoutValueError(code); }
function requireValue(condition: unknown, code: ErrorCode = "invalid_value"): asserts condition {
  if (!condition) fail(code);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isScope(value: unknown): value is MemoryVersionScope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}
function objectKeys(value: unknown): readonly string[] {
  requireValue(value !== null && typeof value === "object");
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === "string"));
  return keys as string[];
}
function readFields(value: object, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    result[field] = descriptor.value;
  }
  return result;
}
function ownFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const keys = objectKeys(value);
  requireValue(keys.length === fields.length && fields.every(field => keys.includes(field)));
  return readFields(value as object, fields);
}

/** Snapshot frozen data through descriptors only: no caller getter or coercion is invoked. */
function snapshot(value: unknown, budget: SnapshotBudget, depth = 0): unknown {
  if (++budget.nodes > 250_000 || depth > 128) fail("budget_exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value) && !Object.is(value, -0));
    return value;
  }
  requireValue(typeof value === "object" && Object.isFrozen(value));
  if (Array.isArray(value)) {
    requireValue(Object.getPrototypeOf(value) === Array.prototype);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    requireValue(lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
      && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0 && lengthDescriptor.value <= 250_000);
    const length = lengthDescriptor.value;
    requireValue(Reflect.ownKeys(value).length === length + 1);
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
      result.push(snapshot(descriptor.value, budget, depth + 1));
    }
    return Object.freeze(result);
  }
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    requireValue(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    descriptors.set(key, descriptor);
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of descriptors)
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true });
  return Object.freeze(result);
}

function validateSelector(value: unknown): SelectorInput {
  const keys = objectKeys(value);
  const hasVersion = keys.includes("version");
  const expected = hasVersion ? [...SELECTOR_FIELDS, "version"] : [...SELECTOR_FIELDS];
  requireValue(keys.length === expected.length && expected.every(field => keys.includes(field)));
  const fields = readFields(value as object, expected);
  requireValue(isScope(fields.scope));
  requireValue(fields.projectId === null || typeof fields.projectId === "string");
  requireValue(fields.agentId === null || typeof fields.agentId === "string");
  requireValue(fields.scope === "global" ? fields.projectId === null && typeof fields.agentId === "string"
    : fields.scope === "project" ? typeof fields.projectId === "string" && fields.agentId === null
      : typeof fields.projectId === "string" && typeof fields.agentId === "string");
  requireValue(typeof fields.documentKind === "string" && (DOCUMENT_KINDS as readonly string[]).includes(fields.documentKind));
  requireValue(typeof fields.documentId === "string" && fields.documentId.length > 0 && fields.documentId.length <= 512
    && !fields.documentId.includes("\0"));
  if (hasVersion) requireValue(typeof fields.version === "number" && Number.isSafeInteger(fields.version) && fields.version > 0);
  return { scope: fields.scope, projectId: fields.projectId, agentId: fields.agentId,
    documentKind: fields.documentKind as DocumentKind, documentId: fields.documentId, hasVersion,
    version: hasVersion ? fields.version as number : undefined };
}

function validateLegacyKey(value: unknown, scope: MemoryVersionScope): LegacyKey {
  const key = ownFields(value, [...KEY_FIELDS]);
  requireValue(key.scope === scope, "inventory_integrity");
  requireValue((scope === "global") === (key.projectId === null)
    && (scope === "project") === (key.agentId === null), "inventory_integrity");
  requireValue(key.projectId === null || typeof key.projectId === "string");
  requireValue(key.agentId === null || typeof key.agentId === "string");
  return Object.freeze({ scope, projectId: key.projectId, agentId: key.agentId }) as LegacyKey;
}

function validateAuthority(value: unknown): AuthorityInput {
  const fields = ownFields(snapshot(value, { nodes: 0 }), [...AUTHORITY_FIELDS]);
  requireValue(fields.contract === "memory-version-authority-value/r1", "unsupported_shape");
  requireValue(isHash(fields.inventoryDigest) && isHash(fields.digest), "inventory_integrity");
  requireValue(typeof fields.storageId === "string" && fields.storageId.length > 0);
  requireValue(Array.isArray(fields.layers) && fields.layers.length === SCOPES.length, "unsupported_shape");
  requireValue(Array.isArray(fields.unreferencedObjects));
  const { digest: _ignored, ...payload } = fields;
  requireValue(digestJson(payload) === fields.digest, "inventory_integrity");
  for (const [index, layer] of fields.layers.entries()) {
    const checked = ownFields(layer, [...LAYER_FIELDS]);
    requireValue(checked.scope === SCOPES[index], "unsupported_shape");
    requireValue(Array.isArray(checked.heads) && Array.isArray(checked.chains) && Array.isArray(checked.objects));
    requireValue(digestJson({ scope: checked.scope, heads: checked.heads, chains: checked.chains, objects: checked.objects })
      === checked.digest, "inventory_integrity");
  }
  return { digest: fields.digest as string, storageId: fields.storageId, layers: fields.layers };
}

function parseRef(value: unknown): Readonly<MemoryObjectRef> {
  try { return parseMemoryObjectRef(value); }
  catch { return fail("inventory_integrity"); }
}
function relativeKey(ref: Readonly<MemoryObjectRef>): string {
  try { return memoryObjectRelativeKey(ref); }
  catch { return fail("inventory_integrity"); }
}

/** Pure projection of an already frozen version authority. No storage, body or permission is consulted. */
export function projectMemoryRead(authority: Readonly<MemoryVersionAuthorityValue>,
  selector: Readonly<MemoryReadSelectorValue>): Readonly<MemoryReadProjectionValue> {
  try {
    const input = validateSelector(selector);
    const checked = validateAuthority(authority);
    const layer = ownFields(checked.layers[SCOPES.indexOf(input.scope)]!, [...LAYER_FIELDS]);
    const layerHeads = layer.heads, layerChains = layer.chains, layerObjects = layer.objects;
    requireValue(layer.scope === input.scope && Array.isArray(layerHeads) && Array.isArray(layerChains)
      && Array.isArray(layerObjects));
    const refKeys = new Set<string>();
    for (const value of layerObjects) {
      const ref = parseRef(value);
      requireValue(ref.storageId === checked.storageId, "inventory_integrity");
      const key = canonicalJson(ref);
      requireValue(!refKeys.has(key), "inventory_integrity");
      refKeys.add(key);
    }

    const heads = new Map<string, Record<string, unknown>>();
    for (const value of layerHeads) {
      const head = ownFields(value, [...HEAD_FIELDS]);
      requireValue(typeof head.documentId === "string" && !heads.has(head.documentId), "inventory_integrity");
      validateLegacyKey(head.legacyKey, input.scope);
      requireValue(typeof head.documentKind === "string" && (DOCUMENT_KINDS as readonly string[]).includes(head.documentKind));
      requireValue(typeof head.currentVersion === "number" && Number.isSafeInteger(head.currentVersion) && head.currentVersion > 0);
      heads.set(head.documentId, head);
    }

    const chains = new Map<string, Record<string, unknown>>();
    for (const value of layerChains) {
      const chain = ownFields(value, [...CHAIN_FIELDS]);
      requireValue(typeof chain.documentId === "string" && !chains.has(chain.documentId), "inventory_integrity");
      validateLegacyKey(chain.legacyKey, input.scope);
      requireValue(typeof chain.headVersionId === "string" && chain.headVersionId.length > 0);
      requireValue(Array.isArray(chain.versions));
      requireValue(digestJson({ documentId: chain.documentId, legacyKey: chain.legacyKey,
        headVersionId: chain.headVersionId, versions: chain.versions }) === chain.digest, "inventory_integrity");
      for (const [index, versionValue] of chain.versions.entries()) {
        const node = ownFields(versionValue, [...NODE_FIELDS]);
        requireValue(node.documentId === chain.documentId, "inventory_integrity");
        requireValue(node.version === index + 1 && node.parentVersion === index, "inventory_integrity");
        const nodeRef = parseRef(node.object);
        requireValue(refKeys.has(canonicalJson(nodeRef)), "inventory_integrity");
        requireValue(node.relativePath === relativeKey(nodeRef), "inventory_integrity");
      }
      chains.set(chain.documentId, chain);
    }
    requireValue(heads.size === chains.size && [...heads.keys()].every(id => chains.has(id)), "inventory_integrity");

    const head = heads.get(input.documentId);
    const chain = chains.get(input.documentId);
    requireValue(head && chain, "value_conflict");
    const legacyKey = validateLegacyKey(head.legacyKey, input.scope);
    requireValue(canonicalJson(legacyKey) === canonicalJson(validateLegacyKey(chain.legacyKey, input.scope)), "inventory_integrity");
    requireValue(head.documentKind === input.documentKind && legacyKey.projectId === input.projectId
      && legacyKey.agentId === input.agentId, "value_conflict");

    const versions = chain.versions as readonly unknown[];
    const headVersion = head.currentVersion as number;
    requireValue(versions.length === headVersion, "inventory_integrity");
    const headNode = ownFields(head.version, [...NODE_FIELDS]);
    const tail = ownFields(versions[headVersion - 1], [...NODE_FIELDS]);
    requireValue(canonicalJson(headNode) === canonicalJson(tail) && tail.versionId === chain.headVersionId, "inventory_integrity");

    const selectedVersion = input.hasVersion ? input.version! : headVersion;
    requireValue(selectedVersion >= 1 && selectedVersion <= headVersion, "value_conflict");
    const selected = ownFields(versions[selectedVersion - 1], [...NODE_FIELDS]);
    requireValue(selected.version === selectedVersion && selected.parentVersion === selectedVersion - 1, "inventory_integrity");
    const object = parseRef(selected.object);
    const payload = { contract: CONTRACT, authorityDigest: checked.digest, legacyKey, documentKind: input.documentKind,
      documentId: input.documentId, headVersion, selectedVersion, parentVersion: selected.parentVersion as number,
      object, relativePath: relativeKey(object) };
    return Object.freeze({ ...payload, digest: digestJson(payload) });
  } catch (error) {
    throw new LayoutValueError(getLayoutValueErrorCode(error) ?? "invalid_value");
  }
}

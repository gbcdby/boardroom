import { canonicalJson, digestJson } from "../storage/maintenance/canonical.ts";
import { getLayoutValueErrorCode, LayoutValueError } from "../storage/maintenance/layout-values.ts";
import { memoryObjectRelativeKey, parseMemoryObjectRef } from "./object-ref.ts";
import type { MemoryObjectRef } from "./object-ref.ts";
import type { MemoryReadSelectorValue } from "./read-projection.ts";
import type { MemoryVersionHeadValue, MemoryVersionScope, MemoryVersionAuthorityValue } from "./version-authority.ts";

type ErrorCode = LayoutValueError["code"];
type LegacyKey = MemoryVersionHeadValue["legacyKey"];
type DocumentKind = MemoryReadSelectorValue["documentKind"];

const CONTRACT = "memory-publication-plan-value/r1" as const;
const SCOPES: readonly MemoryVersionScope[] = Object.freeze(["global", "project", "project-agent"]);
const DOCUMENT_KINDS: readonly DocumentKind[] = Object.freeze(["note"]);
const AUTHORITY_FIELDS = Object.freeze(["contract", "inventoryDigest", "storageId", "layers", "unreferencedObjects", "digest"] as const);
const LAYER_FIELDS = Object.freeze(["scope", "heads", "chains", "objects", "digest"] as const);
const HEAD_FIELDS = Object.freeze(["documentId", "legacyKey", "documentKind", "currentVersion", "updatedAt", "updatedByRaw", "source",
  "sourceRowDigest", "version"] as const);
const CHAIN_FIELDS = Object.freeze(["documentId", "legacyKey", "headVersionId", "versions", "digest"] as const);
const NODE_FIELDS = Object.freeze(["documentId", "versionId", "version", "parentVersion", "object", "relativePath", "actorId",
  "clientMutationId", "summaryRequestId", "authorRaw", "source", "createdAt", "sourceRowDigest"] as const);
const KEY_FIELDS = Object.freeze(["scope", "projectId", "agentId"] as const);
const SELECTOR_FIELDS = Object.freeze(["scope", "projectId", "agentId", "documentKind", "documentId"] as const);
const MAX_NODES = 250_000;
const MAX_BYTES = 32 * 1_048_576;
const MAX_DEPTH = 128;

/** One content-addressed object in a plan. No path, body, permission or durability claim is carried. */
export interface MemoryPublicationObjectValue {
  readonly relativePath: string;
  readonly refDigest: string;
  readonly byteLength: number;
  readonly objectDigest: string;
}

/** Pure planning value. It grants no storage, publication, head-switch or host-loading authority. */
export interface MemoryPublicationPlanValue {
  readonly contract: typeof CONTRACT;
  readonly authorityDigest: string;
  readonly objects: readonly Readonly<MemoryPublicationObjectValue>[];
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
  readonly unreferencedObjects: readonly unknown[];
}

interface SnapshotBudget { nodes: number; bytes: number }

interface ParsedNode {
  readonly value: Record<string, unknown>;
  readonly ref: Readonly<MemoryObjectRef>;
}

interface ParsedChain {
  readonly legacyKey: LegacyKey;
  readonly versions: readonly ParsedNode[];
}

interface ParsedHead {
  readonly legacyKey: LegacyKey;
  readonly documentKind: DocumentKind;
  readonly currentVersion: number;
  readonly version: ParsedNode;
}

interface ParsedLayer {
  readonly refs: Map<string, Readonly<MemoryObjectRef>>;
  readonly heads: Map<string, ParsedHead>;
  readonly chains: Map<string, ParsedChain>;
}

function fail(code: ErrorCode): never { throw new LayoutValueError(code); }
function requireValue(condition: unknown, code: ErrorCode = "invalid_value"): asserts condition {
  if (!condition) fail(code);
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
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
function charge(budget: SnapshotBudget, count: number): void {
  budget.bytes += count;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_BYTES) fail("budget_exceeded");
}
function chargeText(budget: SnapshotBudget, text: string): void {
  if (text.length > MAX_BYTES) fail("budget_exceeded");
  charge(budget, Buffer.byteLength(text, "utf8") + 2);
}

/** Copy frozen data through descriptors only: no caller getter, coercion or mutation is observed. */
function snapshot(value: unknown, budget: SnapshotBudget, depth = 0): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) fail("budget_exceeded");
  if (value === null) { charge(budget, 4); return null; }
  if (typeof value === "string") { chargeText(budget, value); return value; }
  if (typeof value === "boolean") { charge(budget, value ? 4 : 5); return value; }
  if (typeof value === "number") {
    requireValue(Number.isSafeInteger(value) && !Object.is(value, -0));
    charge(budget, String(value).length);
    return value;
  }
  requireValue(typeof value === "object" && Object.isFrozen(value));
  if (Array.isArray(value)) {
    requireValue(Object.getPrototypeOf(value) === Array.prototype);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    requireValue(lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
      && Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0 && lengthDescriptor.value <= MAX_NODES);
    const length = lengthDescriptor.value;
    requireValue(Reflect.ownKeys(value).length === length + 1);
    charge(budget, 2 + Math.max(0, length - 1));
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
  charge(budget, 2 + Math.max(0, keys.length - 1));
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    requireValue(typeof key === "string");
    chargeText(budget, key);
    charge(budget, 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    Object.defineProperty(result, key, { value: snapshot(descriptor.value, budget, depth + 1), enumerable: true });
  }
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

function parseRef(value: unknown): Readonly<MemoryObjectRef> {
  try { return parseMemoryObjectRef(value); }
  catch { return fail("inventory_integrity"); }
}
function relativeKey(ref: Readonly<MemoryObjectRef>): string {
  try { return memoryObjectRelativeKey(ref); }
  catch { return fail("inventory_integrity"); }
}

function validateAuthority(value: unknown): AuthorityInput {
  const safe = snapshot(value, { nodes: 0, bytes: 0 });
  const fields = ownFields(safe, [...AUTHORITY_FIELDS]);
  requireValue(fields.contract === "memory-version-authority-value/r1", "unsupported_shape");
  requireValue(isHash(fields.inventoryDigest) && isHash(fields.digest), "inventory_integrity");
  requireValue(typeof fields.storageId === "string" && fields.storageId.length > 0 && fields.storageId.length <= 128);
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
  return { digest: fields.digest as string, storageId: fields.storageId,
    layers: fields.layers, unreferencedObjects: fields.unreferencedObjects };
}

function parseNode(value: unknown, documentId: string, version: number, parentVersion: number,
  refs: ReadonlyMap<string, Readonly<MemoryObjectRef>>): ParsedNode {
  const node = ownFields(value, [...NODE_FIELDS]);
  requireValue(node.documentId === documentId && typeof node.versionId === "string" && node.versionId.length > 0);
  requireValue(node.version === version && node.parentVersion === parentVersion, "inventory_integrity");
  requireValue(typeof node.actorId === "string" && typeof node.clientMutationId === "string"
    && (node.summaryRequestId === null || typeof node.summaryRequestId === "string")
    && typeof node.authorRaw === "string" && typeof node.source === "string" && typeof node.createdAt === "string"
    && isHash(node.sourceRowDigest));
  const ref = parseRef(node.object);
  requireValue(refs.has(canonicalJson(ref)), "inventory_integrity");
  requireValue(node.relativePath === relativeKey(ref), "inventory_integrity");
  return Object.freeze({ value: node, ref });
}

function inspectAuthority(input: AuthorityInput): readonly ParsedLayer[] {
  const unreferenced = new Set<string>();
  for (const value of input.unreferencedObjects) {
    const ref = parseRef(value);
    requireValue(ref.storageId === input.storageId, "inventory_integrity");
    const key = canonicalJson(ref);
    requireValue(!unreferenced.has(key), "inventory_integrity");
    unreferenced.add(key);
  }

  const digestRefs = new Map<string, Readonly<MemoryObjectRef>>();
  return input.layers.map((layerValue, index) => {
    const layer = ownFields(layerValue, [...LAYER_FIELDS]);
    const scope = SCOPES[index]!;
    const refs = new Map<string, Readonly<MemoryObjectRef>>();
    for (const value of layer.objects as readonly unknown[]) {
      const ref = parseRef(value);
      requireValue(ref.storageId === input.storageId, "inventory_integrity");
      const key = canonicalJson(ref);
      requireValue(!refs.has(key) && !unreferenced.has(key), "inventory_integrity");
      const byDigest = digestRefs.get(ref.contentSha256);
      requireValue(!byDigest || canonicalJson(byDigest) === key, "value_conflict");
      if (!byDigest) digestRefs.set(ref.contentSha256, ref);
      refs.set(key, ref);
    }

    const heads = new Map<string, ParsedHead>();
    for (const value of layer.heads as readonly unknown[]) {
      const head = ownFields(value, [...HEAD_FIELDS]);
      requireValue(typeof head.documentId === "string" && head.documentId.length > 0
        && !heads.has(head.documentId), "inventory_integrity");
      const legacyKey = validateLegacyKey(head.legacyKey, scope);
      requireValue(typeof head.documentKind === "string" && (DOCUMENT_KINDS as readonly string[]).includes(head.documentKind));
      requireValue(typeof head.currentVersion === "number" && Number.isSafeInteger(head.currentVersion)
        && head.currentVersion > 0, "inventory_integrity");
      const version = parseNode(head.version, head.documentId, head.currentVersion, head.currentVersion - 1, refs);
      heads.set(head.documentId, Object.freeze({ legacyKey, documentKind: head.documentKind as DocumentKind,
        currentVersion: head.currentVersion, version }));
    }

    const chains = new Map<string, ParsedChain>();
    const used = new Set<string>();
    for (const value of layer.chains as readonly unknown[]) {
      const chain = ownFields(value, [...CHAIN_FIELDS]);
      requireValue(typeof chain.documentId === "string" && chain.documentId.length > 0
        && !chains.has(chain.documentId), "inventory_integrity");
      const documentId = chain.documentId as string;
      requireValue(typeof chain.headVersionId === "string" && chain.headVersionId.length > 0, "inventory_integrity");
      requireValue(Array.isArray(chain.versions));
      requireValue(digestJson({ documentId, legacyKey: chain.legacyKey,
        headVersionId: chain.headVersionId, versions: chain.versions }) === chain.digest, "inventory_integrity");
      const versions = (chain.versions as readonly unknown[]).map((nodeValue, nodeIndex) => {
        const node = parseNode(nodeValue, documentId, nodeIndex + 1, nodeIndex, refs);
        used.add(canonicalJson(node.ref));
        return node;
      });
      chains.set(documentId, Object.freeze({ legacyKey: validateLegacyKey(chain.legacyKey, scope), versions }));
    }
    requireValue(used.size === refs.size, "incomplete_inventory");
    requireValue(heads.size === chains.size && [...heads.keys()].every(id => chains.has(id)), "inventory_integrity");
    for (const [documentId, head] of heads) {
      const chain = chains.get(documentId)!;
      requireValue(canonicalJson(head.legacyKey) === canonicalJson(chain.legacyKey), "inventory_integrity");
      requireValue(chain.versions.length === head.currentVersion, "inventory_integrity");
      const tail = chain.versions[head.currentVersion - 1]!;
      const headNode = ownFields(head.version.value, [...NODE_FIELDS]);
      requireValue(canonicalJson(headNode) === canonicalJson(tail.value)
        && headNode.versionId === ownFields(chain.versions[head.currentVersion - 1]!.value, [...NODE_FIELDS]).versionId,
      "inventory_integrity");
    }
    return Object.freeze({ refs, heads, chains });
  });
}

function resolveSelector(selector: SelectorInput, layers: readonly ParsedLayer[]): Readonly<MemoryObjectRef> {
  const layer = layers[SCOPES.indexOf(selector.scope)]!;
  const head = layer.heads.get(selector.documentId);
  const chain = layer.chains.get(selector.documentId);
  requireValue(head && chain, "value_conflict");
  const expectedKey = Object.freeze({ scope: selector.scope, projectId: selector.projectId, agentId: selector.agentId });
  requireValue(head.documentKind === selector.documentKind
    && canonicalJson(head.legacyKey) === canonicalJson(expectedKey), "value_conflict");
  const selectedVersion = selector.hasVersion ? selector.version! : head.currentVersion;
  requireValue(selectedVersion >= 1 && selectedVersion <= head.currentVersion, "value_conflict");
  return chain.versions[selectedVersion - 1]!.ref;
}

function entry(ref: Readonly<MemoryObjectRef>): Readonly<MemoryPublicationObjectValue> {
  return Object.freeze({ relativePath: relativeKey(ref), refDigest: digestJson(ref), byteLength: ref.byteLength,
    objectDigest: ref.contentSha256 });
}
function compareEntries(left: Readonly<MemoryPublicationObjectValue>, right: Readonly<MemoryPublicationObjectValue>): number {
  return compareText(left.relativePath, right.relativePath) || compareText(left.refDigest, right.refDigest)
    || left.byteLength - right.byteLength || compareText(left.objectDigest, right.objectDigest);
}

function build(authority: unknown, selector?: unknown): Readonly<MemoryPublicationPlanValue> {
  const checked = validateAuthority(authority);
  const layers = inspectAuthority(checked);
  const selected = selector === undefined ? undefined : validateSelector(selector);
  const objects = selected !== undefined
    ? Object.freeze([entry(resolveSelector(selected, layers))])
    : Object.freeze([...new Map([...layers.flatMap(layer => [...layer.refs.values()])
      .map(ref => [canonicalJson(ref), entry(ref)] as const)]).values()].sort(compareEntries));
  const payload = { contract: CONTRACT, authorityDigest: checked.digest, objects };
  return Object.freeze({ ...payload, digest: digestJson(payload) });
}

/** Pure publication plan from a frozen version authority. No filesystem, database or body is consulted. */
export function buildMemoryPublicationPlan(authority: Readonly<MemoryVersionAuthorityValue>,
  selector?: Readonly<MemoryReadSelectorValue>): Readonly<MemoryPublicationPlanValue> {
  try { return build(authority, selector); }
  catch (error) { throw new LayoutValueError(getLayoutValueErrorCode(error) ?? "invalid_value"); }
}

import { canonicalJson, digestJson, sha256 } from "../storage/maintenance/canonical.ts";
import type { MemoryCollectionObservation } from "../storage/maintenance/layout-memory-collector.ts";
import { buildLayoutMemoryObjectPayloadValues } from "../storage/maintenance/layout-memory-payload-values.ts";
import { getLayoutValueErrorCode, LayoutValueError } from "../storage/maintenance/layout-values.ts";
import type { ReadonlyDeep } from "../storage/maintenance/layout-values.ts";
import { buildMemoryPublicationPlan } from "./publication-plan.ts";
import type { MemoryPublicationObjectValue } from "./publication-plan.ts";
import { projectMemoryRead } from "./read-projection.ts";
import type { MemoryReadSelectorValue } from "./read-projection.ts";
import type { MemoryUnreferencedObjectValue } from "./unreferenced-report.ts";
import { reportUnreferencedObjects } from "./unreferenced-report.ts";
import { parseMemoryObjectRef, memoryObjectRelativeKey } from "./object-ref.ts";
import type { MemoryObjectRef } from "./object-ref.ts";
import { buildMemoryVersionAuthority } from "./version-authority.ts";
import type { MemoryVersionAuthorityValue, MemoryVersionScope } from "./version-authority.ts";

type ErrorCode = LayoutValueError["code"];

const CONTRACT = "memory-authority-envelope-value/r1" as const;
const SCOPES: readonly MemoryVersionScope[] = Object.freeze(["global", "project", "project-agent"]);
const OBSERVATION_FIELDS = Object.freeze(["authority", "contract", "input", "inventory"] as const);
const MAX_NODES = 250_000;
const MAX_BYTES = 32 * 1_048_576;
const MAX_DEPTH = 128;

/** One object linked across payload bytes, ref, authority layer, plan and report. */
export interface MemoryAuthorityEnvelopeObjectValue {
  readonly objectDigest: string;
  readonly refDigest: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly payloadEntryDigest: string;
  readonly payloadBytesDigest: string;
  readonly authorityRefDigest: string;
  readonly authorityScopes: readonly MemoryVersionScope[];
  readonly authorityLayerDigests: readonly string[];
  readonly planEntryDigest: string;
  readonly reportEntryDigest: string | null;
  readonly selectedByRead: boolean;
}

/** Pure assembly of already observed values. It grants no storage, publication or execution authority. */
export interface MemoryAuthorityEnvelopeValue {
  readonly contract: typeof CONTRACT;
  readonly observationContract: "layout-memory-collection-observation/r1";
  readonly authorityLabel: "observation-only";
  readonly observationDigest: string;
  readonly storageId: string;
  readonly inventoryDigest: string;
  readonly payloadDigest: string;
  readonly authorityDigest: string;
  readonly planDigest: string;
  readonly reportDigest: string;
  readonly readDigest: string | null;
  readonly selectedObjectDigest: string | null;
  readonly counts: Readonly<{
    payloadObjects: number;
    authorityRefs: number;
    planObjects: number;
    reportObjects: number;
  }>;
  readonly objects: readonly Readonly<MemoryAuthorityEnvelopeObjectValue>[];
  readonly digest: string;
}

interface SnapshotBudget { nodes: number; bytes: number }

interface PayloadLink {
  readonly ref: Readonly<MemoryObjectRef>;
  readonly relativePath: string;
  readonly payloadEntryDigest: string;
  readonly payloadBytesDigest: string;
}

interface AuthorityLink {
  readonly ref: Readonly<MemoryObjectRef>;
  readonly refDigest: string;
  readonly scopes: MemoryVersionScope[];
  readonly layerDigests: string[];
}

function fail(code: ErrorCode): never { throw new LayoutValueError(code); }
function requireValue(condition: unknown, code: ErrorCode = "invalid_value"): asserts condition {
  if (!condition) fail(code);
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function charge(budget: SnapshotBudget, count: number): void {
  budget.bytes += count;
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes > MAX_BYTES) fail("budget_exceeded");
}
function chargeText(budget: SnapshotBudget, text: string): void {
  if (text.length > MAX_BYTES) fail("budget_exceeded");
  charge(budget, Buffer.byteLength(text, "utf8") + 2);
}
function objectKeys(value: unknown): readonly string[] {
  requireValue(value !== null && typeof value === "object");
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  requireValue(keys.every(key => typeof key === "string"));
  return keys as string[];
}
function ownFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const keys = objectKeys(value);
  requireValue(keys.length === fields.length && fields.every(field => keys.includes(field)));
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    requireValue(descriptor && descriptor.enumerable && "value" in descriptor);
    result[field] = descriptor.value;
  }
  return result;
}

/** Copy the frozen observation through descriptors only: no caller getter, coercion or mutation is observed. */
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

function validateObservation(value: unknown): ReadonlyDeep<MemoryCollectionObservation> {
  const safe = snapshot(value, { nodes: 0, bytes: 0 });
  const fields = ownFields(safe, [...OBSERVATION_FIELDS]);
  requireValue(fields.contract === "layout-memory-collection-observation/r1", "unsupported_shape");
  requireValue(fields.authority === "observation-only", "unsupported_shape");
  requireValue(fields.input !== null && typeof fields.input === "object");
  requireValue(fields.inventory !== null && typeof fields.inventory === "object");
  return safe as ReadonlyDeep<MemoryCollectionObservation>;
}

function parseRef(value: unknown): Readonly<MemoryObjectRef> {
  try { return parseMemoryObjectRef(value); }
  catch { return fail("inventory_integrity"); }
}
function relativeKey(ref: Readonly<MemoryObjectRef>): string {
  try { return memoryObjectRelativeKey(ref); }
  catch { return fail("inventory_integrity"); }
}
function sameKeys(actual: ReadonlyMap<string, unknown>, expected: ReadonlyMap<string, unknown>): boolean {
  return actual.size === expected.size && [...expected.keys()].every(key => actual.has(key));
}
function linkPayloadObjects(payload: ReadonlyDeep<ReturnType<typeof buildLayoutMemoryObjectPayloadValues>>): ReadonlyMap<string, PayloadLink> {
  const links = new Map<string, PayloadLink>();
  for (const entry of payload.objects) {
    const ref = parseRef(entry.object);
    requireValue(/^(?:[0-9a-f]{2})*$/.test(entry.payload.bytesHex), "inventory_integrity");
    const bytesDigest = sha256(Buffer.from(entry.payload.bytesHex, "hex"));
    requireValue(bytesDigest === ref.contentSha256 && entry.payload.sha256 === ref.contentSha256
      && entry.payload.bytes === String(ref.byteLength) && entry.relativePath === relativeKey(ref), "inventory_integrity");
    requireValue(!links.has(ref.contentSha256), "inventory_integrity");
    links.set(ref.contentSha256, Object.freeze({ ref, relativePath: entry.relativePath,
      payloadEntryDigest: digestJson(entry), payloadBytesDigest: bytesDigest }));
  }
  return links;
}
function linkAuthorityObjects(authority: Readonly<MemoryVersionAuthorityValue>): ReadonlyMap<string, AuthorityLink> {
  const links = new Map<string, AuthorityLink>();
  const register = (value: unknown, scope: MemoryVersionScope | null, layerDigest: string | null): AuthorityLink => {
    const ref = parseRef(value);
    requireValue(ref.storageId === authority.storageId, "inventory_integrity");
    const refDigest = digestJson(ref);
    const digest = ref.contentSha256;
    const prior = links.get(digest);
    requireValue(!prior || prior.refDigest === refDigest, "value_conflict");
    if (prior) {
      if (scope !== null && !prior.scopes.includes(scope)) prior.scopes.push(scope);
      if (layerDigest !== null && !prior.layerDigests.includes(layerDigest)) prior.layerDigests.push(layerDigest);
      return prior;
    }
    const created: AuthorityLink = { ref, refDigest, scopes: scope === null ? [] : [scope],
      layerDigests: layerDigest === null ? [] : [layerDigest] };
    links.set(digest, created);
    return created;
  };
  for (const [index, layer] of authority.layers.entries()) {
    requireValue(layer.scope === SCOPES[index], "unsupported_shape");
    requireValue(layer.digest === digestJson({ scope: layer.scope, heads: layer.heads, chains: layer.chains, objects: layer.objects }),
      "inventory_integrity");
    for (const value of layer.objects) register(value, layer.scope, layer.digest);
  }
  for (const value of authority.unreferencedObjects) register(value, null, null);
  return links;
}
function linkPlanObjects(planObjects: readonly Readonly<MemoryPublicationObjectValue>[],
  payload: ReadonlyMap<string, PayloadLink>): ReadonlyMap<string, Readonly<MemoryPublicationObjectValue>> {
  const links = new Map<string, Readonly<MemoryPublicationObjectValue>>();
  for (const value of planObjects) {
    requireValue(!links.has(value.objectDigest), "inventory_integrity");
    requireValue(payload.has(value.objectDigest), "inventory_integrity");
    const item = payload.get(value.objectDigest)!;
    requireValue(canonicalJson(value) === canonicalJson({ relativePath: item.relativePath, refDigest: digestJson(item.ref),
      byteLength: item.ref.byteLength, objectDigest: value.objectDigest }), "value_conflict");
    links.set(value.objectDigest, value);
  }
  return links;
}
function linkReportObjects(reportObjects: readonly Readonly<MemoryUnreferencedObjectValue>[],
  payload: ReadonlyMap<string, PayloadLink>): ReadonlyMap<string, Readonly<MemoryUnreferencedObjectValue>> {
  const links = new Map<string, Readonly<MemoryUnreferencedObjectValue>>();
  for (const value of reportObjects) {
    requireValue(!links.has(value.objectDigest), "inventory_integrity");
    requireValue(payload.has(value.objectDigest), "inventory_integrity");
    const item = payload.get(value.objectDigest)!;
    requireValue(canonicalJson(value) === canonicalJson({ relativePath: item.relativePath, refDigest: digestJson(item.ref),
      objectDigest: value.objectDigest }), "value_conflict");
    links.set(value.objectDigest, value);
  }
  return links;
}

function build(observation: ReadonlyDeep<MemoryCollectionObservation>, selector?: Readonly<MemoryReadSelectorValue>): Readonly<MemoryAuthorityEnvelopeValue> {
  const checked = validateObservation(observation);
  const payload = buildLayoutMemoryObjectPayloadValues(checked.input);
  requireValue(canonicalJson(payload.inventory) === canonicalJson(checked.inventory), "inventory_integrity");
  const authority = buildMemoryVersionAuthority(payload.inventory);
  // 全量发布计划刻意不传 selector：本信封要证明 payload/ref/authority/plan/report
  // 五向一一对应，selector 只经 projectMemoryRead 附加一个读投影，不收窄对象集合。
  const plan = buildMemoryPublicationPlan(authority);
  const report = reportUnreferencedObjects(authority);
  const read = selector === undefined ? null : projectMemoryRead(authority, selector);
  requireValue(plan.authorityDigest === authority.digest && report.authorityDigest === authority.digest
    && (read === null || read.authorityDigest === authority.digest), "inventory_integrity");

  const payloadLinks = linkPayloadObjects(payload);
  const authorityLinks = linkAuthorityObjects(authority);
  requireValue(sameKeys(authorityLinks, payloadLinks), "inventory_integrity");
  const planLinks = linkPlanObjects(plan.objects, payloadLinks);
  requireValue(sameKeys(planLinks, payloadLinks), "inventory_integrity");
  const reportLinks = linkReportObjects(report.objects, payloadLinks);
  const selectedObjectDigest = read === null ? null : read.object.contentSha256;
  requireValue(selectedObjectDigest === null || payloadLinks.has(selectedObjectDigest), "value_conflict");

  const objects: Readonly<MemoryAuthorityEnvelopeObjectValue>[] = [...payloadLinks.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([objectDigest, item]) => {
      const linked = authorityLinks.get(objectDigest)!;
      requireValue(linked.refDigest === digestJson(item.ref)
        && linked.ref.byteLength === item.ref.byteLength, "value_conflict");
      const planEntry = planLinks.get(objectDigest)!;
      const reportEntry = reportLinks.get(objectDigest) ?? null;
      return Object.freeze({
        objectDigest, refDigest: digestJson(item.ref), relativePath: item.relativePath,
        byteLength: item.ref.byteLength, payloadEntryDigest: item.payloadEntryDigest, payloadBytesDigest: item.payloadBytesDigest,
        authorityRefDigest: linked.refDigest, authorityScopes: Object.freeze([...linked.scopes].sort(compareText)),
        authorityLayerDigests: Object.freeze([...linked.layerDigests].sort(compareText)),
        planEntryDigest: digestJson(planEntry), reportEntryDigest: reportEntry === null ? null : digestJson(reportEntry),
        selectedByRead: selectedObjectDigest === objectDigest,
      });
    });
  const counts = Object.freeze({ payloadObjects: payloadLinks.size, authorityRefs: authorityLinks.size,
    planObjects: planLinks.size, reportObjects: reportLinks.size });
  const body = {
    contract: CONTRACT, observationContract: "layout-memory-collection-observation/r1" as const,
    authorityLabel: "observation-only" as const, observationDigest: digestJson(checked), storageId: authority.storageId,
    inventoryDigest: authority.inventoryDigest, payloadDigest: digestJson(payload), authorityDigest: authority.digest,
    planDigest: plan.digest, reportDigest: report.digest, readDigest: read === null ? null : read.digest,
    selectedObjectDigest, counts, objects: Object.freeze(objects),
  };
  return Object.freeze({ ...body, digest: digestJson(body) });
}

/**
 * Pure observation-to-authority envelope assembly. The result is a value-only
 * audit trail; it grants no storage, publication, head-switch or host capability.
 */
export function buildMemoryAuthorityEnvelope(observation: ReadonlyDeep<MemoryCollectionObservation>,
  selector?: Readonly<MemoryReadSelectorValue>): Readonly<MemoryAuthorityEnvelopeValue> {
  try { return build(observation, selector); }
  catch (error) { throw new LayoutValueError(getLayoutValueErrorCode(error) ?? "invalid_value"); }
}

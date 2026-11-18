import { createHash } from "node:crypto";
import { z } from "zod";
import { parseProfileContent, parseBindingOrdinaryContent, parseLegacyConfigSnapshotRef,
  parseLegacySourceValue } from "./m2-config-values.ts";
import { parseProfileOriginHistoryValue, parseProfileAuthorityImportValue, profileAuthorityImportValueDigest,
  ProfileAuthorityValueError } from "./profile-authority-values.ts";
import { canonicalJson } from "../storage/maintenance/canonical.ts";
import { ref as artifactSchema, source as sourceSchema } from "../storage/maintenance/parse-primitives.ts";
import { M2_FORMAT_REGISTRATION } from "./m2-value-contracts.ts";
import type { ReadonlyDeep, M2ValueErrorCode, M2ValueResult, M2ValueTypes, ParsedM2Value, M2DigestValue,
  M2DigestBodies, ConfigSnapshot, WorkspaceMapping, DetachConfigSnapshot, ProfileVersion, BindingVersion,
  CurrentAdvancedSelection, CurrentAdvancedBasis, CurrentAdvancedView, SourceBinding, ActivationReceipt,
  LegacyCaptureBody, MutationReceiptValue, AuthorityRowValue, SourcePair, SelectedConfigSource, RuntimeConfig,
  Backend, Strategy, ExistingAdvancedScope, BindingContent, ProfileRef, BindingConfigRef, ActivationRef,
  ExecutionAttachmentRef, ConfigSnapshotRef, WorkspaceMappingRef, WorkspaceRef, DetachConfigSnapshotRef } from "./m2-value-contracts.ts";

const MAX_BYTES = 16_777_216, MAX_DEPTH = 64, MAX_NODES = 250_000;
const failures = new WeakMap<object, M2ValueErrorCode>();
function fail(code: M2ValueErrorCode): never { const error = Object.create(null) as object; failures.set(error, code); throw error; }
function conflict(condition: boolean): asserts condition { if (!condition) fail("value_conflict"); }
function frozen<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object") { for (const v of Object.values(value)) frozen(v); Object.freeze(value); }
  return value as ReadonlyDeep<T>;
}
// INPUT-ISOLATION-DELTA: fixed standard shapes, never a module-load trust snapshot.
// E1/P1 allocate ordinary objects internally; admit ambient prototypes before they run.
const OBJECT_METHODS = Object.freeze("constructor __defineGetter__ __defineSetter__ hasOwnProperty __lookupGetter__ __lookupSetter__ isPrototypeOf propertyIsEnumerable toString valueOf toLocaleString".split(" "));
const ARRAY_METHODS = Object.freeze("constructor at concat copyWithin fill find findIndex findLast findLastIndex lastIndexOf pop push reverse shift unshift slice sort splice includes indexOf join keys entries values forEach filter flat flatMap map every some reduce reduceRight toReversed toSorted toSpliced with toLocaleString toString".split(" "));
const UNSCOPABLES = Object.freeze("at copyWithin entries fill find findIndex findLast findLastIndex flat flatMap includes keys toReversed toSorted toSpliced values".split(" "));
type PrototypeState = Map<object, Map<PropertyKey, PropertyDescriptor>>;
function ownData(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") && Object.hasOwn(descriptor, "writable")
    && !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set");
}
function prototypeState(previous?: PrototypeState): PrototypeState {
  const state: PrototypeState = new Map();
  const require = (condition: unknown): void => { if (!condition) fail("invalid_value"); };
  require(Object.getPrototypeOf(Object.prototype) === null && Object.getPrototypeOf(Array.prototype) === Object.prototype);
  const inspect = (prototype: object, methods: readonly string[], kind: "object" | "array" | "unscopables") => {
    const keys = Reflect.ownKeys(prototype), descriptors = new Map<PropertyKey, PropertyDescriptor>();
    require(keys.length === methods.length + (kind === "object" ? 1 : kind === "array" ? 3 : 0));
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!, d = Object.getOwnPropertyDescriptor(prototype, key);
      if (!d || !Object.hasOwn(d, "enumerable") || !Object.hasOwn(d, "configurable")) fail("invalid_value");
      const method = typeof key === "string" && methods.includes(key);
      if (kind === "object" && key === "__proto__") {
        require(!Object.hasOwn(d, "value") && !Object.hasOwn(d, "writable") && Object.hasOwn(d, "get") && Object.hasOwn(d, "set")
          && typeof d.get === "function" && typeof d.set === "function" && d.enumerable === false && d.configurable === true);
      } else if (kind === "array" && key === "length") {
        require(ownData(d) && d.value === 0 && d.writable === true && d.enumerable === false && d.configurable === false);
      } else if (kind === "array" && key === Symbol.unscopables) {
        require(ownData(d) && d.value !== null && typeof d.value === "object" && d.writable === false && d.enumerable === false && d.configurable === true);
      } else if (kind === "unscopables" && method) {
        require(ownData(d) && d.value === true && d.writable === true && d.enumerable === true && d.configurable === true);
      } else {
        require((method || kind === "array" && key === Symbol.iterator) && ownData(d)
          && typeof d.value === "function" && d.writable === true && d.enumerable === false && d.configurable === true);
      }
      if (previous) {
        const old = previous.get(prototype)?.get(key);
        if (!old) fail("invalid_value");
        for (const field of ["value", "writable", "get", "set", "enumerable", "configurable"] as const) {
          const present = Object.hasOwn(d, field);
          require(present === Object.hasOwn(old, field) && (!present || Object.is(d[field], old[field])));
        }
      }
      descriptors.set(key, d);
    }
    state.set(prototype, descriptors);
    return descriptors;
  };
  inspect(Object.prototype, OBJECT_METHODS, "object");
  const array = inspect(Array.prototype, ARRAY_METHODS, "array");
  const iterator = array.get(Symbol.iterator), values = array.get("values"), unscopables = array.get(Symbol.unscopables);
  if (!ownData(iterator) || !ownData(values) || !ownData(unscopables)) fail("invalid_value");
  require(iterator.value === values.value);
  const exclusions = unscopables.value;
  if (exclusions === null || typeof exclusions !== "object") fail("invalid_value");
  require(Object.getPrototypeOf(exclusions) === null);
  inspect(exclusions, UNSCOPABLES, "unscopables");
  return state;
}
class Budget {
  nodes = 0;
  bytes = 0;
  charge(n: number) { if ((this.bytes += n) > MAX_BYTES) fail("budget_exceeded"); }
  stringSize(text: string) {
    if (text.length > MAX_BYTES) fail("budget_exceeded");
    let n = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34 || c === 92) n += 2;
      else if (c < 32) n += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
      else if (c < 128) n++;
      else if (c < 2048) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
      if (n > MAX_BYTES - this.bytes) fail("budget_exceeded");
    }
    this.charge(n);
  }
  copy(input: unknown, countBytes = true, offset = 0): unknown {
    const ancestors = new Set<object>();
    const charge = (n: number) => { if (countBytes) this.charge(n); };
    const stringSize = (s: string) => { if (countBytes) this.stringSize(s); };
    const visit = (item: unknown, depth: number): unknown => {
      if (++this.nodes > MAX_NODES || depth > MAX_DEPTH) fail("budget_exceeded");
      if (item === null) { charge(4); return null; }
      if (typeof item === "string") { stringSize(item); return item; }
      if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
      if (typeof item === "number") { if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail("invalid_value"); charge(String(item).length); return item; }
      if (typeof item !== "object" || ancestors.has(item)) fail("invalid_value");
      const array = Array.isArray(item), proto: unknown = Object.getPrototypeOf(item);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail("invalid_value");
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_NODES + (array ? 1 : 0)) fail("budget_exceeded");
      if (keys.some(k => typeof k !== "string")) fail("invalid_value");
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of keys as string[]) { const d = Object.getOwnPropertyDescriptor(item, key); if (!d) fail("invalid_value"); descriptors.set(key, d); }
      ancestors.add(item);
      try {
        if (array) {
          const lengthDescriptor = descriptors.get("length");
          if (!ownData(lengthDescriptor) || lengthDescriptor.enumerable !== false) fail("invalid_value");
          const length: unknown = lengthDescriptor.value;
          if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) fail("invalid_value");
          if (length > MAX_NODES) fail("budget_exceeded");
          if (keys.length !== length + 1) fail("invalid_value");
          charge(2 + Math.max(0, length - 1)); const out: unknown[] = [];
          for (let i = 0; i < length; i++) { const d = descriptors.get(String(i)); if (!ownData(d) || d.enumerable !== true) fail("invalid_value");
            Object.defineProperty(out, String(i), { __proto__: null, value: visit(d.value, depth + 1), enumerable: true, configurable: true, writable: true } as PropertyDescriptor); }
          return Object.freeze(out);
        }
        charge(2 + Math.max(0, keys.length - 1)); const out = Object.create(null) as Record<string, unknown>;
        for (const key of keys as string[]) { const d = descriptors.get(key)!; if (!ownData(d) || d.enumerable !== true) fail("invalid_value");
          stringSize(key); charge(1); Object.defineProperty(out, key, { __proto__: null, value: visit(d.value, depth + 1), enumerable: true } as PropertyDescriptor); }
        return Object.freeze(out);
      } finally { ancestors.delete(item); }
    };
    return visit(input, offset);
  }
  json(text: string, offset: number): unknown {
    // Preflight before JSON.parse allocates any deep/wide structure. The original string bytes
    // were already charged by the outer copy; the parsed nodes share this same call budget.
    const stack: string[] = []; let wantValue = true, nodes = 0;
    const node = () => { if (this.nodes + ++nodes > MAX_NODES || stack.length + offset > MAX_DEPTH) fail("budget_exceeded"); };
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!; if (/\s/.test(c)) continue;
      if (c === "{") { node(); stack.push("object"); wantValue = false; }
      else if (c === "[") { node(); stack.push("array"); wantValue = true; }
      else if (c === "}" || c === "]") { stack.pop(); wantValue = false; }
      else if (c === ":") wantValue = true;
      else if (c === ",") wantValue = stack.at(-1) === "array";
      else if (c === '"') { if (wantValue) node(); for (i++; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; } wantValue = false; }
      else { if (wantValue) node(); while (i + 1 < text.length && !/[\s,}:\]]/.test(text[i + 1]!)) i++; wantValue = false; }
    }
    return this.copy(JSON.parse(text), false, offset);
  }
}
function total<T>(input: unknown, body: (value: unknown, budget: Budget) => T): M2ValueResult<T> {
  try {
    const environment = prototypeState(), budget = new Budget(), copy = budget.copy(input);
    prototypeState(environment); // All caller reflection has returned; E1/P1 receive only isolated data.
    const value = body(copy, budget); prototypeState(environment);
    return frozen({ ok: true as const, classification: "value-consistent" as const, value });
  }
  catch (error) { const code = error !== null && (typeof error === "object" || typeof error === "function") ? failures.get(error) : undefined;
    return frozen({ ok: false as const, error: { code: code ?? "invalid_value" } }); }
}
function parse<T, Input>(schema: z.ZodType<T, z.ZodTypeDef, Input>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const atPath = (path: (string | number)[]) => path.reduce<unknown>((item, key) =>
    item !== null && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined, value);
  const future = result.error.issues.some(i => i.code === "invalid_enum_value" && typeof i.received === "string"
    || i.code === "invalid_union_discriminator" && typeof atPath(i.path) === "string"
    || i.code === "invalid_literal" && typeof i.expected === "string" && typeof i.received === "string"
    || i.code === "invalid_literal" && typeof i.expected === "number" && typeof i.received === "number"
      && ["configVersion", "protocolBefore", "protocolAfter"].includes(String(i.path.at(-1))));
  fail(future ? "unsupported_shape" : "invalid_value");
}
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
// Known DTO keys are ASCII. Codepoint comparison is still explicit for the frozen C-R3 domain.
function r3(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(r3).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const cp = (a: string, b: string) => { const aa = Array.from(a), bb = Array.from(b); for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      const delta = aa[i]!.codePointAt(0)! - bb[i]!.codePointAt(0)!; if (delta) return delta; } return aa.length - bb.length; };
    return `{${Object.keys(value).sort(cp).map(k => `${JSON.stringify(k)}:${r3((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const requiredValue = z.unknown().refine(v => v !== undefined);
const id = z.string().min(1), digest = z.string().regex(/^[0-9a-f]{64}$/), revision = z.number().int().positive().safe();
const backend = z.enum(["claude-code", "codex-cli", "dsh"]), strategy = z.literal("bypassPermissions");
const permission = z.enum(["auto", "manual", "workspace-write"]), tools = z.array(z.string()).nullable();
const profileRef = z.object({ agentId: id, profileRevision: revision, contentDigest: digest }).strict();
const bindingRef = z.object({ groupBindingId: id, bindingConfigRevision: revision, contentDigest: digest }).strict();
const captureRef = z.object({ captureId: id, sourceDigest: digest, artifactDigest: digest }).strict();
const snapshotRef = z.object({ snapshotId: id, contentDigest: digest }).strict();
const mappingRef = z.object({ mappingId: id, contentDigest: digest }).strict();
const detachRef = z.object({ detachSnapshotId: id, contentDigest: digest }).strict();
const workspaceRef = z.object({ projectId: id, workspaceRevision: revision }).strict();
const rootIdentity = z.object({ device: id, inode: id, birthtimeNs: id }).strict();
const evidenceRef = z.object({ artifactId: id, digest }).strict();
const activationRef = z.object({ activationId: id, digest }).strict();
const planRef = z.object({ planId: id, digest }).strict();
const versions = z.object({ runtimeRevision: revision, bindingRevision: revision }).strict();
const attachment = z.object({ executionBindingId: id, groupBindingId: id, runtimeId: id }).strict();
const config = z.object({ model: z.string().nullable(), workdir: id, tools, systemPrompt: z.string(), permissionMode: permission }).strict();
const originalSelection = versions.extend({ strategy }).strict();
const envelope = z.object({ kind: z.string(), value: requiredValue }).strict();
const hashEnvelope = z.object({ kind: z.string(), body: requiredValue }).strict();
function profile(value: unknown) { try { return parseProfileContent(value); } catch { return fail("invalid_value"); } }

const legacyRefSchema = z.object({ authority: z.literal("legacy"), kind: z.enum(["effective", "requestedSnapshot", "applied"]),
  sourceId: id, runtimeId: id, bindingId: id, agentId: id, digest, versions, configVersion: z.literal(1) }).strict();
const scopeSchema = z.object({ sourceIdentityDigest: digest, agentId: id, executionBindingId: id, projectId: id, groupId: id,
  memberId: id, membershipRevision: revision, permissionMode: permission, tools }).strict();
const basisSchema = z.object({ profileRef, bindingConfigRevision: revision, backend: z.literal("claude-code"), ordinaryConfigDigest: digest,
  root: z.object({ workspaceRef, canonicalRoot: id, physicalResourceKey: id, rootIdentity }).strict(), existingScope: scopeSchema,
  existingPermissionScopeDigest: digest, compatibilityBasis: versions.nullable() }).strict();
const advancedSchema = z.discriminatedUnion("state", [z.object({ state: z.literal("none") }).strict(),
  z.object({ state: z.literal("selected"), strategy, basis: basisSchema, origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("legacy_equivalence"), captureRef, legacyRef: legacyRefSchema }).strict(),
    z.object({ kind: z.literal("explicit_compat_request"), requestId: id }).strict()]) }).strict(),
  z.object({ state: z.literal("retained_inactive"), original: originalSelection, captureRef,
    reason: z.enum(["invalidated_by_revision", "migration_reconfirmation_required"]) }).strict()]);
const validity = z.enum(["not_selected", "effective", "invalidated_by_revision", "migration_reconfirmation_required"]);
const viewSchema = z.object({ stored: advancedSchema, effectiveStrategy: strategy.nullable(), validity, blockedReasons: z.array(z.string()) }).strict();
const sourceBindingSchema = z.discriminatedUnion("kind", [
  z.object({ contract: z.literal("m2-source-binding/r1"), kind: z.literal("legacy"), physicalSourceRef: evidenceRef }).strict(),
  z.object({ contract: z.literal("m2-source-binding/r1"), kind: z.literal("local"), physicalSourceRef: evidenceRef, activation: activationRef }).strict(),
  z.object({ contract: z.literal("m2-source-binding/r1"), kind: z.literal("imported"), importArtifact: artifactSchema, importValueDigest: digest }).strict()]);
const guardSchema = z.object({ protocolBefore: z.literal(1), protocolAfter: z.literal(2), guardBeforeDigest: digest, guardAfterDigest: digest,
  schemaBeforeDigest: digest, schemaAfterDigest: digest, writerFormat: z.literal("s2-profile-config/v1"), writerFormatDigest: digest,
  registeredUpgrade: evidenceRef }).strict();
const receiptBodySchema = z.object({ requestId: id, planRef, physicalSourceRef: evidenceRef, snapshotReceiptRef: evidenceRef, captureRef,
  schemaBeforeDigest: digest, schemaAfterDigest: digest, guardTransition: guardSchema, allowedDeltaManifest: evidenceRef,
  targetRowsDigest: digest, sourceToTargetManifest: evidenceRef, committedAuthority: z.literal("profile") }).strict();
const receiptSchema = receiptBodySchema.extend({ ref: activationRef }).strict();
function legacyReference(value: unknown) {
  const v = parse(legacyRefSchema, value); conflict(v.sourceId === v.bindingId);
  try { return parseLegacyConfigSnapshotRef(v); } catch { return fail("invalid_value"); }
}
function advanced(value: unknown): CurrentAdvancedSelection {
  const v = parse(advancedSchema, value);
  if (v.state === "selected") {
    const b = v.basis;
    conflict(b.root.workspaceRef.projectId === b.existingScope.projectId && b.profileRef.agentId === b.existingScope.agentId);
    conflict(b.existingPermissionScopeDigest === hash(r3(b.existingScope)));
    if (v.origin.kind === "explicit_compat_request") conflict(b.compatibilityBasis !== null);
    else { const l = legacyReference(v.origin.legacyRef);
      conflict(l.agentId === b.existingScope.agentId && l.bindingId === b.existingScope.executionBindingId);
      if (b.compatibilityBasis !== null) conflict(same(b.compatibilityBasis, l.versions)); }
  }
  return v;
}
function view(value: unknown): CurrentAdvancedView {
  const v = parse(viewSchema, value), a = advanced(v.stored);
  if (a.state === "none") conflict(v.validity === "not_selected" && v.effectiveStrategy === null);
  else if (a.state === "retained_inactive") conflict(v.validity === a.reason && v.effectiveStrategy === null);
  else conflict(v.validity !== "not_selected" && (v.validity === "effective" ? v.effectiveStrategy === a.strategy : v.effectiveStrategy === null));
  return v;
}
function bindingContent(value: unknown): BindingContent {
  const v = parse(z.object({ roleRef: requiredValue, profileOverrides: requiredValue, currentAdvanced: requiredValue }).strict(), value);
  let ordinary; try { ordinary = parseBindingOrdinaryContent({ roleRef: v.roleRef, profileOverrides: v.profileOverrides }); }
  catch { return fail("invalid_value"); }
  return { ...ordinary, currentAdvanced: advanced(v.currentAdvanced) };
}
function selectedScope(a: CurrentAdvancedSelection, scope: { agentId: string; projectId: string; groupId: string; memberId: string }, ref: BindingConfigRef) {
  if (a.state !== "selected") return;
  const b = a.basis;
  conflict(b.bindingConfigRevision === ref.bindingConfigRevision && b.profileRef.agentId === scope.agentId
    && b.existingScope.agentId === scope.agentId && b.existingScope.projectId === scope.projectId
    && b.existingScope.groupId === scope.groupId && b.existingScope.memberId === scope.memberId);
}
function profileVersion(value: unknown): ProfileVersion {
  const v = parse(z.object({ ref: profileRef, content: requiredValue }).strict(), value), content = profile(v.content);
  conflict(v.ref.contentDigest === hash(r3(content))); return { ref: v.ref, content };
}
function bindingVersion(value: unknown): BindingVersion {
  const v = parse(z.object({ ref: bindingRef, agentId: id, projectId: id, groupId: id, memberId: id, content: requiredValue }).strict(), value);
  const content = bindingContent(v.content); selectedScope(content.currentAdvanced, v, v.ref);
  conflict(v.ref.contentDigest === hash(r3(content))); return { ...v, content };
}
function receiptBody(value: unknown) {
  const v = parse(receiptBodySchema, value);
  conflict(v.schemaBeforeDigest === v.guardTransition.schemaBeforeDigest && v.schemaAfterDigest === v.guardTransition.schemaAfterDigest);
  return v;
}
function receipt(value: unknown): ActivationReceipt {
  const { ref, ...body } = parse(receiptSchema, value); const v = receiptBody(body);
  conflict(ref.digest === hash(r3(v))); return { ref, ...v };
}
function sourceBinding(value: unknown): SourceBinding { return parse(sourceBindingSchema, value); }
const legacyAdvanced = z.object({ originalSelection: originalSelection.nullable(),
  originalValidity: z.enum(["not_selected", "effective", "invalidated_by_revision"]),
  mappedValidity: z.enum(["not_selected", "equivalent", "invalidated_by_revision", "migration_reconfirmation_required"]),
  equivalenceEvidenceDigest: digest.nullable() }).strict();
const snapshotBodySchema = z.object({ agentId: id, groupBindingId: id, executionBindingId: id.nullable(), memberId: id, projectId: id, groupId: id,
  backend, config, advancedStrategy: strategy.nullable(), semanticDigest: digest,
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("legacy"), legacyRef: legacyRefSchema, raw: z.object({ captureRef, rawJson: z.string().nullable(),
      rawDigest: digest.nullable(), rawAdvancedJson: z.string().nullable(), rawAdvancedDigest: digest.nullable() }).strict() }).strict(),
    z.object({ kind: z.literal("profile"), profileRef, bindingRef }).strict()]),
  advancedBasis: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("legacy"), legacy: legacyAdvanced }).strict(),
    z.object({ kind: z.literal("profile"), bindingRef, currentSelection: advancedSchema, resolved: validity }).strict()]),
  legacyAlias: z.object({ displayName: z.string(), hostType: z.string() }).strict().nullable() }).strict();
const snapshotSchema = snapshotBodySchema.extend({ ref: snapshotRef }).strict();
const mappingBodySchema = z.object({ configSnapshotRef: snapshotRef, workspaceRef, originalWorkdir: id, canonicalRoot: id,
  rootIdentity, physicalResourceKey: id, observedAt: id, observationOnly: z.literal(true), requiresRevalidation: z.literal(true), runReady: z.literal(false) }).strict();
const mappingSchema = mappingBodySchema.extend({ ref: mappingRef }).strict();
const selectedSource = z.discriminatedUnion("state", [z.object({ state: z.literal("mapped"), snapshotRef, mappingRef }).strict(),
  z.object({ state: z.literal("blocked"), snapshotRef, reasons: z.array(z.string()).nonempty() }).strict()]);
const detachRootSchema = z.discriminatedUnion("state", [z.object({ state: z.literal("fixed_reference"), workspaceRef, mappingRef: mappingRef.nullable(),
  canonicalRoot: id, physicalResourceKey: id, rootIdentity, observedAt: id, requiresRevalidation: z.literal(true), runReady: z.literal(false) }).strict(),
  z.object({ state: z.literal("missing"), workspaceRef: workspaceRef.nullable(), reasons: z.array(z.string()).nonempty(), runReady: z.literal(false) }).strict()]);
const resolutionSchema = z.discriminatedUnion("state", [z.object({ state: z.literal("complete"), backend, config,
  advancedStrategy: strategy.nullable(), semanticDigest: digest }).strict(), z.object({ state: z.literal("incomplete"), backend: backend.nullable(),
    partialConfig: config.extend({ workdir: z.string() }).partial().strict().transform(v => v as Partial<RuntimeConfig>), reasons: z.array(z.string()).nonempty() }).strict()]);
const detachBodySchema = z.object({ attachment, profileRef, bindingRef, root: detachRootSchema, currentAdvanced: viewSchema,
  resolution: resolutionSchema, requested: selectedSource.nullable(), applied: selectedSource.nullable(), observedAt: id,
  readOnly: z.literal(true), runReady: z.literal(false) }).strict();
const detachSchema = detachBodySchema.extend({ ref: detachRef }).strict();
function semantic(backend: Backend, config: RuntimeConfig, advancedStrategy: Strategy | null) {
  // C-SEM keeps the exact legacy property order and primitive escaping without object toJSON lookup.
  const tools = config.tools === null ? "null" : `[${config.tools.map(value => JSON.stringify(value)).join(",")}]`;
  return hash(`{"backend":${JSON.stringify(backend)},"config":{"model":${JSON.stringify(config.model)},"workdir":${JSON.stringify(config.workdir)},"tools":${tools},"systemPrompt":${JSON.stringify(config.systemPrompt)},"permissionMode":${JSON.stringify(config.permissionMode)}},"advancedStrategy":${JSON.stringify(advancedStrategy)}}`);
}
function effectiveBasis(b: CurrentAdvancedBasis, p: ProfileRef, backend: Backend, cfg: RuntimeConfig) {
  conflict(same(b.profileRef, p) && b.backend === backend && b.ordinaryConfigDigest === hash(r3({ backend, config: cfg })));
}
function snapshotBody(value: unknown, budget: Budget, jsonDepth = 5): Omit<ConfigSnapshot, "ref"> {
  const v = parse(snapshotBodySchema, value);
  conflict(v.semanticDigest === semantic(v.backend, v.config, v.advancedStrategy));
  conflict(v.advancedStrategy === null || v.backend === "claude-code");
  conflict(v.origin.kind === v.advancedBasis.kind);
  if (v.origin.kind === "legacy" && v.advancedBasis.kind === "legacy") {
    const l = legacyReference(v.origin.legacyRef), raw = v.origin.raw, a = v.advancedBasis.legacy;
    conflict(l.agentId === v.agentId && (v.executionBindingId === null ? l.kind === "effective" : l.bindingId === v.executionBindingId));
    if (raw.rawJson !== null) budget.json(raw.rawJson, jsonDepth);
    const rawSelection = raw.rawAdvancedJson === null ? null : parse(originalSelection, budget.json(raw.rawAdvancedJson, jsonDepth));
    conflict(same(rawSelection, a.originalSelection));
    conflict((a.originalSelection === null) === (a.originalValidity === "not_selected"));
    if (a.originalSelection === null) conflict(a.mappedValidity === "not_selected" && a.equivalenceEvidenceDigest === null);
    else conflict(a.mappedValidity !== "not_selected");
    if (a.mappedValidity === "equivalent") conflict(a.originalValidity === "effective" && a.equivalenceEvidenceDigest !== null);
    try { parseLegacySourceValue({ ref: l, snapshot: { backend: v.backend, config: v.config, versions: l.versions,
      advancedStrategy: v.advancedStrategy, digest: v.semanticDigest }, rawJson: raw.rawJson, rawDigest: raw.rawDigest,
      rawAdvancedJson: raw.rawAdvancedJson, rawAdvancedDigest: raw.rawAdvancedDigest }); }
    catch { fail("value_conflict"); }
  } else if (v.origin.kind === "profile" && v.advancedBasis.kind === "profile") {
    const a = v.advancedBasis, selection = advanced(a.currentSelection);
    conflict(v.origin.profileRef.agentId === v.agentId && v.origin.bindingRef.groupBindingId === v.groupBindingId && same(a.bindingRef, v.origin.bindingRef));
    view({ stored: selection, effectiveStrategy: v.advancedStrategy, validity: a.resolved, blockedReasons: [] });
    selectedScope(selection, v, v.origin.bindingRef);
    if (selection.state === "selected") {
      if (v.executionBindingId !== null) conflict(selection.basis.existingScope.executionBindingId === v.executionBindingId);
      if (a.resolved === "effective") effectiveBasis(selection.basis, v.origin.profileRef, v.backend, v.config);
    }
  }
  return v;
}
function snapshot(value: unknown, budget: Budget, jsonDepth = 5): ConfigSnapshot {
  const { ref, ...body } = parse(snapshotSchema, value), v = snapshotBody(body, budget, jsonDepth);
  conflict(ref.contentDigest === hash(r3(v))); return { ref, ...v };
}
function mapping(value: unknown): WorkspaceMapping {
  const { ref, ...body } = parse(mappingSchema, value);
  conflict(ref.contentDigest === hash(r3(body))); return { ref, ...body };
}
function detachBody(value: unknown): Omit<DetachConfigSnapshot, "ref"> {
  const v = parse(detachBodySchema, value); view(v.currentAdvanced);
  conflict(v.bindingRef.groupBindingId === v.attachment.groupBindingId);
  if (v.resolution.state === "complete") {
    conflict(v.resolution.semanticDigest === semantic(v.resolution.backend, v.resolution.config, v.resolution.advancedStrategy));
    conflict(v.resolution.advancedStrategy === v.currentAdvanced.effectiveStrategy);
    conflict(v.resolution.advancedStrategy === null || v.resolution.backend === "claude-code");
  }
  return v;
}
function detach(value: unknown): DetachConfigSnapshot {
  const { ref, ...body } = parse(detachSchema, value), v = detachBody(body);
  conflict(ref.contentDigest === hash(r3(v))); return { ref, ...v };
}
function mappingJoin(snapshot: ConfigSnapshot, mapping: WorkspaceMapping) {
  conflict(same(snapshot.ref, mapping.configSnapshotRef) && snapshot.projectId === mapping.workspaceRef.projectId
    && snapshot.config.workdir === mapping.originalWorkdir);
}
function sourcePair(value: unknown, budget: Budget): SourcePair {
  const v = parse(z.object({ snapshot: requiredValue, mapping: requiredValue.nullable() }).strict(), value);
  return { snapshot: snapshot(v.snapshot, budget, 6), mapping: v.mapping === null ? null : mapping(v.mapping) };
}
function scopedSnapshot(v: ConfigSnapshot, b: BindingVersion, attachment: ExecutionAttachmentRef, allowPreview: boolean) {
  conflict(v.groupBindingId === attachment.groupBindingId && (v.executionBindingId === attachment.executionBindingId || allowPreview && v.executionBindingId === null)
    && v.agentId === b.agentId && v.projectId === b.projectId && v.groupId === b.groupId && v.memberId === b.memberId);
}
function selectedJoin(selected: SelectedConfigSource | null, pair: SourcePair | null, binding: BindingVersion, attachment: ExecutionAttachmentRef) {
  if (selected === null) { conflict(pair === null); return; }
  conflict(pair !== null); scopedSnapshot(pair.snapshot, binding, attachment, false);
  conflict(same(selected.snapshotRef, pair.snapshot.ref));
  if (selected.state === "blocked") conflict(pair.mapping === null);
  else { conflict(pair.mapping !== null && same(selected.mappingRef, pair.mapping.ref)); mappingJoin(pair.snapshot, pair.mapping); }
}
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const int64 = z.string().regex(/^(0|-?[1-9][0-9]*)$/).refine(v => v.length <= 20 && /^(0|-?[1-9][0-9]*)$/.test(v) && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const nativeCell = z.union([z.tuple([z.literal("null")]), z.tuple([z.literal("integer"), int64]),
  z.tuple([z.literal("text"), hex]), z.tuple([z.literal("blob"), hex]), z.tuple([z.literal("real64be"), z.string().regex(/^[0-9a-f]{16}$/)])]);
const legacyTables = ["agents", "agent_runtimes", "agent_runtime_bindings", "agent_runner_states", "agent_runtime_members",
  "members", "projects", "groups", "group_participants", "agent_legacy_aliases"] as const;
const captureSchema = z.object({ contract: z.literal("m2-legacy-capture-body/r1"), captureId: id, physicalSourceRef: evidenceRef, snapshotReceiptRef: evidenceRef,
  source: sourceSchema, textEncoding: z.object({ backend: z.enum(["sqlite", "postgres"]), name: id }).strict(), persistedAliases: z.literal(true), legacySourceDigest: digest,
  tables: z.array(z.object({ name: z.enum(legacyTables), columnContract: artifactSchema, columns: z.array(id).nonempty(), count: decimal,
    rows: z.array(z.object({ rowid: int64.nullable(), cells: z.array(nativeCell) }).strict()) }).strict()).length(10) }).strict();
function capture(value: unknown): LegacyCaptureBody {
  const v = parse(captureSchema, value); conflict(v.textEncoding.backend === v.source.kind);
  for (let i = 0; i < v.tables.length; i++) {
    const t = v.tables[i]!; conflict(t.name === legacyTables[i] && new Set(t.columns).size === t.columns.length && t.count === String(t.rows.length));
    const pk = t.name === "agent_runner_states" ? ["binding_id"] : t.name === "agent_runtime_members" ? ["member_id"]
      : t.name === "group_participants" ? ["group_id", "member_id"] : t.name === "agent_legacy_aliases" ? ["display_name", "host_type"] : ["id"];
    conflict(pk.every(k => t.columns.includes(k))); const keys = new Set<string>();
    for (const row of t.rows) {
      conflict(row.cells.length === t.columns.length && (v.source.kind !== "postgres" || row.rowid === null));
      const key = canonicalJson(pk.map(k => row.cells[t.columns.indexOf(k)])); conflict(!keys.has(key)); keys.add(key);
    }
  }
  return v;
}
const mutationSchema = z.object({ actorScope: id, operation: z.enum(["profile.create", "profile.save", "binding.save"]),
  targetScope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("agent"), agentId: id }).strict(),
    z.object({ kind: z.literal("binding"), groupBindingId: id }).strict()]), mutationId: id, commandDigest: digest,
  result: z.discriminatedUnion("kind", [z.object({ kind: z.literal("profile"), saved: z.object({ ref: profileRef, mutationId: id,
    pendingApply: z.literal(true), missing: z.array(z.string()) }).strict() }).strict(),
    z.object({ kind: z.literal("binding"), saved: z.object({ ref: bindingRef, mutationId: id, pendingApply: z.literal(true), missing: z.array(z.string()) }).strict() }).strict()]), auditId: id }).strict();
function mutation(value: unknown): MutationReceiptValue {
  const v = parse(mutationSchema, value); conflict(v.mutationId === v.result.saved.mutationId);
  if (v.operation === "binding.save") { conflict(v.targetScope.kind === "binding" && v.result.kind === "binding");
    conflict(v.targetScope.groupBindingId === v.result.saved.ref.groupBindingId); }
  else { conflict(v.targetScope.kind === "agent" && v.result.kind === "profile");
    conflict(v.targetScope.agentId === v.result.saved.ref.agentId && (v.operation !== "profile.create" || v.result.saved.ref.profileRevision === 1)); }
  return v;
}
const authoritySchema = z.object({ singleton: z.literal(1), formatVersion: z.number().int().positive().max(2147483647),
  owner: z.enum(["legacy", "profile"]), activationId: id.nullable(), sourceBinding: sourceBindingSchema }).strict();
const authorityJoinSchema = z.object({ authority: authoritySchema, receipt: receiptSchema.nullable(), receiptArtifact: artifactSchema.nullable(),
  sourceHistory: requiredValue.nullable(), importSelection: z.object({ artifact: artifactSchema, value: requiredValue, valueDigest: digest }).strict().nullable() }).strict();
function registered(authority: AuthorityRowValue) {
  if (M2_FORMAT_REGISTRATION.state !== "registered-stage1") fail("format_unregistered");
  if (authority.formatVersion !== M2_FORMAT_REGISTRATION.configFormat) fail("unsupported_shape");
}
function p1<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof ProfileAuthorityValueError && ["invalid_value", "unsupported_shape", "value_conflict", "budget_exceeded"].includes(error.code)) fail(error.code);
    return fail("invalid_value"); }
}
function valueOf(kind: string, value: unknown, budget: Budget): M2ValueTypes[keyof M2ValueTypes] {
  switch (kind) {
    case "profile-content": return profile(value);
    case "binding-content": return bindingContent(value);
    case "profile-version": return profileVersion(value);
    case "binding-version": return bindingVersion(value);
    case "current-advanced": return advanced(value);
    case "current-advanced-view": return view(value);
    case "source-binding": return sourceBinding(value);
    case "activation-receipt": return receipt(value);
    case "config-snapshot": return snapshot(value, budget);
    case "workspace-mapping": return mapping(value);
    case "detach-snapshot": return detach(value);
    case "legacy-capture": return capture(value);
    case "mutation-receipt": return mutation(value);
    default: return fail("unsupported_shape");
  }
}
export function parseM2Value(input: unknown): M2ValueResult<ParsedM2Value> {
  return total(input, (value, budget) => { const v = parse(envelope, value);
    return { kind: v.kind, value: valueOf(v.kind, v.value, budget) } as ParsedM2Value;
  });
}
export function m2ValueDigest(input: unknown): M2ValueResult<M2DigestValue> {
  return total(input, (value, budget) => { const v = parse(hashEnvelope, value); let body: unknown;
    switch (v.kind) {
      case "profile-content": body = profile(v.body); break;
      case "binding-content": body = bindingContent(v.body); break;
      case "existing-scope": body = parse(scopeSchema, v.body); break;
      case "ordinary-config": body = parse(z.object({ backend, config }).strict(), v.body); break;
      case "source-binding": body = sourceBinding(v.body); break;
      case "activation-receipt": body = receiptBody(v.body); break;
      case "config-snapshot": body = snapshotBody(v.body, budget); break;
      case "workspace-mapping": body = parse(mappingBodySchema, v.body); break;
      case "detach-snapshot": body = detachBody(v.body); break;
      case "legacy-capture": body = capture(v.body); break;
      default: return fail("unsupported_shape");
    }
    return { kind: v.kind as keyof M2DigestBodies, algorithm: "sha256" as const,
      canonicalDomain: v.kind === "source-binding" ? "storage-maintenance-utf16/v1" as const : "m2-r3-codepoint/v1" as const,
      digest: hash(v.kind === "source-binding" ? canonicalJson(body) : r3(body)) };
  });
}
export function checkM2SnapshotMappingValues(input: unknown): M2ValueResult<{
  snapshotRef: ConfigSnapshotRef; mappingRef: WorkspaceMappingRef; workspaceRef: WorkspaceRef; executionBindingId: string | null;
}> {
  return total(input, (value, budget) => { const v = parse(z.object({ snapshot: requiredValue, mapping: requiredValue }).strict(), value);
    const snap = snapshot(v.snapshot, budget), map = mapping(v.mapping); mappingJoin(snap, map);
    return { snapshotRef: snap.ref, mappingRef: map.ref, workspaceRef: map.workspaceRef, executionBindingId: snap.executionBindingId };
  });
}
export function checkM2DetachValues(input: unknown): M2ValueResult<{ detachRef: DetachConfigSnapshotRef; attachment: ExecutionAttachmentRef;
  profileRef: ProfileRef; bindingRef: BindingConfigRef; requested: SelectedConfigSource | null; applied: SelectedConfigSource | null }> {
  return total(input, (value, budget) => {
    const v = parse(z.object({ detach: requiredValue, profile: requiredValue, binding: requiredValue, requested: requiredValue.nullable(),
      applied: requiredValue.nullable(), rootSelected: requiredValue.nullable() }).strict(), value);
    const d = detach(v.detach), p = profileVersion(v.profile), b = bindingVersion(v.binding);
    const requested = v.requested === null ? null : sourcePair(v.requested, budget), applied = v.applied === null ? null : sourcePair(v.applied, budget),
      rootPair = v.rootSelected === null ? null : sourcePair(v.rootSelected, budget);
    conflict(same(d.profileRef, p.ref) && same(d.bindingRef, b.ref) && b.agentId === p.ref.agentId
      && b.ref.groupBindingId === d.attachment.groupBindingId && same(d.currentAdvanced.stored, b.content.currentAdvanced));
    if (d.root.workspaceRef !== null) conflict(d.root.workspaceRef.projectId === b.projectId);
    const current = d.currentAdvanced.stored;
    if (current.state === "selected") conflict(current.basis.existingScope.executionBindingId === d.attachment.executionBindingId);
    if (d.currentAdvanced.validity === "effective") {
      conflict(current.state === "selected" && d.resolution.state === "complete" && d.root.state === "fixed_reference");
      effectiveBasis(current.basis, p.ref, d.resolution.backend, d.resolution.config);
      conflict(same(current.basis.root.workspaceRef, d.root.workspaceRef) && current.basis.root.canonicalRoot === d.root.canonicalRoot
        && current.basis.root.physicalResourceKey === d.root.physicalResourceKey && same(current.basis.root.rootIdentity, d.root.rootIdentity));
    }
    selectedJoin(d.requested, requested, b, d.attachment); selectedJoin(d.applied, applied, b, d.attachment);
    if (d.root.state === "fixed_reference" && d.root.mappingRef !== null) {
      conflict(rootPair !== null && rootPair.mapping !== null); const map = rootPair.mapping;
      scopedSnapshot(rootPair.snapshot, b, d.attachment, true); mappingJoin(rootPair.snapshot, map);
      conflict(same(d.root.mappingRef, map.ref) && same(d.root.workspaceRef, map.workspaceRef) && d.root.canonicalRoot === map.canonicalRoot
        && d.root.physicalResourceKey === map.physicalResourceKey && same(d.root.rootIdentity, map.rootIdentity));
    } else conflict(rootPair === null);
    return { detachRef: d.ref, attachment: d.attachment, profileRef: d.profileRef, bindingRef: d.bindingRef, requested: d.requested, applied: d.applied };
  });
}
export function checkM2AuthorityValues(input: unknown): M2ValueResult<{ kind: "legacy" | "local" | "imported";
  activation: ActivationRef | null; sourceBinding: SourceBinding }> {
  return total(input, value => {
    const v = parse(authorityJoinSchema, value), a = v.authority, binding = a.sourceBinding;
    // P1 keeps its original smaller budget and strict parser; registration never relaxes it.
    let deferred: M2ValueErrorCode | null = null;
    const beforeGate = <T>(read: () => T): T | null => { try { return p1(read); } catch (error) {
      const code = error !== null && typeof error === "object" ? failures.get(error) : undefined;
      if (code !== "value_conflict") throw error; deferred = code; return null; } };
    const history = v.sourceHistory === null ? null : beforeGate(() => parseProfileOriginHistoryValue(v.sourceHistory));
    const imported = v.importSelection === null ? null : beforeGate(() => parseProfileAuthorityImportValue(v.importSelection!.value));
    registered(a); if (deferred !== null) fail(deferred);
    if (binding.kind === "legacy") {
      conflict(a.owner === "legacy" && a.activationId === null && v.receipt === null && v.receiptArtifact === null
        && v.sourceHistory === null && v.importSelection === null);
      return { kind: "legacy" as const, activation: null, sourceBinding: binding };
    }
    conflict(a.owner === "profile" && a.activationId !== null && v.receipt !== null);
    const r = receipt(v.receipt); conflict(a.activationId === r.ref.activationId);
    if (binding.kind === "local") {
      conflict(same(binding.activation, r.ref) && same(binding.physicalSourceRef, r.physicalSourceRef) && v.importSelection === null);
      if (history === null) conflict(v.sourceHistory === null && v.receiptArtifact === null);
      else conflict(v.receiptArtifact !== null && same(history.activation, r.ref) && same(history.activationReceipt, v.receiptArtifact));
    } else {
      conflict(history !== null && imported !== null && v.importSelection !== null && v.receiptArtifact !== null);
      conflict(same(binding.importArtifact, v.importSelection.artifact)
        && binding.importValueDigest === v.importSelection.valueDigest
        && v.importSelection.valueDigest === p1(() => profileAuthorityImportValueDigest(imported))
        && same(imported.sourceHistory, history) && same(history.activation, r.ref)
        && same(history.activationReceipt, v.receiptArtifact) && imported.authorityProjection.activationId === a.activationId);
    }
    return { kind: binding.kind, activation: r.ref, sourceBinding: binding };
  });
}

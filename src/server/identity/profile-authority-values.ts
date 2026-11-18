import { z } from "zod";
import { canonicalJson, digestJson } from "../storage/maintenance/canonical.ts";
import { hash, ref, source } from "../storage/maintenance/parse-primitives.ts";
import { LayoutValueError, checkLayoutPublicationValueJoin, parseLayoutIntentValue,
  parsePublicationBundleValue } from "../storage/maintenance/layout-values.ts";

/** Internal data contracts only. No durable codec, database writer or current admission. */
export type ReadonlyDeep<T> = T extends readonly (infer E)[] ? readonly ReadonlyDeep<E>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
export type ProfileAuthorityValueErrorCode = "invalid_value" | "unsupported_shape" | "value_conflict" | "budget_exceeded";
const errorCodes: readonly ProfileAuthorityValueErrorCode[] = ["invalid_value", "unsupported_shape", "value_conflict", "budget_exceeded"];
const failureCodes = new WeakMap<object, ProfileAuthorityValueErrorCode>();
export class ProfileAuthorityValueError extends Error {
  readonly code: ProfileAuthorityValueErrorCode;
  constructor(code: ProfileAuthorityValueErrorCode) {
    const safe = errorCodes.includes(code) ? code : "invalid_value";
    super(`profile_authority_value:${safe}`);
    this.name = "ProfileAuthorityValueError";
    this.code = safe;
    failureCodes.set(this, safe);
  }
}

const MAX_BYTES = 1_048_576;
const MAX_DEPTH = 64;
const MAX_NODES = 250_000;

// Private, fixed-budget copy. The whole public call is bounded before schema traversal or hashing.
function copyData(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function charge(count: number) {
    bytes += count;
    if (bytes > MAX_BYTES) throw new ProfileAuthorityValueError("budget_exceeded");
  }
  function stringSize(text: string) {
    if (text.length > MAX_BYTES) throw new ProfileAuthorityValueError("budget_exceeded");
    if (/[\uD800-\uDFFF]/u.test(text)) throw new ProfileAuthorityValueError("invalid_value");
    charge(Buffer.byteLength(text, "utf8") + 2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) charge(1);
      else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 1 : 5);
    }
  }
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new ProfileAuthorityValueError("budget_exceeded");
    if (item === null) { charge(4); return null; }
    if (typeof item === "string") { stringSize(item); return item; }
    if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new ProfileAuthorityValueError("invalid_value");
      charge(String(item).length); return item;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new ProfileAuthorityValueError("invalid_value");
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new ProfileAuthorityValueError("invalid_value");
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES + (array ? 1 : 0)) throw new ProfileAuthorityValueError("budget_exceeded");
    if (keys.some(key => typeof key !== "string")) throw new ProfileAuthorityValueError("invalid_value");
    // Keep exactly the keys we observed. A second ownKeys trap could reveal fields
    // that would then be silently discarded by walking the older key list.
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) throw new ProfileAuthorityValueError("invalid_value");
      descriptors.set(key, descriptor);
    }
    ancestors.add(item);
    try {
      if (array) {
        const length: unknown = descriptors.get("length")?.value;
        if (typeof length !== "number" || length > MAX_NODES) throw new ProfileAuthorityValueError("budget_exceeded");
        if (keys.length !== length + 1) throw new ProfileAuthorityValueError("invalid_value");
        charge(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors.get(String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ProfileAuthorityValueError("invalid_value");
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      charge(2 + Math.max(0, keys.length - 1));
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const descriptor = descriptors.get(key)!;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new ProfileAuthorityValueError("invalid_value");
        stringSize(key); charge(1);
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { ancestors.delete(item); }
  }
  return visit(value, 0);
}
function withCopy<T>(value: unknown, consume: (safe: unknown) => T): T {
  try { return consume(copyData(value)); }
  catch (error) {
    // Even hostile reflection throwing a Proxy or a modified error cannot leak its text.
    const code = error !== null && (typeof error === "object" || typeof error === "function") ? failureCodes.get(error) : undefined;
    throw new ProfileAuthorityValueError(code ?? "invalid_value");
  }
}
function immutable<T>(value: T): ReadonlyDeep<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) immutable(item);
    Object.freeze(value);
  }
  return value as ReadonlyDeep<T>;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function contract(value: unknown, expected: string) {
  const tag = record(value)?.contract;
  if (typeof tag === "string" && tag !== expected) throw new ProfileAuthorityValueError("unsupported_shape");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProfileAuthorityValueError("invalid_value");
  return result.data;
}
function same(left: unknown, right: unknown) { return canonicalJson(left) === canonicalJson(right); }
function conflict(condition: boolean) { if (!condition) throw new ProfileAuthorityValueError("value_conflict"); }

const id = z.string().min(1).max(512).refine(value => !value.includes("\0"));
const artifactId = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const counter = z.number().int().nonnegative().safe();
const activation = z.object({ activationId: id, digest: hash }).strict();
const takeoverPlan = z.object({ planId: id, digest: hash }).strict();
const evidence = z.object({ artifactId, digest: hash }).strict();
const completion = z.object({ activation, takeoverPlan, migrationId: id, s4PlanDigest: hash, sourceIdentityDigest: hash,
  epochBefore: counter, epochAfter: counter, terminal: z.object({ record: evidence, sequence: counter.positive() }).strict() }).strict();
const historySchema = z.object({ contract: z.literal("profile-origin-history-value/r1"), source, authorityRow: ref,
  activation, activationReceipt: ref, completion, journalClosure: ref }).strict();
const tableNames = ["agent_profiles", "agent_profile_versions", "group_bindings", "group_binding_config_versions",
  "legacy_config_captures", "config_snapshots", "config_detach_snapshots", "config_workspace_mappings",
  "config_activation_receipts", "config_mutation_receipts"] as const;
const tableSchema = z.object({ name: z.enum(tableNames), columnContract: ref, typedRows: ref, count: decimal, rowMultisetDigest: hash }).strict();
const preservationSchema = z.object({ contract: z.literal("profile-preservation-manifest-value/r1"), source, snapshotReady: ref,
  sourceFormat: z.object({ protocolVersion: z.literal(2), writerFormat: z.literal("s2-profile-config/v1"), writerFormatDigest: hash,
    schemaManifest: ref, guardManifest: ref }).strict(), tables: z.array(tableSchema).length(10),
  dependencies: z.object({ stableIdentities: ref, roleVersions: ref, executionLinks: ref, workspaceReferences: ref, auditHistory: ref }).strict() }).strict();
const importSchema = z.object({ contract: z.literal("profile-authority-import-value/r1"), sourceHistory: historySchema,
  preservation: preservationSchema, layout: z.object({ migrationId: id, activationId: id, intentArtifact: ref, intentValueDigest: hash,
    transitionContract: ref, allowedDeltaContract: ref, fixedSeedPlan: ref }).strict(),
  target: z.object({ source, provisioning: ref }).strict(),
  authorityProjection: z.object({ owner: z.literal("profile"), activationId: id, sourceBindingRef: z.literal("SELF") }).strict() }).strict();

export type ArtifactRef = z.infer<typeof ref>;
export type SourceRef = z.infer<typeof source>;
export type EvidenceRef = z.infer<typeof evidence>;
export type ActivationRef = z.infer<typeof activation>;
export type TakeoverPlanRef = z.infer<typeof takeoverPlan>;
export type ProfileCompletionBindingValue = z.infer<typeof completion>;
export type ProfileOriginHistoryValue = z.infer<typeof historySchema>;
export type ProfilePreservedTable = typeof tableNames[number];
export type ProfileTableSummaryValue = z.infer<typeof tableSchema>;
export type ProfilePreservationManifestValue = Omit<z.infer<typeof preservationSchema>, "tables">
  & { tables: readonly ProfileTableSummaryValue[] };
export type ProfileAuthorityImportValue = Omit<z.infer<typeof importSchema>, "preservation">
  & { preservation: ProfilePreservationManifestValue };

function validateHistory(value: ProfileOriginHistoryValue) {
  conflict(same(value.activation, value.completion.activation));
  conflict(value.source.identityDigest === value.completion.sourceIdentityDigest);
  conflict(value.completion.epochBefore < Number.MAX_SAFE_INTEGER
    && value.completion.epochAfter === value.completion.epochBefore + 1);
}
function preservationContracts(value: unknown) {
  contract(value, "profile-preservation-manifest-value/r1");
  const entries = record(value)?.tables;
  if (Array.isArray(entries)) for (const entry of entries) {
    const name = record(entry)?.name;
    if (typeof name === "string" && !tableNames.some(known => known === name)) throw new ProfileAuthorityValueError("unsupported_shape");
  }
}
function validatePreservation(value: ProfilePreservationManifestValue) {
  conflict(value.tables.every((entry, index) => entry.name === tableNames[index]));
}
function parseHistory(value: unknown): ProfileOriginHistoryValue {
  contract(value, "profile-origin-history-value/r1");
  const result = parse(historySchema, value); validateHistory(result); return result;
}
function parsePreservation(value: unknown): ProfilePreservationManifestValue {
  preservationContracts(value);
  const result = parse(preservationSchema, value); validatePreservation(result); return result;
}
function parseImport(value: unknown): ProfileAuthorityImportValue {
  contract(value, "profile-authority-import-value/r1");
  const input = record(value);
  contract(input?.sourceHistory, "profile-origin-history-value/r1");
  preservationContracts(input?.preservation);
  const self = record(input?.authorityProjection)?.sourceBindingRef;
  if (typeof self === "string") conflict(self === "SELF");
  const result = parse(importSchema, value);
  validateHistory(result.sourceHistory); validatePreservation(result.preservation);
  conflict(same(result.sourceHistory.source, result.preservation.source));
  conflict(result.sourceHistory.source.kind === "sqlite" && result.target.source.kind === "sqlite"
    && result.sourceHistory.source.databaseInstanceId !== result.target.source.databaseInstanceId);
  conflict(result.authorityProjection.activationId === result.sourceHistory.activation.activationId);
  return result;
}

export function parseProfileOriginHistoryValue(value: unknown): ReadonlyDeep<ProfileOriginHistoryValue> {
  return withCopy(value, safe => immutable(parseHistory(safe)));
}
export function parseProfilePreservationManifestValue(value: unknown): ReadonlyDeep<ProfilePreservationManifestValue> {
  return withCopy(value, safe => immutable(parsePreservation(safe)));
}
export function parseProfileAuthorityImportValue(value: unknown): ReadonlyDeep<ProfileAuthorityImportValue> {
  return withCopy(value, safe => immutable(parseImport(safe)));
}
export function profileAuthorityImportValueDigest(value: unknown): string {
  return withCopy(value, safe => digestJson(parseImport(safe)));
}

export type ProfileAuthorityTreatmentValue =
  | { kind: "preserve-source-authority"; sourceAuthorityRow: ArtifactRef }
  | { kind: "imported-profile-projection"; sourceAuthorityRow: ArtifactRef; owner: "profile"; activationId: string;
      sourceBinding: { kind: "profile-layout-import-value"; artifact: ArtifactRef; valueDigest: string } };
type ProfileLayoutValueJoinCommon = {
  contract: "profile-layout-value-join/r1"; classification: "value-consistent";
  intentDigest: string; recipeDigest: string; bundleDigest: string; sourceHistoryDigest: string; preservationDigest: string;
};
export type ProfileLayoutValueJoinResult = ProfileLayoutValueJoinCommon & (
  | { mode: "retain-database"; authorityTreatment: Extract<ProfileAuthorityTreatmentValue, { kind: "preserve-source-authority" }> }
  | { mode: "relocate-sqlite"; authorityTreatment: Extract<ProfileAuthorityTreatmentValue, { kind: "imported-profile-projection" }> }
);
const compositionSchema = z.object({ intent: z.unknown(), recipe: z.unknown(), bundle: z.unknown(), intentArtifact: ref,
  sourceHistory: z.unknown(), preservation: z.unknown(),
  importSelection: z.object({ value: z.unknown(), artifact: ref, valueDigest: hash }).strict().nullable() }).strict();

function layoutValues(input: z.infer<typeof compositionSchema>) {
  try {
    const joined = checkLayoutPublicationValueJoin({ intent: input.intent, recipe: input.recipe, bundle: input.bundle });
    return { joined, intent: parseLayoutIntentValue(input.intent), bundle: parsePublicationBundleValue(input.bundle) };
  } catch (error) {
    if (error instanceof LayoutValueError && errorCodes.some(code => code === error.code))
      throw new ProfileAuthorityValueError(error.code as ProfileAuthorityValueErrorCode);
    throw new ProfileAuthorityValueError("invalid_value");
  }
}

export function checkProfileLayoutCompositionValues(value: unknown): ReadonlyDeep<ProfileLayoutValueJoinResult> {
  return withCopy(value, safe => {
    const input = parse(compositionSchema, safe);
    const { joined, intent, bundle } = layoutValues(input);
    const sourceHistory = parseHistory(input.sourceHistory);
    const preservation = parsePreservation(input.preservation);
    if (intent.origin.kind !== "legacy" || intent.mode === "initialize-new") throw new ProfileAuthorityValueError("value_conflict");
    conflict(same(sourceHistory.source, intent.origin.source) && same(sourceHistory.source, preservation.source));
    conflict(same(preservation.snapshotReady, intent.origin.snapshotReady));
    const common = { contract: "profile-layout-value-join/r1" as const, ...joined,
      sourceHistoryDigest: digestJson(sourceHistory), preservationDigest: digestJson(preservation) };
    if (intent.mode === "retain-database") {
      conflict(input.importSelection === null && same(sourceHistory.source, bundle.targetSource));
      return immutable({ ...common, mode: "retain-database" as const,
        authorityTreatment: { kind: "preserve-source-authority" as const, sourceAuthorityRow: sourceHistory.authorityRow } });
    }
    const selection = input.importSelection;
    if (selection === null) throw new ProfileAuthorityValueError("value_conflict");
    const imported = parseImport(selection.value);
    const valueDigest = digestJson(imported);
    conflict(selection.valueDigest === valueDigest);
    // The full history comparison prevents two individually valid histories of the same source from mixing.
    conflict(same(imported.sourceHistory, sourceHistory) && same(imported.preservation, preservation));
    conflict(same(imported.target.source, bundle.targetSource) && same(imported.target.provisioning, bundle.provisioning));
    conflict(same(imported.layout.intentArtifact, input.intentArtifact) && imported.layout.intentValueDigest === joined.intentDigest);
    conflict(imported.layout.migrationId === intent.identity.migrationId && imported.layout.activationId === intent.identity.activationId);
    conflict(same(imported.layout.transitionContract, intent.transitionContract)
      && same(imported.layout.allowedDeltaContract, intent.allowedDeltaContract) && same(imported.layout.fixedSeedPlan, intent.fixedSeedPlan));
    return immutable({ ...common, mode: "relocate-sqlite" as const,
      authorityTreatment: { kind: "imported-profile-projection" as const, sourceAuthorityRow: sourceHistory.authorityRow,
        owner: "profile" as const, activationId: sourceHistory.activation.activationId,
        sourceBinding: { kind: "profile-layout-import-value" as const, artifact: selection.artifact, valueDigest } } });
  });
}

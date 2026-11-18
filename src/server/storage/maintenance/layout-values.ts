import { posix } from "node:path";
import { z } from "zod";
import { canonicalJson, digestJson } from "./canonical.ts";
import { hash, id, ref, source } from "./parse-primitives.ts";

/** Internal data contracts only: no persistent format allocation or IO authority. */
export type ReadonlyDeep<T> = T extends readonly (infer E)[] ? readonly ReadonlyDeep<E>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;
type ErrorCode = "invalid_value" | "unsupported_shape" | "value_conflict" | "incomplete_inventory"
  | "inventory_integrity" | "budget_exceeded";
const errorCodes: readonly ErrorCode[] = ["invalid_value", "unsupported_shape", "value_conflict", "incomplete_inventory",
  "inventory_integrity", "budget_exceeded"];
export class LayoutValueError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    const safe = errorCodes.includes(code) ? code : "invalid_value";
    super(`layout_internal_value:${safe}`);
    this.name = "LayoutValueError";
    this.code = safe;
  }
}

const MAX_NODES = 250_000;
const MAX_DEPTH = 64;
const VALUE_BYTES = 1_048_576;
const INVENTORY_BYTES = 32 * VALUE_BYTES;

/** @internal Only the three layout value modules may consume this data guard. */
export function copyLayoutInternalData(value: unknown, budget: "value" | "inventory"): unknown {
  if (budget !== "value" && budget !== "inventory") throw new LayoutValueError("invalid_value");
  const limit = budget === "value" ? VALUE_BYTES : INVENTORY_BYTES;
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function charge(count: number) {
    bytes += count;
    if (bytes > limit) throw new LayoutValueError("budget_exceeded");
  }
  function stringSize(text: string) {
    if (text.length > limit) throw new LayoutValueError("budget_exceeded");
    if (/[\uD800-\uDFFF]/u.test(text)) throw new LayoutValueError("invalid_value");
    charge(Buffer.byteLength(text, "utf8") + 2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92) charge(1);
      else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 1 : 5);
    }
  }
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new LayoutValueError("budget_exceeded");
    if (item === null) { charge(4); return null; }
    if (typeof item === "string") { stringSize(item); return item; }
    if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new LayoutValueError("invalid_value");
      charge(String(item).length); return item;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw new LayoutValueError("invalid_value");
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new LayoutValueError("invalid_value");
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES + (array ? 1 : 0)) throw new LayoutValueError("budget_exceeded");
    if (keys.some(key => typeof key !== "string")) throw new LayoutValueError("invalid_value");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    ancestors.add(item);
    try {
      if (array) {
        const length: unknown = descriptors.length?.value;
        if (typeof length !== "number" || length > MAX_NODES) throw new LayoutValueError("budget_exceeded");
        if (keys.length !== length + 1) throw new LayoutValueError("invalid_value");
        charge(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new LayoutValueError("invalid_value");
          result.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      charge(2 + Math.max(0, keys.length - 1));
      const result: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new LayoutValueError("invalid_value");
        stringSize(key); charge(1);
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
      }
      return Object.freeze(result);
    } finally { ancestors.delete(item); }
  }
  try { return visit(value, 0); }
  catch (error) {
    if (error instanceof LayoutValueError) throw error;
    throw new LayoutValueError("invalid_value");
  }
}

const storageId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const path = z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.startsWith("//")
  && !value.includes("\0") && posix.normalize(value) === value);
const pathIdentity = z.object({ path, device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict();
const segment = z.string().min(1).max(4096).refine(value => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0"));
const plannedPath = z.object({ path, existingAncestor: pathIdentity, absentSegments: z.array(segment) }).strict()
  .refine(value => posix.join(value.existingAncestor.path, ...value.absentSegments) === value.path);
const rootRoles = ["home", "state", "memory", "skills", "runtime", "workspaces", "artifacts"] as const;
const fileRoles = ["config", "storage-marker", "migration-locator"] as const;
const mode = z.enum(["retain-database", "relocate-sqlite", "initialize-new"]);
const identity = z.object({ migrationId: id, activationId: id, storageId, generation: z.literal(1), layoutVersion: z.literal(2),
  objectFormat: z.literal("utf8-sha256-v1"), memoryFormatContract: ref }).strict();
const database = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sqlite"), targetPath: path, privateDescriptor: ref }).strict(),
  z.object({ kind: z.literal("postgres"), locationId: hash, privateDescriptor: ref }).strict(),
]);
const fileTarget = z.object({ role: z.enum(fileRoles), parentRole: z.enum(["home", "state"]), relativePath: z.string() }).strict();
const recipeSchema = z.object({ contract: z.literal("layout-publication-recipe-value/r1"), identity, mode,
  roots: z.object({ home: plannedPath, state: plannedPath, memory: plannedPath, skills: plannedPath, runtime: plannedPath,
    workspaces: plannedPath, artifacts: plannedPath }).strict(), database, targets: z.array(fileTarget).length(3),
  rendererContract: ref, privateInputs: ref }).strict();
const origin = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy"), source, plan: ref, snapshotReady: ref, originalPrivateConfig: ref, effectiveConfigDigest: hash }).strict(),
  z.object({ kind: z.literal("new-space"), explicitSelection: ref, absenceObservation: ref }).strict(),
]);
const intentSchema = z.object({ contract: z.literal("layout-intent-value/r1"), identity, mode, origin, controlRoot: plannedPath,
  recipeDigest: hash, inventoryDigest: hash, transitionContract: ref, allowedDeltaContract: ref, memoryContractDigest: hash,
  fixedSeedPlan: ref, auditId: id, plannedAt: z.string().max(64).datetime({ offset: true }) }).strict();
const rootObservation = z.object({ role: z.enum(rootRoles), identity: pathIdentity, sourceProfile: ref }).strict();
const parentObservation = z.object({ role: z.enum(fileRoles), identity: pathIdentity }).strict();
const fileBytes = z.object({ role: z.enum(fileRoles), bytes: ref }).strict();
const bundleSchema = z.object({ contract: z.literal("layout-publication-bundle-value/r1"), identity, mode, intentDigest: hash, recipeDigest: hash,
  targetSource: source, provisioning: ref.nullable(), rootBindingSet: ref, roots: z.array(rootObservation).length(7),
  parents: z.array(parentObservation).length(3), files: z.array(fileBytes).length(3) }).strict();

export type RootRole = typeof rootRoles[number];
export type FileRole = typeof fileRoles[number];
export type Mode = z.infer<typeof mode>;
export type LogicalIdentity = z.infer<typeof identity>;
export type DatabasePlanValue = z.infer<typeof database>;
export type FileTargetValue = z.infer<typeof fileTarget>;
export type LayoutOriginValue = z.infer<typeof origin>;
export type RootObservationValue = z.infer<typeof rootObservation>;
export type ParentObservationValue = z.infer<typeof parentObservation>;
export type FileBytesValue = z.infer<typeof fileBytes>;
export type PublicationRecipeValue = ReadonlyDeep<z.infer<typeof recipeSchema>>;
export type LayoutIntentValue = ReadonlyDeep<z.infer<typeof intentSchema>>;
export type PublicationBundleValue = ReadonlyDeep<z.infer<typeof bundleSchema>>;

function parse<T>(schema: z.ZodType<T>, value: unknown, contract?: string): T {
  const safe = copyLayoutInternalData(value, "value");
  if (contract !== undefined && safe && typeof safe === "object" && "contract" in safe
    && typeof safe.contract === "string" && safe.contract !== contract) throw new LayoutValueError("unsupported_shape");
  const parsed = schema.safeParse(safe);
  if (!parsed.success) throw new LayoutValueError("invalid_value");
  return parsed.data;
}
function same(a: unknown, b: unknown) { return canonicalJson(a) === canonicalJson(b); }
function conflict(condition: boolean) { if (!condition) throw new LayoutValueError("value_conflict"); }

export function parseLayoutIntentValue(value: unknown): ReadonlyDeep<LayoutIntentValue> {
  const result = parse(intentSchema, value, "layout-intent-value/r1");
  conflict((result.origin.kind === "new-space") === (result.mode === "initialize-new"));
  if (result.mode === "relocate-sqlite") conflict(result.origin.kind === "legacy" && result.origin.source.kind === "sqlite");
  conflict(result.memoryContractDigest === "cd93b64cd66516a22ef4173a343f03b6af6c2c459e1dd3fa2e7354bcf1fbe58a");
  return copyLayoutInternalData(result, "value") as ReadonlyDeep<LayoutIntentValue>;
}
export function parsePublicationRecipeValue(value: unknown): ReadonlyDeep<PublicationRecipeValue> {
  const result = parse(recipeSchema, value, "layout-publication-recipe-value/r1");
  const expected = [{ role: "config", parentRole: "home", relativePath: "config.json" },
    { role: "storage-marker", parentRole: "state", relativePath: "storage.json" },
    { role: "migration-locator", parentRole: "state", relativePath: `migrations/${result.identity.migrationId}.json` }];
  conflict(same(result.targets, expected));
  if (result.mode === "relocate-sqlite") conflict(result.database.kind === "sqlite");
  return copyLayoutInternalData(result, "value") as ReadonlyDeep<PublicationRecipeValue>;
}
export function parsePublicationBundleValue(value: unknown): ReadonlyDeep<PublicationBundleValue> {
  const result = parse(bundleSchema, value, "layout-publication-bundle-value/r1");
  conflict(same(result.roots.map(item => item.role), rootRoles));
  conflict(same(result.parents.map(item => item.role), fileRoles) && same(result.files.map(item => item.role), fileRoles));
  conflict(new Set(result.files.map(item => digestJson(item.bytes))).size === 3);
  conflict((result.provisioning === null) === (result.mode === "retain-database"));
  if (result.mode === "relocate-sqlite") conflict(result.targetSource.kind === "sqlite");
  return copyLayoutInternalData(result, "value") as ReadonlyDeep<PublicationBundleValue>;
}
export function layoutValueDigest(value: LayoutIntentValue | PublicationRecipeValue | PublicationBundleValue): string {
  const safe = copyLayoutInternalData(value, "value");
  if (!safe || typeof safe !== "object" || !("contract" in safe)) throw new LayoutValueError("invalid_value");
  switch (safe.contract) {
    case "layout-intent-value/r1": return digestJson(parseLayoutIntentValue(safe));
    case "layout-publication-recipe-value/r1": return digestJson(parsePublicationRecipeValue(safe));
    case "layout-publication-bundle-value/r1": return digestJson(parsePublicationBundleValue(safe));
    default: throw new LayoutValueError("unsupported_shape");
  }
}
export function checkLayoutPublicationValueJoin(value: { intent: unknown; recipe: unknown; bundle: unknown }): Readonly<{
  classification: "value-consistent"; intentDigest: string; recipeDigest: string; bundleDigest: string;
}> {
  const input = parse(z.object({ intent: z.unknown(), recipe: z.unknown(), bundle: z.unknown() }).strict(), value);
  const intent = parseLayoutIntentValue(input.intent);
  const recipe = parsePublicationRecipeValue(input.recipe);
  const bundle = parsePublicationBundleValue(input.bundle);
  conflict(same(intent.identity, recipe.identity) && same(intent.identity, bundle.identity));
  conflict(intent.mode === recipe.mode && intent.mode === bundle.mode);
  const recipeDigest = digestJson(recipe);
  const intentDigest = digestJson(intent);
  conflict(intent.recipeDigest === recipeDigest && bundle.recipeDigest === recipeDigest && bundle.intentDigest === intentDigest);
  conflict(bundle.targetSource.kind === recipe.database.kind);
  if (intent.origin.kind === "legacy") {
    conflict(intent.origin.source.kind === recipe.database.kind);
    if (intent.mode === "retain-database") conflict(same(intent.origin.source, bundle.targetSource));
    else conflict(intent.origin.source.kind === "sqlite" && recipe.database.kind === "sqlite" && bundle.targetSource.kind === "sqlite"
      && intent.origin.source.databaseInstanceId !== bundle.targetSource.databaseInstanceId);
  }
  for (const item of bundle.roots) conflict(item.identity.path === recipe.roots[item.role].path);
  const parentPaths = [recipe.roots.home.path, recipe.roots.state.path, posix.join(recipe.roots.state.path, "migrations")];
  for (const [index, item] of bundle.parents.entries()) conflict(item.identity.path === parentPaths[index]);
  return Object.freeze({ classification: "value-consistent", intentDigest, recipeDigest, bundleDigest: digestJson(bundle) });
}

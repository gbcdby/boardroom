/** Internal pure values only; no publication authority or persistent format registration. */
import type { PublicationBundleValue, ReadonlyDeep } from "./layout-values.ts";
import type { ArtifactRef, SourceRef } from "./types.ts";
import type { ProfileOriginHistoryValue } from "../../identity/profile-authority-values.ts";
import { posix } from "node:path";
import { z } from "zod";
import { parseConfigValues } from "../../config.ts";
import type { AppConfig } from "../../config.ts";
import { parseProfileOriginHistoryValue } from "../../identity/profile-authority-values.ts";
import { canonicalJson, digestJson, sha256 } from "./canonical.ts";
import { parsePlan } from "./parse.ts";
import { checkLayoutPublicationValueJoin, copyLayoutInternalData, parseLayoutIntentValue,
  parsePublicationBundleValue, parsePublicationRecipeValue } from "./layout-values.ts";
import { Budget, consume, decodeJson, fail, failure, freeze, selectedBytes, selectedJson, selectedSize,
  strictUtf8 } from "./layout-publication/data.ts";
import type { NumberSources } from "./layout-publication/data.ts";
import { checkNumbers } from "./layout-publication/numbers.ts";
import { fixedSources } from "./layout-publication/fixed-sources.ts";
import { databaseSchema, fileRoles, inputSchema, locatorSchema, markerSchema, originalSchema, plannedPath,
  publicConfigSchema, rendererSchema, rootRoles, rootsSchema, seedSchema, sourceIdentity } from "./layout-publication/schema.ts";

export type SelectedBytes = ReadonlyDeep<{ artifact: ArtifactRef; bytesHex: string }>;
export type LayoutPublicationFileInput = ReadonlyDeep<{
  contract: "layout-publication-file-input/r1";
  plan: SelectedBytes;
  intent: SelectedBytes;
  recipe: SelectedBytes;
  seed: SelectedBytes;
  original: SelectedBytes;
  database: SelectedBytes;
  rendererInputs: SelectedBytes;
  rootBindings: SelectedBytes;
  privateConfig: SelectedBytes | null;
  originHistory: ProfileOriginHistoryValue;
  targetSource: SourceRef;
  provisioning: ArtifactRef | null;
  fixedSources: { memory: SelectedBytes; renderer: SelectedBytes; transition: SelectedBytes; allowedDelta: SelectedBytes };
}>;

export type FileValue<Role extends string> = {
  role: Role;
  artifact: ArtifactRef;
  bytesHex: string;
};
type Unproven<Check extends string> = { check: Check; status: "unproven" };
export type LayoutPublicationFileValues = ReadonlyDeep<{
  contract: "layout-publication-file-values/r1";
  classification: "observation";
  coverage: "private-config-seed-and-three-file-projection";
  source: SourceRef;
  targetSource: SourceRef;
  effectiveConfigDigest: string;
  files: [FileValue<"config">, FileValue<"storage-marker">, FileValue<"migration-locator">];
  bundle: PublicationBundleValue;
  join: { classification: "value-consistent"; intentDigest: string; recipeDigest: string; bundleDigest: string };
  remaining: [
    Unproven<"source-capture-provenance">,
    Unproven<"ready-and-journal-window">,
    Unproven<"origin-artifacts-and-preservation">,
    Unproven<"audit-id-rowid-freshness">,
    Unproven<"root-profiles-and-capabilities">,
    { check: "target-provisioning"; status: "unproven" | "not-applicable" },
    Unproven<"native-file-publication">,
    Unproven<"v2-startup-activation">
  ];
}>;

export type E1FailureCode = "invalid_value" | "unsupported_shape" | "artifact_integrity"
  | "reference_conflict" | "value_conflict" | "semantic_unsupported" | "resource_limit";
export type E1RuleId = "E1_INPUT" | "E1_BYTES" | "E1_CONFIG" | "E1_NUMBER" | "E1_SEED"
  | "E1_BINDING" | "E1_RENDER" | "E1_BUDGET";
export type E1SchemaPath = "/input" | "/selected" | "/privateConfig" | "/original"
  | "/seed" | "/links" | "/files" | "/budget";
export type LayoutPublicationFileResult = ReadonlyDeep<
  { ok: true; value: LayoutPublicationFileValues } |
  { ok: false; error: { code: E1FailureCode; ruleId: E1RuleId; schemaPath: E1SchemaPath } }
>;

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function requireValue(condition: unknown, code: E1FailureCode, stage: E1RuleId): asserts condition {
  if (!condition) fail(code, stage);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, stage: E1RuleId): T {
  const result = schema.safeParse(value);
  if (!result.success) fail("invalid_value", stage);
  return result.data;
}
function contract(value: unknown, expected: string, stage: E1RuleId): void {
  if (value !== null && typeof value === "object" && "contract" in value && typeof value.contract === "string"
    && value.contract !== expected) fail("unsupported_shape", stage);
}
function provider(value: unknown, kind: string): unknown {
  const shape = parse(z.object({ formatVersion: z.number(), kind: z.string(), payload: z.unknown() }).strict(), value, "E1_BYTES");
  requireValue(shape.formatVersion === 1 && shape.kind === kind, "unsupported_shape", "E1_BYTES");
  requireValue(Object.hasOwn(shape, "payload"), "invalid_value", "E1_BYTES");
  return shape.payload;
}
function settings(config: AppConfig) {
  return { port: config.port, heartbeat: config.heartbeat, antiLoop: config.antiLoop, memory: config.memory };
}
function providerPath(artifact: ArtifactRef, kind: string, extension = "json") {
  requireValue(artifact.ref === `s4-provider/sha256/${artifact.sha256}/${kind}.${extension}`, "artifact_integrity", "E1_BYTES");
}

/** Deterministic, bounded projection of captured E1 values. No IO, environment selection or IDs are generated. */
export function buildLayoutPublicationFileValues(value: unknown): LayoutPublicationFileResult {
  let stage: E1RuleId = "E1_INPUT";
  try {
    // Exactly one capture of caller-owned descriptors. Everything below uses this independent snapshot.
    const safe = consume(() => copyLayoutInternalData(value, "inventory"), stage);
    const budget = new Budget();
    budget.tree(safe);
    contract(safe, "layout-publication-file-input/r1", stage);
    const input = parse(inputSchema, safe, stage);
    requireValue(Object.hasOwn(input, "originHistory"), "invalid_value", stage);

    stage = "E1_BYTES";
    const selected = [input.plan, input.intent, input.recipe, input.seed, input.original, input.database,
      input.rendererInputs, input.rootBindings, ...(input.privateConfig === null ? [] : [input.privateConfig]),
      ...Object.values(input.fixedSources)];
    const refs = new Set<string>();
    for (const item of selected) {
      requireValue(!refs.has(item.artifact.ref), "reference_conflict", stage);
      refs.add(item.artifact.ref);
      selectedSize(item, budget);
    }
    const raw = new Map(selected.map(item => [item.artifact.ref, selectedBytes(item)]));
    for (const role of ["memory", "renderer", "transition", "allowedDelta"] as const) {
      const item = input.fixedSources[role], expected = fixedSources[role];
      requireValue(same(item.artifact, expected.artifact), "reference_conflict", stage);
      requireValue(raw.get(item.artifact.ref)!.equals(expected.bytes), "artifact_integrity", stage);
    }
    let privateText: string | null = null;
    if (input.privateConfig !== null) {
      providerPath(input.privateConfig.artifact, "private-config-bytes", "bin");
      privateText = strictUtf8(raw.get(input.privateConfig.artifact.ref)!, stage);
    }
    const json = (item: SelectedBytes) => selectedJson(raw.get(item.artifact.ref)!, budget);
    const envelope = (item: SelectedBytes, kind: string) => {
      providerPath(item.artifact, kind);
      return provider(json(item), kind);
    };
    const planValue = json(input.plan);
    const plan = consume(() => parsePlan(planValue), stage);
    const intentValue = json(input.intent), recipeValue = json(input.recipe);
    const seedValue = envelope(input.seed, "s4p-fixed-seed");
    const originalValue = envelope(input.original, "s4p-original-private-config");
    const databaseValue = envelope(input.database, "s4p-private-database");
    const rendererValue = envelope(input.rendererInputs, "s4p-renderer-inputs");
    const rootsValue = envelope(input.rootBindings, "s4p-root-bindings");

    contract(intentValue, "layout-intent-value/r1", stage);
    contract(recipeValue, "layout-publication-recipe-value/r1", stage);
    stage = "E1_RENDER";
    const intent = consume(() => parseLayoutIntentValue(intentValue), stage);
    const recipe = consume(() => parsePublicationRecipeValue(recipeValue), stage);
    requireValue(intent.mode !== "initialize-new" && recipe.mode !== "initialize-new", "semantic_unsupported", "E1_INPUT");
    requireValue(intent.origin.kind === "legacy", "invalid_value", "E1_INPUT");
    const origin = intent.origin;

    stage = "E1_SEED";
    contract(seedValue, "s4p-fixed-seed/r2", stage);
    const seed = parse(seedSchema, seedValue, stage);
    const history = consume(() => parseProfileOriginHistoryValue(input.originHistory), stage);
    requireValue(seed.originalProfileActivationId === history.activation.activationId
      && seed.originalProfileActivationId === history.completion.activation.activationId
      && seed.layoutActivationId !== seed.originalProfileActivationId, "value_conflict", stage);
    requireValue(seed.migrationId === plan.migrationId && seed.migrationId === intent.identity.migrationId
      && seed.layoutActivationId === intent.identity.activationId && seed.storageId === intent.identity.storageId
      && seed.auditId === intent.auditId && seed.plannedAt === intent.plannedAt
      && seed.generation === intent.identity.generation && seed.layoutVersion === intent.identity.layoutVersion
      && seed.objectFormat === intent.identity.objectFormat && seed.memoryContractDigest === intent.memoryContractDigest
      && new Set([seed.layoutActivationId, seed.storageId, seed.auditId]).size === 3, "value_conflict", stage);
    requireValue(plan.source.kind === "sqlite" ? seed.auditRowid !== null && seed.layoutStateRowid !== null
      : seed.auditRowid === null && seed.layoutStateRowid === null, "invalid_value", stage);

    stage = "E1_CONFIG";
    contract(originalValue, "s4p-original-private-config/r1", "E1_BYTES");
    const original = parse(originalSchema, originalValue, stage);
    requireValue(original.originalCwd === plan.originalCwd, "value_conflict", stage);
    let file: Record<string, unknown> = {};
    const numbers: NumberSources = new WeakMap();
    if (original.presence === "present") {
      requireValue(original.raw !== null && input.privateConfig !== null && original.path !== null
        && original.path === plan.originalConfigPath && same(original.raw, input.privateConfig.artifact)
        && original.raw.sha256 === plan.configDigest, "value_conflict", stage);
      const decoded = decodeJson(privateText!, budget, stage, numbers);
      requireValue(decoded !== null && typeof decoded === "object" && !Array.isArray(decoded), "invalid_value", stage);
      file = decoded as Record<string, unknown>;
    } else {
      requireValue(original.path === null && original.raw === null && input.privateConfig === null
        && plan.originalConfigPath === null && plan.configDigest === digestJson({ configFile: null }), "value_conflict", stage);
    }
    const env: Record<string, string | undefined> = {};
    for (const [key, item] of Object.entries(original.environment)) if (item !== null) env[key] = item;
    const parsed = consume(() => parseConfigValues({ cwd: original.originalCwd, env, fileValues: file,
      configFile: original.path, filePathBase: original.filePathBase, defaultDataDir: original.defaultDataDir }), stage);
    stage = "E1_NUMBER";
    checkNumbers(original, file, numbers, parsed);
    stage = "E1_CONFIG";
    requireValue(same(settings(parsed), original.effective.settings) && parsed.dataDir === original.effective.dataDir
      && parsed.dbDriver === original.effective.dbDriver
      && (parsed.pgConnectionString ?? null) === original.effective.pgConnectionString, "value_conflict", stage);

    stage = "E1_BINDING";
    contract(databaseValue, "s4p-private-database/r1", "E1_BYTES");
    contract(rendererValue, "s4p-renderer-inputs/r1", "E1_BYTES");
    contract(rootsValue, "s4p-root-bindings/r1", "E1_BYTES");
    const database = parse(databaseSchema, databaseValue, stage), renderer = parse(rendererSchema, rendererValue, stage);
    const roots = parse(rootsSchema, rootsValue, stage), identity = parse(sourceIdentity, plan.sourceIdentity, stage);
    requireValue(digestJson(identity) === plan.source.identityDigest && identity.kind === plan.source.kind, "value_conflict", stage);
    if (identity.kind === "postgres") requireValue(identity.databaseInstanceId === plan.source.databaseInstanceId, "value_conflict", stage);
    for (const current of [seed.source, original.source, database.source, renderer.source, history.source,
      origin.source, roots.binding.source]) requireValue(same(current, plan.source), "value_conflict", stage);
    for (const current of [seed.plan, original.plan, origin.plan, roots.binding.plan])
      requireValue(same(current, input.plan.artifact), "reference_conflict", stage);
    const edges = [[seed.sourceReady, origin.snapshotReady], [intent.fixedSeedPlan, input.seed.artifact],
      [renderer.seed, input.seed.artifact], [origin.originalPrivateConfig, input.original.artifact],
      [database.original, input.original.artifact], [renderer.original, input.original.artifact],
      [renderer.database, input.database.artifact], [recipe.database.privateDescriptor, input.database.artifact],
      [recipe.privateInputs, input.rendererInputs.artifact], [roots.binding.intent, input.intent.artifact]];
    for (const [left, right] of edges) requireValue(same(left, right), "reference_conflict", stage);
    requireValue(same(renderer.settings, original.effective.settings), "value_conflict", stage);
    for (const current of [intent.identity.memoryFormatContract, recipe.identity.memoryFormatContract])
      requireValue(same(current, input.fixedSources.memory.artifact), "reference_conflict", stage);
    for (const [current, fixed] of [[recipe.rendererContract, input.fixedSources.renderer.artifact],
      [intent.transitionContract, input.fixedSources.transition.artifact], [intent.allowedDeltaContract, input.fixedSources.allowedDelta.artifact]])
      requireValue(same(current, fixed), "reference_conflict", stage);
    requireValue(same(intent.identity, recipe.identity) && seed.mode === intent.mode && recipe.mode === intent.mode
      && database.mode === intent.mode && roots.binding.mode === intent.mode, "value_conflict", stage);
    requireValue(roots.binding.migrationId === seed.migrationId && roots.binding.layoutActivationId === seed.layoutActivationId
      && roots.binding.storageId === seed.storageId && roots.binding.phase === "snapshot_ready"
      && same(roots.binding.targetSource, input.targetSource), "value_conflict", stage);
    requireValue(database.kind === plan.source.kind && database.kind === parsed.dbDriver && database.kind === recipe.database.kind
      && database.kind === input.targetSource.kind, "value_conflict", stage);
    if (database.kind === "sqlite") {
      requireValue(identity.kind === "sqlite" && recipe.database.kind === "sqlite"
        && database.targetPath === recipe.database.targetPath && original.effective.postgresSchema === null, "value_conflict", stage);
      if (intent.mode === "retain-database") requireValue(database.targetPath === identity.sqlitePath, "value_conflict", stage);
      else {
        requireValue(database.targetPath === posix.join(recipe.roots.state.path, "agent-studio.db"), "semantic_unsupported", stage);
        requireValue(database.targetPath !== identity.sqlitePath, "value_conflict", stage);
      }
    } else {
      requireValue(identity.kind === "postgres" && recipe.database.kind === "postgres" && intent.mode === "retain-database"
        && database.connectionString === parsed.pgConnectionString && database.namespace === original.effective.postgresSchema
        && database.namespace === identity.schemaName, "value_conflict", stage);
      const locationId = digestJson({ connectionStringDigest: sha256(Buffer.from(database.connectionString)), namespace: database.namespace });
      requireValue(database.locationId === locationId && recipe.database.locationId === locationId, "value_conflict", stage);
    }
    if (intent.mode === "retain-database") requireValue(same(input.targetSource, plan.source) && input.provisioning === null, "value_conflict", stage);
    else requireValue(input.targetSource.kind === "sqlite" && input.targetSource.databaseInstanceId !== plan.source.databaseInstanceId
      && input.provisioning !== null, "value_conflict", stage);
    const effectiveConfigDigest = digestJson({ ...settings(parsed), dataDir: parsed.dataDir, dbDriver: parsed.dbDriver,
      postgresConnectionDigest: database.kind === "postgres" ? sha256(Buffer.from(database.connectionString)) : null,
      postgresSchema: database.kind === "postgres" ? database.namespace : null });
    requireValue(effectiveConfigDigest === original.effectiveConfigDigest && effectiveConfigDigest === plan.effectiveConfigDigest
      && effectiveConfigDigest === origin.effectiveConfigDigest, "value_conflict", "E1_CONFIG");
    for (const current of [plan.controlRoot, plan.targetRoot, intent.controlRoot, ...Object.values(recipe.roots),
      ...plan.fileRoots.map(item => item.expected)]) parse(plannedPath, current, stage);
    requireValue(roots.control.identity.path === intent.controlRoot.path && roots.control.identity.path === plan.controlRoot.path, "value_conflict", stage);
    requireValue(same(roots.roots.map(item => item.role), rootRoles) && same(roots.parents.map(item => item.role), fileRoles), "value_conflict", stage);
    for (const root of roots.roots) requireValue(root.identity.path === recipe.roots[root.role].path, "value_conflict", stage);
    const parentPaths = [recipe.roots.home.path, recipe.roots.state.path, posix.join(recipe.roots.state.path, "migrations")];
    for (const [index, parent] of roots.parents.entries()) requireValue(parent.identity.path === parentPaths[index], "value_conflict", stage);
    for (const current of [...roots.roots, ...roots.parents])
      requireValue(current.identity.hostIdentityDigest === roots.control.identity.hostIdentityDigest, "value_conflict", stage);

    stage = "E1_RENDER";
    const config = parse(publicConfigSchema, { layoutVersion: 2, storageId: seed.storageId,
      dataDir: database.kind === "sqlite" ? posix.dirname(database.targetPath) : parsed.dataDir,
      stateRoot: recipe.roots.state.path, skillsRoot: recipe.roots.skills.path, memoryRoot: recipe.roots.memory.path,
      runtimeRoot: recipe.roots.runtime.path, workspacesRoot: recipe.roots.workspaces.path, artifactsRoot: recipe.roots.artifacts.path,
      dbDriver: database.kind, ...settings(parsed), ...(parsed.pgConnectionString === undefined ? {} : { pgConnectionString: parsed.pgConnectionString }),
      ...(database.kind === "postgres" ? { postgresSchema: database.namespace } : {}) }, stage);
    const marker = parse(markerSchema, { contract: "s4p-storage-marker/r1", layoutVersion: 2, storageId: seed.storageId,
      generation: 1, objectFormat: "utf8-sha256-v1", memoryFormatContract: intent.identity.memoryFormatContract,
      migrationId: seed.migrationId, layoutActivationId: seed.layoutActivationId, targetSource: input.targetSource,
      recipe: input.recipe.artifact, rootBindings: input.rootBindings.artifact }, stage);
    const locator = parse(locatorSchema, { contract: "s4p-migration-locator/r1", migrationId: seed.migrationId,
      layoutActivationId: seed.layoutActivationId, storageId: seed.storageId, originSource: plan.source,
      targetSource: input.targetSource, controlRoot: roots.control.identity, plan: input.plan.artifact,
      intent: input.intent.artifact, recipe: input.recipe.artifact,
      journalDirectory: posix.join(roots.control.identity.path, "journals", seed.migrationId),
      selectionRule: "read-authority-db-anchor-never-latest-file" }, stage);
    function render<Role extends string>(role: Role, kind: string, payload: unknown): FileValue<Role> {
      budget.tree(payload);
      const text = canonicalJson(payload), length = Buffer.byteLength(text, "utf8");
      budget.decodedBytes(length);
      const bytes = Buffer.from(text, "utf8"), digest = sha256(bytes);
      return { role, artifact: { ref: `s4-provider/sha256/${digest}/${kind}.json`, sha256: digest, bytes: String(length) }, bytesHex: bytes.toString("hex") };
    }
    const files: [FileValue<"config">, FileValue<"storage-marker">, FileValue<"migration-locator">] = [
      render("config", "s4p-config-bytes", config), render("storage-marker", "s4p-marker-bytes", marker),
      render("migration-locator", "s4p-locator-bytes", locator)];
    const stripHost = (identity: { path: string; device: string; inode: string }) =>
      ({ path: identity.path, device: identity.device, inode: identity.inode });
    const bundle = consume(() => parsePublicationBundleValue({ contract: "layout-publication-bundle-value/r1",
      identity: intent.identity, mode: intent.mode, intentDigest: digestJson(intent), recipeDigest: digestJson(recipe),
      targetSource: input.targetSource, provisioning: input.provisioning, rootBindingSet: input.rootBindings.artifact,
      roots: roots.roots.map(item => ({ role: item.role, identity: stripHost(item.identity), sourceProfile: item.sourceProfile })),
      parents: roots.parents.map(item => ({ role: item.role, identity: stripHost(item.identity) })),
      files: files.map(item => ({ role: item.role, bytes: item.artifact })) }), stage);
    const join = consume(() => checkLayoutPublicationValueJoin({ intent, recipe, bundle }), stage);
    const reparsed = consume(() => parseConfigValues({ cwd: recipe.roots.home.path, env: {},
      fileValues: JSON.parse(Buffer.from(files[0].bytesHex, "hex").toString("utf8")) as Record<string, unknown>,
      configFile: posix.join(recipe.roots.home.path, "config.json"), filePathBase: recipe.roots.home.path,
      defaultDataDir: recipe.roots.state.path }), stage);
    requireValue(same(settings(reparsed), settings(parsed)) && reparsed.dataDir === config.dataDir
      && reparsed.dbDriver === parsed.dbDriver && reparsed.pgConnectionString === parsed.pgConnectionString, "value_conflict", stage);
    const result: LayoutPublicationFileResult = { ok: true, value: { contract: "layout-publication-file-values/r1",
      classification: "observation", coverage: "private-config-seed-and-three-file-projection", source: plan.source,
      targetSource: input.targetSource, effectiveConfigDigest, files, bundle, join,
      remaining: [{ check: "source-capture-provenance", status: "unproven" }, { check: "ready-and-journal-window", status: "unproven" },
        { check: "origin-artifacts-and-preservation", status: "unproven" }, { check: "audit-id-rowid-freshness", status: "unproven" },
        { check: "root-profiles-and-capabilities", status: "unproven" },
        { check: "target-provisioning", status: intent.mode === "retain-database" ? "not-applicable" : "unproven" },
        { check: "native-file-publication", status: "unproven" }, { check: "v2-startup-activation", status: "unproven" }] } };
    budget.tree(result);
    return freeze(result);
  } catch (error) {
    return freeze({ ok: false, error: failure(error, stage) });
  }
}

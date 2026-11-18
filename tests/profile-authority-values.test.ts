import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, digestJson } from "../src/server/storage/maintenance/canonical.ts";
import { ProfileAuthorityValueError, parseProfileAuthorityImportValue, parseProfileOriginHistoryValue,
  parseProfilePreservationManifestValue, profileAuthorityImportValueDigest,
  checkProfileLayoutCompositionValues } from "../src/server/identity/profile-authority-values.ts";
import { checkLayoutPublicationValueJoin } from "../src/server/storage/maintenance/layout-values.ts";

// Artificial internal values only. These references do not attest to files, SQL or native admission.
const hash = (digit: string) => digit.repeat(64);
const ref = (name: string, digit = "a") => ({ ref: `private/${name}`, sha256: hash(digit), bytes: "1" });
const source = (kind: "sqlite" | "postgres" = "sqlite", digit = "1") =>
  ({ kind, databaseInstanceId: digit.repeat(32), identityDigest: hash(digit) });
const tables = ["agent_profiles", "agent_profile_versions", "group_bindings", "group_binding_config_versions",
  "legacy_config_captures", "config_snapshots", "config_detach_snapshots", "config_workspace_mappings",
  "config_activation_receipts", "config_mutation_receipts"];
function history(kind: "sqlite" | "postgres" = "sqlite") {
  const activation = { activationId: "m2-original-activation", digest: hash("2") };
  return { contract: "profile-origin-history-value/r1", source: source(kind), authorityRow: ref("source-authority"),
    activation: { ...activation }, activationReceipt: ref("m2-activation-receipt"),
    completion: { activation: { ...activation }, takeoverPlan: { planId: "m2-plan", digest: hash("3") },
      migrationId: "m2-migration", s4PlanDigest: hash("4"), sourceIdentityDigest: hash("1"),
      epochBefore: 7, epochAfter: 8, terminal: { record: { artifactId: "m2-terminal", digest: hash("5") }, sequence: 2 } },
    journalClosure: ref("m2-complete-history") };
}
function preservation(kind: "sqlite" | "postgres" = "sqlite") {
  return { contract: "profile-preservation-manifest-value/r1", source: source(kind), snapshotReady: ref("layout-ready"),
    sourceFormat: { protocolVersion: 2, writerFormat: "s2-profile-config/v1", writerFormatDigest: hash("6"),
      schemaManifest: ref("p1-schema"), guardManifest: ref("p1-guards") },
    tables: tables.map(name => ({ name, columnContract: ref(`${name}-columns`), typedRows: ref(`${name}-rows`),
      count: "2", rowMultisetDigest: hash("7") })),
    dependencies: { stableIdentities: ref("identities"), roleVersions: ref("roles"), executionLinks: ref("executions"),
      workspaceReferences: ref("workspaces"), auditHistory: ref("audit") } };
}
function imported() {
  return { contract: "profile-authority-import-value/r1", sourceHistory: history(), preservation: preservation(),
    layout: { migrationId: "layout-migration", activationId: "layout-activation", intentArtifact: ref("layout-intent"),
      intentValueDigest: hash("8"), transitionContract: ref("transition"), allowedDeltaContract: ref("delta"), fixedSeedPlan: ref("seed") },
    target: { source: source("sqlite", "9"), provisioning: ref("target-birth") },
    authorityProjection: { owner: "profile", activationId: "m2-original-activation", sourceBindingRef: "SELF" } };
}
function fails(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof ProfileAuthorityValueError
    && (code === undefined || error.code === code) && error.message === `profile_authority_value:${error.code}`
    && !("cause" in error));
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    for (const entry of Object.values(value)) frozen(entry);
  }
}

test("P1-V04/11: source history preserves original identities, bounded epochs and independent frozen copies", () => {
  for (const kind of ["sqlite", "postgres"] as const) {
    const input = history(kind);
    const parsed = parseProfileOriginHistoryValue(input);
    assert.deepEqual(parsed, input);
    frozen(parsed);
    assert.equal(Object.isFrozen(input.completion.activation), false);
    input.completion.activation.activationId = "caller-change";
    assert.equal(parsed.completion.activation.activationId, "m2-original-activation");
  }
  for (const [before, after] of [[0, 1], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]]) {
    const input = history(); input.completion.epochBefore = before!; input.completion.epochAfter = after!;
    assert.equal(parseProfileOriginHistoryValue(input).completion.epochAfter, after);
  }
  for (const [before, after] of [[-2, -1], [-1, 0], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1],
    [0.5, 1.5], [NaN, 1], [-0, 1], [0, Infinity]]) {
    const input = history(); input.completion.epochBefore = before!; input.completion.epochAfter = after!;
    fails(() => parseProfileOriginHistoryValue(input), "invalid_value");
  }
  for (const mutate of [
    (input: ReturnType<typeof history>) => { input.completion.activation.digest = hash("f"); },
    (input: ReturnType<typeof history>) => { input.completion.sourceIdentityDigest = hash("f"); },
    (input: ReturnType<typeof history>) => { input.completion.epochAfter++; },
  ]) { const input = history(); mutate(input); fails(() => parseProfileOriginHistoryValue(input), "value_conflict"); }
  const zeroSequence = history(); zeroSequence.completion.terminal.sequence = 0;
  fails(() => parseProfileOriginHistoryValue(zeroSequence), "invalid_value");
});

test("P1-V05/06: manifest preserves ten ordered tables and five complete dependency domains", () => {
  const input = preservation("postgres");
  const parsed = parseProfilePreservationManifestValue(input);
  assert.deepEqual(parsed, input); frozen(parsed);
  input.tables[0]!.typedRows.ref = "caller-change";
  assert.equal(parsed.tables[0]!.typedRows.ref, "private/agent_profiles-rows");
  for (const mutate of [
    (value: ReturnType<typeof preservation>) => { value.tables.pop(); },
    (value: ReturnType<typeof preservation>) => { value.tables[1] = value.tables[0]!; },
    (value: ReturnType<typeof preservation>) => { value.tables.reverse(); },
    (value: ReturnType<typeof preservation>) => { value.tables[0]!.count = "01"; },
    (value: ReturnType<typeof preservation>) => { Reflect.deleteProperty(value.dependencies, "auditHistory"); },
  ]) { const value = preservation(); mutate(value); fails(() => parseProfilePreservationManifestValue(value)); }
  for (const name of ["headsOnly", "config_authority", "future_table"]) {
    const value = preservation(); value.tables[0]!.name = name;
    fails(() => parseProfilePreservationManifestValue(value), "unsupported_shape");
  }
  fails(() => parseProfilePreservationManifestValue({ ...preservation(), headsOnly: true }), "invalid_value");
  const extra = preservation(); Object.assign(extra.dependencies, { extra: ref("other") });
  fails(() => parseProfilePreservationManifestValue(extra), "invalid_value");
});

test("P1-V02/05/07/08: import value uses deterministic full-value digest before SELF artifact selection", () => {
  const input = imported();
  const parsed = parseProfileAuthorityImportValue(input);
  assert.deepEqual(parsed, input); frozen(parsed);
  assert.equal(profileAuthorityImportValueDigest(input), digestJson(input));
  assert.equal(profileAuthorityImportValueDigest(Object.fromEntries(Object.entries(input).reverse())), digestJson(input));
  input.preservation.tables[0]!.count = "3";
  assert.equal(parsed.preservation.tables[0]!.count, "2");
  assert.notEqual(profileAuthorityImportValueDigest(input), digestJson(parsed));
  for (const patch of [{ digest: hash("a") }, { artifact: ref("self") }, { bundle: ref("future-bundle") },
    { targetManifest: ref("future-manifest") }, { journal: ref("future-journal") }, { permit: true }, { callback: () => true }]) {
    fails(() => parseProfileAuthorityImportValue({ ...imported(), ...patch }), "invalid_value");
  }
  for (const mutate of [
    (value: ReturnType<typeof imported>) => { value.preservation.source.databaseInstanceId = "2".repeat(32); },
    (value: ReturnType<typeof imported>) => { value.target.source = source(); },
    (value: ReturnType<typeof imported>) => { value.target.source.kind = "postgres"; },
    (value: ReturnType<typeof imported>) => { value.authorityProjection.activationId = value.layout.activationId; },
    (value: ReturnType<typeof imported>) => { value.authorityProjection.sourceBindingRef = "private/other"; },
  ]) { const value = imported(); mutate(value); fails(() => parseProfileAuthorityImportValue(value), "value_conflict"); }
});

test("P1-V09/10/11: all parser and digest entries reject hostile data before schema/hash without invoking accessors", () => {
  let calls = 0;
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const getter = { get contract() { calls++; return "private postgres://secret"; } };
  const arrayGetter: unknown[] = [null]; Object.defineProperty(arrayGetter, "0", { get() { calls++; return null; }, enumerable: true });
  const reflection = new Proxy({}, { ownKeys() { throw new Error("private postgres://secret"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = [getter, arrayGetter, cycle, Object.create({ inherited: true }), new Date(), new Array(2),
    Object.defineProperty({}, "hidden", { value: null }), { [Symbol("private")]: 1 }, { key: undefined },
    { key: NaN }, { key: Infinity }, { key: -0 }, { key: "\ud800" }, { "\udfff": 1 }, reflection, revoked.proxy];
  const entries = [parseProfileOriginHistoryValue, parseProfilePreservationManifestValue,
    parseProfileAuthorityImportValue, profileAuthorityImportValueDigest];
  for (const entry of entries) {
    for (const value of hostile) fails(() => entry(value), "invalid_value");
    fails(() => entry({ value: "x".repeat(1_048_577) }), "budget_exceeded");
    let deep: unknown = null; for (let index = 0; index < 65; index++) deep = { deep };
    fails(() => entry(deep), "budget_exceeded");
    fails(() => entry({ entries: Array(250_001).fill(null) }), "budget_exceeded");
  }
  assert.equal(calls, 0);
  const nullPrototype: unknown = Object.assign(Object.create(null), imported());
  assert.deepEqual(parseProfileAuthorityImportValue(nullPrototype), parseProfileAuthorityImportValue(imported()));
  const shared = imported(); shared.sourceHistory.authorityRow = shared.sourceHistory.activationReceipt;
  const result = parseProfileAuthorityImportValue(shared);
  assert.deepEqual(result.sourceHistory.authorityRow, result.sourceHistory.activationReceipt);
  assert.notEqual(result.sourceHistory.authorityRow, result.sourceHistory.activationReceipt);
  const unicode = history(); unicode.activation.activationId = unicode.completion.activation.activationId = " 原始🙂标识 ";
  assert.equal(parseProfileOriginHistoryValue(unicode).activation.activationId, " 原始🙂标识 ");
  for (const [entry, value] of [[parseProfileOriginHistoryValue, history()], [parseProfilePreservationManifestValue, preservation()],
    [parseProfileAuthorityImportValue, imported()]] as const) {
    fails(() => entry({ ...value, contract: "future-contract" }), "unsupported_shape");
  }
  assert.equal(new ProfileAuthorityValueError("private dsn" as "invalid_value").message, "profile_authority_value:invalid_value");
});

const rootRoles = ["home", "state", "memory", "skills", "runtime", "workspaces", "artifacts"] as const;
const fileRoles = ["config", "storage-marker", "migration-locator"] as const;
const pathIdentity = (path: string) => ({ path, device: "1", inode: "2" });
const planned = (path: string) => ({ path, existingAncestor: pathIdentity("/"), absentSegments: path.slice(1).split("/") });
function composition(mode: "retain-database" | "relocate-sqlite" = "retain-database", kind: "sqlite" | "postgres" = "sqlite") {
  const identity = { migrationId: "layout-migration", activationId: "layout-activation", storageId: "storage:1",
    generation: 1, layoutVersion: 2, objectFormat: "utf8-sha256-v1", memoryFormatContract: ref("memory-format") };
  const recipe = { contract: "layout-publication-recipe-value/r1", identity, mode,
    roots: Object.fromEntries(rootRoles.map(role => [role, planned(`/data/${role}`)])),
    database: kind === "sqlite" ? { kind, targetPath: "/data/state/boardroom.db", privateDescriptor: ref("database") }
      : { kind, locationId: hash("b"), privateDescriptor: ref("database") },
    targets: [{ role: "config", parentRole: "home", relativePath: "config.json" },
      { role: "storage-marker", parentRole: "state", relativePath: "storage.json" },
      { role: "migration-locator", parentRole: "state", relativePath: "migrations/layout-migration.json" }],
    rendererContract: ref("renderer"), privateInputs: ref("private-inputs") };
  const origin = { kind: "legacy", source: source(kind), plan: ref("layout-plan"), snapshotReady: ref("layout-ready"),
    originalPrivateConfig: ref("original-config"), effectiveConfigDigest: hash("c") };
  const intent = { contract: "layout-intent-value/r1", identity, mode, origin, controlRoot: planned("/control"),
    recipeDigest: digestJson(recipe), inventoryDigest: hash("d"), transitionContract: ref("transition"), allowedDeltaContract: ref("delta"),
    memoryContractDigest: "cd93b64cd66516a22ef4173a343f03b6af6c2c459e1dd3fa2e7354bcf1fbe58a",
    fixedSeedPlan: ref("seed"), auditId: "layout-audit", plannedAt: "2026-11-18T00:00:00.000Z" };
  const bundle = { contract: "layout-publication-bundle-value/r1", identity, mode, intentDigest: digestJson(intent),
    recipeDigest: digestJson(recipe), targetSource: source(kind, mode === "retain-database" ? "1" : "9"),
    provisioning: mode === "retain-database" ? null : ref("target-birth"), rootBindingSet: ref("root-bindings"),
    roots: rootRoles.map(role => ({ role, identity: pathIdentity(`/data/${role}`), sourceProfile: ref(`root-${role}`) })),
    parents: fileRoles.map((role, index) => ({ role,
      identity: pathIdentity(index === 0 ? "/data/home" : index === 1 ? "/data/state" : "/data/state/migrations") })),
    files: fileRoles.map(role => ({ role, bytes: ref(`bytes-${role}`) })) };
  const input = { intent, recipe, bundle, intentArtifact: ref("layout-intent"), sourceHistory: history(kind),
    preservation: preservation(kind), importSelection: null as null | { value: ReturnType<typeof imported>; artifact: ReturnType<typeof ref>; valueDigest: string } };
  if (mode === "relocate-sqlite") {
    const value = imported();
    value.layout.intentValueDigest = digestJson(intent);
    input.importSelection = { value, artifact: ref("chosen-import-artifact", "f"), valueDigest: profileAuthorityImportValueDigest(value) };
  }
  return input;
}
function refreshLayout(value: ReturnType<typeof composition>) {
  value.intent.recipeDigest = digestJson(value.recipe);
  value.bundle.recipeDigest = digestJson(value.recipe);
  value.bundle.intentDigest = digestJson(value.intent);
}
function refreshImport(value: ReturnType<typeof composition>) {
  value.importSelection!.valueDigest = profileAuthorityImportValueDigest(value.importSelection!.value);
}
function layoutConsistency(value: ReturnType<typeof composition>) {
  return checkLayoutPublicationValueJoin({ intent: value.intent, recipe: value.recipe, bundle: value.bundle });
}

test("P1-V01/02/08/11: retain both backends and relocation expose only the exact authority treatment", () => {
  for (const kind of ["sqlite", "postgres"] as const) {
    const value = composition("retain-database", kind);
    const result = checkProfileLayoutCompositionValues(value);
    assert.deepEqual(result, { contract: "profile-layout-value-join/r1", mode: "retain-database",
      ...layoutConsistency(value), sourceHistoryDigest: digestJson(value.sourceHistory), preservationDigest: digestJson(value.preservation),
      authorityTreatment: { kind: "preserve-source-authority", sourceAuthorityRow: value.sourceHistory.authorityRow } });
    frozen(result);
    assert.equal(Object.isFrozen(value.sourceHistory.authorityRow), false);
    value.sourceHistory.authorityRow.ref = "caller-change";
    assert.equal(result.authorityTreatment.sourceAuthorityRow.ref, "private/source-authority");
  }
  const value = composition("relocate-sqlite");
  const result = checkProfileLayoutCompositionValues(value);
  assert.equal(result.mode, "relocate-sqlite");
  assert.deepEqual(result.authorityTreatment, { kind: "imported-profile-projection", sourceAuthorityRow: value.sourceHistory.authorityRow,
    owner: "profile", activationId: "m2-original-activation", sourceBinding: { kind: "profile-layout-import-value",
      artifact: value.importSelection!.artifact, valueDigest: value.importSelection!.valueDigest } });
  frozen(result);
  assert.notEqual(value.importSelection!.artifact.sha256, value.importSelection!.valueDigest);
  const originalDigest = value.importSelection!.valueDigest;
  value.importSelection!.artifact = ref("a-different-artifact", "e");
  const reselected = checkProfileLayoutCompositionValues(value);
  assert.equal(profileAuthorityImportValueDigest(value.importSelection!.value), originalDigest);
  assert.equal(reselected.authorityTreatment.kind, "imported-profile-projection");
  if (reselected.authorityTreatment.kind === "imported-profile-projection")
    assert.deepEqual(reselected.authorityTreatment.sourceBinding, { kind: "profile-layout-import-value",
      artifact: value.importSelection!.artifact, valueDigest: originalDigest });
  value.importSelection!.valueDigest = hash("0");
  fails(() => checkProfileLayoutCompositionValues(value), "value_conflict");
});

test("P1-V03: same-source independently valid histories must match in full, not only by SourceRef", () => {
  for (const mutate of [
    (value: ReturnType<typeof history>) => { value.authorityRow = ref("other-authority"); },
    (value: ReturnType<typeof history>) => { value.activationReceipt = ref("other-receipt"); },
    (value: ReturnType<typeof history>) => { value.journalClosure = ref("other-history"); },
    (value: ReturnType<typeof history>) => { value.completion.terminal.record.artifactId = "other-terminal"; },
    (value: ReturnType<typeof history>) => { value.completion.terminal.sequence++; },
    (value: ReturnType<typeof history>) => { value.completion.epochBefore++; value.completion.epochAfter++; },
  ]) {
    const input = composition("relocate-sqlite");
    mutate(input.importSelection!.value.sourceHistory);
    assert.deepEqual(input.importSelection!.value.sourceHistory.source, input.sourceHistory.source);
    assert.deepEqual(parseProfileOriginHistoryValue(input.importSelection!.value.sourceHistory), input.importSelection!.value.sourceHistory);
    refreshImport(input); // Both histories and the complete import remain individually valid.
    fails(() => checkProfileLayoutCompositionValues(input), "value_conflict");
  }
});

test("P1-V03: each import/layout ref, identity, source and frozen-manifest relationship is enforced", () => {
  for (const mutate of [
    (input: ReturnType<typeof imported>) => { input.layout.intentArtifact = ref("other-intent"); },
    (input: ReturnType<typeof imported>) => { input.layout.intentValueDigest = hash("0"); },
    (input: ReturnType<typeof imported>) => { input.layout.migrationId = "other-migration"; },
    (input: ReturnType<typeof imported>) => { input.layout.activationId = "other-layout-activation"; },
    (input: ReturnType<typeof imported>) => { input.layout.transitionContract = ref("other-transition"); },
    (input: ReturnType<typeof imported>) => { input.layout.allowedDeltaContract = ref("other-delta"); },
    (input: ReturnType<typeof imported>) => { input.layout.fixedSeedPlan = ref("other-seed"); },
    (input: ReturnType<typeof imported>) => { input.target.source.databaseInstanceId = "8".repeat(32); },
    (input: ReturnType<typeof imported>) => { input.target.source.identityDigest = hash("8"); },
    (input: ReturnType<typeof imported>) => { input.target.provisioning = ref("other-birth"); },
    (input: ReturnType<typeof imported>) => { input.preservation.snapshotReady = ref("other-ready"); },
    (input: ReturnType<typeof imported>) => { input.preservation.tables[0]!.typedRows = ref("other-rows"); },
  ]) {
    const input = composition("relocate-sqlite"); mutate(input.importSelection!.value); refreshImport(input);
    assert.deepEqual(layoutConsistency(input).classification, "value-consistent");
    fails(() => checkProfileLayoutCompositionValues(input), "value_conflict");
  }
  for (const field of ["databaseInstanceId", "identityDigest"] as const) {
    const input = composition(); input.sourceHistory.source[field] = "2".repeat(field === "databaseInstanceId" ? 32 : 64);
    if (field === "identityDigest") input.sourceHistory.completion.sourceIdentityDigest = hash("2");
    assert.deepEqual(parseProfileOriginHistoryValue(input.sourceHistory), input.sourceHistory);
    fails(() => checkProfileLayoutCompositionValues(input), "value_conflict");
  }
  const ready = composition(); ready.preservation.snapshotReady = ref("other-ready");
  fails(() => checkProfileLayoutCompositionValues(ready), "value_conflict");
});

test("P1-V03/07: wrong modes, incomplete selections and fresh/P0 values cannot enter the P1-only composition", () => {
  const retain = composition(); retain.importSelection = composition("relocate-sqlite").importSelection;
  fails(() => checkProfileLayoutCompositionValues(retain), "value_conflict");
  const missing = composition("relocate-sqlite"); missing.importSelection = null;
  fails(() => checkProfileLayoutCompositionValues(missing), "value_conflict");
  const postgres = composition(); postgres.bundle.targetSource.kind = "postgres";
  fails(() => checkProfileLayoutCompositionValues(postgres), "value_conflict");
  const p0 = composition(); p0.preservation.sourceFormat.protocolVersion = 1;
  fails(() => checkProfileLayoutCompositionValues(p0), "invalid_value");
  const fresh = composition();
  Object.assign(fresh.intent, { mode: "initialize-new", origin: { kind: "new-space", explicitSelection: ref("selection"), absenceObservation: ref("absence") } });
  Object.assign(fresh.recipe, { mode: "initialize-new" }); Object.assign(fresh.bundle, { mode: "initialize-new", provisioning: ref("birth") });
  refreshLayout(fresh); assert.equal(layoutConsistency(fresh).classification, "value-consistent");
  fails(() => checkProfileLayoutCompositionValues(fresh), "value_conflict");
  for (const patch of [{ current: { admission: "open" } }, { native: {} }, { permit: true }, { callback: () => true }])
    fails(() => checkProfileLayoutCompositionValues({ ...composition(), ...patch }), "invalid_value");
});

test("P1-V05: later same-source profile snapshots compose without comparing original M2 heads", () => {
  for (const mode of ["retain-database", "relocate-sqlite"] as const) {
    const input = composition(mode);
    const originDigest = digestJson(input.sourceHistory);
    input.preservation.snapshotReady = input.intent.origin.snapshotReady = ref("later-ready");
    input.preservation.tables[1]!.typedRows = ref("later-complete-version-history");
    input.preservation.tables[1]!.count = "99";
    refreshLayout(input);
    if (input.importSelection) {
      input.importSelection.value.preservation = structuredClone(input.preservation);
      input.importSelection.value.layout.intentValueDigest = digestJson(input.intent);
      refreshImport(input);
    }
    const result = checkProfileLayoutCompositionValues(input);
    assert.equal(result.sourceHistoryDigest, originDigest);
    assert.equal(result.preservationDigest, digestJson(input.preservation));
    assert.deepEqual(checkProfileLayoutCompositionValues(Object.fromEntries(Object.entries(input).reverse())), result);
  }
});

test("P1-V09/10/11: join owns one budget across repeated values and maps every error to fixed private-free codes", () => {
  let calls = 0;
  fails(() => checkProfileLayoutCompositionValues({ get intent() { calls++; return "private-dsn"; } }), "invalid_value");
  const throwingError = new Proxy({}, { getPrototypeOf() { throw new Error("private-dsn"); } });
  fails(() => checkProfileLayoutCompositionValues(new Proxy({}, { ownKeys() { throw throwingError; } })), "invalid_value");
  assert.equal(calls, 0);
  const large = composition("relocate-sqlite");
  large.preservation.tables[0]!.count = "1".repeat(600_000);
  large.importSelection!.value.preservation = structuredClone(large.preservation);
  refreshImport(large); // Each valid component fits, but their whole envelope exceeds 1 MiB.
  fails(() => checkProfileLayoutCompositionValues(large), "budget_exceeded");
  const unknown = composition(); unknown.recipe.contract = "future-layout";
  fails(() => checkProfileLayoutCompositionValues(unknown), "unsupported_shape");
  const sparse = composition(); sparse.bundle.roots = new Array(7);
  fails(() => checkProfileLayoutCompositionValues(sparse), "invalid_value");
  const original = composition("relocate-sqlite"); const result = checkProfileLayoutCompositionValues(original);
  original.importSelection!.artifact.ref = "caller-change";
  if (result.authorityTreatment.kind === "imported-profile-projection")
    assert.equal(result.authorityTreatment.sourceBinding.artifact.ref, "private/chosen-import-artifact");
});

test("P1-V10: exact private byte, node and depth budgets do not silently widen or truncate", () => {
  const input = imported();
  const remaining = 1_048_576 - Buffer.byteLength(canonicalJson(input), "utf8");
  input.preservation.tables[0]!.count = "1".repeat(remaining + 1);
  assert.equal(Buffer.byteLength(canonicalJson(input), "utf8"), 1_048_576);
  assert.deepEqual(parseProfileAuthorityImportValue(input), input);
  input.preservation.tables[0]!.count += "1";
  fails(() => parseProfileAuthorityImportValue(input), "budget_exceeded");
  let deep: unknown = null; for (let index = 0; index < 64; index++) deep = { deep };
  fails(() => parseProfileOriginHistoryValue(deep), "invalid_value");
  fails(() => parseProfileOriginHistoryValue({ deep }), "budget_exceeded");
  fails(() => parseProfileOriginHistoryValue(Array(249_999).fill(0)), "invalid_value");
  fails(() => parseProfileOriginHistoryValue(Array(250_000).fill(0)), "budget_exceeded");
});

test("P1-V04/11: bounded identifiers preserve their bytes and public runtime exports stay within the pure scope", async () => {
  const input = history();
  input.activation.activationId = input.completion.activation.activationId = "x".repeat(512);
  input.completion.terminal.record.artifactId = "x".repeat(4096);
  input.journalClosure.ref = "x".repeat(4096);
  assert.deepEqual(parseProfileOriginHistoryValue(input), input);
  for (const value of ["", "x".repeat(513), "original\0activation"]) {
    const invalid = history(); invalid.activation.activationId = invalid.completion.activation.activationId = value;
    fails(() => parseProfileOriginHistoryValue(invalid), "invalid_value");
  }
  for (const invalid of [
    { ...input, journalClosure: { ...input.journalClosure, ref: "x".repeat(4097) } },
    { ...input, completion: { ...input.completion, terminal: { ...input.completion.terminal,
      record: { ...input.completion.terminal.record, artifactId: "x".repeat(4097) } } } },
  ]) fails(() => parseProfileOriginHistoryValue(invalid), "invalid_value");
  const api = await import("../src/server/identity/profile-authority-values.ts");
  assert.deepEqual(Object.keys(api).sort(), ["ProfileAuthorityValueError", "checkProfileLayoutCompositionValues",
    "parseProfileAuthorityImportValue", "parseProfileOriginHistoryValue", "parseProfilePreservationManifestValue",
    "profileAuthorityImportValueDigest"].sort());
});

test("P1-V09/11: reflection uses one complete key snapshot, never a second enumeration projected onto stale keys", () => {
  function driftingKeys<T extends object>(value: T) {
    const target = Object.assign(value, { callback: () => { throw new Error("must never run"); } });
    let enumerations = 0;
    const descriptorKeys: PropertyKey[] = [];
    const proxy = new Proxy(target, {
      ownKeys(item) {
        enumerations++;
        return Reflect.ownKeys(item).filter(key => enumerations !== 1 || key !== "callback");
      },
      getOwnPropertyDescriptor(item, key) {
        descriptorKeys.push(key);
        return Reflect.getOwnPropertyDescriptor(item, key);
      },
    });
    return { proxy, target, count: () => enumerations, descriptorKeys };
  }
  const entries: [((value: unknown) => unknown), object][] = [
    [parseProfileOriginHistoryValue, history()], [parseProfilePreservationManifestValue, preservation()],
    [parseProfileAuthorityImportValue, imported()], [profileAuthorityImportValueDigest, imported()],
    [checkProfileLayoutCompositionValues, composition()],
  ];
  for (const [entry, ordinary] of entries) {
    const expected = entry(ordinary);
    const reflected = driftingKeys(structuredClone(ordinary));
    // The initial key snapshot omits callback; no later reflection may observe and silently drop it.
    assert.deepEqual(entry(reflected.proxy), expected);
    assert.equal(reflected.count(), 1);
    assert.equal(reflected.descriptorKeys.includes("callback"), false);
    fails(() => entry(reflected.target), "invalid_value"); // Callback visible in the snapshot is always rejected.
  }
  const value = preservation();
  const expected = parseProfilePreservationManifestValue(value);
  const reflected = driftingKeys(value.tables);
  value.tables = reflected.proxy;
  assert.deepEqual(parseProfilePreservationManifestValue(value), expected);
  assert.equal(reflected.count(), 1);
  assert.equal(reflected.descriptorKeys.includes("callback"), false);
  value.tables = reflected.target;
  fails(() => parseProfilePreservationManifestValue(value), "invalid_value");

  const missingDescriptor = new Proxy(history(), {
    getOwnPropertyDescriptor(item, key) { return key === "journalClosure" ? undefined : Reflect.getOwnPropertyDescriptor(item, key); },
  });
  fails(() => parseProfileOriginHistoryValue(missingDescriptor), "invalid_value");
});
